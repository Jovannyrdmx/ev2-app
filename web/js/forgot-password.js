/**
 * EV2 — "¿Olvidaste tu contraseña?" en la pantalla de acceso (D131).
 *
 * Nueve pantallas tienen un formulario de correo y contraseña (`#form-login`): la del
 * cliente y las ocho del personal. En todas hace falta el mismo enlace, que hace lo
 * mismo: toma el correo que la persona YA escribió en el formulario, le pide al servidor
 * que mande el enlace de restablecimiento, y enseña el mismo mensaje haya o no cuenta
 * (el servidor tampoco lo distingue; ver `services/password-reset.js`).
 *
 * Por eso vive aquí y no repetido nueve veces: se carga con un `<script>` después de
 * `format.js`, encuentra el formulario y se monta solo. Si una pantalla no tiene
 * `#form-login` o `#login-email`, no hace nada.
 *
 * No usa `api.js` a propósito: la petición no lleva sesión, no se reintenta y no debe
 * disparar los avisos de "sesión caducada" del cliente de la pantalla.
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EV2ForgotPassword = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const PATH = '/auth/password/forgot';
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  /** Qué clave de texto corresponde a cada respuesta del servidor. */
  function messageKeyFor(status) {
    if (status === 202) return 'forgot.sent';
    if (status === 429) return 'forgot.tooMany';
    if (status === 501) return 'forgot.unavailable';
    if (status === 400) return 'forgot.needEmail';
    return 'error.unknown';
  }

  /** El correo que hay en el formulario, limpio, o null si no sirve. */
  function emailFrom(input) {
    const value = input && typeof input.value === 'string' ? input.value.trim().toLowerCase() : '';
    return EMAIL_RE.test(value) ? value : null;
  }

  /**
   * Pedir el enlace. Devuelve `{ status, key }`; nunca lanza (un fallo de red cuenta
   * como error genérico, que es lo que la persona puede entender).
   */
  async function request({ fetch: doFetch, apiBase, clubSlug, email }) {
    try {
      const res = await doFetch(`${apiBase}${PATH}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ nightclub_slug: clubSlug, email }),
      });
      return { status: res.status, key: messageKeyFor(res.status) };
    } catch {
      return { status: 0, key: 'error.unknown' };
    }
  }

  /**
   * Montar el enlace dentro de un formulario de acceso. Devuelve los elementos creados
   * (o null si falta algo), para que la prueba y la pantalla puedan mirarlos.
   */
  function mount({
    form, emailInput, apiBase, clubSlug, t, fetch: doFetch, document: doc,
  }) {
    if (!form || !emailInput || typeof doFetch !== 'function') return null;
    const d = doc || form.ownerDocument;
    const tr = typeof t === 'function' ? t : (k) => k;

    const wrap = d.createElement('div');
    wrap.className = 'text-center pt-1';
    wrap.setAttribute('data-forgot-password', '');

    const link = d.createElement('button');
    link.type = 'button';
    link.id = 'forgot-password';
    link.className = 'text-sm text-white/60 underline tap';
    link.setAttribute('data-i18n', 'forgot.link');
    link.textContent = tr('forgot.link');

    const message = d.createElement('p');
    message.id = 'forgot-message';
    message.className = 'mt-2 text-sm text-white/70';
    message.setAttribute('role', 'status');
    message.hidden = true;

    wrap.appendChild(link);
    wrap.appendChild(message);
    form.appendChild(wrap);

    const say = (key, tone) => {
      message.textContent = tr(key);
      message.className = `mt-2 text-sm ${tone === 'error' ? 'text-red-300' : 'text-white/70'}`;
      message.hidden = false;
    };

    let busy = false;
    link.addEventListener('click', async () => {
      if (busy) return;
      const email = emailFrom(emailInput);
      if (!email) {
        say('forgot.needEmail', 'error');
        try { emailInput.focus(); } catch { /* sin foco en pruebas */ }
        return;
      }
      busy = true;
      link.disabled = true;
      say('forgot.sending');
      const { status, key } = await request({ fetch: doFetch, apiBase, clubSlug, email });
      say(key, status === 202 ? 'ok' : 'error');
      busy = false;
      link.disabled = false;
    });

    return { link, message, wrap };
  }

  /** Se monta solo en el navegador, con lo que la página ya tiene. */
  function autoMount(g) {
    const d = g && g.document;
    if (!d || typeof g.fetch !== 'function') return null;
    const meta = (name, fallback) => {
      const el = d.querySelector(`meta[name="${name}"]`);
      return (el && el.content) || fallback;
    };
    const form = d.getElementById('form-login');
    const emailInput = d.getElementById('login-email');
    const F = g.EV2Format;
    return mount({
      form,
      emailInput,
      apiBase: meta('ev2:api', '/api'),
      clubSlug: meta('ev2:club', 'ev2'),
      t: F && F.t ? F.t : null,
      fetch: g.fetch.bind(g),
      document: d,
    });
  }

  if (typeof window !== 'undefined' && window.document) {
    const start = () => autoMount(window);
    if (window.document.readyState === 'loading') {
      window.document.addEventListener('DOMContentLoaded', start, { once: true });
    } else {
      start();
    }
  }

  return { PATH, messageKeyFor, emailFrom, request, mount, autoMount };
}));
