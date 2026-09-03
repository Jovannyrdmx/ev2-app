// Table reservations: rules, availability, quotes, booking, cancellation, payment methods.
//
// Money movement is recorded in `transactions`; the actual charge (Stripe / Mercado Pago)
// is wired in phase 3. Until then a booking is created as 'pending_payment' with a
// 'pending' deposit transaction.
'use strict';

const express = require('express');
const { pool } = require('../db/pool');
const { ApiError, asyncHandler } = require('../middleware/errors');
const { validate, z, uuid, pagination } = require('../middleware/validate');
const { authenticate, requireRole, sameNightclub } = require('../middleware/auth');
const pricing = require('../services/pricing');
const events = require('../services/events');

const router = express.Router({ mergeParams: true });

const DEFAULT_RULES = {
  min_party_size: 2,
  max_party_size: 20,
  deposit_pct: 30,
  base_price_per_hour: 0,
  currency: 'MXN',
  min_advance_hours: 2,
  max_duration_minutes: 360,
  cancellation_windows: [
    { hours: 48, refund_pct: 100 },
    { hours: 24, refund_pct: 50 },
    { hours: 0, refund_pct: 0 },
  ],
};

async function getRules(nightclubId) {
  const { rows } = await pool.query('SELECT * FROM reservation_rules WHERE nightclub_id = $1', [nightclubId]);
  return rows[0] || { ...DEFAULT_RULES, nightclub_id: nightclubId };
}

// Refund percentage for cancelling `startsAt` right now, per the club's windows.
function refundPctFor(windows, startsAt, now = new Date()) {
  const hoursLeft = (new Date(startsAt).getTime() - now.getTime()) / 3_600_000;
  const sorted = [...windows].sort((a, b) => b.hours - a.hours);
  for (const w of sorted) {
    if (hoursLeft >= w.hours) return Number(w.refund_pct);
  }
  return 0;
}

async function priceReservation({ nightclubId, table, startsAt, durationMinutes, rules }) {
  const hours = durationMinutes / 60;
  const base = Number(rules.base_price_per_hour) * hours;
  const q = await pricing.quote({
    nightclubId,
    appliesTo: 'table_type',
    target: table.type,
    basePrice: base,
    when: new Date(startsAt),
  });
  return { hours, ...q };
}

const RESERVATION_SELECT = `
  SELECT r.id, r.status, r.starts_at, r.ends_at, r.duration_minutes, r.guest_count,
         r.currency, r.total_estimated, r.deposit_amount, r.special_requests,
         r.cancelled_at, r.cancel_reason, r.refund_amount, r.created_at,
         r.table_id, t.code AS table_code, t.section, t.type AS table_type,
         r.user_id, u.display_name AS user_name,
         COALESCE(a.addons, '[]'::json) AS addons
    FROM reservations r
    JOIN tables t ON t.id = r.table_id
    JOIN users u ON u.id = r.user_id
    LEFT JOIN LATERAL (
      SELECT json_agg(json_build_object('id', ra.id, 'type', ra.addon_type, 'name', ra.name,
                                        'price', ra.price, 'quantity', ra.quantity)) AS addons
        FROM reservation_addons ra WHERE ra.reservation_id = r.id
    ) a ON true`;

router.use('/nightclubs/:nightclubId', authenticate, sameNightclub());

// ---------------------------------------------------------------- rules
router.get('/nightclubs/:nightclubId/reservations/rules',
  validate({ params: z.object({ nightclubId: uuid }) }),
  asyncHandler(async (req, res) => {
    res.json({ rules: await getRules(req.params.nightclubId) });
  }));

router.put('/nightclubs/:nightclubId/reservations/rules',
  requireRole('manager'),
  validate({
    params: z.object({ nightclubId: uuid }),
    body: z.object({
      min_party_size: z.number().int().min(1).optional(),
      max_party_size: z.number().int().min(1).optional(),
      deposit_pct: z.number().min(0).max(100).optional(),
      base_price_per_hour: z.number().min(0).optional(),
      currency: z.enum(['MXN', 'USD']).optional(),
      min_advance_hours: z.number().int().min(0).optional(),
      max_duration_minutes: z.number().int().min(30).max(720).optional(),
      cancellation_windows: z.array(z.object({
        hours: z.number().min(0),
        refund_pct: z.number().min(0).max(100),
      })).min(1).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const current = await getRules(req.params.nightclubId);
    const merged = { ...DEFAULT_RULES, ...current, ...req.body };
    if (merged.max_party_size < merged.min_party_size) {
      throw ApiError.unprocessable('max_party_size must be >= min_party_size');
    }
    const { rows } = await pool.query(
      `INSERT INTO reservation_rules (nightclub_id, min_party_size, max_party_size, deposit_pct,
                                      base_price_per_hour, currency, min_advance_hours,
                                      max_duration_minutes, cancellation_windows)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (nightclub_id) DO UPDATE SET
         min_party_size = EXCLUDED.min_party_size, max_party_size = EXCLUDED.max_party_size,
         deposit_pct = EXCLUDED.deposit_pct, base_price_per_hour = EXCLUDED.base_price_per_hour,
         currency = EXCLUDED.currency, min_advance_hours = EXCLUDED.min_advance_hours,
         max_duration_minutes = EXCLUDED.max_duration_minutes,
         cancellation_windows = EXCLUDED.cancellation_windows, updated_at = now()
       RETURNING *`,
      [req.params.nightclubId, merged.min_party_size, merged.max_party_size, merged.deposit_pct,
        merged.base_price_per_hour, merged.currency, merged.min_advance_hours,
        merged.max_duration_minutes, JSON.stringify(merged.cancellation_windows)],
    );
    res.json({ rules: rows[0] });
  }));

// ------------------------------------------------------- availability & quote
const availabilityQuery = z.object({
  starts_at: z.coerce.date(),
  duration_minutes: z.coerce.number().int().min(30).max(720).default(180),
  guests: z.coerce.number().int().min(1).max(50).default(2),
  section: z.string().trim().max(40).optional(),
});

router.get('/nightclubs/:nightclubId/reservations/availability',
  validate({ params: z.object({ nightclubId: uuid }), query: availabilityQuery }),
  asyncHandler(async (req, res) => {
    const { nightclubId } = req.params;
    const { starts_at: startsAt, duration_minutes: duration, guests, section } = req.query;
    const rules = await getRules(nightclubId);

    if (guests < rules.min_party_size || guests > rules.max_party_size) {
      throw ApiError.unprocessable(
        `Party size must be between ${rules.min_party_size} and ${rules.max_party_size}`);
    }
    if (duration > rules.max_duration_minutes) {
      throw ApiError.unprocessable(`Maximum duration is ${rules.max_duration_minutes} minutes`);
    }
    const hoursAhead = (startsAt.getTime() - Date.now()) / 3_600_000;
    if (hoursAhead < rules.min_advance_hours) {
      throw ApiError.unprocessable(`Reservations require ${rules.min_advance_hours} hours notice`);
    }

    // Free tables = active, big enough, not blocked, and with no overlapping live reservation.
    const { rows } = await pool.query(
      `SELECT t.id, t.code, t.name, t.section, t.type, t.capacity, t.x, t.y, t.radius, t.bottle_service
         FROM tables t
        WHERE t.nightclub_id = $1
          AND t.active
          AND t.status <> 'blocked'
          AND t.capacity >= $4
          AND ($5::text IS NULL OR t.section = $5)
          AND NOT EXISTS (
            SELECT 1 FROM reservations r
             WHERE r.table_id = t.id
               AND r.status IN ('pending_payment','confirmed','seated')
               AND tstzrange(r.starts_at, r.ends_at, '[)')
                   && tstzrange($2::timestamptz, $2::timestamptz + make_interval(mins => $3), '[)')
          )
        ORDER BY t.section, t.code`,
      [nightclubId, startsAt.toISOString(), duration, guests, section || null],
    );

    const available = [];
    for (const table of rows) {
      const price = await priceReservation({ nightclubId, table, startsAt, durationMinutes: duration, rules });
      available.push({
        ...table,
        price: price.final,
        currency: rules.currency,
        deposit: Number((price.final * Number(rules.deposit_pct) / 100).toFixed(2)),
      });
    }
    res.json({
      starts_at: startsAt.toISOString(),
      duration_minutes: duration,
      guests,
      currency: rules.currency,
      deposit_pct: Number(rules.deposit_pct),
      tables: available,
    });
  }));

router.post('/nightclubs/:nightclubId/reservations/quote',
  validate({
    params: z.object({ nightclubId: uuid }),
    body: z.object({
      table_id: uuid,
      starts_at: z.coerce.date(),
      duration_minutes: z.number().int().min(30).max(720).default(180),
      addons: z.array(z.object({
        type: z.enum(['bottle_service', 'vip_upgrade', 'extra_hour', 'decorations', 'other']),
        name: z.string().trim().min(1).max(120),
        price: z.number().min(0),
        quantity: z.number().int().min(1).max(50).default(1),
      })).max(20).default([]),
      discount_code: z.string().trim().max(40).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const quote = await buildQuote(req.params.nightclubId, req.body);
    res.json({ quote });
  }));

// Shared by the quote endpoint and by booking, so the client can never invent a price.
async function buildQuote(nightclubId, body, client = pool) {
  const rules = await getRules(nightclubId);
  const t = await client.query(
    'SELECT id, code, type, capacity, status, active FROM tables WHERE id = $1 AND nightclub_id = $2',
    [body.table_id, nightclubId],
  );
  if (t.rowCount === 0 || !t.rows[0].active) throw ApiError.notFound('Table not found');
  const table = t.rows[0];

  const tablePrice = await priceReservation({
    nightclubId, table, startsAt: body.starts_at, durationMinutes: body.duration_minutes, rules,
  });

  const addonsTotal = (body.addons || []).reduce((sum, a) => sum + a.price * a.quantity, 0);
  let subtotal = tablePrice.final + addonsTotal;

  let discount = null;
  if (body.discount_code) {
    const d = await client.query(
      `SELECT * FROM reservation_discounts
        WHERE nightclub_id = $1 AND upper(code) = upper($2) AND active
          AND (valid_from IS NULL OR valid_from <= current_date)
          AND (valid_until IS NULL OR valid_until >= current_date)
          AND (max_uses IS NULL OR used_count < max_uses)`,
      [nightclubId, body.discount_code],
    );
    if (d.rowCount === 0) throw ApiError.unprocessable('Discount code is not valid');
    const rule = d.rows[0];
    const amount = rule.discount_type === 'percentage'
      ? subtotal * Number(rule.discount_value) / 100
      : Number(rule.discount_value);
    discount = {
      id: rule.id, code: rule.code, type: rule.discount_type,
      value: Number(rule.discount_value), amount: Number(Math.min(amount, subtotal).toFixed(2)),
    };
    subtotal = Math.max(0, subtotal - discount.amount);
  }

  const total = Number(subtotal.toFixed(2));
  const deposit = Number((total * Number(rules.deposit_pct) / 100).toFixed(2));
  return {
    table: { id: table.id, code: table.code, type: table.type, capacity: table.capacity },
    hours: tablePrice.hours,
    table_price: tablePrice.final,
    price_rules_applied: tablePrice.applied,
    addons_total: Number(addonsTotal.toFixed(2)),
    discount,
    total,
    deposit,
    currency: rules.currency,
    deposit_pct: Number(rules.deposit_pct),
    rules,
  };
}

// ---------------------------------------------------------------- booking
const bookSchema = z.object({
  client_request_id: uuid,
  table_id: uuid,
  starts_at: z.coerce.date(),
  duration_minutes: z.number().int().min(30).max(720).default(180),
  guest_count: z.number().int().min(1).max(50),
  special_requests: z.string().trim().max(500).optional(),
  addons: z.array(z.object({
    type: z.enum(['bottle_service', 'vip_upgrade', 'extra_hour', 'decorations', 'other']),
    name: z.string().trim().min(1).max(120),
    price: z.number().min(0),
    quantity: z.number().int().min(1).max(50).default(1),
  })).max(20).default([]),
  discount_code: z.string().trim().max(40).optional(),
});

router.post('/nightclubs/:nightclubId/reservations',
  validate({ params: z.object({ nightclubId: uuid }), body: bookSchema }),
  asyncHandler(async (req, res) => {
    const { nightclubId } = req.params;
    const b = req.body;

    // Idempotency is carried by the deposit transaction's client_request_id.
    const dup = await pool.query(
      `SELECT reference_id FROM transactions
        WHERE client_request_id = $1 AND nightclub_id = $2 AND reference_type = 'reservation'`,
      [b.client_request_id, nightclubId],
    );
    if (dup.rowCount > 0) {
      const existing = await pool.query(`${RESERVATION_SELECT} WHERE r.id = $1`, [dup.rows[0].reference_id]);
      res.set('Idempotent-Replay', 'true');
      return res.status(200).json({ reservation: existing.rows[0] });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const quote = await buildQuote(nightclubId, b, client);
      const rules = quote.rules;

      if (b.guest_count < rules.min_party_size || b.guest_count > rules.max_party_size) {
        throw ApiError.unprocessable(
          `Party size must be between ${rules.min_party_size} and ${rules.max_party_size}`);
      }
      if (b.guest_count > quote.table.capacity) {
        throw ApiError.unprocessable(`Table ${quote.table.code} seats ${quote.table.capacity} people`);
      }
      const hoursAhead = (b.starts_at.getTime() - Date.now()) / 3_600_000;
      if (hoursAhead < rules.min_advance_hours) {
        throw ApiError.unprocessable(`Reservations require ${rules.min_advance_hours} hours notice`);
      }
      if (b.duration_minutes > rules.max_duration_minutes) {
        throw ApiError.unprocessable(`Maximum duration is ${rules.max_duration_minutes} minutes`);
      }

      let reservation;
      try {
        const created = await client.query(
          `INSERT INTO reservations (nightclub_id, user_id, table_id, starts_at, duration_minutes,
                                     guest_count, status, currency, total_estimated, deposit_amount,
                                     discount_id, special_requests)
           VALUES ($1,$2,$3,$4,$5,$6,'pending_payment',$7,$8,$9,$10,$11)
           RETURNING id`,
          [nightclubId, req.user.id, b.table_id, b.starts_at, b.duration_minutes, b.guest_count,
            quote.currency, quote.total, quote.deposit, quote.discount ? quote.discount.id : null,
            b.special_requests || null],
        );
        reservation = created.rows[0];
      } catch (err) {
        // 23P01 = exclusion violation: the slot was taken while we were booking.
        if (err.code === '23P01') {
          throw ApiError.conflict('That table was just booked for an overlapping time');
        }
        throw err;
      }

      for (const a of b.addons) {
        await client.query(
          `INSERT INTO reservation_addons (reservation_id, addon_type, name, price, quantity)
           VALUES ($1,$2,$3,$4,$5)`,
          [reservation.id, a.type, a.name, a.price, a.quantity],
        );
      }
      if (quote.discount) {
        await client.query('UPDATE reservation_discounts SET used_count = used_count + 1 WHERE id = $1',
          [quote.discount.id]);
      }

      // Deposit is recorded as pending; the real charge lands in phase 3.
      await client.query(
        `INSERT INTO transactions (nightclub_id, type, direction, amount, currency, status,
                                   payer_user_id, provider, reference_type, reference_id,
                                   client_request_id, metadata)
         VALUES ($1,'reservation_deposit','in',$2,$3,'pending',$4,'manual','reservation',$5,$6,$7)`,
        [nightclubId, quote.deposit > 0 ? quote.deposit : 0.01, quote.currency, req.user.id,
          reservation.id, b.client_request_id, JSON.stringify({ total: quote.total })],
      );

      await events.publish({
        nightclubId, type: 'reservation_created', client,
        audience: { roles: ['hostess', 'manager'], userIds: [req.user.id] },
        payload: {
          reservation_id: reservation.id, table_id: b.table_id,
          starts_at: b.starts_at.toISOString(), deposit: quote.deposit, currency: quote.currency,
        },
      });

      await client.query('COMMIT');
      const full = await pool.query(`${RESERVATION_SELECT} WHERE r.id = $1`, [reservation.id]);
      return res.status(201).json({
        reservation: full.rows[0],
        payment: {
          status: 'pending',
          deposit: quote.deposit,
          currency: quote.currency,
          note: 'Payment processing is enabled in phase 3 (Stripe / Mercado Pago).',
        },
      });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }));

router.get('/nightclubs/:nightclubId/reservations/mine',
  validate({ params: z.object({ nightclubId: uuid }), query: pagination }),
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(
      `${RESERVATION_SELECT} WHERE r.nightclub_id = $1 AND r.user_id = $2
        ORDER BY r.starts_at DESC LIMIT $3 OFFSET $4`,
      [req.params.nightclubId, req.user.id, req.query.limit, req.query.offset],
    );
    res.json({ reservations: rows });
  }));

// Staff view of the book for a given day.
router.get('/nightclubs/:nightclubId/reservations',
  requireRole('hostess', 'waiter', 'manager'),
  validate({
    params: z.object({ nightclubId: uuid }),
    query: pagination.extend({
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      status: z.enum(['pending_payment', 'confirmed', 'seated', 'completed', 'cancelled', 'no_show']).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(
      `${RESERVATION_SELECT}
        WHERE r.nightclub_id = $1
          AND ($2::date IS NULL OR r.starts_at::date = $2::date)
          AND ($3::text IS NULL OR r.status = $3)
        ORDER BY r.starts_at ASC LIMIT $4 OFFSET $5`,
      [req.params.nightclubId, req.query.date || null, req.query.status || null,
        req.query.limit, req.query.offset],
    );
    res.json({ reservations: rows });
  }));

router.get('/nightclubs/:nightclubId/reservations/:reservationId',
  validate({ params: z.object({ nightclubId: uuid, reservationId: uuid }) }),
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(`${RESERVATION_SELECT} WHERE r.id = $1 AND r.nightclub_id = $2`,
      [req.params.reservationId, req.params.nightclubId]);
    if (rows.length === 0) throw ApiError.notFound('Reservation not found');
    const isOwner = rows[0].user_id === req.user.id;
    const isStaff = ['hostess', 'waiter', 'manager', 'admin'].includes(req.user.role);
    if (!isOwner && !isStaff) throw ApiError.forbidden('Not your reservation');
    res.json({ reservation: rows[0] });
  }));

// ------------------------------------------------------------- cancellation
router.post('/nightclubs/:nightclubId/reservations/:reservationId/cancel',
  validate({
    params: z.object({ nightclubId: uuid, reservationId: uuid }),
    body: z.object({ reason: z.string().trim().max(300).optional() }).default({}),
  }),
  asyncHandler(async (req, res) => {
    const { nightclubId, reservationId } = req.params;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const cur = await client.query(
        'SELECT * FROM reservations WHERE id = $1 AND nightclub_id = $2 FOR UPDATE',
        [reservationId, nightclubId],
      );
      if (cur.rowCount === 0) throw ApiError.notFound('Reservation not found');
      const r = cur.rows[0];

      const isOwner = r.user_id === req.user.id;
      const isStaff = ['hostess', 'manager', 'admin'].includes(req.user.role);
      if (!isOwner && !isStaff) throw ApiError.forbidden('Not your reservation');
      if (!['pending_payment', 'confirmed'].includes(r.status)) {
        throw ApiError.conflict(`Cannot cancel a reservation that is '${r.status}'`);
      }

      const rules = await getRules(nightclubId);
      const windows = Array.isArray(rules.cancellation_windows)
        ? rules.cancellation_windows : DEFAULT_RULES.cancellation_windows;
      const refundPct = refundPctFor(windows, r.starts_at);

      // Refund only what was actually paid.
      const paid = await client.query(
        `SELECT COALESCE(sum(amount), 0) AS total FROM transactions
          WHERE reference_type = 'reservation' AND reference_id = $1
            AND direction = 'in' AND status = 'paid'`,
        [reservationId],
      );
      const paidAmount = Number(paid.rows[0].total);
      const refundAmount = Number((paidAmount * refundPct / 100).toFixed(2));

      await client.query(
        `UPDATE reservations SET status = 'cancelled', cancelled_at = now(),
                cancel_reason = $3, refund_amount = $4
          WHERE id = $1 AND nightclub_id = $2`,
        [reservationId, nightclubId, req.body.reason || null, refundAmount],
      );

      // Pending (never charged) deposits are simply cancelled.
      await client.query(
        `UPDATE transactions SET status = 'cancelled'
          WHERE reference_type = 'reservation' AND reference_id = $1 AND status IN ('pending','pending_manual')`,
        [reservationId],
      );

      if (refundAmount > 0) {
        await client.query(
          `INSERT INTO transactions (nightclub_id, type, direction, amount, currency, status,
                                     payee_user_id, provider, reference_type, reference_id, metadata)
           VALUES ($1,'refund','out',$2,$3,'pending',$4,'manual','reservation',$5,$6)`,
          [nightclubId, refundAmount, r.currency, r.user_id, reservationId,
            JSON.stringify({ refund_pct: refundPct, paid: paidAmount })],
        );
      }

      await events.publish({
        nightclubId, type: 'reservation_cancelled', client,
        audience: { roles: ['hostess', 'manager'], userIds: [r.user_id] },
        payload: { reservation_id: reservationId, refund_amount: refundAmount, refund_pct: refundPct },
      });
      await client.query('COMMIT');
      res.json({
        cancelled: true,
        refund_pct: refundPct,
        refund_amount: refundAmount,
        paid_amount: paidAmount,
      });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }));

// Staff moves a booking through its lifecycle.
const STATUS_FLOW = {
  pending_payment: ['confirmed', 'cancelled'],
  confirmed: ['seated', 'no_show', 'cancelled'],
  seated: ['completed'],
  completed: [],
  cancelled: [],
  no_show: [],
};

router.post('/nightclubs/:nightclubId/reservations/:reservationId/status',
  requireRole('hostess', 'manager'),
  validate({
    params: z.object({ nightclubId: uuid, reservationId: uuid }),
    body: z.object({ status: z.enum(['confirmed', 'seated', 'completed', 'no_show']) }),
  }),
  asyncHandler(async (req, res) => {
    const { nightclubId, reservationId } = req.params;
    const next = req.body.status;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const cur = await client.query(
        'SELECT id, status, table_id, user_id FROM reservations WHERE id = $1 AND nightclub_id = $2 FOR UPDATE',
        [reservationId, nightclubId],
      );
      if (cur.rowCount === 0) throw ApiError.notFound('Reservation not found');
      const r = cur.rows[0];
      if (!STATUS_FLOW[r.status].includes(next)) {
        throw ApiError.conflict(`Cannot go from '${r.status}' to '${next}'`,
          { allowed: STATUS_FLOW[r.status] });
      }

      await client.query('UPDATE reservations SET status = $2 WHERE id = $1', [reservationId, next]);
      if (next === 'confirmed') {
        await client.query(`UPDATE tables SET status = 'reserved' WHERE id = $1 AND status = 'available'`,
          [r.table_id]);
      } else if (next === 'seated') {
        await client.query(`UPDATE tables SET status = 'occupied' WHERE id = $1`, [r.table_id]);
      } else if (['completed', 'no_show'].includes(next)) {
        await client.query(
          `UPDATE tables SET status = 'available' WHERE id = $1 AND status IN ('reserved','occupied')`,
          [r.table_id]);
      }

      await events.publish({
        nightclubId, type: `reservation_${next}`, client,
        audience: { roles: ['hostess', 'manager'], userIds: [r.user_id] },
        payload: { reservation_id: reservationId, status: next },
      });
      await client.query('COMMIT');
      res.json({ reservation: { id: reservationId, status: next } });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }));

// ------------------------------------------------------------ payment methods
router.get('/me/payment-methods', authenticate, asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, provider, type, last4, brand, label, is_default, created_at
       FROM payment_methods WHERE user_id = $1 ORDER BY is_default DESC, created_at DESC`,
    [req.user.id],
  );
  res.json({ payment_methods: rows });
}));

router.post('/me/payment-methods', authenticate,
  validate({
    body: z.object({
      provider: z.enum(['stripe', 'mercadopago', 'manual']),
      type: z.enum(['card', 'apple_pay', 'google_pay', 'zelle', 'cash_app', 'bank', 'oxxo', 'spei']),
      provider_token: z.string().trim().min(1).max(500).optional(),
      last4: z.string().regex(/^\d{4}$/).optional(),
      brand: z.string().trim().max(30).optional(),
      label: z.string().trim().max(60).optional(),
      is_default: z.boolean().default(false),
    }).refine((v) => v.provider === 'manual' || !!v.provider_token, {
      message: 'provider_token is required for stripe and mercadopago',
      path: ['provider_token'],
    }),
  }),
  asyncHandler(async (req, res) => {
    const b = req.body;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (b.is_default) {
        await client.query('UPDATE payment_methods SET is_default = false WHERE user_id = $1', [req.user.id]);
      }
      const { rows } = await client.query(
        `INSERT INTO payment_methods (user_id, provider, type, provider_token, last4, brand, label, is_default)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         RETURNING id, provider, type, last4, brand, label, is_default, created_at`,
        [req.user.id, b.provider, b.type, b.provider_token || null, b.last4 || null,
          b.brand || null, b.label || null, b.is_default],
      );
      await client.query('COMMIT');
      res.status(201).json({ payment_method: rows[0] });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }));

router.delete('/me/payment-methods/:id', authenticate,
  validate({ params: z.object({ id: uuid }) }),
  asyncHandler(async (req, res) => {
    const { rowCount } = await pool.query('DELETE FROM payment_methods WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id]);
    if (rowCount === 0) throw ApiError.notFound('Payment method not found');
    res.status(204).end();
  }));

module.exports = router;
