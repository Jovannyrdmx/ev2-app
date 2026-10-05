/**
 * EV2 — el corte de turno de quien cobra (D51).
 *
 * El recorrido completo, en el orden en que pasa de verdad en una noche:
 *
 *   1. El mesero mira cuánto trae (`GET .../shifts/me/cut`). Nadie teclea ese número:
 *      sale de lo que ya cobró.
 *   2. A media noche entrega una parte (`POST .../shifts/me/cash-drops`) y el gerente
 *      la cuenta (`POST .../cash-drops/:id/receive`). Un mesero con doce mil pesos en
 *      la bolsa es un problema de seguridad, no de contabilidad.
 *   3. Al final declara su corte (`POST .../shifts/me/closing`): cuánto entrega.
 *   4. El gerente cuenta y confirma (`POST .../shift-closings/:id/confirm`). Ahí, y
 *      solo ahí, el turno queda cerrado.
 *
 * Quien cobra nunca confirma su propio corte, y quien confirma nunca teclea lo
 * cobrado. Esa separación es el punto entero de este archivo.
 */
'use strict';

const express = require('express');
const { pool } = require('../db/pool');
const { ApiError, asyncHandler } = require('../middleware/errors');
const { validate, z, uuid, pagination } = require('../middleware/validate');
const { authenticate, requireRole, sameNightclub } = require('../middleware/auth');
const cuts = require('../services/shift-closings');
const managerAuth = require('../services/manager-auth');
const tickets = require('../services/tickets');
const events = require('../services/events');
const till = require('../services/till');
const payments = require('../services/payments');

const router = express.Router({ mergeParams: true });

router.use('/nightclubs/:nightclubId', authenticate, sameNightclub());

// El mesero y el bartender siguen aquí aunque desde D77 ya no cobran: un turno que
// cobró antes del cambio todavía tiene que poder hacer su corte.
const STAFF_ROLES = ['waiter', 'bartender', 'hostess', 'cashier', 'manager'];

/** El turno abierto de alguien, o el último que cerró sin corte. */
async function shiftToCut(runner, { nightclubId, userId }) {
  const { rows } = await runner.query(
    `SELECT s.id, s.user_id, s.section, s.started_at, s.ended_at,
            s.location_id, s.opening_float::text AS opening_float
       FROM staff_shifts s
       LEFT JOIN shift_closings c ON c.shift_id = s.id
      WHERE s.nightclub_id = $1 AND s.user_id = $2
        AND (s.ended_at IS NULL OR c.id IS NULL)
      ORDER BY s.started_at DESC
      LIMIT 1`,
    [nightclubId, userId]);
  return rows[0] || null;
}

/** Lo que traigo encima ahora mismo: cobrado, entregado y por entregar. */
router.get('/nightclubs/:nightclubId/shifts/me/cut',
  requireRole(...STAFF_ROLES),
  validate({ params: z.object({ nightclubId: uuid }) }),
  asyncHandler(async (req, res) => {
    const shift = await shiftToCut(pool, {
      nightclubId: req.params.nightclubId, userId: req.user.id,
    });
    if (!shift) {
      // Sin turno no hay corte, pero sí hay respuesta: la pantalla necesita saber que
      // no es un error suyo.
      return res.json({ shift: null, message: 'No tienes un turno abierto' });
    }
    const resumen = await cuts.shiftSummary(pool, {
      nightclubId: req.params.nightclubId, shift,
    });
    return res.json(resumen);
  }));

// ---------------------------------------------------------------- entregas parciales

/**
 * Un retiro parcial de efectivo, autorizado en el acto (D54).
 *
 * Tres cosas y ninguna opcional: cuánto, por qué, y el código de un gerente o un
 * admin tecleado ahí mismo. El código NO abre sesión: autoriza este retiro y nada
 * más, y el aparato sigue siendo del empleado cuando el gerente quita el dedo.
 *
 * Como quien autoriza está presente, el dinero queda recibido y contado en el acto.
 * Dejarlo "pendiente de contar" no tendría sentido: quien lo contaría acaba de
 * firmar que lo tiene en la mano.
 */
router.post('/nightclubs/:nightclubId/shifts/me/cash-drops',
  requireRole(...STAFF_ROLES),
  validate({
    params: z.object({ nightclubId: uuid }),
    body: z.object({
      amount: z.number().positive().max(1_000_000),
      // Pesos o dólares (D86): cada moneda sale de lo que hay de esa moneda.
      currency: z.enum(['MXN', 'USD']).default('MXN'),
      reason: z.string().trim().min(3).max(200),
      manager_pin: z.string().regex(/^\d{6}$/, 'son seis dígitos'),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { nightclubId } = req.params;
    const shift = await shiftToCut(pool, { nightclubId, userId: req.user.id });
    if (!shift || shift.ended_at) {
      throw ApiError.conflict('No tienes un turno abierto: el retiro va dentro del turno');
    }

    // El código se verifica ANTES de tocar nada. Si está mal, no se escribió ni un
    // renglón, y el mensaje no dice por qué está mal.
    const autoriza = await managerAuth.authorize(pool, {
      nightclubId, pin: req.body.manager_pin, selfId: req.user.id, ip: req.ip,
    });

    const client = await pool.connect();
    let hecho;
    try {
      await client.query('BEGIN');
      hecho = await cuts.withdraw(client, {
        nightclubId,
        shift,
        amount: req.body.amount,
        currency: req.body.currency,
        reason: req.body.reason,
        authorizer: autoriza,
      });
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    // El papel del retiro (D81), fuera de la transacción: el retiro ya está hecho.
    let ticket = null;
    try {
      ticket = await tickets.printCashDrop(pool, {
        nightclubId, dropId: hecho.id, userId: req.user.id,
      });
    } catch (err) {
      req.log?.warn?.({ err }, 'no se pudo imprimir el retiro');
    }

    await events.publish({
      nightclubId,
      type: 'cash_withdrawn',
      audience: { roles: ['manager', 'admin'], userIds: [req.user.id] },
      payload: {
        drop_id: hecho.id,
        user_id: req.user.id,
        user_name: req.user.display_name || null,
        amount: hecho.amount,
        currency: hecho.currency,
        reason: req.body.reason,
        authorized_by: autoriza.name,
      },
    });
    res.status(201).json({
      withdrawal: hecho,
      ticket: ticket ? { job_id: ticket.id, status: ticket.status } : null,
    });
  }));

/**
 * Los retiros de efectivo de la noche, con su motivo y quién los autorizó.
 *
 * Es lo que el gerente revisa cuando quiere saber por dónde salió el dinero antes de
 * los cortes. Ya no hay nada que "recibir" aquí: desde D54 un retiro nace autorizado
 * y contado, porque quien lo autoriza está presente.
 */
router.get('/nightclubs/:nightclubId/cash-drops',
  requireRole('manager', 'admin'),
  validate({
    params: z.object({ nightclubId: uuid }),
    query: pagination.extend({
      status: z.enum(['declared', 'received', 'rejected']).optional(),
      hours: z.coerce.number().int().min(1).max(24 * 90).default(24),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT d.id, d.amount::text AS amount, d.counted_amount::text AS counted_amount,
              d.currency, d.note, d.status, d.rejection_reason, d.created_at, d.received_at,
              d.reason, d.authorized_at, d.authorized_role,
              d.user_id, u.display_name AS user_name, u.role,
              r.display_name AS received_by_name,
              a.display_name AS authorized_by_name
         FROM shift_cash_drops d
         JOIN users u ON u.id = d.user_id
         LEFT JOIN users r ON r.id = d.received_by
         LEFT JOIN users a ON a.id = d.authorized_by
        WHERE d.nightclub_id = $1 AND ($2::text IS NULL OR d.status = $2::text)
          AND d.created_at > now() - make_interval(hours => $3)
        ORDER BY d.created_at DESC
        LIMIT $4 OFFSET $5`,
      [req.params.nightclubId, req.query.status || null, req.query.hours,
        req.query.limit, req.query.offset]);
    res.json({ drops: rows });
  }));

// ---------------------------------------------------------------- la caja (D77)

/**
 * Mi caja: la barra que me asignaron esta noche, si ya está abierta, con qué fondo, y
 * los pedidos de esa barra que siguen sin cobrar.
 */
router.get('/nightclubs/:nightclubId/till',
  requireRole('cashier'),
  validate({ params: z.object({ nightclubId: uuid }) }),
  asyncHandler(async (req, res) => {
    res.json(await till.state(pool, { nightclubId: req.params.nightclubId, user: req.user }));
  }));

/**
 * Abrir la caja con su fondo.
 *
 * El cajero teclea el fondo que recibe y el gerente que se lo entrega teclea su
 * código ahí mismo. La barra NO se manda: sale del rol de la noche.
 */
router.post('/nightclubs/:nightclubId/till/open',
  requireRole('cashier'),
  validate({
    params: z.object({ nightclubId: uuid }),
    body: z.object({
      opening_float: z.number().min(0).max(1_000_000),
      currency: z.enum(['MXN', 'USD']).default('MXN'),
      manager_pin: z.string().regex(/^\d{6}$/, 'son seis dígitos'),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { nightclubId } = req.params;
    // La barra se revisa ANTES de gastar un intento de PIN del gerente: sin barra
    // asignada no hay nada que autorizar.
    const asignada = await till.assignedBar(pool, { nightclubId, userId: req.user.id });
    if (!asignada) {
      throw ApiError.unprocessable(
        'No tienes barra asignada para esta noche. El gerente te asigna una en el rol de la noche.');
    }
    const autoriza = await managerAuth.authorize(pool, {
      nightclubId, pin: req.body.manager_pin, selfId: req.user.id, ip: req.ip,
    });

    const client = await pool.connect();
    let abierta;
    try {
      await client.query('BEGIN');
      abierta = await till.open(client, {
        nightclubId,
        userId: req.user.id,
        openingFloat: req.body.opening_float,
        currency: req.body.currency,
        authorizer: autoriza,
      });
      await events.publish({
        nightclubId, type: 'till_opened', client,
        audience: { roles: ['manager', 'admin'], userIds: [req.user.id] },
        payload: {
          shift_id: abierta.shiftId,
          user_id: req.user.id,
          user_name: req.user.display_name || null,
          location_id: abierta.bar.location_id,
          location_name: abierta.bar.location_name,
          opening_float: abierta.openingFloat,
          authorized_by: autoriza.name,
        },
      });
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    res.status(201).json(await till.state(pool, { nightclubId, user: req.user }));
  }));

/**
 * La caja cobra un pedido de su barra, completo o una de sus dos partes (D79).
 *
 * Efectivo o voucher del banco; la terminal de Mercado Pago va por
 * `POST /terminal-charges` con `amount`. Con efectivo, `cash_received` es lo que dio
 * el cliente y el servidor calcula el cambio. Al completarse el pago, el recibo sale
 * solo en la impresora de la caja.
 */
router.post('/nightclubs/:nightclubId/till/payments',
  requireRole('cashier'),
  validate({
    params: z.object({ nightclubId: uuid }),
    body: z.object({
      transaction_id: uuid,
      method: z.enum(['cash', 'cash_usd', 'card_terminal']),
      // En dólares (D86) el monto lo calcula el servidor con el tipo de cambio.
      amount: z.number().positive().max(1_000_000).optional(),
      reference: z.string().trim().min(3).max(60).optional(),
      cash_received: z.number().positive().max(1_000_000).optional(),
      usd_received: z.number().positive().max(100_000).optional(),
      // El tipo de cambio que el cajero vio: si ya no es el vigente, 409.
      exchange_rate_id: z.union([z.string().regex(/^\d+$/), z.number().int().positive()]).optional(),
      client_request_id: uuid.optional(),
    }).refine((b) => b.method === 'cash_usd' || b.amount !== undefined,
      { message: 'Indica el monto a cobrar', path: ['amount'] }),
  }),
  asyncHandler(async (req, res) => {
    const { nightclubId } = req.params;
    const b = req.body;

    // El doble toque: la misma clave devuelve el mismo pago, no cobra otra parte.
    if (b.client_request_id) {
      const ya = await pool.query(
        `SELECT p.id, p.transaction_id, p.method, p.amount::text AS amount,
                p.cash_received::text AS cash_received, p.change_given::text AS change_given,
                p.usd_received::text AS usd_received, p.exchange_rate::text AS exchange_rate,
                t.status AS transaction_status
           FROM manual_payments p JOIN transactions t ON t.id = p.transaction_id
          WHERE p.client_request_id = $1 AND p.nightclub_id = $2`,
        [b.client_request_id, nightclubId]);
      if (ya.rowCount > 0) {
        res.set('Idempotent-Replay', 'true');
        return res.status(200).json({ payment: ya.rows[0], paid: ya.rows[0].transaction_status === 'paid' });
      }
    }

    const client = await pool.connect();
    let hecho;
    try {
      await client.query('BEGIN');
      hecho = await till.collect(client, {
        nightclubId,
        user: req.user,
        transactionId: b.transaction_id,
        method: b.method,
        amount: b.amount ?? null,
        reference: b.reference || null,
        cashReceived: b.cash_received ?? null,
        usdReceived: b.usd_received ?? null,
        exchangeRateId: b.exchange_rate_id === undefined ? null : String(b.exchange_rate_id),
        clientRequestId: b.client_request_id || null,
      });
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    if (hecho.partial) {
      await events.publish({
        nightclubId,
        type: 'payment_partial',
        audience: { roles: ['manager', 'cashier'], userIds: [req.user.id] },
        payload: {
          transaction_id: hecho.tx.id, paid: hecho.paid, remaining: hecho.remaining,
        },
      });
    } else {
      await payments.publishConfirmed({ nightclubId, ...hecho });
    }

    return res.status(201).json({
      payment: hecho.payment,
      paid: !hecho.partial,
      paid_amount: hecho.paid,
      remaining: hecho.remaining,
      change_given: hecho.payment.change_given,
      usd_received: hecho.payment.usd_received || null,
      exchange_rate: hecho.payment.exchange_rate || null,
      receipt: hecho.receipt ? { job_id: hecho.receipt.id, status: hecho.receipt.status } : null,
    });
  }));

/**
 * Las cajas de la noche, para el gerente (D88).
 *
 * Solo lectura: cada caja que abrió en las últimas 18 horas, con su barra, quién la
 * tiene, el fondo, lo cobrado hasta ahora y lo que debe tener en el cajón — pesos y,
 * aparte, dólares —, y si ya hizo corte, con su diferencia. Es la pregunta que el
 * gerente se hace a media noche y que antes solo podía contestar yendo a cada barra.
 */
router.get('/nightclubs/:nightclubId/tills',
  requireRole('manager'),
  validate({ params: z.object({ nightclubId: uuid }) }),
  asyncHandler(async (req, res) => {
    const { nightclubId } = req.params;
    const { rows } = await pool.query(
      `SELECT s.id, s.user_id, s.section, s.started_at, s.ended_at, s.location_id,
              s.opening_float::text AS opening_float, s.float_currency AS currency,
              u.display_name AS user_name, l.name AS location_name,
              c.id AS closing_id, c.difference::text AS difference,
              c.difference_usd::text AS difference_usd, c.confirmed_at
         FROM staff_shifts s
         JOIN users u ON u.id = s.user_id
         JOIN supply_locations l ON l.id = s.location_id
         LEFT JOIN shift_closings c ON c.shift_id = s.id
        WHERE s.nightclub_id = $1 AND s.location_id IS NOT NULL
          AND s.started_at > now() - interval '18 hours'
        ORDER BY l.name, s.started_at`,
      [nightclubId]);
    const tills = [];
    for (const s of rows) {
      // Una caja tras otra: son pocas por noche y así no se acapara el pool.
      const resumen = await cuts.shiftSummary(pool, { nightclubId, shift: s });
      tills.push({
        shift_id: s.id,
        location_id: s.location_id,
        location_name: s.location_name,
        user_id: s.user_id,
        user_name: s.user_name,
        started_at: s.started_at,
        ended_at: s.ended_at,
        currency: s.currency || resumen.totals.currency,
        opening_float: resumen.opening_float,
        collected: resumen.totals.total_collected,
        cash_collected: resumen.totals.cash_collected,
        cash_to_hand: resumen.cash_to_hand,
        usd_received: resumen.totals.usd.received,
        usd_to_hand: resumen.usd_to_hand,
        drops_received: resumen.drops_received,
        pending_orders: (resumen.pending_orders || []).length,
        pending_total: resumen.pending_total,
        closed: Boolean(s.closing_id),
        difference: s.difference,
        difference_usd: s.difference_usd,
        closed_at: s.confirmed_at,
      });
    }
    res.json({ tills });
  }));

// ---------------------------------------------------------------- el corte

/**
 * El corte del turno, en un solo acto (D54).
 *
 * El empleado declara lo que entrega, el gerente cuenta delante de él y teclea su
 * código, y el turno queda cerrado. Antes eran dos pasos y el dueño pidió que fuera
 * uno, porque en la barra es uno: el gerente ya está parado ahí con el dinero.
 *
 * El ticket se imprime DESPUÉS de cerrar, fuera de la transacción: el corte ya es
 * definitivo, y si la impresora falla lo que hay que resolver es la impresora, no
 * deshacer el cierre. Por eso la respuesta dice aparte si el papel salió.
 */
router.post('/nightclubs/:nightclubId/shifts/me/closing',
  requireRole(...STAFF_ROLES),
  validate({
    params: z.object({ nightclubId: uuid }),
    body: z.object({
      declared_cash: z.number().min(0).max(1_000_000),
      counted_cash: z.number().min(0).max(1_000_000),
      // Los dólares del cajón (D86). Obligatorio solo si el turno recibió dólares.
      counted_usd: z.number().min(0).max(1_000_000).optional(),
      difference_reason: z.string().trim().max(280).optional(),
      notes: z.string().trim().max(280).optional(),
      manager_pin: z.string().regex(/^\d{6}$/, 'son seis dígitos'),
      // La caja con pedidos sin cobrar solo se cierra si el gerente que teclea su
      // código lo acepta expresamente (D77).
      acknowledge_pending: z.boolean().default(false),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { nightclubId } = req.params;
    const shift = await shiftToCut(pool, { nightclubId, userId: req.user.id });
    if (!shift) throw ApiError.conflict('No tienes un turno que cortar');

    const autoriza = await managerAuth.authorize(pool, {
      nightclubId, pin: req.body.manager_pin, selfId: req.user.id, ip: req.ip,
    });

    const client = await pool.connect();
    let hecho;
    try {
      await client.query('BEGIN');
      hecho = await cuts.close(client, {
        nightclubId,
        shift,
        role: req.user.role,
        declaredCash: req.body.declared_cash,
        countedCash: req.body.counted_cash,
        reason: req.body.difference_reason,
        notes: req.body.notes,
        authorizer: autoriza,
        acknowledgePending: req.body.acknowledge_pending,
        countedUsd: req.body.counted_usd ?? null,
      });
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    await events.publish({
      nightclubId,
      type: 'shift_closed',
      audience: { roles: ['manager', 'admin'], userIds: [req.user.id] },
      payload: {
        closing_id: hecho.id,
        user_id: req.user.id,
        user_name: req.user.display_name || null,
        expected_cash: hecho.expected_cash,
        counted_cash: hecho.counted_cash,
        difference: hecho.difference,
        difference_usd: hecho.difference_usd,
        opening_float: hecho.opening_float,
        pending_orders: hecho.pending_orders,
        pending_total: hecho.pending_total,
        authorized_by: autoriza.name,
      },
    });

    // El papel. Si no sale, el corte sigue hecho y la respuesta lo dice: el gerente
    // reimprime desde su panel cuando la impresora vuelva.
    let ticket = null;
    try {
      ticket = await tickets.printShiftCut(pool, {
        nightclubId, closingId: hecho.id, userId: req.user.id,
      });
    } catch (err) {
      req.log?.warn?.({ err }, 'no se pudo imprimir el corte');
    }

    const { rows } = await pool.query(`${CLOSING_SELECT} WHERE c.id = $1`, [hecho.id]);
    res.status(201).json({
      closing: rows[0],
      ticket: ticket ? { job_id: ticket.id, status: ticket.status } : null,
    });
  }));

const CLOSING_SELECT = `
  SELECT c.id, c.shift_id, c.user_id, c.role, c.started_at, c.ended_at, c.currency,
         c.totals, c.cash_collected::text AS cash_collected,
         c.drops_total::text AS drops_total, c.expected_cash::text AS expected_cash,
         c.declared_cash::text AS declared_cash, c.declared_notes, c.declared_at,
         c.counted_cash::text AS counted_cash, c.difference::text AS difference,
         c.difference_reason, c.status, c.confirmed_at,
         c.authorized_at, c.authorized_role, c.ticket_job_id,
         c.location_id, l.name AS location_name, c.opening_float::text AS opening_float,
         c.pending_orders, c.pending_total::text AS pending_total,
         c.usd_collected::text AS usd_collected, c.usd_change_given::text AS usd_change_given,
         c.usd_drops_total::text AS usd_drops_total, c.expected_usd::text AS expected_usd,
         c.counted_usd::text AS counted_usd, c.difference_usd::text AS difference_usd,
         u.display_name AS user_name, m.display_name AS confirmed_by_name,
         a.display_name AS authorized_by_name
    FROM shift_closings c
    JOIN users u ON u.id = c.user_id
    LEFT JOIN users m ON m.id = c.confirmed_by
    LEFT JOIN users a ON a.id = c.authorized_by
    LEFT JOIN supply_locations l ON l.id = c.location_id`;

router.get('/nightclubs/:nightclubId/shift-closings',
  requireRole('manager'),
  validate({
    params: z.object({ nightclubId: uuid }),
    query: pagination.extend({
      status: z.enum(['declared', 'confirmed']).optional(),
      hours: z.coerce.number().int().min(1).max(24 * 90).default(24),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(
      `${CLOSING_SELECT}
        WHERE c.nightclub_id = $1
          AND ($2::text IS NULL OR c.status = $2::text)
          AND c.declared_at > now() - make_interval(hours => $3)
        ORDER BY c.status = 'declared' DESC, c.declared_at DESC
        LIMIT $4 OFFSET $5`,
      [req.params.nightclubId, req.query.status || null, req.query.hours,
        req.query.limit, req.query.offset]);
    res.json({ closings: rows });
  }));

router.get('/nightclubs/:nightclubId/shift-closings/:closingId',
  requireRole(...STAFF_ROLES),
  validate({ params: z.object({ nightclubId: uuid, closingId: uuid }) }),
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(
      `${CLOSING_SELECT} WHERE c.id = $1 AND c.nightclub_id = $2`,
      [req.params.closingId, req.params.nightclubId]);
    if (rows.length === 0) throw ApiError.notFound('Ese corte no existe');
    const corte = rows[0];
    // El suyo lo ve cualquiera; el de los demás, solo quien manda.
    const esGerente = ['manager', 'admin'].includes(req.user.role);
    if (!esGerente && corte.user_id !== req.user.id) throw ApiError.forbidden('Ese corte no es tuyo');
    res.json({ closing: corte, drops: await cuts.dropsOf(pool, corte.shift_id) });
  }));

/**
 * Reimprimir el ticket de un corte.
 *
 * Saca EXACTAMENTE el mismo papel: el ticket se arma de nuevo con el renglón del
 * corte, que quedó congelado al cerrarlo. Dos días después, con esa persona habiendo
 * cobrado mil pesos más, el papel dice lo mismo que dijo esa noche.
 */
router.post('/nightclubs/:nightclubId/shift-closings/:closingId/ticket',
  requireRole('manager', 'admin'),
  validate({ params: z.object({ nightclubId: uuid, closingId: uuid }) }),
  asyncHandler(async (req, res) => {
    const job = await tickets.printShiftCut(pool, {
      nightclubId: req.params.nightclubId,
      closingId: req.params.closingId,
      userId: req.user.id,
    });
    if (!job) {
      throw ApiError.badRequest(
        'No hay una impresora de cuentas para la zona de ese turno, o el corte no existe');
    }
    res.status(202).json({ job });
  }));

module.exports = router;
