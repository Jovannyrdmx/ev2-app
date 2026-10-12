'use strict';

/**
 * El saldo de los meseros y su tope (D110).
 *
 *   GET  /waiters/balances  caja y gerencia: lo que trae cada mesero, en vivo.
 *   GET  /waiters/me/balance el mesero: lo suyo, y si ya pasó el tope.
 *   GET  /waiter-limits      el tope del club.
 *   PUT  /waiter-limits      gerencia: lo fija; null en un campo = sin ese tope.
 *   GET  /reports/control    gerencia: por persona, cancelaciones, mermas, cortesías,
 *                            diferencias de corte y vouchers manuales (D111).
 */
const express = require('express');
const { pool } = require('../db/pool');
const { asyncHandler } = require('../middleware/errors');
const { validate, z, uuid } = require('../middleware/validate');
const { authenticate, requireRole, sameNightclub } = require('../middleware/auth');
const waiterBalance = require('../services/waiter-balance');

const router = express.Router({ mergeParams: true });
router.use('/nightclubs/:nightclubId', authenticate, sameNightclub());

router.get('/nightclubs/:nightclubId/waiters/balances',
  requireRole('cashier', 'manager', 'admin'),
  validate({ params: z.object({ nightclubId: uuid }) }),
  asyncHandler(async (req, res) => {
    const { nightclubId } = req.params;
    const [lim, saldos] = await Promise.all([
      waiterBalance.limits(pool, nightclubId),
      waiterBalance.balances(pool, { nightclubId }),
    ]);
    res.json({
      limits: lim,
      waiters: saldos.map((s) => ({ ...s, over_limit: waiterBalance.overLimit(s, lim) })),
    });
  }));

router.get('/nightclubs/:nightclubId/waiters/me/balance',
  requireRole('waiter'),
  validate({ params: z.object({ nightclubId: uuid }) }),
  asyncHandler(async (req, res) => {
    const { nightclubId } = req.params;
    const lim = await waiterBalance.limits(pool, nightclubId);
    const [saldo] = await waiterBalance.balances(pool, { nightclubId, userId: req.user.id });
    const vacio = {
      user_id: req.user.id, open_orders: 0, unpaid_total: '0.00', delivered_unpaid_orders: 0,
      delivered_unpaid_total: '0.00', oldest_delivered_at: null, oldest_delivered_minutes: 0,
    };
    const mio = saldo || vacio;
    res.json({ limits: lim, balance: { ...mio, over_limit: waiterBalance.overLimit(mio, lim) } });
  }));

router.get('/nightclubs/:nightclubId/waiter-limits',
  requireRole('cashier', 'manager', 'admin'),
  validate({ params: z.object({ nightclubId: uuid }) }),
  asyncHandler(async (req, res) => {
    res.json({ limits: await waiterBalance.limits(pool, req.params.nightclubId) });
  }));

router.put('/nightclubs/:nightclubId/waiter-limits',
  requireRole('manager', 'admin'),
  validate({
    params: z.object({ nightclubId: uuid }),
    body: z.object({
      max_unpaid_amount: z.number().positive().max(1_000_000).nullable(),
      max_unpaid_minutes: z.number().int().positive().max(24 * 60).nullable(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { nightclubId } = req.params;
    const client = await pool.connect();
    let lim;
    try {
      await client.query('BEGIN');
      lim = await waiterBalance.setLimits(client, {
        nightclubId, maxAmount: req.body.max_unpaid_amount,
        maxMinutes: req.body.max_unpaid_minutes, userId: req.user.id,
      });
      await client.query(
        `INSERT INTO audit_log (nightclub_id, actor_id, action, entity, after, ip)
         VALUES ($1,$2,'waiter_limits.update','waiter_limits',$3,$4)`,
        [nightclubId, req.user.id, JSON.stringify(req.body), req.ip || null]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    res.json({ limits: lim });
  }));

router.get('/nightclubs/:nightclubId/reports/control',
  requireRole('manager', 'admin'),
  validate({
    params: z.object({ nightclubId: uuid }),
    query: z.object({ hours: z.coerce.number().int().min(1).max(24 * 31).default(18) }),
  }),
  asyncHandler(async (req, res) => {
    const { nightclubId } = req.params;
    const { hours } = req.query;
    const { rows } = await pool.query(
      `WITH w AS (SELECT now() - ($2::int * interval '1 hour') AS since),
       c AS (SELECT cancelled_by AS user_id, count(*)::int AS n,
                    count(*) FILTER (WHERE cancel_served)::int AS served
               FROM drink_orders, w WHERE nightclub_id = $1 AND status = 'cancelled'
                AND updated_at > w.since AND cancelled_by IS NOT NULL GROUP BY 1),
       m AS (SELECT created_by AS user_id, count(*)::int AS n,
                    COALESCE(sum(-quantity), 0)::float8 AS qty
               FROM supply_movements, w WHERE nightclub_id = $1 AND kind = 'waste'
                AND created_at > w.since AND created_by IS NOT NULL GROUP BY 1),
       d AS (SELECT sold_by AS user_id, count(*)::int AS n
               FROM door_admissions, w WHERE nightclub_id = $1 AND payment_method = 'courtesy'
                AND created_at > w.since GROUP BY 1),
       s AS (SELECT user_id, count(*) FILTER (WHERE difference <> 0)::int AS n,
                    COALESCE(sum(difference), 0)::numeric(12,2)::text AS total
               FROM shift_closings, w WHERE nightclub_id = $1 AND declared_at > w.since GROUP BY 1),
       v AS (SELECT declared_by AS user_id, count(*)::int AS n,
                    COALESCE(sum(amount), 0)::numeric(12,2)::text AS total
               FROM manual_payments, w WHERE nightclub_id = $1 AND authorized_by IS NOT NULL
                AND created_at > w.since GROUP BY 1)
       SELECT u.id AS user_id, u.display_name AS name, u.role,
              COALESCE(c.n, 0) AS cancellations, COALESCE(c.served, 0) AS cancellations_served,
              COALESCE(m.n, 0) AS wastes, COALESCE(m.qty, 0) AS waste_quantity,
              COALESCE(d.n, 0) AS door_courtesies,
              COALESCE(s.n, 0) AS cut_differences, COALESCE(s.total, '0.00') AS cut_difference_total,
              COALESCE(v.n, 0) AS manual_vouchers, COALESCE(v.total, '0.00') AS manual_voucher_total
         FROM users u
         LEFT JOIN c ON c.user_id = u.id LEFT JOIN m ON m.user_id = u.id
         LEFT JOIN d ON d.user_id = u.id LEFT JOIN s ON s.user_id = u.id
         LEFT JOIN v ON v.user_id = u.id
        WHERE u.nightclub_id = $1
          AND (c.n IS NOT NULL OR m.n IS NOT NULL OR d.n IS NOT NULL OR s.n IS NOT NULL OR v.n IS NOT NULL)
        ORDER BY u.display_name`, [nightclubId, hours]);
    res.json({ hours, people: rows });
  }));

module.exports = router;
