-- ============================================================================
-- Migration 030: el corte de turno del personal que cobra (D51).
--
-- Un mesero y un bartender cobran dinero toda la noche: efectivo en la mano,
-- vouchers de la terminal, transferencias. Hasta hoy el sistema sabía CUÁNTO se
-- cobró y QUIÉN lo cobró, pero no había ningún momento en el que esa persona
-- entregara lo suyo y alguien lo contara. El faltante aparecía —si aparecía— en el
-- corte de la noche, mezclado con el de todos, cuando ya nadie podía decir de quién
-- era.
--
-- Dos tablas, porque son dos momentos distintos de la misma noche:
--
--   * `shift_cash_drops`: entregas PARCIALES de efectivo durante el turno. El mesero
--     con doce mil pesos en la bolsa no es un problema de contabilidad, es un
--     problema de seguridad; entregar a media noche tiene que ser posible sin
--     cerrar el turno.
--   * `shift_closings`: el corte al final. El empleado declara lo que entrega, el
--     gerente lo cuenta y lo confirma, y la diferencia queda escrita con su motivo y
--     con el nombre de los dos.
--
-- Las dos guardan lo declarado y lo contado por separado, y ninguna de las dos deja
-- editar los montos después: un corte que se puede reescribir no sirve para lo único
-- que sirve un corte.
-- ============================================================================

-- ---------------------------------------------------------------- entregas parciales

CREATE TABLE IF NOT EXISTS shift_cash_drops (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nightclub_id     UUID NOT NULL REFERENCES nightclubs(id) ON DELETE RESTRICT,
  shift_id         UUID NOT NULL REFERENCES staff_shifts(id) ON DELETE RESTRICT,
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  -- Lo que el empleado dice que entrega.
  amount           NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  currency         CHAR(3) NOT NULL DEFAULT 'MXN' CHECK (currency IN ('MXN','USD')),
  note             VARCHAR(200),
  status           VARCHAR(10) NOT NULL DEFAULT 'declared'
                   CHECK (status IN ('declared','received','rejected')),
  -- Lo que el gerente contó de verdad. Puede no ser lo mismo, y eso es justo lo que
  -- hay que poder ver.
  counted_amount   NUMERIC(12,2) CHECK (counted_amount IS NULL OR counted_amount >= 0),
  received_by      UUID REFERENCES users(id) ON DELETE RESTRICT,
  received_at      TIMESTAMPTZ,
  rejection_reason VARCHAR(200),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Recibida sin decir quién la recibió es una entrega que nadie hizo.
  CHECK (status <> 'received' OR (received_by IS NOT NULL AND counted_amount IS NOT NULL)),
  CHECK (status <> 'rejected' OR rejection_reason IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS shift_cash_drops_shift_idx ON shift_cash_drops (shift_id, created_at);
CREATE INDEX IF NOT EXISTS shift_cash_drops_pending_idx
  ON shift_cash_drops (nightclub_id, created_at) WHERE status = 'declared';

-- ---------------------------------------------------------------- el corte

CREATE TABLE IF NOT EXISTS shift_closings (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nightclub_id      UUID NOT NULL REFERENCES nightclubs(id) ON DELETE RESTRICT,
  -- Un turno, un corte. El índice único es lo que impide que alguien declare dos
  -- veces y entregue una.
  shift_id          UUID NOT NULL UNIQUE REFERENCES staff_shifts(id) ON DELETE RESTRICT,
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  -- El puesto que tenía ESA noche. Si mañana lo cambian de puesto, el corte de
  -- anoche tiene que seguir diciendo lo que era.
  role              VARCHAR(20) NOT NULL,
  started_at        TIMESTAMPTZ NOT NULL,
  ended_at          TIMESTAMPTZ NOT NULL,
  currency          CHAR(3) NOT NULL DEFAULT 'MXN' CHECK (currency IN ('MXN','USD')),
  -- La foto de lo que cobró, congelada al declarar: por método de pago y por
  -- concepto. Se guarda entera y no solo el total porque la discusión de la mañana
  -- siguiente es siempre sobre un renglón, no sobre la suma.
  totals            JSONB NOT NULL DEFAULT '{}'::jsonb,
  cash_collected    NUMERIC(12,2) NOT NULL CHECK (cash_collected >= 0),
  drops_total       NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (drops_total >= 0),
  -- Lo que le toca entregar: lo que cobró en efectivo menos lo que ya entregó.
  expected_cash     NUMERIC(12,2) NOT NULL,
  declared_cash     NUMERIC(12,2) NOT NULL CHECK (declared_cash >= 0),
  declared_notes    VARCHAR(280),
  declared_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Lo que el gerente contó, y lo que sobró o faltó. `difference` se guarda aunque
  -- se pueda calcular: es el número que se consulta, y calcularlo en cada consulta
  -- invita a que dos pantallas lo calculen distinto.
  counted_cash      NUMERIC(12,2) CHECK (counted_cash IS NULL OR counted_cash >= 0),
  difference        NUMERIC(12,2),
  difference_reason VARCHAR(280),
  status            VARCHAR(10) NOT NULL DEFAULT 'declared'
                    CHECK (status IN ('declared','confirmed')),
  confirmed_by      UUID REFERENCES users(id) ON DELETE RESTRICT,
  confirmed_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (status <> 'confirmed' OR (confirmed_by IS NOT NULL AND counted_cash IS NOT NULL
                                   AND difference IS NOT NULL)),
  -- Una diferencia sin motivo es exactamente lo que un corte tiene que impedir.
  CHECK (difference IS NULL OR difference = 0 OR difference_reason IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS shift_closings_club_idx ON shift_closings (nightclub_id, declared_at DESC);
CREATE INDEX IF NOT EXISTS shift_closings_pending_idx
  ON shift_closings (nightclub_id, declared_at) WHERE status = 'declared';
CREATE INDEX IF NOT EXISTS shift_closings_user_idx ON shift_closings (user_id, declared_at DESC);

-- ---------------------------------------------------------------- no se reescriben

CREATE OR REPLACE FUNCTION shift_money_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '%: un corte no se borra (id=%)', TG_TABLE_NAME, OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_TABLE_NAME = 'shift_cash_drops' THEN
    IF NEW.amount <> OLD.amount OR NEW.shift_id <> OLD.shift_id OR NEW.user_id <> OLD.user_id
       OR NEW.currency <> OLD.currency OR NEW.created_at <> OLD.created_at THEN
      RAISE EXCEPTION 'shift_cash_drops: lo declarado no se edita (id=%)', OLD.id
        USING ERRCODE = 'restrict_violation';
    END IF;
    -- Una entrega ya resuelta no vuelve atrás: se corrige con otra entrega, no
    -- borrando la anterior.
    IF OLD.status <> 'declared' AND NEW.status <> OLD.status THEN
      RAISE EXCEPTION 'shift_cash_drops: esa entrega ya está %s (id=%)', OLD.status, OLD.id
        USING ERRCODE = 'restrict_violation';
    END IF;
  ELSE
    IF NEW.shift_id <> OLD.shift_id OR NEW.user_id <> OLD.user_id
       OR NEW.declared_cash <> OLD.declared_cash OR NEW.cash_collected <> OLD.cash_collected
       OR NEW.expected_cash <> OLD.expected_cash OR NEW.totals::text <> OLD.totals::text
       OR NEW.declared_at <> OLD.declared_at OR NEW.created_at <> OLD.created_at THEN
      RAISE EXCEPTION 'shift_closings: lo declarado y lo cobrado no se editan (id=%)', OLD.id
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF OLD.status = 'confirmed' THEN
      RAISE EXCEPTION 'shift_closings: ese corte ya está confirmado (id=%)', OLD.id
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS shift_cash_drops_guard ON shift_cash_drops;
CREATE TRIGGER shift_cash_drops_guard BEFORE UPDATE OR DELETE ON shift_cash_drops
  FOR EACH ROW EXECUTE FUNCTION shift_money_guard();

DROP TRIGGER IF EXISTS shift_closings_guard ON shift_closings;
CREATE TRIGGER shift_closings_guard BEFORE UPDATE OR DELETE ON shift_closings
  FOR EACH ROW EXECUTE FUNCTION shift_money_guard();

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['shift_cash_drops','shift_closings'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = t || '_set_updated_at') THEN
      EXECUTE format('CREATE TRIGGER %I_set_updated_at BEFORE UPDATE ON %I '
                     'FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t, t);
    END IF;
  END LOOP;
END $$;
