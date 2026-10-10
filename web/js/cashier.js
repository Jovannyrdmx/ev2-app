/**
 * EV2 — la caja de la barra (D77): las decisiones, sin DOM.
 *
 * El cajero es la única persona que recibe el dinero de los tragos en su barra. Lo
 * que se decide aquí —si ya puede abrir la caja, qué le falta por cobrar y a quién,
 * qué se le avisa cuando llega un evento— se prueba en Node, porque equivocarse aquí
 * es cobrar dos veces, cobrar lo de otra barra o cerrar la caja con un pedido olvidado.
 *
 * El servidor manda en todo lo que importa: la barra sale del rol de la noche, el PIN
 * lo verifica el servidor, y lo que cada cajero puede cobrar también. Esto solo evita
 * mandar peticiones que de antemano se sabe que van a fallar, y dice por qué.
 */
(function (root, factory) {
  'use strict';
  const lib = factory();
  if (typeof module === 'object' && module.exports) module.exports = lib;
  else root.EV2Cashier = lib;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const toCents = (amount) => Math.round(Number(amount || 0) * 100);
  const fromCents = (cents) => (cents / 100).toFixed(2);

  /**
   * Qué enseña la pantalla: 'no_assignment' (no le toca barra esta noche), 'closed'
   * (le toca, todavía no abre), 'open' (caja abierta).
   */
  function phase(till) {
    if (till && till.till) return 'open';
    if (till && till.assignment) return 'closed';
    return 'no_assignment';
  }

  /**
   * Por qué todavía no se puede abrir la caja. Devuelve la clave del motivo o null.
   *
   * El fondo puede ser cero (hay noches sin cambio), pero tiene que ser un número; el
   * código del gerente son seis dígitos, igual que en el corte.
   */
  function openBlocker({ state, amount, pin }) {
    if (phase(state) !== 'closed') return phase(state) === 'open' ? 'till.errOpen' : 'till.errNoBar';
    if (amount === '' || amount === null || amount === undefined) return 'till.errFloat';
    const n = Number(amount);
    if (!Number.isFinite(n) || n < 0) return 'till.errFloat';
    if (!/^\d{6}$/.test(String(pin || ''))) return 'cut.errPin';
    return null;
  }

  /** Lo que se manda para abrir. */
  function openPayload({ amount, pin, currency = 'MXN' }) {
    return { opening_float: Math.round(Number(amount) * 100) / 100, currency, manager_pin: String(pin) };
  }

  /**
   * Lo que falta por cobrar, agrupado por quién lo levantó.
   *
   * Es como llega el dinero a la caja: el mesero se acerca con lo de SUS mesas. Dentro
   * de cada grupo, el más viejo primero — el que más tiempo lleva sin pagarse es el
   * que más cerca está de irse sin pagar. Los grupos, por el más viejo de cada uno.
   */
  function groupByWaiter(orders, { noName = '—' } = {}) {
    const groups = new Map();
    for (const order of (orders || [])) {
      if (!order) continue;
      const key = order.taken_by || 'none';
      if (!groups.has(key)) {
        groups.set(key, {
          key, name: order.taken_by_name || noName, orders: [], cents: 0, oldest: null,
        });
      }
      const g = groups.get(key);
      g.orders.push(order);
      g.cents += toCents(order.subtotal);
      const at = Date.parse(order.created_at || 0);
      if (Number.isFinite(at) && (g.oldest === null || at < g.oldest)) g.oldest = at;
    }
    const list = [...groups.values()];
    for (const g of list) {
      g.orders.sort((a, b) => Date.parse(a.created_at || 0) - Date.parse(b.created_at || 0));
      g.total = fromCents(g.cents);
    }
    return list.sort((a, b) => (a.oldest ?? Infinity) - (b.oldest ?? Infinity));
  }

  /** "2× Corona, 1× Margarita". */
  function itemsSummary(order) {
    return ((order && order.items) || [])
      .map((i) => `${i.quantity}× ${i.name || ''}`.trim())
      .join(', ');
  }

  /** A dónde se entregó: la mesa o el punto de la pista. */
  function destination(order) {
    if (!order) return null;
    if (order.table_code) return order.table_code;
    if (order.delivery_point_name) return order.delivery_point_name;
    return null;
  }

  /** Total de una lista de pedidos, en pesos con dos decimales. */
  function total(orders) {
    return fromCents((orders || []).reduce((n, o) => n + toCents(o && o.subtotal), 0));
  }

  /**
   * El pedido como lo necesita el cobro (`EV2OrderTaking.chargePayload`): sin
   * `sender_id` a propósito, para no mandar `on_behalf_of` —la caja cobra el pedido,
   * no a una persona—.
   */
  function asChargeable(order) {
    return {
      transaction_id: order.transaction_id,
      subtotal: order.subtotal,
      currency: order.currency || 'MXN',
      payment_status: order.payment_status,
    };
  }

  /**
   * Los eventos del socket que cambian lo que la caja tiene que cobrar. No se intenta
   * reconstruir la lista con lo que trae el evento: se vuelve a pedir, porque el evento
   * trae ids y la caja necesita la mesa, el mesero y el importe.
   */
  const REFRESH_EVENTS = ['order_created', 'order_paid', 'order_confirmed', 'order_cancelled',
    'payment_confirmed', 'payment_partial', 'till_opened', 'shift_closed'];

  function shouldRefresh(message, { locationId } = {}) {
    const kind = message && (message.event_type || message.type);
    if (!REFRESH_EVENTS.includes(kind)) return false;
    const payload = (message && message.payload) || {};
    // Un pedido nuevo de OTRA barra no es asunto de esta caja.
    if (kind === 'order_created' && locationId && payload.bar_location_id
      && payload.bar_location_id !== locationId) return false;
    return true;
  }

  // ---------------------------------------------------------------- el cobro (D79)

  const METHOD_KEYS = ['cash', 'cash_usd', 'mercadopago_point', 'card_terminal', 'vip_credit'];
  const isCash = (m) => m === 'cash';
  const isUsd = (m) => m === 'cash_usd';
  const isVip = (m) => m === 'vip_credit';

  // ---------------------------------------------------------------- dólares (D86)

  /**
   * Cuántos centavos de peso cubren `usd` dólares al tipo de cambio `rate`, redondeado
   * al centavo (la mitad hacia arriba), con enteros: igual que `round(usd * rate, 2)`
   * en Postgres. Con flotantes, 17.355 × 100 da 1735.4999… y el peso de diferencia
   * terminaría en una discusión con el servidor.
   */
  function usdToCents(usd, rate) {
    const u = Number(usd);
    const r = Number(rate);
    if (!(u > 0) || !(r > 0)) return null;
    const usdCents = BigInt(Math.round(u * 100));
    const rateMicro = BigInt(Math.round(r * 1e6));
    const scaled = usdCents * rateMicro; // centavos × 1e6
    const UNIT = 1000000n;
    return Number((scaled + UNIT / 2n) / UNIT);
  }

  /**
   * Lo que pasa con unos dólares contra lo que falta cobrar: cuántos pesos cubren, cuánto
   * se aplica, y el cambio en pesos REDONDEADO HACIA ABAJO al peso (los centavos se
   * quedan en el club, D86). `short` dice cuánto falta si no alcanzan. Todo en pesos con
   * dos decimales, o null si todavía no hay dólares capturados.
   */
  function usdQuote(usd, rate, dueAmount) {
    const cubre = usdToCents(usd, rate);
    if (cubre === null) return null;
    const falta = toCents(dueAmount);
    const aplica = Math.min(cubre, falta);
    const cambio = cubre > falta ? Math.floor((cubre - falta) / 100) * 100 : 0;
    return {
      covers: fromCents(cubre),
      applied: fromCents(aplica),
      change: fromCents(cambio),
      short: cubre < falta ? fromCents(falta - cubre) : null,
    };
  }

  /** Los dólares que equivalen a un monto en pesos, redondeados al centavo hacia arriba. */
  function usdFor(amount, rate) {
    const r = Number(rate);
    if (!(r > 0)) return null;
    return (Math.ceil((toCents(amount) / r) - 1e-9) / 100).toFixed(2);
  }
  const isTerminal = (m) => m === 'mercadopago_point';
  const needsReference = (m) => m === 'card_terminal';

  /** Lo que falta por cobrar de un pedido (el servidor ya lo resta de las partes pagadas). */
  function remainingOf(order) {
    if (!order) return '0.00';
    if (order.remaining !== undefined && order.remaining !== null) return fromCents(toCents(order.remaining));
    return fromCents(toCents(order.subtotal));
  }

  /** Las formas de pago que ya se usaron en este pedido. */
  const usedMethods = (order) => ((order && order.parts) || []).map((p) => p.method);

  /**
   * Con qué se puede cobrar lo que falta. Una forma ya usada no se repite: las dos
   * partes de un cobro son formas de pago distintas.
   */
  function methodsFor(order, { usdRate } = {}) {
    const usadas = usedMethods(order);
    // Sin tipo de cambio fijado por el gerente, los dólares ni se ofrecen.
    return METHOD_KEYS.filter((m) => !usadas.includes(m)
      && (!isUsd(m) || Boolean(usdRate))
      && (!isVip(m) || vipBalance(order) > 0));
  }

  /** El credito VIP (D97) que le queda a la mesa del pedido, en centavos; 0 si no hay. */
  function vipBalance(order) {
    return order && order.vip_credit_balance ? toCents(order.vip_credit_balance) : 0;
  }

  /** Solo se divide un pedido que todavía no tiene ninguna parte pagada. */
  const canSplit = (order) => usedMethods(order).length === 0;

  /**
   * El cambio a entregar, en centavos exactos. `null` si todavía no se puede decir
   * (no tecleó lo recibido); negativo si lo recibido no alcanza.
   */
  function change(received, amount) {
    if (received === '' || received === null || received === undefined) return null;
    const r = Number(received);
    if (!Number.isFinite(r)) return null;
    return fromCents(toCents(r) - toCents(amount));
  }

  /**
   * Arma el cobro: una o dos partes, y en qué orden se mandan. Devuelve
   * `{ error }` con la clave del motivo, o `{ steps }`.
   *
   * La terminal de Mercado Pago va PRIMERO: es la única que puede decir que no (una
   * tarjeta rechazada). Si dice que no, todavía no se asentó nada y la caja escoge otra
   * forma; si se cobrara primero el efectivo, quedaría media cuenta pagada esperando.
   *
   * `a` y `b` son `{ method, amount, reference, received }`. Sin `split`, `a` paga
   * todo lo que falta y su monto no se teclea.
   */
  function planCharge({ order, split = false, a = {}, b = {}, terminals, usdRate = null } = {}) {
    const falta = toCents(remainingOf(order));
    if (falta <= 0) return { error: 'till.errNothingDue' };
    const permitidos = methodsFor(order, { usdRate });
    if (split && !canSplit(order)) return { error: 'till.errSplitTwice' };

    // En dólares, la primera parte no se teclea en pesos: la fijan los dólares (D86).
    let montoA = a.amount;
    if (split && isUsd(a.method)) {
      const q = usdRate ? usdQuote(a.usd, usdRate.rate, fromCents(falta)) : null;
      if (!q) return { error: 'till.errUsd' };
      // Si los dólares ya pagan todo, no hay segunda forma de pago que cobrar.
      if (!q.short) return { error: 'till.errUsdCoversAll' };
      montoA = q.applied;
    }

    // Credito VIP (D97): lo que se aplica lo fija el saldo, no se teclea.
    const vip = vipBalance(order);
    if (split && isVip(a.method)) {
      if (vip >= falta) return { error: 'till.errVipCoversAll' };
      montoA = fromCents(vip);
    }

    const partes = split
      ? [{ ...a, amount: montoA }, { ...b, amount: fromCents(falta - toCents(montoA)) }]
      : [{ ...a, amount: fromCents(falta) }];

    if (split) {
      const ca = toCents(montoA);
      if (!(Number(montoA) > 0) || ca <= 0 || ca >= falta) return { error: 'till.errSplitAmount' };
      if (!a.method || !b.method || a.method === b.method) return { error: 'till.errSplitSame' };
    }

    for (const [i, p] of partes.entries()) {
      if (isVip(p.method)) {
        const monto = toCents(p.amount);
        if (vip < monto && !(split && i === 0)) return { error: 'till.errVipShort' };
      }
      if (isUsd(p.method)) {
        if (!usdRate) return { error: 'till.errNoRate' };
        const q = usdQuote(p.usd, usdRate.rate, p.amount);
        if (!q) return { error: 'till.errUsd' };
        // La primera parte en dólares puede quedarse corta (paga el resto la segunda);
        // la que cierra el cobro tiene que alcanzar.
        if (q.short && !(split && i === 0)) return { error: 'till.errUsdShort' };
      }
      if (!p.method || !permitidos.includes(p.method)) return { error: 'till.errMethod' };
      if (needsReference(p.method) && !String(p.reference == null ? '' : p.reference).trim()) {
        return { error: 'take.blocked.no_reference' };
      }
      if (isTerminal(p.method) && terminals !== undefined
        && !(terminals || []).some((t) => t && t.active !== false)) {
        return { error: 'take.blocked.no_terminal' };
      }
      if (isCash(p.method) && p.received !== '' && p.received !== null && p.received !== undefined) {
        const c = change(p.received, p.amount);
        if (c === null) return { error: 'till.errReceived' };
        if (toCents(c) < 0) return { error: 'till.errReceivedShort' };
      }
    }

    const steps = partes
      .map((p) => {
        const q = isUsd(p.method) ? usdQuote(p.usd, usdRate.rate, p.amount) : null;
        const step = {
          method: p.method,
          amount: fromCents(toCents(p.amount)),
          reference: needsReference(p.method) ? String(p.reference).trim() : null,
          cash_received: isCash(p.method) && p.received !== '' && p.received !== undefined && p.received !== null
            ? fromCents(toCents(p.received)) : null,
          change: isCash(p.method) ? change(p.received, p.amount) : (q ? q.change : null),
          terminal: isTerminal(p.method),
        };
        if (q) {
          step.usd_received = fromCents(toCents(p.usd));
          step.exchange_rate_id = String(usdRate.id);
        }
        return step;
      })
      .sort((x, y) => Number(y.terminal) - Number(x.terminal));
    return { steps };
  }

  /** Lo que se manda por `POST /till/payments` para una parte manual. */
  function paymentPayload(order, step, requestId) {
    const body = {
      transaction_id: order.transaction_id,
      method: step.method,
    };
    // En dólares el monto lo calcula el servidor con el tipo de cambio que se vio aquí.
    // (Con credito VIP tambien lo fija el servidor, con el saldo; el monto que va
    // aqui solo es el que el cajero vio.)
    if (isUsd(step.method)) {
      body.usd_received = Number(step.usd_received);
      body.exchange_rate_id = step.exchange_rate_id;
    } else {
      body.amount = Number(step.amount);
    }
    if (step.reference) body.reference = step.reference;
    if (step.cash_received !== null && step.cash_received !== undefined) {
      body.cash_received = Number(step.cash_received);
    }
    if (requestId) body.client_request_id = requestId;
    return body;
  }

  return {
    METHOD_KEYS,
    usdToCents,
    usdQuote,
    usdFor,
    remainingOf,
    methodsFor,
    canSplit,
    change,
    planCharge,
    paymentPayload,
    phase,
    openBlocker,
    openPayload,
    groupByWaiter,
    itemsSummary,
    destination,
    total,
    asChargeable,
    REFRESH_EVENTS,
    shouldRefresh,
  };
}));
