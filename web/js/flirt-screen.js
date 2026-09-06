/**
 * EV2 — la pestaña "Conecta" del cliente, más los interruptores de privacidad y la
 * lista de bloqueados que viven en el perfil.
 *
 * Solo conecta el DOM con `EV2Flirt`. Ninguna decisión vive aquí: a quién se puede
 * mandar, qué se manda, qué se advierte antes de cobrar un trago y en qué orden se
 * enseña la bandeja se resuelven en ese módulo, que sí se prueba.
 *
 * Se engancha al mismo socket y a la misma sesión que `index-screen.js` a través de
 * `EV2Screen`: abrir una segunda conexión haría que el servidor cerrara la primera.
 */
/* global EV2Screen, EV2Flirt, EV2Format */
(function () {
  'use strict';

  if (!window.EV2Screen) return;

  const $ = (id) => document.getElementById(id);
  const uuid = () => (window.crypto && window.crypto.randomUUID
    ? window.crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}-${Math.random().toString(16).slice(2)}`);

  let ctx = null;
  const state = {
    prefs: null, people: [], inbox: [], sent: [], blocks: [],
    section: null, tab: 'people',
    // El destinatario de la hoja abierta y en qué modo está.
    target: null, mode: 'emoji', emoji: 'wave',
    // El id de petición se fija AL ABRIR la hoja, no al tocar mandar: si el dedo toca
    // dos veces —cosa que pasa a oscuras— el servidor reconoce el repetido y devuelve
    // el mismo flirt, en vez de cobrar dos tragos.
    requestId: null,
    reportTarget: null,
    busy: false,
  };

  const t = (key, vars) => (vars ? ctx.t(key, vars) : ctx.t(key));
  const esc = (s) => ctx.escape(s);

  function showError(id, message) {
    const el = $(id);
    if (!el) return;
    el.textContent = message;
    el.hidden = !message;
  }

  // ---------------------------------------------------------------- carga

  async function loadPreferences() {
    const data = await ctx.api.get('/me/preferences');
    state.prefs = data.preferences || {};
    renderGate();
    renderPreferences();
  }

  async function loadPeople() {
    const club = ctx.clubId();
    if (!club) return;
    // Sin mesa el servidor contesta 422 a propósito: se dice con palabras en vez de
    // enseñar un error rojo que no explica nada.
    if (!ctx.myTable() || !ctx.myTable().id) {
      state.people = [];
      renderPeople();
      return;
    }
    const q = state.section ? `?section=${encodeURIComponent(state.section)}&limit=200` : '?limit=200';
    try {
      const data = await ctx.api.get(`/nightclubs/${club}/flirts/people${q}`);
      state.people = data.people || [];
    } catch (err) {
      if (!err || err.status !== 422) throw err;
      state.people = [];
    }
    renderPeople();
  }

  async function loadInbox() {
    const club = ctx.clubId();
    if (!club) return;
    const data = await ctx.api.get(`/nightclubs/${club}/flirts/received?limit=50`);
    state.inbox = data.flirts || [];
    renderInbox();
    renderBadges();
  }

  async function loadSent() {
    const club = ctx.clubId();
    if (!club) return;
    const data = await ctx.api.get(`/nightclubs/${club}/flirts/sent?limit=50`);
    state.sent = data.flirts || [];
    renderSent();
  }

  async function loadBlocks() {
    const data = await ctx.api.get('/me/blocks');
    state.blocks = data.blocks || [];
    renderBlocks();
  }

  async function loadAll() {
    if (!ctx) return;
    try {
      await loadPreferences();
      await loadBlocks();
      if (EV2Flirt.optInState(state.prefs) === 'off') return;
      await Promise.all([loadPeople(), loadInbox(), loadSent()]);
    } catch (err) {
      ctx.showError(err);
    }
  }

  // ---------------------------------------------------------------- la puerta

  /** Con el permiso apagado no se enseña nada más que el interruptor. */
  function renderGate() {
    const on = EV2Flirt.optInState(state.prefs) !== 'off';
    $('flirt-optout').hidden = on;
    $('flirt-main').hidden = !on;
  }

  $('btn-flirt-optin').onclick = async () => {
    try {
      // Encender desde aquí enciende las dos cosas: quien toca "activar" en esta
      // pantalla quiere participar, no quedarse a medias sin saber por qué no lo ven.
      await savePreferences({ accept_flirts: true, discoverable: true });
      await loadAll();
    } catch (err) { ctx.showError(err); }
  };

  // ---------------------------------------------------------------- privacidad

  async function savePreferences(patch) {
    const data = await ctx.api.put('/me/preferences', patch);
    state.prefs = data.preferences || state.prefs;
    renderGate();
    renderPreferences();
    return state.prefs;
  }

  function renderPreferences() {
    const p = state.prefs || {};
    $('pref-accept').checked = !!p.accept_flirts;
    $('pref-discoverable').checked = !!p.discoverable;
    $('pref-map').checked = p.show_on_map !== false;
    // Aparecer en la lista sin aceptar invitaciones no significa nada: el servidor no
    // deja que te manden. Se desactiva la casilla en vez de dejarla mentir.
    $('pref-discoverable').disabled = !p.accept_flirts;
  }

  let savedTimer = null;
  function announceSaved() {
    $('pref-saved').hidden = false;
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => { $('pref-saved').hidden = true; }, 2500);
  }

  function bindPreference(id, field) {
    $(id).onchange = async (ev) => {
      const input = ev.currentTarget;
      const patch = {};
      patch[field] = input.checked;
      // Apagar "aceptar" apaga también "aparecer": quedarse listado sin poder recibir
      // deja a la gente mandando a un buzón cerrado.
      if (field === 'accept_flirts' && !input.checked) patch.discoverable = false;
      showError('pref-error', '');
      try {
        await savePreferences(patch);
        announceSaved();
        if (EV2Flirt.optInState(state.prefs) !== 'off') await loadAll();
      } catch (err) {
        showError('pref-error', EV2Format.errorMessage(err));
        renderPreferences();
      }
    };
  }
  bindPreference('pref-accept', 'accept_flirts');
  bindPreference('pref-discoverable', 'discoverable');
  bindPreference('pref-map', 'show_on_map');

  function renderBlocks() {
    const list = $('blocks-list');
    list.innerHTML = '';
    $('blocks-empty').hidden = state.blocks.length > 0;
    for (const block of state.blocks) {
      const row = document.createElement('div');
      row.className = 'flex items-center justify-between gap-3 card rounded-lg px-3 py-2';
      row.innerHTML = `<span class="text-sm truncate">${esc(block.display_name)}</span>`;
      const btn = document.createElement('button');
      btn.className = 'text-xs text-cyan-300 px-2 py-1 shrink-0';
      btn.textContent = t('privacy.unblock');
      btn.onclick = async () => {
        btn.disabled = true;
        try {
          await ctx.api.del(`/me/blocks/${block.user_id}`);
          await loadBlocks();
          await loadPeople();
        } catch (err) { ctx.showError(err); btn.disabled = false; }
      };
      row.appendChild(btn);
      list.appendChild(row);
    }
  }

  // ---------------------------------------------------------------- esta noche

  function renderSections() {
    const bar = $('flirt-sections');
    bar.innerHTML = '';
    const all = EV2Flirt.sections(state.people);
    if (all.length < 2) return;
    const make = (value, label) => {
      const b = document.createElement('button');
      const on = state.section === value;
      b.className = `px-3 py-1 rounded-full text-xs shrink-0 ${on ? 'tab-active' : 'card text-white/60'}`;
      b.textContent = label;
      b.onclick = async () => { state.section = value; await loadPeople(); };
      return b;
    };
    bar.appendChild(make(null, t('flirt.allZones')));
    for (const section of all) bar.appendChild(make(section, section));
  }

  function renderPeople() {
    const seated = !!(ctx.myTable() && ctx.myTable().id);
    $('flirt-need-table').hidden = seated;
    const box = $('flirt-people-groups');
    box.innerHTML = '';
    $('flirt-people-empty').hidden = !seated || state.people.length > 0;
    if (!seated) { $('flirt-sections').innerHTML = ''; return; }
    renderSections();

    for (const group of EV2Flirt.bySection(state.people)) {
      const wrap = document.createElement('div');
      const title = document.createElement('p');
      title.className = 'text-xs uppercase tracking-wider text-white/40 mb-2';
      title.textContent = group.section || t('flirt.noZone');
      wrap.appendChild(title);

      const grid = document.createElement('div');
      grid.className = 'grid grid-cols-2 gap-2';
      for (const person of group.people) {
        const card = document.createElement('button');
        card.className = 'card rounded-xl p-3 text-left';
        card.innerHTML = `<p class="text-sm font-semibold truncate">${esc(person.display_name)}</p>`
          + `<p class="text-[11px] text-white/40">${t('flirt.atTable', { table: esc(person.table_code || '—') })}</p>`;
        card.onclick = () => openSheet(person);
        grid.appendChild(card);
      }
      wrap.appendChild(grid);
      box.appendChild(wrap);
    }
  }

  // ---------------------------------------------------------------- la hoja de mandar

  function openSheet(person) {
    state.target = person;
    state.mode = 'emoji';
    state.emoji = EV2Flirt.EMOJI_KEYS[0];
    state.requestId = uuid();
    $('flirt-sheet-title').textContent = person.display_name || '';
    $('flirt-sheet-where').textContent = t('flirt.atTable', { table: person.table_code || '—' });
    $('flirt-message').value = '';
    $('flirt-quantity').value = '1';
    showError('flirt-error', '');
    renderDrinks();
    renderEmojis();
    renderMode();
    $('flirt-limits').textContent = t('flirt.limits', {
      hour: EV2Flirt.LIMITS.perHour, night: EV2Flirt.LIMITS.unansweredPerNight,
    });
    $('flirt-sheet').hidden = false;
  }

  function closeSheet() {
    $('flirt-sheet').hidden = true;
    state.target = null;
    state.requestId = null;
  }

  function renderEmojis() {
    const box = $('flirt-emojis');
    box.innerHTML = '';
    for (const emoji of EV2Flirt.EMOJIS) {
      const b = document.createElement('button');
      const on = state.emoji === emoji.key;
      b.className = `py-3 rounded-xl text-2xl ${on ? 'tab-active' : 'card'}`;
      b.textContent = emoji.icon;
      b.title = t(emoji.labelKey);
      b.setAttribute('aria-label', t(emoji.labelKey));
      b.onclick = () => { state.emoji = emoji.key; renderEmojis(); };
      box.appendChild(b);
    }
  }

  function renderDrinks() {
    const select = $('flirt-drink');
    select.innerHTML = '';
    const drinks = (ctx.drinks() || []).filter((d) => d && d.available !== false);
    if (!drinks.length) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = t('flirt.noDrinks');
      select.appendChild(opt);
      return;
    }
    for (const drink of drinks) {
      const opt = document.createElement('option');
      opt.value = drink.id;
      opt.textContent = `${drink.name} · ${ctx.money(drink.price, drink.currency)}`;
      select.appendChild(opt);
    }
  }

  function renderMode() {
    const gift = EV2Flirt.isGift(state.mode);
    $('flirt-mode-emoji').hidden = state.mode !== 'emoji';
    $('flirt-mode-gift').hidden = !gift;
    const warnKey = EV2Flirt.warningKey(state.mode);
    $('flirt-warn').textContent = warnKey ? t(warnKey) : '';
    $('btn-flirt-send').textContent = gift ? t('flirt.sendGift') : t('flirt.send');
    document.querySelectorAll('.flirt-mode').forEach((b) => {
      b.className = `flirt-mode py-2 rounded-lg text-xs ${b.dataset.flirtMode === state.mode ? 'tab-active' : 'text-white/50'}`;
    });
  }

  async function send() {
    if (state.busy) return;
    const person = state.target;
    showError('flirt-error', '');
    const blocker = EV2Flirt.sendBlocker({ me: ctx.user(), person, myTable: ctx.myTable() });
    if (blocker) { showError('flirt-error', t(blocker)); return; }

    const drinkId = $('flirt-drink').value || null;
    if (EV2Flirt.isGift(state.mode)) {
      const gift = EV2Flirt.giftBlocker(drinkId, ctx.drinks());
      if (gift) { showError('flirt-error', t(gift)); return; }
      // Un trago invitado se cobra al mandarlo y no se devuelve. Preguntar una vez es
      // molesto; cobrar sin preguntar es peor.
      if (!window.confirm(t('flirt.confirmGift'))) return;
    }

    const body = EV2Flirt.sendPayload(person, state.mode, {
      clientRequestId: state.requestId,
      emoji: state.emoji,
      message: $('flirt-message').value,
      drinkId,
      quantity: $('flirt-quantity').value,
    });

    state.busy = true;
    $('btn-flirt-send').disabled = true;
    try {
      await ctx.api.post(`/nightclubs/${ctx.clubId()}/flirts`, body);
      closeSheet();
      ctx.toast(t('flirt.sentOk'), 'ok');
      await Promise.all([loadSent(), loadPeople()]);
    } catch (err) {
      showError('flirt-error', EV2Format.errorMessage(err));
    } finally {
      state.busy = false;
      $('btn-flirt-send').disabled = false;
    }
  }

  // ---------------------------------------------------------------- bandeja

  function flirtLine(flirt) {
    const icon = flirt.type === 'emoji' ? EV2Flirt.emojiIcon(flirt.emoji) : '';
    const what = `${icon} ${t(EV2Flirt.typeKey(flirt.type))}`.trim();
    return `<p class="text-sm">${esc(what)}</p>`;
  }

  function renderInbox() {
    const box = $('flirt-inbox-list');
    box.innerHTML = '';
    $('flirt-inbox-empty').hidden = state.inbox.length > 0;

    for (const flirt of EV2Flirt.sortInbox(state.inbox)) {
      const card = document.createElement('div');
      card.className = 'card rounded-xl p-3 space-y-2';
      card.innerHTML = `
        <div class="flex items-start justify-between gap-2">
          <div class="min-w-0">
            <p class="font-semibold truncate">${esc(flirt.sender_name || '')}</p>
            <p class="text-[11px] text-white/40">${t('flirt.fromTable', { table: esc(flirt.sender_table_code || '—') })}</p>
          </div>
          <span class="text-[11px] text-white/40 shrink-0">${esc(t(EV2Flirt.statusKey(flirt)))}</span>
        </div>
        ${flirtLine(flirt)}
        ${flirt.message ? `<p class="text-sm text-white/70">${esc(flirt.message)}</p>` : ''}`;

      if (!EV2Flirt.answered(flirt) && !EV2Flirt.expired(flirt)) {
        const row = document.createElement('div');
        row.className = 'grid grid-cols-6 gap-1 pt-1';
        for (const reaction of EV2Flirt.REACTIONS) {
          const b = document.createElement('button');
          b.className = `py-2 rounded-lg text-lg ${reaction.accepts ? 'card' : 'bg-red-500/20'}`;
          b.textContent = reaction.icon;
          b.title = t(reaction.labelKey);
          b.setAttribute('aria-label', t(reaction.labelKey));
          b.onclick = () => react(flirt.id, reaction.key, b);
          row.appendChild(b);
        }
        card.appendChild(row);
      } else if (flirt.reaction) {
        const said = document.createElement('p');
        said.className = 'text-[11px] text-white/40';
        const r = EV2Flirt.reactionOf(flirt.reaction);
        said.textContent = t('flirt.youAnswered', { answer: r ? t(r.labelKey) : flirt.reaction });
        card.appendChild(said);
      }

      const tools = document.createElement('div');
      tools.className = 'flex gap-3 pt-1';
      const block = document.createElement('button');
      block.className = 'text-[11px] text-white/40';
      block.textContent = t('flirt.block');
      block.onclick = () => blockPerson(flirt.sender_id, flirt.sender_name);
      tools.appendChild(block);
      if (EV2Flirt.canReport(flirt)) {
        const report = document.createElement('button');
        report.className = 'text-[11px] text-red-300';
        report.textContent = t('report.title');
        report.onclick = () => openReport(flirt.sender_id, flirt.sender_name, flirt.id);
        tools.appendChild(report);
      }
      card.appendChild(tools);
      box.appendChild(card);
    }
  }

  function renderSent() {
    const box = $('flirt-sent-list');
    box.innerHTML = '';
    $('flirt-sent-empty').hidden = state.sent.length > 0;
    for (const flirt of state.sent) {
      const card = document.createElement('div');
      card.className = 'card rounded-xl p-3 space-y-1';
      const r = flirt.reaction ? EV2Flirt.reactionOf(flirt.reaction) : null;
      card.innerHTML = `
        <div class="flex items-start justify-between gap-2">
          <p class="font-semibold truncate">${esc(flirt.recipient_name || '')}</p>
          <span class="text-[11px] text-white/40 shrink-0">${esc(t(EV2Flirt.statusKey(flirt)))}</span>
        </div>
        ${flirtLine(flirt)}
        ${r ? `<p class="text-[11px] text-white/50">${esc(t('flirt.theyAnswered', { answer: t(r.labelKey) }))}</p>` : ''}`;
      box.appendChild(card);
    }
  }

  async function react(flirtId, reaction, button) {
    button.disabled = true;
    try {
      await ctx.api.post(`/nightclubs/${ctx.clubId()}/flirts/${flirtId}/react`, { reaction });
      await loadInbox();
    } catch (err) {
      ctx.showError(err);
      button.disabled = false;
    }
  }

  /** Abrir la bandeja marca lo nuevo como visto: eso apaga el globito. */
  async function markSeen() {
    const club = ctx.clubId();
    const nuevos = state.inbox.filter((f) => !f.viewed_at && !EV2Flirt.expired(f));
    if (!club || !nuevos.length) return;
    await Promise.all(nuevos.map((f) => ctx.api
      .post(`/nightclubs/${club}/flirts/${f.id}/view`, {})
      .catch(() => {})));
    await loadInbox();
  }

  async function blockPerson(userId, name) {
    if (!userId || !window.confirm(t('flirt.confirmBlock', { name: name || '' }))) return;
    try {
      await ctx.api.post(`/me/blocks/${userId}`, {});
      ctx.toast(t('flirt.blocked'), 'ok');
      await Promise.all([loadBlocks(), loadInbox(), loadPeople()]);
    } catch (err) { ctx.showError(err); }
  }

  // ---------------------------------------------------------------- reportar

  function openReport(userId, name, flirtId) {
    state.reportTarget = { userId, flirtId };
    $('report-who').textContent = name || '';
    $('report-details').value = '';
    showError('report-error', '');
    const select = $('report-reason');
    select.innerHTML = '';
    for (const reason of EV2Flirt.REPORT_REASONS) {
      const opt = document.createElement('option');
      opt.value = reason.key;
      opt.textContent = t(reason.labelKey);
      select.appendChild(opt);
    }
    $('report-sheet').hidden = false;
  }

  function closeReport() {
    $('report-sheet').hidden = true;
    state.reportTarget = null;
  }

  async function sendReport() {
    const target = state.reportTarget;
    if (!target) return;
    showError('report-error', '');
    const body = EV2Flirt.reportPayload($('report-reason').value, {
      details: $('report-details').value,
      flirtId: target.flirtId,
    });
    $('btn-report-send').disabled = true;
    try {
      await ctx.api.post(`/nightclubs/${ctx.clubId()}/users/${target.userId}/report`, body);
      closeReport();
      ctx.toast(t('report.sent'), 'ok');
    } catch (err) {
      showError('report-error', EV2Format.errorMessage(err));
    } finally {
      $('btn-report-send').disabled = false;
    }
  }

  // ---------------------------------------------------------------- pestañas y eventos

  function renderBadges() {
    const nuevos = EV2Flirt.unread(state.inbox);
    for (const id of ['flirt-badge', 'flirt-inbox-badge']) {
      const el = $(id);
      if (!el) continue;
      el.textContent = String(nuevos);
      el.hidden = nuevos === 0;
    }
  }

  function showTab(name) {
    state.tab = name;
    $('flirt-people').hidden = name !== 'people';
    $('flirt-inbox').hidden = name !== 'inbox';
    $('flirt-sent').hidden = name !== 'sent';
    document.querySelectorAll('.flirt-tab').forEach((b) => {
      b.className = `flirt-tab flex-1 py-2 rounded-lg text-sm ${b.dataset.flirtTab === name ? 'tab-active' : 'text-white/50'}`;
    });
    if (name === 'inbox' && ctx) markSeen().catch(() => {});
  }

  document.querySelectorAll('.flirt-tab').forEach((b) => { b.onclick = () => showTab(b.dataset.flirtTab); });
  document.querySelectorAll('.flirt-mode').forEach((b) => {
    b.onclick = () => { state.mode = b.dataset.flirtMode; renderMode(); };
  });
  $('btn-flirt-close').onclick = closeSheet;
  $('flirt-sheet').onclick = (e) => { if (e.target === $('flirt-sheet')) closeSheet(); };
  $('btn-flirt-send').onclick = send;
  $('btn-report-close').onclick = closeReport;
  $('report-sheet').onclick = (e) => { if (e.target === $('report-sheet')) closeReport(); };
  $('btn-report-send').onclick = sendReport;

  EV2Screen.on('enter', (screen) => { ctx = screen; loadAll(); });

  EV2Screen.on('event', (message) => {
    if (!ctx) return;
    // El tipo real vive en `event_type`; `type` siempre vale 'event'.
    const kind = EV2Flirt.eventKind(message);
    if (!kind) return;
    if (kind === 'flirt_received') {
      loadInbox().then(() => {
        ctx.toast(t('flirt.arrived'), 'ok');
        // Si la bandeja ya está abierta, lo que acaba de llegar se marca visto solo.
        if (state.tab === 'inbox') markSeen().catch(() => {});
      }).catch(() => {});
      return;
    }
    if (kind === 'flirt_reaction') { loadSent().catch(() => {}); return; }
    // Un trago rechazado vuelve a la mesa de quien lo mandó, y se cobra igual: hay que
    // decirlo, no dejar que aparezca una copa sin explicación.
    ctx.toast(t('flirt.giftReturned'), 'info');
    loadSent().catch(() => {});
  });

  EV2Screen.on('view', (name) => {
    if (!ctx) return;
    if (name === 'flirt') loadAll();
    if (name === 'profile') loadBlocks().catch(() => {});
  });

  EV2Screen.on('language', () => {
    if (!ctx) return;
    renderPeople();
    renderInbox();
    renderSent();
    renderBlocks();
    if (!$('flirt-sheet').hidden) { renderEmojis(); renderMode(); }
  });
}());
