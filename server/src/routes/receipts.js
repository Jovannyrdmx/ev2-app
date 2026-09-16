// Fotos de tickets y facturas: el comprobante de una entrada, y de paso los renglones
// pre-llenados (docs/DECISIONES.md D45).
//
// Las dos cosas que pasan aquí, en este orden y nunca al revés:
//
//   1. La foto se GUARDA. Vale por sí sola: es lo que después contesta "este tequila
//      lo pagamos a 900 o a 1,100" y lo que permite reclamarle al proveedor.
//   2. Se INTENTA leer. Si Tesseract truena, la foto ya está adentro, el renglón
//      queda `failed` con la razón escrita, y la captura sigue a mano.
//
// Nada de lo que se lee mueve el inventario. La entrada se sigue guardando por
// `POST /supply-receipts`, con una persona que revisó renglón por renglón; esta
// pantalla solo le ahorra teclear. Un ticket térmico mal impreso confunde un 8 con un
// 3, y un inventario que se llena solo con eso miente con más confianza que uno vacío.
'use strict';

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');

const { pool } = require('../db/pool');
const { ApiError, asyncHandler } = require('../middleware/errors');
const { validate, z, uuid, pagination } = require('../middleware/validate');
const { authenticate, requireRole, sameNightclub } = require('../middleware/auth');
const ocr = require('../services/receipt-ocr');

const router = express.Router({ mergeParams: true });

/**
 * Dónde viven las fotos.
 *
 * Fuera de la base a propósito: un club que recibe tres veces por semana junta
 * cientos de fotos de dos megas, y metidas en Postgres hacen que cada respaldo tarde
 * el triple y que restaurar la base de un viernes por la noche sea imposible.
 */
const receiptsDir = () => process.env.RECEIPTS_DIR
  || path.join(process.cwd(), 'var', 'receipts');

/**
 * La imagen llega a memoria, no a un archivo temporal.
 *
 * Doce megas en RAM por subida es aceptable y se escribe una sola vez, en su lugar
 * definitivo, cuando ya se sabe su checksum. Con archivo temporal quedarían restos en
 * disco cada vez que una subida falla a medias, y nadie los limpia nunca.
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: ocr.MAX_BYTES, files: 1 },
});

/** Convierte los errores de multer en los del resto de la API. */
function receivePhoto(req, res, next) {
  upload.single('photo')(req, res, (err) => {
    if (!err) { next(); return; }
    if (err.code === 'LIMIT_FILE_SIZE') {
      next(ApiError.unprocessable(
        `La imagen pesa más de ${Math.round(ocr.MAX_BYTES / (1024 * 1024))} MB`));
      return;
    }
    if (err.code === 'LIMIT_UNEXPECTED_FILE') {
      next(ApiError.unprocessable('Manda una sola imagen, en el campo "photo"'));
      return;
    }
    next(err);
  });
}

// Quién entra al almacén. Hoy no hay rol de almacenista en el club: el gerente hace
// ese trabajo, y el administrador también entra (decisión del dueño). El rol
// `warehouse` se deja porque el esquema lo permite y mañana puede haber uno.
const WAREHOUSE = ['warehouse', 'manager', 'admin'];

const PHOTO_SELECT = `
  SELECT p.id, p.status, p.mime_type, p.bytes, p.checksum, p.error, p.parsed,
         p.receipt_group, p.created_at, p.parsed_at, p.used_at,
         p.supplier_id, sp.name AS supplier_name,
         p.uploaded_by, u.display_name AS uploaded_by_name
    FROM receipt_photos p
    JOIN users u ON u.id = p.uploaded_by
    LEFT JOIN suppliers sp ON sp.id = p.supplier_id`;

/**
 * La fila como la ve la pantalla. `file_path` NO sale nunca.
 *
 * Es una ruta del disco del servidor: publicarla no le sirve al navegador —no puede
 * abrirla— y sí le sirve a quien esté buscando por dónde entrar. La imagen se pide
 * por su propia ruta, `/receipt-photos/:id/image`, que comprueba el club.
 */
const present = (row) => ({ ...row, bytes: Number(row.bytes) });

router.use('/nightclubs/:nightclubId', authenticate, sameNightclub());

/**
 * Sube la foto y devuelve lo que se pudo leer.
 *
 * El `201` sale igual cuando el reconocimiento falla: la foto SÍ se guardó, y eso es
 * lo que se creó. El `status` dice qué pasó con la lectura, y la pantalla sabe abrir
 * la captura vacía en ese caso en vez de dejar al usuario sin salida.
 */
router.post('/nightclubs/:nightclubId/receipt-photos',
  requireRole(...WAREHOUSE),
  receivePhoto,
  validate({
    params: z.object({ nightclubId: uuid }),
    body: z.object({ supplier_id: uuid.optional() }),
  }),
  asyncHandler(async (req, res) => {
    const { nightclubId } = req.params;
    ocr.checkUpload(req.file);

    const checksum = ocr.checksumOf(req.file.buffer);
    // La misma foto subida dos veces es el caso común —se cierra la app, se vuelve a
    // abrir, se vuelve a subir— y sin esto queda una entrega duplicada esperando a
    // que alguien la capture dos veces. Se devuelve la de antes, con lo que ya leyó.
    const previa = await pool.query(
      `${PHOTO_SELECT} WHERE p.nightclub_id = $1 AND p.checksum = $2`,
      [nightclubId, checksum]);
    if (previa.rowCount > 0) {
      res.status(200).json({ photo: present(previa.rows[0]), already_uploaded: true });
      return;
    }

    const stored = await ocr.storeImage({
      baseDir: receiptsDir(), nightclubId, file: req.file, now: new Date(),
    });

    const creada = await pool.query(
      `INSERT INTO receipt_photos (nightclub_id, uploaded_by, supplier_id,
                                   file_path, mime_type, bytes, checksum)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [nightclubId, req.user.id, req.body.supplier_id || null,
        stored.relative, req.file.mimetype, stored.bytes, stored.checksum]);
    const photoId = creada.rows[0].id;

    await readAndSave({ nightclubId, photoId, absolute: stored.absolute, log: req.log });

    const { rows } = await pool.query(`${PHOTO_SELECT} WHERE p.id = $1`, [photoId]);
    res.status(201).json({ photo: present(rows[0]) });
  }));

/**
 * Lee la imagen y guarda el resultado, pase lo que pase.
 *
 * Que el reconocimiento falle no puede tirar la subida: la foto ya está en disco y en
 * la base, y es el comprobante. Lo que se guarda es POR QUÉ falló, porque un `failed`
 * sin razón obliga a adivinar si fue la foto, el idioma o el programa que no está
 * instalado.
 */
async function readAndSave({ nightclubId, photoId, absolute, log = null }) {
  const client = await pool.connect();
  try {
    const parsed = await ocr.readReceipt(client, { nightclubId, imagePath: absolute });
    await client.query(
      `UPDATE receipt_photos
          SET status = CASE WHEN jsonb_array_length($2::jsonb -> 'lines') > 0
                            THEN 'parsed' ELSE 'failed' END,
              parsed = $2::jsonb,
              error = CASE WHEN jsonb_array_length($2::jsonb -> 'lines') > 0
                           THEN NULL ELSE $3::text END,
              parsed_at = now()
        WHERE id = $1`,
      [photoId, JSON.stringify(parsed),
        'No se reconoció ningún renglón de mercancía en la foto']);
  } catch (err) {
    log?.warn({ err, photoId }, 'receipt ocr failed');
    await client.query(
      `UPDATE receipt_photos SET status = 'failed', error = $2, parsed_at = now() WHERE id = $1`,
      [photoId, String(err.message || err).slice(0, 500)]).catch(() => {});
  } finally {
    client.release();
  }
}

/** La cola de quien captura: lo pendiente primero, lo más reciente arriba. */
router.get('/nightclubs/:nightclubId/receipt-photos',
  requireRole(...WAREHOUSE),
  validate({
    params: z.object({ nightclubId: uuid }),
    query: pagination.extend({
      status: z.enum(['pending', 'parsed', 'failed', 'used', 'discarded']).optional(),
      // Por omisión se esconden las ya capturadas y las descartadas: lo que importa
      // es lo que falta por capturar, que es justo la mercancía que entró sin
      // registrar si nadie la atiende.
      include_done: z.coerce.boolean().default(false),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(
      `${PHOTO_SELECT}
        WHERE p.nightclub_id = $1
          AND ($2::text IS NULL OR p.status = $2::text)
          AND ($3::boolean OR p.status NOT IN ('used', 'discarded'))
        ORDER BY p.created_at DESC
        LIMIT $4 OFFSET $5`,
      [req.params.nightclubId, req.query.status || null, req.query.include_done,
        req.query.limit, req.query.offset]);
    res.json({ photos: rows.map(present) });
  }));

/** Una foto por su id, con lo que se leyó. */
router.get('/nightclubs/:nightclubId/receipt-photos/:photoId',
  requireRole(...WAREHOUSE),
  validate({ params: z.object({ nightclubId: uuid, photoId: uuid }) }),
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(
      `${PHOTO_SELECT} WHERE p.id = $1 AND p.nightclub_id = $2`,
      [req.params.photoId, req.params.nightclubId]);
    if (rows.length === 0) throw ApiError.notFound('Esa foto no existe');
    res.json({ photo: present(rows[0]) });
  }));

/**
 * La imagen misma. Hace falta: quien revisa los renglones tiene que poder ver el
 * papel, y sin esto tendría que confiar en lo que leyó el programa.
 *
 * Va por la API y no por un archivo servido directo, para que pase por el token y por
 * la comprobación de club: una foto de una factura tiene el RFC del club, el nombre
 * del proveedor y los precios de compra.
 */
router.get('/nightclubs/:nightclubId/receipt-photos/:photoId/image',
  requireRole(...WAREHOUSE),
  validate({ params: z.object({ nightclubId: uuid, photoId: uuid }) }),
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(
      'SELECT file_path, mime_type FROM receipt_photos WHERE id = $1 AND nightclub_id = $2',
      [req.params.photoId, req.params.nightclubId]);
    if (rows.length === 0) throw ApiError.notFound('Esa foto no existe');

    // La ruta viene de la base, pero se comprueba igual: un `..` guardado por un
    // error de hace seis meses no debe poder leer /etc/passwd hoy.
    const base = path.resolve(receiptsDir());
    const absolute = path.resolve(base, rows[0].file_path);
    if (!absolute.startsWith(base + path.sep)) {
      throw ApiError.notFound('Esa foto no existe');
    }
    if (!fs.existsSync(absolute)) {
      throw ApiError.notFound('El archivo de esa foto ya no está en el servidor');
    }
    res.type(rows[0].mime_type);
    // Privada: es una factura con el RFC del club y los precios de compra. Ninguna
    // capa intermedia debe guardarse una copia.
    res.setHeader('Cache-Control', 'private, max-age=300');
    fs.createReadStream(absolute).pipe(res);
  }));

/**
 * Vuelve a leer una foto que ya está adentro.
 *
 * Es para el caso real: se sube el ticket, se descubre que tres insumos no estaban en
 * el catálogo, se dan de alta, y ahora el parecido sí los encuentra. Sin esto habría
 * que volver a fotografiar el papel, que a esa hora ya no está.
 */
router.post('/nightclubs/:nightclubId/receipt-photos/:photoId/reparse',
  requireRole(...WAREHOUSE),
  validate({ params: z.object({ nightclubId: uuid, photoId: uuid }) }),
  asyncHandler(async (req, res) => {
    const { nightclubId, photoId } = req.params;
    const { rows } = await pool.query(
      `SELECT file_path, status FROM receipt_photos WHERE id = $1 AND nightclub_id = $2`,
      [photoId, nightclubId]);
    if (rows.length === 0) throw ApiError.notFound('Esa foto no existe');
    if (rows[0].status === 'used') {
      throw ApiError.conflict('Esa foto ya se capturó; volver a leerla no cambiaría la entrada');
    }
    const absolute = path.resolve(receiptsDir(), rows[0].file_path);
    if (!fs.existsSync(absolute)) {
      throw ApiError.notFound('El archivo de esa foto ya no está en el servidor');
    }
    await readAndSave({ nightclubId, photoId, absolute, log: req.log });
    const full = await pool.query(`${PHOTO_SELECT} WHERE p.id = $1`, [photoId]);
    res.json({ photo: present(full.rows[0]) });
  }));

/**
 * Descarta una foto sin capturarla: salió borrosa, o es de una entrega que se devolvió.
 *
 * No se borra. La foto es el comprobante, y un comprobante que se puede borrar no es
 * comprobante: se marca y se queda, con quién la descartó en el registro.
 */
router.post('/nightclubs/:nightclubId/receipt-photos/:photoId/discard',
  requireRole(...WAREHOUSE),
  validate({
    params: z.object({ nightclubId: uuid, photoId: uuid }),
    body: z.object({ reason: z.string().trim().min(3).max(200) }),
  }),
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(
      `UPDATE receipt_photos
          SET status = 'discarded', error = $3
        WHERE id = $1 AND nightclub_id = $2 AND status <> 'used'
        RETURNING id`,
      [req.params.photoId, req.params.nightclubId, req.body.reason]);
    if (rows.length === 0) {
      throw ApiError.notFound('Esa foto no existe, o ya se capturó');
    }
    const full = await pool.query(`${PHOTO_SELECT} WHERE p.id = $1`, [rows[0].id]);
    res.json({ photo: present(full.rows[0]) });
  }));

/**
 * Marca la foto como capturada y la amarra al lote que salió de ella.
 *
 * Lo llama la ruta de `supply-receipts` cuando la captura trae `photo_id`. Vive aquí
 * para que la regla —una foto se usa UNA vez— esté junto a la tabla que la guarda.
 */
async function markUsed(client, { nightclubId, photoId, receiptGroup }) {
  const { rows } = await client.query(
    `UPDATE receipt_photos
        SET status = 'used', receipt_group = $3, used_at = now()
      WHERE id = $1 AND nightclub_id = $2 AND status IN ('pending', 'parsed', 'failed')
      RETURNING id`,
    [photoId, nightclubId, receiptGroup]);
  if (rows.length === 0) {
    // Dentro de la transacción de la captura: si la foto ya se usó, la entrada NO se
    // guarda. Es la protección contra el doble toque en un teléfono lento, que de
    // otro modo mete la misma entrega dos veces al inventario.
    throw ApiError.conflict('Esa foto ya se capturó o se descartó');
  }
}

/** Los archivos viejos de un club, para el respaldo. No expuesto por HTTP. */
async function photoFile({ nightclubId, photoId }) {
  const { rows } = await pool.query(
    'SELECT file_path FROM receipt_photos WHERE id = $1 AND nightclub_id = $2',
    [photoId, nightclubId]);
  if (rows.length === 0) return null;
  const absolute = path.resolve(receiptsDir(), rows[0].file_path);
  return fsp.access(absolute).then(() => absolute, () => null);
}

module.exports = router;
module.exports.markUsed = markUsed;
module.exports.photoFile = photoFile;
module.exports.receiptsDir = receiptsDir;
