/**
 * EV2 — las cajas del club (D126).
 *
 * Una caja es donde se cobra: vive en una barra (o en Cover), tiene su nombre, su
 * equipo (la PC de la caja o un teléfono), su impresora de recibos con cajón y su
 * terminal Point. Una barra puede tener varias cajas para cobrar más rápido; todas ven
 * y cobran los pedidos de esa barra, y cada una tiene su fondo y su corte.
 *
 * Este módulo es el alta de las cajas y de lo que cuelga de ellas. El cobro, el fondo y
 * el corte siguen en `till.js` y `shift-closings.js`.
 *
 * Cómo imprime cada equipo:
 *   - **PC**: la estación de siempre (D99, D125): el gerente saca un código, lo pega
 *     en la PC, y el agente registra la impresora USB (o de red) con su cajón.
 *   - **Teléfono**: un teléfono no puede hablar con una impresora desde el navegador
 *     en iPhone, y en Android solo por Bluetooth. Por eso la caja del teléfono imprime en
 *     una impresora térmica DE RED con cajón, y el papel lo saca el agente de una PC del
 *     club (la cola no cambia). Sirve con cualquier teléfono.
 */
'use strict';

const { ApiError } = require('../middleware/errors');
const printing = require('./printing');
const escpos = require('./escpos');

const DEVICES = ['pc', 'phone'];

const TILL_COLS = `t.id::text AS id, t.nightclub_id::text AS nightclub_id,
  t.location_id::text AS location_id, l.name AS location_name, l.kind AS location_kind,
  t.name, t.device, t.sort_order, t.active, t.created_at, t.updated_at`;

/** Una dirección de impresora: IPv4 o nombre de equipo. Nada de URLs ni espacios. */
const HOST_RE = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$|^(?=.{1,120}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;

const isValidHost = (host) => HOST_RE.test(String(host || '').trim());

async function audit(runner, { nightclubId, actorId, action, entityId, before = null, after = null, ip = null }) {
  await runner.query(
    `INSERT INTO audit_log (nightclub_id, actor_id, action, entity, entity_id, before, after, ip)
     VALUES ($1,$2,$3,'till',$4,$5,$6,$7)`,
    [nightclubId, actorId || null, action, entityId,
      before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null, ip || null]);
}

/** Una caja de este club, o 404. `lock` la bloquea para cambiarla. */
async function getTill(runner, { nightclubId, tillId, lock = false }) {
  const { rows } = await runner.query(
    `SELECT ${TILL_COLS}
       FROM tills t JOIN supply_locations l ON l.id = t.location_id
      WHERE t.id = $1 AND t.nightclub_id = $2
      ${lock ? 'FOR UPDATE OF t' : ''}`,
    [tillId, nightclubId]);
  if (rows.length === 0) throw ApiError.notFound('Esa caja no existe');
  return rows[0];
}

/** Las cajas activas de un lugar. */
async function tillsOfLocation(runner, { locationId }) {
  const { rows } = await runner.query(
    `SELECT t.id::text AS id, t.name, t.device
       FROM tills t WHERE t.location_id = $1 AND t.active
      ORDER BY t.sort_order, t.name, t.id`,
    [locationId]);
  return rows;
}

/**
 * Las PCs del club que imprimirían la impresora de esta caja si no se le asigna una:
 * las activas que atienden todo el club, o ese lugar con uso de caja o sin uso fijo
 * (la misma regla que `printing.claim`). `online` dice si se reportaron hace poco.
 */
async function coveringAgents(runner, { nightclubId, locationId }) {
  const { rows } = await runner.query(
    `SELECT a.id::text AS id, a.name, a.last_seen_at,
            (a.last_seen_at IS NOT NULL
             AND a.last_seen_at > now() - make_interval(mins => $3)) AS online
       FROM print_agents a
      WHERE a.nightclub_id = $1 AND a.active
        AND (a.location_id IS NULL
             OR (a.location_id = $2 AND (a.purpose IS NULL OR a.purpose = 'till')))
      ORDER BY a.name`,
    [nightclubId, locationId, printing.STALE_MINUTES]);
  return rows;
}

/**
 * Todas las cajas del club, con lo que cuelga de cada una y lo que le falta.
 *
 * `issues` es lo que el gerente tiene que arreglar antes de abrir: sin impresora, sin
 * cajón, sin PC que imprima la impresora de red del teléfono, o esa PC apagada.
 */
async function list(runner, { nightclubId, includeInactive = false }) {
  const { rows } = await runner.query(
    `SELECT ${TILL_COLS},
            (SELECT COALESCE(json_agg(z.section ORDER BY z.section), '[]'::json)
               FROM zone_bars z WHERE z.location_id = t.location_id) AS sections,
            (SELECT row_to_json(x) FROM (
               SELECT p.id::text AS id, p.name, p.connection, p.host, p.port, p.windows_name,
                      p.drawer_pin, p.agent_id::text AS agent_id, a.name AS agent_name,
                      a.last_seen_at AS agent_last_seen_at,
                      (a.id IS NOT NULL AND a.last_seen_at > now() - make_interval(mins => $3)) AS agent_online
                 FROM printers p LEFT JOIN print_agents a ON a.id = p.agent_id
                WHERE p.till_id = t.id AND p.purpose = 'till' AND p.active
                LIMIT 1) x) AS printer,
            (SELECT row_to_json(x) FROM (
               SELECT pt.id::text AS id, pt.label AS name
                 FROM payment_terminals pt
                WHERE pt.till_id = t.id AND pt.active
                LIMIT 1) x) AS terminal,
            (SELECT row_to_json(x) FROM (
               SELECT s.id::text AS shift_id, u.display_name AS user_name, s.started_at
                 FROM staff_shifts s JOIN users u ON u.id = s.user_id
                WHERE s.till_id = t.id AND s.ended_at IS NULL
                LIMIT 1) x) AS open_shift
       FROM tills t JOIN supply_locations l ON l.id = t.location_id
      WHERE t.nightclub_id = $1 AND ($2::boolean OR (t.active AND l.active))
      ORDER BY l.kind = 'door', l.sort_order, l.name, t.sort_order, t.name, t.id`,
    [nightclubId, includeInactive, printing.STALE_MINUTES]);

  const cobertura = new Map();
  for (const t of rows) {
    const issues = [];
    if (!t.printer) {
      issues.push({ code: 'no_printer' });
    } else {
      if (!t.printer.drawer_pin) issues.push({ code: 'no_drawer' });
      if (t.printer.agent_id) {
        if (!t.printer.agent_online) issues.push({ code: 'agent_offline', agent: t.printer.agent_name });
      } else {
        if (!cobertura.has(t.location_id)) {
          cobertura.set(t.location_id, await coveringAgents(runner, { nightclubId, locationId: t.location_id }));
        }
        const pcs = cobertura.get(t.location_id);
        if (pcs.length === 0) issues.push({ code: 'no_agent' });
        else if (!pcs.some((a) => a.online)) issues.push({ code: 'agent_offline', agent: pcs.map((a) => a.name).join(', ') });
      }
    }
    t.issues = t.active ? issues : [];
  }
  return rows;
}

/** El nombre no se repite entre cajas activas del club (sin distinguir mayúsculas). */
async function assertNameFree(runner, { nightclubId, name, exceptId = null }) {
  const { rows } = await runner.query(
    `SELECT 1 FROM tills
      WHERE nightclub_id = $1 AND active AND lower(name) = lower($2::text)
        AND ($3::uuid IS NULL OR id <> $3::uuid)`,
    [nightclubId, name, exceptId]);
  if (rows.length > 0) throw ApiError.conflict(`Ya hay una caja que se llama "${name}"`);
}

/**
 * Da de alta una caja en una barra. Cover tiene una sola (D118) y ya existe: no se le
 * agregan más.
 */
async function create(client, { nightclubId, locationId, name, device = 'pc', userId, ip = null }) {
  const nombre = String(name || '').trim();
  if (!nombre) throw ApiError.badRequest('Ponle nombre a la caja');
  if (!DEVICES.includes(device)) throw ApiError.badRequest('El equipo es "pc" o "phone"');
  const { rows: lugar } = await client.query(
    `SELECT id, name, kind, active FROM supply_locations
      WHERE id = $1 AND nightclub_id = $2 FOR UPDATE`,
    [locationId, nightclubId]);
  if (lugar.length === 0) throw ApiError.notFound('Ese lugar no existe');
  if (!lugar[0].active) throw ApiError.unprocessable('Ese lugar está apagado');
  if (lugar[0].kind === 'door') {
    throw ApiError.unprocessable('Cover tiene una sola caja: la de la anfitriona (D118).');
  }
  if (lugar[0].kind !== 'bar') throw ApiError.unprocessable('Las cajas van en una barra');
  await assertNameFree(client, { nightclubId, name: nombre });
  const { rows: orden } = await client.query(
    'SELECT COALESCE(max(sort_order), 0) + 1 AS n FROM tills WHERE location_id = $1', [locationId]);
  const { rows } = await client.query(
    `INSERT INTO tills (nightclub_id, location_id, name, device, sort_order, created_by)
     VALUES ($1,$2,$3::text,$4::text,$5,$6) RETURNING id::text AS id`,
    [nightclubId, locationId, nombre, device, orden[0].n, userId || null]);
  const till = await getTill(client, { nightclubId, tillId: rows[0].id });
  await audit(client, {
    nightclubId, actorId: userId, action: 'till.create', entityId: till.id,
    after: { name: till.name, device: till.device, location_id: till.location_id }, ip,
  });
  return till;
}

/**
 * Cambia el nombre, el equipo o el orden de una caja, o la apaga/prende.
 *
 * Apagar se niega si la caja está abierta, si es la última de su barra (los pedidos de
 * esa barra se quedarían sin quién los cobre), si es la de Cover, o si tiene terminal
 * Point (se quita primero, para que no quede una terminal "de nadie"). Su impresora de
 * recibos se apaga con ella.
 */
async function update(client, { nightclubId, tillId, patch, userId, ip = null }) {
  const antes = await getTill(client, { nightclubId, tillId, lock: true });
  const cambios = {};
  if (patch.name !== undefined) {
    const nombre = String(patch.name || '').trim();
    if (!nombre) throw ApiError.badRequest('Ponle nombre a la caja');
    if (nombre.toLowerCase() !== antes.name.toLowerCase() || patch.active === true) {
      await assertNameFree(client, { nightclubId, name: nombre, exceptId: tillId });
    }
    cambios.name = nombre;
  }
  if (patch.device !== undefined) {
    if (!DEVICES.includes(patch.device)) throw ApiError.badRequest('El equipo es "pc" o "phone"');
    cambios.device = patch.device;
  }
  if (patch.sort_order !== undefined) cambios.sort_order = Number(patch.sort_order);

  if (patch.active === false && antes.active) {
    if (antes.location_kind === 'door') {
      throw ApiError.unprocessable('La caja de Cover no se apaga: es la única de la puerta.');
    }
    const abierta = await client.query(
      'SELECT 1 FROM staff_shifts WHERE till_id = $1 AND ended_at IS NULL', [tillId]);
    if (abierta.rowCount > 0) throw ApiError.conflict('Esa caja está abierta: primero se hace su corte.');
    const otras = await client.query(
      'SELECT count(*)::int AS n FROM tills WHERE location_id = $1 AND active AND id <> $2',
      [antes.location_id, tillId]);
    if (otras.rows[0].n === 0) {
      throw ApiError.unprocessable(
        `Es la única caja de ${antes.location_name}: sus pedidos se quedarían sin quién los cobre.`);
    }
    const terminal = await client.query(
      'SELECT label AS name FROM payment_terminals WHERE till_id = $1 AND active', [tillId]);
    if (terminal.rowCount > 0) {
      throw ApiError.unprocessable(`Quita primero la terminal ${terminal.rows[0].name} de esta caja.`);
    }
    cambios.active = false;
  } else if (patch.active === true && !antes.active) {
    if (antes.location_kind === 'door') {
      await client.query('SELECT 1 FROM tills WHERE location_id = $1 FOR UPDATE', [antes.location_id]);
    }
    if (cambios.name === undefined) await assertNameFree(client, { nightclubId, name: antes.name, exceptId: tillId });
    cambios.active = true;
  }

  const keys = Object.keys(cambios);
  if (keys.length > 0) {
    const sets = keys.map((k, i) => `${k} = $${i + 3}`).join(', ');
    try {
      await client.query(`UPDATE tills SET ${sets} WHERE id = $1 AND nightclub_id = $2`,
        [tillId, nightclubId, ...keys.map((k) => cambios[k])]);
    } catch (err) {
      if (err.code === '23505') throw ApiError.conflict('Cover tiene una sola caja.');
      throw err;
    }
    if (cambios.active === false) {
      const { rows: apagadas } = await client.query(
        `UPDATE printers SET active = false, updated_at = now()
          WHERE till_id = $1 AND active RETURNING id::text AS id`, [tillId]);
      await printing.moveJobs(client, { nightclubId, fromIds: apagadas.map((r) => r.id), to: null });
    }
  }
  const despues = await getTill(client, { nightclubId, tillId });
  await audit(client, {
    nightclubId, actorId: userId, action: 'till.update', entityId: tillId,
    before: { name: antes.name, device: antes.device, active: antes.active, sort_order: antes.sort_order },
    after: { name: despues.name, device: despues.device, active: despues.active, sort_order: despues.sort_order },
    ip,
  });
  return despues;
}

/**
 * Las impresoras de red que alguna PC del club vio en su último barrido y que todavía
 * no son de nadie. Es la lista que el gerente ve para la caja del teléfono: escoger es
 * mejor que teclear una IP.
 */
async function networkCandidates(runner, { nightclubId }) {
  const { rows } = await runner.query(
    `SELECT id::text AS id, name, scan_at, scan_result
       FROM print_agents
      WHERE nightclub_id = $1 AND active AND scan_result IS NOT NULL
      ORDER BY scan_at DESC NULLS LAST`,
    [nightclubId]);
  const { rows: ya } = await runner.query(
    `SELECT host FROM printers
      WHERE nightclub_id = $1 AND active AND connection = 'network' AND host IS NOT NULL`,
    [nightclubId]);
  const registradas = ya.map((r) => r.host);
  const porHost = new Map();
  for (const a of rows) {
    for (const c of printing.stationNetworkCandidates(a.scan_result, registradas)) {
      const clave = `${c.host.toLowerCase()}:${c.tcp_port}`;
      if (!porHost.has(clave)) porHost.set(clave, { ...c, seen_by: [] });
      porHost.get(clave).seen_by.push({ id: a.id, name: a.name, scan_at: a.scan_at });
    }
  }
  return [...porHost.values()];
}

/**
 * La impresora de red de una caja (la del teléfono, o la de una PC que no tiene USB).
 *
 * Reemplaza a la que tuviera la caja: la vieja se apaga y sus papeles pendientes pasan a
 * la nueva (como en D125). Sale la hoja de prueba y, si tiene cajón, el pulso.
 *
 * `agentId` es la PC que la imprime. Sin ella la imprime cualquier PC del club que
 * atienda ese lugar; si no hay ninguna, se dice antes de registrar, porque una impresora
 * que nadie imprime es un recibo que no sale a la hora de cobrar.
 */
async function setNetworkPrinter(client, {
  nightclubId, tillId, host, port = 9100, name = null, drawerPin = null, agentId = null,
  paperWidth = 80, userId, ip = null,
}) {
  const till = await getTill(client, { nightclubId, tillId, lock: true });
  if (!till.active) throw ApiError.unprocessable('Esa caja está apagada');
  const direccion = String(host || '').trim();
  if (!isValidHost(direccion)) throw ApiError.badRequest('Esa dirección no es una IP válida (ej. 192.168.1.50)');
  const puerto = Number(port) || 9100;

  const ajena = await client.query(
    `SELECT p.name, t.name AS till_name FROM printers p LEFT JOIN tills t ON t.id = p.till_id
      WHERE p.nightclub_id = $1 AND p.active AND p.connection = 'network'
        AND lower(p.host) = lower($2::text) AND p.port = $3
        AND (p.till_id IS DISTINCT FROM $4::uuid)`,
    [nightclubId, direccion, puerto, tillId]);
  if (ajena.rowCount > 0) {
    const r = ajena.rows[0];
    throw ApiError.conflict(r.till_name
      ? `Esa impresora ya es la de la caja ${r.till_name}: dos cajas no comparten cajón.`
      : `Esa impresora ya está dada de alta como "${r.name}".`);
  }

  if (agentId) {
    const pc = await client.query(
      'SELECT active FROM print_agents WHERE id = $1 AND nightclub_id = $2', [agentId, nightclubId]);
    if (pc.rowCount === 0) throw ApiError.badRequest('Esa PC no existe');
    if (!pc.rows[0].active) throw ApiError.badRequest('Esa PC está apagada en el panel');
  } else {
    const pcs = await coveringAgents(client, { nightclubId, locationId: till.location_id });
    if (pcs.length === 0) {
      throw ApiError.unprocessable(
        `Ninguna PC del club imprime lo de ${till.location_name}. Escoge qué PC va a sacar el papel de esta caja.`,
        { reason: 'no_agent' });
    }
  }

  const nombre = String(name || `${till.name} · recibos`).trim().slice(0, 60);
  const { rows: viejas } = await client.query(
    `UPDATE printers SET active = false, updated_at = now()
      WHERE nightclub_id = $1 AND active
        AND ((till_id = $2 AND purpose = 'till') OR lower(name) = lower($3::text))
      RETURNING id::text AS id`,
    [nightclubId, tillId, nombre]);
  await client.query(
    `UPDATE printers
        SET name = left(name, 40) || ' (baja ' || to_char(now(), 'YYMMDD-HH24MISS') || ')',
            updated_at = now()
      WHERE nightclub_id = $1 AND NOT active AND lower(name) = lower($2::text)`,
    [nightclubId, nombre]);

  const columnas = Number(paperWidth) === 58 ? 32 : 48;
  const { rows } = await client.query(
    `INSERT INTO printers
       (nightclub_id, location_id, till_id, name, purpose, connection, host, port,
        paper_width, columns, codepage, has_cutter, agent_id, drawer_pin)
     VALUES ($1,$2,$3,$4::text,'till','network',$5::text,$6,$7,$8,'CP850',true,$9,$10)
     RETURNING id::text AS id`,
    [nightclubId, till.location_id, tillId, nombre, direccion, puerto,
      Number(paperWidth) === 58 ? 58 : 80, columnas, agentId || null, drawerPin || null]);
  const printer = await printing.getPrinter(client, { nightclubId, printerId: rows[0].id });
  await printing.moveJobs(client, { nightclubId, fromIds: viejas.map((r) => r.id), to: printer });

  const { rows: club } = await client.query('SELECT name FROM nightclubs WHERE id = $1', [nightclubId]);
  const test = await printing.enqueueTest(client, {
    nightclubId, printer, clubName: club[0] ? club[0].name : 'EV2', createdBy: userId,
  });
  let drawer = null;
  if (printer.drawer_pin) {
    drawer = await printing.enqueueSafely(client, {
      nightclubId, printer, kind: 'drawer', copies: 1,
      payload: escpos.drawerPulse(Number(printer.drawer_pin)),
      preview: `[Abrir cajón] alta de la caja ${till.name}`,
      createdBy: userId,
    });
  }
  await audit(client, {
    nightclubId, actorId: userId, action: 'till.printer', entityId: tillId,
    after: {
      printer_id: printer.id, host: direccion, port: puerto, drawer_pin: printer.drawer_pin,
      agent_id: agentId || null, replaced: viejas.map((r) => r.id),
    },
    ip,
  });
  return {
    printer, replaced: viejas.length,
    test_job: test ? { id: test.id, status: test.status } : null,
    drawer_job: drawer ? { id: drawer.id, status: drawer.status } : null,
  };
}

/**
 * La terminal Point de la caja. `terminalId = null` se la quita.
 *
 * Una terminal está en una sola caja y una caja tiene una sola: si la terminal estaba
 * en otra caja se mueve, y si esta caja ya tenía otra, esa queda libre.
 */
async function setTerminal(client, { nightclubId, tillId, terminalId = null, userId, ip = null }) {
  const till = await getTill(client, { nightclubId, tillId, lock: true });
  if (terminalId && !till.active) throw ApiError.unprocessable('Esa caja está apagada');
  const { rows: antes } = await client.query(
    `UPDATE payment_terminals SET location_id = NULL, till_id = NULL, updated_at = now()
      WHERE till_id = $1 AND active AND ($2::uuid IS NULL OR id <> $2::uuid)
      RETURNING id::text AS id`,
    [tillId, terminalId]);
  let terminal = null;
  if (terminalId) {
    const { rows } = await client.query(
      `SELECT id::text AS id, label AS name, active, provider FROM payment_terminals
        WHERE id = $1 AND nightclub_id = $2 FOR UPDATE`,
      [terminalId, nightclubId]);
    if (rows.length === 0) throw ApiError.notFound('Esa terminal no existe');
    if (!rows[0].active) throw ApiError.unprocessable('Esa terminal está apagada');
    const enCurso = await client.query(
      `SELECT 1 FROM terminal_charges
        WHERE terminal_id = $1 AND status IN ('creating','waiting','action_required')`,
      [terminalId]);
    if (enCurso.rowCount > 0) {
      throw ApiError.conflict('Esa terminal tiene un cobro en curso: espera a que termine para moverla.');
    }
    await client.query(
      `UPDATE payment_terminals SET location_id = $2, till_id = $3, updated_at = now()
        WHERE id = $1`,
      [terminalId, till.location_id, tillId]);
    terminal = { id: rows[0].id, name: rows[0].name };
  }
  await audit(client, {
    nightclubId, actorId: userId, action: 'till.terminal', entityId: tillId,
    after: { terminal_id: terminalId, freed: antes.map((r) => r.id) }, ip,
  });
  return { terminal, freed: antes.length };
}

/** La impresora de recibos activa de una caja, o null. */
async function printerOf(runner, { nightclubId, tillId }) {
  return printing.resolvePrinter(runner, { nightclubId, purpose: 'till', tillId });
}

module.exports = {
  DEVICES,
  isValidHost,
  getTill,
  tillsOfLocation,
  coveringAgents,
  list,
  create,
  update,
  networkCandidates,
  setNetworkPrinter,
  setTerminal,
  printerOf,
};
