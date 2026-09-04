// POS integration registry (docs/DECISIONES.md D24).
//
// The API never holds the club's SQL Server credentials: with the local agent (D16)
// the read-only database user lives on the club's own server. What the API knows is
// the SHA-256 of the agent's key, which is enough to recognise the agent and nothing
// else — a copy of this database does not let anyone into the POS.
'use strict';

const crypto = require('crypto');
const { pool } = require('../../db/pool');

const PROVIDERS = ['softrestaurant11', 'mock'];
const MODES = ['agent', 'api', 'mock'];
const SYNC_KINDS = ['menu', 'inventory', 'orders', 'status', 'tables'];

/** `ev2agent_` + 32 random bytes. Shown to the manager once, stored only as a hash. */
function generateAgentKey() {
  return `ev2agent_${crypto.randomBytes(32).toString('base64url')}`;
}

function hashAgentKey(key) {
  return crypto.createHash('sha256').update(key).digest('hex');
}

/**
 * What the club is told about the integration's health. `enabled` is the club's
 * intention; this is what is actually happening.
 */
function health(row, now = new Date()) {
  if (!row.agent_key_hash && row.mode === 'agent') {
    return { state: 'not_enrolled', message: 'Falta generar la llave del agente.' };
  }
  if (!row.last_seen_at) {
    return { state: 'never_seen', message: 'El agente todavía no se ha reportado.' };
  }
  const secondsSince = Math.round((now - new Date(row.last_seen_at)) / 1000);
  if (secondsSince > row.stale_after_seconds) {
    return {
      state: 'stale',
      seconds_since_last_seen: secondsSince,
      message: `El agente lleva ${Math.round(secondsSince / 60)} min sin reportarse.`,
    };
  }
  if (row.status === 'error') {
    return { state: 'error', seconds_since_last_seen: secondsSince, message: row.last_error };
  }
  return { state: 'ok', seconds_since_last_seen: secondsSince, message: 'El agente está en línea.' };
}

/** Never returns the key hash or anything derived from it. */
function present(row, { includeHealth = true } = {}) {
  const base = {
    id: row.id,
    nightclub_id: row.nightclub_id,
    provider: row.provider,
    mode: row.mode,
    enabled: row.enabled,
    status: row.status,
    config: row.config,
    enrolled: Boolean(row.agent_key_hash),
    agent_version: row.agent_version,
    agent_hostname: row.agent_hostname,
    heartbeat_interval_seconds: row.heartbeat_interval_seconds,
    stale_after_seconds: row.stale_after_seconds,
    last_seen_at: row.last_seen_at,
    last_error: row.last_error,
    key_rotated_at: row.key_rotated_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
  return includeHealth ? { ...base, health: health(row) } : base;
}

/** Resolves an incoming agent request to its integration, or null. */
async function findByAgentKey(key, runner = pool) {
  if (typeof key !== 'string' || key.length < 20) return null;
  const { rows } = await runner.query(
    `SELECT * FROM pos_integrations WHERE agent_key_hash = $1`, [hashAgentKey(key)]);
  return rows[0] || null;
}

module.exports = {
  PROVIDERS, MODES, SYNC_KINDS,
  generateAgentKey, hashAgentKey, findByAgentKey, health, present,
};
