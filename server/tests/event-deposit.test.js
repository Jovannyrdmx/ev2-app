/**
 * El anticipo por noche.
 *
 * La regla del club (D17) es que la mesa se aparta con un anticipo. Lo que se
 * prueba aquí es la sobrescritura por evento: un 31 de diciembre puede pedir el
 * 100% y un martes de temporada baja el 10%, sin mover la lista vigente.
 *
 * Los dos casos que de verdad importan, y que son fáciles de romper:
 *
 *   1. **`null` no es cero.** Una noche sin nada capturado usa la regla del club.
 *      Si se confundieran, cada noche normal se apartaría gratis.
 *   2. **Cambiar el anticipo no toca lo ya vendido.** El monto se congela en la
 *      reservación, así que subirlo a 100% para una noche grande NO hace que las
 *      doce mesas ya apartadas deban el resto. El servidor lo dice con una
 *      cabecera de aviso en vez de dejar que el gerente lo suponga.
 */
'use strict';

const { setupSchema, truncateAll, closePool, pool } = require('./helpers/db');
const { api, auth } = require('./helpers/api');
const f = require('./helpers/factories');
const { loadPriceList } = require('../seeds/price-list');
const pricing = require('../src/services/event-pricing');

let club; let guest; let manager; let hostess;

beforeAll(setupSchema);
afterAll(closePool);

beforeEach(async () => {
  await truncateAll();
  club = await f.createNightclub({ slug: 'ev2' });
  guest = await f.createUser(club.id, { role: 'guest' });
  manager = await f.createUser(club.id, { role: 'manager' });
  hostess = await f.createUser(club.id, { role: 'hostess' });
  await loadPriceList({ slug: 'ev2' });
  // La lista de precios carga las ZONAS, no las mesas. Sin una mesa de verdad en
  // una zona reservable, `availability` devuelve una lista vacia y la prueba
  // fallaria por no tener donde reservar, no por el anticipo.
  await f.createTable(club.id, { code: '39', section: 'ZONA ROJA', capacity: 8, type: 'booth' });
  await f.createTable(club.id, { code: '40', section: 'ZONA ROJA', capacity: 8, type: 'booth' });
});

const url = (p) => `/api/nightclubs/${club.id}${p}`;

/** Una noche que abre en 15 minutos: se puede reservar y el pase ya abre. */
async function crearNoche(over = {}) {
  const abre = new Date(Date.now() + 15 * 60_000).toISOString();
  const res = await api().post(url('/events')).set(auth(manager)).send({
    name: `Noche ${Math.random().toString(16).slice(2, 8)}`,
    event_date: new Date().toISOString().slice(0, 10),
    doors_open_at: abre,
    closes_at: new Date(Date.now() + 8 * 3_600_000).toISOString(),
    ticket_price: 100,
    status: 'published',
    ...over,
  });
  return res;
}

const reglas = (body) => api().put(url('/reservations/rules')).set(auth(manager)).send(body);

// ==========================================================================
// La aritmética, sin base de datos
// ==========================================================================

describe('qué anticipo le toca a una noche', () => {
  it('la noche manda sobre la regla del club', () => {
    expect(pricing.depositPctFor({ deposit_pct: 100 }, { deposit_pct: 30 })).toBe(100);
    expect(pricing.depositPctFor({ deposit_pct: 10 }, { deposit_pct: 30 })).toBe(10);
  });

  it('sin nada capturado, la del club', () => {
    expect(pricing.depositPctFor({ deposit_pct: null }, { deposit_pct: 30 })).toBe(30);
    expect(pricing.depositPctFor({}, { deposit_pct: 30 })).toBe(30);
    expect(pricing.depositPctFor(null, { deposit_pct: 30 })).toBe(30);
  });

  it('CERO es cero, no "usa la del club"', () => {
    // Es la distinción por la que existe la columna. Con un `||` en vez de un
    // `== null`, este caso cobraría 30% y el gerente no entendería por qué.
    expect(pricing.depositPctFor({ deposit_pct: 0 }, { deposit_pct: 30 })).toBe(0);
    expect(pricing.depositFor(5000, { deposit_pct: 0 }, { deposit_pct: 30 })).toBe(0);
  });

  it('Postgres devuelve NUMERIC como cadena, y eso no puede romperlo', () => {
    // `pg` entrega NUMERIC(5,2) como '100.00'. Sumar cadenas es como se calcula
    // un anticipo de "500.0030".
    expect(pricing.depositPctFor({ deposit_pct: '100.00' }, { deposit_pct: '30.00' })).toBe(100);
    expect(pricing.depositFor('5000.00', { deposit_pct: '10.00' }, {})).toBe(500);
  });

  it('el monto se redondea a centavos', () => {
    expect(pricing.depositFor(3333, { deposit_pct: 33 }, {})).toBe(1099.89);
    expect(pricing.depositFor(0, { deposit_pct: 100 }, {})).toBe(0);
  });

  it('sin regla de club y sin noche, cero: nunca NaN', () => {
    // Un NaN aquí se guarda como monto del anticipo y revienta el cobro después.
    expect(pricing.depositPctFor({}, {})).toBe(0);
    expect(pricing.depositFor(1000, null, null)).toBe(0);
  });
});

// ==========================================================================
// La noche
// ==========================================================================

describe('el gerente captura el anticipo de una noche', () => {
  it('se guarda y se devuelve', async () => {
    const res = await crearNoche({ deposit_pct: 100 });
    expect(res.status).toBe(201);
    expect(Number(res.body.event.deposit_pct)).toBe(100);
  });

  it('una noche sin capturar nada nace en null, no en cero', async () => {
    const res = await crearNoche();
    expect(res.body.event.deposit_pct).toBeNull();
  });

  it('se puede cambiar después', async () => {
    const ev = (await crearNoche()).body.event;
    const res = await api().patch(url(`/events/${ev.id}`)).set(auth(manager))
      .send({ deposit_pct: 50 });
    expect(Number(res.body.event.deposit_pct)).toBe(50);
  });

  it('y se puede devolver a la regla del club poniéndolo en null', async () => {
    const ev = (await crearNoche({ deposit_pct: 100 })).body.event;
    const res = await api().patch(url(`/events/${ev.id}`)).set(auth(manager))
      .send({ deposit_pct: null });
    expect(res.body.event.deposit_pct).toBeNull();
  });

  it('un porcentaje imposible se rechaza', async () => {
    for (const malo of [101, -1, 500]) {
      const res = await crearNoche({ deposit_pct: malo });
      expect({ malo, status: res.status }).toEqual({ malo, status: 400 });
    }
  });

  it('solo el gerente lo toca', async () => {
    const ev = (await crearNoche()).body.event;
    for (const quien of [guest, hostess]) {
      const res = await api().patch(url(`/events/${ev.id}`)).set(auth(quien))
        .send({ deposit_pct: 0 });
      expect(res.status).toBe(403);
    }
  });
});

// ==========================================================================
// Lo que se le cobra al cliente
// ==========================================================================

describe('la cotización usa el anticipo de la noche', () => {
  async function mesaLibre(eventId, token) {
    const res = await api().get(url(`/reservations/availability?event_id=${eventId}&guests=4`))
      .set(auth(token));
    return { res, mesa: (res.body.tables || []).find((t) => t.capacity >= 4) };
  }

  beforeEach(async () => {
    await reglas({ deposit_pct: 30, min_advance_hours: 0 });
  });

  it('la disponibilidad enseña el anticipo de ESA noche, no el del club', async () => {
    const ev = (await crearNoche({ deposit_pct: 100 })).body.event;
    const { res, mesa } = await mesaLibre(ev.id, guest);
    expect(Number(res.body.deposit_pct)).toBe(100);
    // Y el monto de cada mesa: el anticipo es el precio completo.
    expect(Number(mesa.deposit)).toBe(Number(mesa.price));
  });

  it('con la noche en null, el del club', async () => {
    const ev = (await crearNoche()).body.event;
    const { res, mesa } = await mesaLibre(ev.id, guest);
    expect(Number(res.body.deposit_pct)).toBe(30);
    expect(Number(mesa.deposit)).toBeCloseTo(Number(mesa.price) * 0.3, 2);
  });

  it('la cotización de una mesa concreta también', async () => {
    const ev = (await crearNoche({ deposit_pct: 10 })).body.event;
    const { mesa } = await mesaLibre(ev.id, guest);
    const res = await api().post(url('/reservations/quote')).set(auth(guest))
      .send({ event_id: ev.id, table_id: mesa.id, guest_count: 4 });
    expect(res.status).toBe(200);
    expect(Number(res.body.quote.deposit_pct)).toBe(10);
    expect(Number(res.body.quote.deposit))
      .toBeCloseTo(Number(res.body.quote.total) * 0.1, 2);
  });

  it('al reservar, el anticipo de la noche queda CONGELADO en la reservación', async () => {
    const ev = (await crearNoche({ deposit_pct: 100 })).body.event;
    const { mesa } = await mesaLibre(ev.id, guest);
    const creada = await api().post(url('/reservations')).set(auth(guest)).send({
      event_id: ev.id, table_id: mesa.id, guest_count: 4,
      client_request_id: require('crypto').randomUUID(),
    });
    expect(creada.status).toBe(201);
    const rid = creada.body.reservation.id;

    const { rows } = await pool.query(
      'SELECT total_estimated::text AS total, deposit_amount::text AS dep FROM reservations WHERE id = $1',
      [rid]);
    expect(Number(rows[0].dep)).toBe(Number(rows[0].total));

    // El gerente baja el anticipo de la noche DESPUÉS de esa venta.
    await api().patch(url(`/events/${ev.id}`)).set(auth(manager)).send({ deposit_pct: 10 });

    const despues = await pool.query(
      'SELECT deposit_amount::text AS dep FROM reservations WHERE id = $1', [rid]);
    expect(Number(despues.rows[0].dep)).toBe(Number(rows[0].dep));
  });

  it('y el asiento del libro se crea por ese mismo monto', async () => {
    const ev = (await crearNoche({ deposit_pct: 100 })).body.event;
    const { mesa } = await mesaLibre(ev.id, guest);
    const creada = await api().post(url('/reservations')).set(auth(guest)).send({
      event_id: ev.id, table_id: mesa.id, guest_count: 4,
      client_request_id: require('crypto').randomUUID(),
    });
    const { rows } = await pool.query(
      `SELECT t.amount::text AS monto, r.deposit_amount::text AS dep
         FROM transactions t JOIN reservations r ON r.id = t.reference_id
        WHERE t.type = 'reservation_deposit' AND r.id = $1`,
      [creada.body.reservation.id]);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].monto)).toBe(Number(rows[0].dep));
  });

  it('cambiar el anticipo con mesas ya vendidas AVISA, no lo hace en silencio', async () => {
    const ev = (await crearNoche({ deposit_pct: 30 })).body.event;
    const { mesa } = await mesaLibre(ev.id, guest);
    await api().post(url('/reservations')).set(auth(guest)).send({
      event_id: ev.id, table_id: mesa.id, guest_count: 4,
      client_request_id: require('crypto').randomUUID(),
    });

    const res = await api().patch(url(`/events/${ev.id}`)).set(auth(manager))
      .send({ deposit_pct: 100 });
    expect(res.status).toBe(200);
    expect(res.headers['x-warning']).toMatch(/1 reservation/);
    expect(res.headers['x-warning']).toMatch(/deposit/);
  });

  it('sin mesas vendidas no avisa nada: el aviso tiene que significar algo', async () => {
    const ev = (await crearNoche({ deposit_pct: 30 })).body.event;
    const res = await api().patch(url(`/events/${ev.id}`)).set(auth(manager))
      .send({ deposit_pct: 100 });
    expect(res.headers['x-warning']).toBeUndefined();
  });

  it('poner el mismo valor otra vez no avisa: no cambió nada', async () => {
    const ev = (await crearNoche({ deposit_pct: 30 })).body.event;
    const { mesa } = await mesaLibre(ev.id, guest);
    await api().post(url('/reservations')).set(auth(guest)).send({
      event_id: ev.id, table_id: mesa.id, guest_count: 4,
      client_request_id: require('crypto').randomUUID(),
    });
    const res = await api().patch(url(`/events/${ev.id}`)).set(auth(manager))
      .send({ deposit_pct: 30 });
    expect(res.headers['x-warning']).toBeUndefined();
  });

  it('una noche de anticipo CERO aparta sin cobrar, y no cae a la regla del club', async () => {
    const ev = (await crearNoche({ deposit_pct: 0 })).body.event;
    const { res, mesa } = await mesaLibre(ev.id, guest);
    expect(Number(res.body.deposit_pct)).toBe(0);
    expect(Number(mesa.deposit)).toBe(0);
  });
});
