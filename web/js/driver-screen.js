/**
 * EV2 — pantalla del conductor (paso 5.6).
 *
 * Conecta el DOM con `EV2` (API y socket), `EV2Taxi` (el viaje) y `EV2Roles`. Las
 * decisiones —qué botón toca, si se le muestran ofertas, qué hace un evento— viven en
 * `taxi-ride.js` y están probadas ahí.
 *
 * Esto se usa manejando. Cada pantalla ofrece UNA acción, y nada más.
 */
/* global EV2, EV2Format, EV2Taxi, EV2Roles, EV2PasswordGate */
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

  const state = {
    driver: null, ride: null, offers: [], tonight: [], realtime: null,
    busy: false, pendingAccept: null,
  };

  const t = (key, vars) => (vars ? EV2Format.tf(key, vars) : EV2Format.t(key));
  const lang = () => EV2Format.getLanguage();
  const money = (amount, currency) => EV2Format.money(amount, currency || 'MXN');
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

  $('btn-lang').onclick = () => {
    EV2Format.setLanguage(EV2Format.otherLanguage());
    applyLanguage();
  };

  function applyLanguage() {
    EV2Format.applyTo(document);
    $('btn-lang').textContent = EV2Format.otherLanguage().toUpperCase();
    renderAll();
    if (!$('screen-wrong-role').hidden) renderWrongRole();
    setConnection(lastConnection.on, lastConnection.key, lastConnection.vars);
  }

  const PASSWORD_GATE_HIDES = ['screen-auth', 'screen-wrong-role', 'screen-driver'];

  // ---------------------------------------------------------------- contraseña temporal

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
      // El servidor cierra las demás sesiones y devuelve tokens nuevos; el cliente ya los
      // aplica. Se vuelve a entrar limpio en vez de arrastrar el estado de la puerta.
      $('form-password').reset();
      $('screen-password').hidden = true;
      toast(t('gate.done'), 'ok');
      await afterSignIn();
    } catch (err) { showError(err, $('pw-error')); }
  };

  // ---------------------------------------------------------------- quién entró

  async function afterSignIn() {
    if (EV2PasswordGate.isRequired(api.session.user)) { showPasswordGate(); return; }
    const role = api.session.user && api.session.user.role;
    if (role !== 'driver') {
      const home = EV2Roles.describe(role, lang());
      if (home.ready && home.home && home.home !== 'driver.html') {
        location.href = home.home;
        return;
      }
      renderWrongRole();
      $('screen-auth').hidden = true;
      $('screen-driver').hidden = true;
      $('screen-wrong-role').hidden = false;
      return;
    }
    await enterDriver();
  }

  function renderWrongRole() {
    const role = api.session.user && api.session.user.role;
    const info = EV2Roles.describe(role, lang());
    $('wrong-role').textContent = info.label;
    $('wrong-role-note').textContent = info.step
      ? t('staff.pending', { step: info.step }) : t('staff.noScreen');
  }

  const clubId = () => api.session.user && api.session.user.nightclub_id;

  async function enterDriver() {
    $('screen-auth').hidden = true;
    $('screen-wrong-role').hidden = true;
    $('screen-driver').hidden = false;
    $('me-name').textContent = (api.session.user && api.session.user.display_name) || '';
    await load();
    connectRealtime();
  }

  /**
   * El registro del conductor puede estar sin verificar: en ese caso `/me/offers`
   * responde 403 a propósito. Se le dice, en vez de mostrarle una lista vacía que
   * parece un problema de señal.
   */
  async function load() {
    try {
      const me = await api.get(`/nightclubs/${clubId()}/taxi/me`);
      state.driver = me.driver;
      $('me-plate').textContent = (me.driver && me.driver.vehicle_plate) || '';
    } catch (err) { showError(err); return; }

    try {
      const mine = await api.get(`/nightclubs/${clubId()}/taxi/me/rides?limit=20`);
      state.ride = mine.live || null;
      state.tonight = mine.tonight || [];
    } catch (err) { showError(err); }

    await loadOffers();
    renderAll();
  }

  async function loadOffers() {
    // Con un viaje encima no se piden ofertas: no puede tomar dos.
    if (state.ride && EV2Taxi.isLive(state.ride.status)) { state.offers = []; return; }
    try {
      const data = await api.get(`/nightclubs/${clubId()}/taxi/me/offers`);
      state.offers = data.offers || [];
      banner(null);
    } catch (err) {
      state.offers = [];
      if (err.status === 403) banner(t('taxi.driverNotVerified'));
      else showError(err);
    }
  }

  // ---------------------------------------------------------------- pintar

  function renderAll() {
    renderAvailability();
    const view = EV2Taxi.driverView(state.ride, state.offers);
    $('ride-card').hidden = view.mode !== 'ride';
    $('offers-box').hidden = view.mode !== 'offers';
    if (view.mode === 'ride') renderRide(view.ride); else renderOffers(view.offers);
  }

  function renderAvailability() {
    const d = state.driver || {};
    const on = d.availability === 'available';
    $('btn-available').classList.toggle('on', on);
    $('btn-off').classList.toggle('on', !on);
    $('chk-at-venue').checked = Boolean(d.at_venue);
    $('chk-at-venue').disabled = !on;

    const total = EV2Taxi.tonightTotal(state.tonight, d.currency || 'MXN');
    $('tonight-rides').textContent = total.rides;
    $('tonight-amount').textContent = money(total.charged, total.currency);
  }

  function renderRide(ride) {
    const action = EV2Taxi.driverAction(ride.status);
    $('ride-guest').textContent = (ride.guest && ride.guest.name) || '—';
    $('ride-destination').textContent = ride.destination || ride.destination_zone || '';
    $('ride-notes').hidden = !ride.notes;
    if (ride.notes) $('ride-notes').textContent = `${t('bar.note')}: ${ride.notes}`;
    $('ride-passengers').textContent = `${t('taxi.driverPassengers')}: ${ride.passengers}`;
    const amount = EV2Taxi.fareAmount(ride);
    $('ride-fare').textContent = amount === null ? t('taxi.fareOpen') : money(amount, ride.currency);

    const head = EV2Taxi.guestHeadline(ride, null);
    $('ride-status').textContent = t(head.key, head.vars);

    const button = $('btn-ride-action');
    button.hidden = !action;
    button.disabled = state.busy;
    if (action) button.textContent = t(action.key);
    $('btn-ride-cancel').hidden = !EV2Taxi.canCancel(ride.status);
  }

  function renderOffers(offers) {
    $('offers-empty').hidden = offers.length > 0;
    $('offers-list').innerHTML = offers.map((o) => {
      const amount = EV2Taxi.fareAmount(o);
      return `
      <article class="card rounded-xl p-4" data-offer="${escape(o.id)}">
        <div class="flex justify-between items-start gap-3">
          <div class="min-w-0">
            <p class="font-display text-lg">${escape(o.destination || o.destination_zone || t('taxi.zoneAny'))}</p>
            <p class="text-sm text-white/60">${escape(t('taxi.driverPassengers'))}: ${o.passengers}</p>
            ${o.notes ? `<p class="text-xs text-amber-200/80 mt-1">${escape(o.notes)}</p>` : ''}
          </div>
          <p class="text-sm flex-none">${amount === null ? escape(t('taxi.fareOpen')) : escape(money(amount, o.currency))}</p>
        </div>
        <div class="grid grid-cols-3 gap-2 mt-3">
          <button class="ev2-button col-span-2 rounded-lg" data-accept="${escape(o.id)}">${escape(t('taxi.driverAccept'))}</button>
          <button class="card rounded-lg text-sm text-white/60" data-decline="${escape(o.id)}">${escape(t('taxi.driverDecline'))}</button>
        </div>
      </article>`;
    }).join('');

    $('offers-list').querySelectorAll('[data-accept]').forEach((b) => {
      b.onclick = () => openEta(b.dataset.accept);
    });
    $('offers-list').querySelectorAll('[data-decline]').forEach((b) => {
      b.onclick = () => decline(b.dataset.decline);
    });
  }

  // ---------------------------------------------------------------- disponibilidad

  async function setAvailability(availability, atVenue) {
    try {
      const data = await api.put(`/nightclubs/${clubId()}/taxi/me/availability`, {
        availability, at_venue: Boolean(atVenue),
      });
      state.driver = Object.assign({}, state.driver, data.availability);
      await loadOffers();
      renderAll();
    } catch (err) { showError(err); }
  }

  $('btn-available').onclick = () => setAvailability('available', $('chk-at-venue').checked);
  $('btn-off').onclick = () => setAvailability('off', false);
  $('chk-at-venue').onchange = () => {
    if (state.driver && state.driver.availability === 'available') {
      setAvailability('available', $('chk-at-venue').checked);
    }
  };

  // ---------------------------------------------------------------- aceptar

  function openEta(rideId) {
    state.pendingAccept = rideId;
    $('eta-choices').innerHTML = EV2Taxi.ETA_CHOICES.map((n) => `
      <button class="eta-choice py-3" data-eta="${n}">${n === 0 ? escape(t('taxi.arrivingNow').split('.')[0]) : n}</button>`).join('');
    $('eta-choices').querySelectorAll('[data-eta]').forEach((b) => {
      b.onclick = () => accept(state.pendingAccept, Number(b.dataset.eta));
    });
    $('eta-box').hidden = false;
  }

  $('btn-eta-cancel').onclick = () => { $('eta-box').hidden = true; state.pendingAccept = null; };

  async function accept(rideId, etaMinutes) {
    $('eta-box').hidden = true;
    state.pendingAccept = null;
    try {
      const { ride } = await api.post(
        `/nightclubs/${clubId()}/taxi/rides/${rideId}/accept`, { eta_minutes: etaMinutes });
      state.ride = ride;
      state.offers = [];
      renderAll();
      toast(t('taxi.driverAccept'), 'ok');
    } catch (err) {
      // Un 409 aquí es casi siempre "otro conductor se adelantó": la lista honesta es
      // la que trae el servidor, no la que quedó en pantalla.
      showError(err);
      await load();
    }
  }

  async function decline(rideId) {
    try {
      await api.post(`/nightclubs/${clubId()}/taxi/rides/${rideId}/decline`, {});
      state.offers = state.offers.filter((o) => o.id !== rideId);
      renderAll();
    } catch (err) { showError(err); }
  }

  // ---------------------------------------------------------------- avanzar el viaje

  $('btn-ride-action').onclick = async () => {
    const ride = state.ride;
    if (!ride || state.busy) return;
    const action = EV2Taxi.driverAction(ride.status);
    if (!action) return;

    // Terminar pide el cobro: es lo único que el conductor teclea, y va al libro mayor.
    if (action.needsAmount) {
      const suggested = EV2Taxi.fareAmount(ride);
      $('finish-amount').value = suggested === null ? '' : suggested;
      $('finish-box').hidden = false;
      $('ride-card').hidden = true;
      return;
    }

    state.busy = true;
    renderAll();
    try {
      const { ride: updated } = await api.post(
        `/nightclubs/${clubId()}/taxi/rides/${ride.id}/${action.action}`, {});
      state.ride = updated;
    } catch (err) {
      showError(err);
      await load();
    } finally {
      state.busy = false;
      renderAll();
    }
  };

  $('btn-finish-cancel').onclick = () => {
    $('finish-box').hidden = true;
    $('ride-card').hidden = false;
  };

  $('btn-finish-confirm').onclick = async () => {
    const ride = state.ride;
    if (!ride) return;
    const amount = Number($('finish-amount').value);
    if (!Number.isFinite(amount) || amount < 0) {
      toast(t('taxi.driverAmount'), 'error');
      return;
    }
    const button = $('btn-finish-confirm');
    button.disabled = true;
    try {
      await api.post(`/nightclubs/${clubId()}/taxi/rides/${ride.id}/finish`, {
        final_amount: amount,
        payment_method: $('finish-payment').value,
      });
      $('finish-box').hidden = true;
      $('ride-card').hidden = false;
      state.ride = null;
      await load();
      toast(t('taxi.done'), 'ok');
    } catch (err) {
      showError(err);
    } finally {
      button.disabled = false;
    }
  };

  $('btn-ride-cancel').onclick = async () => {
    const ride = state.ride;
    if (!ride || !window.confirm(t('taxi.confirmCancel'))) return;
    try {
      await api.post(`/nightclubs/${clubId()}/taxi/rides/${ride.id}/cancel`, {});
      state.ride = null;
      await load();
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

    rt.on('open', () => { setConnection(true, 'top.live'); });
    rt.on('reconnecting', (i) => setConnection(null, 'realtime.reconnecting',
      { text: `${t('realtime.reconnecting')} ${Math.round(i.in_ms / 1000)}s` }));
    rt.on('close', () => setConnection(false, 'top.offline'));
    rt.on('replaced', () => {
      setConnection(false, 'top.otherSession');
      banner(t('banner.replaced'));
    });
    rt.on('resync_required', async () => { banner(t('banner.updating')); await load(); banner(null); });

    rt.on('event', async (message) => {
      const change = EV2Taxi.applyEvent(state.ride, message);
      if (!change.changed) return;
      if (change.refreshOffers) {
        const before = state.offers.length;
        await loadOffers();
        renderAll();
        // Solo vibra cuando de verdad entró una solicitud nueva: el socket reproduce
        // eventos al reconectar y avisar dos veces distrae a alguien que va manejando.
        if (state.offers.length > before) {
          try { if (navigator.vibrate) navigator.vibrate([200, 80, 200]); } catch { /* bloqueado */ }
          toast(t('taxi.driverOffers'), 'ok');
        }
        return;
      }
      await load();
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
