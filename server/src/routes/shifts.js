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
const manualVoucher = require('../services/manual-voucher');
const cashDrawer = require('../services/cash-drawer');
const tickets = require('../services/tickets');
const printing = require('../services/printing');
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
            s.location_id, s.till_id, s.opening_float::text AS opening_float,
            s.opening_float_usd::text AS opening_float_usd
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
    // A ciegas para quien maneja el efectivo (D105).
    return res.json(cuts.forEmployee(resumen, req.user.role));
  }));

/**
 * Corte a ciegas, primer paso (D105): la persona cuenta su cajón y guarda lo que contó
 * sin haber visto lo esperado. Queda escrito y no se cambia; después el gerente cuenta
 * delante de ella, teclea su código y cierra el corte.
 */
router.post('/nightclubs/:nightclubId/shifts/me/declaration',
  requireRole(...STAFF_ROLES),
  validate({
    params: z.object({ nightclubId: uuid }),
    body: z.object({
      declared_cash: z.number().min(0).max(1_000_000),
      declared_usd: z.number().min(0).max(1_000_000).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { nightclubId } = req.params;
    const shift = await shiftToCut(pool, { nightclubId, userId: req.user.id });
    if (!shift) throw ApiError.conflict('No tienes un turno que cortar');
    const client = await pool.connect();
    let hecha;
    try {
      await client.query('BEGIN');
      hecha = await cuts.declare(client, {
        nightclubId, shift,
        declaredCash: req.body.declared_cash,
        declaredUsd: req.body.declared_usd ?? null,
      });
      await client.query(
        `INSERT INTO audit_log (nightclub_id, actor_id, action, entity, entity_id, after, ip)
         VALUES ($1,$2,'shift.blind_declaration','staff_shift',$3,$4,$5)`,
        [nightclubId, req.user.id, shift.id, JSON.stringify(hecha), req.ip || null]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    res.status(201).json({ declaration: hecha });
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
    let hecho; let drawer = null;
    try {
      await client.query('BEGIN');
      hecho = await cuts.withdraw(client, {
        nightclubId,
        shift,
        amount: req.body.amount,
        currency: req.body.currency,
        reason: req.body.reason,
        authorizer: autoriza,
        role: req.user.role,
      });
      // De una caja (D122): el cajón se abre solo para sacar el dinero.
      if (shift.location_id) {
        const caja = await till.openTill(client, { nightclubId, userId: req.user.id });
        const printer = await cashDrawer.printerForTill(client, { nightclubId, caja });
        drawer = await cashDrawer.open(client, {
          nightclubId, printer, refId: hecho.id, createdBy: req.user.id,
          reason: `retiro de efectivo ${hecho.amount} ${hecho.currency}`,
        });
      }
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
      drawer,
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

// ---------------------------------------------------------------- la caja (D77, D118)

/** Quienes tienen caja: el cajero en su barra y la anfitriona en Cover (D118). */
const TILL_ROLES = till.TILL_ROLES;

/**
 * Mi caja: el lugar que me asignaron esta noche (barra o Cover), si ya está abierta,
 * con qué fondo, y —en una barra— los pedidos que siguen sin cobrar.
 */
router.get('/nightclubs/:nightclubId/till',
  requireRole(...TILL_ROLES),
  validate({ params: z.object({ nightclubId: uuid }) }),
  asyncHandler(async (req, res) => {
    res.json(await till.state(pool, { nightclubId: req.params.nightclubId, user: req.user }));
  }));

/**
 * Abrir la caja con su fondo.
 *
 * Quien abre teclea el fondo que recibe —en pesos y, si le dan, en dólares— y el
 * gerente que se lo entrega teclea su código ahí mismo. El lugar NO se manda: sale
 * del rol de la noche (barra para el cajero, Cover para la anfitriona).
 */
router.post('/nightclubs/:nightclubId/till/open',
  requireRole(...TILL_ROLES),
  validate({
    params: z.object({ nightclubId: uuid }),
    body: z.object({
      opening_float: z.number().min(0).max(1_000_000),
      // Los dólares del fondo (D118). Opcional: hay cajas que abren solo con pesos.
      opening_float_usd: z.number().min(0).max(100_000).optional(),
      currency: z.enum(['MXN', 'USD']).default('MXN'),
      manager_pin: z.string().regex(/^\d{6}$/, 'son seis dígitos'),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { nightclubId } = req.params;
    // El lugar se revisa ANTES de gastar un intento de PIN del gerente: sin lugar
    // asignado no hay nada que autorizar.
    const asignada = await till.assignedTill(pool, {
      nightclubId, userId: req.user.id, role: req.user.role,
    });
    if (!asignada) throw ApiError.unprocessable(till.noAssignmentMessage(req.user.role));
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
        role: req.user.role,
        openingFloat: req.body.opening_float,
        openingFloatUsd: req.body.opening_float_usd ?? null,
        currency: req.body.currency,
        authorizer: autoriza,
      });
      // Queda escrito quién abrió, dónde, con cuánto y quién entregó el fondo.
      await client.query(
        `INSERT INTO audit_log (nightclub_id, actor_id, action, entity, entity_id, after, ip)
         VALUES ($1,$2,'till.open','staff_shift',$3,$4,$5)`,
        [nightclubId, req.user.id, abierta.shiftId, JSON.stringify({
          location_id: abierta.location.location_id,
          location_name: abierta.location.location_name,
          location_kind: abierta.location.location_kind,
          opening_float: abierta.openingFloat,
          opening_float_usd: abierta.openingFloatUsd,
          authorized_by: autoriza.id,
          attached_to_shift: abierta.attachedToShift,
        }), req.ip || null]);
      // El fondo entra al cajón (D122): se abre solo, si hay fondo que meter.
      if (Number(abierta.openingFloat) > 0 || Number(abierta.openingFloatUsd) > 0) {
        const printer = await cashDrawer.printerForTill(client, {
          nightclubId, caja: abierta.location,
        });
        abierta.drawer = await cashDrawer.open(client, {
          nightclubId, printer, refId: abierta.shiftId, createdBy: req.user.id,
          reason: 'apertura de caja: fondo',
        });
      }
      // Si es la caja de Cover, las demás anfitrionas también se enteran: desde ese
      // momento ellas escanean y no cobran (D118).
      const puerta = abierta.location.location_kind === 'door';
      await events.publish({
        nightclubId, type: 'till_opened', client,
        audience: { roles: puerta ? ['manager', 'admin', 'hostess'] : ['manager', 'admin'], userIds: [req.user.id] },
        payload: {
          shift_id: abierta.shiftId,
          user_id: req.user.id,
          user_name: req.user.display_name || null,
          location_id: abierta.location.location_id,
          location_name: abierta.location.location_name,
          location_kind: abierta.location.location_kind,
          opening_float: abierta.openingFloat,
          opening_float_usd: abierta.openingFloatUsd,
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
    res.status(201).json({
      ...(await till.state(pool, { nightclubId, user: req.user })),
      drawer: abierta.drawer || null,
    });
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
      method: z.enum(['cash', 'cash_usd', 'card_terminal', 'vip_credit']),
      // En dólares (D86) el monto lo calcula el servidor con el tipo de cambio.
      amount: z.number().positive().max(1_000_000).optional(),
      reference: z.string().trim().min(3).max(60).optional(),
      cash_received: z.number().positive().max(1_000_000).optional(),
      usd_received: z.number().positive().max(100_000).optional(),
      // El tipo de cambio que el cajero vio: si ya no es el vigente, 409.
      exchange_rate_id: z.union([z.string().regex(/^\d+$/), z.number().int().positive()]).optional(),
      client_request_id: uuid.optional(),
      // El voucher tecleado a mano (D107): PIN de un gerente y por qué no fue terminal.
      manager_pin: z.string().regex(/^\d{6}$/, 'son seis dígitos').optional(),
      voucher_reason: z.string().trim().max(200).optional(),
    }).refine((b) => ['cash_usd', 'vip_credit'].includes(b.method) || b.amount !== undefined,
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

    // El voucher manual se autoriza ANTES de abrir la transacción (D107).
    const autorizaVoucher = await manualVoucher.authorize(pool, {
      nightclubId, user: req.user, method: b.method,
      pin: b.manager_pin, reason: b.voucher_reason, ip: req.ip,
    });

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
      await manualVoucher.record(client, {
        nightclubId, paymentId: hecho.payment.id, user: req.user, authorizer: autorizaVoucher, ip: req.ip,
      });
      // Efectivo: el cajón de esta caja se abre solo (D96), en la misma transacción
      // que asienta el cobro.
      if (cashDrawer.opensDrawer(b.method)) {
        const printer = await cashDrawer.tillPrinter(client, {
          nightclubId,
          locationId: hecho.till && hecho.till.location_id,
          tillId: hecho.till && hecho.till.till_id,
        });
        hecho.drawer = await cashDrawer.open(client, {
          nightclubId, printer, refId: hecho.tx.id, createdBy: req.user.id,
          reason: `cobro en efectivo ${hecho.payment.amount} ${hecho.payment.currency || ''}`.trim(),
        });
      }
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
      drawer: hecho.drawer || null,
    });
  }));

/**
 * Cobrar de un jalón todo lo que un mesero entregó y no ha pagado (D112).
 *
 * El mesero llega con el dinero de varias mesas. En vez de cobrar pedido por pedido,
 * la caja le cobra en efectivo lo entregado en una sola operación: un solo monto
 * recibido, un solo cambio, un solo pulso del cajón. Cada pedido se asienta como su
 * propio cobro (mismo libro, mismo recibo) y todo va en una transacción: o se cobra
 * todo o no se cobra nada. Solo efectivo y solo pedidos entregados sin pago previo.
 */
router.post('/nightclubs/:nightclubId/till/payments/batch',
  requireRole('cashier'),
  validate({
    params: z.object({ nightclubId: uuid }),
    body: z.object({
      waiter_id: uuid,
      cash_received: z.number().positive().max(1_000_000),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { nightclubId } = req.params;
    const caja = await till.openTill(pool, { nightclubId, userId: req.user.id });
    if (!caja) throw ApiError.conflict('Abre tu caja antes de cobrar');

    const cents = (n) => Math.round(Number(n) * 100);
    const money = (c) => (c / 100).toFixed(2);

    const client = await pool.connect();
    const hechos = [];
    let drawer = null;
    let total = 0;
    try {
      await client.query('BEGIN');
      const pedidos = (await till.pendingOrders(client, { nightclubId, locationId: caja.location_id }))
        .filter((o) => o.taken_by === req.body.waiter_id && o.status === 'delivered'
          && cents(o.paid_amount) === 0 && o.payment_status !== 'pending_manual');
      if (pedidos.length === 0) {
        throw ApiError.unprocessable('Ese mesero no tiene pedidos entregados por cobrar en tu barra');
      }
      if (new Set(pedidos.map((o) => o.currency)).size > 1) {
        throw ApiError.unprocessable('Los pedidos están en monedas distintas; cóbralos por separado');
      }
      total = pedidos.reduce((a, o) => a + cents(o.remaining), 0);
      const recibido = cents(req.body.cash_received);
      if (recibido < total) {
        throw ApiError.unprocessable(
          `Recibiste ${money(recibido)} y lo entregado suma ${money(total)}: faltan ${money(total - recibido)}.`,
          { cash_received: money(recibido), total: money(total) });
      }
      let acumulado = 0;
      for (let i = 0; i < pedidos.length; i += 1) {
        const o = pedidos[i];
        const monto = cents(o.remaining);
        const esUltimo = i === pedidos.length - 1;
        // El cambio sale en el último cobro: ahí se junta todo lo recibido de más.
        const recibidoAqui = esUltimo ? recibido - acumulado : monto;
        // eslint-disable-next-line no-await-in-loop
        hechos.push(await till.collect(client, {
          nightclubId, user: req.user, transactionId: o.transaction_id, method: 'cash',
          amount: Number(money(monto)), cashReceived: Number(money(recibidoAqui)),
        }));
        acumulado += monto;
      }
      const printer = await cashDrawer.tillPrinter(client, {
        nightclubId, locationId: caja.location_id, tillId: caja.till_id,
      });
      drawer = await cashDrawer.open(client, {
        nightclubId, printer, refId: hechos[0].tx.id, createdBy: req.user.id,
        reason: `cobro por lote de ${pedidos.length} pedidos, ${money(total)}`,
      });
      await client.query(
        `INSERT INTO audit_log (nightclub_id, actor_id, action, entity, after, ip)
         VALUES ($1,$2,'payment.batch_collect','user',$3,$4)`,
        [nightclubId, req.user.id, JSON.stringify({
          waiter_id: req.body.waiter_id, orders: pedidos.length, total: money(total),
          cash_received: money(recibido),
        }), req.ip || null]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    for (const h of hechos) {
      // eslint-disable-next-line no-await-in-loop
      await payments.publishConfirmed({ nightclubId, ...h });
    }
    return res.status(201).json({
      orders: hechos.length,
      total: money(total),
      cash_received: money(cents(req.body.cash_received)),
      change_given: money(cents(req.body.cash_received) - total),
      drawer,
    });
  }));

/**
 * Abrir el cajón sin cobrar (D96): para dar cambio, cambiar un billete o contar.
 *
 * Lo pide quien tiene el cajón —el cajero en su caja, la anfitriona en la puerta— y lo
 * autoriza un gerente con su PIN (nunca él mismo). Cada apertura queda en `audit_log`
 * con el motivo, porque un cajón que se abre sin venta es justo lo que se revisa
 * cuando el corte no cuadra.
 */
router.post('/nightclubs/:nightclubId/cash-drawer/open',
  requireRole('cashier', 'hostess'),
  validate({
    params: z.object({ nightclubId: uuid }),
    body: z.object({
      reason: z.string().trim().min(3).max(200),
      manager_pin: z.string().regex(/^\d{6}$/, 'son seis dígitos'),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { nightclubId } = req.params;
    // El cajón es de quien tiene la caja abierta: el cajero en su barra, la anfitriona
    // en Cover (D118). Sin caja abierta no hay cajón que abrir.
    let printer;
    if (req.user.role === 'cashier') {
      const caja = await till.openTill(pool, { nightclubId, userId: req.user.id });
      if (!caja) throw ApiError.conflict('No tienes la caja abierta');
      printer = await cashDrawer.tillPrinter(pool, {
        nightclubId, locationId: caja.location_id, tillId: caja.till_id,
      });
    } else {
      const caja = await till.assertDoorTill(pool, { nightclubId, user: req.user });
      printer = await cashDrawer.doorPrinter(pool, {
        nightclubId, locationId: caja.location_id, tillId: caja.till_id,
      });
    }
    if (!printer || !printer.drawer_pin) {
      throw ApiError.unprocessable('Esta caja no tiene cajón configurado. El gerente lo da de alta en Impresoras.');
    }

    const autoriza = await managerAuth.authorize(pool, {
      nightclubId, pin: req.body.manager_pin, selfId: req.user.id, ip: req.ip,
    });

    const client = await pool.connect();
    let drawer;
    try {
      await client.query('BEGIN');
      drawer = await cashDrawer.open(client, {
        nightclubId, printer, createdBy: req.user.id,
        reason: `sin venta: ${req.body.reason} (autorizó ${autoriza.name || 'gerente'})`,
      });
      await client.query(
        `INSERT INTO audit_log (nightclub_id, actor_id, action, entity, entity_id, after, ip)
         VALUES ($1,$2,'cash_drawer.open_no_sale','printer',$3,$4,$5)`,
        [nightclubId, req.user.id, printer.id,
          JSON.stringify({ reason: req.body.reason, authorized_by: autoriza.id, job_id: drawer.job_id }),
          req.ip || null]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    res.status(201).json({ drawer, authorized_by: autoriza.name || null });
  }));

// ---------------------------------------------------------------- entrada de efectivo (D122)

/** La impresora con cajón de una caja abierta: la de la barra o la de Cover. */
const drawerPrinterOf = (runner, { nightclubId, caja }) => cashDrawer.printerForTill(runner, { nightclubId, caja });

/**
 * Meter efectivo a la caja abierta (D122): reponer fondo o traer cambio a media noche.
 *
 * Como el retiro: cuánto, por qué y el PIN de un gerente que no sea quien recibe. El
 * cajón se abre solo para meter el dinero, sale el ticket con las dos firmas, y lo
 * que entró suma a lo que la caja debe entregar en su corte.
 */
router.post('/nightclubs/:nightclubId/shifts/me/cash-ins',
  requireRole(...TILL_ROLES),
  validate({
    params: z.object({ nightclubId: uuid }),
    body: z.object({
      amount: z.number().positive().max(1_000_000),
      currency: z.enum(['MXN', 'USD']).default('MXN'),
      reason: z.string().trim().min(3).max(200),
      manager_pin: z.string().regex(/^\d{6}$/, 'son seis dígitos'),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { nightclubId } = req.params;
    const caja = await till.openTill(pool, { nightclubId, userId: req.user.id });
    if (!caja) throw ApiError.conflict('No tienes la caja abierta');

    const autoriza = await managerAuth.authorize(pool, {
      nightclubId, pin: req.body.manager_pin, selfId: req.user.id, ip: req.ip,
    });
    const printer = await drawerPrinterOf(pool, { nightclubId, caja });

    const client = await pool.connect();
    let hecho; let drawer;
    try {
      await client.query('BEGIN');
      hecho = await cuts.addCash(client, {
        nightclubId, shift: caja, amount: req.body.amount, currency: req.body.currency,
        reason: req.body.reason, authorizer: autoriza,
      });
      drawer = await cashDrawer.open(client, {
        nightclubId, printer, refId: hecho.id, createdBy: req.user.id,
        reason: `entrada de efectivo ${hecho.amount} ${hecho.currency}`,
      });
      await client.query(
        `INSERT INTO audit_log (nightclub_id, actor_id, action, entity, entity_id, after, ip)
         VALUES ($1,$2,'till.cash_in','shift_cash_in',$3,$4,$5)`,
        [nightclubId, req.user.id, hecho.id,
          JSON.stringify({ amount: hecho.amount, currency: hecho.currency, reason: hecho.reason,
            authorized_by: autoriza.id, shift_id: caja.id }),
          req.ip || null]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    // El papel, fuera de la transacción: la entrada ya está hecha.
    let ticket = null;
    try {
      ticket = await tickets.printCashIn(pool, { nightclubId, cashInId: hecho.id, userId: req.user.id });
    } catch (err) {
      req.log?.warn?.({ err }, 'no se pudo imprimir la entrada de efectivo');
    }
    await events.publish({
      nightclubId,
      type: 'cash_added',
      audience: { roles: ['manager', 'admin'], userIds: [req.user.id] },
      payload: {
        cash_in_id: hecho.id, user_id: req.user.id, user_name: req.user.display_name || null,
        amount: hecho.amount, currency: hecho.currency, reason: hecho.reason,
        authorized_by: autoriza.name,
      },
    });
    res.status(201).json({
      cash_in: hecho,
      drawer,
      ticket: ticket ? { job_id: ticket.id, status: ticket.status } : null,
    });
  }));

// ---------------------------------------------------------------- corte X (D122)

/** Imprime el corte X de un turno de caja y deja la huella en `audit_log`. */
async function xReport(req, { caja, userName, role, authorizer }) {
  const { nightclubId } = req.params;
  const summary = await cuts.shiftSummary(pool, { nightclubId, shift: caja });
  if (summary.closing) throw ApiError.conflict('Esa caja ya tiene su corte hecho');
  const job = await tickets.printXReport(pool, {
    nightclubId, summary, locationId: caja.location_id,
    locationName: caja.till_name || caja.location_name, tillId: caja.till_id || null,
    userName, role, authorizedBy: authorizer.name || null, userId: req.user.id,
  });
  if (!job) {
    throw ApiError.unprocessable('Esa caja no tiene impresora para el corte X. Dala de alta en Impresoras.');
  }
  await pool.query(
    `INSERT INTO audit_log (nightclub_id, actor_id, action, entity, entity_id, after, ip)
     VALUES ($1,$2,'till.x_report','staff_shift',$3,$4,$5)`,
    [nightclubId, req.user.id, caja.id,
      JSON.stringify({ authorized_by: authorizer.id, job_id: job.id }), req.ip || null]);
  return job;
}

/**
 * Corte X desde la pantalla de la caja, con el PIN del gerente (D122).
 *
 * El papel trae lo que la caja debe tener ahora, así que el cajero no lo puede sacar
 * solo: sería ver el esperado antes de contar (D105). La respuesta no trae números.
 */
router.post('/nightclubs/:nightclubId/till/x-report',
  requireRole(...TILL_ROLES),
  validate({
    params: z.object({ nightclubId: uuid }),
    body: z.object({ manager_pin: z.string().regex(/^\d{6}$/, 'son seis dígitos') }),
  }),
  asyncHandler(async (req, res) => {
    const { nightclubId } = req.params;
    const caja = await till.openTill(pool, { nightclubId, userId: req.user.id });
    if (!caja) throw ApiError.conflict('No tienes la caja abierta');
    const autoriza = await managerAuth.authorize(pool, {
      nightclubId, pin: req.body.manager_pin, selfId: req.user.id, ip: req.ip,
    });
    const job = await xReport(req, {
      caja, userName: req.user.display_name, role: req.user.role, authorizer: autoriza,
    });
    res.status(202).json({ job: { id: job.id, status: job.status }, authorized_by: autoriza.name || null });
  }));

/** Corte X de cualquier caja abierta, desde el panel del gerente (D122). */
router.post('/nightclubs/:nightclubId/tills/:shiftId/x-report',
  requireRole('manager', 'admin'),
  validate({ params: z.object({ nightclubId: uuid, shiftId: uuid }) }),
  asyncHandler(async (req, res) => {
    const { nightclubId, shiftId } = req.params;
    const { rows } = await pool.query(
      `SELECT s.id, s.user_id, s.section, s.started_at, s.ended_at, s.location_id,
              s.opening_float::text AS opening_float, s.opening_float_usd::text AS opening_float_usd,
              l.name AS location_name, l.kind AS location_kind,
              s.till_id, tt.name AS till_name,
              u.display_name AS user_name, u.role
         FROM staff_shifts s
         JOIN supply_locations l ON l.id = s.location_id
         LEFT JOIN tills tt ON tt.id = s.till_id
         JOIN users u ON u.id = s.user_id
        WHERE s.id = $1 AND s.nightclub_id = $2 AND s.location_id IS NOT NULL`,
      [shiftId, nightclubId]);
    const caja = rows[0];
    if (!caja) throw ApiError.notFound('Esa caja no existe');
    const job = await xReport(req, {
      caja, userName: caja.user_name, role: caja.role,
      authorizer: { id: req.user.id, name: req.user.display_name || null },
    });
    res.status(202).json({ job: { id: job.id, status: job.status } });
  }));

// ---------------------------------------------------------------- copia de un recibo (D122)

/** Los recibos que esta caja imprimió en el turno abierto, para reimprimir una copia. */
async function receiptsOfTill(runner, { nightclubId, caja, jobId = null }) {
  // Solo recibos de un cobro (ref = un renglón del libro): el ticket de acceso del
  // cover no se reimprime, porque una copia sería otra entrada.
  const { rows } = await runner.query(
    `SELECT j.id::text AS id, j.created_at, j.status, j.ref_id::text AS transaction_id,
            j.printer_id::text AS printer_id, j.preview, j.payload,
            tx.amount::text AS amount, tx.currency, tx.type
       FROM print_jobs j
       JOIN transactions tx ON tx.id = j.ref_id AND tx.nightclub_id = j.nightclub_id
      WHERE j.nightclub_id = $1 AND j.kind = 'receipt' AND j.created_by = $2
        AND j.created_at >= $3 AND ($4::uuid IS NULL OR j.id = $4::uuid)
      ORDER BY j.created_at DESC
      LIMIT 30`,
    [nightclubId, caja.user_id, caja.started_at, jobId]);
  return rows;
}

router.get('/nightclubs/:nightclubId/till/receipts',
  requireRole(...TILL_ROLES),
  validate({ params: z.object({ nightclubId: uuid }) }),
  asyncHandler(async (req, res) => {
    const { nightclubId } = req.params;
    const caja = await till.openTill(pool, { nightclubId, userId: req.user.id });
    if (!caja) return res.json({ receipts: [] });
    const rows = await receiptsOfTill(pool, { nightclubId, caja });
    // Las copias ya impresas (empiezan con el aviso de copia) no se listan.
    const receipts = rows.filter((r) => !String(r.preview || '').includes('** COPIA'))
      .map((r) => ({
        id: r.id, created_at: r.created_at, status: r.status, transaction_id: r.transaction_id,
        folio: tickets.folio(r.transaction_id), amount: r.amount, currency: r.currency, type: r.type,
      }));
    return res.json({ receipts });
  }));

/**
 * Una copia del recibo, para el cajero (D122): solo de su caja abierta y de este
 * turno, marcada como COPIA con su nombre y la hora, y anotada en `audit_log`.
 */
router.post('/nightclubs/:nightclubId/till/receipts/:jobId/reprint',
  requireRole(...TILL_ROLES),
  validate({ params: z.object({ nightclubId: uuid, jobId: uuid }) }),
  asyncHandler(async (req, res) => {
    const { nightclubId, jobId } = req.params;
    const caja = await till.openTill(pool, { nightclubId, userId: req.user.id });
    if (!caja) throw ApiError.conflict('No tienes la caja abierta');
    const [job] = await receiptsOfTill(pool, { nightclubId, caja, jobId });
    if (!job) throw ApiError.notFound('Ese recibo no es de tu caja en este turno');
    if (String(job.preview || '').includes('** COPIA')) {
      throw ApiError.badRequest('Eso ya es una copia: reimprime el recibo original');
    }
    const copia = await tickets.reprintReceiptCopy(pool, { nightclubId, job, userId: req.user.id });
    if (!copia) throw ApiError.unprocessable('La impresora de ese recibo ya no está activa');
    await pool.query(
      `INSERT INTO audit_log (nightclub_id, actor_id, action, entity, entity_id, after, ip)
       VALUES ($1,$2,'receipt.reprint','print_job',$3,$4,$5)`,
      [nightclubId, req.user.id, job.id,
        JSON.stringify({ copy_job_id: copia.id, transaction_id: job.transaction_id }), req.ip || null]);
    res.status(202).json({ job: { id: copia.id, status: copia.status } });
  }));

/**
 * Las cajas de la noche, para el gerente (D88, D118).
 *
 * Solo lectura: cada caja que abrió en las últimas 18 horas —las barras y Cover—,
 * con su lugar, quién la
 * tiene, el fondo, lo cobrado hasta ahora y lo que debe tener en el cajón — pesos y,
 * aparte, dólares —, y si ya hizo corte, con su diferencia. Es la pregunta que el
 * gerente se hace a media noche y que antes solo podía contestar yendo a cada barra.
 */
router.get('/nightclubs/:nightclubId/tills',
  requireRole('manager'),
  validate({ params: z.object({ nightclubId: uuid }) }),
  asyncHandler(async (req, res) => {
    const tills = await cuts.nightTills(pool, { nightclubId: req.params.nightclubId });
    // `by_method`, `tips` y `usd_drops_received` son para el corte general (D121): la
    // pantalla sigue recibiendo exactamente lo mismo que antes.
    const SOLO_PAPEL = ['by_method', 'tips', 'usd_drops_received'];
    const salida = tills.map((x) => Object.fromEntries(
      Object.entries(x).filter(([k]) => !SOLO_PAPEL.includes(k))));
    res.json({ tills: salida });
  }));

/**
 * El corte general de la noche, en papel (D121).
 *
 * Todas las cajas —barras y Cover— con su fondo, lo cobrado, retiros y diferencia, y
 * los totales del club al pie. Lo pide el gerente (o el admin) y sale en la impresora
 * que él escoja: el corte general no es de ninguna caja. Con cajas abiertas sale
 * marcado PRELIMINAR. No cambia nada: solo lee y encola el papel.
 */
router.post('/nightclubs/:nightclubId/tills/report/print',
  requireRole('manager', 'admin'),
  validate({
    params: z.object({ nightclubId: uuid }),
    body: z.object({ printer_id: uuid }),
  }),
  asyncHandler(async (req, res) => {
    const { nightclubId } = req.params;
    const printer = await printing.getPrinter(pool, { nightclubId, printerId: req.body.printer_id });
    if (!printer || !printer.active) throw ApiError.notFound('Esa impresora no existe o está apagada');
    const tills = await cuts.nightTills(pool, { nightclubId });
    const totals = cuts.nightTotals(tills);
    const job = await tickets.printNightCut(pool, {
      nightclubId, printer, tills, totals, userId: req.user.id,
    });
    res.status(202).json({ job: { id: job.id, status: job.status, printer_id: printer.id }, totals });
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
      // A ciegas (D105) lo declarado ya está guardado y no se manda; para los demás
      // puestos sigue siendo obligatorio.
      declared_cash: z.number().min(0).max(1_000_000).optional(),
      counted_cash: z.number().min(0).max(1_000_000).optional(),
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
    if (!cuts.isBlind(req.user.role)
        && (req.body.declared_cash === undefined || req.body.counted_cash === undefined)) {
      throw ApiError.badRequest('Indica lo que entregas y lo que contó el gerente');
    }

    const autoriza = await managerAuth.authorize(pool, {
      nightclubId, pin: req.body.manager_pin, selfId: req.user.id, ip: req.ip,
    });

    const client = await pool.connect();
    let hecho; let drawerCorte = null;
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
      // El corte de una caja (D122): se abre el cajón para entregar todo el efectivo.
      if (shift.location_id) {
        const { rows: lugar } = await client.query(
          'SELECT kind FROM supply_locations WHERE id = $1', [shift.location_id]);
        const printer = await cashDrawer.printerForTill(client, {
          nightclubId,
          caja: {
            location_id: shift.location_id, till_id: shift.till_id || null,
            location_kind: lugar[0] && lugar[0].kind,
          },
        });
        drawerCorte = await cashDrawer.open(client, {
          nightclubId, printer, refId: hecho.id, createdBy: req.user.id,
          reason: 'corte de caja: entrega del efectivo',
        });
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    // El corte de la caja de Cover libera esa caja: las anfitrionas se enteran (D118).
    const dePuerta = shift.location_id ? (await pool.query(
      'SELECT kind FROM supply_locations WHERE id = $1', [shift.location_id])).rows[0] : null;
    await events.publish({
      nightclubId,
      type: 'shift_closed',
      audience: {
        roles: dePuerta && dePuerta.kind === 'door' ? ['manager', 'admin', 'hostess'] : ['manager', 'admin'],
        userIds: [req.user.id],
      },
      payload: {
        closing_id: hecho.id,
        user_id: req.user.id,
        user_name: req.user.display_name || null,
        expected_cash: hecho.expected_cash,
        counted_cash: hecho.counted_cash,
        difference: hecho.difference,
        difference_usd: hecho.difference_usd,
        opening_float: hecho.opening_float,
        opening_float_usd: hecho.opening_float_usd,
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
      drawer: drawerCorte,
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
         c.location_id, l.name AS location_name, l.kind AS location_kind,
         c.opening_float::text AS opening_float, c.opening_float_usd::text AS opening_float_usd,
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
