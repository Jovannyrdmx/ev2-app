-- ============================================================================
-- Migration 023: el rol de la noche, y el corte de la noche.
--
-- Dos cosas que el gerente no podia hacer y son la mitad de su trabajo:
--
--   1. Decir QUIEN atiende QUE. `staff_shifts` guarda UNA sola zona, y solo el
--      propio empleado puede abrir su turno desde su telefono. Asi que el rol de
--      la noche se armaba de palabra, y a las dos de la manana nadie podia decir
--      quien atendia la Terraza -- que es justo el dato del que dependen las
--      propinas y la responsabilidad de una mesa mal atendida.
--
--   2. Ver como salio una noche. El tablero de hoy es de AHORA MISMO: mesas
--      ocupadas, pedidos en curso, ingreso del dia. Se borra al dia siguiente.
--      Sin corte guardado no se pueden comparar dos viernes, y sin comparar no
--      hay manera de saber si el DJ invitado valio lo que costo.
--
-- ---------------------------------------------------------------------------
-- La venta viene de NUESTRO POS, y eso es una decision, no un pendiente
-- ---------------------------------------------------------------------------
-- El plan original (Fase 4 del manual) sincronizaba las ventas con
-- SoftRestaurant11. El dueno decidio NO hacer esa integracion por ahora y operar
-- con el POS de este sistema. Para el corte eso lo simplifica todo: la venta de
-- la noche sale de `drink_orders` y `transactions`, que son la fuente completa y
-- no una parte. El dia que se conecte un POS externo, el corte tendra que decir
-- de donde viene cada peso -- pero hoy no hace falta advertir de nada, y esta
-- migracion no deja preparada una columna para algo que quizas nunca pase.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. El rol de la noche: quien atiende que
--
-- Una fila por (persona, noche, destino). Un mesero que cubre Zona Roja y
-- Terraza tiene DOS filas, no un campo con una lista: una lista dentro de una
-- columna no se puede indexar, ni unir con `tables.section`, ni contar sin
-- partir cadenas -- y partir cadenas en SQL es como se pierde una zona.
--
-- `section` y `location_id` son excluyentes y al menos uno es obligatorio: un
-- mesero atiende una ZONA del plano, un bartender esta en una BARRA. Poner a un
-- bartender en una zona no significa nada, y el CHECK lo dice en vez de dejar
-- filas que nadie sabe leer.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS shift_assignments (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nightclub_id UUID NOT NULL REFERENCES nightclubs(id) ON DELETE CASCADE,
  -- La noche a la que pertenece. Obligatoria: una asignacion sin noche es una
  -- asignacion que no se sabe cuando aplica, y el rol de la noche pasada
  -- reapareceria el viernes siguiente.
  event_id     UUID NOT NULL REFERENCES events_calendar(id) ON DELETE CASCADE,
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- El rol con el que se le asigno, congelado. Si manana ese empleado cambia de
  -- puesto, el rol de aquella noche tiene que seguir diciendo que era mesero.
  role         VARCHAR(20) NOT NULL,
  -- Zona del plano (para meseros y hostess) -- coincide con `tables.section`.
  section      VARCHAR(40),
  -- Barra (para bartenders) -- apunta a `supply_locations`.
  location_id  UUID REFERENCES supply_locations(id) ON DELETE CASCADE,
  note         VARCHAR(200),
  assigned_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT shift_assignments_one_target CHECK (
    (section IS NOT NULL AND location_id IS NULL)
    OR (section IS NULL AND location_id IS NOT NULL)
  )
);

-- La misma persona a la misma zona la misma noche, una sola vez. Dos filas
-- iguales no dicen "la atiende el doble": son un error de captura que despues
-- duplica a esa persona en cada conteo del rol.
CREATE UNIQUE INDEX IF NOT EXISTS shift_assignments_unique_section
  ON shift_assignments (event_id, user_id, section) WHERE section IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS shift_assignments_unique_location
  ON shift_assignments (event_id, user_id, location_id) WHERE location_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS shift_assignments_event_idx ON shift_assignments (event_id, role);
CREATE INDEX IF NOT EXISTS shift_assignments_user_idx ON shift_assignments (user_id, event_id);

COMMENT ON TABLE shift_assignments IS
  'El rol de la noche: a quien, a que noche, y a que zona o barra. ASIGNADO no es PRESENTE: el turno sigue viviendo en staff_shifts (migracion 023).';
COMMENT ON COLUMN shift_assignments.role IS
  'El puesto congelado al asignar. Si la persona cambia de puesto, el rol de aquella noche no cambia.';

-- Una asignacion tiene que ser de gente y de lugares del MISMO club. La llave
-- foranea no sabe cruzar tres tablas, asi que lo dice un disparador -- mismo
-- criterio que `zone_bars` y `bar_requests`.
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
    -- A una persona se le asigna una BARRA, no el almacen: el almacen no
    -- atiende clientes y una asignacion ahi no significa nada.
    IF loc_kind IS DISTINCT FROM 'bar' THEN
      RAISE EXCEPTION 'shift_assignments.location_id must point at a bar, not %',
        COALESCE(loc_kind, 'nothing') USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS shift_assignments_check_club ON shift_assignments;
CREATE TRIGGER shift_assignments_check_club
  BEFORE INSERT OR UPDATE ON shift_assignments
  FOR EACH ROW EXECUTE FUNCTION shift_assignments_stay_in_one_club();

-- ---------------------------------------------------------------------------
-- 2. El corte de la noche, CONGELADO
--
-- Los numeros se calculan al cerrar y se GUARDAN. No se recalculan al abrir el
-- reporte, y eso es lo importante: si la semana que viene sube el precio de una
-- botella, o alguien corrige una receta, o se reasigna una mesa, el corte del
-- viernes tiene que seguir diciendo lo que dijo el viernes. Un reporte que
-- cambia solo no sirve para comparar dos noches ni para discutir una cifra con
-- nadie.
--
-- Es la misma razon por la que una reservacion congela su total al apartarse.
--
-- El detalle va en `jsonb` y no en cuarenta columnas a proposito: los bloques del
-- corte (zonas, categorias, barras) son listas de largo variable, y una columna
-- por categoria de bebida obligaria a una migracion cada vez que el club invente
-- un producto. Las cifras que SI se consultan para comparar noches -- total,
-- asistencia, ocupacion -- viven en columnas propias, porque de esas se ordena y
-- se suma.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS night_closings (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nightclub_id   UUID NOT NULL REFERENCES nightclubs(id) ON DELETE CASCADE,
  -- RESTRICT y no CASCADE: borrar una noche del calendario no puede borrar su
  -- corte. El corte es el registro de lo que paso, y lo que paso no se borra
  -- porque alguien limpie el calendario.
  event_id       UUID NOT NULL REFERENCES events_calendar(id) ON DELETE RESTRICT,
  event_date     DATE NOT NULL,
  currency       CHAR(3) NOT NULL DEFAULT 'MXN' CHECK (currency IN ('MXN','USD')),

  -- --- lo que se compara entre noches ---
  revenue_total     NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (revenue_total >= 0),
  revenue_bar       NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (revenue_bar >= 0),
  revenue_door      NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (revenue_door >= 0),
  revenue_tables    NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (revenue_tables >= 0),
  tips_total        NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (tips_total >= 0),
  -- Asistencia: los que entraron por la puerta mas los invitados de mesa.
  attendance        INTEGER NOT NULL DEFAULT 0 CHECK (attendance >= 0),
  reservations_booked  INTEGER NOT NULL DEFAULT 0 CHECK (reservations_booked >= 0),
  reservations_arrived INTEGER NOT NULL DEFAULT 0 CHECK (reservations_arrived >= 0),
  reservations_no_show INTEGER NOT NULL DEFAULT 0 CHECK (reservations_no_show >= 0),
  tables_total      INTEGER NOT NULL DEFAULT 0 CHECK (tables_total >= 0),
  tables_used       INTEGER NOT NULL DEFAULT 0 CHECK (tables_used >= 0),
  orders_count      INTEGER NOT NULL DEFAULT 0 CHECK (orders_count >= 0),
  -- Lo que el conteo fisico revelo que se fue sin venderse. Es el numero por el
  -- que existe todo el inventario.
  shrinkage_value   NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (shrinkage_value >= 0),

  -- --- el detalle, tal como se vio al cerrar ---
  detail         JSONB NOT NULL DEFAULT '{}'::jsonb,

  closed_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  closed_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  note           VARCHAR(300),

  -- Una noche se cierra UNA vez. Volver a cerrarla daria dos cortes distintos de
  -- la misma noche, y entonces ninguno de los dos es el corte.
  CONSTRAINT night_closings_one_per_event UNIQUE (event_id),
  -- No pueden haber llegado mas mesas de las que existen, ni mas reservaciones
  -- que las apartadas. Si la cuenta da eso, la consulta esta mal y es mejor que
  -- reviente al cerrar que enseñar un 120% de ocupacion.
  CONSTRAINT night_closings_tables_fit CHECK (tables_used <= tables_total),
  CONSTRAINT night_closings_reservations_fit
    CHECK (reservations_arrived + reservations_no_show <= reservations_booked)
);

CREATE INDEX IF NOT EXISTS night_closings_club_date_idx
  ON night_closings (nightclub_id, event_date DESC);

COMMENT ON TABLE night_closings IS
  'El corte de una noche, congelado al cerrar. No se recalcula: si cambia un precio despues, el corte sigue diciendo lo que dijo (migracion 023).';
COMMENT ON COLUMN night_closings.detail IS
  'Los bloques de largo variable: por zona, por categoria, por barra, por empleado. En jsonb porque una columna por categoria pediria una migracion cada vez que el club invente un producto.';

-- El corte es un registro de lo que paso: se escribe una vez y no se edita. Un
-- corte editable es un corte que no sirve para discutir una cifra con nadie --
-- mismo criterio que `transactions` y `supply_movements`.
CREATE OR REPLACE FUNCTION night_closings_are_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'night_closings is insert-only: a night is closed once, and the closing does not change'
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS night_closings_no_update ON night_closings;
CREATE TRIGGER night_closings_no_update
  BEFORE UPDATE OR DELETE ON night_closings
  FOR EACH ROW EXECUTE FUNCTION night_closings_are_immutable();
