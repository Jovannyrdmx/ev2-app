/**
 * La cola de impresión (D52).
 *
 * El servidor está en un VPS y las impresoras en la red del club: el servidor no
 * puede alcanzarlas. Lo único que hace es decidir **a qué impresora va cada papel** y
 * dejar el trabajo escrito; un agente en una PC de barra se lo lleva.
 *
 * De ahí salen las tres cosas que se prueban aquí, que son las tres que hacen que un
 * ticket no salga en un club de verdad:
 *
 *   1. Que el papel vaya a la impresora correcta cuando el gerente reasigna zonas.
 *   2. Que con dos PCs tomando de la misma cola **el mismo ticket no salga dos veces**.
 *   3. Que una impresora atascada no se trague el papel en silencio.
 */
'use strict';

const { setupSchema, truncateAll, closePool, pool } = require('./helpers/db');
const { api, auth } = require('./helpers/api');
const f = require('./helpers/factories');
const printing = require('../src/services/printing');

let club; let admin; let manager; let waiter;

beforeAll(setupSchema);
afterAll(closePool);

beforeEach(async () => {
  await truncateAll();
  club = await f.createNightclub({ slug: 'ev2-impresion' });
  admin = await f.createUser(club.id, { role: 'admin', display_name: 'Erick' });
  manager = await f.createUser(club.id, { role: 'manager', display_name: 'Gerente' });
  waiter = await f.createUser(club.id, { role: 'waiter', display_name: 'Luis' });
});

const url = (p) => `/api/nightclubs/${club.id}${p}`;

/** Da de alta una impresora como lo haría el gerente desde su panel. */
const altaImpresora = (user, body) => api().post(url('/printers')).set(auth(user)).send({
  location_id: club.bar_id,
  name: 'Barra baja · meseros',
  purpose: 'service',
  connection: 'network',
  host: '192.168.1.50',
  ...body,
});

/**
 * Da de alta una PC como se hace de verdad desde D56: el gerente pide un código y la
 * PC lo canja. El helper recorre el camino real y no un atajo, porque si ese camino
 * se rompe se rompe la instalación del club entero.
 */
async function nuevoAgente(name = 'PC barra baja') {
  const { body } = await api().post(url('/print-agents/invite')).set(auth(manager));
  const res = await api().post('/api/print-agent/pair')
    .send({ code: body.invite.code, hostname: name, version: '1.0.0' });
  return { ...res.body.agent, token: res.body.token };
}

/** Un código de emparejamiento recién emitido. */
const nuevoCodigo = async () => (await api().post(url('/print-agents/invite'))
  .set(auth(manager))).body.invite;

const emparejar = (code, hostname = 'PC prueba') => api().post('/api/print-agent/pair')
  .send({ code, hostname });

const comoAgente = (token, method, path) => api()[method](path).set('X-Print-Agent-Token', token);

// ============================================================================

describe('Dar de alta una impresora', () => {
  it('el gerente la crea y quedan puestas las columnas que caben en ese papel', async () => {
    const res = await altaImpresora(manager);
    expect(res.status).toBe(201);
    // 80 mm son 48 columnas en fuente A. Nadie debería tener que saber ese número.
    expect(res.body.printer).toMatchObject({ paper_width: 80, columns: 48, codepage: 'CP850' });
  });

  it('a 58 mm caben 32, y tampoco hay que decirlo', async () => {
    const res = await altaImpresora(manager, { paper_width: 58, name: 'Chica' });
    expect(res.body.printer.columns).toBe(32);
  });

  it('una impresora de red sin dirección se para aquí, con palabras', async () => {
    const res = await altaImpresora(manager, { host: null });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/dirección IP/i);
  });

  it('una por USB necesita su nombre en Windows', async () => {
    const res = await altaImpresora(manager, { connection: 'windows', host: null });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/nombre en Windows/i);
  });

  it('el almacén no es una barra: ahí no va ninguna impresora', async () => {
    const res = await altaImpresora(manager, { location_id: club.warehouse_id });
    expect(res.status).toBe(400);
  });

  it('una barra no puede tener dos impresoras activas para lo mismo', async () => {
    await altaImpresora(manager);
    const segunda = await altaImpresora(manager, { name: 'Otra' });
    // Si hubiera dos, "la impresora de cuentas de la barra baja" dejaría de ser una
    // respuesta y el ticket saldría en una de las dos al azar.
    expect(segunda.status).toBe(409);
  });

  it('pero sí una de comandas y otra de cuentas: son las dos PCs de esa barra', async () => {
    await altaImpresora(manager, { purpose: 'service' });
    const barra = await altaImpresora(manager, {
      purpose: 'orders', name: 'Barra baja · bartender', host: '192.168.1.51',
    });
    expect(barra.status).toBe(201);
  });

  it('un mesero no da de alta impresoras, pero sí puede ver cuáles hay', async () => {
    expect((await altaImpresora(waiter)).status).toBe(403);
    await altaImpresora(manager);
    expect((await api().get(url('/printers')).set(auth(waiter))).status).toBe(200);
  });
});

describe('A qué impresora va cada papel', () => {
  let servicio; let comandas; let alta;

  beforeEach(async () => {
    servicio = (await altaImpresora(manager, { purpose: 'service' })).body.printer;
    comandas = (await altaImpresora(manager, {
      purpose: 'orders', name: 'Barra baja · bartender', host: '192.168.1.51',
    })).body.printer;
    alta = (await altaImpresora(manager, {
      purpose: 'orders',
      name: 'Barra alta · bartender',
      host: '192.168.1.61',
      location_id: club.locations['barra-alta'],
    })).body.printer;
    await pool.query(
      `INSERT INTO zone_bars (nightclub_id, section, location_id) VALUES ($1,'terraza',$2)`,
      [club.id, club.locations['barra-alta']]);
  });

  it('el propósito decide cuál de las dos PCs de la barra', async () => {
    const paraBarra = await printing.resolvePrinter(pool, {
      nightclubId: club.id, purpose: 'orders', locationId: club.bar_id,
    });
    const paraMesero = await printing.resolvePrinter(pool, {
      nightclubId: club.id, purpose: 'service', locationId: club.bar_id,
    });
    expect(paraBarra.id).toBe(comandas.id);
    expect(paraMesero.id).toBe(servicio.id);
  });

  it('una zona va a la barra que la atiende, no a la más cercana en la lista', async () => {
    const destino = await printing.resolvePrinter(pool, {
      nightclubId: club.id, purpose: 'orders', section: 'terraza',
    });
    expect(destino.id).toBe(alta.id);
  });

  it('cuando el gerente reasigna la terraza a media noche, el papel se muda solo', async () => {
    await pool.query(
      `UPDATE zone_bars SET location_id = $2 WHERE nightclub_id = $1 AND section = 'terraza'`,
      [club.id, club.bar_id]);
    const destino = await printing.resolvePrinter(pool, {
      nightclubId: club.id, purpose: 'orders', section: 'terraza',
    });
    // Nadie tocó ninguna impresora: el enrutado sale de `zone_bars`.
    expect(destino.id).toBe(comandas.id);
  });

  it('una zona sin barra asignada no inventa un destino', async () => {
    const destino = await printing.resolvePrinter(pool, {
      nightclubId: club.id, purpose: 'orders', section: 'vip',
    });
    // Devolver "cualquiera" haría que las comandas del VIP salieran en otra barra
    // sin que nadie entienda por qué.
    expect(destino).toBeNull();
  });

  it('con una sola impresora de ese uso en el club, esa es; con dos, hay que decir dónde', async () => {
    expect((await printing.resolvePrinter(pool, { nightclubId: club.id, purpose: 'service' })).id)
      .toBe(servicio.id);
    expect(await printing.resolvePrinter(pool, { nightclubId: club.id, purpose: 'orders' }))
      .toBeNull();
  });
});

describe('El ticket de prueba', () => {
  it('queda en la cola con los bytes listos y su copia legible', async () => {
    const printer = (await altaImpresora(manager)).body.printer;
    const res = await api().post(url(`/printers/${printer.id}/test`)).set(auth(manager));
    expect(res.status).toBe(202);
    expect(res.body.job).toMatchObject({ kind: 'test', status: 'pending', attempts: 0 });
    expect(res.body.job.preview).toContain('Coñac añejo');
    const { rows } = await pool.query('SELECT payload FROM print_jobs WHERE id = $1',
      [res.body.job.id]);
    expect(rows[0].payload.length).toBeGreaterThan(100);
  });

  it('una impresora apagada no acepta trabajos', async () => {
    const printer = (await altaImpresora(manager)).body.printer;
    await api().patch(url(`/printers/${printer.id}`)).set(auth(manager)).send({ active: false });
    const res = await api().post(url(`/printers/${printer.id}/test`)).set(auth(manager));
    expect(res.status).toBe(400);
  });
});

describe('El agente', () => {
  let printer;
  beforeEach(async () => { printer = (await altaImpresora(manager)).body.printer; });

  it('el token se enseña una vez y nunca más', async () => {
    const agente = await nuevoAgente();
    expect(agente.token).toMatch(/^ev2ag_[0-9a-f]{48}$/);
    const lista = await api().get(url('/print-agents')).set(auth(manager));
    expect(lista.body.agents[0].token).toBeUndefined();
    expect(lista.body.agents[0].token_hint).toBe(agente.token.slice(-6));
  });

  it('la base guarda la huella, no el token', async () => {
    const agente = await nuevoAgente();
    const { rows } = await pool.query('SELECT token_hash FROM print_agents WHERE id = $1',
      [agente.id]);
    expect(rows[0].token_hash).not.toContain(agente.token);
    expect(rows[0].token_hash).toBe(printing.hashToken(agente.token));
  });

  it('sin token no toma nada, y un token inventado tampoco', async () => {
    expect((await api().get('/api/print-agent/jobs')).status).toBe(401);
    expect((await comoAgente('ev2ag_loquesea', 'get', '/api/print-agent/jobs')).status).toBe(401);
  });

  it('su autenticación no se mete con el resto del API', async () => {
    // Montado en `/api` en vez de en `/api/print-agent`, el `use()` del agente corría
    // en TODA petición a `/api`: una dirección inexistente contestaba 401 en vez de
    // 404, y consultaba la base para averiguarlo. Lo encontró una prueba de otro
    // módulo; esta lo deja amarrado aquí.
    const res = await api().get('/api/no-existe-esta-ruta');
    expect(res.status).toBe(404);
  });

  it('un agente apagado deja de poder imprimir', async () => {
    const agente = await nuevoAgente();
    await api().patch(url(`/print-agents/${agente.id}`)).set(auth(manager)).send({ active: false });
    expect((await comoAgente(agente.token, 'get', '/api/print-agent/jobs')).status).toBe(401);
  });

  it('cada vez que pregunta queda constancia de que esa PC sigue viva', async () => {
    const agente = await nuevoAgente();
    await comoAgente(agente.token, 'get', '/api/print-agent/jobs');
    const lista = await api().get(url('/print-agents')).set(auth(manager));
    // Sin esto no se distingue "no hay trabajos" de "esa PC lleva tres horas apagada".
    expect(lista.body.agents[0].last_seen_at).not.toBeNull();
  });

  it('toma el trabajo y se lleva los bytes, no el texto', async () => {
    const agente = await nuevoAgente();
    await api().post(url(`/printers/${printer.id}/test`)).set(auth(manager));
    const res = await comoAgente(agente.token, 'get', '/api/print-agent/jobs');
    expect(res.body.jobs).toHaveLength(1);
    const job = res.body.jobs[0];
    expect(job.status).toBe('taken');
    expect(job.attempts).toBe(1);
    expect(job.printer).toMatchObject({ host: '192.168.1.50', port: 9100 });
    // Los bytes viajan en base64: JSON no transporta un byte 0x1B sin romperse.
    expect(Buffer.from(job.payload, 'base64').slice(0, 2).toString('hex')).toBe('1b40');
  });

  it('dos PCs tomando a la vez NO sacan el mismo ticket dos veces', async () => {
    const a = await nuevoAgente('PC uno');
    const b = await nuevoAgente('PC dos');
    await api().post(url(`/printers/${printer.id}/test`)).set(auth(manager));
    const [uno, dos] = await Promise.all([
      comoAgente(a.token, 'get', '/api/print-agent/jobs'),
      comoAgente(b.token, 'get', '/api/print-agent/jobs'),
    ]);
    // Es lo único que impide que el cliente reciba dos cuentas idénticas.
    const total = uno.body.jobs.length + dos.body.jobs.length;
    expect(total).toBe(1);
  });

  it('lo que ya se imprimió no vuelve a la cola', async () => {
    const agente = await nuevoAgente();
    await api().post(url(`/printers/${printer.id}/test`)).set(auth(manager));
    const tomado = (await comoAgente(agente.token, 'get', '/api/print-agent/jobs')).body.jobs[0];
    await comoAgente(agente.token, 'post', `/api/print-agent/jobs/${tomado.id}/done`).send({});
    const otra = await comoAgente(agente.token, 'get', '/api/print-agent/jobs');
    expect(otra.body.jobs).toHaveLength(0);
  });

  it('el trabajo de una PC que apagaron a medias vuelve a la cola, no se pierde', async () => {
    const agente = await nuevoAgente();
    await api().post(url(`/printers/${printer.id}/test`)).set(auth(manager));
    const tomado = (await comoAgente(agente.token, 'get', '/api/print-agent/jobs')).body.jobs[0];
    // Se apagó la PC con el trabajo en la mano: nunca reportó nada.
    await pool.query(
      `UPDATE print_jobs SET taken_at = now() - interval '5 minutes' WHERE id = $1`,
      [tomado.id]);
    const otro = await nuevoAgente('PC dos');
    const res = await comoAgente(otro.token, 'get', '/api/print-agent/jobs');
    expect(res.body.jobs.map((j) => j.id)).toContain(tomado.id);
  });
});

describe('Cuando la impresora falla', () => {
  let printer; let agente;
  beforeEach(async () => {
    printer = (await altaImpresora(manager)).body.printer;
    agente = await nuevoAgente();
  });

  const encolar = async () => {
    const res = await api().post(url(`/printers/${printer.id}/test`)).set(auth(manager));
    return res.body.job.id;
  };
  const tomarYFallar = async (jobId, error = 'sin papel') => {
    await comoAgente(agente.token, 'get', '/api/print-agent/jobs');
    return comoAgente(agente.token, 'post', `/api/print-agent/jobs/${jobId}/failed`)
      .send({ error });
  };

  it('se reintenta: sin papel dura minutos, no es el final', async () => {
    const jobId = await encolar();
    const res = await tomarYFallar(jobId);
    expect(res.body.job.status).toBe('pending');
    expect(res.body.job.last_error).toBe('sin papel');
  });

  it('pasados los intentos se rinde y lo dice, en vez de callarse', async () => {
    const jobId = await encolar();
    await tomarYFallar(jobId);
    await tomarYFallar(jobId);
    const tercera = await tomarYFallar(jobId);
    // Un ticket que no salió y nadie sabe es peor que uno que no salió y se ve en rojo.
    expect(tercera.body.job.status).toBe('failed');
  });

  it('con impresora de respaldo, el papel sale en la hermana de la barra', async () => {
    const respaldo = (await altaImpresora(manager, {
      purpose: 'orders', name: 'Barra baja · bartender', host: '192.168.1.51',
    })).body.printer;
    await api().patch(url(`/printers/${printer.id}`)).set(auth(manager))
      .send({ fallback_id: respaldo.id });

    const jobId = await encolar();
    await tomarYFallar(jobId);
    const segunda = await tomarYFallar(jobId);

    // El desvío es un trabajo NUEVO: uno ya escrito no cambia de impresora, porque
    // entonces nadie podría reconstruir después dónde se suponía que iba a salir.
    expect(segunda.body.rerouted).toBe(true);
    expect(segunda.body.job.id).not.toBe(jobId);
    expect(segunda.body.job.printer_id).toBe(respaldo.id);
    expect(segunda.body.job.rerouted_from).toBe(printer.id);
    expect(segunda.body.job.status).toBe('pending');
  });

  it('un papel ya desviado no rebota de vuelta a la que falló', async () => {
    const respaldo = (await altaImpresora(manager, {
      purpose: 'orders', name: 'Barra baja · bartender', host: '192.168.1.51',
    })).body.printer;
    await api().patch(url(`/printers/${printer.id}`)).set(auth(manager))
      .send({ fallback_id: respaldo.id });
    await api().patch(url(`/printers/${respaldo.id}`)).set(auth(manager))
      .send({ fallback_id: printer.id });

    const jobId = await encolar();
    await tomarYFallar(jobId);
    const desviado = (await tomarYFallar(jobId)).body.job;

    await tomarYFallar(desviado.id);
    await tomarYFallar(desviado.id);
    const otra = await tomarYFallar(desviado.id);
    // Con dos impresoras por barra el siguiente salto sería de regreso, y el papel
    // andaría rebotando mientras el cliente espera su cuenta. Se queda donde está,
    // agota sus intentos y se rinde ahí.
    expect(otra.body.rerouted).toBe(false);
    expect(otra.body.job.status).toBe('failed');
    expect(otra.body.job.printer_id).toBe(respaldo.id);
  });

  it('lo que no salió se ve arriba en el panel del gerente', async () => {
    const jobId = await encolar();
    await tomarYFallar(jobId);
    await tomarYFallar(jobId);
    await tomarYFallar(jobId);
    const lista = await api().get(url('/print-jobs')).set(auth(manager));
    expect(lista.body.jobs[0].status).toBe('failed');
  });

  it('se reimprime tal cual salió, aunque los precios hayan cambiado', async () => {
    const jobId = await encolar();
    const { rows: antes } = await pool.query('SELECT payload FROM print_jobs WHERE id = $1',
      [jobId]);
    const res = await api().post(url(`/print-jobs/${jobId}/reprint`)).set(auth(manager));
    expect(res.status).toBe(202);
    const { rows: copia } = await pool.query('SELECT payload FROM print_jobs WHERE id = $1',
      [res.body.job.id]);
    expect(copia[0].payload.equals(antes[0].payload)).toBe(true);
  });
});

describe('Lo que ya se imprimió no se reescribe', () => {
  it('un trabajo no se borra, y un ticket impreso no cambia de contenido', async () => {
    const printer = (await altaImpresora(manager)).body.printer;
    const job = (await api().post(url(`/printers/${printer.id}/test`)).set(auth(manager)))
      .body.job;
    await expect(pool.query('DELETE FROM print_jobs WHERE id = $1', [job.id]))
      .rejects.toMatchObject({ code: '23001' });
    // Un ticket impreso está en la mano de alguien: cambiar aquí lo que dice sería
    // inventar una historia distinta de la que anda circulando por el club.
    await expect(pool.query(`UPDATE print_jobs SET preview = 'otra cosa' WHERE id = $1`, [job.id]))
      .rejects.toMatchObject({ code: '23001' });
  });
});

describe('El interruptor de la comanda por pedido', () => {
  it('arranca apagado: un club sin impresoras no debe encolar papel que nadie recoge', async () => {
    const res = await api().get(url('/print-settings')).set(auth(manager));
    expect(res.body.settings).toMatchObject({ print_order_tickets: false, print_receipts: true });
  });

  it('lo prende el gerente, no solo el admin (D58)', async () => {
    // Quien está en el club a las dos de la mañana cuando una impresora se atasca es
    // el gerente. Pedirle que localice al dueño para apagar un interruptor es pedirle
    // que no lo apague.
    const suyo = await api().patch(url('/print-settings')).set(auth(manager))
      .send({ print_order_tickets: true });
    expect(suyo.status).toBe(200);
    expect(suyo.body.settings.print_order_tickets).toBe(true);

    const delAdmin = await api().patch(url('/print-settings')).set(auth(admin))
      .send({ print_order_tickets: false });
    expect(delAdmin.status).toBe(200);
    expect(delAdmin.body.settings.print_order_tickets).toBe(false);
  });

  it('y un mesero no lo toca', async () => {
    // Repartir el permiso no es abrirlo: sigue siendo de quien manda en la noche.
    expect((await api().patch(url('/print-settings')).set(auth(waiter))
      .send({ print_order_tickets: true })).status).toBe(403);
  });

  it('queda constancia de quién lo movió', async () => {
    // Es lo que hace que ampliar el permiso no sea aflojar el control. Si una noche
    // no salió una sola comanda, esto dice quién lo apagó y a qué hora.
    await api().patch(url('/print-settings')).set(auth(manager))
      .send({ print_order_tickets: true });
    const { rows } = await pool.query(
      `SELECT updated_by::text AS updated_by, updated_at
         FROM nightclub_print_settings WHERE nightclub_id = $1`, [club.id]);
    expect(rows[0].updated_by).toBe(manager.id);
    expect(rows[0].updated_at).not.toBeNull();
  });

  it('lo que no se manda no se pisa', async () => {
    await api().patch(url('/print-settings')).set(auth(admin))
      .send({ print_order_tickets: true, footer_text: 'Gracias por su visita' });
    await api().patch(url('/print-settings')).set(auth(admin)).send({ max_attempts: 5 });
    const res = await api().get(url('/print-settings')).set(auth(manager));
    expect(res.body.settings).toMatchObject({
      print_order_tickets: true, footer_text: 'Gracias por su visita', max_attempts: 5,
    });
  });
});

describe('Buscar impresoras en vez de teclear su IP (D55)', () => {
  const scanDe = async (agentId) => {
    const { rows } = await pool.query(
      `SELECT scan_requested_at, scan_at, scan_result, scan_error
         FROM print_agents WHERE id = $1`, [agentId]);
    return rows[0];
  };

  it('el gerente pide la búsqueda y se le encarga a TODAS las PCs', async () => {
    // Con dos agentes lo interesante no es "hay una impresora en el .50": es cuál PC
    // la alcanza, que es lo que decide a quién ponerle de respaldo a quién.
    const a = await nuevoAgente('PC barra baja');
    const b = await nuevoAgente('PC barra alta');
    const res = await api().post(url('/print-agents/scan')).set(auth(manager));

    expect(res.status).toBe(202);
    expect(res.body.asked).toBe(2);
    expect((await scanDe(a.id)).scan_requested_at).not.toBeNull();
    expect((await scanDe(b.id)).scan_requested_at).not.toBeNull();
  });

  it('sin ninguna PC dada de alta lo dice, en vez de encolar algo que nadie hará', async () => {
    const res = await api().post(url('/print-agents/scan')).set(auth(manager));
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/PC/);
  });

  it('una PC apagada no recibe el encargo', async () => {
    const a = await nuevoAgente('PC apagada');
    await api().patch(url(`/print-agents/${a.id}`)).set(auth(manager)).send({ active: false });
    const res = await api().post(url('/print-agents/scan')).set(auth(manager));
    expect(res.status).toBe(400);
  });

  it('el agente ve el encargo en el mismo sondeo que ya hace', async () => {
    const a = await nuevoAgente();
    // La primera búsqueda ya venía pedida al emparejarse (D56): se consume y desde
    // ahí el encargo solo aparece cuando alguien lo pide.
    await comoAgente(a.token, 'post', '/api/print-agent/scan').send({ found: [] });
    expect((await comoAgente(a.token, 'get', '/api/print-agent/jobs')).body.scan).toBe(false);

    await api().post(url('/print-agents/scan')).set(auth(manager));
    // Un segundo canal sería una conexión más que se cae con cada parpadeo del
    // internet del club, para algo que se pide una vez al mes.
    expect((await comoAgente(a.token, 'get', '/api/print-agent/jobs')).body.scan).toBe(true);
  });

  it('reporta lo que encontró y deja de pedírsele', async () => {
    const a = await nuevoAgente();
    await api().post(url('/print-agents/scan')).set(auth(manager));
    const res = await comoAgente(a.token, 'post', '/api/print-agent/scan').send({
      found: [
        { kind: 'network', host: '192.168.1.50', port: 9100, model: 'XP-C260M' },
        { kind: 'windows', name: 'XP-80C', share: 'XP80' },
      ],
    });
    expect(res.status).toBe(200);
    const guardado = await scanDe(a.id);
    expect(guardado.scan_result).toHaveLength(2);
    expect(guardado.scan_result[0]).toMatchObject({ host: '192.168.1.50', model: 'XP-C260M' });
    expect((await comoAgente(a.token, 'get', '/api/print-agent/jobs')).body.scan).toBe(false);
  });

  it('una búsqueda que falla lo dice, en vez de dejar al gerente esperando', async () => {
    const a = await nuevoAgente();
    await api().post(url('/print-agents/scan')).set(auth(manager));
    await comoAgente(a.token, 'post', '/api/print-agent/scan')
      .send({ error: 'no hay ninguna red privada en esta PC' });
    const guardado = await scanDe(a.id);
    expect(guardado.scan_error).toMatch(/red privada/);
    expect(guardado.scan_result).toBeNull();
  });

  it('un encargo viejo se da por abandonado', async () => {
    const a = await nuevoAgente();
    await api().post(url('/print-agents/scan')).set(auth(manager));
    await pool.query(
      `UPDATE print_agents SET scan_requested_at = now() - interval '30 minutes' WHERE id = $1`,
      [a.id]);
    // Una PC que estuvo apagada media hora no debe ponerse a barrer la red al
    // prender, por algo que el gerente pidió cuando estaba en otra cosa.
    expect((await comoAgente(a.token, 'get', '/api/print-agent/jobs')).body.scan).toBe(false);
  });

  it('lo que manda el agente se recorta: es un programa del club, no una fuente de verdad', async () => {
    const a = await nuevoAgente();
    await api().post(url('/print-agents/scan')).set(auth(manager));
    const muchas = Array.from({ length: 200 }, (_, i) => ({
      kind: 'network', host: `192.168.1.${i}`, port: 9100, model: 'x'.repeat(200),
    }));
    await comoAgente(a.token, 'post', '/api/print-agent/scan').send({ found: muchas });
    const guardado = await scanDe(a.id);
    // Ni una lista interminable ni texto de cualquier largo en la pantalla del gerente.
    expect(guardado.scan_result.length).toBeLessThanOrEqual(64);
    expect(guardado.scan_result[0].model.length).toBeLessThanOrEqual(80);
  });

  it('el gerente ve el resultado junto a la PC que lo encontró', async () => {
    const a = await nuevoAgente('PC barra baja');
    await api().post(url('/print-agents/scan')).set(auth(manager));
    await comoAgente(a.token, 'post', '/api/print-agent/scan')
      .send({ found: [{ kind: 'network', host: '192.168.1.50', port: 9100 }] });

    const lista = await api().get(url('/print-agents')).set(auth(manager));
    expect(lista.body.agents[0]).toMatchObject({ name: 'PC barra baja' });
    expect(lista.body.agents[0].scan_result[0].host).toBe('192.168.1.50');
  });

  it('un mesero no manda a buscar impresoras', async () => {
    await nuevoAgente();
    expect((await api().post(url('/print-agents/scan')).set(auth(waiter))).status).toBe(403);
  });
});

describe('Dar de alta una PC sin copiar un token (D56)', () => {
  it('el gerente pide un código corto, legible y de un solo uso', async () => {
    const invite = await nuevoCodigo();
    // Ocho caracteres en dos grupos: alguien lo lee de una pantalla y lo teclea en
    // otra máquina, y ahí es donde se confunde un 0 con una O.
    expect(invite.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(invite.code).not.toMatch(/[ILOU]/);
    expect(invite.ttl_minutes).toBe(10);
  });

  it('la base guarda la huella, no el código', async () => {
    const invite = await nuevoCodigo();
    const { rows } = await pool.query(
      'SELECT code_hash, code_hint FROM print_agent_invites WHERE id = $1', [invite.id]);
    expect(rows[0].code_hash).not.toContain(invite.code.replace('-', ''));
    expect(rows[0].code_hash).toBe(printing.hashCode(invite.code));
    expect(invite.code.endsWith(rows[0].code_hint)).toBe(true);
  });

  it('la PC lo canjea, se nombra sola y recibe su token', async () => {
    const invite = await nuevoCodigo();
    const res = await emparejar(invite.code, 'DESKTOP-BARRA1');

    expect(res.status).toBe(201);
    // El token largo nunca pasa por las manos de nadie: llega por la red y lo escribe
    // el propio agente en su archivo.
    expect(res.body.token).toMatch(/^ev2ag_[0-9a-f]{48}$/);
    expect(res.body.agent.name).toBe('DESKTOP-BARRA1');

    // Y sirve de inmediato.
    const sondeo = await comoAgente(res.body.token, 'get', '/api/print-agent/jobs');
    expect(sondeo.status).toBe(200);
  });

  it('se acepta tecleado como sea: minúsculas, con guión o sin él', async () => {
    const invite = await nuevoCodigo();
    const res = await emparejar(invite.code.toLowerCase().replace('-', ' '));
    // Lo que se enseña lleva un guión, así que quien lo teclea va a ponerlo — o no.
    // Las dos formas son el mismo código.
    expect(res.status).toBe(201);
  });

  it('recién emparejada empieza a buscar impresoras sola', async () => {
    // Es la diferencia entre "ya quedó" y "ahora ve y pícale buscar".
    const invite = await nuevoCodigo();
    const res = await emparejar(invite.code);
    const sondeo = await comoAgente(res.body.token, 'get', '/api/print-agent/jobs');
    expect(sondeo.body.scan).toBe(true);
  });

  it('un código sirve UNA vez', async () => {
    const invite = await nuevoCodigo();
    expect((await emparejar(invite.code, 'PC uno')).status).toBe(201);
    const segunda = await emparejar(invite.code, 'PC dos');
    expect(segunda.status).toBe(403);
    expect(segunda.body.error.message).toBe('Código inválido o vencido');
  });

  it('un código vencido no sirve', async () => {
    const invite = await nuevoCodigo();
    await pool.query(
      `UPDATE print_agent_invites SET expires_at = now() - interval '1 minute' WHERE id = $1`,
      [invite.id]);
    expect((await emparejar(invite.code)).status).toBe(403);
  });

  it('un código inventado no dice nada que ayude a adivinar', async () => {
    const res = await emparejar('AAAA-BBBB');
    expect(res.status).toBe(403);
    // "No existe", "ya se usó" y "venció" son la misma respuesta a propósito.
    expect(res.body.error.message).toBe('Código inválido o vencido');
  });

  it('a fuerza de intentos, los códigos vivos se queman', async () => {
    const invite = await nuevoCodigo();
    for (let i = 0; i < printing.INVITE_MAX_ATTEMPTS; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await emparejar('ZZZZ-ZZZZ');
    }
    // Ocho caracteres son adivinables para una máquina; lo que lo impide no es el
    // largo, es que el código muera antes de que probar valga la pena.
    expect((await emparejar(invite.code)).status).toBe(403);
  });

  it('dos PCs con el mismo nombre de Windows no se pisan', async () => {
    const a = await emparejar((await nuevoCodigo()).code, 'DESKTOP-PC');
    const b = await emparejar((await nuevoCodigo()).code, 'DESKTOP-PC');
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    // Quien está parado en la barra no puede resolver un choque de nombres.
    expect(b.body.agent.name).not.toBe(a.body.agent.name);
  });

  it('queda constancia de cómo entró esa PC, y no se puede reescribir', async () => {
    const invite = await nuevoCodigo();
    await emparejar(invite.code, 'DESKTOP-BARRA1');
    const { rows } = await pool.query(
      `SELECT used_at, used_agent_id, used_ip FROM print_agent_invites WHERE id = $1`,
      [invite.id]);
    expect(rows[0].used_at).not.toBeNull();
    expect(rows[0].used_agent_id).not.toBeNull();

    await expect(pool.query(
      `UPDATE print_agent_invites SET used_agent_id = NULL WHERE id = $1`, [invite.id]))
      .rejects.toMatchObject({ code: '23001' });
    await expect(pool.query('DELETE FROM print_agent_invites WHERE id = $1', [invite.id]))
      .rejects.toMatchObject({ code: '23001' });
  });

  it('el gerente ve los códigos vivos, pero nunca el código otra vez', async () => {
    const invite = await nuevoCodigo();
    const lista = await api().get(url('/print-agents')).set(auth(manager));
    expect(lista.body.invites).toHaveLength(1);
    expect(lista.body.invites[0].code).toBeUndefined();
    expect(lista.body.invites[0].code_hint).toBe(invite.code.slice(-4));
  });

  it('un mesero no emite códigos', async () => {
    expect((await api().post(url('/print-agents/invite')).set(auth(waiter))).status).toBe(403);
  });
});

/**
 * D57 — instalar el agente desde el navegador.
 *
 * El caso real: el gerente entra al panel desde una PC de barra recién puesta, donde
 * no hay ninguna carpeta `agent/` porque nadie la copió por USB. Si esto falla, esa
 * PC no imprime y no hay manera de arreglarlo sin una memoria y un viaje.
 *
 * Lo que se prueba aquí es lo único que se rompe en silencio: que lo que sirve la API
 * sea **el archivo del repositorio**, byte a byte. El día que alguien mueva `agent/`
 * o cambie el contexto de build, esto falla aquí y no en la barra a las once de la
 * noche.
 */
describe('Instalar el agente desde el navegador (D57)', () => {
  const fs = require('fs');
  const path = require('path');
  const AGENT_DIR = path.resolve(__dirname, '../../agent');

  let origenes;
  beforeEach(() => { origenes = process.env.ALLOWED_ORIGINS; });
  afterEach(() => { process.env.ALLOWED_ORIGINS = origenes; });

  it('sirve el agente tal cual está en el repositorio, byte a byte', async () => {
    for (const archivo of ['print-agent.js', 'package.json']) {
      const res = await api().get(`/api/print-agent/files/${archivo}`).buffer().parse((r, cb) => {
        const trozos = [];
        r.on('data', (d) => trozos.push(d));
        r.on('end', () => cb(null, Buffer.concat(trozos)));
      });
      expect(res.status).toBe(200);
      expect(res.body.equals(fs.readFileSync(path.join(AGENT_DIR, archivo)))).toBe(true);
    }
  });

  it('no sirve nada que no sea del agente, ni el config con el token', async () => {
    // `config.json` vive en esa misma carpeta en una PC de barra y lleva su llave.
    expect((await api().get('/api/print-agent/files/config.json')).status).toBe(404);
    expect((await api().get('/api/print-agent/files/README.md')).status).toBe(404);
    expect((await api().get('/api/print-agent/files/..%2F..%2Fserver%2F.env')).status).toBe(404);
  });

  it('bajar el agente no pide sesión, pero tampoco la reemplaza', async () => {
    // Sin token: la descarga sí, tomar trabajos no. Que uno sea público no ablanda
    // al otro, que es lo que este proyecto no puede permitirse confundir.
    expect((await api().get('/api/print-agent/files/print-agent.js')).status).toBe(200);
    expect((await api().get('/api/print-agent/jobs')).status).toBe(401);
  });

  it('el instalador trae el dominio del club, no un ejemplo', async () => {
    process.env.ALLOWED_ORIGINS = 'https://ev2-clandestinoz.mx';
    const res = await api().get('/api/print-agent/install.ps1');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/plain/);
    expect(res.text).toContain("$ApiUrl  = 'https://ev2-clandestinoz.mx'");
    // Y baja los archivos de ese mismo lugar, no de otro.
    expect(res.text).toContain('$ApiUrl/api/print-agent/files/$archivo');
    expect(res.text).toContain("@('print-agent.js', 'package.json')");
  });

  it('un Host inventado no se cuela dentro del instalador', async () => {
    // Quien pide puede escribir el `Host` que quiera. Si eso mandara, bastaría con
    // pedir el instalador con el dominio de otro para que la PC de la barra bajara y
    // ejecutara lo que ese otro sirva. Manda ALLOWED_ORIGINS.
    process.env.ALLOWED_ORIGINS = 'https://ev2-clandestinoz.mx';
    const res = await api().get('/api/print-agent/install.ps1').set('Host', 'servidor-ajeno.mx');
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('servidor-ajeno.mx');
    expect(res.text).toContain("$ApiUrl  = 'https://ev2-clandestinoz.mx'");
  });

  it('sobre http no se genera instalador', async () => {
    process.env.ALLOWED_ORIGINS = 'http://ev2-clandestinoz.mx';
    const res = await api().get('/api/print-agent/install.ps1');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('insecure_install_url');
  });

  it('la imagen de la API se construye de forma que el agente venga adentro', () => {
    // Esto no es pedantería de despliegue: con el contexto anterior (`../server`) la
    // carpeta `agent/` quedaba FUERA del contexto de build, así que estas rutas
    // pasaban todas las pruebas aquí y contestaban 404 en el VPS. Si alguien vuelve a
    // apretar el contexto, se entera aquí.
    const raiz = path.resolve(__dirname, '../..');
    const dockerfile = fs.readFileSync(path.join(raiz, 'deploy/Dockerfile.api'), 'utf8');
    expect(dockerfile).toMatch(/^COPY agent \.\/agent$/m);
    expect(dockerfile).toMatch(/^COPY server\/src \.\/src$/m);

    for (const archivo of ['deploy/docker-compose.prod.yml', 'deploy/docker-compose.yml']) {
      const compose = fs.readFileSync(path.join(raiz, archivo), 'utf8');
      const api2 = compose.slice(compose.indexOf('\n  api:'));
      const build = api2.slice(0, api2.indexOf('container_name'));
      expect(build).toMatch(/context: \.\.$/m);
      expect(build).toMatch(/dockerfile: deploy\/Dockerfile\.api$/m);
    }

    // Y que el proxy de enfrente deje pasar la descarga. Sin el `^~`, la regla por
    // extensión de nginx le gana a la de prefijo y se queda con cualquier `/api/…`
    // que acabe en `.js` buscándola entre los archivos estáticos: 404 justo para
    // `files/print-agent.js`, con el resto de la API contestando perfecto.
    const nginx = fs.readFileSync(path.join(raiz, 'deploy/nginx-web.conf'), 'utf8');
    expect(nginx).toMatch(/location \^~ \/api\/ \{/);

    // Y que el contexto no se lleve por delante el código de la propia API.
    const ignorar = fs.readFileSync(path.join(raiz, '.dockerignore'), 'utf8')
      .split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    expect(ignorar).not.toContain('server');
    expect(ignorar).toContain('agent/config.json');
  });

  it('el instalador se niega él solo si alguien le cambia la dirección', async () => {
    // El servidor no genera nada que no sea https, pero el archivo se puede guardar y
    // pasar de mano. La comprobación viaja dentro del script.
    const res = await api().get('/api/print-agent/install.ps1');
    expect(res.text).toContain("-notmatch '^https://'");
  });
});
