-- ============================================================================
-- Migration 069: entrada de efectivo a la caja y corte X (D122).
--
-- * `shift_cash_ins`: dinero que ENTRA a una caja abierta a media noche (reponer
--   fondo, meter cambio). Lo autoriza un gerente con su PIN, como el retiro (D54).
--   Suma a lo que la caja debe entregar. Solo inserción: un renglón de dinero no se
--   edita ni se borra.
-- * `shift_closings.cash_ins_total` / `usd_cash_ins_total`: lo que entró, congelado
--   en el corte, para que el ticket reimpreso diga lo mismo que el original.
-- * Dos papeles nuevos en la cola: `cash_in` y `x_report` (corte X, parcial).
-- ============================================================================
CREATE TABLE IF NOT EXISTS shift_cash_ins (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nightclub_id     UUID NOT NULL REFERENCES nightclubs(id) ON DELETE RESTRICT,
  shift_id         UUID NOT NULL REFERENCES staff_shifts(id) ON DELETE RESTRICT,
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  amount           NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  currency         CHAR(3) NOT NULL DEFAULT 'MXN' CHECK (currency IN ('MXN','USD')),
  reason           VARCHAR(200) NOT NULL CHECK (length(btrim(reason)) >= 3),
  authorized_by    UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  authorized_role  VARCHAR(20) NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Quien mete el dinero no se autoriza a sí mismo.
  CHECK (authorized_by <> user_id)
);

CREATE INDEX IF NOT EXISTS shift_cash_ins_shift_idx ON shift_cash_ins (shift_id, created_at);
CREATE INDEX IF NOT EXISTS shift_cash_ins_club_idx ON shift_cash_ins (nightclub_id, created_at);

CREATE OR REPLACE FUNCTION shift_cash_ins_guard() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'shift_cash_ins: una entrada de efectivo no se edita ni se borra (id=%)', OLD.id
    USING ERRCODE = 'P0001';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS shift_cash_ins_immutable ON shift_cash_ins;
CREATE TRIGGER shift_cash_ins_immutable BEFORE UPDATE OR DELETE ON shift_cash_ins
  FOR EACH ROW EXECUTE FUNCTION shift_cash_ins_guard();

ALTER TABLE shift_closings
  ADD COLUMN IF NOT EXISTS cash_ins_total     NUMERIC(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS usd_cash_ins_total NUMERIC(12,2) NOT NULL DEFAULT 0;

ALTER TABLE print_jobs DROP CONSTRAINT IF EXISTS print_jobs_kind_check;
ALTER TABLE print_jobs ADD CONSTRAINT print_jobs_kind_check
  CHECK (kind IN ('order','bill','receipt','shift_cut','test','cash_drop','drawer',
                  'night_cut','cash_in','x_report'));

COMMENT ON TABLE shift_cash_ins IS
  'Efectivo que entra a una caja abierta con PIN de gerente (D122). Suma a lo que la caja debe entregar.';
