-- ============================================================================
-- Migration 031: imprimir en papel, desde un servidor que no ve la impresora (D52).
--
-- El club tiene impresoras térmicas de 80 mm en la red local. El servidor está en
-- un VPS, del otro lado del módem: NO puede abrir el puerto 9100 de ninguna de
-- ellas, y el navegador tampoco sabe abrir una conexión TCP cruda. Esa es la
-- restricción que da forma a todo lo de abajo.
--
-- La solución es una cola y un agente. El servidor decide QUÉ se imprime y DÓNDE, y
-- deja el trabajo escrito con los bytes ya armados. Un programa chico —el agente—
-- corre en una PC de barra, se conecta HACIA AFUERA (no hay que abrir un solo
-- puerto del club a internet), toma trabajos y se los pasa a la impresora.
--
-- ---------------------------------------------------------------------------
-- Por qué una cola y no una llamada directa
-- ---------------------------------------------------------------------------
-- Porque las impresoras se quedan sin papel, se atascan y se apagan, y eso pasa a
-- las dos de la mañana con la barra llena. Si imprimir fuera una llamada directa,
-- el pedido fallaría con la impresora. Con una cola, el trago sale igual y el papel
-- se reintenta; y si de plano no sale, queda escrito cuál no salió en vez de
-- desaparecer sin que nadie se entere.
--
-- ---------------------------------------------------------------------------
-- Las cuatro tablas
-- ---------------------------------------------------------------------------
--   * `print_agents`   — qué PCs pueden imprimir, con su token.
--   * `printers`       — cada impresora, colgada de una barra y con un PROPÓSITO.
--   * `print_jobs`     — la cola: los bytes, a dónde van, y qué pasó con ellos.
--   * `nightclub_print_settings` — el interruptor del admin.
--
-- El propósito es lo que hace que esto se enrute solo: en cada barra hay una PC de
-- bartender (comandas) y una de meseros (cuentas y recibos). Un pedido de la
-- terraza va a la impresora de `orders` de la barra que atiende la terraza —que
-- `zone_bars` ya sabe, incluso cuando el gerente reasigna zonas a media noche—, y
-- la cuenta de esa misma mesa va a la de `service` de esa misma barra.
-- ============================================================================

-- ---------------------------------------------------------------- los agentes

CREATE TABLE IF NOT EXISTS print_agents (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nightclub_id   UUID NOT NULL REFERENCES nightclubs(id) ON DELETE CASCADE,
  name           VARCHAR(60) NOT NULL,
  -- El token se guarda hasheado, como una contraseña: si alguien se lleva la base,
  -- no se lleva la llave con la que un agente toma trabajos.
  token_hash     TEXT NOT NULL,
  -- Los últimos cuatro caracteres, para que el gerente distinga en el panel cuál
  -- agente es cuál sin que el token completo vuelva a aparecer nunca.
  token_hint     VARCHAR(8) NOT NULL,
  -- Cuándo se asomó por última vez. Es lo único que distingue "no hay trabajos" de
  -- "esa PC lleva tres horas apagada", y el panel lo pinta en rojo.
  last_seen_at   TIMESTAMPTZ,
  agent_version  VARCHAR(20),
  active         BOOLEAN NOT NULL DEFAULT true,
  created_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (nightclub_id, name)
);

CREATE INDEX IF NOT EXISTS print_agents_club_idx ON print_agents (nightclub_id, active);
-- El agente se identifica en cada consulta con su token. La búsqueda es por esta
-- huella y tiene que ser única: dos agentes con el mismo token serían el mismo
-- agente, y el panel no podría decir cuál de las dos PCs dejó de imprimir.
CREATE UNIQUE INDEX IF NOT EXISTS print_agents_token_idx ON print_agents (token_hash);

-- ---------------------------------------------------------------- las impresoras

CREATE TABLE IF NOT EXISTS printers (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nightclub_id   UUID NOT NULL REFERENCES nightclubs(id) ON DELETE CASCADE,
  -- La barra donde está físicamente. Se apoya en `supply_locations` (kind='bar')
  -- para no inventar un segundo modelo de "dónde está cada cosa" en el club.
  location_id    UUID NOT NULL REFERENCES supply_locations(id) ON DELETE RESTRICT,
  name           VARCHAR(60) NOT NULL,
  -- Qué papel le toca. `orders` es la PC del bartender; `service` la de meseros.
  purpose        VARCHAR(10) NOT NULL CHECK (purpose IN ('orders','service')),

  -- Cómo se le habla. `network` es lo normal: IP y puerto 9100, en crudo.
  -- `windows` es para la impresora que cuelga por USB de una PC: el agente se la
  -- pasa al spooler por nombre, y entonces `host` no aplica.
  connection     VARCHAR(10) NOT NULL DEFAULT 'network'
                 CHECK (connection IN ('network','windows')),
  host           VARCHAR(120),
  port           INTEGER NOT NULL DEFAULT 9100 CHECK (port BETWEEN 1 AND 65535),
  windows_name   VARCHAR(120),

  -- El papel y cómo escribe. Las Xprinter de 80 mm dan 48 columnas en fuente A.
  paper_width    INTEGER NOT NULL DEFAULT 80 CHECK (paper_width IN (58, 80)),
  columns        INTEGER NOT NULL DEFAULT 48 CHECK (columns BETWEEN 24 AND 64),
  -- Estas impresoras salen de fábrica en CP437, que no tiene ni ñ ni acentos. Es
  -- configurable porque el valor correcto se averigua imprimiendo, no leyendo la
  -- ficha: el botón de prueba existe para eso.
  codepage       VARCHAR(12) NOT NULL DEFAULT 'CP850',
  has_cutter     BOOLEAN NOT NULL DEFAULT true,

  -- A dónde se manda si esta no contesta. Normalmente la hermana de la misma
  -- barra: una impresora atascada no puede parar la barra entera.
  fallback_id    UUID REFERENCES printers(id) ON DELETE SET NULL,
  active         BOOLEAN NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (nightclub_id, name),
  -- Una impresora de red sin dirección no es una impresora; una de Windows sin
  -- nombre tampoco. Se para aquí y no en el agente, que es donde ya sería tarde.
  CHECK (connection <> 'network' OR host IS NOT NULL),
  CHECK (connection <> 'windows' OR windows_name IS NOT NULL),
  -- Una impresora no se puede tener a sí misma de respaldo: sería un ciclo de un
  -- solo paso, y el reintento nunca saldría de ella.
  CHECK (fallback_id IS NULL OR fallback_id <> id)
);

-- Una sola impresora activa por barra y propósito: si hubiera dos, "la impresora
-- de comandas de la barra de abajo" dejaría de ser una respuesta.
CREATE UNIQUE INDEX IF NOT EXISTS printers_one_per_purpose_idx
  ON printers (location_id, purpose) WHERE active;
CREATE INDEX IF NOT EXISTS printers_club_idx ON printers (nightclub_id, active);

CREATE OR REPLACE FUNCTION printers_location_must_be_a_bar() RETURNS trigger AS $$
DECLARE
  target_kind VARCHAR(12);
  target_club UUID;
BEGIN
  SELECT kind, nightclub_id INTO target_kind, target_club
    FROM supply_locations WHERE id = NEW.location_id;
  IF target_kind IS DISTINCT FROM 'bar' THEN
    RAISE EXCEPTION 'printers.location_id must point at a bar, not %', COALESCE(target_kind, 'nothing')
      USING ERRCODE = 'check_violation';
  END IF;
  IF target_club IS DISTINCT FROM NEW.nightclub_id THEN
    RAISE EXCEPTION 'printers: the bar belongs to another nightclub'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS printers_check_location ON printers;
CREATE TRIGGER printers_check_location
  BEFORE INSERT OR UPDATE ON printers
  FOR EACH ROW EXECUTE FUNCTION printers_location_must_be_a_bar();

-- ---------------------------------------------------------------- la cola

CREATE TABLE IF NOT EXISTS print_jobs (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nightclub_id   UUID NOT NULL REFERENCES nightclubs(id) ON DELETE CASCADE,
  printer_id     UUID NOT NULL REFERENCES printers(id) ON DELETE RESTRICT,
  kind           VARCHAR(12) NOT NULL
                 CHECK (kind IN ('order','bill','receipt','shift_cut','test')),
  -- De qué es este papel: el pedido, la mesa, el cobro, el corte. Sirve para
  -- reimprimir sin volver a calcular, y para saber qué se quedó sin salir.
  ref_id         UUID,
  copies         INTEGER NOT NULL DEFAULT 1 CHECK (copies BETWEEN 1 AND 5),

  -- Los bytes ya armados. Se guardan hechos, no se arman al momento de imprimir:
  -- una reimpresión tiene que sacar EXACTAMENTE el mismo papel, aunque los precios
  -- hayan cambiado o el pedido se haya editado desde entonces.
  payload        BYTEA NOT NULL,
  -- El mismo ticket en texto plano, para verlo en pantalla y para que un problema
  -- de impresión se pueda diagnosticar sin descifrar bytes.
  preview        TEXT NOT NULL,

  status         VARCHAR(10) NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','taken','printed','failed')),
  attempts       INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error     TEXT,
  taken_by       UUID REFERENCES print_agents(id) ON DELETE SET NULL,
  taken_at       TIMESTAMPTZ,
  printed_at     TIMESTAMPTZ,
  -- Si se mandó aquí porque la de antes falló, de cuál venía.
  rerouted_from  UUID REFERENCES printers(id) ON DELETE SET NULL,
  created_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (status <> 'printed' OR printed_at IS NOT NULL),
  CHECK (status <> 'failed' OR last_error IS NOT NULL)
);

-- El índice del que vive el agente: lo pendiente de este club, lo más viejo
-- primero, sin recorrer la noche entera.
CREATE INDEX IF NOT EXISTS print_jobs_pending_idx
  ON print_jobs (nightclub_id, created_at) WHERE status IN ('pending','taken');
CREATE INDEX IF NOT EXISTS print_jobs_printer_idx ON print_jobs (printer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS print_jobs_ref_idx ON print_jobs (ref_id) WHERE ref_id IS NOT NULL;

-- Lo que ya salió en papel no se reescribe ni se borra. Un ticket impreso está en
-- la mano de alguien: cambiar aquí lo que dice sería inventar una historia distinta
-- de la que anda circulando por el club.
CREATE OR REPLACE FUNCTION print_jobs_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'print_jobs: un trabajo no se borra (id=%)', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.payload <> OLD.payload OR NEW.preview <> OLD.preview
     OR NEW.printer_id <> OLD.printer_id OR NEW.kind <> OLD.kind
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'print_jobs: el contenido de un trabajo no se edita (id=%)', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status = 'printed' AND NEW.status <> 'printed' THEN
    RAISE EXCEPTION 'print_jobs: ese trabajo ya se imprimió (id=%)', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS print_jobs_immutable ON print_jobs;
CREATE TRIGGER print_jobs_immutable BEFORE UPDATE OR DELETE ON print_jobs
  FOR EACH ROW EXECUTE FUNCTION print_jobs_guard();

-- ---------------------------------------------------------------- el interruptor

CREATE TABLE IF NOT EXISTS nightclub_print_settings (
  nightclub_id        UUID PRIMARY KEY REFERENCES nightclubs(id) ON DELETE CASCADE,
  -- Lo que pidió el dueño: que el admin decida si cada pedido saca su comanda en la
  -- barra. Arranca APAGADO a propósito —un club sin impresoras configuradas no
  -- debe empezar a encolar papel que nadie va a recoger.
  print_order_tickets BOOLEAN NOT NULL DEFAULT false,
  -- El recibo de cobro sí sale siempre: es el respaldo de que ese dinero entró, y
  -- es lo que hace que el corte del turno cuadre sin discutir.
  print_receipts      BOOLEAN NOT NULL DEFAULT true,
  -- Cuántas veces se reintenta un papel antes de darlo por perdido y avisar.
  max_attempts        INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10),
  -- El encabezado del papel. Si está vacío se usa el nombre del club.
  header_text         VARCHAR(120),
  footer_text         VARCHAR(160),
  updated_by          UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- updated_at

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['print_agents','printers','print_jobs'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = t || '_set_updated_at') THEN
      EXECUTE format('CREATE TRIGGER %I_set_updated_at BEFORE UPDATE ON %I '
                     'FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t, t);
    END IF;
  END LOOP;
END $$;
