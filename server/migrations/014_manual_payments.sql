-- ============================================================================
-- Migration 014: payments the club receives outside a payment processor
-- (step 3.6, decision D28).
--
-- Cash at the door, a Zelle transfer, a deposit into the club's account. Nobody
-- confirms these automatically, so the flow is: the guest (or the staff member who
-- took the money) declares the payment, and a manager confirms it against the bank
-- statement. Only that confirmation moves the ledger entry to `paid`.
--
-- Two partial unique indexes carry the weight here:
--   * one open declaration per ledger entry, so two people cannot claim the same
--     charge at once;
--   * at most one CONFIRMED payment per ledger entry, so a charge cannot be credited
--     twice even if two managers press confirm in the same second.
-- ============================================================================

-- Where the club takes money outside a processor. Loaded by the manager; empty until
-- then, because inventing a Zelle handle would be worse than showing none.
CREATE TABLE IF NOT EXISTS manual_payment_options (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nightclub_id      UUID NOT NULL REFERENCES nightclubs(id) ON DELETE CASCADE,
  method            VARCHAR(20) NOT NULL
                    CHECK (method IN ('cash','zelle','cash_app','bank_transfer','spei')),
  label             VARCHAR(80) NOT NULL,
  -- The handle, CLABE or account the guest sends money to. Stored in the clear on
  -- purpose: unlike an employee's account (migration 007, encrypted), this is the
  -- club's own receiving account and its whole job is to be shown to whoever pays.
  destination       VARCHAR(120),
  instructions      TEXT,
  currency          CHAR(3) NOT NULL DEFAULT 'MXN' CHECK (currency IN ('MXN','USD')),
  -- Cash handed over at the door has no folio; a transfer does, and without it the
  -- manager cannot match it against the statement.
  requires_reference BOOLEAN NOT NULL DEFAULT true,
  active            BOOLEAN NOT NULL DEFAULT true,
  sort_order        INTEGER NOT NULL DEFAULT 0,
  updated_by        UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (nightclub_id, method, label)
);

CREATE TABLE IF NOT EXISTS manual_payments (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nightclub_id      UUID NOT NULL REFERENCES nightclubs(id) ON DELETE CASCADE,
  -- RESTRICT, not CASCADE: the ledger entry this points at is never deleted, and a
  -- payment record that could vanish with it would be useless as evidence.
  transaction_id    UUID NOT NULL REFERENCES transactions(id) ON DELETE RESTRICT,
  option_id         UUID REFERENCES manual_payment_options(id) ON DELETE SET NULL,
  method            VARCHAR(20) NOT NULL
                    CHECK (method IN ('cash','zelle','cash_app','bank_transfer','spei')),
  declared_by       UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  -- Set when a staff member registers a payment for a guest, so the record says who
  -- took the money and who it was for.
  on_behalf_of      UUID REFERENCES users(id) ON DELETE SET NULL,
  amount            NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  currency          CHAR(3) NOT NULL CHECK (currency IN ('MXN','USD')),
  reference         VARCHAR(60),
  note              VARCHAR(280),
  status            VARCHAR(12) NOT NULL DEFAULT 'declared'
                    CHECK (status IN ('declared','confirmed','rejected','cancelled')),
  reviewed_by       UUID REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at       TIMESTAMPTZ,
  rejection_reason  VARCHAR(200),
  client_request_id UUID,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS manual_payments_open_uidx
  ON manual_payments (transaction_id) WHERE status = 'declared';
CREATE UNIQUE INDEX IF NOT EXISTS manual_payments_confirmed_uidx
  ON manual_payments (transaction_id) WHERE status = 'confirmed';
CREATE UNIQUE INDEX IF NOT EXISTS manual_payments_client_request_uidx
  ON manual_payments (client_request_id) WHERE client_request_id IS NOT NULL;
-- The same transfer folio cannot pay for two different things. Without this, one real
-- Zelle transfer could be declared against three separate charges.
CREATE UNIQUE INDEX IF NOT EXISTS manual_payments_reference_uidx
  ON manual_payments (nightclub_id, method, upper(reference))
  WHERE reference IS NOT NULL AND status IN ('declared', 'confirmed');
CREATE INDEX IF NOT EXISTS manual_payments_queue_idx
  ON manual_payments (nightclub_id, status, created_at);

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['manual_payment_options','manual_payments'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = t || '_set_updated_at') THEN
      EXECUTE format('CREATE TRIGGER %I_set_updated_at BEFORE UPDATE ON %I '
                     'FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t, t);
    END IF;
  END LOOP;
END $$;
