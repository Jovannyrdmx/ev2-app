-- ============================================================================
-- Migration 048: credito de consumo de una reservacion VIP (D97).
--
-- Lo que se paga por reservar una mesa VIP se le da de vuelta a quien reservo como
-- credito para consumir. Reglas del club:
--   * Es lo REALMENTE pagado: crece cuando un pago de la reservacion se confirma.
--     Nunca se da consumo sin dinero recibido.
--   * Vale solo la noche de la reservacion: vence al cierre de esa noche.
--   * Se gasta como una forma de pago mas ("vip_credit") al cobrar una cuenta de la
--     mesa, sola o combinada con efectivo/tarjeta, hasta agotarse o vencer.
--   * Si la reservacion se cancela o no llega, el credito se anula.
--
-- El saldo (granted - spent) vive en `reservation_credits`; cada cambio deja un
-- renglon en `reservation_credit_movements`, que solo admite inserciones: un saldo
-- que nadie puede explicar es peor que no tener saldo.
-- ============================================================================

CREATE TABLE IF NOT EXISTS reservation_credits (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nightclub_id   UUID NOT NULL REFERENCES nightclubs(id) ON DELETE CASCADE,
  reservation_id UUID NOT NULL REFERENCES reservations(id) ON DELETE RESTRICT,
  -- Quien reservo: el credito es suyo.
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  event_id       UUID NOT NULL REFERENCES events_calendar(id) ON DELETE RESTRICT,
  currency       CHAR(3) NOT NULL CHECK (currency IN ('MXN','USD')),
  -- Lo realmente pagado de la reservacion, acumulado.
  granted        NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (granted >= 0),
  spent          NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (spent >= 0),
  -- El cierre de la noche, congelado al otorgarlo.
  expires_at     TIMESTAMPTZ NOT NULL,
  voided_at      TIMESTAMPTZ,
  void_reason    VARCHAR(40),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (reservation_id),
  CHECK (spent <= granted),
  CHECK ((voided_at IS NULL) = (void_reason IS NULL))
);
CREATE INDEX IF NOT EXISTS reservation_credits_club_idx
  ON reservation_credits (nightclub_id, expires_at);
CREATE INDEX IF NOT EXISTS reservation_credits_user_idx
  ON reservation_credits (user_id, expires_at DESC);

DROP TRIGGER IF EXISTS reservation_credits_set_updated_at ON reservation_credits;
CREATE TRIGGER reservation_credits_set_updated_at
  BEFORE UPDATE ON reservation_credits
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS reservation_credit_movements (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  credit_id      UUID NOT NULL REFERENCES reservation_credits(id) ON DELETE RESTRICT,
  nightclub_id   UUID NOT NULL REFERENCES nightclubs(id) ON DELETE CASCADE,
  kind           VARCHAR(10) NOT NULL CHECK (kind IN ('grant','spend','restore','void')),
  -- Con signo: grant y restore suman; spend y void restan del saldo disponible.
  amount         NUMERIC(12,2) NOT NULL CHECK (amount <> 0),
  balance_after  NUMERIC(12,2) NOT NULL CHECK (balance_after >= 0),
  -- El cobro que lo origino: el pago de la reservacion (grant) o la cuenta (spend).
  transaction_id UUID REFERENCES transactions(id) ON DELETE RESTRICT,
  payment_id     UUID REFERENCES manual_payments(id) ON DELETE RESTRICT,
  created_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS reservation_credit_movements_credit_idx
  ON reservation_credit_movements (credit_id, created_at);
-- Un mismo pago de reservacion no otorga credito dos veces.
CREATE UNIQUE INDEX IF NOT EXISTS reservation_credit_grant_once_idx
  ON reservation_credit_movements (credit_id, transaction_id) WHERE kind = 'grant';
-- Un mismo pago de cuenta no gasta credito dos veces.
CREATE UNIQUE INDEX IF NOT EXISTS reservation_credit_spend_once_idx
  ON reservation_credit_movements (payment_id) WHERE kind = 'spend';

CREATE OR REPLACE FUNCTION reservation_credit_movements_are_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'reservation_credit_movements is insert-only: correct a balance with a new movement';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS reservation_credit_movements_no_update ON reservation_credit_movements;
CREATE TRIGGER reservation_credit_movements_no_update
  BEFORE UPDATE OR DELETE ON reservation_credit_movements
  FOR EACH ROW EXECUTE FUNCTION reservation_credit_movements_are_immutable();

-- ---------------------------------------------------------------- forma de pago
ALTER TABLE manual_payments DROP CONSTRAINT IF EXISTS manual_payments_method_check;
ALTER TABLE manual_payments ADD CONSTRAINT manual_payments_method_check
  CHECK (method IN ('cash','cash_usd','card_terminal','zelle','cash_app','bank_transfer','spei',
                    'vip_credit'));
