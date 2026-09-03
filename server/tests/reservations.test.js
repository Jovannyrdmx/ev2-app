'use strict';

const { randomUUID } = require('crypto');
const { setupSchema, truncateAll, closePool, pool } = require('./helpers/db');
const { api, auth } = require('./helpers/api');
const f = require('./helpers/factories');

let club; let guest; let other; let hostess; let manager; let bartender; let vip; let small;

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
  vip = await f.createTable(club.id, { code: 'VIP-1', capacity: 8, type: 'vip', section: 'vip' });
  small = await f.createTable(club.id, { code: 'T-1', capacity: 2, type: 'standard' });
  await f.createReservationRules(club.id, { base_price_per_hour: 500, deposit_pct: 30, max_party_size: 12 });
});

const url = (p) => `/api/nightclubs/${club.id}${p}`;
const inDays = (d) => f.hoursFromNow(d * 24);

const book = (over = {}, user = guest) => api().post(url('/reservations')).set(auth(user)).send({
  client_request_id: randomUUID(),
  table_id: vip.id,
  starts_at: inDays(7),
  duration_minutes: 180,
  guest_count: 6,
  ...over,
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
  it('muestra las mesas con capacidad suficiente y su precio', async () => {
    const res = await api().get(url(`/reservations/availability?starts_at=${inDays(7)}&guests=6`))
      .set(auth(guest));
    expect(res.status).toBe(200);
    expect(res.body.tables).toHaveLength(1); // solo la VIP tiene capacidad 8
    expect(res.body.tables[0].price).toBe(1500); // 500/hora × 3 horas
    expect(res.body.tables[0].deposit).toBe(450); // 30%
  });

  it('excluye mesas bloqueadas', async () => {
    await pool.query(`UPDATE tables SET status = 'blocked' WHERE id = $1`, [vip.id]);
    const res = await api().get(url(`/reservations/availability?starts_at=${inDays(7)}&guests=6`))
      .set(auth(guest));
    expect(res.body.tables).toHaveLength(0);
  });

  it('aplica las reglas de precio dinámico', async () => {
    await pool.query(
      `INSERT INTO pricing_rules (nightclub_id, name, applies_to, target, adjustment_type, value, priority)
       VALUES ($1, 'VIP doble', 'table_type', 'vip', 'multiplier', 2, 10)`, [club.id]);
    const res = await api().post(url('/reservations/quote')).set(auth(guest))
      .send({ table_id: vip.id, starts_at: inDays(7) });

    expect(res.body.quote.table_price).toBe(3000);
    expect(res.body.quote.price_rules_applied[0].name).toBe('VIP doble');
  });

  it('suma extras y aplica descuento porcentual', async () => {
    await pool.query(
      `INSERT INTO reservation_discounts (nightclub_id, code, discount_type, discount_value)
       VALUES ($1,'PROMO10','percentage',10)`, [club.id]);

    const res = await api().post(url('/reservations/quote')).set(auth(guest)).send({
      table_id: vip.id,
      starts_at: inDays(7),
      addons: [{ type: 'bottle_service', name: 'Botella', price: 1800, quantity: 1 }],
      discount_code: 'PROMO10',
    });

    const q = res.body.quote;
    expect(q.table_price).toBe(1500);
    expect(q.addons_total).toBe(1800);
    expect(q.discount.amount).toBe(330); // 10% de 3300
    expect(q.total).toBe(2970);
    expect(q.deposit).toBe(891); // 30% de 2970
  });

  it('aplica descuento de monto fijo', async () => {
    await pool.query(
      `INSERT INTO reservation_discounts (nightclub_id, code, discount_type, discount_value)
       VALUES ($1,'MENOS500','fixed_amount',500)`, [club.id]);
    const res = await api().post(url('/reservations/quote')).set(auth(guest))
      .send({ table_id: vip.id, starts_at: inDays(7), discount_code: 'MENOS500' });
    expect(res.body.quote.total).toBe(1000);
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
        .send({ table_id: vip.id, starts_at: inDays(7), discount_code: code });
      expect(res.status).toBe(422);
    }
  });

  it('rechaza grupos fuera de las reglas del club', async () => {
    const res = await api().get(url(`/reservations/availability?starts_at=${inDays(7)}&guests=13`))
      .set(auth(guest));
    expect(res.status).toBe(422);
  });

  it('exige la anticipación mínima', async () => {
    const res = await api().get(url(`/reservations/availability?starts_at=${f.hoursFromNow(1)}&guests=4`))
      .set(auth(guest));
    expect(res.status).toBe(422);
  });
});

describe('Reserva', () => {
  it('crea la reservación con el depósito calculado en el servidor', async () => {
    const res = await book();
    expect(res.status).toBe(201);
    expect(res.body.reservation.status).toBe('pending_payment');
    expect(res.body.reservation.total_estimated).toBe('1500.00');
    expect(res.body.reservation.deposit_amount).toBe('450.00');
    expect(res.body.payment.status).toBe('pending');
  });

  it('calcula ends_at a partir de la duración', async () => {
    const res = await book({ duration_minutes: 120 });
    const { starts_at: start, ends_at: end } = res.body.reservation;
    expect(new Date(end) - new Date(start)).toBe(120 * 60_000);
  });

  it('registra el depósito en el libro contable como pendiente', async () => {
    await book();
    const { rows } = await pool.query('SELECT type, amount, status, direction FROM transactions');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: 'reservation_deposit', amount: '450.00', status: 'pending', direction: 'in',
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

  it('impide dos reservaciones que se solapan en la misma mesa', async () => {
    const start = inDays(7);
    await book({ starts_at: start, duration_minutes: 180 });

    const overlapping = new Date(new Date(start).getTime() + 60 * 60_000).toISOString();
    const res = await book({ starts_at: overlapping, duration_minutes: 120 }, other);
    expect(res.status).toBe(409);
  });

  it('permite reservar la misma mesa en horarios contiguos', async () => {
    const start = inDays(7);
    await book({ starts_at: start, duration_minutes: 120 });
    const next = new Date(new Date(start).getTime() + 120 * 60_000).toISOString();
    const res = await book({ starts_at: next, duration_minutes: 120 }, other);
    expect(res.status).toBe(201);
  });

  it('vuelve a liberar el horario si la reservación se cancela', async () => {
    const start = inDays(7);
    const first = await book({ starts_at: start });
    await api().post(url(`/reservations/${first.body.reservation.id}/cancel`)).set(auth(guest)).send({});

    const res = await book({ starts_at: start }, other);
    expect(res.status).toBe(201);
  });

  it('rechaza más personas de las que caben en la mesa', async () => {
    const res = await book({ table_id: small.id, guest_count: 6 });
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/seats 2/);
  });

  it('rechaza grupos fuera de las reglas', async () => {
    const res = await book({ guest_count: 13 });
    expect(res.status).toBe(422);
  });

  it('rechaza sin la anticipación mínima', async () => {
    const res = await book({ starts_at: f.hoursFromNow(1) });
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
    let { rows } = await pool.query('SELECT status FROM tables WHERE id = $1', [vip.id]);
    expect(rows[0].status).toBe('reserved');

    await setStatus(body.reservation.id, 'seated', hostess);
    ({ rows } = await pool.query('SELECT status FROM tables WHERE id = $1', [vip.id]));
    expect(rows[0].status).toBe('occupied');

    await setStatus(body.reservation.id, 'completed', hostess);
    ({ rows } = await pool.query('SELECT status FROM tables WHERE id = $1', [vip.id]));
    expect(rows[0].status).toBe('available');
  });

  it('libera la mesa si el cliente no llega', async () => {
    const { body } = await book();
    await setStatus(body.reservation.id, 'confirmed', hostess);
    await setStatus(body.reservation.id, 'no_show', hostess);
    const { rows } = await pool.query('SELECT status FROM tables WHERE id = $1', [vip.id]);
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
    const { body } = await book({ starts_at: inDays(7) });
    await markDepositPaid(body.reservation.id);

    const res = await cancel(body.reservation.id, guest);
    expect(res.body.refund_pct).toBe(100);
    expect(res.body.refund_amount).toBe(450);
  });

  it('reembolsa 50% entre 24 y 48 horas', async () => {
    const { body } = await book({ starts_at: f.hoursFromNow(30) });
    await markDepositPaid(body.reservation.id);

    const res = await cancel(body.reservation.id, guest);
    expect(res.body.refund_pct).toBe(50);
    expect(res.body.refund_amount).toBe(225);
  });

  it('no reembolsa con menos de 24 horas', async () => {
    const { body } = await book({ starts_at: f.hoursFromNow(5) });
    await markDepositPaid(body.reservation.id);

    const res = await cancel(body.reservation.id, guest);
    expect(res.body.refund_pct).toBe(0);
    expect(res.body.refund_amount).toBe(0);
  });

  it('solo reembolsa lo efectivamente cobrado', async () => {
    const { body } = await book({ starts_at: inDays(7) }); // depósito queda 'pending'
    const res = await cancel(body.reservation.id, guest);
    expect(res.body.paid_amount).toBe(0);
    expect(res.body.refund_amount).toBe(0);
  });

  it('cancela el depósito no cobrado y crea el asiento de reembolso cuando corresponde', async () => {
    const { body } = await book({ starts_at: inDays(7) });
    await markDepositPaid(body.reservation.id);
    await cancel(body.reservation.id, guest);

    const { rows } = await pool.query(
      `SELECT type, status, amount FROM transactions ORDER BY created_at`);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ type: 'refund', status: 'pending', amount: '450.00' });
  });

  it('el titular y el personal pueden cancelar; un tercero no', async () => {
    const a = await book({ starts_at: inDays(7) });
    expect((await cancel(a.body.reservation.id, guest)).status).toBe(200);

    const b = await book({ starts_at: inDays(8) });
    expect((await cancel(b.body.reservation.id, hostess)).status).toBe(200);

    const c = await book({ starts_at: inDays(9) });
    expect((await cancel(c.body.reservation.id, other)).status).toBe(403);
  });

  it('no se puede cancelar una reservación ya completada', async () => {
    const { body } = await book();
    await api().post(url(`/reservations/${body.reservation.id}/status`))
      .set(auth(hostess)).send({ status: 'confirmed' });
    await api().post(url(`/reservations/${body.reservation.id}/status`))
      .set(auth(hostess)).send({ status: 'seated' });
    await api().post(url(`/reservations/${body.reservation.id}/status`))
      .set(auth(hostess)).send({ status: 'completed' });

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
