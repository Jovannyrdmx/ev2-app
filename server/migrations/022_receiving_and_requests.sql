-- ============================================================================
-- Migration 022: de quien llega la mercancia, y como la pide una barra.
--
-- La migracion 018 dejo la existencia bien puesta -- el insumo, EN UN LUGAR, con
-- su kardex -- y dos puertas para moverla: `receive` (entra al club) y `transfer`
-- (del almacen a una barra). Lo que faltaba no es el movimiento: es el CONTEXTO.
--
-- ---------------------------------------------------------------------------
-- Lo que faltaba, en concreto
-- ---------------------------------------------------------------------------
-- 1. Un movimiento de entrada no decia DE QUIEN vino. Asi no hay manera de
--    contestar "cuanto le compre a este proveedor este mes", ni de notar que un
--    insumo llego de alguien que nunca lo surte -- que es como entra producto que
--    nadie pidio.
--
-- 2. Cada entrada se capturaba de una en una. Un camion llega con quince
--    renglones, y quince capturas sueltas son quince oportunidades de que la
--    novena se quede a medias y el inventario diga una cosa y la bodega otra.
--    Aqui las quince comparten `receipt_group` y entran en una sola transaccion:
--    o entran todas o no entra ninguna.
--
-- 3. Surtir una barra era una orden del almacen hacia abajo. Pero quien sabe que
--    le falta es el cantinero, a las once de la noche, mirando su estante. De ahi
--    `bar_requests`: la barra PIDE, el almacen SURTE contra ese pedido, y cada
--    renglon guarda lo pedido Y lo surtido -- que son distintos mas seguido de lo
--    que nadie quiere admitir, y es lo unico que despues contesta "pedi doce y me
--    llegaron ocho".
--
-- No se crea una tabla de "recepciones" con folio de factura y total. Fue una
-- decision explicita del dueno: se captura en lote, sin documento. `receipt_group`
-- queda sembrado para que el dia que se quiera el comprobante se construya encima
-- sin mover nada de lo que ya este capturado.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Los proveedores
--
-- El unico por nombre va sobre `lower(name)` a proposito. Sin eso, en tres meses
-- hay "Corona", "corona sa" y "CORONA S.A." como tres proveedores distintos, y la
-- pregunta "cuanto le compro a Corona" deja de tener respuesta -- que es
-- exactamente para lo que existe esta tabla.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS suppliers (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nightclub_id UUID NOT NULL REFERENCES nightclubs(id) ON DELETE CASCADE,
  name         VARCHAR(120) NOT NULL,
  contact_name VARCHAR(120),
  phone        VARCHAR(30),
  email        VARCHAR(255),
  notes        VARCHAR(400),
  -- Baja LOGICA y no borrado: un proveedor con entradas capturadas no se puede
  -- borrar sin dejar huerfano el historial de compras. Se apaga y deja de aparecer
  -- en la lista de captura, pero el kardex sigue pudiendo decir de donde vino
  -- aquella caja.
  active       BOOLEAN NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS suppliers_name_unique
  ON suppliers (nightclub_id, lower(name));
CREATE INDEX IF NOT EXISTS suppliers_club_idx ON suppliers (nightclub_id, active);

DROP TRIGGER IF EXISTS suppliers_set_updated_at ON suppliers;
CREATE TRIGGER suppliers_set_updated_at
  BEFORE UPDATE ON suppliers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE suppliers IS
  'A quien le compra el club. Baja logica: un proveedor con compras capturadas no se borra.';

-- ---------------------------------------------------------------------------
-- 2. Quien surte que
--
-- Sirve para dos cosas concretas, las dos en la pantalla de captura: precargar los
-- renglones del proveedor que acaba de llegar (en vez de buscar quince insumos a
-- mano entre doscientos), y avisar -- avisar, no impedir -- cuando entra un insumo
-- de alguien que no lo surte, porque eso casi siempre es un dedo equivocado en el
-- selector de proveedor.
--
-- `last_cost` es lo ultimo que cobro ESE proveedor por ESE insumo, que es distinto
-- del costo promedio del insumo: el promedio sirve para valuar el inventario, este
-- sirve para notar que subio el precio.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS supply_suppliers (
  supply_id    UUID NOT NULL REFERENCES supplies(id) ON DELETE CASCADE,
  supplier_id  UUID NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  -- Costo de la PRESENTACION completa (la caja, la botella), como viene en la
  -- factura. Nadie cotiza por mililitro.
  last_cost    NUMERIC(14,4) CHECK (last_cost IS NULL OR last_cost >= 0),
  last_bought_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (supply_id, supplier_id)
);

CREATE INDEX IF NOT EXISTS supply_suppliers_supplier_idx ON supply_suppliers (supplier_id);

COMMENT ON TABLE supply_suppliers IS
  'Que proveedor surte que insumo, y a que precio la ultima vez. Precarga la captura y avisa de entradas raras.';

-- ---------------------------------------------------------------------------
-- 3. El movimiento gana su contexto
--
-- Tres columnas, todas opcionales, porque los movimientos que ya estan capturados
-- son validos y no se les puede inventar un proveedor a posteriori.
-- ---------------------------------------------------------------------------
ALTER TABLE supply_movements
  -- De quien vino. Solo tiene sentido en una entrada; las salidas y los traspasos
  -- lo dejan nulo.
  ADD COLUMN IF NOT EXISTS supplier_id    UUID REFERENCES suppliers(id) ON DELETE SET NULL,
  -- Une los renglones capturados juntos. Es el hermano de `transfer_group`.
  ADD COLUMN IF NOT EXISTS receipt_group  UUID,
  -- El pedido de barra que origino este traspaso, cuando lo hubo.
  ADD COLUMN IF NOT EXISTS request_id     UUID;

CREATE INDEX IF NOT EXISTS supply_movements_supplier_idx
  ON supply_movements (supplier_id, created_at DESC) WHERE supplier_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS supply_movements_receipt_group_idx
  ON supply_movements (receipt_group) WHERE receipt_group IS NOT NULL;
CREATE INDEX IF NOT EXISTS supply_movements_request_idx
  ON supply_movements (request_id) WHERE request_id IS NOT NULL;

COMMENT ON COLUMN supply_movements.supplier_id IS
  'De quien vino la mercancia. Solo en entradas (migracion 022).';
COMMENT ON COLUMN supply_movements.receipt_group IS
  'Une los renglones de una captura en lote. Hermano de transfer_group (migracion 022).';

-- ---------------------------------------------------------------------------
-- 4. El pedido de la barra
--
-- Estados, y por que son estos cuatro:
--
--   open      -- la barra pidio y nadie lo ha surtido.
--   partial   -- se surtio algo, pero no todo. NO es un estado de tramite: es la
--                verdad de la noche, y tiene que quedar visible para que a la
--                manana siguiente alguien pregunte por los cuatro que faltaron.
--   fulfilled -- se surtio completo.
--   cancelled -- ya no hace falta (cerro la barra, se pidio por error).
--
-- Un pedido cancelado no se vuelve a surtir. Un pedido surtido tampoco: si falta
-- mas producto, se pide otra vez, y asi cada surtido queda contado por separado en
-- vez de volverse un renglon que crece toda la noche y no dice cuando paso que.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bar_requests (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nightclub_id  UUID NOT NULL REFERENCES nightclubs(id) ON DELETE CASCADE,
  -- La barra que pide. Se valida con disparador que sea una barra y no el almacen:
  -- el almacen no se pide producto a si mismo.
  location_id   UUID NOT NULL REFERENCES supply_locations(id) ON DELETE RESTRICT,
  status        VARCHAR(12) NOT NULL DEFAULT 'open'
                CHECK (status IN ('open', 'partial', 'fulfilled', 'cancelled')),
  note          VARCHAR(300),
  requested_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  fulfilled_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  cancelled_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  cancel_reason VARCHAR(200),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  fulfilled_at  TIMESTAMPTZ,
  cancelled_at  TIMESTAMPTZ,

  -- Cancelar sin decir por que es como corregir un saldo sin motivo: no se
  -- distingue de esconder algo.
  CONSTRAINT bar_requests_cancelled_has_a_reason
    CHECK (status <> 'cancelled' OR (cancel_reason IS NOT NULL AND cancelled_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS bar_requests_pending_idx
  ON bar_requests (nightclub_id, status, created_at)
  WHERE status IN ('open', 'partial');
CREATE INDEX IF NOT EXISTS bar_requests_location_idx
  ON bar_requests (location_id, created_at DESC);

DROP TRIGGER IF EXISTS bar_requests_set_updated_at ON bar_requests;
CREATE TRIGGER bar_requests_set_updated_at
  BEFORE UPDATE ON bar_requests
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Mismo criterio que `zone_bars`: la llave foranea no sabe mirar `kind`, asi que
-- el disparador es lo que impide que el almacen se pida producto a si mismo.
CREATE OR REPLACE FUNCTION bar_requests_must_come_from_a_bar() RETURNS trigger AS $$
DECLARE
  target_kind VARCHAR(12);
  target_club UUID;
BEGIN
  SELECT kind, nightclub_id INTO target_kind, target_club
    FROM supply_locations WHERE id = NEW.location_id;
  IF target_kind IS DISTINCT FROM 'bar' THEN
    RAISE EXCEPTION 'bar_requests.location_id must point at a bar, not %', COALESCE(target_kind, 'nothing')
      USING ERRCODE = 'check_violation';
  END IF;
  IF target_club IS DISTINCT FROM NEW.nightclub_id THEN
    RAISE EXCEPTION 'bar_requests: the bar belongs to another nightclub'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS bar_requests_check_location ON bar_requests;
CREATE TRIGGER bar_requests_check_location
  BEFORE INSERT OR UPDATE OF location_id, nightclub_id ON bar_requests
  FOR EACH ROW EXECUTE FUNCTION bar_requests_must_come_from_a_bar();

COMMENT ON TABLE bar_requests IS
  'Lo que una barra le pide al almacen. La barra pide, el almacen surte (migracion 022).';

-- ---------------------------------------------------------------------------
-- 5. Los renglones del pedido
--
-- `quantity` y `fulfilled` en la UNIDAD BASE del insumo (ml, g, pza), igual que
-- todo lo demas del inventario. La pantalla captura botellas y cajas y multiplica
-- por `package_size` antes de mandar: la conversion vive en un solo lugar, para que
-- la base nunca tenga que adivinar si un 12 son doce botellas o doce mililitros.
--
-- `fulfilled` arranca en cero y SUBE cuando el almacen surte. Se guarda en su
-- propia columna en vez de deducirse del kardex porque es lo que la barra ve en su
-- pantalla, y deducirlo obligaria a sumar movimientos cada vez que alguien abre el
-- pedido -- ademas de romperse el dia que un traspaso a esa barra no venga de un
-- pedido.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bar_request_lines (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID NOT NULL REFERENCES bar_requests(id) ON DELETE CASCADE,
  supply_id  UUID NOT NULL REFERENCES supplies(id) ON DELETE RESTRICT,
  quantity   NUMERIC(14,3) NOT NULL CHECK (quantity > 0),
  fulfilled  NUMERIC(14,3) NOT NULL DEFAULT 0 CHECK (fulfilled >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Un insumo una vez por pedido: dos renglones del mismo whisky en el mismo
  -- pedido son un error de captura, y aceptarlos vuelve ambiguo cuanto se surtio.
  CONSTRAINT bar_request_lines_one_per_supply UNIQUE (request_id, supply_id)
);

CREATE INDEX IF NOT EXISTS bar_request_lines_request_idx ON bar_request_lines (request_id);
CREATE INDEX IF NOT EXISTS bar_request_lines_supply_idx ON bar_request_lines (supply_id);

COMMENT ON COLUMN bar_request_lines.quantity IS
  'Lo pedido, en la unidad base del insumo (ml/g/pza). La pantalla convierte desde presentaciones.';
COMMENT ON COLUMN bar_request_lines.fulfilled IS
  'Lo realmente surtido. Distinto de lo pedido mas seguido de lo que nadie quiere admitir.';

-- La llave foranea de `supply_movements.request_id` se agrega AQUI y no arriba
-- porque `bar_requests` todavia no existia en ese punto del archivo. Va sin
-- CASCADE: borrar un pedido no puede borrar movimientos del kardex, que es
-- solo-insercion por diseno.
ALTER TABLE supply_movements
  DROP CONSTRAINT IF EXISTS supply_movements_request_id_fkey;
ALTER TABLE supply_movements
  ADD CONSTRAINT supply_movements_request_id_fkey
  FOREIGN KEY (request_id) REFERENCES bar_requests(id) ON DELETE SET NULL;
