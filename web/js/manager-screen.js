/**
 * EV2 — panel del gerente (paso 5.5).
 *
 * Conecta el DOM con `EV2` (API y socket), `EV2Manager` (los números y las validaciones)
 * y `EV2Roles`. Cubre lo que el dueño dejó para configurar después: conductores, zonas y
 * tarifas del taxi, y los cajones del estacionamiento — más el resumen del turno.
 */
/* global EV2Push, EV2, EV2Format, EV2Manager, EV2Warehouse, EV2Roles, EV2PasswordGate, EV2StaffAdmin,
   EV2Payouts, EV2NightReport, EV2Roster, EV2Clock */
(function () {
  'use strict';
  // Preguntas con el cuadro de la app (js/ui.js), no con el confirm() del navegador.
  const ask = (text, opts) => (typeof window !== 'undefined' && window.EV2UI
    ? window.EV2UI.confirm(text, opts) : Promise.resolve(window.confirm(text)));
  const askText = (text, value) => (typeof window !== 'undefined' && window.EV2UI
    ? window.EV2UI.prompt(text, { value }) : Promise.resolve(window.prompt(text, value == null ? '' : value)));


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
    cashDrops: [], shiftCuts: [], tips: [], drinks: [], lostFound: [],
    // El catálogo de covers del club. Vacío significa que la puerta todavía teclea el
    // precio; en cuanto tiene uno, el servidor deja de aceptar importes sueltos.
    covers: [],
    // Inventario: lo que el gerente mira, no lo que el almacen opera.
    supplies: [], locations: [], recipes: [], movements: [],
    // Hasta que el inventario llegue de la API, la pestana NO pinta ceros: un
    // "MX$0.00" mientras carga no es "cargando", es un dato falso, y el gerente que
    // lo alcanza a leer se lleva la idea de que la bodega esta vacia.
    invLoaded: false,
    invView: 'stock', invSearch: '', invFilter: 'all', invAddOpen: false,
    staffSearch: '', staffRole: null,
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

  // Las impresoras del club, las PCs que imprimen por él y lo último que se mandó a
  // papel (D52). `staleMinutes` lo dice el servidor: es el mismo umbral con el que
  // decide que una PC se murió con un trabajo en la mano.
  const printing = {
    printers: [], agents: [], jobs: [], settings: null, staleMinutes: 2, health: [], zones: [],
    // La búsqueda de impresoras (D55). `scanUntil` es hasta cuándo se sigue
    // preguntando por el resultado: el que busca es el agente, en el club, y tarda.
    scanUntil: 0,
    // El código de emparejamiento que está en pantalla ahora (D56), y hasta cuándo
    // se espera a que alguien lo teclee en la otra PC.
    invite: null, pairUntil: 0,
  };

  const t = (key, vars) => (vars ? EV2Format.tf(key, vars) : EV2Format.t(key));
  const lang = () => EV2Format.getLanguage();
  const money = (amount, currency) => EV2Format.money(amount, currency || state.currency);
  const escape = (s) => String(s == null ? '' : s).replace(/[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /** El nombre de cada propósito de impresora. `till` es la caja de una barra (D79). */
  const PURPOSE_KEY = { orders: 'prn.pOrders', service: 'prn.pService', till: 'prn.pTill' };

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
    // El teléfono deja de recibir los avisos de esta persona (D90); va antes del logout.
    await EV2Push.forget(api);
    await api.logout();
    // Al inicio, no al login de este rol: desde ahí entra cualquiera y el inicio lo
    // manda a su pantalla.
    location.replace('index.html');
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
    // Notificaciones al teléfono (D90): ofrecerlas, o volver a registrar este teléfono.
    EV2Push.start({ api, box: $('push-box'), toast });
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
      loadExchangeRate(),
      loadTills(),
      loadTerminalCharges(),
      loadTips(),
      loadLostFound(),
      loadShiftCuts(),
      loadPrinting(),
      loadClock(),
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
      // La carta completa, incluidos los tragos apagados: apagar uno es lo que lo
      // quita del menú del cliente, así que hay que poder verlo para volver a prenderlo.
      get(`/nightclubs/${club}/drinks`, (d) => { state.drinks = d.drinks || []; }),
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

  // Cada sección del menú y los bloques que enseña (D88). "Salida segura" junta a los
  // conductores y las tarifas, que eran dos secciones para una misma cosa.
  const TAB_PANELS = {
    summary: ['tab-summary'],
    cash: ['tab-cash'],
    lost: ['tab-lost'],
    reports: ['tab-reports'],
    nights: ['tab-nights'],
    staff: ['tab-staff'],
    inventory: ['tab-inventory'],
    payouts: ['tab-payouts'],
    club: ['tab-club'],
    exit: ['tab-drivers', 'tab-taxi'],
    parking: ['tab-parking'],
    printing: ['tab-printing'],
    clock: ['tab-clock'],
  };
  // Los nombres viejos siguen sirviendo (un enlace o un pendiente guardado).
  const TAB_ALIAS = { drivers: 'exit', taxi: 'exit' };

  function renderAll() {
    if (!TAB_PANELS[state.tab]) state.tab = TAB_ALIAS[state.tab] || 'summary';
    const visibles = new Set(TAB_PANELS[state.tab]);
    for (const panels of Object.values(TAB_PANELS)) {
      for (const id of panels) if ($(id)) $(id).hidden = !visibles.has(id);
    }
    document.querySelectorAll('[data-tab]').forEach((b) => {
      b.classList.toggle('active', b.dataset.tab === state.tab);
    });
    renderSummary();
    renderInbox();
    renderNights();
    renderStaff();
    renderPayouts();
    renderReports();
    renderCoverQuick();
    renderDrivers();
    renderTaxi();
    renderParking();
    renderInventory();
    renderPrinting();
    renderClock();
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
      cambiar.onclick = async () => {
        // Cambiar el precio NO toca lo ya vendido: cada entrada guarda el suyo.
        const dicho = (await askText(t('cover.newAmount', { name: cover.name }), cover.amount));
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
    renderInbox();
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
    if (status === 'actioned' && !(await ask(t('mod.confirmActioned')))) return;
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

  // Fichas abiertas. Vive fuera de renderStaff porque la lista se vuelve a pintar cada
  // vez que llegan datos, y la ficha que el gerente está leyendo no debe cerrarse sola.
  const openStaff = new Set();

  /** Un dato de la ficha, ya listo para leerse. Lo que falta se ve como "—". */
  function staffDetailValue(row) {
    if (row.value === null || row.value === undefined || row.value === '') return '—';
    switch (row.type) {
      case 'role': return EV2Roles.describe(row.value, lang()).label;
      case 'status': return t(row.value);
      case 'country': {
        const key = `staff.country${row.value}`;
        const label = t(key);
        return label && label !== key ? label : row.value;
      }
      case 'date': {
        // Solo el día, leído en UTC: en Hermosillo la medianoche UTC todavía es "ayer".
        const d = new Date(`${row.value}T00:00:00Z`);
        if (Number.isNaN(d.getTime())) return '—';
        return new Intl.DateTimeFormat(EV2Format.locale(), { dateStyle: 'medium', timeZone: 'UTC' })
          .format(d);
      }
      case 'datetime': return EV2Format.dateTime(row.value);
      default: return String(row.value);
    }
  }

  function staffDetail(person) {
    const box = document.createElement('dl');
    box.className = 'grid grid-cols-[auto,1fr] gap-x-3 gap-y-1 text-sm pt-2 border-t border-white/10';
    for (const row of EV2StaffAdmin.detailsFor(person)) {
      const dt = document.createElement('dt');
      dt.className = 'text-white/40';
      dt.textContent = t(row.key);
      const dd = document.createElement('dd');
      dd.className = 'min-w-0 break-words';
      const shown = staffDetailValue(row);
      if (row.type === 'phone' && shown !== '—') {
        // Un toque y se marca: es para lo que el gerente vino a buscar el número.
        const a = document.createElement('a');
        a.href = `tel:${row.value.replace(/[^\d+]/g, '')}`;
        a.className = 'underline';
        a.textContent = shown;
        a.onclick = (e) => e.stopPropagation();
        dd.appendChild(a);
      } else {
        dd.textContent = shown;
      }
      box.append(dt, dd);
    }
    return box;
  }

  function renderStaff() {
    const counts = EV2StaffAdmin.counts(state.staff);
    $('st-onshift').textContent = String(counts.onShift);
    $('st-active').textContent = String(counts.active);
    $('st-inactive').textContent = String(counts.inactive);

    // El filtro de puesto se arma con los puestos que de verdad hay.
    const roles = [...new Set((state.staff || []).map((p) => p.role))];
    const sel = $('staff-role');
    if (sel && sel.dataset.roles !== roles.join(',')) {
      const antes = sel.value;
      sel.innerHTML = `<option value="">${escape(t('staff.allRoles'))}</option>`
        + roles.map((r) => `<option value="${escape(r)}">${escape(EV2Roles.describe(r, lang()).label)}</option>`).join('');
      sel.dataset.roles = roles.join(',');
      sel.value = roles.includes(antes) ? antes : '';
    }
    const q = String(state.staffSearch || '').trim().toLowerCase();
    const todos = EV2StaffAdmin.sortStaff(state.staff);
    const list = todos.filter((p) => (!state.staffRole || p.role === state.staffRole)
      && (!q || [p.display_name, p.first_name, p.last_name, p.email]
        .some((v) => String(v || '').toLowerCase().includes(q))));
    $('staff-empty').hidden = todos.length > 0;
    if ($('staff-nomatch')) $('staff-nomatch').hidden = !(todos.length > 0 && list.length === 0);
    const box = $('staff-list');
    box.innerHTML = '';

    for (const person of list) {
      const actions = EV2StaffAdmin.actionsFor(person);
      const names = EV2StaffAdmin.displayFor(person);
      const card = document.createElement('div');
      card.className = 'card rounded-xl px-3 py-2.5 space-y-2 cursor-pointer';
      if (person.active === false) card.style.opacity = '.55';
      const isOpen = openStaff.has(person.id);
      card.setAttribute('role', 'button');
      card.tabIndex = 0;
      card.setAttribute('aria-expanded', String(isOpen));
      card.title = t('staff.detailHint');
      const toggle = () => {
        if (openStaff.has(person.id)) openStaff.delete(person.id);
        else openStaff.add(person.id);
        renderStaff();
      };
      card.onclick = toggle;
      card.onkeydown = (e) => {
        if (e.target !== card) return;
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
      };

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
      status.className = 'text-xs shrink-0 flex items-center gap-2';
      status.style.color = person.on_shift ? 'var(--ev2-lime)'
        : person.active === false ? 'rgba(255,255,255,.4)' : 'rgba(255,255,255,.6)';
      status.textContent = t(EV2StaffAdmin.statusOf(person));
      // Las acciones (contraseña, PIN, baja) viven dentro de la ficha (D88): se abren con
      // un toque. Antes eran tres botones grandes en cada persona.
      const more = document.createElement('i');
      more.className = `fa-solid ${isOpen ? 'fa-xmark' : 'fa-bars'} text-white/40`;
      status.appendChild(more);
      head.append(left, status);
      card.appendChild(head);

      const row = document.createElement('div');
      row.className = 'flex gap-2 flex-wrap';
      const add = (label, cls, fn) => {
        const b = document.createElement('button');
        b.className = cls;
        b.textContent = t(label);
        // Los botones hacen su trabajo sin abrir ni cerrar la ficha.
        b.onclick = (e) => { e.stopPropagation(); fn(b); };
        row.appendChild(b);
      };
      if (actions.canResetPassword) {
        add('staff.resetPassword', 'card rounded-lg px-3 py-2 text-sm flex-1', async (b) => {
          if (!(await ask(t('staff.confirmReset')))) return;
          patchEmployee(person, { reset_password: true }, 'staff.tempPassword', b);
        });
      }
      if (actions.canResetPin) {
        // Asignar el primero y reiniciar el que ya existe son dos actos distintos, y
        // solo el segundo deja a alguien fuera a media noche. El botón y la pregunta
        // cambian con eso.
        const clave = actions.hasPin ? 'staff.resetPin' : 'staff.assignPin';
        const pregunta = actions.hasPin ? 'staff.confirmResetPin' : 'staff.confirmAssignPin';
        add(clave, 'card rounded-lg px-3 py-2 text-sm flex-1', async (b) => {
          if (!(await ask(t(pregunta)))) return;
          patchEmployee(person, { reset_pin: true }, 'staff.tempPin', b);
        });
      }
      if (actions.canDeactivate) {
        add('staff.deactivate', 'card rounded-lg px-3 py-2 text-sm text-red-300', async (b) => {
          if (!(await ask(t('staff.confirmDeactivate'), { danger: true }))) return;
          patchEmployee(person, { active: false }, 'staff.deactivated', b);
        });
      }
      if (actions.canReactivate) {
        add('staff.reactivate', 'ev2-button rounded-lg px-3 py-2 text-sm flex-1',
          (b) => patchEmployee(person, { active: true }, 'staff.reactivated', b));
      }
      if (isOpen) card.appendChild(staffDetail(person));
      if (isOpen && row.children.length) card.appendChild(row);
      box.appendChild(card);
    }
  }

  if ($('staff-search')) $('staff-search').oninput = (e) => { state.staffSearch = e.target.value; renderStaff(); };
  if ($('staff-role')) $('staff-role').onchange = (e) => { state.staffRole = e.target.value || null; renderStaff(); };

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
  // ---------------------------------------------------------------- las cajas de la noche (D88)

  async function loadTills() {
    try {
      const data = await api.get(`/nightclubs/${clubId()}/tills`);
      state.tills = data.tills || [];
    } catch { state.tills = []; }
    renderTills();
  }

  const TONE_PILL = { ok: 'pill-ok', bad: 'pill-bad', wait: 'pill-wait', on: 'pill-on' };

  function tillCard(c) {
    const st = EV2Manager.tillState(c);
    const usd = Number(c.usd_received) > 0
      ? `<div class="flex justify-between text-xs"><span class="text-white/50">${escape(t('mgr.tillUsd'))}</span><span>US$${escape(Number(c.usd_to_hand).toFixed(2))}</span></div>` : '';
    const dif = c.closed && Number(c.difference || 0) !== 0
      ? `<p class="text-xs text-red-300">${escape(t('mgr.tillDiff', { amount: money(Math.abs(Number(c.difference)), c.currency) }))}</p>` : '';
    return `
      <div class="rounded-xl p-3 space-y-1.5" style="background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08)">
        <div class="flex items-start justify-between gap-2">
          <div class="min-w-0">
            <p class="font-semibold truncate">${escape(c.location_name)}</p>
            <p class="text-xs text-white/50 truncate">${escape(c.user_name || '')}</p>
          </div>
          <span class="pill ${TONE_PILL[st.tone] || 'pill-off'} shrink-0">${escape(t(st.key, { n: c.pending_orders }))}</span>
        </div>
        <div class="flex justify-between text-xs"><span class="text-white/50">${escape(t('mgr.tillCollected'))}</span><span>${escape(money(c.collected, c.currency))}</span></div>
        <div class="flex justify-between text-sm"><span class="text-white/60">${escape(t('mgr.tillToHand'))}</span><span class="font-semibold">${escape(money(c.cash_to_hand, c.currency))}</span></div>
        ${usd}${dif}
      </div>`;
  }

  function renderTills() {
    const list = state.tills || [];
    for (const [box, empty] of [['s-tills', 's-tills-empty'], ['c-tills', 'c-tills-empty']]) {
      if (!$(box)) continue;
      $(box).innerHTML = list.map(tillCard).join('');
      $(empty).hidden = list.length > 0;
    }
  }

  function renderTonight() {
    const hoy = EV2Manager.tonightNight(state.nights, new Date());
    $('s-night').hidden = !hoy;
    $('s-no-night').hidden = Boolean(hoy);
    if (!hoy) return;
    const n = hoy.night;
    $('s-night-when').textContent = t(hoy.live ? 'mgr.nightLive' : 'mgr.nightToday');
    $('s-night-name').textContent = n.name || '';
    const partes = [EV2Format.dateTime(n.doors_open_at)];
    if (Number(n.ticket_price) > 0) partes.push(t('mgr.nightCover', { amount: money(n.ticket_price, n.currency) }));
    if (n.reservations_count != null) {
      const c = Number(n.reservations_count);
      partes.push(c === 1 ? t('mgr.nightBooking1') : t('mgr.nightBookings', { n: c }));
    }
    $('s-night-info').textContent = partes.join(' · ');
  }

  $('s-night-go').onclick = () => goTab('nights');
  $('s-tills-go').onclick = () => goTab('cash');

  // ---------------------------------------------------------------- tipo de cambio (D86)

  async function loadExchangeRate() {
    try {
      const data = await api.get(`/nightclubs/${clubId()}/exchange-rate`);
      state.fx = { current: data.current || null, history: data.history || [] };
    } catch { state.fx = { current: null, history: [] }; }
    renderExchangeRate();
  }

  function renderExchangeRate() {
    const fx = state.fx || { current: null, history: [] };
    const actual = fx.current;
    $('fx-current').textContent = actual ? `$${Number(actual.rate).toFixed(2)}` : '—';
    $('fx-none').hidden = Boolean(actual);
    const ultimo = fx.history[0];
    $('fx-since').textContent = actual
      ? t('fx.since', {
        when: EV2Format.dateTime(actual.effective_from),
        who: (ultimo && String(ultimo.id) === String(actual.id) && ultimo.set_by_name) || '—',
      })
      : '';
    $('fx-history').innerHTML = fx.history.length
      ? fx.history.map((r) => `
        <div class="flex justify-between text-xs">
          <span class="text-white/50">${escape(EV2Format.dateTime(r.effective_from))} · ${escape(r.set_by_name || '—')}</span>
          <span>$${escape(Number(r.rate).toFixed(2))}</span>
        </div>`).join('')
      : `<p class="text-xs text-white/40">${escape(t('fx.noHistory'))}</p>`;
  }

  $('btn-fx-save').onclick = async () => {
    const valor = Number($('fx-rate').value);
    const error = $('fx-error');
    error.hidden = true;
    // Un tipo de cambio fuera de rango es casi siempre un dedazo (175 en vez de 17.5):
    // se para aquí, y el servidor lo vuelve a revisar.
    if (!(valor >= 1 && valor <= 1000)) {
      avisar(error, t('fx.errRate'));
      return;
    }
    const actual = state.fx && state.fx.current;
    if (!(await ask(t('fx.confirm', {
      from: actual ? `$${Number(actual.rate).toFixed(2)}` : '—',
      to: `$${valor.toFixed(2)}`,
    })))) return;
    const listo = ocupado($('btn-fx-save'), 'fx.saving');
    try {
      await api.put(`/nightclubs/${clubId()}/exchange-rate`, { rate: valor });
      $('fx-rate').value = '';
      toast(t('fx.saved', { rate: `$${valor.toFixed(2)}` }), 'ok');
      await loadExchangeRate();
    } catch (err) {
      avisar(error, EV2Format.errorMessage(err));
    } finally { listo(); }
  };

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
    const motivo = (await askText(t('tch.reason', { amount: total }), ''));
    if (motivo === null) return;
    if (motivo.trim().length < 5) { avisar(nota, t('tch.errReason')); return; }
    const tarjeta = c.card ? c.card.brand : '';
    if (!(await ask(t('tch.confirm', { amount: total, card: tarjeta })))) return;

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

  // ---------------------------------------------------------------- objetos perdidos (D67)

  /**
   * Lo perdido y lo encontrado, en una sola lista.
   *
   * Juntos y no en dos paneles a propósito: emparejar es mirar las dos mitades a la
   * vez, y separarlas obliga a recordar de memoria lo que dice el otro lado.
   *
   * El código de entrega **no se enseña aquí**, solo sus últimos tres caracteres. Lo
   * tiene el dueño en su teléfono y quien entrega lo teclea de ahí: si el personal
   * pudiera leerlo, quien entrega y quien lo presenta serían la misma persona y el
   * código no probaría nada.
   */
  async function loadLostFound() {
    try {
      const d = await api.get(`/nightclubs/${clubId()}/lost-items?limit=100`);
      // Lo entregado y lo cerrado salen de la lista: es un panel para trabajar, no un
      // archivo histórico.
      state.lostFound = (d.items || []).filter((i) => i.status === 'open' || i.status === 'matched');
      $('lfm-error').hidden = true;
    } catch (err) {
      state.lostFound = [];
      $('lfm-error').hidden = false;
      $('lfm-error').textContent = EV2Format.errorMessage(err);
    }
    renderLostFound();
  }

  function renderLostFound() {
    renderInbox();
    const lista = state.lostFound || [];
    $('lfm-empty').hidden = lista.length > 0;
    const caja = $('lfm-list');
    caja.innerHTML = '';
    const encontrados = lista.filter((i) => i.kind === 'found' && i.status === 'open');

    for (const item of lista) {
      const card = document.createElement('div');
      card.className = 'card rounded-lg px-3 py-2 space-y-2';
      card.style.borderLeft = `3px solid ${item.kind === 'lost' ? '#fcd34d' : 'var(--ev2-cyan)'}`;

      const arriba = document.createElement('div');
      arriba.className = 'flex items-start justify-between gap-2';
      const izq = document.createElement('div');
      izq.className = 'min-w-0';
      const que = document.createElement('p');
      que.className = 'font-display truncate';
      que.textContent = `${t(`lf.cat.${item.category}`)} · ${t(`lfm.kind.${item.kind}`)}`;
      const senas = document.createElement('p');
      senas.className = 'text-[11px] text-white/60';
      senas.textContent = item.details || '';
      const donde = document.createElement('p');
      donde.className = 'text-[11px] text-white/40 truncate';
      donde.textContent = [item.place, EV2Format.dateTime(item.happened_at),
        item.storage_note].filter(Boolean).join(' · ');
      izq.append(que, senas, donde);

      const estado = document.createElement('span');
      estado.className = 'text-[11px] shrink-0';
      estado.textContent = t(`lf.status.${item.status}`);
      arriba.append(izq, estado);
      card.appendChild(arriba);

      const acciones = document.createElement('div');
      acciones.className = 'flex flex-wrap gap-2';

      // Recibir: convierte "alguien dijo que lo dejó" en "está en la caja".
      if (item.kind === 'found' && !item.received_at) {
        const recibir = document.createElement('button');
        recibir.className = 'card rounded-lg px-3 py-2 text-xs';
        recibir.textContent = t('lfm.receive');
        recibir.onclick = async () => {
          const donde2 = (await askText(t('lfm.whereAsk')));
          if (donde2 === null) return;
          const listo = ocupado(recibir, 'prn.saving');
          try {
            await api.post(`/nightclubs/${clubId()}/lost-items/${item.id}/receive`,
              { storage_note: donde2.trim() || undefined });
            await loadLostFound();
          } catch (err) { listo(); showError(err); }
        };
        acciones.appendChild(recibir);
      }

      // Emparejar: solo desde el lado del reporte de pérdida, contra lo que hay guardado.
      if (item.kind === 'lost' && item.status === 'open' && encontrados.length) {
        const sel = document.createElement('select');
        sel.className = 'card rounded-lg px-2 py-1 text-xs min-w-0 flex-1';
        const vacio = document.createElement('option');
        vacio.value = '';
        vacio.textContent = t('lfm.matchWith');
        sel.appendChild(vacio);
        for (const f of encontrados) {
          const opt = document.createElement('option');
          opt.value = f.id;
          // Se enseñan las señas del objeto guardado: es exactamente lo que hay que
          // comparar contra las del reporte para decidir si es el mismo.
          opt.textContent = `${t(`lf.cat.${f.category}`)} · ${(f.details || '').slice(0, 40)}`;
          sel.appendChild(opt);
        }
        sel.onchange = async () => {
          if (!sel.value) return;
          if (!(await ask(t('lfm.matchAsk')))) { sel.value = ''; return; }
          sel.disabled = true;
          try {
            await api.post(`/nightclubs/${clubId()}/lost-items/${item.id}/match`,
              { found_id: sel.value });
            toast(t('lfm.matched'), 'ok');
            await loadLostFound();
          } catch (err) { sel.value = ''; sel.disabled = false; showError(err); }
        };
        acciones.appendChild(sel);
      }

      // Entregar: pide el código que el dueño trae en su teléfono.
      if (item.kind === 'lost' && item.status === 'matched') {
        const entregar = document.createElement('button');
        entregar.className = 'ev2-button rounded-lg px-3 py-2 text-xs font-display';
        entregar.textContent = t('lfm.handOver', { hint: item.handover_hint || '' });
        entregar.onclick = async () => {
          const code = (await askText(t('lfm.codeAsk')));
          if (!code) return;
          const listo = ocupado(entregar, 'prn.saving');
          try {
            await api.post(`/nightclubs/${clubId()}/lost-items/${item.id}/hand-over`, { code });
            toast(t('lfm.handedOver'), 'ok');
            await loadLostFound();
          } catch (err) { listo(); showError(err); }
        };
        acciones.appendChild(entregar);
      }

      // Cerrar: exige motivo, y queda escrito.
      const cerrar = document.createElement('button');
      cerrar.className = 'card rounded-lg px-3 py-2 text-xs text-red-300';
      cerrar.textContent = t('lfm.closeIt');
      cerrar.onclick = async () => {
        const motivo = (await askText(t('lfm.closeAsk')));
        if (!motivo || motivo.trim().length < 3) return;
        const listo = ocupado(cerrar, 'prn.saving');
        try {
          await api.post(`/nightclubs/${clubId()}/lost-items/${item.id}/close`,
            { reason: motivo.trim() });
          await loadLostFound();
        } catch (err) { listo(); showError(err); }
      };
      acciones.appendChild(cerrar);

      card.appendChild(acciones);
      caja.appendChild(card);
    }
  }

  // ---------------------------------------------------------------- propinas (D66)

  /**
   * Las propinas que esperan la palabra del gerente.
   *
   * `POST /tips/:id/confirm` existía desde el principio y no tenía botón. No es un
   * detalle cosmético: **confirmar es lo que mete la propina al saldo del empleado**.
   * Sin este panel, una propina en efectivo se quedaba en `pending` para siempre y esa
   * persona nunca podía retirarla — el dinero existía en el libro y no en su bolsillo.
   */
  async function loadTips() {
    try {
      const d = await api.get(`/nightclubs/${clubId()}/tips?status=pending&limit=50`);
      state.tips = d.tips || [];
      $('tip-error').hidden = true;
    } catch (err) {
      // A diferencia de otros paneles, aquí el error se DICE: una lista vacía por un
      // fallo de red se ve igual que "no hay propinas pendientes", y la diferencia
      // entre las dos es dinero que alguien está esperando.
      state.tips = [];
      $('tip-error').hidden = false;
      $('tip-error').textContent = EV2Format.errorMessage(err);
    }
    renderTips();
  }

  function renderTips() {
    renderInbox();
    const lista = state.tips || [];
    $('tip-empty').hidden = lista.length > 0;
    const caja = $('tip-list');
    caja.innerHTML = '';
    for (const tip of lista) {
      const card = document.createElement('div');
      card.className = 'card rounded-lg px-3 py-2 flex items-center justify-between gap-3';

      const izq = document.createElement('div');
      izq.className = 'min-w-0';
      const quien = document.createElement('p');
      quien.className = 'font-display truncate';
      quien.textContent = `${money(tip.amount, tip.currency)} · ${tip.to_name || '—'}`;
      const detalle = document.createElement('p');
      detalle.className = 'text-[11px] text-white/50 truncate';
      detalle.textContent = [
        tip.from_name ? t('tip.from', { name: tip.from_name }) : '',
        EV2Format.dateTime(tip.created_at),
      ].filter(Boolean).join(' · ');
      izq.append(quien, detalle);

      const confirmar = document.createElement('button');
      confirmar.className = 'ev2-button rounded-lg px-3 py-2 text-xs font-display shrink-0';
      confirmar.textContent = t('tip.confirm');
      confirmar.onclick = async () => {
        // Se pregunta con el monto y el nombre: confirmar mueve dinero al saldo de una
        // persona, y deshacerlo después es una cancelación con motivo.
        if (!(await ask(t('tip.confirmAsk', {
          amount: money(tip.amount, tip.currency), name: tip.to_name || '—',
        })))) return;
        const listo = ocupado(confirmar, 'tip.confirming');
        try {
          await api.post(`/nightclubs/${clubId()}/tips/${tip.id}/confirm`, { provider: 'cash' });
          toast(t('tip.confirmed'), 'ok');
          await loadTips();
        } catch (err) { listo(); showError(err); }
      };

      card.append(izq, confirmar);
      caja.appendChild(card);
    }
  }

  $('btn-sup-add').onclick = async () => {
    const nombre = $('sup-name').value.trim();
    const tamano = Number($('sup-size').value);
    const error = $('sup-error');
    error.hidden = true;
    if (!nombre) return avisar(error, t('sup.errName'));
    if (!Number.isFinite(tamano) || tamano <= 0) return avisar(error, t('sup.errSize'));

    const listo = ocupado($('btn-sup-add'), 'sup.adding');
    try {
      await api.post(`/nightclubs/${clubId()}/supplies`, {
        name: nombre,
        unit: $('sup-unit').value,
        package_size: tamano,
        category: $('sup-category').value.trim() || undefined,
        package_label: $('sup-label').value.trim() || undefined,
      });
      $('sup-name').value = '';
      state.invAddOpen = false;
      $('sup-size').value = '';
      $('sup-label').value = '';
      toast(t('sup.added'), 'ok');
      const d = await api.get(`/nightclubs/${clubId()}/supplies`);
      state.supplies = d.supplies || [];
      renderInventory();
    } catch (err) {
      showError(err, error);
    } finally { listo(); }
    return undefined;
  };

  // ---------------------------------------------------------------- cortes de turno (D51)

  /**
   * Los retiros de efectivo de la noche y los cortes ya cerrados (D54).
   *
   * Este panel dejó de tener botones que decidan nada: desde D54 un retiro se
   * autoriza en el acto —el gerente teclea su código en el aparato del empleado— y el
   * corte se cierra en ese mismo momento. Lo que queda aquí es lo que el gerente sí
   * necesita: **ver por dónde salió el dinero**, con el motivo y el nombre de quien
   * lo autorizó, y poder reimprimir un ticket que no salió.
   */
  async function loadShiftCuts() {
    try {
      const [retiros, cierres] = await Promise.all([
        api.get(`/nightclubs/${clubId()}/cash-drops?hours=24&limit=50`),
        api.get(`/nightclubs/${clubId()}/shift-closings?hours=24&limit=50`),
      ]);
      state.cashDrops = retiros.drops || [];
      state.shiftCuts = cierres.closings || [];
    } catch {
      state.cashDrops = [];
      state.shiftCuts = [];
    }
    renderShiftCuts();
  }

  function renderShiftCuts() {
    const retiros = state.cashDrops || [];
    const cortes = state.shiftCuts || [];
    $('cuts-empty').hidden = retiros.length > 0 || cortes.length > 0;

    const cajaRetiros = $('cuts-drops');
    cajaRetiros.innerHTML = '';
    for (const d of retiros) {
      const card = document.createElement('div');
      card.className = 'card rounded-lg px-3 py-2 space-y-1';
      const fila = document.createElement('div');
      fila.className = 'flex items-center justify-between gap-3';
      const quien = document.createElement('p');
      quien.className = 'text-sm truncate';
      quien.textContent = d.user_name || '—';
      const monto = document.createElement('p');
      monto.className = 'font-display shrink-0';
      monto.textContent = money(d.amount, d.currency);
      fila.append(quien, monto);

      // El motivo es el renglón que hace útil este panel: un retiro sin él es el
      // hueco que esta función vino a tapar.
      const motivo = document.createElement('p');
      motivo.className = 'text-[11px] text-white/60';
      motivo.textContent = d.reason || t('cuts.noReason');
      const autoriza = document.createElement('p');
      autoriza.className = 'text-[11px] text-white/40';
      autoriza.textContent = d.authorized_by_name
        ? t('cuts.authorizedBy', { name: d.authorized_by_name })
        : t('cuts.notAuthorized');
      if (!d.authorized_by_name) autoriza.style.color = '#fcd34d';

      card.append(fila, motivo, autoriza);
      cajaRetiros.appendChild(card);
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
        declared: money(c.counted_cash ?? c.declared_cash, c.currency),
      });
      left.append(quien, montos);

      // La diferencia, en el color que le toca. Cero también se dice: el silencio
      // no distingue "cuadró" de "nadie lo revisó".
      const dif = Number(c.difference || 0);
      const marca = document.createElement('p');
      marca.className = 'font-display shrink-0 text-sm';
      marca.style.color = dif === 0 ? 'var(--ev2-lime)' : '#fca5a5';
      marca.textContent = dif === 0
        ? t('cuts.balanced')
        : t(dif < 0 ? 'cuts.short' : 'cuts.over', { amount: money(Math.abs(dif), c.currency) });
      fila.append(left, marca);
      card.appendChild(fila);

      if (dif !== 0 && c.difference_reason) {
        const motivo = document.createElement('p');
        motivo.className = 'text-[11px] text-white/60';
        motivo.textContent = c.difference_reason;
        card.appendChild(motivo);
      }
      // La caja de una barra (D77): de qué barra, con qué fondo, y los pedidos que se
      // quedaron sin cobrar con el permiso de quien autorizó este corte.
      if (c.location_name || Number(c.opening_float) > 0) {
        const fondo = document.createElement('p');
        fondo.className = 'text-[11px] text-white/50';
        fondo.textContent = t('cuts.till', {
          bar: c.location_name || '—', amount: money(c.opening_float, c.currency),
        });
        card.appendChild(fondo);
      }
      if ((c.pending_orders || []).length > 0) {
        const pendientes = document.createElement('p');
        pendientes.className = 'text-[11px]';
        pendientes.style.color = '#fcd34d';
        pendientes.textContent = t('cuts.pendingLeft', {
          n: c.pending_orders.length, amount: money(c.pending_total, c.currency),
        });
        card.appendChild(pendientes);
      }
      const autoriza = document.createElement('p');
      autoriza.className = 'text-[11px] text-white/40';
      autoriza.textContent = c.authorized_by_name
        ? t('cuts.authorizedBy', { name: c.authorized_by_name })
        : t('cuts.notAuthorized');
      card.appendChild(autoriza);

      const nota = document.createElement('p');
      nota.className = 'text-xs text-red-300';
      nota.hidden = true;
      const papel = document.createElement('button');
      papel.className = 'card rounded-lg px-3 py-2 text-xs';
      papel.textContent = t('cuts.reprint');
      papel.onclick = () => reprintCut(c, papel, nota);
      card.append(papel, nota);

      caja.appendChild(card);
    }
  }

  /** Vuelve a sacar el ticket de un corte. Sale exactamente el mismo papel. */
  async function reprintCut(corte, button, nota) {
    nota.hidden = true;
    const listo = ocupado(button, 'cuts.saving');
    try {
      await api.post(`/nightclubs/${clubId()}/shift-closings/${corte.id}/ticket`, {});
      toast(t('cuts.reprinted'), 'ok');
    } catch (err) {
      avisar(nota, EV2Format.errorMessage(err));
    } finally {
      listo();
    }
  }

  // ---------------------------------------------------------------- impresoras (D52)

  /**
   * Lo que el gerente necesita ver cuando algo no salió en papel, junto.
   *
   * Son cuatro preguntas y se contestan en la misma pantalla a propósito: qué
   * impresoras hay, qué PCs están vivas, qué tickets se quedaron sin salir y si la
   * comanda por pedido está prendida. Separadas, encontrar por qué no imprimió la
   * barra de arriba es un recorrido por tres pestañas.
   */
  async function loadPrinting() {
    const club = clubId();
    const pedir = async (ruta, aplicar) => {
      try { aplicar(await api.get(ruta)); } catch { /* cada tarjeta se cuida sola */ }
    };
    await Promise.all([
      pedir(`/nightclubs/${club}/printers?include_inactive=true`, (d) => {
        printing.printers = d.printers || [];
      }),
      pedir(`/nightclubs/${club}/print-agents`, (d) => {
        printing.agents = d.agents || [];
        printing.staleMinutes = d.stale_minutes || 2;
      }),
      pedir(`/nightclubs/${club}/print-jobs?limit=20`, (d) => { printing.jobs = d.jobs || []; }),
      pedir(`/nightclubs/${club}/print-settings`, (d) => { printing.settings = d.settings; }),
      pedir(`/nightclubs/${club}/printing-health`, (d) => { printing.health = d.issues || []; }),
      pedir(`/nightclubs/${club}/zone-bars`, (d) => { printing.zones = d.zones || []; }),
    ]);
    renderPrinting();
  }

  /**
   * Por qué no va a salir papel, dicho antes de que alguien lo note (D63).
   *
   * Cada aviso nombra la barra, la impresora o la PC que le falta algo, porque quien
   * lo lee tiene el menú de esa PC a dos dedos y tiene que poder arreglarlo sin
   * volver a preguntar cuál era.
   *
   * Cuando no hay nada que decir el bloque desaparece entero. Eso importa tanto como
   * los avisos: un aviso permanente se vuelve parte del fondo de la pantalla y deja
   * de leerse, y entonces el día que diga algo de verdad tampoco se va a leer.
   */
  function renderPrintHealth() {
    const avisos = printing.health || [];
    const caja = $('prn-health');
    caja.hidden = avisos.length === 0;
    caja.innerHTML = '';
    for (const aviso of avisos) {
      const grave = aviso.severity === 'warn';
      const card = document.createElement('div');
      card.className = 'card rounded-xl px-4 py-3 text-sm';
      card.style.borderLeft = `3px solid ${grave ? '#fca5a5' : '#fcd34d'}`;
      const titulo = document.createElement('p');
      titulo.className = 'font-display';
      titulo.style.color = grave ? '#fca5a5' : '#fcd34d';
      titulo.textContent = t(`prnHealth.${aviso.code}`, {
        bar: aviso.location_name || '',
        printer: aviso.printer_name || '',
        agent: aviso.agent_name || '',
        n: aviso.count || 0,
        minutes: aviso.oldest_minutes || 0,
      });
      const que = document.createElement('p');
      que.className = 'text-[11px] text-white/50 mt-1';
      que.textContent = t(`prnHealth.${aviso.code}Fix`);
      card.append(titulo, que);
      // Las zonas que se quedan sin papel van completas: es lo que el gerente
      // contrasta contra su plano para saber a qué mesas les afecta.
      if (aviso.sections && aviso.sections.length) {
        const zonas = document.createElement('p');
        zonas.className = 'text-[11px] text-white/40 mt-1';
        zonas.textContent = aviso.sections.join(' · ');
        card.appendChild(zonas);
      }
      caja.appendChild(card);
    }
  }

  /** Hace cuánto se asomó esa PC, dicho como lo diría una persona. */
  function agentState(agent) {
    if (!agent.active) return { key: 'prn.agentOff', color: '#fca5a5' };
    if (!agent.last_seen_at) return { key: 'prn.agentNever', color: '#fcd34d' };
    const minutos = (Date.now() - new Date(agent.last_seen_at).getTime()) / 60000;
    // El agente pregunta cada tres segundos: si lleva más de dos minutos callado, esa
    // PC está apagada, y eso es lo que hay que ver de un vistazo.
    return minutos > printing.staleMinutes
      ? { key: 'prn.agentDown', color: '#fca5a5', minutes: Math.round(minutos) }
      : { key: 'prn.agentUp', color: 'var(--ev2-lime)' };
  }

  const JOB_COLOR = {
    printed: 'var(--ev2-lime)', failed: '#fca5a5', taken: '#fcd34d', pending: '#fcd34d',
  };

  /**
   * Qué barra atiende cada zona del plano (D66).
   *
   * Es de lo que más depende esta pestaña y no tenía pantalla: la comanda de una mesa
   * va a la barra que atiende SU zona, y una zona sin barra asignada no encola nada y
   * no avisa. Va junto a los avisos de la revisión porque es donde se arregla lo que
   * esos avisos señalan.
   */
  function renderZoneBars() {
    const zonas = printing.zones || [];
    $('zb-empty').hidden = zonas.length > 0;
    const barras = (state.locations || []).filter((l) => l.kind === 'bar');
    const caja = $('zb-list');
    caja.innerHTML = '';

    for (const zona of zonas) {
      const fila = document.createElement('div');
      fila.className = 'card rounded-lg px-3 py-2 flex items-center justify-between gap-3';

      const izq = document.createElement('div');
      izq.className = 'min-w-0';
      const nombre = document.createElement('p');
      nombre.className = 'font-display truncate';
      nombre.textContent = zona.section;
      const cuantas = document.createElement('p');
      cuantas.className = 'text-[11px] truncate';
      // Una zona sin barra se pinta en ámbar: es la que no va a imprimir nada.
      cuantas.style.color = zona.location_id ? 'rgba(255,255,255,.5)' : '#fcd34d';
      cuantas.textContent = zona.location_id
        ? t('zb.tables', { n: zona.tables })
        : t('zb.noBar', { n: zona.tables });
      izq.append(nombre, cuantas);

      const sel = document.createElement('select');
      sel.className = 'card rounded-lg px-2 py-1 text-xs shrink-0';
      const ninguna = document.createElement('option');
      ninguna.value = '';
      ninguna.textContent = t('zb.pick');
      sel.appendChild(ninguna);
      for (const b of barras) {
        const opt = document.createElement('option');
        opt.value = b.id;
        opt.textContent = b.name;
        sel.appendChild(opt);
      }
      sel.value = zona.location_id || '';
      sel.onchange = async () => {
        sel.disabled = true;
        $('zb-error').hidden = true;
        try {
          await api.put(`/nightclubs/${clubId()}/zone-bars`, {
            assignments: [{ section: zona.section, location_id: sel.value || null }],
          });
          await loadPrinting();
        } catch (err) {
          sel.value = zona.location_id || '';
          $('zb-error').hidden = false;
          $('zb-error').textContent = EV2Format.errorMessage(err);
        } finally { sel.disabled = false; }
      };

      fila.append(izq, sel);
      caja.appendChild(fila);
    }
  }

  function renderPrinting() {
    renderPrintHealth();
    renderZoneBars();
    renderPairing();
    renderFoundPrinters();
    renderPrintersList();
    renderPrintAgents();
    renderPrintJobs();
    renderPrintSettings();

    // Las barras llegan en el mismo lote que todo lo demás, así que esta pestaña se
    // puede abrir antes de que estén. Mientras no estén, el formulario se apaga y lo
    // dice: dejarlo abierto con la lista vacía hacía que picarle "Dar de alta"
    // contestara "escoge en qué barra está" señalando un menú sin opciones.
    const select = $('prn-location');
    const barras = (state.locations || []).filter((l) => l.kind === 'bar');
    const listas = barras.length > 0;
    if (!listas) {
      select.innerHTML = '';
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = t(state.invLoaded ? 'prn.noBars' : 'prn.loadingBars');
      select.appendChild(opt);
    } else if (select.options.length !== barras.length || !select.options[0].value) {
      select.innerHTML = '';
      for (const b of barras) {
        const opt = document.createElement('option');
        opt.value = b.id;
        opt.textContent = b.name;
        select.appendChild(opt);
      }
    }
    select.disabled = !listas;
    $('btn-prn-add').disabled = !listas;

    // La barra de la PC nueva (D80). Con una sola barra, ya viene escogida.
    const selPc = $('prn-agent-loc');
    if (selPc.options.length !== barras.length + 1) {
      const antes = selPc.value;
      selPc.innerHTML = '';
      const todo = document.createElement('option');
      todo.value = '';
      todo.textContent = t('prn.areaAll');
      selPc.appendChild(todo);
      for (const b of barras) {
        const opt = document.createElement('option');
        opt.value = b.id;
        opt.textContent = b.name;
        selPc.appendChild(opt);
      }
      selPc.value = antes || (barras.length === 1 ? barras[0].id : '');
    }
    $('prn-agent-purpose').disabled = !selPc.value;
  }

  $('prn-agent-loc').onchange = () => {
    if (!$('prn-agent-loc').value) $('prn-agent-purpose').value = '';
    $('prn-agent-purpose').disabled = !$('prn-agent-loc').value;
  };

  function renderPrintersList() {
    const lista = printing.printers || [];
    $('prn-empty').hidden = lista.length > 0;
    const caja = $('prn-list');
    caja.innerHTML = '';
    for (const p of lista) {
      const card = document.createElement('div');
      card.className = 'card rounded-lg px-3 py-2 space-y-2';
      if (!p.active) card.style.opacity = '.5';

      const fila = document.createElement('div');
      fila.className = 'flex items-center justify-between gap-3';
      const left = document.createElement('div');
      left.className = 'min-w-0';
      const nombre = document.createElement('p');
      nombre.className = 'font-display truncate';
      nombre.textContent = p.name;
      const donde = document.createElement('p');
      donde.className = 'text-[11px] text-white/50 truncate';
      donde.textContent = `${p.location_name || ''} · ${t(PURPOSE_KEY[p.purpose] || 'prn.pService')}`;
      const como = document.createElement('p');
      como.className = 'text-[11px] text-white/40 truncate';
      como.textContent = p.connection === 'windows'
        ? `${t('prn.cWindows')} · ${p.windows_name}`
        : `${p.host}:${p.port} · ${p.paper_width} mm · ${p.codepage}`;
      left.append(nombre, donde, como);

      const nota = document.createElement('p');
      nota.className = 'text-xs text-red-300';
      nota.hidden = true;

      const acciones = document.createElement('div');
      acciones.className = 'flex gap-2 shrink-0';
      const probar = document.createElement('button');
      probar.className = 'card rounded-lg px-3 py-2 text-xs';
      probar.textContent = t('prn.test');
      probar.disabled = !p.active;
      probar.onclick = () => testPrinter(p, probar, nota);
      const apagar = document.createElement('button');
      apagar.className = 'card rounded-lg px-3 py-2 text-xs';
      apagar.textContent = t(p.active ? 'prn.disable' : 'prn.enable');
      apagar.onclick = () => togglePrinter(p, apagar, nota);
      acciones.append(probar, apagar);

      fila.append(left, acciones);
      card.append(fila, nota);
      caja.appendChild(card);
    }
  }

  /**
   * Lo que cada PC vio en su red (D55).
   *
   * Agrupado por PC y no en una lista sola a propósito: con dos agentes, saber que
   * hay una impresora en el .50 vale menos que saber **cuál PC la alcanza**, que es
   * lo que decide a quién ponerle de respaldo a quién.
   *
   * Lo que ya está dado de alta se marca en vez de esconderse: si alguien busca y no
   * ve su impresora, la pregunta siguiente es "¿entonces cuál es la que ya tengo?".
   */
  function renderFoundPrinters() {
    const agentes = printing.agents || [];
    const caja = $('prn-found');
    const conResultado = agentes.filter((a) => a.scan_at || a.scan_error);
    const buscando = Date.now() < printing.scanUntil;

    const estado = $('prn-scan-status');
    estado.hidden = !buscando && conResultado.length === 0;
    if (buscando) {
      estado.textContent = t('prn.scanning');
      estado.style.color = '#fcd34d';
    } else if (conResultado.length) {
      estado.textContent = t('prn.scanDone', { count: conResultado.length });
      estado.style.color = 'rgba(255,255,255,.4)';
    }

    caja.innerHTML = '';
    // Solo cuentan las prendidas: una apagada se puede volver a registrar (D80).
    const yaDadas = new Set((printing.printers || []).filter((p) => p.active)
      .map((p) => `${p.connection}|${p.host || p.windows_name}`));
    // Desde D61 una USB se abre por su nombre; el compartido es de instalaciones viejas.
    const yaEsta = (h) => (h.kind === 'windows'
      ? yaDadas.has(`windows|${h.name}`) || (h.share && yaDadas.has(`windows|${h.share}`))
      : yaDadas.has(`network|${h.host}`));

    for (const a of conResultado) {
      const bloque = document.createElement('div');
      bloque.className = 'space-y-1';
      const titulo = document.createElement('p');
      titulo.className = 'text-[11px] text-white/50';
      titulo.textContent = a.name;
      bloque.appendChild(titulo);

      if (a.scan_error) {
        const err = document.createElement('p');
        err.className = 'text-xs text-red-300';
        err.textContent = a.scan_error;
        bloque.appendChild(err);
        caja.appendChild(bloque);
        continue;
      }

      const hallazgos = a.scan_result || [];
      if (!hallazgos.length) {
        const vacio = document.createElement('p');
        vacio.className = 'text-xs text-white/40';
        vacio.textContent = t('prn.scanNone');
        bloque.appendChild(vacio);
        caja.appendChild(bloque);
        continue;
      }

      for (const h of hallazgos) {
        const fila = document.createElement('div');
        fila.className = 'card rounded-lg px-3 py-2 flex items-center justify-between gap-3';
        const left = document.createElement('div');
        left.className = 'min-w-0';
        const que = document.createElement('p');
        que.className = 'text-sm truncate';
        que.textContent = h.kind === 'windows'
          ? `${h.name || '—'}${h.share ? ` (${h.share})` : ''}`
          : `${h.host}:${h.port}`;
        const como = document.createElement('p');
        como.className = 'text-[11px] text-white/40 truncate';
        como.textContent = h.kind === 'windows' ? t('prn.cUsb') : (h.model || t('prn.cNetwork'));
        left.append(que, como);

        // Si la PC ya tiene barra y propósito (D80), se registra en un clic con eso;
        // si no, se abre el formulario con lo que se encontró.
        const ya = yaEsta(h);
        const directo = Boolean(a.location_id && a.purpose);
        const accion = document.createElement('button');
        accion.className = `${directo ? 'ev2-button' : 'card'} rounded-lg px-3 py-2 text-xs shrink-0`;
        accion.textContent = ya ? t('prn.already') : t(directo ? 'prn.register' : 'prn.useThis');
        accion.disabled = ya;
        accion.onclick = () => (directo ? registerFound(h, a, accion) : fillFromScan(h, a));

        fila.append(left, accion);
        bloque.appendChild(fila);
      }
      caja.appendChild(bloque);
    }
  }

  /**
   * Pone el hallazgo en el formulario de alta y lo abre.
   *
   * No la da de alta sola: falta decir en qué barra está y para qué es, que es
   * justamente lo que una máquina no puede adivinar.
   */
  function fillFromScan(hallazgo, agente = null) {
    const caja = $('prn-add-box');
    caja.open = true;
    if (agente && agente.location_id) $('prn-location').value = agente.location_id;
    if (agente && agente.purpose) $('prn-purpose').value = agente.purpose;
    // Una USB solo la alcanza la PC que la encontró: queda ligada a ella (D80).
    $('prn-agent-id').value = hallazgo.kind === 'windows' && agente ? agente.id : '';
    if (hallazgo.kind === 'windows') {
      $('prn-connection').value = 'windows';
      $('prn-winname').value = hallazgo.name || hallazgo.share || '';
      $('prn-name').value = (hallazgo.name || '').slice(0, 60);
    } else {
      $('prn-connection').value = 'network';
      $('prn-host').value = hallazgo.host || '';
      $('prn-port').value = String(hallazgo.port || 9100);
      $('prn-name').value = hallazgo.model || `Impresora ${hallazgo.host}`;
    }
    $('prn-connection').onchange();
    caja.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    $('prn-location').focus();
  }

  /** Lo que se manda para dar de alta lo que encontró una PC (D80). */
  function foundPayload(h, a) {
    const base = {
      location_id: a.location_id,
      purpose: a.purpose,
      paper_width: 80,
      codepage: 'CP850',
      has_cutter: true,
      test: true,
    };
    if (h.kind === 'windows') {
      return {
        ...base,
        name: (h.name || h.share || 'Impresora USB').slice(0, 60),
        connection: 'windows',
        windows_name: h.name || h.share,
        agent_id: a.id,
      };
    }
    return {
      ...base,
      name: (h.model || `Impresora ${h.host}`).slice(0, 60),
      connection: 'network',
      host: h.host,
      port: h.port || 9100,
    };
  }

  /** Registrar en un clic, con la barra y el propósito de la PC, y probar. */
  async function registerFound(h, a, boton) {
    const listo = ocupado(boton, 'prn.saving');
    try {
      const res = await api.post(`/nightclubs/${clubId()}/printers`, foundPayload(h, a));
      toast(t('prn.registered'), 'ok');
      askTest(res.printer);
      await loadPrinting();
    } catch (err) {
      listo();
      showError(err);
    }
  }

  // La hoja de prueba: si los acentos salen mal, se cambia la página de códigos y se
  // vuelve a imprimir, sin buscar el formulario de edición.
  const CODEPAGES = ['CP850', 'CP1252', 'CP858', 'CP437', 'CP860'];
  let enPrueba = null;
  function askTest(printer) {
    enPrueba = printer;
    $('prn-test-text').textContent = t('prn.testAsk', { name: printer.name, codepage: printer.codepage });
    $('btn-prn-test-retry').disabled = false;
    $('prn-test-check').hidden = false;
  }
  $('btn-prn-test-ok').onclick = () => {
    enPrueba = null;
    $('prn-test-check').hidden = true;
  };
  $('btn-prn-test-retry').onclick = async () => {
    if (!enPrueba) return;
    const siguiente = CODEPAGES[CODEPAGES.indexOf(enPrueba.codepage) + 1];
    if (!siguiente) {
      $('prn-test-text').textContent = t('prn.testNoMore');
      $('btn-prn-test-retry').disabled = true;
      return;
    }
    const listo = ocupado($('btn-prn-test-retry'), 'prn.sending');
    try {
      const { printer } = await api.patch(`/nightclubs/${clubId()}/printers/${enPrueba.id}`,
        { codepage: siguiente });
      await api.post(`/nightclubs/${clubId()}/printers/${printer.id}/test`, {});
      askTest(printer);
      await loadPrinting();
    } catch (err) {
      showError(err);
    } finally {
      listo();
    }
  };

  $('btn-prn-scan').onclick = async () => {
    const nota = $('prn-scan-error');
    nota.hidden = true;
    const listo = ocupado($('btn-prn-scan'), 'prn.scanning');
    try {
      const res = await api.post(`/nightclubs/${clubId()}/print-agents/scan`, {});
      if (res.online === 0) {
        avisar(nota, t('prn.scanNoAgents'), 'warn');
      }
      // Se sigue preguntando un rato: el barrido tarda unos segundos y el resultado
      // llega cuando el agente lo manda, no cuando esta llamada contesta.
      printing.scanUntil = Date.now() + 30000;
      renderFoundPrinters();
      await waitForScan();
    } catch (err) {
      avisar(nota, EV2Format.errorMessage(err));
    } finally {
      listo();
    }
  };

  /** Vuelve a preguntar por los agentes hasta que contesten, o hasta rendirse. */
  async function waitForScan() {
    while (Date.now() < printing.scanUntil) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => { setTimeout(r, 2000); });
      // eslint-disable-next-line no-await-in-loop
      await loadPrinting();
      const listos = (printing.agents || []).filter((a) => a.scan_at
        && a.scan_requested_at && new Date(a.scan_at) >= new Date(a.scan_requested_at));
      const pedidos = (printing.agents || []).filter((a) => a.active && a.scan_requested_at);
      if (pedidos.length && listos.length >= pedidos.length) break;
    }
    printing.scanUntil = 0;
    renderFoundPrinters();
  }

  function renderPrintAgents() {
    const lista = printing.agents || [];
    $('prn-agents-empty').hidden = lista.length > 0;
    const caja = $('prn-agents');
    caja.innerHTML = '';
    for (const a of lista) {
      const estado = agentState(a);
      const card = document.createElement('div');
      card.className = 'card rounded-lg px-3 py-2 flex items-center justify-between gap-3';
      const left = document.createElement('div');
      left.className = 'min-w-0';
      const nombre = document.createElement('p');
      nombre.className = 'font-display truncate';
      nombre.textContent = a.name;
      const linea = document.createElement('p');
      linea.className = 'text-[11px] truncate';
      linea.style.color = estado.color;
      linea.textContent = estado.minutes !== undefined
        ? t(estado.key, { minutes: estado.minutes })
        : t(estado.key);
      left.append(nombre, linea);

      const apagar = document.createElement('button');
      apagar.className = 'card rounded-lg px-3 py-2 text-xs shrink-0';
      apagar.textContent = t(a.active ? 'prn.disable' : 'prn.enable');
      apagar.onclick = async () => {
        const listo = ocupado(apagar, 'prn.saving');
        try {
          await api.patch(`/nightclubs/${clubId()}/print-agents/${a.id}`, { active: !a.active });
          await loadPrinting();
        } catch (err) { listo(); showError(err); }
      };

      // La tarjeta pasa a dos renglones: arriba quién es y si está viva, abajo a qué
      // barra atiende. El área va en la tarjeta y no en un diálogo aparte porque es
      // lo que hay que poder comprobar de un vistazo cuando una barra no imprime.
      card.className = 'card rounded-lg px-3 py-2 space-y-2';
      const arriba = document.createElement('div');
      arriba.className = 'flex items-center justify-between gap-3';
      arriba.append(left, apagar);
      card.append(arriba, agentAreaRow(a));
      caja.appendChild(card);
    }
  }

  /**
   * A qué barra atiende esta PC (D61).
   *
   * Sin esto, cada PC toma de la cola lo que sea y la más rápida se lleva las
   * comandas de las otras barras: no es una carrera que a veces se pierda, se pierde
   * siempre. Dejar la barra en "todo el club" es lo correcto —y lo único que se
   * puede hacer— mientras el club tenga una sola PC.
   */
  function agentAreaRow(a) {
    const fila = document.createElement('div');
    fila.className = 'flex items-center gap-2';

    const barras = (state.locations || []).filter((l) => l.kind === 'bar');
    const selBarra = document.createElement('select');
    selBarra.className = 'card rounded-lg px-2 py-1 text-xs min-w-0 flex-1';
    const todo = document.createElement('option');
    todo.value = '';
    todo.textContent = t('prn.areaAll');
    selBarra.appendChild(todo);
    for (const b of barras) {
      const opt = document.createElement('option');
      opt.value = b.id;
      opt.textContent = b.name;
      selBarra.appendChild(opt);
    }
    selBarra.value = a.location_id || '';

    const selPapel = document.createElement('select');
    selPapel.className = 'card rounded-lg px-2 py-1 text-xs min-w-0 flex-1';
    for (const [valor, clave] of [['', 'prn.areaBoth'], ['orders', 'prn.pOrders'], ['service', 'prn.pService'], ['till', 'prn.pTill']]) {
      const opt = document.createElement('option');
      opt.value = valor;
      opt.textContent = t(clave);
      selPapel.appendChild(opt);
    }
    selPapel.value = a.purpose || '';
    // Un propósito sin barra no se puede resolver ("la comandera" ¿de cuál barra?),
    // y el servidor lo rechaza. Apagarlo aquí evita ofrecer algo que no se guarda.
    selPapel.disabled = !selBarra.value;

    const guardar = async () => {
      selBarra.disabled = true;
      selPapel.disabled = true;
      try {
        await api.patch(`/nightclubs/${clubId()}/print-agents/${a.id}`, {
          area: { location_id: selBarra.value || null, purpose: selPapel.value || null },
        });
        await loadPrinting();
      } catch (err) {
        selBarra.value = a.location_id || '';
        selPapel.value = a.purpose || '';
        selBarra.disabled = false;
        selPapel.disabled = !selBarra.value;
        showError(err);
      }
    };
    selBarra.onchange = () => {
      if (!selBarra.value) selPapel.value = '';
      selPapel.disabled = !selBarra.value;
      guardar();
    };
    selPapel.onchange = guardar;

    fila.append(selBarra, selPapel);
    return fila;
  }

  function renderPrintJobs() {
    const lista = printing.jobs || [];
    $('prn-jobs-empty').hidden = lista.length > 0;
    const caja = $('prn-jobs');
    caja.innerHTML = '';
    for (const j of lista) {
      const card = document.createElement('div');
      card.className = 'card rounded-lg px-3 py-2 flex items-center justify-between gap-3';
      const left = document.createElement('div');
      left.className = 'min-w-0';
      const que = document.createElement('p');
      que.className = 'text-sm truncate';
      que.textContent = `${t(`prn.k.${j.kind}`)} · ${j.printer_name || ''}`;
      const como = document.createElement('p');
      como.className = 'text-[11px] truncate';
      como.style.color = JOB_COLOR[j.status] || 'rgba(255,255,255,.5)';
      // El motivo del fallo va completo: "no se pudo conectar (EHOSTUNREACH)" es lo
      // que distingue una impresora apagada de una con la IP mal escrita.
      como.textContent = j.status === 'failed'
        ? t('prn.jobFailed', { error: j.last_error || '' })
        : t(`prn.s.${j.status}`);
      left.append(que, como);

      const otra = document.createElement('button');
      otra.className = 'card rounded-lg px-3 py-2 text-xs shrink-0';
      otra.textContent = t('prn.reprint');
      otra.onclick = async () => {
        const listo = ocupado(otra, 'prn.sending');
        try {
          await api.post(`/nightclubs/${clubId()}/print-jobs/${j.id}/reprint`, {});
          toast(t('prn.queued'), 'ok');
          await loadPrinting();
        } catch (err) { listo(); showError(err); }
      };

      card.append(left, otra);
      caja.appendChild(card);
    }
  }

  function renderPrintSettings() {
    const s = printing.settings;
    const check = $('prn-order-tickets');
    check.checked = Boolean(s && s.print_order_tickets);
    // Lo cambian gerente y admin (D58). Para cualquier otro rol que llegue a esta
    // pantalla se deshabilita en vez de esconderse: hay que poder VER si está
    // prendido cuando la barra reclama, aunque no se pueda tocar.
    const rol = (api.session && api.session.user && api.session.user.role) || null;
    check.disabled = !['manager', 'admin'].includes(rol);
  }

  async function testPrinter(printer, button, nota) {
    nota.hidden = true;
    const listo = ocupado(button, 'prn.sending');
    try {
      await api.post(`/nightclubs/${clubId()}/printers/${printer.id}/test`, {});
      toast(t('prn.queued'), 'ok');
      await loadPrinting();
    } catch (err) {
      listo();
      avisar(nota, EV2Format.errorMessage(err));
    }
  }

  async function togglePrinter(printer, button, nota) {
    nota.hidden = true;
    const listo = ocupado(button, 'prn.saving');
    try {
      await api.patch(`/nightclubs/${clubId()}/printers/${printer.id}`,
        { active: !printer.active });
      await loadPrinting();
    } catch (err) {
      listo();
      avisar(nota, EV2Format.errorMessage(err));
    }
  }

  $('prn-connection').onchange = () => {
    const red = $('prn-connection').value === 'network';
    $('prn-network-fields').hidden = !red;
    $('prn-windows-fields').hidden = red;
  };

  $('btn-prn-add').onclick = async () => {
    const nota = $('prn-add-error');
    nota.hidden = true;
    const red = $('prn-connection').value === 'network';
    const cuerpo = {
      location_id: $('prn-location').value,
      name: $('prn-name').value.trim(),
      purpose: $('prn-purpose').value,
      connection: $('prn-connection').value,
      paper_width: Number($('prn-width').value),
      codepage: $('prn-codepage').value,
      has_cutter: $('prn-cutter').checked,
      ...(red
        ? { host: $('prn-host').value.trim(), port: Number($('prn-port').value) }
        : { windows_name: $('prn-winname').value.trim() }),
      ...(!red && $('prn-agent-id').value ? { agent_id: $('prn-agent-id').value } : {}),
      test: true,
    };
    if (!cuerpo.location_id) { avisar(nota, t('prn.errBar')); return; }
    if (!cuerpo.name) { avisar(nota, t('prn.errName')); return; }
    if (red && !cuerpo.host) { avisar(nota, t('prn.errHost')); return; }
    if (!red && !cuerpo.windows_name) { avisar(nota, t('prn.errWinName')); return; }

    const listo = ocupado($('btn-prn-add'), 'prn.saving');
    try {
      const alta = await api.post(`/nightclubs/${clubId()}/printers`, cuerpo);
      askTest(alta.printer);
      $('prn-agent-id').value = '';
      $('prn-name').value = '';
      $('prn-host').value = '';
      $('prn-winname').value = '';
      toast(t('prn.added'), 'ok');
      await loadPrinting();
      listo();
    } catch (err) {
      listo();
      avisar(nota, EV2Format.errorMessage(err));
    }
  };

  /**
   * Dar de alta una PC, sin token que copiar (D56).
   *
   * Se pide un código, se enseña en grande, y se espera a que la otra máquina lo
   * teclee. Copiar un token de 48 caracteres desde aquí hasta la barra —por WhatsApp,
   * por un papel— era donde se rompía la instalación.
   */
  $('btn-agent-add').onclick = async () => {
    const listo = ocupado($('btn-agent-add'), 'prn.saving');
    try {
      // La PC nace con su barra y su papel, escogidos arriba antes del código (D80);
      // con una sola barra ya viene escogida. Se puede cambiar después en su tarjeta.
      const loc = $('prn-agent-loc').value || null;
      const cuerpo = loc
        ? { location_id: loc, purpose: $('prn-agent-purpose').value || null }
        : {};
      const { invite } = await api.post(`/nightclubs/${clubId()}/print-agents/invite`, cuerpo);
      printing.invite = invite;
      printing.pairUntil = new Date(invite.expires_at).getTime();
      renderPairing();
      await waitForPairing(invite);
    } catch (err) {
      showError(err);
    } finally {
      listo();
    }
  };

  function renderPairing() {
    const caja = $('prn-pair');
    const invite = printing.invite;
    const vivo = Boolean(invite) && Date.now() < printing.pairUntil;
    caja.hidden = !vivo;
    if (!vivo) { printing.invite = null; return; }

    $('prn-pair-code').textContent = invite.code;
    const minutos = Math.max(0, Math.ceil((printing.pairUntil - Date.now()) / 60000));
    $('prn-pair-ttl').textContent = t('prn.pairTtl', { minutes: minutos });
    $('prn-pair-wait').hidden = false;
    $('prn-pair-wait').textContent = t('prn.pairWaiting');

    // La línea que se pega en la otra PC (D57). Sale de `location.origin`, no de una
    // constante: el panel ya se está viendo desde el dominio bueno, así que es la
    // única fuente que no se puede quedar vieja cuando el club cambie de dominio.
    $('prn-install-cmd').textContent = installLine();
    $('prn-install-dl').href = `${location.origin}/api/print-agent/install.ps1`;
  }

  /** `irm https://dominio/api/print-agent/install.ps1 | iex` */
  function installLine() {
    return `irm ${location.origin}/api/print-agent/install.ps1 | iex`;
  }

  $('btn-prn-copy').onclick = async () => {
    const linea = installLine();
    try {
      // `navigator.clipboard` no existe fuera de https (salvo en localhost), y el
      // panel se abre en la tableta de la barra. Si no está, se selecciona la línea
      // para que copiarla sea un gesto y no una transcripción a mano.
      if (!navigator.clipboard) throw new Error('sin portapapeles');
      await navigator.clipboard.writeText(linea);
      toast(t('prn.installCopied'), 'ok');
    } catch (err) {
      const rango = document.createRange();
      rango.selectNodeContents($('prn-install-cmd'));
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(rango);
      toast(t('prn.installCopyFail'), 'warn');
    }
  };

  /**
   * Espera a que la PC se empareje y avisa cuando llegó.
   *
   * Se sigue preguntando hasta que el código caduque: quien lo teclea está en la otra
   * barra, y el tiempo que tarda en caminar hasta allá es parte del proceso.
   */
  async function waitForPairing(invite) {
    const antes = new Set((printing.agents || []).map((a) => a.id));
    while (Date.now() < printing.pairUntil) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => { setTimeout(r, 3000); });
      // eslint-disable-next-line no-await-in-loop
      await loadPrinting();
      const nueva = (printing.agents || []).find((a) => !antes.has(a.id));
      if (nueva) {
        printing.invite = null;
        printing.pairUntil = 0;
        toast(t('prn.paired', { name: nueva.name }), 'ok');
        // La PC recién emparejada ya está buscando impresoras sola: se espera su
        // resultado para que el gerente lo encuentre puesto y no tenga que pedirlo.
        printing.scanUntil = Date.now() + 40000;
        renderPrinting();
        await waitForScan();
        return;
      }
      // Sigue vivo el mismo código: se repinta para que el contador baje.
      if (printing.invite && printing.invite.id === invite.id) renderPairing();
    }
    printing.invite = null;
    renderPairing();
  }

  $('prn-order-tickets').onchange = async () => {
    const nota = $('prn-settings-error');
    nota.hidden = true;
    const quiere = $('prn-order-tickets').checked;
    try {
      const { settings } = await api.patch(`/nightclubs/${clubId()}/print-settings`,
        { print_order_tickets: quiere });
      printing.settings = settings;
      toast(t(quiere ? 'prn.ordersOn' : 'prn.ordersOff'), 'ok');
    } catch (err) {
      // Se regresa el interruptor a donde estaba: dejarlo palomeado cuando el
      // servidor lo rechazó haría creer a la barra que va a imprimir.
      $('prn-order-tickets').checked = !quiere;
      avisar(nota, EV2Format.errorMessage(err));
    }
  };

  // ---------------------------------------------------------------- checador de huella (D94)

  /**
   * Qué PC es el checador, las huellas del personal y la asistencia.
   *
   * El registro de huellas habla con el lector a través de `EV2Clock.createReader`, y
   * por eso solo funciona en la PC que tiene el lector (la de la caja de abajo). El
   * lector se prende al abrir la hoja de registro y se apaga al cerrarla: el resto del
   * tiempo este panel no le habla.
   */
  const clock = {
    data: null, events: [], search: '',
    enroll: { person: null, images: [], capturing: false, reader: null, sending: false },
  };
  const STATION_ID_KEY = `${EV2Clock.STATION_KEY}.id`;
  const localStore = (() => { try { return window.localStorage; } catch { return null; } })();
  const thisPcStation = () => (localStore && localStore.getItem(STATION_ID_KEY)) || null;

  async function loadClock() {
    const club = clubId();
    try {
      clock.data = await api.get(`/nightclubs/${club}/clock`);
      const ev = await api.get(`/nightclubs/${club}/clock/events`);
      clock.events = ev.events || [];
    } catch (err) {
      if (state.tab === 'clock') showError(err);
    }
    renderClock();
  }

  function renderClock() {
    const d = clock.data;
    if (!d || !$('tab-clock')) return;
    $('clk-problem').hidden = d.configured;
    $('clk-problem').textContent = d.configured ? '' : (d.problem || t('clk.notConfigured'));

    // Esta PC.
    const mine = thisPcStation();
    const activa = (d.stations || []).find((s) => s.id === mine && s.active);
    $('clk-this-pc').textContent = activa ? t('clk.thisPcIs', { name: activa.name }) : t('clk.thisPcIsNot');
    $('btn-clk-make').hidden = Boolean(activa);
    $('clk-open').hidden = !activa;

    $('clk-stations').innerHTML = (d.stations || []).filter((s) => s.active).map((s) => `
      <div class="flex items-center justify-between gap-2 text-sm rounded-lg bg-white/5 px-3 py-2">
        <div class="min-w-0">
          <p class="truncate">${escape(s.name)}${s.id === mine ? ` <span class="text-[11px] text-lime-300">· ${escape(t('clk.thisPc'))}</span>` : ''}</p>
          <p class="text-[11px] text-white/40">${escape(s.last_seen_at ? t('clk.lastSeen', { when: EV2Format.dateTime(s.last_seen_at) }) : t('clk.neverSeen'))}</p>
        </div>
        <button class="clk-revoke text-xs text-red-300 px-2 py-1" data-id="${escape(s.id)}">${escape(t('clk.revokeStation'))}</button>
      </div>`).join('');

    // El personal.
    const q = clock.search.trim().toLowerCase();
    const gente = (d.employees || []).filter((p) => !q || String(p.name || '').toLowerCase().includes(q));
    $('clk-people').innerHTML = gente.map((p) => {
      const dedos = (p.fingers || []).map((f) => t(EV2Clock.fingerKey(f.finger)));
      const estado = !p.consent_at ? t('clk.noConsent')
        : (dedos.length ? dedos.join(' · ') : t('clk.noFingers'));
      const completo = dedos.length >= (d.fingers_per_person || 2);
      return `
      <button class="clk-person w-full text-left flex items-center justify-between gap-2 rounded-lg bg-white/5 px-3 py-2" data-id="${escape(p.user_id)}">
        <div class="min-w-0">
          <p class="text-sm truncate">${escape(p.name)} <span class="text-[11px] text-white/40">${escape(EV2Roles.describe(p.role, lang()).label)}</span></p>
          <p class="text-[11px] ${completo ? 'text-lime-300' : 'text-white/40'}">${escape(estado)}</p>
        </div>
        <span class="text-xs text-white/60 shrink-0">${escape(t(completo ? 'clk.manage' : 'clk.enroll'))}</span>
      </button>`;
    }).join('');

    // La asistencia.
    $('clk-events-empty').hidden = clock.events.length > 0;
    $('clk-events').innerHTML = clock.events.map((e) => `
      <div class="flex items-center justify-between gap-2 py-2 text-sm">
        <span class="truncate">${escape(e.name)}</span>
        <span class="shrink-0 ${e.kind === 'in' ? 'text-lime-300' : 'text-sky-300'}">${escape(t(e.kind === 'in' ? 'clk.in' : 'clk.out'))} · ${escape(EV2Format.time(e.created_at))}</span>
      </div>`).join('');

    if (clock.enroll.person) renderEnroll();
  }

  $('clk-search').oninput = (e) => { clock.search = e.target.value; renderClock(); };
  $('btn-clk-reload').onclick = () => loadClock();

  $('btn-clk-make').onclick = async () => {
    const nombre = await askText(t('clk.stationName'), t('clk.stationDefault'));
    if (!nombre) return;
    const listo = ocupado($('btn-clk-make'), 'prn.saving');
    try {
      const r = await api.post(`/nightclubs/${clubId()}/clock/stations`, { name: String(nombre).trim().slice(0, 60) });
      // El token se queda en ESTA PC y no se vuelve a ver: la base guarda su huella.
      localStore.setItem(EV2Clock.STATION_KEY, r.token);
      localStore.setItem(STATION_ID_KEY, r.station.id);
      toast(t('clk.stationReady'), 'ok');
      await loadClock();
    } catch (err) {
      showError(err);
    } finally {
      listo();
    }
  };

  $('clk-stations').onclick = async (e) => {
    const b = e.target.closest('.clk-revoke');
    if (!b) return;
    if (!(await ask(t('clk.revokeStationAsk')))) return;
    try {
      await api.del(`/nightclubs/${clubId()}/clock/stations/${b.dataset.id}`);
      if (b.dataset.id === thisPcStation()) {
        localStore.removeItem(EV2Clock.STATION_KEY);
        localStore.removeItem(STATION_ID_KEY);
      }
      await loadClock();
    } catch (err) { showError(err); }
  };

  // ---- registrar huellas

  const enrollPerson = () => {
    const id = clock.enroll.person;
    return clock.data && (clock.data.employees || []).find((p) => p.user_id === id);
  };

  function enrollMsg(text, kind) {
    const el = $('enr-msg');
    el.textContent = text || '';
    el.hidden = !text;
    el.className = `text-sm text-center ${kind === 'error' ? 'text-red-300' : kind === 'ok' ? 'text-lime-300' : 'text-white/60'}`;
  }

  function renderEnroll() {
    const p = enrollPerson();
    if (!p) { closeEnroll(); return; }
    const total = (clock.data && clock.data.captures_per_finger) || 3;
    const tope = (clock.data && clock.data.fingers_per_person) || 2;
    const tiene = (p.fingers || []).map((f) => f.finger);
    $('enr-name').textContent = p.name;
    $('enr-consent').hidden = Boolean(p.consent_at);
    $('enr-capture').hidden = !p.consent_at || tiene.length >= tope;
    $('enr-done').hidden = !p.consent_at;

    const sel = $('enr-finger');
    const elegido = sel.value;
    sel.innerHTML = EV2Clock.FINGERS.filter((f) => !tiene.includes(f))
      .map((f) => `<option value="${f}">${escape(t(EV2Clock.fingerKey(f)))}</option>`).join('');
    if (elegido && !tiene.includes(elegido)) sel.value = elegido;
    sel.disabled = clock.enroll.capturing;

    const n = clock.enroll.images.length;
    $('enr-steps').innerHTML = Array.from({ length: total }, (_, i) => `
      <span class="w-4 h-4 rounded-full ${i < n ? 'bg-lime-400' : 'bg-white/15'}"></span>`).join('');
    $('enr-preview').innerHTML = clock.enroll.images.map((img) => `
      <img src="data:image/png;base64,${img}" alt="" class="h-20 w-auto rounded bg-white">`).join('');
    $('btn-enr-start').hidden = clock.enroll.capturing;

    $('enr-fingers').innerHTML = tiene.length ? (p.fingers || []).map((f) => `
      <div class="flex items-center justify-between text-sm rounded-lg bg-white/5 px-3 py-2">
        <span>${escape(t(EV2Clock.fingerKey(f.finger)))}</span>
        <button class="enr-del text-xs text-red-300 px-2" data-finger="${escape(f.finger)}">${escape(t('clk.deleteFinger'))}</button>
      </div>`).join('') : `<p class="text-sm text-white/40">${escape(t('clk.noFingers'))}</p>`;
  }

  async function openEnroll(userId) {
    clock.enroll = { person: userId, images: [], capturing: false, reader: null, sending: false };
    $('enr-pin').value = '';
    $('enr-reader').textContent = '';
    enrollMsg('');
    $('enroll-sheet').hidden = false;
    renderEnroll();
  }

  async function closeEnroll() {
    const r = clock.enroll.reader;
    clock.enroll = { person: null, images: [], capturing: false, reader: null, sending: false };
    if (r) await r.stop();
    $('enroll-sheet').hidden = true;
  }

  const READER_KEYS = {
    starting: 'clk.readerStarting', ready: 'clk.readerReadyEnroll', 'no-reader': 'clk.readerMissing',
    'no-agent': 'clk.agentMissingHere', error: 'clk.readerError',
  };

  async function sendFinger() {
    const p = enrollPerson();
    const finger = $('enr-finger').value;
    clock.enroll.sending = true;
    enrollMsg(t('clk.saving'));
    try {
      const r = await api.post(`/nightclubs/${clubId()}/employees/${p.user_id}/fingerprints`,
        { finger, images: clock.enroll.images });
      enrollMsg(t('clk.saved', { finger: t(EV2Clock.fingerKey(r.fingerprint.finger)) }), 'ok');
      toast(t('clk.saved', { finger: t(EV2Clock.fingerKey(r.fingerprint.finger)) }), 'ok');
    } catch (err) {
      enrollMsg(EV2Format.errorMessage(err), 'error');
    } finally {
      clock.enroll.sending = false;
      clock.enroll.capturing = false;
      clock.enroll.images = [];
      if (clock.enroll.reader) { await clock.enroll.reader.stop(); clock.enroll.reader = null; }
      // El lector ya se apagó: no debe seguir diciendo "pon el dedo".
      $('enr-reader').textContent = '';
      await loadClock();
    }
  }

  $('btn-enr-start').onclick = async () => {
    if (!$('enr-finger').value) return;
    const total = (clock.data && clock.data.captures_per_finger) || 3;
    clock.enroll.images = [];
    clock.enroll.capturing = true;
    enrollMsg(t('clk.captureN', { n: 1, total }));
    renderEnroll();
    clock.enroll.reader = EV2Clock.createReader({
      onStatus: (s) => {
        $('enr-reader').textContent = t(READER_KEYS[s] || 'clk.readerError');
        if (s === 'no-agent' || s === 'no-reader') {
          clock.enroll.capturing = false;
          renderEnroll();
        }
      },
      onQuality: () => enrollMsg(t('clk.badQuality'), 'error'),
      onSample: (png) => {
        if (!clock.enroll.capturing || clock.enroll.sending) return;
        clock.enroll.images.push(png);
        renderEnroll();
        if (clock.enroll.images.length >= total) { sendFinger(); return; }
        enrollMsg(t('clk.captureN', { n: clock.enroll.images.length + 1, total }));
      },
    });
    await clock.enroll.reader.start();
  };

  $('btn-enr-accept').onclick = async () => {
    const p = enrollPerson();
    const pin = $('enr-pin').value.trim();
    if (!/^\d{6}$/.test(pin)) { enrollMsg(t('clk.pinSix'), 'error'); return; }
    const listo = ocupado($('btn-enr-accept'), 'prn.saving');
    try {
      await api.post(`/nightclubs/${clubId()}/employees/${p.user_id}/biometric-consent`, { pin });
      $('enr-pin').value = '';
      enrollMsg(t('clk.consentOk'), 'ok');
      await loadClock();
    } catch (err) {
      enrollMsg(EV2Format.errorMessage(err), 'error');
    } finally {
      listo();
    }
  };

  $('enr-fingers').onclick = async (e) => {
    const b = e.target.closest('.enr-del');
    if (!b) return;
    const p = enrollPerson();
    if (!(await ask(t('clk.deleteFingerAsk', { finger: t(EV2Clock.fingerKey(b.dataset.finger)) })))) return;
    try {
      await api.del(`/nightclubs/${clubId()}/employees/${p.user_id}/fingerprints/${b.dataset.finger}`);
      await loadClock();
    } catch (err) { showError(err); }
  };

  $('btn-enr-revoke').onclick = async () => {
    const p = enrollPerson();
    if (!(await ask(t('clk.revokeConsentAsk', { name: p.name })))) return;
    try {
      await api.del(`/nightclubs/${clubId()}/employees/${p.user_id}/biometric-consent`);
      toast(t('clk.consentRevoked'), 'ok');
      await loadClock();
    } catch (err) { showError(err); }
  };

  $('clk-people').onclick = (e) => {
    const b = e.target.closest('.clk-person');
    if (b) openEnroll(b.dataset.id);
  };
  $('btn-enr-close').onclick = () => closeEnroll();

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
        if (!(await ask(t('pay.confirmVerify')))) return;
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
        b.onclick = async () => {
          const reason = (await askText(t('pay.reason')));
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
        b.onclick = async () => {
          const reference = (await askText(t('pay.reference'))) || '';
          // Sin referencia no se puede conciliar tres semanas después, cuando el
          // empleado dice que nunca le llegó. Se advierte, no se impone.
          const warn = EV2Payouts.payWarning(w, reference);
          if (warn && !(await ask(t(warn)))) return;
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
      count.textContent = Number(actions.booked) === 1
        ? t('mgr.nightBooking1') : t('night.reservations', { count: actions.booked });
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
        add('night.cancelNight', 'card rounded-lg px-3 py-2 text-sm text-red-300 flex-1', async (b) => {
          if (!(await ask(t('night.confirmCancel'), { danger: true }))) return;
          setNightStatus(night, 'cancelled', 'night.cancelled', b);
        });
      }
      if (actions.canDelete) {
        add('night.delete', 'card rounded-lg px-3 py-2 text-sm text-red-300', (b) => deleteNight(night, b));
      }
      // El corte y el rol viven en la noche a la que pertenecen, no en una pestaña
      // aparte: el gerente piensa "cómo salió el viernes", no "abre el reporte".
      add('night.cutOpen', 'card rounded-lg px-3 py-2 text-sm flex-1', () => openCut(night));
      add('roster.open', 'card rounded-lg px-3 py-2 text-sm flex-1', () => openRoster(night));
      // Duplicar (D88): la misma noche una semana después, en el formulario para revisarla.
      add('night.duplicate', 'card rounded-lg px-3 py-2 text-sm flex-1', () => duplicateNight(night));

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
    `${p.display_name} · ${t('night.cutTips')}`, money(p.total, cur), 'text-white/50',
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
    if (!(await ask(t('cut.confirmClose')))) return;
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
    state.roster = { night, roster: [], gaps: { sections: [], bars: [], tills: [] } };
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
      r.gaps = data.gaps || { sections: [], bars: [], tills: [] };
    } catch (err) {
      showError(err, $('roster-error'));
      return;
    }
    renderRoster();
  }

  /**
   * Copiar el rol de la noche anterior (D88). Se manda asignación por asignación: el
   * servidor revisa cada una, y lo que rechace (alguien dado de baja, una barra que ya
   * no existe) se cuenta y se dice, sin tumbar las demás.
   */
  async function copyPreviousRoster() {
    const r = state.roster;
    if (!r) return;
    const anterior = EV2Manager.previousNight(state.nights, r.night);
    if (!anterior) { toast(t('roster.noPrevious'), 'error'); return; }
    const boton = $('btn-roster-copy');
    boton.disabled = true;
    try {
      const data = await api.get(`/nightclubs/${clubId()}/nights/${anterior.id}/roster`);
      const plan = EV2Roster.copyPlan(data.roster || [], r.roster);
      if (plan.length === 0) { toast(t('roster.copyNothing', { name: anterior.name }), 'info'); return; }
      let ok = 0; let fallaron = 0;
      for (const body of plan) {
        try {
          // eslint-disable-next-line no-await-in-loop
          await api.post(`/nightclubs/${clubId()}/nights/${r.night.id}/roster`, body);
          ok += 1;
        } catch { fallaron += 1; }
      }
      toast(t(fallaron ? 'roster.copiedSome' : 'roster.copied', { n: ok, failed: fallaron, name: anterior.name }),
        fallaron ? 'info' : 'ok');
      await reloadRoster();
    } catch (err) {
      showError(err, $('roster-error'));
    } finally { boton.disabled = false; }
  }
  if ($('btn-roster-copy')) $('btn-roster-copy').onclick = copyPreviousRoster;

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
      }))}${avance.missing_tills ? ` · ${escape(t('roster.missingTills', { n: avance.missing_tills }))}` : ''}</span>`;

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
    if (!(await ask(t('night.confirmDelete'), { danger: true }))) return;
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

  /** Llena el formulario de "Abrir una noche" con la misma noche una semana después. */
  function duplicateNight(night) {
    const v = EV2Manager.duplicateNight(night);
    if (!v) return;
    $('n-name').value = v.name;
    $('n-date').value = v.event_date;
    $('n-doors').value = v.doors_open_at;
    $('n-closes').value = v.closes_at;
    $('n-price').value = v.ticket_price;
    if (v.arrival_deadline_minutes) $('n-deadline').value = v.arrival_deadline_minutes;
    $('n-deposit').value = v.deposit_pct;
    clearNightErrors();
    $('night-form').hidden = false;
    $('night-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
    toast(t('night.duplicated'), 'info');
  }

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

  /**
   * Lo que se vuelve a pedir al abrir cada sección (D88). Antes había un botón
   * "Actualizar" en siete tarjetas; los avisos en vivo ya refrescan todo, y al entrar a
   * una sección se pide lo suyo por si la conexión estuvo caída.
   */
  // ---------------------------------------------------------------- notificaciones (D91)

  let pushStatus = null;
  async function loadPushStatus() {
    try {
      pushStatus = await api.get(`/nightclubs/${clubId()}/push/status`);
    } catch (err) { pushStatus = null; showError(err); }
    renderPushStatus();
  }

  function renderPushStatus() {
    const s = pushStatus;
    const pill = $('ps-pill');
    if (!s) { pill.textContent = '—'; return; }
    pill.textContent = t(s.enabled ? 'ps.on' : 'ps.off');
    pill.className = `pill ${s.enabled ? 'pill-ok' : 'pill-off'}`;
    $('ps-state').textContent = t(s.enabled ? 'ps.stateOn' : 'ps.stateOff');
    const roles = s.by_role || [];
    $('ps-roles').innerHTML = roles.length ? roles.map((r) => `
      <div class="stat-card">
        <div class="stat-number">${escape(r.people)}</div>
        <div class="stat-label">${escape(EV2Roles.describe(r.role, lang()).label)}</div>
      </div>`).join('')
      : `<p class="text-xs text-white/40 col-span-full">${escape(t('ps.noDevices'))}</p>`;
    const mine = s.mine || {};
    $('ps-mine').textContent = mine.receiving_now
      ? t('ps.mineOk', { n: mine.devices })
      : t(`ps.why.${mine.reason || 'no_devices'}`);
    $('btn-ps-test').disabled = !s.enabled;
  }

  $('btn-ps-test').onclick = async () => {
    const listo = ocupado($('btn-ps-test'), 'ps.testing');
    try {
      const r = await EV2Push.testHere(api);
      if (r.ok) toast(t('ps.testOk', { n: r.sent }), 'ok');
      else toast(t(`ps.fail.${r.reason}`) || t('push.failed'), 'error');
    } catch (err) {
      showError(err);
    } finally {
      listo();
      loadPushStatus();
    }
  };

  const TAB_LOADERS = {
    summary: () => Promise.all([loadTills()]),
    cash: () => Promise.all([loadShiftCuts(), loadTerminalCharges(), loadTips(), loadTills()]),
    lost: () => loadLostFound(),
    club: () => Promise.all([loadExchangeRate(), loadTerminals(), loadPrinting(), loadPushStatus()]),
    printing: () => loadPrinting(),
  };

  function goTab(tab) {
    state.tab = TAB_ALIAS[tab] || tab;
    renderAll();
    const cargar = TAB_LOADERS[state.tab];
    if (cargar) cargar().then(renderAll).catch(() => {});
    // Al cambiar de seccion se empieza arriba, y en el telefono la pestana elegida se
    // asoma completa aunque estuviera al final del renglon.
    const main = document.querySelector('.mgr-main');
    if (main) main.scrollTop = 0;
    if (typeof window.scrollTo === 'function') { try { window.scrollTo(0, 0); } catch { /* jsdom */ } }
    const btn = document.querySelector(`[data-tab="${tab}"]`);
    if (btn && typeof btn.scrollIntoView === 'function') btn.scrollIntoView({ block: 'nearest', inline: 'center' });
  }

  document.querySelectorAll('[data-tab]').forEach((b) => {
    b.onclick = () => goTab(b.dataset.tab);
  });

  /** La bandeja de pendientes (D75): lo que pide una accion del gerente, en un lugar. */
  function renderInbox() {
    const s = EV2Manager.summary(state.dashboard, state.currency);
    const items = EV2Manager.pendingWork({
      withdrawals: state.withdrawals, accounts: state.accounts, tips: state.tips,
      reports: state.reports, lostFound: state.lostFound, nights: state.nights,
      posErrors: s.orders.posErrors,
    });
    const total = items.reduce((n, i) => n + i.count, 0);
    $('inbox-total').textContent = String(total);
    $('inbox-total').className = `pill ${items.some((i) => i.urgent) ? 'pill-bad' : total ? 'pill-wait' : 'pill-ok'}`;
    $('inbox-count').hidden = total === 0;
    $('inbox-count').textContent = String(total);
    $('inbox-empty').hidden = items.length > 0;
    const box = $('inbox-list');
    box.innerHTML = '';
    for (const item of items) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = `w-full flex items-center justify-between gap-3 rounded-xl px-4 py-3 text-left ${item.urgent ? 'btn-danger' : 'btn-secondary'}`;
      const label = document.createElement('span');
      label.className = 'text-sm';
      label.textContent = t(item.key, { n: item.count });
      const go = document.createElement('span');
      go.className = 'text-xs text-white/50 shrink-0';
      go.innerHTML = '<i class="fa-solid fa-chevron-right"></i>';
      row.append(label, go);
      // Si ya esta en esta pestana (los pedidos rechazados viven en Turno), no se mueve.
      row.onclick = () => { if (item.tab !== state.tab) goTab(item.tab); };
      box.appendChild(row);
    }
  }

  function renderSummary() {
    renderTonight();
    renderTills();
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

    // El alta se abre con su botón (D88), solo en la vista donde tiene sentido, y los
    // filtros solo existen en Existencias.
    const puedeAlta = state.invView === 'stock' || state.invView === 'menu';
    if ($('btn-inv-add')) {
      $('btn-inv-add').hidden = !puedeAlta;
      $('btn-inv-add-label').textContent = t(state.invView === 'menu' ? 'inv.menuNew' : 'sup.new');
    }
    if ($('menu-add')) $('menu-add').hidden = !(state.invAddOpen && state.invView === 'menu');
    if ($('sup-add')) $('sup-add').hidden = !(state.invAddOpen && state.invView === 'stock');
    if ($('inv-filters')) $('inv-filters').hidden = state.invView !== 'stock';
    for (const b of document.querySelectorAll('[data-invf]')) {
      b.classList.toggle('on', b.dataset.invf === state.invFilter);
    }

    if (state.invView === 'recipes') return renderRecipeList();
    if (state.invView === 'kardex') return renderKardex();
    if (state.invView === 'menu') return renderMenuList();
    return renderStockList();
  }

  function invEmpty(message) {
    $('inv-list').innerHTML = '';
    $('inv-empty').textContent = message;
    $('inv-empty').hidden = false;
  }

  const invMatches = (text) => !state.invSearch
    || String(text || '').toLowerCase().includes(state.invSearch);

  /**
   * Existencias (D88): un renglón por insumo, compacto. El total, cada estante con lo
   * que tiene, y su mínimo ahí mismo — se guarda al salir del campo. Antes eran 88
   * tarjetas grandes con un botón "Mínimo" que preguntaba el estante con un número.
   */
  function renderStockList() {
    let list = state.supplies.filter((x) => invMatches(x.name) || invMatches(x.category));
    if (state.invFilter === 'low') list = list.filter((x) => x.low);
    if (state.invFilter === 'unconfirmed') list = list.filter((x) => x.size_confirmed === false);
    if (list.length === 0) {
      return invEmpty(t(state.invFilter === 'all' ? 'inv.emptyStock' : 'inv.emptyFilter'));
    }
    $('inv-empty').hidden = true;
    const estantes = (state.locations || []).filter((l) => l.kind === 'bar' || l.kind === 'warehouse');

    $('inv-list').innerHTML = EV2Warehouse.byCategory(list).map((group) => `
      <section class="mb-2">
        <h3 class="text-xs uppercase tracking-widest text-white/40 mb-1 px-1">${escape(group.category)} · ${group.items.length}</h3>
        <div class="card rounded-xl divide-y divide-white/5">
          ${group.items.map((supply) => `
            <div class="px-3 py-2 flex flex-wrap items-center gap-x-4 gap-y-1 ${supply.low ? 'border-l-4 border-amber-400' : ''}">
              <div class="min-w-[12rem] flex-1">
                <p class="text-sm font-semibold leading-tight">${escape(supply.name)}
                  ${supply.size_confirmed === false ? `<span class="text-pink-300 text-[11px]">· ${escape(t('inv.confirmSize'))}</span>` : ''}</p>
                <p class="text-[11px] text-white/50">${escape(EV2Warehouse.describeStock(supply, supply.stock, lang()))} · ${escape(money(supply.stock_value, 'MXN'))}</p>
              </div>
              <div class="flex flex-wrap gap-2">
                ${estantes.map((place) => {
                  const aqui = (supply.locations || []).find((l) => l.location_id === place.id);
                  const hay = aqui ? EV2Warehouse.packagesOf(aqui.stock, supply.package_size) : 0;
                  const min = aqui ? EV2Warehouse.packagesOf(aqui.min_stock, supply.package_size) : 0;
                  const bajo = aqui && Number(aqui.min_stock) > 0 && Number(aqui.stock) < Number(aqui.min_stock);
                  return `
                  <label class="text-[11px] rounded-lg px-2 py-1 flex items-center gap-1.5 ${bajo ? 'bg-amber-500/15 text-amber-200' : 'bg-white/5 text-white/60'}" title="${escape(t('inv.minHint'))}">
                    <span class="truncate max-w-[7rem]">${escape(place.name)}</span>
                    <b class="text-white">${escape(String(hay))}</b>
                    <span class="text-white/40">${escape(t('inv.minShort'))}</span>
                    <input type="number" min="0" step="1" inputmode="decimal" value="${escape(String(min))}"
                           data-min-supply="${escape(supply.id)}" data-min-place="${escape(place.id)}"
                           class="w-12 bg-transparent border-b border-white/20 text-center text-white outline-none focus:border-cyan-400">
                  </label>`;
                }).join('')}
              </div>
            </div>`).join('')}
        </div>
      </section>`).join('');

    for (const input of $('inv-list').querySelectorAll('[data-min-supply]')) {
      input.onchange = () => saveMinimum(input);
    }
  }

  /**
   * Guarda un mínimo desde su campo. Se escribe en presentaciones ("dos botellas") y se
   * manda en unidad base, que es lo que entiende el inventario.
   */
  async function saveMinimum(input) {
    const supply = state.supplies.find((x) => x.id === input.dataset.minSupply);
    if (!supply) return;
    const packages = Number(input.value);
    if (!Number.isFinite(packages) || packages < 0) { toast(t('inv.badMin'), 'error'); return; }
    input.disabled = true;
    try {
      const { supply: updated } = await api.put(
        `/nightclubs/${clubId()}/supplies/${supply.id}/min-stock`,
        { location_id: input.dataset.minPlace, min_stock: packages * Number(supply.package_size) });
      state.supplies = state.supplies.map((x) => (x.id === updated.id ? updated : x));
      toast(t('inv.minSaved'), 'ok');
      renderInventory();
    } catch (err) {
      showError(err);
      input.disabled = false;
    }
  }

  /** Recetas: primero lo que no tiene, despues lo de menor margen. */
  /**
   * La carta: el precio de cada trago y si está a la venta (D66).
   *
   * Hasta ahora dar de alta un trago o cambiar un precio se hacía a mano en la base de
   * datos. Las dos rutas existían desde el principio y no tenían pantalla.
   *
   * El precio se edita EN LA LISTA y se guarda al salir del campo: abrir una hoja para
   * cambiar un número es el tipo de fricción que hace que nadie corrija un precio mal
   * puesto, y un precio mal puesto se cobra toda la noche.
   */
  function renderMenuList() {
    const lista = (state.drinks || [])
      .filter((d) => invMatches(d.name) || invMatches(d.category));
    if (lista.length === 0) return invEmpty(t('inv.emptyMenu'));
    $('inv-empty').hidden = true;

    const caja = $('inv-list');
    caja.innerHTML = '';
    for (const trago of lista) {
      const card = document.createElement('article');
      card.className = `card rounded-xl px-3 py-2 flex items-center gap-3 ${trago.available ? '' : 'opacity-50'}`;

      const izq = document.createElement('div');
      izq.className = 'min-w-0 flex-1';
      const nombre = document.createElement('p');
      nombre.className = 'text-sm font-semibold truncate';
      nombre.textContent = trago.name;
      const cat = document.createElement('p');
      cat.className = 'text-xs text-white/50 truncate';
      cat.textContent = [trago.category, trago.available ? '' : t('inv.menuOff')]
        .filter(Boolean).join(' · ');
      izq.append(nombre, cat);

      const precio = document.createElement('input');
      precio.type = 'number';
      precio.min = '0';
      precio.step = '1';
      precio.className = 'field w-24 text-right shrink-0';
      precio.value = Number(trago.price);
      precio.onchange = async () => {
        const nuevo = Number(precio.value);
        if (!Number.isFinite(nuevo) || nuevo < 0) { precio.value = Number(trago.price); return; }
        if (nuevo === Number(trago.price)) return;
        // Se pregunta con el precio viejo y el nuevo: este número se le cobra al
        // cliente en la siguiente ronda, y un dedazo aquí no avisa de ninguna otra forma.
        if (!(await ask(t('inv.menuPriceAsk', {
          name: trago.name, from: money(trago.price, 'MXN'), to: money(nuevo, 'MXN'),
        })))) { precio.value = Number(trago.price); return; }
        precio.disabled = true;
        try {
          await api.patch(`/nightclubs/${clubId()}/drinks/${trago.id}`, { price: nuevo });
          toast(t('inv.menuSaved'), 'ok');
          await loadMenu();
        } catch (err) {
          precio.value = Number(trago.price);
          showError(err);
        } finally { precio.disabled = false; }
      };

      const prender = document.createElement('button');
      prender.className = 'card rounded-lg px-3 py-2 text-xs shrink-0';
      prender.textContent = t(trago.available ? 'inv.menuTurnOff' : 'inv.menuTurnOn');
      prender.onclick = async () => {
        const listo = ocupado(prender, 'prn.saving');
        try {
          await api.patch(`/nightclubs/${clubId()}/drinks/${trago.id}`,
            { available: !trago.available });
          await loadMenu();
        } catch (err) { listo(); showError(err); }
      };

      card.append(izq, precio, prender);
      caja.appendChild(card);
    }
  }

  /** Vuelve a traer la carta y repinta. Se usa tras cada cambio. */
  async function loadMenu() {
    const d = await api.get(`/nightclubs/${clubId()}/drinks`);
    state.drinks = d.drinks || [];
    renderInventory();
  }

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

  $('btn-menu-add').onclick = async () => {
    const nombre = $('menu-name').value.trim();
    const precio = Number($('menu-price').value);
    const categoria = $('menu-category').value.trim();
    const error = $('menu-error');
    error.hidden = true;
    // Se comprueba aquí lo que el servidor va a comprobar: los tres campos son
    // obligatorios allá, y un 400 después de teclear se lee como "algo salió mal".
    if (!nombre) return avisar(error, t('inv.menuErrName'));
    if (!categoria) return avisar(error, t('inv.menuErrCategory'));
    if (!Number.isFinite(precio) || precio < 0) return avisar(error, t('inv.menuErrPrice'));

    const listo = ocupado($('btn-menu-add'), 'inv.menuAdding');
    try {
      await api.post(`/nightclubs/${clubId()}/drinks`,
        { name: nombre, category: categoria, price: precio });
      $('menu-name').value = '';
      state.invAddOpen = false;
      $('menu-price').value = '';
      // La categoría se queda: dar de alta la carta es teclear diez tragos de la misma.
      toast(t('inv.menuAdded'), 'ok');
      await loadMenu();
    } catch (err) {
      showError(err, error);
    } finally { listo(); }
    return undefined;
  };

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
  for (const b of document.querySelectorAll('[data-invf]')) {
    b.onclick = () => { state.invFilter = b.dataset.invf; renderInventory(); };
  }
  if ($('btn-inv-add')) {
    $('btn-inv-add').onclick = () => {
      state.invAddOpen = !state.invAddOpen;
      renderInventory();
      const form = $(state.invView === 'menu' ? 'menu-add' : 'sup-add');
      if (state.invAddOpen && form) {
        const first = form.querySelector('input');
        if (first) first.focus();
      }
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

  // ---------------------------------------------------------------- sustituir (D84)

  let subMgr = null;
  $('sub-box').addEventListener('toggle', async () => {
    if (!$('sub-box').open) return;
    if (!subMgr) {
      subMgr = EV2Substitutions.createPanel($('sub-mgr-panel'), {
        api,
        clubId,
        t,
        toast,
        errorMessage: (err) => EV2Format.errorMessage(err),
        bars: () => (state.locations || []).filter((l) => l.kind === 'bar'),
        barId: () => null,
        time: (d) => new Date(d).toLocaleTimeString(EV2Format.getLanguage() === 'en' ? 'en-US' : 'es-MX',
          { hour: '2-digit', minute: '2-digit' }),
      });
    }
    await subMgr.load();
  });

  // ---------------------------------------------------------------- tiempo real

  const lastConnection = { on: false, key: 'realtime.reconnecting', vars: null };

  function setConnection(on, key, vars) {
    lastConnection.on = on;
    lastConnection.key = key;
    lastConnection.vars = vars || null;
    $('rt-dot').className = `dot ${on === true ? 'dot-on' : on === null ? 'dot-wait' : 'dot-off'}`;
    // Conectado: basta el punto verde (D88). Sin conexión sí se dice, sin la cuenta
    // regresiva que cambiaba cada segundo: los números pueden estar viejos.
    $('rt-text').textContent = on === null ? t('realtime.reconnecting') : t(key);
    $('rt-text').classList.toggle('sr-only', on === true);
    const box = $('rt-text').parentElement;
    if (box) box.title = vars && vars.text ? vars.text : t(key);
  }

  function connectRealtime() {
    const rt = api.createRealtime();
    // Al reconectar o al volver al teléfono tras unos segundos, ponerse al día (D91).
    rt.onCatchUp(() => loadAll());
    // Cada aviso de este puesto suena, vibra y sale arriba con la pantalla abierta (D93).
    EV2Push.listen(rt, { toast });
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
      if (subMgr) subMgr.onEvent(message);
      if (!EV2Manager.affectsModeration(message)) return;
      await loadReports();
      renderReports();
      toast(t('mod.arrived'), 'error');
    });

    rt.on('event', (message) => {
      // Un aviso personal (D93) no cambia ningún dato: no hay nada que recargar.
      if (message && message.event_type === 'notice') return;
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
