-- ============================================================================
-- Migration 043: departure certificate without a taxi (D85).
--
-- Until now the folio was born only when a club driver started a ride. A guest who
-- walks out, or who leaves in their own car, got nothing. Now:
--   * on foot: the guest taps "I'm leaving on my own" and the hostess at the door
--     confirms it. The folio is born at that confirmation, because the club only
--     vouches for what its own staff saw;
--   * valet: delivering the car (with the ticket QR) issues the folio by itself,
--     with the car's plate.
--
-- Rows only move forward: requested -> confirmed | canceled. Nothing is edited or
-- deleted afterwards; a folio somebody already showed on the street must keep
-- saying the same thing.
-- ============================================================================
CREATE TABLE IF NOT EXISTS guest_departures (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nightclub_id    UUID NOT NULL REFERENCES nightclubs(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  mode            VARCHAR(8) NOT NULL CHECK (mode IN ('on_foot', 'valet')),
  status          VARCHAR(10) NOT NULL DEFAULT 'requested'
                  CHECK (status IN ('requested', 'confirmed', 'canceled')),
  -- Valet only: the ticket that was delivered, and the car as it was written down.
  valet_ticket_id UUID UNIQUE REFERENCES valet_tickets(id) ON DELETE RESTRICT,
  vehicle_plate   VARCHAR(20),
  vehicle_desc    VARCHAR(120),
  folio           VARCHAR(20) UNIQUE,
  requested_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirmed_at    TIMESTAMPTZ,
  confirmed_by    UUID REFERENCES users(id) ON DELETE RESTRICT,
  expires_at      TIMESTAMPTZ,
  canceled_at     TIMESTAMPTZ,
  cancel_reason   VARCHAR(12) CHECK (cancel_reason IN ('guest', 'expired', 'superseded')),
  CHECK ((status = 'confirmed') = (folio IS NOT NULL)),
  CHECK (status <> 'confirmed' OR (confirmed_at IS NOT NULL AND expires_at IS NOT NULL)),
  CHECK ((status = 'canceled') = (canceled_at IS NOT NULL AND cancel_reason IS NOT NULL)),
  CHECK (mode <> 'valet' OR valet_ticket_id IS NOT NULL)
);

-- One open request per guest and club: tapping the button twice is the same request.
CREATE UNIQUE INDEX IF NOT EXISTS guest_departures_open_uidx
  ON guest_departures (nightclub_id, user_id) WHERE status = 'requested';
CREATE INDEX IF NOT EXISTS guest_departures_club_idx
  ON guest_departures (nightclub_id, status, requested_at DESC);
CREATE INDEX IF NOT EXISTS guest_departures_user_idx
  ON guest_departures (user_id, requested_at DESC);

-- Only forward, once. Everything else stays as it was written.
CREATE OR REPLACE FUNCTION guest_departures_only_forward() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Una salida no se borra';
  END IF;
  IF OLD.status <> 'requested' THEN
    RAISE EXCEPTION 'Esa salida ya se cerró';
  END IF;
  IF NEW.nightclub_id <> OLD.nightclub_id OR NEW.user_id <> OLD.user_id
     OR NEW.mode <> OLD.mode OR NEW.requested_at <> OLD.requested_at
     OR NEW.valet_ticket_id IS DISTINCT FROM OLD.valet_ticket_id THEN
    RAISE EXCEPTION 'Una salida no se edita';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS guest_departures_guard ON guest_departures;
CREATE TRIGGER guest_departures_guard
  BEFORE UPDATE OR DELETE ON guest_departures
  FOR EACH ROW EXECUTE FUNCTION guest_departures_only_forward();
