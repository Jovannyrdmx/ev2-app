/**
 * El voucher de tarjeta tecleado a mano lo autoriza un gerente (D107).
 *
 * Marcar un cobro en efectivo como "tarjeta" con un folio inventado sacaba ese dinero
 * de lo que se espera en el cajón. Con la terminal en cada caja, el voucher manual es
 * el respaldo para cuando falla, y ahora lleva motivo y el PIN de un gerente.
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
  club = await f.createNightclub({ slug: 'ev2-voucher' });
  manager = await f.createUser(club.id, { role: 'manager', display_name: 'Gerente' });
  cajero = await f.createUser(club.id, { role: 'cashier' });
  waiter = await f.createUser(club.id, { role: 'waiter' });
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

async function pedido() {
  const res = await api().post(url('/orders')).set(auth(waiter)).send({
    client_request_id: randomUUID(), table_id: table.id, items: [{ drink_id: beer.id, quantity: 2 }] });
  return res.body.order;
}
const voucher = (o, extra = {}) => api().post(url('/till/payments')).set(auth(cajero))
  .send({ transaction_id: o.transaction_id, method: 'card_terminal', amount: 120, reference: '000', ...extra });
const pagos = async () => (await pool.query('SELECT count(*)::int AS n FROM manual_payments')).rows[0].n;

describe('En la caja', () => {
  it('sin PIN de gerente no se registra, y el pedido sigue por cobrar', async () => {
    const o = await pedido();
    const res = await voucher(o);
    expect(res.status).toBe(403);
    expect(res.body.error.message).toMatch(/PIN de un gerente/);
    expect(await pagos()).toBe(0);
  });

  it('sin motivo tampoco', async () => {
    const o = await pedido();
    expect((await voucher(o, { manager_pin: pinGerente })).status).toBe(400);
    expect(await pagos()).toBe(0);
  });

  it('con un PIN que no es de gerencia no pasa', async () => {
    const o = await pedido();
    expect((await voucher(o, { manager_pin: '123456', voucher_reason: 'sin señal' })).status).toBe(403);
  });

  it('con motivo y PIN se registra, y queda quién lo autorizó', async () => {
    const o = await pedido();
    const res = await voucher(o, { manager_pin: pinGerente, voucher_reason: 'la terminal no prendía' });
    expect(res.status).toBe(201);
    const { rows } = await pool.query(
      'SELECT authorized_by, authorization_reason FROM manual_payments WHERE id = $1', [res.body.payment.id]);
    expect(rows[0]).toEqual({ authorized_by: manager.id, authorization_reason: 'la terminal no prendía' });
    const log = await pool.query(
      `SELECT actor_id FROM audit_log WHERE action = 'payment.manual_voucher' AND entity_id = $1`,
      [res.body.payment.id]);
    expect(log.rows).toEqual([{ actor_id: cajero.id }]);
  });

  it('el efectivo sigue sin pedir nada', async () => {
    const o = await pedido();
    const res = await api().post(url('/till/payments')).set(auth(cajero))
      .send({ transaction_id: o.transaction_id, method: 'cash', amount: 120, cash_received: 200 });
    expect(res.status).toBe(201);
  });
});

describe('Por el registro directo', () => {
  it('el cajero tampoco lo registra solo por /manual-payments/register', async () => {
    const o = await pedido();
    const body = { transaction_id: o.transaction_id, method: 'card_terminal', amount: 120, currency: 'MXN', reference: 'VCH-1' };
    expect((await api().post(url('/manual-payments/register')).set(auth(cajero)).send(body)).status).toBe(403);
    const ok = await api().post(url('/manual-payments/register')).set(auth(cajero))
      .send({ ...body, manager_pin: pinGerente, voucher_reason: 'terminal descargada' });
    expect(ok.status).toBe(201);
  });
});
