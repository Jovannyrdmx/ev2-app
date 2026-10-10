/**
 * EV2 — objetos perdidos y encontrados (D67).
 *
 * Dos puertas al mismo tema y con permisos muy distintos:
 *
 *   * **El cliente** levanta su reporte, entrega algo que se encontró, ve SUS reportes
 *     con sus señas y su código, y ve el catálogo de lo guardado **sin señas**.
 *   * **El personal** ve todo, recibe físicamente lo entregado, empareja y entrega.
 *
 * La regla que ordena todo el archivo está en `services/lost-found.js`: las señas de un
 * objeto no salen hacia un cliente que no las escribió. Aquí solo se elige, en cada
 * ruta, cuál de las tres vistas se usa.
 */
'use strict';

const express = require('express');
const { pool } = require('../db/pool');
const { ApiError, asyncHandler } = require('../middleware/errors');
const { validate, z, uuid } = require('../middleware/validate');
const { authenticate, requireRole, sameNightclub } = require('../middleware/auth');
const events = require('../services/events');
const lf = require('../services/lost-found');

const router = express.Router({ mergeParams: true });

router.use('/nightclubs/:nightclubId', authenticate, sameNightclub());

/** Quién administra los objetos: los mismos que atienden el piso y la puerta. */
const STAFF = ['waiter', 'bartender', 'hostess', 'security', 'manager', 'admin'];

const categoria = z.enum(lf.CATEGORIES);

// ============================================================ el cliente

const reportBody = z.object({
  kind: z.enum(['lost', 'found']),
  category: categoria,
  // Las señas. Es el campo que hace que esto funcione y el que nunca se publica.
  details: z.string().trim().min(3).max(1000),
  place: z.string().trim().max(80).optional(),
  happened_at: z.coerce.date().optional(),
});

/**
 * "Se me perdió algo" o "me encontré algo".
 *
 * Las dos cosas son el mismo formulario porque son la misma información: qué es, cómo
 * era, dónde y cuándo. Lo único que cambia es de qué lado de la historia está quien
 * escribe.
 *
 * Un objeto entregado por un cliente nace **sin** resguardo: hasta que alguien del club
 * lo tenga en la mano, el catálogo no debe decir que está guardado.
 */
router.post('/nightclubs/:nightclubId/lost-items',
  validate({ params: z.object({ nightclubId: uuid }), body: reportBody }),
  asyncHandler(async (req, res) => {
    const b = req.body;
    const item = await lf.report(pool, {
      nightclubId: req.params.nightclubId,
      kind: b.kind,
      category: b.category,
      details: b.details,
      place: b.place || null,
      happenedAt: b.happened_at || null,
      reportedBy: req.user.id,
    });
    // El personal se entera en el momento: un teléfono que aparece a las 3 de la
    // mañana y nadie ve hasta el día siguiente es un teléfono que ya se fue.
    await events.publish({
      nightclubId: req.params.nightclubId,
      type: 'lost_item_reported',
      audience: { roles: STAFF },
      payload: { item_id: item.id, kind: item.kind, category: item.category },
    });
    res.status(201).json({ item: lf.ownerView(item) });
  }));

/** Mis reportes, con mis señas y mi código de entrega si ya lo hay. */
router.get('/nightclubs/:nightclubId/lost-items/mine',
  validate({ params: z.object({ nightclubId: uuid }) }),
  asyncHandler(async (req, res) => {
    res.json({
      items: await lf.mine(pool, {
        nightclubId: req.params.nightclubId, userId: req.user.id,
      }),
    });
  }));

/**
 * El catálogo de lo que hay guardado, para un cliente.
 *
 * Categoría, zona y día. **Sin señas**, que es lo que impide que alguien lea la
 * descripción y se presente a reclamar algo ajeno describiéndolo.
 */
router.get('/nightclubs/:nightclubId/lost-items/found',
  validate({
    params: z.object({ nightclubId: uuid }),
    query: z.object({
      category: categoria.optional(),
      days: z.coerce.number().int().min(1).max(90).default(30),
    }),
  }),
  asyncHandler(async (req, res) => {
    res.json({
      items: await lf.publicCatalogue(pool, {
        nightclubId: req.params.nightclubId,
        category: req.query.category || null,
        days: req.query.days,
      }),
      categories: lf.CATEGORIES,
    });
  }));

// ============================================================ el personal

/** Todo, con señas: es lo que hace falta para emparejar. */
router.get('/nightclubs/:nightclubId/lost-items',
  requireRole(...STAFF),
  validate({
    params: z.object({ nightclubId: uuid }),
    query: z.object({
      kind: z.enum(['lost', 'found']).optional(),
      status: z.enum(['open', 'matched', 'returned', 'closed']).optional(),
      category: categoria.optional(),
      limit: z.coerce.number().int().min(1).max(200).default(100),
    }),
  }),
  asyncHandler(async (req, res) => {
    res.json({
      items: await lf.list(pool, {
        nightclubId: req.params.nightclubId,
        kind: req.query.kind || null,
        status: req.query.status || null,
        category: req.query.category || null,
        limit: req.query.limit,
      }),
      categories: lf.CATEGORIES,
    });
  }));

/**
 * El club recibe físicamente algo.
 *
 * Es un paso aparte del alta porque "alguien dijo que lo dejó" y "está en la caja" son
 * cosas distintas, y el catálogo solo sirve si las distingue: un cliente que ve "en
 * resguardo" y viene manejando media hora merece que eso sea cierto.
 */
router.post('/nightclubs/:nightclubId/lost-items/:itemId/receive',
  requireRole(...STAFF),
  validate({
    params: z.object({ nightclubId: uuid, itemId: uuid }),
    body: z.object({ storage_note: z.string().trim().max(120).optional() }).default({}),
  }),
  asyncHandler(async (req, res) => {
    const item = await lf.receive(pool, {
      nightclubId: req.params.nightclubId,
      itemId: req.params.itemId,
      userId: req.user.id,
      storageNote: req.body.storage_note || null,
    });
    if (!item) throw ApiError.notFound('Ese objeto no existe, o no es uno encontrado');
    res.json({ item: lf.staffView(item) });
  }));

/**
 * Emparejar: este reporte de pérdida parece ser este objeto guardado.
 *
 * Emite el código de entrega, que viaja **una sola vez** y solo hasta la pantalla del
 * dueño. No se devuelve aquí en claro a quien empareja: si el personal pudiera verlo,
 * el código no probaría nada.
 */
router.post('/nightclubs/:nightclubId/lost-items/:itemId/match',
  requireRole(...STAFF),
  validate({
    params: z.object({ nightclubId: uuid, itemId: uuid }),
    body: z.object({ found_id: uuid }),
  }),
  asyncHandler(async (req, res) => {
    const { nightclubId, itemId } = req.params;
    const client = await pool.connect();
    let hecho;
    try {
      await client.query('BEGIN');
      hecho = await lf.match(client, {
        nightclubId, lostId: itemId, foundId: req.body.found_id,
      });
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      if (err.code === '23514') throw ApiError.unprocessable('Esos dos reportes no se pueden emparejar');
      throw err;
    } finally {
      client.release();
    }

    // El dueño recibe el aviso Y el código, en su teléfono. Es el único camino por el
    // que el código llega a alguien.
    if (hecho.item.reported_by) {
      await events.publish({
        nightclubId,
        type: 'lost_item_matched',
        audience: { userIds: [hecho.item.reported_by] },
        payload: { item_id: hecho.item.id, handover_code: hecho.code },
      });
    }
    // A quien empareja se le devuelve el objeto SIN el código: solo la huella, para que
    // pueda decir "el que termina en …7B" si alguien pregunta.
    res.json({ item: lf.staffView(hecho.item) });
  }));

/**
 * Entregar el objeto. El código es lo que lo autoriza.
 *
 * Sin esto, la entrega depende de que quien está en la barra a las cuatro de la mañana
 * recuerde una cara.
 */
router.post('/nightclubs/:nightclubId/lost-items/:itemId/hand-over',
  requireRole(...STAFF),
  validate({
    params: z.object({ nightclubId: uuid, itemId: uuid }),
    body: z.object({ code: z.string().trim().min(4).max(20) }),
  }),
  asyncHandler(async (req, res) => {
    const client = await pool.connect();
    let item;
    try {
      await client.query('BEGIN');
      item = await lf.handOver(client, {
        nightclubId: req.params.nightclubId,
        lostId: req.params.itemId,
        code: req.body.code,
        userId: req.user.id,
      });
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    res.json({ item: lf.staffView(item) });
  }));

/** Cerrar sin entregar. El motivo es obligatorio. */
router.post('/nightclubs/:nightclubId/lost-items/:itemId/close',
  requireRole('manager', 'admin'),
  validate({
    params: z.object({ nightclubId: uuid, itemId: uuid }),
    body: z.object({ reason: z.string().trim().min(3).max(200) }),
  }),
  asyncHandler(async (req, res) => {
    const item = await lf.close(pool, {
      nightclubId: req.params.nightclubId,
      itemId: req.params.itemId,
      reason: req.body.reason,
    });
    if (!item) throw ApiError.notFound('Ese objeto no existe, o ya se entregó');
    res.json({ item: lf.staffView(item) });
  }));

module.exports = router;
