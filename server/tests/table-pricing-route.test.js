'use strict';

// PUT /tables/vip-pricing (D103): el gerente cambia precio y personas de varias mesas VIP
// a la vez, sin tocar el plano; todo o nada, con rastro en la auditoría.

const { setupSchema, truncateAll, closePool, pool } = require('./helpers/db');
const { api, auth } = require('./helpers/api');
const f = require('./helpers/factories');
const { randomUUID } = require('crypto');

let club; let other; let manager; let admin; let waiter; let a; let b; let foreign;

beforeAll(setupSchema);
afterAll(closePool);
beforeEach(async () => {
  await truncateAll();
  club = await f.createNightclub({ slug: 'ev2-vp' });
  other = await f.createNightclub({ slug: 'ev2-vp-otro' });
  manager = await f.createUser(club.id, { role: 'manager' });
  admin = await f.createUser(club.id, { role: 'admin' });
  waiter = await f.createUser(club.id, { role: 'waiter' });
  a = await f.createTable(club.id, { code: 'V1', section: 'ZONA AZUL', type: 'vip' });
  b = await f.createTable(club.id, { code: 'V2', section: 'ZONA AZUL', type: 'vip' });
  foreign = await f.createTable(other.id, { code: 'X1', section: 'ZONA AZUL', type: 'vip' });
});

const put = (user, tables) => api().put(`/api/nightclubs/${club.id}/tables/vip-pricing`)
  .set(auth(user)).send({ tables });
const row = async (t) => (await pool.query(
  'SELECT vip_price::text AS p, vip_capacity AS c FROM tables WHERE id = $1', [t.id])).rows[0];

describe('PUT /tables/vip-pricing', () => {
  it('gerente y admin fijan precio y personas; el mesero no', async () => {
    expect((await put(waiter, [{ id: a.id, vip_price: 100, vip_capacity: 4 }])).status).toBe(403);
    const res = await put(manager, [{ id: a.id, vip_price: 5000, vip_capacity: 6 },
      { id: b.id, vip_price: 8000, vip_capacity: 8 }]);
    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(2);
    expect(await row(a)).toEqual({ p: '5000.00', c: 6 });
    expect(await row(b)).toEqual({ p: '8000.00', c: 8 });
    expect((await put(admin, [{ id: a.id, vip_price: null, vip_capacity: null }])).status).toBe(200);
    expect(await row(a)).toEqual({ p: null, c: null });
  });

  it('deja rastro con el valor anterior y no registra lo que no cambió', async () => {
    await put(manager, [{ id: a.id, vip_price: 5000, vip_capacity: 6 }]);
    const igual = await put(manager, [{ id: a.id, vip_price: 5000, vip_capacity: 6 }]);
    expect(igual.body.updated).toBe(0);
    await put(manager, [{ id: a.id, vip_price: 5500, vip_capacity: 6 }]);
    const { rows } = await pool.query(
      `SELECT actor_id, before, after FROM audit_log WHERE action = 'table.vip_pricing' ORDER BY created_at`);
    expect(rows).toHaveLength(2);
    expect(rows[1].actor_id).toBe(manager.id);
    expect(rows[1].before).toMatchObject({ code: 'V1', vip_price: '5000.00', vip_capacity: 6 });
    expect(rows[1].after).toMatchObject({ vip_price: 5500, vip_capacity: 6 });
  });

  it('todo o nada: una mesa ajena o inexistente cancela todos los cambios', async () => {
    const res = await put(manager, [{ id: a.id, vip_price: 1, vip_capacity: 1 },
      { id: foreign.id, vip_price: 1, vip_capacity: 1 }]);
    expect(res.status).toBe(404);
    expect(await row(a)).toEqual({ p: null, c: null });
    expect((await put(manager, [{ id: randomUUID(), vip_price: 1, vip_capacity: 1 }])).status).toBe(404);
  });

  it('valida valores y repetidos', async () => {
    expect((await put(manager, [{ id: a.id, vip_price: -5, vip_capacity: 4 }])).status).toBe(400);
    expect((await put(manager, [{ id: a.id, vip_price: 5, vip_capacity: 0 }])).status).toBe(400);
    expect((await put(manager, [{ id: a.id, vip_price: 5, vip_capacity: 2.5 }])).status).toBe(400);
    expect((await put(manager, [])).status).toBe(400);
    expect((await put(manager, [{ id: a.id, vip_price: 5, vip_capacity: 4 },
      { id: a.id, vip_price: 6, vip_capacity: 4 }])).status).toBe(400);
  });

  it('un precio de 0 se acepta (cortesía)', async () => {
    expect((await put(manager, [{ id: a.id, vip_price: 0, vip_capacity: 4 }])).status).toBe(200);
    expect((await row(a)).p).toBe('0.00');
  });
});
