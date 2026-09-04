-- ============================================================================
-- Migration 008: tips, staff shifts, staff drinks and song requests (D20).
--
-- Rules confirmed with the owner on 2026-09-04:
--   * tips keep the minimum and suggested amounts the club already used, per role,
--     editable by the manager (tip_presets); the club keeps nothing;
--   * only roles allowed to receive drinks can be sent one (dancers, as before) —
--     the flag is per role and editable; the drink is charged when sent, never refunded;
--   * the tip to the DJ is separate from the song request; the DJ cannot decline a
--     request; identical songs requested by several guests are merged into one
--     request with votes instead of piling up.
-- ============================================================================

CREATE TABLE IF NOT EXISTS tip_presets (
  nightclub_id   UUID NOT NULL REFERENCES nightclubs(id) ON DELETE CASCADE,
  role           VARCHAR(20) NOT NULL
                 CHECK (role IN ('waiter','bartender','dancer','dj','light_tech','valet','hostess')),
  display_name   VARCHAR(40) NOT NULL,
  icon           VARCHAR(16),
  color          VARCHAR(9),
  currency       CHAR(3) NOT NULL DEFAULT 'MXN' CHECK (currency IN ('MXN','USD')),
  min_tip        NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (min_tip >= 0),
  suggested      JSONB NOT NULL DEFAULT '[]'::jsonb,
  accepts_drinks BOOLEAN NOT NULL DEFAULT false,
  sort_order     INTEGER NOT NULL DEFAULT 0,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (nightclub_id, role)
);

ALTER TABLE tips
  ADD COLUMN IF NOT EXISTS anonymous BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS status    VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'paid', 'cancelled')),
  ADD COLUMN IF NOT EXISTS song_request_id UUID,
  ADD COLUMN IF NOT EXISTS paid_at   TIMESTAMPTZ;

ALTER TABLE staff_drinks
  ADD COLUMN IF NOT EXISTS client_request_id  UUID,
  ADD COLUMN IF NOT EXISTS message            VARCHAR(140),
  ADD COLUMN IF NOT EXISTS from_table_id      UUID REFERENCES tables(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS returned_to_sender BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS declined_at        TIMESTAMPTZ;
CREATE UNIQUE INDEX IF NOT EXISTS staff_drinks_client_request_uidx
  ON staff_drinks (client_request_id) WHERE client_request_id IS NOT NULL;

-- Song requests: one row per distinct song per DJ per night; guests vote on it.
ALTER TABLE song_requests
  ADD COLUMN IF NOT EXISTS normalized_key VARCHAR(420),
  ADD COLUMN IF NOT EXISTS votes          INTEGER NOT NULL DEFAULT 1 CHECK (votes >= 1),
  ADD COLUMN IF NOT EXISTS last_voted_at  TIMESTAMPTZ NOT NULL DEFAULT now();
CREATE INDEX IF NOT EXISTS song_requests_open_key_idx
  ON song_requests (dj_user_id, normalized_key) WHERE status = 'requested';

CREATE TABLE IF NOT EXISTS song_request_votes (
  song_request_id   UUID NOT NULL REFERENCES song_requests(id) ON DELETE CASCADE,
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message           VARCHAR(280),
  client_request_id UUID UNIQUE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (song_request_id, user_id)
);

ALTER TABLE tips
  ADD CONSTRAINT tips_song_request_fk FOREIGN KEY (song_request_id)
  REFERENCES song_requests(id) ON DELETE SET NULL NOT VALID;
ALTER TABLE tips VALIDATE CONSTRAINT tips_song_request_fk;
