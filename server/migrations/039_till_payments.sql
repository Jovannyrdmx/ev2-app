-- ============================================================================
-- Migration 039: el cobro de la caja (D79).
--
-- Tres cosas que pidió el dueño para la caja de cada barra:
--
--   1. Cada caja tiene su impresora, y el recibo del cobro sale ahí solo, al
--      confirmar el pago. Es un propósito más de impresora: `till`.
--   2. El cajero teclea cuánto efectivo le dieron y el sistema calcula el cambio. Se
--      guarda en el pago, porque "le di de cambio 150" es lo primero que se discute
--      cuando el corte no cuadra.
--   3. Un pedido se puede pagar con DOS formas de pago distintas (efectivo y tarjeta,
--      por ejemplo). El renglón del libro sigue siendo uno y su monto no se toca; lo
--      que cambia es que ahora puede tener dos partes que, juntas, suman ese monto.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. La impresora de la caja
-- ---------------------------------------------------------------------------
ALTER TABLE printers DROP CONSTRAINT IF EXISTS printers_purpose_check;
ALTER TABLE printers ADD CONSTRAINT printers_purpose_check
  CHECK (purpose IN ('orders','service','till'));

ALTER TABLE print_agents DROP CONSTRAINT IF EXISTS print_agents_purpose_chk;
ALTER TABLE print_agents ADD CONSTRAINT print_agents_purpose_chk
  CHECK (purpose IS NULL OR purpose IN ('orders','service','till'));

ALTER TABLE print_agent_invites DROP CONSTRAINT IF EXISTS print_agent_invites_purpose_chk;
ALTER TABLE print_agent_invites ADD CONSTRAINT print_agent_invites_purpose_chk
  CHECK (purpose IS NULL OR purpose IN ('orders','service','till'));

-- ---------------------------------------------------------------------------
-- 2. El efectivo recibido y el cambio
-- ---------------------------------------------------------------------------
ALTER TABLE manual_payments
  ADD COLUMN IF NOT EXISTS cash_received NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS change_given  NUMERIC(12,2);

COMMENT ON COLUMN manual_payments.cash_received IS
  'Lo que el cliente entregó en efectivo (D79). El cambio es esto menos el monto.';

ALTER TABLE manual_payments DROP CONSTRAINT IF EXISTS manual_payments_cash_received_chk;
ALTER TABLE manual_payments ADD CONSTRAINT manual_payments_cash_received_chk
  CHECK (
    (cash_received IS NULL AND change_given IS NULL)
    OR (method = 'cash'
        AND cash_received >= amount
        AND change_given = cash_received - amount)
  );

-- ---------------------------------------------------------------------------
-- 3. Dos formas de pago en un mismo cobro
-- ---------------------------------------------------------------------------
-- Antes: un solo pago confirmado por renglón del libro. Ahora puede haber dos, pero
-- nunca dos con la MISMA forma de pago: dos partes en efectivo no son "dos métodos",
-- son un error de dedo. Cuántas partes y que sumen exacto lo decide el servicio, que
-- también ve los cobros con terminal (otra tabla).
DROP INDEX IF EXISTS manual_payments_confirmed_uidx;
CREATE UNIQUE INDEX IF NOT EXISTS manual_payments_confirmed_method_uidx
  ON manual_payments (transaction_id, method) WHERE status = 'confirmed';
