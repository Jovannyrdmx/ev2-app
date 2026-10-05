-- ============================================================================
-- Migration 044: the till takes US dollars and gives change in pesos (D86).
--
-- Decided with the owner on 2026-10-05:
--   * one USD->MXN rate for everything (the `exchange_rates` table that employee
--     withdrawals already use), set by the manager;
--   * the change is in pesos, rounded DOWN to the whole peso; the cents stay with
--     the club;
--   * dollars can be one of the two payment forms of a charge (D79);
--   * the cut counts pesos and dollars separately, each with its own expected amount
--     and difference. Partial withdrawals can be in either currency.
--
-- A dollar payment is its own method, `cash_usd`. Its `amount` is the MXN it covers,
-- so the ledger row (always in the charge's currency) stays exactly as it was; what
-- the guest handed over, at what rate and how much change went out, live next to it.
-- ============================================================================

ALTER TABLE manual_payments DROP CONSTRAINT IF EXISTS manual_payments_method_check;
ALTER TABLE manual_payments ADD CONSTRAINT manual_payments_method_check
  CHECK (method IN ('cash','cash_usd','card_terminal','zelle','cash_app','bank_transfer','spei'));

ALTER TABLE manual_payments
  ADD COLUMN IF NOT EXISTS usd_received     NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS exchange_rate    NUMERIC(12,6),
  ADD COLUMN IF NOT EXISTS exchange_rate_id BIGINT REFERENCES exchange_rates(id) ON DELETE RESTRICT;

COMMENT ON COLUMN manual_payments.usd_received IS
  'Dollars the guest handed over (D86). amount is the MXN they cover; change_given is in MXN.';

-- Pesos: what was received minus the amount, as before. Dollars: the received dollars
-- at the stored rate cover the amount, and the change is what is left, rounded down
-- to the peso. Every other method carries none of these.
ALTER TABLE manual_payments DROP CONSTRAINT IF EXISTS manual_payments_cash_received_chk;
ALTER TABLE manual_payments ADD CONSTRAINT manual_payments_cash_received_chk
  CHECK (
    CASE WHEN method = 'cash_usd' THEN
      usd_received > 0 AND exchange_rate > 0 AND exchange_rate_id IS NOT NULL
      AND cash_received IS NULL AND change_given IS NOT NULL AND change_given >= 0
      AND round(usd_received * exchange_rate, 2) >= amount
      AND change_given = floor(round(usd_received * exchange_rate, 2) - amount)
    ELSE
      usd_received IS NULL AND exchange_rate IS NULL AND exchange_rate_id IS NULL
      AND ((cash_received IS NULL AND change_given IS NULL)
           OR (method = 'cash' AND cash_received >= amount
               AND change_given = cash_received - amount))
    END
  );

-- The cut, in dollars, next to the pesos. NULL on cuts made before this migration.
ALTER TABLE shift_closings
  ADD COLUMN IF NOT EXISTS usd_collected      NUMERIC(12,2) CHECK (usd_collected IS NULL OR usd_collected >= 0),
  ADD COLUMN IF NOT EXISTS usd_change_given   NUMERIC(12,2) CHECK (usd_change_given IS NULL OR usd_change_given >= 0),
  ADD COLUMN IF NOT EXISTS usd_drops_total    NUMERIC(12,2) CHECK (usd_drops_total IS NULL OR usd_drops_total >= 0),
  ADD COLUMN IF NOT EXISTS expected_usd       NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS counted_usd        NUMERIC(12,2) CHECK (counted_usd IS NULL OR counted_usd >= 0),
  ADD COLUMN IF NOT EXISTS difference_usd     NUMERIC(12,2);

ALTER TABLE shift_closings DROP CONSTRAINT IF EXISTS shift_closings_usd_reason_chk;
ALTER TABLE shift_closings ADD CONSTRAINT shift_closings_usd_reason_chk
  CHECK (difference_usd IS NULL OR difference_usd = 0 OR difference_reason IS NOT NULL);

-- The cut stays frozen in dollars too: the same guard as 038, plus the USD columns.
CREATE OR REPLACE FUNCTION shift_money_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '%: un corte no se borra (id=%)', TG_TABLE_NAME, OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_TABLE_NAME = 'shift_cash_drops' THEN
    IF NEW.amount <> OLD.amount OR NEW.shift_id <> OLD.shift_id OR NEW.user_id <> OLD.user_id
       OR NEW.currency <> OLD.currency OR NEW.created_at <> OLD.created_at
       OR NEW.reason IS DISTINCT FROM OLD.reason
       OR NEW.authorized_by IS DISTINCT FROM OLD.authorized_by THEN
      RAISE EXCEPTION 'shift_cash_drops: lo declarado no se edita (id=%)', OLD.id
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF OLD.status <> 'declared' AND NEW.status <> OLD.status THEN
      RAISE EXCEPTION 'shift_cash_drops: esa entrega ya está %s (id=%)', OLD.status, OLD.id
        USING ERRCODE = 'restrict_violation';
    END IF;
  ELSE
    IF NEW.shift_id <> OLD.shift_id OR NEW.user_id <> OLD.user_id
       OR NEW.declared_cash <> OLD.declared_cash OR NEW.cash_collected <> OLD.cash_collected
       OR NEW.expected_cash <> OLD.expected_cash OR NEW.totals::text <> OLD.totals::text
       OR NEW.declared_at <> OLD.declared_at OR NEW.created_at <> OLD.created_at
       OR NEW.authorized_by IS DISTINCT FROM OLD.authorized_by
       OR NEW.location_id IS DISTINCT FROM OLD.location_id
       OR NEW.opening_float <> OLD.opening_float
       OR NEW.pending_orders::text <> OLD.pending_orders::text
       OR NEW.pending_total <> OLD.pending_total
       OR NEW.usd_collected IS DISTINCT FROM OLD.usd_collected
       OR NEW.usd_change_given IS DISTINCT FROM OLD.usd_change_given
       OR NEW.usd_drops_total IS DISTINCT FROM OLD.usd_drops_total
       OR NEW.expected_usd IS DISTINCT FROM OLD.expected_usd THEN
      RAISE EXCEPTION 'shift_closings: lo declarado y lo cobrado no se editan (id=%)', OLD.id
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF OLD.status = 'confirmed' AND (
         NEW.status <> OLD.status
         OR NEW.counted_cash IS DISTINCT FROM OLD.counted_cash
         OR NEW.difference IS DISTINCT FROM OLD.difference
         OR NEW.counted_usd IS DISTINCT FROM OLD.counted_usd
         OR NEW.difference_usd IS DISTINCT FROM OLD.difference_usd
         OR NEW.difference_reason IS DISTINCT FROM OLD.difference_reason
         OR NEW.confirmed_by IS DISTINCT FROM OLD.confirmed_by
         OR NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at
       ) THEN
      RAISE EXCEPTION 'shift_closings: ese corte ya está confirmado (id=%)', OLD.id
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
