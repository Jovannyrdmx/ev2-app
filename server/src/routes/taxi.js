// Safe departure: trusted drivers, fare list and module settings (D21).
//
// Part 1 of step 2.6 covers who can drive and what a ride costs:
//   * only the manager registers a driver; the driver gets a real account (role
//     `driver`) with a one-time temporary password, because the driver — and nobody
//     else — confirms the start and the end of a ride;
//   * `trusted` is the manager's explicit endorsement after seeing licence and
//     papers. An untrusted or inactive driver can sign in but is never dispatched;
//   * availability is the driver's own switch: off / available, plus "I am already
//     parked at the exit", which is what lets the app tell a guest to just walk out;
//   * the fare list is the club's, by zone. A destination outside the list is quoted
//     as "a convenir" rather than with an invented number.
//
// The ride lifecycle, cash settlement and the departure certificate are part 2.
'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const { pool } = require('../db/pool');
const { ApiError, asyncHandler } = require('../middleware/errors');
const { validate, z, uuid, email, currency, pagination } = require('../middleware/validate');
const { authenticate, requireRole, sameNightclub } = require('../middleware/auth');
const { temporaryPassword } = require('../services/credentials');
const events = require('../services/events');
const taxi = require('../services/taxi');

const router = express.Router({ mergeParams: true });

const LIVE = taxi.LIVE_STATUSES;

// What the manager sees. `s` folds in the driver's own history so the manager can
// judge punctuality without a second call.
const DRIVER_SELECT = `
  SELECT d.id, d.user_id, u.email, u.first_name, u.last_name, u.display_name,
         u.status AS account_status, u.must_change_password,
         d.phone, d.company, d.license_number, d.vehicle_plate, d.vehicle_make,
         d.vehicle_model, d.vehicle_color, d.vehicle_year, d.seats, d.notes,
         d.trusted, d.verified_at, d.active, d.availability, d.at_venue,
         d.available_since, d.created_at,
         COALESCE(s.rides_completed, 0) AS rides_completed,
         s.rating_avg, s.avg_pickup_minutes
    FROM drivers d
    JOIN users u ON u.id = d.user_id
    LEFT JOIN LATERAL (
      SELECT COUNT(*) FILTER (WHERE r.status = 'completed')::int AS rides_completed,
             ROUND(AVG(r.rating), 2)::text AS rating_avg,
             ROUND(AVG(EXTRACT(EPOCH FROM (r.arrived_at - r.accepted_at)) / 60))::int
               AS avg_pickup_minutes
        FROM taxi_requests r WHERE r.driver_id = d.id
    ) s ON true`;

/** Loads the signed-in driver's own row, or 403 for anyone who is not a driver. */
async function requireDriver(req, runner = pool) {
  const { rows } = await runner.query(
    `${DRIVER_SELECT} WHERE d.user_id = $1 AND d.nightclub_id = $2`,
    [req.user.id, req.params.nightclubId],
  );
  if (rows.length === 0) throw ApiError.forbidden('Esta sección es solo para conductores registrados');
  return rows[0];
}

async function hasLiveRide(driverId, runner = pool) {
  const { rowCount } = await runner.query(
    `SELECT 1 FROM taxi_requests WHERE driver_id = $1 AND status = ANY($2::text[]) LIMIT 1`,
    [driverId, LIVE],
  );
  return rowCount > 0;
}

router.use('/nightclubs/:nightclubId', authenticate, sameNightclub());

// ------------------------------------------------------------------ settings

router.get('/nightclubs/:nightclubId/taxi-settings',
  validate({ params: z.object({ nightclubId: uuid }) }),
  asyncHandler(async (req, res) => {
    const settings = await taxi.settingsFor(req.params.nightclubId);
    // Only the manager needs to know the commission; guests just need the pickup point.
    if (req.user.role === 'manager' || req.user.role === 'admin') {
      return res.json({ settings });
    }
    const { enabled, pickup_point, currency: cur, conduct_terms } = settings;
    return res.json({ settings: { enabled, pickup_point, currency: cur, conduct_terms } });
  }));

router.put('/nightclubs/:nightclubId/taxi-settings',
  requireRole('manager'),
  validate({
    params: z.object({ nightclubId: uuid }),
    body: z.object({
      enabled: z.boolean().optional(),
      pickup_point: z.string().trim().min(1).max(120).optional(),
      currency: currency.optional(),
      certificate_ttl_minutes: z.number().int().min(15).max(720).optional(),
      request_timeout_minutes: z.number().int().min(3).max(60).optional(),
      club_commission_pct: z.number().min(0).max(100).optional(),
      conduct_terms: z.string().trim().max(4000).nullable().optional(),
    }).refine((b) => Object.keys(b).length > 0, { message: 'No fields to update' }),
  }),
  asyncHandler(async (req, res) => {
    const { nightclubId } = req.params;
    await taxi.settingsFor(nightclubId);
    const b = req.body;
    const { rows } = await pool.query(
      `UPDATE taxi_settings SET
         enabled = COALESCE($2, enabled),
         pickup_point = COALESCE($3, pickup_point),
         currency = COALESCE($4, currency),
         certificate_ttl_minutes = COALESCE($5, certificate_ttl_minutes),
         request_timeout_minutes = COALESCE($6, request_timeout_minutes),
         club_commission_pct = COALESCE($7, club_commission_pct),
         conduct_terms = CASE WHEN $8::boolean THEN $9 ELSE conduct_terms END,
         updated_by = $10, updated_at = now()
       WHERE nightclub_id = $1
       RETURNING nightclub_id, enabled, pickup_point, currency, certificate_ttl_minutes,
                 request_timeout_minutes, club_commission_pct::text, conduct_terms, updated_at`,
      [nightclubId, b.enabled ?? null, b.pickup_point ?? null, b.currency ?? null,
        b.certificate_ttl_minutes ?? null, b.request_timeout_minutes ?? null,
        b.club_commission_pct ?? null,
        Object.hasOwn(b, 'conduct_terms'), b.conduct_terms ?? null, req.user.id]);
    res.json({ settings: rows[0] });
  }));

// ------------------------------------------------------------------ fares

router.get('/nightclubs/:nightclubId/taxi-fares',
  validate({
    params: z.object({ nightclubId: uuid }),
    query: z.object({ include_inactive: z.coerce.boolean().default(false) }),
  }),
  asyncHandler(async (req, res) => {
    const isManager = req.user.role === 'manager' || req.user.role === 'admin';
    const includeInactive = isManager && req.query.include_inactive;
    const { rows } = await pool.query(
      `SELECT id, zone, description, amount::text, currency, active, sort_order
         FROM taxi_fares
        WHERE nightclub_id = $1 AND ($2::boolean OR active)
        ORDER BY sort_order, zone`,
      [req.params.nightclubId, includeInactive]);
    res.json({ fares: rows });
  }));

const fareBody = z.object({
  zone: z.string().trim().min(1).max(80),
  description: z.string().trim().max(160).nullable().optional(),
  amount: z.number().min(0).max(100000),
  currency: currency.optional(),
  sort_order: z.number().int().optional(),
});

router.post('/nightclubs/:nightclubId/taxi-fares',
  requireRole('manager'),
  validate({ params: z.object({ nightclubId: uuid }), body: fareBody }),
  asyncHandler(async (req, res) => {
    const settings = await taxi.settingsFor(req.params.nightclubId);
    const b = req.body;
    try {
      const { rows } = await pool.query(
        `INSERT INTO taxi_fares (nightclub_id, zone, description, amount, currency, sort_order, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         RETURNING id, zone, description, amount::text, currency, active, sort_order`,
        [req.params.nightclubId, b.zone, b.description ?? null, b.amount,
          b.currency || settings.currency, b.sort_order ?? 0, req.user.id]);
      res.status(201).json({ fare: rows[0] });
    } catch (err) {
      if (err.code === '23505') throw ApiError.conflict('Ya existe una tarifa para esa zona');
      throw err;
    }
  }));

router.put('/nightclubs/:nightclubId/taxi-fares/:fareId',
  requireRole('manager'),
  validate({
    params: z.object({ nightclubId: uuid, fareId: uuid }),
    body: fareBody.partial().extend({ active: z.boolean().optional() })
      .refine((b) => Object.keys(b).length > 0, { message: 'No fields to update' }),
  }),
  asyncHandler(async (req, res) => {
    const b = req.body;
    const { rows } = await pool.query(
      `UPDATE taxi_fares SET
         zone = COALESCE($3, zone), description = CASE WHEN $4::boolean THEN $5 ELSE description END,
         amount = COALESCE($6, amount), currency = COALESCE($7, currency),
         active = COALESCE($8, active), sort_order = COALESCE($9, sort_order),
         updated_by = $10, updated_at = now()
       WHERE id = $1 AND nightclub_id = $2
       RETURNING id, zone, description, amount::text, currency, active, sort_order`,
      [req.params.fareId, req.params.nightclubId, b.zone ?? null,
        Object.hasOwn(b, 'description'), b.description ?? null, b.amount ?? null,
        b.currency ?? null, b.active ?? null, b.sort_order ?? null, req.user.id]);
    if (rows.length === 0) throw ApiError.notFound('Tarifa no encontrada');
    res.json({ fare: rows[0] });
  }));

// Retired, not deleted: past rides quote the fare they were charged with.
router.delete('/nightclubs/:nightclubId/taxi-fares/:fareId',
  requireRole('manager'),
  validate({ params: z.object({ nightclubId: uuid, fareId: uuid }) }),
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(
      `UPDATE taxi_fares SET active = false, updated_by = $3, updated_at = now()
        WHERE id = $1 AND nightclub_id = $2
        RETURNING id, zone, active`,
      [req.params.fareId, req.params.nightclubId, req.user.id]);
    if (rows.length === 0) throw ApiError.notFound('Tarifa no encontrada');
    res.json({ fare: rows[0] });
  }));

// ------------------------------------------------------------------ drivers (manager)

const driverCreate = z.object({
  email,
  first_name: z.string().trim().min(1).max(100),
  last_name: z.string().trim().min(1).max(100),
  birth_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD'),
  phone: z.string().trim().min(7).max(30),
  vehicle_plate: z.string().trim().min(3).max(20),
  company: z.string().trim().max(80).nullable().optional(),
  license_number: z.string().trim().max(40).nullable().optional(),
  vehicle_make: z.string().trim().max(40).nullable().optional(),
  vehicle_model: z.string().trim().max(40).nullable().optional(),
  vehicle_color: z.string().trim().max(30).nullable().optional(),
  vehicle_year: z.number().int().min(1980).max(2100).nullable().optional(),
  seats: z.number().int().min(1).max(8).optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
  trusted: z.boolean().optional(),
});

function yearsSince(dateStr) {
  const birth = new Date(`${dateStr}T00:00:00Z`);
  return (Date.now() - birth.getTime()) / (365.25 * 86_400_000);
}

router.get('/nightclubs/:nightclubId/drivers',
  requireRole('manager'),
  validate({
    params: z.object({ nightclubId: uuid }),
    query: pagination.extend({
      availability: z.enum(['off', 'available', 'on_trip']).optional(),
      include_inactive: z.coerce.boolean().default(false),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(
      `${DRIVER_SELECT}
        WHERE d.nightclub_id = $1
          AND ($2::text IS NULL OR d.availability = $2)
          AND ($3::boolean OR d.active)
        ORDER BY d.active DESC, d.trusted DESC, u.first_name, u.last_name
        LIMIT $4 OFFSET $5`,
      [req.params.nightclubId, req.query.availability || null, req.query.include_inactive,
        req.query.limit, req.query.offset]);
    res.json({ drivers: rows });
  }));

router.post('/nightclubs/:nightclubId/drivers',
  requireRole('manager'),
  validate({ params: z.object({ nightclubId: uuid }), body: driverCreate }),
  asyncHandler(async (req, res) => {
    const { nightclubId } = req.params;
    const b = req.body;
    if (yearsSince(b.birth_date) < 18) {
      throw ApiError.unprocessable('El conductor debe ser mayor de edad');
    }
    const temp = temporaryPassword();
    const hash = await bcrypt.hash(temp, 10);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      let userId;
      try {
        const created = await client.query(
          `INSERT INTO users (nightclub_id, email, phone, password_hash, first_name, last_name,
                              display_name, role, birth_date, age_verified, must_change_password,
                              created_by, terms_version, terms_accepted_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'driver',$8,true,true,$9,NULL,NULL)
           RETURNING id`,
          [nightclubId, b.email, b.phone, hash, b.first_name, b.last_name,
            `${b.first_name} ${b.last_name}`.trim(), b.birth_date, req.user.id]);
        userId = created.rows[0].id;
      } catch (err) {
        if (err.code === '23505') throw ApiError.conflict('Ya existe una cuenta con ese correo');
        throw err;
      }
      let driverId;
      try {
        const created = await client.query(
          `INSERT INTO drivers (nightclub_id, user_id, phone, company, license_number, vehicle_plate,
                                vehicle_make, vehicle_model, vehicle_color, vehicle_year, seats,
                                notes, trusted, verified_by, verified_at, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,
                   CASE WHEN $13 THEN $14::uuid END, CASE WHEN $13 THEN now() END, $14)
           RETURNING id`,
          [nightclubId, userId, b.phone, b.company ?? null, b.license_number ?? null,
            b.vehicle_plate.toUpperCase(), b.vehicle_make ?? null, b.vehicle_model ?? null,
            b.vehicle_color ?? null, b.vehicle_year ?? null, b.seats ?? 4, b.notes ?? null,
            b.trusted ?? false, req.user.id]);
        driverId = created.rows[0].id;
      } catch (err) {
        if (err.code === '23505') throw ApiError.conflict('Ya hay un conductor activo con esas placas');
        throw err;
      }
      await client.query('INSERT INTO user_preferences (user_id) VALUES ($1) ON CONFLICT DO NOTHING',
        [userId]);
      await client.query('COMMIT');

      const full = await pool.query(`${DRIVER_SELECT} WHERE d.id = $1`, [driverId]);
      // The temporary password travels exactly once, here. It is never stored in clear.
      res.status(201).json({ driver: full.rows[0], temporary_password: temp });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }));

router.get('/nightclubs/:nightclubId/drivers/:driverId',
  requireRole('manager'),
  validate({ params: z.object({ nightclubId: uuid, driverId: uuid }) }),
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(`${DRIVER_SELECT} WHERE d.id = $1 AND d.nightclub_id = $2`,
      [req.params.driverId, req.params.nightclubId]);
    if (rows.length === 0) throw ApiError.notFound('Conductor no encontrado');
    res.json({ driver: rows[0] });
  }));

router.patch('/nightclubs/:nightclubId/drivers/:driverId',
  requireRole('manager'),
  validate({
    params: z.object({ nightclubId: uuid, driverId: uuid }),
    body: z.object({
      phone: z.string().trim().min(7).max(30).optional(),
      company: z.string().trim().max(80).nullable().optional(),
      license_number: z.string().trim().max(40).nullable().optional(),
      vehicle_plate: z.string().trim().min(3).max(20).optional(),
      vehicle_make: z.string().trim().max(40).nullable().optional(),
      vehicle_model: z.string().trim().max(40).nullable().optional(),
      vehicle_color: z.string().trim().max(30).nullable().optional(),
      vehicle_year: z.number().int().min(1980).max(2100).nullable().optional(),
      seats: z.number().int().min(1).max(8).optional(),
      notes: z.string().trim().max(2000).nullable().optional(),
      trusted: z.boolean().optional(),
      active: z.boolean().optional(),
    }).refine((b) => Object.keys(b).length > 0, { message: 'No fields to update' }),
  }),
  asyncHandler(async (req, res) => {
    const { nightclubId, driverId } = req.params;
    const b = req.body;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const current = await client.query(
        `SELECT id, user_id, active FROM drivers WHERE id = $1 AND nightclub_id = $2 FOR UPDATE`,
        [driverId, nightclubId]);
      if (current.rowCount === 0) throw ApiError.notFound('Conductor no encontrado');

      // A driver in the middle of a ride cannot be taken off the road from here:
      // the guest is in the car.
      const losingRoad = b.active === false || b.trusted === false;
      if (losingRoad && await hasLiveRide(driverId, client)) {
        throw ApiError.conflict('El conductor tiene un viaje en curso; ciérralo antes de darlo de baja');
      }

      const { rows } = await client.query(
        `UPDATE drivers SET
           phone = COALESCE($3, phone),
           company = CASE WHEN $4::boolean THEN $5 ELSE company END,
           license_number = CASE WHEN $6::boolean THEN $7 ELSE license_number END,
           vehicle_plate = COALESCE(upper($8), vehicle_plate),
           vehicle_make = CASE WHEN $9::boolean THEN $10 ELSE vehicle_make END,
           vehicle_model = CASE WHEN $11::boolean THEN $12 ELSE vehicle_model END,
           vehicle_color = CASE WHEN $13::boolean THEN $14 ELSE vehicle_color END,
           vehicle_year = CASE WHEN $15::boolean THEN $16 ELSE vehicle_year END,
           seats = COALESCE($17, seats),
           notes = CASE WHEN $18::boolean THEN $19 ELSE notes END,
           trusted = COALESCE($20, trusted),
           verified_by = CASE WHEN $20 IS TRUE THEN $21::uuid
                              WHEN $20 IS FALSE THEN NULL ELSE verified_by END,
           verified_at = CASE WHEN $20 IS TRUE THEN now()
                              WHEN $20 IS FALSE THEN NULL ELSE verified_at END,
           active = COALESCE($22, active),
           availability = CASE WHEN $22 IS FALSE OR $20 IS FALSE THEN 'off' ELSE availability END,
           at_venue = CASE WHEN $22 IS FALSE OR $20 IS FALSE THEN false ELSE at_venue END,
           updated_at = now()
         WHERE id = $1 AND nightclub_id = $2
         RETURNING user_id`,
        [driverId, nightclubId, b.phone ?? null,
          Object.hasOwn(b, 'company'), b.company ?? null,
          Object.hasOwn(b, 'license_number'), b.license_number ?? null,
          b.vehicle_plate ?? null,
          Object.hasOwn(b, 'vehicle_make'), b.vehicle_make ?? null,
          Object.hasOwn(b, 'vehicle_model'), b.vehicle_model ?? null,
          Object.hasOwn(b, 'vehicle_color'), b.vehicle_color ?? null,
          Object.hasOwn(b, 'vehicle_year'), b.vehicle_year ?? null,
          b.seats ?? null,
          Object.hasOwn(b, 'notes'), b.notes ?? null,
          b.trusted ?? null, req.user.id,
          b.active ?? null]);

      // Deactivating closes the door: the account cannot sign in and its sessions die.
      if (b.active !== undefined) {
        await client.query('UPDATE users SET status = $2 WHERE id = $1',
          [rows[0].user_id, b.active ? 'active' : 'blocked']);
        if (!b.active) {
          await client.query(
            `UPDATE refresh_tokens SET revoked_at = now()
              WHERE user_id = $1 AND revoked_at IS NULL`, [rows[0].user_id]);
        }
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    const full = await pool.query(`${DRIVER_SELECT} WHERE d.id = $1`, [driverId]);
    res.json({ driver: full.rows[0] });
  }));

router.post('/nightclubs/:nightclubId/drivers/:driverId/reset-password',
  requireRole('manager'),
  validate({ params: z.object({ nightclubId: uuid, driverId: uuid }) }),
  asyncHandler(async (req, res) => {
    const found = await pool.query('SELECT user_id FROM drivers WHERE id = $1 AND nightclub_id = $2',
      [req.params.driverId, req.params.nightclubId]);
    if (found.rowCount === 0) throw ApiError.notFound('Conductor no encontrado');
    const userId = found.rows[0].user_id;
    const temp = temporaryPassword();
    await pool.query(
      `UPDATE users SET password_hash = $2, must_change_password = true WHERE id = $1`,
      [userId, await bcrypt.hash(temp, 10)]);
    await pool.query(
      `UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`,
      [userId]);
    res.json({ temporary_password: temp });
  }));

// ------------------------------------------------------------------ driver: own profile

router.get('/nightclubs/:nightclubId/taxi/me',
  validate({ params: z.object({ nightclubId: uuid }) }),
  asyncHandler(async (req, res) => {
    res.json({ driver: await requireDriver(req) });
  }));

router.put('/nightclubs/:nightclubId/taxi/me/availability',
  validate({
    params: z.object({ nightclubId: uuid }),
    // `on_trip` is set by the system when a ride starts, never declared by hand.
    body: z.object({
      availability: z.enum(['off', 'available']),
      at_venue: z.boolean().default(false),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { nightclubId } = req.params;
    const me = await requireDriver(req);
    if (!me.active || !me.trusted) {
      throw ApiError.forbidden('Tu registro debe estar activo y verificado por el gerente');
    }
    const settings = await taxi.settingsFor(nightclubId);
    if (!settings.enabled && req.body.availability === 'available') {
      throw ApiError.unprocessable('El servicio de taxi está desactivado por el club');
    }
    if (req.body.availability === 'off' && await hasLiveRide(me.id)) {
      throw ApiError.conflict('Tienes un viaje en curso; ciérralo antes de marcarte no disponible');
    }
    const atVenue = req.body.availability === 'available' ? req.body.at_venue : false;
    const { rows } = await pool.query(
      // $2 is cast explicitly: without it Postgres deduces varchar from the SET and
      // text from the CASE comparison, and refuses the statement (42P08).
      `UPDATE drivers SET availability = $2::text, at_venue = $3,
              available_since = CASE WHEN $2::text = 'available' AND availability <> 'available'
                                     THEN now()
                                     WHEN $2::text = 'off' THEN NULL
                                     ELSE available_since END,
              updated_at = now()
        WHERE id = $1
        RETURNING availability, at_venue, available_since`,
      [me.id, req.body.availability, atVenue]);

    await events.publish({
      nightclubId,
      type: 'taxi_driver_availability',
      audience: { roles: ['manager', 'hostess'] },
      payload: {
        driver_id: me.id,
        display_name: me.display_name,
        availability: rows[0].availability,
        at_venue: rows[0].at_venue,
      },
    });
    res.json({ availability: rows[0] });
  }));

// ------------------------------------------------------------------ guest: availability

router.get('/nightclubs/:nightclubId/taxi/availability',
  validate({ params: z.object({ nightclubId: uuid }) }),
  asyncHandler(async (req, res) => {
    const { nightclubId } = req.params;
    const settings = await taxi.settingsFor(nightclubId);
    if (!settings.enabled) {
      return res.json({
        enabled: false,
        available_drivers: 0,
        drivers_at_venue: 0,
        wait_at_exit: false,
        estimated_wait_minutes: null,
        message: 'El servicio de salida segura no está disponible en este momento.',
      });
    }
    const state = await taxi.availability(nightclubId);
    return res.json({ enabled: true, pickup_point: settings.pickup_point, ...state });
  }));

module.exports = router;
