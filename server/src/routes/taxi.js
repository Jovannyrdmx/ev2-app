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
// Part 2 adds the ride itself: an open request is offered to every available driver
// at once, the first to accept takes it and declares how many minutes away they are,
// and the driver — nobody else — confirms arrival, start and end. Cash is settled
// hand to hand and recorded in the ledger; card is phase 3. When the ride starts the
// guest gets a departure certificate with a folio anyone can verify.
'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
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

// ================================================================== rides (part 2)

const RIDE_SELECT = `
  SELECT r.id, r.status, r.passengers, r.pickup_location, r.destination, r.destination_zone,
         r.quoted_amount::text AS quoted_amount, r.final_amount::text AS final_amount,
         r.currency, r.payment_method, r.eta_minutes, r.notes, r.rating, r.rating_comment,
         r.created_at, r.accepted_at, r.arrived_at, r.started_at, r.ended_at, r.cancelled_at,
         r.cancel_reason, r.conduct_code, r.code_expires_at, r.certificate_issued_at,
         r.transaction_id, r.fare_id, r.declined_by,
         r.user_id, gu.first_name AS guest_first_name, gu.last_name AS guest_last_name,
         gu.display_name AS guest_name, gu.phone AS guest_phone,
         r.driver_id, du.first_name AS driver_first_name, du.display_name AS driver_name,
         d.phone AS driver_phone, d.company AS driver_company,
         d.vehicle_plate, d.vehicle_color, d.vehicle_make, d.vehicle_model
    FROM taxi_requests r
    JOIN users gu ON gu.id = r.user_id
    LEFT JOIN drivers d ON d.id = r.driver_id
    LEFT JOIN users du ON du.id = d.user_id`;

const OFFERABLE = 'requested';
const CANCELLABLE = ['requested', 'assigned', 'driver_arrived'];

/** Minutes declared by the driver, turned into the instant the guest should be at the door. */
function expectedArrival(row) {
  if (!row.accepted_at || row.eta_minutes === null) return null;
  return new Date(new Date(row.accepted_at).getTime() + row.eta_minutes * 60_000).toISOString();
}

/**
 * One row, three readings. The guest gets the car and the phone only once a driver is
 * on the way; the driver never gets the guest's phone (the guest is at the door, and
 * a phone number handed to a stranger is a risk the club would be creating).
 */
function presentRide(row, viewer) {
  const base = {
    id: row.id,
    status: row.status,
    passengers: row.passengers,
    pickup_location: row.pickup_location,
    destination: row.destination,
    destination_zone: row.destination_zone,
    quoted_amount: row.quoted_amount,
    final_amount: row.final_amount,
    currency: row.currency,
    payment_method: row.payment_method,
    notes: row.notes,
    created_at: row.created_at,
    accepted_at: row.accepted_at,
    arrived_at: row.arrived_at,
    started_at: row.started_at,
    ended_at: row.ended_at,
    cancelled_at: row.cancelled_at,
    cancel_reason: row.cancel_reason,
    rating: row.rating,
  };
  const driver = row.driver_id ? {
    id: row.driver_id,
    name: row.driver_name,
    first_name: row.driver_first_name,
    company: row.driver_company,
    phone: row.driver_phone,
    vehicle: {
      plate: row.vehicle_plate,
      color: row.vehicle_color,
      description: [row.vehicle_make, row.vehicle_model].filter(Boolean).join(' ') || null,
    },
  } : null;

  if (viewer === 'guest') {
    return {
      ...base,
      eta_minutes: row.eta_minutes,
      expected_arrival_at: expectedArrival(row),
      driver,
      certificate_folio: row.conduct_code,
      certificate_expires_at: row.code_expires_at,
    };
  }
  if (viewer === 'driver') {
    return {
      ...base,
      eta_minutes: row.eta_minutes,
      expected_arrival_at: expectedArrival(row),
      guest: { name: row.guest_name || row.guest_first_name },
    };
  }
  return {
    ...base,
    eta_minutes: row.eta_minutes,
    expected_arrival_at: expectedArrival(row),
    guest: { id: row.user_id, name: row.guest_name, phone: row.guest_phone },
    driver,
    rating_comment: row.rating_comment,
    transaction_id: row.transaction_id,
    certificate_folio: row.conduct_code,
    certificate_expires_at: row.code_expires_at,
  };
}

function isManager(user) {
  return user.role === 'manager' || user.role === 'admin';
}

/** Loads a ride and decides which of the three readings the caller gets. */
async function loadRide(req, rideId, runner = pool) {
  const { rows } = await runner.query(`${RIDE_SELECT} WHERE r.id = $1 AND r.nightclub_id = $2`,
    [rideId, req.params.nightclubId]);
  if (rows.length === 0) throw ApiError.notFound('Viaje no encontrado');
  const row = rows[0];
  if (isManager(req.user)) return { row, viewer: 'manager' };
  if (row.user_id === req.user.id) return { row, viewer: 'guest' };
  const mine = await runner.query('SELECT id FROM drivers WHERE user_id = $1', [req.user.id]);
  if (mine.rowCount > 0 && mine.rows[0].id === row.driver_id) return { row, viewer: 'driver' };
  // A ride that is not yours does not exist as far as you are concerned.
  throw ApiError.notFound('Viaje no encontrado');
}

// ------------------------------------------------------------------ guest: request a ride

router.post('/nightclubs/:nightclubId/taxi/rides',
  validate({
    params: z.object({ nightclubId: uuid }),
    body: z.object({
      client_request_id: uuid.optional(),
      fare_id: uuid.optional(),
      destination: z.string().trim().max(300).optional(),
      passengers: z.number().int().min(1).max(8).default(1),
      notes: z.string().trim().max(280).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { nightclubId } = req.params;
    const b = req.body;
    const settings = await taxi.settingsFor(nightclubId);
    if (!settings.enabled) throw ApiError.unprocessable('El servicio de salida segura está desactivado');
    if (req.user.role === 'driver') {
      throw ApiError.forbidden('Un conductor no solicita viajes desde esta cuenta');
    }

    if (b.client_request_id) {
      const existing = await pool.query(`${RIDE_SELECT} WHERE r.client_request_id = $1`,
        [b.client_request_id]);
      if (existing.rowCount > 0) {
        return res.status(200).json({ ride: presentRide(existing.rows[0], 'guest'), idempotent: true });
      }
    }

    const quoted = await taxi.quote({ nightclubId, fareId: b.fare_id });
    if (quoted === null) throw ApiError.unprocessable('La zona seleccionada no está disponible');

    let ride;
    try {
      const { rows } = await pool.query(
        `INSERT INTO taxi_requests (nightclub_id, user_id, pickup_location, destination,
                                    destination_zone, fare_id, quoted_amount, currency,
                                    passengers, notes, client_request_id, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'requested')
         RETURNING id`,
        [nightclubId, req.user.id, settings.pickup_point, b.destination || null,
          quoted.zone, quoted.fare_id, quoted.quoted_amount, quoted.currency,
          b.passengers, b.notes || null, b.client_request_id || null]);
      ride = rows[0];
    } catch (err) {
      if (err.code === '23505') {
        throw ApiError.conflict('Ya tienes una solicitud de taxi abierta');
      }
      throw err;
    }

    const full = await pool.query(`${RIDE_SELECT} WHERE r.id = $1`, [ride.id]);
    await events.publish({
      nightclubId,
      type: 'taxi_requested',
      audience: { roles: ['driver', 'manager', 'hostess'] },
      payload: { ride_id: ride.id, destination_zone: quoted.zone, passengers: b.passengers },
    });

    // The same snapshot the guest saw before pressing the button, so the screen can
    // say "walk to the exit" instead of "waiting" when someone is already there.
    const state = await taxi.availability(nightclubId);
    return res.status(201).json({
      ride: presentRide(full.rows[0], 'guest'),
      availability: state,
      pickup_point: settings.pickup_point,
    });
  }));

router.get('/nightclubs/:nightclubId/taxi/rides/mine',
  validate({
    params: z.object({ nightclubId: uuid }),
    query: pagination,
  }),
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(
      `${RIDE_SELECT} WHERE r.user_id = $1 AND r.nightclub_id = $2
        ORDER BY r.created_at DESC LIMIT $3 OFFSET $4`,
      [req.user.id, req.params.nightclubId, req.query.limit, req.query.offset]);
    res.json({
      rides: rows.map((r) => presentRide(r, 'guest')),
      live: rows.filter((r) => LIVE.includes(r.status)).map((r) => presentRide(r, 'guest'))[0] || null,
    });
  }));

// ------------------------------------------------------------------ driver: offers and lifecycle

router.get('/nightclubs/:nightclubId/taxi/me/offers',
  validate({ params: z.object({ nightclubId: uuid }) }),
  asyncHandler(async (req, res) => {
    const me = await requireDriver(req);
    if (!me.active || !me.trusted) {
      throw ApiError.forbidden('Tu registro debe estar activo y verificado por el gerente');
    }
    const settings = await taxi.settingsFor(req.params.nightclubId);
    const { rows } = await pool.query(
      `${RIDE_SELECT}
        WHERE r.nightclub_id = $1 AND r.status = $2
          AND NOT ($3::uuid = ANY (r.declined_by))
          AND r.created_at > now() - ($4 || ' minutes')::interval
        ORDER BY r.created_at`,
      [req.params.nightclubId, OFFERABLE, me.id, String(settings.request_timeout_minutes)]);
    res.json({ offers: rows.map((r) => presentRide(r, 'driver')) });
  }));

router.get('/nightclubs/:nightclubId/taxi/me/rides',
  validate({ params: z.object({ nightclubId: uuid }), query: pagination }),
  asyncHandler(async (req, res) => {
    const me = await requireDriver(req);
    const [rides, totals] = await Promise.all([
      pool.query(`${RIDE_SELECT} WHERE r.driver_id = $1 ORDER BY r.created_at DESC LIMIT $2 OFFSET $3`,
        [me.id, req.query.limit, req.query.offset]),
      pool.query(
        `SELECT currency, count(*)::int AS rides, COALESCE(sum(final_amount), 0)::numeric(12,2)::text AS charged
           FROM taxi_requests
          WHERE driver_id = $1 AND status = 'completed'
            AND ended_at > date_trunc('day', now() - interval '6 hours')
          GROUP BY currency`, [me.id]),
    ]);
    res.json({
      rides: rides.rows.map((r) => presentRide(r, 'driver')),
      live: rides.rows.filter((r) => LIVE.includes(r.status)).map((r) => presentRide(r, 'driver'))[0] || null,
      tonight: totals.rows,
    });
  }));

router.post('/nightclubs/:nightclubId/taxi/rides/:rideId/accept',
  validate({
    params: z.object({ nightclubId: uuid, rideId: uuid }),
    body: z.object({ eta_minutes: z.number().int().min(0).max(120) }),
  }),
  asyncHandler(async (req, res) => {
    const { nightclubId, rideId } = req.params;
    const me = await requireDriver(req);
    if (!me.active || !me.trusted) throw ApiError.forbidden('Tu registro no está activo y verificado');
    if (me.availability === 'on_trip' || await hasLiveRide(me.id)) {
      throw ApiError.conflict('Ya tienes un viaje en curso');
    }

    const client = await pool.connect();
    let rideRow;
    try {
      await client.query('BEGIN');
      // The WHERE clause is the race guard: two drivers pressing at the same instant,
      // the second one updates zero rows and gets a clean 409.
      const { rows } = await client.query(
        `UPDATE taxi_requests
            SET driver_id = $3, status = 'assigned', eta_minutes = $4, accepted_at = now(),
                updated_at = now()
          WHERE id = $1 AND nightclub_id = $2 AND status = 'requested'
          RETURNING id`,
        [rideId, nightclubId, me.id, req.body.eta_minutes]);
      if (rows.length === 0) {
        const exists = await client.query('SELECT status FROM taxi_requests WHERE id = $1 AND nightclub_id = $2',
          [rideId, nightclubId]);
        if (exists.rowCount === 0) throw ApiError.notFound('Viaje no encontrado');
        throw ApiError.conflict('Ese viaje ya fue tomado o cancelado');
      }
      await client.query(
        `UPDATE drivers SET availability = 'on_trip', at_venue = false, updated_at = now() WHERE id = $1`,
        [me.id]);
      await client.query('COMMIT');
      rideRow = rows[0];
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    const full = await pool.query(`${RIDE_SELECT} WHERE r.id = $1`, [rideRow.id]);
    const row = full.rows[0];
    await events.publish({
      nightclubId,
      type: 'taxi_assigned',
      audience: { userIds: [row.user_id], roles: ['manager', 'hostess'] },
      payload: {
        ride_id: row.id,
        eta_minutes: row.eta_minutes,
        expected_arrival_at: expectedArrival(row),
        driver_name: row.driver_first_name,
        vehicle_plate: row.vehicle_plate,
      },
    });
    res.json({ ride: presentRide(row, 'driver') });
  }));

router.post('/nightclubs/:nightclubId/taxi/rides/:rideId/decline',
  validate({ params: z.object({ nightclubId: uuid, rideId: uuid }) }),
  asyncHandler(async (req, res) => {
    const me = await requireDriver(req);
    const { rows } = await pool.query(
      `UPDATE taxi_requests
          SET declined_by = array_append(declined_by, $3::uuid), updated_at = now()
        WHERE id = $1 AND nightclub_id = $2 AND status = 'requested'
          AND NOT ($3::uuid = ANY (declined_by))
        RETURNING id`,
      [req.params.rideId, req.params.nightclubId, me.id]);
    // Declining is idempotent on purpose: pressing twice is not an error.
    res.json({ declined: true, ride_id: req.params.rideId, changed: rows.length > 0 });
  }));

/** assigned -> driver_arrived: "I am at the door". */
router.post('/nightclubs/:nightclubId/taxi/rides/:rideId/arrived',
  validate({ params: z.object({ nightclubId: uuid, rideId: uuid }) }),
  asyncHandler(async (req, res) => {
    const { nightclubId, rideId } = req.params;
    const me = await requireDriver(req);
    const { rows } = await pool.query(
      `UPDATE taxi_requests SET status = 'driver_arrived', arrived_at = now(), updated_at = now()
        WHERE id = $1 AND nightclub_id = $2 AND driver_id = $3 AND status = 'assigned'
        RETURNING id`,
      [rideId, nightclubId, me.id]);
    if (rows.length === 0) throw ApiError.conflict('El viaje no está en estado "asignado"');

    const full = await pool.query(`${RIDE_SELECT} WHERE r.id = $1`, [rideId]);
    const row = full.rows[0];
    await events.publish({
      nightclubId,
      type: 'taxi_driver_arrived',
      audience: { userIds: [row.user_id], roles: ['manager', 'hostess'] },
      payload: {
        ride_id: row.id,
        pickup_location: row.pickup_location,
        vehicle_plate: row.vehicle_plate,
        vehicle_color: row.vehicle_color,
        message: `Tu conductor te espera en ${row.pickup_location}.`,
      },
    });
    res.json({ ride: presentRide(row, 'driver') });
  }));

/**
 * driver_arrived -> in_progress. This is the moment the guest actually leaves, so it
 * is the moment the departure certificate is issued.
 */
router.post('/nightclubs/:nightclubId/taxi/rides/:rideId/start',
  validate({ params: z.object({ nightclubId: uuid, rideId: uuid }) }),
  asyncHandler(async (req, res) => {
    const { nightclubId, rideId } = req.params;
    const me = await requireDriver(req);
    const settings = await taxi.settingsFor(nightclubId);

    let updated = null;
    // A folio collision is astronomically unlikely but cheap to retry, and a duplicate
    // folio would make the verification page ambiguous.
    for (let attempt = 0; attempt < 5 && !updated; attempt += 1) {
      try {
        const { rows } = await pool.query(
          `UPDATE taxi_requests
              SET status = 'in_progress', started_at = now(), updated_at = now(),
                  conduct_code = COALESCE(conduct_code, $4),
                  certificate_issued_at = COALESCE(certificate_issued_at, now()),
                  code_expires_at = COALESCE(code_expires_at, now() + ($5 || ' minutes')::interval)
            WHERE id = $1 AND nightclub_id = $2 AND driver_id = $3 AND status = 'driver_arrived'
            RETURNING id`,
          [rideId, nightclubId, me.id, taxi.generateFolio(), String(settings.certificate_ttl_minutes)]);
        updated = rows;
      } catch (err) {
        if (err.code !== '23505') throw err;
      }
    }
    if (!updated) throw new Error('Could not generate a unique certificate folio');
    if (updated.length === 0) {
      throw ApiError.conflict('El viaje no está en estado "conductor en la salida"');
    }

    const full = await pool.query(`${RIDE_SELECT} WHERE r.id = $1`, [rideId]);
    const row = full.rows[0];
    await events.publish({
      nightclubId,
      type: 'taxi_started',
      audience: { userIds: [row.user_id], roles: ['manager'] },
      payload: { ride_id: row.id, folio: row.conduct_code, expires_at: row.code_expires_at },
    });
    res.json({
      ride: presentRide(row, 'driver'),
      certificate: taxi.certificate({
        ...row,
        guest_short_name: shortName(row.guest_first_name, row.guest_last_name),
        driver_short_name: row.driver_first_name,
      }, { nightclubName: null }),
    });
  }));

/** in_progress -> completed, with the amount actually charged. */
router.post('/nightclubs/:nightclubId/taxi/rides/:rideId/finish',
  validate({
    params: z.object({ nightclubId: uuid, rideId: uuid }),
    body: z.object({
      final_amount: z.number().min(0).max(100000),
      payment_method: z.enum(['cash', 'card', 'courtesy']),
      notes: z.string().trim().max(280).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { nightclubId, rideId } = req.params;
    const b = req.body;
    if (b.payment_method === 'card') {
      throw ApiError.notImplemented('El cobro con tarjeta llega en la fase 3; por ahora, efectivo');
    }
    if (b.payment_method === 'courtesy' && b.final_amount !== 0) {
      throw ApiError.unprocessable('Un viaje de cortesía no lleva monto');
    }
    if (b.payment_method === 'cash' && b.final_amount <= 0) {
      throw ApiError.unprocessable('Captura el monto que cobraste, o marca el viaje como cortesía');
    }
    const me = await requireDriver(req);
    const settings = await taxi.settingsFor(nightclubId);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const current = await client.query(
        `SELECT r.id, r.user_id, r.currency, r.quoted_amount
           FROM taxi_requests r
          WHERE r.id = $1 AND r.nightclub_id = $2 AND r.driver_id = $3 AND r.status = 'in_progress'
          FOR UPDATE`,
        [rideId, nightclubId, me.id]);
      if (current.rowCount === 0) throw ApiError.conflict('El viaje no está en curso');
      const ride = current.rows[0];

      let transactionId = null;
      if (b.payment_method === 'cash') {
        const commission = (Number(settings.club_commission_pct) / 100) * b.final_amount;
        // The guest hands the money to the driver: the club never holds it. The row
        // exists so the ride can be audited, and says so in its metadata.
        const tx = await client.query(
          `INSERT INTO transactions (nightclub_id, type, direction, amount, currency, status,
                                     payer_user_id, payee_user_id, provider, reference_type,
                                     reference_id, metadata, confirmed_by, confirmed_at)
           VALUES ($1,'taxi_ride','in',$2,$3,'paid',$4,$5,'cash','taxi_request',$6,$7,$8,now())
           RETURNING id`,
          [nightclubId, b.final_amount, ride.currency, ride.user_id, me.user_id, ride.id,
            JSON.stringify({
              settled_directly_with_driver: true,
              club_commission_pct: settings.club_commission_pct,
              club_commission_amount: commission.toFixed(2),
              quoted_amount: ride.quoted_amount,
            }), me.user_id]);
        transactionId = tx.rows[0].id;
      }

      await client.query(
        `UPDATE taxi_requests
            SET status = 'completed', ended_at = now(), completed_at = now(),
                final_amount = $4, payment_method = $5, transaction_id = $6,
                notes = COALESCE($7, notes), updated_at = now()
          WHERE id = $1 AND nightclub_id = $2 AND driver_id = $3`,
        [rideId, nightclubId, me.id, b.final_amount, b.payment_method, transactionId,
          b.notes || null]);

      // Back in the pool, but not at the venue: the driver is wherever the ride ended.
      await client.query(
        `UPDATE drivers SET availability = 'available', at_venue = false, updated_at = now()
          WHERE id = $1 AND active AND trusted`, [me.id]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    const full = await pool.query(`${RIDE_SELECT} WHERE r.id = $1`, [rideId]);
    const row = full.rows[0];
    await events.publish({
      nightclubId,
      type: 'taxi_completed',
      audience: { userIds: [row.user_id], roles: ['manager'] },
      payload: {
        ride_id: row.id,
        final_amount: row.final_amount,
        currency: row.currency,
        payment_method: row.payment_method,
      },
    });
    res.json({ ride: presentRide(row, 'driver') });
  }));

// ------------------------------------------------------------------ cancel, rate, certificate

router.post('/nightclubs/:nightclubId/taxi/rides/:rideId/cancel',
  validate({
    params: z.object({ nightclubId: uuid, rideId: uuid }),
    body: z.object({ reason: z.string().trim().max(160).optional() }).default({}),
  }),
  asyncHandler(async (req, res) => {
    const { nightclubId, rideId } = req.params;
    const { row, viewer } = await loadRide(req, rideId);
    if (viewer === 'driver') {
      throw ApiError.forbidden('Un conductor no cancela el viaje; rechaza la solicitud antes de aceptarla');
    }
    if (!CANCELLABLE.includes(row.status)) {
      throw ApiError.conflict(row.status === 'in_progress'
        ? 'El viaje ya comenzó y no se puede cancelar'
        : 'El viaje ya está cerrado');
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE taxi_requests
            SET status = 'cancelled', cancelled_at = now(), cancelled_by = $3,
                cancel_reason = $4, updated_at = now()
          WHERE id = $1 AND nightclub_id = $2`,
        [rideId, nightclubId, req.user.id, req.body.reason || null]);
      if (row.driver_id) {
        await client.query(
          `UPDATE drivers SET availability = 'available', updated_at = now()
            WHERE id = $1 AND availability = 'on_trip'`, [row.driver_id]);
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    await events.publish({
      nightclubId,
      type: 'taxi_cancelled',
      audience: {
        userIds: [row.user_id],
        roles: row.driver_id ? ['driver', 'manager', 'hostess'] : ['manager', 'hostess'],
      },
      payload: { ride_id: rideId, driver_id: row.driver_id, reason: req.body.reason || null },
    });
    const full = await pool.query(`${RIDE_SELECT} WHERE r.id = $1`, [rideId]);
    res.json({ ride: presentRide(full.rows[0], viewer) });
  }));

router.post('/nightclubs/:nightclubId/taxi/rides/:rideId/rate',
  validate({
    params: z.object({ nightclubId: uuid, rideId: uuid }),
    body: z.object({
      rating: z.number().int().min(1).max(5),
      comment: z.string().trim().max(280).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { row, viewer } = await loadRide(req, req.params.rideId);
    if (viewer !== 'guest') throw ApiError.forbidden('Solo quien viajó puede calificar');
    if (row.status !== 'completed') throw ApiError.conflict('Solo se califica un viaje terminado');
    if (row.rating !== null) throw ApiError.conflict('Este viaje ya fue calificado');

    const { rows } = await pool.query(
      `UPDATE taxi_requests SET rating = $2, rating_comment = $3, updated_at = now()
        WHERE id = $1 RETURNING rating, rating_comment`,
      [row.id, req.body.rating, req.body.comment || null]);
    res.json({ rating: rows[0] });
  }));

/** First name plus the initial of the surname: enough to match a person, not to profile one. */
function shortName(firstName, lastName) {
  const initial = (lastName || '').trim().charAt(0);
  return initial ? `${firstName} ${initial.toUpperCase()}.` : firstName;
}

router.get('/nightclubs/:nightclubId/taxi/rides/:rideId/certificate',
  validate({ params: z.object({ nightclubId: uuid, rideId: uuid }) }),
  asyncHandler(async (req, res) => {
    const { row, viewer } = await loadRide(req, req.params.rideId);
    if (viewer === 'driver') throw ApiError.forbidden('La constancia es del pasajero');
    if (!row.conduct_code) throw ApiError.conflict('La constancia se emite cuando comienza el viaje');
    const club = await pool.query('SELECT name FROM nightclubs WHERE id = $1', [req.params.nightclubId]);
    res.json({
      certificate: taxi.certificate({
        ...row,
        guest_short_name: shortName(row.guest_first_name, row.guest_last_name),
        driver_short_name: row.driver_first_name,
      }, { nightclubName: club.rows[0].name }),
    });
  }));

router.get('/nightclubs/:nightclubId/taxi/rides/:rideId',
  validate({ params: z.object({ nightclubId: uuid, rideId: uuid }) }),
  asyncHandler(async (req, res) => {
    const { row, viewer } = await loadRide(req, req.params.rideId);
    res.json({ ride: presentRide(row, viewer) });
  }));

// ------------------------------------------------------------------ manager: board and numbers

router.get('/nightclubs/:nightclubId/taxi/rides',
  requireRole('manager'),
  validate({
    params: z.object({ nightclubId: uuid }),
    query: pagination.extend({
      status: z.enum(['requested', 'assigned', 'driver_arrived', 'in_progress',
        'completed', 'cancelled', 'no_driver']).optional(),
      driver_id: uuid.optional(),
      live: z.coerce.boolean().default(false),
    }),
  }),
  asyncHandler(async (req, res) => {
    const q = req.query;
    const { rows } = await pool.query(
      `${RIDE_SELECT}
        WHERE r.nightclub_id = $1
          AND ($2::text IS NULL OR r.status = $2)
          AND ($3::uuid IS NULL OR r.driver_id = $3)
          AND (NOT $4::boolean OR r.status = ANY($5::text[]))
        ORDER BY r.created_at DESC LIMIT $6 OFFSET $7`,
      [req.params.nightclubId, q.status || null, q.driver_id || null, q.live, LIVE,
        q.limit, q.offset]);
    res.json({ rides: rows.map((r) => presentRide(r, 'manager')) });
  }));

router.get('/nightclubs/:nightclubId/taxi/stats',
  requireRole('manager'),
  validate({
    params: z.object({ nightclubId: uuid }),
    query: z.object({
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { nightclubId } = req.params;
    const { from, to } = req.query;
    const [totals, byDriver] = await Promise.all([
      pool.query(
        `SELECT count(*)::int AS rides,
                count(*) FILTER (WHERE status = 'completed')::int AS completed,
                count(*) FILTER (WHERE status = 'cancelled')::int AS cancelled,
                count(*) FILTER (WHERE status = 'no_driver')::int AS without_driver,
                count(*) FILTER (WHERE payment_method = 'cash')::int AS paid_cash,
                count(*) FILTER (WHERE payment_method = 'courtesy')::int AS courtesy,
                COALESCE(sum(final_amount), 0)::numeric(12,2)::text AS charged,
                ROUND(AVG(EXTRACT(EPOCH FROM (arrived_at - accepted_at)) / 60))::int AS avg_pickup_minutes
           FROM taxi_requests
          WHERE nightclub_id = $1
            AND ($2::date IS NULL OR created_at >= $2::date)
            AND ($3::date IS NULL OR created_at < ($3::date + interval '1 day'))`,
        [nightclubId, from || null, to || null]),
      pool.query(
        `SELECT d.id AS driver_id, u.display_name, d.vehicle_plate, d.trusted, d.active,
                count(r.id) FILTER (WHERE r.status = 'completed')::int AS rides,
                count(r.id) FILTER (WHERE r.status = 'cancelled')::int AS cancelled,
                COALESCE(sum(r.final_amount), 0)::numeric(12,2)::text AS charged,
                ROUND(AVG(r.rating), 2)::text AS rating_avg,
                ROUND(AVG(EXTRACT(EPOCH FROM (r.arrived_at - r.accepted_at)) / 60))::int
                  AS avg_pickup_minutes
           FROM drivers d
           JOIN users u ON u.id = d.user_id
           LEFT JOIN taxi_requests r ON r.driver_id = d.id
            AND ($2::date IS NULL OR r.created_at >= $2::date)
            AND ($3::date IS NULL OR r.created_at < ($3::date + interval '1 day'))
          WHERE d.nightclub_id = $1
          GROUP BY d.id, u.display_name, d.vehicle_plate, d.trusted, d.active
          ORDER BY rides DESC, u.display_name`,
        [nightclubId, from || null, to || null]),
    ]);
    res.json({ totals: totals.rows[0], drivers: byDriver.rows });
  }));

/**
 * Closes requests nobody accepted within the club's timeout. Called by the staff screen
 * (and, from phase 7, by a scheduled job); idempotent.
 */
router.post('/nightclubs/:nightclubId/taxi/rides/expire',
  requireRole('manager', 'hostess'),
  validate({ params: z.object({ nightclubId: uuid }) }),
  asyncHandler(async (req, res) => {
    const settings = await taxi.settingsFor(req.params.nightclubId);
    const { rows } = await pool.query(
      `UPDATE taxi_requests
          SET status = 'no_driver', cancel_reason = 'Nadie aceptó la solicitud a tiempo',
              cancelled_at = now(), updated_at = now()
        WHERE nightclub_id = $1 AND status = 'requested'
          AND created_at < now() - ($2 || ' minutes')::interval
        RETURNING id, user_id`,
      [req.params.nightclubId, String(settings.request_timeout_minutes)]);
    for (const r of rows) {
      await events.publish({
        nightclubId: req.params.nightclubId,
        type: 'taxi_no_driver',
        audience: { userIds: [r.user_id], roles: ['manager', 'hostess'] },
        payload: { ride_id: r.id },
      });
    }
    res.json({ expired: rows.length, ride_ids: rows.map((r) => r.id) });
  }));

// ------------------------------------------------------------------ public verification

// Deliberately outside authentication: the point of a folio is that whoever holds the
// printed certificate can check it. It answers with the minimum that makes the check
// meaningful — never the destination, the amount, the phone or the full name.
const verifyLimiter = rateLimit({
  windowMs: 60_000,
  limit: Number(process.env.TAXI_VERIFY_RATE_LIMIT_PER_MIN || 20),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (req, res, next) => next(ApiError.tooMany()),
});

router.get('/taxi/verify/:folio', verifyLimiter,
  validate({ params: z.object({ folio: z.string().trim().min(4).max(20) }) }),
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT r.conduct_code, r.certificate_issued_at, r.code_expires_at, r.status,
              n.name AS nightclub_name,
              gu.first_name AS guest_first_name, gu.last_name AS guest_last_name,
              du.first_name AS driver_first_name,
              d.vehicle_plate, d.vehicle_color, d.vehicle_make, d.vehicle_model
         FROM taxi_requests r
         JOIN nightclubs n ON n.id = r.nightclub_id
         JOIN users gu ON gu.id = r.user_id
         LEFT JOIN drivers d ON d.id = r.driver_id
         LEFT JOIN users du ON du.id = d.user_id
        WHERE r.conduct_code = $1`,
      [taxi.normalizeFolio(req.params.folio)]);
    if (rows.length === 0) {
      return res.status(404).json({
        error: {
          code: 'not_found',
          message: 'No existe una constancia con ese folio.',
        },
      });
    }
    const row = rows[0];
    return res.json({
      certificate: taxi.certificate({
        ...row,
        guest_short_name: shortName(row.guest_first_name, row.guest_last_name),
        driver_short_name: row.driver_first_name,
      }, { nightclubName: row.nightclub_name }),
    });
  }));

module.exports = router;

