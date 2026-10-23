/**
 * EV2 — Pantalla de contraseña nueva (`restablecer.html`, D127).
 *
 * Llega aquí quien tocó el enlace del correo de "¿Olvidaste tu contraseña?". El flujo:
 *   1. Leer la clave del fragmento (#token=...). Sin clave no hay nada que hacer.
 *   2. Preguntarle al servidor si sigue vigente ANTES de pedir nada: a quien llegó
 *      tarde se le dice de una vez, no después de teclear dos veces la contraseña.
 *   3. Pedir la contraseña nueva dos veces, guardarla, y mandar a entrar.
 *
 * La lógica pura (leer la clave del fragmento, validar las dos contraseñas) está
 * expuesta en `EV2ResetScreen` para probarse en Node sin navegador; el resto es DOM.
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EV2ResetScreen = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MIN_LENGTH = 8;

  /** `#token=abc` o `#token=abc&x=y` → 'abc'. Vacío si no viene. */
  function tokenFromHash(hash) {
    const h = String(hash || '');
    if (!h.startsWith('#')) return '';
    const params = new URLSearchParams(h.slice(1));
    return (params.get('token') || '').trim();
  }

  /** Qué está mal con el par de contraseñas, como clave de texto, o null si sirven. */
  function validate(password, repeat) {
    if (!password || password.length < MIN_LENGTH) return 'reset.errShort';
    if (password !== repeat) return 'reset.errMismatch';
    return null;
  }

  /** Qué clave de texto corresponde a la respuesta de `reset`. */
  function errorKeyFor(status) {
    if (status === 401 || status === 410) return 'reset.invalidNote';
    if (status === 400) return 'reset.errShort';
    if (status === 429) return 'forgot.tooMany';
    if (status === 0) return 'error.network';
    return 'error.unknown';
  }

  function boot(g) {
    const d = g.document;
    const $ = (id) => d.getElementById(id);
    const F = g.EV2Format;
    const t = (key, vars) => (vars ? F.tf(key, vars) : F.t(key));
    const metaEl = d.querySelector('meta[name="ev2:api"]');
    const API = (metaEl && metaEl.content) || '/api';

    F.setLanguage(F.getLanguage());
    F.applyTo(d);

    const show = (which) => {
      for (const id of ['reset-checking', 'reset-form', 'reset-invalid', 'reset-done']) {
        $(id).hidden = id !== which;
      }
    };
    const error = (message) => {
      $('reset-error').textContent = message || '';
      $('reset-error').hidden = !message;
    };

    const token = tokenFromHash(g.location.hash);
    if (!token) {
      $('reset-invalid-note').textContent = t('reset.noToken');
      show('reset-invalid');
      return;
    }

    const post = async (path, body) => {
      try {
        const res = await g.fetch(`${API}${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify(body),
        });
        let data = null;
        try { data = await res.json(); } catch { /* sin cuerpo */ }
        return { status: res.status, data };
      } catch {
        return { status: 0, data: null };
      }
    };

    (async () => {
      const { status, data } = await post('/auth/password/reset/check', { token });
      if (status === 200 && data && data.valid) {
        $('reset-for').textContent = data.email_masked ? t('reset.for', { email: data.email_masked }) : '';
        show('reset-form');
        try { $('reset-password').focus(); } catch { /* sin foco */ }
        return;
      }
      if (status === 0) {
        $('reset-invalid-note').textContent = t('error.network');
      }
      show('reset-invalid');
    })();

    $('reset-form').onsubmit = async (ev) => {
      ev.preventDefault();
      const password = $('reset-password').value;
      const repeat = $('reset-repeat').value;
      const problem = validate(password, repeat);
      if (problem) { error(t(problem)); return; }
      error('');
      const btn = $('btn-reset');
      btn.disabled = true;
      btn.textContent = t('reset.saving');
      const { status } = await post('/auth/password/reset', { token, new_password: password });
      if (status === 200) { show('reset-done'); return; }
      btn.disabled = false;
      btn.textContent = t('reset.save');
      if (status === 401 || status === 410) { show('reset-invalid'); return; }
      error(t(errorKeyFor(status)));
    };
  }

  if (typeof window !== 'undefined' && window.document && window.document.getElementById('reset-form')) {
    boot(window);
  }

  return { MIN_LENGTH, tokenFromHash, validate, errorKeyFor, boot };
}));
