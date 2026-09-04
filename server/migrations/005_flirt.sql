-- ============================================================================
-- Migration 005: flirt — in-venue, opt-in, same-night only.
--
-- Rules agreed with the owner on 2026-09-04 (docs/DECISIONES.md D18):
--   * Nobody receives a flirt without opting in (accept_flirts, default false), and
--     nobody appears in the "people tonight" list without opting in (discoverable).
--   * Sender and recipient must both be seated in the club right now; a flirt expires
--     when the night ends and never becomes an off-site chat.
--   * Anti-harassment: 20 flirts/hour per sender, at most 3 unanswered to the same
--     person per night, and a "not interested" reaction silences that sender for the
--     rest of the night. Blocks hide both people from each other.
--   * A drink or bottle sent through a flirt is a REAL order, paid by the sender when
--     placed and prepared right away. If the recipient declines, the order is handed
--     back to the sender's table: it is never cancelled and never refunded.
--   * The manager sees counts and reports, never message contents.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Preferences: appearing in the list and accepting flirts are separate choices.
-- ---------------------------------------------------------------------------
ALTER TABLE user_preferences
  ADD COLUMN IF NOT EXISTS discoverable BOOLEAN NOT NULL DEFAULT false;

-- ---------------------------------------------------------------------------
-- Flirts: idempotent, tied to the sender's table, with a lifecycle and an expiry.
-- ---------------------------------------------------------------------------
ALTER TABLE flirts
  ADD COLUMN IF NOT EXISTS client_request_id UUID,
  ADD COLUMN IF NOT EXISTS sender_table_id   UUID REFERENCES tables(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS status            VARCHAR(20) NOT NULL DEFAULT 'sent',
  ADD COLUMN IF NOT EXISTS expires_at        TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '12 hours');

ALTER TABLE flirts DROP CONSTRAINT IF EXISTS flirts_status_check;
ALTER TABLE flirts ADD CONSTRAINT flirts_status_check
  CHECK (status IN ('sent', 'viewed', 'accepted', 'declined', 'expired'));

-- Emoji flirts must carry one of the catalogue keys; other types may carry none.
ALTER TABLE flirts DROP CONSTRAINT IF EXISTS flirts_emoji_required_check;
ALTER TABLE flirts ADD CONSTRAINT flirts_emoji_required_check
  CHECK (type <> 'emoji' OR emoji IS NOT NULL);

CREATE UNIQUE INDEX IF NOT EXISTS flirts_client_request_uidx
  ON flirts (client_request_id) WHERE client_request_id IS NOT NULL;

-- Rate-limit and "unanswered to the same person" lookups.
CREATE INDEX IF NOT EXISTS flirts_pair_night_idx
  ON flirts (sender_id, recipient_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Reactions: a fixed vocabulary, so the client cannot invent one.
-- ---------------------------------------------------------------------------
ALTER TABLE flirt_reactions DROP CONSTRAINT IF EXISTS flirt_reactions_reaction_check;
ALTER TABLE flirt_reactions ADD CONSTRAINT flirt_reactions_reaction_check
  CHECK (reaction IN ('like', 'wave', 'kiss', 'fire', 'interested', 'not_interested'));

-- ---------------------------------------------------------------------------
-- Gifted drinks: when declined, the order goes back to the sender's table.
-- ---------------------------------------------------------------------------
ALTER TABLE drink_orders
  ADD COLUMN IF NOT EXISTS returned_to_sender BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS returned_at        TIMESTAMPTZ;

-- ---------------------------------------------------------------------------
-- Reports: a fixed set of reasons, and a counter the discovery query can use.
-- ---------------------------------------------------------------------------
ALTER TABLE user_reports DROP CONSTRAINT IF EXISTS user_reports_reason_check;
ALTER TABLE user_reports ADD CONSTRAINT user_reports_reason_check
  CHECK (reason IN ('harassment', 'underage', 'fake_profile', 'other'));

CREATE INDEX IF NOT EXISTS user_reports_reported_open_idx
  ON user_reports (reported_id) WHERE status = 'open';
