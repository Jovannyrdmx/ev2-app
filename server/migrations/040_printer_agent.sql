-- ============================================================================
-- Migration 040: cada impresora sabe qué PC la atiende (D80).
--
-- Una impresora USB solo existe para la PC a la que está conectada. Sin este dato,
-- cualquier PC de esa barra podía tomar su ticket, fallar y reintentar. Con él, el
-- ticket solo lo toma esa PC. Es opcional: las de red las alcanza cualquiera, y las
-- impresoras dadas de alta antes de esto siguen funcionando igual.
-- ============================================================================
ALTER TABLE printers
  ADD COLUMN IF NOT EXISTS agent_id UUID REFERENCES print_agents(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS printers_agent_idx ON printers (agent_id) WHERE agent_id IS NOT NULL;

COMMENT ON COLUMN printers.agent_id IS
  'La PC (agente) que atiende esta impresora. Si está puesto, solo ese agente toma sus trabajos (D80).';
