'use strict';

// Notificaciones al teléfono (D90). Lo que se rompe callado:
//   * que le suene el teléfono a quien no le toca (los ocho meseros por un trago);
//   * que le suene a quien no está trabajando, o a un gerente un martes sin noche;
//   * que la pantalla bloqueada enseñe lo que no debe (quién te escribió, tu código);
//   * que el servidor le haga POST a cualquier dirección que alguien le mande;
//   * que un teléfono que ya no existe se quede en la lista para siempre.

const { randomUUID } = require('crypto');
const { setupSchema, truncateAll, closePool, pool } = require('./helpers/db');
const { api, auth } = require('./helpers/api');
const f = require('./helpers/factories');
const push = require('../src/services/push');
const { allowedEndpoint } = require('../src/routes/push');
const { EventRelay } = require('../src/realtime/relay');

const KEYS = { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', auth: 'tBHItJI5svbpez7KI4CCXg' };
const endpointOf = (n) => `https://fcm.googleapis.com/fcm/send/dispositivo-${n}`;

let club; let manager; let waiter; let otherWaiter; let bartender; let guest; let table;
let beer;

beforeAll(setupSchema);
afterAll(closePool);
beforeEach(async () => {
  await truncateAll();
  club = await f.createNightclub({ slug: 'ev2-push' });
  manager = await f.createUser(club.id, { role: 'manager' });
  waiter = await f.createUser(club.id, { role: 'waiter' });
  otherWaiter = await f.createUser(club.id, { role: 'waiter' });
  bartender = await f.createUser(club.id, { role: 'bartender' });
  guest = await f.createUser(club.id, { role: 'guest' });
  table = await f.createTable(club.id, { code: '12', capacity: 4 });
  beer = await f.createDrink(club.id, { name: 'Cerveza', price: 60, stock: 50 });
  const cashier = await f.createUser(club.id, { role: 'cashier' });
  await f.openTill(club.id, { cashier, locationId: club.bar_id, authorizer: manager });
});

const url = (p) => `/api/nightclubs/${club.id}${p}`;

async function subscribe(user, n, lang = 'es') {
  await pool.query(
    `INSERT INTO push_subscriptions (nightclub_id, user_id, endpoint, p256dh, auth, lang)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [club.id, user.id, endpointOf(n), KEYS.p256dh, KEYS.auth, lang]);
}

async function startShift(user) {
  await pool.query('INSERT INTO staff_shifts (nightclub_id, user_id) VALUES ($1,$2)', [club.id, user.id]);
}

async function nightInProgress() {
  await pool.query(
    `INSERT INTO events_calendar (nightclub_id, name, event_date, doors_open_at, ticket_price, status)
     VALUES ($1,'Viernes',(now() - interval '1 hour')::date, now() - interval '1 hour', 0, 'published')`,
    [club.id]);
}

/** Un servicio de notificaciones de mentira: guarda lo que se mandó y a dónde. */
function fakeSender(behavior = {}) {
  const sent = [];
  return {
    sent,
    async sendNotification(sub, body, opts) {
      const status = behavior[sub.endpoint];
      if (status) { const e = new Error(`status ${status}`); e.statusCode = status; throw e; }
      sent.push({ endpoint: sub.endpoint, body: JSON.parse(body), opts });
    },
  };
}
const quiet = { warn() {}, error() {} };

/** El último evento de un tipo, tal como lo dejó la ruta: con su audiencia real. */
async function lastEvent(type) {
  const { rows } = await pool.query(
    `SELECT id::text AS id, nightclub_id, type, audience, payload, created_at
       FROM events WHERE type = $1 ORDER BY id DESC LIMIT 1`, [type]);
  return rows[0];
}

async function waiterOrderReady() {
  const created = await api().post(url('/orders')).set(auth(waiter))
    .send({ client_request_id: randomUUID(), table_id: table.id, items: [{ drink_id: beer.id, quantity: 2 }] });
  expect(created.status).toBe(201);
  const id = created.body.order.id;
  for (const status of ['preparing', 'ready']) {
    const r = await api().post(url(`/orders/${id}/status`)).set(auth(bartender)).send({ status });
    expect(r.status).toBe(200);
  }
  return id;
}

// ================================================================== a quién le toca

describe('a quién le suena el teléfono', () => {
  it('trago listo: solo al mesero que lo levantó, aunque el evento vaya a todos los meseros', async () => {
    await startShift(waiter); await startShift(otherWaiter);
    await subscribe(waiter, 1); await subscribe(otherWaiter, 2); await subscribe(bartender, 3);
    await waiterOrderReady();
    const sender = fakeSender();

    const r = await push.dispatch(await lastEvent('order_ready'), { sender, logger: quiet });

    expect(r.sent).toBe(1);
    expect(sender.sent.map((s) => s.endpoint)).toEqual([endpointOf(1)]);
    expect(sender.sent[0].body).toMatchObject({
      title: 'Trago listo', body: 'Mesa 12 · recoger en Barra planta baja', url: 'staff.html',
    });
    // Un trago no espera: si el teléfono está apagado, el aviso no llega una hora tarde.
    expect(sender.sent[0].opts).toMatchObject({ TTL: 300, urgency: 'high' });
  });

  it('fuera de turno no le suena, aunque el trago sea suyo', async () => {
    await subscribe(waiter, 1);
    await waiterOrderReady();
    const sender = fakeSender();
    expect((await push.dispatch(await lastEvent('order_ready'), { sender, logger: quiet })).sent).toBe(0);
  });

  it('cada teléfono en su idioma', async () => {
    await startShift(waiter);
    await subscribe(waiter, 1, 'en');
    await waiterOrderReady();
    const sender = fakeSender();
    await push.dispatch(await lastEvent('order_ready'), { sender, logger: quiet });
    expect(sender.sent[0].body).toMatchObject({ title: 'Drink ready', body: 'Table 12 · pick up at Barra planta baja' });
  });

  it('el pedido del mesero entra a la barra: le suena al bartender en turno', async () => {
    await startShift(bartender);
    await subscribe(bartender, 3);
    await api().post(url('/orders')).set(auth(waiter))
      .send({ client_request_id: randomUUID(), table_id: table.id, items: [{ drink_id: beer.id, quantity: 3 }] });
    const sender = fakeSender();
    await push.dispatch(await lastEvent('order_created'), { sender, logger: quiet });
    expect(sender.sent.map((s) => s.body.title)).toEqual(['Pedido nuevo']);
    expect(sender.sent[0].body.body).toBe('Mesa 12 · 3 tragos');
  });

  it('al gerente solo le suena con una noche en curso (no abre turno)', async () => {
    await subscribe(manager, 9);
    const event = {
      id: '1', nightclub_id: club.id, type: 'user_reported',
      audience: { roles: ['manager'] }, payload: { report_id: 'r1', reason: 'acoso' },
    };
    let sender = fakeSender();
    expect((await push.dispatch(event, { sender, logger: quiet })).sent).toBe(0);

    await nightInProgress();
    sender = fakeSender();
    await push.dispatch(event, { sender, logger: quiet });
    expect(sender.sent[0].body).toMatchObject({ title: 'Reporte de un usuario', url: 'manager.html' });
  });

  it('nunca fuera de la audiencia del evento: sin audiencia, nadie', async () => {
    await nightInProgress();
    await subscribe(manager, 9);
    const sender = fakeSender();
    await push.dispatch({ id: '2', nightclub_id: club.id, type: 'user_reported', audience: {}, payload: {} },
      { sender, logger: quiet });
    expect(sender.sent).toHaveLength(0);
  });

  it('un evento que no está en el catálogo no suena', async () => {
    await startShift(waiter); await subscribe(waiter, 1);
    const sender = fakeSender();
    await push.dispatch({ id: '3', nightclub_id: club.id, type: 'bar_queue_reordered', audience: { roles: ['waiter'] }, payload: {} },
      { sender, logger: quiet });
    expect(sender.sent).toHaveLength(0);
  });
});

// ================================================================== la pantalla bloqueada

describe('lo que se ve con el teléfono bloqueado', () => {
  it('Conecta no dice quién te escribió', async () => {
    await subscribe(guest, 5);
    const sender = fakeSender();
    await push.dispatch({
      id: '4', nightclub_id: club.id, type: 'flirt_received', audience: { userIds: [guest.id] },
      payload: { flirt_id: 'x', from_table: '7', to_table: '12' },
    }, { sender, logger: quiet });
    expect(sender.sent[0].body).toMatchObject({ title: 'Conecta', body: 'Alguien te mandó algo.', url: 'index.html' });
    expect(JSON.stringify(sender.sent[0].body)).not.toMatch(/7/);
  });

  it('el objeto encontrado no enseña el código de entrega', async () => {
    await subscribe(guest, 5);
    const sender = fakeSender();
    await push.dispatch({
      id: '5', nightclub_id: club.id, type: 'lost_item_matched', audience: { userIds: [guest.id] },
      payload: { item_id: 'i1', handover_code: 'K7Q2' },
    }, { sender, logger: quiet });
    expect(JSON.stringify(sender.sent[0].body)).not.toMatch(/K7Q2/);
  });

  it('el pago confirmado no dice cuánto', async () => {
    await subscribe(guest, 5);
    const sender = fakeSender();
    await push.dispatch({
      id: '6', nightclub_id: club.id, type: 'payment_confirmed', audience: { userIds: [guest.id], roles: ['manager'] },
      payload: { amount: '1234.00', currency: 'MXN' },
    }, { sender, logger: quiet });
    expect(sender.sent[0].body.title).toBe('Pago confirmado');
    expect(JSON.stringify(sender.sent[0].body)).not.toMatch(/1234|1,234/);
  });
});

// ================================================================== la lista de teléfonos

describe('los teléfonos que ya no existen se van solos', () => {
  it('si el servicio contesta 410, el teléfono se borra', async () => {
    await startShift(waiter); await subscribe(waiter, 1);
    await waiterOrderReady();
    const sender = fakeSender({ [endpointOf(1)]: 410 });
    await push.dispatch(await lastEvent('order_ready'), { sender, logger: quiet });
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM push_subscriptions');
    expect(rows[0].n).toBe(0);
  });

  it('otros errores se cuentan, y tras varios seguidos se borra', async () => {
    await subscribe(guest, 5);
    const sender = fakeSender({ [endpointOf(5)]: 500 });
    const ev = { id: '7', nightclub_id: club.id, type: 'flirt_received', audience: { userIds: [guest.id] }, payload: {} };
    for (let i = 1; i < push.MAX_FAILURES; i += 1) await push.dispatch(ev, { sender, logger: quiet });
    let { rows } = await pool.query('SELECT failures FROM push_subscriptions');
    expect(rows[0].failures).toBe(push.MAX_FAILURES - 1);
    await push.dispatch(ev, { sender, logger: quiet });
    ({ rows } = await pool.query('SELECT failures FROM push_subscriptions'));
    expect(rows).toHaveLength(0);
  });

  it('un servicio caído no tumba nada: dispatch nunca lanza', async () => {
    const r = await push.dispatch({ id: '8', nightclub_id: 'no-es-uuid', type: 'flirt_received', audience: { userIds: ['x'] }, payload: {} },
      { sender: fakeSender(), logger: quiet });
    expect(r.sent).toBe(0);
  });
});

// ================================================================== las rutas

describe('POST /push/subscriptions', () => {
  const ORIGINAL = { ...process.env };
  beforeEach(() => {
    process.env.VAPID_PUBLIC_KEY = 'BPublicaDePrueba';
    process.env.VAPID_PRIVATE_KEY = 'privada-de-prueba';
    process.env.VAPID_SUBJECT = 'mailto:pruebas@ev2.local';
  });
  afterEach(() => {
    for (const k of ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT']) {
      if (ORIGINAL[k] === undefined) delete process.env[k]; else process.env[k] = ORIGINAL[k];
    }
  });

  const body = (n, over = {}) => ({ endpoint: endpointOf(n), keys: KEYS, lang: 'es', ...over });

  it('la configuración dice si está encendido y da la llave pública', async () => {
    const r = await api().get('/api/push/config').set(auth(guest));
    expect(r.body).toEqual({ enabled: true, public_key: 'BPublicaDePrueba' });
    delete process.env.VAPID_PRIVATE_KEY;
    const off = await api().get('/api/push/config').set(auth(guest));
    expect(off.body).toEqual({ enabled: false, public_key: null });
  });

  it('guarda el teléfono; el mismo teléfono otra vez no se duplica', async () => {
    const a = await api().post(url('/push/subscriptions')).set(auth(guest)).send(body(1));
    expect(a.status).toBe(201);
    const b = await api().post(url('/push/subscriptions')).set(auth(guest)).send(body(1, { lang: 'en' }));
    expect(b.status).toBe(200);
    const { rows } = await pool.query('SELECT user_id, lang FROM push_subscriptions');
    expect(rows).toEqual([{ user_id: guest.id, lang: 'en' }]);
  });

  it('un teléfono compartido pasa a quien entró después', async () => {
    await api().post(url('/push/subscriptions')).set(auth(guest)).send(body(1));
    await api().post(url('/push/subscriptions')).set(auth(waiter)).send(body(1));
    const { rows } = await pool.query('SELECT user_id FROM push_subscriptions');
    expect(rows).toEqual([{ user_id: waiter.id }]);
  });

  it('solo acepta servicios de notificaciones reales: el servidor no le hace POST a cualquiera', async () => {
    for (const endpoint of [
      'https://169.254.169.254/latest', 'http://fcm.googleapis.com/x', 'https://fcm.googleapis.com.evil.com/x',
      'https://fcm.googleapis.com:8443/x', 'https://localhost/x', 'no-es-url',
    ]) {
      const r = await api().post(url('/push/subscriptions')).set(auth(guest)).send(body(1, { endpoint }));
      expect(r.status).toBe(400);
    }
    expect(allowedEndpoint('https://web.push.apple.com/QGuQyavXutnMH')).toBe(true);
    expect(allowedEndpoint('https://updates.push.services.mozilla.com/wpush/v2/abc')).toBe(true);
    expect(allowedEndpoint('https://wns2-by3p.notify.windows.com/w/?token=x')).toBe(true);
  });

  it('sin llaves en el servidor contesta 503, no guarda a medias', async () => {
    delete process.env.VAPID_PUBLIC_KEY;
    const r = await api().post(url('/push/subscriptions')).set(auth(guest)).send(body(1));
    expect(r.status).toBe(503);
  });

  it('borrar: solo el tuyo, aunque sepas el de otro', async () => {
    await subscribe(waiter, 1);
    await api().delete(url('/push/subscriptions')).set(auth(guest)).send({ endpoint: endpointOf(1) });
    expect((await pool.query('SELECT count(*)::int AS n FROM push_subscriptions')).rows[0].n).toBe(1);
    const r = await api().delete(url('/push/subscriptions')).set(auth(waiter)).send({ endpoint: endpointOf(1) });
    expect(r.status).toBe(204);
    expect((await pool.query('SELECT count(*)::int AS n FROM push_subscriptions')).rows[0].n).toBe(0);
  });

  it('no se suscribe a otro club', async () => {
    const otro = await f.createNightclub({ slug: 'otro-club', locations: false });
    const r = await api().post(`/api/nightclubs/${otro.id}/push/subscriptions`).set(auth(guest)).send(body(1));
    expect(r.status).toBe(403);
  });
});

// ================================================================== la relay

describe('la relay le pasa los eventos en vivo', () => {
  it('notify() llama al gancho sin esperar, y un error del gancho no la tumba', async () => {
    const seen = [];
    const relay = new EventRelay({
      redis: { publish: async () => {} }, logger: quiet,
      onEvent: (e) => { seen.push(e); throw new Error('servicio caído'); },
    });
    relay.notify({ event_id: '10', nightclub_id: club.id, type: 'order_ready', audience: {}, payload: {} });
    await new Promise((r) => { setImmediate(r); });
    expect(seen).toEqual([expect.objectContaining({ id: '10', type: 'order_ready' })]);
  });
});

// ================================================================== el catálogo

describe('el catálogo no se desfasa del sistema', () => {
  const fs = require('fs');
  const path = require('path');
  const fuentes = () => {
    const out = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        // El propio catálogo no cuenta: ahí están TODOS los nombres, bien o mal escritos.
        if (e.isDirectory()) walk(p);
        else if (p.endsWith('.js') && !p.endsWith(path.join('services', 'push.js'))) out.push(fs.readFileSync(p, 'utf8'));
      }
    };
    walk(path.join(__dirname, '..', 'src'));
    return out.join('\n');
  };

  it('cada tipo del catálogo es un evento que el sistema de verdad publica', () => {
    // Un nombre mal escrito ("song_request" en vez de "song_requested") es un aviso que
    // nunca suena, sin un solo error.
    const src = fuentes();
    const plantillas = { order_: /type: `order_\$\{next\}`/, reservation_: /type: `reservation_\$\{next\}`/ };
    for (const type of Object.keys(push.CATALOG)) {
      const literal = src.includes(`'${type}'`);
      const prefijo = Object.keys(plantillas).find((p) => type.startsWith(p));
      const porPlantilla = prefijo && plantillas[prefijo].test(src);
      expect([type, literal || Boolean(porPlantilla)]).toEqual([type, true]);
    }
  });

  it('cada texto existe en español y en inglés', () => {
    expect(Object.keys(push.TEXTS.en).sort()).toEqual(Object.keys(push.TEXTS.es).sort());
  });
});
