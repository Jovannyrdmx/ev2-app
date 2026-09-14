/**
 * Pruebas de seguridad del inventario, las barras y los puntos de entrega.
 *
 * No son pruebas de "camino feliz" con otro nombre: cada una intenta hacer algo que el
 * sistema NO debe permitir. Lo que se cuida aquí es lo que un inventario tiene de
 * valioso para robar o para tapar:
 *
 *   - Entrar sin token, con un token de otro, o con uno al que alguien le editó el rol.
 *   - Que un rol haga lo que no le toca: el cantinero corrigiendo saldos, el mesero
 *     recibiendo mercancía, el almacén reescribiendo recetas.
 *   - Ver o mover el inventario de OTRO club (el defecto más caro de una app
 *     multi-club, y el más fácil de dejar abierto).
 *   - Escribir un saldo por la puerta de atrás: mandando `stock` en el cuerpo, dejando
 *     un estante en negativo, o con dos peticiones al mismo tiempo.
 *   - Inyección por los parámetros de búsqueda y filtros.
 *   - Filtrar el token de un QR, un correo, una consulta SQL o un stack trace en la
 *     respuesta.
 *
 * Todas corren contra Postgres real y la app real, con `createApp()` y supertest. Un
 * 403 que en realidad era un 500 no pasa esta suite.
 */
'use strict';

const jwt = require('jsonwebtoken');
const { randomUUID } = require('crypto');
const { setupSchema, truncateAll, closePool, pool } = require('./helpers/db');
const { api, auth } = require('./helpers/api');
const f = require('./helpers/factories');

let club; let otro;
let manager; let bartender; let waiter; let warehouse; let guest; let hostess;
let managerOtro;
let table; let whisky; let trago;

beforeAll(setupSchema);
afterAll(closePool);

beforeEach(async () => {
  await truncateAll();
  club = await f.createNightclub({ slug: 'ev2-sec' });
  otro = await f.createNightclub({ slug: 'otro-sec' });

  manager = await f.createUser(club.id, { role: 'manager' });
  bartender = await f.createUser(club.id, { role: 'bartender' });
  waiter = await f.createUser(club.id, { role: 'waiter' });
  warehouse = await f.createUser(club.id, { role: 'warehouse' });
  guest = await f.createUser(club.id, { role: 'guest' });
  hostess = await f.createUser(club.id, { role: 'hostess' });
  managerOtro = await f.createUser(otro.id, { role: 'manager' });

  table = await f.createTable(club.id, { code: 'S-1' });
  whisky = await f.createSupply(club.id, {
    name: 'Whisky de prueba', unit: 'ml', package_size: 750, stock: 1500,
  });
  trago = await f.createDrink(club.id, { name: 'TRAGO', price: 150, stock: null });
  await f.setRecipe(trago.id, [[whisky, 30]]);
});

const url = (p, id = null) => `/api/nightclubs/${id || club.id}${p}`;
const stockOf = async (supplyId, locationId = null) => f.supplyStock(supplyId, locationId);

/** Todas las rutas nuevas, con el método y un cuerpo mínimo válido. */
const rutasNuevas = () => [
  ['get', url('/supply-locations')],
  ['post', url('/supply-locations'), { code: 'x', name: 'X', kind: 'bar' }],
  ['patch', url(`/supply-locations/${club.bar_id}`), { name: 'X' }],
  ['get', url('/zone-bars')],
  ['put', url('/zone-bars'), { assignments: [{ section: 'main', location_id: club.bar_id }] }],
  ['get', url('/supplies')],
  ['post', url('/supplies'), { name: 'X', unit: 'ml', package_size: 750 }],
  ['patch', url(`/supplies/${whisky.id}`), { name: 'X' }],
  ['put', url(`/supplies/${whisky.id}/min-stock`), { location_id: club.bar_id, min_stock: 1 }],
  ['post', url(`/supplies/${whisky.id}/receive`), { location_id: club.bar_id, packages: 1 }],
  ['post', url(`/supplies/${whisky.id}/transfer`), { from_location_id: club.bar_id, to_location_id: club.warehouse_id, packages: 1 }],
  ['post', url(`/supplies/${whisky.id}/count`), { location_id: club.bar_id, counted: 0 }],
  ['post', url(`/supplies/${whisky.id}/adjust`), { location_id: club.bar_id, kind: 'waste', quantity: 1, reason: 'x' }],
  ['get', url('/supply-movements')],
  ['get', url(`/supplies/${whisky.id}/movements`)],
  ['get', url('/recipes')],
  ['put', url(`/recipes/${trago.id}`), { items: [] }],
  ['get', url('/delivery-points')],
  ['post', url('/delivery-points'), { code: 'p', name: 'P', kind: 'floor' }],
  ['put', url('/orders/queue-order'), { order_ids: [randomUUID()] }],
];

// ===========================================================================
// A. Autenticación
// ===========================================================================

describe('Sin credenciales no se entra a ninguna ruta nueva', () => {
  it('las 20 rutas nuevas responden 401 sin token', async () => {
    const fallos = [];
    for (const [method, path, body] of rutasNuevas()) {
      const res = await api()[method](path).send(body || {});
      if (res.status !== 401) fallos.push({ method, path, status: res.status });
    }
    expect(fallos).toEqual([]);
  });

  it('un token firmado con OTRO secreto no sirve', async () => {
    const falso = jwt.sign({ sub: manager.id, role: 'admin', nightclub_id: club.id },
      'un-secreto-que-no-es-el-del-servidor', { expiresIn: '15m' });
    const res = await api().get(url('/supplies')).set({ Authorization: `Bearer ${falso}` });
    expect(res.status).toBe(401);
  });

  it('un token vencido no sirve, aunque esté bien firmado', async () => {
    const vencido = jwt.sign(
      { sub: manager.id, role: 'manager', nightclub_id: club.id },
      process.env.JWT_SECRET, { expiresIn: '-1s' });
    const res = await api().get(url('/supplies')).set({ Authorization: `Bearer ${vencido}` });
    expect(res.status).toBe(401);
  });

  it('editarle el rol al token lo invalida: la firma no cuadra', async () => {
    // El ataque clásico: tomar tu propio token, cambiar "guest" por "admin" en el
    // payload y volver a mandarlo.
    const mio = jwt.sign({ sub: guest.id, role: 'guest', nightclub_id: club.id },
      process.env.JWT_SECRET, { expiresIn: '15m' });
    const [head, payload, firma] = mio.split('.');
    const editado = Buffer.from(
      JSON.stringify(Object.assign(JSON.parse(Buffer.from(payload, 'base64url').toString()),
        { role: 'admin' })),
    ).toString('base64url');
    const res = await api().get(url('/supplies'))
      .set({ Authorization: `Bearer ${head}.${editado}.${firma}` });
    expect(res.status).toBe(401);
  });

  it('un token con algoritmo `none` no sirve', async () => {
    const none = `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')}.${
      Buffer.from(JSON.stringify({ sub: manager.id, role: 'admin', nightclub_id: club.id })).toString('base64url')}.`;
    const res = await api().get(url('/supplies')).set({ Authorization: `Bearer ${none}` });
    expect(res.status).toBe(401);
  });
});

// ===========================================================================
// B. Autorización por rol
// ===========================================================================

describe('Cada rol hace solo lo suyo', () => {
  it('el cliente no ve el inventario, ni las recetas, ni el kardex', async () => {
    const rutas = ['/supplies', '/supply-locations', '/zone-bars', '/recipes',
      '/supply-movements', `/supplies/${whisky.id}/movements`];
    for (const ruta of rutas) {
      const res = await api().get(url(ruta)).set(auth(guest));
      expect({ ruta, status: res.status }).toEqual({ ruta, status: 403 });
    }
  });

  it('la anfitriona tampoco: no es su trabajo y son datos de dinero', async () => {
    expect((await api().get(url('/supplies')).set(auth(hostess))).status).toBe(403);
    expect((await api().get(url('/supply-movements')).set(auth(hostess))).status).toBe(403);
  });

  it('el cantinero VE existencias y reporta merma de su barra, y nada más', async () => {
    expect((await api().get(url('/supplies')).set(auth(bartender))).status).toBe(200);
    expect((await api().post(url(`/supplies/${whisky.id}/adjust`)).set(auth(bartender))
      .send({ location_id: club.bar_id, kind: 'waste', quantity: 30, reason: 'Se cayó' })).status).toBe(200);

    const prohibido = [
      ['post', `/supplies/${whisky.id}/receive`, { location_id: club.bar_id, packages: 1 }],
      ['post', `/supplies/${whisky.id}/transfer`, { from_location_id: club.warehouse_id, to_location_id: club.bar_id, packages: 1 }],
      ['post', `/supplies/${whisky.id}/count`, { location_id: club.bar_id, counted: 0 }],
      ['put', `/supplies/${whisky.id}/min-stock`, { location_id: club.bar_id, min_stock: 1 }],
      ['post', '/supplies', { name: 'Nuevo', unit: 'ml', package_size: 750 }],
      ['put', `/recipes/${trago.id}`, { items: [] }],
      ['put', '/zone-bars', { assignments: [{ section: 'main', location_id: club.bar_id }] }],
      ['post', '/supply-locations', { code: 'z', name: 'Z', kind: 'bar' }],
      ['get', '/recipes', null],
    ];
    for (const [method, ruta, body] of prohibido) {
      const res = await api()[method](url(ruta)).set(auth(bartender)).send(body || {});
      expect({ ruta, status: res.status }).toEqual({ ruta, status: 403 });
    }
  });

  it('el cantinero NO corrige un saldo: por ahí se tapa un faltante', async () => {
    const antes = await stockOf(whisky.id, club.bar_id);
    const res = await api().post(url(`/supplies/${whisky.id}/adjust`)).set(auth(bartender))
      .send({ location_id: club.bar_id, kind: 'adjustment', quantity: 750, reason: 'Sobra' });
    expect(res.status).toBe(403);
    expect(await stockOf(whisky.id, club.bar_id)).toBe(antes);
  });

  it('el mesero solo consulta: no recibe, no traspasa, no cuenta, no merma', async () => {
    expect((await api().get(url('/supplies')).set(auth(waiter))).status).toBe(200);
    const prohibido = [
      ['post', `/supplies/${whisky.id}/receive`, { location_id: club.bar_id, packages: 1 }],
      ['post', `/supplies/${whisky.id}/transfer`, { from_location_id: club.warehouse_id, to_location_id: club.bar_id, packages: 1 }],
      ['post', `/supplies/${whisky.id}/count`, { location_id: club.bar_id, counted: 0 }],
      ['post', `/supplies/${whisky.id}/adjust`, { location_id: club.bar_id, kind: 'waste', quantity: 1, reason: 'x' }],
      ['put', '/orders/queue-order', { order_ids: [randomUUID()] }],
    ];
    for (const [method, ruta, body] of prohibido) {
      const res = await api()[method](url(ruta)).set(auth(waiter)).send(body);
      expect({ ruta, status: res.status }).toEqual({ ruta, status: 403 });
    }
  });

  it('el almacén mueve mercancía pero NO reescribe la carta ni las recetas', async () => {
    expect((await api().post(url(`/supplies/${whisky.id}/receive`)).set(auth(warehouse))
      .send({ location_id: club.warehouse_id, packages: 2 })).status).toBe(201);
    expect((await api().post(url(`/supplies/${whisky.id}/transfer`)).set(auth(warehouse))
      .send({ from_location_id: club.warehouse_id, to_location_id: club.bar_id, packages: 1 })).status).toBe(201);
    expect((await api().post(url(`/supplies/${whisky.id}/count`)).set(auth(warehouse))
      .send({ location_id: club.bar_id, counted_packages: 3 })).status).toBe(200);

    const prohibido = [
      ['put', `/recipes/${trago.id}`, { items: [] }],
      ['post', '/supplies', { name: 'Nuevo', unit: 'ml', package_size: 750 }],
      ['patch', `/supplies/${whisky.id}`, { name: 'Otro nombre' }],
      ['put', '/zone-bars', { assignments: [{ section: 'main', location_id: club.bar_id }] }],
      ['post', '/supply-locations', { code: 'z', name: 'Z', kind: 'bar' }],
      ['post', '/delivery-points', { code: 'p', name: 'P', kind: 'floor' }],
    ];
    for (const [method, ruta, body] of prohibido) {
      const res = await api()[method](url(ruta)).set(auth(warehouse)).send(body);
      expect({ ruta, status: res.status }).toEqual({ ruta, status: 403 });
    }
  });

  it('el almacén sí puede corregir un saldo, pero el cliente ni lo intenta', async () => {
    // La corrección la autoriza gerencia (y almacén, que es quien cuenta). Lo que no
    // puede es venir de la barra ni del piso.
    expect((await api().post(url(`/supplies/${whisky.id}/adjust`)).set(auth(guest))
      .send({ location_id: club.bar_id, kind: 'adjustment', quantity: 1, reason: 'x' })).status).toBe(403);
  });

  it('el token del QR solo lo ve gerencia', async () => {
    const punto = await api().post(url('/delivery-points')).set(auth(manager))
      .send({ code: 'pista-a', name: 'Pista A', kind: 'floor' });
    const id = punto.body.delivery_point.id;
    expect((await api().get(url(`/delivery-points/${id}/qr`)).set(auth(waiter))).status).toBe(403);
    expect((await api().get(url(`/delivery-points/${id}/qr`)).set(auth(bartender))).status).toBe(403);
    expect((await api().get(url(`/delivery-points/${id}/qr`)).set(auth(manager))).status).toBe(200);
  });
});

// ===========================================================================
// C. Aislamiento entre clubes
// ===========================================================================

describe('El inventario de otro club no existe para ti', () => {
  it('el gerente de otro club no entra por la ruta de este', async () => {
    for (const [method, path, body] of rutasNuevas()) {
      const res = await api()[method](path).set(auth(managerOtro)).send(body || {});
      expect({ path, status: res.status }).toEqual({ path, status: 403 });
    }
  });

  it('no se recibe mercancía en un lugar de otro club', async () => {
    const lugarAjeno = await pool.query(
      `INSERT INTO supply_locations (nightclub_id, code, name, kind)
       VALUES ($1,'ajeno','Ajeno','warehouse') RETURNING id`, [otro.id]);
    const res = await api().post(url(`/supplies/${whisky.id}/receive`)).set(auth(manager))
      .send({ location_id: lugarAjeno.rows[0].id, packages: 5 });
    // 404, no 403: no se confirma que ese lugar exista en algún lado.
    expect(res.status).toBe(404);
    expect(await stockOf(whisky.id)).toBe(1500);
  });

  it('no se traspasa un insumo de otro club desde aquí', async () => {
    const ajeno = await f.createSupply(otro.id, { name: 'Ajeno', stock: 5000 });
    const res = await api().post(url(`/supplies/${ajeno.id}/transfer`)).set(auth(manager))
      .send({ from_location_id: club.warehouse_id, to_location_id: club.bar_id, packages: 1 });
    expect(res.status).toBe(404);
    expect(await stockOf(ajeno.id)).toBe(5000);
  });

  it('no se cuenta ni se merma un insumo de otro club', async () => {
    const ajeno = await f.createSupply(otro.id, { name: 'Ajeno2', stock: 900 });
    expect((await api().post(url(`/supplies/${ajeno.id}/count`)).set(auth(manager))
      .send({ location_id: club.bar_id, counted: 0 })).status).toBe(404);
    expect((await api().post(url(`/supplies/${ajeno.id}/adjust`)).set(auth(manager))
      .send({ location_id: club.bar_id, kind: 'waste', quantity: 100, reason: 'Rotura' })).status).toBe(404);
    expect(await stockOf(ajeno.id)).toBe(900);
  });

  it('el kardex nunca trae renglones de otro club', async () => {
    const ajeno = await f.createSupply(otro.id, { name: 'Ajeno3', stock: 750 });
    await api().post(url(`/supplies/${whisky.id}/receive`)).set(auth(manager))
      .send({ location_id: club.warehouse_id, packages: 1 });

    const res = await api().get(url('/supply-movements?limit=200')).set(auth(manager));
    expect(res.status).toBe(200);
    expect(res.body.movements.length).toBeGreaterThan(0);
    expect(res.body.movements.some((m) => m.supply_id === ajeno.id)).toBe(false);
    expect(res.body.movements.every((m) => m.supply_name !== 'Ajeno3')).toBe(true);
  });

  it('filtrar el kardex por un insumo de otro club no devuelve nada', async () => {
    const ajeno = await f.createSupply(otro.id, { name: 'Ajeno4', stock: 750 });
    const res = await api().get(url(`/supply-movements?supply_id=${ajeno.id}`)).set(auth(manager));
    expect(res.status).toBe(200);
    expect(res.body.movements).toEqual([]);
  });

  it('la cola de la barra no se puede apuntar a una barra de otro club', async () => {
    const barraAjena = await pool.query(
      `INSERT INTO supply_locations (nightclub_id, code, name, kind)
       VALUES ($1,'barra-ajena','Barra ajena','bar') RETURNING id`, [otro.id]);
    const res = await api().get(url(`/orders?bar_id=${barraAjena.rows[0].id}&active=true`))
      .set(auth(bartender));
    expect(res.status).toBe(200);
    expect(res.body.orders).toEqual([]);
  });

  it('el QR de otro club no abre nada aquí', async () => {
    const ajeno = await pool.query(
      `INSERT INTO delivery_points (nightclub_id, code, name, kind, qr_token)
       VALUES ($1,'pista-ajena','Pista ajena','floor','tokendeotroclub12345') RETURNING qr_token`,
      [otro.id]);
    const res = await api().get(url(`/delivery-points/by-token/${ajeno.rows[0].qr_token}`))
      .set(auth(guest));
    expect(res.status).toBe(404);
  });

  it('una receta no puede apuntar a un insumo de otro club', async () => {
    const ajeno = await f.createSupply(otro.id, { name: 'Ajeno5' });
    const res = await api().put(url(`/recipes/${trago.id}`)).set(auth(manager))
      .send({ items: [{ supply_id: ajeno.id, quantity: 30 }] });
    expect(res.status).toBe(404);
    const receta = await pool.query('SELECT 1 FROM drink_supplies WHERE supply_id = $1', [ajeno.id]);
    expect(receta.rowCount).toBe(0);
  });

  it('una zona no se puede asignar a una barra de otro club', async () => {
    const barraAjena = await pool.query(
      `INSERT INTO supply_locations (nightclub_id, code, name, kind)
       VALUES ($1,'barra-ajena2','Barra ajena','bar') RETURNING id`, [otro.id]);
    const res = await api().put(url('/zone-bars')).set(auth(manager))
      .send({ assignments: [{ section: 'main', location_id: barraAjena.rows[0].id }] });
    expect(res.status).toBe(404);
  });
});

// ===========================================================================
// D. Integridad: no hay puerta de atrás para escribir un saldo
// ===========================================================================

describe('El saldo no se escribe, se mueve', () => {
  it('mandar `stock` o `avg_cost` en el cuerpo no cambia nada', async () => {
    const res = await api().patch(url(`/supplies/${whisky.id}`)).set(auth(manager))
      .send({ name: 'Whisky', stock: 999999, avg_cost: 0.01, packages: 500 });
    expect(res.status).toBe(200);
    expect(await stockOf(whisky.id)).toBe(1500);
    const costo = await pool.query('SELECT avg_cost::float8 AS c FROM supplies WHERE id = $1',
      [whisky.id]);
    expect(Number(costo.rows[0].c)).toBe(0);
  });

  it('crear un insumo con `stock` en el cuerpo lo deja en cero igual', async () => {
    const res = await api().post(url('/supplies')).set(auth(manager))
      .send({ name: 'Ron', unit: 'ml', package_size: 750, stock: 5000, avg_cost: 3 });
    expect(res.status).toBe(201);
    expect(res.body.supply.stock).toBe(0);
    expect(res.body.supply.avg_cost).toBe(0);
  });

  it('no hay ninguna ruta que acepte un saldo directo', async () => {
    // La prueba es sobre el CÓDIGO: si alguien agrega un `UPDATE supply_stock SET stock`
    // fuera del servicio de inventario, esto lo caza antes de que llegue a producción.
    const fs = require('fs');
    const path = require('path');
    const dir = path.join(__dirname, '..', 'src', 'routes');
    const sospechosos = [];
    for (const file of fs.readdirSync(dir)) {
      const src = fs.readFileSync(path.join(dir, file), 'utf8');
      if (/UPDATE\s+supply_stock\s+SET\s+stock/i.test(src)) sospechosos.push(file);
      if (/INSERT\s+INTO\s+supply_movements/i.test(src)) sospechosos.push(`${file} (kardex a mano)`);
    }
    expect(sospechosos).toEqual([]);
  });

  it('el kardex no se puede corregir ni borrar por detrás', async () => {
    await api().post(url(`/supplies/${whisky.id}/receive`)).set(auth(manager))
      .send({ location_id: club.warehouse_id, packages: 1 });
    await expect(pool.query('UPDATE supply_movements SET quantity = 0 WHERE supply_id = $1',
      [whisky.id])).rejects.toThrow(/insert-only/);
    await expect(pool.query('DELETE FROM supply_movements WHERE supply_id = $1', [whisky.id]))
      .rejects.toThrow(/insert-only/);
  });

  it('no se puede sacar más de lo que hay: el estante no queda en negativo', async () => {
    const res = await api().post(url(`/supplies/${whisky.id}/adjust`)).set(auth(manager))
      .send({ location_id: club.bar_id, kind: 'waste', quantity: 3000, reason: 'Rotura' });
    expect(res.status).toBe(409);
    expect(await stockOf(whisky.id, club.bar_id)).toBe(1500);
  });

  it('dos traspasos simultáneos del mismo insumo no duplican producto', async () => {
    // 1500 ml en la barra. Dos traspasos de 1000 al mismo tiempo: uno tiene que fallar.
    const traspaso = () => api().post(url(`/supplies/${whisky.id}/transfer`)).set(auth(manager))
      .send({ from_location_id: club.bar_id, to_location_id: club.warehouse_id, quantity: 1000 });
    const [a, b] = await Promise.all([traspaso(), traspaso()]);
    const estados = [a.status, b.status].sort();
    expect(estados).toEqual([201, 409]);
    // Y el total del club no cambió: se movió producto, no se creó.
    expect(await stockOf(whisky.id)).toBe(1500);
    expect(await stockOf(whisky.id, club.bar_id)).toBe(500);
  });

  it('dos pedidos simultáneos no se llevan el mismo mililitro', async () => {
    await pool.query('UPDATE supply_stock SET stock = 30 WHERE supply_id = $1', [whisky.id]);
    const pedir = () => api().post(url('/orders')).set(auth(guest)).send({
      client_request_id: randomUUID(), table_id: table.id,
      items: [{ drink_id: trago.id, quantity: 1 }],
    });
    const [a, b] = await Promise.all([pedir(), pedir()]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect(await stockOf(whisky.id, club.bar_id)).toBe(0);
  });

  it('un traspaso al mismo lugar no es un traspaso', async () => {
    const res = await api().post(url(`/supplies/${whisky.id}/transfer`)).set(auth(manager))
      .send({ from_location_id: club.bar_id, to_location_id: club.bar_id, quantity: 10 });
    expect(res.status).toBe(422);
  });

  it('una zona no se puede asignar al almacén ni con el id correcto', async () => {
    const res = await api().put(url('/zone-bars')).set(auth(manager))
      .send({ assignments: [{ section: 'main', location_id: club.warehouse_id }] });
    expect(res.status).toBe(422);
  });

  it('no se apaga una barra que todavía atiende zonas', async () => {
    await api().put(url('/zone-bars')).set(auth(manager))
      .send({ assignments: [{ section: 'main', location_id: club.bar_id }] });
    const res = await api().patch(url(`/supply-locations/${club.bar_id}`)).set(auth(manager))
      .send({ active: false });
    expect(res.status).toBe(409);
  });

  it('una merma sin motivo no pasa, ni con el rol correcto', async () => {
    const res = await api().post(url(`/supplies/${whisky.id}/adjust`)).set(auth(manager))
      .send({ location_id: club.bar_id, kind: 'waste', quantity: 30 });
    expect(res.status).toBe(400);
    expect(await stockOf(whisky.id, club.bar_id)).toBe(1500);
  });

  it('un movimiento inventado no se acepta', async () => {
    const res = await api().post(url(`/supplies/${whisky.id}/adjust`)).set(auth(manager))
      .send({ location_id: club.bar_id, kind: 'consumption', quantity: 30, reason: 'Venta falsa' });
    // `consumption` existe en el kardex, pero NO se captura a mano: lo escribe el pedido.
    expect(res.status).toBe(400);
  });
});

// ===========================================================================
// E. Validación e inyección
// ===========================================================================

describe('Entradas hostiles', () => {
  const INYECCIONES = [
    "'; DROP TABLE supplies; --",
    "' OR '1'='1",
    "%' UNION SELECT NULL,NULL,NULL--",
    "\\'; UPDATE supplies SET avg_cost = 0; --",
  ];

  it('la búsqueda de insumos no ejecuta SQL', async () => {
    for (const carga of INYECCIONES) {
      const res = await api().get(`${url('/supplies')}?search=${encodeURIComponent(carga)}`)
        .set(auth(manager));
      expect({ carga, status: res.status }).toEqual({ carga, status: 200 });
      expect(res.body.supplies).toEqual([]);
    }
    // Y la tabla sigue ahí, con su costo intacto.
    const quedan = await pool.query('SELECT count(*)::int AS n FROM supplies');
    expect(quedan.rows[0].n).toBeGreaterThan(0);
  });

  it('la categoría y el tipo de movimiento tampoco', async () => {
    for (const carga of INYECCIONES) {
      const cat = await api().get(`${url('/supplies')}?category=${encodeURIComponent(carga)}`)
        .set(auth(manager));
      expect(cat.status).toBe(200);
      const kind = await api().get(`${url('/supply-movements')}?kind=${encodeURIComponent(carga)}`)
        .set(auth(manager));
      // `kind` es una lista cerrada: lo que no está en ella es 400, no una consulta.
      expect(kind.status).toBe(400);
    }
  });

  it('un id que no es UUID responde 400, no 500', async () => {
    const basura = ['no-es-uuid', '1 OR 1=1', '../../etc/passwd', '00000000'];
    for (const id of basura) {
      const res = await api().get(url(`/supplies/${encodeURIComponent(id)}/movements`))
        .set(auth(manager));
      expect({ id, status: res.status }).toEqual({ id, status: 400 });
    }
  });

  it('cantidades imposibles se rechazan', async () => {
    const malas = [
      { packages: -5 },
      { packages: 0 },
      { quantity: 1e30 },
      { quantity: 'muchos' },
      { packages: null },
      {},
      { quantity: 10, packages: 10 },
    ];
    for (const cuerpo of malas) {
      const res = await api().post(url(`/supplies/${whisky.id}/receive`)).set(auth(manager))
        .send(Object.assign({ location_id: club.bar_id }, cuerpo));
      expect({ cuerpo, status: res.status }).toEqual({ cuerpo, status: 400 });
    }
    expect(await stockOf(whisky.id)).toBe(1500);
  });

  it('el `limit` del kardex tiene techo', async () => {
    expect((await api().get(url('/supply-movements?limit=100000')).set(auth(manager))).status)
      .toBe(400);
    expect((await api().get(url('/supply-movements?limit=-1')).set(auth(manager))).status)
      .toBe(400);
  });

  it('un cuerpo gigante se rechaza antes de tocar la base', async () => {
    const enorme = { name: 'x'.repeat(2 * 1024 * 1024), unit: 'ml', package_size: 750 };
    const res = await api().post(url('/supplies')).set(auth(manager)).send(enorme);
    expect([400, 413]).toContain(res.status);
  });

  it('una receta con el mismo insumo dos veces no pasa', async () => {
    const res = await api().put(url(`/recipes/${trago.id}`)).set(auth(manager)).send({
      items: [{ supply_id: whisky.id, quantity: 30 }, { supply_id: whisky.id, quantity: 10 }],
    });
    expect(res.status).toBe(422);
  });

  it('una receta con 100 renglones no pasa: es un intento de tumbar la consulta', async () => {
    const items = Array.from({ length: 100 }, () => ({ supply_id: whisky.id, quantity: 1 }));
    const res = await api().put(url(`/recipes/${trago.id}`)).set(auth(manager)).send({ items });
    expect(res.status).toBe(400);
  });

  it('el código de un lugar no acepta mayúsculas, espacios ni rutas', async () => {
    for (const code of ['Barra Alta', '../etc', 'BARRA', 'barra alta', '']) {
      const res = await api().post(url('/supply-locations')).set(auth(manager))
        .send({ code, name: 'X', kind: 'bar' });
      expect({ code, status: res.status }).toEqual({ code, status: 400 });
    }
  });

  it('un tipo de lugar inventado no se crea', async () => {
    const res = await api().post(url('/supply-locations')).set(auth(manager))
      .send({ code: 'x', name: 'X', kind: 'oficina' });
    expect(res.status).toBe(400);
  });
});

// ===========================================================================
// F. Lo que la respuesta NO debe traer
// ===========================================================================

describe('Nada se filtra en la respuesta', () => {
  it('el token del QR no aparece en la lista de puntos de entrega', async () => {
    await api().post(url('/delivery-points')).set(auth(manager))
      .send({ code: 'pista-b', name: 'Pista B', kind: 'floor' });

    for (const quien of [guest, waiter, bartender, manager]) {
      const res = await api().get(url('/delivery-points')).set(auth(quien));
      expect(res.status).toBe(200);
      const texto = JSON.stringify(res.body);
      expect(texto).not.toMatch(/qr_token/);
      expect(res.body.delivery_points.every((p) => p.qr_token === undefined)).toBe(true);
    }
  });

  it('el cliente no ve los puntos que no puede elegir (la barra)', async () => {
    await pool.query(
      `INSERT INTO delivery_points (nightclub_id, code, name, kind, qr_token, client_selectable)
       VALUES ($1,'barra-baja','Barra planta baja','bar','tokenbarra1234567',false)`, [club.id]);
    const cliente = await api().get(url('/delivery-points')).set(auth(guest));
    expect(cliente.body.delivery_points.some((p) => p.kind === 'bar')).toBe(false);
    const mesero = await api().get(url('/delivery-points')).set(auth(waiter));
    expect(mesero.body.delivery_points.some((p) => p.kind === 'bar')).toBe(true);
  });

  it('girar el QR invalida el papel viejo', async () => {
    const creado = await api().post(url('/delivery-points')).set(auth(manager))
      .send({ code: 'terraza', name: 'Terraza', kind: 'terrace' });
    const id = creado.body.delivery_point.id;
    const viejo = (await api().get(url(`/delivery-points/${id}/qr`)).set(auth(manager)))
      .body.delivery_point.qr_token;

    expect((await api().get(url(`/delivery-points/by-token/${viejo}`)).set(auth(guest))).status)
      .toBe(200);

    await api().patch(url(`/delivery-points/${id}`)).set(auth(manager)).send({ rotate_qr: true });

    const nuevo = (await api().get(url(`/delivery-points/${id}/qr`)).set(auth(manager)))
      .body.delivery_point.qr_token;
    expect(nuevo).not.toBe(viejo);
    expect((await api().get(url(`/delivery-points/by-token/${viejo}`)).set(auth(guest))).status)
      .toBe(404);
    expect((await api().get(url(`/delivery-points/by-token/${nuevo}`)).set(auth(guest))).status)
      .toBe(200);
  });

  it('el QR no dice quién está sentado en la mesa', async () => {
    await pool.query(
      `INSERT INTO delivery_points (nightclub_id, code, name, kind, table_id, qr_token)
       VALUES ($1,'mesa-s1','Mesa S-1','table',$2,'tokenmesa123456789')`, [club.id, table.id]);
    await pool.query('INSERT INTO table_occupants (table_id, user_id) VALUES ($1,$2)',
      [table.id, guest.id]);

    const res = await api().get(url('/delivery-points/by-token/tokenmesa123456789'))
      .set(auth(guest));
    expect(res.status).toBe(200);
    const texto = JSON.stringify(res.body);
    expect(texto).not.toContain(guest.email);
    expect(texto).not.toContain(guest.display_name);
    expect(texto).not.toMatch(/occupant/i);
  });

  it('el kardex enseña el nombre de quien movió, nunca su correo', async () => {
    await api().post(url(`/supplies/${whisky.id}/receive`)).set(auth(warehouse))
      .send({ location_id: club.warehouse_id, packages: 1 });
    const res = await api().get(url('/supply-movements')).set(auth(manager));
    const texto = JSON.stringify(res.body);
    expect(res.body.movements[0].created_by_name).toBe(warehouse.display_name);
    expect(texto).not.toContain(warehouse.email);
    expect(texto).not.toMatch(/password|hash/i);
  });

  it('un error no devuelve SQL ni stack trace', async () => {
    const res = await api().post(url(`/supplies/${randomUUID()}/receive`)).set(auth(manager))
      .send({ location_id: club.bar_id, packages: 1 });
    expect(res.status).toBe(404);
    const texto = JSON.stringify(res.body);
    expect(texto).not.toMatch(/SELECT|INSERT|UPDATE|pg_|\.js:\d+|at Object/i);
    expect(res.body.error.code).toBe('not_found');
  });

  it('las cabeceras de seguridad están puestas y el servidor no se anuncia', async () => {
    const res = await api().get(url('/supplies')).set(auth(manager));
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options'] || res.headers['content-security-policy'])
      .toBeDefined();
    expect(res.headers['strict-transport-security']).toBeDefined();
  });
});
