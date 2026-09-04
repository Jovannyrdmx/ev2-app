'use strict';

// Servidor de tiempo real (D25): el socket autentica con el mismo token de la API, no
// guarda estado de dominio y solo entrega eventos dirigidos a quien corresponde.

const WebSocket = require('ws');
const jwt = require('jsonwebtoken');
const { setupSchema, truncateAll, closePool, pool } = require('./helpers/db');
const { signAccessToken } = require('../src/middleware/auth');
const { createRealtimeServer, extractToken, CLOSE } = require('../src/ws');
const { Hub } = require('../src/realtime/hub');
const f = require('./helpers/factories');

let realtime; let port;
let club; let otherClub; let guest; let bartender; let manager; let outsider;

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
  club = await f.createNightclub({ slug: 'ev2-ws' });
  otherClub = await f.createNightclub({ name: 'Otro', slug: 'otro-ws' });
  guest = await f.createUser(club.id, { role: 'guest', display_name: 'Ana' });
  bartender = await f.createUser(club.id, { role: 'bartender', display_name: 'Beto' });
  manager = await f.createUser(club.id, { role: 'manager' });
  outsider = await f.createUser(otherClub.id, { role: 'guest' });
});

const open = (token, { subprotocol = true } = {}) => (subprotocol
  ? new WebSocket(`ws://127.0.0.1:${port}/`, ['bearer', token])
  : new WebSocket(`ws://127.0.0.1:${port}/?access_token=${encodeURIComponent(token)}`));

/** Resolves with the first message of each kind, or rejects if the socket closes first. */
function nextMessage(ws) {
  return new Promise((resolve, reject) => {
    const onMessage = (raw) => { cleanup(); resolve(JSON.parse(raw)); };
    const onClose = (code, reason) => { cleanup(); reject(new Error(`closed ${code} ${reason}`)); };
    const cleanup = () => { ws.off('message', onMessage); ws.off('close', onClose); };
    ws.on('message', onMessage);
    ws.on('close', onClose);
  });
}

function closedWith(ws) {
  return new Promise((resolve) => ws.on('close', (code, reason) => resolve({ code, reason: String(reason) })));
}

/** Opens a socket, waits for the welcome, and returns both. */
async function connected(user, opts) {
  const ws = open(signAccessToken(user), opts);
  const welcome = await nextMessage(ws);
  return { ws, welcome };
}

const sockets = [];
afterEach(() => {
  while (sockets.length) {
    const ws = sockets.pop();
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
  }
});
const track = (ws) => { sockets.push(ws); return ws; };

// ---------------------------------------------------------------- autenticación

describe('Autenticación de la conexión', () => {
  it('acepta el token en el subprotocolo y también en la query', async () => {
    const a = await connected(guest);
    track(a.ws);
    expect(a.welcome).toMatchObject({
      type: 'welcome',
      user: { id: guest.id, nightclub_id: club.id, role: 'guest', display_name: 'Ana' },
    });
    expect(a.welcome.last_event_id).toBe('0');
    expect(a.welcome.heartbeat_ms).toBeGreaterThan(0);

    const b = await connected(guest, { subprotocol: false });
    track(b.ws);
    expect(b.welcome.type).toBe('welcome');
  });

  it('prefiere el subprotocolo, porque un token en la URL acaba en las bitácoras', () => {
    const both = extractToken({
      headers: { 'sec-websocket-protocol': 'bearer, abc123' },
      url: '/?access_token=deLaUrl',
    });
    expect(both).toEqual({ token: 'abc123', viaSubprotocol: true });
    const onlyQuery = extractToken({ headers: {}, url: '/?access_token=deLaUrl' });
    expect(onlyQuery).toEqual({ token: 'deLaUrl', viaSubprotocol: false });
  });

  it('sin token, con uno inválido o con uno vencido no se conecta y dice por qué', async () => {
    const noToken = track(new WebSocket(`ws://127.0.0.1:${port}/`));
    expect((await closedWith(noToken)).code).toBe(CLOSE.UNAUTHORIZED);

    const bad = track(open('no-es-un-token'));
    expect((await closedWith(bad)).code).toBe(CLOSE.UNAUTHORIZED);

    const expired = jwt.sign({ sub: guest.id, role: 'guest', nc: club.id },
      process.env.JWT_SECRET, { expiresIn: -60, issuer: 'ev2' });
    const stale = track(open(expired));
    // Distinguir "vencido" de "inválido" es lo que le dice al cliente que refresque.
    expect((await closedWith(stale)).code).toBe(CLOSE.TOKEN_EXPIRED);
  });

  it('una cuenta bloqueada pierde el socket ahora, no en quince minutos', async () => {
    const token = signAccessToken(guest);
    await pool.query("UPDATE users SET status = 'blocked' WHERE id = $1", [guest.id]);
    const ws = track(open(token));
    expect((await closedWith(ws)).code).toBe(CLOSE.FORBIDDEN);
  });

  it('con contraseña temporal pendiente tampoco entra', async () => {
    await pool.query('UPDATE users SET must_change_password = true WHERE id = $1', [bartender.id]);
    const ws = track(open(signAccessToken(bartender)));
    expect((await closedWith(ws)).code).toBe(CLOSE.FORBIDDEN);
  });
});

// ---------------------------------------------------------------- el socket no cambia nada

describe('El socket no cambia nada', () => {
  it('responde al ping y rechaza cualquier otro mensaje', async () => {
    const { ws } = await connected(guest);
    track(ws);
    ws.send(JSON.stringify({ type: 'ping' }));
    expect((await nextMessage(ws)).type).toBe('pong');

    // Todo lo que el servidor viejo aceptaba por el socket ahora vive en la API REST.
    ws.send(JSON.stringify({ type: 'take_seat', tableId: 't7' }));
    const rejected = await nextMessage(ws);
    expect(rejected).toMatchObject({ type: 'error', code: 'unsupported' });
    expect(rejected.message).toMatch(/API REST/);
  });

  it('un mensaje que no es JSON no tumba la conexión', async () => {
    const { ws } = await connected(guest);
    track(ws);
    ws.send('{no es json');
    expect((await nextMessage(ws))).toMatchObject({ type: 'error', code: 'bad_message' });
    ws.send(JSON.stringify({ type: 'ping' }));
    expect((await nextMessage(ws)).type).toBe('pong');
  });
});

// ---------------------------------------------------------------- entrega dirigida

describe('Entrega de eventos', () => {
  it('un evento sin audiencia llega a todo el club y a nadie de otro', async () => {
    const ana = await connected(guest); track(ana.ws);
    const beto = await connected(bartender); track(beto.ws);
    const fuera = await connected(outsider); track(fuera.ws);

    const anaGot = nextMessage(ana.ws);
    const betoGot = nextMessage(beto.ws);
    const reached = realtime.deliver({
      id: 101, nightclub_id: club.id, type: 'table_updated', audience: {},
      payload: { table: 39 }, created_at: new Date().toISOString(),
    });
    expect(reached).toBe(2);
    expect(await anaGot).toMatchObject({ type: 'event', id: '101', event_type: 'table_updated' });
    expect((await betoGot).payload).toEqual({ table: 39 });

    // El de otro club no recibe nada: se comprueba con un evento propio suyo.
    const suyo = nextMessage(fuera.ws);
    realtime.deliver({
      id: 102, nightclub_id: otherClub.id, type: 'table_updated', audience: {},
      payload: { table: 1 }, created_at: new Date().toISOString(),
    });
    expect((await suyo).id).toBe('102');
  });

  it('una audiencia por rol llega solo a ese rol', async () => {
    const ana = await connected(guest); track(ana.ws);
    const beto = await connected(bartender); track(beto.ws);

    const betoGot = nextMessage(beto.ws);
    const reached = realtime.deliver({
      id: 200, nightclub_id: club.id, type: 'order_created',
      audience: { roles: ['bartender'] }, payload: { order: 'abc' },
      created_at: new Date().toISOString(),
    });
    expect(reached).toBe(1);
    expect((await betoGot).event_type).toBe('order_created');

    // Y a Ana le sigue llegando lo que sí es suyo, prueba de que su socket estaba vivo.
    const anaGot = nextMessage(ana.ws);
    realtime.deliver({
      id: 201, nightclub_id: club.id, type: 'valet_ready',
      audience: { userIds: [guest.id] }, payload: {}, created_at: new Date().toISOString(),
    });
    expect((await anaGot).id).toBe('201');
  });

  it('una audiencia por persona no se filtra a los demás', async () => {
    const ana = await connected(guest); track(ana.ws);
    const gerente = await connected(manager); track(gerente.ws);
    const reached = realtime.deliver({
      id: 300, nightclub_id: club.id, type: 'flirt_received',
      audience: { userIds: [guest.id] }, payload: { emoji: '🌹' },
      created_at: new Date().toISOString(),
    });
    expect(reached).toBe(1);
    expect((await nextMessage(ana.ws)).payload).toEqual({ emoji: '🌹' });
    expect(gerente.ws.readyState).toBe(WebSocket.OPEN);
  });

  it('los ids de evento viajan como cadena: son enteros de 64 bits', async () => {
    const { ws } = await connected(guest); track(ws);
    const got = nextMessage(ws);
    realtime.deliver({
      id: 9007199254740993n, nightclub_id: club.id, type: 'x', audience: {},
      payload: {}, created_at: new Date().toISOString(),
    });
    expect((await got).id).toBe('9007199254740993');
  });
});

// ---------------------------------------------------------------- el registro de conexiones

describe('El registro de conexiones no guarda estado de dominio', () => {
  it('solo conoce conexiones, y las suelta al cerrarse', async () => {
    const hub = new Hub();
    expect(Object.keys(hub)).toEqual(expect.not.arrayContaining(['tables', 'activity', 'state']));

    const conn = { user: { id: 'u1', nightclub_id: 'c1', role: 'guest' }, connectedAt: 1 };
    hub.add(conn);
    expect(hub.stats()).toEqual({ connections: 1, users: 1, nightclubs: 1 });
    hub.remove(conn);
    expect(hub.stats()).toEqual({ connections: 0, users: 0, nightclubs: 0 });
  });

  it('/health informa cuántas conexiones hay, sin datos de nadie', async () => {
    const { ws } = await connected(guest); track(ws);
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ status: 'ok', service: 'ev2-ws', connections: 1, users: 1 });
    expect(JSON.stringify(body)).not.toContain(guest.id);
  });

  it('un sexto dispositivo desplaza al más viejo en vez de recibir un portazo', async () => {
    const opened = [];
    for (let i = 0; i < 5; i += 1) {
      const c = await connected(guest);
      track(c.ws);
      opened.push(c.ws);
    }
    const evicted = closedWith(opened[0]);
    const sixth = await connected(guest);
    track(sixth.ws);
    expect(sixth.welcome.type).toBe('welcome');
    expect((await evicted).code).toBe(CLOSE.REPLACED);
  });
});
