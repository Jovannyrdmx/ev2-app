'use strict';

const { setupSchema, truncateAll, closePool, pool } = require('./helpers/db');
const { api, auth } = require('./helpers/api');
const f = require('./helpers/factories');

let club; let guest; let other; let waiter; let manager; let small; let vip;

beforeAll(setupSchema);
afterAll(closePool);
beforeEach(async () => {
  await truncateAll();
  club = await f.createNightclub({ slug: 'ev2-tables' });
  guest = await f.createUser(club.id, { role: 'guest' });
  other = await f.createUser(club.id, { role: 'guest' });
  waiter = await f.createUser(club.id, { role: 'waiter' });
  manager = await f.createUser(club.id, { role: 'manager' });
  small = await f.createTable(club.id, { code: 'T-1', capacity: 2, section: 'main' });
  vip = await f.createTable(club.id, { code: 'VIP-1', capacity: 6, section: 'vip', type: 'vip' });
});

const url = (p) => `/api/nightclubs/${club.id}${p}`;
// Sentar y levantar es cosa del personal desde que se entra por la puerta: el cliente
// ya no se sienta solo tocando el mapa. `by` es quien lo hace; `user` es quien se sienta.
const seat = (tableId, user, by) => api().post(url(`/tables/${tableId}/seat`))
  .set(auth(by || waiter)).send({ user_id: user.id });
const release = (tableId, user, by) => api().post(url(`/tables/${tableId}/release`))
  .set(auth(by || waiter)).send({ user_id: user.id });

describe('GET /tables', () => {
  it('lista las mesas con su plano y sin ocupantes', async () => {
    const res = await api().get(url('/tables')).set(auth(guest));
    expect(res.status).toBe(200);
    expect(res.body.tables).toHaveLength(2);
    expect(res.body.tables[0]).toHaveProperty('x');
    expect(res.body.tables[0].occupants).toEqual([]);
  });

  it('filtra por sección', async () => {
    const res = await api().get(url('/tables?section=vip')).set(auth(guest));
    expect(res.body.tables).toHaveLength(1);
    expect(res.body.tables[0].code).toBe('VIP-1');
  });

  it('filtra por estado', async () => {
    await seat(small.id, guest);
    const res = await api().get(url('/tables?status=occupied')).set(auth(guest));
    expect(res.body.tables).toHaveLength(1);
  });

  it('no muestra mesas de otro club', async () => {
    const otherClub = await f.createNightclub({ slug: 'otro' });
    await f.createTable(otherClub.id, { code: 'AJENA' });
    const res = await api().get(url('/tables')).set(auth(guest));
    expect(res.body.tables.map((t) => t.code)).not.toContain('AJENA');
  });

  it('rechaza consultar otro club con un token propio', async () => {
    const otherClub = await f.createNightclub({ slug: 'otro2' });
    const res = await api().get(`/api/nightclubs/${otherClub.id}/tables`).set(auth(guest));
    expect(res.status).toBe(403);
  });
});

describe('Ocupación', () => {
  it('sienta a una persona y marca la mesa ocupada', async () => {
    const res = await seat(small.id, guest);
    expect(res.status).toBe(201);

    const list = await api().get(url('/tables?section=main')).set(auth(guest));
    expect(list.body.tables[0].status).toBe('occupied');
    expect(list.body.tables[0].occupants).toHaveLength(1);
    expect(list.body.tables[0].occupants[0].user_id).toBe(guest.id);
  });

  it('mueve automáticamente a quien ya estaba en otra mesa', async () => {
    await seat(small.id, guest);
    await seat(vip.id, guest);

    const { rows } = await pool.query(
      'SELECT table_id, left_at FROM table_occupants WHERE user_id = $1 ORDER BY seated_at', [guest.id]);
    expect(rows).toHaveLength(2);
    expect(rows[0].left_at).toBeInstanceOf(Date); // dejó la primera
    expect(rows[1].left_at).toBeNull();
    expect(rows[1].table_id).toBe(vip.id);
  });

  it('libera la mesa anterior al mudarse', async () => {
    await seat(small.id, guest);
    await seat(vip.id, guest);
    const list = await api().get(url('/tables')).set(auth(guest));
    const byCode = Object.fromEntries(list.body.tables.map((t) => [t.code, t]));
    expect(byCode['T-1'].status).toBe('available');
    expect(byCode['VIP-1'].status).toBe('occupied');
  });

  it('rechaza sentarse en una mesa llena', async () => {
    await seat(small.id, guest);
    await seat(small.id, other);
    const third = await f.createUser(club.id);
    const res = await seat(small.id, third);
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/full/i);
  });

  it('rechaza mesas bloqueadas o en limpieza', async () => {
    for (const status of ['blocked', 'cleaning']) {
      await pool.query('UPDATE tables SET status = $2 WHERE id = $1', [vip.id, status]);
      const res = await seat(vip.id, guest);
      expect(res.status).toBe(409);
    }
  });

  it('devuelve 404 para una mesa inexistente', async () => {
    const res = await seat({ id: '00000000-0000-4000-8000-000000000999' }.id, guest);
    expect(res.status).toBe(404);
  });

  it('levantar al último libera la mesa', async () => {
    await seat(small.id, guest);
    const res = await release(small.id, guest);
    expect(res.status).toBe(200);
    expect(res.body.remaining).toBe(0);

    const list = await api().get(url('/tables?section=main')).set(auth(guest));
    expect(list.body.tables[0].status).toBe('available');
  });

  it('mantiene la mesa ocupada si queda alguien', async () => {
    await seat(small.id, guest);
    await seat(small.id, other);
    const res = await release(small.id, guest);
    expect(res.body.remaining).toBe(1);

    const list = await api().get(url('/tables?section=main')).set(auth(guest));
    expect(list.body.tables[0].status).toBe('occupied');
  });

  it('un cliente no puede sentar ni levantar a nadie, ni a sí mismo', async () => {
    expect((await seat(small.id, guest, guest)).status).toBe(403);
    await seat(small.id, other);
    expect((await release(small.id, other, guest)).status).toBe(403);
  });

  it('el mesero sí puede levantar a un cliente', async () => {
    await seat(small.id, other);
    const res = await release(small.id, other);
    expect(res.status).toBe(200);
  });

  it('devuelve 404 al liberar a quien no está sentado', async () => {
    const res = await release(small.id, guest);
    expect(res.status).toBe(404);
  });

  it('publica eventos de mesa', async () => {
    await seat(small.id, guest);
    await release(small.id, guest);
    const { rows } = await pool.query(`SELECT payload->>'action' AS action FROM events ORDER BY id`);
    expect(rows.map((r) => r.action)).toEqual(['seated', 'released']);
  });
});

describe('PUT /tables/layout', () => {
  it('el gerente guarda coordenadas y capacidad', async () => {
    const res = await api().put(url('/tables/layout')).set(auth(manager)).send({
      tables: [
        { id: small.id, x: 120.5, y: 80, radius: 30, capacity: 6 },
        { id: vip.id, section: 'terraza' },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(2);

    const { rows } = await pool.query('SELECT x, y, radius, capacity FROM tables WHERE id = $1', [small.id]);
    expect(Number(rows[0].x)).toBe(120.5);
    expect(rows[0].capacity).toBe(6);
  });

  it('un cliente no puede editar el plano', async () => {
    const res = await api().put(url('/tables/layout')).set(auth(guest))
      .send({ tables: [{ id: small.id, x: 1 }] });
    expect(res.status).toBe(403);
  });

  it('no toca mesas de otro club aunque se manden sus ids', async () => {
    const otherClub = await f.createNightclub({ slug: 'otro3' });
    const foreign = await f.createTable(otherClub.id, { code: 'X', x: 0 });
    const res = await api().put(url('/tables/layout')).set(auth(manager))
      .send({ tables: [{ id: foreign.id, x: 999 }] });

    expect(res.body.updated).toBe(0);
    const { rows } = await pool.query('SELECT x FROM tables WHERE id = $1', [foreign.id]);
    expect(Number(rows[0].x)).toBe(0);
  });

  it('valida el cuerpo', async () => {
    const res = await api().put(url('/tables/layout')).set(auth(manager)).send({ tables: [] });
    expect(res.status).toBe(400);
  });
});
