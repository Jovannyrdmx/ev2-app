/**
 * EV2 — lo que gana un empleado y cómo lo retira (paso 5.4).
 *
 * Aquí se decide qué número ve una bailarina o un mesero cuando abre su portal. Es el
 * lugar donde un error se paga en confianza: enseñar como disponible un dinero que
 * todavía no está confirmado, o dejar pedir un retiro que el servidor va a rechazar.
 *
 * El dinero llega como cadena decimal y se suma en centavos enteros. Nunca en float.
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EV2Earnings = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const toCents = (value) => {
    if (value === null || value === undefined || value === '') return 0;
    const n = Math.round(Number(value) * 100);
    return Number.isFinite(n) ? n : 0;
  };
  const fromCents = (cents) => (cents / 100).toFixed(2);

  const ZERO = {
    currency: 'MXN', earned: '0.00', withdrawn: '0.00', reserved: '0.00',
    available: '0.00', movements: 0,
  };

  /**
   * El saldo de una moneda. `available` es lo ÚNICO que se puede pedir: `reserved` es lo
   * que ya está comprometido en un retiro en proceso, y mostrarlo como disponible haría
   * que el empleado pidiera dos veces el mismo dinero.
   */
  function balanceFor(balances, currency) {
    const wanted = currency || 'MXN';
    const row = (balances || []).find((b) => (b.currency || 'MXN') === wanted);
    if (!row) return Object.assign({}, ZERO, { currency: wanted });
    return {
      currency: row.currency || wanted,
      earned: row.earned || '0.00',
      withdrawn: row.withdrawn || '0.00',
      reserved: row.reserved || '0.00',
      available: row.available || '0.00',
      movements: Number(row.movements) || 0,
    };
  }

  const currenciesIn = (balances) => [...new Set((balances || [])
    .map((b) => b.currency).filter(Boolean))];

  /** Si hay algo que retirar en esa moneda. */
  const hasMoney = (balance) => toCents(balance && balance.available) > 0;

  // ---------------------------------------------------------------- cuentas

  /**
   * Una cuenta sirve para cobrar solo si está verificada por el gerente.
   *
   * El servidor da de baja una cuenta con `active = false` (nunca la borra: un retiro ya
   * pagado tiene que seguir apuntando a ella) y su listado ya filtra por `active`. Se
   * vuelve a comprobar aquí por si alguna vista llega a mandar la columna: seguir
   * ofreciendo una cuenta dada de baja mandaría el dinero justo a donde el empleado ya
   * dijo que no.
   */
  const isUsable = (account) => Boolean(account && account.verified_at && account.active !== false);

  const usableAccounts = (accounts) => (accounts || []).filter(isUsable);

  /**
   * Por qué NO se puede pedir un retiro ahora. Devuelve la clave del motivo, o null si
   * sí se puede. Se dice el motivo concreto: "no tienes saldo" y "tu cuenta no está
   * verificada" mandan al empleado a lugares distintos.
   */
  function withdrawalBlocker(balance, accounts, openWithdrawal) {
    if (openWithdrawal) return 'earn.errOpen';
    if (!(accounts || []).length) return 'earn.errNoAccount';
    if (!usableAccounts(accounts).length) return 'earn.errUnverified';
    if (!hasMoney(balance)) return 'earn.errNoMoney';
    return null;
  }

  /** Comprueba el importe contra el saldo, en centavos. */
  function validateAmount(amount, balance) {
    const cents = toCents(amount);
    if (!(Number(amount) > 0) || cents <= 0) return 'earn.errAmount';
    if (cents > toCents(balance && balance.available)) return 'earn.errTooMuch';
    return null;
  }

  const CLABE_LENGTH = 18;
  const ROUTING_LENGTH = 9;

  /**
   * El dígito verificador de la CLABE, igual que `services/banking.js` en el servidor:
   * los 17 primeros con pesos 3,7,1 y el 18º comprueba la suma.
   *
   * Comprobar solo el largo no basta: el servidor rechaza la CLABE con un mensaje sobre
   * el dígito verificador, y el empleado —que copió bien lo que veía— no entiende qué
   * hizo mal. Con esto se le dice aquí, mientras la tiene enfrente para revisarla.
   */
  function isValidClabe(value) {
    if (!/^\d{18}$/.test(value)) return false;
    const weights = [3, 7, 1];
    let sum = 0;
    for (let i = 0; i < 17; i += 1) sum += (Number(value[i]) * weights[i % 3]) % 10;
    return ((10 - (sum % 10)) % 10) === Number(value[17]);
  }

  /** El routing de un banco de Estados Unidos: 9 dígitos, pesos 3,7,1, suma múltiplo de 10. */
  function isValidRouting(value) {
    if (!/^\d{9}$/.test(value)) return false;
    const weights = [3, 7, 1];
    let sum = 0;
    for (let i = 0; i < 9; i += 1) sum += Number(value[i]) * weights[i % 3];
    return sum % 10 === 0;
  }

  /**
   * Comprueba una cuenta antes de mandarla. Una CLABE mal escrita no falla al
   * registrarla: falla el día del pago, y para entonces el empleado ya contaba con el
   * dinero.
   */
  function validateAccount(form) {
    const errors = {};
    const text = (v) => String(v === null || v === undefined ? '' : v).trim();
    const digits = (v) => text(v).replace(/\D/g, '');

    if (!['clabe', 'us_checking', 'us_savings'].includes(form.type)) errors.type = 'earn.errRequired';
    if (!text(form.bank_name)) errors.bank_name = 'earn.errRequired';
    if (!text(form.holder_name)) errors.holder_name = 'earn.errRequired';

    const account = digits(form.account_number);
    if (form.type === 'clabe') {
      // Primero el largo, y solo después el dígito verificador: así el mensaje dice lo
      // que de verdad está mal en vez de un genérico.
      if (account.length !== CLABE_LENGTH) errors.account_number = 'earn.errClabe';
      else if (!isValidClabe(account)) errors.account_number = 'earn.errClabeCheck';
    } else if (account.length < 4 || account.length > 20) {
      errors.account_number = 'earn.errAccount';
    }

    if (form.type !== 'clabe') {
      const routing = digits(form.routing_number);
      if (routing.length !== ROUTING_LENGTH) errors.routing_number = 'earn.errRouting';
      else if (!isValidRouting(routing)) errors.routing_number = 'earn.errRoutingCheck';
    }
    return errors;
  }

  /** Lo que se manda al servidor: dígitos limpios, sin guiones ni espacios. */
  function accountPayload(form) {
    const digits = (v) => String(v || '').replace(/\D/g, '');
    const body = {
      type: form.type,
      bank_name: String(form.bank_name || '').trim(),
      holder_name: String(form.holder_name || '').trim(),
      account_number: digits(form.account_number),
      is_default: form.is_default !== false,
    };
    if (form.type !== 'clabe') body.routing_number = digits(form.routing_number);
    return body;
  }

  // ---------------------------------------------------------------- retiros

  const OPEN_STATUSES = ['pending', 'approved'];

  /** El retiro que sigue en proceso, si hay uno. Solo puede haber uno a la vez. */
  const openWithdrawal = (withdrawals) => (withdrawals || [])
    .find((w) => OPEN_STATUSES.includes(w.status)) || null;

  const STATUS_KEY = {
    pending: 'earn.wPending',
    approved: 'earn.wApproved',
    paid: 'earn.wPaid',
    rejected: 'earn.wRejected',
  };

  const withdrawalLabel = (status) => STATUS_KEY[status] || 'earn.wPending';

  // ---------------------------------------------------------------- movimientos

  const TYPE_KEY = {
    tip: 'earn.mTip',
    song_request: 'earn.mSong',
    taxi_ride: 'earn.mRide',
    valet: 'earn.mValet',
    withdrawal: 'earn.mWithdrawal',
    adjustment: 'earn.mAdjustment',
  };

  const movementLabel = (type) => TYPE_KEY[type] || 'earn.mOther';

  /**
   * Suma los movimientos por tipo, en la moneda pedida. Devuelve el mayor primero: al
   * empleado le importa de dónde viene su dinero, y eso decide dónde pone su esfuerzo.
   */
  function byType(rows, currency) {
    const wanted = currency || 'MXN';
    const totals = new Map();
    for (const row of (rows || [])) {
      if ((row.currency || 'MXN') !== wanted) continue;
      const key = row.type || 'other';
      totals.set(key, (totals.get(key) || 0) + toCents(row.total !== undefined ? row.total : row.amount));
    }
    return [...totals.entries()]
      .map(([type, cents]) => ({ type, amount: fromCents(cents), key: movementLabel(type) }))
      .sort((a, b) => toCents(b.amount) - toCents(a.amount));
  }

  return {
    ZERO,
    CLABE_LENGTH,
    ROUTING_LENGTH,
    OPEN_STATUSES,
    isValidClabe,
    isValidRouting,
    toCents,
    fromCents,
    balanceFor,
    currenciesIn,
    hasMoney,
    isUsable,
    usableAccounts,
    withdrawalBlocker,
    validateAmount,
    validateAccount,
    accountPayload,
    openWithdrawal,
    withdrawalLabel,
    movementLabel,
    byType,
  };
}));
