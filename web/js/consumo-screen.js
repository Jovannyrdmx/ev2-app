/**
 * EV2 — Mi consumo (D101).
 *
 * El empleado pide una bebida para sí desde su teléfono. El servidor decide todo: quién
 * puede pedir, el porcentaje y lo que se descuenta. Esta pantalla muestra la carta con
 * el precio ya con descuento y manda solo qué bebidas y cuántas.
 */
/* global EV2, EV2Format, EV2Roles, EV2PasswordGate, EV2StaffOrder */
(function () {
  'use strict';
  const ask = (text, opts) => (typeof window !== 'undefined' && window.EV2UI
    ? window.EV2UI.confirm(text, opts) : Promise.resolve(window.confirm(text)));

  const $ = (id) => document.getElementById(id);
  const meta = (name, fallback) => {
    const el = document.querySelector(`meta[name="${name}"]`);
    return (el && el.content) || fallback;
  };
  const api = EV2.createClient({ baseUrl: meta('ev2:api', '/api') });

  /** Quién puede pedir para sí. El servidor manda igual: esto solo evita la pantalla. */
  const STAFF_ROLES = ['waiter', 'bartender', 'cashier', 'dancer', 'dj', 'light_tech',
    'valet', 'hostess', 'rp'];

  const t = (key, vars) => (vars ? EV2Format.tf(key, vars) : EV2Format.t(key));
  const money = (a, c) => EV2Format.money(a, c || 'MXN');
  const escape = (s) => String(s == null ? '' : s).replace(/[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const clubId = () => api.session.user && api.session.user.nightclub_id;

  const state = {
    pct: null, drinks: [], cart: EV2StaffOrder.createCart(), search: '', sending: false,
    requestId: null,
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

  function showError(err) {
    const box = $('soc-error');
    box.textContent = (err && err.message) || t('soc.errGeneric');
    box.hidden = false;
  }

  // ---------------------------------------------------------------- pintar

  function renderWeek(me) {
    $('soc-week').hidden = false;
    const totales = Object.entries(me.totals || {}).map(([cur, v]) => money(v, cur)).join(' · ');
    $('soc-week-total').textContent = totales || money(0);
    $('soc-week-note').textContent = t('soc.weekNote', { n: me.count || 0 });
  }

  function renderMenu() {
    const ok = state.pct !== null;
    $('soc-off').hidden = ok;
    $('soc-menu').hidden = !ok;
    if (!ok) { $('soc-bar').hidden = true; return; }

    $('soc-pct').textContent = t('soc.pct', { pct: state.pct });
    const q = state.search.trim().toLowerCase();
    const grupos = EV2StaffOrder.byCategory(state.drinks)
      .map((g) => ({
        ...g,
        items: g.items.filter((d) => !q || String(d.name).toLowerCase().includes(q)
          || String(g.category).toLowerCase().includes(q)),
      }))
      .filter((g) => g.items.length > 0);
    $('soc-empty').hidden = grupos.length > 0;

    $('soc-list').innerHTML = grupos.map((g) => `
      <div class="space-y-2">
        ${g.category ? `<p class="text-xs uppercase tracking-wider text-white/40">${escape(g.category)}</p>` : ''}
        ${g.items.map((d) => {
    const cantidad = state.cart.quantity(d.id);
    const promoU = EV2StaffOrder.promoUnit(d, state.pct);
    const tuyo = promoU !== null ? promoU : EV2StaffOrder.staffPrice(d.price, state.pct);
    const etiqueta = EV2Promos.badge(d);
    const horario = EV2Promos.window(d);
    return `<div class="card rounded-xl px-3 py-2 flex items-center gap-3" data-drink="${escape(d.id)}">
            <div class="min-w-0 flex-1">
              <p class="text-sm font-semibold break-words" data-role="drink-name">${escape(d.name)}</p>
              <p class="text-xs"><span class="text-white/40 line-through">${escape(money(d.price, d.currency))}</span>
                <span class="text-emerald-300 ml-1">${escape(money(tuyo, d.currency))}</span>
                ${etiqueta ? `<span class="ml-1 rounded-full bg-fuchsia-500/20 text-fuchsia-200 px-2 py-0.5 text-[11px]" data-role="promo-badge">${escape(etiqueta)}${horario ? ` · ${escape(horario)}` : ''}</span>` : ''}</p>
            </div>
            <div class="flex items-center gap-2 shrink-0">
              <button class="card rounded-lg px-3 py-2 text-sm" data-minus="${escape(d.id)}" aria-label="${escape(t('soc.less'))}" ${cantidad === 0 ? 'disabled' : ''}>−</button>
              <span class="w-6 text-center text-sm" data-role="qty">${cantidad}</span>
              <button class="card rounded-lg px-3 py-2 text-sm" data-plus="${escape(d.id)}" aria-label="${escape(t('soc.more'))}">+</button>
            </div>
          </div>`;
  }).join('')}
      </div>`).join('');

    document.querySelectorAll('[data-plus]').forEach((b) => {
      b.onclick = () => { state.cart.add(b.dataset.plus, 1); state.requestId = null; renderMenu(); };
    });
    document.querySelectorAll('[data-minus]').forEach((b) => {
      b.onclick = () => { state.cart.add(b.dataset.minus, -1); state.requestId = null; renderMenu(); };
    });

    const vacio = state.cart.isEmpty();
    $('soc-bar').hidden = vacio;
    if (!vacio) {
      const tot = EV2StaffOrder.totals(state.cart, state.drinks, state.pct);
      $('soc-bar-count').textContent = t('soc.items', { n: state.cart.count() });
      $('soc-bar-total').textContent = t('soc.deduct', { total: money(tot.deduct) });
    }
    $('btn-soc-send').disabled = state.sending;
  }

  // ---------------------------------------------------------------- datos

  async function load() {
    $('soc-error').hidden = true;
    try {
      const club = clubId();
      const cfg = await api.get(`/nightclubs/${club}/staff-consumption/settings`);
      state.pct = cfg.discount_pct;
      if (state.pct !== null) {
        const [d, me] = await Promise.all([
          api.get(`/nightclubs/${club}/drinks`),
          api.get(`/nightclubs/${club}/staff-consumption/me`),
        ]);
        state.drinks = d.drinks || [];
        renderWeek(me);
      }
    } catch (err) { showError(err); }
    renderMenu();
  }

  async function send() {
    if (state.sending || state.cart.isEmpty()) return;
    const tot = EV2StaffOrder.totals(state.cart, state.drinks, state.pct);
    if (!(await ask(t('soc.confirm', { n: state.cart.count(), total: money(tot.deduct) })))) return;

    state.sending = true;
    // La misma llave para el mismo carrito: un doble toque no pide dos veces.
    if (!state.requestId) state.requestId = EV2.uuid();
    renderMenu();
    try {
      await api.post(`/nightclubs/${clubId()}/staff-orders`, {
        client_request_id: state.requestId, items: state.cart.items(),
      });
      state.cart.clear();
      state.requestId = null;
      toast(t('soc.sent'), 'ok');
      await load();
    } catch (err) {
      showError(err);
    } finally {
      state.sending = false;
      renderMenu();
    }
  }

  // ---------------------------------------------------------------- entrada

  function applyLanguage() {
    EV2Format.applyTo(document);
    $('btn-lang').textContent = EV2Format.otherLanguage().toUpperCase();
    renderMenu();
  }

  $('btn-lang').onclick = () => { EV2Format.setLanguage(EV2Format.otherLanguage()); applyLanguage(); };
  $('btn-soc-send').onclick = send;
  $('soc-search').oninput = (e) => { state.search = e.target.value; renderMenu(); };

  (async function boot() {
    EV2Format.setLanguage(EV2Format.getLanguage());
    EV2Format.applyTo(document);
    $('btn-lang').textContent = EV2Format.otherLanguage().toUpperCase();
    const user = await api.resume();
    // Sin sesión se va al inicio, donde se entra con el PIN.
    if (!user) { location.replace('index.html'); return; }
    if (EV2PasswordGate.mustChangePin(user)) { location.href = EV2PasswordGate.PIN_PAGE; return; }
    if (!STAFF_ROLES.includes(user.role)) { location.replace('index.html'); return; }
    const info = EV2Roles.describe(user.role, EV2Format.getLanguage());
    $('soc-who').textContent = `${user.display_name || ''} · ${info.label}`;
    if (info.home) $('soc-home').href = info.home;
    await load();
  }());
}());
