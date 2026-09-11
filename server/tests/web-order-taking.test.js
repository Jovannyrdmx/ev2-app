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
    expect(Take.methodKeys()).toEqual(['cash', 'card_terminal']);
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
