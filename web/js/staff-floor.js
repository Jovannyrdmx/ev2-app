/**
 * EV2 — el piso, visto por el mesero y la hostess (paso 5.7, segunda mitad).
 *
 * El mesero no necesita la cola de la barra: necesita **qué charolas hay que llevar y a
 * qué mesa**. Y necesita que el orden sea el de la barra, no el de la pantalla: un trago
 * que lleva diez minutos listo se echa a perder mientras otro recién servido se lleva
 * primero.
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EV2Staff = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const toTime = (iso) => {
    const ms = Date.parse(iso);
    return Number.isFinite(ms) ? ms : null;
  };

  /**
   * Lo que hay que llevar AHORA: solo lo que la barra marcó listo. Un pedido en
   * preparación no se recoge — el mesero llegaría a la barra a esperar.
   */
  const isDeliverable = (order) => order && order.status === 'ready';

  /** Lo que sigue vivo pero todavía no se puede llevar: sirve para saber qué viene. */
  const isComing = (order) => order && ['pending', 'confirmed', 'preparing'].includes(order.status);

  /**
   * Minutos desde que la barra lo dejó listo. NO desde que el cliente lo pidió: aquí lo
   * que se mide es cuánto lleva el trago parado en la barra, que es lo que lo arruina.
   */
  function readyMinutes(order, now) {
    const at = toTime(order && order.ready_at);
    if (at === null) return null;
    return Math.max(0, Math.floor(((now || Date.now()) - at) / 60000));
  }

  const THRESHOLDS = { warn: 3, late: 6 };

  /** 'ok' | 'warn' | 'late' — el color de la charola. Un trago con hielo no espera. */
  function urgency(minutes, thresholds) {
    const th = thresholds || THRESHOLDS;
    if (minutes === null || minutes === undefined) return 'ok';
    if (minutes >= th.late) return 'late';
    if (minutes >= th.warn) return 'warn';
    return 'ok';
  }

  /**
   * Agrupa lo que está listo POR MESA: un viaje por mesa, no uno por pedido. Las mesas
   * salen ordenadas por el pedido más viejo que tienen esperando.
   *
   * Los pedidos sin mesa (una invitación a alguien que no está sentado) van juntos al
   * final, en su propio grupo: no se pueden repartir, pero tampoco desaparecer.
   */
  function trays(orders, now) {
    const groups = new Map();
    for (const order of (orders || [])) {
      if (!isDeliverable(order)) continue;
      const key = order.table_id || '';
      if (!groups.has(key)) {
        groups.set(key, {
          table_id: order.table_id || null,
          table_code: order.table_code || null,
          orders: [],
          items: 0,
          oldestReady: null,
        });
      }
      const group = groups.get(key);
      group.orders.push(order);
      group.items += ((order.items || []).reduce((n, i) => n + (Number(i.quantity) || 0), 0));
      const at = toTime(order.ready_at);
      if (at !== null && (group.oldestReady === null || at < group.oldestReady)) {
        group.oldestReady = at;
      }
    }
    const list = [...groups.values()];
    for (const group of list) {
      group.waitMinutes = group.oldestReady === null
        ? null : Math.max(0, Math.floor(((now || Date.now()) - group.oldestReady) / 60000));
      group.urgency = urgency(group.waitMinutes);
    }
    return list.sort((a, b) => {
      // Los sin mesa siempre al final: no son un destino.
      if (!a.table_id && b.table_id) return 1;
      if (a.table_id && !b.table_id) return -1;
      if (a.oldestReady === null) return 1;
      if (b.oldestReady === null) return -1;
      return a.oldestReady - b.oldestReady;
    });
  }

  /** Lo que resume el encabezado: cuántas charolas y cuánto lleva la más vieja. */
  function summary(orders, now) {
    const list = trays(orders, now);
    const coming = (orders || []).filter(isComing).length;
    const worst = list.reduce((max, g) => (
      g.waitMinutes !== null && (max === null || g.waitMinutes > max) ? g.waitMinutes : max), null);
    return {
      trays: list.length,
      items: list.reduce((n, g) => n + g.items, 0),
      coming,
      oldest: worst,
    };
  }

  // ---------------------------------------------------------------- ocupación

  /**
   * La ocupación del club por piso y zona, tal como la devuelve `/tables/stats`. Se
   * normaliza aquí porque la hostess la lee de un vistazo para saber a dónde mandar a
   * la siguiente mesa.
   */
  function occupancy(stats) {
    const s = stats || {};
    const total = s.total || {};
    // El servidor llama `tables` al conteo (ROLLUP en /tables/stats), no `total`.
    const count = (row) => Number(row && row.tables) || 0;
    const busy = (row) => Number(row && row.occupied) || 0;
    const free = (row) => Math.max(count(row) - busy(row), 0);

    return {
      total: count(total),
      occupied: busy(total),
      free: free(total),
      guests: Number(total.guests) || 0,
      pct: Number(total.tables_occupied_pct) || 0,
      floors: (s.floors || []).map((floor) => ({
        floor: floor.floor,
        total: count(floor),
        occupied: busy(floor),
        free: free(floor),
        sections: (floor.sections || []).map((section) => ({
          section: section.section,
          total: count(section),
          occupied: busy(section),
          free: free(section),
        })),
      })),
    };
  }

  // ---------------------------------------------------------------- turno y propinas

  /** Cuánto lleva el turno abierto, en minutos. */
  function shiftMinutes(shift, now) {
    const at = toTime(shift && shift.started_at);
    if (at === null) return null;
    const end = toTime(shift && shift.ended_at);
    return Math.max(0, Math.floor(((end === null ? (now || Date.now()) : end) - at) / 60000));
  }

  /**
   * Las propinas de la noche, separadas por si ya se confirmaron o no.
   *
   * Una propina `pending` todavía NO es dinero del empleado: el gerente la confirma
   * cuando la recibe. Sumarlas juntas le haría creer que tiene un saldo que no tiene.
   */
  function tipTotals(tips, currency) {
    const wanted = currency || 'MXN';
    let paidCents = 0;
    let pendingCents = 0;
    let count = 0;
    for (const tip of (tips || [])) {
      if ((tip.currency || 'MXN') !== wanted) continue;
      const cents = Math.round(Number(tip.amount) * 100);
      if (!Number.isFinite(cents)) continue;
      count += 1;
      if (tip.status === 'paid') paidCents += cents;
      else if (tip.status === 'pending') pendingCents += cents;
    }
    return {
      currency: wanted,
      count,
      paid: (paidCents / 100).toFixed(2),
      pending: (pendingCents / 100).toFixed(2),
    };
  }

  // ---------------------------------------------------------------- eventos

  const ORDER_EVENTS = ['order_created', 'order_confirmed', 'order_preparing',
    'order_ready', 'order_delivered', 'order_cancelled'];

  /**
   * Qué hacer con un evento. Solo `order_ready` merece avisar al mesero: los demás
   * cambian la lista pero no le piden que se levante.
   *
   * OJO: el tipo real viaja en `event_type`; `type` siempre vale 'event'.
   */
  function applyEvent(message) {
    const kind = message && (message.event_type || message.type);
    if (kind === 'table_updated') return { changed: true, reloadTables: true };
    if (!ORDER_EVENTS.includes(kind)) return { changed: false };
    return {
      changed: true,
      reloadOrders: true,
      announce: kind === 'order_ready',
      orderId: (message.payload || {}).order_id || null,
    };
  }

  return {
    THRESHOLDS,
    ORDER_EVENTS,
    isDeliverable,
    isComing,
    readyMinutes,
    urgency,
    trays,
    summary,
    occupancy,
    shiftMinutes,
    tipTotals,
    applyEvent,
  };
}));
