/**
 * EV2 — pantalla de almacén.
 *
 * Une el DOM con `EV2` (API) y `EV2Warehouse` (las decisiones y la aritmética, que
 * están probadas aparte). Aquí solo hay pintado y eventos: si algo calcula, va en
 * `warehouse.js`.
 *
 * La pantalla está pensada para cómo se trabaja de verdad un almacén de bar:
 *
 *   - Un estante a la vez. El filtro de lugar es lo primero, porque contar "el total
 *     del club" no es una tarea que exista: se cuenta el almacén, o una barra.
 *   - Cajas antes que mililitros. Quien recibe cuenta botellas; la conversión la hace
 *     el sistema, no la cabeza de la persona a las dos de la mañana.
 *   - Antes de guardar, se enseña el saldo que va a quedar. Corregir antes es gratis;
 *     corregir después deja un renglón de ajuste que alguien tendrá que explicar.
 */
/* global EV2, EV2Format, EV2Warehouse, EV2Roles, EV2PasswordGate */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const meta = (name, fallback) => {
    const el = document.querySelector(`meta[name="${name}"]`);
    return (el && el.content) || fallback;
  };

  const api = EV2.createClient({ baseUrl: meta('ev2:api', '/api') });
  const CLUB_SLUG = meta('ev2:club', 'ev2');

  /** Quién opera el almacén. El servidor manda igual: esto solo evita la pantalla. */
  const WAREHOUSE_ROLES = ['warehouse', 'manager', 'admin'];

  const state = {
    supplies: [],
    locations: [],
    movements: [],
    locationFilter: null,   // null = todos los lugares
    tab: 'stock',
    search: '',
    sheet: null,            // { supply, kind, mode }
    busy: false,
  };

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

  const clubId = () => api.session.user && api.session.user.nightclub_id;
  const locationById = (id) => state.locations.find((l) => l.id === id) || null;

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
    await api.logout();
    location.reload();
  }
  $('btn-logout').onclick = signOut;
  $('btn-wrong-logout').onclick = signOut;
  $('btn-pw-logout').onclick = signOut;
  $('btn-refresh').onclick = () => load();

  $('btn-lang').onclick = () => {
    EV2Format.setLanguage(EV2Format.otherLanguage());
    applyLanguage();
  };

  function applyLanguage() {
    EV2Format.applyTo(document);
    $('btn-lang').textContent = EV2Format.otherLanguage().toUpperCase();
    renderAll();
    if (!$('screen-wrong-role').hidden) renderWrongRole();
    if (state.sheet) renderSheet();
  }

  const PASSWORD_GATE_HIDES = ['screen-auth', 'screen-wrong-role', 'screen-warehouse'];

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
    if (EV2PasswordGate.isRequired(api.session.user)) { showPasswordGate(); return; }
    const role = api.session.user && api.session.user.role;
    if (!WAREHOUSE_ROLES.includes(role)) {
      const home = EV2Roles.describe(role, lang());
      if (home.ready && home.home && home.home !== 'almacen.html') {
        location.href = home.home;
        return;
      }
      renderWrongRole();
      $('screen-auth').hidden = true;
      $('screen-warehouse').hidden = true;
      $('screen-wrong-role').hidden = false;
      return;
    }
    await enterWarehouse();
  }

  function renderWrongRole() {
    const role = api.session.user && api.session.user.role;
    const info = EV2Roles.describe(role, lang());
    $('wrong-role').textContent = info.label;
    $('wrong-role-note').textContent = info.step
      ? t('staff.pending', { step: info.step }) : t('staff.noScreen');
  }

  async function enterWarehouse() {
    $('screen-auth').hidden = true;
    $('screen-wrong-role').hidden = true;
    $('screen-warehouse').hidden = false;
    $('me-name').textContent = (api.session.user && api.session.user.display_name) || '';
    await load();
  }

  // ---------------------------------------------------------------- cargar

  async function load() {
    try {
      const [locations, supplies] = await Promise.all([
        api.get(`/nightclubs/${clubId()}/supply-locations`),
        api.get(`/nightclubs/${clubId()}/supplies`),
      ]);
      state.locations = locations.locations || [];
      state.supplies = supplies.supplies || [];
      if (state.tab === 'kardex') await loadMovements();
      renderAll();
      banner(null);
    } catch (err) { showError(err); }
  }

  async function loadMovements() {
    const place = state.locationFilter ? `&location_id=${state.locationFilter}` : '';
    try {
      const data = await api.get(`/nightclubs/${clubId()}/supply-movements?limit=80${place}`);
      state.movements = data.movements || [];
    } catch (err) { showError(err); }
  }

  // ---------------------------------------------------------------- pintar

  function renderAll() {
    renderStats();
    renderLocationChips();
    renderTabs();
    renderList();
  }

  function renderStats() {
    const visible = suppliesForLocation();
    const low = visible.filter((s) => isLowHere(s)).length;
    const value = EV2Warehouse.inventoryValue(visible);
    const scoped = state.locationFilter
      ? (value.byLocation.find(([name]) => {
        const place = locationById(state.locationFilter);
        return place && name === place.name;
      }) || [null, 0])[1]
      : value.total;
    $('stat-low').textContent = low;
    $('stat-value').textContent = EV2Format.money(scoped || 0, 'MXN', { compact: true });
    $('stat-unconfirmed').textContent = visible.filter((s) => s.size_confirmed === false).length;
  }

  /** Los insumos que tocan el lugar filtrado (o todos, sin filtro). */
  function suppliesForLocation() {
    if (!state.locationFilter) return state.supplies;
    return state.supplies.filter((s) => (s.locations || [])
      .some((l) => l.location_id === state.locationFilter));
  }

  function isLowHere(supply) {
    const locations = supply.locations || [];
    if (!state.locationFilter) return Boolean(supply.low);
    const here = locations.find((l) => l.location_id === state.locationFilter);
    return Boolean(here && here.low);
  }

  function stockHere(supply) {
    const locations = supply.locations || [];
    if (!state.locationFilter) return Number(supply.stock || 0);
    const here = locations.find((l) => l.location_id === state.locationFilter);
    return here ? Number(here.stock) : 0;
  }

  function renderLocationChips() {
    const chips = [{ id: null, name: t('wh.allPlaces') }]
      .concat(state.locations.map((l) => ({ id: l.id, name: l.name })));
    $('location-chips').innerHTML = chips.map((c) => `
      <button class="chip tap px-3 whitespace-nowrap ${c.id === state.locationFilter ? 'on' : ''}"
              data-location="${c.id === null ? '' : escape(c.id)}">${escape(c.name)}</button>`).join('');
    for (const button of $('location-chips').querySelectorAll('[data-location]')) {
      button.onclick = async () => {
        state.locationFilter = button.dataset.location || null;
        if (state.tab === 'kardex') await loadMovements();
        renderAll();
      };
    }
  }

  function renderTabs() {
    const visible = filtered();
    $('count-stock').textContent = visible.length;
    $('count-restock').textContent = restock().length;
    for (const tab of document.querySelectorAll('[data-tab]')) {
      tab.classList.toggle('active', tab.dataset.tab === state.tab);
    }
  }

  for (const tab of document.querySelectorAll('[data-tab]')) {
    tab.onclick = async () => {
      state.tab = tab.dataset.tab;
      if (state.tab === 'kardex') await loadMovements();
      renderAll();
    };
  }

  $('search').oninput = () => {
    state.search = $('search').value.trim().toLowerCase();
    renderAll();
  };

  function filtered() {
    const list = suppliesForLocation();
    if (!state.search) return list;
    return list.filter((s) => s.name.toLowerCase().includes(state.search)
      || String(s.category || '').toLowerCase().includes(state.search));
  }

  function restock() {
    const place = state.locationFilter ? locationById(state.locationFilter) : null;
    return EV2Warehouse.restockList(state.supplies,
      place && place.kind === 'bar' ? { barCode: place.code } : {});
  }

  function renderList() {
    if (state.tab === 'restock') return renderRestock();
    if (state.tab === 'kardex') return renderKardex();
    return renderStock();
  }

  function empty(message) {
    $('list').innerHTML = '';
    $('list-empty').textContent = message;
    $('list-empty').hidden = false;
  }

  function renderStock() {
    const list = filtered();
    if (list.length === 0) return empty(t('wh.emptyStock'));
    $('list-empty').hidden = true;

    const groups = EV2Warehouse.byCategory(list);
    $('list').innerHTML = groups.map((group) => `
      <section class="mb-4">
        <h3 class="text-xs uppercase tracking-widest text-white/40 mb-1 px-1">
          ${escape(group.category)}
          ${group.low ? `<span class="text-amber-300">· ${group.low} ${escape(t('wh.lowShort'))}</span>` : ''}
        </h3>
        <div class="space-y-2">
          ${group.items.map((supply) => supplyRow(supply)).join('')}
        </div>
      </section>`).join('');

    for (const button of $('list').querySelectorAll('[data-supply]')) {
      button.onclick = () => openSheet(button.dataset.supply, button.dataset.kind || 'receive');
    }
  }

  function supplyRow(supply) {
    const here = stockHere(supply);
    const low = isLowHere(supply);
    const cls = here <= 0 ? 'row-empty' : (low ? 'row-low' : '');
    const unconfirmed = supply.size_confirmed === false;
    const perLocation = (supply.locations || [])
      .map((l) => `${escape(l.name)}: <b>${EV2Warehouse.packagesOf(l.stock, supply.package_size)}</b>`)
      .join(' · ');

    return `
      <article class="card rounded-xl px-3 py-2 ${cls} ${unconfirmed ? 'row-unconfirmed' : ''}">
        <div class="flex items-start justify-between gap-2">
          <div class="min-w-0">
            <p class="font-semibold truncate">${escape(supply.name)}</p>
            <p class="text-xs text-white/60">${escape(EV2Warehouse.describeStock(supply, here, lang()))}</p>
            ${state.locationFilter ? '' : `<p class="text-[11px] text-white/40 mt-.5">${perLocation || escape(t('wh.noStockAnywhere'))}</p>`}
            ${unconfirmed ? `<p class="text-[11px] text-pink-300 mt-1">${escape(t('wh.confirmSize'))}</p>` : ''}
          </div>
          <div class="flex flex-col gap-1 shrink-0">
            <button class="chip tap px-3" data-supply="${escape(supply.id)}" data-kind="receive">${escape(t('wh.kind.receive'))}</button>
            <button class="chip tap px-3" data-supply="${escape(supply.id)}" data-kind="transfer">${escape(t('wh.kind.transfer'))}</button>
            <button class="chip tap px-3" data-supply="${escape(supply.id)}" data-kind="count">${escape(t('wh.kind.count'))}</button>
          </div>
        </div>
      </article>`;
  }

  function renderRestock() {
    const list = restock();
    if (list.length === 0) return empty(t('wh.emptyRestock'));
    $('list-empty').hidden = true;
    const labels = { transfer: 'wh.actionTransfer', partial: 'wh.actionPartial', purchase: 'wh.actionPurchase' };
    $('list').innerHTML = list.map((item) => `
      <article class="card rounded-xl px-3 py-2 ${item.action === 'purchase' ? 'row-empty' : 'row-low'}">
        <div class="flex items-start justify-between gap-2">
          <div class="min-w-0">
            <p class="font-semibold truncate">${escape(item.name)}</p>
            <p class="text-xs text-white/60">
              ${escape(t('wh.missingIn', { amount: item.missing_packages, place: item.location_name }))}
            </p>
            <p class="text-[11px] text-white/40">${escape(t(labels[item.action]))}</p>
          </div>
          ${item.action === 'purchase' ? '' : `
            <button class="chip on tap px-3 shrink-0" data-restock="${escape(item.supply_id)}"
                    data-to="${escape(item.location_id)}" data-amount="${item.missing_packages}">
              ${escape(t('wh.kind.transfer'))}
            </button>`}
        </div>
      </article>`).join('');

    for (const button of $('list').querySelectorAll('[data-restock]')) {
      button.onclick = () => {
        openSheet(button.dataset.restock, 'transfer');
        // El destino y la cantidad ya se saben: es el faltante. Se rellenan para que
        // surtir sea un toque y no una captura, que es donde se cuelan los dedazos.
        const warehouse = state.locations.find((l) => l.kind === 'warehouse');
        if (warehouse) $('sheet-from').value = warehouse.id;
        $('sheet-to').value = button.dataset.to;
        $('sheet-amount').value = button.dataset.amount;
        renderPreview();
      };
    }
  }

  function renderKardex() {
    if (state.movements.length === 0) return empty(t('wh.emptyKardex'));
    $('list-empty').hidden = true;
    $('list').innerHTML = state.movements.map((m) => {
      const sign = Number(m.quantity) > 0 ? '+' : '';
      const colour = Number(m.quantity) > 0 ? 'text-emerald-300' : 'text-red-300';
      const other = m.counterpart_name
        ? ` ${m.kind === 'transfer_in' ? '←' : '→'} ${escape(m.counterpart_name)}` : '';
      return `
        <article class="card rounded-xl px-3 py-2">
          <div class="flex items-start justify-between gap-2">
            <div class="min-w-0">
              <p class="text-sm font-semibold truncate">${escape(m.supply_name)}</p>
              <p class="text-xs text-white/60">
                ${escape(t(`wh.kind.${m.kind}`))} · ${escape(m.location_name)}${other}
              </p>
              ${m.reason ? `<p class="text-[11px] text-white/40">${escape(m.reason)}</p>` : ''}
              <p class="text-[11px] text-white/40">
                ${escape(EV2Format.dateTime(m.created_at))}
                ${m.created_by_name ? `· ${escape(m.created_by_name)}` : ''}
              </p>
            </div>
            <div class="text-right shrink-0">
              <p class="${colour} font-semibold">${sign}${Number(m.quantity)} ${escape(m.unit)}</p>
              <p class="text-[11px] text-white/40">${escape(t('wh.balance'))} ${Number(m.balance_after)}</p>
            </div>
          </div>
        </article>`;
    }).join('');
  }

  // ------------------------------------------------------- captura de movimiento

  function openSheet(supplyId, kind) {
    const supply = state.supplies.find((s) => s.id === supplyId);
    if (!supply) return;
    state.sheet = {
      supply,
      kind,
      // Cajas por omisión: es como se cuenta. Lo que se cuenta por pieza no tiene
      // presentación que convertir, así que ahí se captura directo.
      mode: supply.unit === 'pza' || Number(supply.package_size) === 1 ? 'base' : 'packages',
    };
    $('sheet-amount').value = '';
    $('sheet-cost').value = '';
    $('sheet-reason').value = '';
    $('sheet-error').hidden = true;
    renderSheet();
    $('sheet-backdrop').hidden = false;
    $('sheet').hidden = false;
  }

  function closeSheet() {
    state.sheet = null;
    $('sheet').hidden = true;
    $('sheet-backdrop').hidden = true;
  }
  $('sheet-close').onclick = closeSheet;
  $('sheet-backdrop').onclick = closeSheet;

  function renderSheet() {
    const { supply, kind, mode } = state.sheet;
    const move = EV2Warehouse.movementFor(kind);
    $('sheet-title').textContent = t(`wh.kind.${kind}`);
    $('sheet-supply').textContent = `${supply.name} · ${EV2Warehouse.describeStock(supply, stockHere(supply), lang())}`;

    $('sheet-kinds').innerHTML = EV2Warehouse.movementKeys().map((key) => `
      <button type="button" class="chip tap px-3 ${key === kind ? 'on' : ''}" data-kind="${key}">
        ${escape(t(`wh.kind.${key}`))}
      </button>`).join('');
    for (const button of $('sheet-kinds').querySelectorAll('[data-kind]')) {
      button.onclick = () => {
        state.sheet.kind = button.dataset.kind;
        $('sheet-error').hidden = true;
        renderSheet();
      };
    }

    // De dónde / a dónde. Una recepción entra en un lugar; un traspaso va entre dos.
    const options = (list, selected) => list.map((l) => `
      <option value="${escape(l.id)}" ${l.id === selected ? 'selected' : ''}>${escape(l.name)}</option>`).join('');
    const suggested = state.locationFilter
      || (kind === 'receive'
        ? (state.locations.find((l) => l.kind === 'warehouse') || {}).id
        : (state.locations[0] || {}).id);
    $('sheet-from').innerHTML = options(state.locations, suggested);
    $('sheet-to-wrap').hidden = !move.needsTarget;
    if (move.needsTarget) {
      const bar = state.locations.find((l) => l.kind === 'bar');
      $('sheet-to').innerHTML = options(state.locations, bar && bar.id);
    }
    $('sheet-cost-wrap').hidden = !move.needsCost;
    $('sheet-reason-required').hidden = !move.needsReason;

    const unitLabel = supply.unit === 'pza' ? t('wh.unitPieces') : supply.unit;
    $('mode-base').textContent = unitLabel;
    $('mode-packages').hidden = supply.unit === 'pza' || Number(supply.package_size) === 1;
    $('mode-packages').classList.toggle('on', mode === 'packages');
    $('mode-base').classList.toggle('on', mode === 'base');
    $('sheet-amount-label').textContent = kind === 'count' ? t('wh.counted') : t('wh.amount');
    renderPreview();
  }

  $('mode-packages').onclick = () => { state.sheet.mode = 'packages'; renderSheet(); };
  $('mode-base').onclick = () => { state.sheet.mode = 'base'; renderSheet(); };
  $('sheet-amount').oninput = renderPreview;

  /** Lo que va a pasar, antes de que pase. */
  function renderPreview() {
    if (!state.sheet) return;
    const { supply, kind, mode } = state.sheet;
    const raw = $('sheet-amount').value;
    if (raw === '') { $('sheet-preview').textContent = ''; return; }
    const quantity = EV2Warehouse.toBaseUnit({ amount: raw, mode, supply });
    const from = shelf($('sheet-from').value);
    const to = $('sheet-to-wrap').hidden ? null : shelf($('sheet-to').value);
    const rows = EV2Warehouse.preview({ kind, supply, from, to, quantity });
    if (!rows) { $('sheet-preview').textContent = ''; return; }
    $('sheet-preview').innerHTML = rows.map((row) => {
      const name = row.location ? row.location.name : '—';
      const diff = row.difference !== undefined
        ? ` <span class="${row.difference < 0 ? 'text-red-300' : 'text-emerald-300'}">(${row.difference > 0 ? '+' : ''}${row.difference})</span>`
        : '';
      return `<div>${escape(name)}: ${EV2Warehouse.describeStock(supply, row.before, lang())}
        → <b>${EV2Warehouse.describeStock(supply, row.after, lang())}</b>${diff}</div>`;
    }).join('');
  }

  /** El estante: el lugar más el saldo que tiene de este insumo. */
  function shelf(locationId) {
    const place = locationById(locationId);
    if (!place) return null;
    const here = (state.sheet.supply.locations || [])
      .find((l) => l.location_id === locationId);
    return {
      id: place.id, code: place.code, name: place.name, kind: place.kind,
      stock: here ? Number(here.stock) : 0,
      min_stock: here ? Number(here.min_stock) : 0,
    };
  }

  $('sheet-submit').onclick = async () => {
    if (!state.sheet || state.busy) return;
    const { supply, kind, mode } = state.sheet;
    $('sheet-error').hidden = true;

    const quantity = EV2Warehouse.toBaseUnit({ amount: $('sheet-amount').value, mode, supply });
    const from = shelf($('sheet-from').value);
    const to = $('sheet-to-wrap').hidden ? null : shelf($('sheet-to').value);
    const reason = $('sheet-reason').value;
    const unitCost = $('sheet-cost-wrap').hidden ? undefined : $('sheet-cost').value;

    const problems = EV2Warehouse.validate({ kind, supply, from, to, quantity, reason, unitCost });
    if (problems.length > 0) {
      const first = problems[0];
      $('sheet-error').textContent = first.code === 'not_enough'
        ? t('wh.err.not_enough', { available: first.available, needed: first.needed })
        : t(`wh.err.${first.code}`);
      $('sheet-error').hidden = false;
      return;
    }

    // Se manda lo que capturó la persona (cajas o unidad base) con el campo que
    // corresponde: convertir aquí y allá sería convertir dos veces.
    const amount = mode === 'packages'
      ? Number($('sheet-amount').value) : Number($('sheet-amount').value);
    const request = EV2Warehouse.requestFor({
      kind, supply, from, to, quantity: amount, reason, unitCost, mode,
    });

    state.busy = true;
    $('sheet-submit').disabled = true;
    try {
      const result = await api.post(`/nightclubs/${clubId()}${request.path}`, request.body);
      closeSheet();
      if (kind === 'count' && result && result.difference !== undefined) {
        toast(result.difference === 0
          ? t('wh.countMatches')
          : t('wh.countDiff', { diff: result.difference }), result.difference === 0 ? 'ok' : 'info');
      } else {
        toast(t('wh.saved'), 'ok');
      }
      await load();
    } catch (err) {
      showError(err, $('sheet-error'));
    } finally {
      state.busy = false;
      $('sheet-submit').disabled = false;
    }
  };

  api.on('auth:expired', () => {
    banner(t('banner.expired'));
    setTimeout(() => location.reload(), 2500);
  });

  // ---------------------------------------------------------------- arranque

  (async function boot() {
    EV2Format.setLanguage(EV2Format.getLanguage());
    EV2Format.applyTo(document);
    $('btn-lang').textContent = EV2Format.otherLanguage().toUpperCase();
    const user = await api.resume();
    if (user) await afterSignIn();
  }());
}());
