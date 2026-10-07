// Checador de huella (D94): consentimiento, registro, PC checadora, entrada y salida.
//
// El comparador real (matcher/, Java + SourceAFIS) se prueba aparte con huellas de
// verdad. Aquí se sustituye `fetch` por un comparador de mentira que entiende
// "imágenes" de la forma `HUELLA:<dedo>:<n>`: dos imágenes del mismo <dedo> coinciden
// con 100 puntos y de dedos distintos con 5. Lo que se prueba es lo que hace la API
// con esos puntajes.
'use strict';

const { setupSchema, truncateAll, closePool, pool } = require('./helpers/db');
const { api, auth } = require('./helpers/api');
const f = require('./helpers/factories');
const pins = require('../src/services/pins');
const fp = require('../src/services/fingerprints');

process.env.FINGERPRINT_KEY = 'test-fingerprint-key-0123456789-0123456789';
process.env.MATCHER_URL = 'http://matcher.test:8090';
process.env.MATCHER_TOKEN = 'test-matcher-token-0123456789-0123456789';

const realFetch = global.fetch;
let matcherDown = false;
const matcherCalls = [];

/** Una "imagen" de prueba: base64 de un texto largo que dice de qué dedo es. */
const huella = (dedo, n = 1) => Buffer.from(`HUELLA:${dedo}:${n}:${'x'.repeat(120)}`).toString('base64');
const dedoDe = (b64) => Buffer.from(b64, 'base64').toString('utf8').split(':')[1];
const score = (a, b) => (a === b ? 100 : 5);

function fakeMatcher(url, init) {
  if (!String(url).startsWith(process.env.MATCHER_URL)) return realFetch(url, init);
  if (matcherDown) return Promise.reject(new Error('ECONNREFUSED'));
  const body = JSON.parse(init.body);
  const path = new URL(url).pathname;
  matcherCalls.push({ path, token: init.headers['x-matcher-token'], body });
  const reply = (status, data) => Promise.resolve({ ok: status < 400, status, json: async () => data });
  if (init.headers['x-matcher-token'] !== process.env.MATCHER_TOKEN) return reply(401, { error: 'unauthorized' });
  if (path === '/extract') {
    const dedos = body.images.map(dedoDe);
    if (dedos.includes('borrosa')) return reply(422, { error: 'bad_image' });
    const pairs = [];
    for (let i = 0; i < dedos.length; i += 1) {
      for (let j = i + 1; j < dedos.length; j += 1) pairs.push([i, j, score(dedos[i], dedos[j])]);
    }
    // La "plantilla" es el nombre del dedo: suficiente para el comparador de mentira.
    return reply(200, { templates: dedos.map((d) => `T-${d}`), pairs });
  }
  if (path === '/identify') {
    const probe = dedoDe(body.image);
    const top = body.candidates
      .map((c) => ({ id: c.id, score: score(`T-${probe}`, c.template) }))
      .sort((a, b) => b.score - a.score).slice(0, 10);
    return reply(200, { top });
  }
  return reply(404, { error: 'not_found' });
}

let club; let manager; let waiter; let bartender; let cashier; let otherClubManager;

async function empleado(role, nombre, clubId = club.id) {
  const u = await f.createUser(clubId, { role, display_name: nombre });
  await pool.query('INSERT INTO employee_profiles (user_id) VALUES ($1)', [u.id]);
  return u;
}

async function pinDe(user) {
  const pin = await pins.issuePin(pool, { userId: user.id });
  await pool.query('UPDATE users SET must_change_pin = false WHERE id = $1', [user.id]);
  return pin;
}

/** Consentimiento con su PIN y dos dedos registrados. */
async function registrar(user, dedos = [`${user.id}-a`, `${user.id}-b`]) {
  const pin = await pinDe(user);
  const c = await api().post(`/api/nightclubs/${club.id}/employees/${user.id}/biometric-consent`)
    .set(auth(manager)).send({ pin });
  expect(c.status).toBe(201);
  const fingers = ['right_index', 'left_index'];
  for (let i = 0; i < dedos.length; i += 1) {
    const r = await api().post(`/api/nightclubs/${club.id}/employees/${user.id}/fingerprints`)
      .set(auth(manager))
      .send({ finger: fingers[i], images: [huella(dedos[i], 1), huella(dedos[i], 2), huella(dedos[i], 3)] });
    expect([r.status, r.body.error && r.body.error.message]).toEqual([201, undefined]);
  }
  return dedos;
}

async function estacion() {
  const r = await api().post(`/api/nightclubs/${club.id}/clock/stations`)
    .set(auth(manager)).send({ name: 'Caja barra de abajo' });
  expect(r.status).toBe(201);
  return r.body.token;
}

const marcar = (token, dedo) => api().post('/api/clock-station/punch')
  .set('X-Clock-Station-Token', token).send({ image: huella(dedo, 9) });

/** Echa para atrás la última marca de alguien, como si hubiera pasado el tiempo. */
async function atrasar(userId, minutos) {
  await pool.query('ALTER TABLE clock_events DISABLE TRIGGER clock_events_guard');
  await pool.query(
    `UPDATE clock_events SET created_at = created_at - make_interval(mins => $2::int)
      WHERE user_id = $1`, [userId, minutos]);
  await pool.query('ALTER TABLE clock_events ENABLE TRIGGER clock_events_guard');
}

beforeAll(async () => {
  await setupSchema();
  global.fetch = fakeMatcher;
});
afterAll(async () => {
  global.fetch = realFetch;
  await closePool();
});

beforeEach(async () => {
  await truncateAll();
  matcherDown = false;
  matcherCalls.length = 0;
  club = await f.createNightclub();
  manager = await empleado('manager', 'Gerente');
  waiter = await empleado('waiter', 'Juan Mesero');
  bartender = await empleado('bartender', 'Ana Barra');
  cashier = await empleado('cashier', 'Luis Caja');
  const otro = await f.createNightclub({ slug: 'otro-club', name: 'Otro', locations: false });
  otherClubManager = await empleado('manager', 'Gerente Otro', otro.id);
});

describe('configuración', () => {
  it('sin llaves no registra y dice qué falta', async () => {
    const guardada = process.env.FINGERPRINT_KEY;
    delete process.env.FINGERPRINT_KEY;
    try {
      const pin = await pinDe(waiter);
      await api().post(`/api/nightclubs/${club.id}/employees/${waiter.id}/biometric-consent`)
        .set(auth(manager)).send({ pin }).expect(201);
      const r = await api().post(`/api/nightclubs/${club.id}/employees/${waiter.id}/fingerprints`)
        .set(auth(manager)).send({ finger: 'right_index', images: [huella('a'), huella('a'), huella('a')] });
      expect(r.status).toBe(501);
      expect(r.body.error.message).toMatch(/FINGERPRINT_KEY/);
      const s = await api().get(`/api/nightclubs/${club.id}/clock`).set(auth(manager)).expect(200);
      expect(s.body.configured).toBe(false);
    } finally {
      process.env.FINGERPRINT_KEY = guardada;
    }
  });

  it('el comparador recibe su token y la resolución del lector', async () => {
    await registrar(waiter);
    expect(matcherCalls[0].token).toBe(process.env.MATCHER_TOKEN);
    expect(matcherCalls[0].body.dpi).toBe(512);
  });
});

describe('consentimiento', () => {
  it('lo confirma el empleado con SU PIN, no el del gerente', async () => {
    await pinDe(waiter);
    const pinGerente = await pinDe(manager);
    const r = await api().post(`/api/nightclubs/${club.id}/employees/${waiter.id}/biometric-consent`)
      .set(auth(manager)).send({ pin: pinGerente });
    expect(r.status).toBe(403);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM biometric_consents');
    expect(rows[0].n).toBe(0);
  });

  it('queda escrito quién fue testigo y qué aviso aceptó', async () => {
    const pin = await pinDe(waiter);
    const r = await api().post(`/api/nightclubs/${club.id}/employees/${waiter.id}/biometric-consent`)
      .set(auth(manager)).send({ pin }).expect(201);
    expect(r.body.consent.notice_version).toBe(fp.NOTICE_VERSION);
    expect(r.body.consent.witnessed_by).toBe(manager.id);
  });

  it('sin consentimiento no se registra ninguna huella', async () => {
    const r = await api().post(`/api/nightclubs/${club.id}/employees/${waiter.id}/fingerprints`)
      .set(auth(manager)).send({ finger: 'right_index', images: [huella('a'), huella('a'), huella('a')] });
    expect(r.status).toBe(422);
    expect(r.body.error.message).toMatch(/aviso de privacidad/);
  });

  it('retirarlo borra sus huellas en el acto', async () => {
    await registrar(waiter);
    const r = await api().delete(`/api/nightclubs/${club.id}/employees/${waiter.id}/biometric-consent`)
      .set(auth(manager)).expect(200);
    expect(r.body.fingerprints_deleted).toBe(2);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM staff_fingerprints');
    expect(rows[0].n).toBe(0);
  });

  it('un mesero no puede registrar huellas', async () => {
    const pin = await pinDe(waiter);
    await api().post(`/api/nightclubs/${club.id}/employees/${waiter.id}/biometric-consent`)
      .set(auth(waiter)).send({ pin }).expect(403);
  });

  it('el gerente de otro club no toca a este', async () => {
    const pin = await pinDe(waiter);
    await api().post(`/api/nightclubs/${club.id}/employees/${waiter.id}/biometric-consent`)
      .set(auth(otherClubManager)).send({ pin }).expect(403);
  });
});

describe('registro de huellas', () => {
  it('se guarda cifrada: ni la imagen ni la plantilla en claro', async () => {
    await registrar(waiter, ['dedo-juan', 'dedo-juan-2']);
    const { rows } = await pool.query('SELECT template_enc FROM staff_fingerprints');
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.template_enc.toString('latin1')).not.toMatch(/dedo-juan|HUELLA/);
    }
    const { rows: claro } = await pool.query(
      'SELECT pgp_sym_decrypt(template_enc, $1) AS t FROM staff_fingerprints ORDER BY finger DESC',
      [process.env.FINGERPRINT_KEY]);
    expect(JSON.parse(claro[0].t)).toEqual(['T-dedo-juan', 'T-dedo-juan', 'T-dedo-juan']);
  });

  it('las tres capturas tienen que ser del mismo dedo', async () => {
    const pin = await pinDe(waiter);
    await api().post(`/api/nightclubs/${club.id}/employees/${waiter.id}/biometric-consent`)
      .set(auth(manager)).send({ pin }).expect(201);
    const r = await api().post(`/api/nightclubs/${club.id}/employees/${waiter.id}/fingerprints`)
      .set(auth(manager)).send({ finger: 'right_index', images: [huella('a'), huella('a'), huella('b')] });
    expect(r.status).toBe(422);
    expect(r.body.error.message).toMatch(/no se parecen/);
  });

  it('una imagen que no es huella se dice como problema del dedo', async () => {
    const pin = await pinDe(waiter);
    await api().post(`/api/nightclubs/${club.id}/employees/${waiter.id}/biometric-consent`)
      .set(auth(manager)).send({ pin }).expect(201);
    const r = await api().post(`/api/nightclubs/${club.id}/employees/${waiter.id}/fingerprints`)
      .set(auth(manager)).send({ finger: 'right_index', images: [huella('borrosa'), huella('a'), huella('a')] });
    expect(r.status).toBe(422);
    expect(r.body.error.message).toMatch(/Limpia el lector/);
  });

  it('no deja registrar el dedo de otro a tu nombre', async () => {
    await registrar(waiter, ['dedo-juan', 'dedo-juan-2']);
    const pin = await pinDe(bartender);
    await api().post(`/api/nightclubs/${club.id}/employees/${bartender.id}/biometric-consent`)
      .set(auth(manager)).send({ pin }).expect(201);
    const r = await api().post(`/api/nightclubs/${club.id}/employees/${bartender.id}/fingerprints`)
      .set(auth(manager))
      .send({ finger: 'right_index', images: [huella('dedo-juan'), huella('dedo-juan'), huella('dedo-juan')] });
    expect(r.status).toBe(409);
    expect(r.body.error.message).toMatch(/Juan Mesero/);
  });

  it('el segundo dedo no puede ser el mismo que el primero', async () => {
    const pin = await pinDe(waiter);
    await api().post(`/api/nightclubs/${club.id}/employees/${waiter.id}/biometric-consent`)
      .set(auth(manager)).send({ pin }).expect(201);
    await api().post(`/api/nightclubs/${club.id}/employees/${waiter.id}/fingerprints`)
      .set(auth(manager)).send({ finger: 'right_index', images: [huella('a'), huella('a'), huella('a')] })
      .expect(201);
    const r = await api().post(`/api/nightclubs/${club.id}/employees/${waiter.id}/fingerprints`)
      .set(auth(manager)).send({ finger: 'left_index', images: [huella('a'), huella('a'), huella('a')] });
    expect(r.status).toBe(409);
    expect(r.body.error.message).toMatch(/otra mano/);
  });

  it('dos dedos por persona, no tres', async () => {
    await registrar(waiter);
    const r = await api().post(`/api/nightclubs/${club.id}/employees/${waiter.id}/fingerprints`)
      .set(auth(manager)).send({ finger: 'right_thumb', images: [huella('c'), huella('c'), huella('c')] });
    expect(r.status).toBe(422);
    expect(r.body.error.message).toMatch(/Ya tiene 2 dedos/);
  });

  it('el panel ve quién tiene qué, sin plantillas', async () => {
    await registrar(waiter);
    const r = await api().get(`/api/nightclubs/${club.id}/clock`).set(auth(manager)).expect(200);
    const juan = r.body.employees.find((e) => e.user_id === waiter.id);
    expect(juan.fingers.map((x) => x.finger).sort()).toEqual(['left_index', 'right_index']);
    expect(juan.consent_at).toBeTruthy();
    expect(JSON.stringify(r.body)).not.toMatch(/template/);
  });

  it('borrar un dedo', async () => {
    await registrar(waiter);
    await api().delete(`/api/nightclubs/${club.id}/employees/${waiter.id}/fingerprints/left_index`)
      .set(auth(manager)).expect(204);
    const { rows } = await pool.query('SELECT finger FROM staff_fingerprints');
    expect(rows.map((r) => r.finger)).toEqual(['right_index']);
  });
});

describe('la PC checadora', () => {
  it('el token sale una vez y la base guarda solo su huella', async () => {
    const token = await estacion();
    const { rows } = await pool.query('SELECT token_hash FROM clock_stations');
    expect(rows[0].token_hash).toBe(fp.hashToken(token));
    expect(rows[0].token_hash).not.toBe(token);
    const r = await api().get('/api/clock-station').set('X-Clock-Station-Token', token).expect(200);
    expect(r.body.station.name).toBe('Caja barra de abajo');
  });

  it('sin token, o con uno dado de baja, no marca nada', async () => {
    await registrar(waiter, ['dedo-juan', 'dedo-juan-2']);
    await api().post('/api/clock-station/punch').send({ image: huella('dedo-juan') }).expect(401);
    // Un token de persona tampoco sirve aquí.
    await api().post('/api/clock-station/punch').set(auth(manager)).send({ image: huella('dedo-juan') })
      .expect(401);
    const token = await estacion();
    const { rows } = await pool.query('SELECT id FROM clock_stations');
    await api().delete(`/api/nightclubs/${club.id}/clock/stations/${rows[0].id}`).set(auth(manager)).expect(204);
    await marcar(token, 'dedo-juan').expect(401);
  });
});

describe('marcar entrada y salida', () => {
  it('mesero: la huella abre el turno y después lo cierra', async () => {
    await registrar(waiter, ['dedo-juan', 'dedo-juan-2']);
    const token = await estacion();

    const entrada = await marcar(token, 'dedo-juan').expect(201);
    expect(entrada.body).toMatchObject({ kind: 'in', user: { name: 'Juan Mesero', role: 'waiter' } });
    const abierto = await pool.query('SELECT id FROM staff_shifts WHERE user_id = $1 AND ended_at IS NULL', [waiter.id]);
    expect(abierto.rowCount).toBe(1);

    await atrasar(waiter.id, 5);
    // Con el OTRO dedo también lo reconoce.
    const salida = await marcar(token, 'dedo-juan-2').expect(201);
    expect(salida.body.kind).toBe('out');
    const cerrado = await pool.query('SELECT ended_at FROM staff_shifts WHERE user_id = $1', [waiter.id]);
    expect(cerrado.rows[0].ended_at).not.toBeNull();

    const { rows } = await pool.query(
      'SELECT kind, shift_id, station_id FROM clock_events WHERE user_id = $1 ORDER BY id', [waiter.id]);
    expect(rows.map((r) => r.kind)).toEqual(['in', 'out']);
    expect(rows[0].shift_id).toBe(abierto.rows[0].id);
    expect(rows[1].station_id).toBeTruthy();
  });

  it('poner el dedo dos veces seguidas no marca entrada y salida', async () => {
    await registrar(waiter, ['dedo-juan', 'dedo-juan-2']);
    const token = await estacion();
    await marcar(token, 'dedo-juan').expect(201);
    const otra = await marcar(token, 'dedo-juan').expect(200);
    expect(otra.body).toMatchObject({ kind: 'in', repeated: true });
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM clock_events');
    expect(rows[0].n).toBe(1);
  });

  it('una entrada olvidada de ayer no convierte la de hoy en salida', async () => {
    await registrar(waiter, ['dedo-juan', 'dedo-juan-2']);
    const token = await estacion();
    await marcar(token, 'dedo-juan').expect(201);
    await atrasar(waiter.id, (fp.OPEN_ENTRY_HOURS + 1) * 60);
    // El turno de ayer lo cerró el gerente.
    await pool.query('UPDATE staff_shifts SET ended_at = now() WHERE user_id = $1', [waiter.id]);
    const hoy = await marcar(token, 'dedo-juan').expect(201);
    expect(hoy.body.kind).toBe('in');
  });

  it('una huella que no es de nadie no marca nada', async () => {
    await registrar(waiter, ['dedo-juan', 'dedo-juan-2']);
    const token = await estacion();
    const r = await marcar(token, 'dedo-extrano');
    expect(r.status).toBe(404);
    expect(r.body.error.message).toMatch(/No te reconocí/);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM clock_events');
    expect(rows[0].n).toBe(0);
  });

  it('si se parece a dos personas, no adivina', async () => {
    // Dos personas con el mismo "dedo" solo pasan si se registran a la fuerza en la base.
    await registrar(waiter, ['dedo-juan', 'dedo-juan-2']);
    await registrar(bartender, ['dedo-ana', 'dedo-ana-2']);
    await pool.query(
      `UPDATE staff_fingerprints SET template_enc = pgp_sym_encrypt('["T-gemelo"]', $1)
        WHERE finger = 'right_index'`, [process.env.FINGERPRINT_KEY]);
    const token = await estacion();
    const r = await marcar(token, 'gemelo');
    expect(r.status).toBe(409);
  });

  it('cajero: la huella marca asistencia pero no le abre turno', async () => {
    await registrar(cashier, ['dedo-luis', 'dedo-luis-2']);
    const token = await estacion();
    const r = await marcar(token, 'dedo-luis').expect(201);
    expect(r.body.kind).toBe('in');
    const { rowCount } = await pool.query('SELECT 1 FROM staff_shifts WHERE user_id = $1', [cashier.id]);
    expect(rowCount).toBe(0);
  });

  it('cajero con la caja abierta: no sale sin corte', async () => {
    await registrar(cashier, ['dedo-luis', 'dedo-luis-2']);
    const token = await estacion();
    await marcar(token, 'dedo-luis').expect(201);
    const caja = await f.openTill(club.id, { cashier, locationId: club.bar_id, authorizer: manager });
    await atrasar(cashier.id, 5);

    const r = await marcar(token, 'dedo-luis');
    expect(r.status).toBe(422);
    expect(r.body.error.message).toMatch(/Haz tu corte primero/);
    const { rows } = await pool.query('SELECT kind FROM clock_events WHERE user_id = $1', [cashier.id]);
    expect(rows.map((x) => x.kind)).toEqual(['in']);

    // El corte cierra el turno (aquí, directo en la base) y entonces sí sale.
    await pool.query('UPDATE staff_shifts SET ended_at = now() WHERE id = $1', [caja.id]);
    const ya = await marcar(token, 'dedo-luis').expect(201);
    expect(ya.body.kind).toBe('out');
  });

  it('la regla del corte es la misma que la del botón del teléfono', async () => {
    await registrar(bartender, ['dedo-ana', 'dedo-ana-2']);
    const token = await estacion();
    await marcar(token, 'dedo-ana').expect(201);
    await atrasar(bartender.id, 5);
    const staffShifts = require('../src/services/staff-shifts');
    const original = staffShifts.end;
    // Lo que dice la regla compartida cuando alguien cobró sin corte.
    staffShifts.end = async () => {
      const err = new Error('x'); err.needsCut = true; err.details = { total_collected: '480.00' };
      throw err;
    };
    try {
      const r = await marcar(token, 'dedo-ana');
      expect(r.status).toBe(422);
      expect(r.body.error.message).toMatch(/cobraste en este turno/);
    } finally {
      staffShifts.end = original;
    }
  });

  it('a un empleado dado de baja ya no lo reconoce, y sus huellas se borran', async () => {
    await registrar(waiter, ['dedo-juan', 'dedo-juan-2']);
    const token = await estacion();
    await marcar(token, 'dedo-juan').expect(201);

    await api().patch(`/api/nightclubs/${club.id}/employees/${waiter.id}`)
      .set(auth(manager)).send({ active: false }).expect(200);
    const huellas = await pool.query('SELECT count(*)::int AS n FROM staff_fingerprints');
    expect(huellas.rows[0].n).toBe(0);
    const consent = await pool.query('SELECT revoke_reason FROM biometric_consents WHERE user_id = $1', [waiter.id]);
    expect(consent.rows[0].revoke_reason).toBe('terminated');
    // La asistencia se queda.
    const asistencia = await pool.query('SELECT count(*)::int AS n FROM clock_events');
    expect(asistencia.rows[0].n).toBe(1);

    await registrar(bartender, ['dedo-ana', 'dedo-ana-2']);
    await atrasar(waiter.id, 5);
    await marcar(token, 'dedo-juan').expect(404);
  });

  it('si el comparador no responde, lo dice como falla del sistema', async () => {
    await registrar(waiter, ['dedo-juan', 'dedo-juan-2']);
    const token = await estacion();
    matcherDown = true;
    const r = await marcar(token, 'dedo-juan');
    expect(r.status).toBe(503);
    expect(r.body.error.message).toMatch(/Avisa al gerente/);
  });

  it('el gerente ve la asistencia', async () => {
    await registrar(waiter, ['dedo-juan', 'dedo-juan-2']);
    const token = await estacion();
    await marcar(token, 'dedo-juan').expect(201);
    const r = await api().get(`/api/nightclubs/${club.id}/clock/events`).set(auth(manager)).expect(200);
    expect(r.body.events).toHaveLength(1);
    expect(r.body.events[0]).toMatchObject({ name: 'Juan Mesero', kind: 'in', station_name: 'Caja barra de abajo' });
    await api().get(`/api/nightclubs/${club.id}/clock/events`).set(auth(waiter)).expect(403);
  });

  it('cada marca avisa a la gerencia, y solo a la gerencia', async () => {
    await registrar(waiter, ['dedo-juan', 'dedo-juan-2']);
    const token = await estacion();
    await marcar(token, 'dedo-juan').expect(201);
    const { rows } = await pool.query(`SELECT audience, payload FROM events WHERE type = 'clock_punch'`);
    expect(rows).toHaveLength(1);
    expect(rows[0].audience).toEqual({ roles: ['manager', 'admin'] });
    expect(rows[0].payload).toMatchObject({ name: 'Juan Mesero', kind: 'in' });
  });
});

describe('la asistencia no se edita', () => {
  it('ni se cambia ni se borra', async () => {
    await registrar(waiter, ['dedo-juan', 'dedo-juan-2']);
    const token = await estacion();
    await marcar(token, 'dedo-juan').expect(201);
    await expect(pool.query("UPDATE clock_events SET kind = 'out'")).rejects.toThrow(/not edited/);
    await expect(pool.query('DELETE FROM clock_events')).rejects.toThrow(/not deleted/);
  });
});
