/**
 * EV2 — Compras y reabasto en el panel del gerente (D114).
 *
 * Dos partes en un archivo:
 *
 *   - Las cuentas y lecturas puras (`qtyLabel`, `groupBySupplier`, `shoppingText`,
 *     `pastNights`, `upcomingNights`, `promoLine`), que se prueban sin DOM.
 *
 * Las promociones se dan de alta en la sección Promociones (D102); aquí se enseñan
 * con lo que cambian del plan y un botón para ir a editarlas.
 *   - `mount(deps)`, que pinta la sección `#tab-purchasing` y habla con la API.
 *
 * El servidor hace TODAS las cuentas de compra (pronóstico, mínimos, presentaciones,
 * costo). Aquí no se recalcula nada: si la pantalla y el servidor llegaran a decir
 * números distintos, el gerente no sabría a cuál creerle.
 */
/* global module */
(function (root, factory) {
  'use strict';
  const lib = factory();
  if (typeof module === 'object' && module.exports) module.exports = lib;
  root.EV2Purchasing = lib;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const num = (n) => Number(n || 0);
  /** Cuántos días hacia atrás se ofrecen noches para ver su reporte. */
  const HISTORY_DAYS = 90;

  /** "1,500 ml", "24 pzas". Sin decimales de más: 0.5 se queda, 2.000 no. */
  function qtyLabel(value, unit, locale = 'es-MX') {
    const n = num(value);
    const text = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(n);
    const u = unit === 'pza' ? (n === 1 ? 'pza' : 'pzas') : (unit || '');
    return `${text} ${u}`.trim();
  }

  /** Las noches que ya abrieron (para ver su reporte), de la más reciente atrás. */
  function pastNights(nights, now = new Date()) {
    return (nights || [])
      .filter((n) => n && n.status !== 'cancelled' && n.doors_open_at
        && new Date(n.doors_open_at).getTime() <= now.getTime())
      .sort((a, b) => new Date(b.doors_open_at) - new Date(a.doors_open_at));
  }

  /** Las noches por venir que se pueden planear, de la más próxima en adelante. */
  function upcomingNights(nights, now = new Date()) {
    return (nights || [])
      .filter((n) => n && ['draft', 'published'].includes(n.status) && n.doors_open_at
        && new Date(n.doors_open_at).getTime() > now.getTime())
      .sort((a, b) => new Date(a.doors_open_at) - new Date(b.doors_open_at));
  }

  /**
   * La lista de compra agrupada por proveedor, solo lo que hay que comprar.
   * Lo que no tiene proveedor va al final, junto: es lo que hay que cotizar.
   */
  function groupBySupplier(rows) {
    const groups = new Map();
    for (const r of rows || []) {
      if (!(num(r.to_buy_packages) > 0)) continue;
      const key = r.supplier ? r.supplier.id : '';
      if (!groups.has(key)) {
        groups.set(key, { supplier: r.supplier || null, rows: [], estimated_cost: 0, without_cost: 0 });
      }
      const g = groups.get(key);
      g.rows.push(r);
      if (r.estimated_cost == null) g.without_cost += 1;
      else g.estimated_cost = Math.round((g.estimated_cost + num(r.estimated_cost)) * 100) / 100;
    }
    return [...groups.values()].sort((a, b) => {
      if (!a.supplier) return 1;
      if (!b.supplier) return -1;
      return a.supplier.name.localeCompare(b.supplier.name);
    });
  }

  /**
   * El pedido en texto, para mandarlo por WhatsApp al proveedor. Sin precios: el
   * proveedor cotiza; el costo estimado es para el gerente.
   */
  function shoppingText(group, { title = 'Pedido', noSupplier = 'Sin proveedor' } = {}) {
    const lines = [`${title} — ${group.supplier ? group.supplier.name : noSupplier}`];
    for (const r of group.rows) {
      lines.push(`- ${r.to_buy_packages} x ${r.package_label || qtyLabel(r.package_size, r.unit)} · ${r.name}`);
    }
    return lines.join('\n');
  }

  /**
   * Cómo se lee una promoción en el plan: qué es, a qué aplica y si cambia el
   * pronóstico. Devuelve claves y variables para que la pantalla las traduzca.
   */
  function promoLine(p) {
    const target = p.drink_name || p.category || '';
    let effect;
    if (!p.drink_id) effect = { key: 'pur.promoCategory' };
    else if (p.expected_units == null) effect = { key: 'pur.unitsForecast' };
    else effect = { key: 'pur.unitsExpected', vars: { n: p.expected_units } };
    return { title: p.title, target, kindKey: `prm.kind.${p.kind}`, effect };
  }

  /** Clave del texto que explica de dónde sale la cantidad planeada de un trago. */
  function sourceKey(source) {
    return { promotion: 'pur.srcPromotion', history: 'pur.srcHistory', no_history: 'pur.srcNone' }[source]
      || 'pur.srcNone';
  }

  // ======================================================================= pantalla

  function mount(deps) {
    const { api, clubId, t, money, toast, showError, getNights, dateTime } = deps;
    const doc = deps.document || document;
    const $ = (id) => doc.getElementById(id);
    const el = (tag, cls, text) => {
      const e = doc.createElement(tag);
      if (cls) e.className = cls;
      if (text !== undefined && text !== null) e.textContent = text;
      return e;
    };
    const st = { nights: null, nightId: null, nextId: '', planId: null, report: null, plan: null, showAll: false };
    const now = () => (deps.now ? deps.now() : new Date());

    function fillSelect(select, nights, selected, { auto = null } = {}) {
      select.innerHTML = '';
      if (auto) select.appendChild(new Option(auto, ''));
      for (const n of nights) {
        const o = new Option(`${n.name} · ${dateTime(n.doors_open_at)}`, n.id);
        if (n.id === selected) o.selected = true;
        select.appendChild(o);
      }
    }

    function renderSelectors() {
      const past = pastNights(nightsList(), now());
      const coming = upcomingNights(nightsList(), now());
      if (!st.nightId || !past.some((n) => n.id === st.nightId)) st.nightId = past[0] ? past[0].id : null;
      if (!st.planId || !coming.some((n) => n.id === st.planId)) st.planId = coming[0] ? coming[0].id : null;
      fillSelect($('pur-night'), past, st.nightId);
      fillSelect($('pur-next'), coming, st.nextId, { auto: t('pur.nextAuto') });
      fillSelect($('pur-plan-night'), coming, st.planId);
      $('pur-no-nights').hidden = past.length > 0;
      $('pur-report').hidden = past.length === 0;
      $('pur-no-upcoming').hidden = coming.length > 0;
      $('pur-plan-box').hidden = coming.length === 0;
    }

    // ------------------------------------------------------------ reporte

    function renderReport() {
      const r = st.report;
      const box = $('pur-report-body');
      box.hidden = !r;
      if (!r) return;
      const cur = r.currency;
      $('pur-k-units').textContent = String(r.drinks_total.units);
      $('pur-k-revenue').textContent = money(r.drinks_total.revenue, cur);
      $('pur-k-spent').textContent = money(r.supplies_spent_cost, cur);
      $('pur-k-buy').textContent = money(r.totals.estimated_cost, cur);
      $('pur-k-buy-note').hidden = !(r.totals.without_cost > 0);
      $('pur-k-buy-note').textContent = t('pur.withoutCost', { n: r.totals.without_cost });

      // Tragos
      const list = $('pur-drinks');
      list.innerHTML = '';
      $('pur-drinks-empty').hidden = r.drinks.length > 0;
      const shown = st.showAll ? r.drinks : r.drinks.slice(0, 10);
      for (const d of shown) {
        const row = el('div', 'space-y-1');
        const top = el('div', 'flex items-center justify-between gap-3 text-sm');
        const left = el('p', 'min-w-0 truncate');
        left.append(el('span', 'text-white/40 mr-2', `${d.rank}.`), doc.createTextNode(d.name));
        if (!d.has_recipe) left.appendChild(el('span', 'ml-2 text-[10px] text-amber-300', t('pur.noRecipe')));
        const right = el('p', 'shrink-0 text-right');
        right.append(el('span', 'font-display', String(d.units)),
          el('span', 'text-[11px] text-white/40 ml-2', money(d.revenue, cur)));
        top.append(left, right);
        const bar = el('div', 'h-1 rounded bg-white/10 overflow-hidden');
        const fill = el('div', 'h-1 rounded');
        fill.style.width = `${Math.min(100, d.share)}%`;
        fill.style.background = 'var(--ev2-lime)';
        bar.appendChild(fill);
        row.append(top, bar);
        list.appendChild(row);
      }
      const more = $('pur-drinks-more');
      more.hidden = r.drinks.length <= 10;
      more.textContent = st.showAll ? t('pur.showLess') : t('pur.showAll', { n: r.drinks.length });

      // Insumos gastados
      const sp = $('pur-spent');
      sp.innerHTML = '';
      $('pur-spent-empty').hidden = r.supplies_spent.length > 0;
      for (const s of r.supplies_spent) {
        const row = el('div', 'flex items-start justify-between gap-3 text-sm border-b border-white/5 pb-2');
        const left = el('div', 'min-w-0');
        left.appendChild(el('p', 'truncate', s.name));
        const detail = [t('pur.sold', { q: qtyLabel(s.sold, s.unit) })];
        if (s.courtesy > 0) detail.push(t('pur.courtesy', { q: qtyLabel(s.courtesy, s.unit) }));
        if (s.waste > 0) detail.push(t('pur.waste', { q: qtyLabel(s.waste, s.unit) }));
        left.appendChild(el('p', 'text-[11px] text-white/40', detail.join(' · ')));
        const right = el('div', 'text-right shrink-0');
        right.appendChild(el('p', 'font-display', qtyLabel(s.total, s.unit)));
        right.appendChild(el('p', 'text-[11px] text-white/40',
          `${t('pur.packages', { n: s.packages, label: s.package_label || '' })} · ${money(s.cost, cur)}`));
        row.append(left, right);
        sp.appendChild(row);
      }

      // Próxima noche
      const nx = r.next_event;
      $('pur-next-info').textContent = nx
        ? t('pur.nextInfo', { name: nx.name, nights: nx.history_nights, promos: nx.promotions })
        : t('pur.nextNone');
      const wr = $('pur-next-norecipe');
      wr.hidden = !(nx && nx.without_recipe.length > 0);
      if (nx) wr.textContent = t('pur.planNoRecipe', { list: nx.without_recipe.map((d) => d.name).join(', ') });

      // Lista de compra
      renderPurchase($('pur-buy'), $('pur-buy-empty'), r.purchase, cur);
    }

    function renderPurchase(box, empty, rows, cur) {
      box.innerHTML = '';
      const groups = groupBySupplier(rows);
      empty.hidden = groups.length > 0;
      for (const g of groups) {
        const card = el('div', 'rounded-lg border border-white/10 p-3 space-y-2');
        const head = el('div', 'flex items-center justify-between gap-2');
        head.appendChild(el('p', 'font-display text-sm', g.supplier ? g.supplier.name : t('pur.noSupplier')));
        const copy = el('button', 'text-xs underline text-white/60', t('pur.copy'));
        copy.type = 'button';
        copy.onclick = async () => {
          const text = shoppingText(g, { title: t('pur.orderTitle'), noSupplier: t('pur.noSupplier') });
          try {
            await navigator.clipboard.writeText(text);
            toast(t('pur.copied'), 'ok');
          } catch {
            toast(t('pur.copyFail'), 'error');
          }
        };
        head.appendChild(copy);
        card.appendChild(head);
        for (const r of g.rows) {
          const row = el('div', 'flex items-start justify-between gap-3 text-sm');
          const left = el('div', 'min-w-0');
          left.appendChild(el('p', 'truncate', r.name));
          const why = [];
          if (r.spent > 0) why.push(t('pur.whySpent', { q: qtyLabel(r.spent, r.unit) }));
          if (r.planned_need > 0) why.push(t('pur.whyPlan', { q: qtyLabel(r.planned_need, r.unit) }));
          if (r.min_stock > 0) why.push(t('pur.whyMin', { q: qtyLabel(r.min_stock, r.unit) }));
          why.push(t('pur.whyStock', { q: qtyLabel(r.stock, r.unit) }));
          left.appendChild(el('p', 'text-[11px] text-white/40', why.join(' · ')));
          const right = el('div', 'text-right shrink-0');
          right.appendChild(el('p', 'font-display',
            `${r.to_buy_packages} × ${r.package_label || qtyLabel(r.package_size, r.unit)}`));
          right.appendChild(el('p', 'text-[11px] text-white/40',
            r.estimated_cost == null ? t('pur.noCost') : money(r.estimated_cost, cur)));
          row.append(left, right);
          card.appendChild(row);
        }
        // El total del proveedor solo cuando hay más de un renglón: con uno repetiría
        // el mismo importe dos veces.
        if (g.rows.length > 1) {
          const sinCosto = t('pur.withoutCost', { n: g.without_cost });
          let total = money(g.estimated_cost, cur);
          if (g.without_cost === g.rows.length) total = sinCosto;
          else if (g.without_cost > 0) total = `${total} + ${sinCosto}`;
          card.appendChild(el('p', 'text-xs font-display text-right border-t border-white/5 pt-2', total));
        }
        box.appendChild(card);
      }
    }

    async function loadReport() {
      if (!st.nightId) { st.report = null; renderReport(); return; }
      const q = st.nextId ? `?next_event_id=${encodeURIComponent(st.nextId)}` : '';
      try {
        const d = await api.get(`/nightclubs/${clubId()}/nights/${st.nightId}/purchasing${q}`);
        st.report = d.report;
      } catch (err) {
        st.report = null;
        showError(err);
      }
      renderReport();
    }

    // ------------------------------------------------------------ plan

    function renderPlan() {
      const p = st.plan;
      $('pur-plan-body').hidden = !p;
      if (!p) return;
      $('pur-plan-history').textContent = p.history.nights_used === 0
        ? t('pur.historyNone')
        : t('pur.historyUsed', { n: p.history.nights_used, of: p.history.nights_wanted });

      // Promociones: solo lectura; se editan en su sección.
      const pl = $('pur-promos');
      pl.innerHTML = '';
      $('pur-promos-empty').hidden = p.promotions.length > 0;
      for (const pr of p.promotions) {
        const line = promoLine(pr);
        const row = el('div', 'text-sm border-b border-white/5 pb-2');
        row.appendChild(el('p', 'truncate', `${line.title} · ${line.target}`));
        row.appendChild(el('p', 'text-[11px] text-white/40',
          `${t(line.kindKey)} · ${t(line.effect.key, line.effect.vars)}`));
        pl.appendChild(row);
      }

      // Tragos planeados
      const dl = $('pur-plan-drinks');
      dl.innerHTML = '';
      $('pur-plan-drinks-empty').hidden = p.drinks.length > 0;
      for (const d of p.drinks) {
        const row = el('div', 'flex items-center justify-between gap-3 text-sm');
        const left = el('div', 'min-w-0');
        left.appendChild(el('p', 'truncate', d.name || '—'));
        left.appendChild(el('p', 'text-[11px] text-white/40',
          t(sourceKey(d.source), { avg: d.history_average })));
        row.append(left, el('p', 'font-display shrink-0', String(d.planned_units)));
        dl.appendChild(row);
      }
      const nr = $('pur-plan-norecipe');
      nr.hidden = p.without_recipe.length === 0;
      nr.textContent = t('pur.planNoRecipe', { list: p.without_recipe.map((d) => d.name).join(', ') });

      renderPurchase($('pur-plan-buy'), $('pur-plan-buy-empty'), p.supplies);
      $('pur-plan-total').textContent = p.totals.without_cost > 0
        ? `${money(p.totals.estimated_cost)} + ${t('pur.withoutCost', { n: p.totals.without_cost })}`
        : money(p.totals.estimated_cost);
    }

    async function loadPlan() {
      if (!st.planId) { st.plan = null; renderPlan(); return; }
      try {
        const d = await api.get(`/nightclubs/${clubId()}/events/${st.planId}/supply-plan`);
        st.plan = d.plan;
      } catch (err) {
        st.plan = null;
        showError(err);
      }
      renderPlan();
    }

    // ------------------------------------------------------------ eventos

    $('pur-night').onchange = (e) => { st.nightId = e.target.value; st.showAll = false; loadReport(); };
    $('pur-next').onchange = (e) => { st.nextId = e.target.value; loadReport(); };
    $('pur-plan-night').onchange = (e) => { st.planId = e.target.value; loadPlan(); };
    $('pur-drinks-more').onclick = () => { st.showAll = !st.showAll; renderReport(); };
    $('pur-go-promos').onclick = () => { if (deps.goTab) deps.goTab('promos'); };

    // Las noches se piden aquí y no se toman del panel: la lista del panel viene de
    // la más vieja a la más nueva con un tope, y con meses de operación las noches
    // recientes —justo las que importan aquí— se quedarían fuera.
    async function loadNights() {
      const from = new Date(now().getTime() - HISTORY_DAYS * 86_400_000).toISOString().slice(0, 10);
      try {
        const d = await api.get(`/nightclubs/${clubId()}/events?from=${from}&limit=200`);
        st.nights = d.events || [];
      } catch (err) {
        st.nights = null;
        showError(err);
      }
    }
    const nightsList = () => st.nights || getNights() || [];

    return {
      async load() {
        await loadNights();
        renderSelectors();
        await Promise.all([loadReport(), loadPlan()]);
      },
      state: st,
    };
  }

  return {
    qtyLabel, pastNights, upcomingNights, groupBySupplier, shoppingText, promoLine, sourceKey, mount,
  };
}));
