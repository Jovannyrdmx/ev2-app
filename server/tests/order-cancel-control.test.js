/**
 * Cancelar un pedido deja rastro, y lo ya preparado es merma (D106).
 *
 * El mesero y el cajero cancelaban sin PIN, sin motivo y sin que el pedido dijera
 * quién; y un trago que la barra ya estaba preparando "regresaba" al inventario. Así
 * se esconde un trago regalado: se sirve, se cobra en efectivo y se cancela.
 */
'use strict';

const { randomUUID } = require('crypto');
const { setupSchema, truncateAll, closePool, pool } = require('./helpers/db');
const pins = require('../src/services/pins');
const { api, auth } = require('./helpers/api');
const f = require('./helpers/factories');

let club; let manager; let waiter; let cajero; let bartender; let table; let beer; let pinGerente;

beforeAll(setupSchema);
afterAll(closePool);

const url = (p) => `/api/nightclubs/${club.id}${p}`;

beforeEach(async () => {
  await truncateAll();
  club = await f.createNightclub({ slug: 'ev2-cancelar' });
  manager = await f.createUser(club.id, { role: 'manager', display_name: 'Gerente' });
  waiter = await f.createUser(club.id, { role: 'waiter' });
  cajero = await f.createUser(club.id, { role: 'cashier' });
  bartender = await f.createUser(club.id, { role: 'bartender' });
  table = await f.createTable(club.id, { section: 'ROJA' });
  beer = await f.createDrink(club.id, { name: 'Cerveza', price: 60, stock: 40 });
  pinGerente = await pins.issuePin(pool, { userId: manager.id });
  await pool.query('UPDATE users SET must_change_pin = false WHERE id = $1', [manager.id]);
});

async function pedido(qty = 2) {
  const res = await api().post(url('/orders')).set(auth(waiter)).send({
    client_request_id: randomUUID(), table_id: table.id, items: [{ drink_id: beer.id, quantity: qty }] });
  expect(res.status).toBe(201);
  return res.body.order;
}
const estado = (o, user, body) => api().post(url(`/orders/${o.id}/status`)).set(auth(user)).send(body);
const existencia = () => f.supplyStock(beer.supply_id, club.bar_id);
const fila = async (o) => (await pool.query(
  `SELECT status, cancelled_by, cancel_reason, cancel_authorized_by, cancel_served
     FROM drink_orders WHERE id = $1`, [o.id])).rows[0];

describe('Quién puede cancelar', () => {
  it.each([['mesero', () => waiter], ['cajero', () => cajero]])(
    'el %s no cancela sin el PIN de un gerente', async (_, quien) => {
      const o = await pedido();
      const res = await estado(o, quien(), { status: 'cancelled', reason: 'se fue' });
      expect(res.status).toBe(403);
      expect((await fila(o)).status).toBe('confirmed');
      expect(await existencia()).toBe(38);
    });

  it('con motivo y PIN cancela, y el pedido dice quién y con permiso de quién', async () => {
    const o = await pedido();
    const res = await estado(o, waiter, { status: 'cancelled', reason: 'la mesa se fue', manager_pin: pinGerente });
    expect(res.status).toBe(200);
    expect(await fila(o)).toMatchObject({
      status: 'cancelled', cancelled_by: waiter.id, cancel_reason: 'la mesa se fue',
      cancel_authorized_by: manager.id, cancel_served: false,
    });
    expect(await existencia()).toBe(40);
    const { rows } = await pool.query(
      `SELECT action, actor_id FROM audit_log WHERE entity = 'drink_order' AND entity_id = $1`, [o.id]);
    expect(rows).toEqual([{ action: 'order.cancel_authorized', actor_id: waiter.id }]);
  });

  it('sin motivo no cancela aunque traiga PIN', async () => {
    const o = await pedido();
    const res = await estado(o, cajero, { status: 'cancelled', manager_pin: pinGerente });
    expect(res.status).toBe(400);
  });

  it('el gerente cancela sin PIN, pero queda escrito', async () => {
    const o = await pedido();
    expect((await estado(o, manager, { status: 'cancelled', reason: 'error de captura' })).status).toBe(200);
    expect((await fila(o)).cancelled_by).toBe(manager.id);
    const { rows } = await pool.query(
      `SELECT action FROM audit_log WHERE entity = 'drink_order' AND entity_id = $1`, [o.id]);
    expect(rows).toEqual([{ action: 'order.cancelled' }]);
  });
});

describe('Lo ya preparado es merma', () => {
  it('un pedido en "preparando" no regresa al estante: queda como merma', async () => {
    const o = await pedido(3);
    await estado(o, bartender, { status: 'preparing' });
    const res = await estado(o, waiter, { status: 'cancelled', reason: 'no lo quiso', manager_pin: pinGerente });
    expect(res.status).toBe(200);
    expect(await existencia()).toBe(37);
    expect((await fila(o)).cancel_served).toBe(true);
    const { rows } = await pool.query(
      `SELECT kind, quantity::float8 AS q, authorized_by FROM supply_movements
        WHERE reference_id = $1 ORDER BY created_at, kind`, [o.id]);
    const merma = rows.find((r) => r.kind === 'waste');
    expect(merma).toMatchObject({ q: -3, authorized_by: manager.id });
  });

  it('en la cola sin empezar, si dicen que ya se sirvió, también es merma', async () => {
    const o = await pedido(2);
    await estado(o, cajero, { status: 'cancelled', reason: 'se derramó', manager_pin: pinGerente, served: true });
    expect(await existencia()).toBe(38);
  });

  it('en la cola sin empezar y sin servir, regresa al estante', async () => {
    const o = await pedido(2);
    await estado(o, cajero, { status: 'cancelled', reason: 'se equivocó de mesa', manager_pin: pinGerente });
    expect(await existencia()).toBe(40);
  });
});
