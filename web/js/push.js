/**
 * EV2 — notificaciones al teléfono (D90).
 *
 * Cada pantalla, al entrar, llama `EV2Push.start({ api, box })`; al salir,
 * `EV2Push.forget(api)` ANTES de cerrar la sesión. Lo demás vive aquí:
 *
 *   * el recuadro "Activar notificaciones" — el permiso solo se puede pedir con un
 *     toque, así que no se pide solo al abrir;
 *   * la guía del iPhone: Safari solo da notificaciones a la app agregada a la
 *     pantalla de inicio (iOS 16.4 o más nuevo);
 *   * con el permiso ya dado, el teléfono se vuelve a registrar solo en cada entrada
 *     (si las llaves cambiaron o el navegador renovó la suscripción, se arregla aquí);
 *   * con la app abierta, nuestro sonido y la vibración — con la app cerrada suena el
 *     del teléfono: el navegador no deja escoger otro.
 *
 * Lo que decide QUÉ se avisa y a QUIÉN está en el servidor (services/push.js).
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EV2Push = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------------------------------------------------------------- lo que se decide sin DOM

  /** La llave pública VAPID viene en base64url; el navegador la quiere en bytes. */
  function keyBytes(base64url) {
    const padded = String(base64url || '').replace(/-/g, '+').replace(/_/g, '/')
      + '='.repeat((4 - (String(base64url || '').length % 4)) % 4);
    const raw = typeof atob === 'function' ? atob(padded) : Buffer.from(padded, 'base64').toString('binary');
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
    return out;
  }

  /** ¿Es un iPhone o iPad? (los iPad nuevos dicen ser Mac, pero tienen pantalla táctil). */
  function isIos(env) {
    const ua = String((env && env.userAgent) || '');
    return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && Number(env && env.maxTouchPoints) > 1);
  }

  /**
   * Qué enseña el recuadro:
   *   'hidden'   nada que hacer (ya está activo, o el servidor no tiene notificaciones);
   *   'ios'      iPhone en Safari: primero hay que agregar la app a la pantalla de inicio;
   *   'offer'    se puede activar con un toque;
   *   'denied'   las bloqueó: se dice dónde se desbloquean;
   *   'unsupported' este navegador no las tiene.
   */
  function boxState({ serverEnabled, supported, ios, standalone, permission, subscribed, dismissed }) {
    if (!serverEnabled) return 'hidden';
    if (supported && permission === 'granted' && subscribed) return 'hidden';
    if (dismissed) return 'hidden';
    if (ios && !standalone) return 'ios';
    if (!supported) return 'unsupported';
    if (permission === 'denied') return 'denied';
    return 'offer';
  }

  // ---------------------------------------------------------------- el sonido

  // El sonido se arma con osciladores, no con un archivo: no hay nada que descargar y
  // suena igual sin señal. El navegador no deja sonar nada hasta el primer toque en la
  // página, así que el audio se "despierta" con ese toque.
  let audio = null;
  function wakeAudio() {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      if (!audio) audio = new Ctx();
      if (audio.state === 'suspended') audio.resume();
    } catch { /* sin audio: queda la vibración */ }
  }

  function chime() {
    try {
      if (!audio || audio.state !== 'running') return;
      const now = audio.currentTime;
      [[880, 0], [1320, 0.14]].forEach(([freq, at]) => {
        const osc = audio.createOscillator();
        const gain = audio.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, now + at);
        gain.gain.exponentialRampToValueAtTime(0.35, now + at + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + at + 0.32);
        osc.connect(gain).connect(audio.destination);
        osc.start(now + at);
        osc.stop(now + at + 0.34);
      });
    } catch { /* un navegador raro no debe romper la pantalla */ }
    try { if (navigator.vibrate) navigator.vibrate([200, 100, 200]); } catch { /* bloqueado */ }
  }

  // ---------------------------------------------------------------- el navegador

  const supported = () => typeof window !== 'undefined'
    && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

  const standalone = () => {
    try {
      return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
    } catch { return false; }
  };

  const fmt = () => (typeof window !== 'undefined' ? window.EV2Format : null);
  const t = (key) => (fmt() ? fmt().t(key) : key);
  const lang = () => (fmt() && fmt().getLanguage() === 'en' ? 'en' : 'es');

  const DISMISS_KEY = 'ev2.push.dismissed';
  const dismissedFor = (userId) => {
    try { return localStorage.getItem(DISMISS_KEY) === String(userId); } catch { return false; }
  };
  const dismiss = (userId) => { try { localStorage.setItem(DISMISS_KEY, String(userId)); } catch { /* privado */ } };

  /**
   * El service worker lo registra pwa.js al cargar; aquí se espera a que esté listo.
   * Con tope (D91): `ready` nunca termina si el registro falló, y entonces el botón se
   * quedaba apagado para siempre sin decir nada.
   */
  const READY_TIMEOUT_MS = 8000;
  async function registration() {
    if (!supported()) return null;
    try {
      return await Promise.race([
        navigator.serviceWorker.ready,
        new Promise((resolve) => { setTimeout(() => resolve(null), READY_TIMEOUT_MS); }),
      ]);
    } catch { return null; }
  }

  /**
   * Para la tarjeta del gerente (D91): deja ESTE teléfono registrado (pidiendo el
   * permiso si hace falta, con el toque que lo llamó) y manda uno de prueba.
   * Devuelve { ok, reason?, devices?, sent? }.
   */
  async function testHere(api) {
    let config = { enabled: false, public_key: null };
    try { config = await api.get('/push/config'); } catch { return { ok: false, reason: 'server' }; }
    if (!config.enabled) return { ok: false, reason: 'server_disabled' };
    if (!supported()) return { ok: false, reason: isIos(navigator) && !standalone() ? 'ios' : 'unsupported' };
    wakeAudio();
    const r = await activate(api, config.public_key);
    if (r !== 'granted') return { ok: false, reason: r };
    const sent = await api.post(`/nightclubs/${clubOf(api)}/push/test`, {});
    return { ok: sent.sent > 0, devices: sent.devices, sent: sent.sent, reason: sent.sent > 0 ? null : 'not_delivered' };
  }

  const clubOf = (api) => api.session.user && api.session.user.nightclub_id;

  async function sendToServer(api, subscription) {
    const json = subscription.toJSON();
    await api.post(`/nightclubs/${clubOf(api)}/push/subscriptions`, {
      endpoint: json.endpoint, keys: json.keys, lang: lang(),
    });
  }

  /** Pide el permiso (con el toque del usuario) y registra el teléfono. */
  async function activate(api, publicKey) {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') return permission;
    const reg = await registration();
    if (!reg) return 'unsupported';
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
    }
    await sendToServer(api, sub);
    return 'granted';
  }

  /**
   * Con el permiso ya dado: se asegura de que el servidor tenga ESTE teléfono a nombre de
   * quien entró (un teléfono compartido cambia de dueño aquí) y en su idioma.
   */
  async function sync(api, publicKey) {
    const reg = await registration();
    if (!reg) return false;
    let sub = await reg.pushManager.getSubscription();
    // Llaves del servidor nuevas: la suscripción vieja ya no sirve, se rehace.
    if (sub && sub.options && sub.options.applicationServerKey) {
      const actual = new Uint8Array(sub.options.applicationServerKey);
      const nueva = keyBytes(publicKey);
      if (actual.length !== nueva.length || actual.some((b, i) => b !== nueva[i])) {
        await sub.unsubscribe().catch(() => {});
        sub = null;
      }
    }
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
    await sendToServer(api, sub);
    return true;
  }

  // ---------------------------------------------------------------- el recuadro

  function render(box, state, { onActivate, onDismiss }) {
    if (!box) return;
    box.hidden = state === 'hidden';
    if (state === 'hidden') { box.innerHTML = ''; return; }
    const text = {
      offer: t('push.offer'), ios: t('push.ios'), denied: t('push.denied'), unsupported: t('push.unsupported'),
    }[state];
    box.className = 'mx-4 mt-3 rounded-xl px-3 py-2 flex items-center gap-3 card';
    box.innerHTML = `
      <i class="fa-solid fa-bell text-lg" style="color:var(--ev2-cyan)" aria-hidden="true"></i>
      <p class="text-sm flex-1 min-w-0"></p>
      ${state === 'offer' ? `<button type="button" data-push="on" class="ev2-button rounded-lg px-3 py-2 text-xs font-display flex-none"></button>` : ''}
      <button type="button" data-push="off" class="w-8 h-8 rounded-lg flex-none text-white/50" aria-label=""><i class="fa-solid fa-xmark"></i></button>`;
    box.querySelector('p').textContent = text;
    const on = box.querySelector('[data-push="on"]');
    if (on) { on.textContent = t('push.activate'); on.onclick = () => onActivate(on); }
    const off = box.querySelector('[data-push="off"]');
    off.setAttribute('aria-label', t('push.dismiss'));
    off.onclick = onDismiss;
  }

  let started = false;

  /**
   * Arranca todo para la persona que acaba de entrar. Nunca lanza: sin notificaciones
   * la pantalla funciona igual.
   */
  async function start({ api, box, toast }) {
    if (!api || !api.session || !api.session.user) return;
    const userId = api.session.user.id;
    const say = (msg, kind) => { if (typeof toast === 'function') toast(msg, kind); };

    if (!started && typeof window !== 'undefined') {
      started = true;
      // El primer toque despierta el audio; los avisos que llegan con la app abierta
      // los manda el service worker como mensaje y aquí suenan.
      window.addEventListener('pointerdown', wakeAudio, { passive: true });
      if (supported()) {
        navigator.serviceWorker.addEventListener('message', (ev) => {
          if (ev.data && ev.data.type === 'ev2-push') ringOnce(ev.data.payload && ev.data.payload.tag);
        });
      }
    }

    let config = { enabled: false, public_key: null };
    try { config = await api.get('/push/config'); } catch { /* sin servidor: no se ofrece */ }

    const env = typeof navigator !== 'undefined' ? navigator : {};
    const permission = supported() ? Notification.permission : 'default';
    let subscribed = false;
    if (config.enabled && supported() && permission === 'granted') {
      try { subscribed = await sync(api, config.public_key); } catch { subscribed = false; }
    }

    const paint = () => render(box, boxState({
      serverEnabled: config.enabled, supported: supported(), ios: isIos(env), standalone: standalone(),
      permission: supported() ? Notification.permission : 'default', subscribed, dismissed: dismissedFor(userId),
    }), {
      async onActivate(button) {
        button.disabled = true;
        wakeAudio();
        try {
          const r = await activate(api, config.public_key);
          subscribed = r === 'granted';
          if (subscribed) {
            say(t('push.on'), 'ok');
            // Uno de prueba, para que se escuche y se vea cómo llegan.
            api.post(`/nightclubs/${clubOf(api)}/push/test`, {}).catch(() => {});
          } else if (r === 'denied') {
            say(t('push.denied'), 'error');
          }
        } catch {
          say(t('push.failed'), 'error');
        } finally {
          button.disabled = false;
          paint();
        }
      },
      onDismiss() { dismiss(userId); paint(); },
    });
    paint();
  }

  /**
   * Al salir: este teléfono deja de ser de esta persona. Va ANTES de cerrar la sesión
   * (después ya no hay con qué avisarle al servidor). Nunca lanza.
   */
  async function forget(api) {
    try {
      const reg = await registration();
      const sub = reg && await reg.pushManager.getSubscription();
      if (!sub) return;
      await api.request('DELETE', `/nightclubs/${clubOf(api)}/push/subscriptions`,
        { body: { endpoint: sub.endpoint } });
      await sub.unsubscribe();
    } catch { /* salir siempre funciona, con o sin notificaciones */ }
  }

  // ---------------------------------------------------------------- avisos en vivo (D93)

  // El mismo aviso puede llegar dos veces casi juntas: por la conexión en vivo y por la
  // notificación del teléfono. Suena una sola vez por aviso.
  const recientes = new Map();
  const DEDUPE_MS = 5000;
  function firstTime(tag, now = Date.now()) {
    for (const [k, at] of recientes) if (now - at > DEDUPE_MS) recientes.delete(k);
    if (!tag) return true;
    if (recientes.has(tag)) return false;
    recientes.set(tag, now);
    return true;
  }
  function ringOnce(tag) { if (firstTime(tag)) chime(); }

  /** El texto del aviso en el idioma de la pantalla. */
  function noticeText(payload, language) {
    const p = payload || {};
    const t = (language === 'en' && p.en) || p.es || p.en || {};
    return { title: t.title || '', body: t.body || '' };
  }

  /**
   * Cada pantalla, al abrir su conexión en vivo, llama `EV2Push.listen(rt, { toast })`.
   * Con la pantalla a la vista, cada aviso suena, vibra y sale arriba — aunque este
   * teléfono no haya activado las notificaciones del sistema. Con la pantalla
   * escondida no hace nada: para eso está la notificación del teléfono.
   */
  function listen(rt, { toast } = {}) {
    if (!rt || typeof rt.on !== 'function') return;
    rt.on('notice', (payload) => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      const text = noticeText(payload, lang());
      if (!firstTime(payload && payload.tag)) return;
      chime();
      if (typeof toast === 'function' && text.title) toast(`${text.title} · ${text.body}`, 'ok');
    });
  }

  return { keyBytes, isIos, boxState, start, forget, chime, testHere, listen, noticeText, firstTime };
}));
