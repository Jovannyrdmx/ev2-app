/**
 * EV2 — pantalla de la caja (D77).
 *
 * Conecta el DOM con `EV2` (API y socket) y con `EV2Cashier` (las decisiones, probadas
 * en Node). Reusa lo que ya existe en vez de copiarlo: el cobro con terminal
 * (`EV2TerminalCharge`), el corte (`EV2ShiftCut`) y el carrito y los métodos de cobro
 * de la venta (`EV2Client`, `EV2OrderTaking`).
 */
/* global EV2, EV2Format, EV2Roles, EV2PasswordGate, EV2Client, EV2OrderTaking,
   EV2TerminalCharge, EV2ShiftCut, EV2Cashier */
(function () {
  'use strict';
  const ask = (text, opts) => (typeof window !== 'undefined' && window.EV2UI
    ? window.EV2UI.confirm(text, opts) : Promise.resolve(window.confirm(text)));

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

  /** Solo el cajero tiene caja: el servidor responde 403 a cualquier otro. */
  const TILL_ROLES = ['cashier'];

  const state = {
    till: null,          // lo que contesta GET /till
    terminals: [],
    drinks: [],
    realtime: null,
    charge: { open: false, order: null, sending: false },
    sale: { open: false, cart: null, search: '', sending: false },
  };

  const t = (key, vars) => (vars ? EV2Format.tf(key, vars) : EV2Format.t(key));
  const lang = () => EV2Format.getLanguage();
  const money = (a, c) => EV2Format.money(a, c || 'MXN');
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

  const clubId = () => api.session.user && api.session.user.nightclub_id;

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
  $('btn-pw-logout').onclick = signOut;

  $('btn-lang').onclick = () => {
    EV2Format.setLanguage(EV2Format.otherLanguage());
    applyLanguage();
  };

  function applyLanguage() {
    EV2Format.applyTo(document);
    $('btn-lang').textContent = EV2Format.otherLanguage().toUpperCase();
    render();
    if (!$('screen-wrong-role').hidden) renderWrongRole();
    if (state.sale.open) { renderSaleMethods(); renderSale(); }
    if (state.charge.open) { renderChargeMethods(); renderCharge(); }
    setConnection(lastConnection.on, lastConnection.key, lastConnection.vars);
  }

  const PASSWORD_GATE_HIDES = ['screen-auth', 'screen-wrong-role', 'screen-till', 'sale-sheet', 'charge-sheet'];

  function showPasswordGate() {
    for (const id of PASSWORD_GATE_HIDES) $(id).hidden = true;
    $('screen-password').hidden = false;
    $('pw-error').hidden = true;
  }

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
      await api.login({ nightclubSlug: CLUB_SLUG, email, password: next });
      $('form-password').reset();
      $('screen-password').hidden = true;
      toast(t('gate.done'), 'ok');
      await afterSignIn();
    } catch (err) { showError(err, $('pw-error')); }
  };

  async function afterSignIn() {
    if (EV2PasswordGate.mustChangePin(api.session.user)) {
      location.href = EV2PasswordGate.PIN_PAGE;
      return;
    }
    if (EV2PasswordGate.isRequired(api.session.user)) { showPasswordGate(); return; }
    const role = api.session.user && api.session.user.role;
    if (!TILL_ROLES.includes(role)) {
      const home = EV2Roles.describe(role, lang());
      if (home.ready && home.home && home.home !== 'caja.html') {
        location.href = home.home;
        return;
      }
      renderWrongRole();
      $('screen-auth').hidden = true;
      $('screen-till').hidden = true;
      $('screen-wrong-role').hidden = false;
      return;
    }
    await enterTill();
  }

  function renderWrongRole() {
    const role = api.session.user && api.session.user.role;
    const info = EV2Roles.describe(role, lang());
    $('wrong-role').textContent = info.label;
    $('wrong-role-note').textContent = info.step
      ? t('staff.pending', { step: info.step }) : t('staff.noScreen');
  }

  async function enterTill() {
    $('screen-auth').hidden = true;
    $('screen-wrong-role').hidden = true;
    $('screen-till').hidden = false;
    $('me-name').textContent = (api.session.user && api.session.user.display_name) || '';
    await Promise.all([loadTill(), loadTerminals()]);
    connectRealtime();
    // El "hace 12 min" de cada pedido avanza solo.
    setInterval(render, 60000);
  }

  // ---------------------------------------------------------------- datos

  async function loadTill() {
    try {
      state.till = await api.get(`/nightclubs/${clubId()}/till`);
      render();
    } catch (err) { showError(err); }
  }

  /** Sin terminales la caja sigue cobrando en efectivo: un fallo aquí no tumba nada. */
  async function loadTerminals() {
    try {
      const data = await api.get(`/nightclubs/${clubId()}/payment-terminals`);
      state.terminals = data.terminals || [];
    } catch { state.terminals = []; }
  }

  const barId = () => (state.till && state.till.till && state.till.till.location_id) || null;

  // ---------------------------------------------------------------- pintar

  function render() {
    const s = state.till;
    const phase = EV2Cashier.phase(s);
    $('till-closed').hidden = phase === 'open';
    $('till-open').hidden = phase !== 'open';

    if (phase !== 'open') {
      const a = s && s.assignment;
      $('till-bar').textContent = a ? a.location_name : '—';
      $('open-bar').textContent = a ? a.location_name : '—';
      $('open-night').textContent = a
        ? `${a.event_name} · ${EV2Format.dateTime(a.doors_open_at)}` : '';
      $('open-none').hidden = phase !== 'no_assignment';
      $('open-form').hidden = phase === 'no_assignment';
      return;
    }

    const till = s.till;
    $('till-bar').textContent = till.location_name;
    $('stat-float').textContent = money(till.opening_float, till.currency);
    $('stat-pending').textContent = (s.pending_orders || []).length
      ? money(s.pending_total, till.currency) : '0';

    const grupos = EV2Cashier.groupByWaiter(s.pending_orders, { noName: t('till.noWaiter') });
    $('pending-empty').hidden = grupos.length > 0;
    const now = Date.now();
    $('pending-list').innerHTML = grupos.map((g) => `
      <div class="card rounded-xl p-3 space-y-2">
        <div class="flex items-baseline justify-between gap-2">
          <p class="font-display">${escape(g.name)}</p>
          <p class="text-sm text-white/60">${escape(t('till.waiterTotal', { n: g.orders.length, amount: money(g.total) }))}</p>
        </div>
        ${g.orders.map((o) => orderRow(o, now)).join('')}
      </div>`).join('');

    const apartados = (s.awaiting_payment || []);
    $('awaiting-block').hidden = apartados.length === 0;
    $('awaiting-list').innerHTML = apartados.map((o) => `
      <div class="card rounded-xl p-3">${orderRow(o, now, o.sender_name)}</div>`).join('');

    for (const el of document.querySelectorAll('[data-charge]')) {
      el.onclick = () => openCharge(el.dataset.charge);
    }
  }

  function orderRow(order, now, who) {
    const donde = EV2Cashier.destination(order);
    const minutos = Math.max(0, Math.floor((now - Date.parse(order.created_at || now)) / 60000));
    return `
      <div class="flex items-center justify-between gap-2">
        <div class="min-w-0">
          <p class="text-sm truncate">${donde ? `${escape(t('bar.table'))} ${escape(donde)}` : escape(t('bar.noTable'))}
            ${who ? `<span class="text-white/40">· ${escape(who)}</span>` : ''}
            <span class="text-white/40 text-xs">· ${escape(minutos < 1 ? t('bar.justNow') : t('bar.minutes', { n: minutos }))}</span></p>
          <p class="text-xs text-white/50 truncate">${escape(EV2Cashier.itemsSummary(order))}</p>
          ${order.payment_status === 'pending_manual' ? `<p class="text-[11px] text-amber-300">${escape(t('till.inReview'))}</p>` : ''}
        </div>
        <button class="ev2-button rounded-lg px-3 py-2 text-sm font-display flex-none"
                data-charge="${escape(order.order_id)}" ${order.payment_status === 'pending_manual' ? 'disabled' : ''}>
          ${escape(money(order.subtotal, order.currency))}
        </button>
      </div>`;
  }

  // ---------------------------------------------------------------- abrir la caja

  $('btn-refresh-assignment').onclick = loadTill;

  $('btn-open').onclick = async () => {
    $('open-error').hidden = true;
    const amount = $('open-float').value;
    const pin = $('open-pin').value;
    const blocker = EV2Cashier.openBlocker({ state: state.till, amount, pin });
    if (blocker) { $('open-error').textContent = t(blocker); $('open-error').hidden = false; return; }
    if (!(await ask(t('till.confirmOpen', {
      amount: money(amount), bar: state.till.assignment.location_name,
    })))) return;
    $('btn-open').disabled = true;
    try {
      state.till = await api.post(`/nightclubs/${clubId()}/till/open`,
        EV2Cashier.openPayload({ amount, pin }));
      $('open-float').value = '';
      toast(t('till.opened'), 'ok');
      render();
    } catch (err) {
      showError(err, $('open-error'));
    } finally {
      // El código del gerente no se queda escrito, salga bien o mal.
      $('open-pin').value = '';
      $('btn-open').disabled = false;
    }
  };

  // ---------------------------------------------------------------- cobrar un pedido

  const allOpenOrders = () => ((state.till && state.till.pending_orders) || [])
    .concat((state.till && state.till.awaiting_payment) || []);

  function openCharge(orderId) {
    const order = allOpenOrders().find((o) => o.order_id === orderId);
    if (!order) return;
    state.charge = { open: true, order, sending: false };
    $('charge-reference').value = '';
    $('charge-error').hidden = true;
    renderChargeMethods();
    renderCharge();
    $('charge-sheet').hidden = false;
  }

  function closeCharge() {
    state.charge = { open: false, order: null, sending: false };
    $('charge-sheet').hidden = true;
  }
  $('btn-charge-close').onclick = closeCharge;

  function renderChargeMethods() {
    $('charge-method').innerHTML = EV2OrderTaking.methodKeys()
      .map((k) => `<option value="${escape(k)}">${escape(t(`take.method.${k}`))}</option>`).join('');
    onChargeMethodChange();
  }

  function onChargeMethodChange() {
    const method = EV2OrderTaking.methodFor($('charge-method').value);
    $('charge-reference').hidden = !(method && method.requiresReference);
  }
  $('charge-method').onchange = onChargeMethodChange;

  function renderCharge() {
    const order = state.charge.order;
    if (!order) return;
    const donde = EV2Cashier.destination(order);
    $('charge-what').textContent = [
      donde ? `${t('bar.table')} ${donde}` : t('bar.noTable'),
      order.taken_by_name || order.sender_name || '',
    ].filter(Boolean).join(' · ');
    $('charge-items').textContent = EV2Cashier.itemsSummary(order);
    $('charge-total').textContent = money(order.subtotal, order.currency);
  }

  $('btn-charge').onclick = async () => {
    const current = state.charge;
    if (!current.open || current.sending) return;
    const order = EV2Cashier.asChargeable(current.order);
    const method = $('charge-method').value;
    const reference = $('charge-reference').value;
    const blocker = EV2OrderTaking.chargeBlocker({
      order, method, reference, terminals: state.terminals,
    });
    if (blocker) {
      $('charge-error').textContent = t(`take.blocked.${blocker}`);
      $('charge-error').hidden = false;
      return;
    }
    current.sending = true;
    $('btn-charge').disabled = true;
    try {
      if (EV2OrderTaking.isTerminalMethod(method)) {
        const terminal = EV2TerminalCharge.pickTerminal(state.terminals, EV2TerminalCharge.recordada());
        const res = await api.post(`/nightclubs/${clubId()}/terminal-charges`, {
          transaction_id: order.transaction_id, terminal_id: terminal.id,
        });
        EV2TerminalCharge.recordar(terminal.id);
        closeCharge();
        sheet().watch(res.charge);
        return;
      }
      await api.post(`/nightclubs/${clubId()}/manual-payments/register`,
        EV2OrderTaking.chargePayload({ order, method, reference }));
      toast(t('take.charged'), 'ok');
      closeCharge();
      await loadTill();
    } catch (err) {
      showError(err, $('charge-error'));
      await loadTill();
    } finally {
      current.sending = false;
      $('btn-charge').disabled = false;
    }
  };

  let terminalSheet = null;
  function sheet() {
    if (!terminalSheet) {
      terminalSheet = EV2TerminalCharge.createSheet({
        api,
        clubId,
        t,
        money: (a, c) => money(a, c),
        errorMessage: (err) => EV2Format.errorMessage(err),
        confirm: (texto) => ask(texto),
        onPaid: async () => { closeSale(); await loadTill(); },
        onClose: async () => { await loadTill(); },
      });
    }
    return terminalSheet;
  }

  // ---------------------------------------------------------------- venta en la barra
  //
  // El cliente que llega a la barra, pide y paga ahí mismo. Primero existe el pedido
  // con su cobro y después se cobra, en ese orden: al revés, un fallo de red dejaría
  // dinero recibido sin nada que lo respalde. El servidor lo manda a la barra de ESTA
  // caja, diga lo que diga el cuerpo.

  async function loadDrinks() {
    const bar = barId() ? `?bar_id=${barId()}` : '';
    try {
      const data = await api.get(`/nightclubs/${clubId()}/drinks${bar}`);
      state.drinks = data.drinks || [];
    } catch (err) { showError(err); }
  }

  function openSale() {
    if (!barId()) return;
    state.sale = { open: true, cart: EV2Client.createCart(), search: '', sending: false };
    $('sale-search').value = '';
    $('sale-reference').value = '';
    $('sale-error').hidden = true;
    $('sale-bar').textContent = state.till.till.location_name;
    renderSaleMethods();
    renderSale();
    $('sale-sheet').hidden = false;
    loadDrinks().then(renderSale);
  }

  function closeSale() {
    state.sale = { open: false, cart: null, search: '', sending: false };
    $('sale-sheet').hidden = true;
  }

  $('btn-new-sale').onclick = openSale;
  $('btn-sale-close').onclick = closeSale;
  $('sale-search').oninput = () => { state.sale.search = $('sale-search').value; renderSale(); };
  $('sale-reference').oninput = renderSale;
  $('sale-method').onchange = () => onSaleMethodChange();

  function renderSaleMethods() {
    $('sale-method').innerHTML = EV2OrderTaking.methodKeys()
      .map((k) => `<option value="${escape(k)}">${escape(t(`take.method.${k}`))}</option>`).join('');
    onSaleMethodChange();
  }

  function onSaleMethodChange() {
    const method = EV2OrderTaking.methodFor($('sale-method').value);
    $('sale-reference').hidden = !(method && method.requiresReference);
    renderSale();
  }

  function renderSale() {
    if (!state.sale.open) return;
    const cart = state.sale.cart;
    const lista = EV2OrderTaking.sellableDrinks(state.drinks, { search: state.sale.search });
    $('sale-menu').innerHTML = lista.length === 0
      ? `<p class="text-center text-white/40 text-sm py-10">${escape(t('sale.empty'))}</p>`
      : lista.map((drink) => `
        <div class="card rounded-xl p-3 flex items-center gap-3" data-drink="${escape(drink.id)}">
          <div class="min-w-0 flex-1">
            <p class="text-sm truncate">${escape(drink.name)}</p>
            <p class="text-xs text-white/50">
              ${escape(money(drink.price, drink.currency))}
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
        if (!cart.add(drink)) toast(t('sale.noMore'), 'error');
        renderSale();
      };
      el.querySelector('[data-minus]').onclick = () => { cart.remove(drink.id); renderSale(); };
    }

    $('sale-cart').innerHTML = cart.lines.map((l) => `
      <div class="flex justify-between text-xs">
        <span class="truncate">${l.quantity}× ${escape(l.drink.name)}</span>
        <span class="text-white/60">${escape(money(l.subtotal, cart.currency))}</span>
      </div>`).join('');
    $('sale-total').textContent = money(cart.total, cart.currency);

    const method = EV2OrderTaking.methodFor($('sale-method').value);
    const blocker = EV2OrderTaking.barSaleBlocker({ barId: barId(), cart: cart.lines })
      || (method && method.requiresReference && !String($('sale-reference').value).trim()
        ? 'no_reference' : null);
    $('btn-sale-charge').disabled = state.sale.sending || blocker !== null;
  }

  $('btn-sale-charge').onclick = async () => {
    const current = state.sale;
    if (!current.open || current.sending) return;
    const cart = current.cart;
    const method = $('sale-method').value;
    const reference = $('sale-reference').value;
    const blocker = EV2OrderTaking.barSaleBlocker({ barId: barId(), cart: cart.lines });
    if (blocker) { $('sale-error').textContent = t(`sale.blocked.${blocker}`); $('sale-error').hidden = false; return; }

    current.sending = true;
    $('sale-error').hidden = true;
    renderSale();
    try {
      const body = EV2OrderTaking.orderPayload({
        cart: cart.lines,
        barLocationId: barId(),
        // La misma clave en el reintento: regenerarla es cobrar dos veces la ronda.
        requestId: cart.requestKey(EV2.uuid),
      });
      const { order } = await api.post(`/nightclubs/${clubId()}/orders`, body);
      if (order.transaction_id) {
        const chargeBlocker = EV2OrderTaking.chargeBlocker({
          order, method, reference, terminals: state.terminals,
        });
        if (chargeBlocker) {
          $('sale-error').textContent = t(`take.blocked.${chargeBlocker}`);
          $('sale-error').hidden = false;
          return;
        }
        if (EV2OrderTaking.isTerminalMethod(method)) {
          const terminal = EV2TerminalCharge.pickTerminal(state.terminals, EV2TerminalCharge.recordada());
          const res = await api.post(`/nightclubs/${clubId()}/terminal-charges`, {
            transaction_id: order.transaction_id, terminal_id: terminal.id,
          });
          EV2TerminalCharge.recordar(terminal.id);
          sheet().watch(res.charge);
          return;
        }
        await api.post(`/nightclubs/${clubId()}/manual-payments/register`,
          EV2OrderTaking.chargePayload({ order, method, reference }));
      }
      toast(t('till.saleDone', { total: money(order.subtotal, order.currency) }), 'ok');
      closeSale();
      await loadTill();
    } catch (err) {
      showError(err, $('sale-error'));
      await loadTill();
    } finally {
      const still = state.sale;
      if (still) still.sending = false;
      if (!$('sale-sheet').hidden) renderSale();
    }
  };

  // ---------------------------------------------------------------- el corte

  let cutSheet = null;
  function corte() {
    if (!cutSheet) {
      cutSheet = EV2ShiftCut.createSheet({
        api,
        clubId,
        t,
        money: (a) => money(a),
        errorMessage: (err) => EV2Format.errorMessage(err),
        toast,
        // Hecho el corte, la caja queda cerrada y la barra libre: se vuelve a pedir.
        onChange: () => loadTill(),
      });
    }
    return cutSheet;
  }
  $('btn-cut').onclick = () => corte().open();

  // ---------------------------------------------------------------- tiempo real

  const lastConnection = { on: false, key: 'realtime.reconnecting', vars: null };

  function setConnection(on, key, vars) {
    lastConnection.on = on;
    lastConnection.key = key;
    lastConnection.vars = vars || null;
    $('rt-dot').className = `dot ${on === true ? 'dot-on' : on === null ? 'dot-wait' : 'dot-off'}`;
    $('rt-text').textContent = vars && vars.text ? vars.text : t(key);
  }

  let refreshTimer = null;
  function refreshSoon() {
    // Una ronda de cinco pedidos son cinco eventos: se junta en una sola consulta.
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(loadTill, 300);
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
    rt.on('resync_required', () => refreshSoon());
    rt.on('event', (message) => {
      if (terminalSheet) terminalSheet.onEvent(message);
      if (EV2Cashier.shouldRefresh(message, { locationId: barId() })) refreshSoon();
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
