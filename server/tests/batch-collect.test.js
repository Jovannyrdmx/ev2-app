/**
 * Cobro por lote de lo que un mesero entregó (D112).
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

const url = (p) => `/api/nightclubs/${club.id}${p}`;

beforeEach(async () => {
  await truncateAll();
  club = await f.createNightclub({ slug: 'ev2-lote' });
  manager = await f.createUser(club.id, { role: 'manager' });
  cajero = await f.createUser(club.id, { role: 'cashier' });
  waiter = await f.createUser(club.id, { role: 'waiter', on_shift: true });
  table = await f.createTable(club.id, { section: 'ROJA' });
  beer = await f.createDrink(club.id, { name: 'Cerveza', price: 60, stock: 40 });
  pinGerente = await pins.issuePin(pool, { userId: manager.id });
  await pool.query('UPDATE users SET must_change_pin = false WHERE id = $1', [manager.id]);
  const { rows } = await pool.query(
    `INSERT INTO events_calendar (nightclub_id, name, event_date, doors_open_at, ticket_price, status)
     VALUES ($1,'Viernes',(now() - interval '1 hour')::date, now() - interval '1 hour', 0, 'published')
     RETURNING id`, [club.id]);
  await api().post(url(`/nights/${rows[0].id}/roster`)).set(auth(manager))
    .send({ user_id: cajero.id, location_id: club.bar_id });
  await api().post(url('/till/open')).set(auth(cajero)).send({ opening_float: 500, manager_pin: pinGerente });
});

async function entregado(qty) {
  const res = await api().post(url('/orders')).set(auth(waiter)).send({
    client_request_id: randomUUID(), table_id: table.id, items: [{ drink_id: beer.id, quantity: qty }] });
  await pool.query(`UPDATE drink_orders SET status = 'delivered', delivered_at = now() WHERE id = $1`, [res.body.order.id]);
  return res.body.order;
}
const lote = (body) => api().post(url('/till/payments/batch')).set(auth(cajero)).send({ waiter_id: waiter.id, ...body });
const pagados = async () => (await pool.query(
  `SELECT count(*)::int AS n FROM transactions WHERE status = 'paid'`)).rows[0].n;

test('cobra todo lo entregado del mesero de una vez y da un solo cambio', async () => {
  await entregado(1); await entregado(2);
  const res = await lote({ cash_received: 200 });
  expect(res.status).toBe(201);
  expect(res.body).toMatchObject({ orders: 2, total: '180.00', change_given: '20.00' });
  expect(await pagados()).toBe(2);
  const log = await pool.query(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'payment.batch_collect'`);
  expect(log.rows[0].n).toBe(1);
});

test('si lo recibido no alcanza, no se cobra ninguno', async () => {
  await entregado(1); await entregado(2);
  expect((await lote({ cash_received: 150 })).status).toBe(422);
  expect(await pagados()).toBe(0);
});

test('un mesero sin pedidos entregados no tiene qué cobrar', async () => {
  expect((await lote({ cash_received: 100 })).status).toBe(422);
});
