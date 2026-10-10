/**
 * EV2 — entrar con una cuenta de otro: la parte que se puede probar sin navegador.
 *
 * El viaje de OAuth termina con la persona **rebotada** a esta página con algo en el
 * fragmento de la dirección (`#...`). Decidir qué hacer con eso es lo que vive aquí:
 * puro, sin DOM y sin red, para que las reglas que importan se prueben de verdad.
 *
 * ---------------------------------------------------------------------------
 * Por qué el fragmento se borra antes de usarse
 * ---------------------------------------------------------------------------
 * Lo que vuelve en `#h=` es un pase que abre una sesión. El fragmento no viaja al
 * servidor, pero SÍ se queda en el historial del navegador, y en el teléfono de un
 * cliente —prestado, compartido, o simplemente con la pestaña abierta— eso sería su
 * cuenta al alcance del siguiente. Así que `takeFromLocation()` lo lee y lo borra
 * del historial en la misma operación, antes de mandarlo a canjear.
 *
 * El pase también es de un solo uso del lado del servidor. Son dos capas para lo
 * mismo a propósito: una sola cede en cuanto alguien recarga la página.
 */
/* global module */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.EV2Social = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /**
   * Los proveedores, con su cara. Solo se pinta el que el servidor reporte
   * encendido: un botón que no funciona es peor que no tener botón.
   */
  const LOOKS = {
    facebook: { icon: 'fa-brands fa-facebook-f', color: '#1877F2' },
    instagram: { icon: 'fa-brands fa-instagram', color: '#E1306C' },
    google: { icon: 'fa-brands fa-google', color: '#EA4335' },
    apple: { icon: 'fa-brands fa-apple', color: '#FFFFFF' },
  };

  function look(provider) {
    return LOOKS[provider] || { icon: 'fa-solid fa-right-to-bracket', color: '#94A3B8' };
  }

  /**
   * Lo que el servidor puede contestar cuando algo sale mal, y su clave de texto.
   *
   * Cada uno dice qué hacer, no solo qué pasó: "cancelaste" no necesita disculpa, y
   * "ese correo ya tiene cuenta" tiene que explicar el único camino que hay (entrar
   * con contraseña y ligar Facebook desde el perfil), porque si no la persona vuelve
   * a intentar lo mismo tres veces y se va.
   */
  const ERROR_KEYS = {
    cancelled: 'social.errCancelled',
    provider: 'social.errProvider',
    provider_unavailable: 'social.errUnavailable',
    missing_code: 'social.errProvider',
    expired_state: 'social.errExpired',
    email_taken: 'social.errEmailTaken',
    already_linked: 'social.errAlreadyLinked',
    account_inactive: 'social.errInactive',
  };

  function errorKey(code) {
    return ERROR_KEYS[String(code || '')] || 'social.errProvider';
  }

  /**
   * Qué trae el fragmento. Uno solo, el primero que aparezca de los que entendemos.
   *
   * @returns {{kind:'session'|'signup'|'linked'|'error', value:string}|null}
   */
  function readHash(hash) {
    const crudo = String(hash || '').replace(/^#/, '');
    if (!crudo) return null;
    const p = new URLSearchParams(crudo);
    if (p.get('h')) return { kind: 'session', value: p.get('h') };
    if (p.get('oauth_signup')) return { kind: 'signup', value: p.get('oauth_signup') };
    if (p.get('oauth_linked')) return { kind: 'linked', value: p.get('oauth_linked') };
    if (p.get('oauth_error')) return { kind: 'error', value: p.get('oauth_error') };
    return null;
  }

  /**
   * Lee el fragmento y lo BORRA del historial en la misma operación.
   *
   * `replaceState` en vez de cambiar `location.hash`: cambiar el hash añade una
   * entrada nueva al historial (y deja la vieja, con el pase, justo detrás del botón
   * de atrás). `replaceState` reemplaza la entrada actual, así que no queda rastro.
   *
   * Si el navegador no tiene `history.replaceState` —no debería pasar, pero la
   * pantalla de acceso tiene que funcionar igual— se cae a vaciar el hash: es peor
   * que nada en el historial, y mucho mejor que dejar el pase a la vista.
   */
  function takeFromLocation(loc, history) {
    const leido = readHash(loc && loc.hash);
    if (!leido) return null;
    const limpia = String(loc.pathname || '') + String(loc.search || '');
    try {
      if (history && typeof history.replaceState === 'function') {
        history.replaceState(null, '', limpia || ' ');
      } else if (loc && 'hash' in loc) {
        loc.hash = '';
      }
    } catch { /* si el navegador no deja tocar el historial, seguimos igual */ }
    return leido;
  }

  /**
   * La dirección que arranca el viaje.
   *
   * Es un enlace de navegación completa, no una llamada con `fetch`: la respuesta es
   * un 302 hacia Facebook, y un `fetch` lo seguiría en segundo plano en vez de
   * llevarse a la persona. Por eso el botón cambia `location`, y por eso la ruta del
   * servidor contesta 302 y no un JSON.
   */
  function startUrl({ baseUrl = '/api', provider, clubSlug, redirectTo = 'index.html' }) {
    const base = String(baseUrl).replace(/\/+$/, '');
    const q = new URLSearchParams({ nightclub_slug: clubSlug, redirect_to: redirectTo });
    return `${base}/auth/oauth/${encodeURIComponent(provider)}/start?${q.toString()}`;
  }

  /** Los que de verdad se pueden pintar, en el orden en que vinieron. */
  function enabledProviders(status) {
    const lista = (status && status.providers) || [];
    return lista.filter((p) => p && p.enabled).map((p) => ({
      provider: p.provider, label: p.label, ...look(p.provider),
    }));
  }

  /**
   * ¿Se puede quitar esta cuenta social sin dejar a la persona fuera?
   *
   * La misma regla que el servidor, repetida aquí para no OFRECER un botón que va a
   * fallar. El servidor sigue siendo el que decide: esto es cortesía, no seguridad.
   */
  function canUnlink({ has_password: tienePassword, identities }) {
    const cuantas = (identities || []).length;
    return Boolean(tienePassword) || cuantas > 1;
  }

  /**
   * Lo que falta por preguntar para terminar un registro social.
   *
   * La fecha de nacimiento y los términos SIEMPRE: de la primera depende dejar entrar
   * a alguien a un negocio de alcohol, y Facebook no la da de forma fiable. El correo
   * solo si el proveedor no lo dio (el cliente puede negar ese permiso).
   */
  function signupNeeds(token, decode) {
    const datos = (typeof decode === 'function' ? decode(token) : null) || {};
    return {
      email: !datos.email,
      birth_date: true,
      accept_terms: true,
      suggested_email: datos.email || '',
      provider: datos.provider || null,
    };
  }

  /**
   * Lee el token de completar SIN verificarlo, solo para rellenar la pantalla.
   *
   * Es una firma que este navegador no puede comprobar, así que lo que salga de aquí
   * no decide nada: solo escribe el correo sugerido en su campo. Quien decide es el
   * servidor, que sí verifica la firma en `/auth/oauth/complete`.
   */
  function peekToken(token) {
    try {
      const cuerpo = String(token).split('.')[1];
      if (!cuerpo) return null;
      // base64url a base64, con el relleno que `atob` sí exige.
      const base64 = cuerpo.replace(/-/g, '+').replace(/_/g, '/')
        .padEnd(cuerpo.length + ((4 - (cuerpo.length % 4)) % 4), '=');
      const json = typeof atob === 'function'
        // Los acentos vienen en UTF-8: `atob` devuelve bytes, así que se pasan por
        // `decodeURIComponent` en vez de leerlos como si fueran letras.
        ? decodeURIComponent(Array.prototype.map.call(atob(base64),
          (c) => `%${`00${c.charCodeAt(0).toString(16)}`.slice(-2)}`).join(''))
        : Buffer.from(base64, 'base64').toString('utf8');
      const datos = JSON.parse(json);
      return { email: datos.email || null, provider: datos.provider || null };
    } catch {
      return null;
    }
  }

  return {
    LOOKS,
    ERROR_KEYS,
    look,
    errorKey,
    readHash,
    takeFromLocation,
    startUrl,
    enabledProviders,
    canUnlink,
    signupNeeds,
    peekToken,
  };
}));
