/**
 * EV2 — panel del gerente (paso 5.5).
 *
 * Conecta el DOM con `EV2` (API y socket), `EV2Manager` (los números y las validaciones)
 * y `EV2Roles`. Cubre lo que el dueño dejó para configurar después: conductores, zonas y
 * tarifas del taxi, y los cajones del estacionamiento — más el resumen del turno.
 */
/* global EV2Push, EV2, EV2Format, EV2Manager, EV2Warehouse, EV2Roles, EV2PasswordGate, EV2StaffAdmin,
   EV2Payouts, EV2NightReport, EV2Roster, EV2TillSetup, EV2Clock, EV2Deposit, EV2Purchasing */
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
    supplies: [], locations: [], recipes: [], movements: [], mixers: [],
    // Hasta que el inventario llegue de la API, la pestana NO pinta ceros: un
    // "MX$0.00" mientras carga no es "cargando", es un dato falso, y el gerente que
    // lo alcanza a leer se lleva la idea de que la bodega esta vacia.
    invLoaded: false,
    invView: 'stock', invSearch: '', invFilter: 'all', invAddOpen: false,
    staffSearch: '', staffRole: null,
    recipe: null,   // { drink_id, name, price, lines: [{supply_id, quantity}] }
    // D95: el insumo abierto en la hoja de edición, y los dados de baja. Los inactivos
    // se piden aparte y solo al abrir su filtro: `supplies` sigue siendo lo vigente,
    // que es lo que alimenta el valor del inventario y el selector de recetas.
    supEdit: null, inactiveSupplies: [], inactiveLoaded: false,
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
    // Lo apagado se archiva y no se enseña (D125), salvo que el gerente lo pida.
    showArchived: false,
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
  const PURPOSE_KEY = {
    orders: 'prn.pOrders', service: 'prn.pService', till: 'prn.pTill', door: 'prn.pDoor',
  };

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
    $('btn-venue-editor').hidden = role !== 'admin';
    // Mi consumo (D116): el gerente pide para sí; el admin es el dueño, no lleva descuento.
    if ($('btn-my-consumption')) $('btn-my-consumption').hidden = role !== 'manager';
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
      loadDepositQueue(),
      loadExchangeRate(),
      loadTills(),
      loadWaiters(),
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
      // Servicio de botella (D117): el catálogo de mezcladores, incluidos los apagados.
      get(`/nightclubs/${club}/bottle-mixers`, (d) => { state.mixers = d.mixers || []; }),
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
    tmon: ['tab-tmon'],
    cash: ['tab-cash'],
    lost: ['tab-lost'],
    reports: ['tab-reports'],
    nights: ['tab-nights'],
    staff: ['tab-staff'],
    staffcons: ['tab-staffcons'],
    promos: ['tab-promos'],
    tableprice: ['tab-tableprice'],
    inventory: ['tab-inventory'],
    purchasing: ['tab-purchasing'],
    payouts: ['tab-payouts'],
    club: ['tab-club'],
    exit: ['tab-drivers', 'tab-taxi'],
    parking: ['tab-parking'],
    printing: ['tab-printing'],
    tills: ['tab-tills'],
    clock: ['tab-clock'],
    rps: ['tab-rps'],
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
    renderStaffCons();
    renderPromos();
    renderTablePrices();
    renderPayouts();
    renderReports();
    renderCoverQuick();
    renderDrivers();
    renderTaxi();
    renderParking();
    renderInventory();
    renderPrinting();
    renderClock();
    renderRps();
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

  // ---------------------------------------------------------------- meseros: saldo y tope (D110)

  async function loadWaiters() {
    if (!$('w-list')) return;
    try {
      const [bal, ctl] = await Promise.all([
        api.get(`/nightclubs/${clubId()}/waiters/balances`),
        api.get(`/nightclubs/${clubId()}/reports/control`),
      ]);
      const lim = bal.limits || {};
      if (document.activeElement !== $('w-amount')) $('w-amount').value = lim.max_unpaid_amount ? Number(lim.max_unpaid_amount) : '';
      if (document.activeElement !== $('w-minutes')) $('w-minutes').value = lim.max_unpaid_minutes || '';
      const ws = bal.waiters || [];
      $('w-empty').hidden = ws.length > 0;
      $('w-list').innerHTML = ws.map((w) => `
        <div class="rounded-xl p-3 flex justify-between gap-2" style="background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08)">
          <div class="min-w-0"><p class="font-semibold truncate">${escape(w.name)}</p>
            <p class="text-xs text-white/50">${escape(t('mgr.wOldest', { n: w.oldest_delivered_minutes }))}</p></div>
          <div class="text-right"><p class="font-semibold">${escape(money(w.delivered_unpaid_total, 'MXN'))}</p>
            ${w.over_limit ? `<span class="pill pill-bad">${escape(t('mgr.wOver'))}</span>` : ''}</div>
        </div>`).join('');
      $('w-control').innerHTML = (ctl.people || []).map((p) => `<p>${escape(t('mgr.wControlRow', {
        name: p.name, c: p.cancellations, m: p.wastes, d: p.door_courtesies,
        s: p.cut_differences, v: p.manual_vouchers }))}</p>`).join('');
    } catch { /* la tarjeta queda como estaba */ }
  }

  if ($('w-form')) {
    $('w-form').onsubmit = async (e) => {
      e.preventDefault();
      const num = (id) => (($(id).value || '').trim() === '' ? null : Number($(id).value));
      try {
        await api.put(`/nightclubs/${clubId()}/waiter-limits`, {
          max_unpaid_amount: num('w-amount'), max_unpaid_minutes: num('w-minutes') });
        toast(t('mgr.wSaved'), 'ok');
        loadWaiters();
      } catch (err) { toast(err.message, 'error'); }
    };
  }

  // ---------------------------------------------------------------- monitor de mesas (D113)

  const tmon = { tables: [], detail: null, history: [], error: null };
  const TMON_IDLE_KEY = 'ev2.tmon.idle';

  async function loadMonitor() {
    try {
      const data = await api.get(`/nightclubs/${clubId()}/tables/monitor`);
      tmon.tables = data.tables || [];
      tmon.error = null;
      if (tmon.detail) {
        const h = await api.get(`/nightclubs/${clubId()}/tables/${tmon.detail}/history`);
        tmon.history = h.sessions || [];
      }
    } catch (err) { tmon.error = err.message; }
    renderMonitor();
  }

  const TMON_TONE = { occupied: 'pill-on', available: 'pill-ok', reserved: 'pill-wait', blocked: 'pill-bad', cleaning: 'pill-bad' };

  function renderMonitor() {
    if (!$('tmon-grid')) return;
    const idleMin = Number($('tmon-idle').value) || 0;
    const soloVip = $('tmon-vip').checked;
    const list = tmon.tables.filter((x) => !soloVip || x.is_vip);
    $('tmon-error').hidden = !tmon.error;
    $('tmon-error').textContent = tmon.error || '';
    $('tmon-empty').hidden = list.length > 0;
    const ocupadas = tmon.tables.filter((x) => x.status === 'occupied');
    $('tmon-stats').innerHTML = [
      t('tmon.statOcc', { n: ocupadas.length, total: tmon.tables.length }),
      t('tmon.statVip', { n: ocupadas.filter((x) => x.is_vip).length, total: tmon.tables.filter((x) => x.is_vip).length }),
    ].map((x) => `<span class="pill pill-off">${escape(x)}</span>`).join('');
    $('tmon-grid').innerHTML = list.map((x) => {
      const sinConsumo = idleMin > 0 && x.status === 'occupied' && Number(x.total) === 0
        && (x.minutes_seated || 0) >= idleMin;
      return `
      <button class="card rounded-xl p-3 text-left space-y-1.5" data-tmon="${escape(x.id)}"
              style="${sinConsumo ? 'border:1px solid #f59e0b' : ''}">
        <div class="flex items-start justify-between gap-2">
          <div class="min-w-0"><p class="font-semibold truncate">${x.is_vip ? '★ ' : ''}${escape(x.code)}</p>
            <p class="text-xs text-white/50 truncate">${escape(x.section || '')}</p></div>
          <span class="pill ${TMON_TONE[x.status] || 'pill-off'} shrink-0">${escape(t(`tmon.st.${x.status}`))}</span>
        </div>
        ${x.status === 'occupied' ? `
          <div class="flex justify-between text-xs"><span class="text-white/50">${escape(t('tmon.guests', { n: x.guests }))}</span>
            <span>${escape(t('tmon.since', { n: x.minutes_seated }))}</span></div>
          <div class="flex justify-between text-sm"><span class="text-white/60">${escape(t('tmon.consumed'))}</span>
            <span class="font-semibold">${escape(money(x.total, x.currency || state.currency))}</span></div>
          ${sinConsumo ? `<p class="text-[11px] text-amber-300">${escape(t('tmon.noOrders'))}</p>` : ''}` : ''}
      </button>`;
    }).join('');
    document.querySelectorAll('[data-tmon]').forEach((b) => {
      b.onclick = async () => { tmon.detail = b.dataset.tmon; await loadMonitor(); };
    });

    const det = tmon.detail && tmon.tables.find((x) => x.id === tmon.detail);
    $('tmon-detail').hidden = !det;
    if (!det) return;
    $('tmon-detail').innerHTML = `
      <div class="flex justify-between items-baseline">
        <p class="font-display text-lg">${escape(t('tmon.history', { code: det.code }))}</p>
        <button data-tmon-close class="text-xs underline text-white/60">${escape(t('tmon.close'))}</button>
      </div>
      ${tmon.history.length ? tmon.history.map((h) => `
        <div class="rounded-xl p-3 space-y-1" style="background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08)">
          <div class="flex justify-between text-xs text-white/60">
            <span>${escape(EV2Format.dateTime(h.started_at))} → ${escape(h.ended_at ? EV2Format.dateTime(h.ended_at) : t('tmon.now'))}</span>
            <span>${escape(t('tmon.guests', { n: h.guests }))}</span></div>
          ${(h.lines || []).map((l) => `<div class="flex justify-between text-sm"><span>${escape(l.quantity)} × ${escape(l.name)}</span><span>${escape(money(l.amount, h.currency || state.currency))}</span></div>`).join('')
            || `<p class="text-xs text-white/40">${escape(t('tmon.noConsumption'))}</p>`}
          <div class="flex justify-between text-sm font-semibold"><span>${escape(t('tmon.total'))}</span><span>${escape(money(h.total, h.currency || state.currency))}</span></div>
        </div>`).join('') : `<p class="text-sm text-white/50">${escape(t('tmon.noHistory'))}</p>`}`;
    $('tmon-detail').querySelector('[data-tmon-close]').onclick = () => { tmon.detail = null; tmon.history = []; renderMonitor(); };
  }

  if ($('tmon-idle')) {
    try { $('tmon-idle').value = localStorage.getItem(TMON_IDLE_KEY) || ''; } catch { /* sin almacenamiento */ }
    $('tmon-idle').onchange = () => {
      try { localStorage.setItem(TMON_IDLE_KEY, $('tmon-idle').value); } catch { /* sin almacenamiento */ }
      renderMonitor();
    };
    $('tmon-vip').onchange = renderMonitor;
  }

  const TONE_PILL = { ok: 'pill-ok', bad: 'pill-bad', wait: 'pill-wait', on: 'pill-on' };

  function tillCard(c) {
    const st = EV2Manager.tillState(c);
    // Dólares: si entraron o si la caja abrió con dólares (D118).
    const usd = Number(c.usd_received) > 0 || Number(c.opening_float_usd) > 0
      ? `<div class="flex justify-between text-xs"><span class="text-white/50">${escape(t('mgr.tillUsd'))}</span><span>US$${escape(Number(c.usd_to_hand).toFixed(2))}</span></div>` : '';
    const fondoUsd = Number(c.opening_float_usd) > 0 ? ` + US$${Number(c.opening_float_usd).toFixed(2)}` : '';
    const fondo = Number(c.opening_float) > 0 || fondoUsd
      ? `<div class="flex justify-between text-xs"><span class="text-white/50">${escape(t('mgr.tillFloat'))}</span><span>${escape(money(c.opening_float, c.currency))}${escape(fondoUsd)}</span></div>` : '';
    // La caja de Cover (D118): cuánta gente entró por ella.
    const puerta = c.location_kind === 'door'
      ? `<div class="flex justify-between text-xs"><span class="text-white/50">${escape(t('mgr.tillDoorPeople'))}</span><span>${escape(t('mgr.tillDoorPeopleN', { n: c.door_people || 0 }))}</span></div>` : '';
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
        ${fondo}${puerta}
        <div class="flex justify-between text-xs"><span class="text-white/50">${escape(t('mgr.tillCollected'))}</span><span>${escape(money(c.collected, c.currency))}</span></div>
        <div class="flex justify-between text-sm"><span class="text-white/60">${escape(t('mgr.tillToHand'))}</span><span class="font-semibold">${escape(money(c.cash_to_hand, c.currency))}</span></div>
        ${usd}${dif}
        ${c.closed ? '' : `<button type="button" class="card rounded-lg px-3 py-1.5 text-xs" data-xreport="${escape(c.shift_id)}" data-name="${escape(c.location_name)}">${escape(t('mgr.tillXReport'))}</button>`}
      </div>`;
  }

  function renderTills() {
    const list = state.tills || [];
    for (const [box, empty] of [['s-tills', 's-tills-empty'], ['c-tills', 'c-tills-empty']]) {
      if (!$(box)) continue;
      $(box).innerHTML = list.map(tillCard).join('');
      $(empty).hidden = list.length > 0;
      // El corte X de una caja abierta (D122): sale en la impresora de esa caja.
      for (const b of $(box).querySelectorAll('[data-xreport]')) {
        b.onclick = async () => {
          const listo = ocupado(b, 'prn.sending');
          try {
            await api.post(`/nightclubs/${clubId()}/tills/${b.dataset.xreport}/x-report`, {});
            toast(t('mgr.tillXSent', { name: b.dataset.name }), 'ok');
          } catch (err) { showError(err); } finally { listo(); }
        };
      }
    }
    loadNightCutPrinters();
  }

  // ---------------------------------------------------------------- corte general (D121)

  /** Las impresoras activas, para escoger dónde sale el corte general. */
  async function loadNightCutPrinters() {
    const sel = $('c-nightcut-printer');
    if (!sel || $('tab-cash').hidden) return;
    try {
      const { printers } = await api.get(`/nightclubs/${clubId()}/printers`);
      const activas = (printers || []).filter((p) => p.active);
      const antes = sel.value;
      sel.innerHTML = activas.map((p) => `<option value="${escape(p.id)}">${escape(p.name)}</option>`).join('');
      if (activas.some((p) => p.id === antes)) sel.value = antes;
      $('c-nightcut-print').disabled = activas.length === 0;
    } catch { /* la lista queda como estaba */ }
  }

  if ($('c-nightcut-print')) {
    $('c-nightcut-print').onclick = async () => {
      const nota = $('c-nightcut-error');
      nota.hidden = true;
      const printerId = $('c-nightcut-printer').value;
      if (!printerId) { avisar(nota, t('mgr.nightCutNoPrinter')); return; }
      const listo = ocupado($('c-nightcut-print'), 'prn.sending');
      try {
        const r = await api.post(`/nightclubs/${clubId()}/tills/report/print`, { printer_id: printerId });
        toast(t(r.totals && r.totals.open_tills > 0 ? 'mgr.nightCutSentPrelim' : 'mgr.nightCutSent'), 'ok');
      } catch (err) {
        avisar(nota, EV2Format.errorMessage(err));
      } finally { listo(); }
    };
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

      const nota = document.createElement('p');
      nota.className = 'text-xs text-red-300';
      nota.hidden = true;

      // Dónde vive la terminal (D100): la caja de una barra o la puerta. El cobro de ese
      // lugar sale por ella sin que nadie la escoja.
      const sitio = document.createElement('select');
      sitio.className = 'field text-xs mt-1';
      sitio.setAttribute('aria-label', t('term.place'));
      const ninguno = document.createElement('option');
      ninguno.value = '';
      ninguno.textContent = t('term.placeNone');
      sitio.appendChild(ninguno);
      for (const lugar of printPlaces()) {
        const opt = document.createElement('option');
        opt.value = lugar.id;
        opt.textContent = lugar.name;
        sitio.appendChild(opt);
      }
      sitio.value = term.location_id || '';
      sitio.onchange = async () => {
        sitio.disabled = true;
        nota.hidden = true;
        try {
          await api.patch(`/nightclubs/${clubId()}/payment-terminals/${term.id}`,
            { location_id: sitio.value || null });
          toast(t('term.saved'), 'ok');
          await loadTerminals();
        } catch (err) {
          sitio.disabled = false;
          sitio.value = term.location_id || '';
          avisar(nota, EV2Format.errorMessage(err));
        }
      };
      left.appendChild(sitio);

      const acciones = document.createElement('div');
      acciones.className = 'flex gap-2 shrink-0';
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
          bar: c.location_name || '—',
          amount: money(c.opening_float, c.currency)
            + (Number(c.opening_float_usd) > 0 ? ` + US$${Number(c.opening_float_usd).toFixed(2)}` : ''),
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
  /**
   * Donde puede vivir una PC o una impresora (D96): las barras y Cover. El almacén
   * no imprime. Cover solo lleva recibos de caja; el servidor lo vuelve a revisar.
   */
  const printPlaces = () => (state.locations || [])
    .filter((l) => (l.kind === 'bar' || l.kind === 'door') && l.active !== false);
  const isDoor = (id) => Boolean(id)
    && (state.locations || []).some((l) => l.id === id && l.kind === 'door');

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
    renderPrintersList();
    renderPrintAgents();
    renderPrintJobs();
    renderPrintSettings();
  }

  function renderPrintersList() {
    const lista = (printing.printers || []).filter((p) => p.active || printing.showArchived);
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
      donde.textContent = [p.location_name, t(PURPOSE_KEY[p.purpose] || 'prn.pService'),
        p.drawer_pin ? t('prn.drawerOn', { pin: p.drawer_pin }) : null].filter(Boolean).join(' · ');
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
      acciones.append(probar);
      // El cajón (D96): probarlo y cambiar el pin desde la misma tarjeta.
      const pin = document.createElement('select');
      pin.className = 'field text-xs py-1';
      pin.setAttribute('aria-label', t('prn.drawer'));
      for (const [v, k] of [['', 'prn.drawerNone'], ['2', 'prn.drawerPin2'], ['5', 'prn.drawerPin5']]) {
        const o = document.createElement('option');
        o.value = v;
        o.textContent = t(k);
        pin.appendChild(o);
      }
      pin.value = p.drawer_pin ? String(p.drawer_pin) : '';
      pin.disabled = !p.active;
      pin.onchange = () => setDrawerPin(p, pin, nota);
      const cajon = document.createElement('button');
      cajon.className = 'card rounded-lg px-3 py-2 text-xs';
      cajon.textContent = t('prn.testDrawer');
      cajon.hidden = !p.drawer_pin;
      cajon.disabled = !p.active;
      cajon.onclick = () => testDrawer(p, cajon, nota);
      acciones.append(cajon, apagar);
      acciones.classList.add('flex-wrap', 'justify-end');

      fila.append(left, acciones);
      const filaCajon = document.createElement('div');
      filaCajon.className = 'flex items-center gap-2';
      filaCajon.append(pin);
      card.append(fila, filaCajon, nota);
      caja.appendChild(card);
    }
  }

  function renderPrintAgents() {
    const lista = (printing.agents || []).filter((a) => a.active || printing.showArchived);
    $('prn-agents-empty').hidden = lista.length > 0;
    renderArchivedToggle();
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

    const barras = printPlaces();
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
      // En Cover solo hay recibos de caja (D96).
      if (isDoor(selBarra.value)) selPapel.value = 'till';
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
    // El encabezado y el pie (D121): no se pisa lo que el gerente está escribiendo.
    if ($('prn-header') && document.activeElement !== $('prn-header')) $('prn-header').value = (s && s.header_text) || '';
    if ($('prn-footer') && document.activeElement !== $('prn-footer')) $('prn-footer').value = (s && s.footer_text) || '';
    // Lo cambian gerente y admin (D58). Para cualquier otro rol que llegue a esta
    // pantalla se deshabilita en vez de esconderse: hay que poder VER si está
    // prendido cuando la barra reclama, aunque no se pueda tocar.
    const rol = (api.session && api.session.user && api.session.user.role) || null;
    check.disabled = !['manager', 'admin'].includes(rol);
    for (const id of ['prn-header', 'prn-footer', 'prn-texts-save']) if ($(id)) $(id).disabled = check.disabled;
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

  async function testDrawer(printer, button, nota) {
    nota.hidden = true;
    const listo = ocupado(button, 'prn.sending');
    try {
      await api.post(`/nightclubs/${clubId()}/printers/${printer.id}/test-drawer`, {});
      toast(t('prn.drawerQueued'), 'ok');
      listo();
    } catch (err) {
      listo();
      avisar(nota, EV2Format.errorMessage(err));
    }
  }

  async function setDrawerPin(printer, select, nota) {
    nota.hidden = true;
    try {
      await api.patch(`/nightclubs/${clubId()}/printers/${printer.id}`,
        { drawer_pin: select.value ? Number(select.value) : null });
      toast(t('prn.saved'), 'ok');
      await loadPrinting();
    } catch (err) {
      select.value = printer.drawer_pin ? String(printer.drawer_pin) : '';
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

  /** Cuántas PCs e impresoras apagadas hay, y el botón para verlas (D125). */
  function renderArchivedToggle() {
    const boton = $('btn-prn-archived');
    if (!boton) return;
    const n = (printing.agents || []).filter((a) => !a.active).length
      + (printing.printers || []).filter((p) => !p.active).length;
    boton.hidden = n === 0;
    boton.textContent = t(printing.showArchived ? 'prn.archivedHide' : 'prn.archivedShow', { n });
  }
  $('btn-prn-archived').onclick = () => {
    printing.showArchived = !printing.showArchived;
    renderPrintersList();
    renderPrintAgents();
  };

  // "Limpiar equipos" (D125): deja en la lista solo lo que funciona.
  $('btn-prn-cleanup').onclick = async () => {
    if (!(await ask(t('prn.cleanupConfirm')))) return;
    const listo = ocupado($('btn-prn-cleanup'), 'prn.saving');
    try {
      const { cleanup: r } = await api.post(`/nightclubs/${clubId()}/print-agents/cleanup`, {});
      listo();
      toast(t('prn.cleanupDone', {
        deleted: r.agents_deleted + r.printers_deleted,
        cancelled: r.jobs_cancelled,
        archived: r.archived.agents + r.archived.printers,
      }), 'ok');
      await loadPrinting();
    } catch (err) { listo(); showError(err); }
  };

  if ($('prn-texts')) {
    $('prn-texts').onsubmit = async (e) => {
      e.preventDefault();
      const nota = $('prn-settings-error');
      nota.hidden = true;
      const limpio = (v) => { const x = String(v || '').trim(); return x === '' ? null : x; };
      const listo = ocupado($('prn-texts-save'), 'prn.saving');
      try {
        const { settings } = await api.patch(`/nightclubs/${clubId()}/print-settings`, {
          header_text: limpio($('prn-header').value), footer_text: limpio($('prn-footer').value),
        });
        printing.settings = settings;
        toast(t('prn.textsSaved'), 'ok');
      } catch (err) {
        avisar(nota, EV2Format.errorMessage(err));
      } finally { listo(); }
    };
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
    $('cut-night').textContent = `${night.name} · ${EV2Format.dateTime(night.doors_open_at)}`;
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
    $('roster-night').textContent = `${night.name} · ${EV2Format.dateTime(night.doors_open_at)}`;
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
      r.tills = data.tills || [];
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
    // Las barras y Cover (D118): Cover sale de los huecos de caja cuando no hay
    // anfitriona asignada, para que se vea vacío en vez de no aparecer.
    const barrasConocidas = r.gaps.bars.map((b) => ({ ...b, kind: 'bar' }))
      .concat((r.gaps.tills || []).filter((x) => x.kind === 'door'))
      .concat(r.roster.flatMap((p) => (p.targets || [])
        .filter((x) => x.location_id)
        .map((x) => ({ location_id: x.location_id, name: x.location_name, kind: x.location_kind || 'bar' }))));
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
          ${escape(p.display_name)}${p.till_name ? ` <span class="text-[11px] text-lime-300">· ${escape(p.till_name)}</span>` : ''}
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
                 data-bar-name="${escape(b.name)}" data-bar-kind="${escape(b.kind || 'bar')}">+</button>`)),
    ].join('');

    for (const boton of $('roster-body').querySelectorAll('[data-add-section]')) {
      boton.onclick = () => openPick({ section: boton.dataset.addSection });
    }
    for (const boton of $('roster-body').querySelectorAll('[data-add-bar]')) {
      boton.onclick = () => openPick({
        locationId: boton.dataset.addBar, name: boton.dataset.barName,
        kind: boton.dataset.barKind || 'bar',
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
    // Cover (D118) es para la anfitriona; una barra, para bartender y cajero.
    const gente = EV2Roster.candidates(state.staff)
      .filter((p) => EV2Roster.fitsTarget(p.role, destino));

    $('pick-list').innerHTML = gente.map((p) => {
      const problema = EV2Roster.check({
        person: p,
        section: destino.section || null,
        locationId: destino.locationId || null,
        locationKind: destino.kind || null,
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

  async function assignPicked(userId, tillId = null) {
    const destino = state.pick;
    const r = state.roster;
    if (!destino || !r) return;
    // Una barra con varias cajas (D126): al cajero se le dice en cuál va.
    const persona = (state.staff || []).find((p) => p.id === userId);
    const cajas = EV2Roster.tillChoices({
      role: persona && persona.role, locationId: destino.locationId || null,
      tills: r.tills || [],
    });
    if (!tillId && cajas.length) {
      const libres = new Set(((r.gaps && r.gaps.tills) || []).map((x) => x.till_id));
      $('pick-where').textContent = `${destino.name} · ${t('tset.whichTill')}`;
      $('pick-list').innerHTML = cajas.map((c) => `
        <button type="button" class="card rounded-xl p-3 w-full text-left" data-pick-till="${escape(c.till_id)}">
          <p class="text-sm font-semibold truncate"><i class="fa-solid ${c.device === 'phone' ? 'fa-mobile-screen' : 'fa-desktop'} mr-1"></i>${escape(c.till_name)}</p>
          <p class="text-[11px] ${libres.has(c.till_id) ? 'text-lime-300' : 'text-white/40'}">${escape(t(libres.has(c.till_id) ? 'tset.free' : 'tset.taken'))}</p>
        </button>`).join('');
      for (const b of $('pick-list').querySelectorAll('[data-pick-till]')) {
        b.onclick = () => assignPicked(userId, b.dataset.pickTill);
      }
      return;
    }
    try {
      await api.post(`/nightclubs/${clubId()}/nights/${r.night.id}/roster`,
        EV2Roster.assignBody({
          userId, section: destino.section || null, locationId: destino.locationId || null, tillId,
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

  /* ---------- RPs (D98) ---------- */
  const rps = { list: [], event: null, summary: null };

  async function loadRps() {
    const club = clubId();
    try {
      const l = await api.get(`/nightclubs/${club}/rps`);
      rps.list = l.rps || [];
      const q = rps.event ? `?event_id=${encodeURIComponent(rps.event)}` : '';
      rps.summary = await api.get(`/nightclubs/${club}/rp/summary${q}`);
      if (rps.summary && rps.summary.event) rps.event = rps.summary.event.id;
    } catch (err) {
      if (state.tab === 'rps') showError(err);
    }
    renderRps();
  }

  function renderRps() {
    if (!$('tab-rps')) return;
    $('rpm-empty').hidden = rps.list.length > 0;
    $('rpm-list').innerHTML = rps.list.map((r) => `
      <div class="rounded-lg border border-white/10 p-3 flex flex-wrap items-center justify-between gap-2">
        <div class="min-w-0">
          <p class="font-display truncate">${escape(r.display_name)}${r.active === false ? ` · ${escape(t('rpm.inactive'))}` : ''}</p>
          <p class="text-xs text-white/50">${r.role ? `${escape(EV2Roles.describe(r.role, lang()).label)} · ` : ''}${escape(t('rpm.code'))}: <b>${escape(r.code || '—')}</b> · ${escape(r.commission_pct || '10')}%</p>
        </div>
        <div class="flex flex-wrap gap-2">
          <button data-rp-pct="${escape(r.user_id)}" class="ev2-button rounded-lg px-3 py-1 text-xs">${escape(t('rpm.editPct'))}</button>
          <button data-rp-code="${escape(r.user_id)}" class="ev2-button rounded-lg px-3 py-1 text-xs">${escape(t('rpm.newCode'))}</button>
          <button data-rp-active="${escape(r.user_id)}" class="ev2-button rounded-lg px-3 py-1 text-xs">${escape(r.active === false ? t('rpm.activate') : t('rpm.deactivate'))}</button>
        </div>
      </div>`).join('');

    const sel = $('rpm-event');
    const noches = EV2Manager.sortNights(state.nights, new Date());
    sel.innerHTML = noches.map((n) => `<option value="${escape(n.id)}">${escape(n.name || '')} · ${escape(EV2Format.dateTime(n.doors_open_at))}</option>`).join('');
    if (rps.event) sel.value = rps.event;

    const s = rps.summary;
    const over = !!(s && s.night_over);
    const note = $('rpm-note');
    note.hidden = !(s && s.event && !over);
    note.textContent = t('rpm.notOver');
    const filas = (s && s.rps) || [];
    $('rpm-night-empty').hidden = filas.length > 0;
    $('rpm-night').innerHTML = filas.map((r) => {
      const tot = (r.totals || []).map((x) => `${money(x.base, x.currency)} → <b>${money(x.commission, x.currency)}</b>`).join(' · ');
      const liq = (r.settled || []).length > 0;
      const accion = liq
        ? `<span class="text-xs text-emerald-300">${escape(t('rpm.settled'))}</span>`
        : `<button data-rp-settle="${escape(r.rp_user_id)}" class="ev2-button rounded-lg px-3 py-1 text-xs" ${over ? '' : 'disabled'}>${escape(t('rpm.settle'))}</button>`;
      return `<div class="rounded-lg border border-white/10 p-3 flex flex-wrap items-center justify-between gap-2">
        <div class="min-w-0">
          <p class="font-display truncate">${escape(r.display_name || '')} <span class="text-xs text-white/50">${escape(r.code || '')}</span></p>
          <p class="text-xs text-white/60">${escape(t('rpm.counts', { tables: r.tables, covers: r.covers }))}</p>
          <p class="text-sm">${tot}</p>
        </div>${accion}</div>`;
    }).join('');

    sel.onchange = () => { rps.event = sel.value || null; loadRps(); };
    document.querySelectorAll('[data-rp-pct]').forEach((b) => {
      b.onclick = async () => {
        const r = rps.list.find((x) => x.user_id === b.dataset.rpPct);
        const v = window.prompt(t('rpm.askPct'), r ? r.commission_pct : '10');
        if (v == null) return;
        const pct = Number(String(v).replace(',', '.'));
        if (!Number.isFinite(pct) || pct < 0 || pct > 100) { toast(t('rpm.badPct'), 'error'); return; }
        await rpPatch(b.dataset.rpPct, { commission_pct: pct });
      };
    });
    document.querySelectorAll('[data-rp-code]').forEach((b) => {
      b.onclick = async () => {
        if (!window.confirm(t('rpm.confirmCode'))) return;
        await rpPatch(b.dataset.rpCode, { regenerate_code: true });
      };
    });
    document.querySelectorAll('[data-rp-active]').forEach((b) => {
      b.onclick = async () => {
        const r = rps.list.find((x) => x.user_id === b.dataset.rpActive);
        await rpPatch(b.dataset.rpActive, { active: r ? r.active === false : true });
      };
    });
    document.querySelectorAll('[data-rp-settle]').forEach((b) => {
      b.onclick = async () => {
        if (!window.confirm(t('rpm.confirmSettle'))) return;
        const listo = ocupado(b, 'prn.saving');
        try {
          await api.post(`/nightclubs/${clubId()}/rp/settle`, { rp_user_id: b.dataset.rpSettle, event_id: rps.event });
          toast(t('rpm.settledOk'), 'ok');
          await loadRps();
        } catch (err) { showError(err); } finally { listo(); }
      };
    });
  }

  async function rpPatch(userId, body) {
    try {
      await api.patch(`/nightclubs/${clubId()}/rps/${userId}`, body);
      toast(t('rpm.saved'), 'ok');
      await loadRps();
    } catch (err) { showError(err); }
  }

  // ---------------------------------------------------------------- consumo del personal (D101)

  /**
   * El personal pide para sí desde su teléfono y lo que consume se le descuenta del pago.
   * Aquí el gerente fija el porcentaje de descuento y ve, de jueves a miércoles, cuánto se
   * le descuenta a cada quien. El porcentaje no tiene valor por omisión: sin él, la
   * función está apagada.
   */
  const scn = { pct: null, week: null, report: null };

  const addDays = (iso, n) => {
    const d = new Date(`${iso}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };

  async function loadStaffCons() {
    const club = clubId();
    try {
      const cfg = await api.get(`/nightclubs/${club}/staff-consumption/settings`);
      scn.pct = cfg.discount_pct;
      const q = scn.week ? `?week_start=${encodeURIComponent(scn.week)}` : '';
      scn.report = await api.get(`/nightclubs/${club}/staff-consumption/weekly${q}`);
      scn.week = scn.report.week_start;
    } catch (err) {
      if (state.tab === 'staffcons') showError(err);
    }
    renderStaffCons();
  }

  function renderStaffCons() {
    if (!$('tab-staffcons')) return;
    $('scn-pct').textContent = scn.pct === null ? '—' : `${scn.pct}%`;
    $('scn-off').hidden = scn.pct !== null;

    const r = scn.report;
    if (r) {
      $('scn-week').textContent = t('scn.weekOf', {
        from: EV2Format.date(`${r.week_start}T12:00:00`), to: EV2Format.date(`${r.week_end}T12:00:00`),
      });
    }
    const empleados = (r && r.employees) || [];
    $('scn-empty').hidden = empleados.length > 0;
    $('scn-total').textContent = empleados.length
      ? t('scn.total', {
        total: Object.entries(r.totals).map(([cur, v]) => money(v, cur)).join(' · '),
      })
      : '';
    $('scn-list').innerHTML = empleados.map((e) => {
      const totales = Object.entries(e.totals).map(([cur, v]) => money(v, cur)).join(' · ');
      const filas = e.consumptions.map((c) => `
        <div class="flex items-start justify-between gap-3 text-xs border-t border-white/10 pt-2">
          <div class="min-w-0">
            <p class="text-white/50">${escape(EV2Format.date(`${c.business_date}T12:00:00`))}</p>
            <p class="break-words">${escape(c.items.map((i) => `${i.quantity} × ${i.name}`).join(', '))}</p>
          </div>
          <div class="text-right shrink-0">
            <p class="text-white/40 line-through">${escape(money(c.list_total, c.currency))}</p>
            <p>${escape(money(c.amount, c.currency))}</p>
          </div>
        </div>`).join('');
      return `<details class="rounded-lg border border-white/10 p-3">
        <summary class="flex items-center justify-between gap-3 cursor-pointer">
          <span class="min-w-0">
            <span class="font-display block truncate">${escape(e.name)}</span>
            <span class="text-xs text-white/50">${escape(e.role_label)} · ${escape(t('scn.count', { n: e.count }))}</span>
          </span>
          <span class="font-display shrink-0">${escape(totales)}</span>
        </summary>
        <div class="mt-3 space-y-2">${filas}</div>
      </details>`;
    }).join('');

    $('btn-scn-pct').onclick = async () => {
      const dicho = await askText(t('scn.askPct'), scn.pct === null ? '' : String(scn.pct));
      if (dicho === null) return;
      const pct = Number(String(dicho).replace(',', '.'));
      if (String(dicho).trim() === '' || !Number.isFinite(pct) || pct < 0 || pct > 100) {
        toast(t('scn.badPct'), 'error'); return;
      }
      try {
        await api.put(`/nightclubs/${clubId()}/staff-consumption/settings`, { discount_pct: pct });
        toast(t('scn.saved'), 'ok');
        await loadStaffCons();
      } catch (err) { showError(err); }
    };
    $('btn-scn-prev').onclick = () => { if (scn.week) { scn.week = addDays(scn.week, -7); loadStaffCons(); } };
    $('btn-scn-next').onclick = () => { if (scn.week) { scn.week = addDays(scn.week, 7); loadStaffCons(); } };
    $('btn-scn-csv').onclick = async () => {
      const listo = ocupado($('btn-scn-csv'), 'prn.saving');
      try {
        const blob = await api.getBlob(
          `/nightclubs/${clubId()}/staff-consumption/weekly?format=csv&week_start=${encodeURIComponent(scn.week || '')}`);
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `consumo-personal-${scn.week}.csv`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      } catch (err) { showError(err); } finally { listo(); }
    };
  }

  // ---------------------------------------------------------------- precios de mesas (D103)
  //
  // Precio y personas propios de cada mesa VIP. Vacío = usa los de su zona. Lo escrito se
  // guarda en `tpr.edits` (no en el DOM) para que un re-pintado no borre lo que se estaba
  // tecleando; al guardar solo se mandan las mesas que cambiaron.

  const tpr = { tables: [], zones: [], edits: new Map(), loaded: false };

  async function loadTablePrices() {
    const club = clubId();
    try {
      const [mesas, zonas] = await Promise.all([
        api.get(`/nightclubs/${club}/tables`),
        api.get(`/nightclubs/${club}/zone-pricing`),
      ]);
      tpr.tables = mesas.tables || [];
      tpr.zones = zonas.zones || [];
      tpr.edits = new Map();
      tpr.loaded = true;
    } catch (err) {
      if (state.tab === 'tableprice') showError(err);
    }
    renderTablePrices();
  }

  const tprValue = (table, field) => {
    const e = tpr.edits.get(table.id);
    if (e) return e[field];
    const v = field === 'price' ? table.vip_price : table.vip_capacity;
    return v === null || v === undefined ? '' : String(field === 'price' ? Number(v) : v);
  };

  /** Lo que verá el cliente con lo que hay escrito ahora (aunque no esté guardado). */
  function tprSees(table, zone) {
    const price = EV2TablePricing.parseField('price', tprValue(table, 'price'));
    const people = EV2TablePricing.parseField('people', tprValue(table, 'people'));
    if (price.error || people.error) return '';
    const eff = EV2TablePricing.effective(
      { ...table, vip_price: price.value, vip_capacity: people.value }, zone);
    const z = t('tpr.fromZone');
    return t('tpr.sees', {
      price: `${money(eff.price, zone.currency)}${eff.priceFromTable ? '' : ` (${z})`}`,
      people: `${eff.people}${eff.peopleFromTable ? '' : ` (${z})`}`,
    });
  }

  function tprRefreshSave() {
    const { changes, errors } = EV2TablePricing.diff(tpr.tables, tpr.edits);
    $('btn-tpr-save').disabled = changes.length === 0 || errors.length > 0;
    const err = $('tpr-error');
    err.hidden = errors.length === 0;
    if (errors.length) err.textContent = t(`tpr.bad.${errors[0].field}`);
  }

  function renderTablePrices() {
    if (!$('tab-tableprice')) return;
    const grupos = EV2TablePricing.groupByZone(tpr.tables, tpr.zones);
    $('tpr-empty').hidden = grupos.length > 0 || !tpr.loaded;
    $('tpr-list').innerHTML = grupos.map((g) => `
      <div class="card rounded-xl p-4 space-y-3" data-tpr-zone="${escape(g.section)}">
        <div>
          <p class="font-display">${escape(g.zone.display_name || g.section)}</p>
          <p class="text-xs text-white/50">${escape(t('tpr.zone', {
    price: money(g.zone.base_price, g.zone.currency), people: g.zone.included_tickets,
  }))}</p>
        </div>
        ${g.tables.map((tb) => `
        <div class="rounded-lg border border-white/10 p-3 space-y-2" data-tpr-row="${escape(tb.id)}">
          <p class="text-sm font-semibold">${escape(t('tpr.table', { n: tb.table_number || tb.code }))}</p>
          <div class="grid grid-cols-2 gap-2">
            <label class="text-xs text-white/50">${escape(t('tpr.price'))}
              <input class="field mt-1" inputmode="decimal" data-tpr-price="${escape(tb.id)}" value="${escape(tprValue(tb, 'price'))}" placeholder="${escape(t('tpr.sameAsZone'))}">
            </label>
            <label class="text-xs text-white/50">${escape(t('tpr.people'))}
              <input class="field mt-1" inputmode="numeric" data-tpr-people="${escape(tb.id)}" value="${escape(tprValue(tb, 'people'))}" placeholder="${escape(t('tpr.sameAsZone'))}">
            </label>
          </div>
          <p class="text-xs text-white/60" data-role="tpr-sees">${escape(tprSees(tb, g.zone))}</p>
        </div>`).join('')}
      </div>`).join('');

    const onEdit = (id) => {
      const row = document.querySelector(`[data-tpr-row="${CSS.escape(id)}"]`);
      tpr.edits.set(id, {
        price: row.querySelector('[data-tpr-price]').value,
        people: row.querySelector('[data-tpr-people]').value,
      });
      const tb = tpr.tables.find((x) => x.id === id);
      const zone = tpr.zones.find((z) => z.section === tb.section);
      row.querySelector('[data-role="tpr-sees"]').textContent = tprSees(tb, zone);
      tprRefreshSave();
    };
    document.querySelectorAll('[data-tpr-price]').forEach((el) => { el.oninput = () => onEdit(el.dataset.tprPrice); });
    document.querySelectorAll('[data-tpr-people]').forEach((el) => { el.oninput = () => onEdit(el.dataset.tprPeople); });
    tprRefreshSave();

    $('btn-tpr-save').onclick = async () => {
      const { changes, errors } = EV2TablePricing.diff(tpr.tables, tpr.edits);
      if (errors.length || changes.length === 0) return;
      const listo = ocupado($('btn-tpr-save'), 'prn.saving');
      try {
        await api.put(`/nightclubs/${clubId()}/tables/vip-pricing`, { tables: changes });
        toast(t('tpr.saved', { n: changes.length }), 'ok');
        await loadTablePrices();
      } catch (err) { showError(err); } finally { listo(); }
    };
  }

  // ---------------------------------------------------------------- promociones (D102)
  //
  // Bebidas en oferta para UNA noche. El precio lo calcula el servidor al crear el pedido;
  // aquí solo se dan de alta, se ven y se apagan.

  const prm = { night: null, list: [] };

  const nochesOrdenadas = () => EV2Manager.sortNights(state.nights, new Date());

  async function loadPromos() {
    const noches = nochesOrdenadas();
    if (!prm.night || !noches.some((n) => n.id === prm.night)) {
      const hoy = EV2Manager.tonightNight(state.nights, new Date());
      prm.night = hoy ? hoy.night.id : (noches[0] ? noches[0].id : null);
    }
    prm.list = [];
    if (prm.night) {
      try {
        const d = await api.get(`/nightclubs/${clubId()}/events/${prm.night}/promotions`);
        prm.list = d.promotions || [];
      } catch (err) {
        if (state.tab === 'promos') showError(err);
      }
    }
    renderPromos();
  }

  function describePromo(p) {
    const que = p.drink_name || p.category || '';
    let texto;
    if (p.kind === 'n_for_m') texto = t('prm.d.n', { what: que, n: p.buy_qty, m: p.pay_qty });
    else if (p.kind === 'percent') texto = t('prm.d.percent', { what: que, pct: Number(p.value) });
    else if (p.kind === 'special') texto = t('prm.d.special', { what: que });
    else texto = t('prm.d.fixed', { what: que, price: money(p.value) });
    if (p.starts_time) texto += ` · ${t('prm.d.window', { from: p.starts_time, to: p.ends_time })}`;
    if (p.expected_units) texto += ` · ${t('prm.d.expected', { n: p.expected_units })}`;
    return texto;
  }

  function renderPromos() {
    if (!$('tab-promos')) return;
    const noches = nochesOrdenadas();
    $('prm-nonights').hidden = noches.length > 0;
    const sel = $('prm-night');
    sel.innerHTML = noches.map((n) => `<option value="${escape(n.id)}">${escape(n.name || '')} · ${escape(EV2Format.dateTime(n.doors_open_at))}</option>`).join('');
    if (prm.night) sel.value = prm.night;
    sel.onchange = () => { prm.night = sel.value; loadPromos(); };
    const noche = noches.find((n) => n.id === prm.night);
    $('prm-warn').hidden = !(noche && ['cancelled', 'finished'].includes(noche.status));
    $('prm-form').hidden = noches.length === 0;

    $('prm-empty').hidden = prm.list.length > 0;
    $('prm-list').innerHTML = prm.list.map((p) => `
      <div class="flex items-start justify-between gap-3 rounded-lg border border-white/10 p-3 ${p.active ? '' : 'opacity-50'}" data-promo="${escape(p.id)}">
        <div class="min-w-0">
          <p class="font-display break-words">${escape(p.name)}${p.active ? '' : ` <span class="text-xs text-white/50">· ${escape(t('prm.inactive'))}</span>`}</p>
          <p class="text-xs text-white/60 break-words">${escape(describePromo(p))}</p>
        </div>
        <button class="btn-secondary rounded-lg px-3 py-2 text-xs shrink-0" data-toggle-promo="${escape(p.id)}">${escape(t(p.active ? 'prm.off' : 'prm.on'))}</button>
      </div>`).join('');
    document.querySelectorAll('[data-toggle-promo]').forEach((b) => {
      b.onclick = async () => {
        const p = prm.list.find((x) => x.id === b.dataset.togglePromo);
        if (!p) return;
        try {
          await api.patch(`/nightclubs/${clubId()}/promotions/${p.id}`, { active: !p.active });
          toast(t(p.active ? 'prm.offDone' : 'prm.onDone'), 'ok');
          await loadPromos();
        } catch (err) { showError(err); }
      };
    });

    // El formulario: los campos que no son del tipo escogido se esconden, y el objetivo
    // (bebida o categoría) llena su propia lista.
    const kind = $('prm-kind').value;
    $('prm-f-n').hidden = kind !== 'n_for_m';
    $('prm-f-pct').hidden = kind !== 'percent';
    $('prm-f-price').hidden = kind !== 'fixed_price';
    // El trago especial (D114) es siempre de una bebida.
    if (kind === 'special') $('prm-target-kind').value = 'drink';
    $('prm-target-kind').disabled = kind === 'special';
    $('prm-kind').onchange = renderPromos;
    const porCategoria = $('prm-target-kind').value === 'category';
    const previo = $('prm-target').value;
    const categorias = [...new Set((state.drinks || []).map((d) => d.category).filter(Boolean))].sort();
    $('prm-target').innerHTML = porCategoria
      ? categorias.map((c) => `<option value="${escape(c)}">${escape(c)}</option>`).join('')
      : (state.drinks || []).slice().sort((a, b) => String(a.name).localeCompare(String(b.name)))
        .map((d) => `<option value="${escape(d.id)}">${escape(d.name)}</option>`).join('');
    if (previo && [...$('prm-target').options].some((o) => o.value === previo)) $('prm-target').value = previo;
    $('prm-target-kind').onchange = renderPromos;

    $('prm-form').onsubmit = async (ev) => {
      ev.preventDefault();
      const r = EV2Promos.payload({
        name: $('prm-name').value, kind: $('prm-kind').value,
        buy: $('prm-buy').value, pay: $('prm-pay').value,
        pct: $('prm-pct').value, price: $('prm-price').value,
        targetKind: $('prm-target-kind').value,
        drinkId: $('prm-target-kind').value === 'drink' ? $('prm-target').value : '',
        category: $('prm-target-kind').value === 'category' ? $('prm-target').value : '',
        from: $('prm-from').value, to: $('prm-to').value,
        expected: $('prm-expected').value,
      });
      const err = $('prm-error');
      if (r.error) {
        err.textContent = t(`prm.bad.${r.error}`);
        err.hidden = false;
        return;
      }
      err.hidden = true;
      const listo = ocupado($('btn-prm-add'), 'prn.saving');
      try {
        await api.post(`/nightclubs/${clubId()}/events/${prm.night}/promotions`, r.body);
        toast(t('prm.saved'), 'ok');
        $('prm-name').value = '';
        $('prm-expected').value = '';
        await loadPromos();
      } catch (e) { showError(e); } finally { listo(); }
    };
  }

  // ---------------------------------------------------------------- anticipos (D113)

  let depositQueue = null;
  function depQueue() {
    if (!depositQueue && window.EV2DepositReview) {
      depositQueue = window.EV2DepositReview.create({
        api, clubId, t, money,
        dateTime: (d) => EV2Format.dateTime(d),
        toast, errorMessage: (e) => EV2Format.errorMessage(e),
        container: $('depq-list'),
      });
    }
    return depositQueue;
  }
  async function loadDepositQueue() {
    const q = depQueue();
    if (!q || !$('depq-list')) return;
    try { await q.load(); } catch (err) { showError(err); }
  }

  async function loadPaymentOptions() {
    const box = $('mpo-list');
    if (!box) return;
    let opciones = [];
    try {
      const d = await api.get(`/nightclubs/${clubId()}/manual-payment-options`);
      opciones = (d.options || []).filter((o) => o.method !== 'cash');
    } catch (err) { showError(err); return; }
    box.innerHTML = '';
    if (opciones.length === 0) {
      const p = document.createElement('p');
      p.className = 'text-sm text-amber-200';
      p.textContent = t('mpo.none');
      box.appendChild(p);
    }
    for (const o of opciones) {
      const fila = document.createElement('div');
      fila.className = 'flex items-start justify-between gap-3 rounded-lg bg-white/5 px-3 py-2';
      const info = document.createElement('div');
      info.className = 'min-w-0';
      const a = document.createElement('p');
      a.className = 'text-sm';
      a.textContent = `${o.label} · ${t(EV2Deposit.methodKey(o.method))}`;
      const b = document.createElement('p');
      b.className = 'font-display tracking-wider break-all';
      b.textContent = o.destination || '';
      const c = document.createElement('p');
      c.className = 'text-[11px] text-white/50 whitespace-pre-line';
      c.textContent = o.instructions || '';
      info.append(a, b, c);
      const quitar = document.createElement('button');
      quitar.type = 'button';
      quitar.className = 'text-xs text-red-300 underline shrink-0';
      quitar.textContent = t('mpo.remove');
      quitar.onclick = async () => {
        if (!(await ask(t('mpo.removeAsk', { label: o.label }), { danger: true }))) return;
        try {
          await api.del(`/nightclubs/${clubId()}/manual-payment-options/${o.id}`);
          await loadPaymentOptions();
        } catch (err) { showError(err); }
      };
      fila.append(info, quitar);
      box.appendChild(fila);
    }
  }

  async function addPaymentOption() {
    const err = $('mpo-error');
    err.hidden = true;
    const body = {
      method: $('mpo-method').value,
      label: $('mpo-label').value.trim(),
      destination: $('mpo-destination').value.trim(),
      instructions: $('mpo-instructions').value.trim() || null,
      // Con la foto del comprobante el folio deja de ser obligatorio (D113).
      requires_reference: false,
    };
    if (!body.label || !body.destination) {
      err.textContent = t('mpo.errMissing');
      err.hidden = false;
      return;
    }
    if (!(await ask(t('mpo.confirmAdd', { label: body.label, dest: body.destination })))) return;
    const boton = $('btn-mpo-add');
    boton.disabled = true;
    try {
      await api.post(`/nightclubs/${clubId()}/manual-payment-options`, body);
      ['mpo-label', 'mpo-destination', 'mpo-instructions'].forEach((id) => { $(id).value = ''; });
      toast(t('mpo.added'), 'ok');
      await loadPaymentOptions();
    } catch (e) {
      err.textContent = EV2Format.errorMessage(e);
      err.hidden = false;
    } finally { boton.disabled = false; }
  }
  if ($('btn-mpo-add')) $('btn-mpo-add').onclick = addPaymentOption;
  if ($('btn-depq-refresh')) $('btn-depq-refresh').onclick = loadDepositQueue;

  // Compras y reabasto (D114): su pantalla vive en js/purchasing.js y se monta la
  // primera vez que se abre la sección.
  let purchasingView = null;
  function purchasing() {
    if (!purchasingView) {
      purchasingView = EV2Purchasing.mount({
        api, clubId, t, money, toast, showError,
        getNights: () => state.nights,
        dateTime: (iso) => EV2Format.dateTime(iso),
        goTab: (tab) => goTab(tab),
      });
    }
    return purchasingView;
  }

  // Cajas (D126): la pestaña vive en js/till-setup.js.
  const tillSetup = window.EV2TillSetup.mount({
    api, t, toast, showError, clubId, escape, ask,
  });

  const TAB_LOADERS = {
    purchasing: () => purchasing().load(),
    summary: () => Promise.all([loadTills(), loadWaiters()]),
    cash: () => Promise.all([loadShiftCuts(), loadTerminalCharges(), loadTips(), loadTills()]),
    lost: () => loadLostFound(),
    club: () => Promise.all([loadExchangeRate(), loadTerminals(), loadPrinting(), loadPushStatus(),
      loadDepositQueue(), loadPaymentOptions()]),
    printing: () => loadPrinting(),
    tills: () => tillSetup.load(),
    rps: () => loadRps(),
    staffcons: () => loadStaffCons(),
    promos: () => loadPromos(),
    tableprice: () => loadTablePrices(),
    tmon: () => loadMonitor(),
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
    if (state.invView === 'service') return renderBottleService();
    return renderStockList();
  }

  // ---------------------------------------------------------------- servicio de botella

  /**
   * Servicio de botella (D117). Arriba, los mezcladores que se pueden elegir al pedir
   * una botella: de qué insumo bajan, cuánto descuenta cada uno y cuánto cuesta cuando
   * se pasa del tope. Abajo, cada botella con su tope: cuántos incluye por pieza.
   * Vacío = esa botella no ofrece servicio. Todo se guarda al salir del campo.
   */
  const esBotella = (d) => /botella|bottle/i.test(String(d.category || ''))
    || (d.included_mixers !== null && d.included_mixers !== undefined);

  async function reloadMixers() {
    const club = clubId();
    const [m, d] = await Promise.all([
      api.get(`/nightclubs/${club}/bottle-mixers`),
      api.get(`/nightclubs/${club}/drinks`),
    ]);
    state.mixers = m.mixers || [];
    state.drinks = d.drinks || [];
    renderInventory();
  }

  function renderBottleService() {
    $('inv-empty').hidden = true;
    const caja = $('inv-list');
    const usados = new Set(state.mixers.map((m) => m.supply_id));
    const disponibles = (state.supplies || []).filter((x) => x.active !== false && !usados.has(x.id))
      .sort((a, b) => a.name.localeCompare(b.name, 'es'));
    const botellas = (state.drinks || []).filter(esBotella)
      .filter((d) => invMatches(d.name) || invMatches(d.category))
      .sort((a, b) => a.name.localeCompare(b.name, 'es'));
    const unidad = (u) => (u === 'ml' ? 'ml' : u === 'g' ? 'g' : 'pza');

    caja.innerHTML = `
      <section class="space-y-2">
        <p class="text-sm font-semibold">${escape(t('bs.mixers'))}</p>
        <p class="text-[11px] text-white/45">${escape(t('bs.mixersHelp'))}</p>
        ${state.mixers.length ? '' : `<p class="text-xs text-white/50">${escape(t('bs.noMixers'))}</p>`}
        ${state.mixers.map((m) => `
          <article class="card rounded-xl px-3 py-2 space-y-2 ${m.active ? '' : 'opacity-50'}" data-mixer="${escape(m.id)}">
            <div class="flex items-center gap-2">
              <input class="field flex-1 text-sm" data-f="name" value="${escape(m.name)}" maxlength="80" aria-label="${escape(t('bs.name'))}">
              <label class="text-xs flex items-center gap-1 shrink-0">
                <input type="checkbox" data-f="active" ${m.active ? 'checked' : ''}> ${escape(t('bs.active'))}
              </label>
            </div>
            <p class="text-[11px] text-white/45">${escape(t('bs.fromSupply', { supply: m.supply_name }))}</p>
            <div class="flex flex-wrap items-center gap-3 text-xs">
              <label class="flex items-center gap-1">${escape(t('bs.portion'))}
                <input class="field" style="width:6rem" type="number" min="0.001" step="any" data-f="portion" value="${escape(m.portion)}"> ${unidad(m.unit)}</label>
              <label class="flex items-center gap-1">${escape(t('bs.extra'))} $
                <input class="field" style="width:6rem" type="number" min="0" step="0.01" data-f="extra_price" value="${escape(Number(m.extra_price).toFixed(2))}"></label>
              <label class="flex items-center gap-1">${escape(t('bs.size'))}
                <select class="field" style="width:7rem" data-f="size">
                  <option value="small" ${m.size === 'large' ? '' : 'selected'}>${escape(t('bs.small'))}</option>
                  <option value="large" ${m.size === 'large' ? 'selected' : ''}>${escape(t('bs.large'))}</option>
                </select></label>
            </div>
          </article>`).join('')}
        <form id="bs-add" class="card rounded-xl p-3 space-y-2">
          <p class="text-xs font-semibold">${escape(t('bs.add'))}</p>
          <select id="bs-add-supply" class="field w-full text-sm" required>
            <option value="">${escape(t('bs.pickSupply'))}</option>
            ${disponibles.map((x) => `<option value="${escape(x.id)}">${escape(x.name)} (${unidad(x.unit)})</option>`).join('')}
          </select>
          <input id="bs-add-name" class="field w-full text-sm" maxlength="80" required placeholder="${escape(t('bs.namePh'))}">
          <div class="flex flex-wrap gap-3 text-xs items-center">
            <label class="flex items-center gap-1">${escape(t('bs.portion'))}
              <input id="bs-add-portion" class="field" style="width:6rem" type="number" min="0.001" step="any" required>
              <span id="bs-add-unit"></span></label>
            <label class="flex items-center gap-1">${escape(t('bs.extra'))} $
              <input id="bs-add-price" class="field" style="width:6rem" type="number" min="0" step="0.01" required value="0"></label>
            <label class="flex items-center gap-1">${escape(t('bs.size'))}
              <select id="bs-add-size" class="field" style="width:7rem">
                <option value="small">${escape(t('bs.small'))}</option>
                <option value="large">${escape(t('bs.large'))}</option>
              </select></label>
          </div>
          <p id="bs-add-error" class="text-xs text-red-300" hidden></p>
          <button class="ev2-button rounded-lg px-4 py-2 text-sm">${escape(t('bs.addBtn'))}</button>
        </form>
      </section>
      <section class="space-y-2 pt-4">
        <p class="text-sm font-semibold">${escape(t('bs.bottles'))}</p>
        <p class="text-[11px] text-white/45">${escape(t('bs.bottlesHelp'))}</p>
        ${botellas.length ? '' : `<p class="text-xs text-white/50">${escape(t('bs.noBottles'))}</p>`}
        ${botellas.map((d) => `
          <article class="card rounded-xl px-3 py-2 flex items-center gap-3" data-bottle="${escape(d.id)}">
            <div class="min-w-0 flex-1">
              <p class="text-sm font-semibold break-words">${escape(d.name)}</p>
              <p class="text-xs text-white/50">${escape(money(d.price, d.currency))}</p>
            </div>
            <div class="flex flex-col gap-1 shrink-0 text-xs">
              <label class="flex items-center justify-end gap-1">${escape(t('bs.includesSmall'))}
                <input class="field" style="width:4.5rem" type="number" min="0" max="50" step="1" data-cap="small"
                       placeholder="—" value="${d.included_mixers === null || d.included_mixers === undefined ? '' : escape(d.included_mixers)}"></label>
              <label class="flex items-center justify-end gap-1">${escape(t('bs.includesLarge'))}
                <input class="field" style="width:4.5rem" type="number" min="0" max="50" step="1" data-cap="large"
                       value="${escape(d.included_large_mixers || 0)}"></label>
            </div>
          </article>`).join('')}
      </section>`;

    // Guardar un mezclador al salir de cualquiera de sus campos.
    caja.querySelectorAll('[data-mixer]').forEach((card) => {
      const id = card.dataset.mixer;
      const m = state.mixers.find((x) => x.id === id);
      card.querySelectorAll('[data-f]').forEach((input) => {
        const evento = input.type === 'checkbox' ? 'change' : 'change';
        input.addEventListener(evento, async () => {
          const f = input.dataset.f;
          const body = {};
          if (f === 'active') body.active = input.checked;
          else if (f === 'name') body.name = input.value.trim();
          else if (f === 'size') body.size = input.value;
          else body[f] = Number(input.value);
          if (f === 'name' && !body.name) { input.value = m.name; return; }
          if ((f === 'portion' && !(body.portion > 0)) || (f === 'extra_price' && !(body.extra_price >= 0))) {
            input.value = m[f]; toast(t('bs.badNumber'), 'error'); return;
          }
          try {
            await api.patch(`/nightclubs/${clubId()}/bottle-mixers/${id}`, body);
            toast(t('bs.saved'), 'ok');
            await reloadMixers();
          } catch (err) { showError(err); await reloadMixers(); }
        });
      });
    });

    const sel = caja.querySelector('#bs-add-supply');
    sel.onchange = () => {
      const x = (state.supplies || []).find((s2) => s2.id === sel.value);
      if (!x) return;
      if (!caja.querySelector('#bs-add-name').value) caja.querySelector('#bs-add-name').value = x.name;
      // Por omisión, una presentación completa: una botella de Sprite de 3 L = 3000 ml.
      caja.querySelector('#bs-add-portion').value = x.package_size || '';
      caja.querySelector('#bs-add-unit').textContent = unidad(x.unit);
    };
    caja.querySelector('#bs-add').onsubmit = async (ev) => {
      ev.preventDefault();
      const error = caja.querySelector('#bs-add-error');
      error.hidden = true;
      try {
        await api.post(`/nightclubs/${clubId()}/bottle-mixers`, {
          supply_id: sel.value,
          name: caja.querySelector('#bs-add-name').value.trim(),
          portion: Number(caja.querySelector('#bs-add-portion').value),
          extra_price: Number(caja.querySelector('#bs-add-price').value),
          size: caja.querySelector('#bs-add-size').value,
        });
        toast(t('bs.saved'), 'ok');
        await reloadMixers();
      } catch (err) { showError(err, error); }
    };

    caja.querySelectorAll('[data-bottle]').forEach((card) => {
      const chicos = card.querySelector('[data-cap="small"]');
      const grandes = card.querySelector('[data-cap="large"]');
      const guardar = async () => {
        const raw = chicos.value.trim();
        const value = raw === '' ? null : Math.floor(Number(raw));
        const large = grandes.value.trim() === '' ? 0 : Math.floor(Number(grandes.value));
        if ((value !== null && !(value >= 0 && value <= 50)) || !(large >= 0 && large <= 50)) {
          toast(t('bs.badNumber'), 'error'); return;
        }
        try {
          await api.put(`/nightclubs/${clubId()}/drinks/${card.dataset.bottle}/included-mixers`,
            { included_mixers: value, included_large_mixers: large });
          toast(t('bs.saved'), 'ok');
          await reloadMixers();
        } catch (err) { showError(err); }
      };
      chicos.addEventListener('change', guardar);
      grandes.addEventListener('change', guardar);
    });
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
    const inactivos = state.invFilter === 'inactive';
    if (inactivos && !state.inactiveLoaded) {
      invEmpty(t('inv.loading'));
      loadInactiveSupplies();
      return undefined;
    }
    const base = inactivos ? state.inactiveSupplies : state.supplies;
    let list = base.filter((x) => invMatches(x.name) || invMatches(x.category));
    if (state.invFilter === 'low') list = list.filter((x) => x.low);
    if (state.invFilter === 'unconfirmed') list = list.filter((x) => x.size_confirmed === false);
    if (list.length === 0) {
      return invEmpty(t(state.invFilter === 'all' ? 'inv.emptyStock'
        : (inactivos ? 'inv.emptyInactive' : 'inv.emptyFilter')));
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
                  ${supply.active === false ? `<span class="text-white/40 text-[11px]">· ${escape(t('inv.inactive'))}</span>` : ''}
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
              <button type="button" class="tap shrink-0 w-9 h-9 rounded-lg bg-white/5 text-white/70 hover:text-white"
                      data-edit-supply="${escape(supply.id)}" title="${escape(t('inv.editSupply'))}"
                      aria-label="${escape(t('inv.editSupply'))}: ${escape(supply.name)}"><i class="fa-solid fa-pen text-xs"></i></button>
            </div>`).join('')}
        </div>
      </section>`).join('');

    for (const input of $('inv-list').querySelectorAll('[data-min-supply]')) {
      input.onchange = () => saveMinimum(input);
    }
    for (const button of $('inv-list').querySelectorAll('[data-edit-supply]')) {
      button.onclick = () => openSupplyEdit(button.dataset.editSupply);
    }
    return undefined;
  }

  // ---------------------------------------------------------------- editar / eliminar un insumo (D95)

  /** Los dados de baja: solo se piden al abrir su filtro. */
  async function loadInactiveSupplies() {
    try {
      const d = await api.get(`/nightclubs/${clubId()}/supplies?include_inactive=true`);
      state.inactiveSupplies = (d.supplies || []).filter((x) => x.active === false);
      state.inactiveLoaded = true;
    } catch (err) {
      showError(err);
      state.invFilter = 'all';
    }
    renderInventory();
  }

  /**
   * Después de editar, desactivar o borrar se vuelve a pedir lo que ese insumo toca:
   * la lista, los inactivos (si ya se abrieron) y las recetas, que muestran su nombre.
   */
  async function reloadAfterSupplyChange() {
    const club = clubId();
    const [vigentes, recetas] = await Promise.all([
      api.get(`/nightclubs/${club}/supplies`),
      api.get(`/nightclubs/${club}/recipes`),
    ]);
    state.supplies = vigentes.supplies || [];
    state.recipes = recetas.recipes || [];
    if (state.inactiveLoaded) {
      const d = await api.get(`/nightclubs/${club}/supplies?include_inactive=true`);
      state.inactiveSupplies = (d.supplies || []).filter((x) => x.active === false);
    }
    renderInventory();
  }

  const findSupply = (id) => state.supplies.find((x) => x.id === id)
    || state.inactiveSupplies.find((x) => x.id === id) || null;

  function openSupplyEdit(id) {
    const supply = findSupply(id);
    if (!supply) return;
    state.supEdit = supply;
    $('sup-edit-name').value = supply.name || '';
    $('sup-edit-category').value = supply.category || '';
    $('sup-edit-unit').value = supply.unit;
    $('sup-edit-size').value = supply.package_size;
    $('sup-edit-label').value = supply.package_label || '';
    $('sup-edit-error').hidden = true;
    renderSupplySheet();
    $('sup-sheet').hidden = false;
    $('sup-edit-name').focus();
  }

  function closeSupplyEdit() {
    state.supEdit = null;
    $('sup-sheet').hidden = true;
  }

  function renderSupplySheet() {
    const supply = state.supEdit;
    if (!supply) return;
    const activo = supply.active !== false;
    $('sup-edit-status').textContent = [
      supply.name,
      activo ? t('sup.statusActive') : t('inv.inactive'),
      EV2Warehouse.describeStock(supply, supply.stock, lang()),
    ].join(' · ');
    $('btn-sup-toggle').textContent = t(activo ? 'sup.deactivate' : 'sup.reactivate');
  }

  /** Nombres de recetas para un aviso: los primeros cinco y cuántos más. */
  function recipeNames(recipes) {
    const names = (recipes || []).map((r) => r.name);
    const shown = names.slice(0, 5).join(', ');
    return names.length > 5 ? `${shown} ${t('sup.andMore', { n: names.length - 5 })}` : shown;
  }

  /** Un 409 del servidor, dicho en el idioma de la pantalla. */
  function supplyConflictMessage(err) {
    const d = (err && err.details) || {};
    if (d.reason === 'unit_locked') return t('sup.errUnitLocked');
    if (d.reason === 'in_recipes') return t('sup.errInRecipes', { names: recipeNames(d.recipes) });
    return null;
  }

  async function saveSupply() {
    const supply = state.supEdit;
    if (!supply) return undefined;
    const error = $('sup-edit-error');
    error.hidden = true;
    const nombre = $('sup-edit-name').value.trim();
    const tamano = Number($('sup-edit-size').value);
    if (!nombre) return avisar(error, t('sup.errName'));
    if (!Number.isFinite(tamano) || tamano <= 0) return avisar(error, t('sup.errSize'));

    // Solo lo que cambió: mandar el tamaño sin tocarlo lo daría por confirmado.
    const cambios = {};
    const categoria = $('sup-edit-category').value.trim();
    const presentacion = $('sup-edit-label').value.trim();
    if (nombre !== supply.name) cambios.name = nombre;
    if (categoria !== (supply.category || '')) cambios.category = categoria;
    if ($('sup-edit-unit').value !== supply.unit) cambios.unit = $('sup-edit-unit').value;
    if (tamano !== Number(supply.package_size)) cambios.package_size = tamano;
    if (presentacion !== (supply.package_label || '')) cambios.package_label = presentacion;
    if (Object.keys(cambios).length === 0) return avisar(error, t('sup.noChanges'), 'warn');

    const listo = ocupado($('btn-sup-save'), 'sup.saving');
    try {
      await api.patch(`/nightclubs/${clubId()}/supplies/${supply.id}`, cambios);
      toast(t('sup.saved'), 'ok');
      closeSupplyEdit();
      await reloadAfterSupplyChange();
    } catch (err) {
      const conflicto = supplyConflictMessage(err);
      if (conflicto) avisar(error, conflicto); else showError(err, error);
    } finally { listo(); }
    return undefined;
  }

  /** Desactivar o reactivar. Desactivar no toca el saldo ni el historial. */
  async function setSupplyActive(supply, active) {
    const error = $('sup-edit-error');
    error.hidden = true;
    const listo = ocupado($('btn-sup-toggle'), 'sup.saving');
    try {
      await api.patch(`/nightclubs/${clubId()}/supplies/${supply.id}`, { active });
      toast(t(active ? 'sup.reactivated' : 'sup.deactivated'), 'ok');
      closeSupplyEdit();
      await reloadAfterSupplyChange();
    } catch (err) {
      const conflicto = supplyConflictMessage(err);
      if (conflicto) avisar(error, conflicto); else showError(err, error);
    } finally { listo(); }
  }

  async function toggleSupply() {
    const supply = state.supEdit;
    if (!supply) return;
    if (supply.active === false) { await setSupplyActive(supply, true); return; }
    if (!(await ask(t('sup.deactivateAsk', { name: supply.name }),
      { title: t('sup.deactivate'), ok: t('sup.deactivate') }))) return;
    await setSupplyActive(supply, false);
  }

  /**
   * Eliminar. Solo se borra lo que nunca se usó; si el servidor dice que tiene
   * historia, se ofrece desactivarlo — o se dice qué recetas lo impiden.
   */
  async function deleteSupply() {
    const supply = state.supEdit;
    if (!supply) return;
    const error = $('sup-edit-error');
    error.hidden = true;
    if (!(await ask(t('sup.deleteAsk', { name: supply.name }),
      { title: t('sup.delete'), ok: t('sup.delete'), danger: true }))) return;

    const listo = ocupado($('btn-sup-delete'), 'sup.deleting');
    let enUso = null;
    try {
      await api.del(`/nightclubs/${clubId()}/supplies/${supply.id}`);
      toast(t('sup.deleted'), 'ok');
      closeSupplyEdit();
      await reloadAfterSupplyChange();
      return;
    } catch (err) {
      const d = err && err.details;
      if (err && err.status === 409 && d && d.reason === 'supply_in_use') enUso = d;
      else showError(err, error);
    } finally { listo(); }
    if (!enUso) return;

    if (enUso.can_deactivate) {
      const ofrecer = await ask(t('sup.inUseAsk', { name: supply.name }),
        { title: t('sup.cannotDelete'), ok: t('sup.deactivate') });
      if (ofrecer) await setSupplyActive(supply, false);
      return;
    }
    if ((enUso.active_recipes || []).length > 0) {
      avisar(error, t('sup.inUseRecipes', { names: recipeNames(enUso.active_recipes) }));
      return;
    }
    avisar(error, t('sup.inUseInactive'), 'warn');
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
      card.dataset.drink = trago.id;

      // El nombre se lee COMPLETO (sin `truncate`): en el teléfono un trago como
      // "BUCHANANS 18 - AGUA MINERAL" tiene que verse entero, aunque ocupe dos líneas.
      const izq = document.createElement('div');
      izq.className = 'min-w-0 flex-1';
      const nombre = document.createElement('p');
      nombre.className = 'text-sm font-semibold break-words';
      nombre.dataset.role = 'drink-name';
      nombre.textContent = trago.name;
      const cat = document.createElement('p');
      cat.className = 'text-xs text-white/50 truncate';
      cat.textContent = [trago.category, trago.available ? '' : t('inv.menuOff')]
        .filter(Boolean).join(' · ');
      izq.append(nombre, cat);

      // El precio, con su signo. La caja lleva ancho propio EN LÍNEA: `.field` pone
      // `width: 100%` y le ganaba a `w-24`, así que el campo se comía la tarjeta y
      // empujaba el nombre y el botón fuera de la pantalla.
      const bloquePrecio = document.createElement('label');
      bloquePrecio.className = 'flex items-center gap-1 shrink-0 text-sm text-white/60';
      const signo = document.createElement('span');
      signo.textContent = '$';
      signo.setAttribute('aria-hidden', 'true');

      const precio = document.createElement('input');
      precio.type = 'number';
      precio.min = '0';
      precio.step = '1';
      precio.className = 'field text-right';
      precio.style.width = '5.5rem';
      precio.style.flex = '0 0 auto';
      precio.dataset.role = 'drink-price';
      precio.setAttribute('aria-label', t('inv.menuPrice'));
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

      bloquePrecio.append(signo, precio);
      card.append(izq, bloquePrecio, prender);
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
    b.onclick = () => {
      // Los inactivos se vuelven a pedir cada vez que se abre su filtro: otro gerente
      // pudo haber dado de baja algo desde otra pantalla.
      if (b.dataset.invf === 'inactive') state.inactiveLoaded = false;
      state.invFilter = b.dataset.invf;
      renderInventory();
    };
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
  if ($('btn-sup-close')) $('btn-sup-close').onclick = closeSupplyEdit;
  if ($('btn-sup-save')) $('btn-sup-save').onclick = saveSupply;
  if ($('btn-sup-toggle')) $('btn-sup-toggle').onclick = toggleSupply;
  if ($('btn-sup-delete')) $('btn-sup-delete').onclick = deleteSupply;
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
      const tipo = message && (message.event_type || message.type);
      if (tipo === 'vip_table_occupied' || tipo === 'vip_table_released') {
        const p = message.payload || {};
        toast(t(tipo === 'vip_table_occupied' ? 'tmon.vipIn' : 'tmon.vipOut', { code: p.code || '' }), 'ok');
      }
      if (state.tab === 'tmon' && /^(table_updated|vip_table_|order_)/.test(tipo || '')) loadMonitor();
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
