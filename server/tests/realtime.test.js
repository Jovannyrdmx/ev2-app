'use strict';

// Relevo de eventos: Postgres -> Redis -> socket (D26). Contra Postgres y Redis reales.
//
// Lo que estas pruebas cuidan de verdad: que un evento escrito dentro de una transacción
// **no salga hasta que la transacción confirme**, y que si se deshace no salga nunca.

const WebSocket = require('ws');
const { createClient } = require('redis');
const { setupSchema, truncateAll, closePool, pool } = require('./helpers/db');
const { signAccessToken } = require('../src/middleware/auth');
const { createRealtimeServer } = require('../src/ws');
const { EventRelay, CHANNEL, LIVE_WINDOW_SECONDS } = require('../src/realtime/relay');
const { EventSubscriber } = require('../src/realtime/subscriber');
const events = require('../src/services/events');
const f = require('./helpers/factories');

const redisOptions = {
  socket: {
    host: process.env.REDIS_HOST || 'localhost',
    port: Number(process.env.REDIS_PORT || 6379),
  },
};

let redis; let relay; let subscriber; let realtime; let port;
let club; let otherClub; let guest; let bartender;

beforeAll(async () => {
  await setupSchema();
  redis = createClient(redisOptions);
  await redis.connect();
});

afterAll(async () => {
  if (subscriber) await subscriber.stop();
  if (relay) await relay.stop();
  if (realtime) await realtime.close();
  if (redis?.isOpen) await redis.quit();
  await closePool();
});

beforeEach(async () => {
  await truncateAll();
  // 0 significa «relevar desde el primer evento». NULL es distinto: «este relevo
  // nunca ha corrido aquí», y entonces arranca desde el más reciente.
  await pool.query('UPDATE realtime_relay_state SET last_event_id = 0, leader_instance = NULL WHERE id = 1');
  club = await f.createNightclub({ slug: 'ev2-rt' });
  otherClub = await f.createNightclub({ name: 'Otro', slug: 'otro-rt' });
  guest = await f.createUser(club.id, { role: 'guest', display_name: 'Ana' });
  bartender = await f.createUser(club.id, { role: 'bartender' });
});

afterEach(async () => {
  if (subscriber) { await subscriber.stop(); subscriber = null; }
  if (relay) { await relay.stop(); relay = null; }
  if (realtime) { await realtime.close(); realtime = null; }
});

/** Starts the relay with a fast sweep so tests do not wait a whole second. */
async function startRelay(opts = {}) {
  relay = await new EventRelay({
    redis, sweepIntervalMs: 50, logger: { log() {}, error() {}, warn() {} }, ...opts,
  }).start();
  return relay;
}

/** Collects raw messages off the Redis channel, bypassing the socket layer. */
async function tapChannel() {
  const client = redis.duplicate();
  await client.connect();
  const seen = [];
  await client.subscribe(CHANNEL, (m) => seen.push(JSON.parse(m)));
  return {
    seen,
    async waitFor(n, ms = 3000) {
      const until = Date.now() + ms;
      while (seen.length < n && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
      return seen;
    },
    stop: () => client.quit(),
  };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- confirmación

describe('Un evento sale solo cuando la transacción confirma', () => {
  it('lo escrito dentro de una transacción no se publica hasta el COMMIT', async () => {
    await startRelay();
    const tap = await tapChannel();
    try {
      const client = await pool.connect();
      await client.query('BEGIN');
      await events.publish({
        nightclubId: club.id, type: 'order_created', audience: {}, payload: { n: 1 }, client,
      });
      // Aún sin confirmar: nada debe haber salido.
      await wait(200);
      expect(tap.seen).toHaveLength(0);

      await client.query('COMMIT');
      client.release();
      const got = await tap.waitFor(1);
      expect(got).toHaveLength(1);
      expect(got[0]).toMatchObject({ nightclub_id: club.id, type: 'order_created', payload: { n: 1 } });
    } finally {
      await tap.stop();
    }
  });

  it('lo deshecho con ROLLBACK no se publica nunca', async () => {
    await startRelay();
    const tap = await tapChannel();
    try {
      const client = await pool.connect();
      await client.query('BEGIN');
      await events.publish({
        nightclubId: club.id, type: 'order_created', audience: {}, payload: { n: 2 }, client,
      });
      await client.query('ROLLBACK');
      client.release();

      // Y un evento posterior sí sale, lo que prueba que el relevo seguía vivo.
      await events.publish({ nightclubId: club.id, type: 'table_updated', payload: {} });
      const got = await tap.waitFor(1);
      expect(got).toHaveLength(1);
      expect(got[0].type).toBe('table_updated');
      const { rows } = await pool.query('SELECT count(*)::int AS n FROM events');
      expect(rows[0].n).toBe(1);
    } finally {
      await tap.stop();
    }
  });

  it('respeta el orden y no repite', async () => {
    await startRelay();
    const tap = await tapChannel();
    try {
      for (let i = 0; i < 10; i += 1) {
        await events.publish({ nightclubId: club.id, type: 'tick', payload: { i } });
      }
      const got = await tap.waitFor(10);
      expect(got).toHaveLength(10);
      expect(got.map((e) => e.payload.i)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
      const ids = got.map((e) => e.id);
      expect(new Set(ids).size).toBe(10);
      await wait(200);
      expect(tap.seen).toHaveLength(10);
    } finally {
      await tap.stop();
    }
  });
});

// ---------------------------------------------------------------- robustez del relevo

describe('El relevo no depende de que la notificación llegue', () => {
  it('recupera lo que se escribió mientras estaba caído', async () => {
    await startRelay();
    const tap = await tapChannel();
    try {
      await events.publish({ nightclubId: club.id, type: 'antes_de_caer', payload: {} });
      await tap.waitFor(1);

      // Se cae el relevo. La notificación de lo siguiente no la oye nadie.
      await relay.stop();
      relay = null;
      await events.publish({ nightclubId: club.id, type: 'mientras_caido', payload: {} });
      await wait(200);
      expect(tap.seen).toHaveLength(1);

      // Al volver, sigue desde su cursor y entrega lo que se perdió.
      await startRelay();
      const got = await tap.waitFor(2);
      expect(got.map((e) => e.type)).toEqual(['antes_de_caer', 'mientras_caido']);
    } finally {
      await tap.stop();
    }
  });

  it('una instalación nueva no reproduce la noche entera', async () => {
    for (let i = 0; i < 3; i += 1) {
      await events.publish({ nightclubId: club.id, type: 'viejo', payload: { i } });
    }
    // NULL: este relevo nunca ha corrido aquí.
    await pool.query('UPDATE realtime_relay_state SET last_event_id = NULL WHERE id = 1');
    const max = await pool.query('SELECT max(id)::text AS id FROM events');

    const tap = await tapChannel();
    try {
      await startRelay();
      await wait(300);
      expect(tap.seen).toHaveLength(0);
      expect(relay.cursor.toString()).toBe(max.rows[0].id);

      // Y lo que pase a partir de ahora sí sale.
      await events.publish({ nightclubId: club.id, type: 'nuevo', payload: {} });
      expect((await tap.waitFor(1))[0].type).toBe('nuevo');
    } finally {
      await tap.stop();
    }
  });

  it('no entrega en vivo eventos viejos: esos se recuperan al reconectar (3.3)', async () => {
    const old = await events.publish({ nightclubId: club.id, type: 'antiguo', payload: {} });
    await pool.query(
      `UPDATE events SET created_at = now() - ($2 || ' seconds')::interval WHERE id = $1`,
      [old.id, String(LIVE_WINDOW_SECONDS + 60)]);
    await pool.query('UPDATE realtime_relay_state SET last_event_id = $1 WHERE id = 1',
      [(BigInt(old.id) - 1n).toString()]);

    const tap = await tapChannel();
    try {
      await startRelay();
      await events.publish({ nightclubId: club.id, type: 'reciente', payload: {} });
      const got = await tap.waitFor(1);
      expect(got.map((e) => e.type)).toEqual(['reciente']);
      expect(relay.status().skipped_stale).toBe(1);
    } finally {
      await tap.stop();
    }
  });

  it('solo un proceso releva: el segundo se queda de reserva', async () => {
    await startRelay();
    expect(relay.isLeader).toBe(true);
    const standby = await new EventRelay({
      redis, sweepIntervalMs: 50, leaderRetryMs: 50, logger: { log() {}, error() {} },
    }).start();
    try {
      expect(standby.isLeader).toBe(false);
      const tap = await tapChannel();
      try {
        await events.publish({ nightclubId: club.id, type: 'unico', payload: {} });
        const got = await tap.waitFor(1);
        await wait(250);
        // Con dos relevos activos este evento habría salido dos veces.
        expect(got).toHaveLength(1);
      } finally {
        await tap.stop();
      }
    } finally {
      await standby.stop();
    }
  });

  it('la reserva toma el mando cuando el líder se va', async () => {
    await startRelay();
    const standby = await new EventRelay({
      redis, sweepIntervalMs: 50, leaderRetryMs: 50, logger: { log() {}, error() {} },
    }).start();
    try {
      expect(standby.isLeader).toBe(false);
      await relay.stop();
      relay = null;
      const until = Date.now() + 3000;
      while (!standby.isLeader && Date.now() < until) await wait(50);
      expect(standby.isLeader).toBe(true);

      const tap = await tapChannel();
      try {
        await events.publish({ nightclubId: club.id, type: 'tras_relevo', payload: {} });
        expect((await tap.waitFor(1))[0].type).toBe('tras_relevo');
      } finally {
        await tap.stop();
      }
    } finally {
      await standby.stop();
    }
  });
});

// ---------------------------------------------------------------- de punta a punta

describe('De la API al socket', () => {
  async function startStack() {
    // Mismo orden que src/ws.js: el suscriptor se construye antes para que /health
    // pueda informarlo, y se apunta al deliver() del servidor una vez existe.
    subscriber = new EventSubscriber({
      redis, onEvent: (e) => realtime.deliver(e), logger: { error() {} },
    });
    realtime = createRealtimeServer({ subscriber });
    await subscriber.start();
    await new Promise((resolve) => realtime.server.listen(0, resolve));
    port = realtime.server.address().port;
    await startRelay();
  }

  function connect(user) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/`, ['bearer', signAccessToken(user)]);
    return ws;
  }

  function collect(ws) {
    const seen = [];
    ws.on('message', (raw) => seen.push(JSON.parse(raw)));
    return {
      seen,
      async waitFor(type, ms = 4000) {
        const until = Date.now() + ms;
        for (;;) {
          const hit = seen.find((m) => m.type === type || m.event_type === type);
          if (hit) return hit;
          if (Date.now() > until) throw new Error(`timeout esperando ${type}: ${JSON.stringify(seen)}`);
          await wait(20);
        }
      },
    };
  }

  it('un evento confirmado en la API llega al socket del destinatario', async () => {
    await startStack();
    const ws = connect(bartender);
    const box = collect(ws);
    await box.waitFor('welcome');

    await events.publish({
      nightclubId: club.id, type: 'order_created', audience: { roles: ['bartender'] },
      payload: { order_id: 'abc', table: 39 },
    });
    const got = await box.waitFor('order_created');
    expect(got).toMatchObject({ type: 'event', event_type: 'order_created' });
    expect(got.payload).toEqual({ order_id: 'abc', table: 39 });
    ws.close();
  });

  it('la audiencia sigue mandando después de pasar por Redis', async () => {
    await startStack();
    const ana = connect(guest);
    const beto = connect(bartender);
    const anaBox = collect(ana);
    const betoBox = collect(beto);
    await anaBox.waitFor('welcome');
    await betoBox.waitFor('welcome');

    await events.publish({
      nightclubId: club.id, type: 'order_ready', audience: { roles: ['bartender'] }, payload: {},
    });
    await betoBox.waitFor('order_ready');
    // Ana no debe haberlo recibido; se comprueba enviándole después algo suyo.
    await events.publish({
      nightclubId: club.id, type: 'flirt_received', audience: { userIds: [guest.id] }, payload: {},
    });
    await anaBox.waitFor('flirt_received');
    expect(anaBox.seen.some((m) => m.event_type === 'order_ready')).toBe(false);
    ana.close(); beto.close();
  });

  it('un evento de otro club no cruza', async () => {
    await startStack();
    const ws = connect(guest);
    const box = collect(ws);
    await box.waitFor('welcome');

    await events.publish({ nightclubId: otherClub.id, type: 'order_created', payload: {} });
    await events.publish({ nightclubId: club.id, type: 'table_updated', payload: {} });
    await box.waitFor('table_updated');
    expect(box.seen.some((m) => m.event_type === 'order_created')).toBe(false);
    ws.close();
  });

  it('/health del socket avisa cuando la suscripción no está viva', async () => {
    await startStack();
    const ok = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
    expect(ok).toMatchObject({ status: 'ok', realtime: { connected: true } });

    await subscriber.stop();
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    const degraded = await res.json();
    // Un servidor de sockets con la suscripción muerta se ve sano y no entrega nada.
    expect(res.status).toBe(503);
    expect(degraded.status).toBe('degraded');
    subscriber = null;
  });

  it('un mensaje corrupto en el canal no tumba la entrega', async () => {
    await startStack();
    const ws = connect(guest);
    const box = collect(ws);
    await box.waitFor('welcome');

    await redis.publish(CHANNEL, 'esto no es json');
    await redis.publish(CHANNEL, JSON.stringify({ sin: 'campos' }));
    await events.publish({ nightclubId: club.id, type: 'table_updated', payload: { ok: true } });
    const got = await box.waitFor('table_updated');
    expect(got.payload).toEqual({ ok: true });
    expect(subscriber.status().malformed).toBe(2);
    ws.close();
  });
});
