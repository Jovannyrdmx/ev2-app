/**
 * EV2 — estado de la pantalla del cliente (paso 5.2).
 *
 * Todo lo que se puede equivocar sin que se note —la cuenta del carrito, qué evento
 * actualiza qué pedido, cuándo una mesa está llena— vive aquí y se prueba sin navegador.
 * El HTML solo pinta lo que este módulo dice.
 */
(function (root, factory) {
  const lib = factory();
  if (typeof module === 'object' && module.exports) module.exports = lib;
  else root.EV2Client = lib;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const toCents = (amount) => Math.round(Number(amount) * 100);
  const fromCents = (cents) => (cents / 100).toFixed(2);

  /**
   * Carrito. Las cuentas se hacen en centavos enteros: en float, tres cervezas de 79.90
   * no suman 239.70, y el cliente ve un total que no cuadra con lo que se le cobra.
   */
  function createCart() {
    const lines = new Map(); // drinkId -> { drink, quantity }
    let requestId = null;

    return {
      get lines() {
        return [...lines.values()].map((l) => ({
          drink: l.drink,
          quantity: l.quantity,
          subtotal: fromCents(toCents(l.drink.price) * l.quantity),
        }));
      },
      get count() {
        return [...lines.values()].reduce((n, l) => n + l.quantity, 0);
      },
      get currency() {
        const first = lines.values().next().value;
        return first ? first.drink.currency : 'MXN';
      },
      get total() {
        let cents = 0;
        for (const l of lines.values()) cents += toCents(l.drink.price) * l.quantity;
        return fromCents(cents);
      },
      quantityOf(drinkId) {
        return lines.has(drinkId) ? lines.get(drinkId).quantity : 0;
      },
      /** Sube de uno en uno y respeta las existencias: no se pide lo que no hay. */
      add(drink, qty = 1) {
        if (!drink || drink.available === false) return false;
        const stock = drink.stock === undefined || drink.stock === null
          ? Infinity : Number(drink.stock);
        const current = this.quantityOf(drink.id);
        const next = Math.min(current + qty, stock, 20);
        if (next <= current) return false;
        lines.set(drink.id, { drink, quantity: next });
        return true;
      },
      remove(drinkId, qty = 1) {
        const line = lines.get(drinkId);
        if (!line) return false;
        line.quantity -= qty;
        if (line.quantity <= 0) lines.delete(drinkId);
        return true;
      },
      clear() { lines.clear(); requestId = null; },
      /**
       * La misma clave mientras el pedido no salga: si el botón se toca dos veces o la
       * red reintenta, el servidor devuelve el mismo pedido en vez de crear otro.
       */
      requestKey(uuid) {
        if (!requestId) requestId = uuid();
        return requestId;
      },
      newRequestKey() { requestId = null; },
      toOrderItems() {
        return [...lines.values()].map((l) => ({ drink_id: l.drink.id, quantity: l.quantity }));
      },
    };
  }

  // El orden en que el cliente ve avanzar su pedido.
  const ORDER_FLOW = ['pending', 'confirmed', 'preparing', 'ready', 'delivered'];

  const ORDER_LABELS = {
    es: {
      pending: 'Enviado', confirmed: 'Confirmado', preparing: 'Preparando',
      ready: '¡Listo! Recógelo en la barra', delivered: 'Entregado',
      cancelled: 'Cancelado', pos_error: 'Con problema, ya lo revisan',
      returned_to_sender: 'Te lo devolvieron',
    },
    en: {
      pending: 'Sent', confirmed: 'Confirmed', preparing: 'Preparing',
      ready: 'Ready! Pick it up at the bar', delivered: 'Delivered',
      cancelled: 'Cancelled', pos_error: 'There was a problem; staff is on it',
      returned_to_sender: 'It was returned to you',
    },
  };

  function orderLabel(status, lang = 'es') {
    const table = ORDER_LABELS[lang] || ORDER_LABELS.es;
    return table[status] || status;
  }

  /** Del 0 al 1, para la barra de avance. Un pedido cancelado no avanza. */
  function orderProgress(status) {
    if (status === 'cancelled' || status === 'pos_error') return 0;
    const i = ORDER_FLOW.indexOf(status);
    return i < 0 ? 0 : (i + 1) / ORDER_FLOW.length;
  }

  const isOpenOrder = (status) => !['delivered', 'cancelled'].includes(status);

  /**
   * Agrupa el plano como lo nombra el personal: primero por piso, luego por zona. Sin
   * esto, 55 mesas son una lista plana en la que nadie encuentra la suya.
   */
  // El club tiene dos plantas y el personal las llama por su nombre, no por número.
  const FLOOR_ORDER = { baja: 1, alta: 2 };
  const floorRank = (floor) => FLOOR_ORDER[floor] ?? (Number.isFinite(Number(floor)) ? Number(floor) : 99);
  const FLOOR_LABELS = { baja: 'Planta baja', alta: 'Planta alta' };
  const floorLabel = (floor) => FLOOR_LABELS[floor] || `Piso ${floor}`;

  function groupFloorPlan(tables) {
    const floors = new Map();
    for (const t of tables || []) {
      const floor = t.floor ?? 'baja';
      if (!floors.has(floor)) floors.set(floor, new Map());
      const zones = floors.get(floor);
      const zone = t.section || 'General';
      if (!zones.has(zone)) zones.set(zone, []);
      zones.get(zone).push(t);
    }
    return [...floors.entries()]
      .sort((a, b) => floorRank(a[0]) - floorRank(b[0]))
      .map(([floor, zones]) => ({
        floor,
        label: floorLabel(floor),
        zones: [...zones.entries()].sort((a, b) => a[0].localeCompare(b[0]))
          .map(([zone, list]) => ({
            zone,
            tables: list.sort((a, b) => String(a.table_number || a.code)
              .localeCompare(String(b.table_number || b.code), undefined, { numeric: true })),
          })),
      }));
  }

  /**
   * `/tables` devuelve `occupants` (un arreglo) y `/floor-plan` devuelve `seated` (un
   * número). Contar mal aquí deja al cliente tocando mesas que ya están llenas.
   */
  function seatedCount(table) {
    if (!table) return 0;
    if (Array.isArray(table.occupants)) return table.occupants.length;
    return Number(table.seated ?? 0) || 0;
  }

  function tableIsFull(table) {
    if (!table) return true;
    return seatedCount(table) >= Number(table.capacity || 0);
  }

  /** La mesa donde estoy sentado, según los ocupantes que devuelve la API. */
  function myTable(tables, userId) {
    return (tables || []).find((t) => Array.isArray(t.occupants)
      && t.occupants.some((o) => o.user_id === userId)) || null;
  }

  function tableIsSelectable(table) {
    if (!table) return false;
    if (['blocked', 'cleaning'].includes(table.status)) return false;
    return !tableIsFull(table);
  }

  /**
   * Aplica un evento del socket al estado. Devuelve qué cambió para que la pantalla
   * vuelva a pintar solo eso, y `null` si el evento no era para esta pantalla.
   */
  function applyEvent(state, message) {
    const type = message && message.event_type;
    const payload = (message && message.payload) || {};
    if (!type) return null;

    if (type.startsWith('order_')) {
      const id = payload.order_id || payload.id;
      if (!id) return null;
      const order = (state.orders || []).find((o) => o.id === id);
      if (!order) return { changed: 'orders', unknownOrder: id };
      if (type === 'order_returned') {
        order.status = 'returned_to_sender';
      } else {
        const next = type.replace('order_', '');
        // `order_created` no es un estado; el resto del nombre sí lo es.
        if (ORDER_FLOW.includes(next) || next === 'cancelled' || next === 'pos_error') {
          order.status = next;
        }
      }
      if (payload.status) order.status = payload.status;
      return { changed: 'orders', orderId: id, status: order.status };
    }

    if (type === 'table_updated') return { changed: 'floorPlan' };
    if (type === 'flirt_received') return { changed: 'flirts', payload };
    return null;
  }

  return {
    createCart, orderLabel, orderProgress, isOpenOrder, groupFloorPlan,
    tableIsFull, tableIsSelectable, seatedCount, myTable, floorLabel, applyEvent,
    toCents, fromCents,
    ORDER_FLOW, ORDER_LABELS,
  };
}));
