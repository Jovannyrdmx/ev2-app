// Servicio de botella (D117): el catálogo de mezcladores y el tope de cada botella.
//
// Lo ve todo el que pide (mesero y cliente necesitan saber qué se puede elegir y cuánto
// cuesta el extra); lo cambia solo el gerente o el admin, y cada cambio queda en
// audit_log con el antes y el después: subir el precio de un extra es dinero.
'use strict';

const express = require('express');
const { pool } = require('../db/pool');
const { ApiError, asyncHandler } = require('../middleware/errors');
const { validate, z, uuid } = require('../middleware/validate');
const { authenticate, requireRole, sameNightclub } = require('../middleware/auth');
const bottleService = require('../services/bottle-service');

const router = express.Router({ mergeParams: true });
router.use('/nightclubs/:nightclubId', authenticate, sameNightclub());

const MANAGERS = ['manager', 'admin'];
const isManager = (user) => MANAGERS.includes(user.role);
const money = z.number().min(0).max(100000);

async function audit(client, req, action, entityId, before, after) {
  await client.query(
    `INSERT INTO audit_log (nightclub_id, actor_id, action, entity, entity_id, before, after, ip)
     VALUES ($1,$2,$3,'bottle_mixer',$4,$5,$6,$7)`,
    [req.params.nightclubId, req.user.id, action, entityId,
      before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null, req.ip || null]);
}

/** El catálogo. El personal de piso y el cliente solo ven lo activo. */
router.get('/nightclubs/:nightclubId/bottle-mixers',
  validate({ params: z.object({ nightclubId: uuid }) }),
  asyncHandler(async (req, res) => {
    const mixers = await bottleService.listMixers(pool, {
      nightclubId: req.params.nightclubId, activeOnly: !isManager(req.user) });
    res.json({ mixers });
  }));

router.post('/nightclubs/:nightclubId/bottle-mixers',
  requireRole(...MANAGERS),
  validate({
    params: z.object({ nightclubId: uuid }),
    body: z.object({
      supply_id: uuid,
      name: z.string().trim().min(1).max(80),
      portion: z.number().positive().max(1_000_000),
      extra_price: money,
      size: z.enum(['small', 'large']).default('small'),
      sort_order: z.number().int().min(0).max(10_000).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { nightclubId } = req.params;
    const b = req.body;
    const supply = await pool.query(
      'SELECT id, unit FROM supplies WHERE id = $1 AND nightclub_id = $2 AND active',
      [b.supply_id, nightclubId]);
    if (supply.rowCount === 0) throw ApiError.notFound('Ese insumo no existe o está dado de baja');

    const client = await pool.connect();
    let row;
    try {
      await client.query('BEGIN');
      try {
        const { rows } = await client.query(
          `INSERT INTO bottle_mixers (nightclub_id, supply_id, name, portion, extra_price, size, sort_order)
           VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
          [nightclubId, b.supply_id, b.name, b.portion, b.extra_price.toFixed(2), b.size,
            b.sort_order ?? 0]);
        row = rows[0];
      } catch (err) {
        if (err.code === '23505') throw ApiError.conflict('Ese insumo ya es un mezclador del servicio');
        throw err;
      }
      await audit(client, req, 'bottle_mixer_created', row.id, null, b);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    const all = await bottleService.listMixers(pool, { nightclubId });
    res.status(201).json({ mixer: all.find((m) => m.id === row.id) });
  }));

router.patch('/nightclubs/:nightclubId/bottle-mixers/:mixerId',
  requireRole(...MANAGERS),
  validate({
    params: z.object({ nightclubId: uuid, mixerId: uuid }),
    body: z.object({
      name: z.string().trim().min(1).max(80).optional(),
      portion: z.number().positive().max(1_000_000).optional(),
      extra_price: money.optional(),
      size: z.enum(['small', 'large']).optional(),
      active: z.boolean().optional(),
      sort_order: z.number().int().min(0).max(10_000).optional(),
    }).refine((b) => Object.keys(b).length > 0, 'Nada que cambiar'),
  }),
  asyncHandler(async (req, res) => {
    const { nightclubId, mixerId } = req.params;
    const b = req.body;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const prev = await client.query(
        `SELECT name, portion::float8 AS portion, extra_price::text AS extra_price, size, active, sort_order
           FROM bottle_mixers WHERE id = $1 AND nightclub_id = $2 FOR UPDATE`, [mixerId, nightclubId]);
      if (prev.rowCount === 0) throw ApiError.notFound('Mezclador no encontrado');
      await client.query(
        `UPDATE bottle_mixers
            SET name = COALESCE($3, name), portion = COALESCE($4, portion),
                extra_price = COALESCE($5, extra_price), active = COALESCE($6, active),
                sort_order = COALESCE($7, sort_order), size = COALESCE($8, size)
          WHERE id = $1 AND nightclub_id = $2`,
        [mixerId, nightclubId, b.name ?? null, b.portion ?? null,
          b.extra_price === undefined ? null : b.extra_price.toFixed(2), b.active ?? null,
          b.sort_order ?? null, b.size ?? null]);
      await audit(client, req, 'bottle_mixer_updated', mixerId, prev.rows[0], b);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    const all = await bottleService.listMixers(pool, { nightclubId });
    res.json({ mixer: all.find((m) => m.id === mixerId) });
  }));

/**
 * Los topes de una botella, por pieza: `included_mixers` (chicos) e
 * `included_large_mixers` (grandes). `included_mixers: null` le quita el servicio
 * (deja de ofrecerse el selector); 0 = lleva servicio pero todo ese tamaño se cobra.
 */
router.put('/nightclubs/:nightclubId/drinks/:drinkId/included-mixers',
  requireRole(...MANAGERS),
  validate({
    params: z.object({ nightclubId: uuid, drinkId: uuid }),
    body: z.object({
      included_mixers: z.number().int().min(0).max(50).nullable(),
      included_large_mixers: z.number().int().min(0).max(50).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { nightclubId, drinkId } = req.params;
    const value = req.body.included_mixers;
    const large = req.body.included_large_mixers;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const prev = await client.query(
        `SELECT name, included_mixers, included_large_mixers FROM drinks
          WHERE id = $1 AND nightclub_id = $2 FOR UPDATE`,
        [drinkId, nightclubId]);
      if (prev.rowCount === 0) throw ApiError.notFound('Producto no encontrado');
      await client.query(
        `UPDATE drinks SET included_mixers = $3,
                included_large_mixers = COALESCE($4, included_large_mixers), updated_at = now()
          WHERE id = $1 AND nightclub_id = $2`,
        [drinkId, nightclubId, value, large ?? null]);
      await client.query(
        `INSERT INTO audit_log (nightclub_id, actor_id, action, entity, entity_id, before, after, ip)
         VALUES ($1,$2,'drink_included_mixers_set','drink',$3,$4,$5,$6)`,
        [nightclubId, req.user.id, drinkId,
          JSON.stringify({ included_mixers: prev.rows[0].included_mixers,
            included_large_mixers: prev.rows[0].included_large_mixers }),
          JSON.stringify({ included_mixers: value,
            included_large_mixers: large ?? prev.rows[0].included_large_mixers }), req.ip || null]);
      await client.query('COMMIT');
      res.json({ drink: { id: drinkId, name: prev.rows[0].name, included_mixers: value,
        included_large_mixers: large ?? prev.rows[0].included_large_mixers } });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }));

module.exports = router;
