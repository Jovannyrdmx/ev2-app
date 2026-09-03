// Drink catalogue and inventory (read for everyone signed in; writes for managers).
'use strict';

const express = require('express');
const { pool } = require('../db/pool');
const { ApiError, asyncHandler } = require('../middleware/errors');
const { validate, z, uuid, currency } = require('../middleware/validate');
const { authenticate, requireRole, sameNightclub } = require('../middleware/auth');

const router = express.Router({ mergeParams: true });

router.use('/nightclubs/:nightclubId', authenticate, sameNightclub());

router.get('/nightclubs/:nightclubId/drinks',
  validate({
    params: z.object({ nightclubId: uuid }),
    query: z.object({
      category: z.string().trim().max(40).optional(),
      available_only: z.coerce.boolean().default(false),
      search: z.string().trim().max(100).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { category, available_only: availableOnly, search } = req.query;
    const { rows } = await pool.query(
      `SELECT d.id, d.name, d.category, d.price, d.currency, d.description, d.image_url,
              d.available, d.sort_order,
              COALESCE(i.quantity, 0) AS stock,
              (COALESCE(i.quantity, 0) <= COALESCE(i.low_stock_threshold, 0)) AS low_stock
         FROM drinks d
         LEFT JOIN inventory i ON i.drink_id = d.id
        WHERE d.nightclub_id = $1
          AND d.active
          AND ($2::text IS NULL OR d.category = $2)
          AND ($3::boolean IS FALSE OR (d.available AND COALESCE(i.quantity, 0) > 0))
          AND ($4::text IS NULL OR d.name ILIKE '%' || $4 || '%')
        ORDER BY d.sort_order, d.name`,
      [req.params.nightclubId, category || null, availableOnly, search || null],
    );
    res.json({ drinks: rows });
  }));

router.get('/nightclubs/:nightclubId/drinks/categories',
  validate({ params: z.object({ nightclubId: uuid }) }),
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT category, count(*)::int AS count FROM drinks
        WHERE nightclub_id = $1 AND active GROUP BY category ORDER BY category`,
      [req.params.nightclubId],
    );
    res.json({ categories: rows });
  }));

router.get('/nightclubs/:nightclubId/inventory',
  requireRole('bartender', 'manager'),
  validate({ params: z.object({ nightclubId: uuid }) }),
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT d.id AS drink_id, d.name, d.category, i.quantity, i.unit, i.low_stock_threshold, i.synced_at
         FROM drinks d JOIN inventory i ON i.drink_id = d.id
        WHERE d.nightclub_id = $1 AND d.active
        ORDER BY (i.quantity <= i.low_stock_threshold) DESC, d.name`,
      [req.params.nightclubId],
    );
    res.json({ inventory: rows });
  }));

// Manual stock adjustment; the POS sync (phase 4) is the normal source of truth.
router.put('/nightclubs/:nightclubId/inventory/:drinkId',
  requireRole('manager'),
  validate({
    params: z.object({ nightclubId: uuid, drinkId: uuid }),
    body: z.object({
      quantity: z.number().min(0),
      low_stock_threshold: z.number().min(0).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(
      `UPDATE inventory i
          SET quantity = $3,
              low_stock_threshold = COALESCE($4, i.low_stock_threshold),
              updated_at = now()
         FROM drinks d
        WHERE i.drink_id = d.id AND d.id = $2 AND d.nightclub_id = $1
        RETURNING i.drink_id, i.quantity, i.low_stock_threshold`,
      [req.params.nightclubId, req.params.drinkId, req.body.quantity, req.body.low_stock_threshold ?? null],
    );
    if (rows.length === 0) throw ApiError.notFound('Drink not found in this nightclub');
    res.json({ inventory: rows[0] });
  }));

const drinkBody = z.object({
  name: z.string().trim().min(1).max(255),
  category: z.string().trim().min(1).max(40),
  price: z.number().min(0),
  currency: currency.default('MXN'),
  description: z.string().trim().max(1000).optional(),
  image_url: z.string().url().max(500).optional(),
  available: z.boolean().default(true),
  sort_order: z.number().int().default(0),
  initial_stock: z.number().min(0).default(0),
});

router.post('/nightclubs/:nightclubId/drinks',
  requireRole('manager'),
  validate({ params: z.object({ nightclubId: uuid }), body: drinkBody }),
  asyncHandler(async (req, res) => {
    const b = req.body;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `INSERT INTO drinks (nightclub_id, name, category, price, currency, description, image_url, available, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [req.params.nightclubId, b.name, b.category, b.price, b.currency, b.description || null,
          b.image_url || null, b.available, b.sort_order],
      );
      await client.query(
        `INSERT INTO inventory (drink_id, quantity) VALUES ($1,$2) ON CONFLICT (drink_id) DO NOTHING`,
        [rows[0].id, b.initial_stock],
      );
      await client.query('COMMIT');
      res.status(201).json({ drink: rows[0] });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }));

router.patch('/nightclubs/:nightclubId/drinks/:drinkId',
  requireRole('manager'),
  validate({
    params: z.object({ nightclubId: uuid, drinkId: uuid }),
    body: drinkBody.partial().omit({ initial_stock: true }),
  }),
  asyncHandler(async (req, res) => {
    const fields = Object.keys(req.body);
    if (fields.length === 0) throw ApiError.badRequest('No fields to update');
    const sets = fields.map((f, i) => `${f} = $${i + 3}`).join(', ');
    const { rows } = await pool.query(
      `UPDATE drinks SET ${sets} WHERE id = $2 AND nightclub_id = $1 RETURNING *`,
      [req.params.nightclubId, req.params.drinkId, ...fields.map((f) => req.body[f])],
    );
    if (rows.length === 0) throw ApiError.notFound('Drink not found');
    res.json({ drink: rows[0] });
  }));

module.exports = router;
