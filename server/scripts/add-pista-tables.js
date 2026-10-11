#!/usr/bin/env node
/**
 * EV2 — agrega las 19 mesas de la pista de baile de planta baja (PISTA 1 a PISTA 19).
 *
 * Qué hace
 * --------
 * Crea, en planta baja, 19 mesas llamadas PISTA 1 … PISTA 19 dentro de la pista de baile
 * (landmark `dance_baja`), cada una con su punto de entrega y QR (como toda mesa), y deja
 * la zona PISTA atendida por la Barra planta baja. Sube la revisión del plano para que el
 * mapa 3D y el plano 2D las dibujen sin recargar.
 *
 * Decisiones del dueño (Jovanny, 2026-10-10): 19 mesas, capacidad 4, tipo standard, sin
 * servicio de botella, zona PISTA con la Barra planta baja. El acomodo (5 columnas x 4
 * filas, la última casilla vacía) sale de que la pista mide 210x120 y las mesas 32 y 33
 * ya ocupan su borde derecho: las nuevas quedan a la izquierda y al centro, sin tocar a
 * ninguna existente.
 *
 * Es seguro repetirlo: una mesa que ya existe (mismo código) no se toca, y lo que no
 * existe se crea. Deja constancia en `audit_log`.
 *
 * Uso (dentro del contenedor de la API)
 * -------------------------------------
 *   node scripts/add-pista-tables.js --dry     # solo dice qué haría
 *   node scripts/add-pista-tables.js           # lo hace
 * Con --club <slug> cuando la base tiene más de un club.
 */
'use strict';

const crypto = require('crypto');
const { pool } = require('../src/db/pool');
const floorLayout = require('../src/services/floor-layout');
const events = require('../src/services/events');

const SECTION = 'PISTA';
const FLOOR = 'baja';
const COUNT = 19;
const CAPACITY = 4;
const RADIUS = 12;
// Rejilla dentro de la pista: columnas de 27 y filas de 28, desde la esquina izquierda.
const COLS = 5;
const X0 = 312;
const Y0 = 164;
const DX = 27;
const DY = 28;

/** Las posiciones de las 19 mesas, en orden de lectura (izquierda a derecha, arriba abajo). */
function positions() {
  return Array.from({ length: COUNT }, (_, i) => ({
    n: i + 1,
    x: X0 + (i % COLS) * DX,
    y: Y0 + Math.floor(i / COLS) * DY,
  }));
}

async function run({ clubSlug = null, dry = false, log = console.log } = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const clubs = await client.query(
      clubSlug ? 'SELECT id, slug FROM nightclubs WHERE slug = $1' : 'SELECT id, slug FROM nightclubs',
      clubSlug ? [clubSlug] : []);
    if (clubs.rowCount !== 1) {
      throw new Error(clubs.rowCount === 0
        ? 'No encontré el club.' : 'Hay más de un club: dime cuál con --club <slug>.');
    }
    const club = clubs.rows[0];

    const dance = await client.query(
      `SELECT x, y, width, height FROM venue_landmarks
        WHERE nightclub_id = $1 AND code = 'dance_baja' AND active`, [club.id]);
    if (dance.rowCount === 0) throw new Error('No existe la pista de baile de planta baja (dance_baja).');
    const area = dance.rows[0];

    const bar = await client.query(
      `SELECT id FROM supply_locations
        WHERE nightclub_id = $1 AND code = 'barra-baja' AND kind = 'bar' AND active`, [club.id]);
    if (bar.rowCount === 0) throw new Error('No encontré la Barra planta baja (barra-baja).');

    // Todas las mesas tienen que quedar DENTRO de la pista y sin encimarse con otra.
    const spots = positions();
    const dentro = (p) => p.x - RADIUS >= Number(area.x) && p.x + RADIUS <= Number(area.x) + Number(area.width)
      && p.y - RADIUS >= Number(area.y) && p.y + RADIUS <= Number(area.y) + Number(area.height);
    const fuera = spots.filter((p) => !dentro(p));
    if (fuera.length) throw new Error(`Las mesas ${fuera.map((p) => p.n).join(', ')} quedarían fuera de la pista.`);

    const vecinas = await client.query(
      `SELECT code, x, y, radius FROM tables
        WHERE nightclub_id = $1 AND active AND floor = $2 AND section <> $3`,
      [club.id, FLOOR, SECTION]);
    for (const p of spots) {
      for (const t of vecinas.rows) {
        const d = Math.hypot(Number(t.x) - p.x, Number(t.y) - p.y);
        if (d < Number(t.radius) + RADIUS + 2) {
          throw new Error(`PISTA ${p.n} se encimaría con la mesa ${t.code}.`);
        }
      }
    }

    let created = 0;
    for (const p of spots) {
      const code = `PISTA-${p.n}`;
      const name = `PISTA ${p.n}`;
      const exists = await client.query(
        'SELECT id FROM tables WHERE nightclub_id = $1 AND code = $2', [club.id, code]);
      if (exists.rowCount) continue;
      created += 1;
      if (dry) continue;
      const t = await client.query(
        `INSERT INTO tables (nightclub_id, code, name, section, type, capacity, x, y, radius,
                             floor, table_number, bottle_service)
         VALUES ($1,$2,$3,$4,'standard',$5,$6,$7,$8,$9,NULL,false) RETURNING id`,
        [club.id, code, name, SECTION, CAPACITY, p.x, p.y, RADIUS, FLOOR]);
      await client.query(
        `INSERT INTO delivery_points (nightclub_id, code, name, kind, table_id, section, floor,
                                      qr_token, client_selectable)
         VALUES ($1,$2,$3,'table',$4,$5,$6,$7,true)`,
        [club.id, `mesa-${code.toLowerCase()}`, name, t.rows[0].id, SECTION, FLOOR,
          crypto.randomBytes(16).toString('hex')]);
    }

    const zone = await client.query(
      'SELECT location_id FROM zone_bars WHERE nightclub_id = $1 AND section = $2', [club.id, SECTION]);
    const zoneNew = zone.rowCount === 0;
    if (zoneNew && !dry) {
      await client.query(
        'INSERT INTO zone_bars (nightclub_id, section, location_id) VALUES ($1,$2,$3)',
        [club.id, SECTION, bar.rows[0].id]);
    }

    if (dry) {
      log(`Simulación: crearía ${created} mesa(s) PISTA y ${zoneNew ? 'asignaría' : 'ya tiene asignada'} la zona a la Barra planta baja.`);
      await client.query('ROLLBACK');
      return { created, zoneNew, dry: true };
    }

    if (created > 0 || zoneNew) {
      await client.query(
        `INSERT INTO audit_log (nightclub_id, actor_id, action, entity, entity_id, before, after)
         VALUES ($1, NULL, 'pista_tables_added_from_console', 'tables', NULL, $2, $3)`,
        [club.id, JSON.stringify({}), JSON.stringify({ created, section: SECTION, floor: FLOOR, capacity: CAPACITY })]);
      await events.publish({
        nightclubId: club.id, type: 'table_updated', client,
        audience: { roles: ['waiter', 'bartender', 'hostess', 'manager', 'admin'] },
        payload: { action: 'layout_changed', count: created },
      });
      await floorLayout.bump(client, club.id);
    }
    await client.query('COMMIT');
    log(`Listo: ${created} mesa(s) PISTA creadas${created === 0 ? ' (ya existían todas)' : ''}; zona ${zoneNew ? 'asignada a' : 'ya atendida por'} la Barra planta baja.`);
    return { created, zoneNew, dry: false };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { run, positions, SECTION, COUNT };

if (require.main === module) {
  const args = process.argv.slice(2);
  const i = args.indexOf('--club');
  run({ clubSlug: i >= 0 ? args[i + 1] : null, dry: args.includes('--dry') })
    .then(() => pool.end())
    .catch((err) => {
      console.error(`No se hizo nada: ${err.message}`);
      pool.end().finally(() => process.exit(1));
    });
}
