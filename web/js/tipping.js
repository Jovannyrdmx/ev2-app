/**
 * EV2 — dar propina e invitar un trago al personal (paso 5.2, pantalla del cliente).
 *
 * Este módulo decide qué se le enseña al cliente y qué se le deja mandar. Importa
 * porque una propina es dinero que sale de su bolsillo de golpe, en la oscuridad y con
 * una sola mano: si el botón manda un importe distinto al que se ve, o deja pedir algo
 * que el servidor va a rechazar, el cliente pierde la confianza en toda la app.
 *
 * El servidor manda los importes como cadena decimal. Aquí se comparan en centavos
 * enteros, nunca en float.
 *
 * Sin DOM a propósito: todo esto se prueba en Node.
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EV2Tipping = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const toCents = (value) => {
    if (value === null || value === undefined || value === '') return 0;
    const n = Math.round(Number(value) * 100);
    return Number.isFinite(n) ? n : 0;
  };
  const money = (value) => (toCents(value) / 100).toFixed(2);

  /**
   * Orden en que se enseña el personal en turno.
   *
   * Primero a quien el cliente tiene enfrente —la bailarina del show, el mesero de su
   * mesa— y al final quien trabaja lejos de la vista. Dentro de cada rol, por nombre,
   * para que la lista no se reacomode sola cada vez que llega un evento y el dedo
   * termine tocando a otra persona.
   */
  const ROLE_ORDER = ['dancer', 'dj', 'waiter', 'bartender', 'hostess', 'light_tech', 'valet', 'driver'];

  const roleRank = (role) => {
    const i = ROLE_ORDER.indexOf(role);
    return i === -1 ? ROLE_ORDER.length : i;
  };

  /** Agrupa al personal en turno por rol, en el orden de arriba. Grupos vacíos, fuera. */
  function byRole(staff) {
    const groups = new Map();
    for (const person of (staff || [])) {
      if (!person || !person.id) continue;
      const role = person.role || 'other';
      if (!groups.has(role)) groups.set(role, []);
      groups.get(role).push(person);
    }
    return [...groups.entries()]
      .map(([role, people]) => ({
        role,
        label: (people[0] && people[0].role_label) || role,
        icon: (people[0] && people[0].icon) || null,
        people: people.slice().sort((a, b) => String(a.display_name || '')
          .localeCompare(String(b.display_name || ''), 'es')),
      }))
      .sort((a, b) => roleRank(a.role) - roleRank(b.role));
  }

  /**
   * Los importes que se ofrecen de un toque.
   *
   * Se toman los sugeridos del club, se quita cualquiera por debajo del mínimo de ese
   * rol (ofrecer un botón que el servidor rechaza es la peor forma de enterarse) y, si
   * no queda ninguno, se cae al mínimo para que siempre haya al menos un botón.
   */
  function presetAmounts(person) {
    const min = toCents(person && person.min_tip);
    const list = ((person && person.suggested) || [])
      .map((v) => toCents(v))
      .filter((c) => c > 0 && c >= min);
    const unique = [...new Set(list)].sort((a, b) => a - b);
    if (unique.length) return unique.map((c) => (c / 100).toFixed(2));
    return min > 0 ? [(min / 100).toFixed(2)] : [];
  }

  /**
   * Comprueba el importe de la propina antes de mandarla. Devuelve la clave del error
   * o null. El mínimo lo pone el club por rol y el servidor lo vuelve a comprobar.
   */
  function validateTip(amount, person) {
    const cents = toCents(amount);
    if (!(Number(amount) > 0) || cents <= 0) return 'tip.errAmount';
    const min = toCents(person && person.min_tip);
    if (min > 0 && cents < min) return 'tip.errMin';
    // Tope del servidor: amount.max(100_000). Se corta aquí para que el cliente no
    // mande un dedazo de seis ceros y reciba un 422 sin explicación.
    if (cents > 100000 * 100) return 'tip.errMax';
    return null;
  }

  /** Lo que se manda al crear una propina. El id de petición lo pone quien llama. */
  function tipPayload(person, amount, opts) {
    const o = opts || {};
    const body = {
      client_request_id: o.clientRequestId,
      to_user_id: person.id,
      amount: Number(money(amount)),
      currency: person.currency || 'MXN',
      anonymous: !!o.anonymous,
    };
    const message = String(o.message || '').trim();
    if (message) body.message = message.slice(0, 280);
    return body;
  }

  // ------------------------------------------------------- invitar un trago

  /**
   * Por qué NO se puede invitar un trago ahora mismo. Devuelve la clave del motivo o
   * null. Son tres condiciones distintas y mandan al cliente a lugares distintos: al
   * rol no se le invitan tragos nunca, esa persona ya se fue, o el cliente todavía no
   * se sienta (el trago se carga a su mesa).
   */
  function drinkBlocker(person, table) {
    if (!person || !person.accepts_drinks) return 'tip.errNoDrinks';
    if (!person.started_at) return 'tip.errOffShift';
    if (!table || !table.id) return 'tip.errNoTable';
    return null;
  }

  /** Lo que se manda al invitar un trago. */
  function drinkPayload(drinkId, opts) {
    const o = opts || {};
    const body = {
      client_request_id: o.clientRequestId,
      drink_id: drinkId,
      quantity: Math.min(5, Math.max(1, Number(o.quantity) || 1)),
    };
    const message = String(o.message || '').trim();
    if (message) body.message = message.slice(0, 140);
    return body;
  }

  // ------------------------------------------------------- pestañas por rol

  /**
   * Las pestañas de la pantalla, una por rol con gente en turno, en el orden de
   * ROLE_ORDER (primero quien el cliente tiene enfrente). La pantalla añade "Música" y
   * "Reconocimiento" al final; esas dos no dependen de quién esté trabajando.
   *
   * Se expone aparte de `byRole` para que el controlador no tenga que conocer el orden
   * ni cómo se saca la etiqueta de cada rol.
   */
  function roleTabs(staff) {
    return byRole(staff).map((g) => ({ key: g.role, label: g.label, count: g.people.length }));
  }

  // ------------------------------------------------------- reconocimiento

  /**
   * Normaliza la respuesta de `GET /leaderboard` para la pantalla del cliente.
   *
   * A un invitado la API le entrega solo `rank`, `display_name`, `role` y `fans`
   * (cuántas personas distintas le dieron propina) — nunca montos, decidido en el paso
   * 2.5. Si llegara la forma del personal (con `total_mxn`, etc.) esos campos se
   * ignoran aquí a propósito: esta es la vista del cliente.
   */
  function boardRows(payload) {
    const list = (payload && payload.leaderboard) || [];
    return list
      .filter((r) => r && r.user_id)
      .map((r, i) => ({
        rank: Number(r.rank) > 0 ? Number(r.rank) : i + 1,
        userId: r.user_id,
        name: r.display_name || '',
        role: r.role || null,
        fans: Number(r.fans) > 0 ? Number(r.fans) : 0,
      }));
  }

  // ------------------------------------------------------- lo ya dado

  /** Suma lo que el cliente lleva dado esta noche, por moneda. La mayor primero. */
  function givenTotals(tips) {
    const totals = new Map();
    for (const tip of (tips || [])) {
      if (tip.status === 'cancelled') continue;
      const cur = tip.currency || 'MXN';
      totals.set(cur, (totals.get(cur) || 0) + toCents(tip.amount));
    }
    return [...totals.entries()]
      .map(([currency, cents]) => ({ currency, amount: (cents / 100).toFixed(2) }))
      .sort((a, b) => toCents(b.amount) - toCents(a.amount));
  }

  const STATUS_KEY = {
    pending: 'tip.stPending',
    paid: 'tip.stPaid',
    cancelled: 'tip.stCancelled',
  };

  const statusLabel = (status) => STATUS_KEY[status] || 'tip.stPending';

  /**
   * Un evento del socket que toca a esta pantalla. Ojo: el marco real trae el tipo en
   * `event_type`; `type` siempre vale 'event'. Leer `type` fue un error que ya costó
   * una pantalla muda una vez.
   */
  const TIP_EVENTS = ['tip_received', 'song_tip_received', 'staff_drink_received', 'shift_started', 'shift_ended'];

  const affectsTips = (message) => TIP_EVENTS
    .includes(message && (message.event_type || message.type));

  return {
    ROLE_ORDER,
    TIP_EVENTS,
    toCents,
    money,
    roleRank,
    byRole,
    roleTabs,
    boardRows,
    presetAmounts,
    validateTip,
    tipPayload,
    drinkBlocker,
    drinkPayload,
    givenTotals,
    statusLabel,
    affectsTips,
  };
}));
