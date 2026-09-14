/**
 * EV2 — pantalla de la barra (paso 5.7).
 *
 * Conecta el DOM con `EV2` (API y socket), `EV2Bar` (la cola) y `EV2Roles` (quién puede
 * abrir esto). Las decisiones —qué carril, qué botón, qué hace un evento— viven en
 * `bar-queue.js` y están probadas ahí.
 */
/* global EV2, EV2Format, EV2Bar, EV2Client, EV2OrderTaking, EV2Receiving, EV2Roles, EV2PasswordGate */
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

  /** Quién puede operar la barra. El servidor manda igual: esto solo evita la pantalla. */
  const BAR_ROLES = ['bartender', 'manager', 'admin'];
  const ALERT_KEY = 'ev2.bar.alert';

  const state = {
    orders: [], lane: 'new', realtime: null, busy: new Set(), arrived: new Set(),
    alert: true,
    // La barra en la que esta parado el cantinero. Se recuerda en el aparato, porque
    // el telefono de la barra de arriba es siempre el de la barra de arriba.
    bars: [], barId: null,
    // La venta en la barra: la carta de ESA barra y el carrito de quien esta enfrente.
    drinks: [], sale: { open: false, cart: null, search: '', sending: false },
  };
  const BAR_KEY = 'ev2.bar.location';

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

  $('btn-lang').onclick = () => {
    EV2Format.setLanguage(EV2Format.otherLanguage());
    applyLanguage();
  };

  function applyLanguage() {
    EV2Format.applyTo(document);
    $('btn-lang').textContent = EV2Format.otherLanguage().toUpperCase();
    renderAll();
    if (!$('screen-wrong-role').hidden) renderWrongRole();
    if (state.sale && state.sale.open) { renderSaleMethods(); renderSale(); }
    setConnection(lastConnection.on, lastConnection.key, lastConnection.vars);
  }

  const PASSWORD_GATE_HIDES = ['screen-auth', 'screen-wrong-role', 'screen-bar', 'sale-sheet'];

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

  /**
   * Un invitado que llega aquí por un enlace no debe ver los pedidos de todo el club.
   * Se le manda a su pantalla en vez de dejarlo con una lista vacía sin explicación.
   */
  async function afterSignIn() {
    if (EV2PasswordGate.isRequired(api.session.user)) { showPasswordGate(); return; }
    const role = api.session.user && api.session.user.role;
    if (!BAR_ROLES.includes(role)) {
      const home = EV2Roles.describe(role, lang());
      if (home.ready && home.home && home.home !== 'bartender.html') {
        location.href = home.home;
        return;
      }
      renderWrongRole();
      $('screen-auth').hidden = true;
      $('screen-bar').hidden = true;
      $('screen-wrong-role').hidden = false;
      return;
    }
    await enterBar();
  }

  function renderWrongRole() {
    const role = api.session.user && api.session.user.role;
    const info = EV2Roles.describe(role, lang());
    $('wrong-role').textContent = info.label;
    $('wrong-role-note').textContent = info.step
      ? t('staff.pending', { step: info.step }) : t('staff.noScreen');
  }

  const clubId = () => api.session.user && api.session.user.nightclub_id;

  async function enterBar() {
    $('screen-auth').hidden = true;
    $('screen-wrong-role').hidden = true;
    $('screen-bar').hidden = false;
    $('me-name').textContent = (api.session.user && api.session.user.display_name) || '';
    await loadBars();
    await loadQueue();
    // Lo pedido y todavía no surtido, para que el número del botón avise en cuanto
    // se abre la pantalla y nadie pida dos veces lo mismo.
    await loadMyRequests();
    connectRealtime();
    // El reloj de espera avanza solo: sin esto, "hace 2 min" se queda en 2 min toda la
    // noche y el color deja de avisar.
    setInterval(renderAll, 30000);
  }

  /**
   * Las barras del club.
   *
   * Sin esto la pantalla mezclaba las dos colas: el cantinero de arriba veia -y podia
   * preparar- los tragos de abajo, que salen de un estante que no tiene enfrente.
   */
  async function loadBars() {
    try {
      const data = await api.get(`/nightclubs/${clubId()}/supply-locations`);
      state.bars = (data.locations || []).filter((l) => l.kind === 'bar' && l.active);
      let saved = null;
      try { saved = localStorage.getItem(BAR_KEY); } catch { saved = null; }
      const known = state.bars.some((b) => b.id === saved);
      // Con una sola barra no hay nada que elegir; con varias, la recordada, y si no
      // ninguna: "todas" es honesto mientras nadie diga en cual esta.
      state.barId = known ? saved : (state.bars.length === 1 ? state.bars[0].id : null);
    } catch (err) { showError(err); }
  }

  function chooseBar(barId) {
    state.barId = barId;
    try {
      if (barId) localStorage.setItem(BAR_KEY, barId);
      else localStorage.removeItem(BAR_KEY);
    } catch { /* navegacion privada: la eleccion vive solo en memoria */ }
    // La carta traia las existencias de la OTRA barra: se vuelve a pedir.
    state.drinks = [];
    loadQueue();
    // Y los pedidos pendientes son de ESA barra, no de la anterior.
    loadMyRequests();
  }

  function renderBars() {
    const holder = $('bar-chips');
    if (!holder) return;
    holder.hidden = state.bars.length < 2;
    if (state.bars.length < 2) return;
    const chips = [{ id: null, name: t('bar.allBars') }]
      .concat(state.bars.map((b) => ({ id: b.id, name: b.name })));
    holder.innerHTML = chips.map((c) => `
      <button class="chip tap px-3 whitespace-nowrap ${c.id === state.barId ? 'on' : ''}"
              data-bar="${c.id === null ? '' : escape(c.id)}">${escape(c.name)}</button>`).join('');
    for (const button of holder.querySelectorAll('[data-bar]')) {
      button.onclick = () => chooseBar(button.dataset.bar || null);
    }
  }

  async function loadQueue() {
    try {
      // `active=true` trae solo lo que sigue vivo en la barra; el cliente de la API no
      // arma la query, así que va en la ruta. `bar_id` la separa de la otra barra.
      const bar = state.barId ? `&bar_id=${state.barId}` : '';
      const data = await api.get(`/nightclubs/${clubId()}/orders?active=true&limit=100${bar}`);
      state.orders = data.orders || [];
      renderAll();
    } catch (err) { showError(err); }
  }

  // ---------------------------------------------------------------- pintar

  function renderAll() {
    const now = Date.now();
    const counts = EV2Bar.counts(state.orders);
    $('count-new').textContent = counts.new;
    $('count-prep').textContent = counts.prep;
    $('count-ready').textContent = counts.ready;
    $('stat-open').textContent = counts.total;

    const oldest = EV2Bar.oldestWait(state.orders, now);
    $('stat-oldest').textContent = oldest === null ? '—' : t('bar.minutes', { n: oldest });

    renderBars();

    document.querySelectorAll('[data-lane]').forEach((b) => {
      b.classList.toggle('active', b.dataset.lane === state.lane);
    });

    const lanes = EV2Bar.groupByLane(state.orders);
    const list = lanes[state.lane] || [];
    const empty = { new: 'bar.emptyNew', prep: 'bar.emptyPrep', ready: 'bar.emptyReady' };
    $('lane-empty').textContent = t(empty[state.lane]);
    $('lane-empty').hidden = list.length > 0;

    $('lane-list').innerHTML = list.map((order) => card(order, now)).join('');
    wireCards();
  }

  function card(order, now) {
    const minutes = EV2Bar.waitMinutes(order, now);
    const level = EV2Bar.urgency(minutes, EV2Bar.DEFAULT_THRESHOLDS);
    const action = EV2Bar.nextAction(order.status);
    const table = EV2Bar.destination(order);
    const busy = state.busy.has(order.id);
    const flash = state.arrived.has(order.id) ? ' just-arrived' : '';

    const wait = minutes === null ? ''
      : (minutes < 1 ? t('bar.justNow') : t('bar.minutes', { n: minutes }));
    const paid = EV2Bar.isPaid(order);

    const who = order.recipient_name
      ? `<span class="text-pink-300"><i class="fa-solid fa-gift mr-1"></i>${escape(t('bar.gift'))}: ${escape(order.recipient_name)}</span>`
      : `${escape(t('bar.for'))} ${escape(order.sender_name || '')}`;

    return `
    <article class="card wait-${level}${flash} rounded-xl p-4" data-order="${escape(order.id)}">
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0">
          <p class="font-display text-lg leading-tight">
            ${table ? `${escape(t('bar.table'))} ${escape(table)}` : escape(t('bar.noTable'))}
            <span class="text-white/40 text-sm font-normal">· ${EV2Bar.itemCount(order)}</span>
          </p>
          <p class="text-sm text-white/70 mt-1 break-words">${escape(EV2Bar.itemsSummary(order))}</p>
          <p class="text-xs text-white/45 mt-1">${who}</p>
          ${order.message ? `<p class="text-xs text-amber-200/80 mt-1">${escape(t('bar.note'))}: ${escape(order.message)}</p>` : ''}
          ${order.status === 'pos_error' ? `<p class="text-xs text-red-300 mt-1">${escape(t('bar.posError'))}${order.pos_error ? ` ${escape(order.pos_error)}` : ''}</p>` : ''}
          ${paid ? '' : `<p class="text-xs text-amber-300 mt-1"><i class="fa-solid fa-hand-holding-dollar mr-1"></i>${escape(t('bar.unpaid'))}</p>`}
          ${!state.barId && order.bar_name ? `<p class="text-[11px] text-white/35 mt-1">${escape(order.bar_name)}</p>` : ''}
        </div>
        <div class="text-right flex-none">
          <p class="text-xs ${level === 'late' ? 'text-red-300' : level === 'warn' ? 'text-amber-300' : 'text-white/50'}">${escape(wait)}</p>
          <p class="text-sm mt-1">${escape(EV2Format.money(order.subtotal, order.currency))}</p>
        </div>
      </div>
      <div class="flex gap-2 mt-3">
        ${action ? `<button class="ev2-button flex-1 rounded-lg" data-do="${escape(action.status)}" ${busy || !paid ? 'disabled' : ''}>${escape(t(action.key))}</button>` : ''}
        ${EV2Bar.canCancel(order.status) ? `<button class="card rounded-lg px-4 text-sm text-red-300" data-do="cancelled" ${busy ? 'disabled' : ''}>${escape(t('bar.cancel'))}</button>` : ''}
        <button class="card rounded-lg px-3 text-sm" data-move="up" title="${escape(t('bar.moveUp'))}" ${busy ? 'disabled' : ''}>↑</button>
        <button class="card rounded-lg px-3 text-sm" data-move="down" title="${escape(t('bar.moveDown'))}" ${busy ? 'disabled' : ''}>↓</button>
      </div>
    </article>`;
  }

  function wireCards() {
    $('lane-list').querySelectorAll('[data-order]').forEach((el) => {
      el.querySelectorAll('[data-do]').forEach((button) => {
        button.onclick = () => advance(el.dataset.order, button.dataset.do);
      });
      el.querySelectorAll('[data-move]').forEach((button) => {
        button.onclick = () => move(el.dataset.order, button.dataset.move);
      });
    });
  }

  /**
   * Reacomodar la cola por eficiencia, sin tocar la auditoria.
   *
   * Lo que se manda es el orden completo del carril; el servidor solo guarda una
   * preferencia de pantalla. La hora en que entro cada pedido y la hora en que se pago
   * siguen intactas, que es lo que el reporte del cierre usa para decir cuanto espero
   * de verdad cada cliente.
   */
  async function move(orderId, direction) {
    const ids = EV2Bar.reorder(state.orders, state.lane, orderId, direction);
    if (!ids) return;
    // Se pinta antes de que el servidor conteste: mover una tarjeta tiene que sentirse
    // inmediato, y si falla se recarga la cola, que es la verdad.
    const position = new Map(ids.map((id, i) => [id, i + 1]));
    state.orders = state.orders.map((o) => (position.has(o.id)
      ? Object.assign({}, o, { bar_position: position.get(o.id) }) : o));
    renderAll();
    try {
      await api.put(`/nightclubs/${clubId()}/orders/queue-order`, { order_ids: ids });
    } catch (err) {
      showError(err);
      await loadQueue();
    }
  }

  /**
   * Un solo cambio de estado por toque. El botón se bloquea mientras el servidor
   * responde: en una barra ruidosa la gente toca dos veces, y sin esto el segundo toque
   * manda una transición que ya no aplica y aparece un error que confunde.
   */
  async function advance(orderId, status) {
    if (state.busy.has(orderId)) return;
    if (status === 'cancelled' && !window.confirm(t('bar.confirmCancel'))) return;

    state.busy.add(orderId);
    renderAll();
    try {
      const { order } = await api.post(
        `/nightclubs/${clubId()}/orders/${orderId}/status`, { status });
      const index = state.orders.findIndex((o) => o.id === orderId);
      if (index !== -1) {
        if (EV2Bar.isClosed(order.status)) state.orders.splice(index, 1);
        else state.orders[index] = Object.assign({}, state.orders[index], { status: order.status });
      }
    } catch (err) {
      // Un 409 aquí casi siempre significa que otro bartender ya lo movió: recargar la
      // cola dice la verdad mejor que dejar la tarjeta como estaba.
      showError(err);
      await loadQueue();
    } finally {
      state.busy.delete(orderId);
      renderAll();
    }
  }

  document.querySelectorAll('[data-lane]').forEach((b) => {
    b.onclick = () => { state.lane = b.dataset.lane; renderAll(); };
  });

  // ---------------------------------------------------------------- aviso de pedido nuevo

  function loadAlertPreference() {
    try {
      const saved = window.localStorage.getItem(ALERT_KEY);
      if (saved !== null) state.alert = saved === '1';
    } catch { /* modo privado: se queda encendido */ }
    paintAlertButton();
  }

  function paintAlertButton() {
    const button = $('btn-alert');
    button.style.color = state.alert ? 'var(--ev2-lime)' : 'rgba(255,255,255,.35)';
    button.title = t(state.alert ? 'bar.alertOn' : 'bar.alertOff');
  }

  $('btn-alert').onclick = () => {
    state.alert = !state.alert;
    try { window.localStorage.setItem(ALERT_KEY, state.alert ? '1' : '0'); } catch { /* ídem */ }
    paintAlertButton();
    toast(t(state.alert ? 'bar.alertOn' : 'bar.alertOff'));
  };

  /**
   * En un antro no se oye nada: el aviso de un pedido nuevo es vibración, no sonido.
   * `navigator.vibrate` no existe en escritorio ni en iOS, así que la tarjeta también
   * destella — el aviso no puede depender de una sola vía.
   */
  function alertNewOrder(orderId) {
    state.arrived.add(orderId);
    setTimeout(() => { state.arrived.delete(orderId); }, 3000);
    if (!state.alert) return;
    try {
      if (navigator.vibrate) navigator.vibrate([120, 60, 120]);
    } catch { /* algunos navegadores lo bloquean sin interacción previa */ }
    toast(t('bar.newOrder'), 'ok');
  }

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
    // Una barra desconectada es peor que una barra vacía: el aviso se queda fijo.
    rt.on('close', () => setConnection(false, 'top.offline'));
    rt.on('replaced', () => {
      setConnection(false, 'top.otherSession');
      banner(t('banner.replaced'));
    });
    rt.on('resync_required', async () => {
      banner(t('banner.updating'));
      await loadQueue();
      banner(null);
    });

    rt.on('event', async (message) => {
      const change = EV2Bar.applyEvent(state.orders, message);
      if (!change.changed) return;
      if (change.fetch) {
        // El evento trae el id y el estado, no el pedido: hay que traerlo para saber
        // qué mesa es y qué lleva.
        try {
          const { order } = await api.get(`/nightclubs/${clubId()}/orders/${change.fetch}`);
          if (!state.orders.some((o) => o.id === order.id)) state.orders.push(order);
          if (message.type === 'order_created') alertNewOrder(order.id);
        } catch (err) { showError(err); }
      }
      renderAll();
    });

    api.on('auth:expired', () => {
      banner(t('banner.expired'));
      setTimeout(() => location.reload(), 2500);
    });

    rt.connect();
  }

  // ---------------------------------------------------------------- venta en la barra
  //
  // El cliente que llega a la barra, pide y paga ahi mismo. Hasta ahora no existia en el
  // sistema: el cantinero servia el trago y el inventario nunca se enteraba. Son dos
  // pasos y en ESE orden -- primero existe el pedido con su cobro, despues se cobra --
  // porque al reves un fallo de red dejaria dinero recibido sin nada que lo respalde.

  const sale = () => state.sale;

  async function loadDrinks() {
    // La carta de ESTA barra: `stock` es cuantos alcanzan en este estante, no en el club.
    const bar = state.barId ? `?bar_id=${state.barId}` : '';
    try {
      const data = await api.get(`/nightclubs/${clubId()}/drinks${bar}`);
      state.drinks = data.drinks || [];
    } catch (err) { showError(err); }
  }

  function openSale() {
    if (!state.barId && state.bars.length > 1) { toast(t('sale.pickBar'), 'error'); return; }
    const barId = state.barId || (state.bars[0] && state.bars[0].id) || null;
    state.barId = barId;
    state.sale = { open: true, cart: EV2Client.createCart(), search: '', sending: false };
    $('sale-search').value = '';
    $('sale-reference').value = '';
    $('sale-error').hidden = true;
    $('sale-bar').textContent = (state.bars.find((b) => b.id === barId) || {}).name || '';
    renderSaleMethods();
    renderSale();
    $('sale-sheet').hidden = false;
    loadDrinks().then(renderSale);
  }

  function closeSale() {
    state.sale = { open: false, cart: null, search: '', sending: false };
    $('sale-sheet').hidden = true;
  }

  function renderSaleMethods() {
    $('sale-method').innerHTML = EV2OrderTaking.methodKeys()
      .map((k) => `<option value="${escape(k)}">${escape(t(`take.method.${k}`))}</option>`).join('');
    onSaleMethodChange();
  }

  function onSaleMethodChange() {
    const method = EV2OrderTaking.methodFor($('sale-method').value);
    // El folio solo lo pide la terminal: sin el, un cobro con tarjeta es la palabra del
    // cantinero contra el estado de cuenta del banco.
    $('sale-reference').hidden = !(method && method.requiresReference);
    renderSale();
  }

  function renderSale() {
    if (!sale().open) return;
    const cart = sale().cart;
    const lista = EV2OrderTaking.sellableDrinks(state.drinks, { search: sale().search });

    $('sale-menu').innerHTML = lista.length === 0
      ? `<p class="text-center text-white/40 text-sm py-10">${escape(t('sale.empty'))}</p>`
      : lista.map((drink) => `
        <div class="card rounded-xl p-3 flex items-center gap-3" data-drink="${escape(drink.id)}">
          <div class="min-w-0 flex-1">
            <p class="text-sm truncate">${escape(drink.name)}</p>
            <p class="text-xs text-white/50">
              ${escape(EV2Format.money(drink.price, drink.currency))}
              ${drink.stock === null || drink.stock === undefined ? ''
                : `<span class="text-white/35">· ${escape(t('sale.left', { n: drink.stock }))}</span>`}
            </p>
          </div>
          <div class="flex items-center gap-2 flex-none">
            <button class="card rounded-lg w-9 h-9 text-lg" data-minus="1" aria-label="-">−</button>
            <span class="w-5 text-center text-sm">${cart.quantityOf(drink.id)}</span>
            <button class="ev2-button rounded-lg w-9 h-9 text-lg font-display" data-plus="1" aria-label="+">+</button>
          </div>
        </div>`).join('');

    for (const el of $('sale-menu').querySelectorAll('[data-drink]')) {
      const drink = state.drinks.find((d) => d.id === el.dataset.drink);
      el.querySelector('[data-plus]').onclick = () => {
        // `add` respeta la existencia del estante: no deja pedir lo que no hay.
        if (!cart.add(drink)) toast(t('sale.noMore'), 'error');
        renderSale();
      };
      el.querySelector('[data-minus]').onclick = () => { cart.remove(drink.id); renderSale(); };
    }

    $('sale-cart').innerHTML = cart.lines.map((l) => `
      <div class="flex justify-between text-xs">
        <span class="truncate">${l.quantity}× ${escape(l.drink.name)}</span>
        <span class="text-white/60">${escape(EV2Format.money(l.subtotal, cart.currency))}</span>
      </div>`).join('');
    $('sale-total').textContent = EV2Format.money(cart.total, cart.currency);

    const method = $('sale-method').value;
    const reference = $('sale-reference').value;
    const blocker = EV2OrderTaking.barSaleBlocker({ barId: state.barId, cart: cart.lines })
      || (EV2OrderTaking.methodFor(method) && EV2OrderTaking.methodFor(method).requiresReference
        && !String(reference).trim() ? 'no_reference' : null);
    $('btn-sale-charge').disabled = sale().sending || blocker !== null;
  }

  function saleError(key, vars) {
    const el = $('sale-error');
    if (!key) { el.hidden = true; return; }
    el.textContent = vars ? t(key, vars) : t(key);
    el.hidden = false;
  }

  /**
   * Cobrar y mandar a preparar.
   *
   * La clave de idempotencia se genera UNA vez y se reusa en el reintento: regenerarla
   * en el catch es como se cobra dos veces la misma ronda.
   */
  async function chargeSale() {
    const current = sale();
    if (!current.open || current.sending) return;
    const cart = current.cart;
    const method = $('sale-method').value;
    const reference = $('sale-reference').value;

    const blocker = EV2OrderTaking.barSaleBlocker({ barId: state.barId, cart: cart.lines });
    if (blocker) { saleError(`sale.blocked.${blocker}`); return; }

    current.sending = true;
    saleError(null);
    renderSale();
    try {
      const body = EV2OrderTaking.orderPayload({
        cart: cart.lines,
        barLocationId: state.barId,
        // `requestKey` guarda la clave en el carrito: el reintento manda la MISMA.
        requestId: cart.requestKey(EV2.uuid),
      });
      const { order } = await api.post(`/nightclubs/${clubId()}/orders`, body);

      // Un producto de precio cero no genera cobro: ya esta listo para preparar.
      if (order.transaction_id) {
        const chargeBlocker = EV2OrderTaking.chargeBlocker({ order, method, reference });
        if (chargeBlocker) { saleError(`take.blocked.${chargeBlocker}`); return; }
        await api.post(`/nightclubs/${clubId()}/manual-payments/register`,
          EV2OrderTaking.chargePayload({ order, method, reference }));
      }

      toast(t('sale.done', { total: EV2Format.money(order.subtotal, order.currency) }), 'ok');
      closeSale();
      await loadQueue();
    } catch (err) {
      // El pedido pudo quedar creado y el cobro no: recargar la cola dice la verdad, y
      // el pedido aparece ahi con su aviso de "sin pagar" para cobrarlo desde la tarjeta.
      showError(err, $('sale-error'));
      await loadQueue();
    } finally {
      const still = sale();
      if (still) still.sending = false;
      if (!$('sale-sheet').hidden) renderSale();
    }
  }

  // ==================================================== pedir al almacén
  //
  // La barra pide, el almacén surte. Quien sabe qué falta es el cantinero mirando su
  // estante a las once de la noche; antes de esto, surtir era una orden hacia abajo y
  // lo que faltaba se resolvía de palabra — que es cómo acaba producto en la barra sin
  // registro, y cómo un faltante deja de tener dueño.

  const req = {
    open: false,
    tab: 'new',
    suggested: [],
    mine: [],
    picked: new Map(),   // supply_id -> presentaciones a pedir
    sending: false,
  };

  /** La barra en la que se está parado. Sin una elegida no hay a quién surtir. */
  function myBar() {
    if (state.barId) return state.bars.find((b) => b.id === state.barId) || null;
    return state.bars.length === 1 ? state.bars[0] : null;
  }

  async function loadMyRequests() {
    const bar = myBar();
    if (!bar) { req.mine = []; return; }
    try {
      const data = await api.get(
        `/nightclubs/${clubId()}/bar-requests?location_id=${bar.id}&status=all&limit=20`);
      req.mine = data.requests || [];
    } catch { req.mine = []; }
    renderPendingBadge();
  }

  /** El número del botón: lo pedido que todavía no llega. Evita pedir dos veces. */
  function renderPendingBadge() {
    const pendientes = req.mine.filter((r) => EV2Receiving.statusOf(r.status).pending).length;
    const badge = $('restock-pending');
    if (!badge) return;
    badge.textContent = pendientes;
    badge.hidden = pendientes === 0;
  }

  async function openRestock() {
    const bar = myBar();
    if (!bar) { toast(t('req.pickBarFirst'), 'error'); return; }
    req.open = true;
    req.tab = 'new';
    req.picked = new Map();
    $('req-bar').textContent = bar.name;
    $('req-sheet').hidden = false;
    $('req-error').hidden = true;
    $('req-note').value = '';

    try {
      const data = await api.get(
        `/nightclubs/${clubId()}/bar-requests/suggested?location_id=${bar.id}`);
      req.suggested = data.suggested || [];
      // Lo que está bajo mínimo Y el almacén tiene se marca solo, con la cantidad
      // sugerida: pedir tiene que ser un toque, no una captura.
      for (const linea of EV2Receiving.requestFromSuggested(req.suggested)) {
        req.picked.set(linea.supply_id, linea.amount);
      }
    } catch (err) {
      req.suggested = [];
      showError(err, $('req-error'));
    }
    await loadMyRequests();
    renderRestock();
  }

  function closeRestock() {
    req.open = false;
    $('req-sheet').hidden = true;
  }

  function renderRestock() {
    for (const tab of document.querySelectorAll('[data-req-tab]')) {
      tab.classList.toggle('active', tab.dataset.reqTab === req.tab);
    }
    $('req-count-mine').textContent = req.mine
      .filter((r) => EV2Receiving.statusOf(r.status).pending).length;
    $('req-footer').hidden = req.tab !== 'new';
    if (req.tab === 'mine') return renderMyRequests();
    return renderSuggested();
  }

  function renderSuggested() {
    const conStock = req.suggested.filter((s) => Number(s.warehouse_stock) > 0);
    const sinStock = req.suggested.filter((s) => Number(s.warehouse_stock) <= 0);

    if (req.suggested.length === 0) {
      $('req-body').innerHTML = `<p class="text-center text-white/40 text-sm py-16">
          ${escape(t('req.nothingLow'))}</p>`;
      $('btn-req-send').disabled = true;
      return;
    }

    const fila = (item) => {
      const elegido = req.picked.has(item.supply_id);
      return `
        <article class="card rounded-xl px-3 py-2 ${elegido ? 'row-low' : ''}">
          <div class="flex items-center justify-between gap-2">
            <label class="flex items-center gap-2 min-w-0 flex-1 cursor-pointer">
              <input type="checkbox" class="w-5 h-5 shrink-0 accent-cyan-400"
                     data-req-pick="${escape(item.supply_id)}" ${elegido ? 'checked' : ''}>
              <span class="min-w-0">
                <span class="block text-sm font-semibold truncate">${escape(item.name)}</span>
                <span class="block text-[11px] text-white/40">
                  ${escape(t('req.lowHere', {
    have: Math.round((item.stock / item.package_size) * 100) / 100,
    min: Math.round((item.min_stock / item.package_size) * 100) / 100,
  }))}
                </span>
              </span>
            </label>
            <input type="number" min="0.01" step="0.01" inputmode="decimal"
                   class="field w-20 shrink-0"
                   value="${escape(req.picked.get(item.supply_id) || item.suggested_packages)}"
                   data-req-amount="${escape(item.supply_id)}" ${elegido ? '' : 'disabled'}>
          </div>
        </article>`;
    };

    $('req-body').innerHTML = `
      ${conStock.length > 0 ? `<div class="space-y-2">${conStock.map(fila).join('')}</div>` : ''}
      ${sinStock.length > 0 ? `
        <section class="mt-4">
          <h3 class="text-xs uppercase tracking-widest text-white/40 mb-1 px-1">
            ${escape(t('req.toBuy'))}
          </h3>
          <p class="text-[11px] text-white/40 px-1 mb-2">${escape(t('req.toBuyNote'))}</p>
          <div class="space-y-2">${sinStock.map(fila).join('')}</div>
        </section>` : ''}`;

    for (const box of $('req-body').querySelectorAll('[data-req-pick]')) {
      box.onchange = () => {
        const id = box.dataset.reqPick;
        if (box.checked) {
          const item = req.suggested.find((s) => s.supply_id === id);
          req.picked.set(id, String(item ? item.suggested_packages : 1));
        } else req.picked.delete(id);
        renderRestock();
      };
    }
    for (const input of $('req-body').querySelectorAll('[data-req-amount]')) {
      input.onchange = () => {
        if (req.picked.has(input.dataset.reqAmount)) {
          req.picked.set(input.dataset.reqAmount, input.value);
        }
      };
    }
    $('btn-req-send').disabled = req.picked.size === 0 || req.sending;
  }

  function renderMyRequests() {
    if (req.mine.length === 0) {
      $('req-body').innerHTML = `<p class="text-center text-white/40 text-sm py-16">
          ${escape(t('req.noneYet'))}</p>`;
      return;
    }
    $('req-body').innerHTML = req.mine.map((request) => {
      const estado = EV2Receiving.statusOf(request.status);
      const lineas = (request.lines || []).map((l) => {
        const falta = Number(l.pending);
        const cuantas = Math.round((falta / Number(l.package_size)) * 100) / 100;
        return `<li class="flex justify-between gap-2">
            <span class="truncate">${escape(l.name)}</span>
            <span class="shrink-0 ${falta > 0 ? 'text-amber-200' : 'text-emerald-300'}">
              ${falta > 0 ? escape(t('req.stillMissing', { n: cuantas })) : escape(t('req.arrived'))}
            </span>
          </li>`;
      }).join('');
      return `
        <article class="card rounded-xl px-3 py-2 ${estado.pending ? 'row-low' : ''}">
          <div class="flex items-start justify-between gap-2">
            <p class="text-[11px] text-white/40">${escape(EV2Format.dateTime(request.created_at))}</p>
            <span class="chip shrink-0">${escape(t(`req.status.${request.status}`))}</span>
          </div>
          <ul class="text-xs text-white/70 mt-1 space-y-.5">${lineas}</ul>
          ${estado.pending ? `
            <button class="text-[11px] text-red-300 underline mt-2"
                    data-req-cancel="${escape(request.id)}">${escape(t('req.cancel'))}</button>` : ''}
        </article>`;
    }).join('');

    for (const button of $('req-body').querySelectorAll('[data-req-cancel]')) {
      button.onclick = async () => {
        // Cancelar exige motivo: un pedido que desaparece sin explicación es un
        // pedido perdido, y el almacén se queda esperando surtirlo.
        const motivo = prompt(t('req.cancelWhy'));
        if (!motivo || !motivo.trim()) return;
        try {
          await api.post(
            `/nightclubs/${clubId()}/bar-requests/${button.dataset.reqCancel}/cancel`,
            { reason: motivo.trim() });
          await loadMyRequests();
          renderRestock();
        } catch (err) { showError(err, $('req-error')); }
      };
    }
  }

  async function sendRestock() {
    const bar = myBar();
    if (!bar || req.sending || req.picked.size === 0) return;
    req.sending = true;
    $('btn-req-send').disabled = true;
    $('req-error').hidden = true;
    try {
      const lines = [...req.picked.entries()].map(([supplyId, amount]) => ({
        supply_id: supplyId, mode: 'packages', amount,
      }));
      await api.post(`/nightclubs/${clubId()}/bar-requests`,
        EV2Receiving.requestBody({
          locationId: bar.id, lines, note: $('req-note').value,
        }));
      toast(t('req.sent'), 'ok');
      req.picked = new Map();
      $('req-note').value = '';
      req.tab = 'mine';
      await loadMyRequests();
      renderRestock();
    } catch (err) {
      showError(err, $('req-error'));
    } finally {
      req.sending = false;
      renderRestock();
    }
  }

  $('btn-restock').onclick = openRestock;
  $('btn-req-close').onclick = closeRestock;
  $('btn-req-send').onclick = sendRestock;
  for (const tab of document.querySelectorAll('[data-req-tab]')) {
    tab.onclick = async () => {
      req.tab = tab.dataset.reqTab;
      if (req.tab === 'mine') await loadMyRequests();
      renderRestock();
    };
  }

  $('btn-new-sale').onclick = openSale;
  $('btn-sale-close').onclick = closeSale;
  $('btn-sale-charge').onclick = chargeSale;
  $('sale-method').onchange = onSaleMethodChange;
  $('sale-reference').oninput = renderSale;
  $('sale-search').oninput = (ev) => { state.sale.search = ev.target.value; renderSale(); };

  // ---------------------------------------------------------------- arranque

  (async function boot() {
    EV2Format.setLanguage(EV2Format.getLanguage());
    EV2Format.applyTo(document);
    $('btn-lang').textContent = EV2Format.otherLanguage().toUpperCase();
    loadAlertPreference();
    const user = await api.resume();
    if (user) await afterSignIn();
  }());
}());
