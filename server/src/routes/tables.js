// Floor layout: list tables, seat/release guests, manager layout editing.
'use strict';

const express = require('express');
const { pool } = require('../db/pool');
const { ApiError, asyncHandler } = require('../middleware/errors');
const { validate, z, uuid } = require('../middleware/validate');
const { authenticate, requireRole, sameNightclub } = require('../middleware/auth');
const events = require('../services/events');

const router = express.Router({ mergeParams: true });

router.use('/nightclubs/:nightclubId', authenticate, sameNightclub());

// Tables with their current open occupants (single query, no N+1).
router.get('/nightclubs/:nightclubId/tables',
  validate({
    params: z.object({ nightclubId: uuid }),
    query: z.object({
      section: z.string().trim().max(40).optional(),
      status: z.enum(['available', 'occupied', 'reserved', 'blocked', 'cleaning']).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT t.id, t.code, t.name, t.section, t.type, t.capacity, t.x, t.y, t.radius,
              t.status, t.bottle_service,
              COALESCE(o.occupants, '[]'::json) AS occupants
         FROM tables t
         LEFT JOIN LATERAL (
           SELECT json_agg(json_build_object(
                    'user_id', u.id,
                    'display_name', COALESCE(u.display_name, u.first_name),
                    'seated_at', tc.seated_at)
                  ORDER BY tc.seated_at) AS occupants
             FROM table_occupants tc JOIN users u ON u.id = tc.user_id
            WHERE tc.table_id = t.id AND tc.left_at IS NULL
         ) o ON true
        WHERE t.nightclub_id = $1 AND t.active
          AND ($2::text IS NULL OR t.section = $2)
          AND ($3::text IS NULL OR t.status = $3)
        ORDER BY t.section, t.code`,
      [req.params.nightclubId, req.query.section || null, req.query.status || null],
    );
    res.json({ tables: rows });
  }));

router.post('/nightclubs/:nightclubId/tables/:tableId/seat',
  validate({ params: z.object({ nightclubId: uuid, tableId: uuid }) }),
  asyncHandler(async (req, res) => {
    const { nightclubId, tableId } = req.params;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const table = await client.query(
        `SELECT id, code, capacity, status FROM tables
          WHERE id = $1 AND nightclub_id = $2 AND active FOR UPDATE`,
        [tableId, nightclubId],
      );
      if (table.rowCount === 0) throw ApiError.notFound('Table not found');
      if (['blocked', 'cleaning'].includes(table.rows[0].status)) {
        throw ApiError.conflict(`Table is ${table.rows[0].status}`);
      }

      const seated = await client.query(
        'SELECT count(*)::int AS n FROM table_occupants WHERE table_id = $1 AND left_at IS NULL',
        [tableId],
      );
      if (seated.rows[0].n >= table.rows[0].capacity) throw ApiError.conflict('Table is full');

      // Leave any other table first (one open occupancy per user), and release that
      // table if nobody is left at it — otherwise the floor map shows ghost tables.
      const left = await client.query(
        `UPDATE table_occupants SET left_at = now()
          WHERE user_id = $1 AND left_at IS NULL
          RETURNING table_id`,
        [req.user.id],
      );
      for (const row of left.rows) {
        if (row.table_id === tableId) continue;
        await client.query(
          `UPDATE tables t SET status = 'available'
            WHERE t.id = $1 AND t.status = 'occupied'
              AND NOT EXISTS (
                SELECT 1 FROM table_occupants o WHERE o.table_id = t.id AND o.left_at IS NULL
              )`,
          [row.table_id],
        );
      }
      await client.query('INSERT INTO table_occupants (table_id, user_id) VALUES ($1,$2)', [tableId, req.user.id]);
      await client.query(`UPDATE tables SET status = 'occupied' WHERE id = $1 AND status = 'available'`, [tableId]);

      await events.publish({
        nightclubId, type: 'table_updated', client,
        payload: { table_id: tableId, code: table.rows[0].code, action: 'seated', user_id: req.user.id },
      });
      await client.query('COMMIT');
      res.status(201).json({ seated: true, table_id: tableId });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }));

router.post('/nightclubs/:nightclubId/tables/:tableId/release',
  validate({
    params: z.object({ nightclubId: uuid, tableId: uuid }),
    body: z.object({ user_id: uuid.optional() }).default({}),
  }),
  asyncHandler(async (req, res) => {
    const { nightclubId, tableId } = req.params;
    // Only staff may release someone else.
    const targetUserId = req.body.user_id || req.user.id;
    if (targetUserId !== req.user.id && !['waiter', 'hostess', 'manager', 'admin'].includes(req.user.role)) {
      throw ApiError.forbidden('Only staff can release another guest');
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const upd = await client.query(
        `UPDATE table_occupants tc SET left_at = now()
           FROM tables t
          WHERE tc.table_id = t.id AND t.id = $1 AND t.nightclub_id = $2
            AND tc.user_id = $3 AND tc.left_at IS NULL
          RETURNING tc.id`,
        [tableId, nightclubId, targetUserId],
      );
      if (upd.rowCount === 0) throw ApiError.notFound('No open occupancy for that user at this table');

      const remaining = await client.query(
        'SELECT count(*)::int AS n FROM table_occupants WHERE table_id = $1 AND left_at IS NULL',
        [tableId],
      );
      if (remaining.rows[0].n === 0) {
        await client.query(`UPDATE tables SET status = 'available' WHERE id = $1 AND status = 'occupied'`, [tableId]);
      }
      await events.publish({
        nightclubId, type: 'table_updated', client,
        payload: { table_id: tableId, action: 'released', user_id: targetUserId },
      });
      await client.query('COMMIT');
      res.json({ released: true, table_id: tableId, remaining: remaining.rows[0].n });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }));

// Manager: bulk layout update (coordinates, capacity, section, status).
const layoutItem = z.object({
  id: uuid,
  x: z.number().optional(),
  y: z.number().optional(),
  radius: z.number().positive().optional(),
  section: z.string().trim().max(40).optional(),
  capacity: z.number().int().positive().optional(),
  status: z.enum(['available', 'occupied', 'reserved', 'blocked', 'cleaning']).optional(),
  bottle_service: z.boolean().optional(),
});

router.put('/nightclubs/:nightclubId/tables/layout',
  requireRole('manager'),
  validate({
    params: z.object({ nightclubId: uuid }),
    body: z.object({ tables: z.array(layoutItem).min(1).max(200) }),
  }),
  asyncHandler(async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      let updated = 0;
      for (const t of req.body.tables) {
        const fields = Object.keys(t).filter((k) => k !== 'id');
        if (fields.length === 0) continue;
        const sets = fields.map((f, i) => `${f} = $${i + 3}`).join(', ');
        const r = await client.query(
          `UPDATE tables SET ${sets} WHERE id = $2 AND nightclub_id = $1`,
          [req.params.nightclubId, t.id, ...fields.map((f) => t[f])],
        );
        updated += r.rowCount;
      }
      await events.publish({
        nightclubId: req.params.nightclubId, type: 'table_updated', client,
        payload: { action: 'layout_changed', count: updated },
      });
      await client.query('COMMIT');
      res.json({ updated });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }));

module.exports = router;
