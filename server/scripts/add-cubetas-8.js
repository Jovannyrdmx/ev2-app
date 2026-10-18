#!/usr/bin/env node
/**
 * EV2 — agrega a la carta las cubetas de 8 piezas con su receta.
 *
 *   CUBETA TECATE LIGHT 8 PZ  $200  -> descuenta 8 pza de TECATE LIGHT
 *   CUBETA TECATE ROJA 8 PZ   $200  -> descuenta 8 pza de TECATE ROJA
 *
 * Son productos NUEVOS: las cubetas de SoftRestaurant11 ("CUB. TECATE ... 1/4", $300,
 * 10 piezas) se quedan como están.
 *
 * Se crean sin `pos_product_id` a propósito: no existen en SoftRestaurant11, y un id
 * inventado haría que `seed:menu` (que apaga lo que no está en el archivo de la caja)
 * las diera de baja la próxima vez que se corra. Sin id de caja son como cualquier
 * producto dado de alta desde el panel del gerente, y ninguna semilla las toca.
 *
 * Idempotente: si el producto ya existe (mismo nombre) actualiza precio y receta.
 * Vista previa por omisión; guarda con --apply.
 *
 *   docker exec ev2-api node scripts/add-cubetas-8.js
 *   docker exec ev2-api node scripts/add-cubetas-8.js --apply
 */
'use strict';

require('dotenv').config();
const os = require('os');
const { pool } = require('../src/db/pool');

const CUBETAS = [
  { name: 'CUBETA TECATE LIGHT 8 PZ', price: 200, supply: { pos_id: '001051', name: 'TECATE LIGHT' }, pieces: 8 },
  { name: 'CUBETA TECATE ROJA 8 PZ', price: 200, supply: { pos_id: '001059', name: 'TECATE ROJA' }, pieces: 8 },
];
// Junto a las cubetas que ya tiene la carta, para que el mesero las encuentre ahí.
const SIBLINGS = { 'TECATE LIGHT': 'CUB. TECATE LIGHT 1/4', 'TECATE ROJA': 'CUB. TECATE ROJA 1/4' };

function parseArgs(argv) {
  const i = argv.indexOf('--club');
  return { slug: i >= 0 ? argv[i + 1] : 'ev2', apply: argv.includes('--apply') };
}

async function addCubetas(client, { nightclubId }) {
  const done = [];
  for (const c of CUBETAS) {
    const supply = await client.query(
      `SELECT id, name, unit FROM supplies
        WHERE nightclub_id = $1 AND active AND (pos_id = $2 OR lower(btrim(name)) = lower($3))
        ORDER BY (pos_id = $2) DESC LIMIT 1`,
      [nightclubId, c.supply.pos_id, c.supply.name]);
    if (supply.rowCount === 0) throw new Error(`No existe el insumo ${c.supply.name} (corre seed:supplies)`);
    if (supply.rows[0].unit !== 'pza') {
      throw new Error(`${supply.rows[0].name} está en ${supply.rows[0].unit}, se esperaba pza`);
    }

    const sibling = await client.query(
      `SELECT category, currency, sort_order FROM drinks
        WHERE nightclub_id = $1 AND name = $2 ORDER BY active DESC LIMIT 1`,
      [nightclubId, SIBLINGS[c.supply.name]]);
    const base = sibling.rows[0] || { category: 'Cervezas', currency: 'MXN', sort_order: 0 };

    const existing = await client.query(
      `SELECT id, price::float8 AS price FROM drinks
        WHERE nightclub_id = $1 AND lower(btrim(name)) = lower($2) LIMIT 1`,
      [nightclubId, c.name]);
    let drinkId;
    let action;
    if (existing.rowCount) {
      drinkId = existing.rows[0].id;
      await client.query(
        `UPDATE drinks SET price = $2, active = true, available = true, updated_at = now()
          WHERE id = $1`, [drinkId, c.price]);
      action = existing.rows[0].price === c.price ? 'ya existía' : `precio ${existing.rows[0].price} -> ${c.price}`;
    } else {
      const { rows } = await client.query(
        `INSERT INTO drinks (nightclub_id, name, category, price, currency, available, active, sort_order)
         VALUES ($1,$2,$3,$4,$5,true,true,$6) RETURNING id`,
        [nightclubId, c.name, base.category, c.price, base.currency, base.sort_order]);
      drinkId = rows[0].id;
      action = 'creado';
    }

    // La receta se reemplaza entera, igual que en el panel del gerente.
    await client.query('DELETE FROM drink_supplies WHERE drink_id = $1', [drinkId]);
    await client.query(
      'INSERT INTO drink_supplies (drink_id, supply_id, quantity) VALUES ($1,$2,$3)',
      [drinkId, supply.rows[0].id, c.pieces]);

    await client.query(
      `INSERT INTO audit_log (nightclub_id, actor_id, action, entity, entity_id, before, after)
       VALUES ($1, NULL, 'drink_added_from_console', 'drink', $2, $3, $4)`,
      [nightclubId, drinkId, existing.rowCount ? JSON.stringify({ price: existing.rows[0].price }) : null,
        JSON.stringify({ name: c.name, price: c.price, recipe: [{ supply: supply.rows[0].name, quantity: c.pieces }],
          operator: `${os.userInfo().username}@${os.hostname()}` })]);
    done.push({ name: c.name, price: c.price, supply: supply.rows[0].name, pieces: c.pieces, action });
  }
  return done;
}

async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  const club = await pool.query('SELECT id, name FROM nightclubs WHERE slug = $1', [opts.slug]);
  if (club.rowCount === 0) { console.error(`No existe el club '${opts.slug}'`); return 1; }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const done = await addCubetas(client, { nightclubId: club.rows[0].id });
    await client.query(opts.apply ? 'COMMIT' : 'ROLLBACK');
    for (const d of done) {
      console.log(`  ${d.name.padEnd(28)} $${d.price}  receta: ${d.pieces} pza ${d.supply}  (${d.action})`);
    }
    console.log(opts.apply ? 'Guardado.' : 'VISTA PREVIA: no se guardó nada. Para guardar, agrega --apply.');
    return 0;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(err.message);
    return 1;
  } finally {
    client.release();
  }
}

if (require.main === module) {
  main().then((code) => pool.end().then(() => process.exit(code)));
}

module.exports = { addCubetas, CUBETAS };
