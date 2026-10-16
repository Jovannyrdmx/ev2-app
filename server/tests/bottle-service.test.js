/**
 * Servicio de botella (D117): los mezcladores se eligen al pedir la botella, la botella
 * incluye hasta su tope, lo demás se cobra, y todo baja de la barra que la sirve.
 */
'use strict';

const { randomUUID } = require('crypto');
const { setupSchema, truncateAll, closePool, pool } = require('./helpers/db');
const { api, auth } = require('./helpers/api');
const f = require('./helpers/factories');

let club; let manager; let guest; let waiter; let table;
let whisky; let sprite; let agua; let botella; let trago;
let mxSprite; let mxAgua;

beforeAll(setupSchema);
afterAll(closePool);

const url = (p) => `/api/nightclubs/${club.id}${p}`;

beforeEach(async () => {
  await truncateAll();
  club = await f.createNightclub({ slug: 'ev2-botella' });
  manager = await f.createUser(club.id, { role: 'manager' });
  guest = await f.createUser(club.id, { role: 'guest' });
  waiter = await f.createUser(club.id, { role: 'waiter' });
  table = await f.createTable(club.id, { code: 'V-1' });

  whisky = await f.createSupply(club.id, { name: "Buchanan's 12", unit: 'ml', package_size: 750, stock: 1500 });
  sprite = await f.createSupply(club.id, { name: 'Sprite 3 L', unit: 'ml', package_size: 3000, stock: 30000 });
  agua = await f.createSupply(club.id, { name: 'Agua mineral 2 L', unit: 'ml', package_size: 2000, stock: 4000 });
  botella = await f.createDrink(club.id, { name: 'BUCHANANS 12', category: 'Botellas', price: 2650, stock: null });
  trago = await f.createDrink(club.id, { name: 'BUCHANANS 12 - SPRITE', category: 'Drinks', price: 150, stock: null });
  await f.setRecipe(botella.id, [[whisky, 750]]);

  const a = await api().post(url('/bottle-mixers')).set(auth(manager))
    .send({ supply_id: sprite.id, name: 'Sprite 3 L', portion: 3000, extra_price: 120 });
  const b = await api().post(url('/bottle-mixers')).set(auth(manager))
    .send({ supply_id: agua.id, name: 'Agua mineral 2 L', portion: 2000, extra_price: 80 });
  expect(a.status).toBe(201);
  expect(b.status).toBe(201);
  mxSprite = a.body.mixer; mxAgua = b.body.mixer;
  const tope = await api().put(url(`/drinks/${botella.id}/included-mixers`)).set(auth(manager))
    .send({ included_mixers: 2 });
  expect(tope.status).toBe(200);
});

const pedir = (items, who = guest) => api().post(url('/orders')).set(auth(who)).send({
  client_request_id: randomUUID(), table_id: table.id, items,
});

describe('el catálogo del gerente', () => {
  it('solo el gerente da de alta mezcladores y pone el tope', async () => {
    const r = await api().post(url('/bottle-mixers')).set(auth(waiter))
      .send({ supply_id: whisky.id, name: 'x', portion: 1, extra_price: 1 });
    expect(r.status).toBe(403);
    const t = await api().put(url(`/drinks/${botella.id}/included-mixers`)).set(auth(waiter))
      .send({ included_mixers: 9 });
    expect(t.status).toBe(403);
  });

  it('el mesero y el cliente ven solo los activos; la carta trae el tope', async () => {
    await api().patch(url(`/bottle-mixers/${mxAgua.id}`)).set(auth(manager)).send({ active: false });
    const lista = await api().get(url('/bottle-mixers')).set(auth(guest));
    expect(lista.body.mixers.map((m) => m.name)).toEqual(['Sprite 3 L']);
    const carta = await api().get(url('/drinks')).set(auth(guest));
    expect(carta.body.drinks.find((d) => d.id === botella.id).included_mixers).toBe(2);
    expect(carta.body.drinks.find((d) => d.id === trago.id).included_mixers).toBeNull();
  });

  it('el mismo insumo no se da de alta dos veces', async () => {
    const r = await api().post(url('/bottle-mixers')).set(auth(manager))
      .send({ supply_id: sprite.id, name: 'Otra', portion: 1, extra_price: 0 });
    expect(r.status).toBe(409);
  });
});

describe('pedir la botella con su servicio', () => {
  it('dentro del tope no cuesta nada y baja de la barra', async () => {
    const res = await pedir([{ drink_id: botella.id, quantity: 1,
      mixers: [{ mixer_id: mxSprite.id, quantity: 1 }, { mixer_id: mxAgua.id, quantity: 1 }] }]);
    expect(res.status).toBe(201);
    expect(Number(res.body.order.subtotal)).toBe(2650);
    expect(await f.supplyStock(sprite.id)).toBe(30000 - 3000);
    expect(await f.supplyStock(agua.id)).toBe(4000 - 2000);
    expect(await f.supplyStock(whisky.id)).toBe(1500 - 750);
    const linea = res.body.order.items[0];
    expect(linea.mixers).toHaveLength(2);
    expect(linea.mixers.every((m) => m.charged === 0)).toBe(true);
  });

  it('lo que pasa del tope se cobra, y se cobran los más baratos', async () => {
    // Tope 2: incluye las 2 Sprite ($120) y cobra el agua ($80).
    const res = await pedir([{ drink_id: botella.id, quantity: 1,
      mixers: [{ mixer_id: mxAgua.id, quantity: 1 }, { mixer_id: mxSprite.id, quantity: 2 }] }]);
    expect(res.status).toBe(201);
    expect(Number(res.body.order.subtotal)).toBe(2650 + 80);
    const tx = await pool.query(`SELECT amount::float8 AS amount FROM transactions WHERE reference_id = $1`,
      [res.body.order.id]);
    expect(tx.rows[0].amount).toBe(2730);
    const aguaLinea = res.body.order.items[0].mixers.find((m) => m.name === 'Agua mineral 2 L');
    expect(aguaLinea).toMatchObject({ quantity: 1, included: 0, charged: 1, line_total: '80.00' });
  });

  it('dos botellas incluyen el doble', async () => {
    const res = await pedir([{ drink_id: botella.id, quantity: 2,
      mixers: [{ mixer_id: mxSprite.id, quantity: 4 }] }]);
    expect(res.status).toBe(201);
    expect(Number(res.body.order.subtotal)).toBe(5300);
  });

  it('el precio no lo manda el teléfono', async () => {
    const res = await pedir([{ drink_id: botella.id, quantity: 1,
      mixers: [{ mixer_id: mxSprite.id, quantity: 3, unit_price: 0, included: 3 }] }]);
    expect(res.status).toBe(201);
    expect(Number(res.body.order.subtotal)).toBe(2650 + 120);
  });

  it('un trago que no es botella de servicio no acepta mezcladores', async () => {
    const res = await pedir([{ drink_id: trago.id, quantity: 1,
      mixers: [{ mixer_id: mxSprite.id, quantity: 1 }] }]);
    expect(res.status).toBe(422);
  });

  it('si no alcanza el mezclador en la barra, no se vende y lo dice', async () => {
    const res = await pedir([{ drink_id: botella.id, quantity: 1,
      mixers: [{ mixer_id: mxAgua.id, quantity: 3 }] }]);
    expect(res.status).toBe(409);
    expect(JSON.stringify(res.body)).toMatch(/Agua mineral 2 L/);
    expect(await f.supplyStock(whisky.id)).toBe(1500);
  });

  it('el mesero también lo pide por la mesa', async () => {
    await pool.query('INSERT INTO staff_shifts (nightclub_id, user_id) VALUES ($1,$2)', [club.id, waiter.id]);
    const res = await pedir([{ drink_id: botella.id, quantity: 1,
      mixers: [{ mixer_id: mxSprite.id, quantity: 2 }] }], waiter);
    expect(res.status).toBe(201);
    expect(await f.supplyStock(sprite.id)).toBe(30000 - 6000);
  });

  it('al cancelar, los mezcladores regresan a la barra', async () => {
    const res = await pedir([{ drink_id: botella.id, quantity: 1,
      mixers: [{ mixer_id: mxSprite.id, quantity: 2 }] }]);
    await api().post(url(`/orders/${res.body.order.id}/status`)).set(auth(manager))
      .send({ status: 'cancelled', reason: 'prueba' });
    expect(await f.supplyStock(sprite.id)).toBe(30000);
    expect(await f.supplyStock(whisky.id)).toBe(1500);
  });
});

describe('la barra y la cuenta', () => {
  it('la cuenta de la mesa trae el extra como su propio renglón', async () => {
    await pedir([{ drink_id: botella.id, quantity: 1,
      mixers: [{ mixer_id: mxSprite.id, quantity: 2 }, { mixer_id: mxAgua.id, quantity: 1 }] }]);
    const tickets = require('../src/services/tickets');
    const bill = await tickets.billData(pool, { nightclubId: club.id, tableId: table.id });
    expect(bill.total).toBe('2730.00');
    expect(bill.lines.map((l) => l.name)).toContain('Extra Agua mineral 2 L');
  });

  it('la comanda enseña los mezcladores bajo la botella', async () => {
    const res = await pedir([{ drink_id: botella.id, quantity: 1,
      mixers: [{ mixer_id: mxSprite.id, quantity: 2 }] }]);
    const tickets = require('../src/services/tickets');
    const data = await tickets.orderData(pool, { nightclubId: club.id, orderId: res.body.order.id });
    const printer = { columns: 48, codepage: 'cp850', has_cutter: true };
    const { preview } = tickets.build(printer, (t) => tickets.renderOrder(t, data, {
      club: { name: 'EV2', timezone: 'America/Hermosillo' }, settings: {} }));
    expect(preview).toMatch(/\+ 2 Sprite 3 L/);
  });
});
