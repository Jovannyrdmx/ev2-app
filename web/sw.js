/**
 * EV2 — service worker (paso 5.8).
 *
 * Su trabajo es UNO: que la app abra aunque la señal del club sea mala. La cáscara
 * (HTML, CSS, JS) se guarda; los datos NO.
 *
 * Guardar respuestas de la API sería mentir: un plano de mesas de hace media hora dice
 * que hay lugar donde ya no lo hay, y un pedido "listo" que ya se entregó manda al
 * mesero a la barra por nada. Todo lo que va a /api pasa siempre por la red, y si no
 * hay red, falla — que es la verdad.
 */
'use strict';

// Se sube en CADA despliegue que cambie la cascara. La busqueda va por red primero,
// asi que un despliegue se ve sin tocar esto; subirla es lo que TIRA la copia vieja en
// vez de dejarla ahi ocupando espacio y sirviendo de respaldo a una version que ya no
// existe.
const VERSION = 'ev2-v51';
const SHELL = [
  'index.html', 'bartender.html', 'driver.html', 'manager.html', 'staff.html',
  'valet.html', 'employee-portal.html', 'almacen.html', 'manifest.json',
  // La página pública de verificación: la abre alguien SIN cuenta, en la calle,
  // posiblemente con mala señal. Es justo donde una caché sirve.
  'verificar.html', 'js/verify-screen.js',
  // El aviso de privacidad y los terminos: los abre gente sin cuenta, y el enlace de
  // eliminacion de datos que esta dado de alta en el panel de Meta apunta aqui. Una de
  // las dos paginas en blanco por falta de senal es una revision de Meta reprobada.
  'privacidad.html', 'terminos.html',
  'js/api.js', 'js/format.js', 'js/roles.js', 'js/password-gate.js', 'js/client.js',
  'js/floor-map.js', 'js/index-screen.js', 'js/bar-queue.js', 'js/bartender-screen.js',
  'js/taxi-ride.js', 'js/driver-screen.js', 'js/manager.js', 'js/manager-screen.js',
  'js/staff-floor.js', 'js/staff-screen.js', 'js/valet-tickets.js', 'js/valet-screen.js',
  'js/earnings.js', 'js/employee-screen.js', 'js/pwa.js',
  // Faltaban: sin ellos, la app abría sin señal pero las pestañas de propinas, música,
  // reservación, personal, pagos, turno, puerta y conecta se quedaban en blanco.
  'js/tipping.js', 'js/songs.js', 'js/booking.js', 'js/show-screen.js', 'js/booking-screen.js',
  'js/staff-admin.js', 'js/payouts.js', 'js/shift.js', 'js/door.js',
  'js/flirt.js', 'js/flirt-screen.js', 'js/lost-found-screen.js', 'js/account-delete.js', 'js/drink-art.js', 'js/order-taking.js',
  'js/door-scan.js',
  // El almacen se cuenta en una bodega, que es donde peor entra la senal de todo el
  // edificio: si esta pantalla no abre sin red, el conteo se hace en papel.
  'js/warehouse.js', 'js/warehouse-screen.js',
  // Faltaban cinco, de cuatro pasos distintos, y el efecto era el mismo en todos: la
  // pantalla abria sin senal y la pestana que dependia de ese archivo se quedaba en
  // blanco. El peor era el almacen: se cuenta en una bodega, que es donde peor entra
  // la senal del edificio. `tests/web-pwa.test.js` ahora compara esta lista contra los
  // <script> de cada pagina, para que no vuelva a quedarse atras en silencio.
  'js/receiving.js', 'js/receipt-review.js', 'js/roster.js', 'js/night-report.js',
  'js/social-login.js',
  // El teclado del PIN (D46). Es lo PRIMERO que toca el personal al llegar: si este
  // archivo no esta guardado, una mala senal en la puerta deja a todo el turno sin
  // poder entrar.
  'js/pin-pad.js',
  // El cuadro de la terminal (D47): si no esta guardado, el cobro con tarjeta se
  // queda sin pantalla justo cuando la senal falla, que es cuando mas se nota.
  'js/terminal-charge.js',
  // El corte del turno (D51): quien cobra lo abre al final de la noche, con el club
  // lleno y la senal peor que nunca. Sin el guardado, no puede ni ver cuanto entrega.
  'js/shift-cut.js',
  // La caja de cada barra (D77): el cajero abre, cobra y corta desde aquí toda la noche.
  'caja.html', 'js/cashier.js', 'js/cashier-screen.js', 'js/substitutions.js',
  'js/ui.js',
  // Las notificaciones (D90): el recuadro para activarlas y el sonido con la app abierta.
  'js/push.js',
  'checador.html', 'js/checador.js',
  'vendor/digitalpersona/websdk.client.ui.js', 'vendor/digitalpersona/dp.core.js',
  'vendor/digitalpersona/dp.devices.js',
  // La hoja de estilo, las letras y los iconos viven aquí mismo (D71): sin señal la app
  // abre con su diseño, no con los botones grises del navegador.
  'css/ev2.css',
  'fonts/inter-latin-400-normal.woff2', 'fonts/inter-latin-500-normal.woff2',
  'fonts/inter-latin-600-normal.woff2', 'fonts/inter-latin-700-normal.woff2',
  'fonts/poppins-latin-500-normal.woff2', 'fonts/poppins-latin-600-normal.woff2',
  'fonts/poppins-latin-700-normal.woff2',
  // El logo y los íconos (D92). Cada nombre tiene que existir: `cache.add` de un archivo
  // que no está falla en silencio, y así se quedó la app sin ícono una vez.
  'images/favicon-32x32.png', 'images/favicon-16x16.png', 'images/favicon.ico',
  'images/apple-touch-icon.png', 'images/icon-192.png', 'images/icon-512.png',
  'images/icon-maskable-512.png', 'images/ev2-clandestinoz.webp',
];

self.addEventListener('install', (event) => {
  // Un archivo que falte no debe impedir que el resto se guarde: se piden de uno en uno.
  event.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    await Promise.all(SHELL.map((url) => cache.add(url).catch(() => null)));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n !== VERSION).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  // Ni la API ni el socket se guardan nunca: ver datos viejos es peor que no verlos.
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws')) return;
  // Solo lo de este origen; el CDN se lo arregla el navegador.
  if (url.origin !== self.location.origin) return;

  event.respondWith((async () => {
    // Primero la red, para que un despliegue nuevo se vea sin borrar nada; el guardado
    // es la red de seguridad cuando no hay señal.
    try {
      const fresh = await fetch(request);
      if (fresh && fresh.ok) {
        const cache = await caches.open(VERSION);
        cache.put(request, fresh.clone());
      }
      return fresh;
    } catch (err) {
      const cached = await caches.match(request);
      if (cached) return cached;
      throw err;
    }
  })());
});

// ---------------------------------------------------------------- notificaciones (D90)
//
// El servidor manda { title, body, url, tag }. Se enseña SIEMPRE una notificación: iPhone
// le quita el permiso a la app que recibe un push sin enseñar nada. Si la app está
// abierta y a la vista, la notificación sale callada y la pantalla toca nuestro sonido
// (dos sonidos a la vez confunden más de lo que avisan).

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'EV2', body: event.data ? event.data.text() : '' };
  }
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const visible = windows.some((c) => c.visibilityState === 'visible' && c.focused);
    for (const c of windows) c.postMessage({ type: 'ev2-push', payload: data });
    const options = {
      body: data.body || '',
      icon: 'images/icon-192.png',
      badge: 'images/favicon-32x32.png',
      // Mismo tag = reemplaza al anterior en vez de apilar diez avisos del mismo pedido;
      // renotify hace que el reemplazo vuelva a sonar.
      tag: data.tag || undefined,
      renotify: Boolean(data.tag),
      silent: visible,
      data: { url: data.url || 'index.html' },
    };
    // Vibrar y callada a la vez es un error para el navegador (TypeError) y la
    // notificación no sale: la vibración va solo cuando suena.
    if (!visible) options.vibrate = [200, 100, 200];
    await self.registration.showNotification(data.title || 'EV2', options);
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL((event.notification.data && event.notification.data.url) || 'index.html', self.registration.scope);
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    // Si esa pantalla ya está abierta, se trae al frente en vez de abrir otra.
    const same = windows.find((c) => new URL(c.url).pathname === target.pathname);
    if (same) return same.focus();
    return self.clients.openWindow(target.href);
  })());
});
