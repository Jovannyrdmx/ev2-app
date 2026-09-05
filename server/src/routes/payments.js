// Manual payments: cash, Zelle, Cash App, transfers and SPEI (docs/DECISIONES.md D28).
//
// Nothing here charges anybody -- card processing is 3.4 and 3.5. A manual payment is a
// claim, and it only reaches the ledger when a manager confirms it against the bank
// statement. Everything the club can actually do tonight goes through this file, because
// today the club is paid in cash.
'use strict';

const express = require('express');
const { pool } = require('../db/pool');
const { ApiError, asyncHandler } = require('../middleware/errors');
const { validate, z, uuid, currency, pagination } = require('../middleware/validate');
const { authenticate, requireRole, sameNightclub } = require('../middleware/auth');
const payments = require('../services/payments');
const events = require('../services/events');
const paymentConfig = require('../config/payments');

const router = express.Router({ mergeParams: true });

const method = z.enum(payments.METHODS);
const STAFF_ROLES = ['hostess', 'manager'];

function isManager(user) {
  return user.role === 'manager' || user.role === 'admin';
}
function isStaff(user) {
  return isManager(user) || STAFF_ROLES.includes(user.role);
}

router.use('/nightclubs/:nightclubId', authenticate, sameNightclub());

// ------------------------------------------------------------------ providers

/**
 * What the app can charge with right now. The manager sees which keys are still missing
 * so setting up Stripe or Mercado Pago is a checklist, not a guess; the guest sees only
 * what they can actually pay with, plus the publishable key their browser needs.
 */
router.get('/nightclubs/:nightclubId/payment-providers',
  validate({ params: z.object({ nightclubId: uuid }) }),
  asyncHandler(async (req, res) => {
    const state = paymentConfig.status();
    if (isManager(req.user)) return res.json(state);
    return res.json({
      manual_available: state.manual_available,
      providers: state.providers
        .filter((p) => p.configured)
        .map(({ provider, mode, publishable_key: pk, public_key: mpk, currencies, methods }) => ({
          provider, mode, publishable_key: pk ?? mpk, currencies, methods,
        })),
    });
  }));

// ------------------------------------------------------------------ where to pay

router.get('/nightclubs/:nightclubId/manual-payment-options',
  validate({
    params: z.object({ nightclubId: uuid }),
    query: z.object({ include_inactive: z.coerce.boolean().default(false) }),
  }),
  asyncHandler(async (req, res) => {
    const includeInactive = isManager(req.user) && req.query.include_inactive;
    const { rows } = await pool.query(
      `SELECT id, method, label, destination, instructions, currency, requires_reference,
              active, sort_order
         FROM manual_payment_options
        WHERE nightclub_id = $1 AND ($2::boolean OR active)
        ORDER BY sort_order, method, label`,
      [req.params.nightclubId, includeInactive]);
    res.json({ options: rows });
  }));

const optionBody = z.object({
  method,
  label: z.string().trim().min(1).max(80),
  destination: z.string().trim().max(120).nullable().optional(),
  instructions: z.string().trim().max(2000).nullable().optional(),
  currency: currency.optional(),
  requires_reference: z.boolean().optional(),
  sort_order: z.number().int().optional(),
});

router.post('/nightclubs/:nightclubId/manual-payment-options',
  requireRole('manager'),
  validate({ params: z.object({ nightclubId: uuid }), body: optionBody }),
  asyncHandler(async (req, res) => {
    const b = req.body;
    // A transfer nobody can address is not a payment option; cash needs no destination.
    if (!payments.CASH_METHODS.includes(b.method) && !b.destination) {
      throw ApiError.unprocessable('Indica a dónde se envía el dinero (cuenta, CLABE o usuario)');
    }
    try {
      const { rows } = await pool.query(
        `INSERT INTO manual_payment_options (nightclub_id, method, label, destination, instructions,
                                             currency, requires_reference, sort_order, updated_by)
         VALUES ($1,$2::text,$3,$4,$5,COALESCE($6,'MXN'),
                 -- $2 is cast: without it Postgres deduces varchar from the column and
                 -- text from the ANY() comparison, and refuses the statement (42P08).
                 COALESCE($7, NOT ($2::text = ANY($10::text[]))), COALESCE($8,0), $9)
         RETURNING id, method, label, destination, instructions, currency, requires_reference,
                   active, sort_order`,
        [req.params.nightclubId, b.method, b.label, b.destination ?? null, b.instructions ?? null,
          b.currency ?? null, b.requires_reference ?? null, b.sort_order ?? null, req.user.id,
          payments.CASH_METHODS]);
      res.status(201).json({ option: rows[0] });
    } catch (err) {
      if (err.code === '23505') throw ApiError.conflict('Ya existe una opción con ese nombre');
      throw err;
    }
  }));

router.put('/nightclubs/:nightclubId/manual-payment-options/:optionId',
  requireRole('manager'),
  validate({
    params: z.object({ nightclubId: uuid, optionId: uuid }),
    body: optionBody.partial().extend({ active: z.boolean().optional() })
      .refine((b) => Object.keys(b).length > 0, { message: 'No fields to update' }),
  }),
  asyncHandler(async (req, res) => {
    const b = req.body;
    const { rows } = await pool.query(
      `UPDATE manual_payment_options SET
         method = COALESCE($3, method), label = COALESCE($4, label),
         destination = CASE WHEN $5::boolean THEN $6 ELSE destination END,
         instructions = CASE WHEN $7::boolean THEN $8 ELSE instructions END,
         currency = COALESCE($9, currency),
         requires_reference = COALESCE($10, requires_reference),
         active = COALESCE($11, active), sort_order = COALESCE($12, sort_order),
         updated_by = $13, updated_at = now()
       WHERE id = $1 AND nightclub_id = $2
       RETURNING id, method, label, destination, instructions, currency, requires_reference,
                 active, sort_order`,
      [req.params.optionId, req.params.nightclubId, b.method ?? null, b.label ?? null,
        Object.hasOwn(b, 'destination'), b.destination ?? null,
        Object.hasOwn(b, 'instructions'), b.instructions ?? null,
        b.currency ?? null, b.requires_reference ?? null, b.active ?? null,
        b.sort_order ?? null, req.user.id]);
    if (rows.length === 0) throw ApiError.notFound('Opción no encontrada');
    res.json({ option: rows[0] });
  }));

router.delete('/nightclubs/:nightclubId/manual-payment-options/:optionId',
  requireRole('manager'),
  validate({ params: z.object({ nightclubId: uuid, optionId: uuid }) }),
  asyncHandler(async (req, res) => {
    // Retired, not deleted: payments already declared point at it.
    const { rows } = await pool.query(
      `UPDATE manual_payment_options SET active = false, updated_by = $3, updated_at = now()
        WHERE id = $1 AND nightclub_id = $2 RETURNING id, label, active`,
      [req.params.optionId, req.params.nightclubId, req.user.id]);
    if (rows.length === 0) throw ApiError.notFound('Opción no encontrada');
    res.json({ option: rows[0] });
  }));

// ------------------------------------------------------------------ declaring a payment

/** Loads an open ledger entry the caller is allowed to pay for. */
async function loadPayableTransaction(client, { transactionId, nightclubId, user, onBehalfOf }) {
  const { rows } = await client.query(
    `SELECT id, type, amount::text AS amount, currency, status, payer_user_id
       FROM transactions WHERE id = $1 AND nightclub_id = $2 FOR UPDATE`,
    [transactionId, nightclubId]);
  if (rows.length === 0) throw ApiError.notFound('Cobro no encontrado');
  const tx = rows[0];

  const payer = onBehalfOf || user.id;
  // A guest declares only their own charges. Staff may declare for whoever handed them
  // the money, which is the whole point of taking cash at the door.
  if (!isStaff(user) && tx.payer_user_id !== user.id) throw ApiError.notFound('Cobro no encontrado');
  if (isStaff(user) && onBehalfOf && tx.payer_user_id && tx.payer_user_id !== onBehalfOf) {
    throw ApiError.unprocessable('Ese cobro es de otra persona');
  }
  if (tx.status === 'paid') throw ApiError.conflict('Ese cobro ya está pagado');
  if (!payments.OPEN_TX_STATUSES.includes(tx.status)) {
    throw ApiError.conflict(`El cobro está '${tx.status}' y ya no admite pago`);
  }
  return { tx, payer };
}

const declareBody = z.object({
  transaction_id: uuid,
  option_id: uuid.optional(),
  method,
  amount: z.number().positive().max(1_000_000),
  currency,
  reference: z.string().trim().min(3).max(60).optional(),
  note: z.string().trim().max(280).optional(),
  on_behalf_of: uuid.optional(),
  client_request_id: uuid.optional(),
});

router.post('/nightclubs/:nightclubId/manual-payments',
  validate({ params: z.object({ nightclubId: uuid }), body: declareBody }),
  asyncHandler(async (req, res) => {
    const { nightclubId } = req.params;
    const b = req.body;
    if (b.on_behalf_of && !isStaff(req.user)) {
      throw ApiError.forbidden('Solo el personal registra pagos a nombre de otra persona');
    }

    if (b.client_request_id) {
      const existing = await pool.query(`${payments.PAYMENT_SELECT} WHERE p.client_request_id = $1`,
        [b.client_request_id]);
      if (existing.rowCount > 0) {
        return res.status(200).json({
          payment: payments.present(existing.rows[0], isManager(req.user) ? 'manager' : 'guest'),
          idempotent: true,
        });
      }
    }

    let option = null;
    if (b.option_id) {
      const found = await pool.query(
        `SELECT id, method, requires_reference FROM manual_payment_options
          WHERE id = $1 AND nightclub_id = $2 AND active`, [b.option_id, nightclubId]);
      if (found.rowCount === 0) throw ApiError.unprocessable('Esa forma de pago no está disponible');
      option = found.rows[0];
      if (option.method !== b.method) {
        throw ApiError.unprocessable('El método no corresponde a la opción elegida');
      }
    }
    // Without a folio a transfer cannot be matched against the statement, so it would be
    // a claim the manager has no way to check.
    const needsReference = option ? option.requires_reference : !payments.CASH_METHODS.includes(b.method);
    if (needsReference && !b.reference) {
      throw ApiError.unprocessable('Captura el folio o la referencia de la transferencia');
    }

    const client = await pool.connect();
    let created;
    try {
      await client.query('BEGIN');
      const { tx, payer } = await loadPayableTransaction(client, {
        transactionId: b.transaction_id, nightclubId, user: req.user, onBehalfOf: b.on_behalf_of,
      });
      try {
        const { rows } = await client.query(
          `INSERT INTO manual_payments (nightclub_id, transaction_id, option_id, method, declared_by,
                                        on_behalf_of, amount, currency, reference, note,
                                        client_request_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
          [nightclubId, tx.id, b.option_id ?? null, b.method, req.user.id,
            b.on_behalf_of ?? (payer !== req.user.id ? payer : null), b.amount, b.currency,
            b.reference ?? null, b.note ?? null, b.client_request_id ?? null]);
        created = rows[0];
      } catch (err) {
        if (err.code === '23505') {
          const detail = String(err.detail || '');
          if (detail.includes('reference')) {
            throw ApiError.conflict('Esa referencia ya se usó para otro pago');
          }
          throw ApiError.conflict('Ese cobro ya tiene un pago declarado o confirmado');
        }
        throw err;
      }
      await client.query(
        `UPDATE transactions SET status = 'pending_manual', updated_at = now()
          WHERE id = $1 AND status = 'pending'`, [tx.id]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    const full = await pool.query(`${payments.PAYMENT_SELECT} WHERE p.id = $1`, [created.id]);
    return res.status(201).json({
      payment: payments.present(full.rows[0], isManager(req.user) ? 'manager' : 'guest'),
    });
  }));

router.get('/nightclubs/:nightclubId/manual-payments/mine',
  validate({ params: z.object({ nightclubId: uuid }), query: pagination }),
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(
      `${payments.PAYMENT_SELECT}
        WHERE p.nightclub_id = $1 AND (p.declared_by = $2 OR p.on_behalf_of = $2)
        ORDER BY p.created_at DESC LIMIT $3 OFFSET $4`,
      [req.params.nightclubId, req.user.id, req.query.limit, req.query.offset]);
    res.json({ payments: rows.map((r) => payments.present(r, 'guest')) });
  }));

router.post('/nightclubs/:nightclubId/manual-payments/:paymentId/cancel',
  validate({ params: z.object({ nightclubId: uuid, paymentId: uuid }) }),
  asyncHandler(async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const found = await client.query(
        `SELECT id, declared_by, on_behalf_of, status, transaction_id FROM manual_payments
          WHERE id = $1 AND nightclub_id = $2 FOR UPDATE`,
        [req.params.paymentId, req.params.nightclubId]);
      if (found.rowCount === 0) throw ApiError.notFound('Pago no encontrado');
      const p = found.rows[0];
      const mine = p.declared_by === req.user.id || p.on_behalf_of === req.user.id;
      if (!mine && !isManager(req.user)) throw ApiError.notFound('Pago no encontrado');
      if (p.status !== 'declared') {
        throw ApiError.conflict(`El pago ya está '${p.status}' y no se puede retirar`);
      }
      await client.query(
        `UPDATE manual_payments SET status = 'cancelled', updated_at = now() WHERE id = $1`, [p.id]);
      // The charge goes back to plain pending so it can be declared again.
      await client.query(
        `UPDATE transactions SET status = 'pending', updated_at = now()
          WHERE id = $1 AND status = 'pending_manual'`, [p.transaction_id]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    const full = await pool.query(`${payments.PAYMENT_SELECT} WHERE p.id = $1`, [req.params.paymentId]);
    res.json({ payment: payments.present(full.rows[0], isManager(req.user) ? 'manager' : 'guest') });
  }));

// ------------------------------------------------------------------ manager: the queue

router.get('/nightclubs/:nightclubId/manual-payments',
  requireRole('manager'),
  validate({
    params: z.object({ nightclubId: uuid }),
    query: pagination.extend({
      status: z.enum(['declared', 'confirmed', 'rejected', 'cancelled']).optional(),
      method: method.optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const q = req.query;
    const [rows, pending] = await Promise.all([
      pool.query(
        `${payments.PAYMENT_SELECT}
          WHERE p.nightclub_id = $1
            AND ($2::text IS NULL OR p.status = $2)
            AND ($3::text IS NULL OR p.method = $3)
          ORDER BY (p.status = 'declared') DESC, p.created_at
          LIMIT $4 OFFSET $5`,
        [req.params.nightclubId, q.status || null, q.method || null, q.limit, q.offset]),
      pool.query(
        `SELECT currency, count(*)::int AS count, sum(amount)::numeric(12,2)::text AS total
           FROM manual_payments WHERE nightclub_id = $1 AND status = 'declared'
          GROUP BY currency`, [req.params.nightclubId]),
    ]);
    res.json({
      payments: rows.rows.map((r) => payments.present(r, 'manager')),
      awaiting_review: pending.rows,
    });
  }));

router.get('/nightclubs/:nightclubId/manual-payments/:paymentId',
  validate({ params: z.object({ nightclubId: uuid, paymentId: uuid }) }),
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(
      `${payments.PAYMENT_SELECT} WHERE p.id = $1 AND p.nightclub_id = $2`,
      [req.params.paymentId, req.params.nightclubId]);
    if (rows.length === 0) throw ApiError.notFound('Pago no encontrado');
    const row = rows[0];
    const mine = row.declared_by === req.user.id || row.on_behalf_of === req.user.id;
    if (!mine && !isManager(req.user)) throw ApiError.notFound('Pago no encontrado');
    res.json({ payment: payments.present(row, isManager(req.user) ? 'manager' : 'guest') });
  }));

router.post('/nightclubs/:nightclubId/manual-payments/:paymentId/confirm',
  requireRole('manager'),
  validate({ params: z.object({ nightclubId: uuid, paymentId: uuid }) }),
  asyncHandler(async (req, res) => {
    const { nightclubId, paymentId } = req.params;
    const client = await pool.connect();
    let outcome;
    try {
      await client.query('BEGIN');
      const found = await client.query(
        `SELECT id, transaction_id, method, amount::text AS amount, currency, status,
                declared_by, on_behalf_of
           FROM manual_payments WHERE id = $1 AND nightclub_id = $2 FOR UPDATE`,
        [paymentId, nightclubId]);
      if (found.rowCount === 0) throw ApiError.notFound('Pago no encontrado');
      const payment = found.rows[0];
      if (payment.status !== 'declared') {
        throw ApiError.conflict(`El pago ya está '${payment.status}'`);
      }

      const { tx, reservation } = await payments.settle(client, {
        payment, reviewerId: req.user.id, nightclubId,
      });
      await client.query(
        `UPDATE manual_payments SET status = 'confirmed', reviewed_by = $2, reviewed_at = now(),
                updated_at = now()
          WHERE id = $1`, [payment.id, req.user.id]);
      await client.query('COMMIT');
      outcome = { payment, tx, reservation };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    await payments.publishConfirmed({ nightclubId, ...outcome });
    const full = await pool.query(`${payments.PAYMENT_SELECT} WHERE p.id = $1`, [paymentId]);
    res.json({
      payment: payments.present(full.rows[0], 'manager'),
      reservation_confirmed: outcome.reservation ? outcome.reservation.id : null,
    });
  }));

router.post('/nightclubs/:nightclubId/manual-payments/:paymentId/reject',
  requireRole('manager'),
  validate({
    params: z.object({ nightclubId: uuid, paymentId: uuid }),
    body: z.object({ reason: z.string().trim().min(5).max(200) }),
  }),
  asyncHandler(async (req, res) => {
    const { nightclubId, paymentId } = req.params;
    const client = await pool.connect();
    let payment;
    try {
      await client.query('BEGIN');
      const found = await client.query(
        `SELECT id, transaction_id, status, declared_by, on_behalf_of
           FROM manual_payments WHERE id = $1 AND nightclub_id = $2 FOR UPDATE`,
        [paymentId, nightclubId]);
      if (found.rowCount === 0) throw ApiError.notFound('Pago no encontrado');
      payment = found.rows[0];
      if (payment.status !== 'declared') throw ApiError.conflict(`El pago ya está '${payment.status}'`);

      await client.query(
        `UPDATE manual_payments SET status = 'rejected', reviewed_by = $2, reviewed_at = now(),
                rejection_reason = $3, updated_at = now()
          WHERE id = $1`, [payment.id, req.user.id, req.body.reason]);
      // Back to pending, not failed: the guest can correct the folio and declare again.
      await client.query(
        `UPDATE transactions SET status = 'pending', updated_at = now()
          WHERE id = $1 AND status = 'pending_manual'`, [payment.transaction_id]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    await events.publish({
      nightclubId,
      type: 'payment_rejected',
      audience: { userIds: [payment.on_behalf_of || payment.declared_by], roles: ['manager'] },
      payload: { manual_payment_id: payment.id, reason: req.body.reason },
    });
    const full = await pool.query(`${payments.PAYMENT_SELECT} WHERE p.id = $1`, [paymentId]);
    res.json({ payment: payments.present(full.rows[0], 'manager') });
  }));

/**
 * Cash taken at the door: declared and confirmed in one step by whoever received it.
 * There is no second party to verify it, so the record says plainly who took the money.
 */
router.post('/nightclubs/:nightclubId/manual-payments/register',
  requireRole(...STAFF_ROLES),
  validate({
    params: z.object({ nightclubId: uuid }),
    body: declareBody.omit({ on_behalf_of: true }).extend({ on_behalf_of: uuid.optional() }),
  }),
  asyncHandler(async (req, res) => {
    const { nightclubId } = req.params;
    const b = req.body;
    if (!payments.CASH_METHODS.includes(b.method) && !b.reference) {
      throw ApiError.unprocessable('Captura el folio o la referencia de la transferencia');
    }

    const client = await pool.connect();
    let outcome;
    try {
      await client.query('BEGIN');
      const { tx } = await loadPayableTransaction(client, {
        transactionId: b.transaction_id, nightclubId, user: req.user, onBehalfOf: b.on_behalf_of,
      });
      let created;
      try {
        const { rows } = await client.query(
          `INSERT INTO manual_payments (nightclub_id, transaction_id, option_id, method, declared_by,
                                        on_behalf_of, amount, currency, reference, note, status,
                                        reviewed_by, reviewed_at, client_request_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'confirmed',$5,now(),$11)
           RETURNING id, transaction_id, method, amount::text AS amount, currency, status,
                     declared_by, on_behalf_of`,
          [nightclubId, tx.id, b.option_id ?? null, b.method, req.user.id, b.on_behalf_of ?? null,
            b.amount, b.currency, b.reference ?? null, b.note ?? null, b.client_request_id ?? null]);
        created = rows[0];
      } catch (err) {
        if (err.code === '23505') throw ApiError.conflict('Ese cobro ya tiene un pago registrado');
        throw err;
      }
      const settled = await payments.settle(client, {
        payment: created, reviewerId: req.user.id, nightclubId,
      });
      await client.query('COMMIT');
      outcome = { payment: created, ...settled };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    await payments.publishConfirmed({ nightclubId, ...outcome });
    const full = await pool.query(`${payments.PAYMENT_SELECT} WHERE p.id = $1`, [outcome.payment.id]);
    res.status(201).json({
      payment: payments.present(full.rows[0], 'manager'),
      reservation_confirmed: outcome.reservation ? outcome.reservation.id : null,
    });
  }));

module.exports = router;
