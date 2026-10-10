/**
 * Cómo salió una noche.
 *
 * Lo que se prueba aquí son los cuatro errores que harían inútil el reporte, y
 * ninguno de los cuatro revienta: todos dan un número más grande.
 *
 *   1. **Cancelado no es vendido, y no-show no es ocupado.** Contarlos infla la
 *      noche y arruina la comparación entre dos viernes, que es para lo que existe
 *      el corte.
 *   2. **Las propinas NO son ingreso del club.** Son de la persona. Sumarlas al
 *      total mete dinero que nunca fue del club.
 *   3. **El corte congelado no cambia.** Si mañana sube un precio, el corte del
 *      viernes tiene que seguir diciendo lo que dijo el viernes. Un reporte que se
 *      mueve solo no sirve para discutir una cifra con nadie.
 *   4. **Una zona vacía tiene que APARECER con cero.** La que no sale del reporte
 *      es la que nadie se acuerda de preguntar, y son justo las que hay que
 *      repensar.
 *
 * La venta sale de NUESTRO POS (`drink_orders` y `transactions`): el dueño decidió
 * no hacer la integración con SoftRestaurant por ahora, así que el total del corte
 * es el total real del club y no una parte.
 */
'use strict';

const { setupSchema, truncateAll, closePool, pool } = require('./helpers/db');
const { api, auth } = require('./helpers/api');
const f = require('./helpers/factories');

let club;
let manager;
let waiter;
let guest;
let night;
let mesaRoja;
let mesaTerraza;

beforeAll(async () => {
  await setupSchema();
});
beforeEach(async () => {
  await truncateAll();
  club = await f.createNightclub({ slug: 'ev2-nights' });
  manager = await f.createUser(club.id, { role: 'manager' });
  waiter = await f.createUser(club.id, { role: 'waiter' });
  guest = await f.createUser(club.id, { role: 'guest' });
  mesaRoja = await f.createTable(club.id, { code: '10', section: 'ZONA ROJA', capacity: 8 });
  mesaTerraza = await f.createTable(club.id, { code: '20', section: 'TERRAZA', capacity: 4 });
  night = await crearNoche();
});
afterAll(closePool);

const url = (p) => `/api/nightclubs/${club.id}${p}`;

/** Una noche que YA abrió, para poder cortarla. */
let dia = 0;
async function crearNoche(over = {}) {
  const fecha = new Date(Date.now() + (dia += 1) * 86_400_000);
  const res = await api().post(url('/events')).set(auth(manager)).send({
    name: `Noche ${Math.random().toString(16).slice(2, 8)}`,
    event_date: fecha.toISOString().slice(0, 10),
    // Abrió hace dos horas: el corte se puede cerrar.
    doors_open_at: new Date(Date.now() - 2 * 3_600_000).toISOString(),
    closes_at: new Date(Date.now() + 6 * 3_600_000).toISOString(),
    ticket_price: 150,
    status: 'published',
    ...over,
  });
  expect(res.status).toBe(201);
  return res.body.event;
}

const stats = (quien = manager, evento = night) => api()
  .get(url(`/nights/${evento.id}/stats`)).set(auth(quien));

/**
 * Una reservación puesta directo en la base, con el estado que interese.
 *
 * `starts_at` sale de la FECHA DE LA NOCHE y no de `now()`: una mesa no admite dos
 * reservaciones que se traslapen (restricción de exclusión), y dos noches
 * distintas sobre la misma mesa a la misma hora chocarían aunque sean de días
 * diferentes.
 */
async function reservar({ table, status, guests = 4, total = 5000, deposit = 1500,
  evento = null }) {
  const noche = evento || night;
  const { rows } = await pool.query(
    `INSERT INTO reservations (nightclub_id, user_id, table_id, event_id, starts_at,
                               duration_minutes, guest_count, status, total_estimated,
                               deposit_amount, currency)
     VALUES ($1,$2,$3,$4,($5::date + interval '22 hours'),180,$6,$7,$8,$9,'MXN')
     RETURNING id`,
    [club.id, guest.id, table.id, noche.id, noche.event_date, guests, status, total, deposit]);
  return rows[0].id;
}

/** Un pedido de barra con su renglón, en el estado que interese. */
async function pedir({ status = 'delivered', price = 250, quantity = 2, category = 'Whisky' }) {
  const drink = await f.createDrink(club.id, { category, price });
  const { rows } = await pool.query(
    `INSERT INTO drink_orders (nightclub_id, sender_id, table_id, status, subtotal,
                               currency, client_request_id, delivered_at)
     VALUES ($1,$2,$3,$4,$5,'MXN',gen_random_uuid(),now()) RETURNING id`,
    [club.id, guest.id, mesaRoja.id, status, price * quantity]);
  await pool.query(
    `INSERT INTO drink_order_items (order_id, drink_id, quantity, unit_price)
     VALUES ($1,$2,$3,$4)`,
    [rows[0].id, drink.id, quantity, price]);
  return rows[0].id;
}

/**
 * Cover de puerta.
 *
 * Un `vip_extra` exige su reservación (decisión D40: el extra pagado va ligado a
 * su mesa, para poder cuadrar "pagué dos extras" con "entraron dos extras").
 */
async function cobrarPuerta({ kind = 'general', quantity = 10, unit = 150,
  reservationId = null }) {
  await pool.query(
    `INSERT INTO door_admissions (nightclub_id, event_id, kind, reservation_id, quantity,
                                  unit_price, total, currency, payment_method, sold_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'MXN','cash',$8)`,
    [club.id, night.id, kind, reservationId, quantity, unit, unit * quantity, manager.id]);
}

// ===========================================================================
// Una noche sin nada
// ===========================================================================

describe('una noche sin actividad', () => {
  it('da ceros, no nulos ni errores', async () => {
    const res = await stats();

    expect(res.status).toBe(200);
    const s = res.body.stats;
    // El corte de un martes muerto es un dato válido. `null` obligaría a cada
    // pantalla a decidir qué hacer, y alguna decidiría mal.
    expect(s.revenue.total).toBe(0);
    expect(s.attendance.total).toBe(0);
    expect(s.reservations).toMatchObject({ booked: 0, arrived: 0, no_show: 0 });
    expect(s.tables).toMatchObject({ total: 2, used: 0, occupancy: 0 });
    expect(s.per_person).toBe(0);
  });

  it('las zonas vacías SÍ aparecen, con cero', async () => {
    const res = await stats();
    // La zona que no sale del reporte es la que nadie se acuerda de preguntar.
    expect(res.body.stats.zones.map((z) => z.section).sort()).toEqual(['TERRAZA', 'ZONA ROJA']);
    expect(res.body.stats.zones.every((z) => z.revenue === 0 && z.occupancy === 0)).toBe(true);
  });

  it('una noche que no existe es 404', async () => {
    const res = await api().get(url('/nights/11111111-1111-1111-1111-111111111111/stats'))
      .set(auth(manager));
    expect(res.status).toBe(404);
  });
});

// ===========================================================================
// Reservaciones
// ===========================================================================

describe('las reservaciones del corte', () => {
  it('cuenta apartadas, llegadas y no-show por separado', async () => {
    await reservar({ table: mesaRoja, status: 'seated', guests: 8, total: 6000 });
    await reservar({ table: mesaTerraza, status: 'no_show', guests: 4, total: 3000 });

    const s = (await stats()).body.stats;
    expect(s.reservations).toMatchObject({ booked: 2, arrived: 1, no_show: 1 });
    expect(s.reservations.guests_arrived).toBe(8);
    // Solo la que llegó dejó dinero. La no-show apartó una mesa que no se vendió
    // dos veces, y ese es el número que duele.
    expect(s.reservations.revenue).toBe(6000);
  });

  it('una reservación CANCELADA no cuenta como mesa usada ni como venta', async () => {
    await reservar({ table: mesaRoja, status: 'cancelled', total: 6000 });

    const s = (await stats()).body.stats;
    expect(s.reservations.cancelled).toBe(1);
    expect(s.reservations.arrived).toBe(0);
    expect(s.reservations.revenue).toBe(0);
    expect(s.tables.used).toBe(0);
    expect(s.revenue.tables).toBe(0);
  });

  it('una confirmada que nadie marcó queda como apartada, sin inventar el estado', async () => {
    await reservar({ table: mesaRoja, status: 'confirmed' });

    const s = (await stats()).body.stats;
    expect(s.reservations.booked).toBe(1);
    // Ni llegada ni no-show: la puerta las marca, y si nadie las marcó no se
    // inventa aquí quién llegó al club.
    expect(s.reservations.arrived).toBe(0);
    expect(s.reservations.no_show).toBe(0);
  });

  it('los anticipos se suman aparte del total', async () => {
    await reservar({ table: mesaRoja, status: 'seated', total: 6000, deposit: 1800 });
    const s = (await stats()).body.stats;
    expect(s.revenue.deposits).toBe(1800);
    // El anticipo es parte del total de la mesa, no dinero extra: no se suma dos veces.
    expect(s.revenue.total).toBe(6000);
  });
});

// ===========================================================================
// Zonas
// ===========================================================================

describe('las zonas del corte', () => {
  it('cada zona trae su ocupación y su venta', async () => {
    await reservar({ table: mesaRoja, status: 'completed', guests: 8, total: 6000 });

    const s = (await stats()).body.stats;
    const roja = s.zones.find((z) => z.section === 'ZONA ROJA');
    const terraza = s.zones.find((z) => z.section === 'TERRAZA');

    expect(roja).toMatchObject({ tables_total: 1, tables_used: 1, occupancy: 100, revenue: 6000 });
    expect(terraza).toMatchObject({ tables_total: 1, tables_used: 0, occupancy: 0, revenue: 0 });
    expect(s.tables).toMatchObject({ total: 2, used: 1, occupancy: 50 });
  });

  it('el no-show de una zona se ve en su zona', async () => {
    await reservar({ table: mesaTerraza, status: 'no_show' });
    const s = (await stats()).body.stats;
    expect(s.zones.find((z) => z.section === 'TERRAZA').no_show).toBe(1);
  });
});

// ===========================================================================
// Barra
// ===========================================================================

describe('la barra del corte', () => {
  it('suma los pedidos ENTREGADOS y los desglosa por categoría', async () => {
    await pedir({ status: 'delivered', price: 250, quantity: 2, category: 'Whisky' });
    await pedir({ status: 'delivered', price: 120, quantity: 3, category: 'Cerveza' });

    const s = (await stats()).body.stats;
    expect(s.bar.orders).toBe(2);
    expect(s.bar.revenue).toBe(860);
    const cats = Object.fromEntries(s.bar.by_category.map((c) => [c.category, c]));
    expect(cats.Whisky).toMatchObject({ units: 2, revenue: 500 });
    expect(cats.Cerveza).toMatchObject({ units: 3, revenue: 360 });
  });

  it('un pedido CANCELADO no es venta, y se reporta aparte', async () => {
    await pedir({ status: 'delivered', price: 250, quantity: 2 });
    await pedir({ status: 'cancelled', price: 900, quantity: 1 });

    const s = (await stats()).body.stats;
    // Contar el cancelado como venta es lo que hace que el corte no cuadre con la
    // caja, y entonces nadie vuelve a creerle al corte.
    expect(s.bar.revenue).toBe(500);
    expect(s.bar.cancelled).toBe(1);
    expect(s.bar.cancelled_value).toBe(900);
  });

  it('un pedido que se quedó en preparación tampoco es venta', async () => {
    await pedir({ status: 'preparing', price: 400, quantity: 1 });
    const s = (await stats()).body.stats;
    expect(s.bar.revenue).toBe(0);
    expect(s.bar.orders).toBe(0);
  });
});

// ===========================================================================
// Puerta, propinas y merma
// ===========================================================================

describe('puerta, propinas y merma', () => {
  it('la puerta separa cover general de extras de mesa', async () => {
    const reserva = await reservar({ table: mesaRoja, status: 'seated', guests: 8 });
    await cobrarPuerta({ kind: 'general', quantity: 20, unit: 150 });
    await cobrarPuerta({ kind: 'vip_extra', quantity: 2, unit: 200, reservationId: reserva });

    const s = (await stats()).body.stats;
    expect(s.door).toMatchObject({
      people: 22, revenue: 3400, general: 20, general_revenue: 3000,
      extras: 2, extras_revenue: 400,
    });
  });

  it('la asistencia suma puerta MÁS los invitados que llegaron con mesa', async () => {
    await cobrarPuerta({ quantity: 20, unit: 150 });
    await reservar({ table: mesaRoja, status: 'seated', guests: 8 });

    const s = (await stats()).body.stats;
    expect(s.attendance).toMatchObject({ total: 28, door: 20, table_guests: 8 });
  });

  it('las propinas NO son ingreso del club', async () => {
    await pool.query(
      `INSERT INTO tips (nightclub_id, from_user_id, to_user_id, amount, currency, client_request_id)
       VALUES ($1,$2,$3,500,'MXN',gen_random_uuid())`,
      [club.id, guest.id, waiter.id]);
    await cobrarPuerta({ quantity: 10, unit: 150 });

    const s = (await stats()).body.stats;
    expect(s.tips.total).toBe(500);
    // Son de la persona. Sumarlas al total del club infla la noche con dinero que
    // nunca fue del club, y es el error más fácil de cometer en un reporte así.
    expect(s.revenue.total).toBe(1500);
    expect(s.revenue.tips_not_club_revenue).toBe(500);
    expect(s.tips.by_person[0]).toMatchObject({ user_id: waiter.id, total: 500 });
  });

  it('la merma se valúa al COSTO, y la cortesía se reporta aparte', async () => {
    const supply = await f.createSupply(club.id, { package_size: 750, avg_cost: 1.2 });
    const bar = club.bar_id;
    await f.stockUp(club.id, supply.id, bar, 3000);
    // Una botella rota: 750 ml a $1.20/ml = $900 de costo.
    await pool.query(
      `INSERT INTO supply_movements (nightclub_id, supply_id, location_id, kind, quantity,
                                     balance_after, reason)
       VALUES ($1,$2,$3,'waste',-750,2250,'Botella rota')`,
      [club.id, supply.id, bar]);
    await pool.query(
      `INSERT INTO supply_movements (nightclub_id, supply_id, location_id, kind, quantity,
                                     balance_after, reason)
       VALUES ($1,$2,$3,'courtesy',-300,1950,'Cortesía a la mesa 10')`,
      [club.id, supply.id, bar]);

    const s = (await stats()).body.stats;
    // Al costo y nunca al precio de venta: valuar una botella rota a precio de
    // trago convierte $900 de pérdida en $6,000 y vuelve imposible tomarse el
    // número en serio.
    expect(s.shrinkage.waste).toBeCloseTo(900, 1);
    expect(s.shrinkage.courtesy).toBeCloseTo(360, 1);
    // La cortesía salió del inventario igual, pero el club la autorizó: mezclarla
    // con la merma hace que una promoción parezca un robo.
    expect(s.shrinkage.value).toBeCloseTo(900, 1);
  });
});

// ===========================================================================
// El total y el ticket promedio
// ===========================================================================

describe('el total de la noche', () => {
  it('suma mesas, barra y puerta', async () => {
    await reservar({ table: mesaRoja, status: 'seated', guests: 8, total: 6000 });
    await pedir({ status: 'delivered', price: 250, quantity: 2 });
    await cobrarPuerta({ quantity: 20, unit: 150 });

    const s = (await stats()).body.stats;
    expect(s.revenue).toMatchObject({ tables: 6000, bar: 500, door: 3000, total: 9500 });
  });

  it('el ticket promedio es por persona que entró', async () => {
    await cobrarPuerta({ quantity: 20, unit: 150 });
    await reservar({ table: mesaRoja, status: 'seated', guests: 8, total: 6000 });

    const s = (await stats()).body.stats;
    // 9,000 entre 28 personas.
    expect(s.per_person).toBeCloseTo(321.43, 1);
  });

  it('sin asistencia el promedio es 0, no una división por cero', async () => {
    await pedir({ status: 'delivered', price: 250, quantity: 2 });
    const s = (await stats()).body.stats;
    expect(s.per_person).toBe(0);
    expect(Number.isFinite(s.per_person)).toBe(true);
  });
});

// ===========================================================================
// Cerrar la noche
// ===========================================================================

describe('POST /nights/:id/close', () => {
  it('congela el corte', async () => {
    await reservar({ table: mesaRoja, status: 'seated', guests: 8, total: 6000 });
    await pedir({ status: 'delivered', price: 250, quantity: 2 });
    await cobrarPuerta({ quantity: 20, unit: 150 });

    const res = await api().post(url(`/nights/${night.id}/close`)).set(auth(manager))
      .send({ note: 'Buena noche' });

    expect(res.status).toBe(201);
    expect(Number(res.body.closing.revenue_total)).toBe(9500);
    expect(res.body.closing.attendance).toBe(28);
    expect(res.body.closing.tables_used).toBe(1);
    expect(res.body.closing.note).toBe('Buena noche');
    expect(res.body.closing.detail.zones).toHaveLength(2);
  });

  it('el corte NO cambia si después cambia un precio', async () => {
    await reservar({ table: mesaRoja, status: 'seated', guests: 8, total: 6000 });
    const cerrado = await api().post(url(`/nights/${night.id}/close`)).set(auth(manager)).send({});
    expect(cerrado.status).toBe(201);

    // Al día siguiente alguien corrige el total de esa reservación.
    await pool.query('UPDATE reservations SET total_estimated = 99999 WHERE event_id = $1',
      [night.id]);

    const guardado = await api().get(url(`/nights/${night.id}/closing`)).set(auth(manager));
    // Un reporte que se mueve solo no sirve para comparar dos noches ni para
    // discutir una cifra con nadie.
    expect(Number(guardado.body.closing.revenue_total)).toBe(6000);
  });

  it('una noche se cierra UNA vez', async () => {
    expect((await api().post(url(`/nights/${night.id}/close`)).set(auth(manager)).send({}))
      .status).toBe(201);
    const otra = await api().post(url(`/nights/${night.id}/close`)).set(auth(manager)).send({});
    expect(otra.status).toBe(409);
    // Dos cortes de la misma noche significan que ninguno de los dos es el corte.
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM night_closings');
    expect(rows[0].n).toBe(1);
  });

  it('una noche que todavía no empieza no se puede cortar', async () => {
    const futura = await crearNoche({
      doors_open_at: new Date(Date.now() + 3 * 3_600_000).toISOString(),
    });
    const res = await api().post(url(`/nights/${futura.id}/close`)).set(auth(manager)).send({});

    expect(res.status).toBe(422);
    // Un corte de una noche que no ha pasado son ceros presentados como hechos.
    expect(res.body.error.message).toMatch(/todavía no empieza/i);
  });

  it('el corte guardado no se puede editar ni borrar', async () => {
    await api().post(url(`/nights/${night.id}/close`)).set(auth(manager)).send({});

    await expect(pool.query('UPDATE night_closings SET revenue_total = 1'))
      .rejects.toThrow(/insert-only/);
    await expect(pool.query('DELETE FROM night_closings'))
      .rejects.toThrow(/insert-only/);
  });

  it('el corte en vivo avisa cuando la noche ya está cerrada', async () => {
    const sinCerrar = await stats();
    expect(sinCerrar.body.closed).toBeNull();

    await api().post(url(`/nights/${night.id}/close`)).set(auth(manager)).send({});
    const cerrada = await stats();
    // Los números en vivo pueden diferir del corte (una propina tardía): decirlo
    // evita que dos cifras distintas parezcan un error del sistema.
    expect(cerrada.body.closed.closed_at).toBeTruthy();
  });

  it('una noche sin cerrar no tiene corte guardado', async () => {
    const res = await api().get(url(`/nights/${night.id}/closing`)).set(auth(manager));
    expect(res.status).toBe(404);
  });
});

// ===========================================================================
// Comparar noches
// ===========================================================================

describe('GET /nights/closings', () => {
  it('lista los cortes de la noche más reciente hacia atrás', async () => {
    await reservar({ table: mesaRoja, status: 'seated', total: 6000 });
    await api().post(url(`/nights/${night.id}/close`)).set(auth(manager)).send({});

    const segunda = await crearNoche();
    const anterior = night;
    await reservar({ table: mesaRoja, status: 'seated', total: 9000, evento: segunda });
    await api().post(url(`/nights/${segunda.id}/close`)).set(auth(manager)).send({});

    const res = await api().get(url('/nights/closings')).set(auth(manager));
    expect(res.status).toBe(200);
    expect(res.body.closings).toHaveLength(2);
    // La más reciente primero: es la que se mira.
    expect(res.body.closings[0].event_id).toBe(segunda.id);
    expect(Number(res.body.closings[0].revenue_total)).toBe(9000);
    expect(res.body.closings[1].event_id).toBe(anterior.id);
    expect(res.body.closings[0].closed_by_name).toBeTruthy();
  });

  it('sin cortes la lista viene vacía', async () => {
    const res = await api().get(url('/nights/closings')).set(auth(manager));
    expect(res.body.closings).toEqual([]);
  });
});

// ===========================================================================
// Quién puede ver esto
// ===========================================================================

describe('permisos del corte', () => {
  it('el piso NO ve cuánto se vendió', async () => {
    // Es información del negocio: cuánto se vendió, qué zona no se llenó, cuánto
    // producto se fue sin venderse.
    expect((await stats(waiter)).status).toBe(403);
    expect((await stats(guest)).status).toBe(403);
  });

  it('el piso no cierra la noche', async () => {
    const res = await api().post(url(`/nights/${night.id}/close`)).set(auth(waiter)).send({});
    expect(res.status).toBe(403);
  });

  it('el almacén tampoco', async () => {
    const almacen = await f.createUser(club.id, { role: 'warehouse' });
    expect((await stats(almacen)).status).toBe(403);
  });

  it('una noche de otro club no se lee desde aquí', async () => {
    const otro = await f.createNightclub({ slug: 'otro-noches', name: 'Otro' });
    const ajena = await pool.query(
      `INSERT INTO events_calendar (nightclub_id, name, event_date, doors_open_at, ticket_price)
       VALUES ($1,'Ajena',CURRENT_DATE,now(),100) RETURNING id`, [otro.id]);

    const res = await api().get(url(`/nights/${ajena.rows[0].id}/stats`)).set(auth(manager));
    expect(res.status).toBe(404);
  });
});

// ===========================================================================
// El rol en el corte
// ===========================================================================

describe('quién trabajó la noche', () => {
  it('el corte dice quién estaba asignado y quién de verdad llegó', async () => {
    const otro = await f.createUser(club.id, { role: 'waiter' });
    await api().post(url(`/nights/${night.id}/roster`)).set(auth(manager))
      .send({ user_id: waiter.id, section: 'ZONA ROJA' });
    await api().post(url(`/nights/${night.id}/roster`)).set(auth(manager))
      .send({ user_id: otro.id, section: 'TERRAZA' });
    await api().post(url('/staff/shifts/start')).set(auth(waiter)).send({});

    const s = (await stats()).body.stats;
    expect(s.staff.assigned).toBe(2);
    // Asignado y presente son dos cosas distintas: el segundo mesero no llegó.
    expect(s.staff.showed_up).toBe(1);
    const quienLlego = s.staff.people.find((p) => p.user_id === waiter.id);
    expect(quienLlego).toMatchObject({ showed_up: true, sections: ['ZONA ROJA'] });
    expect(s.staff.people.find((p) => p.user_id === otro.id).showed_up).toBe(false);
  });
});
