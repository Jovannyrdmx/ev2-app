// Valet parking with QR (docs/DECISIONES.md D22).
//
//   * parking is free: the club charges nothing and what the valet earns is the tip,
//     which goes through the tips module (2.5). The fee mechanism exists and is
//     honoured if the club ever sets one above zero;
//   * the ticket has a short code to talk about it and a long random token behind the
//     QR to release the car. **The board never shows the token**: if a valet could
//     read it off a list, requiring it at handover would be theatre. It travels once
//     at check-in (to print it) and to the guest who owns the ticket, so the car can
//     also be released from the phone;
//   * the only way past the QR is the manager, who records why, what kind of ID was
//     shown and the name on it. The ID number is never stored.
'use strict';

const express = require('express');
const { pool } = require('../db/pool');
const { ApiError, asyncHandler } = require('../middleware/errors');
const { validate, z, uuid, pagination, currency } = require('../middleware/validate');
const { authenticate, requireRole, sameNightclub } = require('../middleware/auth');
const events = require('../services/events');
const valet = require('../services/valet');

const router = express.Router({ mergeParams: true });

const OPEN = valet.OPEN_STATUSES;
const STAND_ROLES = ['valet', 'hostess', 'manager'];

// `qr_token` is deliberately absent: see the file header.
const TICKET_SELECT = `
  SELECT t.id, t.code, t.status, t.plate, t.vehicle_desc, t.phone, t.notes,
         t.fee::text AS fee, t.currency, t.rating, t.rating_comment,
         t.checked_in_at, t.requested_at, t.ready_at, t.delivered_at, t.cancelled_at,
         t.cancel_reason, t.claimed_at, t.created_at, t.transaction_id,
         t.user_id, ou.display_name AS owner_name, ou.phone AS owner_phone,
         t.spot_id, s.code AS spot_code, s.zone AS spot_zone,
         t.valet_in_id, vi.display_name AS received_by,
         t.valet_out_id, vo.display_name AS delivered_by,
         t.override_by, t.override_at, t.override_reason, t.override_id_type, t.override_id_name,
         ob.display_name AS override_by_name
    FROM valet_tickets t
    LEFT JOIN users ou ON ou.id = t.user_id
    LEFT JOIN parking_spots s ON s.id = t.spot_id
    LEFT JOIN users vi ON vi.id = t.valet_in_id
    LEFT JOIN users vo ON vo.id = t.valet_out_id
    LEFT JOIN users ob ON ob.id = t.override_by`;

function isStand(user) {
  return user.role === 'admin' || STAND_ROLES.includes(user.role);
}
function isManager(user) {
  return user.role === 'manager' || user.role === 'admin';
}

/** The guest never sees who parked their car or the manager's override notes. */
function presentTicket(row, viewer) {
  const base = {
    id: row.id,
    code: row.code,
    status: row.status,
    plate: row.plate,
    vehicle_desc: row.vehicle_desc,
    fee: row.fee,
    currency: row.currency,
    rating: row.rating,
    spot: row.spot_id ? { id: row.spot_id, code: row.spot_code, zone: row.spot_zone } : null,
    checked_in_at: row.checked_in_at,
    requested_at: row.requested_at,
    ready_at: row.ready_at,
    delivered_at: row.delivered_at,
    cancelled_at: row.cancelled_at,
    cancel_reason: row.cancel_reason,
    claimed: row.user_id !== null,
  };
  if (viewer === 'guest') return base;
  const staff = {
    ...base,
    phone: row.phone,
    notes: row.notes,
    owner: row.user_id ? { id: row.user_id, name: row.owner_name, phone: row.owner_phone } : null,
    received_by: row.received_by,
    delivered_by: row.delivered_by,
    rating_comment: row.rating_comment,
  };
  if (viewer !== 'manager') return staff;
  return {
    ...staff,
    transaction_id: row.transaction_id,
    override: row.override_by ? {
      by: row.override_by_name,
      at: row.override_at,
      reason: row.override_reason,
      id_type: row.override_id_type,
      id_name: row.override_id_name,
    } : null,
  };
}

async function loadTicket(req, ticketId, runner = pool) {
  const { rows } = await runner.query(`${TICKET_SELECT} WHERE t.id = $1 AND t.nightclub_id = $2`,
    [ticketId, req.params.nightclubId]);
  if (rows.length === 0) throw ApiError.notFound('Ticket no encontrado');
  const row = rows[0];
  if (isManager(req.user)) return { row, viewer: 'manager' };
  if (isStand(req.user)) return { row, viewer: 'staff' };
  if (row.user_id === req.user.id) return { row, viewer: 'guest' };
  throw ApiError.notFound('Ticket no encontrado');
}

router.use('/nightclubs/:nightclubId', authenticate, sameNightclub());

// ------------------------------------------------------------------ settings

router.get('/nightclubs/:nightclubId/valet-settings',
  validate({ params: z.object({ nightclubId: uuid }) }),
  asyncHandler(async (req, res) => {
    const settings = await valet.settingsFor(req.params.nightclubId);
    res.json({ settings });
  }));

router.put('/nightclubs/:nightclubId/valet-settings',
  requireRole('manager'),
  validate({
    params: z.object({ nightclubId: uuid }),
    body: z.object({
      enabled: z.boolean().optional(),
      handover_point: z.string().trim().min(1).max(120).optional(),
      fee_amount: z.number().min(0).max(100000).optional(),
      currency: currency.optional(),
      terms: z.string().trim().max(4000).nullable().optional(),
    }).refine((b) => Object.keys(b).length > 0, { message: 'No fields to update' }),
  }),
  asyncHandler(async (req, res) => {
    const { nightclubId } = req.params;
    await valet.settingsFor(nightclubId);
    const b = req.body;
    const { rows } = await pool.query(
      `UPDATE valet_settings SET
         enabled = COALESCE($2, enabled),
         handover_point = COALESCE($3, handover_point),
         fee_amount = COALESCE($4, fee_amount),
         currency = COALESCE($5, currency),
         terms = CASE WHEN $6::boolean THEN $7 ELSE terms END,
         updated_by = $8, updated_at = now()
       WHERE nightclub_id = $1
       RETURNING nightclub_id, enabled, handover_point, fee_amount::text, currency, terms, updated_at`,
      [nightclubId, b.enabled ?? null, b.handover_point ?? null, b.fee_amount ?? null,
        b.currency ?? null, Object.hasOwn(b, 'terms'), b.terms ?? null, req.user.id]);
    res.json({ settings: rows[0] });
  }));

// ------------------------------------------------------------------ parking spots

router.get('/nightclubs/:nightclubId/parking-spots',
  requireRole(...STAND_ROLES),
  validate({
    params: z.object({ nightclubId: uuid }),
    query: z.object({ include_inactive: z.coerce.boolean().default(false) }),
  }),
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT s.id, s.code, s.zone, s.active,
              t.id AS ticket_id, t.code AS ticket_code, t.plate
         FROM parking_spots s
         LEFT JOIN valet_tickets t ON t.spot_id = s.id AND t.status = ANY($3::text[])
        WHERE s.nightclub_id = $1 AND ($2::boolean OR s.active)
        ORDER BY s.zone NULLS FIRST, s.code`,
      [req.params.nightclubId, req.query.include_inactive, OPEN]);
    res.json({
      spots: rows.map((r) => ({
        id: r.id,
        code: r.code,
        zone: r.zone,
        active: r.active,
        occupied_by: r.ticket_id ? { ticket_id: r.ticket_id, code: r.ticket_code, plate: r.plate } : null,
      })),
      occupancy: await valet.occupancy(req.params.nightclubId),
    });
  }));

router.post('/nightclubs/:nightclubId/parking-spots',
  requireRole('manager'),
  validate({
    params: z.object({ nightclubId: uuid }),
    // Bulk on purpose: a lot is loaded once, as A1..A20, not one call at a time.
    body: z.object({
      spots: z.array(z.object({
        code: z.string().trim().min(1).max(20),
        zone: z.string().trim().max(40).nullable().optional(),
      })).min(1).max(300),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { nightclubId } = req.params;
    const codes = req.body.spots.map((s) => s.code.toUpperCase());
    if (new Set(codes).size !== codes.length) {
      throw ApiError.badRequest('La lista trae cajones repetidos');
    }
    const client = await pool.connect();
    const created = [];
    try {
      await client.query('BEGIN');
      for (const spot of req.body.spots) {
        const { rows } = await client.query(
          `INSERT INTO parking_spots (nightclub_id, code, zone) VALUES ($1,$2,$3)
           ON CONFLICT (nightclub_id, code) DO NOTHING
           RETURNING id, code, zone, active`,
          [nightclubId, spot.code.toUpperCase(), spot.zone ?? null]);
        if (rows.length > 0) created.push(rows[0]);
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    res.status(201).json({ created, skipped: req.body.spots.length - created.length });
  }));

router.put('/nightclubs/:nightclubId/parking-spots/:spotId',
  requireRole('manager'),
  validate({
    params: z.object({ nightclubId: uuid, spotId: uuid }),
    body: z.object({
      code: z.string().trim().min(1).max(20).optional(),
      zone: z.string().trim().max(40).nullable().optional(),
      active: z.boolean().optional(),
    }).refine((b) => Object.keys(b).length > 0, { message: 'No fields to update' }),
  }),
  asyncHandler(async (req, res) => {
    const b = req.body;
    if (b.active === false) {
      const busy = await pool.query(
        `SELECT 1 FROM valet_tickets WHERE spot_id = $1 AND status = ANY($2::text[]) LIMIT 1`,
        [req.params.spotId, OPEN]);
      if (busy.rowCount > 0) throw ApiError.conflict('El cajón tiene un auto estacionado');
    }
    try {
      const { rows } = await pool.query(
        `UPDATE parking_spots SET code = COALESCE(upper($3), code),
                zone = CASE WHEN $4::boolean THEN $5 ELSE zone END,
                active = COALESCE($6, active)
          WHERE id = $1 AND nightclub_id = $2
          RETURNING id, code, zone, active`,
        [req.params.spotId, req.params.nightclubId, b.code ?? null,
          Object.hasOwn(b, 'zone'), b.zone ?? null, b.active ?? null]);
      if (rows.length === 0) throw ApiError.notFound('Cajón no encontrado');
      res.json({ spot: rows[0] });
    } catch (err) {
      if (err.code === '23505') throw ApiError.conflict('Ya existe un cajón con ese código');
      throw err;
    }
  }));

router.delete('/nightclubs/:nightclubId/parking-spots/:spotId',
  requireRole('manager'),
  validate({ params: z.object({ nightclubId: uuid, spotId: uuid }) }),
  asyncHandler(async (req, res) => {
    const busy = await pool.query(
      `SELECT 1 FROM valet_tickets WHERE spot_id = $1 AND status = ANY($2::text[]) LIMIT 1`,
      [req.params.spotId, OPEN]);
    if (busy.rowCount > 0) throw ApiError.conflict('El cajón tiene un auto estacionado');
    // Retired, not deleted: past tickets point at it.
    const { rows } = await pool.query(
      `UPDATE parking_spots SET active = false WHERE id = $1 AND nightclub_id = $2
        RETURNING id, code, zone, active`,
      [req.params.spotId, req.params.nightclubId]);
    if (rows.length === 0) throw ApiError.notFound('Cajón no encontrado');
    res.json({ spot: rows[0] });
  }));

// ------------------------------------------------------------------ check-in

router.post('/nightclubs/:nightclubId/valet/tickets',
  requireRole(...STAND_ROLES),
  validate({
    params: z.object({ nightclubId: uuid }),
    body: z.object({
      plate: z.string().trim().min(3).max(20),
      vehicle_desc: z.string().trim().max(120).optional(),
      phone: z.string().trim().max(30).optional(),
      spot_id: uuid.optional(),
      notes: z.string().trim().max(280).optional(),
      client_request_id: uuid.optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { nightclubId } = req.params;
    const b = req.body;
    const settings = await valet.settingsFor(nightclubId);
    if (!settings.enabled) throw ApiError.unprocessable('El servicio de valet está desactivado');

    if (b.client_request_id) {
      const existing = await pool.query(
        `${TICKET_SELECT} WHERE t.client_request_id = $1`, [b.client_request_id]);
      if (existing.rowCount > 0) {
        return res.status(200).json({
          ticket: presentTicket(existing.rows[0], 'staff'), idempotent: true,
        });
      }
    }

    if (b.spot_id) {
      const spot = await pool.query(
        'SELECT id FROM parking_spots WHERE id = $1 AND nightclub_id = $2 AND active',
        [b.spot_id, nightclubId]);
      if (spot.rowCount === 0) throw ApiError.unprocessable('Ese cajón no existe o está retirado');
    }

    const qrToken = valet.generateQrToken();
    let ticket = null;
    // The short code is random, so a collision inside one club is possible and cheap
    // to retry; the token is not.
    for (let attempt = 0; attempt < 5 && !ticket; attempt += 1) {
      try {
        const { rows } = await pool.query(
          `INSERT INTO valet_tickets (nightclub_id, code, qr_token, valet_in_id, spot_id, plate,
                                      vehicle_desc, phone, notes, fee, currency, client_request_id)
           VALUES ($1,$2,$3,$4,$5,upper($6),$7,$8,$9,$10,$11,$12)
           RETURNING id`,
          [nightclubId, valet.generateCode(), qrToken, req.user.id, b.spot_id || null, b.plate,
            b.vehicle_desc || null, b.phone || null, b.notes || null,
            settings.fee_amount, settings.currency, b.client_request_id || null]);
        ticket = rows[0];
      } catch (err) {
        if (err.code !== '23505') throw err;
        const detail = String(err.detail || '');
        if (detail.includes('plate')) {
          throw ApiError.conflict('Ese auto ya tiene un ticket abierto');
        }
        if (detail.includes('spot')) {
          throw ApiError.conflict('Ese cajón ya está ocupado');
        }
        if (!detail.includes('code')) throw err;
      }
    }
    if (!ticket) throw new Error('Could not generate a unique valet ticket code');

    const full = await pool.query(`${TICKET_SELECT} WHERE t.id = $1`, [ticket.id]);
    // The token travels exactly once, here, to be printed on the slip as a QR.
    return res.status(201).json({
      ticket: presentTicket(full.rows[0], 'staff'),
      qr_token: qrToken,
      handover_point: settings.handover_point,
    });
  }));

// ------------------------------------------------------------------ boards

router.get('/nightclubs/:nightclubId/valet/tickets',
  requireRole(...STAND_ROLES),
  validate({
    params: z.object({ nightclubId: uuid }),
    query: pagination.extend({
      status: z.enum(['parked', 'requested', 'ready', 'delivered', 'cancelled']).optional(),
      open: z.coerce.boolean().default(false),
      plate: z.string().trim().max(20).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const q = req.query;
    const { rows } = await pool.query(
      `${TICKET_SELECT}
        WHERE t.nightclub_id = $1
          AND ($2::text IS NULL OR t.status = $2)
          AND (NOT $3::boolean OR t.status = ANY($4::text[]))
          AND ($5::text IS NULL OR t.plate LIKE '%' || upper($5) || '%')
        ORDER BY CASE t.status WHEN 'requested' THEN 0 WHEN 'ready' THEN 1 ELSE 2 END,
                 t.requested_at NULLS LAST, t.created_at DESC
        LIMIT $6 OFFSET $7`,
      [req.params.nightclubId, q.status || null, q.open, OPEN, q.plate || null, q.limit, q.offset]);
    const viewer = isManager(req.user) ? 'manager' : 'staff';
    res.json({
      tickets: rows.map((r) => presentTicket(r, viewer)),
      occupancy: await valet.occupancy(req.params.nightclubId),
    });
  }));

router.get('/nightclubs/:nightclubId/valet/tickets/mine',
  validate({ params: z.object({ nightclubId: uuid }), query: pagination }),
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(
      `${TICKET_SELECT} WHERE t.user_id = $1 AND t.nightclub_id = $2
        ORDER BY t.created_at DESC LIMIT $3 OFFSET $4`,
      [req.user.id, req.params.nightclubId, req.query.limit, req.query.offset]);
    res.json({
      tickets: rows.map((r) => presentTicket(r, 'guest')),
      open: rows.filter((r) => OPEN.includes(r.status)).map((r) => presentTicket(r, 'guest')),
    });
  }));

/** Resolving a scan: the token is the input, never the output. */
router.get('/nightclubs/:nightclubId/valet/tickets/by-token/:token',
  requireRole(...STAND_ROLES),
  validate({ params: z.object({ nightclubId: uuid, token: z.string().trim().min(16).max(64) }) }),
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(
      `${TICKET_SELECT} WHERE t.qr_token = $1 AND t.nightclub_id = $2`,
      [req.params.token, req.params.nightclubId]);
    if (rows.length === 0) throw ApiError.notFound('Ese código no corresponde a ningún ticket');
    res.json({ ticket: presentTicket(rows[0], isManager(req.user) ? 'manager' : 'staff') });
  }));

router.get('/nightclubs/:nightclubId/valet/occupancy',
  requireRole(...STAND_ROLES),
  validate({ params: z.object({ nightclubId: uuid }) }),
  asyncHandler(async (req, res) => {
    res.json({ occupancy: await valet.occupancy(req.params.nightclubId) });
  }));

router.get('/nightclubs/:nightclubId/valet/stats',
  requireRole('manager'),
  validate({
    params: z.object({ nightclubId: uuid }),
    query: z.object({
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    res.json(await valet.stats(req.params.nightclubId, req.query));
  }));

// ------------------------------------------------------------------ guest: claim, request, rate

router.post('/nightclubs/:nightclubId/valet/claim',
  validate({
    params: z.object({ nightclubId: uuid }),
    body: z.object({ qr_token: z.string().trim().min(16).max(64) }),
  }),
  asyncHandler(async (req, res) => {
    const { nightclubId } = req.params;
    const found = await pool.query(
      `SELECT id, user_id, status FROM valet_tickets WHERE qr_token = $1 AND nightclub_id = $2`,
      [req.body.qr_token, nightclubId]);
    if (found.rowCount === 0) throw ApiError.notFound('Ese código no corresponde a ningún ticket');
    const ticket = found.rows[0];
    if (ticket.user_id && ticket.user_id !== req.user.id) {
      throw ApiError.conflict('Ese ticket ya está asociado a otra cuenta');
    }
    if (!OPEN.includes(ticket.status)) throw ApiError.conflict('Ese ticket ya está cerrado');

    await pool.query(
      `UPDATE valet_tickets SET user_id = $2, claimed_at = COALESCE(claimed_at, now()),
              updated_at = now()
        WHERE id = $1`, [ticket.id, req.user.id]);
    const full = await pool.query(`${TICKET_SELECT} WHERE t.id = $1`, [ticket.id]);
    res.json({ ticket: presentTicket(full.rows[0], 'guest') });
  }));

router.post('/nightclubs/:nightclubId/valet/tickets/:ticketId/request',
  validate({ params: z.object({ nightclubId: uuid, ticketId: uuid }) }),
  asyncHandler(async (req, res) => {
    const { nightclubId, ticketId } = req.params;
    const { row, viewer } = await loadTicket(req, ticketId);
    if (viewer === 'guest' && row.user_id !== req.user.id) throw ApiError.notFound('Ticket no encontrado');
    if (row.status === 'requested' || row.status === 'ready') {
      // Pressing twice is not an error: the car is already on its way.
      return res.json({ ticket: presentTicket(row, viewer), already_requested: true });
    }
    if (row.status !== 'parked') throw ApiError.conflict('Ese ticket ya está cerrado');

    await pool.query(
      `UPDATE valet_tickets SET status = 'requested', requested_at = now(), requested_by = $2,
              updated_at = now()
        WHERE id = $1 AND status = 'parked'`, [ticketId, req.user.id]);
    const full = await pool.query(`${TICKET_SELECT} WHERE t.id = $1`, [ticketId]);
    await events.publish({
      nightclubId,
      type: 'valet_requested',
      audience: { roles: ['valet', 'hostess', 'manager'] },
      payload: {
        ticket_id: ticketId,
        code: full.rows[0].code,
        plate: full.rows[0].plate,
        spot: full.rows[0].spot_code,
      },
    });
    return res.json({ ticket: presentTicket(full.rows[0], viewer) });
  }));

router.post('/nightclubs/:nightclubId/valet/tickets/:ticketId/rate',
  validate({
    params: z.object({ nightclubId: uuid, ticketId: uuid }),
    body: z.object({
      rating: z.number().int().min(1).max(5),
      comment: z.string().trim().max(280).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { row, viewer } = await loadTicket(req, req.params.ticketId);
    if (viewer !== 'guest') throw ApiError.forbidden('Solo el dueño del ticket puede calificar');
    if (row.status !== 'delivered') throw ApiError.conflict('Solo se califica un servicio terminado');
    if (row.rating !== null) throw ApiError.conflict('Este ticket ya fue calificado');
    const { rows } = await pool.query(
      `UPDATE valet_tickets SET rating = $2, rating_comment = $3, updated_at = now()
        WHERE id = $1 RETURNING rating, rating_comment`,
      [row.id, req.body.rating, req.body.comment || null]);
    res.json({ rating: rows[0] });
  }));

// ------------------------------------------------------------------ valet: ready, deliver, cancel

router.post('/nightclubs/:nightclubId/valet/tickets/:ticketId/ready',
  requireRole(...STAND_ROLES),
  validate({ params: z.object({ nightclubId: uuid, ticketId: uuid }) }),
  asyncHandler(async (req, res) => {
    const { nightclubId, ticketId } = req.params;
    const settings = await valet.settingsFor(nightclubId);
    const { rows } = await pool.query(
      `UPDATE valet_tickets SET status = 'ready', ready_at = now(), valet_out_id = $3,
              requested_at = COALESCE(requested_at, now()), updated_at = now()
        WHERE id = $1 AND nightclub_id = $2 AND status IN ('parked','requested')
        RETURNING id, user_id, code`,
      [ticketId, nightclubId, req.user.id]);
    if (rows.length === 0) throw ApiError.conflict('El ticket no está estacionado ni solicitado');

    if (rows[0].user_id) {
      await events.publish({
        nightclubId,
        type: 'valet_ready',
        audience: { userIds: [rows[0].user_id], roles: ['manager'] },
        payload: {
          ticket_id: ticketId,
          code: rows[0].code,
          handover_point: settings.handover_point,
          message: `Tu auto te espera en ${settings.handover_point}.`,
        },
      });
    }
    const full = await pool.query(`${TICKET_SELECT} WHERE t.id = $1`, [ticketId]);
    res.json({ ticket: presentTicket(full.rows[0], isManager(req.user) ? 'manager' : 'staff') });
  }));

/**
 * Releases the car. The QR token is the control here, not the state machine: whoever
 * holds the ticket (on paper or on their phone) gets the car, whether or not it was
 * requested first.
 */
router.post('/nightclubs/:nightclubId/valet/tickets/:ticketId/deliver',
  requireRole(...STAND_ROLES),
  validate({
    params: z.object({ nightclubId: uuid, ticketId: uuid }),
    body: z.object({
      qr_token: z.string().trim().min(16).max(64),
      payment_method: z.enum(['cash', 'card', 'courtesy']).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { nightclubId, ticketId } = req.params;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const current = await client.query(
        `SELECT id, qr_token, status, user_id, fee, currency
           FROM valet_tickets WHERE id = $1 AND nightclub_id = $2 FOR UPDATE`,
        [ticketId, nightclubId]);
      if (current.rowCount === 0) throw ApiError.notFound('Ticket no encontrado');
      const ticket = current.rows[0];
      if (!OPEN.includes(ticket.status)) throw ApiError.conflict('Ese ticket ya está cerrado');
      if (!valet.tokenMatches(req.body.qr_token, ticket.qr_token)) {
        // Same message whether the token is wrong or belongs to another ticket: a
        // difference here would tell someone they are getting closer.
        throw ApiError.forbidden('El código del ticket no coincide con este auto');
      }

      let transactionId = null;
      const fee = Number(ticket.fee);
      if (fee > 0) {
        if (req.body.payment_method === 'card') {
          throw ApiError.notImplemented('El cobro con tarjeta llega en la fase 3; por ahora, efectivo');
        }
        if (!req.body.payment_method) {
          throw ApiError.unprocessable('Este club cobra el valet: indica cómo se pagó');
        }
        if (req.body.payment_method === 'cash') {
          const tx = await client.query(
            `INSERT INTO transactions (nightclub_id, type, direction, amount, currency, status,
                                       payer_user_id, provider, reference_type, reference_id,
                                       confirmed_by, confirmed_at)
             VALUES ($1,'valet','in',$2,$3,'paid',$4,'cash','valet_ticket',$5,$6,now())
             RETURNING id`,
            [nightclubId, fee, ticket.currency, ticket.user_id, ticket.id, req.user.id]);
          transactionId = tx.rows[0].id;
        }
      }

      await client.query(
        `UPDATE valet_tickets SET status = 'delivered', delivered_at = now(),
                valet_out_id = $2, transaction_id = $3, updated_at = now()
          WHERE id = $1`,
        [ticketId, req.user.id, transactionId]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    const full = await pool.query(`${TICKET_SELECT} WHERE t.id = $1`, [ticketId]);
    if (full.rows[0].user_id) {
      await events.publish({
        nightclubId,
        type: 'valet_delivered',
        audience: { userIds: [full.rows[0].user_id], roles: ['manager'] },
        payload: { ticket_id: ticketId, code: full.rows[0].code },
      });
    }
    res.json({ ticket: presentTicket(full.rows[0], isManager(req.user) ? 'manager' : 'staff') });
  }));

/**
 * The only door around the QR, and it is the manager's alone. What is recorded is
 * what answers "who took this car": the reason, the kind of ID and the name on it.
 * The document number is never stored — it would add nothing here and be a liability.
 */
router.post('/nightclubs/:nightclubId/valet/tickets/:ticketId/deliver-override',
  requireRole('manager'),
  validate({
    params: z.object({ nightclubId: uuid, ticketId: uuid }),
    body: z.object({
      reason: z.string().trim().min(5).max(200),
      id_type: z.enum(['INE', 'pasaporte', 'licencia', 'otro']),
      id_name: z.string().trim().min(2).max(120),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { nightclubId, ticketId } = req.params;
    const b = req.body;
    const { rows } = await pool.query(
      `UPDATE valet_tickets
          SET status = 'delivered', delivered_at = now(), valet_out_id = $3,
              override_by = $3, override_at = now(), override_reason = $4,
              override_id_type = $5, override_id_name = $6, updated_at = now()
        WHERE id = $1 AND nightclub_id = $2 AND status = ANY($7::text[])
        RETURNING id, user_id, code, plate`,
      [ticketId, nightclubId, req.user.id, b.reason, b.id_type, b.id_name, OPEN]);
    if (rows.length === 0) throw ApiError.conflict('Ese ticket ya está cerrado');

    await pool.query(
      `INSERT INTO audit_log (nightclub_id, actor_id, action, entity, entity_id, after, ip)
       VALUES ($1,$2,'valet_handover_without_qr','valet_ticket',$3,$4,$5)`,
      [nightclubId, req.user.id, ticketId,
        JSON.stringify({
          code: rows[0].code, plate: rows[0].plate, reason: b.reason,
          id_type: b.id_type, id_name: b.id_name,
        }), req.ip || null]);

    await events.publish({
      nightclubId,
      type: 'valet_delivered',
      audience: { roles: ['manager'] },
      payload: { ticket_id: ticketId, code: rows[0].code, without_qr: true },
    });
    const full = await pool.query(`${TICKET_SELECT} WHERE t.id = $1`, [ticketId]);
    res.json({ ticket: presentTicket(full.rows[0], 'manager') });
  }));

router.post('/nightclubs/:nightclubId/valet/tickets/:ticketId/cancel',
  requireRole(...STAND_ROLES),
  validate({
    params: z.object({ nightclubId: uuid, ticketId: uuid }),
    body: z.object({ reason: z.string().trim().min(3).max(160) }),
  }),
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(
      `UPDATE valet_tickets SET status = 'cancelled', cancelled_at = now(),
              cancel_reason = $3, updated_at = now()
        WHERE id = $1 AND nightclub_id = $2 AND status = ANY($4::text[])
        RETURNING id`,
      [req.params.ticketId, req.params.nightclubId, req.body.reason, OPEN]);
    if (rows.length === 0) throw ApiError.conflict('Ese ticket ya está cerrado');
    const full = await pool.query(`${TICKET_SELECT} WHERE t.id = $1`, [req.params.ticketId]);
    res.json({ ticket: presentTicket(full.rows[0], isManager(req.user) ? 'manager' : 'staff') });
  }));

router.get('/nightclubs/:nightclubId/valet/tickets/:ticketId',
  validate({ params: z.object({ nightclubId: uuid, ticketId: uuid }) }),
  asyncHandler(async (req, res) => {
    const { row, viewer } = await loadTicket(req, req.params.ticketId);
    res.json({ ticket: presentTicket(row, viewer) });
  }));

module.exports = router;
