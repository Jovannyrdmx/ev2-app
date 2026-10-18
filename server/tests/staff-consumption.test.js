/**
 * El consumo del personal (D101): un empleado pide para si desde su telefono, no paga en
 * la caja, y lo que consume se le descuenta del pago. El gerente ve cada semana, de
 * jueves a miercoles, cuanto se le descuenta a cada quien.
 */
'use strict';

const { randomUUID } = require('crypto');
const { setupSchema, truncateAll, closePool, pool } = require('./helpers/db');
const { api, auth } = require('./helpers/api');
const f = require('./helpers/factories');
const pins = require('../src/services/pins');
const consumption = require('../src/services/staff-consumption');
const nightStats = require('../src/services/night-stats');

let club; let manager; let admin; let waiter; let bartender; let dancer; let guest; let beer;

beforeAll(setupSchema);
afterAll(closePool);
beforeEach(async () => {
  await truncateAll();
  club = await f.createNightclub({ slug: 'ev2-personal' });
  manager = await f.createUser(club.id, { role: 'manager', display_name: 'Gerente' });
  admin = await f.createUser(club.id, { role: 'admin' });
  waiter = await f.createUser(club.id, { role: 'waiter', display_name: 'Luis Pérez' });
  bartender = await f.createUser(club.id, { role: 'bartender', display_name: 'Sol Díaz' });
  dancer = await f.createUser(club.id, { role: 'dancer', display_name: 'Ana López' });
  guest = await f.createUser(club.id, { role: 'guest' });
  beer = await f.createDrink(club.id, { name: 'Cerveza Coronita', price: 60, stock: 40 });
});

const url = (p) => `/api/nightclubs/${club.id}${p}`;
const setPct = (pct, user = manager) => api().put(url('/staff-consumption/settings'))
  .set(auth(user)).send({ discount_pct: pct });
const pedir = (user = waiter, over = {}) => api().post(url('/staff-orders')).set(auth(user)).send({
  client_request_id: randomUUID(),
  items: [{ drink_id: beer.id, quantity: 2 }],
  ...over,
});
const pinOf = async (user) => {
  const pin = await pins.issuePin(pool, { userId: user.id });
  await pool.query('UPDATE users SET must_change_pin = false WHERE id = $1', [user.id]);
  return pin;
};
const semana = (user = manager, q = '') => api().get(url(`/staff-consumption/weekly${q}`)).set(auth(user));

describe('el porcentaje de descuento', () => {
  it('sin porcentaje la función está apagada: no se inventa un descuento', async () => {
    const res = await api().get(url('/staff-consumption/settings')).set(auth(waiter));
    expect(res.body).toEqual({ discount_pct: null, enabled: false });
    const pedido = await pedir();
    expect(pedido.status).toBe(409);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM drink_orders');
    expect(rows[0].n).toBe(0);
  });

  it('solo el gerente lo fija, entre 0 y 100, y queda en la auditoría', async () => {
    expect((await setPct(40, waiter)).status).toBe(403);
    expect((await setPct(101)).status).toBe(400);
    expect((await setPct(-1)).status).toBe(400);
    expect((await setPct(40)).status).toBe(200);
    const res = await api().get(url('/staff-consumption/settings')).set(auth(waiter));
    expect(res.body).toEqual({ discount_pct: 40, enabled: true });
    const { rows } = await pool.query(
      `SELECT actor_id FROM audit_log WHERE action = 'staff_consumption.set_discount'`);
    expect(rows).toHaveLength(1);
    expect(rows[0].actor_id).toBe(manager.id);
  });
});

describe('el empleado pide para sí', () => {
  beforeEach(async () => { await setPct(40); });

  it('nace confirmado, sin cobro en el libro, con el descuento y su nombre y puesto', async () => {
    const res = await pedir();
    expect(res.status).toBe(201);
    expect(res.body.order.status).toBe('confirmed');
    expect(res.body.order.staff_consumption).toBe(true);
    expect(res.body.order.sender_name).toBe('Luis Pérez');
    expect(res.body.order.sender_role).toBe('waiter');
    expect(res.body.order.payment_status).toBe('not_required');
    expect(res.body.consumption).toMatchObject({ discount_pct: 40, list_total: 120, amount: 72 });

    const tx = await pool.query(
      `SELECT count(*)::int AS n FROM transactions WHERE reference_id = $1`, [res.body.order.id]);
    expect(tx.rows[0].n).toBe(0);
    const { rows } = await pool.query(
      'SELECT user_name, user_role, list_total::text, amount::text, status FROM staff_consumptions');
    expect(rows).toEqual([{
      user_name: 'Luis Pérez', user_role: 'waiter', list_total: '120.00', amount: '72.00', status: 'active',
    }]);
  });

  it('descuenta existencias como cualquier pedido', async () => {
    const antes = await f.supplyStock(beer.supply_id);
    await pedir();
    const despues = await f.supplyStock(beer.supply_id);
    expect(despues).toBeLessThan(antes);
  });

  it('el cliente y el admin no piden por aquí', async () => {
    expect((await pedir(guest)).status).toBe(403);
    expect((await pedir(admin)).status).toBe(403);
  });

  it('el gerente sí pide su consumo y entra al reporte semanal (D116)', async () => {
    const res = await pedir(manager);
    expect(res.status).toBe(201);
    const mio = await api().get(url('/staff-consumption/me')).set(auth(manager));
    expect(mio.status).toBe(200);
    const rep = await semana(manager);
    expect(JSON.stringify(rep.body)).toMatch(/Gerente/);
  });

  it('es idempotente: el doble toque no descuenta dos veces', async () => {
    const id = randomUUID();
    const a = await pedir(waiter, { client_request_id: id });
    const b = await pedir(waiter, { client_request_id: id });
    expect(a.status).toBe(201);
    expect(b.status).toBe(200);
    expect(b.body.order.id).toBe(a.body.order.id);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM staff_consumptions');
    expect(rows[0].n).toBe(1);
  });

  it('no cuenta como venta de la noche', async () => {
    const res = await pedir();
    await api().post(url(`/orders/${res.body.order.id}/status`)).set(auth(bartender))
      .send({ status: 'ready' });
    await api().post(url(`/orders/${res.body.order.id}/status`)).set(auth(manager))
      .send({ status: 'delivered' });
    const bar = await nightStats.bar({
      nightclubId: club.id, from: new Date(Date.now() - 36e5), to: new Date(Date.now() + 36e5),
    });
    expect(bar.orders).toBe(0);
    expect(bar.revenue).toBe(0);
  });

  it('la comanda dice quién lo pidió y su puesto', async () => {
    await api().patch(url('/print-settings')).set(auth(admin)).send({ print_order_tickets: true });
    await api().post(url('/printers')).set(auth(manager)).send({
      location_id: club.bar_id, name: 'Barra comandas', purpose: 'orders',
      connection: 'network', host: '192.168.1.50',
    });
    await pedir();
    const { rows } = await pool.query(
      `SELECT preview FROM print_jobs WHERE nightclub_id = $1 AND kind = 'order'`, [club.id]);
    expect(rows).toHaveLength(1);
    expect(rows[0].preview).toContain('PERSONAL: Luis Pérez - Mesero');
  });
});

describe('el reporte semanal', () => {
  beforeEach(async () => { await setPct(40); });

  it('la semana de pago abre el jueves y cierra el miércoles', async () => {
    const c = (date) => consumption.weekStartOf(pool, { nightclubId: club.id, date });
    expect(await c('2026-10-08')).toBe('2026-10-08'); // jueves
    expect(await c('2026-10-10')).toBe('2026-10-08'); // sábado
    expect(await c('2026-10-11')).toBe('2026-10-08'); // domingo
    expect(await c('2026-10-14')).toBe('2026-10-08'); // miércoles
    expect(await c('2026-10-15')).toBe('2026-10-15'); // jueves siguiente
  });

  it('suma por empleado con su nombre y puesto, y solo el gerente lo ve', async () => {
    await pedir(waiter);
    await pedir(waiter, { items: [{ drink_id: beer.id, quantity: 1 }] });
    await pedir(dancer);
    expect((await semana(waiter)).status).toBe(403);

    const res = await semana();
    expect(res.status).toBe(200);
    const luis = res.body.employees.find((e) => e.name === 'Luis Pérez');
    const ana = res.body.employees.find((e) => e.name === 'Ana López');
    expect(luis).toMatchObject({ role: 'waiter', role_label: 'Mesero', count: 2 });
    expect(luis.totals.MXN).toBe('108.00'); // 72 + 36
    expect(ana).toMatchObject({ role: 'dancer', role_label: 'Bailarina', count: 1 });
    expect(res.body.totals.MXN).toBe('180.00');
    expect(luis.consumptions[0].items[0]).toMatchObject({ name: 'Cerveza Coronita' });
  });

  it('el nombre y el puesto son los de ese día, aunque después cambien', async () => {
    await pedir(waiter);
    await pool.query(`UPDATE users SET display_name = 'Otro Nombre', role = 'valet' WHERE id = $1`,
      [waiter.id]);
    const res = await semana();
    expect(res.body.employees[0]).toMatchObject({ name: 'Luis Pérez', role: 'waiter' });
  });

  it('una semana distinta no mezcla consumos', async () => {
    await pedir(waiter);
    const res = await semana(manager, '?week_start=2026-01-01');
    expect(res.body.employees).toEqual([]);
    expect(res.body.week_start).toBe(
      await consumption.weekStartOf(pool, { nightclubId: club.id, date: '2026-01-01' }));
  });

  it('el CSV trae una fila por consumo y un total por empleado', async () => {
    await pedir(waiter);
    const res = await semana(manager, '?format=csv');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toMatch(/consumo-personal-\d{4}-\d{2}-\d{2}\.csv/);
    expect(res.text).toContain('Luis Pérez,Mesero');
    expect(res.text).toContain('2 x Cerveza Coronita');
    expect(res.text).toContain('TOTAL');
  });

  it('el CSV no deja que un nombre se abra como fórmula', () => {
    const csv = consumption.reportCsv({
      employees: [{
        name: '=HYPERLINK("x")', role_label: 'Mesero', totals: {}, consumptions: [],
      }, {
        name: '+cmd', role_label: 'Mesero', totals: { MXN: '1.00' }, consumptions: [],
      }],
    });
    expect(csv).toContain("'+cmd");
    expect(csv).not.toMatch(/(^|,)\+cmd/m);
  });

  it('lo que llevo yo: solo lo mío', async () => {
    await pedir(waiter);
    await pedir(dancer);
    const res = await api().get(url('/staff-consumption/me')).set(auth(waiter));
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.totals.MXN).toBe('72.00');
    expect((await api().get(url('/staff-consumption/me')).set(auth(guest))).status).toBe(403);
  });

  it('un pedido cancelado deja de descontarse', async () => {
    const res = await pedir(waiter);
    const cancel = await api().post(url(`/orders/${res.body.order.id}/status`)).set(auth(bartender))
      .send({ status: 'cancelled', reason: 'Se equivocó', manager_pin: await pinOf(manager) });
    expect(cancel.status).toBe(200);
    const rep = await semana();
    expect(rep.body.employees).toEqual([]);
    const { rows } = await pool.query('SELECT status FROM staff_consumptions');
    expect(rows[0].status).toBe('cancelled');
  });
});
