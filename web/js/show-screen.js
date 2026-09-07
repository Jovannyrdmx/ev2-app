/**
 * EV2 — la pestaña "Show" del cliente: propinas al personal, invitar un trago y pedir
 * canción.
 *
 * Solo conecta el DOM con `EV2Tipping` y `EV2Songs`. Ninguna decisión vive aquí: los
 * importes, los mínimos, el orden de la cola y si una canción ya está pedida se
 * resuelven en esos módulos, que sí se prueban.
 *
 * Se engancha al mismo socket y a la misma sesión que `index-screen.js` a través de
 * `EV2Screen`: abrir una segunda conexión haría que el servidor cerrara la primera.
 */
/* global EV2Screen, EV2Tipping, EV2Songs */
(function () {
  'use strict';

  if (!window.EV2Screen) return;

  const $ = (id) => document.getElementById(id);
  const uuid = () => (window.crypto && window.crypto.randomUUID
    ? window.crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}-${Math.random().toString(16).slice(2)}`);

  let ctx = null;
  const state = {
    staff: [], tips: [], songs: [], djs: [], board: [],
    // Qué pestaña se ve: la clave de un rol ('dancer', 'dj'…), 'music' o 'board'.
    active: null,
    // Periodo del reconocimiento: 'night' o 'month'.
    boardPeriod: 'night',
    // El destinatario de la hoja abierta, y en qué modo está: propina o trago.
    target: null, mode: 'tip',
    // El id de petición se fija AL ABRIR la hoja, no al tocar enviar: si el dedo toca
    // dos veces —cosa que pasa a oscuras— el servidor reconoce el repetido y devuelve
    // la misma propina en vez de cobrar dos.
    requestId: null,
  };

  const t = (key, vars) => (vars ? ctx.t(key, vars) : ctx.t(key));

  // ---------------------------------------------------------------- carga

  async function loadStaff() {
    const club = ctx.clubId();
    if (!club) return;
    const data = await ctx.api.get(`/nightclubs/${club}/staff/on-shift`);
    state.staff = data.staff || [];
    state.djs = state.staff.filter((p) => p.role === 'dj');
    renderStaff();
    renderDjPicker();
  }

  async function loadBoard() {
    const club = ctx.clubId();
    if (!club) return;
    const data = await ctx.api.get(
      `/nightclubs/${club}/leaderboard?period=${state.boardPeriod}&limit=20`);
    state.board = EV2Tipping.boardRows(data);
    renderBoard();
  }

  async function loadTips() {
    const club = ctx.clubId();
    if (!club) return;
    const data = await ctx.api.get(`/nightclubs/${club}/tips/mine?limit=50`);
    state.tips = data.tips || [];
    renderTips();
  }

  async function loadSongs() {
    const club = ctx.clubId();
    if (!club) return;
    const data = await ctx.api.get(`/nightclubs/${club}/song-requests?status=requested&limit=50`);
    state.songs = data.song_requests || [];
    renderSongs();
  }

  const loadAll = () => Promise.all([loadStaff(), loadTips(), loadSongs(), loadBoard()])
    .catch(() => {});

  // ---------------------------------------------------------------- personal

  /**
   * La tira de pestañas: una por rol con gente en turno (en el orden de EV2Tipping),
   * más Música y Reconocimiento, que están siempre. Si la pestaña activa dejó de
   * existir —el último DJ cerró turno— se cae a la primera.
   */
  function renderTabs() {
    const tabs = EV2Tipping.roleTabs(state.staff)
      .concat([{ key: 'music', label: t('tip.tabMusic') },
        { key: 'board', label: t('tip.tabBoard') }]);
    if (!tabs.some((x) => x.key === state.active)) state.active = tabs[0].key;

    const box = $('show-tabs');
    box.innerHTML = '';
    for (const tab of tabs) {
      const b = document.createElement('button');
      b.className = `show-tab whitespace-nowrap px-3 py-2 rounded-lg text-sm ${
        tab.key === state.active ? 'tab-active' : 'text-white/50'}`;
      b.dataset.showTab = tab.key;
      b.textContent = tab.label;
      b.onclick = () => showTab(tab.key);
      box.appendChild(b);
    }
    syncPanels();
  }

  /** Enseña el panel de la pestaña activa y esconde los otros dos. Idempotente. */
  function syncPanels() {
    const staffView = state.active !== 'music' && state.active !== 'board';
    $('show-staff').hidden = !staffView;
    $('show-music').hidden = state.active !== 'music';
    $('show-board').hidden = state.active !== 'board';
  }

  function renderStaff() {
    renderTabs();
    const groups = EV2Tipping.byRole(state.staff);
    const active = groups.find((g) => g.role === state.active);
    $('staff-empty').hidden = groups.length > 0;

    const box = $('staff-groups');
    box.innerHTML = '';
    if (!active) return;

    const head = document.createElement('p');
    head.className = 'text-xs uppercase tracking-wider mb-2';
    head.style.color = 'var(--ev2-pink)';
    head.textContent = active.label;
    box.appendChild(head);
    for (const person of active.people) box.appendChild(personCard(person));
  }

  /**
   * El selector de DJ solo aparece cuando hay más de uno en turno: con uno solo el
   * servidor ya sabe a quién va la canción y un desplegable de una opción estorba.
   */
  function renderDjPicker() {
    const wrap = $('song-dj-wrap');
    const select = $('song-dj');
    select.innerHTML = '';
    if (state.djs.length <= 1) { wrap.hidden = true; return; }
    for (const dj of state.djs) {
      const opt = document.createElement('option');
      opt.value = dj.id;
      opt.textContent = dj.display_name || dj.role_label || 'DJ';
      select.appendChild(opt);
    }
    wrap.hidden = false;
  }

  /**
   * El reconocimiento de la noche o del mes. A un cliente la API no le manda montos
   * (decidido en 2.5): se enseña el puesto, el nombre, el rol y cuánta gente lo
   * reconoció.
   */
  function renderBoard() {
    const lang = window.EV2Format.getLanguage();
    $('board-empty').hidden = state.board.length > 0;
    const box = $('board-list');
    box.innerHTML = '';

    for (const row of state.board) {
      const card = document.createElement('div');
      card.className = 'card rounded-xl p-3 flex items-center gap-3';

      const rank = document.createElement('div');
      rank.className = 'font-display text-lg w-8 text-center shrink-0';
      rank.style.color = 'var(--ev2-gold)';
      rank.textContent = row.rank <= 3 ? ['🥇', '🥈', '🥉'][row.rank - 1] : `#${row.rank}`;
      card.appendChild(rank);

      const mid = document.createElement('div');
      mid.className = 'min-w-0 flex-1';
      const name = document.createElement('p');
      name.className = 'font-display truncate';
      name.textContent = row.name;
      const sub = document.createElement('p');
      sub.className = 'text-[11px] text-white/40 truncate';
      const roleLabel = row.role ? window.EV2Roles.describe(row.role, lang).label : '';
      sub.textContent = [roleLabel, t('tip.boardFans', { count: row.fans })]
        .filter(Boolean).join(' · ');
      mid.append(name, sub);
      card.appendChild(mid);

      box.appendChild(card);
    }
  }

  function personCard(person) {
    const card = document.createElement('div');
    card.className = 'card rounded-xl p-3 mb-2 flex items-center justify-between gap-3';

    const left = document.createElement('div');
    left.className = 'min-w-0';
    const name = document.createElement('p');
    name.className = 'font-display truncate';
    name.textContent = person.display_name || '';
    left.appendChild(name);

    const note = document.createElement('p');
    note.className = 'text-[11px] text-white/40';
    const bits = [];
    if (person.section) bits.push(t('tip.section', { section: person.section }));
    if (Number(person.min_tip) > 0) {
      bits.push(t('tip.minNote', { amount: ctx.money(person.min_tip, person.currency) }));
    }
    note.textContent = bits.join(' · ');
    left.appendChild(note);
    card.appendChild(left);

    const actions = document.createElement('div');
    actions.className = 'flex gap-2 shrink-0';

    const tip = document.createElement('button');
    tip.className = 'ev2-button rounded-lg px-3 text-sm';
    tip.dataset.tipFor = person.id;
    tip.textContent = t('tip.give');
    tip.onclick = () => openSheet(person, 'tip');
    actions.appendChild(tip);

    // El botón de trago solo aparece si de verdad se puede: ofrecerlo y luego explicar
    // que no, es peor que no ofrecerlo.
    if (person.accepts_drinks) {
      const drink = document.createElement('button');
      drink.className = 'card rounded-lg px-3 text-sm';
      drink.dataset.drinkFor = person.id;
      drink.title = t('tip.inviteDrink');
      // El icono va junto a una palabra: si la fuente de iconos no carga —pasa con la
      // señal del club— un botón que solo era un glifo se queda vacío y sin sentido.
      drink.innerHTML = `<i class="fa-solid fa-martini-glass mr-1"></i>${ctx.escape(t('tip.drinkSend'))}`;
      drink.onclick = () => openSheet(person, 'drink');
      actions.appendChild(drink);
    }

    card.appendChild(actions);
    return card;
  }

  function renderTips() {
    const totals = EV2Tipping.givenTotals(state.tips);
    const given = $('tips-given');
    given.hidden = totals.length === 0;
    given.textContent = totals.map((x) => ctx.money(x.amount, x.currency)).join(' · ');

    $('tips-empty').hidden = state.tips.length > 0;
    const list = $('tips-list');
    list.innerHTML = '';
    for (const tip of state.tips.slice(0, 20)) {
      const row = document.createElement('div');
      row.className = 'card rounded-lg px-3 py-2 flex justify-between text-sm';
      const who = document.createElement('span');
      who.className = 'truncate';
      who.textContent = tip.to_name || tip.to_display_name || '';
      const amount = document.createElement('span');
      amount.className = 'shrink-0 ml-3';
      amount.textContent = `${ctx.money(tip.amount, tip.currency)} · ${t(EV2Tipping.statusLabel(tip.status))}`;
      row.append(who, amount);
      list.appendChild(row);
    }
  }

  // ---------------------------------------------------------------- la hoja

  function openSheet(person, mode) {
    state.target = person;
    state.mode = mode;
    state.requestId = uuid();

    $('tip-sheet-title').textContent = mode === 'drink'
      ? t('tip.drinkFor', { name: person.display_name || '' })
      : t('tip.giveTo', { name: person.display_name || '' });
    $('tip-sheet-role').textContent = person.role_label || person.role || '';

    $('tip-mode-amount').hidden = mode !== 'tip';
    $('tip-mode-drink').hidden = mode !== 'drink';
    hideError('tip-error');
    hideError('tip-drink-error');

    if (mode === 'tip') renderPresets(person);
    else renderDrinkOptions(person);

    $('tip-sheet').hidden = false;
  }

  function closeSheet() {
    $('tip-sheet').hidden = true;
    state.target = null;
    state.requestId = null;
    $('tip-amount').value = '';
    $('tip-message').value = '';
    $('tip-anonymous').checked = false;
    $('tip-drink-message').value = '';
  }

  function renderPresets(person) {
    const box = $('tip-presets');
    box.innerHTML = '';
    for (const amount of EV2Tipping.presetAmounts(person)) {
      const b = document.createElement('button');
      b.className = 'card rounded-xl py-3 font-display';
      b.textContent = ctx.money(amount, person.currency);
      // Un toque = una propina. Sin paso intermedio: a oscuras, cada toque de más es
      // una oportunidad de tocar el botón equivocado.
      b.onclick = () => sendTip(amount);
      box.appendChild(b);
    }
    const min = $('tip-min');
    min.hidden = !(Number(person.min_tip) > 0);
    min.textContent = t('tip.minNote', { amount: ctx.money(person.min_tip, person.currency) });
  }

  function renderDrinkOptions(person) {
    const select = $('tip-drink');
    select.innerHTML = '';
    for (const drink of ctx.drinks()) {
      if (drink.available === false) continue;
      const opt = document.createElement('option');
      opt.value = drink.id;
      opt.textContent = `${drink.name} — ${ctx.money(drink.price, drink.currency)}`;
      select.appendChild(opt);
    }
    const blocker = EV2Tipping.drinkBlocker(person, ctx.myTable());
    $('btn-drink-send').disabled = !!blocker || !select.options.length;
    if (blocker) showError('tip-drink-error', t(blocker));
  }

  const showError = (id, text) => { const el = $(id); el.textContent = text; el.hidden = false; };
  const hideError = (id) => { $(id).hidden = true; };

  async function sendTip(amount) {
    const person = state.target;
    if (!person) return;
    const problem = EV2Tipping.validateTip(amount, person);
    if (problem) { showError('tip-error', t(problem)); return; }

    const button = $('btn-tip-send');
    button.disabled = true;
    try {
      await ctx.api.post(`/nightclubs/${ctx.clubId()}/tips`, EV2Tipping.tipPayload(person, amount, {
        clientRequestId: state.requestId,
        message: $('tip-message').value,
        anonymous: $('tip-anonymous').checked,
      }));
      closeSheet();
      ctx.toast(t('tip.sent'), 'ok');
      await loadTips();
    } catch (err) {
      showError('tip-error', window.EV2Format.errorMessage(err));
    } finally {
      button.disabled = false;
    }
  }

  async function sendDrink() {
    const person = state.target;
    const drinkId = $('tip-drink').value;
    if (!person || !drinkId) return;
    const blocker = EV2Tipping.drinkBlocker(person, ctx.myTable());
    if (blocker) { showError('tip-drink-error', t(blocker)); return; }

    const button = $('btn-drink-send');
    button.disabled = true;
    try {
      await ctx.api.post(
        `/nightclubs/${ctx.clubId()}/staff/${person.id}/drinks`,
        EV2Tipping.drinkPayload(drinkId, {
          clientRequestId: state.requestId,
          message: $('tip-drink-message').value,
        }));
      closeSheet();
      ctx.toast(t('tip.drinkSent'), 'ok');
    } catch (err) {
      showError('tip-drink-error', window.EV2Format.errorMessage(err));
    } finally {
      button.disabled = false;
    }
  }

  // ---------------------------------------------------------------- música

  function renderSongs() {
    const list = EV2Songs.pending(state.songs);
    $('song-empty').hidden = list.length > 0;
    const box = $('song-queue');
    box.innerHTML = '';
    const me = ctx.user().id;

    list.forEach((song, i) => {
      const card = document.createElement('div');
      card.className = 'card rounded-xl p-3 flex items-center gap-3';

      const position = document.createElement('div');
      position.className = 'font-display text-lg w-7 text-center shrink-0';
      position.style.color = 'var(--ev2-cyan)';
      position.textContent = String(i + 1);
      card.appendChild(position);

      const mid = document.createElement('div');
      mid.className = 'min-w-0 flex-1';
      const title = document.createElement('p');
      title.className = 'truncate';
      title.textContent = song.song_title || '';
      const sub = document.createElement('p');
      sub.className = 'text-[11px] text-white/40 truncate';
      const bits = [song.artist, t('song.votes', { count: Number(song.votes) || 0 })];
      if (EV2Songs.iVoted(song, me)) bits.push(t('song.mine'));
      sub.textContent = bits.filter(Boolean).join(' · ');
      mid.append(title, sub);
      card.appendChild(mid);

      // Sumarse solo se ofrece a quien no votó: el servidor contesta 409 al segundo
      // voto, y un botón que siempre falla enseña a desconfiar de la pantalla.
      if (!EV2Songs.iVoted(song, me)) {
        const vote = document.createElement('button');
        vote.className = 'ev2-button rounded-lg px-3 text-sm shrink-0';
        vote.textContent = t('song.vote');
        vote.onclick = () => submitSong(song.song_title, song.artist);
        card.appendChild(vote);
      }

      box.appendChild(card);
    });
  }

  async function submitSong(title, artist) {
    const blocker = EV2Songs.requestBlocker(state.djs);
    if (blocker) { showError('song-error', t(blocker)); return; }

    const plan = EV2Songs.planRequest(state.songs, title, artist, ctx.user().id);
    if (plan.action === 'blocked') { showError('song-error', t(plan.reason)); return; }

    hideError('song-error');
    const button = $('btn-song');
    button.disabled = true;
    // Se lee ANTES de limpiar el formulario: leerlo después devolvía siempre cero y la
    // lista de propinas dadas no se refrescaba tras pedir una canción con propina.
    const tipped = Number($('song-tip').value) > 0;
    try {
      // El DJ elegido y la dedicatoria solo viajan en una canción NUEVA: en un voto a
      // una que ya está en la cola, mandar otro DJ la abriría como fila aparte.
      const extra = plan.action === 'request'
        ? {
          djUserId: (!$('song-dj-wrap').hidden && $('song-dj').value) || undefined,
          message: $('song-message').value,
        }
        : {};
      const body = EV2Songs.requestPayload(title, artist, Object.assign({
        clientRequestId: uuid(),
        tipAmount: $('song-tip').value,
        currency: (state.djs[0] && state.djs[0].currency) || 'MXN',
      }, extra));
      const data = await ctx.api.post(`/nightclubs/${ctx.clubId()}/song-requests`, body);
      $('song-title').value = '';
      $('song-artist').value = '';
      $('song-tip').value = '';
      $('song-message').value = '';
      await loadSongs();

      // Se le dice su lugar en la cola, no solo "listo": lo que quiere saber es cuándo
      // va a sonar su canción.
      const song = data.song_request || {};
      const position = EV2Songs.positionOf(state.songs, song.id);
      ctx.toast(data.merged
        ? t('song.voted', { position, votes: Number(song.votes) || 0 })
        : t('song.requested', { position }), 'ok');
      if (tipped) await loadTips();
    } catch (err) {
      showError('song-error', window.EV2Format.errorMessage(err));
    } finally {
      button.disabled = false;
    }
  }

  // ---------------------------------------------------------------- pestañas y eventos

  function showTab(name) {
    state.active = name;
    if (name === 'music' || name === 'board') renderTabs();
    else renderStaff();
    if (name === 'board') loadBoard().catch(() => {});
  }

  document.querySelectorAll('.board-period').forEach((b) => {
    b.onclick = () => {
      if (state.boardPeriod === b.dataset.boardPeriod) return;
      state.boardPeriod = b.dataset.boardPeriod;
      document.querySelectorAll('.board-period').forEach((x) => {
        x.className = `board-period flex-1 py-2 rounded-lg text-sm ${
          x.dataset.boardPeriod === state.boardPeriod ? 'tab-active' : 'text-white/50'}`;
      });
      loadBoard().catch(() => {});
    };
  });
  $('btn-tip-close').onclick = closeSheet;
  $('tip-sheet').onclick = (e) => { if (e.target === $('tip-sheet')) closeSheet(); };
  $('btn-tip-send').onclick = () => sendTip($('tip-amount').value);
  $('btn-drink-send').onclick = sendDrink;
  $('song-form').onsubmit = (e) => {
    e.preventDefault();
    submitSong($('song-title').value, $('song-artist').value);
  };

  EV2Screen.on('enter', (screen) => { ctx = screen; loadAll(); });

  EV2Screen.on('event', (message) => {
    if (!ctx) return;
    // El tipo real vive en `event_type`; `type` siempre vale 'event'.
    if (EV2Songs.affectsSongs(message)) loadSongs().catch(() => {});
    if (EV2Tipping.affectsTips(message)) loadAll();
  });

  EV2Screen.on('view', (name) => { if (name === 'show' && ctx) loadAll(); });

  EV2Screen.on('language', () => {
    if (!ctx) return;
    renderStaff();
    renderDjPicker();
    renderTips();
    renderSongs();
    renderBoard();
  });
}());
