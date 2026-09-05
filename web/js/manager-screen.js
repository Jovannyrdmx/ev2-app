/**
 * EV2 — panel del gerente (paso 5.5).
 *
 * Conecta el DOM con `EV2` (API y socket), `EV2Manager` (los números y las validaciones)
 * y `EV2Roles`. Cubre lo que el dueño dejó para configurar después: conductores, zonas y
 * tarifas del taxi, y los cajones del estacionamiento — más el resumen del turno.
 */
/* global EV2, EV2Format, EV2Manager, EV2Roles, EV2PasswordGate */
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
  const MANAGER_ROLES = ['manager', 'admin'];

  const state = {
    tab: 'summary', currency: 'MXN',
    dashboard: null, drivers: [], taxiSettings: null, fares: [],
    valetSettings: null, spots: [], occupancy: null,
    realtime: null, busy: false,
  };
  const secret = EV2Manager.createSecretBox();

  const t = (key, vars) => (vars ? EV2Format.tf(key, vars) : EV2Format.t(key));
  const lang = () => EV2Format.getLanguage();
  const money = (amount, currency) => EV2Format.money(amount, currency || state.currency);
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
  $('btn-refresh').onclick = () => loadAll();

  $('btn-lang').onclick = () => {
    EV2Format.setLanguage(EV2Format.otherLanguage());
    EV2Format.applyTo(document);
    $('btn-lang').textContent = EV2Format.otherLanguage().toUpperCase();
    renderAll();
    if (!$('screen-wrong-role').hidden) renderWrongRole();
    setConnection(lastConnection.on, lastConnection.key, lastConnection.vars);
  };

  const PASSWORD_GATE_HIDES = ['screen-auth', 'screen-wrong-role', 'screen-manager'];

  /**
   * El servidor bloquea TODAS las rutas de alguien con `must_change_password` salvo
   * /auth/password, /auth/logout y /auth/me. Sin esta puerta, quien entra con una
   * contraseña temporal ve errores en cada llamada y no puede hacer nada.
   */
  function showPasswordGate() {
    for (const id of PASSWORD_GATE_HIDES) $(id).hidden = true;
    $('screen-password').hidden = false;
    $('pw-error').hidden = true;
  }

  $('btn-pw-logout').onclick = signOut;

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
      // El servidor CIERRA todas las sesiones al cambiar la contraseña (revoca los
      // tokens de refresco). El que tiene el navegador quedó muerto, así que hay que
      // entrar de nuevo con la contraseña nueva: si no, la siguiente llamada falla y
      // la persona se queda fuera justo después de hacer lo que se le pidió.
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
    if (!MANAGER_ROLES.includes(role)) {
      const home = EV2Roles.describe(role, lang());
      if (home.ready && home.home && home.home !== 'manager.html') {
        location.href = home.home;
        return;
      }
      renderWrongRole();
      $('screen-auth').hidden = true;
      $('screen-manager').hidden = true;
      $('screen-wrong-role').hidden = false;
      return;
    }
    $('screen-auth').hidden = true;
    $('screen-wrong-role').hidden = true;
    $('screen-manager').hidden = false;
    $('me-name').textContent = (api.session.user && api.session.user.display_name) || '';
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

  const clubId = () => api.session.user && api.session.user.nightclub_id;

  /**
   * Cada panel se pide por separado y ninguno tumba a los demás: si el club todavía no
   * tiene valet configurado, eso no debe dejar sin números al resumen del turno.
   */
  async function loadAll() {
    const club = clubId();
    const get = async (path, apply) => {
      try { apply(await api.get(path)); } catch (err) { showError(err); }
    };
    await Promise.all([
      get(`/nightclubs/${club}/dashboard`, (d) => {
        state.dashboard = d;
        const found = EV2Manager.currenciesIn(d.revenue_today);
        if (found.length && !found.includes(state.currency)) [state.currency] = found;
      }),
      get(`/nightclubs/${club}/drivers?include_inactive=true&limit=200`, (d) => { state.drivers = d.drivers || []; }),
      get(`/nightclubs/${club}/taxi-settings`, (d) => { state.taxiSettings = d.settings; }),
      get(`/nightclubs/${club}/taxi-fares?include_inactive=false`, (d) => { state.fares = d.fares || []; }),
      get(`/nightclubs/${club}/valet-settings`, (d) => { state.valetSettings = d.settings; }),
      get(`/nightclubs/${club}/parking-spots`, (d) => {
        state.spots = d.spots || [];
        state.occupancy = d.occupancy || null;
      }),
    ]);
    renderAll();
  }

  // ---------------------------------------------------------------- pintar

  const TABS = ['summary', 'drivers', 'taxi', 'parking'];

  function renderAll() {
    for (const tab of TABS) $(`tab-${tab}`).hidden = tab !== state.tab;
    document.querySelectorAll('[data-tab]').forEach((b) => {
      b.classList.toggle('active', b.dataset.tab === state.tab);
    });
    renderSummary();
    renderDrivers();
    renderTaxi();
    renderParking();
    renderSecret();
  }

  document.querySelectorAll('[data-tab]').forEach((b) => {
    b.onclick = () => { state.tab = b.dataset.tab; renderAll(); };
  });

  function renderSummary() {
    const s = EV2Manager.summary(state.dashboard, state.currency);
    $('s-occupancy').textContent = `${s.occupancy.occupied}/${s.occupancy.total}`;
    $('s-orders').textContent = s.orders.inProgress + s.orders.ready;
    $('s-shift').textContent = s.staffOnShift;
    $('s-delivered').textContent = s.orders.delivered;
    $('s-poserr').textContent = s.orders.posErrors;
    // Un pedido que la caja rechazó no se sirve solo: se marca en rojo.
    $('s-poserr-card').classList.toggle('warn', s.orders.posErrors > 0);

    $('s-club').textContent = money(s.money.club, s.money.currency);
    $('s-staff').textContent = money(s.money.staff, s.money.currency);
    $('s-drivers').textContent = money(s.money.drivers, s.money.currency);

    const currencies = EV2Manager.currenciesIn(state.dashboard && state.dashboard.revenue_today);
    $('currency-switch').innerHTML = currencies.length > 1
      ? currencies.map((c) => `<button data-currency="${escape(c)}" class="px-3 py-1 rounded-lg text-xs ${c === state.currency ? 'ev2-button' : 'card'}">${escape(c)}</button>`).join('')
      : '';
    $('currency-switch').querySelectorAll('[data-currency]').forEach((b) => {
      b.onclick = () => { state.currency = b.dataset.currency; renderSummary(); };
    });
  }

  const STATE_PILL = {
    inactive: ['manager.driverInactive', 'pill-bad'],
    unverified: ['manager.driverUnverified', 'pill-wait'],
    onTrip: ['manager.driverOnTrip', 'pill-wait'],
    atVenue: ['manager.driverAtVenue', 'pill-ok'],
    available: ['manager.driverAvailable', 'pill-ok'],
    off: ['manager.driverOff', 'pill-off'],
  };

  function renderDrivers() {
    $('drivers-empty').hidden = state.drivers.length > 0;
    $('drivers-list').innerHTML = state.drivers.map((d) => {
      const [key, cls] = STATE_PILL[EV2Manager.driverState(d)] || STATE_PILL.off;
      return `
      <article class="card rounded-xl p-4" data-driver="${escape(d.id)}">
        <div class="flex justify-between items-start gap-3">
          <div class="min-w-0">
            <p class="font-display">${escape(d.display_name || `${d.first_name || ''} ${d.last_name || ''}`.trim())}</p>
            <p class="text-sm text-white/60">${escape(EV2Manager.vehicleOf(d) || '—')}</p>
            <p class="text-xs text-white/40">${escape(d.company || '')}${d.phone ? ` · ${escape(d.phone)}` : ''}</p>
          </div>
          <span class="pill ${cls}">${escape(t(key))}</span>
        </div>
        <div class="flex flex-wrap gap-2 mt-3">
          <button class="card rounded-lg px-3 py-2 text-xs" data-act="trust" data-value="${d.trusted ? 'false' : 'true'}">
            ${escape(t(d.trusted ? 'manager.unverify' : 'manager.verify'))}
          </button>
          <button class="card rounded-lg px-3 py-2 text-xs" data-act="active" data-value="${d.active ? 'false' : 'true'}">
            ${escape(t(d.active ? 'manager.deactivate' : 'manager.activate'))}
          </button>
          <button class="card rounded-lg px-3 py-2 text-xs" data-act="reset">${escape(t('manager.resetPassword'))}</button>
        </div>
      </article>`;
    }).join('');

    $('drivers-list').querySelectorAll('[data-driver]').forEach((el) => {
      el.querySelectorAll('[data-act]').forEach((b) => {
        b.onclick = () => driverAction(el.dataset.driver, b.dataset.act, b.dataset.value);
      });
    });
  }

  function renderTaxi() {
    const s = state.taxiSettings || {};
    $('taxi-enabled').checked = Boolean(s.enabled);
    if (document.activeElement !== $('taxi-pickup')) $('taxi-pickup').value = s.pickup_point || '';

    $('zones-empty').hidden = state.fares.length > 0;
    $('zones-list').innerHTML = state.fares.map((f) => `
      <div class="flex justify-between items-center gap-2" data-fare="${escape(f.id)}">
        <span class="text-sm min-w-0 truncate">${escape(f.zone)}</span>
        <span class="text-sm flex-none">${escape(EV2Format.money(f.amount, f.currency))}</span>
        <button class="text-xs text-red-300 underline flex-none" data-remove>${escape(t('manager.remove'))}</button>
      </div>`).join('');
    $('zones-list').querySelectorAll('[data-fare]').forEach((el) => {
      el.querySelector('[data-remove]').onclick = () => removeFare(el.dataset.fare);
    });
  }

  function renderParking() {
    const o = EV2Manager.occupancy(state.occupancy);
    $('p-total').textContent = o.total;
    $('p-free').textContent = o.free;
    $('p-occupied').textContent = o.occupied;

    const v = state.valetSettings || {};
    $('valet-enabled').checked = Boolean(v.enabled);
    if (document.activeElement !== $('valet-fee')) {
      $('valet-fee').value = v.fee_amount === undefined || v.fee_amount === null ? '' : v.fee_amount;
    }

    $('spots-empty').hidden = state.spots.length > 0;
    $('spots-list').innerHTML = state.spots.map((s) => `
      <span class="pill ${s.occupied ? 'pill-wait' : 'pill-off'}">${escape(s.code)}</span>`).join('');
  }

  function renderSecret() {
    const held = secret.peek();
    $('secret-box').hidden = !held;
    if (held) {
      $('secret-who').textContent = held.who;
      $('secret-value').textContent = held.password;
    }
  }
  $('btn-secret-ok').onclick = () => { secret.clear(); renderSecret(); };

  // ---------------------------------------------------------------- conductores

  $('btn-new-driver').onclick = () => {
    $('driver-form').hidden = !$('driver-form').hidden;
  };
  $('btn-driver-cancel').onclick = () => { $('driver-form').hidden = true; clearFieldErrors(); };

  function clearFieldErrors() {
    document.querySelectorAll('[data-error]').forEach((p) => { p.hidden = true; p.textContent = ''; });
    document.querySelectorAll('#driver-form .field').forEach((f) => f.classList.remove('bad'));
  }

  const DRIVER_FIELDS = {
    first_name: 'd-first', last_name: 'd-last', email: 'd-email', phone: 'd-phone',
    birth_date: 'd-birth', vehicle_plate: 'd-plate',
  };

  function showFieldErrors(errors) {
    clearFieldErrors();
    for (const [field, key] of Object.entries(errors)) {
      const p = document.querySelector(`[data-error="${field}"]`);
      if (p) { p.textContent = t(key); p.hidden = false; }
      const input = $(DRIVER_FIELDS[field]);
      if (input) input.classList.add('bad');
    }
  }

  $('driver-form').onsubmit = async (ev) => {
    ev.preventDefault();
    const form = {
      first_name: $('d-first').value.trim(),
      last_name: $('d-last').value.trim(),
      email: $('d-email').value.trim(),
      phone: $('d-phone').value.trim(),
      birth_date: $('d-birth').value,
      vehicle_plate: $('d-plate').value.trim(),
    };
    // Se comprueba aquí primero para no perder el formulario lleno por algo que se ve
    // desde la pantalla. El servidor vuelve a comprobarlo todo de todas formas.
    const errors = EV2Manager.validateDriver(form);
    if (Object.keys(errors).length) { showFieldErrors(errors); return; }
    clearFieldErrors();

    const body = Object.assign({}, form, { trusted: $('d-trusted').checked });
    for (const [key, id] of [['company', 'd-company'], ['vehicle_color', 'd-color'],
      ['vehicle_make', 'd-make'], ['vehicle_model', 'd-model']]) {
      const value = $(id).value.trim();
      if (value) body[key] = value;
    }

    try {
      const data = await api.post(`/nightclubs/${clubId()}/drivers`, body);
      // La contraseña temporal viene UNA vez: se guarda antes de repintar nada.
      secret.hold(`${form.first_name} ${form.last_name}`.trim(), data.temporary_password);
      $('driver-form').reset();
      $('d-trusted').checked = true;
      $('driver-form').hidden = true;
      await loadAll();
      toast(t('manager.saved'), 'ok');
    } catch (err) { showError(err); }
  };

  async function driverAction(driverId, action, value) {
    try {
      if (action === 'reset') {
        const data = await api.post(`/nightclubs/${clubId()}/drivers/${driverId}/reset-password`, {});
        const who = state.drivers.find((d) => d.id === driverId);
        secret.hold(who ? (who.display_name || who.first_name || '') : '', data.temporary_password);
        renderSecret();
        return;
      }
      const body = action === 'trust' ? { trusted: value === 'true' } : { active: value === 'true' };
      await api.patch(`/nightclubs/${clubId()}/drivers/${driverId}`, body);
      await loadAll();
      toast(t('manager.saved'), 'ok');
    } catch (err) { showError(err); }
  }

  // ---------------------------------------------------------------- taxi

  $('btn-taxi-save').onclick = async () => {
    try {
      const body = { enabled: $('taxi-enabled').checked };
      const pickup = $('taxi-pickup').value.trim();
      if (pickup) body.pickup_point = pickup;
      const data = await api.put(`/nightclubs/${clubId()}/taxi-settings`, body);
      state.taxiSettings = data.settings;
      renderTaxi();
      toast(t('manager.saved'), 'ok');
    } catch (err) { showError(err); }
  };

  $('btn-zone-add').onclick = async () => {
    const zone = $('zone-name').value.trim();
    const amount = Number($('zone-amount').value);
    if (!zone || !Number.isFinite(amount) || amount < 0) { toast(t('manager.errRequired'), 'error'); return; }
    try {
      await api.post(`/nightclubs/${clubId()}/taxi-fares`, { zone, amount });
      $('zone-name').value = '';
      $('zone-amount').value = '';
      const data = await api.get(`/nightclubs/${clubId()}/taxi-fares`);
      state.fares = data.fares || [];
      renderTaxi();
      toast(t('manager.saved'), 'ok');
    } catch (err) { showError(err); }
  };

  async function removeFare(fareId) {
    try {
      // Baja lógica en el servidor: los viajes viejos siguen apuntando a su tarifa.
      await api.del(`/nightclubs/${clubId()}/taxi-fares/${fareId}`);
      state.fares = state.fares.filter((f) => f.id !== fareId);
      renderTaxi();
    } catch (err) { showError(err); }
  }

  // ---------------------------------------------------------------- cajones

  function previewSpots() {
    const { spots, invalid } = EV2Manager.parseSpots($('spots-text').value, $('spots-zone').value);
    const parts = [];
    if (spots.length) parts.push(t('manager.spotsAdded', { n: spots.length }).replace(/\.$/, ''));
    if (invalid.length) parts.push(t('manager.spotsInvalid', { list: invalid.slice(0, 5).join(', ') }));
    $('spots-preview').textContent = parts.join(' · ');
  }
  $('spots-text').oninput = previewSpots;
  $('spots-zone').oninput = previewSpots;

  $('btn-spots-add').onclick = async () => {
    const { spots, invalid } = EV2Manager.parseSpots($('spots-text').value, $('spots-zone').value);
    if (!spots.length) { toast(t('manager.errRequired'), 'error'); return; }
    try {
      const data = await api.post(`/nightclubs/${clubId()}/parking-spots`, { spots });
      $('spots-text').value = '';
      previewSpots();
      await loadAll();
      // Lo que no se entendió y lo que ya existía se dicen: si el gerente pega cien y
      // entran noventa, tiene que enterarse aquí y no descubrirlo el sábado.
      const said = [t('manager.spotsAdded', { n: data.created })];
      if (data.skipped) said.push(t('manager.spotsSkipped', { n: data.skipped }));
      if (invalid.length) said.push(t('manager.spotsInvalid', { list: invalid.join(', ') }));
      toast(said.join(' '), invalid.length ? 'info' : 'ok');
    } catch (err) { showError(err); }
  };

  $('btn-valet-save').onclick = async () => {
    try {
      const body = { enabled: $('valet-enabled').checked };
      const fee = Number($('valet-fee').value);
      // Cero es un valor válido a propósito: el dueño eligió "gratis, solo propina".
      if ($('valet-fee').value !== '' && Number.isFinite(fee) && fee >= 0) body.fee_amount = fee;
      const data = await api.put(`/nightclubs/${clubId()}/valet-settings`, body);
      state.valetSettings = data.settings;
      renderParking();
      toast(t('manager.saved'), 'ok');
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

    // El panel se refresca solo con casi cualquier evento del club, pero no en cada uno:
    // sería una consulta por trago servido. Se agrupan en una recarga cada pocos segundos.
    let pending = null;
    rt.on('event', () => {
      if (pending) return;
      pending = setTimeout(async () => { pending = null; await loadAll(); }, 4000);
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
