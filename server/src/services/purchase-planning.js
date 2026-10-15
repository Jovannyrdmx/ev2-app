/**
 * Compras y reabasto (D114).
 *
 * Tres preguntas que el gerente y el administrador se hacen al día siguiente de
 * cada noche, y antes de la próxima:
 *
 *   1. ¿Qué tragos se vendieron más? — `topDrinks`.
 *   2. ¿Cuánto insumo se gastó? — `suppliesSpent`, sacado del KARDEX y no de las
 *      recetas: el kardex dice lo que de verdad bajó del estante, incluidas las
 *      sustituciones (D84), las cortesías y la merma.
 *   3. ¿Cuánto hay que comprar? — `purchaseList` para reponer lo de una noche, y
 *      `supplyPlan` para cubrir la próxima, con sus promociones.
 *
 * ---------------------------------------------------------------------------
 * Las reglas del club (decididas por Jovanny el 2026-10-15)
 * ---------------------------------------------------------------------------
 * - **Pronóstico:** promedio por trago de las últimas 4 noches CERRADAS del mismo
 *   día de la semana. Si hay menos, se usan las que haya y se dice cuántas; si no
 *   hay ninguna, el pronóstico es 0 y se marca "sin historial". Nunca se inventa
 *   una cifra. El promedio se redondea hacia ARRIBA: medio trago no se vende, y
 *   quedarse corto la noche de la fiesta cuesta más que una botella de sobra.
 * - **Promoción o trago especial:** las de `event_promotions` (D102), activas, de esa
 *   noche. Si una promoción de UNA bebida trae `expected_units`, ese número REEMPLAZA
 *   al pronóstico de esa bebida; si no, se usa el pronóstico. Las de categoría se
 *   enseñan pero no cambian el plan: no se sabe a qué bebida repartirlas.
 * - **Compra:** lo mayor entre lo que se gastó y lo que pide el próximo evento, más
 *   el mínimo de todas las barras y del almacén, menos lo que ya hay en el club. En
 *   presentaciones completas: nadie compra media botella.
 * - **Venta:** con promoción, el importe de un renglón es su `line_total`.
 *
 * ---------------------------------------------------------------------------
 * Lo que NO se calcula, y se dice
 * ---------------------------------------------------------------------------
 * Un trago sin receta no tiene insumos. Sale en el ranking, pero en el plan va
 * aparte en `without_recipe` para que se capture su receta: sumarlo en cero haría
 * creer que no necesita nada.
 */
'use strict';

const { pool } = require('../db/pool');
const { ApiError } = require('../middleware/errors');
const { loadNight } = require('./night-stats');

/** Cuántas noches del mismo día de la semana entran al promedio. */
const HISTORY_NIGHTS = 4;

const money = (n) => Math.round(Number(n || 0) * 100) / 100;
/** Cantidades de insumo: tres decimales, como la columna. */
const qty = (n) => Math.round(Number(n || 0) * 1000) / 1000;

/** Presentaciones completas que cubren una cantidad. Cero se queda en cero. */
function packagesFor(quantity, packageSize) {
  if (!(quantity > 0) || !(packageSize > 0)) return 0;
  // Se resta una milésima antes de redondear: 1500 ml en botellas de 750 son 2, no 3
  // por un error de punto flotante.
  return Math.ceil(qty(quantity) / packageSize - 1e-9);
}

// ======================================================================= la noche

/**
 * Los tragos de la noche, del más vendido al menos.
 *
 * Solo pedidos ENTREGADOS, igual que el corte (`night-stats.bar`), y el importe con
 * promoción es el `line_total` del renglón (D102). Uno cancelado o
 * que se quedó en preparación no es venta, y si este ranking no cuadra con el corte
 * nadie le cree a ninguno de los dos.
 */
async function topDrinks({ nightclubId, from, to, runner = pool }) {
  const { rows } = await runner.query(
    `SELECT d.id AS drink_id, d.name, d.category,
            sum(i.quantity)::int AS units,
            sum(COALESCE(i.line_total, i.quantity * i.unit_price))::float8 AS revenue,
            EXISTS (SELECT 1 FROM drink_supplies ds WHERE ds.drink_id = d.id) AS has_recipe
       FROM drink_order_items i
       JOIN drink_orders o ON o.id = i.order_id
       JOIN drinks d ON d.id = i.drink_id
      WHERE o.nightclub_id = $1 AND o.created_at >= $2 AND o.created_at < $3
        AND o.status = 'delivered'
      GROUP BY d.id, d.name, d.category
      ORDER BY units DESC, revenue DESC, d.name`,
    [nightclubId, from, to],
  );
  const totalUnits = rows.reduce((n, r) => n + r.units, 0);
  return rows.map((r, i) => ({
    rank: i + 1,
    drink_id: r.drink_id,
    name: r.name,
    category: r.category,
    units: r.units,
    revenue: money(r.revenue),
    share: totalUnits > 0 ? Math.round((r.units / totalUnits) * 1000) / 10 : 0,
    has_recipe: r.has_recipe,
  }));
}

/**
 * Lo que salió de los estantes en la ventana de la noche, por insumo.
 *
 * `sold` es lo vendido neto: lo que bajó por pedidos menos lo que regresó por
 * pedidos cancelados. Cortesía y merma van aparte porque se explican distinto, pero
 * las tres salieron del estante y las tres hay que reponerlas.
 */
async function suppliesSpent({ nightclubId, from, to, runner = pool }) {
  const { rows } = await runner.query(
    `SELECT s.id AS supply_id, s.name, s.category, s.unit,
            s.package_size::float8 AS package_size, s.package_label,
            s.avg_cost::float8 AS avg_cost,
            COALESCE(-sum(m.quantity) FILTER (WHERE m.kind IN ('consumption', 'return')), 0)::float8 AS sold,
            COALESCE(-sum(m.quantity) FILTER (WHERE m.kind = 'courtesy'), 0)::float8 AS courtesy,
            COALESCE(-sum(m.quantity) FILTER (WHERE m.kind = 'waste'), 0)::float8 AS waste
       FROM supply_movements m
       JOIN supplies s ON s.id = m.supply_id
      WHERE m.nightclub_id = $1 AND m.created_at >= $2 AND m.created_at < $3
        AND m.kind IN ('consumption', 'return', 'courtesy', 'waste')
      GROUP BY s.id, s.name, s.category, s.unit, s.package_size, s.package_label, s.avg_cost
      ORDER BY s.name`,
    [nightclubId, from, to],
  );
  return rows
    .map((r) => {
      const sold = Math.max(qty(r.sold), 0);
      const courtesy = Math.max(qty(r.courtesy), 0);
      const waste = Math.max(qty(r.waste), 0);
      const total = qty(sold + courtesy + waste);
      return {
        supply_id: r.supply_id,
        name: r.name,
        category: r.category,
        unit: r.unit,
        package_size: r.package_size,
        package_label: r.package_label,
        sold,
        courtesy,
        waste,
        total,
        // En presentaciones, con decimales: "3.5 botellas" es lo que se puede
        // comprobar mirando el estante.
        packages: Math.round((total / r.package_size) * 100) / 100,
        cost: money(total * r.avg_cost),
      };
    })
    .filter((r) => r.total > 0);
}

// ================================================================== el pronóstico

/** La noche a planear, con su día de la semana. */
async function loadEvent({ nightclubId, eventId, runner = pool }) {
  const { rows } = await runner.query(
    `SELECT id, name, event_date, doors_open_at, closes_at, status
       FROM events_calendar WHERE id = $1 AND nightclub_id = $2`,
    [eventId, nightclubId],
  );
  if (rows.length === 0) throw ApiError.notFound('Esa noche no existe');
  return rows[0];
}

/**
 * Las noches cerradas que sirven de historial: mismo día de la semana, anteriores a
 * la noche a planear, de la más reciente hacia atrás.
 *
 * Solo CERRADAS: una noche sin corte puede estar a medias o haberse quedado sin
 * cerrar, y meterla al promedio lo jala hacia abajo sin que nadie lo note.
 */
async function historyNights({ nightclubId, event, runner = pool }) {
  const { rows } = await runner.query(
    `SELECT e.id, e.name, e.event_date, e.doors_open_at,
            COALESCE(e.closes_at, e.doors_open_at + interval '12 hours') AS window_end
       FROM night_closings c
       JOIN events_calendar e ON e.id = c.event_id
       JOIN events_calendar t ON t.id = $2::uuid
      WHERE c.nightclub_id = $1
        AND e.event_date < t.event_date
        AND extract(dow FROM e.event_date) = extract(dow FROM t.event_date)
      ORDER BY e.event_date DESC, e.doors_open_at DESC
      LIMIT $3::int`,
    // La fecha se compara dentro de Postgres y no se pasa como parámetro: un DATE
    // que va y vuelve por un objeto Date de JavaScript puede cambiar de día según
    // la zona horaria del proceso.
    [nightclubId, event.id, HISTORY_NIGHTS],
  );
  return rows;
}

/**
 * Unidades por trago, promedio de las noches de historial.
 *
 * El promedio divide entre TODAS las noches del historial, no solo entre las que
 * vendieron ese trago: si un trago se vendió 20 un viernes y 0 los otros tres, el
 * viernes típico vende 5, no 20.
 */
async function forecastFromHistory({ nightclubId, nights, runner = pool }) {
  if (nights.length === 0) return new Map();
  const ids = nights.map((n) => n.id);
  const { rows } = await runner.query(
    `SELECT i.drink_id, sum(i.quantity)::int AS units
       FROM events_calendar e
       JOIN drink_orders o
         ON o.nightclub_id = e.nightclub_id
        AND o.created_at >= e.doors_open_at
        AND o.created_at < COALESCE(e.closes_at, e.doors_open_at + interval '12 hours')
        AND o.status = 'delivered'
       JOIN drink_order_items i ON i.order_id = o.id
      WHERE e.nightclub_id = $1 AND e.id = ANY($2::uuid[])
      GROUP BY i.drink_id`,
    [nightclubId, ids],
  );
  const out = new Map();
  for (const r of rows) {
    const avg = r.units / nights.length;
    out.set(r.drink_id, { total: r.units, average: Math.round(avg * 10) / 10, units: Math.ceil(avg - 1e-9) });
  }
  return out;
}

/**
 * Las promociones ACTIVAS de una noche (D102), con el nombre de la bebida. Las
 * apagadas no cuentan: no se van a vender así.
 */
async function listPromotions({ nightclubId, eventId, runner = pool }) {
  const { rows } = await runner.query(
    `SELECT p.id, p.event_id, p.name AS title, p.kind, p.drink_id, d.name AS drink_name,
            p.category, p.expected_units,
            (p.drink_id IS NOT NULL
             AND EXISTS (SELECT 1 FROM drink_supplies ds WHERE ds.drink_id = p.drink_id)) AS has_recipe
       FROM event_promotions p
       LEFT JOIN drinks d ON d.id = p.drink_id
      WHERE p.nightclub_id = $1 AND p.event_id = $2 AND p.active
      ORDER BY p.created_at, p.id`,
    [nightclubId, eventId],
  );
  return rows;
}

/**
 * Existencia del club y mínimo, por insumo: suma de todos los lugares activos.
 *
 * Se compra para el club, no para una barra: lo que falta en una barra y sobra en
 * el almacén se traspasa (`bar-requests`), no se compra.
 */
async function stockBySupply({ nightclubId, supplyIds, runner = pool }) {
  if (supplyIds.length === 0) return new Map();
  const { rows } = await runner.query(
    `SELECT ss.supply_id,
            COALESCE(sum(ss.stock), 0)::float8 AS stock,
            COALESCE(sum(ss.min_stock), 0)::float8 AS min_stock
       FROM supply_stock ss
       JOIN supply_locations l ON l.id = ss.location_id
      WHERE l.nightclub_id = $1 AND l.active AND ss.supply_id = ANY($2::uuid[])
      GROUP BY ss.supply_id`,
    [nightclubId, supplyIds],
  );
  return new Map(rows.map((r) => [r.supply_id, { stock: qty(r.stock), min_stock: qty(r.min_stock) }]));
}

/**
 * El proveedor de referencia de cada insumo y el costo de una presentación.
 *
 * El proveedor es el de la ÚLTIMA compra registrada; su `last_cost` ya viene por
 * presentación (como dice la factura). Si nadie lo ha comprado con proveedor, el
 * costo sale del promedio del kardex; si tampoco hay, el costo queda en `null` y la
 * pantalla dice "sin costo" en vez de enseñar un cero que parece gratis.
 */
async function supplyDetails({ nightclubId, supplyIds, runner = pool }) {
  if (supplyIds.length === 0) return new Map();
  const { rows } = await runner.query(
    `SELECT s.id, s.name, s.category, s.unit, s.package_size::float8 AS package_size,
            s.package_label, s.avg_cost::float8 AS avg_cost, s.active,
            sup.supplier_id, sup.supplier_name, sup.last_cost::float8 AS last_cost
       FROM supplies s
       LEFT JOIN LATERAL (
         SELECT x.supplier_id, p.name AS supplier_name, x.last_cost
           FROM supply_suppliers x
           JOIN suppliers p ON p.id = x.supplier_id AND p.active
          WHERE x.supply_id = s.id
          ORDER BY x.last_bought_at DESC NULLS LAST, x.created_at DESC
          LIMIT 1
       ) sup ON true
      WHERE s.nightclub_id = $1 AND s.id = ANY($2::uuid[])`,
    [nightclubId, supplyIds],
  );
  return new Map(rows.map((r) => {
    let packageCost = null;
    let costSource = null;
    if (r.last_cost != null && r.last_cost > 0) {
      packageCost = r.last_cost; costSource = 'supplier';
    } else if (r.avg_cost > 0) {
      packageCost = r.avg_cost * r.package_size; costSource = 'average';
    }
    return [r.id, { ...r, package_cost: packageCost == null ? null : money(packageCost), cost_source: costSource }];
  }));
}

/**
 * El plan de insumos de una noche: cuánto se espera vender de cada trago, cuánto
 * insumo pide eso, y cuánto falta comprar.
 */
async function supplyPlan({ nightclubId, eventId, runner = pool }) {
  const event = await loadEvent({ nightclubId, eventId, runner });
  const nights = await historyNights({ nightclubId, event, runner });
  const history = await forecastFromHistory({ nightclubId, nights, runner });
  const promos = await listPromotions({ nightclubId, eventId, runner });
  // Solo las de UNA bebida cambian el plan. Si una bebida tiene varias, manda la que
  // trae cantidad esperada (la primera que se dio de alta).
  const promoByDrink = new Map();
  for (const p of promos) {
    if (!p.drink_id) continue;
    const prev = promoByDrink.get(p.drink_id);
    if (!prev || (prev.expected_units == null && p.expected_units != null)) promoByDrink.set(p.drink_id, p);
  }

  // Los tragos a planear: los del historial y los de las promociones.
  const drinkIds = [...new Set([...history.keys(), ...promoByDrink.keys()])];
  const drinksInfo = drinkIds.length === 0 ? [] : (await runner.query(
    `SELECT id, name, category FROM drinks WHERE nightclub_id = $1 AND id = ANY($2::uuid[])`,
    [nightclubId, drinkIds])).rows;
  const nameOf = new Map(drinksInfo.map((d) => [d.id, d]));

  const drinks = drinkIds.map((id) => {
    const h = history.get(id);
    const p = promoByDrink.get(id);
    const forecastUnits = h ? h.units : 0;
    const useExpected = p && p.expected_units != null;
    return {
      drink_id: id,
      name: nameOf.get(id)?.name || null,
      category: nameOf.get(id)?.category || null,
      history_average: h ? h.average : 0,
      forecast_units: forecastUnits,
      promotion: p ? { id: p.id, kind: p.kind, title: p.title, expected_units: p.expected_units } : null,
      planned_units: useExpected ? p.expected_units : forecastUnits,
      source: useExpected ? 'promotion' : (h ? 'history' : 'no_history'),
    };
  }).filter((d) => d.planned_units > 0 || d.promotion)
    .sort((a, b) => b.planned_units - a.planned_units || String(a.name).localeCompare(String(b.name)));

  // Recetas de los tragos con venta planeada.
  const planned = drinks.filter((d) => d.planned_units > 0);
  const recipes = planned.length === 0 ? [] : (await runner.query(
    `SELECT drink_id, supply_id, quantity::float8 AS quantity
       FROM drink_supplies WHERE drink_id = ANY($1::uuid[])`,
    [planned.map((d) => d.drink_id)])).rows;
  const withRecipe = new Set(recipes.map((r) => r.drink_id));

  const need = new Map();
  for (const r of recipes) {
    const d = planned.find((x) => x.drink_id === r.drink_id);
    need.set(r.supply_id, (need.get(r.supply_id) || 0) + r.quantity * d.planned_units);
  }

  const supplies = await buildPurchaseRows({
    nightclubId, runner, needBySupply: need, spentBySupply: new Map(),
  });

  return {
    event: {
      id: event.id, name: event.name, event_date: event.event_date,
      doors_open_at: event.doors_open_at, status: event.status,
    },
    history: {
      nights_used: nights.length,
      nights_wanted: HISTORY_NIGHTS,
      nights: nights.map((n) => ({
        id: n.id, name: n.name, event_date: n.event_date, doors_open_at: n.doors_open_at,
      })),
    },
    promotions: promos,
    drinks,
    without_recipe: planned.filter((d) => !withRecipe.has(d.drink_id))
      .map((d) => ({ drink_id: d.drink_id, name: d.name, planned_units: d.planned_units })),
    supplies,
    totals: totalsOf(supplies),
  };
}

/**
 * Los renglones de compra: uno por insumo, con lo que falta en presentaciones.
 *
 *   demanda = máx(lo gastado, lo que pide la próxima noche)
 *   comprar = máx(0, demanda + mínimo − existencia), en presentaciones completas
 *
 * También entra todo insumo que ya está por debajo de su mínimo aunque nadie lo
 * haya gastado: si no, el que se quedó corto la semana pasada nunca vuelve a la
 * lista.
 */
async function buildPurchaseRows({ nightclubId, needBySupply, spentBySupply, runner = pool }) {
  const below = await runner.query(
    `SELECT ss.supply_id
       FROM supply_stock ss
       JOIN supply_locations l ON l.id = ss.location_id
       JOIN supplies s ON s.id = ss.supply_id
      WHERE l.nightclub_id = $1 AND l.active AND s.active
      GROUP BY ss.supply_id
     HAVING sum(ss.min_stock) > 0 AND sum(ss.stock) < sum(ss.min_stock)`,
    [nightclubId],
  );
  const ids = [...new Set([
    ...needBySupply.keys(), ...spentBySupply.keys(), ...below.rows.map((r) => r.supply_id),
  ])];
  const [stock, details] = await Promise.all([
    stockBySupply({ nightclubId, supplyIds: ids, runner }),
    supplyDetails({ nightclubId, supplyIds: ids, runner }),
  ]);

  return ids
    .map((id) => {
      const d = details.get(id);
      if (!d || !d.active) return null; // un insumo dado de baja no se compra
      const st = stock.get(id) || { stock: 0, min_stock: 0 };
      const spent = qty(spentBySupply.get(id) || 0);
      const planned = qty(needBySupply.get(id) || 0);
      const demand = Math.max(spent, planned);
      const missing = qty(Math.max(0, demand + st.min_stock - st.stock));
      const packages = packagesFor(missing, d.package_size);
      return {
        supply_id: id,
        name: d.name,
        category: d.category,
        unit: d.unit,
        package_size: d.package_size,
        package_label: d.package_label,
        spent,
        planned_need: planned,
        stock: st.stock,
        min_stock: st.min_stock,
        to_buy: missing,
        to_buy_packages: packages,
        package_cost: d.package_cost,
        cost_source: d.cost_source,
        estimated_cost: d.package_cost == null ? null : money(packages * d.package_cost),
        supplier: d.supplier_id ? { id: d.supplier_id, name: d.supplier_name } : null,
      };
    })
    .filter(Boolean)
    .sort((a, b) => (b.to_buy_packages > 0) - (a.to_buy_packages > 0)
      || String(a.supplier?.name || '~').localeCompare(String(b.supplier?.name || '~'))
      || a.name.localeCompare(b.name));
}

function totalsOf(rows) {
  const buy = rows.filter((r) => r.to_buy_packages > 0);
  return {
    supplies_to_buy: buy.length,
    packages_to_buy: buy.reduce((n, r) => n + r.to_buy_packages, 0),
    estimated_cost: money(buy.reduce((n, r) => n + (r.estimated_cost || 0), 0)),
    // Cuántos renglones a comprar no tienen costo conocido: el total de arriba se
    // queda corto por ellos, y hay que decirlo.
    without_cost: buy.filter((r) => r.estimated_cost == null).length,
  };
}

/**
 * La próxima noche a planear: la primera que todavía no abre puertas y no está
 * cancelada ni terminada.
 */
async function nextEvent({ nightclubId, now = new Date(), runner = pool }) {
  const { rows } = await runner.query(
    `SELECT id, name, event_date, doors_open_at, status
       FROM events_calendar
      WHERE nightclub_id = $1 AND status IN ('draft', 'published') AND doors_open_at > $2
      ORDER BY doors_open_at, event_date
      LIMIT 1`,
    [nightclubId, now],
  );
  return rows[0] || null;
}

/**
 * El reporte de una noche: lo más vendido, lo gastado y la lista para reponerlo
 * cubriendo además la próxima noche.
 */
async function nightReport({ nightclubId, eventId, nextEventId = null, now = new Date(), runner = pool }) {
  const { night, from, to } = await loadNight({ nightclubId, eventId, runner });
  const [drinks, spent] = await Promise.all([
    topDrinks({ nightclubId, from, to, runner }),
    suppliesSpent({ nightclubId, from, to, runner }),
  ]);

  let next = null;
  if (nextEventId) {
    if (nextEventId === eventId) throw ApiError.badRequest('La próxima noche no puede ser la misma noche');
    next = await loadEvent({ nightclubId, eventId: nextEventId, runner });
  } else {
    next = await nextEvent({ nightclubId, now, runner });
    if (next && next.id === eventId) next = null;
  }

  let plan = null;
  const needBySupply = new Map();
  if (next) {
    plan = await supplyPlan({ nightclubId, eventId: next.id, runner });
    for (const s of plan.supplies) if (s.planned_need > 0) needBySupply.set(s.supply_id, s.planned_need);
  }

  const purchase = await buildPurchaseRows({
    nightclubId, runner, needBySupply,
    spentBySupply: new Map(spent.map((s) => [s.supply_id, s.total])),
  });

  return {
    event: {
      id: night.id, name: night.name, event_date: night.event_date,
      doors_open_at: night.doors_open_at, status: night.status,
    },
    window: { from, to },
    currency: night.currency,
    drinks,
    drinks_total: {
      units: drinks.reduce((n, d) => n + d.units, 0),
      revenue: money(drinks.reduce((n, d) => n + d.revenue, 0)),
      without_recipe: drinks.filter((d) => !d.has_recipe).length,
    },
    supplies_spent: spent,
    supplies_spent_cost: money(spent.reduce((n, s) => n + s.cost, 0)),
    next_event: next ? {
      id: next.id, name: next.name, event_date: next.event_date, doors_open_at: next.doors_open_at,
      history_nights: plan.history.nights_used,
      promotions: plan.promotions.length,
      without_recipe: plan.without_recipe,
    } : null,
    purchase,
    totals: totalsOf(purchase),
  };
}

module.exports = {
  HISTORY_NIGHTS,
  packagesFor,
  topDrinks,
  suppliesSpent,
  historyNights,
  forecastFromHistory,
  supplyPlan,
  nightReport,
  nextEvent,
  listPromotions,
};
