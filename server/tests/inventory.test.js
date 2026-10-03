/**
 * Inventario real: el insumo, la receta y el kardex.
 *
 * Lo que se prueba aquí es la razón de ser de todo el módulo: que vender un trago
 * baje LA BOTELLA, y no un contador que nadie llena. Mientras eso no fuera cierto,
 * cualquier número de faltante que enseñara el sistema era una invención.
 */
'use strict';

const { randomUUID } = require('crypto');
const { setupSchema, truncateAll, closePool, pool } = require('./helpers/db');
const { api, auth } = require('./helpers/api');
const f = require('./helpers/factories');

let club; let manager; let bartender; let guest; let waiter; let table;

beforeAll(setupSchema);
afterAll(closePool);
beforeEach(async () => {
  await truncateAll();
  club = await f.createNightclub({ slug: 'ev2-inv' });
  manager = await f.createUser(club.id, { role: 'manager' });
  bartender = await f.createUser(club.id, { role: 'bartender' });
  waiter = await f.createUser(club.id, { role: 'waiter' });
  guest = await f.createUser(club.id, { role: 'guest' });
  table = await f.createTable(club.id, { code: 'T-1' });
});

const url = (p) => `/api/nightclubs/${club.id}${p}`;

/** El caso real del club: la misma botella se vende por trago y completa. */
async function barraBuchanans({ ml = 1500 } = {}) {
  const whisky = await f.createSupply(club.id, {
    name: "Buchanan's 12", unit: 'ml', package_size: 750,
    package_label: 'Botella 750 ml', stock: ml, min_stock: 750,
  });
  const refresco = await f.createSupply(club.id, {
    name: 'Sprite', unit: 'ml', package_size: 2000, package_label: 'Botella 2 L', stock: 4000,
  });
  const trago = await f.createDrink(club.id, {
    name: "BUCHANANS 12 - SPRITE", category: 'Drinks', price: 150, stock: null,
  });
  const botella = await f.createDrink(club.id, {
    name: "BUCHANANS 12", category: 'Botellas', price: 2650, stock: null,
  });
  await f.setRecipe(trago.id, [[whisky, 45], [refresco, 200]]);
  await f.setRecipe(botella.id, [[whisky, 750]]);
  return { whisky, refresco, trago, botella };
}

const pedir = (drink, quantity, who) => api().post(url('/orders')).set(auth(who || guest)).send({
  client_request_id: randomUUID(),
  table_id: table.id,
  items: [{ drink_id: drink.id, quantity }],
});

describe('Un trago descuenta de la botella, no de un contador inventado', () => {
  it('seis tragos consumen 270 ml de la misma botella que se vende completa', async () => {
    const { whisky, trago } = await barraBuchanans();
    const res = await pedir(trago, 6);
    expect(res.status).toBe(201);
    expect(await f.supplyStock(whisky.id)).toBe(1500 - 270);
  });

  it('un trago con dos ingredientes baja los dos, cada uno lo suyo', async () => {
    const { whisky, refresco, trago } = await barraBuchanans();
    await pedir(trago, 2);
    expect(await f.supplyStock(whisky.id)).toBe(1500 - 90);
    expect(await f.supplyStock(refresco.id)).toBe(4000 - 400);
  });

  it('vender la botella completa baja los 750 ml de la MISMA existencia', async () => {
    const { whisky, trago, botella } = await barraBuchanans();
    await pedir(trago, 4); // 180 ml
    await pedir(botella, 1); // 750 ml
    expect(await f.supplyStock(whisky.id)).toBe(1500 - 180 - 750);
  });

  it('la carta dice cuántos ALCANZAN, no un número suelto', async () => {
    const { trago, botella } = await barraBuchanans({ ml: 200 });
    const res = await api().get(url('/drinks')).set(auth(guest));
    const byId = Object.fromEntries(res.body.drinks.map((d) => [d.id, d]));
    // Con 200 ml quedan 4 tragos de 45 ml y ninguna botella de 750.
    expect(byId[trago.id].stock).toBe(4);
    expect(byId[botella.id].stock).toBe(0);
    expect(byId[trago.id].stock_tracked).toBe(true);
  });

  it('el ingrediente más escaso manda, aunque del otro sobre', async () => {
    const { refresco, trago } = await barraBuchanans();
    await pool.query('UPDATE supply_stock SET stock = 300 WHERE supply_id = $1', [refresco.id]);
    const res = await api().get(url('/drinks')).set(auth(guest));
    const t = res.body.drinks.find((d) => d.id === trago.id);
    expect(t.stock).toBe(1); // 300 ml de refresco / 200 = 1, aunque el whisky da para 33
  });
});

describe('Lo que no se sabe, no se inventa', () => {
  it('un producto sin receta NO tiene existencia: dice null, no cero', async () => {
    const suelto = await f.createDrink(club.id, { name: 'CORTESIA', stock: null });
    const res = await api().get(url('/drinks')).set(auth(guest));
    const d = res.body.drinks.find((x) => x.id === suelto.id);
    expect(d.stock).toBeNull();
    expect(d.stock_tracked).toBe(false);
  });

  it('y se puede vender: sin dato no se bloquea la venta', async () => {
    const suelto = await f.createDrink(club.id, { name: 'CORTESIA', stock: null });
    expect((await pedir(suelto, 3)).status).toBe(201);
  });

  it('un insumo nace en cero: la existencia entra por recepción o conteo', async () => {
    const res = await api().post(url('/supplies')).set(auth(manager)).send({
      name: 'Tequila Don Julio', unit: 'ml', package_size: 700, package_label: 'Botella 700 ml',
    });
    expect(res.status).toBe(201);
    expect(res.body.supply.stock).toBe(0);
    expect(res.body.supply.avg_cost).toBe(0);
    expect(res.body.supply.locations).toEqual([]);
  });
});

describe('No se vende lo que no alcanza, y se dice qué faltó', () => {
  it('rechaza el pedido nombrando el INSUMO y lo que queda de verdad', async () => {
    const { trago } = await barraBuchanans({ ml: 100 });
    const res = await pedir(trago, 3); // 135 ml y solo hay 100
    expect(res.status).toBe(409);
    const falta = res.body.error.details.supplies[0];
    expect(falta).toMatchObject({ name: "Buchanan's 12", reason: 'out_of_stock', unit: 'ml' });
    expect(falta.available).toBe(100);
    expect(falta.needed).toBe(135);
  });

  it('y no toca el inventario al rechazar', async () => {
    const { whisky, refresco, trago } = await barraBuchanans({ ml: 100 });
    await pedir(trago, 3);
    expect(await f.supplyStock(whisky.id)).toBe(100);
    expect(await f.supplyStock(refresco.id)).toBe(4000);
  });

  it('un insumo dado de baja detiene la venta aunque el saldo diga que hay', async () => {
    const { whisky, trago } = await barraBuchanans();
    await pool.query('UPDATE supplies SET active = false WHERE id = $1', [whisky.id]);
    expect((await pedir(trago, 1)).status).toBe(409);
  });

  it('dos pedidos seguidos no se llevan la misma botella dos veces', async () => {
    const { whisky, botella } = await barraBuchanans({ ml: 750 });
    const uno = await pedir(botella, 1);
    const dos = await pedir(botella, 1);
    expect(uno.status).toBe(201);
    expect(dos.status).toBe(409);
    expect(await f.supplyStock(whisky.id)).toBe(0);
  });
});

describe('Cancelar devuelve exactamente lo que salió', () => {
  it('devuelve los mililitros consumidos, no los de la receta de hoy', async () => {
    const { whisky, refresco, trago } = await barraBuchanans();
    const res = await pedir(trago, 4); // 180 ml y 800 ml
    const id = res.body.order.id;

    // Alguien corrige la receta entre que se sirvió y que se cancela.
    await f.setRecipe(trago.id, [[whisky, 60], [refresco, 300]]);

    await api().post(url(`/orders/${id}/status`)).set(auth(bartender)).send({ status: 'cancelled' });
    expect(await f.supplyStock(whisky.id)).toBe(1500);
    expect(await f.supplyStock(refresco.id)).toBe(4000);
  });

  it('cancelar dos veces no regala producto', async () => {
    const { whisky, trago } = await barraBuchanans();
    const res = await pedir(trago, 2);
    const id = res.body.order.id;
    await api().post(url(`/orders/${id}/status`)).set(auth(bartender)).send({ status: 'cancelled' });
    await api().post(url(`/orders/${id}/status`)).set(auth(bartender)).send({ status: 'cancelled' });
    expect(await f.supplyStock(whisky.id)).toBe(1500);
  });

  it('la devolución deja su renglón en el kardex, con motivo', async () => {
    const { whisky, trago } = await barraBuchanans();
    const res = await pedir(trago, 1);
    await api().post(url(`/orders/${res.body.order.id}/status`)).set(auth(bartender))
      .send({ status: 'cancelled', reason: 'Se equivocó de mesa' });

    const mov = await api().get(url(`/supplies/${whisky.id}/movements`)).set(auth(manager));
    const kinds = mov.body.movements.map((m) => m.kind);
    // El 'receipt' del final es como entró la botella al estante: en este modelo la
    // existencia no aparece sola, ni siquiera en una prueba.
    expect(kinds).toEqual(['return', 'consumption', 'receipt']);
    expect(mov.body.movements[0].reason).toBe('Se equivocó de mesa');
  });
});

describe('El kardex explica cada saldo', () => {
  it('cada movimiento guarda el saldo que quedó', async () => {
    const { whisky, trago } = await barraBuchanans();
    await pedir(trago, 2); // -90
    await pedir(trago, 1); // -45
    const mov = await api().get(url(`/supplies/${whisky.id}/movements`)).set(auth(manager));
    expect(mov.body.movements.map((m) => m.balance_after)).toEqual([1365, 1410, 1500]);
  });

  it('dice quién y contra qué pedido salió', async () => {
    const { whisky, trago } = await barraBuchanans();
    const res = await pedir(trago, 1, waiter);
    const mov = await api().get(url(`/supplies/${whisky.id}/movements`)).set(auth(manager));
    expect(mov.body.movements[0]).toMatchObject({
      reference_type: 'drink_order',
      reference_id: res.body.order.id,
      created_by: waiter.id,
    });
  });

  it('el kardex no se puede corregir por detrás', async () => {
    const { whisky, trago } = await barraBuchanans();
    await pedir(trago, 1);
    await expect(pool.query('UPDATE supply_movements SET quantity = 0 WHERE supply_id = $1',
      [whisky.id])).rejects.toThrow(/insert-only/);
    await expect(pool.query('DELETE FROM supply_movements WHERE supply_id = $1', [whisky.id]))
      .rejects.toThrow(/insert-only/);
  });

  it('el saldo es la suma de su historia', async () => {
    const { whisky, trago } = await barraBuchanans();
    await pedir(trago, 3);
    const { rows } = await pool.query(
      `SELECT sum(quantity)::float8 AS total FROM supply_movements WHERE supply_id = $1`,
      [whisky.id]);
    // Sin sumandos de fuera: el saldo ES la suma del kardex, entrada incluida.
    expect(Number(rows[0].total)).toBe(await f.supplyStock(whisky.id));
  });
});

describe('Conteo físico: la diferencia es el dato', () => {
  it('capturar lo que hay en el estante calcula la merma', async () => {
    const { whisky, trago } = await barraBuchanans();
    await pedir(trago, 4); // teórico: 1320

    const res = await api().post(url(`/supplies/${whisky.id}/count`)).set(auth(manager))
      .send({ location_id: club.bar_id, counted: 1200, reason: 'Corte de la noche' });

    expect(res.status).toBe(200);
    expect(res.body.difference).toBe(-120);
    expect(res.body.shrinkage).toBe(120);
    expect(res.body.supply.stock).toBe(1200);
  });

  it('si el conteo coincide no inventa un movimiento', async () => {
    const { whisky } = await barraBuchanans();
    const res = await api().post(url(`/supplies/${whisky.id}/count`)).set(auth(manager))
      .send({ location_id: club.bar_id, counted: 1500 });
    expect(res.body.difference).toBe(0);
    const mov = await api().get(url(`/supplies/${whisky.id}/movements`)).set(auth(manager));
    expect(mov.body.movements.map((m) => m.kind)).not.toContain('count');
  });

  it('un ajuste a mano exige motivo', async () => {
    const { whisky } = await barraBuchanans();
    // Sin motivo no pasa ni la validación: un saldo corregido sin explicación es
    // indistinguible de un robo, y separar esas dos cosas es para lo que sirve.
    const res = await api().post(url(`/supplies/${whisky.id}/adjust`)).set(auth(manager))
      .send({ location_id: club.bar_id, kind: 'waste', quantity: -750 });
    expect(res.status).toBe(400);
    expect(await f.supplyStock(whisky.id)).toBe(1500);
  });

  it('una rotura se registra como tal, no como una venta', async () => {
    const { whisky } = await barraBuchanans();
    const res = await api().post(url(`/supplies/${whisky.id}/adjust`)).set(auth(manager))
      .send({ location_id: club.bar_id, kind: 'waste', quantity: -750, reason: 'Se cayó una botella' });
    expect(res.status).toBe(200);
    expect(res.body.supply.stock).toBe(750);
    const mov = await api().get(url(`/supplies/${whisky.id}/movements`)).set(auth(manager));
    expect(mov.body.movements[0]).toMatchObject({ kind: 'waste', reason: 'Se cayó una botella' });
  });

  it('el cantinero SÍ reporta la merma de su barra: es donde se rompen las botellas', async () => {
    const { whisky } = await barraBuchanans();
    const res = await api().post(url(`/supplies/${whisky.id}/adjust`)).set(auth(bartender))
      .send({ location_id: club.bar_id, kind: 'waste', quantity: 750, reason: 'Se cayó' });
    expect(res.status).toBe(200);
    expect(res.body.supply.stock).toBe(750);
  });

  it('pero NO corrige un saldo: por ahí se tapa un faltante', async () => {
    const { whisky } = await barraBuchanans();
    const res = await api().post(url(`/supplies/${whisky.id}/adjust`)).set(auth(bartender))
      .send({ location_id: club.bar_id, kind: 'adjustment', quantity: 750, reason: 'Sobra' });
    expect(res.status).toBe(403);
    expect(await f.supplyStock(whisky.id)).toBe(1500);
  });

  it('una merma escrita en positivo igual RESTA: nadie merma hacia adentro', async () => {
    const { whisky } = await barraBuchanans();
    await api().post(url(`/supplies/${whisky.id}/adjust`)).set(auth(manager))
      .send({ location_id: club.bar_id, kind: 'waste', quantity: 750, reason: 'Rotura' });
    expect(await f.supplyStock(whisky.id)).toBe(750);
  });

  it('una cortesía sale del inventario, pero no se confunde con una venta', async () => {
    const { whisky } = await barraBuchanans();
    await api().post(url(`/supplies/${whisky.id}/adjust`)).set(auth(manager))
      .send({ location_id: club.bar_id, kind: 'courtesy', packages: 1, reason: 'Mesa del dueño' });
    const mov = await api().get(url(`/supplies/${whisky.id}/movements`)).set(auth(manager));
    expect(mov.body.movements[0]).toMatchObject({ kind: 'courtesy', quantity: -750 });
    expect(await f.supplyStock(whisky.id)).toBe(750);
  });

  it('no se puede mermar más de lo que hay en ese estante', async () => {
    const { whisky } = await barraBuchanans({ ml: 300 });
    const res = await api().post(url(`/supplies/${whisky.id}/adjust`)).set(auth(manager))
      .send({ location_id: club.bar_id, kind: 'waste', quantity: 750, reason: 'Rotura' });
    expect(res.status).toBe(409);
    expect(await f.supplyStock(whisky.id)).toBe(300);
  });
});

describe('Costo promedio ponderado', () => {
  const inventory = require('../src/services/inventory');

  const recibir = async (supplyId, quantity, unitCost) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await inventory.receive(client, {
        nightclubId: club.id, supplyId, locationId: club.warehouse_id,
        quantity, unitCost, userId: manager.id,
      });
      await client.query('COMMIT');
    } finally { client.release(); }
  };
  const costo = async (id) => {
    const { rows } = await pool.query('SELECT avg_cost::float8 AS c FROM supplies WHERE id = $1', [id]);
    return Number(rows[0].c);
  };

  it('la primera compra fija el costo', async () => {
    const s = await f.createSupply(club.id, { name: 'Ron', unit: 'ml', package_size: 750 });
    await recibir(s.id, 1500, 1.2);
    expect(await costo(s.id)).toBeCloseTo(1.2, 6);
    expect(await f.supplyStock(s.id)).toBe(1500);
  });

  it('pondera por cantidad, no por número de compras', async () => {
    const s = await f.createSupply(club.id, { name: 'Ron', unit: 'ml', package_size: 750 });
    await recibir(s.id, 1500, 1.0);   // 15 000 ml... no: 1500 ml a 1.00
    await recibir(s.id, 500, 2.0);
    // (1500*1 + 500*2) / 2000 = 1.25 — y NO 1.50, que sería el promedio simple.
    expect(await costo(s.id)).toBeCloseTo(1.25, 6);
  });

  it('recibir sube la existencia y deja su renglón', async () => {
    const s = await f.createSupply(club.id, { name: 'Ron', unit: 'ml', package_size: 750 });
    await recibir(s.id, 750, 1.5);
    const mov = await api().get(url(`/supplies/${s.id}/movements`)).set(auth(manager));
    expect(mov.body.movements[0]).toMatchObject({ kind: 'receipt', quantity: 750, unit_cost: 1.5 });
  });
});

describe('Recetas', () => {
  it('lista los productos que todavía no tienen receta', async () => {
    await barraBuchanans();
    await f.createDrink(club.id, { name: 'SIN RECETA', stock: null });
    const res = await api().get(url('/recipes')).set(auth(manager));
    expect(res.body.without_recipe).toBe(1);
    expect(res.body.recipes[0].name).toBe('SIN RECETA');
  });

  it('guardar la receta reemplaza la anterior entera', async () => {
    const { whisky, trago } = await barraBuchanans();
    const res = await api().put(url(`/recipes/${trago.id}`)).set(auth(manager))
      .send({ items: [{ supply_id: whisky.id, quantity: 60 }] });
    expect(res.status).toBe(200);
    expect(res.body.recipe.items).toHaveLength(1);
    expect(res.body.recipe.items[0].quantity).toBe(60);
  });

  it('no deja repetir un insumo en la misma receta', async () => {
    const { whisky, trago } = await barraBuchanans();
    const res = await api().put(url(`/recipes/${trago.id}`)).set(auth(manager)).send({
      items: [{ supply_id: whisky.id, quantity: 45 }, { supply_id: whisky.id, quantity: 15 }],
    });
    expect(res.status).toBe(422);
  });

  it('una receta vacía apaga el control de existencia de ese producto', async () => {
    const { trago } = await barraBuchanans();
    await api().put(url(`/recipes/${trago.id}`)).set(auth(manager)).send({ items: [] });
    const res = await api().get(url('/drinks')).set(auth(guest));
    expect(res.body.drinks.find((d) => d.id === trago.id).stock).toBeNull();
  });

  it('un insumo de otro club no entra en la receta de aquí', async () => {
    const otro = await f.createNightclub({ slug: 'otro-club-inv' });
    const ajeno = await f.createSupply(otro.id, { name: 'Ajeno' });
    const { trago } = await barraBuchanans();
    const res = await api().put(url(`/recipes/${trago.id}`)).set(auth(manager))
      .send({ items: [{ supply_id: ajeno.id, quantity: 45 }] });
    expect(res.status).toBe(404);
  });

  it('el cliente no ve ni toca insumos ni recetas', async () => {
    expect((await api().get(url('/supplies')).set(auth(guest))).status).toBe(403);
    expect((await api().get(url('/recipes')).set(auth(guest))).status).toBe(403);
  });
});

describe('Faltantes para el gerente', () => {
  it('marca bajo mínimo lo que hay que comprar', async () => {
    const { whisky } = await barraBuchanans({ ml: 700 }); // mínimo 750
    const res = await api().get(url('/supplies?low_only=true')).set(auth(manager));
    expect(res.body.supplies).toHaveLength(1);
    expect(res.body.supplies[0]).toMatchObject({ id: whisky.id, low: true });
  });

  it('dice cuántas presentaciones quedan, que es como se cuenta en el estante', async () => {
    const { whisky } = await barraBuchanans({ ml: 1875 });
    const res = await api().get(url('/supplies')).set(auth(manager));
    const s = res.body.supplies.find((x) => x.id === whisky.id);
    expect(s.packages).toBeCloseTo(2.5, 3); // 1875 / 750
  });

  it('valora la existencia al costo, no al precio de venta', async () => {
    const s = await f.createSupply(club.id, { name: 'Ron', stock: 1000, avg_cost: 1.5 });
    const res = await api().get(url('/supplies')).set(auth(manager));
    expect(res.body.supplies.find((x) => x.id === s.id).stock_value).toBeCloseTo(1500, 3);
  });

  it('no se ven los insumos de otro club', async () => {
    const otro = await f.createNightclub({ slug: 'otro-club-inv2' });
    await f.createSupply(otro.id, { name: 'Ajeno' });
    await barraBuchanans();
    const res = await api().get(url('/supplies')).set(auth(manager));
    expect(res.body.supplies.map((s) => s.name)).not.toContain('Ajeno');
  });
});

/**
 * Dos barras.
 *
 * Es la diferencia entre un inventario que sirve y uno decorativo: treinta botellas
 * repartidas 10/15/5 no son treinta disponibles. Si la barra de arriba se queda sin
 * mango, de nada sirve que el almacén tenga diez, y un sistema que diga "quedan 30"
 * mientras el cantinero mira un estante vacío es peor que no decir nada.
 */
describe('Cada barra tiene su propio estante', () => {
  it('el club arranca con almacén y las dos barras', async () => {
    const res = await api().get(url('/supply-locations')).set(auth(manager));
    expect(res.status).toBe(200);
    expect(res.body.locations.map((l) => l.code).sort())
      .toEqual(['almacen', 'barra-alta', 'barra-baja']);
    expect(res.body.locations.find((l) => l.code === 'almacen').kind).toBe('warehouse');
  });

  it('la existencia se reporta por lugar y en total', async () => {
    const s = await f.createSupply(club.id, { name: 'Absolut Mango', package_size: 750 });
    await f.stockUp(club.id, s.id, club.locations.almacen, 7500);      // 10 botellas
    await f.stockUp(club.id, s.id, club.locations['barra-baja'], 11250); // 15
    await f.stockUp(club.id, s.id, club.locations['barra-alta'], 3750);  // 5

    const res = await api().get(url('/supplies')).set(auth(manager));
    const supply = res.body.supplies.find((x) => x.id === s.id);
    expect(supply.packages).toBeCloseTo(30, 3);
    const byCode = Object.fromEntries(supply.locations.map((l) => [l.code, l.packages]));
    expect(byCode).toEqual({ almacen: 10, 'barra-baja': 15, 'barra-alta': 5 });
  });

  it('un trago de la barra de abajo NO baja del estante de arriba', async () => {
    const { whisky, trago } = await barraBuchanans();
    await f.stockUp(club.id, whisky.id, club.locations['barra-alta'], 3000);
    await pedir(trago, 2); // la mesa T-1 la atiende la barra de abajo

    expect(await f.supplyStock(whisky.id, club.locations['barra-baja'])).toBe(1500 - 90);
    expect(await f.supplyStock(whisky.id, club.locations['barra-alta'])).toBe(3000);
  });

  it('la barra de arriba no puede servir lo que solo está abajo', async () => {
    const { trago } = await barraBuchanans();
    const arriba = await f.createTable(club.id, { code: 'V-1', section: 'vip-elevado' });
    await pool.query(`UPDATE tables SET floor = 'alta' WHERE id = $1`, [arriba.id]);

    const res = await api().post(url('/orders')).set(auth(guest)).send({
      client_request_id: randomUUID(), table_id: arriba.id,
      items: [{ drink_id: trago.id, quantity: 1 }],
    });
    expect(res.status).toBe(409);
    expect(res.body.error.details.supplies[0]).toMatchObject({ reason: 'out_of_stock', available: 0 });
  });

  it('el gerente reasigna una zona a la otra barra y el pedido cambia de estante', async () => {
    const { whisky, refresco, trago } = await barraBuchanans();
    await f.stockUp(club.id, whisky.id, club.locations['barra-alta'], 3000);
    await f.stockUp(club.id, refresco.id, club.locations['barra-alta'], 4000);

    const assign = await api().put(url('/zone-bars')).set(auth(manager)).send({
      assignments: [{ section: 'main', location_id: club.locations['barra-alta'] }],
    });
    expect(assign.status).toBe(200);

    expect((await pedir(trago, 2)).status).toBe(201);
    expect(await f.supplyStock(whisky.id, club.locations['barra-baja'])).toBe(1500);
    expect(await f.supplyStock(whisky.id, club.locations['barra-alta'])).toBe(3000 - 90);
  });

  it('una zona no se puede asignar al almacén: el almacén no sirve tragos', async () => {
    const res = await api().put(url('/zone-bars')).set(auth(manager)).send({
      assignments: [{ section: 'main', location_id: club.locations.almacen }],
    });
    expect(res.status).toBe(422);
  });

  it('no se apaga una barra que todavía atiende zonas', async () => {
    await api().put(url('/zone-bars')).set(auth(manager)).send({
      assignments: [{ section: 'main', location_id: club.bar_id }],
    });
    const res = await api().patch(url(`/supply-locations/${club.bar_id}`)).set(auth(manager))
      .send({ active: false });
    expect(res.status).toBe(409);
    expect(res.body.error.details.sections).toContain('main');
  });

  it('la carta dice de qué barra habla', async () => {
    await barraBuchanans();
    const res = await api().get(url('/drinks')).set(auth(guest));
    expect(res.body.bar_location_id).toBe(club.bar_id);
  });

  it('el pedido guarda de qué barra salió y a dónde va', async () => {
    const { trago } = await barraBuchanans();
    const res = await pedir(trago, 1);
    expect(res.body.order.bar_location_id).toBe(club.bar_id);
    expect(res.body.order.bar_name).toBe('Barra planta baja');
  });
});

describe('Traspasos: el producto no aparece, se mueve', () => {
  const surtir = (supplyId, body, who) => api()
    .post(url(`/supplies/${supplyId}/transfer`)).set(auth(who || manager)).send(body);

  it('lo que sale del almacén entra en la barra, con un solo folio', async () => {
    const s = await f.createSupply(club.id, { name: 'Tequila', package_size: 750 });
    await f.stockUp(club.id, s.id, club.locations.almacen, 7500);

    const res = await surtir(s.id, {
      from_location_id: club.locations.almacen,
      to_location_id: club.locations['barra-baja'],
      packages: 3, reason: 'Surtido de apertura',
    });

    expect(res.status).toBe(201);
    expect(await f.supplyStock(s.id, club.locations.almacen)).toBe(7500 - 2250);
    expect(await f.supplyStock(s.id, club.locations['barra-baja'])).toBe(2250);
    // Y el total del club no cambió: el producto se movió, no se creó.
    expect(await f.supplyStock(s.id)).toBe(7500);
    expect(res.body.transfer.out.id).not.toBe(res.body.transfer.in.id);
  });

  it('los dos renglones quedan unidos, para poder preguntar de dónde salió', async () => {
    const s = await f.createSupply(club.id, { name: 'Tequila', package_size: 750 });
    await f.stockUp(club.id, s.id, club.locations.almacen, 1500);
    await surtir(s.id, {
      from_location_id: club.locations.almacen,
      to_location_id: club.locations['barra-alta'], quantity: 750,
    });

    const mov = await api().get(url(`/supplies/${s.id}/movements`)).set(auth(manager));
    const traspaso = mov.body.movements.filter((m) => m.kind.startsWith('transfer'));
    expect(traspaso).toHaveLength(2);
    expect(traspaso[0].transfer_group).toBe(traspaso[1].transfer_group);
    const entrada = traspaso.find((m) => m.kind === 'transfer_in');
    expect(entrada.location_code).toBe('barra-alta');
    expect(entrada.counterpart_code).toBe('almacen');
  });

  it('no se traspasa lo que no hay: el almacén no queda en negativo', async () => {
    const s = await f.createSupply(club.id, { name: 'Tequila', package_size: 750 });
    await f.stockUp(club.id, s.id, club.locations.almacen, 750);
    const res = await surtir(s.id, {
      from_location_id: club.locations.almacen,
      to_location_id: club.bar_id, packages: 2,
    });
    expect(res.status).toBe(409);
    expect(res.body.error.details).toMatchObject({ needed: 1500, available: 750 });
    expect(await f.supplyStock(s.id, club.locations.almacen)).toBe(750);
  });

  it('no se traspasa a sí mismo', async () => {
    const s = await f.createSupply(club.id, { name: 'Tequila', stock: 750 });
    const res = await surtir(s.id, {
      from_location_id: club.bar_id, to_location_id: club.bar_id, quantity: 100,
    });
    expect(res.status).toBe(422);
  });

  it('el cantinero no surte su propia barra: eso lo hace almacén', async () => {
    const s = await f.createSupply(club.id, { name: 'Tequila' });
    await f.stockUp(club.id, s.id, club.locations.almacen, 750);
    const res = await surtir(s.id, {
      from_location_id: club.locations.almacen, to_location_id: club.bar_id, quantity: 750,
    }, bartender);
    expect(res.status).toBe(403);
  });

  it('quien recibe cuenta cajas, no mililitros', async () => {
    const s = await f.createSupply(club.id, { name: 'Tequila', package_size: 750 });
    const res = await api().post(url(`/supplies/${s.id}/receive`)).set(auth(manager))
      .send({ location_id: club.locations.almacen, packages: 12, package_cost: 900 });
    expect(res.status).toBe(201);
    expect(await f.supplyStock(s.id, club.locations.almacen)).toBe(9000);
    // El costo se guarda por unidad base, que es como lo consume la receta.
    expect(res.body.supply.avg_cost).toBeCloseTo(900 / 750, 6);
  });

  it('el mínimo es por lugar: la barra se surte antes que el almacén', async () => {
    const s = await f.createSupply(club.id, { name: 'Tequila', package_size: 750 });
    await f.stockUp(club.id, s.id, club.bar_id, 750);
    await api().put(url(`/supplies/${s.id}/min-stock`)).set(auth(manager))
      .send({ location_id: club.bar_id, min_stock: 1500 });

    const res = await api().get(url('/supplies?low_only=true')).set(auth(manager));
    const supply = res.body.supplies.find((x) => x.id === s.id);
    expect(supply.low).toBe(true);
    expect(supply.locations.find((l) => l.code === 'barra-baja').low).toBe(true);
  });
});

describe('Presentaciones sin confirmar', () => {
  it('un tamaño que nadie confirmó se reporta como tal', async () => {
    const s = await f.createSupply(club.id, { name: 'Clase Azul', package_size: 750 });
    await pool.query('UPDATE supplies SET size_confirmed = false WHERE id = $1', [s.id]);
    const res = await api().get(url('/supplies?unconfirmed_only=true')).set(auth(manager));
    expect(res.body.supplies.map((x) => x.id)).toEqual([s.id]);
    expect(res.body.unconfirmed_sizes).toBe(1);
  });

  it('corregir el tamaño lo da por confirmado', async () => {
    const s = await f.createSupply(club.id, { name: 'Clase Azul', package_size: 750 });
    await pool.query('UPDATE supplies SET size_confirmed = false WHERE id = $1', [s.id]);
    const res = await api().patch(url(`/supplies/${s.id}`)).set(auth(manager))
      .send({ package_size: 700, package_label: 'Botella 700 ml' });
    expect(res.body.supply.size_confirmed).toBe(true);
    expect(res.body.supply.package_size).toBe(700);
  });
});
