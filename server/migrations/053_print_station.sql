-- ============================================================================
-- Migration 053: la estación de caja de un solo paso (D99).
--
-- Una estación es una PC + su impresora USB + su cajón. Antes eran cuatro pantallas:
-- dar de alta la PC, buscar impresoras, registrar la que apareció y editarla para
-- decirle que tiene cajón. Ahora el gerente dice una vez qué es (nombre, lugar, si
-- tiene cajón), recibe el código, y la PC que lo canjea registra sola su impresora.
--
-- `station` viaja en el código y se copia a la PC al canjearlo:
--   { name, purpose, drawer_pin, status, message, printer_id, candidates }
-- `status`: pending | done | choose | none | blocked.
-- ============================================================================
ALTER TABLE print_agent_invites ADD COLUMN IF NOT EXISTS station JSONB;
ALTER TABLE print_agents        ADD COLUMN IF NOT EXISTS station JSONB;

COMMENT ON COLUMN print_agents.station IS
  'Lo que el gerente pidió al dar de alta la PC (D99): nombre, uso, cajón y cómo va el registro automático de su impresora USB.';
