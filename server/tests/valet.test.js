'use strict';

// Valet con QR (D22): el estacionamiento es gratis y lo que gana el valet es la
// propina; el token del QR es lo único que libera un auto, y el gerente es la única
// excepción, dejando constancia.

const { setupSchema, truncateAll, closePool, pool } = require('./helpers/db');
const { api, auth } = require('./helpers/api');
const f = require('./helpers/factories');

let club; let manager; let valet; let guest; let otherGuest;

beforeAll(setupSchema);
afterAll(closePool);

beforeEach(async () => {
  await truncateAll();
  club = await f.createNightclub({ slug: 'ev2-valet' });
  manager = await f.createUser(club.id, { role: 'manager' });
  valet = await f.createUser(club.id, { role: 'valet', display_name: 'Beto' });
  guest = await f.createUser(club.id, { role: 'guest', display_name: 'Ana' });
  otherGuest = await f.createUser(club.id, { role: 'guest', display_name: 'Sofía' });
});

const url = (p) => `/api/nightclubs/${club.id}${p}`;
let plateSeq = 0;

const checkIn = (over = {}, as = valet) => {
  plateSeq += 1;
  return api().post(url('/valet/tickets')).set(auth(as))
    .send({ plate: `xyz-${1000 + plateSeq}`, vehicle_desc: 'Sentra gris', ...over });
};

const addSpots = (codes, zone = 'Frente') => api().post(url('/parking-spots')).set(auth(manager))
  .send({ spots: codes.map((code) => ({ code, zone })) });

// ---------------------------------------------------------------- ajustes y cajones

describe('Ajustes y cajones', () => {
  it('el valet nace gratis: la tarifa por omisión es cero', async () => {
    const res = await api().get(url('/valet-settings')).set(auth(guest));
    expect(res.status).toBe(200);
    expect(res.body.settings).toMatchObject({
      enabled: true, fee_amount: '0.00', currency: 'MXN', handover_point: 'Entrada principal',
    });
  });

  it('el gerente edita el punto de entrega y el cliente no puede', async () => {
    const ok = await api().put(url('/valet-settings')).set(auth(manager))
      .send({ handover_point: 'Puerta de valet' });
    expect(ok.body.settings.handover_point).toBe('Puerta de valet');
    expect((await api().put(url('/valet-settings')).set(auth(guest)).send({ enabled: false })).status)
      .toBe(403);
  });

  it('los cajones se cargan de golpe y los repetidos se omiten sin fallar', async () => {
    const first = await addSpots(['A1', 'A2', 'A3']);
    expect(first.status).toBe(201);
    expect(first.body.created).toHaveLength(3);
    expect(first.body.created[0].code).toBe('A1');

    const again = await addSpots(['A2', 'A4']);
    expect(again.body.created).toHaveLength(1);
    expect(again.body.skipped).toBe(1);

    const dupes = await addSpots(['B1', 'b1']);
    expect(dupes.status).toBe(400);
  });

  it('un cajón con auto no se puede retirar ni desactivar', async () => {
    const spots = await addSpots(['A1']);
    const spot = spots.body.created[0];
    await checkIn({ spot_id: spot.id });

    expect((await api().delete(url(`/parking-spots/${spot.id}`)).set(auth(manager))).status).toBe(409);
    expect((await api().put(url(`/parking-spots/${spot.id}`)).set(auth(manager))
      .send({ active: false })).status).toBe(409);
  });

  it('el cliente no ve el mapa de cajones', async () => {
    expect((await api().get(url('/parking-spots')).set(auth(guest))).status).toBe(403);
    expect((await api().get(url('/parking-spots')).set(auth(valet))).status).toBe(200);
  });
});

// ---------------------------------------------------------------- recepción

describe('Recibir el auto', () => {
  it('entrega un código corto para hablar y un token largo para el QR', async () => {
    const res = await checkIn();
    expect(res.status).toBe(201);
    expect(res.body.ticket).toMatchObject({ status: 'parked', fee: '0.00', claimed: false });
    expect(res.body.ticket.code).toMatch(/^V-[A-Z0-9]{4}$/);
    expect(res.body.ticket.plate).toMatch(/^XYZ-/);
    expect(res.body.qr_token).toMatch(/^[0-9a-f]{48}$/);
    expect(res.body.handover_point).toBe('Entrada principal');
  });

  it('el token del QR nunca vuelve a viajar en las consultas', async () => {
    const created = await checkIn();
    const { qr_token: token, ticket } = created.body;

    const board = await api().get(url('/valet/tickets')).set(auth(valet));
    expect(JSON.stringify(board.body)).not.toContain(token);

    const one = await api().get(url(`/valet/tickets/${ticket.id}`)).set(auth(manager));
    expect(JSON.stringify(one.body)).not.toContain(token);

    // Y sí se puede resolver un escaneo: el token es la entrada, no la salida.
    const scanned = await api().get(url(`/valet/tickets/by-token/${token}`)).set(auth(valet));
    expect(scanned.body.ticket.id).toBe(ticket.id);
    expect(JSON.stringify(scanned.body)).not.toContain(token);
  });

  it('el mismo auto no puede tener dos tickets abiertos', async () => {
    const first = await checkIn();
    const again = await api().post(url('/valet/tickets')).set(auth(valet))
      .send({ plate: first.body.ticket.plate.toLowerCase() });
    expect(again.status).toBe(409);
    expect(again.body.error.message).toMatch(/ticket abierto/i);
  });

  it('un cajón ocupado responde 409 y uno inexistente 422', async () => {
    const spot = (await addSpots(['A1'])).body.created[0];
    await checkIn({ spot_id: spot.id });
    expect((await checkIn({ spot_id: spot.id })).status).toBe(409);
    expect((await checkIn({ spot_id: '00000000-0000-4000-8000-000000000000' })).status).toBe(422);
  });

  it('el mismo client_request_id no crea dos tickets', async () => {
    const key = '55555555-5555-4555-8555-555555555555';
    const first = await checkIn({ client_request_id: key });
    const second = await api().post(url('/valet/tickets')).set(auth(valet))
      .send({ plate: first.body.ticket.plate, client_request_id: key });
    expect(second.status).toBe(200);
    expect(second.body.idempotent).toBe(true);
    expect(second.body.ticket.id).toBe(first.body.ticket.id);
  });

  it('un cliente no recibe autos y con el módulo apagado nadie lo hace', async () => {
    expect((await checkIn({}, guest)).status).toBe(403);
    await api().put(url('/valet-settings')).set(auth(manager)).send({ enabled: false });
    expect((await checkIn()).status).toBe(422);
  });
});

// ---------------------------------------------------------------- reclamar y pedir

describe('El cliente reclama y pide su auto', () => {
  let token; let ticket;
  beforeEach(async () => {
    const created = await checkIn();
    token = created.body.qr_token;
    ticket = created.body.ticket;
  });

  it('escanear el QR asocia el ticket a la cuenta', async () => {
    const res = await api().post(url('/valet/claim')).set(auth(guest)).send({ qr_token: token });
    expect(res.status).toBe(200);
    expect(res.body.ticket).toMatchObject({ id: ticket.id, claimed: true });

    const mine = await api().get(url('/valet/tickets/mine')).set(auth(guest));
    expect(mine.body.open).toHaveLength(1);
    // El cliente no ve quién estacionó su auto ni las notas del personal.
    expect(mine.body.open[0]).not.toHaveProperty('received_by');
    expect(mine.body.open[0]).not.toHaveProperty('notes');
  });

  it('un ticket ya reclamado no se lo lleva otra cuenta y un token falso no existe', async () => {
    await api().post(url('/valet/claim')).set(auth(guest)).send({ qr_token: token });
    const stolen = await api().post(url('/valet/claim')).set(auth(otherGuest)).send({ qr_token: token });
    expect(stolen.status).toBe(409);

    const fake = await api().post(url('/valet/claim')).set(auth(otherGuest))
      .send({ qr_token: 'a'.repeat(48) });
    expect(fake.status).toBe(404);
  });

  it('pedir el auto avisa al valet y pedirlo dos veces no es un error', async () => {
    await api().post(url('/valet/claim')).set(auth(guest)).send({ qr_token: token });
    const res = await api().post(url(`/valet/tickets/${ticket.id}/request`)).set(auth(guest));
    expect(res.status).toBe(200);
    expect(res.body.ticket.status).toBe('requested');

    const { rows } = await pool.query(`SELECT audience, payload FROM events WHERE type = 'valet_requested'`);
    expect(rows).toHaveLength(1);
    expect(rows[0].audience.roles).toContain('valet');
    expect(rows[0].payload.plate).toBe(ticket.plate);

    const twice = await api().post(url(`/valet/tickets/${ticket.id}/request`)).set(auth(guest));
    expect(twice.status).toBe(200);
    expect(twice.body.already_requested).toBe(true);
  });

  it('un ticket ajeno no existe para el cliente', async () => {
    await api().post(url('/valet/claim')).set(auth(guest)).send({ qr_token: token });
    expect((await api().get(url(`/valet/tickets/${ticket.id}`)).set(auth(otherGuest))).status).toBe(404);
    expect((await api().post(url(`/valet/tickets/${ticket.id}/request`)).set(auth(otherGuest))).status)
      .toBe(404);
  });
});

// ---------------------------------------------------------------- entrega

describe('Entregar el auto', () => {
  let token; let ticket; let spot;
  beforeEach(async () => {
    spot = (await addSpots(['A1'])).body.created[0];
    const created = await checkIn({ spot_id: spot.id });
    token = created.body.qr_token;
    ticket = created.body.ticket;
  });

  it('avisar que el auto está listo le dice al cliente dónde recogerlo', async () => {
    await api().post(url('/valet/claim')).set(auth(guest)).send({ qr_token: token });
    await api().post(url(`/valet/tickets/${ticket.id}/request`)).set(auth(guest));
    const res = await api().post(url(`/valet/tickets/${ticket.id}/ready`)).set(auth(valet));
    expect(res.body.ticket.status).toBe('ready');

    const { rows } = await pool.query(`SELECT audience, payload FROM events WHERE type = 'valet_ready'`);
    expect(rows[0].audience.userIds).toEqual([guest.id]);
    expect(rows[0].payload.message).toContain('Entrada principal');
  });

  it('con el token correcto se entrega y el cajón queda libre', async () => {
    const res = await api().post(url(`/valet/tickets/${ticket.id}/deliver`)).set(auth(valet))
      .send({ qr_token: token });
    expect(res.status).toBe(200);
    expect(res.body.ticket.status).toBe('delivered');

    const spots = await api().get(url('/parking-spots')).set(auth(valet));
    expect(spots.body.spots[0].occupied_by).toBeNull();
    expect(spots.body.occupancy).toMatchObject({ total: 1, occupied: 0, free: 1 });
  });

  it('el token de otro ticket no abre este auto', async () => {
    const other = await checkIn();
    const res = await api().post(url(`/valet/tickets/${ticket.id}/deliver`)).set(auth(valet))
      .send({ qr_token: other.body.qr_token });
    expect(res.status).toBe(403);

    const still = await api().get(url(`/valet/tickets/${ticket.id}`)).set(auth(valet));
    expect(still.body.ticket.status).toBe('parked');
  });

  it('el QR es el control, no el estado: se puede entregar sin haberlo pedido', async () => {
    const res = await api().post(url(`/valet/tickets/${ticket.id}/deliver`)).set(auth(valet))
      .send({ qr_token: token });
    expect(res.status).toBe(200);
    // Y no se entrega dos veces.
    const twice = await api().post(url(`/valet/tickets/${ticket.id}/deliver`)).set(auth(valet))
      .send({ qr_token: token });
    expect(twice.status).toBe(409);
  });

  it('un token vacío o demasiado corto ni siquiera llega a comparar', async () => {
    const res = await api().post(url(`/valet/tickets/${ticket.id}/deliver`)).set(auth(valet))
      .send({ qr_token: 'abc' });
    expect(res.status).toBe(400);
  });

  it('cancelar cierra el ticket y libera el cajón', async () => {
    const res = await api().post(url(`/valet/tickets/${ticket.id}/cancel`)).set(auth(valet))
      .send({ reason: 'El cliente se llevó el auto antes de entrar' });
    expect(res.body.ticket.status).toBe('cancelled');
    const spots = await api().get(url('/parking-spots')).set(auth(valet));
    expect(spots.body.spots[0].occupied_by).toBeNull();
  });
});

// ---------------------------------------------------------------- ticket perdido

describe('Ticket perdido', () => {
  let ticket;
  beforeEach(async () => {
    ticket = (await checkIn()).body.ticket;
  });

  const override = (as, body = {}) => api().post(url(`/valet/tickets/${ticket.id}/deliver-override`))
    .set(auth(as))
    .send({ reason: 'Perdió el ticket y trae identificación', id_type: 'INE', id_name: 'Ana Pérez', ...body });

  it('el valet no puede saltarse el QR: solo el gerente', async () => {
    expect((await override(valet)).status).toBe(403);
    expect((await override(manager)).status).toBe(200);
  });

  it('la entrega sin QR queda asentada con quién la autorizó', async () => {
    const res = await override(manager);
    expect(res.body.ticket.status).toBe('delivered');
    expect(res.body.ticket.override).toMatchObject({
      by: manager.display_name, reason: 'Perdió el ticket y trae identificación',
      id_type: 'INE', id_name: 'Ana Pérez',
    });

    const { rows } = await pool.query(
      `SELECT action, entity, entity_id, actor_id, after FROM audit_log
        WHERE action = 'valet_handover_without_qr'`);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ entity: 'valet_ticket', entity_id: ticket.id, actor_id: manager.id });
    expect(rows[0].after).toMatchObject({ id_type: 'INE', id_name: 'Ana Pérez' });
    // El número del documento nunca se guarda: no aporta y sí es un riesgo.
    expect(Object.keys(rows[0].after)).not.toContain('id_number');
  });

  it('exige un motivo real y un tipo de identificación conocido', async () => {
    expect((await override(manager, { reason: 'x' })).status).toBe(400);
    expect((await override(manager, { id_type: 'tarjeta del gym' })).status).toBe(400);
  });

  it('un ticket ya entregado no se puede volver a entregar', async () => {
    await override(manager);
    expect((await override(manager)).status).toBe(409);
  });
});

// ---------------------------------------------------------------- cobro (si el club cobrara)

describe('Si el club decidiera cobrar el valet', () => {
  let token; let ticket;
  beforeEach(async () => {
    await api().put(url('/valet-settings')).set(auth(manager)).send({ fee_amount: 80 });
    const created = await checkIn();
    token = created.body.qr_token;
    ticket = created.body.ticket;
  });

  it('la tarifa se congela en el ticket al recibir el auto', async () => {
    expect(ticket.fee).toBe('80.00');
    // Cambiarla después no altera los tickets ya abiertos.
    await api().put(url('/valet-settings')).set(auth(manager)).send({ fee_amount: 200 });
    const still = await api().get(url(`/valet/tickets/${ticket.id}`)).set(auth(valet));
    expect(still.body.ticket.fee).toBe('80.00');
  });

  it('sin decir cómo se pagó no se entrega, y la tarjeta llega en la fase 3', async () => {
    const noMethod = await api().post(url(`/valet/tickets/${ticket.id}/deliver`)).set(auth(valet))
      .send({ qr_token: token });
    expect(noMethod.status).toBe(422);
    const card = await api().post(url(`/valet/tickets/${ticket.id}/deliver`)).set(auth(valet))
      .send({ qr_token: token, payment_method: 'card' });
    expect(card.status).toBe(501);
  });

  it('en efectivo asienta el cobro a favor del club', async () => {
    const res = await api().post(url(`/valet/tickets/${ticket.id}/deliver`)).set(auth(valet))
      .send({ qr_token: token, payment_method: 'cash' });
    expect(res.status).toBe(200);
    const { rows } = await pool.query(
      `SELECT type, direction, amount::text, status, provider, payee_user_id, reference_type
         FROM transactions WHERE reference_id = $1`, [ticket.id]);
    expect(rows[0]).toMatchObject({
      type: 'valet', direction: 'in', amount: '80.00', status: 'paid', provider: 'cash',
      // El valet no es el beneficiario: la tarifa es del club, la propina va aparte.
      payee_user_id: null, reference_type: 'valet_ticket',
    });
  });
});

// ---------------------------------------------------------------- calificación y números

describe('Calificación y números del gerente', () => {
  it('solo el dueño califica, solo un servicio entregado y una sola vez', async () => {
    const created = await checkIn();
    const { qr_token: token, ticket } = created.body;
    await api().post(url('/valet/claim')).set(auth(guest)).send({ qr_token: token });

    const early = await api().post(url(`/valet/tickets/${ticket.id}/rate`)).set(auth(guest))
      .send({ rating: 5 });
    expect(early.status).toBe(409);

    await api().post(url(`/valet/tickets/${ticket.id}/deliver`)).set(auth(valet))
      .send({ qr_token: token });
    expect((await api().post(url(`/valet/tickets/${ticket.id}/rate`)).set(auth(guest))
      .send({ rating: 5, comment: 'Rapidísimo' })).status).toBe(200);
    expect((await api().post(url(`/valet/tickets/${ticket.id}/rate`)).set(auth(guest))
      .send({ rating: 1 })).status).toBe(409);
    expect((await api().post(url(`/valet/tickets/${ticket.id}/rate`)).set(auth(valet))
      .send({ rating: 1 })).status).toBe(403);
  });

  it('las estadísticas separan lo entregado de lo entregado sin QR', async () => {
    const a = await checkIn();
    await api().post(url(`/valet/tickets/${a.body.ticket.id}/deliver`)).set(auth(valet))
      .send({ qr_token: a.body.qr_token });
    const b = await checkIn();
    await api().post(url(`/valet/tickets/${b.body.ticket.id}/deliver-override`)).set(auth(manager))
      .send({ reason: 'Perdió el ticket', id_type: 'licencia', id_name: 'Luis Ruiz' });
    await checkIn();

    const res = await api().get(url('/valet/stats')).set(auth(manager));
    expect(res.status).toBe(200);
    expect(res.body.totals).toMatchObject({
      tickets: 3, delivered: 2, open: 1, handed_over_without_qr: 1,
    });
    expect(res.body.valets[0]).toMatchObject({ user_id: valet.id, received: 3 });
    expect((await api().get(url('/valet/stats')).set(auth(valet))).status).toBe(403);
  });
});

// ---------------------------------------------------------------- tablero del club

describe('El tablero ya no cuenta como ingreso lo que no es del club', () => {
  it('separa la venta del club, lo del personal y lo de los conductores', async () => {
    const driverUser = await f.createUser(club.id, { role: 'driver' });
    await pool.query(
      `INSERT INTO transactions (nightclub_id, type, direction, amount, currency, status, payee_user_id)
       VALUES ($1,'drink_order','in',500,'MXN','paid',NULL),
              ($1,'tip','in',300,'MXN','paid',$2),
              ($1,'taxi_ride','in',150,'MXN','paid',$3)`,
      [club.id, valet.id, driverUser.id]);

    const res = await api().get(url('/dashboard')).set(auth(manager));
    expect(res.status).toBe(200);
    const mxn = res.body.revenue_today.find((r) => r.currency === 'MXN');
    // Antes esto devolvía 950: la propina de la ambientadora y el taxi del conductor
    // aparecían como venta del club.
    expect(mxn).toMatchObject({ total: '500.00', count: 1, to_staff: '300.00', to_drivers: '150.00' });
  });
});
