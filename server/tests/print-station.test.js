/**
 * La estación de caja de un solo paso (D99): PC + impresora USB + cajón.
 *
 * Lo que se prueba es el camino real: el gerente pide el código con lo que quiere
 * (nombre, lugar, cajón), la PC lo canjea, hace su barrido de impresoras, y la
 * impresora USB queda registrada, con su cajón, hoja de prueba y pulso del cajón en la
 * cola, sin que nadie vuelva a tocar el panel.
 */
'use strict';

const { setupSchema, truncateAll, closePool, pool } = require('./helpers/db');
const { api, auth } = require('./helpers/api');
const f = require('./helpers/factories');

let club; let manager; let waiter;

beforeAll(setupSchema);
afterAll(closePool);

beforeEach(async () => {
  await truncateAll();
  club = await f.createNightclub({ slug: 'ev2-estacion' });
  manager = await f.createUser(club.id, { role: 'manager', display_name: 'Gerente' });
  waiter = await f.createUser(club.id, { role: 'waiter', display_name: 'Luis' });
});

const url = (p) => `/api/nightclubs/${club.id}${p}`;
const comoAgente = (token, method, path) => api()[method](path).set('X-Print-Agent-Token', token);

const pedirCodigo = (station, extra = {}, user = manager) => api()
  .post(url('/print-agents/invite')).set(auth(user))
  .send({ location_id: club.bar_id, station, ...extra });

const estacionCaja = { name: 'Caja barra baja', purpose: 'till', has_drawer: true };

/** Canjea el código y devuelve la PC con su token. */
async function canjear(res, hostname = 'CAJA-01') {
  const pair = await api().post('/api/print-agent/pair')
    .send({ code: res.body.invite.code, hostname, version: '1.0.0' });
  return { ...pair.body.agent, token: pair.body.token };
}

const barrer = (agent, found) => comoAgente(agent.token, 'post', '/api/print-agent/scan')
  .send({ found });

const termica = { kind: 'windows', name: 'XP-80C', host: 'USB001', share: null };
const virtuales = [
  { kind: 'windows', name: 'Microsoft Print to PDF', host: 'PORTPROMPT:' },
  { kind: 'windows', name: 'OneNote (Desktop)', host: 'nul:' },
  { kind: 'windows', name: 'Fax', host: 'SHRFAX:' },
  { kind: 'network', host: '192.168.1.77', port: 9100, model: 'Otra en red' },
];

const estacionDe = async (agent) => (await pool.query(
  'SELECT station FROM print_agents WHERE id = $1', [agent.id])).rows[0].station;

describe('Pedir el código de una estación', () => {
  it('guarda lo pedido y la PC que lo canjea nace con eso', async () => {
    const res = await pedirCodigo(estacionCaja);
    expect(res.status).toBe(201);
    expect(res.body.invite.station).toMatchObject({
      name: 'Caja barra baja', purpose: 'till', drawer_pin: 2, status: 'pending',
    });
    const agent = await canjear(res);
    expect(agent.station).toMatchObject({ purpose: 'till', drawer_pin: 2, status: 'pending' });
    expect(agent.location_id).toBe(club.bar_id);
    expect(agent.purpose).toBe('till');
  });

  it('sin cajón no guarda ningún pin', async () => {
    const res = await pedirCodigo({ ...estacionCaja, has_drawer: false });
    expect(res.body.invite.station.drawer_pin).toBeNull();
  });

  it('una estación que no es la puerta necesita barra', async () => {
    const res = await pedirCodigo(estacionCaja, { location_id: null });
    expect(res.status).toBe(400);
  });

  it('la puerta no lleva barra', async () => {
    const res = await pedirCodigo({ name: 'Puerta', purpose: 'door', has_drawer: true },
      { location_id: null });
    expect(res.status).toBe(201);
    expect(res.body.invite.location_id).toBeNull();
    expect(res.body.invite.station.purpose).toBe('door');
  });

  it('un mesero no puede', async () => {
    expect((await pedirCodigo(estacionCaja, {}, waiter)).status).toBe(403);
  });

  it('el nombre es obligatorio y el pin solo 2 o 5', async () => {
    expect((await pedirCodigo({ ...estacionCaja, name: '  ' })).status).toBe(400);
    expect((await pedirCodigo({ ...estacionCaja, drawer_pin: 3 })).status).toBe(400);
  });
});

describe('El registro automático', () => {
  it('con una sola térmica USB la registra sola, con cajón, prueba y pulso', async () => {
    const agent = await canjear(await pedirCodigo(estacionCaja));
    const res = await barrer(agent, [...virtuales, termica]);
    expect(res.status).toBe(200);

    const st = await estacionDe(agent);
    expect(st.status).toBe('done');
    const { rows } = await pool.query(
      `SELECT name, purpose, connection, windows_name, agent_id::text AS agent_id,
              location_id::text AS location_id, drawer_pin, paper_width, columns, active
         FROM printers WHERE nightclub_id = $1`, [club.id]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      name: 'Caja barra baja', purpose: 'till', connection: 'windows', windows_name: 'XP-80C',
      agent_id: agent.id, location_id: club.bar_id, drawer_pin: 2, active: true,
    });

    const { rows: jobs } = await pool.query(
      `SELECT kind FROM print_jobs WHERE nightclub_id = $1 ORDER BY kind`, [club.id]);
    expect(jobs.map((j) => j.kind)).toEqual(['drawer', 'test']);
  });

  it('sin cajón no manda ningún pulso', async () => {
    const agent = await canjear(await pedirCodigo({ ...estacionCaja, has_drawer: false }));
    await barrer(agent, [termica]);
    const { rows } = await pool.query(
      `SELECT kind FROM print_jobs WHERE nightclub_id = $1`, [club.id]);
    expect(rows.map((j) => j.kind)).toEqual(['test']);
    const p = await pool.query('SELECT drawer_pin FROM printers WHERE nightclub_id = $1', [club.id]);
    expect(p.rows[0].drawer_pin).toBeNull();
  });

  it('en la puerta queda como impresora de puerta, sin barra', async () => {
    const agent = await canjear(await pedirCodigo(
      { name: 'Puerta', purpose: 'door', has_drawer: true }, { location_id: null }));
    await barrer(agent, [termica]);
    const { rows } = await pool.query(
      'SELECT purpose, location_id, drawer_pin FROM printers WHERE nightclub_id = $1', [club.id]);
    expect(rows[0]).toMatchObject({ purpose: 'door', location_id: null, drawer_pin: 2 });
  });

  it('con pin 5 lo respeta', async () => {
    const agent = await canjear(await pedirCodigo({ ...estacionCaja, drawer_pin: 5 }));
    await barrer(agent, [termica]);
    const { rows } = await pool.query('SELECT drawer_pin FROM printers WHERE nightclub_id = $1', [club.id]);
    expect(rows[0].drawer_pin).toBe(5);
  });

  it('sin ninguna impresora USB avisa qué revisar y se completa en el siguiente barrido', async () => {
    const agent = await canjear(await pedirCodigo(estacionCaja));
    await barrer(agent, virtuales);
    const st = await estacionDe(agent);
    expect(st.status).toBe('none');
    expect(st.message).toMatch(/USB/);
    expect((await pool.query('SELECT 1 FROM printers WHERE nightclub_id = $1', [club.id])).rowCount)
      .toBe(0);

    await barrer(agent, [termica]);
    expect((await estacionDe(agent)).status).toBe('done');
  });

  it('con varias candidatas pregunta, y el gerente escoge', async () => {
    const agent = await canjear(await pedirCodigo(estacionCaja));
    await barrer(agent, [termica, { kind: 'windows', name: 'POS-58', host: 'USB002' }]);
    const st = await estacionDe(agent);
    expect(st.status).toBe('choose');
    expect(st.candidates.map((c) => c.name).sort()).toEqual(['POS-58', 'XP-80C']);

    const bad = await api().post(url(`/print-agents/${agent.id}/station/finish`))
      .set(auth(manager)).send({ windows_name: 'No existe' });
    expect(bad.status).toBe(400);

    const ok = await api().post(url(`/print-agents/${agent.id}/station/finish`))
      .set(auth(manager)).send({ windows_name: 'POS-58' });
    expect(ok.status).toBe(200);
    expect(ok.body.station.status).toBe('done');
    const { rows } = await pool.query('SELECT windows_name, drawer_pin FROM printers WHERE nightclub_id = $1', [club.id]);
    expect(rows[0]).toMatchObject({ windows_name: 'POS-58', drawer_pin: 2 });

    const otra = await api().post(url(`/print-agents/${agent.id}/station/finish`))
      .set(auth(manager)).send({ windows_name: 'XP-80C' });
    expect(otra.status).toBe(409);
  });

  it('un mesero no puede terminar la estación', async () => {
    const agent = await canjear(await pedirCodigo(estacionCaja));
    await barrer(agent, [termica, { kind: 'windows', name: 'POS-58', host: 'USB002' }]);
    const res = await api().post(url(`/print-agents/${agent.id}/station/finish`))
      .set(auth(waiter)).send({ windows_name: 'POS-58' });
    expect(res.status).toBe(403);
  });

  it('si ya hay una impresora para ese uso en ese lugar, no la pisa y lo dice', async () => {
    await api().post(url('/printers')).set(auth(manager)).send({
      location_id: club.bar_id, name: 'Vieja', purpose: 'till', connection: 'network', host: '192.168.1.9',
    });
    const agent = await canjear(await pedirCodigo(estacionCaja));
    await barrer(agent, [termica]);
    const st = await estacionDe(agent);
    expect(st.status).toBe('blocked');
    expect(st.message).toMatch(/Ya hay una impresora/);
    expect((await pool.query('SELECT 1 FROM printers WHERE nightclub_id = $1', [club.id])).rowCount).toBe(1);
  });

  it('una PC sin estación no registra nada sola', async () => {
    const res = await api().post(url('/print-agents/invite')).set(auth(manager)).send({});
    const agent = await canjear(res);
    await barrer(agent, [termica]);
    expect((await pool.query('SELECT 1 FROM printers WHERE nightclub_id = $1', [club.id])).rowCount).toBe(0);
  });

  it('un barrido repetido no registra dos veces', async () => {
    const agent = await canjear(await pedirCodigo(estacionCaja));
    await barrer(agent, [termica]);
    await barrer(agent, [termica]);
    expect((await pool.query('SELECT 1 FROM printers WHERE nightclub_id = $1', [club.id])).rowCount).toBe(1);
  });

  it('la lista de PCs trae el estado de la estación', async () => {
    const agent = await canjear(await pedirCodigo(estacionCaja));
    await barrer(agent, [termica]);
    const res = await api().get(url('/print-agents')).set(auth(manager));
    const mine = res.body.agents.find((a) => a.id === agent.id);
    expect(mine.station.status).toBe('done');
    expect(mine.station.printer_id).toBeTruthy();
  });

  it('el probar cajón y cambiar de pin que ya existían siguen sirviendo para la impresora nueva', async () => {
    const agent = await canjear(await pedirCodigo(estacionCaja));
    await barrer(agent, [termica]);
    const { printer_id: id } = await estacionDe(agent);
    const cambia = await api().patch(url(`/printers/${id}`)).set(auth(manager)).send({ drawer_pin: 5 });
    expect(cambia.body.printer.drawer_pin).toBe(5);
    const prueba = await api().post(url(`/printers/${id}/test-drawer`)).set(auth(manager));
    expect(prueba.status).toBe(202);
  });
});
