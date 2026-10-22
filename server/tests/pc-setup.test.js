/**
 * "Registrar esta PC" (D127) y la caja del bartender (D128).
 *
 *   * El gerente escoge qué es la PC y baja `Instalar-EV2.cmd`: lleva la dirección del
 *     club y una llave de un solo uso que vence; con ella la PC se da de alta sola, sin
 *     teclear nada, y registra su impresora USB con cajón, prueba y pulso.
 *   * La PC del bartender registra la MISMA impresora USB para sus comandas y para su
 *     caja (con el cajón), y su caja se crea si la barra no tenía.
 *   * El bartender abre su caja con fondo y PIN del gerente, vende en su barra y cobra
 *     SOLO eso; los pedidos de meseros siguen siendo del cajero.
 *   * "Borrar PCs e impresoras" deja el club sin equipos, sin tocar las cajas.
 */
'use strict';

const { randomUUID } = require('crypto');
const { setupSchema, truncateAll, closePool, pool } = require('./helpers/db');
const { api, auth } = require('./helpers/api');
const f = require('./helpers/factories');
const pins = require('../src/services/pins');
const pcSetup = require('../src/services/pc-setup');

let club; let manager; let waiter; let bartender; let cajero; let table; let beer; let pinGerente; let noche;

beforeAll(setupSchema);
afterAll(closePool);

const url = (p) => `/api/nightclubs/${club.id}${p}`;
const comoAgente = (token, method, path) => api()[method](path).set('X-Print-Agent-Token', token);
const termica = { kind: 'windows', name: 'XP-80C', host: 'USB001', share: null };
const enRed = { kind: 'network', host: '192.168.1.77', port: 9100, model: 'Otra en red' };
let origenes;

beforeEach(async () => {
  origenes = process.env.ALLOWED_ORIGINS;
  process.env.ALLOWED_ORIGINS = 'https://ev2-clandestinoz.mx';
  await truncateAll();
  club = await f.createNightclub({ slug: 'ev2-pcs' });
  manager = await f.createUser(club.id, { role: 'manager', display_name: 'Gerente Ana' });
  waiter = await f.createUser(club.id, { role: 'waiter', on_shift: true, display_name: 'Luis' });
  bartender = await f.createUser(club.id, { role: 'bartender', display_name: 'Beto' });
  cajero = await f.createUser(club.id, { role: 'cashier', display_name: 'Caja PB' });
  table = await f.createTable(club.id, { code: 'T-1', section: 'ZONA ROJA', capacity: 4 });
  beer = await f.createDrink(club.id, { name: 'Cerveza', price: 60, stock: 40 });
  await pool.query(`INSERT INTO zone_bars (nightclub_id, section, location_id) VALUES ($1,'ZONA ROJA',$2)`,
    [club.id, club.bar_id]);
  pinGerente = await pins.issuePin(pool, { userId: manager.id });
  await pool.query('UPDATE users SET must_change_pin = false WHERE id = $1', [manager.id]);
  const { rows } = await pool.query(
    `INSERT INTO events_calendar (nightclub_id, name, event_date, doors_open_at, ticket_price, status)
     VALUES ($1,'Viernes',(now() - interval '1 hour')::date, now() - interval '1 hour', 0, 'published')
     RETURNING id`, [club.id]);
  noche = rows[0];
});
afterEach(() => { process.env.ALLOWED_ORIGINS = origenes; });

const cajaDeBarra = async () => (await pool.query(
  `SELECT id::text AS id FROM tills WHERE location_id = $1 AND operator = 'cashier'`, [club.bar_id])).rows[0].id;

const instalador = (target, body = {}) => api().post(url('/till-setup/installer')).set(auth(manager))
  .send({ target, ...body });

/** Lo que hace el .cmd: sacar la llave de adentro y darse de alta con ella. */
async function instalarCon(script, hostname = 'CAJA-PB') {
  const codigo = /\$Codigo\s+=\s+'([0-9A-Z]+)'/.exec(script)[1];
  const res = await api().post('/api/print-agent/pair').send({ code: codigo, hostname, version: '2.0.0' });
  return { res, agent: { ...res.body.agent, token: res.body.token } };
}

describe('Registrar esta PC (D127)', () => {
  it('ofrece las cajas con PC y la PC del bartender de cada barra', async () => {
    const res = await api().get(url('/till-setup/pc-targets')).set(auth(manager));
    expect(res.status).toBe(200);
    const etiquetas = res.body.targets.map((x) => x.label);
    expect(etiquetas).toEqual(expect.arrayContaining([
      'Caja: Barra planta baja', 'Caja: Barra planta alta',
      'Bartender: Barra planta baja', 'Bartender: Barra planta alta',
    ]));
    expect((await api().get(url('/till-setup/pc-targets')).set(auth(cajero))).status).toBe(403);
  });

  it('el instalador trae el club y una llave larga de un solo uso; sin teclear nada la PC queda registrada', async () => {
    const tillId = await cajaDeBarra();
    const res = await instalador(`till:${tillId}`);
    expect(res.status).toBe(201);
    expect(res.headers['cache-control']).toMatch(/no-store/);
    expect(res.body.filename).toBe('Instalar-EV2.cmd');
    const { script } = res.body;
    expect(script.startsWith('@echo off\r\n')).toBe(true);
    expect(script).toContain("$ApiUrl  = 'https://ev2-clandestinoz.mx'");
    expect(script).toContain('winget install --id OpenJS.NodeJS.LTS');
    expect(script).toContain('--pair-only --repair');
    expect(script).toContain('EV2-POWERSHELL#');
    // La marca no aparece entera en la línea que la busca (si no, se leería a sí misma).
    expect(script.indexOf('EV2-POWERSHELL#')).toBe(script.lastIndexOf('EV2-POWERSHELL#'));
    expect(/[^\x00-\x7F]/.test(script)).toBe(false);
    const codigo = /\$Codigo\s+=\s+'([0-9A-Z]+)'/.exec(script)[1];
    expect(codigo).toHaveLength(pcSetup.INSTALLER_CODE_LENGTH);

    const { res: alta, agent } = await instalarCon(script);
    expect(alta.status).toBe(201);
    expect(agent.station).toMatchObject({ purpose: 'till', till_id: tillId, drawer_pin: 2 });
    // Una sola vez.
    const otra = await api().post('/api/print-agent/pair').send({ code: codigo, hostname: 'OTRA' });
    expect(otra.status).toBe(403);

    // Encuentra la USB y la registra sola, con cajón, prueba y pulso.
    await comoAgente(agent.token, 'post', '/api/print-agent/scan').send({ found: [termica, enRed] });
    const { rows } = await pool.query(
      `SELECT purpose, connection, windows_name, drawer_pin, till_id::text AS till_id FROM printers
        WHERE nightclub_id = $1 AND active`, [club.id]);
    expect(rows).toEqual([{ purpose: 'till', connection: 'windows', windows_name: 'XP-80C', drawer_pin: 2, till_id: tillId }]);
    const { rows: trabajos } = await pool.query(
      'SELECT kind FROM print_jobs WHERE nightclub_id = $1 ORDER BY kind', [club.id]);
    expect(trabajos.map((j) => j.kind)).toEqual(['drawer', 'test']);
    const { rows: log } = await pool.query(
      `SELECT 1 FROM audit_log WHERE nightclub_id = $1 AND action = 'pc.installer'`, [club.id]);
    expect(log).toHaveLength(1);
  });

  it('una llave vencida no sirve', async () => {
    const res = await instalador(`till:${await cajaDeBarra()}`);
    await pool.query(`UPDATE print_agent_invites SET expires_at = now() - interval '1 minute'`);
    const { res: alta } = await instalarCon(res.body.script);
    expect(alta.status).toBe(403);
  });

  it('sin cajón no lleva pin; sobre http no se genera; solo el gerente; la caja del teléfono no va por aquí', async () => {
    const tillId = await cajaDeBarra();
    const sin = await instalador(`till:${tillId}`, { has_drawer: false });
    expect(sin.body.invite.station.drawer_pin).toBeNull();
    expect((await api().post(url('/till-setup/installer')).set(auth(cajero)).send({ target: `till:${tillId}` })).status).toBe(403);
    expect((await instalador('cualquier-cosa')).status).toBe(400);
    const tel = await api().post(url('/till-setup')).set(auth(manager))
      .send({ location_id: club.bar_id, name: 'Teléfono PB', device: 'phone' });
    expect((await instalador(`till:${tel.body.till.id}`)).status).toBe(422);
    process.env.ALLOWED_ORIGINS = 'http://ev2.local';
    expect((await instalador(`till:${tillId}`)).status).toBe(400);
  });

  it('la PC del bartender: su caja se crea y la misma USB saca comandas y recibos, con el cajón en la caja', async () => {
    const res = await instalador(`bartender:${club.bar_id}`);
    expect(res.status).toBe(201);
    const { rows: cajas } = await pool.query(
      `SELECT id::text AS id, name, operator FROM tills WHERE location_id = $1 AND operator = 'bartender'`, [club.bar_id]);
    expect(cajas).toEqual([{ id: expect.any(String), name: 'Bartender · Barra planta baja', operator: 'bartender' }]);
    // Bajarlo otra vez no crea otra caja.
    await instalador(`bartender:${club.bar_id}`);
    expect((await pool.query(`SELECT 1 FROM tills WHERE operator = 'bartender'`)).rowCount).toBe(1);

    const { agent } = await instalarCon(res.body.script, 'BARRA-PB');
    await comoAgente(agent.token, 'post', '/api/print-agent/scan').send({ found: [termica] });
    const { rows } = await pool.query(
      `SELECT purpose, windows_name, drawer_pin, till_id::text AS till_id, agent_id::text AS agent_id
         FROM printers WHERE nightclub_id = $1 AND active ORDER BY purpose`, [club.id]);
    expect(rows).toEqual([
      { purpose: 'orders', windows_name: 'XP-80C', drawer_pin: null, till_id: null, agent_id: agent.id },
      { purpose: 'till', windows_name: 'XP-80C', drawer_pin: 2, till_id: cajas[0].id, agent_id: agent.id },
    ]);
    const { rows: pulso } = await pool.query(
      `SELECT p.purpose FROM print_jobs j JOIN printers p ON p.id = j.printer_id WHERE j.kind = 'drawer'`);
    expect(pulso).toEqual([{ purpose: 'till' }]);
    // Y la caja del cajero de esa barra sigue siendo "la de la barra".
    const { rows: unica } = await pool.query('SELECT till_of_location($1)::text AS t', [club.bar_id]);
    expect(unica[0].t).toBe(await cajaDeBarra());
  });

  it('borrar PCs e impresoras: pide BORRAR, deja todo apagado y las PCs viejas ya no toman papel', async () => {
    const res = await instalador(`till:${await cajaDeBarra()}`);
    const { agent } = await instalarCon(res.body.script);
    await comoAgente(agent.token, 'post', '/api/print-agent/scan').send({ found: [termica] });
    expect((await api().post(url('/till-setup/wipe-devices')).set(auth(manager)).send({})).status).toBe(400);
    expect((await api().post(url('/till-setup/wipe-devices')).set(auth(cajero)).send({ confirm: 'BORRAR' })).status).toBe(403);
    const ok = await api().post(url('/till-setup/wipe-devices')).set(auth(manager)).send({ confirm: 'BORRAR' });
    expect(ok.status).toBe(200);
    expect(ok.body.wiped).toMatchObject({ printers_off: 1, agents_off: 1 });
    expect((await pool.query('SELECT 1 FROM printers WHERE active')).rowCount).toBe(0);
    expect((await pool.query('SELECT 1 FROM print_agents WHERE active')).rowCount).toBe(0);
    expect((await comoAgente(agent.token, 'get', '/api/print-agent/jobs')).status).toBe(401);
    // Las cajas siguen ahí.
    expect((await pool.query('SELECT 1 FROM tills WHERE active')).rowCount).toBeGreaterThan(0);
    // Y se puede volver a registrar con el mismo nombre de impresora.
    const otra = await instalador(`till:${await cajaDeBarra()}`);
    const { agent: nueva } = await instalarCon(otra.body.script);
    await comoAgente(nueva.token, 'post', '/api/print-agent/scan').send({ found: [termica] });
    expect((await pool.query('SELECT 1 FROM printers WHERE active')).rowCount).toBe(1);
    expect((await pool.query(`SELECT 1 FROM audit_log WHERE action = 'printing.wipe'`)).rowCount).toBe(1);
  });

  it('el instalador ya no es una línea de PowerShell ni un código de 8 letras', async () => {
    // Ya no existe: sin la ruta, el router del agente pide su llave (401) en vez de un script.
    const ps1 = await api().get('/api/print-agent/install.ps1');
    expect(ps1.status).not.toBe(200);
    expect(ps1.text).not.toContain('$ApiUrl');
    expect((await api().post(url('/print-agents/invite')).set(auth(manager)).send({})).status).toBe(404);
  });
});

describe('La caja del bartender (D128)', () => {
  let cajaBartender;

  beforeEach(async () => {
    // La PC del bartender, registrada como en la barra: instalador y su USB.
    const inst = await instalador(`bartender:${club.bar_id}`);
    const { agent } = await instalarCon(inst.body.script, 'BARRA-PB');
    await comoAgente(agent.token, 'post', '/api/print-agent/scan').send({ found: [termica] });
    cajaBartender = (await pool.query(
      `SELECT id::text AS id FROM tills WHERE operator = 'bartender'`)).rows[0].id;
  });

  const asignar = (user) => api().post(url(`/nights/${noche.id}/roster`)).set(auth(manager))
    .send({ user_id: user.id, location_id: club.bar_id });
  const abrir = (user) => api().post(url('/till/open')).set(auth(user))
    .send({ opening_float: 300, manager_pin: pinGerente });

  it('el rol lo pone en su caja y la abre con fondo y PIN del gerente, junto al cajero', async () => {
    expect((await asignar(bartender)).status).toBe(201);
    expect((await asignar(cajero)).status).toBe(201);
    const { rows } = await pool.query(
      'SELECT user_id::text AS u, till_id::text AS t FROM shift_assignments ORDER BY role', [] );
    expect(rows).toEqual(expect.arrayContaining([
      { u: bartender.id, t: cajaBartender }, { u: cajero.id, t: await cajaDeBarra() },
    ]));
    const b = await abrir(bartender);
    expect(b.status).toBe(201);
    expect(b.body.till).toMatchObject({ till_id: cajaBartender, operator: 'bartender' });
    expect(b.body.pending_orders).toEqual([]);
    expect((await abrir(cajero)).status).toBe(201);
  });

  it('cobra su venta directa (y abre su cajón), pero no los pedidos de meseros', async () => {
    await asignar(bartender);
    await asignar(cajero);
    await abrir(bartender);
    await abrir(cajero);

    const venta = await api().post(url('/orders')).set(auth(bartender)).send({
      client_request_id: randomUUID(), items: [{ drink_id: beer.id, quantity: 1 }],
    });
    expect(venta.status).toBe(201);
    const cobro = await api().post(url('/till/payments')).set(auth(bartender))
      .send({ transaction_id: venta.body.order.transaction_id, method: 'cash', amount: 60, cash_received: 100 });
    expect(cobro.status).toBe(201);
    expect(cobro.body.change_given).toBe('40.00');
    expect(cobro.body.drawer.status).toBe('queued');

    const delMesero = await api().post(url('/orders')).set(auth(waiter)).send({
      client_request_id: randomUUID(), table_id: table.id, items: [{ drink_id: beer.id, quantity: 1 }],
    });
    const noSuyo = await api().post(url('/till/payments')).set(auth(bartender))
      .send({ transaction_id: delMesero.body.order.transaction_id, method: 'cash', amount: 60, cash_received: 60 });
    expect(noSuyo.status).toBe(403);
    // El cajero sí lo cobra.
    const cajeroCobra = await api().post(url('/till/payments')).set(auth(cajero))
      .send({ transaction_id: delMesero.body.order.transaction_id, method: 'cash', amount: 60, cash_received: 60 });
    expect(cajeroCobra.status).toBe(201);
  });

  it('sin caja abierta no vende; su corte no se detiene por los pedidos de meseros', async () => {
    await asignar(bartender);
    const sinCaja = await api().post(url('/orders')).set(auth(bartender)).send({
      client_request_id: randomUUID(), items: [{ drink_id: beer.id, quantity: 1 }],
    });
    expect(sinCaja.status).toBe(409);
    await abrir(bartender);
    await asignar(cajero);
    await abrir(cajero);
    await api().post(url('/orders')).set(auth(waiter)).send({
      client_request_id: randomUUID(), table_id: table.id, items: [{ drink_id: beer.id, quantity: 1 }],
    });
    // Corte a ciegas: primero cuenta, luego el gerente cierra.
    const dec = await api().post(url('/shifts/me/declaration')).set(auth(bartender)).send({ declared_cash: 300 });
    expect(dec.status).toBeLessThan(300);
    const corte = await api().post(url('/shifts/me/closing')).set(auth(bartender))
      .send({ manager_pin: pinGerente, counted_cash: 300 });
    expect(corte.status).toBe(201);
  });

  it('sin caja de bartender en su barra, el bartender sigue solo preparando', async () => {
    const otraBarra = club.locations['barra-alta'];
    const res = await api().post(url(`/nights/${noche.id}/roster`)).set(auth(manager))
      .send({ user_id: bartender.id, location_id: otraBarra });
    expect(res.status).toBe(201);
    const abre = await abrir(bartender);
    expect(abre.status).toBe(422);
    expect(abre.body.error.message).toMatch(/no tiene caja de bartender/);
  });
});
