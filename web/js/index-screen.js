/**
 * EV2 — pantalla del cliente.
 *
 * Solo conecta el DOM con `EV2` (API y socket), `EV2Client` (carrito, pedidos, eventos),
 * `EV2Map` (plano) y `EV2Roles` (a dónde va cada rol). Ninguna decisión de negocio vive
 * aquí: si algo hay que probar, va en esos módulos.
 */
/* global EV2, EV2Format, EV2Client, EV2Map, EV2Roles */
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
  };
  const cart = EV2Client.createCart();

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
  const escape = (s) => String(s == null ? '' : s).replace(/[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /** Un error de la API se muestra tal cual: dice *por qué* mejor que un texto genérico. */
  function showError(err, where) {
    const message = EV2Format.errorMessage(err);
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
      showError(err, $('auth-error'));
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

  $('btn-lang').onclick = () => {
    const next = EV2Format.getLanguage() === 'es' ? 'en' : 'es';
    EV2Format.setLanguage(next);
    $('btn-lang').textContent = next === 'es' ? 'EN' : 'ES';
    renderOrders();
    renderMenu();
  };

  // ---------------------------------------------------------------- ruteo por rol

  /**
   * Un bartender no tiene por qué ver el plano de mesas para sentarse. Si su pantalla
   * ya está conectada se le manda ahí; si todavía no existe se le dice, en vez de
   * dejarlo en la del invitado o mandarlo a un archivo con datos inventados.
   */
  async function afterSignIn() {
    const role = api.session.user && api.session.user.role;
    const decision = EV2Roles.route(role, location.pathname);

    if (decision.action === 'redirect') { location.href = decision.to; return; }
    if (decision.action === 'pending') { showStaffPending(decision.info); return; }
    await enterClub();
  }

  function showStaffPending(info) {
    $('screen-auth').hidden = true;
    $('screen-app').hidden = true;
    $('screen-staff').hidden = false;
    $('staff-role').textContent = info.label;
    $('staff-name').textContent = (api.session.user && api.session.user.display_name) || '';
    $('staff-does').textContent = info.does || '';
    $('staff-pending').textContent = info.step
      ? `Esta pantalla todavía no está conectada al servidor. Se construye en el paso ${info.step} del plan de implementación.`
      : 'Esta cuenta no tiene una pantalla asignada. Avisa al administrador del club.';
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
    $('profile-role').textContent = EV2Roles.describe(user.role).label;
    $('profile-club').textContent = (state.club && state.club.name) || 'EV2 Clandestinoz';
    await Promise.all([loadFloor(), loadMenu(), loadOrders()]);
    connectRealtime();
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
    $('me-table').textContent = table ? `mesa ${table.table_number || table.code}` : 'sin mesa';
    $('profile-table').textContent = table
      ? `${table.section || ''} ${table.table_number || table.code}`.trim() : 'sin mesa';
  }

  function renderFloorButtons() {
    const box = $('floor-buttons');
    box.innerHTML = state.floors.map((f) => `
      <button class="floor-btn ${f === state.floor ? 'active' : ''}" data-floor="${escape(f)}">
        ${escape(EV2Map.floorLabel(f))}
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
      .concat([{ name: 'Ocupada', color: EV2Map.COLORS.red },
        { name: 'Tu mesa', color: EV2Map.COLORS.mine }]);
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
    booth: 'Booth', vip: 'VIP', standard: 'Estándar', bar_top: 'Barra',
  };

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
      sit.textContent = 'Sentarme aquí';
      return;
    }

    $('sel-number').textContent = table.table_number != null ? table.table_number : (table.code || '—');
    $('sel-section').textContent = table.section || '—';
    $('sel-capacity').textContent = `${EV2Map.seatedCount(table)}/${table.capacity}`;
    $('sel-type').textContent = TYPE_LABELS[table.type] || (table.type || '—');

    if (isMine) {
      note.textContent = 'Aquí estás sentado.';
      note.hidden = false;
      sit.disabled = true;
      sit.textContent = 'Ya estás en esta mesa';
      return;
    }
    if (!EV2Map.isFree(table)) {
      note.textContent = table.status && table.status !== 'available'
        ? `Esta mesa está ${escape(table.status)}.`
        : 'Esta mesa ya está llena.';
      note.hidden = false;
      sit.disabled = true;
      sit.textContent = 'No disponible';
      return;
    }
    note.hidden = true;
    sit.disabled = false;
    sit.textContent = mine ? 'Cambiarme a esta mesa' : 'Sentarme aquí';
  }

  $('btn-sit').onclick = async () => {
    const table = selectedTable();
    if (!table) return;
    const button = $('btn-sit');
    button.disabled = true;
    try {
      await api.post(`/nightclubs/${clubId()}/tables/${table.id}/seat`, {});
      await loadFloor();
      toast('Listo, esa es tu mesa', 'ok');
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
        ${c === null ? 'Todo' : escape(c)}
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
          <p class="text-xs text-white/50">${escape(d.category || '')}${out ? ' · agotado' : ''}</p>
          <p class="text-sm mt-1">${money(d.price, d.currency)}</p>
        </div>
        ${out ? '' : `
        <div class="flex items-center gap-2">
          ${qty > 0 ? `<button data-less="${d.id}" class="w-9 h-9 rounded-full card">−</button>
                       <span class="w-5 text-center">${qty}</span>` : ''}
          <button data-more="${d.id}" class="w-9 h-9 rounded-full ev2-button">+</button>
        </div>`}
      </div>`;
    }).join('') || '<p class="text-white/40 text-sm text-center py-10">No hay bebidas en esta categoría.</p>';

    $('menu-list').querySelectorAll('[data-more]').forEach((b) => {
      b.onclick = () => {
        const drink = state.drinks.find((d) => d.id === b.dataset.more);
        // El tope no es un capricho: pedir más de lo que hay solo produce un error al final.
        if (!cart.add(drink)) toast('No hay más existencias de eso');
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
      toast('Primero elige tu mesa: el mesero necesita saber a dónde llevarlo');
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
      toast('Pedido enviado a la barra', 'ok');
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

  // ---------------------------------------------------------------- navegación

  const VIEWS = ['map', 'menu', 'orders', 'profile'];

  function showView(name) {
    for (const v of VIEWS) $(`view-${v}`).hidden = v !== name;
    document.querySelectorAll('.nav-tab').forEach((b) => {
      b.className = `nav-tab py-3 text-xs ${b.dataset.view === name ? 'tab-active' : 'text-white/50'}`;
    });
    // El lienzo se mide al mostrarse: dibujarlo mientras estaba oculto lo deja en blanco.
    if (name === 'map') drawMap();
  }
  document.querySelectorAll('.nav-tab').forEach((b) => { b.onclick = () => showView(b.dataset.view); });

  // ---------------------------------------------------------------- tiempo real

  function setConnection(on, text) {
    $('rt-dot').className = `dot ${on === true ? 'dot-on' : on === null ? 'dot-wait' : 'dot-off'}`;
    $('rt-text').textContent = text;
  }

  function connectRealtime() {
    const rt = api.createRealtime();
    state.realtime = rt;

    rt.on('open', () => { setConnection(true, 'En vivo'); banner(null); });
    rt.on('reconnecting', (i) => setConnection(null, `Reconectando en ${Math.round(i.in_ms / 1000)}s`));
    rt.on('close', () => setConnection(false, 'Sin conexión'));
    rt.on('replaced', () => {
      setConnection(false, 'Otra sesión');
      banner('Abriste la app en otro lado. Recarga si quieres seguir aquí.');
    });
    // El hueco fue mayor de lo que el servidor reproduce: recargar es lo honesto, en vez
    // de seguir pintando un estado que ya no corresponde.
    rt.on('resync_required', async () => {
      banner('Actualizando…');
      await Promise.all([loadFloor(), loadOrders()]);
      banner(null);
    });

    rt.on('event', async (message) => {
      const change = EV2Client.applyEvent(state, message);
      if (!change) return;
      if (change.changed === 'orders') {
        if (change.unknownOrder) await loadOrders(); else renderOrders();
        if (change.status === 'ready') toast('¡Tu pedido está listo en la barra!', 'ok');
      }
      if (change.changed === 'floorPlan') await loadFloor();
    });

    api.on('auth:expired', () => {
      banner('Tu sesión terminó. Vuelve a entrar.');
      setTimeout(() => location.reload(), 2500);
    });

    rt.connect();
  }

  // ---------------------------------------------------------------- arranque

  (async function boot() {
    try {
      const data = await api.get(`/nightclubs/by-slug/${encodeURIComponent(CLUB_SLUG)}`);
      state.club = data.nightclub;
      $('club-city').textContent = `${data.nightclub.city}, ${data.nightclub.country}`;
    } catch {
      // Sin club no se puede entrar, pero la pantalla de acceso debe verse igual.
    }
    const user = await api.resume();
    if (user) await afterSignIn();
  }());
}());
