-- ============================================================================
-- Migration 046: fingerprint time clock (D94).
--
-- Every employee marks entry and exit with a fingerprint on the reader at the
-- till PC of the lower bar. Four tables:
--
--   clock_stations      The PC (browser) allowed to clock people in. Only a request
--                       carrying a station token is accepted: a fingerprint image
--                       sent from anywhere else is refused.
--   biometric_consents  The express consent of each employee (LFPDPPP: biometric
--                       data is sensitive). No consent, no enrollment. Revoking it
--                       deletes the templates.
--   staff_fingerprints  The templates, encrypted with pgcrypto. Never the image.
--                       Two fingers per person. Deleted when the employee is let go.
--   clock_events        The attendance log: who, when, in or out, from which
--                       station. Insert-only: an attendance record is not edited.
-- ============================================================================

CREATE TABLE IF NOT EXISTS clock_stations (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nightclub_id  UUID NOT NULL REFERENCES nightclubs(id) ON DELETE CASCADE,
  name          VARCHAR(60) NOT NULL,
  -- SHA-256 of a random 192-bit token. The token itself is shown once, to the
  -- browser that becomes the station, and never stored.
  token_hash    CHAR(64) NOT NULL UNIQUE,
  token_hint    VARCHAR(8) NOT NULL,
  active        BOOLEAN NOT NULL DEFAULT true,
  created_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ,
  revoked_at    TIMESTAMPTZ,
  revoked_by    UUID REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS clock_stations_club ON clock_stations (nightclub_id);

CREATE TABLE IF NOT EXISTS biometric_consents (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nightclub_id    UUID NOT NULL REFERENCES nightclubs(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Which text of the privacy notice the employee accepted.
  notice_version  VARCHAR(20) NOT NULL,
  accepted_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- The employee confirmed with their OWN PIN, in front of the manager below.
  witnessed_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  ip              VARCHAR(64),
  revoked_at      TIMESTAMPTZ,
  revoked_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  revoke_reason   VARCHAR(40)
);
CREATE UNIQUE INDEX IF NOT EXISTS biometric_consents_one_active
  ON biometric_consents (user_id) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS staff_fingerprints (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nightclub_id  UUID NOT NULL REFERENCES nightclubs(id) ON DELETE CASCADE,
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  finger        VARCHAR(20) NOT NULL CHECK (finger IN (
                  'right_thumb', 'right_index', 'right_middle', 'right_ring', 'right_little',
                  'left_thumb', 'left_index', 'left_middle', 'left_ring', 'left_little')),
  -- pgp_sym_encrypt(<SourceAFIS templates, JSON array of base64>, FINGERPRINT_KEY).
  -- Several captures of the same finger are kept: matching against all of them is
  -- what makes a wet or badly placed finger still recognizable.
  template_enc  BYTEA NOT NULL,
  captures      SMALLINT NOT NULL CHECK (captures BETWEEN 1 AND 8),
  consent_id    UUID NOT NULL REFERENCES biometric_consents(id) ON DELETE CASCADE,
  enrolled_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, finger)
);
CREATE INDEX IF NOT EXISTS staff_fingerprints_club ON staff_fingerprints (nightclub_id);

CREATE TABLE IF NOT EXISTS clock_events (
  id            BIGSERIAL PRIMARY KEY,
  nightclub_id  UUID NOT NULL REFERENCES nightclubs(id) ON DELETE CASCADE,
  -- NO ACTION: an attendance record outlives the account that made it (employees are
  -- deactivated, not deleted). NO ACTION and not RESTRICT so that deleting a whole
  -- club, which cascades to both tables in one statement, still works.
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE NO ACTION,
  station_id    UUID REFERENCES clock_stations(id) ON DELETE SET NULL,
  kind          VARCHAR(3) NOT NULL CHECK (kind IN ('in', 'out')),
  -- The shift this mark opened or closed, when it did (cashiers: none, their shift
  -- opens with the till).
  shift_id      UUID REFERENCES staff_shifts(id) ON DELETE SET NULL,
  score         NUMERIC(6,2),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS clock_events_user ON clock_events (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS clock_events_club ON clock_events (nightclub_id, created_at DESC);

-- Insert-only. The two FKs that are SET NULL on delete (station, shift) are the only
-- changes allowed, and only that exact change.
CREATE OR REPLACE FUNCTION clock_events_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- The club itself going away (CASCADE from nightclubs) is the one delete allowed.
    IF NOT EXISTS (SELECT 1 FROM nightclubs WHERE id = OLD.nightclub_id) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'clock_events: attendance records are not deleted (id=%)', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.id <> OLD.id OR NEW.nightclub_id <> OLD.nightclub_id OR NEW.user_id <> OLD.user_id
     OR NEW.kind <> OLD.kind OR NEW.created_at <> OLD.created_at
     OR NEW.score IS DISTINCT FROM OLD.score
     OR (NEW.station_id IS DISTINCT FROM OLD.station_id AND NEW.station_id IS NOT NULL)
     OR (NEW.shift_id IS DISTINCT FROM OLD.shift_id AND NEW.shift_id IS NOT NULL) THEN
    RAISE EXCEPTION 'clock_events: attendance records are not edited (id=%)', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS clock_events_guard ON clock_events;
CREATE TRIGGER clock_events_guard BEFORE UPDATE OR DELETE ON clock_events
  FOR EACH ROW EXECUTE FUNCTION clock_events_guard();

COMMENT ON TABLE staff_fingerprints IS
  'Encrypted fingerprint templates (D94). Sensitive personal data (LFPDPPP): only with an active consent; deleted on termination or when consent is revoked.';
COMMENT ON TABLE clock_events IS
  'Attendance log from the fingerprint clock (D94). Insert-only.';
