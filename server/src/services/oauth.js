/**
 * Entrar con una cuenta de otro: el viaje, y las decisiones que lo hacen seguro.
 *
 * Casi todo lo de aquí es puro —armar la dirección de ida, normalizar el perfil
 * que devuelve el proveedor, decidir si una cuenta se puede desvincular— y se
 * prueba sin red. Las dos funciones que sí hablan con Meta reciben su `fetch`
 * por parámetro, así que también se prueban sin salir a internet.
 *
 * ---------------------------------------------------------------------------
 * Las tres decisiones que importan
 * ---------------------------------------------------------------------------
 *
 * 1. **No se liga automáticamente por correo.** Si alguien entra con un Facebook
 *    cuyo correo coincide con una cuenta que ya existe, NO se le da esa cuenta:
 *    se le dice que entre con su contraseña y ligue Facebook desde su perfil.
 *    Parece un paso de más y es la diferencia entre una molestia y un robo de
 *    cuenta — quien logre que un proveedor le acepte un correo ajeno se
 *    quedaría con la cuenta del cliente, con sus reservaciones y su historial.
 *    Auth0 y Okta lo traen apagado por omisión por lo mismo.
 *
 * 2. **Una cuenta nueva no se crea sola.** El club es 18+, y `users.birth_date`
 *    es obligatorio porque de eso depende dejar entrar a alguien. Facebook no
 *    entrega fecha de nacimiento fiable, así que INVENTARLA sería inventar la
 *    edad de un cliente en un negocio de alcohol. En su lugar, el primer viaje
 *    devuelve un *token de completar* de 15 minutos y la app pide la fecha y la
 *    aceptación de términos, como en el registro normal.
 *
 * 3. **El token del proveedor se usa una vez y se tira.** Se canjea el código,
 *    se lee el perfil, y se descarta. No se guarda en ninguna tabla: el sistema
 *    no necesita volver a entrar al Facebook del cliente nunca, y guardarlo
 *    convertiría una fuga de esta base en un problema dentro de la cuenta
 *    personal de cada cliente.
 */
'use strict';

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { ApiError } = require('../middleware/errors');

/** Cuánto vive el `state` del viaje de ida. Lo que tarda una persona en decidir. */
const STATE_TTL_MINUTES = 15;

/** Cuánto vive el token de completar el registro. */
const COMPLETION_TTL_MINUTES = 15;

/**
 * El emisor del token de completar, DISTINTO del de la sesión.
 *
 * `middleware/auth.js` verifica `issuer: 'ev2'`, así que un token de completar
 * presentado como `Bearer` se rechaza por el emisor, no por casualidad. Firmar
 * las dos cosas con el mismo secreto sin separarlas sería darle una sesión a
 * quien todavía no tiene cuenta.
 */
const COMPLETION_ISSUER = 'ev2-oauth';

function jwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 16) {
    throw new Error('JWT_SECRET is missing or too short (min 16 characters)');
  }
  return secret;
}

/** Un `state` nuevo: 32 bytes al azar. No se deriva de nada. */
function newState() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * A dónde se manda a la persona para que autorice.
 *
 * `redirect_uri` tiene que coincidir carácter por carácter con la que esté dada
 * de alta en el panel de Meta, así que se arma en un solo lugar (`config/oauth`)
 * y de ahí sale para el viaje de ida Y para el canje del código: si las dos no
 * son idénticas, Meta rechaza el canje.
 */
function authorizeUrl(config, state) {
  const params = new URLSearchParams({
    client_id: config.app_id,
    redirect_uri: config.redirect_uri,
    state,
    response_type: 'code',
    scope: config.scope,
  });
  return `${config.authorize_url}?${params.toString()}`;
}

/**
 * El perfil, en los campos que este sistema entiende.
 *
 * Todo puede faltar menos el id: el correo lo puede negar el cliente en la
 * pantalla de permisos, y el apellido no existe en muchas cuentas. Lo que NO
 * puede faltar es el id — sin él no hay a quién ligar — y por eso es el único
 * que revienta.
 */
function normalizeProfile(provider, raw) {
  const r = raw || {};
  const id = String(r.id || r.sub || '').trim();
  if (!id) throw ApiError.unprocessable(`${provider} no devolvió un identificador de cuenta`);

  const nombre = String(r.name || '').trim();
  const partes = nombre.split(/\s+/).filter(Boolean);
  const first = String(r.first_name || partes[0] || '').trim();
  const last = String(r.last_name || partes.slice(1).join(' ') || '').trim();

  return {
    provider,
    provider_user_id: id,
    email: r.email ? String(r.email).trim().toLowerCase() : null,
    first_name: first.slice(0, 80) || null,
    last_name: last.slice(0, 80) || null,
    display_name: (nombre || [first, last].filter(Boolean).join(' ')).slice(0, 150) || null,
  };
}

/**
 * Canjear el código por un token de acceso del proveedor.
 *
 * Con un tiempo límite: si Meta se queda callado, la persona está mirando una
 * pantalla en blanco, y es mejor decirle que vuelva a intentar que dejarla ahí.
 */
async function exchangeCode(config, code, { fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
  const params = new URLSearchParams({
    client_id: config.app_id,
    client_secret: config.app_secret,
    redirect_uri: config.redirect_uri,
    code,
  });
  const res = await withTimeout(
    fetchImpl(`${config.token_url}?${params.toString()}`, { headers: { Accept: 'application/json' } }),
    timeoutMs, config.provider);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    // El mensaje del proveedor NO se le pasa al cliente: puede traer el id de la
    // app y detalles de la configuración. Se registra del lado del servidor.
    throw ApiError.unprocessable(`No se pudo verificar la cuenta de ${config.label}`,
      { provider: config.provider });
  }
  return data.access_token;
}

/** Leer el perfil con ese token. Es lo único que se le pide al proveedor. */
async function fetchProfile(config, accessToken, { fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
  const params = new URLSearchParams({ fields: config.profile_fields, access_token: accessToken });
  const res = await withTimeout(
    fetchImpl(`${config.profile_url}?${params.toString()}`, { headers: { Accept: 'application/json' } }),
    timeoutMs, config.provider);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw ApiError.unprocessable(`No se pudo leer el perfil de ${config.label}`,
      { provider: config.provider });
  }
  return normalizeProfile(config.provider, data);
}

function withTimeout(promise, ms, provider) {
  let t;
  const limite = new Promise((_, reject) => {
    t = setTimeout(() => reject(ApiError.unprocessable(
      `${provider} no respondió a tiempo, inténtalo otra vez`)), ms);
  });
  return Promise.race([promise, limite]).finally(() => clearTimeout(t));
}

// -------------------------------------------------------------- completar el registro

/**
 * El token de completar: lleva el perfil del proveedor, firmado, 15 minutos.
 *
 * Va firmado y no guardado en una tabla porque no necesita ser de un solo uso:
 * completar el registro dos veces con el mismo token choca contra el índice
 * único de `user_identities`, así que el segundo intento falla por sí solo.
 */
function signCompletionToken(profile) {
  return jwt.sign(
    {
      provider: profile.provider,
      pid: profile.provider_user_id,
      email: profile.email || null,
      fn: profile.first_name || null,
      ln: profile.last_name || null,
      dn: profile.display_name || null,
      nc: profile.nightclub_id,
    },
    jwtSecret(),
    { expiresIn: `${COMPLETION_TTL_MINUTES}m`, issuer: COMPLETION_ISSUER },
  );
}

function verifyCompletionToken(token) {
  let payload;
  try {
    payload = jwt.verify(token, jwtSecret(), { issuer: COMPLETION_ISSUER });
  } catch (err) {
    throw ApiError.unauthorized(err.name === 'TokenExpiredError'
      ? 'El registro tardó demasiado: vuelve a entrar con tu cuenta'
      : 'Ese registro no es válido');
  }
  return {
    provider: payload.provider,
    provider_user_id: payload.pid,
    email: payload.email || null,
    first_name: payload.fn || null,
    last_name: payload.ln || null,
    display_name: payload.dn || null,
    nightclub_id: payload.nc,
  };
}

// -------------------------------------------------------------- desvincular

/**
 * ¿Se puede quitar esta cuenta social?
 *
 * No, si es la única manera de entrar. Dejar a alguien sin contraseña y sin
 * cuenta ligada es dejarlo fuera de su propia cuenta, con sus reservaciones
 * adentro, y la única salida sería que el gerente le reinicie la contraseña a
 * mano en la base — que es exactamente lo que acabamos de tener que hacer una vez
 * y no queremos volver a hacer.
 */
function canUnlink({ hasPassword, identityCount }) {
  if (hasPassword) return { ok: true };
  if (Number(identityCount) > 1) return { ok: true };
  return { ok: false, reason: 'last_way_in' };
}

/**
 * A dónde se manda a la persona al terminar.
 *
 * Lista blanca de páginas del propio sistema. Un destino libre convertiría esta
 * ruta en un salto abierto: un enlace con la cara del club que lleva a otro
 * sitio, que es como se roba una contraseña.
 */
const SAFE_REDIRECTS = ['index.html', 'staff.html', 'manager.html', 'bartender.html',
  'almacen.html', 'valet.html', 'driver.html', 'employee-portal.html'];

function safeRedirect(destino) {
  const limpio = String(destino || '').replace(/^\/+/, '').split(/[?#]/)[0];
  return SAFE_REDIRECTS.includes(limpio) ? limpio : 'index.html';
}

module.exports = {
  STATE_TTL_MINUTES,
  COMPLETION_TTL_MINUTES,
  COMPLETION_ISSUER,
  SAFE_REDIRECTS,
  newState,
  authorizeUrl,
  normalizeProfile,
  exchangeCode,
  fetchProfile,
  signCompletionToken,
  verifyCompletionToken,
  canUnlink,
  safeRedirect,
};
