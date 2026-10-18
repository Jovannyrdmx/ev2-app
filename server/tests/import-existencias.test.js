/**
 * Carga de existencias desde los reportes de SoftRestaurant11.
 *
 * Lo que importa: que el saldo quede EXACTAMENTE en lo que dice el reporte, que entre
 * al kardex como conteo físico, que no deje nada a medias si algo no cuadra, y que no
 * se pueda aplicar dos veces por error.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { setupSchema, truncateAll, closePool, pool } = require('./helpers/db');
const f = require('./helpers/factories');
const { importStock, validate } = require('../scripts/import-existencias');

let club;

beforeAll(setupSchema);
afterAll(closePool);
beforeEach(async () => {
  await truncateAll();
  club = await f.createNightclub({ slug: 'ev2-import' });
});

const data = (over = {}) => ({
  reason: 'Inventario SR11 prueba',
  new_supplies: [{ name: 'SAL', unit: 'pza', package_size: 1, package_label: 'pieza' }],
  locations: [
    { code: 'almacen', items: [
      { supply: 'WHISKY BLACK LABEL', unit: 'ml', quantity: 5250 },
      { supply: 'SAL', unit: 'pza', quantity: 6 },
    ] },
    { code: 'barra-baja', items: [{ supply: 'WHISKY BLACK LABEL', unit: 'ml', quantity: 1695 }] },
    { code: 'barra-alta', items: [{ supply: 'WHISKY BLACK LABEL', unit: 'ml', quantity: 0 }] },
  ],
  ...over,
});

async function run(d, opts = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const report = await importStock(client, { nightclubId: club.id, data: d, ...opts });
    await client.query(report.problems.length ? 'ROLLBACK' : 'COMMIT');
    return report;
  } finally {
    client.release();
  }
}

describe('import-existencias', () => {
  it('deja cada lugar en lo que dice el reporte y lo registra como conteo', async () => {
    const whisky = await f.createSupply(club.id, { name: 'WHISKY BLACK LABEL', unit: 'ml', package_size: 750 });
    await f.stockUp(club.id, whisky.id, club.locations['barra-alta'], 300);

    const report = await run(data());
    expect(report.problems).toEqual([]);
    expect(await f.supplyStock(whisky.id, club.locations.almacen)).toBe(5250);
    expect(await f.supplyStock(whisky.id, club.locations['barra-baja'])).toBe(1695);
    expect(await f.supplyStock(whisky.id, club.locations['barra-alta'])).toBe(0);

    const kinds = await pool.query(
      `SELECT DISTINCT kind FROM supply_movements WHERE supply_id = $1 AND reason LIKE 'Inventario SR11 prueba%'`,
      [whisky.id]);
    expect(kinds.rows.map((r) => r.kind)).toEqual(['count']);
  });

  it('da de alta los insumos que faltan con su unidad', async () => {
    await f.createSupply(club.id, { name: 'WHISKY BLACK LABEL', unit: 'ml', package_size: 750 });
    const report = await run(data());
    expect(report.created).toHaveLength(1);
    const sal = await pool.query(`SELECT id, unit FROM supplies WHERE nightclub_id = $1 AND name = 'SAL'`, [club.id]);
    expect(sal.rows[0].unit).toBe('pza');
    expect(await f.supplyStock(sal.rows[0].id, club.locations.almacen)).toBe(6);
  });

  it('no carga nada si un insumo no existe ni viene como nuevo', async () => {
    const report = await run(data());
    expect(report.problems.join(' ')).toMatch(/WHISKY BLACK LABEL/);
    const n = await pool.query('SELECT count(*)::int AS n FROM supplies WHERE nightclub_id = $1', [club.id]);
    expect(n.rows[0].n).toBe(0);
  });

  it('se detiene si la unidad del sistema no coincide con la del archivo', async () => {
    await f.createSupply(club.id, { name: 'WHISKY BLACK LABEL', unit: 'pza', package_size: 1 });
    const report = await run(data());
    expect(report.problems.join(' ')).toMatch(/pza/);
  });

  it('se niega a aplicarse dos veces salvo --force', async () => {
    await f.createSupply(club.id, { name: 'WHISKY BLACK LABEL', unit: 'ml', package_size: 750 });
    expect((await run(data())).problems).toEqual([]);
    const again = await run(data());
    expect(again.alreadyApplied).toBe(true);
    expect((await run(data(), { force: true })).problems).toEqual([]);
  });

  it('el archivo real del 15/10/2026 es válido', () => {
    const file = path.resolve(__dirname, '../seeds/data/existencias-2026-10-15.json');
    expect(validate(JSON.parse(fs.readFileSync(file, 'utf8')))).toEqual([]);
  });
});
