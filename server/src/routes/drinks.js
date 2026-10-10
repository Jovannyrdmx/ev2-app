// Drink catalogue (read for everyone signed in; writes for managers).
//
// Las existencias NO viven aqui desde la migracion 018: viven en `supplies`, y lo
// que este archivo publica como `stock` es cuantas unidades alcanzan segun la
// receta del producto. El inventario en si se administra en `routes/inventory.js`.
'use strict';

const express = require('express');
const { pool } = require('../db/pool');
const { ApiError, asyncHandler } = require('../middleware/errors');
const { validate, z, uuid, currency } = require('../middleware/validate');
const { authenticate, requireRole, sameNightclub } = require('../middleware/auth');
const inventory = require('../services/inventory');

const router = express.Router({ mergeParams: true });

router.use('/nightclubs/:nightclubId', authenticate, sameNightclub());

/**
 * De que barra hablamos cuando decimos "cuantos quedan".
 *
 * Un producto no tiene una existencia: tiene una por barra. La del cliente es la de
 * la barra que atiende su mesa; la del cantinero, la de la barra en la que esta
 * parado. Si no hay forma de saberlo, se usa la primera barra del club y la
 * respuesta lo dice, para que la pantalla no presuma un numero de otro lado.
 */
async function resolveBar(nightclubId, req) {
  if (req.query.bar_id) return req.query.bar_id;
  const { rows } = await pool.query(
    `SELECT t.id FROM table_occupants o JOIN tables t ON t.id = o.table_id
      WHERE o.user_id = $1 AND o.left_at IS NULL AND t.nightclub_id = $2 LIMIT 1`,
    [req.user.id, nightclubId]);
  if (rows.length > 0) {
    const bar = await inventory.barForTable(pool, { nightclubId, tableId: rows[0].id });
    if (bar) return bar;
  }
  return inventory.defaultBar(pool, { nightclubId });
}

router.get('/nightclubs/:nightclubId/drinks',
  validate({
    params: z.object({ nightclubId: uuid }),
    query: z.object({
      category: z.string().trim().max(40).optional(),
      available_only: z.coerce.boolean().default(false),
      search: z.string().trim().max(100).optional(),
      bar_id: uuid.optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { category, available_only: availableOnly, search } = req.query;
    const barId = await resolveBar(req.params.nightclubId, req);
    const { rows } = await pool.query(
      // `stock` ya no es un contador del producto: es cuantas unidades ALCANZAN con lo
      // que hay en la bodega, el minimo entre los ingredientes de su receta. Un
      // producto sin receta devuelve `null` -"no se lleva existencia"-, que es
      // distinto de 0. Inventar un numero aqui era lo que hacia inutil al inventario
      // anterior (migracion 018).
      `SELECT d.id, d.name, d.category, d.price, d.currency, d.description, d.image_url,
              d.available, d.sort_order,
              (r.lines > 0) AS stock_tracked,
              CASE WHEN COALESCE(r.lines, 0) = 0 THEN NULL
                   WHEN r.lines <> r.active_lines THEN 0
                   ELSE GREATEST(r.servings, 0) END::int AS stock,
              COALESCE(r.low, false) AS low_stock
         FROM drinks d
         LEFT JOIN LATERAL (
           SELECT count(*)::int AS lines,
                  count(*) FILTER (WHERE s.active)::int AS active_lines,
                  min(floor(COALESCE(ss.stock, 0) / ds.quantity)) FILTER (WHERE s.active) AS servings,
                  bool_or(COALESCE(ss.stock, 0) <= ss.min_stock AND ss.min_stock > 0) AS low
             FROM drink_supplies ds
             JOIN supplies s ON s.id = ds.supply_id
             LEFT JOIN supply_stock ss ON ss.supply_id = s.id AND ss.location_id = $5::uuid
            WHERE ds.drink_id = d.id
         ) r ON true
        WHERE d.nightclub_id = $1
          AND d.active
          AND ($2::text IS NULL OR d.category = $2)
          AND ($3::boolean IS FALSE OR (d.available AND (COALESCE(r.lines, 0) = 0 OR r.servings > 0)))
          AND ($4::text IS NULL OR d.name ILIKE '%' || $4 || '%')
        ORDER BY d.sort_order, d.name`,
      [req.params.nightclubId, category || null, availableOnly, search || null, barId],
    );
    // La barra a la que se refieren esos numeros. Sin esto, "quedan 3" no dice tres
    // donde, y el mesero promete un trago que la otra barra no tiene.
    res.json({ drinks: rows, bar_location_id: barId });
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

const drinkBody = z.object({
  name: z.string().trim().min(1).max(255),
  category: z.string().trim().min(1).max(40),
  price: z.number().min(0),
  currency: currency.default('MXN'),
  description: z.string().trim().max(1000).optional(),
  image_url: z.string().url().max(500).optional(),
  available: z.boolean().default(true),
  sort_order: z.number().int().default(0),
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
    body: drinkBody.partial(),
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
