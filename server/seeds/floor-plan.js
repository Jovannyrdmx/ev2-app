#!/usr/bin/env node
// Loads the club's real floor plan (52 tables + 6 landmarks) into a nightclub.
//
//   npm run seed:floor -- --slug ev2
//
// Idempotent: re-running updates the layout in place and never touches occupancy,
// orders or reservations. Tables that disappear from the plan are deactivated rather
// than deleted, so their history survives.
'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { pool } = require('../src/db/pool');

const PLAN_PATH = path.resolve(__dirname, 'data/ev2-floor-plan.json');

function parseArgs(argv) {
  const slugIndex = argv.indexOf('--slug');
  return { slug: slugIndex >= 0 ? argv[slugIndex + 1] : 'ev2' };
}

async function loadFloorPlan({ slug, planPath = PLAN_PATH } = {}) {
  const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));

  const club = await pool.query('SELECT id, name FROM nightclubs WHERE slug = $1', [slug]);
  if (club.rowCount === 0) throw new Error(`Nightclub '${slug}' not found. Run the base seed first.`);
  const nightclubId = club.rows[0].id;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const t of plan.tables) {
      await client.query(
        `INSERT INTO tables (nightclub_id, code, table_number, name, section, floor, type,
                             capacity, x, y, radius, bottle_service, color, active)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,true)
         ON CONFLICT (nightclub_id, code) DO UPDATE SET
           table_number = EXCLUDED.table_number, name = EXCLUDED.name,
           section = EXCLUDED.section, floor = EXCLUDED.floor, type = EXCLUDED.type,
           capacity = EXCLUDED.capacity, x = EXCLUDED.x, y = EXCLUDED.y,
           radius = EXCLUDED.radius, bottle_service = EXCLUDED.bottle_service,
           color = EXCLUDED.color, active = true`,
        [nightclubId, t.code, t.table_number, t.name, t.section, t.floor, t.type,
          t.capacity, t.x, t.y, t.radius, t.bottle_service, t.color],
      );
    }

    // Tables no longer in the plan are retired, not deleted: their orders and
    // reservations must keep pointing at something.
    const codes = plan.tables.map((t) => t.code);
    const retired = await client.query(
      `UPDATE tables SET active = false
        WHERE nightclub_id = $1 AND active AND NOT (code = ANY($2::text[]))
        RETURNING code`,
      [nightclubId, codes],
    );

    for (const l of plan.landmarks) {
      await client.query(
        `INSERT INTO venue_landmarks (nightclub_id, code, name, type, description, floor, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (nightclub_id, code) DO UPDATE SET
           name = EXCLUDED.name, type = EXCLUDED.type, description = EXCLUDED.description,
           floor = EXCLUDED.floor, sort_order = EXCLUDED.sort_order, active = true`,
        [nightclubId, l.code, l.name, l.type, l.description, l.floor, l.sort_order],
      );
    }

    await client.query(
      `UPDATE nightclubs SET settings = settings || $2::jsonb WHERE id = $1`,
      [nightclubId, JSON.stringify({ floor_plan: { version: plan.version, canvas: plan.canvas } })],
    );

    await client.query('COMMIT');

    const summary = await pool.query(
      `SELECT floor, section, count(*)::int AS tables, sum(capacity)::int AS seats
         FROM tables WHERE nightclub_id = $1 AND active
        GROUP BY floor, section ORDER BY floor, section`,
      [nightclubId],
    );
    return {
      nightclub: club.rows[0].name,
      tables: plan.tables.length,
      landmarks: plan.landmarks.length,
      seats: plan.tables.reduce((s, t) => s + t.capacity, 0),
      retired: retired.rows.map((r) => r.code),
      breakdown: summary.rows,
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

if (require.main === module) {
  loadFloorPlan(parseArgs(process.argv))
    .then((r) => {
      console.log(`Floor plan loaded into "${r.nightclub}": ${r.tables} tables, ` +
        `${r.landmarks} landmarks, ${r.seats} seats.`);
      for (const row of r.breakdown) {
        console.log(`  ${row.floor.padEnd(6)} ${row.section.padEnd(20)} ${String(row.tables).padStart(2)} mesas, ${row.seats} lugares`);
      }
      if (r.retired.length) console.log(`  Retiradas del plano: ${r.retired.join(', ')}`);
      return pool.end();
    })
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Floor plan seed failed:', err.message);
      pool.end().finally(() => process.exit(1));
    });
}

module.exports = { loadFloorPlan, PLAN_PATH };
