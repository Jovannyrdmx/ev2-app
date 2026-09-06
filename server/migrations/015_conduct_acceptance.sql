-- ============================================================================
-- Migration 015: leave written proof that the guest accepted the club's code of
-- conduct before the ride was requested.
--
-- The club already stores the text (`taxi_settings.conduct_terms`) and already
-- issues a verifiable departure certificate. What was missing is the half that
-- protects the club: a record that this person read and accepted those terms at
-- this instant, tied to this ride. Without it, "they agreed to the rules" is a
-- claim with nothing behind it the night something goes wrong in a car.
--
-- Nullable on purpose: rides created before this migration have no acceptance,
-- and a club that publishes no terms never asks for one. NULL means "not asked",
-- never "refused" — a refusal does not produce a ride at all.
-- ============================================================================

ALTER TABLE taxi_requests
  ADD COLUMN IF NOT EXISTS conduct_accepted_at TIMESTAMPTZ;

COMMENT ON COLUMN taxi_requests.conduct_accepted_at IS
  'When the guest accepted the club code of conduct for this ride. NULL = the club published no terms at the time.';
