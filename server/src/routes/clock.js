/**
 * EV2 — checador de huella (D94). Reglas en `services/fingerprints.js`.
 *
 * Dos públicos, dos routers (igual que las impresoras, D52):
 *
 *   * **La PC checadora**, sin sesión de persona: se identifica con su token en
 *     `X-Clock-Station-Token`. Lo único que puede hacer es marcar entradas y salidas
 *     de SU club. Un token de persona no sirve aquí, y este token no sirve en ningún
 *     otro lado.
 *   * **El gerente**, con su sesión: da de alta la PC checadora, registra huellas con
 *     el consentimiento del empleado, las borra, y ve la asistencia.
 */
'use strict';

const express = require('express');
const { pool } = require('../db/pool');
const { ApiError, asyncHandler } = require('../middleware/errors');
const { validate, z, uuid } = require('../middleware/validate');
const { authenticate, requireRole, sameNightclub } = require('../middleware/auth');
const fp = require('../services/fingerprints');

const router = express.Router({ mergeParams: true });
const stationRouter = express.Router({ mergeParams: true });

const image = z.string().min(100).max(420 * 1024);

/** Una transacción, para lo que escribe en varias tablas o bloquea a una persona. */
async function inTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ============================================================================
// La PC checadora
// ============================================================================

const authenticateStation = asyncHandler(async (req, res, next) => {
  const station = await fp.stationByToken(pool, req.get('X-Clock-Station-Token') || '');
  // Un token malo no dice si existía, si estaba dado de baja ni de qué club era.
  if (!station) throw ApiError.unauthorized('Esta PC no está dada de alta como checador');
  req.station = station;
  next();
});

stationRouter.use(authenticateStation);

stationRouter.get('/',
  asyncHandler(async (req, res) => {
    res.json({
      station: { id: req.station.id, name: req.station.name, club_name: req.station.club_name },
      configured: fp.isConfigured(),
    });
  }));

stationRouter.post('/punch',
  validate({ body: z.object({ image }) }),
  asyncHandler(async (req, res) => {
    const r = await inTransaction((client) => fp.punch(client, { station: req.station, image: req.body.image }));
    res.status(r.repeated ? 200 : 201).json({
      kind: r.kind,
      at: r.at,
      repeated: r.repeated,
      user: { name: r.user.name, role: r.user.role },
    });
  }));

// ============================================================================
// El gerente
// ============================================================================

router.use('/nightclubs/:nightclubId', authenticate, sameNightclub());

const MANAGE = ['manager'];
const finger = z.enum(fp.FINGERS);

/** El empleado, de este club y activo. */
async function employeeOf(nightclubId, userId) {
  const { rows } = await pool.query(
    `SELECT u.id, u.role, COALESCE(u.display_name, u.first_name) AS name
       FROM users u JOIN employee_profiles p ON p.user_id = u.id AND p.active
      WHERE u.id = $1 AND u.nightclub_id = $2 AND u.status = 'active'`,
    [userId, nightclubId]);
  if (!rows[0]) throw ApiError.notFound('Ese empleado no existe o está dado de baja');
  return rows[0];
}

router.get('/nightclubs/:nightclubId/clock',
  requireRole(...MANAGE),
  validate({ params: z.object({ nightclubId: uuid }) }),
  asyncHandler(async (req, res) => {
    const [stations, employees] = await Promise.all([
      fp.listStations(pool, { nightclubId: req.params.nightclubId }),
      fp.enrollmentStatus(pool, { nightclubId: req.params.nightclubId }),
    ]);
    res.json({
      configured: fp.isConfigured(),
      problem: fp.configProblem(),
      notice_version: fp.NOTICE_VERSION,
      captures_per_finger: fp.CAPTURES_PER_FINGER,
      fingers_per_person: fp.FINGERS_PER_PERSON,
      stations,
      employees,
    });
  }));

/**
 * Hacer de ESTA PC el checador. Se llama desde la propia PC de la caja, con el
 * gerente con su sesión ahí: el token vuelve una sola vez y se queda en esa PC.
 */
router.post('/nightclubs/:nightclubId/clock/stations',
  requireRole(...MANAGE),
  validate({
    params: z.object({ nightclubId: uuid }),
    body: z.object({ name: z.string().trim().min(1).max(60) }),
  }),
  asyncHandler(async (req, res) => {
    const out = await fp.createStation(pool, {
      nightclubId: req.params.nightclubId, name: req.body.name, createdBy: req.user.id,
    });
    res.status(201).json(out);
  }));

router.delete('/nightclubs/:nightclubId/clock/stations/:stationId',
  requireRole(...MANAGE),
  validate({ params: z.object({ nightclubId: uuid, stationId: uuid }) }),
  asyncHandler(async (req, res) => {
    await fp.revokeStation(pool, {
      nightclubId: req.params.nightclubId, stationId: req.params.stationId, revokedBy: req.user.id,
    });
    res.status(204).end();
  }));

/** El empleado acepta el aviso de privacidad con SU PIN, delante del gerente. */
router.post('/nightclubs/:nightclubId/employees/:userId/biometric-consent',
  requireRole(...MANAGE),
  validate({
    params: z.object({ nightclubId: uuid, userId: uuid }),
    body: z.object({ pin: z.string().trim().regex(/^\d{6}$/, 'El PIN es de 6 dígitos') }),
  }),
  asyncHandler(async (req, res) => {
    const employee = await employeeOf(req.params.nightclubId, req.params.userId);
    const consent = await fp.giveConsent(pool, {
      nightclubId: req.params.nightclubId, employee, pin: req.body.pin,
      witnessId: req.user.id, ip: req.ip,
    });
    res.status(201).json({ consent });
  }));

/** Retirar el consentimiento: borra sus huellas en el acto. */
router.delete('/nightclubs/:nightclubId/employees/:userId/biometric-consent',
  requireRole(...MANAGE),
  validate({ params: z.object({ nightclubId: uuid, userId: uuid }) }),
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(
      'SELECT id FROM users WHERE id = $1 AND nightclub_id = $2', [req.params.userId, req.params.nightclubId]);
    if (!rows[0]) throw ApiError.notFound('Ese empleado no existe');
    const out = await inTransaction((client) => fp.revokeAndErase(client, {
      userId: req.params.userId, revokedBy: req.user.id, reason: 'requested',
    }));
    res.json(out);
  }));

router.post('/nightclubs/:nightclubId/employees/:userId/fingerprints',
  requireRole(...MANAGE),
  validate({
    params: z.object({ nightclubId: uuid, userId: uuid }),
    body: z.object({ finger, images: z.array(image).length(fp.CAPTURES_PER_FINGER) }),
  }),
  asyncHandler(async (req, res) => {
    const employee = await employeeOf(req.params.nightclubId, req.params.userId);
    const out = await inTransaction(async (client) => {
      // Una persona a la vez: dos registros simultáneos no deben saltarse el tope de dedos.
      await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [employee.id]);
      return fp.enrollFinger(client, {
        nightclubId: req.params.nightclubId, employee, finger: req.body.finger,
        images: req.body.images, enrolledBy: req.user.id,
      });
    });
    res.status(201).json(out);
  }));

router.delete('/nightclubs/:nightclubId/employees/:userId/fingerprints/:finger',
  requireRole(...MANAGE),
  validate({ params: z.object({ nightclubId: uuid, userId: uuid, finger }) }),
  asyncHandler(async (req, res) => {
    await employeeOf(req.params.nightclubId, req.params.userId);
    await fp.deleteFinger(pool, { userId: req.params.userId, finger: req.params.finger });
    res.status(204).end();
  }));

/** La asistencia de un rango (por omisión, las últimas 24 horas). */
router.get('/nightclubs/:nightclubId/clock/events',
  requireRole(...MANAGE),
  validate({
    params: z.object({ nightclubId: uuid }),
    query: z.object({
      since: z.string().datetime({ offset: true }).optional(),
      until: z.string().datetime({ offset: true }).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const until = req.query.until || new Date().toISOString();
    const since = req.query.since || new Date(Date.parse(until) - 24 * 3600 * 1000).toISOString();
    if (Date.parse(until) - Date.parse(since) > 62 * 24 * 3600 * 1000) {
      throw ApiError.badRequest('El rango máximo es de dos meses');
    }
    const events = await fp.attendance(pool, { nightclubId: req.params.nightclubId, since, until });
    res.json({ events, since, until });
  }));

module.exports = router;
module.exports.stationRouter = stationRouter;
