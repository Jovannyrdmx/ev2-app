/**
 * Promociones por evento (D102, parte B): el servidor calcula el precio, la promo vive
 * solo en la noche de su evento y dentro de su horario, y las ventas, la comanda y el
 * consumo del personal cuadran con lo cobrado.
 */
'use strict';

const { randomUUID } = require('crypto');
const { setupSchema, truncateAll, closePool, pool } = require('./helpers/db');
const { api, auth } = require('./helpers/api');
const f = require('./helpers/factories');
const promotions = require('../src/services/promotions');
const nightStats = require('../src/services/night-stats');

describe('cuentas puras', () => {
  const drinks = new Map([['a', { id: 'a', price: 60, category: 'beer' }]]);
  const two = { id: 'p', kind: 'n_for_m', buy_qty: 2, pay_qty: 1 };

  test('2x1: lleva 3 paga 2, lleva 4 paga 2', () => {
    expect(promotions.totalCents(60, 3, two)).toBe(12000);
    expect(promotions.totalCents(60, 4, two)).toBe(12000);
    expect(promotions.totalCents(60, 1, two)).toBe(6000);
  });

  test('precio fijo nunca sube el precio y porcentaje redondea una vez por pieza', () => {
    expect(promotions.totalCents(60, 2, { kind: 'fixed_price', value: 45 })).toBe(9000);
    expect(promotions.totalCents(60, 2, { kind: 'fixed_price', value: 90 })).toBe(12000);
    expect(promotions.totalCents(33.33, 3, { kind: 'percent', value: 10 })).toBe(9000);
  });

  test('gana la que deja el total mas bajo, sin acumular', () => {
    const pct = { id: 'q', kind: 'percent', value: 20 };
    expect(promotions.bestPromo(60, 2, [pct, two]).id).toBe('p');
    expect(promotions.bestPromo(60, 1, [pct, two]).id).toBe('q');
    expect(promotions.bestPromo(60, 1, [])).toBeNull();
  });

  test('una bebida repetida en dos renglones cuenta junta', () => {
    const lines = [{ drink_id: 'a', quantity: 1 }, { drink_id: 'a', quantity: 1 }];
    const out = promotions.priceLines(lines, drinks, () => [two]);
    expect(out.map((l) => l.totalCents)).toEqual([6000, 0]);
    expect(out[0].unitPrice).toBe(60);
    expect(out[0].lineTotal).toBe(60);
  });
});

let club; let manager; let waiter; let beer; let gin; let event;

beforeAll(setupSchema);
afterAll(closePool);
beforeEach(async () => {
  await truncateAll();
  club = await f.createNightclub({ slug: 'ev2-promos' });
  manager = await f.createUser(club.id, { role: 'manager', display_name: 'Gerente' });
  waiter = await f.createUser(club.id, { role: 'waiter', on_shift: true, display_name: 'Luis Pérez' });
  beer = await f.createDrink(club.id, { name: 'Cerveza', price: 60, category: 'beer', stock: 100 });
  gin = await f.createDrink(club.id, { name: 'Gin', price: 200, category: 'spirits', stock: 100 });
  event = await crearEvento();
});

const url = (p) => `/api/nightclubs/${club.id}${p}`;

/** Un evento de la noche de negocio de hoy en la zona del club. */
async function crearEvento(status = 'published') {
  const { rows } = await pool.query(
    `INSERT INTO events_calendar (nightclub_id, name, event_date, doors_open_at, status)
     SELECT c.id, 'Noche de prueba ' || gen_random_uuid()::text,
            ((now() AT TIME ZONE c.timezone) - interval '6 hours')::date, now(), $2
       FROM nightclubs c WHERE c.id = $1 RETURNING id`, [club.id, status]);
  return rows[0];
}
const crear = (body, user = manager, ev = event) => api()
  .post(url(`/events/${ev.id}/promotions`)).set(auth(user)).send(body);
const pedir = (user, items) => api().post(url('/orders')).set(auth(user))
  .send({ client_request_id: randomUUID(), items });

describe('el gerente administra las promociones', () => {
  it('solo gerente crea; valida el tipo y a que aplica', async () => {
    const ok = { name: '2x1 cerveza', kind: 'n_for_m', buy_qty: 2, pay_qty: 1, drink_id: beer.id };
    expect((await crear(ok, waiter)).status).toBe(403);
    expect((await crear({ ...ok, pay_qty: 2 })).status).toBe(422);
    expect((await crear({ ...ok, category: 'beer' })).status).toBe(422);
    expect((await crear({ name: 'x', kind: 'percent', value: 0, drink_id: beer.id })).status).toBe(422);
    expect((await crear({ ...ok, starts_time: '22:00' })).status).toBe(422);
    expect((await crear({ ...ok, category: undefined, drink_id: randomUUID() })).status).toBe(404);
    const res = await crear(ok);
    expect(res.status).toBe(201);
    expect(res.body.promotion).toMatchObject({ kind: 'n_for_m', buy_qty: 2, pay_qty: 1, active: true });
    const { rows } = await pool.query(`SELECT actor_id FROM audit_log WHERE action = 'promotion.create'`);
    expect(rows[0].actor_id).toBe(manager.id);
  });

  it('se apaga con PATCH y deja de aplicar; no se borra', async () => {
    const c = await crear({ name: '-50%', kind: 'percent', value: 50, drink_id: beer.id });
    const id = c.body.promotion.id;
    expect((await api().patch(url(`/promotions/${id}`)).set(auth(waiter)).send({ active: false })).status).toBe(403);
    const off = await api().patch(url(`/promotions/${id}`)).set(auth(manager)).send({ active: false });
    expect(off.body.promotion.active).toBe(false);
    const vigentes = await api().get(url('/promotions/active')).set(auth(waiter));
    expect(vigentes.body.promotions).toEqual([]);
    const lista = await api().get(url(`/events/${event.id}/promotions`)).set(auth(manager));
    expect(lista.body.promotions).toHaveLength(1);
  });
});

describe('el precio en el pedido', () => {
  it('sin promocion todo cuesta como siempre y line_total queda nulo', async () => {
    const res = await pedir(waiter, [{ drink_id: beer.id, quantity: 2 }]);
    expect(res.status).toBe(201);
    expect(Number(res.body.order.subtotal)).toBe(120);
    const { rows } = await pool.query('SELECT line_total, promo_id FROM drink_order_items');
    expect(rows).toEqual([{ line_total: null, promo_id: null }]);
  });

  it('2x1 cobra la mitad, guarda precio de carta y la promo, y el cargo cuadra', async () => {
    const c = await crear({ name: '2x1 cerveza', kind: 'n_for_m', buy_qty: 2, pay_qty: 1, drink_id: beer.id });
    const res = await pedir(waiter, [{ drink_id: beer.id, quantity: 2 }, { drink_id: gin.id, quantity: 1 }]);
    expect(res.status).toBe(201);
    expect(Number(res.body.order.subtotal)).toBe(260);
    const cerveza = res.body.order.items.find((i) => i.name === 'Cerveza');
    expect(cerveza).toMatchObject({ unit_price: '60.00', list_price: '60.00', line_total: '60.00', promo: '2x1 cerveza' });
    const gen = res.body.order.items.find((i) => i.name === 'Gin');
    expect(gen.promo).toBeNull();
    const tx = await pool.query('SELECT amount::text FROM transactions WHERE reference_id = $1', [res.body.order.id]);
    expect(tx.rows[0].amount).toBe('260.00');
    expect(c.status).toBe(201);
  });

  it('por categoria, y el cliente no puede mandar un precio', async () => {
    await crear({ name: 'Licores -25%', kind: 'percent', value: 25, category: 'spirits' });
    const res = await api().post(url('/orders')).set(auth(waiter)).send({
      client_request_id: randomUUID(), items: [{ drink_id: gin.id, quantity: 1, unit_price: 1 }] });
    expect(res.status).toBe(201);
    expect(Number(res.body.order.subtotal)).toBe(150);
  });

  it('una promo de otra noche, de un evento cancelado o fuera de horario no aplica', async () => {
    // Otra noche (manana): su promo no aplica hoy.
    const { rows: [otra] } = await pool.query(
      `INSERT INTO events_calendar (nightclub_id, name, event_date, doors_open_at, status)
       SELECT c.id, 'Manana', ((now() AT TIME ZONE c.timezone) - interval '6 hours')::date + 1,
              now(), 'published' FROM nightclubs c WHERE c.id = $1 RETURNING id`, [club.id]);
    await crear({ name: 'Mañana', kind: 'percent', value: 50, drink_id: beer.id }, manager, otra);
    const manana = await pedir(waiter, [{ drink_id: beer.id, quantity: 1 }]);
    expect(Number(manana.body.order.subtotal)).toBe(60);

    // Evento de hoy cancelado: la promo deja de aplicar.
    const hoy = await crear({ name: 'Cancelada', kind: 'percent', value: 50, drink_id: beer.id });
    await pool.query(`UPDATE events_calendar SET status = 'cancelled' WHERE id = $1`, [event.id]);
    const canc = await pedir(waiter, [{ drink_id: beer.id, quantity: 1 }]);
    expect(Number(canc.body.order.subtotal)).toBe(60);
    await pool.query(`UPDATE events_calendar SET status = 'published' WHERE id = $1`, [event.id]);
    await api().patch(url(`/promotions/${hoy.body.promotion.id}`)).set(auth(manager)).send({ active: false });

    const c = await crear({ name: 'Madrugada', kind: 'percent', value: 50, drink_id: beer.id });
    // Una ventana de una hora que empieza dentro de 2 horas: ahora no esta vigente.
    await pool.query(
      `UPDATE event_promotions p
          SET starts_time = ((now() AT TIME ZONE n.timezone) + interval '2 hours')::time,
              ends_time   = ((now() AT TIME ZONE n.timezone) + interval '3 hours')::time
         FROM nightclubs n WHERE p.id = $1 AND n.id = p.nightclub_id`, [c.body.promotion.id]);
    const res = await pedir(waiter, [{ drink_id: beer.id, quantity: 1 }]);
    expect(Number(res.body.order.subtotal)).toBe(60);

    // Y una ventana que cruza la medianoche y SI incluye ahora.
    await pool.query(
      `UPDATE event_promotions p
          SET starts_time = ((now() AT TIME ZONE n.timezone) - interval '1 hour')::time,
              ends_time   = ((now() AT TIME ZONE n.timezone) + interval '1 hour')::time
         FROM nightclubs n WHERE p.id = $1 AND n.id = p.nightclub_id`, [c.body.promotion.id]);
    const dentro = await pedir(waiter, [{ drink_id: beer.id, quantity: 1 }]);
    expect(Number(dentro.body.order.subtotal)).toBe(30);
  });

  it('las ventas de la noche suman el total del renglon, no precio x cantidad', async () => {
    await crear({ name: '2x1', kind: 'n_for_m', buy_qty: 2, pay_qty: 1, drink_id: beer.id });
    const res = await pedir(waiter, [{ drink_id: beer.id, quantity: 2 }]);
    await pool.query(`UPDATE drink_orders SET status = 'delivered' WHERE id = $1`, [res.body.order.id]);
    const stats = await nightStats.bar({
      nightclubId: club.id, from: new Date(Date.now() - 3600e3), to: new Date(Date.now() + 3600e3) });
    expect(stats.revenue).toBe(60);
    expect(stats.by_category.find((c) => c.category === 'beer').revenue).toBe(60);
  });
});

describe('consumo del personal con promociones', () => {
  const pedirPersonal = (items) => api().post(url('/staff-orders')).set(auth(waiter))
    .send({ client_request_id: randomUUID(), items });

  it('se le descuenta el menor entre la promo y el precio de personal', async () => {
    await api().put(url('/staff-consumption/settings')).set(auth(manager)).send({ discount_pct: 40 });
    // 2x1 en cerveza: 2 piezas = $60 (50%), mejor que el 40% de personal ($72).
    await crear({ name: '2x1', kind: 'n_for_m', buy_qty: 2, pay_qty: 1, drink_id: beer.id });
    const a = await pedirPersonal([{ drink_id: beer.id, quantity: 2 }]);
    expect(a.status).toBe(201);
    expect(a.body.consumption).toMatchObject({ list_total: 120, amount: 60 });
    // Gin con -10%: ($180) pierde contra el 40% de personal ($120).
    await crear({ name: 'Gin -10%', kind: 'percent', value: 10, drink_id: gin.id });
    const b = await pedirPersonal([{ drink_id: gin.id, quantity: 1 }]);
    expect(b.body.consumption).toMatchObject({ list_total: 200, amount: 120 });
  });
});

describe('las listas de bebidas', () => {
  it('cada bebida dice su promocion vigente, o null', async () => {
    await crear({ name: '2x1 cerveza', kind: 'n_for_m', buy_qty: 2, pay_qty: 1, drink_id: beer.id });
    await crear({ name: 'Licores $150', kind: 'fixed_price', value: 150, category: 'spirits' });
    const res = await api().get(url('/drinks')).set(auth(waiter));
    const por = Object.fromEntries(res.body.drinks.map((d) => [d.name, d.promo]));
    expect(por.Cerveza).toMatchObject({ badge: '2x1', kind: 'n_for_m', unit_price: null });
    expect(por.Gin).toMatchObject({ badge: '$150', kind: 'fixed_price', unit_price: 150 });
    const sin = await f.createDrink(club.id, { name: 'Agua', price: 20, category: 'soft', stock: 5 });
    const otra = await api().get(url('/drinks')).set(auth(waiter));
    expect(otra.body.drinks.find((d) => d.id === sin.id).promo).toBeNull();
  });
});
