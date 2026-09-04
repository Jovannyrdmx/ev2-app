'use strict';

// Reconexión con lastEventId (D27): quien se quedó sin señal recupera al volver lo que
// se perdió, en orden, sin repetidos y sin ver lo que no era para él.

const WebSocket = require('ws');
const { setupSchema, truncateAll, closePool, pool } = require('./helpers/db');
const { signAccessToken } = require('../src/middleware/auth');
const { createRealtimeServer, extractSinceId, RESUME_MAX_EVENTS } = require('../src/ws');
const { pendingAfter } = require('../src/realtime/hub');
const events = require('../src/services/events');
const f = require('./helpers/factories');

let realtime; let port;
let club; let otherClub; let guest; let bartender; let outsider;

beforeAll(async () => {
  await setupSchema();
  realtime = createRealtimeServer();
  await new Promise((resolve) => realtime.server.listen(0, resolve));
  port = realtime.server.address().port;
});

afterAll(async () => {
  await realtime.close();
  await closePool();
});

beforeEach(async () => {
  await truncateAll();
  club = await f.createNightclub({ slug: 'ev2-resume' });
  otherClub = await f.createNightclub({ name: 'Otro', slug: 'otro-resume' });
  guest = await f.createUser(club.id, { role: 'guest', display_name: 'Ana' });
  bartender = await f.createUser(club.id, { role: 'bartender' });
  outsider = await f.createUser(otherClub.id, { role: 'guest' });
});

const sockets = [];
afterEach(() => {
  while (sockets.length) {
    const ws = sockets.pop();
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
  }
});

function open(user, { sinceId } = {}) {
  const q = sinceId === undefined ? '' : `?since_id=${sinceId}`;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/${q}`, ['bearer', signAccessToken(user)]);
  sockets.push(ws);
  const seen = [];
  ws.on('message', (raw) => seen.push(JSON.parse(raw)));
  return {
    ws,
    seen,
    async waitFor(type, ms = 4000) {
      const until = Date.now() + ms;
      for (;;) {
        const hit = seen.find((m) => m.type === type);
        if (hit) return hit;
        if (Date.now() > until) throw new Error(`timeout ${type}: ${JSON.stringify(seen)}`);
        await new Promise((r) => setTimeout(r, 15));
      }
    },
    replayed: () => seen.filter((m) => m.type === 'event').map((m) => m.payload.i),
  };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Writes n events for the club and returns their ids as strings. */
async function seed(n, { nightclubId = null, audience = {}, type = 'tick' } = {}) {
  const ids = [];
  for (let i = 0; i < n; i += 1) {
    const row = await events.publish({
      nightclubId: nightclubId || club.id, type, audience, payload: { i },
    });
    ids.push(String(row.id));
  }
  return ids;
}

// ---------------------------------------------------------------- lo básico

describe('Recuperar lo perdido', () => {
  it('el welcome entrega el punto de partida y reconectar con él trae lo que faltaba', async () => {
    const first = open(guest);
    const welcome = await first.waitFor('welcome');
    expect(welcome.resuming).toBe(false);
    expect(welcome.last_event_id).toBe('0');
    first.ws.close();

    // Se cae la señal y pasan cosas.
    await seed(3);

    const back = open(guest, { sinceId: welcome.last_event_id });
    const started = await back.waitFor('resume_started');
    expect(started).toMatchObject({ since_id: '0', count: 3 });
    const done = await back.waitFor('resume_complete');
    expect(done).toMatchObject({ delivered: 3, complete: true });
    expect(back.replayed()).toEqual([0, 1, 2]);
    // Y el último id sirve como punto de partida de la próxima reconexión.
    expect(done.last_event_id).toBe(
      (await pool.query('SELECT max(id)::text AS id FROM events')).rows[0].id);
  });

  it('sin since_id no reproduce nada: es una sesión nueva, no una reconexión', async () => {
    await seed(3);
    const fresh = open(guest);
    const welcome = await fresh.waitFor('welcome');
    expect(welcome.resuming).toBe(false);
    await wait(200);
    expect(fresh.seen.some((m) => m.type === 'resume_started')).toBe(false);
    expect(fresh.replayed()).toEqual([]);
  });

  it('un since_id ya al día no trae nada y lo dice sin inventar un error', async () => {
    const ids = await seed(2);
    const back = open(guest, { sinceId: ids[ids.length - 1] });
    const done = await back.waitFor('resume_complete');
    expect(done).toMatchObject({ delivered: 0, complete: true });
    expect(back.replayed()).toEqual([]);
  });

  it('un since_id del futuro tampoco rompe nada', async () => {
    await seed(2);
    const back = open(guest, { sinceId: '999999' });
    expect(await back.waitFor('resume_complete')).toMatchObject({ delivered: 0 });
  });

  it('un since_id que no es un número se avisa y la conexión sigue en vivo', async () => {
    expect(extractSinceId({ url: '/?since_id=12' })).toEqual({ sinceId: 12n, invalid: false });
    expect(extractSinceId({ url: '/?since_id=abc' })).toEqual({ sinceId: null, invalid: true });
    expect(extractSinceId({ url: '/?since_id=-1' })).toEqual({ sinceId: null, invalid: true });
    expect(extractSinceId({ url: '/' })).toEqual({ sinceId: null, invalid: false });

    const bad = open(guest, { sinceId: 'ayer' });
    const err = await bad.waitFor('error');
    expect(err.code).toBe('bad_since_id');
    // Sigue viva y entregando.
    realtime.deliver({
      id: 77, nightclub_id: club.id, type: 'table_updated', audience: {},
      payload: { i: 99 }, created_at: new Date().toISOString(),
    });
    expect((await bad.waitFor('event')).payload).toEqual({ i: 99 });
  });
});

// ---------------------------------------------------------------- no filtra nada

describe('Reconectar no es una puerta trasera', () => {
  it('solo se reproduce lo que era para esa persona', async () => {
    await seed(1, { audience: { roles: ['bartender'] }, type: 'order_created' });
    await seed(1, { audience: { userIds: [bartender.id] }, type: 'tip_received' });
    await seed(1, { audience: {}, type: 'table_updated' });

    const ana = open(guest, { sinceId: '0' });
    const done = await ana.waitFor('resume_complete');
    // De los tres, solo el que no tenía audiencia es suyo.
    expect(done.delivered).toBe(1);
    expect(ana.seen.filter((m) => m.type === 'event').map((m) => m.event_type))
      .toEqual(['table_updated']);
  });

  it('lo de otro club no se reproduce ni pidiéndolo', async () => {
    await seed(3, { nightclubId: otherClub.id });
    const ana = open(guest, { sinceId: '0' });
    expect(await ana.waitFor('resume_complete')).toMatchObject({ delivered: 0 });

    // Y el de aquel club sí ve los suyos, prueba de que los eventos existen.
    const fuera = open(outsider, { sinceId: '0' });
    expect((await fuera.waitFor('resume_complete')).delivered).toBe(3);
  });

  it('no se reproduce lo más viejo que la retención', async () => {
    const ids = await seed(2);
    await pool.query(
      `UPDATE events SET created_at = now() - interval '30 hours' WHERE id = $1`, [ids[0]]);
    const back = open(guest, { sinceId: '0' });
    const done = await back.waitFor('resume_complete');
    expect(done.delivered).toBe(1);
    expect(back.replayed()).toEqual([1]);
  });
});

// ---------------------------------------------------------------- orden y duplicados

describe('Orden y duplicados', () => {
  it('un evento en vivo durante la reproducción se entrega después, no en medio', async () => {
    await seed(3);
    const back = open(guest, { sinceId: '0' });
    await back.waitFor('welcome');

    // Llega algo en vivo mientras todavía se está reproduciendo.
    realtime.deliver({
      id: 9999, nightclub_id: club.id, type: 'en_vivo', audience: {},
      payload: { i: 'vivo' }, created_at: new Date().toISOString(),
    });

    await back.waitFor('resume_complete');
    await wait(150);
    const order = back.seen.filter((m) => m.type === 'event').map((m) => m.payload.i);
    expect(order).toEqual([0, 1, 2, 'vivo']);
    // Y el aviso de fin llegó antes que el evento en vivo.
    const iDone = back.seen.findIndex((m) => m.type === 'resume_complete');
    const iLive = back.seen.findIndex((m) => m.payload?.i === 'vivo');
    expect(iDone).toBeLessThan(iLive);
  });

  it('no se ve dos veces lo que entró en la reproducción y también en vivo', () => {
    // La ventana en que un evento en vivo se retiene dura lo que tarda una consulta:
    // real, pero imposible de provocar desde fuera. La regla se prueba aquí directamente
    // y el orden, de punta a punta, en la prueba anterior.
    const msg = (i) => ({ type: 'event', payload: { i } });
    const buffered = [
      { id: 5n, message: msg(5) },   // ya venía en la reproducción
      { id: 9n, message: msg(9) },   // justo el último reproducido
      { id: 10n, message: msg(10) }, // nuevo
      { id: 11n, message: msg(11) },
    ];
    expect(pendingAfter(buffered, 9n).map((m) => m.payload.i)).toEqual([10, 11]);
    // Sin nada reproducido todavía, no se descarta nada.
    expect(pendingAfter(buffered, null).map((m) => m.payload.i)).toEqual([5, 9, 10, 11]);
    expect(pendingAfter([], 9n)).toEqual([]);
    // El corte compara enteros de 64 bits, no cadenas: '10' > '9' como texto sería falso.
    expect(pendingAfter([{ id: 10n, message: msg(10) }], 9n)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------- el hueco demasiado grande

describe('Cuando el hueco es más grande de lo que se puede reproducir', () => {
  it('lo admite y pide recargar en vez de entregar una historia a medias', async () => {
    // Se insertan de golpe: uno por uno serían 501 viajes a la base.
    await pool.query(
      `INSERT INTO events (nightclub_id, type, audience, payload)
       SELECT $1, 'tick', '{}'::jsonb, jsonb_build_object('i', g)
         FROM generate_series(1, $2) AS g`,
      [club.id, RESUME_MAX_EVENTS + 1]);

    const back = open(guest, { sinceId: '0' });
    const done = await back.waitFor('resume_complete');
    expect(done.delivered).toBe(RESUME_MAX_EVENTS);
    expect(done.complete).toBe(false);

    const resync = await back.waitFor('resync_required');
    expect(resync.reason).toBe('gap_too_large');
    expect(resync.message).toMatch(/vuelve a cargar/i);
  });
});
