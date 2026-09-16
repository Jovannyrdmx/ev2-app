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
/* global EV2, EV2Format, EV2Warehouse, EV2Receiving, EV2ReceiptReview, EV2Roles,
   EV2PasswordGate */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);

  /**
   * Cablea un elemento que puede no estar todavía, y dice si lo encontró.
   *
   * Para los elementos que se agregaron en un paso posterior al del HTML que ya está
   * en el teléfono de alguien. El resto sigue usando `$(...)` directo a propósito: si
   * falta el botón de salir, la pantalla está tan rota que callarlo no ayuda.
   */
  function on(id, event, handler) {
    const el = $(id);
    if (el) el[event] = handler;
    return Boolean(el);
  }
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
    // --- entrada de mercancía en lote ---
    suppliers: [],
    // El borrador vive en el estado y NO en los <input> de la pantalla: una entrega
    // son quince renglones capturados con el camión esperando, y cualquier repintado
    // que los borre es justo el momento en que alguien decide "ya, ponle que llegó
    // todo".
    draft: [],
    draftSupplier: '',
    // --- la foto del ticket o la factura ---
    // `photo` es la que se está capturando ahora; `photos` son las subidas que
    // todavía no se han capturado, que es mercancía dentro del club y fuera del
    // inventario: lo más importante que esta pantalla puede avisar.
    photo: null,
    photos: [],
    photoBusy: false,
    photoUrl: null,         // el object URL de la imagen abierta, para liberarlo
    // --- pedidos de las barras ---
    requests: [],
    fulfill: null,          // { request, from, lines }
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
  // Con `on` y no con `$(...).onclick` directo: este archivo y `almacen.html` viajan
  // por separado, y un navegador puede quedarse con el HTML de ayer y el JavaScript de
  // hoy (o al revés). Si un id no existe todavía, lo que se pierde es ESE botón; con el
  // acceso directo se cae el archivo entero al cargar y la pantalla no abre siquiera.
  on('photo-viewer-close', 'onclick', () => closePhotoViewer());

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
    // La vuelta al panel solo para quien tiene panel. Un almacenista no lo tiene, y un
    // enlace que lo manda a una pantalla que le dice "rol equivocado" es peor que nada.
    const role = api.session.user && api.session.user.role;
    $('btn-back-manager').hidden = !['manager', 'admin'].includes(role);
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
      // Los pedidos pendientes se cargan SIEMPRE, no solo al abrir su pestaña: el
      // número en la pestaña es lo que hace que el almacenista se entere de que la
      // barra pidió algo. Un contador que solo aparece al entrar no avisa de nada.
      await Promise.all([loadRequests(), loadSuppliers(), loadPhotos()]);
      if (state.tab === 'kardex') await loadMovements();
      if (state.draft.length === 0) state.draft = [EV2Receiving.emptyLine()];
      renderAll();
      banner(null);
    } catch (err) { showError(err); }
  }

  async function loadSuppliers() {
    try {
      const data = await api.get(`/nightclubs/${clubId()}/suppliers`);
      state.suppliers = data.suppliers || [];
    } catch {
      // Sin proveedores se puede capturar igual: el proveedor es opcional a
      // propósito, y una entrega no se queda sin registrar por eso.
      state.suppliers = [];
    }
  }

  async function loadRequests() {
    try {
      const data = await api.get(`/nightclubs/${clubId()}/bar-requests?limit=50`);
      state.requests = data.requests || [];
    } catch {
      state.requests = [];
    }
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
    $('count-entry').textContent = EV2Receiving.draftSummary(state.draft, state.supplies).lines;
    $('count-requests').textContent = state.requests
      .filter((r) => EV2Receiving.statusOf(r.status).pending).length;
    for (const tab of document.querySelectorAll('[data-tab]')) {
      tab.classList.toggle('active', tab.dataset.tab === state.tab);
    }
    // El buscador filtra la lista de existencias. En la captura de una entrada y en
    // la bandeja de pedidos no filtra nada, y dejarlo ahí hace creer que sí.
    $('search-wrap').hidden = ['entrada', 'pedidos'].includes(state.tab);
  }

  for (const tab of document.querySelectorAll('[data-tab]')) {
    tab.onclick = async () => {
      state.tab = tab.dataset.tab;
      if (state.tab === 'kardex') await loadMovements();
      if (state.tab === 'pedidos') await loadRequests();
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
    if (state.tab === 'entrada') return renderEntry();
    if (state.tab === 'pedidos') return renderRequests();
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

  // ==================================================== entrada de mercancía en lote

  // ------------------------------------------------- la foto del ticket o la factura

  /**
   * La tarjeta de la foto, arriba de la captura.
   *
   * Dos cosas, y el orden en la pantalla dice cuál manda: el botón de la foto arriba,
   * y debajo, chiquito, que se puede capturar a mano. La foto es lo normal; teclear
   * quince renglones de pie es lo que se hacía antes.
   *
   * Cuando hay fotos subidas y sin capturar, se listan aquí. Una foto pendiente es una
   * entrega que entró al club y todavía no está en el inventario: es la cosa más
   * importante que esta pantalla puede decirle a alguien.
   */
  function photoCard() {
    const foto = state.photo;
    const pendientes = (state.photos || []).filter((p) => !foto || p.id !== foto.id);

    return `
      <section class="card rounded-xl px-3 py-3 mb-3 space-y-2">
        <input id="photo-input" type="file" accept="image/*" capture="environment" hidden>
        <button type="button" id="photo-pick"
                class="ev2-button w-full py-3 rounded-xl font-display flex items-center justify-center gap-2"
                ${state.photoBusy ? 'disabled' : ''}>
          <i class="fa-solid fa-camera"></i>
          <span>${escape(state.photoBusy ? t('rc.reading') : t('rc.takePhoto'))}</span>
        </button>
        <p class="text-[11px] text-white/40">${escape(t('rc.photoHint'))}</p>
        ${foto ? photoState(foto) : ''}
        ${pendientes.length ? `
          <div class="pt-1 border-t border-white/10">
            <p class="text-[11px] text-amber-300 mb-1">
              ${escape(t('rc.pendingPhotos', { n: pendientes.length }))}
            </p>
            ${pendientes.map((p) => `
              <div class="flex items-center justify-between gap-2 py-1">
                <span class="text-xs text-white/60 truncate">
                  ${escape(EV2Format.dateTime(p.created_at))}
                  ${p.supplier_name ? `· ${escape(p.supplier_name)}` : ''}
                </span>
                <button type="button" class="chip tap px-3 shrink-0" data-photo="open" data-id="${escape(p.id)}">
                  ${escape(t('rc.use'))}
                </button>
              </div>`).join('')}
          </div>` : ''}
      </section>`;
  }

  /** El estado de la foto cargada: qué leyó, qué falta, y qué se puede hacer con ella. */
  function photoState(foto) {
    const estado = EV2ReceiptReview.statusOf(foto.status);
    const resumen = foto.parsed
      ? EV2ReceiptReview.summary(foto.parsed, state.draft) : null;

    return `
      <div class="rounded-xl px-3 py-2" style="background:rgba(255,255,255,.04)">
        <div class="flex items-center justify-between gap-2">
          <p class="text-xs ${estado.usable ? 'text-lime-300' : 'text-amber-300'}">
            ${escape(t(estado.key))}
          </p>
          <div class="flex gap-1 shrink-0">
            <button type="button" class="chip tap px-3" data-photo="view">${escape(t('rc.viewPhoto'))}</button>
            <button type="button" class="chip tap px-3" data-photo="reparse">${escape(t('rc.reread'))}</button>
            <button type="button" class="chip tap px-3" data-photo="discard">${escape(t('rc.discard'))}</button>
          </div>
        </div>
        ${foto.error ? `<p class="text-[11px] text-pink-300 mt-1">${escape(foto.error)}</p>
          <p class="text-[11px] text-white/50">${escape(t('rc.failedButSaved'))}</p>` : ''}
        ${resumen ? `
          <p class="text-[11px] text-white/60 mt-1">
            ${escape(t('rc.reviewCount', { n: resumen.lines, review: resumen.to_review }))}
          </p>
          ${resumen.total_matches === false ? `
            <p class="text-[11px] text-amber-300 mt-1">
              ${escape(t('rc.totalGap', {
    paper: EV2Format.money(resumen.paper_total, 'MXN'),
    lines: EV2Format.money(resumen.total, 'MXN'),
  }))}
            </p>` : ''}
          ${resumen.total_matches === true ? `
            <p class="text-[11px] text-lime-300 mt-1">${escape(t('rc.totalOk'))}</p>` : ''}
        ` : ''}
      </div>`;
  }

  /**
   * Sube la foto: la guarda y, si se pudo leer, pre-llena los renglones.
   *
   * El borrador solo se pisa si está limpio. Perder quince renglones ya capturados
   * porque alguien tocó la cámara sin querer es exactamente el tipo de cosa que hace
   * que a la tercera entrega ya nadie capture nada.
   */
  async function uploadPhoto(file) {
    if (!file || state.photoBusy) return;
    state.photoBusy = true;
    renderEntry();
    try {
      const form = new FormData();
      form.append('photo', file, file.name || 'ticket.jpg');
      if (state.draftSupplier) form.append('supplier_id', state.draftSupplier);
      const data = await api.postForm(`/nightclubs/${clubId()}/receipt-photos`, form);
      state.photo = data.photo;
      if (data.already_uploaded) toast(t('rc.alreadyUploaded'), 'warn');
      applyPhotoToDraft(data.photo);
      await loadPhotos();
    } catch (err) {
      state.photo = null;
      showError(err, $('entry-error'));
    } finally {
      state.photoBusy = false;
      renderTabs();
      renderEntry();
    }
  }

  /** Pasa lo leído al borrador, si hay algo que pasar y no hay nada que perder. */
  function applyPhotoToDraft(foto) {
    const lines = (foto.parsed && foto.parsed.lines) || [];
    if (lines.length === 0) {
      toast(t('rc.nothingRead'), 'warn');
      return;
    }
    const limpio = state.draft.every((l) => EV2Receiving.isEmptyLine(l));
    if (!limpio) { toast(t('rc.draftKept'), 'warn'); return; }
    state.draft = EV2ReceiptReview.draftFromPhoto(foto.parsed);
    state.draft.push(EV2Receiving.emptyLine());
    const resumen = EV2ReceiptReview.summary(foto.parsed, state.draft);
    toast(t('rc.filled', { n: resumen.lines, review: resumen.to_review }), 'ok');
  }

  /** Las fotos subidas y todavía sin capturar. */
  async function loadPhotos() {
    try {
      const data = await api.get(`/nightclubs/${clubId()}/receipt-photos?limit=20`);
      state.photos = data.photos || [];
    } catch { state.photos = []; }
  }

  /** Abre la imagen en grande. Con el token puesto: es una factura, no un archivo público. */
  async function viewPhoto(photoId) {
    // Mismo caso que arriba: el visor vive en el HTML y este archivo puede llegar
    // antes. Se avisa y se sigue, en vez de tirar un error que nadie va a leer.
    if (!$('photo-viewer')) { toast(t('rc.viewerMissing'), 'warn'); return; }
    try {
      const blob = await api.getBlob(`/nightclubs/${clubId()}/receipt-photos/${photoId}/image`);
      if (state.photoUrl) URL.revokeObjectURL(state.photoUrl);
      state.photoUrl = URL.createObjectURL(blob);
      $('photo-viewer-img').src = state.photoUrl;
      $('photo-viewer-title').textContent = t('rc.viewPhoto');
      $('photo-viewer').hidden = false;
    } catch (err) { showError(err, $('entry-error')); }
  }

  function closePhotoViewer() {
    $('photo-viewer').hidden = true;
    $('photo-viewer-img').src = '';
    if (state.photoUrl) { URL.revokeObjectURL(state.photoUrl); state.photoUrl = null; }
  }

  function wirePhotoCard() {
    const input = $('photo-input');
    const boton = $('photo-pick');
    if (!input || !boton) return;
    boton.onclick = () => input.click();
    input.onchange = () => {
      const file = input.files && input.files[0];
      input.value = '';
      if (file) uploadPhoto(file);
    };

    for (const el of $('list').querySelectorAll('[data-photo]')) {
      const accion = el.dataset.photo;
      if (accion === 'open') {
        el.onclick = async () => {
          const foto = (state.photos || []).find((p) => p.id === el.dataset.id);
          if (!foto) return;
          state.photo = foto;
          applyPhotoToDraft(foto);
          renderEntry();
        };
      } else if (accion === 'view') {
        el.onclick = () => viewPhoto(state.photo.id);
      } else if (accion === 'reparse') {
        el.onclick = async () => {
          if (state.photoBusy) return;
          state.photoBusy = true;
          renderEntry();
          try {
            const data = await api.post(
              `/nightclubs/${clubId()}/receipt-photos/${state.photo.id}/reparse`, {});
            state.photo = data.photo;
            // Al volver a leer se pisa el borrador a propósito: es lo que se pidió, y
            // los renglones de antes salieron de esta misma foto.
            state.draft = [EV2Receiving.emptyLine()];
            applyPhotoToDraft(data.photo);
          } catch (err) { showError(err, $('entry-error')); } finally {
            state.photoBusy = false;
            renderEntry();
          }
        };
      } else if (accion === 'discard') {
        el.onclick = async () => {
          // Se pide el motivo: una foto descartada sin razón deja la duda de si la
          // entrega llegó o no, que es peor que no tener la foto.
          const motivo = (prompt(t('rc.discardWhy')) || '').trim();
          if (motivo.length < 3) return;
          try {
            await api.post(
              `/nightclubs/${clubId()}/receipt-photos/${state.photo.id}/discard`,
              { reason: motivo });
            state.photo = null;
            state.draft = [EV2Receiving.emptyLine()];
            await loadPhotos();
            toast(t('rc.discarded'), 'ok');
          } catch (err) { showError(err, $('entry-error')); } finally { renderEntry(); }
        };
      }
    }
  }

  const supplyOption = (s, selectedId, marca) => `<option value="${escape(s.id)}"
      ${s.id === selectedId ? 'selected' : ''}>${marca}${escape(s.name)}${
  s.package_label ? ` · ${escape(s.package_label)}` : ''}</option>`;

  /**
   * Las opciones del selector de insumo, una sola vez por repintado.
   *
   * `sugeridos` son los que el parecido de nombre encontró al leer la foto del ticket,
   * y van ARRIBA, marcados. El resto del catálogo va debajo, siempre: el parecido
   * acierta casi siempre, y cuando no, la lista completa tiene que estar en el mismo
   * selector y no en otra pantalla, con el camión esperando.
   */
  function supplyOptions(selectedId, sugeridos = []) {
    const propuestos = (sugeridos || [])
      .map((c) => ({ ...(supplyById(c.id) || { id: c.id, name: c.name }), score: c.score }))
      .filter((s) => s.id);
    const vistos = new Set(propuestos.map((s) => s.id));
    const resto = state.supplies
      .filter((s) => s.active !== false && !vistos.has(s.id))
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name));

    const partes = ['<option value="">—</option>'];
    if (propuestos.length) {
      partes.push(`<optgroup label="${escape(t('rc.suggested'))}">`,
        ...propuestos.map((s) => supplyOption(s, selectedId, '')), '</optgroup>',
        `<optgroup label="${escape(t('rc.allSupplies'))}">`,
        ...resto.map((s) => supplyOption(s, selectedId, '')), '</optgroup>');
    } else {
      partes.push(...resto.map((s) => supplyOption(s, selectedId, '')));
    }
    return partes.join('');
  }

  const supplyById = (id) => state.supplies.find((s) => s.id === id) || null;

  /** ¿A dónde entra la mercancía? Al almacén, salvo que se filtre otro lugar. */
  function entryLocation() {
    if (state.locationFilter) return state.locationFilter;
    const almacen = state.locations.find((l) => l.kind === 'warehouse');
    return almacen ? almacen.id : (state.locations[0] && state.locations[0].id) || null;
  }

  function renderEntry() {
    $('list-empty').hidden = true;
    const resumen = EV2Receiving.draftSummary(state.draft, state.supplies);
    const problemas = EV2Receiving.validateDraft(state.draft, state.supplies);
    const porRenglon = new Map();
    for (const p of problemas) {
      if (!porRenglon.has(p.row)) porRenglon.set(p.row, []);
      porRenglon.get(p.row).push(p);
    }
    const lugar = locationById(entryLocation());
    const puedeAltaProveedor = api.hasRole('manager');

    $('list').innerHTML = `
      ${photoCard()}
      <section class="card rounded-xl px-3 py-3 mb-3 space-y-3">
        <div>
          <label class="text-xs text-white/50" data-i18n="wh.entryInto">Entra en</label>
          <p class="text-sm font-semibold">${escape(lugar ? lugar.name : t('wh.noLocations'))}</p>
        </div>
        <div>
          <label class="text-xs text-white/50" data-i18n="wh.supplier">Proveedor</label>
          <div class="flex gap-2">
            <select id="entry-supplier" class="field">
              <option value="">${escape(t('wh.noSupplier'))}</option>
              ${state.suppliers.map((p) => `<option value="${escape(p.id)}"
                  ${p.id === state.draftSupplier ? 'selected' : ''}>${escape(p.name)}</option>`).join('')}
            </select>
            ${puedeAltaProveedor
    ? `<button type="button" id="entry-new-supplier" class="chip tap px-3 shrink-0">+</button>` : ''}
          </div>
          <p class="text-[11px] text-white/40 mt-1" data-i18n="wh.supplierOptional">
            Opcional. Si lo eliges, se precargan los insumos que surte.
          </p>
        </div>
      </section>

      <div id="entry-lines" class="space-y-2">
        ${state.draft.map((line, index) => entryRow(line, index, porRenglon.get(index + 1) || [])).join('')}
      </div>

      <div class="card rounded-xl px-3 py-3 mt-3 space-y-2">
        <div class="flex items-center justify-between text-sm">
          <span class="text-white/60">${escape(t('wh.entryLines', { n: resumen.lines }))}</span>
          <span class="font-display text-lg">${escape(EV2Format.money(resumen.total, 'MXN'))}</span>
        </div>
        ${resumen.lines > 0 && !resumen.total_is_complete
    ? `<p class="text-[11px] text-amber-300">${escape(t('wh.entryTotalPartial'))}</p>` : ''}
        <button type="button" id="entry-add" class="chip tap px-3 w-full py-2">
          ${escape(t('wh.entryAddLine'))}
        </button>
        <p id="entry-error" class="text-sm text-red-300" hidden></p>
        <button type="button" id="entry-submit"
                class="ev2-button w-full py-3 rounded-xl font-display">
          ${escape(t('wh.entrySave'))}
        </button>
        <button type="button" id="entry-clear" class="w-full text-xs text-white/40 underline">
          ${escape(t('wh.entryClear'))}
        </button>
      </div>`;

    wireEntry();
  }

  /**
   * Lo que se leyó del papel, arriba del renglón: el texto tal cual y qué tan fiable es.
   *
   * El texto crudo es lo que hace comparable el renglón con el ticket sin abrir la
   * foto, y la insignia dice si hay que mirarlo. `ok` significa que cantidad × precio
   * dio el importe impreso: eso se comprueba solo y no necesita que nadie lo revise.
   */
  function readBadge(line) {
    if (!line.read) return '';
    const marcas = { high: 'text-lime-300', medium: 'text-amber-300', low: 'text-pink-300' };
    const tono = marcas[line.read.confidence] || 'text-white/50';
    const cuadra = line.read.math === 'ok';
    return `
      <div class="mb-2 border-l-2 pl-2 ${cuadra ? 'border-lime-400/40' : 'border-pink-400/50'}">
        <p class="text-[11px] text-white/45 break-words">${escape(line.read.text)}</p>
        <p class="text-[10px] ${tono}">
          ${escape(t(`rc.conf.${line.read.confidence}`))}
          · ${escape(t(`rc.math.${line.read.math}`))}
        </p>
      </div>`;
  }

  function entryRow(line, index, problemas) {
    const supply = supplyById(line.supply_id);
    const totales = EV2Receiving.lineTotals(line, supply);
    const malo = problemas.length > 0;
    const unidad = supply ? supply.unit : 'ml';
    const sugeridos = (line.read && line.read.candidates) || [];

    return `
      <article class="card rounded-xl px-3 py-2 ${malo ? 'row-empty' : ''}" data-row="${index}">
        ${readBadge(line)}
        <div class="flex items-center gap-2 mb-2">
          <select class="field" data-entry="supply" data-index="${index}">
            ${supplyOptions(line.supply_id, sugeridos)}
          </select>
          <button type="button" class="text-white/40 px-2 shrink-0" data-entry="remove"
                  data-index="${index}" aria-label="${escape(t('wh.entryRemoveLine'))}">✕</button>
        </div>
        <div class="flex gap-2">
          <input type="number" step="0.001" min="0" inputmode="decimal" class="field"
                 placeholder="${escape(line.mode === 'packages' ? t('wh.inPackages') : unidad)}"
                 value="${escape(line.amount)}" data-entry="amount" data-index="${index}">
          <div class="flex gap-1 shrink-0">
            <button type="button" class="chip tap px-2 ${line.mode === 'packages' ? 'on' : ''}"
                    data-entry="mode" data-mode="packages" data-index="${index}">
              ${escape(t('wh.inPackages'))}
            </button>
            <button type="button" class="chip tap px-2 ${line.mode === 'base' ? 'on' : ''}"
                    data-entry="mode" data-mode="base" data-index="${index}">${escape(unidad)}</button>
          </div>
          <input type="number" step="0.01" min="0" inputmode="decimal" class="field"
                 placeholder="${escape(t('wh.packageCostShort'))}"
                 value="${escape(line.package_cost)}" data-entry="cost" data-index="${index}">
        </div>
        <div class="flex items-center justify-between mt-1 text-[11px]">
          <span class="text-white/40">
            ${totales.quantity !== null && supply
    ? escape(EV2Warehouse.describeStock(supply, totales.quantity, lang())) : ''}
          </span>
          <span class="text-white/60">
            ${totales.total !== null ? escape(EV2Format.money(totales.total, 'MXN')) : ''}
          </span>
        </div>
        ${malo ? `<p class="text-[11px] text-red-300 mt-1">
            ${problemas.map((p) => escape(entryProblemText(p))).join(' · ')}
          </p>` : ''}
      </article>`;
  }

  /** Los códigos del validador, en palabras. Se traducen aquí, no en la lógica. */
  function entryProblemText(problem) {
    const key = `wh.entryErr.${problem.field}.${problem.code}`;
    const texto = t(key);
    return texto === key ? t('wh.entryErr.generic') : texto;
  }

  function wireEntry() {
    const repintar = () => { renderTabs(); renderEntry(); };
    wirePhotoCard();

    const selector = $('entry-supplier');
    if (selector) {
      selector.onchange = async () => {
        state.draftSupplier = selector.value;
        if (!state.draftSupplier) return repintar();
        // Precargar los renglones del proveedor es la diferencia entre capturar una
        // entrega en dos minutos y buscar quince insumos entre doscientos con el
        // camión esperando. Solo si el borrador está limpio: pisar lo capturado
        // sería perder trabajo hecho.
        const limpio = state.draft.every((l) => EV2Receiving.isEmptyLine(l));
        if (!limpio) return repintar();
        try {
          const data = await api.get(`/nightclubs/${clubId()}/suppliers/${state.draftSupplier}`);
          if ((data.supplies || []).length > 0) {
            state.draft = EV2Receiving.draftFromSupplier(data.supplies);
          }
        } catch { /* sin precarga se captura a mano, que es lo de siempre */ }
        return repintar();
      };
    }

    const nuevo = $('entry-new-supplier');
    if (nuevo) nuevo.onclick = () => openSupplierSheet();

    $('entry-add').onclick = () => {
      state.draft.push(EV2Receiving.emptyLine());
      repintar();
    };

    $('entry-clear').onclick = () => {
      state.draft = [EV2Receiving.emptyLine()];
      state.draftSupplier = '';
      repintar();
    };

    for (const el of $('list').querySelectorAll('[data-entry]')) {
      const index = Number(el.dataset.index);
      const campo = el.dataset.entry;

      if (campo === 'supply') {
        el.onchange = () => { state.draft[index].supply_id = el.value || null; repintar(); };
      } else if (campo === 'amount') {
        // `onchange` y no `oninput`: repintar en cada tecla mueve el foco y borra lo
        // que la persona está escribiendo.
        el.onchange = () => { state.draft[index].amount = el.value; repintar(); };
      } else if (campo === 'cost') {
        el.onchange = () => { state.draft[index].package_cost = el.value; repintar(); };
      } else if (campo === 'mode') {
        el.onclick = () => { state.draft[index].mode = el.dataset.mode; repintar(); };
      } else if (campo === 'remove') {
        el.onclick = () => {
          state.draft.splice(index, 1);
          if (state.draft.length === 0) state.draft = [EV2Receiving.emptyLine()];
          repintar();
        };
      }
    }

    $('entry-submit').onclick = submitEntry;
  }

  async function submitEntry() {
    if (state.busy) return;
    const problemas = EV2Receiving.validateDraft(state.draft, state.supplies);
    if (problemas.length > 0) {
      const el = $('entry-error');
      el.textContent = problemas[0].row === 0
        ? t(`wh.entryErr.lines.${problemas[0].code}`)
        : t('wh.entryFixLines', { n: new Set(problemas.map((p) => p.row)).size });
      el.hidden = false;
      return;
    }
    const lugar = entryLocation();
    if (!lugar) { showError(new Error(t('wh.noLocations')), $('entry-error')); return; }

    state.busy = true;
    $('entry-submit').disabled = true;
    try {
      const body = EV2Receiving.receiptRequest({
        locationId: lugar,
        supplierId: state.draftSupplier || null,
        lines: state.draft,
        // La foto viaja con la captura para que queden amarradas: el comprobante y el
        // lote que salio de el. El servidor se niega si esa foto ya se capturo, que es
        // la proteccion contra el doble toque en un telefono lento.
        photoId: state.photo ? state.photo.id : null,
      });
      const data = await api.post(`/nightclubs/${clubId()}/supply-receipts`, body);
      toast(t('wh.entrySaved', { n: data.receipt.lines.length }), 'ok');
      state.draft = [EV2Receiving.emptyLine()];
      state.draftSupplier = '';
      state.photo = null;
      await load();
    } catch (err) {
      showError(err, $('entry-error'));
    } finally {
      state.busy = false;
      const boton = $('entry-submit');
      if (boton) boton.disabled = false;
    }
  }

  // -------------------------------------------------------------- proveedor nuevo

  function openSupplierSheet() {
    $('supplier-error').hidden = true;
    $('form-supplier').reset();
    $('sheet-backdrop').hidden = false;
    $('sheet-supplier').hidden = false;
  }

  function closeSupplierSheet() {
    $('sheet-supplier').hidden = true;
    if ($('sheet').hidden && $('sheet-fulfill').hidden) $('sheet-backdrop').hidden = true;
  }

  $('supplier-close').onclick = closeSupplierSheet;

  $('form-supplier').onsubmit = async (ev) => {
    ev.preventDefault();
    $('supplier-error').hidden = true;
    try {
      const data = await api.post(`/nightclubs/${clubId()}/suppliers`, {
        name: $('supplier-name').value.trim(),
        contact_name: $('supplier-contact').value.trim() || undefined,
        phone: $('supplier-phone').value.trim() || undefined,
      });
      await loadSuppliers();
      // Se deja elegido: quien acaba de darlo de alta es porque va a capturar su
      // entrega ahora mismo.
      state.draftSupplier = data.supplier.id;
      closeSupplierSheet();
      toast(t('wh.supplierSaved'), 'ok');
      renderAll();
    } catch (err) {
      showError(err, $('supplier-error'));
    }
  };

  // ============================================ pedidos de las barras

  function renderRequests() {
    if (state.requests.length === 0) return empty(t('wh.emptyRequests'));
    $('list-empty').hidden = true;

    $('list').innerHTML = state.requests.map((request) => {
      const estado = EV2Receiving.statusOf(request.status);
      const tono = estado.tone === 'warn' ? 'row-low' : (estado.tone === 'ok' ? '' : 'row-empty');
      const lineas = (request.lines || []).map((l) => {
        const falta = Number(l.pending);
        const cuantas = Math.round((falta / Number(l.package_size)) * 100) / 100;
        return `<li class="flex justify-between gap-2">
            <span class="truncate">${escape(l.name)}</span>
            <span class="shrink-0 ${falta > 0 ? 'text-amber-200' : 'text-white/40'}">
              ${falta > 0 ? escape(t('wh.requestPending', { n: cuantas })) : escape(t('wh.requestDone'))}
            </span>
          </li>`;
      }).join('');

      return `
        <article class="card rounded-xl px-3 py-2 ${tono} mb-2">
          <div class="flex items-start justify-between gap-2">
            <div class="min-w-0">
              <p class="font-semibold truncate">${escape(request.location_name)}</p>
              <p class="text-[11px] text-white/40">
                ${escape(EV2Format.dateTime(request.created_at))}
                ${request.requested_by_name ? `· ${escape(request.requested_by_name)}` : ''}
              </p>
              ${request.note ? `<p class="text-xs text-white/60 mt-1">${escape(request.note)}</p>` : ''}
            </div>
            <span class="chip shrink-0">${escape(t(`wh.requestStatus.${request.status}`))}</span>
          </div>
          <ul class="text-xs text-white/70 mt-2 space-y-.5">${lineas}</ul>
          ${estado.pending ? `
            <div class="flex gap-2 mt-2">
              <button class="chip on tap px-3" data-fulfill="${escape(request.id)}">
                ${escape(t('wh.fulfillSend'))}
              </button>
            </div>` : ''}
        </article>`;
    }).join('');

    for (const button of $('list').querySelectorAll('[data-fulfill]')) {
      button.onclick = () => openFulfillSheet(button.dataset.fulfill);
    }
  }

  /** Lo que hay en un lugar de un insumo, para avisar antes de prometer producto. */
  function stockAt(supplyId, locationId) {
    const supply = supplyById(supplyId);
    if (!supply) return 0;
    const here = (supply.locations || []).find((l) => l.location_id === locationId);
    return here ? Number(here.stock) : 0;
  }

  function openFulfillSheet(requestId) {
    const request = state.requests.find((r) => r.id === requestId);
    if (!request) return;
    const almacen = state.locations.find((l) => l.kind === 'warehouse');
    state.fulfill = {
      request,
      // El origen por omisión es el almacén. Se puede cambiar porque a media noche
      // se surte de la otra barra, que es lo que de verdad pasa.
      from: almacen ? almacen.id : null,
      lines: EV2Receiving.fulfillDraft(request),
    };
    $('sheet-backdrop').hidden = false;
    $('sheet-fulfill').hidden = false;
    renderFulfill();
  }

  function closeFulfillSheet() {
    state.fulfill = null;
    $('sheet-fulfill').hidden = true;
    if ($('sheet').hidden && $('sheet-supplier').hidden) $('sheet-backdrop').hidden = true;
  }

  $('fulfill-close').onclick = closeFulfillSheet;

  function renderFulfill() {
    const f = state.fulfill;
    if (!f) return;
    $('fulfill-bar').textContent = f.request.location_name;
    $('fulfill-from').innerHTML = state.locations
      .filter((l) => l.id !== f.request.location_id)
      .map((l) => `<option value="${escape(l.id)}" ${l.id === f.from ? 'selected' : ''}>
          ${escape(l.name)}</option>`).join('');
    $('fulfill-from').onchange = () => { f.from = $('fulfill-from').value; renderFulfill(); };

    $('fulfill-lines').innerHTML = f.lines.map((line, index) => {
      const hay = stockAt(line.supply_id, f.from);
      const pide = Number(line.amount) * Number(line.package_size);
      const corto = pide > hay;
      return `
        <article class="card rounded-xl px-3 py-2 ${corto ? 'row-low' : ''}">
          <div class="flex items-center justify-between gap-2">
            <div class="min-w-0">
              <p class="text-sm font-semibold truncate">${escape(line.name)}</p>
              <p class="text-[11px] text-white/40">
                ${escape(t('wh.fulfillPendingOf', {
    pending: Math.round((line.pending / line.package_size) * 100) / 100,
    available: Math.round((hay / line.package_size) * 100) / 100,
  }))}
              </p>
            </div>
            <input type="number" step="0.01" min="0" inputmode="decimal"
                   class="field w-24 shrink-0" value="${escape(line.amount)}"
                   data-fulfill-index="${index}">
          </div>
          ${corto ? `<p class="text-[11px] text-amber-300 mt-1">${escape(t('wh.fulfillShortLine'))}</p>` : ''}
        </article>`;
    }).join('');

    for (const input of $('fulfill-lines').querySelectorAll('[data-fulfill-index]')) {
      input.onchange = () => {
        f.lines[Number(input.dataset.fulfillIndex)].amount = input.value;
        renderFulfill();
      };
    }

    const existencias = {};
    for (const line of f.lines) existencias[line.supply_id] = stockAt(line.supply_id, f.from);
    const vista = EV2Receiving.fulfillPreview(f.request, f.lines, existencias);
    // Que el estado se pueda anticipar importa: el almacenista tiene que saber que va
    // a dejar el pedido a medias ANTES de mandarlo, para poder decírselo a la barra.
    $('fulfill-preview').textContent = vista.status_after === 'fulfilled'
      ? t('wh.fulfillWillComplete')
      : t('wh.fulfillWillPartial', { n: vista.short.length });
  }

  $('fulfill-submit').onclick = async () => {
    const f = state.fulfill;
    if (!f || state.busy) return;
    if (!f.from) { showError(new Error(t('wh.noLocations')), $('fulfill-error')); return; }
    state.busy = true;
    $('fulfill-submit').disabled = true;
    $('fulfill-error').hidden = true;
    try {
      const body = EV2Receiving.fulfillBody({ fromLocationId: f.from, draft: f.lines });
      const data = await api.post(
        `/nightclubs/${clubId()}/bar-requests/${f.request.id}/fulfill`, body);
      toast(data.short && data.short.length > 0
        ? t('wh.fulfilledPartial', { n: data.short.length })
        : t('wh.fulfilledAll'), data.short && data.short.length > 0 ? 'info' : 'ok');
      closeFulfillSheet();
      await load();
    } catch (err) {
      showError(err, $('fulfill-error'));
    } finally {
      state.busy = false;
      $('fulfill-submit').disabled = false;
    }
  };

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
