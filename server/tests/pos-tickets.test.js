/**
 * Los tickets como los de un punto de venta (D121): el recibo con sus artículos, el
 * encabezado y el pie que captura el gerente, y el corte general de la noche.
 */
'use strict';

const { randomUUID } = require('crypto');
const { setupSchema, truncateAll, closePool, pool } = require('./helpers/db');
const { api, auth } = require('./helpers/api');
const f = require('./helpers/factories');
const escpos = require('../src/services/escpos');
const tickets = require('../src/services/tickets');

let club; let waiter; let manager; let admin; let cashier; let table; let beer; let shot;
let impresoraCaja;

beforeAll(setupSchema);
afterAll(closePool);

const url = (p) => `/api/nightclubs/${club.id}${p}`;

beforeEach(async () => {
  await truncateAll();
  club = await f.createNightclub({ slug: 'ev2-pos-tickets' });
  waiter = await f.createUser(club.id, { role: 'waiter', on_shift: true, display_name: 'Luis' });
  manager = await f.createUser(club.id, { role: 'manager', display_name: 'Gerente Ana' });
  admin = await f.createUser(club.id, { role: 'admin' });
  cashier = await f.createUser(club.id, { role: 'cashier', display_name: 'Caja PB' });
  await f.openTill(club.id, { cashier, locationId: club.bar_id, authorizer: manager, openingFloat: 500 });
  table = await f.createTable(club.id, { code: 'T-7', section: 'TERRAZA', capacity: 4 });
  beer = await f.createDrink(club.id, { name: 'Cerveza Coronita', price: 60, stock: 40 });
  shot = await f.createDrink(club.id, { name: 'Tequila añejo', price: 180, stock: 20 });
  await pool.query(
    `INSERT INTO zone_bars (nightclub_id, section, location_id) VALUES ($1,'TERRAZA',$2)`,
    [club.id, club.bar_id]);
  const res = await api().post(url('/printers')).set(auth(manager)).send({
    location_id: club.bar_id, name: 'Caja PB', purpose: 'till', connection: 'network', host: '192.168.1.52',
  });
  impresoraCaja = res.body.printer;
});

const pedir = (items) => api().post(url('/orders')).set(auth(waiter)).send({
  client_request_id: randomUUID(), table_id: table.id, items,
});

const cobrarEfectivo = async (orderId, cashReceived) => {
  const { rows } = await pool.query(
    `SELECT id, amount::text AS amount, currency FROM transactions
      WHERE reference_type = 'drink_order' AND reference_id = $1`, [orderId]);
  return api().post(url('/till/payments')).set(auth(cashier)).send({
    transaction_id: rows[0].id, method: 'cash', amount: Number(rows[0].amount),
    cash_received: cashReceived,
  });
};

const jobs = async (kind) => (await pool.query(
  `SELECT kind, preview, printer_id::text AS printer_id FROM print_jobs
    WHERE nightclub_id = $1 AND kind = $2::text ORDER BY created_at`, [club.id, kind])).rows;

describe('El recibo de pago lleva los artículos (D121)', () => {
  it('cantidad, descripción e importe de cada trago, el total y la forma de pago', async () => {
    const pedido = await pedir([{ drink_id: beer.id, quantity: 2 }, { drink_id: shot.id, quantity: 1 }]);
    expect(pedido.status).toBe(201);
    const cobro = await cobrarEfectivo(pedido.body.order.id, 500);
    expect(cobro.status).toBe(201);

    const [recibo] = await jobs('receipt');
    expect(recibo.printer_id).toBe(impresoraCaja.id);
    const p = recibo.preview;
    expect(p).toContain('RECIBO DE PAGO');
    expect(p).toMatch(/^CANT DESCRIPCION\s+IMPORTE$/m);
    expect(p).toMatch(/^2 {3}Cerveza Coronita\s+\$120\.00$/m);
    expect(p).toMatch(/^ {4}2 x \$60\.00$/m);
    expect(p).toMatch(/^1 {3}Tequila añejo\s+\$180\.00$/m);
    expect(p).toMatch(/^Subtotal\s+\$300\.00$/m);
    expect(p).toMatch(/^TOTAL\s+\$300\.00$/m);
    expect(p).toContain('FORMA DE PAGO');
    expect(p).toMatch(/^Efectivo\s+\$300\.00$/m);
    expect(p).toMatch(/Recibido\s+\$500\.00/);
    expect(p).toMatch(/Cambio\s+\$200\.00/);
    // Quién cobró, en qué caja, la mesa y su mesero.
    expect(p).toMatch(/^Caja\s+\S/m);
    expect(p).toMatch(/^Atendió\s+Caja PB$/m);
    expect(p).toMatch(/^Mesa T-7\s+Mesero: Luis$/m);
    expect(p).toContain('PAGADO');
    // Nada se sale del ancho del papel.
    for (const linea of p.split('\n')) expect(linea.length).toBeLessThanOrEqual(48);
  });

  it('la propina de la terminal va aparte y suma al total', () => {
    const t = escpos.ticket({ columns: 48 });
    tickets.renderReceipt(t, {
      transaction_id: randomUUID(), amount: '300.00', currency: 'MXN', tip_amount: '30.00',
      items: [{ name: 'Cerveza', quantity: 5, unit_price: '60.00', amount: '300.00', mixers: [] }],
      parts: [{ method: 'card_terminal', amount: '300.00', reference: 'VCH-1' }],
    }, { club: { name: 'EV2', timezone: 'America/Hermosillo' }, settings: {} });
    const { text } = t.build();
    expect(text).toMatch(/^Subtotal\s+\$300\.00$/m);
    expect(text).toMatch(/^Propina\s+\$30\.00$/m);
    expect(text).toMatch(/^TOTAL\s+\$330\.00$/m);
  });
});

describe('Encabezado y pie del ticket (D121)', () => {
  it('cada renglón que captura el gerente sale en su línea, el nombre arriba', async () => {
    const res = await api().patch(url('/print-settings')).set(auth(manager)).send({
      header_text: 'EV2 CLANDESTINOZ\nAv. Principal 123\nTel. 000 000 0000',
      footer_text: '¡Gracias por su visita!',
    });
    expect(res.status).toBe(200);
    const pedido = await pedir([{ drink_id: beer.id, quantity: 1 }]);
    await cobrarEfectivo(pedido.body.order.id, 60);
    const [recibo] = await jobs('receipt');
    const lineas = recibo.preview.split('\n').map((l) => l.trim());
    expect(lineas[0]).toBe('EV2 CLANDESTINOZ');
    expect(lineas[1]).toBe('Av. Principal 123');
    expect(lineas[2]).toBe('Tel. 000 000 0000');
    expect(lineas).toContain('¡Gracias por su visita!');
  });

  it('sin encabezado capturado, el nombre del club; nada inventado', () => {
    const t = escpos.ticket({ columns: 48 });
    tickets.header(t, { name: 'Club Prueba' }, {});
    const { text } = t.build();
    expect(text.split('\n').filter((l) => l.trim() && !/^=+$/.test(l))).toEqual([
      expect.stringContaining('Club Prueba'),
    ]);
  });
});

describe('El corte general de la noche (D121)', () => {
  it('el gerente lo imprime con todas las cajas y los totales; con caja abierta sale PRELIMINAR', async () => {
    const pedido = await pedir([{ drink_id: beer.id, quantity: 2 }]);
    await cobrarEfectivo(pedido.body.order.id, 200);

    const res = await api().post(url('/tills/report/print')).set(auth(manager))
      .send({ printer_id: impresoraCaja.id });
    expect(res.status).toBe(202);
    expect(res.body.totals).toMatchObject({ tills: 1, open_tills: 1, total_collected: '120.00' });

    const [corte] = await jobs('night_cut');
    expect(corte.printer_id).toBe(impresoraCaja.id);
    const p = corte.preview;
    expect(p).toContain('CORTE GENERAL');
    expect(p).toMatch(/PRELIMINAR: 1 caja\(s\) abierta\(s\)/);
    expect(p).toMatch(/\(ABIERTA\)/);
    expect(p).toMatch(/Fondo\s+\$500\.00/);
    expect(p).toMatch(/Cobrado\s+\$120\.00/);
    expect(p).toMatch(/Debe tener\s+\$620\.00/);
    expect(p).toMatch(/^Efectivo \(1\)\s+\$120\.00$/m);
    expect(p).toMatch(/^TOTAL\s+\$120\.00$/m);
    expect(p).toMatch(/Pidió\s+Gerente Ana/);
    for (const linea of p.split('\n')) expect(linea.length).toBeLessThanOrEqual(48);
  });

  it('la pantalla de cajas no cambia: no trae lo que es solo del papel', async () => {
    const res = await api().get(url('/tills')).set(auth(manager));
    expect(res.status).toBe(200);
    expect(res.body.tills).toHaveLength(1);
    expect(res.body.tills[0]).not.toHaveProperty('by_method');
    expect(res.body.tills[0]).toMatchObject({ opening_float: '500.00', closed: false });
  });

  it('el admin también puede; un cajero o un mesero no', async () => {
    expect((await api().post(url('/tills/report/print')).set(auth(admin))
      .send({ printer_id: impresoraCaja.id })).status).toBe(202);
    for (const quien of [cashier, waiter]) {
      expect((await api().post(url('/tills/report/print')).set(auth(quien))
        .send({ printer_id: impresoraCaja.id })).status).toBe(403);
    }
  });

  it('con una impresora que no existe o está apagada, lo dice y no encola nada', async () => {
    expect((await api().post(url('/tills/report/print')).set(auth(manager))
      .send({ printer_id: randomUUID() })).status).toBe(404);
    await pool.query('UPDATE printers SET active = false WHERE id = $1', [impresoraCaja.id]);
    expect((await api().post(url('/tills/report/print')).set(auth(manager))
      .send({ printer_id: impresoraCaja.id })).status).toBe(404);
    expect(await jobs('night_cut')).toHaveLength(0);
  });
});
