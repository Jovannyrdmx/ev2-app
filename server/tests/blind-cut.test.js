/**
 * Corte a ciegas (D105).
 *
 * Quien tiene efectivo del club en la mano cuenta su cajón sin saber cuánto debería
 * haber, y lo que contó queda escrito antes de que el gerente le enseñe lo esperado.
 * Si lo viera antes, un sobrante se lo podría quedar sin que el corte lo note.
 */
'use strict';

const { randomUUID } = require('crypto');
const { setupSchema, truncateAll, closePool, pool } = require('./helpers/db');
const pins = require('../src/services/pins');
const { api, auth } = require('./helpers/api');
const f = require('./helpers/factories');

let club; let manager; let cajero; let waiter; let hostess; let table; let beer; let pinGerente;

beforeAll(setupSchema);
afterAll(closePool);

const url = (p) => `/api/nightclubs/${club.id}${p}`;

beforeEach(async () => {
  await truncateAll();
  club = await f.createNightclub({ slug: 'ev2-ciegas' });
  manager = await f.createUser(club.id, { role: 'manager', display_name: 'Gerente' });
  cajero = await f.createUser(club.id, { role: 'cashier', display_name: 'Caja Ana' });
  waiter = await f.createUser(club.id, { role: 'waiter' });
  hostess = await f.createUser(club.id, { role: 'hostess' });
  table = await f.createTable(club.id, { section: 'ZONA ROJA' });
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
  expect(abierta.status).toBe(201);
});

async function cobrado(method = 'cash', extra = {}) {
  const o = await api().post(url('/orders')).set(auth(waiter)).send({
    client_request_id: randomUUID(), table_id: table.id, items: [{ drink_id: beer.id, quantity: 2 }] });
  const res = await api().post(url('/till/payments')).set(auth(cajero))
    .send({ transaction_id: o.body.order.transaction_id, method, amount: 120, ...extra });
  expect(res.status).toBe(201);
}

const miCorte = () => api().get(url('/shifts/me/cut')).set(auth(cajero));
const declarar = (body, user = cajero) => api().post(url('/shifts/me/declaration')).set(auth(user)).send(body);
const cerrar = (body) => api().post(url('/shifts/me/closing')).set(auth(cajero))
  .send({ manager_pin: pinGerente, ...body });

describe('Lo que ve el cajero antes de contar', () => {
  it('no ve lo esperado ni nada de lo que pueda sacarlo', async () => {
    await cobrado('cash');
    await cobrado('card_terminal', { reference: 'VCH-1001' });
    const res = await miCorte();
    expect(res.status).toBe(200);
    expect(res.body.blind).toBe(true);
    expect(res.body.cash_to_hand).toBeNull();
    expect(res.body.usd_to_hand).toBeNull();
    expect(res.body.totals.cash_collected).toBeNull();
    expect(res.body.totals.total_collected).toBeNull();
    const porMetodo = Object.fromEntries(res.body.totals.by_method.map((l) => [l.method, l]));
    expect(porMetodo.cash).toMatchObject({ amount: null, count: 1 });
    // Lo de tarjeta no es efectivo: se ve.
    expect(porMetodo.card_terminal).toMatchObject({ amount: '120.00', count: 1 });
    expect(JSON.stringify(res.body)).not.toMatch(/1120/);
  });

  it('la anfitriona no ve cuánto lleva cobrado en la puerta; el gerente sí', async () => {
    expect((await api().get(url('/door/summary')).set(auth(hostess))).body.door.cobrado).toBeNull();
    expect((await api().get(url('/door/summary')).set(auth(manager))).body.door.cobrado).not.toBeNull();
  });
});

describe('Contar, guardar y cerrar', () => {
  it('sin el conteo guardado no se cierra', async () => {
    await cobrado('cash');
    const res = await cerrar({ counted_cash: 1120 });
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/guarda tu conteo/);
  });

  it('el conteo se guarda una vez y no se cambia', async () => {
    await cobrado('cash');
    expect((await declarar({ declared_cash: 1100 })).status).toBe(201);
    const otra = await declarar({ declared_cash: 1120 });
    expect(otra.status).toBe(409);
    await expect(pool.query('UPDATE shift_declarations SET declared_cash = 1120'))
      .rejects.toMatchObject({ code: '23001' });
    await expect(pool.query('DELETE FROM shift_declarations'))
      .rejects.toMatchObject({ code: '23001' });
  });

  it('el cierre usa lo que se guardó, no lo que llegue después', async () => {
    await cobrado('cash');
    await declarar({ declared_cash: 1100 });
    // Ya vio el número en el cierre anterior y quiere "corregir": no se puede.
    const res = await cerrar({ declared_cash: 1120, counted_cash: 1100, difference_reason: 'faltan 20 de cambio' });
    expect(res.status).toBe(201);
    expect(res.body.closing).toMatchObject({
      declared_cash: '1100.00', counted_cash: '1100.00', expected_cash: '1120.00', difference: '-20.00',
    });
  });

  it('con diferencia y sin motivo, el gerente (ya con su código) ve cuánto y pone el motivo', async () => {
    await cobrado('cash');
    await declarar({ declared_cash: 1100 });
    const sinMotivo = await cerrar({ counted_cash: 1100 });
    expect(sinMotivo.status).toBe(422);
    expect(sinMotivo.body.error.details).toMatchObject({ expected: '1120.00', difference: '-20.00' });
    const ok = await cerrar({ counted_cash: 1100, difference_reason: 'cambio mal dado' });
    expect(ok.status).toBe(201);
  });

  it('con un código equivocado no se revela nada', async () => {
    await cobrado('cash');
    await declarar({ declared_cash: 1100 });
    const res = await cerrar({ counted_cash: 1100, manager_pin: '000000' });
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).not.toMatch(/1120/);
  });

  it('ya cerrado, el corte enseña todo', async () => {
    await cobrado('cash');
    await declarar({ declared_cash: 1120 });
    expect((await cerrar({ counted_cash: 1120 })).status).toBe(201);
    const res = await miCorte();
    // El turno se cerró: el corte ya no es del turno abierto.
    if (res.body.shift) expect(res.body.blind).toBe(false);
  });
});
