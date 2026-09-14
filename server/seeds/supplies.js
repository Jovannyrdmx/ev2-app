#!/usr/bin/env node
// Carga el almacen real del club: los lugares, los insumos y las recetas.
//
//   npm run seed:supplies -- --slug ev2
//
// Es lo que convierte el inventario en algo que sirve. Hasta antes de esto, vender
// `BUCHANANS 12 - SPRITE` descontaba un contador del propio trago, que nadie
// rellena nunca, mientras la botella de Buchanan's seguia marcando lo mismo. Con
// las recetas cargadas, ese trago baja 30 ml de la botella y la venta de la botella
// entera baja los 750, que es lo que de verdad pasa detras de la barra.
//
// Lo que crea, y lo que deliberadamente NO crea:
//
//   - Tres lugares: almacen, barra de planta baja y barra de planta alta. Son los
//     que el dueno describio; el gerente puede agregar o apagar lugares despues.
//   - La asignacion zona -> barra, por planta: lo de abajo lo sirve la barra de
//     abajo. Es solo el punto de partida; el gerente reasigna zonas cuando quiere,
//     y esta semilla NO pisa una asignacion que ya exista.
//   - 88 insumos con su presentacion y su unidad base, y 129 recetas.
//   - Un punto de entrega por mesa (con su QR) y los de la pista y la terraza.
//   - NINGUNA existencia. Ni una botella. El saldo entra por una recepcion de
//     mercancia o por un conteo fisico, con nombre y hora, y de ninguna otra forma:
//     un inventario que arranca con numeros inventados miente desde el primer dia y
//     nadie vuelve a creerle.
//
// Idempotente: correrlo otra vez actualiza nombres, presentaciones y recetas sin
// tocar saldos ni asignaciones.
'use strict';

require('dotenv').config();
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { pool } = require('../src/db/pool');

const SUPPLIES_PATH = path.resolve(__dirname, 'data/ev2-supplies.json');
const RECIPES_PATH = path.resolve(__dirname, 'data/ev2-recipes.json');

/**
 * Los lugares del club. `floor` es la planta que atiende cada barra, y tiene que
 * coincidir con el `floor` de las mesas del plano (`baja` / `alta`), porque es asi
 * como se decide, sin que nadie configure nada, de que barra sale el primer pedido.
 */
const LOCATIONS = [
  { code: 'almacen', name: 'Almacén', kind: 'warehouse', floor: null, sort_order: 0 },
  { code: 'barra-baja', name: 'Barra planta baja', kind: 'bar', floor: 'baja', sort_order: 1 },
  { code: 'barra-alta', name: 'Barra planta alta', kind: 'bar', floor: 'alta', sort_order: 2 },
];

/**
 * Los puntos de entrega que no son una mesa.
 *
 * En la pista nadie tiene mesa, y un pedido sin direccion es un mesero dando vueltas
 * con una charola. Cada punto lleva su QR pegado en una columna o en la baranda.
 */
const FLOOR_POINTS = [
  { code: 'pista-a', name: 'Pista A', kind: 'floor', floor: 'baja' },
  { code: 'pista-b', name: 'Pista B', kind: 'floor', floor: 'baja' },
  { code: 'terraza', name: 'Terraza', kind: 'terrace', floor: 'alta' },
];

function parseArgs(argv) {
  const i = argv.indexOf('--slug');
  return { slug: i >= 0 ? argv[i + 1] : 'ev2' };
}

/**
 * El token del QR.
 *
 * Aleatorio y opaco a proposito: si el QR llevara el id de la mesa o su nombre,
 * cualquiera que le tome una foto podria pedir a nombre de esa mesa desde su casa.
 * Asi, el token no dice nada por si mismo y se puede reemplazar sin tocar la mesa.
 */
const newToken = () => crypto.randomBytes(16).toString('hex');

async function loadSupplies({ slug = 'ev2', suppliesPath = SUPPLIES_PATH,
  recipesPath = RECIPES_PATH } = {}) {
  const suppliesFile = JSON.parse(fs.readFileSync(suppliesPath, 'utf8'));
  const recipesFile = JSON.parse(fs.readFileSync(recipesPath, 'utf8'));

  const club = await pool.query('SELECT id, name FROM nightclubs WHERE slug = $1', [slug]);
  if (club.rowCount === 0) throw new Error(`Nightclub '${slug}' not found. Run the base seed first.`);
  const nightclubId = club.rows[0].id;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ----------------------------------------------------------------- lugares
    const locationIds = new Map();
    for (const location of LOCATIONS) {
      const { rows } = await client.query(
        `INSERT INTO supply_locations (nightclub_id, code, name, kind, floor, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (nightclub_id, code) DO UPDATE
           SET name = EXCLUDED.name, kind = EXCLUDED.kind, floor = EXCLUDED.floor,
               sort_order = EXCLUDED.sort_order, updated_at = now()
         RETURNING id`,
        [nightclubId, location.code, location.name, location.kind, location.floor,
          location.sort_order],
      );
      locationIds.set(location.code, rows[0].id);
    }

    // ------------------------------------------------- que barra atiende que zona
    // Solo las zonas que todavia no tienen barra: si el gerente movio la terraza a
    // la barra de abajo, volver a correr esto no debe deshacerselo.
    const zones = await client.query(
      `SELECT DISTINCT t.section, t.floor FROM tables t
        WHERE t.nightclub_id = $1 AND t.active
          AND NOT EXISTS (SELECT 1 FROM zone_bars zb
                           WHERE zb.nightclub_id = t.nightclub_id AND zb.section = t.section)`,
      [nightclubId],
    );
    let assigned = 0;
    for (const zone of zones.rows) {
      const code = zone.floor === 'alta' ? 'barra-alta' : 'barra-baja';
      await client.query(
        `INSERT INTO zone_bars (nightclub_id, section, location_id) VALUES ($1,$2,$3)
         ON CONFLICT (nightclub_id, section) DO NOTHING`,
        [nightclubId, zone.section, locationIds.get(code)],
      );
      assigned += 1;
    }

    // ----------------------------------------------------------------- insumos
    let created = 0;
    const supplyIds = new Map();
    for (const supply of suppliesFile.items) {
      const { rows } = await client.query(
        `INSERT INTO supplies (nightclub_id, name, category, unit, package_size,
                               package_label, size_confirmed, pos_id, active)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true)
         ON CONFLICT (nightclub_id, pos_id) WHERE pos_id IS NOT NULL
           DO UPDATE SET name = EXCLUDED.name, category = EXCLUDED.category,
                         unit = EXCLUDED.unit,
                         -- Un tamano YA CONFIRMADO por una persona no se pisa con el
                         -- valor por omision del archivo: confirmarlo es justamente
                         -- lo que el archivo no sabe hacer.
                         package_size = CASE WHEN supplies.size_confirmed
                                             THEN supplies.package_size
                                             ELSE EXCLUDED.package_size END,
                         package_label = CASE WHEN supplies.size_confirmed
                                              THEN supplies.package_label
                                              ELSE EXCLUDED.package_label END,
                         size_confirmed = supplies.size_confirmed OR EXCLUDED.size_confirmed,
                         active = true, updated_at = now()
         RETURNING id, (xmax = 0) AS inserted`,
        [nightclubId, supply.name, supply.category || null, supply.unit, supply.package_size,
          supply.package_label || null, supply.size_confirmed !== false, supply.pos_id],
      );
      supplyIds.set(supply.pos_id, rows[0].id);
      if (rows[0].inserted) created += 1;
    }

    // ----------------------------------------------------------------- recetas
    const drinks = await client.query(
      `SELECT id, pos_product_id FROM drinks
        WHERE nightclub_id = $1 AND pos_product_id IS NOT NULL AND active`,
      [nightclubId],
    );
    const drinkIds = new Map(drinks.rows.map((d) => [d.pos_product_id, d.id]));

    let recipes = 0;
    let lines = 0;
    const missing = [];
    for (const recipe of recipesFile.items) {
      const drinkId = drinkIds.get(recipe.pos_id);
      if (!drinkId) { missing.push(recipe.name); continue; }
      // La receta se reemplaza entera: es una lista, no un historial. Lo que de
      // verdad salio con la receta anterior ya esta en el kardex.
      await client.query('DELETE FROM drink_supplies WHERE drink_id = $1', [drinkId]);
      for (const line of recipe.lines) {
        const supplyId = supplyIds.get(line.supply_pos_id);
        if (!supplyId) { missing.push(`${recipe.name} / ${line.supply_name}`); continue; }
        await client.query(
          `INSERT INTO drink_supplies (drink_id, supply_id, quantity) VALUES ($1,$2,$3)
           ON CONFLICT (drink_id, supply_id)
             DO UPDATE SET quantity = EXCLUDED.quantity, updated_at = now()`,
          [drinkId, supplyId, line.quantity],
        );
        lines += 1;
      }
      recipes += 1;
    }

    // -------------------------------------------------------- puntos de entrega
    let points = 0;
    const tables = await client.query(
      `SELECT id, code, COALESCE(name, code) AS name, section, floor FROM tables
        WHERE nightclub_id = $1 AND active ORDER BY code`,
      [nightclubId],
    );
    for (const table of tables.rows) {
      await client.query(
        `INSERT INTO delivery_points (nightclub_id, code, name, kind, table_id, section, floor,
                                      qr_token, client_selectable)
         VALUES ($1,$2,$3,'table',$4,$5,$6,$7,true)
         ON CONFLICT (nightclub_id, code) DO UPDATE
           SET name = EXCLUDED.name, section = EXCLUDED.section, floor = EXCLUDED.floor,
               table_id = EXCLUDED.table_id, active = true, updated_at = now()`,
        [nightclubId, `mesa-${table.code.toLowerCase()}`, table.name, table.id,
          table.section, table.floor, newToken()],
      );
      points += 1;
    }
    for (const point of FLOOR_POINTS) {
      await client.query(
        `INSERT INTO delivery_points (nightclub_id, code, name, kind, section, floor,
                                      qr_token, client_selectable)
         VALUES ($1,$2,$3,$4,$5,$6,$7,true)
         ON CONFLICT (nightclub_id, code) DO UPDATE
           SET name = EXCLUDED.name, kind = EXCLUDED.kind, floor = EXCLUDED.floor,
               active = true, updated_at = now()`,
        [nightclubId, point.code, point.name, point.kind, point.code, point.floor, newToken()],
      );
      points += 1;
    }
    // La barra como punto de entrega existe para la VENTA EN BARRA -- el cliente que
    // llega y pide ahi mismo -- pero no se puede elegir desde el telefono: el club no
    // quiere gente amontonada esperando su trago (regla de la primera version).
    for (const bar of LOCATIONS.filter((l) => l.kind === 'bar')) {
      await client.query(
        `INSERT INTO delivery_points (nightclub_id, code, name, kind, floor, qr_token,
                                      client_selectable)
         VALUES ($1,$2,$3,'bar',$4,$5,false)
         ON CONFLICT (nightclub_id, code) DO UPDATE
           SET name = EXCLUDED.name, client_selectable = false, active = true, updated_at = now()`,
        [nightclubId, bar.code, bar.name, bar.floor, newToken()],
      );
      points += 1;
    }

    await client.query('COMMIT');

    const unconfirmed = await pool.query(
      `SELECT name FROM supplies WHERE nightclub_id = $1 AND NOT size_confirmed ORDER BY name`,
      [nightclubId],
    );
    const withoutRecipe = await pool.query(
      `SELECT d.name FROM drinks d
        WHERE d.nightclub_id = $1 AND d.active
          AND NOT EXISTS (SELECT 1 FROM drink_supplies ds WHERE ds.drink_id = d.id)
        ORDER BY d.name`,
      [nightclubId],
    );

    return {
      nightclub: club.rows[0].name,
      locations: LOCATIONS.length,
      zonesAssigned: assigned,
      supplies: suppliesFile.items.length,
      suppliesCreated: created,
      recipes,
      recipeLines: lines,
      deliveryPoints: points,
      missing,
      unconfirmed: unconfirmed.rows.map((r) => r.name),
      withoutRecipe: withoutRecipe.rows.map((r) => r.name),
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

if (require.main === module) {
  loadSupplies(parseArgs(process.argv))
    .then((r) => {
      console.log(`Almacén cargado en "${r.nightclub}":`);
      console.log(`  ${r.locations} lugares · ${r.zonesAssigned} zonas asignadas a una barra`);
      console.log(`  ${r.supplies} insumos (${r.suppliesCreated} nuevos)`);
      console.log(`  ${r.recipes} recetas · ${r.recipeLines} renglones`);
      console.log(`  ${r.deliveryPoints} puntos de entrega con QR`);
      if (r.withoutRecipe.length) {
        console.log(`  ${r.withoutRecipe.length} productos SIN receta (se venden sin control de existencia):`);
        for (const name of r.withoutRecipe) console.log(`      ${name}`);
      }
      if (r.unconfirmed.length) {
        console.log(`  ${r.unconfirmed.length} presentaciones POR CONFIRMAR (cargadas con 750 ml):`);
        for (const name of r.unconfirmed) console.log(`      ${name}`);
      }
      if (r.missing.length) {
        console.log(`  ${r.missing.length} renglones sin cargar (producto o insumo ausente):`);
        for (const name of r.missing) console.log(`      ${name}`);
      }
      console.log('\n  Existencia: CERO. Entra por recepción de mercancía o por conteo físico.');
      return pool.end();
    })
    .catch((err) => {
      console.error('El almacén no se pudo cargar:', err.message);
      pool.end().finally(() => process.exit(1));
    });
}

module.exports = { loadSupplies, LOCATIONS, FLOOR_POINTS };
