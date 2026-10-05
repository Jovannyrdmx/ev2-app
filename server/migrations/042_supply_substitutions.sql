-- ============================================================================
-- Migration 042: sustituir un insumo que se acabó (D84).
--
-- "No hay Buchanan's 12 en la barra de arriba: usa Black Label". Mientras dure, todos
-- los tragos que llevan el insumo agotado descuentan el sustituto, al mismo precio,
-- y la comanda lo dice para que el bartender sirva el correcto. Termina sola al
-- acabar la noche o cuando vuelve a haber del original; también se quita a mano.
--
-- Solo avanza: una sustitución no se edita ni se borra. Es lo que contesta después
-- "¿por qué salió Black Label en una noche que no se vendió ninguno?".
-- ============================================================================
CREATE TABLE IF NOT EXISTS supply_substitutions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nightclub_id   UUID NOT NULL REFERENCES nightclubs(id) ON DELETE CASCADE,
  location_id    UUID NOT NULL REFERENCES supply_locations(id) ON DELETE RESTRICT,
  supply_id      UUID NOT NULL REFERENCES supplies(id) ON DELETE RESTRICT,
  substitute_id  UUID NOT NULL REFERENCES supplies(id) ON DELETE RESTRICT,
  note           VARCHAR(200),
  created_by     UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at     TIMESTAMPTZ NOT NULL,
  ended_at       TIMESTAMPTZ,
  ended_by       UUID REFERENCES users(id) ON DELETE SET NULL,
  ended_reason   VARCHAR(12) CHECK (ended_reason IN ('manual', 'restocked', 'expired')),
  CHECK (supply_id <> substitute_id),
  CHECK (expires_at > created_at),
  CHECK ((ended_at IS NULL) = (ended_reason IS NULL))
);

-- Una sola sustitución viva por insumo y barra.
CREATE UNIQUE INDEX IF NOT EXISTS supply_substitutions_live_uidx
  ON supply_substitutions (location_id, supply_id) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS supply_substitutions_club_idx
  ON supply_substitutions (nightclub_id, created_at DESC);

-- Solo se puede cerrar, una vez. Lo demás no cambia.
CREATE OR REPLACE FUNCTION supply_substitutions_only_end() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Una sustitución no se borra: se termina';
  END IF;
  IF OLD.ended_at IS NOT NULL THEN
    RAISE EXCEPTION 'Esa sustitución ya terminó';
  END IF;
  IF NEW.nightclub_id <> OLD.nightclub_id OR NEW.location_id <> OLD.location_id
     OR NEW.supply_id <> OLD.supply_id OR NEW.substitute_id <> OLD.substitute_id
     OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at
     OR NEW.expires_at <> OLD.expires_at OR NEW.note IS DISTINCT FROM OLD.note THEN
    RAISE EXCEPTION 'Una sustitución no se edita: se termina y se crea otra';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS supply_substitutions_guard ON supply_substitutions;
CREATE TRIGGER supply_substitutions_guard
  BEFORE UPDATE OR DELETE ON supply_substitutions
  FOR EACH ROW EXECUTE FUNCTION supply_substitutions_only_end();

-- Lo que se cambió en cada pedido, para la comanda y para revisarlo después:
-- [{ "from": "Buchanan's 12", "to": "Black Label", "substitution_id": "…" }]
ALTER TABLE drink_orders ADD COLUMN IF NOT EXISTS substitutions JSONB;
