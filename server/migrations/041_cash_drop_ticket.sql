-- ============================================================================
-- Migration 041: el retiro de efectivo saca su ticket (D81).
--
-- El retiro parcial ya quedaba escrito con su motivo y quién lo autorizó; ahora
-- también sale en papel, en la impresora de la caja, para que el dinero que sale de
-- la caja viaje con un comprobante firmado por los dos.
-- ============================================================================
ALTER TABLE print_jobs DROP CONSTRAINT IF EXISTS print_jobs_kind_check;
ALTER TABLE print_jobs ADD CONSTRAINT print_jobs_kind_check
  CHECK (kind IN ('order','bill','receipt','shift_cut','test','cash_drop'));
