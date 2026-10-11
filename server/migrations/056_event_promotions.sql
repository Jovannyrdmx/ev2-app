-- ============================================================================
-- Migration 056: promociones por evento (D102, parte B).
--
-- El gerente pone bebidas en oferta para una NOCHE (un renglon de events_calendar):
--   * fixed_price : precio fijo por pieza.
--   * percent     : porcentaje de descuento sobre el precio de la carta.
--   * n_for_m     : lleva N, paga M (2x1 = lleva 2, paga 1).
-- Aplica a UNA bebida o a una CATEGORIA, y puede tener horario dentro de la noche
-- (hora del club; si termina antes de empezar cruza la medianoche).
--
-- El precio lo calcula siempre el servidor al crear el pedido. Un renglon con promocion
-- guarda el precio de carta (`list_price`), la promocion aplicada (`promo_id`) y el
-- total del renglon (`line_total`): un 2x1 no se puede expresar como precio x cantidad.
-- Sin promocion `line_total` queda NULL y todo se calcula como siempre.
-- ============================================================================

CREATE TABLE IF NOT EXISTS event_promotions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nightclub_id UUID NOT NULL REFERENCES nightclubs(id) ON DELETE CASCADE,
  event_id     UUID NOT NULL REFERENCES events_calendar(id) ON DELETE CASCADE,
  name         VARCHAR(120) NOT NULL,
  kind         VARCHAR(12) NOT NULL CHECK (kind IN ('fixed_price','percent','n_for_m')),
  drink_id     UUID REFERENCES drinks(id) ON DELETE CASCADE,
  category     VARCHAR(40),
  -- fixed_price: precio por pieza. percent: porcentaje (0-100). n_for_m: no se usa.
  value        NUMERIC(12,2),
  -- n_for_m: lleva buy_qty, paga pay_qty.
  buy_qty      INTEGER,
  pay_qty      INTEGER,
  -- Horario opcional dentro de la noche, hora local del club.
  starts_time  TIME,
  ends_time    TIME,
  active       BOOLEAN NOT NULL DEFAULT true,
  created_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((drink_id IS NOT NULL) <> (category IS NOT NULL)),
  CHECK ((starts_time IS NULL) = (ends_time IS NULL)),
  CHECK (starts_time IS NULL OR starts_time <> ends_time),
  CHECK (
    (kind = 'fixed_price' AND value IS NOT NULL AND value >= 0
       AND buy_qty IS NULL AND pay_qty IS NULL)
    OR (kind = 'percent' AND value IS NOT NULL AND value > 0 AND value <= 100
       AND buy_qty IS NULL AND pay_qty IS NULL)
    OR (kind = 'n_for_m' AND value IS NULL AND buy_qty IS NOT NULL AND pay_qty IS NOT NULL
       AND buy_qty >= 2 AND pay_qty >= 0 AND pay_qty < buy_qty)
  )
);
CREATE INDEX IF NOT EXISTS event_promotions_event_idx
  ON event_promotions (nightclub_id, event_id) WHERE active;

ALTER TABLE drink_order_items
  ADD COLUMN IF NOT EXISTS list_price NUMERIC(12,2) CHECK (list_price >= 0),
  ADD COLUMN IF NOT EXISTS promo_id   UUID REFERENCES event_promotions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS line_total NUMERIC(12,2) CHECK (line_total >= 0);
