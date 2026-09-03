// Domain events. For now they are persisted to the `events` table so clients can
// catch up via GET /events/since/:id. Redis pub/sub fan-out is added in step 3.2.
'use strict';

const { pool } = require('../db/pool');

/**
 * @param {object} opts
 * @param {string} opts.nightclubId
 * @param {string} opts.type       e.g. 'order_created'
 * @param {object} [opts.audience] { roles?: string[], userIds?: string[], tableIds?: string[] }
 * @param {object} [opts.payload]
 * @param {object} [opts.client]   optional pg client to publish inside a transaction
 */
async function publish({ nightclubId, type, audience = {}, payload = {}, client }) {
  const runner = client || pool;
  const { rows } = await runner.query(
    `INSERT INTO events (nightclub_id, type, audience, payload) VALUES ($1,$2,$3,$4) RETURNING id, created_at`,
    [nightclubId, type, JSON.stringify(audience), JSON.stringify(payload)],
  );
  return rows[0];
}

async function since({ nightclubId, sinceId, limit = 200 }) {
  const { rows } = await pool.query(
    `SELECT id, type, audience, payload, created_at
       FROM events
      WHERE nightclub_id = $1 AND id > $2 AND created_at > now() - interval '24 hours'
      ORDER BY id ASC LIMIT $3`,
    [nightclubId, sinceId, limit],
  );
  return rows;
}

// Returns true when the event is meant for this user (used by the WS server in phase 3).
function matchesAudience(audience, user) {
  if (!audience || Object.keys(audience).length === 0) return true;
  if (Array.isArray(audience.userIds) && audience.userIds.includes(user.id)) return true;
  if (Array.isArray(audience.roles) && audience.roles.includes(user.role)) return true;
  return false;
}

module.exports = { publish, since, matchesAudience };
