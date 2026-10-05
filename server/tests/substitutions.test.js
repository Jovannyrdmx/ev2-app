/**
 * Sustituir un insumo que se acabó (D84).
 *
 * Lo que se prueba es lo que hace que la sustitución sea verdad y no solo un aviso:
 * que el trago se pueda seguir vendiendo, que salga del inventario el sustituto y no
 * el original, que la comanda lo diga, que termine sola, y que no se pueda inventar
 * un sustituto que no corresponde.
 */
'use strict';

const { randomUUID } = require('crypto');
const { setupSchema, truncateAll, closePool, pool } = require('./helpers/db');
const { api, auth } = require('./helpers/api');
const f = require('./helpers/factories');

let club; let manager; let bartender; let waiter; let guest; let table;
let buchanans; let blackLabel; let refresco; let cuba;

beforeAll(setupSchema);
afterAll(closePool);

beforeEach(async () => {
  await truncateAll();
  club = await f.createNightclub({ slug: 'ev2-sustituir' });
  manager = await f.createUser(club.id, { role: 'manager', display_name: 'Gerente' });
  bartender = await f.createUser(club.id, { role: 'bartender', display_name: 'Beto' });
  waiter = await f.createUser(club.id, { role: 'waiter', display_name: 'Luis' });
  guest = await f.createUser(club.id, { role: 'guest' });
  table = await f.createTable(club.id, { code: 'T-1', section: 'ZONA ROJA', capacity: 4 });
  // Buchanan's agotado en la barra; Black Label sí hay. Misma unidad (ml).
  buchanans = await f.createSupply(club.id, { name: "Buchanan's 12", unit: 'ml', location_id: club.bar_id });
  blackLabel = await f.createSupply(club.id, { name: 'Black Label', unit: 'ml', stock: 750, location_id: club.bar_id });
  refresco = await f.createSupply(club.id, { name: 'Refresco', unit: 'ml', stock: 5000, location_id: club.bar_id });
  cuba = await f.createDrink(club.id, { name: "Buchanan's preparado", price: 150, stock: null });
  await f.setRecipe(cuba.id, [[buchanans, 60], [refresco, 200]]);
});

const url = (p) => `/api/nightclubs/${club.id}${p}`;

const sustituir = (body = {}, who = bartender) => api().post(url('/supply-substitutions')).set(auth(who))
  .send({ location_id: club.bar_id, supply_id: buchanans.id, substitute_id: blackLabel.id, ...body });

const pedir = (quantity = 1) => api().post(url('/orders')).set(auth(waiter)).send({
  client_request_id: randomUUID(), table_id: table.id, items: [{ drink_id: cuba.id, quantity }],
});

describe('Sin sustituto, el trago no se vende', () => {
  it('pedirlo choca con "no alcanza" y la carta lo marca agotado', async () => {
    const res = await pedir();
    expect(res.status).toBe(409);
    const carta = await api().get(url(`/drinks?bar_id=${club.bar_id}`)).set(auth(waiter));
    expect(carta.body.drinks.find((d) => d.id === cuba.id).stock).toBe(0);
  });
});

describe('Activar la sustitución', () => {
  it('el bartender la activa y queda escrito quién y hasta cuándo', async () => {
    const res = await sustituir();
    expect(res.status).toBe(201);
    expect(res.body.substitution).toMatchObject({
      supply_name: "Buchanan's 12", substitute_name: 'Black Label', created_by_name: 'Beto',
      ended_at: null,
    });
    expect(new Date(res.body.substitution.expires_at) > new Date()).toBe(true);
  });

  it('el gerente también; un mesero no', async () => {
    expect((await sustituir({}, manager)).status).toBe(201);
    await pool.query("UPDATE supply_substitutions SET ended_at = now(), ended_reason = 'manual'");
    expect((await sustituir({}, waiter)).status).toBe(403);
  });

  it('no se mezclan unidades: ml no se sustituye con piezas', async () => {
    const pieza = await f.createSupply(club.id, { name: 'Lata', unit: 'pza', stock: 10, location_id: club.bar_id });
    const res = await sustituir({ substitute_id: pieza.id });
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/se mide en ml/);
  });

  it('no se sustituye con algo que tampoco hay', async () => {
    const vacio = await f.createSupply(club.id, { name: 'Chivas', unit: 'ml', location_id: club.bar_id });
    const res = await sustituir({ substitute_id: vacio.id });
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/Tampoco hay Chivas/);
  });

  it('una sola viva por insumo y barra', async () => {
    expect((await sustituir()).status).toBe(201);
    const otra = await sustituir();
    expect(otra.status).toBe(409);
  });

  it('no se edita ni se borra: solo se termina', async () => {
    const { body } = await sustituir();
    await expect(pool.query('DELETE FROM supply_substitutions WHERE id = $1', [body.substitution.id]))
      .rejects.toThrow(/no se borra/);
    await expect(pool.query('UPDATE supply_substitutions SET substitute_id = $2 WHERE id = $1',
      [body.substitution.id, refresco.id])).rejects.toThrow(/no se edita/);
  });
});

describe('Con la sustitución, se sigue vendiendo', () => {
  beforeEach(async () => { expect((await sustituir()).status).toBe(201); });

  it('la carta vuelve a ofrecerlo, con lo que alcanza el sustituto', async () => {
    const carta = await api().get(url(`/drinks?bar_id=${club.bar_id}`)).set(auth(waiter));
    expect(carta.body.drinks.find((d) => d.id === cuba.id).stock).toBe(12); // 750 / 60
  });

  it('el pedido pasa, sale Black Label del inventario y no Buchanan\'s, mismo precio', async () => {
    const res = await pedir(2);
    expect(res.status).toBe(201);
    expect(res.body.order.subtotal).toBe('300.00');
    expect(await f.supplyStock(blackLabel.id, club.bar_id)).toBe(630);
    expect(await f.supplyStock(buchanans.id, club.bar_id)).toBe(0);
    const { rows } = await pool.query('SELECT substitutions FROM drink_orders WHERE id = $1', [res.body.order.id]);
    expect(rows[0].substitutions).toEqual([
      expect.objectContaining({ from: "Buchanan's 12", to: 'Black Label' }),
    ]);
  });

  it('la barra ve el cambio; el cliente no', async () => {
    const pedido = (await pedir()).body.order;
    const barra = await api().get(url(`/orders?active=true&bar_id=${club.bar_id}`)).set(auth(bartender));
    expect(barra.body.orders.find((o) => o.id === pedido.id).substitutions).toHaveLength(1);
    const delMesero = await api().get(url(`/orders/${pedido.id}`)).set(auth(waiter));
    expect(delMesero.body.order || delMesero.body).not.toHaveProperty('substitutions');
  });

  it('la comanda dice con qué se sirve', async () => {
    const pedido = (await pedir()).body.order;
    const tickets = require('../src/services/tickets');
    const data = await tickets.orderData(pool, { nightclubId: club.id, orderId: pedido.id });
    const t = require('../src/services/escpos').ticket({ columns: 48, codepage: 'CP850', hasCutter: true });
    tickets.renderOrder(t, data, { club: { name: 'EV2', timezone: 'America/Hermosillo' }, settings: {} });
    expect(t.build().text).toMatch(/SUSTITUCION[\s\S]*Buchanan's 12 -> Black Label/);
  });

  it('cancelar el pedido devuelve el sustituto, no el original', async () => {
    const pedido = (await pedir()).body.order;
    const inventory = require('../src/services/inventory');
    const client = await pool.connect();
    try {
      await inventory.restore(client, { nightclubId: club.id, orderId: pedido.id, userId: manager.id });
    } finally { client.release(); }
    expect(await f.supplyStock(blackLabel.id, club.bar_id)).toBe(750);
    expect(await f.supplyStock(buchanans.id, club.bar_id)).toBe(0);
  });
});

describe('Termina sola o a mano', () => {
  it('cuando vuelve a haber del original, la siguiente venta usa el original y la cierra', async () => {
    const { body } = await sustituir();
    await f.stockUp(club.id, buchanans.id, club.bar_id, 750);
    expect((await pedir()).status).toBe(201);
    expect(await f.supplyStock(buchanans.id, club.bar_id)).toBe(690);
    expect(await f.supplyStock(blackLabel.id, club.bar_id)).toBe(750);
    const { rows } = await pool.query('SELECT ended_reason FROM supply_substitutions WHERE id = $1',
      [body.substitution.id]);
    expect(rows[0].ended_reason).toBe('restocked');
  });

  it('al terminar la noche ya no aplica', async () => {
    const { body } = await sustituir();
    await pool.query("ALTER TABLE supply_substitutions DISABLE TRIGGER supply_substitutions_guard");
    await pool.query("UPDATE supply_substitutions SET created_at = now() - interval '2 hours', expires_at = now() - interval '1 minute' WHERE id = $1",
      [body.substitution.id]);
    await pool.query("ALTER TABLE supply_substitutions ENABLE TRIGGER supply_substitutions_guard");
    expect((await pedir()).status).toBe(409);
    const lista = await api().get(url(`/supply-substitutions?location_id=${club.bar_id}`)).set(auth(manager));
    expect(lista.body.substitutions).toHaveLength(0);
  });

  it('a mano: el bartender la termina y el trago vuelve a estar agotado', async () => {
    const { body } = await sustituir();
    const fin = await api().post(url(`/supply-substitutions/${body.substitution.id}/end`)).set(auth(bartender));
    expect(fin.status).toBe(200);
    expect(fin.body.substitution.ended_reason).toBe('manual');
    expect((await pedir()).status).toBe(409);
    const otra = await api().post(url(`/supply-substitutions/${body.substitution.id}/end`)).set(auth(bartender));
    expect(otra.status).toBe(409);
  });
});

describe('Las opciones para escoger', () => {
  it('lo que llevan las recetas, y los sustitutos con existencia', async () => {
    const res = await api().get(url(`/supply-substitutions/options?location_id=${club.bar_id}`)).set(auth(bartender));
    expect(res.status).toBe(200);
    expect(res.body.supplies.map((s) => s.name)).toEqual(expect.arrayContaining(["Buchanan's 12", 'Refresco']));
    expect(res.body.substitutes.map((s) => s.name)).toEqual(expect.arrayContaining(['Black Label']));
    expect(res.body.substitutes.map((s) => s.name)).not.toContain("Buchanan's 12");
  });
});
