-- ============================================================================
-- Migration 024: la foto del ticket o la factura.
--
-- La 022 dejo la captura en lote, y funciona: quince renglones en una transaccion,
-- con proveedor y `receipt_group`. Pero sigue siendo TECLEAR quince renglones de
-- pie, a la hora que llega el camion, con la caja en la otra mano. Y cuando eso
-- cansa, lo que pasa no es que se capture mal: es que no se captura, y el
-- inventario deja de servir para nada a la tercera entrega.
--
-- ---------------------------------------------------------------------------
-- Las dos cosas que hace esta tabla, y son dos
-- ---------------------------------------------------------------------------
--
-- 1. **Guarda el comprobante.** Esto vale por si mismo, sin OCR ni nada: tener la
--    foto de la factura amarrada a la entrada es lo que despues contesta "este
--    tequila lo pagamos a 900 o a 1,100", y lo que permite reclamarle al
--    proveedor. Aunque el reconocimiento falle por completo, la foto queda.
--
-- 2. **Pre-llena los renglones.** Tesseract lee la imagen, y lo que saca se
--    GUARDA COMO SUGERENCIA, en `parsed`, no como movimiento. Nada del inventario
--    se mueve hasta que una persona revisa renglon por renglon y guarda. Un
--    ticket termico mal impreso lee "l" donde dice "1" y confunde un 8 con un 3;
--    dejar que eso entre solo al inventario seria peor que teclearlo.
--
-- El orden importa: la foto se guarda ANTES de intentar leerla. Si el OCR truena,
-- se queda `failed` con su razon escrita y la captura sigue a mano, con la foto ya
-- adentro. La captura nunca depende de que el reconocimiento funcione.
--
-- ---------------------------------------------------------------------------
-- Decisiones
-- ---------------------------------------------------------------------------
--
-- * La imagen NO va en la base. Va en disco (`RECEIPTS_DIR`, un volumen del
--   contenedor) y aqui solo su ruta relativa, su tipo y su tamano. Un club que
--   recibe tres veces por semana junta cientos de fotos de dos megas: metidas en
--   Postgres hacen que cada respaldo tarde el triple y que restaurar la base de un
--   viernes por la noche sea imposible. La ruta es relativa a proposito, para que
--   mover el volumen no invalide cada renglon.
--
-- * `parsed` es JSONB y no columnas. Lo que devuelve un OCR no tiene forma fija:
--   hoy son renglones con cantidad y precio, manana un folio y un total. Guardarlo
--   crudo, tal como se leyo, es lo que permite volver a interpretarlo con mejores
--   reglas sin perder las fotos viejas.
--
-- * `receipt_group` se llena DESPUES, cuando la entrada se guarda, y se queda en
--   NULL si nadie la guardo. Una foto sin `receipt_group` es una entrega
--   fotografiada que nunca se capturo -- y poder listarlas es justo lo que
--   descubre la mercancia que entro sin registrar.
--
-- * `pg_trgm` se habilita aqui para parecidos de nombre. El ticket dice "TEQ DON
--   JULIO 70 750", el catalogo dice "Tequila Don Julio 70 Anejo"; sin parecido por
--   trigramas no hay forma de proponer el insumo correcto, y sin propuesta el OCR
--   no ahorra nada: quien captura tendria que buscar los quince a mano igual.
-- ============================================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Normaliza un nombre para comparar: minusculas, sin acentos, sin espacios sobrantes.
--
-- Los acentos se quitan con `translate` y no con la extension `unaccent` a proposito:
-- `unaccent` no es IMMUTABLE, asi que no se puede indexar sin envolverla, y un indice
-- es justo lo que hace falta aqui. Un ticket dice "ANEJO" y el catalogo "Añejo"; sin
-- esto son dos palabras distintas y el parecido no encuentra nada.
--
-- El servidor tiene la MISMA normalizacion en JavaScript (`services/receipt-ocr.js`).
-- Si una cambia sin la otra, el indice deja de servir en silencio: sigue devolviendo
-- resultados, solo que peores.
CREATE OR REPLACE FUNCTION ev2_norm(value text) RETURNS text AS $$
  SELECT regexp_replace(
           lower(btrim(translate(value,
             'áàäâéèëêíìïîóòöôúùüûñÁÀÄÂÉÈËÊÍÌÏÎÓÒÖÔÚÙÜÛÑ',
             'aaaaeeeeiiiioooouuuunAAAAEEEEIIIIOOOOUUUUN'))),
           '\s+', ' ', 'g')
$$ LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE;

-- El indice por parecido sobre el nombre del insumo. Sin el, cada renglon leido
-- recorreria el catalogo entero; con quince renglones y ochocientos insumos eso se
-- nota en la mano de quien esta esperando de pie.
CREATE INDEX IF NOT EXISTS supplies_name_trgm_idx
  ON supplies USING gin (ev2_norm(name) gin_trgm_ops);

CREATE TABLE IF NOT EXISTS receipt_photos (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nightclub_id   UUID NOT NULL REFERENCES nightclubs(id) ON DELETE CASCADE,
  -- Quien tomo la foto. No es adorno: si tres entregas de la misma semana traen
  -- fotos ilegibles de la misma persona, es un problema que se arregla ensenando,
  -- no revisando el inventario.
  uploaded_by    UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  supplier_id    UUID REFERENCES suppliers(id) ON DELETE SET NULL,

  -- Ruta RELATIVA dentro de RECEIPTS_DIR, no absoluta: mover el volumen no debe
  -- invalidar cada renglon de esta tabla.
  file_path      TEXT NOT NULL,
  mime_type      VARCHAR(60) NOT NULL,
  bytes          INTEGER NOT NULL CHECK (bytes > 0),
  -- SHA-256 del archivo. La misma foto subida dos veces es el caso comun --
  -- se cierra la app, se vuelve a abrir, se vuelve a subir -- y sin esto queda una
  -- entrega duplicada esperando a que alguien la capture dos veces.
  checksum       CHAR(64) NOT NULL,

  status         VARCHAR(12) NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'parsed', 'failed', 'used', 'discarded')),
  -- Por que fallo, en palabras. Un `failed` sin razon obliga a adivinar si fue la
  -- foto, el idioma o que el programa no esta instalado.
  error          TEXT,
  -- Lo que se leyo, crudo y como se leyo: texto completo, renglones detectados y
  -- los insumos que se les parecen. Nunca es la verdad, es una propuesta.
  parsed         JSONB,
  -- Cuando la entrada se guardo de verdad, este es el lote que salio de esta foto.
  receipt_group  UUID,

  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  parsed_at      TIMESTAMPTZ,
  used_at        TIMESTAMPTZ,

  -- Un `failed` tiene que decir por que, y un `parsed` tiene que traer algo leido.
  -- Sin esto la tabla acepta estados que no significan nada.
  CONSTRAINT receipt_photos_failed_says_why
    CHECK (status <> 'failed' OR error IS NOT NULL),
  -- `parsed` significa "se leyo algo": sin contenido no significa nada. `used` NO lo
  -- exige a proposito -- una foto que el OCR no pudo leer se captura a mano igual, y
  -- esa entrada es tan valida como cualquiera.
  CONSTRAINT receipt_photos_parsed_has_content
    CHECK (status <> 'parsed' OR parsed IS NOT NULL),
  CONSTRAINT receipt_photos_used_has_group
    CHECK (status <> 'used' OR (receipt_group IS NOT NULL AND used_at IS NOT NULL))
);

-- La misma foto no se sube dos veces al mismo club. Se compara por contenido, no
-- por nombre de archivo: el telefono la llama IMG_0042.jpg las dos veces.
CREATE UNIQUE INDEX IF NOT EXISTS receipt_photos_checksum_unique
  ON receipt_photos (nightclub_id, checksum);
-- La cola de quien captura: lo pendiente primero, lo mas reciente arriba.
CREATE INDEX IF NOT EXISTS receipt_photos_pending_idx
  ON receipt_photos (nightclub_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS receipt_photos_group_idx
  ON receipt_photos (receipt_group) WHERE receipt_group IS NOT NULL;

-- La foto es el comprobante: si se pudiera borrar, la palabra "comprobante" no
-- significaria nada. Se marca `discarded` y se queda. Lo que SI se puede cambiar es
-- el resultado del reconocimiento -- se vuelve a leer con mejores reglas -- asi que
-- el UPDATE no se bloquea; solo el DELETE.
DROP TRIGGER IF EXISTS receipt_photos_no_delete ON receipt_photos;
CREATE TRIGGER receipt_photos_no_delete
  BEFORE DELETE ON receipt_photos
  FOR EACH ROW EXECUTE FUNCTION forbid_delete();

COMMIT;
