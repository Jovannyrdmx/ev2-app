/**
 * El monitor de mesas del gerente (D113).
 */
'use strict';

const { randomUUID } = require('crypto');
const { setupSchema, truncateAll, closePool, pool } = require('./helpers/db');
const { api, auth } = require('./helpers/api');
const f = require('./helpers/factories');

let club; let manager; let waiter; let guest; let vip; let normal; let beer;

beforeAll(setupSchema);
afterAll(closePool);

const url = (p) => `/api/nightclubs/${club.id}${p}`;

beforeEach(async () => {
  await truncateAll();
  club = await f.createNightclub({ slug: 'ev2-monitor' });
  manager = await f.createUser(club.id, { role: 'manager' });
  waiter = await f.createUser(club.id, { role: 'waiter', on_shift: true });
  guest = await f.createUser(club.id, { role: 'guest' });
  vip = await f.createTable(club.id, { code: 'V1', section: 'ROJA', type: 'vip' });
  normal = await f.createTable(club.id, { code: 'N1', section: 'ROJA' });
  beer = await f.createDrink(club.id, { name: 'Cerveza', price: 60, stock: 40 });
});

const sentar = (mesa, user) => api().post(url(`/tables/${mesa.id}/seat`)).set(auth(manager)).send({ user_id: user.id });
const levantar = (mesa, user) => api().post(url(`/tables/${mesa.id}/release`)).set(auth(manager)).send({ user_id: user.id });
const eventos = async (tipo) => (await pool.query('SELECT payload FROM events WHERE type = $1 ORDER BY id', [tipo])).rows;

test('solo gerencia lo ve', async () => {
  expect((await api().get(url('/tables/monitor')).set(auth(waiter))).status).toBe(403);
  expect((await api().get(url('/tables/monitor')).set(auth(manager))).status).toBe(200);
});

test('las VIP salen primero, con quién hay y lo consumido desde que se sentaron', async () => {
  await sentar(vip, guest);
  await api().post(url('/orders')).set(auth(waiter)).send({
    client_request_id: randomUUID(), table_id: vip.id, items: [{ drink_id: beer.id, quantity: 3 }] });
  const res = await api().get(url('/tables/monitor')).set(auth(manager));
  expect(res.body.tables.map((t) => t.code)).toEqual(['V1', 'N1']);
  expect(res.body.tables[0]).toMatchObject({ is_vip: true, status: 'occupied', guests: 1, orders: 1, total: '180.00' });
  expect(res.body.tables[1]).toMatchObject({ is_vip: false, status: 'available', total: '0.00' });
});

test('al ocuparse y desocuparse una VIP el gerente recibe aviso; una normal no avisa', async () => {
  await sentar(vip, guest);
  await levantar(vip, guest);
  expect(await eventos('vip_table_occupied')).toHaveLength(1);
  expect(await eventos('vip_table_released')).toHaveLength(1);
  const otro = await f.createUser(club.id, { role: 'guest' });
  await sentar(normal, otro);
  expect(await eventos('vip_table_occupied')).toHaveLength(1);
});

test('el historial junta cada ocupación con lo que consumió', async () => {
  await sentar(vip, guest);
  await api().post(url('/orders')).set(auth(waiter)).send({
    client_request_id: randomUUID(), table_id: vip.id, items: [{ drink_id: beer.id, quantity: 2 }] });
  await levantar(vip, guest);
  await sentar(vip, guest);
  const res = await api().get(url(`/tables/${vip.id}/history`)).set(auth(manager));
  expect(res.status).toBe(200);
  expect(res.body.sessions).toHaveLength(2);
  const [actual, anterior] = res.body.sessions;
  expect(actual.ended_at).toBeNull();
  expect(anterior.total).toBe('120.00');
  expect(anterior.lines).toEqual([{ name: 'Cerveza', quantity: 2, amount: '120.00' }]);
});
