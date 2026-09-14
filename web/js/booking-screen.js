/**
 * EV2 — reservar mesa para otra noche, desde la pantalla del cliente (paso 5.3).
 *
 * Solo conecta el DOM con `EV2Booking`. El precio SIEMPRE viene del servidor: aquí no
 * se calcula ningún total para cobrarlo, solo se pinta el que la cotización devolvió.
 * Un número distinto entre pantalla y cargo es lo que hace que un cliente dispute el
 * pago con su banco.
 */
/* global EV2Screen, EV2Booking */
(function () {
  'use strict';

  if (!window.EV2Screen) return;

  const $ = (id) => document.getElementById(id);
  const uuid = () => (window.crypto && window.crypto.randomUUID
    ? window.crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}-${Math.random().toString(16).slice(2)}`);

  let ctx = null;
  const state = {
    events: [], rules: {}, tables: [], mine: [],
    event: null, table: null, guests: 2, quote: null,
    // Se fija al abrir el panel: si el dedo toca dos veces "Reservar", el servidor
    // reconoce el repetido y devuelve la misma reservación en vez de apartar dos mesas.
    requestId: null,
    loading: false,
  };

  const t = (key, vars) => (vars ? ctx.t(key, vars) : ctx.t(key));
  const showError = (text) => { const el = $('book-error'); el.textContent = text; el.hidden = false; };
  const hideError = () => { $('book-error').hidden = true; };

  // ---------------------------------------------------------------- carga

  async function loadEvents() {
    const club = ctx.clubId();
    if (!club) return;
    const [events, rules] = await Promise.all([
      ctx.api.get(`/nightclubs/${club}/events?upcoming=true&limit=30`),
      ctx.api.get(`/nightclubs/${club}/reservations/rules`).catch(() => ({ rules: {} })),
    ]);
    state.rules = rules.rules || {};
    state.events = EV2Booking.bookableEvents(events.events, new Date());
    renderEvents();
  }

  async function loadMine() {
    const club = ctx.clubId();
    if (!club) return;
    const data = await ctx.api.get(`/nightclubs/${club}/reservations/mine?limit=20`);
    state.mine = data.reservations || [];
    renderMine();
  }

  async function loadTables() {
    if (!state.event) { state.tables = []; renderTables(); return; }
    const club = ctx.clubId();
    const query = `event_id=${encodeURIComponent(state.event.id)}&guests=${state.guests}`;
    try {
      const data = await ctx.api.get(`/nightclubs/${club}/reservations/availability?${query}`);
      state.tables = data.tables || [];
      hideError();
    } catch (err) {
      // Aquí el 422 es información útil ("las reservaciones de esa noche ya cerraron"),
      // no una falla: se muestra tal cual en vez de dejar la lista vacía sin explicar.
      state.tables = [];
      showError(window.EV2Format.errorMessage(err));
    }
    state.table = null;
    state.quote = null;
    renderTables();
    renderQuote();
  }

  // ---------------------------------------------------------------- pintado

  function renderEvents() {
    const select = $('book-event');
    select.innerHTML = '';
    $('book-no-events').hidden = state.events.length > 0;

    for (const event of state.events) {
      const opt = document.createElement('option');
      opt.value = event.id;
      const date = event.doors_open_at || event.event_date;
      opt.textContent = `${event.name} — ${window.EV2Format.date(date)}`;
      select.appendChild(opt);
    }
    state.event = state.events[0] || null;
    if (state.event) select.value = state.event.id;

    const guests = $('book-guests');
    guests.innerHTML = '';
    const min = Math.max(1, Number(state.rules.min_party_size) || 1);
    for (let n = min; n <= 30; n += 1) {
      const opt = document.createElement('option');
      opt.value = String(n);
      opt.textContent = String(n);
      guests.appendChild(opt);
    }
    state.guests = Math.max(state.guests, min);
    guests.value = String(state.guests);
  }

  function renderTables() {
    const box = $('book-tables');
    box.innerHTML = '';
    $('book-no-tables').hidden = state.tables.length > 0 || !state.event;

    for (const zone of EV2Booking.tablesByZone(state.tables)) {
      const head = document.createElement('p');
      head.className = 'text-xs uppercase tracking-wider pt-1';
      head.style.color = 'var(--ev2-pink)';
      head.textContent = `${zone.section} · ${t('book.from', { amount: ctx.money(zone.from) })}`;
      box.appendChild(head);

      for (const table of zone.tables) {
        const b = document.createElement('button');
        const chosen = state.table && state.table.id === table.id;
        b.className = `w-full rounded-xl px-3 py-3 flex justify-between items-center text-sm ${chosen ? 'ev2-button' : 'card'}`;
        const left = document.createElement('span');
        left.textContent = `${table.code || table.table_number} · ${table.capacity || '—'}`;
        const right = document.createElement('span');
        right.className = 'font-display';
        right.textContent = ctx.money(table.price, table.currency);
        b.append(left, right);
        b.onclick = () => pickTable(table);
        box.appendChild(b);
      }
    }
  }

  function renderQuote() {
    const box = $('book-quote');
    if (!state.quote) { box.hidden = true; $('btn-book-confirm').disabled = true; return; }
    box.hidden = false;

    const lines = $('book-quote-lines');
    lines.innerHTML = '';
    for (const line of EV2Booking.quoteLines(state.quote)) {
      const row = document.createElement('div');
      row.className = 'flex justify-between text-white/70';
      const label = document.createElement('span');
      label.textContent = line.vars ? t(line.key, line.vars) : t(line.key);
      const amount = document.createElement('span');
      amount.textContent = ctx.money(line.amount, state.quote.currency);
      row.append(label, amount);
      lines.appendChild(row);
    }

    const pay = EV2Booking.payNow(state.quote);
    $('book-total').textContent = ctx.money(pay.total, pay.currency);
    $('book-deposit').textContent = ctx.money(pay.deposit, pay.currency);
    $('book-rest').textContent = ctx.money(pay.rest, pay.currency);
    $('btn-book-confirm').disabled = false;
  }

  /**
   * El pase a pantalla completa.
   *
   * El QR se pide al servidor una vez y se guarda en el teléfono: adentro del club
   * casi no hay señal, y el pase tiene que abrir igual cuando el cliente ya está
   * en la fila. Si no se puede pedir y no hay copia guardada, se enseña el código
   * escrito, que es con lo que la puerta puede teclear igual.
   */
  async function openPass(reservation) {
    const guardado = `ev2.pass.${reservation.id}`;
    $('pass-where').textContent = [reservation.event_name, reservation.table_code]
      .filter(Boolean).join(' · ');
    $('pass-when').textContent = reservation.doors_open_at
      ? window.EV2Format.dateTime(reservation.doors_open_at) : '';
    $('pass-code').textContent = reservation.pass_code || '—';
    $('pass-used').hidden = !reservation.checked_in_at;
    if (reservation.checked_in_at) {
      $('pass-used').textContent = t('pass.usedAt',
        { time: window.EV2Format.time(reservation.checked_in_at) });
    }
    $('pass-error').hidden = true;
    $('pass-qr').innerHTML = '';
    $('pass-sheet').hidden = false;
    // Los pases de los invitados, en paralelo: la hoja ya se abrió y el QR del
    // titular es lo que tiene que aparecer primero.
    loadPasses(reservation.id).catch(() => {});

    let svg = null;
    try { svg = window.localStorage.getItem(guardado); } catch { svg = null; }
    if (svg) { $('pass-qr').innerHTML = svg; return; }

    try {
      const data = await ctx.api.get(
        `/nightclubs/${ctx.clubId()}/reservations/${reservation.id}/pass`);
      // El SVG lo genera nuestro servidor, no viene de un tercero.
      $('pass-qr').innerHTML = data.pass.qr_svg;
      try { window.localStorage.setItem(guardado, data.pass.qr_svg); } catch { /* sin espacio */ }
    } catch {
      // Sin QR, el código escrito basta: la puerta lo teclea.
      $('pass-error').textContent = t('pass.noQr');
      $('pass-error').hidden = false;
    }
  }

  // ---------------------------------------------------------------- los pases de la mesa

  /**
   * Los pases de los invitados, desde el teléfono del titular.
   *
   * Cada uno es de una persona y sirve una vez. Lo que el titular hace aquí es lo
   * único que este sistema le pide: ponerles nombre, mandarlos por WhatsApp, y
   * cambiarlos cuando alguien no viene.
   *
   * El QR NO se pide aquí. La lista solo trae códigos; el payload firmado se pide
   * pase por pase, al momento de compartirlo, porque es la credencial: mandarlo en
   * cada renglón lo dejaría en la caché del navegador y en el historial.
   */
  const passes = { reservationId: null, rows: [], summary: null, busy: null, ask: null };

  const gpError = (text) => {
    const el = $('gp-error');
    el.textContent = text || '';
    el.hidden = !text;
  };

  function renderPasses() {
    const bloque = $('gp-block');
    if (!passes.rows.length) { bloque.hidden = true; return; }
    bloque.hidden = false;

    const s = passes.summary || {};
    $('gp-summary').textContent = t('gp.summary', {
      active: s.active || 0, used: s.used || 0,
    });

    let n = 0;
    $('gp-list').innerHTML = passes.rows.map((p) => {
      const esTitular = p.kind === 'holder';
      if (!esTitular) n += 1;
      const nombre = p.label || (esTitular ? t('gp.holder') : t('gp.guest', { n }));
      const muerto = p.status !== 'active';

      let estado = '';
      if (p.status === 'used') {
        estado = p.used_at
          ? t('gp.usedAt', { time: window.EV2Format.time(p.used_at) })
          : t('scan.used');
      } else if (p.status === 'revoked') {
        estado = t('gp.revoked', { reason: p.revoke_reason || '' });
      } else if (p.share_count > 0) {
        estado = t('gp.shared', { count: p.share_count });
      }

      // El titular no reparte su propio pase ni lo reasigna: es el suyo. Y un pase
      // gastado no ofrece ningún botón, porque esa persona ya está adentro.
      const acciones = (esTitular || muerto) ? '' : `
        <div class="flex flex-wrap gap-1 mt-2">
          <button data-gp-share="${p.id}" class="px-3 py-1.5 rounded-full text-[11px] ev2-button">
            ${p.share_count > 0 ? t('gp.reshare') : t('gp.share')}
          </button>
          <button data-gp-reassign="${p.id}" class="px-3 py-1.5 rounded-full text-[11px] card">
            ${t('gp.reassign')}
          </button>
          <button data-gp-revoke="${p.id}" class="px-3 py-1.5 rounded-full text-[11px] card">
            ${t('gp.revoke')}
          </button>
        </div>`;

      return `
        <div class="rounded-xl p-3 card ${muerto ? 'opacity-50' : ''}">
          <div class="flex items-baseline justify-between gap-2">
            <p class="text-sm font-medium truncate">${escapeHtml(nombre)}</p>
            <p class="font-display text-xs tracking-widest text-white/50">${escapeHtml(p.code)}</p>
          </div>
          ${estado ? `<p class="text-[11px] text-white/40 mt-0.5">${escapeHtml(estado)}</p>` : ''}
          ${acciones}
        </div>`;
    }).join('');

    for (const b of $('gp-list').querySelectorAll('[data-gp-share]')) {
      b.onclick = () => compartirPase(b.dataset.gpShare);
    }
    for (const b of $('gp-list').querySelectorAll('[data-gp-revoke]')) {
      b.onclick = () => pedirMotivo('revoke', b.dataset.gpRevoke);
    }
    for (const b of $('gp-list').querySelectorAll('[data-gp-reassign]')) {
      b.onclick = () => pedirMotivo('reassign', b.dataset.gpReassign);
    }
  }

  const escapeHtml = (v) => String(v == null ? '' : v).replace(/[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  async function loadPasses(reservationId) {
    passes.reservationId = reservationId;
    passes.rows = [];
    passes.summary = null;
    gpError('');
    $('gp-block').hidden = true;
    try {
      const data = await ctx.api.get(
        `/nightclubs/${ctx.clubId()}/reservations/${reservationId}/passes`);
      passes.rows = data.passes || [];
      passes.summary = data.summary || null;
      renderPasses();
    } catch {
      // Sin la lista, el titular todavía tiene su propio pase arriba, que es lo que
      // necesita para entrar. No se le grita un error por lo secundario.
      $('gp-block').hidden = true;
    }
  }

  /**
   * Abrir WhatsApp con el mensaje ya escrito.
   *
   * El servidor devuelve el texto y el enlace; el teléfono del titular abre su propia
   * app. Así el invitado recibe el mensaje del número de su amigo, que es el número
   * del que hace caso, en vez de uno desconocido del club.
   *
   * `navigator.share` primero cuando existe: deja elegir WhatsApp, Telegram o un
   * mensaje de texto, que es lo que de verdad usa la gente.
   */
  async function compartirPase(passId) {
    if (passes.busy) return;
    passes.busy = passId;
    gpError('');
    try {
      const data = await ctx.api.post(
        `/nightclubs/${ctx.clubId()}/reservations/${passes.reservationId}/passes/${passId}/share`,
        { lang: window.EV2Format.getLanguage() });
      const share = data.share;
      let compartido = false;
      if (navigator.share) {
        try {
          await navigator.share({ text: share.text });
          compartido = true;
        } catch {
          // El usuario canceló, o el navegador lo bloqueó: se cae a WhatsApp.
          compartido = false;
        }
      }
      if (!compartido) window.open(share.whatsapp_url, '_blank', 'noopener');
      await loadPasses(passes.reservationId);
    } catch (err) {
      gpError(window.EV2Format.errorMessage(err));
    } finally {
      passes.busy = null;
    }
  }

  function pedirMotivo(accion, passId) {
    passes.ask = { accion, passId };
    $('gp-reason-title').textContent = t(accion === 'revoke' ? 'gp.revoke' : 'gp.reassign');
    $('btn-gp-reason-go').textContent = t(accion === 'revoke' ? 'gp.revoke' : 'gp.reassign');
    // Al reasignar se pregunta también el nombre del que viene en su lugar: es lo
    // siguiente que el titular va a querer escribir, y pedirlo después sería otra
    // pantalla más.
    $('gp-reason-name').hidden = accion !== 'reassign';
    $('gp-reason-name').value = '';
    $('gp-reason-text').value = '';
    $('gp-reason-error').hidden = true;
    $('gp-reason-sheet').hidden = false;
    $('gp-reason-text').focus();
  }

  const cerrarMotivo = () => { $('gp-reason-sheet').hidden = true; passes.ask = null; };

  async function confirmarMotivo() {
    if (!passes.ask) return;
    const { accion, passId } = passes.ask;
    const motivo = $('gp-reason-text').value.trim();
    if (motivo.length < 3) {
      $('gp-reason-error').textContent = t('gp.errReason');
      $('gp-reason-error').hidden = false;
      return;
    }
    $('btn-gp-reason-go').disabled = true;
    try {
      const base = `/nightclubs/${ctx.clubId()}/reservations/${passes.reservationId}/passes/${passId}`;
      if (accion === 'revoke') {
        await ctx.api.post(`${base}/revoke`, { reason: motivo });
      } else {
        const data = await ctx.api.post(`${base}/reassign`, {
          reason: motivo, label: $('gp-reason-name').value.trim() || undefined,
        });
        cerrarMotivo();
        await loadPasses(passes.reservationId);
        // Y se ofrece mandarlo en el acto: un pase nuevo que nadie reparte es una
        // silla vacía.
        if (data.share) {
          if (navigator.share) {
            try { await navigator.share({ text: data.share.text }); } catch { /* canceló */ }
          } else {
            window.open(data.share.whatsapp_url, '_blank', 'noopener');
          }
        }
        return;
      }
      cerrarMotivo();
      await loadPasses(passes.reservationId);
    } catch (err) {
      $('gp-reason-error').textContent = window.EV2Format.errorMessage(err);
      $('gp-reason-error').hidden = false;
    } finally {
      $('btn-gp-reason-go').disabled = false;
    }
  }

  function renderMine() {
    const list = EV2Booking.upcoming(state.mine, new Date());
    $('book-none').hidden = list.length > 0;
    const box = $('book-list');
    box.innerHTML = '';

    for (const r of list) {
      const card = document.createElement('div');
      card.className = 'card rounded-xl p-3 space-y-1';

      const head = document.createElement('div');
      head.className = 'flex justify-between items-start gap-3';
      const left = document.createElement('div');
      left.className = 'min-w-0';
      const title = document.createElement('p');
      title.className = 'font-display truncate';
      title.textContent = `${r.event_name || ''} · ${r.table_code || ''}`;
      const when = document.createElement('p');
      when.className = 'text-[11px] text-white/40';
      when.textContent = window.EV2Format.dateTime(r.doors_open_at);
      left.append(title, when);
      const status = document.createElement('span');
      status.className = 'text-xs shrink-0';
      status.textContent = t(EV2Booking.statusLabel(r.status));
      head.append(left, status);
      card.appendChild(head);

      // La hora de llegada va en la tarjeta, no escondida: pasada esa hora el club
      // libera la mesa, y el cliente tiene que verlo antes de salir de su casa.
      const countdown = EV2Booking.arrivalCountdown(r, new Date());
      if (countdown) {
        const note = document.createElement('p');
        note.className = countdown.expired ? 'text-[11px] text-red-300' : 'text-[11px] text-white/50';
        note.textContent = countdown.expired
          ? t('book.arriveLate')
          : t('book.arriveBy', { time: window.EV2Format.time(countdown.deadline) });
        card.appendChild(note);
      }

      // El pase, en la tarjeta. Es lo primero que el cliente busca al llegar al club,
      // así que no se esconde detrás de un "ver detalle".
      if (r.pass_code && ['confirmed', 'pending_payment', 'seated'].includes(r.status)) {
        const pase = document.createElement('button');
        pase.className = 'ev2-button w-full py-2 rounded-lg text-sm font-display';
        pase.textContent = r.checked_in_at ? t('pass.seeUsed') : t('pass.see');
        pase.onclick = () => openPass(r);
        card.appendChild(pase);
      }

      if (EV2Booking.canCancel(r)) {
        const cancel = document.createElement('button');
        cancel.className = 'w-full py-2 text-sm text-red-300 underline';
        cancel.textContent = t('book.cancel');
        cancel.onclick = () => cancelReservation(r);
        card.appendChild(cancel);
      }
      box.appendChild(card);
    }
  }

  // ---------------------------------------------------------------- acciones

  async function pickTable(table) {
    state.table = table;
    renderTables();
    hideError();
    try {
      // La cotización la calcula el SERVIDOR. El precio de la lista de mesas es solo
      // para escoger; el que se cobra es este.
      const data = await ctx.api.post(`/nightclubs/${ctx.clubId()}/reservations/quote`, {
        event_id: state.event.id,
        table_id: table.id,
        guest_count: state.guests,
        addons: [],
        discount_code: $('book-code').value.trim() || undefined,
      });
      state.quote = data.quote;
    } catch (err) {
      state.quote = null;
      showError(window.EV2Format.errorMessage(err));
    }
    renderQuote();
  }

  async function confirm() {
    const form = {
      event: state.event, table: state.table, guests: state.guests,
      notes: $('book-notes').value, discountCode: $('book-code').value,
    };
    const blocker = EV2Booking.bookingBlocker(form, state.rules, new Date());
    if (blocker) {
      showError(blocker === 'book.errMinParty'
        ? t(blocker, { min: state.rules.min_party_size })
        : t(blocker));
      return;
    }

    const button = $('btn-book-confirm');
    button.disabled = true;
    try {
      await ctx.api.post(`/nightclubs/${ctx.clubId()}/reservations`,
        EV2Booking.bookingPayload(form, { clientRequestId: state.requestId || uuid() }));
      state.requestId = uuid();
      state.table = null;
      state.quote = null;
      $('book-notes').value = '';
      ctx.toast(t('book.done'), 'ok');
      await Promise.all([loadMine(), loadTables()]);
      renderQuote();
    } catch (err) {
      showError(window.EV2Format.errorMessage(err));
    } finally {
      button.disabled = false;
    }
  }

  async function cancelReservation(reservation) {
    if (!window.confirm(t('book.confirmCancel'))) return;
    try {
      await ctx.api.post(
        `/nightclubs/${ctx.clubId()}/reservations/${reservation.id}/cancel`, {});
      ctx.toast(t('book.cancelled'), 'ok');
      await loadMine();
    } catch (err) { ctx.showError(err); }
  }

  // ---------------------------------------------------------------- enganche

  $('btn-book-open').onclick = async () => {
    const panel = $('book-panel');
    panel.hidden = !panel.hidden;
    if (panel.hidden || !ctx || state.loading) return;
    state.loading = true;
    state.requestId = uuid();
    try {
      await loadEvents();
      await loadTables();
    } finally {
      state.loading = false;
    }
  };

  $('book-event').onchange = () => {
    state.event = state.events.find((e) => e.id === $('book-event').value) || null;
    loadTables();
  };
  $('book-guests').onchange = () => {
    state.guests = Number($('book-guests').value) || 1;
    loadTables();
  };
  $('btn-book-confirm').onclick = confirm;

  $('btn-gp-reason-close').onclick = cerrarMotivo;
  $('btn-gp-reason-go').onclick = confirmarMotivo;
  $('gp-reason-sheet').onclick = (e) => { if (e.target === $('gp-reason-sheet')) cerrarMotivo(); };

  const closePass = () => { $('pass-sheet').hidden = true; cerrarMotivo(); };
  $('btn-pass-close').onclick = closePass;
  $('pass-sheet').onclick = (e) => { if (e.target === $('pass-sheet')) closePass(); };

  EV2Screen.on('enter', (screen) => { ctx = screen; loadMine().catch(() => {}); });
  EV2Screen.on('language', () => { if (ctx) { renderTables(); renderQuote(); renderMine(); } });
}());
