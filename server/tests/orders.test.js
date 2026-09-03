'use strict';

const { randomUUID } = require('crypto');
const { setupSchema, truncateAll, closePool, pool } = require('./helpers/db');
const { api, auth } = require('./helpers/api');
const f = require('./helpers/factories');

let club; let guest; let other; let bartender; let manager; let table; let beer; let shot;

beforeAll(setupSchema);
afterAll(closePool);
beforeEach(async () => {
  await truncateAll();
  club = await f.createNightclub({ slug: 'ev2-orders' });
  guest = await f.createUser(club.id, { role: 'guest' });
  other = await f.createUser(club.id, { role: 'guest' });
  bartender = await f.createUser(club.id, { role: 'bartender' });
  manager = await f.createUser(club.id, { role: 'manager' });
  table = await f.createTable(club.id, { code: 'T-1', capacity: 4 });
  beer = await f.createDrink(club.id, { name: 'Cerveza', price: 60, stock: 10 });
  shot = await f.createDrink(club.id, { name: 'Tequila', price: 80, stock: 3 });
});

const url = (p) => `/api/nightclubs/${club.id}${p}`;
const newOrder = (over = {}) => ({
  client_request_id: randomUUID(),
  items: [{ drink_id: beer.id, quantity: 2 }],
  ...over,
});

async function stockOf(drinkId) {
  const { rows } = await pool.query('SELECT quantity FROM inventory WHERE drink_id = $1', [drinkId]);
  return Number(rows[0].quantity);
}

describe('POST /orders', () => {
  it('crea el pedido, congela precios y descuenta existencias', async () => {
    const res = await api().post(url('/orders')).set(auth(guest))
      .send(newOrder({ table_id: table.id, items: [{ drink_id: beer.id, quantity: 2 }] }));

    expect(res.status).toBe(201);
    expect(res.body.order.status).toBe('pending');
    expect(res.body.order.subtotal).toBe('120.00');
    expect(res.body.order.items[0]).toMatchObject({ name: 'Cerveza', quantity: 2, unit_price: '60.00' });
    expect(await stockOf(beer.id)).toBe(8);
  });

  it('conserva el precio pagado aunque la bebida suba de precio después', async () => {
    const res = await api().post(url('/orders')).set(auth(guest)).send(newOrder());
    await pool.query('UPDATE drinks SET price = 999 WHERE id = $1', [beer.id]);

    const after = await api().get(url(`/orders/${res.body.order.id}`)).set(auth(guest));
    expect(after.body.order.items[0].unit_price).toBe('60.00');
    expect(after.body.order.subtotal).toBe('120.00');
  });

  it('suma varias bebidas en un mismo pedido', async () => {
    const res = await api().post(url('/orders')).set(auth(guest)).send(newOrder({
      items: [{ drink_id: beer.id, quantity: 1 }, { drink_id: shot.id, quantity: 2 }],
    }));
    expect(res.status).toBe(201);
    expect(res.body.order.subtotal).toBe('220.00'); // 60 + 160
  });

  it('es idempotente: reenviar no duplica ni descuenta dos veces', async () => {
    const body = newOrder();
    const first = await api().post(url('/orders')).set(auth(guest)).send(body);
    const second = await api().post(url('/orders')).set(auth(guest)).send(body);

    expect(second.status).toBe(200);
    expect(second.headers['idempotent-replay']).toBe('true');
    expect(second.body.order.id).toBe(first.body.order.id);
    expect(await stockOf(beer.id)).toBe(8);

    const { rows } = await pool.query('SELECT count(*)::int AS n FROM drink_orders');
    expect(rows[0].n).toBe(1);
  });

  it('rechaza si no hay existencias suficientes y no toca el inventario', async () => {
    const res = await api().post(url('/orders')).set(auth(guest))
      .send(newOrder({ items: [{ drink_id: shot.id, quantity: 5 }] }));

    expect(res.status).toBe(409);
    expect(res.body.error.details[0]).toMatchObject({ reason: 'out_of_stock', stock: 3 });
    expect(await stockOf(shot.id)).toBe(3);
  });

  it('rechaza una bebida marcada como no disponible', async () => {
    await pool.query('UPDATE drinks SET available = false WHERE id = $1', [beer.id]);
    const res = await api().post(url('/orders')).set(auth(guest)).send(newOrder());
    expect(res.status).toBe(409);
    expect(res.body.error.details[0].reason).toBe('unavailable');
  });

  it('no permite pedir bebidas de otro club', async () => {
    const otherClub = await f.createNightclub({ slug: 'otro-club' });
    const foreign = await f.createDrink(otherClub.id);
    const res = await api().post(url('/orders')).set(auth(guest))
      .send(newOrder({ items: [{ drink_id: foreign.id, quantity: 1 }] }));
    expect(res.status).toBe(404);
  });

  it('permite invitar una bebida a otra persona', async () => {
    const res = await api().post(url('/orders')).set(auth(guest))
      .send(newOrder({ recipient_id: other.id, message: 'Salud' }));
    expect(res.status).toBe(201);
    expect(res.body.order.recipient_id).toBe(other.id);
  });

  it('impide invitar a alguien que te bloqueó', async () => {
    await pool.query('INSERT INTO user_blocks (blocker_id, blocked_id) VALUES ($1,$2)',
      [other.id, guest.id]);
    const res = await api().post(url('/orders')).set(auth(guest))
      .send(newOrder({ recipient_id: other.id }));
    expect(res.status).toBe(403);
  });

  it('valida el cuerpo de la petición', async () => {
    const res = await api().post(url('/orders')).set(auth(guest))
      .send({ client_request_id: 'no-es-uuid', items: [] });
    expect(res.status).toBe(400);
  });

  it('no deja que dos pedidos simultáneos agoten el mismo producto', async () => {
    // Solo quedan 3 tequilas: dos pedidos de 2 no pueden pasar ambos.
    const [a, b] = await Promise.all([
      api().post(url('/orders')).set(auth(guest))
        .send(newOrder({ items: [{ drink_id: shot.id, quantity: 2 }] })),
      api().post(url('/orders')).set(auth(other))
        .send(newOrder({ items: [{ drink_id: shot.id, quantity: 2 }] })),
    ]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([201, 409]);
    expect(await stockOf(shot.id)).toBe(1);
  });
});

describe('Flujo de estados', () => {
  async function makeOrder() {
    const res = await api().post(url('/orders')).set(auth(guest)).send(newOrder());
    return res.body.order.id;
  }
  const setStatus = (id, status, user) => api().post(url(`/orders/${id}/status`))
    .set(auth(user)).send({ status });

  it('recorre confirmado → preparando → listo → entregado', async () => {
    const id = await makeOrder();
    for (const status of ['confirmed', 'preparing', 'ready', 'delivered']) {
      const res = await setStatus(id, status, bartender);
      expect(res.status).toBe(200);
      expect(res.body.order.status).toBe(status);
    }
  });

  it('registra las marcas de tiempo de cada etapa', async () => {
    const id = await makeOrder();
    await setStatus(id, 'confirmed', bartender);
    await setStatus(id, 'preparing', bartender);
    await setStatus(id, 'ready', bartender);
    await setStatus(id, 'delivered', bartender);

    const { rows } = await pool.query(
      'SELECT confirmed_at, ready_at, delivered_at, bartender_id FROM drink_orders WHERE id = $1', [id]);
    expect(rows[0].confirmed_at).toBeInstanceOf(Date);
    expect(rows[0].ready_at).toBeInstanceOf(Date);
    expect(rows[0].delivered_at).toBeInstanceOf(Date);
    expect(rows[0].bartender_id).toBe(bartender.id);
  });

  it('rechaza saltarse etapas', async () => {
    const id = await makeOrder();
    const res = await setStatus(id, 'delivered', bartender);
    expect(res.status).toBe(409);
    expect(res.body.error.details.allowed).toContain('confirmed');
  });

  it('rechaza cambios sobre un pedido ya entregado', async () => {
    const id = await makeOrder();
    for (const s of ['confirmed', 'preparing', 'ready', 'delivered']) await setStatus(id, s, bartender);
    const res = await setStatus(id, 'preparing', bartender);
    expect(res.status).toBe(409);
  });

  it('el cliente no puede mover pedidos', async () => {
    const id = await makeOrder();
    const res = await setStatus(id, 'ready', guest);
    expect(res.status).toBe(403);
  });

  it('el cliente sí puede cancelar el suyo mientras está pendiente, y recupera existencias', async () => {
    const id = await makeOrder();
    const res = await setStatus(id, 'cancelled', guest);
    expect(res.status).toBe(200);
    expect(await stockOf(beer.id)).toBe(10);
  });

  it('el cliente no puede cancelar el pedido de otra persona', async () => {
    const id = await makeOrder();
    const res = await setStatus(id, 'cancelled', other);
    expect(res.status).toBe(403);
  });

  it('el cliente no puede cancelar una vez confirmado', async () => {
    const id = await makeOrder();
    await setStatus(id, 'confirmed', bartender);
    const res = await setStatus(id, 'cancelled', guest);
    expect(res.status).toBe(403);
  });

  it('cancelar desde la barra también devuelve las existencias', async () => {
    const id = await makeOrder();
    await setStatus(id, 'confirmed', bartender);
    await setStatus(id, 'cancelled', bartender);
    expect(await stockOf(beer.id)).toBe(10);
  });

  it('publica un evento por cada cambio de estado', async () => {
    const id = await makeOrder();
    await setStatus(id, 'confirmed', bartender);
    const { rows } = await pool.query('SELECT type FROM events ORDER BY id');
    expect(rows.map((r) => r.type)).toEqual(['order_created', 'order_confirmed']);
  });
});

describe('Consultas de pedidos', () => {
  it('la barra ve la cola activa', async () => {
    await api().post(url('/orders')).set(auth(guest)).send(newOrder());
    const res = await api().get(url('/orders?active=true')).set(auth(bartender));
    expect(res.status).toBe(200);
    expect(res.body.orders).toHaveLength(1);
  });

  it('un cliente no puede ver la cola', async () => {
    const res = await api().get(url('/orders')).set(auth(guest));
    expect(res.status).toBe(403);
  });

  it('cada quien ve sus pedidos enviados y recibidos', async () => {
    await api().post(url('/orders')).set(auth(guest)).send(newOrder({ recipient_id: other.id }));
    const mine = await api().get(url('/orders/mine')).set(auth(guest));
    const theirs = await api().get(url('/orders/mine')).set(auth(other));
    expect(mine.body.orders).toHaveLength(1);
    expect(theirs.body.orders).toHaveLength(1);
  });

  it('un tercero no puede leer un pedido ajeno', async () => {
    const res = await api().post(url('/orders')).set(auth(guest)).send(newOrder());
    const third = await f.createUser(club.id, { role: 'guest' });
    const read = await api().get(url(`/orders/${res.body.order.id}`)).set(auth(third));
    expect(read.status).toBe(403);
  });

  it('el gerente sí puede leer cualquiera', async () => {
    const res = await api().post(url('/orders')).set(auth(guest)).send(newOrder());
    const read = await api().get(url(`/orders/${res.body.order.id}`)).set(auth(manager));
    expect(read.status).toBe(200);
  });
});
