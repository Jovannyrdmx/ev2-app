/**
 * EV2 — impresoras, agentes y la cola de papel (D52).
 *
 * Hay dos públicos muy distintos en este archivo, y por eso hay dos routers:
 *
 *   * **El gerente**, con su sesión normal: da de alta impresoras, ve la cola,
 *     reimprime lo que no salió y prende o apaga la comanda por pedido.
 *   * **El agente**, que es un programa en una PC de barra y NO tiene sesión: se
 *     identifica con un token propio en `X-Print-Agent-Token`. Sus rutas viven
 *     aparte, fuera de `authenticate`, porque un agente no es una persona: no tiene
 *     rol, no pertenece a nadie y lo único que puede hacer es tomar trabajos de su
 *     club e informar cómo le fue.
 *
 * Esa separación es a propósito. Si el agente usara una sesión de persona, habría
 * que crear un usuario "impresora" con contraseña eterna guardada en un archivo de
 * texto en la barra, y ese usuario podría hacer todo lo que hace un empleado.
 */
'use strict';

const express = require('express');
const { pool } = require('../db/pool');
const { ApiError, asyncHandler } = require('../middleware/errors');
const { validate, z, uuid } = require('../middleware/validate');
const { authenticate, requireRole, sameNightclub } = require('../middleware/auth');
const printing = require('../services/printing');
const events = require('../services/events');

const router = express.Router({ mergeParams: true });

// ============================================================================
// El agente: sin sesión, con token propio.
// ============================================================================

const agentRouter = express.Router({ mergeParams: true });

/** Quién pregunta. Un token malo no dice si existía y estaba apagado, ni de quién era. */
const authenticateAgent = asyncHandler(async (req, res, next) => {
  const token = req.get('X-Print-Agent-Token') || '';
  const agente = await printing.agentByToken(pool, token);
  if (!agente) throw ApiError.unauthorized('Token de agente inválido');
  req.agent = agente;
  await printing.touchAgent(pool, {
    agentId: agente.id, version: req.get('X-Print-Agent-Version') || null,
  });
  next();
});

/**
 * Canjear un código de emparejamiento (D56).
 *
 * Va ANTES de `authenticateAgent` a propósito: quien llama aquí todavía no tiene
 * token —es lo que viene a pedir— y pasar por la autenticación de agente le daría un
 * 401 en vez de dejarlo emparejarse.
 *
 * El token sale de aquí una sola vez en la vida de esa PC, y esta vez no lo copia
 * nadie: lo guarda el propio agente en su archivo.
 */
agentRouter.post('/pair',
  validate({
    body: z.object({
      code: z.string().trim().min(4).max(20),
      hostname: z.string().trim().max(80).optional(),
      version: z.string().trim().max(20).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const client = await pool.connect();
    let hecho;
    try {
      await client.query('BEGIN');
      hecho = await printing.redeemInvite(client, {
        code: req.body.code,
        hostname: req.body.hostname,
        version: req.body.version,
        ip: req.ip,
      });
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      // Un código equivocado le cuesta a todos los códigos vivos: pasados unos
      // cuantos fallos se queman solos, y adivinar deja de ser posible antes de que
      // valga la pena empezar.
      if (err.status === 403) await printing.countFailedPairing(pool).catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    await events.publish({
      nightclubId: hecho.nightclubId,
      type: 'print_agent_paired',
      audience: { roles: ['manager', 'admin'] },
      payload: { agent_id: hecho.agent.id, name: hecho.agent.name },
    });
    res.status(201).json({ agent: hecho.agent, token: hecho.token });
  }));

// Va montado en `/api/print-agent`, no en `/api`, y esto no es un detalle de estilo:
// un `use()` sin ruta sobre un router montado en `/api` corre en TODAS las peticiones
// que llegan a `/api`, incluidas las que no casan con ninguna ruta. El efecto era que
// cualquier dirección inexistente contestaba 401 en vez de 404 —y consultaba la base
// para averiguarlo— y lo encontró una prueba de otro módulo, no la lectura.
agentRouter.use(authenticateAgent);

/**
 * "Dame trabajo."
 *
 * Contesta de inmediato, aunque esté vacío: el agente vuelve a preguntar en unos
 * segundos. Mantener la petición abierta esperando trabajo sería más elegante y
 * también sería una conexión colgada por PC toda la noche, cayéndose con cada
 * parpadeo del internet del club.
 */
agentRouter.get('/jobs',
  validate({ query: z.object({ limit: z.coerce.number().int().min(1).max(20).default(5) }) }),
  asyncHandler(async (req, res) => {
    const [jobs, scan] = await Promise.all([
      printing.claim(pool, {
        nightclubId: req.agent.nightclub_id,
        agentId: req.agent.id,
        limit: req.query.limit,
      }),
      // La petición de búsqueda viaja en el mismo sondeo que ya hace el agente. Un
      // segundo canal sería una conexión más que se cae con cada parpadeo del
      // internet del club, para algo que se pide una vez al mes.
      printing.pendingScan(pool, req.agent.id),
    ]);
    res.json({ agent: { id: req.agent.id, name: req.agent.name }, jobs, scan });
  }));

agentRouter.post('/jobs/:jobId/done',
  validate({ params: z.object({ jobId: uuid }) }),
  asyncHandler(async (req, res) => {
    const job = await printing.markPrinted(pool, {
      nightclubId: req.agent.nightclub_id, jobId: req.params.jobId, agentId: req.agent.id,
    });
    if (!job) throw ApiError.notFound('Ese trabajo no existe');
    res.json({ job });
  }));

agentRouter.post('/jobs/:jobId/failed',
  validate({
    params: z.object({ jobId: uuid }),
    body: z.object({ error: z.string().trim().min(1).max(500) }),
  }),
  asyncHandler(async (req, res) => {
    const resultado = await printing.markFailed(pool, {
      nightclubId: req.agent.nightclub_id,
      jobId: req.params.jobId,
      agentId: req.agent.id,
      error: req.body.error,
    });
    if (!resultado) throw ApiError.notFound('Ese trabajo no existe');
    // `rerouted` es cómo terminó esta llamada, no una propiedad del papel: sale del
    // trabajo y se responde aparte, para que el agente sepa que el que acaba de
    // fallar ya tiene quien lo saque y no lo reporte dos veces.
    const { rerouted, ...job } = resultado;
    // El gerente tiene que enterarse de que un papel no salió mientras la noche
    // sigue, no al cerrar. Solo cuando ya no se va a reintentar más.
    if (job.status === 'failed') {
      await events.publish({
        nightclubId: req.agent.nightclub_id,
        type: 'print_job_failed',
        audience: { roles: ['manager', 'admin'] },
        payload: { job_id: job.id, kind: job.kind, error: job.last_error },
      });
    }
    res.json({ job, rerouted: Boolean(rerouted) });
  }));

/**
 * "Esto es lo que veo en mi red."
 *
 * Lo manda el agente después de barrer. Puede traer `error` en vez de `found`: una
 * búsqueda que falla en silencio deja al gerente esperando una lista que no va a
 * llegar, y eso es peor que un mensaje feo.
 */
agentRouter.post('/scan',
  validate({
    body: z.object({
      // Los topes de aquí son solo para que un cuerpo absurdo no llegue a la base;
      // el recorte de verdad lo hace `saveScan`. Rechazar el reporte entero por venir
      // largo perdería un barrido bueno de una red grande, que es justo cuando más
      // sirve: 64 hallazgos es lo que se enseña, no lo máximo que se acepta oír.
      found: z.array(z.object({
        kind: z.enum(['network', 'windows']),
        host: z.string().trim().max(240).nullish(),
        port: z.coerce.number().int().min(1).max(65535).nullish(),
        name: z.string().trim().max(240).nullish(),
        share: z.string().trim().max(240).nullish(),
        model: z.string().trim().max(240).nullish(),
      })).max(512).optional(),
      error: z.string().trim().max(400).nullish(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const hecho = await printing.saveScan(pool, {
      agentId: req.agent.id,
      found: req.body.found || [],
      error: req.body.error || null,
    });
    res.json({ saved: Boolean(hecho), scan_at: hecho ? hecho.scan_at : null });
  }));

// ============================================================================
// El gerente.
// ============================================================================

router.use('/nightclubs/:nightclubId', authenticate, sameNightclub());

const MANAGE = ['manager', 'admin'];

const printerBody = z.object({
  location_id: uuid,
  name: z.string().trim().min(1).max(60),
  purpose: z.enum(['orders', 'service']),
  connection: z.enum(['network', 'windows']).default('network'),
  host: z.string().trim().min(1).max(120).nullish(),
  port: z.coerce.number().int().min(1).max(65535).default(9100),
  windows_name: z.string().trim().min(1).max(120).nullish(),
  paper_width: z.coerce.number().int().refine((n) => n === 58 || n === 80, 'debe ser 58 u 80')
    .default(80),
  columns: z.coerce.number().int().min(24).max(64).optional(),
  codepage: z.enum(['CP437', 'CP850', 'CP858', 'CP860', 'CP1252']).default('CP850'),
  has_cutter: z.coerce.boolean().default(true),
  fallback_id: uuid.nullish(),
});

/** Las columnas que caben, si no las dijeron: 48 a 80 mm, 32 a 58 mm. */
const defaultColumns = (paperWidth) => (Number(paperWidth) === 58 ? 32 : 48);

/**
 * Lo que la base no puede comprobar sola.
 *
 * Una impresora de red sin dirección y una de Windows sin nombre las para el CHECK
 * de la tabla, pero el mensaje que suelta Postgres no le sirve a nadie. Se dicen
 * aquí, con palabras, antes de llegar allá.
 */
function checkPrinter(body) {
  if (body.connection === 'network' && !body.host) {
    throw ApiError.badRequest('Una impresora de red necesita su dirección IP');
  }
  if (body.connection === 'windows' && !body.windows_name) {
    throw ApiError.badRequest('Una impresora por USB necesita su nombre en Windows');
  }
}

router.get('/nightclubs/:nightclubId/printers',
  requireRole(...MANAGE, 'bartender', 'waiter'),
  validate({
    params: z.object({ nightclubId: uuid }),
    query: z.object({ include_inactive: z.coerce.boolean().default(false) }),
  }),
  asyncHandler(async (req, res) => {
    const printers = await printing.listPrinters(pool, {
      nightclubId: req.params.nightclubId,
      includeInactive: req.query.include_inactive,
    });
    res.json({ printers });
  }));

router.post('/nightclubs/:nightclubId/printers',
  requireRole(...MANAGE),
  validate({ params: z.object({ nightclubId: uuid }), body: printerBody }),
  asyncHandler(async (req, res) => {
    checkPrinter(req.body);
    const b = req.body;
    try {
      const { rows } = await pool.query(
        `INSERT INTO printers
           (nightclub_id, location_id, name, purpose, connection, host, port,
            windows_name, paper_width, columns, codepage, has_cutter, fallback_id)
         VALUES ($1,$2,$3::text,$4::text,$5::text,$6,$7,$8,$9,$10,$11::text,$12,$13)
         RETURNING id::text AS id`,
        [req.params.nightclubId, b.location_id, b.name, b.purpose, b.connection,
          b.host || null, b.port, b.windows_name || null, b.paper_width,
          b.columns || defaultColumns(b.paper_width), b.codepage, b.has_cutter,
          b.fallback_id || null]);
      const printer = await printing.getPrinter(pool, {
        nightclubId: req.params.nightclubId, printerId: rows[0].id,
      });
      res.status(201).json({ printer });
    } catch (err) {
      if (err.code === '23505') {
        throw ApiError.conflict('Ya hay una impresora activa con ese nombre, '
          + 'o esa barra ya tiene una para ese uso');
      }
      if (err.code === '23503') throw ApiError.badRequest('Esa barra no existe');
      if (err.code === '23514') throw ApiError.badRequest('Esa barra no es una barra');
      throw err;
    }
  }));

router.patch('/nightclubs/:nightclubId/printers/:printerId',
  requireRole(...MANAGE),
  validate({
    params: z.object({ nightclubId: uuid, printerId: uuid }),
    body: printerBody.partial().extend({ active: z.coerce.boolean().optional() }),
  }),
  asyncHandler(async (req, res) => {
    const actual = await printing.getPrinter(pool, {
      nightclubId: req.params.nightclubId, printerId: req.params.printerId,
    });
    if (!actual) throw ApiError.notFound('Esa impresora no existe');
    const merged = { ...actual, ...req.body };
    checkPrinter(merged);
    try {
      await pool.query(
        `UPDATE printers
            SET location_id = $3, name = $4::text, purpose = $5::text,
                connection = $6::text, host = $7, port = $8, windows_name = $9,
                paper_width = $10, columns = $11, codepage = $12::text,
                has_cutter = $13, fallback_id = $14, active = $15
          WHERE id = $1 AND nightclub_id = $2`,
        [req.params.printerId, req.params.nightclubId, merged.location_id, merged.name,
          merged.purpose, merged.connection, merged.host || null, merged.port,
          merged.windows_name || null, merged.paper_width, merged.columns,
          merged.codepage, merged.has_cutter, merged.fallback_id || null, merged.active]);
    } catch (err) {
      if (err.code === '23505') {
        throw ApiError.conflict('Ya hay una impresora activa con ese nombre, '
          + 'o esa barra ya tiene una para ese uso');
      }
      if (err.code === '23514') throw ApiError.badRequest('Esa barra no es una barra');
      throw err;
    }
    const printer = await printing.getPrinter(pool, {
      nightclubId: req.params.nightclubId, printerId: req.params.printerId,
    });
    res.json({ printer });
  }));

/**
 * El botón de prueba.
 *
 * Es la única verificación que sirve para una impresora térmica: la ficha del
 * fabricante no dice en qué página de códigos vino configurada de fábrica, y los
 * acentos solo se comprueban viéndolos salir.
 */
router.post('/nightclubs/:nightclubId/printers/:printerId/test',
  requireRole(...MANAGE),
  validate({ params: z.object({ nightclubId: uuid, printerId: uuid }) }),
  asyncHandler(async (req, res) => {
    const printer = await printing.getPrinter(pool, {
      nightclubId: req.params.nightclubId, printerId: req.params.printerId,
    });
    if (!printer) throw ApiError.notFound('Esa impresora no existe');
    if (!printer.active) throw ApiError.badRequest('Esa impresora está apagada');
    const club = await pool.query('SELECT name FROM nightclubs WHERE id = $1',
      [req.params.nightclubId]);
    const job = await printing.enqueueTest(pool, {
      nightclubId: req.params.nightclubId,
      printer,
      clubName: club.rows[0] ? club.rows[0].name : 'EV2',
      createdBy: req.user.id,
    });
    res.status(202).json({ job });
  }));

// ---------------------------------------------------------------- los agentes

router.get('/nightclubs/:nightclubId/print-agents',
  requireRole(...MANAGE),
  validate({ params: z.object({ nightclubId: uuid }) }),
  asyncHandler(async (req, res) => {
    const [agents, invites] = await Promise.all([
      printing.listAgents(pool, { nightclubId: req.params.nightclubId }),
      printing.openInvites(pool, { nightclubId: req.params.nightclubId }),
    ]);
    res.json({ agents, invites, stale_minutes: printing.STALE_MINUTES });
  }));

/**
 * Emitir un código para dar de alta una PC (D56).
 *
 * El código se enseña en la pantalla del gerente y se teclea en la PC de la barra.
 * No hay token que copiar: la PC se configura sola al canjearlo, se pone el nombre
 * de la máquina, y empieza a buscar impresoras sin que nadie se lo pida.
 */
router.post('/nightclubs/:nightclubId/print-agents/invite',
  requireRole(...MANAGE),
  validate({ params: z.object({ nightclubId: uuid }) }),
  asyncHandler(async (req, res) => {
    const invite = await printing.createInvite(pool, {
      nightclubId: req.params.nightclubId, createdBy: req.user.id,
    });
    // `code` sale de aquí una sola vez: la base guarda su huella, no el código.
    res.status(201).json({ invite });
  }));

router.post('/nightclubs/:nightclubId/print-agents/scan',
  requireRole(...MANAGE),
  validate({ params: z.object({ nightclubId: uuid }) }),
  asyncHandler(async (req, res) => {
    const agentes = await printing.requestScan(pool, {
      nightclubId: req.params.nightclubId,
    });
    if (agentes.length === 0) {
      throw ApiError.badRequest(
        'No hay ninguna PC dada de alta que pueda buscar. Da de alta una primero.');
    }
    const vivas = agentes.filter((a) => a.last_seen_at
      && Date.now() - new Date(a.last_seen_at).getTime() < printing.STALE_MINUTES * 60000);
    res.status(202).json({
      asked: agentes.length,
      online: vivas.length,
      agents: agentes.map((a) => ({ id: a.id, name: a.name })),
    });
  }));

router.patch('/nightclubs/:nightclubId/print-agents/:agentId',
  requireRole(...MANAGE),
  validate({
    params: z.object({ nightclubId: uuid, agentId: uuid }),
    body: z.object({ active: z.coerce.boolean() }),
  }),
  asyncHandler(async (req, res) => {
    const agent = await printing.setAgentActive(pool, {
      nightclubId: req.params.nightclubId,
      agentId: req.params.agentId,
      active: req.body.active,
    });
    if (!agent) throw ApiError.notFound('Ese agente no existe');
    res.json({ agent });
  }));

// ---------------------------------------------------------------- la cola

router.get('/nightclubs/:nightclubId/print-jobs',
  requireRole(...MANAGE),
  validate({
    params: z.object({ nightclubId: uuid }),
    query: z.object({
      status: z.enum(['pending', 'taken', 'printed', 'failed']).optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50),
    }),
  }),
  asyncHandler(async (req, res) => {
    const jobs = await printing.listJobs(pool, {
      nightclubId: req.params.nightclubId,
      status: req.query.status || null,
      limit: req.query.limit,
    });
    res.json({ jobs });
  }));

router.post('/nightclubs/:nightclubId/print-jobs/:jobId/reprint',
  requireRole(...MANAGE),
  validate({ params: z.object({ nightclubId: uuid, jobId: uuid }) }),
  asyncHandler(async (req, res) => {
    const job = await printing.reprint(pool, {
      nightclubId: req.params.nightclubId, jobId: req.params.jobId, createdBy: req.user.id,
    });
    res.status(202).json({ job });
  }));

// ---------------------------------------------------------------- los ajustes

router.get('/nightclubs/:nightclubId/print-settings',
  requireRole(...MANAGE),
  validate({ params: z.object({ nightclubId: uuid }) }),
  asyncHandler(async (req, res) => {
    res.json({ settings: await printing.settingsOf(pool, req.params.nightclubId) });
  }));

router.patch('/nightclubs/:nightclubId/print-settings',
  requireRole('admin'),
  validate({
    params: z.object({ nightclubId: uuid }),
    body: z.object({
      print_order_tickets: z.coerce.boolean().optional(),
      print_receipts: z.coerce.boolean().optional(),
      max_attempts: z.coerce.number().int().min(1).max(10).optional(),
      header_text: z.string().trim().max(120).nullish(),
      footer_text: z.string().trim().max(160).nullish(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const settings = await printing.saveSettings(pool, {
      nightclubId: req.params.nightclubId, patch: req.body, userId: req.user.id,
    });
    await events.publish({
      nightclubId: req.params.nightclubId,
      type: 'print_settings_changed',
      audience: { roles: ['manager', 'admin', 'bartender'] },
      payload: { print_order_tickets: settings.print_order_tickets },
    });
    res.json({ settings });
  }));

module.exports = router;
module.exports.agentRouter = agentRouter;
