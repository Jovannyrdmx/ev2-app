-- ============================================================================
-- Migration 020: el anticipo se puede cambiar por evento.
--
-- La regla del club sigue siendo la de D17: la mesa se aparta con un anticipo,
-- 30% por omision, y eso vive en `reservation_rules`. Lo que faltaba es lo que
-- ya existia para el precio de zona y para los boletos incluidos: poder
-- sobrescribirlo **para una sola noche**, sin tocar la lista vigente.
--
-- Por que hace falta: no todas las noches valen lo mismo para el club. Un 31 de
-- diciembre o un artista invitado justifican pedir el 100% por adelantado -- una
-- mesa que se cae esa noche no se vuelve a vender -- y un martes de temporada
-- baja justifica pedir el 10% para que la gente se anime a apartar. Hasta ahora
-- cambiar eso significaba mover la regla del club entero, que afecta a todas las
-- noches futuras, y acordarse de volverla a poner. Nadie se acuerda.
--
-- NULL quiere decir "usa la regla del club", igual que en `event_zone_pricing`.
-- Es lo que distingue "esta noche no tiene nada especial" de "esta noche el
-- anticipo es 0%", que son cosas distintas y una de las dos regala mesas.
-- ============================================================================

ALTER TABLE events_calendar
  ADD COLUMN IF NOT EXISTS deposit_pct NUMERIC(5,2)
    CHECK (deposit_pct IS NULL OR (deposit_pct >= 0 AND deposit_pct <= 100));

COMMENT ON COLUMN events_calendar.deposit_pct IS
  'Anticipo de esta noche, en por ciento. NULL = usar reservation_rules.deposit_pct del club.';

-- Nada que rellenar: todas las noches que ya existen se quedan en NULL, que es
-- exactamente el comportamiento que tenian antes de esta migracion.
