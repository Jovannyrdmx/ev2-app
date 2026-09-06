/**
 * EV2 — el gerente verificando cuentas y pagando retiros (paso 5.5).
 *
 * Sin esta pantalla el dinero entra al sistema y nunca sale: nadie verifica la cuenta
 * de un empleado, y sin verificación el servidor rechaza su primer retiro para siempre.
 * Es el final del camino de una propina, y por eso es donde un error se paga en
 * confianza del personal, que es lo más caro de recuperar en un club.
 *
 * Nada de esto mueve dinero solo. Cada paso es una decisión del gerente contra algo que
 * ya vio: un estado de cuenta, una transferencia hecha por fuera. El sistema solo lleva
 * el registro de quién decidió qué y cuándo.
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EV2Payouts = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const toCents = (value) => {
    if (value === null || value === undefined || value === '') return 0;
    const n = Math.round(Number(value) * 100);
    return Number.isFinite(n) ? n : 0;
  };
  const money = (c) => (c / 100).toFixed(2);

  // ---------------------------------------------------------------- retiros

  const OPEN = ['pending', 'approved'];

  /**
   * El orden de la bandeja.
   *
   * Lo que espera decisión primero, y dentro de eso lo más viejo arriba: un retiro
   * aprobado hace tres días y sin pagar es alguien que ya contó con ese dinero. Lo
   * cerrado va al final, como historial.
   */
  function sortWithdrawals(withdrawals) {
    const rank = (w) => {
      if (w.status === 'pending') return 0;
      if (w.status === 'approved') return 1;
      return 2;
    };
    return (withdrawals || [])
      .filter((w) => w && w.id)
      .slice()
      .sort((a, b) => rank(a) - rank(b)
        || new Date(a.created_at || 0) - new Date(b.created_at || 0));
  }

  /** Lo que el gerente tiene pendiente, para saber si puede cerrar la noche. */
  function inbox(withdrawals, now) {
    const list = (withdrawals || []).filter((w) => w && w.id);
    const open = list.filter((w) => OPEN.includes(w.status));
    const when = now ? new Date(now) : new Date();
    let oldest = 0;
    for (const w of open) {
      const days = Math.floor((when - new Date(w.created_at || when)) / 86400000);
      if (days > oldest) oldest = days;
    }
    const owed = new Map();
    for (const w of open) {
      const cur = w.payout_currency || w.currency || 'MXN';
      owed.set(cur, (owed.get(cur) || 0) + toCents(w.amount_paid || w.amount));
    }
    return {
      pending: list.filter((w) => w.status === 'pending').length,
      approved: list.filter((w) => w.status === 'approved').length,
      oldestDays: oldest,
      owed: [...owed.entries()].map(([currency, c]) => ({ currency, amount: money(c) })),
    };
  }

  const STATUS_KEY = {
    pending: 'pay.stPending',
    approved: 'pay.stApproved',
    paid: 'pay.stPaid',
    rejected: 'pay.stRejected',
  };

  const statusLabel = (status) => STATUS_KEY[status] || 'pay.stPending';

  /**
   * Qué puede hacer el gerente con este retiro, y por qué no puede lo demás.
   *
   * Aprobar y pagar son dos pasos separados a propósito: aprobar dice "sí, le debemos
   * esto"; pagar dice "ya hice la transferencia". Juntarlos haría que un descuido
   * marcara como pagado dinero que sigue en la cuenta del club.
   */
  function actionsFor(withdrawal) {
    const w = withdrawal || {};
    return {
      canApprove: w.status === 'pending',
      canReject: w.status === 'pending',
      // Solo se marca pagado lo aprobado. El servidor también lo exige y contesta 409.
      canPay: w.status === 'approved',
      isClosed: w.status === 'paid' || w.status === 'rejected',
    };
  }

  /**
   * Comprueba antes de marcar como pagado.
   *
   * Una transferencia sin referencia es imposible de conciliar tres semanas después,
   * cuando el empleado dice que nunca le llegó. Se pide, pero no se inventa: el
   * servidor la acepta vacía y aquí solo se advierte.
   */
  function payWarning(withdrawal, reference) {
    const text = String(reference === null || reference === undefined ? '' : reference).trim();
    if (!text) return 'pay.warnNoReference';
    return null;
  }

  /** El motivo de un rechazo es obligatorio: un "no" sin explicación no se puede corregir. */
  function validateRejection(reason) {
    const text = String(reason === null || reason === undefined ? '' : reason).trim();
    if (text.length < 4) return 'pay.errReason';
    return null;
  }

  // ---------------------------------------------------------------- cuentas

  /**
   * Las cuentas de un empleado, la que cobra primero.
   *
   * El gerente entra aquí a hacer UNA cosa: comparar los últimos cuatro dígitos con el
   * estado de cuenta que tiene enfrente y decir sí o no. Todo lo demás sobra.
   */
  function sortAccounts(accounts) {
    return (accounts || [])
      .filter((a) => a && a.id)
      .slice()
      .sort((a, b) => (Number(Boolean(b.is_default)) - Number(Boolean(a.is_default)))
        || (Number(verified(a)) - Number(verified(b)))
        || new Date(a.created_at || 0) - new Date(b.created_at || 0));
  }

  const isVerified = (account) => verified(account);

  /** Cuántas cuentas esperan que alguien las mire. */
  const unverifiedCount = (accounts) => (accounts || [])
    .filter((a) => a && a.id && !verified(a)).length;

  /**
   * Cómo se enseña una cuenta. NUNCA el número completo: la API solo manda los últimos
   * cuatro dígitos, y esta pantalla no debe dar la impresión de que hay más que ver.
   *
   * El campo se llama `account_masked` y viene ya con la forma `****1234`
   * (`services/banking.js`, maskAccount). Leer `account_last4` —que existe en la tabla
   * pero NO en la respuesta— dejaba un guion justo donde el gerente tiene que comparar
   * dígitos, y verificar se volvía puro teatro.
   */
  function accountLabel(account) {
    const a = account || {};
    const bank = String(a.bank_name || '').trim();
    const fromApi = String(a.account_masked || '').replace(/^[*•]+/, '').trim();
    const last4 = fromApi || String(a.account_last4 || '').trim();
    return {
      bank: bank || '—',
      masked: last4 ? `••••${last4}` : '—',
      holder: String(a.holder_name || '').trim(),
      type: a.type === 'clabe' ? 'earn.typeClabe'
        : a.type === 'us_savings' ? 'earn.typeSavings' : 'earn.typeChecking',
    };
  }

  /**
   * Si la cuenta ya está verificada.
   *
   * La API manda las dos cosas: `verified` (booleano) y `verified_at`. Se aceptan
   * ambas porque distintas rutas devuelven distinta forma, y quedarse con una sola
   * haría que la bandeja enseñara como pendiente algo ya resuelto.
   */
  function verified(account) {
    const a = account || {};
    return Boolean(a.verified_at || a.verified === true);
  }

  /**
   * Lo que el gerente debe leer antes de verificar.
   *
   * Verificar no es un trámite: es lo que autoriza que salga dinero a esa cuenta. Si
   * los dígitos no coinciden con lo que el empleado le enseñó, el dinero se va a otro
   * lado y no vuelve.
   */
  const verifyWarning = () => 'pay.verifyNote';

  return {
    OPEN,
    toCents,
    money,
    sortWithdrawals,
    inbox,
    statusLabel,
    actionsFor,
    payWarning,
    validateRejection,
    sortAccounts,
    verified,
    isVerified,
    unverifiedCount,
    accountLabel,
    verifyWarning,
  };
}));
