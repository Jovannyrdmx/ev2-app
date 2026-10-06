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
   * Agrupa lo que está listo POR DESTINO: un viaje por mesa o por punto de entrega
   * ("Pista A", "Terraza"), no uno por pedido. Salen ordenados por el pedido más viejo
   * que tienen esperando.
   *
   * Antes solo se agrupaba por mesa y lo de la pista caía en "Sin mesa": el mesero veía
   * la charola pero no a dónde llevarla (D89). Lo que no tiene ni mesa ni punto (una
   * invitación a alguien que no está sentado) va junto al final: no es un destino, pero
   * tampoco desaparece.
   */
  function trays(orders, now) {
    const groups = new Map();
    for (const order of (orders || [])) {
      if (!isDeliverable(order)) continue;
      const point = !order.table_id && order.delivery_point_id ? order.delivery_point_id : null;
      const key = order.table_id ? `t:${order.table_id}` : (point ? `p:${point}` : '');
      if (!groups.has(key)) {
        groups.set(key, {
          key,
          table_id: order.table_id || null,
          table_code: order.table_code || null,
          point_id: point,
          point_name: point ? (order.delivery_point_name || null) : null,
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
      // Lo que no tiene destino siempre al final.
      if (!a.key && b.key) return 1;
      if (a.key && !b.key) return -1;
      if (a.oldestReady === null) return 1;
      if (b.oldestReady === null) return -1;
      return a.oldestReady - b.oldestReady;
    });
  }

  /**
   * ¿Este pedido le toca a este mesero? Lo que él levantó y lo que pidió el cliente desde
   * su teléfono (no tiene mesero). Lo de otro mesero, no: es su mesa y su propina. Es la
   * misma regla con la que antes se armaba "Listos para llevar" en Mesas.
   */
  const isMine = (order, waiterId) => !waiterId || !order.taken_by || order.taken_by === waiterId;

  /**
   * Las charolas, partidas en las de este mesero y las de los demás (D89). Antes había
   * dos listas de lo mismo, una con todo y otra solo con lo suyo, y cada una con su
   * botón de "Entregado".
   */
  function splitTrays(orders, now, waiterId) {
    const mine = []; const others = [];
    for (const o of (orders || [])) (isMine(o, waiterId) ? mine : others).push(o);
    return { mine: trays(mine, now), others: trays(others, now) };
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

  // ---------------------------------------------------------------- las mesas del mesero (D89)

  const fold = (text) => String(text == null ? '' : text)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

  /** Las zonas que hay, en el orden en que aparecen en el plano. */
  function zones(tables) {
    return [...new Set((tables || []).map((m) => m.section).filter(Boolean))];
  }

  /**
   * Las mesas que este mesero atendió esta noche: las de sus pedidos (entregados o no).
   * `orders` es lo que devuelve `/orders?mine=true&since_hours=…`.
   */
  function myTableIds(orders, waiterId) {
    const ids = new Set();
    for (const o of (orders || [])) {
      if (!o || !o.table_id || o.status === 'cancelled') continue;
      if (waiterId && o.taken_by && o.taken_by !== waiterId) continue;
      ids.add(o.table_id);
    }
    return ids;
  }

  /**
   * La cuadrícula de mesas: primero las suyas, luego las ocupadas o con algo en la
   * barra, luego el resto. Dentro de cada grupo, el orden del plano. La búsqueda es por
   * número de mesa (o por el nombre de alguien sentado), sin acentos.
   *
   * Cada mesa sale con `mine`, `busy` (gente o pedidos vivos) y `active` (pedidos vivos).
   */
  function tableGrid(tables, { search = '', zone = null, mine = new Set(), activeOrders = [] } = {}) {
    const vivos = new Map();
    for (const o of (activeOrders || [])) {
      if (o && o.table_id && ['pending', 'confirmed', 'preparing', 'ready'].includes(o.status)) {
        vivos.set(o.table_id, (vivos.get(o.table_id) || 0) + 1);
      }
    }
    const q = fold(search);
    const list = (tables || [])
      .filter((m) => !zone || m.section === zone)
      .filter((m) => {
        if (!q) return true;
        const code = fold(m.code);
        // "5" encuentra la 5 antes que la 15: primero el número exacto, luego lo que empiece.
        return code === q || code.startsWith(q)
          || (m.guests || []).some((g) => fold(g.name).includes(q));
      })
      .map((m, i) => ({
        ...m,
        order: i,
        mine: mine.has(m.id),
        active: vivos.get(m.id) || 0,
        busy: (m.guests || []).length > 0 || vivos.has(m.id),
      }));
    // Buscando, la mesa con ese número exacto va antes que todo: quien teclea "5"
    // busca la 5, aunque la 51 sea suya.
    const exacta = (m) => (q && fold(m.code) === q ? 0 : 1);
    const rank = (m) => (m.mine ? 0 : m.busy ? 1 : 2);
    return list.sort((a, b) => (exacta(a) - exacta(b))
      || (rank(a) - rank(b))
      || (a.order - b.order));
  }

  /**
   * "Otra ronda" (D89): lo último que se pidió para esa mesa, para volver a armarlo de
   * un toque. Solo los productos que siguen en la carta; el mesero revisa antes de mandar.
   * Devuelve `{ order, items: [{ drink, quantity }] }` o null.
   */
  function lastRound(orders, tableId, drinks) {
    if (!tableId) return null;
    const ultimo = (orders || [])
      .filter((o) => o && o.table_id === tableId && o.status !== 'cancelled')
      .sort((a, b) => (toTime(b.created_at) || 0) - (toTime(a.created_at) || 0))[0];
    if (!ultimo) return null;
    const carta = new Map((drinks || []).filter((d) => d && d.available !== false).map((d) => [d.id, d]));
    const items = (ultimo.items || [])
      .filter((i) => carta.has(i.drink_id) && Number(i.quantity) > 0)
      .map((i) => ({ drink: carta.get(i.drink_id), quantity: Number(i.quantity) }));
    return items.length ? { order: ultimo, items } : null;
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
    isMine,
    splitTrays,
    summary,
    zones,
    myTableIds,
    tableGrid,
    lastRound,
    occupancy,
    shiftMinutes,
    tipTotals,
    applyEvent,
  };
}));
