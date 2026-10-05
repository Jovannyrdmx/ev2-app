// Departure certificate without a taxi (D85).
//
// On foot: the guest asks, the hostess confirms, and only then is the folio born —
// the club vouches only for what its own staff saw. With valet: delivering the car
// with the ticket QR issues it directly. Rows only move forward (migration 043).
'use strict';

const { ApiError } = require('../middleware/errors');
const taxi = require('./taxi');

const SELECT = `
  SELECT g.id, g.nightclub_id, g.user_id, g.mode, g.status, g.valet_ticket_id,
         g.vehicle_plate, g.vehicle_desc, g.folio, g.requested_at, g.confirmed_at,
         g.expires_at, g.canceled_at, g.cancel_reason,
         u.first_name AS guest_first_name, u.last_name AS guest_last_name,
         u.display_name AS guest_display_name,
         cb.display_name AS confirmed_by_name
    FROM guest_departures g
    JOIN users u ON u.id = g.user_id
    LEFT JOIN users cb ON cb.id = g.confirmed_by`;

/** First name plus the initial of the surname: enough to match a person at the door. */
function shortName(row) {
  const first = (row.guest_first_name || row.guest_display_name || '').trim();
  const initial = (row.guest_last_name || '').trim().charAt(0);
  return initial ? `${first} ${initial.toUpperCase()}.` : first;
}

/** What the API returns for a departure. The hostess name is only for the manager. */
function present(row, { manager = false } = {}) {
  if (!row) return null;
  return {
    id: row.id,
    mode: row.mode,
    status: row.status,
    guest: shortName(row),
    vehicle_plate: row.vehicle_plate,
    folio: row.folio,
    requested_at: row.requested_at,
    confirmed_at: row.confirmed_at,
    expires_at: row.expires_at,
    canceled_at: row.canceled_at,
    cancel_reason: row.cancel_reason,
    ...(manager ? { confirmed_by_name: row.confirmed_by_name } : {}),
  };
}

function certificate(row, nightclubName) {
  return taxi.departureCertificate({ ...row, guest_short_name: shortName(row) }, { nightclubName });
}

async function get(runner, { nightclubId, id, lock = false }) {
  const { rows } = await runner.query(
    `${SELECT} WHERE g.id = $1 AND g.nightclub_id = $2${lock ? ' FOR UPDATE OF g' : ''}`,
    [id, nightclubId]);
  return rows[0] || null;
}

/**
 * A request nobody confirmed in time is closed, so the door list never fills up with
 * people who left hours ago. The window is the club's own taxi request timeout.
 */
async function expireOld(runner, { nightclubId }) {
  const settings = await taxi.settingsFor(nightclubId, runner);
  await runner.query(
    `UPDATE guest_departures
        SET status = 'canceled', canceled_at = now(), cancel_reason = 'expired'
      WHERE nightclub_id = $1 AND status = 'requested'
        AND requested_at < now() - ($2::text || ' minutes')::interval`,
    [nightclubId, String(settings.request_timeout_minutes)]);
}

/** The open requests the hostess sees, oldest first: whoever has waited longest. */
async function pending(runner, { nightclubId }) {
  await expireOld(runner, { nightclubId });
  const { rows } = await runner.query(
    `${SELECT} WHERE g.nightclub_id = $1 AND g.status = 'requested' ORDER BY g.requested_at, g.id`,
    [nightclubId]);
  return rows;
}

/**
 * The guest's current departure: the open request, or else the latest certificate
 * that is still valid. Null when there is neither.
 */
async function currentFor(runner, { nightclubId, userId }) {
  await expireOld(runner, { nightclubId });
  const { rows } = await runner.query(
    `${SELECT}
      WHERE g.nightclub_id = $1 AND g.user_id = $2
        AND (g.status = 'requested' OR (g.status = 'confirmed' AND g.expires_at > now()))
      ORDER BY (g.status = 'requested') DESC, g.confirmed_at DESC NULLS LAST, g.id
      LIMIT 1`,
    [nightclubId, userId]);
  return rows[0] || null;
}

/** Opens a request, or returns the one already open (tapping twice is one request). */
async function request(client, { nightclubId, userId }) {
  await expireOld(client, { nightclubId });
  const inserted = await client.query(
    `INSERT INTO guest_departures (nightclub_id, user_id, mode)
     VALUES ($1, $2, 'on_foot')
     ON CONFLICT (nightclub_id, user_id) WHERE status = 'requested' DO NOTHING
     RETURNING id`,
    [nightclubId, userId]);
  if (inserted.rowCount > 0) {
    return { row: await get(client, { nightclubId, id: inserted.rows[0].id }), created: true };
  }
  const { rows } = await client.query(
    `${SELECT} WHERE g.nightclub_id = $1 AND g.user_id = $2 AND g.status = 'requested'`,
    [nightclubId, userId]);
  return { row: rows[0], created: false };
}

/**
 * A folio that exists in neither table. The alphabet and format are the ride's, so
 * one public page verifies both; a collision is astronomically unlikely but cheap to
 * rule out, and a duplicate would make that page ambiguous.
 */
async function freshFolio(client) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const folio = taxi.generateFolio();
    const { rowCount } = await client.query(
      `SELECT 1 FROM taxi_requests WHERE conduct_code = $1
       UNION ALL SELECT 1 FROM guest_departures WHERE folio = $1`, [folio]);
    if (rowCount === 0) return folio;
  }
  throw new Error('Could not generate a unique certificate folio');
}

/** The hostess saw the guest walk out: requested -> confirmed, and the folio is born. */
async function confirm(client, { nightclubId, id, staffId }) {
  const row = await get(client, { nightclubId, id, lock: true });
  if (!row) throw ApiError.notFound('Salida no encontrada');
  if (row.status !== 'requested') throw ApiError.conflict('Esa salida ya no está pendiente');
  const settings = await taxi.settingsFor(nightclubId, client);
  await client.query(
    `UPDATE guest_departures
        SET status = 'confirmed', folio = $2, confirmed_at = now(), confirmed_by = $3,
            expires_at = now() + ($4::text || ' minutes')::interval
      WHERE id = $1`,
    [id, await freshFolio(client), staffId, String(settings.certificate_ttl_minutes)]);
  return get(client, { nightclubId, id });
}

/** Only the guest cancels their own open request. */
async function cancel(client, { nightclubId, id, userId }) {
  const row = await get(client, { nightclubId, id, lock: true });
  if (!row || row.user_id !== userId) throw ApiError.notFound('Salida no encontrada');
  if (row.status !== 'requested') throw ApiError.conflict('Esa salida ya no está pendiente');
  await client.query(
    `UPDATE guest_departures SET status = 'canceled', canceled_at = now(), cancel_reason = 'guest'
      WHERE id = $1`, [id]);
  return get(client, { nightclubId, id });
}

/**
 * The valet handed the car over (the ticket QR matched): the certificate is issued
 * right there, with the plate. An open on-foot request from the same guest is closed
 * as superseded — they left with their car, not walking.
 */
async function issueForValet(client, { nightclubId, ticket, staffId }) {
  if (!ticket.user_id) return null;
  await client.query(
    `UPDATE guest_departures
        SET status = 'canceled', canceled_at = now(), cancel_reason = 'superseded'
      WHERE nightclub_id = $1 AND user_id = $2 AND status = 'requested'`,
    [nightclubId, ticket.user_id]);
  const settings = await taxi.settingsFor(nightclubId, client);
  const { rows } = await client.query(
    `INSERT INTO guest_departures (nightclub_id, user_id, mode, status, valet_ticket_id,
                                   vehicle_plate, vehicle_desc, folio, confirmed_at,
                                   confirmed_by, expires_at)
     VALUES ($1, $2, 'valet', 'confirmed', $3, $4, $5, $6, now(), $7,
             now() + ($8::text || ' minutes')::interval)
     RETURNING id`,
    [nightclubId, ticket.user_id, ticket.id, ticket.plate || null, ticket.vehicle_desc || null,
      await freshFolio(client), staffId, String(settings.certificate_ttl_minutes)]);
  return get(client, { nightclubId, id: rows[0].id });
}

/** For the public verification page: the certificate behind a folio, or null. */
async function byFolio(runner, folio) {
  const { rows } = await runner.query(
    `SELECT d.*, n.name AS nightclub_name
       FROM (${SELECT} WHERE g.folio = $1) d
       JOIN nightclubs n ON n.id = d.nightclub_id`, [folio]);
  return rows[0] || null;
}

module.exports = {
  shortName, present, certificate, get, pending, currentFor, request, confirm, cancel,
  issueForValet, byFolio, expireOld,
};
