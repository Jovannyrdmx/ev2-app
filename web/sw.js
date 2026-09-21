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
const VERSION = 'ev2-v11';
const SHELL = [
  'index.html', 'bartender.html', 'driver.html', 'manager.html', 'staff.html',
  'valet.html', 'employee-portal.html', 'almacen.html', 'manifest.json',
  // La página pública de verificación: la abre alguien SIN cuenta, en la calle,
  // posiblemente con mala señal. Es justo donde una caché sirve.
  'verificar.html', 'js/verify-screen.js',
  'js/api.js', 'js/format.js', 'js/roles.js', 'js/password-gate.js', 'js/client.js',
  'js/floor-map.js', 'js/index-screen.js', 'js/bar-queue.js', 'js/bartender-screen.js',
  'js/taxi-ride.js', 'js/driver-screen.js', 'js/manager.js', 'js/manager-screen.js',
  'js/staff-floor.js', 'js/staff-screen.js', 'js/valet-tickets.js', 'js/valet-screen.js',
  'js/earnings.js', 'js/employee-screen.js', 'js/pwa.js',
  // Faltaban: sin ellos, la app abría sin señal pero las pestañas de propinas, música,
  // reservación, personal, pagos, turno, puerta y conecta se quedaban en blanco.
  'js/tipping.js', 'js/songs.js', 'js/booking.js', 'js/show-screen.js', 'js/booking-screen.js',
  'js/staff-admin.js', 'js/payouts.js', 'js/shift.js', 'js/door.js',
  'js/flirt.js', 'js/flirt-screen.js', 'js/drink-art.js', 'js/order-taking.js',
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
  // El nombre del logo lleva la extension doble ('...svg.png') porque el archivo que
  // se puso es un PNG. Apuntar a 'ev2-logo.svg' -- que no existe -- dejaba la app sin
  // icono grande al agregarla a la pantalla de inicio, y el service worker fallaba al
  // guardarlo en silencio.
  'images/favicon-32x32.png', 'images/ev2-logo.svg.png',
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
