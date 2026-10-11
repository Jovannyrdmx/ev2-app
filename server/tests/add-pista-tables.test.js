/**
 * Las 19 mesas de la pista de baile (scripts/add-pista-tables.js).
 *
 * Lo que importa: que queden DENTRO de la pista, sin tocar a ninguna otra mesa, con su
 * punto de entrega, atendidas por la Barra planta baja; y que repetirlo no duplique nada.
 */
'use strict';

const { setupSchema, truncateAll, closePool, pool } = require('./helpers/db');
const f = require('./helpers/factories');
const script = require('../scripts/add-pista-tables');

let club;
beforeAll(setupSchema);
afterAll(closePool);

beforeEach(async () => {
  await truncateAll();
  club = await f.createNightclub({ slug: 'ev2-pista' });
  await pool.query(
    `INSERT INTO venue_landmarks (nightclub_id, code, name, type, floor, x, y, width, height)
     VALUES ($1,'dance_baja','DANCE FLOOR','dance_area','baja',300,150,210,120)`, [club.id]);
  // Las que ya están en el borde derecho de la pista.
  for (const [code, y] of [['32', 196], ['33', 242]]) {
    await pool.query(
      `INSERT INTO tables (nightclub_id, code, name, section, type, capacity, x, y, radius, floor)
       VALUES ($1,$2,$2,'ZONA AZUL','vip',10,468,$3,34,'baja')`, [club.id, code, y]);
  }
});

const quiet = () => {};

describe('Mesas de la pista', () => {
  it('crea PISTA 1 a PISTA 19 dentro de la pista, con punto de entrega y barra', async () => {
    const r = await script.run({ log: quiet });
    expect(r).toMatchObject({ created: 19, zoneNew: true });

    const { rows } = await pool.query(
      `SELECT name, code, section, type, capacity, floor, bottle_service, x, y, radius
         FROM tables WHERE section = 'PISTA' ORDER BY length(code), code`);
    expect(rows).toHaveLength(19);
    expect(rows[0]).toMatchObject({ name: 'PISTA 1', code: 'PISTA-1', type: 'standard', capacity: 4, floor: 'baja', bottle_service: false });
    expect(rows[18].name).toBe('PISTA 19');
    for (const t of rows) {
      expect(Number(t.x) - Number(t.radius)).toBeGreaterThanOrEqual(300);
      expect(Number(t.x) + Number(t.radius)).toBeLessThanOrEqual(510);
      expect(Number(t.y) - Number(t.radius)).toBeGreaterThanOrEqual(150);
      expect(Number(t.y) + Number(t.radius)).toBeLessThanOrEqual(270);
      // Ninguna se encima con las existentes.
      expect(Math.hypot(Number(t.x) - 468, Number(t.y) - 196)).toBeGreaterThan(34 + Number(t.radius));
      expect(Math.hypot(Number(t.x) - 468, Number(t.y) - 242)).toBeGreaterThan(34 + Number(t.radius));
    }
    // Ni entre ellas.
    for (let i = 0; i < rows.length; i += 1) {
      for (let j = i + 1; j < rows.length; j += 1) {
        expect(Math.hypot(rows[i].x - rows[j].x, rows[i].y - rows[j].y)).toBeGreaterThan(24);
      }
    }

    const puntos = await pool.query(`SELECT count(*)::int AS n FROM delivery_points WHERE section = 'PISTA' AND table_id IS NOT NULL`);
    expect(puntos.rows[0].n).toBe(19);
    const zona = await pool.query('SELECT location_id FROM zone_bars WHERE section = $1', ['PISTA']);
    expect(zona.rows[0].location_id).toBe(club.bar_id);
    const rev = await pool.query(`SELECT (settings#>>'{floor_plan,revision}')::int AS r FROM nightclubs WHERE id = $1`, [club.id]);
    expect(rev.rows[0].r).toBe(1);
    const audit = await pool.query(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'pista_tables_added_from_console'`);
    expect(audit.rows[0].n).toBe(1);
  });

  it('repetirlo no duplica nada', async () => {
    await script.run({ log: quiet });
    const otra = await script.run({ log: quiet });
    expect(otra).toMatchObject({ created: 0, zoneNew: false });
    expect((await pool.query(`SELECT count(*)::int AS n FROM tables WHERE section = 'PISTA'`)).rows[0].n).toBe(19);
    expect((await pool.query(`SELECT count(*)::int AS n FROM delivery_points WHERE section = 'PISTA'`)).rows[0].n).toBe(19);
  });

  it('en simulación no escribe nada', async () => {
    const r = await script.run({ dry: true, log: quiet });
    expect(r).toMatchObject({ created: 19, dry: true });
    expect((await pool.query(`SELECT count(*)::int AS n FROM tables WHERE section = 'PISTA'`)).rows[0].n).toBe(0);
    expect((await pool.query('SELECT count(*)::int AS n FROM zone_bars')).rows[0].n).toBe(0);
  });

  it('si una mesa existente estorba, se detiene sin crear nada', async () => {
    await pool.query(
      `INSERT INTO tables (nightclub_id, code, section, type, capacity, x, y, radius, floor)
       VALUES ($1,'99','GENERAL','standard',4,340,190,20,'baja')`, [club.id]);
    await expect(script.run({ log: quiet })).rejects.toThrow(/se encimaría/);
    expect((await pool.query(`SELECT count(*)::int AS n FROM tables WHERE section = 'PISTA'`)).rows[0].n).toBe(0);
  });

  it('sin la pista de baile, lo dice', async () => {
    await pool.query(`DELETE FROM venue_landmarks WHERE code = 'dance_baja'`);
    await expect(script.run({ log: quiet })).rejects.toThrow(/dance_baja/);
  });
});
