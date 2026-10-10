/**
 * La barra pide, el almacén surte.
 *
 * El orden es el del club real: quien sabe qué falta es el cantinero mirando su
 * estante a las once de la noche, no el almacenista a las seis de la tarde. Antes
 * de esto, surtir era una orden hacia abajo y lo que faltaba se resolvía de palabra
 * — que es cómo acaba producto en la barra sin registro.
 *
 * Lo que se prueba:
 *
 *   1. Surtir de MENOS es un resultado, no un error. Si el almacén tiene ocho de
 *      los doce pedidos, se mandan ocho, el pedido queda `partial`, y el faltante
 *      queda escrito. Negar el pedido entero dejaría a la barra sin los once que sí
 *      había, y el cantinero acabaría tomándolo del almacén sin registro.
 *   2. Surtir de MÁS se niega. Si la barra necesita más, lo pide otra vez.
 *   3. Una barra no se surte a sí misma, y el almacén no se pide a sí mismo.
 *   4. Un pedido cancelado o ya surtido no se vuelve a surtir.
 *   5. Lo ya surtido antes de cancelar NO se devuelve: esa mercancía está
 *      físicamente en la barra.
 */
'use strict';

const { setupSchema, truncateAll, closePool, pool } = require('./helpers/db');
const { api, auth } = require('./helpers/api');
const f = require('./helpers/factories');

let club;
let warehouse;
let bar;
let otherBar;
let manager;
let almacenista;
let bartender;

beforeAll(async () => {
  await setupSchema();
});
beforeEach(async () => {
  await truncateAll();
  club = await f.createNightclub({ slug: 'ev2-requests' });
  warehouse = club.warehouse_id;
  bar = club.locations['barra-baja'];
  otherBar = club.locations['barra-alta'];
  manager = await f.createUser(club.id, { role: 'manager' });
  almacenista = await f.createUser(club.id, { role: 'warehouse' });
  bartender = await f.createUser(club.id, { role: 'bartender' });
});
afterAll(closePool);

const url = (path) => `/api/nightclubs/${club.id}${path}`;

/** Un insumo con existencia en el almacén, en presentaciones de 1 L. */
async function conExistencia(nombre, litros) {
  const supply = await f.createSupply(club.id, { name: nombre, package_size: 1000 });
  if (litros) await f.stockUp(club.id, supply.id, warehouse, litros * 1000);
  return supply;
}

async function pedir(lines, over = {}) {
  const res = await api().post(url('/bar-requests')).set(auth(bartender))
    .send({ location_id: bar, lines, ...over });
  expect(res.status).toBe(201);
  return res.body.request;
}

const surtir = (requestId, body = {}) => api()
  .post(url(`/bar-requests/${requestId}/fulfill`)).set(auth(almacenista))
  .send({ from_location_id: warehouse, ...body });

// ===========================================================================
// Pedir
// ===========================================================================

describe('POST /bar-requests', () => {
  it('el cantinero pide y el pedido nace abierto', async () => {
    const whisky = await conExistencia('Buchanans 12', 10);

    const pedido = await pedir([{ supply_id: whisky.id, packages: 3 }]);

    expect(pedido).toMatchObject({ status: 'open', location_id: bar });
    expect(pedido.lines).toHaveLength(1);
    expect(pedido.lines[0]).toMatchObject({ quantity: 3000, fulfilled: 0 });
    expect(pedido.requested_by).toBe(bartender.id);
  });

  it('se puede pedir algo que el almacén NO tiene: eso es lo que hay que comprar', async () => {
    const whisky = await conExistencia('Clase Azul', 0);
    const pedido = await pedir([{ supply_id: whisky.id, packages: 2 }]);
    expect(pedido.status).toBe('open');
  });

  it('el almacén NO se pide producto a sí mismo', async () => {
    const whisky = await conExistencia('Buchanans 12', 5);
    const res = await api().post(url('/bar-requests')).set(auth(almacenista))
      .send({ location_id: warehouse, lines: [{ supply_id: whisky.id, packages: 1 }] });

    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/barra/i);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM bar_requests');
    expect(rows[0].n).toBe(0);
  });

  it('el mismo insumo dos veces en un pedido se rechaza', async () => {
    const whisky = await conExistencia('Buchanans 12', 5);
    const res = await api().post(url('/bar-requests')).set(auth(bartender)).send({
      location_id: bar,
      lines: [{ supply_id: whisky.id, packages: 2 }, { supply_id: whisky.id, packages: 3 }],
    });
    expect(res.status).toBe(422);
    expect(res.body.error.details.lines[0].code).toBe('duplicate_supply');
  });

  it('un pedido sin renglones no existe', async () => {
    const res = await api().post(url('/bar-requests')).set(auth(bartender))
      .send({ location_id: bar, lines: [] });
    expect(res.status).toBe(400);
  });

  it('el cliente no pide al almacén', async () => {
    const whisky = await conExistencia('Buchanans 12', 5);
    const invitado = await f.createUser(club.id, { role: 'guest' });
    const res = await api().post(url('/bar-requests')).set(auth(invitado))
      .send({ location_id: bar, lines: [{ supply_id: whisky.id, packages: 1 }] });
    expect(res.status).toBe(403);
  });
});

// ===========================================================================
// Lo que la barra debería pedir
// ===========================================================================

describe('GET /bar-requests/suggested', () => {
  it('trae lo que está bajo el mínimo, con lo que hay en el almacén al lado', async () => {
    const whisky = await f.createSupply(club.id, {
      name: 'Buchanans 12', package_size: 1000, location_id: bar, stock: 500, min_stock: 3000,
    });
    await f.stockUp(club.id, whisky.id, warehouse, 10_000);

    const res = await api().get(url('/bar-requests/suggested')).query({ location_id: bar })
      .set(auth(bartender));

    expect(res.status).toBe(200);
    expect(res.body.suggested).toHaveLength(1);
    expect(res.body.suggested[0]).toMatchObject({
      supply_id: whisky.id, stock: 500, min_stock: 3000, missing: 2500,
      warehouse_stock: 10_000, warehouse_has_enough: true,
    });
    // Redondeado HACIA ARRIBA: nadie manda media botella del almacén a la barra.
    expect(res.body.suggested[0].suggested_packages).toBe(3);
  });

  it('avisa cuando el almacén tampoco tiene: ese pedido nace muerto', async () => {
    const whisky = await f.createSupply(club.id, {
      name: 'Clase Azul', package_size: 1000, location_id: bar, stock: 200, min_stock: 5000,
    });
    await f.stockUp(club.id, whisky.id, warehouse, 1000);

    const res = await api().get(url('/bar-requests/suggested')).query({ location_id: bar })
      .set(auth(bartender));
    expect(res.body.suggested[0].warehouse_has_enough).toBe(false);
  });

  it('un insumo sin mínimo capturado no se sugiere: sin mínimo no hay "poco"', async () => {
    const whisky = await f.createSupply(club.id, {
      name: 'Sin minimo', package_size: 1000, location_id: bar, stock: 100,
    });
    const res = await api().get(url('/bar-requests/suggested')).query({ location_id: bar })
      .set(auth(bartender));
    expect(res.body.suggested.map((s) => s.supply_id)).not.toContain(whisky.id);
  });

  it('el almacén no es una barra y no tiene qué pedir', async () => {
    const res = await api().get(url('/bar-requests/suggested')).query({ location_id: warehouse })
      .set(auth(almacenista));
    expect(res.status).toBe(422);
  });
});

// ===========================================================================
// Surtir
// ===========================================================================

describe('POST /bar-requests/:id/fulfill', () => {
  it('surte completo y mueve la existencia de verdad', async () => {
    const whisky = await conExistencia('Buchanans 12', 10);
    const pedido = await pedir([{ supply_id: whisky.id, packages: 3 }]);

    const res = await surtir(pedido.id);

    expect(res.status).toBe(200);
    expect(res.body.request.status).toBe('fulfilled');
    expect(res.body.sent).toHaveLength(1);
    expect(res.body.short).toHaveLength(0);
    expect(await f.supplyStock(whisky.id, warehouse)).toBe(7000);
    expect(await f.supplyStock(whisky.id, bar)).toBe(3000);
  });

  it('el traspaso queda ligado al pedido en el kardex', async () => {
    const whisky = await conExistencia('Buchanans 12', 10);
    const pedido = await pedir([{ supply_id: whisky.id, packages: 2 }]);
    await surtir(pedido.id);

    const { rows } = await pool.query(
      `SELECT kind, request_id FROM supply_movements
        WHERE kind IN ('transfer_in','transfer_out') ORDER BY kind`);
    expect(rows).toHaveLength(2);
    // Los DOS renglones, el que sale y el que entra. Un traspaso sin causa es un
    // traspaso que nadie puede explicar a la mañana siguiente.
    expect(rows.every((r) => r.request_id === pedido.id)).toBe(true);
  });

  it('con menos de lo pedido manda lo que hay y lo deja escrito', async () => {
    const whisky = await conExistencia('Buchanans 12', 8);
    const pedido = await pedir([{ supply_id: whisky.id, packages: 12 }]);

    const res = await surtir(pedido.id);

    expect(res.status).toBe(200);
    expect(res.body.request.status).toBe('partial');
    expect(res.body.sent[0]).toMatchObject({ requested: 12_000, sent: 8000 });
    expect(res.body.short[0]).toMatchObject({ requested: 12_000, sent: 8000, available: 8000 });
    expect(res.body.request.lines[0]).toMatchObject({ quantity: 12_000, fulfilled: 8000 });
    // Lo que había se movió: la barra no se queda esperando.
    expect(await f.supplyStock(whisky.id, bar)).toBe(8000);
    expect(await f.supplyStock(whisky.id, warehouse)).toBe(0);
  });

  it('un renglón sin nada en almacén sale en el faltante y los demás sí se surten', async () => {
    const whisky = await conExistencia('Buchanans 12', 5);
    const azul = await conExistencia('Clase Azul', 0);
    const pedido = await pedir([
      { supply_id: whisky.id, packages: 3 },
      { supply_id: azul.id, packages: 2 },
    ]);

    const res = await surtir(pedido.id);

    expect(res.body.request.status).toBe('partial');
    expect(res.body.sent.map((s) => s.name)).toEqual(['Buchanans 12']);
    expect(res.body.short.map((s) => s.name)).toEqual(['Clase Azul']);
    expect(await f.supplyStock(whisky.id, bar)).toBe(3000);
    expect(await f.supplyStock(azul.id, bar)).toBe(0);
  });

  it('dos surtidos parciales completan el pedido', async () => {
    const whisky = await conExistencia('Buchanans 12', 4);
    const pedido = await pedir([{ supply_id: whisky.id, packages: 10 }]);

    const primero = await surtir(pedido.id);
    expect(primero.body.request.status).toBe('partial');

    // Llega mercancía y se surte el resto.
    await f.stockUp(club.id, whisky.id, warehouse, 6000);
    const segundo = await surtir(pedido.id);

    expect(segundo.body.request.status).toBe('fulfilled');
    expect(segundo.body.request.lines[0].fulfilled).toBe(10_000);
    expect(await f.supplyStock(whisky.id, bar)).toBe(10_000);
  });

  it('el almacén puede surtir solo parte, a propósito', async () => {
    const whisky = await conExistencia('Buchanans 12', 10);
    const pedido = await pedir([{ supply_id: whisky.id, packages: 8 }]);

    const res = await surtir(pedido.id, { lines: [{ supply_id: whisky.id, packages: 3 }] });

    expect(res.body.request.status).toBe('partial');
    expect(res.body.request.lines[0].fulfilled).toBe(3000);
    expect(await f.supplyStock(whisky.id, bar)).toBe(3000);
  });

  it('surtir MÁS de lo pedido se niega: si necesita más, lo pide otra vez', async () => {
    const whisky = await conExistencia('Buchanans 12', 20);
    const pedido = await pedir([{ supply_id: whisky.id, packages: 3 }]);

    const res = await surtir(pedido.id, { lines: [{ supply_id: whisky.id, packages: 5 }] });

    expect(res.status).toBe(422);
    expect(res.body.error.details.lines[0]).toMatchObject({ code: 'over_request', pending: 3000 });
    expect(await f.supplyStock(whisky.id, bar)).toBe(0);
  });

  it('surtir algo que no está en el pedido se niega', async () => {
    const whisky = await conExistencia('Buchanans 12', 10);
    const otro = await conExistencia('Bacardi', 10);
    const pedido = await pedir([{ supply_id: whisky.id, packages: 2 }]);

    const res = await surtir(pedido.id, { lines: [{ supply_id: otro.id, packages: 2 }] });

    expect(res.status).toBe(422);
    expect(res.body.error.details.lines[0].code).toBe('not_in_request');
    expect(await f.supplyStock(otro.id, bar)).toBe(0);
  });

  it('una barra NO se surte a sí misma', async () => {
    const whisky = await conExistencia('Buchanans 12', 10);
    await f.stockUp(club.id, whisky.id, bar, 5000);
    const pedido = await pedir([{ supply_id: whisky.id, packages: 2 }]);

    const res = await surtir(pedido.id, { from_location_id: bar });

    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/a sí misma/i);
  });

  it('se puede surtir desde la otra barra, que es lo que pasa a media noche', async () => {
    const whisky = await conExistencia('Buchanans 12', 0);
    await f.stockUp(club.id, whisky.id, otherBar, 4000);
    const pedido = await pedir([{ supply_id: whisky.id, packages: 2 }]);

    const res = await surtir(pedido.id, { from_location_id: otherBar });

    expect(res.status).toBe(200);
    expect(res.body.request.status).toBe('fulfilled');
    expect(await f.supplyStock(whisky.id, otherBar)).toBe(2000);
    expect(await f.supplyStock(whisky.id, bar)).toBe(2000);
  });

  it('un pedido ya surtido NO se vuelve a surtir', async () => {
    const whisky = await conExistencia('Buchanans 12', 10);
    const pedido = await pedir([{ supply_id: whisky.id, packages: 2 }]);
    await surtir(pedido.id);

    const otra = await surtir(pedido.id);
    expect(otra.status).toBe(409);
    // Y no se movió nada de más.
    expect(await f.supplyStock(whisky.id, bar)).toBe(2000);
  });

  it('el cantinero NO se surte a sí mismo: es la separación que hace que un faltante tenga dos nombres', async () => {
    const whisky = await conExistencia('Buchanans 12', 10);
    const pedido = await pedir([{ supply_id: whisky.id, packages: 2 }]);

    const res = await api().post(url(`/bar-requests/${pedido.id}/fulfill`)).set(auth(bartender))
      .send({ from_location_id: warehouse });

    expect(res.status).toBe(403);
    expect(await f.supplyStock(whisky.id, bar)).toBe(0);
  });

  it('el gerente sí puede surtir', async () => {
    const whisky = await conExistencia('Buchanans 12', 10);
    const pedido = await pedir([{ supply_id: whisky.id, packages: 2 }]);
    const res = await api().post(url(`/bar-requests/${pedido.id}/fulfill`)).set(auth(manager))
      .send({ from_location_id: warehouse });
    expect(res.status).toBe(200);
  });

  it('un pedido de otro club no se surte desde aquí', async () => {
    const otro = await f.createNightclub({ slug: 'otro-club-req', name: 'Otro' });
    const ajeno = await pool.query(
      `INSERT INTO bar_requests (nightclub_id, location_id) VALUES ($1,$2) RETURNING id`,
      [otro.id, otro.bar_id]);
    const res = await surtir(ajeno.rows[0].id);
    expect(res.status).toBe(404);
  });
});

// ===========================================================================
// Cancelar
// ===========================================================================

describe('POST /bar-requests/:id/cancel', () => {
  it('se cancela con motivo y deja de estar pendiente', async () => {
    const whisky = await conExistencia('Buchanans 12', 10);
    const pedido = await pedir([{ supply_id: whisky.id, packages: 2 }]);

    const res = await api().post(url(`/bar-requests/${pedido.id}/cancel`)).set(auth(bartender))
      .send({ reason: 'Ya cerramos la barra de arriba' });

    expect(res.status).toBe(200);
    expect(res.body.request.status).toBe('cancelled');

    const pendientes = await api().get(url('/bar-requests')).set(auth(almacenista));
    expect(pendientes.body.requests).toHaveLength(0);
  });

  it('cancelar sin motivo no se puede', async () => {
    const whisky = await conExistencia('Buchanans 12', 10);
    const pedido = await pedir([{ supply_id: whisky.id, packages: 2 }]);
    const res = await api().post(url(`/bar-requests/${pedido.id}/cancel`)).set(auth(bartender))
      .send({ reason: '' });
    expect(res.status).toBe(400);
  });

  it('un pedido cancelado ya NO se surte', async () => {
    const whisky = await conExistencia('Buchanans 12', 10);
    const pedido = await pedir([{ supply_id: whisky.id, packages: 2 }]);
    await api().post(url(`/bar-requests/${pedido.id}/cancel`)).set(auth(bartender))
      .send({ reason: 'Error de captura' });

    const res = await surtir(pedido.id);
    expect(res.status).toBe(409);
    expect(await f.supplyStock(whisky.id, bar)).toBe(0);
  });

  it('lo ya surtido antes de cancelar NO se devuelve: está en la barra', async () => {
    const whisky = await conExistencia('Buchanans 12', 4);
    const pedido = await pedir([{ supply_id: whisky.id, packages: 10 }]);
    await surtir(pedido.id);
    expect(await f.supplyStock(whisky.id, bar)).toBe(4000);

    const res = await api().post(url(`/bar-requests/${pedido.id}/cancel`)).set(auth(bartender))
      .send({ reason: 'Ya no alcanza la noche' });

    expect(res.status).toBe(200);
    // Devolverlo en la base dejaría el almacén diciendo que tiene botellas que
    // están físicamente arriba.
    expect(await f.supplyStock(whisky.id, bar)).toBe(4000);
    expect(await f.supplyStock(whisky.id, warehouse)).toBe(0);
  });

  it('un pedido ya surtido completo no se cancela', async () => {
    const whisky = await conExistencia('Buchanans 12', 10);
    const pedido = await pedir([{ supply_id: whisky.id, packages: 2 }]);
    await surtir(pedido.id);

    const res = await api().post(url(`/bar-requests/${pedido.id}/cancel`)).set(auth(bartender))
      .send({ reason: 'Ya no' });
    expect(res.status).toBe(409);
  });
});

// ===========================================================================
// La bandeja
// ===========================================================================

describe('GET /bar-requests', () => {
  it('por omisión trae solo lo que falta por surtir', async () => {
    const whisky = await conExistencia('Buchanans 12', 20);
    const abierto = await pedir([{ supply_id: whisky.id, packages: 2 }]);
    const surtido = await pedir([{ supply_id: whisky.id, packages: 1 }]);
    await surtir(surtido.id);

    const res = await api().get(url('/bar-requests')).set(auth(almacenista));

    expect(res.status).toBe(200);
    expect(res.body.requests.map((r) => r.id)).toEqual([abierto.id]);
    expect(res.body.requests[0].pending_lines).toBe(1);
    expect(res.body.requests[0].location_name).toBe('Barra planta baja');
    expect(res.body.requests[0].requested_by_name).toBeTruthy();
  });

  it('con status=all sale el historial completo', async () => {
    const whisky = await conExistencia('Buchanans 12', 20);
    const a = await pedir([{ supply_id: whisky.id, packages: 1 }]);
    await surtir(a.id);
    await pedir([{ supply_id: whisky.id, packages: 2 }]);

    const res = await api().get(url('/bar-requests')).query({ status: 'all' })
      .set(auth(almacenista));
    expect(res.body.requests).toHaveLength(2);
  });

  it('se filtra por barra', async () => {
    const whisky = await conExistencia('Buchanans 12', 20);
    await pedir([{ supply_id: whisky.id, packages: 1 }]);
    await api().post(url('/bar-requests')).set(auth(bartender))
      .send({ location_id: otherBar, lines: [{ supply_id: whisky.id, packages: 2 }] });

    const res = await api().get(url('/bar-requests')).query({ location_id: otherBar })
      .set(auth(bartender));
    expect(res.body.requests).toHaveLength(1);
    expect(res.body.requests[0].location_code).toBe('barra-alta');
  });

  it('cada renglón dice lo pedido, lo surtido y lo que falta', async () => {
    const whisky = await conExistencia('Buchanans 12', 4);
    const pedido = await pedir([{ supply_id: whisky.id, packages: 10 }]);
    await surtir(pedido.id);

    const res = await api().get(url(`/bar-requests/${pedido.id}`)).set(auth(bartender));
    expect(res.body.request.lines[0]).toMatchObject({ quantity: 10_000, fulfilled: 4000 });

    const bandeja = await api().get(url('/bar-requests')).set(auth(almacenista));
    expect(bandeja.body.requests[0].lines[0]).toMatchObject({
      quantity: 10_000, fulfilled: 4000, pending: 6000,
    });
  });
});
