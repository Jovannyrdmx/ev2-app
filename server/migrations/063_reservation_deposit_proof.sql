-- ============================================================================
-- Migration 063: el comprobante del anticipo y el resto en la puerta (D113).
--
-- Quien reserva una mesa paga el anticipo por transferencia y sube la FOTO del
-- comprobante desde la app. El gerente o la anfitriona la revisan contra el banco y
-- confirman; recien entonces la reservacion pasa a `confirmed` y lo pagado se vuelve
-- credito de consumo (D97). El resto (total - anticipo) se cobra en la puerta, en
-- efectivo o con la terminal, antes de dejar pasar a la mesa.
--
-- La foto vive en disco, en el mismo volumen respaldado de las fotos de facturas
-- (RECEIPTS_DIR), y aqui solo su ruta relativa: un comprobante bancario tiene el
-- nombre y la cuenta de quien pago, y no debe viajar en cada respaldo de la base ni
-- servirse como archivo publico.
-- ============================================================================

ALTER TABLE manual_payments
  ADD COLUMN IF NOT EXISTS proof_path        TEXT,
  ADD COLUMN IF NOT EXISTS proof_mime        VARCHAR(60),
  ADD COLUMN IF NOT EXISTS proof_bytes       INTEGER,
  ADD COLUMN IF NOT EXISTS proof_checksum    CHAR(64),
  ADD COLUMN IF NOT EXISTS proof_uploaded_at TIMESTAMPTZ;

COMMENT ON COLUMN manual_payments.proof_path IS
  'Ruta RELATIVA a RECEIPTS_DIR de la foto del comprobante (D113). Nunca se publica: la imagen se pide por la API.';

-- Todo o nada: una foto sin tipo o sin fecha es una foto que nadie sabe servir.
ALTER TABLE manual_payments DROP CONSTRAINT IF EXISTS manual_payments_proof_chk;
ALTER TABLE manual_payments ADD CONSTRAINT manual_payments_proof_chk CHECK (
  (proof_path IS NULL AND proof_mime IS NULL AND proof_bytes IS NULL
     AND proof_checksum IS NULL AND proof_uploaded_at IS NULL)
  OR (proof_path IS NOT NULL AND proof_mime IS NOT NULL AND proof_bytes > 0
     AND proof_checksum IS NOT NULL AND proof_uploaded_at IS NOT NULL)
);

-- La cola de "anticipos por revisar" de la puerta y del gerente.
CREATE INDEX IF NOT EXISTS manual_payments_declared_idx
  ON manual_payments (nightclub_id, created_at)
  WHERE status = 'declared';

-- El resto de una reservacion se busca por su reservacion en cada escaneo.
CREATE INDEX IF NOT EXISTS transactions_reservation_money_idx
  ON transactions (reference_id)
  WHERE reference_type = 'reservation'
    AND type IN ('reservation_deposit', 'reservation_balance');
