// Realtime server: authenticated WebSocket delivery, with no domain state of its own
// (docs/DECISIONES.md D25).
//
// What changed from the old server: it kept five hard-coded tables and an activity feed
// in memory and let any anonymous socket move people between them. That made the socket
// a third place where the truth lived, next to Postgres and the API, and the three drifted
// apart the moment anything restarted.
//
// Now:
//   * every connection authenticates with the same access token the REST API uses, and
//     the user is loaded from Postgres, so a blocked account cannot hold a socket open;
//   * the socket is read-only for domain purposes. Clients send `ping` and nothing else;
//     everything that changes state goes through the REST API, which is where the
//     validation, the roles and the ledger live;
//   * events are addressed: an event reaches only the connections its audience names,
//     and never leaves its own club;
//   * the access token is short-lived on purpose, so the socket refuses to outlive it:
//     at expiry it says so and closes with 4001, and the client reconnects with a fresh
//     token instead of silently keeping a session that authentication no longer backs.
//
// Where events come from is deliberately not decided here: `deliver()` is the entry
// point, and step 3.2 plugs Redis pub/sub into it.
'use strict';

require('dotenv').config();

const http = require('http');
const jwt = require('jsonwebtoken');
const { WebSocketServer } = require('ws');
const { pool } = require('./db/pool');
const { Hub } = require('./realtime/hub');
const { EventSubscriber } = require('./realtime/subscriber');
const { redis } = require('./db/redis');

const PORT = Number(process.env.WS_PORT || process.env.PORT || 4000);
const HEARTBEAT_MS = Number(process.env.WS_HEARTBEAT_MS || 30_000);
const MAX_PER_USER = Number(process.env.WS_MAX_CONNECTIONS_PER_USER || 5);
const MAX_MESSAGE_BYTES = 4096;
const CLIENT_MESSAGE_LIMIT_PER_MIN = 120;

// Close codes the client is expected to understand.
const CLOSE = {
  UNAUTHORIZED: 4401,
  TOKEN_EXPIRED: 4001,
  REPLACED: 4002,      // a newer connection from the same account took its place
  FORBIDDEN: 4403,
  POLICY: 4004,        // the client misbehaved (flooding, oversized frames)
  GOING_AWAY: 1001,
};

function jwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 16) {
    throw new Error('JWT_SECRET is missing or too short (min 16 characters)');
  }
  return secret;
}

/**
 * Browsers cannot set headers on a WebSocket handshake, so the token arrives either in
 * the `Sec-WebSocket-Protocol` header (`bearer, <token>`) or, as a fallback, in the
 * query string. The subprotocol form is preferred and documented as such: a token in a
 * URL ends up in access logs and proxy history.
 */
function extractToken(req) {
  const proto = req.headers['sec-websocket-protocol'];
  if (proto) {
    const parts = String(proto).split(',').map((p) => p.trim());
    const i = parts.indexOf('bearer');
    if (i !== -1 && parts[i + 1]) return { token: parts[i + 1], viaSubprotocol: true };
  }
  const url = new URL(req.url || '/', 'http://localhost');
  const q = url.searchParams.get('access_token');
  if (q) return { token: q, viaSubprotocol: false };
  return { token: null, viaSubprotocol: false };
}

/**
 * Verifies the token and loads the current user. Returns the user and the token's
 * expiry, or throws with a close code.
 */
async function authenticateRequest(req, { db = pool } = {}) {
  const { token, viaSubprotocol } = extractToken(req);
  if (!token) {
    const err = new Error('Missing access token');
    err.closeCode = CLOSE.UNAUTHORIZED;
    throw err;
  }
  let payload;
  try {
    payload = jwt.verify(token, jwtSecret(), { issuer: 'ev2' });
  } catch (e) {
    const err = new Error(e.name === 'TokenExpiredError' ? 'Token expired' : 'Invalid token');
    err.closeCode = e.name === 'TokenExpiredError' ? CLOSE.TOKEN_EXPIRED : CLOSE.UNAUTHORIZED;
    throw err;
  }
  // Loaded fresh, not trusted from the token: a blocked account loses its socket now,
  // not in fifteen minutes.
  const { rows } = await db.query(
    `SELECT id, nightclub_id, email, display_name, role, status, must_change_password
       FROM users WHERE id = $1`,
    [payload.sub],
  );
  const user = rows[0];
  if (!user) {
    const err = new Error('User no longer exists');
    err.closeCode = CLOSE.UNAUTHORIZED;
    throw err;
  }
  if (user.status !== 'active') {
    const err = new Error('Account is not active');
    err.closeCode = CLOSE.FORBIDDEN;
    throw err;
  }
  if (user.must_change_password) {
    const err = new Error('Change your temporary password first');
    err.closeCode = CLOSE.FORBIDDEN;
    throw err;
  }
  return { user, expiresAt: payload.exp * 1000, viaSubprotocol };
}

function createRealtimeServer({ db = pool, hub = new Hub({ maxPerUser: MAX_PER_USER }), subscriber = null } = {}) {
  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      // `realtime` says whether events can actually arrive. A socket server with happy
      // sockets and a dead subscription looks fine and delivers nothing.
      const body = { status: 'ok', service: 'ev2-ws', ...hub.stats() };
      if (subscriber) {
        body.realtime = subscriber.status();
        if (!body.realtime.connected) body.status = 'degraded';
      }
      res.writeHead(body.status === 'ok' ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'not_found', message: 'Not found' } }));
  });

  const wss = new WebSocketServer({
    server,
    maxPayload: MAX_MESSAGE_BYTES,
    handleProtocols: (protocols) => (protocols.has('bearer') ? 'bearer' : false),
  });

  function send(conn, message) {
    if (conn.ws.readyState === conn.ws.OPEN) conn.ws.send(JSON.stringify(message));
  }

  /** The one way a domain event reaches clients. Step 3.2 feeds this from Redis. */
  function deliver(event) {
    return hub.deliver(event, send);
  }

  wss.on('connection', async (ws, req) => {
    let auth;
    try {
      auth = await authenticateRequest(req, { db });
    } catch (err) {
      // Say why before closing: a client that cannot tell "expired" from "blocked"
      // either retries forever or gives up when it should have refreshed.
      try {
        ws.send(JSON.stringify({ type: 'error', code: err.closeCode, message: err.message }));
      } catch { /* the socket may already be gone */ }
      ws.close(err.closeCode || CLOSE.UNAUTHORIZED, err.message);
      return;
    }

    const conn = {
      ws,
      user: auth.user,
      connectedAt: Date.now(),
      expiresAt: auth.expiresAt,
      alive: true,
      messagesThisMinute: 0,
      windowStartedAt: Date.now(),
    };

    // A new device pushes out the oldest session instead of being refused: being told
    // "too many connections" when you just opened the app is a bug from the user's side
    // of the screen.
    while (hub.countForUser(conn.user.id) >= MAX_PER_USER) {
      const oldest = hub.oldestForUser(conn.user.id);
      if (!oldest) break;
      send(oldest, { type: 'closing', code: CLOSE.REPLACED, message: 'Sesión reemplazada por otra más reciente' });
      oldest.ws.close(CLOSE.REPLACED, 'Replaced by a newer connection');
      hub.remove(oldest);
    }

    hub.add(conn);

    send(conn, {
      type: 'welcome',
      user: {
        id: conn.user.id,
        nightclub_id: conn.user.nightclub_id,
        role: conn.user.role,
        display_name: conn.user.display_name,
      },
      // The client stores this and sends it back after a drop; the replay itself is
      // step 3.3.
      last_event_id: await latestEventId(conn.user.nightclub_id, db),
      heartbeat_ms: HEARTBEAT_MS,
      token_expires_at: new Date(conn.expiresAt).toISOString(),
      server_time: new Date().toISOString(),
    });

    ws.on('pong', () => { conn.alive = true; });

    ws.on('message', (raw) => {
      const now = Date.now();
      if (now - conn.windowStartedAt > 60_000) {
        conn.windowStartedAt = now;
        conn.messagesThisMinute = 0;
      }
      conn.messagesThisMinute += 1;
      if (conn.messagesThisMinute > CLIENT_MESSAGE_LIMIT_PER_MIN) {
        send(conn, { type: 'error', code: CLOSE.POLICY, message: 'Demasiados mensajes' });
        ws.close(CLOSE.POLICY, 'Too many messages');
        return;
      }

      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        send(conn, { type: 'error', code: 'bad_message', message: 'El mensaje no es JSON' });
        return;
      }
      // The socket does not change anything. Every command the old server accepted
      // (take_seat, send_drink, send_flirt) is a REST endpoint with validation, roles
      // and a ledger behind it.
      if (msg && msg.type === 'ping') {
        send(conn, { type: 'pong', server_time: new Date().toISOString() });
        return;
      }
      send(conn, {
        type: 'error',
        code: 'unsupported',
        message: 'Este canal solo entrega eventos. Usa la API REST para cualquier acción.',
      });
    });

    ws.on('close', () => hub.remove(conn));
    ws.on('error', () => hub.remove(conn));
  });

  // Heartbeat: drop sockets that stopped answering, and close the ones whose token has
  // run out so the client refreshes instead of holding an unbacked session.
  const heartbeat = setInterval(() => {
    const now = Date.now();
    for (const conn of hub.all()) {
      if (conn.expiresAt <= now) {
        send(conn, { type: 'closing', code: CLOSE.TOKEN_EXPIRED, message: 'El token expiró; reconecta con uno nuevo' });
        conn.ws.close(CLOSE.TOKEN_EXPIRED, 'Token expired');
        hub.remove(conn);
        continue;
      }
      if (!conn.alive) {
        conn.ws.terminate();
        hub.remove(conn);
        continue;
      }
      conn.alive = false;
      try { conn.ws.ping(); } catch { hub.remove(conn); }
    }
  }, HEARTBEAT_MS);
  heartbeat.unref?.();

  async function close() {
    clearInterval(heartbeat);
    if (subscriber) await subscriber.stop().catch(() => {});
    for (const conn of hub.all()) {
      send(conn, { type: 'closing', code: CLOSE.GOING_AWAY, message: 'El servidor se está reiniciando' });
      conn.ws.close(CLOSE.GOING_AWAY, 'Server shutting down');
    }
    await new Promise((resolve) => wss.close(resolve));
    await new Promise((resolve) => server.close(resolve));
  }

  return { server, wss, hub, deliver, close, CLOSE, subscriber };
}

async function latestEventId(nightclubId, db = pool) {
  try {
    const { rows } = await db.query(
      'SELECT COALESCE(max(id), 0)::text AS id FROM events WHERE nightclub_id = $1',
      [nightclubId]);
    return rows[0].id;
  } catch {
    // A realtime channel that refuses to open because a catch-up pointer could not be
    // read would be worse than one that opens without it.
    return '0';
  }
}

async function start() {
  jwtSecret();
  await pool.query('SELECT 1');
  await redis.connect();

  // Built first so the server can report the subscription in /health, then pointed at
  // the server's deliver() once it exists.
  let realtime;
  const subscriber = new EventSubscriber({ redis, onEvent: (event) => realtime.deliver(event) });
  realtime = createRealtimeServer({ subscriber });
  await subscriber.start();
  await new Promise((resolve) => realtime.server.listen(PORT, resolve));
  console.log(`EV2 realtime server listening on ${PORT}`);

  const shutdown = async (signal) => {
      console.log(`${signal} received, closing realtime server`);
    await realtime.close();
    await redis.quit().catch(() => {});
    await pool.end().catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  return realtime;
}

if (require.main === module) {
  start().catch((err) => {
      console.error('Realtime server failed to start:', err.message);
    process.exit(1);
  });
}

module.exports = { createRealtimeServer, authenticateRequest, extractToken, start, CLOSE, Hub };
