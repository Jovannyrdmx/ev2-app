/**
 * EV2 — levantar un pedido en la mesa y cobrarlo ahí mismo (paso 5.7).
 *
 * El cliente de admisión general no está registrado en la app: entra, paga su acceso en
 * la puerta y se sienta donde quiere. Alguien tiene que levantarle el pedido, y ese
 * alguien es el mesero. Lo que decide este módulo —a qué mesa, a nombre de quién, cuánto
 * y con qué se cobra— se prueba sin navegador, porque equivocarse aquí es cobrar de más,
 * cobrar a quien no era, o mandar a la barra un trago que nadie pagó.
 *
 * El carrito no se reinventa: es el de `EV2Client`, que ya suma en centavos enteros y
 * respeta existencias.
 */
(function (root, factory) {
  const lib = factory();
  if (typeof module === 'object' && module.exports) module.exports = lib;
  else root.EV2OrderTaking = lib;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const toCents = (amount) => Math.round(Number(amount) * 100);
  const fromCents = (cents) => (cents / 100).toFixed(2);

  /**
   * Formas de pago que el mesero puede cerrar en la mesa.
   *
   * Solo lo que queda cobrado en el momento: el billete en la mano, o un voucher que el
   * banco ya aprobó. Una transferencia no se puede verificar de pie junto a la mesa, así
   * que no está aquí — esa la confirma el gerente contra el estado de cuenta.
   *
   * `requiresReference` es lo que hace auditable el corte: sin el folio del voucher, un
   * cobro con terminal es la palabra del mesero contra el estado de cuenta del banco.
   */
  /**
   * Cómo se cobra en la mesa.
   *
   * `mercadopago_point` no es un pago manual como los otros dos: no registra dinero que
   * ya cambió de manos, sino que le dice a la terminal del club que cobre (D47). Por eso
   * no pide folio — no hay nada que teclear — y por eso `isTerminal` existe: la pantalla
   * tiene que mandarlo por otra ruta y quedarse esperando la tarjeta.
   *
   * Vive en la MISMA lista que efectivo y terminal-del-banco a propósito. Para el mesero
   * es la misma pregunta de siempre —¿con qué me paga?— y partirla en dos botones en
   * pantallas distintas sería inventar una diferencia que al cliente no le importa.
   */
  const METHODS = [
    { key: 'cash', requiresReference: false, isTerminal: false },
    { key: 'mercadopago_point', requiresReference: false, isTerminal: true },
    { key: 'card_terminal', requiresReference: true, isTerminal: false },
  ];

  /** Si ese método lo cobra la terminal por su cuenta en vez de registrarse a mano. */
  const isTerminalMethod = (key) => Boolean((METHODS.find((m) => m.key === key) || {}).isTerminal);

  const methodKeys = () => METHODS.map((m) => m.key);
  const methodFor = (key) => METHODS.find((m) => m.key === key) || null;

  /**
   * Las mesas como las necesita el mesero: todas las activas, no solo las que tienen
   * gente identificada.
   *
   * Una mesa de general casi nunca tiene ocupantes en la app —el cliente no se registró—
   * y aun así hay que poder levantarle un pedido. Filtrar por ocupantes dejaba fuera
   * justo a la mayoría de la clientela.
   *
   * Salen ordenadas por zona y luego por código, que es como se camina el piso, y con
   * `guests` para poder decir "¿de quién es?" cuando sí hay alguien registrado.
   */
  function servableTables(tables) {
    return (tables || [])
      .filter((table) => table && table.active !== false
        && !['blocked', 'cleaning'].includes(table.status))
      .map((table) => ({
        id: table.id,
        code: table.table_number || table.code,
        section: table.section || '',
        status: table.status || 'available',
        capacity: Number(table.capacity) || 0,
        guests: (table.occupants || []).map((g) => ({
          id: g.user_id, name: g.display_name || null,
        })),
      }))
      .sort((a, b) => (a.section || '').localeCompare(b.section || '', 'es')
        || String(a.code).localeCompare(String(b.code), 'es', { numeric: true }));
  }

  /**
   * A donde se lleva, cuando no es una mesa.
   *
   * En la pista nadie tiene mesa: el cliente esta bailando y el mesero necesita un
   * lugar concreto al que llegar. Los puntos ("Pista A", "Terraza") los configura la
   * gerencia y cada uno tiene su QR pegado en una columna.
   *
   * La barra queda fuera a proposito (`client_selectable: false`): en esta primera
   * version el club no quiere gente amontonada en la barra esperando su trago. El
   * mesero si puede usarla, porque la venta en barra se entrega ahi mismo.
   */
  function deliveryPoints(points, { forStaff = false } = {}) {
    return (points || [])
      .filter((p) => p && p.active !== false && p.kind !== 'table')
      .filter((p) => forStaff || p.client_selectable !== false)
      .map((p) => ({ id: p.id, name: p.name, kind: p.kind, floor: p.floor || null }))
      .sort((a, b) => String(a.name).localeCompare(String(b.name), 'es', { numeric: true }));
  }

  /**
   * Lo que se manda al crear el pedido. `on_behalf_of` solo si hay cliente
   * identificado; `delivery_point_id` solo cuando no se entrega en una mesa.
   *
   * Nunca los dos: una mesa YA es un punto de entrega, y mandar los dos deja al mesero
   * con dos direcciones distintas para la misma charola.
   */
  function orderPayload({ tableId, guestId, cart, requestId, deliveryPointId, barLocationId }) {
    const body = {
      client_request_id: requestId,
      items: (cart || []).map((line) => ({
        drink_id: line.drink.id,
        quantity: line.quantity,
      })),
    };
    if (tableId) body.table_id = tableId;
    else if (deliveryPointId) body.delivery_point_id = deliveryPointId;
    if (barLocationId) body.bar_location_id = barLocationId;
    if (guestId) body.on_behalf_of = guestId;
    return body;
  }

  /**
   * Lo que se manda al cobrar. El monto NO se recalcula del carrito: se toma del cobro
   * que devolvió el servidor. Si los dos no coinciden, el que manda es el libro contable,
   * y volver a sumar aquí solo serviría para inventar una diferencia.
   */
  function chargePayload({ order, method, reference }) {
    const body = {
      transaction_id: order.transaction_id,
      method,
      amount: Number(order.subtotal),
      currency: order.currency,
    };
    const ref = String(reference == null ? '' : reference).trim();
    if (ref) body.reference = ref;
    if (order.sender_id) body.on_behalf_of = order.sender_id;
    return body;
  }

  /**
   * Por qué todavía no se puede cobrar. Devuelve la razón, no un booleano, para que la
   * pantalla diga qué falta en vez de dejar un botón apagado sin explicación.
   *
   * `null` significa que se puede.
   */
  function chargeBlocker({ order, method, reference, terminals }) {
    if (!order || !order.transaction_id) return 'no_charge';
    if (order.payment_status === 'paid') return 'already_paid';
    const found = methodFor(method);
    if (!found) return 'no_method';
    if (found.requiresReference && !String(reference == null ? '' : reference).trim()) {
      return 'no_reference';
    }
    // Cobrar con una terminal que no existe deja al mesero tocando un botón que falla
    // desde el servidor. Si no hay ninguna dada de alta, se dice aquí.
    if (found.isTerminal && terminals !== undefined
      && !(terminals || []).some((t) => t && t.active !== false)) {
      return 'no_terminal';
    }
    return null;
  }

  /**
   * Por qué todavía no se puede mandar el pedido. `null` significa que se puede.
   *
   * Hace falta UNA direccion: una mesa, un punto de la pista, o la barra en la que el
   * cantinero esta vendiendo. Un pedido sin direccion es una charola dando vueltas.
   */
  function orderBlocker({ tableId, cart, deliveryPointId, barLocationId }) {
    if (!tableId && !deliveryPointId && !barLocationId) return 'no_table';
    if (!cart || cart.length === 0) return 'empty_cart';
    return null;
  }

  /**
   * Los pedidos que el mesero tiene que ir a ENTREGAR: los que la barra ya marco
   * listos.
   *
   * Ordenados por la hora en que quedaron listos, no por la hora en que se pidieron: el
   * trago que lleva mas tiempo en la barra es el que se esta calentando, y es el que hay
   * que levantar primero aunque se haya pedido despues.
   */
  function readyToDeliver(orders, { waiterId } = {}) {
    return (orders || [])
      .filter((o) => o && o.status === 'ready')
      .filter((o) => !waiterId || !o.taken_by || o.taken_by === waiterId)
      .sort((a, b) => Date.parse(a.ready_at || a.created_at || 0)
        - Date.parse(b.ready_at || b.created_at || 0));
  }

  /** Cuantos minutos lleva listo, esperando a que alguien lo lleve. */
  function waitingSince(order, now) {
    const at = Date.parse((order && (order.ready_at || order.created_at)) || 0);
    if (!Number.isFinite(at)) return null;
    return Math.max(0, Math.floor(((now || Date.now()) - at) / 60000));
  }

  /**
   * Total del carrito en centavos enteros. Existe aparte del carrito para poder
   * comprobarlo contra lo que devuelve el servidor antes de cobrar: si el precio de una
   * bebida cambió entre que se armó el pedido y que se creó, el cliente tiene que ver el
   * precio real, no el que alcanzó a leer el mesero.
   */
  function totalCents(cart) {
    let cents = 0;
    for (const line of (cart || [])) cents += toCents(line.drink.price) * line.quantity;
    return cents;
  }

  /**
   * ¿Lo que se cobró es lo que se armó? Solo informativo: manda el servidor.
   * Devuelve la diferencia en centavos (positiva si el cobro salió más caro).
   */
  function priceDrift(cart, order) {
    if (!order || order.subtotal == null) return 0;
    return toCents(order.subtotal) - totalCents(cart);
  }

  /**
   * La venta en la barra: el cliente que llega, pide y paga ahí mismo.
   *
   * Es la mitad de la clientela de una barra y hasta ahora no existía en el sistema:
   * el cantinero la servía y el trago salía del inventario sin que nadie lo registrara,
   * o no salía en absoluto. `null` significa que se puede cobrar.
   *
   * No pide mesa a propósito: una venta en barra se entrega en la barra. Lo que sí pide
   * es LA BARRA, porque de ese estante van a salir los mililitros.
   */
  function barSaleBlocker({ barId, cart }) {
    if (!barId) return 'no_bar';
    if (!cart || cart.length === 0) return 'empty_cart';
    return null;
  }

  /**
   * Lo que la barra puede servir AHORA: disponible y con existencia en ese estante.
   *
   * Un producto sin receta (`stock: null`) se vende libre: el sistema no sabe cuánto
   * hay y decirlo es mejor que inventarlo. Lo que se esconde es lo que está en cero de
   * verdad, porque ofrecerlo es prometer un trago que no se puede servir.
   */
  function sellableDrinks(drinks, { search = '' } = {}) {
    const needle = String(search || '').trim().toLowerCase();
    return (drinks || [])
      .filter((d) => d && d.available !== false)
      .filter((d) => d.stock === null || d.stock === undefined || Number(d.stock) > 0)
      .filter((d) => !needle || String(d.name || '').toLowerCase().includes(needle))
      .sort((a, b) => String(a.category || '').localeCompare(String(b.category || ''), 'es')
        || String(a.name).localeCompare(String(b.name), 'es'));
  }

  /**
   * Los pedidos que el mesero tiene que ir a cobrar: los que alguien pidió desde su
   * teléfono y siguen esperando dinero. No incluye los que él mismo acaba de levantar y
   * cobrar, porque esos ya están.
   *
   * Ordenados del más viejo al más nuevo: el que lleva más rato esperando es el que más
   * cerca está de irse sin pagar.
   */
  function awaitingPayment(orders) {
    return (orders || [])
      .filter((o) => o && o.payment_status === 'pending' && o.status === 'pending')
      .sort((a, b) => Date.parse(a.created_at || 0) - Date.parse(b.created_at || 0));
  }

  return {
    METHODS,
    methodKeys,
    methodFor,
    isTerminalMethod,
    servableTables,
    deliveryPoints,
    orderPayload,
    chargePayload,
    chargeBlocker,
    orderBlocker,
    barSaleBlocker,
    sellableDrinks,
    totalCents,
    fromCents,
    priceDrift,
    awaitingPayment,
    readyToDeliver,
    waitingSince,
  };
}));
