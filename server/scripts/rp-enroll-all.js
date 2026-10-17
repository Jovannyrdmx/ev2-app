#!/usr/bin/env node
/**
 * EV2 — da codigo de RP a todo el personal activo, sin cambiarle el puesto (D120).
 *
 * Que hace
 * --------
 * A cada empleado y gerente activo (todo usuario del club que no sea cliente ni la
 * cuenta del dueno, con su perfil de empleado activo) le crea su perfil de RP con un
 * codigo unico y la comision indicada. El mesero sigue siendo mesero: el codigo solo
 * le permite que la puerta le atribuya mesas y covers, como a cualquier RP.
 *
 * Es seguro repetirlo: quien ya tiene codigo NO se toca (ni codigo, ni porcentaje, ni
 * si esta activo); solo se crea lo que falta. Deja constancia en `audit_log`.
 * Al final imprime la lista completa (nuevos y existentes) con nombre, puesto, codigo
 * y porcentaje. Con --csv la imprime en CSV para pasarla a Excel.
 *
 * Decision del dueno (Jovanny, 2026-10-16): todos los empleados, incluidos gerentes,
 * con 5% de comision.
 *
 * Uso (dentro del contenedor de la API)
 * -------------------------------------
 *   node scripts/rp-enroll-all.js --pct 5 --dry    # solo dice que haria
 *   node scripts/rp-enroll-all.js --pct 5          # lo hace
 *   node scripts/rp-enroll-all.js --list --csv     # solo la lista, sin crear nada
 * Con --club <slug> cuando la base tiene mas de un club.
 */
'use strict';

const { pool } = require('../src/db/pool');
const rp = require('../src/services/rp');

function parsePct(raw) {
  const n = Number(raw);
  if (raw === undefined || raw === null || raw === '' || !Number.isFinite(n) || n < 0 || n > 100) {
    throw new Error('Indica la comision con --pct <0-100>, por ejemplo --pct 5.');
  }
  return Math.round(n * 100) / 100;
}

const csvCell = (v) => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** La lista de todo el personal con codigo de RP del club. */
async function roster(runner, nightclubId) {
  const { rows } = await runner.query(
    `SELECT u.id AS user_id, u.display_name, u.first_name, u.last_name, u.role,
            p.code, p.commission_pct::text AS commission_pct, p.active
       FROM rp_profiles p JOIN users u ON u.id = p.user_id
      WHERE p.nightclub_id = $1
      ORDER BY u.role, u.display_name`, [nightclubId]);
  return rows;
}

async function run({ clubSlug = null, pct = null, dry = false, listOnly = false,
  csv = false, log = console.log } = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const clubs = await client.query(
      clubSlug ? 'SELECT id, slug FROM nightclubs WHERE slug = $1' : 'SELECT id, slug FROM nightclubs',
      clubSlug ? [clubSlug] : []);
    if (clubs.rowCount !== 1) {
      throw new Error(clubs.rowCount === 0
        ? 'No encontre el club.' : 'Hay mas de un club: dime cual con --club <slug>.');
    }
    const club = clubs.rows[0];

    let created = [];
    if (!listOnly) {
      const commissionPct = parsePct(pct);
      const staff = await client.query(
        `SELECT u.id, u.display_name, u.role
           FROM users u LEFT JOIN employee_profiles ep ON ep.user_id = u.id
          WHERE u.nightclub_id = $1 AND u.status = 'active'
            AND NOT (u.role = ANY($2::text[])) AND COALESCE(ep.active, true)
            AND NOT EXISTS (SELECT 1 FROM rp_profiles p WHERE p.user_id = u.id)
          ORDER BY u.role, u.display_name
          FOR UPDATE OF u`, [club.id, rp.NOT_STAFF]);
      for (const u of staff.rows) {
        if (await rp.ensureProfile(client, { nightclubId: club.id, userId: u.id, commissionPct })) {
          created.push(u);
        }
      }
      if (created.length > 0) {
        await client.query(
          `INSERT INTO audit_log (nightclub_id, actor_id, action, entity, entity_id, before, after)
           VALUES ($1, NULL, 'rp.enroll_all_from_console', 'rp_profiles', NULL, $2, $3)`,
          [club.id, JSON.stringify({}), JSON.stringify({
            created: created.length, commission_pct: commissionPct,
            user_ids: created.map((u) => u.id),
          })]);
      }
    }

    const list = await roster(client, club.id);
    const newIds = new Set(created.map((u) => u.id));
    if (csv) {
      log('nombre,puesto,codigo,comision_pct,activo,nuevo');
      for (const r of list) {
        log([r.display_name, r.role, r.code, r.commission_pct, r.active ? 'si' : 'no',
          newIds.has(r.user_id) ? 'si' : 'no'].map(csvCell).join(','));
      }
    } else {
      for (const r of list) {
        log(`${r.code}  ${r.commission_pct.padStart(6)}%  ${r.role.padEnd(10)}  ${r.display_name}`
          + `${r.active ? '' : '  (inactivo)'}${newIds.has(r.user_id) ? '  [nuevo]' : ''}`);
      }
    }

    if (dry || listOnly) {
      await client.query('ROLLBACK');
      if (!listOnly) log(`Simulacion: crearia ${created.length} codigo(s) de RP. No se guardo nada.`);
      return { created: created.length, dry: true, list };
    }
    await client.query('COMMIT');
    if (!csv) log(`Listo: ${created.length} codigo(s) de RP nuevos; ${list.length} en total.`);
    return { created: created.length, dry: false, list };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { run, parsePct };

if (require.main === module) {
  const args = process.argv.slice(2);
  const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
  run({
    clubSlug: opt('--club'),
    pct: opt('--pct'),
    dry: args.includes('--dry'),
    listOnly: args.includes('--list'),
    csv: args.includes('--csv'),
  })
    .then(() => pool.end())
    .catch((err) => {
      console.error(`No se hizo nada: ${err.message}`);
      pool.end().finally(() => process.exit(1));
    });
}
