'use strict';

// Pagos manuales (D28): efectivo, Zelle, Cash App, transferencia y SPEI. Nada de esto
// cobra: es una declaración, y solo el gerente la vuelve un pago del libro contable.

const { setupSchema, truncateAll, closePool, pool } = require('./helpers/db');
const { api, auth } = require('./helpers/api');
const f = require('./helpers/factories');

let club; let otherClub; let manager; let hostess; let guest; let otherGuest; let otherManager;

beforeAll(setupSchema);
afterAll(closePool);

beforeEach(async () => {
  await truncateAll();
  club = await f.createNightclub({ slug: 'ev2-pay' });
  otherClub = await f.createNightclub({ name: 'Otro', slug: 'otro-pay' });
  manager = await f.createUser(club.id, { role: 'manager' });
  hostess = await f.createUser(club.id, { role: 'hostess' });
  guest = await f.createUser(club.id, { role: 'guest', display_name: 'Ana' });
  otherGuest = await f.createUser(club.id, { role: 'guest', display_name: 'Sofía' });
  otherManager = await f.createUser(otherClub.id, { role: 'manager' });
});

const url = (p) => `/api/nightclubs/${club.id}${p}`;

/** A pending charge in the ledger, which is what a manual payment settles. */
async function charge({ user = guest, amount = 1500, type = 'reservation_deposit',
  referenceType = null, referenceId = null, currency = 'MXN' } = {}) {
  const { rows } = await pool.query(
    `INSERT INTO transactions (nightclub_id, type, direction, amount, currency, status,
                               payer_user_id, provider, reference_type, reference_id)
     VALUES ($1,$2,'in',$3,$4,'pending',$5,'manual',$6,$7)
     RETURNING id, amount::text AS amount, currency, status`,
    [club.id, type, amount, currency, user.id, referenceType, referenceId]);
  return rows[0];
}

const addOption = (over = {}, as = manager) => api().post(url('/manual-payment-options'))
  .set(auth(as)).send({ method: 'zelle', label: 'Zelle tesorería', destination: 'pagos@ev2.mx', ...over });

const declare = (tx, over = {}, as = guest) => api().post(url('/manual-payments')).set(auth(as))
  .send({
    transaction_id: tx.id, method: 'zelle', amount: Number(tx.amount), currency: tx.currency,
    reference: `ZEL-${Math.random().toString(36).slice(2, 8).toUpperCase()}`, ...over,
  });

const txStatus = async (id) => (await pool.query('SELECT status, provider, confirmed_by FROM transactions WHERE id = $1', [id])).rows[0];

// ---------------------------------------------------------------- dónde pagar

describe('Formas de pago del club', () => {
  it('el gerente carga una forma de pago y el cliente ve a dónde mandar el dinero', async () => {
    const res = await addOption({ instructions: 'Pon tu nombre en el concepto' });
    expect(res.status).toBe(201);
    expect(res.body.option).toMatchObject({
      method: 'zelle', destination: 'pagos@ev2.mx', requires_reference: true, active: true,
    });

    const asGuest = await api().get(url('/manual-payment-options')).set(auth(guest));
    expect(asGuest.body.options).toHaveLength(1);
    expect(asGuest.body.options[0].instructions).toMatch(/concepto/);
  });

  it('una transferencia sin destino no es una forma de pago; el efectivo sí', async () => {
    expect((await addOption({ destination: null })).status).toBe(422);
    const cash = await addOption({ method: 'cash', label: 'Efectivo en la puerta', destination: null });
    expect(cash.status).toBe(201);
    // El efectivo no pide folio porque se entrega en mano.
    expect(cash.body.option.requires_reference).toBe(false);
  });

  it('solo el gerente las administra y el nombre repetido responde 409', async () => {
    await addOption();
    expect((await addOption()).status).toBe(409);
    expect((await addOption({}, guest)).status).toBe(403);
    expect((await addOption({}, hostess)).status).toBe(403);
  });

  it('retirar una forma de pago la esconde del cliente pero no la borra', async () => {
    const created = await addOption();
    await api().delete(url(`/manual-payment-options/${created.body.option.id}`)).set(auth(manager));
    expect((await api().get(url('/manual-payment-options')).set(auth(guest))).body.options).toHaveLength(0);
    const asManager = await api().get(url('/manual-payment-options?include_inactive=true')).set(auth(manager));
    expect(asManager.body.options).toHaveLength(1);
  });
});

// ---------------------------------------------------------------- declarar

describe('El cliente declara que ya pagó', () => {
  it('la declaración no cobra nada: deja el asiento a la espera de revisión', async () => {
    const tx = await charge();
    const res = await declare(tx);
    expect(res.status).toBe(201);
    expect(res.body.payment).toMatchObject({ status: 'declared', method: 'zelle', amount: '1500.00' });
    // Lo importante: el libro NO dice pagado.
    expect((await txStatus(tx.id)).status).toBe('pending_manual');
    // Y el cliente no ve quién lo va a revisar ni el detalle interno del asiento.
    expect(res.body.payment).not.toHaveProperty('reviewed_by');
    expect(res.body.payment).not.toHaveProperty('transaction');
  });

  it('una transferencia sin folio no se acepta, en efectivo sí', async () => {
    const tx = await charge();
    expect((await declare(tx, { reference: undefined })).status).toBe(422);
    const cash = await charge({ amount: 300 });
    const ok = await declare(cash, { method: 'cash', reference: undefined, amount: 300 });
    expect(ok.status).toBe(201);
  });

  it('no se puede declarar el cobro de otra persona', async () => {
    const tx = await charge({ user: otherGuest });
    expect((await declare(tx)).status).toBe(404);
  });

  it('un cobro ya pagado o cancelado no admite pago', async () => {
    const tx = await charge();
    await pool.query("UPDATE transactions SET status = 'paid' WHERE id = $1", [tx.id]);
    expect((await declare(tx)).status).toBe(409);

    const cancelled = await charge();
    await pool.query("UPDATE transactions SET status = 'cancelled' WHERE id = $1", [cancelled.id]);
    expect((await declare(cancelled)).status).toBe(409);
  });

  it('dos declaraciones abiertas para el mismo cobro: la segunda es conflicto', async () => {
    const tx = await charge();
    expect((await declare(tx)).status).toBe(201);
    expect((await declare(tx)).status).toBe(409);
  });

  it('la misma referencia no puede pagar dos cosas distintas', async () => {
    const a = await charge();
    const b = await charge({ amount: 900 });
    await declare(a, { reference: 'ZEL-99887' });
    const reused = await declare(b, { reference: 'zel-99887', amount: 900 });
    expect(reused.status).toBe(409);
    expect(reused.body.error.message).toMatch(/referencia/i);
  });

  it('la misma clave de idempotencia no crea dos declaraciones', async () => {
    const tx = await charge();
    const key = '33333333-3333-4333-8333-333333333333';
    const first = await declare(tx, { client_request_id: key, reference: 'ZEL-1' });
    const second = await declare(tx, { client_request_id: key, reference: 'ZEL-1' });
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ idempotent: true });
    expect(second.body.payment.id).toBe(first.body.payment.id);
  });

  it('el cliente puede retirar su declaración y volver a declarar', async () => {
    const tx = await charge();
    const declared = await declare(tx);
    const cancelled = await api()
      .post(url(`/manual-payments/${declared.body.payment.id}/cancel`)).set(auth(guest));
    expect(cancelled.body.payment.status).toBe('cancelled');
    // El cobro vuelve a estar disponible.
    expect((await txStatus(tx.id)).status).toBe('pending');
    expect((await declare(tx)).status).toBe(201);
  });
});

// ---------------------------------------------------------------- confirmar

describe('El gerente confirma contra el estado de cuenta', () => {
  it('confirmar es lo único que mueve el libro a pagado', async () => {
    const tx = await charge();
    const declared = await declare(tx);
    expect((await txStatus(tx.id)).status).toBe('pending_manual');

    const res = await api().post(url(`/manual-payments/${declared.body.payment.id}/confirm`))
      .set(auth(manager));
    expect(res.status).toBe(200);
    expect(res.body.payment.status).toBe('confirmed');

    const after = await txStatus(tx.id);
    expect(after).toMatchObject({ status: 'paid', provider: 'manual', confirmed_by: manager.id });
  });

  it('confirmar el depósito confirma la reservación, que es lo que le importa al cliente', async () => {
    await f.createReservationRules(club.id);
    const table = await f.createTable(club.id);
    const { rows } = await pool.query(
      `INSERT INTO reservations (nightclub_id, user_id, table_id, guest_count, status, currency,
                                 total_estimated, deposit_amount, starts_at, duration_minutes)
       VALUES ($1,$2,$3,4,'pending_payment','MXN',5000,1500, now() + interval '3 hours', 180)
       RETURNING id`,
      [club.id, guest.id, table.id]);
    const reservationId = rows[0].id;
    const tx = await charge({ referenceType: 'reservation', referenceId: reservationId });

    const declared = await declare(tx);
    const res = await api().post(url(`/manual-payments/${declared.body.payment.id}/confirm`))
      .set(auth(manager));
    expect(res.body.reservation_confirmed).toBe(reservationId);

    const r = await pool.query('SELECT status FROM reservations WHERE id = $1', [reservationId]);
    expect(r.rows[0].status).toBe('confirmed');
    const evts = await pool.query(
      `SELECT type FROM events WHERE nightclub_id = $1 ORDER BY id`, [club.id]);
    expect(evts.rows.map((e) => e.type)).toEqual(
      expect.arrayContaining(['payment_confirmed', 'reservation_confirmed']));
  });

  it('un monto distinto al del cobro no se confirma: se rechaza indicando la diferencia', async () => {
    const tx = await charge({ amount: 1500 });
    const declared = await declare(tx, { amount: 1200 });
    const res = await api().post(url(`/manual-payments/${declared.body.payment.id}/confirm`))
      .set(auth(manager));
    expect(res.status).toBe(422);
    expect(res.body.error.details).toMatchObject({ declared: '1200.00', expected: '1500.00' });
    // El libro sigue sin tocarse.
    expect((await txStatus(tx.id)).status).toBe('pending_manual');
  });

  it('confirmar dos veces no acredita dos veces', async () => {
    const tx = await charge();
    const declared = await declare(tx);
    const id = declared.body.payment.id;
    expect((await api().post(url(`/manual-payments/${id}/confirm`)).set(auth(manager))).status).toBe(200);
    const again = await api().post(url(`/manual-payments/${id}/confirm`)).set(auth(manager));
    expect(again.status).toBe(409);
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM manual_payments WHERE transaction_id = $1 AND status = 'confirmed'`,
      [tx.id]);
    expect(rows[0].n).toBe(1);
  });

  it('rechazar devuelve el cobro a pendiente y avisa al cliente con el motivo', async () => {
    const tx = await charge();
    const declared = await declare(tx);
    const res = await api().post(url(`/manual-payments/${declared.body.payment.id}/reject`))
      .set(auth(manager)).send({ reason: 'No aparece en el estado de cuenta' });
    expect(res.status).toBe(200);
    expect(res.body.payment).toMatchObject({
      status: 'rejected', rejection_reason: 'No aparece en el estado de cuenta',
    });
    expect((await txStatus(tx.id)).status).toBe('pending');

    const evts = await pool.query(`SELECT audience, payload FROM events WHERE type = 'payment_rejected'`);
    expect(evts.rows[0].audience.userIds).toEqual([guest.id]);
    expect(evts.rows[0].payload.reason).toMatch(/estado de cuenta/);

    // Y el cliente puede corregir el folio y volver a declarar.
    expect((await declare(tx)).status).toBe(201);
  });

  it('rechazar exige un motivo de verdad', async () => {
    const tx = await charge();
    const declared = await declare(tx);
    const res = await api().post(url(`/manual-payments/${declared.body.payment.id}/reject`))
      .set(auth(manager)).send({ reason: 'no' });
    expect(res.status).toBe(400);
  });

  it('ni el cliente ni la anfitriona confirman pagos', async () => {
    const tx = await charge();
    const declared = await declare(tx);
    const id = declared.body.payment.id;
    expect((await api().post(url(`/manual-payments/${id}/confirm`)).set(auth(guest))).status).toBe(403);
    expect((await api().post(url(`/manual-payments/${id}/confirm`)).set(auth(hostess))).status).toBe(403);
    expect((await api().get(url('/manual-payments')).set(auth(guest))).status).toBe(403);
  });
});

// ---------------------------------------------------------------- efectivo en la puerta

describe('Efectivo recibido en la puerta', () => {
  it('la anfitriona lo registra y queda pagado en un solo paso, con su nombre', async () => {
    const tx = await charge({ amount: 800 });
    const res = await api().post(url('/manual-payments/register')).set(auth(hostess)).send({
      transaction_id: tx.id, method: 'cash', amount: 800, currency: 'MXN',
      on_behalf_of: guest.id, note: 'Pagó en la entrada',
    });
    expect(res.status).toBe(201);
    expect(res.body.payment).toMatchObject({ status: 'confirmed', method: 'cash' });
    // Queda quién tomó el dinero y de parte de quién: no hay segunda persona que verifique.
    expect(res.body.payment.declared_by.id).toBe(hostess.id);
    expect(res.body.payment.on_behalf_of.id).toBe(guest.id);

    const after = await txStatus(tx.id);
    expect(after).toMatchObject({ status: 'paid', provider: 'cash', confirmed_by: hostess.id });
  });

  it('el mismo cobro no se registra dos veces', async () => {
    const tx = await charge({ amount: 800 });
    const body = { transaction_id: tx.id, method: 'cash', amount: 800, currency: 'MXN' };
    expect((await api().post(url('/manual-payments/register')).set(auth(hostess)).send(body)).status)
      .toBe(201);
    expect((await api().post(url('/manual-payments/register')).set(auth(hostess)).send(body)).status)
      .toBe(409);
  });

  it('un cliente no puede registrar su propio pago como recibido', async () => {
    const tx = await charge({ amount: 800 });
    const res = await api().post(url('/manual-payments/register')).set(auth(guest))
      .send({ transaction_id: tx.id, method: 'cash', amount: 800, currency: 'MXN' });
    expect(res.status).toBe(403);
  });

  it('una transferencia registrada por el personal sigue necesitando folio', async () => {
    const tx = await charge({ amount: 800 });
    const res = await api().post(url('/manual-payments/register')).set(auth(hostess))
      .send({ transaction_id: tx.id, method: 'spei', amount: 800, currency: 'MXN' });
    expect(res.status).toBe(422);
  });
});

// ---------------------------------------------------------------- aislamiento

describe('Aislamiento entre clubes y visibilidad', () => {
  it('un pago de este club no lo ve ni lo toca el gerente de otro', async () => {
    const tx = await charge();
    const declared = await declare(tx);
    const id = declared.body.payment.id;
    expect((await api().get(url('/manual-payments')).set(auth(otherManager))).status).toBe(403);
    const cross = await api().post(`/api/nightclubs/${otherClub.id}/manual-payments/${id}/confirm`)
      .set(auth(otherManager));
    expect(cross.status).toBe(404);
  });

  it('la cola del gerente resume lo que falta por revisar', async () => {
    const a = await charge({ amount: 1000 });
    const b = await charge({ amount: 500, user: otherGuest });
    await declare(a, { reference: 'ZEL-A' });
    await declare(b, { reference: 'ZEL-B', amount: 500 }, otherGuest);

    const queue = await api().get(url('/manual-payments')).set(auth(manager));
    expect(queue.body.payments).toHaveLength(2);
    expect(queue.body.awaiting_review).toEqual([{ currency: 'MXN', count: 2, total: '1500.00' }]);
    // El gerente sí ve quién declaró y contra qué asiento.
    expect(queue.body.payments[0].declared_by).toHaveProperty('name');
    expect(queue.body.payments[0].transaction).toHaveProperty('amount');
  });

  it('cada quien ve solo sus declaraciones', async () => {
    const a = await charge();
    await declare(a);
    const mine = await api().get(url('/manual-payments/mine')).set(auth(guest));
    expect(mine.body.payments).toHaveLength(1);
    expect((await api().get(url('/manual-payments/mine')).set(auth(otherGuest))).body.payments)
      .toHaveLength(0);
  });
});
