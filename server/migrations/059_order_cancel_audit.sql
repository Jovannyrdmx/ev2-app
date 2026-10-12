-- ============================================================================
-- Migration 059: quién cancela un pedido, por qué, y con permiso de quién (D106).
--
-- Antes solo la cancelación del bartender quedaba en la bitácora. El mesero y el
-- cajero cancelaban sin dejar rastro en el pedido, y un trago ya servido "regresaba"
-- al inventario. Ahora el pedido guarda quién lo canceló, el motivo, el gerente que lo
-- autorizó y si el trago ya se había preparado (en ese caso cuenta como merma).
-- ============================================================================
ALTER TABLE drink_orders
  ADD COLUMN IF NOT EXISTS cancelled_by          UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS cancel_reason         VARCHAR(200),
  ADD COLUMN IF NOT EXISTS cancel_authorized_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS cancel_served         BOOLEAN;

CREATE INDEX IF NOT EXISTS drink_orders_cancelled_idx
  ON drink_orders (nightclub_id, cancelled_at) WHERE status = 'cancelled';
