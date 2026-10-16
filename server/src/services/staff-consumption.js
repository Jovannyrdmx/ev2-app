/**
 * EV2 — el consumo del personal (D101).
 *
 * Un empleado pide para si desde su telefono; no paga en la caja, se le descuenta del
 * pago. Aqui vive todo lo que no es la ruta: el porcentaje, el calculo, la semana de
 * pago y el reporte.
 */
'use strict';

const { ApiError } = require('../middleware/errors');

/**
 * Quien puede pedir para si. El gerente tambien (D116): el dueno lo pidio, y su
 * consumo entra al mismo reporte semanal de descuento por nomina que el de todos.
 * El admin no: es el dueno, no personal con descuento.
 */
const STAFF_ROLES = ['waiter', 'bartender', 'cashier', 'dancer', 'dj', 'light_tech',
  'valet', 'hostess', 'rp', 'manager'];

const ROLE_LABEL_ES = {
  waiter: 'Mesero', bartender: 'Bartender', cashier: 'Cajero', dancer: 'Bailarina',
  dj: 'DJ', light_tech: 'Iluminación', valet: 'Valet', hostess: 'Anfitriona', rp: 'RP',
  manager: 'Gerente', admin: 'Administrador',
};
const roleLabel = (role) => ROLE_LABEL_ES[role] || role;

/** El porcentaje del club, o null si el gerente todavia no lo configura. */
async function discountPct(runner, nightclubId) {
  const { rows } = await runner.query(
    'SELECT discount_pct::float8 AS pct FROM staff_consumption_settings WHERE nightclub_id = $1',
    [nightclubId]);
  return rows.length ? rows[0].pct : null;
}

async function setDiscountPct(runner, { nightclubId, pct, userId }) {
  await runner.query(
    `INSERT INTO staff_consumption_settings (nightclub_id, discount_pct, updated_by, updated_at)
     VALUES ($1,$2,$3,now())
     ON CONFLICT (nightclub_id) DO UPDATE
       SET discount_pct = EXCLUDED.discount_pct, updated_by = EXCLUDED.updated_by,
           updated_at = now()`,
    [nightclubId, pct.toFixed(2), userId]);
}

/** Lo que se le descuenta: precio de lista menos el descuento, a dos decimales. */
function amountFor(listTotal, pct) {
  return Number((Number(listTotal) * (1 - Number(pct) / 100)).toFixed(2));
}

/**
 * Lo que se le descuenta con promociones de por medio (D102): el MENOR entre el precio de
 * personal sobre la carta y lo que costaria el pedido con las promociones de la noche.
 * No se acumulan: una promo no se suma al descuento del personal.
 */
function amountDue(listTotal, pct, promoTotal = null) {
  const staff = amountFor(listTotal, pct);
  return promoTotal === null ? staff : Math.min(staff, Number(promoTotal));
}

/**
 * Guarda el consumo de un pedido ya creado. La noche y la semana se calculan en SQL con
 * la zona horaria del club: las 6 de la manana cierran el dia, y la semana abre el jueves.
 */
async function record(client, { nightclubId, user, orderId, listTotal, pct, currency, promoTotal = null }) {
  const amount = amountDue(listTotal, pct, promoTotal);
  const { rows } = await client.query(
    `WITH n AS (
       SELECT ((now() AT TIME ZONE c.timezone) - interval '6 hours')::date AS bd
         FROM nightclubs c WHERE c.id = $1)
     INSERT INTO staff_consumptions
       (nightclub_id, user_id, user_name, user_role, order_id, list_total, discount_pct,
        amount, currency, business_date, week_start)
     SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, n.bd,
            n.bd - ((extract(dow FROM n.bd)::int - 4 + 7) % 7)
       FROM n
     RETURNING id, business_date::text AS business_date, week_start::text AS week_start`,
    [nightclubId, user.id, user.display_name || 'Sin nombre', user.role, orderId,
      Number(listTotal).toFixed(2), Number(pct).toFixed(2), amount.toFixed(2),
      currency]);
  return rows[0];
}

/** Un pedido cancelado deja de descontarse. */
async function voidForOrder(client, orderId) {
  await client.query(
    `UPDATE staff_consumptions SET status = 'cancelled', cancelled_at = now()
      WHERE order_id = $1 AND status = 'active'`, [orderId]);
}

/** El jueves de la semana de pago de hoy, o de la fecha dada. */
async function weekStartOf(runner, { nightclubId, date = null }) {
  const { rows } = await runner.query(
    `WITH n AS (
       SELECT COALESCE($2::date,
                ((now() AT TIME ZONE c.timezone) - interval '6 hours')::date) AS bd
         FROM nightclubs c WHERE c.id = $1)
     SELECT (n.bd - ((extract(dow FROM n.bd)::int - 4 + 7) % 7))::text AS week_start FROM n`,
    [nightclubId, date]);
  if (!rows.length) throw ApiError.notFound('Club no encontrado');
  return rows[0].week_start;
}

/**
 * El reporte de una semana de pago: por empleado, cada consumo y el total a descontar,
 * separado por moneda (un empleado puede haber pedido en pesos y en dolares).
 */
async function weeklyReport(runner, { nightclubId, weekStart }) {
  const { rows } = await runner.query(
    `SELECT sc.user_id, sc.user_name, sc.user_role, sc.id, sc.created_at, sc.business_date::text AS business_date,
            sc.list_total::text AS list_total, sc.discount_pct::float8 AS discount_pct,
            sc.amount::text AS amount, sc.currency, sc.order_id::text AS order_id,
            COALESCE(items.items, '[]'::json) AS items
       FROM staff_consumptions sc
       LEFT JOIN LATERAL (
         SELECT json_agg(json_build_object('name', d.name, 'quantity', oi.quantity,
                  'unit_price', oi.unit_price::text,
                  'line_total', COALESCE(oi.line_total, oi.unit_price * oi.quantity)::text) ORDER BY d.name) AS items
           FROM drink_order_items oi JOIN drinks d ON d.id = oi.drink_id
          WHERE oi.order_id = sc.order_id) items ON true
      WHERE sc.nightclub_id = $1 AND sc.week_start = $2::date AND sc.status = 'active'
      ORDER BY sc.user_name, sc.user_id, sc.created_at`,
    [nightclubId, weekStart]);

  const byUser = new Map();
  for (const r of rows) {
    let e = byUser.get(r.user_id);
    if (!e) {
      e = {
        user_id: r.user_id, name: r.user_name, role: r.user_role, role_label: roleLabel(r.user_role),
        totals: {}, count: 0, consumptions: [],
      };
      byUser.set(r.user_id, e);
    }
    e.count += 1;
    e.totals[r.currency] = Number(((e.totals[r.currency] || 0) + Number(r.amount)).toFixed(2));
    e.consumptions.push({
      id: r.id, order_id: r.order_id, at: r.created_at, business_date: r.business_date,
      list_total: r.list_total, discount_pct: r.discount_pct, amount: r.amount,
      currency: r.currency, items: r.items,
    });
  }
  const employees = [...byUser.values()].map((e) => ({
    ...e, totals: Object.fromEntries(Object.entries(e.totals).map(([k, v]) => [k, v.toFixed(2)])),
  }));
  const grand = {};
  for (const r of rows) grand[r.currency] = Number(((grand[r.currency] || 0) + Number(r.amount)).toFixed(2));

  const end = await runner.query(`SELECT ($1::date + 6)::text AS d`, [weekStart]);
  return {
    week_start: weekStart,
    week_end: end.rows[0].d,
    employees,
    totals: Object.fromEntries(Object.entries(grand).map(([k, v]) => [k, v.toFixed(2)])),
  };
}

const csvCell = (v) => {
  const s = String(v == null ? '' : v);
  // Una celda que empieza con = + - @ se abre como formula en Excel.
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

/** El mismo reporte, una fila por consumo, para abrir en Excel. */
function reportCsv(report) {
  const head = ['Empleado', 'Puesto', 'Fecha (noche)', 'Detalle', 'Precio de lista',
    'Descuento %', 'A descontar', 'Moneda'];
  const lines = [head.map(csvCell).join(',')];
  for (const e of report.employees) {
    for (const c of e.consumptions) {
      const detalle = c.items.map((i) => `${i.quantity} x ${i.name}`).join('; ');
      lines.push([e.name, e.role_label, c.business_date, detalle, c.list_total,
        c.discount_pct, c.amount, c.currency].map(csvCell).join(','));
    }
    for (const [cur, total] of Object.entries(e.totals)) {
      lines.push([e.name, e.role_label, 'TOTAL', '', '', '', total, cur].map(csvCell).join(','));
    }
  }
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

module.exports = {
  STAFF_ROLES, roleLabel, discountPct, setDiscountPct, amountFor, amountDue, record, voidForOrder,
  weekStartOf, weeklyReport, reportCsv,
};
