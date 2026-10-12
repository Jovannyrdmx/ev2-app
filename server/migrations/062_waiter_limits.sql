-- ============================================================================
-- Migration 062: el saldo del mesero y su tope (D110).
--
-- Desde D77 el pedido del mesero entra a la barra sin pagar y el mesero lleva el
-- dinero a la caja. Lo que entregó y no ha pagado es dinero que trae encima. El gerente
-- puede poner un tope: un monto y/o unos minutos. Pasado cualquiera de los dos, el
-- mesero no manda pedidos nuevos a la barra hasta pagar en la caja lo entregado.
-- Sin tope capturado (NULL) no se bloquea nada, pero el saldo se ve igual.
-- ============================================================================
CREATE TABLE IF NOT EXISTS waiter_limits (
  nightclub_id        UUID PRIMARY KEY REFERENCES nightclubs(id) ON DELETE CASCADE,
  max_unpaid_amount   NUMERIC(12,2) CHECK (max_unpaid_amount IS NULL OR max_unpaid_amount > 0),
  max_unpaid_minutes  INTEGER CHECK (max_unpaid_minutes IS NULL OR max_unpaid_minutes > 0),
  updated_by          UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Para sumar lo que cada mesero entregó y no ha pagado sin recorrer todos los pedidos.
CREATE INDEX IF NOT EXISTS drink_orders_waiter_open_idx
  ON drink_orders (nightclub_id, taken_by, delivered_at)
  WHERE pay_at_till AND status <> 'cancelled';
