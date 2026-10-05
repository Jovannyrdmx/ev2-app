/**
 * Sustituir un insumo que se acabó en una barra (D84).
 *
 * "No hay Buchanan's 12 arriba: usa Black Label". El gerente o el bartender lo dice
 * una vez, y mientras dure, todos los tragos de esa barra que llevan el insumo agotado
 * descuentan el sustituto en la misma cantidad y al mismo precio. La comanda lo dice
 * para que se sirva el correcto; el cliente ve su trago de siempre.
 *
 * Termina sola de dos formas: al acabar la noche, o cuando vuelve a alcanzar el
 * original (la primera venta que encuentra existencia suficiente la cierra como
 * `restocked`). También se quita a mano.
 */
'use strict';

const { ApiError } = require('../middleware/errors');

/** Si no hay una noche en curso, la sustitución dura esto. */
const FALLBACK_HOURS = 12;

const SELECT = `
  SELECT x.id::text AS id, x.location_id::text AS location_id, l.name AS location_name,
         x.supply_id::text AS supply_id, s.name AS supply_name, s.unit,
         x.substitute_id::text AS substitute_id, t.name AS substitute_name,
         x.note, x.created_at, x.expires_at, x.ended_at, x.ended_reason,
         cu.display_name AS created_by_name, eu.display_name AS ended_by_name,
         COALESCE(so.stock, 0)::float8 AS supply_stock,
         COALESCE(st.stock, 0)::float8 AS substitute_stock
    FROM supply_substitutions x
    JOIN supply_locations l ON l.id = x.location_id
    JOIN supplies s ON s.id = x.supply_id
    JOIN supplies t ON t.id = x.substitute_id
    JOIN users cu ON cu.id = x.created_by
    LEFT JOIN users eu ON eu.id = x.ended_by
    LEFT JOIN supply_stock so ON so.supply_id = x.supply_id AND so.location_id = x.location_id
    LEFT JOIN supply_stock st ON st.supply_id = x.substitute_id AND st.location_id = x.location_id`;

/** Cuándo termina la noche en curso; sin noche, dentro de FALLBACK_HOURS. */
async function nightEndsAt(runner, { nightclubId, now = new Date() }) {
  const { rows } = await runner.query(
    `SELECT COALESCE(closes_at, doors_open_at + interval '8 hours') AS ends
       FROM events_calendar
      WHERE nightclub_id = $1 AND status = 'published'
        AND doors_open_at <= $2
        AND COALESCE(closes_at, doors_open_at + interval '8 hours') > $2
      ORDER BY doors_open_at DESC LIMIT 1`,
    [nightclubId, now]);
  if (rows[0]) return new Date(rows[0].ends);
  return new Date(now.getTime() + FALLBACK_HOURS * 3_600_000);
}

/** Cierra las que ya vencieron, para que la lista y las ventas no las vean vivas. */
async function expireOld(runner, { nightclubId }) {
  await runner.query(
    `UPDATE supply_substitutions SET ended_at = now(), ended_reason = 'expired'
      WHERE nightclub_id = $1 AND ended_at IS NULL AND expires_at <= now()`,
    [nightclubId]);
}

async function list(runner, { nightclubId, locationId = null, activeOnly = true }) {
  await expireOld(runner, { nightclubId });
  const { rows } = await runner.query(
    `${SELECT}
      WHERE x.nightclub_id = $1
        AND ($2::uuid IS NULL OR x.location_id = $2::uuid)
        AND ($3::boolean IS FALSE OR x.ended_at IS NULL)
      ORDER BY x.ended_at IS NULL DESC, x.created_at DESC
      LIMIT 100`,
    [nightclubId, locationId, activeOnly]);
  return rows;
}

async function get(runner, { nightclubId, id }) {
  const { rows } = await runner.query(`${SELECT} WHERE x.id = $1 AND x.nightclub_id = $2`,
    [id, nightclubId]);
  return rows[0] || null;
}

/**
 * Activar una sustitución. Se valida lo que haría que la barra sirviera algo que no
 * corresponde: una barra que no es barra, un insumo de otro club, unidades distintas
 * (30 ml de whisky no son 30 piezas de nada) o un sustituto que tampoco hay.
 */
async function create(client, { nightclubId, locationId, supplyId, substituteId, note, userId }) {
  if (supplyId === substituteId) {
    throw ApiError.unprocessable('El sustituto tiene que ser otro insumo');
  }
  const loc = await client.query(
    'SELECT kind FROM supply_locations WHERE id = $1 AND nightclub_id = $2', [locationId, nightclubId]);
  if (!loc.rows[0]) throw ApiError.badRequest('Esa barra no existe');
  if (loc.rows[0].kind !== 'bar') throw ApiError.unprocessable('Las sustituciones son por barra');

  const { rows } = await client.query(
    `SELECT s.id::text AS id, s.name, s.unit, s.active, COALESCE(ss.stock, 0)::float8 AS stock
       FROM supplies s
       LEFT JOIN supply_stock ss ON ss.supply_id = s.id AND ss.location_id = $3
      WHERE s.nightclub_id = $1 AND s.id = ANY($2::uuid[])`,
    [nightclubId, [supplyId, substituteId], locationId]);
  const original = rows.find((r) => r.id === supplyId);
  const sustituto = rows.find((r) => r.id === substituteId);
  if (!original || !sustituto) throw ApiError.badRequest('Ese insumo no existe');
  if (original.unit !== sustituto.unit) {
    throw ApiError.unprocessable(`No se puede: ${original.name} se mide en ${original.unit} `
      + `y ${sustituto.name} en ${sustituto.unit}. El sustituto se descuenta en la misma cantidad.`);
  }
  if (!sustituto.active) throw ApiError.unprocessable(`${sustituto.name} está dado de baja`);
  if (!(sustituto.stock > 0)) {
    throw ApiError.unprocessable(`Tampoco hay ${sustituto.name} en esta barra`);
  }

  await expireOld(client, { nightclubId });
  const expiresAt = await nightEndsAt(client, { nightclubId });
  try {
    const ins = await client.query(
      `INSERT INTO supply_substitutions
         (nightclub_id, location_id, supply_id, substitute_id, note, created_by, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [nightclubId, locationId, supplyId, substituteId, note || null, userId, expiresAt]);
    return get(client, { nightclubId, id: ins.rows[0].id });
  } catch (err) {
    if (err.code === '23505') {
      throw ApiError.conflict(`${original.name} ya tiene un sustituto en esta barra. `
        + 'Termínalo antes de poner otro.');
    }
    throw err;
  }
}

async function end(client, { nightclubId, id, userId, reason = 'manual' }) {
  const { rowCount } = await client.query(
    `UPDATE supply_substitutions SET ended_at = now(), ended_by = $3, ended_reason = $4
      WHERE id = $1 AND nightclub_id = $2 AND ended_at IS NULL`,
    [id, nightclubId, userId, reason]);
  if (rowCount === 0) {
    const ya = await get(client, { nightclubId, id });
    if (!ya) throw ApiError.notFound('Esa sustitución no existe');
    throw ApiError.conflict('Esa sustitución ya había terminado');
  }
  return get(client, { nightclubId, id });
}

/** Las vivas de una barra para unos insumos, por insumo original. Para `consume`. */
async function liveFor(client, { nightclubId, locationId, supplyIds }) {
  if (!supplyIds.length) return new Map();
  const { rows } = await client.query(
    `SELECT x.id::text AS id, x.supply_id::text AS supply_id, x.substitute_id::text AS substitute_id,
            s.name AS supply_name, t.name AS substitute_name, t.unit, t.active
       FROM supply_substitutions x
       JOIN supplies s ON s.id = x.supply_id
       JOIN supplies t ON t.id = x.substitute_id
      WHERE x.nightclub_id = $1 AND x.location_id = $2 AND x.supply_id = ANY($3::uuid[])
        AND x.ended_at IS NULL AND x.expires_at > now()`,
    [nightclubId, locationId, supplyIds]);
  return new Map(rows.map((r) => [r.supply_id, r]));
}

module.exports = {
  FALLBACK_HOURS, nightEndsAt, expireOld, list, get, create, end, liveFor,
};
