-- ============================================================================
-- Migration 007: employees, encrypted bank accounts, withdrawals (D19).
--
-- Rules confirmed with the owner on 2026-09-04:
--   * the club keeps NO share of tips; there is NO minimum withdrawal;
--   * a bank account must be verified by the manager before the first withdrawal;
--   * an employee's balance is never stored — it is computed from the ledger
--     (what they received as payee minus what they withdrew);
--   * account numbers are encrypted with pgcrypto and only ever shown as ****1234.
-- ============================================================================

-- Employees created by the manager get a temporary password and must change it.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE employee_profiles
  ADD COLUMN IF NOT EXISTS preferred_payout_currency CHAR(3) NOT NULL DEFAULT 'MXN'
    CHECK (preferred_payout_currency IN ('MXN', 'USD')),
  ADD COLUMN IF NOT EXISTS phone VARCHAR(30),
  ADD COLUMN IF NOT EXISTS deactivated_at TIMESTAMPTZ;

ALTER TABLE employee_bank_accounts
  ADD COLUMN IF NOT EXISTS routing_last4 VARCHAR(4),
  ADD COLUMN IF NOT EXISTS verified_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS active        BOOLEAN NOT NULL DEFAULT true;

-- One default account per employee.
CREATE UNIQUE INDEX IF NOT EXISTS employee_bank_accounts_one_default
  ON employee_bank_accounts (user_id) WHERE is_default AND active;

ALTER TABLE withdrawals
  ADD COLUMN IF NOT EXISTS payout_currency  CHAR(3) CHECK (payout_currency IN ('MXN', 'USD')),
  ADD COLUMN IF NOT EXISTS exchange_rate    NUMERIC(12,6),
  ADD COLUMN IF NOT EXISTS amount_paid      NUMERIC(12,2) CHECK (amount_paid > 0),
  ADD COLUMN IF NOT EXISTS rejection_reason TEXT;

-- One withdrawal in flight per employee.
CREATE UNIQUE INDEX IF NOT EXISTS withdrawals_one_open_per_user
  ON withdrawals (user_id) WHERE status IN ('pending', 'approved');

-- Balance lookups: everything paid to this person, everything paid out.
CREATE INDEX IF NOT EXISTS transactions_payee_paid_idx
  ON transactions (payee_user_id, currency) WHERE status = 'paid';
