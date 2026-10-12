/**
 * Saldo y tope del mesero (D110) y caja cerrada (D111).
 */
'use strict';

const { randomUUID } = require('crypto');
const { setupSchema, truncateAll, closePool, pool } = require('./helpers/db');
const { api, auth } = require('./helpers/api');
const f = require('./helpers/factories');

let club; let manager; let waiter; let table; let beer;

beforeAll(setupSchema);
afterAll(closePool);

const url = (p) => `/api/nightclubs/${club.id}${p}`;
const pedir = (user = waiter) => api().post(url('/orders')).set(auth(user)).send({
  client_request_id: randomUUID(), table_id: table.id, items: [{ drink_id: beer.id, quantity: 1 }] });

beforeEach(async () => {
  await truncateAll();
  club = await f.createNightclub({ slug: 'ev2-saldo' });
  manager = await f.createUser(club.id, { role: 'manager' });
  waiter = await f.createUser(club.id, { role: 'waiter', on_shift: true });
  table = await f.createTable(club.id, { section: 'ROJA' });
  beer = await f.createDrink(club.id, { name: 'Cerveza', price: 60, stock: 40 });
});

test('sin entrada checada el mesero no levanta pedidos', async () => {
  const sin = await f.createUser(club.id, { role: 'waiter' });
  expect((await pedir(sin)).status).toBe(409);
});

test('sin tope configurado no se bloquea, y el saldo se ve', async () => {
  expect((await pedir()).status).toBe(201);
  const res = await api().get(url('/waiters/me/balance')).set(auth(waiter));
  expect(res.status).toBe(200);
});

test('solo el gerente fija el tope, y el tope por minutos bloquea', async () => {
  expect((await api().put(url('/waiter-limits')).set(auth(waiter)).send({ max_unpaid_amount: null, max_unpaid_minutes: 5 })).status).toBe(403);
  const put = await api().put(url('/waiter-limits')).set(auth(manager)).send({ max_unpaid_amount: null, max_unpaid_minutes: 5 });
  expect(put.status).toBe(200);
  const o = (await pedir()).body.order;
  await pool.query(`UPDATE drink_orders SET status = 'delivered', delivered_at = now() - interval '10 minutes' WHERE id = $1`, [o.id]);
  expect((await pedir()).status).toBe(409);
});
