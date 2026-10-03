/**
 * Inventario: lugares, insumos, recetas, kardex y movimientos.
 *
 * Es la pantalla de almacen traducida a rutas. Lo que NO esta aqui a proposito:
 * ninguna forma de escribir un saldo directamente. Toda existencia entra por una
 * recepcion, un traspaso, un conteo o un ajuste con motivo, y las cuatro dejan
 * renglon en el kardex. Un endpoint de "poner el saldo en 40" seria el agujero por
 * el que se pierde la capacidad de preguntar a donde se fue el producto.
 *
 * Quien puede que:
 *   - ver existencias: barra, mesero, almacen, gerencia (el cantinero necesita
 *     saber si le queda whisky antes de prometer un trago);
 *   - recibir, traspasar y contar: almacen y gerencia;
 *   - merma, cortesia y salida: almacen y gerencia, y la barra puede reportar
 *     merma DE SU BARRA, que es donde se rompen las botellas;
 *   - dar de alta insumos, editar recetas y reasignar zonas a barras: gerencia.
 */
'use strict';

const express = require('express');
const { pool } = require('../db/pool');
const { ApiError, asyncHandler } = require('../middleware/errors');
const { validate, z, uuid, pagination } = require('../middleware/validate');
const { authenticate, requireRole, sameNightclub } = require('../middleware/auth');
const inventory = require('../services/inventory');
const receiving = require('../services/receiving');
const receiptPhotos = require('./receipts');

const router = express.Router({ mergeParams: true });

router.use('/nightclubs/:nightclubId', authenticate, sameNightclub());

/**
 * El insumo con su existencia en cada lugar y el total.
 *
 * `packages` es la existencia en presentaciones, que es como se cuenta en el
 * estante: "quedan 3.5 botellas" se puede verificar mirando; "quedan 2,630 ml" no.
 */
const SUPPLY_SELECT = `
  SELECT s.id, s.name, s.category, s.unit,
         s.package_size::float8 AS package_size, s.package_label, s.size_confirmed,
         s.avg_cost::float8 AS avg_cost, s.pos_id, s.active, s.updated_at,
         COALESCE(st.total, 0)::float8 AS stock,
         (COALESCE(st.total, 0) / s.package_size)::float8 AS packages,
         (COALESCE(st.total, 0) * s.avg_cost)::float8 AS stock_value,
         COALESCE(st.low, false) AS low,
         COALESCE(st.by_location, '[]'::json) AS locations
    FROM supplies s
    LEFT JOIN LATERAL (
      SELECT sum(ss.stock) AS total,
             bool_or(ss.stock <= ss.min_stock AND ss.min_stock > 0) AS low,
             json_agg(json_build_object(
               'location_id', l.id, 'code', l.code, 'name', l.name, 'kind', l.kind,
               'stock', ss.stock::float8,
               'packages', (ss.stock / s.package_size)::float8,
               'min_stock', ss.min_stock::float8,
               'low', (ss.stock <= ss.min_stock AND ss.min_stock > 0)
             ) ORDER BY l.sort_order, l.code) AS by_location
        FROM supply_stock ss
        JOIN supply_locations l ON l.id = ss.location_id
       WHERE ss.supply_id = s.id
    ) st ON true`;

const LOCATION_SELECT = `
  SELECT l.id, l.code, l.name, l.kind, l.floor, l.sort_order, l.active,
         COALESCE(z.sections, '[]'::json) AS sections
    FROM supply_locations l
    LEFT JOIN LATERAL (
      SELECT json_agg(zb.section ORDER BY zb.section) AS sections
        FROM zone_bars zb WHERE zb.location_id = l.id
    ) z ON true`;

const supplyBody = z.object({
  name: z.string().trim().min(1).max(120),
  category: z.string().trim().max(40).optional(),
  unit: z.enum(inventory.UNITS),
  package_size: z.number().positive().max(1_000_000),
  package_label: z.string().trim().max(60).optional(),
  size_confirmed: z.boolean().optional(),
  pos_id: z.string().trim().max(60).optional(),
});

/** Corre `fn` dentro de una transaccion y devuelve lo que regrese. */
async function inTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** El lugar existe y es de este club. Devuelve su fila, o 404. */
async function findLocation(runner, nightclubId, locationId) {
  const { rows } = await runner.query(
    'SELECT id, code, name, kind FROM supply_locations WHERE id = $1 AND nightclub_id = $2 AND active',
    [locationId, nightclubId]);
  if (rows.length === 0) throw ApiError.notFound('Lugar no encontrado');
  return rows[0];
}

// ---------------------------------------------------------------------- lugares

router.get('/nightclubs/:nightclubId/supply-locations',
  requireRole('bartender', 'waiter', 'warehouse', 'manager', 'admin'),
  validate({
    params: z.object({ nightclubId: uuid }),
    query: z.object({ include_inactive: z.coerce.boolean().default(false) }),
  }),
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(
      `${LOCATION_SELECT}
        WHERE l.nightclub_id = $1 AND ($2::boolean IS TRUE OR l.active)
        ORDER BY l.kind DESC, l.sort_order, l.code`,
      [req.params.nightclubId, req.query.include_inactive],
    );
    res.json({ locations: rows });
  }));

router.post('/nightclubs/:nightclubId/supply-locations',
  requireRole('manager', 'admin'),
  validate({
    params: z.object({ nightclubId: uuid }),
    body: z.object({
      code: z.string().trim().min(1).max(30).regex(/^[a-z0-9-]+$/,
        'El codigo va en minusculas, sin espacios ni acentos'),
      name: z.string().trim().min(1).max(80),
      kind: z.enum(['warehouse', 'bar']),
      floor: z.string().trim().max(10).optional(),
      sort_order: z.number().int().min(0).max(999).default(0),
    }),
  }),
  asyncHandler(async (req, res) => {
    const b = req.body;
    let created;
    try {
      const { rows } = await pool.query(
        `INSERT INTO supply_locations (nightclub_id, code, name, kind, floor, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [req.params.nightclubId, b.code, b.name, b.kind, b.floor || null, b.sort_order]);
      created = rows[0];
    } catch (err) {
      if (err.code === '23505') throw ApiError.conflict('Ya existe un lugar con ese codigo');
      throw err;
    }
    const full = await pool.query(`${LOCATION_SELECT} WHERE l.id = $1`, [created.id]);
    res.status(201).json({ location: full.rows[0] });
  }));

router.patch('/nightclubs/:nightclubId/supply-locations/:locationId',
  requireRole('manager', 'admin'),
  validate({
    params: z.object({ nightclubId: uuid, locationId: uuid }),
    body: z.object({
      name: z.string().trim().min(1).max(80).optional(),
      floor: z.string().trim().max(10).optional(),
      sort_order: z.number().int().min(0).max(999).optional(),
      active: z.boolean().optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const b = req.body;
    if (Object.keys(b).length === 0) throw ApiError.unprocessable('Nada que cambiar');
    // Apagar una barra que todavia atiende zonas dejaria esos pedidos sin barra a
    // media noche. Primero se reasignan las zonas, y el error lo dice.
    if (b.active === false) {
      const zones = await pool.query(
        'SELECT section FROM zone_bars WHERE location_id = $1 ORDER BY section',
        [req.params.locationId]);
      if (zones.rowCount > 0) {
        throw ApiError.conflict('Esta barra todavia atiende zonas: reasignalas primero',
          { sections: zones.rows.map((r) => r.section) });
      }
    }
    const { rows } = await pool.query(
      `UPDATE supply_locations
          SET name = COALESCE($3, name), floor = COALESCE($4, floor),
              sort_order = COALESCE($5, sort_order), active = COALESCE($6, active)
        WHERE id = $2 AND nightclub_id = $1 RETURNING id`,
      [req.params.nightclubId, req.params.locationId, b.name ?? null, b.floor ?? null,
        b.sort_order ?? null, b.active ?? null]);
    if (rows.length === 0) throw ApiError.notFound('Lugar no encontrado');
    const full = await pool.query(`${LOCATION_SELECT} WHERE l.id = $1`, [rows[0].id]);
    res.json({ location: full.rows[0] });
  }));

// ------------------------------------------------------------ zonas por barra

router.get('/nightclubs/:nightclubId/zone-bars',
  requireRole('bartender', 'waiter', 'warehouse', 'manager', 'admin'),
  validate({ params: z.object({ nightclubId: uuid }) }),
  asyncHandler(async (req, res) => {
    // Todas las zonas del plano, tengan barra asignada o no: una zona sin barra es
    // justo lo que el gerente necesita ver antes de que llegue el primer pedido.
    const { rows } = await pool.query(
      `SELECT t.section, t.floor, count(*)::int AS tables,
              zb.location_id, l.code AS bar_code, l.name AS bar_name
         FROM tables t
         LEFT JOIN zone_bars zb ON zb.nightclub_id = t.nightclub_id AND zb.section = t.section
         LEFT JOIN supply_locations l ON l.id = zb.location_id
        WHERE t.nightclub_id = $1 AND t.active
        GROUP BY t.section, t.floor, zb.location_id, l.code, l.name
        ORDER BY t.floor, t.section`,
      [req.params.nightclubId]);
    res.json({
      zones: rows,
      unassigned: rows.filter((r) => !r.location_id).map((r) => r.section),
    });
  }));

router.put('/nightclubs/:nightclubId/zone-bars',
  requireRole('manager', 'admin'),
  validate({
    params: z.object({ nightclubId: uuid }),
    body: z.object({
      assignments: z.array(z.object({
        section: z.string().trim().min(1).max(40),
        // `null` desasigna: la zona vuelve a la barra de su planta.
        location_id: uuid.nullable(),
      })).min(1).max(50),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { nightclubId } = req.params;
    await inTransaction(async (client) => {
      for (const item of req.body.assignments) {
        if (item.location_id === null) {
          await client.query('DELETE FROM zone_bars WHERE nightclub_id = $1 AND section = $2',
            [nightclubId, item.section]);
          continue;
        }
        const bar = await findLocation(client, nightclubId, item.location_id);
        if (bar.kind !== 'bar') throw ApiError.unprocessable('Una zona se asigna a una barra, no al almacen');
        await client.query(
          `INSERT INTO zone_bars (nightclub_id, section, location_id, updated_by)
           VALUES ($1,$2,$3,$4)
           ON CONFLICT (nightclub_id, section)
             DO UPDATE SET location_id = EXCLUDED.location_id,
                           updated_by = EXCLUDED.updated_by, updated_at = now()`,
          [nightclubId, item.section, item.location_id, req.user.id]);
      }
    });
    const { rows } = await pool.query(
      `SELECT zb.section, zb.location_id, l.code AS bar_code, l.name AS bar_name, zb.updated_at
         FROM zone_bars zb JOIN supply_locations l ON l.id = zb.location_id
        WHERE zb.nightclub_id = $1 ORDER BY zb.section`,
      [nightclubId]);
    res.json({ assignments: rows });
  }));

// --------------------------------------------------------------------- insumos

router.get('/nightclubs/:nightclubId/supplies',
  requireRole('bartender', 'waiter', 'warehouse', 'manager', 'admin'),
  validate({
    params: z.object({ nightclubId: uuid }),
    query: z.object({
      search: z.string().trim().max(100).optional(),
      category: z.string().trim().max(40).optional(),
      location_id: uuid.optional(),
      low_only: z.coerce.boolean().default(false),
      unconfirmed_only: z.coerce.boolean().default(false),
      include_inactive: z.coerce.boolean().default(false),
    }),
  }),
  asyncHandler(async (req, res) => {
    const q = req.query;
    const { rows } = await pool.query(
      `${SUPPLY_SELECT}
        WHERE s.nightclub_id = $1
          AND ($2::boolean IS TRUE OR s.active)
          AND ($3::text IS NULL OR s.name ILIKE '%' || $3::text || '%')
          AND ($4::text IS NULL OR s.category = $4::text)
          AND ($5::boolean IS FALSE OR COALESCE(st.low, false))
          AND ($6::boolean IS FALSE OR s.size_confirmed IS FALSE)
          AND ($7::uuid IS NULL OR EXISTS (
                SELECT 1 FROM supply_stock ss
                 WHERE ss.supply_id = s.id AND ss.location_id = $7::uuid))
        ORDER BY COALESCE(st.low, false) DESC, s.category, s.name`,
      [req.params.nightclubId, q.include_inactive, q.search || null, q.category || null,
        q.low_only, q.unconfirmed_only, q.location_id || null],
    );
    res.json({
      supplies: rows,
      // Cuantas presentaciones siguen sin confirmar: es lo que impide fiarse de un
      // conteo, y por eso va en la respuesta y no escondido en un filtro.
      unconfirmed_sizes: rows.filter((r) => r.size_confirmed === false).length,
    });
  }));

router.post('/nightclubs/:nightclubId/supplies',
  requireRole('manager', 'admin'),
  validate({ params: z.object({ nightclubId: uuid }), body: supplyBody }),
  asyncHandler(async (req, res) => {
    const b = req.body;
    let created;
    try {
      const { rows } = await pool.query(
        `INSERT INTO supplies (nightclub_id, name, category, unit, package_size,
                               package_label, size_confirmed, pos_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [req.params.nightclubId, b.name, b.category || null, b.unit, b.package_size,
          b.package_label || null, b.size_confirmed ?? true, b.pos_id || null],
      );
      created = rows[0];
    } catch (err) {
      if (err.code === '23505') throw ApiError.conflict('Ya existe un insumo con ese nombre');
      throw err;
    }
    // Nace en cero a proposito: la existencia entra por una recepcion o un conteo,
    // nunca al darlo de alta. Un saldo inicial tecleado es un numero sin respaldo.
    const { rows } = await pool.query(`${SUPPLY_SELECT} WHERE s.id = $1`, [created.id]);
    res.status(201).json({ supply: rows[0] });
  }));

router.patch('/nightclubs/:nightclubId/supplies/:supplyId',
  requireRole('manager', 'admin'),
  validate({
    params: z.object({ nightclubId: uuid, supplyId: uuid }),
    // `stock` y `avg_cost` no estan: no se editan, se mueven.
    body: supplyBody.partial().extend({ active: z.boolean().optional() }),
  }),
  asyncHandler(async (req, res) => {
    const b = req.body;
    if (Object.keys(b).length === 0) throw ApiError.unprocessable('Nada que cambiar');
    // Cambiar el tamano de la presentacion es confirmarlo: es exactamente el dato
    // que faltaba, y pedirlo dos veces solo consigue que nadie lo confirme.
    const confirmed = b.size_confirmed ?? (b.package_size !== undefined ? true : null);
    const { rows } = await pool.query(
      `UPDATE supplies
          SET name = COALESCE($3, name),
              category = COALESCE($4, category),
              unit = COALESCE($5, unit),
              package_size = COALESCE($6, package_size),
              package_label = COALESCE($7, package_label),
              size_confirmed = COALESCE($8, size_confirmed),
              pos_id = COALESCE($9, pos_id),
              active = COALESCE($10, active),
              updated_at = now()
        WHERE id = $2 AND nightclub_id = $1
        RETURNING id`,
      [req.params.nightclubId, req.params.supplyId, b.name ?? null, b.category ?? null,
        b.unit ?? null, b.package_size ?? null, b.package_label ?? null,
        confirmed, b.pos_id ?? null, b.active ?? null],
    );
    if (rows.length === 0) throw ApiError.notFound('Insumo no encontrado');
    const full = await pool.query(`${SUPPLY_SELECT} WHERE s.id = $1`, [rows[0].id]);
    res.json({ supply: full.rows[0] });
  }));

/** El minimo es por lugar, asi que se fija por lugar. */
router.put('/nightclubs/:nightclubId/supplies/:supplyId/min-stock',
  requireRole('warehouse', 'manager', 'admin'),
  validate({
    params: z.object({ nightclubId: uuid, supplyId: uuid }),
    body: z.object({ location_id: uuid, min_stock: z.number().min(0).max(1_000_000) }),
  }),
  asyncHandler(async (req, res) => {
    const { nightclubId, supplyId } = req.params;
    await findLocation(pool, nightclubId, req.body.location_id);
    const owned = await pool.query('SELECT 1 FROM supplies WHERE id = $1 AND nightclub_id = $2',
      [supplyId, nightclubId]);
    if (owned.rowCount === 0) throw ApiError.notFound('Insumo no encontrado');
    await pool.query(
      `INSERT INTO supply_stock (supply_id, location_id, stock, min_stock)
       VALUES ($1,$2,0,$3)
       ON CONFLICT (supply_id, location_id)
         DO UPDATE SET min_stock = EXCLUDED.min_stock, updated_at = now()`,
      [supplyId, req.body.location_id, req.body.min_stock]);
    const full = await pool.query(`${SUPPLY_SELECT} WHERE s.id = $1`, [supplyId]);
    res.json({ supply: full.rows[0] });
  }));

// ------------------------------------------------------------------ movimientos

const movementReference = {
  reference_type: z.string().trim().max(30).optional(),
  reason: z.string().trim().max(200).optional(),
};

/** Entrada de mercancia: la unica puerta por la que entra producto al club. */
router.post('/nightclubs/:nightclubId/supplies/:supplyId/receive',
  requireRole('warehouse', 'manager', 'admin'),
  validate({
    params: z.object({ nightclubId: uuid, supplyId: uuid }),
    body: z.object({
      location_id: uuid,
      // En presentaciones (`packages`) o en la unidad base (`quantity`). Quien recibe
      // cuenta cajas y botellas, no mililitros; obligarlo a multiplicar de cabeza es
      // como se capturan entradas de 750 unidades en vez de 750 ml.
      quantity: z.number().positive().max(10_000_000).optional(),
      packages: z.number().positive().max(100_000).optional(),
      // Costo de la presentacion completa (lo que dice la factura), no del mililitro.
      package_cost: z.number().min(0).max(1_000_000).optional(),
      ...movementReference,
    }).refine((b) => (b.quantity === undefined) !== (b.packages === undefined),
      { message: 'Captura la cantidad en presentaciones o en la unidad base, no en las dos' }),
  }),
  asyncHandler(async (req, res) => {
    const { nightclubId, supplyId } = req.params;
    const b = req.body;
    const result = await inTransaction(async (client) => {
      await findLocation(client, nightclubId, b.location_id);
      const { rows } = await client.query(
        'SELECT package_size::float8 AS package_size FROM supplies WHERE id = $1 AND nightclub_id = $2',
        [supplyId, nightclubId]);
      if (rows.length === 0) throw ApiError.notFound('Insumo no encontrado');
      const packageSize = Number(rows[0].package_size);
      const quantity = b.quantity !== undefined ? b.quantity : b.packages * packageSize;
      const unitCost = b.package_cost !== undefined ? b.package_cost / packageSize : null;
      return inventory.receive(client, {
        nightclubId, supplyId, locationId: b.location_id, quantity, unitCost,
        referenceType: b.reference_type || null, reason: b.reason || null, userId: req.user.id,
      });
    });
    const full = await pool.query(`${SUPPLY_SELECT} WHERE s.id = $1`, [supplyId]);
    res.status(201).json({ supply: full.rows[0], movement: result });
  }));

/** Traspaso: lo que sale del almacen entra en la barra, con un solo folio. */
router.post('/nightclubs/:nightclubId/supplies/:supplyId/transfer',
  requireRole('warehouse', 'manager', 'admin'),
  validate({
    params: z.object({ nightclubId: uuid, supplyId: uuid }),
    body: z.object({
      from_location_id: uuid,
      to_location_id: uuid,
      quantity: z.number().positive().max(10_000_000).optional(),
      packages: z.number().positive().max(100_000).optional(),
      reason: z.string().trim().max(200).optional(),
    }).refine((b) => (b.quantity === undefined) !== (b.packages === undefined),
      { message: 'Captura la cantidad en presentaciones o en la unidad base, no en las dos' }),
  }),
  asyncHandler(async (req, res) => {
    const { nightclubId, supplyId } = req.params;
    const b = req.body;
    const result = await inTransaction(async (client) => {
      await findLocation(client, nightclubId, b.from_location_id);
      await findLocation(client, nightclubId, b.to_location_id);
      const { rows } = await client.query(
        'SELECT package_size::float8 AS package_size FROM supplies WHERE id = $1 AND nightclub_id = $2',
        [supplyId, nightclubId]);
      if (rows.length === 0) throw ApiError.notFound('Insumo no encontrado');
      const quantity = b.quantity !== undefined ? b.quantity : b.packages * Number(rows[0].package_size);
      return inventory.transfer(client, {
        nightclubId, supplyId, fromLocationId: b.from_location_id,
        toLocationId: b.to_location_id, quantity, reason: b.reason || null, userId: req.user.id,
      });
    });
    const full = await pool.query(`${SUPPLY_SELECT} WHERE s.id = $1`, [supplyId]);
    res.status(201).json({ supply: full.rows[0], transfer: result });
  }));

/** Conteo fisico: se captura lo que hay y el sistema calcula lo que falta. */
router.post('/nightclubs/:nightclubId/supplies/:supplyId/count',
  requireRole('warehouse', 'manager', 'admin'),
  validate({
    params: z.object({ nightclubId: uuid, supplyId: uuid }),
    body: z.object({
      location_id: uuid,
      counted: z.number().min(0).max(10_000_000).optional(),
      counted_packages: z.number().min(0).max(100_000).optional(),
      reason: z.string().trim().max(200).optional(),
    }).refine((b) => (b.counted === undefined) !== (b.counted_packages === undefined),
      { message: 'Captura el conteo en presentaciones o en la unidad base, no en las dos' }),
  }),
  asyncHandler(async (req, res) => {
    const { nightclubId, supplyId } = req.params;
    const b = req.body;
    const outcome = await inTransaction(async (client) => {
      await findLocation(client, nightclubId, b.location_id);
      const { rows } = await client.query(
        'SELECT package_size::float8 AS package_size FROM supplies WHERE id = $1 AND nightclub_id = $2',
        [supplyId, nightclubId]);
      if (rows.length === 0) throw ApiError.notFound('Insumo no encontrado');
      const counted = b.counted !== undefined
        ? b.counted : b.counted_packages * Number(rows[0].package_size);
      return inventory.count(client, {
        nightclubId, supplyId, locationId: b.location_id, counted,
        reason: b.reason, userId: req.user.id,
      });
    });
    const full = await pool.query(`${SUPPLY_SELECT} WHERE s.id = $1`, [supplyId]);
    res.json({
      supply: full.rows[0],
      difference: outcome.difference,
      // Lo que el conteo revela: cuanto se fue sin venderse. Es el numero por el que
      // existe todo lo demas.
      shrinkage: outcome.difference < 0 ? Math.abs(outcome.difference) : 0,
    });
  }));

/** Merma, cortesia, salida y correccion. Todas exigen motivo. */
router.post('/nightclubs/:nightclubId/supplies/:supplyId/adjust',
  requireRole('bartender', 'warehouse', 'manager', 'admin'),
  validate({
    params: z.object({ nightclubId: uuid, supplyId: uuid }),
    body: z.object({
      location_id: uuid,
      kind: z.enum(['adjustment', 'waste', 'courtesy', 'issue']),
      quantity: z.number().refine((n) => n !== 0, 'La cantidad no puede ser cero').optional(),
      packages: z.number().refine((n) => n !== 0, 'La cantidad no puede ser cero').optional(),
      reason: z.string().trim().min(3).max(200),
    }).refine((b) => (b.quantity === undefined) !== (b.packages === undefined),
      { message: 'Captura la cantidad en presentaciones o en la unidad base, no en las dos' }),
  }),
  asyncHandler(async (req, res) => {
    const { nightclubId, supplyId } = req.params;
    const b = req.body;
    // Una correccion de saldo la firma la gerencia: es el unico movimiento que puede
    // SUBIR la existencia sin que haya entrado mercancia, y por ahi se tapa un faltante.
    if (b.kind === 'adjustment' && !['manager', 'admin'].includes(req.user.role)) {
      throw ApiError.forbidden('Una correccion de saldo la autoriza la gerencia');
    }
    await inTransaction(async (client) => {
      await findLocation(client, nightclubId, b.location_id);
      const { rows } = await client.query(
        'SELECT package_size::float8 AS package_size FROM supplies WHERE id = $1 AND nightclub_id = $2',
        [supplyId, nightclubId]);
      if (rows.length === 0) throw ApiError.notFound('Insumo no encontrado');
      const quantity = b.quantity !== undefined ? b.quantity : b.packages * Number(rows[0].package_size);
      return inventory.adjust(client, {
        nightclubId, supplyId, locationId: b.location_id, kind: b.kind, quantity,
        reason: b.reason, userId: req.user.id,
      });
    });
    const full = await pool.query(`${SUPPLY_SELECT} WHERE s.id = $1`, [supplyId]);
    res.json({ supply: full.rows[0] });
  }));

// ---------------------------------------------------------------------- kardex

const MOVEMENT_SELECT = `
  SELECT m.id, m.kind, m.quantity::float8 AS quantity,
         m.balance_after::float8 AS balance_after,
         m.unit_cost::float8 AS unit_cost, m.reference_type, m.reference_id,
         m.reason, m.created_at, m.transfer_group,
         m.supply_id, s.name AS supply_name, s.unit, s.package_size::float8 AS package_size,
         m.location_id, l.code AS location_code, l.name AS location_name,
         m.counterpart_location_id, cl.code AS counterpart_code, cl.name AS counterpart_name,
         m.created_by, u.display_name AS created_by_name,
         m.authorized_by, a.display_name AS authorized_by_name,
         -- Migracion 022: de quien vino, con que captura entro, y que pedido lo
         -- origino. Sin esto, el kardex dice que algo bajo del almacen pero no por
         -- que, y una entrada no dice de quien.
         m.supplier_id, p.name AS supplier_name,
         m.receipt_group, m.request_id
    FROM supply_movements m
    JOIN supplies s ON s.id = m.supply_id
    JOIN supply_locations l ON l.id = m.location_id
    LEFT JOIN supply_locations cl ON cl.id = m.counterpart_location_id
    LEFT JOIN users u ON u.id = m.created_by
    LEFT JOIN users a ON a.id = m.authorized_by
    LEFT JOIN suppliers p ON p.id = m.supplier_id`;

router.get('/nightclubs/:nightclubId/supply-movements',
  requireRole('warehouse', 'manager', 'admin'),
  validate({
    params: z.object({ nightclubId: uuid }),
    query: pagination.extend({
      supply_id: uuid.optional(),
      location_id: uuid.optional(),
      kind: z.enum(inventory.MOVEMENT_KINDS).optional(),
      since: z.coerce.date().optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const q = req.query;
    const { rows } = await pool.query(
      `${MOVEMENT_SELECT}
        WHERE m.nightclub_id = $1
          AND ($2::uuid IS NULL OR m.supply_id = $2::uuid)
          AND ($3::uuid IS NULL OR m.location_id = $3::uuid)
          AND ($4::text IS NULL OR m.kind = $4::text)
          AND ($5::timestamptz IS NULL OR m.created_at >= $5::timestamptz)
        ORDER BY m.created_at DESC, m.id DESC
        LIMIT $6 OFFSET $7`,
      [req.params.nightclubId, q.supply_id || null, q.location_id || null,
        q.kind || null, q.since || null, q.limit, q.offset],
    );
    res.json({ movements: rows });
  }));

router.get('/nightclubs/:nightclubId/supplies/:supplyId/movements',
  requireRole('bartender', 'warehouse', 'manager', 'admin'),
  validate({
    params: z.object({ nightclubId: uuid, supplyId: uuid }),
    query: pagination.extend({ location_id: uuid.optional() }),
  }),
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(
      `${MOVEMENT_SELECT}
        WHERE m.nightclub_id = $1 AND m.supply_id = $2
          AND ($3::uuid IS NULL OR m.location_id = $3::uuid)
        ORDER BY m.created_at DESC, m.id DESC
        LIMIT $4 OFFSET $5`,
      [req.params.nightclubId, req.params.supplyId, req.query.location_id || null,
        req.query.limit, req.query.offset],
    );
    res.json({ movements: rows });
  }));

// ==========================================================================
// Entrada de mercancia en lote
//
// La ruta de un solo insumo (`/supplies/:id/receive`) se queda: sirve para la
// botella suelta y para corregir. Esta es para cuando llega el camion, que es lo
// normal, y su diferencia no es la comodidad: es que las quince lineas entran en
// UNA transaccion. Con la ruta de a una, la novena puede fallar y quedan ocho
// adentro y siete afuera, y nadie sabe cuales ocho hasta contar el estante.
// ==========================================================================

const receiptLine = z.object({
  supply_id: uuid,
  quantity: z.number().positive().max(10_000_000).optional(),
  packages: z.number().positive().max(100_000).optional(),
  // Lo que dice el renglon de la factura: el costo de la PRESENTACION completa.
  package_cost: z.number().min(0).max(1_000_000).optional(),
  reason: z.string().trim().max(200).optional(),
}).refine((l) => (l.quantity === undefined) !== (l.packages === undefined),
  { message: 'Captura la cantidad en presentaciones o en la unidad base, no en las dos' });

router.post('/nightclubs/:nightclubId/supply-receipts',
  requireRole('warehouse', 'manager', 'admin'),
  validate({
    params: z.object({ nightclubId: uuid }),
    body: z.object({
      location_id: uuid,
      // Opcional a proposito: una entrega de un proveedor que todavia no esta en el
      // catalogo no se puede quedar sin capturar por eso.
      supplier_id: uuid.optional(),
      // La foto del ticket o la factura de la que salio esta captura, si hubo una.
      // Amarrarlas es lo que despues contesta "este tequila lo pagamos a 900 o a
      // 1,100" sin buscar el papel, y lo que evita capturar la misma entrega dos
      // veces: una foto se usa UNA vez, y el segundo intento choca.
      photo_id: uuid.optional(),
      lines: z.array(receiptLine).min(1).max(receiving.MAX_LINES),
      reason: z.string().trim().max(200).optional(),
      reference_type: z.string().trim().max(30).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { nightclubId } = req.params;
    const b = req.body;
    const result = await inTransaction(async (client) => {
      const lugar = await findLocation(client, nightclubId, b.location_id);
      const lote = await receiving.receiveBatch(client, {
        nightclubId,
        locationId: lugar.id,
        supplierId: b.supplier_id || null,
        lines: b.lines,
        reason: b.reason || null,
        referenceType: b.reference_type || null,
        userId: req.user.id,
      });
      // Dentro de la misma transaccion: si la foto ya se habia capturado, la entrada
      // NO entra. Es la proteccion contra el doble toque en un telefono lento, que de
      // otro modo mete la misma entrega dos veces al inventario.
      if (b.photo_id) {
        await receiptPhotos.markUsed(client, {
          nightclubId, photoId: b.photo_id, receiptGroup: lote.receipt_group,
        });
      }
      return lote;
    });
    res.status(201).json({ receipt: result });
  }));

/** Una captura completa, por su folio. Es a lo que se vuelve cuando algo no cuadra. */
router.get('/nightclubs/:nightclubId/supply-receipts/:group',
  requireRole('warehouse', 'manager', 'admin'),
  validate({ params: z.object({ nightclubId: uuid, group: uuid }) }),
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(
      `${MOVEMENT_SELECT}
        WHERE m.nightclub_id = $1 AND m.receipt_group = $2
        ORDER BY s.name`,
      [req.params.nightclubId, req.params.group]);
    if (rows.length === 0) throw ApiError.notFound('Esa captura no existe');

    const conCosto = rows.filter((r) => r.unit_cost !== null);
    res.json({
      receipt: {
        receipt_group: req.params.group,
        location_id: rows[0].location_id,
        location_name: rows[0].location_name,
        supplier_id: rows[0].supplier_id,
        supplier_name: rows[0].supplier_name,
        created_at: rows[0].created_at,
        created_by_name: rows[0].created_by_name,
        lines: rows,
        total: Number(conCosto.reduce((s, r) => s + r.quantity * r.unit_cost, 0).toFixed(2)),
        // Si algun renglon entro sin costo, el total NO cuadra con el papel. Se dice,
        // en vez de dar un numero que parece exacto.
        total_is_complete: conCosto.length === rows.length,
      },
    });
  }));

/** Las ultimas capturas, una linea por entrega. La bitacora de compras. */
router.get('/nightclubs/:nightclubId/supply-receipts',
  requireRole('warehouse', 'manager', 'admin'),
  validate({
    params: z.object({ nightclubId: uuid }),
    query: pagination.extend({ supplier_id: uuid.optional() }),
  }),
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT m.receipt_group,
              min(m.created_at)                       AS created_at,
              count(*)::int                           AS line_count,
              max(l.name)                             AS location_name,
              max(p.name)                             AS supplier_name,
              max(u.display_name)                     AS created_by_name,
              sum(m.quantity * m.unit_cost)::float8   AS total,
              bool_and(m.unit_cost IS NOT NULL)       AS total_is_complete
         FROM supply_movements m
         JOIN supply_locations l ON l.id = m.location_id
         LEFT JOIN suppliers p ON p.id = m.supplier_id
         LEFT JOIN users u ON u.id = m.created_by
        WHERE m.nightclub_id = $1 AND m.receipt_group IS NOT NULL
          AND ($2::uuid IS NULL OR m.supplier_id = $2::uuid)
        GROUP BY m.receipt_group
        ORDER BY min(m.created_at) DESC
        LIMIT $3 OFFSET $4`,
      [req.params.nightclubId, req.query.supplier_id || null,
        req.query.limit, req.query.offset]);
    res.json({ receipts: rows });
  }));

// ==========================================================================
// Pedidos de barra: la barra pide, el almacen surte
//
// El orden importa y es el del club real: quien sabe que falta es el cantinero
// mirando su estante a las once de la noche, no el almacenista a las seis de la
// tarde. Antes de esto, surtir era una orden hacia abajo y lo que faltaba se
// resolvia de palabra -- que es como acaba producto en la barra sin registro.
// ==========================================================================

const requestLine = z.object({
  supply_id: uuid,
  quantity: z.number().positive().max(10_000_000).optional(),
  packages: z.number().positive().max(100_000).optional(),
}).refine((l) => (l.quantity === undefined) !== (l.packages === undefined),
  { message: 'Captura la cantidad en presentaciones o en la unidad base, no en las dos' });

/** Lo que esta barra deberia pedir: sus insumos bajo el minimo, con lo que hay en almacen. */
router.get('/nightclubs/:nightclubId/bar-requests/suggested',
  requireRole('bartender', 'warehouse', 'manager', 'admin'),
  validate({
    params: z.object({ nightclubId: uuid }),
    query: z.object({ location_id: uuid }),
  }),
  asyncHandler(async (req, res) => {
    const lugar = await findLocation(pool, req.params.nightclubId, req.query.location_id);
    if (lugar.kind !== 'bar') throw ApiError.unprocessable('Ese lugar no es una barra');
    res.json({
      location_id: lugar.id,
      location_name: lugar.name,
      suggested: await receiving.suggestForBar(pool, {
        nightclubId: req.params.nightclubId, locationId: lugar.id,
      }),
    });
  }));

router.get('/nightclubs/:nightclubId/bar-requests',
  requireRole('bartender', 'warehouse', 'manager', 'admin'),
  validate({
    params: z.object({ nightclubId: uuid }),
    query: pagination.extend({
      location_id: uuid.optional(),
      // Por omision solo lo que falta por surtir: es la bandeja de trabajo del
      // almacen, y enterrarla bajo los pedidos de anoche la vuelve inservible.
      status: z.enum(['open', 'partial', 'fulfilled', 'cancelled', 'pending', 'all'])
        .default('pending'),
    }),
  }),
  asyncHandler(async (req, res) => {
    const q = req.query;
    const estados = q.status === 'pending' ? receiving.OPEN_STATUSES
      : (q.status === 'all' ? null : [q.status]);
    const { rows } = await pool.query(
      `SELECT r.id, r.location_id, l.name AS location_name, l.code AS location_code,
              r.status, r.note, r.created_at, r.fulfilled_at, r.cancel_reason,
              u.display_name AS requested_by_name,
              f.display_name AS fulfilled_by_name,
              COALESCE(li.lines, '[]'::json) AS lines,
              COALESCE(li.pending_lines, 0)::int AS pending_lines
         FROM bar_requests r
         JOIN supply_locations l ON l.id = r.location_id
         LEFT JOIN users u ON u.id = r.requested_by
         LEFT JOIN users f ON f.id = r.fulfilled_by
         LEFT JOIN LATERAL (
           SELECT json_agg(json_build_object(
                    'supply_id', s.id, 'name', s.name, 'unit', s.unit,
                    'package_size', s.package_size::float8,
                    'package_label', s.package_label,
                    'quantity', bl.quantity::float8,
                    'fulfilled', bl.fulfilled::float8,
                    'pending', GREATEST(bl.quantity - bl.fulfilled, 0)::float8
                  ) ORDER BY s.name) AS lines,
                  count(*) FILTER (WHERE bl.fulfilled < bl.quantity) AS pending_lines
             FROM bar_request_lines bl JOIN supplies s ON s.id = bl.supply_id
            WHERE bl.request_id = r.id
         ) li ON true
        WHERE r.nightclub_id = $1
          AND ($2::uuid IS NULL OR r.location_id = $2::uuid)
          AND ($3::text[] IS NULL OR r.status = ANY($3::text[]))
        ORDER BY r.created_at DESC
        LIMIT $4 OFFSET $5`,
      [req.params.nightclubId, q.location_id || null, estados, q.limit, q.offset]);
    res.json({ requests: rows });
  }));

router.post('/nightclubs/:nightclubId/bar-requests',
  requireRole('bartender', 'warehouse', 'manager', 'admin'),
  validate({
    params: z.object({ nightclubId: uuid }),
    body: z.object({
      location_id: uuid,
      lines: z.array(requestLine).min(1).max(receiving.MAX_LINES),
      note: z.string().trim().max(300).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { nightclubId } = req.params;
    const result = await inTransaction(async (client) => {
      const lugar = await findLocation(client, nightclubId, req.body.location_id);
      if (lugar.kind !== 'bar') throw ApiError.unprocessable('Solo una barra pide al almacen');
      return receiving.createRequest(client, {
        nightclubId,
        locationId: lugar.id,
        lines: req.body.lines,
        note: req.body.note || null,
        userId: req.user.id,
      });
    });
    res.status(201).json({ request: result });
  }));

/**
 * Surtir. Solo almacen y gerencia: quien pide no se surte a si mismo, porque es
 * justo la separacion que hace que un faltante tenga dos nombres y no uno.
 */
router.post('/nightclubs/:nightclubId/bar-requests/:requestId/fulfill',
  requireRole('warehouse', 'manager', 'admin'),
  validate({
    params: z.object({ nightclubId: uuid, requestId: uuid }),
    body: z.object({
      from_location_id: uuid,
      // Sin `lines`, se surte todo lo que falte. Con `lines`, solo eso -- que es lo
      // que pasa cuando el almacenista manda la mitad y deja el resto para luego.
      lines: z.array(requestLine).min(1).max(receiving.MAX_LINES).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { nightclubId, requestId } = req.params;
    const result = await inTransaction(async (client) => {
      const origen = await findLocation(client, nightclubId, req.body.from_location_id);
      return receiving.fulfillRequest(client, {
        nightclubId,
        requestId,
        fromLocationId: origen.id,
        lines: req.body.lines || null,
        userId: req.user.id,
      });
    });
    res.json(result);
  }));

router.post('/nightclubs/:nightclubId/bar-requests/:requestId/cancel',
  requireRole('bartender', 'warehouse', 'manager', 'admin'),
  validate({
    params: z.object({ nightclubId: uuid, requestId: uuid }),
    body: z.object({ reason: z.string().trim().min(3).max(200) }),
  }),
  asyncHandler(async (req, res) => {
    const result = await inTransaction((client) => receiving.cancelRequest(client, {
      nightclubId: req.params.nightclubId,
      requestId: req.params.requestId,
      reason: req.body.reason,
      userId: req.user.id,
    }));
    res.json({ request: result });
  }));

router.get('/nightclubs/:nightclubId/bar-requests/:requestId',
  requireRole('bartender', 'warehouse', 'manager', 'admin'),
  validate({ params: z.object({ nightclubId: uuid, requestId: uuid }) }),
  asyncHandler(async (req, res) => {
    res.json({
      request: await receiving.loadRequest(pool, {
        nightclubId: req.params.nightclubId, requestId: req.params.requestId,
      }),
    });
  }));

// --------------------------------------------------------------------- recetas

router.get('/nightclubs/:nightclubId/recipes',
  requireRole('warehouse', 'manager', 'admin'),
  validate({
    params: z.object({ nightclubId: uuid }),
    query: z.object({ missing_only: z.coerce.boolean().default(false) }),
  }),
  asyncHandler(async (req, res) => {
    // Los productos SIN receta salen primero: son los que todavia no tienen control
    // de existencia, y saber cuantos faltan es la mitad del trabajo del gerente
    // mientras se carga el inventario por primera vez.
    const { rows } = await pool.query(
      `SELECT d.id AS drink_id, d.name, d.category, d.price::text AS price,
              COALESCE(json_agg(json_build_object(
                'supply_id', s.id, 'name', s.name, 'unit', s.unit,
                'quantity', ds.quantity::float8,
                'package_size', s.package_size::float8
              ) ORDER BY s.name) FILTER (WHERE s.id IS NOT NULL), '[]'::json) AS items,
              -- Lo que cuesta servirlo hoy, con el costo promedio de cada insumo.
              COALESCE(sum(ds.quantity * s.avg_cost), 0)::float8 AS cost
         FROM drinks d
         LEFT JOIN drink_supplies ds ON ds.drink_id = d.id
         LEFT JOIN supplies s ON s.id = ds.supply_id
        WHERE d.nightclub_id = $1 AND d.active
        GROUP BY d.id
       HAVING ($2::boolean IS FALSE OR count(ds.supply_id) = 0)
        ORDER BY count(ds.supply_id) = 0 DESC, d.category, d.name`,
      [req.params.nightclubId, req.query.missing_only],
    );
    res.json({
      recipes: rows,
      without_recipe: rows.filter((r) => r.items.length === 0).length,
    });
  }));

router.put('/nightclubs/:nightclubId/recipes/:drinkId',
  requireRole('manager', 'admin'),
  validate({
    params: z.object({ nightclubId: uuid, drinkId: uuid }),
    body: z.object({
      items: z.array(z.object({
        supply_id: uuid,
        quantity: z.number().positive().max(1_000_000),
      })).max(20),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { nightclubId, drinkId } = req.params;
    const items = req.body.items;
    const ids = items.map((i) => i.supply_id);
    if (new Set(ids).size !== ids.length) {
      throw ApiError.unprocessable('Un insumo no puede ir dos veces en la misma receta');
    }

    await inTransaction(async (client) => {
      const drink = await client.query(
        'SELECT id FROM drinks WHERE id = $1 AND nightclub_id = $2', [drinkId, nightclubId]);
      if (drink.rowCount === 0) throw ApiError.notFound('Producto no encontrado');

      if (ids.length > 0) {
        const found = await client.query(
          'SELECT id FROM supplies WHERE id = ANY($1::uuid[]) AND nightclub_id = $2',
          [ids, nightclubId]);
        if (found.rowCount !== ids.length) throw ApiError.notFound('Algun insumo no existe en este club');
      }

      // Se reemplaza entera: una receta es una lista, no un historial. El kardex ya
      // guarda lo que de verdad salio con la receta anterior.
      await client.query('DELETE FROM drink_supplies WHERE drink_id = $1', [drinkId]);
      for (const item of items) {
        await client.query(
          'INSERT INTO drink_supplies (drink_id, supply_id, quantity) VALUES ($1,$2,$3)',
          [drinkId, item.supply_id, item.quantity]);
      }
    });

    const recipes = await inventory.recipesFor(pool, { nightclubId, drinkIds: [drinkId] });
    const recipe = recipes.get(drinkId) || [];
    res.json({
      recipe: {
        drink_id: drinkId,
        items: recipe.map((r) => ({
          supply_id: r.supply_id, name: r.name, unit: r.unit, quantity: r.quantity,
        })),
      },
    });
  }));

module.exports = router;
