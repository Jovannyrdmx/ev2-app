'use strict';

// Cliente web compartido (D30). Vive en web/js/ pero se prueba con el mismo jest: la
// lógica que de verdad se rompe —renovar el token, reintentar, reconectar el socket— no
// necesita navegador, y por eso el módulo recibe fetch y WebSocket desde fuera.

const EV2 = require('../../web/js/api.js');
const fmt = require('../../web/js/format.js');

/** localStorage de mentira, incluido el modo que lanza excepción (navegación privada). */
function fakeStorage({ broken = false } = {}) {
  const data = new Map();
  return {
    getItem: (k) => { if (broken) throw new Error('bloqueado'); return data.has(k) ? data.get(k) : null; },
    setItem: (k, v) => { if (broken) throw new Error('bloqueado'); data.set(k, v); },
    removeItem: (k) => { if (broken) throw new Error('bloqueado'); data.delete(k); },
    _data: data,
  };
}

/** fetch programable: se le da la respuesta de cada llamada y guarda lo que recibió. */
function fakeFetch(handlers) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, headers: init.headers, body: init.body ? JSON.parse(init.body) : null });
    const handler = handlers.shift();
    if (!handler) throw new Error(`fetch inesperado: ${init.method} ${url}`);
    if (typeof handler === 'function') return handler({ url, init });
    if (handler.throw) throw handler.throw;
    return {
      status: handler.status,
      json: async () => handler.body,
    };
  };
  fn.calls = calls;
  return fn;
}

const ok = (body) => ({ status: 200, body });
const fail = (status, code, message, details) => ({
  status, body: { error: { code, message, details, request_id: 'req-1' } },
});

const TOKENS = {
  access_token: 'access-1',
  refresh_token: 'refresh-1',
  user: { id: 'u1', nightclub_id: 'c1', role: 'guest', display_name: 'Ana' },
};

const client = (handlers, extra = {}) => EV2.createClient(Object.assign({
  baseUrl: '/api', fetch: fakeFetch(handlers), storage: fakeStorage(), retries: 0,
}, extra));

// ---------------------------------------------------------------- sesión

describe('Sesión', () => {
  it('el token de acceso vive en memoria y solo el de refresco se guarda', async () => {
    const storage = fakeStorage();
    const api = client([ok(TOKENS)], { storage });
    await api.login({ nightclubSlug: 'ev2', email: 'a@b.mx', password: 'x' });

    expect(api.session.user.display_name).toBe('Ana');
    const saved = JSON.parse(storage._data.get('ev2.session'));
    expect(saved.refresh_token).toBe('refresh-1');
    // Lo importante: el token de acceso NO queda en el almacenamiento del navegador.
    expect(JSON.stringify(saved)).not.toContain('access-1');
  });

  it('manda el Bearer y un id de petición para poder rastrear el error', async () => {
    const api = client([ok(TOKENS), ok({ drinks: [] })]);
    await api.login({ nightclubSlug: 'ev2', email: 'a@b.mx', password: 'x' });
    await api.get('/nightclubs/c1/drinks');
    const last = api.config.fetch.calls[1];
    expect(last.headers.Authorization).toBe('Bearer access-1');
    expect(last.headers['X-Request-Id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('con el almacenamiento bloqueado la sesión sigue funcionando en memoria', async () => {
    const api = client([ok(TOKENS), ok({ ok: true })], { storage: fakeStorage({ broken: true }) });
    await api.login({ nightclubSlug: 'ev2', email: 'a@b.mx', password: 'x' });
    expect(api.session.user.id).toBe('u1');
    await expect(api.get('/algo')).resolves.toEqual({ ok: true });
  });

  it('cerrar sesión limpia todo aunque el servidor no conteste', async () => {
    const storage = fakeStorage();
    const api = client([ok(TOKENS), { throw: new Error('sin red') }], { storage });
    await api.login({ nightclubSlug: 'ev2', email: 'a@b.mx', password: 'x' });
    await api.logout();
    expect(api.session.accessToken).toBeNull();
    expect(storage._data.get('ev2.session')).toBeUndefined();
  });

  it('retoma la sesión guardada al recargar la página', async () => {
    const storage = fakeStorage();
    storage.setItem('ev2.session', JSON.stringify({
      refresh_token: 'refresh-guardado', user: { id: 'u1', role: 'guest' },
    }));
    const api = client([
      ok({ access_token: 'access-2', refresh_token: 'refresh-2' }),
      ok({ user: { id: 'u1', role: 'guest', display_name: 'Ana' } }),
    ], { storage });

    const user = await api.resume();
    expect(user.display_name).toBe('Ana');
    expect(api.session.accessToken).toBe('access-2');
    // Y el token de refresco rotado quedó guardado, no el viejo.
    expect(JSON.parse(storage._data.get('ev2.session')).refresh_token).toBe('refresh-2');
  });

  it('si el token guardado ya no sirve, no deja una sesión a medias', async () => {
    const storage = fakeStorage();
    storage.setItem('ev2.session', JSON.stringify({ refresh_token: 'viejo', user: { id: 'u1' } }));
    const api = client([fail(401, 'unauthorized', 'Invalid refresh token')], { storage });
    expect(await api.resume()).toBeNull();
    expect(api.session.refreshToken).toBeNull();
    expect(storage._data.get('ev2.session')).toBeUndefined();
  });
});

// ---------------------------------------------------------------- renovación

describe('Renovación del token', () => {
  it('un 401 renueva y reintenta una sola vez, sin que la pantalla se entere', async () => {
    const api = client([
      ok(TOKENS),
      fail(401, 'unauthorized', 'Token expired'),
      ok({ access_token: 'access-2', refresh_token: 'refresh-2' }),
      ok({ tables: [1, 2] }),
    ]);
    await api.login({ nightclubSlug: 'ev2', email: 'a@b.mx', password: 'x' });
    await expect(api.get('/nightclubs/c1/tables')).resolves.toEqual({ tables: [1, 2] });
    // El reintento va con el token nuevo.
    expect(api.config.fetch.calls[3].headers.Authorization).toBe('Bearer access-2');
  });

  it('diez peticiones que caducan a la vez disparan UNA sola renovación', async () => {
    // Con rotación de token de refresco, dos renovaciones en paralelo invalidarían la
    // sesión: la segunda usaría un token ya canjeado.
    let refreshes = 0;
    const router = (url, init) => {
      const path = String(url);
      if (path.endsWith('/auth/login')) {
        return Promise.resolve({ status: 200, json: async () => TOKENS });
      }
      if (path.endsWith('/auth/refresh')) {
        refreshes += 1;
        return Promise.resolve({
          status: 200,
          json: async () => ({ access_token: 'access-2', refresh_token: `r-${refreshes}` }),
        });
      }
      if (init.headers.Authorization === 'Bearer access-1') {
        return Promise.resolve({ status: 401, json: async () => ({ error: { code: 'unauthorized' } }) });
      }
      return Promise.resolve({ status: 200, json: async () => ({ ok: true }) });
    };
    const api = EV2.createClient({
      baseUrl: '/api', fetch: router, storage: fakeStorage(), retries: 0,
    });
    await api.login({ nightclubSlug: 'ev2', email: 'a@b.mx', password: 'x' });

    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => api.get(`/recurso/${i}`)));
    expect(results.every((r) => r.ok)).toBe(true);
    expect(refreshes).toBe(1);
  });

  it('si la renovación falla, avisa que la sesión terminó en vez de insistir', async () => {
    const api = client([
      ok(TOKENS),
      fail(401, 'unauthorized', 'Token expired'),
      fail(401, 'unauthorized', 'Invalid refresh token'),
    ]);
    await api.login({ nightclubSlug: 'ev2', email: 'a@b.mx', password: 'x' });
    const expired = [];
    api.on('auth:expired', () => expired.push(1));
    await expect(api.get('/algo')).rejects.toMatchObject({ status: 401 });
    expect(expired).toHaveLength(1);
    expect(api.session.refreshToken).toBeNull();
  });

  it('avisa cuando la cuenta trae contraseña temporal pendiente', async () => {
    const api = client([ok(TOKENS), fail(403, 'password_change_required', 'Cambia tu contraseña')]);
    await api.login({ nightclubSlug: 'ev2', email: 'a@b.mx', password: 'x' });
    const avisos = [];
    api.on('auth:password_change_required', () => avisos.push(1));
    await expect(api.get('/algo')).rejects.toMatchObject({ code: 'password_change_required' });
    expect(avisos).toHaveLength(1);
  });
});

// ---------------------------------------------------------------- reintentos

describe('Reintentos', () => {
  it('reintenta un GET que falló por red, y no reintenta un POST', async () => {
    const api = client([
      { throw: new TypeError('failed to fetch') },
      ok({ ok: true }),
    ], { retries: 2 });
    await expect(api.get('/menu')).resolves.toEqual({ ok: true });

    // Un POST reintentado a ciegas es la forma de cobrar dos veces.
    const api2 = client([{ throw: new TypeError('failed to fetch') }], { retries: 2 });
    await expect(api2.post('/pedidos', { x: 1 })).rejects.toMatchObject({ name: 'NetworkError' });
    expect(api2.config.fetch.calls).toHaveLength(1);
  });

  it('reintenta 503 en GET pero no 400', async () => {
    expect(EV2.shouldRetry('GET', 503)).toBe(true);
    expect(EV2.shouldRetry('GET', 429)).toBe(true);
    expect(EV2.shouldRetry('GET', 400)).toBe(false);
    expect(EV2.shouldRetry('GET', 409)).toBe(false);
    expect(EV2.shouldRetry('POST', 503)).toBe(false);
    expect(EV2.shouldRetry('DELETE', null)).toBe(false);
  });

  it('el error trae código, folio y los errores por campo listos para pintar', async () => {
    const api = client([fail(400, 'bad_request', 'Validation failed', [
      { field: 'body.email', message: 'must be a valid email' },
      { field: 'body.password', message: 'must be at least 8 characters' },
    ])]);
    const err = await api.get('/x').catch((e) => e);
    expect(err).toBeInstanceOf(EV2.ApiError);
    expect(err.code).toBe('bad_request');
    expect(err.requestId).toBe('req-1');
    expect(err.fieldErrors()).toEqual({
      email: 'must be a valid email',
      password: 'must be at least 8 characters',
    });
  });
});

// ---------------------------------------------------------------- tiempo real

/** WebSocket de mentira que deja provocar mensajes y cierres desde la prueba. */
class FakeWS {
  constructor(url, protocols) {
    this.url = url;
    this.protocols = protocols;
    this.readyState = 0;
    this.sent = [];
    FakeWS.instances.push(this);
  }

  open() { this.readyState = 1; if (this.onopen) this.onopen({}); }
  receive(msg) { if (this.onmessage) this.onmessage({ data: JSON.stringify(msg) }); }
  fire(code) { this.readyState = 3; if (this.onclose) this.onclose({ code }); }
  send(data) { this.sent.push(JSON.parse(data)); }
  close() { this.readyState = 3; }
}
FakeWS.instances = [];

describe('Socket de tiempo real', () => {
  beforeEach(() => { FakeWS.instances = []; });

  /** `fetchImpl` se puede cambiar durante la prueba, para simular lo que responda la API. */
  async function connected() {
    let impl = (url) => (String(url).endsWith('/auth/login')
      ? Promise.resolve({ status: 200, json: async () => TOKENS })
      : Promise.resolve({ status: 200, json: async () => ({ ok: true }) }));
    const api = EV2.createClient({
      baseUrl: '/api',
      fetch: (url, init) => impl(url, init),
      storage: fakeStorage(),
      retries: 0,
      WebSocket: FakeWS,
      wsUrl: 'ws://x',
    });
    await api.login({ nightclubSlug: 'ev2', email: 'a@b.mx', password: 'x' });
    // Espera mínima y sin ruido: la escalada real ya se comprueba en su propia prueba.
    const rt = api.createRealtime({ backoff: { baseMs: 20, maxMs: 40, jitterMs: 0 } });
    rt.connect();
    const ws = FakeWS.instances[0];
    ws.open();
    return { api, rt, ws, setFetch: (fn) => { impl = fn; } };
  }

  it('sin wsUrl asume el mismo origen en /ws, que es lo que reenvia nginx', async () => {
    const api = EV2.createClient({
      baseUrl: '/api',
      fetch: async () => ({ status: 200, json: async () => TOKENS }),
      storage: fakeStorage(),
      WebSocket: FakeWS,
      // sin wsUrl: en Node no hay `location`, asi que cae al respaldo con la ruta
    });
    await api.login({ nightclubSlug: 'ev2', email: 'a@b.mx', password: 'x' });
    const rt = api.createRealtime({ backoff: { baseMs: 10, maxMs: 20, jitterMs: 0 } });
    rt.connect();
    expect(FakeWS.instances[0].url).toBe('ws://localhost:4000/ws');
    rt.close();
  });

  it('al reconectar cuelga since_id de la ruta, sin duplicar la barra', async () => {
    const { rt, ws } = await connected();
    ws.receive({ type: 'welcome', last_event_id: '7' });
    ws.fire(1006);
    await new Promise((r) => setTimeout(r, 120));
    // wsUrl explicito sin ruta: la query se pega directo, no como "//?since_id".
    expect(FakeWS.instances[1].url).toBe('ws://x?since_id=7');
    rt.close();
  });

  it('manda el token en el subprotocolo, no en la URL', async () => {
    const { ws } = await connected();
    expect(ws.protocols).toEqual(['bearer', 'access-1']);
    expect(ws.url).not.toContain('access-1');
  });

  it('entrega los eventos por tipo y recuerda el último id', async () => {
    const { rt, ws } = await connected();
    const pedidos = [];
    rt.on('order_created', (p) => pedidos.push(p));
    ws.receive({ type: 'welcome', last_event_id: '10' });
    ws.receive({ type: 'event', id: '11', event_type: 'order_created', payload: { mesa: 39 } });
    expect(pedidos).toEqual([{ mesa: 39 }]);
    expect(rt.lastEventId).toBe('11');
  });

  it('al reconectar pide lo que se perdió y no entrega dos veces lo mismo', async () => {
    const { rt, ws } = await connected();
    const vistos = [];
    rt.on('event', (e) => vistos.push(e.id));
    ws.receive({ type: 'welcome', last_event_id: '10' });
    ws.receive({ type: 'event', id: '11', event_type: 'x', payload: {} });

    ws.fire(1006); // se cayó la señal
    await new Promise((r) => setTimeout(r, 120));
    const ws2 = FakeWS.instances[1];
    expect(ws2).toBeDefined();
    expect(ws2.url).toContain('since_id=11');

    ws2.open();
    // La recuperación vuelve a traer el 11: no debe verse dos veces.
    ws2.receive({ type: 'event', id: '11', event_type: 'x', payload: {} });
    ws2.receive({ type: 'event', id: '12', event_type: 'x', payload: {} });
    expect(vistos).toEqual(['11', '12']);
  });

  it('con el token vencido lo renueva y vuelve a conectar', async () => {
    const { rt, ws, setFetch } = await connected();
    setFetch(async () => ({
      status: 200, json: async () => ({ access_token: 'access-2', refresh_token: 'refresh-2' }),
    }));
    ws.fire(4001);
    await new Promise((r) => setTimeout(r, 120));
    const ws2 = FakeWS.instances[1];
    expect(ws2).toBeDefined();
    // Reconecta con el token NUEVO: con el viejo el servidor volvería a cerrar en 4001.
    expect(ws2.protocols).toEqual(['bearer', 'access-2']);
    expect(rt.connected).toBe(false); // reconectó, todavía no abre
  });

  it('si otra sesión lo reemplaza NO reconecta: serían dos pestañas peleando', async () => {
    const { rt, ws } = await connected();
    const avisos = [];
    rt.on('replaced', () => avisos.push(1));
    ws.fire(4002);
    await new Promise((r) => setTimeout(r, 120));
    expect(avisos).toHaveLength(1);
    expect(FakeWS.instances).toHaveLength(1);
  });

  it('avisa cuando el hueco fue tan grande que hay que recargar', async () => {
    const { rt, ws } = await connected();
    const avisos = [];
    rt.on('resync_required', (m) => avisos.push(m.reason));
    ws.receive({ type: 'resync_required', reason: 'gap_too_large', message: 'recarga' });
    expect(avisos).toEqual(['gap_too_large']);
  });

  it('la espera entre reintentos crece, para no golpear al servidor que se reinicia', async () => {
    const api = EV2.createClient({
      baseUrl: '/api',
      fetch: async () => ({ status: 200, json: async () => TOKENS }),
      storage: fakeStorage(),
      WebSocket: FakeWS,
      wsUrl: 'ws://x',
    });
    await api.login({ nightclubSlug: 'ev2', email: 'a@b.mx', password: 'x' });
    const rt = api.createRealtime({
      backoff: { baseMs: 10, maxMs: 60, jitterMs: 0, stableMs: 10000 },
    });
    const esperas = [];
    rt.on('reconnecting', (i) => esperas.push(i.in_ms));
    rt.connect();

    for (let i = 0; i < 4; i += 1) {
      const last = FakeWS.instances[FakeWS.instances.length - 1];
      last.open();
      last.fire(1006);
      await new Promise((r) => setTimeout(r, 80));
    }
    // El socket abre y muere enseguida: eso NO cuenta como conexión buena, así que la
    // espera sigue creciendo en vez de reiniciarse.
    expect(esperas.slice(0, 3)).toEqual([10, 20, 40]);
    expect(Math.max(...esperas)).toBeLessThanOrEqual(60); // con tope
    rt.close();
  });

  it('una conexión que sí se sostuvo reinicia la espera', async () => {
    const api = EV2.createClient({
      baseUrl: '/api',
      fetch: async () => ({ status: 200, json: async () => TOKENS }),
      storage: fakeStorage(),
      WebSocket: FakeWS,
      wsUrl: 'ws://x',
    });
    await api.login({ nightclubSlug: 'ev2', email: 'a@b.mx', password: 'x' });
    // stableMs 0: cualquier conexión abierta cuenta como buena.
    const rt = api.createRealtime({ backoff: { baseMs: 10, maxMs: 60, jitterMs: 0, stableMs: 0 } });
    const esperas = [];
    rt.on('reconnecting', (i) => esperas.push(i.in_ms));
    rt.connect();
    for (let i = 0; i < 3; i += 1) {
      const last = FakeWS.instances[FakeWS.instances.length - 1];
      last.open();
      last.fire(1006);
      await new Promise((r) => setTimeout(r, 60));
    }
    expect(esperas).toEqual([10, 10, 10]);
    rt.close();
  });

  it('cerrar a propósito no dispara reconexión', async () => {
    const { rt, ws } = await connected();
    rt.close();
    ws.fire(1000);
    await new Promise((r) => setTimeout(r, 120));
    expect(FakeWS.instances).toHaveLength(1);
  });
});

// ---------------------------------------------------------------- formato

describe('Dinero e idioma', () => {
  afterEach(() => fmt.setLanguage('es'));

  it('formatea sin romper los decimales y suma en centavos', () => {
    expect(fmt.money('1500.00', 'MXN')).toMatch(/1,500\.00/);
    expect(fmt.money(null, 'MXN')).toBe('—');
    // 0.1 + 0.2 en float da 0.30000000000000004; en centavos, no.
    expect(fmt.addMoney('0.10', '0.20')).toBe('0.30');
    expect(fmt.addMoney('1500.00', '250.50', '0.50')).toBe('1751.00');
  });

  it('cambia de idioma y usa el mensaje del servidor cuando lo hay', () => {
    fmt.setLanguage('en');
    expect(fmt.t('error.network')).toMatch(/reach the server/);
    expect(fmt.errorMessage({ name: 'NetworkError' })).toMatch(/reach the server/);
    expect(fmt.errorMessage({ code: 'forbidden' })).toMatch(/permission/);

    fmt.setLanguage('es');
    // El del servidor dice *por qué*, y eso vale más que un texto genérico.
    expect(fmt.errorMessage({ code: 'conflict', message: 'Ya tienes una solicitud abierta' }))
      .toBe('Ya tienes una solicitud abierta');
    expect(fmt.errorMessage(null)).toMatch(/Algo salió mal/);
  });

  it('un idioma que no existe cae a español en vez de quedarse en blanco', () => {
    expect(fmt.setLanguage('fr')).toBe('es');
    expect(fmt.t('error.network')).toMatch(/contactar al servidor/);
  });
});

// ---------------------------------------------------------------- CORS

describe('Origen no permitido', () => {
  // El navegador manda `Origin` incluso en peticiones al mismo origen cuando no son GET.
  // Antes esto salía como "500 Internal server error" y no decía nada del problema real.
  const { createApp } = require('../src/app');
  const request = require('supertest');

  it('responde 403 diciendo qué configurar, no un 500 mudo', async () => {
    const saved = process.env.ALLOWED_ORIGINS;
    process.env.ALLOWED_ORIGINS = 'http://permitido.mx';
    const app = createApp();
    const res = await request(app).post('/api/auth/login')
      .set('Origin', 'http://otro.mx')
      .send({ nightclub_slug: 'x', email: 'a@b.mx', password: 'xxxxxxxx' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('origin_not_allowed');
    expect(res.body.error.message).toMatch(/ALLOWED_ORIGINS/);
    expect(res.body.error.message).toContain('http://otro.mx');
    process.env.ALLOWED_ORIGINS = saved;
  });

  it('un origen permitido pasa, y un cliente nativo sin Origin también', async () => {
    const saved = process.env.ALLOWED_ORIGINS;
    process.env.ALLOWED_ORIGINS = 'http://permitido.mx';
    const app = createApp();
    // 400 por credenciales inválidas es señal de que CORS lo dejó pasar.
    const conOrigen = await request(app).post('/api/auth/login')
      .set('Origin', 'http://permitido.mx').send({});
    expect(conOrigen.status).toBe(400);
    const sinOrigen = await request(app).post('/api/auth/login').send({});
    expect(sinOrigen.status).toBe(400);
    process.env.ALLOWED_ORIGINS = saved;
  });
});
