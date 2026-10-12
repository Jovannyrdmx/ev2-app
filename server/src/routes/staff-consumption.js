/**
 * EV2 — el consumo del personal (D101).
 *
 *   POST /staff-orders                    el empleado pide para si desde su telefono
 *   GET  /staff-consumption/settings      el porcentaje de descuento (null = apagado)
 *   PUT  /staff-consumption/settings      el gerente lo fija
 *   GET  /staff-consumption/me            lo que llevo en la semana de pago
 *   GET  /staff-consumption/weekly        el reporte del gerente (JSON o CSV)
 *
 * El pedido nace confirmado y NO tiene cobro en el libro: lo que consume se descuenta
 * del pago, no se cobra en la caja. Por eso no entra a la caja, a los cortes ni a las
 * ventas de la noche. Descuenta existencias como cualquier pedido, y sale su comanda
 * con el nombre y el puesto de quien lo pidio.
 */
'use strict';

const express = require('express');
const { pool } = require('../db/pool');
const { ApiError, asyncHandler } = require('../middleware/errors');
const { validate, z, uuid } = require('../middleware/validate');
const { authenticate, requireRole, sameNightclub } = require('../middleware/auth');
const events = require('../services/events');
const tickets = require('../services/tickets');
const consumption = require('../services/staff-consumption');
const { createOrder, ORDER_SELECT } = require('../services/orders');

const router = express.Router({ mergeParams: true });
router.use('/nightclubs/:nightclubId', authenticate, sameNightclub());

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'AAAA-MM-DD');

function assertStaff(req) {
  if (!consumption.STAFF_ROLES.includes(req.user.role)) {
    throw ApiError.forbidden('El consumo del personal es para el personal del club');
  }
}

router.get('/nightclubs/:nightclubId/staff-consumption/settings',
  validate({ params: z.object({ nightclubId: uuid }) }),
  asyncHandler(async (req, res) => {
    const pct = await consumption.discountPct(pool, req.params.nightclubId);
    res.json({ discount_pct: pct, enabled: pct !== null });
  }));

router.put('/nightclubs/:nightclubId/staff-consumption/settings',
  requireRole('manager'),
  validate({
    params: z.object({ nightclubId: uuid }),
    body: z.object({ discount_pct: z.number().min(0).max(100) }),
  }),
  asyncHandler(async (req, res) => {
    const { nightclubId } = req.params;
    const before = await consumption.discountPct(pool, nightclubId);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await consumption.setDiscountPct(client, {
        nightclubId, pct: req.body.discount_pct, userId: req.user.id });
      await client.query(
        `INSERT INTO audit_log (nightclub_id, actor_id, action, entity, entity_id, before, after, ip)
         VALUES ($1,$2,'staff_consumption.set_discount','nightclub',$1,$3,$4,$5)`,
        [nightclubId, req.user.id, JSON.stringify({ discount_pct: before }),
          JSON.stringify({ discount_pct: req.body.discount_pct }), req.ip || null]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    res.json({ discount_pct: req.body.discount_pct, enabled: true });
  }));

router.post('/nightclubs/:nightclubId/staff-orders',
  validate({
    params: z.object({ nightclubId: uuid }),
    body: z.object({
      client_request_id: uuid,
      bar_location_id: uuid.optional(),
      message: z.string().trim().max(280).optional(),
      items: z.array(z.object({
        drink_id: uuid,
        quantity: z.number().int().min(1).max(20).default(1),
        notes: z.string().trim().max(120).optional(),
      })).min(1).max(20),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { nightclubId } = req.params;
    const b = req.body;
    assertStaff(req);

    const existing = await pool.query(
      `${ORDER_SELECT} WHERE o.client_request_id = $1 AND o.nightclub_id = $2 AND o.sender_id = $3`,
      [b.client_request_id, nightclubId, req.user.id]);
    if (existing.rowCount > 0) {
      res.set('Idempotent-Replay', 'true');
      return res.status(200).json({ order: existing.rows[0] });
    }

    const pct = await consumption.discountPct(pool, nightclubId);
    if (pct === null) {
      throw ApiError.conflict('El consumo del personal todavía no está configurado: pide al gerente el porcentaje de descuento');
    }

    const me = await pool.query(
      `SELECT id, display_name, role, status FROM users WHERE id = $1 AND nightclub_id = $2`,
      [req.user.id, nightclubId]);
    if (me.rowCount === 0 || me.rows[0].status !== 'active') {
      throw ApiError.forbidden('Tu cuenta no está activa');
    }
    const user = me.rows[0];

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      let order;
      try {
        order = await createOrder({
          client, nightclubId, senderId: user.id, takenBy: null, message: b.message,
          items: b.items, clientRequestId: b.client_request_id,
          barLocationId: b.bar_location_id, noCharge: true,
        });
      } catch (err) {
        if (err.code === '23505') {
          await client.query('ROLLBACK');
          const again = await client.query(
            `${ORDER_SELECT} WHERE o.client_request_id = $1 AND o.nightclub_id = $2 AND o.sender_id = $3`,
            [b.client_request_id, nightclubId, user.id]);
          res.set('Idempotent-Replay', 'true');
          return res.status(200).json({ order: again.rows[0] });
        }
        throw err;
      }

      // Entra a la barra en este acto: no hay cobro que esperar.
      await client.query(
        `UPDATE drink_orders
            SET status = 'confirmed', confirmed_at = now(), updated_at = now(),
                staff_consumption = true
          WHERE id = $1`, [order.id]);
      const rec = await consumption.record(client, {
        nightclubId, user, orderId: order.id, listTotal: order.listTotal, pct,
        currency: order.currency, promoTotal: order.subtotal,
      });
      await tickets.printOrder(client, { nightclubId, orderId: order.id, userId: user.id });

      await events.publish({
        nightclubId, type: 'order_created', client,
        audience: { roles: ['bartender', 'manager', 'cashier'], userIds: [user.id] },
        payload: {
          order_id: order.id, subtotal: order.subtotal, currency: order.currency,
          staff_consumption: true, staff_name: user.display_name, staff_role: user.role,
        },
      });
      await client.query('COMMIT');

      const full = await client.query(`${ORDER_SELECT} WHERE o.id = $1`, [order.id]);
      res.status(201).json({
        order: full.rows[0],
        consumption: {
          discount_pct: pct, list_total: order.listTotal,
          amount: consumption.amountDue(order.listTotal, pct, order.subtotal),
          week_start: rec.week_start, business_date: rec.business_date,
        },
      });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }));

router.get('/nightclubs/:nightclubId/staff-consumption/me',
  validate({
    params: z.object({ nightclubId: uuid }),
    query: z.object({ week_start: isoDate.optional() }),
  }),
  asyncHandler(async (req, res) => {
    assertStaff(req);
    const { nightclubId } = req.params;
    const weekStart = await consumption.weekStartOf(pool, {
      nightclubId, date: req.query.week_start || null });
    const report = await consumption.weeklyReport(pool, { nightclubId, weekStart });
    const mine = report.employees.find((e) => e.user_id === req.user.id) || null;
    res.json({
      week_start: report.week_start, week_end: report.week_end,
      count: mine ? mine.count : 0, totals: mine ? mine.totals : {},
      consumptions: mine ? mine.consumptions : [],
    });
  }));

router.get('/nightclubs/:nightclubId/staff-consumption/weekly',
  requireRole('manager'),
  validate({
    params: z.object({ nightclubId: uuid }),
    query: z.object({ week_start: isoDate.optional(), format: z.enum(['json', 'csv']).default('json') }),
  }),
  asyncHandler(async (req, res) => {
    const { nightclubId } = req.params;
    // Cualquier fecha dentro de la semana vale: se lleva al jueves que la abre.
    const weekStart = await consumption.weekStartOf(pool, {
      nightclubId, date: req.query.week_start || null });
    const report = await consumption.weeklyReport(pool, { nightclubId, weekStart });
    if (req.query.format === 'csv') {
      res.set('Content-Type', 'text/csv; charset=utf-8');
      res.set('Content-Disposition',
        `attachment; filename="consumo-personal-${report.week_start}.csv"`);
      return res.send(consumption.reportCsv(report));
    }
    return res.json(report);
  }));

module.exports = router;
