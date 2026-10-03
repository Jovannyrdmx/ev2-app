-- ============================================================================
-- Migration 028: lo que le faltaba al cobro con terminal para estar completo.
--
-- Se contrastó la integración (D47) con la guía oficial de Mercado Pago Point
-- ("Procesamiento de pagos", Orders API) el 2026-09-21. Esta migración cubre las tres
-- cosas de esa guía que el esquema no podía guardar:
--
-- 1. REEMBOLSOS. La guía los documenta (`POST /v1/orders/{id}/refund`) y aquí no
--    existían: un cobro equivocado con tarjeta solo se podía devolver desde el panel de
--    Mercado Pago, y el libro del club seguía diciendo que ese dinero había entrado.
--    Peor: el aviso `order.refunded` llegaba y se tiraba, porque el cobro ya estaba en
--    estado final.
--
-- 2. EL ID DEL PAGO (`PAY…`). Es el que identifica la transacción dentro de la orden y
--    el que la guía usa para reembolsar. No se guardaba.
--
-- 3. LA PROPINA. La respuesta de la orden trae `tip_amount` por pago, y la guía prohíbe
--    reembolsos parciales "cuando la orden contiene propinas", o sea que la terminal
--    puede cobrarlas. No se guardaban, y un cobro con propina podía leerse como "cobró
--    un monto distinto del que pedimos" y quedarse sin asentar.
-- ============================================================================

ALTER TABLE terminal_charges
  -- `transactions.payments[0].id` de la orden. Empieza con PAY.
  ADD COLUMN IF NOT EXISTS payment_transaction_id VARCHAR(60),
  ADD COLUMN IF NOT EXISTS tip_amount NUMERIC(12,2)
    CHECK (tip_amount IS NULL OR tip_amount >= 0),
  -- Cuánto se ha devuelto de este cobro, por cualquier vía. Es la base del cálculo
  -- idempotente de abajo: lo que se asienta es siempre la DIFERENCIA contra esto,
  -- bajo bloqueo de la fila, así que el mismo reembolso visto dos veces (nuestra
  -- respuesta y su webhook) se asienta una sola.
  ADD COLUMN IF NOT EXISTS refunded_amount NUMERIC(12,2) NOT NULL DEFAULT 0
    CHECK (refunded_amount >= 0);

-- ---------------------------------------------------------------- los reembolsos

CREATE TABLE IF NOT EXISTS terminal_refunds (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nightclub_id           UUID NOT NULL REFERENCES nightclubs(id) ON DELETE RESTRICT,
  charge_id              UUID NOT NULL REFERENCES terminal_charges(id) ON DELETE RESTRICT,
  -- El renglón del libro que se cobró, y el que asienta la devolución (tipo `refund`,
  -- dirección `out`). El segundo queda nulo mientras Mercado Pago no la acepte.
  transaction_id         UUID NOT NULL REFERENCES transactions(id) ON DELETE RESTRICT,
  refund_transaction_id  UUID REFERENCES transactions(id) ON DELETE RESTRICT,
  amount                 NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  currency               CHAR(3) NOT NULL CHECK (currency IN ('MXN','USD')),
  -- `staff`: lo pidió alguien desde el sistema. `external`: se hizo desde el panel o
  -- la terminal de Mercado Pago y nos enteramos por su aviso. Los dos se asientan: el
  -- dinero salió igual.
  source                 VARCHAR(10) NOT NULL CHECK (source IN ('staff','external')),
  reason                 VARCHAR(280),
  requested_by           UUID REFERENCES users(id) ON DELETE RESTRICT,
  -- La llave que viajó en X-Idempotency-Key. Mercado Pago la respeta 24 horas: es lo
  -- que permite reintentar un reembolso cuya respuesta se perdió sin devolver dos veces.
  idempotency_key        UUID NOT NULL UNIQUE,
  external_refund_id     VARCHAR(60),
  status                 VARCHAR(12) NOT NULL DEFAULT 'requested'
                         CHECK (status IN ('requested','processing','processed','failed')),
  status_detail          VARCHAR(200),
  -- Cuándo se le pidió por última vez a Mercado Pago. Es el reloj del reintento, y va
  -- en su propia columna porque `updated_at` lo reescribe el trigger en cada cambio.
  last_attempt_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Un reembolso pedido desde el sistema tiene quién lo pidió y por qué. Uno externo no
  -- tiene ninguna de las dos cosas y no se le inventan.
  CHECK (source = 'external' OR (requested_by IS NOT NULL AND reason IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS terminal_refunds_charge_idx ON terminal_refunds (charge_id, created_at);

-- La protección de verdad contra dos gerentes tocando "Reembolsar" a la vez: un solo
-- reembolso pedido desde el sistema, en vuelo o hecho, por cobro. Uno fallido no
-- cuenta, para poder reintentar después de corregir la causa.
CREATE UNIQUE INDEX IF NOT EXISTS terminal_refunds_one_staff_uidx
  ON terminal_refunds (charge_id) WHERE source = 'staff' AND status <> 'failed';

CREATE UNIQUE INDEX IF NOT EXISTS terminal_refunds_external_uidx
  ON terminal_refunds (external_refund_id) WHERE external_refund_id IS NOT NULL;

-- Lo que se devolvió y de qué cobro no se edita ni se borra. El estado sí avanza
-- (requested → processing → processed), igual que un cobro.
CREATE OR REPLACE FUNCTION terminal_refunds_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'terminal_refunds: un reembolso no se borra (id=%)', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.amount <> OLD.amount OR NEW.currency <> OLD.currency
     OR NEW.charge_id <> OLD.charge_id OR NEW.transaction_id <> OLD.transaction_id
     OR NEW.source <> OLD.source OR NEW.idempotency_key <> OLD.idempotency_key
     OR NEW.requested_by IS DISTINCT FROM OLD.requested_by
     OR NEW.reason IS DISTINCT FROM OLD.reason
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'terminal_refunds: lo que se devolvió y de qué cobro no se cambia (id=%)', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS terminal_refunds_guard ON terminal_refunds;
CREATE TRIGGER terminal_refunds_guard
  BEFORE UPDATE OR DELETE ON terminal_refunds
  FOR EACH ROW EXECUTE FUNCTION terminal_refunds_guard();

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'terminal_refunds_set_updated_at') THEN
    CREATE TRIGGER terminal_refunds_set_updated_at BEFORE UPDATE ON terminal_refunds
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;
