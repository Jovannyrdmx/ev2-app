-- ============================================================================
-- Migration 050: Cover, un lugar que no es barra (D96).
--
-- Una PC y su impresora solo se podian asignar a una BARRA, y el club solo tenia
-- dos: planta baja y planta alta. La entrada -- donde se cobra el cover -- no tenia
-- donde ponerse, asi que su PC no se podia dar de alta con su lugar.
--
-- Darla de alta como "otra barra" la habria metido en existencias, traspasos, la
-- cola del bartender y la asignacion de zonas, donde no significa nada. Por eso es
-- un tipo nuevo: `door`. Solo sirve para imprimir: su PC y su impresora existen
-- para los recibos del cover (proposito `till`), nada mas.
-- ============================================================================

ALTER TABLE supply_locations DROP CONSTRAINT IF EXISTS supply_locations_kind_check;
ALTER TABLE supply_locations ADD CONSTRAINT supply_locations_kind_check
  CHECK (kind IN ('warehouse', 'bar', 'door'));

-- ---------------------------------------------------------------- impresoras
-- En una barra, cualquier proposito. En la puerta, solo recibos de caja: ahi no se
-- preparan comandas ni se imprimen cuentas de mesa.
CREATE OR REPLACE FUNCTION printers_location_must_be_a_bar() RETURNS trigger AS $$
DECLARE
  target_kind VARCHAR(12);
  target_club UUID;
BEGIN
  -- La impresora de la puerta del cajon (propósito `door`, migración 047) no tiene
  -- lugar: la regla de "una barra o Cover" solo aplica cuando sí lo tiene.
  IF NEW.location_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT kind, nightclub_id INTO target_kind, target_club
    FROM supply_locations WHERE id = NEW.location_id;
  IF target_kind IS DISTINCT FROM 'bar' AND target_kind IS DISTINCT FROM 'door' THEN
    RAISE EXCEPTION 'printers.location_id must point at a bar or the door, not %',
      COALESCE(target_kind, 'nothing') USING ERRCODE = 'check_violation';
  END IF;
  IF target_kind = 'door' AND NEW.purpose IS DISTINCT FROM 'till' THEN
    RAISE EXCEPTION 'printers: the door only prints till receipts, not %', NEW.purpose
      USING ERRCODE = 'check_violation';
  END IF;
  IF target_club IS DISTINCT FROM NEW.nightclub_id THEN
    RAISE EXCEPTION 'printers: the bar belongs to another nightclub'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------- PCs
CREATE OR REPLACE FUNCTION print_agents_location_must_be_a_bar() RETURNS trigger AS $$
DECLARE
  target_kind VARCHAR(12);
  target_club UUID;
BEGIN
  IF NEW.location_id IS NULL THEN RETURN NEW; END IF;
  SELECT kind, nightclub_id INTO target_kind, target_club
    FROM supply_locations WHERE id = NEW.location_id;
  IF target_kind IS DISTINCT FROM 'bar' AND target_kind IS DISTINCT FROM 'door' THEN
    RAISE EXCEPTION 'print_agents.location_id must point at a bar or the door, not %',
      COALESCE(target_kind, 'nothing') USING ERRCODE = 'check_violation';
  END IF;
  IF target_kind = 'door' AND NEW.purpose IS NOT NULL AND NEW.purpose <> 'till' THEN
    RAISE EXCEPTION 'print_agents: the door only prints till receipts, not %', NEW.purpose
      USING ERRCODE = 'check_violation';
  END IF;
  IF target_club IS DISTINCT FROM NEW.nightclub_id THEN
    RAISE EXCEPTION 'print_agents: the bar belongs to another nightclub'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------- el lugar
-- Cada club ya existente recibe su Cover. Uno nuevo lo recibe de la semilla.
INSERT INTO supply_locations (nightclub_id, code, name, kind, floor, sort_order)
SELECT n.id, 'cover', 'Cover', 'door', NULL, 3
  FROM nightclubs n
ON CONFLICT (nightclub_id, code) DO NOTHING;

-- ---------------------------------------------------------------- sin existencia
-- Cover no guarda producto: ni recepciones, ni traspasos, ni conteos. Se para en el
-- renglon del estante, que es por donde entra cualquier saldo nuevo.
CREATE OR REPLACE FUNCTION supply_stock_not_at_the_door() RETURNS trigger AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM supply_locations WHERE id = NEW.location_id AND kind = 'door') THEN
    RAISE EXCEPTION 'supply_stock: the door holds no stock'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS supply_stock_check_door ON supply_stock;
CREATE TRIGGER supply_stock_check_door
  BEFORE INSERT ON supply_stock
  FOR EACH ROW EXECUTE FUNCTION supply_stock_not_at_the_door();
