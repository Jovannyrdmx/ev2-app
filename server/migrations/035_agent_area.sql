-- ============================================================================
-- Migration 035: cada PC sabe a qué barra pertenece (D61).
--
-- ---------------------------------------------------------------------------
-- El problema que resuelve
-- ---------------------------------------------------------------------------
-- Hasta hoy una PC dada de alta tomaba **cualquier** trabajo de la cola del club.
-- Con una sola PC eso está bien y es lo más simple que funciona. Con cuatro —la de
-- la barra de abajo, la de arriba, la de la terraza y la comandera de meseros— deja
-- de estarlo: la primera que pregunte se lleva el ticket de la barra de al lado y lo
-- imprime en SU impresora. El bartender de abajo recibe las comandas de arriba, el
-- de arriba no recibe nada, y no hay forma de entender por qué mirando el panel.
--
-- No es una carrera que se pueda perder a veces: se pierde siempre, porque la PC más
-- rápida se lleva todo. `printers` ya sabe en qué barra está cada impresora y para
-- qué sirve; lo que faltaba es que la PC también lo supiera.
--
-- ---------------------------------------------------------------------------
-- Por qué las dos columnas admiten NULL
-- ---------------------------------------------------------------------------
-- Porque un club con una sola PC no tiene nada que repartir, y obligarlo a elegir
-- una barra sería papeleo sin sentido. `NULL` significa "esta PC atiende todo el
-- club", que es exactamente lo que hacían las PCs que ya estaban dadas de alta antes
-- de esta migración. Así nadie se queda sin imprimir la noche del despliegue.
--
-- El día que el club tenga dos PCs, el panel las manda a elegir barra. Eso se empuja
-- desde la pantalla, no desde una restricción aquí: una base que se niega a guardar
-- deja al gerente con un error rojo a media noche, y lo que hay que darle es una
-- lista de barras.
-- ============================================================================

-- ---------------------------------------------------------------- las PCs

ALTER TABLE print_agents
  -- La barra que atiende esta PC. `ON DELETE RESTRICT` y no `SET NULL` a propósito:
  -- borrar una barra no puede convertir en silencio a su PC en una que imprime todo
  -- el club. Que falle y que alguien decida.
  ADD COLUMN IF NOT EXISTS location_id UUID REFERENCES supply_locations(id) ON DELETE RESTRICT,
  -- Qué papel le toca, con los mismos dos valores que `printers.purpose`:
  -- `orders` es la PC del bartender, `service` la comandera de meseros. NULL es
  -- "los dos", para la PC única que hace todo.
  ADD COLUMN IF NOT EXISTS purpose VARCHAR(10);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'print_agents_purpose_chk') THEN
    ALTER TABLE print_agents
      ADD CONSTRAINT print_agents_purpose_chk
      CHECK (purpose IS NULL OR purpose IN ('orders','service'));
  END IF;
  -- Un propósito sin barra no se puede resolver: "la comandera" de cuál barra. Se
  -- para aquí porque es el único lugar donde la regla no se puede saltar.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'print_agents_area_chk') THEN
    ALTER TABLE print_agents
      ADD CONSTRAINT print_agents_area_chk
      CHECK (purpose IS NULL OR location_id IS NOT NULL);
  END IF;
END $$;

-- Es la consulta que corre cada tres segundos por cada PC del club: la que decide si
-- un trabajo le toca a esta o no. Sin índice, cada latido de cada PC lee la tabla.
CREATE INDEX IF NOT EXISTS print_agents_area_idx
  ON print_agents (nightclub_id, location_id, purpose) WHERE active;

/*
 * La barra de una PC tiene que ser una barra, y del mismo club.
 *
 * Es la misma regla que `printers` ya tiene, y por la misma razón: `location_id`
 * apunta a `supply_locations`, donde también viven la bodega y la caja fuerte.
 * Asignarle a una PC la bodega la dejaría sin imprimir nunca, sin que nada avisara.
 *
 * El cruce de clubes es más serio que un error de dedo: sería una PC de un club
 * tomando el papel de otro. Con una sola base para varios clubes, esa comprobación es
 * lo único que lo impide.
 */
CREATE OR REPLACE FUNCTION print_agents_location_must_be_a_bar() RETURNS trigger AS $$
DECLARE
  target_kind VARCHAR(12);
  target_club UUID;
BEGIN
  IF NEW.location_id IS NULL THEN RETURN NEW; END IF;
  SELECT kind, nightclub_id INTO target_kind, target_club
    FROM supply_locations WHERE id = NEW.location_id;
  IF target_kind IS DISTINCT FROM 'bar' THEN
    RAISE EXCEPTION 'print_agents.location_id must point at a bar, not %',
      COALESCE(target_kind, 'nothing') USING ERRCODE = 'check_violation';
  END IF;
  IF target_club IS DISTINCT FROM NEW.nightclub_id THEN
    RAISE EXCEPTION 'print_agents: the bar belongs to another nightclub'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS print_agents_check_location ON print_agents;
CREATE TRIGGER print_agents_check_location
  BEFORE INSERT OR UPDATE ON print_agents
  FOR EACH ROW EXECUTE FUNCTION print_agents_location_must_be_a_bar();

-- ---------------------------------------------------------------- los códigos

/*
 * El código de emparejamiento lleva la barra puesta.
 *
 * Sin esto, dar de alta una PC son dos pasos separados: teclear el código en la
 * máquina, y después volver al panel a decirle a cuál barra pertenece. Entre uno y
 * otro hay una PC dada de alta que se lleva el papel de todo el club — justo el
 * problema que esta migración arregla, reaparecido en la ventana de la instalación.
 *
 * Yendo en el código, el gerente elige la barra ANTES de que exista la PC, y la PC
 * nace ya asignada. Quien está frente a la máquina de la barra solo teclea ocho
 * caracteres, que es lo único que se le puede pedir a alguien a las once de la noche.
 */
ALTER TABLE print_agent_invites
  ADD COLUMN IF NOT EXISTS location_id UUID REFERENCES supply_locations(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS purpose VARCHAR(10);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'print_agent_invites_purpose_chk') THEN
    ALTER TABLE print_agent_invites
      ADD CONSTRAINT print_agent_invites_purpose_chk
      CHECK (purpose IS NULL OR purpose IN ('orders','service'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'print_agent_invites_area_chk') THEN
    ALTER TABLE print_agent_invites
      ADD CONSTRAINT print_agent_invites_area_chk
      CHECK (purpose IS NULL OR location_id IS NOT NULL);
  END IF;
END $$;
