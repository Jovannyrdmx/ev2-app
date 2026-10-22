/**
 * EV2 — el alta de las cajas (D126): `/nightclubs/:id/till-setup`.
 *
 * Lo usa el gerente desde Cajas → Nueva caja: crear la caja en una barra, decir si se
 * cobra con PC o con teléfono, darle su impresora con cajón y su terminal Point, y
 * probarla. `/tills` (sin "-setup") sigue siendo el estado de las cajas abiertas de la
 * noche (D121) y no cambia.
 *
 * La caja con PC registra su impresora con el código de estación de siempre
 * (`POST /print-agents/invite` con `station.till_id`). La caja con teléfono usa una
 * impresora de red: `POST /till-setup/:tillId/printer`.
 */
'use strict';

const express = require('express');
const { pool } = require('../db/pool');
const { ApiError, asyncHandler } = require('../middleware/errors');
const { validate, z, uuid } = require('../middleware/validate');
const { authenticate, requireRole, sameNightclub } = require('../middleware/auth');
const tills = require('../services/tills');
const till = require('../services/till');
const printing = require('../services/printing');
const pcSetup = require('../services/pc-setup');

const router = express.Router({ mergeParams: true });
router.use('/nightclubs/:nightclubId', authenticate, sameNightclub());

const MANAGE = ['manager', 'admin'];

/** Corre `fn` en una transacción y devuelve lo que regrese. */
async function inTx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

router.get('/nightclubs/:nightclubId/till-setup',
  requireRole(...MANAGE),
  validate({
    params: z.object({ nightclubId: uuid }),
    query: z.object({ include_inactive: z.coerce.boolean().default(false) }),
  }),
  asyncHandler(async (req, res) => {
    const { nightclubId } = req.params;
    const [lista, lugares, terminales] = await Promise.all([
      tills.list(pool, { nightclubId, includeInactive: req.query.include_inactive }),
      pool.query(
        `SELECT l.id::text AS id, l.name, l.kind,
                (SELECT COALESCE(json_agg(z.section ORDER BY z.section), '[]'::json)
                   FROM zone_bars z WHERE z.location_id = l.id) AS sections
           FROM supply_locations l
          WHERE l.nightclub_id = $1 AND l.active AND l.kind IN ('bar', 'door')
          ORDER BY l.kind = 'door', l.sort_order, l.name`, [nightclubId]),
      pool.query(
        `SELECT id::text AS id, label AS name, till_id::text AS till_id
           FROM payment_terminals
          WHERE nightclub_id = $1 AND active AND provider = 'mercadopago'
          ORDER BY sort_order, label`, [nightclubId]),
    ]);
    res.json({ tills: lista, places: lugares.rows, terminals: terminales.rows });
  }));

router.post('/nightclubs/:nightclubId/till-setup',
  requireRole(...MANAGE),
  validate({
    params: z.object({ nightclubId: uuid }),
    body: z.object({
      location_id: uuid,
      name: z.string().trim().min(1).max(60),
      device: z.enum(tills.DEVICES).default('pc'),
    }),
  }),
  asyncHandler(async (req, res) => {
    const caja = await inTx((client) => tills.create(client, {
      nightclubId: req.params.nightclubId,
      locationId: req.body.location_id,
      name: req.body.name,
      device: req.body.device,
      userId: req.user.id,
      ip: req.ip,
    }));
    res.status(201).json({ till: caja });
  }));

router.patch('/nightclubs/:nightclubId/till-setup/:tillId',
  requireRole(...MANAGE),
  validate({
    params: z.object({ nightclubId: uuid, tillId: uuid }),
    body: z.object({
      name: z.string().trim().min(1).max(60).optional(),
      device: z.enum(tills.DEVICES).optional(),
      sort_order: z.number().int().min(0).max(999).optional(),
      active: z.boolean().optional(),
    }).refine((b) => Object.keys(b).length > 0, { message: 'No hay nada que cambiar' }),
  }),
  asyncHandler(async (req, res) => {
    const caja = await inTx((client) => tills.update(client, {
      nightclubId: req.params.nightclubId,
      tillId: req.params.tillId,
      patch: req.body,
      userId: req.user.id,
      ip: req.ip,
    }));
    res.json({ till: caja });
  }));

/** Las impresoras de red que las PCs del club ven y que todavía no son de nadie. */
router.get('/nightclubs/:nightclubId/till-setup/network-printers',
  requireRole(...MANAGE),
  validate({ params: z.object({ nightclubId: uuid }) }),
  asyncHandler(async (req, res) => {
    const { nightclubId } = req.params;
    const [candidates, agents] = await Promise.all([
      tills.networkCandidates(pool, { nightclubId }),
      printing.listAgents(pool, { nightclubId }),
    ]);
    const corte = Date.now() - printing.STALE_MINUTES * 60000;
    res.json({
      candidates,
      agents: agents.filter((a) => a.active).map((a) => ({
        id: a.id,
        name: a.name,
        location_name: a.location_name || null,
        online: Boolean(a.last_seen_at && new Date(a.last_seen_at).getTime() > corte),
        scan_at: a.scan_at,
      })),
    });
  }));

/**
 * La impresora de red (con cajón) de una caja: la del teléfono, o la de una PC sin USB.
 * Sale la hoja de prueba y abre el cajón para confirmar que es la buena.
 */
router.post('/nightclubs/:nightclubId/till-setup/:tillId/printer',
  requireRole(...MANAGE),
  validate({
    params: z.object({ nightclubId: uuid, tillId: uuid }),
    body: z.object({
      host: z.string().trim().min(1).max(120),
      port: z.coerce.number().int().min(1).max(65535).default(9100),
      name: z.string().trim().min(1).max(60).optional(),
      has_drawer: z.boolean().default(true),
      drawer_pin: z.union([z.literal(2), z.literal(5)]).default(2),
      paper_width: z.union([z.literal(58), z.literal(80)]).default(80),
      // La PC que la imprime. Sin ella, cualquier PC que atienda ese lugar.
      agent_id: uuid.nullish(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const b = req.body;
    const hecho = await inTx((client) => tills.setNetworkPrinter(client, {
      nightclubId: req.params.nightclubId,
      tillId: req.params.tillId,
      host: b.host,
      port: b.port,
      name: b.name || null,
      drawerPin: b.has_drawer ? b.drawer_pin : null,
      agentId: b.agent_id || null,
      paperWidth: b.paper_width,
      userId: req.user.id,
      ip: req.ip,
    }));
    res.status(201).json(hecho);
  }));

/** La terminal Point de la caja; `terminal_id: null` se la quita. */
router.put('/nightclubs/:nightclubId/till-setup/:tillId/terminal',
  requireRole(...MANAGE),
  validate({
    params: z.object({ nightclubId: uuid, tillId: uuid }),
    body: z.object({ terminal_id: uuid.nullable() }),
  }),
  asyncHandler(async (req, res) => {
    const hecho = await inTx((client) => tills.setTerminal(client, {
      nightclubId: req.params.nightclubId,
      tillId: req.params.tillId,
      terminalId: req.body.terminal_id,
      userId: req.user.id,
      ip: req.ip,
    }));
    res.json(hecho);
  }));

// ---------------------------------------------------------------- registrar esta PC (D127)

/** Qué puede ser una PC: las cajas con PC y la PC del bartender de cada barra. */
router.get('/nightclubs/:nightclubId/till-setup/pc-targets',
  requireRole(...MANAGE),
  validate({ params: z.object({ nightclubId: uuid }) }),
  asyncHandler(async (req, res) => {
    res.json({
      targets: await pcSetup.targets(pool, { nightclubId: req.params.nightclubId }),
      ttl_minutes: pcSetup.INSTALLER_TTL_MINUTES,
    });
  }));

/**
 * El instalador de esta PC (`Instalar-EV2.cmd`): doble clic y la PC queda registrada,
 * con su impresora USB, la hoja de prueba y el cajón. Lleva una llave de un solo uso que
 * vence en 15 minutos; la pantalla lo baja como archivo y no lo enseña.
 */
router.post('/nightclubs/:nightclubId/till-setup/installer',
  requireRole(...MANAGE),
  validate({
    params: z.object({ nightclubId: uuid }),
    body: z.object({
      target: z.string().trim().regex(/^(till|bartender):[0-9a-f-]{36}$/i, 'destino inválido'),
      has_drawer: z.boolean().default(true),
    }),
  }),
  asyncHandler(async (req, res) => {
    const hecho = await inTx((client) => pcSetup.createInstaller(client, {
      nightclubId: req.params.nightclubId,
      target: req.body.target,
      hasDrawer: req.body.has_drawer,
      userId: req.user.id,
      baseUrl: pcSetup.agentBaseUrl(req),
      ip: req.ip,
    }));
    res.set('Cache-Control', 'no-store').status(201).json(hecho);
  }));

/**
 * Borrar las PCs e impresoras del club para registrarlas de nuevo (D127). Pide escribir
 * BORRAR: mientras no se registren otra vez, no sale papel. Las cajas no se tocan.
 */
router.post('/nightclubs/:nightclubId/till-setup/wipe-devices',
  requireRole(...MANAGE),
  validate({
    params: z.object({ nightclubId: uuid }),
    body: z.object({ confirm: z.literal('BORRAR') }),
  }),
  asyncHandler(async (req, res) => {
    const { nightclubId } = req.params;
    const hecho = await inTx(async (client) => {
      const r = await pcSetup.wipeDevices(client, { nightclubId });
      await client.query(
        `INSERT INTO audit_log (nightclub_id, actor_id, action, entity, entity_id, after, ip)
         VALUES ($1,$2,'printing.wipe','print_agents',NULL,$3,$4)`,
        [nightclubId, req.user.id, JSON.stringify(r), req.ip || null]);
      return r;
    });
    res.json({ wiped: hecho });
  }));

// ---------------------------------------------------------------- quien cobra

/**
 * "Probar impresora" desde la caja (D126): el cajero o la anfitriona saca la hoja de
 * prueba en la impresora de SU caja abierta, para saber antes del primer cobro que el
 * papel sale. No abre el cajón: eso sigue pidiendo el PIN del gerente (D96).
 */
router.post('/nightclubs/:nightclubId/till/test-print',
  requireRole(...till.TILL_ROLES),
  validate({ params: z.object({ nightclubId: uuid }) }),
  asyncHandler(async (req, res) => {
    const { nightclubId } = req.params;
    const caja = await till.openTill(pool, { nightclubId, userId: req.user.id });
    if (!caja) throw ApiError.conflict('Abre tu caja para probar su impresora');
    const printer = await printing.resolvePrinter(pool, {
      nightclubId, purpose: 'till', tillId: caja.till_id,
    });
    if (!printer) {
      throw ApiError.unprocessable('Tu caja no tiene impresora. El gerente la da de alta en Cajas.');
    }
    const { rows } = await pool.query('SELECT name FROM nightclubs WHERE id = $1', [nightclubId]);
    const job = await printing.enqueueTest(pool, {
      nightclubId, printer, clubName: rows[0] ? rows[0].name : 'EV2', createdBy: req.user.id,
    });
    const pcs = printer.agent_id ? [] : await tills.coveringAgents(pool, {
      nightclubId, locationId: caja.location_id,
    });
    res.status(202).json({
      job: { id: job.id, status: job.status },
      printer: { id: printer.id, name: printer.name, connection: printer.connection },
      // Para la pantalla: si nadie va a imprimirlo, decirlo ya y no esperar el papel.
      agent_online: printer.agent_id ? null : pcs.some((a) => a.online),
    });
  }));

module.exports = router;
