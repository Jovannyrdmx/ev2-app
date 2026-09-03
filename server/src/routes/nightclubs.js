// Nightclub profile, staff directory, emergency contacts, event catch-up and dashboard.
'use strict';

const express = require('express');
const { pool } = require('../db/pool');
const { ApiError, asyncHandler } = require('../middleware/errors');
const { validate, z, uuid } = require('../middleware/validate');
const { authenticate, requireRole, sameNightclub } = require('../middleware/auth');
const events = require('../services/events');

const router = express.Router({ mergeParams: true });

// Public: lets the web app resolve a slug before anyone signs in.
router.get('/nightclubs/by-slug/:slug',
  validate({ params: z.object({ slug: z.string().trim().min(1).max(100) }) }),
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT id, name, slug, city, country, timezone, currency_default
         FROM nightclubs WHERE slug = $1 AND active`,
      [req.params.slug],
    );
    if (rows.length === 0) throw ApiError.notFound('Nightclub not found');
    res.json({ nightclub: rows[0] });
  }));

router.use('/nightclubs/:nightclubId', authenticate, sameNightclub());

router.get('/nightclubs/:nightclubId',
  validate({ params: z.object({ nightclubId: uuid }) }),
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT id, name, slug, address, city, country, phone, timezone, currency_default, capacity, settings
         FROM nightclubs WHERE id = $1`,
      [req.params.nightclubId],
    );
    if (rows.length === 0) throw ApiError.notFound('Nightclub not found');
    res.json({ nightclub: rows[0] });
  }));

// Staff directory (used by tipping, song requests, table assignment).
router.get('/nightclubs/:nightclubId/staff',
  validate({
    params: z.object({ nightclubId: uuid }),
    query: z.object({
      role: z.enum(['waiter', 'bartender', 'dancer', 'dj', 'light_tech', 'valet', 'hostess', 'manager']).optional(),
      on_shift: z.coerce.boolean().default(false),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT u.id, u.display_name, u.role, ep.stage_name, ep.avatar_url,
              (s.id IS NOT NULL) AS on_shift, s.section
         FROM users u
         LEFT JOIN employee_profiles ep ON ep.user_id = u.id
         LEFT JOIN staff_shifts s ON s.user_id = u.id AND s.ended_at IS NULL
        WHERE u.nightclub_id = $1 AND u.status = 'active'
          AND u.role <> 'guest'
          AND ($2::text IS NULL OR u.role = $2)
          AND ($3::boolean IS FALSE OR s.id IS NOT NULL)
        ORDER BY u.role, COALESCE(ep.stage_name, u.display_name)`,
      [req.params.nightclubId, req.query.role || null, req.query.on_shift],
    );
    res.json({ staff: rows });
  }));

router.get('/nightclubs/:nightclubId/emergency-contacts',
  validate({ params: z.object({ nightclubId: uuid }) }),
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT id, name, phone, type FROM emergency_contacts
        WHERE nightclub_id = $1 AND active ORDER BY sort_order, name`,
      [req.params.nightclubId],
    );
    res.json({ contacts: rows });
  }));

// Event catch-up after a reconnect (the WS server uses the same source in phase 3).
router.get('/nightclubs/:nightclubId/events',
  validate({
    params: z.object({ nightclubId: uuid }),
    query: z.object({
      since_id: z.coerce.number().int().min(0).default(0),
      limit: z.coerce.number().int().min(1).max(500).default(200),
    }),
  }),
  asyncHandler(async (req, res) => {
    const all = await events.since({
      nightclubId: req.params.nightclubId,
      sinceId: req.query.since_id,
      limit: req.query.limit,
    });
    const mine = all.filter((e) => events.matchesAudience(e.audience, req.user));
    res.json({ events: mine, last_id: all.length ? all[all.length - 1].id : req.query.since_id });
  }));

router.get('/nightclubs/:nightclubId/dashboard',
  requireRole('manager'),
  validate({ params: z.object({ nightclubId: uuid }) }),
  asyncHandler(async (req, res) => {
    const id = req.params.nightclubId;
    const [tables, orders, revenue, staff] = await Promise.all([
      pool.query(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE status = 'occupied')::int AS occupied,
                count(*) FILTER (WHERE status = 'available')::int AS available,
                count(*) FILTER (WHERE status = 'reserved')::int AS reserved
           FROM tables WHERE nightclub_id = $1 AND active`, [id]),
      pool.query(
        `SELECT count(*) FILTER (WHERE status IN ('pending','confirmed','preparing'))::int AS in_progress,
                count(*) FILTER (WHERE status = 'ready')::int AS ready,
                count(*) FILTER (WHERE status = 'delivered')::int AS delivered_today,
                count(*) FILTER (WHERE status = 'pos_error')::int AS pos_errors
           FROM drink_orders
          WHERE nightclub_id = $1 AND created_at > date_trunc('day', now() - interval '6 hours')`, [id]),
      pool.query(
        `SELECT currency, COALESCE(sum(amount), 0) AS total, count(*)::int AS count
           FROM transactions
          WHERE nightclub_id = $1 AND status = 'paid'
            AND created_at > date_trunc('day', now() - interval '6 hours')
          GROUP BY currency`, [id]),
      pool.query(
        `SELECT count(*)::int AS on_shift FROM staff_shifts WHERE nightclub_id = $1 AND ended_at IS NULL`, [id]),
    ]);

    res.json({
      tables: tables.rows[0],
      orders: orders.rows[0],
      revenue_today: revenue.rows,
      staff: staff.rows[0],
      generated_at: new Date().toISOString(),
    });
  }));

module.exports = router;
