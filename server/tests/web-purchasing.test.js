/**
 * Compras y reabasto en el navegador (D114).
 *
 * La pantalla no recalcula nada de la compra: lo que se prueba es que lea bien lo
 * que manda el servidor (agrupar por proveedor, lo que no tiene costo dicho como tal,
 * el pedido en texto para el proveedor), cómo se lee una promoción en el plan, y que la
 * sección del panel REAL se pinte y hable con las rutas correctas.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..', '..', 'web');
const P = require(path.join(ROOT, 'js', 'purchasing.js'));
const Format = require(path.join(ROOT, 'js', 'format.js'));

beforeAll(() => Format.setLanguage('es'));

const fila = (over = {}) => ({
  supply_id: 's1', name: 'Tequila 1800', unit: 'ml', package_size: 750, package_label: 'Botella 750 ml',
  spent: 1500, planned_need: 0, stock: 600, min_stock: 750, to_buy: 1650, to_buy_packages: 3,
  package_cost: 420, estimated_cost: 1260, supplier: { id: 'p1', name: 'Vinos del Norte' }, ...over,
});

describe('las lecturas', () => {
  it('cantidades legibles, sin decimales de más', () => {
    expect(P.qtyLabel(1500, 'ml')).toBe('1,500 ml');
    expect(P.qtyLabel(0.5, 'ml')).toBe('0.5 ml');
    expect(P.qtyLabel(1, 'pza')).toBe('1 pza');
    expect(P.qtyLabel(24, 'pza')).toBe('24 pzas');
  });

  it('noches pasadas de la más reciente atrás; por venir de la más próxima', () => {
    const now = new Date('2026-10-15T12:00:00Z');
    const n = (id, iso, status = 'published') => ({ id, doors_open_at: iso, status });
    const lista = [
      n('a', '2026-10-09T05:00:00Z', 'finished'), n('b', '2026-10-14T05:00:00Z'),
      n('c', '2026-10-20T05:00:00Z'), n('d', '2026-10-17T05:00:00Z', 'draft'),
      n('x', '2026-10-12T05:00:00Z', 'cancelled'), n('y', '2026-10-30T05:00:00Z', 'cancelled'),
    ];
    expect(P.pastNights(lista, now).map((x) => x.id)).toEqual(['b', 'a']);
    expect(P.upcomingNights(lista, now).map((x) => x.id)).toEqual(['d', 'c']);
  });

  it('agrupa por proveedor solo lo que hay que comprar; sin proveedor al final', () => {
    const grupos = P.groupBySupplier([
      fila({ supply_id: 's3', name: 'Hielo', supplier: null, estimated_cost: null, to_buy_packages: 2 }),
      fila(),
      fila({ supply_id: 's2', name: 'Limón', estimated_cost: 90, to_buy_packages: 1 }),
      fila({ supply_id: 's4', name: 'Alcanza', to_buy_packages: 0 }),
      fila({ supply_id: 's5', name: 'Coca', supplier: { id: 'p2', name: 'Arca' }, estimated_cost: 300 }),
    ]);
    expect(grupos.map((g) => (g.supplier ? g.supplier.name : null))).toEqual(['Arca', 'Vinos del Norte', null]);
    expect(grupos[1]).toMatchObject({ estimated_cost: 1350, without_cost: 0 });
    expect(grupos[2]).toMatchObject({ estimated_cost: 0, without_cost: 1 });
  });

  it('el pedido en texto, sin precios', () => {
    const [g] = P.groupBySupplier([fila(), fila({ name: 'Hielo', unit: 'g', package_label: null, package_size: 5000, to_buy_packages: 2 })]);
    const text = P.shoppingText(g, { title: 'Pedido' });
    expect(text).toBe('Pedido — Vinos del Norte\n- 3 x Botella 750 ml · Tequila 1800\n- 2 x 5,000 g · Hielo');
    expect(text).not.toMatch(/\$|420/);
  });

  it('cómo se lee una promoción en el plan', () => {
    expect(P.promoLine({ title: 'Paloma 2x1', kind: 'n_for_m', drink_id: 'd', drink_name: 'Paloma', expected_units: 40 }))
      .toEqual({ title: 'Paloma 2x1', target: 'Paloma', kindKey: 'prm.kind.n_for_m', effect: { key: 'pur.unitsExpected', vars: { n: 40 } } });
    expect(P.promoLine({ title: 'X', kind: 'special', drink_id: 'd', drink_name: 'Paloma', expected_units: null }).effect)
      .toEqual({ key: 'pur.unitsForecast' });
    expect(P.promoLine({ title: 'X', kind: 'percent', drink_id: null, category: 'Tequila' }))
      .toMatchObject({ target: 'Tequila', effect: { key: 'pur.promoCategory' } });
  });

  it('cada texto existe en los dos idiomas', () => {
    const fuente = fs.readFileSync(path.join(ROOT, 'js', 'purchasing.js'), 'utf8')
      + fs.readFileSync(path.join(ROOT, 'manager.html'), 'utf8');
    const claves = [...new Set(fuente.match(/(pur|prm)\.[A-Za-z_]+(\.[A-Za-z_]+)*/g))]
      .filter((k) => k !== 'prm.kind');
    for (const lang of ['es', 'en']) {
      expect(claves.filter((k) => Format.STRINGS[lang][k] === undefined)).toEqual([]);
    }
  });
});

// ============================================================================
// La sección del panel real
// ============================================================================

describe('la sección en el panel del gerente', () => {
  const html = fs.readFileSync(path.join(ROOT, 'manager.html'), 'utf8');
  let dom;
  afterEach(() => dom && dom.window.close());

  const REPORT = {
    event: { id: 'n1', name: 'Viernes' }, currency: 'MXN',
    drinks: Array.from({ length: 12 }, (_, i) => ({
      rank: i + 1, drink_id: `d${i}`, name: `Trago ${i + 1}`, units: 20 - i, revenue: 100, share: 5, has_recipe: i !== 0,
    })),
    drinks_total: { units: 186, revenue: 1200, without_recipe: 1 },
    supplies_spent: [{ supply_id: 's1', name: 'Tequila 1800', unit: 'ml', sold: 1440, courtesy: 45, waste: 15,
      total: 1500, packages: 2, package_label: 'Botella 750 ml', cost: 750 }],
    supplies_spent_cost: 750,
    next_event: { id: 'n2', name: 'Sábado', history_nights: 3, promotions: 1, without_recipe: [{ name: 'Shot' }] },
    purchase: [fila(), fila({ supply_id: 's9', name: 'Hielo', supplier: null, estimated_cost: null, to_buy_packages: 2 })],
    totals: { supplies_to_buy: 2, packages_to_buy: 5, estimated_cost: 1260, without_cost: 1 },
  };
  const PLAN = {
    event: { id: 'n2' }, history: { nights_used: 3, nights_wanted: 4, nights: [] },
    promotions: [
      { id: 'pr1', drink_id: 'd1', drink_name: 'Paloma', kind: 'n_for_m', title: 'Paloma 2x1', expected_units: 40 },
      { id: 'pr2', drink_id: null, category: 'Tequila', kind: 'percent', title: '10% tequilas', expected_units: null },
    ],
    drinks: [{ drink_id: 'd1', name: 'Paloma', planned_units: 40, history_average: 10, source: 'promotion' }],
    without_recipe: [], supplies: [fila({ planned_need: 2400 })],
    totals: { supplies_to_buy: 1, packages_to_buy: 3, estimated_cost: 1260, without_cost: 0 },
  };

  function montar() {
    dom = new JSDOM(html, { url: 'https://ev2.local/manager.html' });
    const { document } = dom.window;
    global.Option = dom.window.Option;
    const calls = [];
    const api = {
      get: jest.fn(async (p) => {
        calls.push(['GET', p]);
        if (p.includes('/events?')) {
          return { events: [
            { id: 'n1', name: 'Viernes', status: 'finished', doors_open_at: '2026-10-10T05:00:00Z' },
            { id: 'n2', name: 'Sábado', status: 'published', doors_open_at: '2026-10-18T05:00:00Z' },
          ] };
        }
        if (p.includes('/purchasing')) return { report: REPORT };
        if (p.includes('/supply-plan')) return { plan: PLAN };
        throw new Error(`ruta inesperada ${p}`);
      }),
    };
    const goTab = jest.fn();
    const toast = jest.fn();
    const showError = jest.fn();
    const view = P.mount({
      document, api, clubId: () => 'club1',
      t: (k, v) => (v ? Format.tf(k, v) : Format.t(k)),
      money: (a, c) => Format.money(a, c || 'MXN'),
      toast, showError,
      getNights: () => [],
      dateTime: (iso) => iso,
      goTab,
      now: () => new Date('2026-10-15T12:00:00Z'),
    });
    return { document, api, calls, view, toast, showError, goTab };
  }

  it('pinta el reporte y el plan desde las rutas de compras', async () => {
    const m = montar();
    await m.view.load();
    const $ = (id) => m.document.getElementById(id);
    expect(m.showError).not.toHaveBeenCalled();
    expect(m.calls.map((c) => c[1])).toEqual(expect.arrayContaining([
      expect.stringMatching(/^\/nightclubs\/club1\/events\?from=2026-07-17&limit=200$/),
      '/nightclubs/club1/nights/n1/purchasing',
      '/nightclubs/club1/events/n2/supply-plan',
    ]));
    expect($('pur-k-units').textContent).toBe('186');
    expect($('pur-k-buy-note').hidden).toBe(false);
    // Solo los 10 primeros, con botón para ver los 12.
    expect($('pur-drinks').children).toHaveLength(10);
    expect($('pur-drinks').textContent).toContain('sin receta');
    $('pur-drinks-more').click();
    expect($('pur-drinks').children).toHaveLength(12);
    expect($('pur-spent').textContent).toContain('merma 15 ml');
    expect($('pur-next-norecipe').textContent).toContain('Shot');
    // Dos grupos: Vinos del Norte y Sin proveedor (al final), éste sin costo.
    const grupos = $('pur-buy').children;
    expect(grupos).toHaveLength(2);
    expect(grupos[0].textContent).toContain('Vinos del Norte');
    expect(grupos[1].textContent).toContain('Sin proveedor');
    expect(grupos[1].textContent).toContain('sin costo');
    // El plan.
    expect($('pur-plan-history').textContent).toContain('3 de 4');
    expect($('pur-promos').textContent).toContain('Paloma 2x1');
    expect($('pur-promos').textContent).toContain('esperas 40');
    expect($('pur-promos').textContent).toContain('no cambia el plan');
    expect($('pur-plan-drinks').textContent).toContain('piezas esperadas de la promoción');
  });

  it('el botón lleva a la sección Promociones', async () => {
    const m = montar();
    await m.view.load();
    m.document.getElementById('pur-go-promos').click();
    expect(m.goTab).toHaveBeenCalledWith('promos');
  });
});
