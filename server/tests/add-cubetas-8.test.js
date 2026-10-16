/**
 * Cubetas de 8 piezas: producto nuevo a $200 que descuenta 8 cervezas de la barra.
 */
'use strict';

const { randomUUID } = require('crypto');
const { setupSchema, truncateAll, closePool, pool } = require('./helpers/db');
const { api, auth } = require('./helpers/api');
const f = require('./helpers/factories');
const { addCubetas } = require('../scripts/add-cubetas-8');

let club; let guest; let table; let light; let roja;

beforeAll(setupSchema);
afterAll(closePool);
beforeEach(async () => {
  await truncateAll();
  club = await f.createNightclub({ slug: 'ev2-cub8' });
  guest = await f.createUser(club.id, { role: 'guest' });
  table = await f.createTable(club.id, { code: 'T-1' });
  light = await f.createSupply(club.id, { name: 'TECATE LIGHT', unit: 'pza', package_size: 1, pos_id: '001051', stock: 20 });
  roja = await f.createSupply(club.id, { name: 'TECATE ROJA', unit: 'pza', package_size: 1, pos_id: '001059', stock: 20 });
});

async function run() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const done = await addCubetas(client, { nightclubId: club.id });
    await client.query('COMMIT');
    return done;
  } finally {
    client.release();
  }
}

describe('add-cubetas-8', () => {
  it('crea las dos cubetas a $200 con receta de 8 piezas', async () => {
    await run();
    const { rows } = await pool.query(
      `SELECT d.name, d.price::float8 AS price, d.pos_product_id, s.name AS supply, ds.quantity::float8 AS q
         FROM drinks d JOIN drink_supplies ds ON ds.drink_id = d.id JOIN supplies s ON s.id = ds.supply_id
        WHERE d.nightclub_id = $1 ORDER BY d.name`, [club.id]);
    expect(rows).toEqual([
      { name: 'CUBETA TECATE LIGHT 8 PZ', price: 200, pos_product_id: null, supply: 'TECATE LIGHT', q: 8 },
      { name: 'CUBETA TECATE ROJA 8 PZ', price: 200, pos_product_id: null, supply: 'TECATE ROJA', q: 8 },
    ]);
  });

  it('vender una cubeta baja 8 cervezas', async () => {
    await run();
    const d = await pool.query(`SELECT id FROM drinks WHERE name = 'CUBETA TECATE LIGHT 8 PZ' AND nightclub_id = $1`, [club.id]);
    const res = await api().post(`/api/nightclubs/${club.id}/orders`).set(auth(guest)).send({
      client_request_id: randomUUID(), table_id: table.id, items: [{ drink_id: d.rows[0].id, quantity: 1 }],
    });
    expect(res.status).toBe(201);
    expect(await f.supplyStock(light.id)).toBe(12);
    expect(await f.supplyStock(roja.id)).toBe(20);
  });

  it('correrlo dos veces no duplica productos ni recetas', async () => {
    await run();
    await run();
    const n = await pool.query(`SELECT count(*)::int AS n FROM drinks WHERE nightclub_id = $1`, [club.id]);
    expect(n.rows[0].n).toBe(2);
    const r = await pool.query(
      `SELECT count(*)::int AS n FROM drink_supplies ds JOIN drinks d ON d.id = ds.drink_id WHERE d.nightclub_id = $1`, [club.id]);
    expect(r.rows[0].n).toBe(2);
  });
});
