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

/** Crea un agente y devuelve su token en claro, que solo se ve esta vez. */
async function nuevoAgente(name = 'PC barra baja') {
  const res = await api().post(url('/print-agents')).set(auth(manager)).send({ name });
  return res.body.agent;
}

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

  it('lo prende el admin, y no el gerente', async () => {
    expect((await api().patch(url('/print-settings')).set(auth(manager))
      .send({ print_order_tickets: true })).status).toBe(403);
    const res = await api().patch(url('/print-settings')).set(auth(admin))
      .send({ print_order_tickets: true });
    expect(res.status).toBe(200);
    expect(res.body.settings.print_order_tickets).toBe(true);
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
