/**
 * El pool lleno no congela el sistema (D104).
 *
 * Una ruta que tiene su conexión retenida y pide OTRA al pool se queda esperando a que
 * alguien suelte la suya. Con el pool lleno de rutas iguales nadie la suelta: todas
 * esperan 5 s, el pool contesta "timeout" y los meseros ven error en pedidos que SÍ se
 * guardaron. Pasaba con diez pedidos del mismo producto a la vez (una promo).
 *
 * Dos pruebas: la ráfaga real con un pool chico, y un recorrido del código que exige que
 * ninguna ruta use `pool` mientras retiene una conexión.
 */
'use strict';

// El pool se arma al cargar el módulo: el tamaño se fija antes de cualquier require.
process.env.DB_POOL_MAX = '3';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { setupSchema, truncateAll, closePool } = require('./helpers/db');
const { api, auth } = require('./helpers/api');
const f = require('./helpers/factories');

beforeAll(setupSchema);
afterAll(closePool);
beforeEach(truncateAll);

test('una ráfaga de pedidos del mismo producto con el pool lleno no da error', async () => {
  const club = await f.createNightclub({ slug: 'ev2-pool' });
  const waiter = await f.createUser(club.id, { role: 'waiter', on_shift: true });
  const table = await f.createTable(club.id, { section: 'ROJA' });
  const drink = await f.createDrink(club.id, { name: 'Cerveza promo', price: 50, stock: 20 });

  const t0 = Date.now();
  const res = await Promise.all(Array.from({ length: 12 }, () => api()
    .post(`/api/nightclubs/${club.id}/orders`).set(auth(waiter))
    .send({ client_request_id: randomUUID(), table_id: table.id,
      items: [{ drink_id: drink.id, quantity: 1 }] })));
  const elapsed = Date.now() - t0;

  expect(res.map((r) => r.status)).toEqual(Array(12).fill(201));
  expect(await f.supplyStock(drink.supply_id, club.bar_id)).toBe(8);
  // Sin el arreglo, cada ráfaga se quedaba 5 s esperando al pool.
  expect(elapsed).toBeLessThan(4000);
});

test('ninguna ruta pide otra conexión al pool mientras retiene la suya', () => {
  const dirs = ['../src/routes', '../src/services', '../src/services/pos']
    .map((d) => path.join(__dirname, d));
  const offenders = [];
  for (const dir of dirs) {
    for (const name of fs.readdirSync(dir).filter((n) => n.endsWith('.js'))) {
      const file = path.join(dir, name);
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      let holding = false;
      lines.forEach((line, i) => {
        if (/=\s*await pool\.connect\(\)/.test(line)) { holding = true; return; }
        if (/\.release\(\)/.test(line)) { holding = false; return; }
        if (holding && /[^\w.]pool\.(query|connect)\(|\(pool[,)]/.test(line)) {
          offenders.push(`${path.relative(path.join(__dirname, '..'), file)}:${i + 1}`);
        }
      });
    }
  }
  expect(offenders).toEqual([]);
});
