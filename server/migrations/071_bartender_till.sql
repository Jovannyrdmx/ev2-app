-- ============================================================================
-- Migration 071: el bartender también cobra, con su propia caja (D128).
--
-- Hasta D77 el bartender solo preparaba. Ahora cobra la VENTA DIRECTA de su barra (lo
-- que le pide el cliente parado enfrente) con una caja suya: fondo con PIN del
-- gerente, corte, corte X, retiros y entradas, y su cajón en la misma impresora USB
-- donde salen sus comandas. Los pedidos de meseros siguen siendo del cajero.
--
--   * `tills.operator`: quién opera esa caja. `cashier` (el cajero; en Cover, la
--     anfitriona) o `bartender`. Las cajas de antes son todas `cashier`.
--   * `till_of_location(lugar)` —la caja que se sobreentiende cuando solo se dice el
--     lugar— cuenta solo las de cajero: agregar la del bartender a una barra no vuelve
--     "ambigua" la caja del cajero.
--   * El rol de la noche pone al bartender en su caja (si su barra tiene una).
-- ============================================================================

ALTER TABLE tills
  ADD COLUMN IF NOT EXISTS operator VARCHAR(12) NOT NULL DEFAULT 'cashier'
  CHECK (operator IN ('cashier', 'bartender'));

COMMENT ON COLUMN tills.operator IS
  'Quién opera la caja (D128): cashier (cajero; en Cover la anfitriona) o bartender (solo venta directa).';


CREATE OR REPLACE FUNCTION tills_operator_guard() RETURNS trigger AS $$
DECLARE
  loc_kind VARCHAR(12);
BEGIN
  IF NEW.operator = 'bartender' THEN
    SELECT kind INTO loc_kind FROM supply_locations WHERE id = NEW.location_id;
    IF loc_kind IS DISTINCT FROM 'bar' THEN
      RAISE EXCEPTION 'tills: la caja del bartender va en una barra'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.operator IS DISTINCT FROM OLD.operator THEN
    RAISE EXCEPTION 'tills: quién opera una caja no se cambia (id=%)', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tills_operator_check ON tills;
CREATE TRIGGER tills_operator_check
  BEFORE INSERT OR UPDATE ON tills
  FOR EACH ROW EXECUTE FUNCTION tills_operator_guard();

-- La caja que se sobreentiende: solo entre las del cajero.
CREATE OR REPLACE FUNCTION till_of_location(loc UUID) RETURNS UUID AS $$
  SELECT CASE WHEN count(*) = 1 THEN (array_agg(id))[1] END
    FROM tills WHERE location_id = loc AND active AND operator = 'cashier';
$$ LANGUAGE sql STABLE;

-- El rol de la noche: el bartender también lleva caja (la de bartender de su barra).
CREATE OR REPLACE FUNCTION shift_assignments_till_guard() RETURNS trigger AS $$
DECLARE
  till_loc UUID;
  till_op  VARCHAR(12);
BEGIN
  IF NEW.role NOT IN ('cashier', 'hostess', 'bartender') OR NEW.location_id IS NULL THEN
    IF NEW.till_id IS NOT NULL THEN
      RAISE EXCEPTION 'shift_assignments: ese puesto no lleva caja'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.till_id IS NULL AND NEW.role <> 'bartender' THEN
    NEW.till_id := till_of_location(NEW.location_id);
  END IF;
  IF NEW.till_id IS NOT NULL THEN
    SELECT location_id, operator INTO till_loc, till_op FROM tills WHERE id = NEW.till_id;
    IF till_loc IS DISTINCT FROM NEW.location_id THEN
      RAISE EXCEPTION 'shift_assignments: esa caja no es de ese lugar'
        USING ERRCODE = 'check_violation';
    END IF;
    IF (NEW.role = 'bartender') IS DISTINCT FROM (till_op = 'bartender') THEN
      RAISE EXCEPTION 'shift_assignments: esa caja es de otro puesto'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
