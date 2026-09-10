// La puerta: escanear el pase de una reservación, y vender la entrada.
//
// Todo lo de aquí lo hace el personal de la entrada con un teléfono en la mano y
// una fila enfrente. Eso manda en dos decisiones:
//
//   * un pase que no abre devuelve SIEMPRE 200 con un motivo en palabras, no un
//     error. "Esta reservación es de mañana" o "ya entraron a las 11:40" se
//     resuelven hablando; un 404 rojo solo detiene la fila;
//   * lo que se vende se registra en el mismo instante y en el mismo libro que
//     todo lo demás (`transactions`), porque al cierre nadie va a recordar
//     cuántos covers se cobraron.
'use strict';

const express = require('express');
const { pool } = require('../db/pool');
const { ApiError, asyncHandler } = require('../middleware/errors');
const { validate, z, uuid } = require('../middleware/validate');
const { authenticate, requireRole, sameNightclub } = require('../middleware/auth');
const events = require('../services/events');
const door = require('../services/door');
const QRCode = require('qrcode');
const seating = require('../services/seating');

const router = express.Router({ mergeParams: true });

router.use('/nightclubs/:nightclubId', authenticate, sameNightclub());

const DOOR_ROLES = ['hostess', 'manager', 'admin'];

// Lo que la puerta necesita ver de un pase: quién, qué mesa, cuántos.
const PASS_SELECT = `
  SELECT r.id, r.status, r.starts_at, r.ends_at, r.guest_count, r.pass_code,
         r.checked_in_at, r.special_requests, r.nightclub_id,
         r.user_id, u.display_name AS guest_name, u.phone AS guest_phone,
         t.id AS table_id, t.code AS table_code, t.section, t.floor, t.capacity,
         COALESCE(x.extras, 0)::int AS extras_bought
    FROM reservations r
    JOIN users u ON u.id = r.user_id
    JOIN tables t ON t.id = r.table_id
    LEFT JOIN LATERAL (
      SELECT sum(quantity) AS extras FROM door_admissions a
       WHERE a.reservation_id = r.id AND a.kind = 'vip_extra'
    ) x ON true`;

function presentPass(row, check) {
  return {
    reservation_id: row.id,
    status: row.status,
    pass_code: row.pass_code,
    guest: { id: row.user_id, name: row.guest_name },
    table: {
      id: row.table_id, code: row.table_code, section: row.section,
      floor: row.floor, capacity: row.capacity,
    },
    guest_count: row.guest_count,
    extras_bought: row.extras_bought,
    starts_at: row.starts_at,
    checked_in_at: row.checked_in_at,
    special_requests: row.special_requests || null,
    result: check.status,
    ok: check.ok,
  };
}

// ------------------------------------------------------------------ el pase del cliente

/**
 * El pase que el cliente enseña en la puerta: su código y el QR.
 *
 * El QR se dibuja aquí y no en el teléfono a propósito. Un generador en el
 * navegador serían doscientas líneas de aritmética de Reed-Solomon que nadie va a
 * revisar, y un QR mal generado no falla: se ve bien y no lee. Aquí lo hace una
 * librería probada, y el cliente recibe un SVG que puede guardar, imprimir o
 * enseñar en pantalla.
 *
 * Lo puede pedir el dueño de la reservación y el personal de la puerta. Nadie más:
 * un pase ajeno es una entrada ajena.
 */
router.get('/nightclubs/:nightclubId/reservations/:reservationId/pass',
  validate({ params: z.object({ nightclubId: uuid, reservationId: uuid }) }),
  asyncHandler(async (req, res) => {
    const { nightclubId, reservationId } = req.params;
    const { rows } = await pool.query(
      `${PASS_SELECT} WHERE r.id = $1 AND r.nightclub_id = $2`,
      [reservationId, nightclubId]);
    if (rows.length === 0) throw ApiError.notFound('Reservación no encontrada');
    const row = rows[0];

    const esSuyo = row.user_id === req.user.id;
    const esPersonal = DOOR_ROLES.includes(req.user.role);
    if (!esSuyo && !esPersonal) throw ApiError.notFound('Reservación no encontrada');

    if (!row.pass_code) throw ApiError.conflict('Esta reservación todavía no tiene pase');

    // El QR lleva el código pelón, no una dirección: así lo lee cualquier lector,
    // y si el cliente enseña la pantalla apagada el código sigue debajo, escrito.
    const qr = await QRCode.toString(row.pass_code, {
      type: 'svg', errorCorrectionLevel: 'M', margin: 1, width: 320,
      color: { dark: '#000000', light: '#ffffff' },
    });

    res.json({
      pass: {
        code: row.pass_code,
        qr_svg: qr,
        guest_name: row.guest_name,
        table_code: row.table_code,
        section: row.section,
        guest_count: row.guest_count,
        starts_at: row.starts_at,
        status: row.status,
        checked_in_at: row.checked_in_at,
      },
    });
  }));

// ------------------------------------------------------------------ leer un pase

/**
 * Mirar sin dejar entrar. Sirve para que la puerta compruebe un pase dudoso —o
 * conteste "¿a qué hora es mi reservación?"— sin gastarlo.
 */
router.get('/nightclubs/:nightclubId/door/pass/:code',
  requireRole(...DOOR_ROLES),
  validate({ params: z.object({ nightclubId: uuid, code: z.string().trim().min(4).max(30) }) }),
  asyncHandler(async (req, res) => {
    const code = door.normalizePassCode(req.params.code);
    const { rows } = await pool.query(
      `${PASS_SELECT} WHERE r.pass_code = $1 AND r.nightclub_id = $2`,
      [code, req.params.nightclubId]);
    if (rows.length === 0) {
      return res.json({ pass: null, result: door.PASS_STATUS.notFound, ok: false });
    }
    return res.json({ pass: presentPass(rows[0], door.checkPass(rows[0])) });
  }));

// ------------------------------------------------------------------ dejar entrar

/**
 * El escaneo de la entrada. Esto es lo que de verdad sienta a la mesa.
 *
 * Un pase que no abre NO es un error: se contesta 200 con el motivo, porque la
 * persona de la puerta necesita leerlo y explicarlo, no un código de estado.
 */
router.post('/nightclubs/:nightclubId/door/check-in',
  requireRole(...DOOR_ROLES),
  validate({
    params: z.object({ nightclubId: uuid }),
    body: z.object({ code: z.string().trim().min(4).max(200) }),
  }),
  asyncHandler(async (req, res) => {
    const { nightclubId } = req.params;
    // Lo que llega puede ser el código pelón o la dirección completa del QR.
    const code = door.passFromScan(req.body.code);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `${PASS_SELECT} WHERE r.pass_code = $1 AND r.nightclub_id = $2 FOR UPDATE OF r`,
        [code, nightclubId]);
      if (rows.length === 0) {
        await client.query('ROLLBACK');
        return res.json({ pass: null, result: door.PASS_STATUS.notFound, ok: false });
      }
      const row = rows[0];
      const check = door.checkPass(row);
      if (!check.ok) {
        await client.query('ROLLBACK');
        return res.json({ pass: presentPass(row, check) });
      }

      await client.query(
        `UPDATE reservations
            SET status = 'seated', checked_in_at = now(), checked_in_by = $2, updated_at = now()
          WHERE id = $1`,
        [row.id, req.user.id]);
      // Y sentar de verdad: sin esto la mesa se pinta ocupada y el cliente sigue
      // sin poder pedir nada desde su teléfono.
      await seating.seatUser(client, { tableId: row.table_id, userId: row.user_id });

      await events.publish({
        nightclubId, type: 'reservation_seated', client,
        audience: { roles: ['hostess', 'manager', 'waiter'], userIds: [row.user_id] },
        payload: {
          reservation_id: row.id, table_id: row.table_id, table_code: row.table_code,
          guest_count: row.guest_count,
        },
      });
      await client.query('COMMIT');

      const fresco = await pool.query(`${PASS_SELECT} WHERE r.id = $1`, [row.id]);
      return res.status(200).json({
        pass: presentPass(fresco.rows[0], { status: door.PASS_STATUS.ok, ok: true }),
        seated: true,
      });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }));

// ------------------------------------------------------------------ vender la entrada

const admissionSchema = z.object({
  client_request_id: uuid.optional(),
  kind: z.enum(['general', 'vip_extra']),
  reservation_id: uuid.optional(),
  quantity: z.number().int().min(1).max(50).default(1),
  unit_price: z.number().min(0).max(100000),
  currency: z.enum(['MXN', 'USD']).default('MXN'),
  payment_method: z.enum(['cash', 'card', 'transfer', 'courtesy']).default('cash'),
  notes: z.string().trim().max(200).optional(),
  event_id: uuid.optional(),
}).refine((b) => b.kind !== 'vip_extra' || b.reservation_id, {
  message: 'Un extra VIP va contra una reservación', path: ['reservation_id'],
});

router.post('/nightclubs/:nightclubId/door/admissions',
  requireRole(...DOOR_ROLES),
  validate({ params: z.object({ nightclubId: uuid }), body: admissionSchema }),
  asyncHandler(async (req, res) => {
    const { nightclubId } = req.params;
    const b = req.body;
    const total = Math.round(b.unit_price * b.quantity * 100) / 100;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      if (b.reservation_id) {
        const r = await client.query(
          'SELECT id FROM reservations WHERE id = $1 AND nightclub_id = $2',
          [b.reservation_id, nightclubId]);
        if (r.rowCount === 0) throw ApiError.notFound('Reservación no encontrada');
      }

      // Una cortesía no es dinero: se registra el acceso, pero no se inventa un
      // renglón de cobro por cero pesos en el libro.
      let transactionId = null;
      if (b.payment_method !== 'courtesy' && total > 0) {
        const tx = await client.query(
          `INSERT INTO transactions (nightclub_id, type, direction, amount, currency, status,
                                     provider, reference_type, metadata)
           VALUES ($1,'cover','in',$2,$3,'paid',$4,'door_admission',$5)
           RETURNING id`,
          [nightclubId, total, b.currency,
            b.payment_method === 'cash' ? 'cash' : 'manual',
            JSON.stringify({
              kind: b.kind, quantity: b.quantity, payment_method: b.payment_method,
              reservation_id: b.reservation_id || null, sold_by: req.user.id,
            })],
        );
        transactionId = tx.rows[0].id;
      }

      const { rows } = await client.query(
        `INSERT INTO door_admissions (nightclub_id, event_id, kind, reservation_id, quantity,
                                      unit_price, total, currency, payment_method,
                                      transaction_id, sold_by, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         RETURNING id, kind, quantity, unit_price::text, total::text, currency,
                   payment_method, reservation_id, created_at`,
        [nightclubId, b.event_id || null, b.kind, b.reservation_id || null, b.quantity,
          b.unit_price, total, b.currency, b.payment_method, transactionId,
          req.user.id, b.notes || null],
      );

      await events.publish({
        nightclubId, type: 'door_admission', client,
        audience: { roles: ['hostess', 'manager'] },
        payload: { kind: b.kind, quantity: b.quantity, total: String(total) },
      });
      await client.query('COMMIT');
      return res.status(201).json({ admission: rows[0] });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }));

// ------------------------------------------------------------------ el aforo

/**
 * Cuánta gente hay adentro, ahora.
 *
 * Se cuenta por separado lo reservado y lo vendido en la puerta porque son dos
 * negocios distintos: una noche puede ir floja de mesas y llena de general, y un
 * solo número escondería eso.
 */
router.get('/nightclubs/:nightclubId/door/summary',
  requireRole(...DOOR_ROLES),
  validate({ params: z.object({ nightclubId: uuid }) }),
  asyncHandler(async (req, res) => {
    const id = req.params.nightclubId;
    const [reservas, ventas, mesas] = await Promise.all([
      pool.query(
        `SELECT count(*) FILTER (WHERE status IN ('confirmed','pending_payment'))::int AS esperadas,
                count(*) FILTER (WHERE status = 'seated')::int AS adentro,
                count(*) FILTER (WHERE status = 'no_show')::int AS no_llegaron,
                COALESCE(sum(guest_count) FILTER (WHERE status = 'seated'), 0)::int AS personas_vip
           FROM reservations
          WHERE nightclub_id = $1 AND starts_at > now() - interval '12 hours'`,
        [id]),
      pool.query(
        `SELECT COALESCE(sum(quantity) FILTER (WHERE kind = 'general'), 0)::int AS generales,
                COALESCE(sum(quantity) FILTER (WHERE kind = 'vip_extra'), 0)::int AS extras_vip,
                COALESCE(sum(total), 0)::text AS cobrado,
                COALESCE(max(currency), 'MXN') AS currency
           FROM door_admissions
          WHERE nightclub_id = $1 AND created_at > now() - interval '12 hours'`,
        [id]),
      pool.query(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE status = 'occupied')::int AS ocupadas
           FROM tables WHERE nightclub_id = $1 AND active`,
        [id]),
    ]);
    const r = reservas.rows[0];
    const v = ventas.rows[0];
    res.json({
      reservations: r,
      door: v,
      tables: mesas.rows[0],
      inside: r.personas_vip + v.generales + v.extras_vip,
      generated_at: new Date().toISOString(),
    });
  }));

module.exports = router;
module.exports.PASS_SELECT = PASS_SELECT;
