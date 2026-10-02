'use strict';
const { ApiError } = require('../middleware/errors');
const events = require('./events');

async function lock(client, nightclubId) {
  const result = await client.query('SELECT settings FROM nightclubs WHERE id=$1 FOR UPDATE', [nightclubId]);
  if (!result.rowCount) throw ApiError.notFound('El lugar no existe.');
  return result.rows[0].settings?.floor_plan || {};
}

async function bump(client, nightclubId) {
  const result = await client.query(
    `UPDATE nightclubs SET settings=jsonb_set(COALESCE(settings,'{}'::jsonb),'{floor_plan}',
       COALESCE(settings->'floor_plan','{}'::jsonb) ||
       jsonb_build_object('revision',COALESCE((settings#>>'{floor_plan,revision}')::int,0)+1),true)
     WHERE id=$1 RETURNING (settings#>>'{floor_plan,revision}')::int AS revision`, [nightclubId]);
  const revision = result.rows[0].revision;
  await events.publish({
    client, nightclubId, type: 'floor_plan_updated',
    audience: { roles: ['guest', 'admin', 'manager', 'waiter', 'bartender', 'hostess'] },
    payload: { revision },
  });
  return revision;
}

function checkPosition(item, width, height, extents) {
  if (item.x < extents.left || item.y < extents.top
    || item.x + extents.right > width || item.y + extents.bottom > height) {
    throw ApiError.unprocessable('El elemento debe quedar dentro del plano.');
  }
}

async function save(pool, nightclubId, body) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const plan = await lock(client, nightclubId);
    if (Number(plan.revision || 0) !== body.revision) {
      throw ApiError.conflict('Otra sesión modificó el plano. Recarga antes de guardar; tus cambios no se sobrescribieron.');
    }
    const width = Number(plan.canvas?.width || 800);
    const height = Number(plan.canvas?.height || 580);
    for (const [kind, key, rows] of [['tables', 'id', body.tables], ['venue_landmarks', 'code', body.landmarks]]) {
      if (new Set(rows.map((r) => r[key])).size !== rows.length) {
        throw ApiError.badRequest('La solicitud repite un elemento.');
      }
      for (const item of rows) {
        // Identifiers below are constants, never client-supplied SQL identifiers.
        const found = await client.query(
          `SELECT * FROM ${kind} WHERE ${key}=$1 AND nightclub_id=$2 AND active FOR UPDATE`,
          [item[key], nightclubId]);
        if (!found.rowCount) throw ApiError.notFound('Un elemento ya no pertenece a este plano.');
        const row = found.rows[0];
        const radius = Number(row.radius || 24);
        checkPosition(item, width, height, kind === 'tables'
          ? { left: radius, right: radius, top: radius, bottom: radius }
          : { left: 0, top: 0, right: Number(row.width || 0), bottom: Number(row.height || 0) });
        await client.query(`UPDATE ${kind} SET x=$1,y=$2 WHERE ${key}=$3 AND nightclub_id=$4`,
          [item.x, item.y, item[key], nightclubId]);
      }
    }
    const revision = await bump(client, nightclubId);
    // Existing staff screens listen to this established event name.
    await events.publish({
      client, nightclubId, type: 'table_updated',
      audience: { roles: ['admin', 'manager', 'waiter', 'bartender', 'hostess'] },
      payload: { action: 'layout_changed', count: body.tables.length, revision },
    });
    await client.query('COMMIT');
    return { revision, updated: body.tables.length + body.landmarks.length };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally { client.release(); }
}
module.exports = { lock, bump, save, checkPosition };
