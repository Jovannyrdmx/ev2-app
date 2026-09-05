/**
 * EV2 — idioma y formato (paso 5.1).
 *
 * Dos cosas que se hacen mal muy fácil:
 *
 * 1. **El dinero llega como cadena decimal** (`"1500.00"`) porque un peso no cabe sin
 *    pérdida en un `number` de JavaScript en cuanto se hacen cuentas. Aquí se formatea
 *    sin convertir a float, y sumar importes se hace en centavos enteros.
 * 2. **Los ids de evento son enteros de 64 bits** y viajan como cadena. No los pases por
 *    `Number()`.
 */
(function (root, factory) {
  const lib = factory();
  if (typeof module === 'object' && module.exports) module.exports = lib;
  else root.EV2Format = lib;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const LOCALES = { es: 'es-MX', en: 'en-US' };

  const STRINGS = {
    es: {
      'error.network': 'Sin conexión. Revisa tu señal e intenta de nuevo.',
      'error.unauthorized': 'Tu sesión terminó. Vuelve a entrar.',
      // Un 401 al ENTRAR no es una sesión vencida: no había sesión. Decirle a alguien
      // que su sesión terminó cuando lo que pasó es que se equivocó de contraseña lo
      // manda a buscar el problema donde no está.
      'error.badLogin': 'Correo o contraseña incorrectos.',
      'error.forbidden': 'No tienes permiso para hacer esto.',
      'error.not_found': 'No encontramos eso.',
      'error.conflict': 'Alguien se adelantó. Vuelve a intentar.',
      'error.unprocessable': 'No se puede completar con esos datos.',
      'error.too_many_requests': 'Demasiados intentos. Espera un momento.',
      'error.not_implemented': 'Todavía no está disponible.',
      'error.unknown': 'Algo salió mal. Intenta de nuevo.',
      'realtime.reconnecting': 'Reconectando…',
      'realtime.resync': 'Actualizando la pantalla…',
      'realtime.replaced': 'Abriste la app en otro lado.',

      // --- acceso ---
      'auth.city': 'Nogales, Sonora',
      'auth.signin': 'Entrar',
      'auth.signup': 'Crear cuenta',
      'auth.email': 'Correo',
      'auth.password': 'Contraseña',
      'auth.enter': 'Entrar al club',
      'auth.firstName': 'Nombre',
      'auth.lastName': 'Apellido',
      'auth.newPassword': 'Contraseña (mínimo 8)',
      'auth.birthDate': 'Fecha de nacimiento',
      'auth.terms': 'Tengo 18 años o más y acepto los términos y el código de conducta.',
      'auth.flirts': 'Quiero recibir invitaciones de otras personas.',
      'auth.flirtsNote': 'Puedes cambiarlo cuando quieras.',
      'auth.create': 'Crear cuenta',
      'auth.adults': 'Solo +18 · EV2 Clandestinoz',

      // --- barra superior y navegación ---
      'nav.map': 'Mapa',
      'nav.menu': 'Menú',
      'nav.orders': 'Pedidos',
      'nav.profile': 'Perfil',
      'top.noTable': 'sin mesa',
      'top.table': 'mesa',
      'top.live': 'En vivo',
      'top.offline': 'Sin conexión',
      'top.otherSession': 'Otra sesión',
      'top.signOut': 'Salir',

      // --- plano ---
      'map.tables': 'Mesas',
      'map.free': 'Libres',
      'map.vip': 'VIP',
      'map.busy': 'Ocupadas',
      'map.hint': 'Toca tu mesa en el plano',
      'map.selected': 'Mesa seleccionada',
      'map.table': 'Mesa',
      'map.zone': 'Zona',
      'map.capacity': 'Capacidad',
      'map.type': 'Tipo',
      'map.sit': 'Sentarme aquí',
      'map.move': 'Cambiarme a esta mesa',
      'map.alreadyHere': 'Ya estás en esta mesa',
      'map.youAreHere': 'Aquí estás sentado.',
      'map.unavailable': 'No disponible',
      'map.full': 'Esta mesa ya está llena.',
      'map.leave': 'Dejar mi mesa',
      'map.seated': 'Listo, esa es tu mesa',
      'map.occupied': 'Ocupada',
      'map.mine': 'Tu mesa',
      'map.floorBaja': 'PLANTA BAJA',
      'map.floorAlta': 'PLANTA ALTA',
      'map.floorAmbas': 'TODO EL CLUB',

      // --- menú y pedidos ---
      'menu.all': 'Todo',
      'menu.soldOut': 'agotado',
      'menu.empty': 'No hay bebidas en esta categoría.',
      'menu.noStock': 'No hay más existencias de eso',
      'cart.order': 'Pedir',
      'orders.empty': 'Todavía no has pedido nada.',
      'orders.needTable': 'Primero elige tu mesa: el mesero necesita saber a dónde llevarlo',
      'orders.sent': 'Pedido enviado a la barra',
      'orders.ready': '¡Tu pedido está listo en la barra!',

      // --- perfil ---
      'profile.table': 'Mesa',
      'profile.club': 'Club',
      'profile.account': 'Cuenta',
      'profile.signOut': 'Cerrar sesión',

      // --- empleado sin pantalla ---
      'staff.signedInAs': 'Entraste como',
      'staff.pending': 'Esta pantalla todavía no está conectada al servidor. Se construye en el paso {step} del plan de implementación.',
      'staff.noScreen': 'Esta cuenta no tiene una pantalla asignada. Avisa al administrador del club.',

      // --- avisos ---
      'banner.replaced': 'Abriste la app en otro lado. Recarga si quieres seguir aquí.',
      'banner.expired': 'Tu sesión terminó. Vuelve a entrar.',
      'banner.updating': 'Actualizando…',

      // --- barra (paso 5.7) ---
      'bar.title': 'Barra',
      'bar.laneNew': 'Nuevos',
      'bar.lanePrep': 'En preparación',
      'bar.laneReady': 'Listos',
      'bar.accept': 'Aceptar',
      'bar.retry': 'Reintentar',
      'bar.start': 'Empezar',
      'bar.markReady': 'Listo',
      'bar.markDelivered': 'Entregado',
      'bar.cancel': 'Cancelar',
      'bar.confirmCancel': '¿Cancelar este pedido? Se devuelve la existencia.',
      'bar.emptyNew': 'Sin pedidos nuevos.',
      'bar.emptyPrep': 'Nada en preparación.',
      'bar.emptyReady': 'Nada listo para recoger.',
      'bar.table': 'Mesa',
      'bar.noTable': 'Sin mesa',
      'bar.for': 'Para',
      'bar.gift': 'Invitación',
      'bar.note': 'Nota',
      'bar.justNow': 'recién',
      'bar.minutes': '{n} min',
      'bar.oldest': 'El más viejo',
      'bar.open': 'Abiertos',
      'bar.posError': 'La caja rechazó este pedido.',
      'bar.alertOn': 'Aviso activado',
      'bar.alertOff': 'Aviso apagado',
      'bar.newOrder': 'Pedido nuevo',
      'bar.reload': 'Actualizar',

      // --- salida segura / taxi (paso 5.6) ---
      'taxi.title': 'Salida segura',
      'taxi.nav': 'Salida',
      'taxi.disabled': 'El servicio de salida segura no está disponible ahora.',
      'taxi.someoneWaiting': 'Hay un conductor esperando en la salida.',
      'taxi.driversAvailable': '{n} conductor(es) disponible(s).',
      'taxi.noDriversNow': 'Ahora mismo no hay conductores. Puedes solicitar y te avisamos.',
      'taxi.searching': 'Buscando conductor…',
      'taxi.onTheWay': 'Un conductor va en camino.',
      'taxi.arrivesIn': 'Llega en {n} min. Espera arriba.',
      'taxi.goDownNow': 'Llega en {n} min. Baja a la salida.',
      'taxi.arrivingNow': 'Ya está llegando. Baja a la salida.',
      'taxi.atExit': 'Tu conductor está en la salida.',
      'taxi.riding': 'Viaje en curso. Buen camino.',
      'taxi.done': 'Viaje terminado.',
      'taxi.cancelled': 'El viaje se canceló.',
      'taxi.noDriver': 'Nadie tomó la solicitud. Puedes volver a pedir.',
      'taxi.request': 'Solicitar taxi',
      'taxi.requesting': 'Solicitando…',
      'taxi.cancel': 'Cancelar solicitud',
      'taxi.confirmCancel': '¿Cancelar la solicitud de taxi?',
      'taxi.destination': 'A dónde vas',
      'taxi.destinationHint': 'Colonia o referencia',
      'taxi.zone': 'Zona',
      'taxi.zoneAny': 'Otra zona (se acuerda con el conductor)',
      'taxi.passengers': 'Cuántos van',
      'taxi.notes': 'Algo que el conductor deba saber',
      'taxi.pickup': 'Punto de encuentro',
      'taxi.driver': 'Conductor',
      'taxi.vehicle': 'Vehículo',
      'taxi.fare': 'Costo',
      'taxi.fareOpen': 'Se acuerda con el conductor',
      'taxi.call': 'Llamar',
      'taxi.certificate': 'Comprobante de salida',
      'taxi.certificateFolio': 'Folio',
      'taxi.certificateNote': 'Cualquiera puede verificar este folio en la página del club. Vence solo.',
      'taxi.certificateExpired': 'Este comprobante ya venció.',
      'taxi.history': 'Tus viajes',
      'taxi.noHistory': 'Todavía no has pedido ningún taxi.',
      // --- pantalla del conductor ---
      'taxi.driverTitle': 'Conductor',
      'taxi.driverOffers': 'Solicitudes',
      'taxi.driverNoOffers': 'No hay solicitudes ahora.',
      'taxi.driverAvailable': 'Disponible',
      'taxi.driverOff': 'No disponible',
      'taxi.driverAtVenue': 'Estoy en la salida del club',
      'taxi.driverAccept': 'Aceptar',
      'taxi.driverEta': '¿En cuántos minutos llegas?',
      'taxi.driverDecline': 'Paso',
      'taxi.driverArrived': 'Ya llegué',
      'taxi.driverStart': 'Empezar viaje',
      'taxi.driverFinish': 'Terminar viaje',
      'taxi.driverAmount': 'Cuánto se cobró',
      'taxi.driverPayment': 'Cómo pagó',
      'taxi.payCash': 'Efectivo',
      'taxi.payCard': 'Tarjeta',
      'taxi.payCourtesy': 'Cortesía',
      'taxi.driverPassengers': 'Pasajeros',
      'taxi.driverTonight': 'Esta noche',
      'taxi.driverRides': 'viajes',
      'taxi.driverGuest': 'Pasajero',
      'taxi.driverNotVerified': 'Tu registro debe estar activo y verificado por el gerente.',
    },
    en: {
      'error.network': 'No connection. Check your signal and try again.',
      'error.unauthorized': 'Your session ended. Please sign in again.',
      'error.badLogin': 'Wrong email or password.',
      'error.forbidden': "You don't have permission to do this.",
      'error.not_found': "We couldn't find that.",
      'error.conflict': 'Someone got there first. Try again.',
      'error.unprocessable': "That can't be completed with those details.",
      'error.too_many_requests': 'Too many attempts. Wait a moment.',
      'error.not_implemented': 'Not available yet.',
      'error.unknown': 'Something went wrong. Try again.',
      'realtime.reconnecting': 'Reconnecting…',
      'realtime.resync': 'Refreshing…',
      'realtime.replaced': 'You opened the app somewhere else.',

      // --- sign in ---
      'auth.city': 'Nogales, Sonora',
      'auth.signin': 'Sign in',
      'auth.signup': 'Sign up',
      'auth.email': 'Email',
      'auth.password': 'Password',
      'auth.enter': 'Enter the club',
      'auth.firstName': 'First name',
      'auth.lastName': 'Last name',
      'auth.newPassword': 'Password (at least 8)',
      'auth.birthDate': 'Date of birth',
      'auth.terms': "I'm 18 or older and I accept the terms and the code of conduct.",
      'auth.flirts': 'I want to receive invitations from other people.',
      'auth.flirtsNote': 'You can change this anytime.',
      'auth.create': 'Create account',
      'auth.adults': '18+ only · EV2 Clandestinoz',

      // --- top bar and navigation ---
      'nav.map': 'Map',
      'nav.menu': 'Menu',
      'nav.orders': 'Orders',
      'nav.profile': 'Profile',
      'top.noTable': 'no table',
      'top.table': 'table',
      'top.live': 'Live',
      'top.offline': 'Offline',
      'top.otherSession': 'Other session',
      'top.signOut': 'Sign out',

      // --- floor plan ---
      'map.tables': 'Tables',
      'map.free': 'Free',
      'map.vip': 'VIP',
      'map.busy': 'Taken',
      'map.hint': 'Tap your table on the map',
      'map.selected': 'Selected table',
      'map.table': 'Table',
      'map.zone': 'Zone',
      'map.capacity': 'Capacity',
      'map.type': 'Type',
      'map.sit': 'Sit here',
      'map.move': 'Move to this table',
      'map.alreadyHere': "You're already at this table",
      'map.youAreHere': "You're sitting here.",
      'map.unavailable': 'Not available',
      'map.full': 'This table is full.',
      'map.leave': 'Leave my table',
      'map.seated': "Done, that's your table",
      'map.occupied': 'Taken',
      'map.mine': 'Your table',
      'map.floorBaja': 'GROUND FLOOR',
      'map.floorAlta': 'UPPER FLOOR',
      'map.floorAmbas': 'WHOLE CLUB',

      // --- menu and orders ---
      'menu.all': 'All',
      'menu.soldOut': 'sold out',
      'menu.empty': 'No drinks in this category.',
      'menu.noStock': "There's no more of that in stock",
      'cart.order': 'Order',
      'orders.empty': "You haven't ordered anything yet.",
      'orders.needTable': 'Pick your table first: the waiter needs to know where to take it',
      'orders.sent': 'Order sent to the bar',
      'orders.ready': 'Your order is ready at the bar!',

      // --- profile ---
      'profile.table': 'Table',
      'profile.club': 'Club',
      'profile.account': 'Account',
      'profile.signOut': 'Sign out',

      // --- staff without a screen yet ---
      'staff.signedInAs': 'You signed in as',
      'staff.pending': 'This screen is not connected to the server yet. It is built in step {step} of the implementation plan.',
      'staff.noScreen': 'This account has no screen assigned. Tell the club administrator.',

      // --- notices ---
      'banner.replaced': 'You opened the app somewhere else. Reload if you want to continue here.',
      'banner.expired': 'Your session ended. Please sign in again.',
      'banner.updating': 'Refreshing…',

      // --- bar (step 5.7) ---
      'bar.title': 'Bar',
      'bar.laneNew': 'New',
      'bar.lanePrep': 'In progress',
      'bar.laneReady': 'Ready',
      'bar.accept': 'Accept',
      'bar.retry': 'Retry',
      'bar.start': 'Start',
      'bar.markReady': 'Ready',
      'bar.markDelivered': 'Delivered',
      'bar.cancel': 'Cancel',
      'bar.confirmCancel': 'Cancel this order? The stock goes back.',
      'bar.emptyNew': 'No new orders.',
      'bar.emptyPrep': 'Nothing in progress.',
      'bar.emptyReady': 'Nothing waiting for pickup.',
      'bar.table': 'Table',
      'bar.noTable': 'No table',
      'bar.for': 'For',
      'bar.gift': 'Gift',
      'bar.note': 'Note',
      'bar.justNow': 'just now',
      'bar.minutes': '{n} min',
      'bar.oldest': 'Longest wait',
      'bar.open': 'Open',
      'bar.posError': 'The register rejected this order.',
      'bar.alertOn': 'Alert on',
      'bar.alertOff': 'Alert off',
      'bar.newOrder': 'New order',
      'bar.reload': 'Refresh',

      // --- safe departure / taxi (step 5.6) ---
      'taxi.title': 'Safe departure',
      'taxi.nav': 'Ride',
      'taxi.disabled': 'Safe departure is not available right now.',
      'taxi.someoneWaiting': 'A driver is waiting at the exit.',
      'taxi.driversAvailable': '{n} driver(s) available.',
      'taxi.noDriversNow': 'No drivers right now. You can still request and we will tell you.',
      'taxi.searching': 'Looking for a driver…',
      'taxi.onTheWay': 'A driver is on the way.',
      'taxi.arrivesIn': 'Arrives in {n} min. Wait upstairs.',
      'taxi.goDownNow': 'Arrives in {n} min. Head to the exit.',
      'taxi.arrivingNow': 'Arriving now. Head to the exit.',
      'taxi.atExit': 'Your driver is at the exit.',
      'taxi.riding': 'Ride in progress. Safe trip.',
      'taxi.done': 'Ride finished.',
      'taxi.cancelled': 'The ride was cancelled.',
      'taxi.noDriver': 'Nobody took the request. You can ask again.',
      'taxi.request': 'Request a ride',
      'taxi.requesting': 'Requesting…',
      'taxi.cancel': 'Cancel request',
      'taxi.confirmCancel': 'Cancel the ride request?',
      'taxi.destination': 'Where to',
      'taxi.destinationHint': 'Neighbourhood or landmark',
      'taxi.zone': 'Zone',
      'taxi.zoneAny': 'Another zone (agreed with the driver)',
      'taxi.passengers': 'How many of you',
      'taxi.notes': 'Anything the driver should know',
      'taxi.pickup': 'Pickup point',
      'taxi.driver': 'Driver',
      'taxi.vehicle': 'Vehicle',
      'taxi.fare': 'Fare',
      'taxi.fareOpen': 'Agreed with the driver',
      'taxi.call': 'Call',
      'taxi.certificate': 'Departure receipt',
      'taxi.certificateFolio': 'Reference',
      'taxi.certificateNote': 'Anyone can verify this reference on the club page. It expires on its own.',
      'taxi.certificateExpired': 'This receipt has expired.',
      'taxi.history': 'Your rides',
      'taxi.noHistory': "You haven't requested a ride yet.",
      // --- driver screen ---
      'taxi.driverTitle': 'Driver',
      'taxi.driverOffers': 'Requests',
      'taxi.driverNoOffers': 'No requests right now.',
      'taxi.driverAvailable': 'Available',
      'taxi.driverOff': 'Not available',
      'taxi.driverAtVenue': "I'm at the club exit",
      'taxi.driverAccept': 'Accept',
      'taxi.driverEta': 'How many minutes away are you?',
      'taxi.driverDecline': 'Pass',
      'taxi.driverArrived': "I've arrived",
      'taxi.driverStart': 'Start ride',
      'taxi.driverFinish': 'Finish ride',
      'taxi.driverAmount': 'Amount charged',
      'taxi.driverPayment': 'How they paid',
      'taxi.payCash': 'Cash',
      'taxi.payCard': 'Card',
      'taxi.payCourtesy': 'Courtesy',
      'taxi.driverPassengers': 'Passengers',
      'taxi.driverTonight': 'Tonight',
      'taxi.driverRides': 'rides',
      'taxi.driverGuest': 'Passenger',
      'taxi.driverNotVerified': 'Your registration must be active and verified by the manager.',
    },
  };

  /**
   * Mensajes que el servidor todavía manda en inglés. Mostrarlos tal cual a un usuario
   * en español es peor que el texto genérico; se traducen por catálogo mientras la API
   * no los localice.
   */
  const ENGLISH_SERVER_MESSAGES = new Set([
    'Invalid credentials', 'Order not found', 'Table not found', 'Not your order',
    'Only staff can change this order',
  ]);

  const STORAGE_KEY = 'ev2.lang';
  const SUPPORTED = Object.keys(STRINGS);

  /**
   * El idioma se elige una vez y se recuerda. Antes vivía en una variable en memoria:
   * el botón cambiaba de etiqueta, y al recargar volvía a español sin avisar.
   */
  function readStored(storage) {
    try {
      const saved = storage && storage.getItem(STORAGE_KEY);
      if (saved && SUPPORTED.includes(saved)) return saved;
    } catch { /* modo privado, cuota llena: no es motivo para no abrir la app */ }
    return null;
  }

  function detect(nav) {
    const tags = (nav && (nav.languages || (nav.language ? [nav.language] : []))) || [];
    for (const tag of tags) {
      const base = String(tag).slice(0, 2).toLowerCase();
      if (SUPPORTED.includes(base)) return base;
    }
    return 'es';
  }

  const g = typeof globalThis !== 'undefined' ? globalThis : {};
  let store = null;
  try { store = g.localStorage || null; } catch { store = null; }

  let lang = readStored(store) || detect(g.navigator) || 'es';

  function setLanguage(next) {
    lang = STRINGS[next] ? next : 'es';
    try { if (store) store.setItem(STORAGE_KEY, lang); } catch { /* ver readStored */ }
    if (g.document && g.document.documentElement) g.document.documentElement.lang = lang;
    return lang;
  }
  const getLanguage = () => lang;
  const locale = () => LOCALES[lang];
  /** El otro idioma: es lo que tiene que decir el botón, no el actual. */
  const otherLanguage = () => (lang === 'es' ? 'en' : 'es');

  function t(key, fallback) {
    const table = STRINGS[lang] || STRINGS.es;
    // Si a un idioma le falta una clave se cae al español antes que al nombre de la
    // clave: un botón que diga "map.sit" es peor que uno que diga "Sentarme aquí".
    const value = table[key] !== undefined ? table[key] : STRINGS.es[key];
    return value !== undefined ? value : (fallback !== undefined ? fallback : key);
  }

  /** `t` con huecos: t('staff.pending', { step: '5.7' }). */
  function tf(key, vars) {
    return String(t(key)).replace(/\{(\w+)\}/g, (whole, name) => (
      vars && vars[name] !== undefined ? vars[name] : whole));
  }

  /**
   * Traduce el HTML ya escrito. Cada texto visible lleva `data-i18n="clave"`, y los
   * textos que van dentro de un atributo llevan `data-i18n-placeholder` o
   * `data-i18n-title`. Así el idioma se aplica sin volver a pintar la pantalla.
   */
  function applyTo(root) {
    if (!root || !root.querySelectorAll) return 0;
    let count = 0;
    for (const el of root.querySelectorAll('[data-i18n]')) {
      el.textContent = t(el.getAttribute('data-i18n'));
      count += 1;
    }
    for (const attr of ['placeholder', 'title', 'aria-label']) {
      for (const el of root.querySelectorAll(`[data-i18n-${attr}]`)) {
        el.setAttribute(attr, t(el.getAttribute(`data-i18n-${attr}`)));
        count += 1;
      }
    }
    return count;
  }

  /** Las claves que le faltan a un idioma. Se usa en las pruebas. */
  function missingKeys(language) {
    const table = STRINGS[language] || {};
    return Object.keys(STRINGS.es).filter((k) => table[k] === undefined);
  }

  /**
   * El mensaje del servidor ya viene en español y suele ser más útil que uno genérico
   * (dice *por qué* no se pudo). Se usa ese, y el texto propio solo cuando no hay.
   */
  function errorMessage(err, opts) {
    if (!err) return t('error.unknown');
    if (err.name === 'NetworkError') return t('error.network');

    // En la pantalla de acceso, un 401 significa credenciales malas. El servidor
    // responde 'unauthorized' para los dos casos, así que la pantalla es la única que
    // sabe cuál es; sin esto el texto es literalmente falso.
    if (opts && opts.context === 'login' && err.status === 401) return t('error.badLogin');

    // El mensaje del servidor viene en español y suele decir *por qué* mejor que uno
    // genérico. En inglés no sirve: está en español, así que se usa el catálogo.
    if (err.message && err.code && err.code !== 'unknown' && lang === 'es'
        && !ENGLISH_SERVER_MESSAGES.has(err.message)) {
      return err.message;
    }
    return t(`error.${err.code || 'unknown'}`, err.message);
  }

  /** "1500.00" -> "$1,500.00". Nunca convierte a float para mostrar. */
  function money(amount, currency, opts = {}) {
    if (amount === null || amount === undefined || amount === '') return '—';
    const value = typeof amount === 'string' ? Number(amount) : amount;
    if (!Number.isFinite(value)) return String(amount);
    return new Intl.NumberFormat(opts.locale || locale(), {
      style: 'currency',
      currency: currency || 'MXN',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value);
  }

  /** Suma importes decimales en centavos enteros: 0.1 + 0.2 no es 0.3 en float. */
  function addMoney(...amounts) {
    const cents = amounts.reduce((sum, a) => {
      if (a === null || a === undefined || a === '') return sum;
      return sum + Math.round(Number(a) * 100);
    }, 0);
    return (cents / 100).toFixed(2);
  }

  function dateTime(iso, opts = {}) {
    if (!iso) return '—';
    return new Intl.DateTimeFormat(opts.locale || locale(), Object.assign({
      dateStyle: 'medium', timeStyle: 'short',
    }, opts.format || {})).format(new Date(iso));
  }

  function time(iso) {
    if (!iso) return '—';
    return new Intl.DateTimeFormat(locale(), { hour: '2-digit', minute: '2-digit' })
      .format(new Date(iso));
  }

  /** "llega en 8 min", "ya pasó". Para la espera del taxi y del auto en el valet. */
  function minutesUntil(iso) {
    if (!iso) return null;
    return Math.round((new Date(iso).getTime() - Date.now()) / 60000);
  }

  return {
    setLanguage, getLanguage, otherLanguage, locale, t, tf, applyTo, missingKeys,
    errorMessage, money, addMoney, dateTime, time, minutesUntil,
    detect, STRINGS, SUPPORTED, STORAGE_KEY,
  };
}));
