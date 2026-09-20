/**
 * EV2 — pantalla del valet (paso 5.6, segunda mitad).
 *
 * Conecta el DOM con `EV2` (API y socket), `EV2Valet` (carriles, espera, búsqueda) y
 * `EV2Roles`. Las decisiones viven en `valet-tickets.js` y están probadas ahí.
 */
/* global EV2, EV2Format, EV2Valet, EV2Roles, EV2PasswordGate */
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
  const STAND_ROLES = ['valet', 'hostess', 'manager', 'admin'];
  const PASSWORD_GATE_HIDES = ['screen-auth', 'screen-wrong-role', 'screen-valet'];

  const state = {
    lane: 'requested', tickets: [], spots: [], settings: null, query: '',
    realtime: null, busy: new Set(), delivering: null, secret: null,
  };

  const t = (key, vars) => (vars ? EV2Format.tf(key, vars) : EV2Format.t(key));
  const lang = () => EV2Format.getLanguage();
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
      await api.login({ nightclubSlug: CLUB_SLUG, email, password: next });
      $('form-password').reset();
      $('screen-password').hidden = true;
      toast(t('gate.done'), 'ok');
      await afterSignIn();
    } catch (err) { showError(err, $('pw-error')); }
  };

  async function afterSignIn() {
    // El PIN se cambia donde está el teclado, no aquí (D46): mientras no lo cambie, el
    // servidor le bloquea todas las rutas y esta pantalla solo sabría dar errores.
    if (EV2PasswordGate.mustChangePin(api.session.user)) {
      location.href = EV2PasswordGate.PIN_PAGE;
      return;
    }
    if (EV2PasswordGate.isRequired(api.session.user)) { showPasswordGate(); return; }
    const role = api.session.user && api.session.user.role;
    if (!STAND_ROLES.includes(role)) {
      const home = EV2Roles.describe(role, lang());
      if (home.ready && home.home && home.home !== 'valet.html') { location.href = home.home; return; }
      renderWrongRole();
      $('screen-auth').hidden = true;
      $('screen-valet').hidden = true;
      $('screen-wrong-role').hidden = false;
      return;
    }
    $('screen-auth').hidden = true;
    $('screen-wrong-role').hidden = true;
    $('screen-valet').hidden = false;
    $('me-name').textContent = (api.session.user && api.session.user.display_name) || '';
    await loadAll();
    connectRealtime();
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
      get(`/nightclubs/${club}/valet/tickets?open=true&limit=200`, (d) => { state.tickets = d.tickets || []; }),
      get(`/nightclubs/${club}/parking-spots`, (d) => { state.spots = d.spots || []; }),
      get(`/nightclubs/${club}/valet-settings`, (d) => { state.settings = d.settings; }),
    ]);
    renderAll();
  }

  async function loadTickets() {
    try {
      const d = await api.get(`/nightclubs/${clubId()}/valet/tickets?open=true&limit=200`);
      state.tickets = d.tickets || [];
    } catch (err) { showError(err); }
    renderAll();
  }

  // ---------------------------------------------------------------- pintar

  function renderAll() {
    const now = Date.now();
    const counts = EV2Valet.counts(state.tickets);
    $('count-requested').textContent = counts.requested;
    $('count-ready').textContent = counts.ready;
    $('count-parked').textContent = counts.parked;
    $('handover').textContent = (state.settings && state.settings.handover_point) || '';

    document.querySelectorAll('[data-lane]').forEach((b) => {
      b.classList.toggle('active', b.dataset.lane === state.lane);
    });

    const lanes = EV2Valet.groupByLane(EV2Valet.search(state.tickets, state.query), now);
    const list = lanes[state.lane] || [];
    const empty = {
      requested: 'valet.emptyRequested', ready: 'valet.emptyReady', parked: 'valet.emptyParked',
    };
    $('lane-empty').textContent = t(empty[state.lane]);
    $('lane-empty').hidden = list.length > 0;

    $('lane-list').innerHTML = list.map((ticket) => {
      const minutes = EV2Valet.waitMinutes(ticket, now);
      const level = EV2Valet.urgency(minutes);
      const action = EV2Valet.nextAction(ticket.status);
      const busy = state.busy.has(ticket.id);
      const wait = minutes === null ? ''
        : (minutes < 1 ? t('bar.justNow') : t('bar.minutes', { n: minutes }));
      return `
      <article class="card wait-${level} rounded-xl p-4" data-ticket="${escape(ticket.id)}">
        <div class="flex justify-between items-start gap-3">
          <div class="min-w-0">
            <p class="font-display text-xl">${escape(ticket.plate || '—')}</p>
            <p class="text-sm text-white/60">${escape(ticket.vehicle_desc || '')}</p>
            ${ticket.spot_code ? `<p class="text-xs text-white/40">${escape(t('valet.spot'))} ${escape(ticket.spot_code)}</p>` : ''}
          </div>
          <p class="text-xs flex-none ${level === 'late' ? 'text-red-300' : level === 'warn' ? 'text-amber-300' : 'text-white/50'}">${escape(wait)}</p>
        </div>
        <div class="flex gap-2 mt-3">
          ${action ? `<button class="ev2-button flex-1 rounded-lg py-3" data-do="${escape(action.action)}" ${busy ? 'disabled' : ''}>${escape(t(action.key))}</button>` : ''}
          ${EV2Valet.canCancel(ticket.status) ? `<button class="card rounded-lg px-4 text-sm text-red-300" data-do="cancel" ${busy ? 'disabled' : ''}>${escape(t('bar.cancel'))}</button>` : ''}
        </div>
      </article>`;
    }).join('');

    $('lane-list').querySelectorAll('[data-ticket]').forEach((el) => {
      el.querySelectorAll('[data-do]').forEach((b) => {
        b.onclick = () => act(el.dataset.ticket, b.dataset.do);
      });
    });

    renderSpots();
    renderSecret();
  }

  function renderSpots() {
    const select = $('t-spot');
    const free = state.spots.filter((s) => !s.occupied && s.active !== false);
    const signature = `${free.length}:${lang()}`;
    if (select.dataset.filled === signature) return;
    select.innerHTML = [`<option value="">${escape(t('valet.spotAuto'))}</option>`]
      .concat(free.map((s) => `<option value="${escape(s.id)}">${escape(s.code)}${s.zone ? ` · ${escape(s.zone)}` : ''}</option>`))
      .join('');
    select.dataset.filled = signature;
  }

  function renderSecret() {
    $('secret-box').hidden = !state.secret;
    if (state.secret) {
      $('secret-plate').textContent = state.secret.plate;
      $('secret-value').textContent = state.secret.token;
    }
  }
  $('btn-secret-ok').onclick = () => { state.secret = null; renderSecret(); };

  document.querySelectorAll('[data-lane]').forEach((b) => {
    b.onclick = () => { state.lane = b.dataset.lane; renderAll(); };
  });
  $('search').oninput = () => { state.query = $('search').value; renderAll(); };

  // ---------------------------------------------------------------- recibir un auto

  $('btn-new-ticket').onclick = () => { $('ticket-form').hidden = !$('ticket-form').hidden; };
  $('btn-ticket-cancel').onclick = () => { $('ticket-form').hidden = true; };

  $('ticket-form').onsubmit = async (ev) => {
    ev.preventDefault();
    const problem = EV2Valet.validatePlate($('t-plate').value);
    const errorLine = document.querySelector('[data-error="plate"]');
    if (problem) {
      errorLine.textContent = t(problem);
      errorLine.hidden = false;
      $('t-plate').classList.add('bad');
      return;
    }
    errorLine.hidden = true;
    $('t-plate').classList.remove('bad');

    const body = { plate: $('t-plate').value.trim(), client_request_id: EV2.uuid() };
    const desc = $('t-desc').value.trim();
    if (desc) body.vehicle_desc = desc;
    const phone = $('t-phone').value.trim();
    if (phone) body.phone = phone;
    const spot = $('t-spot').value;
    if (spot) body.spot_id = spot;

    try {
      const data = await api.post(`/nightclubs/${clubId()}/valet/tickets`, body);
      // El código del cliente viaja UNA sola vez: se guarda antes de repintar nada. Sin
      // él, el cliente no puede recoger su auto sin pasar por el gerente.
      if (data.qr_token) {
        state.secret = { plate: body.plate, token: data.qr_token };
      }
      $('ticket-form').reset();
      $('t-spot').dataset.filled = '';
      $('ticket-form').hidden = true;
      await loadAll();
      toast(t('valet.ticketCreated', { code: body.plate }), 'ok');
    } catch (err) { showError(err); }
  };

  // ---------------------------------------------------------------- acciones

  async function act(ticketId, action) {
    if (action === 'deliver') { openDeliver(ticketId); return; }
    if (action === 'cancel') {
      const reason = window.prompt(t('valet.cancelReason'));
      if (!reason || reason.trim().length < 3) return;
      await call(ticketId, 'cancel', { reason: reason.trim() });
      return;
    }
    await call(ticketId, action, {});
  }

  async function call(ticketId, action, body) {
    if (state.busy.has(ticketId)) return;
    state.busy.add(ticketId);
    renderAll();
    try {
      await api.post(`/nightclubs/${clubId()}/valet/tickets/${ticketId}/${action}`, body);
      await loadTickets();
    } catch (err) {
      showError(err);
      await loadTickets();
    } finally {
      state.busy.delete(ticketId);
      renderAll();
    }
  }

  function openDeliver(ticketId) {
    const ticket = state.tickets.find((x) => x.id === ticketId);
    state.delivering = ticketId;
    $('qr-plate').textContent = ticket ? (EV2Valet.vehicleLabel(ticket) || '') : '';
    $('qr-token').value = '';
    $('qr-error').hidden = true;
    $('qr-box').hidden = false;
    $('qr-token').focus();
  }

  $('btn-qr-cancel').onclick = () => { $('qr-box').hidden = true; state.delivering = null; };

  $('btn-qr-confirm').onclick = async () => {
    const token = $('qr-token').value.trim();
    const problem = EV2Valet.validateToken(token);
    if (problem) { $('qr-error').textContent = t(problem); $('qr-error').hidden = false; return; }
    const ticketId = state.delivering;
    if (!ticketId) return;
    try {
      await api.post(`/nightclubs/${clubId()}/valet/tickets/${ticketId}/deliver`, {
        qr_token: token,
        payment_method: $('qr-payment').value,
      });
      $('qr-box').hidden = true;
      state.delivering = null;
      await loadTickets();
      toast(t('valet.deliver'), 'ok');
    } catch (err) {
      // Un código que no cuadra es justo lo que esta pantalla existe para atrapar: se
      // dice ahí mismo, sin cerrar el cuadro.
      showError(err, $('qr-error'));
    }
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
      const change = EV2Valet.applyEvent(message);
      if (!change.changed) return;
      if (change.announce) {
        // Un cliente esperando su coche en la puerta es la única cola que se ve desde
        // la calle: por eso este es el único evento que vibra.
        try { if (navigator.vibrate) navigator.vibrate([200, 80, 200]); } catch { /* bloqueado */ }
        toast(t('valet.carRequested'), 'ok');
        state.lane = 'requested';
      }
      await loadTickets();
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
