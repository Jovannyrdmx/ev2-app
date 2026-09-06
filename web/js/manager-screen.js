/**
 * EV2 — panel del gerente (paso 5.5).
 *
 * Conecta el DOM con `EV2` (API y socket), `EV2Manager` (los números y las validaciones)
 * y `EV2Roles`. Cubre lo que el dueño dejó para configurar después: conductores, zonas y
 * tarifas del taxi, y los cajones del estacionamiento — más el resumen del turno.
 */
/* global EV2, EV2Format, EV2Manager, EV2Roles, EV2PasswordGate, EV2StaffAdmin, EV2Payouts */
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
    nights: [], staff: [], withdrawals: [], accounts: [],
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
      // Sin filtro de estado: el gerente TIENE que ver sus borradores, que son
      // justamente las noches que todavía nadie puede reservar.
      get(`/nightclubs/${club}/events?limit=60`, (d) => { state.nights = d.events || []; }),
      get(`/nightclubs/${club}/employees?include_inactive=true&limit=200`,
        (d) => { state.staff = d.employees || []; }),
      get(`/nightclubs/${club}/withdrawals?limit=100`, (d) => { state.withdrawals = d.withdrawals || []; }),
    ]);
    // Las cuentas por verificar se piden por empleado: no hay un listado del club, y
    // sin verificar una cuenta esa persona no puede cobrar nunca.
    await loadAccounts();
    renderAll();
  }

  /**
   * Las cuentas bancarias de quienes todavía no tienen ninguna verificada.
   *
   * Se pregunta empleado por empleado a propósito: la API no expone un listado del club
   * entero, y con razón — son datos bancarios y cada consulta queda ligada a la persona
   * a la que pertenecen.
   */
  async function loadAccounts() {
    const club = clubId();
    const activos = (state.staff || []).filter((p) => p.active !== false);
    const results = await Promise.all(activos.map(async (person) => {
      try {
        const d = await api.get(`/nightclubs/${club}/employees/${person.id}/bank-accounts`);
        return (d.bank_accounts || []).map((a) => ({ ...a, employee: person }));
      } catch {
        // Un empleado sin cuentas contesta vacío; cualquier otro fallo no debe tumbar
        // la pestaña entera de pagos.
        return [];
      }
    }));
    state.accounts = results.flat();
  }

  // ---------------------------------------------------------------- pintar

  const TABS = ['summary', 'nights', 'staff', 'payouts', 'drivers', 'taxi', 'parking'];

  function renderAll() {
    for (const tab of TABS) $(`tab-${tab}`).hidden = tab !== state.tab;
    document.querySelectorAll('[data-tab]').forEach((b) => {
      b.classList.toggle('active', b.dataset.tab === state.tab);
    });
    renderSummary();
    renderNights();
    renderStaff();
    renderPayouts();
    renderDrivers();
    renderTaxi();
    renderParking();
    renderSecret();
  }

  // ---------------------------------------------------------------- personal

  function renderStaff() {
    const counts = EV2StaffAdmin.counts(state.staff);
    $('st-onshift').textContent = String(counts.onShift);
    $('st-active').textContent = String(counts.active);
    $('st-inactive').textContent = String(counts.inactive);

    const list = EV2StaffAdmin.sortStaff(state.staff);
    $('staff-empty').hidden = list.length > 0;
    const box = $('staff-list');
    box.innerHTML = '';

    for (const person of list) {
      const actions = EV2StaffAdmin.actionsFor(person);
      const names = EV2StaffAdmin.displayFor(person);
      const card = document.createElement('div');
      card.className = 'card rounded-xl p-3 space-y-2';
      if (person.active === false) card.style.opacity = '.55';

      const head = document.createElement('div');
      head.className = 'flex justify-between items-start gap-3';
      const left = document.createElement('div');
      left.className = 'min-w-0';
      const name = document.createElement('p');
      name.className = 'font-display truncate';
      name.textContent = names.primary;
      left.appendChild(name);
      const sub = document.createElement('p');
      sub.className = 'text-[11px] text-white/40 truncate';
      // El nombre legal se enseña junto al artístico: la nómina lo necesita.
      sub.textContent = [names.secondary, EV2Roles.describe(person.role, lang()).label, person.email]
        .filter(Boolean).join(' · ');
      left.appendChild(sub);

      const status = document.createElement('span');
      status.className = 'text-xs shrink-0';
      status.style.color = person.on_shift ? 'var(--ev2-lime)'
        : person.active === false ? 'rgba(255,255,255,.4)' : 'rgba(255,255,255,.6)';
      status.textContent = t(EV2StaffAdmin.statusOf(person));
      head.append(left, status);
      card.appendChild(head);

      const row = document.createElement('div');
      row.className = 'flex gap-2 flex-wrap';
      const add = (label, cls, fn) => {
        const b = document.createElement('button');
        b.className = cls;
        b.textContent = t(label);
        b.onclick = () => fn(b);
        row.appendChild(b);
      };
      if (actions.canResetPassword) {
        add('staff.resetPassword', 'card rounded-lg px-3 py-2 text-sm flex-1', (b) => {
          if (!window.confirm(t('staff.confirmReset'))) return;
          patchEmployee(person, { reset_password: true }, 'staff.tempPassword', b);
        });
      }
      if (actions.canDeactivate) {
        add('staff.deactivate', 'card rounded-lg px-3 py-2 text-sm text-red-300', (b) => {
          if (!window.confirm(t('staff.confirmDeactivate'))) return;
          patchEmployee(person, { active: false }, 'staff.deactivated', b);
        });
      }
      if (actions.canReactivate) {
        add('staff.reactivate', 'ev2-button rounded-lg px-3 py-2 text-sm flex-1',
          (b) => patchEmployee(person, { active: true }, 'staff.reactivated', b));
      }
      if (row.children.length) card.appendChild(row);
      box.appendChild(card);
    }
  }

  async function patchEmployee(person, body, message, button) {
    button.disabled = true;
    try {
      const data = await api.patch(`/nightclubs/${clubId()}/employees/${person.id}`, body);
      // La contraseña temporal viaja UNA vez, en esta respuesta. Si la pantalla la
      // pierde, no hay forma de recuperarla y hay que volver a reiniciarla.
      if (data.temporary_password) {
        secret.hold(EV2StaffAdmin.displayFor(person).primary, data.temporary_password);
      } else {
        toast(t(message), 'ok');
      }
      await loadAll();
    } catch (err) {
      showError(err);
      button.disabled = false;
    }
  }

  $('btn-new-staff').onclick = () => {
    const form = $('staff-form');
    form.hidden = !form.hidden;
    clearStaffErrors();
    if (!form.hidden) fillRoleOptions();
  };
  $('btn-staff-cancel').onclick = () => { $('staff-form').hidden = true; clearStaffErrors(); };

  function fillRoleOptions() {
    const select = $('s-role');
    if (select.options.length) return;
    for (const role of EV2StaffAdmin.EMPLOYEE_ROLES) {
      const opt = document.createElement('option');
      opt.value = role;
      opt.textContent = EV2Roles.describe(role, lang()).label;
      select.appendChild(opt);
    }
  }

  const STAFF_FIELDS = {
    first_name: 's-first', last_name: 's-last', email: 's-email',
    phone: 's-phone', role: 's-role', birth_date: 's-birth',
  };

  function clearStaffErrors() {
    for (const [field, id] of Object.entries(STAFF_FIELDS)) {
      const p = document.querySelector(`#staff-form [data-error="${field}"]`);
      if (p) { p.hidden = true; p.textContent = ''; }
      const input = $(id);
      if (input) input.classList.remove('bad');
    }
  }

  function showStaffErrors(errors) {
    clearStaffErrors();
    for (const [field, key] of Object.entries(errors)) {
      const p = document.querySelector(`#staff-form [data-error="${field}"]`);
      if (p) { p.textContent = t(key); p.hidden = false; }
      const input = $(STAFF_FIELDS[field]);
      if (input) input.classList.add('bad');
    }
  }

  $('staff-form').onsubmit = async (ev) => {
    ev.preventDefault();
    const form = {
      first_name: $('s-first').value,
      last_name: $('s-last').value,
      stage_name: $('s-stage').value,
      email: $('s-email').value,
      phone: $('s-phone').value,
      role: $('s-role').value,
      birth_date: $('s-birth').value,
    };
    // La edad se comprueba aquí y en el servidor. No es redundancia: dar de alta a un
    // menor como personal de un centro nocturno es el peor error de esta pantalla.
    const errors = EV2StaffAdmin.validateEmployee(form, new Date());
    if (Object.keys(errors).length) { showStaffErrors(errors); return; }
    clearStaffErrors();

    try {
      const data = await api.post(`/nightclubs/${clubId()}/employees`,
        EV2StaffAdmin.employeePayload(form));
      $('staff-form').reset();
      $('staff-form').hidden = true;
      secret.hold(EV2StaffAdmin.displayFor(data.employee || form).primary, data.temporary_password);
      await loadAll();
    } catch (err) { showError(err); }
  };

  // ---------------------------------------------------------------- pagos

  function renderPayouts() {
    const box = EV2Payouts.inbox(state.withdrawals, new Date());
    $('p-owed').textContent = box.owed.length
      ? box.owed.map((o) => money(o.amount, o.currency)).join(' · ')
      : money('0.00', state.currency);
    $('p-inbox').textContent = `${t('pay.pending', { count: box.pending })} · ${t('pay.approved', { count: box.approved })}`;
    const oldest = $('p-oldest');
    oldest.hidden = box.oldestDays < 1;
    oldest.textContent = t('pay.oldest', { days: box.oldestDays });

    renderAccounts();
    renderWithdrawals();
  }

  function renderAccounts() {
    // Solo lo que espera decisión: una cuenta ya verificada no necesita mirarse otra vez.
    const pendientes = EV2Payouts.sortAccounts(state.accounts).filter((a) => !EV2Payouts.isVerified(a));
    $('acc-empty').hidden = pendientes.length > 0;
    const box = $('acc-list');
    box.innerHTML = '';

    for (const account of pendientes) {
      const label = EV2Payouts.accountLabel(account);
      const card = document.createElement('div');
      card.className = 'card rounded-xl p-3 space-y-2';

      const who = document.createElement('p');
      who.className = 'font-display truncate';
      who.textContent = (account.employee && account.employee.display_name) || '';
      const detail = document.createElement('p');
      detail.className = 'text-sm text-white/70';
      detail.textContent = `${label.bank} · ${label.masked}`;
      const holder = document.createElement('p');
      holder.className = 'text-[11px] text-white/40';
      holder.textContent = label.holder;
      card.append(who, detail, holder);

      const note = document.createElement('p');
      note.className = 'text-[11px]';
      note.style.color = 'var(--ev2-gold)';
      note.textContent = t(EV2Payouts.verifyWarning());
      card.appendChild(note);

      const verify = document.createElement('button');
      verify.className = 'ev2-button w-full rounded-lg py-2 text-sm';
      verify.textContent = t('pay.verify');
      verify.onclick = async () => {
        if (!window.confirm(t('pay.confirmVerify'))) return;
        verify.disabled = true;
        try {
          await api.post(
            `/nightclubs/${clubId()}/employees/${account.employee.id}/bank-accounts/${account.id}/verify`,
            { verified: true });
          toast(t('pay.verified1'), 'ok');
          await loadAll();
        } catch (err) { showError(err); verify.disabled = false; }
      };
      card.appendChild(verify);
      box.appendChild(card);
    }
  }

  function renderWithdrawals() {
    const list = EV2Payouts.sortWithdrawals(state.withdrawals);
    $('pay-empty').hidden = list.length > 0;
    const box = $('pay-list');
    box.innerHTML = '';

    for (const w of list) {
      const actions = EV2Payouts.actionsFor(w);
      const card = document.createElement('div');
      card.className = 'card rounded-xl p-3 space-y-2';
      if (actions.isClosed) card.style.opacity = '.6';

      const head = document.createElement('div');
      head.className = 'flex justify-between items-start gap-3';
      const left = document.createElement('div');
      left.className = 'min-w-0';
      const who = document.createElement('p');
      who.className = 'font-display truncate';
      who.textContent = w.employee_name || '';
      const detail = document.createElement('p');
      detail.className = 'text-[11px] text-white/40 truncate';
      detail.textContent = [w.bank_name, EV2Format.dateTime(w.created_at)].filter(Boolean).join(' · ');
      left.append(who, detail);

      const amount = document.createElement('span');
      amount.className = 'font-display shrink-0';
      amount.textContent = money(w.amount_paid || w.amount, w.payout_currency || w.currency);
      head.append(left, amount);
      card.appendChild(head);

      const status = document.createElement('p');
      status.className = 'text-xs text-white/50';
      status.textContent = t(EV2Payouts.statusLabel(w.status));
      card.appendChild(status);

      const row = document.createElement('div');
      row.className = 'flex gap-2 flex-wrap';
      if (actions.canApprove) {
        const b = document.createElement('button');
        b.className = 'ev2-button rounded-lg px-3 py-2 text-sm flex-1';
        b.textContent = t('pay.approve');
        b.onclick = () => withdrawalAction(w, 'approve', {}, 'pay.approved1', b);
        row.appendChild(b);
      }
      if (actions.canReject) {
        const b = document.createElement('button');
        b.className = 'card rounded-lg px-3 py-2 text-sm text-red-300';
        b.textContent = t('pay.reject');
        b.onclick = () => {
          const reason = window.prompt(t('pay.reason'));
          if (reason === null) return;
          const problem = EV2Payouts.validateRejection(reason);
          if (problem) { toast(t(problem), 'error'); return; }
          withdrawalAction(w, 'reject', { reason: reason.trim() }, 'pay.rejected1', b);
        };
        row.appendChild(b);
      }
      if (actions.canPay) {
        const b = document.createElement('button');
        b.className = 'ev2-button rounded-lg px-3 py-2 text-sm flex-1';
        b.textContent = t('pay.markPaid');
        b.onclick = () => {
          const reference = window.prompt(t('pay.reference')) || '';
          // Sin referencia no se puede conciliar tres semanas después, cuando el
          // empleado dice que nunca le llegó. Se advierte, no se impone.
          const warn = EV2Payouts.payWarning(w, reference);
          if (warn && !window.confirm(t(warn))) return;
          withdrawalAction(w, 'paid', { reference: reference.trim() || undefined }, 'pay.paid1', b);
        };
        row.appendChild(b);
      }
      if (row.children.length) card.appendChild(row);
      box.appendChild(card);
    }
  }

  async function withdrawalAction(withdrawal, action, body, message, button) {
    button.disabled = true;
    try {
      await api.post(`/nightclubs/${clubId()}/withdrawals/${withdrawal.id}/${action}`, body);
      toast(t(message), 'ok');
      await loadAll();
    } catch (err) {
      showError(err);
      button.disabled = false;
    }
  }

  // ---------------------------------------------------------------- noches

  function renderNights() {
    const list = EV2Manager.sortNights(state.nights, new Date());
    $('nights-empty').hidden = list.length > 0;
    const box = $('nights-list');
    box.innerHTML = '';

    for (const night of list) {
      const actions = EV2Manager.nightActions(night);
      const card = document.createElement('div');
      card.className = 'card rounded-xl p-3 space-y-2';

      const head = document.createElement('div');
      head.className = 'flex justify-between items-start gap-3';
      const left = document.createElement('div');
      left.className = 'min-w-0';
      const name = document.createElement('p');
      name.className = 'font-display truncate';
      name.textContent = night.name || '';
      const when = document.createElement('p');
      when.className = 'text-[11px] text-white/40';
      when.textContent = `${EV2Format.dateTime(night.doors_open_at)} · ${money(night.ticket_price, night.currency)}`;
      left.append(name, when);

      const status = document.createElement('span');
      status.className = 'text-xs shrink-0';
      // La noche publicada se marca en verde: es la única que de verdad está abierta,
      // y de un vistazo el gerente tiene que ver si ya abrió la del sábado.
      status.style.color = night.status === 'published' ? 'var(--ev2-lime)'
        : night.status === 'cancelled' ? 'var(--ev2-red)' : 'rgba(255,255,255,.5)';
      status.textContent = t(EV2Manager.nightStatusLabel(night.status));
      head.append(left, status);
      card.appendChild(head);

      const count = document.createElement('p');
      count.className = 'text-[11px] text-white/50';
      count.textContent = t('night.reservations', { count: actions.booked });
      card.appendChild(count);

      const row = document.createElement('div');
      row.className = 'flex gap-2 flex-wrap';
      const add = (label, className, fn) => {
        const b = document.createElement('button');
        b.className = className;
        b.textContent = t(label);
        b.onclick = () => fn(b);
        row.appendChild(b);
      };
      if (actions.canPublish) {
        add('night.publish', 'ev2-button rounded-lg px-3 py-2 text-sm flex-1',
          (b) => setNightStatus(night, 'published', 'night.published', b));
      }
      if (actions.canUnpublish) {
        add('night.unpublish', 'card rounded-lg px-3 py-2 text-sm flex-1',
          (b) => setNightStatus(night, 'draft', 'night.created', b));
      }
      if (actions.canCancel) {
        add('night.cancelNight', 'card rounded-lg px-3 py-2 text-sm text-red-300 flex-1', (b) => {
          if (!window.confirm(t('night.confirmCancel'))) return;
          setNightStatus(night, 'cancelled', 'night.cancelled', b);
        });
      }
      if (actions.canDelete) {
        add('night.delete', 'card rounded-lg px-3 py-2 text-sm text-red-300', (b) => deleteNight(night, b));
      }
      if (row.children.length) card.appendChild(row);
      box.appendChild(card);
    }
  }

  async function setNightStatus(night, status, message, button) {
    button.disabled = true;
    try {
      await api.patch(`/nightclubs/${clubId()}/events/${night.id}`, { status });
      toast(t(message), 'ok');
      await loadAll();
    } catch (err) {
      showError(err);
      button.disabled = false;
    }
  }

  async function deleteNight(night, button) {
    if (!window.confirm(t('night.confirmDelete'))) return;
    button.disabled = true;
    try {
      await api.del(`/nightclubs/${clubId()}/events/${night.id}`);
      toast(t('night.deleted'), 'ok');
      await loadAll();
    } catch (err) {
      // El servidor contesta 409 si la noche tiene reservaciones vivas: ese texto
      // explica mejor que cualquier genérico por qué hay que cancelarla en vez de
      // borrarla.
      showError(err);
      button.disabled = false;
    }
  }

  $('btn-new-night').onclick = () => {
    const form = $('night-form');
    form.hidden = !form.hidden;
    clearNightErrors();
  };
  $('btn-night-cancel').onclick = () => { $('night-form').hidden = true; clearNightErrors(); };

  const NIGHT_FIELDS = {
    name: 'n-name', event_date: 'n-date', doors_open_at: 'n-doors',
    closes_at: 'n-closes', ticket_price: 'n-price',
  };

  function clearNightErrors() {
    for (const [field, id] of Object.entries(NIGHT_FIELDS)) {
      const p = document.querySelector(`#night-form [data-error="${field}"]`);
      if (p) { p.hidden = true; p.textContent = ''; }
      const input = $(id);
      if (input) input.classList.remove('bad');
    }
  }

  function showNightErrors(errors) {
    clearNightErrors();
    for (const [field, key] of Object.entries(errors)) {
      const p = document.querySelector(`#night-form [data-error="${field}"]`);
      if (p) { p.textContent = t(key); p.hidden = false; }
      const input = $(NIGHT_FIELDS[field]);
      if (input) input.classList.add('bad');
    }
  }

  $('night-form').onsubmit = async (ev) => {
    ev.preventDefault();
    const form = {
      name: $('n-name').value,
      event_date: $('n-date').value,
      // `datetime-local` da una hora SIN zona: `new Date()` la lee en la del teléfono,
      // que es la del club. Es lo correcto aquí — el gerente captura la hora local a
      // la que abre la puerta— y `nightPayload` la manda en ISO con zona.
      doors_open_at: $('n-doors').value,
      closes_at: $('n-closes').value,
      ticket_price: $('n-price').value,
      arrival_deadline_minutes: $('n-deadline').value,
      currency: state.currency,
    };
    const errors = EV2Manager.validateNight(form, new Date());
    if (Object.keys(errors).length) { showNightErrors(errors); return; }
    clearNightErrors();

    try {
      await api.post(`/nightclubs/${clubId()}/events`, EV2Manager.nightPayload(form));
      $('night-form').reset();
      $('n-deadline').value = '180';
      $('n-price').value = '0';
      $('night-form').hidden = true;
      toast(t('night.created'), 'ok');
      await loadAll();
    } catch (err) { showError(err); }
  };

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
