'use strict';

const { randomUUID } = require('crypto');
const { setupSchema, truncateAll, closePool, pool } = require('./helpers/db');
const { api, auth } = require('./helpers/api');
const f = require('./helpers/factories');
const { loadPriceList } = require('../seeds/price-list');
const { loadMenu } = require('../seeds/menu');

let club; let guest; let other; let hostess; let manager; let bartender;
let roja; let azul; let general;

beforeAll(setupSchema);
afterAll(closePool);

beforeEach(async () => {
  await truncateAll();
  club = await f.createNightclub({ slug: 'ev2' });
  guest = await f.createUser(club.id, { role: 'guest' });
  other = await f.createUser(club.id, { role: 'guest' });
  hostess = await f.createUser(club.id, { role: 'hostess' });
  manager = await f.createUser(club.id, { role: 'manager' });
  bartender = await f.createUser(club.id, { role: 'bartender' });

  await loadPriceList({ slug: 'ev2' });
  // Las botellas y los extras salen del catalogo real de la caja, no de la lista de zonas.
  await loadMenu({ slug: 'ev2' });
  await pool.query(
    `INSERT INTO reservation_rules (nightclub_id, min_party_size, max_party_size, deposit_pct,
                                    currency, min_advance_hours)
     VALUES ($1, 2, 20, 30, 'MXN', 2)`, [club.id]);

  roja = await f.createTable(club.id, { code: '39', section: 'ZONA ROJA', capacity: 8, type: 'booth' });
  azul = await f.createTable(club.id, { code: 'AZ13', section: 'ZONA AZUL', capacity: 10, type: 'vip' });
  general = await f.createTable(club.id, { code: '5', section: 'GENERAL', capacity: 4 });
});

const url = (p) => `/api/nightclubs/${club.id}${p}`;

/** Creates an event that opens `hoursAhead` from now. */
async function makeEvent(over = {}, user = manager) {
  const hoursAhead = over.hoursAhead ?? 48;
  const doors = new Date(Date.now() + hoursAhead * 3_600_000);
  const body = {
    name: over.name || 'Noche de prueba',
    event_date: over.event_date || doors.toISOString().slice(0, 10),
    doors_open_at: doors.toISOString(),
    ticket_price: over.ticket_price ?? 250,
    status: over.status || 'published',
    ...(over.arrival_deadline_minutes ? { arrival_deadline_minutes: over.arrival_deadline_minutes } : {}),
  };
  const res = await api().post(url('/events')).set(auth(user)).send(body);
  return res;
}

describe('Eventos', () => {
  it('el gerente crea un evento con su precio de boleto', async () => {
    const res = await makeEvent({ name: 'Reggaetón Night', ticket_price: 300 });
    expect(res.status).toBe(201);
    expect(res.body.event).toMatchObject({ name: 'Reggaetón Night', ticket_price: '300.00', status: 'published' });
    expect(res.body.event.arrival_deadline).toBeTruthy();
  });

  it('calcula el plazo de llegada a 3 horas de la apertura', async () => {
    const res = await makeEvent();
    const doors = new Date(res.body.event.doors_open_at);
    const deadline = new Date(res.body.event.arrival_deadline);
    expect(deadline - doors).toBe(3 * 3_600_000);
  });

  it('permite un plazo de llegada distinto', async () => {
    const res = await makeEvent({ arrival_deadline_minutes: 120 });
    const doors = new Date(res.body.event.doors_open_at);
    expect(new Date(res.body.event.arrival_deadline) - doors).toBe(2 * 3_600_000);
  });

  it('no permite dos eventos la misma fecha', async () => {
    const first = await makeEvent();
    const res = await makeEvent({ event_date: String(first.body.event.event_date).slice(0, 10) });
    expect(res.status).toBe(409);
  });

  it('solo el gerente crea eventos', async () => {
    expect((await makeEvent({}, guest)).status).toBe(403);
    expect((await makeEvent({}, hostess)).status).toBe(403);
  });

  it('el cliente solo ve eventos publicados', async () => {
    await makeEvent({ name: 'Publicado', status: 'published' });
    await makeEvent({ name: 'Borrador', status: 'draft', hoursAhead: 72 });

    const asGuest = await api().get(url('/events')).set(auth(guest));
    expect(asGuest.body.events.map((e) => e.name)).toEqual(['Publicado']);

    const asManager = await api().get(url('/events')).set(auth(manager));
    expect(asManager.body.events).toHaveLength(2);
  });

  it('un cliente no puede abrir un evento en borrador', async () => {
    const ev = await makeEvent({ status: 'draft' });
    expect((await api().get(url(`/events/${ev.body.event.id}`)).set(auth(guest))).status).toBe(404);
    expect((await api().get(url(`/events/${ev.body.event.id}`)).set(auth(manager))).status).toBe(200);
  });

  it('el gerente edita y publica un evento', async () => {
    const ev = await makeEvent({ status: 'draft' });
    const res = await api().patch(url(`/events/${ev.body.event.id}`)).set(auth(manager))
      .send({ status: 'published', ticket_price: 400 });
    expect(res.status).toBe(200);
    expect(res.body.event).toMatchObject({ status: 'published', ticket_price: '400.00' });
  });

  it('avisa si cambia el boleto con reservaciones hechas', async () => {
    const ev = await makeEvent();
    await book(ev.body.event.id, roja.id, 8);

    const res = await api().patch(url(`/events/${ev.body.event.id}`)).set(auth(manager))
      .send({ ticket_price: 999 });
    expect(res.status).toBe(200);
    expect(res.headers['x-warning']).toMatch(/keep the price agreed/);
  });

  it('no borra un evento con reservaciones activas', async () => {
    const ev = await makeEvent();
    await book(ev.body.event.id, roja.id, 8);

    const res = await api().delete(url(`/events/${ev.body.event.id}`)).set(auth(manager));
    expect(res.status).toBe(409);
    expect(res.body.error.details.reservations).toBe(1);
  });

  it('sí borra un evento sin reservaciones', async () => {
    const ev = await makeEvent();
    expect((await api().delete(url(`/events/${ev.body.event.id}`)).set(auth(manager))).status).toBe(204);
  });
});

describe('Precios por zona y por evento', () => {
  it('devuelve la lista de precios vigente', async () => {
    const res = await api().get(url('/zone-pricing')).set(auth(guest));
    expect(res.status).toBe(200);

    const zonas = Object.fromEntries(res.body.zones.map((z) => [z.section, z]));
    expect(zonas['ZONA ROJA']).toMatchObject({ base_price: '5000.00', included_tickets: 8, max_extras: 0 });
    expect(zonas['ZONA AZUL']).toMatchObject({ base_price: '4500.00', included_tickets: 10, max_extras: 2 });
    expect(zonas['CELEBRATION SUITE'].base_price).toBe('8000.00');
    expect(zonas.GENERAL.reservable).toBe(false);
  });

  it('el gerente cambia la tarifa base de una zona', async () => {
    const res = await api().put(url('/zone-pricing/ZONA ROSA')).set(auth(manager))
      .send({ base_price: 4800, included_tickets: 6, max_extras: 3 });
    expect(res.status).toBe(200);
    expect(res.body.zone).toMatchObject({ base_price: '4800.00', max_extras: 3 });
  });

  it('un cliente no puede cambiar precios', async () => {
    const res = await api().put(url('/zone-pricing/ZONA ROSA')).set(auth(guest))
      .send({ base_price: 1, included_tickets: 1 });
    expect(res.status).toBe(403);
  });

  it('muestra las zonas con el precio de un evento', async () => {
    const ev = await makeEvent({ ticket_price: 250 });
    const res = await api().get(url(`/events/${ev.body.event.id}/zones`)).set(auth(guest));

    expect(res.status).toBe(200);
    expect(res.body.event.ticket_price).toBe('250.00');
    const roja2 = res.body.zones.find((z) => z.section === 'ZONA ROJA');
    expect(roja2).toMatchObject({ base_price: '5000.00', included_tickets: 8, max_extras: 0, max_guests: 8 });
  });

  it('el gerente ajusta una zona solo para un evento', async () => {
    const especial = await makeEvent({ name: 'Especial', hoursAhead: 48 });
    const normal = await makeEvent({ name: 'Normal', hoursAhead: 96 });

    const res = await api().put(url(`/events/${especial.body.event.id}/zones/ZONA ROJA`))
      .set(auth(manager))
      .send({ base_price: 7000, included_tickets: 10, max_extras: 2, note: 'Noche especial' });
    expect(res.status).toBe(200);

    const conAjuste = await api().get(url(`/events/${especial.body.event.id}/zones`)).set(auth(manager));
    const zonaEspecial = conAjuste.body.zones.find((z) => z.section === 'ZONA ROJA');
    expect(zonaEspecial).toMatchObject({
      base_price: '7000.00', included_tickets: 10, max_extras: 2, overridden: true,
    });

    // La otra noche conserva la tarifa de la lista.
    const sinAjuste = await api().get(url(`/events/${normal.body.event.id}/zones`)).set(auth(manager));
    const zonaNormal = sinAjuste.body.zones.find((z) => z.section === 'ZONA ROJA');
    expect(zonaNormal).toMatchObject({ base_price: '5000.00', included_tickets: 8, overridden: false });
  });

  it('un ajuste parcial hereda el resto de la lista', async () => {
    const ev = await makeEvent();
    await api().put(url(`/events/${ev.body.event.id}/zones/ZONA AZUL`)).set(auth(manager))
      .send({ base_price: 5500 }); // solo el precio

    const res = await api().get(url(`/events/${ev.body.event.id}/zones`)).set(auth(manager));
    const azul2 = res.body.zones.find((z) => z.section === 'ZONA AZUL');
    expect(azul2).toMatchObject({ base_price: '5500.00', included_tickets: 10, max_extras: 2 });
  });

  it('quitar el ajuste devuelve la zona a su tarifa', async () => {
    const ev = await makeEvent();
    await api().put(url(`/events/${ev.body.event.id}/zones/ZONA ROJA`)).set(auth(manager))
      .send({ base_price: 9000 });
    await api().delete(url(`/events/${ev.body.event.id}/zones/ZONA ROJA`)).set(auth(manager));

    const res = await api().get(url(`/events/${ev.body.event.id}/zones`)).set(auth(manager));
    expect(res.body.zones.find((z) => z.section === 'ZONA ROJA').base_price).toBe('5000.00');
  });

  it('rechaza ajustar una zona que no existe', async () => {
    const ev = await makeEvent();
    const res = await api().put(url(`/events/${ev.body.event.id}/zones/ZONA INVENTADA`))
      .set(auth(manager)).send({ base_price: 100 });
    expect(res.status).toBe(404);
  });

  it('lista botellas y extras del club', async () => {
    const res = await api().get(url('/reservation-products')).set(auth(guest));
    expect(res.status).toBe(200);
    const bottles = res.body.products.filter((p) => p.kind === 'bottle');
    const addons = res.body.products.filter((p) => p.kind === 'addon');
    // Las 48 botellas de la carta real y los tres extras que el club cobra de verdad.
    expect(bottles).toHaveLength(48);
    expect(addons).toHaveLength(3);
    expect(bottles.find((b) => b.code === 'pos-03022').name).toBe('MOET');
    expect(addons.find((a) => a.code === 'vip_wristband').price).toBe('100.00');
  });
});

// ---------------------------------------------------------------- reservations
async function book(eventId, tableId, guests, user = guest, extra = {}) {
  return api().post(url('/reservations')).set(auth(user)).send({
    client_request_id: randomUUID(),
    event_id: eventId,
    table_id: tableId,
    guest_count: guests,
    ...extra,
  });
}

describe('Reservación por noche', () => {
  it('cobra el precio de la zona cuando nadie sobra', async () => {
    const ev = await makeEvent({ ticket_price: 250 });
    const res = await book(ev.body.event.id, roja.id, 8);

    expect(res.status).toBe(201);
    expect(res.body.reservation.total_estimated).toBe('5000.00');
    expect(res.body.reservation.extra_guests).toBe(0);
    expect(res.body.reservation.deposit_amount).toBe('1500.00'); // 30%
  });

  it('cobra el boleto del evento por cada persona adicional', async () => {
    const ev = await makeEvent({ ticket_price: 250 });
    const res = await book(ev.body.event.id, azul.id, 12);

    // Zona Azul: 4,500 incluye 10 personas; 2 extras x 250 = 5,000
    expect(res.status).toBe(201);
    expect(res.body.reservation.total_estimated).toBe('5000.00');
    expect(res.body.reservation.extra_guests).toBe(2);
    expect(res.body.reservation.ticket_at_booking).toBe('250.00');
  });

  it('rechaza extras en una zona que no los admite', async () => {
    const ev = await makeEvent();
    const res = await book(ev.body.event.id, roja.id, 9);

    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/no admite extras/);
  });

  it('rechaza pasarse del máximo de extras', async () => {
    const ev = await makeEvent();
    const res = await book(ev.body.event.id, azul.id, 13);

    expect(res.status).toBe(422);
    expect(res.body.error.details.max_guests).toBe(12);
  });

  it('no permite reservar una zona marcada como no reservable', async () => {
    const ev = await makeEvent();
    const res = await book(ev.body.event.id, general.id, 4);
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/no se reserva/);
  });

  it('el precio del boleto se congela al reservar', async () => {
    const ev = await makeEvent({ ticket_price: 250 });
    const res = await book(ev.body.event.id, azul.id, 12);
    const total = res.body.reservation.total_estimated;

    await api().patch(url(`/events/${ev.body.event.id}`)).set(auth(manager)).send({ ticket_price: 900 });

    const after = await api().get(url(`/reservations/${res.body.reservation.id}`)).set(auth(guest));
    expect(after.body.reservation.total_estimated).toBe(total);
    expect(after.body.reservation.ticket_at_booking).toBe('250.00');
  });

  it('aplica el ajuste de precio del evento', async () => {
    const ev = await makeEvent({ ticket_price: 250 });
    await api().put(url(`/events/${ev.body.event.id}/zones/ZONA ROJA`)).set(auth(manager))
      .send({ base_price: 7000, included_tickets: 10, max_extras: 2 });

    const res = await book(ev.body.event.id, roja.id, 8);
    expect(res.body.reservation.total_estimated).toBe('7000.00');
    expect(res.body.reservation.zone_base_at_booking).toBe('7000.00');
  });

  it('la reservación abarca la noche y guarda el plazo de llegada', async () => {
    const ev = await makeEvent();
    const res = await book(ev.body.event.id, roja.id, 8);

    expect(res.body.reservation.starts_at).toBe(new Date(ev.body.event.doors_open_at).toISOString());
    const deadline = new Date(res.body.reservation.arrival_deadline);
    expect(deadline - new Date(ev.body.event.doors_open_at)).toBe(3 * 3_600_000);
  });

  it('una mesa no se puede reservar dos veces en el mismo evento', async () => {
    const ev = await makeEvent();
    expect((await book(ev.body.event.id, roja.id, 8)).status).toBe(201);

    const res = await book(ev.body.event.id, roja.id, 8, other);
    expect(res.status).toBe(409);
  });

  it('la misma mesa sí se reserva en eventos distintos', async () => {
    const a = await makeEvent({ hoursAhead: 48 });
    const b = await makeEvent({ hoursAhead: 96 });
    expect((await book(a.body.event.id, roja.id, 8)).status).toBe(201);
    expect((await book(b.body.event.id, roja.id, 8, other)).status).toBe(201);
  });

  it('cancelar libera la mesa para ese evento', async () => {
    const ev = await makeEvent();
    const first = await book(ev.body.event.id, roja.id, 8);
    await api().post(url(`/reservations/${first.body.reservation.id}/cancel`)).set(auth(guest)).send({});

    expect((await book(ev.body.event.id, roja.id, 8, other)).status).toBe(201);
  });

  it('es idempotente', async () => {
    const ev = await makeEvent();
    const id = randomUUID();
    const body = { client_request_id: id, event_id: ev.body.event.id, table_id: roja.id, guest_count: 8 };

    const first = await api().post(url('/reservations')).set(auth(guest)).send(body);
    const second = await api().post(url('/reservations')).set(auth(guest)).send(body);
    expect(second.status).toBe(200);
    expect(second.body.reservation.id).toBe(first.body.reservation.id);
  });

  it('no reserva en un evento cancelado', async () => {
    const ev = await makeEvent();
    await api().patch(url(`/events/${ev.body.event.id}`)).set(auth(manager)).send({ status: 'cancelled' });

    const res = await book(ev.body.event.id, roja.id, 8);
    expect(res.status).toBe(422);
  });

  it('respeta la anticipación mínima', async () => {
    const ev = await makeEvent({ hoursAhead: 1 });
    const res = await book(ev.body.event.id, roja.id, 8);
    expect(res.status).toBe(422);
  });

  it('suma botellas y extras del catálogo por su código', async () => {
    const ev = await makeEvent({ ticket_price: 250 });
    const res = await book(ev.body.event.id, roja.id, 8, guest, {
      // Codigos de la carta real: MOET ($3,500) y la pulsera extra VIP ($100).
      addons: [{ code: 'pos-03022', quantity: 2 }, { code: 'vip_wristband', quantity: 1 }],
    });

    // 5,000 + 2 x 3,500 + 100 = 12,100
    expect(res.status).toBe(201);
    expect(res.body.reservation.total_estimated).toBe('12100.00');
  });

  it('rechaza un producto inexistente', async () => {
    const ev = await makeEvent();
    const res = await book(ev.body.event.id, roja.id, 8, guest, {
      addons: [{ code: 'no-existe', quantity: 1 }],
    });
    expect(res.status).toBe(404);
  });
});

describe('Disponibilidad por evento', () => {
  it('lista mesas libres con su precio ya calculado', async () => {
    const ev = await makeEvent({ ticket_price: 250 });
    const res = await api().get(url(`/reservations/availability?event_id=${ev.body.event.id}&guests=8`))
      .set(auth(guest));

    expect(res.status).toBe(200);
    const codes = res.body.tables.map((t) => t.code);
    expect(codes).toContain('39'); // Zona Roja admite 8
    expect(codes).not.toContain('5'); // General no es reservable
    const rojaFree = res.body.tables.find((t) => t.code === '39');
    expect(rojaFree.price).toBe(5000);
    expect(rojaFree.deposit).toBe(1500);
  });

  it('oculta las mesas ya reservadas para ese evento', async () => {
    const ev = await makeEvent();
    await book(ev.body.event.id, roja.id, 8);

    const res = await api().get(url(`/reservations/availability?event_id=${ev.body.event.id}&guests=8`))
      .set(auth(guest));
    expect(res.body.tables.map((t) => t.code)).not.toContain('39');
  });

  it('excluye zonas que no admiten ese número de personas', async () => {
    const ev = await makeEvent();
    const res = await api().get(url(`/reservations/availability?event_id=${ev.body.event.id}&guests=12`))
      .set(auth(guest));

    const codes = res.body.tables.map((t) => t.code);
    expect(codes).toContain('AZ13'); // Azul llega a 12
    expect(codes).not.toContain('39'); // Roja tope 8
  });
});

describe('No llegó: liberación sin reembolso', () => {
  /** Books and then moves the deadline into the past, as if the night had happened. */
  async function bookAndExpire(eventId, tableId, guests = 8) {
    const res = await book(eventId, tableId, guests);
    await pool.query(
      `UPDATE reservations SET arrival_deadline = now() - interval '10 minutes' WHERE id = $1`,
      [res.body.reservation.id]);
    return res.body.reservation.id;
  }

  it('libera las reservaciones con el plazo vencido', async () => {
    const ev = await makeEvent();
    const id = await bookAndExpire(ev.body.event.id, roja.id);

    const res = await api().post(url('/reservations/release-no-shows')).set(auth(hostess)).send({});
    expect(res.status).toBe(200);
    expect(res.body.released).toBe(1);

    const after = await pool.query('SELECT status, refund_amount FROM reservations WHERE id = $1', [id]);
    expect(after.rows[0].status).toBe('no_show');
    expect(Number(after.rows[0].refund_amount)).toBe(0);
  });

  it('deja la mesa libre para otra persona', async () => {
    const ev = await makeEvent();
    await bookAndExpire(ev.body.event.id, roja.id);
    await api().post(url('/reservations/release-no-shows')).set(auth(hostess)).send({});

    expect((await book(ev.body.event.id, roja.id, 8, other)).status).toBe(201);
  });

  it('no toca las que aún están en plazo', async () => {
    const ev = await makeEvent();
    const res = await book(ev.body.event.id, roja.id, 8);

    const released = await api().post(url('/reservations/release-no-shows')).set(auth(hostess)).send({});
    expect(released.body.released).toBe(0);

    const after = await pool.query('SELECT status FROM reservations WHERE id = $1',
      [res.body.reservation.id]);
    expect(after.rows[0].status).toBe('pending_payment');
  });

  it('se puede llamar varias veces sin efectos raros', async () => {
    const ev = await makeEvent();
    await bookAndExpire(ev.body.event.id, roja.id);

    const first = await api().post(url('/reservations/release-no-shows')).set(auth(hostess)).send({});
    const second = await api().post(url('/reservations/release-no-shows')).set(auth(hostess)).send({});
    expect(first.body.released).toBe(1);
    expect(second.body.released).toBe(0);
  });

  it('cancelar después del plazo no reembolsa nada, aunque falten días', async () => {
    // Evento lejano: por ventana tocaría 100%, pero el plazo de llegada ya venció.
    const ev = await makeEvent({ hoursAhead: 200 });
    const res = await book(ev.body.event.id, roja.id, 8);
    await pool.query(
      `UPDATE reservations SET arrival_deadline = now() - interval '1 hour' WHERE id = $1`,
      [res.body.reservation.id]);
    await pool.query(`UPDATE transactions SET status = 'paid' WHERE reference_id = $1`,
      [res.body.reservation.id]);

    const cancel = await api().post(url(`/reservations/${res.body.reservation.id}/cancel`))
      .set(auth(guest)).send({});
    expect(cancel.body.refund_pct).toBe(0);
    expect(cancel.body.refund_amount).toBe(0);
    expect(cancel.body.missed_arrival).toBe(true);
  });

  it('solo el personal puede liberarlas', async () => {
    expect((await api().post(url('/reservations/release-no-shows')).set(auth(guest)).send({})).status)
      .toBe(403);
    expect((await api().post(url('/reservations/release-no-shows')).set(auth(bartender)).send({})).status)
      .toBe(403);
  });
});
