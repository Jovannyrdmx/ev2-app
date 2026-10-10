/**
 * Cómo salió una noche, y el rol de quién la trabajó.
 *
 * Dos cosas para el gerente, en su propio archivo porque ninguna de las dos mueve
 * dinero ni existencias: aquí solo se lee y se congela un reporte.
 *
 * Quién puede qué:
 *   - ver el corte y cerrarlo: gerencia. Es información del negocio -- cuánto se
 *     vendió, qué zona no se llenó, cuánto producto se fue sin venderse -- y no
 *     tiene por qué verla el piso;
 *   - armar el rol de la noche: gerencia. Quién atiende qué zona decide las
 *     propinas de la noche, así que no se reacomoda solo;
 *   - ver LO SUYO del rol: cualquier empleado, sobre su propia asignación.
 */
'use strict';

const express = require('express');
const { pool } = require('../db/pool');
const { ApiError, asyncHandler } = require('../middleware/errors');
const { validate, z, uuid, pagination } = require('../middleware/validate');
const { authenticate, requireRole, sameNightclub } = require('../middleware/auth');
const nightStats = require('../services/night-stats');
const assignments = require('../services/assignments');

const router = express.Router({ mergeParams: true });

router.use('/nightclubs/:nightclubId', authenticate, sameNightclub());

// ======================================================================= el corte

/**
 * El corte en vivo: se calcula al pedirlo.
 *
 * Durante la noche cambia a cada rato, y eso es lo que se quiere: el gerente lo
 * mira desde el telefono a la una de la manana. El corte GUARDADO es otra cosa
 * (`/close`), y la diferencia es todo el punto: uno se mueve, el otro no.
 */
router.get('/nightclubs/:nightclubId/nights/:eventId/stats',
  requireRole('manager', 'admin'),
  validate({ params: z.object({ nightclubId: uuid, eventId: uuid }) }),
  asyncHandler(async (req, res) => {
    const stats = await nightStats.nightStats({
      nightclubId: req.params.nightclubId, eventId: req.params.eventId,
    });

    // Si la noche ya se cerro, se dice: los numeros de arriba pueden diferir del
    // corte guardado (una propina tardia, un pedido que se entrego despues), y
    // enseñar dos cifras distintas sin explicar por que es como se pierde la
    // confianza en un reporte.
    const { rows } = await pool.query(
      'SELECT id, closed_at FROM night_closings WHERE event_id = $1', [req.params.eventId]);

    res.json({
      stats,
      closed: rows.length > 0 ? { id: rows[0].id, closed_at: rows[0].closed_at } : null,
    });
  }));

/** Congela el corte. Una noche se cierra una vez. */
router.post('/nightclubs/:nightclubId/nights/:eventId/close',
  requireRole('manager', 'admin'),
  validate({
    params: z.object({ nightclubId: uuid, eventId: uuid }),
    body: z.object({ note: z.string().trim().max(300).optional() }).default({}),
  }),
  asyncHandler(async (req, res) => {
    const closing = await nightStats.closeNight({
      nightclubId: req.params.nightclubId,
      eventId: req.params.eventId,
      userId: req.user.id,
      note: req.body.note || null,
    });
    res.status(201).json({ closing });
  }));

/** Los cortes guardados, de la noche mas reciente hacia atras. */
router.get('/nightclubs/:nightclubId/nights/closings',
  requireRole('manager', 'admin'),
  validate({ params: z.object({ nightclubId: uuid }), query: pagination }),
  asyncHandler(async (req, res) => {
    res.json({
      closings: await nightStats.closings({
        nightclubId: req.params.nightclubId,
        limit: req.query.limit,
        offset: req.query.offset,
      }),
    });
  }));

/**
 * Un corte guardado, completo.
 *
 * Va por `event_id` y no por el id del corte: el gerente piensa en noches, no en
 * ids de reportes, y la pantalla ya tiene el evento en la mano.
 */
router.get('/nightclubs/:nightclubId/nights/:eventId/closing',
  requireRole('manager', 'admin'),
  validate({ params: z.object({ nightclubId: uuid, eventId: uuid }) }),
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT c.*, e.name AS event_name, u.display_name AS closed_by_name
         FROM night_closings c
         JOIN events_calendar e ON e.id = c.event_id
         LEFT JOIN users u ON u.id = c.closed_by
        WHERE c.event_id = $1 AND c.nightclub_id = $2`,
      [req.params.eventId, req.params.nightclubId]);
    if (rows.length === 0) throw ApiError.notFound('Esa noche todavia no se ha cerrado');
    res.json({ closing: rows[0] });
  }));

// ============================================================== el rol de la noche

const target = z.object({
  section: z.string().trim().max(40).optional(),
  location_id: uuid.optional(),
  note: z.string().trim().max(200).optional(),
});

/** Quien esta asignado, y -- mas importante -- que quedo sin nadie. */
router.get('/nightclubs/:nightclubId/nights/:eventId/roster',
  requireRole('manager', 'admin'),
  validate({ params: z.object({ nightclubId: uuid, eventId: uuid }) }),
  asyncHandler(async (req, res) => {
    const { nightclubId, eventId } = req.params;
    await assignments.loadEvent(pool, { nightclubId, eventId });
    const [roster, gaps] = await Promise.all([
      assignments.rosterFor(pool, { nightclubId, eventId }),
      assignments.gapsFor(pool, { nightclubId, eventId }),
    ]);
    res.json({
      roster,
      gaps,
      assigned: roster.length,
      on_shift: roster.filter((p) => p.on_shift).length,
      assignable_roles: assignments.ASSIGNABLE_ROLES,
    });
  }));

/**
 * Pone a alguien en el rol.
 *
 * Solo gerencia: quien atiende que zona decide las propinas de la noche, y
 * dejarlo abierto es dejar que se reacomode solo. Y asignar NO abre el turno --
 * el empleado marca su entrada al llegar, para que "asignado" y "presente" sigan
 * siendo dos cosas distintas.
 */
router.post('/nightclubs/:nightclubId/nights/:eventId/roster',
  requireRole('manager', 'admin'),
  validate({
    params: z.object({ nightclubId: uuid, eventId: uuid }),
    body: target.extend({ user_id: uuid }),
  }),
  asyncHandler(async (req, res) => {
    const { nightclubId, eventId } = req.params;
    const result = await assignments.assign(pool, {
      nightclubId,
      eventId,
      userId: req.body.user_id,
      section: req.body.section || null,
      locationId: req.body.location_id || null,
      note: req.body.note || null,
      assignedBy: req.user.id,
    });
    const roster = await assignments.rosterFor(pool, { nightclubId, eventId });
    res.status(result.already ? 200 : 201).json({
      assignment_id: result.id, already: result.already, roster,
    });
  }));

router.delete('/nightclubs/:nightclubId/roster/:assignmentId',
  requireRole('manager', 'admin'),
  validate({ params: z.object({ nightclubId: uuid, assignmentId: uuid }) }),
  asyncHandler(async (req, res) => {
    await assignments.unassign(pool, {
      nightclubId: req.params.nightclubId, assignmentId: req.params.assignmentId,
    });
    res.status(204).end();
  }));

/**
 * A que quedo asignada la persona que pregunta.
 *
 * Cualquier empleado, solo lo suyo: es lo que ve al llegar, en vez de teclear su
 * zona de memoria -- que es como alguien acaba cobrando las propinas de otra
 * seccion.
 */
router.get('/nightclubs/:nightclubId/roster/mine',
  validate({
    params: z.object({ nightclubId: uuid }),
    query: z.object({ event_id: uuid.optional() }).default({}),
  }),
  asyncHandler(async (req, res) => {
    res.json({
      assignments: await assignments.myAssignments(pool, {
        nightclubId: req.params.nightclubId,
        userId: req.user.id,
        eventId: req.query.event_id || null,
      }),
    });
  }));

module.exports = router;
