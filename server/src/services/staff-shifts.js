/**
 * EV2 — abrir y cerrar el turno de una persona del piso (D20, D51, D94).
 *
 * Vive aquí, y no en la ruta, porque lo usan dos puertas: el botón del teléfono
 * (`routes/tips.js`) y el checador de huella (`routes/clock.js`). Las dos tienen que
 * aplicar EXACTAMENTE la misma regla —sobre todo la del corte—, y una regla copiada en
 * dos archivos es una regla que un día dice dos cosas distintas.
 */
'use strict';

const { pool } = require('../db/pool');
const { ApiError } = require('../middleware/errors');
const events = require('./events');
const shiftCuts = require('./shift-closings');

/**
 * Los roles que abren turno "normal" (sin caja). El cajero no está a propósito: su
 * turno nace al abrir la caja con el fondo (D51), no con un botón.
 */
const SHIFT_ROLES = ['waiter', 'bartender', 'dancer', 'dj', 'light_tech', 'valet', 'hostess'];

/** El turno abierto de esa persona, o null. */
async function openShift(userId, runner = pool) {
  const { rows } = await runner.query(
    'SELECT id, section, started_at FROM staff_shifts WHERE user_id = $1 AND ended_at IS NULL', [userId]);
  return rows[0] || null;
}

/**
 * Abre el turno. Si ya había uno, lo devuelve con `alreadyOpen` en vez de fallar:
 * marcar dos veces la entrada no es un error de quien la marca.
 */
async function start(runner, { nightclubId, user, section = null }) {
  const current = await openShift(user.id, runner);
  if (current) return { shift: current, alreadyOpen: true };
  const { rows } = await runner.query(
    `INSERT INTO staff_shifts (nightclub_id, user_id, section) VALUES ($1,$2,$3)
     RETURNING id, section, started_at`,
    [nightclubId, user.id, section || null]);
  await events.publish({
    nightclubId, type: 'shift_started',
    audience: { roles: ['manager', 'hostess'] },
    payload: { user_id: user.id, role: user.role, section: section || null },
    client: runner,
  });
  return { shift: rows[0], alreadyOpen: false };
}

/**
 * Cierra el turno abierto de esa persona.
 *
 * Quien cobró dinero no cierra su turno sin corte (D51, D54). Irse con el efectivo
 * del club en la bolsa y el turno cerrado es exactamente lo que el corte existe para
 * impedir. Desde D54 el corte se hace en un acto —el gerente cuenta y teclea su
 * código ahí mismo— y al cerrarlo el turno queda cerrado solo, así que quien llega
 * aquí con dinero cobrado es alguien que todavía no lo ha hecho.
 *
 * Errores: 409 si no hay turno abierto; 422 (`needsCut`) si falta el corte.
 */
async function end(runner, { nightclubId, userId }) {
  const abierto = await runner.query(
    `SELECT id, user_id, section, started_at, ended_at FROM staff_shifts
      WHERE user_id = $1 AND nightclub_id = $2 AND ended_at IS NULL`,
    [userId, nightclubId]);
  if (abierto.rowCount === 0) throw ApiError.conflict('No tienes un turno abierto');

  await assertCanClose(runner, { nightclubId, shift: abierto.rows[0] });

  const { rows } = await runner.query(
    `UPDATE staff_shifts SET ended_at = now() WHERE id = $1 AND ended_at IS NULL
     RETURNING id, section, started_at, ended_at`, [abierto.rows[0].id]);
  if (rows.length === 0) throw ApiError.conflict('No tienes un turno abierto');
  return rows[0];
}

/** La regla del corte, sola, para quien solo necesita preguntar. */
async function assertCanClose(runner, { nightclubId, shift }) {
  const resumen = await shiftCuts.shiftSummary(runner, { nightclubId, shift });
  if (Number(resumen.cash_to_hand) > 0 || Number(resumen.totals.total_collected) > 0) {
    if (!resumen.closing) {
      const err = ApiError.unprocessable(
        `Cobraste ${resumen.totals.total_collected} en este turno: haz tu corte antes de `
        + 'cerrarlo. Al cerrarlo, el turno se cierra solo.',
        { cash_to_hand: resumen.cash_to_hand, total_collected: resumen.totals.total_collected });
      err.needsCut = true;
      throw err;
    }
  }
}

module.exports = {
  SHIFT_ROLES, openShift, start, end, assertCanClose,
};
