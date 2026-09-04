-- ============================================================================
-- Migration 012: POS integration registry (step 2.8, decision D24).
--
-- This step does NOT talk to SoftRestaurant: that is phase 4, against whatever
-- mechanism National Soft confirms (docs/POS_REAL.md). What it does is give the
-- club one place to declare the integration, hand the local agent a rotatable key
-- of its own, and see whether that agent is alive and what it has been doing.
--
-- No SQL Server credentials are stored here. With the local agent (D16) the
-- database user lives on the club's own server; the API only ever knows the hash
-- of the agent's key. `credentials_encrypted` stays unused until there is a real
-- provider secret to keep -- storing a speculative one would be code we cannot test.
-- ============================================================================

ALTER TABLE pos_integrations
  ADD COLUMN IF NOT EXISTS enabled                    BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS agent_version              VARCHAR(30),
  ADD COLUMN IF NOT EXISTS agent_hostname             VARCHAR(120),
  ADD COLUMN IF NOT EXISTS agent_last_ip              INET,
  ADD COLUMN IF NOT EXISTS key_rotated_at             TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS key_rotated_by             UUID REFERENCES users(id) ON DELETE SET NULL,
  -- How often the agent should call in, and how long silence is tolerated before
  -- the integration is reported as stale on the manager's screen.
  ADD COLUMN IF NOT EXISTS heartbeat_interval_seconds INTEGER NOT NULL DEFAULT 60
    CHECK (heartbeat_interval_seconds BETWEEN 15 AND 3600),
  ADD COLUMN IF NOT EXISTS stale_after_seconds        INTEGER NOT NULL DEFAULT 300
    CHECK (stale_after_seconds BETWEEN 60 AND 86400),
  ADD COLUMN IF NOT EXISTS created_by                 UUID REFERENCES users(id) ON DELETE SET NULL;

-- The key hash is how an incoming agent request finds its integration, so it has to
-- be unique across the whole system, not per club.
CREATE UNIQUE INDEX IF NOT EXISTS pos_integrations_agent_key_uidx
  ON pos_integrations (agent_key_hash) WHERE agent_key_hash IS NOT NULL;

ALTER TABLE pos_sync_log
  ADD COLUMN IF NOT EXISTS integration_id    UUID REFERENCES pos_integrations(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS source            VARCHAR(12) NOT NULL DEFAULT 'agent'
    CHECK (source IN ('agent','manual','scheduled')),
  ADD COLUMN IF NOT EXISTS details           JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS client_request_id UUID;

-- An agent that retries after a timeout must not double-write its own history.
CREATE UNIQUE INDEX IF NOT EXISTS pos_sync_log_client_request_uidx
  ON pos_sync_log (client_request_id) WHERE client_request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS pos_sync_log_integration_idx
  ON pos_sync_log (integration_id, started_at DESC) WHERE integration_id IS NOT NULL;
