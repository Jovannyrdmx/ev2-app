/**
 * EV2 — salida segura: el viaje visto desde los dos lados (paso 5.6).
 *
 * El cliente necesita saber una sola cosa a las 3 de la mañana: **si baja ya o si
 * espera**. El conductor necesita otra: qué le toca tocar ahora. Las dos respuestas se
 * calculan aquí, en funciones puras probadas en Node, porque equivocarse en cualquiera
 * de las dos manda a alguien a la banqueta a esperar un coche que no viene.
 *
 * Los estados son los del CHECK de `taxi_requests` (migración 009). Aquí no se inventa
 * ninguno ni se salta un paso.
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EV2Taxi = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const LIVE_STATUSES = ['requested', 'assigned', 'driver_arrived', 'in_progress'];
  const CLOSED_STATUSES = ['completed', 'cancelled', 'no_driver'];
  /** Los que ofrece el servidor en `ETA_CHOICES`; el conductor elige uno al aceptar. */
  const ETA_CHOICES = [0, 5, 10, 15, 20, 30, 45];

  const isLive = (status) => LIVE_STATUSES.includes(status);
  const isClosed = (status) => CLOSED_STATUSES.includes(status);

  /** El cliente solo puede cancelar antes de subirse. Ya andando, se arregla adentro. */
  const canCancel = (status) => ['requested', 'assigned', 'driver_arrived'].includes(status);

  const toTime = (iso) => {
    const ms = Date.parse(iso);
    return Number.isFinite(ms) ? ms : null;
  };

  // ---------------------------------------------------------------- el cliente

  /**
   * Minutos que faltan para que llegue, redondeados hacia arriba: decir "0 min" cuando
   * todavía faltan cuarenta segundos hace que el cliente salga antes de tiempo.
   * Negativo significa que ya se pasó la hora prometida, y eso también hay que decirlo.
   */
  function minutesUntilArrival(ride, now) {
    const at = toTime(ride && ride.expected_arrival_at);
    if (at === null) return null;
    return Math.ceil((at - (now || Date.now())) / 60000);
  }

  /**
   * En qué punto va el viaje, desde los ojos del cliente. Es lo que decide el mensaje
   * grande de la pantalla, y por eso está separado del dibujo.
   */
  function guestStage(ride) {
    if (!ride || !ride.status) return 'idle';
    switch (ride.status) {
      case 'requested': return 'searching';
      case 'assigned': return 'onTheWay';
      case 'driver_arrived': return 'atExit';
      case 'in_progress': return 'riding';
      case 'completed': return 'done';
      case 'cancelled': return 'cancelled';
      case 'no_driver': return 'noDriver';
      default: return 'idle';
    }
  }

  /**
   * El renglón grande: qué tiene que hacer el cliente AHORA.
   *
   * Devuelve `{ key, vars, urgent }` para que la pantalla lo traduzca. `urgent` es
   * cuando tiene que levantarse y caminar a la salida.
   */
  function guestHeadline(ride, availability, now) {
    const stage = guestStage(ride);

    if (stage === 'idle') {
      const state = availability || {};
      if (state.enabled === false) return { key: 'taxi.disabled', vars: null, urgent: false };
      // "Hay uno parado en la puerta" solo se dice si de verdad hay uno parado ahí.
      if (state.wait_at_exit) return { key: 'taxi.someoneWaiting', vars: null, urgent: false };
      if (state.available_drivers > 0) {
        return { key: 'taxi.driversAvailable', vars: { n: state.available_drivers }, urgent: false };
      }
      return { key: 'taxi.noDriversNow', vars: null, urgent: false };
    }

    if (stage === 'searching') return { key: 'taxi.searching', vars: null, urgent: false };

    if (stage === 'onTheWay') {
      const left = minutesUntilArrival(ride, now);
      if (left === null) return { key: 'taxi.onTheWay', vars: null, urgent: false };
      // Un conductor que aceptó con 0 minutos ya está ahí: no se le hace esperar.
      if (left <= 0) return { key: 'taxi.arrivingNow', vars: null, urgent: true };
      if (left <= 2) return { key: 'taxi.goDownNow', vars: { n: left }, urgent: true };
      return { key: 'taxi.arrivesIn', vars: { n: left }, urgent: false };
    }

    if (stage === 'atExit') return { key: 'taxi.atExit', vars: null, urgent: true };
    if (stage === 'riding') return { key: 'taxi.riding', vars: null, urgent: false };
    if (stage === 'done') return { key: 'taxi.done', vars: null, urgent: false };
    if (stage === 'cancelled') return { key: 'taxi.cancelled', vars: null, urgent: false };
    return { key: 'taxi.noDriver', vars: null, urgent: false };
  }

  /**
   * El coche, en el orden en que sirve para reconocerlo desde la banqueta: color,
   * modelo y placa. La placa es lo último que se lee y lo que confirma.
   */
  function vehicleLabel(ride) {
    const v = ride && ride.driver && ride.driver.vehicle;
    if (!v) return null;
    const parts = [v.color, v.description].filter(Boolean);
    const body = parts.join(' ');
    if (!v.plate) return body || null;
    return body ? `${body} · ${v.plate}` : v.plate;
  }

  /** El precio de la zona, o null cuando el club no la tiene en su lista. */
  function fareAmount(ride) {
    if (!ride) return null;
    const amount = ride.final_amount !== null && ride.final_amount !== undefined
      ? ride.final_amount : ride.quoted_amount;
    return amount === null || amount === undefined || amount === '' ? null : amount;
  }

  /** Qué se le muestra del certificado, y solo cuando ya existe y no ha vencido. */
  function certificate(ride, now) {
    if (!ride || !ride.certificate_folio) return null;
    const expires = toTime(ride.certificate_expires_at);
    const expired = expires !== null && expires <= (now || Date.now());
    return { folio: ride.certificate_folio, expires_at: ride.certificate_expires_at, expired };
  }

  /**
   * Qué viaje enseñarle al cliente. Si hay uno vivo, ese. Si no, el último cerrado
   * MIENTRAS su comprobante siga vigente: en cuanto el conductor marca "terminado" el
   * viaje deja de estar vivo, y si la pantalla lo soltara de inmediato el cliente se
   * quedaría sin el folio justo cuando le sirve — es lo único que prueba a qué hora y
   * con quién salió del club.
   */
  function currentForGuest(live, rides, now) {
    if (live && isLive(live.status)) return live;
    const closed = (rides || []).filter((r) => isClosed(r.status));
    for (const ride of closed) {
      const cert = certificate(ride, now);
      if (cert && !cert.expired) return ride;
    }
    return null;
  }

  // ---------------------------------------------------------------- el conductor

  /**
   * El único botón que el conductor tiene que ver. Cada uno es UNA llamada al servidor,
   * en el orden que el servidor acepta: aceptar → llegué → empecé → terminé.
   */
  const DRIVER_ACTION = {
    requested: { action: 'accept', key: 'taxi.driverAccept', needsEta: true },
    assigned: { action: 'arrived', key: 'taxi.driverArrived', needsEta: false },
    driver_arrived: { action: 'start', key: 'taxi.driverStart', needsEta: false },
    in_progress: { action: 'finish', key: 'taxi.driverFinish', needsEta: false, needsAmount: true },
  };

  const driverAction = (status) => DRIVER_ACTION[status] || null;

  /**
   * Un conductor solo puede tener un viaje vivo a la vez (lo garantiza un índice único
   * en la base). Mientras lo tenga, las ofertas no se le muestran: aceptar otra le daría
   * un error y lo distraería manejando.
   */
  function driverView(live, offers) {
    if (live && isLive(live.status)) return { mode: 'ride', ride: live, offers: [] };
    return { mode: 'offers', ride: null, offers: offers || [] };
  }

  /** Lo que lleva cobrado esta noche, ya sumado por moneda. */
  function tonightTotal(totals, currency) {
    const row = (totals || []).find((t) => t.currency === (currency || 'MXN'));
    return row ? { rides: row.rides, charged: row.charged, currency: row.currency }
      : { rides: 0, charged: '0.00', currency: currency || 'MXN' };
  }

  // ---------------------------------------------------------------- eventos

  const TAXI_EVENTS = ['taxi_requested', 'taxi_assigned', 'taxi_driver_arrived',
    'taxi_started', 'taxi_completed', 'taxi_cancelled', 'taxi_no_driver',
    'taxi_driver_availability'];

  const STATUS_BY_EVENT = {
    taxi_assigned: 'assigned',
    taxi_driver_arrived: 'driver_arrived',
    taxi_started: 'in_progress',
    taxi_completed: 'completed',
    taxi_cancelled: 'cancelled',
    taxi_no_driver: 'no_driver',
  };

  /**
   * Qué hacer ante un evento del socket. El mensaje trae el id y poco más, así que casi
   * siempre la respuesta correcta es volver a pedir el viaje: es lo único que trae el
   * coche, la placa y el teléfono del conductor.
   *
   * OJO: el tipo real viaja en `event_type`; `type` siempre vale 'event'.
   */
  function applyEvent(current, message) {
    const kind = message && (message.event_type || message.type);
    if (!TAXI_EVENTS.includes(kind)) return { changed: false };

    if (kind === 'taxi_driver_availability') return { changed: true, refreshAvailability: true };
    if (kind === 'taxi_requested') return { changed: true, refreshOffers: true };

    const payload = (message && message.payload) || {};
    const rideId = payload.ride_id;
    if (!rideId) return { changed: false };
    // Un evento de OTRO viaje no toca el que se está mostrando.
    if (current && current.id && current.id !== rideId) return { changed: false };

    const status = payload.status || STATUS_BY_EVENT[kind] || null;
    return { changed: true, refreshRide: rideId, status };
  }

  return {
    LIVE_STATUSES,
    CLOSED_STATUSES,
    ETA_CHOICES,
    TAXI_EVENTS,
    DRIVER_ACTION,
    isLive,
    isClosed,
    canCancel,
    minutesUntilArrival,
    guestStage,
    guestHeadline,
    vehicleLabel,
    fareAmount,
    certificate,
    currentForGuest,
    driverAction,
    driverView,
    tonightTotal,
    applyEvent,
  };
}));
