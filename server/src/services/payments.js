// Money the club receives outside a payment processor (docs/DECISIONES.md D28).
//
// Nothing here charges anybody. A manual payment is a claim -- "I sent you this" -- and
// it only touches the ledger when a manager confirms it against the statement. Both
// halves of that confirmation happen in one SQL transaction, so a ledger entry can never
// end up `paid` without the record of who approved it, or the other way round.
'use strict';

const { ApiError } = require('../middleware/errors');
const events = require('./events');

const METHODS = ['cash', 'zelle', 'cash_app', 'bank_transfer', 'spei'];
// Cash is handed over in person; the rest leave a folio in a statement, which is the
// only thing that lets a manager tell a real transfer from a story.
const CASH_METHODS = ['cash'];
const OPEN_TX_STATUSES = ['pending', 'pending_manual'];

const PAYMENT_SELECT = `
  SELECT p.id, p.nightclub_id, p.transaction_id, p.option_id, p.method,
         p.amount::text AS amount, p.currency, p.reference, p.note, p.status,
         p.rejection_reason, p.reviewed_at, p.created_at,
         p.declared_by, du.display_name AS declared_by_name,
         p.on_behalf_of, bu.display_name AS on_behalf_of_name,
         p.reviewed_by, ru.display_name AS reviewed_by_name,
         t.type AS transaction_type, t.amount::text AS transaction_amount,
         t.status AS transaction_status, t.reference_type, t.reference_id
    FROM manual_payments p
    JOIN transactions t ON t.id = p.transaction_id
    JOIN users du ON du.id = p.declared_by
    LEFT JOIN users bu ON bu.id = p.on_behalf_of
    LEFT JOIN users ru ON ru.id = p.reviewed_by`;

/** The guest never sees who reviewed it or why an internal note said what it said. */
function present(row, viewer) {
  const base = {
    id: row.id,
    transaction_id: row.transaction_id,
    method: row.method,
    amount: row.amount,
    currency: row.currency,
    reference: row.reference,
    note: row.note,
    status: row.status,
    created_at: row.created_at,
    reviewed_at: row.reviewed_at,
    rejection_reason: row.rejection_reason,
    pays_for: { type: row.transaction_type, reference_type: row.reference_type },
  };
  if (viewer !== 'manager') return base;
  return {
    ...base,
    declared_by: { id: row.declared_by, name: row.declared_by_name },
    on_behalf_of: row.on_behalf_of ? { id: row.on_behalf_of, name: row.on_behalf_of_name } : null,
    reviewed_by: row.reviewed_by ? { id: row.reviewed_by, name: row.reviewed_by_name } : null,
    transaction: {
      id: row.transaction_id,
      type: row.transaction_type,
      amount: row.transaction_amount,
      status: row.transaction_status,
      reference_type: row.reference_type,
      reference_id: row.reference_id,
    },
  };
}

/**
 * Applies what a confirmed payment means for the thing that was paid for. A reservation
 * held as `pending_payment` is what the guest actually cares about: confirming the
 * deposit is what turns it into a table that will be there when they arrive.
 */
async function applySideEffects(client, tx, nightclubId) {
  if (tx.reference_type !== 'reservation' || tx.type !== 'reservation_deposit') return null;
  const { rows } = await client.query(
    `UPDATE reservations SET status = 'confirmed', updated_at = now()
      WHERE id = $1 AND nightclub_id = $2 AND status = 'pending_payment'
      RETURNING id, user_id, table_id, event_id`,
    [tx.reference_id, nightclubId]);
  return rows[0] || null;
}

/**
 * Moves the ledger entry to `paid` and records who said so. Shared by the manager's
 * confirmation and by a staff member registering cash already in hand, so both leave
 * exactly the same trail.
 */
async function settle(client, { payment, reviewerId, nightclubId }) {
  const txRes = await client.query(
    `SELECT id, type, amount::text AS amount, currency, status, reference_type, reference_id,
            payer_user_id
       FROM transactions WHERE id = $1 AND nightclub_id = $2 FOR UPDATE`,
    [payment.transaction_id, nightclubId]);
  if (txRes.rowCount === 0) throw ApiError.notFound('El cobro no existe');
  const tx = txRes.rows[0];

  if (tx.status === 'paid') throw ApiError.conflict('Ese cobro ya está pagado');
  if (!OPEN_TX_STATUSES.includes(tx.status)) {
    throw ApiError.conflict(`El cobro está '${tx.status}' y ya no admite pago`);
  }
  // The ledger amount cannot be edited -- it is immutable by design -- so a payment for
  // a different amount is not something to reconcile silently. The manager rejects it
  // and asks for the difference.
  if (Number(payment.amount) !== Number(tx.amount)) {
    throw ApiError.unprocessable(
      `El monto declarado (${payment.amount}) no coincide con el cobro (${tx.amount}). `
      + 'Recházalo indicando la diferencia.',
      { declared: payment.amount, expected: tx.amount },
    );
  }
  if (payment.currency !== tx.currency) {
    throw ApiError.unprocessable('La moneda declarada no coincide con la del cobro');
  }

  await client.query(
    `UPDATE transactions
        SET status = 'paid', provider = $2, confirmed_by = $3, confirmed_at = now(),
            updated_at = now()
      WHERE id = $1`,
    [tx.id, CASH_METHODS.includes(payment.method) ? 'cash' : 'manual', reviewerId]);

  const reservation = await applySideEffects(client, tx, nightclubId);
  return { tx, reservation };
}

async function publishConfirmed({ nightclubId, payment, tx, reservation }) {
  await events.publish({
    nightclubId,
    type: 'payment_confirmed',
    audience: {
      userIds: [payment.on_behalf_of || payment.declared_by, tx.payer_user_id].filter(Boolean),
      roles: ['manager'],
    },
    payload: {
      manual_payment_id: payment.id,
      transaction_id: tx.id,
      amount: payment.amount,
      currency: payment.currency,
      method: payment.method,
      pays_for: tx.type,
    },
  });
  if (reservation) {
    await events.publish({
      nightclubId,
      type: 'reservation_confirmed',
      audience: { userIds: [reservation.user_id], roles: ['hostess', 'manager'] },
      payload: { reservation_id: reservation.id, table_id: reservation.table_id },
    });
  }
}

module.exports = {
  METHODS, CASH_METHODS, OPEN_TX_STATUSES, PAYMENT_SELECT,
  present, settle, applySideEffects, publishConfirmed,
};
