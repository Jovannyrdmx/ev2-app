-- ============================================================================
-- Migration 068: el corte general de la noche (D121).
--
-- Un papel nuevo en la cola: `night_cut`, todas las cajas de la noche (barras y
-- Cover) con los totales del club. Solo se amplía la lista de tipos; nada más cambia.
-- ============================================================================
ALTER TABLE print_jobs DROP CONSTRAINT IF EXISTS print_jobs_kind_check;
ALTER TABLE print_jobs ADD CONSTRAINT print_jobs_kind_check
  CHECK (kind IN ('order','bill','receipt','shift_cut','test','cash_drop','drawer','night_cut'));
