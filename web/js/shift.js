/**
 * EV2 — el turno de un empleado y los tragos que le invitan (paso 5.4).
 *
 * El turno no es un adorno. El servidor exige turno abierto para que a alguien se le
 * pueda dar propina, para que el DJ acepte una canción y para que se le invite un
 * trago. Una ambientadora con el turno cerrado sencillamente no existe para el cliente,
 * y desde su pantalla no hay forma de saber por qué nadie le da propina.
 *
 * Sin DOM a propósito: todo esto se prueba en Node.
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EV2Shift = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const cents = (value) => {
    if (value === null || value === undefined || value === '') return 0;
    const n = Math.round(Number(value) * 100);
    return Number.isFinite(n) ? n : 0;
  };

  // ---------------------------------------------------------------- el turno

  /**
   * El turno abierto de esta persona, si lo hay.
   *
   * Acepta dos formas porque las dos existen: la lista de `/staff/shifts` (que solo
   * pueden leer el gerente y la anfitriona) y la fila del propio empleado que viene en
   * `/employees/me/dashboard`, con `on_shift` y `shift_started_at`. Sin esto, el portal
   * de un empleado tendría que pedir una ruta que su rol no puede leer.
   */
  function openShift(shifts) {
    if (!shifts) return null;
    if (!Array.isArray(shifts)) {
      return shifts.on_shift
        ? { started_at: shifts.shift_started_at || null, ended_at: null }
        : null;
    }
    return shifts.find((s) => s && !s.ended_at) || null;
  }

  const isOpen = (shifts) => Boolean(openShift(shifts));

  /**
   * Qué botón se enseña y qué consecuencia tiene.
   *
   * El texto dice lo que va a pasar, no el estado en el que está: "Terminar turno" es
   * una acción; "En turno" es una etiqueta y deja al empleado adivinando si el botón
   * abre o cierra.
   */
  function shiftButton(shifts) {
    return isOpen(shifts)
      ? { action: 'end', key: 'shift.end', path: 'end' }
      : { action: 'start', key: 'shift.start', path: 'start' };
  }

  /**
   * Cuánto lleva trabajando, en minutos, redondeado hacia abajo.
   *
   * Hacia abajo a propósito: es tiempo cumplido, no tiempo prometido. Decir "llevas 4
   * horas" cuando lleva 3 con 50 minutos es cobrarle al club un minuto que no fue.
   */
  function minutesOnShift(shifts, now) {
    const open = openShift(shifts);
    if (!open || !open.started_at) return 0;
    const when = now ? new Date(now) : new Date();
    return Math.max(0, Math.floor((when - new Date(open.started_at)) / 60000));
  }

  /**
   * Lo que hay que decirle al empleado sobre su turno, con su consecuencia.
   *
   * Sin turno no aparece en la lista de nadie. Es la única explicación de por qué una
   * noche entera puede pasar sin una sola propina, y tiene que estar escrita donde se
   * ve, no deducirse.
   */
  function headline(shifts, now) {
    if (!isOpen(shifts)) return { key: 'shift.closedNote', vars: null, working: false };
    return {
      key: 'shift.openNote',
      vars: { minutes: minutesOnShift(shifts, now) },
      working: true,
    };
  }

  // ---------------------------------------------------------------- tragos invitados

  const PENDING = 'pending';

  /** Los tragos que esperan respuesta, el más viejo primero: alguien está esperando. */
  function pendingDrinks(drinks) {
    return (drinks || [])
      .filter((d) => d && d.status === PENDING)
      .slice()
      .sort((a, b) => new Date(a.created_at || 0) - new Date(b.created_at || 0));
  }

  const STATUS_KEY = {
    pending: 'drink.stPending',
    confirmed: 'drink.stAccepted',
    declined: 'drink.stDeclined',
  };

  const statusLabel = (status) => STATUS_KEY[status] || 'drink.stPending';

  /**
   * Lo que se le advierte al empleado ANTES de rechazar un trago.
   *
   * Rechazar no cancela nada: el trago ya se cobró al cliente cuando lo pidió y se
   * regresa a su mesa (D20). El empleado tiene derecho a decir que no, y el cliente
   * tiene derecho a no perder su dinero — pero quien rechaza debe saber que del otro
   * lado hay una persona esperando en una mesa, no un botón.
   */
  const declineWarning = () => 'drink.declineNote';

  /** Suma lo invitado esta noche, por moneda, sin contar lo rechazado. */
  function drinkTotals(drinks) {
    const totals = new Map();
    for (const d of (drinks || [])) {
      if (d.status === 'declined') continue;
      const cur = d.currency || 'MXN';
      totals.set(cur, (totals.get(cur) || 0) + cents(d.amount));
    }
    return [...totals.entries()]
      .map(([currency, c]) => ({ currency, amount: (c / 100).toFixed(2) }))
      .sort((a, b) => cents(b.amount) - cents(a.amount));
  }

  /**
   * Los eventos del socket que mueven esta pantalla.
   *
   * El tipo real vive en `event_type`; `type` siempre vale 'event'. Leerlo del campo
   * equivocado ya dejó una pantalla muda una vez.
   */
  const SHIFT_EVENTS = ['staff_drink_received', 'shift_started', 'shift_ended'];

  const affectsShift = (message) => SHIFT_EVENTS
    .includes(message && (message.event_type || message.type));

  return {
    SHIFT_EVENTS,
    openShift,
    isOpen,
    shiftButton,
    minutesOnShift,
    headline,
    pendingDrinks,
    statusLabel,
    declineWarning,
    drinkTotals,
    affectsShift,
  };
}));
