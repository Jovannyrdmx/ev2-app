/**
 * EV2 — la cuenta de uno mismo: borrarla (D68).
 *
 * Va montado en `/api/auth` junto al resto de lo que una persona hace con su propia
 * cuenta, y no bajo `/api/nightclubs/:id/...`: borrarse no es una acción dentro de un
 * club, es salirse. El club sale del token, no de la dirección.
 *
 * ---------------------------------------------------------------------------
 * Por qué son dos rutas y no una
 * ---------------------------------------------------------------------------
 * `GET /me/deletion` responde qué impide borrarse AHORA. La pantalla la llama antes de
 * enseñar el botón, así que quien tiene el coche en el valet lee "tu coche sigue en el
 * valet" en vez de teclear su confirmación y llevarse un 409. Un error después de
 * escribir "BORRAR" se lee como que el sistema no quiere dejarte ir.
 *
 * `DELETE /me` hace el trabajo, y vuelve a comprobar todo por su cuenta: entre la
 * pantalla y el botón pueden pasar veinte minutos y una ronda de tragos.
 *
 * ---------------------------------------------------------------------------
 * La confirmación escrita
 * ---------------------------------------------------------------------------
 * El cuerpo tiene que traer `confirm: "BORRAR"`. No es teatro: es la única acción
 * irreversible que un cliente puede ejecutar sobre sí mismo, y un toque accidental en
 * un teléfono a las tres de la mañana no debe poder hacerla. El texto se compara en
 * mayúsculas y sin espacios alrededor, para que el teclado del teléfono no sea el que
 * decida si alguien conserva su cuenta.
 */
'use strict';

const express = require('express');
const { ApiError, asyncHandler } = require('../middleware/errors');
const { validate, z } = require('../middleware/validate');
const { authenticate, revokeAllRefreshTokens } = require('../middleware/auth');
const deletion = require('../services/account-deletion');

const router = express.Router();

const PALABRA = 'BORRAR';

/** Qué impide borrar esta cuenta ahora mismo. */
router.get('/me/deletion', authenticate, asyncHandler(async (req, res) => {
  const estado = await deletion.check(req.user.id);
  if (!estado) throw ApiError.notFound('No existe esa cuenta');
  res.json(estado);
}));

/**
 * Borrar la cuenta.
 *
 * Responde 200 y no 204 a propósito: quien acaba de borrarse merece ver la constancia
 * —la fecha y qué se limpió— y no una pantalla en blanco que lo deje con la duda de si
 * de verdad pasó algo.
 */
router.delete('/me', authenticate,
  validate({ body: z.object({ confirm: z.string().trim().max(20) }) }),
  asyncHandler(async (req, res) => {
    if (String(req.body.confirm).trim().toUpperCase() !== PALABRA) {
      throw ApiError.badRequest(`Para borrar tu cuenta escribe ${PALABRA}`,
        { reason: 'confirmation_required' });
    }

    const r = await deletion.remove(req.user.id, { requestedBy: 'self' });
    if (r.notFound) throw ApiError.notFound('No existe esa cuenta');
    if (!r.ok) {
      throw ApiError.conflict('Todavía no se puede borrar tu cuenta',
        { blockers: r.blockers });
    }

    // El servicio ya borró los tokens de refresco dentro de su transacción. Esto es el
    // cinturón encima del tirante: si algún día esa limpieza se mueve de lugar, aquí
    // sigue habiendo alguien cerrando las sesiones abiertas.
    await revokeAllRefreshTokens(req.user.id).catch(() => {});

    res.json({ deleted_at: r.deleted_at, cleared: r.cleared });
  }));

module.exports = router;
