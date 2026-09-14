// Minimal fixtures: one club plus whatever each suite asks for.
'use strict';

const bcrypt = require('bcryptjs');
const { randomUUID } = require('crypto');
const { pool } = require('../../src/db/pool');

const PASSWORD = 'TestPassword123';
let cachedHash = null;

async function passwordHash() {
  if (!cachedHash) cachedHash = await bcrypt.hash(PASSWORD, 4); // low cost: tests only
  return cachedHash;
}

async function createNightclub(overrides = {}) {
  const { rows } = await pool.query(
    `INSERT INTO nightclubs (name, slug, city, country, timezone, currency_default, capacity)
     VALUES ($1,$2,'Nogales','MX','America/Hermosillo','MXN',500) RETURNING *`,
    [overrides.name || 'EV2 Test', overrides.slug || 'ev2-test'],
  );
  const club = rows[0];
  // Un club sin barra no puede descontar nada: desde la migracion 018 la existencia
  // vive en un lugar concreto. Se crean los tres del club real -- almacen y las dos
  // barras -- porque probar contra una sola barra esconde justo los errores que
  // importan (el pedido de arriba bajando del estante de abajo).
  if (overrides.locations !== false) {
    const locations = await pool.query(
      `INSERT INTO supply_locations (nightclub_id, code, name, kind, floor, sort_order)
       VALUES ($1,'almacen','Almacen','warehouse',NULL,0),
              ($1,'barra-baja','Barra planta baja','bar','baja',1),
              ($1,'barra-alta','Barra planta alta','bar','alta',2)
       RETURNING id, code`,
      [club.id],
    );
    club.locations = Object.fromEntries(locations.rows.map((l) => [l.code, l.id]));
    club.bar_id = club.locations['barra-baja'];
    club.warehouse_id = club.locations.almacen;
  }
  return club;
}

/** El id de una barra del club por su codigo; por omision, la de planta baja. */
async function barOf(nightclubId, code = 'barra-baja') {
  const { rows } = await pool.query(
    'SELECT id FROM supply_locations WHERE nightclub_id = $1 AND code = $2', [nightclubId, code]);
  return rows.length ? rows[0].id : null;
}

/** Deja existencia en un lugar como lo haria una recepcion, con su renglon de kardex. */
async function stockUp(nightclubId, supplyId, locationId, quantity) {
  // Cargar cero no es un movimiento: crea el renglon del estante y ya. El kardex no
  // admite renglones de cantidad cero, y con razon -- no explican nada.
  if (!quantity) {
    await pool.query(
      `INSERT INTO supply_stock (supply_id, location_id, stock) VALUES ($1,$2,0)
       ON CONFLICT (supply_id, location_id) DO NOTHING`, [supplyId, locationId]);
    return 0;
  }
  const { rows } = await pool.query(
    `INSERT INTO supply_stock (supply_id, location_id, stock) VALUES ($1,$2,$3)
     ON CONFLICT (supply_id, location_id)
       DO UPDATE SET stock = supply_stock.stock + EXCLUDED.stock, updated_at = now()
     RETURNING stock::float8 AS stock`,
    [supplyId, locationId, quantity]);
  await pool.query(
    `INSERT INTO supply_movements (nightclub_id, supply_id, location_id, kind, quantity,
                                   balance_after, reason)
     VALUES ($1,$2,$3,'receipt',$4,$5,'Carga de prueba')`,
    [nightclubId, supplyId, locationId, quantity, rows[0].stock]);
  return Number(rows[0].stock);
}

async function createUser(nightclubId, overrides = {}) {
  const role = overrides.role || 'guest';
  const { rows } = await pool.query(
    `INSERT INTO users (nightclub_id, email, password_hash, first_name, last_name, display_name,
                        role, birth_date, terms_version, terms_accepted_at)
     VALUES ($1,$2,$3,$4,'Test',$5,$6,$7,'test',now()) RETURNING *`,
    [
      nightclubId,
      overrides.email || `${role}-${randomUUID().slice(0, 8)}@test.mx`,
      await passwordHash(),
      overrides.first_name || role,
      overrides.display_name || `${role} Test`,
      role,
      overrides.birth_date || '1995-01-01',
    ],
  );
  await pool.query(
    `INSERT INTO user_preferences (user_id, accept_flirts) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
    [rows[0].id, overrides.accept_flirts ?? false],
  );
  return rows[0];
}

async function createTable(nightclubId, overrides = {}) {
  const { rows } = await pool.query(
    `INSERT INTO tables (nightclub_id, code, section, type, capacity, x, y, radius, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [nightclubId, overrides.code || `T-${randomUUID().slice(0, 6)}`, overrides.section || 'main',
      overrides.type || 'standard', overrides.capacity ?? 4, overrides.x ?? 0, overrides.y ?? 0,
      overrides.radius ?? 1, overrides.status || 'available'],
  );
  return rows[0];
}

async function createDrink(nightclubId, overrides = {}) {
  const { rows } = await pool.query(
    `INSERT INTO drinks (nightclub_id, name, category, price, currency, available)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [nightclubId, overrides.name || `Bebida ${randomUUID().slice(0, 6)}`,
      overrides.category || 'beer', overrides.price ?? 100, overrides.currency || 'MXN',
      overrides.available ?? true],
  );
  // Desde la migracion 018 la existencia vive en el insumo, no en el producto. Una
  // bebida de prueba se crea con su propio insumo de piezas y una receta de 1: es el
  // caso mas simple del modelo real (una cerveza es una cerveza) y deja que las
  // pruebas de siempre sigan hablando de `stock` sin mentir sobre como funciona.
  //
  // `stock: null` crea el producto SIN receta: sin control de existencia, que es lo
  // que hay que probar para el catalogo que todavia no se captura.
  if (overrides.stock !== null) {
    const supply = await pool.query(
      `INSERT INTO supplies (nightclub_id, name, category, unit, package_size, package_label)
       VALUES ($1,$2,$3,'pza',1,'Pieza') RETURNING id`,
      [nightclubId, `Insumo ${rows[0].name}`, overrides.category || 'beer'],
    );
    await pool.query(
      'INSERT INTO drink_supplies (drink_id, supply_id, quantity) VALUES ($1,$2,1)',
      [rows[0].id, supply.rows[0].id],
    );
    // La existencia va a UNA barra: la de planta baja salvo que la prueba diga otra.
    const locationId = overrides.location_id || await barOf(nightclubId);
    if (locationId) {
      await stockUp(nightclubId, supply.rows[0].id, locationId, overrides.stock ?? 50);
      if (overrides.low_stock_threshold !== undefined) {
        await pool.query(
          'UPDATE supply_stock SET min_stock = $3 WHERE supply_id = $1 AND location_id = $2',
          [supply.rows[0].id, locationId, overrides.low_stock_threshold]);
      }
    }
    rows[0].supply_id = supply.rows[0].id;
    rows[0].location_id = locationId;
  }
  return rows[0];
}

/**
 * Existencia de un insumo. Sin lugar, el total del club; con lugar, la de ese
 * estante -- que es la que decide si se puede servir un trago.
 */
async function supplyStock(supplyId, locationId = null) {
  const { rows } = await pool.query(
    `SELECT COALESCE(sum(stock), 0)::float8 AS stock FROM supply_stock
      WHERE supply_id = $1 AND ($2::uuid IS NULL OR location_id = $2::uuid)`,
    [supplyId, locationId]);
  return rows.length ? Number(rows[0].stock) : null;
}

/** Crea un insumo suelto, para recetas de varios ingredientes. */
async function createSupply(nightclubId, overrides = {}) {
  const { rows } = await pool.query(
    `INSERT INTO supplies (nightclub_id, name, category, unit, package_size,
                           package_label, avg_cost, pos_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [nightclubId, overrides.name || `Insumo ${randomUUID().slice(0, 6)}`,
      overrides.category || null, overrides.unit || 'ml',
      overrides.package_size ?? 750, overrides.package_label || 'Botella 750 ml',
      overrides.avg_cost ?? 0, overrides.pos_id || null],
  );
  const supply = rows[0];
  const locationId = overrides.location_id || (overrides.stock ? await barOf(nightclubId) : null);
  if (locationId) {
    if (overrides.stock) await stockUp(nightclubId, supply.id, locationId, overrides.stock);
    if (overrides.min_stock) {
      await pool.query(
        `INSERT INTO supply_stock (supply_id, location_id, stock, min_stock) VALUES ($1,$2,0,$3)
         ON CONFLICT (supply_id, location_id) DO UPDATE SET min_stock = EXCLUDED.min_stock`,
        [supply.id, locationId, overrides.min_stock]);
    }
    supply.location_id = locationId;
  }
  return supply;
}

/** Pone la receta de un producto: [[supply, cantidad], ...]. */
async function setRecipe(drinkId, lines) {
  await pool.query('DELETE FROM drink_supplies WHERE drink_id = $1', [drinkId]);
  for (const [supply, quantity] of lines) {
    await pool.query(
      'INSERT INTO drink_supplies (drink_id, supply_id, quantity) VALUES ($1,$2,$3)',
      [drinkId, supply.id || supply, quantity]);
  }
}

async function createReservationRules(nightclubId, overrides = {}) {
  const { rows } = await pool.query(
    `INSERT INTO reservation_rules (nightclub_id, min_party_size, max_party_size, deposit_pct,
                                    base_price_per_hour, currency, min_advance_hours, max_duration_minutes)
     VALUES ($1,$2,$3,$4,$5,'MXN',$6,360)
     ON CONFLICT (nightclub_id) DO UPDATE SET deposit_pct = EXCLUDED.deposit_pct RETURNING *`,
    [nightclubId, overrides.min_party_size ?? 2, overrides.max_party_size ?? 12,
      overrides.deposit_pct ?? 30, overrides.base_price_per_hour ?? 500,
      overrides.min_advance_hours ?? 2],
  );
  return rows[0];
}

/** A Date `hours` from now, as an ISO string the API accepts. */
function hoursFromNow(hours) {
  return new Date(Date.now() + hours * 3_600_000).toISOString();
}

module.exports = {
  PASSWORD, createNightclub, createUser, createTable, createDrink,
  createReservationRules, hoursFromNow,
  createSupply, setRecipe, supplyStock, barOf, stockUp,
};
