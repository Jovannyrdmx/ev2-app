/**
 * EV2 — panel del gerente (paso 5.5).
 *
 * Conecta el DOM con `EV2` (API y socket), `EV2Manager` (los números y las validaciones)
 * y `EV2Roles`. Cubre lo que el dueño dejó para configurar después: conductores, zonas y
 * tarifas del taxi, y los cajones del estacionamiento — más el resumen del turno.
 */
/* global EV2, EV2Format, EV2Manager, EV2Warehouse, EV2Roles, EV2PasswordGate, EV2StaffAdmin,
   EV2Payouts, EV2NightReport, EV2Roster */
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
    reports: [], reportFilter: null,
    nights: [], staff: [], withdrawals: [], accounts: [],
    // Lo que espera a que el gerente cuente dinero (D51).
    cashDrops: [], shiftCuts: [],
    // El catálogo de covers del club. Vacío significa que la puerta todavía teclea el
    // precio; en cuanto tiene uno, el servidor deja de aceptar importes sueltos.
    covers: [],
    // Inventario: lo que el gerente mira, no lo que el almacen opera.
    supplies: [], locations: [], recipes: [], movements: [],
    // Hasta que el inventario llegue de la API, la pestana NO pinta ceros: un
    // "MX$0.00" mientras carga no es "cargando", es un dato falso, y el gerente que
    // lo alcanza a leer se lleva la idea de que la bodega esta vacia.
    invLoaded: false,
    invView: 'stock', invSearch: '',
    recipe: null,   // { drink_id, name, price, lines: [{supply_id, quantity}] }
    // El corte de la noche y el rol. `closings` son los cortes GUARDADOS, los
    // unicos que se pueden comparar entre si.
    closings: [],
    cut: null,      // { night, stats, closed }
    roster: null,   // { night, roster, gaps, sections, bars }
    pick: null,     // { section } o { locationId, name }
    realtime: null, busy: false,
  };
  const secret = EV2Manager.createSecretBox();

  // Las terminales del club y lo que Mercado Pago dice que hay en la cuenta (D47).
  // `warnings`: por qué una terminal quedó dada de alta sin poder cobrar, por id. Vive en
  // memoria a propósito: la verdad del modo está en el servidor, esto es solo la razón.
  const terminals = { mine: [], found: [], provider: null, warnings: {}, charges: [] };

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
    // El PIN se cambia donde está el teclado, no aquí (D46): mientras no lo cambie, el
    // servidor le bloquea todas las rutas y esta pantalla solo sabría dar errores.
    if (EV2PasswordGate.mustChangePin(api.session.user)) {
      location.href = EV2PasswordGate.PIN_PAGE;
      return;
    }
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
      loadTerminals(),
      loadTerminalCharges(),
      loadShiftCuts(),
      loadCovers(),
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
      loadReports(),
      // Inventario. Va en el mismo lote: son tres consultas y el gerente abre la
      // pestana sin esperar, que es la diferencia entre revisar margenes y no hacerlo.
      get(`/nightclubs/${club}/supply-locations`, (d) => { state.locations = d.locations || []; }),
      get(`/nightclubs/${club}/supplies`, (d) => { state.supplies = d.supplies || []; }),
      get(`/nightclubs/${club}/recipes`, (d) => { state.recipes = d.recipes || []; }),
      get(`/nightclubs/${club}/supply-movements?limit=60`, (d) => { state.movements = d.movements || []; }),
      // Los cortes guardados. Van en el mismo lote porque el comparador vive en la
      // pestana de noches y tiene que estar listo cuando el gerente la abre.
      get(`/nightclubs/${club}/nights/closings?limit=30`, (d) => { state.closings = d.closings || []; }),
    ]);
    state.invLoaded = true;
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

  const TABS = ['summary', 'nights', 'staff', 'payouts', 'reports', 'drivers', 'taxi', 'parking', 'inventory'];

  function renderAll() {
    for (const tab of TABS) $(`tab-${tab}`).hidden = tab !== state.tab;
    document.querySelectorAll('[data-tab]').forEach((b) => {
      b.classList.toggle('active', b.dataset.tab === state.tab);
    });
    renderSummary();
    renderNights();
    renderStaff();
    renderPayouts();
    renderReports();
    renderCoverQuick();
    renderDrivers();
    renderTaxi();
    renderParking();
    renderInventory();
    renderSecret();
  }


  // ---------------------------------------------------------------- los covers del club

  /**
   * El catálogo de covers.
   *
   * Antes eran tres precios escritos dentro de este archivo y de `staff-screen.js`, y el
   * servidor asentaba en el libro el importe que la puerta tecleara sin compararlo con
   * nada: quien cobraba ponía el precio y el corte cuadraba contra su propio número.
   * Ahora los pone el gerente aquí y el servidor los verifica en cada entrada.
   */
  async function loadCovers() {
    try {
      const data = await api.get(`/nightclubs/${clubId()}/cover-prices`);
      state.covers = data.cover_prices || [];
    } catch {
      state.covers = [];
    }
    renderCovers();
  }

  function renderCovers() {
    $('cover-empty').hidden = state.covers.length > 0;
    const box = $('cover-list');
    box.innerHTML = '';
    for (const cover of state.covers) {
      const card = document.createElement('div');
      card.className = 'flex items-center justify-between gap-3 card rounded-lg px-3 py-2';
      if (!cover.active) card.style.opacity = '.55';

      const left = document.createElement('div');
      left.className = 'min-w-0';
      const name = document.createElement('p');
      name.className = 'font-display truncate';
      name.textContent = cover.name;
      const amount = document.createElement('p');
      amount.className = 'text-[11px] text-white/50';
      amount.textContent = EV2Format.money(cover.amount, cover.currency);
      left.append(name, amount);

      const acciones = document.createElement('div');
      acciones.className = 'flex gap-2 shrink-0';
      const cambiar = document.createElement('button');
      cambiar.className = 'card rounded-lg px-3 py-2 text-xs';
      cambiar.textContent = t('cover.change');
      cambiar.onclick = () => {
        // Cambiar el precio NO toca lo ya vendido: cada entrada guarda el suyo.
        const dicho = window.prompt(t('cover.newAmount', { name: cover.name }), cover.amount);
        if (dicho === null) return;
        const monto = Number(dicho);
        if (!(monto >= 0)) { showError(new Error(t('cover.errAmount')), $('cover-error')); return; }
        patchCover(cover.id, { amount: monto }, cambiar);
      };
      const baja = document.createElement('button');
      baja.className = `card rounded-lg px-3 py-2 text-xs ${cover.active ? 'text-red-300' : ''}`;
      baja.textContent = t(cover.active ? 'cover.deactivate' : 'cover.reactivate');
      baja.onclick = () => patchCover(cover.id, { active: !cover.active }, baja);
      acciones.append(cambiar, baja);

      card.append(left, acciones);
      box.appendChild(card);
    }
  }

  async function patchCover(id, body, button) {
    button.disabled = true;
    $('cover-error').hidden = true;
    try {
      await api.patch(`/nightclubs/${clubId()}/cover-prices/${id}`, body);
      toast(t('cover.saved'), 'ok');
      await loadCovers();
    } catch (err) {
      showError(err, $('cover-error'));
      button.disabled = false;
    }
  }

  $('cover-form').onsubmit = async (ev) => {
    ev.preventDefault();
    const b = $('btn-cover-add');
    b.disabled = true;
    $('cover-error').hidden = true;
    try {
      await api.post(`/nightclubs/${clubId()}/cover-prices`, {
        name: $('cover-name').value.trim(),
        amount: Number($('cover-amount').value),
        sort_order: state.covers.length,
      });
      $('cover-name').value = '';
      $('cover-amount').value = '';
      await loadCovers();
    } catch (err) {
      showError(err, $('cover-error'));
    } finally {
      b.disabled = false;
    }
  };

  /** Los covers del club, de un toque, para no teclear la tarifa de la noche. */
  function renderCoverQuick() {
    const box = $('n-price-quick');
    if (!box) return;
    box.innerHTML = '';
    for (const cover of state.covers.filter((c) => c.active)) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'px-2 py-1 rounded-lg text-[11px] card';
      b.textContent = `${cover.name} · ${EV2Format.money(cover.amount, cover.currency)}`;
      b.onclick = () => { $('n-price').value = String(cover.amount); };
      box.appendChild(b);
    }
  }

  // ---------------------------------------------------------------- reportes

  /**
   * La bandeja de moderación. Lo que se ve aquí es deliberadamente poco: quién reportó
   * a quién, por qué y cuándo. El mensaje del flirt NO viaja al gerente ni existe una
   * ruta para pedirlo — leer conversaciones ajenas no es moderar.
   */
  function renderReports() {
    const summary = EV2Manager.moderationSummary(state.reports);
    $('mod-open').textContent = String(summary.open);
    $('mod-urgent').textContent = String(summary.urgent);
    $('mod-actioned').textContent = String(summary.actioned);

    renderReportFilters();

    const list = EV2Manager.sortReports(state.reports);
    $('mod-empty').hidden = list.length > 0;
    const box = $('mod-list');
    box.innerHTML = '';

    for (const report of list) {
      const severity = EV2Manager.reportSeverity(report);
      const card = document.createElement('div');
      card.className = 'card rounded-xl p-3 space-y-2';
      if (severity === 'urgent') card.style.borderColor = 'rgba(248,113,113,.5)';
      if (report.status !== 'open') card.style.opacity = '.7';

      const against = Number(report.reports_against) || 0;
      card.innerHTML = `
        <div class="flex items-start justify-between gap-2">
          <div class="min-w-0">
            <p class="font-semibold truncate">${escape(report.reported_name || '')}</p>
            <p class="text-[11px] text-white/40">${escape(t('mod.reportedBy', { name: report.reporter_name || '' }))}</p>
          </div>
          <span class="text-[11px] shrink-0 ${report.status === 'open' ? 'text-amber-300' : 'text-white/40'}">${escape(t(EV2Manager.reportStatusKey(report.status)))}</span>
        </div>
        <p class="text-sm">${escape(t(EV2Manager.reportReasonKey(report.reason)))}</p>
        ${report.details ? `<p class="text-sm text-white/70">${escape(report.details)}</p>` : ''}
        ${against > 1 ? `<p class="text-[11px] text-red-300">${escape(t('mod.against', { count: against }))}</p>` : ''}
        ${report.flirt_id ? `<p class="text-[11px] text-white/30">${escape(t('mod.flirtAttached'))}</p>` : ''}
        <p class="text-[11px] text-white/30">${escape(EV2Format.dateTime(report.created_at))}</p>
        ${report.resolution_note ? `<p class="text-[11px] text-white/50">${escape(report.resolution_note)}</p>` : ''}
        ${report.reviewed_by_name ? `<p class="text-[11px] text-white/30">${escape(t('mod.reviewedBy', { name: report.reviewed_by_name }))}</p>` : ''}`;

      const actions = EV2Manager.reportActions(report);
      if (actions.length) {
        const note = document.createElement('input');
        note.className = 'w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 focus:border-cyan-400 outline-none text-sm';
        note.maxLength = 500;
        note.placeholder = t('mod.noteHint');
        card.appendChild(note);

        const err = document.createElement('p');
        err.className = 'text-sm text-red-300';
        err.hidden = true;
        card.appendChild(err);

        const row = document.createElement('div');
        row.className = 'grid gap-2';
        row.style.gridTemplateColumns = `repeat(${actions.length}, minmax(0, 1fr))`;
        for (const action of actions) {
          const b = document.createElement('button');
          b.className = `py-2 rounded-lg text-xs ${action === 'actioned' ? 'bg-red-500/90' : 'card'}`;
          b.textContent = t(`mod.ac${action.charAt(0).toUpperCase()}${action.slice(1)}`);
          b.onclick = () => resolveReport(report.id, action, note.value, err, b);
          row.appendChild(b);
        }
        card.appendChild(row);
      }
      box.appendChild(card);
    }
  }

  /** Los filtros por estado. 'Todos' primero, y el que está puesto se ve puesto. */
  function renderReportFilters() {
    const bar = $('mod-filters');
    bar.innerHTML = '';
    const make = (value, label) => {
      const b = document.createElement('button');
      const on = state.reportFilter === value;
      b.className = `px-3 py-1 rounded-full text-xs shrink-0 ${on ? 'bg-white/20' : 'card text-white/60'}`;
      b.textContent = label;
      b.onclick = async () => { state.reportFilter = value; await loadReports(); renderReports(); };
      return b;
    };
    bar.appendChild(make(null, t('mod.filterAll')));
    for (const status of ['open', 'reviewed', 'actioned', 'dismissed']) {
      bar.appendChild(make(status, t(EV2Manager.reportStatusKey(status))));
    }
  }

  async function loadReports() {
    const club = clubId();
    if (!club) return;
    const q = state.reportFilter ? `?status=${state.reportFilter}&limit=100` : '?limit=100';
    try {
      const data = await api.get(`/nightclubs/${club}/reports${q}`);
      state.reports = data.reports || [];
    } catch (err) { showError(err); }
  }

  /**
   * Resolver un reporte. "Bloquear la cuenta" pide nota y confirmación: cierra la
   * sesión de una persona real, la saca de su mesa y no se deshace desde aquí.
   */
  async function resolveReport(reportId, status, note, errorEl, button) {
    errorEl.hidden = true;
    const problem = EV2Manager.validateResolution(status, note);
    if (problem) {
      errorEl.textContent = t(problem);
      errorEl.hidden = false;
      return;
    }
    if (status === 'actioned' && !window.confirm(t('mod.confirmActioned'))) return;
    button.disabled = true;
    try {
      await api.patch(`/nightclubs/${clubId()}/reports/${reportId}`,
        EV2Manager.resolutionPayload(status, note));
      await loadReports();
      renderReports();
      toast(t('mod.resolved'), 'ok');
    } catch (err) {
      showError(err);
      button.disabled = false;
    }
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
      if (actions.canResetPin) {
        add('staff.resetPin', 'card rounded-lg px-3 py-2 text-sm flex-1', (b) => {
          if (!window.confirm(t('staff.confirmResetPin'))) return;
          patchEmployee(person, { reset_pin: true }, 'staff.tempPin', b);
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
      if (data.temporary_password || data.pin) {
        secret.hold(EV2StaffAdmin.displayFor(person).primary,
          { pin: data.pin, password: data.temporary_password });
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

  /** El rol de quien está viendo la pantalla: decide qué puede dar de alta. */
  const myRole = () => (api.session.user && api.session.user.role) || null;

  function fillRoleOptions() {
    const select = $('s-role');
    if (select.options.length) return;
    for (const role of EV2StaffAdmin.creatableRoles(myRole())) {
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
    const errors = EV2StaffAdmin.validateEmployee(form, new Date(), myRole());
    if (Object.keys(errors).length) { showStaffErrors(errors); return; }
    clearStaffErrors();

    try {
      const data = await api.post(`/nightclubs/${clubId()}/employees`,
        EV2StaffAdmin.employeePayload(form));
      $('staff-form').reset();
      $('staff-form').hidden = true;
      // Las dos cosas viajan UNA vez, en esta respuesta. El de piso recibe solo PIN;
      // un gerente nuevo recibe las dos, porque entra por las dos puertas.
      secret.hold(EV2StaffAdmin.displayFor(data.employee || form).primary,
        { pin: data.pin, password: data.temporary_password });
      await loadAll();
    } catch (err) { showError(err); }
  };

  // ---------------------------------------------------------------- terminales (D47)

  /**
   * Las terminales del club.
   *
   * Es lo primero que hay que hacer para cobrar con tarjeta, y también el diagnóstico
   * cuando "toco cobrar y no pasa nada": el modo de operación se enseña aquí, porque una
   * terminal en STANDALONE ignora al sistema sin decir una palabra.
   *
   * REGLA DE ESTA SECCIÓN, aprendida por las malas: **ningún botón puede no hacer nada.**
   * El 21 de septiembre de 2026 el gerente reportó dos veces que "el botón no funciona",
   * y las dos era verdad desde donde él estaba parado. Se encontraron cuatro caminos
   * silenciosos: el botón de buscar se APAGABA sin credenciales (se veía, no respondía);
   * una búsqueda que volvía vacía no enseñaba nada; "Dar de alta" sin nombre solo ponía un
   * borde rojo; y si Mercado Pago rechazaba el cambio a PDV, la terminal no se guardaba y
   * el error salía en inglés al fondo de la tarjeta, fuera de la pantalla del teléfono.
   * Cada toque ahora dice qué está haciendo mientras espera, y en qué terminó.
   */
  async function loadTerminals() {
    try {
      const data = await api.get(`/nightclubs/${clubId()}/payment-terminals`);
      terminals.mine = data.terminals || [];
      terminals.provider = data.provider || null;
    } catch {
      terminals.mine = [];
    }
    renderTerminals();
  }

  const MODE_KEY = {
    PDV: 'term.modePDV', STANDALONE: 'term.modeStandalone', UNDEFINED: 'term.modeUnknown',
  };

  /** Un mensaje donde se ve: junto a lo que se tocó, y llevado a la pantalla. */
  function avisar(el, message, kind) {
    el.textContent = message;
    el.hidden = false;
    el.style.color = kind === 'warn' ? '#fcd34d' : '';
    try { el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch { /* navegadores viejos */ }
  }

  /** El botón dice lo que está haciendo mientras espera. Devuelve cómo regresarlo. */
  function ocupado(button, key) {
    const antes = button.textContent;
    button.disabled = true;
    button.textContent = t(key);
    button.setAttribute('aria-busy', 'true');
    return () => {
      button.disabled = false;
      button.textContent = antes;
      button.removeAttribute('aria-busy');
    };
  }

  const faltaConfig = () => {
    const prov = terminals.provider;
    return prov && !prov.configured ? prov : null;
  };

  function renderTerminals() {
    const aviso = $('term-not-configured');
    const falta = faltaConfig();
    aviso.hidden = !falta;
    if (falta) aviso.textContent = t('term.notConfigured', { missing: (falta.missing || []).join(', ') });
    // El botón NO se apaga sin credenciales. Apagado se veía igual y no respondía, y eso
    // se lee como "está roto". Encendido, al tocarlo explica qué falta (ver abajo).
    $('btn-term-discover').disabled = false;

    $('term-empty').hidden = terminals.mine.length > 0;
    const box = $('term-list');
    box.innerHTML = '';
    for (const term of terminals.mine) {
      const card = document.createElement('div');
      card.className = 'card rounded-lg px-3 py-2 space-y-2';
      if (term.active === false) card.style.opacity = '.55';

      const fila = document.createElement('div');
      fila.className = 'flex items-center justify-between gap-3';

      const left = document.createElement('div');
      left.className = 'min-w-0';
      const name = document.createElement('p');
      name.className = 'font-display truncate';
      name.textContent = term.label;
      const mode = document.createElement('p');
      mode.className = 'text-[11px]';
      mode.style.color = term.operating_mode === 'PDV'
        ? 'var(--ev2-lime)' : term.operating_mode === 'STANDALONE' ? '#fca5a5' : '#fcd34d';
      mode.textContent = t(MODE_KEY[term.operating_mode] || 'term.modeUnknown');
      left.append(name, mode);

      const acciones = document.createElement('div');
      acciones.className = 'flex gap-2 shrink-0';
      const nota = document.createElement('p');
      nota.className = 'text-xs text-red-300';
      nota.hidden = true;
      // La razón por la que se dio de alta sin poder cobrar. Se queda puesta hasta que se
      // arregle: si solo saliera en un aviso de dos segundos, nadie sabría qué pasó.
      const pendiente = terminals.warnings[term.id];
      if (pendiente && term.operating_mode !== 'PDV') avisar(nota, pendiente, 'warn');

      if (term.operating_mode !== 'PDV') {
        const fix = document.createElement('button');
        fix.className = 'card rounded-lg px-3 py-2 text-xs';
        fix.textContent = t('term.fixMode');
        fix.onclick = () => patchTerminal(term.id, { set_pdv: true }, fix, 'term.restart', nota, 'term.fixing');
        acciones.appendChild(fix);
      }
      const baja = document.createElement('button');
      baja.className = `card rounded-lg px-3 py-2 text-xs ${term.active === false ? '' : 'text-red-300'}`;
      baja.textContent = t(term.active === false ? 'term.reactivate' : 'term.deactivate');
      baja.onclick = () => patchTerminal(term.id, { active: term.active === false }, baja, 'term.saved', nota, 'term.saving');
      acciones.appendChild(baja);

      fila.append(left, acciones);
      card.append(fila, nota);
      box.appendChild(card);
    }
  }

  async function patchTerminal(id, body, button, okKey, where, busyKey) {
    const listo = ocupado(button, busyKey);
    where.hidden = true;
    try {
      await api.patch(`/nightclubs/${clubId()}/payment-terminals/${id}`, body);
      if (body.set_pdv) delete terminals.warnings[id];
      toast(t(okKey), 'ok');
      await loadTerminals();
    } catch (err) {
      listo();
      avisar(where, EV2Format.errorMessage(err));
    }
  }

  $('btn-term-discover').onclick = async () => {
    const b = $('btn-term-discover');
    const error = $('term-error');
    error.hidden = true;
    // Sin credenciales no hay nada que preguntarle a Mercado Pago, pero el toque se
    // contesta igual: con lo que falta y dónde se pone.
    const falta = faltaConfig();
    if (falta) {
      avisar(error, t('term.notConfigured', { missing: (falta.missing || []).join(', ') }));
      return;
    }
    const listo = ocupado(b, 'term.searching');
    try {
      const data = await api.post(`/nightclubs/${clubId()}/payment-terminals/discover`, {});
      terminals.found = data.terminals || [];
      renderFoundTerminals();
      // Vacío también es una respuesta, y la que más confunde: sin esto no aparecía nada.
      // En modo prueba nunca llega vacío (siempre está la virtual), pero si no hay NINGUNA
      // física se explica por qué: con credenciales de prueba la Point del club no
      // aparece, y es lo primero que alguien espera ver.
      const fisicas = terminals.found.filter((f) => !f.virtual);
      if (terminals.found.length === 0) avisar(error, t('term.noneFound'), 'warn');
      else if (data.mode === 'test' && fisicas.length === 0) avisar(error, t('term.testOnlyVirtual'), 'warn');
      // Buscar pone al día el modo de las que ya están dadas de alta.
      await loadTerminals();
    } catch (err) {
      avisar(error, EV2Format.errorMessage(err));
    } finally {
      listo();
    }
  };

  function renderFoundTerminals() {
    $('term-found-block').hidden = terminals.found.length === 0;
    const box = $('term-found');
    box.innerHTML = '';
    for (const found of terminals.found) {
      const fila = document.createElement('div');
      fila.className = 'card rounded-lg px-3 py-2 space-y-2';

      const id = document.createElement('p');
      id.className = 'text-[11px] text-white/40 break-all';
      id.textContent = found.external_id;
      if (found.virtual) {
        const v = document.createElement('p');
        v.className = 'text-xs';
        v.style.color = '#fcd34d';
        v.textContent = t('term.virtual');
        fila.appendChild(v);
      }
      fila.appendChild(id);

      if (found.registered) {
        const ya = document.createElement('p');
        ya.className = 'text-xs';
        ya.style.color = 'var(--ev2-lime)';
        ya.textContent = t('term.registered');
        fila.appendChild(ya);
      } else {
        const linea = document.createElement('div');
        linea.className = 'flex gap-2';
        const input = document.createElement('input');
        input.className = 'field flex-1';
        input.maxLength = 60;
        input.placeholder = t('term.label');
        input.setAttribute('aria-label', t('term.label'));
        // La virtual trae nombre puesto: nadie le va a buscar uno a algo que no existe.
        if (found.virtual) input.value = t('term.virtualName');
        const alta = document.createElement('button');
        alta.className = 'ev2-button rounded-lg px-3 py-2 text-xs shrink-0';
        alta.textContent = t('term.register');
        // El resultado del alta va AQUÍ, pegado a la terminal que se tocó. Al fondo de la
        // tarjeta quedaba fuera de la pantalla del teléfono.
        const nota = document.createElement('p');
        nota.className = 'text-xs text-red-300';
        nota.hidden = true;
        input.oninput = () => { input.classList.remove('bad'); nota.hidden = true; };
        alta.onclick = async () => {
          const label = input.value.trim();
          nota.hidden = true;
          // Sin nombre no se da de alta: un número de serie no es un nombre que el
          // personal pueda usar a las dos de la mañana. Pero se DICE, no solo se marca.
          if (!label) {
            input.classList.add('bad');
            avisar(nota, t('term.needName'));
            input.focus();
            return;
          }
          const listo = ocupado(alta, 'term.registering');
          try {
            const data = await api.post(`/nightclubs/${clubId()}/payment-terminals`, {
              external_id: found.external_id, label, set_pdv: true,
            });
            if (data.warning) {
              // Quedó dada de alta, pero todavía no cobra. Se guarda la razón para
              // enseñarla en su tarjeta hasta que se arregle.
              terminals.warnings[data.terminal.id] = data.warning;
              toast(t('term.savedPending'), 'error');
            } else {
              toast(t(data.sandbox ? 'term.sandboxReady' : 'term.restart'), 'ok');
            }
            terminals.found = [];
            $('term-found-block').hidden = true;
            await loadTerminals();
          } catch (err) {
            listo();
            avisar(nota, EV2Format.errorMessage(err));
          }
        };
        linea.append(input, alta);
        fila.append(linea, nota);
      }
      box.appendChild(fila);
    }
  }

  // ---------------------------------------------------------------- cobros con terminal (D49)

  /**
   * Los cobros con terminal de las últimas 24 horas, y el botón de devolver.
   *
   * Devolver es dinero que sale: se pide el motivo (se guarda con el nombre de quien lo
   * hizo) y se confirma con el monto y la tarjeta a la vista. Solo el cobro completo, a
   * propósito: ver D49.
   */
  async function loadTerminalCharges() {
    try {
      const data = await api.get(`/nightclubs/${clubId()}/terminal-charges?hours=24`);
      terminals.charges = data.charges || [];
    } catch {
      terminals.charges = [];
    }
    renderTerminalCharges();
  }

  const TCH_COLOR = { processed: 'var(--ev2-lime)', refunded: '#fcd34d', error: '#fca5a5', failed: '#fca5a5' };

  function renderTerminalCharges() {
    const lista = terminals.charges || [];
    $('tch-empty').hidden = lista.length > 0;
    const box = $('tch-list');
    box.innerHTML = '';
    for (const c of lista) {
      const card = document.createElement('div');
      card.className = 'card rounded-lg px-3 py-2 space-y-2';

      const fila = document.createElement('div');
      fila.className = 'flex items-center justify-between gap-3';
      const left = document.createElement('div');
      left.className = 'min-w-0';
      const monto = document.createElement('p');
      monto.className = 'font-display';
      monto.textContent = money(c.amount, c.currency);
      const estado = document.createElement('p');
      estado.className = 'text-[11px]';
      estado.style.color = TCH_COLOR[c.status] || 'rgba(255,255,255,.5)';
      const partes = [t(`tch.status.${c.status}`)];
      if (c.card) partes.push(`${c.card.brand}`);
      if (Number(c.tip_amount) > 0) partes.push(t('tch.tip', { tip: money(c.tip_amount, c.currency) }));
      estado.textContent = partes.join(' · ');
      const quien = document.createElement('p');
      quien.className = 'text-[11px] text-white/40 truncate';
      const hora = new Date(c.created_at).toLocaleTimeString(lang() === 'en' ? 'en-US' : 'es-MX',
        { hour: '2-digit', minute: '2-digit' });
      quien.textContent = `${hora} · ${c.terminal ? c.terminal.label : ''} · ${t('tch.by', { name: (c.started_by && c.started_by.name) || '' })}`;
      left.append(monto, estado, quien);
      fila.appendChild(left);

      const nota = document.createElement('p');
      nota.className = 'text-xs text-red-300';
      nota.hidden = true;

      if (!c.is_final && c.terminal && c.terminal.virtual) {
        // Sin aparato no hay tarjeta que pasar: el resultado se decide aquí. La ruta solo
        // existe con credenciales de prueba y solo la llama el gerente.
        const acciones = document.createElement('div');
        acciones.className = 'flex gap-2 shrink-0';
        for (const [status, key] of [['processed', 'tch.simPaid'], ['failed', 'tch.simFailed']]) {
          const b = document.createElement('button');
          b.className = `card rounded-lg px-3 py-2 text-xs ${status === 'failed' ? 'text-red-300' : ''}`;
          b.textContent = t(key);
          b.onclick = () => simulateCharge(c, status, b, nota);
          acciones.appendChild(b);
        }
        fila.appendChild(acciones);
      }
      if (c.refundable) {
        const devolver = document.createElement('button');
        devolver.className = 'card rounded-lg px-3 py-2 text-xs text-red-300 shrink-0';
        devolver.textContent = t('tch.refund');
        devolver.onclick = () => refundCharge(c, devolver, nota);
        fila.appendChild(devolver);
      }
      card.appendChild(fila);

      for (const r of c.refunds || []) {
        const linea = document.createElement('p');
        linea.className = 'text-[11px] text-white/50';
        const who = r.source === 'external' ? t('tch.external') : (r.requested_by || '');
        linea.textContent = `${t('tch.refundedBy', { amount: money(r.amount, r.currency), who })}${r.reason ? ` — ${r.reason}` : ''}`;
        card.appendChild(linea);
      }
      card.appendChild(nota);
      box.appendChild(card);
    }
  }

  async function refundCharge(c, button, nota) {
    nota.hidden = true;
    const total = money(Number(c.amount) + Number(c.tip_amount || 0), c.currency);
    const motivo = window.prompt(t('tch.reason', { amount: total }), '');
    if (motivo === null) return;
    if (motivo.trim().length < 5) { avisar(nota, t('tch.errReason')); return; }
    const tarjeta = c.card ? c.card.brand : '';
    if (!window.confirm(t('tch.confirm', { amount: total, card: tarjeta }))) return;

    const listo = ocupado(button, 'tch.refunding');
    try {
      const data = await api.post(`/nightclubs/${clubId()}/terminal-charges/${c.id}/refund`, {
        reason: motivo.trim(),
      });
      toast(t(data.outcome === 'pending' ? 'tch.pending' : 'tch.done'), 'ok');
      await loadTerminalCharges();
    } catch (err) {
      listo();
      avisar(nota, EV2Format.errorMessage(err));
    }
  }

  async function simulateCharge(c, status, button, nota) {
    nota.hidden = true;
    const listo = ocupado(button, 'tch.simulating');
    try {
      await api.post(`/nightclubs/${clubId()}/terminal-charges/${c.id}/simulate`, { status });
      // Mercado Pago tarda unos segundos en aplicar el resultado simulado. Consultar el
      // cobro le pregunta directamente y asienta lo que conteste, sin esperar al webhook.
      for (let i = 0; i < 6; i += 1) {
        await new Promise((r) => setTimeout(r, 2000));
        const data = await api.get(`/nightclubs/${clubId()}/terminal-charges/${c.id}`);
        if (data.charge && data.charge.is_final) break;
      }
      await loadTerminalCharges();
    } catch (err) {
      listo();
      avisar(nota, EV2Format.errorMessage(err));
    }
  }

  $('btn-tch-reload').onclick = async () => {
    const listo = ocupado($('btn-tch-reload'), 'tch.reload');
    try { await loadTerminalCharges(); } finally { listo(); }
  };

  // ---------------------------------------------------------------- cortes de turno (D51)

  /**
   * Lo que el gerente tiene que contar: las entregas de efectivo de media noche y los
   * cortes que esperan a que alguien cuente el dinero.
   *
   * Confirmar un corte cierra el turno de esa persona, así que el botón pide el monto
   * contado y, si no cuadra, el motivo. Un faltante sin explicación es exactamente lo
   * que este panel existe para no dejar pasar.
   */
  async function loadShiftCuts() {
    try {
      const [drops, cierres] = await Promise.all([
        api.get(`/nightclubs/${clubId()}/cash-drops?status=declared`),
        api.get(`/nightclubs/${clubId()}/shift-closings?status=declared`),
      ]);
      state.cashDrops = drops.drops || [];
      state.shiftCuts = cierres.closings || [];
    } catch {
      state.cashDrops = [];
      state.shiftCuts = [];
    }
    renderShiftCuts();
  }

  function renderShiftCuts() {
    const drops = state.cashDrops || [];
    const cortes = state.shiftCuts || [];
    $('cuts-empty').hidden = drops.length > 0 || cortes.length > 0;

    const cajaDrops = $('cuts-drops');
    cajaDrops.innerHTML = '';
    for (const d of drops) {
      const card = document.createElement('div');
      card.className = 'card rounded-lg px-3 py-2 space-y-2';
      const fila = document.createElement('div');
      fila.className = 'flex items-center justify-between gap-3';
      const left = document.createElement('div');
      left.className = 'min-w-0';
      const monto = document.createElement('p');
      monto.className = 'font-display';
      monto.textContent = money(d.amount, d.currency);
      const quien = document.createElement('p');
      quien.className = 'text-[11px] text-white/50 truncate';
      quien.textContent = t('cuts.dropFrom', { name: d.user_name || '', note: d.note || '' });
      left.append(monto, quien);
      const nota = document.createElement('p');
      nota.className = 'text-xs text-red-300';
      nota.hidden = true;

      const acciones = document.createElement('div');
      acciones.className = 'flex gap-2 shrink-0';
      const recibir = document.createElement('button');
      recibir.className = 'card rounded-lg px-3 py-2 text-xs';
      recibir.textContent = t('cuts.receive');
      recibir.onclick = () => receiveDrop(d, recibir, nota);
      const rechazar = document.createElement('button');
      rechazar.className = 'card rounded-lg px-3 py-2 text-xs text-red-300';
      rechazar.textContent = t('cuts.reject');
      rechazar.onclick = () => rejectDrop(d, rechazar, nota);
      acciones.append(recibir, rechazar);

      fila.append(left, acciones);
      card.append(fila, nota);
      cajaDrops.appendChild(card);
    }

    const caja = $('cuts-list');
    caja.innerHTML = '';
    for (const c of cortes) {
      const card = document.createElement('div');
      card.className = 'card rounded-lg px-3 py-2 space-y-2';

      const fila = document.createElement('div');
      fila.className = 'flex items-center justify-between gap-3';
      const left = document.createElement('div');
      left.className = 'min-w-0';
      const quien = document.createElement('p');
      quien.className = 'font-display truncate';
      quien.textContent = `${c.user_name} · ${EV2Roles.describe(c.role, lang()).label}`;
      const montos = document.createElement('p');
      montos.className = 'text-[11px] text-white/50';
      montos.textContent = t('cuts.amounts', {
        expected: money(c.expected_cash, c.currency),
        declared: money(c.declared_cash, c.currency),
      });
      left.append(quien, montos);
      const nota = document.createElement('p');
      nota.className = 'text-xs text-red-300';
      nota.hidden = true;

      const confirmar = document.createElement('button');
      confirmar.className = 'ev2-button rounded-lg px-3 py-2 text-xs shrink-0';
      confirmar.textContent = t('cuts.count');
      confirmar.onclick = () => confirmCut(c, confirmar, nota);

      fila.append(left, confirmar);
      card.append(fila, nota);
      if (c.declared_notes) {
        const n = document.createElement('p');
        n.className = 'text-[11px] text-white/40';
        n.textContent = c.declared_notes;
        card.appendChild(n);
      }
      caja.appendChild(card);
    }
  }

  async function receiveDrop(drop, button, nota) {
    nota.hidden = true;
    const dicho = window.prompt(t('cuts.countedPrompt', { amount: money(drop.amount, drop.currency) }),
      drop.amount);
    if (dicho === null) return;
    // Enter en blanco = "cuadra con lo declarado". Tomarlo como CERO daría por recibida
    // una entrega de nada, y ese dinero le seguiría cobrándose a quien ya lo entregó.
    const contado = String(dicho).trim() === '' ? Number(drop.amount) : Number(dicho);
    if (!(contado >= 0)) { avisar(nota, t('cuts.errAmount')); return; }
    const listo = ocupado(button, 'cuts.saving');
    try {
      await api.post(`/nightclubs/${clubId()}/cash-drops/${drop.id}/receive`, { counted_amount: contado });
      toast(t('cuts.received'), 'ok');
      await loadShiftCuts();
    } catch (err) {
      listo();
      avisar(nota, EV2Format.errorMessage(err));
    }
  }

  async function rejectDrop(drop, button, nota) {
    nota.hidden = true;
    const motivo = window.prompt(t('cuts.rejectPrompt'), '');
    if (motivo === null) return;
    if (motivo.trim().length < 5) { avisar(nota, t('cuts.errReason')); return; }
    const listo = ocupado(button, 'cuts.saving');
    try {
      await api.post(`/nightclubs/${clubId()}/cash-drops/${drop.id}/reject`, { reason: motivo.trim() });
      await loadShiftCuts();
    } catch (err) {
      listo();
      avisar(nota, EV2Format.errorMessage(err));
    }
  }

  async function confirmCut(corte, button, nota) {
    nota.hidden = true;
    const dicho = window.prompt(t('cuts.countPrompt', {
      name: corte.user_name, expected: money(corte.expected_cash, corte.currency),
    }), corte.declared_cash);
    if (dicho === null) return;
    // Igual que arriba: en blanco es "lo que declaró", no cero.
    const contado = String(dicho).trim() === '' ? Number(corte.declared_cash) : Number(dicho);
    if (!(contado >= 0)) { avisar(nota, t('cuts.errAmount')); return; }

    const diferencia = Math.round((contado - Number(corte.expected_cash)) * 100) / 100;
    let motivo = null;
    if (diferencia !== 0) {
      // Un faltante o un sobrante no se cierra sin explicación: el servidor también lo
      // exige, pero preguntarlo aquí evita el viaje de ida y vuelta con un error.
      motivo = window.prompt(t(diferencia < 0 ? 'cuts.missingPrompt' : 'cuts.overPrompt', {
        amount: money(Math.abs(diferencia), corte.currency),
      }), '');
      if (motivo === null) return;
      if (motivo.trim().length < 5) { avisar(nota, t('cuts.errReason')); return; }
    }
    if (!window.confirm(t('cuts.confirmClose', { name: corte.user_name }))) return;

    const listo = ocupado(button, 'cuts.saving');
    try {
      await api.post(`/nightclubs/${clubId()}/shift-closings/${corte.id}/confirm`, {
        counted_cash: contado, ...(motivo ? { reason: motivo.trim() } : {}),
      });
      toast(t('cuts.closed'), 'ok');
      await loadShiftCuts();
    } catch (err) {
      listo();
      avisar(nota, EV2Format.errorMessage(err));
    }
  }

  $('btn-cuts-reload').onclick = async () => {
    const listo = ocupado($('btn-cuts-reload'), 'cuts.reload');
    try { await loadShiftCuts(); } finally { listo(); }
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
      // El corte y el rol viven en la noche a la que pertenecen, no en una pestaña
      // aparte: el gerente piensa "cómo salió el viernes", no "abre el reporte".
      add('cut.open', 'card rounded-lg px-3 py-2 text-sm flex-1', () => openCut(night));
      add('roster.open', 'card rounded-lg px-3 py-2 text-sm flex-1', () => openRoster(night));

      if (row.children.length) card.appendChild(row);
      box.appendChild(card);
    }
    renderCompare();
  }

  // ==================================================== el corte de la noche

  async function openCut(night) {
    state.cut = { night, stats: null, closed: null };
    $('cut-night').textContent = `${night.name} · ${String(night.event_date).slice(0, 10)}`;
    $('cut-body').innerHTML = `<p class="text-white/40 text-sm py-8 text-center">${escape(t('manager.loading'))}</p>`;
    $('cut-error').hidden = true;
    $('cut-note').value = '';
    $('cut-sheet').hidden = false;

    try {
      const data = await api.get(`/nightclubs/${clubId()}/nights/${night.id}/stats`);
      state.cut.stats = data.stats;
      state.cut.closed = data.closed;
    } catch (err) {
      showError(err, $('cut-error'));
      $('cut-body').innerHTML = '';
      return;
    }
    renderCut();
  }

  function closeCut() {
    state.cut = null;
    $('cut-sheet').hidden = true;
  }

  function renderCut() {
    const c = state.cut;
    if (!c || !c.stats) return;
    const s = c.stats;
    const cur = s.currency;
    const cabeza = EV2NightReport.headline(s);
    const avisos = EV2NightReport.flags(s);
    const zonas = EV2NightReport.zonesByRevenue(s);
    const cats = EV2NightReport.topCategories(s);

    const tile = (valor, etiqueta) => `
      <div class="stat-card">
        <div class="stat-number">${escape(valor)}</div>
        <div class="stat-label">${escape(etiqueta)}</div>
      </div>`;

    const fila = (izq, der, tono = '') => `
      <div class="flex justify-between gap-3 text-sm ${tono}">
        <span class="text-white/60 min-w-0 truncate">${escape(izq)}</span>
        <span class="shrink-0">${escape(der)}</span>
      </div>`;

    $('cut-body').innerHTML = `
      <div class="grid grid-cols-2 gap-2">
        ${tile(money(cabeza.revenue, cur), t('cut.revenue'))}
        ${tile(String(cabeza.attendance), t('cut.attendance'))}
        ${tile(`${cabeza.occupancy}%`, t('cut.occupancy'))}
        ${tile(money(cabeza.per_person, cur), t('cut.perPerson'))}
      </div>

      ${avisos.length > 0 ? `
        <section class="card rounded-xl p-3 space-y-1">
          <p class="text-xs uppercase tracking-wider text-white/40">${escape(t('cut.watch'))}</p>
          ${avisos.map((a) => `<p class="text-sm ${
    a.tone === 'bad' ? 'text-red-300' : a.tone === 'warn' ? 'text-amber-200' : 'text-white/70'
  }">${escape(flagText(a, cur))}</p>`).join('')}
        </section>` : ''}

      <section class="card rounded-xl p-3 space-y-1">
        <p class="text-xs uppercase tracking-wider text-white/40">${escape(t('cut.money'))}</p>
        ${fila(t('cut.tables'), money(s.revenue.tables, cur))}
        ${fila(t('cut.bar'), money(s.revenue.bar, cur))}
        ${fila(t('cut.door'), money(s.revenue.door, cur))}
        <div class="border-t border-white/10 pt-1 mt-1"></div>
        ${fila(t('cut.total'), money(s.revenue.total, cur))}
        ${fila(t('cut.tipsApart'), money(s.revenue.tips_not_club_revenue, cur), 'text-white/40')}
      </section>

      <section class="card rounded-xl p-3 space-y-1">
        <p class="text-xs uppercase tracking-wider text-white/40">${escape(t('cut.reservations'))}</p>
        ${fila(t('cut.booked'), String(s.reservations.booked))}
        ${fila(t('cut.arrived'), String(s.reservations.arrived))}
        ${fila(t('cut.noShow'), String(s.reservations.no_show), s.reservations.no_show > 0 ? 'text-amber-200' : '')}
        ${s.reservations.cancelled > 0 ? fila(t('cut.cancelled'), String(s.reservations.cancelled)) : ''}
      </section>

      <section class="card rounded-xl p-3 space-y-1">
        <p class="text-xs uppercase tracking-wider text-white/40">${escape(t('cut.zones'))}</p>
        ${zonas.map((z) => fila(
    `${z.section} · ${z.tables_used}/${z.tables_total} (${z.occupancy}%)`,
    money(z.revenue, cur),
    z.occupancy < 50 ? 'text-white/50' : '',
  )).join('')}
      </section>

      ${cats.length > 0 ? `
        <section class="card rounded-xl p-3 space-y-1">
          <p class="text-xs uppercase tracking-wider text-white/40">${escape(t('cut.byCategory'))}</p>
          ${cats.map((c2) => fila(`${c2.category} · ${c2.units}`, money(c2.revenue, cur))).join('')}
        </section>` : ''}

      ${(s.bar.by_bar || []).length > 0 ? `
        <section class="card rounded-xl p-3 space-y-1">
          <p class="text-xs uppercase tracking-wider text-white/40">${escape(t('cut.byBar'))}</p>
          ${s.bar.by_bar.map((b) => fila(b.name, t('cut.barCost', { amount: money(b.cost, cur) }))).join('')}
        </section>` : ''}

      <section class="card rounded-xl p-3 space-y-1">
        <p class="text-xs uppercase tracking-wider text-white/40">${escape(t('cut.staff'))}</p>
        ${fila(t('cut.assigned'), String(s.staff.assigned))}
        ${fila(t('cut.showedUp'), String(s.staff.showed_up),
    s.staff.showed_up < s.staff.assigned ? 'text-amber-200' : '')}
        ${(s.tips.by_person || []).slice(0, 5).map((p) => fila(
    `${p.display_name} · ${t('cut.tips')}`, money(p.total, cur), 'text-white/50',
  )).join('')}
      </section>`;

    // El botón de cerrar solo si de verdad se puede: ofrecer uno que va a fallar
    // es peor que no ofrecerlo.
    const puede = EV2NightReport.canClose({ stats: s, closed: c.closed });
    $('btn-cut-save').hidden = !puede.ok;
    $('cut-note').hidden = !puede.ok;
    const nota = $('cut-frozen');
    if (c.closed) {
      // Los números de arriba son EN VIVO y pueden diferir del corte guardado (una
      // propina tardía, un pedido que se entregó después). Decirlo evita que dos
      // cifras distintas parezcan un error del sistema.
      nota.textContent = t('cut.alreadyClosed', {
        when: EV2Format.dateTime(c.closed.closed_at),
      });
      nota.hidden = false;
    } else if (!puede.ok) {
      nota.textContent = t(`cut.cannot.${puede.reason}`);
      nota.hidden = false;
    } else {
      nota.hidden = true;
    }
  }

  /** Los avisos del corte, en palabras. Cada uno lleva su número al lado. */
  function flagText(flag, currency) {
    if (flag.key === 'no_show') {
      return t('cut.flag.noShow', {
        n: flag.count, pct: flag.pct === null ? '—' : `${flag.pct}%`,
      });
    }
    if (flag.key === 'cold_zone') {
      return t('cut.flag.coldZone', { zone: flag.section, pct: flag.occupancy });
    }
    if (flag.key === 'shrinkage') {
      return t('cut.flag.shrinkage', { amount: money(flag.value, currency) });
    }
    if (flag.key === 'cancelled_orders') {
      return t('cut.flag.cancelled', { n: flag.count, amount: money(flag.value, currency) });
    }
    if (flag.key === 'missing_staff') {
      return t('cut.flag.missingStaff', { n: flag.count, assigned: flag.assigned });
    }
    return '';
  }

  $('btn-cut-close').onclick = closeCut;

  $('btn-cut-save').onclick = async () => {
    const c = state.cut;
    if (!c || state.busy) return;
    if (!window.confirm(t('cut.confirmClose'))) return;
    state.busy = true;
    $('btn-cut-save').disabled = true;
    $('cut-error').hidden = true;
    try {
      await api.post(`/nightclubs/${clubId()}/nights/${c.night.id}/close`,
        { note: $('cut-note').value.trim() || undefined });
      toast(t('cut.closed'), 'ok');
      closeCut();
      await loadAll();
    } catch (err) {
      showError(err, $('cut-error'));
    } finally {
      state.busy = false;
      $('btn-cut-save').disabled = false;
    }
  };

  // -------------------------------------------------------------- comparar noches

  function renderCompare() {
    const opciones = EV2NightReport.closingOptions(state.closings);
    // Con una sola noche cerrada no hay nada que comparar, y el recuadro vacío
    // solo estorba.
    $('compare-box').hidden = opciones.length < 2;
    if (opciones.length < 2) return;

    const pintar = (id, seleccionado) => {
      $(id).innerHTML = opciones.map((o) => `<option value="${escape(o.event_id)}"
          ${o.event_id === seleccionado ? 'selected' : ''}>${escape(o.label)}</option>`).join('');
    };
    if (!$('compare-a').value) pintar('compare-a', opciones[0].event_id);
    else pintar('compare-a', $('compare-a').value);
    if (!$('compare-b').value) pintar('compare-b', opciones[1].event_id);
    else pintar('compare-b', $('compare-b').value);

    $('compare-a').onchange = renderCompare;
    $('compare-b').onchange = renderCompare;

    const a = state.closings.find((c) => c.event_id === $('compare-a').value);
    const b = state.closings.find((c) => c.event_id === $('compare-b').value);
    const resultado = EV2NightReport.compare(a, b);
    const caja = $('compare-result');

    if (!resultado) { caja.innerHTML = ''; return; }
    if (!resultado.comparable) {
      caja.innerHTML = `<p class="text-sm text-amber-200">${escape(t('cut.notComparable'))}</p>`;
      return;
    }

    const CAMPOS = [
      ['revenue_total', 'cut.total', true],
      ['attendance', 'cut.attendance', false],
      ['tables_used', 'cut.tablesUsed', false],
      ['reservations_no_show', 'cut.noShow', false],
      ['shrinkage_value', 'cut.shrinkage', true],
    ];
    caja.innerHTML = CAMPOS.map(([campo, clave, esDinero]) => {
      const d = resultado.diff[campo];
      const signo = d.delta > 0 ? '+' : '';
      const color = d.delta === 0 ? 'text-white/50'
        : (campo === 'reservations_no_show' || campo === 'shrinkage_value')
          ? (d.delta > 0 ? 'text-red-300' : 'text-emerald-300')
          : (d.delta > 0 ? 'text-emerald-300' : 'text-red-300');
      const valor = esDinero
        ? `${signo}${money(d.delta, resultado.currency)}`
        : `${signo}${d.delta}`;
      return `<div class="flex justify-between gap-3 text-sm">
          <span class="text-white/60">${escape(t(clave))}</span>
          <span class="${color}">${escape(valor)}${d.pct === null ? '' : ` (${signo}${d.pct}%)`}</span>
        </div>`;
    }).join('');
  }

  // ==================================================== el rol de la noche

  async function openRoster(night) {
    state.roster = { night, roster: [], gaps: { sections: [], bars: [] } };
    $('roster-night').textContent = `${night.name} · ${String(night.event_date).slice(0, 10)}`;
    $('roster-error').hidden = true;
    $('roster-sheet').hidden = false;
    await reloadRoster();
  }

  async function reloadRoster() {
    const r = state.roster;
    if (!r) return;
    try {
      const data = await api.get(`/nightclubs/${clubId()}/nights/${r.night.id}/roster`);
      r.roster = data.roster || [];
      r.gaps = data.gaps || { sections: [], bars: [] };
    } catch (err) {
      showError(err, $('roster-error'));
      return;
    }
    renderRoster();
  }

  function closeRoster() {
    state.roster = null;
    $('roster-sheet').hidden = true;
  }

  function renderRoster() {
    const r = state.roster;
    if (!r) return;
    const avance = EV2Roster.progress(r);
    // Todas las zonas del club: las que quedaron sin nadie vienen en `gaps`, y las
    // que ya tienen gente vienen en el rol. Juntas son el plano completo, así que
    // una zona vacía no puede desaparecer de la pantalla — que es justo lo que hay
    // que ver.
    const zonasConocidas = [...new Set(
      r.gaps.sections.concat(
        r.roster.flatMap((p) => (p.targets || []).map((x) => x.section).filter(Boolean)),
      ),
    )];
    const barrasConocidas = r.gaps.bars.concat(
      r.roster.flatMap((p) => (p.targets || [])
        .filter((x) => x.location_id)
        .map((x) => ({ location_id: x.location_id, name: x.location_name }))),
    );
    const porDestino = EV2Roster.byTarget({
      roster: r.roster, sections: zonasConocidas, bars: dedupeBars(barrasConocidas),
    });

    $('roster-progress').innerHTML = avance.complete
      ? `<span class="text-emerald-300">${escape(t('roster.complete'))}</span>`
      : `<span class="text-amber-200">${escape(t('roster.missing', {
        zones: avance.missing_sections, bars: avance.missing_bars,
      }))}</span>`;

    const persona = (p) => `
      <div class="flex items-center justify-between gap-2 text-sm">
        <span class="min-w-0 truncate">
          ${escape(p.display_name)}
          <span class="${p.on_shift ? 'text-emerald-300' : 'text-white/35'} text-[11px]">
            · ${escape(t(p.on_shift ? 'roster.here' : 'roster.notHere'))}
          </span>
        </span>
        <button class="text-[11px] text-red-300 underline shrink-0"
                data-unassign="${escape(p.assignment_id)}">${escape(t('roster.remove'))}</button>
      </div>`;

    const bloque = (titulo, gente, boton) => `
      <section class="card rounded-xl p-3 space-y-2 ${gente.length === 0 ? 'border-red-400/40' : ''}">
        <div class="flex items-center justify-between gap-2">
          <p class="font-display truncate">${escape(titulo)}</p>
          ${boton}
        </div>
        ${gente.length === 0
    ? `<p class="text-[11px] text-red-300">${escape(t('roster.nobody'))}</p>`
    : gente.map(persona).join('')}
      </section>`;

    $('roster-body').innerHTML = [
      ...porDestino.sections.map((z) => bloque(z.section, z.people,
        `<button class="chip tap px-3 shrink-0" data-add-section="${escape(z.section)}">+</button>`)),
      ...porDestino.bars.map((b) => bloque(b.name, b.people,
        `<button class="chip tap px-3 shrink-0" data-add-bar="${escape(b.location_id)}"
                 data-bar-name="${escape(b.name)}">+</button>`)),
    ].join('');

    for (const boton of $('roster-body').querySelectorAll('[data-add-section]')) {
      boton.onclick = () => openPick({ section: boton.dataset.addSection });
    }
    for (const boton of $('roster-body').querySelectorAll('[data-add-bar]')) {
      boton.onclick = () => openPick({
        locationId: boton.dataset.addBar, name: boton.dataset.barName,
      });
    }
    for (const boton of $('roster-body').querySelectorAll('[data-unassign]')) {
      boton.onclick = async () => {
        try {
          await api.del(`/nightclubs/${clubId()}/roster/${boton.dataset.unassign}`);
          await reloadRoster();
        } catch (err) { showError(err, $('roster-error')); }
      };
    }
  }

  /** Las barras sin repetir, que llegan por dos caminos (huecos y asignadas). */
  function dedupeBars(bars) {
    const porId = new Map();
    for (const bar of bars) if (bar && bar.location_id) porId.set(bar.location_id, bar);
    return [...porId.values()];
  }

  $('btn-roster-close').onclick = closeRoster;

  // -------------------------------------------------------- elegir a quién poner

  function openPick(destino) {
    state.pick = destino;
    const r = state.roster;
    if (!r) return;
    $('pick-where').textContent = destino.section || destino.name;

    // Solo los candidatos del puesto que ESE destino necesita: ofrecer un mesero
    // para una barra es ofrecer un error.
    const quiere = destino.section ? 'section' : 'location';
    const gente = EV2Roster.candidates(state.staff)
      .filter((p) => EV2Roster.ruleFor(p.role).target === quiere);

    $('pick-list').innerHTML = gente.map((p) => {
      const problema = EV2Roster.check({
        person: p,
        section: destino.section || null,
        locationId: destino.locationId || null,
        roster: r.roster,
      });
      const bloqueado = problema !== null;
      return `
        <button type="button" class="card rounded-xl p-3 w-full text-left ${bloqueado ? 'opacity-50' : ''}"
                data-pick="${escape(p.id)}" ${bloqueado ? 'disabled' : ''}>
          <p class="text-sm font-semibold truncate">${escape(p.display_name || '')}</p>
          <p class="text-[11px] text-white/40">
            ${escape(EV2Roles.describe(p.role, lang()).label)}
            ${bloqueado ? ` · ${escape(pickProblemText(problema))}` : ''}
          </p>
        </button>`;
    }).join('');

    $('pick-empty').textContent = gente.length === 0 ? t('roster.noCandidates') : '';
    $('pick-empty').hidden = gente.length > 0;

    for (const boton of $('pick-list').querySelectorAll('[data-pick]')) {
      boton.onclick = () => assignPicked(boton.dataset.pick);
    }
    $('pick-backdrop').hidden = false;
    $('pick-sheet').hidden = false;
  }

  function pickProblemText(problem) {
    const clave = `roster.err.${problem.code}`;
    const texto = problem.code === 'only_one_bar'
      ? t(clave, { name: problem.name, bar: problem.current || '—' })
      : t(clave, { name: problem.name || '' });
    return texto === clave ? t('roster.err.generic') : texto;
  }

  function closePick() {
    state.pick = null;
    $('pick-sheet').hidden = true;
    $('pick-backdrop').hidden = true;
  }

  $('pick-close').onclick = closePick;
  $('pick-backdrop').onclick = closePick;

  async function assignPicked(userId) {
    const destino = state.pick;
    const r = state.roster;
    if (!destino || !r) return;
    try {
      await api.post(`/nightclubs/${clubId()}/nights/${r.night.id}/roster`,
        EV2Roster.assignBody({
          userId, section: destino.section || null, locationId: destino.locationId || null,
        }));
      closePick();
      await reloadRoster();
    } catch (err) {
      closePick();
      showError(err, $('roster-error'));
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
    closes_at: 'n-closes', ticket_price: 'n-price', deposit_pct: 'n-deposit',
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
      // Vacio se manda como vacio, no como cero: `nightPayload` decide que eso
      // significa "usa el anticipo del club" y ni siquiera manda el campo.
      deposit_pct: $('n-deposit').value,
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
      $('n-deposit').value = '';
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
    // Nunca se pisa lo que el gerente está escribiendo: un refresco del socket mientras
    // redacta el código de conducta le borraría el párrafo a medias.
    if (document.activeElement !== $('taxi-ttl')) $('taxi-ttl').value = s.certificate_ttl_minutes || '';
    if (document.activeElement !== $('taxi-conduct-terms')) {
      $('taxi-conduct-terms').value = s.conduct_terms || '';
    }

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
    if (!held) return;
    $('secret-who').textContent = held.who;
    // Cada renglón sale solo si hay algo que enseñar: el personal de piso recibe PIN y
    // nada más, y un recuadro con "Contraseña temporal: —" invita a buscarla.
    $('secret-pin-row').hidden = !held.pin;
    if (held.pin) $('secret-pin').textContent = held.pin;
    $('secret-password-row').hidden = !held.password;
    if (held.password) $('secret-value').textContent = held.password;
    $('secret-both').hidden = !(held.pin && held.password);
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
      const ttl = Number($('taxi-ttl').value);
      if (Number.isFinite(ttl) && ttl > 0) body.certificate_ttl_minutes = Math.round(ttl);
      // Se manda SIEMPRE, incluso vacío: es la única forma de borrar el texto, y sin
      // eso un club no podría quitar unas reglas que ya no aplica.
      body.conduct_terms = $('taxi-conduct-terms').value.trim() || null;
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


  // ---------------------------------------------------------------- inventario
  //
  // Lo que el gerente necesita y la pantalla de almacen no da: cuanto vale lo que hay,
  // que producto se vende con poco margen, y el editor de recetas -- que hasta ahora
  // solo existia como ruta de la API, o sea que corregir una receta requeria un curl.

  function renderInventory() {
    if (!$('tab-inventory')) return;
    if (!state.invLoaded) {
      for (const id of ['inv-value', 'inv-low', 'inv-norecipe']) $(id).textContent = '—';
      $('inv-unconfirmed').hidden = true;
      $('inv-list').innerHTML = '';
      $('inv-empty').textContent = t('inv.loading');
      $('inv-empty').hidden = false;
      return;
    }
    const value = EV2Warehouse.inventoryValue(state.supplies);
    $('inv-value').textContent = money(value.total, 'MXN');
    $('inv-low').textContent = state.supplies.filter((x) => x.low).length;
    $('inv-norecipe').textContent = state.recipes.filter((r) => (r.items || []).length === 0).length;

    const sinConfirmar = state.supplies.filter((x) => x.size_confirmed === false).length;
    $('inv-unconfirmed').hidden = sinConfirmar === 0;
    $('inv-unconfirmed-n').textContent = sinConfirmar;

    for (const b of document.querySelectorAll('[data-inv]')) {
      b.classList.toggle('on', b.dataset.inv === state.invView);
    }

    if (state.invView === 'recipes') return renderRecipeList();
    if (state.invView === 'kardex') return renderKardex();
    return renderStockList();
  }

  function invEmpty(message) {
    $('inv-list').innerHTML = '';
    $('inv-empty').textContent = message;
    $('inv-empty').hidden = false;
  }

  const invMatches = (text) => !state.invSearch
    || String(text || '').toLowerCase().includes(state.invSearch);

  /** Existencias: el total del club y el desglose por estante, en presentaciones. */
  function renderStockList() {
    const list = state.supplies.filter((x) => invMatches(x.name) || invMatches(x.category));
    if (list.length === 0) return invEmpty(t('inv.emptyStock'));
    $('inv-empty').hidden = true;

    $('inv-list').innerHTML = EV2Warehouse.byCategory(list).map((group) => `
      <section class="mb-3">
        <h3 class="text-xs uppercase tracking-widest text-white/40 mb-1 px-1">${escape(group.category)}</h3>
        <div class="space-y-2">
          ${group.items.map((supply) => `
            <article class="card rounded-xl px-3 py-2 ${supply.low ? 'border-l-4 border-amber-400' : ''}">
              <div class="flex items-start justify-between gap-2">
                <div class="min-w-0">
                  <p class="text-sm font-semibold truncate">${escape(supply.name)}
                    ${supply.size_confirmed === false ? `<span class="text-pink-300 text-[11px]">· ${escape(t('inv.confirmSize'))}</span>` : ''}</p>
                  <p class="text-xs text-white/60">${escape(EV2Warehouse.describeStock(supply, supply.stock, lang()))}</p>
                  <p class="text-[11px] text-white/40">${(supply.locations || []).map((l) => `${escape(l.name)}: <b>${EV2Warehouse.packagesOf(l.stock, supply.package_size)}</b>`).join(' · ') || escape(t('inv.noStock'))}</p>
                </div>
                <div class="text-right shrink-0">
                  <p class="text-sm">${escape(money(supply.stock_value, 'MXN'))}</p>
                  <p class="text-[11px] text-white/40">${escape(t('inv.atCost'))}</p>
                  <button class="chip tap px-2 mt-1" data-min="${escape(supply.id)}">${escape(t('inv.setMin'))}</button>
                </div>
              </div>
            </article>`).join('')}
        </div>
      </section>`).join('');

    for (const button of $('inv-list').querySelectorAll('[data-min]')) {
      button.onclick = () => setMinimum(button.dataset.min);
    }
  }

  /**
   * El minimo por estante.
   *
   * Se pregunta en presentaciones porque es como se piensa ("surte cuando baje de dos
   * botellas"), y se manda en unidad base, que es lo que entiende el inventario.
   */
  async function setMinimum(supplyId) {
    const supply = state.supplies.find((x) => x.id === supplyId);
    if (!supply) return;
    const bars = state.locations.filter((l) => l.kind === 'bar' || l.kind === 'warehouse');
    if (bars.length === 0) return;
    const nombres = bars.map((b, i) => `${i + 1}) ${b.name}`).join('  ');
    const cual = window.prompt(t('inv.askPlace', { list: nombres }), '1');
    const place = bars[Number(cual) - 1];
    if (!place) return;
    const actual = (supply.locations || []).find((l) => l.location_id === place.id);
    const previo = actual ? EV2Warehouse.packagesOf(actual.min_stock, supply.package_size) : 0;
    const raw = window.prompt(t('inv.askMin', { name: supply.name, place: place.name }), String(previo));
    if (raw === null) return;
    const packages = Number(raw);
    if (!Number.isFinite(packages) || packages < 0) { toast(t('inv.badMin'), 'error'); return; }
    try {
      const { supply: updated } = await api.put(
        `/nightclubs/${clubId()}/supplies/${supplyId}/min-stock`,
        { location_id: place.id, min_stock: packages * Number(supply.package_size) });
      state.supplies = state.supplies.map((x) => (x.id === updated.id ? updated : x));
      toast(t('inv.minSaved'), 'ok');
      renderInventory();
    } catch (err) { showError(err); }
  }

  /** Recetas: primero lo que no tiene, despues lo de menor margen. */
  function renderRecipeList() {
    const list = EV2Manager.sortRecipes(state.recipes, { search: state.invSearch });
    if (list.length === 0) return invEmpty(t('inv.emptyRecipes'));
    $('inv-empty').hidden = true;

    $('inv-list').innerHTML = list.map((r) => {
      const sin = (r.items || []).length === 0;
      const m = r.margin;
      return `
      <article class="card rounded-xl px-3 py-2 ${sin ? 'border-l-4 border-red-400' : ''}"
               data-recipe="${escape(r.drink_id)}">
        <div class="flex items-start justify-between gap-2">
          <div class="min-w-0">
            <p class="text-sm font-semibold truncate">${escape(r.name)}</p>
            <p class="text-xs text-white/60">
              ${sin ? escape(t('inv.withoutRecipe'))
                : escape((r.items || []).map((i) => `${i.quantity} ${i.unit} ${i.name}`).join(' + '))}
            </p>
          </div>
          <div class="text-right shrink-0">
            <p class="text-sm">${escape(money(r.price, 'MXN'))}</p>
            <p class="text-[11px] ${m.pct === null ? 'text-white/40' : (m.pct < 50 ? 'text-amber-300' : 'text-emerald-300')}">
              ${m.pct === null ? escape(t('inv.noCost')) : `${escape(money(m.cost, 'MXN'))} · ${m.pct}%`}
            </p>
          </div>
        </div>
      </article>`;
    }).join('');

    for (const el of $('inv-list').querySelectorAll('[data-recipe]')) {
      el.onclick = () => openRecipe(el.dataset.recipe);
    }
  }

  /** Los ultimos movimientos, de solo lectura: el detalle se opera en almacen.html. */
  function renderKardex() {
    const list = state.movements.filter((m) => invMatches(m.supply_name) || invMatches(m.reason));
    if (list.length === 0) return invEmpty(t('inv.emptyKardex'));
    $('inv-empty').hidden = true;
    $('inv-list').innerHTML = list.map((m) => {
      const signo = Number(m.quantity) > 0 ? '+' : '';
      const color = Number(m.quantity) > 0 ? 'text-emerald-300' : 'text-red-300';
      const otro = m.counterpart_name ? ` ${m.kind === 'transfer_in' ? '←' : '→'} ${escape(m.counterpart_name)}` : '';
      return `
      <article class="card rounded-xl px-3 py-2">
        <div class="flex items-start justify-between gap-2">
          <div class="min-w-0">
            <p class="text-sm truncate">${escape(m.supply_name)}</p>
            <p class="text-xs text-white/60">${escape(t(`wh.kind.${m.kind}`))} · ${escape(m.location_name)}${otro}</p>
            <p class="text-[11px] text-white/40">${escape(EV2Format.dateTime(m.created_at))}${m.created_by_name ? ` · ${escape(m.created_by_name)}` : ''}${m.reason ? ` · ${escape(m.reason)}` : ''}</p>
          </div>
          <p class="${color} text-sm shrink-0">${signo}${Number(m.quantity)} ${escape(m.unit)}</p>
        </div>
      </article>`;
    }).join('');
  }

  // ------------------------------------------------------- editor de receta

  function openRecipe(drinkId) {
    const r = state.recipes.find((x) => x.drink_id === drinkId);
    if (!r) return;
    state.recipe = {
      drink_id: r.drink_id,
      name: r.name,
      price: r.price,
      lines: (r.items || []).map((i) => ({ supply_id: i.supply_id, quantity: Number(i.quantity) })),
    };
    $('recipe-error').hidden = true;
    $('recipe-qty').value = '';
    renderRecipeSheet();
    $('recipe-sheet').hidden = false;
  }

  function closeRecipe() {
    state.recipe = null;
    $('recipe-sheet').hidden = true;
  }

  const supplyById = (id) => state.supplies.find((x) => x.id === id) || null;

  function renderRecipeSheet() {
    const r = state.recipe;
    if (!r) return;
    $('recipe-title').textContent = r.name;
    $('recipe-note').textContent = t('inv.recipeNote', { price: money(r.price, 'MXN') });

    $('recipe-lines').innerHTML = r.lines.length === 0
      ? `<p class="text-center text-white/40 text-sm py-8">${escape(t('inv.recipeEmpty'))}</p>`
      : r.lines.map((line, index) => {
        const supply = supplyById(line.supply_id);
        const costo = supply ? Number(supply.avg_cost) * Number(line.quantity) : 0;
        return `
        <div class="card rounded-xl px-3 py-2 flex items-center justify-between gap-2" data-line="${index}">
          <div class="min-w-0">
            <p class="text-sm truncate">${escape(supply ? supply.name : line.supply_id)}</p>
            <p class="text-xs text-white/50">${line.quantity} ${escape(supply ? supply.unit : '')} · ${escape(money(costo, 'MXN'))}</p>
          </div>
          <button class="card rounded-lg px-3 text-red-300 text-sm shrink-0" data-drop="${index}">✕</button>
        </div>`;
      }).join('');

    // Solo insumos activos y que no esten ya en la receta: repetir uno la invalida.
    const usados = new Set(r.lines.map((l) => l.supply_id));
    $('recipe-supply').innerHTML = state.supplies
      .filter((x) => x.active !== false && !usados.has(x.id))
      .map((x) => `<option value="${escape(x.id)}">${escape(x.name)} (${escape(x.unit)})</option>`)
      .join('');

    const costo = r.lines.reduce((sum, l) => {
      const supply = supplyById(l.supply_id);
      return sum + (supply ? Number(supply.avg_cost) * Number(l.quantity) : 0);
    }, 0);
    const m = EV2Manager.recipeMargin({ price: r.price, cost: costo });
    $('recipe-cost').textContent = m.pct === null
      ? t('inv.noCostYet')
      : t('inv.marginLine', { cost: money(m.cost, 'MXN'), profit: money(m.profit, 'MXN'), pct: m.pct });

    for (const button of $('recipe-lines').querySelectorAll('[data-drop]')) {
      button.onclick = () => {
        r.lines.splice(Number(button.dataset.drop), 1);
        renderRecipeSheet();
      };
    }
  }

  function addRecipeLine() {
    const r = state.recipe;
    if (!r) return;
    const supplyId = $('recipe-supply').value;
    const quantity = Number($('recipe-qty').value);
    if (!supplyId) { recipeError('inv.err.no_supply'); return; }
    if (!(quantity > 0)) { recipeError('inv.err.bad_quantity'); return; }
    r.lines.push({ supply_id: supplyId, quantity });
    $('recipe-qty').value = '';
    recipeError(null);
    renderRecipeSheet();
  }

  function recipeError(key) {
    const el = $('recipe-error');
    if (!key) { el.hidden = true; return; }
    el.textContent = t(key);
    el.hidden = false;
  }

  async function saveRecipe() {
    const r = state.recipe;
    if (!r) return;
    const problem = EV2Manager.validateRecipe(r.lines);
    if (problem) { recipeError(`inv.err.${problem}`); return; }
    try {
      await api.put(`/nightclubs/${clubId()}/recipes/${r.drink_id}`,
        EV2Manager.recipePayload(r.lines));
      // Se vuelve a pedir la lista: el costo y el margen los calcula el servidor con el
      // costo promedio de cada insumo, y recalcularlos aqui seria inventar el numero.
      const d = await api.get(`/nightclubs/${clubId()}/recipes`);
      state.recipes = d.recipes || [];
      toast(r.lines.length === 0 ? t('inv.recipeCleared') : t('inv.recipeSaved'), 'ok');
      closeRecipe();
      renderInventory();
    } catch (err) { showError(err, $('recipe-error')); }
  }

  for (const b of document.querySelectorAll('[data-inv]')) {
    b.onclick = () => {
      state.invView = b.dataset.inv;
      // La busqueda se limpia al cambiar de vista: "BUCHANANS" busca un producto en
      // recetas y un insumo en existencias, y arrastrarla entre las dos deja la lista
      // vacia sin que se vea por que.
      state.invSearch = '';
      if ($('inv-search')) $('inv-search').value = '';
      renderInventory();
    };
  }
  if ($('inv-search')) {
    $('inv-search').oninput = (ev) => {
      state.invSearch = ev.target.value.trim().toLowerCase();
      renderInventory();
    };
  }
  if ($('btn-recipe-close')) $('btn-recipe-close').onclick = closeRecipe;
  if ($('btn-recipe-add')) $('btn-recipe-add').onclick = addRecipeLine;
  if ($('btn-recipe-save')) $('btn-recipe-save').onclick = saveRecipe;

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
    // Un reporte no espera al refresco general de cuatro segundos: puede ser "parece
    // menor de edad", que es lo único de esta lista capaz de cerrarle el club.
    rt.on('event', async (message) => {
      if (!EV2Manager.affectsModeration(message)) return;
      await loadReports();
      renderReports();
      toast(t('mod.arrived'), 'error');
    });

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
