// Domain events. For now they are persisted to the `events` table so clients can
// catch up via GET /events/since/:id. Redis pub/sub fan-out is added in step 3.2.
'use strict';

const { pool } = require('../db/pool');

/**
 * @param {object} opts
 * @param {string} opts.nightclubId
 * @param {string} opts.type       e.g. 'order_created'
 * @param {object} [opts.audience] { roles?: string[], userIds?: string[], tableIds?: string[] }
 * @param {object} [opts.payload]
 * @param {object} [opts.client]   optional pg client to publish inside a transaction
 */
async function publish({ nightclubId, type, audience = {}, payload = {}, client }) {
  const runner = client || pool;
  const { rows } = await runner.query(
    `INSERT INTO events (nightclub_id, type, audience, payload) VALUES ($1,$2,$3,$4) RETURNING id, created_at`,
    [nightclubId, type, JSON.stringify(audience), JSON.stringify(payload)],
  );
  return rows[0];
}

async function since({ nightclubId, sinceId, limit = 200 }) {
  const { rows } = await pool.query(
    `SELECT id, type, audience, payload, created_at
       FROM events
      WHERE nightclub_id = $1 AND id > $2 AND created_at > now() - interval '24 hours'
      ORDER BY id ASC LIMIT $3`,
    [nightclubId, sinceId, limit],
  );
  return rows;
}

/**
 * ¿Este evento es para esta persona?
 *
 * ---------------------------------------------------------------------------
 * Un evento sin audiencia no le llega a NADIE (D65)
 * ---------------------------------------------------------------------------
 * Antes era al revés: sin audiencia, el evento era para todos. Suena inofensivo hasta
 * que alguien olvida el campo — y alguien lo olvidó. Los tres `publish` de
 * `table_updated` iban sin audiencia, así que cada vez que una persona se sentaba, el
 * identificador de esa persona y su mesa le llegaban en vivo a cualquier cliente con
 * el socket abierto. De unos sesenta `publish` del sistema, esos tres eran los únicos
 * sin audiencia: el olvido, no la regla.
 *
 * Fallar cerrado cambia la consecuencia de ese olvido. Antes, olvidarlo publicaba
 * datos de más y nadie lo notaba. Ahora, olvidarlo hace que el aviso no llegue — que
 * SÍ se nota, porque una pantalla deja de actualizarse sola, y se arregla el mismo
 * día en vez de quedarse filtrando durante meses.
 *
 * Y para que ni siquiera llegue a producción, `tests/events-audience.test.js` recorre
 * el repositorio y exige que cada llamada a `publish()` lleve su audiencia. El
 * desarrollo falla ruidosamente; la producción falla en silencio pero del lado seguro.
 */
function matchesAudience(audience, user) {
  if (!audience || Object.keys(audience).length === 0) return false;
  if (Array.isArray(audience.userIds) && audience.userIds.includes(user.id)) return true;
  if (Array.isArray(audience.roles) && audience.roles.includes(user.role)) return true;
  return false;
}

module.exports = { publish, since, matchesAudience };
