-- ============================================================================
-- Migration 009: safe departure — trusted drivers, rides, cash payments and a
-- verifiable departure certificate (docs/DECISIONES.md D21).
--
-- Rules confirmed with the owner on 2026-09-04:
--   * the club dispatches its OWN trusted drivers; each one is a real account with
--     role `driver`, created by the manager, so that the driver — nobody else —
--     confirms the start and the end of the ride;
--   * the arrival time is DECLARED by the driver when accepting (no GPS in this
--     phase); a driver already waiting at the venue is offered as "available now,
--     wait at the exit"; the historical average (accepted -> arrived) is computed
--     from the rides themselves and shown as a reference;
--   * the fare comes from a zone price list the manager loads; the driver confirms
--     the amount actually charged when closing the ride, and a difference against
--     the quote stays on the record;
--   * cash is settled now (ledger row `taxi_ride`, provider `cash`, guest pays the
--     driver); card is phase 3;
--   * the departure certificate states only what the club can attest — this guest
--     left this club at this time in a ride coordinated by us — with a folio that
--     anyone can verify. It claims no legal effect.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. New role: driver. Kept out of every staff/tip list on purpose — a driver is
--    not club staff and is not tipped through the app.
-- ---------------------------------------------------------------------------
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN (
  'guest','waiter','bartender','dancer','dj','light_tech','valet','hostess','driver','manager','admin'));

-- 2. Ledger entry type for a ride.
ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_type_check;
ALTER TABLE transactions ADD CONSTRAINT transactions_type_check CHECK (type IN (
  'drink_order','bottle_service','tip','song_request','reservation_deposit',
  'reservation_balance','refund','valet','taxi_ride','withdrawal','adjustment'));

-- ---------------------------------------------------------------------------
-- 3. Trusted drivers
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS drivers (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nightclub_id    UUID NOT NULL REFERENCES nightclubs(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  phone           VARCHAR(30) NOT NULL,
  company         VARCHAR(80),                 -- sitio de taxis or "independiente"
  license_number  VARCHAR(40),
  vehicle_plate   VARCHAR(20) NOT NULL,
  vehicle_make    VARCHAR(40),
  vehicle_model   VARCHAR(40),
  vehicle_color   VARCHAR(30),
  vehicle_year    SMALLINT CHECK (vehicle_year BETWEEN 1980 AND 2100),
  seats           SMALLINT NOT NULL DEFAULT 4 CHECK (seats BETWEEN 1 AND 8),
  notes           TEXT,
  -- `trusted` is the manager's explicit endorsement after seeing licence and papers.
  -- An untrusted driver can sign in but is never offered a ride.
  trusted         BOOLEAN NOT NULL DEFAULT false,
  verified_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  verified_at     TIMESTAMPTZ,
  active          BOOLEAN NOT NULL DEFAULT true,
  availability    VARCHAR(12) NOT NULL DEFAULT 'off'
                  CHECK (availability IN ('off','available','on_trip')),
  at_venue        BOOLEAN NOT NULL DEFAULT false,   -- already parked at the exit
  available_since TIMESTAMPTZ,
  created_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Two active drivers cannot share a plate: the guest identifies the car by it.
CREATE UNIQUE INDEX IF NOT EXISTS drivers_plate_uidx
  ON drivers (nightclub_id, upper(vehicle_plate)) WHERE active;
CREATE INDEX IF NOT EXISTS drivers_available_idx
  ON drivers (nightclub_id, availability) WHERE active AND trusted;

-- ---------------------------------------------------------------------------
-- 4. Fare list by zone (loaded by the manager; empty until then)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS taxi_fares (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nightclub_id UUID NOT NULL REFERENCES nightclubs(id) ON DELETE CASCADE,
  zone         VARCHAR(80) NOT NULL,
  description  VARCHAR(160),
  amount       NUMERIC(12,2) NOT NULL CHECK (amount >= 0),
  currency     CHAR(3) NOT NULL DEFAULT 'MXN' CHECK (currency IN ('MXN','USD')),
  active       BOOLEAN NOT NULL DEFAULT true,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  updated_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (nightclub_id, zone)
);

-- ---------------------------------------------------------------------------
-- 5. Per-club settings for the module
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS taxi_settings (
  nightclub_id            UUID PRIMARY KEY REFERENCES nightclubs(id) ON DELETE CASCADE,
  enabled                 BOOLEAN NOT NULL DEFAULT true,
  pickup_point            VARCHAR(120) NOT NULL DEFAULT 'Salida principal',
  currency                CHAR(3) NOT NULL DEFAULT 'MXN' CHECK (currency IN ('MXN','USD')),
  -- How long the departure certificate stays valid.
  certificate_ttl_minutes INTEGER NOT NULL DEFAULT 120
                          CHECK (certificate_ttl_minutes BETWEEN 15 AND 720),
  -- A request nobody accepts in this many minutes is closed as `no_driver`.
  request_timeout_minutes INTEGER NOT NULL DEFAULT 15
                          CHECK (request_timeout_minutes BETWEEN 3 AND 60),
  -- 0 by default: the fare is the driver's. Any other value is a club commission
  -- and must be agreed with the drivers before being set.
  club_commission_pct     NUMERIC(5,2) NOT NULL DEFAULT 0
                          CHECK (club_commission_pct >= 0 AND club_commission_pct <= 100),
  conduct_terms           TEXT,
  updated_by              UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- 6. Rides. `taxi_requests` was created in 001 but no code ever wrote to it; the
--    columns that assumed an external provider are replaced by the real flow.
-- ---------------------------------------------------------------------------
ALTER TABLE taxi_requests
  DROP COLUMN IF EXISTS provider,
  DROP COLUMN IF EXISTS confirmed_by,
  DROP COLUMN IF EXISTS confirmed_at;

ALTER TABLE taxi_requests
  ADD COLUMN IF NOT EXISTS driver_id             UUID REFERENCES drivers(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS fare_id               UUID REFERENCES taxi_fares(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS destination_zone      VARCHAR(80),
  ADD COLUMN IF NOT EXISTS quoted_amount         NUMERIC(12,2) CHECK (quoted_amount >= 0),
  ADD COLUMN IF NOT EXISTS final_amount          NUMERIC(12,2) CHECK (final_amount >= 0),
  ADD COLUMN IF NOT EXISTS currency              CHAR(3) NOT NULL DEFAULT 'MXN'
                                                 CHECK (currency IN ('MXN','USD')),
  ADD COLUMN IF NOT EXISTS payment_method        VARCHAR(12)
                                                 CHECK (payment_method IN ('cash','card','courtesy')),
  ADD COLUMN IF NOT EXISTS transaction_id        UUID REFERENCES transactions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS eta_minutes           SMALLINT CHECK (eta_minutes BETWEEN 0 AND 120),
  ADD COLUMN IF NOT EXISTS client_request_id     UUID,
  ADD COLUMN IF NOT EXISTS accepted_at           TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS arrived_at            TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS started_at            TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ended_at              TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS rating                SMALLINT CHECK (rating BETWEEN 1 AND 5),
  ADD COLUMN IF NOT EXISTS rating_comment        VARCHAR(280),
  ADD COLUMN IF NOT EXISTS cancelled_by          UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS cancel_reason         VARCHAR(160),
  ADD COLUMN IF NOT EXISTS notes                 VARCHAR(280),
  ADD COLUMN IF NOT EXISTS certificate_issued_at TIMESTAMPTZ;

-- The certificate folio is shown printed and typed into a public verification page,
-- so it is longer than the original CHAR(6) and unique across the whole system.
DROP INDEX IF EXISTS taxi_requests_code_uidx;
ALTER TABLE taxi_requests ALTER COLUMN conduct_code TYPE VARCHAR(20);
CREATE UNIQUE INDEX IF NOT EXISTS taxi_requests_conduct_code_uidx
  ON taxi_requests (conduct_code) WHERE conduct_code IS NOT NULL;

ALTER TABLE taxi_requests DROP CONSTRAINT IF EXISTS taxi_requests_status_check;
ALTER TABLE taxi_requests ADD CONSTRAINT taxi_requests_status_check CHECK (status IN (
  'requested','assigned','driver_arrived','in_progress','completed','cancelled','no_driver'));

-- A guest has at most one live ride, and a driver at most one assigned ride: without
-- these two indexes the same driver could be sent to two exits at once.
CREATE UNIQUE INDEX IF NOT EXISTS taxi_requests_open_by_user_uidx
  ON taxi_requests (user_id)
  WHERE status IN ('requested','assigned','driver_arrived','in_progress');
CREATE UNIQUE INDEX IF NOT EXISTS taxi_requests_open_by_driver_uidx
  ON taxi_requests (driver_id)
  WHERE driver_id IS NOT NULL AND status IN ('assigned','driver_arrived','in_progress');
CREATE UNIQUE INDEX IF NOT EXISTS taxi_requests_client_request_uidx
  ON taxi_requests (client_request_id) WHERE client_request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS taxi_requests_driver_history_idx
  ON taxi_requests (driver_id, created_at DESC) WHERE driver_id IS NOT NULL;

-- updated_at triggers for the new tables (same helper as 001).
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['drivers','taxi_fares','taxi_settings'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = t || '_set_updated_at') THEN
      EXECUTE format('CREATE TRIGGER %I_set_updated_at BEFORE UPDATE ON %I '
                     'FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t, t);
    END IF;
  END LOOP;
END $$;
