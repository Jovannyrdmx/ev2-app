-- ============================================================================
-- Migration 016: the door.
--
-- Until now a reservation became "seated" because a hostess tapped a button, and
-- that tap did not actually seat anybody: the table turned `occupied` but nobody
-- was written into `table_occupants`, so the guest still could not order from
-- their phone. Two halves of the same idea that never met.
--
-- The club's rule, confirmed with the owner on 2026-09-10:
--
--   * a reservation gives the guest a PASS. At the door that pass is scanned (or
--     its short code typed) and the system seats the table and counts the people.
--     Nobody seats themselves from the map any more;
--   * general admission and extra VIP wristbands are SOLD at the door, and every
--     sale is recorded — that is the count of who is inside;
--   * general guests sit wherever they like. The club does not assign them a
--     table, so the app does not pretend to.
--
-- Three things this adds.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. The pass.
--
-- `pass_code` is what the QR encodes and what the door types when a phone screen
-- is cracked, dead, or the camera will not focus in the dark. It is random, not
-- derived from the reservation id: a code that could be guessed from "table 46,
-- Saturday" would let anyone walk in as someone else.
--
-- Unique across the whole table, not per club: the door types a code without
-- saying which club it belongs to, and two clubs colliding would seat the wrong
-- person. NULL is allowed so this migration can fill existing rows in one pass.
-- ---------------------------------------------------------------------------
ALTER TABLE reservations
  ADD COLUMN IF NOT EXISTS pass_code      VARCHAR(20),
  ADD COLUMN IF NOT EXISTS checked_in_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS checked_in_by  UUID REFERENCES users(id) ON DELETE SET NULL;

-- Codes for the reservations that already exist. The alphabet leaves out 0/O and
-- 1/I/L: they are read aloud at a noisy door and dictated wrong every time.
UPDATE reservations
   SET pass_code = 'EV2-' || (
         SELECT string_agg(substr('23456789ABCDEFGHJKMNPQRSTUVWXYZ',
                                  (floor(random() * 31) + 1)::int, 1), '')
           FROM generate_series(1, 4)
       ) || '-' || (
         SELECT string_agg(substr('23456789ABCDEFGHJKMNPQRSTUVWXYZ',
                                  (floor(random() * 31) + 1)::int, 1), '')
           FROM generate_series(1, 4)
       )
 WHERE pass_code IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS reservations_pass_code_uidx
  ON reservations (pass_code) WHERE pass_code IS NOT NULL;

COMMENT ON COLUMN reservations.pass_code IS
  'The pass the guest shows at the door: what the QR encodes and what the door types as a fallback.';
COMMENT ON COLUMN reservations.checked_in_at IS
  'When the door scanned this pass. This is what actually seats the table.';

-- ---------------------------------------------------------------------------
-- 2. What is sold at the door.
--
-- General covers and extra VIP wristbands. Both are money taken at the entrance
-- by a person holding a phone, so both are recorded the same way and both land
-- in `transactions`, which is the club's only book.
--
-- `reservation_id` is set only for a VIP extra — that is what makes "reserved 8,
-- came 10, paid 2 extras" answerable a week later.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS door_admissions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nightclub_id   UUID NOT NULL REFERENCES nightclubs(id) ON DELETE CASCADE,
  event_id       UUID REFERENCES events(id) ON DELETE SET NULL,
  kind           VARCHAR(20) NOT NULL CHECK (kind IN ('general', 'vip_extra')),
  reservation_id UUID REFERENCES reservations(id) ON DELETE SET NULL,
  quantity       INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 50),
  unit_price     NUMERIC(12,2) NOT NULL CHECK (unit_price >= 0),
  total          NUMERIC(12,2) NOT NULL CHECK (total >= 0),
  currency       CHAR(3) NOT NULL DEFAULT 'MXN' CHECK (currency IN ('MXN','USD')),
  payment_method VARCHAR(20) NOT NULL DEFAULT 'cash'
                 CHECK (payment_method IN ('cash','card','transfer','courtesy')),
  transaction_id UUID REFERENCES transactions(id) ON DELETE SET NULL,
  sold_by        UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  notes          VARCHAR(200),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- A VIP extra belongs to a reservation; a general cover never does. Without
  -- this, an extra with no reservation would silently stop being attributable.
  CHECK ((kind = 'vip_extra' AND reservation_id IS NOT NULL)
      OR (kind = 'general'   AND reservation_id IS NULL))
);

CREATE INDEX IF NOT EXISTS door_admissions_night_idx
  ON door_admissions (nightclub_id, created_at DESC);
CREATE INDEX IF NOT EXISTS door_admissions_reservation_idx
  ON door_admissions (reservation_id) WHERE reservation_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 3. The ledger learns the word "cover".
--
-- Money taken at the door is money, and it belongs in the same book as everything
-- else. Without this the entrance takings would live in their own table and never
-- show up in a night's total.
-- ---------------------------------------------------------------------------
ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_type_check;
ALTER TABLE transactions ADD CONSTRAINT transactions_type_check
  CHECK (type IN ('drink_order','bottle_service','tip','song_request','reservation_deposit',
                  'reservation_balance','refund','valet','withdrawal','adjustment',
                  'taxi_ride','cover'));
