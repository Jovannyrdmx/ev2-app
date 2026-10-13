// El anticipo de una reservación por transferencia, con su comprobante (D113).
//
// El recorrido completo:
//
//   1. El cliente reserva y la app le abre la página del anticipo: cuánto, a qué
//      cuenta (las que capturó el gerente) y un botón para subir la foto del
//      comprobante (`POST …/deposit-proof`).
//   2. El pago queda `declared` y el renglón del libro `pending_manual`. Le llega un
//      aviso al gerente y a la anfitriona.
//   3. Cualquiera de los dos abre la foto (`GET …/manual-payments/:id/proof`), la
//      compara con el banco y confirma o rechaza con las rutas de siempre de
//      `routes/payments.js`. Confirmar pasa la reservación a `confirmed` y le da al
//      cliente su crédito de consumo (D97). Rechazar le dice por qué y le deja subir
//      otro.
//
// Nada de aquí mueve dinero: subir una foto es DECIR que se pagó, igual que en D28.
'use strict';

const express = require('express');
const multer = require('multer');
const fs = require('fs');

const { pool } = require('../db/pool');
const { ApiError, asyncHandler } = require('../middleware/errors');
const { validate, z, uuid, pagination } = require('../middleware/validate');
const { authenticate, requireRole, sameNightclub } = require('../middleware/auth');
const payments = require('../services/payments');
const money = require('../services/reservation-money');
const events = require('../services/events');

const router = express.Router({ mergeParams: true });

const REVIEWERS = ['hostess', 'manager', 'admin'];
const isReviewer = (user) => REVIEWERS.includes(user.role);
const isManager = (user) => user.role === 'manager' || user.role === 'admin';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: money.PROOF_MAX_BYTES, files: 1 },
});

function receiveProof(req, res, next) {
  upload.single('photo')(req, res, (err) => {
    if (!err) { next(); return; }
    if (err.code === 'LIMIT_FILE_SIZE') {
      next(ApiError.unprocessable(
        `El comprobante pesa más de ${Math.round(money.PROOF_MAX_BYTES / (1024 * 1024))} MB`));
      return;
    }
    if (err.code === 'LIMIT_UNEXPECTED_FILE') {
      next(ApiError.unprocessable('Manda un solo archivo, en el campo "photo"'));
      return;
    }
    next(err);
  });
}

router.use('/nightclubs/:nightclubId', authenticate, sameNightclub());

/** La reservación y si quien pregunta puede verla: su dueño o el personal de la puerta. */
async function loadReservation(runner, { nightclubId, reservationId, user }) {
  const { rows } = await runner.query(
    `SELECT r.id, r.status, r.user_id, r.currency, r.starts_at, r.guest_count,
            r.total_estimated::text AS total, r.deposit_amount::text AS deposit,
            ev.name AS event_name, ev.doors_open_at, t.code AS table_code, t.section,
            u.display_name AS holder_name
       FROM reservations r
       JOIN tables t ON t.id = r.table_id
       JOIN users u ON u.id = r.user_id
       LEFT JOIN events_calendar ev ON ev.id = r.event_id
      WHERE r.id = $1 AND r.nightclub_id = $2`,
    [reservationId, nightclubId]);
  const r = rows[0];
  // Lo de otro cliente no existe para este: un 404, no un 403 que confirme que existe.
  if (!r || (r.user_id !== user.id && !isReviewer(user))) {
    throw ApiError.notFound('Reservación no encontrada');
  }
  return r;
}

/** Las cuentas a donde se transfiere: las que el gerente dio de alta y no son efectivo. */
async function transferOptions(runner, nightclubId) {
  const { rows } = await runner.query(
    `SELECT id, method, label, destination, instructions, currency, requires_reference
       FROM manual_payment_options
      WHERE nightclub_id = $1 AND active AND method <> ALL($2::text[])
      ORDER BY sort_order, method, label`,
    [nightclubId, payments.CASH_METHODS]);
  return rows;
}

/**
 * Todo lo que la página del anticipo necesita en una sola llamada: cuánto, a dónde,
 * qué pasó con el último comprobante y cuánto crédito trae para esa noche.
 */
router.get('/nightclubs/:nightclubId/reservations/:reservationId/payment',
  validate({ params: z.object({ nightclubId: uuid, reservationId: uuid }) }),
  asyncHandler(async (req, res) => {
    const { nightclubId, reservationId } = req.params;
    const r = await loadReservation(pool, { nightclubId, reservationId, user: req.user });
    const [saldo, options, credit] = await Promise.all([
      money.balanceOf(pool, { nightclubId, reservationId }),
      transferOptions(pool, nightclubId),
      pool.query(
        `SELECT granted::text AS granted, spent::text AS spent, expires_at, voided_at
           FROM reservation_credits WHERE reservation_id = $1`, [reservationId]),
    ]);

    let lastProof = null;
    if (saldo.deposit_tx) {
      const p = await pool.query(
        `${payments.PAYMENT_SELECT} WHERE p.transaction_id = $1
          ORDER BY p.created_at DESC LIMIT 1`, [saldo.deposit_tx.id]);
      if (p.rows[0]) lastProof = payments.present(p.rows[0], isManager(req.user) ? 'manager' : 'guest');
    }

    const c = credit.rows[0];
    const disponible = c && !c.voided_at && new Date(c.expires_at) > new Date()
      ? Math.max(0, Number(c.granted) - Number(c.spent)).toFixed(2) : '0.00';

    res.json({
      reservation: {
        id: r.id, status: r.status, event_name: r.event_name, doors_open_at: r.doors_open_at,
        starts_at: r.starts_at, table_code: r.table_code, section: r.section,
        guest_count: r.guest_count, currency: r.currency,
      },
      total: saldo.total,
      deposit: saldo.deposit,
      paid: saldo.paid,
      due: saldo.due,
      deposit_status: saldo.deposit_tx ? saldo.deposit_tx.status : null,
      deposit_amount_due: saldo.deposit_tx ? Number(saldo.deposit_tx.amount).toFixed(2) : null,
      last_proof: lastProof,
      options,
      credit: c ? { granted: c.granted, spent: c.spent, available: disponible, expires_at: c.expires_at } : null,
    });
  }));

const proofBody = z.object({
  option_id: uuid.optional(),
  reference: z.string().trim().min(3).max(60).optional(),
  note: z.string().trim().max(280).optional(),
  client_request_id: uuid.optional(),
});

/**
 * El cliente sube la foto del comprobante del anticipo.
 *
 * Solo el dueño de la reservación, y solo mientras la reservación espera su pago. Un
 * comprobante en revisión bloquea otro (si se equivocó de foto, lo retira con
 * `manual-payments/:id/cancel` y sube el bueno); uno rechazado deja subir otro.
 */
router.post('/nightclubs/:nightclubId/reservations/:reservationId/deposit-proof',
  receiveProof,
  validate({ params: z.object({ nightclubId: uuid, reservationId: uuid }), body: proofBody }),
  asyncHandler(async (req, res) => {
    const { nightclubId, reservationId } = req.params;
    const b = req.body;

    const r = await loadReservation(pool, { nightclubId, reservationId, user: req.user });
    if (r.user_id !== req.user.id) {
      throw ApiError.forbidden('El comprobante lo sube quien hizo la reservación desde su app');
    }
    const mime = money.checkProof(req.file);

    // La opción: obligatoria si el club tiene cuentas dadas de alta, para que el gerente
    // sepa en qué estado de cuenta buscar el depósito.
    const opciones = await transferOptions(pool, nightclubId);
    let option = null;
    if (b.option_id) {
      option = opciones.find((o) => o.id === b.option_id);
      if (!option) throw ApiError.unprocessable('Esa cuenta para transferir ya no está disponible');
    } else if (opciones.length > 0) {
      throw ApiError.unprocessable('Escoge a qué cuenta transferiste');
    }

    if (b.client_request_id) {
      const ya = await pool.query(
        `${payments.PAYMENT_SELECT} WHERE p.client_request_id = $1 AND p.nightclub_id = $2`,
        [b.client_request_id, nightclubId]);
      if (ya.rowCount > 0) {
        return res.status(200).json({ payment: payments.present(ya.rows[0], 'guest'), idempotent: true });
      }
    }

    // La foto se escribe ANTES de la transacción: si la base falla queda un archivo
    // huérfano (inofensivo); al revés quedaría un pago que dice tener foto y no la tiene.
    const guardado = await money.storeProof({ nightclubId, file: req.file, mime });

    const client = await pool.connect();
    let creado;
    let tx;
    try {
      await client.query('BEGIN');
      const resv = await client.query(
        'SELECT status FROM reservations WHERE id = $1 FOR UPDATE', [reservationId]);
      if (resv.rows[0].status !== 'pending_payment') {
        throw ApiError.conflict(resv.rows[0].status === 'confirmed' || resv.rows[0].status === 'seated'
          ? 'El anticipo de esta reservación ya está confirmado'
          : 'Esta reservación ya no espera su anticipo');
      }
      const txRes = await client.query(
        `SELECT id, amount::text AS amount, currency, status
           FROM transactions
          WHERE reference_type = 'reservation' AND reference_id = $1 AND nightclub_id = $2
            AND type = 'reservation_deposit'
          ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
        [reservationId, nightclubId]);
      tx = txRes.rows[0];
      if (!tx) throw ApiError.conflict('Esta reservación no tiene anticipo por pagar');
      if (tx.status === 'pending_manual') {
        throw ApiError.conflict('Ya mandaste un comprobante y está en revisión. Si te equivocaste de foto, retíralo y sube el correcto.');
      }
      if (tx.status !== 'pending') {
        throw ApiError.conflict(`El anticipo está '${tx.status}' y ya no admite comprobante`);
      }

      const method = option ? option.method : 'bank_transfer';
      try {
        const { rows } = await client.query(
          `INSERT INTO manual_payments (nightclub_id, transaction_id, option_id, method, declared_by,
                                        amount, currency, reference, note, client_request_id,
                                        proof_path, proof_mime, proof_bytes, proof_checksum,
                                        proof_uploaded_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,now())
           RETURNING id`,
          [nightclubId, tx.id, option ? option.id : null, method, req.user.id,
            tx.amount, tx.currency, b.reference ?? null, b.note ?? null, b.client_request_id ?? null,
            guardado.relative, mime, guardado.bytes, guardado.checksum]);
        creado = rows[0];
      } catch (err) {
        if (err.code === '23505') {
          if (String(err.detail || '').includes('reference')) {
            throw ApiError.conflict('Ese folio ya se usó para otro pago');
          }
          throw ApiError.conflict('Ese anticipo ya tiene un comprobante en revisión');
        }
        throw err;
      }
      await client.query(
        `UPDATE transactions SET status = 'pending_manual', updated_at = now()
          WHERE id = $1 AND status = 'pending'`, [tx.id]);
      await events.publish({
        client, nightclubId, type: 'deposit_proof_received',
        audience: { roles: ['hostess', 'manager'] },
        payload: {
          manual_payment_id: creado.id, reservation_id: reservationId,
          amount: tx.amount, currency: tx.currency, guest_name: r.holder_name,
          table_code: r.table_code,
        },
      });
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    const full = await pool.query(`${payments.PAYMENT_SELECT} WHERE p.id = $1`, [creado.id]);
    res.status(201).json({ payment: payments.present(full.rows[0], 'guest') });
  }));

/**
 * La foto del comprobante. La ven: quien la subió, el gerente, y la anfitriona cuando
 * es el anticipo de una reservación (que es lo único que ella aprueba).
 */
router.get('/nightclubs/:nightclubId/manual-payments/:paymentId/proof',
  validate({ params: z.object({ nightclubId: uuid, paymentId: uuid }) }),
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT p.proof_path, p.proof_mime, p.declared_by, p.on_behalf_of, t.type
         FROM manual_payments p JOIN transactions t ON t.id = p.transaction_id
        WHERE p.id = $1 AND p.nightclub_id = $2`,
      [req.params.paymentId, req.params.nightclubId]);
    const p = rows[0];
    const suyo = p && (p.declared_by === req.user.id || p.on_behalf_of === req.user.id);
    const puede = p && (suyo || isManager(req.user)
      || (req.user.role === 'hostess' && p.type === 'reservation_deposit'));
    if (!puede || !p.proof_path) throw ApiError.notFound('Ese comprobante no existe');

    const absolute = money.proofAbsolute(p.proof_path);
    if (!absolute || !fs.existsSync(absolute)) {
      throw ApiError.notFound('El archivo del comprobante ya no está en el servidor');
    }
    res.type(p.proof_mime);
    // Un comprobante bancario trae nombre y cuenta: que ninguna capa intermedia lo guarde,
    // y que el navegador no intente interpretarlo como otra cosa.
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', 'inline');
    fs.createReadStream(absolute).pipe(res);
  }));

/**
 * La cola de anticipos por revisar, para la puerta y el gerente. Solo anticipos de
 * reservación: el resto de los pagos manuales sigue en la cola del gerente.
 */
router.get('/nightclubs/:nightclubId/deposit-reviews',
  requireRole('hostess', 'manager'),
  validate({
    params: z.object({ nightclubId: uuid }),
    query: pagination.extend({
      status: z.enum(['declared', 'confirmed', 'rejected', 'cancelled']).default('declared'),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(
      `${payments.PAYMENT_SELECT}
        WHERE p.nightclub_id = $1 AND t.type = 'reservation_deposit' AND p.status = $2
        ORDER BY p.created_at ${req.query.status === 'declared' ? 'ASC' : 'DESC'}
        LIMIT $3 OFFSET $4`,
      [req.params.nightclubId, req.query.status, req.query.limit, req.query.offset]);
    const ids = rows.map((r) => r.reference_id).filter(Boolean);
    const resv = ids.length === 0 ? { rows: [] } : await pool.query(
      `SELECT r.id, r.status, r.guest_count, r.starts_at, r.total_estimated::text AS total,
              t.code AS table_code, t.section, ev.name AS event_name, u.display_name AS holder_name,
              u.phone AS holder_phone
         FROM reservations r
         JOIN tables t ON t.id = r.table_id
         JOIN users u ON u.id = r.user_id
         LEFT JOIN events_calendar ev ON ev.id = r.event_id
        WHERE r.id = ANY($1::uuid[])`, [ids]);
    const porId = new Map(resv.rows.map((r) => [r.id, r]));
    res.json({
      reviews: rows.map((row) => ({
        payment: payments.present(row, 'manager'),
        reservation: porId.get(row.reference_id) || null,
      })),
    });
  }));

module.exports = router;
module.exports.isReviewer = isReviewer;
