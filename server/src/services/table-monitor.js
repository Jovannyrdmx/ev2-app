'use strict';

/**
 * El monitor de mesas del gerente (D113): qué mesas están ocupadas, desde cuándo, qué
 * llevan consumido, y la historia de cada mesa (quién se sentó, cuándo se fue, qué
 * consumió esa vez).
 *
 * No guarda nada nuevo: lee `table_occupants` (entrada y salida de cada persona) y los
 * pedidos de la mesa. Una "ocupación" es un tramo continuo en que hubo alguien
 * sentado; si entra uno antes de que se vaya el último, sigue siendo la misma.
 */
const { ORDER_STATES_ON_BILL } = require('./tickets');

const VIP_TYPES = ['vip', 'premium', 'booth'];

/** Todas las mesas con su estado, quién hay, desde cuándo y lo consumido desde entonces. */
async function monitor(runner, { nightclubId }) {
  const { rows } = await runner.query(
    `SELECT t.id, t.code, t.section, t.floor, t.type, t.status, t.capacity,
            (t.type = ANY($2::text[])) AS is_vip,
            occ.guests, occ.since,
            COALESCE(cons.orders, 0)::int AS orders,
            COALESCE(cons.total, 0)::numeric(12,2)::text AS total,
            cons.currency,
            CASE WHEN occ.since IS NULL THEN NULL
                 ELSE floor(extract(epoch FROM now() - occ.since) / 60)::int END AS minutes_seated,
            cons.last_order_at
       FROM tables t
       LEFT JOIN LATERAL (
         SELECT count(*)::int AS guests, min(seated_at) AS since
           FROM table_occupants WHERE table_id = t.id AND left_at IS NULL
       ) occ ON occ.guests > 0
       LEFT JOIN LATERAL (
         SELECT count(DISTINCT o.id) AS orders, max(o.created_at) AS last_order_at,
                sum(COALESCE(oi.line_total, oi.quantity * oi.unit_price)) AS total,
                min(o.currency) AS currency
           FROM drink_orders o JOIN drink_order_items oi ON oi.order_id = o.id
          WHERE o.nightclub_id = t.nightclub_id AND o.table_id = t.id
            AND o.created_at >= occ.since AND o.status = ANY($3::text[])
       ) cons ON occ.since IS NOT NULL
      WHERE t.nightclub_id = $1 AND t.active
      ORDER BY (t.type = ANY($2::text[])) DESC, t.floor NULLS LAST, t.section, t.code`,
    [nightclubId, VIP_TYPES, ORDER_STATES_ON_BILL]);
  return rows;
}

/** Las ocupaciones de una mesa en las últimas `hours` horas, con lo que se consumió en cada una. */
async function history(runner, { nightclubId, tableId, hours }) {
  const { rows } = await runner.query(
    `WITH o AS (
       SELECT oc.id, oc.seated_at, COALESCE(oc.left_at, 'infinity'::timestamptz) AS l
         FROM table_occupants oc JOIN tables t ON t.id = oc.table_id
        WHERE oc.table_id = $2 AND t.nightclub_id = $1
          AND COALESCE(oc.left_at, now()) > now() - ($3::int * interval '1 hour')
     ), r AS (
       SELECT o.*, max(l) OVER (ORDER BY seated_at, id
                                ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS prev_max
         FROM o
     ), s AS (
       SELECT r.*, sum(CASE WHEN prev_max IS NULL OR seated_at > prev_max THEN 1 ELSE 0 END)
                     OVER (ORDER BY seated_at, id) AS grp
         FROM r
     ), ses AS (
       SELECT grp, min(seated_at) AS started_at,
              CASE WHEN bool_or(l = 'infinity') THEN NULL ELSE max(l) END AS ended_at,
              count(*)::int AS guests
         FROM s GROUP BY grp
     )
     SELECT ses.started_at, ses.ended_at, ses.guests,
            COALESCE(c.total, 0)::numeric(12,2)::text AS total, c.currency,
            COALESCE(c.lines, '[]'::json) AS lines
       FROM ses
       LEFT JOIN LATERAL (
         SELECT sum(x.amount) AS total, min(x.currency) AS currency,
                json_agg(json_build_object('name', x.name, 'quantity', x.qty,
                                           'amount', x.amount::numeric(12,2)::text)
                         ORDER BY x.name) AS lines
           FROM (
             SELECT d.name, o2.currency, sum(oi.quantity)::int AS qty,
                    sum(COALESCE(oi.line_total, oi.quantity * oi.unit_price)) AS amount
               FROM drink_orders o2
               JOIN drink_order_items oi ON oi.order_id = o2.id
               JOIN drinks d ON d.id = oi.drink_id
              WHERE o2.nightclub_id = $1 AND o2.table_id = $2
                AND o2.created_at >= ses.started_at
                AND (ses.ended_at IS NULL OR o2.created_at <= ses.ended_at)
                AND o2.status = ANY($4::text[])
              GROUP BY d.name, o2.currency
           ) x
       ) c ON true
      ORDER BY ses.started_at DESC
      LIMIT 50`,
    [nightclubId, tableId, hours, ORDER_STATES_ON_BILL]);
  return rows;
}

module.exports = { VIP_TYPES, monitor, history };
