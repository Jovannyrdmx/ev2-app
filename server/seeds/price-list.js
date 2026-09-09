#!/usr/bin/env node
// Loads the club's official price list: the zone tariffs, and only those.
//
// Bottles and add-ons used to be invented here. They now come from the register's real
// catalogue (`npm run seed:menu`, seeds/data/ev2-menu.json), which is the only place
// that knows what the club actually charges.
//
//   npm run seed:prices -- --slug ev2
//
// Idempotent. Zones missing from the file are deactivated rather than deleted so that
// past reservations keep resolving their zone.
'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { pool } = require('../src/db/pool');

const LIST_PATH = path.resolve(__dirname, 'data/ev2-price-list.json');

function parseArgs(argv) {
  const i = argv.indexOf('--slug');
  return { slug: i >= 0 ? argv[i + 1] : 'ev2' };
}

async function loadPriceList({ slug = 'ev2', listPath = LIST_PATH } = {}) {
  const list = JSON.parse(fs.readFileSync(listPath, 'utf8'));

  const club = await pool.query('SELECT id, name FROM nightclubs WHERE slug = $1', [slug]);
  if (club.rowCount === 0) throw new Error(`Nightclub '${slug}' not found. Run the base seed first.`);
  const nightclubId = club.rows[0].id;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const z of list.zones) {
      await client.query(
        `INSERT INTO zone_pricing (nightclub_id, section, display_name, base_price, included_tickets,
                                   max_extras, currency, color, includes, reservable, sort_order, active)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,true)
         ON CONFLICT (nightclub_id, section) DO UPDATE SET
           display_name = EXCLUDED.display_name, base_price = EXCLUDED.base_price,
           included_tickets = EXCLUDED.included_tickets, max_extras = EXCLUDED.max_extras,
           currency = EXCLUDED.currency, color = EXCLUDED.color, includes = EXCLUDED.includes,
           reservable = EXCLUDED.reservable, sort_order = EXCLUDED.sort_order, active = true`,
        [nightclubId, z.section, z.display_name || z.section, z.base_price, z.included_tickets,
          z.max_extras, list.currency || 'MXN', z.color || null,
          JSON.stringify(z.includes || []), z.reservable !== false, z.sort_order || 0],
      );
    }

    const sections = list.zones.map((z) => z.section);
    const retired = await client.query(
      `UPDATE zone_pricing SET active = false
        WHERE nightclub_id = $1 AND active AND NOT (section = ANY($2::text[]))
        RETURNING section`,
      [nightclubId, sections],
    );

    await client.query('COMMIT');

    const summary = await pool.query(
      `SELECT section, base_price, included_tickets, max_extras, reservable
         FROM zone_pricing WHERE nightclub_id = $1 AND active ORDER BY sort_order, section`,
      [nightclubId],
    );
    return {
      nightclub: club.rows[0].name,
      zones: summary.rows,
      retired: retired.rows.map((r) => r.section),
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

if (require.main === module) {
  loadPriceList(parseArgs(process.argv))
    .then((r) => {
      console.log(`Price list loaded into "${r.nightclub}": ${r.zones.length} zones.`);
      for (const z of r.zones) {
        const extras = Number(z.max_extras) === 0 ? 'sin extras' : `${z.max_extras} extras`;
        const flag = z.reservable ? '' : '  (no reservable)';
        console.log(`  ${z.section.padEnd(22)} $${String(z.base_price).padStart(8)}  ` +
          `${z.included_tickets} boletos, ${extras}${flag}`);
      }
      if (r.retired.length) console.log(`  Desactivadas: ${r.retired.join(', ')}`);
      return pool.end();
    })
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Price list seed failed:', err.message);
      pool.end().finally(() => process.exit(1));
    });
}

module.exports = { loadPriceList, LIST_PATH };
