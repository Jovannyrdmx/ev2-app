#!/usr/bin/env node
/**
 * EV2 — carga las existencias reales del almacén y las barras desde los reportes de
 * inventario de SoftRestaurant11.
 *
 * Por qué existe
 * --------------
 * El sistema no inventa saldos: la existencia entra por una recepción o por un
 * conteo físico, con nombre y motivo. Este script es ese conteo, hecho una sola vez
 * con los números que el club ya tiene contados en SoftRestaurant11 (reportes
 * EXISTENCIAS ALM / B1 / BVIP del 15/10/2026), para no capturar 300 renglones a mano.
 *
 * Qué hace
 * --------
 *   1. Da de alta los insumos que existen en SoftRestaurant11 y todavía no en EV2
 *      (sal, popotes, Be Light, Hornitos Reposado, ...), con su unidad y presentación.
 *   2. Por cada lugar (almacen, barra-baja = Barra 1, barra-alta = Barra VIP) registra
 *      un CONTEO FÍSICO por insumo: el saldo queda en lo que dice el reporte, y la
 *      diferencia contra lo que había entra al kardex con el motivo del archivo.
 *
 * Las cantidades ya vienen convertidas en el archivo de datos (1 oz = 30 ml, botellas
 * por su tamaño de presentación, packs por sus piezas) y cada renglón trae las líneas
 * del reporte de las que sale, para que cualquiera pueda rehacer la cuenta.
 *
 * Qué NO hace
 * -----------
 * No toca recetas, precios ni la carta. No reactiva insumos dados de baja ni cambia la
 * unidad de un insumo existente: si encuentra cualquiera de las dos cosas, se detiene
 * y lo dice. Y no se corre dos veces por error: un segundo conteo con los números del
 * 15/10 borraría todo lo vendido desde entonces, así que si ya se aplicó se niega
 * (salvo --force).
 *
 * Uso (en el servidor, dentro del contenedor de la API)
 * -----------------------------------------------------
 *   node scripts/import-existencias.js                 # solo vista previa, no guarda nada
 *   node scripts/import-existencias.js --apply         # guarda
 *   node scripts/import-existencias.js --apply --user gerente@club.com
 *
 * Opciones: --club <slug> (ev2), --file <ruta.json>, --user <correo> (queda como quien
 * capturó el conteo), --force (permite volver a aplicarlo).
 */
'use strict';

require('dotenv').config();
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pool } = require('../src/db/pool');
const inventory = require('../src/services/inventory');

const DEFAULT_FILE = path.resolve(__dirname, '../seeds/data/existencias-2026-10-15.json');
const LOCATION_CODES = ['almacen', 'barra-baja', 'barra-alta'];

function parseArgs(argv) {
  const value = (flag) => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
  };
  return {
    slug: value('--club') || 'ev2',
    file: value('--file') || DEFAULT_FILE,
    user: value('--user'),
    apply: argv.includes('--apply'),
    force: argv.includes('--force'),
  };
}

const norm = (s) => String(s || '').trim().toLowerCase();

/** Revisa el archivo antes de tocar la base: un error aquí no debe dejar nada a medias. */
function validate(data) {
  const errors = [];
  if (!data || typeof data !== 'object') return ['El archivo no es un objeto JSON'];
  if (!data.reason || String(data.reason).length > 150) errors.push('Falta `reason` (máx. 150 caracteres)');
  if (!Array.isArray(data.locations) || data.locations.length === 0) errors.push('Falta `locations`');
  const newNames = new Set();
  for (const s of data.new_supplies || []) {
    if (!s.name || !inventory.UNITS.includes(s.unit) || !(Number(s.package_size) > 0)) {
      errors.push(`Insumo nuevo inválido: ${JSON.stringify(s)}`);
    }
    if (newNames.has(norm(s.name))) errors.push(`Insumo nuevo repetido: ${s.name}`);
    newNames.add(norm(s.name));
  }
  const seen = new Set();
  for (const loc of data.locations || []) {
    if (!LOCATION_CODES.includes(loc.code)) errors.push(`Lugar desconocido: ${loc.code}`);
    if (seen.has(loc.code)) errors.push(`Lugar repetido: ${loc.code}`);
    seen.add(loc.code);
    const items = new Set();
    for (const it of loc.items || []) {
      const q = Number(it.quantity);
      if (!it.supply || !Number.isFinite(q) || q < 0) {
        errors.push(`${loc.code}: renglón inválido ${JSON.stringify(it.supply)} = ${it.quantity}`);
      }
      if (!inventory.UNITS.includes(it.unit)) errors.push(`${loc.code}/${it.supply}: unidad ${it.unit}`);
      if (items.has(norm(it.supply))) errors.push(`${loc.code}: ${it.supply} aparece dos veces`);
      items.add(norm(it.supply));
    }
  }
  return errors;
}

/**
 * Hace todo dentro de la transacción del llamador. Devuelve el reporte; quien llama
 * decide si hace COMMIT (--apply) o ROLLBACK (vista previa). Así la vista previa es
 * exactamente lo que se guardaría, insumos nuevos incluidos.
 */
async function importStock(client, { nightclubId, data, userId = null, force = false }) {
  const report = { created: [], problems: [], lines: [], alreadyApplied: false };

  const prior = await client.query(
    `SELECT count(*)::int AS n FROM supply_movements
      WHERE nightclub_id = $1 AND kind = 'count' AND reason LIKE $2`,
    [nightclubId, `${data.reason}%`]);
  if (prior.rows[0].n > 0 && !force) {
    report.alreadyApplied = true;
    report.problems.push(`Este inventario ya se aplicó (${prior.rows[0].n} movimientos con el motivo `
      + `"${data.reason}"). Volver a aplicarlo borraría lo vendido desde entonces. Usa --force solo si es a propósito.`);
    return report;
  }

  const locs = await client.query(
    `SELECT id, code, name, active FROM supply_locations
      WHERE nightclub_id = $1 AND code = ANY($2)`, [nightclubId, LOCATION_CODES]);
  const locationByCode = new Map(locs.rows.map((l) => [l.code, l]));
  for (const loc of data.locations) {
    const l = locationByCode.get(loc.code);
    if (!l) report.problems.push(`No existe el lugar '${loc.code}' (corre primero seed:supplies)`);
    else if (!l.active) report.problems.push(`El lugar '${loc.code}' está desactivado`);
  }

  // ----------------------------------------------------------- resolver insumos
  const existing = await client.query(
    `SELECT id, name, unit, active, pos_id FROM supplies WHERE nightclub_id = $1`, [nightclubId]);
  const byName = new Map(existing.rows.map((s) => [norm(s.name), s]));
  const byPos = new Map(existing.rows.filter((s) => s.pos_id).map((s) => [s.pos_id, s]));
  const newByName = new Map((data.new_supplies || []).map((s) => [norm(s.name), s]));

  const supplyFor = new Map(); // norm(name) -> fila de supplies
  const wanted = new Map();
  for (const loc of data.locations) for (const it of loc.items) wanted.set(norm(it.supply), it);

  for (const [key, it] of wanted) {
    const found = (it.pos_id && byPos.get(it.pos_id)) || byName.get(key);
    if (found) {
      if (!found.active) report.problems.push(`El insumo '${found.name}' está dado de baja en EV2`);
      if (found.unit !== it.unit) {
        report.problems.push(`'${found.name}' está en ${found.unit} en EV2 y el archivo lo trae en ${it.unit}`);
      }
      supplyFor.set(key, found);
      continue;
    }
    const spec = newByName.get(key);
    if (!spec) { report.problems.push(`'${it.supply}' no existe en EV2 ni en la lista de insumos nuevos`); continue; }
    if (spec.unit !== it.unit) report.problems.push(`'${spec.name}': unidad ${spec.unit} vs ${it.unit}`);
    const { rows } = await client.query(
      `INSERT INTO supplies (nightclub_id, name, category, unit, package_size, package_label,
                             size_confirmed, active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,true)
       RETURNING id, name, unit, active, pos_id`,
      [nightclubId, spec.name, spec.category || null, spec.unit, spec.package_size,
        spec.package_label || null, spec.size_confirmed !== false]);
    supplyFor.set(key, rows[0]);
    report.created.push(`${spec.name} (${spec.unit}, presentación ${spec.package_size})`);
  }
  if (report.problems.length) return report;

  // ------------------------------------------------------------------- conteos
  for (const loc of data.locations) {
    const location = locationByCode.get(loc.code);
    const reason = `${data.reason} — ${loc.code}`.slice(0, 200);
    for (const it of loc.items) {
      const supply = supplyFor.get(norm(it.supply));
      const counted = Math.round(Number(it.quantity) * 1000) / 1000;
      const result = await inventory.count(client, {
        nightclubId, supplyId: supply.id, locationId: location.id, counted, reason, userId,
      });
      // Un insumo que el reporte da en cero y nunca había estado en ese lugar no
      // genera movimiento; se deja su renglón en el estante para que se vea en cero.
      if (counted === 0 && !result.movement) {
        await client.query(
          `INSERT INTO supply_stock (supply_id, location_id, stock) VALUES ($1,$2,0)
           ON CONFLICT (supply_id, location_id) DO NOTHING`, [supply.id, location.id]);
      }
      report.lines.push({
        location: loc.code, supply: supply.name, unit: supply.unit,
        before: Math.round((counted - result.difference) * 1000) / 1000,
        after: counted, difference: result.difference,
      });
    }
  }

  await client.query(
    `INSERT INTO audit_log (nightclub_id, actor_id, action, entity, entity_id, before, after)
     VALUES ($1, $2, 'stock_imported_from_sr11', 'supply_stock', NULL, NULL, $3)`,
    [nightclubId, userId, JSON.stringify({
      reason: data.reason,
      counted_on: data.counted_on || null,
      lines: report.lines.length,
      changed: report.lines.filter((l) => l.difference !== 0).length,
      created_supplies: report.created,
      operator: `${os.userInfo().username}@${os.hostname()}`,
    })]);
  return report;
}

function printReport(report, { apply }) {
  const fmt = (n) => Number(n).toLocaleString('es-MX', { maximumFractionDigits: 3 });
  if (report.created.length) {
    console.log(`\nInsumos nuevos (${report.created.length}):`);
    for (const c of report.created) console.log(`  + ${c}`);
  }
  for (const code of LOCATION_CODES) {
    const lines = report.lines.filter((l) => l.location === code);
    if (!lines.length) continue;
    const changed = lines.filter((l) => l.difference !== 0);
    console.log(`\n== ${code}: ${lines.length} insumos, ${changed.length} cambian ==`);
    for (const l of changed) {
      const sign = l.difference > 0 ? '+' : '';
      console.log(`  ${l.supply.padEnd(44)} ${fmt(l.before).padStart(10)} -> ${fmt(l.after).padStart(10)} ${l.unit}`
        + `  (${sign}${fmt(l.difference)})`);
    }
  }
  console.log(apply
    ? '\nGuardado. Cada cambio quedó en el kardex como conteo físico, y el resumen en audit_log.'
    : '\nVISTA PREVIA: no se guardó nada. Para guardar, corre lo mismo con --apply.');
}

async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  const data = JSON.parse(fs.readFileSync(opts.file, 'utf8'));
  const errors = validate(data);
  if (errors.length) {
    console.error('El archivo de existencias tiene errores:');
    for (const e of errors) console.error(`  - ${e}`);
    return 1;
  }

  const club = await pool.query('SELECT id, name FROM nightclubs WHERE slug = $1', [opts.slug]);
  if (club.rowCount === 0) { console.error(`No existe el club '${opts.slug}'`); return 1; }
  const nightclubId = club.rows[0].id;

  let userId = null;
  if (opts.user) {
    const u = await pool.query(
      `SELECT id FROM users WHERE nightclub_id = $1 AND lower(email) = lower($2)
         AND role IN ('manager','admin','warehouse')`, [nightclubId, opts.user]);
    if (u.rowCount === 0) { console.error(`No hay gerente/almacén con el correo ${opts.user}`); return 1; }
    userId = u.rows[0].id;
  }

  console.log(`Club: ${club.rows[0].name}  |  Archivo: ${path.basename(opts.file)}  |  ${opts.apply ? 'APLICAR' : 'vista previa'}`);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const report = await importStock(client, { nightclubId, data, userId, force: opts.force });
    if (report.problems.length) {
      await client.query('ROLLBACK');
      console.error('\nNo se cargó nada:');
      for (const p of report.problems) console.error(`  - ${p}`);
      return 1;
    }
    await client.query(opts.apply ? 'COMMIT' : 'ROLLBACK');
    printReport(report, opts);
    return 0;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

if (require.main === module) {
  main()
    .then((code) => pool.end().then(() => process.exit(code)))
    .catch((err) => {
      console.error(err.message);
      pool.end().finally(() => process.exit(1));
    });
}

module.exports = { importStock, validate, parseArgs, main };
