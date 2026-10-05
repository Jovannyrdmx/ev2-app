/**
 * La caja cobra en dólares y da el cambio en pesos (D86).
 *
 * Lo que tiene que ser cierto, no solo verse en pantalla:
 *   * el tipo de cambio es el que fijó el gerente, y si cambió, el cobro se para;
 *   * el cambio sale en pesos, redondeado HACIA ABAJO al peso;
 *   * los dólares pueden ser una de las dos formas de pago;
 *   * el corte cuenta los dólares aparte, y el cambio en pesos sale del cajón de pesos.
 */
'use strict';

const { randomUUID } = require('crypto');
const { setupSchema, truncateAll, closePool, pool } = require('./helpers/db');
const pins = require('../src/services/pins');
const { api, auth } = require('./helpers/api');
const f = require('./helpers/factories');

let club; let manager; let cajero; let waiter; let table; let beer; let pinGerente;

beforeAll(setupSchema);
afterAll(closePool);

beforeEach(async () => {
  await truncateAll();
  club = await f.createNightclub({ slug: 'ev2-dolares' });
  manager = await f.createUser(club.id, { role: 'manager', display_name: 'Gerente' });
  cajero = await f.createUser(club.id, { role: 'cashier', display_name: 'Caja Ana' });
  waiter = await f.createUser(club.id, { role: 'waiter', display_name: 'Luis' });
  table = await f.createTable(club.id, { code: 'T-3', section: 'ZONA ROJA', capacity: 4 });
  beer = await f.createDrink(club.id, { name: 'Cerveza', price: 60, stock: 40 });
  const { rows } = await pool.query(
    `INSERT INTO events_calendar (nightclub_id, name, event_date, doors_open_at, ticket_price, status)
     VALUES ($1,'Viernes',(now() - interval '1 hour')::date, now() - interval '1 hour', 0, 'published')
     RETURNING id`, [club.id]);
  pinGerente = await pins.issuePin(pool, { userId: manager.id });
  await pool.query('UPDATE users SET must_change_pin = false WHERE id = $1', [manager.id]);
  await api().post(url(`/nights/${rows[0].id}/roster`)).set(auth(manager))
    .send({ user_id: cajero.id, location_id: club.bar_id });
  const abierta = await api().post(url('/till/open')).set(auth(cajero))
    .send({ opening_float: 1000, manager_pin: pinGerente });
  if (abierta.status !== 201) throw new Error(`abrir caja: ${abierta.status}`);
});

const url = (p) => `/api/nightclubs/${club.id}${p}`;

const fijarTipo = async (rate) => {
  const res = await api().put(url('/exchange-rate')).set(auth(manager)).send({ rate });
  expect(res.status).toBe(201);
  return String(res.body.rate.id);
};

/** Dos cervezas: $120. */
const pedido = async () => {
  const res = await api().post(url('/orders')).set(auth(waiter)).send({
    client_request_id: randomUUID(), table_id: table.id,
    items: [{ drink_id: beer.id, quantity: 2 }],
  });
  if (res.status !== 201) throw new Error(`pedido: ${res.status}`);
  return res.body.order;
};

const pagar = (order, body) => api().post(url('/till/payments')).set(auth(cajero))
  .send({ transaction_id: order.transaction_id, ...body });

const cortar = (body) => api().post(url('/shifts/me/closing')).set(auth(cajero))
  .send({ manager_pin: pinGerente, declared_cash: 0, ...body });

describe('Cobrar en dólares', () => {
  it('sin tipo de cambio no se cobra en dólares', async () => {
    const res = await pagar(await pedido(), { method: 'cash_usd', usd_received: 10, exchange_rate_id: 1 });
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/tipo de cambio/);
  });

  it('el cambio sale en pesos, redondeado hacia abajo, y el recibo lo dice', async () => {
    await api().post(url('/printers')).set(auth(manager)).send({
      location_id: club.bar_id, name: 'Caja PB', purpose: 'till', host: '192.168.1.70',
    });
    const tipo = await fijarTipo(17.35);
    // US$10 a 17.35 = $173.50; el pedido es $120; sobran $53.50 → se dan $53.
    const res = await pagar(await pedido(), { method: 'cash_usd', usd_received: 10, exchange_rate_id: tipo });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      paid: true, remaining: '0.00', change_given: '53.00', usd_received: '10.00', exchange_rate: '17.350000',
    });
    expect(res.body.payment).toMatchObject({ method: 'cash_usd', amount: '120.00', currency: 'MXN' });

    const { rows } = await pool.query(`SELECT preview FROM print_jobs WHERE kind = 'receipt'`);
    expect(rows[0].preview).toMatch(/Efectivo en dólares/);
    expect(rows[0].preview).toMatch(/Recibido\s+USD 10\.00/);
    expect(rows[0].preview).toMatch(/Tipo de cambio\s+17\.35/);
    expect(rows[0].preview).toMatch(/Cambio\s+\$53\.00/);
  });

  it('si el gerente cambió el tipo de cambio, se para y enseña el nuevo', async () => {
    const viejo = await fijarTipo(17.35);
    const nuevo = await fijarTipo(18);
    const res = await pagar(await pedido(), { method: 'cash_usd', usd_received: 10, exchange_rate_id: viejo });
    expect(res.status).toBe(409);
    expect(res.body.error.details.exchange_rate).toMatchObject({ id: nuevo });
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM manual_payments');
    expect(rows[0].n).toBe(0);
  });

  it('dólares que no alcanzan: quedan como primera parte y el resto se paga en pesos', async () => {
    const tipo = await fijarTipo(17.35);
    const p = await pedido();
    // US$5 = $86.75; faltan $33.25.
    const r1 = await pagar(p, { method: 'cash_usd', usd_received: 5, exchange_rate_id: tipo });
    expect(r1.status).toBe(201);
    expect(r1.body).toMatchObject({ paid: false, remaining: '33.25', change_given: '0.00' });
    const r2 = await pagar(p, { method: 'cash', amount: 33.25, cash_received: 50 });
    expect(r2.status).toBe(201);
    expect(r2.body).toMatchObject({ paid: true, change_given: '16.75' });
  });

  it('como segunda forma de pago los dólares tienen que completar', async () => {
    const tipo = await fijarTipo(17.35);
    const p = await pedido();
    await pagar(p, { method: 'cash', amount: 20 });
    const corto = await pagar(p, { method: 'cash_usd', usd_received: 5, exchange_rate_id: tipo });
    expect(corto.status).toBe(422);
    const completo = await pagar(p, { method: 'cash_usd', usd_received: 10, exchange_rate_id: tipo });
    expect(completo.status).toBe(201);
    // $173.50 − $100 que faltaban = $73.50 → $73.
    expect(completo.body).toMatchObject({ paid: true, change_given: '73.00' });
  });

  it('sin dólares capturados, o con dólares en otra forma de pago, no se acepta', async () => {
    const tipo = await fijarTipo(17.35);
    const p = await pedido();
    expect((await pagar(p, { method: 'cash_usd', exchange_rate_id: tipo })).status).toBe(422);
    expect((await pagar(p, { method: 'cash', amount: 120, usd_received: 10 })).status).toBe(422);
    expect((await pagar(p, { method: 'cash' })).status).toBe(400);
  });

  it('la base no acepta un cambio que no cuadre con los dólares y el tipo de cambio', async () => {
    const tipo = await fijarTipo(17.35);
    const res = await pagar(await pedido(), { method: 'cash_usd', usd_received: 10, exchange_rate_id: tipo });
    await expect(pool.query(
      `INSERT INTO manual_payments (nightclub_id, transaction_id, method, declared_by, amount, currency,
                                    status, usd_received, exchange_rate, exchange_rate_id, change_given)
       SELECT nightclub_id, transaction_id, 'cash_usd', declared_by, 120, 'MXN', 'rejected',
              10, 17.35, exchange_rate_id, 60
         FROM manual_payments WHERE id = $1`, [res.body.payment.id]))
      .rejects.toThrow(/cash_received_chk/);
  });
});

describe('El corte con dólares', () => {
  it('cuenta los dólares aparte y resta del cajón de pesos el cambio que se dio', async () => {
    await api().post(url('/printers')).set(auth(manager)).send({
      location_id: club.bar_id, name: 'Caja PB', purpose: 'till', host: '192.168.1.70',
    });
    const tipo = await fijarTipo(17.35);
    await pagar(await pedido(), { method: 'cash_usd', usd_received: 10, exchange_rate_id: tipo }); // cambio 53

    const sinDolares = await cortar({ counted_cash: 947 });
    expect(sinDolares.status).toBe(422);
    expect(sinDolares.body.error.message).toMatch(/US\$10\.00/);

    const res = await cortar({ counted_cash: 947, counted_usd: 10 });
    expect(res.status).toBe(201);
    expect(res.body.closing).toMatchObject({
      expected_cash: '947.00', difference: '0.00',
      usd_collected: '10.00', usd_change_given: '53.00',
      expected_usd: '10.00', counted_usd: '10.00', difference_usd: '0.00',
    });
    const { rows } = await pool.query(`SELECT preview FROM print_jobs WHERE kind = 'shift_cut'`);
    expect(rows[0].preview).toMatch(/Cambio por dólares\s+-\$53\.00/);
    expect(rows[0].preview).toMatch(/DÓLARES/);
    expect(rows[0].preview).toMatch(/Debía entregar\s+USD 10\.00/);
  });

  it('una diferencia en dólares pide motivo', async () => {
    const tipo = await fijarTipo(17.35);
    await pagar(await pedido(), { method: 'cash_usd', usd_received: 10, exchange_rate_id: tipo });
    const sinMotivo = await cortar({ counted_cash: 947, counted_usd: 5 });
    expect(sinMotivo.status).toBe(422);
    expect(sinMotivo.body.error.message).toMatch(/Faltan dólares \(US\$5\.00\)/);
    const conMotivo = await cortar({ counted_cash: 947, counted_usd: 5, difference_reason: 'Billete falso devuelto' });
    expect(conMotivo.status).toBe(201);
    expect(conMotivo.body.closing.difference_usd).toBe('-5.00');
  });

  it('un turno sin dólares corta como siempre, sin pedir dólares', async () => {
    const res = await cortar({ counted_cash: 1000 });
    expect(res.status).toBe(201);
    expect(res.body.closing).toMatchObject({ expected_usd: null, counted_usd: null });
  });

  it('el retiro en dólares sale de los dólares, no de los pesos', async () => {
    const tipo = await fijarTipo(17.35);
    await pagar(await pedido(), { method: 'cash_usd', usd_received: 10, exchange_rate_id: tipo });
    const retirar = (body) => api().post(url('/shifts/me/cash-drops')).set(auth(cajero))
      .send({ reason: 'Al banco', manager_pin: pinGerente, ...body });

    const demasiado = await retirar({ amount: 20, currency: 'USD' });
    expect(demasiado.status).toBe(422);
    expect(demasiado.body.error.message).toMatch(/US\$10\.00 en dólares/);

    const ok = await retirar({ amount: 6, currency: 'USD' });
    expect(ok.status).toBe(201);
    expect(ok.body.withdrawal).toMatchObject({ currency: 'USD', remaining: '4.00' });

    const res = await cortar({ counted_cash: 947, counted_usd: 4 });
    expect(res.status).toBe(201);
    expect(res.body.closing).toMatchObject({
      expected_cash: '947.00', usd_drops_total: '6.00', expected_usd: '4.00',
    });
  });
});

describe('Las cajas de la noche, para el gerente (D88)', () => {
  it('cada caja abierta con su barra, cajero, fondo, lo cobrado y lo que debe tener', async () => {
    const tipo = await fijarTipo(17.35);
    await pagar(await pedido(), { method: 'cash_usd', usd_received: 10, exchange_rate_id: tipo });
    const res = await api().get(url('/tills')).set(auth(manager));
    expect(res.status).toBe(200);
    expect(res.body.tills).toHaveLength(1);
    expect(res.body.tills[0]).toMatchObject({
      location_id: club.bar_id, user_name: 'Caja Ana', opening_float: '1000.00',
      cash_to_hand: '947.00', usd_received: '10.00', usd_to_hand: '10.00',
      closed: false, pending_orders: 0,
    });
  });

  it('al cortar queda marcada como cerrada, con su diferencia', async () => {
    await cortar({ counted_cash: 990, difference_reason: 'Faltó un billete de 10' });
    const res = await api().get(url('/tills')).set(auth(manager));
    expect(res.body.tills[0]).toMatchObject({ closed: true, difference: '-10.00' });
  });

  it('solo el gerente la ve', async () => {
    expect((await api().get(url('/tills')).set(auth(cajero))).status).toBe(403);
    expect((await api().get(url('/tills')).set(auth(waiter))).status).toBe(403);
  });
});
