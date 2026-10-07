/**
 * EV2 — registro del service worker (paso 5.8) y la versión nueva sola (D91).
 *
 * Se registra sin bloquear nada: si el navegador no lo soporta, o la página se abre por
 * file:// o sin HTTPS, la app funciona igual. Nunca se le pide al usuario que haga algo
 * por esto.
 *
 * La versión nueva: un teléfono con la app abierta desde antes del despliegue seguía con
 * el código viejo hasta que alguien la cerraba del todo. Ahora busca versión cada cinco
 * minutos y al volver a la app; cuando el service worker nuevo toma el control, la página
 * se recarga sola — pero NUNCA a media acción: con una hoja abierta o escribiendo, sale
 * un botón "Actualizar" y la recarga espera.
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else {
    root.EV2Pwa = api;
    api.boot();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const CHECK_EVERY_MS = 5 * 60 * 1000;

  /**
   * ¿Hay alguien a media acción? Una hoja o un cuadro abierto (todos son `fixed
   * inset-0` o `role="dialog"`), o el cursor en un campo con algo escrito. Recargar ahí
   * borra un pedido armado o un cobro a medias.
   */
  function isBusy(doc) {
    const d = doc || (typeof document !== 'undefined' ? document : null);
    if (!d) return false;
    const view = d.defaultView;
    const visible = (el) => !el.hidden && !el.closest('[hidden]')
      && !(view && view.getComputedStyle && view.getComputedStyle(el).display === 'none');
    const overlays = [...d.querySelectorAll('.fixed.inset-0, [role="dialog"], dialog[open]')];
    if (overlays.some(visible)) return true;
    const active = d.activeElement;
    if (active && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName) && String(active.value || '').trim() !== '') return true;
    return false;
  }

  function label() {
    const F = typeof window !== 'undefined' && window.EV2Format;
    return F ? F.t('pwa.update') : 'Actualizar';
  }

  /** El botón para cuando no se puede recargar solo. */
  function offerButton(onClick) {
    if (document.getElementById('ev2-update')) return;
    const b = document.createElement('button');
    b.id = 'ev2-update';
    b.type = 'button';
    b.className = 'fixed top-3 left-1/2 -translate-x-1/2 z-[60] whitespace-nowrap ev2-button rounded-full px-4 py-2 text-xs font-display shadow-lg';
    b.innerHTML = '<i class="fa-solid fa-rotate mr-2" aria-hidden="true"></i><span></span>';
    b.querySelector('span').textContent = label();
    b.onclick = onClick;
    document.body.appendChild(b);
  }

  function boot() {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
    // Un service worker solo corre en https o en localhost; en otro caso ni se intenta.
    const secure = window.isSecureContext
      || ['localhost', '127.0.0.1'].includes(window.location.hostname);
    if (!secure) return;

    // Si la página ya tenía service worker al abrir, un cambio de control es una versión
    // nueva. Si no lo tenía, es la primera instalación: no hay nada que recargar.
    const hadController = Boolean(navigator.serviceWorker.controller);
    let reloading = false;
    let waitTimer = null;
    const reload = () => {
      if (reloading) return;
      reloading = true;
      window.location.reload();
    };
    const reloadWhenFree = () => {
      if (!isBusy()) { reload(); return; }
      offerButton(reload);
      // En cuanto se cierre la hoja o se termine de escribir, se recarga sola.
      clearInterval(waitTimer);
      waitTimer = setInterval(() => { if (!isBusy()) { clearInterval(waitTimer); reload(); } }, 5000);
    };

    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (hadController) reloadWhenFree();
    });

    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').then((reg) => {
        const check = () => { reg.update().catch(() => { /* sin señal: la siguiente vez */ }); };
        setInterval(check, CHECK_EVERY_MS);
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible') check();
        });
        window.addEventListener('online', check);
      }).catch(() => {
        // Sin service worker la app pierde la apertura sin señal, nada más.
      });
    });
  }

  return { isBusy, boot, CHECK_EVERY_MS };
}));
