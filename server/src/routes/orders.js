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

const STAFF_ROLES = ['bartender', 'waiter', 'manager', 'admin'];
const TAKING_ROLES = ['waiter', 'bartender', 'manager', 'admin'];

const createSchema = z.object({
  client_request_id: uuid,
  table_id: uuid.optional(),
  recipient_id: uuid.optional(),
  // Only staff may send this: the waiter standing at the table says who he is serving,
  // so the charge lands on the guest and not on the waiter's own name.
  on_behalf_of: uuid.optional(),
  message: z.string().trim().max(280).optional(),
  items: z.array(z.object({
    drink_id: uuid,
    quantity: z.number().int().min(1).max(20).default(1),
    notes: z.string().trim().max(120).optional(),
  })).min(1).max(20),
});

/**
 * Who the order is for, and who took it.
 *
 * A guest ordering from their own phone is both. A waiter is neither: he is the one
 * holding the tray. When he names the guest he is serving, the charge is the guest's;
 * when the guest is not registered in the app -- most of general admission -- the
 * charge stays on the waiter, because he is the one who took the money and the one the
 * cut at closing will ask about. What is never true is that nobody owes it.
 */
async function resolveParties(client, { req, nightclubId, tableId }) {
  const isStaff = STAFF_ROLES.includes(req.user.role);
  const onBehalfOf = req.body.on_behalf_of;

  if (!isStaff) {
    if (onBehalfOf) throw ApiError.forbidden('Solo el personal levanta pedidos para otra persona');
    return { senderId: req.user.id, takenBy: null };
  }
  if (!TAKING_ROLES.includes(req.user.role)) {
    throw ApiError.forbidden('Este rol no levanta pedidos');
  }
  if (!onBehalfOf) return { senderId: req.user.id, takenBy: req.user.id };

  const guest = await client.query(
    `SELECT u.id FROM users u WHERE u.id = $1 AND u.nightclub_id = $2 AND u.status = 'active'`,
    [onBehalfOf, nightclubId]);
  if (guest.rowCount === 0) throw ApiError.notFound('Esa persona no existe en el club');

  // The guest has to actually be at the table the waiter says he is serving. Without
  // this, a mistyped id charges a drink to somebody sitting across the room.
  if (tableId) {
    const seated = await client.query(
      `SELECT 1 FROM table_occupants
        WHERE table_id = $1 AND user_id = $2 AND left_at IS NULL`,
      [tableId, onBehalfOf]);
    if (seated.rowCount === 0) throw ApiError.unprocessable('Esa persona no está en esa mesa');
  }
  return { senderId: onBehalfOf, takenBy: req.user.id };
}

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

      const parties = await resolveParties(client, { req, nightclubId, tableId: b.table_id });

      let order;
      try {
        order = await createOrder({
          client, nightclubId, senderId: parties.senderId, recipientId: b.recipient_id,
          tableId: b.table_id, takenBy: parties.takenBy, message: b.message, items: b.items,
          clientRequestId: b.client_request_id,
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
          userIds: [req.user.id, parties.senderId, b.recipient_id].filter(Boolean),
        },
        payload: {
          order_id: order.id, table_id: b.table_id || null, subtotal, currency: orderCurrency,
          transaction_id: order.transactionId, awaiting_payment: Boolean(order.transactionId),
        },
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
    let refundDue = false;
    try {
      await client.query('BEGIN');
      const cur = await client.query(
        `SELECT o.id, o.status, o.sender_id, o.recipient_id,
                tx.id AS transaction_id, tx.status AS payment_status
           FROM drink_orders o
           LEFT JOIN transactions tx
                  ON tx.reference_type = 'drink_order' AND tx.reference_id = o.id
          WHERE o.id = $1 AND o.nightclub_id = $2
          FOR UPDATE OF o`,
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

      // The bar does not pour on credit. Confirming is what sends the ticket to the
      // bar, so that is where the charge is checked -- once, in the one place every
      // path goes through, instead of trusting each screen to remember.
      if (next === 'confirmed' && order.transaction_id && order.payment_status !== 'paid') {
        throw ApiError.conflict('Ese pedido todavía no está pagado', {
          transaction_id: order.transaction_id,
          payment_status: order.payment_status,
        });
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
        // ...and closes the charge, but only while it is still unpaid. Money already
        // received is never erased from the ledger: that is a refund, with its own
        // entry and its own signature (step 3.7), not a row quietly turned off.
        //
        // A paid order still cancels -- the bar ran out, the bottle broke, and refusing
        // would leave the staff stuck with a drink they cannot serve. What it does not
        // do is pretend the money came back. The charge stays `paid` and the event says
        // a refund is owed, so it lands in front of the manager instead of evaporating.
        if (order.transaction_id) {
          await client.query(
            `UPDATE transactions SET status = 'cancelled', updated_at = now()
              WHERE id = $1 AND status IN ('pending','pending_manual')`,
            [order.transaction_id]);
        }
        refundDue = order.payment_status === 'paid';
      }

      await events.publish({
        nightclubId, type: `order_${next}`, client,
        audience: { roles: ['bartender', 'waiter', 'manager'], userIds: [order.sender_id] },
        payload: {
          order_id: orderId, status: next, reason: req.body.reason || null,
          transaction_id: order.transaction_id || null,
          refund_due: refundDue,
        },
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
