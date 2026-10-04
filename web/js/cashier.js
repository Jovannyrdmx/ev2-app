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
    'payment_confirmed', 'till_opened', 'shift_closed'];

  function shouldRefresh(message, { locationId } = {}) {
    const kind = message && (message.event_type || message.type);
    if (!REFRESH_EVENTS.includes(kind)) return false;
    const payload = (message && message.payload) || {};
    // Un pedido nuevo de OTRA barra no es asunto de esta caja.
    if (kind === 'order_created' && locationId && payload.bar_location_id
      && payload.bar_location_id !== locationId) return false;
    return true;
  }

  return {
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
