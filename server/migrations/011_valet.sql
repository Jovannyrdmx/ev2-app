-- ============================================================================
-- Migration 011: valet with QR (docs/DECISIONES.md D22).
--
-- Rules confirmed with the owner on 2026-09-04:
--   * parking is FREE: the club charges nothing. What the valet earns is the tip,
--     which already flows through the tips module (step 2.5, role `valet`). The
--     fee column stays and defaults to 0 so the club can start charging later
--     without a migration, and the checkout only asks for money if it is > 0;
--   * the QR is what stops a car from being handed to the wrong person: the ticket
--     carries a long random token, not the short human code, and the valet must
--     present that token to release the car;
--   * the only way around the QR is the manager, who records why, what kind of ID
--     was shown and the name on it. The ID NUMBER is never stored: the name and the
--     document type answer "who took the car", the number would only be a liability.
-- ============================================================================

CREATE TABLE IF NOT EXISTS valet_settings (
  nightclub_id   UUID PRIMARY KEY REFERENCES nightclubs(id) ON DELETE CASCADE,
  enabled        BOOLEAN NOT NULL DEFAULT true,
  handover_point VARCHAR(120) NOT NULL DEFAULT 'Entrada principal',
  -- 0 = free (the club's choice today). Any other value is charged at checkout.
  fee_amount     NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (fee_amount >= 0),
  currency       CHAR(3) NOT NULL DEFAULT 'MXN' CHECK (currency IN ('MXN','USD')),
  terms          TEXT,
  updated_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE valet_tickets
  ADD COLUMN IF NOT EXISTS qr_token           VARCHAR(64),
  ADD COLUMN IF NOT EXISTS client_request_id  UUID,
  ADD COLUMN IF NOT EXISTS requested_by       UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS claimed_at         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cancelled_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cancel_reason      VARCHAR(160),
  ADD COLUMN IF NOT EXISTS rating_comment     VARCHAR(280),
  ADD COLUMN IF NOT EXISTS notes              VARCHAR(280),
  -- Handover without the QR: who authorised it and on what evidence.
  ADD COLUMN IF NOT EXISTS override_by        UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS override_at        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS override_reason    VARCHAR(200),
  ADD COLUMN IF NOT EXISTS override_id_type   VARCHAR(30),
  ADD COLUMN IF NOT EXISTS override_id_name   VARCHAR(120);

-- Existing rows (none in production; the table was never written to) still get a
-- token so the column can be NOT NULL from here on.
UPDATE valet_tickets SET qr_token = encode(gen_random_bytes(24), 'hex') WHERE qr_token IS NULL;
ALTER TABLE valet_tickets ALTER COLUMN qr_token SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS valet_tickets_qr_token_uidx ON valet_tickets (qr_token);
CREATE UNIQUE INDEX IF NOT EXISTS valet_tickets_client_request_uidx
  ON valet_tickets (client_request_id) WHERE client_request_id IS NOT NULL;
-- The same plate cannot be parked twice at the same time: it would mean two tickets
-- for one car and a guaranteed argument at the door.
CREATE UNIQUE INDEX IF NOT EXISTS valet_tickets_open_plate_uidx
  ON valet_tickets (nightclub_id, upper(plate))
  WHERE status IN ('parked','requested','ready');
CREATE INDEX IF NOT EXISTS valet_tickets_owner_idx
  ON valet_tickets (user_id, created_at DESC) WHERE user_id IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'valet_settings_set_updated_at') THEN
    CREATE TRIGGER valet_settings_set_updated_at BEFORE UPDATE ON valet_settings
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;
