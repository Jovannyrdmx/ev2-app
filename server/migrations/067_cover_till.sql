-- ============================================================================
-- Migration 067: Cover es una caja (D118).
--
-- Hasta aqui el club tenia dos cajas, una por barra (planta baja y planta alta), y
-- la puerta cobraba sin caja: la anfitriona vendia covers y cobraba el resto de las
-- mesas sin fondo, sin que el gerente supiera quien tenia el cajon y sin aparecer en
-- "Cajas de la noche". El dueño pidio que Cover sea una caja mas:
--
--   * la abre la anfitriona que el gerente puso en Cover en el rol de la noche, con
--     un fondo en pesos y otro en dolares que el gerente confirma con su PIN;
--   * UNA sola caja abierta en Cover (la misma regla que en las barras): las demas
--     anfitrionas escanean pases pero no cobran;
--   * sin la caja abierta no se vende cover ni se cobra el resto de una mesa;
--   * su corte devuelve el fondo en las dos monedas.
--
-- Y para que el sistema lleve registro de TODO lo que entra a cada caja, cada cobro
-- de la puerta y cada pago registrado en una caja guarda el turno de caja que lo
-- recibio (`till_shift_id`). Hasta hoy eso se deducia por persona y por horario.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. El fondo en dolares de una caja
-- ---------------------------------------------------------------------------
ALTER TABLE staff_shifts
  ADD COLUMN IF NOT EXISTS opening_float_usd NUMERIC(12,2);

COMMENT ON COLUMN staff_shifts.opening_float_usd IS
  'Los dolares con los que abre la caja (D118). Va con el fondo en pesos: lo confirma el mismo gerente con el mismo PIN.';

ALTER TABLE staff_shifts DROP CONSTRAINT IF EXISTS staff_shifts_float_usd_chk;
ALTER TABLE staff_shifts ADD CONSTRAINT staff_shifts_float_usd_chk
  CHECK (opening_float_usd IS NULL OR (opening_float_usd >= 0 AND opening_float IS NOT NULL));

-- ---------------------------------------------------------------------------
-- 2. La caja puede estar en una barra o en Cover
-- ---------------------------------------------------------------------------
-- Igual que en 038, mas tres reglas:
--   * el lugar puede ser una barra o la puerta (`door`);
--   * la caja de la puerta solo la tiene una anfitriona;
--   * el fondo en dolares tampoco se edita una vez escrito.
CREATE OR REPLACE FUNCTION staff_shifts_till_guard() RETURNS trigger AS $$
DECLARE
  loc_club  UUID;
  loc_kind  VARCHAR(12);
  user_role VARCHAR(20);
BEGIN
  IF NEW.location_id IS NOT NULL AND (TG_OP = 'INSERT'
       OR NEW.location_id IS DISTINCT FROM OLD.location_id) THEN
    SELECT nightclub_id, kind INTO loc_club, loc_kind
      FROM supply_locations WHERE id = NEW.location_id;
    IF loc_club IS DISTINCT FROM NEW.nightclub_id THEN
      RAISE EXCEPTION 'staff_shifts: that bar belongs to another nightclub'
        USING ERRCODE = 'check_violation';
    END IF;
    IF loc_kind IS DISTINCT FROM 'bar' AND loc_kind IS DISTINCT FROM 'door' THEN
      RAISE EXCEPTION 'staff_shifts.location_id must point at a bar or the door, not %',
        COALESCE(loc_kind, 'nothing') USING ERRCODE = 'check_violation';
    END IF;
    IF loc_kind = 'door' THEN
      SELECT role INTO user_role FROM users WHERE id = NEW.user_id;
      IF user_role IS DISTINCT FROM 'hostess' THEN
        RAISE EXCEPTION 'staff_shifts: the door till is held by a hostess, not %',
          COALESCE(user_role, 'nobody') USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;

  -- El fondo y la barra, una vez escritos, no se editan: son la base del corte.
  IF TG_OP = 'UPDATE' THEN
    IF OLD.location_id IS NOT NULL AND NEW.location_id IS DISTINCT FROM OLD.location_id THEN
      RAISE EXCEPTION 'staff_shifts: la barra de una caja no se cambia (id=%)', OLD.id
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF OLD.opening_float IS NOT NULL AND (
         NEW.opening_float IS DISTINCT FROM OLD.opening_float
         OR NEW.opening_float_usd IS DISTINCT FROM OLD.opening_float_usd
         OR NEW.float_currency IS DISTINCT FROM OLD.float_currency
         OR NEW.float_authorized_by IS DISTINCT FROM OLD.float_authorized_by
         OR NEW.float_authorized_at IS DISTINCT FROM OLD.float_authorized_at
         OR NEW.float_authorized_role IS DISTINCT FROM OLD.float_authorized_role) THEN
      RAISE EXCEPTION 'staff_shifts: el fondo de una caja no se edita (id=%)', OLD.id
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- El disparador ya existe desde 038 y llama a esta funcion; se vuelve a crear igual
-- para que la migracion no dependa de eso.
DROP TRIGGER IF EXISTS staff_shifts_till_check ON staff_shifts;
CREATE TRIGGER staff_shifts_till_check
  BEFORE INSERT OR UPDATE ON staff_shifts
  FOR EACH ROW EXECUTE FUNCTION staff_shifts_till_guard();

-- ---------------------------------------------------------------------------
-- 3. En el rol de la noche, la anfitriona puede ir a Cover
-- ---------------------------------------------------------------------------
-- Igual que en 023, mas: una barra es para bartender y cajero; Cover (la puerta) es
-- solo para la anfitriona, que es quien abre esa caja.
CREATE OR REPLACE FUNCTION shift_assignments_stay_in_one_club() RETURNS trigger AS $$
DECLARE
  user_club  UUID;
  event_club UUID;
  loc_club   UUID;
  loc_kind   VARCHAR(12);
BEGIN
  SELECT nightclub_id INTO user_club FROM users WHERE id = NEW.user_id;
  IF user_club IS DISTINCT FROM NEW.nightclub_id THEN
    RAISE EXCEPTION 'shift_assignments: that person belongs to another nightclub'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT nightclub_id INTO event_club FROM events_calendar WHERE id = NEW.event_id;
  IF event_club IS DISTINCT FROM NEW.nightclub_id THEN
    RAISE EXCEPTION 'shift_assignments: that night belongs to another nightclub'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.location_id IS NOT NULL THEN
    SELECT nightclub_id, kind INTO loc_club, loc_kind
      FROM supply_locations WHERE id = NEW.location_id;
    IF loc_club IS DISTINCT FROM NEW.nightclub_id THEN
      RAISE EXCEPTION 'shift_assignments: that bar belongs to another nightclub'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.role = 'hostess' THEN
      IF loc_kind IS DISTINCT FROM 'door' THEN
        RAISE EXCEPTION 'shift_assignments: a hostess goes to the door, not to %',
          COALESCE(loc_kind, 'nothing') USING ERRCODE = 'check_violation';
      END IF;
    ELSIF loc_kind IS DISTINCT FROM 'bar' THEN
      RAISE EXCEPTION 'shift_assignments.location_id must point at a bar, not %',
        COALESCE(loc_kind, 'nothing') USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- 4. El corte guarda el fondo en dolares
-- ---------------------------------------------------------------------------
ALTER TABLE shift_closings
  ADD COLUMN IF NOT EXISTS opening_float_usd NUMERIC(12,2) NOT NULL DEFAULT 0;

ALTER TABLE shift_closings DROP CONSTRAINT IF EXISTS shift_closings_float_usd_chk;
ALTER TABLE shift_closings ADD CONSTRAINT shift_closings_float_usd_chk
  CHECK (opening_float_usd >= 0);

-- La guarda de 044 aprende la columna nueva: el fondo en dolares de un corte se
-- congela igual que el de pesos.
CREATE OR REPLACE FUNCTION shift_money_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '%: un corte no se borra (id=%)', TG_TABLE_NAME, OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_TABLE_NAME = 'shift_cash_drops' THEN
    IF NEW.amount <> OLD.amount OR NEW.shift_id <> OLD.shift_id OR NEW.user_id <> OLD.user_id
       OR NEW.currency <> OLD.currency OR NEW.created_at <> OLD.created_at
       OR NEW.reason IS DISTINCT FROM OLD.reason
       OR NEW.authorized_by IS DISTINCT FROM OLD.authorized_by THEN
      RAISE EXCEPTION 'shift_cash_drops: lo declarado no se edita (id=%)', OLD.id
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF OLD.status <> 'declared' AND NEW.status <> OLD.status THEN
      RAISE EXCEPTION 'shift_cash_drops: esa entrega ya está %s (id=%)', OLD.status, OLD.id
        USING ERRCODE = 'restrict_violation';
    END IF;
  ELSE
    IF NEW.shift_id <> OLD.shift_id OR NEW.user_id <> OLD.user_id
       OR NEW.declared_cash <> OLD.declared_cash OR NEW.cash_collected <> OLD.cash_collected
       OR NEW.expected_cash <> OLD.expected_cash OR NEW.totals::text <> OLD.totals::text
       OR NEW.declared_at <> OLD.declared_at OR NEW.created_at <> OLD.created_at
       OR NEW.authorized_by IS DISTINCT FROM OLD.authorized_by
       OR NEW.location_id IS DISTINCT FROM OLD.location_id
       OR NEW.opening_float <> OLD.opening_float
       OR NEW.opening_float_usd <> OLD.opening_float_usd
       OR NEW.pending_orders::text <> OLD.pending_orders::text
       OR NEW.pending_total <> OLD.pending_total
       OR NEW.usd_collected IS DISTINCT FROM OLD.usd_collected
       OR NEW.usd_change_given IS DISTINCT FROM OLD.usd_change_given
       OR NEW.usd_drops_total IS DISTINCT FROM OLD.usd_drops_total
       OR NEW.expected_usd IS DISTINCT FROM OLD.expected_usd THEN
      RAISE EXCEPTION 'shift_closings: lo declarado y lo cobrado no se editan (id=%)', OLD.id
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF OLD.status = 'confirmed' AND (
         NEW.status <> OLD.status
         OR NEW.counted_cash IS DISTINCT FROM OLD.counted_cash
         OR NEW.difference IS DISTINCT FROM OLD.difference
         OR NEW.counted_usd IS DISTINCT FROM OLD.counted_usd
         OR NEW.difference_usd IS DISTINCT FROM OLD.difference_usd
         OR NEW.difference_reason IS DISTINCT FROM OLD.difference_reason
         OR NEW.confirmed_by IS DISTINCT FROM OLD.confirmed_by
         OR NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at
       ) THEN
      RAISE EXCEPTION 'shift_closings: ese corte ya está confirmado (id=%)', OLD.id
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- 5. Que caja recibio cada cobro
-- ---------------------------------------------------------------------------
ALTER TABLE door_admissions
  ADD COLUMN IF NOT EXISTS till_shift_id UUID REFERENCES staff_shifts(id) ON DELETE RESTRICT;
ALTER TABLE manual_payments
  ADD COLUMN IF NOT EXISTS till_shift_id UUID REFERENCES staff_shifts(id) ON DELETE RESTRICT;

COMMENT ON COLUMN door_admissions.till_shift_id IS
  'La caja de Cover que recibio esta entrada (D118). NULL en las entradas de antes de que Cover fuera caja.';
COMMENT ON COLUMN manual_payments.till_shift_id IS
  'La caja (barra o Cover) que recibio este pago (D118). NULL si no se cobro en una caja.';

CREATE INDEX IF NOT EXISTS door_admissions_till_shift_idx
  ON door_admissions (till_shift_id) WHERE till_shift_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS manual_payments_till_shift_idx
  ON manual_payments (till_shift_id) WHERE till_shift_id IS NOT NULL;

-- La caja que se anota tiene que ser una caja ABIERTA, de quien cobro y del mismo
-- club. Sin esto, un cobro se podria colgar de la caja de otra persona o de una que
-- ya hizo su corte, y el corte de las dos dejaria de cuadrar.
CREATE OR REPLACE FUNCTION till_shift_must_be_open_and_own() RETURNS trigger AS $$
DECLARE
  s_user  UUID;
  s_club  UUID;
  s_loc   UUID;
  s_ended TIMESTAMPTZ;
  collector UUID;
BEGIN
  IF NEW.till_shift_id IS NULL THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND NEW.till_shift_id IS NOT DISTINCT FROM OLD.till_shift_id THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.till_shift_id IS NOT NULL THEN
    RAISE EXCEPTION '%: la caja de un cobro no se cambia (id=%)', TG_TABLE_NAME, OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  -- Cada tabla dice con su propia columna quien recibio el dinero. Van en ramas
  -- separadas porque PL/pgSQL no deja nombrar una columna que el renglon no tiene.
  IF TG_TABLE_NAME = 'door_admissions' THEN
    collector := NEW.sold_by;
  ELSE
    collector := NEW.declared_by;
  END IF;
  SELECT user_id, nightclub_id, location_id, ended_at INTO s_user, s_club, s_loc, s_ended
    FROM staff_shifts WHERE id = NEW.till_shift_id;
  IF s_club IS DISTINCT FROM NEW.nightclub_id THEN
    RAISE EXCEPTION '%: that till belongs to another nightclub', TG_TABLE_NAME
      USING ERRCODE = 'check_violation';
  END IF;
  IF s_loc IS NULL THEN
    RAISE EXCEPTION '%: that shift is not a till', TG_TABLE_NAME
      USING ERRCODE = 'check_violation';
  END IF;
  IF s_user IS DISTINCT FROM collector THEN
    RAISE EXCEPTION '%: the till belongs to someone else', TG_TABLE_NAME
      USING ERRCODE = 'check_violation';
  END IF;
  IF s_ended IS NOT NULL THEN
    RAISE EXCEPTION '%: that till is already closed', TG_TABLE_NAME
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS door_admissions_till_check ON door_admissions;
CREATE TRIGGER door_admissions_till_check
  BEFORE INSERT OR UPDATE OF till_shift_id ON door_admissions
  FOR EACH ROW EXECUTE FUNCTION till_shift_must_be_open_and_own();

DROP TRIGGER IF EXISTS manual_payments_till_check ON manual_payments;
CREATE TRIGGER manual_payments_till_check
  BEFORE INSERT OR UPDATE OF till_shift_id ON manual_payments
  FOR EACH ROW EXECUTE FUNCTION till_shift_must_be_open_and_own();
