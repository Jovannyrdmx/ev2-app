/**
 * EV2 — el corte de turno de quien cobra (D51).
 *
 * El recorrido completo, en el orden en que pasa de verdad en una noche:
 *
 *   1. El mesero mira cuánto trae (`GET .../shifts/me/cut`). Nadie teclea ese número:
 *      sale de lo que ya cobró.
 *   2. A media noche entrega una parte (`POST .../shifts/me/cash-drops`) y el gerente
 *      la cuenta (`POST .../cash-drops/:id/receive`). Un mesero con doce mil pesos en
 *      la bolsa es un problema de seguridad, no de contabilidad.
 *   3. Al final declara su corte (`POST .../shifts/me/closing`): cuánto entrega.
 *   4. El gerente cuenta y confirma (`POST .../shift-closings/:id/confirm`). Ahí, y
 *      solo ahí, el turno queda cerrado.
 *
 * Quien cobra nunca confirma su propio corte, y quien confirma nunca teclea lo
 * cobrado. Esa separación es el punto entero de este archivo.
 */
'use strict';

const express = require('express');
const { pool } = require('../db/pool');
const { ApiError, asyncHandler } = require('../middleware/errors');
const { validate, z, uuid, pagination } = require('../middleware/validate');
const { authenticate, requireRole, sameNightclub } = require('../middleware/auth');
const cuts = require('../services/shift-closings');
const events = require('../services/events');

const router = express.Router({ mergeParams: true });

router.use('/nightclubs/:nightclubId', authenticate, sameNightclub());

const STAFF_ROLES = ['waiter', 'bartender', 'hostess', 'manager'];

/** El turno abierto de alguien, o el último que cerró sin corte. */
async function shiftToCut(runner, { nightclubId, userId }) {
  const { rows } = await runner.query(
    `SELECT s.id, s.user_id, s.section, s.started_at, s.ended_at
       FROM staff_shifts s
       LEFT JOIN shift_closings c ON c.shift_id = s.id
      WHERE s.nightclub_id = $1 AND s.user_id = $2
        AND (s.ended_at IS NULL OR c.id IS NULL)
      ORDER BY s.started_at DESC
      LIMIT 1`,
    [nightclubId, userId]);
  return rows[0] || null;
}

/** Lo que traigo encima ahora mismo: cobrado, entregado y por entregar. */
router.get('/nightclubs/:nightclubId/shifts/me/cut',
  requireRole(...STAFF_ROLES),
  validate({ params: z.object({ nightclubId: uuid }) }),
  asyncHandler(async (req, res) => {
    const shift = await shiftToCut(pool, {
      nightclubId: req.params.nightclubId, userId: req.user.id,
    });
    if (!shift) {
      // Sin turno no hay corte, pero sí hay respuesta: la pantalla necesita saber que
      // no es un error suyo.
      return res.json({ shift: null, message: 'No tienes un turno abierto' });
    }
    const resumen = await cuts.shiftSummary(pool, {
      nightclubId: req.params.nightclubId, shift,
    });
    return res.json(resumen);
  }));

// ---------------------------------------------------------------- entregas parciales

router.post('/nightclubs/:nightclubId/shifts/me/cash-drops',
  requireRole(...STAFF_ROLES),
  validate({
    params: z.object({ nightclubId: uuid }),
    body: z.object({
      amount: z.number().positive().max(1_000_000),
      note: z.string().trim().max(200).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { nightclubId } = req.params;
    const shift = await shiftToCut(pool, { nightclubId, userId: req.user.id });
    if (!shift || shift.ended_at) {
      throw ApiError.conflict('No tienes un turno abierto: la entrega va dentro del turno');
    }
    const { rows } = await pool.query(
      `INSERT INTO shift_cash_drops (nightclub_id, shift_id, user_id, amount, currency, note)
       VALUES ($1,$2,$3,$4,'MXN',$5::text)
       RETURNING id, amount::text AS amount, currency, note, status, created_at`,
      [nightclubId, shift.id, req.user.id, req.body.amount, req.body.note || null]);

    // El gerente tiene que enterarse AHORA: hay alguien esperando con dinero en la mano.
    await events.publish({
      nightclubId,
      type: 'cash_drop_declared',
      audience: { roles: ['manager'] },
      payload: {
        drop_id: rows[0].id, user_id: req.user.id, amount: rows[0].amount,
        user_name: req.user.display_name || null,
      },
    });
    res.status(201).json({ drop: rows[0] });
  }));

/** Las entregas que esperan a que alguien las cuente. */
router.get('/nightclubs/:nightclubId/cash-drops',
  requireRole('manager'),
  validate({
    params: z.object({ nightclubId: uuid }),
    query: pagination.extend({
      status: z.enum(['declared', 'received', 'rejected']).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT d.id, d.amount::text AS amount, d.counted_amount::text AS counted_amount,
              d.currency, d.note, d.status, d.rejection_reason, d.created_at, d.received_at,
              d.user_id, u.display_name AS user_name, u.role,
              r.display_name AS received_by_name
         FROM shift_cash_drops d
         JOIN users u ON u.id = d.user_id
         LEFT JOIN users r ON r.id = d.received_by
        WHERE d.nightclub_id = $1 AND ($2::text IS NULL OR d.status = $2::text)
        ORDER BY d.status = 'declared' DESC, d.created_at DESC
        LIMIT $3 OFFSET $4`,
      [req.params.nightclubId, req.query.status || null, req.query.limit, req.query.offset]);
    res.json({ drops: rows });
  }));

router.post('/nightclubs/:nightclubId/cash-drops/:dropId/receive',
  requireRole('manager'),
  validate({
    params: z.object({ nightclubId: uuid, dropId: uuid }),
    body: z.object({
      // Lo que el gerente CONTÓ. Por omisión, lo declarado: en la mayoría de las
      // entregas coincide, y obligar a teclearlo otra vez invita a teclearlo mal.
      counted_amount: z.number().min(0).max(1_000_000).optional(),
      note: z.string().trim().max(200).optional(),
    }).default({}),
  }),
  asyncHandler(async (req, res) => {
    const { nightclubId, dropId } = req.params;
    const { rows } = await pool.query(
      `UPDATE shift_cash_drops
          SET status = 'received',
              counted_amount = COALESCE($3::numeric, amount),
              received_by = $4, received_at = now(), updated_at = now()
        WHERE id = $1 AND nightclub_id = $2 AND status = 'declared'
        RETURNING id, user_id, amount::text AS amount, counted_amount::text AS counted_amount,
                  currency, status`,
      [dropId, nightclubId, req.body.counted_amount ?? null, req.user.id]);
    if (rows.length === 0) {
      throw ApiError.conflict('Esa entrega no existe o ya estaba contada');
    }
    const drop = rows[0];
    await events.publish({
      nightclubId,
      type: 'cash_drop_received',
      audience: { roles: ['manager'], userIds: [drop.user_id] },
      payload: { drop_id: drop.id, counted_amount: drop.counted_amount },
    });
    res.json({ drop });
  }));

router.post('/nightclubs/:nightclubId/cash-drops/:dropId/reject',
  requireRole('manager'),
  validate({
    params: z.object({ nightclubId: uuid, dropId: uuid }),
    body: z.object({ reason: z.string().trim().min(5).max(200) }),
  }),
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(
      `UPDATE shift_cash_drops
          SET status = 'rejected', rejection_reason = $3::text,
              received_by = $4, received_at = now(), updated_at = now()
        WHERE id = $1 AND nightclub_id = $2 AND status = 'declared'
        RETURNING id, user_id, status, rejection_reason`,
      [req.params.dropId, req.params.nightclubId, req.body.reason, req.user.id]);
    if (rows.length === 0) throw ApiError.conflict('Esa entrega no existe o ya estaba resuelta');
    await events.publish({
      nightclubId: req.params.nightclubId,
      type: 'cash_drop_rejected',
      audience: { roles: ['manager'], userIds: [rows[0].user_id] },
      payload: { drop_id: rows[0].id, reason: rows[0].rejection_reason },
    });
    res.json({ drop: rows[0] });
  }));

// ---------------------------------------------------------------- el corte

router.post('/nightclubs/:nightclubId/shifts/me/closing',
  requireRole(...STAFF_ROLES),
  validate({
    params: z.object({ nightclubId: uuid }),
    body: z.object({
      declared_cash: z.number().min(0).max(1_000_000),
      notes: z.string().trim().max(280).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { nightclubId } = req.params;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const shift = await shiftToCut(client, { nightclubId, userId: req.user.id });
      if (!shift) throw ApiError.conflict('No tienes un turno que cortar');
      const hecho = await cuts.declare(client, {
        nightclubId,
        shift,
        role: req.user.role,
        declaredCash: req.body.declared_cash,
        notes: req.body.notes,
      });
      await client.query('COMMIT');
      await events.publish({
        nightclubId,
        type: 'shift_closing_declared',
        audience: { roles: ['manager'] },
        payload: {
          closing_id: hecho.id, user_id: req.user.id,
          declared_cash: Number(req.body.declared_cash).toFixed(2),
          expected_cash: hecho.expected_cash,
        },
      });
      const detalle = await pool.query(
        `SELECT id, status, declared_cash::text AS declared_cash,
                expected_cash::text AS expected_cash, declared_at
           FROM shift_closings WHERE id = $1`, [hecho.id]);
      res.status(201).json({ closing: detalle.rows[0] });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }));

const CLOSING_SELECT = `
  SELECT c.id, c.shift_id, c.user_id, c.role, c.started_at, c.ended_at, c.currency,
         c.totals, c.cash_collected::text AS cash_collected,
         c.drops_total::text AS drops_total, c.expected_cash::text AS expected_cash,
         c.declared_cash::text AS declared_cash, c.declared_notes, c.declared_at,
         c.counted_cash::text AS counted_cash, c.difference::text AS difference,
         c.difference_reason, c.status, c.confirmed_at,
         u.display_name AS user_name, m.display_name AS confirmed_by_name
    FROM shift_closings c
    JOIN users u ON u.id = c.user_id
    LEFT JOIN users m ON m.id = c.confirmed_by`;

router.get('/nightclubs/:nightclubId/shift-closings',
  requireRole('manager'),
  validate({
    params: z.object({ nightclubId: uuid }),
    query: pagination.extend({
      status: z.enum(['declared', 'confirmed']).optional(),
      hours: z.coerce.number().int().min(1).max(24 * 90).default(24),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(
      `${CLOSING_SELECT}
        WHERE c.nightclub_id = $1
          AND ($2::text IS NULL OR c.status = $2::text)
          AND c.declared_at > now() - make_interval(hours => $3)
        ORDER BY c.status = 'declared' DESC, c.declared_at DESC
        LIMIT $4 OFFSET $5`,
      [req.params.nightclubId, req.query.status || null, req.query.hours,
        req.query.limit, req.query.offset]);
    res.json({ closings: rows });
  }));

router.get('/nightclubs/:nightclubId/shift-closings/:closingId',
  requireRole(...STAFF_ROLES),
  validate({ params: z.object({ nightclubId: uuid, closingId: uuid }) }),
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(
      `${CLOSING_SELECT} WHERE c.id = $1 AND c.nightclub_id = $2`,
      [req.params.closingId, req.params.nightclubId]);
    if (rows.length === 0) throw ApiError.notFound('Ese corte no existe');
    const corte = rows[0];
    // El suyo lo ve cualquiera; el de los demás, solo quien manda.
    const esGerente = ['manager', 'admin'].includes(req.user.role);
    if (!esGerente && corte.user_id !== req.user.id) throw ApiError.forbidden('Ese corte no es tuyo');
    res.json({ closing: corte, drops: await cuts.dropsOf(pool, corte.shift_id) });
  }));

router.post('/nightclubs/:nightclubId/shift-closings/:closingId/confirm',
  requireRole('manager'),
  validate({
    params: z.object({ nightclubId: uuid, closingId: uuid }),
    body: z.object({
      counted_cash: z.number().min(0).max(1_000_000),
      reason: z.string().trim().max(280).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { nightclubId, closingId } = req.params;
    const client = await pool.connect();
    let hecho;
    try {
      await client.query('BEGIN');
      hecho = await cuts.confirm(client, {
        nightclubId,
        closingId,
        countedCash: req.body.counted_cash,
        reason: req.body.reason,
        managerId: req.user.id,
      });
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    await events.publish({
      nightclubId,
      type: 'shift_closing_confirmed',
      audience: { roles: ['manager'], userIds: [hecho.userId] },
      payload: { closing_id: closingId, difference: hecho.difference },
    });
    const { rows } = await pool.query(`${CLOSING_SELECT} WHERE c.id = $1`, [closingId]);
    res.json({ closing: rows[0] });
  }));

module.exports = router;
