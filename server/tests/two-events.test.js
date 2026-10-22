/**
 * Dos eventos el mismo día (D130): una tardeada y la noche.
 *
 *   * Se crean con la misma fecha si sus horarios no se enciman; encimados, 409 con el
 *     nombre y las horas del otro. Un cancelado no estorba; sin cierre se cuentan 8 h.
 *   * Cada uno es "el evento en curso" en su horario: la caja abre con el rol de ESE
 *     evento y las promociones son solo las suyas.
 */
'use strict';

const { randomUUID } = require('crypto');
const { setupSchema, truncateAll, closePool, pool } = require('./helpers/db');
const { api, auth } = require('./helpers/api');
const f = require('./helpers/factories');
const pins = require('../src/services/pins');

let club; let manager; let cajero; let waiter; let beer; let pinGerente;

beforeAll(setupSchema);
afterAll(closePool);

const url = (p) => `/api/nightclubs/${club.id}${p}`;
const H = 3_600_000;
const at = (h) => new Date(Date.now() + h * H).toISOString();

beforeEach(async () => {
  await truncateAll();
  club = await f.createNightclub({ slug: 'ev2-dos-eventos' });
  manager = await f.createUser(club.id, { role: 'manager', display_name: 'Gerente' });
  cajero = await f.createUser(club.id, { role: 'cashier', display_name: 'Caja' });
  waiter = await f.createUser(club.id, { role: 'waiter', on_shift: true, display_name: 'Luis' });
  beer = await f.createDrink(club.id, { name: 'Cerveza', price: 60, category: 'beer', stock: 100 });
  pinGerente = await pins.issuePin(pool, { userId: manager.id });
  await pool.query('UPDATE users SET must_change_pin = false WHERE id = $1', [manager.id]);
});

const evento = (name, desde, hasta, over = {}) => api().post(url('/events')).set(auth(manager)).send({
  name, event_date: '2026-11-07', doors_open_at: at(desde),
  ...(hasta === null ? {} : { closes_at: at(hasta) }),
  ticket_price: 0, status: 'published', ...over,
});

describe('Dos eventos el mismo día (D130)', () => {
  it('tardeada y noche el mismo día; encimados no, con el nombre del otro', async () => {
    const tarde = await evento('Tardeada', 24, 29);
    const noche = await evento('Noche', 29, 35);
    expect(tarde.status).toBe(201);
    expect(noche.status).toBe(201);
    const encima = await evento('Otra', 28, 30);
    expect(encima.status).toBe(409);
    expect(encima.body.error.message).toMatch(/Tardeada/);
    expect(encima.body.error.details).toMatchObject({ reason: 'event_overlap', event_id: tarde.body.event.id });
    const lista = await api().get(url('/events?limit=10')).set(auth(manager));
    expect(lista.body.events.filter((e) => String(e.event_date).startsWith('2026-11-07'))).toHaveLength(2);
  });

  it('sin hora de cierre cuenta 8 horas; un cancelado no estorba; mover uno encima se rechaza', async () => {
    const a = await evento('Sin cierre', 24, null);
    expect((await evento('A las 5 h', 29, 31)).status).toBe(409);
    expect((await evento('A las 8 h', 32, 34)).status).toBe(201);
    await api().patch(url(`/events/${a.body.event.id}`)).set(auth(manager)).send({ status: 'cancelled' });
    const b = await evento('Ahora sí', 25, 30);
    expect(b.status).toBe(201);
    const mover = await api().patch(url(`/events/${b.body.event.id}`)).set(auth(manager))
      .send({ closes_at: at(33) });
    expect(mover.status).toBe(409);
    // Revivir el cancelado encima de otro tampoco.
    const revivir = await api().patch(url(`/events/${a.body.event.id}`)).set(auth(manager))
      .send({ status: 'published' });
    expect(revivir.status).toBe(409);
  });

  it('la caja abre con el rol del evento en curso: la tardeada ya cerró, toca la noche', async () => {
    const { rows: [tarde] } = await pool.query(
      `INSERT INTO events_calendar (nightclub_id, name, event_date, doors_open_at, closes_at, status)
       VALUES ($1,'Tardeada', current_date, now() - interval '6 hours', now() - interval '1 hour', 'published')
       RETURNING id`, [club.id]);
    const { rows: [noche] } = await pool.query(
      `INSERT INTO events_calendar (nightclub_id, name, event_date, doors_open_at, closes_at, status)
       VALUES ($1,'Noche', current_date, now() - interval '30 minutes', now() + interval '5 hours', 'published')
       RETURNING id`, [club.id]);
    // Solo está en el rol de la tardeada: ya no puede abrir.
    await api().post(url(`/nights/${tarde.id}/roster`)).set(auth(manager)).send({ user_id: cajero.id, location_id: club.bar_id });
    const abrir = () => api().post(url('/till/open')).set(auth(cajero)).send({ opening_float: 0, manager_pin: pinGerente });
    expect((await abrir()).status).toBe(422);
    await api().post(url(`/nights/${noche.id}/roster`)).set(auth(manager)).send({ user_id: cajero.id, location_id: club.bar_id });
    const ok = await abrir();
    expect(ok.status).toBe(201);
    expect(ok.body.till).toBeTruthy();
    const estado = await api().get(url('/till')).set(auth(cajero));
    expect(estado.body.till).toBeTruthy();
  });

  it('las promociones son solo las del evento en curso', async () => {
    const insert = (name, desde, hasta) => pool.query(
      `INSERT INTO events_calendar (nightclub_id, name, event_date, doors_open_at, closes_at, status)
       SELECT c.id, $2, ((now() AT TIME ZONE c.timezone) - interval '6 hours')::date,
              now() + $3::interval, now() + $4::interval, 'published'
         FROM nightclubs c WHERE c.id = $1 RETURNING id`, [club.id, name, desde, hasta]);
    const { rows: [enCurso] } = await insert('En curso', '-1 hour', '2 hours');
    const { rows: [despues] } = await insert('Después', '2 hours', '7 hours');
    const crear = (ev, name) => api().post(url(`/events/${ev.id}/promotions`)).set(auth(manager))
      .send({ name, kind: 'n_for_m', buy_qty: 2, pay_qty: 1, drink_id: beer.id });
    expect((await crear(enCurso, '2x1 tarde')).status).toBe(201);
    expect((await crear(despues, '2x1 noche')).status).toBe(201);
    const vigentes = await api().get(url('/promotions/active')).set(auth(waiter));
    expect(vigentes.status).toBe(200);
    const nombres = (vigentes.body.promotions || []).map((p) => p.name);
    expect(nombres).toEqual(['2x1 tarde']);
    expect(randomUUID).toBeTruthy();
  });
});
