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

  const METHOD_KEYS = ['cash', 'mercadopago_point', 'card_terminal'];
  const isCash = (m) => m === 'cash';
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
  function methodsFor(order) {
    const usadas = usedMethods(order);
    return METHOD_KEYS.filter((m) => !usadas.includes(m));
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
  function planCharge({ order, split = false, a = {}, b = {}, terminals } = {}) {
    const falta = toCents(remainingOf(order));
    if (falta <= 0) return { error: 'till.errNothingDue' };
    const permitidos = methodsFor(order);
    if (split && !canSplit(order)) return { error: 'till.errSplitTwice' };

    const partes = split
      ? [{ ...a, amount: a.amount }, { ...b, amount: fromCents(falta - toCents(a.amount)) }]
      : [{ ...a, amount: fromCents(falta) }];

    if (split) {
      const ca = toCents(a.amount);
      if (!(Number(a.amount) > 0) || ca <= 0 || ca >= falta) return { error: 'till.errSplitAmount' };
      if (!a.method || !b.method || a.method === b.method) return { error: 'till.errSplitSame' };
    }

    for (const p of partes) {
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
      .map((p) => ({
        method: p.method,
        amount: fromCents(toCents(p.amount)),
        reference: needsReference(p.method) ? String(p.reference).trim() : null,
        cash_received: isCash(p.method) && p.received !== '' && p.received !== undefined && p.received !== null
          ? fromCents(toCents(p.received)) : null,
        change: isCash(p.method) ? change(p.received, p.amount) : null,
        terminal: isTerminal(p.method),
      }))
      .sort((x, y) => Number(y.terminal) - Number(x.terminal));
    return { steps };
  }

  /** Lo que se manda por `POST /till/payments` para una parte manual. */
  function paymentPayload(order, step, requestId) {
    const body = {
      transaction_id: order.transaction_id,
      method: step.method,
      amount: Number(step.amount),
    };
    if (step.reference) body.reference = step.reference;
    if (step.cash_received !== null && step.cash_received !== undefined) {
      body.cash_received = Number(step.cash_received);
    }
    if (requestId) body.client_request_id = requestId;
    return body;
  }

  return {
    METHOD_KEYS,
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
