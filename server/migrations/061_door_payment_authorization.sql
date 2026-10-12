-- ============================================================================
-- Migration 061: en la puerta, cortesía y transferencia las autoriza un gerente (D109).
--
-- La anfitriona podía cobrar en efectivo y registrar la entrada como cortesía, o como
-- "tarjeta"/"transferencia" sin folio: ese dinero dejaba de esperarse en su cajón. La
-- tarjeta en la puerta ya se cobra con la terminal Mercado Pago (D100), así que la
-- tarjeta tecleada a mano deja de aceptarse; cortesía y transferencia llevan el PIN de
-- un gerente, la cortesía su motivo y la transferencia su folio.
-- ============================================================================
ALTER TABLE door_admissions
  ADD COLUMN IF NOT EXISTS authorized_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS payment_reference VARCHAR(60);

CREATE INDEX IF NOT EXISTS door_admissions_authorized_idx
  ON door_admissions (nightclub_id, created_at) WHERE payment_method IN ('courtesy', 'transfer');
