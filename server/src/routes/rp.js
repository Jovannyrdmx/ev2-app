// El RP: su codigo, sus invitados de la noche y su comision (D98).
//
// Montado desde `employees.js` porque el RP es un puesto de empleado: entra con PIN,
// su comision liquidada llega a su saldo y la retira con el mismo flujo de retiros.
'use strict';

const express = require('express');
const { pool } = require('../db/pool');
const { ApiError, asyncHandler } = require('../middleware/errors');
const { validate, z, uuid } = require('../middleware/validate');
const { authenticate, requireRole, sameNightclub } = require('../middleware/auth');
const rp = require('../services/rp');

const router = express.Router({ mergeParams: true });

const guard = [authenticate, sameNightclub()];
const DOOR_ROLES = ['hostess', 'manager', 'admin'];
const MANAGE_ROLES = ['manager', 'admin'];
const params = z.object({ nightclubId: uuid });

const REASONS = {
  unknown_code: 'Ese código de RP no existe o el RP está inactivo',
  no_reservation: 'Reservación no encontrada',
  no_event: 'No hay una noche abierta para ligar al RP',
  reservation_closed: 'La reservación está cancelada o no llegó',
  has_other_rp: 'Esa mesa ya tiene otro RP. Solo el gerente puede cambiarlo.',
};
const present = (out) => ({
  ok: out.ok,
  reason: out.ok ? null : out.reason,
  message: out.ok ? null : (REASONS[out.reason] || null),
  rp: out.rp ? { display_name: out.rp.display_name, code: out.rp.code } : null,
});

async function pickEvent(runner, { nightclubId, eventId }) {
  if (eventId) return eventId;
  const now = await rp.currentEventId(runner, { nightclubId });
  if (now) return now;
  const { rows } = await runner.query(
    `SELECT a.event_id FROM rp_attributions a JOIN events_calendar e ON e.id = a.event_id
      WHERE a.nightclub_id = $1 ORDER BY e.doors_open_at DESC LIMIT 1`, [nightclubId]);
  return rows[0] ? rows[0].event_id : null;
}

const eventQuery = z.object({ event_id: uuid.optional() });

// ---------------------------------------------------------------- el RP: lo suyo

router.get('/nightclubs/:nightclubId/rp/me', ...guard,
  validate({ params, query: eventQuery }),
  asyncHandler(async (req, res) => {
    const { nightclubId } = req.params;
    // El puesto RP nace con su codigo; cualquier otro empleado lo tiene solo si el
    // gerente se lo dio (D120). Sin perfil no hay nada que ver.
    if (req.user.role === rp.ROLE) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await rp.ensureProfile(client, { nightclubId, userId: req.user.id });
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    }
    const profile = await rp.profileOf(pool, { userId: req.user.id });
    if (!profile) throw ApiError.notFound('No tienes código de RP');
    const eventId = req.query.event_id
      || await rp.currentEventId(pool, { nightclubId })
      || await rp.latestEventFor(pool, { nightclubId, rpUserId: req.user.id });
    const night = eventId
      ? await rp.nightReport(pool, { nightclubId, eventId, rpUserId: req.user.id })
      : null;
    res.json({ profile, night });
  }));

router.get('/nightclubs/:nightclubId/rp/me/nights', ...guard,
  validate({ params }),
  asyncHandler(async (req, res) => {
    const { nightclubId } = req.params;
    if (!(await rp.profileOf(pool, { userId: req.user.id }))) {
      throw ApiError.notFound('No tienes código de RP');
    }
    const { rows } = await pool.query(
      `SELECT DISTINCT e.id, e.name, e.event_date, e.doors_open_at
         FROM rp_attributions a JOIN events_calendar e ON e.id = a.event_id
        WHERE a.nightclub_id = $1 AND a.rp_user_id = $2
        ORDER BY e.doors_open_at DESC LIMIT 30`, [nightclubId, req.user.id]);
    const nights = [];
    for (const e of rows) {
      const r = await rp.nightReport(pool, { nightclubId, eventId: e.id, rpUserId: req.user.id });
      nights.push({ event: e, totals: r.totals, settlements: r.settlements });
    }
    res.json({ nights });
  }));

// ---------------------------------------------------------------- la puerta

// Confirma un codigo antes de guardarlo: la anfitriona ve el nombre del RP.
router.get('/nightclubs/:nightclubId/rp/lookup', ...guard, requireRole(...DOOR_ROLES),
  validate({ params, query: z.object({ code: z.string().trim().min(1).max(20) }) }),
  asyncHandler(async (req, res) => {
    const found = await rp.findByCode(pool, { nightclubId: req.params.nightclubId, code: req.query.code });
    res.json({ rp: found ? { display_name: found.display_name, code: found.code } : null });
  }));

router.post('/nightclubs/:nightclubId/reservations/:reservationId/rp', ...guard,
  requireRole(...DOOR_ROLES),
  validate({
    params: z.object({ nightclubId: uuid, reservationId: uuid }),
    body: z.object({ code: z.string().trim().min(1).max(20) }),
  }),
  asyncHandler(async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const out = await rp.attachToReservation(client, {
        nightclubId: req.params.nightclubId, reservationId: req.params.reservationId,
        code: req.body.code, actorId: req.user.id,
      });
      await client.query('COMMIT');
      res.json(present(out));
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }));

// ---------------------------------------------------------------- el gerente

router.put('/nightclubs/:nightclubId/reservations/:reservationId/rp', ...guard,
  requireRole(...MANAGE_ROLES),
  validate({
    params: z.object({ nightclubId: uuid, reservationId: uuid }),
    body: z.object({
      code: z.string().trim().min(1).max(20).nullable(),
      reason: z.string().trim().min(3).max(200),
    }),
  }),
  asyncHandler(async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const out = await rp.reassignReservation(client, {
        nightclubId: req.params.nightclubId, reservationId: req.params.reservationId,
        code: req.body.code, actorId: req.user.id, reason: req.body.reason,
      });
      await client.query('COMMIT');
      res.json({ ok: true, removed: Boolean(out.removed),
        rp: out.rp ? { display_name: out.rp.display_name, code: out.rp.code } : null });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }));

router.get('/nightclubs/:nightclubId/rps', ...guard, requireRole(...MANAGE_ROLES),
  validate({ params }),
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT u.id AS user_id, u.display_name, u.role, u.status, p.code,
              p.commission_pct::text AS commission_pct, p.active
         FROM users u LEFT JOIN rp_profiles p ON p.user_id = u.id
        WHERE u.nightclub_id = $1 AND (u.role = 'rp' OR p.user_id IS NOT NULL)
        ORDER BY u.display_name`, [req.params.nightclubId]);
    res.json({ rps: rows });
  }));

router.patch('/nightclubs/:nightclubId/rps/:userId', ...guard, requireRole(...MANAGE_ROLES),
  validate({
    params: z.object({ nightclubId: uuid, userId: uuid }),
    body: z.object({
      commission_pct: z.number().min(0).max(100).optional(),
      active: z.boolean().optional(),
      regenerate_code: z.boolean().optional(),
    }).refine((b) => Object.keys(b).length > 0, { message: 'Nada que cambiar' }),
  }),
  asyncHandler(async (req, res) => {
    const { nightclubId, userId } = req.params;
    const b = req.body;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const u = await client.query(
        `SELECT u.id, u.role, (p.user_id IS NOT NULL) AS has_profile
           FROM users u LEFT JOIN rp_profiles p ON p.user_id = u.id
          WHERE u.id = $1 AND u.nightclub_id = $2 FOR UPDATE OF u`,
        [userId, nightclubId]);
      if (u.rowCount === 0 || (u.rows[0].role !== rp.ROLE && !u.rows[0].has_profile)) {
        throw ApiError.notFound('RP no encontrado');
      }
      await rp.ensureProfile(client, { nightclubId, userId });
      if (b.regenerate_code) {
        for (let i = 0; i < 20; i += 1) {
          const ok = await client.query(
            `UPDATE rp_profiles SET code = $2, updated_at = now() WHERE user_id = $1
               AND NOT EXISTS (SELECT 1 FROM rp_profiles x WHERE x.nightclub_id = $3 AND x.code = $2)`,
            [userId, rp.randomCode(), nightclubId]);
          if (ok.rowCount > 0) break;
        }
      }
      await client.query(
        `UPDATE rp_profiles
            SET commission_pct = COALESCE($2::numeric, commission_pct),
                active = COALESCE($3::boolean, active), updated_at = now()
          WHERE user_id = $1`,
        [userId, b.commission_pct ?? null, b.active ?? null]);
      await client.query(
        `INSERT INTO audit_log (nightclub_id, actor_id, action, entity, entity_id, after)
         VALUES ($1,$2,'rp.update','user',$3,$4)`,
        [nightclubId, req.user.id, userId, JSON.stringify(b)]);
      await client.query('COMMIT');
      const { rows } = await client.query(
        `SELECT code, commission_pct::text AS commission_pct, active FROM rp_profiles WHERE user_id = $1`,
        [userId]);
      res.json({ profile: rows[0] });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }));

router.get('/nightclubs/:nightclubId/rp/summary', ...guard, requireRole(...MANAGE_ROLES),
  validate({ params, query: eventQuery }),
  asyncHandler(async (req, res) => {
    const eventId = await pickEvent(pool, { nightclubId: req.params.nightclubId, eventId: req.query.event_id });
    if (!eventId) return res.json({ event: null, rps: [] });
    res.json(await rp.summary(pool, { nightclubId: req.params.nightclubId, eventId }));
  }));

router.get('/nightclubs/:nightclubId/rp/:userId/night', ...guard, requireRole(...MANAGE_ROLES),
  validate({ params: z.object({ nightclubId: uuid, userId: uuid }), query: eventQuery }),
  asyncHandler(async (req, res) => {
    const eventId = await pickEvent(pool, { nightclubId: req.params.nightclubId, eventId: req.query.event_id });
    if (!eventId) return res.json({ night: null });
    res.json({ night: await rp.nightReport(pool, {
      nightclubId: req.params.nightclubId, eventId, rpUserId: req.params.userId }) });
  }));

router.post('/nightclubs/:nightclubId/rp/settle', ...guard, requireRole(...MANAGE_ROLES),
  validate({
    params,
    body: z.object({
      rp_user_id: uuid, event_id: uuid, note: z.string().trim().max(200).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const done = await rp.settle(client, {
        nightclubId: req.params.nightclubId, rpUserId: req.body.rp_user_id,
        eventId: req.body.event_id, settledBy: req.user.id, note: req.body.note || null,
      });
      await client.query(
        `INSERT INTO audit_log (nightclub_id, actor_id, action, entity, entity_id, after)
         VALUES ($1,$2,'rp.settle','user',$3,$4)`,
        [req.params.nightclubId, req.user.id, req.body.rp_user_id,
          JSON.stringify({ event_id: req.body.event_id, settlements: done })]);
      await client.query('COMMIT');
      res.status(201).json({ settlements: done });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }));

module.exports = router;
