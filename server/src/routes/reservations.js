// Table reservations: availability, quotes, booking, cancellation, payment methods.
//
// A table is booked for a whole NIGHT (an event), never for a time range, and it is
// priced as `zone base + extra guests x that night's ticket` (see docs/DECISIONES.md D17).
// Guests have a limited time to arrive; after that the table is released as a no-show
// with no refund.
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
const eventPricing = require('../services/event-pricing');
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

/** The event a booking is for, ensuring it belongs to this club and can still be booked. */
async function getBookableEvent(nightclubId, eventId, runner = pool) {
  const { rows } = await runner.query(
    `SELECT * FROM events_calendar WHERE id = $1 AND nightclub_id = $2`,
    [eventId, nightclubId],
  );
  if (rows.length === 0) throw ApiError.notFound('Event not found');
  const event = rows[0];
  if (event.status === 'cancelled') throw ApiError.unprocessable('Ese evento fue cancelado');
  if (event.status === 'finished') throw ApiError.unprocessable('Ese evento ya terminó');
  return event;
}

const RESERVATION_SELECT = `
  SELECT r.id, r.status, r.starts_at, r.ends_at, r.guest_count,
         r.currency, r.total_estimated, r.deposit_amount, r.special_requests,
         r.cancelled_at, r.cancel_reason, r.refund_amount, r.created_at,
         r.arrival_deadline, r.included_tickets, r.extra_guests,
         r.zone_base_at_booking, r.ticket_at_booking,
         r.event_id, ev.name AS event_name, ev.event_date, ev.doors_open_at,
         ev.status AS event_status,
         r.table_id, t.code AS table_code, t.table_number, t.section, t.floor,
         t.type AS table_type,
         r.user_id, u.display_name AS user_name,
         COALESCE(a.addons, '[]'::json) AS addons
    FROM reservations r
    JOIN tables t ON t.id = r.table_id
    JOIN users u ON u.id = r.user_id
    LEFT JOIN events_calendar ev ON ev.id = r.event_id
    LEFT JOIN LATERAL (
      SELECT json_agg(json_build_object('id', ra.id, 'type', ra.addon_type, 'name', ra.name,
                                        -- ::text: money stays a two-decimal string.
                                        'price', ra.price::text, 'quantity', ra.quantity)) AS addons
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

/** Free tables for an event = active, reservable zone, big enough, not already booked. */
async function availableTables({ nightclubId, eventId, guests, section, floor, runner = pool }) {
  const { rows } = await runner.query(
    `SELECT t.id, t.code, t.table_number, t.name, t.section, t.floor, t.type, t.capacity,
            t.x, t.y, t.radius, t.color, t.bottle_service
       FROM tables t
       JOIN zone_pricing z ON z.nightclub_id = t.nightclub_id AND z.section = t.section
      WHERE t.nightclub_id = $1
        AND t.active
        AND t.status <> 'blocked'
        AND z.active AND z.reservable
        AND (z.included_tickets + z.max_extras) >= $3
        AND ($4::text IS NULL OR t.section = $4)
        AND ($5::text IS NULL OR t.floor = $5)
        AND NOT EXISTS (
          SELECT 1 FROM reservations r
           WHERE r.table_id = t.id AND r.event_id = $2
             AND r.status IN ('pending_payment','confirmed','seated')
        )
      ORDER BY t.floor, t.section, t.table_number NULLS LAST, t.code`,
    [nightclubId, eventId, guests, section || null, floor || null],
  );
  return rows;
}

const availabilityQuery = z.object({
  event_id: uuid,
  guests: z.coerce.number().int().min(1).max(50).default(2),
  section: z.string().trim().max(40).optional(),
  floor: z.enum(['baja', 'alta', 'ambas']).optional(),
});

router.get('/nightclubs/:nightclubId/reservations/availability',
  validate({ params: z.object({ nightclubId: uuid }), query: availabilityQuery }),
  asyncHandler(async (req, res) => {
    const { nightclubId } = req.params;
    const { event_id: eventId, guests, section, floor } = req.query;

    const event = await getBookableEvent(nightclubId, eventId);
    const isStaff = ['hostess', 'waiter', 'manager', 'admin'].includes(req.user.role);
    if (!isStaff && event.status !== 'published') throw ApiError.notFound('Event not found');

    const rules = await getRules(nightclubId);
    const hoursAhead = (new Date(event.doors_open_at).getTime() - Date.now()) / 3_600_000;
    if (hoursAhead < Number(rules.min_advance_hours)) {
      throw ApiError.unprocessable(
        `Las reservaciones cierran ${rules.min_advance_hours} horas antes de abrir`);
    }

    const { zones } = await eventPricing.getEventPricing({ nightclubId, eventId });
    const byZone = new Map(zones.map((z) => [z.section, z]));
    const free = await availableTables({ nightclubId, eventId, guests, section, floor });

    const tables = [];
    for (const table of free) {
      const zone = byZone.get(table.section);
      if (!zone) continue;
      let quote;
      try {
        quote = eventPricing.quote({ zone, event, guests });
      } catch {
        continue; // la zona no admite ese número de personas
      }
      tables.push({
        ...table,
        zone: quote.zone,
        price: quote.subtotal,
        extra_guests: quote.extra_guests,
        extras_total: quote.extras_total,
        deposit: eventPricing.round(quote.subtotal * Number(rules.deposit_pct) / 100),
        currency: quote.currency,
      });
    }

    res.json({
      event: {
        id: event.id, name: event.name, event_date: event.event_date,
        doors_open_at: event.doors_open_at, ticket_price: event.ticket_price,
        currency: event.currency,
        arrival_deadline: eventPricing.arrivalDeadline(event).toISOString(),
      },
      guests,
      deposit_pct: Number(rules.deposit_pct),
      tables,
    });
  }));

const addonInput = z.object({
  code: z.string().trim().min(1).max(40).optional(),
  type: z.enum(['bottle_service', 'vip_upgrade', 'extra_hour', 'decorations', 'other']).default('other'),
  name: z.string().trim().min(1).max(120).optional(),
  price: z.number().min(0).optional(),
  quantity: z.number().int().min(1).max(50).default(1),
});

/**
 * Resolves add-ons against the club's catalogue. A client may reference a product by
 * `code` (price comes from the database) or pass a custom line; either way the price
 * that ends up on the reservation is decided here.
 */
async function resolveAddons(nightclubId, addons = [], runner = pool) {
  if (addons.length === 0) return [];
  const codes = addons.filter((a) => a.code).map((a) => a.code);
  const catalogue = new Map();
  if (codes.length > 0) {
    const { rows } = await runner.query(
      `SELECT code, kind, name, price FROM reservation_products
        WHERE nightclub_id = $1 AND active AND code = ANY($2::text[])`,
      [nightclubId, codes]);
    rows.forEach((r) => catalogue.set(r.code, r));
  }
  return addons.map((a) => {
    if (a.code) {
      const product = catalogue.get(a.code);
      if (!product) throw ApiError.notFound(`El producto '${a.code}' no existe o no está activo`);
      return {
        type: product.kind === 'bottle' ? 'bottle_service' : 'other',
        name: product.name,
        price: Number(product.price),
        quantity: a.quantity,
      };
    }
    if (a.name === undefined || a.price === undefined) {
      throw ApiError.badRequest('Cada extra necesita `code`, o bien `name` y `price`');
    }
    return { type: a.type, name: a.name, price: a.price, quantity: a.quantity };
  });
}

/** Shared by the quote endpoint and by booking, so a client can never set a price. */
async function buildQuote(nightclubId, body, runner = pool) {
  const rules = await getRules(nightclubId);
  const event = await getBookableEvent(nightclubId, body.event_id, runner);

  const t = await runner.query(
    `SELECT id, code, table_number, section, floor, capacity, active
       FROM tables WHERE id = $1 AND nightclub_id = $2`,
    [body.table_id, nightclubId]);
  if (t.rowCount === 0 || !t.rows[0].active) throw ApiError.notFound('Table not found');
  const table = t.rows[0];

  const { zone } = await eventPricing.zoneFor({
    nightclubId, eventId: body.event_id, section: table.section, runner,
  });
  if (!zone) throw ApiError.unprocessable(`La zona '${table.section}' no tiene precio configurado`);

  const addons = await resolveAddons(nightclubId, body.addons || [], runner);
  const base = eventPricing.quote({ zone, event, guests: body.guest_count, addons });

  let discount = null;
  let total = base.subtotal;
  if (body.discount_code) {
    const d = await runner.query(
      `SELECT * FROM reservation_discounts
        WHERE nightclub_id = $1 AND upper(code) = upper($2) AND active
          AND (valid_from IS NULL OR valid_from <= current_date)
          AND (valid_until IS NULL OR valid_until >= current_date)
          AND (max_uses IS NULL OR used_count < max_uses)`,
      [nightclubId, body.discount_code]);
    if (d.rowCount === 0) throw ApiError.unprocessable('Discount code is not valid');
    const rule = d.rows[0];
    const amount = rule.discount_type === 'percentage'
      ? total * Number(rule.discount_value) / 100
      : Number(rule.discount_value);
    discount = {
      id: rule.id, code: rule.code, type: rule.discount_type,
      value: Number(rule.discount_value), amount: eventPricing.round(Math.min(amount, total)),
    };
    total = Math.max(0, total - discount.amount);
  }

  total = eventPricing.round(total);
  return {
    ...base,
    table: {
      id: table.id, code: table.code, table_number: table.table_number,
      section: table.section, floor: table.floor, capacity: table.capacity,
    },
    addons,
    discount,
    total,
    deposit: eventPricing.round(total * Number(rules.deposit_pct) / 100),
    deposit_pct: Number(rules.deposit_pct),
    arrival_deadline: eventPricing.arrivalDeadline(event).toISOString(),
    rules,
    _event: event,
    _zone: zone,
  };
}

router.post('/nightclubs/:nightclubId/reservations/quote',
  validate({
    params: z.object({ nightclubId: uuid }),
    body: z.object({
      event_id: uuid,
      table_id: uuid,
      guest_count: z.number().int().min(1).max(50),
      addons: z.array(addonInput).max(20).default([]),
      discount_code: z.string().trim().max(40).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const q = await buildQuote(req.params.nightclubId, req.body);
    delete q.rules; delete q._event; delete q._zone;
    res.json({ quote: q });
  }));

// ---------------------------------------------------------------- booking
const bookSchema = z.object({
  client_request_id: uuid,
  event_id: uuid,
  table_id: uuid,
  guest_count: z.number().int().min(1).max(50),
  special_requests: z.string().trim().max(500).optional(),
  addons: z.array(addonInput).max(20).default([]),
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
      const event = quote._event;

      if (event.status !== 'published'
          && !['hostess', 'manager', 'admin'].includes(req.user.role)) {
        throw ApiError.notFound('Event not found');
      }
      if (b.guest_count < rules.min_party_size) {
        throw ApiError.unprocessable(`El mínimo son ${rules.min_party_size} personas`);
      }
      // The zone rule decides how many people fit, not the table's nominal capacity:
      // the price list sets it ("Zona Azul: 10 personas, 2 extras" = up to 12) and
      // eventPricing.quote() already enforced it above.

      const hoursAhead = (new Date(event.doors_open_at).getTime() - Date.now()) / 3_600_000;
      if (hoursAhead < Number(rules.min_advance_hours)) {
        throw ApiError.unprocessable(
          `Las reservaciones cierran ${rules.min_advance_hours} horas antes de abrir`);
      }

      // The night, not a time range: starts when doors open and ends when the club closes.
      const startsAt = new Date(event.doors_open_at);
      const endsAt = event.closes_at
        ? new Date(event.closes_at)
        : new Date(startsAt.getTime() + 8 * 3_600_000);
      const durationMinutes = Math.max(30, Math.round((endsAt - startsAt) / 60_000));

      let reservation;
      try {
        const created = await client.query(
          `INSERT INTO reservations (nightclub_id, user_id, event_id, table_id, starts_at,
                                     duration_minutes, guest_count, status, currency,
                                     total_estimated, deposit_amount, discount_id, special_requests,
                                     arrival_deadline, included_tickets, extra_guests,
                                     zone_base_at_booking, ticket_at_booking)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'pending_payment',$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
           RETURNING id`,
          [nightclubId, req.user.id, b.event_id, b.table_id, startsAt, durationMinutes,
            b.guest_count, quote.currency, quote.total, quote.deposit,
            quote.discount ? quote.discount.id : null, b.special_requests || null,
            quote.arrival_deadline, quote.zone.included_tickets, quote.extra_guests,
            quote.zone.base_price, quote.ticket_price],
        );
        reservation = created.rows[0];
      } catch (err) {
        // 23505 = the unique index for one live reservation per table per event.
        if (err.code === '23505' || err.code === '23P01') {
          throw ApiError.conflict('Esa mesa ya está reservada para ese evento');
        }
        throw err;
      }

      for (const a of quote.addons) {
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
          reservation_id: reservation.id, table_id: b.table_id, event_id: b.event_id,
          starts_at: startsAt.toISOString(), deposit: quote.deposit, currency: quote.currency,
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
        arrival_deadline: quote.arrival_deadline,
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
      event_id: uuid.optional(),
      status: z.enum(['pending_payment', 'confirmed', 'seated', 'completed', 'cancelled', 'no_show']).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(
      `${RESERVATION_SELECT}
        WHERE r.nightclub_id = $1
          AND ($2::date IS NULL OR ev.event_date = $2::date)
          AND ($3::text IS NULL OR r.status = $3)
          AND ($4::uuid IS NULL OR r.event_id = $4)
        ORDER BY r.starts_at ASC LIMIT $5 OFFSET $6`,
      [req.params.nightclubId, req.query.date || null, req.query.status || null,
        req.query.event_id || null, req.query.limit, req.query.offset],
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

// Releases tables whose guests never showed up. Idempotent, so it is safe to call from
// a screen refresh, from the hostess tablet, or from a scheduled job later on.
// No refund: the club's rule is that a missed arrival forfeits the deposit (D17).
router.post('/nightclubs/:nightclubId/reservations/release-no-shows',
  requireRole('hostess', 'manager'),
  validate({
    params: z.object({ nightclubId: uuid }),
    body: z.object({ event_id: uuid.optional() }).default({}),
  }),
  asyncHandler(async (req, res) => {
    const { nightclubId } = req.params;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `UPDATE reservations r
            SET status = 'no_show', refund_amount = 0
          WHERE r.nightclub_id = $1
            AND r.status IN ('pending_payment','confirmed')
            AND r.arrival_deadline IS NOT NULL
            AND r.arrival_deadline < now()
            AND ($2::uuid IS NULL OR r.event_id = $2)
          RETURNING r.id, r.table_id, r.user_id, r.event_id`,
        [nightclubId, req.body.event_id || null],
      );

      for (const r of rows) {
        await client.query(
          `UPDATE tables SET status = 'available'
            WHERE id = $1 AND status IN ('reserved','occupied')
              AND NOT EXISTS (
                SELECT 1 FROM table_occupants o WHERE o.table_id = $1 AND o.left_at IS NULL
              )`,
          [r.table_id],
        );
        // Deposits already charged are NOT refunded; pending ones are simply dropped.
        await client.query(
          `UPDATE transactions SET status = 'cancelled'
            WHERE reference_type = 'reservation' AND reference_id = $1
              AND status IN ('pending','pending_manual')`,
          [r.id],
        );
        await events.publish({
          nightclubId, type: 'reservation_no_show', client,
          audience: { roles: ['hostess', 'manager'], userIds: [r.user_id] },
          payload: { reservation_id: r.id, table_id: r.table_id, event_id: r.event_id, refunded: false },
        });
      }

      await client.query('COMMIT');
      res.json({ released: rows.length, reservation_ids: rows.map((r) => r.id) });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
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
      // Past the arrival deadline the deposit is forfeited, whatever the window says (D17).
      const missedArrival = r.arrival_deadline && new Date(r.arrival_deadline) < new Date();
      const refundPct = missedArrival ? 0 : refundPctFor(windows, r.starts_at);

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
        missed_arrival: !!missedArrival,
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
