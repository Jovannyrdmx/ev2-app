/**
 * EV2 — el estacionamiento, visto por el valet (paso 5.6, segunda mitad).
 *
 * Tres carriles y una regla que manda sobre todas: **quien ya pidió su coche va
 * primero**. Un cliente parado en la puerta esperando su auto es la peor cola del club,
 * y la única que se ve desde la calle.
 *
 * Los estados son los del CHECK de `valet_tickets`; aquí no se inventa ninguno.
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EV2Valet = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const LANES = ['requested', 'ready', 'parked'];

  const LANE_OF = {
    requested: 'requested', // el cliente ya lo pidió: es lo urgente
    ready: 'ready', // el coche está en la puerta esperando a que lo recojan
    parked: 'parked', // guardado, sin prisa
  };

  const CLOSED = ['delivered', 'cancelled'];

  const laneOf = (status) => LANE_OF[status] || null;
  const isClosed = (status) => CLOSED.includes(status);

  /**
   * El botón principal. `deliver` NO va aquí: entregar exige el QR del cliente y eso es
   * una pantalla aparte, no un toque más en la lista.
   */
  const NEXT_ACTION = {
    parked: { action: 'ready', key: 'valet.markReady' },
    requested: { action: 'ready', key: 'valet.bringIt' },
    ready: { action: 'deliver', key: 'valet.deliver', needsToken: true },
  };

  const nextAction = (status) => NEXT_ACTION[status] || null;

  const canCancel = (status) => ['parked', 'requested', 'ready'].includes(status);

  const toTime = (iso) => {
    const ms = Date.parse(iso);
    return Number.isFinite(ms) ? ms : null;
  };

  /**
   * Desde cuándo cuenta la espera de cada carril.
   *
   * En `requested` se cuenta desde que el cliente lo pidió, no desde que llegó al club:
   * lo que importa es cuánto lleva parado en la puerta.
   */
  function waitMinutes(ticket, now) {
    const t = ticket || {};
    const from = t.status === 'requested' ? (t.requested_at || t.created_at)
      : t.status === 'ready' ? (t.ready_at || t.requested_at || t.created_at)
        : t.created_at;
    const at = toTime(from);
    if (at === null) return null;
    return Math.max(0, Math.floor(((now || Date.now()) - at) / 60000));
  }

  const THRESHOLDS = { warn: 4, late: 8 };

  function urgency(minutes, thresholds) {
    const th = thresholds || THRESHOLDS;
    if (minutes === null || minutes === undefined) return 'ok';
    if (minutes >= th.late) return 'late';
    if (minutes >= th.warn) return 'warn';
    return 'ok';
  }

  /** Reparte en carriles, el que más lleva esperando primero dentro de cada uno. */
  function groupByLane(tickets, now) {
    const lanes = { requested: [], ready: [], parked: [] };
    for (const ticket of (tickets || [])) {
      const lane = laneOf(ticket.status);
      if (lane) lanes[lane].push(ticket);
    }
    for (const lane of LANES) {
      lanes[lane].sort((a, b) => {
        const wa = waitMinutes(a, now);
        const wb = waitMinutes(b, now);
        if (wa === null) return 1;
        if (wb === null) return -1;
        return wb - wa; // el que más lleva esperando, arriba
      });
    }
    return lanes;
  }

  function counts(tickets) {
    const lanes = groupByLane(tickets);
    return {
      requested: lanes.requested.length,
      ready: lanes.ready.length,
      parked: lanes.parked.length,
      total: lanes.requested.length + lanes.ready.length + lanes.parked.length,
    };
  }

  /** El coche, como se busca en el estacionamiento: placa primero. */
  function vehicleLabel(ticket) {
    const t = ticket || {};
    const parts = [t.plate, t.vehicle_desc].filter(Boolean);
    return parts.join(' · ') || null;
  }

  /**
   * Busca por placa, aunque la escriban con guiones o sin ellos. Un valet teclea
   * "abc123" con una mano y el boleto dice "ABC-123": las dos tienen que encontrarlo.
   */
  const normalisePlate = (value) => String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

  function search(tickets, query) {
    const needle = normalisePlate(query);
    if (!needle) return tickets || [];
    return (tickets || []).filter((t) => normalisePlate(t.plate).includes(needle));
  }

  /**
   * Comprueba la placa antes de mandarla: el servidor exige de 3 a 20 caracteres, y un
   * boleto con una placa mal escrita es un coche que no se encuentra.
   */
  function validatePlate(plate) {
    const value = String(plate || '').trim();
    if (value.length < 3 || value.length > 20) return 'valet.errPlate';
    if (!/[A-Za-z0-9]/.test(value)) return 'valet.errPlate';
    return null;
  }

  /** El QR del cliente: el servidor lo exige de 16 a 64 caracteres para entregar. */
  function validateToken(token) {
    const value = String(token || '').trim();
    if (value.length < 16 || value.length > 64) return 'valet.errToken';
    return null;
  }

  // ---------------------------------------------------------------- eventos

  // Los tres que el servidor publica hoy (routes/valet.js). Los otros dos se aceptan
  // por si se agregan: llegar de más solo provoca una recarga de más.
  const VALET_EVENTS = ['valet_requested', 'valet_ready', 'valet_delivered',
    'valet_parked', 'valet_cancelled'];

  /** OJO: el tipo real viaja en `event_type`; `type` siempre vale 'event'. */
  function applyEvent(message) {
    const kind = message && (message.event_type || message.type);
    if (!VALET_EVENTS.includes(kind)) return { changed: false };
    return {
      changed: true,
      reload: true,
      // Que un cliente pida su coche es lo único que hace correr al valet.
      announce: kind === 'valet_requested',
      ticketId: (message.payload || {}).ticket_id || null,
    };
  }

  return {
    LANES,
    LANE_OF,
    CLOSED,
    THRESHOLDS,
    VALET_EVENTS,
    laneOf,
    isClosed,
    nextAction,
    canCancel,
    waitMinutes,
    urgency,
    groupByLane,
    counts,
    vehicleLabel,
    normalisePlate,
    search,
    validatePlate,
    validateToken,
    applyEvent,
  };
}));
