'use strict';

/**
 * El saldo de los meseros y su tope (D110).
 *
 *   GET  /waiters/balances  caja y gerencia: lo que trae cada mesero, en vivo.
 *   GET  /waiters/me/balance el mesero: lo suyo, y si ya pasó el tope.
 *   GET  /waiter-limits      el tope del club.
 *   PUT  /waiter-limits      gerencia: lo fija; null en un campo = sin ese tope.
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

module.exports = router;
