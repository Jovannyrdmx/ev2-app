-- ============================================================================
-- Migration 004: events, zone pricing, and per-event price overrides.
--
-- The club sells a table for the WHOLE NIGHT, not by the hour, and the price works
-- like this (confirmed with the owner on 2026-09-03, price list effective Jan 2026):
--
--   total = zone base price + (extra guests x that night's ticket price)
--
-- Each zone includes a number of tickets in its base price and allows a capped number
-- of extras. "ZONA ROJA: 8 personas, NO extras" means the 5,000 covers 8 tickets and
-- nobody else may be added. "ZONA AZUL: 10 personas, 2 extras" means 10 covered plus
-- up to 2 more, each paying that night's ticket.
--
-- The ticket price changes per event, and the manager may override any zone's price,
-- included tickets or extras for a specific event without touching the standing list.
--
-- Guests have 3 hours from doors opening to arrive; after that the table is released
-- as a no-show and the deposit is NOT refunded.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Events: one per night the club opens.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS events_calendar (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nightclub_id             UUID NOT NULL REFERENCES nightclubs(id) ON DELETE CASCADE,
  name                     VARCHAR(150) NOT NULL,
  slug                     VARCHAR(150),
  event_date               DATE NOT NULL,
  doors_open_at            TIMESTAMPTZ NOT NULL,
  closes_at                TIMESTAMPTZ,
  ticket_price             NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (ticket_price >= 0),
  currency                 CHAR(3) NOT NULL DEFAULT 'MXN' CHECK (currency IN ('MXN','USD')),
  -- Minutes a guest has to show up before the table is released without refund.
  arrival_deadline_minutes INTEGER NOT NULL DEFAULT 180 CHECK (arrival_deadline_minutes > 0),
  status                   VARCHAR(20) NOT NULL DEFAULT 'draft'
                           CHECK (status IN ('draft','published','cancelled','finished')),
  description              TEXT,
  cover_image_url          TEXT,
  created_by               UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (nightclub_id, event_date),
  CHECK (closes_at IS NULL OR closes_at > doors_open_at)
);
CREATE INDEX IF NOT EXISTS events_calendar_lookup_idx
  ON events_calendar (nightclub_id, event_date DESC);
CREATE INDEX IF NOT EXISTS events_calendar_published_idx
  ON events_calendar (nightclub_id, status, event_date);

CREATE TRIGGER events_calendar_set_updated_at
  BEFORE UPDATE ON events_calendar FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Standing price list, one row per zone. Editable by the manager at any time.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS zone_pricing (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nightclub_id      UUID NOT NULL REFERENCES nightclubs(id) ON DELETE CASCADE,
  section           VARCHAR(40) NOT NULL,
  display_name      VARCHAR(80),
  base_price        NUMERIC(12,2) NOT NULL CHECK (base_price >= 0),
  -- Tickets covered by base_price (the "8 personas" in the price list).
  included_tickets  INTEGER NOT NULL CHECK (included_tickets > 0),
  -- Extra guests allowed on top, each paying the event ticket. 0 = "NO extras".
  max_extras        INTEGER NOT NULL DEFAULT 0 CHECK (max_extras >= 0),
  currency          CHAR(3) NOT NULL DEFAULT 'MXN' CHECK (currency IN ('MXN','USD')),
  color             VARCHAR(9),
  includes          JSONB NOT NULL DEFAULT '[]'::jsonb,
  reservable        BOOLEAN NOT NULL DEFAULT true,
  sort_order        INTEGER NOT NULL DEFAULT 0,
  active            BOOLEAN NOT NULL DEFAULT true,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (nightclub_id, section)
);

CREATE TRIGGER zone_pricing_set_updated_at
  BEFORE UPDATE ON zone_pricing FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Per-event overrides. Only the columns the manager changes are stored; anything
-- left NULL falls back to zone_pricing.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS event_zone_pricing (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id         UUID NOT NULL REFERENCES events_calendar(id) ON DELETE CASCADE,
  section          VARCHAR(40) NOT NULL,
  base_price       NUMERIC(12,2) CHECK (base_price IS NULL OR base_price >= 0),
  included_tickets INTEGER CHECK (included_tickets IS NULL OR included_tickets > 0),
  max_extras       INTEGER CHECK (max_extras IS NULL OR max_extras >= 0),
  reservable       BOOLEAN,
  note             TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (event_id, section)
);

CREATE TRIGGER event_zone_pricing_set_updated_at
  BEFORE UPDATE ON event_zone_pricing FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Reservations become night-based and remember what was charged.
-- ---------------------------------------------------------------------------
ALTER TABLE reservations
  ADD COLUMN IF NOT EXISTS event_id             UUID REFERENCES events_calendar(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS arrival_deadline     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS included_tickets     INTEGER,
  ADD COLUMN IF NOT EXISTS extra_guests         INTEGER NOT NULL DEFAULT 0 CHECK (extra_guests >= 0),
  -- Prices are frozen at booking time: changing the price list later must never
  -- alter what an existing customer already agreed to pay.
  ADD COLUMN IF NOT EXISTS zone_base_at_booking NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS ticket_at_booking    NUMERIC(12,2);

CREATE INDEX IF NOT EXISTS reservations_event_idx ON reservations (event_id, status);

-- One live reservation per table per event.
CREATE UNIQUE INDEX IF NOT EXISTS reservations_one_per_table_per_event
  ON reservations (event_id, table_id)
  WHERE status IN ('pending_payment', 'confirmed', 'seated');

-- ---------------------------------------------------------------------------
-- Bottles and add-ons the club actually sells (from the legacy price list).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reservation_products (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nightclub_id UUID NOT NULL REFERENCES nightclubs(id) ON DELETE CASCADE,
  kind         VARCHAR(20) NOT NULL CHECK (kind IN ('bottle', 'addon')),
  code         VARCHAR(40) NOT NULL,
  name         VARCHAR(120) NOT NULL,
  price        NUMERIC(12,2) NOT NULL CHECK (price >= 0),
  currency     CHAR(3) NOT NULL DEFAULT 'MXN' CHECK (currency IN ('MXN','USD')),
  servings     INTEGER,
  description  TEXT,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  active       BOOLEAN NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (nightclub_id, code)
);

CREATE TRIGGER reservation_products_set_updated_at
  BEFORE UPDATE ON reservation_products FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- reservation_rules: hourly pricing no longer applies.
-- ---------------------------------------------------------------------------
ALTER TABLE reservation_rules
  ADD COLUMN IF NOT EXISTS default_arrival_deadline_minutes INTEGER NOT NULL DEFAULT 180
    CHECK (default_arrival_deadline_minutes > 0);

COMMENT ON COLUMN reservation_rules.base_price_per_hour IS
  'Deprecated since migration 004: tables are sold per night through zone_pricing.';
