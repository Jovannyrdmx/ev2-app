-- ============================================================================
-- Migration 072: dos (o más) eventos el mismo día, sin que sus horarios se enciman (D130).
--
-- Hasta aquí había un evento por fecha (`UNIQUE (nightclub_id, event_date)`). El club
-- quiere, por ejemplo, una tardeada y la noche el mismo día. Lo que de verdad importa no
-- es la fecha sino el HORARIO: la caja, la puerta, los RP, el crédito VIP, las
-- promociones y los avisos buscan "el evento en curso" por su hora de apertura y de
-- cierre, y dos eventos encimados harían ambigua esa pregunta.
--
-- La regla nueva: los eventos de un club que no están cancelados no se enciman. Sin
-- hora de cierre se cuentan 8 horas (lo mismo que ya suponen `till.js` y las rutas).
--
-- Es un disparador y no un EXCLUDE: `timestamptz + interval` no es IMMUTABLE y no puede
-- ir en un índice. El candado por club hace que dos altas al mismo tiempo no se cuelen.
-- ============================================================================

ALTER TABLE events_calendar DROP CONSTRAINT IF EXISTS events_calendar_nightclub_id_event_date_key;

CREATE OR REPLACE FUNCTION events_calendar_no_overlap() RETURNS trigger AS $$
DECLARE
  choque RECORD;
  fin    TIMESTAMPTZ;
BEGIN
  IF NEW.status = 'cancelled' THEN
    RETURN NEW;
  END IF;
  -- Solo cuando cambia algo que mueve el horario o lo revive.
  IF TG_OP = 'UPDATE'
     AND NEW.doors_open_at = OLD.doors_open_at
     AND NEW.closes_at IS NOT DISTINCT FROM OLD.closes_at
     AND NEW.nightclub_id = OLD.nightclub_id
     AND OLD.status <> 'cancelled' THEN
    RETURN NEW;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('events_calendar:' || NEW.nightclub_id::text));
  fin := COALESCE(NEW.closes_at, NEW.doors_open_at + interval '8 hours');
  SELECT e.id, e.name, e.doors_open_at,
         COALESCE(e.closes_at, e.doors_open_at + interval '8 hours') AS cierra
    INTO choque
    FROM events_calendar e
   WHERE e.nightclub_id = NEW.nightclub_id
     AND e.id <> NEW.id
     AND e.status <> 'cancelled'
     AND e.doors_open_at < fin
     AND COALESCE(e.closes_at, e.doors_open_at + interval '8 hours') > NEW.doors_open_at
   ORDER BY e.doors_open_at
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'events_calendar: se encima con otro evento'
      USING ERRCODE = 'exclusion_violation',
            CONSTRAINT = 'events_calendar_no_overlap',
            DETAIL = json_build_object('id', choque.id, 'name', choque.name,
                                       'doors_open_at', choque.doors_open_at,
                                       'closes_at', choque.cierra)::text;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS events_calendar_no_overlap ON events_calendar;
CREATE TRIGGER events_calendar_no_overlap
  BEFORE INSERT OR UPDATE ON events_calendar
  FOR EACH ROW EXECUTE FUNCTION events_calendar_no_overlap();

COMMENT ON TABLE events_calendar IS
  'Eventos del club. Varios por fecha (D130) mientras sus horarios no se enciman; sin cierre se cuentan 8 horas.';
