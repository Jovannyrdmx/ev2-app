-- ============================================================================
-- Migration 017: a drink order is a charge, not just a ticket for the bar.
--
-- Until now an order went straight to the bar and nobody recorded whether it had
-- been paid. That works in a restaurant, where the bill is settled at the end at
-- one table; it does not work in a club, where the same person orders four times
-- from three different spots and leaves when they feel like it.
--
-- From here on every order carries its own ledger entry, and the bar does not
-- start on it until that entry says `paid`. The waiter collects at the table with
-- the money or the club's card terminal; the app itself still charges no card,
-- because there are no processor keys yet.
-- ============================================================================

-- Who took the order. Null means the guest ordered from their own phone, which is
-- the difference between "the guest chose it" and "a waiter chose it for them" —
-- and the only way to know, later, whose tray it was.
ALTER TABLE drink_orders
  ADD COLUMN IF NOT EXISTS taken_by UUID REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS drink_orders_taken_by_idx
  ON drink_orders (taken_by, created_at DESC) WHERE taken_by IS NOT NULL;

-- The club's own card terminal. The bank charges the card; the app only records
-- that it happened and the voucher folio, so the cut at closing has something to
-- match against. Adding it here rather than in 014 because the door only ever took
-- cash, and the table is where plastic shows up.
ALTER TABLE manual_payment_options DROP CONSTRAINT IF EXISTS manual_payment_options_method_check;
ALTER TABLE manual_payment_options ADD CONSTRAINT manual_payment_options_method_check
  CHECK (method IN ('cash','card_terminal','zelle','cash_app','bank_transfer','spei'));

ALTER TABLE manual_payments DROP CONSTRAINT IF EXISTS manual_payments_method_check;
ALTER TABLE manual_payments ADD CONSTRAINT manual_payments_method_check
  CHECK (method IN ('cash','card_terminal','zelle','cash_app','bank_transfer','spei'));
