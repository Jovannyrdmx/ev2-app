/**
 * Cobrar con la terminal del club (D47).
 *
 * Mercado Pago no se llama de verdad: `fetch` se sustituye por una tienda de respuestas
 * que este archivo controla. No es por comodidad — es la única forma de probar los casos
 * que importan, que son justo los que no se pueden provocar a voluntad contra un
 * servidor ajeno: la red que se cae a la mitad, la notificación que llega dos veces, la
 * que llega con una firma falsa, y la que dice que cobró un monto distinto del que
 * pedimos.
 *
 * Lo que se comprueba en todos ellos es una sola cosa: **que el libro solo se mueva
 * cuando de verdad se cobró, y una sola vez.**
 */
'use strict';

const crypto = require('crypto');
const { setupSchema, truncateAll, closePool, pool } = require('./helpers/db');
const { api, auth } = require('./helpers/api');
const f = require('./helpers/factories');
const terminalCharges = require('../src/services/terminal-charges');

let club; let manager; let waiter; let guest;

// ---------------------------------------------------------------- Mercado Pago de mentira

/** Lo que el falso Mercado Pago va a contestar, y lo que se le pidió. */
const mpFake = { orders: new Map(), calls: [], failNext: null, terminals: [] };

const ORDER_ID = () => `ORDTST${crypto.randomBytes(6).toString('hex').toUpperCase()}`;

function fakeFetch(url, opts = {}) {
  const method = opts.method || 'GET';
  const path = String(url).replace('https://api.mercadopago.com', '');
  const body = opts.body ? JSON.parse(opts.body) : null;
  mpFake.calls.push({
    method, path, body, idempotency: (opts.headers || {})['X-Idempotency-Key'] || null,
    headers: opts.headers || {},
  });

  if (mpFake.failNext) {
    const fallo = mpFake.failNext;
    mpFake.failNext = null;
    if (fallo === 'abort') {
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      return Promise.reject(err);
    }
    return Promise.resolve(respuesta(fallo.status, fallo.body));
  }

  if (method === 'GET' && path.startsWith('/terminals/v1/list')) {
    return Promise.resolve(respuesta(200, { data: { terminals: mpFake.terminals } }));
  }
  if (method === 'PATCH' && path === '/terminals/v1/setup') {
    return Promise.resolve(respuesta(200, { live_mode: false, terminals: body.terminals }));
  }
  if (method === 'POST' && path === '/v1/orders') {
    // La idempotencia de verdad: la MISMA llave devuelve la MISMA orden.
    const llave = (opts.headers || {})['X-Idempotency-Key'];
    const yaEsta = [...mpFake.orders.values()].find((o) => o._key === llave);
    if (yaEsta) return Promise.resolve(respuesta(201, yaEsta));
    const order = {
      id: ORDER_ID(),
      status: 'created',
      live_mode: false,
      total_amount: body.transactions.payments[0].amount,
      external_reference: body.external_reference,
      _key: llave,
    };
    mpFake.orders.set(order.id, order);
    return Promise.resolve(respuesta(201, order));
  }
  const verOrden = /^\/v1\/orders\/([^/]+)$/.exec(path);
  if (method === 'GET' && verOrden) {
    const order = mpFake.orders.get(decodeURIComponent(verOrden[1]));
    return Promise.resolve(order ? respuesta(200, order) : respuesta(404, { message: 'not found' }));
  }
  const cancelar = /^\/v1\/orders\/([^/]+)\/cancel$/.exec(path);
  if (method === 'POST' && cancelar) {
    const order = mpFake.orders.get(decodeURIComponent(cancelar[1]));
    if (!order) return Promise.resolve(respuesta(404, { message: 'not found' }));
    // Como lo documenta Mercado Pago: sin la cabecera, solo cancela lo que sigue en
    // `created`. Una orden que la terminal ya enseña se niega.
    const permite = (opts.headers || {})['x-allow-cancelable-status'] === 'at_terminal';
    if (order.status === 'at_terminal' && !permite) {
      return Promise.resolve(respuesta(409, { errors: [{ code: 'cannot_cancel_order', message: 'Order status at_terminal can not be canceled' }] }));
    }
    if (!['created', 'at_terminal'].includes(order.status)) {
      return Promise.resolve(respuesta(409, { errors: [{ code: 'cannot_cancel_order', message: `Order status ${order.status} can not be canceled` }] }));
    }
    order.status = 'canceled';
    return Promise.resolve(respuesta(200, order));
  }
  const devolver = /^\/v1\/orders\/([^/]+)\/refund$/.exec(path);
  if (method === 'POST' && devolver) {
    const order = mpFake.orders.get(decodeURIComponent(devolver[1]));
    if (!order) return Promise.resolve(respuesta(404, { errors: [{ code: 'order_not_found' }] }));
    const llave = (opts.headers || {})['X-Idempotency-Key'];
    mpFake.refundKeys = mpFake.refundKeys || new Map();
    if (mpFake.refundKeys.has(llave)) return Promise.resolve(respuesta(201, mpFake.refundKeys.get(llave)));
    if (order.status === 'refunded') {
      return Promise.resolve(respuesta(409, { errors: [{ code: 'order_already_refunded', message: 'already refunded' }] }));
    }
    if (order.status !== 'processed') {
      return Promise.resolve(respuesta(409, { errors: [{ code: 'cannot_refund_order', message: 'cannot refund' }] }));
    }
    const pago = order.transactions.payments[0];
    const total = (Number(pago.paid_amount || order.total_paid_amount)).toFixed(2);
    pago.refunded_amount = total;
    order.status = 'refunded';
    order.status_detail = 'refunded';
    order.transactions.refunds = [{
      id: `REF${crypto.randomBytes(5).toString('hex').toUpperCase()}`,
      transaction_id: pago.id, amount: total, status: 'processing',
    }];
    const copia = JSON.parse(JSON.stringify(order));
    mpFake.refundKeys.set(llave, copia);
    return Promise.resolve(respuesta(201, copia));
  }
  const eventos = /^\/v1\/orders\/([^/]+)\/events$/.exec(path);
  if (method === 'POST' && eventos) {
    const order = mpFake.orders.get(decodeURIComponent(eventos[1]));
    if (!order) return Promise.resolve(respuesta(404, { message: 'not found' }));
    Object.assign(order, {
      status: body.status,
      status_detail: body.status_detail,
      total_paid_amount: body.status === 'processed' ? order.total_amount : null,
      transactions: {
        payments: [{
          amount: order.total_amount,
          status_detail: body.status_detail,
          payment_method: {
            id: body.payment_method_id, type: body.payment_method_type, installments: 1,
          },
        }],
      },
    });
    return Promise.resolve(respuesta(204, null));
  }
  return Promise.resolve(respuesta(404, { message: `sin ruta falsa para ${method} ${path}` }));
}

function respuesta(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(body === null ? '' : JSON.stringify(body)),
  };
}

/** Pone la orden en el estado que sea, como lo haría el simulador de Mercado Pago. */
function resolverOrden(orderId, status, extra = {}) {
  const order = mpFake.orders.get(orderId);
  Object.assign(order, {
    status,
    status_detail: extra.status_detail || (status === 'processed' ? 'accredited' : status),
    total_paid_amount: status === 'processed'
      ? (extra.paid ?? order.total_amount) : null,
    transactions: {
      payments: [{
        id: order._payId || (order._payId = `PAY${crypto.randomBytes(6).toString('hex').toUpperCase()}`),
        amount: order.total_amount,
        ...(extra.tip ? { tip_amount: extra.tip } : {}),
        payment_method: { id: 'visa', type: 'credit_card', installments: 1 },
      }],
    },
  });
  return order;
}

let fetchOriginal;

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
  mpFake.failNext = null;
  mpFake.refundKeys = new Map();
  mpFake.terminals = [
    { id: 'NEWLAND_N950__SBX0000001', operating_mode: 'PDV' },
    { id: 'NEWLAND_N950__N950NCB801293324', operating_mode: 'STANDALONE' },
  ];
  process.env.MERCADOPAGO_ACCESS_TOKEN = 'APP_USR-fake-token-for-tests';
  process.env.MERCADOPAGO_PUBLIC_KEY = 'APP_USR-fake-public-key';
  process.env.MERCADOPAGO_ENV = 'test';
  process.env.MERCADOPAGO_WEBHOOK_SECRET = 'secreto-de-prueba';

  club = await f.createNightclub({ slug: 'ev2-mp' });
  manager = await f.createUser(club.id, { role: 'manager' });
  waiter = await f.createUser(club.id, { role: 'waiter' });
  guest = await f.createUser(club.id, { role: 'guest' });
});

// ---------------------------------------------------------------- ayudas

const tokenDe = (user) => auth(user);

/** Una terminal dada de alta, lista para cobrar. */
async function altaTerminal(label = 'Barra', externalId = 'NEWLAND_N950__SBX0000001') {
  const res = await api().post(`/api/nightclubs/${club.id}/payment-terminals`)
    .set(await tokenDe(manager))
    .send({ external_id: externalId, label });
  expect(res.status).toBe(201);
  return res.body.terminal;
}

/** Un renglón del libro por cobrar, como el de un pedido. */
async function cobroPendiente(amount = '450.00') {
  const { rows } = await pool.query(
    `INSERT INTO transactions (nightclub_id, type, direction, amount, currency, status,
                               payer_user_id, provider)
     VALUES ($1,'drink_order','in',$2,'MXN','pending',$3,'manual')
     RETURNING id, amount::text AS amount, status`,
    [club.id, amount, guest.id]);
  return rows[0];
}

const empezar = async (tx, terminal, quien = waiter) => api()
  .post(`/api/nightclubs/${club.id}/terminal-charges`)
  .set(await tokenDe(quien))
  .send({ transaction_id: tx.id, terminal_id: terminal.id });

/** La notificación, firmada como la firma Mercado Pago. */
async function notificar(orderId, { requestId = crypto.randomUUID(), secret = 'secreto-de-prueba', action = 'order.processed' } = {}) {
  const ts = Date.now();
  const manifest = `id:${orderId};request-id:${requestId};ts:${ts};`;
  const v1 = crypto.createHmac('sha256', secret).update(manifest).digest('hex');
  return api().post('/api/payments/mercadopago/webhook')
    .set('x-signature', `ts=${ts},v1=${v1}`)
    .set('x-request-id', requestId)
    .send({ action, type: 'order', data: { id: orderId } });
}

const estadoDe = async (txId) => (await pool.query(
  'SELECT status, provider, provider_ref FROM transactions WHERE id = $1', [txId])).rows[0];

// ---------------------------------------------------------------- las terminales

describe('Las terminales del club', () => {
  it('se listan las de la cuenta y se ve cuál ya está dada de alta', async () => {
    await altaTerminal();
    const res = await api().post(`/api/nightclubs/${club.id}/payment-terminals/discover`)
      .set(await tokenDe(manager)).send({});
    expect(res.status).toBe(200);
    const sbx = res.body.terminals.find((t) => t.external_id.includes('SBX0000001'));
    expect(sbx.registered).toBe(true);
    expect(res.body.terminals.find((t) => t.external_id.includes('N950NCB')).registered).toBe(false);
  });

  it('darla de alta la pasa a PDV, que es el único modo en que obedece', async () => {
    await api().post(`/api/nightclubs/${club.id}/payment-terminals`)
      .set(await tokenDe(manager))
      .send({ external_id: 'NEWLAND_N950__N950NCB801293324', label: 'Puerta' });
    const patch = mpFake.calls.find((c) => c.path === '/terminals/v1/setup');
    expect(patch.body.terminals[0].operating_mode).toBe('PDV');
  });

  it('no se puede repetir el nombre ni el aparato', async () => {
    await altaTerminal('Barra');
    const mismoNombre = await api().post(`/api/nightclubs/${club.id}/payment-terminals`)
      .set(await tokenDe(manager))
      .send({ external_id: 'NEWLAND_N950__OTRA', label: 'Barra' });
    expect(mismoNombre.status).toBe(409);
  });

  it('el mesero las ve pero no las da de alta', async () => {
    await altaTerminal();
    expect((await api().get(`/api/nightclubs/${club.id}/payment-terminals`)
      .set(await tokenDe(waiter))).status).toBe(200);
    expect((await api().post(`/api/nightclubs/${club.id}/payment-terminals`)
      .set(await tokenDe(waiter))
      .send({ external_id: 'X__Y', label: 'Mía' })).status).toBe(403);
  });

  it('una terminal en STANDALONE no cobra, y lo dice antes de intentarlo', async () => {
    // Es el motivo número uno de "toco cobrar y no pasa nada": viene así de fábrica.
    const t = await altaTerminal('Puerta', 'NEWLAND_N950__N950NCB801293324');
    await pool.query("UPDATE payment_terminals SET operating_mode = 'STANDALONE' WHERE id = $1", [t.id]);
    const tx = await cobroPendiente();
    const res = await empezar(tx, t);
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/STANDALONE/);
    // Y no se le pidió nada a Mercado Pago: se paró antes.
    expect(mpFake.calls.filter((c) => c.path === '/v1/orders')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------- el cobro

describe('Cobrar', () => {
  it('despierta la terminal y contesta sin esperar a que el cliente pague', async () => {
    const t = await altaTerminal();
    const tx = await cobroPendiente('450.00');
    const res = await empezar(tx, t);

    expect(res.status).toBe(201);
    expect(res.body.charge.status).toBe('waiting');
    expect(res.body.charge.is_final).toBe(false);
    // El libro NO se movió: todavía no hay dinero.
    expect((await estadoDe(tx.id)).status).toBe('pending');

    const creada = mpFake.calls.find((c) => c.path === '/v1/orders');
    expect(creada.body.type).toBe('point');
    // Dos decimales exactos: un `450` en vez de `"450.00"` es un 400 en plena barra.
    expect(creada.body.transactions.payments[0].amount).toBe('450.00');
    expect(creada.body.config.point.terminal_id).toBe('NEWLAND_N950__SBX0000001');
    expect(creada.idempotency).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('el segundo mesero que toca cobrar NO despierta una segunda terminal', async () => {
    // Sin esto, el cliente paga dos veces y la segunda es una devolución que nadie nota
    // esa noche.
    const t = await altaTerminal();
    const tx = await cobroPendiente();
    expect((await empezar(tx, t)).status).toBe(201);
    const segundo = await empezar(tx, t, manager);
    expect(segundo.status).toBe(409);
    expect(mpFake.calls.filter((c) => c.path === '/v1/orders')).toHaveLength(1);
  });

  it('no se cobra un renglón que ya está pagado', async () => {
    const t = await altaTerminal();
    const tx = await cobroPendiente();
    await pool.query("UPDATE transactions SET status = 'paid' WHERE id = $1", [tx.id]);
    expect((await empezar(tx, t)).status).toBe(409);
  });

  it('un invitado no puede cobrarle a nadie', async () => {
    const t = await altaTerminal();
    const tx = await cobroPendiente();
    expect((await empezar(tx, t, guest)).status).toBe(403);
  });
});

// ---------------------------------------------------------------- el resultado

describe('Cuando la tarjeta pasa', () => {
  async function cobroEsperando() {
    const t = await altaTerminal();
    const tx = await cobroPendiente('450.00');
    const res = await empezar(tx, t);
    const { rows } = await pool.query(
      'SELECT external_order_id FROM terminal_charges WHERE id = $1', [res.body.charge.id]);
    return { tx, charge: res.body.charge, orderId: rows[0].external_order_id };
  }

  it('el libro queda pagado, y dice que fue Mercado Pago y con qué folio', async () => {
    const { tx, orderId } = await cobroEsperando();
    resolverOrden(orderId, 'processed');
    expect((await notificar(orderId)).status).toBe(200);

    const libro = await estadoDe(tx.id);
    expect(libro.status).toBe('paid');
    expect(libro.provider).toBe('mercadopago');
    expect(libro.provider_ref).toBe(orderId);
  });

  it('la MISMA notificación dos veces no cobra dos veces', async () => {
    // Mercado Pago reintenta hasta que le contestamos 200, así que esto pasa de verdad.
    const { tx, orderId, charge } = await cobroEsperando();
    resolverOrden(orderId, 'processed');
    const req = crypto.randomUUID();
    expect((await notificar(orderId, { requestId: req })).status).toBe(200);
    expect((await notificar(orderId, { requestId: req })).status).toBe(200);

    expect((await estadoDe(tx.id)).status).toBe('paid');
    const cobros = await pool.query(
      "SELECT count(*)::int AS n FROM terminal_charges WHERE transaction_id = $1 AND status = 'processed'",
      [tx.id]);
    expect(cobros.rows[0].n).toBe(1);
    const pasos = await pool.query(
      "SELECT count(*)::int AS n FROM terminal_charge_events WHERE charge_id = $1 AND request_id = $2",
      [charge.id, req]);
    // El índice único sobre (cobro, notificación) cuenta una sola vez la misma entrega.
    expect(pasos.rows[0].n).toBe(1);
  });

  it('NO se cree lo que dice la notificación: vuelve a preguntar', async () => {
    // La notificación dice "order.processed" y la orden de verdad está fallida. Gana la
    // orden. Es lo que hace que un webhook falsificado no mueva un peso.
    const { tx, orderId } = await cobroEsperando();
    resolverOrden(orderId, 'failed', { status_detail: 'insufficient_amount' });
    expect((await notificar(orderId, { action: 'order.processed' })).status).toBe(200);

    expect((await estadoDe(tx.id)).status).toBe('pending');
    const { rows } = await pool.query(
      'SELECT status, status_detail FROM terminal_charges WHERE transaction_id = $1', [tx.id]);
    expect(rows[0].status).toBe('failed');
    expect(rows[0].status_detail).toBe('insufficient_amount');
  });

  it('si cobró un monto distinto del que pedimos, NO se da por pagado', async () => {
    // Un renglón dado por pagado con menos dinero del que vale es dinero que el club no
    // cobró y que ya nadie va a reclamar.
    const { tx, orderId } = await cobroEsperando();
    resolverOrden(orderId, 'processed', { paid: '400.00' });
    await notificar(orderId);

    expect((await estadoDe(tx.id)).status).toBe('pending');
    const { rows } = await pool.query(
      'SELECT status, status_detail FROM terminal_charges WHERE transaction_id = $1', [tx.id]);
    expect(rows[0].status).toBe('error');
    expect(rows[0].status_detail).toMatch(/400/);
  });

  it('una firma falsa se anota, pero no decide', async () => {
    // La firma es una señal. La verdad es el GET con nuestro token — entre otras cosas
    // porque hoy la validación de firma de la Orders API tiene un defecto abierto en los
    // propios SDK de Mercado Pago, y colgar el cobro de ella sería dejar que un defecto
    // ajeno le diga al club que un pago real no ocurrió.
    const { tx, orderId, charge } = await cobroEsperando();
    resolverOrden(orderId, 'processed');
    expect((await notificar(orderId, { secret: 'el-secreto-equivocado' })).status).toBe(200);

    expect((await estadoDe(tx.id)).status).toBe('paid');
    const { rows } = await pool.query(
      `SELECT payload->>'signature' AS firma FROM terminal_charge_events
        WHERE charge_id = $1 AND source = 'webhook' ORDER BY id LIMIT 1`, [charge.id]);
    expect(rows[0].firma).toBe('invalid');
  });

  it('una firma buena se anota como buena', async () => {
    const { orderId, charge } = await cobroEsperando();
    resolverOrden(orderId, 'processed');
    await notificar(orderId);
    const { rows } = await pool.query(
      `SELECT payload->>'signature' AS firma FROM terminal_charge_events
        WHERE charge_id = $1 AND source = 'webhook' ORDER BY id LIMIT 1`, [charge.id]);
    expect(rows[0].firma).toBe('valid');
  });

  it('una notificación de una orden que no es nuestra se contesta 200 y se tira', async () => {
    // Contestar otra cosa haría que Mercado Pago reintentara toda la noche.
    const res = await notificar('ORDTST-QUE-NO-EXISTE');
    expect(res.status).toBe(200);
    expect(res.body.ignored).toBeDefined();
  });

  it('lo que Mercado Pago dijo no se puede editar después', async () => {
    const { orderId, charge } = await cobroEsperando();
    resolverOrden(orderId, 'processed');
    await notificar(orderId);
    await expect(pool.query(
      "UPDATE terminal_charge_events SET action = 'otra cosa' WHERE charge_id = $1",
      [charge.id])).rejects.toThrow(/insert-only/);
  });
});

// ---------------------------------------------------------------- lo que sale mal

describe('Cuando algo falla', () => {
  it('un tiempo de espera NO es una tarjeta rechazada', async () => {
    // Es "no sabemos": la orden puede existir del otro lado. Marcarla fallida y dejar
    // que el mesero vuelva a cobrar es cómo se cobra dos veces.
    const t = await altaTerminal();
    const tx = await cobroPendiente();
    mpFake.failNext = 'abort';
    const res = await empezar(tx, t);

    expect(res.status).toBe(504);
    const { rows } = await pool.query(
      'SELECT status, external_order_id FROM terminal_charges WHERE transaction_id = $1', [tx.id]);
    expect(rows[0].status).toBe('creating');
    expect(rows[0].external_order_id).toBeNull();
    expect((await estadoDe(tx.id)).status).toBe('pending');
  });

  it('cancelar apaga la terminal ANTES de dar el cobro por muerto', async () => {
    // Al revés, la terminal se quedaría pidiendo una tarjeta por un cobro que el sistema
    // ya cerró — y alguien la pasaría.
    const t = await altaTerminal();
    const tx = await cobroPendiente();
    const creado = await empezar(tx, t);
    const res = await api()
      .post(`/api/nightclubs/${club.id}/terminal-charges/${creado.body.charge.id}/cancel`)
      .set(await tokenDe(waiter)).send({});

    expect(res.status).toBe(200);
    expect(res.body.charge.status).toBe('canceled');
    const orden = mpFake.calls.filter((c) => c.path.endsWith('/cancel'));
    expect(orden).toHaveLength(1);
    expect((await estadoDe(tx.id)).status).toBe('pending');
  });

  it('un cobro ya pagado no se puede cancelar', async () => {
    const t = await altaTerminal();
    const tx = await cobroPendiente();
    const creado = await empezar(tx, t);
    const { rows } = await pool.query(
      'SELECT external_order_id FROM terminal_charges WHERE id = $1', [creado.body.charge.id]);
    resolverOrden(rows[0].external_order_id, 'processed');
    await notificar(rows[0].external_order_id);

    const res = await api()
      .post(`/api/nightclubs/${club.id}/terminal-charges/${creado.body.charge.id}/cancel`)
      .set(await tokenDe(waiter)).send({});
    expect(res.status).toBe(409);
  });

  it('consultar el cobro pregunta a Mercado Pago si sigue esperando', async () => {
    // Quien abre esa pantalla es alguien mirando algo que no cambia: el webhook pudo no
    // llegar, y preguntar es más barato que dejarlo colgado.
    const t = await altaTerminal();
    const tx = await cobroPendiente();
    const creado = await empezar(tx, t);
    const { rows } = await pool.query(
      'SELECT external_order_id FROM terminal_charges WHERE id = $1', [creado.body.charge.id]);
    resolverOrden(rows[0].external_order_id, 'processed');

    const res = await api()
      .get(`/api/nightclubs/${club.id}/terminal-charges/${creado.body.charge.id}`)
      .set(await tokenDe(waiter));
    expect(res.status).toBe(200);
    expect(res.body.charge.status).toBe('processed');
    expect((await estadoDe(tx.id)).status).toBe('paid');
  });
});

// ---------------------------------------------------------------- las credenciales

describe('Las credenciales', () => {
  it('sin MERCADOPAGO_ENV no se cobra, y lo explica', async () => {
    // Hoy el token de prueba y el de producción empiezan igual (APP_USR): adivinar mal
    // es cobrarle a una tarjeta real creyendo que es un ensayo.
    const t = await altaTerminal();
    const tx = await cobroPendiente();
    delete process.env.MERCADOPAGO_ENV;
    const res = await empezar(tx, t);
    expect(res.status).toBe(501);
    expect(res.body.error.message).toMatch(/MERCADOPAGO_ENV/);
    process.env.MERCADOPAGO_ENV = 'test';
  });

  it('si el .env dice prueba y la cuenta contesta real, se detiene', async () => {
    const t = await altaTerminal();
    const tx = await cobroPendiente();
    mpFake.failNext = { status: 201, body: { id: ORDER_ID(), status: 'created', live_mode: true } };
    const res = await empezar(tx, t);
    // 503 y no 500 a propósito: un 500 se contesta sin el motivo, y el motivo es lo
    // único útil aquí.
    expect(res.status).toBe(503);
    expect(res.body.error.message).toMatch(/PRODUCCIÓN/);
    expect((await estadoDe(tx.id)).status).toBe('pending');
  });

  it('sin token, la ruta lo dice en vez de fallar de forma rara', async () => {
    const t = await altaTerminal();
    const tx = await cobroPendiente();
    const antes = process.env.MERCADOPAGO_ACCESS_TOKEN;
    delete process.env.MERCADOPAGO_ACCESS_TOKEN;
    const res = await empezar(tx, t);
    expect(res.status).toBe(501);
    expect(res.body.error.message).toMatch(/MERCADOPAGO_ACCESS_TOKEN/);
    process.env.MERCADOPAGO_ACCESS_TOKEN = antes;
  });
});

// ---------------------------------------------------------------- el doble cobro

describe('Que no se cobre dos veces', () => {
  it('con la terminal esperando la tarjeta, NO se puede cobrar en efectivo', async () => {
    // El caso real: la terminal tarda, el cliente saca billetes, el mesero cobra en
    // efectivo y se olvida de cancelar el cobro. La tarjeta pasa treinta segundos
    // después y el cliente pagó dos veces.
    const t = await altaTerminal();
    const tx = await cobroPendiente('450.00');
    expect((await empezar(tx, t)).status).toBe(201);

    const efectivo = await api()
      .post(`/api/nightclubs/${club.id}/manual-payments/register`)
      .set(await tokenDe(waiter))
      .send({
        transaction_id: tx.id, method: 'cash', amount: 450, currency: 'MXN',
      });

    expect(efectivo.status).toBe(409);
    // El mensaje tiene que decir el nombre de la terminal: en una barra con tres, saber
    // cuál es la que hay que cancelar es la diferencia entre resolverlo y no.
    expect(efectivo.body.error.message).toMatch(/Barra/);
    expect(efectivo.body.error.details.terminal_charge_id).toBeTruthy();
    expect((await estadoDe(tx.id)).status).toBe('pending');
  });

  it('cancelado el cobro de la terminal, el efectivo ya pasa', async () => {
    const t = await altaTerminal();
    const tx = await cobroPendiente('450.00');
    const creado = await empezar(tx, t);
    await api()
      .post(`/api/nightclubs/${club.id}/terminal-charges/${creado.body.charge.id}/cancel`)
      .set(await tokenDe(waiter)).send({});

    const efectivo = await api()
      .post(`/api/nightclubs/${club.id}/manual-payments/register`)
      .set(await tokenDe(waiter))
      .send({ transaction_id: tx.id, method: 'cash', amount: 450, currency: 'MXN' });

    expect(efectivo.status).toBe(201);
    expect((await estadoDe(tx.id)).status).toBe('paid');
  });

  it('si la tarjeta cobró y el libro no lo aceptó, queda la evidencia', async () => {
    // Lo peor que puede pasar: hay dinero cobrado al cliente y el sistema no lo refleja.
    // El ROLLBACK de la transacción borraría hasta el rastro de que pasó, así que el
    // renglón de evidencia se escribe FUERA de ella.
    const t = await altaTerminal();
    const tx = await cobroPendiente('450.00');
    const creado = await empezar(tx, t);
    const chargeId = creado.body.charge.id;
    const { rows } = await pool.query(
      'SELECT external_order_id FROM terminal_charges WHERE id = $1', [chargeId]);
    const orderId = rows[0].external_order_id;

    // El renglón se cancela por otra vía: asentar el pago va a reventar dentro de la
    // transacción, que es justo lo que se quiere provocar.
    await pool.query("UPDATE transactions SET status = 'cancelled' WHERE id = $1", [tx.id]);

    resolverOrden(orderId, 'processed');
    await notificar(orderId);

    const cobro = (await pool.query(
      'SELECT status, status_detail FROM terminal_charges WHERE id = $1', [chargeId])).rows[0];
    expect(cobro.status).toBe('error');
    expect(cobro.status_detail).toMatch(/cobrado pero no se pudo asentar/);

    const evidencia = await pool.query(
      `SELECT action FROM terminal_charge_events
        WHERE charge_id = $1 AND action = 'settle_failed'`, [chargeId]);
    expect(evidencia.rowCount).toBe(1);
  });

  it('el cobro que nunca devolvió id se reintenta con LA MISMA llave', async () => {
    // La llamada original se cortó a media respuesta: puede haber una orden viva en la
    // terminal con un id que nunca supimos. Reintentar con otra llave sería despertarla
    // dos veces; con la misma, Mercado Pago devuelve la que ya existe.
    const t = await altaTerminal();
    const tx = await cobroPendiente('450.00');
    mpFake.failNext = 'abort';
    const res = await empezar(tx, t);
    expect(res.status).toBe(504);

    const { rows } = await pool.query(
      `SELECT id, status, external_order_id, idempotency_key
         FROM terminal_charges WHERE transaction_id = $1`, [tx.id]);
    expect(rows[0].status).toBe('creating');
    expect(rows[0].external_order_id).toBeNull();
    const llave = rows[0].idempotency_key;

    // Dentro de la ventana no se toca: la petición original puede seguir en vuelo.
    mpFake.calls = [];
    expect(await terminalCharges.sweep(pool)).toEqual([]);
    expect(mpFake.calls.filter((c) => c.path === '/v1/orders')).toHaveLength(0);

    // Pasada la ventana, se reintenta.
    await pool.query(
      `UPDATE terminal_charges
          SET created_at = now() - interval '5 minutes', last_polled_at = NULL
        WHERE id = $1`, [rows[0].id]);
    const repaso = await terminalCharges.sweep(pool);

    expect(repaso).toEqual([{ id: rows[0].id, status: 'waiting', recovered: true }]);
    const reintento = mpFake.calls.filter((c) => c.path === '/v1/orders');
    expect(reintento).toHaveLength(1);
    expect(reintento[0].idempotency).toBe(llave);

    const despues = (await pool.query(
      'SELECT status, external_order_id FROM terminal_charges WHERE id = $1', [rows[0].id])).rows[0];
    expect(despues.status).toBe('waiting');
    expect(despues.external_order_id).toBeTruthy();
    // Y el libro sigue sin moverse: nadie ha pagado todavía.
    expect((await estadoDe(tx.id)).status).toBe('pending');
  });
});

// ---------------------------------------------------------------- el alta no se atora

describe('Dar de alta una terminal nunca deja al gerente atorado', () => {
  const FISICA = 'NEWLAND_N950__N950NCB801293324';
  const altaCruda = async (body) => api().post(`/api/nightclubs/${club.id}/payment-terminals`)
    .set(await tokenDe(manager)).send(body);
  const noAsociada = { status: 400, body: { message: 'Terminal not found or not associated with the user', status: 400 } };

  it('si Mercado Pago no deja pasarla a PDV, se guarda igual y dice por qué, en español', async () => {
    // Antes: 502, la terminal NO se guardaba, y volver a tocar daba lo mismo para siempre.
    mpFake.failNext = noAsociada;
    const res = await altaCruda({ external_id: FISICA, label: 'Barra' });

    expect(res.status).toBe(201);
    expect(res.body.terminal.operating_mode).toBeNull();
    expect(res.body.warning).toMatch(/no está vinculada a la cuenta/);
    // El texto original de Mercado Pago viaja también: si la traducción falla, sigue ahí.
    expect(res.body.warning).toMatch(/not associated with the user/);
  });

  it('una terminal con el modo sin confirmar NO cobra, y dice qué tocar', async () => {
    mpFake.failNext = noAsociada;
    const t = (await altaCruda({ external_id: FISICA, label: 'Barra' })).body.terminal;
    const tx = await cobroPendiente();
    mpFake.calls = [];

    const res = await empezar(tx, t);
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/Pasarla a PDV/);
    // Ni siquiera se le pidió la orden a Mercado Pago: se paró antes.
    expect(mpFake.calls.filter((c) => c.path === '/v1/orders')).toHaveLength(0);
  });

  it('"Pasarla a PDV" reintenta: si vuelve a fallar lo explica, y si pasa ya cobra', async () => {
    mpFake.failNext = noAsociada;
    const t = (await altaCruda({ external_id: FISICA, label: 'Barra' })).body.terminal;
    const url = `/api/nightclubs/${club.id}/payment-terminals/${t.id}`;

    mpFake.failNext = noAsociada;
    const otraVez = await api().patch(url).set(await tokenDe(manager)).send({ set_pdv: true });
    expect(otraVez.status).toBe(422);
    expect(otraVez.body.error.message).toMatch(/no está vinculada/);

    const ahora = await api().patch(url).set(await tokenDe(manager)).send({ set_pdv: true });
    expect(ahora.status).toBe(200);
    expect(ahora.body.terminal.operating_mode).toBe('PDV');
    expect((await empezar(await cobroPendiente(), t)).status).toBe(201);
  });

  it('un nombre repetido se rechaza ANTES de tocar la terminal', async () => {
    // Si no, se cambiaba el modo de un aparato para luego contestar "ese nombre ya existe".
    await altaTerminal('Barra');
    mpFake.calls = [];
    const res = await altaCruda({ external_id: FISICA, label: 'Barra' });
    expect(res.status).toBe(409);
    expect(mpFake.calls.filter((c) => c.path === '/terminals/v1/setup')).toHaveLength(0);
  });

  it('la terminal virtual no pide cambio de modo y se anuncia como de prueba', async () => {
    mpFake.calls = [];
    const res = await altaCruda({ external_id: 'NEWLAND_N950__SBX0000001', label: 'Prueba' });
    expect(res.status).toBe(201);
    expect(res.body.sandbox).toBe(true);
    expect(res.body.terminal.operating_mode).toBe('PDV');
    expect(mpFake.calls.filter((c) => c.path === '/terminals/v1/setup')).toHaveLength(0);
  });

  it('buscar pone al día el modo que dice Mercado Pago', async () => {
    // Alguien la regresó a STANDALONE desde el aparato: ya no debe verse "lista para cobrar".
    const t = await altaTerminal('Puerta', FISICA);
    expect(t.operating_mode).toBe('PDV');
    const res = await api().post(`/api/nightclubs/${club.id}/payment-terminals/discover`)
      .set(await tokenDe(manager)).send({});
    expect(res.status).toBe(200);
    const { rows } = await pool.query(
      'SELECT operating_mode FROM payment_terminals WHERE id = $1', [t.id]);
    expect(rows[0].operating_mode).toBe('STANDALONE');
  });
});

// ---------------------------------------------------------------- contra la guía de Point

describe('Lo que la guía de Point dice y faltaba', () => {
  /** Empieza un cobro y devuelve { t, tx, chargeId, orderId }. */
  async function cobroVivo(amount = '450.00') {
    const t = await altaTerminal();
    const tx = await cobroPendiente(amount);
    const creado = await empezar(tx, t);
    expect(creado.status).toBe(201);
    const { rows } = await pool.query(
      'SELECT external_order_id FROM terminal_charges WHERE id = $1', [creado.body.charge.id]);
    return { t, tx, chargeId: creado.body.charge.id, orderId: rows[0].external_order_id };
  }
  const verCobro = async (chargeId) => api()
    .get(`/api/nightclubs/${club.id}/terminal-charges/${chargeId}`).set(await tokenDe(waiter));
  const pagado = async (orderId, extra) => { resolverOrden(orderId, 'processed', extra); await notificar(orderId); };
  const devolver = async (chargeId, quien = manager, reason = 'Se cobró dos veces a la mesa 12') => api()
    .post(`/api/nightclubs/${club.id}/terminal-charges/${chargeId}/refund`)
    .set(await tokenDe(quien)).send({ reason });
  const libro = async (txId) => (await pool.query(
    `SELECT id, type, direction, amount::text AS amount, status, reference_id
       FROM transactions WHERE id = $1 OR reference_id = $1 ORDER BY created_at`, [txId])).rows;

  it('la vigencia viaja como ISO 8601 normalizado (PT3M, no PT180S)', async () => {
    await cobroVivo();
    const creada = mpFake.calls.find((c) => c.path === '/v1/orders');
    expect(creada.body.expiration_time).toBe('PT3M');
  });

  it('"at_terminal" ya no revienta: el cobro sigue esperando y dice que la terminal lo tiene', async () => {
    // Antes el CHECK de la tabla no aceptaba ese estado: cada consulta chocaba y la
    // excepción se tragaba en silencio.
    const { chargeId, orderId } = await cobroVivo();
    mpFake.orders.get(orderId).status = 'at_terminal';
    mpFake.orders.get(orderId).status_detail = 'at_terminal';

    const res = await verCobro(chargeId);
    expect(res.status).toBe(200);
    expect(res.body.charge.status).toBe('waiting');
    expect(res.body.charge.at_terminal).toBe(true);
    expect(res.body.charge.is_final).toBe(false);
  });

  it('el repaso tampoco se atora con "created" ni con "at_terminal"', async () => {
    const { chargeId, orderId } = await cobroVivo();
    await pool.query("UPDATE terminal_charges SET last_polled_at = NULL WHERE id = $1", [chargeId]);
    mpFake.orders.get(orderId).status = 'at_terminal';
    await terminalCharges.sweep(pool);
    const fallos = await pool.query(
      "SELECT 1 FROM terminal_charge_events WHERE charge_id = $1 AND action = 'poll_failed'", [chargeId]);
    expect(fallos.rowCount).toBe(0);
  });

  it('cancelar funciona aunque la terminal YA muestre el cobro', async () => {
    // Es el momento en que el cliente dice "mejor en efectivo". Sin la cabecera
    // `x-allow-cancelable-status`, Mercado Pago se negaba justo ahí.
    const { chargeId, orderId } = await cobroVivo();
    mpFake.orders.get(orderId).status = 'at_terminal';
    const res = await api()
      .post(`/api/nightclubs/${club.id}/terminal-charges/${chargeId}/cancel`)
      .set(await tokenDe(waiter)).send({});
    expect(res.status).toBe(200);
    expect(res.body.charge.status).toBe('canceled');
    const llamada = mpFake.calls.find((c) => c.path.endsWith('/cancel'));
    expect(llamada.headers['x-allow-cancelable-status']).toBe('at_terminal');
  });

  it('si la tarjeta pasó en el último segundo, cancelar NO lo da por cancelado', async () => {
    const { tx, chargeId, orderId } = await cobroVivo();
    resolverOrden(orderId, 'processed'); // pagó, y el webhook todavía no llega
    const res = await api()
      .post(`/api/nightclubs/${club.id}/terminal-charges/${chargeId}/cancel`)
      .set(await tokenDe(waiter)).send({});
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/YA pasó/);
    expect((await estadoDe(tx.id)).status).toBe('paid');
  });

  it('una propina en la terminal no convierte el cobro en "monto distinto"', async () => {
    const { tx, chargeId, orderId } = await cobroVivo('450.00');
    await pagado(orderId, { paid: '500.00', tip: '50.00' });
    expect((await estadoDe(tx.id)).status).toBe('paid');
    const res = await verCobro(chargeId);
    expect(res.body.charge.status).toBe('processed');
    expect(res.body.charge.tip_amount).toBe('50.00');
  });

  it('pero una diferencia que NO es la propina sigue siendo descuadre', async () => {
    const { tx, orderId } = await cobroVivo('450.00');
    await pagado(orderId, { paid: '520.00', tip: '50.00' });
    expect((await estadoDe(tx.id)).status).toBe('pending');
  });

  it('devolver: Mercado Pago lo devuelve y el libro asienta la SALIDA', async () => {
    const { tx, chargeId, orderId } = await cobroVivo('450.00');
    await pagado(orderId);

    const res = await devolver(chargeId);
    expect(res.status).toBe(200);
    expect(res.body.charge.status).toBe('refunded');
    expect(res.body.charge.refunded_amount).toBe('450.00');
    expect(res.body.charge.refunds).toHaveLength(1);
    expect(res.body.charge.refunds[0].reason).toMatch(/dos veces/);

    // El renglón original sale del ingreso, y la salida queda en su propio renglón.
    const filas = await libro(tx.id);
    expect(filas.find((r) => r.id === tx.id).status).toBe('refunded');
    const salida = filas.filter((r) => r.type === 'refund');
    expect(salida).toHaveLength(1);
    expect(salida[0]).toMatchObject({ direction: 'out', amount: '450.00', status: 'paid' });

    const pedida = mpFake.calls.find((c) => c.path.endsWith('/refund'));
    expect(pedida.idempotency).toMatch(/^[0-9a-f-]{36}$/);
    expect(pedida.body).toBeNull(); // total: cuerpo vacío, como dice la guía
  });

  it('su webhook de la misma devolución NO la asienta dos veces', async () => {
    const { tx, chargeId, orderId } = await cobroVivo();
    await pagado(orderId);
    await devolver(chargeId);
    await notificar(orderId, { action: 'order.refunded' });
    await notificar(orderId, { action: 'order.refunded' });

    expect((await libro(tx.id)).filter((r) => r.type === 'refund')).toHaveLength(1);
    const reembolsos = await pool.query('SELECT source FROM terminal_refunds WHERE charge_id = $1', [chargeId]);
    expect(reembolsos.rows.map((r) => r.source)).toEqual(['staff']);
  });

  it('una devolución hecha desde el panel de Mercado Pago también se asienta', async () => {
    // Antes este aviso llegaba a un cobro "ya terminado" y se tiraba.
    const { tx, chargeId, orderId } = await cobroVivo();
    await pagado(orderId);
    const order = mpFake.orders.get(orderId);
    order.status = 'refunded';
    order.transactions.payments[0].refunded_amount = '450.00';
    order.transactions.refunds = [{ id: 'REFPANEL1', amount: '450.00', status: 'processed' }];
    await notificar(orderId, { action: 'order.refunded' });

    expect((await estadoDe(tx.id)).status).toBe('refunded');
    const r = await pool.query('SELECT source, status, amount::text AS amount FROM terminal_refunds WHERE charge_id = $1', [chargeId]);
    expect(r.rows).toEqual([{ source: 'external', status: 'processed', amount: '450.00' }]);
  });

  it('una devolución PARCIAL desde el panel: el original sigue pagado y el tablero la resta', async () => {
    const { tx, orderId } = await cobroVivo('450.00');
    await pagado(orderId);
    await pool.query("UPDATE transactions SET type = 'drink_order' WHERE id = $1", [tx.id]);
    const order = mpFake.orders.get(orderId);
    order.transactions.payments[0].refunded_amount = '100.00';
    order.transactions.refunds = [{ id: 'REFPARC1', amount: '100.00', status: 'processed' }];
    await notificar(orderId, { action: 'order.refunded' });

    expect((await estadoDe(tx.id)).status).toBe('paid');
    const salida = (await libro(tx.id)).filter((r) => r.type === 'refund');
    expect(salida.map((r) => r.amount)).toEqual(['100.00']);

    const tablero = await api().get(`/api/nightclubs/${club.id}/dashboard`).set(await tokenDe(manager));
    const mxn = tablero.body.revenue_today.find((r) => r.currency === 'MXN');
    expect(mxn.total).toBe('350.00');
    expect(mxn.refunded_partial).toBe('100.00');
  });

  it('dos gerentes tocando "devolver" a la vez: solo una llega a Mercado Pago', async () => {
    const { chargeId, orderId } = await cobroVivo();
    await pagado(orderId);
    const [a, b] = await Promise.all([devolver(chargeId), devolver(chargeId)]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(mpFake.calls.filter((c) => c.path.endsWith('/refund'))).toHaveLength(1);
  });

  it('solo el gerente devuelve, siempre con motivo, y solo lo que la tarjeta ya pagó', async () => {
    const { chargeId, orderId } = await cobroVivo();
    expect((await devolver(chargeId)).status).toBe(409); // todavía no se paga
    await pagado(orderId);
    expect((await devolver(chargeId, waiter)).status).toBe(403);
    expect((await devolver(chargeId, manager, 'no')).status).toBe(400);
    expect((await devolver(chargeId)).status).toBe(200);
    const otraVez = await devolver(chargeId);
    expect(otraVez.status).toBe(409);
    expect(otraVez.body.error.message).toMatch(/ya está devuelto/);
  });

  it('si Mercado Pago se niega, lo dice en español y se puede reintentar después', async () => {
    const { tx, chargeId, orderId } = await cobroVivo();
    await pagado(orderId);
    mpFake.failNext = { status: 428, body: { errors: [{ code: 'insufficient_money_for_refund', message: 'no money' }] } };
    const res = await devolver(chargeId);
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/saldo suficiente/);
    expect((await estadoDe(tx.id)).status).toBe('paid');

    // Una fallida no bloquea la siguiente.
    expect((await devolver(chargeId)).status).toBe(200);
  });

  it('si la respuesta se pierde, queda pedida y el repaso la termina con LA MISMA llave', async () => {
    const { tx, chargeId, orderId } = await cobroVivo();
    await pagado(orderId);
    mpFake.failNext = 'abort';
    const res = await devolver(chargeId);
    expect(res.status).toBe(202);
    expect(res.body.outcome).toBe('pending');
    expect((await estadoDe(tx.id)).status).toBe('paid');

    const { rows } = await pool.query(
      "SELECT idempotency_key FROM terminal_refunds WHERE charge_id = $1", [chargeId]);
    await pool.query(
      "UPDATE terminal_refunds SET last_attempt_at = now() - interval '5 minutes' WHERE charge_id = $1", [chargeId]);
    await terminalCharges.sweep(pool);

    expect((await estadoDe(tx.id)).status).toBe('refunded');
    const reintentos = mpFake.calls.filter((c) => c.path.endsWith('/refund'));
    expect(reintentos).toHaveLength(2);
    expect(reintentos[1].idempotency).toBe(rows[0].idempotency_key);
  });

  it('la lista de cobros es del gerente, con sus devoluciones', async () => {
    const { chargeId, orderId } = await cobroVivo();
    await pagado(orderId);
    await devolver(chargeId);
    const lista = await api().get(`/api/nightclubs/${club.id}/terminal-charges`).set(await tokenDe(manager));
    expect(lista.status).toBe(200);
    const este = lista.body.charges.find((c) => c.id === chargeId);
    expect(este.status).toBe('refunded');
    expect(este.refunds).toHaveLength(1);
    expect((await api().get(`/api/nightclubs/${club.id}/terminal-charges`)
      .set(await tokenDe(waiter))).status).toBe(403);
  });

  it('el corte de la noche enseña lo devuelto con tarjeta, aparte', async () => {
    const stats = require('../src/services/night-stats');
    const { chargeId, orderId } = await cobroVivo();
    await pagado(orderId);
    await devolver(chargeId);
    const r = await stats.cardRefunds({
      nightclubId: club.id, from: new Date(Date.now() - 3600e3), to: new Date(Date.now() + 3600e3),
    });
    expect(r).toEqual({ total: 450, count: 1 });
  });
});
