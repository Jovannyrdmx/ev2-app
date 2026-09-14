#!/usr/bin/env node
// Loads the club's REAL catalogue, exported from SoftRestaurant11.
//
//   npm run seed:menu -- --slug ev2
//
// Until this existed the app sold thirty invented drinks at invented prices. This
// replaces them with what the register actually charges: 129 bar items, the 48 real
// bottles as reservation products, and the three real add-ons.
//
// Three things worth knowing before changing anything here:
//
//   1. **The key is the POS id** (`productos.idproducto`), not the name. It survives a
//      rename in the register, and it is the same key the POS sync will use in phase 4,
//      so loading this file now is also the groundwork for that.
//   2. **Nothing is ever deleted.** A product that leaves the file is deactivated:
//      `drink_orders` point at drinks, and deleting one would tear a hole through
//      tonight's tickets and every past ticket. Deactivated means "not sellable any
//      more", which is what was actually meant.
//   3. **Prices already include tax** (8%, the border-zone rate) because that is how
//      they are charged at the register. Storing the pre-tax price would show the guest
//      a number that does not match what they are asked to pay.
//
// Idempotent: run it as many times as you like. Run it again whenever the register's
// price list changes.
'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { pool } = require('../src/db/pool');

const MENU_PATH = path.resolve(__dirname, 'data/ev2-menu.json');

function parseArgs(argv) {
  const i = argv.indexOf('--slug');
  return { slug: i >= 0 ? argv[i + 1] : 'ev2' };
}

async function loadMenu({ slug = 'ev2', menuPath = MENU_PATH } = {}) {
  const menu = JSON.parse(fs.readFileSync(menuPath, 'utf8'));
  const currency = menu.currency || 'MXN';

  const club = await pool.query('SELECT id, name FROM nightclubs WHERE slug = $1', [slug]);
  if (club.rowCount === 0) throw new Error(`Nightclub '${slug}' not found. Run the base seed first.`);
  const nightclubId = club.rows[0].id;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ------------------------------------------------------------------ bar menu
    for (const [i, item] of menu.items.entries()) {
      const { rows } = await client.query(
        `INSERT INTO drinks (nightclub_id, name, category, price, currency, pos_product_id,
                             available, active, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,true,true,$7)
         ON CONFLICT (nightclub_id, pos_product_id) WHERE pos_product_id IS NOT NULL
           DO UPDATE SET name = EXCLUDED.name, category = EXCLUDED.category,
                         price = EXCLUDED.price, currency = EXCLUDED.currency,
                         active = true, sort_order = EXCLUDED.sort_order,
                         updated_at = now()
         RETURNING id, (xmax = 0) AS inserted`,
        [nightclubId, item.name, item.category, item.price, currency, item.pos_id, i],
      );
      // `available` is the bar's switch for "we ran out tonight" and belongs to whoever
      // is behind the bar: re-running this file must not silently put back on the menu
      // something they just marked as finished.
      //
      // No stock is created here. This used to give every new product 12 (bottles) or
      // 100 (everything else) so the first night could be sold, and those numbers then
      // sat on screen looking measured. Since migration 018 stock belongs to supplies
      // and arrives only through a goods receipt or a physical count; a product with no
      // recipe simply has no stock control, which is the truth.
    }

    const posIds = menu.items.map((i) => i.pos_id);
    const retiredDrinks = await client.query(
      `UPDATE drinks SET active = false, updated_at = now()
        WHERE nightclub_id = $1 AND active AND pos_product_id IS NOT NULL
          AND NOT (pos_product_id = ANY($2::text[]))
        RETURNING name`,
      [nightclubId, posIds],
    );

    // ------------------------------------------------------------------ reservation products
    const products = [
      ...(menu.reservation_bottles || []).map((b) => ({ ...b, kind: 'bottle' })),
      ...(menu.reservation_addons || []).map((a) => ({ ...a, kind: 'addon' })),
    ];
    for (const [i, p] of products.entries()) {
      await client.query(
        `INSERT INTO reservation_products (nightclub_id, kind, code, name, price, currency,
                                           servings, description, sort_order, active)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,true)
         ON CONFLICT (nightclub_id, code) DO UPDATE SET
           kind = EXCLUDED.kind, name = EXCLUDED.name, price = EXCLUDED.price,
           currency = EXCLUDED.currency, sort_order = EXCLUDED.sort_order, active = true`,
        [nightclubId, p.kind, p.code, p.name, p.price, currency,
          p.servings || null, p.description || null, i],
      );
    }
    const codes = products.map((p) => p.code);
    const retiredProducts = await client.query(
      `UPDATE reservation_products SET active = false
        WHERE nightclub_id = $1 AND active AND NOT (code = ANY($2::text[]))
        RETURNING code`,
      [nightclubId, codes],
    );

    await client.query('COMMIT');

    const counts = await pool.query(
      `SELECT category, count(*)::int AS n FROM drinks
        WHERE nightclub_id = $1 AND active GROUP BY category ORDER BY min(sort_order)`,
      [nightclubId],
    );
    return {
      nightclub: club.rows[0].name,
      items: menu.items.length,
      byCategory: counts.rows,
      bottles: (menu.reservation_bottles || []).length,
      addons: (menu.reservation_addons || []).length,
      retiredDrinks: retiredDrinks.rows.map((r) => r.name),
      retiredProducts: retiredProducts.rows.map((r) => r.code),
      cover: menu.cover_reference || [],
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

if (require.main === module) {
  loadMenu(parseArgs(process.argv))
    .then((r) => {
      console.log(`Menú cargado en "${r.nightclub}": ${r.items} productos de barra.`);
      for (const c of r.byCategory) console.log(`  ${c.category.padEnd(14)} ${String(c.n).padStart(3)}`);
      console.log(`  Reservación: ${r.bottles} botellas, ${r.addons} extras.`);
      if (r.retiredDrinks.length) {
        console.log(`  Desactivados (ya no están en la lista): ${r.retiredDrinks.length}`);
        for (const n of r.retiredDrinks.slice(0, 10)) console.log(`    · ${n}`);
        if (r.retiredDrinks.length > 10) console.log(`    · … y ${r.retiredDrinks.length - 10} más`);
      }
      if (r.retiredProducts.length) {
        console.log(`  Productos de reservación desactivados: ${r.retiredProducts.join(', ')}`);
      }
      if (r.cover.length) {
        console.log('  Cover de la caja (para capturar la noche):');
        for (const c of r.cover) console.log(`    · ${c.name.padEnd(12)} $${c.price}`);
      }
      return pool.end();
    })
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Menu seed failed:', err.message);
      pool.end().finally(() => process.exit(1));
    });
}

module.exports = { loadMenu, MENU_PATH };
