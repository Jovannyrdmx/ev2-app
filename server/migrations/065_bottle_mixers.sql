-- ============================================================================
-- Migration 065: el servicio de botella (D117).
--
-- Una botella no sale sola: va con sus mezcladores -- Sprite, agua mineral, jugo --
-- y hasta hoy esos mezcladores no bajaban de ningún lado. La receta de la botella
-- solo descuenta el licor, porque el servicio cambia en cada mesa: una pide cuatro
-- Sprite, otra dos aguas minerales y un arándano.
--
-- Lo que decidió el dueño:
--   * Los mezcladores se ELIGEN AL PEDIR la botella (mesero o cliente).
--   * Cada botella incluye hasta un TOPE propio de mezcladores sin costo; de ahí en
--     adelante cada uno se cobra a su precio extra.
--   * Solo se ofrecen los mezcladores que el gerente dio de alta para el servicio.
--
-- Tres piezas:
--   1. `bottle_mixers`: el catálogo del gerente. Cada uno apunta a un insumo y dice
--      cuánto descuenta (una botella de Sprite de 3 L = 3000 ml) y cuánto cuesta de
--      más cuando se pasa del tope.
--   2. `drinks.included_mixers`: el tope de cada botella. NULL = ese producto no
--      lleva servicio y no se le ofrece selector.
--   3. `drink_order_item_mixers`: lo que llevó de verdad cada botella pedida,
--      congelado al pedirlo (nombre, porción y precio), para que un cambio de precio
--      mañana no reescriba el ticket de hoy.
-- ============================================================================

CREATE TABLE IF NOT EXISTS bottle_mixers (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nightclub_id  UUID NOT NULL REFERENCES nightclubs(id) ON DELETE CASCADE,
  supply_id     UUID NOT NULL REFERENCES supplies(id) ON DELETE RESTRICT,
  -- Como lo ve el mesero y el cliente: "Sprite 3 L", "Agua mineral".
  name          VARCHAR(80) NOT NULL,
  -- Cuánto descuenta UN mezclador, en la unidad base del insumo (ml o pza).
  portion       NUMERIC(12,3) NOT NULL CHECK (portion > 0),
  extra_price   NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (extra_price >= 0),
  active        BOOLEAN NOT NULL DEFAULT true,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (nightclub_id, supply_id)
);
CREATE INDEX IF NOT EXISTS bottle_mixers_club_idx ON bottle_mixers (nightclub_id, active, sort_order);

DROP TRIGGER IF EXISTS bottle_mixers_set_updated_at ON bottle_mixers;
CREATE TRIGGER bottle_mixers_set_updated_at
  BEFORE UPDATE ON bottle_mixers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE drinks
  ADD COLUMN IF NOT EXISTS included_mixers INTEGER;
ALTER TABLE drinks DROP CONSTRAINT IF EXISTS drinks_included_mixers_valid;
ALTER TABLE drinks ADD CONSTRAINT drinks_included_mixers_valid
  CHECK (included_mixers IS NULL OR included_mixers BETWEEN 0 AND 50);

CREATE TABLE IF NOT EXISTS drink_order_item_mixers (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id       UUID NOT NULL REFERENCES drink_orders(id) ON DELETE CASCADE,
  order_item_id  UUID NOT NULL REFERENCES drink_order_items(id) ON DELETE CASCADE,
  mixer_id       UUID REFERENCES bottle_mixers(id) ON DELETE SET NULL,
  supply_id      UUID NOT NULL REFERENCES supplies(id) ON DELETE RESTRICT,
  name           VARCHAR(80) NOT NULL,
  portion        NUMERIC(12,3) NOT NULL CHECK (portion > 0),
  quantity       INTEGER NOT NULL CHECK (quantity > 0),
  included       INTEGER NOT NULL CHECK (included >= 0),
  charged        INTEGER NOT NULL CHECK (charged >= 0),
  unit_price     NUMERIC(12,2) NOT NULL CHECK (unit_price >= 0),
  line_total     NUMERIC(12,2) NOT NULL CHECK (line_total >= 0),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (included + charged = quantity)
);
CREATE INDEX IF NOT EXISTS drink_order_item_mixers_order_idx ON drink_order_item_mixers (order_id);
CREATE INDEX IF NOT EXISTS drink_order_item_mixers_item_idx ON drink_order_item_mixers (order_item_id);
