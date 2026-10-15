-- ============================================================================
-- Migration 064: unidades esperadas y "trago especial" en las promociones (D114).
--
-- Compras y reabasto planea los insumos de la próxima noche con el promedio de las
-- últimas noches cerradas del mismo día de la semana. Una promoción rompe ese
-- historial: el 2x1 de mezcal del viernes no se parece a ningún viernes anterior.
-- Por eso la promoción gana dos cosas:
--
--   * `expected_units`: cuántas piezas espera vender el gerente. Si lo captura, ese
--     número reemplaza al pronóstico de esa bebida. Solo en promociones de UNA bebida:
--     en una de categoría no se sabe a qué bebida —y a qué receta— repartirlo, y
--     adivinarlo sería inventar insumos.
--   * `kind = 'special'`: el trago de la noche, el que se va a empujar SIN descuento.
--     No tiene precio, nunca cambia el cobro (el cálculo de precio solo acepta una
--     promoción si deja el total más bajo) y existe para planear: siempre de una
--     bebida.
--
-- Los nombres de los CHECK son los que Postgres les dio en la 056 (no tenían nombre
-- propio); se reemplazan por unos con nombre para que la próxima vez no haya que
-- adivinar.
-- ============================================================================

ALTER TABLE event_promotions
  ADD COLUMN IF NOT EXISTS expected_units INTEGER;

ALTER TABLE event_promotions DROP CONSTRAINT IF EXISTS event_promotions_kind_check;
ALTER TABLE event_promotions DROP CONSTRAINT IF EXISTS event_promotions_check3;
ALTER TABLE event_promotions DROP CONSTRAINT IF EXISTS event_promotions_kind_valid;
ALTER TABLE event_promotions DROP CONSTRAINT IF EXISTS event_promotions_shape;
ALTER TABLE event_promotions DROP CONSTRAINT IF EXISTS event_promotions_expected_units_valid;

ALTER TABLE event_promotions
  ADD CONSTRAINT event_promotions_kind_valid
    CHECK (kind IN ('fixed_price', 'percent', 'n_for_m', 'special')),
  ADD CONSTRAINT event_promotions_shape CHECK (
    (kind = 'fixed_price' AND value IS NOT NULL AND value >= 0
       AND buy_qty IS NULL AND pay_qty IS NULL)
    OR (kind = 'percent' AND value IS NOT NULL AND value > 0 AND value <= 100
       AND buy_qty IS NULL AND pay_qty IS NULL)
    OR (kind = 'n_for_m' AND value IS NULL AND buy_qty IS NOT NULL AND pay_qty IS NOT NULL
       AND buy_qty >= 2 AND pay_qty >= 0 AND pay_qty < buy_qty)
    OR (kind = 'special' AND value IS NULL AND buy_qty IS NULL AND pay_qty IS NULL
       AND drink_id IS NOT NULL)
  ),
  ADD CONSTRAINT event_promotions_expected_units_valid CHECK (
    expected_units IS NULL OR (expected_units > 0 AND drink_id IS NOT NULL)
  );

COMMENT ON COLUMN event_promotions.expected_units IS
  'Piezas que el gerente espera vender esa noche. Reemplaza al pronóstico de la bebida en Compras y reabasto; NULL = usar el pronóstico (D114).';
