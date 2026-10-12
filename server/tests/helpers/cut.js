// El corte a ciegas (D105) en las pruebas.
//
// Quien maneja efectivo ya no ve lo esperado en `GET /shifts/me/cut`. Las pruebas que
// verifican los NÚMEROS del corte (lo cobrado, lo que toca entregar) los leen como los
// lee el gerente: del resumen completo del servicio. Y el corte de esos puestos se
// hace en dos pasos: primero se guarda lo contado, luego el gerente cierra.
'use strict';

const { pool } = require('../../src/db/pool');
const cuts = require('../../src/services/shift-closings');
const { api, auth } = require('./api');

/** El corte completo del turno abierto de esa persona, como lo ve el gerente. */
async function fullCut(nightclubId, user) {
  const { rows } = await pool.query(
    `SELECT * FROM staff_shifts WHERE user_id = $1 AND nightclub_id = $2
      ORDER BY started_at DESC LIMIT 1`, [user.id, nightclubId]);
  if (!rows[0]) return { shift: null };
  return cuts.shiftSummary(pool, { nightclubId, shift: rows[0] });
}

/** Guarda el conteo a ciegas. */
const declare = (nightclubId, user, declaredCash, declaredUsd) => api()
  .post(`/api/nightclubs/${nightclubId}/shifts/me/declaration`).set(auth(user))
  .send({ declared_cash: declaredCash, ...(declaredUsd !== undefined ? { declared_usd: declaredUsd } : {}) });

/**
 * El corte en sus dos pasos: lo declarado (si el puesto cuenta a ciegas y aún no lo
 * guardó) y el cierre con el código del gerente.
 */
async function declareAndClose(nightclubId, user, body) {
  if (cuts.isBlind(user.role) && body.declared_cash !== undefined) {
    await declare(nightclubId, user, body.declared_cash, body.counted_usd);
  }
  return api().post(`/api/nightclubs/${nightclubId}/shifts/me/closing`).set(auth(user)).send(body);
}

module.exports = { fullCut, declare, declareAndClose };
