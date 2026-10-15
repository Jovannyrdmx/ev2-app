/**
 * Compras y reabasto (D114): lo más vendido de una noche, los insumos que se
 * gastaron, cuánto comprar y el plan de la próxima noche con sus promociones.
 *
 * Las promociones se dan de alta en su propia sección (`routes/promotions.js`, D102);
 * aquí solo se leen.
 *
 * Todo es de gerencia (gerente y administrador). Son números del negocio —qué se
 * vende, cuánto cuesta reponerlo— y aquí no se mueve ni dinero ni existencia: la
 * compra se registra después por la entrada de mercancía de siempre.
 */
'use strict';

const express = require('express');
const { asyncHandler } = require('../middleware/errors');
const { validate, z, uuid } = require('../middleware/validate');
const { authenticate, requireRole, sameNightclub } = require('../middleware/auth');
const planning = require('../services/purchase-planning');

const router = express.Router({ mergeParams: true });

router.use('/nightclubs/:nightclubId', authenticate, sameNightclub());

const manage = requireRole('manager', 'admin');
const eventParams = z.object({ nightclubId: uuid, eventId: uuid });

/**
 * El reporte de una noche: tragos más vendidos, insumos gastados y la lista de
 * compra. La lista cubre además la próxima noche; `next_event_id` permite escoger
 * otra en vez de la que sigue en el calendario.
 */
router.get('/nightclubs/:nightclubId/nights/:eventId/purchasing',
  manage,
  validate({
    params: eventParams,
    query: z.object({ next_event_id: uuid.optional() }),
  }),
  asyncHandler(async (req, res) => {
    res.json({
      report: await planning.nightReport({
        nightclubId: req.params.nightclubId,
        eventId: req.params.eventId,
        nextEventId: req.query.next_event_id || null,
      }),
    });
  }));

/** El plan de insumos de una noche por venir: pronóstico + promociones. */
router.get('/nightclubs/:nightclubId/events/:eventId/supply-plan',
  manage,
  validate({ params: eventParams }),
  asyncHandler(async (req, res) => {
    res.json({
      plan: await planning.supplyPlan({
        nightclubId: req.params.nightclubId, eventId: req.params.eventId,
      }),
    });
  }));

module.exports = router;
