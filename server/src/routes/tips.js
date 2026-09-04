// Tips, shifts, staff drinks and song requests (docs/DECISIONES.md D20).
//
//   * a tip writes its row in `tips` and its ledger row in `transactions` in ONE SQL
//     transaction, idempotent by client_request_id; it is born `pending` and only
//     reaches the employee's balance once it is `paid` (card processing is phase 3;
//     until then the manager confirms cash tips);
//   * minimum and suggested amounts per role are the ones the club already used,
//     editable by the manager (tip_presets); the club keeps nothing;
//   * a staff drink is a real order charged to the guest when sent; only roles flagged
//     `accepts_drinks` can receive one; declining hands it back to the guest's table
//     and never refunds;
//   * the tip to the DJ is separate from the song request, the DJ cannot decline a
//     request, and identical songs are merged into one request with votes.
'use strict';

const express = require('express');
const { pool } = require('../db/pool');
const { ApiError, asyncHandler } = require('../middleware/errors');
const { validate, z, uuid, currency, pagination } = require('../middleware/validate');
const { authenticate, requireRole, sameNightclub } = require('../middleware/auth');
const events = require('../services/events');
const { createOrder } = require('../services/orders');

const router = express.Router({ mergeParams: true });

const STAFF_ROLES = ['waiter', 'bartender', 'dancer', 'dj', 'light_tech', 'valet', 'hostess'];

// The amounts the club used before this system (tip-dancer-system.js), kept as the
// starting point. The manager edits them from the app; valet had none and gets the
// waiter amounts.
const DEFAULT_PRESETS = [
  { role: 'waiter', display_name: 'Mesero', icon: '🍽️', color: '#00BFFF', min_tip: 50, suggested: [50, 100, 200, 500], accepts_drinks: false, sort_order: 1 },
  { role: 'bartender', display_name: 'Cantinero', icon: '🍹', color: '#FF8C00', min_tip: 50, suggested: [50, 100, 200, 500], accepts_drinks: false, sort_order: 2 },
  { role: 'dancer', display_name: 'Ambientadora', icon: '💃', color: '#FF1493', min_tip: 100, suggested: [100, 200, 500, 1000], accepts_drinks: true, sort_order: 3 },
  { role: 'dj', display_name: 'DJ', icon: '🎧', color: '#00FF00', min_tip: 100, suggested: [100, 200, 500, 1000], accepts_drinks: false, sort_order: 4 },
  { role: 'light_tech', display_name: 'Técnico de luces', icon: '💡', color: '#FFFF00', min_tip: 75, suggested: [75, 150, 300, 750], accepts_drinks: false, sort_order: 5 },
  { role: 'hostess', display_name: 'Anfitriona', icon: '👩‍💼', color: '#9D00FF', min_tip: 50, suggested: [50, 100, 200, 500], accepts_drinks: false, sort_order: 6 },
  { role: 'valet', display_name: 'Valet', icon: '🚗', color: '#C0C0C0', min_tip: 50, suggested: [50, 100, 200, 500], accepts_drinks: false, sort_order: 7 },
];

/** Presets for a club, seeding the defaults the first time they are needed. */
async function presetsFor(nightclubId, runner = pool) {
  const existing = await runner.query(
    'SELECT role, display_name, icon, color, currency, min_tip, suggested, accepts_drinks, sort_order FROM tip_presets WHERE nightclub_id = $1 ORDER BY sort_order',
    [nightclubId]);
  if (existing.rowCount > 0) return existing.rows;
  for (const p of DEFAULT_PRESETS) {
    await runner.query(
      `INSERT INTO tip_presets (nightclub_id, role, display_name, icon, color, min_tip, suggested, accepts_drinks, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING`,
      [nightclubId, p.role, p.display_name, p.icon, p.color, p.min_tip, JSON.stringify(p.suggested),
        p.accepts_drinks, p.sort_order]);
  }
  return presetsFor(nightclubId, runner);
}

const TIP_SELECT = `
  SELECT t.id, t.amount::text, t.currency, t.message, t.source, t.status, t.anonymous,
         t.created_at, t.paid_at, t.transaction_id, t.song_request_id,
         t.to_user_id,   eu.display_name AS to_name, eu.role AS to_role,
         t.from_user_id, fu.display_name AS from_name
    FROM tips t
    JOIN users eu ON eu.id = t.to_user_id
    LEFT JOIN users fu ON fu.id = t.from_user_id`;

/** What the recipient sees: an anonymous tip hides who sent it. */
function tipForRecipient(row) {
  if (!row.anonymous) return row;
  return { ...row, from_user_id: null, from_name: 'Anónimo' };
}

router.use('/nightclubs/:nightclubId', authenticate, sameNightclub());

// ---------------------------------------------------------------- presets

router.get('/nightclubs/:nightclubId/tip-presets',
  validate({ params: z.object({ nightclubId: uuid }) }),
  asyncHandler(async (req, res) => {
    res.json({ presets: await presetsFor(req.params.nightclubId) });
  }));

router.put('/nightclubs/:nightclubId/tip-presets/:role',
  requireRole('manager'),
  validate({
    params: z.object({ nightclubId: uuid, role: z.enum(STAFF_ROLES) }),
    body: z.object({
      display_name: z.string().trim().min(1).max(40).optional(),
      icon: z.string().trim().max(16).optional(),
      color: z.string().trim().max(9).optional(),
      currency: currency.optional(),
      min_tip: z.number().min(0).optional(),
      suggested: z.array(z.number().positive()).min(1).max(8).optional(),
      accepts_drinks: z.boolean().optional(),
      sort_order: z.number().int().optional(),
    }).refine((b) => Object.keys(b).length > 0, { message: 'No fields to update' }),
  }),
  asyncHandler(async (req, res) => {
    const { nightclubId, role } = req.params;
    await presetsFor(nightclubId);
    const b = req.body;
    if (b.suggested && b.min_tip !== undefined && b.suggested.some((s) => s < b.min_tip)) {
      throw ApiError.unprocessable('Los montos sugeridos no pueden ser menores que el mínimo');
    }
    const { rows } = await pool.query(
      `UPDATE tip_presets SET
         display_name = COALESCE($3, display_name), icon = COALESCE($4, icon), color = COALESCE($5, color),
         currency = COALESCE($6, currency), min_tip = COALESCE($7, min_tip),
         suggested = COALESCE($8::jsonb, suggested), accepts_drinks = COALESCE($9, accepts_drinks),
         sort_order = COALESCE($10, sort_order), updated_at = now()
       WHERE nightclub_id = $1 AND role = $2
       RETURNING role, display_name, icon, color, currency, min_tip, suggested, accepts_drinks, sort_order`,
      [nightclubId, role, b.display_name ?? null, b.icon ?? null, b.color ?? null, b.currency ?? null,
        b.min_tip ?? null, b.suggested ? JSON.stringify(b.suggested) : null, b.accepts_drinks ?? null,
        b.sort_order ?? null]);
    res.json({ preset: rows[0] });
  }));

// ---------------------------------------------------------------- shifts

async function openShift(userId, runner = pool) {
  const { rows } = await runner.query(
    'SELECT id, section, started_at FROM staff_shifts WHERE user_id = $1 AND ended_at IS NULL', [userId]);
  return rows[0] || null;
}

router.post('/nightclubs/:nightclubId/staff/shifts/start',
  requireRole(...STAFF_ROLES),
  validate({
    params: z.object({ nightclubId: uuid }),
    body: z.object({ section: z.string().trim().max(40).optional() }).default({}),
  }),
  asyncHandler(async (req, res) => {
    const current = await openShift(req.user.id);
    if (current) return res.status(200).json({ shift: current, already_open: true });
    const { rows } = await pool.query(
      `INSERT INTO staff_shifts (nightclub_id, user_id, section) VALUES ($1,$2,$3)
       RETURNING id, section, started_at`,
      [req.params.nightclubId, req.user.id, req.body.section || null]);
    await events.publish({
      nightclubId: req.params.nightclubId, type: 'shift_started',
      audience: { roles: ['manager', 'hostess'] },
      payload: { user_id: req.user.id, role: req.user.role, section: req.body.section || null },
    });
    return res.status(201).json({ shift: rows[0] });
  }));

router.post('/nightclubs/:nightclubId/staff/shifts/end',
  requireRole(...STAFF_ROLES),
  validate({ params: z.object({ nightclubId: uuid }) }),
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(
      `UPDATE staff_shifts SET ended_at = now() WHERE user_id = $1 AND ended_at IS NULL
       RETURNING id, section, started_at, ended_at`, [req.user.id]);
    if (rows.length === 0) throw ApiError.conflict('No tienes un turno abierto');
    res.json({ shift: rows[0] });
  }));

// The manager closes forgotten shifts.
router.post('/nightclubs/:nightclubId/staff/:userId/shifts/end',
  requireRole('manager'),
  validate({ params: z.object({ nightclubId: uuid, userId: uuid }) }),
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(
      `UPDATE staff_shifts SET ended_at = now()
        WHERE user_id = $1 AND nightclub_id = $2 AND ended_at IS NULL
       RETURNING id, section, started_at, ended_at`, [req.params.userId, req.params.nightclubId]);
    if (rows.length === 0) throw ApiError.notFound('No hay turno abierto para esa persona');
    res.json({ shift: rows[0] });
  }));

router.get('/nightclubs/:nightclubId/staff/shifts',
  requireRole('manager', 'hostess'),
  validate({
    params: z.object({ nightclubId: uuid }),
    query: pagination.extend({ open: z.coerce.boolean().default(true) }),
  }),
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT s.id, s.user_id, u.display_name, u.role, s.section, s.started_at, s.ended_at
         FROM staff_shifts s JOIN users u ON u.id = s.user_id
        WHERE s.nightclub_id = $1 AND (NOT $2::boolean OR s.ended_at IS NULL)
        ORDER BY s.ended_at NULLS FIRST, s.started_at DESC LIMIT $3 OFFSET $4`,
      [req.params.nightclubId, req.query.open, req.query.limit, req.query.offset]);
    res.json({ shifts: rows });
  }));

/** Who is working right now, with the amounts to suggest. */
router.get('/nightclubs/:nightclubId/staff/on-shift',
  validate({
    params: z.object({ nightclubId: uuid }),
    query: z.object({ role: z.enum(STAFF_ROLES).optional() }),
  }),
  asyncHandler(async (req, res) => {
    const presets = await presetsFor(req.params.nightclubId);
    const byRole = new Map(presets.map((p) => [p.role, p]));
    const { rows } = await pool.query(
      `SELECT u.id, u.role, COALESCE(p.stage_name, u.display_name) AS display_name, p.avatar_url,
              s.section, s.started_at
         FROM staff_shifts s
         JOIN users u ON u.id = s.user_id
         LEFT JOIN employee_profiles p ON p.user_id = u.id
        WHERE s.nightclub_id = $1 AND s.ended_at IS NULL AND u.status = 'active'
          AND ($2::text IS NULL OR u.role = $2)
        ORDER BY u.role, display_name`,
      [req.params.nightclubId, req.query.role || null]);
    res.json({
      staff: rows.map((r) => {
        const p = byRole.get(r.role) || {};
        return {
          ...r,
          role_label: p.display_name || r.role,
          icon: p.icon || null,
          min_tip: p.min_tip ?? '0.00',
          suggested: p.suggested || [],
          currency: p.currency || 'MXN',
          accepts_drinks: !!p.accepts_drinks,
        };
      }),
    });
  }));

// ---------------------------------------------------------------- tips

/**
 * Records a tip: row in `tips` + row in `transactions`, same SQL transaction.
 * Returns the tip id. Used by POST /tips and by song requests.
 */
async function recordTip({ client, nightclubId, from, toUserId, amount, cur, message, anonymous, clientRequestId, type = 'tip', songRequestId = null }) {
  const tx = await client.query(
    `INSERT INTO transactions (nightclub_id, type, direction, amount, currency, status,
                               payer_user_id, payee_user_id, provider, reference_type, client_request_id, metadata)
     VALUES ($1,$2,'in',$3,$4,'pending',$5,$6,'manual','tip',$7,$8) RETURNING id`,
    [nightclubId, type, amount, cur, from.id, toUserId, clientRequestId,
      JSON.stringify({ anonymous: !!anonymous, song_request_id: songRequestId })]);
  const tip = await client.query(
    `INSERT INTO tips (nightclub_id, from_user_id, to_user_id, amount, currency, message, source,
                       transaction_id, client_request_id, anonymous, status, song_request_id)
     VALUES ($1,$2,$3,$4,$5,$6,'app',$7,$8,$9,'pending',$10) RETURNING id`,
    [nightclubId, from.id, toUserId, amount, cur, message || null, tx.rows[0].id, clientRequestId,
      !!anonymous, songRequestId]);
  await client.query(`UPDATE transactions SET reference_id = $2 WHERE id = $1`, [tx.rows[0].id, tip.rows[0].id]);
  await events.publish({
    nightclubId, type: type === 'tip' ? 'tip_received' : 'song_tip_received', client,
    audience: { userIds: [toUserId] },
    payload: { tip_id: tip.rows[0].id, amount, currency: cur, anonymous: !!anonymous,
      from_name: anonymous ? null : from.display_name },
  });
  return tip.rows[0].id;
}

/** The employee must exist in this club, be active, hold a staff role; returns the row. */
async function tippableStaff(nightclubId, userId, runner = pool) {
  const { rows } = await runner.query(
    `SELECT u.id, u.role, u.display_name FROM users u
      WHERE u.id = $1 AND u.nightclub_id = $2 AND u.status = 'active' AND u.role = ANY($3::text[])`,
    [userId, nightclubId, STAFF_ROLES]);
  if (rows.length === 0) throw ApiError.notFound('Staff member not found');
  return rows[0];
}

router.post('/nightclubs/:nightclubId/tips',
  validate({
    params: z.object({ nightclubId: uuid }),
    body: z.object({
      client_request_id: uuid,
      to_user_id: uuid,
      amount: z.number().positive().max(100_000),
      currency: currency.default('MXN'),
      message: z.string().trim().max(280).optional(),
      anonymous: z.boolean().default(false),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { nightclubId } = req.params;
    const b = req.body;
    if (b.to_user_id === req.user.id) throw ApiError.unprocessable('No puedes darte propina a ti mismo');

    const dup = await pool.query(`${TIP_SELECT} WHERE t.client_request_id = $1`, [b.client_request_id]);
    if (dup.rowCount > 0) {
      res.set('Idempotent-Replay', 'true');
      return res.status(200).json({ tip: dup.rows[0] });
    }

    const staff = await tippableStaff(nightclubId, b.to_user_id);
    const preset = (await presetsFor(nightclubId)).find((p) => p.role === staff.role);
    const amount = Number(b.amount.toFixed(2));
    if (preset && amount < Number(preset.min_tip)) {
      throw ApiError.unprocessable(`La propina mínima para ${preset.display_name} es $${Number(preset.min_tip).toFixed(2)} ${preset.currency}`,
        { min_tip: Number(preset.min_tip), currency: preset.currency });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      let tipId;
      try {
        tipId = await recordTip({
          client, nightclubId, from: req.user, toUserId: b.to_user_id, amount, cur: b.currency,
          message: b.message, anonymous: b.anonymous, clientRequestId: b.client_request_id,
        });
      } catch (err) {
        if (err.code === '23505') {
          await client.query('ROLLBACK');
          const again = await pool.query(`${TIP_SELECT} WHERE t.client_request_id = $1`, [b.client_request_id]);
          res.set('Idempotent-Replay', 'true');
          return res.status(200).json({ tip: again.rows[0] });
        }
        throw err;
      }
      await client.query('COMMIT');
      const full = await pool.query(`${TIP_SELECT} WHERE t.id = $1`, [tipId]);
      return res.status(201).json({
        tip: full.rows[0],
        payment: { status: 'pending', note: 'El cobro con tarjeta se conecta en la fase 3; el gerente puede confirmar propinas en efectivo.' },
      });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }));

router.get('/nightclubs/:nightclubId/tips/mine',
  validate({ params: z.object({ nightclubId: uuid }), query: pagination }),
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(
      `${TIP_SELECT} WHERE t.from_user_id = $1 ORDER BY t.created_at DESC LIMIT $2 OFFSET $3`,
      [req.user.id, req.query.limit, req.query.offset]);
    res.json({ tips: rows });
  }));

router.get('/nightclubs/:nightclubId/staff/me/tips',
  requireRole(...STAFF_ROLES),
  validate({
    params: z.object({ nightclubId: uuid }),
    query: pagination.extend({ status: z.enum(['pending', 'paid', 'cancelled']).optional() }),
  }),
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(
      `${TIP_SELECT} WHERE t.to_user_id = $1 AND ($2::text IS NULL OR t.status = $2)
        ORDER BY t.created_at DESC LIMIT $3 OFFSET $4`,
      [req.user.id, req.query.status || null, req.query.limit, req.query.offset]);
    res.json({ tips: rows.map(tipForRecipient) });
  }));

// Manager view: sees who tipped even when anonymous (for disputes). Cancelled tips are kept.
router.get('/nightclubs/:nightclubId/tips',
  requireRole('manager'),
  validate({
    params: z.object({ nightclubId: uuid }),
    query: pagination.extend({
      status: z.enum(['pending', 'paid', 'cancelled']).optional(),
      to_user_id: uuid.optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(
      `${TIP_SELECT} WHERE t.nightclub_id = $1
          AND ($2::text IS NULL OR t.status = $2) AND ($3::uuid IS NULL OR t.to_user_id = $3)
        ORDER BY t.created_at DESC LIMIT $4 OFFSET $5`,
      [req.params.nightclubId, req.query.status || null, req.query.to_user_id || null,
        req.query.limit, req.query.offset]);
    res.json({ tips: rows });
  }));

/**
 * Until card payments exist (phase 3), the manager confirms a tip was paid (cash, or a
 * transfer seen by the manager). This is what moves it into the employee's balance.
 */
router.post('/nightclubs/:nightclubId/tips/:tipId/confirm',
  requireRole('manager'),
  validate({
    params: z.object({ nightclubId: uuid, tipId: uuid }),
    body: z.object({
      provider: z.enum(['cash', 'manual']).default('cash'),
      reference: z.string().trim().max(120).optional(),
    }).default({}),
  }),
  asyncHandler(async (req, res) => {
    const { nightclubId, tipId } = req.params;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const cur = await client.query(
        'SELECT * FROM tips WHERE id = $1 AND nightclub_id = $2 FOR UPDATE', [tipId, nightclubId]);
      if (cur.rowCount === 0) throw ApiError.notFound('Tip not found');
      const tip = cur.rows[0];
      if (tip.status !== 'pending') throw ApiError.conflict(`La propina ya está '${tip.status}'`);

      await client.query(
        `UPDATE transactions SET status = 'paid', provider = $2, provider_ref = $3,
                confirmed_by = $4, confirmed_at = now(), updated_at = now()
          WHERE id = $1`,
        [tip.transaction_id, req.body.provider, req.body.reference || null, req.user.id]);
      await client.query(`UPDATE tips SET status = 'paid', paid_at = now() WHERE id = $1`, [tipId]);
      await events.publish({
        nightclubId, type: 'tip_paid', client, audience: { userIds: [tip.to_user_id] },
        payload: { tip_id: tipId, amount: tip.amount, currency: tip.currency },
      });
      await client.query('COMMIT');
      const full = await pool.query(`${TIP_SELECT} WHERE t.id = $1`, [tipId]);
      res.json({ tip: full.rows[0] });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }));

router.post('/nightclubs/:nightclubId/tips/:tipId/cancel',
  requireRole('manager'),
  validate({
    params: z.object({ nightclubId: uuid, tipId: uuid }),
    body: z.object({ reason: z.string().trim().min(1).max(300) }),
  }),
  asyncHandler(async (req, res) => {
    const { nightclubId, tipId } = req.params;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const cur = await client.query(
        'SELECT * FROM tips WHERE id = $1 AND nightclub_id = $2 FOR UPDATE', [tipId, nightclubId]);
      if (cur.rowCount === 0) throw ApiError.notFound('Tip not found');
      const tip = cur.rows[0];
      // A paid tip is money already in the ledger; it is never cancelled here.
      if (tip.status !== 'pending') throw ApiError.conflict(`La propina ya está '${tip.status}'`);
      await client.query(
        `UPDATE transactions SET status = 'cancelled', metadata = metadata || $2::jsonb, updated_at = now() WHERE id = $1`,
        [tip.transaction_id, JSON.stringify({ cancel_reason: req.body.reason, cancelled_by: req.user.id })]);
      await client.query(`UPDATE tips SET status = 'cancelled' WHERE id = $1`, [tipId]);
      await client.query('COMMIT');
      const full = await pool.query(`${TIP_SELECT} WHERE t.id = $1`, [tipId]);
      res.json({ tip: full.rows[0] });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }));

// ---------------------------------------------------------------- staff drinks

async function seatedTable(userId, runner = pool) {
  const { rows } = await runner.query(
    `SELECT t.id, t.code FROM table_occupants o JOIN tables t ON t.id = o.table_id
      WHERE o.user_id = $1 AND o.left_at IS NULL`, [userId]);
  return rows[0] || null;
}

const STAFF_DRINK_SELECT = `
  SELECT sd.id, sd.status, sd.message, sd.created_at, sd.confirmed_at, sd.declined_at,
         sd.returned_to_sender, sd.drink_order_id, sd.drink_id, d.name AS drink_name,
         o.subtotal::text AS amount, o.currency, o.status AS order_status,
         sd.to_user_id,   su.display_name AS to_name, su.role AS to_role,
         sd.from_user_id, fu.display_name AS from_name,
         sd.from_table_id, ft.code AS from_table_code
    FROM staff_drinks sd
    JOIN drinks d ON d.id = sd.drink_id
    LEFT JOIN drink_orders o ON o.id = sd.drink_order_id
    JOIN users su ON su.id = sd.to_user_id
    JOIN users fu ON fu.id = sd.from_user_id
    LEFT JOIN tables ft ON ft.id = sd.from_table_id`;

/**
 * Invite a drink to a staff member: a real order charged to the guest when sent (D20).
 * Only roles flagged accepts_drinks, and only while on shift.
 */
router.post('/nightclubs/:nightclubId/staff/:userId/drinks',
  validate({
    params: z.object({ nightclubId: uuid, userId: uuid }),
    body: z.object({
      client_request_id: uuid,
      drink_id: uuid,
      quantity: z.number().int().min(1).max(5).default(1),
      message: z.string().trim().max(140).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { nightclubId, userId } = req.params;
    const b = req.body;

    const dup = await pool.query(`${STAFF_DRINK_SELECT} WHERE sd.client_request_id = $1`, [b.client_request_id]);
    if (dup.rowCount > 0) {
      res.set('Idempotent-Replay', 'true');
      return res.status(200).json({ staff_drink: dup.rows[0] });
    }

    const staff = await tippableStaff(nightclubId, userId);
    const preset = (await presetsFor(nightclubId)).find((p) => p.role === staff.role);
    if (!preset || !preset.accepts_drinks) {
      throw ApiError.unprocessable(`A ${preset ? preset.display_name : staff.role} no se le pueden invitar tragos`);
    }
    if (!(await openShift(userId))) throw ApiError.unprocessable('Esa persona no está en turno ahora');
    const table = await seatedTable(req.user.id);
    if (!table) throw ApiError.unprocessable('Siéntate en una mesa para invitar un trago');

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const order = await createOrder({
        client, nightclubId, senderId: req.user.id, recipientId: userId, tableId: table.id,
        clientRequestId: b.client_request_id,
        message: `Para ${staff.display_name} (${preset.display_name}) de ${req.user.display_name}, mesa ${table.code}`,
        items: [{ drink_id: b.drink_id, quantity: b.quantity }],
      });
      await client.query(
        `INSERT INTO transactions (nightclub_id, type, direction, amount, currency, status,
                                   payer_user_id, provider, reference_type, reference_id, metadata)
         VALUES ($1,'drink_order','in',$2,$3,'pending',$4,'manual','drink_order',$5,$6)`,
        [nightclubId, order.subtotal, order.currency, req.user.id, order.id,
          JSON.stringify({ staff_drink: true, to_user_id: userId, non_refundable: true })]);
      const sd = await client.query(
        `INSERT INTO staff_drinks (nightclub_id, from_user_id, to_user_id, drink_id, drink_order_id,
                                   client_request_id, message, from_table_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [nightclubId, req.user.id, userId, b.drink_id, order.id, b.client_request_id,
          b.message || null, table.id]);
      await events.publish({
        nightclubId, type: 'staff_drink_received', client, audience: { userIds: [userId] },
        payload: { staff_drink_id: sd.rows[0].id, from_name: req.user.display_name, from_table: table.code },
      });
      await events.publish({
        nightclubId, type: 'order_created', client,
        audience: { roles: ['bartender', 'manager'], userIds: [req.user.id, userId] },
        payload: { order_id: order.id, table_id: table.id, staff_drink: true,
          subtotal: order.subtotal, currency: order.currency },
      });
      await client.query('COMMIT');
      const full = await pool.query(`${STAFF_DRINK_SELECT} WHERE sd.id = $1`, [sd.rows[0].id]);
      return res.status(201).json({ staff_drink: full.rows[0] });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }));

router.get('/nightclubs/:nightclubId/staff/me/drinks',
  requireRole(...STAFF_ROLES),
  validate({ params: z.object({ nightclubId: uuid }), query: pagination }),
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(
      `${STAFF_DRINK_SELECT} WHERE sd.to_user_id = $1 ORDER BY sd.created_at DESC LIMIT $2 OFFSET $3`,
      [req.user.id, req.query.limit, req.query.offset]);
    res.json({ staff_drinks: rows });
  }));

async function ownStaffDrink(client, id, userId) {
  const { rows } = await client.query('SELECT * FROM staff_drinks WHERE id = $1 FOR UPDATE', [id]);
  if (rows.length === 0 || rows[0].to_user_id !== userId) throw ApiError.notFound('Staff drink not found');
  if (rows[0].status !== 'pending') throw ApiError.conflict(`Ya está '${rows[0].status}'`);
  return rows[0];
}

router.post('/nightclubs/:nightclubId/staff-drinks/:id/accept',
  requireRole(...STAFF_ROLES),
  validate({ params: z.object({ nightclubId: uuid, id: uuid }) }),
  asyncHandler(async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const sd = await ownStaffDrink(client, req.params.id, req.user.id);
      await client.query(`UPDATE staff_drinks SET status = 'confirmed', confirmed_at = now() WHERE id = $1`, [sd.id]);
      await events.publish({
        nightclubId: req.params.nightclubId, type: 'staff_drink_accepted', client,
        audience: { userIds: [sd.from_user_id] }, payload: { staff_drink_id: sd.id },
      });
      await client.query('COMMIT');
      const full = await pool.query(`${STAFF_DRINK_SELECT} WHERE sd.id = $1`, [sd.id]);
      res.json({ staff_drink: full.rows[0] });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }));

// Declining hands the order back to the guest's table. Never cancelled, never refunded.
router.post('/nightclubs/:nightclubId/staff-drinks/:id/decline',
  requireRole(...STAFF_ROLES),
  validate({ params: z.object({ nightclubId: uuid, id: uuid }) }),
  asyncHandler(async (req, res) => {
    const { nightclubId } = req.params;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const sd = await ownStaffDrink(client, req.params.id, req.user.id);
      const returned = await client.query(
        `UPDATE drink_orders
            SET recipient_id = NULL, returned_to_sender = true, returned_at = now(),
                message = COALESCE(message, '') || ' — RECHAZADO por el personal: entregar en mesa ' || COALESCE($3, '?'),
                updated_at = now()
          WHERE id = $1 AND nightclub_id = $2
            AND status IN ('pending', 'confirmed', 'preparing', 'ready', 'pos_error')
          RETURNING id`,
        [sd.drink_order_id, nightclubId,
          (await client.query('SELECT code FROM tables WHERE id = $1', [sd.from_table_id])).rows[0]?.code || null]);
      await client.query(
        `UPDATE staff_drinks SET status = 'declined', declined_at = now(), returned_to_sender = $2 WHERE id = $1`,
        [sd.id, returned.rowCount > 0]);
      await events.publish({
        nightclubId, type: 'order_returned', client,
        audience: { roles: ['bartender', 'waiter', 'manager'], userIds: [sd.from_user_id] },
        payload: { order_id: sd.drink_order_id, staff_drink_id: sd.id, returned: returned.rowCount > 0 },
      });
      await client.query('COMMIT');
      const full = await pool.query(`${STAFF_DRINK_SELECT} WHERE sd.id = $1`, [sd.id]);
      res.json({ staff_drink: full.rows[0] });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }));

// ---------------------------------------------------------------- song requests

/** "La Chona" / "la chona!!" / "LA  CHONA" are the same song. */
function normalizeSong(title, artist) {
  const norm = (v) => String(v || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return `${norm(title)}|${norm(artist)}`;
}

const SONG_SELECT = `
  SELECT s.id, s.song_title, s.artist, s.status, s.votes, s.created_at, s.last_voted_at, s.played_at,
         s.dj_user_id, du.display_name AS dj_name,
         COALESCE(tp.total, 0)::numeric(12,2)::text AS tips_total,
         COALESCE(tp.count, 0)::int AS tips_count,
         COALESCE(v.requesters, '[]'::json) AS requesters
    FROM song_requests s
    JOIN users du ON du.id = s.dj_user_id
    LEFT JOIN LATERAL (
      SELECT sum(t.amount) AS total, count(*) AS count FROM tips t
       WHERE t.song_request_id = s.id AND t.status <> 'cancelled') tp ON true
    LEFT JOIN LATERAL (
      SELECT json_agg(json_build_object('user_id', sv.user_id, 'name', u.display_name,
                                        'message', sv.message, 'at', sv.created_at) ORDER BY sv.created_at) AS requesters
        FROM song_request_votes sv JOIN users u ON u.id = sv.user_id WHERE sv.song_request_id = s.id) v ON true`;

async function djOnShift(nightclubId, djUserId, runner = pool) {
  const { rows } = await runner.query(
    `SELECT u.id, u.display_name FROM staff_shifts s JOIN users u ON u.id = s.user_id
      WHERE s.nightclub_id = $1 AND s.ended_at IS NULL AND u.role = 'dj' AND u.status = 'active'
        AND ($2::uuid IS NULL OR u.id = $2)
      ORDER BY s.started_at DESC LIMIT 1`,
    [nightclubId, djUserId || null]);
  return rows[0] || null;
}

router.post('/nightclubs/:nightclubId/song-requests',
  validate({
    params: z.object({ nightclubId: uuid }),
    body: z.object({
      client_request_id: uuid,
      dj_user_id: uuid.optional(),
      song_title: z.string().trim().min(1).max(200),
      artist: z.string().trim().max(200).optional(),
      message: z.string().trim().max(280).optional(),
      tip_amount: z.number().min(0).max(100_000).default(0),
      currency: currency.default('MXN'),
      anonymous_tip: z.boolean().default(false),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { nightclubId } = req.params;
    const b = req.body;

    const dup = await pool.query(
      `${SONG_SELECT} WHERE s.id = (SELECT song_request_id FROM song_request_votes WHERE client_request_id = $1)`,
      [b.client_request_id]);
    if (dup.rowCount > 0) {
      res.set('Idempotent-Replay', 'true');
      return res.status(200).json({ song_request: dup.rows[0], merged: null });
    }

    const dj = await djOnShift(nightclubId, b.dj_user_id);
    if (!dj) throw ApiError.unprocessable('No hay DJ en turno en este momento');

    const tipAmount = Number(b.tip_amount.toFixed(2));
    if (tipAmount > 0) {
      const preset = (await presetsFor(nightclubId)).find((p) => p.role === 'dj');
      if (preset && tipAmount < Number(preset.min_tip)) {
        throw ApiError.unprocessable(`La propina mínima para el DJ es $${Number(preset.min_tip).toFixed(2)}`,
          { min_tip: Number(preset.min_tip) });
      }
    }

    const key = normalizeSong(b.song_title, b.artist);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // One row per song per DJ per night: serialize on the key.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`song:${dj.id}:${key}`]);

      const open = await client.query(
        `SELECT id FROM song_requests
          WHERE dj_user_id = $1 AND normalized_key = $2 AND status = 'requested'
            AND created_at > now() - interval '12 hours'`,
        [dj.id, key]);

      let requestId; let merged = false;
      if (open.rowCount > 0) {
        requestId = open.rows[0].id;
        merged = true;
        const vote = await client.query(
          `INSERT INTO song_request_votes (song_request_id, user_id, message, client_request_id)
           VALUES ($1,$2,$3,$4) ON CONFLICT (song_request_id, user_id) DO NOTHING RETURNING user_id`,
          [requestId, req.user.id, b.message || null, b.client_request_id]);
        if (vote.rowCount === 0) throw ApiError.conflict('Ya pediste esa canción esta noche');
        await client.query(
          `UPDATE song_requests SET votes = votes + 1, last_voted_at = now() WHERE id = $1`, [requestId]);
      } else {
        const created = await client.query(
          `INSERT INTO song_requests (nightclub_id, from_user_id, dj_user_id, song_title, artist, message,
                                      tip_amount, currency, normalized_key)
           VALUES ($1,$2,$3,$4,$5,$6,0,$7,$8) RETURNING id`,
          [nightclubId, req.user.id, dj.id, b.song_title, b.artist || null, b.message || null, b.currency, key]);
        requestId = created.rows[0].id;
        await client.query(
          `INSERT INTO song_request_votes (song_request_id, user_id, message, client_request_id) VALUES ($1,$2,$3,$4)`,
          [requestId, req.user.id, b.message || null, b.client_request_id]);
      }

      if (tipAmount > 0) {
        await recordTip({
          client, nightclubId, from: req.user, toUserId: dj.id, amount: tipAmount, cur: b.currency,
          message: b.message, anonymous: b.anonymous_tip, clientRequestId: b.client_request_id,
          type: 'song_request', songRequestId: requestId,
        });
        await client.query(
          `UPDATE song_requests SET tip_amount = tip_amount + $2 WHERE id = $1`, [requestId, tipAmount]);
      }

      await events.publish({
        nightclubId, type: merged ? 'song_request_voted' : 'song_requested', client,
        audience: { userIds: [dj.id] },
        payload: { song_request_id: requestId, title: b.song_title, artist: b.artist || null, tip: tipAmount },
      });
      await client.query('COMMIT');
      const full = await pool.query(`${SONG_SELECT} WHERE s.id = $1`, [requestId]);
      return res.status(merged ? 200 : 201).json({ song_request: full.rows[0], merged });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }));

// Tonight's open queue, most requested first. Guests see it so they vote instead of duplicating.
router.get('/nightclubs/:nightclubId/song-requests',
  validate({
    params: z.object({ nightclubId: uuid }),
    query: pagination.extend({ status: z.enum(['requested', 'played']).default('requested') }),
  }),
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(
      `${SONG_SELECT}
        WHERE s.nightclub_id = $1 AND s.status = $2 AND s.created_at > now() - interval '12 hours'
        ORDER BY s.votes DESC, tips_total DESC, s.created_at
        LIMIT $3 OFFSET $4`,
      [req.params.nightclubId, req.query.status, req.query.limit, req.query.offset]);
    const isStaff = req.user.role !== 'guest';
    res.json({
      song_requests: rows.map((r) => (isStaff ? r : {
        ...r, tips_total: undefined, tips_count: undefined,
        requesters: r.requesters.map((q) => ({ name: q.name, message: q.message })),
        i_voted: r.requesters.some((q) => q.user_id === req.user.id),
      })),
    });
  }));

router.get('/nightclubs/:nightclubId/song-requests/mine',
  validate({ params: z.object({ nightclubId: uuid }), query: pagination }),
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(
      `${SONG_SELECT}
        WHERE EXISTS (SELECT 1 FROM song_request_votes v WHERE v.song_request_id = s.id AND v.user_id = $1)
        ORDER BY s.created_at DESC LIMIT $2 OFFSET $3`,
      [req.user.id, req.query.limit, req.query.offset]);
    res.json({ song_requests: rows });
  }));

router.get('/nightclubs/:nightclubId/dj/song-requests',
  requireRole('dj', 'manager'),
  validate({
    params: z.object({ nightclubId: uuid }),
    query: pagination.extend({ status: z.enum(['requested', 'played']).default('requested') }),
  }),
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(
      `${SONG_SELECT}
        WHERE s.nightclub_id = $1 AND ($2::uuid IS NULL OR s.dj_user_id = $2) AND s.status = $3
          AND s.created_at > now() - interval '12 hours'
        ORDER BY s.votes DESC, tips_total DESC, s.created_at
        LIMIT $4 OFFSET $5`,
      [req.params.nightclubId, req.user.role === 'dj' ? req.user.id : null, req.query.status,
        req.query.limit, req.query.offset]);
    res.json({ song_requests: rows });
  }));

// The DJ marks a song as played; requests are never declined (D20).
router.post('/nightclubs/:nightclubId/song-requests/:id/play',
  requireRole('dj'),
  validate({ params: z.object({ nightclubId: uuid, id: uuid }) }),
  asyncHandler(async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const cur = await client.query('SELECT * FROM song_requests WHERE id = $1 FOR UPDATE', [req.params.id]);
      const s = cur.rows[0];
      if (!s || s.dj_user_id !== req.user.id) throw ApiError.notFound('Song request not found');
      if (s.status !== 'requested') throw ApiError.conflict(`Ya está '${s.status}'`);
      await client.query(`UPDATE song_requests SET status = 'played', played_at = now() WHERE id = $1`, [s.id]);
      const voters = await client.query('SELECT user_id FROM song_request_votes WHERE song_request_id = $1', [s.id]);
      await events.publish({
        nightclubId: req.params.nightclubId, type: 'song_played', client,
        audience: { userIds: voters.rows.map((v) => v.user_id) },
        payload: { song_request_id: s.id, title: s.song_title, artist: s.artist },
      });
      await client.query('COMMIT');
      const full = await pool.query(`${SONG_SELECT} WHERE s.id = $1`, [s.id]);
      res.json({ song_request: full.rows[0] });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }));

// ---------------------------------------------------------------- leaderboard

router.get('/nightclubs/:nightclubId/leaderboard',
  validate({
    params: z.object({ nightclubId: uuid }),
    query: z.object({
      period: z.enum(['night', 'month']).default('night'),
      role: z.enum(STAFF_ROLES).optional(),
      limit: z.coerce.number().int().min(1).max(50).default(10),
    }),
  }),
  asyncHandler(async (req, res) => {
    const since = req.query.period === 'night' ? "now() - interval '12 hours'" : "date_trunc('month', now())";
    const { rows } = await pool.query(
      `SELECT u.id AS user_id, COALESCE(p.stage_name, u.display_name) AS display_name, u.role,
              count(t.id)::int AS tips_count,
              COALESCE(sum(t.amount) FILTER (WHERE t.currency = 'MXN'), 0)::numeric(12,2)::text AS total_mxn,
              COALESCE(sum(t.amount) FILTER (WHERE t.currency = 'USD'), 0)::numeric(12,2)::text AS total_usd,
              count(DISTINCT t.from_user_id)::int AS fans
         FROM tips t
         JOIN users u ON u.id = t.to_user_id
         LEFT JOIN employee_profiles p ON p.user_id = u.id
        WHERE t.nightclub_id = $1 AND t.status = 'paid' AND t.created_at > ${since}
          AND ($2::text IS NULL OR u.role = $2)
        GROUP BY u.id, p.stage_name, u.display_name, u.role
        ORDER BY sum(t.amount) DESC, tips_count DESC
        LIMIT $3`,
      [req.params.nightclubId, req.query.role || null, req.query.limit]);
    const isStaff = req.user.role !== 'guest';
    res.json({
      period: req.query.period,
      leaderboard: rows.map((r, i) => (isStaff
        ? { rank: i + 1, ...r }
        : { rank: i + 1, user_id: r.user_id, display_name: r.display_name, role: r.role, fans: r.fans })),
    });
  }));

module.exports = router;
module.exports.STAFF_ROLES = STAFF_ROLES;
module.exports.DEFAULT_PRESETS = DEFAULT_PRESETS;
module.exports.presetsFor = presetsFor;
module.exports.recordTip = recordTip;
module.exports.tippableStaff = tippableStaff;
module.exports.openShift = openShift;
module.exports.TIP_SELECT = TIP_SELECT;
module.exports.normalizeSong = normalizeSong;
