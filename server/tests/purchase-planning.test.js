/**
 * Compras y reabasto (D114).
 *
 * Lo que se prueba son los errores que harían comprar mal, y ninguno revienta:
 *
 *   1. El ranking cuenta lo ENTREGADO: un pedido cancelado no es venta.
 *   2. Lo gastado sale del kardex: lo vendido neto de devoluciones, más cortesía y
 *      merma. Lo que regresó al estante no se vuelve a comprar.
 *   3. La compra es máx(gastado, plan de la próxima noche) + mínimo − existencia, en
 *      presentaciones completas, y el insumo que ya estaba bajo mínimo también entra.
 *   4. El pronóstico promedia las últimas 4 noches CERRADAS del mismo día de la
 *      semana, dividiendo entre todas (no solo las que vendieron ese trago).
 *   5. Una promoción (D102) con unidades esperadas reemplaza al pronóstico; sin
 *      unidades, no inventa nada. El trago especial no cambia el cobro.
 *   6. Un trago sin receta se dice aparte, no se suma en cero.
 */
'use strict';

const { setupSchema, truncateAll, closePool, pool } = require('./helpers/db');
const { api, auth } = require('./helpers/api');
const f = require('./helpers/factories');
const planning = require('../src/services/purchase-planning');

let club;
let other;
let manager;
let admin;
let waiter;
let guest;
let mesa;

beforeAll(async () => {
  await setupSchema();
});
beforeEach(async () => {
  await truncateAll();
  club = await f.createNightclub({ slug: 'ev2-purchasing' });
  other = await f.createNightclub({ slug: 'ev2-other', locations: false });
  manager = await f.createUser(club.id, { role: 'manager' });
  admin = await f.createUser(club.id, { role: 'admin' });
  waiter = await f.createUser(club.id, { role: 'waiter' });
  guest = await f.createUser(club.id, { role: 'guest' });
  mesa = await f.createTable(club.id, { code: '10', section: 'ZONA ROJA', capacity: 8 });
});
afterAll(closePool);

const url = (p) => `/api/nightclubs/${club.id}${p}`;

/** Una noche en una fecha concreta: abre a las 22:00 y cierra a las 05:00. */
async function noche(fecha, { status = 'published', cerrada = false, nightclubId = club.id } = {}) {
  const { rows } = await pool.query(
    `INSERT INTO events_calendar (nightclub_id, name, event_date, doors_open_at, closes_at, status)
     VALUES ($1, $2, $3::date, $3::date + interval '22 hours', $3::date + interval '29 hours', $4)
     RETURNING id, event_date, doors_open_at`,
    [nightclubId, `Noche ${fecha}`, fecha, status]);
  if (cerrada) {
    await pool.query(
      `INSERT INTO night_closings (nightclub_id, event_id, event_date, closed_by)
       VALUES ($1,$2,$3::date,$4)`, [nightclubId, rows[0].id, fecha, manager.id]);
  }
  return rows[0];
}

/** Un pedido dentro de la noche (una hora después de abrir). */
async function vender(evento, drink, quantity, { status = 'delivered', price = 100, lineTotal = null } = {}) {
  const { rows } = await pool.query(
    `INSERT INTO drink_orders (nightclub_id, sender_id, table_id, status, subtotal, currency,
                               client_request_id, created_at)
     VALUES ($1,$2,$3,$4,$5,'MXN',gen_random_uuid(),$6::timestamptz + interval '1 hour')
     RETURNING id`,
    [club.id, guest.id, mesa.id, status, price * quantity, evento.doors_open_at]);
  await pool.query(
    'INSERT INTO drink_order_items (order_id, drink_id, quantity, unit_price, line_total) VALUES ($1,$2,$3,$4,$5)',
    [rows[0].id, drink.id, quantity, price, lineTotal]);
  return rows[0].id;
}

/** Un renglón de kardex dentro de la noche, como lo deja el punto de venta. */
async function kardex(evento, supply, kind, quantity) {
  await pool.query(
    `INSERT INTO supply_movements (nightclub_id, supply_id, location_id, kind, quantity,
                                   balance_after, created_at)
     VALUES ($1,$2,$3,$4,$5,0,$6::timestamptz + interval '2 hours')`,
    [club.id, supply.id, club.bar_id, kind, quantity, evento.doors_open_at]);
}

async function existencia(supply, { location = club.bar_id, stock = 0, min = 0 } = {}) {
  await pool.query(
    `INSERT INTO supply_stock (supply_id, location_id, stock, min_stock) VALUES ($1,$2,$3,$4)
     ON CONFLICT (supply_id, location_id) DO UPDATE SET stock = EXCLUDED.stock, min_stock = EXCLUDED.min_stock`,
    [supply.id, location, stock, min]);
}

async function proveedor(supply, lastCost, name = 'Vinos del Norte') {
  const { rows } = await pool.query(
    'INSERT INTO suppliers (nightclub_id, name) VALUES ($1,$2) RETURNING id', [club.id, name]);
  await pool.query(
    `INSERT INTO supply_suppliers (supply_id, supplier_id, last_cost, last_bought_at)
     VALUES ($1,$2,$3,now())`, [supply.id, rows[0].id, lastCost]);
  return rows[0].id;
}

const tequila = () => f.createSupply(club.id, {
  name: 'Tequila 1800', unit: 'ml', package_size: 750, package_label: 'Botella 750 ml', avg_cost: 0.5,
});
const trago = (name) => f.createDrink(club.id, { name, stock: null, price: 150, category: 'Tequila' });

// ============================================================================
// El ranking de la noche
// ============================================================================

describe('los tragos más vendidos de la noche', () => {
  it('ordena por unidades, cuenta solo lo entregado y da el porcentaje', async () => {
    const n = await noche('2026-10-09');
    const paloma = await trago('Paloma');
    const margarita = await trago('Margarita');
    await vender(n, paloma, 6);
    // Con un 2x1 (D102) el importe es el line_total, no cantidad x precio.
    await vender(n, paloma, 2, { lineTotal: 100 });
    await vender(n, margarita, 2);
    await vender(n, margarita, 10, { status: 'cancelled' });
    // Fuera de la ventana de la noche: no cuenta.
    await pool.query(
      `INSERT INTO drink_orders (nightclub_id, sender_id, status, subtotal, currency, client_request_id, created_at)
       VALUES ($1,$2,'delivered',0,'MXN',gen_random_uuid(), $3::timestamptz - interval '3 hours')`,
      [club.id, guest.id, n.doors_open_at]);

    const res = await api().get(url(`/nights/${n.id}/purchasing`)).set(auth(manager));
    expect(res.status).toBe(200);
    const { drinks, drinks_total: total } = res.body.report;
    expect(drinks.map((d) => [d.rank, d.name, d.units])).toEqual([[1, 'Paloma', 8], [2, 'Margarita', 2]]);
    expect(drinks[0]).toMatchObject({ revenue: 700, share: 80, has_recipe: false });
    expect(total).toMatchObject({ units: 10, revenue: 900, without_recipe: 2 });
  });

  it('solo gerencia lo ve, y solo de su club', async () => {
    const n = await noche('2026-10-09');
    expect((await api().get(url(`/nights/${n.id}/purchasing`)).set(auth(waiter))).status).toBe(403);
    expect((await api().get(url(`/nights/${n.id}/purchasing`)).set(auth(guest))).status).toBe(403);
    expect((await api().get(url(`/nights/${n.id}/purchasing`)).set(auth(admin))).status).toBe(200);
    const ajena = await noche('2026-10-09', { nightclubId: other.id });
    expect((await api().get(url(`/nights/${ajena.id}/purchasing`)).set(auth(manager))).status).toBe(404);
  });
});

// ============================================================================
// Lo gastado y la lista de compra
// ============================================================================

describe('los insumos gastados y lo que hay que comprar', () => {
  it('lo gastado es lo vendido neto más cortesía y merma', async () => {
    const n = await noche('2026-10-09');
    const t = await tequila();
    await kardex(n, t, 'consumption', -1500);
    await kardex(n, t, 'return', 60); // un pedido cancelado regresó dos tragos
    await kardex(n, t, 'courtesy', -45);
    await kardex(n, t, 'waste', -15);
    await kardex(n, t, 'receipt', 7500); // una entrada no es gasto

    const { report } = (await api().get(url(`/nights/${n.id}/purchasing`)).set(auth(manager))).body;
    expect(report.supplies_spent).toEqual([expect.objectContaining({
      name: 'Tequila 1800', sold: 1440, courtesy: 45, waste: 15, total: 1500, packages: 2, cost: 750,
    })]);
    expect(report.supplies_spent_cost).toBe(750);
  });

  it('compra lo gastado más el mínimo menos lo que hay, en botellas completas', async () => {
    const n = await noche('2026-10-09');
    const t = await tequila();
    await kardex(n, t, 'consumption', -1500);
    await existencia(t, { stock: 600, min: 750 });
    await proveedor(t, 420);

    const { report } = (await api().get(url(`/nights/${n.id}/purchasing`)).set(auth(manager))).body;
    // 1500 + 750 - 600 = 1650 ml → 3 botellas de 750, a $420 la botella.
    expect(report.purchase).toEqual([expect.objectContaining({
      spent: 1500, planned_need: 0, stock: 600, min_stock: 750, to_buy: 1650,
      to_buy_packages: 3, package_cost: 420, cost_source: 'supplier', estimated_cost: 1260,
      supplier: expect.objectContaining({ name: 'Vinos del Norte' }),
    })]);
    expect(report.totals).toEqual({ supplies_to_buy: 1, packages_to_buy: 3, estimated_cost: 1260, without_cost: 0 });
  });

  it('suma la existencia de todos los lugares y no compra lo que ya alcanza', async () => {
    const n = await noche('2026-10-09');
    const t = await tequila();
    await kardex(n, t, 'consumption', -750);
    await existencia(t, { stock: 300, min: 300 });
    await existencia(t, { location: club.warehouse_id, stock: 1500, min: 0 });

    const { report } = (await api().get(url(`/nights/${n.id}/purchasing`)).set(auth(manager))).body;
    // 750 + 300 - 1800 < 0: no hay que comprar.
    expect(report.purchase[0]).toMatchObject({ stock: 1800, to_buy: 0, to_buy_packages: 0, estimated_cost: 0 });
    expect(report.totals.supplies_to_buy).toBe(0);
  });

  it('sin proveedor usa el costo promedio; sin ninguno, lo dice', async () => {
    const n = await noche('2026-10-09');
    const t = await tequila(); // avg_cost 0.5 por ml
    const hielo = await f.createSupply(club.id, { name: 'Hielo', unit: 'g', package_size: 5000, avg_cost: 0 });
    await kardex(n, t, 'consumption', -750);
    await kardex(n, hielo, 'consumption', -6000);

    const { report } = (await api().get(url(`/nights/${n.id}/purchasing`)).set(auth(manager))).body;
    const byName = Object.fromEntries(report.purchase.map((r) => [r.name, r]));
    expect(byName['Tequila 1800']).toMatchObject({ package_cost: 375, cost_source: 'average', estimated_cost: 375 });
    expect(byName.Hielo).toMatchObject({ to_buy_packages: 2, package_cost: null, estimated_cost: null });
    expect(report.totals).toMatchObject({ supplies_to_buy: 2, estimated_cost: 375, without_cost: 1 });
  });

  it('el insumo bajo mínimo entra aunque esa noche no se haya gastado', async () => {
    const n = await noche('2026-10-09');
    const limon = await f.createSupply(club.id, { name: 'Limón', unit: 'pza', package_size: 100 });
    await existencia(limon, { stock: 20, min: 150 });
    const baja = await f.createSupply(club.id, { name: 'Dado de baja', unit: 'pza', package_size: 1 });
    await existencia(baja, { stock: 0, min: 10 });
    await pool.query('UPDATE supplies SET active = false WHERE id = $1', [baja.id]);

    const { report } = (await api().get(url(`/nights/${n.id}/purchasing`)).set(auth(manager))).body;
    expect(report.purchase.map((r) => [r.name, r.to_buy_packages])).toEqual([['Limón', 2]]);
  });

  it('presentaciones exactas no redondean de más', () => {
    expect(planning.packagesFor(1500, 750)).toBe(2);
    expect(planning.packagesFor(1500.0004, 750)).toBe(2);
    expect(planning.packagesFor(1501, 750)).toBe(3);
    expect(planning.packagesFor(0, 750)).toBe(0);
  });
});

// ============================================================================
// El pronóstico y las promociones
// ============================================================================

describe('el plan de la próxima noche', () => {
  // Viernes 6 de noviembre de 2026; su historial son los viernes anteriores.
  const VIERNES = '2026-11-06';

  async function historial(drink, unidades) {
    const fechas = ['2026-10-30', '2026-10-23', '2026-10-16', '2026-10-09', '2026-10-02'];
    for (let i = 0; i < unidades.length; i += 1) {
      const n = await noche(fechas[i], { status: 'finished', cerrada: true });
      if (unidades[i] > 0) await vender(n, drink, unidades[i]);
    }
  }

  it('promedia las últimas 4 noches cerradas del mismo día, entre todas', async () => {
    const paloma = await trago('Paloma');
    const t = await tequila();
    await f.setRecipe(paloma.id, [[t, 60]]);
    // 5 viernes: el más viejo (40) queda fuera. (10 + 0 + 7 + 4) / 4 = 5.25 → 6.
    await historial(paloma, [10, 0, 7, 4, 40]);
    // Un sábado que vendió mucho no cuenta para el viernes, ni una noche sin cerrar.
    const sabado = await noche('2026-10-31', { status: 'finished', cerrada: true });
    await vender(sabado, paloma, 50);
    const sinCerrar = await noche('2026-10-26', { status: 'finished' });
    await vender(sinCerrar, paloma, 50);
    const objetivo = await noche(VIERNES);

    const res = await api().get(url(`/events/${objetivo.id}/supply-plan`)).set(auth(manager));
    expect(res.status).toBe(200);
    const { plan } = res.body;
    expect(plan.history).toMatchObject({ nights_used: 4, nights_wanted: 4 });
    expect(plan.drinks).toEqual([expect.objectContaining({
      name: 'Paloma', history_average: 5.3, forecast_units: 6, planned_units: 6, source: 'history',
    })]);
    // 6 tragos x 60 ml = 360 ml → 1 botella.
    expect(plan.supplies[0]).toMatchObject({ planned_need: 360, to_buy_packages: 1 });
  });

  it('con menos historial dice cuántas noches usó; sin historial, cero', async () => {
    const paloma = await trago('Paloma');
    await historial(paloma, [8]);
    const objetivo = await noche(VIERNES);
    let { plan } = (await api().get(url(`/events/${objetivo.id}/supply-plan`)).set(auth(manager))).body;
    expect(plan.history.nights_used).toBe(1);
    expect(plan.drinks[0]).toMatchObject({ planned_units: 8 });

    const jueves = await noche('2026-11-05');
    ({ plan } = (await api().get(url(`/events/${jueves.id}/supply-plan`)).set(auth(manager))).body);
    expect(plan.history.nights_used).toBe(0);
    expect(plan.drinks).toEqual([]);
    expect(plan.supplies).toEqual([]);
  });

  it('la promoción con unidades reemplaza al pronóstico; sin unidades no inventa', async () => {
    const paloma = await trago('Paloma');
    const mezcal = await trago('Mezcal 2x1');
    const especial = await trago('Carajillo');
    const t = await tequila();
    await f.setRecipe(paloma.id, [[t, 60]]);
    await f.setRecipe(mezcal.id, [[t, 90]]);
    await historial(paloma, [10, 10, 10, 10]);
    const objetivo = await noche(VIERNES);

    const post = (body) => api().post(url(`/events/${objetivo.id}/promotions`)).set(auth(manager)).send(body);
    expect((await post({ drink_id: paloma.id, kind: 'n_for_m', buy_qty: 2, pay_qty: 1, name: 'Paloma 2x1', expected_units: 40 })).status).toBe(201);
    expect((await post({ drink_id: mezcal.id, kind: 'fixed_price', value: 60, name: 'Mezcal de la casa', expected_units: 20 })).status).toBe(201);
    expect((await post({ drink_id: especial.id, kind: 'special', name: 'Trago de la noche' })).status).toBe(201);
    // Una de categoría se enseña, pero no cambia el plan.
    expect((await post({ category: 'Tequila', kind: 'percent', value: 10, name: '10% tequilas' })).status).toBe(201);
    // Una apagada no cuenta.
    const apagada = await post({ drink_id: paloma.id, kind: 'fixed_price', value: 50, name: 'Vieja', expected_units: 999 });
    await api().patch(url(`/promotions/${apagada.body.promotion.id}`)).set(auth(manager)).send({ active: false });

    const { plan } = (await api().get(url(`/events/${objetivo.id}/supply-plan`)).set(auth(manager))).body;
    expect(plan.promotions.map((p) => p.title)).toEqual(['Paloma 2x1', 'Mezcal de la casa', 'Trago de la noche', '10% tequilas']);
    const byName = Object.fromEntries(plan.drinks.map((d) => [d.name, d]));
    expect(byName.Paloma).toMatchObject({ forecast_units: 10, planned_units: 40, source: 'promotion' });
    expect(byName['Mezcal 2x1']).toMatchObject({ forecast_units: 0, planned_units: 20, source: 'promotion' });
    // Sin cantidad y sin historial: aparece con su promoción, pero en cero.
    expect(byName.Carajillo).toMatchObject({ planned_units: 0, source: 'no_history' });
    expect(byName.Carajillo.promotion).toMatchObject({ kind: 'special', expected_units: null });
    // 40 x 60 + 20 x 90 = 4200 ml → 6 botellas.
    expect(plan.supplies[0]).toMatchObject({ planned_need: 4200, to_buy_packages: 6 });
    expect(plan.without_recipe).toEqual([]);
  });

  it('un trago sin receta se dice aparte', async () => {
    const shot = await trago('Shot sin receta');
    await historial(shot, [3, 3, 3, 3]);
    const objetivo = await noche(VIERNES);
    const { plan } = (await api().get(url(`/events/${objetivo.id}/supply-plan`)).set(auth(manager))).body;
    expect(plan.without_recipe).toEqual([expect.objectContaining({ name: 'Shot sin receta', planned_units: 3 })]);
    expect(plan.supplies).toEqual([]);
  });

  it('la lista de compra de una noche cubre lo que pide la próxima', async () => {
    const paloma = await trago('Paloma');
    const t = await tequila();
    await f.setRecipe(paloma.id, [[t, 60]]);
    const pasada = await noche('2026-10-30', { status: 'finished', cerrada: true });
    await vender(pasada, paloma, 10);
    await kardex(pasada, t, 'consumption', -600);
    const proxima = await noche(VIERNES);
    const creada = await api().post(url(`/events/${proxima.id}/promotions`)).set(auth(manager))
      .send({ drink_id: paloma.id, kind: 'n_for_m', buy_qty: 2, pay_qty: 1, name: 'Paloma 2x1', expected_units: 50 });
    expect(creada.status).toBe(201);

    const res = await api().get(url(`/nights/${pasada.id}/purchasing?next_event_id=${proxima.id}`)).set(auth(manager));
    expect(res.status).toBe(200);
    const { report } = res.body;
    expect(report.next_event).toMatchObject({ id: proxima.id, promotions: 1, history_nights: 1 });
    // máx(600 gastados, 50 x 60 = 3000 del plan) + 0 − 0 = 3000 → 4 botellas.
    expect(report.purchase[0]).toMatchObject({ spent: 600, planned_need: 3000, to_buy: 3000, to_buy_packages: 4 });

    // Sin escoger, toma la siguiente noche del calendario que aún no abre.
    const auto = await planning.nightReport({
      nightclubId: club.id, eventId: pasada.id, now: new Date('2026-10-31T12:00:00Z'),
    });
    expect(auto.next_event.id).toBe(proxima.id);
    const misma = await api().get(url(`/nights/${pasada.id}/purchasing?next_event_id=${pasada.id}`)).set(auth(manager));
    expect(misma.status).toBe(400);
  });
});

// ============================================================================
// Las promociones (D102) con unidades esperadas y trago especial
// ============================================================================

describe('unidades esperadas y trago especial en las promociones', () => {
  let evento;
  let paloma;
  const base = () => url(`/events/${evento.id}/promotions`);
  const promotions = require('../src/services/promotions');

  beforeEach(async () => {
    evento = await noche('2026-11-06');
    paloma = await trago('Paloma');
  });

  it('el trago especial se guarda sin precio y no cambia el cobro', async () => {
    const res = await api().post(base()).set(auth(manager))
      .send({ drink_id: paloma.id, kind: 'special', name: 'Trago de la noche', value: 10, expected_units: 30 });
    expect(res.status).toBe(201);
    expect(res.body.promotion).toMatchObject({ kind: 'special', value: null, buy_qty: null, expected_units: 30 });

    const p = { ...res.body.promotion, value: null };
    expect(promotions.totalCents(150, 3, p)).toBe(45000);
    expect(promotions.bestPromo(150, 3, [p])).toBeNull();
    expect(promotions.summary({ price: 150 }, [p])).toBeNull();
    const [linea] = promotions.priceLines([{ drink_id: paloma.id, quantity: 2 }],
      new Map([[paloma.id, { ...paloma, price: 150 }]]), () => [p]);
    expect(linea).toMatchObject({ promoId: null, totalCents: 30000 });
    expect(promotions.badge(p)).toBe('★');
  });

  it('especial y piezas esperadas solo en una bebida', async () => {
    const post = (body) => api().post(base()).set(auth(manager)).send(body);
    expect((await post({ category: 'Tequila', kind: 'special', name: 'X' })).status).toBe(422);
    expect((await post({ category: 'Tequila', kind: 'percent', value: 10, name: 'X', expected_units: 5 })).status).toBe(422);
    expect((await post({ drink_id: paloma.id, kind: 'percent', value: 10, name: 'X', expected_units: 0 })).status).toBe(400);
    expect((await post({ drink_id: paloma.id, kind: 'percent', value: 10, name: 'X', expected_units: 2.5 })).status).toBe(400);
  });

  it('se editan las piezas esperadas y el cambio a especial borra el precio', async () => {
    const creada = await api().post(base()).set(auth(manager))
      .send({ drink_id: paloma.id, kind: 'fixed_price', value: 90, name: 'Paloma a 90', expected_units: 40 });
    const id = creada.body.promotion.id;
    let res = await api().patch(url(`/promotions/${id}`)).set(auth(manager)).send({ expected_units: null });
    expect(res.status).toBe(200);
    expect(res.body.promotion.expected_units).toBeNull();
    res = await api().patch(url(`/promotions/${id}`)).set(auth(manager)).send({ kind: 'special' });
    expect(res.body.promotion).toMatchObject({ kind: 'special', value: null });
    // Pasarla a categoría con piezas esperadas no se deja.
    await api().patch(url(`/promotions/${id}`)).set(auth(manager)).send({ kind: 'percent', value: 5, expected_units: 10 });
    res = await api().patch(url(`/promotions/${id}`)).set(auth(manager)).send({ category: 'Tequila', drink_id: undefined });
    expect(res.status).toBe(200);
    expect(res.body.promotion).toMatchObject({ category: 'Tequila', expected_units: null });
  });

  it('la base no acepta un especial con precio ni piezas esperadas de categoría', async () => {
    await expect(pool.query(
      `INSERT INTO event_promotions (nightclub_id, event_id, name, kind, drink_id, value)
       VALUES ($1,$2,'X','special',$3,10)`, [club.id, evento.id, paloma.id])).rejects.toThrow(/event_promotions_shape/);
    await expect(pool.query(
      `INSERT INTO event_promotions (nightclub_id, event_id, name, kind, category, value, expected_units)
       VALUES ($1,$2,'X','percent','Tequila',10,5)`, [club.id, evento.id])).rejects.toThrow(/expected_units_valid/);
  });
});
