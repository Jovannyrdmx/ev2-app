-- ============================================================================
-- Migration 013: commit-safe relay of domain events (step 3.2, decision D26).
--
-- The problem this solves: most routes publish their event INSIDE the same SQL
-- transaction that changes the data, which is what makes the event and the change
-- atomic. If the API pushed to Redis at that moment, a socket could be told about a
-- pedido that the transaction then rolled back.
--
-- `pg_notify` is transactional: it fires only when the transaction commits and is
-- discarded on rollback. So the trigger below is the only thing that knows when an
-- event has really happened. It carries just the id -- notification payloads are
-- capped at 8000 bytes and an event payload has no such limit -- and the relay reads
-- the row.
-- ============================================================================

CREATE OR REPLACE FUNCTION notify_new_event() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('ev2_events', NEW.id::text);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS events_notify ON events;
CREATE TRIGGER events_notify AFTER INSERT ON events
  FOR EACH ROW EXECUTE FUNCTION notify_new_event();

-- Where the relay got to. A notification can be missed (the listening connection drops
-- at the wrong moment), so the relay never trusts notifications alone: it sweeps from
-- this cursor, and the notification only tells it to sweep now instead of in a second.
CREATE TABLE IF NOT EXISTS realtime_relay_state (
  id              SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  -- NULL means "this relay has never run here". It is not the same as 0, which would
  -- mean "start from the first event ever" and would replay a whole night into
  -- everyone's screen on the first deployment.
  last_event_id   BIGINT,
  leader_instance TEXT,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO realtime_relay_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
