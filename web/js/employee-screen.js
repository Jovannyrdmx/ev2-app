/**
 * EV2 — portal del empleado (paso 5.4).
 *
 * Conecta el DOM con `EV2` (API), `EV2Earnings` (saldos, retiros, cuentas) y
 * `EV2Roles`. Aquí un error se paga en confianza: enseñar como disponible un dinero
 * que todavía no lo está, o dejar pedir un retiro que el servidor va a rechazar.
 */
/* global EV2, EV2Format, EV2Earnings, EV2Roles, EV2PasswordGate, EV2Songs */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const meta = (name, fallback) => {
    const el = document.querySelector(`meta[name="${name}"]`);
    return (el && el.content) || fallback;
  };

  const api = EV2.createClient({
    baseUrl: meta('ev2:api', '/api'),
    wsUrl: meta('ev2:ws', '') || null,
  });
  const CLUB_SLUG = meta('ev2:club', 'ev2');
  // El portal es para el personal. El gerente cobra por nómina, no por este portal.
  const EMPLOYEE_ROLES = ['waiter', 'bartender', 'dancer', 'dj', 'light_tech', 'valet', 'hostess'];
  const PASSWORD_GATE_HIDES = ['screen-auth', 'screen-wrong-role', 'screen-portal'];

  const state = {
    tab: 'money', currency: 'MXN',
    employee: null, balances: [], movements: [], byType: [],
    accounts: [], withdrawals: [], openWithdrawal: null,
    songs: [], realtime: null,
  };

  const isDj = () => (api.session.user && api.session.user.role) === 'dj';
  const clubId = () => api.session.user && api.session.user.nightclub_id;

  const t = (key, vars) => (vars ? EV2Format.tf(key, vars) : EV2Format.t(key));
  const lang = () => EV2Format.getLanguage();
  const money = (a, c) => EV2Format.money(a, c || state.currency);
  const escape = (s) => String(s == null ? '' : s).replace(/[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  let toastTimer = null;
  function toast(message, kind = 'info') {
    const el = $('toast');
    el.textContent = message;
    el.className = 'fixed top-4 left-1/2 -translate-x-1/2 px-4 py-2 rounded-xl text-sm z-50 '
      + (kind === 'error' ? 'bg-red-500/90' : kind === 'ok' ? 'bg-emerald-500/90' : 'bg-slate-700/95');
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 4000);
  }

  function banner(message) {
    const el = $('banner');
    if (!message) { el.hidden = true; return; }
    el.textContent = message;
    el.hidden = false;
  }

  function showError(err, where, opts) {
    const message = EV2Format.errorMessage(err, opts);
    if (where) { where.textContent = message; where.hidden = false; } else toast(message, 'error');
  }

  // ---------------------------------------------------------------- entrar

  $('form-login').onsubmit = async (ev) => {
    ev.preventDefault();
    $('auth-error').hidden = true;
    try {
      await api.login({
        nightclubSlug: CLUB_SLUG,
        email: $('login-email').value.trim(),
        password: $('login-password').value,
      });
      await afterSignIn();
    } catch (err) { showError(err, $('auth-error'), { context: 'login' }); }
  };

  async function signOut() { await api.logout(); location.reload(); }
  $('btn-logout').onclick = signOut;
  $('btn-wrong-logout').onclick = signOut;
  $('btn-pw-logout').onclick = signOut;
  $('btn-refresh').onclick = () => loadAll();

  $('btn-lang').onclick = () => {
    EV2Format.setLanguage(EV2Format.otherLanguage());
    EV2Format.applyTo(document);
    $('btn-lang').textContent = EV2Format.otherLanguage().toUpperCase();
    renderAll();
    if (!$('screen-wrong-role').hidden) renderWrongRole();
    setConnection(lastConnection.on, lastConnection.key, lastConnection.vars);
  };

  function showPasswordGate() {
    for (const id of PASSWORD_GATE_HIDES) $(id).hidden = true;
    $('screen-password').hidden = false;
    $('pw-error').hidden = true;
  }

  $('form-password').onsubmit = async (ev) => {
    ev.preventDefault();
    $('pw-error').hidden = true;
    const current = $('pw-current').value;
    const next = $('pw-new').value;
    const problem = EV2PasswordGate.validate(current, next, $('pw-repeat').value);
    if (problem) { $('pw-error').textContent = t(problem); $('pw-error').hidden = false; return; }
    const email = (api.session.user && api.session.user.email) || '';
    try {
      await api.post('/auth/password', { current_password: current, new_password: next });
      await api.login({ nightclubSlug: CLUB_SLUG, email, password: next });
      $('form-password').reset();
      $('screen-password').hidden = true;
      toast(t('gate.done'), 'ok');
      await afterSignIn();
    } catch (err) { showError(err, $('pw-error')); }
  };

  async function afterSignIn() {
    if (EV2PasswordGate.isRequired(api.session.user)) { showPasswordGate(); return; }
    const role = api.session.user && api.session.user.role;
    if (!EMPLOYEE_ROLES.includes(role)) {
      const home = EV2Roles.describe(role, lang());
      if (home.ready && home.home && home.home !== 'employee-portal.html') {
        location.href = home.home;
        return;
      }
      renderWrongRole();
      $('screen-auth').hidden = true;
      $('screen-portal').hidden = true;
      $('screen-wrong-role').hidden = false;
      return;
    }
    $('screen-auth').hidden = true;
    $('screen-wrong-role').hidden = true;
    $('screen-portal').hidden = false;
    const user = api.session.user || {};
    $('me-name').textContent = user.display_name || '';
    $('me-role').textContent = EV2Roles.describe(user.role, lang()).label;
    await loadAll();
    connectRealtime();
  }

  function renderWrongRole() {
    const role = api.session.user && api.session.user.role;
    const info = EV2Roles.describe(role, lang());
    $('wrong-role').textContent = info.label;
    $('wrong-role-note').textContent = info.step
      ? t('staff.pending', { step: info.step }) : t('staff.noScreen');
  }

  // ---------------------------------------------------------------- carga

  async function loadAll() {
    const get = async (path, apply) => {
      try { apply(await api.get(path)); } catch (err) { showError(err); }
    };
    await Promise.all([
      get('/employees/me/dashboard', (d) => {
        state.employee = d.employee;
        state.balances = d.balances || [];
        state.movements = d.recent_movements || [];
        state.openWithdrawal = d.open_withdrawal || null;
        const found = EV2Earnings.currenciesIn(state.balances);
        if (found.length && !found.includes(state.currency)) [state.currency] = found;
      }),
      get('/employees/me/earnings', (d) => { state.byType = d.by_type || []; }),
      get('/employees/me/bank-accounts', (d) => { state.accounts = d.bank_accounts || []; }),
      get('/employees/me/withdrawals?limit=20', (d) => { state.withdrawals = d.withdrawals || []; }),
      // La cola solo se pide si hay un DJ mirando: para cualquier otro rol el servidor
      // contesta 403, y un error rojo en la pantalla de una bailarina no significa nada.
      isDj()
        ? get(`/nightclubs/${clubId()}/dj/song-requests?status=requested&limit=50`,
          (d) => { state.songs = d.song_requests || []; })
        : Promise.resolve(),
    ]);
    // El panel trae el retiro abierto, pero el historial es la fuente más fresca.
    state.openWithdrawal = EV2Earnings.openWithdrawal(state.withdrawals) || state.openWithdrawal;
    renderAll();
  }

  // ---------------------------------------------------------------- pintar

  const TABS = ['money', 'songs', 'withdraw', 'account'];

  function renderAll() {
    // La pestaña de canciones solo existe para el DJ. Escondida es mejor que
    // deshabilitada: nadie más tiene por qué preguntarse qué hay ahí.
    const songsTab = document.querySelector('[data-tab="songs"]');
    if (songsTab) songsTab.hidden = !isDj();
    if (state.tab === 'songs' && !isDj()) state.tab = 'money';

    for (const tab of TABS) $(`tab-${tab}`).hidden = tab !== state.tab;
    document.querySelectorAll('[data-tab]').forEach((b) => {
      b.classList.toggle('active', b.dataset.tab === state.tab);
    });
    renderBalance();
    renderMoney();
    renderWithdraw();
    renderAccounts();
    if (isDj()) renderSongs();
  }

  // ---------------------------------------------------------------- la cola del DJ

  function renderSongs() {
    const summary = EV2Songs.djSummary(state.songs, new Date());
    $('dj-waiting').textContent = String(summary.waiting);
    $('dj-oldest').textContent = summary.waiting ? `${summary.oldestMinutes}m` : '—';
    $('dj-tips').textContent = money(summary.tips, state.currency);

    const list = EV2Songs.pending(state.songs);
    $('dj-empty').hidden = list.length > 0;
    const box = $('dj-queue');
    box.innerHTML = '';

    list.forEach((song, i) => {
      const card = document.createElement('div');
      card.className = 'card rounded-xl p-3 flex items-center gap-3';

      const position = document.createElement('div');
      position.className = 'font-display text-xl w-8 text-center shrink-0';
      position.style.color = 'var(--ev2-cyan)';
      position.textContent = String(i + 1);
      card.appendChild(position);

      const mid = document.createElement('div');
      mid.className = 'min-w-0 flex-1';
      const title = document.createElement('p');
      title.className = 'font-display truncate';
      title.textContent = song.song_title || '';
      const sub = document.createElement('p');
      sub.className = 'text-[11px] text-white/40 truncate';
      // Los votos y la propina van juntos: son las dos razones por las que el DJ
      // decide poner una canción antes que otra, y esconder una de las dos le quita
      // la decisión.
      const bits = [song.artist, t('song.votes', { count: Number(song.votes) || 0 })];
      if (EV2Earnings.toCents(song.tips_total) > 0) {
        bits.push(money(song.tips_total, state.currency));
      }
      sub.textContent = bits.filter(Boolean).join(' · ');
      mid.append(title, sub);
      card.appendChild(mid);

      const play = document.createElement('button');
      play.className = 'ev2-button rounded-lg px-3 text-sm shrink-0';
      play.textContent = t('song.djPlay');
      play.onclick = () => markPlayed(song, play);
      card.appendChild(play);

      box.appendChild(card);
    });
  }

  async function markPlayed(song, button) {
    button.disabled = true;
    try {
      await api.post(`/nightclubs/${clubId()}/song-requests/${song.id}/play`, {});
      // Se quita de la lista de inmediato: el DJ ya la puso, y verla seguir ahí lo
      // hace tocar dos veces y recibir un 409.
      state.songs = state.songs.filter((s) => s.id !== song.id);
      renderSongs();
    } catch (err) {
      showError(err);
      button.disabled = false;
    }
  }

  document.querySelectorAll('[data-tab]').forEach((b) => {
    b.onclick = () => { state.tab = b.dataset.tab; renderAll(); };
  });

  function renderBalance() {
    const b = EV2Earnings.balanceFor(state.balances, state.currency);
    $('b-available').textContent = money(b.available, b.currency);
    $('b-earned').textContent = money(b.earned, b.currency);
    $('b-reserved').textContent = money(b.reserved, b.currency);
    $('b-withdrawn').textContent = money(b.withdrawn, b.currency);

    const currencies = EV2Earnings.currenciesIn(state.balances);
    $('currency-switch').innerHTML = currencies.length > 1
      ? currencies.map((c) => `<button data-currency="${escape(c)}" class="px-3 py-1 rounded-lg text-xs ${c === state.currency ? 'ev2-button' : 'card'}">${escape(c)}</button>`).join('')
      : '';
    $('currency-switch').querySelectorAll('[data-currency]').forEach((btn) => {
      btn.onclick = () => { state.currency = btn.dataset.currency; renderAll(); };
    });
  }

  function renderMoney() {
    const sources = EV2Earnings.byType(state.byType, state.currency);
    $('sources-list').innerHTML = sources.length
      ? sources.map((s) => `
        <div class="flex justify-between text-sm">
          <span class="text-white/60">${escape(t(s.key))}</span>
          <span>${escape(money(s.amount))}</span>
        </div>`).join('')
      : `<p class="text-sm text-white/40">${escape(t('earn.noMovements'))}</p>`;

    const rows = state.movements.filter((m) => (m.currency || 'MXN') === state.currency);
    $('movements-empty').hidden = rows.length > 0;
    $('movements-list').innerHTML = rows.map((m) => `
      <div class="flex justify-between items-center">
        <div class="min-w-0">
          <p class="text-sm">${escape(t(EV2Earnings.movementLabel(m.type)))}</p>
          <p class="text-xs text-white/40">${escape(EV2Format.dateTime(m.created_at))}</p>
        </div>
        <span class="text-sm flex-none ${m.direction === 'out' ? 'text-red-300' : ''}">${escape(money(m.amount, m.currency))}</span>
      </div>`).join('');
  }

  function renderWithdraw() {
    const balance = EV2Earnings.balanceFor(state.balances, state.currency);
    const blocker = EV2Earnings.withdrawalBlocker(balance, state.accounts, state.openWithdrawal);

    // El motivo concreto: "sin saldo" y "cuenta sin verificar" mandan a lugares distintos.
    $('withdraw-blocker').hidden = !blocker;
    if (blocker) $('withdraw-blocker').textContent = t(blocker);
    $('withdraw-form').hidden = Boolean(blocker);

    const select = $('w-account');
    const usable = EV2Earnings.usableAccounts(state.accounts);
    select.innerHTML = usable.map((a) => `
      <option value="${escape(a.id)}">${escape(a.bank_name)} · ${escape(a.account_masked || a.account_number || '')}</option>`).join('');

    $('withdrawals-empty').hidden = state.withdrawals.length > 0;
    $('withdrawals-list').innerHTML = state.withdrawals.map((w) => `
      <div class="card rounded-xl p-3 flex justify-between items-center">
        <div class="min-w-0">
          <p class="text-sm">${escape(money(w.amount, w.currency))}</p>
          <p class="text-xs text-white/40">${escape(EV2Format.dateTime(w.created_at))}${w.account_masked ? ` · ${escape(w.account_masked)}` : ''}</p>
          ${w.reason ? `<p class="text-xs text-red-300">${escape(w.reason)}</p>` : ''}
        </div>
        <span class="pill flex-none ${w.status === 'paid' ? 'pill-ok' : w.status === 'rejected' ? 'pill-bad' : 'pill-wait'}">
          ${escape(t(EV2Earnings.withdrawalLabel(w.status)))}
        </span>
      </div>`).join('');
  }

  $('btn-all').onclick = () => {
    $('w-amount').value = EV2Earnings.balanceFor(state.balances, state.currency).available;
  };

  $('withdraw-form').onsubmit = async (ev) => {
    ev.preventDefault();
    const line = document.querySelector('[data-error="amount"]');
    line.hidden = true;
    const balance = EV2Earnings.balanceFor(state.balances, state.currency);
    const problem = EV2Earnings.validateAmount($('w-amount').value, balance);
    if (problem) { line.textContent = t(problem); line.hidden = false; return; }
    try {
      await api.post('/employees/me/withdrawals', {
        amount: Number($('w-amount').value),
        currency: state.currency,
        bank_account_id: $('w-account').value || undefined,
      });
      $('withdraw-form').reset();
      await loadAll();
      toast(t('earn.request'), 'ok');
    } catch (err) { showError(err); }
  };

  function renderAccounts() {
    $('accounts-empty').hidden = state.accounts.length > 0;
    $('accounts-list').innerHTML = state.accounts.map((a) => `
      <div class="card rounded-xl p-3 flex justify-between items-center" data-account="${escape(a.id)}">
        <div class="min-w-0">
          <p class="text-sm">${escape(a.bank_name)}</p>
          <p class="text-xs text-white/40">${escape(a.account_masked || '')} · ${escape(a.holder_name || '')}</p>
        </div>
        <div class="flex items-center gap-2 flex-none">
          <span class="pill ${EV2Earnings.isUsable(a) ? 'pill-ok' : 'pill-wait'}">
            ${escape(t(EV2Earnings.isUsable(a) ? 'earn.verified' : 'earn.unverified'))}
          </span>
          <button class="text-xs text-red-300 underline" data-delete>${escape(t('earn.deleteAccount'))}</button>
        </div>
      </div>`).join('');

    $('accounts-list').querySelectorAll('[data-account]').forEach((el) => {
      el.querySelector('[data-delete]').onclick = () => removeAccount(el.dataset.account);
    });
  }

  $('btn-new-account').onclick = () => { $('account-form').hidden = !$('account-form').hidden; };
  $('btn-account-cancel').onclick = () => { $('account-form').hidden = true; clearErrors(); };

  // El routing solo existe para las cuentas de Estados Unidos.
  $('a-type').onchange = () => { $('routing-row').hidden = $('a-type').value === 'clabe'; };

  const ACCOUNT_FIELDS = {
    bank_name: 'a-bank', holder_name: 'a-holder', account_number: 'a-number',
    routing_number: 'a-routing', type: 'a-type',
  };

  function clearErrors() {
    document.querySelectorAll('#account-form [data-error]').forEach((p) => { p.hidden = true; });
    document.querySelectorAll('#account-form .field').forEach((f) => f.classList.remove('bad'));
  }

  $('account-form').onsubmit = async (ev) => {
    ev.preventDefault();
    const form = {
      type: $('a-type').value,
      bank_name: $('a-bank').value,
      holder_name: $('a-holder').value,
      account_number: $('a-number').value,
      routing_number: $('a-routing').value,
    };
    const errors = EV2Earnings.validateAccount(form);
    clearErrors();
    if (Object.keys(errors).length) {
      for (const [field, key] of Object.entries(errors)) {
        const p = document.querySelector(`#account-form [data-error="${field}"]`);
        if (p) { p.textContent = t(key); p.hidden = false; }
        const input = $(ACCOUNT_FIELDS[field]);
        if (input) input.classList.add('bad');
      }
      return;
    }
    try {
      await api.post('/employees/me/bank-accounts', EV2Earnings.accountPayload(form));
      $('account-form').reset();
      $('routing-row').hidden = true;
      $('account-form').hidden = true;
      await loadAll();
      toast(t('manager.saved'), 'ok');
    } catch (err) { showError(err); }
  };

  async function removeAccount(accountId) {
    if (!window.confirm(t('earn.confirmDeleteAccount'))) return;
    try {
      await api.del(`/employees/me/bank-accounts/${accountId}`);
      await loadAll();
    } catch (err) { showError(err); }
  }

  api.on('auth:expired', () => {
    banner(t('banner.expired'));
    setTimeout(() => location.reload(), 2500);
  });

  // ---------------------------------------------------------------- tiempo real

  const lastConnection = { on: false, key: 'top.offline', vars: null };

  function setConnection(on, key, vars) {
    lastConnection.on = on;
    lastConnection.key = key;
    lastConnection.vars = vars || null;
    $('rt-dot').className = `dot ${on === true ? 'dot-on' : on === null ? 'dot-wait' : 'dot-off'}`;
    $('rt-text').textContent = vars && vars.text ? vars.text : t(key);
  }

  /**
   * El portal también escucha.
   *
   * Para el DJ es lo que hace que la cola sirva: una canción pedida hace diez minutos
   * que él no ve es un cliente convencido de que lo ignoraron. Para el resto es su
   * propina apareciendo sola, sin tener que jalar la pantalla hacia abajo.
   */
  function connectRealtime() {
    if (state.realtime) return;
    const rt = api.createRealtime();
    state.realtime = rt;
    rt.on('open', () => { setConnection(true, 'top.live'); banner(null); });
    rt.on('reconnecting', (i) => setConnection(null, 'realtime.reconnecting',
      { text: `${t('realtime.reconnecting')} ${Math.round(i.in_ms / 1000)}s` }));
    rt.on('close', () => setConnection(false, 'top.offline'));
    rt.on('replaced', () => { setConnection(false, 'top.otherSession'); banner(t('banner.replaced')); });
    rt.on('resync_required', async () => { banner(t('banner.updating')); await loadAll(); banner(null); });

    rt.on('event', async (message) => {
      // El tipo real vive en `event_type`; `type` siempre vale 'event'.
      const kind = message && (message.event_type || message.type);
      if (EV2Songs.affectsSongs(message)) {
        await loadAll();
        if (kind === 'song_requested' || kind === 'song_request_voted') {
          // En la cabina no se oye nada: el aviso es vibración.
          try { if (navigator.vibrate) navigator.vibrate([120, 60, 120]); } catch { /* bloqueado */ }
        }
        return;
      }
      if (['tip_received', 'song_tip_received', 'withdrawal_updated'].includes(kind)) {
        await loadAll();
        if (kind !== 'withdrawal_updated') toast(t('earn.mTip'), 'ok');
      }
    });

    rt.connect();
  }

  // ---------------------------------------------------------------- arranque

  (async function boot() {
    EV2Format.setLanguage(EV2Format.getLanguage());
    EV2Format.applyTo(document);
    $('btn-lang').textContent = EV2Format.otherLanguage().toUpperCase();
    const user = await api.resume();
    if (user) await afterSignIn();
  }());
}());
