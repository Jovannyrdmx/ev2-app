/**
 * EV2 — objetos perdidos y encontrados (D67).
 *
 * ---------------------------------------------------------------------------
 * Todo este archivo gira alrededor de una sola regla
 * ---------------------------------------------------------------------------
 * **Las señas de un objeto no salen hacia un cliente que no las escribió.**
 *
 * Si la aplicación enseñara "iPhone 15 negro con funda roja y una calcomanía de un
 * gato", cualquiera puede leerlo y presentarse a reclamarlo describiéndolo. La única
 * prueba de que algo es tuyo es que puedas describir lo que nadie más vio.
 *
 * Por eso hay dos formas de leer un objeto, y es lo primero que hay aquí abajo:
 * `publicView` (lo que ve un cliente del catálogo: categoría, zona y día) y
 * `staffView` (todo, para quien tiene que emparejar). Están juntas a propósito: el día
 * que alguien agregue un campo nuevo, va a ver las dos y va a tener que decidir en
 * cuál va.
 */
'use strict';

const crypto = require('crypto');
const { ApiError } = require('../middleware/errors');

/**
 * Las categorías, cerradas a propósito.
 *
 * Un campo libre acabaría con el modelo del teléfono escrito adentro —"iPhone 15 Pro
 * morado"— y eso es exactamente lo que no debe ser público. Ocho cajones alcanzan
 * para que alguien reconozca lo suyo en una lista y no alcanzan para inventárselo.
 */
const CATEGORIES = ['phone', 'wallet', 'keys', 'bag', 'clothing', 'jewelry', 'document', 'other'];

/** Un objeto entregado y uno cerrado ya no se emparejan con nada. */
const OPEN_STATES = ['open', 'matched'];

// ---------------------------------------------------------------- el código

/**
 * Sin I, L, O ni U: se leen en la pantalla de un teléfono a las cuatro de la mañana y
 * se teclean en otra. Es el mismo alfabeto de los códigos de emparejamiento de las PCs,
 * y por la misma razón.
 */
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_LENGTH = 6;

function newCode() {
  const bytes = crypto.randomBytes(CODE_LENGTH);
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i += 1) code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return code;
}

/** Como se teclea, no importa cómo: minúsculas, guiones y espacios se perdonan. */
const normalizeCode = (code) => String(code || '').toUpperCase().replace(/[^0-9A-Z]/g, '');

const hashCode = (code) => crypto.createHash('sha256').update(normalizeCode(code)).digest('hex');

// ---------------------------------------------------------------- las dos vistas

/**
 * Lo que ve un cliente del catálogo de lo encontrado.
 *
 * Categoría, zona y día. **Nada de `details`, nada de `storage_note`, nada de quién lo
 * entregó.** Con esto alguien puede decir "sí, creo que es mío" y levantar su reporte;
 * sin las señas, no puede describir lo que no vio.
 *
 * `id` sí viaja: hace falta para que el cliente diga cuál cree que es, y por sí solo
 * no dice nada de nadie.
 */
const publicView = (row) => ({
  id: row.id,
  category: row.category,
  place: row.place,
  happened_at: row.happened_at,
  // "Está en resguardo" es distinto de "alguien dijo que lo dejó": lo primero significa
  // que el club lo tiene en la mano.
  in_custody: Boolean(row.received_at),
});

/** Lo que ve quien tiene que emparejar y entregar: todo. */
const staffView = (row) => ({
  id: row.id,
  kind: row.kind,
  status: row.status,
  category: row.category,
  details: row.details,
  place: row.place,
  happened_at: row.happened_at,
  reported_by: row.reported_by,
  reporter_name: row.reporter_name,
  reporter_phone: row.reporter_phone,
  received_by: row.received_by,
  received_at: row.received_at,
  received_name: row.received_name,
  storage_note: row.storage_note,
  match_id: row.match_id,
  // El código NUNCA se devuelve, ni al personal: solo su huella y los últimos
  // caracteres. Quien entrega lo teclea de la pantalla del dueño, no lo lee de la suya
  // — si el personal pudiera verlo, el código no probaría nada.
  handover_hint: row.handover_hint,
  returned_at: row.returned_at,
  returned_by: row.returned_by,
  closed_reason: row.closed_reason,
  created_at: row.created_at,
});

/**
 * Lo que ve el dueño de su PROPIO reporte.
 *
 * Sus señas sí, porque las escribió él. Y el código de entrega, que es el único lugar
 * del sistema donde aparece en claro y solo mientras el objeto sigue sin entregarse.
 */
const ownerView = (row, code = null) => ({
  id: row.id,
  kind: row.kind,
  status: row.status,
  category: row.category,
  details: row.details,
  place: row.place,
  happened_at: row.happened_at,
  match_id: row.match_id,
  // Dónde recogerlo, cuando ya hay algo que recoger.
  storage_note: row.status === 'matched' ? row.matched_storage_note : null,
  handover_code: code,
  handover_hint: row.handover_hint,
  returned_at: row.returned_at,
  closed_reason: row.closed_reason,
  created_at: row.created_at,
});

const SELECT = `
  SELECT i.*, ru.display_name AS received_name,
         m.storage_note AS matched_storage_note
    FROM lost_items i
    LEFT JOIN users ru ON ru.id = i.received_by
    LEFT JOIN lost_items m ON m.id = i.match_id`;

// ---------------------------------------------------------------- escribir

/** Levanta un reporte: algo que se perdió, o algo que apareció. */
async function report(runner, {
  nightclubId, kind, category, details = null, place = null, happenedAt = null,
  reportedBy = null, reporterName = null, reporterPhone = null,
  receivedBy = null, storageNote = null,
}) {
  const { rows } = await runner.query(
    `INSERT INTO lost_items
       (nightclub_id, kind, category, details, place, happened_at,
        reported_by, reporter_name, reporter_phone,
        received_by, received_at, storage_note)
     VALUES ($1,$2::text,$3::text,$4,$5,COALESCE($6::timestamptz, now()),
             $7,$8,$9, $10, CASE WHEN $10::uuid IS NULL THEN NULL ELSE now() END, $11)
     RETURNING id`,
    [nightclubId, kind, category, details, place, happenedAt,
      reportedBy, reporterName, reporterPhone, receivedBy, storageNote]);
  const { rows: full } = await runner.query(`${SELECT} WHERE i.id = $1`, [rows[0].id]);
  return full[0];
}

/**
 * El club recibe físicamente algo que un cliente dijo haber dejado.
 *
 * Es un paso aparte y no un campo del alta porque **"alguien dijo que lo dejó" y "está
 * en la caja" son cosas distintas**, y el catálogo solo sirve si distingue las dos. Un
 * cliente que ve "en resguardo" y viene manejando media hora merece que eso sea cierto.
 */
async function receive(runner, { nightclubId, itemId, userId, storageNote = null }) {
  const { rows } = await runner.query(
    `UPDATE lost_items
        SET received_by = $3, received_at = now(),
            storage_note = COALESCE($4, storage_note), updated_at = now()
      WHERE id = $1 AND nightclub_id = $2 AND kind = 'found' AND status <> 'returned'
      RETURNING id`,
    [itemId, nightclubId, userId, storageNote]);
  if (rows.length === 0) return null;
  const { rows: full } = await runner.query(`${SELECT} WHERE i.id = $1`, [itemId]);
  return full[0];
}

/**
 * Empareja un reporte de pérdida con un objeto guardado, y emite el código de entrega.
 *
 * El código va en el renglón del DUEÑO porque es él quien tiene que enseñarlo, y sale
 * en claro exactamente una vez: aquí. Después solo queda su huella.
 *
 * Emparejar no entrega nada. Son dos actos y en ese orden a propósito: entre uno y otro
 * está el viaje de la persona al club, y el objeto sigue en la caja.
 */
async function match(client, { nightclubId, lostId, foundId }) {
  const { rows } = await client.query(
    `SELECT id, kind, status FROM lost_items
      WHERE id = ANY($1::uuid[]) AND nightclub_id = $2 FOR UPDATE`,
    [[lostId, foundId], nightclubId]);
  const perdido = rows.find((r) => r.id === lostId);
  const encontrado = rows.find((r) => r.id === foundId);
  if (!perdido || !encontrado) throw ApiError.notFound('Uno de los dos reportes no existe');
  if (perdido.kind !== 'lost' || encontrado.kind !== 'found') {
    throw ApiError.unprocessable('Se empareja un reporte de pérdida con un objeto encontrado');
  }
  for (const r of [perdido, encontrado]) {
    if (!OPEN_STATES.includes(r.status)) {
      throw ApiError.conflict(`Ese objeto ya está '${r.status}'`);
    }
  }

  const code = newCode();
  await client.query(
    `UPDATE lost_items
        SET match_id = $2, status = 'matched',
            handover_hash = $3, handover_hint = $4, updated_at = now()
      WHERE id = $1`,
    [lostId, foundId, hashCode(code), code.slice(-3)]);
  // El otro lado también queda emparejado, para que no se le ofrezca a nadie más.
  await client.query(
    `UPDATE lost_items SET match_id = $2, status = 'matched', updated_at = now()
      WHERE id = $1`,
    [foundId, lostId]);

  const { rows: full } = await client.query(`${SELECT} WHERE i.id = $1`, [lostId]);
  return { item: full[0], code };
}

/**
 * Se entrega el objeto. El código es lo que lo autoriza.
 *
 * Se compara contra la huella, nunca contra un texto guardado. Y se exige que el
 * objeto esté emparejado: entregar algo que nadie emparejó es entregarlo sin que nadie
 * haya comprobado que es de quien dice.
 */
async function handOver(client, { nightclubId, lostId, code, userId }) {
  const { rows } = await client.query(
    `SELECT id, status, handover_hash, match_id FROM lost_items
      WHERE id = $1 AND nightclub_id = $2 AND kind = 'lost' FOR UPDATE`,
    [lostId, nightclubId]);
  const item = rows[0];
  if (!item) throw ApiError.notFound('Ese reporte no existe');
  if (item.status === 'returned') throw ApiError.conflict('Ese objeto ya se entregó');
  if (item.status !== 'matched' || !item.handover_hash) {
    throw ApiError.unprocessable('Ese reporte todavía no está emparejado con nada');
  }
  // Un código equivocado dice justo eso y nada más. No hay nada que filtrar —quien
  // pregunta ya tiene el reporte enfrente— y quien se equivocó tecleando merece
  // saberlo en vez de ver "algo salió mal".
  if (hashCode(code) !== item.handover_hash) throw ApiError.forbidden('Ese código no es el de este objeto');

  await client.query(
    `UPDATE lost_items SET status = 'returned', returned_at = now(), returned_by = $2,
            updated_at = now()
      WHERE id = $1`,
    [lostId, userId]);
  if (item.match_id) {
    await client.query(
      `UPDATE lost_items SET status = 'returned', returned_at = now(), returned_by = $2,
              updated_at = now()
        WHERE id = $1 AND status <> 'returned'`,
      [item.match_id, userId]);
  }
  const { rows: full } = await client.query(`${SELECT} WHERE i.id = $1`, [lostId]);
  return full[0];
}

/** Se cierra sin entregar. El motivo es obligatorio: un "se cerró" solo no responde nada. */
async function close(runner, { nightclubId, itemId, reason }) {
  const { rows } = await runner.query(
    `UPDATE lost_items SET status = 'closed', closed_reason = $3, updated_at = now()
      WHERE id = $1 AND nightclub_id = $2 AND status <> 'returned'
      RETURNING id`,
    [itemId, nightclubId, reason]);
  if (rows.length === 0) return null;
  const { rows: full } = await runner.query(`${SELECT} WHERE i.id = $1`, [itemId]);
  return full[0];
}

// ---------------------------------------------------------------- leer

/** El catálogo que ve un cliente: solo lo encontrado, y solo lo que puede ver. */
async function publicCatalogue(runner, { nightclubId, category = null, days = 30 }) {
  const { rows } = await runner.query(
    `SELECT i.id, i.category, i.place, i.happened_at, i.received_at
       FROM lost_items i
      WHERE i.nightclub_id = $1 AND i.kind = 'found' AND i.status = 'open'
        AND i.happened_at > now() - ($3::int * interval '1 day')
        AND ($2::text IS NULL OR i.category = $2::text)
      ORDER BY i.happened_at DESC LIMIT 200`,
    [nightclubId, category, days]);
  return rows.map(publicView);
}

/** Los reportes de una persona, con sus propias señas y su código si ya lo hay. */
async function mine(runner, { nightclubId, userId }) {
  const { rows } = await runner.query(
    `${SELECT} WHERE i.nightclub_id = $1 AND i.reported_by = $2
      ORDER BY i.created_at DESC LIMIT 100`,
    [nightclubId, userId]);
  return rows.map((r) => ownerView(r));
}

/** Todo, para quien empareja. */
async function list(runner, { nightclubId, kind = null, status = null, category = null, limit = 100 }) {
  const { rows } = await runner.query(
    `${SELECT} WHERE i.nightclub_id = $1
        AND ($2::text IS NULL OR i.kind = $2::text)
        AND ($3::text IS NULL OR i.status = $3::text)
        AND ($4::text IS NULL OR i.category = $4::text)
      ORDER BY i.created_at DESC LIMIT $5::int`,
    [nightclubId, kind, status, category, limit]);
  return rows.map(staffView);
}

/** Un objeto por id, crudo. Quien llama decide con qué vista lo enseña. */
async function byId(runner, { nightclubId, itemId }) {
  const { rows } = await runner.query(
    `${SELECT} WHERE i.id = $1 AND i.nightclub_id = $2`, [itemId, nightclubId]);
  return rows[0] || null;
}

module.exports = {
  CATEGORIES, OPEN_STATES, CODE_LENGTH,
  newCode, normalizeCode, hashCode,
  publicView, staffView, ownerView,
  report, receive, match, handOver, close,
  publicCatalogue, mine, list, byId,
};
