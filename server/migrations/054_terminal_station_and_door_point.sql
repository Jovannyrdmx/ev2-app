-- ============================================================================
-- Migration 054: a Mercado Pago terminal belongs to a till, and the door can charge
-- the cover on it (D100).
--
-- Until now every card charge asked "which terminal?" at the moment of charging. With a
-- terminal physically sitting at each till (and one at the door), that question is a
-- chance to wake the wrong device and send the customer to the wrong bar. The terminal
-- now carries the place it lives in -- the same `supply_locations` row the till, the
-- printer and the cash drawer already hang from -- and the charge goes there by itself.
--
-- One ACTIVE terminal per place, enforced here and not only in the form: two terminals
-- at one till would bring the old question back.
-- ============================================================================

ALTER TABLE payment_terminals
  ADD COLUMN IF NOT EXISTS location_id UUID REFERENCES supply_locations(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS payment_terminals_location_uidx
  ON payment_terminals (location_id) WHERE active AND location_id IS NOT NULL;

-- ----------------------------------------------------------------------------
-- The door's cover paid on the terminal.
--
-- The admission is written AFTER Mercado Pago confirms the card, never before: an
-- entry (and its QR passes) must not exist for money that did not arrive. So the charge
-- comes first, as a pending 'cover' ledger row, and the admission that claims it carries
-- the charge id. The unique index makes a charge claimable exactly once: a double tap,
-- or two hostesses recovering the same charge, cannot sell two entries for one card.
-- ============================================================================

ALTER TABLE door_admissions DROP CONSTRAINT IF EXISTS door_admissions_payment_method_check;
ALTER TABLE door_admissions ADD CONSTRAINT door_admissions_payment_method_check
  CHECK (payment_method::text IN ('cash','card','transfer','courtesy','point'));

ALTER TABLE door_admissions
  ADD COLUMN IF NOT EXISTS terminal_charge_id UUID REFERENCES terminal_charges(id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX IF NOT EXISTS door_admissions_charge_uidx
  ON door_admissions (terminal_charge_id) WHERE terminal_charge_id IS NOT NULL;

-- A 'point' admission always names its charge, and only a 'point' admission does.
ALTER TABLE door_admissions DROP CONSTRAINT IF EXISTS door_admissions_point_chk;
ALTER TABLE door_admissions ADD CONSTRAINT door_admissions_point_chk
  CHECK ((payment_method::text = 'point') = (terminal_charge_id IS NOT NULL));
