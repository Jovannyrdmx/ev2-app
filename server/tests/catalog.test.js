'use strict';

const { setupSchema, truncateAll, closePool, pool } = require('./helpers/db');
const { api, auth } = require('./helpers/api');
const f = require('./helpers/factories');

let club; let guest; let bartender; let manager; let beer; let cocktail;

beforeAll(setupSchema);
afterAll(closePool);
beforeEach(async () => {
  await truncateAll();
  club = await f.createNightclub({ slug: 'ev2-cat' });
  guest = await f.createUser(club.id, { role: 'guest' });
  bartender = await f.createUser(club.id, { role: 'bartender' });
  manager = await f.createUser(club.id, { role: 'manager' });
  beer = await f.createDrink(club.id, { name: 'Cerveza nacional', category: 'beer', price: 60, stock: 20 });
  cocktail = await f.createDrink(club.id, { name: 'Margarita', category: 'cocktail', price: 130, stock: 2, low_stock_threshold: 5 });
});

const url = (p) => `/api/nightclubs/${club.id}${p}`;

describe('Menú', () => {
  it('lista las bebidas con existencias y aviso de stock bajo', async () => {
    const res = await api().get(url('/drinks')).set(auth(guest));
    expect(res.status).toBe(200);
    expect(res.body.drinks).toHaveLength(2);

    const margarita = res.body.drinks.find((d) => d.name === 'Margarita');
    expect(margarita.low_stock).toBe(true);
    expect(margarita.price).toBe('130.00');
  });

  it('filtra por categoría', async () => {
    const res = await api().get(url('/drinks?category=beer')).set(auth(guest));
    expect(res.body.drinks).toHaveLength(1);
    expect(res.body.drinks[0].name).toBe('Cerveza nacional');
  });

  it('busca por nombre sin distinguir mayúsculas', async () => {
    const res = await api().get(url('/drinks?search=margar')).set(auth(guest));
    expect(res.body.drinks).toHaveLength(1);
  });

  it('con available_only oculta lo agotado y lo no disponible', async () => {
    // Agotar de verdad: se vacía el insumo del que sale, no un contador del producto.
    await pool.query(
      `UPDATE supply_stock SET stock = 0 WHERE supply_id = (
         SELECT supply_id FROM drink_supplies WHERE drink_id = $1)`, [cocktail.id]);
    const res = await api().get(url('/drinks?available_only=true')).set(auth(guest));
    expect(res.body.drinks.map((d) => d.name)).toEqual(['Cerveza nacional']);
  });

  it('oculta las bebidas dadas de baja', async () => {
    await pool.query('UPDATE drinks SET active = false WHERE id = $1', [beer.id]);
    const res = await api().get(url('/drinks')).set(auth(guest));
    expect(res.body.drinks).toHaveLength(1);
  });

  it('devuelve las categorías con su conteo', async () => {
    const res = await api().get(url('/drinks/categories')).set(auth(guest));
    expect(res.status).toBe(200);
    expect(res.body.categories).toEqual(
      expect.arrayContaining([{ category: 'beer', count: 1 }, { category: 'cocktail', count: 1 }]),
    );
  });

  it('exige autenticación', async () => {
    expect((await api().get(url('/drinks'))).status).toBe(401);
  });
});

describe('Alta y edición de bebidas', () => {
  it('el gerente crea una bebida, y nace SIN existencia inventada', async () => {
    const res = await api().post(url('/drinks')).set(auth(manager)).send({
      name: 'Mezcal', category: 'shot', price: 85,
    });
    expect(res.status).toBe(201);
    expect(res.body.drink.name).toBe('Mezcal');

    // Un producto recién creado no tiene receta, así que no se le lleva existencia.
    // Teclear un saldo inicial al darlo de alta era la forma de meter un número sin
    // respaldo al sistema.
    const list = await api().get(url('/drinks?category=shot')).set(auth(manager));
    const mezcal = list.body.drinks.find((d) => d.id === res.body.drink.id);
    expect(mezcal.stock).toBeNull();
    expect(mezcal.stock_tracked).toBe(false);
  });

  it('un bartender no puede crear bebidas', async () => {
    const res = await api().post(url('/drinks')).set(auth(bartender))
      .send({ name: 'X', category: 'beer', price: 10 });
    expect(res.status).toBe(403);
  });

  it('valida el cuerpo del alta', async () => {
    const res = await api().post(url('/drinks')).set(auth(manager))
      .send({ name: '', category: 'beer', price: -5 });
    expect(res.status).toBe(400);
  });

  it('el gerente edita precio y disponibilidad', async () => {
    const res = await api().patch(url(`/drinks/${beer.id}`)).set(auth(manager))
      .send({ price: 75, available: false });
    expect(res.status).toBe(200);
    expect(res.body.drink.price).toBe('75.00');
    expect(res.body.drink.available).toBe(false);
  });

  it('devuelve 404 al editar una bebida de otro club', async () => {
    const otherClub = await f.createNightclub({ slug: 'otro-cat' });
    const foreign = await f.createDrink(otherClub.id);
    const res = await api().patch(url(`/drinks/${foreign.id}`)).set(auth(manager)).send({ price: 1 });
    expect(res.status).toBe(404);
  });

  it('rechaza una edición vacía', async () => {
    const res = await api().patch(url(`/drinks/${beer.id}`)).set(auth(manager)).send({});
    expect(res.status).toBe(400);
  });
});

describe('Inventario', () => {
  // El inventario por producto se fue en la migración 018: la existencia vive en el
  // insumo y estas rutas ya no existen. Lo que queda aquí es que el catálogo siga
  // diciendo la verdad sobre lo que alcanza; el inventario en sí se prueba entero en
  // `inventory.test.js`.
  it('la carta dice cuántos alcanzan según la receta', async () => {
    const res = await api().get(url('/drinks?category=beer')).set(auth(guest));
    const cerveza = res.body.drinks.find((d) => d.id === beer.id);
    expect(cerveza.stock_tracked).toBe(true);
    expect(cerveza.stock).toBe(20);
  });

  it('lo que está bajo mínimo viene marcado', async () => {
    const res = await api().get(url('/drinks')).set(auth(guest));
    const margarita = res.body.drinks.find((d) => d.name === 'Margarita');
    expect(margarita.low_stock).toBe(true); // 2 en existencia, mínimo 5
  });

  it('las rutas viejas de inventario por producto ya no existen', async () => {
    expect((await api().get(url('/inventory')).set(auth(bartender))).status).toBe(404);
  });
});

describe('Club', () => {
  it('resuelve el club por su slug sin autenticación', async () => {
    const res = await api().get(`/api/nightclubs/by-slug/${club.slug}`);
    expect(res.status).toBe(200);
    expect(res.body.nightclub.id).toBe(club.id);
    // Los datos internos no se exponen públicamente.
    expect(res.body.nightclub.settings).toBeUndefined();
  });

  it('devuelve 404 para un slug inexistente', async () => {
    expect((await api().get('/api/nightclubs/by-slug/no-existe')).status).toBe(404);
  });

  it('devuelve el perfil completo a un usuario autenticado', async () => {
    const res = await api().get(url('')).set(auth(guest));
    expect(res.status).toBe(200);
    expect(res.body.nightclub.timezone).toBe('America/Hermosillo');
  });

  it('lista el personal y excluye a los clientes', async () => {
    const res = await api().get(url('/staff')).set(auth(guest));
    expect(res.status).toBe(200);
    const roles = res.body.staff.map((s) => s.role);
    expect(roles).toEqual(expect.arrayContaining(['bartender', 'manager']));
    expect(roles).not.toContain('guest');
  });

  it('filtra el personal por rol y por turno abierto', async () => {
    await pool.query('INSERT INTO staff_shifts (nightclub_id, user_id, section) VALUES ($1,$2,$3)',
      [club.id, bartender.id, 'barra']);

    const porRol = await api().get(url('/staff?role=bartender')).set(auth(guest));
    expect(porRol.body.staff).toHaveLength(1);

    const enTurno = await api().get(url('/staff?on_shift=true')).set(auth(guest));
    expect(enTurno.body.staff).toHaveLength(1);
    expect(enTurno.body.staff[0].on_shift).toBe(true);
    expect(enTurno.body.staff[0].section).toBe('barra');
  });

  it('lista los contactos de emergencia activos, en orden', async () => {
    await pool.query(
      `INSERT INTO emergency_contacts (nightclub_id, name, phone, type, sort_order, active) VALUES
       ($1,'911','911','police',0,true),
       ($1,'Taxi','631','taxi',1,true),
       ($1,'Viejo','000','other',2,false)`, [club.id]);

    const res = await api().get(url('/emergency-contacts')).set(auth(guest));
    expect(res.body.contacts.map((c) => c.name)).toEqual(['911', 'Taxi']);
  });

  it('el tablero es solo para gerencia', async () => {
    expect((await api().get(url('/dashboard')).set(auth(bartender))).status).toBe(403);

    const res = await api().get(url('/dashboard')).set(auth(manager));
    expect(res.status).toBe(200);
    expect(res.body.tables).toHaveProperty('total');
    expect(res.body.orders).toHaveProperty('in_progress');
    expect(res.body).toHaveProperty('generated_at');
  });

  it('entrega los eventos dirigidos al usuario', async () => {
    const table = await f.createTable(club.id);
    await api().post(url(`/tables/${table.id}/seat`)).set(auth(manager)).send({ user_id: guest.id });

    const res = await api().get(url('/sync/events?since_id=0')).set(auth(guest));
    expect(res.status).toBe(200);
    expect(res.body.events.length).toBeGreaterThanOrEqual(1);
    // Los ids de evento viajan como cadena: son enteros de 64 bits y JavaScript
    // pierde precisión por encima de 2^53 (documentado en openapi.yaml).
    expect(typeof res.body.last_id).toBe('string');
    expect(Number(res.body.last_id)).toBeGreaterThan(0);
  });

  it('filtra los eventos por audiencia', async () => {
    const drink = await f.createDrink(club.id, { stock: 5 });
    const { randomUUID } = require('crypto');
    await api().post(url('/orders')).set(auth(guest)).send({
      client_request_id: randomUUID(), items: [{ drink_id: drink.id, quantity: 1 }],
    });

    // El pedido va dirigido a la barra y a quien lo hizo, no a otro cliente.
    const outsider = await f.createUser(club.id, { role: 'guest' });
    const res = await api().get(url('/sync/events?since_id=0')).set(auth(outsider));
    expect(res.body.events.filter((e) => e.type === 'order_created')).toHaveLength(0);

    const barra = await api().get(url('/sync/events?since_id=0')).set(auth(bartender));
    expect(barra.body.events.filter((e) => e.type === 'order_created')).toHaveLength(1);
  });
});
