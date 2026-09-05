/**
 * EV2 — pantalla del cliente (paso 5.2).
 *
 * Solo conecta el DOM con `EV2` (API y socket) y `EV2Client` (carrito, plano, eventos).
 * Ninguna decisión de negocio vive aquí: si algo hay que probar, va en client.js.
 */
/* global EV2, EV2Format, EV2Client */
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
  const CLUB_SLUG = meta('ev2:club', 'ev2-clandestinoz');

  const state = {
    club: null, drinks: [], categories: [], category: null,
    floorPlan: [], myTable: null, orders: [], realtime: null,
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
      await enterClub();
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
      await enterClub();
    } catch (err) {
      // El servidor distingue "menor de edad" de "correo repetido"; ese texto es el útil.
      showError(err, $('auth-error'));
    }
  };

  $('btn-logout').onclick = async () => {
    if (state.realtime) state.realtime.close();
    await api.logout();
    location.reload();
  };

  $('btn-lang').onclick = () => {
    const next = EV2Format.getLanguage() === 'es' ? 'en' : 'es';
    EV2Format.setLanguage(next);
    $('btn-lang').textContent = next === 'es' ? 'EN' : 'ES';
    renderOrders();
    renderMenu();
  };

  // ---------------------------------------------------------------- carga inicial

  const clubId = () => api.session.user && api.session.user.nightclub_id;

  async function enterClub() {
    $('screen-auth').hidden = true;
    $('screen-app').hidden = false;
    $('me-name').textContent = (api.session.user && api.session.user.display_name) || 'Invitado';
    await Promise.all([loadFloorPlan(), loadMenu(), loadOrders()]);
    connectRealtime();
  }

  /**
   * Se usa `/tables` y no `/floor-plan`: es el único que dice **quién** está sentado, y
   * sin eso la app no sabe cuál es tu mesa al recargar. Trae además capacidad, zona,
   * piso y estado, así que una sola llamada basta para dibujar todo.
   */
  async function loadFloorPlan() {
    try {
      const data = await api.get(`/nightclubs/${clubId()}/tables`);
      state.floorPlan = data.tables || [];
      state.myTable = EV2Client.myTable(state.floorPlan, api.session.user.id);
      renderFloorPlan();
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

  // ---------------------------------------------------------------- mesa

  function renderFloorPlan() {
    const box = $('floor-plan');
    const groups = EV2Client.groupFloorPlan(state.floorPlan);
    $('my-table-box').hidden = !state.myTable;
    $('tables-hint').hidden = Boolean(state.myTable);
    if (state.myTable) {
      $('my-table-name').textContent = `${state.myTable.section || ''} ${state.myTable.table_number || state.myTable.code}`.trim();
      $('me-table').textContent = `mesa ${state.myTable.table_number || state.myTable.code}`;
    } else {
      $('me-table').textContent = 'sin mesa';
    }

    box.innerHTML = groups.map((floor) => `
      <div>
        <p class="text-xs uppercase tracking-wider text-white/40 mb-2">${escape(floor.label)}</p>
        ${floor.zones.map((z) => `
          <p class="text-sm text-white/70 mt-3 mb-1">${escape(z.zone)}</p>
          <div class="grid grid-cols-3 gap-2">
            ${z.tables.map((t) => {
    const mine = state.myTable && state.myTable.id === t.id;
    const selectable = EV2Client.tableIsSelectable(t);
    const cls = mine ? 'card card-mine' : selectable ? 'card card-free' : 'card card-full';
    const seated = EV2Client.seatedCount(t);
    return `<button class="${cls} rounded-xl p-2 text-center tap" data-table="${t.id}"
                      ${selectable || mine ? '' : 'disabled'}>
                <span class="block font-display">${escape(t.table_number || t.code)}</span>
                <span class="block text-[11px] text-white/50">${seated}/${t.capacity}</span>
              </button>`;
  }).join('')}
          </div>`).join('')}
      </div>`).join('') || '<p class="text-white/40 text-sm">El plano todavía no está cargado.</p>';

    box.querySelectorAll('[data-table]').forEach((btn) => {
      btn.onclick = () => sitAt(btn.dataset.table);
    });
  }

  async function sitAt(tableId) {
    try {
      await api.post(`/nightclubs/${clubId()}/tables/${tableId}/seat`, {});
      await loadFloorPlan();
      toast('Listo, esa es tu mesa', 'ok');
    } catch (err) { showError(err); }
  }

  $('btn-leave').onclick = async () => {
    if (!state.myTable) return;
    try {
      await api.post(`/nightclubs/${clubId()}/tables/${state.myTable.id}/release`, {});
      state.myTable = null;
      await loadFloorPlan();
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
      showView('tables');
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

  function showView(name) {
    for (const v of ['tables', 'menu', 'orders']) $(`view-${v}`).hidden = v !== name;
    document.querySelectorAll('.nav-tab').forEach((b) => {
      b.className = `nav-tab py-3 text-xs ${b.dataset.view === name ? 'tab-active' : 'text-white/50'}`;
    });
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
      await Promise.all([loadFloorPlan(), loadOrders()]);
      banner(null);
    });

    rt.on('event', async (message) => {
      const change = EV2Client.applyEvent(state, message);
      if (!change) return;
      if (change.changed === 'orders') {
        if (change.unknownOrder) await loadOrders(); else renderOrders();
        if (change.status === 'ready') toast('¡Tu pedido está listo en la barra!', 'ok');
      }
      if (change.changed === 'floorPlan') await loadFloorPlan();
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
    if (user) await enterClub();
  }());
}());
