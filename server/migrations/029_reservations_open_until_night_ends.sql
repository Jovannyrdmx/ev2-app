-- ============================================================================
-- Migration 029: las reservaciones ya no cierran antes de abrir.
--
-- Hasta hoy (2026-09-21) una noche dejaba de aceptar reservaciones
-- `min_advance_hours` antes de abrir las puertas (2 por omisión). El dueño decidió
-- quitar esa regla: una mesa se puede reservar siempre, incluso con el evento en
-- curso, mientras nadie más la tenga. Lo único que cierra las reservaciones de una
-- noche es que la noche termine (`closes_at`, o 8 horas después de abrir).
--
-- La columna no se borra: hay datos que la leen en respaldos y reportes viejos, y
-- borrarla no se puede deshacer. Se deja en 0 y con un comentario que dice que ya no
-- se aplica, para que nadie crea que todavía manda.
-- ============================================================================

UPDATE reservation_rules SET min_advance_hours = 0 WHERE min_advance_hours <> 0;

ALTER TABLE reservation_rules ALTER COLUMN min_advance_hours SET DEFAULT 0;

COMMENT ON COLUMN reservation_rules.min_advance_hours IS
  'YA NO SE APLICA (migración 029, 2026-09-21). Las reservaciones están abiertas hasta que termina la noche.';
