/**
 * EV2 — la cola de la barra (paso 5.7).
 *
 * Lo que decide qué ve el bartender: en qué carril cae cada pedido, cuál es el
 * siguiente botón, cuánto lleva esperando y qué hace un evento del socket con la cola.
 * Todo son funciones puras, probadas en Node: un pedido que se pierde de la cola o que
 * aparece en el carril equivocado no se nota hasta que un cliente reclama su trago.
 *
 * El servidor manda: aquí NO se inventan transiciones. El orden de estados es el de
 * `TRANSITIONS` en server/src/routes/orders.js, y cada botón hace UNA sola llamada.
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EV2Bar = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /**
   * Tres carriles, no seis. El bartender no piensa en "confirmed" y "preparing" como
   * cosas distintas: piensa en "me acaba de entrar", "lo estoy haciendo" y "ya está,
   * que lo recojan".
   */
  const LANES = ['new', 'prep', 'ready'];

  const LANE_OF = {
    pending: 'new',
    pos_error: 'new',
    confirmed: 'prep',
    preparing: 'prep',
    ready: 'ready',
  };

  /** Estados que ya salieron de la barra: no ocupan lugar en la pantalla. */
  const CLOSED = ['delivered', 'cancelled'];

  const laneOf = (status) => LANE_OF[status] || null;
  const isClosed = (status) => CLOSED.includes(status);

  /**
   * El botón principal de un pedido. Cada uno es UNA transición del servidor; no se
   * encadenan dos llamadas en un toque, porque si la segunda falla el pedido queda en
   * un estado que la pantalla no muestra y nadie se entera.
   */
  const NEXT_ACTION = {
    pending: { status: 'confirmed', key: 'bar.accept' },
    pos_error: { status: 'confirmed', key: 'bar.retry' },
    confirmed: { status: 'preparing', key: 'bar.start' },
    preparing: { status: 'ready', key: 'bar.markReady' },
    ready: { status: 'delivered', key: 'bar.markDelivered' },
  };

  const nextAction = (status) => NEXT_ACTION[status] || null;

  /** Cancelar solo tiene sentido antes de servirlo. */
  const canCancel = (status) => ['pending', 'confirmed', 'preparing', 'pos_error'].includes(status);

  // ---------------------------------------------------------------- la cola

  const toTime = (iso) => {
    const ms = Date.parse(iso);
    return Number.isFinite(ms) ? ms : null;
  };

  /**
   * Cuántos minutos lleva esperando. Se cuenta desde que el pedido entró, no desde que
   * el bartender lo tocó: al cliente le importa desde que lo pidió.
   */
  function waitMinutes(order, now) {
    const at = toTime(order && order.created_at);
    if (at === null) return null;
    return Math.max(0, Math.floor(((now || Date.now()) - at) / 60000));
  }

  const DEFAULT_THRESHOLDS = { warn: 5, late: 10 };

  /** 'ok' | 'warn' | 'late'. Sirve para el color de la tarjeta. */
  function urgency(minutes, thresholds) {
    const th = thresholds || DEFAULT_THRESHOLDS;
    if (minutes === null || minutes === undefined) return 'ok';
    if (minutes >= th.late) return 'late';
    if (minutes >= th.warn) return 'warn';
    return 'ok';
  }

  /**
   * Reparte los pedidos en carriles, **el más viejo primero** dentro de cada uno.
   * Ese orden no es estético: es la regla de la barra. Si se ordenara por el último
   * cambio, un pedido que nadie tocó se hunde y el cliente espera media hora.
   */
  function groupByLane(orders) {
    const lanes = { new: [], prep: [], ready: [] };
    for (const order of (orders || [])) {
      const lane = laneOf(order.status);
      if (lane) lanes[lane].push(order);
    }
    for (const lane of LANES) lanes[lane].sort(queueOrder);
    return lanes;
  }

  /**
   * El orden de la cola.
   *
   * Primero lo que el cantinero movio a mano (`bar_position`): tres tragos del mismo
   * whisky se preparan juntos, y obligarlo a seguir el orden de llegada es hacer la
   * barra mas lenta a proposito. Lo que NO se mueve es la hora: `created_at` sigue
   * siendo la auditoria, asi que el reporte del cierre dice cuanto espero de verdad
   * cada cliente aunque su tarjeta cambiara de lugar.
   *
   * Sin posicion puesta, el mas viejo primero. Ese orden no es estetico: si se
   * ordenara por el ultimo cambio, un pedido que nadie toco se hunde y el cliente
   * espera media hora.
   */
  function queueOrder(a, b) {
    const pa = Number.isFinite(Number(a.bar_position)) ? Number(a.bar_position) : null;
    const pb = Number.isFinite(Number(b.bar_position)) ? Number(b.bar_position) : null;
    if (pa !== null && pb !== null && pa !== pb) return pa - pb;
    if (pa !== null && pb === null) return -1;
    if (pa === null && pb !== null) return 1;
    const ta = toTime(a.created_at);
    const tb = toTime(b.created_at);
    if (ta === null) return 1;
    if (tb === null) return -1;
    return ta - tb;
  }

  /**
   * Solo los pedidos de UNA barra.
   *
   * La barra de arriba no tiene por que ver -ni preparar- los tragos de la de abajo:
   * dos colas mezcladas es como un trago se queda media hora esperando a que alguien
   * decida que le toca.
   */
  function filterByBar(orders, barId) {
    if (!barId) return (orders || []).slice();
    return (orders || []).filter((o) => o.bar_location_id === barId);
  }

  /**
   * La barra no sirve a credito: un pedido sin pagar se ve, pero no se prepara.
   *
   * `not_required` es un pedido que no cuesta nada (un producto de precio cero), que no
   * tiene cobro que esperar. Distinto de `pending`, que es dinero que nadie entrego.
   */
  const isPaid = (order) => ['paid', 'not_required'].includes(
    (order && order.payment_status) || 'not_required');

  /**
   * Mover una tarjeta de lugar dentro de su carril.
   *
   * Devuelve la lista COMPLETA de ids del carril en el orden nuevo, que es lo que
   * espera el servidor: mandar solo el id movido dejaria al resto sin posicion y el
   * siguiente reacomodo empezaria de cero.
   */
  function reorder(orders, lane, orderId, direction) {
    const list = groupByLane(orders)[lane] || [];
    const ids = list.map((o) => o.id);
    const from = ids.indexOf(orderId);
    if (from === -1) return null;
    const to = direction === 'up' ? from - 1 : from + 1;
    if (to < 0 || to >= ids.length) return null;
    ids.splice(to, 0, ids.splice(from, 1)[0]);
    return ids;
  }

  /** "2× Corona, 1× Margarita". Lo que el bartender tiene que preparar, de un vistazo. */
  function itemsSummary(order) {
    return ((order && order.items) || [])
      .map((i) => `${i.quantity}× ${i.name || i.drink_name || ''}`.trim())
      .join(', ');
  }

  /** Cuántos tragos salen en total: si son 12, no es "un pedido", es una ronda. */
  function itemCount(order) {
    return ((order && order.items) || []).reduce((n, i) => n + (Number(i.quantity) || 0), 0);
  }

  /** A dónde va: la mesa es lo único que el mesero necesita. */
  function destination(order) {
    if (!order) return null;
    // El punto de entrega manda sobre la mesa: en la pista no hay mesa, y "Pista A" es
    // una direccion a la que el mesero puede llegar. Un pedido sin ninguno de los dos
    // es la venta en la barra, que se entrega ahi mismo.
    if (order.delivery_point_name && order.delivery_point_kind !== 'table') {
      return order.delivery_point_name;
    }
    if (order.table_code) return order.table_code;
    if (order.delivery_point_name) return order.delivery_point_name;
    return null;
  }

  // ---------------------------------------------------------------- eventos

  /** Los eventos del socket que mueven la cola. `order_created` trae un pedido nuevo. */
  const ORDER_EVENTS = ['order_created', 'order_confirmed', 'order_preparing',
    'order_ready', 'order_delivered', 'order_cancelled', 'order_pos_error'];

  const statusFromType = (type) => (String(type || '').startsWith('order_')
    ? String(type).slice('order_'.length) : null);

  /**
   * Aplica un evento a la lista de pedidos. Devuelve qué pasó, para que la pantalla
   * decida si tiene que pedir el pedido completo al servidor.
   *
   * El evento trae el id y el estado, no el pedido entero: por eso `fetch` es la
   * respuesta correcta para uno que no está en la lista, y no inventarlo con lo poco
   * que trae el mensaje.
   */
  function applyEvent(orders, message) {
    // OJO: el tipo real viene en `event_type`. El `type` del mensaje siempre vale
    // 'event' — es la clase de trama del socket, no el evento. Leer `type` aquí hacía
    // que la cola no se enterara de nada, y las pruebas no lo veían porque el mensaje
    // de prueba se escribía a mano con la forma equivocada.
    const kind = message && (message.event_type || message.type);
    if (!message || !ORDER_EVENTS.includes(kind)) return { changed: false };
    const payload = message.payload || {};
    const id = payload.order_id;
    if (!id) return { changed: false };

    const status = payload.status || statusFromType(kind);
    const index = (orders || []).findIndex((o) => o.id === id);

    if (index === -1) {
      // No lo teníamos. Si ya está cerrado no hace falta traerlo; si sigue vivo, sí.
      if (isClosed(status)) return { changed: false };
      return { changed: true, fetch: id, status };
    }

    if (isClosed(status)) {
      orders.splice(index, 1);
      return { changed: true, removed: id, status };
    }

    orders[index] = Object.assign({}, orders[index], { status });
    return { changed: true, moved: id, status, lane: laneOf(status) };
  }

  /** Los conteos del encabezado. */
  function counts(orders) {
    const lanes = groupByLane(orders);
    return {
      new: lanes.new.length,
      prep: lanes.prep.length,
      ready: lanes.ready.length,
      total: lanes.new.length + lanes.prep.length + lanes.ready.length,
    };
  }

  /**
   * El pedido que lleva más esperando sin servir. Es el número que dice si la barra va
   * bien o va ahogada, mejor que el total de pedidos abiertos.
   */
  function oldestWait(orders, now) {
    let worst = null;
    for (const order of (orders || [])) {
      if (!laneOf(order.status) || order.status === 'ready') continue;
      const minutes = waitMinutes(order, now);
      if (minutes !== null && (worst === null || minutes > worst)) worst = minutes;
    }
    return worst;
  }

  return {
    LANES,
    LANE_OF,
    CLOSED,
    ORDER_EVENTS,
    DEFAULT_THRESHOLDS,
    laneOf,
    isClosed,
    nextAction,
    canCancel,
    waitMinutes,
    urgency,
    groupByLane,
    queueOrder,
    filterByBar,
    isPaid,
    reorder,
    itemsSummary,
    itemCount,
    destination,
    applyEvent,
    counts,
    oldestWait,
  };
}));
