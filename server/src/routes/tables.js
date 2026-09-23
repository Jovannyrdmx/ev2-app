// Floor layout: list tables, seat/release guests, manager layout editing.
'use strict';

const express = require('express');
const { pool } = require('../db/pool');
const { ApiError, asyncHandler } = require('../middleware/errors');
const { validate, z, uuid } = require('../middleware/validate');
const { authenticate, requireRole, sameNightclub } = require('../middleware/auth');
const events = require('../services/events');
const seating = require('../services/seating');
const tickets = require('../services/tickets');

const router = express.Router({ mergeParams: true });

router.use('/nightclubs/:nightclubId', authenticate, sameNightclub());

// Tables with their current open occupants (single query, no N+1).
router.get('/nightclubs/:nightclubId/tables',
  validate({
    params: z.object({ nightclubId: uuid }),
    query: z.object({
      section: z.string().trim().max(40).optional(),
      floor: z.enum(['baja', 'alta', 'ambas']).optional(),
      status: z.enum(['available', 'occupied', 'reserved', 'blocked', 'cleaning']).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT t.id, t.code, t.table_number, t.name, t.section, t.floor, t.type,
              t.capacity, t.x, t.y, t.radius, t.color, t.status, t.bottle_service,
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
          AND ($4::text IS NULL OR t.floor = $4)
        ORDER BY t.floor, t.section, t.table_number NULLS LAST, t.code`,
      [req.params.nightclubId, req.query.section || null, req.query.status || null,
        req.query.floor || null],
    );
    res.json({ tables: rows });
  }));

// Full floor plan: tables plus the landmarks that make the map readable
// (bar, dance floor, DJ booth, entrance, restrooms) and the canvas size.
router.get('/nightclubs/:nightclubId/floor-plan',
  validate({
    params: z.object({ nightclubId: uuid }),
    query: z.object({ floor: z.enum(['baja', 'alta', 'ambas']).optional() }),
  }),
  asyncHandler(async (req, res) => {
    const { nightclubId } = req.params;
    const floor = req.query.floor || null;

    const [club, tables, landmarks] = await Promise.all([
      pool.query('SELECT settings FROM nightclubs WHERE id = $1', [nightclubId]),
      pool.query(
        `SELECT t.id, t.code, t.table_number, t.name, t.section, t.floor, t.type, t.capacity,
                t.x, t.y, t.radius, t.color, t.status, t.bottle_service,
                COALESCE(o.seated, 0)::int AS seated
           FROM tables t
           LEFT JOIN LATERAL (
             SELECT count(*) AS seated FROM table_occupants o
              WHERE o.table_id = t.id AND o.left_at IS NULL
           ) o ON true
          WHERE t.nightclub_id = $1 AND t.active
            AND ($2::text IS NULL OR t.floor = $2)
          ORDER BY t.floor, t.section, t.table_number NULLS LAST, t.code`,
        [nightclubId, floor],
      ),
      pool.query(
        `SELECT code, name, type, description, floor, x, y, width, height
           FROM venue_landmarks
          WHERE nightclub_id = $1 AND active
            AND ($2::text IS NULL OR floor = $2 OR floor = 'ambas')
          ORDER BY sort_order, name`,
        [nightclubId, floor],
      ),
    ]);

    const settings = club.rows[0] ? club.rows[0].settings : {};
    res.json({
      canvas: (settings && settings.floor_plan && settings.floor_plan.canvas) || null,
      floors: [...new Set(tables.rows.map((t) => t.floor))],
      tables: tables.rows,
      landmarks: landmarks.rows,
    });
  }));

// Occupancy for the manager: how full the room is, by floor and by section.
router.get('/nightclubs/:nightclubId/tables/stats',
  requireRole('waiter', 'hostess', 'bartender', 'manager'),
  validate({ params: z.object({ nightclubId: uuid }) }),
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT t.floor, t.section,
              count(*)::int AS tables,
              count(*) FILTER (WHERE t.status = 'occupied')::int AS occupied,
              count(*) FILTER (WHERE t.status = 'available')::int AS available,
              count(*) FILTER (WHERE t.status = 'reserved')::int AS reserved,
              count(*) FILTER (WHERE t.status IN ('blocked','cleaning'))::int AS out_of_service,
              sum(t.capacity)::int AS seats,
              COALESCE(sum(o.seated), 0)::int AS guests
         FROM tables t
         LEFT JOIN LATERAL (
           SELECT count(*) AS seated FROM table_occupants o
            WHERE o.table_id = t.id AND o.left_at IS NULL
         ) o ON true
        WHERE t.nightclub_id = $1 AND t.active
        GROUP BY ROLLUP (t.floor, t.section)
        ORDER BY t.floor NULLS LAST, t.section NULLS LAST`,
      [req.params.nightclubId],
    );

    const pct = (part, whole) => (whole > 0 ? Math.round((part / whole) * 100) : 0);
    const decorate = (r) => ({
      tables: r.tables,
      occupied: r.occupied,
      available: r.available,
      reserved: r.reserved,
      out_of_service: r.out_of_service,
      seats: r.seats,
      guests: r.guests,
      tables_occupied_pct: pct(r.occupied, r.tables),
      seats_used_pct: pct(r.guests, r.seats),
    });

    // ROLLUP yields per-section rows, per-floor subtotals (section NULL) and one grand
    // total (both NULL).
    const total = rows.find((r) => r.floor === null);
    const floors = rows.filter((r) => r.floor !== null && r.section === null)
      .map((r) => ({
        floor: r.floor,
        ...decorate(r),
        sections: rows.filter((s) => s.floor === r.floor && s.section !== null)
          .map((s) => ({ section: s.section, ...decorate(s) })),
      }));

    res.json({
      total: total ? decorate(total) : decorate({ tables: 0, occupied: 0, available: 0, reserved: 0, out_of_service: 0, seats: 0, guests: 0 }),
      floors,
      generated_at: new Date().toISOString(),
    });
  }));

/**
 * Sentar a alguien en una mesa.
 *
 * SOLO el personal. Un cliente ya no se sienta tocando el mapa: en este club se
 * entra por la puerta, y es el escaneo del pase —o el personal, a mano— lo que
 * sienta a una mesa. Cuando cualquiera podía sentarse solo, una mesa VIP se
 * podía "ocupar" desde la banqueta y el plano dejaba de decir la verdad.
 *
 * Esta ruta es la salida manual para lo que el escaneo no cubre: mover a alguien
 * de mesa, o sentar a quien llegó sin pase y el gerente decidió acomodar.
 */
router.post('/nightclubs/:nightclubId/tables/:tableId/seat',
  requireRole('waiter', 'hostess', 'manager', 'admin'),
  validate({
    params: z.object({ nightclubId: uuid, tableId: uuid }),
    body: z.object({ user_id: uuid }),
  }),
  asyncHandler(async (req, res) => {
    const { nightclubId, tableId } = req.params;
    const targetUserId = req.body.user_id;
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

      const persona = await client.query(
        'SELECT id FROM users WHERE id = $1 AND nightclub_id = $2',
        [targetUserId, nightclubId]);
      if (persona.rowCount === 0) throw ApiError.notFound('User not found');

      const seated = await client.query(
        'SELECT count(*)::int AS n FROM table_occupants WHERE table_id = $1 AND left_at IS NULL',
        [tableId],
      );
      if (seated.rows[0].n >= table.rows[0].capacity) throw ApiError.conflict('Table is full');

      await seating.seatUser(client, { tableId, userId: targetUserId });

      await events.publish({
        nightclubId, type: 'table_updated', client,
        payload: { table_id: tableId, code: table.rows[0].code, action: 'seated', user_id: targetUserId },
      });
      await client.query('COMMIT');
      res.status(201).json({ seated: true, table_id: tableId, user_id: targetUserId });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }));

// Levantar a alguien de una mesa. También solo el personal: quien sienta, levanta.
router.post('/nightclubs/:nightclubId/tables/:tableId/release',
  requireRole('waiter', 'hostess', 'manager', 'admin'),
  validate({
    params: z.object({ nightclubId: uuid, tableId: uuid }),
    // Required, not optional-defaulting-to-the-caller: since only staff can do this,
    // a missing user_id used to mean "the waiter lifts himself from the table", which
    // is not a thing that happens. Now it has to say who is leaving.
    body: z.object({ user_id: uuid }),
  }),
  asyncHandler(async (req, res) => {
    const { nightclubId, tableId } = req.params;
    const targetUserId = req.body.user_id;

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

// ---------------------------------------------------------------- la cuenta (D53)

/**
 * Lo que va en la cuenta de esa mesa.
 *
 * Todo lo que se pidió **desde que esa gente se sentó**, no "lo de hoy": una mesa que
 * se ocupó a las 11 y otra que se ocupó a las 3 tienen cuentas distintas, y contar
 * por noche juntaría la de los que ya se fueron con la de los que acaban de llegar.
 *
 * Se puede leer sin imprimir: el mesero enseña la cuenta en la pantalla cuando el
 * cliente solo quiere saber cuánto lleva.
 */
router.get('/nightclubs/:nightclubId/tables/:tableId/bill',
  requireRole('waiter', 'bartender', 'hostess', 'manager', 'admin'),
  validate({ params: z.object({ nightclubId: uuid, tableId: uuid }) }),
  asyncHandler(async (req, res) => {
    const bill = await tickets.billData(pool, {
      nightclubId: req.params.nightclubId, tableId: req.params.tableId,
    });
    if (!bill) throw ApiError.notFound('Esa mesa no existe');
    res.json({ bill });
  }));

/**
 * Imprime la cuenta en la impresora de meseros de la barra que atiende esa zona.
 *
 * A diferencia de la comanda y del recibo, esta falla con voz: sale porque alguien
 * picó un botón con el cliente enfrente, y quedarse callado lo deja parado mirando
 * la pantalla sin saber si el papel viene o no.
 */
router.post('/nightclubs/:nightclubId/tables/:tableId/bill/print',
  requireRole('waiter', 'bartender', 'hostess', 'manager', 'admin'),
  validate({ params: z.object({ nightclubId: uuid, tableId: uuid }) }),
  asyncHandler(async (req, res) => {
    const out = await tickets.printBill(pool, {
      nightclubId: req.params.nightclubId,
      tableId: req.params.tableId,
      userId: req.user.id,
    });
    if (out.error) throw ApiError.badRequest(out.error);
    res.status(202).json({ job: out.job, bill: out.bill });
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

// ---------------------------------------------------------------------------
// Puntos de entrega
//
// No todo el que pide esta en una mesa. En la pista se pide desde donde se este
// bailando, y el mesero necesita un lugar concreto al que llegar: "Pista A",
// "Pista B", "Terraza". Cada punto tiene su QR pegado en una columna.
//
// El QR lleva un token opaco -- ni el nombre del cliente, ni la mesa, ni nada que
// sirva de algo si alguien le toma una foto. Y solo el personal y la gerencia ven
// ese token: el cliente que escanea no necesita verlo, necesita que funcione.
// ---------------------------------------------------------------------------

const POINT_SELECT = `
  SELECT dp.id, dp.code, dp.name, dp.kind, dp.section, dp.floor,
         dp.client_selectable, dp.active, dp.table_id, t.code AS table_code
    FROM delivery_points dp
    LEFT JOIN tables t ON t.id = dp.table_id`;

router.get('/nightclubs/:nightclubId/delivery-points',
  validate({
    params: z.object({ nightclubId: uuid }),
    query: z.object({
      kind: z.enum(['table', 'floor', 'terrace', 'bar']).optional(),
      include_tables: z.coerce.boolean().default(false),
      include_inactive: z.coerce.boolean().default(false),
    }),
  }),
  asyncHandler(async (req, res) => {
    const q = req.query;
    const staff = ['waiter', 'bartender', 'hostess', 'warehouse', 'manager', 'admin']
      .includes(req.user.role);
    const { rows } = await pool.query(
      `${POINT_SELECT}
        WHERE dp.nightclub_id = $1
          AND ($2::boolean IS TRUE OR dp.active)
          AND ($3::text IS NULL OR dp.kind = $3::text)
          AND ($4::boolean IS TRUE OR dp.kind <> 'table')
          AND ($5::boolean IS TRUE OR dp.client_selectable)
        ORDER BY dp.kind, dp.name`,
      [req.params.nightclubId, q.include_inactive, q.kind || null, q.include_tables, staff],
    );
    res.json({ delivery_points: rows });
  }));

/**
 * Lo que hay detras de un QR pegado en una mesa o en una columna.
 *
 * Es la puerta de "pedir escaneando": el telefono lee el token y pregunta a donde
 * pertenece. Devuelve lo minimo -- el punto y, si es una mesa, cual -- y nunca
 * quien esta sentado ahi.
 */
router.get('/nightclubs/:nightclubId/delivery-points/by-token/:token',
  validate({
    params: z.object({ nightclubId: uuid, token: z.string().trim().min(8).max(64) }),
  }),
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(
      `${POINT_SELECT} WHERE dp.nightclub_id = $1 AND dp.qr_token = $2 AND dp.active`,
      [req.params.nightclubId, req.params.token],
    );
    if (rows.length === 0) throw ApiError.notFound('Ese codigo no corresponde a ningun lugar');
    res.json({ delivery_point: rows[0] });
  }));

/** El QR para imprimir. Solo gerencia: es lo que autoriza a pedir a nombre de un lugar. */
router.get('/nightclubs/:nightclubId/delivery-points/:pointId/qr',
  requireRole('manager', 'admin'),
  validate({ params: z.object({ nightclubId: uuid, pointId: uuid }) }),
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT id, code, name, kind, qr_token FROM delivery_points
        WHERE id = $1 AND nightclub_id = $2`,
      [req.params.pointId, req.params.nightclubId]);
    if (rows.length === 0) throw ApiError.notFound('Punto de entrega no encontrado');
    res.json({ delivery_point: rows[0] });
  }));

router.post('/nightclubs/:nightclubId/delivery-points',
  requireRole('manager', 'admin'),
  validate({
    params: z.object({ nightclubId: uuid }),
    body: z.object({
      code: z.string().trim().min(1).max(30).regex(/^[a-z0-9-]+$/,
        'El codigo va en minusculas, sin espacios ni acentos'),
      name: z.string().trim().min(1).max(80),
      kind: z.enum(['floor', 'terrace', 'bar']),
      floor: z.string().trim().max(10).optional(),
      section: z.string().trim().max(40).optional(),
      client_selectable: z.boolean().default(true),
    }),
  }),
  asyncHandler(async (req, res) => {
    const b = req.body;
    // Token nuevo en cada alta: el QR se imprime una vez y se pega. Reusar uno viejo
    // dejaria dos lugares distintos respondiendo al mismo papel.
    let created;
    try {
      const { rows } = await pool.query(
        `INSERT INTO delivery_points (nightclub_id, code, name, kind, section, floor,
                                      qr_token, client_selectable)
         VALUES ($1,$2,$3,$4,$5,$6, encode(gen_random_bytes(16), 'hex'), $7)
         RETURNING id`,
        [req.params.nightclubId, b.code, b.name, b.kind, b.section || null,
          b.floor || null, b.client_selectable]);
      created = rows[0];
    } catch (err) {
      if (err.code === '23505') throw ApiError.conflict('Ya existe un punto con ese codigo');
      throw err;
    }
    const full = await pool.query(`${POINT_SELECT} WHERE dp.id = $1`, [created.id]);
    res.status(201).json({ delivery_point: full.rows[0] });
  }));

router.patch('/nightclubs/:nightclubId/delivery-points/:pointId',
  requireRole('manager', 'admin'),
  validate({
    params: z.object({ nightclubId: uuid, pointId: uuid }),
    body: z.object({
      name: z.string().trim().min(1).max(80).optional(),
      floor: z.string().trim().max(10).optional(),
      section: z.string().trim().max(40).optional(),
      client_selectable: z.boolean().optional(),
      active: z.boolean().optional(),
      // Girar el token invalida el papel pegado en la columna. Se pide a proposito,
      // porque es justo lo que hay que hacer si alguien fotografio el QR.
      rotate_qr: z.boolean().optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const b = req.body;
    if (Object.keys(b).length === 0) throw ApiError.unprocessable('Nada que cambiar');
    const { rows } = await pool.query(
      `UPDATE delivery_points
          SET name = COALESCE($3, name), floor = COALESCE($4, floor),
              section = COALESCE($5, section),
              client_selectable = COALESCE($6, client_selectable),
              active = COALESCE($7, active),
              qr_token = CASE WHEN $8::boolean IS TRUE
                              THEN encode(gen_random_bytes(16), 'hex') ELSE qr_token END,
              updated_at = now()
        WHERE id = $2 AND nightclub_id = $1
        RETURNING id`,
      [req.params.nightclubId, req.params.pointId, b.name ?? null, b.floor ?? null,
        b.section ?? null, b.client_selectable ?? null, b.active ?? null, b.rotate_qr ?? false]);
    if (rows.length === 0) throw ApiError.notFound('Punto de entrega no encontrado');
    const full = await pool.query(`${POINT_SELECT} WHERE dp.id = $1`, [rows[0].id]);
    res.json({ delivery_point: full.rows[0] });
  }));

module.exports = router;
