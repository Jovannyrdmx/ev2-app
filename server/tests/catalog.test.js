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
    await pool.query('UPDATE inventory SET quantity = 0 WHERE drink_id = $1', [cocktail.id]);
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
  it('el gerente crea una bebida con existencias iniciales', async () => {
    const res = await api().post(url('/drinks')).set(auth(manager)).send({
      name: 'Mezcal', category: 'shot', price: 85, initial_stock: 30,
    });
    expect(res.status).toBe(201);
    expect(res.body.drink.name).toBe('Mezcal');

    const { rows } = await pool.query(
      'SELECT quantity FROM inventory WHERE drink_id = $1', [res.body.drink.id]);
    expect(Number(rows[0].quantity)).toBe(30);
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
  it('el bartender lo consulta y ve primero lo que está bajo mínimo', async () => {
    const res = await api().get(url('/inventory')).set(auth(bartender));
    expect(res.status).toBe(200);
    expect(res.body.inventory[0].name).toBe('Margarita'); // stock 2 < umbral 5
  });

  it('un cliente no puede verlo', async () => {
    expect((await api().get(url('/inventory')).set(auth(guest))).status).toBe(403);
  });

  it('el gerente ajusta existencias', async () => {
    const res = await api().put(url(`/inventory/${beer.id}`)).set(auth(manager))
      .send({ quantity: 5, low_stock_threshold: 10 });
    expect(res.status).toBe(200);
    expect(Number(res.body.inventory.quantity)).toBe(5);

    const list = await api().get(url('/drinks?category=beer')).set(auth(guest));
    expect(list.body.drinks[0].low_stock).toBe(true);
  });

  it('el bartender no puede ajustar existencias', async () => {
    const res = await api().put(url(`/inventory/${beer.id}`)).set(auth(bartender)).send({ quantity: 0 });
    expect(res.status).toBe(403);
  });

  it('rechaza cantidades negativas', async () => {
    const res = await api().put(url(`/inventory/${beer.id}`)).set(auth(manager)).send({ quantity: -1 });
    expect(res.status).toBe(400);
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
