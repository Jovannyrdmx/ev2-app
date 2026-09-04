-- ============================================================================
-- Migration 010: an open ride is offered to every available driver at once, so a
-- driver needs a way to take one off their own list without taking it away from
-- the rest. `declined_by` holds exactly that: whoever passed on this ride.
-- ============================================================================

ALTER TABLE taxi_requests
  ADD COLUMN IF NOT EXISTS declined_by UUID[] NOT NULL DEFAULT '{}';
