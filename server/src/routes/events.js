// Events (nights) and the price list the manager controls.
//
// Every night the club opens is an event with its own ticket price. The manager can
// override any zone's price, included tickets or extras for one event without touching
// the standing list — see docs/DECISIONES.md D17.
'use strict';

const express = require('express');
const { pool } = require('../db/pool');
const { ApiError, asyncHandler } = require('../middleware/errors');
const { validate, z, uuid, currency, isoDate, pagination } = require('../middleware/validate');
const { authenticate, requireRole, sameNightclub } = require('../middleware/auth');
const eventPricing = require('../services/event-pricing');

const router = express.Router({ mergeParams: true });

router.use('/nightclubs/:nightclubId', authenticate, sameNightclub());

const EVENT_SELECT = `
  SELECT e.id, e.name, e.slug, e.event_date, e.doors_open_at, e.closes_at,
         e.ticket_price, e.currency, e.arrival_deadline_minutes, e.status,
         -- El anticipo de ESTA noche. NULL = se usa la regla del club.
         e.deposit_pct,
         e.description, e.cover_image_url, e.created_at, e.updated_at,
         (e.doors_open_at + make_interval(mins => e.arrival_deadline_minutes)) AS arrival_deadline,
         COALESCE(r.reservations, 0)::int AS reservations_count,
         COALESCE(o.overrides, '[]'::json) AS zone_overrides
    FROM events_calendar e
    LEFT JOIN LATERAL (
      SELECT count(*) AS reservations FROM reservations rr
       WHERE rr.event_id = e.id AND rr.status IN ('pending_payment','confirmed','seated')
    ) r ON true
    LEFT JOIN LATERAL (
      SELECT json_agg(json_build_object(
               'section', z.section, 'base_price', z.base_price::text,
               'included_tickets', z.included_tickets, 'max_extras', z.max_extras,
               'reservable', z.reservable, 'note', z.note) ORDER BY z.section) AS overrides
        FROM event_zone_pricing z WHERE z.event_id = e.id
    ) o ON true`;

// ------------------------------------------------------------------ events
router.get('/nightclubs/:nightclubId/events',
  validate({
    params: z.object({ nightclubId: uuid }),
    query: pagination.extend({
      status: z.enum(['draft', 'published', 'cancelled', 'finished']).optional(),
      from: isoDate.optional(),
      to: isoDate.optional(),
      upcoming: z.coerce.boolean().default(false),
    }),
  }),
  asyncHandler(async (req, res) => {
    // Guests only ever see published events; staff see everything.
    const isStaff = ['hostess', 'waiter', 'bartender', 'manager', 'admin'].includes(req.user.role);
    const status = isStaff ? (req.query.status || null) : 'published';

    const { rows } = await pool.query(
      `${EVENT_SELECT}
        WHERE e.nightclub_id = $1
          AND ($2::text IS NULL OR e.status = $2)
          AND ($3::date IS NULL OR e.event_date >= $3::date)
          AND ($4::date IS NULL OR e.event_date <= $4::date)
          AND ($5::boolean IS FALSE OR e.event_date >= current_date)
        ORDER BY e.event_date ASC
        LIMIT $6 OFFSET $7`,
      [req.params.nightclubId, status, req.query.from || null, req.query.to || null,
        req.query.upcoming, req.query.limit, req.query.offset],
    );
    res.json({ events: rows });
  }));

router.get('/nightclubs/:nightclubId/events/:eventId',
  validate({ params: z.object({ nightclubId: uuid, eventId: uuid }) }),
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(`${EVENT_SELECT} WHERE e.id = $1 AND e.nightclub_id = $2`,
      [req.params.eventId, req.params.nightclubId]);
    if (rows.length === 0) throw ApiError.notFound('Event not found');

    const isStaff = ['hostess', 'waiter', 'bartender', 'manager', 'admin'].includes(req.user.role);
    if (!isStaff && rows[0].status !== 'published') throw ApiError.notFound('Event not found');
    res.json({ event: rows[0] });
  }));

const eventBody = z.object({
  name: z.string().trim().min(1).max(150),
  event_date: isoDate,
  doors_open_at: z.coerce.date(),
  closes_at: z.coerce.date().optional(),
  ticket_price: z.number().min(0),
  currency: currency.default('MXN'),
  arrival_deadline_minutes: z.number().int().min(15).max(720).default(180),
  // El anticipo de esta noche. `null` lo devuelve a la regla del club, y es
  // distinto de 0 ("esta noche se aparta sin anticipo"): por eso es nullable y
  // no solo opcional.
  deposit_pct: z.number().min(0).max(100).nullable().optional(),
  status: z.enum(['draft', 'published', 'cancelled']).default('draft'),
  description: z.string().trim().max(2000).optional(),
  cover_image_url: z.string().url().max(500).optional(),
});

router.post('/nightclubs/:nightclubId/events',
  requireRole('manager'),
  validate({ params: z.object({ nightclubId: uuid }), body: eventBody }),
  asyncHandler(async (req, res) => {
    const b = req.body;
    if (b.closes_at && b.closes_at <= b.doors_open_at) {
      throw ApiError.unprocessable('closes_at must be after doors_open_at');
    }
    try {
      const { rows } = await pool.query(
        `INSERT INTO events_calendar (nightclub_id, name, slug, event_date, doors_open_at, closes_at,
                                      ticket_price, currency, arrival_deadline_minutes, status,
                                      description, cover_image_url, deposit_pct, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
        [req.params.nightclubId, b.name, slugify(b.name), b.event_date, b.doors_open_at,
          b.closes_at || null, b.ticket_price, b.currency, b.arrival_deadline_minutes,
          b.status, b.description || null, b.cover_image_url || null,
          b.deposit_pct === undefined ? null : b.deposit_pct, req.user.id],
      );
      const full = await pool.query(`${EVENT_SELECT} WHERE e.id = $1`, [rows[0].id]);
      res.status(201).json({ event: full.rows[0] });
    } catch (err) {
      if (err.code === '23505') throw ApiError.conflict('Ya existe un evento para esa fecha');
      throw err;
    }
  }));

router.patch('/nightclubs/:nightclubId/events/:eventId',
  requireRole('manager'),
  validate({
    params: z.object({ nightclubId: uuid, eventId: uuid }),
    body: eventBody.partial().extend({
      status: z.enum(['draft', 'published', 'cancelled', 'finished']).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const fields = Object.keys(req.body);
    if (fields.length === 0) throw ApiError.badRequest('No fields to update');

    const current = await pool.query(
      'SELECT status, ticket_price, deposit_pct FROM events_calendar WHERE id = $1 AND nightclub_id = $2',
      [req.params.eventId, req.params.nightclubId]);
    if (current.rowCount === 0) throw ApiError.notFound('Event not found');

    // Changing the ticket price or the deposit after people have booked would not change
    // what they were charged -- both are frozen onto the reservation -- so warn instead of
    // silently allowing it. The deposit matters as much as the price here: a manager who
    // raises it from 30% to 100% for a big night would otherwise assume the twelve tables
    // already sold now owe the full amount, and they do not.
    // Comparacion NUMERICA, no de cadenas: Postgres devuelve NUMERIC(5,2) como
    // '30.00' y el cuerpo trae 30, asi que compararlos como texto avisaba de un
    // cambio que no ocurrio -- y un aviso que sale siempre es un aviso que nadie
    // lee. `null` se compara aparte porque "sin anticipo propio" y "0%" son cosas
    // distintas y ninguna es la otra.
    const cambia = (campo) => {
      if (req.body[campo] === undefined) return false;
      const nuevo = req.body[campo];
      const viejo = current.rows[0][campo];
      if (nuevo == null || viejo == null) return (nuevo == null) !== (viejo == null);
      return Number(nuevo) !== Number(viejo);
    };
    if (cambia('ticket_price') || cambia('deposit_pct')) {
      const booked = await pool.query(
        `SELECT count(*)::int AS n FROM reservations
          WHERE event_id = $1 AND status IN ('pending_payment','confirmed','seated')`,
        [req.params.eventId]);
      if (booked.rows[0].n > 0) {
        res.set('X-Warning',
          `${booked.rows[0].n} reservation(s) keep the price and deposit agreed at booking`);
      }
    }

    const sets = fields.map((f, i) => `${f} = $${i + 3}`).join(', ');
    const { rows } = await pool.query(
      `UPDATE events_calendar SET ${sets} WHERE id = $2 AND nightclub_id = $1 RETURNING id`,
      [req.params.nightclubId, req.params.eventId, ...fields.map((f) => req.body[f])],
    );
    if (rows.length === 0) throw ApiError.notFound('Event not found');

    const full = await pool.query(`${EVENT_SELECT} WHERE e.id = $1`, [rows[0].id]);
    res.json({ event: full.rows[0] });
  }));

router.delete('/nightclubs/:nightclubId/events/:eventId',
  requireRole('manager'),
  validate({ params: z.object({ nightclubId: uuid, eventId: uuid }) }),
  asyncHandler(async (req, res) => {
    // An event with live reservations is cancelled, never deleted: the bookings and the
    // money attached to them must remain traceable.
    const booked = await pool.query(
      `SELECT count(*)::int AS n FROM reservations
        WHERE event_id = $1 AND status IN ('pending_payment','confirmed','seated')`,
      [req.params.eventId]);
    if (booked.rows[0].n > 0) {
      throw ApiError.conflict(
        `El evento tiene ${booked.rows[0].n} reservación(es) activas: cancélalo en lugar de borrarlo`,
        { reservations: booked.rows[0].n });
    }
    const { rowCount } = await pool.query(
      'DELETE FROM events_calendar WHERE id = $1 AND nightclub_id = $2',
      [req.params.eventId, req.params.nightclubId]);
    if (rowCount === 0) throw ApiError.notFound('Event not found');
    res.status(204).end();
  }));

// ----------------------------------------------------- zone prices per event
router.get('/nightclubs/:nightclubId/events/:eventId/zones',
  validate({ params: z.object({ nightclubId: uuid, eventId: uuid }) }),
  asyncHandler(async (req, res) => {
    const { event, zones } = await eventPricing.getEventPricing({
      nightclubId: req.params.nightclubId, eventId: req.params.eventId,
    });
    const isStaff = ['hostess', 'waiter', 'bartender', 'manager', 'admin'].includes(req.user.role);
    if (!isStaff && event.status !== 'published') throw ApiError.notFound('Event not found');

    res.json({
      event: {
        id: event.id, name: event.name, event_date: event.event_date,
        doors_open_at: event.doors_open_at, ticket_price: event.ticket_price,
        currency: event.currency, status: event.status,
        arrival_deadline: eventPricing.arrivalDeadline(event).toISOString(),
      },
      zones: zones.map((zone) => ({
        section: zone.section,
        display_name: zone.display_name,
        base_price: zone.base_price,
        included_tickets: zone.included_tickets,
        max_extras: zone.max_extras,
        max_guests: Number(zone.included_tickets) + Number(zone.max_extras),
        reservable: zone.reservable,
        currency: zone.currency,
        color: zone.color,
        includes: zone.includes,
        overridden: zone.overridden,
        override_note: isStaff ? zone.override_note : undefined,
      })),
    });
  }));

const overrideBody = z.object({
  base_price: z.number().min(0).nullable().optional(),
  included_tickets: z.number().int().min(1).nullable().optional(),
  max_extras: z.number().int().min(0).nullable().optional(),
  reservable: z.boolean().nullable().optional(),
  note: z.string().trim().max(300).nullable().optional(),
});

router.put('/nightclubs/:nightclubId/events/:eventId/zones/:section',
  requireRole('manager'),
  validate({
    params: z.object({ nightclubId: uuid, eventId: uuid, section: z.string().trim().min(1).max(40) }),
    body: overrideBody,
  }),
  asyncHandler(async (req, res) => {
    const { nightclubId, eventId, section } = req.params;

    const event = await pool.query(
      'SELECT id FROM events_calendar WHERE id = $1 AND nightclub_id = $2', [eventId, nightclubId]);
    if (event.rowCount === 0) throw ApiError.notFound('Event not found');

    const zone = await pool.query(
      'SELECT section FROM zone_pricing WHERE nightclub_id = $1 AND section = $2 AND active',
      [nightclubId, section]);
    if (zone.rowCount === 0) throw ApiError.notFound(`La zona '${section}' no está en la lista de precios`);

    const b = req.body;
    const { rows } = await pool.query(
      `INSERT INTO event_zone_pricing (event_id, section, base_price, included_tickets,
                                       max_extras, reservable, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (event_id, section) DO UPDATE SET
         base_price = EXCLUDED.base_price, included_tickets = EXCLUDED.included_tickets,
         max_extras = EXCLUDED.max_extras, reservable = EXCLUDED.reservable,
         note = EXCLUDED.note, updated_at = now()
       RETURNING section, base_price, included_tickets, max_extras, reservable, note`,
      [eventId, section, b.base_price ?? null, b.included_tickets ?? null,
        b.max_extras ?? null, b.reservable ?? null, b.note ?? null],
    );
    res.json({ override: rows[0] });
  }));

router.delete('/nightclubs/:nightclubId/events/:eventId/zones/:section',
  requireRole('manager'),
  validate({
    params: z.object({ nightclubId: uuid, eventId: uuid, section: z.string().trim().min(1).max(40) }),
  }),
  asyncHandler(async (req, res) => {
    const { rowCount } = await pool.query(
      `DELETE FROM event_zone_pricing o
        USING events_calendar e
        WHERE o.event_id = e.id AND e.nightclub_id = $1
          AND o.event_id = $2 AND o.section = $3`,
      [req.params.nightclubId, req.params.eventId, req.params.section]);
    if (rowCount === 0) throw ApiError.notFound('No hay ajuste para esa zona en ese evento');
    res.status(204).end();
  }));

// --------------------------------------------------------- standing price list
router.get('/nightclubs/:nightclubId/zone-pricing',
  validate({ params: z.object({ nightclubId: uuid }) }),
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT section, display_name, base_price, included_tickets, max_extras,
              (included_tickets + max_extras) AS max_guests,
              currency, color, includes, reservable, sort_order
         FROM zone_pricing WHERE nightclub_id = $1 AND active
        ORDER BY sort_order, section`,
      [req.params.nightclubId],
    );
    res.json({ zones: rows });
  }));

const zonePricingBody = z.object({
  display_name: z.string().trim().max(80).optional(),
  base_price: z.number().min(0),
  included_tickets: z.number().int().min(1),
  max_extras: z.number().int().min(0).default(0),
  currency: currency.default('MXN'),
  color: z.string().trim().max(9).optional(),
  includes: z.array(z.string().trim().max(120)).max(20).default([]),
  reservable: z.boolean().default(true),
  sort_order: z.number().int().default(0),
});

router.put('/nightclubs/:nightclubId/zone-pricing/:section',
  requireRole('manager'),
  validate({
    params: z.object({ nightclubId: uuid, section: z.string().trim().min(1).max(40) }),
    body: zonePricingBody,
  }),
  asyncHandler(async (req, res) => {
    const b = req.body;
    const { rows } = await pool.query(
      `INSERT INTO zone_pricing (nightclub_id, section, display_name, base_price, included_tickets,
                                 max_extras, currency, color, includes, reservable, sort_order, active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,true)
       ON CONFLICT (nightclub_id, section) DO UPDATE SET
         display_name = EXCLUDED.display_name, base_price = EXCLUDED.base_price,
         included_tickets = EXCLUDED.included_tickets, max_extras = EXCLUDED.max_extras,
         currency = EXCLUDED.currency, color = EXCLUDED.color, includes = EXCLUDED.includes,
         reservable = EXCLUDED.reservable, sort_order = EXCLUDED.sort_order, active = true
       RETURNING section, display_name, base_price, included_tickets, max_extras,
                 currency, color, includes, reservable, sort_order`,
      [req.params.nightclubId, req.params.section, b.display_name || req.params.section,
        b.base_price, b.included_tickets, b.max_extras, b.currency, b.color || null,
        JSON.stringify(b.includes), b.reservable, b.sort_order],
    );
    res.json({ zone: rows[0] });
  }));

// ------------------------------------------------------ bottles and add-ons
router.get('/nightclubs/:nightclubId/reservation-products',
  validate({
    params: z.object({ nightclubId: uuid }),
    query: z.object({ kind: z.enum(['bottle', 'addon']).optional() }),
  }),
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT kind, code, name, price, currency, servings, description
         FROM reservation_products
        WHERE nightclub_id = $1 AND active AND ($2::text IS NULL OR kind = $2)
        ORDER BY kind, sort_order, name`,
      [req.params.nightclubId, req.query.kind || null],
    );
    res.json({ products: rows });
  }));

router.put('/nightclubs/:nightclubId/reservation-products/:code',
  requireRole('manager'),
  validate({
    params: z.object({ nightclubId: uuid, code: z.string().trim().min(1).max(40) }),
    body: z.object({
      kind: z.enum(['bottle', 'addon']),
      name: z.string().trim().min(1).max(120),
      price: z.number().min(0),
      currency: currency.default('MXN'),
      servings: z.number().int().min(1).optional(),
      description: z.string().trim().max(500).optional(),
      sort_order: z.number().int().default(0),
      active: z.boolean().default(true),
    }),
  }),
  asyncHandler(async (req, res) => {
    const b = req.body;
    const { rows } = await pool.query(
      `INSERT INTO reservation_products (nightclub_id, kind, code, name, price, currency,
                                         servings, description, sort_order, active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (nightclub_id, code) DO UPDATE SET
         kind = EXCLUDED.kind, name = EXCLUDED.name, price = EXCLUDED.price,
         currency = EXCLUDED.currency, servings = EXCLUDED.servings,
         description = EXCLUDED.description, sort_order = EXCLUDED.sort_order,
         active = EXCLUDED.active
       RETURNING kind, code, name, price, currency, servings, description, active`,
      [req.params.nightclubId, b.kind, req.params.code, b.name, b.price, b.currency,
        b.servings || null, b.description || null, b.sort_order, b.active],
    );
    res.json({ product: rows[0] });
  }));

function slugify(text) {
  return text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 150);
}

module.exports = router;
