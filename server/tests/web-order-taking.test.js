/**
 * Levantar el pedido en la mesa y cobrarlo, del lado de la pantalla.
 *
 * Lo que se prueba aquí es lo que cuesta dinero si sale mal: a qué mesa se le carga,
 * a nombre de quién, con qué monto, y qué falta antes de poder cobrar.
 */
'use strict';

const path = require('path');

const Take = require(path.join(__dirname, '..', '..', 'web', 'js', 'order-taking.js'));

const mesa = (over = {}) => ({
  id: 't1', code: '39', section: 'ZONA ROJA', capacity: 8, status: 'available',
  active: true, occupants: [], ...over,
});

describe('qué mesas puede atender', () => {
  it('incluye las vacías: el cliente de general no está registrado en la app', () => {
    const list = Take.servableTables([mesa({ id: 't1', occupants: [] })]);
    expect(list).toHaveLength(1);
    expect(list[0].guests).toEqual([]);
  });

  it('deja fuera las bloqueadas y las que están en limpieza', () => {
    const list = Take.servableTables([
      mesa({ id: 'a', status: 'blocked' }),
      mesa({ id: 'b', status: 'cleaning' }),
      mesa({ id: 'c', status: 'occupied' }),
    ]);
    expect(list.map((m) => m.id)).toEqual(['c']);
  });

  it('deja fuera las dadas de baja', () => {
    expect(Take.servableTables([mesa({ active: false })])).toHaveLength(0);
  });

  it('las ordena por zona y luego por número, como se camina el piso', () => {
    const list = Take.servableTables([
      mesa({ id: 'a', section: 'ZONA ROJA', code: '10' }),
      mesa({ id: 'b', section: 'ZONA AZUL', code: '2' }),
      mesa({ id: 'c', section: 'ZONA ROJA', code: '2' }),
    ]);
    expect(list.map((m) => m.id)).toEqual(['b', 'c', 'a']);
  });

  it('trae a quien sí está registrado, para poder cargarle el pedido', () => {
    const list = Take.servableTables([mesa({
      occupants: [{ user_id: 'u1', display_name: 'Ana' }],
    })]);
    expect(list[0].guests).toEqual([{ id: 'u1', name: 'Ana' }]);
  });
});

describe('lo que se manda al levantar el pedido', () => {
  const cart = [
    { drink: { id: 'd1', price: '60.00' }, quantity: 2 },
    { drink: { id: 'd2', price: '80.00' }, quantity: 1 },
  ];

  it('lleva la mesa y los artículos', () => {
    const body = Take.orderPayload({ tableId: 't1', cart, requestId: 'req-1' });
    expect(body).toEqual({
      client_request_id: 'req-1',
      table_id: 't1',
      items: [{ drink_id: 'd1', quantity: 2 }, { drink_id: 'd2', quantity: 1 }],
    });
  });

  it('sin cliente identificado NO manda on_behalf_of: el cobro es del mesero', () => {
    const body = Take.orderPayload({ tableId: 't1', guestId: null, cart, requestId: 'r' });
    expect(body).not.toHaveProperty('on_behalf_of');
  });

  it('con cliente identificado sí lo manda', () => {
    const body = Take.orderPayload({ tableId: 't1', guestId: 'u1', cart, requestId: 'r' });
    expect(body.on_behalf_of).toBe('u1');
  });
});

describe('el total se cuenta en centavos enteros', () => {
  it('tres de 79.90 suman 239.70 y no 239.70000000000002', () => {
    const cart = [{ drink: { id: 'd', price: '79.90' }, quantity: 3 }];
    expect(Take.totalCents(cart)).toBe(23970);
    expect(Take.fromCents(Take.totalCents(cart))).toBe('239.70');
  });

  it('un carrito vacío vale cero', () => {
    expect(Take.totalCents([])).toBe(0);
  });
});

describe('lo que se manda al cobrar', () => {
  const order = {
    id: 'o1', transaction_id: 'tx1', subtotal: '200.00', currency: 'MXN',
    sender_id: 'u1', payment_status: 'pending',
  };

  it('el monto sale del cobro del servidor, no de volver a sumar el carrito', () => {
    const body = Take.chargePayload({ order, method: 'cash' });
    expect(body).toMatchObject({ transaction_id: 'tx1', amount: 200, currency: 'MXN' });
  });

  it('dice de parte de quién se recibió el dinero', () => {
    expect(Take.chargePayload({ order, method: 'cash' }).on_behalf_of).toBe('u1');
  });

  it('el folio viaja recortado, y si va vacío no viaja', () => {
    expect(Take.chargePayload({ order, method: 'card_terminal', reference: '  V-77  ' }).reference)
      .toBe('V-77');
    expect(Take.chargePayload({ order, method: 'cash', reference: '   ' }))
      .not.toHaveProperty('reference');
  });
});

describe('qué falta antes de poder cobrar', () => {
  const order = { transaction_id: 'tx1', subtotal: '200.00', currency: 'MXN', payment_status: 'pending' };

  it('el efectivo no pide folio', () => {
    expect(Take.chargeBlocker({ order, method: 'cash' })).toBeNull();
  });

  it('la terminal del club SÍ pide folio: sin él no hay nada que cuadrar en el corte', () => {
    expect(Take.chargeBlocker({ order, method: 'card_terminal' })).toBe('no_reference');
    expect(Take.chargeBlocker({ order, method: 'card_terminal', reference: 'V-1' })).toBeNull();
  });

  it('una transferencia no se puede cerrar en la mesa', () => {
    expect(Take.chargeBlocker({ order, method: 'spei', reference: 'ABC' })).toBe('no_method');
    // En la mesa solo se cierra lo que se liquida ahí mismo: el dinero en la mano, el
    // voucher del banco, o la terminal del club cobrando sola (D47). Una transferencia
    // la confirma el gerente contra el estado de cuenta.
    expect(Take.methodKeys()).toEqual(['cash', 'mercadopago_point', 'card_terminal']);
  });

  it('el cobro con terminal no pide folio, y no se puede sin terminal dada de alta', () => {
    // No hay folio que teclear: lo que hay es una terminal que cobra sola. Y ofrecer el
    // método sin ninguna terminal dada de alta deja al mesero tocando un botón que solo
    // sabe fallar desde el servidor, con el cliente enfrente.
    expect(Take.isTerminalMethod('mercadopago_point')).toBe(true);
    expect(Take.isTerminalMethod('card_terminal')).toBe(false);
    expect(Take.methodFor('mercadopago_point').requiresReference).toBe(false);

    expect(Take.chargeBlocker({ order, method: 'mercadopago_point', terminals: [] }))
      .toBe('no_terminal');
    expect(Take.chargeBlocker({ order, method: 'mercadopago_point', terminals: [{ id: 'a', active: false }] }))
      .toBe('no_terminal');
    expect(Take.chargeBlocker({ order, method: 'mercadopago_point', terminals: [{ id: 'a' }] }))
      .toBe(null);
    // Sin pasar la lista se comporta como antes: quien no la conoce no bloquea nada.
    expect(Take.chargeBlocker({ order, method: 'mercadopago_point' })).toBe(null);
  });

  it('no se cobra dos veces lo ya pagado', () => {
    expect(Take.chargeBlocker({ order: { ...order, payment_status: 'paid' }, method: 'cash' }))
      .toBe('already_paid');
  });

  it('un pedido sin cobro no se puede cobrar', () => {
    expect(Take.chargeBlocker({ order: { payment_status: 'not_required' }, method: 'cash' }))
      .toBe('no_charge');
  });
});

describe('qué falta antes de poder levantar el pedido', () => {
  it('sin mesa no se levanta: el trago no sabría a dónde ir', () => {
    expect(Take.orderBlocker({ tableId: null, cart: [{}] })).toBe('no_table');
  });

  it('sin nada en el carrito tampoco', () => {
    expect(Take.orderBlocker({ tableId: 't1', cart: [] })).toBe('empty_cart');
  });

  it('con mesa y algo pedido, adelante', () => {
    expect(Take.orderBlocker({ tableId: 't1', cart: [{}] })).toBeNull();
  });
});

describe('lo que hay que ir a cobrar', () => {
  const pedido = (over) => ({
    id: 'o', status: 'pending', payment_status: 'pending',
    created_at: '2026-09-11T02:00:00Z', ...over,
  });

  it('solo lo que sigue esperando dinero', () => {
    const list = Take.awaitingPayment([
      pedido({ id: 'a' }),
      pedido({ id: 'b', payment_status: 'paid', status: 'confirmed' }),
      pedido({ id: 'c', payment_status: 'not_required' }),
    ]);
    expect(list.map((o) => o.id)).toEqual(['a']);
  });

  it('lo más viejo primero: es lo que más cerca está de irse sin pagar', () => {
    const list = Take.awaitingPayment([
      pedido({ id: 'nuevo', created_at: '2026-09-11T02:30:00Z' }),
      pedido({ id: 'viejo', created_at: '2026-09-11T01:00:00Z' }),
    ]);
    expect(list.map((o) => o.id)).toEqual(['viejo', 'nuevo']);
  });

  it('sin pedidos no truena', () => {
    expect(Take.awaitingPayment(null)).toEqual([]);
  });
});

describe('si el precio cambió entre armar y cobrar', () => {
  it('lo dice, y manda el importe del servidor', () => {
    const cart = [{ drink: { id: 'd', price: '60.00' }, quantity: 2 }];
    const order = { subtotal: '130.00' };
    expect(Take.priceDrift(cart, order)).toBe(1000);
  });

  it('si coinciden, cero', () => {
    const cart = [{ drink: { id: 'd', price: '60.00' }, quantity: 2 }];
    expect(Take.priceDrift(cart, { subtotal: '120.00' })).toBe(0);
  });
});

/**
 * A dónde se lleva, y qué falta por entregar.
 *
 * El cliente de general no tiene mesa: está en la pista. Sin un punto de entrega, el
 * pedido no tiene dirección y el mesero sale a buscar a alguien con una charola en la
 * mano — que es exactamente lo que pasaba antes de esto.
 */
describe('Puntos de entrega', () => {
  const points = [
    { id: 'p1', name: 'Pista A', kind: 'floor', active: true, client_selectable: true },
    { id: 'p2', name: 'Terraza', kind: 'terrace', active: true, client_selectable: true },
    { id: 'p3', name: 'Barra planta baja', kind: 'bar', active: true, client_selectable: false },
    { id: 'p4', name: 'Mesa 39', kind: 'table', active: true, client_selectable: true },
    { id: 'p5', name: 'Pista vieja', kind: 'floor', active: false, client_selectable: true },
  ];

  it('el cliente ve la pista y la terraza, nunca la barra', () => {
    expect(Take.deliveryPoints(points).map((p) => p.name)).toEqual(['Pista A', 'Terraza']);
  });

  it('el personal sí puede usar la barra: la venta en barra se entrega ahí mismo', () => {
    expect(Take.deliveryPoints(points, { forStaff: true }).map((p) => p.name))
      .toEqual(['Barra planta baja', 'Pista A', 'Terraza']);
  });

  it('las mesas no son puntos de esta lista: la mesa se elige en el plano', () => {
    expect(Take.deliveryPoints(points, { forStaff: true }).some((p) => p.kind === 'table'))
      .toBe(false);
  });

  it('un punto apagado no se ofrece', () => {
    expect(Take.deliveryPoints(points).some((p) => p.id === 'p5')).toBe(false);
  });
});

describe('El pedido lleva UNA dirección', () => {
  const cart = [{ drink: { id: 'd1', price: '150.00' }, quantity: 1 }];

  it('con mesa manda mesa y nada más', () => {
    const body = Take.orderPayload({ tableId: 't1', cart, requestId: 'r1', deliveryPointId: 'p1' });
    expect(body.table_id).toBe('t1');
    expect(body.delivery_point_id).toBeUndefined();
  });

  it('sin mesa manda el punto de la pista', () => {
    const body = Take.orderPayload({ tableId: null, cart, requestId: 'r1', deliveryPointId: 'p1' });
    expect(body.delivery_point_id).toBe('p1');
    expect(body.table_id).toBeUndefined();
  });

  it('la venta en barra manda la barra de la que sale', () => {
    const body = Take.orderPayload({ cart, requestId: 'r1', barLocationId: 'b1' });
    expect(body.bar_location_id).toBe('b1');
  });

  it('sin ninguna dirección no se manda: una charola sin destino', () => {
    expect(Take.orderBlocker({ cart })).toBe('no_table');
    expect(Take.orderBlocker({ cart, deliveryPointId: 'p1' })).toBeNull();
    expect(Take.orderBlocker({ cart, barLocationId: 'b1' })).toBeNull();
  });
});

describe('Lo que hay que entregar', () => {
  const now = Date.parse('2026-09-14T02:00:00Z');
  const orders = [
    { id: 'a', status: 'ready', created_at: '2026-09-14T01:00:00Z', ready_at: '2026-09-14T01:50:00Z' },
    { id: 'b', status: 'ready', created_at: '2026-09-14T01:30:00Z', ready_at: '2026-09-14T01:40:00Z' },
    { id: 'c', status: 'preparing', created_at: '2026-09-14T01:10:00Z' },
  ];

  it('solo los que la barra marcó listos', () => {
    expect(Take.readyToDeliver(orders).map((o) => o.id)).toEqual(['b', 'a']);
  });

  it('ordena por cuándo quedó LISTO, no por cuándo se pidió', () => {
    // 'b' se pidió después que 'a', pero lleva más tiempo enfriándose en la barra.
    expect(Take.readyToDeliver(orders)[0].id).toBe('b');
  });

  it('dice cuántos minutos lleva esperando en la barra', () => {
    expect(Take.waitingSince(orders[1], now)).toBe(20);
    expect(Take.waitingSince(orders[0], now)).toBe(10);
  });

  it('un pedido de otro mesero no aparece en la lista de uno', () => {
    const mixed = [{ ...orders[0], taken_by: 'otro' }, { ...orders[1], taken_by: 'yo' }];
    expect(Take.readyToDeliver(mixed, { waiterId: 'yo' }).map((o) => o.id)).toEqual(['b']);
  });

  it('pero uno que nadie levantó sí: alguien tiene que llevarlo', () => {
    const mixed = [{ ...orders[0], taken_by: null }];
    expect(Take.readyToDeliver(mixed, { waiterId: 'yo' })).toHaveLength(1);
  });
});

/**
 * La venta en la barra.
 *
 * El cliente que llega, pide y paga ahí mismo. Antes de esto no existía en el sistema:
 * el cantinero servía el trago y el inventario nunca se enteraba.
 */
describe('Venta en la barra', () => {
  const cart = [{ drink: { id: 'd1', price: '150.00' }, quantity: 1 }];

  it('sin barra no se cobra: de algún estante tienen que salir los mililitros', () => {
    expect(Take.barSaleBlocker({ cart })).toBe('no_bar');
  });

  it('con la barra y algo en el carrito, se puede cobrar', () => {
    expect(Take.barSaleBlocker({ barId: 'b1', cart })).toBeNull();
  });

  it('un carrito vacío no se cobra', () => {
    expect(Take.barSaleBlocker({ barId: 'b1', cart: [] })).toBe('empty_cart');
  });

  it('NO pide mesa: una venta en barra se entrega en la barra', () => {
    const body = Take.orderPayload({ cart, requestId: 'r1', barLocationId: 'b1' });
    expect(body.bar_location_id).toBe('b1');
    expect(body.table_id).toBeUndefined();
    expect(body.delivery_point_id).toBeUndefined();
  });
});

describe('Lo que la barra puede servir ahora', () => {
  const carta = [
    { name: 'Con existencia', stock: 5, category: 'Drinks' },
    { name: 'Agotado', stock: 0, category: 'Drinks' },
    { name: 'Sin receta', stock: null, category: 'Botellas' },
    { name: 'Apagado por la barra', stock: 9, available: false, category: 'Drinks' },
  ];

  it('esconde lo que está en cero: ofrecerlo es prometer un trago que no hay', () => {
    // Ordenado por categoría: Botellas antes que Drinks, como se lee una carta.
    expect(Take.sellableDrinks(carta).map((d) => d.name))
      .toEqual(['Sin receta', 'Con existencia']);
  });

  it('lo que no lleva receta se vende libre: no se sabe cuánto hay y se dice', () => {
    expect(Take.sellableDrinks(carta).some((d) => d.name === 'Sin receta')).toBe(true);
  });

  it('lo que el cantinero apagó no aparece, aunque haya existencia', () => {
    expect(Take.sellableDrinks(carta).some((d) => d.name === 'Apagado por la barra')).toBe(false);
  });

  it('busca por nombre sin distinguir mayúsculas', () => {
    expect(Take.sellableDrinks(carta, { search: 'EXISTEN' }).map((d) => d.name))
      .toEqual(['Con existencia']);
  });

  it('ordena por categoría y luego por nombre, como se lee una carta', () => {
    const mezclado = [
      { name: 'Zombie', stock: 1, category: 'Drinks' },
      { name: 'Absolut', stock: 1, category: 'Botellas' },
      { name: 'Azulito', stock: 1, category: 'Drinks' },
    ];
    expect(Take.sellableDrinks(mezclado).map((d) => d.name))
      .toEqual(['Absolut', 'Azulito', 'Zombie']);
  });
});
