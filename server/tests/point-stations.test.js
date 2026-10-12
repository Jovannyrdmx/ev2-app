/**
 * La terminal Mercado Pago fija en cada caja y en la puerta (D100).
 *
 * Mercado Pago no se llama de verdad: `fetch` se sustituye por una tienda de respuestas.
 * Lo que se comprueba:
 *
 *   * una terminal vive en UN lugar (una barra o la puerta) y ese lugar tiene UNA activa;
 *   * el cajero cobra por la terminal de SU caja sin escogerla, y no puede usar la de otra;
 *   * el cover de la puerta se cobra primero en la terminal y la entrada se asienta solo
 *     cuando Mercado Pago aprueba, una sola vez por tarjeta;
 *   * si la tarjeta no pasa, no queda entrada ni renglón pendiente;
 *   * el aviso push sale en aprobado, rechazado y vencido.
 */
'use strict';

const crypto = require('crypto');
const { setupSchema, truncateAll, closePool, pool } = require('./helpers/db');
const { api, auth } = require('./helpers/api');
const f = require('./helpers/factories');
const push = require('../src/services/push');

let club; let manager; let cajero; let hostess; let guest; let doorId;
const mpFake = { orders: new Map(), calls: [] };
let fetchOriginal;

const respuesta = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  text: () => Promise.resolve(body === null ? '' : JSON.stringify(body)),
});

function fakeFetch(url, opts = {}) {
  const method = opts.method || 'GET';
  const path = String(url).replace('https://api.mercadopago.com', '');
  const body = opts.body ? JSON.parse(opts.body) : null;
  mpFake.calls.push({ method, path, body });
  if (method === 'PATCH' && path === '/terminals/v1/setup') {
    return Promise.resolve(respuesta(200, { live_mode: true, terminals: body.terminals }));
  }
  if (method === 'POST' && path === '/v1/orders') {
    const llave = (opts.headers || {})['X-Idempotency-Key'];
    const yaEsta = [...mpFake.orders.values()].find((o) => o._key === llave);
    if (yaEsta) return Promise.resolve(respuesta(201, yaEsta));
    const order = {
      id: `ORDTST${crypto.randomBytes(6).toString('hex').toUpperCase()}`,
      status: 'created',
      live_mode: true,
      total_amount: body.transactions.payments[0].amount,
      external_reference: body.external_reference,
      _terminal: body.config.point.terminal_id,
      _key: llave,
    };
    mpFake.orders.set(order.id, order);
    return Promise.resolve(respuesta(201, order));
  }
  const ver = /^\/v1\/orders\/([^/]+)$/.exec(path);
  if (method === 'GET' && ver) {
    const order = mpFake.orders.get(decodeURIComponent(ver[1]));
    return Promise.resolve(order ? respuesta(200, order) : respuesta(404, { message: 'not found' }));
  }
  return Promise.resolve(respuesta(404, { message: `sin ruta falsa para ${method} ${path}` }));
}

function resolverOrden(orderId, status) {
  const order = mpFake.orders.get(orderId);
  Object.assign(order, {
    status,
    status_detail: status === 'processed' ? 'accredited' : status,
    total_paid_amount: status === 'processed' ? order.total_amount : null,
    transactions: {
      payments: [{
        id: `PAY${crypto.randomBytes(6).toString('hex').toUpperCase()}`,
        amount: order.total_amount,
        payment_method: { id: 'visa', type: 'credit_card', installments: 1 },
      }],
    },
  });
}

async function notificar(orderId) {
  const requestId = crypto.randomUUID();
  const ts = Date.now();
  const manifest = `id:${orderId.toLowerCase()};request-id:${requestId};ts:${ts};`;
  const v1 = crypto.createHmac('sha256', 'secreto-de-prueba').update(manifest).digest('hex');
  return api().post(`/api/payments/mercadopago/webhook?data.id=${encodeURIComponent(orderId)}`)
    .set('x-signature', `ts=${ts},v1=${v1}`)
    .set('x-request-id', requestId)
    .send({ action: 'order.processed', type: 'order', data: { id: orderId } });
}

const url = (p) => `/api/nightclubs/${club.id}${p}`;

async function altaTerminal(label, serial, locationId) {
  const res = await api().post(url('/payment-terminals')).set(await auth(manager))
    .send({ external_id: `NEWLAND_N950__${serial}`, label, location_id: locationId });
  expect(res.status).toBe(201);
  return res.body.terminal;
}

async function cobroDeBarra(amount = '120.00') {
  const { rows } = await pool.query(
    `INSERT INTO transactions (nightclub_id, type, direction, amount, currency, status,
                               payer_user_id, provider, reference_type)
     VALUES ($1,'drink_order','in',$2,'MXN','pending',$3,'manual','drink_order')
     RETURNING id`, [club.id, amount, guest.id]);
  return rows[0];
}

beforeAll(async () => {
  await setupSchema();
  fetchOriginal = global.fetch;
  global.fetch = fakeFetch;
});

afterAll(async () => {
  global.fetch = fetchOriginal;
  await closePool();
});

beforeEach(async () => {
  await truncateAll();
  mpFake.orders.clear();
  mpFake.calls = [];
  process.env.MERCADOPAGO_ACCESS_TOKEN = 'APP_USR-fake-token-for-tests';
  process.env.MERCADOPAGO_PUBLIC_KEY = 'APP_USR-fake-public-key';
  process.env.MERCADOPAGO_ENV = 'live';
  process.env.MERCADOPAGO_WEBHOOK_SECRET = 'secreto-de-prueba';

  club = await f.createNightclub({ slug: 'ev2-point' });
  const door = await pool.query(
    `INSERT INTO supply_locations (nightclub_id, code, name, kind, sort_order)
     VALUES ($1,'cover','Cover','door',3) RETURNING id`, [club.id]);
  doorId = door.rows[0].id;
  manager = await f.createUser(club.id, { role: 'manager' });
  cajero = await f.createUser(club.id, { role: 'cashier' });
  hostess = await f.createUser(club.id, { role: 'hostess' });
  guest = await f.createUser(club.id, { role: 'guest' });
});

describe('Una terminal vive en un lugar', () => {
  it('se asigna a una barra, se ve en la lista y ese lugar admite solo una activa', async () => {
    const t1 = await altaTerminal('Barra baja', 'AAA111', club.bar_id);
    expect(t1.location_id).toBe(club.bar_id);
    const lista = await api().get(url('/payment-terminals')).set(await auth(manager));
    expect(lista.body.terminals[0]).toMatchObject({ location_name: 'Barra planta baja', location_kind: 'bar' });

    const dos = await api().post(url('/payment-terminals')).set(await auth(manager))
      .send({ external_id: 'NEWLAND_N950__BBB222', label: 'Otra', location_id: club.bar_id });
    expect(dos.status).toBe(409);
    expect(dos.body.error.message).toMatch(/ya tiene una terminal/);
  });

  it('el almacén no cobra, y se puede quitar el lugar', async () => {
    const malo = await api().post(url('/payment-terminals')).set(await auth(manager))
      .send({ external_id: 'NEWLAND_N950__CCC333', label: 'Bodega', location_id: club.warehouse_id });
    expect(malo.status).toBe(422);

    const t = await altaTerminal('Puerta', 'DDD444', doorId);
    const quitar = await api().patch(url(`/payment-terminals/${t.id}`)).set(await auth(manager))
      .send({ location_id: null });
    expect(quitar.status).toBe(200);
    expect(quitar.body.terminal.location_id).toBeNull();
  });
});

describe('La caja cobra por su terminal', () => {
  let tBaja; let tAlta;
  beforeEach(async () => {
    tBaja = await altaTerminal('Barra baja', 'AAA111', club.bar_id);
    tAlta = await altaTerminal('Barra alta', 'BBB222', club.locations['barra-alta']);
    await f.openTill(club.id, { cashier: cajero, locationId: club.bar_id, authorizer: manager });
  });

  it('sin mandar terminal, cobra en la de su barra', async () => {
    const waiter = await f.createUser(club.id, { role: 'waiter', on_shift: true });
    const table = await f.createTable(club.id, { code: 'T-3', section: 'ZONA ROJA', capacity: 4 });
    const beer = await f.createDrink(club.id, { name: 'Cerveza', price: 60, stock: 40 });
    const pedido = await api().post(url('/orders')).set(await auth(waiter)).send({
      client_request_id: crypto.randomUUID(), table_id: table.id,
      items: [{ drink_id: beer.id, quantity: 2 }],
    });
    expect(pedido.status).toBe(201);
    await pool.query('UPDATE drink_orders SET bar_location_id = $1 WHERE id = $2',
      [club.bar_id, pedido.body.order.id]);

    const res = await api().post(url('/terminal-charges')).set(await auth(cajero))
      .send({ transaction_id: pedido.body.order.transaction_id });
    if (res.status !== 201) throw new Error(JSON.stringify(res.body));
    const orden = [...mpFake.orders.values()][0];
    expect(orden._terminal).toBe(`NEWLAND_N950__AAA111`);
    expect(res.body.charge.terminal.label).toBe('Barra baja');
  });

  it('no puede mandar el cobro a la terminal de otra barra', async () => {
    const tx = await cobroDeBarra();
    const res = await api().post(url('/terminal-charges')).set(await auth(manager))
      .send({ transaction_id: tx.id });
    // El gerente no tiene lugar: tiene que decir cuál. Y la caja con la ajena:
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/Falta la terminal/);
    const terminalCharges = require('../src/services/terminal-charges');
    const client = await pool.connect();
    try {
      await expect(terminalCharges.resolveTerminal(client, {
        nightclubId: club.id, locationId: club.bar_id, requested: tAlta.id,
      })).rejects.toMatchObject({ status: 403 });
      await expect(terminalCharges.resolveTerminal(client, {
        nightclubId: club.id, locationId: club.bar_id, requested: null,
      })).resolves.toBe(tBaja.id);
      await expect(terminalCharges.resolveTerminal(client, {
        nightclubId: club.id, locationId: club.bar_id, requested: tBaja.id,
      })).resolves.toBe(tBaja.id);
    } finally { client.release(); }
  });
});

describe('Cover en la puerta con la terminal', () => {
  let tPuerta; let cover;
  beforeEach(async () => {
    tPuerta = await altaTerminal('Puerta', 'DDD444', doorId);
    const c = await api().post(url('/cover-prices')).set(await auth(manager))
      .send({ name: 'General', amount: 300, currency: 'MXN' });
    expect(c.status).toBe(201);
    cover = c.body.cover_price || c.body;
  });

  const cobrar = async (over = {}) => api().post(url('/door/point-charges')).set(await auth(hostess))
    .send({ kind: 'general', quantity: 2, cover_price_id: cover.id, ...over });
  const asentar = async (chargeId, over = {}) => api().post(url('/door/admissions')).set(await auth(hostess))
    .send({ kind: 'general', quantity: 2, cover_price_id: cover.id, payment_method: 'point',
      terminal_charge_id: chargeId, ...over });

  it('primero la tarjeta: sin aprobar no hay entrada; aprobada, se asienta UNA vez', async () => {
    const res = await cobrar();
    if (res.status !== 201) throw new Error(JSON.stringify(res.body));
    expect(res.status).toBe(201);
    expect(res.body.charge.amount).toBe('600.00');
    const orden = [...mpFake.orders.values()][0];
    expect(orden._terminal).toBe(tPuerta.external_id);

    const tx = await pool.query(`SELECT status, type FROM transactions WHERE id = (SELECT transaction_id FROM terminal_charges WHERE id = $1)`, [res.body.charge.id]);
    expect(tx.rows[0]).toMatchObject({ status: 'pending', type: 'cover' });

    // La tarjeta todavía no pasa.
    const antes = await asentar(res.body.charge.id);
    expect(antes.status).toBe(409);
    expect((await pool.query('SELECT count(*)::int AS n FROM door_admissions')).rows[0].n).toBe(0);

    // Aparece en pendientes mientras espera.
    const pend = await api().get(url('/door/point-charges/pending')).set(await auth(hostess));
    expect(pend.body.charges).toHaveLength(1);

    resolverOrden(orden.id, 'processed');
    expect((await notificar(orden.id)).status).toBe(200);

    const ok = await asentar(res.body.charge.id);
    expect(ok.status).toBe(201);
    expect(ok.body.admission).toMatchObject({ payment_method: 'point', total: '600.00' });
    expect(ok.body.drawer).toBeNull();

    const pagado = await pool.query(
      `SELECT status, provider FROM transactions WHERE id = (SELECT transaction_id FROM terminal_charges WHERE id = $1)`,
      [res.body.charge.id]);
    expect(pagado.rows[0]).toMatchObject({ status: 'paid', provider: 'mercadopago' });

    // La misma tarjeta no vende otra entrada.
    const otra = await asentar(res.body.charge.id, { client_request_id: crypto.randomUUID() });
    expect(otra.status).toBe(409);
    expect((await pool.query('SELECT count(*)::int AS n FROM door_admissions')).rows[0].n).toBe(1);
    const vacio = await api().get(url('/door/point-charges/pending')).set(await auth(hostess));
    expect(vacio.body.charges).toHaveLength(0);
  });

  it('un cobro aprobado por otro monto no ampara esta entrada', async () => {
    const res = await cobrar({ quantity: 1 });
    const orden = [...mpFake.orders.values()][0];
    resolverOrden(orden.id, 'processed');
    await notificar(orden.id);
    const mal = await asentar(res.body.charge.id, { quantity: 3 });
    expect(mal.status).toBe(409);
    expect((await pool.query('SELECT count(*)::int AS n FROM door_admissions')).rows[0].n).toBe(0);
  });

  it('si la tarjeta no pasa, no queda entrada y el renglón se cancela', async () => {
    const res = await cobrar();
    const orden = [...mpFake.orders.values()][0];
    resolverOrden(orden.id, 'failed');
    await notificar(orden.id);
    const tx = await pool.query(
      `SELECT status FROM transactions WHERE id = (SELECT transaction_id FROM terminal_charges WHERE id = $1)`,
      [res.body.charge.id]);
    expect(tx.rows[0].status).toBe('cancelled');
    const mal = await asentar(res.body.charge.id);
    expect(mal.status).toBe(409);
  });

  it('sin terminal asignada a la puerta, lo dice', async () => {
    await api().patch(url(`/payment-terminals/${tPuerta.id}`)).set(await auth(manager))
      .send({ location_id: null });
    const res = await cobrar();
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/no tiene una terminal asignada/);
  });

  it('un cover en dólares no pasa por la terminal', async () => {
    const usd = await api().post(url('/cover-prices')).set(await auth(manager))
      .send({ name: 'USD', amount: 20, currency: 'USD' });
    const c = usd.body.cover_price || usd.body;
    const res = await cobrar({ cover_price_id: c.id });
    expect(res.status).toBe(422);
  });
});

describe('Avisos de cobro', () => {
  it('suenan aprobado, rechazado y vencido; los pasos intermedios no', async () => {
    const quien = (status) => push.CATALOG.terminal_charge_updated(pool, {
      nightclub_id: club.id,
      payload: { status, started_by: cajero.id, amount: '600.00', currency: 'MXN', terminal: 'Puerta', charge_id: 'c1' },
    });
    const keys = async (status) => (await quien(status)).map((n) => n.key);
    expect(new Set(await keys('processed'))).toEqual(new Set(['terminalPaid']));
    expect(new Set(await keys('failed'))).toEqual(new Set(['terminalRejected']));
    expect(new Set(await keys('expired'))).toEqual(new Set(['terminalExpired']));
    expect(await keys('waiting')).toEqual([]);
    const ids = (await quien('processed')).map((n) => n.id);
    expect(ids).toContain(cajero.id);
    expect(ids).toContain(manager.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
