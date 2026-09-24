/**
 * EV2 — la cola de impresión: qué se imprime, dónde, y qué pasó con el papel (D52).
 *
 * ---------------------------------------------------------------------------
 * El reparto de responsabilidades
 * ---------------------------------------------------------------------------
 * Aquí se decide **a qué impresora va cada papel** y se deja el trabajo escrito con
 * los bytes ya armados. Quién se los pasa a la impresora es asunto del agente, que
 * corre en una PC del club. Este archivo nunca abre una conexión a una impresora:
 * no podría, el servidor está en otra red.
 *
 * ---------------------------------------------------------------------------
 * Cómo se enruta sin que nadie lo configure dos veces
 * ---------------------------------------------------------------------------
 * Una impresora cuelga de una barra y tiene un propósito: `orders` (la PC del
 * bartender) o `service` (la de meseros). Un papel dice de qué mesa o de qué zona
 * viene; `zone_bars` dice qué barra atiende esa zona —y el gerente la reasigna a
 * media noche sin que nadie toque nada aquí—; y el propósito escoge cuál de las dos
 * impresoras de esa barra.
 *
 * ---------------------------------------------------------------------------
 * Lo que pasa cuando falla, que es lo que de verdad importa
 * ---------------------------------------------------------------------------
 * Tres cosas, en este orden:
 *
 *  1. **Se reintenta.** Sin papel, atascada o apagada son estados que duran minutos.
 *  2. **Se desvía a la hermana de la barra.** Después de dos intentos, el papel sale
 *     en la otra impresora de la misma barra en vez de no salir. Un desvío es un
 *     trabajo NUEVO —con `rerouted_from` apuntando a la que falló— porque un trabajo
 *     ya escrito no cambia de impresora: si cambiara, nadie podría reconstruir
 *     después dónde se suponía que iba a salir ese ticket.
 *  3. **Se rinde y lo dice.** Pasados los intentos queda `failed` con el motivo. Un
 *     ticket que no salió y nadie sabe es peor que uno que no salió y se ve en rojo
 *     en el panel del gerente.
 *
 * Y el trabajo que un agente tomó y nunca reportó —porque apagaron la PC a medio
 * trabajo— vuelve a la cola solo pasados dos minutos. Sin eso, apagar una PC en el
 * momento equivocado deja ese papel colgado para siempre.
 */
'use strict';

const crypto = require('crypto');

const { ApiError } = require('../middleware/errors');
const escpos = require('./escpos');

/** Cuánto esperamos a un agente que tomó un trabajo antes de dárselo a otro. */
const STALE_MINUTES = 2;
/** A partir de cuántos intentos fallidos se deja de insistir y se desvía. */
const REROUTE_AFTER = 2;

// ---------------------------------------------------------------- los ajustes

const DEFAULTS = {
  print_order_tickets: false,
  print_receipts: true,
  max_attempts: 3,
  header_text: null,
  footer_text: null,
};

/**
 * Los ajustes de impresión del club, con los de fábrica si nunca se tocaron.
 *
 * Devuelve valores aunque no exista el renglón: un club recién creado tiene que
 * poder imprimir un ticket de prueba sin que alguien entre antes a "guardar" una
 * pantalla de ajustes que no cambió nada.
 */
async function settingsOf(runner, nightclubId) {
  const { rows } = await runner.query(
    `SELECT print_order_tickets, print_receipts, max_attempts, header_text, footer_text
       FROM nightclub_print_settings WHERE nightclub_id = $1`,
    [nightclubId]);
  return { ...DEFAULTS, ...(rows[0] || {}) };
}

/** Guarda los ajustes. Solo lo que venga: lo que no se manda no se pisa. */
async function saveSettings(runner, { nightclubId, patch, userId }) {
  const campos = ['print_order_tickets', 'print_receipts', 'max_attempts',
    'header_text', 'footer_text'];
  const actual = await settingsOf(runner, nightclubId);
  const nuevo = { ...actual };
  for (const k of campos) if (patch[k] !== undefined) nuevo[k] = patch[k];
  const { rows } = await runner.query(
    `INSERT INTO nightclub_print_settings
       (nightclub_id, print_order_tickets, print_receipts, max_attempts,
        header_text, footer_text, updated_by, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7, now())
     ON CONFLICT (nightclub_id) DO UPDATE
       SET print_order_tickets = EXCLUDED.print_order_tickets,
           print_receipts      = EXCLUDED.print_receipts,
           max_attempts        = EXCLUDED.max_attempts,
           header_text         = EXCLUDED.header_text,
           footer_text         = EXCLUDED.footer_text,
           updated_by          = EXCLUDED.updated_by,
           updated_at          = now()
     RETURNING print_order_tickets, print_receipts, max_attempts, header_text, footer_text`,
    [nightclubId, nuevo.print_order_tickets, nuevo.print_receipts, nuevo.max_attempts,
      nuevo.header_text, nuevo.footer_text, userId || null]);
  return rows[0];
}

// ---------------------------------------------------------------- las impresoras

// Van calificadas con `p.` porque esta lista también se usa dentro de un JOIN con
// `zone_bars`, donde `nightclub_id` y `location_id` existen en las dos tablas y
// Postgres se niega a adivinar cuál se quiso decir.
const PRINTER_COLS = `p.id::text AS id, p.nightclub_id::text AS nightclub_id,
  p.location_id::text AS location_id, p.name, p.purpose, p.connection, p.host, p.port,
  p.windows_name, p.paper_width, p.columns, p.codepage, p.has_cutter,
  p.fallback_id::text AS fallback_id, p.active`;

async function listPrinters(runner, { nightclubId, includeInactive = false }) {
  const { rows } = await runner.query(
    `SELECT ${PRINTER_COLS},
            (SELECT l.name FROM supply_locations l WHERE l.id = p.location_id) AS location_name
       FROM printers p
      WHERE p.nightclub_id = $1 AND ($2::boolean OR p.active)
      ORDER BY location_name, purpose`,
    [nightclubId, includeInactive]);
  return rows;
}

async function getPrinter(runner, { nightclubId, printerId }) {
  const { rows } = await runner.query(
    `SELECT ${PRINTER_COLS} FROM printers p WHERE p.id = $1 AND p.nightclub_id = $2`,
    [printerId, nightclubId]);
  return rows[0] || null;
}

/**
 * La impresora que le toca a este papel.
 *
 * `section` es la zona del plano (la que trae una mesa); `locationId` es la barra
 * directa, para cuando quien imprime ya sabe dónde está parado. Si la zona no tiene
 * barra asignada no se adivina una: devolver "cualquiera" haría que las comandas de
 * la terraza salieran en la barra de abajo sin que nadie entienda por qué.
 */
async function resolvePrinter(runner, { nightclubId, purpose, section = null, locationId = null }) {
  if (locationId) {
    const { rows } = await runner.query(
      `SELECT ${PRINTER_COLS} FROM printers p
        WHERE p.nightclub_id = $1 AND p.location_id = $2 AND p.purpose = $3::text AND p.active`,
      [nightclubId, locationId, purpose]);
    return rows[0] || null;
  }
  if (section) {
    const { rows } = await runner.query(
      `SELECT ${PRINTER_COLS} FROM printers p
         JOIN zone_bars z ON z.location_id = p.location_id AND z.nightclub_id = p.nightclub_id
        WHERE p.nightclub_id = $1 AND z.section = $2::text AND p.purpose = $3::text AND p.active`,
      [nightclubId, section, purpose]);
    return rows[0] || null;
  }
  // Sin zona ni barra: si el club tiene una sola impresora de ese propósito, es esa.
  // Con varias no se escoge al azar — se dice que falta decir dónde.
  const { rows } = await runner.query(
    `SELECT ${PRINTER_COLS} FROM printers p
      WHERE p.nightclub_id = $1 AND p.purpose = $2::text AND p.active LIMIT 2`,
    [nightclubId, purpose]);
  return rows.length === 1 ? rows[0] : null;
}

// ---------------------------------------------------------------- la cola

const JOB_COLS = `id::text AS id, nightclub_id::text AS nightclub_id,
  printer_id::text AS printer_id, kind, ref_id::text AS ref_id, copies,
  status, attempts, last_error, preview,
  taken_by::text AS taken_by, taken_at, printed_at,
  rerouted_from::text AS rerouted_from, created_at`;

/**
 * Deja un papel en la cola. Devuelve el trabajo, sin los bytes.
 *
 * No falla si la impresora está apagada: eso es justo lo que la cola resuelve. Falla
 * si no hay impresora a dónde mandarlo, porque entonces el papel no va a salir nunca
 * y decirlo en el momento es mejor que descubrirlo al cerrar la noche.
 */
async function enqueue(runner, {
  nightclubId, printer, kind, refId = null, copies = 1,
  payload, preview, createdBy = null, reroutedFrom = null,
}) {
  if (!printer) throw ApiError.badRequest('No hay una impresora configurada para eso');
  const { rows } = await runner.query(
    `INSERT INTO print_jobs
       (nightclub_id, printer_id, kind, ref_id, copies, payload, preview,
        created_by, rerouted_from)
     VALUES ($1,$2,$3::text,$4,$5,$6,$7,$8,$9)
     RETURNING ${JOB_COLS}`,
    [nightclubId, printer.id, kind, refId, copies, payload, preview,
      createdBy, reroutedFrom]);
  return rows[0];
}

/**
 * Arma un ticket y lo encola de un tirón.
 *
 * `render` recibe un constructor ya configurado con el ancho, la página de códigos y
 * el cortador de ESA impresora, porque el mismo ticket no se dibuja igual en una de
 * 58 mm que en una de 80.
 */
async function enqueueTicket(runner, {
  nightclubId, printer, kind, refId = null, copies = 1, createdBy = null, render,
}) {
  if (!printer) throw ApiError.badRequest('No hay una impresora configurada para eso');
  const t = escpos.ticket({
    columns: printer.columns,
    codepage: printer.codepage,
    hasCutter: printer.has_cutter,
  });
  render(t);
  const { bytes, text } = t.build();
  return enqueue(runner, {
    nightclubId, printer, kind, refId, copies, payload: bytes, preview: text, createdBy,
  });
}

/**
 * Encola sin poder tumbar lo que esté pasando alrededor.
 *
 * Los tres papeles del servicio —comanda, cuenta y recibo— se encolan DENTRO de la
 * transacción que asienta el pedido o el cobro, y eso es lo correcto: un recibo de un
 * cobro que no se asentó sería un papel mintiendo. Pero trae un peligro: en Postgres
 * **cualquier** error aborta la transacción entera, así que una impresora sin
 * configurar reventaría el cobro. Atrapar la excepción en JavaScript no alcanza: la
 * transacción ya quedó envenenada y el `COMMIT` fallaría igual.
 *
 * El `SAVEPOINT` resuelve las dos cosas a la vez: si encolar falla, se deshace solo
 * ese pedacito y el cobro sigue su camino. Devuelve `null` y quien llama no tiene
 * nada que decidir.
 */
async function enqueueSafely(client, args) {
  const punto = `print_${Math.random().toString(36).slice(2, 10)}`;
  try {
    await client.query(`SAVEPOINT ${punto}`);
    const job = await enqueue(client, args);
    await client.query(`RELEASE SAVEPOINT ${punto}`);
    return job;
  } catch (err) {
    await client.query(`ROLLBACK TO SAVEPOINT ${punto}`).catch(() => {});
    // No se vuelve a lanzar: que no salga un papel nunca puede impedir que se sirva un
    // trago o se cobre una cuenta. Queda en la bitácora del servidor.
    console.warn(`[printing] no se pudo encolar ${args.kind}: ${err.message}`);
    return null;
  }
}

/** El ticket de prueba de una impresora recién dada de alta. */
async function enqueueTest(runner, { nightclubId, printer, clubName, createdBy }) {
  const { bytes, text } = escpos.testTicket({
    clubName,
    printerName: printer.name,
    purpose: printer.purpose,
    columns: printer.columns,
    codepage: printer.codepage,
    hasCutter: printer.has_cutter,
  });
  return enqueue(runner, {
    nightclubId, printer, kind: 'test', payload: bytes, preview: text, createdBy,
  });
}

/**
 * El agente pide trabajo.
 *
 * `FOR UPDATE SKIP LOCKED` es lo que permite tener dos PCs tomando de la misma cola
 * sin que el mismo ticket salga dos veces: la que llega segunda no espera al
 * renglón ocupado, se lo salta y toma el siguiente.
 */
async function claim(runner, { nightclubId, agentId, limit = 5 }) {
  const { rows } = await runner.query(
    `UPDATE print_jobs j
        SET status = 'taken', taken_by = $2, taken_at = now(), attempts = j.attempts + 1
      WHERE j.id IN (
        SELECT c.id FROM print_jobs c
         WHERE c.nightclub_id = $1
           AND (c.status = 'pending'
                OR (c.status = 'taken'
                    AND c.taken_at < now() - ($3::int * interval '1 minute')))
         ORDER BY c.created_at
         FOR UPDATE SKIP LOCKED
         LIMIT $4::int)
      RETURNING ${JOB_COLS}, payload,
                (SELECT row_to_json(p) FROM (
                   SELECT ${PRINTER_COLS} FROM printers p WHERE p.id = j.printer_id
                 ) p) AS printer`,
    [nightclubId, agentId, STALE_MINUTES, limit]);
  return rows.map((r) => ({
    ...r,
    payload: Buffer.from(r.payload).toString('base64'),
  }));
}

/** El trabajo salió en papel. */
async function markPrinted(runner, { nightclubId, jobId, agentId }) {
  const { rows } = await runner.query(
    `UPDATE print_jobs
        SET status = 'printed', printed_at = now(), taken_by = $3, last_error = NULL
      WHERE id = $1 AND nightclub_id = $2 AND status <> 'printed'
      RETURNING ${JOB_COLS}`,
    [jobId, nightclubId, agentId || null]);
  return rows[0] || null;
}

/**
 * El trabajo no salió. Aquí se decide si se reintenta, se desvía o se abandona.
 *
 * El desvío solo ocurre una vez: un trabajo que ya viene desviado (`rerouted_from`)
 * no se vuelve a desviar, porque con dos impresoras por barra el siguiente salto
 * sería de regreso a la que ya falló, y el papel andaría rebotando entre las dos
 * mientras el cliente espera su cuenta.
 */
async function markFailed(runner, { nightclubId, jobId, agentId, error }) {
  const { rows } = await runner.query(
    `SELECT ${JOB_COLS}, payload FROM print_jobs WHERE id = $1 AND nightclub_id = $2`,
    [jobId, nightclubId]);
  const job = rows[0];
  if (!job) return null;
  if (job.status === 'printed') return { ...job, payload: undefined };

  const { max_attempts: maxAttempts } = await settingsOf(runner, nightclubId);
  const motivo = String(error || 'sin detalle').slice(0, 500);

  const printer = await getPrinter(runner, { nightclubId, printerId: job.printer_id });
  const puedeDesviar = printer && printer.fallback_id && !job.rerouted_from
    && job.attempts >= REROUTE_AFTER;

  if (puedeDesviar) {
    const destino = await getPrinter(runner, {
      nightclubId, printerId: printer.fallback_id,
    });
    if (destino && destino.active) {
      await runner.query(
        `UPDATE print_jobs SET status = 'failed', last_error = $3, taken_by = $4
          WHERE id = $1 AND nightclub_id = $2`,
        [jobId, nightclubId, `${motivo} (desviado a ${destino.name})`, agentId || null]);
      const desviado = await enqueue(runner, {
        nightclubId,
        printer: destino,
        kind: job.kind,
        refId: job.ref_id,
        copies: job.copies,
        payload: job.payload,
        preview: job.preview,
        createdBy: null,
        reroutedFrom: job.printer_id,
      });
      return { ...desviado, rerouted: true };
    }
  }

  const rendirse = job.attempts >= maxAttempts;
  const { rows: out } = await runner.query(
    `UPDATE print_jobs
        SET status = $3::text, last_error = $4, taken_by = $5, taken_at = NULL
      WHERE id = $1 AND nightclub_id = $2
      RETURNING ${JOB_COLS}`,
    [jobId, nightclubId, rendirse ? 'failed' : 'pending', motivo, agentId || null]);
  return out[0] || null;
}

/** Vuelve a mandar a la cola un papel que ya se había armado, tal cual salió. */
async function reprint(runner, { nightclubId, jobId, createdBy }) {
  const { rows } = await runner.query(
    `SELECT ${JOB_COLS}, payload FROM print_jobs WHERE id = $1 AND nightclub_id = $2`,
    [jobId, nightclubId]);
  const job = rows[0];
  if (!job) throw ApiError.notFound('Ese trabajo de impresión no existe');
  const printer = await getPrinter(runner, { nightclubId, printerId: job.printer_id });
  if (!printer || !printer.active) {
    throw ApiError.badRequest('Esa impresora ya no está activa');
  }
  return enqueue(runner, {
    nightclubId,
    printer,
    kind: job.kind,
    refId: job.ref_id,
    copies: job.copies,
    payload: job.payload,
    preview: job.preview,
    createdBy,
  });
}

/** La cola tal como la ve el gerente: lo reciente, con lo que falló arriba. */
async function listJobs(runner, { nightclubId, status = null, limit = 50 }) {
  const { rows } = await runner.query(
    `SELECT ${JOB_COLS},
            (SELECT p.name FROM printers p WHERE p.id = j.printer_id) AS printer_name
       FROM print_jobs j
      WHERE j.nightclub_id = $1 AND ($2::text IS NULL OR j.status = $2::text)
      ORDER BY (j.status = 'failed') DESC, j.created_at DESC
      LIMIT $3::int`,
    [nightclubId, status, limit]);
  return rows;
}

// ---------------------------------------------------------------- los agentes

/** El token con el que un agente se identifica. Se enseña UNA vez, al crearlo. */
function newToken() {
  return `ev2ag_${crypto.randomBytes(24).toString('hex')}`;
}

/**
 * La huella del token.
 *
 * SHA-256 a secas y no bcrypt: un token de 192 bits al azar no se adivina probando,
 * así que lo único que hace falta es que la base no guarde el original. Y el agente
 * se identifica en CADA consulta —cada pocos segundos, toda la noche—: bcrypt ahí
 * sería quemar el servidor para protegerse de un ataque que no existe.
 */
const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

async function createAgent(runner, { nightclubId, name, createdBy }) {
  const token = newToken();
  const { rows } = await runner.query(
    `INSERT INTO print_agents (nightclub_id, name, token_hash, token_hint, created_by)
     VALUES ($1,$2::text,$3,$4,$5)
     RETURNING id::text AS id, name, token_hint, active, created_at`,
    [nightclubId, name, hashToken(token), token.slice(-6), createdBy || null]);
  // El token viaja de vuelta una sola vez en la vida. Después solo queda la huella.
  return { ...rows[0], token };
}

async function listAgents(runner, { nightclubId }) {
  const { rows } = await runner.query(
    `SELECT id::text AS id, name, token_hint, last_seen_at, agent_version, active, created_at,
            scan_requested_at, scan_at, scan_result, scan_error
       FROM print_agents WHERE nightclub_id = $1 ORDER BY name`,
    [nightclubId]);
  return rows;
}

// ---------------------------------------------------------------- buscar impresoras

/** Cuánto vale una petición de búsqueda antes de darla por abandonada. */
const SCAN_TTL_MINUTES = 5;

/**
 * Pide a todas las PCs vivas del club que busquen impresoras (D55).
 *
 * A todas, no a una: con dos agentes lo interesante no es solo "hay una impresora en
 * el .50", es **cuál PC la alcanza**, que es lo que decide a quién ponerle de
 * respaldo a quién. Cada una contesta lo que ve desde donde está.
 *
 * Marcar la petición y esperar a que el agente la recoja en su siguiente vuelta es
 * todo el mecanismo: ya pregunta cada pocos segundos, y un segundo canal para
 * avisarle sería una conexión más que se cae con cada parpadeo del internet del club.
 */
async function requestScan(runner, { nightclubId }) {
  const { rows } = await runner.query(
    `UPDATE print_agents
        SET scan_requested_at = now(), scan_error = NULL
      WHERE nightclub_id = $1 AND active
      RETURNING id::text AS id, name, last_seen_at`,
    [nightclubId]);
  return rows;
}

/** ¿Este agente tiene una búsqueda pendiente que todavía le interese a alguien? */
async function pendingScan(runner, agentId) {
  const { rows } = await runner.query(
    `SELECT scan_requested_at FROM print_agents
      WHERE id = $1 AND scan_requested_at IS NOT NULL
        AND (scan_at IS NULL OR scan_at < scan_requested_at)
        AND scan_requested_at > now() - ($2::int * interval '1 minute')`,
    [agentId, SCAN_TTL_MINUTES]);
  return rows.length > 0;
}

/**
 * Guarda lo que esa PC encontró.
 *
 * Los hallazgos vienen de un programa que corre en el club, así que se recortan aquí:
 * un agente comprometido no debe poder llenar la base con una lista de cien mil
 * renglones ni meter texto de cualquier largo en la pantalla del gerente.
 */
async function saveScan(runner, { agentId, found = [], error = null }) {
  const limpio = (Array.isArray(found) ? found : []).slice(0, 64).map((f) => ({
    kind: f.kind === 'windows' ? 'windows' : 'network',
    host: f.host ? String(f.host).slice(0, 120) : null,
    port: Number.isFinite(Number(f.port)) ? Number(f.port) : null,
    name: f.name ? String(f.name).slice(0, 120) : null,
    share: f.share ? String(f.share).slice(0, 120) : null,
    model: f.model ? String(f.model).slice(0, 80) : null,
  }));
  const { rows } = await runner.query(
    `UPDATE print_agents
        SET scan_at = now(), scan_result = $2::jsonb, scan_error = $3::text
      WHERE id = $1
      RETURNING id::text AS id, scan_at`,
    [agentId, error ? null : JSON.stringify(limpio),
      error ? String(error).slice(0, 400) : null]);
  return rows[0] || null;
}

/** Quién es el que está preguntando por trabajo. */
async function agentByToken(runner, token) {
  if (!token) return null;
  const { rows } = await runner.query(
    `SELECT id::text AS id, nightclub_id::text AS nightclub_id, name, active
       FROM print_agents WHERE token_hash = $1`,
    [hashToken(token)]);
  const agente = rows[0];
  return agente && agente.active ? agente : null;
}

/** Deja constancia de que esa PC sigue viva. */
async function touchAgent(runner, { agentId, version = null }) {
  await runner.query(
    `UPDATE print_agents SET last_seen_at = now(),
            agent_version = COALESCE($2::text, agent_version)
      WHERE id = $1`,
    [agentId, version]);
}

async function setAgentActive(runner, { nightclubId, agentId, active }) {
  const { rows } = await runner.query(
    `UPDATE print_agents SET active = $3
      WHERE id = $1 AND nightclub_id = $2
      RETURNING id::text AS id, name, token_hint, last_seen_at, agent_version, active`,
    [agentId, nightclubId, active]);
  return rows[0] || null;
}

module.exports = {
  DEFAULTS, STALE_MINUTES, REROUTE_AFTER,
  settingsOf, saveSettings,
  listPrinters, getPrinter, resolvePrinter,
  enqueue, enqueueSafely, enqueueTicket, enqueueTest,
  claim, markPrinted, markFailed, reprint, listJobs,
  newToken, hashToken, createAgent, listAgents, agentByToken, touchAgent, setAgentActive,
  SCAN_TTL_MINUTES, requestScan, pendingScan, saveScan,
};
