// Departure certificate without a taxi (D85).
//
//   guest    POST /departures            "I'm leaving on my own"
//            GET  /departures/mine       the open request, or the still-valid certificate
//            POST /departures/:id/cancel
//            GET  /departures/:id/certificate
//   hostess  GET  /departures            who is waiting at the door
//            POST /departures/:id/confirm  she saw them leave: the folio is born
//
// The valet's delivery issues its own certificate (routes/valet.js), and the public
// page verifies both kinds through GET /taxi/verify/:folio.
'use strict';

const express = require('express');
const { pool } = require('../db/pool');
const { ApiError, asyncHandler } = require('../middleware/errors');
const { validate, z, uuid } = require('../middleware/validate');
const { authenticate, requireRole, sameNightclub } = require('../middleware/auth');
const events = require('../services/events');
const departures = require('../services/departures');

const router = express.Router({ mergeParams: true });

router.use('/nightclubs/:nightclubId/departures', authenticate, sameNightclub());

const DOOR_ROLES = ['hostess'];
const isManager = (user) => user.role === 'manager' || user.role === 'admin';

async function inTransaction(work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function clubName(nightclubId) {
  const { rows } = await pool.query('SELECT name FROM nightclubs WHERE id = $1', [nightclubId]);
  return rows[0] ? rows[0].name : null;
}

// ------------------------------------------------------------------ guest

router.post('/nightclubs/:nightclubId/departures',
  requireRole('guest'),
  validate({ params: z.object({ nightclubId: uuid }) }),
  asyncHandler(async (req, res) => {
    const { nightclubId } = req.params;
    const { row, created } = await inTransaction(
      (client) => departures.request(client, { nightclubId, userId: req.user.id }));
    if (created) {
      await events.publish({
        nightclubId,
        type: 'departure_requested',
        audience: { roles: ['hostess', 'manager'] },
        payload: { departure_id: row.id, guest: departures.shortName(row) },
      });
    }
    res.status(created ? 201 : 200).json({ departure: departures.present(row) });
  }));

router.get('/nightclubs/:nightclubId/departures/mine',
  validate({ params: z.object({ nightclubId: uuid }) }),
  asyncHandler(async (req, res) => {
    const { nightclubId } = req.params;
    const row = await departures.currentFor(pool, { nightclubId, userId: req.user.id });
    res.json({
      departure: departures.present(row),
      certificate: row && row.status === 'confirmed'
        ? departures.certificate(row, await clubName(nightclubId)) : null,
    });
  }));

router.post('/nightclubs/:nightclubId/departures/:departureId/cancel',
  validate({ params: z.object({ nightclubId: uuid, departureId: uuid }) }),
  asyncHandler(async (req, res) => {
    const { nightclubId, departureId } = req.params;
    const row = await inTransaction((client) => departures.cancel(client, {
      nightclubId, id: departureId, userId: req.user.id,
    }));
    await events.publish({
      nightclubId,
      type: 'departure_canceled',
      audience: { roles: ['hostess', 'manager'] },
      payload: { departure_id: row.id },
    });
    res.json({ departure: departures.present(row) });
  }));

router.get('/nightclubs/:nightclubId/departures/:departureId/certificate',
  validate({ params: z.object({ nightclubId: uuid, departureId: uuid }) }),
  asyncHandler(async (req, res) => {
    const { nightclubId, departureId } = req.params;
    const row = await departures.get(pool, { nightclubId, id: departureId });
    // Someone else's departure does not exist as far as you are concerned.
    if (!row || (row.user_id !== req.user.id && !isManager(req.user))) {
      throw ApiError.notFound('Salida no encontrada');
    }
    if (row.status !== 'confirmed') {
      throw ApiError.conflict('La constancia se emite cuando la hostess confirma la salida');
    }
    res.json({ certificate: departures.certificate(row, await clubName(nightclubId)) });
  }));

// ------------------------------------------------------------------ the door

router.get('/nightclubs/:nightclubId/departures',
  requireRole(...DOOR_ROLES, 'manager'),
  validate({ params: z.object({ nightclubId: uuid }) }),
  asyncHandler(async (req, res) => {
    const rows = await departures.pending(pool, { nightclubId: req.params.nightclubId });
    res.json({ departures: rows.map((r) => departures.present(r)) });
  }));

router.post('/nightclubs/:nightclubId/departures/:departureId/confirm',
  requireRole(...DOOR_ROLES),
  validate({ params: z.object({ nightclubId: uuid, departureId: uuid }) }),
  asyncHandler(async (req, res) => {
    const { nightclubId, departureId } = req.params;
    const row = await inTransaction((client) => departures.confirm(client, {
      nightclubId, id: departureId, staffId: req.user.id,
    }));
    await events.publish({
      nightclubId,
      type: 'departure_confirmed',
      audience: { userIds: [row.user_id], roles: ['hostess', 'manager'] },
      payload: { departure_id: row.id, folio: row.folio, expires_at: row.expires_at },
    });
    res.json({ departure: departures.present(row) });
  }));

module.exports = router;
