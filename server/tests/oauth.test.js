// Entrar con una cuenta de otro: las pruebas.
//
// Lo que se prueba aquí no es "que Facebook funcione" -- eso lo prueba Facebook.
// Se prueban las decisiones que, si se rompen, regalan una cuenta:
//
//   1. El `state` es de UN SOLO USO y no se acepta uno ajeno.
//   2. NO se liga sola una cuenta social a una cuenta que ya existe por el correo.
//   3. El token de completar NO sirve como sesión (emisor distinto).
//   4. Un menor no puede terminar un registro que empezó con Facebook.
//   5. El pase de mano es de un solo uso.
//   6. No se puede quitar la única manera de entrar que tiene una persona.
//   7. Instagram contesta el motivo, no un botón roto.
//   8. La lista pública de proveedores no lleva el secreto de la app.
//
// Nada de esto sale a internet: las dos funciones que hablan con Meta reciben su
// `fetch`, y en las rutas se sustituye el global.
'use strict';

const jwt = require('jsonwebtoken');
const { setupSchema, truncateAll, closePool, pool } = require('./helpers/db');
const { api, auth } = require('./helpers/api');
const f = require('./helpers/factories');
const oauthConfig = require('../src/config/oauth');
const oauth = require('../src/services/oauth');

const APP_ID = '1234567890';
const APP_SECRET = 'app-secret-de-prueba';

let club;
let fetchReal;

beforeAll(async () => {
  await setupSchema();
  fetchReal = global.fetch;
});
beforeEach(async () => {
  await truncateAll();
  club = await f.createNightclub({ slug: 'ev2-oauth' });
  process.env.FACEBOOK_APP_ID = APP_ID;
  process.env.FACEBOOK_APP_SECRET = APP_SECRET;
});
afterEach(() => {
  global.fetch = fetchReal;
});
afterAll(async () => {
  delete process.env.FACEBOOK_APP_ID;
  delete process.env.FACEBOOK_APP_SECRET;
  await closePool();
});

/** Suplanta a Meta: primero el canje del código, luego el perfil. */
function metaResponde(perfil, { tokenOk = true, profileOk = true } = {}) {
  global.fetch = jest.fn(async (url) => {
    if (String(url).includes('/oauth/access_token')) {
      return {
        ok: tokenOk,
        json: async () => (tokenOk
          ? { access_token: 'token-de-un-solo-uso' }
          : { error: { message: 'App 1234567890 secret is wrong', code: 101 } }),
      };
    }
    return { ok: profileOk, json: async () => (profileOk ? perfil : { error: { message: 'bad token' } }) };
  });
}

/** El fragmento de la dirección a la que redirige el callback, ya partido. */
function fragmento(res) {
  const url = String(res.headers.location || '');
  const i = url.indexOf('#');
  if (i === -1) return {};
  const out = {};
  for (const par of url.slice(i + 1).split('&')) {
    const [k, v] = par.split('=');
    out[k] = decodeURIComponent(v || '');
  }
  return out;
}

/** Arranca un viaje de verdad y devuelve el `state` que quedó guardado. */
async function nuevoViaje({ slug = 'ev2-oauth', redirectTo } = {}) {
  const res = await api().get('/api/auth/oauth/facebook/start')
    .query({ nightclub_slug: slug, ...(redirectTo ? { redirect_to: redirectTo } : {}) });
  expect(res.status).toBe(302);
  const state = new URL(res.headers.location).searchParams.get('state');
  return state;
}

// ===========================================================================
// La configuración: qué se enseña y qué no
// ===========================================================================

describe('config/oauth', () => {
  it('la lista pública NUNCA lleva el secreto de la app', async () => {
    const res = await api().get('/api/auth/oauth/providers');
    expect(res.status).toBe(200);
    const texto = JSON.stringify(res.body);
    expect(texto).not.toContain(APP_SECRET);
    // Ni el app_id: el viaje lo arma el servidor, el navegador no lo necesita.
    expect(texto).not.toContain(APP_ID);
  });

  it('con credenciales, Facebook se reporta encendido', async () => {
    const res = await api().get('/api/auth/oauth/providers');
    const fb = res.body.providers.find((p) => p.provider === 'facebook');
    expect(fb).toMatchObject({ enabled: true, available: true });
    expect(res.body.any_enabled).toBe(true);
  });

  it('sin credenciales, Facebook se reporta apagado y dice qué variable falta', async () => {
    delete process.env.FACEBOOK_APP_ID;
    delete process.env.FACEBOOK_APP_SECRET;

    const res = await api().get('/api/auth/oauth/providers');
    const fb = res.body.providers.find((p) => p.provider === 'facebook');
    expect(fb.enabled).toBe(false);
    // El nombre de la variable sale en la vista del gerente, no en la pública.
    expect(oauthConfig.status().providers[0].missing)
      .toEqual(['FACEBOOK_APP_ID', 'FACEBOOK_APP_SECRET']);
  });

  it('el correo y la contraseña siguen disponibles con o sin proveedores', async () => {
    delete process.env.FACEBOOK_APP_ID;
    const res = await api().get('/api/auth/oauth/providers');
    expect(res.body.password_available).toBe(true);
  });

  it('Instagram viene declarado, apagado y con el motivo escrito', async () => {
    const res = await api().get('/api/auth/oauth/providers');
    const ig = res.body.providers.find((p) => p.provider === 'instagram');
    expect(ig).toMatchObject({
      enabled: false,
      available: false,
      unavailable_reason: 'instagram_consumer_login_discontinued',
    });
    expect(ig.unavailable_note).toMatch(/Business|Creator/);
  });

  it('la dirección de retorno se arma con el dominio del servidor, no con el Host de quien pide', async () => {
    const fb = oauthConfig.facebookConfig();
    expect(fb.redirect_uri).toBe('http://localhost:8080/api/auth/oauth/facebook/callback');

    const res = await api().get('/api/auth/oauth/facebook/start')
      .set('Host', 'sitio-de-otro.com')
      .query({ nightclub_slug: 'ev2-oauth' });
    expect(res.headers.location).toContain(encodeURIComponent('http://localhost:8080'));
    expect(res.headers.location).not.toContain('sitio-de-otro.com');
  });
});

// ===========================================================================
// El servicio: las piezas puras
// ===========================================================================

describe('services/oauth', () => {
  it('cada state es distinto y no se deriva de nada', () => {
    const a = oauth.newState();
    const b = oauth.newState();
    expect(a).toHaveLength(64);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
  });

  it('la dirección de ida pide lo mínimo y lleva el state', () => {
    const url = new URL(oauth.authorizeUrl(oauthConfig.facebookConfig(), 'abc123'));
    expect(url.origin + url.pathname).toBe('https://www.facebook.com/v21.0/dialog/oauth');
    expect(url.searchParams.get('state')).toBe('abc123');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('scope')).toBe('public_profile,email');
    // Nada de amigos, fotos ni publicaciones.
    expect(url.searchParams.get('scope')).not.toMatch(/friends|photos|posts/);
  });

  it('normaliza el perfil: parte el nombre y baja el correo a minúsculas', () => {
    const p = oauth.normalizeProfile('facebook', { id: '99', name: 'Ana María Pérez', email: 'Ana@Correo.MX' });
    expect(p).toMatchObject({
      provider_user_id: '99',
      first_name: 'Ana',
      last_name: 'María Pérez',
      email: 'ana@correo.mx',
    });
  });

  it('acepta un perfil sin correo y sin apellido: el cliente puede negar el permiso', () => {
    const p = oauth.normalizeProfile('facebook', { id: '99', first_name: 'Ana' });
    expect(p.email).toBeNull();
    expect(p.last_name).toBeNull();
  });

  it('sin identificador de cuenta revienta: no hay a quién ligar', () => {
    expect(() => oauth.normalizeProfile('facebook', { name: 'Sin Id' })).toThrow(/identificador/);
  });

  it('el error del proveedor NO se le pasa al cliente', async () => {
    const config = oauthConfig.facebookConfig();
    const fetchImpl = async () => ({
      ok: false,
      json: async () => ({ error: { message: `App ${APP_ID} secret is wrong` } }),
    });
    await expect(oauth.exchangeCode(config, 'code', { fetchImpl }))
      .rejects.toThrow(/No se pudo verificar la cuenta de Facebook/);
    // Ni el id de la app ni el texto de Meta salen en el mensaje.
    await expect(oauth.exchangeCode(config, 'code', { fetchImpl }))
      .rejects.not.toThrow(new RegExp(APP_ID));
  });

  it('una respuesta 200 sin access_token también falla', async () => {
    const fetchImpl = async () => ({ ok: true, json: async () => ({ nada: true }) });
    await expect(oauth.exchangeCode(oauthConfig.facebookConfig(), 'code', { fetchImpl }))
      .rejects.toThrow(/No se pudo verificar/);
  });

  it('si el proveedor se queda callado, se corta y se le dice a la persona', async () => {
    const fetchImpl = () => new Promise(() => {}); // nunca resuelve
    await expect(oauth.exchangeCode(oauthConfig.facebookConfig(), 'code',
      { fetchImpl, timeoutMs: 20 })).rejects.toThrow(/no respondió a tiempo/);
  });

  it('el destino se valida contra una lista blanca: no hay salto abierto', () => {
    expect(oauth.safeRedirect('staff.html')).toBe('staff.html');
    expect(oauth.safeRedirect('/manager.html')).toBe('manager.html');
    // Todo lo demás cae a la pantalla de acceso.
    expect(oauth.safeRedirect('https://sitio-de-otro.com/roba')).toBe('index.html');
    expect(oauth.safeRedirect('../../etc/passwd')).toBe('index.html');
    expect(oauth.safeRedirect('//sitio-de-otro.com')).toBe('index.html');
    expect(oauth.safeRedirect(undefined)).toBe('index.html');
  });

  it('no se desvincula la única manera de entrar', () => {
    expect(oauth.canUnlink({ hasPassword: false, identityCount: 1 }))
      .toEqual({ ok: false, reason: 'last_way_in' });
    expect(oauth.canUnlink({ hasPassword: true, identityCount: 1 }).ok).toBe(true);
    expect(oauth.canUnlink({ hasPassword: false, identityCount: 2 }).ok).toBe(true);
  });
});

// ===========================================================================
// Empezar el viaje
// ===========================================================================

describe('GET /api/auth/oauth/:provider/start', () => {
  it('manda a la pantalla de permisos y deja el state guardado', async () => {
    const res = await api().get('/api/auth/oauth/facebook/start')
      .query({ nightclub_slug: 'ev2-oauth' });

    expect(res.status).toBe(302);
    const state = new URL(res.headers.location).searchParams.get('state');
    const { rows } = await pool.query('SELECT * FROM oauth_states WHERE state = $1', [state]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      nightclub_id: club.id, provider: 'facebook', link_user_id: null, redirect_to: 'index.html',
    });
  });

  it('un destino fuera de la lista blanca se guarda ya saneado', async () => {
    const state = await nuevoViaje({ redirectTo: 'https://sitio-de-otro.com' });
    const { rows } = await pool.query('SELECT redirect_to FROM oauth_states WHERE state = $1', [state]);
    expect(rows[0].redirect_to).toBe('index.html');
  });

  it('Instagram contesta 501 con el motivo, no un 404 ni una pantalla rota', async () => {
    const res = await api().get('/api/auth/oauth/instagram/start')
      .query({ nightclub_slug: 'ev2-oauth' });

    expect(res.status).toBe(501);
    expect(res.body.error.code).toBe('provider_unavailable');
    expect(res.body.error.details.reason).toBe('instagram_consumer_login_discontinued');
  });

  it('sin credenciales contesta 501 diciendo qué variable falta', async () => {
    delete process.env.FACEBOOK_APP_SECRET;
    const res = await api().get('/api/auth/oauth/facebook/start')
      .query({ nightclub_slug: 'ev2-oauth' });

    expect(res.status).toBe(501);
    expect(res.body.error.code).toBe('provider_not_configured');
    expect(res.body.error.details.missing).toEqual(['FACEBOOK_APP_SECRET']);
  });

  it('un proveedor que no existe es 404', async () => {
    const res = await api().get('/api/auth/oauth/tiktok/start')
      .query({ nightclub_slug: 'ev2-oauth' });
    expect(res.status).toBe(404);
  });

  it('un club que no existe es 404 y no deja basura en la tabla', async () => {
    const res = await api().get('/api/auth/oauth/facebook/start')
      .query({ nightclub_slug: 'club-que-no-existe' });
    expect(res.status).toBe(404);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM oauth_states');
    expect(rows[0].n).toBe(0);
  });
});

// ===========================================================================
// La vuelta: el state
// ===========================================================================

describe('GET /api/auth/oauth/facebook/callback — el state', () => {
  it('un state inventado no abre nada', async () => {
    metaResponde({ id: '1', name: 'Quien Sea' });
    const res = await api().get('/api/auth/oauth/facebook/callback')
      .query({ code: 'codigo', state: 'a'.repeat(64) });

    expect(res.status).toBe(302);
    expect(fragmento(res).oauth_error).toBe('expired_state');
    // Y no se llegó a hablar con Meta: se corta antes de canjear.
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('el state es de UN SOLO USO: la segunda vuelta con el mismo no entra', async () => {
    const state = await nuevoViaje();
    metaResponde({ id: '77', name: 'Ana Pérez', email: 'ana@correo.mx' });

    const primera = await api().get('/api/auth/oauth/facebook/callback')
      .query({ code: 'codigo', state });
    expect(fragmento(primera).oauth_signup).toBeTruthy();

    const segunda = await api().get('/api/auth/oauth/facebook/callback')
      .query({ code: 'codigo', state });
    expect(fragmento(segunda).oauth_error).toBe('expired_state');
  });

  it('un state de otro proveedor no vale para este', async () => {
    const state = await nuevoViaje();
    await pool.query('UPDATE oauth_states SET provider = $1 WHERE state = $2', ['google', state]);
    metaResponde({ id: '1', name: 'Quien Sea' });

    const res = await api().get('/api/auth/oauth/facebook/callback').query({ code: 'c', state });
    expect(fragmento(res).oauth_error).toBe('expired_state');
  });

  it('un state vencido no vale', async () => {
    const state = await nuevoViaje();
    await pool.query(
      `UPDATE oauth_states SET created_at = now() - make_interval(mins => $1) WHERE state = $2`,
      [oauth.STATE_TTL_MINUTES + 1, state]);
    metaResponde({ id: '1', name: 'Quien Sea' });

    const res = await api().get('/api/auth/oauth/facebook/callback').query({ code: 'c', state });
    expect(fragmento(res).oauth_error).toBe('expired_state');
  });

  it('si el cliente cancela en la pantalla de permisos, vuelve sin ruido', async () => {
    const res = await api().get('/api/auth/oauth/facebook/callback')
      .query({ error: 'access_denied', error_description: 'Permissions error' });

    expect(res.status).toBe(302);
    expect(fragmento(res).oauth_error).toBe('cancelled');
  });

  it('si Meta falla al canjear, la persona ve un error genérico y no el de Meta', async () => {
    const state = await nuevoViaje();
    metaResponde(null, { tokenOk: false });

    const res = await api().get('/api/auth/oauth/facebook/callback').query({ code: 'c', state });
    const frag = fragmento(res);
    expect(frag.oauth_error).toBe('provider');
    expect(String(res.headers.location)).not.toContain(APP_ID);
  });
});

// ===========================================================================
// La vuelta: entrar y registrarse
// ===========================================================================

describe('GET /api/auth/oauth/facebook/callback — entrar', () => {
  it('una cuenta social nueva NO crea cuenta sola: devuelve un token de completar', async () => {
    const state = await nuevoViaje();
    metaResponde({ id: '77', name: 'Ana Pérez', email: 'ana@correo.mx' });

    const res = await api().get('/api/auth/oauth/facebook/callback').query({ code: 'c', state });
    expect(fragmento(res).oauth_signup).toBeTruthy();

    const { rows } = await pool.query('SELECT count(*)::int AS n FROM users');
    expect(rows[0].n).toBe(0);
  });

  it('NO se liga sola por el correo: una cuenta que ya existe no se entrega', async () => {
    await f.createUser(club.id, { email: 'ana@correo.mx' });
    const state = await nuevoViaje();
    metaResponde({ id: '77', name: 'Ana Pérez', email: 'ana@correo.mx' });

    const res = await api().get('/api/auth/oauth/facebook/callback').query({ code: 'c', state });
    const frag = fragmento(res);
    expect(frag.oauth_error).toBe('email_taken');
    expect(frag.h).toBeUndefined();
    expect(frag.oauth_signup).toBeUndefined();
    // Y no quedó ligada ninguna identidad.
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM user_identities');
    expect(rows[0].n).toBe(0);
  });

  it('con la cuenta ya ligada, entrega un pase de mano y no la sesión en la dirección', async () => {
    const user = await f.createUser(club.id, { email: 'ligada@correo.mx' });
    await pool.query(
      `INSERT INTO user_identities (user_id, provider, provider_user_id, email)
       VALUES ($1,'facebook','77','ligada@correo.mx')`, [user.id]);
    const state = await nuevoViaje();
    metaResponde({ id: '77', name: 'Ana Pérez', email: 'ligada@correo.mx' });

    const res = await api().get('/api/auth/oauth/facebook/callback').query({ code: 'c', state });
    const frag = fragmento(res);
    expect(frag.h).toMatch(/^[0-9a-f]{64}$/);
    // Lo que queda en el historial del navegador no es una sesión.
    expect(String(res.headers.location)).not.toMatch(/access_token|refresh_token|eyJ/);
  });

  it('una cuenta bloqueada no entra aunque tenga Facebook ligado', async () => {
    const user = await f.createUser(club.id);
    await pool.query('UPDATE users SET status = $1 WHERE id = $2', ['blocked', user.id]);
    await pool.query(
      `INSERT INTO user_identities (user_id, provider, provider_user_id)
       VALUES ($1,'facebook','77')`, [user.id]);
    const state = await nuevoViaje();
    metaResponde({ id: '77', name: 'Ana Pérez' });

    const res = await api().get('/api/auth/oauth/facebook/callback').query({ code: 'c', state });
    expect(fragmento(res).oauth_error).toBe('account_inactive');
  });

  it('el mismo Facebook en otro club no entra a la cuenta del primero', async () => {
    const otro = await f.createNightclub({ slug: 'otro-club', name: 'Otro' });
    const user = await f.createUser(otro.id);
    await pool.query(
      `INSERT INTO user_identities (user_id, provider, provider_user_id)
       VALUES ($1,'facebook','77')`, [user.id]);
    const state = await nuevoViaje(); // viaje del club ev2-oauth
    metaResponde({ id: '77', name: 'Ana Pérez' });

    const res = await api().get('/api/auth/oauth/facebook/callback').query({ code: 'c', state });
    // No encuentra a nadie EN ESTE club, así que ofrece registro, no la sesión ajena.
    expect(fragmento(res).h).toBeUndefined();
    expect(fragmento(res).oauth_signup).toBeTruthy();
  });
});

// ===========================================================================
// El pase de mano
// ===========================================================================

describe('POST /api/auth/oauth/handoff', () => {
  async function paseVivo() {
    const user = await f.createUser(club.id, { email: 'pase@correo.mx' });
    await pool.query(
      `INSERT INTO user_identities (user_id, provider, provider_user_id)
       VALUES ($1,'facebook','77')`, [user.id]);
    const state = await nuevoViaje();
    metaResponde({ id: '77', name: 'Ana Pérez' });
    const res = await api().get('/api/auth/oauth/facebook/callback').query({ code: 'c', state });
    return { user, handoff: fragmento(res).h };
  }

  it('se canjea por una sesión de verdad', async () => {
    const { user, handoff } = await paseVivo();

    const res = await api().post('/api/auth/oauth/handoff').send({ handoff });
    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(user.id);
    expect(res.body.access_token).toEqual(expect.any(String));
    expect(res.body.refresh_token).toEqual(expect.any(String));

    // Y la sesión sirve.
    const yo = await api().get('/api/auth/me')
      .set('Authorization', `Bearer ${res.body.access_token}`);
    expect(yo.status).toBe(200);
  });

  it('es de UN SOLO USO: el que queda en el historial ya no abre nada', async () => {
    const { handoff } = await paseVivo();

    expect((await api().post('/api/auth/oauth/handoff').send({ handoff })).status).toBe(200);
    const segunda = await api().post('/api/auth/oauth/handoff').send({ handoff });
    expect(segunda.status).toBe(401);
  });

  it('un pase inventado no entra', async () => {
    const res = await api().post('/api/auth/oauth/handoff').send({ handoff: 'f'.repeat(64) });
    expect(res.status).toBe(401);
  });

  it('un pase vencido no entra', async () => {
    const { handoff } = await paseVivo();
    await pool.query(
      `UPDATE oauth_handoffs SET created_at = now() - interval '5 minutes' WHERE token = $1`,
      [handoff]);

    const res = await api().post('/api/auth/oauth/handoff').send({ handoff });
    expect(res.status).toBe(401);
  });
});

// ===========================================================================
// Completar el registro
// ===========================================================================

describe('POST /api/auth/oauth/complete', () => {
  function tokenDeCompletar(over = {}) {
    return oauth.signCompletionToken({
      provider: 'facebook',
      provider_user_id: '77',
      email: 'ana@correo.mx',
      first_name: 'Ana',
      last_name: 'Pérez',
      display_name: 'Ana Pérez',
      nightclub_id: club.id,
      ...over,
    });
  }
  const cuerpo = (over = {}) => ({
    completion_token: tokenDeCompletar(),
    birth_date: '1995-06-15',
    accept_terms: true,
    ...over,
  });

  it('crea la cuenta sin contraseña y entrega la sesión', async () => {
    const res = await api().post('/api/auth/oauth/complete').send(cuerpo());

    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({ email: 'ana@correo.mx', role: 'guest' });
    expect(res.body.access_token).toEqual(expect.any(String));

    const { rows } = await pool.query('SELECT password_hash FROM users WHERE email = $1',
      ['ana@correo.mx']);
    // NULL dice la verdad: esta cuenta no entra por contraseña. No se le inventa
    // un hash que parezca una credencial y no lo sea.
    expect(rows[0].password_hash).toBeNull();
  });

  it('deja la identidad ligada y sin token del proveedor guardado', async () => {
    await api().post('/api/auth/oauth/complete').send(cuerpo());
    const { rows } = await pool.query('SELECT * FROM user_identities');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ provider: 'facebook', provider_user_id: '77' });
    // La tabla no tiene dónde guardar el token del proveedor, a propósito.
    expect(Object.keys(rows[0])).not.toContain('access_token');
  });

  it('un menor de edad NO termina el registro', async () => {
    const hace17 = new Date();
    hace17.setFullYear(hace17.getFullYear() - 17);
    const res = await api().post('/api/auth/oauth/complete')
      .send(cuerpo({ birth_date: hace17.toISOString().slice(0, 10) }));

    expect(res.status).toBe(422);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM users');
    expect(rows[0].n).toBe(0);
  });

  it('sin aceptar términos no se crea nada', async () => {
    const res = await api().post('/api/auth/oauth/complete').send(cuerpo({ accept_terms: false }));
    expect(res.status).toBe(400);
  });

  it('si el proveedor no dio correo, se pide', async () => {
    const res = await api().post('/api/auth/oauth/complete')
      .send({ ...cuerpo(), completion_token: tokenDeCompletar({ email: null }) });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/correo/);
  });

  it('con el correo escrito a mano sí se crea', async () => {
    const res = await api().post('/api/auth/oauth/complete').send({
      ...cuerpo(),
      completion_token: tokenDeCompletar({ email: null }),
      email: 'amano@correo.mx',
    });
    expect(res.status).toBe(201);
    expect(res.body.user.email).toBe('amano@correo.mx');
  });

  it('el mismo token no crea dos cuentas', async () => {
    const token = tokenDeCompletar();
    expect((await api().post('/api/auth/oauth/complete')
      .send(cuerpo({ completion_token: token }))).status).toBe(201);

    const segunda = await api().post('/api/auth/oauth/complete')
      .send(cuerpo({ completion_token: token, email: 'otro@correo.mx' }));
    expect(segunda.status).toBe(409);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM users');
    expect(rows[0].n).toBe(1);
  });

  it('un token de completar NO sirve como sesión: el emisor es distinto', async () => {
    const token = tokenDeCompletar();
    const res = await api().get('/api/auth/me').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
  });

  it('una sesión de verdad NO sirve para completar un registro', async () => {
    const user = await f.createUser(club.id, { role: 'manager' });
    const { signAccessToken } = require('../src/middleware/auth');
    const res = await api().post('/api/auth/oauth/complete')
      .send(cuerpo({ completion_token: signAccessToken(user) }));
    expect(res.status).toBe(401);
  });

  it('un token de completar vencido se rechaza con un mensaje que se entiende', async () => {
    const vencido = jwt.sign(
      { provider: 'facebook', pid: '77', nc: club.id },
      process.env.JWT_SECRET,
      { expiresIn: '-1m', issuer: oauth.COMPLETION_ISSUER });

    const res = await api().post('/api/auth/oauth/complete')
      .send(cuerpo({ completion_token: vencido }));
    expect(res.status).toBe(401);
    expect(res.body.error.message).toMatch(/tardó demasiado/);
  });

  it('un token firmado con otro secreto se rechaza', async () => {
    const falso = jwt.sign({ provider: 'facebook', pid: '77', nc: club.id },
      'otro-secreto-de-al-menos-16', { expiresIn: '15m', issuer: oauth.COMPLETION_ISSUER });

    const res = await api().post('/api/auth/oauth/complete')
      .send(cuerpo({ completion_token: falso }));
    expect(res.status).toBe(401);
  });
});

// ===========================================================================
// Ligar y desvincular desde el perfil
// ===========================================================================

describe('ligar y desvincular', () => {
  it('la lista de cuentas ligadas dice si se puede quitar alguna', async () => {
    const user = await f.createUser(club.id);
    const res = await api().get('/api/auth/oauth/linked').set(auth(user));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ identities: [], has_password: true, can_unlink: false });
  });

  it('ligar con la sesión puesta guarda el state con el dueño', async () => {
    const user = await f.createUser(club.id);
    const res = await api().post('/api/auth/oauth/facebook/link').set(auth(user)).send({});

    expect(res.status).toBe(200);
    const state = new URL(res.body.authorize_url).searchParams.get('state');
    const { rows } = await pool.query('SELECT link_user_id FROM oauth_states WHERE state = $1',
      [state]);
    expect(rows[0].link_user_id).toBe(user.id);
  });

  it('la vuelta de un viaje de ligar liga la cuenta y no crea otra', async () => {
    const user = await f.createUser(club.id);
    const inicio = await api().post('/api/auth/oauth/facebook/link').set(auth(user)).send({});
    const state = new URL(inicio.body.authorize_url).searchParams.get('state');
    metaResponde({ id: '77', name: 'Ana Pérez', email: 'ana@correo.mx' });

    const res = await api().get('/api/auth/oauth/facebook/callback').query({ code: 'c', state });
    expect(fragmento(res).oauth_linked).toBe('facebook');

    const { rows } = await pool.query('SELECT user_id FROM user_identities');
    expect(rows).toHaveLength(1);
    expect(rows[0].user_id).toBe(user.id);
  });

  it('un Facebook ya ligado a otra persona no se roba', async () => {
    const primera = await f.createUser(club.id, { email: 'primera@correo.mx' });
    await pool.query(
      `INSERT INTO user_identities (user_id, provider, provider_user_id)
       VALUES ($1,'facebook','77')`, [primera.id]);

    const segunda = await f.createUser(club.id, { email: 'segunda@correo.mx' });
    const inicio = await api().post('/api/auth/oauth/facebook/link').set(auth(segunda)).send({});
    const state = new URL(inicio.body.authorize_url).searchParams.get('state');
    metaResponde({ id: '77', name: 'Ana Pérez' });

    const res = await api().get('/api/auth/oauth/facebook/callback').query({ code: 'c', state });
    expect(fragmento(res).oauth_error).toBe('already_linked');
    const { rows } = await pool.query('SELECT user_id FROM user_identities');
    expect(rows).toHaveLength(1);
    expect(rows[0].user_id).toBe(primera.id);
  });

  it('con contraseña, quitar la cuenta social se permite', async () => {
    const user = await f.createUser(club.id);
    await pool.query(
      `INSERT INTO user_identities (user_id, provider, provider_user_id)
       VALUES ($1,'facebook','77')`, [user.id]);

    const res = await api().delete('/api/auth/oauth/facebook').set(auth(user));
    expect(res.status).toBe(204);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM user_identities');
    expect(rows[0].n).toBe(0);
  });

  it('sin contraseña y con una sola cuenta ligada, NO se deja fuera a la persona', async () => {
    const user = await f.createUser(club.id);
    await pool.query('UPDATE users SET password_hash = NULL WHERE id = $1', [user.id]);
    await pool.query(
      `INSERT INTO user_identities (user_id, provider, provider_user_id)
       VALUES ($1,'facebook','77')`, [user.id]);

    const res = await api().delete('/api/auth/oauth/facebook').set(auth(user));
    expect(res.status).toBe(409);
    expect(res.body.error.details.reason).toBe('last_way_in');
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM user_identities');
    expect(rows[0].n).toBe(1);
  });

  it('quitar una cuenta que no se tiene ligada es 404', async () => {
    const user = await f.createUser(club.id);
    const res = await api().delete('/api/auth/oauth/facebook').set(auth(user));
    expect(res.status).toBe(404);
  });

  it('ligar y desvincular exigen sesión', async () => {
    expect((await api().get('/api/auth/oauth/linked')).status).toBe(401);
    expect((await api().post('/api/auth/oauth/facebook/link').send({})).status).toBe(401);
    expect((await api().delete('/api/auth/oauth/facebook')).status).toBe(401);
  });
});

// ===========================================================================
// La contraseña, cuando la cuenta no tiene
// ===========================================================================

describe('POST /api/auth/login con una cuenta sin contraseña', () => {
  it('contesta credenciales inválidas, no un error del servidor', async () => {
    const user = await f.createUser(club.id, { email: 'social@correo.mx' });
    await pool.query('UPDATE users SET password_hash = NULL WHERE id = $1', [user.id]);

    const res = await api().post('/api/auth/login').send({
      nightclub_slug: 'ev2-oauth', email: 'social@correo.mx', password: 'CualquieraSirve1',
    });
    expect(res.status).toBe(401);
  });

  it('una contraseña vacía tampoco entra a una cuenta sin contraseña', async () => {
    const user = await f.createUser(club.id, { email: 'social2@correo.mx' });
    await pool.query('UPDATE users SET password_hash = NULL WHERE id = $1', [user.id]);

    const res = await api().post('/api/auth/login').send({
      nightclub_slug: 'ev2-oauth', email: 'social2@correo.mx', password: '',
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});
