-- ============================================================================
-- Migration 060: el voucher de tarjeta tecleado a mano lo autoriza un gerente (D107).
--
-- Con la terminal Mercado Pago en cada caja, registrar "tarjeta" con un folio tecleado
-- es el respaldo para cuando la terminal falla. También era la forma de quedarse con
-- un pago en efectivo: se marca como tarjeta con un folio inventado y ese dinero deja
-- de esperarse en el cajón. Ahora el voucher manual lleva el gerente que lo autorizó y
-- el motivo, y sale en el reporte de la noche para cruzarlo contra Mercado Pago.
-- ============================================================================
ALTER TABLE manual_payments
  ADD COLUMN IF NOT EXISTS authorized_by        UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS authorization_reason VARCHAR(200);

CREATE INDEX IF NOT EXISTS manual_payments_voucher_idx
  ON manual_payments (nightclub_id, created_at) WHERE method = 'card_terminal';
