/**
 * Proveedores y entrada de mercancía en lote.
 *
 * Lo que se prueba aquí no es "que se pueda capturar una entrada" — eso ya lo hacía
 * la ruta de un solo insumo. Es lo que esa ruta NO podía garantizar:
 *
 *   1. El lote entra COMPLETO o no entra. Una línea mala no puede dejar ocho
 *      renglones adentro y siete afuera: eso es un inventario que miente, y nadie
 *      se enteraría hasta contar el estante a mano.
 *   2. El costo es POR LÍNEA, y cada línea mueve el promedio de SU insumo. Repartir
 *      un total daría un promedio que no corresponde a ningún precio real.
 *   3. Un insumo repetido en el mismo lote se rechaza: es el mismo renglón capturado
 *      dos veces, y aceptarlo duplica la entrada en silencio.
 *   4. Los proveedores no se duplican por mayúsculas. Sin eso, "cuánto le compro a
 *      Corona" deja de tener respuesta, que es para lo que existe el catálogo.
 */
'use strict';

const { setupSchema, truncateAll, closePool, pool } = require('./helpers/db');
const { api, auth } = require('./helpers/api');
const f = require('./helpers/factories');

let club;
let warehouse;
let manager;
let almacenista;
let bartender;

beforeAll(async () => {
  await setupSchema();
});
beforeEach(async () => {
  await truncateAll();
  club = await f.createNightclub({ slug: 'ev2-receiving' });
  warehouse = club.warehouse_id;
  manager = await f.createUser(club.id, { role: 'manager' });
  almacenista = await f.createUser(club.id, { role: 'warehouse' });
  bartender = await f.createUser(club.id, { role: 'bartender' });
});
afterAll(closePool);

const url = (path) => `/api/nightclubs/${club.id}${path}`;

async function crearProveedor(over = {}) {
  const res = await api().post(url('/suppliers')).set(auth(manager))
    .send({ name: 'Distribuidora Corona', ...over });
  expect(res.status).toBe(201);
  return res.body.supplier;
}

// ===========================================================================
// El catálogo de proveedores
// ===========================================================================

describe('proveedores', () => {
  it('se da de alta y aparece en la lista', async () => {
    const proveedor = await crearProveedor({
      name: 'Casa Cuervo', contact_name: 'Luis', phone: '6311234567',
    });
    expect(proveedor).toMatchObject({ name: 'Casa Cuervo', contact_name: 'Luis', active: true });

    const lista = await api().get(url('/suppliers')).set(auth(almacenista));
    expect(lista.status).toBe(200);
    expect(lista.body.suppliers).toHaveLength(1);
  });

  it('NO se duplica por mayúsculas ni espacios', async () => {
    await crearProveedor({ name: 'Corona SA' });

    for (const nombre of ['corona sa', 'CORONA SA', '  Corona SA  ']) {
      const res = await api().post(url('/suppliers')).set(auth(manager)).send({ name: nombre });
      expect(res.status).toBe(409);
      expect(res.body.error.message).toMatch(/ya existe/i);
    }
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM suppliers');
    expect(rows[0].n).toBe(1);
  });

  it('el almacén ve la lista pero NO da de alta', async () => {
    expect((await api().get(url('/suppliers')).set(auth(almacenista))).status).toBe(200);
    // Un proveedor nuevo es una decisión de compras. Quien recibe mercancía no
    // debería poder inventarse el origen de una caja para justificarla.
    const res = await api().post(url('/suppliers')).set(auth(almacenista))
      .send({ name: 'Inventado' });
    expect(res.status).toBe(403);
  });

  it('el cantinero no ve el catálogo de compras', async () => {
    expect((await api().get(url('/suppliers')).set(auth(bartender))).status).toBe(403);
  });

  it('se apaga en vez de borrarse, y deja de salir en la lista de captura', async () => {
    const proveedor = await crearProveedor();
    const apagado = await api().patch(url(`/suppliers/${proveedor.id}`)).set(auth(manager))
      .send({ active: false });
    expect(apagado.status).toBe(200);
    expect(apagado.body.supplier.active).toBe(false);

    const normal = await api().get(url('/suppliers')).set(auth(almacenista));
    expect(normal.body.suppliers).toHaveLength(0);

    const conApagados = await api().get(url('/suppliers')).query({ include_inactive: 'true' })
      .set(auth(almacenista));
    expect(conApagados.body.suppliers).toHaveLength(1);

    // Y sigue en la base: su historial de compras no se puede quedar huérfano.
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM suppliers');
    expect(rows[0].n).toBe(1);
  });

  it('se busca por nombre y por contacto', async () => {
    await crearProveedor({ name: 'Casa Cuervo', contact_name: 'Luis Mendez' });
    await crearProveedor({ name: 'Bacardi', contact_name: 'Ana' });

    const porNombre = await api().get(url('/suppliers')).query({ search: 'cuervo' })
      .set(auth(almacenista));
    expect(porNombre.body.suppliers.map((p) => p.name)).toEqual(['Casa Cuervo']);

    const porContacto = await api().get(url('/suppliers')).query({ search: 'Mendez' })
      .set(auth(almacenista));
    expect(porContacto.body.suppliers.map((p) => p.name)).toEqual(['Casa Cuervo']);
  });

  it('un proveedor de otro club no se ve ni se edita', async () => {
    const otro = await f.createNightclub({ slug: 'otro-club', name: 'Otro' });
    const ajeno = await pool.query(
      'INSERT INTO suppliers (nightclub_id, name) VALUES ($1,$2) RETURNING id',
      [otro.id, 'Ajeno']);

    const ver = await api().get(url(`/suppliers/${ajeno.rows[0].id}`)).set(auth(manager));
    expect(ver.status).toBe(404);
    const editar = await api().patch(url(`/suppliers/${ajeno.rows[0].id}`)).set(auth(manager))
      .send({ name: 'Robado' });
    expect(editar.status).toBe(404);
  });

  it('un PATCH vacío se rechaza en vez de hacer un UPDATE sin columnas', async () => {
    const proveedor = await crearProveedor();
    const res = await api().patch(url(`/suppliers/${proveedor.id}`)).set(auth(manager)).send({});
    expect(res.status).toBe(400);
  });
});

// ===========================================================================
// Quién surte qué
// ===========================================================================

describe('qué insumos surte cada proveedor', () => {
  it('se asigna la lista completa de una vez', async () => {
    const proveedor = await crearProveedor();
    const whisky = await f.createSupply(club.id, { name: 'Buchanans 12' });
    const ron = await f.createSupply(club.id, { name: 'Bacardi Blanco' });

    const res = await api().put(url(`/supplies/${whisky.id}/suppliers`)).set(auth(manager))
      .send({ supplier_ids: [proveedor.id] });
    expect(res.status).toBe(200);
    expect(res.body.suppliers).toHaveLength(1);

    const detalle = await api().get(url(`/suppliers/${proveedor.id}`)).set(auth(almacenista));
    expect(detalle.body.supplies.map((s) => s.name)).toEqual(['Buchanans 12']);
    expect(detalle.body.supplier.supply_count).toBe(1);

    // Y quitar es mandar la lista sin él, no una ruta aparte.
    await api().put(url(`/supplies/${whisky.id}/suppliers`)).set(auth(manager))
      .send({ supplier_ids: [] });
    const vacio = await api().get(url(`/supplies/${whisky.id}/suppliers`)).set(auth(almacenista));
    expect(vacio.body.suppliers).toHaveLength(0);
    expect(ron.id).toBeTruthy();
  });

  it('un proveedor de otro club no se puede asignar', async () => {
    const otro = await f.createNightclub({ slug: 'otro-2', name: 'Otro 2' });
    const ajeno = await pool.query(
      'INSERT INTO suppliers (nightclub_id, name) VALUES ($1,$2) RETURNING id',
      [otro.id, 'Ajeno']);
    const insumo = await f.createSupply(club.id);

    const res = await api().put(url(`/supplies/${insumo.id}/suppliers`)).set(auth(manager))
      .send({ supplier_ids: [ajeno.rows[0].id] });
    expect(res.status).toBe(422);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM supply_suppliers');
    expect(rows[0].n).toBe(0);
  });
});

// ===========================================================================
// La entrada en lote
// ===========================================================================

describe('POST /supply-receipts', () => {
  async function tresInsumos() {
    return [
      await f.createSupply(club.id, { name: 'Buchanans 12', package_size: 750 }),
      await f.createSupply(club.id, { name: 'Bacardi Blanco', package_size: 1000 }),
      await f.createSupply(club.id, { name: 'Coca Cola', unit: 'ml', package_size: 355 }),
    ];
  }

  it('mete las tres líneas con un solo folio', async () => {
    const [whisky, ron, refresco] = await tresInsumos();

    const res = await api().post(url('/supply-receipts')).set(auth(almacenista)).send({
      location_id: warehouse,
      lines: [
        { supply_id: whisky.id, packages: 6, package_cost: 900 },
        { supply_id: ron.id, packages: 12, package_cost: 320 },
        { supply_id: refresco.id, packages: 24, package_cost: 18 },
      ],
    });

    expect(res.status).toBe(201);
    expect(res.body.receipt.lines).toHaveLength(3);
    expect(res.body.receipt.receipt_group).toEqual(expect.any(String));

    // Las cantidades entraron en la unidad base: 6 botellas de 750 ml son 4,500 ml.
    expect(await f.supplyStock(whisky.id, warehouse)).toBe(4500);
    expect(await f.supplyStock(ron.id, warehouse)).toBe(12000);
    expect(await f.supplyStock(refresco.id, warehouse)).toBe(8520);

    // Y los tres renglones comparten folio, así que la entrega se puede ver junta.
    const { rows } = await pool.query(
      `SELECT count(DISTINCT receipt_group)::int AS folios, count(*)::int AS renglones
         FROM supply_movements WHERE kind = 'receipt' AND receipt_group IS NOT NULL`);
    expect(rows[0]).toEqual({ folios: 1, renglones: 3 });
  });

  it('suma el total de la captura', async () => {
    const [whisky, ron] = await tresInsumos();
    const res = await api().post(url('/supply-receipts')).set(auth(almacenista)).send({
      location_id: warehouse,
      lines: [
        { supply_id: whisky.id, packages: 6, package_cost: 900 },
        { supply_id: ron.id, packages: 10, package_cost: 320 },
      ],
    });
    // 6 x 900 + 10 x 320
    expect(res.body.receipt.total).toBe(8600);
    expect(res.body.receipt.total_is_complete).toBe(true);
  });

  it('avisa que el total NO cuadra si alguna línea entró sin costo', async () => {
    const [whisky, ron] = await tresInsumos();
    const res = await api().post(url('/supply-receipts')).set(auth(almacenista)).send({
      location_id: warehouse,
      lines: [
        { supply_id: whisky.id, packages: 6, package_cost: 900 },
        { supply_id: ron.id, packages: 10 },
      ],
    });
    expect(res.body.receipt.total).toBe(5400);
    // Un total que parece exacto y está incompleto es peor que no dar total.
    expect(res.body.receipt.total_is_complete).toBe(false);
  });

  it('el costo es POR LÍNEA: cada insumo mueve su propio promedio', async () => {
    const [whisky, ron] = await tresInsumos();

    await api().post(url('/supply-receipts')).set(auth(almacenista)).send({
      location_id: warehouse,
      lines: [
        { supply_id: whisky.id, packages: 1, package_cost: 900 },
        { supply_id: ron.id, packages: 1, package_cost: 300 },
      ],
    });

    const { rows } = await pool.query(
      'SELECT id, avg_cost::float8 AS avg_cost FROM supplies WHERE id = ANY($1::uuid[])',
      [[whisky.id, ron.id]]);
    const porId = Object.fromEntries(rows.map((r) => [r.id, r.avg_cost]));
    // 900 / 750 ml y 300 / 1000 ml. Si se repartiera un total, los dos saldrían igual.
    expect(porId[whisky.id]).toBeCloseTo(1.2, 4);
    expect(porId[ron.id]).toBeCloseTo(0.3, 4);
  });

  it('el promedio se pondera por cantidad, no por número de compras', async () => {
    const whisky = await f.createSupply(club.id, { package_size: 1000 });

    await api().post(url('/supply-receipts')).set(auth(almacenista)).send({
      location_id: warehouse,
      lines: [{ supply_id: whisky.id, packages: 20, package_cost: 900 }],
    });
    await api().post(url('/supply-receipts')).set(auth(almacenista)).send({
      location_id: warehouse,
      lines: [{ supply_id: whisky.id, packages: 1, package_cost: 1400 }],
    });

    const { rows } = await pool.query('SELECT avg_cost::float8 AS c FROM supplies WHERE id = $1',
      [whisky.id]);
    // (20 x 0.9 + 1 x 1.4) / 21 = 0.9238. NO 1.15, que es lo que daría promediar precios.
    expect(rows[0].c).toBeCloseTo(0.923809, 4);
  });

  it('una línea mala NO deja medio lote adentro', async () => {
    const [whisky, ron] = await tresInsumos();

    const res = await api().post(url('/supply-receipts')).set(auth(almacenista)).send({
      location_id: warehouse,
      lines: [
        { supply_id: whisky.id, packages: 6, package_cost: 900 },
        { supply_id: ron.id, packages: 10, package_cost: 320 },
        { supply_id: '11111111-1111-1111-1111-111111111111', packages: 1 },
      ],
    });

    expect(res.status).toBe(422);
    expect(res.body.error.details.lines[0]).toMatchObject({ row: 3, code: 'unknown_supply' });
    // Nada entró: ni el whisky ni el ron, que eran válidos.
    expect(await f.supplyStock(whisky.id, warehouse)).toBe(0);
    expect(await f.supplyStock(ron.id, warehouse)).toBe(0);
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM supply_movements WHERE kind = 'receipt'`);
    expect(rows[0].n).toBe(0);
  });

  it('nombra TODAS las líneas malas, no solo la primera', async () => {
    const [whisky] = await tresInsumos();
    const apagado = await f.createSupply(club.id, { name: 'Apagado' });
    await pool.query('UPDATE supplies SET active = false WHERE id = $1', [apagado.id]);

    const res = await api().post(url('/supply-receipts')).set(auth(almacenista)).send({
      location_id: warehouse,
      lines: [
        { supply_id: whisky.id, packages: 1 },
        { supply_id: apagado.id, packages: 1 },
        { supply_id: '22222222-2222-2222-2222-222222222222', packages: 1 },
      ],
    });

    expect(res.status).toBe(422);
    // Quien captura corrige las dos de una pasada, en vez de descubrirlas de a una.
    expect(res.body.error.details.lines).toHaveLength(2);
    expect(res.body.error.details.lines.map((l) => l.code))
      .toEqual(['inactive_supply', 'unknown_supply']);
  });

  it('el mismo insumo dos veces en el lote se rechaza', async () => {
    const [whisky] = await tresInsumos();
    const res = await api().post(url('/supply-receipts')).set(auth(almacenista)).send({
      location_id: warehouse,
      lines: [
        { supply_id: whisky.id, packages: 6, package_cost: 900 },
        { supply_id: whisky.id, packages: 6, package_cost: 900 },
      ],
    });
    expect(res.status).toBe(422);
    expect(res.body.error.details.lines[0]).toMatchObject({ code: 'duplicate_supply', first_row: 1 });
    expect(await f.supplyStock(whisky.id, warehouse)).toBe(0);
  });

  it('guarda de quién vino y actualiza lo que ese proveedor cobró', async () => {
    const proveedor = await crearProveedor();
    const whisky = await f.createSupply(club.id, { package_size: 750 });

    await api().post(url('/supply-receipts')).set(auth(almacenista)).send({
      location_id: warehouse,
      supplier_id: proveedor.id,
      lines: [{ supply_id: whisky.id, packages: 6, package_cost: 900 }],
    });

    const { rows } = await pool.query(
      'SELECT last_cost::float8 AS last_cost FROM supply_suppliers WHERE supplier_id = $1',
      [proveedor.id]);
    // El costo de la PRESENTACIÓN, como viene en la factura. Nadie cotiza por mililitro.
    expect(rows[0].last_cost).toBe(900);

    const detalle = await api().get(url(`/suppliers/${proveedor.id}`)).set(auth(almacenista));
    expect(detalle.body.supplier.purchases_total).toBeCloseTo(5400, 2);
  });

  it('se puede capturar sin proveedor: una entrega no se queda sin registrar por eso', async () => {
    const whisky = await f.createSupply(club.id);
    const res = await api().post(url('/supply-receipts')).set(auth(almacenista)).send({
      location_id: warehouse,
      lines: [{ supply_id: whisky.id, packages: 2 }],
    });
    expect(res.status).toBe(201);
    expect(res.body.receipt.supplier_id).toBeNull();
  });

  it('un proveedor apagado no se puede usar para capturar', async () => {
    const proveedor = await crearProveedor();
    await api().patch(url(`/suppliers/${proveedor.id}`)).set(auth(manager)).send({ active: false });
    const whisky = await f.createSupply(club.id);

    const res = await api().post(url('/supply-receipts')).set(auth(almacenista)).send({
      location_id: warehouse,
      supplier_id: proveedor.id,
      lines: [{ supply_id: whisky.id, packages: 1 }],
    });
    expect(res.status).toBe(404);
    expect(await f.supplyStock(whisky.id, warehouse)).toBe(0);
  });

  it('cantidad en presentaciones O en unidad base, nunca las dos', async () => {
    const whisky = await f.createSupply(club.id);
    const dos = await api().post(url('/supply-receipts')).set(auth(almacenista)).send({
      location_id: warehouse,
      lines: [{ supply_id: whisky.id, packages: 6, quantity: 4500 }],
    });
    expect(dos.status).toBe(400);

    const ninguna = await api().post(url('/supply-receipts')).set(auth(almacenista)).send({
      location_id: warehouse,
      lines: [{ supply_id: whisky.id }],
    });
    expect(ninguna.status).toBe(400);
  });

  it('el cantinero no captura entradas de mercancía', async () => {
    const whisky = await f.createSupply(club.id);
    const res = await api().post(url('/supply-receipts')).set(auth(bartender)).send({
      location_id: warehouse,
      lines: [{ supply_id: whisky.id, packages: 1 }],
    });
    expect(res.status).toBe(403);
  });

  it('un lugar de otro club no recibe nada', async () => {
    const otro = await f.createNightclub({ slug: 'otro-3', name: 'Otro 3' });
    const whisky = await f.createSupply(club.id);
    const res = await api().post(url('/supply-receipts')).set(auth(almacenista)).send({
      location_id: otro.warehouse_id,
      lines: [{ supply_id: whisky.id, packages: 1 }],
    });
    expect(res.status).toBe(404);
  });

  it('un insumo de otro club no entra en este inventario', async () => {
    const otro = await f.createNightclub({ slug: 'otro-4', name: 'Otro 4' });
    const ajeno = await f.createSupply(otro.id);
    const res = await api().post(url('/supply-receipts')).set(auth(almacenista)).send({
      location_id: warehouse,
      lines: [{ supply_id: ajeno.id, packages: 1 }],
    });
    expect(res.status).toBe(422);
    expect(res.body.error.details.lines[0].code).toBe('unknown_supply');
  });
});

// ===========================================================================
// Volver a ver una captura
// ===========================================================================

describe('GET /supply-receipts', () => {
  it('devuelve la entrega completa por su folio', async () => {
    const proveedor = await crearProveedor();
    const whisky = await f.createSupply(club.id, { name: 'Buchanans 12', package_size: 750 });
    const ron = await f.createSupply(club.id, { name: 'Bacardi', package_size: 1000 });

    const creada = await api().post(url('/supply-receipts')).set(auth(almacenista)).send({
      location_id: warehouse,
      supplier_id: proveedor.id,
      lines: [
        { supply_id: whisky.id, packages: 6, package_cost: 900 },
        { supply_id: ron.id, packages: 10, package_cost: 320 },
      ],
    });
    const folio = creada.body.receipt.receipt_group;

    const res = await api().get(url(`/supply-receipts/${folio}`)).set(auth(almacenista));
    expect(res.status).toBe(200);
    expect(res.body.receipt.lines).toHaveLength(2);
    expect(res.body.receipt.supplier_name).toBe('Distribuidora Corona');
    expect(res.body.receipt.total).toBeCloseTo(8600, 2);
    expect(res.body.receipt.created_by_name).toBeTruthy();
  });

  it('la bitácora de compras trae una línea por entrega', async () => {
    const whisky = await f.createSupply(club.id);
    const ron = await f.createSupply(club.id);
    await api().post(url('/supply-receipts')).set(auth(almacenista)).send({
      location_id: warehouse,
      lines: [{ supply_id: whisky.id, packages: 1 }, { supply_id: ron.id, packages: 1 }],
    });
    await api().post(url('/supply-receipts')).set(auth(almacenista)).send({
      location_id: warehouse,
      lines: [{ supply_id: whisky.id, packages: 2 }],
    });

    const res = await api().get(url('/supply-receipts')).set(auth(almacenista));
    expect(res.status).toBe(200);
    expect(res.body.receipts).toHaveLength(2);
    // Dos entregas, no tres movimientos.
    expect(res.body.receipts.map((r) => r.line_count).sort()).toEqual([1, 2]);
  });

  it('un folio que no existe es 404', async () => {
    const res = await api().get(url('/supply-receipts/33333333-3333-3333-3333-333333333333'))
      .set(auth(almacenista));
    expect(res.status).toBe(404);
  });

  it('el kardex dice de quién vino cada entrada', async () => {
    const proveedor = await crearProveedor();
    const whisky = await f.createSupply(club.id);
    await api().post(url('/supply-receipts')).set(auth(almacenista)).send({
      location_id: warehouse,
      supplier_id: proveedor.id,
      lines: [{ supply_id: whisky.id, packages: 3, package_cost: 500 }],
    });

    const res = await api().get(url('/supply-movements')).set(auth(almacenista));
    const entrada = res.body.movements.find((m) => m.kind === 'receipt');
    expect(entrada.supplier_name).toBe('Distribuidora Corona');
    expect(entrada.receipt_group).toEqual(expect.any(String));
  });
});
