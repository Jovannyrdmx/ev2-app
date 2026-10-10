-- ============================================================================
-- Migration 033: buscar las impresoras en vez de teclear su IP (D55).
--
-- Dar de alta una impresora obligaba a teclear su dirección a mano, y una IP mal
-- escrita no se descubre al guardarla: se descubre cuando el ticket no sale, a las
-- dos de la mañana, con la barra llena. El gerente pide "buscar", la PC de la barra
-- barre su red, y lo que encuentra se escoge de una lista.
--
-- ---------------------------------------------------------------------------
-- Por qué tres columnas y no una tabla
-- ---------------------------------------------------------------------------
-- Un escaneo no es un objeto con vida propia: es **lo último que vio una PC**. Una
-- tabla `printer_scans` daría un historial que nadie va a leer —a quién le importa
-- lo que se veía en la red anteayer— y obligaría a limpiarla. Guardado en el agente,
-- el dato dice justo lo que hace falta y se pisa solo en cada búsqueda.
--
-- Y dice algo que una lista suelta no diría: **qué PC alcanza a cuál impresora**.
-- Con dos agentes, eso es lo que decide a quién ponerle de respaldo a quién.
-- ============================================================================

ALTER TABLE print_agents
  -- Cuándo se pidió la búsqueda. El agente lo ve en su siguiente vuelta —ya pregunta
  -- cada pocos segundos— así que no hace falta un segundo canal para avisarle.
  ADD COLUMN IF NOT EXISTS scan_requested_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS scan_at           TIMESTAMPTZ,
  -- Lo que encontró: una lista de objetos con `kind` (network|windows), la dirección
  -- o el nombre compartido, y el modelo cuando la impresora se identifica. Va como
  -- JSONB y no en columnas porque es un hallazgo, no un registro: se lee entero, se
  -- pisa entero, y nadie va a consultarlo por partes.
  ADD COLUMN IF NOT EXISTS scan_result       JSONB,
  -- Por qué no se pudo buscar. Un barrido que falla en silencio deja al gerente
  -- esperando una lista que no va a llegar.
  ADD COLUMN IF NOT EXISTS scan_error        TEXT;

-- Un resultado sin hora de búsqueda, o una hora sin resultado ni error, sería un
-- estado que la pantalla no sabría pintar.
ALTER TABLE print_agents DROP CONSTRAINT IF EXISTS print_agents_scan_chk;
ALTER TABLE print_agents ADD CONSTRAINT print_agents_scan_chk
  CHECK (scan_at IS NULL OR scan_result IS NOT NULL OR scan_error IS NOT NULL);
