/**
 * Varias cajas por barra (D126): una con PC y otra con teléfono.
 *
 *   * Cada barra (y Cover) nace con su caja; una barra puede tener más.
 *   * Dos cajeros abren dos cajas de la MISMA barra: cada uno cobra los pedidos de esa
 *     barra, el cajón y el recibo salen en la impresora de SU caja, y el pedido no se
 *     cobra dos veces.
 *   * El rol de la noche dice en qué caja va cada cajero; sin eso no se abre.
 *   * La caja del teléfono imprime en una impresora de red que saca una PC del club.
 *   * La terminal Point es de la caja.
 */
'use strict';

const { randomUUID } = require('crypto');
const { setupSchema, truncateAll, closePool, pool } = require('./helpers/db');
const { api, auth } = require('./helpers/api');
const pairing = require('./helpers/pairing');
const f = require('./helpers/factories');
const pins = require('../src/services/pins');

let club; let manager; let cajeroPc; let cajeroTel; let waiter; let table; let beer;
let pinGerente; let noche; let cajaPc; let cajaTel; let pc;

beforeAll(setupSchema);
afterAll(closePool);

const url = (p) => `/api/nightclubs/${club.id}${p}`;

async function codigoDe(user) {
  const pin = await pins.issuePin(pool, { userId: user.id });
  await pool.query('UPDATE users SET must_change_pin = false WHERE id = $1', [user.id]);
  return pin;
}

const jobs = async (kind) => (await pool.query(
  `SELECT id::text AS id, kind, preview, printer_id::text AS printer_id FROM print_jobs
    WHERE nightclub_id = $1 AND kind = $2::text ORDER BY created_at`, [club.id, kind])).rows;

beforeEach(async () => {
  await truncateAll();
  club = await f.createNightclub({ slug: 'ev2-cajas' });
  manager = await f.createUser(club.id, { role: 'manager', display_name: 'Gerente Ana' });
  cajeroPc = await f.createUser(club.id, { role: 'cashier', display_name: 'Cajero PC' });
  cajeroTel = await f.createUser(club.id, { role: 'cashier', display_name: 'Cajera Tel' });
  waiter = await f.createUser(club.id, { role: 'waiter', on_shift: true, display_name: 'Luis' });
  table = await f.createTable(club.id, { code: 'T-1', section: 'ZONA ROJA', capacity: 4 });
  beer = await f.createDrink(club.id, { name: 'Cerveza', price: 60, stock: 40 });
  await pool.query(
    `INSERT INTO zone_bars (nightclub_id, section, location_id) VALUES ($1,'ZONA ROJA',$2)`,
    [club.id, club.bar_id]);
  pinGerente = await codigoDe(manager);
  const { rows } = await pool.query(
    `INSERT INTO events_calendar (nightclub_id, name, event_date, doors_open_at, ticket_price, status)
     VALUES ($1,'Viernes',(now() - interval '1 hour')::date, now() - interval '1 hour', 0, 'published')
     RETURNING id`, [club.id]);
  noche = rows[0];
  // Una PC del club que atiende todo (la que imprime la impresora de red del teléfono).
  const agente = await pool.query(
    `INSERT INTO print_agents (nightclub_id, name, token_hash, token_hint, last_seen_at)
     VALUES ($1,'PC Barra baja',$2,'abcd', now()) RETURNING id::text AS id`,
    [club.id, randomUUID().replace(/-/g, '')]);
  pc = agente.rows[0];

  const lista = await api().get(url('/till-setup')).set(auth(manager));
  cajaPc = lista.body.tills.find((t) => t.location_id === club.bar_id);
});

async function segundaCaja() {
  const res = await api().post(url('/till-setup')).set(auth(manager))
    .send({ location_id: club.bar_id, name: 'Caja teléfono PB', device: 'phone' });
  expect(res.status).toBe(201);
  cajaTel = res.body.till;
  return cajaTel;
}

const asignar = (user, body = {}) => api().post(url(`/nights/${noche.id}/roster`)).set(auth(manager))
  .send({ user_id: user.id, location_id: club.bar_id, ...body });
const abrir = (user) => api().post(url('/till/open')).set(auth(user))
  .send({ opening_float: 500, manager_pin: pinGerente });

async function pedido() {
  const res = await api().post(url('/orders')).set(auth(waiter)).send({
    client_request_id: randomUUID(), table_id: table.id, items: [{ drink_id: beer.id, quantity: 1 }],
  });
  expect(res.status).toBe(201);
  return res.body.order;
}

describe('Las cajas del club (D126)', () => {
  it('cada barra y Cover nacen con su caja, con el nombre del lugar', async () => {
    const lista = await api().get(url('/till-setup')).set(auth(manager));
    expect(lista.status).toBe(200);
    const nombres = lista.body.tills.map((t) => t.name).sort();
    expect(nombres).toEqual(['Barra planta alta', 'Barra planta baja']);
    expect(cajaPc).toMatchObject({ device: 'pc', active: true, sections: ['ZONA ROJA'] });
    expect(cajaPc.issues.map((i) => i.code)).toContain('no_printer');
    const cover = await f.coverOf(club.id);
    const conCover = await api().get(url('/till-setup')).set(auth(manager));
    expect(conCover.body.tills.some((t) => t.location_id === cover)).toBe(true);
  });

  it('se agrega una caja de teléfono a la barra; Cover no admite otra; nombres no se repiten', async () => {
    await segundaCaja();
    expect(cajaTel).toMatchObject({ device: 'phone', location_id: club.bar_id });
    const cover = await f.coverOf(club.id);
    const otraCover = await api().post(url('/till-setup')).set(auth(manager))
      .send({ location_id: cover, name: 'Cover 2' });
    expect(otraCover.status).toBe(422);
    const repetida = await api().post(url('/till-setup')).set(auth(manager))
      .send({ location_id: club.bar_id, name: 'caja TELÉFONO pb' });
    expect(repetida.status).toBe(409);
    const cajero = await api().post(url('/till-setup')).set(auth(cajeroPc))
      .send({ location_id: club.bar_id, name: 'X' });
    expect(cajero.status).toBe(403);
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM audit_log WHERE action = 'till.create' AND nightclub_id = $1`, [club.id]);
    expect(rows[0].n).toBe(1);
  });

  it('no se apaga la última caja de una barra, ni una caja abierta', async () => {
    const sola = await api().patch(url(`/till-setup/${cajaPc.id}`)).set(auth(manager)).send({ active: false });
    expect(sola.status).toBe(422);
    await segundaCaja();
    await asignar(cajeroTel, { till_id: cajaTel.id });
    expect((await abrir(cajeroTel)).status).toBe(201);
    const abierta = await api().patch(url(`/till-setup/${cajaTel.id}`)).set(auth(manager)).send({ active: false });
    expect(abierta.status).toBe(409);
    const ok = await api().patch(url(`/till-setup/${cajaPc.id}`)).set(auth(manager)).send({ active: false, name: 'Caja vieja' });
    expect(ok.status).toBe(200);
    expect(ok.body.till).toMatchObject({ active: false, name: 'Caja vieja' });
  });
});

describe('Dos cajas en la misma barra', () => {
  beforeEach(async () => {
    await segundaCaja();
    // La caja de la PC con su impresora (de red aquí para no depender de USB) y la del
    // teléfono con la suya.
    const a = await api().post(url(`/till-setup/${cajaPc.id}/printer`)).set(auth(manager))
      .send({ host: '192.168.1.60', drawer_pin: 2 });
    expect(a.status).toBe(201);
    cajaPc.printer = a.body.printer;
    const b = await api().post(url(`/till-setup/${cajaTel.id}/printer`)).set(auth(manager))
      .send({ host: '192.168.1.61', drawer_pin: 5 });
    expect(b.status).toBe(201);
    cajaTel.printer = b.body.printer;
  });

  it('el rol pide la caja cuando la barra tiene varias, y sin caja no se abre', async () => {
    const sinCaja = await asignar(cajeroPc);
    expect(sinCaja.status).toBe(422);
    expect(sinCaja.body.error.details.tills).toHaveLength(2);
    // Una asignación vieja (sin caja) no deja abrir: el gerente tiene que decir cuál.
    await pool.query(
      `INSERT INTO shift_assignments (nightclub_id, event_id, user_id, role, location_id)
       VALUES ($1,$2,$3,'cashier',$4)`, [club.id, noche.id, cajeroPc.id, club.bar_id]);
    const estado = await api().get(url('/till')).set(auth(cajeroPc));
    expect(estado.body.assignment).toMatchObject({ needs_till: true });
    const sin = await abrir(cajeroPc);
    expect(sin.status).toBe(422);
    expect(sin.body.error.message).toMatch(/varias cajas/);
    // Asignarlo con caja corrige la misma fila.
    expect((await asignar(cajeroPc, { till_id: cajaPc.id })).status).toBe(201);
    expect((await abrir(cajeroPc)).status).toBe(201);
    const gaps = await api().get(url(`/nights/${noche.id}/roster`)).set(auth(manager));
    expect(gaps.body.gaps.tills.map((t) => t.till_id)).toContain(cajaTel.id);
    expect(gaps.body.gaps.tills.map((t) => t.till_id)).not.toContain(cajaPc.id);
  });

  it('cada cajero abre su caja; dos en la misma caja no', async () => {
    await asignar(cajeroPc, { till_id: cajaPc.id });
    await asignar(cajeroTel, { till_id: cajaTel.id });
    const uno = await abrir(cajeroPc);
    const dos = await abrir(cajeroTel);
    expect(uno.status).toBe(201);
    expect(dos.status).toBe(201);
    expect(uno.body.till).toMatchObject({ till_id: cajaPc.id, till_name: 'Barra planta baja', device: 'pc' });
    expect(dos.body.till).toMatchObject({ till_id: cajaTel.id, till_name: 'Caja teléfono PB', device: 'phone' });

    // El fondo abre el cajón de CADA caja, en su impresora.
    const pulsos = await jobs('drawer');
    const deApertura = pulsos.filter((j) => /fondo/.test(j.preview));
    expect(deApertura.map((j) => j.printer_id).sort())
      .toEqual([cajaPc.printer.id, cajaTel.printer.id].sort());

    // Un tercer cajero en la caja del teléfono: ocupada.
    const otro = await f.createUser(club.id, { role: 'cashier', display_name: 'Respaldo' });
    await asignar(otro, { till_id: cajaTel.id });
    const ocupada = await abrir(otro);
    expect(ocupada.status).toBe(409);
    expect(ocupada.body.error.message).toMatch(/Caja teléfono PB.*Cajera Tel/);
  });

  it('las dos ven los pedidos de la barra; cada cobro sale en SU impresora y no se cobra dos veces', async () => {
    await asignar(cajeroPc, { till_id: cajaPc.id });
    await asignar(cajeroTel, { till_id: cajaTel.id });
    await abrir(cajeroPc);
    await abrir(cajeroTel);
    const p1 = await pedido();
    const p2 = await pedido();

    const verPc = await api().get(url('/till')).set(auth(cajeroPc));
    const verTel = await api().get(url('/till')).set(auth(cajeroTel));
    expect(verPc.body.pending_orders).toHaveLength(2);
    expect(verTel.body.pending_orders).toHaveLength(2);

    const cobrar = (user, order) => api().post(url('/till/payments')).set(auth(user))
      .send({ transaction_id: order.transaction_id, method: 'cash', amount: 60, cash_received: 100 });

    // Las dos cajas cobran el mismo pedido al mismo tiempo: uno solo pasa.
    const [a, b] = await Promise.all([cobrar(cajeroPc, p1), cobrar(cajeroTel, p1)]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    const pagos = await pool.query(
      'SELECT count(*)::int AS n FROM manual_payments WHERE transaction_id = $1', [p1.transaction_id]);
    expect(pagos.rows[0].n).toBe(1);

    const c = await cobrar(cajeroTel, p2);
    expect(c.status).toBe(201);
    expect(c.body.drawer.status).toBe('queued');

    // El cajón del cobro del teléfono se abrió en la impresora del teléfono.
    const pulsos = (await jobs('drawer')).filter((j) => /cobro en efectivo/.test(j.preview));
    expect(pulsos).toHaveLength(2);
    const recibos = await jobs('receipt');
    const reciboTel = recibos.find((j) => j.printer_id === cajaTel.printer.id);
    expect(reciboTel).toBeTruthy();
    expect(reciboTel.preview).toContain('Caja teléfono PB');

    // Cada pago quedó en el turno de su caja.
    const { rows } = await pool.query(
      `SELECT s.till_id::text AS till_id FROM manual_payments m
         JOIN staff_shifts s ON s.id = m.till_shift_id WHERE m.transaction_id = $1`, [p2.transaction_id]);
    expect(rows[0].till_id).toBe(cajaTel.id);
  });

  it('probar impresora desde la caja sale en la de esa caja', async () => {
    await asignar(cajeroTel, { till_id: cajaTel.id });
    await abrir(cajeroTel);
    const res = await api().post(url('/till/test-print')).set(auth(cajeroTel));
    expect(res.status).toBe(202);
    expect(res.body.printer.id).toBe(cajaTel.printer.id);
    expect(res.body.agent_online).toBe(true);
    const sinCaja = await api().post(url('/till/test-print')).set(auth(cajeroPc));
    expect(sinCaja.status).toBe(409);
  });

  it('el corte general nombra cada caja', async () => {
    await asignar(cajeroPc, { till_id: cajaPc.id });
    await asignar(cajeroTel, { till_id: cajaTel.id });
    await abrir(cajeroPc);
    await abrir(cajeroTel);
    const res = await api().get(url('/tills')).set(auth(manager));
    expect(res.status).toBe(200);
    expect(res.body.tills.map((t) => t.location_name).sort())
      .toEqual(['Barra planta baja', 'Caja teléfono PB']);
  });
});

describe('La impresora del teléfono y la terminal', () => {
  beforeEach(segundaCaja);

  it('registra la impresora de red con cajón: hoja de prueba y pulso; reemplaza a la anterior', async () => {
    const res = await api().post(url(`/till-setup/${cajaTel.id}/printer`)).set(auth(manager))
      .send({ host: '192.168.1.70', has_drawer: true, drawer_pin: 2 });
    expect(res.status).toBe(201);
    expect(res.body.printer).toMatchObject({
      purpose: 'till', connection: 'network', host: '192.168.1.70', drawer_pin: 2, till_id: cajaTel.id,
    });
    expect(res.body.test_job).not.toBeNull();
    expect(res.body.drawer_job).not.toBeNull();

    const otra = await api().post(url(`/till-setup/${cajaTel.id}/printer`)).set(auth(manager))
      .send({ host: '192.168.1.71' });
    expect(otra.status).toBe(201);
    expect(otra.body.replaced).toBe(1);
    const activas = await pool.query(
      `SELECT host FROM printers WHERE till_id = $1 AND active`, [cajaTel.id]);
    expect(activas.rows).toEqual([{ host: '192.168.1.71' }]);
  });

  it('dos cajas no comparten impresora, y la IP se valida', async () => {
    await api().post(url(`/till-setup/${cajaTel.id}/printer`)).set(auth(manager)).send({ host: '192.168.1.80' });
    const misma = await api().post(url(`/till-setup/${cajaPc.id}/printer`)).set(auth(manager))
      .send({ host: '192.168.1.80' });
    expect(misma.status).toBe(409);
    const mala = await api().post(url(`/till-setup/${cajaPc.id}/printer`)).set(auth(manager))
      .send({ host: 'http://x; rm -rf' });
    expect(mala.status).toBe(400);
  });

  it('sin ninguna PC que imprima esa barra se dice antes de registrar; con PC asignada sí', async () => {
    await pool.query('UPDATE print_agents SET location_id = $2, purpose = $3 WHERE id = $1',
      [pc.id, club.locations['barra-alta'], 'till']);
    const nadie = await api().post(url(`/till-setup/${cajaTel.id}/printer`)).set(auth(manager))
      .send({ host: '192.168.1.90' });
    expect(nadie.status).toBe(422);
    expect(nadie.body.error.details.reason).toBe('no_agent');
    const conPc = await api().post(url(`/till-setup/${cajaTel.id}/printer`)).set(auth(manager))
      .send({ host: '192.168.1.90', agent_id: pc.id });
    expect(conPc.status).toBe(201);
    expect(conPc.body.printer.agent_id).toBe(pc.id);
  });

  it('las impresoras de red que vio una PC se ofrecen, sin las ya registradas', async () => {
    await pool.query(
      `UPDATE print_agents SET scan_at = now(), scan_result = $2::jsonb WHERE id = $1`,
      [pc.id, JSON.stringify([
        { kind: 'network', host: '192.168.1.100', port: 9100, model: 'XP-80' },
        { kind: 'network', host: '192.168.1.101', port: 9100 },
        { kind: 'windows', name: 'XP-80C', host: 'USB001' },
      ])]);
    await api().post(url(`/till-setup/${cajaPc.id}/printer`)).set(auth(manager)).send({ host: '192.168.1.101' });
    const res = await api().get(url('/till-setup/network-printers')).set(auth(manager));
    expect(res.status).toBe(200);
    expect(res.body.candidates.map((c) => c.host)).toEqual(['192.168.1.100']);
    expect(res.body.candidates[0].seen_by[0].name).toBe('PC Barra baja');
    expect(res.body.agents[0]).toMatchObject({ name: 'PC Barra baja', online: true });
  });

  it('la terminal es de la caja: se asigna, se mueve y se quita', async () => {
    const { rows } = await pool.query(
      `INSERT INTO payment_terminals (nightclub_id, external_id, label)
       VALUES ($1,'PAX_A910__SMARTPOS1','Point PB 2') RETURNING id::text AS id`, [club.id]);
    const terminal = rows[0];
    const a = await api().put(url(`/till-setup/${cajaTel.id}/terminal`)).set(auth(manager))
      .send({ terminal_id: terminal.id });
    expect(a.status).toBe(200);
    let fila = (await pool.query('SELECT till_id::text AS t, location_id::text AS l FROM payment_terminals WHERE id = $1', [terminal.id])).rows[0];
    expect(fila).toEqual({ t: cajaTel.id, l: club.bar_id });
    const b = await api().put(url(`/till-setup/${cajaPc.id}/terminal`)).set(auth(manager))
      .send({ terminal_id: terminal.id });
    expect(b.status).toBe(200);
    fila = (await pool.query('SELECT till_id::text AS t FROM payment_terminals WHERE id = $1', [terminal.id])).rows[0];
    expect(fila.t).toBe(cajaPc.id);
    const c = await api().put(url(`/till-setup/${cajaPc.id}/terminal`)).set(auth(manager))
      .send({ terminal_id: null });
    expect(c.status).toBe(200);
    fila = (await pool.query('SELECT till_id, location_id FROM payment_terminals WHERE id = $1', [terminal.id])).rows[0];
    expect(fila).toEqual({ till_id: null, location_id: null });
  });

  it('en una barra con dos cajas, una impresora de caja sin caja dicha se rechaza con palabras', async () => {
    const res = await api().post(url('/printers')).set(auth(manager)).send({
      location_id: club.bar_id, name: 'Sin caja', purpose: 'till', connection: 'network', host: '192.168.1.99',
    });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/varias cajas/);
  });
});
