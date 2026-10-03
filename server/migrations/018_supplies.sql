-- ============================================================================
-- Migration 018: la existencia vive en el insumo, en una barra concreta.
--
-- Hasta ahora cada producto vendible cargaba su propio contador. En el catalogo
-- real del club `BUCHANANS 12 - SPRITE` (un trago de $150) y `BUCHANANS 12` (una
-- botella de $2,650) son dos productos distintos, asi que vender seis tragos
-- descontaba un contador que nadie rellena mientras el de la botella seguia
-- intacto. El numero en pantalla no estaba equivocado por poco: no tenia relacion
-- con nada de lo que hay en la bodega.
--
-- De aqui en adelante la existencia pertenece al INSUMO -- la botella de 750 ml de
-- Buchanan's 12, la caja de Sprite, la cerveza -- y cada producto de la carta
-- carga una RECETA que dice cuanto de cual insumo consume. Seis tragos y una
-- botella entera bajan de la misma botella, que es lo que de verdad ocurre
-- detras de la barra.
--
-- Y pertenece a un LUGAR. El club tiene almacen, barra de planta baja y barra de
-- planta alta, y las mismas 30 botellas de Absolut Mango repartidas 10/15/5 no son
-- lo mismo que 30 en un solo monton: si la barra de arriba se queda sin mango, de
-- nada sirve que el almacen tenga diez. Cada barra atiende las zonas que le
-- asigna el administrador, el pedido de una mesa baja de la barra que atiende su
-- zona, y mover producto de un lugar a otro es un traspaso con responsable, no una
-- correccion silenciosa.
--
-- Que significa la "existencia" de un producto: cuantos se pueden servir todavia
-- en esa barra -- el minimo entre sus ingredientes. Se calcula, nunca se guarda,
-- para que no pueda alejarse de los insumos de los que depende.
--
-- Un producto SIN receta no tiene control de existencia: se vende libre y la app
-- dice "no se lleva" en vez de ensenar un numero. Esa es la respuesta honesta
-- mientras el club termina de capturar sus recetas, y es la razon por la que esta
-- migracion no inventa un saldo inicial para nada: las cantidades reales entran
-- por una recepcion de mercancia o por un conteo fisico, y por ningun otro lado.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Donde vive el producto
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS supply_locations (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nightclub_id   UUID NOT NULL REFERENCES nightclubs(id) ON DELETE CASCADE,
  -- Corto y estable (`almacen`, `barra-baja`, `barra-alta`): es lo que usan las
  -- semillas y las pantallas para referirse a un lugar sin cargar su UUID.
  code           VARCHAR(30) NOT NULL,
  name           VARCHAR(80) NOT NULL,
  kind           VARCHAR(12) NOT NULL CHECK (kind IN ('warehouse', 'bar')),
  -- La planta que atiende una barra. El almacen no atiende ninguna.
  floor          VARCHAR(10),
  sort_order     INTEGER NOT NULL DEFAULT 0,
  active         BOOLEAN NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (nightclub_id, code)
);
CREATE INDEX IF NOT EXISTS supply_locations_club_idx ON supply_locations (nightclub_id, kind, active);

DROP TRIGGER IF EXISTS supply_locations_set_updated_at ON supply_locations;
CREATE TRIGGER supply_locations_set_updated_at
  BEFORE UPDATE ON supply_locations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Que barra atiende cada zona del plano. Es una tabla y no una columna en `tables`
-- porque el gerente reasigna zonas completas a media noche -- "la terraza pasa a
-- la barra de arriba" -- y hacerlo mesa por mesa es como se queda una fuera.
CREATE TABLE IF NOT EXISTS zone_bars (
  nightclub_id   UUID NOT NULL REFERENCES nightclubs(id) ON DELETE CASCADE,
  section        VARCHAR(40) NOT NULL,
  location_id    UUID NOT NULL REFERENCES supply_locations(id) ON DELETE RESTRICT,
  updated_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (nightclub_id, section)
);
CREATE INDEX IF NOT EXISTS zone_bars_location_idx ON zone_bars (location_id);

-- Una zona no se puede asignar al almacen: el almacen no sirve tragos. Se valida
-- con un disparador porque la llave foranea no sabe mirar la columna `kind`.
CREATE OR REPLACE FUNCTION zone_bars_target_must_be_a_bar() RETURNS trigger AS $$
DECLARE
  target_kind VARCHAR(12);
  target_club UUID;
BEGIN
  SELECT kind, nightclub_id INTO target_kind, target_club
    FROM supply_locations WHERE id = NEW.location_id;
  IF target_kind IS DISTINCT FROM 'bar' THEN
    RAISE EXCEPTION 'zone_bars.location_id must point at a bar, not %', COALESCE(target_kind, 'nothing')
      USING ERRCODE = 'check_violation';
  END IF;
  IF target_club IS DISTINCT FROM NEW.nightclub_id THEN
    RAISE EXCEPTION 'zone_bars: the bar belongs to another nightclub'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS zone_bars_check_target ON zone_bars;
CREATE TRIGGER zone_bars_check_target
  BEFORE INSERT OR UPDATE ON zone_bars
  FOR EACH ROW EXECUTE FUNCTION zone_bars_target_must_be_a_bar();

-- ---------------------------------------------------------------------------
-- Que compra y cuenta el club
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS supplies (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nightclub_id   UUID NOT NULL REFERENCES nightclubs(id) ON DELETE CASCADE,
  name           VARCHAR(120) NOT NULL,
  category       VARCHAR(40),
  -- La unidad base en la que se mide todo. Existencia, receta y costo hablan esta
  -- unidad, asi que nunca hay una conversion que equivocar en el punto de venta.
  unit           VARCHAR(8) NOT NULL CHECK (unit IN ('ml', 'g', 'pza')),
  -- Cuanto de la unidad base trae una presentacion: 750 para una botella de 750 ml,
  -- 1 para una cerveza. Es lo que permite decir "quedan 3.5 botellas" en vez de
  -- "quedan 2,630 ml", que es la unica forma en que un humano puede comprobarlo
  -- mirando el estante.
  package_size   NUMERIC(12,3) NOT NULL CHECK (package_size > 0),
  package_label  VARCHAR(60),
  -- false = nadie ha confirmado el tamano de esta presentacion. Se carga con un
  -- valor por omision para poder operar, pero la pantalla de almacen lo pide antes
  -- del primer conteo en vez de fingir que se sabe.
  size_confirmed BOOLEAN NOT NULL DEFAULT true,
  -- Costo promedio ponderado por unidad base, recalculado en cada recepcion. Cero
  -- significa que todavia no se recibe nada -- no que sea gratis.
  avg_cost       NUMERIC(14,6) NOT NULL DEFAULT 0 CHECK (avg_cost >= 0),
  pos_id         VARCHAR(60),
  active         BOOLEAN NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Dos insumos con el mismo nombre en un club es como una bodega termina con dos
-- renglones a medias de la misma botella. Sin distinguir mayusculas ni espacios.
CREATE UNIQUE INDEX IF NOT EXISTS supplies_name_unique
  ON supplies (nightclub_id, lower(btrim(name)));
CREATE UNIQUE INDEX IF NOT EXISTS supplies_pos_id_unique
  ON supplies (nightclub_id, pos_id) WHERE pos_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS supplies_club_active_idx ON supplies (nightclub_id, active);

DROP TRIGGER IF EXISTS supplies_set_updated_at ON supplies;
CREATE TRIGGER supplies_set_updated_at
  BEFORE UPDATE ON supplies
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- El saldo, por lugar. Nunca se edita a mano: cada cambio pasa por
-- `supply_movements`, asi que el saldo siempre trae un motivo pegado.
CREATE TABLE IF NOT EXISTS supply_stock (
  supply_id      UUID NOT NULL REFERENCES supplies(id) ON DELETE CASCADE,
  location_id    UUID NOT NULL REFERENCES supply_locations(id) ON DELETE RESTRICT,
  stock          NUMERIC(14,3) NOT NULL DEFAULT 0,
  -- El minimo es por lugar: la barra de arriba se surte cuando baja de dos
  -- botellas, el almacen cuando baja de una caja. Un solo minimo para los dos
  -- avisa tarde en un lado y de mas en el otro.
  min_stock      NUMERIC(14,3) NOT NULL DEFAULT 0 CHECK (min_stock >= 0),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (supply_id, location_id)
);
CREATE INDEX IF NOT EXISTS supply_stock_location_idx ON supply_stock (location_id);

-- ---------------------------------------------------------------------------
-- El kardex
-- ---------------------------------------------------------------------------
-- Solo inserciones, como `transactions`: el saldo es la suma de su historia, y un
-- numero de existencia que nadie puede explicar es peor que no tener numero.
CREATE TABLE IF NOT EXISTS supply_movements (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nightclub_id   UUID NOT NULL REFERENCES nightclubs(id) ON DELETE CASCADE,
  supply_id      UUID NOT NULL REFERENCES supplies(id) ON DELETE RESTRICT,
  -- El lugar cuyo saldo cambia en ESTE renglon. Un traspaso son dos renglones
  -- -- uno que sale de un lado y otro que entra en el otro -- unidos por
  -- `transfer_group`, para que `balance_after` siga significando algo en cada uno.
  location_id    UUID NOT NULL REFERENCES supply_locations(id) ON DELETE RESTRICT,
  counterpart_location_id UUID REFERENCES supply_locations(id) ON DELETE RESTRICT,
  transfer_group UUID,
  kind           VARCHAR(20) NOT NULL
                 CHECK (kind IN ('receipt', 'issue', 'transfer_in', 'transfer_out',
                                 'consumption', 'return', 'waste', 'courtesy',
                                 'count', 'adjustment')),
  -- Con signo, en la unidad base del insumo: positivo entra, negativo sale.
  quantity       NUMERIC(14,3) NOT NULL CHECK (quantity <> 0),
  balance_after  NUMERIC(14,3) NOT NULL,
  unit_cost      NUMERIC(14,6),
  reference_type VARCHAR(30),
  reference_id   UUID,
  -- Obligatorio para todo lo que decide una persona a mano. Un conteo o una rotura
  -- sin motivo es indistinguible de un robo, que es exactamente lo que esta columna
  -- existe para poder separar.
  reason         VARCHAR(200),
  created_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  -- Quien lo autorizo, cuando no es quien lo captura: una merma de una botella de
  -- $3,000 la firma el gerente, no el cantinero que la tiro.
  authorized_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS supply_movements_supply_idx
  ON supply_movements (supply_id, location_id, created_at DESC);
CREATE INDEX IF NOT EXISTS supply_movements_club_idx
  ON supply_movements (nightclub_id, created_at DESC);
CREATE INDEX IF NOT EXISTS supply_movements_reference_idx
  ON supply_movements (reference_type, reference_id);
CREATE INDEX IF NOT EXISTS supply_movements_transfer_idx
  ON supply_movements (transfer_group) WHERE transfer_group IS NOT NULL;

-- El kardex es evidencia, asi que tampoco se edita.
CREATE OR REPLACE FUNCTION supply_movements_are_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'supply_movements is insert-only: correct a balance with a new movement';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS supply_movements_no_update ON supply_movements;
CREATE TRIGGER supply_movements_no_update
  BEFORE UPDATE OR DELETE ON supply_movements
  FOR EACH ROW EXECUTE FUNCTION supply_movements_are_immutable();

-- ---------------------------------------------------------------------------
-- La receta
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS drink_supplies (
  drink_id   UUID NOT NULL REFERENCES drinks(id) ON DELETE CASCADE,
  supply_id  UUID NOT NULL REFERENCES supplies(id) ON DELETE RESTRICT,
  -- En la unidad base del insumo. 30 ml de whisky (la onza de la barra), 1 pza de
  -- cerveza, 750 ml para una botella que se vende entera.
  quantity   NUMERIC(12,3) NOT NULL CHECK (quantity > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (drink_id, supply_id)
);
CREATE INDEX IF NOT EXISTS drink_supplies_supply_idx ON drink_supplies (supply_id);

DROP TRIGGER IF EXISTS drink_supplies_set_updated_at ON drink_supplies;
CREATE TRIGGER drink_supplies_set_updated_at
  BEFORE UPDATE ON drink_supplies
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- A donde se lleva el pedido
-- ---------------------------------------------------------------------------
-- No todo el que pide esta en una mesa. En la pista se pide desde donde se este
-- bailando, y el mesero necesita un punto concreto al que llegar: "Pista A",
-- "Pista B", "Terraza". Cada punto tiene su QR pegado, y el QR lleva un token
-- opaco -- ni el nombre del cliente, ni la mesa, ni nada que sirva de algo si
-- alguien lo fotografia.
CREATE TABLE IF NOT EXISTS delivery_points (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nightclub_id   UUID NOT NULL REFERENCES nightclubs(id) ON DELETE CASCADE,
  code           VARCHAR(30) NOT NULL,
  name           VARCHAR(80) NOT NULL,
  kind           VARCHAR(16) NOT NULL CHECK (kind IN ('table', 'floor', 'terrace', 'bar')),
  -- Cuando el punto ES una mesa, apunta a ella: el pedido queda ligado a la mesa
  -- de verdad y no a una copia con su nombre.
  table_id       UUID REFERENCES tables(id) ON DELETE CASCADE,
  section        VARCHAR(40),
  floor          VARCHAR(10),
  qr_token       VARCHAR(64) NOT NULL,
  -- La barra no se elige desde el telefono en esta version: el club no quiere
  -- gente amontonada en la barra esperando su trago.
  client_selectable BOOLEAN NOT NULL DEFAULT true,
  active         BOOLEAN NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (nightclub_id, code)
);
CREATE UNIQUE INDEX IF NOT EXISTS delivery_points_qr_unique ON delivery_points (qr_token);
CREATE UNIQUE INDEX IF NOT EXISTS delivery_points_table_unique
  ON delivery_points (table_id) WHERE table_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS delivery_points_club_idx ON delivery_points (nightclub_id, active);

DROP TRIGGER IF EXISTS delivery_points_set_updated_at ON delivery_points;
CREATE TRIGGER delivery_points_set_updated_at
  BEFORE UPDATE ON delivery_points
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- El pedido: de que barra sale y a donde va
-- ---------------------------------------------------------------------------
ALTER TABLE drink_orders
  ADD COLUMN IF NOT EXISTS bar_location_id UUID REFERENCES supply_locations(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS delivery_point_id UUID REFERENCES delivery_points(id) ON DELETE SET NULL,
  -- Cuando la barra empezo a prepararlo de verdad. La cola del mesero se ordena
  -- por la hora en que quedo listo, no por la hora en que se pidio: sirve para
  -- saber que trago lleva mas tiempo en la barra enfriandose.
  ADD COLUMN IF NOT EXISTS prep_started_at TIMESTAMPTZ,
  -- El orden en que el cantinero decidio prepararlos. Puede mover la tarjeta de
  -- lugar por eficiencia -- tres tragos del mismo whisky se hacen juntos -- sin que
  -- eso toque `created_at` ni la hora de pago, que son las que auditan la cola.
  ADD COLUMN IF NOT EXISTS bar_position INTEGER;

CREATE INDEX IF NOT EXISTS drink_orders_bar_queue_idx
  ON drink_orders (bar_location_id, status, created_at)
  WHERE bar_location_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Quien mueve el almacen
--
-- Hasta ahora todo lo que tocaba existencias lo hacia el gerente, porque no habia
-- nadie mas. En un club con almacen de verdad hay quien recibe la mercancia, la
-- surte a las barras y cuenta al cerrar, y no es la misma persona que autoriza una
-- merma de una botella de $3,000. Separarlos es la mitad del control.
-- ---------------------------------------------------------------------------
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN (
  'guest','waiter','bartender','dancer','dj','light_tech','valet','hostess','driver',
  'warehouse','manager','admin'));

-- ---------------------------------------------------------------------------
-- La tabla `inventory` vieja
--
-- Se elimina. Sus numeros venian de la semilla de la carta, que le daba a cada
-- producto nuevo 12 (botellas) o 100 (todo lo demas) para poder vender la primera
-- noche -- cifras inventadas. Arrastrarlas al modelo nuevo seria blanquearlas
-- como si fueran algo medido, y ahora hay 129 recetas reales que las reemplazan.
-- ---------------------------------------------------------------------------
DROP TABLE IF EXISTS inventory;
