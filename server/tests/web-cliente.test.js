'use strict';

// Lógica de la pantalla del cliente (paso 5.2). Lo que se puede equivocar sin que se note
// —la cuenta del carrito, qué evento actualiza qué pedido, cuándo una mesa está llena—
// se prueba aquí; el HTML solo pinta lo que este módulo dice.

const C = require('../../web/js/client.js');

const drink = (over = {}) => Object.assign({
  id: 'd1', name: 'Cerveza', category: 'beer', price: '79.90', currency: 'MXN',
  available: true, stock: '10',
}, over);

// ---------------------------------------------------------------- carrito

describe('Carrito', () => {
  it('suma en centavos: tres de 79.90 son 239.70, no 239.70000000000002', () => {
    const cart = C.createCart();
    cart.add(drink(), 1); cart.add(drink(), 1); cart.add(drink(), 1);
    expect(cart.count).toBe(3);
    expect(cart.total).toBe('239.70');
    // Comprobación explícita de por qué no se usa float.
    expect(0.1 + 0.2).not.toBe(0.3);
    expect(C.fromCents(C.toCents('0.10') + C.toCents('0.20'))).toBe('0.30');
  });

  it('el subtotal por línea también cuadra', () => {
    const cart = C.createCart();
    cart.add(drink({ price: '33.33' }), 3);
    expect(cart.lines[0].subtotal).toBe('99.99');
  });

  it('no deja pedir más de lo que hay en existencia', () => {
    const cart = C.createCart();
    const d = drink({ stock: '2' });
    expect(cart.add(d)).toBe(true);
    expect(cart.add(d)).toBe(true);
    // Pedir un tercero solo produciría un error al final del flujo.
    expect(cart.add(d)).toBe(false);
    expect(cart.quantityOf('d1')).toBe(2);
  });

  it('ignora lo agotado y respeta el tope de 20 por bebida', () => {
    const cart = C.createCart();
    expect(cart.add(drink({ available: false }))).toBe(false);
    expect(cart.add(drink({ stock: '999' }), 50)).toBe(true);
    expect(cart.quantityOf('d1')).toBe(20);
  });

  it('quitar una línea la borra cuando llega a cero', () => {
    const cart = C.createCart();
    cart.add(drink(), 2);
    cart.remove('d1');
    expect(cart.count).toBe(1);
    cart.remove('d1');
    expect(cart.count).toBe(0);
    expect(cart.lines).toEqual([]);
    expect(cart.total).toBe('0.00');
  });

  it('mantiene la misma clave hasta que el pedido sale: reintentar no duplica', () => {
    const cart = C.createCart();
    let n = 0;
    const uuid = () => `clave-${++n}`;
    cart.add(drink());
    const first = cart.requestKey(uuid);
    // Doble toque del botón, o un reintento por tiempo de espera: la misma clave.
    expect(cart.requestKey(uuid)).toBe(first);
    cart.clear();
    cart.add(drink());
    expect(cart.requestKey(uuid)).not.toBe(first);
  });

  it('arma los renglones del pedido tal como los espera la API', () => {
    const cart = C.createCart();
    cart.add(drink(), 2);
    cart.add(drink({ id: 'd2', name: 'Tequila' }), 1);
    expect(cart.toOrderItems()).toEqual([
      { drink_id: 'd1', quantity: 2 },
      { drink_id: 'd2', quantity: 1 },
    ]);
  });
});

// ---------------------------------------------------------------- pedidos

describe('Estado de los pedidos', () => {
  it('traduce el estado a algo que el cliente entienda', () => {
    expect(C.orderLabel('ready')).toMatch(/barra/i);
    expect(C.orderLabel('ready', 'en')).toMatch(/bar/i);
    expect(C.orderLabel('preparing')).toBe('Preparando');
    // Un estado que no conocemos se muestra tal cual en vez de quedar en blanco.
    expect(C.orderLabel('inventado')).toBe('inventado');
  });

  it('la barra de avance crece y un cancelado no avanza', () => {
    expect(C.orderProgress('pending')).toBeCloseTo(0.2);
    expect(C.orderProgress('ready')).toBeCloseTo(0.8);
    expect(C.orderProgress('delivered')).toBe(1);
    expect(C.orderProgress('cancelled')).toBe(0);
  });

  it('sabe cuáles siguen abiertos, que son los que hay que vigilar', () => {
    expect(C.isOpenOrder('preparing')).toBe(true);
    expect(C.isOpenOrder('delivered')).toBe(false);
    expect(C.isOpenOrder('cancelled')).toBe(false);
  });
});

// ---------------------------------------------------------------- mesas

describe('Plano del club', () => {
  // Forma real de `GET /tables`: los pisos son 'baja' y 'alta', y la ocupación viene
  // como arreglo de personas, no como número.
  const persona = (id) => ({ user_id: id, display_name: 'X' });
  const tables = [
    { id: '1', code: 'A2', table_number: '2', section: 'Zona Azul', floor: 'baja', capacity: 4, occupants: [], status: 'available' },
    { id: '2', code: 'A10', table_number: '10', section: 'Zona Azul', floor: 'baja', capacity: 4, occupants: [persona('a'), persona('b'), persona('c'), persona('d')], status: 'occupied' },
    { id: '3', code: 'V1', table_number: 'V1', section: 'VIP', floor: 'alta', capacity: 10, occupants: [persona('yo'), persona('e')], status: 'occupied' },
    { id: '4', code: 'A1', table_number: '1', section: 'Zona Azul', floor: 'baja', capacity: 4, occupants: [], status: 'cleaning' },
  ];

  it('la planta baja va antes que la alta, aunque no sean números', () => {
    const groups = C.groupFloorPlan(tables);
    expect(groups.map((g) => g.floor)).toEqual(['baja', 'alta']);
    expect(groups.map((g) => g.label)).toEqual(['Planta baja', 'Planta alta']);
    const azul = groups[0].zones.find((z) => z.zone === 'Zona Azul');
    // "10" va después de "2": orden numérico, no alfabético.
    expect(azul.tables.map((t) => t.table_number)).toEqual(['1', '2', '10']);
    expect(groups[1].zones[0].zone).toBe('VIP');
  });

  it('cuenta la ocupación venga como arreglo o como número', () => {
    // `/tables` manda `occupants`; `/floor-plan` manda `seated`. Contar mal aquí deja al
    // cliente tocando mesas que ya están llenas.
    expect(C.seatedCount(tables[1])).toBe(4);
    expect(C.seatedCount({ seated: 3 })).toBe(3);
    expect(C.seatedCount({})).toBe(0);
  });

  it('encuentra mi mesa al recargar, por los ocupantes', () => {
    expect(C.myTable(tables, 'yo').code).toBe('V1');
    expect(C.myTable(tables, 'nadie')).toBeNull();
    expect(C.myTable([], 'yo')).toBeNull();
  });

  it('una mesa llena o en limpieza no se puede elegir', () => {
    expect(C.tableIsSelectable(tables[0])).toBe(true);   // libre
    expect(C.tableIsSelectable(tables[1])).toBe(false);  // llena
    expect(C.tableIsSelectable(tables[2])).toBe(true);   // VIP con lugar
    expect(C.tableIsSelectable(tables[3])).toBe(false);  // en limpieza
    expect(C.tableIsFull(tables[1])).toBe(true);
  });

  it('sin mesas no se rompe', () => {
    expect(C.groupFloorPlan([])).toEqual([]);
    expect(C.groupFloorPlan(undefined)).toEqual([]);
  });
});

// ---------------------------------------------------------------- eventos

describe('Eventos del socket', () => {
  const state = () => ({ orders: [{ id: 'o1', status: 'confirmed' }] });

  it('avanza el pedido que corresponde', () => {
    const s = state();
    const change = C.applyEvent(s, { event_type: 'order_ready', payload: { order_id: 'o1' } });
    expect(change).toMatchObject({ changed: 'orders', status: 'ready' });
    expect(s.orders[0].status).toBe('ready');
  });

  it('un pedido que no tenemos pide recargar en vez de inventarlo', () => {
    const s = state();
    const change = C.applyEvent(s, { event_type: 'order_ready', payload: { order_id: 'otro' } });
    expect(change).toMatchObject({ changed: 'orders', unknownOrder: 'otro' });
  });

  it('`order_created` no es un estado y no ensucia el pedido', () => {
    const s = state();
    C.applyEvent(s, { event_type: 'order_created', payload: { order_id: 'o1' } });
    expect(s.orders[0].status).toBe('confirmed');
  });

  it('una invitación devuelta se muestra como tal', () => {
    const s = state();
    C.applyEvent(s, { event_type: 'order_returned', payload: { order_id: 'o1' } });
    expect(s.orders[0].status).toBe('returned_to_sender');
    expect(C.orderLabel('returned_to_sender')).toMatch(/devolvieron/i);
  });

  it('una mesa que cambió obliga a repintar el plano', () => {
    expect(C.applyEvent(state(), { event_type: 'table_updated', payload: {} }))
      .toEqual({ changed: 'floorPlan' });
  });

  it('lo que no es para esta pantalla se ignora sin ruido', () => {
    expect(C.applyEvent(state(), { event_type: 'withdrawal_approved', payload: {} })).toBeNull();
    expect(C.applyEvent(state(), {})).toBeNull();
    expect(C.applyEvent(state(), { event_type: 'order_ready', payload: {} })).toBeNull();
  });
});
