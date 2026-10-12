'use strict';

/**
 * El saldo del mesero y su tope (D110), y lo que hace falta para levantar pedidos.
 *
 * Desde D77 el pedido del mesero entra a la barra sin pagar y él lleva el dinero a la
 * caja. Lo que ya entregó y la caja no ha cobrado es dinero que trae encima: se ve en
 * vivo (caja y gerente) y, si el gerente puso un tope, pasado el tope no manda pedidos
 * nuevos hasta pagar.
 */
const { pool } = require('../db/pool');
const { ApiError } = require('../middleware/errors');
const { OPEN_TX_STATUSES } = require('./payments');
const staffShifts = require('./staff-shifts');

const round2 = (n) => Math.round(Number(n || 0) * 100) / 100;
const money = (n) => round2(n).toFixed(2);

/** El tope del club: `null` en cada campo = sin tope. */
async function limits(runner, nightclubId) {
  const { rows } = await runner.query(
    `SELECT max_unpaid_amount::text AS max_unpaid_amount, max_unpaid_minutes, updated_at,
            updated_by
       FROM waiter_limits WHERE nightclub_id = $1`, [nightclubId]);
  return rows[0] || { max_unpaid_amount: null, max_unpaid_minutes: null, updated_at: null, updated_by: null };
}

async function setLimits(runner, { nightclubId, maxAmount, maxMinutes, userId }) {
  const { rows } = await runner.query(
    `INSERT INTO waiter_limits (nightclub_id, max_unpaid_amount, max_unpaid_minutes, updated_by, updated_at)
     VALUES ($1,$2,$3,$4, now())
     ON CONFLICT (nightclub_id) DO UPDATE
       SET max_unpaid_amount = EXCLUDED.max_unpaid_amount,
           max_unpaid_minutes = EXCLUDED.max_unpaid_minutes,
           updated_by = EXCLUDED.updated_by, updated_at = now()
     RETURNING max_unpaid_amount::text AS max_unpaid_amount, max_unpaid_minutes, updated_at, updated_by`,
    [nightclubId, maxAmount, maxMinutes, userId]);
  return rows[0];
}

/**
 * Lo que trae cada mesero: pedidos que se cobran en caja, sin cancelar, con el cobro
 * abierto. Separa lo ya entregado (dinero que debería traer) de lo que sigue en la
 * barra. Solo las últimas 18 horas: es la noche.
 */
async function balances(runner, { nightclubId, userId = null }) {
  const { rows } = await runner.query(
    `WITH abiertos AS (
       SELECT o.taken_by, o.status, o.delivered_at,
              (o.subtotal - COALESCE((
                 SELECT sum(x.amount) FROM (
                   SELECT p.amount FROM manual_payments p
                    WHERE p.transaction_id = tx.id AND p.status = 'confirmed'
                   UNION ALL
                   SELECT c.amount FROM terminal_charges c
                    WHERE c.transaction_id = tx.id AND c.status = 'processed') x), 0)) AS remaining
         FROM drink_orders o
         JOIN transactions tx ON tx.reference_type = 'drink_order' AND tx.reference_id = o.id
        WHERE o.nightclub_id = $1 AND o.pay_at_till AND o.status <> 'cancelled'
          AND tx.status = ANY($2::text[])
          AND o.created_at > now() - interval '18 hours'
          AND ($3::uuid IS NULL OR o.taken_by = $3::uuid)
     )
     SELECT a.taken_by AS user_id, u.display_name AS name,
            count(*)::int AS open_orders,
            COALESCE(sum(a.remaining), 0)::numeric(12,2)::text AS unpaid_total,
            count(*) FILTER (WHERE a.status = 'delivered')::int AS delivered_unpaid_orders,
            COALESCE(sum(a.remaining) FILTER (WHERE a.status = 'delivered'), 0)::numeric(12,2)::text
              AS delivered_unpaid_total,
            min(a.delivered_at) FILTER (WHERE a.status = 'delivered') AS oldest_delivered_at,
            COALESCE(floor(extract(epoch FROM now() - min(a.delivered_at)
              FILTER (WHERE a.status = 'delivered')) / 60), 0)::int AS oldest_delivered_minutes
       FROM abiertos a
       JOIN users u ON u.id = a.taken_by
      GROUP BY a.taken_by, u.display_name
      ORDER BY sum(a.remaining) FILTER (WHERE a.status = 'delivered') DESC NULLS LAST, u.display_name`,
    [nightclubId, OPEN_TX_STATUSES, userId]);
  return rows;
}

/** Si ese saldo pasa el tope, por qué; si no, `null`. */
function overLimit(balance, lim) {
  if (!balance) return null;
  const debe = Number(balance.delivered_unpaid_total);
  if (lim.max_unpaid_amount !== null && debe > Number(lim.max_unpaid_amount)) {
    return { reason: 'amount', limit: money(lim.max_unpaid_amount), value: money(debe) };
  }
  if (lim.max_unpaid_minutes !== null && balance.delivered_unpaid_orders > 0
      && balance.oldest_delivered_minutes >= Number(lim.max_unpaid_minutes)) {
    return { reason: 'minutes', limit: lim.max_unpaid_minutes, value: balance.oldest_delivered_minutes };
  }
  return null;
}

/**
 * Antes de que un mesero mande un pedido a la barra: que haya checado su entrada, y
 * que no haya pasado el tope de lo entregado sin pagar.
 */
async function assertCanOrder(runner = pool, { nightclubId, user }) {
  if (user.role !== 'waiter') return;
  const turno = await staffShifts.openShift(user.id, runner);
  if (!turno) {
    throw ApiError.conflict('Checa tu entrada antes de levantar pedidos.', { reason: 'no_shift' });
  }
  const lim = await limits(runner, nightclubId);
  if (lim.max_unpaid_amount === null && lim.max_unpaid_minutes === null) return;
  const [saldo] = await balances(runner, { nightclubId, userId: user.id });
  const pasado = overLimit(saldo, lim);
  if (!pasado) return;
  throw ApiError.conflict(pasado.reason === 'amount'
    ? `Traes ${pasado.value} entregados sin pagar (el tope es ${pasado.limit}). Pasa a la caja antes de pedir más.`
    : `Tienes un pedido entregado hace ${pasado.value} min sin pagar (el tope es ${pasado.limit} min). Pasa a la caja antes de pedir más.`,
  { reason: `over_${pasado.reason}`, delivered_unpaid_total: saldo.delivered_unpaid_total,
    oldest_delivered_minutes: saldo.oldest_delivered_minutes, limits: lim });
}

module.exports = { limits, setLimits, balances, overLimit, assertCanOrder };
