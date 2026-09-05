// Drink orders: creation (idempotent, stock-checked) and the bartender workflow.
'use strict';

const express = require('express');
const { pool } = require('../db/pool');
const { ApiError, asyncHandler } = require('../middleware/errors');
const { validate, z, uuid, pagination } = require('../middleware/validate');
const { authenticate, requireRole, sameNightclub } = require('../middleware/auth');
const events = require('../services/events');

const router = express.Router({ mergeParams: true });

router.use('/nightclubs/:nightclubId', authenticate, sameNightclub());

// Allowed state transitions. 'pos_error' is set by the POS sync (phase 4).
const TRANSITIONS = {
  pending: ['confirmed', 'cancelled'],
  confirmed: ['preparing', 'cancelled'],
  preparing: ['ready', 'cancelled'],
  ready: ['delivered'],
  delivered: [],
  cancelled: [],
  pos_error: ['confirmed', 'cancelled'],
};

const { createOrder, ORDER_SELECT } = require('../services/orders');

const createSchema = z.object({
  client_request_id: uuid,
  table_id: uuid.optional(),
  recipient_id: uuid.optional(),
  message: z.string().trim().max(280).optional(),
  items: z.array(z.object({
    drink_id: uuid,
    quantity: z.number().int().min(1).max(20).default(1),
    notes: z.string().trim().max(120).optional(),
  })).min(1).max(20),
});

router.post('/nightclubs/:nightclubId/orders',
  validate({ params: z.object({ nightclubId: uuid }), body: createSchema }),
  asyncHandler(async (req, res) => {
    const { nightclubId } = req.params;
    const b = req.body;

    // Idempotency: the same client_request_id returns the original order.
    const existing = await pool.query(
      `${ORDER_SELECT} WHERE o.client_request_id = $1 AND o.nightclub_id = $2`,
      [b.client_request_id, nightclubId],
    );
    if (existing.rowCount > 0) {
      res.set('Idempotent-Replay', 'true');
      return res.status(200).json({ order: existing.rows[0] });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      if (b.recipient_id) {
        const r = await client.query(
          `SELECT u.id FROM users u WHERE u.id = $1 AND u.nightclub_id = $2 AND u.status = 'active'`,
          [b.recipient_id, nightclubId]);
        if (r.rowCount === 0) throw ApiError.notFound('Recipient not found');
        const blocked = await client.query(
          'SELECT 1 FROM user_blocks WHERE blocker_id = $1 AND blocked_id = $2',
          [b.recipient_id, req.user.id]);
        if (blocked.rowCount > 0) throw ApiError.forbidden('You cannot send drinks to this user');
      }

      let order;
      try {
        order = await createOrder({
          client, nightclubId, senderId: req.user.id, recipientId: b.recipient_id,
          tableId: b.table_id, message: b.message, items: b.items, clientRequestId: b.client_request_id,
        });
      } catch (err) {
        // Concurrent request with the same idempotency key.
        if (err.code === '23505') {
          await client.query('ROLLBACK');
          const again = await pool.query(
            `${ORDER_SELECT} WHERE o.client_request_id = $1 AND o.nightclub_id = $2`,
            [b.client_request_id, nightclubId]);
          res.set('Idempotent-Replay', 'true');
          return res.status(200).json({ order: again.rows[0] });
        }
        throw err;
      }
      const { subtotal, currency: orderCurrency } = order;

      await events.publish({
        nightclubId, type: 'order_created', client,
        // El mesero va en la audiencia: es quien lleva la charola a la mesa, y sin esto
        // su pantalla no se enteraba de nada — se quedaba viendo una lista vacía
        // mientras los tragos se calentaban en la barra.
        audience: {
          roles: ['bartender', 'waiter', 'manager'],
          userIds: [req.user.id, b.recipient_id].filter(Boolean),
        },
        payload: { order_id: order.id, table_id: b.table_id || null, subtotal, currency: orderCurrency },
      });

      await client.query('COMMIT');
      const full = await pool.query(`${ORDER_SELECT} WHERE o.id = $1`, [order.id]);
      return res.status(201).json({ order: full.rows[0] });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }));

// Bartender/manager queue.
router.get('/nightclubs/:nightclubId/orders',
  requireRole('bartender', 'waiter', 'manager'),
  validate({
    params: z.object({ nightclubId: uuid }),
    query: pagination.extend({
      status: z.enum(['pending', 'confirmed', 'preparing', 'ready', 'delivered', 'cancelled', 'pos_error']).optional(),
      active: z.coerce.boolean().default(false),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { status, active, limit, offset } = req.query;
    const { rows } = await pool.query(
      `${ORDER_SELECT}
        WHERE o.nightclub_id = $1
          AND ($2::text IS NULL OR o.status = $2)
          AND ($3::boolean IS FALSE OR o.status IN ('pending','confirmed','preparing','ready','pos_error'))
        ORDER BY o.created_at ASC
        LIMIT $4 OFFSET $5`,
      [req.params.nightclubId, status || null, active, limit, offset],
    );
    res.json({ orders: rows });
  }));

// A guest's own orders (sent and received).
router.get('/nightclubs/:nightclubId/orders/mine',
  validate({ params: z.object({ nightclubId: uuid }), query: pagination }),
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(
      `${ORDER_SELECT}
        WHERE o.nightclub_id = $1 AND (o.sender_id = $2 OR o.recipient_id = $2)
        ORDER BY o.created_at DESC LIMIT $3 OFFSET $4`,
      [req.params.nightclubId, req.user.id, req.query.limit, req.query.offset],
    );
    res.json({ orders: rows });
  }));

router.get('/nightclubs/:nightclubId/orders/:orderId',
  validate({ params: z.object({ nightclubId: uuid, orderId: uuid }) }),
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(`${ORDER_SELECT} WHERE o.id = $1 AND o.nightclub_id = $2`,
      [req.params.orderId, req.params.nightclubId]);
    if (rows.length === 0) throw ApiError.notFound('Order not found');
    const order = rows[0];
    const isParty = [order.sender_id, order.recipient_id].includes(req.user.id);
    const isStaff = ['bartender', 'waiter', 'manager', 'admin'].includes(req.user.role);
    if (!isParty && !isStaff) throw ApiError.forbidden('Not your order');
    res.json({ order });
  }));

const TIMESTAMP_FOR = {
  confirmed: 'confirmed_at',
  ready: 'ready_at',
  delivered: 'delivered_at',
  cancelled: 'cancelled_at',
};

router.post('/nightclubs/:nightclubId/orders/:orderId/status',
  validate({
    params: z.object({ nightclubId: uuid, orderId: uuid }),
    body: z.object({
      status: z.enum(['confirmed', 'preparing', 'ready', 'delivered', 'cancelled']),
      reason: z.string().trim().max(200).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { nightclubId, orderId } = req.params;
    const next = req.body.status;
    const staffRoles = ['bartender', 'waiter', 'manager', 'admin'];

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const cur = await client.query(
        'SELECT id, status, sender_id, recipient_id FROM drink_orders WHERE id = $1 AND nightclub_id = $2 FOR UPDATE',
        [orderId, nightclubId],
      );
      if (cur.rowCount === 0) throw ApiError.notFound('Order not found');
      const order = cur.rows[0];

      // A guest may only cancel their own order while it is still pending, and never a
      // gift: a drink sent to someone else is charged when placed (D18).
      const isStaff = staffRoles.includes(req.user.role);
      if (!isStaff) {
        if (next !== 'cancelled' || order.sender_id !== req.user.id || order.status !== 'pending') {
          throw ApiError.forbidden('Only staff can change this order');
        }
        if (order.recipient_id) {
          throw ApiError.forbidden('Una invitación ya enviada no se cancela ni se reembolsa');
        }
      }

      if (!TRANSITIONS[order.status].includes(next)) {
        throw ApiError.conflict(`Cannot go from '${order.status}' to '${next}'`,
          { allowed: TRANSITIONS[order.status] });
      }

      const stamp = TIMESTAMP_FOR[next];
      const setBartender = ['confirmed', 'preparing'].includes(next) && isStaff;
      const { rows } = await client.query(
        `UPDATE drink_orders
            SET status = $3
                ${stamp ? `, ${stamp} = now()` : ''}
                ${setBartender ? ', bartender_id = COALESCE(bartender_id, $4)' : ''}
          WHERE id = $1 AND nightclub_id = $2
          RETURNING id, status`,
        setBartender ? [orderId, nightclubId, next, req.user.id] : [orderId, nightclubId, next],
      );

      // Cancelling returns the stock.
      if (next === 'cancelled') {
        await client.query(
          `UPDATE inventory i SET quantity = i.quantity + s.qty, updated_at = now()
             FROM (SELECT drink_id, sum(quantity) AS qty FROM drink_order_items
                    WHERE order_id = $1 GROUP BY drink_id) s
            WHERE i.drink_id = s.drink_id`,
          [orderId],
        );
      }

      await events.publish({
        nightclubId, type: `order_${next}`, client,
        audience: { roles: ['bartender', 'waiter', 'manager'], userIds: [order.sender_id] },
        payload: { order_id: orderId, status: next, reason: req.body.reason || null },
      });
      await client.query('COMMIT');
      res.json({ order: rows[0] });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }));

module.exports = router;
