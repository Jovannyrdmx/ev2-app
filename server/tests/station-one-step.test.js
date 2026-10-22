/**
 * Alta de estación sin rodeos (D125).
 *
 * Lo que se prueba es lo que antes obligaba a volver al panel:
 *  - reinstalar una PC creaba otra ("COVER (2)") en vez de reemplazarla;
 *  - la impresora vieja de la caja bloqueaba a la nueva ("apágala y vuelve a buscar");
 *  - con dos impresoras en la PC había que escoger aunque una fuera de tinta;
 *  - lo apagado se iba juntando en la lista sin forma de quitarlo.
 */
'use strict';

const { setupSchema, truncateAll, closePool, pool } = require('./helpers/db');
const { api, auth } = require('./helpers/api');
const pairing = require('./helpers/pairing');
const f = require('./helpers/factories');
const printing = require('../src/services/printing');

let club; let manager; let waiter;

beforeAll(setupSchema);
afterAll(closePool);

beforeEach(async () => {
  await truncateAll();
  club = await f.createNightclub({ slug: 'ev2-un-paso' });
  manager = await f.createUser(club.id, { role: 'manager', display_name: 'Gerente' });
  waiter = await f.createUser(club.id, { role: 'waiter', display_name: 'Luis' });
});

const url = (p) => `/api/nightclubs/${club.id}${p}`;
const comoAgente = (token, method, path) => api()[method](path).set('X-Print-Agent-Token', token);
const pedirCodigo = (station, extra = {}) => pairing.invite(club.id, manager, { location_id: club.bar_id, station, ...extra });
const caja = { name: 'Caja barra baja', purpose: 'till', has_drawer: true };

async function canjear(res, hostname = 'CAJA-01') {
  const pair = await api().post('/api/print-agent/pair')
    .send({ code: res.body.invite.code, hostname, version: '1.0.0' });
  expect(pair.status).toBe(201);
  return { ...pair.body.agent, token: pair.body.token };
}
const buscar = (agent, found) => comoAgente(agent.token, 'post', '/api/print-agent/scan').send({ found });

/**
 * Barrido de la PC y, si en su lista hay UNA sola impresora USB de esa PC, el gerente
 * la escoge (D129: ya nunca se escoge sola). Con varias, se queda preguntando.
 */
async function barrer(agent, found) {
  const res = await buscar(agent, found);
  const { rows } = await pool.query('SELECT station FROM print_agents WHERE id = $1', [agent.id]);
  const st = rows[0] && rows[0].station;
  const usbs = st && st.status === 'choose' ? (st.candidates || []).filter((c) => c.via === 'usb') : [];
  if (usbs.length === 1) {
    await api().post(url(`/print-agents/${agent.id}/station/finish`)).set(auth(manager))
      .send({ windows_name: usbs[0].name });
  }
  return res;
}
const usb = (name, port = 'USB001') => ({ kind: 'windows', name, host: port, share: null });
const estacionDe = async (agent) => (await pool.query(
  'SELECT station FROM print_agents WHERE id = $1', [agent.id])).rows[0].station;
const agentes = async () => (await pool.query(
  'SELECT id::text AS id, name, active FROM print_agents WHERE nightclub_id = $1 ORDER BY created_at',
  [club.id])).rows;

describe('Reinstalar una PC la reemplaza', () => {
  it('el mismo nombre de máquina reusa la PC: no aparece "CAJA-01 (2)"', async () => {
    const primera = await canjear(await pedirCodigo(caja));
    await barrer(primera, [usb('XP-80C')]);
    const segunda = await canjear(await pedirCodigo(caja));
    expect(segunda.id).toBe(primera.id);
    expect(segunda.name).toBe('CAJA-01');
    const lista = await agentes();
    expect(lista).toHaveLength(1);
    expect(lista[0].active).toBe(true);
  });

  it('el token viejo deja de servir y el nuevo sí', async () => {
    const primera = await canjear(await pedirCodigo(caja));
    const segunda = await canjear(await pedirCodigo(caja));
    expect((await comoAgente(primera.token, 'get', '/api/print-agent/jobs')).status).toBe(401);
    expect((await comoAgente(segunda.token, 'get', '/api/print-agent/jobs')).status).toBe(200);
  });

  it('una PC apagada con ese nombre también se reusa y vuelve a quedar activa', async () => {
    const primera = await canjear(await pedirCodigo(caja));
    await pool.query('UPDATE print_agents SET active = false WHERE id = $1', [primera.id]);
    const segunda = await canjear(await pedirCodigo(caja));
    expect(segunda.id).toBe(primera.id);
    expect((await agentes())[0].active).toBe(true);
  });

  it('reinstalada, pregunta otra vez (D129) y al escoger la misma no la duplica', async () => {
    const primera = await canjear(await pedirCodigo(caja));
    await barrer(primera, [usb('XP-80C')]);
    const segunda = await canjear(await pedirCodigo(caja));
    await buscar(segunda, [usb('XP-80C'), usb('HP DeskJet 2700', 'USB002')]);
    expect((await estacionDe(segunda)).status).toBe('choose');
    await api().post(url(`/print-agents/${segunda.id}/station/finish`)).set(auth(manager))
      .send({ windows_name: 'XP-80C' });
    expect((await estacionDe(segunda)).status).toBe('done');
    const { rows } = await pool.query(
      'SELECT windows_name, active FROM printers WHERE nightclub_id = $1 AND active', [club.id]);
    expect(rows).toEqual([{ windows_name: 'XP-80C', active: true }]);
  });

  it('PCs con distinto nombre siguen siendo PCs distintas', async () => {
    await canjear(await pedirCodigo(caja), 'CAJA-01');
    await canjear(await pedirCodigo({ ...caja, name: 'Comandas', purpose: 'orders', has_drawer: false }), 'COMANDAS');
    expect(await agentes()).toHaveLength(2);
  });
});

describe('La impresora nueva toma el lugar de la vieja', () => {
  it('se lleva los papeles pendientes de la vieja; el cajón y la prueba no', async () => {
    const vieja = await api().post(url('/printers')).set(auth(manager)).send({
      location_id: club.bar_id, name: 'Vieja', purpose: 'till', connection: 'network', host: '192.168.1.9',
    });
    const viejaId = vieja.body.printer.id;
    const p = await printing.getPrinter(pool, { nightclubId: club.id, printerId: viejaId });
    await printing.enqueue(pool, { nightclubId: club.id, printer: p, kind: 'receipt', payload: Buffer.from('r'), preview: 'Recibo 1' });
    await printing.enqueue(pool, { nightclubId: club.id, printer: p, kind: 'drawer', payload: Buffer.from('d'), preview: 'cajón' });

    const agent = await canjear(await pedirCodigo(caja));
    await barrer(agent, [usb('XP-80C')]);
    const st = await estacionDe(agent);
    expect(st.status).toBe('done');

    const { rows: viejos } = await pool.query(
      'SELECT kind, status, last_error FROM print_jobs WHERE printer_id = $1 ORDER BY kind', [viejaId]);
    expect(viejos.every((j) => j.status === 'failed' && /reemplazada/.test(j.last_error))).toBe(true);
    const { rows: nuevos } = await pool.query(
      `SELECT kind, preview, rerouted_from::text AS rerouted_from FROM print_jobs
        WHERE printer_id = $1 AND kind = 'receipt'`, [st.printer_id]);
    expect(nuevos).toEqual([{ kind: 'receipt', preview: 'Recibo 1', rerouted_from: viejaId }]);
  });

  it('una apagada con el mismo nombre ya no impide usar ese nombre', async () => {
    const vieja = await api().post(url('/printers')).set(auth(manager)).send({
      location_id: club.bar_id, name: 'Caja barra baja', purpose: 'till', connection: 'network', host: '192.168.1.9',
    });
    await pool.query('UPDATE printers SET active = false WHERE id = $1', [vieja.body.printer.id]);
    const agent = await canjear(await pedirCodigo(caja));
    await barrer(agent, [usb('XP-80C')]);
    expect((await estacionDe(agent)).status).toBe('done');
    const { rows } = await pool.query(
      'SELECT name FROM printers WHERE nightclub_id = $1 AND active', [club.id]);
    expect(rows).toEqual([{ name: 'Caja barra baja' }]);
  });

  it('una impresora de OTRA barra o de otro uso no se toca', async () => {
    await api().post(url('/printers')).set(auth(manager)).send({
      location_id: club.bar_id, name: 'Comandas', purpose: 'orders', connection: 'network', host: '192.168.1.9',
    });
    const agent = await canjear(await pedirCodigo(caja));
    await barrer(agent, [usb('XP-80C')]);
    const { rows } = await pool.query(
      'SELECT name, active FROM printers WHERE nightclub_id = $1 ORDER BY name', [club.id]);
    expect(rows).toEqual([{ name: 'Caja barra baja', active: true }, { name: 'Comandas', active: true }]);
  });
});

describe('Escoger sola la térmica', () => {
  it('con una térmica y una de tinta pregunta, con la térmica primero (D129)', async () => {
    const agent = await canjear(await pedirCodigo(caja));
    await buscar(agent, [usb('HP ENVY 6000 series', 'USB002'), usb('Xprinter XP-230H')]);
    const st = await estacionDe(agent);
    expect(st.status).toBe('choose');
    expect(st.candidates.map((c) => c.name)).toEqual(['Xprinter XP-230H', 'HP ENVY 6000 series']);
  });

  it('con dos térmicas sigue preguntando: adivinar mandaría los tickets a otra caja', async () => {
    const agent = await canjear(await pedirCodigo(caja));
    await barrer(agent, [usb('XP-76C'), usb('XP-80C', 'USB002')]);
    expect((await estacionDe(agent)).status).toBe('choose');
  });

  it('pickStationPrinter: lo que ya usaba gana a la regla de nombres', () => {
    const c = [{ name: 'XP-76C' }, { name: 'COVERGOOD' }];
    expect(printing.pickStationPrinter(c, ['COVERGOOD'])).toEqual({ name: 'COVERGOOD' });
    expect(printing.pickStationPrinter(c, [])).toEqual({ name: 'XP-76C' });
    expect(printing.pickStationPrinter([{ name: 'A' }, { name: 'B' }], [])).toBeNull();
  });
});

describe('Limpiar equipos', () => {
  const limpiar = (user = manager) => api().post(url('/print-agents/cleanup')).set(auth(user)).send({});

  it('un mesero no puede', async () => {
    expect((await limpiar(waiter)).status).toBe(403);
  });

  it('borra lo apagado sin historia, archiva lo que sí tiene y no toca lo que funciona', async () => {
    const buena = await api().post(url('/printers')).set(auth(manager)).send({
      location_id: club.bar_id, name: 'Buena', purpose: 'orders', connection: 'network', host: '10.0.0.1',
    });
    const sinHistoria = await api().post(url('/printers')).set(auth(manager)).send({
      location_id: club.bar_id, name: 'Sin historia', purpose: 'till', connection: 'network', host: '10.0.0.2',
    });
    const conHistoria = await api().post(url('/printers')).set(auth(manager)).send({
      location_id: club.bar_id, name: 'Con historia', purpose: 'service', connection: 'network', host: '10.0.0.3',
    });
    const ch = await printing.getPrinter(pool, { nightclubId: club.id, printerId: conHistoria.body.printer.id });
    await printing.enqueue(pool, { nightclubId: club.id, printer: ch, kind: 'receipt', payload: Buffer.from('x'), preview: 'atorado' });
    await pool.query('UPDATE printers SET active = false WHERE id = ANY($1::uuid[])',
      [[sinHistoria.body.printer.id, conHistoria.body.printer.id]]);
    const pcSuelta = await printing.createAgent(pool, { nightclubId: club.id, name: 'Vieja', createdBy: manager.id });
    await pool.query('UPDATE print_agents SET active = false WHERE id = $1', [pcSuelta.id]);

    const res = await limpiar();
    expect(res.status).toBe(200);
    expect(res.body.cleanup).toMatchObject({
      printers_deleted: 1, agents_deleted: 1, jobs_cancelled: 1, archived: { printers: 1, agents: 0 },
    });
    const { rows } = await pool.query('SELECT name, active FROM printers WHERE nightclub_id = $1 ORDER BY name', [club.id]);
    expect(rows).toEqual([{ name: 'Buena', active: true }, { name: 'Con historia', active: false }]);
    expect(buena.status).toBe(201);
    const { rows: audit } = await pool.query(
      "SELECT 1 FROM audit_log WHERE nightclub_id = $1 AND action = 'printing.cleanup'", [club.id]);
    expect(audit).toHaveLength(1);
  });

  it('apaga la PC repetida que no imprime y deja la que sí', async () => {
    const a = await canjear(await pedirCodigo(caja), 'CAJA3');
    await barrer(a, [usb('XP-80C')]);
    // Una copia vieja con el mismo nombre de máquina, como dejaban las reinstalaciones.
    const { rows } = await pool.query(
      `INSERT INTO print_agents (nightclub_id, name, token_hash, token_hint, hostname, active, last_seen_at)
       VALUES ($1, 'CAJA3 (4)', 'x-hash', 'xxxxxx', 'CAJA3', true, now() - interval '1 day')
       RETURNING id::text AS id`, [club.id]);
    const res = await limpiar();
    expect(res.body.cleanup.duplicates_disabled).toBe(1);
    const lista = await agentes();
    expect(lista.find((x) => x.id === a.id).active).toBe(true);
    expect(lista.find((x) => x.id === rows[0].id)).toBeUndefined();
  });
});
