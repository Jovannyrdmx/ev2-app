/**
 * EV2 — la página pública que comprueba una constancia de salida.
 *
 * La abre alguien que tiene el folio en la mano y ninguna cuenta: un policía en la
 * calle, un familiar, el propio cliente desde un teléfono prestado. Por eso NO usa
 * `EV2.createClient` —ese cliente arrastra sesión, refresco de token y reintentos que
 * aquí no sirven de nada— sino un `fetch` pelón contra la ruta pública.
 *
 * Las decisiones (qué filas se enseñan, si sigue vigente, cómo se limpia lo tecleado)
 * viven en `EV2Taxi`, que sí se prueba. Aquí solo hay DOM.
 */
/* global EV2Format, EV2Taxi */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const meta = (name, fallback) => {
    const el = document.querySelector(`meta[name="${name}"]`);
    return (el && el.content) || fallback;
  };
  const API = meta('ev2:api', '/api');

  const t = (key, vars) => (vars ? EV2Format.tf(key, vars) : EV2Format.t(key));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function error(message) {
    $('verify-error').textContent = message || '';
    $('verify-error').hidden = !message;
    if (message) $('verify-result').hidden = true;
  }

  function render(cert) {
    const view = EV2Taxi.certificateView(cert);
    if (!view) { error(t('verify.notFound')); return; }

    // Lo primero y más grande: si vale o no. Quien la mira decide con eso.
    const state = $('verify-state');
    state.textContent = view.valid ? t('verify.valid') : t('verify.expired');
    state.style.color = view.valid ? 'var(--ev2-lime)' : '#fca5a5';

    $('verify-club').textContent = view.nightclub || '';
    $('verify-folio-out').textContent = view.folio;

    const rows = $('verify-rows');
    rows.innerHTML = view.rows.map((row) => `
      <div class="flex justify-between gap-3 py-2 text-sm">
        <dt class="text-white/50">${esc(t(row.labelKey))}</dt>
        <dd class="text-right">${esc(row.value)}</dd>
      </div>`).join('');

    $('verify-issued').textContent = view.issuedAt
      ? t('cert.issuedAt', { when: EV2Format.dateTime(view.issuedAt) }) : '';
    $('verify-expires').textContent = view.expiresAt
      ? t(view.expired ? 'cert.expiredAt' : 'cert.expiresAt',
        { when: EV2Format.dateTime(view.expiresAt) }) : '';
    $('verify-disclaimer').textContent = view.disclaimer || '';

    error('');
    $('verify-result').hidden = false;
  }

  async function check(text) {
    const folio = EV2Taxi.normalizeFolio(text);
    if (!EV2Taxi.folioLooksUsable(folio)) { error(t('verify.errFolio')); return; }

    $('btn-verify').disabled = true;
    try {
      const res = await fetch(`${API}/taxi/verify/${encodeURIComponent(folio)}`, {
        headers: { Accept: 'application/json' },
      });
      if (res.status === 404) { error(t('verify.notFound')); return; }
      // 429: la ruta pública tiene límite de intentos, justamente para que nadie pruebe
      // folios al azar. Decirlo con claridad evita que la persona insista y se bloquee.
      if (res.status === 429) { error(t('verify.errTooMany')); return; }
      if (!res.ok) { error(t('error.unknown')); return; }
      const data = await res.json();
      render(data.certificate);
    } catch {
      error(t('error.network'));
    } finally {
      $('btn-verify').disabled = false;
    }
  }

  $('verify-form').onsubmit = (ev) => {
    ev.preventDefault();
    check($('verify-folio').value);
  };

  // Se teclea de un papel: se normaliza mientras se escribe para que lo que se ve sea
  // lo que se va a mandar, sin sorpresas al tocar el botón.
  $('verify-folio').oninput = (ev) => {
    const input = ev.currentTarget;
    const clean = EV2Taxi.normalizeFolio(input.value);
    if (clean !== input.value) input.value = clean;
  };

  (function boot() {
    EV2Format.setLanguage(EV2Format.getLanguage());
    EV2Format.applyTo(document);
    // Un enlace o un QR pueden traer el folio ya puesto: ?folio=EV2-XXXX. Entonces se
    // comprueba solo, que es lo que espera quien escaneó el código.
    const fromUrl = new URLSearchParams(window.location.search).get('folio');
    if (fromUrl) {
      $('verify-folio').value = EV2Taxi.normalizeFolio(fromUrl);
      check(fromUrl);
    }
  }());
}());
