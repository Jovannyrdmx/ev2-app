/**
 * EV2 — registro del service worker (paso 5.8).
 *
 * Se registra sin bloquear nada: si el navegador no lo soporta, o la página se abre por
 * file:// o sin HTTPS, la app funciona igual. Nunca se le pide al usuario que haga algo
 * por esto.
 */
(function () {
  'use strict';
  if (!('serviceWorker' in navigator)) return;
  // Un service worker solo corre en https o en localhost; en otro caso ni se intenta.
  const secure = window.isSecureContext
    || ['localhost', '127.0.0.1'].includes(window.location.hostname);
  if (!secure) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {
      // Sin service worker la app pierde la apertura sin señal, nada más.
    });
  });
}());
