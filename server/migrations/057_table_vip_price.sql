-- ============================================================================
-- Migration 057: precio y personas POR MESA para las mesas VIP (D103).
--
-- Hasta hoy el precio de reservar una mesa salia de su zona (`zone_pricing`), asi que
-- todas las mesas de una zona costaban igual. En la hoja de precios del club hay mesas
-- de la misma zona con precio y personas distintos (DIAMANTE SUITE: la 38 de 6 personas a
-- $5,000 y la 39 de 8 a $8,000).
--
-- `vip_price` y `vip_capacity` son opcionales. Vacios, la mesa usa lo de su zona como
-- siempre. Llenos, mandan sobre la zona; solo una sobrescritura de la NOCHE
-- (`event_zone_pricing`) manda sobre la mesa, porque esa la puso el gerente para una
-- noche en particular.
-- ============================================================================

ALTER TABLE tables
  ADD COLUMN IF NOT EXISTS vip_price    NUMERIC(12,2) CHECK (vip_price IS NULL OR vip_price >= 0),
  ADD COLUMN IF NOT EXISTS vip_capacity INTEGER CHECK (vip_capacity IS NULL OR vip_capacity > 0);
