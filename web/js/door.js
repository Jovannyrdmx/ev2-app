/**
 * EV2 — la puerta: la anfitriona recibiendo las reservaciones de la noche (paso 5.3).
 *
 * Ya se puede reservar desde el teléfono, pero hasta ahora nadie podía sentar al que
 * llegaba. Esta es la mitad que faltaba: sin ella, una reservación pagada es una
 * promesa que el club no puede cumplir en la puerta.
 *
 * Es una pantalla que se usa de pie, con gente esperando enfrente y ruido. Por eso todo
 * lo que decide está aquí, probado, y la pantalla solo pinta.
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EV2Door = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** Las transiciones que el servidor acepta. Copiadas de routes/reservations.js. */
  const STATUS_FLOW = {
    pending_payment: ['confirmed', 'cancelled'],
    confirmed: ['seated', 'no_show', 'cancelled'],
    seated: ['completed'],
    completed: [],
    cancelled: [],
    no_show: [],
  };

  const LIVE = ['pending_payment', 'confirmed', 'seated'];

  const text = (v) => String(v === null || v === undefined ? '' : v).trim();

  /**
   * El orden de la lista en la puerta.
   *
   * Quien ya está sentado se va al final: ya no es trabajo. Arriba, quien todavía no
   * llega, ordenado por su hora límite de llegada — porque el que está a punto de
   * perder su mesa es el que hay que atender o liberar primero.
   */
  function sortForDoor(reservations, now) {
    const when = now ? new Date(now) : new Date();
    const rank = (r) => {
      if (r.status === 'seated') return 2;
      if (r.status === 'pending_payment') return 0;
      return 1;
    };
    const deadline = (r) => new Date(r.arrival_deadline || r.doors_open_at || when).getTime();
    return (reservations || [])
      .filter((r) => r && r.id && LIVE.includes(r.status))
      .slice()
      .sort((a, b) => rank(a) - rank(b) || deadline(a) - deadline(b));
  }

  /**
   * Cuánto falta para que esta mesa se libere, en minutos, redondeado hacia arriba.
   *
   * Hacia arriba porque es tiempo que al cliente todavía le queda: quitarle un minuto
   * es liberar su mesa antes de tiempo, y esa mesa ya está pagada.
   */
  function countdown(reservation, now) {
    const r = reservation || {};
    const limit = r.arrival_deadline || r.doors_open_at;
    if (!limit) return null;
    const when = now ? new Date(now) : new Date();
    const minutes = Math.ceil((new Date(limit) - when) / 60000);
    return { minutes, expired: minutes <= 0 };
  }

  /**
   * El semáforo de una tarjeta: qué tan urgente es.
   *
   *   'late'  — se le pasó la hora; la mesa se puede liberar.
   *   'soon'  — le quedan 15 minutos o menos.
   *   'ok'    — todavía hay tiempo.
   *   'done'  — ya está sentado, no hay nada que hacer.
   */
  function urgency(reservation, now) {
    const r = reservation || {};
    if (r.status === 'seated') return 'done';
    const c = countdown(r, now);
    if (!c) return 'ok';
    if (c.expired) return 'late';
    return c.minutes <= 15 ? 'soon' : 'ok';
  }

  /**
   * Los botones de una reservación, en el orden en que se usan de verdad.
   *
   * "Llegó" es siempre el principal y el más grande: es lo que pasa el 95% de las
   * veces, y la anfitriona lo toca con una mano mientras con la otra sostiene la
   * tableta. Marcar que no llegó va aparte y pide confirmación, porque libera una mesa
   * que alguien pagó.
   */
  function actionsFor(reservation) {
    const status = (reservation || {}).status;
    const allowed = STATUS_FLOW[status] || [];
    const actions = [];
    // Una reservación sin anticipo pagado se confirma en la puerta: el cliente llegó y
    // paga ahí. El club prefiere cobrarle a rechazarlo.
    if (allowed.includes('confirmed')) {
      actions.push({ status: 'confirmed', key: 'door.confirm', primary: true, confirm: false });
    }
    if (allowed.includes('seated')) {
      actions.push({ status: 'seated', key: 'door.seat', primary: true, confirm: false });
    }
    if (allowed.includes('no_show')) {
      actions.push({ status: 'no_show', key: 'door.noShow', primary: false, confirm: true });
    }
    if (allowed.includes('completed')) {
      actions.push({ status: 'completed', key: 'door.complete', primary: false, confirm: false });
    }
    return actions;
  }

  /** Si una transición la va a aceptar el servidor. Evita ofrecer un botón que da 409. */
  const canGo = (from, to) => (STATUS_FLOW[from] || []).includes(to);

  /**
   * El resumen de la noche en la puerta: cuántos faltan por llegar, cuántos ya están
   * dentro y cuántos van tarde. Es lo que la anfitriona le contesta al gerente cuando
   * pregunta "¿cómo vamos?".
   */
  function summary(reservations, now) {
    const list = (reservations || []).filter((r) => r && r.id);
    const live = list.filter((r) => LIVE.includes(r.status));
    let late = 0;
    let guests = 0;
    for (const r of live) {
      if (r.status !== 'seated' && urgency(r, now) === 'late') late += 1;
      if (r.status === 'seated') guests += Number(r.guest_count) || 0;
    }
    return {
      expected: live.filter((r) => r.status !== 'seated').length,
      seated: live.filter((r) => r.status === 'seated').length,
      late,
      guestsInside: guests,
      noShow: list.filter((r) => r.status === 'no_show').length,
    };
  }

  /** Búsqueda por nombre o por mesa, sin acentos y sin importar mayúsculas. */
  function search(reservations, term) {
    const norm = (v) => text(v).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    const q = norm(term);
    if (!q) return reservations || [];
    return (reservations || []).filter((r) => norm(r.user_name).includes(q)
      || norm(r.table_code).includes(q)
      || norm(r.table_number).includes(q));
  }

  const STATUS_KEY = {
    pending_payment: 'book.stPending',
    confirmed: 'book.stConfirmed',
    seated: 'book.stSeated',
    completed: 'book.stCompleted',
    cancelled: 'book.stCancelled',
    no_show: 'book.stNoShow',
  };

  const statusLabel = (status) => STATUS_KEY[status] || 'book.stPending';

  /**
   * Los eventos del socket que mueven la puerta.
   *
   * Verificados contra `routes/reservations.js`, no supuestos: el cambio de estado
   * publica `reservation_${estado}`, así que los nombres son estos y no un genérico
   * tipo `reservation_updated`, que no existe y dejaría la pantalla muda. El tipo real
   * viaja en `event_type`; `type` siempre vale 'event'.
   */
  const DOOR_EVENTS = ['reservation_created', 'reservation_cancelled', 'reservation_confirmed',
    'reservation_seated', 'reservation_completed', 'reservation_no_show'];

  const affectsDoor = (message) => DOOR_EVENTS
    .includes(message && (message.event_type || message.type));

  return {
    STATUS_FLOW,
    LIVE,
    DOOR_EVENTS,
    sortForDoor,
    countdown,
    urgency,
    actionsFor,
    canGo,
    summary,
    search,
    statusLabel,
    affectsDoor,
  };
}));
