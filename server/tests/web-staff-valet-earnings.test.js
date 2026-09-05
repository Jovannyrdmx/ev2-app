'use strict';

// Las tres pantallas que faltaban. Lo que se rompe callado en cada una:
// mesero  — una charola que se hunde en la lista mientras el hielo se derrite.
// valet   — un cliente parado en la puerta que queda debajo de un coche sin prisa.
// portal  — enseñar como disponible un dinero que todavía no está confirmado.

const Staff = require('../../web/js/staff-floor.js');
const Valet = require('../../web/js/valet-tickets.js');
const Earn = require('../../web/js/earnings.js');

const NOW = Date.parse('2026-09-06T05:00:00.000Z');
const agoMin = (n) => new Date(NOW - n * 60000).toISOString();

// ================================================================== MESERO

const order = (over = {}) => Object.assign({
  id: 'o1', status: 'ready', table_id: 't1', table_code: '39',
  ready_at: agoMin(2), created_at: agoMin(9),
  items: [{ name: 'Corona', quantity: 2 }],
}, over);

describe('Mesero: qué charolas hay que llevar', () => {
  it('solo lo que la barra marcó listo', () => {
    // Recoger algo "en preparación" es llegar a la barra a esperar.
    expect(Staff.isDeliverable(order({ status: 'ready' }))).toBe(true);
    for (const s of ['pending', 'confirmed', 'preparing', 'delivered', 'cancelled']) {
      expect(Staff.isDeliverable(order({ status: s }))).toBe(false);
    }
  });

  it('la espera se mide desde que quedó listo, no desde que lo pidieron', () => {
    // Lo que arruina el trago es el tiempo parado en la barra, no el total.
    const o = order({ created_at: agoMin(20), ready_at: agoMin(3) });
    expect(Staff.readyMinutes(o, NOW)).toBe(3);
  });

  it('una fecha inservible no imprime NaN', () => {
    expect(Staff.readyMinutes(order({ ready_at: null }), NOW)).toBe(null);
    expect(Staff.readyMinutes(order({ ready_at: 'ayer' }), NOW)).toBe(null);
  });

  it('el color avisa antes de que el hielo se derrita', () => {
    expect(Staff.urgency(0)).toBe('ok');
    expect(Staff.urgency(3)).toBe('warn');
    expect(Staff.urgency(6)).toBe('late');
    expect(Staff.urgency(null)).toBe('ok');
  });

  it('agrupa por mesa: un viaje por mesa, no uno por pedido', () => {
    const list = Staff.trays([
      order({ id: 'a', table_id: 't1', table_code: '39', items: [{ quantity: 2 }] }),
      order({ id: 'b', table_id: 't1', table_code: '39', items: [{ quantity: 1 }] }),
      order({ id: 'c', table_id: 't2', table_code: '40', items: [{ quantity: 3 }] }),
    ], NOW);
    expect(list).toHaveLength(2);
    const mesa39 = list.find((g) => g.table_code === '39');
    expect(mesa39.orders).toHaveLength(2);
    expect(mesa39.items).toBe(3);
  });

  it('la mesa que lleva más esperando va arriba', () => {
    const list = Staff.trays([
      order({ id: 'nueva', table_id: 't2', table_code: '40', ready_at: agoMin(1) }),
      order({ id: 'vieja', table_id: 't1', table_code: '39', ready_at: agoMin(8) }),
    ], NOW);
    expect(list[0].table_code).toBe('39');
    expect(list[0].waitMinutes).toBe(8);
    expect(list[0].urgency).toBe('late');
  });

  it('la espera de la mesa es la del pedido más viejo que tiene, no el promedio', () => {
    const list = Staff.trays([
      order({ id: 'a', ready_at: agoMin(9) }),
      order({ id: 'b', ready_at: agoMin(1) }),
    ], NOW);
    expect(list[0].waitMinutes).toBe(9);
  });

  it('los pedidos sin mesa van juntos al final, pero no desaparecen', () => {
    // Una invitación a alguien que no está sentado: no se puede repartir, pero existe.
    const list = Staff.trays([
      order({ id: 'suelto', table_id: null, table_code: null, ready_at: agoMin(30) }),
      order({ id: 'mesa', table_id: 't1', table_code: '39', ready_at: agoMin(1) }),
    ], NOW);
    expect(list).toHaveLength(2);
    expect(list[0].table_code).toBe('39');
    expect(list[1].table_id).toBe(null);
  });

  it('el resumen cuenta charolas, tragos y lo que viene en camino', () => {
    const s = Staff.summary([
      order({ id: 'a', table_id: 't1', items: [{ quantity: 2 }], ready_at: agoMin(5) }),
      order({ id: 'b', table_id: 't2', items: [{ quantity: 1 }], ready_at: agoMin(1) }),
      order({ id: 'c', status: 'preparing' }),
      order({ id: 'd', status: 'delivered' }),
    ], NOW);
    expect(s).toMatchObject({ trays: 2, items: 3, coming: 1, oldest: 5 });
  });

  it('sin nada listo el resumen son ceros, no huecos', () => {
    expect(Staff.summary([], NOW)).toEqual({ trays: 0, items: 0, coming: 0, oldest: null });
    expect(Staff.trays(undefined, NOW)).toEqual([]);
  });
});

describe('Mesero: turno y propinas', () => {
  it('el turno abierto se mide hasta ahora; el cerrado, hasta que cerró', () => {
    expect(Staff.shiftMinutes({ started_at: agoMin(125) }, NOW)).toBe(125);
    expect(Staff.shiftMinutes({ started_at: agoMin(125), ended_at: agoMin(65) }, NOW)).toBe(60);
    expect(Staff.shiftMinutes(null, NOW)).toBe(null);
  });

  it('una propina sin confirmar NO se suma con las cobradas', () => {
    // El gerente la confirma cuando la recibe. Sumarlas juntas le haría creer al
    // empleado que tiene un saldo que todavía no existe.
    const totals = Staff.tipTotals([
      { amount: '100.00', currency: 'MXN', status: 'paid' },
      { amount: '50.50', currency: 'MXN', status: 'pending' },
      { amount: '20.00', currency: 'MXN', status: 'cancelled' },
    ], 'MXN');
    expect(totals.paid).toBe('100.00');
    expect(totals.pending).toBe('50.50');
    expect(totals.count).toBe(3);
  });

  it('suma en centavos: tres de 33.33 son 99.99', () => {
    const totals = Staff.tipTotals([
      { amount: '33.33', currency: 'MXN', status: 'paid' },
      { amount: '33.33', currency: 'MXN', status: 'paid' },
      { amount: '33.33', currency: 'MXN', status: 'paid' },
    ], 'MXN');
    expect(totals.paid).toBe('99.99');
  });

  it('no mezcla pesos con dólares', () => {
    const tips = [
      { amount: '100.00', currency: 'MXN', status: 'paid' },
      { amount: '10.00', currency: 'USD', status: 'paid' },
    ];
    expect(Staff.tipTotals(tips, 'MXN').paid).toBe('100.00');
    expect(Staff.tipTotals(tips, 'USD').paid).toBe('10.00');
  });

  it('sin propinas son ceros', () => {
    expect(Staff.tipTotals([], 'MXN')).toMatchObject({ paid: '0.00', pending: '0.00', count: 0 });
    expect(Staff.tipTotals(null, 'MXN').paid).toBe('0.00');
  });
});

describe('Mesero: eventos', () => {
  const ev = (eventType, payload) => ({ type: 'event', event_type: eventType, payload });

  it('solo "listo" merece avisarle: los demás cambian la lista y ya', () => {
    expect(Staff.applyEvent(ev('order_ready', { order_id: 'o1' })))
      .toMatchObject({ changed: true, reloadOrders: true, announce: true });
    expect(Staff.applyEvent(ev('order_preparing', { order_id: 'o1' })).announce).toBe(false);
  });

  it('lee el tipo de `event_type`, que es donde viaja', () => {
    expect(Staff.applyEvent(ev('order_ready', {})).changed).toBe(true);
    expect(Staff.applyEvent({ type: 'order_ready', payload: {} }).changed).toBe(true);
  });

  it('un cambio de mesa recarga el plano, no los pedidos', () => {
    expect(Staff.applyEvent(ev('table_updated', {})))
      .toEqual({ changed: true, reloadTables: true });
  });

  it('lo que no es de pedidos ni de mesas no toca nada', () => {
    for (const k of ['flirt_received', 'taxi_assigned', undefined]) {
      expect(Staff.applyEvent(ev(k, {})).changed).toBe(false);
    }
  });
});

describe('Mesero y hostess: la ocupación', () => {
  it('normaliza pisos y zonas, y calcula lo libre', () => {
    // El servidor llama `tables` al conteo, no `total`: leer la clave equivocada
    // pintaría el club vacío toda la noche.
    const o = Staff.occupancy({
      total: { tables: 55, occupied: 20, guests: 84, tables_occupied_pct: 36 },
      floors: [{
        floor: 'baja', tables: 43, occupied: 18,
        sections: [{ section: 'GENERAL', tables: 28, occupied: 10 }],
      }],
    });
    expect(o).toMatchObject({ total: 55, occupied: 20, free: 35, guests: 84, pct: 36 });
    expect(o.floors[0]).toMatchObject({ floor: 'baja', total: 43, free: 25 });
    expect(o.floors[0].sections[0].free).toBe(18);
  });

  it('sin datos no revienta ni da NaN', () => {
    expect(Staff.occupancy(null)).toMatchObject({ total: 0, occupied: 0, free: 0, floors: [] });
  });
});

// ================================================================== VALET

const ticket = (over = {}) => Object.assign({
  id: 'v1', status: 'parked', plate: 'ABC-123', vehicle_desc: 'Nissan blanco',
  created_at: agoMin(60), requested_at: null, ready_at: null,
}, over);

describe('Valet: los carriles', () => {
  it('quien ya pidió su coche está en su propio carril', () => {
    expect(Valet.laneOf('requested')).toBe('requested');
    expect(Valet.laneOf('ready')).toBe('ready');
    expect(Valet.laneOf('parked')).toBe('parked');
  });

  it('lo entregado y lo cancelado sale del tablero', () => {
    expect(Valet.laneOf('delivered')).toBe(null);
    expect(Valet.laneOf('cancelled')).toBe(null);
    expect(Valet.isClosed('delivered')).toBe(true);
  });

  it('el carril de "ya lo pidieron" va primero en el orden de los carriles', () => {
    // Un cliente parado en la puerta es la única cola que se ve desde la calle.
    expect(Valet.LANES[0]).toBe('requested');
  });

  it('un estado desconocido no se cuela a un carril', () => {
    expect(Valet.laneOf('lavando')).toBe(null);
  });
});

describe('Valet: qué botón toca', () => {
  it('guardado y pedido llevan al mismo sitio: traer el coche', () => {
    expect(Valet.nextAction('parked')).toMatchObject({ action: 'ready' });
    expect(Valet.nextAction('requested')).toMatchObject({ action: 'ready' });
  });

  it('entregar exige el QR del cliente', () => {
    // Pedirlo no es teatro: es lo único que impide entregar un coche a quien no es.
    expect(Valet.nextAction('ready')).toMatchObject({ action: 'deliver', needsToken: true });
  });

  it('un boleto cerrado no ofrece nada', () => {
    expect(Valet.nextAction('delivered')).toBe(null);
    expect(Valet.nextAction('cancelled')).toBe(null);
  });

  it('cancelar se puede mientras el coche siga adentro', () => {
    expect(Valet.canCancel('parked')).toBe(true);
    expect(Valet.canCancel('ready')).toBe(true);
    expect(Valet.canCancel('delivered')).toBe(false);
  });
});

describe('Valet: la espera', () => {
  it('en "ya lo pidieron" se cuenta desde que lo pidió, no desde que llegó al club', () => {
    const t = ticket({ status: 'requested', created_at: agoMin(180), requested_at: agoMin(6) });
    expect(Valet.waitMinutes(t, NOW)).toBe(6);
  });

  it('guardado se cuenta desde que llegó: no hay prisa, pero se sabe', () => {
    expect(Valet.waitMinutes(ticket({ created_at: agoMin(90) }), NOW)).toBe(90);
  });

  it('el que más lleva esperando va arriba de su carril', () => {
    const lanes = Valet.groupByLane([
      ticket({ id: 'nuevo', status: 'requested', requested_at: agoMin(1) }),
      ticket({ id: 'viejo', status: 'requested', requested_at: agoMin(9) }),
    ], NOW);
    expect(lanes.requested.map((t) => t.id)).toEqual(['viejo', 'nuevo']);
  });

  it('los conteos cuadran con los carriles', () => {
    expect(Valet.counts([
      ticket({ id: 'a', status: 'requested' }),
      ticket({ id: 'b', status: 'ready' }),
      ticket({ id: 'c', status: 'parked' }),
      ticket({ id: 'd', status: 'delivered' }),
    ])).toEqual({ requested: 1, ready: 1, parked: 1, total: 3 });
  });
});

describe('Valet: buscar el coche', () => {
  const tickets = [ticket({ id: 'a', plate: 'ABC-123' }), ticket({ id: 'b', plate: 'XYZ-987' })];

  it('encuentra escribiendo con guiones o sin ellos', () => {
    // El valet teclea con una mano; el boleto dice ABC-123.
    expect(Valet.search(tickets, 'abc123').map((t) => t.id)).toEqual(['a']);
    expect(Valet.search(tickets, 'ABC-123').map((t) => t.id)).toEqual(['a']);
    expect(Valet.search(tickets, '123').map((t) => t.id)).toEqual(['a']);
  });

  it('una búsqueda vacía no esconde nada', () => {
    expect(Valet.search(tickets, '')).toHaveLength(2);
    expect(Valet.search(tickets, '   ')).toHaveLength(2);
  });

  it('la placa se comprueba antes de crear el boleto', () => {
    // Una placa mal escrita es un coche que no se encuentra a las 4 de la mañana.
    expect(Valet.validatePlate('ABC-123')).toBe(null);
    expect(Valet.validatePlate('AB')).toBe('valet.errPlate');
    expect(Valet.validatePlate('---')).toBe('valet.errPlate');
    expect(Valet.validatePlate('')).toBe('valet.errPlate');
  });

  it('el QR se comprueba con el largo que el servidor exige', () => {
    expect(Valet.validateToken('a'.repeat(32))).toBe(null);
    expect(Valet.validateToken('corto')).toBe('valet.errToken');
    expect(Valet.validateToken('a'.repeat(100))).toBe('valet.errToken');
  });

  it('el coche se lee con la placa primero', () => {
    expect(Valet.vehicleLabel(ticket())).toBe('ABC-123 · Nissan blanco');
    expect(Valet.vehicleLabel(ticket({ vehicle_desc: null }))).toBe('ABC-123');
  });
});

describe('Valet: eventos', () => {
  const ev = (eventType, payload) => ({ type: 'event', event_type: eventType, payload });

  it('que un cliente pida su coche es lo único que hace correr al valet', () => {
    expect(Valet.applyEvent(ev('valet_requested', { ticket_id: 'v1' })).announce).toBe(true);
    expect(Valet.applyEvent(ev('valet_parked', { ticket_id: 'v1' })).announce).toBe(false);
  });

  it('lee el tipo de `event_type`', () => {
    expect(Valet.applyEvent(ev('valet_ready', {})).changed).toBe(true);
    expect(Valet.applyEvent({ type: 'valet_ready', payload: {} }).changed).toBe(true);
  });

  it('lo que no es del valet no toca nada', () => {
    expect(Valet.applyEvent(ev('order_ready', {})).changed).toBe(false);
    expect(Valet.applyEvent(null).changed).toBe(false);
  });
});

// ================================================================== PORTAL

describe('Portal: el saldo', () => {
  const balances = [
    { currency: 'MXN', earned: '4500.00', withdrawn: '1000.00', reserved: '500.00', available: '3000.00', movements: 22 },
    { currency: 'USD', earned: '120.00', withdrawn: '0.00', reserved: '0.00', available: '120.00', movements: 3 },
  ];

  it('lo disponible es lo único que se puede pedir', () => {
    // `reserved` ya está comprometido en un retiro en proceso: mostrarlo como
    // disponible haría que el empleado pidiera dos veces el mismo dinero.
    const b = Earn.balanceFor(balances, 'MXN');
    expect(b.available).toBe('3000.00');
    expect(b.reserved).toBe('500.00');
    expect(Number(b.available) + Number(b.reserved) + Number(b.withdrawn)).toBe(Number(b.earned));
  });

  it('cada moneda por separado', () => {
    expect(Earn.balanceFor(balances, 'USD').available).toBe('120.00');
    expect(Earn.currenciesIn(balances)).toEqual(['MXN', 'USD']);
  });

  it('una moneda sin movimientos son ceros, no huecos', () => {
    expect(Earn.balanceFor(balances, 'EUR')).toMatchObject({ currency: 'EUR', available: '0.00' });
    expect(Earn.balanceFor(null, 'MXN').available).toBe('0.00');
  });

  it('sin saldo no hay nada que retirar', () => {
    expect(Earn.hasMoney({ available: '0.00' })).toBe(false);
    expect(Earn.hasMoney({ available: '0.01' })).toBe(true);
    expect(Earn.hasMoney(null)).toBe(false);
  });
});

describe('Portal: cuándo se puede pedir un retiro', () => {
  const money = { available: '3000.00' };
  const verified = { id: 'a1', verified_at: '2026-09-01T00:00:00Z' };
  const unverified = { id: 'a2', verified_at: null };

  it('con saldo y una cuenta verificada, sí', () => {
    expect(Earn.withdrawalBlocker(money, [verified], null)).toBe(null);
  });

  it('el motivo es concreto: sin cuenta y sin verificar mandan a lugares distintos', () => {
    expect(Earn.withdrawalBlocker(money, [], null)).toBe('earn.errNoAccount');
    expect(Earn.withdrawalBlocker(money, [unverified], null)).toBe('earn.errUnverified');
    expect(Earn.withdrawalBlocker({ available: '0.00' }, [verified], null)).toBe('earn.errNoMoney');
  });

  it('con un retiro ya en proceso no se puede pedir otro', () => {
    expect(Earn.withdrawalBlocker(money, [verified], { id: 'w1', status: 'pending' }))
      .toBe('earn.errOpen');
  });

  // La columna se llama `active`, no `deleted_at`: el servidor da de baja la cuenta
  // poniendo active = false para que un retiro ya pagado la siga encontrando.
  it('una cuenta dada de baja no cuenta como verificada', () => {
    const gone = { id: 'a3', verified_at: '2026-09-01T00:00:00Z', active: false };
    expect(Earn.isUsable(gone)).toBe(false);
    expect(Earn.withdrawalBlocker(money, [gone], null)).toBe('earn.errUnverified');
  });

  it('una cuenta que llega sin la columna active sigue sirviendo', () => {
    expect(Earn.isUsable({ id: 'a4', verified_at: '2026-09-01T00:00:00Z' })).toBe(true);
  });

  it('no se puede pedir más de lo disponible', () => {
    expect(Earn.validateAmount('3000.00', money)).toBe(null);
    expect(Earn.validateAmount('3000.01', money)).toBe('earn.errTooMuch');
    expect(Earn.validateAmount('0', money)).toBe('earn.errAmount');
    expect(Earn.validateAmount('-5', money)).toBe('earn.errAmount');
    expect(Earn.validateAmount('abc', money)).toBe('earn.errAmount');
  });

  it('el tope se compara en centavos, no en float', () => {
    // 0.1 + 0.2 no es 0.3: comparar importes en float deja pasar un centavo de más.
    expect(Earn.validateAmount('0.30', { available: '0.30' })).toBe(null);
    expect(Earn.validateAmount('0.31', { available: '0.30' })).toBe('earn.errTooMuch');
  });

  it('el retiro en proceso se encuentra entre todos los del historial', () => {
    const list = [
      { id: 'w0', status: 'paid' }, { id: 'w1', status: 'pending' }, { id: 'w2', status: 'rejected' },
    ];
    expect(Earn.openWithdrawal(list).id).toBe('w1');
    expect(Earn.openWithdrawal([{ status: 'paid' }])).toBe(null);
    expect(Earn.openWithdrawal(null)).toBe(null);
  });
});

describe('Portal: la cuenta bancaria', () => {
  const clabe = {
    type: 'clabe', bank_name: 'BBVA', holder_name: 'María Ruiz',
    // Con dígito verificador correcto: si no, estas pruebas medirían otra cosa.
    account_number: '012345678901234568',
  };

  it('una CLABE correcta pasa', () => {
    expect(Earn.validateAccount(clabe)).toEqual({});
  });

  it('el dígito verificador se comprueba igual que en el servidor', () => {
    // Comprobar solo el largo deja pasar una CLABE que el servidor rechaza, y el
    // empleado —que copió bien lo que veía— no entiende qué hizo mal.
    // eslint-disable-next-line global-require
    const banking = require('../src/services/banking.js');
    const base = '01234567890123456';
    const weights = [3, 7, 1];
    let sum = 0;
    for (let i = 0; i < 17; i += 1) sum += (Number(base[i]) * weights[i % 3]) % 10;
    const buena = base + String((10 - (sum % 10)) % 10);
    const mala = `${base}${(Number(buena[17]) + 1) % 10}`;

    expect(banking.isValidClabe(buena)).toBe(true);
    expect(Earn.isValidClabe(buena)).toBe(true);
    expect(Earn.isValidClabe(mala)).toBe(false);
    expect(banking.isValidClabe(mala)).toBe(false);

    expect(Earn.validateAccount({ ...clabe, account_number: buena })).toEqual({});
    expect(Earn.validateAccount({ ...clabe, account_number: mala }))
      .toHaveProperty('account_number', 'earn.errClabeCheck');
  });

  it('el routing de EE. UU. también comprueba su suma', () => {
    // eslint-disable-next-line global-require
    const banking = require('../src/services/banking.js');
    expect(Earn.isValidRouting('021000021')).toBe(banking.isValidAbaRouting('021000021'));
    expect(Earn.isValidRouting('021000022')).toBe(false);
    const us = {
      type: 'us_checking', bank_name: 'Chase', holder_name: 'Ana',
      account_number: '123456789', routing_number: '021000022',
    };
    expect(Earn.validateAccount(us)).toHaveProperty('routing_number', 'earn.errRoutingCheck');
  });

  it('la CLABE son 18 dígitos exactos, ni uno más ni uno menos', () => {
    // Mal escrita no falla al registrarla: falla el día del pago.
    expect(Earn.validateAccount({ ...clabe, account_number: '01234567890123456' }))
      .toHaveProperty('account_number', 'earn.errClabe');
    expect(Earn.validateAccount({ ...clabe, account_number: '01234567890123456888' }))
      .toHaveProperty('account_number', 'earn.errClabe');
  });

  it('acepta la CLABE con espacios y guiones, como viene en el estado de cuenta', () => {
    expect(Earn.validateAccount({ ...clabe, account_number: '0123 4567 8901 2345 68' })).toEqual({});
    expect(Earn.accountPayload({ ...clabe, account_number: '0123 4567 8901 2345 68' }).account_number)
      .toBe('012345678901234568');
  });

  it('una cuenta de Estados Unidos exige routing de 9 dígitos', () => {
    const us = { type: 'us_checking', bank_name: 'Chase', holder_name: 'Maria Ruiz', account_number: '123456789', routing_number: '021000021' };
    expect(Earn.validateAccount(us)).toEqual({});
    expect(Earn.validateAccount({ ...us, routing_number: '12345' }))
      .toHaveProperty('routing_number', 'earn.errRouting');
  });

  it('la CLABE no lleva routing', () => {
    expect(Earn.accountPayload(clabe).routing_number).toBeUndefined();
  });

  it('los campos que faltan se señalan uno por uno', () => {
    const errors = Earn.validateAccount({ type: 'clabe', account_number: '1' });
    expect(errors).toHaveProperty('bank_name');
    expect(errors).toHaveProperty('holder_name');
    expect(errors).toHaveProperty('account_number');
  });

  it('un tipo de cuenta que el servidor no acepta se detiene aquí', () => {
    expect(Earn.validateAccount({ ...clabe, type: 'paypal' })).toHaveProperty('type');
  });
});

describe('Portal: de dónde viene el dinero', () => {
  it('suma por tipo y pone arriba lo que más da', () => {
    const rows = [
      { type: 'tip', currency: 'MXN', total: '1200.00' },
      { type: 'song_request', currency: 'MXN', total: '300.00' },
      { type: 'tip', currency: 'MXN', total: '800.00' },
      { type: 'tip', currency: 'USD', total: '50.00' },
    ];
    const list = Earn.byType(rows, 'MXN');
    expect(list[0]).toMatchObject({ type: 'tip', amount: '2000.00' });
    expect(list[1]).toMatchObject({ type: 'song_request', amount: '300.00' });
    expect(list).toHaveLength(2);
  });

  it('cada tipo tiene un nombre, y uno desconocido no imprime la clave', () => {
    expect(Earn.movementLabel('tip')).toBe('earn.mTip');
    expect(Earn.movementLabel('lo_que_sea')).toBe('earn.mOther');
  });

  it('los estados del retiro tienen nombre, incluido uno inesperado', () => {
    expect(Earn.withdrawalLabel('paid')).toBe('earn.wPaid');
    expect(Earn.withdrawalLabel('rejected')).toBe('earn.wRejected');
    expect(Earn.withdrawalLabel('marciano')).toBe('earn.wPending');
  });

  it('sin movimientos la lista está vacía, no rota', () => {
    expect(Earn.byType([], 'MXN')).toEqual([]);
    expect(Earn.byType(null, 'MXN')).toEqual([]);
  });
});
