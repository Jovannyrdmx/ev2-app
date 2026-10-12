/**
 * EV2 — promociones por evento (D102, parte B).
 *
 *   GET   /promotions/active                      lo vigente AHORA (para pintar los precios)
 *   GET   /events/:eventId/promotions             todas las de la noche (gerente)
 *   POST  /events/:eventId/promotions             crear (gerente)
 *   PATCH /promotions/:promotionId                editar o apagar (gerente)
 *
 * No se borran: se apagan. Un pedido ya hecho conserva su precio (`line_total`) y el
 * nombre de la promocion que se le aplico.
 */
'use strict';

const express = require('express');
const { pool } = require('../db/pool');
const { ApiError, asyncHandler } = require('../middleware/errors');
const { validate, z, uuid } = require('../middleware/validate');
const { authenticate, requireRole, sameNightclub } = require('../middleware/auth');
const promotions = require('../services/promotions');

const router = express.Router({ mergeParams: true });
router.use('/nightclubs/:nightclubId', authenticate, sameNightclub());

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM');

const fields = {
  name: z.string().trim().min(1).max(120),
  kind: z.enum(['fixed_price', 'percent', 'n_for_m']),
  drink_id: uuid.optional(),
  category: z.string().trim().min(1).max(40).optional(),
  value: z.number().min(0).max(100000).optional(),
  buy_qty: z.number().int().min(2).max(20).optional(),
  pay_qty: z.number().int().min(0).max(19).optional(),
  starts_time: hhmm.optional(),
  ends_time: hhmm.optional(),
};

/** Las reglas que el CHECK de la base tambien impone, con un mensaje que el gerente entiende. */
function checkShape(b) {
  if ((b.drink_id ? 1 : 0) + (b.category ? 1 : 0) !== 1) {
    throw ApiError.unprocessable('La promoción aplica a una bebida o a una categoría, no a las dos ni a ninguna');
  }
  if (Boolean(b.starts_time) !== Boolean(b.ends_time) || (b.starts_time && b.starts_time === b.ends_time)) {
    throw ApiError.unprocessable('El horario necesita hora de inicio y de fin distintas');
  }
  if (b.kind === 'fixed_price' && b.value === undefined) throw ApiError.unprocessable('Falta el precio');
  if (b.kind === 'percent' && !(b.value > 0 && b.value <= 100)) {
    throw ApiError.unprocessable('El porcentaje va de 1 a 100');
  }
  if (b.kind === 'n_for_m') {
    if (b.buy_qty === undefined || b.pay_qty === undefined || b.pay_qty >= b.buy_qty) {
      throw ApiError.unprocessable('Lleva N paga M: M debe ser menor que N');
    }
  }
}

const SELECT = `
  SELECT p.id, p.event_id, p.name, p.kind, p.drink_id, d.name AS drink_name, p.category,
         p.value::text AS value, p.buy_qty, p.pay_qty,
         to_char(p.starts_time, 'HH24:MI') AS starts_time,
         to_char(p.ends_time, 'HH24:MI') AS ends_time,
         p.active, p.created_at, p.updated_at
    FROM event_promotions p LEFT JOIN drinks d ON d.id = p.drink_id`;

async function audit(client, req, action, id, before, after) {
  await client.query(
    `INSERT INTO audit_log (nightclub_id, actor_id, action, entity, entity_id, before, after, ip)
     VALUES ($1,$2,$3,'event_promotion',$4,$5,$6,$7)`,
    [req.params.nightclubId, req.user.id, action, id,
      before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null, req.ip || null]);
}

async function assertTargets(runner, nightclubId, b) {
  if (b.drink_id) {
    const r = await runner.query('SELECT 1 FROM drinks WHERE id = $1 AND nightclub_id = $2 AND active',
      [b.drink_id, nightclubId]);
    if (r.rowCount === 0) throw ApiError.notFound('Bebida no encontrada');
  }
  if (b.category) {
    const r = await runner.query(
      'SELECT 1 FROM drinks WHERE nightclub_id = $1 AND category = $2 AND active LIMIT 1',
      [nightclubId, b.category]);
    if (r.rowCount === 0) throw ApiError.notFound('Ninguna bebida tiene esa categoría');
  }
}

router.get('/nightclubs/:nightclubId/promotions/active',
  validate({ params: z.object({ nightclubId: uuid }) }),
  asyncHandler(async (req, res) => {
    const rows = await promotions.activeNow(pool, { nightclubId: req.params.nightclubId });
    res.json({
      promotions: rows.map((p) => ({ ...p, badge: promotions.badge(p) })),
    });
  }));

router.get('/nightclubs/:nightclubId/events/:eventId/promotions',
  requireRole('manager'),
  validate({ params: z.object({ nightclubId: uuid, eventId: uuid }) }),
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(
      `${SELECT} WHERE p.nightclub_id = $1 AND p.event_id = $2 ORDER BY p.active DESC, p.created_at`,
      [req.params.nightclubId, req.params.eventId]);
    res.json({ promotions: rows });
  }));

router.post('/nightclubs/:nightclubId/events/:eventId/promotions',
  requireRole('manager'),
  validate({
    params: z.object({ nightclubId: uuid, eventId: uuid }),
    body: z.object(fields),
  }),
  asyncHandler(async (req, res) => {
    const { nightclubId, eventId } = req.params;
    const b = req.body;
    checkShape(b);
    const ev = await pool.query(
      'SELECT status FROM events_calendar WHERE id = $1 AND nightclub_id = $2', [eventId, nightclubId]);
    if (ev.rowCount === 0) throw ApiError.notFound('Evento no encontrado');
    if (['cancelled', 'finished'].includes(ev.rows[0].status)) {
      throw ApiError.conflict('El evento ya está cancelado o terminado');
    }
    await assertTargets(pool, nightclubId, b);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const ins = await client.query(
        `INSERT INTO event_promotions (nightclub_id, event_id, name, kind, drink_id, category,
                                       value, buy_qty, pay_qty, starts_time, ends_time, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
        [nightclubId, eventId, b.name, b.kind, b.drink_id || null, b.category || null,
          b.kind === 'n_for_m' ? null : b.value,
          b.kind === 'n_for_m' ? b.buy_qty : null, b.kind === 'n_for_m' ? b.pay_qty : null,
          b.starts_time || null, b.ends_time || null, req.user.id]);
      await audit(client, req, 'promotion.create', ins.rows[0].id, null, b);
      await client.query('COMMIT');
      const { rows } = await client.query(`${SELECT} WHERE p.id = $1`, [ins.rows[0].id]);
      res.status(201).json({ promotion: rows[0] });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }));

router.patch('/nightclubs/:nightclubId/promotions/:promotionId',
  requireRole('manager'),
  validate({
    params: z.object({ nightclubId: uuid, promotionId: uuid }),
    body: z.object({
      ...fields,
      starts_time: hhmm.nullable().optional(),
      ends_time: hhmm.nullable().optional(),
      active: z.boolean().optional(),
    }).partial().refine((o) => Object.keys(o).length > 0, 'Nada que cambiar'),
  }),
  asyncHandler(async (req, res) => {
    const { nightclubId, promotionId } = req.params;
    const cur = await pool.query(`${SELECT} WHERE p.id = $1 AND p.nightclub_id = $2`,
      [promotionId, nightclubId]);
    if (cur.rowCount === 0) throw ApiError.notFound('Promoción no encontrada');
    const before = cur.rows[0];
    const b = req.body;

    // Se valida la promocion ENTERA como quedaria, no solo los campos que llegan.
    const merged = {
      kind: b.kind || before.kind,
      drink_id: b.drink_id !== undefined ? b.drink_id : (b.category ? undefined : before.drink_id || undefined),
      category: b.category !== undefined ? b.category : (b.drink_id ? undefined : before.category || undefined),
      value: b.value !== undefined ? b.value : (before.value === null ? undefined : Number(before.value)),
      buy_qty: b.buy_qty !== undefined ? b.buy_qty : before.buy_qty ?? undefined,
      pay_qty: b.pay_qty !== undefined ? b.pay_qty : before.pay_qty ?? undefined,
      starts_time: b.starts_time !== undefined ? b.starts_time || undefined : before.starts_time || undefined,
      ends_time: b.ends_time !== undefined ? b.ends_time || undefined : before.ends_time || undefined,
    };
    checkShape(merged);
    await assertTargets(pool, nightclubId, merged);
    const isN = merged.kind === 'n_for_m';

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE event_promotions
            SET name = $3, kind = $4, drink_id = $5, category = $6, value = $7,
                buy_qty = $8, pay_qty = $9, starts_time = $10, ends_time = $11,
                active = $12, updated_at = now()
          WHERE id = $1 AND nightclub_id = $2`,
        [promotionId, nightclubId, b.name || before.name, merged.kind,
          merged.drink_id || null, merged.category || null,
          isN ? null : merged.value, isN ? merged.buy_qty : null, isN ? merged.pay_qty : null,
          merged.starts_time || null, merged.ends_time || null,
          b.active !== undefined ? b.active : before.active]);
      await audit(client, req, b.active === false ? 'promotion.disable' : 'promotion.update',
        promotionId, before, b);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    const { rows } = await pool.query(`${SELECT} WHERE p.id = $1`, [promotionId]);
    res.json({ promotion: rows[0] });
  }));

module.exports = router;
