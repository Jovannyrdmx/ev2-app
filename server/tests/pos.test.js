'use strict';

// Registro de integraciones POS (D24). Este paso NO habla con SoftRestaurant: eso es
// la fase 4. Aquí se declara la integración, se enrola el agente local con una llave
// propia y se ve si está vivo y qué ha estado haciendo.

const { setupSchema, truncateAll, closePool, pool } = require('./helpers/db');
const { api, auth } = require('./helpers/api');
const f = require('./helpers/factories');
const registry = require('../src/services/pos/registry');

let club; let otherClub; let manager; let otherManager; let guest; let bartender;

beforeAll(setupSchema);
afterAll(closePool);

beforeEach(async () => {
  await truncateAll();
  club = await f.createNightclub({ slug: 'ev2-pos' });
  otherClub = await f.createNightclub({ name: 'Otro', slug: 'otro-pos' });
  manager = await f.createUser(club.id, { role: 'manager' });
  otherManager = await f.createUser(otherClub.id, { role: 'manager' });
  guest = await f.createUser(club.id, { role: 'guest' });
  bartender = await f.createUser(club.id, { role: 'bartender' });
});

const url = (p) => `/api/nightclubs/${club.id}${p}`;

const createIntegration = (over = {}, as = manager) => api().post(url('/pos-integrations'))
  .set(auth(as)).send({ config: { sql_server_host: '192.168.2.108', sql_database: 'ev2pos' }, ...over });

/** Enrols an agent and turns the integration on, which is the normal starting point. */
async function enrolled(over = {}) {
  const created = await createIntegration(over);
  await api().patch(url(`/pos-integrations/${created.body.integration.id}`))
    .set(auth(manager)).send({ enabled: true });
  return { integration: created.body.integration, key: created.body.agent_key };
}

const asAgent = (key) => ({ 'X-Agent-Key': key });

// ---------------------------------------------------------------- registro

describe('Declarar la integración', () => {
  it('el gerente la registra y recibe la llave del agente una sola vez', async () => {
    const res = await createIntegration();
    expect(res.status).toBe(201);
    expect(res.body.integration).toMatchObject({
      provider: 'softrestaurant11', mode: 'agent', enabled: false, status: 'inactive',
      enrolled: true, heartbeat_interval_seconds: 60, stale_after_seconds: 300,
    });
    expect(res.body.integration.config).toMatchObject({ sql_server_host: '192.168.2.108' });
    expect(res.body.agent_key).toMatch(/^ev2agent_[\w-]{40,}$/);
    expect(res.body.integration.health.state).toBe('never_seen');

    // Solo se guarda el hash: una copia de esta base no abre el POS.
    const { rows } = await pool.query('SELECT agent_key_hash, credentials_encrypted FROM pos_integrations');
    expect(rows[0].agent_key_hash).toBe(registry.hashAgentKey(res.body.agent_key));
    expect(rows[0].agent_key_hash).not.toContain(res.body.agent_key);
    // No se guardan credenciales de SQL Server: viven en el servidor del club (D16).
    expect(rows[0].credentials_encrypted).toBeNull();
  });

  it('la llave no vuelve a aparecer en ninguna consulta', async () => {
    const { key, integration } = await enrolled();
    const listed = await api().get(url('/pos-integrations')).set(auth(manager));
    expect(JSON.stringify(listed.body)).not.toContain(key);
    const one = await api().get(url(`/pos-integrations/${integration.id}`)).set(auth(manager));
    expect(JSON.stringify(one.body)).not.toContain(key);
    expect(JSON.stringify(one.body)).not.toContain('agent_key_hash');
  });

  it('rechaza configuración con llaves desconocidas y un proveedor inventado', async () => {
    const bad = await createIntegration({ config: { password: 'sa123' } });
    expect(bad.status).toBe(400);
    expect((await createIntegration({ provider: 'aloha' })).status).toBe(400);
  });

  it('un club no puede tener dos integraciones del mismo proveedor', async () => {
    await createIntegration();
    expect((await createIntegration()).status).toBe(409);
    // Pero sí una de otro proveedor.
    expect((await createIntegration({ provider: 'mock', mode: 'mock' })).status).toBe(201);
  });

  it('el modo mock no genera llave porque no hay nada que enrolar', async () => {
    const res = await createIntegration({ provider: 'mock', mode: 'mock' });
    expect(res.body.agent_key).toBeUndefined();
    expect(res.body.integration.enrolled).toBe(false);
  });

  it('solo el gerente entra al registro', async () => {
    expect((await createIntegration({}, guest)).status).toBe(403);
    expect((await createIntegration({}, bartender)).status).toBe(403);
    expect((await api().get(url('/pos-integrations')).set(auth(guest))).status).toBe(403);
  });

  it('el gerente de otro club no ve ni toca esta integración', async () => {
    const { integration } = await enrolled();
    expect((await api().get(url('/pos-integrations')).set(auth(otherManager))).status).toBe(403);
    const listed = await api().get(`/api/nightclubs/${otherClub.id}/pos-integrations`)
      .set(auth(otherManager));
    expect(listed.body.integrations).toHaveLength(0);
    const cross = await api().get(`/api/nightclubs/${otherClub.id}/pos-integrations/${integration.id}`)
      .set(auth(otherManager));
    expect(cross.status).toBe(404);
  });
});

// ---------------------------------------------------------------- encendido y llave

describe('Encender, rotar y eliminar', () => {
  it('no se enciende una integración de agente sin llave', async () => {
    const created = await createIntegration({ provider: 'mock', mode: 'mock' });
    const toAgent = await api().patch(url(`/pos-integrations/${created.body.integration.id}`))
      .set(auth(manager)).send({ mode: 'agent', enabled: true });
    expect(toAgent.status).toBe(422);
  });

  it('rotar la llave deja fuera al agente que traía la anterior', async () => {
    const { key, integration } = await enrolled();
    await api().post('/api/pos/agent/heartbeat').set(asAgent(key)).send({ version: '1.0.0' });

    const rotated = await api().post(url(`/pos-integrations/${integration.id}/rotate-key`))
      .set(auth(manager));
    expect(rotated.status).toBe(200);
    expect(rotated.body.agent_key).not.toBe(key);
    // Rotar borra lo que sabíamos del agente anterior: ya no es el mismo.
    expect(rotated.body.integration).toMatchObject({ agent_version: null, last_seen_at: null });
    expect(rotated.body.integration.health.state).toBe('never_seen');

    expect((await api().post('/api/pos/agent/heartbeat').set(asAgent(key)).send({})).status).toBe(401);
    expect((await api().post('/api/pos/agent/heartbeat').set(asAgent(rotated.body.agent_key))
      .send({})).status).toBe(200);
  });

  it('una integración encendida no se elimina por accidente', async () => {
    const { integration } = await enrolled();
    expect((await api().delete(url(`/pos-integrations/${integration.id}`)).set(auth(manager))).status)
      .toBe(409);

    await api().patch(url(`/pos-integrations/${integration.id}`)).set(auth(manager))
      .send({ enabled: false });
    expect((await api().delete(url(`/pos-integrations/${integration.id}`)).set(auth(manager))).status)
      .toBe(204);
    const listed = await api().get(url('/pos-integrations')).set(auth(manager));
    expect(listed.body.integrations).toHaveLength(0);
  });
});

// ---------------------------------------------------------------- el agente

describe('El agente se reporta', () => {
  it('una llave inválida o ausente no entra', async () => {
    expect((await api().post('/api/pos/agent/heartbeat').send({})).status).toBe(401);
    expect((await api().post('/api/pos/agent/heartbeat').set(asAgent('ev2agent_no')).send({})).status)
      .toBe(401);
    // Y una sesión de usuario tampoco sirve: el agente es una máquina.
    expect((await api().post('/api/pos/agent/heartbeat').set(auth(manager)).send({})).status).toBe(401);
  });

  it('el latido deja constancia y le dice al agente qué puede hacer', async () => {
    const { key, integration } = await enrolled();
    const res = await api().post('/api/pos/agent/heartbeat').set(asAgent(key))
      .send({ version: '1.2.0', hostname: 'SRV-POS-01' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      integration_id: integration.id, nightclub_id: club.id, enabled: true, mode: 'agent',
      heartbeat_interval_seconds: 60,
    });
    expect(res.body.config).toMatchObject({ sql_server_host: '192.168.2.108' });
    // Escribir comandas en el POS no existe todavía (fase 4).
    expect(res.body.capabilities).toEqual({
      read_catalog: true, read_inventory: true, push_orders: false,
    });

    const view = await api().get(url(`/pos-integrations/${integration.id}`)).set(auth(manager));
    expect(view.body.integration).toMatchObject({
      agent_version: '1.2.0', agent_hostname: 'SRV-POS-01', status: 'active',
    });
    expect(view.body.integration.health.state).toBe('ok');
  });

  it('apagar la integración desde la app llega al agente en el siguiente latido', async () => {
    const { key, integration } = await enrolled();
    await api().patch(url(`/pos-integrations/${integration.id}`)).set(auth(manager))
      .send({ enabled: false });
    const res = await api().post('/api/pos/agent/heartbeat').set(asAgent(key)).send({});
    expect(res.body.enabled).toBe(false);
    expect(res.body.capabilities.read_catalog).toBe(false);
  });

  it('el agente puede reportar que él mismo está fallando', async () => {
    const { key, integration } = await enrolled();
    await api().post('/api/pos/agent/heartbeat').set(asAgent(key))
      .send({ status: 'error', error: 'Login failed for user ev2_readonly' });
    const view = await api().get(url(`/pos-integrations/${integration.id}`)).set(auth(manager));
    expect(view.body.integration.status).toBe('error');
    expect(view.body.integration.health.state).toBe('error');
    expect(view.body.integration.last_error).toMatch(/Login failed/);

    // Y cuando se recupera, el error se limpia solo.
    await api().post('/api/pos/agent/heartbeat').set(asAgent(key)).send({ status: 'ok' });
    const back = await api().get(url(`/pos-integrations/${integration.id}`)).set(auth(manager));
    expect(back.body.integration.last_error).toBeNull();
    expect(back.body.integration.health.state).toBe('ok');
  });

  it('un agente callado se reporta como perdido, no como sano', async () => {
    const { key, integration } = await enrolled();
    await api().post('/api/pos/agent/heartbeat').set(asAgent(key)).send({});
    await pool.query(
      `UPDATE pos_integrations SET last_seen_at = now() - interval '20 minutes' WHERE id = $1`,
      [integration.id]);
    const view = await api().get(url(`/pos-integrations/${integration.id}`)).set(auth(manager));
    expect(view.body.integration.health.state).toBe('stale');
    expect(view.body.integration.health.message).toMatch(/sin reportarse/);
  });
});

// ---------------------------------------------------------------- bitácora

describe('Bitácora de sincronizaciones', () => {
  it('el agente registra una corrida y el gerente la ve', async () => {
    const { key, integration } = await enrolled();
    const res = await api().post('/api/pos/agent/sync').set(asAgent(key))
      .send({ kind: 'menu', ok: true, items_synced: 128, details: { source_table: 'productos' } });
    expect(res.status).toBe(201);
    expect(res.body.run_id).toMatch(/^\d+$/);

    const log = await api().get(url('/pos-sync-log')).set(auth(manager));
    expect(log.body.runs).toHaveLength(1);
    expect(log.body.runs[0]).toMatchObject({
      kind: 'menu', source: 'agent', ok: true, items_synced: 128, integration_id: integration.id,
    });
    expect(log.body.last_7_days[0]).toMatchObject({ kind: 'menu', runs: 1, ok: 1, items: 128 });
  });

  it('una corrida fallida marca la integración, no se queda enterrada en el log', async () => {
    const { key, integration } = await enrolled();
    await api().post('/api/pos/agent/sync').set(asAgent(key))
      .send({ kind: 'inventory', ok: false, error: 'Timeout expired' });

    const view = await api().get(url(`/pos-integrations/${integration.id}`)).set(auth(manager));
    expect(view.body.integration.status).toBe('error');
    expect(view.body.integration.last_error).toBe('Timeout expired');

    const failed = await api().get(url('/pos-sync-log?only_failed=true')).set(auth(manager));
    expect(failed.body.runs).toHaveLength(1);
    expect(failed.body.runs[0].error).toBe('Timeout expired');
  });

  it('reintentar con la misma clave no duplica la corrida', async () => {
    const { key } = await enrolled();
    const body = {
      kind: 'inventory', ok: true, items_synced: 30,
      client_request_id: '99999999-9999-4999-8999-999999999999',
    };
    const first = await api().post('/api/pos/agent/sync').set(asAgent(key)).send(body);
    const second = await api().post('/api/pos/agent/sync').set(asAgent(key)).send(body);
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ run_id: first.body.run_id, idempotent: true });
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM pos_sync_log');
    expect(rows[0].n).toBe(1);
  });

  it('con la integración apagada el agente no escribe nada', async () => {
    const { key, integration } = await enrolled();
    await api().patch(url(`/pos-integrations/${integration.id}`)).set(auth(manager))
      .send({ enabled: false });
    const res = await api().post('/api/pos/agent/sync').set(asAgent(key))
      .send({ kind: 'menu', ok: true, items_synced: 5 });
    expect(res.status).toBe(403);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM pos_sync_log');
    expect(rows[0].n).toBe(0);
  });

  it('un tipo de sincronización inventado se rechaza', async () => {
    const { key } = await enrolled();
    const res = await api().post('/api/pos/agent/sync').set(asAgent(key))
      .send({ kind: 'clientes', ok: true });
    expect(res.status).toBe(400);
  });

  it('el cliente no ve la bitácora', async () => {
    expect((await api().get(url('/pos-sync-log')).set(auth(guest))).status).toBe(403);
  });
});

// ---------------------------------------------------------------- lo que todavía no existe

describe('Lo que la fase 4 todavía no entrega', () => {
  it('el webhook del POS sigue respondiendo 501 y lo dice', async () => {
    const res = await api().post('/api/webhooks/pos').send({});
    expect(res.status).toBe(501);
    expect(res.body.error.message).toMatch(/phase 4/i);
    expect(res.body.error.message).toMatch(/POS_REAL/);
  });

  it('el cliente de SoftRestaurant no finge funcionar', async () => {
    const { SoftRestaurant11Client } = require('../src/services/pos/softrestaurant11');
    const client = new SoftRestaurant11Client();
    await expect(client.getMenu()).rejects.toMatchObject({ status: 501 });
    await expect(client.createOrder()).rejects.toMatchObject({ status: 501 });
  });
});
