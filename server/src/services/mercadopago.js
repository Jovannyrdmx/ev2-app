/**
 * EV2 — hablar con Mercado Pago (D47).
 *
 * Todo lo que sale de este servidor hacia `api.mercadopago.com` pasa por aquí, y nada
 * más de aquí sale. Un solo archivo para una sola razón: el día que Mercado Pago cambie
 * la forma de una respuesta, el arreglo está en un sitio y no repartido entre la ruta,
 * el webhook y el repaso de respaldo.
 *
 * ---------------------------------------------------------------------------
 * Tres cosas que no son adorno
 * ---------------------------------------------------------------------------
 *
 * 1. **`X-Idempotency-Key` en TODO lo que crea o cambia algo.** Si la red se cae entre
 *    nuestra petición y su respuesta, no sabemos si la orden se creó. Reintentar con la
 *    misma llave devuelve la orden que ya existe; reintentar sin ella despierta una
 *    segunda terminal y le cobra al cliente dos veces. No es una optimización: es la
 *    diferencia entre un tiempo de espera y un cargo duplicado.
 *
 * 2. **`live_mode` se comprueba contra lo que declara el `.env`.** Cada respuesta de
 *    Mercado Pago dice si la cuenta es real. Si el servidor dice "prueba" y la cuenta
 *    contesta "real" —o al revés—, se detiene ahí. Es el único momento en que un error
 *    de credenciales se puede atrapar sin que lo descubra un estado de cuenta.
 *
 * 3. **Tiempo de espera corto, y nunca esperamos al cliente.** Crear la orden tarda lo
 *    que tarda una petición HTTP; lo que tarda es que la persona saque la tarjeta, y eso
 *    llega por webhook. Un `fetch` abierto tres minutos es una conexión colgada por cada
 *    cobro de la noche.
 */
'use strict';

const crypto = require('crypto');
const { ApiError } = require('../middleware/errors');
const config = require('../config/payments');

const BASE_URL = process.env.MERCADOPAGO_BASE_URL || 'https://api.mercadopago.com';
// Suficiente para una petición honesta y corto para que una caída de su lado no
// arrastre la pantalla del mesero.
const TIMEOUT_MS = Number(process.env.MERCADOPAGO_TIMEOUT_MS || 12000);

const token = () => process.env.MERCADOPAGO_ACCESS_TOKEN || '';

/** El dispositivo virtual de pruebas de Mercado Pago. No existe físicamente. */
const SANDBOX_SERIAL = 'SBX0000001';
const isSandboxTerminal = (externalId) => String(externalId || '').includes(SANDBOX_SERIAL);

/**
 * Se puede cobrar, o no, y por qué no.
 *
 * Se comprueba antes de cada cobro y no solo al arrancar: las variables de entorno se
 * cambian en caliente más a menudo de lo que a nadie le gusta admitir.
 */
function assertUsable() {
  const mp = config.mercadoPagoConfig();
  if (!mp.configured) {
    throw new ApiError(501, 'mercadopago_not_configured',
      `Mercado Pago no está configurado en este servidor: falta ${mp.missing.join(', ')} en el .env`,
      { missing: mp.missing });
  }
  if (mp.mode === 'undeclared') {
    throw new ApiError(501, 'mercadopago_env_undeclared',
      'Falta MERCADOPAGO_ENV en el .env. Hoy el token de prueba y el de producción '
      + 'empiezan igual (APP_USR), así que el servidor no puede adivinar cuál le pusiste '
      + '— y adivinar mal es cobrarle a una tarjeta real creyendo que es una prueba.');
  }
  return mp;
}

/**
 * Lo que dijo la cuenta contra lo que dice el `.env`.
 *
 * Se llama con cada respuesta que traiga `live_mode`. Un desajuste detiene la operación
 * en vez de dejarla pasar: significa que alguien pegó las credenciales equivocadas, y
 * ese es justo el momento de parar.
 */
function assertModeMatches(body, declared) {
  if (!body || typeof body.live_mode !== 'boolean') return;
  const real = body.live_mode ? 'live' : 'test';
  if (real === declared) return;
  // 503 y no 500: no es un fallo del servidor, es una negativa a seguir. Un 500 se
  // contesta como "Internal server error" sin el motivo (y hace bien), y este es
  // justamente el motivo que hay que leer.
  throw new ApiError(503, 'mercadopago_env_mismatch',
    `El .env dice que las credenciales de Mercado Pago son de ${declared === 'test' ? 'PRUEBA' : 'PRODUCCIÓN'}, `
    + `pero la cuenta contesta que son de ${real === 'test' ? 'PRUEBA' : 'PRODUCCIÓN'}. `
    + 'No se cobra nada hasta que eso cuadre.',
    { declared, reported: real });
}

/**
 * Una petición. Devuelve `{ status, body }` y NO lanza por un código de error HTTP:
 * quien llama decide, porque un 404 al consultar una orden y un 404 al cancelarla no
 * significan lo mismo.
 */
async function request(method, path, {
  body, idempotencyKey, expectLiveMode = true, extraHeaders = {},
} = {}) {
  const mp = assertUsable();
  const headers = {
    ...extraHeaders,
    Authorization: `Bearer ${token()}`,
    Accept: 'application/json',
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (idempotencyKey) headers['X-Idempotency-Key'] = idempotencyKey;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res;
  let text;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    text = await res.text();
  } catch (err) {
    // Un tiempo de espera NO es "no se cobró". Es "no sabemos", y quien llama tiene que
    // tratarlo como tal: la orden puede existir del otro lado.
    throw new ApiError(504, 'mercadopago_unreachable',
      err.name === 'AbortError'
        ? 'Mercado Pago no contestó a tiempo. El cobro puede haber quedado creado: se consulta, no se repite.'
        : `No se pudo contactar a Mercado Pago: ${err.message}`,
      { cause: err.name });
  } finally {
    clearTimeout(timer);
  }

  let parsed = null;
  if (text) {
    try { parsed = JSON.parse(text); } catch { parsed = { raw: text.slice(0, 500) }; }
  }
  if (expectLiveMode && res.ok) assertModeMatches(parsed, mp.mode);
  return { status: res.status, body: parsed };
}

/** El mensaje que de verdad sirve de un error de Mercado Pago, sin inventar. */
function describeError(status, body) {
  if (!body) return `Mercado Pago contestó ${status} sin explicación`;
  if (Array.isArray(body.errors) && body.errors.length) {
    return body.errors.map((e) => e.message || e.code).filter(Boolean).join('; ');
  }
  return body.message || body.error || `Mercado Pago contestó ${status}`;
}

// ---------------------------------------------------------------- terminales

/**
 * Las terminales de la cuenta.
 *
 * Es lo primero que se llama al configurar el club, y también el diagnóstico cuando un
 * cobro "no hace nada": aquí se ve el `operating_mode`, y una terminal en STANDALONE
 * ignora las órdenes de la API en silencio.
 */
async function listTerminals({ limit = 50, offset = 0 } = {}) {
  const { status, body } = await request('GET',
    `/terminals/v1/list?limit=${limit}&offset=${offset}`);
  if (status !== 200) {
    throw new ApiError(502, 'mercadopago_error', describeError(status, body), { status });
  }
  // La forma exacta de la respuesta está documentada como `data.terminals`, pero se lee
  // con tolerancia: si Mercado Pago la mueve, el club se queda sin listar terminales, no
  // sin cobrar.
  const data = body && (body.data || body);
  const list = (data && (data.terminals || data.results)) || [];
  return list.map((t) => ({
    external_id: t.id,
    operating_mode: t.operating_mode || null,
    store_id: t.store_id || null,
    pos_id: t.pos_id || null,
  }));
}

/** Pasar una terminal a modo PDV, que es el único en el que obedece a la API. */
async function setOperatingMode(externalId, mode = 'PDV') {
  const { status, body } = await request('PATCH', '/terminals/v1/setup', {
    idempotencyKey: crypto.randomUUID(),
    body: { terminals: [{ id: externalId, operating_mode: mode }] },
  });
  if (status !== 200) {
    throw new ApiError(502, 'mercadopago_error', describeError(status, body), { status });
  }
  return { external_id: externalId, operating_mode: mode, raw: body };
}

// ---------------------------------------------------------------- cobrar

/**
 * La vigencia de la orden en ISO 8601, como la documenta Mercado Pago: mínimo `PT30S`,
 * máximo `PT3H`. Se normaliza a horas/minutos/segundos (`PT3M`, `PT1M30S`) porque así
 * vienen todos sus ejemplos: `PT180S` es ISO válido, pero no hay por qué apostar a que
 * su validador lo acepte en plena barra.
 */
function isoDuration(seconds) {
  const total = Math.max(30, Math.min(10800, Math.round(Number(seconds) || 0)));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  return `PT${h ? `${h}H` : ''}${m ? `${m}M` : ''}${sec ? `${sec}S` : ''}`;
}

/**
 * Despertar la terminal con un monto.
 *
 * `amount` viaja como texto con DOS decimales exactos, que es lo que la API exige. Se
 * formatea aquí y no en quien llama: un `24` en vez de `"24.00"` es un 400 en medio de
 * un cobro, de pie en la barra.
 */
async function createPointOrder({
  terminalExternalId, amount, currency = 'MXN', externalReference,
  description, idempotencyKey, expirationSeconds = 180, printTicket = false,
}) {
  const body = {
    type: 'point',
    external_reference: externalReference,
    // Corto a propósito: una orden viva es una terminal ocupada. Si el cliente no paga
    // en tres minutos, vence sola y el mesero puede volver a cobrar sin llamar a nadie.
    expiration_time: isoDuration(expirationSeconds),
    transactions: {
      payments: [{ amount: Number(amount).toFixed(2) }],
    },
    config: {
      point: {
        terminal_id: terminalExternalId,
        print_on_terminal: printTicket ? 'seller_ticket' : 'no_ticket',
      },
    },
  };
  if (description) body.description = String(description).slice(0, 255);

  const { status, body: res } = await request('POST', '/v1/orders', { body, idempotencyKey });
  if (status !== 200 && status !== 201) {
    throw new ApiError(502, 'mercadopago_error', describeError(status, res), { status, body: res });
  }
  return res;
}

/** Cómo va esa orden. Es la ÚNICA fuente que este sistema cree. */
async function getOrder(orderId) {
  const { status, body } = await request('GET', `/v1/orders/${encodeURIComponent(orderId)}`);
  if (status === 404) return null;
  if (status !== 200) {
    throw new ApiError(502, 'mercadopago_error', describeError(status, body), { status });
  }
  return body;
}

/**
 * Cancelar una orden que todavía no se cobró.
 *
 * `x-allow-cancelable-status: at_terminal` NO es opcional en la práctica. Sin esa
 * cabecera Mercado Pago solo cancela órdenes en `created`, y una orden pasa a
 * `at_terminal` en cuanto la terminal la enseña — que es justo el momento en el que el
 * cliente dice "mejor en efectivo". Sin ella, cancelar fallaba exactamente cuando más
 * hacía falta, y el mesero se quedaba con la terminal pidiendo una tarjeta.
 */
async function cancelOrder(orderId, idempotencyKey = crypto.randomUUID()) {
  const { status, body } = await request(
    'POST', `/v1/orders/${encodeURIComponent(orderId)}/cancel`, {
      idempotencyKey, extraHeaders: { 'x-allow-cancelable-status': 'at_terminal' },
    });
  if (status === 200 || status === 201) return body;
  throw new ApiError(status === 404 ? 404 : 502, 'mercadopago_error',
    describeError(status, body), { status, body });
}

/**
 * Los códigos de error de un reembolso que documenta Mercado Pago, dichos para quien
 * está frente a la pantalla. El código original se conserva en `details`.
 */
const REFUND_ERRORS = {
  refund_period_exceeded: 'Ya pasaron más de 90 días desde el cobro: Mercado Pago ya no permite devolverlo.',
  insufficient_money_for_refund: 'La cuenta de Mercado Pago no tiene saldo suficiente para devolver este cobro.',
  order_already_refunded: 'Mercado Pago dice que este cobro ya estaba devuelto.',
  cannot_refund_order: 'Mercado Pago no permite devolver este cobro.',
  payment_not_refundable: 'Mercado Pago no permite devolver este pago.',
  max_refunds_exceeded: 'Este cobro ya tiene el máximo de devoluciones que permite Mercado Pago.',
  partial_refund_forbidden_with_tips: 'Un cobro con propina solo se puede devolver completo.',
  refund_amount_exceeds: 'Lo que se quiere devolver es más de lo que se cobró.',
};

function refundErrorCode(body) {
  if (!body) return null;
  if (Array.isArray(body.errors) && body.errors.length) return body.errors[0].code || null;
  return body.code || body.error || null;
}

/**
 * Devolver una orden cobrada, completa.
 *
 * Solo el reembolso total, a propósito (ver D49): el parcial existe en la API, pero un
 * cobro que queda "pagado" por una parte deja el corte de la noche descuadrado en
 * lugares que hoy no saben restar, y en una disco el caso real es el cobro equivocado
 * o el doble, que se devuelve completo.
 *
 * La llave de idempotencia la pone quien llama y se guarda antes: Mercado Pago la
 * respeta 24 horas, y es lo único que permite reintentar un reembolso cuya respuesta se
 * perdió sin devolver el dinero dos veces.
 */
async function refundOrder(orderId, { idempotencyKey }) {
  const { status, body } = await request(
    'POST', `/v1/orders/${encodeURIComponent(orderId)}/refund`, { idempotencyKey });
  if (status === 200 || status === 201) return body;
  const code = refundErrorCode(body);
  const message = (code && REFUND_ERRORS[code]) || describeError(status, body);
  const http = status === 404 ? 404 : status === 409 || status === 428 ? 409 : 502;
  throw new ApiError(http, code === 'order_already_refunded' ? 'already_refunded' : 'mercadopago_refund_error',
    message, { status, code });
}

/**
 * Simular un resultado en el dispositivo virtual. SOLO en modo prueba.
 *
 * La comprobación de abajo no sobra: esta llamada contra una cuenta real no simula nada
 * —no existe— pero dejarla disponible en producción es dejar en el código un botón
 * llamado "dar por pagado" que apunta a la pasarela.
 */
async function simulateOrderEvent(orderId, event) {
  const mp = assertUsable();
  if (mp.mode !== 'test') {
    throw new ApiError(403, 'simulation_not_allowed',
      'Los cobros solo se simulan con credenciales de prueba.');
  }
  const { status, body } = await request(
    'POST', `/v1/orders/${encodeURIComponent(orderId)}/events`,
    { body: event, idempotencyKey: crypto.randomUUID(), expectLiveMode: false });
  if (status === 200 || status === 201 || status === 204) return true;
  throw new ApiError(502, 'mercadopago_error', describeError(status, body), { status });
}

// ---------------------------------------------------------------- el webhook

/**
 * ¿La notificación viene de Mercado Pago?
 *
 * Devuelve 'valid', 'invalid' o 'unverifiable' (no hay secreto configurado). Lo que NO
 * hace es decidir si se cobra: eso lo decide `getOrder`, con nuestro propio token. La
 * firma es una señal, no la verdad, y aquí hay una razón concreta para no depender de
 * ella — la validación de la firma de la Orders API tiene hoy un desacuerdo abierto en
 * los propios SDK de Mercado Pago sobre si el id va en minúsculas al armar el texto
 * firmado. Por eso se prueban las dos formas, y por eso un 'invalid' se ANOTA en vez de
 * tirar la notificación: una firma que no cuadra por un defecto ajeno no puede dejar al
 * club sin registrar un cobro que de verdad ocurrió.
 */
function verifySignature({ signatureHeader, requestId, dataId, secret }) {
  if (!secret) return 'unverifiable';
  if (!signatureHeader) return 'invalid';

  const parts = String(signatureHeader).split(',').reduce((acc, piece) => {
    const [k, v] = piece.split('=');
    if (k && v) acc[k.trim()] = v.trim();
    return acc;
  }, {});
  if (!parts.ts || !parts.v1) return 'invalid';

  const candidates = [String(dataId), String(dataId).toLowerCase()];
  for (const id of candidates) {
    const manifest = `id:${id};request-id:${requestId || ''};ts:${parts.ts};`;
    const hmac = crypto.createHmac('sha256', secret).update(manifest).digest('hex');
    // Comparación de tiempo constante: comparar hashes con === filtra información por el
    // tiempo que tarda en fallar.
    const a = Buffer.from(hmac, 'utf8');
    const b = Buffer.from(parts.v1, 'utf8');
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return 'valid';
  }
  return 'invalid';
}

// ---------------------------------------------------------------- leer una orden

/** Los estados de Mercado Pago que significan que la cosa ya terminó. */
const FINAL_STATUSES = ['processed', 'failed', 'canceled', 'expired', 'refunded'];

/**
 * Los estados de Mercado Pago que para este sistema son "sigue esperando".
 *
 * `created` (recién creada) y `at_terminal` (la terminal ya la muestra) son los dos
 * primeros pasos de TODA orden según la guía de Point. Esta tabla no los aceptaba
 * (migración 026), y cada vez que la consulta o el repaso los leían, el UPDATE chocaba
 * con el CHECK, la excepción se tragaba en silencio y el cobro seguía "esperando" sin
 * que nadie supiera que la terminal ya lo tenía en pantalla.
 */
const PENDING_STATUSES = ['created', 'at_terminal'];

const money2 = (v) => (v === null || v === undefined || v === '' ? null : Number(v).toFixed(2));

/**
 * La orden de Mercado Pago traducida a lo que esta base guarda.
 *
 * Se lee con tolerancia a propósito: si un campo opcional cambia de sitio, el cobro se
 * registra igual con lo que sí se entendió, en vez de fallar entero por un detalle del
 * recibo.
 */
function readOrder(order) {
  if (!order) return null;
  const tx = order.transactions || {};
  const payment = ((tx.payments || [])[0]) || {};
  const refunds = (tx.refunds || []).map((r) => ({
    id: r.id || null,
    transaction_id: r.transaction_id || null,
    amount: money2(r.amount),
    status: r.status || null,
  }));
  // Lo devuelto: lo que diga el pago, o la suma de sus reembolsos si no lo dice.
  const devueltoPorLista = refunds.reduce((acc, r) => acc + (Number(r.amount) || 0), 0);
  const refunded = payment.refunded_amount != null
    ? Number(payment.refunded_amount) : devueltoPorLista;

  const mpStatus = order.status || null;
  const status = PENDING_STATUSES.includes(mpStatus) ? 'waiting' : mpStatus;
  return {
    external_order_id: order.id || null,
    // En el vocabulario de esta base. `mp_status` es lo que dijo Mercado Pago tal cual.
    status,
    mp_status: mpStatus,
    at_terminal: mpStatus === 'at_terminal',
    status_detail: order.status_detail || payment.status_detail
      || (PENDING_STATUSES.includes(mpStatus) ? mpStatus : null),
    amount: money2(order.total_amount || payment.amount),
    paid_amount: money2(payment.paid_amount != null ? payment.paid_amount : order.total_paid_amount),
    tip_amount: money2(payment.tip_amount),
    refunded_amount: money2(refunded) || '0.00',
    refunds,
    payment_transaction_id: payment.id || null,
    payment_method_type: (payment.payment_method || {}).type || null,
    payment_method_id: (payment.payment_method || {}).id || null,
    installments: (payment.payment_method || {}).installments || null,
    live_mode: typeof order.live_mode === 'boolean' ? order.live_mode : null,
    is_final: FINAL_STATUSES.includes(mpStatus),
  };
}

module.exports = {
  BASE_URL,
  SANDBOX_SERIAL,
  FINAL_STATUSES,
  isSandboxTerminal,
  assertUsable,
  assertModeMatches,
  describeError,
  listTerminals,
  setOperatingMode,
  createPointOrder,
  getOrder,
  cancelOrder,
  refundOrder,
  isoDuration,
  PENDING_STATUSES,
  REFUND_ERRORS,
  simulateOrderEvent,
  verifySignature,
  readOrder,
  request,
};
