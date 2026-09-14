/**
 * EV2 — cliente compartido de la API (paso 5.1, docs/DECISIONES.md D30).
 *
 * Lo usan todas las pantallas. Sin paso de compilación: se carga con una etiqueta
 * <script> y queda en `window.EV2`. También se puede requerir desde Node, que es como
 * está probado.
 *
 * Todo lo que entra del exterior —fetch, WebSocket, almacenamiento— se inyecta, así que
 * la lógica que de verdad se rompe (renovar el token, reintentar, reconectar) se prueba
 * sin navegador.
 *
 *   <script src="/js/api.js"></script>
 *   <script>
 *     const api = EV2.createClient({ baseUrl: '/api' });
 *     await api.login({ nightclubSlug: 'ev2', email, password });
 *     const { drinks } = await api.get(`/nightclubs/${api.session.user.nightclub_id}/drinks`);
 *   </script>
 */
(function (root, factory) {
  const lib = factory();
  if (typeof module === 'object' && module.exports) module.exports = lib;
  else root.EV2 = lib;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /** Errores de la API con la forma que documenta openapi.yaml. */
  class ApiError extends Error {
    constructor(status, body, requestId) {
      const info = (body && body.error) || {};
      super(info.message || `HTTP ${status}`);
      this.name = 'ApiError';
      this.status = status;
      this.code = info.code || 'unknown';
      this.details = info.details || null;
      this.requestId = info.request_id || requestId || null;
    }

    /** Errores por campo, para pintarlos junto al input que los provocó. */
    fieldErrors() {
      if (!Array.isArray(this.details)) return {};
      return this.details.reduce((acc, d) => {
        acc[String(d.field || '').replace(/^body\./, '')] = d.message;
        return acc;
      }, {});
    }
  }

  class NetworkError extends Error {
    constructor(cause) {
      super('No hay conexión con el servidor');
      this.name = 'NetworkError';
      this.code = 'network';
      this.cause = cause;
    }
  }

  const DEFAULTS = {
    baseUrl: '/api',
    wsUrl: null,           // se deduce de baseUrl si no se indica
    timeoutMs: 15000,
    retries: 2,            // solo para GET; ver shouldRetry()
    storageKey: 'ev2.session',
  };

  function uuid() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    // Respaldo para navegadores viejos y para las pruebas.
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = Math.floor(Math.random() * 16);
      return (c === 'x' ? r : ((r & 0x3) | 0x8)).toString(16);
    });
  }

  /** Almacenamiento que no explota cuando el navegador lo tiene bloqueado. */
  function safeStorage(storage) {
    return {
      get(key) {
        try { return storage ? storage.getItem(key) : null; } catch { return null; }
      },
      set(key, value) {
        try { if (storage) storage.setItem(key, value); } catch { /* modo privado */ }
      },
      remove(key) {
        try { if (storage) storage.removeItem(key); } catch { /* ídem */ }
      },
    };
  }

  /** Emisor de eventos mínimo: `on()` devuelve la función para darse de baja. */
  function emitter() {
    const listeners = new Map();
    return {
      on(type, fn) {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type).add(fn);
        return () => listeners.get(type).delete(fn);
      },
      emit(type, payload) {
        for (const fn of listeners.get(type) || []) {
          // Un manejador que falla no puede tumbar a los demás ni al que emite.
          try { fn(payload); } catch (err) { console.error(`EV2 listener ${type}:`, err); }
        }
        for (const fn of listeners.get('*') || []) {
          try { fn({ type, payload }); } catch { /* ídem */ }
        }
      },
    };
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /**
   * Solo se reintenta lo que se puede repetir sin consecuencias. Un POST reintentado a
   * ciegas es la forma de cobrar dos veces; los que sí son idempotentes lo son porque
   * llevan `client_request_id`, y para esos el servidor devuelve el mismo recurso.
   */
  function shouldRetry(method, status) {
    if (method !== 'GET' && method !== 'HEAD') return false;
    return status === null || status === 502 || status === 503 || status === 504 || status === 429;
  }

  function createClient(options) {
    const cfg = Object.assign({}, DEFAULTS, options || {});
    const g = typeof globalThis !== 'undefined' ? globalThis : {};
    const doFetch = cfg.fetch || (g.fetch ? g.fetch.bind(g) : null);
    const WS = cfg.WebSocket || g.WebSocket || null;
    const store = safeStorage(cfg.storage || (g.localStorage || null));
    const bus = emitter();

    const session = {
      accessToken: null,   // solo en memoria: no sobrevive a un refresco de página a propósito
      refreshToken: null,
      user: null,
      expiresAt: null,
    };

    function persist() {
      // El token de acceso NO se guarda: dura 15 minutos y se vuelve a pedir con el de
      // refresco. El de refresco sí, porque si no, cerrar la pestaña sería cerrar sesión.
      // Queda anotado en D30 como deuda a resolver con cookie httpOnly en la fase 8.
      if (session.refreshToken) {
        store.set(cfg.storageKey, JSON.stringify({
          refresh_token: session.refreshToken, user: session.user,
        }));
      } else {
        store.remove(cfg.storageKey);
      }
    }

    function restore() {
      const raw = store.get(cfg.storageKey);
      if (!raw) return false;
      try {
        const saved = JSON.parse(raw);
        session.refreshToken = saved.refresh_token || null;
        session.user = saved.user || null;
        return Boolean(session.refreshToken);
      } catch {
        store.remove(cfg.storageKey);
        return false;
      }
    }

    function clearSession(reason) {
      session.accessToken = null;
      session.refreshToken = null;
      session.user = null;
      session.expiresAt = null;
      persist();
      bus.emit('auth:signed_out', { reason });
    }

    function applyTokens(data) {
      if (data.access_token) session.accessToken = data.access_token;
      if (data.refresh_token) session.refreshToken = data.refresh_token;
      if (data.user) session.user = data.user;
      persist();
    }

    // ---------------------------------------------------------------- petición

    async function rawRequest(method, path, { body, headers, signal, timeoutMs } = {}) {
      if (!doFetch) throw new Error('No hay fetch disponible; pásalo en createClient({ fetch })');
      const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timer = controller
        ? setTimeout(() => controller.abort(), timeoutMs || cfg.timeoutMs)
        : null;
      if (signal && controller) signal.addEventListener('abort', () => controller.abort());

      const requestId = uuid();
      const finalHeaders = Object.assign({
        Accept: 'application/json',
        'X-Request-Id': requestId,
      }, headers || {});
      if (body !== undefined) finalHeaders['Content-Type'] = 'application/json';
      if (session.accessToken) finalHeaders.Authorization = `Bearer ${session.accessToken}`;

      let res;
      try {
        res = await doFetch(cfg.baseUrl + path, {
          method,
          headers: finalHeaders,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: controller ? controller.signal : undefined,
        });
      } catch (err) {
        throw new NetworkError(err);
      } finally {
        if (timer) clearTimeout(timer);
      }

      if (res.status === 204) return { status: 204, data: null, requestId };
      let data = null;
      try { data = await res.json(); } catch { data = null; }
      return { status: res.status, data, requestId };
    }

    // Una sola renovación en vuelo: diez peticiones que caducan a la vez no deben
    // disparar diez refrescos, y con rotación de token de refresco eso además invalidaría
    // la sesión (el segundo refresco usaría un token ya canjeado).
    let refreshing = null;

    function refresh() {
      if (refreshing) return refreshing;
      if (!session.refreshToken) return Promise.reject(new ApiError(401, {}, null));
      refreshing = (async () => {
        const saved = session.refreshToken;
        session.accessToken = null;
        const { status, data } = await rawRequest('POST', '/auth/refresh', {
          body: { refresh_token: saved },
        });
        if (status !== 200 || !data || !data.access_token) {
          clearSession('refresh_failed');
          throw new ApiError(status, data, null);
        }
        applyTokens(data);
        bus.emit('auth:refreshed', { user: session.user });
        return data.access_token;
      })().finally(() => { refreshing = null; });
      return refreshing;
    }

    async function request(method, path, opts = {}) {
      let attempt = 0;
      let refreshed = false;
      for (;;) {
        let result;
        try {
          result = await rawRequest(method, path, opts);
        } catch (err) {
          if (err instanceof NetworkError && shouldRetry(method, null) && attempt < cfg.retries) {
            attempt += 1;
            await sleep(2 ** attempt * 200);
            continue;
          }
          bus.emit('error', err);
          throw err;
        }

        const { status, data, requestId } = result;
        if (status >= 200 && status < 300) return data;

        // 401 una sola vez: se renueva y se reintenta. Si vuelve a fallar, la sesión
        // terminó de verdad y la pantalla debe reaccionar en vez de insistir.
        if (status === 401 && !refreshed && session.refreshToken && !path.startsWith('/auth/refresh')) {
          refreshed = true;
          try {
            await refresh();
            continue;
          } catch {
            bus.emit('auth:expired', {});
            throw new ApiError(401, data, requestId);
          }
        }
        if (status === 401) {
          clearSession('unauthorized');
          bus.emit('auth:expired', {});
        }
        if (status === 403 && data && data.error && data.error.code === 'password_change_required') {
          bus.emit('auth:password_change_required', {});
        }
        if (shouldRetry(method, status) && attempt < cfg.retries) {
          attempt += 1;
          await sleep(2 ** attempt * 300);
          continue;
        }
        const err = new ApiError(status, data, requestId);
        bus.emit('error', err);
        throw err;
      }
    }

    // ---------------------------------------------------------------- sesión

    async function login({ nightclubSlug, email, password }) {
      const data = await request('POST', '/auth/login', {
        body: { nightclub_slug: nightclubSlug, email, password },
      });
      applyTokens(data);
      bus.emit('auth:signed_in', { user: session.user });
      return session.user;
    }

    /**
     * Guardar una sesión que ya vino armada de otra ruta.
     *
     * La usa el acceso con una cuenta social: la sesión no nace de `/auth/login`
     * sino de canjear el pase de mano (`/auth/oauth/handoff`) o de terminar el
     * registro (`/auth/oauth/complete`). Es la MISMA sesión —los mismos tokens,
     * el mismo guardado, el mismo aviso— y por eso entra por aquí en vez de que
     * cada pantalla escriba en `session` por su cuenta: una pantalla que guarda
     * tokens a mano es una pantalla que algún día se olvida de `persist()` y
     * pierde la sesión en la siguiente recarga.
     */
    function signInWith(data) {
      if (!data || !data.access_token) {
        throw new Error('signInWith needs a response with an access_token');
      }
      applyTokens(data);
      bus.emit('auth:signed_in', { user: session.user });
      return session.user;
    }

    async function logout() {
      try {
        if (session.refreshToken) {
          await request('POST', '/auth/logout', { body: { refresh_token: session.refreshToken } });
        }
      } catch { /* cerrar sesión local no puede depender de que el servidor conteste */ }
      clearSession('logout');
    }

    /** Retoma la sesión guardada al cargar la página. Devuelve el usuario o null. */
    async function resume() {
      if (!restore()) return null;
      try {
        await refresh();
        const me = await request('GET', '/auth/me');
        session.user = (me && me.user) || session.user;
        persist();
        bus.emit('auth:signed_in', { user: session.user, resumed: true });
        return session.user;
      } catch {
        clearSession('resume_failed');
        return null;
      }
    }

    const hasRole = (...roles) => Boolean(session.user)
      && (session.user.role === 'admin' || roles.includes(session.user.role));

    // ---------------------------------------------------------------- tiempo real

    /**
     * Socket que implementa el contrato de docs/api/websocket.md: token en el
     * subprotocolo, recuperación con `since_id`, códigos de cierre y reconexión con
     * espera creciente.
     */
    function createRealtime(rtOptions = {}) {
      const rt = emitter();
      // La espera entre reintentos es configurable para poder probarla sin esperar
      // segundos reales, y para poder ajustarla en un club con mala señal.
      const backoff = Object.assign({
        baseMs: 500, maxMs: 30000, jitterMs: 400,
        // Cuánto tiene que aguantar una conexión para considerarla buena. Reiniciar la
        // espera con solo abrir el socket hace que un servidor que se cae al instante
        // reciba reintentos cada medio segundo para siempre.
        stableMs: 10000,
      }, rtOptions.backoff || {});
      let ws = null;
      let lastEventId = rtOptions.lastEventId || null;
      let attempts = 0;
      let openedAt = null;
      let closedByUs = false;
      let reconnectTimer = null;
      const seen = new Set();       // ids ya entregados a la pantalla
      const seenOrder = [];

      // Sin `wsUrl` explicito se asume el mismo origen detras del proxy, en la ruta
      // `/ws` (ver deploy/nginx-web.conf). El servidor de sockets no mira la ruta: lee
      // `since_id` de la query, venga en `/` o en `/ws`.
      const wsPath = rtOptions.path || cfg.wsPath || '/ws';
      const wsBase = cfg.wsUrl || (() => {
        if (typeof location === 'undefined') return `ws://localhost:4000${wsPath}`;
        const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
        return `${proto}//${location.host}${wsPath}`;
      })();

      /** Evita entregar dos veces el mismo evento tras una reconexión. */
      function isNew(id) {
        if (!id) return true;
        if (seen.has(id)) return false;
        seen.add(id);
        seenOrder.push(id);
        if (seenOrder.length > 1000) seen.delete(seenOrder.shift());
        return true;
      }

      function scheduleReconnect(delayMs) {
        if (closedByUs || reconnectTimer) return;
        attempts += 1;
        // Espera creciente con ruido: si el servidor se reinicia, cien teléfonos no
        // vuelven todos en el mismo milisegundo.
        // 2^(intentos-1): el primer reintento espera exactamente `baseMs`, que es lo que
        // el nombre promete.
        const base = delayMs != null
          ? delayMs
          : Math.min(backoff.maxMs, 2 ** (attempts - 1) * backoff.baseMs);
        const wait = base + Math.floor(Math.random() * backoff.jitterMs);
        rt.emit('reconnecting', { attempt: attempts, in_ms: wait });
        reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, wait);
      }

      function connect() {
        if (!WS) throw new Error('No hay WebSocket disponible; pásalo en createClient({ WebSocket })');
        if (!session.accessToken) { scheduleReconnect(1000); return; }
        closedByUs = false;
        const url = wsBase + (lastEventId ? `?since_id=${encodeURIComponent(lastEventId)}` : '');
        ws = new WS(url, ['bearer', session.accessToken]);

        ws.onopen = () => { openedAt = Date.now(); rt.emit('open', {}); };

        ws.onmessage = (ev) => {
          let msg;
          try { msg = JSON.parse(ev.data); } catch { return; }
          switch (msg.type) {
            case 'welcome':
              if (!lastEventId) lastEventId = msg.last_event_id;
              rt.emit('welcome', msg);
              break;
            case 'event':
              lastEventId = msg.id;
              if (isNew(msg.id)) {
                rt.emit('event', msg);
                rt.emit(msg.event_type, msg.payload);
              }
              break;
            case 'resume_started': rt.emit('resume_started', msg); break;
            case 'resume_complete':
              lastEventId = msg.last_event_id || lastEventId;
              rt.emit('resume_complete', msg);
              break;
            case 'resync_required':
              // El hueco fue mayor de lo que el servidor reproduce: la pantalla tiene que
              // recargar su estado desde la API, no seguir como si nada.
              rt.emit('resync_required', msg);
              break;
            case 'pong': rt.emit('pong', msg); break;
            default: rt.emit(msg.type || 'message', msg);
          }
        };

        ws.onerror = () => rt.emit('socket_error', {});

        ws.onclose = async (ev) => {
          const code = ev && ev.code;
          // Solo una conexión que se sostuvo cuenta como buena.
          if (openedAt && Date.now() - openedAt >= backoff.stableMs) attempts = 0;
          openedAt = null;
          ws = null;
          rt.emit('close', { code });
          if (closedByUs) return;
          if (code === 4002) {
            // Otra sesión de la misma cuenta tomó el lugar: reconectar sería una pelea
            // entre dos pestañas.
            rt.emit('replaced', {});
            return;
          }
          if (code === 4403) { rt.emit('forbidden', {}); return; }
          if (code === 4001 || code === 4401) {
            try { await refresh(); } catch { rt.emit('auth_lost', {}); return; }
            scheduleReconnect(0);
            return;
          }
          scheduleReconnect();
        };
      }

      return {
        on: rt.on,
        connect,
        get lastEventId() { return lastEventId; },
        get connected() { return Boolean(ws) && ws.readyState === 1; },
        ping() { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'ping' })); },
        close() {
          closedByUs = true;
          if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
          if (ws) { ws.close(1000, 'client'); ws = null; }
        },
      };
    }

    return {
      config: cfg,
      session,
      on: bus.on,
      ApiError,
      NetworkError,
      uuid,
      login,
      signInWith,
      logout,
      resume,
      refresh,
      hasRole,
      clearSession,
      request,
      get: (path, opts) => request('GET', path, opts),
      post: (path, body, opts) => request('POST', path, Object.assign({ body }, opts)),
      put: (path, body, opts) => request('PUT', path, Object.assign({ body }, opts)),
      patch: (path, body, opts) => request('PATCH', path, Object.assign({ body }, opts)),
      del: (path, opts) => request('DELETE', path, opts),
      createRealtime,
    };
  }

  return { createClient, ApiError, NetworkError, uuid, shouldRetry };
}));
