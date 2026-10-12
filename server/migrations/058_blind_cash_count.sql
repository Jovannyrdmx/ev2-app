-- ============================================================================
-- Migration 058: corte a ciegas (D105).
--
-- Quien maneja efectivo (cajero en su barra, anfitriona en la puerta) cuenta su
-- cajón SIN saber cuánto debería haber, y lo que declara queda escrito antes de que
-- el gerente le enseñe lo esperado. Si viera lo esperado antes de contar, un sobrante
-- (un cambio mal dado a favor del club) se lo podría quedar sin que el corte lo note.
--
-- La declaración es una por turno y no se edita ni se borra: contar dos veces hasta
-- "atinarle" es justo lo que esto viene a impedir.
-- ============================================================================
CREATE TABLE IF NOT EXISTS shift_declarations (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nightclub_id   UUID NOT NULL REFERENCES nightclubs(id) ON DELETE RESTRICT,
  shift_id       UUID NOT NULL UNIQUE REFERENCES staff_shifts(id) ON DELETE RESTRICT,
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  declared_cash  NUMERIC(12,2) NOT NULL CHECK (declared_cash >= 0),
  -- Los dólares del cajón, aparte y sin convertir (D86). NULL = el turno no los contó.
  declared_usd   NUMERIC(12,2) CHECK (declared_usd IS NULL OR declared_usd >= 0),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS shift_declarations_club_idx
  ON shift_declarations (nightclub_id, created_at);

CREATE OR REPLACE FUNCTION shift_declarations_guard() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'shift_declarations: lo que se contó a ciegas no se edita ni se borra (id=%)',
    OLD.id USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS shift_declarations_guard ON shift_declarations;
CREATE TRIGGER shift_declarations_guard BEFORE UPDATE OR DELETE ON shift_declarations
  FOR EACH ROW EXECUTE FUNCTION shift_declarations_guard();
