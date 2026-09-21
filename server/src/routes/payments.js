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
const mercadopago = require('../services/mercadopago');
const terminalCharges = require('../services/terminal-charges');

const router = express.Router({ mergeParams: true });

const method = z.enum(payments.METHODS);
// Who may take money for the club. The waiter is on this list because the table is
// where most of it is taken: an order is charged the moment it is placed, and he is
// the one standing there with the terminal.
const STAFF_ROLES = ['hostess', 'waiter', 'bartender', 'manager'];

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

  // Y la otra vía. Esto cierra un cobro doble real:
  //
  //   El mesero toca cobrar con terminal, la terminal se enciende. El cliente dice
  //   "mejor efectivo". Se registra el efectivo y el renglón queda pagado — pero la
  //   terminal SIGUE encendida, porque nadie la apagó. El siguiente que pase una
  //   tarjeta ahí paga la misma cuenta otra vez, y ese cargo es real.
  //
  // El `FOR UPDATE` de arriba serializa las dos vías sobre el mismo renglón, así que
  // esta comprobación no tiene carrera: o llega primero el efectivo y el cobro con
  // terminal ve el renglón pagado, o llega primero la terminal y el efectivo ve esto.
  const enTerminal = await client.query(
    `SELECT c.id, t.label FROM terminal_charges c
       JOIN payment_terminals t ON t.id = c.terminal_id
      WHERE c.transaction_id = $1
        AND c.status IN ('creating','waiting','action_required')`,
    [tx.id]);
  if (enTerminal.rowCount > 0) {
    throw ApiError.conflict(
      `Ese cobro tiene la terminal "${enTerminal.rows[0].label}" esperando la tarjeta. `
      + 'Cancélalo ahí antes de cobrar de otra forma, o la terminal cobra otra vez.',
      { terminal_charge_id: enTerminal.rows[0].id });
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
      // El filtro por club NO sobra: `client_request_id` lo escoge el cliente y viaja
      // en el cuerpo. Sin él, quien conozca una clave de otro club recibía su pago
      // completo, con folio bancario y los nombres de quien lo declaró y lo revisó.
      const existing = await pool.query(
        `${payments.PAYMENT_SELECT} WHERE p.client_request_id = $1 AND p.nightclub_id = $2`,
        [b.client_request_id, nightclubId]);
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

      const { tx, reservation, order } = await payments.settle(client, {
        payment, reviewerId: req.user.id, nightclubId,
      });
      await client.query(
        `UPDATE manual_payments SET status = 'confirmed', reviewed_by = $2, reviewed_at = now(),
                updated_at = now()
          WHERE id = $1`, [payment.id, req.user.id]);
      await client.query('COMMIT');
      outcome = { payment, tx, reservation, order };
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
    // This route confirms in one step, with no second pair of eyes, so it only accepts
    // what is settled on the spot: money in hand, or a voucher the bank already
    // approved. A transfer still goes through the manager, who has the statement in
    // front of him -- otherwise anyone on shift could clear a payment nobody sent.
    if (!payments.ON_THE_SPOT_METHODS.includes(b.method)) {
      throw ApiError.unprocessable(
        'Aquí solo se registra lo que ya está cobrado: efectivo o terminal. '
        + 'Una transferencia la confirma el gerente contra el estado de cuenta.',
        { allowed: payments.ON_THE_SPOT_METHODS });
    }
    if (!payments.CASH_METHODS.includes(b.method) && !b.reference) {
      throw ApiError.unprocessable('Captura el folio del voucher de la terminal');
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

// ==========================================================================
// Cobrar con la terminal del club (D47)
// ==========================================================================
//
// La diferencia con todo lo de arriba: esto SÍ cobra. Lo de arriba registra dinero que
// ya cambió de manos; aquí el sistema despierta una terminal, la persona pasa su
// tarjeta, y Mercado Pago contesta si pasó. Nadie teclea un monto y nadie teclea un
// folio, que son los dos sitios por donde se cuela un error en una noche llena.

/** Las terminales que el club tiene dadas de alta. */
router.get('/nightclubs/:nightclubId/payment-terminals',
  requireRole(...STAFF_ROLES),
  validate({ params: z.object({ nightclubId: uuid }) }),
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT id, external_id, label, operating_mode, operating_mode_at, active, sort_order
         FROM payment_terminals
        WHERE nightclub_id = $1 AND (${isManager(req.user)} OR active)
        ORDER BY active DESC, sort_order, label`,
      [req.params.nightclubId]);
    res.json({ terminals: rows, provider: paymentConfig.mercadoPagoConfig() });
  }));

/**
 * Preguntarle a Mercado Pago qué terminales tiene la cuenta.
 *
 * No da de alta nada: enseña lo que hay para que el gerente le ponga nombre. Una
 * terminal se llama "NEWLAND_N950__N950NCB801293324" y eso no se le dice a nadie a las
 * dos de la mañana.
 */
router.post('/nightclubs/:nightclubId/payment-terminals/discover',
  requireRole('manager'),
  validate({ params: z.object({ nightclubId: uuid }) }),
  asyncHandler(async (req, res) => {
    const found = await mercadopago.listTerminals();
    const { rows } = await pool.query(
      'SELECT external_id FROM payment_terminals WHERE nightclub_id = $1',
      [req.params.nightclubId]);
    const yaEstan = new Set(rows.map((r) => r.external_id));
    res.json({
      terminals: found.map((t) => ({ ...t, registered: yaEstan.has(t.external_id) })),
    });
  }));

router.post('/nightclubs/:nightclubId/payment-terminals',
  requireRole('manager'),
  validate({
    params: z.object({ nightclubId: uuid }),
    body: z.object({
      external_id: z.string().trim().min(3).max(120),
      label: z.string().trim().min(1).max(60),
      sort_order: z.number().int().min(0).max(999).default(0),
      // Pasarla a PDV en el mismo movimiento. Es lo que casi siempre se quiere: una
      // terminal recién sacada de la caja viene en STANDALONE y no obedece a nadie.
      set_pdv: z.boolean().default(true),
    }),
  }),
  asyncHandler(async (req, res) => {
    const b = req.body;
    let mode = null;
    if (b.set_pdv && !mercadopago.isSandboxTerminal(b.external_id)) {
      await mercadopago.setOperatingMode(b.external_id, 'PDV');
      mode = 'PDV';
    } else if (mercadopago.isSandboxTerminal(b.external_id)) {
      // El dispositivo virtual no tiene modo que cambiar: no existe.
      mode = 'PDV';
    }
    try {
      const { rows } = await pool.query(
        `INSERT INTO payment_terminals
           (nightclub_id, external_id, label, sort_order, operating_mode, operating_mode_at,
            registered_by)
         VALUES ($1,$2,$3,$4,$5::text, CASE WHEN $5::text IS NULL THEN NULL ELSE now() END, $6)
         RETURNING id, external_id, label, operating_mode, active, sort_order`,
        [req.params.nightclubId, b.external_id, b.label, b.sort_order, mode, req.user.id]);
      res.status(201).json({ terminal: rows[0] });
    } catch (err) {
      if (err.code === '23505') {
        throw ApiError.conflict('Ya hay una terminal con ese nombre o ese identificador');
      }
      throw err;
    }
  }));

router.patch('/nightclubs/:nightclubId/payment-terminals/:terminalId',
  requireRole('manager'),
  validate({
    params: z.object({ nightclubId: uuid, terminalId: uuid }),
    body: z.object({
      label: z.string().trim().min(1).max(60).optional(),
      active: z.boolean().optional(),
      sort_order: z.number().int().min(0).max(999).optional(),
      set_pdv: z.boolean().optional(),
    }).refine((v) => Object.keys(v).length > 0, { message: 'No hay nada que cambiar' }),
  }),
  asyncHandler(async (req, res) => {
    const { nightclubId, terminalId } = req.params;
    const found = await pool.query(
      'SELECT id, external_id FROM payment_terminals WHERE id = $1 AND nightclub_id = $2',
      [terminalId, nightclubId]);
    if (found.rowCount === 0) throw ApiError.notFound('Esa terminal no existe');

    let mode = null;
    if (req.body.set_pdv) {
      await mercadopago.setOperatingMode(found.rows[0].external_id, 'PDV');
      mode = 'PDV';
    }
    const { rows } = await pool.query(
      `UPDATE payment_terminals
          SET label = COALESCE($3::text, label),
              active = COALESCE($4::boolean, active),
              sort_order = COALESCE($5::int, sort_order),
              operating_mode = COALESCE($6::text, operating_mode),
              operating_mode_at = CASE WHEN $6::text IS NULL THEN operating_mode_at ELSE now() END,
              updated_at = now()
        WHERE id = $1 AND nightclub_id = $2
        RETURNING id, external_id, label, operating_mode, active, sort_order`,
      [terminalId, nightclubId, req.body.label ?? null, req.body.active ?? null,
        req.body.sort_order ?? null, mode]);
    res.json({ terminal: rows[0] });
  }));

// ------------------------------------------------------------------ el cobro

/**
 * Empezar un cobro: la terminal se enciende sola con el monto.
 *
 * Contesta en cuanto Mercado Pago acepta la orden, NO cuando el cliente paga. La
 * pantalla se queda mirando el socket. Esperar aquí a que alguien saque la tarjeta es
 * tener una conexión colgada por cada cobro de la noche, y perder el cobro entero
 * cuando el wifi del club parpadea.
 */
router.post('/nightclubs/:nightclubId/terminal-charges',
  requireRole(...STAFF_ROLES),
  validate({
    params: z.object({ nightclubId: uuid }),
    body: z.object({ transaction_id: uuid, terminal_id: uuid }),
  }),
  asyncHandler(async (req, res) => {
    mercadopago.assertUsable();
    const { nightclubId } = req.params;

    const client = await pool.connect();
    let apartado;
    try {
      await client.query('BEGIN');
      apartado = await terminalCharges.reserve(client, {
        nightclubId,
        transactionId: req.body.transaction_id,
        terminalId: req.body.terminal_id,
        userId: req.user.id,
      });
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    // Fuera de la transacción: la red no puede tener bloqueado un renglón del libro.
    await terminalCharges.push(pool, {
      charge: { ...apartado.charge, started_by: req.user.id },
      tx: apartado.tx,
      terminal: apartado.terminal,
      nightclubId,
    });

    const { rows } = await pool.query(`${terminalCharges.CHARGE_SELECT} WHERE c.id = $1`,
      [apartado.charge.id]);
    res.status(201).json({ charge: terminalCharges.present(rows[0]) });
  }));

/**
 * Cómo va ese cobro.
 *
 * Si sigue esperando, aprovecha y le pregunta a Mercado Pago antes de contestar: quien
 * abre esta ruta es alguien mirando una pantalla que no cambia, y el webhook pudo no
 * llegar.
 */
router.get('/nightclubs/:nightclubId/terminal-charges/:chargeId',
  requireRole(...STAFF_ROLES),
  validate({ params: z.object({ nightclubId: uuid, chargeId: uuid }) }),
  asyncHandler(async (req, res) => {
    const { nightclubId, chargeId } = req.params;
    const first = await pool.query(
      `${terminalCharges.CHARGE_SELECT} WHERE c.id = $1 AND c.nightclub_id = $2`,
      [chargeId, nightclubId]);
    if (first.rowCount === 0) throw ApiError.notFound('Ese cobro no existe');
    let row = first.rows[0];

    if (!terminalCharges.present(row).is_final && row.external_order_id) {
      try {
        const order = await mercadopago.getOrder(row.external_order_id);
        const read = mercadopago.readOrder(order);
        if (read && read.status && read.status !== row.status) {
          const applied = await terminalCharges.apply(pool, {
            chargeId, read, source: 'poll', rawPayload: order,
          });
          if (applied.changed) {
            await terminalCharges.announce({
              nightclubId, chargeId, status: applied.status,
              outcome: applied.outcome, startedBy: row.started_by,
            });
          }
          const again = await pool.query(`${terminalCharges.CHARGE_SELECT} WHERE c.id = $1`,
            [chargeId]);
          row = again.rows[0];
        }
      } catch {
        // Si Mercado Pago no contesta, se enseña lo que hay guardado en vez de fallar:
        // una pantalla que dice "esperando" es más útil que una que dice "error" cuando
        // el cobro puede estar pasando en ese momento.
      }
    }
    res.json({ charge: terminalCharges.present(row) });
  }));

/** Cancelar un cobro que la terminal todavía no cobró. */
router.post('/nightclubs/:nightclubId/terminal-charges/:chargeId/cancel',
  requireRole(...STAFF_ROLES),
  validate({ params: z.object({ nightclubId: uuid, chargeId: uuid }) }),
  asyncHandler(async (req, res) => {
    const { nightclubId, chargeId } = req.params;
    const found = await pool.query(
      `SELECT id, status, external_order_id, started_by FROM terminal_charges
        WHERE id = $1 AND nightclub_id = $2`,
      [chargeId, nightclubId]);
    if (found.rowCount === 0) throw ApiError.notFound('Ese cobro no existe');
    const charge = found.rows[0];
    if (mercadopago.FINAL_STATUSES.includes(charge.status)) {
      throw ApiError.conflict(`Ese cobro ya está '${charge.status}' y no se puede cancelar`);
    }

    if (charge.external_order_id) {
      // Se cancela PRIMERO del lado de Mercado Pago. Al revés, la terminal se quedaría
      // encendida pidiendo una tarjeta por un cobro que el sistema ya dio por muerto —
      // y alguien la pasaría.
      await mercadopago.cancelOrder(charge.external_order_id);
    }
    const applied = await terminalCharges.apply(pool, {
      chargeId, read: { status: 'canceled', status_detail: 'cancelado desde el sistema' },
      source: 'staff',
    });
    await terminalCharges.announce({
      nightclubId, chargeId, status: 'canceled', outcome: null, startedBy: charge.started_by,
    });
    const { rows } = await pool.query(`${terminalCharges.CHARGE_SELECT} WHERE c.id = $1`, [chargeId]);
    res.json({ charge: terminalCharges.present(rows[0]), changed: applied.changed });
  }));

/**
 * El simulador. Solo con credenciales de prueba — el propio cliente se niega si no.
 *
 * Existe para que la prueba completa se pueda correr sin una terminal en la mano: se
 * crea el cobro, se simula "aprobado", y se comprueba que el libro se movió. Sin esto,
 * probar el camino del dinero exigiría hardware.
 */
router.post('/nightclubs/:nightclubId/terminal-charges/:chargeId/simulate',
  requireRole('manager'),
  validate({
    params: z.object({ nightclubId: uuid, chargeId: uuid }),
    body: z.object({
      status: z.enum(['processed', 'failed', 'canceled', 'expired', 'action_required']),
      status_detail: z.string().trim().max(60).optional(),
      payment_method_id: z.string().trim().max(30).default('visa'),
      payment_method_type: z.string().trim().max(30).default('credit_card'),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { nightclubId, chargeId } = req.params;
    const found = await pool.query(
      `SELECT id, external_order_id FROM terminal_charges
        WHERE id = $1 AND nightclub_id = $2`, [chargeId, nightclubId]);
    if (found.rowCount === 0) throw ApiError.notFound('Ese cobro no existe');
    if (!found.rows[0].external_order_id) {
      throw ApiError.conflict('Ese cobro nunca llegó a Mercado Pago: no hay nada que simular');
    }
    await mercadopago.simulateOrderEvent(found.rows[0].external_order_id, {
      status: req.body.status,
      status_detail: req.body.status_detail
        || (req.body.status === 'processed' ? 'accredited' : 'simulated'),
      payment_method_type: req.body.payment_method_type,
      payment_method_id: req.body.payment_method_id,
      installments: 1,
    });
    res.status(202).json({ simulated: req.body.status });
  }));

// ------------------------------------------------------------------ el webhook

/**
 * Lo que Mercado Pago nos avisa.
 *
 * PÚBLICA: no lleva sesión, porque quien la llama es un servidor de Mercado Pago. Dos
 * cosas la hacen segura, y ninguna es la firma:
 *
 *   1. El cuerpo de la notificación NO se cree. Solo se lee de él el id de la orden,
 *      y con ese id se vuelve a preguntar `GET /v1/orders/{id}` con NUESTRO token.
 *      Cualquiera puede mandar un JSON que diga "pagado"; nadie puede hacer que la API
 *      de Mercado Pago lo confirme.
 *   2. Ese id tiene que corresponder a un cobro que ESTE club empezó. Uno que no
 *      conocemos se contesta 200 y se tira: contestar otra cosa haría que Mercado Pago
 *      reintentara toda la noche.
 *
 * La firma se comprueba igual y se anota, pero no decide. Hay un motivo concreto: hoy
 * la validación de firma de la Orders API tiene un desacuerdo abierto en los propios SDK
 * de Mercado Pago. Colgar el cobro de ella sería dejar que un defecto ajeno le diga al
 * club que un pago real no ocurrió.
 *
 * Siempre 200. Un 500 aquí es Mercado Pago reintentando cada pocos minutos, y un
 * problema nuestro convertido en tormenta.
 */
router.post('/payments/mercadopago/webhook', express.json({ limit: '64kb' }),
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    const orderId = String(
      (body.data && body.data.id) || req.query['data.id'] || body.id || '').trim();
    const requestId = req.get('x-request-id') || null;

    // Se contesta rápido pase lo que pase; lo que sigue decide si había algo que hacer.
    if (!orderId) return res.status(200).json({ ignored: 'sin id' });

    const found = await pool.query(
      `SELECT id, nightclub_id, status, started_by FROM terminal_charges
        WHERE provider = 'mercadopago' AND external_order_id = $1`, [orderId]);
    if (found.rowCount === 0) return res.status(200).json({ ignored: 'desconocido' });
    const charge = found.rows[0];

    const firma = mercadopago.verifySignature({
      signatureHeader: req.get('x-signature'),
      requestId,
      dataId: orderId,
      secret: process.env.MERCADOPAGO_WEBHOOK_SECRET || '',
    });
    await terminalCharges.record(pool, {
      chargeId: charge.id, source: 'webhook', action: `notify_${body.action || 'unknown'}`,
      requestId, payload: { signature: firma, body },
    });

    try {
      const order = await mercadopago.getOrder(orderId);
      if (!order) return res.status(200).json({ ignored: 'la orden ya no existe' });
      const read = mercadopago.readOrder(order);
      const applied = await terminalCharges.apply(pool, {
        chargeId: charge.id, read, source: 'webhook', requestId, rawPayload: order,
      });
      if (applied.changed) {
        await terminalCharges.announce({
          nightclubId: charge.nightclub_id,
          chargeId: charge.id,
          status: applied.status,
          outcome: applied.outcome,
          startedBy: charge.started_by,
        });
      }
      return res.status(200).json({ applied: applied.changed });
    } catch (err) {
      // No se pudo consultar. 200 igual: el repaso de respaldo lo recoge, y un error
      // aquí solo conseguiría que Mercado Pago repita la misma notificación fallida.
      await terminalCharges.record(pool, {
        chargeId: charge.id, source: 'webhook', action: 'lookup_failed',
        payload: { message: err.message },
      });
      return res.status(200).json({ deferred: true });
    }
  }));

module.exports = router;
