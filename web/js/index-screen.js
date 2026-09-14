/**
 * EV2 — pantalla del cliente.
 *
 * Solo conecta el DOM con `EV2` (API y socket), `EV2Client` (carrito, pedidos, eventos),
 * `EV2Map` (plano) y `EV2Roles` (a dónde va cada rol). Ninguna decisión de negocio vive
 * aquí: si algo hay que probar, va en esos módulos.
 */
/* global EV2, EV2Format, EV2Client, EV2Map, EV2Roles, EV2Taxi, EV2DrinkArt, EV2Social */
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
    club: null, drinks: [], categories: [], category: null,
    tables: [], landmarks: [], canvas: null, floors: [], floor: null,
    selectedId: null, myTable: null, orders: [], realtime: null,
    taxi: { availability: null, ride: null, rides: [], fares: [], pickup: null,
      settings: null, contacts: [], certificate: null, certificateFor: null },
  };
  const cart = EV2Client.createCart();

  /**
   * El enganche para las pantallas que viven en otro archivo (`show-screen.js`,
   * `booking-screen.js`).
   *
   * Están aparte porque este archivo ya es largo y mezclarlo todo hace que un cambio en
   * las propinas rompa el plano. Lo que comparten es lo mínimo: la API, el estado, y
   * tres avisos —entró alguien, cambió de pestaña, llegó un evento del socket—. Nada de
   * lógica de negocio pasa por aquí; esa vive en EV2Tipping, EV2Songs y EV2Booking.
   */
  const hub = (function makeHub() {
    const handlers = { enter: [], view: [], event: [], language: [] };
    let entered = null;
    const call = (fn, arg) => {
      // Un fallo en una pantalla secundaria no puede tumbar el plano ni los pedidos.
      try { const r = fn(arg); if (r && r.catch) r.catch(() => {}); } catch { /* seguimos */ }
    };
    return {
      on(name, fn) {
        (handlers[name] || (handlers[name] = [])).push(fn);
        // 'enter' se repite al que llegó tarde. Los <script> se cargan en orden, pero la
        // sesión se recupera con una llamada de red que puede resolverse mientras el
        // navegador todavía está bajando el archivo siguiente: sin esto, la pantalla de
        // propinas se quedaría vacía justo en las recargas, que es cuando se nota.
        if (name === 'enter' && entered) call(fn, entered);
      },
      emit(name, arg) {
        if (name === 'enter') entered = arg;
        for (const fn of (handlers[name] || [])) call(fn, arg);
      },
    };
  }());

  // ---------------------------------------------------------------- utilidades de pantalla

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

  const money = (amount, currency) => EV2Format.money(amount, currency || 'MXN');
  const t = (key, vars) => (vars ? EV2Format.tf(key, vars) : EV2Format.t(key));
  const lang = () => EV2Format.getLanguage();
  const escape = (s) => String(s == null ? '' : s).replace(/[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /** Un error de la API se muestra tal cual: dice *por qué* mejor que un texto genérico. */
  function showError(err, where, opts) {
    const message = EV2Format.errorMessage(err, opts);
    if (where) { where.textContent = message; where.hidden = false; } else toast(message, 'error');
  }

  // ---------------------------------------------------------------- entrar

  function switchAuthTab(which) {
    const login = which === 'login';
    $('form-login').hidden = !login;
    $('form-register').hidden = login;
    $('tab-login').className = `flex-1 py-2 ${login ? 'tab-active font-semibold' : 'text-white/50'}`;
    $('tab-register').className = `flex-1 py-2 ${login ? 'text-white/50' : 'tab-active font-semibold'}`;
    $('auth-error').hidden = true;
  }

  $('tab-login').onclick = () => switchAuthTab('login');
  $('tab-register').onclick = () => switchAuthTab('register');

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
    } catch (err) {
      showError(err, $('auth-error'), { context: 'login' });
    }
  };

  $('form-register').onsubmit = async (ev) => {
    ev.preventDefault();
    $('auth-error').hidden = true;
    try {
      await api.post('/auth/register', {
        nightclub_slug: CLUB_SLUG,
        email: $('reg-email').value.trim(),
        password: $('reg-password').value,
        first_name: $('reg-first').value.trim(),
        last_name: $('reg-last').value.trim(),
        birth_date: $('reg-birth').value,
        accept_terms: $('reg-terms').checked,
        accept_flirts: $('reg-flirts').checked,
      });
      await api.login({
        nightclubSlug: CLUB_SLUG,
        email: $('reg-email').value.trim(),
        password: $('reg-password').value,
      });
      await afterSignIn();
    } catch (err) {
      // El servidor distingue "menor de edad" de "correo repetido"; ese texto es el útil.
      showError(err, $('auth-error'));
    }
  };

  // ------------------------------------- entrar con una cuenta de otro (Facebook)

  const API_BASE = meta('ev2:api', '/api');
  // El proveedor de la última vuelta que dijo "ya quedó ligada". Se guarda porque el
  // aviso tiene que salir DESPUÉS de que la pantalla del cliente esté montada.
  let socialLinkedToast = null;
  let socialCompletionToken = null;
  let socialProviders = [];

  function socialButton({ icon, color, text, onClick }) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'w-full py-3 rounded-xl text-sm font-semibold flex items-center '
      + 'justify-center gap-3 bg-white/5 border border-white/10 tap';
    const i = document.createElement('i');
    i.className = icon;
    i.style.color = color;
    const s = document.createElement('span');
    s.textContent = text;
    b.append(i, s);
    b.onclick = onClick;
    return b;
  }

  /**
   * Los botones de la pantalla de acceso.
   *
   * Si la lista no se puede pedir, no se pinta nada y no se avisa: correo y contraseña
   * no dependen de ningún proveedor, así que la pantalla de acceso sigue sirviendo
   * igual. Enseñar "no pudimos cargar los botones de Facebook" sobre el formulario que
   * sí funciona solo asusta.
   */
  async function loadSocialButtons() {
    try {
      socialProviders = EV2Social.enabledProviders(await api.get('/auth/oauth/providers'));
    } catch {
      return;
    }
    renderSocialButtons();
  }

  function renderSocialButtons() {
    const caja = $('social-buttons');
    caja.innerHTML = '';
    for (const p of socialProviders) {
      caja.appendChild(socialButton({
        icon: p.icon,
        color: p.color,
        text: t('social.with', { provider: p.label }),
        // Navegación completa y no `fetch`: la respuesta es un 302 hacia Facebook, y
        // un `fetch` lo seguiría en segundo plano en vez de llevarse a la persona.
        onClick: () => {
          location.href = EV2Social.startUrl({
            baseUrl: API_BASE, provider: p.provider, clubSlug: CLUB_SLUG,
          });
        },
      }));
    }
    $('social-block').hidden = socialProviders.length === 0 || !$('social-finish').hidden;
  }

  /**
   * La vuelta del proveedor.
   *
   * Devuelve `true` cuando ya se hizo cargo de la pantalla, para que el arranque no
   * siga con la sesión guardada por encima.
   */
  async function handleSocialReturn() {
    const vuelta = EV2Social.takeFromLocation(location, window.history);
    if (!vuelta) return false;

    if (vuelta.kind === 'error') {
      const el = $('auth-error');
      el.textContent = t(EV2Social.errorKey(vuelta.value));
      el.hidden = false;
      return false;
    }
    if (vuelta.kind === 'linked') {
      // La persona venía de su perfil: su sesión sigue guardada, así que el arranque
      // la retoma solo. Aquí únicamente se recuerda el aviso.
      socialLinkedToast = vuelta.value;
      return false;
    }
    if (vuelta.kind === 'signup') {
      showSocialFinish(vuelta.value);
      return true;
    }
    try {
      api.signInWith(await api.post('/auth/oauth/handoff', { handoff: vuelta.value }));
      await afterSignIn();
      return true;
    } catch (err) {
      showError(err, $('auth-error'));
      return false;
    }
  }

  function showSocialFinish(token) {
    socialCompletionToken = token;
    const falta = EV2Social.signupNeeds(token, EV2Social.peekToken);
    const etiqueta = falta.provider
      ? falta.provider.charAt(0).toUpperCase() + falta.provider.slice(1)
      : null;
    $('social-finish-note').textContent = etiqueta
      ? t('social.finishNote', { provider: etiqueta })
      : t('social.finishNoteGeneric');
    // El correo se enseña siempre, ya escrito si el proveedor lo dio: así la persona
    // ve con qué cuenta va a entrar y lo puede corregir antes de que exista.
    $('social-email').value = falta.suggested_email || '';
    $('form-login').hidden = true;
    $('form-register').hidden = true;
    $('social-block').hidden = true;
    $('social-finish').hidden = false;
    $('screen-auth').hidden = false;
  }

  $('social-finish').onsubmit = async (ev) => {
    ev.preventDefault();
    $('auth-error').hidden = true;
    try {
      const correo = $('social-email').value.trim();
      api.signInWith(await api.post('/auth/oauth/complete', {
        completion_token: socialCompletionToken,
        email: correo || undefined,
        birth_date: $('social-birth').value,
        accept_terms: $('social-terms').checked,
      }));
      socialCompletionToken = null;
      await afterSignIn();
    } catch (err) {
      // El servidor distingue "menor de edad" de "ese correo ya tiene cuenta"; ese
      // texto es el útil.
      showError(err, $('auth-error'));
    }
  };

  $('social-finish-cancel').onclick = () => {
    socialCompletionToken = null;
    $('social-finish').hidden = true;
    switchAuthTab('login');
    renderSocialButtons();
  };

  /**
   * El panel del perfil: qué cuentas hay ligadas, qué se puede ligar y qué se puede
   * quitar. El botón de quitar solo sale cuando queda otra manera de entrar.
   */
  async function loadSocialPanel() {
    let estado;
    let ligadas;
    try {
      [estado, ligadas] = await Promise.all([
        api.get('/auth/oauth/providers'),
        api.get('/auth/oauth/linked'),
      ]);
    } catch {
      return;
    }
    const disponibles = EV2Social.enabledProviders(estado);
    const yaLigadas = ligadas.identities || [];
    if (disponibles.length === 0 && yaLigadas.length === 0) {
      $('social-panel').hidden = true;
      return;
    }

    const puedeQuitar = EV2Social.canUnlink(ligadas);
    const lista = $('social-panel-list');
    lista.innerHTML = '';
    for (const ident of yaLigadas) {
      const cara = EV2Social.look(ident.provider);
      const fila = document.createElement('div');
      fila.className = 'flex items-center justify-between gap-3 text-sm';
      const izq = document.createElement('span');
      izq.className = 'flex items-center gap-2';
      const i = document.createElement('i');
      i.className = cara.icon;
      i.style.color = cara.color;
      const texto = document.createElement('span');
      texto.textContent = ident.email || ident.display_name || ident.provider;
      izq.append(i, texto);
      fila.appendChild(izq);
      if (puedeQuitar) {
        const quitar = document.createElement('button');
        quitar.type = 'button';
        quitar.className = 'text-xs text-red-300 underline';
        quitar.textContent = t('social.unlink');
        quitar.onclick = async () => {
          $('social-panel-error').hidden = true;
          try {
            await api.del(`/auth/oauth/${encodeURIComponent(ident.provider)}`);
            await loadSocialPanel();
          } catch (err) {
            showError(err, $('social-panel-error'));
          }
        };
        fila.appendChild(quitar);
      }
      lista.appendChild(fila);
    }

    const agregar = $('social-panel-add');
    agregar.innerHTML = '';
    const ligados = new Set(yaLigadas.map((x) => x.provider));
    for (const p of disponibles.filter((x) => !ligados.has(x.provider))) {
      agregar.appendChild(socialButton({
        icon: p.icon,
        color: p.color,
        text: t('social.link', { provider: p.label }),
        onClick: async () => {
          $('social-panel-error').hidden = true;
          try {
            const r = await api.post(`/auth/oauth/${encodeURIComponent(p.provider)}/link`,
              { redirect_to: 'index.html' });
            location.href = r.authorize_url;
          } catch (err) {
            showError(err, $('social-panel-error'));
          }
        },
      }));
    }

    $('social-panel-empty').hidden = yaLigadas.length > 0;
    const nota = $('social-panel-note');
    nota.textContent = puedeQuitar ? '' : t('social.lastWayIn');
    nota.hidden = puedeQuitar || yaLigadas.length === 0;
    $('social-panel').hidden = false;
  }

  async function signOut() {
    if (state.realtime) state.realtime.close();
    await api.logout();
    location.reload();
  }

  $('btn-logout').onclick = signOut;
  $('btn-profile-logout').onclick = signOut;
  $('btn-staff-logout').onclick = signOut;

  /**
   * Cambiar de idioma tiene que cambiar TODA la pantalla, no solo la etiqueta del botón
   * (que era lo único que pasaba). `applyTo` traduce el HTML marcado con `data-i18n`, y
   * después se vuelven a pintar las partes que se generan desde JavaScript.
   */
  function applyLanguage() {
    EV2Format.applyTo(document);
    // El botón muestra el idioma AL QUE se cambia, no el actual.
    $('btn-lang').textContent = EV2Format.otherLanguage().toUpperCase();
    renderMenu();
    renderCart();
    renderOrders();
    if (!$('screen-app').hidden) { renderFloor(); renderTaxi(); }
    if (!$('screen-staff').hidden) renderStaffPending();
    renderSocialButtons();
    if (!$('social-panel').hidden) loadSocialPanel();
    setConnection(lastConnection.on, lastConnection.key);
    hub.emit('language', lang());
  }

  $('btn-lang').onclick = () => {
    EV2Format.setLanguage(EV2Format.otherLanguage());
    applyLanguage();
  };

  // ---------------------------------------------------------------- ruteo por rol

  /**
   * Un bartender no tiene por qué ver el plano de mesas para sentarse. Si su pantalla
   * ya está conectada se le manda ahí; si todavía no existe se le dice, en vez de
   * dejarlo en la del invitado o mandarlo a un archivo con datos inventados.
   */
  async function afterSignIn() {
    const role = api.session.user && api.session.user.role;
    const decision = EV2Roles.route(role, location.pathname, lang());

    if (decision.action === 'redirect') { location.href = decision.to; return; }
    if (decision.action === 'pending') {
      $('screen-auth').hidden = true;
      $('screen-app').hidden = true;
      $('screen-staff').hidden = false;
      renderStaffPending();
      return;
    }
    await enterClub();
  }

  function renderStaffPending() {
    const role = api.session.user && api.session.user.role;
    const info = EV2Roles.describe(role, lang());
    $('staff-role').textContent = info.label;
    $('staff-name').textContent = (api.session.user && api.session.user.display_name) || '';
    $('staff-does').textContent = info.does || '';
    $('staff-pending').textContent = info.step
      ? t('staff.pending', { step: info.step })
      : t('staff.noScreen');
  }

  // ---------------------------------------------------------------- carga inicial

  const clubId = () => api.session.user && api.session.user.nightclub_id;

  async function enterClub() {
    $('screen-auth').hidden = true;
    $('screen-staff').hidden = true;
    $('screen-app').hidden = false;
    const user = api.session.user || {};
    $('me-name').textContent = user.display_name || 'Invitado';
    $('profile-name').textContent = user.display_name || 'Invitado';
    $('profile-email').textContent = user.email || '';
    $('profile-role').textContent = EV2Roles.describe(user.role, lang()).label;
    $('profile-club').textContent = (state.club && state.club.name) || 'EV2 Clandestinoz';
    await Promise.all([loadFloor(), loadMenu(), loadOrders(), loadTaxi()]);
    connectRealtime();
    // El panel de cuentas ligadas no bloquea la entrada al club: si falla, el perfil
    // se queda sin ese recuadro y todo lo demás funciona.
    loadSocialPanel();
    if (socialLinkedToast) {
      toast(t('social.linked', { provider: socialLinkedToast }), 'ok');
      socialLinkedToast = null;
    }
    hub.emit('enter', context());
  }

  /** Lo que ven las pantallas de al lado. Se arma al vuelo para que nunca vean copias viejas. */
  function context() {
    return {
      api,
      clubId,
      user: () => api.session.user || {},
      club: () => state.club,
      drinks: () => state.drinks,
      myTable: () => state.myTable,
      t,
      money,
      lang,
      escape,
      toast,
      showError,
    };
  }

  /**
   * Dos llamadas, a propósito:
   *   `/floor-plan` trae el tamaño del plano y los elementos fijos (barra, pista, DJ,
   *   entrada, baños) — sin ellos el mapa es una nube de puntos sin referencia.
   *   `/tables`     es el único que dice **quién** está sentado, y sin eso la app no
   *   sabe cuál es tu mesa al recargar.
   */
  async function loadFloor() {
    try {
      const [plan, tables] = await Promise.all([
        api.get(`/nightclubs/${clubId()}/floor-plan`),
        api.get(`/nightclubs/${clubId()}/tables`),
      ]);
      state.canvas = plan.canvas || EV2Map.DEFAULT_CANVAS;
      state.landmarks = plan.landmarks || [];
      state.tables = tables.tables || [];
      state.floors = EV2Map.floors(state.tables);
      state.myTable = EV2Client.myTable(state.tables, api.session.user.id);
      if (!state.floor || !state.floors.includes(state.floor)) {
        // Al entrar se muestra el piso donde ya estás sentado, no siempre la planta baja.
        state.floor = (state.myTable && state.myTable.floor) || state.floors[0] || null;
      }
      if (state.myTable) state.selectedId = state.myTable.id;
      renderFloor();
    } catch (err) { showError(err); }
  }

  async function loadMenu() {
    try {
      const data = await api.get(`/nightclubs/${clubId()}/drinks`);
      state.drinks = data.drinks || [];
      state.categories = [...new Set(state.drinks.map((d) => d.category).filter(Boolean))].sort();
      renderMenu();
    } catch (err) { showError(err); }
  }

  async function loadOrders() {
    try {
      const data = await api.get(`/nightclubs/${clubId()}/orders/mine`);
      state.orders = data.orders || [];
      renderOrders();
    } catch (err) { showError(err); }
  }

  // ---------------------------------------------------------------- plano

  const canvasEl = () => $('floor-canvas');
  const tablesOnFloor = () => state.tables.filter((t) => !state.floor || t.floor === state.floor);
  const landmarksOnFloor = () => state.landmarks.filter(
    (m) => !state.floor || m.floor === state.floor || m.floor === 'ambas');

  function renderFloor() {
    renderFloorButtons();
    renderStats();
    renderLegend();
    drawMap();
    renderSelection();

    const table = state.myTable;
    $('me-table').textContent = table
      ? `${t('top.table')} ${table.table_number || table.code}` : t('top.noTable');
    $('profile-table').textContent = table
      ? `${table.section || ''} ${table.table_number || table.code}`.trim() : t('top.noTable');
  }

  function renderFloorButtons() {
    const box = $('floor-buttons');
    box.innerHTML = state.floors.map((f) => `
      <button class="floor-btn ${f === state.floor ? 'active' : ''}" data-floor="${escape(f)}">
        ${escape(floorName(f))}
      </button>`).join('');
    box.querySelectorAll('[data-floor]').forEach((b) => {
      b.onclick = () => {
        state.floor = b.dataset.floor;
        // Al cambiar de piso la selección deja de tener sentido, salvo que sea tu mesa.
        if (state.selectedId && !tablesOnFloor().some((t) => t.id === state.selectedId)) {
          state.selectedId = null;
        }
        renderFloor();
      };
    });
  }

  function renderStats() {
    const s = EV2Map.stats(tablesOnFloor());
    $('stat-total').textContent = s.total;
    $('stat-free').textContent = s.available;
    $('stat-vip').textContent = s.vip;
    $('stat-busy').textContent = s.occupied;
  }

  function renderLegend() {
    const items = EV2Map.zones(tablesOnFloor())
      .map((z) => ({ name: z.name, color: z.color }))
      .concat([{ name: t('map.occupied'), color: EV2Map.COLORS.red },
        { name: t('map.mine'), color: EV2Map.COLORS.mine }]);
    $('legend').innerHTML = items.map((z) => `
      <span class="flex items-center gap-1.5">
        <span class="legend-color" style="background:${escape(z.color)}"></span>${escape(z.name)}
      </span>`).join('');
  }

  function drawMap() {
    const canvas = canvasEl();
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    return EV2Map.draw(ctx, {
      canvasSize: { width: canvas.width, height: canvas.height },
      planSize: state.canvas,
      tables: tablesOnFloor(),
      landmarks: landmarksOnFloor(),
      selectedId: state.selectedId,
      myTableId: state.myTable && state.myTable.id,
    });
  }

  canvasEl().addEventListener('click', (ev) => {
    const canvas = canvasEl();
    const size = { width: canvas.width, height: canvas.height };
    const l = EV2Map.layout(size, state.canvas);
    const point = EV2Map.pointFromEvent(ev, canvas.getBoundingClientRect(), size, l);
    const table = EV2Map.hitTest(tablesOnFloor(), point);
    state.selectedId = table ? table.id : null;
    drawMap();
    renderSelection();
  });

  function selectedTable() {
    return state.tables.find((t) => t.id === state.selectedId) || null;
  }

  const TYPE_LABELS = {
    es: { booth: 'Booth', vip: 'VIP', standard: 'Estándar', bar_top: 'Barra' },
    en: { booth: 'Booth', vip: 'VIP', standard: 'Standard', bar_top: 'Bar top' },
  };
  const typeName = (type) => (TYPE_LABELS[lang()] || TYPE_LABELS.es)[type] || type || '—';
  /** El nombre del piso sale del catálogo de idioma; EV2Map solo conoce el español. */
  const FLOOR_KEYS = { baja: 'map.floorBaja', alta: 'map.floorAlta', ambas: 'map.floorAmbas' };
  const floorName = (floor) => (FLOOR_KEYS[floor]
    ? t(FLOOR_KEYS[floor]) : EV2Map.floorLabel(floor));

  /**
   * La ficha de la mesa seleccionada. Solo informa.
   *
   * Antes esto decidía si se habilitaba el botón de sentarse. Ese botón ya no
   * existe: en este club se entra por la puerta y es el escaneo del pase lo que
   * sienta a la mesa. Lo que queda es lo que el cliente sí necesita mirar — cuál
   * es su mesa, cuántos caben, cuántos hay — y una línea que explique por qué no
   * puede tocarla.
   */
  function renderSelection() {
    const table = selectedTable();
    const note = $('sel-note');
    const hint = $('sel-hint');
    const isMine = Boolean(table && state.myTable && table.id === state.myTable.id);

    if (!table) {
      $('sel-number').textContent = '—';
      $('sel-section').textContent = '—';
      $('sel-capacity').textContent = '—';
      $('sel-type').textContent = '—';
      note.hidden = true;
      hint.hidden = Boolean(state.myTable);
      return;
    }

    $('sel-number').textContent = table.table_number != null ? table.table_number : (table.code || '—');
    $('sel-section').textContent = table.section || '—';
    $('sel-capacity').textContent = `${EV2Map.seatedCount(table)}/${table.capacity}`;
    $('sel-type').textContent = typeName(table.type);

    if (isMine) {
      note.textContent = t('map.youAreHere');
      note.hidden = false;
      hint.hidden = true;
      return;
    }
    if (!EV2Map.isFree(table)) {
      note.textContent = t('map.full');
      note.hidden = false;
      hint.hidden = true;
      return;
    }
    note.hidden = true;
    // Sin mesa propia, se explica cómo se consigue una. Con mesa propia, ya lo sabe.
    hint.hidden = Boolean(state.myTable);
  }

  // ---------------------------------------------------------------- menú y carrito

  /**
   * El cuadrito de cada renglón de la carta.
   *
   * Si el producto tiene foto, la foto: nadie prefiere un dibujo cuando existe la cosa
   * real. Si no, la ilustración que le toca por su nombre. La decisión vive en
   * `EV2DrinkArt`, que sí se prueba; aquí solo se arma el HTML.
   *
   * El SVG entra sin escapar porque lo generamos nosotros, no viene de la base. La
   * dirección de la foto SÍ viene de la base y por eso va escapada.
   */
  function thumb(drink) {
    const art = EV2DrinkArt.artFor(drink);
    const caja = 'w-14 h-14 rounded-lg shrink-0 flex items-center justify-center overflow-hidden';
    if (art.type === 'photo') {
      return `<img src="${escape(art.url)}" alt="" loading="lazy" class="${caja} object-cover">`;
    }
    return `<div class="${caja}" style="background:rgba(255,255,255,.05)">${EV2DrinkArt.svgFor(drink, 40)}</div>`;
  }

  function renderMenu() {
    const cats = $('menu-categories');
    cats.innerHTML = [null, ...state.categories].map((c) => `
      <button data-cat="${c === null ? '' : escape(c)}"
              class="px-3 py-1.5 rounded-full text-sm whitespace-nowrap ${state.category === c ? 'ev2-button' : 'card'}">
        ${c === null ? escape(t('menu.all')) : escape(c)}
      </button>`).join('');
    cats.querySelectorAll('[data-cat]').forEach((b) => {
      b.onclick = () => { state.category = b.dataset.cat || null; renderMenu(); };
    });

    const list = state.drinks.filter((d) => !state.category || d.category === state.category);
    $('menu-list').innerHTML = list.map((d) => {
      const qty = cart.quantityOf(d.id);
      const out = d.available === false || Number(d.stock) <= 0;
      return `
      <div class="card rounded-xl p-3 flex items-center gap-3 ${out ? 'opacity-50' : ''}">
        ${thumb(d)}
        <div class="flex-1 min-w-0">
          <p class="font-semibold">${escape(d.name)}</p>
          <p class="text-xs text-white/50">${escape(d.category || '')}${out ? ` · ${escape(t('menu.soldOut'))}` : ''}</p>
          <p class="text-sm mt-1">${money(d.price, d.currency)}</p>
        </div>
        ${out ? '' : `
        <div class="flex items-center gap-2">
          ${qty > 0 ? `<button data-less="${d.id}" class="w-9 h-9 rounded-full card">−</button>
                       <span class="w-5 text-center">${qty}</span>` : ''}
          <button data-more="${d.id}" class="w-9 h-9 rounded-full ev2-button">+</button>
        </div>`}
      </div>`;
    }).join('') || `<p class="text-white/40 text-sm text-center py-10">${escape(t('menu.empty'))}</p>`;

    $('menu-list').querySelectorAll('[data-more]').forEach((b) => {
      b.onclick = () => {
        const drink = state.drinks.find((d) => d.id === b.dataset.more);
        // El tope no es un capricho: pedir más de lo que hay solo produce un error al final.
        if (!cart.add(drink)) toast(t('menu.noStock'));
        renderMenu(); renderCart();
      };
    });
    $('menu-list').querySelectorAll('[data-less]').forEach((b) => {
      b.onclick = () => { cart.remove(b.dataset.less); renderMenu(); renderCart(); };
    });
  }

  function renderCart() {
    const has = cart.count > 0;
    $('cart-bar').hidden = !has;
    if (!has) return;
    $('cart-count').textContent = cart.count;
    $('cart-total').textContent = money(cart.total, cart.currency);
  }

  $('btn-order').onclick = async () => {
    if (!state.myTable) {
      toast(t('orders.needTable'));
      showView('map');
      return;
    }
    const button = $('btn-order');
    button.disabled = true;
    try {
      const { order } = await api.post(`/nightclubs/${clubId()}/orders`, {
        client_request_id: cart.requestKey(EV2.uuid),
        table_id: state.myTable.id,
        items: cart.toOrderItems(),
      });
      cart.clear();
      renderMenu(); renderCart();
      state.orders.unshift(order);
      renderOrders();
      showView('orders');
      toast(t('orders.sent'), 'ok');
    } catch (err) {
      // La clave del pedido NO se regenera: si esto fue un tiempo de espera y el pedido
      // sí entró, reintentar con la misma clave devuelve el mismo, no uno nuevo.
      showError(err);
    } finally {
      button.disabled = false;
    }
  };

  // ---------------------------------------------------------------- pedidos

  function renderOrders() {
    const lang = EV2Format.getLanguage();
    const open = state.orders.filter((o) => EV2Client.isOpenOrder(o.status)).length;
    $('orders-badge').hidden = open === 0;
    $('orders-badge').textContent = open;
    $('orders-empty').hidden = state.orders.length > 0;

    $('orders-list').innerHTML = state.orders.map((o) => {
      const pct = Math.round(EV2Client.orderProgress(o.status) * 100);
      const items = (o.items || []).map((i) => `${i.quantity}× ${escape(i.name || i.drink_name || '')}`).join(', ');
      // Un pedido sin pagar no lo está preparando nadie. Decirlo aquí evita la espera
      // más frustrante que hay: la de un trago que nunca se empezó a servir.
      const porPagar = o.payment_status === 'pending' || o.payment_status === 'pending_manual';
      return `
      <div class="card rounded-xl p-3">
        <div class="flex justify-between items-start">
          <div>
            <p class="font-semibold">${EV2Client.orderLabel(o.status, lang)}</p>
            <p class="text-xs text-white/50">${items}</p>
            ${porPagar ? `<p class="text-xs text-amber-300 mt-1">${escape(t('orders.awaitingPayment'))}</p>` : ''}
          </div>
          <p class="text-sm">${money(o.total, o.currency)}</p>
        </div>
        <div class="mt-2 h-1 rounded-full bg-white/10 overflow-hidden">
          <div class="h-full ev2-button ${EV2Client.isOpenOrder(o.status) ? 'pulsing' : ''}" style="width:${pct}%"></div>
        </div>
      </div>`;
    }).join('');
  }

  // ---------------------------------------------------------------- salida segura

  const PASSENGER_CHOICES = [1, 2, 3, 4, 5, 6, 7, 8];

  /**
   * Tres llamadas: cómo está el servicio ahora, las zonas con precio, y mis viajes.
   * `rides/mine` ya devuelve cuál es el vivo, así que no hay que deducirlo aquí.
   */
  async function loadTaxi() {
    try {
      const [availability, mine] = await Promise.all([
        api.get(`/nightclubs/${clubId()}/taxi/availability`),
        api.get(`/nightclubs/${clubId()}/taxi/rides/mine?limit=10`),
      ]);
      state.taxi.availability = availability;
      state.taxi.pickup = availability.pickup_point || null;
      state.taxi.rides = mine.rides || [];
      // No solo el vivo: un viaje recién terminado se sigue mostrando mientras su
      // comprobante valga, que es cuando el cliente lo necesita.
      state.taxi.ride = EV2Taxi.currentForGuest(mine.live, state.taxi.rides);
      // El texto del código de conducta y a quién llamar viven en el club, no en el
      // viaje: se piden una vez y se quedan.
      if (!state.taxi.settings) {
        try {
          const cfg = await api.get(`/nightclubs/${clubId()}/taxi-settings`);
          state.taxi.settings = cfg.settings || null;
        } catch { state.taxi.settings = null; }
      }
      if (!state.taxi.contacts.length) {
        try {
          const contacts = await api.get(`/nightclubs/${clubId()}/emergency-contacts`);
          state.taxi.contacts = contacts.contacts || [];
        } catch { state.taxi.contacts = []; }
      }
      await loadCertificate();
      // Las zonas solo hacen falta para pedir; si el servicio está apagado no se piden.
      if (availability.enabled && state.taxi.fares.length === 0) {
        try {
          const fares = await api.get(`/nightclubs/${clubId()}/taxi-fares`);
          state.taxi.fares = fares.fares || [];
        } catch { state.taxi.fares = []; }
      }
      renderTaxi();
    } catch (err) { showError(err); }
  }

  /**
   * La constancia completa. El viaje solo trae el folio y su vencimiento; el nombre del
   * club, el del pasajero, el del conductor, la placa y el descargo viven en su propia
   * ruta. Se pide una sola vez por viaje: no cambia una vez emitida.
   *
   * Un fallo aquí no puede dejar la pantalla del taxi en blanco: sin constancia se
   * enseña el resto igual, que es lo que el cliente necesita para subirse al coche.
   */
  async function loadCertificate() {
    const ride = state.taxi.ride;
    if (!ride || !ride.certificate_folio) {
      state.taxi.certificate = null;
      state.taxi.certificateFor = null;
      return;
    }
    if (state.taxi.certificateFor === ride.id && state.taxi.certificate) return;
    try {
      const data = await api.get(`/nightclubs/${clubId()}/taxi/rides/${ride.id}/certificate`);
      state.taxi.certificate = data.certificate || null;
      state.taxi.certificateFor = ride.id;
    } catch {
      // Todavía no se emite (el viaje no ha arrancado) o no se pudo pedir: se cae al
      // folio que ya trae el viaje, que es mejor que nada.
      state.taxi.certificate = null;
      state.taxi.certificateFor = null;
    }
  }

  /** Un aviso por cambio de estado, y vibración cuando toca levantarse a caminar. */
  function announceTaxi() {
    const head = EV2Taxi.guestHeadline(state.taxi.ride, state.taxi.availability);
    toast(t(head.key, head.vars), head.urgent ? 'ok' : 'info');
    if (!head.urgent) return;
    try {
      if (navigator.vibrate) navigator.vibrate([200, 80, 200]);
    } catch { /* algunos navegadores lo bloquean sin interacción previa */ }
  }

  function renderTaxi() {
    const ride = state.taxi.ride;
    const head = EV2Taxi.guestHeadline(ride, state.taxi.availability);
    const live = Boolean(ride && EV2Taxi.isLive(ride.status));
    // La tarjeta se muestra también con el viaje ya terminado (por el comprobante);
    // el formulario reaparece en cuanto deja de estar vivo, para poder pedir otro.
    const showCard = Boolean(ride);

    $('taxi-headline-text').textContent = t(head.key, head.vars);
    $('taxi-headline').style.borderColor = head.urgent ? 'var(--ev2-lime)' : 'var(--ev2-cyan)';
    $('taxi-headline-text').style.color = head.urgent ? 'var(--ev2-lime)' : '';

    // La insignia de la pestaña: se ve el aviso aunque estés en el menú pidiendo.
    $('taxi-badge').hidden = !head.urgent;
    $('taxi-badge').textContent = '!';

    const pickup = state.taxi.pickup;
    $('taxi-pickup').hidden = !pickup;
    if (pickup) $('taxi-pickup').textContent = `${t('taxi.pickup')}: ${pickup}`;

    $('taxi-live').hidden = !showCard;
    $('taxi-form').hidden = live || !(state.taxi.availability && state.taxi.availability.enabled);

    if (showCard) renderLiveRide(ride);
    renderTaxiForm();
    renderConduct();
    renderEmergency();
    renderTaxiHistory();
  }

  function renderLiveRide(ride) {
    const driver = ride.driver;
    $('taxi-driver-name').textContent = driver
      ? [driver.name, driver.company].filter(Boolean).join(' · ') : t('taxi.searching');
    $('taxi-vehicle').textContent = EV2Taxi.vehicleLabel(ride) || '';

    // El teléfono del conductor solo existe cuando ya aceptó: antes no hay a quién llamar.
    const call = $('taxi-call');
    call.hidden = !(driver && driver.phone);
    if (driver && driver.phone) call.href = `tel:${driver.phone}`;

    const amount = EV2Taxi.fareAmount(ride);
    $('taxi-fare').textContent = amount === null
      ? t('taxi.fareOpen') : money(amount, ride.currency);

    renderCertificate(ride);

    $('btn-taxi-cancel').hidden = !EV2Taxi.canCancel(ride.status);
  }

  /**
   * La constancia en pantalla. Se arma con la ficha completa cuando ya llegó, y si no
   * con el folio que trae el viaje: nunca se deja al cliente sin el número, que es lo
   * único que prueba a qué hora y con quién salió del club.
   */
  function renderCertificate(ride) {
    const short = EV2Taxi.certificate(ride);
    const full = state.taxi.certificate;
    const view = EV2Taxi.certificateView(full) || (short ? {
      folio: short.folio, nightclub: null, issuedAt: null, expiresAt: short.expires_at,
      expired: short.expired, valid: !short.expired, rows: [], disclaimer: null,
    } : null);

    $('taxi-certificate').hidden = !view;
    if (!view) return;

    $('taxi-folio').textContent = view.folio;
    const stateEl = $('taxi-cert-state');
    stateEl.textContent = t(view.valid ? 'verify.valid' : 'verify.expired');
    stateEl.style.color = view.valid ? 'var(--ev2-lime)' : '#fca5a5';

    $('taxi-cert-rows').innerHTML = view.rows.map((row) => `
      <div class="flex justify-between gap-3 py-1.5 text-sm">
        <dt class="text-white/50">${escape(t(row.labelKey))}</dt>
        <dd class="text-right">${escape(row.value)}</dd>
      </div>`).join('');

    $('taxi-cert-club').textContent = view.nightclub || '';
    $('taxi-cert-issued').textContent = view.issuedAt
      ? t('cert.issuedAt', { when: EV2Format.dateTime(view.issuedAt) }) : '';
    $('taxi-cert-expires').textContent = view.expiresAt
      ? t(view.expired ? 'cert.expiredAt' : 'cert.expiresAt',
        { when: EV2Format.dateTime(view.expiresAt) }) : '';
    $('taxi-cert-disclaimer').textContent = view.disclaimer || '';
    // El enlace lleva el folio puesto: quien lo abra no tiene que teclearlo.
    $('taxi-cert-link').href = `verificar.html?folio=${encodeURIComponent(view.folio)}`;
    $('taxi-cert-expired').hidden = !view.expired;
  }

  /**
   * El código de conducta y la casilla. Sin club que publique reglas, ni el panel ni el
   * bloqueo existen: no se le pide a nadie que acepte una hoja en blanco.
   */
  function renderConduct() {
    const terms = EV2Taxi.conductTerms(state.taxi.settings);
    $('taxi-conduct').hidden = !terms;
    if (terms) $('taxi-conduct-text').textContent = terms;
    $('btn-taxi-request').disabled = !!EV2Taxi.requestBlocker(
      state.taxi.settings, $('taxi-conduct-accept').checked);
  }

  $('taxi-conduct-accept').onchange = renderConduct;

  /** A quién llamar. Cada renglón marca de verdad: es un enlace tel:, no un texto. */
  function renderEmergency() {
    const list = state.taxi.contacts;
    $('taxi-emergency').hidden = list.length === 0;
    const box = $('emergency-list');
    box.innerHTML = '';
    for (const contact of list) {
      const row = document.createElement('a');
      row.href = `tel:${contact.phone}`;
      row.className = 'flex items-center justify-between gap-3 card rounded-lg px-3 py-2 tap';
      row.innerHTML = `<span class="text-sm truncate">${escape(contact.name)}</span>`
        + `<span class="text-sm" style="color:var(--ev2-cyan)">${escape(contact.phone)}</span>`;
      box.appendChild(row);
    }
  }

  function renderTaxiForm() {
    const zone = $('taxi-zone');
    if (zone.dataset.filled !== String(state.taxi.fares.length)) {
      zone.innerHTML = [`<option value="">${escape(t('taxi.zoneAny'))}</option>`]
        .concat(state.taxi.fares.map((f) => `<option value="${escape(f.id)}">${escape(f.zone)} · ${escape(EV2Format.money(f.amount, f.currency))}</option>`))
        .join('');
      zone.dataset.filled = String(state.taxi.fares.length);
    }
    const people = $('taxi-passengers');
    if (!people.dataset.filled) {
      people.innerHTML = PASSENGER_CHOICES.map((n) => `<option value="${n}">${n}</option>`).join('');
      people.dataset.filled = '1';
    }
    $('btn-taxi-request').textContent = t('taxi.request');
  }

  function renderTaxiHistory() {
    const shown = state.taxi.ride && state.taxi.ride.id;
    const past = state.taxi.rides.filter((r) => !EV2Taxi.isLive(r.status) && r.id !== shown);
    $('taxi-empty').hidden = past.length > 0;
    $('taxi-history').innerHTML = past.map((r) => {
      const amount = EV2Taxi.fareAmount(r);
      const head = EV2Taxi.guestHeadline(r, null);
      return `
      <div class="card rounded-xl p-3 flex justify-between items-center">
        <div class="min-w-0">
          <p class="text-sm">${escape(r.destination || r.destination_zone || t('taxi.zoneAny'))}</p>
          <p class="text-xs text-white/45">${escape(EV2Format.dateTime(r.created_at))} · ${escape(t(head.key, head.vars))}</p>
        </div>
        <p class="text-sm flex-none ml-3">${amount === null ? '—' : escape(money(amount, r.currency))}</p>
      </div>`;
    }).join('');
  }

  $('taxi-form').onsubmit = async (ev) => {
    ev.preventDefault();
    const blocker = EV2Taxi.requestBlocker(
      state.taxi.settings, $('taxi-conduct-accept').checked);
    if (blocker) { toast(t(blocker), 'error'); return; }
    const button = $('btn-taxi-request');
    button.disabled = true;
    button.textContent = t('taxi.requesting');
    try {
      const body = {
        // Misma clave si el botón se toca dos veces o se cae la señal: el servidor
        // devuelve la solicitud que ya existe en vez de abrir una segunda.
        client_request_id: EV2.uuid(),
        passengers: Number($('taxi-passengers').value) || 1,
      };
      const zone = $('taxi-zone').value;
      if (zone) body.fare_id = zone;
      const destination = $('taxi-destination').value.trim();
      if (destination) body.destination = destination;
      const notes = $('taxi-notes').value.trim();
      if (notes) body.notes = notes;
      // Solo `true` cuenta como aceptación, y el servidor lo vuelve a comprobar.
      if (EV2Taxi.conductTerms(state.taxi.settings)) body.conduct_accepted = true;

      const data = await api.post(`/nightclubs/${clubId()}/taxi/rides`, body);
      state.taxi.ride = data.ride;
      if (data.availability) state.taxi.availability = Object.assign(
        {}, state.taxi.availability, data.availability);
      if (data.pickup_point) state.taxi.pickup = data.pickup_point;
      renderTaxi();
      announceTaxi();
    } catch (err) {
      showError(err);
    } finally {
      button.textContent = t('taxi.request');
      // No se reactiva a ciegas: si el club exige el código y la casilla está sin
      // marcar, el botón tiene que seguir apagado.
      renderConduct();
    }
  };

  $('btn-taxi-cancel').onclick = async () => {
    const ride = state.taxi.ride;
    if (!ride || !window.confirm(t('taxi.confirmCancel'))) return;
    try {
      await api.post(`/nightclubs/${clubId()}/taxi/rides/${ride.id}/cancel`, {});
      await loadTaxi();
    } catch (err) { showError(err); }
  };

  // ---------------------------------------------------------------- navegación

  const VIEWS = ['map', 'menu', 'orders', 'show', 'flirt', 'taxi', 'profile'];

  function showView(name) {
    for (const v of VIEWS) $(`view-${v}`).hidden = v !== name;
    document.querySelectorAll('.nav-tab').forEach((b) => {
      b.className = `nav-tab py-3 text-[10px] ${b.dataset.view === name ? 'tab-active' : 'text-white/50'}`;
    });
    // El lienzo se mide al mostrarse: dibujarlo mientras estaba oculto lo deja en blanco.
    if (name === 'map') drawMap();
    hub.emit('view', name);
  }
  document.querySelectorAll('.nav-tab').forEach((b) => { b.onclick = () => showView(b.dataset.view); });

  // ---------------------------------------------------------------- tiempo real

  // Se recuerda el último estado para poder repintarlo al cambiar de idioma.
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
    rt.on('replaced', () => {
      setConnection(false, 'top.otherSession');
      banner(t('banner.replaced'));
    });
    // El hueco fue mayor de lo que el servidor reproduce: recargar es lo honesto, en vez
    // de seguir pintando un estado que ya no corresponde.
    rt.on('resync_required', async () => {
      banner(t('banner.updating'));
      await Promise.all([loadFloor(), loadOrders(), loadTaxi()]);
      banner(null);
    });

    rt.on('event', async (message) => {
      const change = EV2Client.applyEvent(state, message);
      if (!change) return;
      if (change.changed === 'orders') {
        if (change.unknownOrder) await loadOrders(); else renderOrders();
        if (change.status === 'ready') toast(t('orders.ready'), 'ok');
      }
      if (change.changed === 'floorPlan') await loadFloor();
    });

    // Las pantallas de propinas, música y reservación escuchan el MISMO socket: abrir
    // una segunda conexión haría que el servidor cerrara la primera por sesión repetida.
    rt.on('event', (message) => hub.emit('event', message));

    // Los eventos del taxi los interpreta su propio módulo: el mensaje trae el id del
    // viaje, no el coche ni el teléfono, así que casi siempre hay que volver a pedirlo.
    rt.on('event', async (message) => {
      const change = EV2Taxi.applyEvent(state.taxi.ride, message);
      if (!change.changed) return;
      const before = state.taxi.ride && state.taxi.ride.status;
      await loadTaxi();
      const now = state.taxi.ride && state.taxi.ride.status;
      // Solo se avisa cuando de verdad cambió algo, para no repetir el mismo aviso si
      // el socket reproduce eventos al reconectar.
      if (now && now !== before) announceTaxi();
    });

    api.on('auth:expired', () => {
      banner(t('banner.expired'));
      setTimeout(() => location.reload(), 2500);
    });

    rt.connect();
  }

  // ---------------------------------------------------------------- arranque

  (async function boot() {
    // El idioma guardado (o el del navegador) se aplica ANTES de la primera pantalla:
    // si no, se ve un parpadeo en español y luego cambia.
    EV2Format.setLanguage(EV2Format.getLanguage());
    EV2Format.applyTo(document);
    $('btn-lang').textContent = EV2Format.otherLanguage().toUpperCase();
    try {
      const data = await api.get(`/nightclubs/by-slug/${encodeURIComponent(CLUB_SLUG)}`);
      state.club = data.nightclub;
      // Viene del servidor, no del catálogo: se le quita la marca para que un cambio
      // de idioma no lo reemplace por el texto por omisión.
      $('club-city').removeAttribute('data-i18n');
      $('club-city').textContent = `${data.nightclub.city}, ${data.nightclub.country}`;
    } catch {
      // Sin club no se puede entrar, pero la pantalla de acceso debe verse igual.
    }
    // Los botones sociales, antes de retomar la sesión: si la persona no tiene sesión
    // guardada, lo primero que ve es la pantalla de acceso ya completa.
    loadSocialButtons();

    // La vuelta del proveedor manda sobre la sesión guardada: quien acaba de entrar
    // con Facebook espera entrar CON ESA cuenta, no con la que quedó en el teléfono.
    if (await handleSocialReturn()) return;

    const user = await api.resume();
    if (user) await afterSignIn();
  }());

  // Se publica al final, ya con todo armado: un archivo que se cargue antes encontraría
  // la mitad de las funciones sin definir.
  window.EV2Screen = { on: hub.on, context };
}());
