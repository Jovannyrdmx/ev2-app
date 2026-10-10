// Credito de consumo de una reservacion VIP (D97, migracion 048).
//
// Lo pagado por reservar se le da de vuelta a quien reservo, para consumir ESA noche.
// Aqui vive toda la regla: otorgarlo, ver cuanto queda, gastarlo, anularlo. Los
// cobros (`till.collect`, `payments.settle`) y las reservaciones solo llaman a estas
// funciones, para que ningun camino invente su propia version de "cuanto queda".
'use strict';

const { ApiError } = require('../middleware/errors');
const eventPricing = require('./event-pricing');

const METHOD = 'vip_credit';
const round2 = (n) => Math.round(Number(n || 0) * 100) / 100;
const money = (n) => round2(n).toFixed(2);

/** Cuanto queda por gastar, o 0 si esta anulado o ya vencio. */
function available(credit, now = new Date()) {
  if (credit.voided_at) return 0;
  if (new Date(credit.expires_at) <= now) return 0;
  return Math.max(0, round2(Number(credit.granted) - Number(credit.spent)));
}

async function record(client, { credit, kind, amount, balanceAfter, transactionId = null,
  paymentId = null, userId = null }) {
  await client.query(
    `INSERT INTO reservation_credit_movements
       (credit_id, nightclub_id, kind, amount, balance_after, transaction_id, payment_id, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [credit.id, credit.nightclub_id, kind, money(amount), money(balanceAfter),
      transactionId, paymentId, userId]);
}

/**
 * Un pago de la reservacion se confirmo: lo pagado pasa a ser credito.
 * Sin noche (reservacion sin evento) no hay "esa noche" a la que atarlo: no se otorga.
 * Un credito ya anulado no revive.
 */
async function grant(client, { nightclubId, tx }) {
  const { rows } = await client.query(
    `SELECT r.id, r.user_id, r.event_id, r.currency, e.doors_open_at, e.closes_at
       FROM reservations r
       JOIN events_calendar e ON e.id = r.event_id
      WHERE r.id = $1 AND r.nightclub_id = $2
        AND r.status NOT IN ('cancelled','no_show')`,
    [tx.reference_id, nightclubId]);
  const r = rows[0];
  if (!r) return null;
  const amount = round2(tx.amount);
  if (!(amount > 0)) return null;

  const expiresAt = eventPricing.nightEnd(r);
  const up = await client.query(
    `INSERT INTO reservation_credits
       (nightclub_id, reservation_id, user_id, event_id, currency, granted, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (reservation_id) DO UPDATE
        SET granted = reservation_credits.granted + EXCLUDED.granted
      WHERE reservation_credits.voided_at IS NULL
     RETURNING id, nightclub_id, granted, spent`,
    [nightclubId, r.id, r.user_id, r.event_id, r.currency, money(amount), expiresAt]);
  const credit = up.rows[0];
  if (!credit) return null;
  await record(client, {
    credit, kind: 'grant', amount, balanceAfter: round2(credit.granted - credit.spent),
    transactionId: tx.id, userId: null,
  });
  return credit;
}

/**
 * La reservacion se cancelo o no llego: lo que quede del credito se anula.
 * Idempotente: sin credito, o ya anulado, no hace nada.
 */
async function voidForReservation(client, { reservationId, reason, userId = null }) {
  const { rows } = await client.query(
    `SELECT id, nightclub_id, granted, spent FROM reservation_credits
      WHERE reservation_id = $1 AND voided_at IS NULL FOR UPDATE`,
    [reservationId]);
  const credit = rows[0];
  if (!credit) return null;
  const left = round2(credit.granted - credit.spent);
  await client.query(
    `UPDATE reservation_credits SET voided_at = now(), void_reason = $2::text WHERE id = $1`,
    [credit.id, reason]);
  if (left > 0) {
    await record(client, { credit, kind: 'void', amount: left, balanceAfter: 0, userId });
  }
  return { id: credit.id, voided: left };
}

/**
 * Cuanto del credito puede cubrir esta cuenta, y de cual credito sale.
 *
 * Una cuenta usa el credito si es un pedido de la MESA reservada, de esa noche, hecho
 * por quien reservo o por el personal en su nombre. Un invitado de la mesa que pide
 * por su cuenta no lo gasta: el credito es de quien reservo.
 *
 * Bloquea el credito (`FOR UPDATE OF c`): dos cajas cobrando a la vez no pueden gastar
 * el mismo saldo dos veces.
 */
async function quote(client, { nightclubId, transactionId, pending, currency }) {
  const { rows } = await client.query(
    `SELECT c.id, c.nightclub_id, c.user_id AS holder_id, c.granted, c.spent, c.currency,
            c.expires_at, c.voided_at, o.sender_id, su.role AS sender_role
       FROM transactions tx
       JOIN drink_orders o ON o.id = tx.reference_id AND tx.reference_type = 'drink_order'
       JOIN users su ON su.id = o.sender_id
       JOIN reservations r ON r.table_id = o.table_id AND r.nightclub_id = o.nightclub_id
       JOIN reservation_credits c ON c.reservation_id = r.id
       JOIN events_calendar e ON e.id = c.event_id
      WHERE tx.id = $1 AND tx.nightclub_id = $2
        AND r.status NOT IN ('cancelled','no_show','pending_payment')
        AND c.voided_at IS NULL AND c.expires_at > now()
        AND o.created_at >= e.doors_open_at - interval '6 hours'
        AND o.created_at < c.expires_at
      ORDER BY c.expires_at
      LIMIT 1
      FOR UPDATE OF c`,
    [transactionId, nightclubId]);
  const c = rows[0];
  if (!c) {
    throw ApiError.unprocessable('Esta cuenta no tiene crédito VIP disponible: la mesa no tiene '
      + 'una reservación VIP pagada esta noche, o su crédito ya venció o se anuló.');
  }
  if (c.sender_id !== c.holder_id && c.sender_role === 'guest') {
    throw ApiError.unprocessable('El crédito VIP lo usa quien reservó (o el personal en su nombre): '
      + 'este pedido lo hizo otra persona.');
  }
  if (c.currency !== currency) {
    throw ApiError.unprocessable('El crédito VIP y la cuenta están en monedas distintas');
  }
  const left = available(c);
  if (!(left > 0)) throw ApiError.conflict('El crédito VIP de esta mesa ya se agotó');
  const amount = Math.min(left, round2(pending));
  if (!(amount > 0)) throw ApiError.conflict('Ese cobro ya está pagado');
  return { credit: c, amount: money(amount), available_before: money(left) };
}

/** El pago con credito ya quedo escrito: se descuenta y deja su renglon. */
async function spend(client, { credit, amount, paymentId, transactionId, userId }) {
  const monto = round2(amount);
  const { rows } = await client.query(
    `UPDATE reservation_credits SET spent = spent + $2::numeric
      WHERE id = $1 AND granted - spent >= $2::numeric
      RETURNING id, nightclub_id, granted, spent`,
    [credit.id, money(monto)]);
  if (rows.length === 0) throw ApiError.conflict('El crédito VIP ya no alcanza');
  await record(client, {
    credit: rows[0], kind: 'spend', amount: -monto,
    balanceAfter: round2(rows[0].granted - rows[0].spent), transactionId, paymentId, userId,
  });
  return rows[0];
}

/**
 * Una cuenta pagada con credito se cancelo: el credito gastado en ella regresa, si
 * todavia esta vigente. Lo que ya venció o se anuló no vuelve: el credito no vive
 * mas alla de la noche.
 */
async function restoreForTransaction(client, { transactionId, userId = null }) {
  const { rows } = await client.query(
    `SELECT m.payment_id, -m.amount AS spent, c.id, c.nightclub_id, c.granted, c.spent AS total_spent,
            c.expires_at, c.voided_at
       FROM reservation_credit_movements m
       JOIN reservation_credits c ON c.id = m.credit_id
      WHERE m.transaction_id = $1 AND m.kind = 'spend'
        AND NOT EXISTS (
          SELECT 1 FROM reservation_credit_movements r
           WHERE r.kind = 'restore' AND r.payment_id = m.payment_id)
      FOR UPDATE OF c`,
    [transactionId]);
  let restored = 0;
  for (const row of rows) {
    if (row.voided_at || new Date(row.expires_at) <= new Date()) continue;
    const up = await client.query(
      `UPDATE reservation_credits SET spent = spent - $2::numeric
        WHERE id = $1 AND spent >= $2::numeric RETURNING id, nightclub_id, granted, spent`,
      [row.id, money(row.spent)]);
    if (up.rows.length === 0) continue;
    await record(client, {
      credit: up.rows[0], kind: 'restore', amount: row.spent,
      balanceAfter: round2(up.rows[0].granted - up.rows[0].spent),
      transactionId, paymentId: row.payment_id, userId,
    });
    restored = round2(restored + Number(row.spent));
  }
  return restored;
}

const PRESENT = `
  SELECT c.id, c.reservation_id, c.currency, c.granted::text AS granted, c.spent::text AS spent,
         GREATEST(c.granted - c.spent, 0)::text AS balance,
         c.expires_at, c.voided_at, c.void_reason,
         (c.voided_at IS NULL AND c.expires_at > now() AND c.granted > c.spent) AS usable,
         t.code AS table_code, t.section, e.name AS event_name, u.display_name AS holder_name
    FROM reservation_credits c
    JOIN reservations r ON r.id = c.reservation_id
    JOIN tables t ON t.id = r.table_id
    JOIN events_calendar e ON e.id = c.event_id
    JOIN users u ON u.id = c.user_id`;

/** Los creditos de una persona que siguen vigentes esta noche. */
async function mine(runner, { nightclubId, userId }) {
  const { rows } = await runner.query(
    `${PRESENT}
      WHERE c.nightclub_id = $1 AND c.user_id = $2 AND c.expires_at > now()
      ORDER BY c.expires_at`,
    [nightclubId, userId]);
  return rows;
}

/** Para el personal: los creditos de la noche en curso, con su saldo. */
async function tonight(runner, { nightclubId }) {
  const { rows } = await runner.query(
    `${PRESENT}
      WHERE c.nightclub_id = $1 AND c.expires_at > now()
        AND e.doors_open_at <= now() + interval '12 hours'
      ORDER BY t.code`,
    [nightclubId]);
  return rows;
}

module.exports = {
  METHOD, available, grant, voidForReservation, quote, spend, restoreForTransaction,
  mine, tonight,
};
