'use strict';

// Precio y personas por mesa VIP (D103): dos mesas de la misma zona pueden costar y
// admitir distinto; una mesa sin precio propio usa el de su zona; y una sobrescritura de
// la NOCHE manda sobre la mesa.

const { randomUUID } = require('crypto');
const { setupSchema, truncateAll, closePool, pool } = require('./helpers/db');
const { api, auth } = require('./helpers/api');
const f = require('./helpers/factories');
const { loadPriceList } = require('../seeds/price-list');
const eventPricing = require('../src/services/event-pricing');

let club; let guest; let manager; let admin; let a; let b; let event;

beforeAll(setupSchema);
afterAll(closePool);

beforeEach(async () => {
  await truncateAll();
  club = await f.createNightclub({ slug: 'ev2-vip' });
  guest = await f.createUser(club.id, { role: 'guest' });
  manager = await f.createUser(club.id, { role: 'manager' });
  admin = await f.createUser(club.id, { role: 'admin' });
  await loadPriceList({ slug: 'ev2-vip' });
  await f.createReservationRules(club.id, { deposit_pct: 30, min_party_size: 2, max_party_size: 20 });
  // Dos mesas de la MISMA zona (ZONA AZUL: $4,500, 10 personas, 2 extras).
  a = await f.createTable(club.id, { code: 'V1', section: 'ZONA AZUL', capacity: 10, type: 'vip' });
  b = await f.createTable(club.id, { code: 'V2', section: 'ZONA AZUL', capacity: 10, type: 'vip' });
  const doors = new Date(Date.now() + 7 * 24 * 3_600_000);
  event = (await api().post(url('/events')).set(auth(manager)).send({
    name: 'Noche', event_date: doors.toISOString().slice(0, 10), doors_open_at: doors.toISOString(),
    ticket_price: 250, status: 'published',
  })).body.event;
});

const url = (p) => `/api/nightclubs/${club.id}${p}`;
const setTable = (t, vip_price, vip_capacity) => pool.query(
  'UPDATE tables SET vip_price = $2, vip_capacity = $3 WHERE id = $1', [t.id, vip_price, vip_capacity]);
const disponibles = async (guests) => {
  const res = await api().get(url(`/reservations/availability?event_id=${event.id}&guests=${guests}`))
    .set(auth(guest));
  return Object.fromEntries(res.body.tables.map((t) => [t.code, t]));
};

describe('forTable', () => {
  const zona = { base_price: 4500, included_tickets: 10 };

  test('sin datos de mesa deja la zona intacta', () => {
    expect(eventPricing.forTable(zona, { vip_price: null, vip_capacity: null })).toEqual(zona);
    expect(eventPricing.forTable(zona, null)).toBe(zona);
  });

  test('la mesa manda sobre la zona; la noche manda sobre la mesa', () => {
    expect(eventPricing.forTable(zona, { vip_price: '8000.00', vip_capacity: 8 }))
      .toMatchObject({ base_price: '8000.00', included_tickets: 8 });
    expect(eventPricing.forTable({ ...zona, base_price_overridden: true }, { vip_price: 8000, vip_capacity: 8 }))
      .toMatchObject({ base_price: 4500, included_tickets: 8 });
    expect(eventPricing.forTable({ ...zona, included_overridden: true }, { vip_price: 8000, vip_capacity: 8 }))
      .toMatchObject({ base_price: 8000, included_tickets: 10 });
  });

  test('un precio de 0 es un precio (mesa de cortesía)', () => {
    expect(eventPricing.forTable(zona, { vip_price: 0 }).base_price).toBe(0);
  });
});

describe('cotización por mesa', () => {
  it('sin precio propio, ambas mesas cuestan lo de la zona', async () => {
    const t = await disponibles(10);
    expect(t.V1.price).toBe(4500);
    expect(t.V2.price).toBe(4500);
  });

  it('dos mesas de la misma zona con precio y personas distintos', async () => {
    await setTable(a, 5000, 6);
    await setTable(b, 8000, 8);
    const t = await disponibles(6);
    expect(t.V1.price).toBe(5000);
    expect(t.V2.price).toBe(8000);
    expect(t.V1.zone).toMatchObject({ base_price: 5000, included_tickets: 6 });
    // 9 personas: la de 6 (+2 extras máximo) ya no alcanza, la de 8 sí (1 extra de $250).
    const nueve = await disponibles(9);
    expect(nueve.V1).toBeUndefined();
    expect(nueve.V2.price).toBe(8250);
  });

  it('la reservación cobra el precio de SU mesa', async () => {
    await setTable(b, 8000, 8);
    const res = await api().post(url('/reservations')).set(auth(guest)).send({
      client_request_id: randomUUID(), event_id: event.id, table_id: b.id, guest_count: 8 });
    expect(res.status).toBe(201);
    expect(Number(res.body.reservation.total_estimated)).toBe(8000);
    const otra = await api().post(url('/reservations')).set(auth(guest)).send({
      client_request_id: randomUUID(), event_id: event.id, table_id: a.id, guest_count: 8 });
    expect(Number(otra.body.reservation.total_estimated)).toBe(4500);
  });

  it('un precio de la noche para la zona manda sobre el de la mesa', async () => {
    await setTable(b, 8000, 8);
    await pool.query(
      `INSERT INTO event_zone_pricing (event_id, section, base_price) VALUES ($1, 'ZONA AZUL', 3000)`,
      [event.id]);
    const t = await disponibles(8);
    expect(t.V2.price).toBe(3000);
    expect(t.V1.price).toBe(3000);
  });
});

describe('edición desde el plano', () => {
  const layout = (user, tables) => api().put(url('/tables/layout')).set(auth(user)).send({ tables });

  it('el administrador fija y quita precio y personas de una mesa', async () => {
    expect((await layout(admin, [{ id: a.id, vip_price: 5000, vip_capacity: 6 }])).status).toBe(200);
    let lista = await api().get(url('/tables')).set(auth(guest));
    expect(lista.body.tables.find((t) => t.code === 'V1')).toMatchObject({ vip_price: '5000.00', vip_capacity: 6 });
    expect((await layout(admin, [{ id: a.id, vip_price: null, vip_capacity: null }])).status).toBe(200);
    lista = await api().get(url('/tables')).set(auth(guest));
    expect(lista.body.tables.find((t) => t.code === 'V1')).toMatchObject({ vip_price: null, vip_capacity: null });
  });

  it('valida: sin negativos y solo el administrador', async () => {
    expect((await layout(admin, [{ id: a.id, vip_price: -1 }])).status).toBe(400);
    expect((await layout(admin, [{ id: a.id, vip_capacity: 0 }])).status).toBe(400);
    expect((await layout(manager, [{ id: a.id, vip_price: 100 }])).status).toBe(403);
  });
});
