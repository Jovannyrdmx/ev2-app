-- ============================================================================
-- Migration 027: el precio del cover deja de teclearse, y la puerta deja de
-- cobrar dos veces.
--
-- Dos defectos reales, encontrados en la revisión del 2026-09-20, los dos en la
-- misma ruta (`POST /door/admissions`):
--
-- 1. EL PRECIO LO PONÍA QUIEN COBRA. El servidor aceptaba `unit_price` del
--    cuerpo de la petición y lo asentaba en el libro sin comparar con nada. El
--    cover de la noche son $300, el cadenero cobra $300 y teclea 150: el libro
--    le da la razón y al cierre la caja CUADRA, contra un total que él mismo
--    escribió. Con doscientas entradas son treinta mil pesos por noche que el
--    sistema no puede detectar.
--
--    No se podía arreglar solo en el código porque el club no tenía dónde
--    guardar sus covers: los tres precios vivían inventados dentro de
--    `web/js/staff-screen.js`. Esta tabla es ese sitio.
--
-- 2. DOBLE TOQUE = DOBLE COBRO. `client_request_id` estaba declarado en la
--    validación de la ruta, no se leía en ninguna parte, y la columna no
--    existía. En la puerta, con mal wifi, la pantalla se queda pensando y el
--    cadenero toca otra vez: dos entradas, dos renglones en el libro y dos
--    juegos de QR válidos. Al cierre la caja aparece corta por la diferencia y
--    el faltante se lo carga él.
-- ============================================================================

-- ---------------------------------------------------------------- los covers del club

-- El catálogo de entradas. Lo carga el gerente; nace VACÍO a propósito: inventar
-- tres precios aquí sería repetir el defecto en otro archivo.
--
-- Mientras esté vacío, la puerta sigue cobrando con el precio tecleado (si no,
-- un club que actualice a media noche se queda sin poder vender). Ese caso queda
-- marcado en el libro como `price_source: 'manual'`, que es lo que permite
-- distinguir en el corte una venta con precio de catálogo de una a mano.
CREATE TABLE IF NOT EXISTS cover_prices (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nightclub_id  UUID NOT NULL REFERENCES nightclubs(id) ON DELETE CASCADE,
  -- Como lo llama la puerta: "COVER", "COVER S", "Cumpleañera".
  name          VARCHAR(40) NOT NULL,
  amount        NUMERIC(12,2) NOT NULL CHECK (amount >= 0),
  currency      CHAR(3) NOT NULL DEFAULT 'MXN' CHECK (currency IN ('MXN','USD')),
  active        BOOLEAN NOT NULL DEFAULT true,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  updated_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Dos covers con el mismo nombre en un club es una discusión en la puerta que
  -- nadie puede resolver.
  UNIQUE (nightclub_id, name)
);

CREATE INDEX IF NOT EXISTS cover_prices_club_idx
  ON cover_prices (nightclub_id, active, sort_order);

-- ---------------------------------------------------------------- la puerta, una sola vez

ALTER TABLE door_admissions
  ADD COLUMN IF NOT EXISTS client_request_id UUID,
  -- De qué salió el precio: del catálogo, de la tarifa de la noche, o tecleado.
  -- Va en la fila y no solo en el `metadata` del libro porque el corte de la
  -- noche lo va a querer contar, y contar dentro de un jsonb es caro y frágil.
  ADD COLUMN IF NOT EXISTS price_source VARCHAR(10)
    CHECK (price_source IS NULL OR price_source IN ('catalog','event','manual')),
  ADD COLUMN IF NOT EXISTS cover_price_id UUID REFERENCES cover_prices(id) ON DELETE SET NULL;

-- La protección de verdad. Parcial sobre no-nulos para no estorbar a las filas
-- viejas, que no tienen clave.
CREATE UNIQUE INDEX IF NOT EXISTS door_admissions_client_request_uidx
  ON door_admissions (client_request_id) WHERE client_request_id IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'cover_prices_set_updated_at') THEN
    CREATE TRIGGER cover_prices_set_updated_at BEFORE UPDATE ON cover_prices
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;
