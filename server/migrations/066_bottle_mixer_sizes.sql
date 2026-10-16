-- ============================================================================
-- Migration 066: chicos y grandes en el servicio de botella (D117).
--
-- La 065 ya corrió en producción con un solo tope por botella, así que esto va en
-- su propia migración y no editando la 065.
--
-- La regla del dueño: al pedir una botella se eligen primero sus CHICOS (p. ej. 3) y
-- después UN GRANDE O UN CHICO (p. ej. 1).
--   * `bottle_mixers.size`: si el mezclador es chico o grande.
--   * `drinks.included_mixers`: los lugares de chico (sigue siendo el interruptor:
--     NULL = esa botella no ofrece servicio).
--   * `drinks.included_large_mixers`: los lugares de "un grande o un chico". Un grande
--     nunca ocupa un lugar de chico.
--   * `drink_order_item_mixers.size`: el tamaño, congelado en el pedido.
-- Todo lo que ya existe queda como CHICO y con 0 lugares de grande: el servicio se
-- comporta exactamente igual que antes hasta que el gerente lo cambie.
-- ============================================================================

ALTER TABLE bottle_mixers
  ADD COLUMN IF NOT EXISTS size VARCHAR(5) NOT NULL DEFAULT 'small';
ALTER TABLE bottle_mixers DROP CONSTRAINT IF EXISTS bottle_mixers_size_valid;
ALTER TABLE bottle_mixers ADD CONSTRAINT bottle_mixers_size_valid CHECK (size IN ('small', 'large'));

ALTER TABLE drinks
  ADD COLUMN IF NOT EXISTS included_large_mixers INTEGER NOT NULL DEFAULT 0;
ALTER TABLE drinks DROP CONSTRAINT IF EXISTS drinks_included_large_mixers_valid;
ALTER TABLE drinks ADD CONSTRAINT drinks_included_large_mixers_valid
  CHECK (included_large_mixers BETWEEN 0 AND 50);

ALTER TABLE drink_order_item_mixers
  ADD COLUMN IF NOT EXISTS size VARCHAR(5) NOT NULL DEFAULT 'small';
ALTER TABLE drink_order_item_mixers DROP CONSTRAINT IF EXISTS drink_order_item_mixers_size_valid;
ALTER TABLE drink_order_item_mixers ADD CONSTRAINT drink_order_item_mixers_size_valid
  CHECK (size IN ('small', 'large'));
