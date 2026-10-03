/**
 * Proveedores: a quién le compra el club, y quién surte qué.
 *
 * Va en su propio archivo y no dentro de `inventory.js` porque es un catálogo, no
 * un movimiento: aquí no se mueve una sola existencia. Mezclarlos haría que el
 * archivo que mueve dinero y producto creciera con altas de contactos.
 *
 * Quién puede qué:
 *   - ver la lista: almacén y gerencia (es quien captura entradas);
 *   - dar de alta, editar y apagar: gerencia. Un proveedor nuevo es una decisión de
 *     compras, y quien recibe mercancía no debería poder inventarse el origen de una
 *     caja para justificarla.
 *
 * No hay borrado, solo baja lógica. Un proveedor con compras capturadas no se puede
 * borrar sin dejar huérfano el historial, y el historial de compras es justo lo que
 * contesta "¿por qué subió el costo del whisky?".
 */
'use strict';

const express = require('express');
const { pool } = require('../db/pool');
const { ApiError, asyncHandler } = require('../middleware/errors');
const { validate, z, uuid } = require('../middleware/validate');
const { authenticate, requireRole, sameNightclub } = require('../middleware/auth');

const router = express.Router({ mergeParams: true });

router.use('/nightclubs/:nightclubId', authenticate, sameNightclub());

/**
 * El proveedor con lo que de verdad se le pregunta: cuántos insumos surte, cuándo
 * fue la última compra y cuánto se le ha comprado.
 *
 * `purchases` suma solo movimientos de entrada con costo. Los renglones capturados
 * sin costo no se pueden sumar en pesos, y sumarlos como cero daría un total que
 * parece exacto y está mal — peor que no dar total.
 */
const SUPPLIER_SELECT = `
  SELECT p.id, p.name, p.contact_name, p.phone, p.email, p.notes, p.active,
         p.created_at, p.updated_at,
         COALESCE(s.supplies, 0)::int AS supply_count,
         s.last_bought_at,
         COALESCE(m.purchases, 0)::float8 AS purchases_total,
         m.last_receipt_at
    FROM suppliers p
    LEFT JOIN LATERAL (
      SELECT count(*) AS supplies, max(last_bought_at) AS last_bought_at
        FROM supply_suppliers ss WHERE ss.supplier_id = p.id
    ) s ON true
    LEFT JOIN LATERAL (
      SELECT sum(sm.quantity * sm.unit_cost) AS purchases, max(sm.created_at) AS last_receipt_at
        FROM supply_movements sm
       WHERE sm.supplier_id = p.id AND sm.kind = 'receipt' AND sm.unit_cost IS NOT NULL
    ) m ON true`;

const supplierBody = z.object({
  name: z.string().trim().min(1).max(120),
  contact_name: z.string().trim().max(120).optional(),
  phone: z.string().trim().max(30).optional(),
  email: z.string().trim().email().max(255).optional(),
  notes: z.string().trim().max(400).optional(),
});

/** 23505 aquí solo puede ser el único por nombre. Se explica en vez de reventar. */
function asConflict(err) {
  if (err.code === '23505') {
    return ApiError.conflict('Ya existe un proveedor con ese nombre en este club');
  }
  return err;
}

// ------------------------------------------------------------------- catálogo

router.get('/nightclubs/:nightclubId/suppliers',
  requireRole('warehouse', 'manager', 'admin'),
  validate({
    params: z.object({ nightclubId: uuid }),
    query: z.object({
      // Por omisión solo los activos: la lista sirve para capturar una entrada, y
      // un proveedor apagado no debería poder elegirse por descuido.
      include_inactive: z.enum(['true', 'false']).optional(),
      search: z.string().trim().max(120).optional(),
    }).default({}),
  }),
  asyncHandler(async (req, res) => {
    const filtros = ['p.nightclub_id = $1'];
    const args = [req.params.nightclubId];
    if (req.query.include_inactive !== 'true') filtros.push('p.active');
    if (req.query.search) {
      args.push(`%${req.query.search}%`);
      filtros.push(`(p.name ILIKE $${args.length} OR p.contact_name ILIKE $${args.length})`);
    }
    const { rows } = await pool.query(
      `${SUPPLIER_SELECT} WHERE ${filtros.join(' AND ')} ORDER BY p.active DESC, p.name`, args);
    res.json({ suppliers: rows });
  }));

router.get('/nightclubs/:nightclubId/suppliers/:supplierId',
  requireRole('warehouse', 'manager', 'admin'),
  validate({ params: z.object({ nightclubId: uuid, supplierId: uuid }) }),
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(
      `${SUPPLIER_SELECT} WHERE p.id = $2 AND p.nightclub_id = $1`,
      [req.params.nightclubId, req.params.supplierId]);
    if (rows.length === 0) throw ApiError.notFound('Proveedor no encontrado');

    // Y lo que surte, con lo que cobró la última vez. Es lo que la pantalla de
    // captura usa para precargar los renglones de una entrega.
    const { rows: surte } = await pool.query(
      `SELECT ss.supply_id, s.name, s.unit, s.package_size::float8 AS package_size,
              s.package_label, s.avg_cost::float8 AS avg_cost,
              ss.last_cost::float8 AS last_cost, ss.last_bought_at
         FROM supply_suppliers ss
         JOIN supplies s ON s.id = ss.supply_id
        WHERE ss.supplier_id = $1 AND s.nightclub_id = $2
        ORDER BY s.name`,
      [req.params.supplierId, req.params.nightclubId]);

    res.json({ supplier: rows[0], supplies: surte });
  }));

router.post('/nightclubs/:nightclubId/suppliers',
  requireRole('manager', 'admin'),
  validate({ params: z.object({ nightclubId: uuid }), body: supplierBody }),
  asyncHandler(async (req, res) => {
    const b = req.body;
    let created;
    try {
      created = await pool.query(
        `INSERT INTO suppliers (nightclub_id, name, contact_name, phone, email, notes)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [req.params.nightclubId, b.name, b.contact_name || null, b.phone || null,
          b.email || null, b.notes || null]);
    } catch (err) {
      throw asConflict(err);
    }
    const { rows } = await pool.query(`${SUPPLIER_SELECT} WHERE p.id = $1`, [created.rows[0].id]);
    res.status(201).json({ supplier: rows[0] });
  }));

router.patch('/nightclubs/:nightclubId/suppliers/:supplierId',
  requireRole('manager', 'admin'),
  validate({
    params: z.object({ nightclubId: uuid, supplierId: uuid }),
    body: supplierBody.partial().extend({ active: z.boolean().optional() }),
  }),
  asyncHandler(async (req, res) => {
    const campos = [];
    const args = [req.params.supplierId, req.params.nightclubId];
    for (const campo of ['name', 'contact_name', 'phone', 'email', 'notes', 'active']) {
      if (req.body[campo] !== undefined) {
        args.push(req.body[campo]);
        campos.push(`${campo} = $${args.length}`);
      }
    }
    if (campos.length === 0) throw ApiError.badRequest('No hay nada que cambiar');

    let actualizado;
    try {
      actualizado = await pool.query(
        `UPDATE suppliers SET ${campos.join(', ')} WHERE id = $1 AND nightclub_id = $2 RETURNING id`,
        args);
    } catch (err) {
      throw asConflict(err);
    }
    if (actualizado.rowCount === 0) throw ApiError.notFound('Proveedor no encontrado');

    const { rows } = await pool.query(`${SUPPLIER_SELECT} WHERE p.id = $1`,
      [req.params.supplierId]);
    res.json({ supplier: rows[0] });
  }));

// ------------------------------------------------------------- quién surte qué

/**
 * Los proveedores de un insumo.
 *
 * Se reemplaza la lista completa en vez de agregar y quitar de a uno: es como lo
 * ve el gerente en la pantalla (una lista de casillas) y así no hay dos rutas que
 * puedan dejar el conjunto a medias.
 *
 * `last_cost` de los que ya estaban NO se pisa: es historia de compras, y esta ruta
 * edita una relación, no un precio.
 */
router.put('/nightclubs/:nightclubId/supplies/:supplyId/suppliers',
  requireRole('manager', 'admin'),
  validate({
    params: z.object({ nightclubId: uuid, supplyId: uuid }),
    body: z.object({ supplier_ids: z.array(uuid).max(20) }),
  }),
  asyncHandler(async (req, res) => {
    const { nightclubId, supplyId } = req.params;
    const ids = [...new Set(req.body.supplier_ids)];

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const insumo = await client.query(
        'SELECT 1 FROM supplies WHERE id = $1 AND nightclub_id = $2', [supplyId, nightclubId]);
      if (insumo.rowCount === 0) throw ApiError.notFound('Insumo no encontrado');

      if (ids.length > 0) {
        const validos = await client.query(
          'SELECT id FROM suppliers WHERE id = ANY($1::uuid[]) AND nightclub_id = $2',
          [ids, nightclubId]);
        if (validos.rowCount !== ids.length) {
          throw ApiError.unprocessable('Alguno de esos proveedores no es de este club');
        }
      }

      await client.query(
        'DELETE FROM supply_suppliers WHERE supply_id = $1 AND NOT (supplier_id = ANY($2::uuid[]))',
        [supplyId, ids]);
      for (const supplierId of ids) {
        await client.query(
          `INSERT INTO supply_suppliers (supply_id, supplier_id) VALUES ($1,$2)
           ON CONFLICT (supply_id, supplier_id) DO NOTHING`,
          [supplyId, supplierId]);
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    const { rows } = await pool.query(
      `SELECT ss.supplier_id, p.name, p.active, ss.last_cost::float8 AS last_cost,
              ss.last_bought_at
         FROM supply_suppliers ss
         JOIN suppliers p ON p.id = ss.supplier_id
        WHERE ss.supply_id = $1
        ORDER BY p.name`,
      [supplyId]);
    res.json({ supply_id: supplyId, suppliers: rows });
  }));

router.get('/nightclubs/:nightclubId/supplies/:supplyId/suppliers',
  requireRole('warehouse', 'manager', 'admin'),
  validate({ params: z.object({ nightclubId: uuid, supplyId: uuid }) }),
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT ss.supplier_id, p.name, p.contact_name, p.phone, p.active,
              ss.last_cost::float8 AS last_cost, ss.last_bought_at
         FROM supply_suppliers ss
         JOIN suppliers p ON p.id = ss.supplier_id
         JOIN supplies s ON s.id = ss.supply_id
        WHERE ss.supply_id = $1 AND s.nightclub_id = $2
        ORDER BY p.name`,
      [req.params.supplyId, req.params.nightclubId]);
    res.json({ supply_id: req.params.supplyId, suppliers: rows });
  }));

module.exports = router;
