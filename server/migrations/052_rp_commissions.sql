-- ============================================================================
-- Migration 052: el RP y su comision sobre lo que consumen sus invitados (D98).
--
-- Un RP (relaciones publicas) trae gente al club. Se le paga un porcentaje (10% por
-- defecto) de lo que esa gente paga esa noche.
--
-- El sistema NO identifica a cada cliente (los pases son anonimos y los tragos se
-- cobran por mesa), asi que el vinculo no es "esta persona" sino:
--   * una MESA / reservacion de esa noche, a la que la puerta le captura el codigo del
--     RP: cuenta todo lo pagado en esa mesa esa noche;
--   * un COVER vendido con el codigo del RP: cuenta lo cobrado en esa venta.
--
-- Un solo RP por mesa y noche. Corregirlo lo hace el gerente y queda en la bitacora.
-- La comision se liquida por noche: el gerente la abona al saldo del RP, que la retira
-- con el mismo flujo de retiros de cualquier empleado.
-- ============================================================================

-- ---------------------------------------------------------------- el puesto
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN (
  'guest','waiter','bartender','dancer','dj','light_tech','valet','hostess','driver',
  'warehouse','cashier','rp','manager','admin'));

-- La comision entra al libro como dinero del empleado, igual que una propina.
ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_type_check;
ALTER TABLE transactions ADD CONSTRAINT transactions_type_check
  CHECK (type IN ('drink_order','bottle_service','tip','song_request','reservation_deposit',
                  'reservation_balance','refund','valet','withdrawal','adjustment',
                  'taxi_ride','cover','rp_commission'));

-- ---------------------------------------------------------------- el RP
CREATE TABLE IF NOT EXISTS rp_profiles (
  user_id        UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  nightclub_id   UUID NOT NULL REFERENCES nightclubs(id) ON DELETE CASCADE,
  -- Lo que la anfitriona teclea en la puerta. Sin O/0 ni I/1/L: se dicta en voz alta.
  code           VARCHAR(12) NOT NULL CHECK (code ~ '^[A-Z0-9]{4,12}$'),
  commission_pct NUMERIC(5,2) NOT NULL DEFAULT 10.00
                 CHECK (commission_pct >= 0 AND commission_pct <= 100),
  active         BOOLEAN NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS rp_profiles_code_idx ON rp_profiles (nightclub_id, code);

-- ---------------------------------------------------------------- a quien se atribuye
-- El porcentaje se copia aqui: cambiarle el porcentaje al RP no reescribe noches pasadas.
CREATE TABLE IF NOT EXISTS rp_attributions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nightclub_id   UUID NOT NULL REFERENCES nightclubs(id) ON DELETE CASCADE,
  rp_user_id     UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  event_id       UUID NOT NULL REFERENCES events_calendar(id) ON DELETE RESTRICT,
  kind           VARCHAR(10) NOT NULL CHECK (kind IN ('table', 'cover')),
  reservation_id UUID REFERENCES reservations(id) ON DELETE RESTRICT,
  admission_id   UUID REFERENCES door_admissions(id) ON DELETE RESTRICT,
  commission_pct NUMERIC(5,2) NOT NULL CHECK (commission_pct >= 0 AND commission_pct <= 100),
  created_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((kind = 'table' AND reservation_id IS NOT NULL AND admission_id IS NULL)
      OR (kind = 'cover' AND admission_id IS NOT NULL AND reservation_id IS NULL))
);
-- Un solo RP por mesa y noche, y por venta de cover.
CREATE UNIQUE INDEX IF NOT EXISTS rp_attributions_table_once_idx
  ON rp_attributions (reservation_id) WHERE reservation_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS rp_attributions_cover_once_idx
  ON rp_attributions (admission_id) WHERE admission_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS rp_attributions_rp_event_idx ON rp_attributions (rp_user_id, event_id);

-- ---------------------------------------------------------------- la liquidacion
-- Una por RP, noche y moneda. Solo inserta: lo liquidado no se edita ni se borra.
CREATE TABLE IF NOT EXISTS rp_settlements (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nightclub_id   UUID NOT NULL REFERENCES nightclubs(id) ON DELETE CASCADE,
  rp_user_id     UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  event_id       UUID NOT NULL REFERENCES events_calendar(id) ON DELETE RESTRICT,
  currency       CHAR(3) NOT NULL CHECK (currency IN ('MXN','USD')),
  base           NUMERIC(12,2) NOT NULL CHECK (base > 0),
  amount         NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  transaction_id UUID REFERENCES transactions(id) ON DELETE RESTRICT,
  settled_by     UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  note           VARCHAR(200),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (rp_user_id, event_id, currency)
);

CREATE OR REPLACE FUNCTION rp_settlements_are_final() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'rp_settlements is insert-only' USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS rp_settlements_no_change ON rp_settlements;
CREATE TRIGGER rp_settlements_no_change
  BEFORE UPDATE OR DELETE ON rp_settlements
  FOR EACH ROW EXECUTE FUNCTION rp_settlements_are_final();
