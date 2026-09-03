-- ============================================================================
-- Migration 002: transactions.direction must not be blank-padded.
--
-- CHAR(3) is blank-padded in PostgreSQL, so the value 'in' came back as 'in ' and
-- any client comparing it to "in" failed. 'out' happened to be exactly 3 characters,
-- which is why only inbound rows were affected. VARCHAR(3) stores what we write.
--
-- The other fixed-width columns are safe because their values always fill the width:
-- currency CHAR(3) ('MXN'/'USD'), country CHAR(2) ('MX'/'US'), conduct_code CHAR(6).
-- ============================================================================

ALTER TABLE transactions
  ALTER COLUMN direction TYPE VARCHAR(3) USING btrim(direction);

-- Re-assert the constraint against the trimmed values.
ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_direction_check;
ALTER TABLE transactions
  ADD CONSTRAINT transactions_direction_check CHECK (direction IN ('in', 'out'));
