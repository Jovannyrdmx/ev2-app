-- ============================================================================
-- Migration 047: el cajón de dinero, y el cambio en la puerta (D96).
--
-- 1. El cajón. Va conectado con su cable RJ11 a la impresora de recibos y se abre
--    con un pulso ESC/POS (`ESC p`). Cada impresora dice si tiene cajón y por qué
--    pin lo abre (2 o 5, según el cajón). El pulso viaja como un trabajo de
--    impresión más (`kind = 'drawer'`), así llega por el mismo agente y la misma
--    red que los recibos, sin abrir nada del club a internet.
--
-- 2. La puerta tiene su propia impresora (y su cajón). Las impresoras vivían
--    siempre en una barra; la de la puerta no tiene barra, así que su ubicación es
--    opcional SOLO para ese uso.
--
-- 3. Lo que la anfitriona recibe al cobrar un cover en efectivo: pesos, dólares o
--    los dos, el tipo de cambio de ese momento y el cambio que entregó en pesos.
--    Sin esto el corte de la puerta no puede separar los dólares del cajón.
-- ============================================================================

-- ---------------------------------------------------------------- 1. el cajón

ALTER TABLE printers
  ADD COLUMN IF NOT EXISTS drawer_pin SMALLINT;

ALTER TABLE printers DROP CONSTRAINT IF EXISTS printers_drawer_pin_chk;
ALTER TABLE printers ADD CONSTRAINT printers_drawer_pin_chk
  CHECK (drawer_pin IS NULL OR drawer_pin IN (2, 5));

COMMENT ON COLUMN printers.drawer_pin IS
  'Pin del conector RJ11 que abre el cajón (2 o 5). NULL: esta impresora no tiene cajón (D96).';

ALTER TABLE print_jobs DROP CONSTRAINT IF EXISTS print_jobs_kind_check;
ALTER TABLE print_jobs ADD CONSTRAINT print_jobs_kind_check
  CHECK (kind IN ('order','bill','receipt','shift_cut','test','cash_drop','drawer'));

-- ---------------------------------------------------------------- 2. la puerta

ALTER TABLE printers DROP CONSTRAINT IF EXISTS printers_purpose_check;
ALTER TABLE printers ADD CONSTRAINT printers_purpose_check
  CHECK (purpose IN ('orders','service','till','door'));

ALTER TABLE printers ALTER COLUMN location_id DROP NOT NULL;

ALTER TABLE printers DROP CONSTRAINT IF EXISTS printers_location_required_chk;
ALTER TABLE printers ADD CONSTRAINT printers_location_required_chk
  CHECK (purpose = 'door' OR location_id IS NOT NULL);

-- Una sola impresora de puerta activa por club: "la impresora de la puerta" tiene
-- que ser una respuesta, igual que la de cada barra.
CREATE UNIQUE INDEX IF NOT EXISTS printers_one_door_idx
  ON printers (nightclub_id) WHERE active AND purpose = 'door';

CREATE OR REPLACE FUNCTION printers_location_must_be_a_bar() RETURNS trigger AS $$
DECLARE
  target_kind VARCHAR(12);
  target_club UUID;
BEGIN
  -- La impresora de la puerta no está en ninguna barra.
  IF NEW.location_id IS NULL THEN
    RETURN NEW;
  END IF;
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

ALTER TABLE print_agents DROP CONSTRAINT IF EXISTS print_agents_purpose_chk;
ALTER TABLE print_agents ADD CONSTRAINT print_agents_purpose_chk
  CHECK (purpose IS NULL OR purpose IN ('orders','service','till'));

-- ---------------------------------------------------------------- 3. el cambio en la puerta

ALTER TABLE door_admissions
  ADD COLUMN IF NOT EXISTS cash_received    NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS usd_received     NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS exchange_rate    NUMERIC(12,6),
  ADD COLUMN IF NOT EXISTS exchange_rate_id BIGINT REFERENCES exchange_rates(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS usd_amount       NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS usd_change       NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS change_given     NUMERIC(12,2);

ALTER TABLE door_admissions DROP CONSTRAINT IF EXISTS door_admissions_tender_chk;
ALTER TABLE door_admissions ADD CONSTRAINT door_admissions_tender_chk CHECK (
  (cash_received IS NULL OR cash_received >= 0)
  AND (usd_received IS NULL OR usd_received > 0)
  AND (change_given IS NULL OR change_given >= 0)
  -- Dólares siempre con su tipo de cambio y lo que cubrieron en pesos.
  AND (usd_received IS NULL OR (exchange_rate IS NOT NULL AND usd_amount IS NOT NULL
                                AND usd_change IS NOT NULL))
  -- Lo recibido solo existe en un cobro en efectivo.
  AND ((cash_received IS NULL AND usd_received IS NULL) OR payment_method = 'cash')
);

COMMENT ON COLUMN door_admissions.cash_received IS 'Pesos que entregó el cliente en la puerta (D96).';
COMMENT ON COLUMN door_admissions.usd_received IS 'Dólares que entregó el cliente; se quedan en el cajón como dólares (D96).';
COMMENT ON COLUMN door_admissions.usd_amount IS 'Pesos del cover que cubrieron esos dólares al tipo de cambio de ese momento.';
COMMENT ON COLUMN door_admissions.usd_change IS 'Parte del cambio (en pesos) que salió por pagar con dólares de más.';
COMMENT ON COLUMN door_admissions.change_given IS 'Cambio total entregado, en pesos.';
