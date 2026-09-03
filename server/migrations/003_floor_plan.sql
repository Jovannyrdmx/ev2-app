-- ============================================================================
-- Migration 003: the real floor plan needs two things the schema did not have.
--
-- 1. `floor`: EV2 Clandestinoz has two levels (planta baja / planta alta) and the
--    original schema assumed a single one. Without it the map cannot be drawn and
--    staff cannot filter by level.
-- 2. `table_number`: staff talk about "la mesa 39", not about a UUID or a code.
--    The code stays the unique key (it carries the zone prefix where numbers repeat);
--    the number is what people say out loud.
--
-- It also adds `venue_landmarks` for the parts of the map that are not tables —
-- bar, dance floor, DJ booth, VIP area, entrance, restrooms. The legacy code stored
-- them alongside tables, which made every "count the tables" query wrong.
-- ============================================================================

ALTER TABLE tables
  ADD COLUMN IF NOT EXISTS floor        VARCHAR(20) NOT NULL DEFAULT 'baja',
  ADD COLUMN IF NOT EXISTS table_number INTEGER,
  ADD COLUMN IF NOT EXISTS color        VARCHAR(9);

ALTER TABLE tables DROP CONSTRAINT IF EXISTS tables_floor_check;
ALTER TABLE tables
  ADD CONSTRAINT tables_floor_check CHECK (floor IN ('baja', 'alta', 'ambas'));

CREATE INDEX IF NOT EXISTS tables_nightclub_floor_idx ON tables (nightclub_id, floor);

CREATE TABLE IF NOT EXISTS venue_landmarks (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nightclub_id UUID NOT NULL REFERENCES nightclubs(id) ON DELETE CASCADE,
  code         VARCHAR(40) NOT NULL,
  name         VARCHAR(80) NOT NULL,
  type         VARCHAR(20) NOT NULL
               CHECK (type IN ('bar', 'dance_area', 'dj', 'vip', 'entrance', 'restroom', 'stage', 'other')),
  description  TEXT,
  floor        VARCHAR(20) NOT NULL DEFAULT 'ambas' CHECK (floor IN ('baja', 'alta', 'ambas')),
  x            NUMERIC(8,2),
  y            NUMERIC(8,2),
  width        NUMERIC(8,2),
  height       NUMERIC(8,2),
  sort_order   INTEGER NOT NULL DEFAULT 0,
  active       BOOLEAN NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (nightclub_id, code)
);

CREATE TRIGGER venue_landmarks_set_updated_at
  BEFORE UPDATE ON venue_landmarks
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
