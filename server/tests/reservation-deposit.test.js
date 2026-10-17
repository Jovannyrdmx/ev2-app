/**
 * El anticipo por transferencia con su comprobante, y el resto en la puerta (D113).
 *
 * Lo que se prueba es lo que pasa una noche real:
 *
 *   * el cliente ve a qué cuenta transferir y cuánto, y sube la foto;
 *   * solo él puede subirla, y una foto que no es foto se rechaza;
 *   * la anfitriona y el gerente la ven y la aprueban; un mesero no;
 *   * aprobarla confirma la reservación y le da el crédito de consumo;
 *   * en la puerta, una mesa con resto pendiente NO entra y el pase no se gasta;
 *   * el resto se cobra en efectivo (con cambio) o en la terminal de Cover;
 *   * lo pagado de resto también suma al crédito, y el pase ya abre.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');
const { setupSchema, truncateAll, closePool, pool } = require('./helpers/db');
const { api, auth } = require('./helpers/api');
const f = require('./helpers/factories');
const gp = require('../src/services/guest-passes');
const door = require('../src/services/door');
const mp = require('../src/services/mercadopago');
const terminalCharges = require('../src/services/terminal-charges');

let club; let guest; let otro; let hostess; let manager; let waiter; let mesa; let night;
let cuenta; let tmpDir;

// Un JPG de verdad (los primeros bytes son los que se revisan) y un "archivo" que no lo es.
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7)]);
const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(200, 32)]);
const HTML = Buffer.from('<html><script>alert(1)</script></html>');

beforeAll(async () => {
  await setupSchema();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ev2-proofs-'));
  process.env.RECEIPTS_DIR = tmpDir;
});
afterAll(async () => {
  await closePool();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const url = (p) => `/api/nightclubs/${club.id}${p}`;

beforeEach(async () => {
  await truncateAll();
  club = await f.createNightclub({ slug: 'ev2-anticipo' });
  guest = await f.createUser(club.id, { role: 'guest', display_name: 'Ana Cliente' });
  otro = await f.createUser(club.id, { role: 'guest', display_name: 'Otro' });
  hostess = await f.createUser(club.id, { role: 'hostess', display_name: 'Recepción' });
  manager = await f.createUser(club.id, { role: 'manager', display_name: 'Gerente' });
  // Desde D118 en la puerta cobra la anfitriona con la caja de Cover abierta.
  await f.openDoorTill(club.id, { hostess, authorizer: manager });
  waiter = await f.createUser(club.id, { role: 'waiter', display_name: 'Mesero' });
  mesa = await f.createTable(club.id, { code: 'V-7', section: 'VIP ELEVADO', capacity: 8 });
  const ev = await pool.query(
    `INSERT INTO events_calendar (nightclub_id, name, event_date, doors_open_at, ticket_price, status)
     VALUES ($1,'Sábado',(now() - interval '1 hour')::date, now() - interval '1 hour', 0, 'published')
     RETURNING id`, [club.id]);
  night = ev.rows[0];
  const op = await api().post(url('/manual-payment-options')).set(auth(manager)).send({
    method: 'spei', label: 'BBVA EV2', destination: '012345678901234567',
    instructions: 'Beneficiario: EV2 Clandestinoz. Pon tu nombre en el concepto.',
  });
  expect(op.status).toBe(201);
  cuenta = op.body.option;
});

/** Una reservación de $4,000 con anticipo de $1,200, sin pagar, con sus pases. */
async function reservar(over = {}) {
  const { rows } = await pool.query(
    `INSERT INTO reservations (nightclub_id, user_id, table_id, event_id, starts_at, duration_minutes,
                               guest_count, status, currency, total_estimated, deposit_amount, pass_code)
     VALUES ($1,$2,$3,$4, now() + interval '20 minutes', 240, 4, 'pending_payment', 'MXN', $5, $6, $7)
     RETURNING id, nightclub_id, pass_code, status, guest_count`,
    [club.id, guest.id, mesa.id, night.id, over.total ?? 4000, over.deposit ?? 1200,
      door.generatePassCode()]);
  await pool.query(
    `INSERT INTO transactions (nightclub_id, type, direction, amount, currency, status, payer_user_id,
                               provider, reference_type, reference_id)
     VALUES ($1,'reservation_deposit','in',$2,'MXN','pending',$3,'manual','reservation',$4)`,
    [club.id, over.deposit ?? 1200, guest.id, rows[0].id]);
  await gp.issueForReservation(pool, { reservation: rows[0], actorId: guest.id });
  return rows[0];
}

const subir = (reservationId, quien = guest, archivo = JPG, campos = { option_id: null }) => {
  let req = api().post(url(`/reservations/${reservationId}/deposit-proof`)).set(auth(quien));
  const opt = campos.option_id === null ? cuenta.id : campos.option_id;
  if (opt) req = req.field('option_id', opt);
  if (campos.reference) req = req.field('reference', campos.reference);
  return req.attach('photo', archivo, { filename: 'comprobante.jpg', contentType: 'image/jpeg' });
};

const estadoReserva = async (id) => (await pool.query(
  'SELECT status FROM reservations WHERE id = $1', [id])).rows[0].status;
const credito = async () => (await pool.query(
  'SELECT granted::text AS granted, spent::text AS spent FROM reservation_credits')).rows[0];

async function entrar(code, staff = hostess) {
  const rev = await api().post(url('/door/id-checks')).set(auth(staff))
    .send({ document: 'ine', adult: true, decision: 'accepted' });
  return api().post(url('/door/check-in')).set(auth(staff))
    .send({ code, id_check_id: rev.body.id_check.id });
}

async function aprobarAnticipo(r, quien = hostess) {
  const s = await subir(r.id);
  expect(s.status).toBe(201);
  const ok = await api().post(url(`/manual-payments/${s.body.payment.id}/confirm`)).set(auth(quien));
  expect(ok.status).toBe(200);
  return s.body.payment;
}

// ==========================================================================

describe('La página del anticipo', () => {
  it('le dice al cliente cuánto, a qué cuenta y cuánto falta', async () => {
    const r = await reservar();
    const res = await api().get(url(`/reservations/${r.id}/payment`)).set(auth(guest));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      total: '4000.00', deposit: '1200.00', paid: '0.00', due: '4000.00',
      deposit_status: 'pending', deposit_amount_due: '1200.00', last_proof: null, credit: null,
    });
    expect(res.body.options).toHaveLength(1);
    expect(res.body.options[0]).toMatchObject({ label: 'BBVA EV2', destination: '012345678901234567' });
  });

  it('la reservación de otro cliente no existe para éste', async () => {
    const r = await reservar();
    expect((await api().get(url(`/reservations/${r.id}/payment`)).set(auth(otro))).status).toBe(404);
    expect((await subir(r.id, otro)).status).toBe(404);
  });

  it('la cuenta de efectivo no se ofrece para transferir', async () => {
    await api().post(url('/manual-payment-options')).set(auth(manager))
      .send({ method: 'cash', label: 'En la puerta' });
    const r = await reservar();
    const res = await api().get(url(`/reservations/${r.id}/payment`)).set(auth(guest));
    expect(res.body.options.map((o) => o.method)).toEqual(['spei']);
  });
});

describe('Subir el comprobante', () => {
  it('queda en revisión, con la foto guardada fuera de la base y avisando a la puerta', async () => {
    const r = await reservar();
    const res = await subir(r.id);
    expect(res.status).toBe(201);
    expect(res.body.payment).toMatchObject({ status: 'declared', amount: '1200.00', method: 'spei' });
    expect(res.body.payment.proof).toMatchObject({ mime: 'image/jpeg' });
    // La ruta del disco no viaja.
    expect(JSON.stringify(res.body)).not.toMatch(/deposit-proofs|proof_path/);

    const tx = await pool.query(
      `SELECT status FROM transactions WHERE reference_id = $1 AND type = 'reservation_deposit'`, [r.id]);
    expect(tx.rows[0].status).toBe('pending_manual');
    const ev = await pool.query(`SELECT audience FROM events WHERE type = 'deposit_proof_received'`);
    expect(ev.rows[0].audience.roles).toEqual(['hostess', 'manager']);
    expect(await estadoReserva(r.id)).toBe('pending_payment');
  });

  it('acepta PDF y rechaza lo que no es foto aunque diga que lo es', async () => {
    const r = await reservar();
    const malo = await subir(r.id, guest, HTML);
    expect(malo.status).toBe(422);
    expect(malo.body.error.message).toMatch(/no es una foto ni un PDF/);
    const pdf = await subir(r.id, guest, PDF);
    expect(pdf.status).toBe(201);
    expect(pdf.body.payment.proof.mime).toBe('application/pdf');
  });

  it('sin escoger cuenta no se acepta, y un segundo comprobante espera al primero', async () => {
    const r = await reservar();
    const sin = await api().post(url(`/reservations/${r.id}/deposit-proof`)).set(auth(guest))
      .attach('photo', JPG, { filename: 'a.jpg', contentType: 'image/jpeg' });
    expect(sin.status).toBe(422);
    expect((await subir(r.id)).status).toBe(201);
    const otra = await subir(r.id);
    expect(otra.status).toBe(409);
    expect(otra.body.error.message).toMatch(/en revisión/);
  });

  it('el personal no sube comprobantes a nombre del cliente', async () => {
    const r = await reservar();
    expect((await subir(r.id, hostess)).status).toBe(403);
  });
});

describe('Revisar el comprobante', () => {
  it('la anfitriona ve la foto y la cola; el mesero y otro cliente no', async () => {
    const r = await reservar();
    const s = await subir(r.id);
    const id = s.body.payment.id;

    const foto = await api().get(url(`/manual-payments/${id}/proof`)).set(auth(hostess));
    expect(foto.status).toBe(200);
    expect(foto.headers['content-type']).toMatch(/image\/jpeg/);
    expect(foto.headers['cache-control']).toMatch(/no-store/);
    expect((await api().get(url(`/manual-payments/${id}/proof`)).set(auth(guest))).status).toBe(200);
    expect((await api().get(url(`/manual-payments/${id}/proof`)).set(auth(otro))).status).toBe(404);
    expect((await api().get(url(`/manual-payments/${id}/proof`)).set(auth(waiter))).status).toBe(404);

    const cola = await api().get(url('/deposit-reviews')).set(auth(hostess));
    expect(cola.status).toBe(200);
    expect(cola.body.reviews).toHaveLength(1);
    expect(cola.body.reviews[0].reservation).toMatchObject({ table_code: 'V-7', holder_name: 'Ana Cliente' });
    expect((await api().get(url('/deposit-reviews')).set(auth(waiter))).status).toBe(403);
  });

  it('aprobarlo confirma la reservación y le da el crédito de consumo', async () => {
    const r = await reservar();
    await aprobarAnticipo(r, hostess);
    expect(await estadoReserva(r.id)).toBe('confirmed');
    expect(await credito()).toMatchObject({ granted: '1200.00', spent: '0.00' });

    const pagina = await api().get(url(`/reservations/${r.id}/payment`)).set(auth(guest));
    expect(pagina.body).toMatchObject({ paid: '1200.00', due: '2800.00', deposit_status: 'paid' });
    expect(pagina.body.credit).toMatchObject({ available: '1200.00' });
  });

  it('rechazarlo explica por qué y deja subir otro', async () => {
    const r = await reservar();
    const s = await subir(r.id);
    const no = await api().post(url(`/manual-payments/${s.body.payment.id}/reject`)).set(auth(hostess))
      .send({ reason: 'No aparece en el banco' });
    expect(no.status).toBe(200);
    const pagina = await api().get(url(`/reservations/${r.id}/payment`)).set(auth(guest));
    expect(pagina.body.last_proof).toMatchObject({ status: 'rejected', rejection_reason: 'No aparece en el banco' });
    expect((await subir(r.id)).status).toBe(201);
  });

  it('la anfitriona solo aprueba anticipos: otro pago manual sigue siendo del gerente', async () => {
    const r = await reservar();
    const { rows } = await pool.query(
      `INSERT INTO transactions (nightclub_id, type, direction, amount, currency, status, payer_user_id,
                                 provider, reference_type, reference_id)
       VALUES ($1,'drink_order','in',300,'MXN','pending',$2,'manual','reservation',$3) RETURNING id`,
      [club.id, guest.id, r.id]);
    const dec = await api().post(url('/manual-payments')).set(auth(guest)).send({
      transaction_id: rows[0].id, method: 'spei', amount: 300, currency: 'MXN', reference: 'FOLIO-99',
    });
    expect(dec.status).toBe(201);
    const intento = await api().post(url(`/manual-payments/${dec.body.payment.id}/confirm`)).set(auth(hostess));
    expect(intento.status).toBe(403);
    expect((await api().post(url(`/manual-payments/${dec.body.payment.id}/confirm`)).set(auth(manager))).status)
      .toBe(200);
  });
});

describe('La puerta', () => {
  it('sin anticipo pagado avisa que hay un comprobante para revisar ahí mismo', async () => {
    const r = await reservar();
    const s = await subir(r.id);
    const res = await entrar(r.pass_code);
    expect(res.body.pass.result).toBe('unpaid');
    expect(res.body.deposit_review).toMatchObject({ payment_id: s.body.payment.id, has_proof: true });
  });

  it('con resto pendiente NO entra, y ni el pase ni la revisión se gastan', async () => {
    const r = await reservar();
    await aprobarAnticipo(r);
    const res = await entrar(r.pass_code);
    expect(res.status).toBe(200);
    expect(res.body.pass).toMatchObject({ result: 'balance_due', ok: false });
    expect(res.body.balance).toMatchObject({ due: '2800.00', paid: '1200.00', total: '4000.00' });
    const pase = await pool.query('SELECT status FROM guest_passes WHERE code = $1', [r.pass_code]);
    expect(pase.rows[0].status).toBe('active');
    const rev = await pool.query('SELECT count(*)::int AS n FROM door_id_checks WHERE consumed_by IS NOT NULL');
    expect(rev.rows[0].n).toBe(0);
  });

  it('el resto en efectivo da el cambio, suma al crédito y el pase ya abre', async () => {
    const r = await reservar();
    await aprobarAnticipo(r);
    const cobro = await api().post(url(`/door/reservations/${r.id}/balance`)).set(auth(hostess))
      .send({ method: 'cash', cash_received: 3000, client_request_id: randomUUID() });
    expect(cobro.status).toBe(201);
    expect(cobro.body).toMatchObject({ change_given: '200.00' });
    expect(cobro.body.balance).toMatchObject({ due: '0.00', paid: '4000.00' });
    expect(await credito()).toMatchObject({ granted: '4000.00' });

    // Cuenta en el corte de la anfitriona: el pago es suyo y en efectivo.
    const mp1 = await pool.query(
      `SELECT method, declared_by, status, cash_received::text, change_given::text FROM manual_payments
        WHERE transaction_id = (SELECT id FROM transactions WHERE type = 'reservation_balance')`);
    expect(mp1.rows[0]).toMatchObject({ method: 'cash', declared_by: hostess.id, status: 'confirmed',
      cash_received: '3000.00', change_given: '200.00' });

    const res = await entrar(r.pass_code);
    expect(res.body.admitted).toBe(true);
    expect(await estadoReserva(r.id)).toBe('seated');
  });

  it('el efectivo que no alcanza se rechaza diciendo cuánto falta, y el doble toque no cobra dos veces', async () => {
    const r = await reservar();
    await aprobarAnticipo(r);
    const poco = await api().post(url(`/door/reservations/${r.id}/balance`)).set(auth(hostess))
      .send({ method: 'cash', cash_received: 2000 });
    expect(poco.status).toBe(422);
    expect(poco.body.error.message).toMatch(/Faltan \$800\.00/);

    const clave = randomUUID();
    const a = await api().post(url(`/door/reservations/${r.id}/balance`)).set(auth(hostess))
      .send({ method: 'cash', client_request_id: clave });
    const b = await api().post(url(`/door/reservations/${r.id}/balance`)).set(auth(hostess))
      .send({ method: 'cash', client_request_id: clave });
    expect(a.status).toBe(201);
    expect(b.status).toBe(200);
    expect(b.body.idempotent).toBe(true);
    const n = await pool.query(`SELECT count(*)::int AS n FROM transactions WHERE type = 'reservation_balance'`);
    expect(n.rows[0].n).toBe(1);
    // Ya pagado: un tercer intento sin clave no cobra nada.
    expect((await api().post(url(`/door/reservations/${r.id}/balance`)).set(auth(hostess))
      .send({ method: 'cash' })).status).toBe(409);
  });

  it('sin anticipo confirmado no se cobra el resto', async () => {
    const r = await reservar();
    const res = await api().post(url(`/door/reservations/${r.id}/balance`)).set(auth(hostess))
      .send({ method: 'cash' });
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/Primero se confirma el anticipo/);
  });

  it('una mesa sin resto (todo pagado con el anticipo) entra directo', async () => {
    const r = await reservar({ total: 1200, deposit: 1200 });
    await aprobarAnticipo(r);
    const res = await entrar(r.pass_code);
    expect(res.body.admitted).toBe(true);
  });

  describe('con la terminal de Cover', () => {
    let original;
    beforeEach(async () => {
      process.env.MERCADOPAGO_ENV = 'test';
      const cover = { rows: [{ id: await f.coverOf(club.id) }] };
      await pool.query(
        `INSERT INTO payment_terminals (nightclub_id, external_id, label, operating_mode,
                                        operating_mode_at, location_id, registered_by)
         VALUES ($1,'NEWLAND_N950__SBX0000001','Cover','PDV',now(),$2,$3)`,
        [club.id, cover.rows[0].id, manager.id]);
      original = mp.createPointOrder;
    });
    afterEach(() => { mp.createPointOrder = original; });

    it('despierta la Point de la puerta con el resto exacto, y al aprobarse el pase abre', async () => {
      const r = await reservar();
      await aprobarAnticipo(r);
      let pedido = null;
      mp.createPointOrder = async (req) => {
        pedido = req;
        return { id: 'ORDTEST1', status: 'created', live_mode: false,
          external_reference: req.externalReference, total_amount: req.amount };
      };
      const cobro = await api().post(url(`/door/reservations/${r.id}/balance`)).set(auth(hostess))
        .send({ method: 'point' });
      expect(cobro.status).toBe(201);
      expect(pedido).toMatchObject({ terminalExternalId: 'NEWLAND_N950__SBX0000001', amount: '2800.00' });

      // Mientras la tarjeta no pase, sigue sin entrar.
      expect((await entrar(r.pass_code)).body.pass.result).toBe('balance_due');

      const chargeId = cobro.body.charge.id;
      await terminalCharges.apply(pool, {
        chargeId, source: 'webhook',
        read: mp.readOrder({
          id: 'ORDTEST1', status: 'processed', status_detail: 'accredited', live_mode: false,
          external_reference: chargeId, total_amount: '2800.00', total_paid_amount: '2800.00',
          transactions: { payments: [{ id: 'PAY1', amount: '2800.00', paid_amount: '2800.00',
            status: 'processed', status_detail: 'accredited', payment_method: { id: 'visa', type: 'credit_card' } }] },
        }),
      });
      expect(await credito()).toMatchObject({ granted: '4000.00' });
      const res = await entrar(r.pass_code);
      expect(res.body.admitted).toBe(true);
    });
  });
});
