-- ============================================================================
-- Migration 055: consumo del personal (D101).
--
-- Un empleado pide una bebida para si desde su telefono. No paga en la caja: lo que
-- consume se le descuenta del pago, con un porcentaje de descuento para el personal
-- que fija el gerente. El pedido lleva el NOMBRE y el PUESTO de quien lo pide, y el
-- gerente ve cada semana cuanto se le va a descontar a cada quien.
--
-- Reglas:
--   * El porcentaje lo escribe el gerente. Sin porcentaje configurado la funcion esta
--     apagada: el sistema no inventa un descuento.
--   * El nombre y el puesto se guardan COPIADOS en el momento del pedido: si despues
--     le cambian el puesto o el nombre, el reporte de esa semana sigue diciendo lo que
--     paso.
--   * La semana de pago va de jueves a miercoles, medida sobre la "noche" del club
--     (las 6 de la manana cierran el dia), no sobre el reloj: un trago de las 2 am del
--     viernes es del jueves.
--   * El consumo del personal NO es una venta: no tiene cobro en el libro, no entra a
--     la caja ni a los cortes, y no cuenta como ingreso de la noche.
-- ============================================================================

ALTER TABLE drink_orders
  ADD COLUMN IF NOT EXISTS staff_consumption BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS staff_consumption_settings (
  nightclub_id UUID PRIMARY KEY REFERENCES nightclubs(id) ON DELETE CASCADE,
  -- Porcentaje de descuento sobre el precio de lista. 0 = se descuenta el precio
  -- completo; 100 = el club invita. NULL no existe: sin renglon, la funcion esta apagada.
  discount_pct NUMERIC(5,2) NOT NULL CHECK (discount_pct >= 0 AND discount_pct <= 100),
  updated_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS staff_consumptions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nightclub_id  UUID NOT NULL REFERENCES nightclubs(id) ON DELETE CASCADE,
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  -- Copias del momento del pedido.
  user_name     VARCHAR(120) NOT NULL,
  user_role     VARCHAR(20)  NOT NULL,
  order_id      UUID NOT NULL UNIQUE REFERENCES drink_orders(id) ON DELETE RESTRICT,
  list_total    NUMERIC(12,2) NOT NULL CHECK (list_total >= 0),
  discount_pct  NUMERIC(5,2)  NOT NULL CHECK (discount_pct >= 0 AND discount_pct <= 100),
  -- Lo que se le descuenta: list_total menos el descuento, a dos decimales.
  amount        NUMERIC(12,2) NOT NULL CHECK (amount >= 0),
  currency      CHAR(3) NOT NULL CHECK (currency IN ('MXN','USD')),
  -- La noche del club y el jueves que abre su semana de pago.
  business_date DATE NOT NULL,
  week_start    DATE NOT NULL,
  status        VARCHAR(10) NOT NULL DEFAULT 'active' CHECK (status IN ('active','cancelled')),
  cancelled_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (amount <= list_total),
  CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS staff_consumptions_week_idx
  ON staff_consumptions (nightclub_id, week_start, user_id);
CREATE INDEX IF NOT EXISTS staff_consumptions_user_idx
  ON staff_consumptions (user_id, week_start);
