/**
 * Cover es una caja (D118).
 *
 * Lo que se prueba aquí es lo que hace que la puerta sea una caja de verdad y no
 * solo una pantalla:
 *
 *   * Cover se asigna en el rol de la noche, y solo a una anfitriona.
 *   * La caja abre con fondo en pesos y en dólares, con el PIN del gerente, y queda
 *     escrito en `audit_log`. Si la anfitriona ya tenía turno (huella o botón), la caja
 *     se le pone a ese turno.
 *   * Una sola caja abierta en Cover: la otra anfitriona ve quién la tiene y no cobra.
 *   * Sin la caja abierta no se vende cover ni se cobra el resto de una mesa; la
 *     gerencia ya no vende en la puerta.
 *   * Cada cobro queda anotado a esa caja, el gerente la ve en "Cajas de la noche" y el
 *     corte devuelve el fondo en las dos monedas.
 *   * La base defiende las mismas reglas aunque alguien se salte la API.
 */
'use strict';

const { setupSchema, truncateAll, closePool, pool } = require('./helpers/db');
const pins = require('../src/services/pins');
const { api, auth } = require('./helpers/api');
const f = require('./helpers/factories');
const { fullCut, declareAndClose } = require('./helpers/cut');
const guestPasses = require('../src/services/guest-passes');

let club; let manager; let ana; let sol; let bartender; let night; let pinGerente; let coverId;

beforeAll(setupSchema);
afterAll(closePool);

async function codigoDe(user) {
  const pin = await pins.issuePin(pool, { userId: user.id });
  await pool.query('UPDATE users SET must_change_pin = false WHERE id = $1', [user.id]);
  return pin;
}

/** Una noche en curso: abrió hace una hora. */
async function nocheEnCurso() {
  const { rows } = await pool.query(
    `INSERT INTO events_calendar (nightclub_id, name, event_date, doors_open_at, ticket_price, status)
     VALUES ($1,'Viernes',(now() - interval '1 hour')::date, now() - interval '1 hour', 0, 'published')
     RETURNING id`, [club.id]);
  return rows[0];
}

beforeEach(async () => {
  await truncateAll();
  club = await f.createNightclub({ slug: 'ev2-cover' });
  manager = await f.createUser(club.id, { role: 'manager', display_name: 'Gerente' });
  ana = await f.createUser(club.id, { role: 'hostess', display_name: 'Ana' });
  sol = await f.createUser(club.id, { role: 'hostess', display_name: 'Sol' });
  bartender = await f.createUser(club.id, { role: 'bartender', display_name: 'Beto' });
  coverId = await f.coverOf(club.id);
  night = await nocheEnCurso();
  pinGerente = await codigoDe(manager);
});

const url = (p) => `/api/nightclubs/${club.id}${p}`;

const asignar = (user, body) => api().post(url(`/nights/${night.id}/roster`)).set(auth(manager))
  .send({ user_id: user.id, ...body });
const miCaja = (user = ana) => api().get(url('/till')).set(auth(user));
const abrirCaja = (body = {}, user = ana) => api().post(url('/till/open')).set(auth(user))
  .send({ opening_float: 1000, manager_pin: pinGerente, ...body });
const vender = (body = {}, user = ana) => api().post(url('/door/admissions')).set(auth(user))
  .send({ kind: 'general', quantity: 2, unit_price: 150, payment_method: 'cash', ...body });

// ============================================================================

describe('Cover en el rol de la noche', () => {
  it('a una anfitriona se le pone en Cover, y Cover aparece en el rol', async () => {
    const res = await asignar(ana, { location_id: coverId });
    expect(res.status).toBe(201);
    const persona = res.body.roster.find((p) => p.user_id === ana.id);
    expect(persona.targets).toEqual([expect.objectContaining({
      location_id: coverId, location_name: 'Cover', location_kind: 'door',
    })]);
  });

  it('a Cover no va un bartender, y a la anfitriona no se le pone en una barra', async () => {
    const beto = await asignar(bartender, { location_id: coverId });
    expect(beto.status).toBe(422);
    const enBarra = await asignar(ana, { location_id: club.bar_id });
    expect(enBarra.status).toBe(422);
    // La base dice lo mismo aunque alguien se salte la API.
    await expect(pool.query(
      `INSERT INTO shift_assignments (nightclub_id, event_id, user_id, role, location_id)
       VALUES ($1,$2,$3,'bartender',$4)`, [club.id, night.id, bartender.id, coverId]))
      .rejects.toMatchObject({ code: '23514' });
  });

  it('Cover sin anfitriona sale como caja sin nadie', async () => {
    const res = await api().get(url(`/nights/${night.id}/roster`)).set(auth(manager));
    expect(res.status).toBe(200);
    expect(res.body.gaps.tills).toEqual(expect.arrayContaining([
      expect.objectContaining({ location_id: coverId, kind: 'door' })]));
    await asignar(ana, { location_id: coverId });
    const despues = await api().get(url(`/nights/${night.id}/roster`)).set(auth(manager));
    expect(despues.body.gaps.tills.find((x) => x.location_id === coverId)).toBeUndefined();
  });
});

describe('Abrir la caja de Cover', () => {
  it('sin Cover asignado no abre, y no gasta un intento del PIN', async () => {
    const res = await abrirCaja();
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/Cover/);
  });

  it('abre con fondo en pesos y en dólares, el PIN del gerente, y queda en audit_log', async () => {
    await asignar(ana, { location_id: coverId });
    const antes = await miCaja();
    expect(antes.body.till).toBeNull();
    expect(antes.body.assignment).toMatchObject({ location_id: coverId, location_kind: 'door', held_by: null });

    const res = await abrirCaja({ opening_float: 1500, opening_float_usd: 40 });
    expect(res.status).toBe(201);
    expect(res.body.till).toMatchObject({
      location_id: coverId, location_kind: 'door',
      opening_float: '1500.00', opening_float_usd: '40.00', float_authorized_by: 'Gerente',
    });
    expect(res.body.pending_orders).toEqual([]);

    const log = await pool.query(
      `SELECT actor_id, after FROM audit_log WHERE action = 'till.open'`);
    expect(log.rows).toHaveLength(1);
    expect(log.rows[0].actor_id).toBe(ana.id);
    expect(log.rows[0].after).toMatchObject({
      location_kind: 'door', opening_float: '1500.00', opening_float_usd: '40.00',
      authorized_by: manager.id,
    });
  });

  it('si ya marcó entrada, la caja se le pone a ESE turno', async () => {
    await asignar(ana, { location_id: coverId });
    const turno = await api().post(url('/staff/shifts/start')).set(auth(ana)).send({});
    expect(turno.status).toBe(201);
    const res = await abrirCaja();
    expect(res.status).toBe(201);
    expect(res.body.till.shift_id).toBe(turno.body.shift.id);
    const { rows } = await pool.query(
      'SELECT count(*)::int AS n FROM staff_shifts WHERE user_id = $1', [ana.id]);
    expect(rows[0].n).toBe(1);
  });

  it('una sola caja en Cover: la otra anfitriona ve quién la tiene y no abre otra', async () => {
    await asignar(ana, { location_id: coverId });
    await asignar(sol, { location_id: coverId });
    expect((await abrirCaja()).status).toBe(201);

    const deSol = await miCaja(sol);
    expect(deSol.body.till).toBeNull();
    expect(deSol.body.assignment).toMatchObject({ location_id: coverId, held_by: 'Ana' });

    const otra = await abrirCaja({}, sol);
    expect(otra.status).toBe(409);
    expect(otra.body.error.message).toMatch(/Cover ya está abierta con Ana/);
  });

  it('el fondo, una vez escrito, no se edita', async () => {
    await asignar(ana, { location_id: coverId });
    const res = await abrirCaja({ opening_float_usd: 20 });
    await expect(pool.query(
      'UPDATE staff_shifts SET opening_float_usd = 999 WHERE id = $1', [res.body.till.shift_id]))
      .rejects.toMatchObject({ code: '23001' });
  });

  it('la caja de Cover solo la tiene una anfitriona, aunque se escriba directo en la base', async () => {
    const cajero = await f.createUser(club.id, { role: 'cashier' });
    await expect(f.openTill(club.id, { cashier: cajero, locationId: coverId, authorizer: manager }))
      .rejects.toMatchObject({ code: '23514' });
  });
});

describe('Cobrar en la puerta', () => {
  it('sin la caja abierta la anfitriona no vende, ni siquiera una cortesía', async () => {
    const res = await vender();
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/Abre la caja de Cover/);
    const cortesia = await vender({ payment_method: 'courtesy', notes: 'prensa', manager_pin: pinGerente });
    expect(cortesia.status).toBe(409);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM door_admissions');
    expect(rows[0].n).toBe(0);
  });

  it('la gerencia ya no vende en la puerta', async () => {
    const res = await vender({}, manager);
    expect(res.status).toBe(403);
  });

  it('la otra anfitriona, sin la caja, tampoco cobra', async () => {
    await asignar(ana, { location_id: coverId });
    await abrirCaja();
    const res = await vender({}, sol);
    expect(res.status).toBe(409);
  });

  it('con la caja abierta vende, y la entrada queda anotada a esa caja', async () => {
    await asignar(ana, { location_id: coverId });
    const abierta = await abrirCaja();
    const res = await vender({ cash_received: 500 });
    expect(res.status).toBe(201);
    expect(res.body.change_given).toBe('200.00');
    const { rows } = await pool.query(
      'SELECT till_shift_id FROM door_admissions WHERE id = $1', [res.body.admission.id]);
    expect(rows[0].till_shift_id).toBe(abierta.body.till.shift_id);
  });

  it('el resto de una mesa también se cobra solo con la caja, y queda anotado a ella', async () => {
    const guest = await f.createUser(club.id, { role: 'guest' });
    const mesa = await f.createTable(club.id, { code: '39', section: 'ZONA ROJA', capacity: 8 });
    const { rows: [r] } = await pool.query(
      `INSERT INTO reservations (nightclub_id, user_id, table_id, starts_at, duration_minutes,
                                 guest_count, status, currency, pass_code, total_estimated)
       VALUES ($1,$2,$3,now() + interval '30 minutes',240,6,'confirmed','MXN','COVR1234',3000)
       RETURNING id, nightclub_id, pass_code, status, guest_count`,
      [club.id, guest.id, mesa.id]);
    await guestPasses.issueForReservation(pool, { reservation: r });

    const sinCaja = await api().post(url(`/door/reservations/${r.id}/balance`)).set(auth(ana))
      .send({ method: 'cash' });
    expect(sinCaja.status).toBe(409);

    await asignar(ana, { location_id: coverId });
    const abierta = await abrirCaja();
    const res = await api().post(url(`/door/reservations/${r.id}/balance`)).set(auth(ana))
      .send({ method: 'cash', cash_received: 3000 });
    expect(res.status).toBe(201);
    const { rows } = await pool.query(
      'SELECT till_shift_id FROM manual_payments WHERE id = $1', [res.body.payment.id]);
    expect(rows[0].till_shift_id).toBe(abierta.body.till.shift_id);
  });

  it('un cobro no se cuelga de la caja de otra persona', async () => {
    await asignar(ana, { location_id: coverId });
    const abierta = await abrirCaja();
    await expect(pool.query(
      `INSERT INTO door_admissions (nightclub_id, kind, quantity, unit_price, total, currency,
                                    payment_method, sold_by, till_shift_id)
       VALUES ($1,'general',1,100,100,'MXN','cash',$2,$3)`,
      [club.id, sol.id, abierta.body.till.shift_id]))
      .rejects.toMatchObject({ code: '23514' });
  });
});

describe('El gerente ve la caja de Cover y su corte', () => {
  beforeEach(async () => {
    await asignar(ana, { location_id: coverId });
  });

  it('Cover sale en "Cajas de la noche" con su fondo, la gente que entró y los dólares', async () => {
    await abrirCaja({ opening_float: 1000, opening_float_usd: 50 });
    await vender({ quantity: 3, cash_received: 450 });

    const res = await api().get(url('/tills')).set(auth(manager));
    expect(res.status).toBe(200);
    const cover = res.body.tills.find((x) => x.location_id === coverId);
    expect(cover).toMatchObject({
      location_kind: 'door', user_name: 'Ana', opening_float: '1000.00', opening_float_usd: '50.00',
      cash_to_hand: '1450.00', usd_to_hand: '50.00', door_people: 3, closed: false,
    });
  });

  it('la caja abierta no se cierra sin corte, aunque no haya vendido nada', async () => {
    await abrirCaja({ opening_float: 500 });
    const res = await api().post(url('/staff/shifts/end')).set(auth(ana)).send({});
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/caja abierta/);
    // A ciegas (D105): el error no dice cuánto hay en el cajón.
    expect(res.body.error.details || {}).not.toHaveProperty('cash_to_hand');
  });

  it('el corte devuelve el fondo en pesos y en dólares, y pide contar los dólares', async () => {
    await abrirCaja({ opening_float: 1000, opening_float_usd: 30 });
    await vender({ quantity: 2, cash_received: 300 });

    const resumen = await fullCut(club.id, ana);
    expect(resumen).toMatchObject({
      opening_float: '1000.00', opening_float_usd: '30.00', has_usd: true,
      cash_to_hand: '1300.00', usd_to_hand: '30.00',
    });

    // Sin contar los dólares no se guarda el conteo.
    const sinDolares = await api().post(url('/shifts/me/declaration')).set(auth(ana))
      .send({ declared_cash: 1300 });
    expect(sinDolares.status).toBe(422);

    const corte = await declareAndClose(club.id, ana, {
      declared_cash: 1300, counted_usd: 30, manager_pin: pinGerente,
    });
    expect(corte.status).toBe(201);
    expect(corte.body.closing).toMatchObject({
      location_kind: 'door', opening_float: '1000.00', opening_float_usd: '30.00',
      expected_cash: '1300.00', difference: '0.00', expected_usd: '30.00', difference_usd: '0.00',
    });

    // Con el corte hecho la caja queda libre: la puede abrir otra anfitriona.
    await asignar(sol, { location_id: coverId });
    expect((await abrirCaja({}, sol)).status).toBe(201);
  });

  it('el ticket del corte dice la caja, la gente que entró y el fondo en dólares', async () => {
    const prn = await api().post(url('/printers')).set(auth(manager)).send({
      location_id: coverId, name: 'Cover · caja', purpose: 'till',
      connection: 'network', host: '192.168.1.60',
    });
    expect(prn.status).toBe(201);
    await abrirCaja({ opening_float: 1000, opening_float_usd: 30 });
    await vender({ quantity: 2, cash_received: 300 });
    const corte = await declareAndClose(club.id, ana, {
      declared_cash: 1300, counted_usd: 30, manager_pin: pinGerente,
    });
    expect(corte.body.ticket).not.toBeNull();
    const { rows } = await pool.query(
      `SELECT printer_id, preview FROM print_jobs WHERE kind = 'shift_cut'`);
    expect(rows[0].printer_id).toBe(prn.body.printer.id);
    expect(rows[0].preview).toMatch(/Caja: Cover/);
    expect(rows[0].preview).toMatch(/Personas que entraron\s+2/);
    expect(rows[0].preview).toMatch(/Fondo en dólares\s+USD 30\.00/);
  });

  it('un cover con precio en dólares entra al cajón como dólares, no como pesos', async () => {
    await abrirCaja({ opening_float: 0 });
    const res = await vender({ quantity: 1, unit_price: 20, currency: 'USD' });
    expect(res.status).toBe(201);
    const resumen = await fullCut(club.id, ana);
    expect(resumen.cash_to_hand).toBe('0.00');
    expect(resumen.usd_to_hand).toBe('20.00');
    expect(resumen.totals.door_people).toBe(1);
  });
});
