/**
 * El crédito de consumo de una reservación VIP (D97).
 *
 * Lo pagado por reservar se le da a quien reservó para consumir ESA noche:
 *   * crece con lo que de verdad entra (cada pago confirmado de la reservación);
 *   * se gasta en caja con la forma de pago "Crédito VIP", sola o junto a otra;
 *   * solo en la mesa reservada, solo esa noche, solo quien reservó (o el personal);
 *   * se anula si la reservación se cancela o no llega;
 *   * si se cancela la cuenta pagada con él, regresa mientras la noche siga.
 */
'use strict';

const { randomUUID } = require('crypto');
const { setupSchema, truncateAll, closePool, pool } = require('./helpers/db');
const pins = require('../src/services/pins');
const { api, auth } = require('./helpers/api');
const f = require('./helpers/factories');

let club; let manager; let cajero; let waiter; let guest; let table; let otherTable; let beer;
let night; let pinGerente;

beforeAll(setupSchema);
afterAll(closePool);

const url = (p) => `/api/nightclubs/${club.id}${p}`;

beforeEach(async () => {
  await truncateAll();
  club = await f.createNightclub({ slug: 'ev2-vip' });
  manager = await f.createUser(club.id, { role: 'manager', display_name: 'Gerente' });
  cajero = await f.createUser(club.id, { role: 'cashier', display_name: 'Caja Ana' });
  waiter = await f.createUser(club.id, { role: 'waiter', display_name: 'Luis' });
  guest = await f.createUser(club.id, { role: 'guest', display_name: 'Ana' });
  table = await f.createTable(club.id, { code: 'V-1', section: 'VIP', capacity: 8 });
  otherTable = await f.createTable(club.id, { code: 'T-9', section: 'ZONA ROJA', capacity: 4 });
  beer = await f.createDrink(club.id, { name: 'Cerveza', price: 60, stock: 100 });
  const ev = await pool.query(
    `INSERT INTO events_calendar (nightclub_id, name, event_date, doors_open_at, ticket_price, status)
     VALUES ($1,'Viernes',(now() - interval '1 hour')::date, now() - interval '1 hour', 0, 'published')
     RETURNING id`, [club.id]);
  night = ev.rows[0];
  pinGerente = await pins.issuePin(pool, { userId: manager.id });
  await pool.query('UPDATE users SET must_change_pin = false WHERE id = $1', [manager.id]);
  await api().post(url(`/nights/${night.id}/roster`)).set(auth(manager))
    .send({ user_id: cajero.id, location_id: club.bar_id });
  const abierta = await api().post(url('/till/open')).set(auth(cajero))
    .send({ opening_float: 1000, manager_pin: pinGerente });
  if (abierta.status !== 201) throw new Error(`abrir caja: ${abierta.status}`);
});

/** Una reservación de la mesa VIP para esta noche, sin pagar. */
async function reservar(over = {}) {
  const { rows } = await pool.query(
    `INSERT INTO reservations (nightclub_id, user_id, table_id, event_id, guest_count, status,
                               currency, total_estimated, deposit_amount, starts_at, duration_minutes)
     VALUES ($1,$2,$3,$4,6,'pending_payment','MXN',4000,$5, now() + interval '3 hours', 180)
     RETURNING id`,
    [club.id, over.user_id || guest.id, over.table_id || table.id, night.id, over.deposit || 1200]);
  return rows[0].id;
}

/** Cobra un pago de la reservación (lo hace el gerente, en efectivo). */
async function pagarReserva(reservationId, amount) {
  const { rows } = await pool.query(
    `INSERT INTO transactions (nightclub_id, type, direction, amount, currency, status,
                               payer_user_id, provider, reference_type, reference_id)
     VALUES ($1,'reservation_deposit','in',$2,'MXN','pending',$3,'manual','reservation',$4)
     RETURNING id`, [club.id, amount, guest.id, reservationId]);
  const res = await api().post(url('/manual-payments/register')).set(auth(manager))
    .send({ transaction_id: rows[0].id, method: 'cash', amount, currency: 'MXN' });
  if (res.status >= 300) throw new Error(`pago reserva: ${res.status} ${JSON.stringify(res.body)}`);
  return rows[0].id;
}

const credito = async () => (await pool.query(
  `SELECT granted::text AS granted, spent::text AS spent, voided_at, void_reason, expires_at
     FROM reservation_credits`)).rows[0];

/** Dos cervezas ($120) en la mesa dada. */
const pedido = async (tableId = table.id) => {
  const res = await api().post(url('/orders')).set(auth(waiter)).send({
    client_request_id: randomUUID(), table_id: tableId, items: [{ drink_id: beer.id, quantity: 2 }],
  });
  if (res.status !== 201) throw new Error(`pedido: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.order;
};

const pagar = (order, body) => api().post(url('/till/payments')).set(auth(cajero))
  .send({ transaction_id: order.transaction_id, ...body });

describe('Otorgar el crédito', () => {
  it('lo pagado por la reservación pasa a ser crédito de quien reservó, hasta el fin de la noche', async () => {
    const id = await reservar();
    expect(await credito()).toBeUndefined();
    await pagarReserva(id, 1200);
    const c = await credito();
    expect(c).toMatchObject({ granted: '1200.00', spent: '0.00', voided_at: null });
    expect(new Date(c.expires_at).getTime()).toBeGreaterThan(Date.now());

    const mio = await api().get(url('/vip-credit/mine')).set(auth(guest));
    expect(mio.status).toBe(200);
    expect(mio.body.credits[0]).toMatchObject({ balance: '1200.00', usable: true, table_code: 'V-1' });
    const personal = await api().get(url('/vip-credits')).set(auth(cajero));
    expect(personal.body.credits).toHaveLength(1);
    expect((await api().get(url('/vip-credits')).set(auth(guest))).status).toBe(403);
  });

  it('un segundo pago de la reservación suma al crédito', async () => {
    const id = await reservar();
    await pagarReserva(id, 1200);
    await pagarReserva(id, 2800);
    expect((await credito()).granted).toBe('4000.00');
    const { rows } = await pool.query(
      `SELECT kind FROM reservation_credit_movements ORDER BY created_at, kind DESC`);
    expect(rows.map((r) => r.kind)).toEqual(['grant', 'grant']);
  });
});

describe('Gastar el crédito en caja', () => {
  it('"Crédito VIP" paga la cuenta de la mesa y descuenta el saldo', async () => {
    await pagarReserva(await reservar(), 1200);
    const res = await pagar(await pedido(), { method: 'vip_credit', amount: 120 });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ paid: true, remaining: '0.00' });
    expect(res.body.payment).toMatchObject({ method: 'vip_credit', amount: '120.00' });
    expect(await credito()).toMatchObject({ granted: '1200.00', spent: '120.00' });
    const mov = await pool.query(
      `SELECT kind, amount::text AS amount, balance_after::text AS balance_after
         FROM reservation_credit_movements WHERE kind = 'spend'`);
    expect(mov.rows).toEqual([{ kind: 'spend', amount: '-120.00', balance_after: '1080.00' }]);
  });

  it('el pedido pendiente de la caja avisa cuánto crédito VIP tiene la mesa', async () => {
    await pagarReserva(await reservar(), 1200);
    await pedido();
    const res = await api().get(url('/till')).set(auth(cajero));
    expect(res.body.pending_orders[0].vip_credit_balance).toBe('1200.00');
    await pedido(otherTable.id);
    const otra = (await api().get(url('/till')).set(auth(cajero))).body.pending_orders
      .find((o) => o.table_id === otherTable.id);
    expect(otra.vip_credit_balance).toBeNull();
  });

  it('si el crédito no alcanza, cubre lo que tiene y el resto va en otra forma de pago', async () => {
    await pagarReserva(await reservar({ deposit: 50 }), 50);
    const order = await pedido(); // 120
    const a = await pagar(order, { method: 'vip_credit', amount: 120 });
    expect(a.status).toBe(201);
    expect(a.body).toMatchObject({ paid: false, remaining: '70.00' });
    expect((await credito()).spent).toBe('50.00');
    const b = await pagar(order, { method: 'cash', amount: 70 });
    expect(b.body.paid).toBe(true);
    // Agotado: no hay más que gastar.
    const otro = await pagar(await pedido(), { method: 'vip_credit', amount: 120 });
    expect(otro.status).toBe(409);
    expect(otro.body.error.message).toMatch(/agotó/);
  });

  it('una mesa sin reservación VIP no tiene crédito', async () => {
    await pagarReserva(await reservar(), 1200);
    const res = await pagar(await pedido(otherTable.id), { method: 'vip_credit', amount: 120 });
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/no tiene crédito VIP/);
  });

  it('pasada la noche el crédito ya no se gasta', async () => {
    await pagarReserva(await reservar(), 1200);
    const order = await pedido();
    await pool.query(`UPDATE reservation_credits SET expires_at = now() - interval '1 minute'`);
    const res = await pagar(order, { method: 'vip_credit', amount: 120 });
    expect(res.status).toBe(422);
    expect((await credito()).spent).toBe('0.00');
  });

  it('un invitado de la mesa no gasta el crédito de quien reservó', async () => {
    await pagarReserva(await reservar(), 1200);
    const invitado = await f.createUser(club.id, { role: 'guest', display_name: 'Invitado' });
    const order = await pedido();
    await pool.query('UPDATE drink_orders SET sender_id = $1 WHERE id = $2', [invitado.id, order.id]);
    const res = await pagar(order, { method: 'vip_credit', amount: 120 });
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/quien reservó/);
  });

  it('el recibo dice Crédito VIP', async () => {
    await pagarReserva(await reservar(), 1200);
    await api().post(url('/printers')).set(auth(manager)).send({
      location_id: club.bar_id, name: 'Caja PB', purpose: 'till',
      connection: 'network', host: '192.168.1.70',
    });
    await pagar(await pedido(), { method: 'vip_credit', amount: 120 });
    const { rows } = await pool.query(`SELECT preview FROM print_jobs WHERE kind = 'receipt'`);
    expect(rows[0].preview).toMatch(/Crédito VIP/);
  });
});

describe('Anular y devolver', () => {
  it('cancelar la reservación anula el crédito', async () => {
    const id = await reservar();
    await pagarReserva(id, 1200);
    const res = await api().post(url(`/reservations/${id}/cancel`)).set(auth(guest)).send({});
    expect(res.status).toBe(200);
    expect(await credito()).toMatchObject({ void_reason: 'cancelled' });
    const mov = await pool.query(`SELECT kind, amount::text AS amount FROM reservation_credit_movements
                                   WHERE kind = 'void'`);
    expect(mov.rows).toEqual([{ kind: 'void', amount: '1200.00' }]);
    const gasto = await pagar(await pedido(), { method: 'vip_credit', amount: 120 });
    expect(gasto.status).toBe(422);
  });

  it('marcar que no llegó anula el crédito', async () => {
    const id = await reservar();
    await pagarReserva(id, 1200);
    const res = await api().post(url(`/reservations/${id}/status`)).set(auth(manager))
      .send({ status: 'no_show' });
    expect(res.status).toBe(200);
    expect(await credito()).toMatchObject({ void_reason: 'no_show' });
  });

  it('un pago que llega tarde no revive un crédito anulado', async () => {
    const id = await reservar();
    await pagarReserva(id, 1200);
    await api().post(url(`/reservations/${id}/status`)).set(auth(manager)).send({ status: 'no_show' });
    await pagarReserva(id, 100);
    expect((await credito()).granted).toBe('1200.00');
  });

  it('cancelar una cuenta pagada con crédito lo regresa, una sola vez', async () => {
    await pagarReserva(await reservar(), 1200);
    const order = await pedido();
    await pagar(order, { method: 'vip_credit', amount: 120 });
    expect((await credito()).spent).toBe('120.00');
    const res = await api().post(url(`/orders/${order.id}/status`)).set(auth(manager))
      .send({ status: 'cancelled', reason: 'se acabó' });
    expect(res.status).toBe(200);
    expect((await credito()).spent).toBe('0.00');
    const mov = await pool.query(`SELECT kind FROM reservation_credit_movements ORDER BY created_at, kind DESC`);
    expect(mov.rows.map((r) => r.kind)).toEqual(['grant', 'spend', 'restore']);
  });
});

describe('Libro del crédito', () => {
  it('los movimientos no se editan ni se borran', async () => {
    await pagarReserva(await reservar(), 1200);
    await expect(pool.query(`UPDATE reservation_credit_movements SET amount = 1`)).rejects.toThrow();
    await expect(pool.query(`DELETE FROM reservation_credit_movements`)).rejects.toThrow();
  });

  it('no se puede gastar más de lo otorgado', async () => {
    await pagarReserva(await reservar(), 1200);
    await expect(pool.query(`UPDATE reservation_credits SET spent = granted + 1`)).rejects.toThrow();
  });
});
