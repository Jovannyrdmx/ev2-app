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

const ORDER_SELECT = `
  SELECT o.id, o.status, o.subtotal, o.currency, o.message, o.created_at, o.confirmed_at,
         o.ready_at, o.delivered_at, o.cancelled_at, o.pos_order_id, o.pos_error,
         o.table_id, t.code AS table_code,
         o.sender_id, su.display_name AS sender_name,
         o.recipient_id, ru.display_name AS recipient_name,
         o.bartender_id,
         COALESCE(items.items, '[]'::json) AS items
    FROM drink_orders o
    LEFT JOIN tables t ON t.id = o.table_id
    LEFT JOIN users su ON su.id = o.sender_id
    LEFT JOIN users ru ON ru.id = o.recipient_id
    LEFT JOIN LATERAL (
      SELECT json_agg(json_build_object(
               'drink_id', oi.drink_id, 'name', d.name, 'quantity', oi.quantity,
               -- ::text keeps money as a two-decimal string, like every other amount
               -- in the API (json_build_object would turn NUMERIC into a JSON number).
               'unit_price', oi.unit_price::text, 'notes', oi.notes) ORDER BY d.name) AS items
        FROM drink_order_items oi JOIN drinks d ON d.id = oi.drink_id
       WHERE oi.order_id = o.id
    ) items ON true`;

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

      if (b.table_id) {
        const t = await client.query('SELECT id FROM tables WHERE id = $1 AND nightclub_id = $2 AND active',
          [b.table_id, nightclubId]);
        if (t.rowCount === 0) throw ApiError.notFound('Table not found');
      }
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

      // Lock inventory rows first, in a stable order, to avoid deadlocks between
      // concurrent orders. (FOR UPDATE cannot be used on the nullable side of a LEFT JOIN.)
      const drinkIds = [...new Set(b.items.map((i) => i.drink_id))].sort();
      const locked = await client.query(
        `SELECT drink_id, quantity FROM inventory
          WHERE drink_id = ANY($1::uuid[]) ORDER BY drink_id FOR UPDATE`,
        [drinkIds],
      );
      const stockById = new Map(locked.rows.map((r) => [r.drink_id, Number(r.quantity)]));

      const drinks = await client.query(
        `SELECT id, name, price, currency, available FROM drinks
          WHERE id = ANY($1::uuid[]) AND nightclub_id = $2 AND active`,
        [drinkIds, nightclubId],
      );
      const byId = new Map(drinks.rows.map((d) => [d.id, { ...d, stock: stockById.get(d.id) ?? 0 }]));
      if (byId.size !== drinkIds.length) throw ApiError.notFound('One or more drinks do not exist');

      const wanted = new Map();
      for (const item of b.items) wanted.set(item.drink_id, (wanted.get(item.drink_id) || 0) + item.quantity);

      const unavailable = [];
      for (const [id, qty] of wanted) {
        const d = byId.get(id);
        if (!d.available) unavailable.push({ drink_id: id, name: d.name, reason: 'unavailable' });
        else if (Number(d.stock) < qty) {
          unavailable.push({ drink_id: id, name: d.name, reason: 'out_of_stock', stock: Number(d.stock) });
        }
      }
      if (unavailable.length > 0) throw ApiError.conflict('Some drinks are not available', unavailable);

      const currencies = new Set(drinks.rows.map((d) => d.currency));
      if (currencies.size > 1) throw ApiError.unprocessable('All drinks in one order must share a currency');
      const orderCurrency = currencies.values().next().value;

      let subtotal = 0;
      for (const item of b.items) subtotal += Number(byId.get(item.drink_id).price) * item.quantity;

      let order;
      try {
        const created = await client.query(
          `INSERT INTO drink_orders (nightclub_id, sender_id, recipient_id, table_id, message,
                                     subtotal, currency, client_request_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
          [nightclubId, req.user.id, b.recipient_id || null, b.table_id || null, b.message || null,
            subtotal.toFixed(2), orderCurrency, b.client_request_id],
        );
        order = created.rows[0];
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

      for (const item of b.items) {
        await client.query(
          `INSERT INTO drink_order_items (order_id, drink_id, quantity, unit_price, notes)
           VALUES ($1,$2,$3,$4,$5)`,
          [order.id, item.drink_id, item.quantity, byId.get(item.drink_id).price, item.notes || null],
        );
      }
      for (const [id, qty] of wanted) {
        await client.query('UPDATE inventory SET quantity = quantity - $2, updated_at = now() WHERE drink_id = $1',
          [id, qty]);
      }

      await events.publish({
        nightclubId, type: 'order_created', client,
        audience: { roles: ['bartender', 'manager'], userIds: [req.user.id, b.recipient_id].filter(Boolean) },
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
        'SELECT id, status, sender_id FROM drink_orders WHERE id = $1 AND nightclub_id = $2 FOR UPDATE',
        [orderId, nightclubId],
      );
      if (cur.rowCount === 0) throw ApiError.notFound('Order not found');
      const order = cur.rows[0];

      // A guest may only cancel their own order while it is still pending.
      const isStaff = staffRoles.includes(req.user.role);
      if (!isStaff) {
        if (next !== 'cancelled' || order.sender_id !== req.user.id || order.status !== 'pending') {
          throw ApiError.forbidden('Only staff can change this order');
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
        audience: { roles: ['bartender', 'manager'], userIds: [order.sender_id] },
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
