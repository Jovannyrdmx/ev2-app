// POS integration registry and agent enrolment (docs/DECISIONES.md D24).
//
// This step does not read a single row from SoftRestaurant. It gives the club one
// place to declare the integration, hands the local agent a key of its own, and shows
// whether that agent is alive and what it has been doing. The actual synchronisation
// lands in phase 4, against the mechanism National Soft confirms (docs/POS_REAL.md).
//
//   * no SQL Server credentials live here: with the local agent (D16) the read-only
//     database user stays on the club's server. The API only keeps the SHA-256 of the
//     agent's key, so a copy of this database is not a way into the POS;
//   * the key is shown once, when it is created or rotated, and never again;
//   * the agent authenticates with `X-Agent-Key`, not with a user session: it is a
//     machine, it has no person behind it and it must not inherit anyone's permissions.
'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const { pool } = require('../db/pool');
const { ApiError, asyncHandler } = require('../middleware/errors');
const { validate, z, uuid, pagination } = require('../middleware/validate');
const { authenticate, requireRole, sameNightclub } = require('../middleware/auth');
const registry = require('../services/pos/registry');

const router = express.Router({ mergeParams: true });

// Only names, never secrets: which server, which instance, which database. The agent
// reads them to know what to open locally; none of them grants access by itself.
const agentConfig = z.object({
  sql_server_host: z.string().trim().max(120).optional(),
  sql_instance: z.string().trim().max(60).optional(),
  sql_database: z.string().trim().max(60).optional(),
  sync_menu: z.boolean().optional(),
  sync_inventory: z.boolean().optional(),
  sync_tables: z.boolean().optional(),
  sync_orders: z.boolean().optional(),
  notes: z.string().trim().max(500).optional(),
}).strict();

// ------------------------------------------------------------------ manager: registry

router.use('/nightclubs/:nightclubId', authenticate, sameNightclub());

router.get('/nightclubs/:nightclubId/pos-integrations',
  requireRole('manager'),
  validate({ params: z.object({ nightclubId: uuid }) }),
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(
      'SELECT * FROM pos_integrations WHERE nightclub_id = $1 ORDER BY provider',
      [req.params.nightclubId]);
    res.json({ integrations: rows.map((r) => registry.present(r)) });
  }));

router.post('/nightclubs/:nightclubId/pos-integrations',
  requireRole('manager'),
  validate({
    params: z.object({ nightclubId: uuid }),
    body: z.object({
      provider: z.enum(registry.PROVIDERS).default('softrestaurant11'),
      mode: z.enum(registry.MODES).default('agent'),
      config: agentConfig.default({}),
      heartbeat_interval_seconds: z.number().int().min(15).max(3600).optional(),
      stale_after_seconds: z.number().int().min(60).max(86400).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { nightclubId } = req.params;
    const b = req.body;
    // Only the agent needs a key; the other modes have nothing to enrol.
    const key = b.mode === 'agent' ? registry.generateAgentKey() : null;
    let created;
    try {
      const { rows } = await pool.query(
        `INSERT INTO pos_integrations (nightclub_id, provider, mode, config, agent_key_hash,
                                       heartbeat_interval_seconds, stale_after_seconds, created_by,
                                       key_rotated_at, key_rotated_by)
         VALUES ($1,$2,$3,$4,$5,COALESCE($6,60),COALESCE($7,300),$8,
                 CASE WHEN $5::text IS NOT NULL THEN now() END,
                 CASE WHEN $5::text IS NOT NULL THEN $8::uuid END)
         RETURNING *`,
        [nightclubId, b.provider, b.mode, JSON.stringify(b.config),
          key ? registry.hashAgentKey(key) : null,
          b.heartbeat_interval_seconds ?? null, b.stale_after_seconds ?? null, req.user.id]);
      created = rows[0];
    } catch (err) {
      if (err.code === '23505') {
        throw ApiError.conflict('Ya existe una integración con ese proveedor para este club');
      }
      throw err;
    }
    // The key travels exactly once, here. Only its hash is stored.
    res.status(201).json({
      integration: registry.present(created),
      ...(key ? { agent_key: key } : {}),
    });
  }));

router.get('/nightclubs/:nightclubId/pos-integrations/:integrationId',
  requireRole('manager'),
  validate({ params: z.object({ nightclubId: uuid, integrationId: uuid }) }),
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(
      'SELECT * FROM pos_integrations WHERE id = $1 AND nightclub_id = $2',
      [req.params.integrationId, req.params.nightclubId]);
    if (rows.length === 0) throw ApiError.notFound('Integración no encontrada');
    res.json({ integration: registry.present(rows[0]) });
  }));

router.patch('/nightclubs/:nightclubId/pos-integrations/:integrationId',
  requireRole('manager'),
  validate({
    params: z.object({ nightclubId: uuid, integrationId: uuid }),
    body: z.object({
      mode: z.enum(registry.MODES).optional(),
      config: agentConfig.optional(),
      enabled: z.boolean().optional(),
      heartbeat_interval_seconds: z.number().int().min(15).max(3600).optional(),
      stale_after_seconds: z.number().int().min(60).max(86400).optional(),
    }).refine((b) => Object.keys(b).length > 0, { message: 'No fields to update' }),
  }),
  asyncHandler(async (req, res) => {
    const { nightclubId, integrationId } = req.params;
    const b = req.body;
    const current = await pool.query(
      'SELECT * FROM pos_integrations WHERE id = $1 AND nightclub_id = $2',
      [integrationId, nightclubId]);
    if (current.rowCount === 0) throw ApiError.notFound('Integración no encontrada');

    // Turning it on with nobody enrolled would show a green light over nothing.
    const mode = b.mode || current.rows[0].mode;
    if (b.enabled === true && mode === 'agent' && !current.rows[0].agent_key_hash) {
      throw ApiError.unprocessable('Genera primero la llave del agente');
    }
    const { rows } = await pool.query(
      `UPDATE pos_integrations SET
         mode = COALESCE($3, mode),
         config = COALESCE($4::jsonb, config),
         enabled = COALESCE($5, enabled),
         heartbeat_interval_seconds = COALESCE($6, heartbeat_interval_seconds),
         stale_after_seconds = COALESCE($7, stale_after_seconds),
         updated_at = now()
       WHERE id = $1 AND nightclub_id = $2
       RETURNING *`,
      [integrationId, nightclubId, b.mode ?? null, b.config ? JSON.stringify(b.config) : null,
        b.enabled ?? null, b.heartbeat_interval_seconds ?? null, b.stale_after_seconds ?? null]);
    res.json({ integration: registry.present(rows[0]) });
  }));

/**
 * Rotating invalidates the previous key immediately: an agent still holding it stops
 * being recognised, which is exactly what rotation is for.
 */
router.post('/nightclubs/:nightclubId/pos-integrations/:integrationId/rotate-key',
  requireRole('manager'),
  validate({ params: z.object({ nightclubId: uuid, integrationId: uuid }) }),
  asyncHandler(async (req, res) => {
    const key = registry.generateAgentKey();
    const { rows } = await pool.query(
      `UPDATE pos_integrations
          SET agent_key_hash = $3, key_rotated_at = now(), key_rotated_by = $4,
              agent_version = NULL, agent_hostname = NULL, agent_last_ip = NULL,
              last_seen_at = NULL, status = 'inactive', last_error = NULL, updated_at = now()
        WHERE id = $1 AND nightclub_id = $2
        RETURNING *`,
      [req.params.integrationId, req.params.nightclubId, registry.hashAgentKey(key), req.user.id]);
    if (rows.length === 0) throw ApiError.notFound('Integración no encontrada');
    res.json({ integration: registry.present(rows[0]), agent_key: key });
  }));

router.delete('/nightclubs/:nightclubId/pos-integrations/:integrationId',
  requireRole('manager'),
  validate({ params: z.object({ nightclubId: uuid, integrationId: uuid }) }),
  asyncHandler(async (req, res) => {
    const current = await pool.query(
      'SELECT enabled FROM pos_integrations WHERE id = $1 AND nightclub_id = $2',
      [req.params.integrationId, req.params.nightclubId]);
    if (current.rowCount === 0) throw ApiError.notFound('Integración no encontrada');
    if (current.rows[0].enabled) {
      throw ApiError.conflict('Desactiva la integración antes de eliminarla');
    }
    await pool.query('DELETE FROM pos_integrations WHERE id = $1', [req.params.integrationId]);
    res.status(204).end();
  }));

router.get('/nightclubs/:nightclubId/pos-sync-log',
  requireRole('manager'),
  validate({
    params: z.object({ nightclubId: uuid }),
    query: pagination.extend({
      kind: z.enum(registry.SYNC_KINDS).optional(),
      only_failed: z.coerce.boolean().default(false),
    }),
  }),
  asyncHandler(async (req, res) => {
    const q = req.query;
    const [runs, summary] = await Promise.all([
      pool.query(
        `SELECT id::text AS id, integration_id, kind, source, started_at, finished_at, ok,
                items_synced, error, details
           FROM pos_sync_log
          WHERE nightclub_id = $1
            AND ($2::text IS NULL OR kind = $2)
            AND (NOT $3::boolean OR ok IS NOT TRUE)
          ORDER BY started_at DESC LIMIT $4 OFFSET $5`,
        [req.params.nightclubId, q.kind || null, q.only_failed, q.limit, q.offset]),
      pool.query(
        `SELECT kind,
                count(*)::int AS runs,
                count(*) FILTER (WHERE ok)::int AS ok,
                count(*) FILTER (WHERE ok IS NOT TRUE AND finished_at IS NOT NULL)::int AS failed,
                COALESCE(sum(items_synced), 0)::int AS items,
                max(finished_at) FILTER (WHERE ok) AS last_success_at
           FROM pos_sync_log
          WHERE nightclub_id = $1 AND started_at > now() - interval '7 days'
          GROUP BY kind ORDER BY kind`,
        [req.params.nightclubId]),
    ]);
    // Event ids are 64-bit and travel as strings (same rule as /events).
    res.json({ runs: runs.rows, last_7_days: summary.rows });
  }));

// ------------------------------------------------------------------ the agent

// An agent that loses connectivity retries; the limit is generous enough for a normal
// heartbeat and tight enough that a stolen key cannot be used to hammer the API.
const agentLimiter = rateLimit({
  windowMs: 60_000,
  limit: Number(process.env.POS_AGENT_RATE_LIMIT_PER_MIN || 120),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (req, res, next) => next(ApiError.tooMany()),
});

/** Machine authentication: a key, no session, no inherited permissions. */
const agentAuth = asyncHandler(async (req, res, next) => {
  const key = req.headers['x-agent-key'];
  const integration = await registry.findByAgentKey(Array.isArray(key) ? key[0] : key);
  if (!integration) throw ApiError.unauthorized('Llave de agente inválida');
  req.integration = integration;
  return next();
});

router.post('/pos/agent/heartbeat', agentLimiter, agentAuth,
  validate({
    body: z.object({
      version: z.string().trim().max(30).optional(),
      hostname: z.string().trim().max(120).optional(),
      status: z.enum(['ok', 'error']).default('ok'),
      error: z.string().trim().max(2000).optional(),
    }).default({}),
  }),
  asyncHandler(async (req, res) => {
    const b = req.body;
    const { rows } = await pool.query(
      `UPDATE pos_integrations
          SET last_seen_at = now(), agent_version = COALESCE($2, agent_version),
              agent_hostname = COALESCE($3, agent_hostname), agent_last_ip = $4,
              -- $5 is cast explicitly: without it Postgres deduces varchar from the SET
              -- and text from the CASE comparison, and refuses the statement (42P08).
              status = $5::text, last_error = CASE WHEN $5::text = 'error' THEN $6 ELSE NULL END,
              updated_at = now()
        WHERE id = $1
        RETURNING *`,
      [req.integration.id, b.version || null, b.hostname || null, req.ip || null,
        b.status === 'error' ? 'error' : 'active', b.error || null]);
    const row = rows[0];
    // The answer tells the agent what to do, so the club can turn the integration on
    // and off without touching the machine at the venue.
    res.json({
      integration_id: row.id,
      nightclub_id: row.nightclub_id,
      enabled: row.enabled,
      mode: row.mode,
      config: row.config,
      heartbeat_interval_seconds: row.heartbeat_interval_seconds,
      // Writing orders into the POS is not available yet (phase 4, docs/POS_REAL.md).
      capabilities: { read_catalog: row.enabled, read_inventory: row.enabled, push_orders: false },
      server_time: new Date().toISOString(),
    });
  }));

router.post('/pos/agent/sync', agentLimiter, agentAuth,
  validate({
    body: z.object({
      kind: z.enum(registry.SYNC_KINDS),
      ok: z.boolean(),
      items_synced: z.number().int().min(0).max(1_000_000).default(0),
      started_at: z.string().datetime().optional(),
      error: z.string().trim().max(2000).optional(),
      details: z.record(z.string(), z.unknown()).default({}),
      client_request_id: uuid.optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const b = req.body;
    const integration = req.integration;
    if (!integration.enabled) {
      throw ApiError.forbidden('La integración está desactivada por el club');
    }
    if (b.client_request_id) {
      const existing = await pool.query(
        'SELECT id::text AS id FROM pos_sync_log WHERE client_request_id = $1',
        [b.client_request_id]);
      if (existing.rowCount > 0) {
        return res.status(200).json({ run_id: existing.rows[0].id, idempotent: true });
      }
    }
    const { rows } = await pool.query(
      `INSERT INTO pos_sync_log (nightclub_id, integration_id, kind, source, started_at,
                                 finished_at, ok, items_synced, error, details, client_request_id)
       VALUES ($1,$2,$3,'agent',COALESCE($4::timestamptz, now()),now(),$5,$6,$7,$8,$9)
       RETURNING id::text AS id`,
      [integration.nightclub_id, integration.id, b.kind, b.started_at || null, b.ok,
        b.items_synced, b.ok ? null : (b.error || 'sin detalle'), JSON.stringify(b.details),
        b.client_request_id || null]);

    // A failed run is what the manager's screen must show, not something buried in a log.
    await pool.query(
      `UPDATE pos_integrations
          SET status = $2, last_error = $3, last_seen_at = now(), updated_at = now()
        WHERE id = $1`,
      [integration.id, b.ok ? 'active' : 'error', b.ok ? null : (b.error || 'sin detalle')]);

    return res.status(201).json({ run_id: rows[0].id });
  }));

module.exports = router;
