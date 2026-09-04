// Safe departure helpers: club settings, arrival-time estimates, fare quoting and
// the departure certificate (docs/DECISIONES.md D21).
//
// There is no GPS in this phase. An estimate is either the driver's own declaration
// ("I am 10 minutes away"), or zero when the driver is already parked at the exit.
// The historical average is computed from the rides themselves and only ever shown
// as a reference, never presented to the guest as a live ETA.
'use strict';

const crypto = require('crypto');
const { pool } = require('../db/pool');

// Ambiguous characters (0/O, 1/I/L) are out: the folio is read aloud and typed by hand.
const FOLIO_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const FOLIO_PREFIX = 'EV2';
const LIVE_STATUSES = ['requested', 'assigned', 'driver_arrived', 'in_progress'];
const ETA_CHOICES = [0, 5, 10, 15, 20, 30, 45];

/** Per-club settings, created with safe defaults the first time they are needed. */
async function settingsFor(nightclubId, runner = pool) {
  const { rows } = await runner.query(
    `INSERT INTO taxi_settings (nightclub_id) VALUES ($1)
     ON CONFLICT (nightclub_id) DO UPDATE SET nightclub_id = EXCLUDED.nightclub_id
     RETURNING nightclub_id, enabled, pickup_point, currency, certificate_ttl_minutes,
               request_timeout_minutes, club_commission_pct::text, conduct_terms, updated_at`,
    [nightclubId],
  );
  return rows[0];
}

/**
 * Average minutes between accepting a ride and reaching the door, per driver, from
 * the last `sample` completed pickups. Null while a driver has no history.
 */
async function pickupAverages(nightclubId, { sample = 10, runner = pool } = {}) {
  const { rows } = await runner.query(
    `WITH recent AS (
       SELECT driver_id,
              EXTRACT(EPOCH FROM (arrived_at - accepted_at)) / 60 AS minutes,
              ROW_NUMBER() OVER (PARTITION BY driver_id ORDER BY arrived_at DESC) AS rn
         FROM taxi_requests
        WHERE nightclub_id = $1 AND driver_id IS NOT NULL
          AND accepted_at IS NOT NULL AND arrived_at IS NOT NULL
     )
     SELECT driver_id, ROUND(AVG(minutes))::int AS avg_pickup_minutes, COUNT(*)::int AS sample_size
       FROM recent WHERE rn <= $2 GROUP BY driver_id`,
    [nightclubId, sample],
  );
  return new Map(rows.map((r) => [r.driver_id, r]));
}

/**
 * What the guest is told before requesting: how many trusted drivers are free, whether
 * one is already waiting at the exit, and the best estimate available.
 */
async function availability(nightclubId, runner = pool) {
  const { rows } = await runner.query(
    `SELECT d.id, d.at_venue, d.available_since
       FROM drivers d
      WHERE d.nightclub_id = $1 AND d.active AND d.trusted AND d.availability = 'available'`,
    [nightclubId],
  );
  const averages = await pickupAverages(nightclubId, { runner });
  const atVenue = rows.filter((d) => d.at_venue);
  const estimates = rows
    .map((d) => (d.at_venue ? 0 : averages.get(d.id)?.avg_pickup_minutes))
    .filter((m) => Number.isInteger(m));

  return {
    available_drivers: rows.length,
    drivers_at_venue: atVenue.length,
    // Only true when someone is physically parked at the exit right now.
    wait_at_exit: atVenue.length > 0,
    estimated_wait_minutes: estimates.length > 0 ? Math.min(...estimates) : null,
    message: rows.length === 0
      ? 'No hay conductores disponibles en este momento. Puedes solicitar y te avisamos en cuanto uno acepte.'
      : atVenue.length > 0
        ? 'Hay un conductor esperando en la salida. Solicita y baja a la salida.'
        : 'Hay conductores disponibles. Al aceptar tu solicitud verás en cuántos minutos llega.',
  };
}

/**
 * Resolves what the ride is expected to cost. The zone price list is the club's; a
 * destination outside it is quoted as null ("a convenir con el conductor") instead of
 * inventing a number.
 */
async function quote({ nightclubId, fareId, runner = pool }) {
  const settings = await settingsFor(nightclubId, runner);
  if (!fareId) {
    return { fare_id: null, zone: null, quoted_amount: null, currency: settings.currency };
  }
  const { rows } = await runner.query(
    `SELECT id, zone, amount::text, currency FROM taxi_fares
      WHERE id = $1 AND nightclub_id = $2 AND active`,
    [fareId, nightclubId],
  );
  if (rows.length === 0) return null;
  return {
    fare_id: rows[0].id,
    zone: rows[0].zone,
    quoted_amount: rows[0].amount,
    currency: rows[0].currency,
  };
}

/** EV2-XXXX-XXXX — 8 random characters out of 31, checked for collision on insert. */
function generateFolio() {
  const bytes = crypto.randomBytes(8);
  const chars = Array.from(bytes, (b) => FOLIO_ALPHABET[b % FOLIO_ALPHABET.length]);
  return `${FOLIO_PREFIX}-${chars.slice(0, 4).join('')}-${chars.slice(4).join('')}`;
}

function normalizeFolio(input) {
  return String(input || '').trim().toUpperCase();
}

/**
 * The certificate says only what the club can attest to: this guest left this club at
 * this time, in a ride the club coordinated. It carries no legal effect and never
 * claims any — saying otherwise would expose the club and mislead the guest.
 */
const CERTIFICATE_DISCLAIMER = 'Esta constancia solo acredita que la persona salió del '
  + 'establecimiento a la hora indicada en un viaje coordinado por el club. No sustituye '
  + 'ninguna identificación oficial ni otorga permiso, autorización o efecto legal alguno.';

function certificate(row, { nightclubName }) {
  const expiresAt = row.code_expires_at ? new Date(row.code_expires_at) : null;
  return {
    folio: row.conduct_code,
    nightclub: nightclubName,
    issued_at: row.certificate_issued_at,
    expires_at: row.code_expires_at,
    valid: Boolean(expiresAt && expiresAt > new Date()),
    guest: row.guest_short_name,
    driver: row.driver_short_name,
    vehicle: row.vehicle_plate
      ? {
        plate: row.vehicle_plate,
        color: row.vehicle_color,
        description: [row.vehicle_make, row.vehicle_model].filter(Boolean).join(' ') || null,
      }
      : null,
    disclaimer: CERTIFICATE_DISCLAIMER,
  };
}

module.exports = {
  settingsFor, pickupAverages, availability, quote,
  generateFolio, normalizeFolio, certificate,
  LIVE_STATUSES, ETA_CHOICES, CERTIFICATE_DISCLAIMER,
};
