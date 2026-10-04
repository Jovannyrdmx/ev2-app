-- ============================================================================
-- Migration 038: el cajero de cada barra (D77).
--
-- Hasta aqui cobraba quien atendia: el mesero en la mesa, el bartender en la venta
-- directa. El dueño cambio la regla: el dinero lo recibe UNA persona por barra, el
-- cajero, que tiene la terminal bancaria y hace su corte al final. El mesero levanta
-- el pedido, la barra lo prepara y el mesero lleva lo cobrado a la caja de esa
-- barra.
--
-- Lo que esta migracion agrega es solo lo que el modelo no sabia decir:
--
--   1. El puesto `cashier`.
--   2. De que barra es una caja abierta (`staff_shifts.location_id`), y que no haya
--      dos cajas abiertas en la misma barra: dos cajeros cobrando los mismos
--      pedidos es como un pedido se cobra dos veces o ninguna.
--   3. El fondo con el que abre la caja y QUIEN se lo entrego. Lo teclea el cajero y
--      lo confirma el gerente con su PIN; sin el fondo, el corte de la noche diria
--      "sobran $1,000" todas las noches.
--   4. En el corte: el fondo, la barra, y los pedidos que quedaron sin cobrar con el
--      permiso del gerente. Quedan escritos; no desaparecen.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. El puesto
-- ---------------------------------------------------------------------------
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN (
  'guest','waiter','bartender','dancer','dj','light_tech','valet','hostess','driver',
  'warehouse','cashier','manager','admin'));

-- ---------------------------------------------------------------------------
-- 2 y 3. La caja abierta: su barra y su fondo
-- ---------------------------------------------------------------------------
ALTER TABLE staff_shifts
  ADD COLUMN IF NOT EXISTS location_id           UUID REFERENCES supply_locations(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS opening_float         NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS float_currency        CHAR(3),
  ADD COLUMN IF NOT EXISTS float_authorized_by   UUID REFERENCES users(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS float_authorized_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS float_authorized_role VARCHAR(20);

COMMENT ON COLUMN staff_shifts.location_id IS
  'La barra de una caja abierta (cajero). NULL en los turnos que no son caja.';
COMMENT ON COLUMN staff_shifts.opening_float IS
  'El fondo con el que abre la caja, confirmado por un gerente con su PIN (D77).';

-- El fondo va completo o no va: un monto sin quien lo entrego es un numero que
-- cualquiera pudo escribir.
ALTER TABLE staff_shifts DROP CONSTRAINT IF EXISTS staff_shifts_float_complete_chk;
ALTER TABLE staff_shifts ADD CONSTRAINT staff_shifts_float_complete_chk
  CHECK (num_nonnulls(opening_float, float_currency, float_authorized_by,
                      float_authorized_at, float_authorized_role) IN (0, 5));

ALTER TABLE staff_shifts DROP CONSTRAINT IF EXISTS staff_shifts_float_amount_chk;
ALTER TABLE staff_shifts ADD CONSTRAINT staff_shifts_float_amount_chk
  CHECK (opening_float IS NULL OR opening_float >= 0);

ALTER TABLE staff_shifts DROP CONSTRAINT IF EXISTS staff_shifts_float_currency_chk;
ALTER TABLE staff_shifts ADD CONSTRAINT staff_shifts_float_currency_chk
  CHECK (float_currency IS NULL OR float_currency IN ('MXN','USD'));

-- Quien recibe el fondo no se lo autoriza a si mismo.
ALTER TABLE staff_shifts DROP CONSTRAINT IF EXISTS staff_shifts_float_not_self_chk;
ALTER TABLE staff_shifts ADD CONSTRAINT staff_shifts_float_not_self_chk
  CHECK (float_authorized_by IS NULL OR float_authorized_by <> user_id);

-- Una caja abierta por barra.
CREATE UNIQUE INDEX IF NOT EXISTS staff_shifts_one_open_till_per_bar
  ON staff_shifts (location_id) WHERE ended_at IS NULL AND location_id IS NOT NULL;

-- La barra de la caja tiene que ser una barra de ESE club.
CREATE OR REPLACE FUNCTION staff_shifts_till_guard() RETURNS trigger AS $$
DECLARE
  loc_club UUID;
  loc_kind VARCHAR(12);
BEGIN
  IF NEW.location_id IS NOT NULL AND (TG_OP = 'INSERT'
       OR NEW.location_id IS DISTINCT FROM OLD.location_id) THEN
    SELECT nightclub_id, kind INTO loc_club, loc_kind
      FROM supply_locations WHERE id = NEW.location_id;
    IF loc_club IS DISTINCT FROM NEW.nightclub_id THEN
      RAISE EXCEPTION 'staff_shifts: that bar belongs to another nightclub'
        USING ERRCODE = 'check_violation';
    END IF;
    IF loc_kind IS DISTINCT FROM 'bar' THEN
      RAISE EXCEPTION 'staff_shifts.location_id must point at a bar, not %',
        COALESCE(loc_kind, 'nothing') USING ERRCODE = 'check_violation';
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

DROP TRIGGER IF EXISTS staff_shifts_till_check ON staff_shifts;
CREATE TRIGGER staff_shifts_till_check
  BEFORE INSERT OR UPDATE ON staff_shifts
  FOR EACH ROW EXECUTE FUNCTION staff_shifts_till_guard();

-- ---------------------------------------------------------------------------
-- 4. El corte del cajero
-- ---------------------------------------------------------------------------
ALTER TABLE shift_closings
  ADD COLUMN IF NOT EXISTS location_id    UUID REFERENCES supply_locations(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS opening_float  NUMERIC(12,2) NOT NULL DEFAULT 0,
  -- Los pedidos de la barra que seguian sin cobrar al cerrar, con el permiso del
  -- gerente que autorizo el corte: [{order_id, table_code, subtotal, taken_by_name}].
  ADD COLUMN IF NOT EXISTS pending_orders JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS pending_total  NUMERIC(12,2) NOT NULL DEFAULT 0;

ALTER TABLE shift_closings DROP CONSTRAINT IF EXISTS shift_closings_float_chk;
ALTER TABLE shift_closings ADD CONSTRAINT shift_closings_float_chk
  CHECK (opening_float >= 0 AND pending_total >= 0);

ALTER TABLE shift_closings DROP CONSTRAINT IF EXISTS shift_closings_pending_authorized_chk;
ALTER TABLE shift_closings ADD CONSTRAINT shift_closings_pending_authorized_chk
  CHECK (jsonb_array_length(pending_orders) = 0 OR authorized_by IS NOT NULL);

-- La guarda de D51/D54 aprende las columnas nuevas: el fondo, la barra y los
-- pendientes de un corte se congelan igual que los montos.
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
       OR NEW.pending_orders::text <> OLD.pending_orders::text
       OR NEW.pending_total <> OLD.pending_total THEN
      RAISE EXCEPTION 'shift_closings: lo declarado y lo cobrado no se editan (id=%)', OLD.id
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF OLD.status = 'confirmed' AND (
         NEW.status <> OLD.status
         OR NEW.counted_cash IS DISTINCT FROM OLD.counted_cash
         OR NEW.difference IS DISTINCT FROM OLD.difference
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
-- 5. El pedido que se cobra en caja
-- ---------------------------------------------------------------------------
-- La barra no sirve a credito (D47), con UNA excepcion desde D77: lo que levanta el
-- mesero entra a la barra al levantarlo y se cobra despues en la caja de esa barra.
-- La marca vive en el pedido y no se deduce del rol de quien lo tomo, porque el rol
-- de una persona cambia y la regla con la que nacio un pedido no.
ALTER TABLE drink_orders
  ADD COLUMN IF NOT EXISTS pay_at_till BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN drink_orders.pay_at_till IS
  'Lo levanto un mesero: entra a la barra sin pagar y se cobra en la caja de esa barra (D77).';

-- Lo que la barra tiene por cobrar se busca por barra y por estado del cobro, toda
-- la noche, desde la pantalla de caja.
CREATE INDEX IF NOT EXISTS drink_orders_bar_open_idx
  ON drink_orders (bar_location_id, created_at)
  WHERE status NOT IN ('delivered', 'cancelled');
