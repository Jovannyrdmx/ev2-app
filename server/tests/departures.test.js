'use strict';

// Constancia de salida sin taxi (D85): a pie la pide el cliente y la confirma la
// hostess; con valet sale sola al entregar el auto con el QR. Los dos folios se
// verifican en la misma página pública que los del taxi.

const { setupSchema, truncateAll, closePool, pool } = require('./helpers/db');
const { api, auth } = require('./helpers/api');
const f = require('./helpers/factories');

let club; let otherClub; let manager; let hostess; let waiter; let valet; let guest; let otherGuest;
let foreignHostess;

beforeAll(setupSchema);
afterAll(closePool);

beforeEach(async () => {
  await truncateAll();
  club = await f.createNightclub({ name: 'EV2 Clandestinoz', slug: 'ev2-salidas' });
  otherClub = await f.createNightclub({ name: 'Otro', slug: 'otro-salidas' });
  manager = await f.createUser(club.id, { role: 'manager' });
  hostess = await f.createUser(club.id, { role: 'hostess', display_name: 'Lupita' });
  waiter = await f.createUser(club.id, { role: 'waiter' });
  valet = await f.createUser(club.id, { role: 'valet' });
  guest = await f.createUser(club.id, { role: 'guest', first_name: 'Ana' });
  otherGuest = await f.createUser(club.id, { role: 'guest', first_name: 'Sofía' });
  foreignHostess = await f.createUser(otherClub.id, { role: 'hostess' });
});

const url = (p) => `/api/nightclubs/${club.id}${p}`;
const ask = (who = guest) => api().post(url('/departures')).set(auth(who));
const confirm = (id, who = hostess) => api().post(url(`/departures/${id}/confirm`)).set(auth(who));
const mine = (who = guest) => api().get(url('/departures/mine')).set(auth(who));

describe('Salida a pie', () => {
  it('el cliente la pide y queda pendiente, sin folio', async () => {
    const res = await ask();
    expect(res.status).toBe(201);
    expect(res.body.departure).toMatchObject({
      mode: 'on_foot', status: 'requested', guest: 'Ana T.', folio: null,
    });

    const { rows } = await pool.query(
      `SELECT audience, payload FROM events WHERE type = 'departure_requested'`);
    expect(rows[0].audience.roles).toEqual(['hostess', 'manager']);
    expect(rows[0].payload.guest).toBe('Ana T.');
  });

  it('tocar dos veces es la misma solicitud', async () => {
    const first = await ask();
    const second = await ask();
    expect(second.status).toBe(200);
    expect(second.body.departure.id).toBe(first.body.departure.id);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM guest_departures');
    expect(rows[0].n).toBe(1);
  });

  it('solo un cliente la pide', async () => {
    expect((await ask(waiter)).status).toBe(403);
    expect((await ask(hostess)).status).toBe(403);
  });

  it('la hostess ve la lista y al confirmar nace el folio', async () => {
    const created = (await ask()).body.departure;
    await ask(otherGuest);

    const list = await api().get(url('/departures')).set(auth(hostess));
    expect(list.status).toBe(200);
    expect(list.body.departures.map((d) => d.guest)).toEqual(['Ana T.', 'Sofía T.']);

    const res = await confirm(created.id);
    expect(res.status).toBe(200);
    expect(res.body.departure.status).toBe('confirmed');
    expect(res.body.departure.folio).toMatch(/^EV2-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(new Date(res.body.departure.expires_at) > new Date()).toBe(true);

    const after = await api().get(url('/departures')).set(auth(hostess));
    expect(after.body.departures.map((d) => d.guest)).toEqual(['Sofía T.']);

    const { rows } = await pool.query(
      `SELECT audience FROM events WHERE type = 'departure_confirmed'`);
    expect(rows[0].audience.userIds).toEqual([guest.id]);
  });

  it('solo la hostess confirma: ni el mesero, ni el gerente, ni el propio cliente', async () => {
    const created = (await ask()).body.departure;
    expect((await confirm(created.id, waiter)).status).toBe(403);
    expect((await confirm(created.id, manager)).status).toBe(403);
    expect((await confirm(created.id, guest)).status).toBe(403);
    expect((await api().get(url('/departures')).set(auth(guest))).status).toBe(403);
  });

  it('la hostess de otro club no la ve ni la confirma', async () => {
    const created = (await ask()).body.departure;
    expect((await confirm(created.id, foreignHostess)).status).toBe(403);
    const other = await api().post(`/api/nightclubs/${otherClub.id}/departures/${created.id}/confirm`)
      .set(auth(foreignHostess));
    expect(other.status).toBe(404);
  });

  it('no se confirma dos veces ni después de cancelada', async () => {
    const created = (await ask()).body.departure;
    expect((await confirm(created.id)).status).toBe(200);
    expect((await confirm(created.id)).status).toBe(409);

    const again = (await ask()).body.departure;
    const canceled = await api().post(url(`/departures/${again.id}/cancel`)).set(auth(guest));
    expect(canceled.body.departure).toMatchObject({ status: 'canceled', cancel_reason: 'guest' });
    expect((await confirm(again.id)).status).toBe(409);
  });

  it('nadie cancela la salida de otro', async () => {
    const created = (await ask()).body.departure;
    const res = await api().post(url(`/departures/${created.id}/cancel`)).set(auth(otherGuest));
    expect(res.status).toBe(404);
  });

  it('el cliente ve su constancia y otro cliente no', async () => {
    const created = (await ask()).body.departure;
    const pending = await api().get(url(`/departures/${created.id}/certificate`)).set(auth(guest));
    expect(pending.status).toBe(409);

    await confirm(created.id);
    const now = await mine();
    expect(now.body.departure.status).toBe('confirmed');
    expect(now.body.certificate).toMatchObject({
      nightclub: 'EV2 Clandestinoz', guest: 'Ana T.', driver: null, vehicle: null,
      mode: 'on_foot', valid: true,
    });
    expect(now.body.certificate.disclaimer).toMatch(/confirmado por personal del club/);

    const cert = await api().get(url(`/departures/${created.id}/certificate`)).set(auth(guest));
    expect(cert.body.certificate.folio).toBe(now.body.departure.folio);
    const stranger = await api().get(url(`/departures/${created.id}/certificate`)).set(auth(otherGuest));
    expect(stranger.status).toBe(404);
  });

  it('una solicitud que nadie confirmó a tiempo se cierra sola', async () => {
    const created = (await ask()).body.departure;
    // Se mueve la hora con el disparador apagado: en producción nada edita una salida.
    await pool.query('ALTER TABLE guest_departures DISABLE TRIGGER guest_departures_guard');
    await pool.query(`UPDATE guest_departures SET requested_at = now() - interval '2 hours'`);
    await pool.query('ALTER TABLE guest_departures ENABLE TRIGGER guest_departures_guard');

    const list = await api().get(url('/departures')).set(auth(hostess));
    expect(list.body.departures).toEqual([]);
    const { rows } = await pool.query('SELECT status, cancel_reason FROM guest_departures WHERE id = $1',
      [created.id]);
    expect(rows[0]).toEqual({ status: 'canceled', cancel_reason: 'expired' });
    expect((await mine()).body.departure).toBeNull();
  });

  it('una salida cerrada no se edita ni se borra', async () => {
    const created = (await ask()).body.departure;
    await confirm(created.id);
    await expect(pool.query(`UPDATE guest_departures SET folio = 'EV2-AAAA-AAAA'`))
      .rejects.toThrow(/ya se cerró/);
    await expect(pool.query('DELETE FROM guest_departures')).rejects.toThrow(/no se borra/);
  });
});

describe('Verificación pública', () => {
  it('el folio de una salida a pie se verifica sin sesión y sin datos de más', async () => {
    const created = (await ask()).body.departure;
    const { folio } = (await confirm(created.id)).body.departure;

    const res = await api().get(`/api/taxi/verify/${folio.toLowerCase()}`);
    expect(res.status).toBe(200);
    expect(res.body.certificate).toMatchObject({
      folio, nightclub: 'EV2 Clandestinoz', guest: 'Ana T.', mode: 'on_foot', valid: true,
    });
    expect(JSON.stringify(res.body)).not.toMatch(/Lupita|Testb/);
  });

  it('un folio que no existe sigue dando 404', async () => {
    const res = await api().get('/api/taxi/verify/EV2-ZZZZ-ZZZZ');
    expect(res.status).toBe(404);
  });
});

describe('Salida con valet', () => {
  let token; let ticket;
  beforeEach(async () => {
    const created = await api().post(url('/valet/tickets')).set(auth(valet))
      .send({ plate: 'abc-123', vehicle_desc: 'Sentra gris' });
    token = created.body.qr_token;
    ticket = created.body.ticket;
  });

  it('al entregar el auto de un cliente con cuenta sale la constancia con la placa', async () => {
    await api().post(url('/valet/claim')).set(auth(guest)).send({ qr_token: token });
    // Había pedido salir a pie: se fue en su auto, así que esa solicitud se cierra.
    const walking = (await ask()).body.departure;

    const res = await api().post(url(`/valet/tickets/${ticket.id}/deliver`)).set(auth(valet))
      .send({ qr_token: token });
    expect(res.status).toBe(200);
    expect(res.body.departure_folio).toMatch(/^EV2-/);

    const now = await mine();
    expect(now.body.departure).toMatchObject({ mode: 'valet', status: 'confirmed' });
    expect(now.body.certificate).toMatchObject({
      mode: 'valet', vehicle: { plate: 'ABC-123', description: 'Sentra gris' },
    });
    const { rows } = await pool.query('SELECT status, cancel_reason FROM guest_departures WHERE id = $1',
      [walking.id]);
    expect(rows[0]).toEqual({ status: 'canceled', cancel_reason: 'superseded' });

    const verified = await api().get(`/api/taxi/verify/${res.body.departure_folio}`);
    expect(verified.body.certificate.vehicle.plate).toBe('ABC-123');
  });

  it('un ticket sin cuenta de cliente no genera constancia', async () => {
    const res = await api().post(url(`/valet/tickets/${ticket.id}/deliver`)).set(auth(valet))
      .send({ qr_token: token });
    expect(res.status).toBe(200);
    expect(res.body.departure_folio).toBeNull();
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM guest_departures');
    expect(rows[0].n).toBe(0);
  });

  it('con el QR equivocado no se entrega ni sale constancia', async () => {
    await api().post(url('/valet/claim')).set(auth(guest)).send({ qr_token: token });
    const res = await api().post(url(`/valet/tickets/${ticket.id}/deliver`)).set(auth(valet))
      .send({ qr_token: 'b'.repeat(48) });
    expect(res.status).toBe(403);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM guest_departures');
    expect(rows[0].n).toBe(0);
  });
});
