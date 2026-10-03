-- ============================================================================
-- Migration 026: charging a card on the club's own Mercado Pago terminal (D47).
--
-- What changes, and what does not
-- -------------------------------
-- Until now the club's card payments were RECORDED, not charged: the bank's terminal
-- took the money and a waiter typed the voucher folio into `manual_payments`
-- (method `card_terminal`, migration 017). That still works and is still there -- it is
-- what a club with a Banorte terminal uses, and what this club falls back to the night
-- Mercado Pago is down.
--
-- What is new is a card charge the SYSTEM starts and the SYSTEM confirms: the amount is
-- pushed to a Point Smart terminal, the customer taps, and Mercado Pago tells us whether
-- it went through. Nobody types an amount, so nobody mistypes one, and "did that card go
-- through?" stops being a question anyone has to answer from memory.
--
-- Why two tables and not one
-- --------------------------
-- `payment_terminals` is the club's hardware: one row per physical terminal, with the
-- name the staff calls it ("Barra", "Mesero 1", "Puerta"). There will be several, they
-- move around, and a charge has to say which one it went to -- at closing, "the card
-- reader" is not an answer when there are three.
--
-- `terminal_charges` is one attempt to charge. It is NOT the ledger: `transactions`
-- stays the ledger, unchanged and still immutable. This table is the conversation with
-- Mercado Pago about one of those ledger entries, and its `status` is Mercado Pago's
-- answer, not ours.
--
-- Why an events table as well
-- ---------------------------
-- A charge's status is a moving thing -- created, waiting, processed -- and the row
-- above only ever shows where it ended. `terminal_charge_events` keeps every step, from
-- whichever of the three mouths it came out of (the API call, the webhook, the backup
-- poll), insert-only and with the raw payload. The night a customer says "it charged me
-- twice", that table is the only thing that can answer, and an answer that can be edited
-- is not evidence.
-- ============================================================================

-- ---------------------------------------------------------------- the hardware

CREATE TABLE IF NOT EXISTS payment_terminals (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nightclub_id      UUID NOT NULL REFERENCES nightclubs(id) ON DELETE CASCADE,
  provider          VARCHAR(20) NOT NULL DEFAULT 'mercadopago'
                    CHECK (provider IN ('mercadopago')),
  -- What Mercado Pago calls it: "NEWLAND_N950__N950NCB801293324". Type and serial, and
  -- the only handle the API accepts.
  external_id       VARCHAR(120) NOT NULL,
  -- What the staff calls it. A serial number is unusable at 2 a.m.
  label             VARCHAR(60) NOT NULL,
  -- The last operating mode Mercado Pago reported. A terminal ships in STANDALONE and
  -- ignores API orders until it is switched to PDV, and that is the single most common
  -- reason a charge "does nothing" -- so it is stored, and shown, instead of guessed.
  operating_mode    VARCHAR(12) CHECK (operating_mode IN ('PDV','STANDALONE','UNDEFINED')),
  operating_mode_at TIMESTAMPTZ,
  active            BOOLEAN NOT NULL DEFAULT true,
  sort_order        INTEGER NOT NULL DEFAULT 0,
  registered_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- The same physical terminal cannot be registered twice in one club, and two
  -- terminals cannot share a name -- "cóbralo en la Barra" has to mean one device.
  UNIQUE (nightclub_id, external_id),
  UNIQUE (nightclub_id, label)
);

CREATE INDEX IF NOT EXISTS payment_terminals_club_idx
  ON payment_terminals (nightclub_id, active, sort_order);

-- ---------------------------------------------------------------- one attempt to charge

CREATE TABLE IF NOT EXISTS terminal_charges (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nightclub_id      UUID NOT NULL REFERENCES nightclubs(id) ON DELETE CASCADE,
  -- RESTRICT for the same reason as `manual_payments`: the ledger entry this points at
  -- is never deleted, and a charge record that could vanish with it proves nothing.
  transaction_id    UUID NOT NULL REFERENCES transactions(id) ON DELETE RESTRICT,
  terminal_id       UUID NOT NULL REFERENCES payment_terminals(id) ON DELETE RESTRICT,
  provider          VARCHAR(20) NOT NULL DEFAULT 'mercadopago'
                    CHECK (provider IN ('mercadopago')),
  -- The order id at Mercado Pago. Null only in the instant between deciding to charge
  -- and getting an answer -- which is exactly the instant a crash would otherwise leave
  -- a charge nobody can find.
  external_order_id VARCHAR(120),
  -- What we sent as X-Idempotency-Key. Kept because it is the only way to ask Mercado
  -- Pago for "that same charge" after a timeout instead of starting a second one, which
  -- on a card terminal means charging the customer twice.
  idempotency_key   UUID NOT NULL,
  amount            NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  currency          CHAR(3) NOT NULL CHECK (currency IN ('MXN','USD')),
  -- Mercado Pago's vocabulary, deliberately, not a translation of it: `processed` is
  -- their word for "the money went through", and renaming it here would mean two
  -- vocabularies to keep in step. `error` is ours, and means we never got an answer.
  status            VARCHAR(16) NOT NULL DEFAULT 'creating'
                    CHECK (status IN ('creating','waiting','action_required','processed',
                                      'failed','canceled','expired','refunded','error')),
  status_detail     VARCHAR(80),
  payment_method_type VARCHAR(30),
  payment_method_id VARCHAR(30),
  installments      SMALLINT CHECK (installments IS NULL OR installments > 0),
  -- Who pressed charge. Not "who approved it": nobody approves a terminal charge, the
  -- card does. This is who to ask what happened.
  started_by        UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  expires_at        TIMESTAMPTZ,
  settled_at        TIMESTAMPTZ,
  -- When the backup poll last asked. Null means it never had to.
  last_polled_at    TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One live charge per ledger entry. Without this, two waiters pressing charge on the
-- same bill wake up two terminals and the customer pays twice -- and the second payment
-- is a refund conversation, not a mistake anyone notices that night.
CREATE UNIQUE INDEX IF NOT EXISTS terminal_charges_open_uidx
  ON terminal_charges (transaction_id)
  WHERE status IN ('creating','waiting','action_required');

-- And at most one that succeeded, ever.
CREATE UNIQUE INDEX IF NOT EXISTS terminal_charges_processed_uidx
  ON terminal_charges (transaction_id) WHERE status = 'processed';

CREATE UNIQUE INDEX IF NOT EXISTS terminal_charges_idempotency_uidx
  ON terminal_charges (idempotency_key);

CREATE UNIQUE INDEX IF NOT EXISTS terminal_charges_order_uidx
  ON terminal_charges (provider, external_order_id)
  WHERE external_order_id IS NOT NULL;

-- What the backup poll reads: the ones still waiting, oldest first.
CREATE INDEX IF NOT EXISTS terminal_charges_pending_idx
  ON terminal_charges (status, created_at)
  WHERE status IN ('creating','waiting','action_required');

CREATE INDEX IF NOT EXISTS terminal_charges_club_idx
  ON terminal_charges (nightclub_id, created_at DESC);

-- ---------------------------------------------------------------- every step, kept

CREATE TABLE IF NOT EXISTS terminal_charge_events (
  id            BIGSERIAL PRIMARY KEY,
  charge_id     UUID NOT NULL REFERENCES terminal_charges(id) ON DELETE RESTRICT,
  -- Which mouth it came out of. When two of them disagree, this is what says so.
  source        VARCHAR(10) NOT NULL CHECK (source IN ('api','webhook','poll','staff')),
  action        VARCHAR(40) NOT NULL,
  status        VARCHAR(16),
  -- Mercado Pago's own notification id. Their webhooks repeat -- by design, since they
  -- retry until we answer 200 -- and without this the same notification could be
  -- applied twice.
  request_id    VARCHAR(120),
  payload       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS terminal_charge_events_charge_idx
  ON terminal_charge_events (charge_id, id);

-- The same webhook delivery counts once.
CREATE UNIQUE INDEX IF NOT EXISTS terminal_charge_events_request_uidx
  ON terminal_charge_events (charge_id, request_id)
  WHERE request_id IS NOT NULL;

-- Insert-only, like every other record in here that has to survive an argument.
-- Same shape as `night_closings` (023) and `supply_movements`.
CREATE OR REPLACE FUNCTION terminal_charge_events_are_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'terminal_charge_events is insert-only: what Mercado Pago said is what it said'
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS terminal_charge_events_no_change ON terminal_charge_events;
CREATE TRIGGER terminal_charge_events_no_change
  BEFORE UPDATE OR DELETE ON terminal_charge_events
  FOR EACH ROW EXECUTE FUNCTION terminal_charge_events_are_immutable();

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['payment_terminals','terminal_charges'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = t || '_set_updated_at') THEN
      EXECUTE format('CREATE TRIGGER %I_set_updated_at BEFORE UPDATE ON %I '
                     'FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t, t);
    END IF;
  END LOOP;
END $$;
