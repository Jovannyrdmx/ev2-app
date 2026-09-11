// Flirt: opt-in, in-venue, same-night only (docs/DECISIONES.md D18).
//
// Protection comes first, function second:
//   * nobody receives a flirt without opting in, and nobody is listed without opting in;
//   * both people must be seated in the club right now;
//   * 20 flirts/hour per sender, 3 unanswered to the same person per night, and a
//     "not interested" reaction silences that sender for the rest of the night;
//   * a block hides both people from each other and every send fails with a neutral 404;
//   * the manager sees counts and reports, never contents.
//
// Drink and bottle gifts are REAL orders: charged to the sender when placed and
// prepared right away. If the recipient declines, the order goes back to the sender's
// table — it is never cancelled and never refunded.
'use strict';

const express = require('express');
const { pool } = require('../db/pool');
const { ApiError, asyncHandler } = require('../middleware/errors');
const { validate, z, uuid, pagination } = require('../middleware/validate');
const { authenticate, requireRole, sameNightclub } = require('../middleware/auth');
const events = require('../services/events');
const { createOrder, ORDER_SELECT } = require('../services/orders');

const router = express.Router({ mergeParams: true });

// Limits (D18). Kept here so the tests and the contract quote the same numbers.
const LIMITS = {
  perHour: 20,
  unansweredPerNight: 3,
  nightHours: 12, // a flirt lives this long at most
  openReportsToHide: 2, // used by part 2; discovery already honours it
  messageMax: 140,
};

// The only emojis a client may send. Keys are what travels; icons are for display.
const EMOJI_CATALOGUE = {
  wave: { icon: '👋', label_es: 'Saludo' },
  wink: { icon: '😉', label_es: 'Guiño' },
  kiss: { icon: '😘', label_es: 'Beso' },
  fire: { icon: '🔥', label_es: 'Fuego' },
  heart: { icon: '❤️', label_es: 'Corazón' },
  dance: { icon: '💃', label_es: 'Baile' },
  star: { icon: '⭐', label_es: 'Estrella' },
};

const REACTIONS = ['like', 'wave', 'kiss', 'fire', 'interested', 'not_interested'];

// What a flirt looks like to the two people involved. Never exposes email or phone.
const FLIRT_SELECT = `
  SELECT f.id, f.type, f.emoji, f.message, f.status, f.created_at, f.viewed_at, f.expires_at,
         f.drink_order_id,
         f.sender_id,    su.display_name AS sender_name,
         f.recipient_id, ru.display_name AS recipient_name,
         f.sender_table_id, st.code AS sender_table_code, st.section AS sender_section,
         r.reaction, r.created_at AS reacted_at
    FROM flirts f
    JOIN users su ON su.id = f.sender_id
    JOIN users ru ON ru.id = f.recipient_id
    LEFT JOIN tables st ON st.id = f.sender_table_id
    LEFT JOIN flirt_reactions r ON r.flirt_id = f.id AND r.user_id = f.recipient_id`;

// ---------------------------------------------------------------- helpers

/** The table this user is seated at right now, or null. */
async function seatedAt(userId, runner = pool) {
  const { rows } = await runner.query(
    `SELECT t.id, t.code, t.section, t.floor
       FROM table_occupants o JOIN tables t ON t.id = o.table_id
      WHERE o.user_id = $1 AND o.left_at IS NULL`,
    [userId]);
  return rows[0] || null;
}

async function blockedEitherWay(a, b, runner = pool) {
  const { rows } = await runner.query(
    `SELECT 1 FROM user_blocks
      WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1)
      LIMIT 1`,
    [a, b]);
  return rows.length > 0;
}

async function preferencesFor(userId, runner = pool) {
  const { rows } = await runner.query(
    `SELECT accept_flirts, discoverable, show_on_map, notifications, updated_at
       FROM user_preferences WHERE user_id = $1`,
    [userId]);
  return rows[0] || {
    accept_flirts: false, discoverable: false, show_on_map: true, notifications: {}, updated_at: null,
  };
}

/**
 * Everything that must be true before `sender` may send to `recipient`. Throws the
 * right error; a block or a hidden recipient answers with the same neutral 404 so
 * the sender learns nothing.
 */
async function assertCanSend({ nightclubId, sender, recipientId, runner }) {
  if (sender.id === recipientId) throw ApiError.unprocessable('No puedes enviarte un flirt a ti mismo');

  const senderTable = await seatedAt(sender.id, runner);
  if (!senderTable) throw ApiError.unprocessable('Tienes que estar sentado en una mesa para enviar un flirt');

  const rec = await runner.query(
    `SELECT u.id, u.display_name, u.status, u.role,
            p.accept_flirts,
            (SELECT count(*)::int FROM user_reports r
              WHERE r.reported_id = u.id AND r.status = 'open') AS open_reports
       FROM users u LEFT JOIN user_preferences p ON p.user_id = u.id
      WHERE u.id = $1 AND u.nightclub_id = $2`,
    [recipientId, nightclubId]);
  const recipient = rec.rows[0];
  const unavailable = ApiError.notFound('Esa persona no está disponible');
  if (!recipient || recipient.status !== 'active' || recipient.role !== 'guest') throw unavailable;
  if (recipient.open_reports >= LIMITS.openReportsToHide) throw unavailable;
  if (await blockedEitherWay(sender.id, recipientId, runner)) throw unavailable;

  if (!recipient.accept_flirts) throw ApiError.forbidden('Esa persona no acepta flirts');

  const recipientTable = await seatedAt(recipientId, runner);
  if (!recipientTable) throw ApiError.unprocessable('Esa persona ya no está en el club');

  // "Not interested" tonight ends the conversation for the night.
  const silenced = await runner.query(
    `SELECT 1 FROM flirt_reactions r JOIN flirts f ON f.id = r.flirt_id
      WHERE f.sender_id = $1 AND f.recipient_id = $2 AND r.user_id = $2
        AND r.reaction = 'not_interested' AND r.created_at > now() - make_interval(hours => $3)
      LIMIT 1`,
    [sender.id, recipientId, LIMITS.nightHours]);
  if (silenced.rows.length > 0) throw ApiError.forbidden('Esa persona pidió no recibir más flirts tuyos esta noche');

  const hourly = await runner.query(
    `SELECT count(*)::int AS n FROM flirts
      WHERE sender_id = $1 AND created_at > now() - interval '1 hour'`,
    [sender.id]);
  if (hourly.rows[0].n >= LIMITS.perHour) {
    throw ApiError.tooMany(`Máximo ${LIMITS.perHour} flirts por hora`);
  }

  const unanswered = await runner.query(
    `SELECT count(*)::int AS n FROM flirts f
      WHERE f.sender_id = $1 AND f.recipient_id = $2
        AND f.created_at > now() - make_interval(hours => $3)
        AND f.status IN ('sent', 'viewed')
        AND NOT EXISTS (SELECT 1 FROM flirt_reactions r WHERE r.flirt_id = f.id AND r.user_id = $2)`,
    [sender.id, recipientId, LIMITS.nightHours]);
  if (unanswered.rows[0].n >= LIMITS.unansweredPerNight) {
    throw ApiError.tooMany(
      `Ya enviaste ${LIMITS.unansweredPerNight} flirts sin respuesta a esa persona; espera a que responda`);
  }

  return { senderTable, recipient, recipientTable };
}

// ---------------------------------------------------------------- preferences

router.get('/me/preferences', authenticate, asyncHandler(async (req, res) => {
  res.json({ preferences: await preferencesFor(req.user.id) });
}));

router.put('/me/preferences', authenticate,
  validate({
    body: z.object({
      accept_flirts: z.boolean().optional(),
      discoverable: z.boolean().optional(),
      show_on_map: z.boolean().optional(),
      notifications: z.record(z.boolean()).optional(),
    }).refine((b) => Object.keys(b).length > 0, { message: 'No fields to update' }),
  }),
  asyncHandler(async (req, res) => {
    const b = req.body;
    const { rows } = await pool.query(
      `INSERT INTO user_preferences (user_id, accept_flirts, discoverable, show_on_map, notifications)
       VALUES ($1, COALESCE($2, false), COALESCE($3, false), COALESCE($4, true), COALESCE($5, '{}'::jsonb))
       ON CONFLICT (user_id) DO UPDATE SET
         accept_flirts = COALESCE($2, user_preferences.accept_flirts),
         discoverable  = COALESCE($3, user_preferences.discoverable),
         show_on_map   = COALESCE($4, user_preferences.show_on_map),
         notifications = COALESCE($5, user_preferences.notifications),
         updated_at    = now()
       RETURNING accept_flirts, discoverable, show_on_map, notifications, updated_at`,
      [req.user.id, b.accept_flirts ?? null, b.discoverable ?? null, b.show_on_map ?? null,
        b.notifications ? JSON.stringify(b.notifications) : null],
    );
    res.json({ preferences: rows[0] });
  }));

// ---------------------------------------------------------------- club routes

router.use('/nightclubs/:nightclubId', authenticate, sameNightclub());

router.get('/nightclubs/:nightclubId/flirts/catalogue',
  validate({ params: z.object({ nightclubId: uuid }) }),
  (req, res) => {
    res.json({
      emojis: Object.entries(EMOJI_CATALOGUE).map(([key, v]) => ({ key, ...v })),
      reactions: REACTIONS,
      limits: {
        per_hour: LIMITS.perHour,
        unanswered_per_night: LIMITS.unansweredPerNight,
        message_max: LIMITS.messageMax,
      },
    });
  });

/**
 * People available tonight: guests seated right now who chose to be listed, minus
 * anyone blocked either way and anyone with open reports. Only name, table and zone
 * leave the server.
 */
router.get('/nightclubs/:nightclubId/flirts/people',
  validate({
    params: z.object({ nightclubId: uuid }),
    query: pagination.extend({ section: z.string().trim().max(40).optional() }),
  }),
  asyncHandler(async (req, res) => {
    const me = req.user.id;
    if (!(await seatedAt(me))) {
      throw ApiError.unprocessable('Siéntate en una mesa para ver quién está esta noche');
    }
    const { rows } = await pool.query(
      `SELECT u.id, u.display_name,
              t.id AS table_id, t.code AS table_code, t.section, t.floor,
              p.accept_flirts
         FROM table_occupants o
         JOIN users u  ON u.id = o.user_id
         JOIN tables t ON t.id = o.table_id
         JOIN user_preferences p ON p.user_id = u.id
        WHERE o.left_at IS NULL
          AND u.nightclub_id = $1 AND u.id <> $2
          AND u.role = 'guest' AND u.status = 'active'
          AND u.birth_date <= (current_date - interval '18 years')
          AND p.discoverable
          AND ($3::text IS NULL OR t.section = $3)
          AND NOT EXISTS (SELECT 1 FROM user_blocks b
                           WHERE (b.blocker_id = $2 AND b.blocked_id = u.id)
                              OR (b.blocker_id = u.id AND b.blocked_id = $2))
          AND (SELECT count(*) FROM user_reports r
                WHERE r.reported_id = u.id AND r.status = 'open') < $4
        ORDER BY t.floor, t.section, t.code, u.display_name
        LIMIT $5 OFFSET $6`,
      [req.params.nightclubId, me, req.query.section || null, LIMITS.openReportsToHide,
        req.query.limit, req.query.offset],
    );
    res.json({ people: rows });
  }));

// ---------------------------------------------------------------- send

const sendSchema = z.object({
  client_request_id: uuid,
  recipient_id: uuid,
  type: z.enum(['emoji', 'meet', 'drink', 'bottle']),
  emoji: z.enum(Object.keys(EMOJI_CATALOGUE)).optional(),
  message: z.string().trim().max(LIMITS.messageMax).optional(),
  drink_id: uuid.optional(),
  quantity: z.number().int().min(1).max(10).default(1),
}).refine((b) => b.type !== 'emoji' || b.emoji, { message: 'emoji is required for type emoji', path: ['emoji'] });

router.post('/nightclubs/:nightclubId/flirts',
  validate({ params: z.object({ nightclubId: uuid }), body: sendSchema }),
  asyncHandler(async (req, res) => {
    const { nightclubId } = req.params;
    const b = req.body;
    if (req.user.role !== 'guest') throw ApiError.forbidden('Solo los clientes envían flirts');

    const dup = await pool.query(`${FLIRT_SELECT} WHERE f.client_request_id = $1 AND f.sender_id = $2`,
      [b.client_request_id, req.user.id]);
    if (dup.rowCount > 0) {
      res.set('Idempotent-Replay', 'true');
      return res.status(200).json({ flirt: dup.rows[0] });
    }

    const isGift = b.type === 'drink' || b.type === 'bottle';
    if (isGift && !b.drink_id) throw ApiError.badRequest('drink_id is required to send a drink or a bottle');

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { senderTable, recipientTable, recipient } = await assertCanSend({
        nightclubId, sender: req.user, recipientId: b.recipient_id, runner: client,
      });

      // A gift is a real order for the recipient's table, paid by the sender (D18).
      let order = null;
      if (isGift) {
        // The ledger entry is created by createOrder, together with the order, so a gift
        // cannot end up with two charges or none -- which is what happened while this
        // route inserted its own alongside the one the order already had.
        order = await createOrder({
          client, nightclubId, senderId: req.user.id, recipientId: b.recipient_id,
          tableId: recipientTable.id, clientRequestId: b.client_request_id,
          message: `Invitación de ${req.user.display_name} (mesa ${senderTable.code})`,
          items: [{ drink_id: b.drink_id, quantity: b.quantity }],
          chargeType: b.type === 'bottle' ? 'bottle_service' : 'drink_order',
          chargeMetadata: { gift: true, recipient_id: b.recipient_id, non_refundable: true },
        });
      }

      const created = await client.query(
        `INSERT INTO flirts (nightclub_id, sender_id, recipient_id, type, emoji, message,
                             client_request_id, sender_table_id, drink_order_id, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now() + make_interval(hours => $10))
         RETURNING id`,
        [nightclubId, req.user.id, b.recipient_id, b.type, b.emoji || null, b.message || null,
          b.client_request_id, senderTable.id, order ? order.id : null, LIMITS.nightHours],
      );

      await events.publish({
        nightclubId, type: 'flirt_received', client,
        audience: { userIds: [b.recipient_id] },
        payload: {
          flirt_id: created.rows[0].id, type: b.type, emoji: b.emoji || null,
          from_table: senderTable.code, to_table: recipientTable.code,
          order_id: order ? order.id : null,
        },
      });
      if (order) {
        await events.publish({
          nightclubId, type: 'order_created', client,
          audience: { roles: ['bartender', 'manager'], userIds: [req.user.id, recipient.id] },
          payload: { order_id: order.id, table_id: recipientTable.id, gift: true,
            subtotal: order.subtotal, currency: order.currency },
        });
      }
      await client.query('COMMIT');

      const full = await pool.query(`${FLIRT_SELECT} WHERE f.id = $1`, [created.rows[0].id]);
      return res.status(201).json({ flirt: full.rows[0] });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }));

// ---------------------------------------------------------------- inbox

// Tonight's flirts only; anything past its expiry is history and stays out of the app.
router.get('/nightclubs/:nightclubId/flirts/received',
  validate({ params: z.object({ nightclubId: uuid }), query: pagination }),
  asyncHandler(async (req, res) => {
    const prefs = await preferencesFor(req.user.id);
    if (!prefs.accept_flirts) return res.json({ flirts: [], accept_flirts: false });
    const { rows } = await pool.query(
      `${FLIRT_SELECT}
        WHERE f.recipient_id = $1 AND f.expires_at > now()
          AND NOT EXISTS (SELECT 1 FROM user_blocks b
                           WHERE b.blocker_id = $1 AND b.blocked_id = f.sender_id)
        ORDER BY f.created_at DESC LIMIT $2 OFFSET $3`,
      [req.user.id, req.query.limit, req.query.offset]);
    res.json({ flirts: rows, accept_flirts: true });
  }));

router.get('/nightclubs/:nightclubId/flirts/sent',
  validate({ params: z.object({ nightclubId: uuid }), query: pagination }),
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(
      `${FLIRT_SELECT}
        WHERE f.sender_id = $1 AND f.expires_at > now()
        ORDER BY f.created_at DESC LIMIT $2 OFFSET $3`,
      [req.user.id, req.query.limit, req.query.offset]);
    res.json({ flirts: rows });
  }));

async function ownReceivedFlirt(flirtId, userId, runner = pool) {
  const { rows } = await runner.query(
    'SELECT * FROM flirts WHERE id = $1 FOR UPDATE', [flirtId]);
  const f = rows[0];
  if (!f || f.recipient_id !== userId) throw ApiError.notFound('Flirt not found');
  if (new Date(f.expires_at) < new Date()) throw ApiError.conflict('Ese flirt ya caducó');
  return f;
}

router.post('/nightclubs/:nightclubId/flirts/:flirtId/view',
  validate({ params: z.object({ nightclubId: uuid, flirtId: uuid }) }),
  asyncHandler(async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const f = await ownReceivedFlirt(req.params.flirtId, req.user.id, client);
      if (!f.viewed_at) {
        await client.query(
          `UPDATE flirts SET viewed_at = now(), status = CASE WHEN status = 'sent' THEN 'viewed' ELSE status END
            WHERE id = $1`, [f.id]);
      }
      await client.query('COMMIT');
      const full = await pool.query(`${FLIRT_SELECT} WHERE f.id = $1`, [f.id]);
      res.json({ flirt: full.rows[0] });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }));

/**
 * The recipient answers. `not_interested` declines the flirt and silences that
 * sender for the rest of the night; anything else accepts it.
 */
router.post('/nightclubs/:nightclubId/flirts/:flirtId/react',
  validate({
    params: z.object({ nightclubId: uuid, flirtId: uuid }),
    body: z.object({ reaction: z.enum(REACTIONS) }),
  }),
  asyncHandler(async (req, res) => {
    const { nightclubId, flirtId } = req.params;
    const { reaction } = req.body;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const f = await ownReceivedFlirt(flirtId, req.user.id, client);

      await client.query(
        `INSERT INTO flirt_reactions (flirt_id, user_id, reaction) VALUES ($1,$2,$3)
         ON CONFLICT (flirt_id, user_id) DO UPDATE SET reaction = EXCLUDED.reaction, created_at = now()`,
        [f.id, req.user.id, reaction]);
      const status = reaction === 'not_interested' ? 'declined' : 'accepted';
      await client.query(
        `UPDATE flirts SET status = $2, viewed_at = COALESCE(viewed_at, now()) WHERE id = $1`,
        [f.id, status]);

      // Declining a drink or bottle hands the order back to the sender's table. It is
      // never cancelled and never refunded (D18).
      let returned = null;
      if (status === 'declined' && f.drink_order_id) {
        returned = await returnGiftToSender({ client, nightclubId, flirt: f });
      }

      await events.publish({
        nightclubId, type: 'flirt_reaction', client,
        audience: { userIds: [f.sender_id] },
        payload: { flirt_id: f.id, reaction, status, order_returned: !!returned },
      });
      await client.query('COMMIT');

      const full = await pool.query(`${FLIRT_SELECT} WHERE f.id = $1`, [f.id]);
      res.json({ flirt: full.rows[0] });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }));

/**
 * Moves a declined gift order to the sender's table. Works for orders still in the
 * bar's hands; a delivered or cancelled order is left alone.
 */
async function returnGiftToSender({ client, nightclubId, flirt }) {
  const senderTable = await seatedAt(flirt.sender_id, client);
  const { rows } = await client.query(
    `UPDATE drink_orders
        SET table_id = COALESCE($3, table_id),
            recipient_id = NULL,
            returned_to_sender = true,
            returned_at = now(),
            message = COALESCE(message, '') || ' — RECHAZADO: devolver a mesa ' || COALESCE($4, '?'),
            updated_at = now()
      WHERE id = $1 AND nightclub_id = $2
        AND status IN ('pending', 'confirmed', 'preparing', 'ready', 'pos_error')
      RETURNING id, status, table_id`,
    [flirt.drink_order_id, nightclubId, senderTable ? senderTable.id : null,
      senderTable ? senderTable.code : null]);
  if (rows.length === 0) return null;

  await events.publish({
    nightclubId, type: 'order_returned', client,
    audience: { roles: ['bartender', 'waiter', 'manager'], userIds: [flirt.sender_id] },
    payload: {
      order_id: rows[0].id, status: rows[0].status,
      return_to_table: senderTable ? senderTable.code : null,
    },
  });
  return rows[0];
}

// ---------------------------------------------------------------- blocks

router.get('/me/blocks', authenticate, asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT b.blocked_id AS user_id, u.display_name, b.created_at
       FROM user_blocks b JOIN users u ON u.id = b.blocked_id
      WHERE b.blocker_id = $1 ORDER BY b.created_at DESC`,
    [req.user.id]);
  res.json({ blocks: rows });
}));

router.post('/me/blocks/:userId', authenticate,
  validate({ params: z.object({ userId: uuid }) }),
  asyncHandler(async (req, res) => {
    const target = req.params.userId;
    if (target === req.user.id) throw ApiError.unprocessable('No puedes bloquearte a ti mismo');
    const u = await pool.query('SELECT id FROM users WHERE id = $1 AND nightclub_id = $2',
      [target, req.user.nightclub_id]);
    if (u.rowCount === 0) throw ApiError.notFound('User not found');

    await pool.query(
      `INSERT INTO user_blocks (blocker_id, blocked_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [req.user.id, target]);
    // Anything still pending from that person is closed; the bar keeps any gift order.
    await pool.query(
      `UPDATE flirts SET status = 'declined'
        WHERE recipient_id = $1 AND sender_id = $2 AND status IN ('sent', 'viewed')`,
      [req.user.id, target]);
    res.status(201).json({ blocked: true, user_id: target });
  }));

router.delete('/me/blocks/:userId', authenticate,
  validate({ params: z.object({ userId: uuid }) }),
  asyncHandler(async (req, res) => {
    await pool.query('DELETE FROM user_blocks WHERE blocker_id = $1 AND blocked_id = $2',
      [req.user.id, req.params.userId]);
    res.status(204).end();
  }));

// ---------------------------------------------------------------- reports

const REPORT_REASONS = ['harassment', 'underage', 'fake_profile', 'other'];

router.post('/nightclubs/:nightclubId/users/:userId/report',
  validate({
    params: z.object({ nightclubId: uuid, userId: uuid }),
    body: z.object({
      reason: z.enum(REPORT_REASONS),
      details: z.string().trim().max(500).optional(),
      flirt_id: uuid.optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { nightclubId, userId } = req.params;
    if (userId === req.user.id) throw ApiError.unprocessable('No puedes reportarte a ti mismo');
    const u = await pool.query('SELECT id FROM users WHERE id = $1 AND nightclub_id = $2',
      [userId, nightclubId]);
    if (u.rowCount === 0) throw ApiError.notFound('User not found');

    if (req.body.flirt_id) {
      // Only a flirt the reporter actually received can be attached as evidence.
      const fl = await pool.query('SELECT 1 FROM flirts WHERE id = $1 AND recipient_id = $2 AND sender_id = $3',
        [req.body.flirt_id, req.user.id, userId]);
      if (fl.rowCount === 0) throw ApiError.notFound('Flirt not found');
    }

    let report;
    try {
      const { rows } = await pool.query(
        `INSERT INTO user_reports (nightclub_id, reporter_id, reported_id, reason, details, flirt_id)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, reason, status, created_at`,
        [nightclubId, req.user.id, userId, req.body.reason, req.body.details || null,
          req.body.flirt_id || null]);
      report = rows[0];
    } catch (err) {
      if (err.code === '23505') throw ApiError.conflict('Ya tienes un reporte abierto sobre esa persona');
      throw err;
    }

    await events.publish({
      nightclubId, type: 'user_reported',
      audience: { roles: ['manager'] },
      payload: { report_id: report.id, reason: report.reason },
    });
    res.status(201).json({ report });
  }));

const REPORT_SELECT = `
  SELECT r.id, r.reason, r.details, r.status, r.resolution_note, r.created_at, r.reviewed_at,
         r.reporter_id, ru.display_name AS reporter_name,
         r.reported_id, du.display_name AS reported_name, du.status AS reported_account_status,
         r.reviewed_by, mu.display_name AS reviewed_by_name,
         r.flirt_id, f.type AS flirt_type, f.created_at AS flirt_sent_at,
         (SELECT count(*)::int FROM user_reports x
           WHERE x.reported_id = r.reported_id AND x.status <> 'dismissed') AS reports_against
    FROM user_reports r
    JOIN users ru ON ru.id = r.reporter_id
    JOIN users du ON du.id = r.reported_id
    LEFT JOIN users mu ON mu.id = r.reviewed_by
    LEFT JOIN flirts f ON f.id = r.flirt_id`;

// The manager sees who, why and when — never the flirt's message.
router.get('/nightclubs/:nightclubId/reports',
  requireRole('manager'),
  validate({
    params: z.object({ nightclubId: uuid }),
    query: pagination.extend({
      status: z.enum(['open', 'reviewed', 'actioned', 'dismissed']).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(
      `${REPORT_SELECT}
        WHERE r.nightclub_id = $1 AND ($2::text IS NULL OR r.status = $2)
        ORDER BY (r.status = 'open') DESC, r.created_at DESC
        LIMIT $3 OFFSET $4`,
      [req.params.nightclubId, req.query.status || null, req.query.limit, req.query.offset]);
    res.json({ reports: rows });
  }));

router.patch('/nightclubs/:nightclubId/reports/:reportId',
  requireRole('manager'),
  validate({
    params: z.object({ nightclubId: uuid, reportId: uuid }),
    body: z.object({
      status: z.enum(['reviewed', 'actioned', 'dismissed']),
      resolution_note: z.string().trim().max(500).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { nightclubId, reportId } = req.params;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const cur = await client.query(
        'SELECT * FROM user_reports WHERE id = $1 AND nightclub_id = $2 FOR UPDATE', [reportId, nightclubId]);
      if (cur.rowCount === 0) throw ApiError.notFound('Report not found');

      await client.query(
        `UPDATE user_reports
            SET status = $2, resolution_note = COALESCE($3, resolution_note),
                reviewed_by = $4, reviewed_at = now()
          WHERE id = $1`,
        [reportId, req.body.status, req.body.resolution_note || null, req.user.id]);

      // "Actioned" blocks the account: the person can no longer sign in or be listed.
      if (req.body.status === 'actioned') {
        await client.query(`UPDATE users SET status = 'blocked', updated_at = now() WHERE id = $1`,
          [cur.rows[0].reported_id]);
        await client.query(`DELETE FROM refresh_tokens WHERE user_id = $1`, [cur.rows[0].reported_id]);
        await client.query(`UPDATE table_occupants SET left_at = now() WHERE user_id = $1 AND left_at IS NULL`,
          [cur.rows[0].reported_id]);
      }
      await client.query('COMMIT');
      const full = await pool.query(`${REPORT_SELECT} WHERE r.id = $1`, [reportId]);
      res.json({ report: full.rows[0] });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }));

// ---------------------------------------------------------------- manager stats

// Counts only. No names, no messages.
router.get('/nightclubs/:nightclubId/flirts/stats',
  requireRole('manager'),
  validate({ params: z.object({ nightclubId: uuid }) }),
  asyncHandler(async (req, res) => {
    const id = req.params.nightclubId;
    const [flirts, gifts, reports, optIn] = await Promise.all([
      pool.query(
        `SELECT count(*)::int AS sent,
                count(*) FILTER (WHERE status = 'accepted')::int AS accepted,
                count(*) FILTER (WHERE status = 'declined')::int AS declined,
                count(*) FILTER (WHERE type = 'emoji')::int AS emoji,
                count(*) FILTER (WHERE type = 'meet')::int AS meet,
                count(DISTINCT sender_id)::int AS senders
           FROM flirts WHERE nightclub_id = $1 AND created_at > now() - make_interval(hours => $2)`,
        [id, LIMITS.nightHours]),
      pool.query(
        `SELECT count(*)::int AS orders,
                count(*) FILTER (WHERE o.returned_to_sender)::int AS returned,
                COALESCE(sum(o.subtotal), 0)::text AS total,
                COALESCE(max(o.currency), 'MXN') AS currency
           FROM flirts f JOIN drink_orders o ON o.id = f.drink_order_id
          WHERE f.nightclub_id = $1 AND f.created_at > now() - make_interval(hours => $2)`,
        [id, LIMITS.nightHours]),
      pool.query(
        `SELECT count(*) FILTER (WHERE status = 'open')::int AS open,
                count(*) FILTER (WHERE created_at > now() - make_interval(hours => $2))::int AS tonight
           FROM user_reports WHERE nightclub_id = $1`,
        [id, LIMITS.nightHours]),
      pool.query(
        `SELECT count(*) FILTER (WHERE p.accept_flirts)::int AS accepting,
                count(*) FILTER (WHERE p.discoverable)::int AS discoverable
           FROM user_preferences p JOIN users u ON u.id = p.user_id
          WHERE u.nightclub_id = $1 AND u.role = 'guest' AND u.status = 'active'`,
        [id]),
    ]);
    res.json({
      window_hours: LIMITS.nightHours,
      flirts: flirts.rows[0],
      gifts: gifts.rows[0],
      reports: reports.rows[0],
      opt_in: optIn.rows[0],
      generated_at: new Date().toISOString(),
    });
  }));

module.exports = router;
module.exports.LIMITS = LIMITS;
module.exports.EMOJI_CATALOGUE = EMOJI_CATALOGUE;
module.exports.seatedAt = seatedAt;
module.exports.assertCanSend = assertCanSend;
module.exports.FLIRT_SELECT = FLIRT_SELECT;
module.exports.ORDER_SELECT = ORDER_SELECT;
module.exports.REPORT_REASONS = REPORT_REASONS;
