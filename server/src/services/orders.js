// Drink order creation, shared by the orders route and by flirt gifts.
//
// Runs inside the caller's transaction (`client`) so a gift flirt and its order are
// committed or rolled back together. Locks inventory in a stable order, validates
// availability and currency, inserts the order and its items and decrements stock.
// Idempotency (client_request_id) is checked by the caller before calling this.
'use strict';

const { ApiError } = require('../middleware/errors');

const ORDER_SELECT = `
  SELECT o.id, o.status, o.subtotal, o.currency, o.message, o.created_at, o.confirmed_at,
         o.ready_at, o.delivered_at, o.cancelled_at, o.pos_order_id, o.pos_error,
         o.table_id, t.code AS table_code,
         o.sender_id, su.display_name AS sender_name,
         o.recipient_id, ru.display_name AS recipient_name,
         o.taken_by, wu.display_name AS taken_by_name,
         o.bartender_id, o.returned_to_sender, o.returned_at,
         tx.id AS transaction_id,
         -- 'not_required' is not a ledger status: it is the honest answer for an order
         -- that costs nothing (a zero-price item), which has no charge to wait for.
         COALESCE(tx.status, 'not_required') AS payment_status,
         COALESCE(items.items, '[]'::json) AS items
    FROM drink_orders o
    LEFT JOIN tables t ON t.id = o.table_id
    LEFT JOIN users su ON su.id = o.sender_id
    LEFT JOIN users ru ON ru.id = o.recipient_id
    LEFT JOIN users wu ON wu.id = o.taken_by
    LEFT JOIN transactions tx
           ON tx.reference_type = 'drink_order' AND tx.reference_id = o.id
    LEFT JOIN LATERAL (
      SELECT json_agg(json_build_object(
               'drink_id', oi.drink_id, 'name', d.name, 'quantity', oi.quantity,
               -- ::text keeps money as a two-decimal string, like every other amount
               -- in the API (json_build_object would turn NUMERIC into a JSON number).
               'unit_price', oi.unit_price::text, 'notes', oi.notes) ORDER BY d.name) AS items
        FROM drink_order_items oi JOIN drinks d ON d.id = oi.drink_id
       WHERE oi.order_id = o.id
    ) items ON true`;

/**
 * @param {object} p
 * @param {object} p.client        pg client with an open transaction
 * @param {string} p.nightclubId
 * @param {string} p.senderId      who pays
 * @param {string} [p.recipientId] who receives (gifts)
 * @param {string} [p.tableId]     where it is delivered
 * @param {string} [p.takenBy]     the waiter who took it; absent when the guest ordered
 * @param {string} [p.message]
 * @param {Array}  p.items         [{ drink_id, quantity, notes? }]
 * @param {string} p.clientRequestId
 * @param {string} [p.chargeType]     ledger type; 'drink_order' unless it is a bottle
 * @param {object} [p.chargeMetadata] extra ledger context (a gift, who it is for)
 * @returns {{ id, subtotal: number, currency: string, transactionId: string|null }}
 */
async function createOrder({ client, nightclubId, senderId, recipientId, tableId, takenBy,
  message, items, clientRequestId, chargeType, chargeMetadata }) {
  if (tableId) {
    const t = await client.query('SELECT id FROM tables WHERE id = $1 AND nightclub_id = $2 AND active',
      [tableId, nightclubId]);
    if (t.rowCount === 0) throw ApiError.notFound('Table not found');
  }

  // Lock inventory rows first, in a stable order, to avoid deadlocks between
  // concurrent orders. (FOR UPDATE cannot be used on the nullable side of a LEFT JOIN.)
  const drinkIds = [...new Set(items.map((i) => i.drink_id))].sort();
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
  for (const item of items) wanted.set(item.drink_id, (wanted.get(item.drink_id) || 0) + item.quantity);

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
  const currency = currencies.values().next().value;

  let subtotal = 0;
  for (const item of items) subtotal += Number(byId.get(item.drink_id).price) * item.quantity;
  subtotal = Number(subtotal.toFixed(2));

  const created = await client.query(
    `INSERT INTO drink_orders (nightclub_id, sender_id, recipient_id, table_id, taken_by, message,
                               subtotal, currency, client_request_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [nightclubId, senderId, recipientId || null, tableId || null, takenBy || null, message || null,
      subtotal.toFixed(2), currency, clientRequestId],
  );
  const order = created.rows[0];

  for (const item of items) {
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

  // The charge. An order that nobody has paid for is not a ticket for the bar: it is a
  // debt, and it stays one until someone hands over money. Creating it here, inside the
  // caller's transaction, is what makes "the order exists but the charge does not"
  // impossible -- the state that let drinks walk out unpaid.
  //
  // `client_request_id` is the order's own: the ledger rejects a duplicate before the
  // same order can grow a second charge.
  let transactionId = null;
  if (subtotal > 0) {
    const charge = await client.query(
      `INSERT INTO transactions (nightclub_id, type, direction, amount, currency, status,
                                 payer_user_id, provider, reference_type, reference_id,
                                 client_request_id, metadata)
       VALUES ($1,$2,'in',$3,$4,'pending',$5,'manual','drink_order',$6,$7,$8)
       RETURNING id`,
      [nightclubId, chargeType || 'drink_order', subtotal.toFixed(2), currency, senderId,
        order.id, clientRequestId, JSON.stringify(chargeMetadata || {})],
    );
    transactionId = charge.rows[0].id;
  }

  return { id: order.id, subtotal, currency, drinks: drinks.rows, transactionId };
}

module.exports = { createOrder, ORDER_SELECT };
