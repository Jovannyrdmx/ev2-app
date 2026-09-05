/**
 * EV2 — pantalla del mesero y la hostess (paso 5.7, segunda mitad).
 *
 * Conecta el DOM con `EV2` (API y socket), `EV2Staff` (charolas, ocupación, propinas)
 * y `EV2Roles`. Las decisiones viven en `staff-floor.js` y están probadas ahí.
 */
/* global EV2, EV2Format, EV2Staff, EV2Roles, EV2PasswordGate */
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
  const FLOOR_ROLES = ['waiter', 'hostess', 'manager', 'admin'];
  const PASSWORD_GATE_HIDES = ['screen-auth', 'screen-wrong-role', 'screen-floor'];

  const state = {
    tab: 'trays', orders: [], tables: [], stats: null, tips: [],
    employee: null, currency: 'MXN', realtime: null, busy: new Set(), arrived: new Set(),
  };

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

  async function signOut() {
    if (state.realtime) state.realtime.close();
    await api.logout();
    location.reload();
  }
  $('btn-logout').onclick = signOut;
  $('btn-wrong-logout').onclick = signOut;
  $('btn-pw-logout').onclick = signOut;

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
      // El servidor cierra todas las sesiones al cambiarla: hay que entrar de nuevo.
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
    if (!FLOOR_ROLES.includes(role)) {
      const home = EV2Roles.describe(role, lang());
      if (home.ready && home.home && home.home !== 'staff.html') { location.href = home.home; return; }
      renderWrongRole();
      $('screen-auth').hidden = true;
      $('screen-floor').hidden = true;
      $('screen-wrong-role').hidden = false;
      return;
    }
    $('screen-auth').hidden = true;
    $('screen-wrong-role').hidden = true;
    $('screen-floor').hidden = false;
    const user = api.session.user || {};
    $('me-name').textContent = user.display_name || '';
    $('me-role').textContent = EV2Roles.describe(user.role, lang()).label;
    await loadAll();
    connectRealtime();
    // El reloj de espera avanza solo: si no, "hace 2 min" se queda en 2 min toda la noche.
    setInterval(renderAll, 30000);
  }

  function renderWrongRole() {
    const role = api.session.user && api.session.user.role;
    const info = EV2Roles.describe(role, lang());
    $('wrong-role').textContent = info.label;
    $('wrong-role-note').textContent = info.step
      ? t('staff.pending', { step: info.step }) : t('staff.noScreen');
  }

  // ---------------------------------------------------------------- carga

  const clubId = () => api.session.user && api.session.user.nightclub_id;

  async function loadAll() {
    const club = clubId();
    const get = async (path, apply) => {
      try { apply(await api.get(path)); } catch (err) { showError(err); }
    };
    await Promise.all([
      get(`/nightclubs/${club}/orders?active=true&limit=100`, (d) => { state.orders = d.orders || []; }),
      get(`/nightclubs/${club}/tables`, (d) => { state.tables = d.tables || []; }),
      get(`/nightclubs/${club}/tables/stats`, (d) => { state.stats = d; }),
      get(`/nightclubs/${club}/staff/me/tips?limit=50`, (d) => { state.tips = d.tips || []; }),
      // `on_shift` viene aquí y no en /auth/me: es lo que decide el botón del turno.
      get('/employees/me', (d) => { state.employee = d.employee; }),
    ]);
    renderAll();
  }

  async function loadOrders() {
    try {
      const d = await api.get(`/nightclubs/${clubId()}/orders?active=true&limit=100`);
      state.orders = d.orders || [];
    } catch (err) { showError(err); }
    renderAll();
  }

  async function loadTables() {
    const club = clubId();
    try {
      const [tables, stats] = await Promise.all([
        api.get(`/nightclubs/${club}/tables`),
        api.get(`/nightclubs/${club}/tables/stats`),
      ]);
      state.tables = tables.tables || [];
      state.stats = stats;
    } catch (err) { showError(err); }
    renderAll();
  }

  // ---------------------------------------------------------------- pintar

  const TABS = ['trays', 'tables', 'me'];

  function renderAll() {
    for (const tab of TABS) $(`tab-${tab}`).hidden = tab !== state.tab;
    document.querySelectorAll('[data-tab]').forEach((b) => {
      b.classList.toggle('active', b.dataset.tab === state.tab);
    });
    renderTrays();
    renderTables();
    renderMe();
  }

  document.querySelectorAll('[data-tab]').forEach((b) => {
    b.onclick = () => { state.tab = b.dataset.tab; renderAll(); };
  });

  function renderTrays() {
    const now = Date.now();
    const s = EV2Staff.summary(state.orders, now);
    $('s-trays').textContent = s.trays;
    $('s-items').textContent = s.items;
    $('s-coming').textContent = s.coming;
    $('s-oldest').textContent = s.oldest === null ? '—' : t('bar.minutes', { n: s.oldest });
    $('count-trays').textContent = s.trays;

    const list = EV2Staff.trays(state.orders, now);
    $('trays-empty').hidden = list.length > 0;
    $('trays-list').innerHTML = list.map((group) => {
      const wait = group.waitMinutes === null ? ''
        : (group.waitMinutes < 1 ? t('bar.justNow') : t('bar.minutes', { n: group.waitMinutes }));
      const flash = group.orders.some((o) => state.arrived.has(o.id)) ? ' just-arrived' : '';
      const busy = group.orders.some((o) => state.busy.has(o.id));
      const detail = group.orders.map((o) => `
        <p class="text-sm text-white/70">${escape((o.items || []).map((i) => `${i.quantity}× ${i.name || ''}`).join(', '))}
          <span class="text-white/40">· ${escape(o.recipient_name ? `${t('bar.gift')}: ${o.recipient_name}` : (o.sender_name || ''))}</span></p>`).join('');
      return `
      <article class="card wait-${group.urgency}${flash} rounded-xl p-4" data-tray="${escape(group.table_id || '')}">
        <div class="flex justify-between items-start gap-3">
          <div class="min-w-0">
            <p class="font-display text-xl">${group.table_code
    ? `${escape(t('floor.tableShort'))} ${escape(group.table_code)}`
    : escape(t('floor.noTable'))}</p>
            ${detail}
          </div>
          <p class="text-xs flex-none ${group.urgency === 'late' ? 'text-red-300' : group.urgency === 'warn' ? 'text-amber-300' : 'text-white/50'}">${escape(wait)}</p>
        </div>
        <button class="ev2-button w-full rounded-lg py-3 mt-3 font-display" data-deliver="${escape(group.table_id || '')}" ${busy ? 'disabled' : ''}>
          ${escape(t('floor.deliver'))} · ${group.items}
        </button>
      </article>`;
    }).join('');

    $('trays-list').querySelectorAll('[data-deliver]').forEach((b) => {
      b.onclick = () => deliverTray(b.dataset.deliver);
    });
  }

  /**
   * Un toque entrega TODA la charola de esa mesa: el mesero hace un viaje, no uno por
   * pedido. Cada pedido es su propia llamada, y si una falla se dice cuál.
   */
  async function deliverTray(tableId) {
    const group = EV2Staff.trays(state.orders).find((g) => (g.table_id || '') === tableId);
    if (!group) return;
    for (const order of group.orders) state.busy.add(order.id);
    renderTrays();
    let failed = 0;
    for (const order of group.orders) {
      try {
        await api.post(`/nightclubs/${clubId()}/orders/${order.id}/status`, { status: 'delivered' });
      } catch (err) {
        failed += 1;
        showError(err);
      }
    }
    for (const order of group.orders) state.busy.delete(order.id);
    await loadOrders();
    if (!failed) toast(t('floor.delivered'), 'ok');
  }

  function renderTables() {
    const o = EV2Staff.occupancy(state.stats);
    $('o-occupied').textContent = o.occupied;
    $('o-free').textContent = o.free;
    $('o-guests').textContent = o.guests;

    const seated = state.tables.filter((table) => (table.occupants || []).length > 0);
    $('tables-list').innerHTML = seated.map((table) => `
      <div class="card rounded-xl p-3" data-table="${escape(table.id)}">
        <div class="flex justify-between items-center gap-2">
          <div class="min-w-0">
            <p class="font-display">${escape(t('floor.tableShort'))} ${escape(table.table_number || table.code)}
              <span class="text-xs text-white/40">${escape(table.section || '')}</span></p>
            <p class="text-xs text-white/60">${escape((table.occupants || []).map((g) => g.display_name || '—').join(', '))}</p>
          </div>
          <span class="pill pill-wait flex-none">${(table.occupants || []).length}/${table.capacity}</span>
        </div>
        <div class="flex flex-wrap gap-2 mt-2">
          ${(table.occupants || []).map((g) => `
            <button class="card rounded-lg px-3 py-2 text-xs text-red-300" data-release="${escape(g.user_id)}">
              ${escape(t('floor.release'))}: ${escape(g.display_name || '—')}
            </button>`).join('')}
        </div>
      </div>`).join('');

    $('tables-list').querySelectorAll('[data-table]').forEach((el) => {
      el.querySelectorAll('[data-release]').forEach((b) => {
        b.onclick = () => releaseGuest(el.dataset.table, b.dataset.release);
      });
    });
  }

  async function releaseGuest(tableId, userId) {
    if (!window.confirm(t('floor.confirmRelease'))) return;
    try {
      await api.post(`/nightclubs/${clubId()}/tables/${tableId}/release`, { user_id: userId });
      await loadTables();
    } catch (err) { showError(err); }
  }

  function renderMe() {
    const employee = state.employee || {};
    const onShift = Boolean(employee.on_shift);
    const minutes = EV2Staff.shiftMinutes(employee.current_shift || employee.shift, Date.now());
    $('shift-state').textContent = onShift
      ? (minutes === null ? t('floor.onShift', { n: 0 }) : t('floor.onShift', { n: minutes }))
      : t('floor.offShift');
    $('btn-shift').textContent = t(onShift ? 'floor.shiftEnd' : 'floor.shiftStart');

    const totals = EV2Staff.tipTotals(state.tips, state.currency);
    $('tips-paid').textContent = money(totals.paid, totals.currency);
    $('tips-pending').textContent = money(totals.pending, totals.currency);
    $('tips-empty').hidden = state.tips.length > 0;
    $('tips-list').innerHTML = state.tips.slice(0, 20).map((tip) => `
      <div class="card rounded-lg p-3 flex justify-between items-center">
        <div class="min-w-0">
          <p class="text-sm">${escape(tip.from_name || t('bar.gift'))}</p>
          <p class="text-xs text-white/40">${escape(EV2Format.dateTime(tip.created_at))}</p>
        </div>
        <div class="text-right flex-none">
          <p class="text-sm">${escape(money(tip.amount, tip.currency))}</p>
          <span class="pill ${tip.status === 'paid' ? 'pill-ok' : tip.status === 'pending' ? 'pill-wait' : 'pill-off'}">
            ${escape(t(tip.status === 'paid' ? 'floor.tipsPaid' : 'floor.tipsPending'))}
          </span>
        </div>
      </div>`).join('');
  }

  $('btn-shift').onclick = async () => {
    const onShift = Boolean(state.employee && state.employee.on_shift);
    if (onShift && !window.confirm(t('floor.confirmEndShift'))) return;
    try {
      await api.post(`/nightclubs/${clubId()}/staff/shifts/${onShift ? 'end' : 'start'}`, {});
      const d = await api.get('/employees/me');
      state.employee = d.employee;
      renderMe();
      toast(t(onShift ? 'floor.shiftEnd' : 'floor.shiftStart'), 'ok');
    } catch (err) { showError(err); }
  };

  // ---------------------------------------------------------------- tiempo real

  const lastConnection = { on: false, key: 'realtime.reconnecting', vars: null };

  function setConnection(on, key, vars) {
    lastConnection.on = on;
    lastConnection.key = key;
    lastConnection.vars = vars || null;
    $('rt-dot').className = `dot ${on === true ? 'dot-on' : on === null ? 'dot-wait' : 'dot-off'}`;
    $('rt-text').textContent = vars && vars.text ? vars.text : t(key);
  }

  function connectRealtime() {
    const rt = api.createRealtime();
    state.realtime = rt;
    rt.on('open', () => { setConnection(true, 'top.live'); banner(null); });
    rt.on('reconnecting', (i) => setConnection(null, 'realtime.reconnecting',
      { text: `${t('realtime.reconnecting')} ${Math.round(i.in_ms / 1000)}s` }));
    rt.on('close', () => setConnection(false, 'top.offline'));
    rt.on('replaced', () => { setConnection(false, 'top.otherSession'); banner(t('banner.replaced')); });
    rt.on('resync_required', async () => { banner(t('banner.updating')); await loadAll(); banner(null); });

    rt.on('event', async (message) => {
      const change = EV2Staff.applyEvent(message);
      if (!change.changed) return;
      if (change.reloadTables) { await loadTables(); return; }
      if (change.announce && change.orderId) {
        state.arrived.add(change.orderId);
        setTimeout(() => { state.arrived.delete(change.orderId); }, 4000);
        // En un antro no se oye nada: el aviso es vibración más el destello de la tarjeta.
        try { if (navigator.vibrate) navigator.vibrate([150, 60, 150]); } catch { /* bloqueado */ }
        toast(t('floor.newReady'), 'ok');
      }
      await loadOrders();
    });

    api.on('auth:expired', () => {
      banner(t('banner.expired'));
      setTimeout(() => location.reload(), 2500);
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
