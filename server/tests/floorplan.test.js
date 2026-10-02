'use strict';

const path = require('path');
const { setupSchema, truncateAll, closePool, pool } = require('./helpers/db');
const { api, auth } = require('./helpers/api');
const f = require('./helpers/factories');
const { loadFloorPlan } = require('../seeds/floor-plan');

let club; let guest; let manager; let waiter;

beforeAll(setupSchema);
afterAll(closePool);
beforeEach(async () => {
  await truncateAll();
  club = await f.createNightclub({ slug: 'ev2' });
  guest = await f.createUser(club.id, { role: 'guest' });
  manager = await f.createUser(club.id, { role: 'manager' });
  waiter = await f.createUser(club.id, { role: 'waiter' });
});

const url = (p) => `/api/nightclubs/${club.id}${p}`;

describe('Carga del plano real', () => {
  it('carga las 55 mesas y las 8 áreas del club', async () => {
    const result = await loadFloorPlan({ slug: 'ev2' });
    expect(result.tables).toBe(55);
    expect(result.landmarks).toBe(8);
    expect(result.seats).toBe(308);
  });

  it('distingue con prefijo las mesas cuyo número se repetía', async () => {
    await loadFloorPlan({ slug: 'ev2' });
    const { rows } = await pool.query(
      `SELECT code, section, capacity FROM tables
        WHERE nightclub_id = $1 AND table_number IN (16,17,18) ORDER BY code`, [club.id]);

    expect(rows.map((r) => r.code)).toEqual(['G16', 'G17', 'G18', 'VE16', 'VE17', 'VE18']);
    // Las VE son las del VIP ELEVADO, de 8 lugares; las G son las generales de 4.
    expect(rows.filter((r) => r.code.startsWith('VE')).every((r) => r.capacity === 8)).toBe(true);
    expect(rows.filter((r) => r.code.startsWith('G')).every((r) => r.capacity === 4)).toBe(true);
  });

  it('reparte las mesas en los dos pisos', async () => {
    await loadFloorPlan({ slug: 'ev2' });
    const { rows } = await pool.query(
      `SELECT floor, count(*)::int AS n FROM tables WHERE nightclub_id = $1 GROUP BY floor ORDER BY floor`,
      [club.id]);
    expect(rows).toEqual([{ floor: 'alta', n: 12 }, { floor: 'baja', n: 43 }]);
  });

  it('es idempotente y no duplica al recargar', async () => {
    await loadFloorPlan({ slug: 'ev2' });
    await loadFloorPlan({ slug: 'ev2' });
    const { rows } = await pool.query(
      'SELECT count(*)::int AS n FROM tables WHERE nightclub_id = $1', [club.id]);
    expect(rows[0].n).toBe(55);
  });

  it('recargar el plano no borra la ocupación en curso', async () => {
    await loadFloorPlan({ slug: 'ev2' });
    const table = await pool.query(
      `SELECT id FROM tables WHERE nightclub_id = $1 AND code = 'VE16'`, [club.id]);
    await api().post(url(`/tables/${table.rows[0].id}/seat`)).set(auth(manager)).send({ user_id: guest.id });

    await loadFloorPlan({ slug: 'ev2' });

    const { rows } = await pool.query(
      'SELECT count(*)::int AS n FROM table_occupants WHERE left_at IS NULL');
    expect(rows[0].n).toBe(1);
  });

  it('retira las mesas que ya no están en el plano en vez de borrarlas', async () => {
    const old = await f.createTable(club.id, { code: 'MESA-VIEJA' });
    const result = await loadFloorPlan({ slug: 'ev2' });

    expect(result.retired).toContain('MESA-VIEJA');
    const { rows } = await pool.query('SELECT active FROM tables WHERE id = $1', [old.id]);
    expect(rows[0].active).toBe(false); // sigue existiendo, para no perder su historial
  });

  it('falla con un club inexistente', async () => {
    await expect(loadFloorPlan({ slug: 'no-existe' })).rejects.toThrow(/not found/);
  });

  it('el archivo del plano no tiene códigos repetidos', () => {
    const plan = require(path.resolve(__dirname, '../seeds/data/ev2-floor-plan.json'));
    const codes = plan.tables.map((t) => t.code);
    expect(new Set(codes).size).toBe(codes.length);
  });
});

describe('GET /floor-plan', () => {
  beforeEach(async () => { await loadFloorPlan({ slug: 'ev2' }); });

  it('devuelve mesas, áreas y el tamaño del lienzo', async () => {
    const res = await api().get(url('/floor-plan')).set(auth(guest));
    expect(res.status).toBe(200);
    expect(res.body.tables).toHaveLength(55);
    expect(res.body.landmarks.map((l) => l.name)).toEqual(
      expect.arrayContaining(['BARRA', 'DANCE FLOOR', 'DJ BOOTH', 'ENTRADA CLANDESTINOZ', 'W.C. AREA']));
    expect(res.body.canvas).toEqual({ width: 800, height: 580 });
    expect(res.body.floors.sort()).toEqual(['alta', 'baja']);
  });

  it('cada mesa trae lo necesario para dibujarla', async () => {
    const res = await api().get(url('/floor-plan')).set(auth(guest));
    expect(res.body.tables[0]).toEqual(expect.objectContaining({
      code: expect.any(String),
      section: expect.any(String),
      floor: expect.any(String),
      capacity: expect.any(Number),
      x: expect.any(String),
      y: expect.any(String),
      radius: expect.any(String),
      status: expect.any(String),
      seated: expect.any(Number),
    }));
  });

  it('filtra por piso e incluye las áreas comunes', async () => {
    const res = await api().get(url('/floor-plan?floor=alta')).set(auth(guest));
    expect(res.body.tables).toHaveLength(12);
    expect(res.body.tables.every((t) => t.floor === 'alta')).toBe(true);
    // BARRA y DANCE FLOOR están en 'ambas' y deben verse desde cualquier piso.
    expect(res.body.landmarks.map((l) => l.name)).toContain('BARRA');
  });

  it('refleja quién está sentado', async () => {
    const table = await pool.query(`SELECT id FROM tables WHERE code = '39' AND nightclub_id = $1`, [club.id]);
    await api().post(url(`/tables/${table.rows[0].id}/seat`)).set(auth(manager)).send({ user_id: guest.id });

    const res = await api().get(url('/floor-plan')).set(auth(guest));
    const t39 = res.body.tables.find((t) => t.code === '39');
    expect(t39.seated).toBe(1);
    expect(t39.status).toBe('occupied');
  });

  it('exige autenticación', async () => {
    expect((await api().get(url('/floor-plan'))).status).toBe(401);
  });
});

describe('GET /tables/stats', () => {
  beforeEach(async () => { await loadFloorPlan({ slug: 'ev2' }); });

  it('resume el aforo del club', async () => {
    const res = await api().get(url('/tables/stats')).set(auth(manager));
    expect(res.status).toBe(200);
    expect(res.body.total).toMatchObject({
      tables: 55, seats: 308, occupied: 0, available: 55, guests: 0,
    });
  });

  it('desglosa por piso y por zona', async () => {
    const res = await api().get(url('/tables/stats')).set(auth(manager));
    const baja = res.body.floors.find((f2) => f2.floor === 'baja');
    expect(baja.tables).toBe(43);
    expect(baja.seats).toBe(230);
    expect(baja.sections.map((s) => s.section)).toEqual(
      ['GENERAL', 'VIP ELEVADO', 'ZONA AZUL', 'ZONA DIAMANTE', 'ZONA ROJA']);
  });

  it('calcula porcentajes de mesas ocupadas y de lugares usados', async () => {
    const vip = await pool.query(
      `SELECT id FROM tables WHERE nightclub_id = $1 AND section = 'VIP ELEVADO' ORDER BY code LIMIT 1`,
      [club.id]);
    await api().post(url(`/tables/${vip.rows[0].id}/seat`)).set(auth(manager)).send({ user_id: guest.id });

    const res = await api().get(url('/tables/stats')).set(auth(manager));
    const zona = res.body.floors.find((f2) => f2.floor === 'baja')
      .sections.find((s) => s.section === 'VIP ELEVADO');

    expect(zona.occupied).toBe(1);
    expect(zona.guests).toBe(1);
    expect(zona.tables_occupied_pct).toBe(33); // 1 de 3 mesas
    expect(zona.seats_used_pct).toBe(4); // 1 de 24 lugares
  });

  it('cuenta aparte las mesas fuera de servicio', async () => {
    await pool.query(
      `UPDATE tables SET status = 'blocked' WHERE nightclub_id = $1 AND code = '39'`, [club.id]);
    const res = await api().get(url('/tables/stats')).set(auth(manager));
    expect(res.body.total.out_of_service).toBe(1);
    expect(res.body.total.available).toBe(54);
  });

  it('ignora las mesas retiradas', async () => {
    await pool.query(`UPDATE tables SET active = false WHERE nightclub_id = $1 AND code = '39'`, [club.id]);
    const res = await api().get(url('/tables/stats')).set(auth(manager));
    expect(res.body.total.tables).toBe(54);
  });

  it('el personal de piso puede consultarlas; un cliente no', async () => {
    expect((await api().get(url('/tables/stats')).set(auth(waiter))).status).toBe(200);
    expect((await api().get(url('/tables/stats')).set(auth(guest))).status).toBe(403);
  });
});

describe('Listado de mesas con el plano real', () => {
  beforeEach(async () => { await loadFloorPlan({ slug: 'ev2' }); });

  it('filtra por piso', async () => {
    const res = await api().get(url('/tables?floor=alta')).set(auth(guest));
    expect(res.body.tables).toHaveLength(12);
  });

  it('devuelve el número de mesa que usa el personal', async () => {
    const res = await api().get(url('/tables?section=ZONA ROJA')).set(auth(guest));
    expect(res.body.tables.map((t) => t.table_number).sort((a, b) => a - b)).toEqual([39, 40, 41]);
  });

  it('ordena por piso, zona y número', async () => {
    const res = await api().get(url('/tables?section=ZONA DIAMANTE')).set(auth(guest));
    const numbers = res.body.tables.map((t) => t.table_number);
    expect(numbers).toEqual([...numbers].sort((a, b) => a - b));
  });
});

describe('Editor del plano, solo administrador', () => {
  let admin; let plan;
  beforeEach(async () => {
    await loadFloorPlan({ slug: 'ev2' });
    admin = await f.createUser(club.id, { role: 'admin' });
    plan = (await api().get(url('/floor-plan')).set(auth(admin))).body;
  });
  const save = (body, by) => api().put(url('/floor-plan/layout')).set(auth(by || admin)).send(body);
  const body = () => ({ revision: plan.revision, tables: [{ id: plan.tables[0].id, x: 120, y: 160 }],
    landmarks: [{ code: plan.landmarks[0].code, x: 30, y: 40 }] });
  it('guarda mesas y áreas de forma atómica sin alterar sus demás datos', async () => {
    const before = plan.tables[0];
    const res = await save(body());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ updated: 2, revision: 1 });
    const after = (await api().get(url('/floor-plan')).set(auth(guest))).body;
    expect(after.tables.find((r) => r.id === before.id)).toMatchObject({ ...before, x: '120.00', y: '160.00' });
    expect(after.revision).toBe(1);
    expect(Number(after.landmarks[0].x)).toBe(30);
    const events = (await pool.query("SELECT audience,payload FROM events WHERE type='floor_plan_updated'")).rows;
    expect(events).toHaveLength(1);
    expect(events[0].payload).toEqual({ revision: 1 });
    expect(events[0].audience.roles).toContain('guest');
  });
  it.each(['guest','manager','waiter'])('rechaza el rol %s', async (role) => {
    const user = { guest, manager, waiter }[role];
    expect((await save(body(), user)).status).toBe(403);
  });
  it('rechaza una revisión vieja sin sobrescribir', async () => {
    expect((await save(body())).status).toBe(200);
    expect((await save({ ...body(), tables: [{ id: plan.tables[0].id, x: 160, y: 200 }] })).status).toBe(409);
    expect(Number((await pool.query('SELECT x FROM tables WHERE id=$1', [plan.tables[0].id])).rows[0].x)).toBe(120);
  });
  it('una llamada concurrente gana y la otra conserva la revisión anterior', async () => {
    const results = await Promise.all([save(body()), save(body())]);
    expect(results.map((r) => r.status).sort()).toEqual([200,409]);
  });
  it('revierte todo si un área sale del plano', async () => {
    expect((await save({ ...body(), landmarks: [{ code: plan.landmarks[0].code, x: 799, y: 579 }] })).status).toBe(422);
    const after = (await api().get(url('/floor-plan')).set(auth(admin))).body;
    expect(after).toEqual(plan);
  });
  it('no permite cambiar capacidad, precios, zona ni estado', async () => {
    for (const field of ['capacity','price','section','status']) {
      const b = body(); b.tables[0][field] = 10;
      expect((await save(b)).status).toBe(400);
    }
  });
  it('rechaza elementos repetidos', async () => {
    const b = body(); b.tables.push(b.tables[0]);
    expect((await save(b)).status).toBe(400);
  });
  it('rechaza una mesa de otro club y revierte el lote', async () => {
    const foreignClub = await f.createNightclub({ slug: 'foreign-plan' });
    const foreign = await f.createTable(foreignClub.id);
    const b = body(); b.tables.push({ id: foreign.id, x: 80, y: 80 });
    expect((await save(b)).status).toBe(404);
    expect((await api().get(url('/floor-plan')).set(auth(admin))).body).toEqual(plan);
  });
  it('editar por la ruta anterior también invalida un borrador viejo', async () => {
    expect((await api().put(url('/tables/layout')).set(auth(admin))
      .send({ tables: [{ id: plan.tables[0].id, x: 120 }] })).status).toBe(200);
    expect((await save(body())).status).toBe(409);
  });
});
