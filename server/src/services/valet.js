// Valet helpers: club settings, the ticket's two identifiers and the numbers the
// manager looks at (docs/DECISIONES.md D22).
//
// A ticket carries two different things on purpose:
//   * `code` — short, printed big, read aloud ("ticket V-7K2M"). It identifies the
//     ticket in conversation and it is NOT a secret;
//   * `qr_token` — 48 hex characters behind the QR. It is the only thing that
//     releases a car, precisely because nobody can read it across the counter or
//     guess the next one.
'use strict';

const crypto = require('crypto');
const { pool } = require('../db/pool');

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const OPEN_STATUSES = ['parked', 'requested', 'ready'];

/** Per-club settings, created with safe defaults the first time they are needed. */
async function settingsFor(nightclubId, runner = pool) {
  const { rows } = await runner.query(
    `INSERT INTO valet_settings (nightclub_id) VALUES ($1)
     ON CONFLICT (nightclub_id) DO UPDATE SET nightclub_id = EXCLUDED.nightclub_id
     RETURNING nightclub_id, enabled, handover_point, fee_amount::text, currency, terms, updated_at`,
    [nightclubId],
  );
  return rows[0];
}

/** V-XXXX: short enough to shout across the valet stand. Never a secret. */
function generateCode() {
  const bytes = crypto.randomBytes(4);
  return `V-${Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('')}`;
}

/** The secret behind the QR. 24 random bytes: not guessable, not enumerable. */
function generateQrToken() {
  return crypto.randomBytes(24).toString('hex');
}

/**
 * Compares a scanned token against the stored one in constant time, so that a
 * response cannot be timed character by character.
 */
function tokenMatches(scanned, stored) {
  if (typeof scanned !== 'string' || typeof stored !== 'string') return false;
  const a = Buffer.from(scanned);
  const b = Buffer.from(stored);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

async function stats(nightclubId, { from, to, runner = pool } = {}) {
  const [totals, byValet] = await Promise.all([
    runner.query(
      `SELECT count(*)::int AS tickets,
              count(*) FILTER (WHERE status = ANY($4::text[]))::int AS open,
              count(*) FILTER (WHERE status = 'delivered')::int AS delivered,
              count(*) FILTER (WHERE status = 'cancelled')::int AS cancelled,
              count(*) FILTER (WHERE override_by IS NOT NULL)::int AS handed_over_without_qr,
              ROUND(AVG(EXTRACT(EPOCH FROM (ready_at - requested_at)) / 60))::int
                AS avg_retrieval_minutes,
              ROUND(AVG(rating), 2)::text AS rating_avg
         FROM valet_tickets
        WHERE nightclub_id = $1
          AND ($2::date IS NULL OR created_at >= $2::date)
          AND ($3::date IS NULL OR created_at < ($3::date + interval '1 day'))`,
      [nightclubId, from || null, to || null, OPEN_STATUSES]),
    runner.query(
      `SELECT u.id AS user_id, u.display_name,
              count(t.id)::int AS received,
              count(d.id)::int AS delivered,
              ROUND(AVG(d.rating), 2)::text AS rating_avg,
              ROUND(AVG(EXTRACT(EPOCH FROM (d.ready_at - d.requested_at)) / 60))::int
                AS avg_retrieval_minutes
         FROM users u
         LEFT JOIN valet_tickets t ON t.valet_in_id = u.id
          AND ($2::date IS NULL OR t.created_at >= $2::date)
          AND ($3::date IS NULL OR t.created_at < ($3::date + interval '1 day'))
         LEFT JOIN valet_tickets d ON d.valet_out_id = u.id
          AND ($2::date IS NULL OR d.created_at >= $2::date)
          AND ($3::date IS NULL OR d.created_at < ($3::date + interval '1 day'))
        WHERE u.nightclub_id = $1 AND u.role = 'valet'
        GROUP BY u.id, u.display_name
        ORDER BY delivered DESC, u.display_name`,
      [nightclubId, from || null, to || null]),
  ]);
  return { totals: totals.rows[0], valets: byValet.rows };
}

/** Occupancy of the lot right now, for the valet stand screen. */
async function occupancy(nightclubId, runner = pool) {
  const { rows } = await runner.query(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE t.id IS NOT NULL)::int AS occupied
       FROM parking_spots s
       LEFT JOIN valet_tickets t ON t.spot_id = s.id AND t.status = ANY($2::text[])
      WHERE s.nightclub_id = $1 AND s.active`,
    [nightclubId, OPEN_STATUSES]);
  const { total, occupied } = rows[0];
  return { total, occupied, free: total - occupied };
}

module.exports = {
  settingsFor, generateCode, generateQrToken, tokenMatches, stats, occupancy, OPEN_STATUSES,
};
