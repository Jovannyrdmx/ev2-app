-- ============================================================================
-- Migration 036: objetos perdidos y encontrados (D67).
--
-- ---------------------------------------------------------------------------
-- El problema real, que no es "hacer una lista"
-- ---------------------------------------------------------------------------
-- Una noche cualquiera aparecen un teléfono en el baño, una cartera bajo una mesa y
-- tres suéteres. Hoy eso vive en una caja detrás de la barra y en la memoria de quien
-- estaba ese día: al día siguiente nadie sabe qué hay, y quien llama preguntando por
-- su cartera recibe un "déjame preguntar" que no vuelve.
--
-- Pero la parte difícil no es guardar la lista. Es **entregarle el objeto a su dueño y
-- no a otro**.
--
-- ---------------------------------------------------------------------------
-- Por qué las señas del objeto NO son públicas
-- ---------------------------------------------------------------------------
-- Si la aplicación enseñara "iPhone 15 negro con funda roja y una calcomanía de un
-- gato", cualquiera puede leerlo y reclamarlo describiéndolo. La única prueba de que
-- algo es tuyo es que puedas describir lo que nadie más vio.
--
-- Por eso `details` —las señas particulares— **nunca sale hacia un cliente**. Lo que un
-- cliente ve del catálogo es categoría, zona y día: suficiente para decir "sí, creo que
-- es mío" y levantar su reporte, insuficiente para inventárselo. Quien perdió algo
-- escribe SUS señas en su propio reporte, y el personal compara los dos textos.
--
-- ---------------------------------------------------------------------------
-- Y por qué hay un código de entrega
-- ---------------------------------------------------------------------------
-- Porque emparejar no es entregar. Cuando el personal decide que el reporte de alguien
-- corresponde a un objeto guardado, el sistema genera un código que **solo ve el dueño
-- en su teléfono**. Quien entrega el objeto teclea ese código. Sin él, la entrega
-- depende de que quien está en la barra a las 4 de la mañana recuerde una cara.
--
-- El código se guarda hasheado, como todos los demás de este sistema: con la base
-- robada, nadie puede presentarse a recoger cosas ajenas.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS lost_items (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nightclub_id   UUID NOT NULL REFERENCES nightclubs(id) ON DELETE CASCADE,

  -- `lost` es "se me perdió"; `found` es "esto apareció". Son las dos mitades de la
  -- misma historia y viven en la misma tabla justamente para poder emparejarlas.
  kind           VARCHAR(6) NOT NULL CHECK (kind IN ('lost', 'found')),

  -- `open`     lost: buscando · found: en resguardo
  -- `matched`  hay un candidato y un código de entrega emitido
  -- `returned` se entregó a su dueño
  -- `closed`   se cerró sin entregar (se fue a la basura, nadie lo reclamó, era falsa alarma)
  status         VARCHAR(10) NOT NULL DEFAULT 'open'
                 CHECK (status IN ('open', 'matched', 'returned', 'closed')),

  -- La categoría es lo ÚNICO del objeto que un cliente ajeno llega a ver, junto con la
  -- zona y el día. Es cerrada a propósito: un campo libre acabaría con el modelo del
  -- teléfono escrito adentro, y eso es justo lo que no debe ser público.
  category       VARCHAR(12) NOT NULL
                 CHECK (category IN ('phone', 'wallet', 'keys', 'bag', 'clothing',
                                     'jewelry', 'document', 'other')),

  -- Las señas particulares. **Nunca salen hacia un cliente que no sea quien las
  -- escribió.** Es lo que permite comprobar que algo es de quien dice.
  details        TEXT,
  -- Dónde se perdió o apareció, en palabras del club ("terraza", "baño de abajo").
  place          VARCHAR(80),
  happened_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Quién levantó el reporte. Puede ser nulo: el personal también lo levanta por
  -- alguien que no tiene cuenta, y ahí sirven las dos columnas de abajo.
  reported_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  reporter_name  VARCHAR(80),
  reporter_phone VARCHAR(30),

  -- Solo para `found`: quién del personal lo tiene físicamente y dónde lo guardó. Un
  -- objeto entregado por un cliente nace SIN esto, y se llena cuando alguien del club
  -- lo recibe de verdad — la diferencia entre "alguien dijo que lo dejó" y "está en la
  -- caja" es la que hace que el catálogo sirva para algo.
  received_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  received_at    TIMESTAMPTZ,
  storage_note   VARCHAR(120),

  -- El otro lado de la historia: un `lost` apunta al `found` que parece ser suyo.
  match_id       UUID REFERENCES lost_items(id) ON DELETE SET NULL,

  -- El código de entrega, hasheado. Se emite al emparejar y vive en el renglón del
  -- DUEÑO (el `lost`), porque es él quien tiene que enseñarlo.
  handover_hash  TEXT,
  handover_hint  VARCHAR(8),

  returned_at    TIMESTAMPTZ,
  returned_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  closed_reason  VARCHAR(200),

  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Un objeto no se empareja consigo mismo: sería un ciclo de un solo paso.
  CHECK (match_id IS NULL OR match_id <> id),
  -- Entregado sin hora ni quién lo entregó sería una entrega que nadie firmó.
  CHECK (status <> 'returned' OR (returned_at IS NOT NULL AND returned_by IS NOT NULL)),
  -- Cerrar exige decir por qué. "Se cerró" sin motivo, tres meses después, no le
  -- responde nada a quien pregunta por su cartera.
  CHECK (status <> 'closed' OR closed_reason IS NOT NULL),
  -- Recibido a medias —quién sin cuándo— no se puede leer.
  CHECK (num_nonnulls(received_by, received_at) <> 1)
);

-- Las dos consultas que de verdad se hacen: el catálogo de lo que hay guardado, y los
-- reportes abiertos de una persona.
CREATE INDEX IF NOT EXISTS lost_items_club_idx
  ON lost_items (nightclub_id, kind, status, happened_at DESC);
CREATE INDEX IF NOT EXISTS lost_items_reporter_idx
  ON lost_items (reported_by, created_at DESC) WHERE reported_by IS NOT NULL;
-- Buscar por categoría es como el personal empareja: "teléfonos de este fin de semana".
CREATE INDEX IF NOT EXISTS lost_items_category_idx
  ON lost_items (nightclub_id, category, status);

/*
 * Las dos mitades tienen que ser de la misma clase y del mismo club.
 *
 * Emparejar un `lost` con otro `lost` no significa nada, y emparejarlo con algo de
 * otro club sería entregar el objeto de un club en otro. Se para aquí porque es el
 * único lugar donde la regla no se puede saltar.
 */
CREATE OR REPLACE FUNCTION lost_items_match_guard() RETURNS trigger AS $$
DECLARE
  otro_kind VARCHAR(6);
  otro_club UUID;
BEGIN
  IF NEW.match_id IS NULL THEN RETURN NEW; END IF;
  SELECT kind, nightclub_id INTO otro_kind, otro_club FROM lost_items WHERE id = NEW.match_id;
  IF otro_club IS DISTINCT FROM NEW.nightclub_id THEN
    RAISE EXCEPTION 'lost_items: ese objeto es de otro club'
      USING ERRCODE = 'check_violation';
  END IF;
  IF otro_kind = NEW.kind THEN
    RAISE EXCEPTION 'lost_items: un reporte se empareja con su contrario, no con otro igual'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS lost_items_check_match ON lost_items;
CREATE TRIGGER lost_items_check_match
  BEFORE INSERT OR UPDATE ON lost_items
  FOR EACH ROW EXECUTE FUNCTION lost_items_match_guard();

/*
 * Una entrega no se borra ni se reescribe.
 *
 * Es la constancia de que ese objeto salió del club y con quién. Si se pudiera editar,
 * "¿a quién le entregaron mi cartera?" dejaría de tener respuesta justo cuando alguien
 * la pregunte en serio — que es el único momento en que esa pregunta se hace.
 */
CREATE OR REPLACE FUNCTION lost_items_returned_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'lost_items: un objeto entregado no se borra (id=%)', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status = 'returned' AND (
       NEW.status <> 'returned' OR NEW.returned_at <> OLD.returned_at
       OR NEW.returned_by IS DISTINCT FROM OLD.returned_by) THEN
    RAISE EXCEPTION 'lost_items: esa entrega ya está asentada (id=%)', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS lost_items_immutable ON lost_items;
CREATE TRIGGER lost_items_immutable
  BEFORE UPDATE OR DELETE ON lost_items
  FOR EACH ROW WHEN (OLD.status = 'returned')
  EXECUTE FUNCTION lost_items_returned_guard();

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'lost_items_set_updated_at') THEN
    CREATE TRIGGER lost_items_set_updated_at BEFORE UPDATE ON lost_items
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

COMMIT;
