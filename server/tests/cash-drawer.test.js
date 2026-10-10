/**
 * El cajón de dinero y el cambio en la puerta (D96).
 *
 * Lo que tiene que ser cierto:
 *   * cobrar en efectivo encola el pulso que abre el cajón de ESA caja; con tarjeta no;
 *   * el pulso son los bytes ESC/POS correctos para el pin configurado;
 *   * un pulso viejo ya no se abre, ni se desvía a otra impresora, ni se reimprime;
 *   * abrir sin venta pide el PIN de un gerente y queda en la bitácora;
 *   * en la puerta, lo recibido (pesos, dólares o los dos) da el cambio en pesos con la
 *     misma regla de la caja, y el corte de la anfitriona separa los dólares.
 */
'use strict';

const { randomUUID } = require('crypto');
const { setupSchema, truncateAll, closePool, pool } = require('./helpers/db');
const pins = require('../src/services/pins');
const escpos = require('../src/services/escpos');
const printing = require('../src/services/printing');
const { api, auth } = require('./helpers/api');
const f = require('./helpers/factories');

let club; let manager; let cajero; let hostess; let waiter; let table; let beer; let pinGerente;

beforeAll(setupSchema);
afterAll(closePool);

const url = (p) => `/api/nightclubs/${club.id}${p}`;

beforeEach(async () => {
  await truncateAll();
  club = await f.createNightclub({ slug: 'ev2-cajon' });
  manager = await f.createUser(club.id, { role: 'manager', display_name: 'Gerente' });
  cajero = await f.createUser(club.id, { role: 'cashier', display_name: 'Caja Ana' });
  hostess = await f.createUser(club.id, { role: 'hostess', display_name: 'Sol' });
  waiter = await f.createUser(club.id, { role: 'waiter', display_name: 'Luis' });
  table = await f.createTable(club.id, { code: 'T-3', section: 'ZONA ROJA', capacity: 4 });
  beer = await f.createDrink(club.id, { name: 'Cerveza', price: 60, stock: 40 });
  const { rows } = await pool.query(
    `INSERT INTO events_calendar (nightclub_id, name, event_date, doors_open_at, ticket_price, status)
     VALUES ($1,'Viernes',(now() - interval '1 hour')::date, now() - interval '1 hour', 0, 'published')
     RETURNING id`, [club.id]);
  pinGerente = await pins.issuePin(pool, { userId: manager.id });
  await pool.query('UPDATE users SET must_change_pin = false WHERE id = $1', [manager.id]);
  await api().post(url(`/nights/${rows[0].id}/roster`)).set(auth(manager))
    .send({ user_id: cajero.id, location_id: club.bar_id });
  const abierta = await api().post(url('/till/open')).set(auth(cajero))
    .send({ opening_float: 1000, manager_pin: pinGerente });
  if (abierta.status !== 201) throw new Error(`abrir caja: ${abierta.status}`);
});

const altaImpresora = async (body) => {
  const res = await api().post(url('/printers')).set(auth(manager)).send(body);
  if (res.status !== 201) throw new Error(`impresora: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.printer;
};
const cajaConCajon = (pin = 2) => altaImpresora({
  location_id: club.bar_id, name: 'Caja PB', purpose: 'till', host: '192.168.1.70', drawer_pin: pin,
});
const puertaConCajon = (pin = 2) => altaImpresora({
  name: 'Puerta', purpose: 'door', host: '192.168.1.80', drawer_pin: pin,
});

/** Dos cervezas: $120. */
const pedido = async () => {
  const res = await api().post(url('/orders')).set(auth(waiter)).send({
    client_request_id: randomUUID(), table_id: table.id,
    items: [{ drink_id: beer.id, quantity: 2 }],
  });
  if (res.status !== 201) throw new Error(`pedido: ${res.status}`);
  return res.body.order;
};
const pagar = (order, body) => api().post(url('/till/payments')).set(auth(cajero))
  .send({ transaction_id: order.transaction_id, ...body });
const fijarTipo = async (rate) => {
  const res = await api().put(url('/exchange-rate')).set(auth(manager)).send({ rate });
  expect(res.status).toBe(201);
  return String(res.body.rate.id);
};
const drawerJobs = async () => (await pool.query(
  `SELECT id, printer_id::text AS printer_id, status, payload, preview, created_by::text AS created_by
     FROM print_jobs WHERE kind = 'drawer' ORDER BY created_at`)).rows;

describe('El pulso ESC/POS', () => {
  it('pin 2 y pin 5 son los bytes que piden los cajones', () => {
    expect([...escpos.drawerPulse(2)]).toEqual([0x1b, 0x40, 0x1b, 0x70, 0, 25, 250]);
    expect([...escpos.drawerPulse(5)]).toEqual([0x1b, 0x40, 0x1b, 0x70, 1, 25, 250]);
    expect(() => escpos.drawerPulse(3)).toThrow();
  });
});

describe('La caja abre su cajón al cobrar en efectivo', () => {
  it('efectivo: encola el pulso a la impresora de esa caja, con el pin configurado', async () => {
    const caja = await cajaConCajon(5);
    const res = await pagar(await pedido(), { method: 'cash', amount: 120, cash_received: 200 });
    expect(res.status).toBe(201);
    expect(res.body.drawer).toMatchObject({ status: 'queued' });
    const jobs = await drawerJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ printer_id: caja.id, status: 'pending', created_by: cajero.id });
    expect([...jobs[0].payload]).toEqual([...escpos.drawerPulse(5)]);
  });

  it('dólares también abren el cajón', async () => {
    await cajaConCajon();
    const tipo = await fijarTipo(17.35);
    const res = await pagar(await pedido(), { method: 'cash_usd', usd_received: 10, exchange_rate_id: tipo });
    expect(res.status).toBe(201);
    expect(res.body.drawer).toMatchObject({ status: 'queued' });
  });

  it('con voucher de terminal no se abre', async () => {
    await cajaConCajon();
    const res = await pagar(await pedido(), { method: 'card_terminal', amount: 120, reference: 'VCH123' });
    expect(res.status).toBe(201);
    expect(res.body.drawer).toBeNull();
    expect(await drawerJobs()).toHaveLength(0);
  });

  it('una caja sin cajón configurado cobra igual y lo dice', async () => {
    await altaImpresora({ location_id: club.bar_id, name: 'Caja PB', purpose: 'till', host: '192.168.1.70' });
    const res = await pagar(await pedido(), { method: 'cash', amount: 120 });
    expect(res.status).toBe(201);
    expect(res.body.drawer).toMatchObject({ status: 'no_drawer' });
    expect(await drawerJobs()).toHaveLength(0);
  });
});

describe('La cola trata el cajón distinto a un papel', () => {
  async function agente() {
    const a = await printing.createAgent(pool, { nightclubId: club.id, name: 'PC barra', createdBy: manager.id });
    return a.agent || a;
  }

  it('un pulso vencido ya no se entrega', async () => {
    await cajaConCajon();
    await pagar(await pedido(), { method: 'cash', amount: 120 });
    // Envejecer el pulso: el disparador de la tabla no deja editar un trabajo, así que
    // solo para esta línea se ejecuta en modo réplica (sin disparadores).
    const c = await pool.connect();
    try {
      await c.query("SET session_replication_role = 'replica'");
      await c.query(`UPDATE print_jobs SET created_at = now() - interval '5 minutes' WHERE kind = 'drawer'`);
      await c.query("SET session_replication_role = 'origin'");
    } finally { c.release(); }
    const pc = await agente();
    const tomados = await printing.claim(pool, { nightclubId: club.id, agentId: pc.id });
    expect(tomados.filter((j) => j.kind === 'drawer')).toHaveLength(0);
    const [job] = await drawerJobs();
    expect(job.status).toBe('failed');
  });

  it('si falla no se reintenta ni se desvía a la impresora de respaldo', async () => {
    const caja = await cajaConCajon();
    const otra = await altaImpresora({
      location_id: club.bar_id, name: 'Meseros PB', purpose: 'service', host: '192.168.1.71',
    });
    await api().patch(url(`/printers/${caja.id}`)).set(auth(manager)).send({ fallback_id: otra.id });
    await pagar(await pedido(), { method: 'cash', amount: 120 });
    const pc = await agente();
    const [tomado] = (await printing.claim(pool, { nightclubId: club.id, agentId: pc.id }))
      .filter((j) => j.kind === 'drawer');
    const out = await printing.markFailed(pool, {
      nightclubId: club.id, jobId: tomado.id, agentId: pc.id, error: 'sin papel',
    });
    expect(out.status).toBe('failed');
    expect(out.rerouted).toBeUndefined();
    expect(await drawerJobs()).toHaveLength(1);
  });

  it('abrir el cajón no se reimprime', async () => {
    await cajaConCajon();
    await pagar(await pedido(), { method: 'cash', amount: 120 });
    const [job] = await drawerJobs();
    await expect(printing.reprint(pool, { nightclubId: club.id, jobId: job.id, createdBy: manager.id }))
      .rejects.toThrow(/no se reimprime/);
  });
});

describe('Abrir sin venta', () => {
  const abrir = (user, body) => api().post(url('/cash-drawer/open')).set(auth(user)).send(body);

  it('el cajero lo abre con el PIN del gerente y queda en la bitácora', async () => {
    await cajaConCajon();
    const res = await abrir(cajero, { reason: 'Cambiar un billete', manager_pin: pinGerente });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ drawer: { status: 'queued' }, authorized_by: 'Gerente' });
    const { rows } = await pool.query(
      `SELECT actor_id::text AS actor, after FROM audit_log WHERE action = 'cash_drawer.open_no_sale'`);
    expect(rows).toHaveLength(1);
    expect(rows[0].actor).toBe(cajero.id);
    expect(rows[0].after).toMatchObject({ reason: 'Cambiar un billete', authorized_by: manager.id });
  });

  it('con un PIN equivocado no se abre nada', async () => {
    await cajaConCajon();
    const res = await abrir(cajero, { reason: 'Cambiar un billete', manager_pin: '000000' });
    expect(res.status).toBe(403);
    expect(await drawerJobs()).toHaveLength(0);
  });

  it('la anfitriona abre el de la puerta', async () => {
    const puerta = await puertaConCajon();
    const res = await abrir(hostess, { reason: 'Contar fondo', manager_pin: pinGerente });
    expect(res.status).toBe(201);
    expect((await drawerJobs())[0].printer_id).toBe(puerta.id);
  });

  it('sin cajón configurado lo dice', async () => {
    const res = await abrir(hostess, { reason: 'Contar fondo', manager_pin: pinGerente });
    expect(res.status).toBe(422);
  });

  it('un mesero no puede', async () => {
    await cajaConCajon();
    expect((await abrir(waiter, { reason: 'Nada', manager_pin: pinGerente })).status).toBe(403);
  });
});

describe('La impresora de la puerta', () => {
  it('no va en una barra, y hay una sola por club', async () => {
    await puertaConCajon();
    const otra = await api().post(url('/printers')).set(auth(manager))
      .send({ name: 'Puerta 2', purpose: 'door', host: '192.168.1.81' });
    expect(otra.status).toBe(409);
    const conBarra = await api().post(url('/printers')).set(auth(manager))
      .send({ location_id: club.bar_id, name: 'Puerta 3', purpose: 'door', host: '192.168.1.82' });
    expect(conBarra.status).toBe(400);
    const sinBarra = await api().post(url('/printers')).set(auth(manager))
      .send({ name: 'Caja sin barra', purpose: 'till', host: '192.168.1.83' });
    expect(sinBarra.status).toBe(400);
  });

  it('el gerente prueba el cajón desde el panel', async () => {
    const puerta = await puertaConCajon(5);
    const res = await api().post(url(`/printers/${puerta.id}/test-drawer`)).set(auth(manager)).send({});
    expect(res.status).toBe(202);
    expect(res.body.drawer).toMatchObject({ status: 'queued' });
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'cash_drawer.test'`);
    expect(rows[0].n).toBe(1);
  });
});

describe('El cambio en la puerta', () => {
  let cover;
  beforeEach(async () => {
    const res = await api().post(url('/cover-prices')).set(auth(manager))
      .send({ name: 'COVER', amount: 300, currency: 'MXN' });
    expect(res.status).toBe(201);
    cover = res.body.cover_price || res.body.cover;
  });
  const vender = (body) => api().post(url('/door/admissions')).set(auth(hostess)).send({
    kind: 'general', quantity: 1, cover_price_id: cover.id, payment_method: 'cash',
    client_request_id: randomUUID(), ...body,
  });

  it('pesos: cambio exacto, se guarda y abre el cajón de la puerta', async () => {
    const puerta = await puertaConCajon();
    const res = await vender({ cash_received: 500 });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ change_given: '200.00', drawer: { status: 'queued' } });
    expect(res.body.admission).toMatchObject({ cash_received: '500.00', change_given: '200.00' });
    expect((await drawerJobs())[0].printer_id).toBe(puerta.id);
  });

  it('dólares y pesos juntos: el cambio sale en pesos, lo de dólares redondeado hacia abajo', async () => {
    const tipo = await fijarTipo(17.35);
    // US$20 = $347.00 > $300: sobran $47.00 de dólares; los $100 en pesos vuelven completos.
    const res = await vender({ usd_received: 20, cash_received: 100, exchange_rate_id: tipo });
    expect(res.status).toBe(201);
    expect(res.body.change_given).toBe('147.00');
    // US$10 = $173.50; faltan $126.50 en pesos; da $200 → cambio $73.50.
    const r2 = await vender({ usd_received: 10, cash_received: 200, exchange_rate_id: tipo });
    expect(r2.body.change_given).toBe('73.50');
    // US$18 = $312.30 → sobran $12.30 → se dan $12.
    const r3 = await vender({ usd_received: 18, exchange_rate_id: tipo });
    expect(r3.body.change_given).toBe('12.00');
  });

  it('si no alcanza no se vende', async () => {
    const res = await vender({ cash_received: 250 });
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/Faltan \$50\.00/);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM door_admissions');
    expect(rows[0].n).toBe(0);
  });

  it('con un tipo de cambio viejo se para', async () => {
    const viejo = await fijarTipo(17.35);
    await fijarTipo(18);
    const res = await vender({ usd_received: 20, exchange_rate_id: viejo });
    expect(res.status).toBe(409);
  });

  it('lo recibido no aplica a tarjeta', async () => {
    const res = await vender({ payment_method: 'card', cash_received: 500 });
    expect(res.status).toBe(400);
  });

  it('el corte de la anfitriona cuenta los dólares aparte y descuenta el cambio de dólares', async () => {
    const tipo = await fijarTipo(17.35);
    expect((await api().post(url('/staff/shifts/start')).set(auth(hostess)).send({})).status).toBe(201);
    await vender({ cash_received: 300 }); // $300 en pesos
    await vender({ usd_received: 20, exchange_rate_id: tipo }); // $300 con dólares, $47 de cambio
    const res = await api().get(url('/shifts/me/cut')).set(auth(hostess));
    expect(res.status).toBe(200);
    const totals = res.body.totals || res.body.cut || res.body;
    const porMetodo = Object.fromEntries((totals.by_method || []).map((l) => [l.method, l.amount]));
    expect(porMetodo.cash).toBe('300.00');
    expect(porMetodo.cash_usd).toBe('300.00');
    expect(totals.usd).toMatchObject({ received: '20.00', change_given_mxn: '47.00' });
  });
});
