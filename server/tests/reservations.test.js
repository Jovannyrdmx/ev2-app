'use strict';

// Reservaciones en el modelo por noche: cada reservación pertenece a un evento y su
// precio sale de la zona (base + boletos extra) más los extras del catálogo.
// Las reglas de zona y los precios por evento se prueban aparte, en events.test.js.

const { randomUUID } = require('crypto');
const { setupSchema, truncateAll, closePool, pool } = require('./helpers/db');
const { api, auth } = require('./helpers/api');
const f = require('./helpers/factories');
const { loadPriceList } = require('../seeds/price-list');
const { loadMenu } = require('../seeds/menu');

let club; let guest; let other; let hostess; let manager; let bartender;
let azul; let roja; let general; let event;

beforeAll(setupSchema);
afterAll(closePool);

beforeEach(async () => {
  await truncateAll();
  club = await f.createNightclub({ slug: 'ev2-res' });
  guest = await f.createUser(club.id, { role: 'guest' });
  other = await f.createUser(club.id, { role: 'guest' });
  hostess = await f.createUser(club.id, { role: 'hostess' });
  manager = await f.createUser(club.id, { role: 'manager' });
  bartender = await f.createUser(club.id, { role: 'bartender' });

  await loadPriceList({ slug: 'ev2-res' });
  await loadMenu({ slug: 'ev2-res' });
  await f.createReservationRules(club.id, { deposit_pct: 30, min_party_size: 2, max_party_size: 20 });

  azul = await f.createTable(club.id, { code: 'AZ13', section: 'ZONA AZUL', capacity: 10, type: 'vip' });
  roja = await f.createTable(club.id, { code: '39', section: 'ZONA ROJA', capacity: 8, type: 'booth' });
  general = await f.createTable(club.id, { code: '5', section: 'GENERAL', capacity: 4 });

  event = (await makeEvent()).body.event;
});

const url = (p) => `/api/nightclubs/${club.id}${p}`;

/** Crea un evento publicado que abre `hoursAhead` horas a partir de ahora. */
async function makeEvent(over = {}) {
  const doors = new Date(Date.now() + (over.hoursAhead ?? 24 * 7) * 3_600_000);
  return api().post(url('/events')).set(auth(manager)).send({
    name: over.name || 'Noche de prueba',
    event_date: doors.toISOString().slice(0, 10),
    doors_open_at: doors.toISOString(),
    ticket_price: over.ticket_price ?? 250,
    status: over.status || 'published',
  });
}

const book = (over = {}, user = guest) => api().post(url('/reservations')).set(auth(user)).send({
  client_request_id: randomUUID(),
  event_id: over.event_id || event.id,
  table_id: over.table_id || azul.id,
  guest_count: over.guest_count ?? 10,
  ...(over.addons ? { addons: over.addons } : {}),
  ...(over.discount_code ? { discount_code: over.discount_code } : {}),
  ...(over.client_request_id ? { client_request_id: over.client_request_id } : {}),
});

describe('Reglas', () => {
  it('devuelve las reglas del club', async () => {
    const res = await api().get(url('/reservations/rules')).set(auth(guest));
    expect(res.status).toBe(200);
    expect(Number(res.body.rules.deposit_pct)).toBe(30);
  });

  it('el gerente las actualiza', async () => {
    const res = await api().put(url('/reservations/rules')).set(auth(manager))
      .send({ deposit_pct: 50, max_party_size: 10 });
    expect(res.status).toBe(200);
    expect(Number(res.body.rules.deposit_pct)).toBe(50);
  });

  it('un cliente no puede', async () => {
    const res = await api().put(url('/reservations/rules')).set(auth(guest)).send({ deposit_pct: 0 });
    expect(res.status).toBe(403);
  });

  it('rechaza un máximo menor que el mínimo', async () => {
    const res = await api().put(url('/reservations/rules')).set(auth(manager))
      .send({ min_party_size: 10, max_party_size: 4 });
    expect(res.status).toBe(422);
  });
});

describe('Disponibilidad y cotización', () => {
  it('muestra las mesas reservables con el precio de la noche', async () => {
    const res = await api().get(url(`/reservations/availability?event_id=${event.id}&guests=10`))
      .set(auth(guest));
    expect(res.status).toBe(200);
    // ZONA ROJA incluye 8 sin extras, GENERAL no se reserva: solo queda la azul.
    expect(res.body.tables.map((t) => t.code)).toEqual(['AZ13']);
    expect(res.body.tables[0].price).toBe(4500); // base de Zona Azul, 10 boletos incluidos
    expect(res.body.tables[0].deposit).toBe(1350); // 30%
  });

  it('cobra el boleto del evento por cada persona extra', async () => {
    const res = await api().get(url(`/reservations/availability?event_id=${event.id}&guests=12`))
      .set(auth(guest));
    const t = res.body.tables.find((x) => x.code === 'AZ13');
    expect(t.extra_guests).toBe(2);
    expect(t.extras_total).toBe(500); // 2 × $250 de boleto
    expect(t.price).toBe(5000);
  });

  it('nunca ofrece una zona no reservable', async () => {
    const res = await api().get(url(`/reservations/availability?event_id=${event.id}&guests=4`))
      .set(auth(guest));
    expect(res.body.tables.map((t) => t.code)).not.toContain(general.code);
  });

  it('excluye mesas bloqueadas', async () => {
    await pool.query(`UPDATE tables SET status = 'blocked' WHERE id = $1`, [azul.id]);
    const res = await api().get(url(`/reservations/availability?event_id=${event.id}&guests=10`))
      .set(auth(guest));
    expect(res.body.tables).toHaveLength(0);
  });

  it('suma extras del catálogo y aplica descuento porcentual', async () => {
    await pool.query(
      `INSERT INTO reservation_discounts (nightclub_id, code, discount_type, discount_value)
       VALUES ($1,'PROMO10','percentage',10)`, [club.id]);

    const res = await api().post(url('/reservations/quote')).set(auth(guest)).send({
      event_id: event.id,
      table_id: azul.id,
      guest_count: 10,
      addons: [{ code: 'pos-03022', quantity: 1 }], // MOET, $3,500 de la carta real
      discount_code: 'PROMO10',
    });

    const q = res.body.quote;
    expect(q.zone.base_price).toBe(4500);
    expect(q.addons_total).toBe(3500);
    expect(q.subtotal).toBe(8000);
    expect(q.discount.amount).toBe(800);
    expect(q.total).toBe(7200);
    expect(q.deposit).toBe(2160); // 30% de 7200
  });

  it('aplica descuento de monto fijo', async () => {
    await pool.query(
      `INSERT INTO reservation_discounts (nightclub_id, code, discount_type, discount_value)
       VALUES ($1,'MENOS500','fixed_amount',500)`, [club.id]);
    const res = await api().post(url('/reservations/quote')).set(auth(guest))
      .send({ event_id: event.id, table_id: azul.id, guest_count: 10, discount_code: 'MENOS500' });
    expect(res.body.quote.total).toBe(4000);
  });

  it('rechaza un código inválido, vencido o agotado', async () => {
    await pool.query(
      `INSERT INTO reservation_discounts (nightclub_id, code, discount_type, discount_value, valid_until)
       VALUES ($1,'VENCIDO','percentage',10, current_date - 1)`, [club.id]);
    await pool.query(
      `INSERT INTO reservation_discounts (nightclub_id, code, discount_type, discount_value, max_uses, used_count)
       VALUES ($1,'AGOTADO','percentage',10, 1, 1)`, [club.id]);

    for (const code of ['NOEXISTE', 'VENCIDO', 'AGOTADO']) {
      const res = await api().post(url('/reservations/quote')).set(auth(guest))
        .send({ event_id: event.id, table_id: azul.id, guest_count: 10, discount_code: code });
      expect(res.status).toBe(422);
    }
  });

  it('exige la anticipación mínima', async () => {
    const soon = (await makeEvent({ hoursAhead: 1, name: 'Hoy mismo' })).body.event;
    const res = await api().get(url(`/reservations/availability?event_id=${soon.id}&guests=10`))
      .set(auth(guest));
    expect(res.status).toBe(422);
  });
});

describe('Reserva', () => {
  it('crea la reservación con el depósito calculado en el servidor', async () => {
    const res = await book();
    expect(res.status).toBe(201);
    expect(res.body.reservation.status).toBe('pending_payment');
    expect(res.body.reservation.total_estimated).toBe('4500.00');
    expect(res.body.reservation.deposit_amount).toBe('1350.00');
    expect(res.body.payment.status).toBe('pending');
    expect(res.body.arrival_deadline).toBeTruthy();
  });

  it('congela el precio de la zona y del boleto de esa noche', async () => {
    const res = await book({ guest_count: 12 });
    const { rows } = await pool.query(
      `SELECT zone_base_at_booking, ticket_at_booking, included_tickets, extra_guests
         FROM reservations WHERE id = $1`, [res.body.reservation.id]);
    expect(rows[0]).toMatchObject({
      zone_base_at_booking: '4500.00', ticket_at_booking: '250.00',
      included_tickets: 10, extra_guests: 2,
    });
  });

  it('la reservación dura toda la noche, no un horario', async () => {
    const res = await book();
    const { starts_at: start } = res.body.reservation;
    expect(new Date(start).toISOString()).toBe(new Date(event.doors_open_at).toISOString());
  });

  it('registra el depósito en el libro contable como pendiente', async () => {
    await book();
    const { rows } = await pool.query('SELECT type, amount, status, direction FROM transactions');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: 'reservation_deposit', amount: '1350.00', status: 'pending', direction: 'in',
    });
  });

  it('es idempotente', async () => {
    const id = randomUUID();
    const first = await book({ client_request_id: id });
    const second = await book({ client_request_id: id });

    expect(second.status).toBe(200);
    expect(second.body.reservation.id).toBe(first.body.reservation.id);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM reservations');
    expect(rows[0].n).toBe(1);
  });

  it('rechaza más personas de las que admite la zona', async () => {
    const res = await book({ table_id: roja.id, guest_count: 9 });
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/no admite extras/);
  });

  it('rechaza grupos por debajo del mínimo del club', async () => {
    const res = await book({ guest_count: 1 });
    expect(res.status).toBe(422);
  });

  it('rechaza sin la anticipación mínima', async () => {
    const soon = (await makeEvent({ hoursAhead: 1, name: 'Hoy mismo' })).body.event;
    const res = await book({ event_id: soon.id });
    expect(res.status).toBe(422);
  });

  it('cuenta el uso del código de descuento', async () => {
    await pool.query(
      `INSERT INTO reservation_discounts (nightclub_id, code, discount_type, discount_value, max_uses)
       VALUES ($1,'PROMO10','percentage',10,5)`, [club.id]);
    await book({ discount_code: 'PROMO10' });
    const { rows } = await pool.query('SELECT used_count FROM reservation_discounts');
    expect(rows[0].used_count).toBe(1);
  });

  it('guarda los extras', async () => {
    const res = await book({
      addons: [{ type: 'decorations', name: 'Globos', price: 300, quantity: 2 }],
    });
    expect(res.body.reservation.addons).toHaveLength(1);
    expect(res.body.reservation.addons[0]).toMatchObject({ name: 'Globos', price: '300.00', quantity: 2 });
  });
});

describe('Ciclo de vida', () => {
  const setStatus = (id, status, user) => api().post(url(`/reservations/${id}/status`))
    .set(auth(user)).send({ status });

  it('avanza de confirmada a sentada y completada', async () => {
    const { body } = await book();
    for (const status of ['confirmed', 'seated', 'completed']) {
      const res = await setStatus(body.reservation.id, status, hostess);
      expect(res.status).toBe(200);
    }
  });

  it('reserva y luego ocupa la mesa según el estado', async () => {
    const { body } = await book();
    await setStatus(body.reservation.id, 'confirmed', hostess);
    let { rows } = await pool.query('SELECT status FROM tables WHERE id = $1', [azul.id]);
    expect(rows[0].status).toBe('reserved');

    await setStatus(body.reservation.id, 'seated', hostess);
    ({ rows } = await pool.query('SELECT status FROM tables WHERE id = $1', [azul.id]));
    expect(rows[0].status).toBe('occupied');

    await setStatus(body.reservation.id, 'completed', hostess);
    ({ rows } = await pool.query('SELECT status FROM tables WHERE id = $1', [azul.id]));
    expect(rows[0].status).toBe('available');
  });

  it('libera la mesa si el cliente no llega', async () => {
    const { body } = await book();
    await setStatus(body.reservation.id, 'confirmed', hostess);
    await setStatus(body.reservation.id, 'no_show', hostess);
    const { rows } = await pool.query('SELECT status FROM tables WHERE id = $1', [azul.id]);
    expect(rows[0].status).toBe('available');
  });

  it('rechaza transiciones inválidas', async () => {
    const { body } = await book();
    const res = await setStatus(body.reservation.id, 'completed', hostess);
    expect(res.status).toBe(409);
  });

  it('el bartender no puede mover reservaciones', async () => {
    const { body } = await book();
    const res = await setStatus(body.reservation.id, 'confirmed', bartender);
    expect(res.status).toBe(403);
  });
});

describe('Cancelación y reembolso', () => {
  const cancel = (id, user) => api().post(url(`/reservations/${id}/cancel`)).set(auth(user)).send({});

  async function markDepositPaid(reservationId) {
    await pool.query(
      `UPDATE transactions SET status = 'paid' WHERE reference_id = $1`, [reservationId]);
  }

  it('reembolsa 100% con más de 48 horas de antelación', async () => {
    const { body } = await book();
    await markDepositPaid(body.reservation.id);

    const res = await cancel(body.reservation.id, guest);
    expect(res.body.refund_pct).toBe(100);
    expect(res.body.refund_amount).toBe(1350);
  });

  it('reembolsa 50% entre 24 y 48 horas', async () => {
    const pronto = (await makeEvent({ hoursAhead: 30, name: 'Pasado mañana' })).body.event;
    const { body } = await book({ event_id: pronto.id });
    await markDepositPaid(body.reservation.id);

    const res = await cancel(body.reservation.id, guest);
    expect(res.body.refund_pct).toBe(50);
    expect(res.body.refund_amount).toBe(675);
  });

  it('no reembolsa con menos de 24 horas', async () => {
    const hoy = (await makeEvent({ hoursAhead: 5, name: 'Esta noche' })).body.event;
    const { body } = await book({ event_id: hoy.id });
    await markDepositPaid(body.reservation.id);

    const res = await cancel(body.reservation.id, guest);
    expect(res.body.refund_pct).toBe(0);
    expect(res.body.refund_amount).toBe(0);
  });

  it('solo reembolsa lo efectivamente cobrado', async () => {
    const { body } = await book(); // el depósito queda 'pending'
    const res = await cancel(body.reservation.id, guest);
    expect(res.body.paid_amount).toBe(0);
    expect(res.body.refund_amount).toBe(0);
  });

  it('cancela el depósito no cobrado y crea el asiento de reembolso cuando corresponde', async () => {
    const { body } = await book();
    await markDepositPaid(body.reservation.id);
    await cancel(body.reservation.id, guest);

    const { rows } = await pool.query(
      `SELECT type, status, amount FROM transactions ORDER BY created_at`);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ type: 'refund', status: 'pending', amount: '1350.00' });
  });

  it('el titular y el personal pueden cancelar; un tercero no', async () => {
    const a = await book();
    expect((await cancel(a.body.reservation.id, guest)).status).toBe(200);

    const b = await book({ table_id: roja.id, guest_count: 8 });
    expect((await cancel(b.body.reservation.id, hostess)).status).toBe(200);

    const c = await book();
    expect((await cancel(c.body.reservation.id, other)).status).toBe(403);
  });

  it('no se puede cancelar una reservación ya completada', async () => {
    const { body } = await book();
    for (const status of ['confirmed', 'seated', 'completed']) {
      await api().post(url(`/reservations/${body.reservation.id}/status`))
        .set(auth(hostess)).send({ status });
    }
    const res = await cancel(body.reservation.id, guest);
    expect(res.status).toBe(409);
  });
});

describe('Consultas', () => {
  it('cada quien ve sus reservaciones', async () => {
    await book();
    const mine = await api().get(url('/reservations/mine')).set(auth(guest));
    const theirs = await api().get(url('/reservations/mine')).set(auth(other));
    expect(mine.body.reservations).toHaveLength(1);
    expect(theirs.body.reservations).toHaveLength(0);
  });

  it('el personal ve la agenda del día; un cliente no', async () => {
    const { body } = await book();
    const date = body.reservation.starts_at.slice(0, 10);

    const staff = await api().get(url(`/reservations?date=${date}`)).set(auth(hostess));
    expect(staff.status).toBe(200);
    expect(staff.body.reservations.length).toBeGreaterThanOrEqual(1);

    const asGuest = await api().get(url('/reservations')).set(auth(guest));
    expect(asGuest.status).toBe(403);
  });

  it('un tercero no puede leer una reservación ajena', async () => {
    const { body } = await book();
    const res = await api().get(url(`/reservations/${body.reservation.id}`)).set(auth(other));
    expect(res.status).toBe(403);
  });
});

describe('Métodos de pago', () => {
  it('guarda un método sin exponer el token', async () => {
    const create = await api().post('/api/me/payment-methods').set(auth(guest)).send({
      provider: 'stripe', type: 'card', provider_token: 'pm_secreto', last4: '4242', brand: 'visa',
    });
    expect(create.status).toBe(201);
    expect(JSON.stringify(create.body)).not.toContain('pm_secreto');

    const list = await api().get('/api/me/payment-methods').set(auth(guest));
    expect(JSON.stringify(list.body)).not.toContain('pm_secreto');
    expect(list.body.payment_methods[0].last4).toBe('4242');
  });

  it('exige token del proveedor salvo en pagos manuales', async () => {
    const sinToken = await api().post('/api/me/payment-methods').set(auth(guest))
      .send({ provider: 'stripe', type: 'card' });
    expect(sinToken.status).toBe(400);

    const manual = await api().post('/api/me/payment-methods').set(auth(guest))
      .send({ provider: 'manual', type: 'zelle', label: 'Zelle personal' });
    expect(manual.status).toBe(201);
  });

  it('solo puede haber un método predeterminado', async () => {
    await api().post('/api/me/payment-methods').set(auth(guest))
      .send({ provider: 'stripe', type: 'card', provider_token: 'a', is_default: true });
    await api().post('/api/me/payment-methods').set(auth(guest))
      .send({ provider: 'stripe', type: 'card', provider_token: 'b', is_default: true });

    const { rows } = await pool.query(
      'SELECT count(*)::int AS n FROM payment_methods WHERE user_id = $1 AND is_default', [guest.id]);
    expect(rows[0].n).toBe(1);
  });

  it('no permite borrar el método de otra persona', async () => {
    const create = await api().post('/api/me/payment-methods').set(auth(guest))
      .send({ provider: 'manual', type: 'cash_app' });
    const res = await api().delete(`/api/me/payment-methods/${create.body.payment_method.id}`)
      .set(auth(other));
    expect(res.status).toBe(404);
  });
});
