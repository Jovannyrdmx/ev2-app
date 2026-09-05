/**
 * EV2 — pantalla del cliente.
 *
 * Solo conecta el DOM con `EV2` (API y socket), `EV2Client` (carrito, pedidos, eventos),
 * `EV2Map` (plano) y `EV2Roles` (a dónde va cada rol). Ninguna decisión de negocio vive
 * aquí: si algo hay que probar, va en esos módulos.
 */
/* global EV2, EV2Format, EV2Client, EV2Map, EV2Roles, EV2Taxi */
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
    taxi: { availability: null, ride: null, rides: [], fares: [], pickup: null },
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

  function renderSelection() {
    const table = selectedTable();
    const sit = $('btn-sit');
    const leave = $('btn-leave');
    const note = $('sel-note');
    const mine = Boolean(state.myTable);
    const isMine = Boolean(table && state.myTable && table.id === state.myTable.id);

    leave.hidden = !mine;

    if (!table) {
      $('sel-number').textContent = '—';
      $('sel-section').textContent = '—';
      $('sel-capacity').textContent = '—';
      $('sel-type').textContent = '—';
      note.hidden = true;
      sit.disabled = true;
      sit.textContent = t('map.sit');
      return;
    }

    $('sel-number').textContent = table.table_number != null ? table.table_number : (table.code || '—');
    $('sel-section').textContent = table.section || '—';
    $('sel-capacity').textContent = `${EV2Map.seatedCount(table)}/${table.capacity}`;
    $('sel-type').textContent = typeName(table.type);

    if (isMine) {
      note.textContent = t('map.youAreHere');
      note.hidden = false;
      sit.disabled = true;
      sit.textContent = t('map.alreadyHere');
      return;
    }
    if (!EV2Map.isFree(table)) {
      note.textContent = t('map.full');
      note.hidden = false;
      sit.disabled = true;
      sit.textContent = t('map.unavailable');
      return;
    }
    note.hidden = true;
    sit.disabled = false;
    sit.textContent = mine ? t('map.move') : t('map.sit');
  }

  $('btn-sit').onclick = async () => {
    const table = selectedTable();
    if (!table) return;
    const button = $('btn-sit');
    button.disabled = true;
    try {
      await api.post(`/nightclubs/${clubId()}/tables/${table.id}/seat`, {});
      await loadFloor();
      toast(t('map.seated'), 'ok');
    } catch (err) {
      showError(err);
      renderSelection();
    }
  };

  $('btn-leave').onclick = async () => {
    if (!state.myTable) return;
    try {
      await api.post(`/nightclubs/${clubId()}/tables/${state.myTable.id}/release`, {});
      state.myTable = null;
      state.selectedId = null;
      await loadFloor();
    } catch (err) { showError(err); }
  };

  // ---------------------------------------------------------------- menú y carrito

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
        <div class="flex-1">
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
      return `
      <div class="card rounded-xl p-3">
        <div class="flex justify-between items-start">
          <div>
            <p class="font-semibold">${EV2Client.orderLabel(o.status, lang)}</p>
            <p class="text-xs text-white/50">${items}</p>
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

  /** Un aviso por cambio de estado, y vibración cuando toca levantarse a caminar. */
  function announceTaxi(status) {
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

    const cert = EV2Taxi.certificate(ride);
    $('taxi-certificate').hidden = !cert;
    if (cert) {
      $('taxi-folio').textContent = cert.folio;
      $('taxi-cert-expired').hidden = !cert.expired;
    }

    $('btn-taxi-cancel').hidden = !EV2Taxi.canCancel(ride.status);
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

      const data = await api.post(`/nightclubs/${clubId()}/taxi/rides`, body);
      state.taxi.ride = data.ride;
      if (data.availability) state.taxi.availability = Object.assign(
        {}, state.taxi.availability, data.availability);
      if (data.pickup_point) state.taxi.pickup = data.pickup_point;
      renderTaxi();
      announceTaxi(data.ride.status);
    } catch (err) {
      showError(err);
    } finally {
      button.disabled = false;
      button.textContent = t('taxi.request');
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

  const VIEWS = ['map', 'menu', 'orders', 'show', 'taxi', 'profile'];

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
      if (now && now !== before) announceTaxi(now);
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
    const user = await api.resume();
    if (user) await afterSignIn();
  }());

  // Se publica al final, ya con todo armado: un archivo que se cargue antes encontraría
  // la mitad de las funciones sin definir.
  window.EV2Screen = { on: hub.on, context };
}());
