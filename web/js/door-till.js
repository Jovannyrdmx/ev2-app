/**
 * EV2 — la caja de Cover en la pantalla de la puerta (D118): las decisiones, sin DOM.
 *
 * Desde D118 la puerta es una caja más. La anfitriona que el gerente puso en Cover la
 * abre con su fondo (pesos y dólares) y el PIN del gerente, y mientras la tenga abierta
 * es la ÚNICA que cobra en la puerta: covers, el resto de las mesas y la terminal de
 * Cover. Las demás anfitrionas y la gerencia siguen escaneando pases.
 *
 * El servidor manda en todo: de dónde sale la caja (el rol de la noche), el PIN y quién
 * puede cobrar. Esto solo decide qué enseñar y evita mandar lo que de antemano se sabe
 * que va a fallar, diciendo por qué.
 */
(function (root, factory) {
  'use strict';
  const lib = factory();
  if (typeof module === 'object' && module.exports) module.exports = lib;
  else root.EV2DoorTill = lib;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const HOSTESS = 'hostess';

  /** ¿La caja abierta de este estado es la de la puerta? */
  const isDoor = (till) => Boolean(till && till.location_kind === 'door');

  /**
   * En qué punto está la caja de Cover para quien mira:
   *   'not_hostess'   — gerencia u otro puesto: en la puerta no cobra;
   *   'other_till'    — tiene abierta otra caja que no es la de la puerta;
   *   'open'          — tiene la caja de Cover abierta: cobra;
   *   'taken'         — Cover le tocaba, pero la caja la tiene otra anfitriona;
   *   'closed'        — Cover le toca y todavía no la abre;
   *   'no_assignment' — esta noche no la pusieron en Cover.
   */
  function phase(state, role) {
    if (role !== HOSTESS) return 'not_hostess';
    if (state && state.till) return isDoor(state.till) ? 'open' : 'other_till';
    const a = state && state.assignment;
    if (a && a.held_by) return 'taken';
    if (a) return 'closed';
    return 'no_assignment';
  }

  /** ¿Puede cobrar en la puerta ahora mismo? */
  const canCharge = (state, role) => phase(state, role) === 'open';

  /** Por qué no puede cobrar (clave de texto), o null si sí puede. */
  function chargeBlocker(state, role) {
    switch (phase(state, role)) {
      case 'open': return null;
      case 'not_hostess': return 'dtill.lockedStaff';
      case 'taken': return 'dtill.lockedTaken';
      case 'closed': return 'dtill.lockedClosed';
      case 'other_till': return 'dtill.lockedOther';
      default: return 'dtill.lockedNoAssignment';
    }
  }

  /** Un monto de fondo: vacío no vale en pesos (puede ser 0), y vacío en dólares es 0. */
  function amountOk(value, { optional = false } = {}) {
    if (value === '' || value === null || value === undefined) return optional;
    const n = Number(value);
    return Number.isFinite(n) && n >= 0;
  }

  /** Por qué todavía no se puede abrir la caja de Cover (clave), o null. */
  function openBlocker({ state, role, amount, amountUsd, pin }) {
    const p = phase(state, role);
    if (p === 'open') return 'till.errOpen';
    if (p === 'taken') return 'dtill.lockedTaken';
    if (p !== 'closed') return 'dtill.lockedNoAssignment';
    if (!amountOk(amount)) return 'till.errFloat';
    if (!amountOk(amountUsd, { optional: true })) return 'dtill.errFloatUsd';
    if (!/^\d{6}$/.test(String(pin || ''))) return 'cut.errPin';
    return null;
  }

  const round2 = (n) => Math.round(Number(n) * 100) / 100;

  /** Lo que se manda para abrir. Los dólares solo si hay. */
  function openPayload({ amount, amountUsd, pin }) {
    const body = { opening_float: round2(amount), manager_pin: String(pin) };
    if (amountUsd !== '' && amountUsd !== null && amountUsd !== undefined && Number(amountUsd) > 0) {
      body.opening_float_usd = round2(amountUsd);
    }
    return body;
  }

  /** ¿Este evento del socket cambia la caja de Cover de alguien? */
  function affectsTill(message) {
    const tipo = String((message && (message.event_type || message.type)) || '');
    return tipo === 'till_opened' || tipo === 'shift_closed';
  }

  return {
    HOSTESS, isDoor, phase, canCharge, chargeBlocker, openBlocker, openPayload, affectsTill,
  };
}));
