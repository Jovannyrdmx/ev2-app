-- ============================================================================
-- Migration 070: la caja es una cosa propia, y una barra puede tener varias (D126).
--
-- Hasta aquí "la caja" era la barra: una caja abierta por barra, una impresora de caja
-- por barra, una terminal Point por barra. Para cobrar más rápido en la misma barra (una
-- caja en la PC y otra en un teléfono, con el mismo bartender y el mismo inventario) la
-- caja pasa a tener su propio renglón:
--
--   * `tills`: la caja, en una barra o en Cover, con su nombre y su equipo (PC o
--     teléfono). Cover sigue teniendo UNA sola caja (D118).
--   * `till_id` en el turno (`staff_shifts`), en el rol de la noche
--     (`shift_assignments`), en la impresora de recibos (`printers`, uso `till`) y en la
--     terminal (`payment_terminals`). Las reglas de "una por barra" pasan a ser "una por
--     caja": una caja abierta, una impresora de recibos, una terminal.
--   * Los pedidos, el inventario y el bartender siguen siendo de la BARRA: todas las
--     cajas de una barra ven y cobran los pedidos de esa barra. El renglón del libro se
--     bloquea al cobrar (`FOR UPDATE`), así que dos cajas no cobran el mismo pedido.
--
-- Nada cambia para quien no quiera dos cajas: se crea una caja por cada barra y por
-- Cover con el nombre del lugar, y todo lo que ya existe queda colgado de ella. Las
-- pantallas y rutas de antes, que solo dicen la barra, siguen funcionando mientras esa
-- barra tenga una sola caja (los disparadores de abajo la ponen solos).
-- ============================================================================

CREATE TABLE IF NOT EXISTS tills (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nightclub_id  UUID NOT NULL REFERENCES nightclubs(id) ON DELETE CASCADE,
  -- La barra (o Cover) donde está. Sus pedidos, su bartender y su inventario son los
  -- de ese lugar.
  location_id   UUID NOT NULL REFERENCES supply_locations(id) ON DELETE RESTRICT,
  name          VARCHAR(60) NOT NULL CHECK (length(btrim(name)) >= 1),
  -- Con qué se cobra: la PC de la caja o un teléfono. No cambia las reglas del cobro;
  -- dice cómo se imprime (el teléfono imprime en una impresora de red, D126).
  device        VARCHAR(10) NOT NULL DEFAULT 'pc' CHECK (device IN ('pc', 'phone')),
  sort_order    INTEGER NOT NULL DEFAULT 0,
  active        BOOLEAN NOT NULL DEFAULT true,
  created_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- El nombre es lo que sale en el ticket y en el corte. Que no se repita entre cajas
-- activas lo cuida el alta (`services/tills.js`) y no un índice: el club puede tener
-- hoy dos lugares con el mismo nombre, y esta migración no puede fallar por eso.
CREATE INDEX IF NOT EXISTS tills_location_idx ON tills (location_id, active);

DROP TRIGGER IF EXISTS tills_set_updated_at ON tills;
CREATE TRIGGER tills_set_updated_at
  BEFORE UPDATE ON tills
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE tills IS
  'Las cajas del club (D126): varias por barra, una en Cover. Turno, rol, impresora de recibos y terminal Point cuelgan de la caja.';

-- La caja vive en una barra o en Cover de SU club; Cover tiene una sola caja activa; y
-- una caja no se muda de lugar (su historia de cortes es la de ese lugar).
CREATE OR REPLACE FUNCTION tills_guard() RETURNS trigger AS $$
DECLARE
  loc_club UUID;
  loc_kind VARCHAR(12);
BEGIN
  SELECT nightclub_id, kind INTO loc_club, loc_kind
    FROM supply_locations WHERE id = NEW.location_id;
  IF loc_club IS DISTINCT FROM NEW.nightclub_id THEN
    RAISE EXCEPTION 'tills: that place belongs to another nightclub'
      USING ERRCODE = 'check_violation';
  END IF;
  IF loc_kind IS NULL OR loc_kind NOT IN ('bar', 'door') THEN
    RAISE EXCEPTION 'tills.location_id must point at a bar or the door, not %',
      COALESCE(loc_kind, 'nothing') USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.location_id IS DISTINCT FROM OLD.location_id THEN
    RAISE EXCEPTION 'tills: una caja no se cambia de lugar (id=%)', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF loc_kind = 'door' AND NEW.active AND EXISTS (
       SELECT 1 FROM tills t
        WHERE t.location_id = NEW.location_id AND t.active AND t.id <> NEW.id) THEN
    RAISE EXCEPTION 'tills: Cover tiene una sola caja'
      USING ERRCODE = 'unique_violation', CONSTRAINT = 'tills_one_at_the_door';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tills_check ON tills;
CREATE TRIGGER tills_check
  BEFORE INSERT OR UPDATE ON tills
  FOR EACH ROW EXECUTE FUNCTION tills_guard();

-- ---------------------------------------------------------------------------
-- 1. Una caja por cada barra y por Cover que ya existen, con el nombre del lugar.
--    Y, de aquí en adelante, una barra o Cover nuevos nacen con su caja.
-- ---------------------------------------------------------------------------
INSERT INTO tills (nightclub_id, location_id, name, device, sort_order, active)
SELECT l.nightclub_id, l.id, left(l.name, 60), 'pc', l.sort_order, l.active
  FROM supply_locations l
 WHERE l.kind IN ('bar', 'door')
   AND NOT EXISTS (SELECT 1 FROM tills t WHERE t.location_id = l.id)
   -- Dos lugares con el mismo nombre (uno apagado) no chocan: el apagado nace apagado.
 ORDER BY l.active DESC, l.created_at;

CREATE OR REPLACE FUNCTION supply_locations_default_till() RETURNS trigger AS $$
BEGIN
  IF NEW.kind IN ('bar', 'door')
     AND NOT EXISTS (SELECT 1 FROM tills t WHERE t.location_id = NEW.id) THEN
    INSERT INTO tills (nightclub_id, location_id, name, device, sort_order, active)
    VALUES (NEW.nightclub_id, NEW.id, left(NEW.name, 60), 'pc', NEW.sort_order, NEW.active)
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS supply_locations_default_till ON supply_locations;
CREATE TRIGGER supply_locations_default_till
  AFTER INSERT ON supply_locations
  FOR EACH ROW EXECUTE FUNCTION supply_locations_default_till();

-- La caja que se sobreentiende cuando solo se dijo el lugar: la única activa de ese
-- lugar. Con dos o más no se adivina (NULL) y quien llama tiene que decir cuál.
CREATE OR REPLACE FUNCTION till_of_location(loc UUID) RETURNS UUID AS $$
  SELECT CASE WHEN count(*) = 1 THEN (array_agg(id))[1] END
    FROM tills WHERE location_id = loc AND active;
$$ LANGUAGE sql STABLE;

-- ---------------------------------------------------------------------------
-- 2. El turno de caja: su caja.
-- ---------------------------------------------------------------------------
ALTER TABLE staff_shifts
  ADD COLUMN IF NOT EXISTS till_id UUID REFERENCES tills(id) ON DELETE RESTRICT;

UPDATE staff_shifts s SET till_id = t.id
  FROM tills t
 WHERE s.location_id IS NOT NULL AND s.till_id IS NULL AND t.location_id = s.location_id;

ALTER TABLE staff_shifts DROP CONSTRAINT IF EXISTS staff_shifts_till_with_location_chk;
ALTER TABLE staff_shifts ADD CONSTRAINT staff_shifts_till_with_location_chk
  CHECK ((location_id IS NULL) = (till_id IS NULL));

-- Una caja abierta por CAJA (antes: por barra).
DROP INDEX IF EXISTS staff_shifts_one_open_till_per_bar;
CREATE UNIQUE INDEX IF NOT EXISTS staff_shifts_one_open_per_till
  ON staff_shifts (till_id) WHERE ended_at IS NULL AND till_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS staff_shifts_location_open_idx
  ON staff_shifts (location_id) WHERE ended_at IS NULL AND location_id IS NOT NULL;

COMMENT ON COLUMN staff_shifts.till_id IS
  'La caja de este turno (D126). Va junto con location_id: o las dos o ninguna. No se cambia una vez escrita.';

-- Se pone sola cuando el lugar tiene una sola caja; tiene que ser de ese lugar; y no
-- se cambia (es la base del corte, igual que la barra y el fondo).
CREATE OR REPLACE FUNCTION staff_shifts_till_id_guard() RETURNS trigger AS $$
DECLARE
  till_loc UUID;
BEGIN
  IF NEW.location_id IS NOT NULL AND NEW.till_id IS NULL THEN
    NEW.till_id := till_of_location(NEW.location_id);
    IF NEW.till_id IS NULL THEN
      RAISE EXCEPTION 'staff_shifts: ese lugar tiene varias cajas; di cuál'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'staff_shifts_till_ambiguous';
    END IF;
  END IF;
  IF NEW.till_id IS NOT NULL THEN
    SELECT location_id INTO till_loc FROM tills WHERE id = NEW.till_id;
    IF till_loc IS DISTINCT FROM NEW.location_id THEN
      RAISE EXCEPTION 'staff_shifts: esa caja no es de ese lugar'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.till_id IS NOT NULL
     AND NEW.till_id IS DISTINCT FROM OLD.till_id THEN
    RAISE EXCEPTION 'staff_shifts: la caja de un turno no se cambia (id=%)', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS staff_shifts_till_id_check ON staff_shifts;
CREATE TRIGGER staff_shifts_till_id_check
  BEFORE INSERT OR UPDATE ON staff_shifts
  FOR EACH ROW EXECUTE FUNCTION staff_shifts_till_id_guard();

-- ---------------------------------------------------------------------------
-- 3. El rol de la noche: a qué caja va el cajero (y la anfitriona de Cover).
-- ---------------------------------------------------------------------------
ALTER TABLE shift_assignments
  ADD COLUMN IF NOT EXISTS till_id UUID REFERENCES tills(id) ON DELETE CASCADE;

UPDATE shift_assignments a SET till_id = t.id
  FROM tills t
 WHERE a.role IN ('cashier', 'hostess') AND a.location_id IS NOT NULL AND a.till_id IS NULL
   AND t.location_id = a.location_id;

-- Sin índice único por caja: el club ya pone a veces a dos personas en el mismo lugar
-- (la de respaldo). La que abre primero se queda la caja; el índice de abajo
-- (`staff_shifts_one_open_per_till`) es el que impide dos cajas abiertas en una.
CREATE INDEX IF NOT EXISTS shift_assignments_till_idx
  ON shift_assignments (event_id, till_id) WHERE till_id IS NOT NULL;

COMMENT ON COLUMN shift_assignments.till_id IS
  'La caja (D126) del cajero o de la anfitriona de Cover. Si el lugar tiene una sola caja se pone sola.';

CREATE OR REPLACE FUNCTION shift_assignments_till_guard() RETURNS trigger AS $$
DECLARE
  till_loc UUID;
BEGIN
  IF NEW.role NOT IN ('cashier', 'hostess') OR NEW.location_id IS NULL THEN
    IF NEW.till_id IS NOT NULL THEN
      RAISE EXCEPTION 'shift_assignments: solo el cajero y la anfitriona de Cover llevan caja'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.till_id IS NULL THEN
    NEW.till_id := till_of_location(NEW.location_id);
  END IF;
  IF NEW.till_id IS NOT NULL THEN
    SELECT location_id INTO till_loc FROM tills WHERE id = NEW.till_id;
    IF till_loc IS DISTINCT FROM NEW.location_id THEN
      RAISE EXCEPTION 'shift_assignments: esa caja no es de ese lugar'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS shift_assignments_till_check ON shift_assignments;
CREATE TRIGGER shift_assignments_till_check
  BEFORE INSERT OR UPDATE ON shift_assignments
  FOR EACH ROW EXECUTE FUNCTION shift_assignments_till_guard();

-- ---------------------------------------------------------------------------
-- 4. La impresora de recibos es de la caja.
-- ---------------------------------------------------------------------------
ALTER TABLE printers
  ADD COLUMN IF NOT EXISTS till_id UUID REFERENCES tills(id) ON DELETE RESTRICT;

UPDATE printers p SET till_id = t.id
  FROM tills t
 WHERE p.purpose = 'till' AND p.location_id IS NOT NULL AND p.till_id IS NULL
   AND t.location_id = p.location_id;

-- Una impresora de recibos por caja (antes: por barra). Comandas y servicio siguen
-- siendo una por barra.
DROP INDEX IF EXISTS printers_one_per_purpose_idx;
CREATE UNIQUE INDEX IF NOT EXISTS printers_one_per_purpose_idx
  ON printers (location_id, purpose) WHERE active AND purpose <> 'till';
CREATE UNIQUE INDEX IF NOT EXISTS printers_one_per_till_idx
  ON printers (till_id) WHERE active AND purpose = 'till';

ALTER TABLE printers DROP CONSTRAINT IF EXISTS printers_till_needs_till_chk;
ALTER TABLE printers ADD CONSTRAINT printers_till_needs_till_chk
  CHECK ((purpose = 'till') = (till_id IS NOT NULL));

COMMENT ON COLUMN printers.till_id IS
  'La caja (D126) de una impresora de recibos. Solo uso `till`; el lugar es el de la caja.';

CREATE OR REPLACE FUNCTION printers_till_guard() RETURNS trigger AS $$
DECLARE
  till_loc UUID;
BEGIN
  IF NEW.purpose = 'till' THEN
    IF NEW.till_id IS NULL AND NEW.location_id IS NOT NULL THEN
      NEW.till_id := till_of_location(NEW.location_id);
      IF NEW.till_id IS NULL THEN
        RAISE EXCEPTION 'printers: ese lugar tiene varias cajas; di de cuál es la impresora'
          USING ERRCODE = 'check_violation', CONSTRAINT = 'printers_till_ambiguous';
      END IF;
    END IF;
    IF NEW.till_id IS NOT NULL THEN
      SELECT location_id INTO till_loc FROM tills WHERE id = NEW.till_id;
      IF NEW.location_id IS NULL THEN
        NEW.location_id := till_loc;
      ELSIF till_loc IS DISTINCT FROM NEW.location_id THEN
        RAISE EXCEPTION 'printers: esa caja no es de ese lugar'
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  ELSE
    NEW.till_id := NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Antes que el disparador que revisa el lugar (los BEFORE corren por nombre): así el
-- lugar ya viene puesto cuando se dio solo la caja.
DROP TRIGGER IF EXISTS printers_a_till_check ON printers;
CREATE TRIGGER printers_a_till_check
  BEFORE INSERT OR UPDATE ON printers
  FOR EACH ROW EXECUTE FUNCTION printers_till_guard();

-- ---------------------------------------------------------------------------
-- 5. La terminal Point es de la caja (D100 decía "del lugar").
-- ---------------------------------------------------------------------------
ALTER TABLE payment_terminals
  ADD COLUMN IF NOT EXISTS till_id UUID REFERENCES tills(id) ON DELETE SET NULL;

UPDATE payment_terminals p SET till_id = t.id
  FROM tills t
 WHERE p.location_id IS NOT NULL AND p.till_id IS NULL AND t.location_id = p.location_id;

DROP INDEX IF EXISTS payment_terminals_location_uidx;
CREATE UNIQUE INDEX IF NOT EXISTS payment_terminals_till_uidx
  ON payment_terminals (till_id) WHERE active AND till_id IS NOT NULL;

COMMENT ON COLUMN payment_terminals.till_id IS
  'La caja (D126) donde vive la terminal; el cobro de esa caja sale por ella.';

CREATE OR REPLACE FUNCTION payment_terminals_till_guard() RETURNS trigger AS $$
DECLARE
  till_loc UUID;
BEGIN
  IF NEW.location_id IS NULL THEN
    NEW.till_id := NULL;
    RETURN NEW;
  END IF;
  IF NEW.till_id IS NULL OR (TG_OP = 'UPDATE' AND NEW.location_id IS DISTINCT FROM OLD.location_id
                             AND NEW.till_id IS NOT DISTINCT FROM OLD.till_id) THEN
    NEW.till_id := till_of_location(NEW.location_id);
    IF NEW.till_id IS NULL THEN
      RAISE EXCEPTION 'payment_terminals: ese lugar tiene varias cajas; di de cuál es la terminal'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'payment_terminals_till_ambiguous';
    END IF;
  END IF;
  SELECT location_id INTO till_loc FROM tills WHERE id = NEW.till_id;
  IF till_loc IS DISTINCT FROM NEW.location_id THEN
    RAISE EXCEPTION 'payment_terminals: esa caja no es de ese lugar'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS payment_terminals_till_check ON payment_terminals;
CREATE TRIGGER payment_terminals_till_check
  BEFORE INSERT OR UPDATE ON payment_terminals
  FOR EACH ROW EXECUTE FUNCTION payment_terminals_till_guard();
