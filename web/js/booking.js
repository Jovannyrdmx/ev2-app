/**
 * EV2 — reservar mesa para otra noche (paso 5.3).
 *
 * Reservar no se parece a nada más de la app: el cliente no está en el club, está en su
 * casa decidiendo si gasta. Lo que se le enseña tiene que cuadrar al peso con lo que va
 * a pagar, y tiene que quedar claro qué se le cobra HOY (el anticipo) y qué el día del
 * evento. Un número que baila entre la pantalla y el cargo es la forma más rápida de
 * perder a un cliente para siempre.
 *
 * El precio SIEMPRE lo pone el servidor. Aquí nunca se calcula un total para cobrarlo:
 * se calcula solo para avisar, y lo que se manda es la cotización que el servidor
 * devolvió.
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EV2Booking = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const cents = (value) => {
    if (value === null || value === undefined || value === '') return 0;
    const n = Math.round(Number(value) * 100);
    return Number.isFinite(n) ? n : 0;
  };
  const money = (c) => (c / 100).toFixed(2);

  // ---------------------------------------------------------------- eventos

  /**
   * Las noches que se pueden reservar, la más cercana primero.
   *
   * Se filtran las canceladas y las que ya pasaron: enseñar una noche que ya fue, y
   * dejar tocarla, termina en un error del servidor que el cliente lee como una falla
   * de la app.
   */
  function bookableEvents(events, now) {
    const when = now ? new Date(now) : new Date();
    return (events || [])
      .filter((e) => e && e.id && e.status !== 'cancelled' && e.status !== 'finished')
      // Hasta que la noche TERMINA, no hasta que abre: se reserva con el evento en curso.
      .filter((e) => !e.doors_open_at || nightEnd(e) > when)
      .sort((a, b) => new Date(a.event_date || a.doors_open_at || 0)
        - new Date(b.event_date || b.doors_open_at || 0));
  }

  /**
   * Cuántas horas faltan para que abran las puertas. Sirve para avisar antes de tocar
   * que las reservaciones de esa noche ya cerraron.
   */
  function hoursUntilDoors(event, now) {
    if (!event || !event.doors_open_at) return Infinity;
    const when = now ? new Date(now) : new Date();
    return (new Date(event.doors_open_at) - when) / 3600000;
  }

  /**
   * Cuándo termina la noche: el cierre publicado, o 8 horas después de abrir. Es la
   * misma cuenta que hace el servidor (`eventPricing.nightEnd`).
   */
  function nightEnd(event) {
    if (event && event.closes_at) return new Date(event.closes_at);
    if (event && event.doors_open_at) return new Date(new Date(event.doors_open_at).getTime() + 8 * 3600000);
    return new Date(8640000000000000);
  }

  /**
   * Si esa noche todavía admite reservaciones: mientras no haya terminado.
   *
   * Antes cerraban unas horas antes de abrir (`min_advance_hours`). El dueño quitó esa
   * regla el 2026-09-21: se reserva siempre, incluso con el evento en curso, mientras
   * nadie más tenga la mesa. El servidor vuelve a comprobarlo y contesta 422 si ya
   * terminó.
   */
  function isOpenForBooking(event, now) {
    if (!event) return false;
    const when = now ? new Date(now) : new Date();
    return nightEnd(event) > when;
  }

  // ---------------------------------------------------------------- mesas

  /**
   * Ordena las mesas disponibles: primero las más baratas.
   *
   * Alguien que abre la pantalla de reservaciones está decidiendo cuánto gastar, no
   * qué zona le gusta. Enseñarle primero la mesa de doce mil pesos hace que cierre la
   * app. Con el mismo precio, se respeta el orden que ya trae el servidor (piso,
   * sección, número), para que la lista no salte entre recargas.
   */
  function tablesByPrice(tables) {
    return (tables || []).map((t, i) => ({ t, i }))
      .sort((a, b) => (cents(a.t.price) - cents(b.t.price)) || (a.i - b.i))
      .map((x) => x.t);
  }

  /** Agrupa las mesas por zona, en el orden de la más barata de cada zona. */
  function tablesByZone(tables) {
    const groups = new Map();
    for (const table of tablesByPrice(tables)) {
      const key = table.section || '—';
      if (!groups.has(key)) groups.set(key, { section: key, tables: [], from: table.price });
      groups.get(key).tables.push(table);
    }
    return [...groups.values()].sort((a, b) => cents(a.from) - cents(b.from));
  }

  /** El anticipo que toca a un precio, con el porcentaje del club. Se redondea al peso. */
  function depositFor(price, depositPct) {
    const pct = Number(depositPct);
    if (!Number.isFinite(pct) || pct <= 0) return '0.00';
    return money(Math.round(cents(price) * pct / 100));
  }

  // ---------------------------------------------------------------- cotización

  /**
   * Desglosa una cotización del servidor en renglones para enseñar.
   *
   * Se enseña TODO lo que compone el total, incluidos los invitados extra y el
   * descuento: el cliente que ve solo el total no sabe si le cobraron de más, y el que
   * no entiende el cargo lo disputa con su banco.
   */
  function quoteLines(quote) {
    if (!quote) return [];
    const lines = [];
    const push = (key, amount, vars) => {
      if (cents(amount) !== 0) lines.push({ key, amount: money(cents(amount)), vars: vars || null });
    };
    // El precio de la mesa vive en `zone.base_price`, no suelto en la cotización:
    // leerlo del lugar equivocado deja el renglón principal en cero y el desglose no
    // suma al total que se cobra.
    push('book.lineTable', quote.zone && quote.zone.base_price);
    if (Number(quote.extra_guests) > 0) {
      push('book.lineExtras', quote.extras_total, { count: Number(quote.extra_guests) });
    }
    for (const addon of (quote.addons || [])) {
      const total = cents(addon.price) * (Number(addon.quantity) || 1);
      if (total) {
        lines.push({
          key: 'book.lineAddon',
          amount: money(total),
          vars: { name: addon.name || addon.code || '', quantity: Number(addon.quantity) || 1 },
        });
      }
    }
    if (quote.discount && cents(quote.discount.amount) > 0) {
      lines.push({
        key: 'book.lineDiscount',
        amount: `-${money(cents(quote.discount.amount))}`,
        vars: { code: quote.discount.code || '' },
      });
    }
    return lines;
  }

  /**
   * Los dos números que de verdad importan: lo que se paga hoy y lo que queda para la
   * noche del evento. Separados a propósito — meterlos en un solo "total" es lo que
   * hace que el cliente crea que le cobraron todo por adelantado.
   */
  function payNow(quote) {
    if (!quote) return { deposit: '0.00', rest: '0.00', total: '0.00', currency: 'MXN' };
    const total = cents(quote.total !== undefined ? quote.total : quote.subtotal);
    const deposit = Math.min(total, cents(quote.deposit));
    return {
      deposit: money(deposit),
      rest: money(total - deposit),
      total: money(total),
      currency: quote.currency || 'MXN',
    };
  }

  // ---------------------------------------------------------------- validación

  /**
   * Por qué no se puede reservar todavía. Devuelve la clave del motivo o null.
   * `rules` son las del club: el mínimo de personas.
   */
  function bookingBlocker(form, rules, now) {
    const r = rules || {};
    if (!form || !form.event) return 'book.errNoEvent';
    if (!form.table) return 'book.errNoTable';
    const guests = Number(form.guests);
    const min = Number(r.min_party_size) || 1;
    if (!Number.isInteger(guests) || guests < 1) return 'book.errGuests';
    if (guests < min) return 'book.errMinParty';
    if (!isOpenForBooking(form.event, now)) return 'book.errClosed';
    return null;
  }

  /** Lo que se manda al reservar. El precio no viaja: lo vuelve a calcular el servidor. */
  function bookingPayload(form, opts) {
    const o = opts || {};
    const body = {
      client_request_id: o.clientRequestId,
      event_id: form.event.id,
      table_id: form.table.id,
      guest_count: Number(form.guests),
      addons: form.addons || [],
    };
    const notes = String(form.notes || '').trim();
    if (notes) body.special_requests = notes.slice(0, 500);
    const code = String(form.discountCode || '').trim();
    if (code) body.discount_code = code.slice(0, 40);
    return body;
  }

  // ---------------------------------------------------------------- mis reservaciones

  const STATUS_KEY = {
    pending_payment: 'book.stPending',
    confirmed: 'book.stConfirmed',
    seated: 'book.stSeated',
    cancelled: 'book.stCancelled',
    no_show: 'book.stNoShow',
    completed: 'book.stCompleted',
  };

  const statusLabel = (status) => STATUS_KEY[status] || 'book.stPending';

  const LIVE = ['pending_payment', 'confirmed', 'seated'];

  /** Las reservaciones que todavía significan algo, la más próxima primero. */
  function upcoming(reservations, now) {
    const when = now ? new Date(now) : new Date();
    return (reservations || [])
      .filter((r) => LIVE.includes(r.status))
      // Hasta que termina la noche. Antes desaparecía al abrir las puertas, o sea que
      // quien llegaba con su reservación ya no veía su pase en el teléfono justo en la
      // fila de la entrada — y quien reserva con el evento en curso no lo veía nunca.
      .filter((r) => {
        if (r.ends_at) return new Date(r.ends_at) > when;
        return !r.doors_open_at || nightEnd(r) > when;
      })
      .sort((a, b) => new Date(a.doors_open_at || 0) - new Date(b.doors_open_at || 0));
  }

  /**
   * Si todavía se puede cancelar. El servidor decide de verdad; esto solo evita
   * enseñar un botón que va a fallar. Una reservación ya sentada no se cancela: el
   * cliente está adentro.
   */
  const canCancel = (reservation) => ['pending_payment', 'confirmed'].includes(reservation && reservation.status);

  /**
   * Cuánto falta para tener que estar en la puerta. El club libera la mesa pasada esa
   * hora, así que el cliente tiene que verlo antes de salir de su casa, no después.
   * Los minutos se redondean hacia arriba.
   */
  function arrivalCountdown(reservation, now) {
    const deadline = reservation && (reservation.arrival_deadline || reservation.doors_open_at);
    if (!deadline) return null;
    const when = now ? new Date(now) : new Date();
    const minutes = Math.ceil((new Date(deadline) - when) / 60000);
    return { minutes, expired: minutes <= 0, deadline: new Date(deadline).toISOString() };
  }

  return {
    LIVE,
    cents,
    money,
    bookableEvents,
    hoursUntilDoors,
    nightEnd,
    isOpenForBooking,
    tablesByPrice,
    tablesByZone,
    depositFor,
    quoteLines,
    payNow,
    bookingBlocker,
    bookingPayload,
    statusLabel,
    upcoming,
    canCancel,
    arrivalCountdown,
  };
}));
