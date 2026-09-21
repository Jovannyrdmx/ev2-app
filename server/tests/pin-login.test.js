/**
 * El acceso por PIN (D46).
 *
 * El dueño escogió entrar **solo con el PIN**, sin número de empleado ni lista de
 * nombres. Es lo más rápido con las manos ocupadas y tiene un costo concreto:
 *
 *   Seis dígitos son 1,000,000 de combinaciones. Con 40 empleados, cada intento a
 *   ciegas le atina a ALGUIEN con probabilidad 1 en 25,000. No se ataca una cuenta:
 *   se ataca el espacio entero, y por eso las defensas normales no sirven.
 *
 * Lo que se prueba aquí es exactamente eso — no "que se pueda entrar con un PIN", que
 * es la parte fácil:
 *
 *   1. El freno se cuenta POR CLUB. Bloquear la cuenta atacada no sirve cuando no se
 *      sabe cuál es, y limitar por IP no alcanza contra alguien con diez conexiones.
 *   2. Nada distingue un PIN inexistente de uno bloqueado, de otro club, o de un rol
 *      que no entra por aquí. Cualquier diferencia convierte la ruta en una forma de
 *      averiguar PINes ajenos de a uno por intento.
 *   3. La puerta NO se cierra bajo ataque, se frena. Cerrarla dejaría al personal sin
 *      entrar a las once de un sábado, y le regalaría a cualquiera una forma de apagar
 *      el club tecleando PINes equivocados.
 *   4. Un rechazo al cambiar el PIN no dice si fue por débil o por ocupado.
 */
'use strict';

const { setupSchema, truncateAll, closePool, pool } = require('./helpers/db');
const { api, auth } = require('./helpers/api');
const f = require('./helpers/factories');
const pins = require('../src/services/pins');
const clubNetwork = require('../src/services/club-network');

let club; let otroClub; let manager; let admin;

beforeAll(setupSchema);
afterAll(closePool);

beforeEach(async () => {
  await truncateAll();
  club = await f.createNightclub({ slug: 'ev2-pin' });
  otroClub = await f.createNightclub({ slug: 'ev2-pin-2' });
  manager = await f.createUser(club.id, { role: 'manager' });
  admin = await f.createUser(club.id, { role: 'admin' });
  delete process.env.CLUB_NETWORKS;
});

/** Le pone un PIN conocido a alguien, como lo haría el alta. */
async function darPin(userId, pin, { mustChange = false } = {}) {
  const ok = await pins.setPin(pool, { userId, pin, mustChange });
  expect(ok).toBe(true);
  return pin;
}

const entrar = (pin, slug = 'ev2-pin') => api().post('/api/auth/pin-login')
  .send({ nightclub_slug: slug, pin });

describe('Los PIN que no se permiten', () => {
  it('rechaza los obvios: iguales, escaleras y patrones', () => {
    const malos = ['000000', '999999', '123456', '234567', '987654', '543210',
      '121212', '123123', '112233', '454545'];
    expect(malos.filter((p) => !pins.isWeakPin(p))).toEqual([]);
  });

  it('acepta los que sí parecen un PIN', () => {
    const buenos = ['481937', '205864', '739215', '160492'];
    expect(buenos.filter((p) => pins.isWeakPin(p))).toEqual([]);
  });

  it('reconoce la fecha de nacimiento, venga como texto o como Date', () => {
    // Postgres entrega una columna DATE como objeto `Date`. Sin cubrir los dos casos
    // esta comprobación era decorativa y aceptaba la fecha de nacimiento como PIN.
    for (const fecha of ['1996-05-04', new Date('1996-05-04T00:00:00Z')]) {
      expect(pins.looksLikeBirthDate('040596', fecha)).toBe(true);
      expect(pins.looksLikeBirthDate('050496', fecha)).toBe(true);
      expect(pins.looksLikeBirthDate('481937', fecha)).toBe(false);
    }
  });

  it('el generador nunca entrega uno prohibido', () => {
    const generados = Array.from({ length: 300 }, () => pins.generatePin({ birthDate: '1996-05-04' }));
    expect(generados.filter((p) => pins.isWeakPin(p))).toEqual([]);
    expect(generados.filter((p) => pins.looksLikeBirthDate(p, '1996-05-04'))).toEqual([]);
    expect(generados.every((p) => /^\d{6}$/.test(p))).toBe(true);
    // Y son distintos entre sí: un generador predecible no es un generador.
    expect(new Set(generados).size).toBeGreaterThan(280);
  });

  it('la huella se puede buscar pero no deshacer sin la llave', () => {
    const uno = pins.lookupOf('481937');
    expect(uno).toBe(pins.lookupOf('481937'));
    expect(uno).not.toBe(pins.lookupOf('481938'));
    expect(uno).not.toContain('481937');

    // Con otra llave, la misma combinación da otra huella. Eso es lo que hace inútil
    // la base robada sin el .env.
    const antes = process.env.PIN_LOOKUP_KEY;
    process.env.PIN_LOOKUP_KEY = 'otra-llave-completamente-distinta-0123456789';
    expect(pins.lookupOf('481937')).not.toBe(uno);
    process.env.PIN_LOOKUP_KEY = antes;
  });
});

describe('Entrar con el PIN', () => {
  it('el empleado entra y recibe su sesión', async () => {
    const mesero = await f.createUser(club.id, { role: 'waiter', display_name: 'Luis' });
    await darPin(mesero.id, '481937');

    const res = await entrar('481937');
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ id: mesero.id, role: 'waiter', has_pin: true });
    expect(res.body.access_token).toBeTruthy();
    expect(res.body.refresh_token).toBeTruthy();
  });

  it('el PIN no se repite dentro del club', async () => {
    const uno = await f.createUser(club.id, { role: 'waiter' });
    const otro = await f.createUser(club.id, { role: 'bartender' });
    await darPin(uno.id, '481937');
    // El segundo no lo puede tomar: lo impide el índice de la base, no una lectura
    // previa —entre el "¿está libre?" y el "tómalo" cabe otro que lo tome primero—.
    expect(await pins.setPin(pool, { userId: otro.id, pin: '481937' })).toBe(false);
  });

  it('el mismo PIN en OTRO club sí se puede, y no se confunden', async () => {
    const aqui = await f.createUser(club.id, { role: 'waiter' });
    const alla = await f.createUser(otroClub.id, { role: 'waiter' });
    await darPin(aqui.id, '481937');
    await darPin(alla.id, '481937');

    expect((await entrar('481937')).body.user.id).toBe(aqui.id);
    expect((await entrar('481937', 'ev2-pin-2')).body.user.id).toBe(alla.id);
  });

  it('todo lo que falla suena EXACTAMENTE igual', async () => {
    // Es la regla más importante de esta ruta. Si un PIN bloqueado respondiera
    // distinto de uno inexistente, probar PINes diría cuáles existen.
    const baja = await f.createUser(club.id, { role: 'waiter' });
    await darPin(baja.id, '205864');
    await pool.query("UPDATE users SET status = 'blocked' WHERE id = $1", [baja.id]);

    const cliente = await f.createUser(club.id, { role: 'guest' });
    await darPin(cliente.id, '739215');

    const deOtroClub = await f.createUser(otroClub.id, { role: 'waiter' });
    await darPin(deOtroClub.id, '160492');

    const respuestas = await Promise.all([
      entrar('481937'), // no es de nadie
      entrar('205864'), // existe, pero la cuenta está bloqueada
      entrar('739215'), // existe, pero es de un cliente y no entra por aquí
      entrar('160492'), // existe, pero es de otro club
    ]);
    const distintas = new Set(respuestas.map((r) => `${r.status}:${r.body.error.message}`));
    expect([...distintas]).toHaveLength(1);
    expect(respuestas[0].status).toBe(401);
  });

  it('un club que no existe tampoco se delata', async () => {
    const res = await entrar('481937', 'club-que-no-existe');
    expect(res.status).toBe(401);
  });

  it('una sola sesión abierta: la segunda entrada cierra la primera', async () => {
    const mesero = await f.createUser(club.id, { role: 'waiter' });
    await darPin(mesero.id, '481937');

    const primera = await entrar('481937');
    const segunda = await entrar('481937');

    expect((await api().post('/api/auth/refresh')
      .send({ refresh_token: primera.body.refresh_token })).status).toBe(401);
    expect((await api().post('/api/auth/refresh')
      .send({ refresh_token: segunda.body.refresh_token })).status).toBe(200);
  });
});

describe('El freno del club', () => {
  it('cuenta los fallos del CLUB, no de una cuenta', async () => {
    // Es lo que distingue esta defensa de la normal: al no haber cuenta atacada, la
    // única forma de acotar el ataque es contar el total del club.
    await Promise.all([entrar('111112'), entrar('222223'), entrar('333334')]);
    expect(await pins.recentFailures(pool, { nightclubId: club.id })).toBe(3);
    // Y los de otro club no cuentan para este.
    await entrar('444445', 'ev2-pin-2');
    expect(await pins.recentFailures(pool, { nightclubId: club.id })).toBe(3);
    expect(await pins.recentFailures(pool, { nightclubId: otroClub.id })).toBe(1);
  });

  it('la espera sube por escalones, y no hay espera sin ataque', () => {
    expect(pins.delayFor(0)).toBe(0);
    expect(pins.delayFor(29)).toBe(0);
    expect(pins.delayFor(30)).toBe(2000);
    expect(pins.delayFor(99)).toBe(2000);
    expect(pins.delayFor(100)).toBe(5000);
    expect(pins.delayFor(5000)).toBe(5000);
  });

  it('bajo ataque FRENA pero NO cierra: el personal sigue entrando', async () => {
    // Cerrar la puerta dejaría al club entero sin trabajar a las once de un sábado, y
    // le daría a cualquiera una forma de apagarlo tecleando PINes equivocados.
    const mesero = await f.createUser(club.id, { role: 'waiter' });
    await darPin(mesero.id, '481937');

    const fallos = Array.from({ length: 35 }, (unused, i) => ({
      nightclub_id: club.id, pin: String(100000 + i),
    }));
    for (const intento of fallos) {
      // eslint-disable-next-line no-await-in-loop
      await pins.recordAttempt(pool, { nightclubId: intento.nightclub_id, ok: false });
    }
    expect(await pins.recentFailures(pool, { nightclubId: club.id }))
      .toBeGreaterThanOrEqual(30);

    // Frenado, sí; cerrado, no. El mesero de verdad entra igual.
    const res = await entrar('481937');
    expect(res.status).toBe(200);
  }, 20000);

  it('el acierto también queda escrito, para poder distinguir un ataque de un teclado malo', async () => {
    const mesero = await f.createUser(club.id, { role: 'waiter' });
    await darPin(mesero.id, '481937');
    await entrar('481937');
    await entrar('111112');

    const { rows } = await pool.query(
      'SELECT ok, user_id FROM pin_attempts WHERE nightclub_id = $1 ORDER BY id', [club.id]);
    expect(rows.map((r) => r.ok)).toEqual([true, false]);
    expect(rows[0].user_id).toBe(mesero.id);
    // En un fallo NO se guarda un usuario: no se sabe de quién era el intento, y
    // guardar uno adivinado sería inventar un dato.
    expect(rows[1].user_id).toBeNull();
  });
});

describe('La gerencia: PIN en el club, contraseña desde fuera', () => {
  it('sin CLUB_NETWORKS configurada, el gerente NO entra con PIN en ningún lado', async () => {
    // Falla hacia el lado seguro a propósito: un servidor recién instalado no debe
    // quedar aceptando PINes de gerente desde internet.
    await darPin(manager.id, '481937');
    const res = await entrar('481937');
    expect(res.status).toBe(403);
    expect(res.body.error.message).toMatch(/no está habilitado/i);
  });

  it('con la red del club configurada, entra desde adentro', async () => {
    // supertest llega como 127.0.0.1, así que esa es "la red del club" en la prueba.
    process.env.CLUB_NETWORKS = '127.0.0.0/8';
    await darPin(manager.id, '481937');
    expect((await entrar('481937')).status).toBe(200);
  });

  it('y NO desde fuera', async () => {
    process.env.CLUB_NETWORKS = '187.234.11.90';
    await darPin(admin.id, '205864');
    const res = await entrar('205864');
    expect(res.status).toBe(403);
    expect(res.body.error.message).toMatch(/red del club/i);
  });

  it('el piso entra desde donde sea: esto no le aplica', async () => {
    process.env.CLUB_NETWORKS = '187.234.11.90';
    const mesero = await f.createUser(club.id, { role: 'waiter' });
    await darPin(mesero.id, '739215');
    expect((await entrar('739215')).status).toBe(200);
  });

  it('reconoce la IP venga como venga', () => {
    process.env.CLUB_NETWORKS = '187.234.11.90,192.168.1.0/24';
    expect(clubNetwork.isInsideClub('187.234.11.90')).toBe(true);
    // Express puede entregarla envuelta en forma IPv6 según por cuántas capas pasó.
    expect(clubNetwork.isInsideClub('::ffff:187.234.11.90')).toBe(true);
    expect(clubNetwork.isInsideClub('192.168.1.77')).toBe(true);
    expect(clubNetwork.isInsideClub('192.168.2.77')).toBe(false);
    expect(clubNetwork.isInsideClub('8.8.8.8')).toBe(false);
  });
});

describe('Cambiar el PIN', () => {
  async function sesionDe(role = 'waiter', pin = '481937') {
    const persona = await f.createUser(club.id, { role });
    await darPin(persona.id, pin);
    const res = await entrar(pin);
    return { persona, token: { Authorization: `Bearer ${res.body.access_token}` } };
  }

  it('pide el PIN actual cuando no es un cambio obligado', async () => {
    const { token } = await sesionDe();
    expect((await api().post('/api/auth/pin').set(token)
      .send({ new_pin: '205864' })).status).toBe(422);
    expect((await api().post('/api/auth/pin').set(token)
      .send({ current_pin: '111112', new_pin: '205864' })).status).toBe(401);
    expect((await api().post('/api/auth/pin').set(token)
      .send({ current_pin: '481937', new_pin: '205864' })).status).toBe(200);
  });

  it('no deja poner el mismo que ya tenía', async () => {
    const { token } = await sesionDe();
    expect((await api().post('/api/auth/pin').set(token)
      .send({ current_pin: '481937', new_pin: '481937' })).status).toBe(422);
  });

  it('débil y ocupado dan el MISMO mensaje', async () => {
    // Es la fuga propia de los PIN únicos: "ese ya está en uso" le revelaría a quien
    // pregunta el PIN de otra persona, de a uno por intento.
    const vecino = await f.createUser(club.id, { role: 'bartender' });
    await darPin(vecino.id, '205864');
    const { token } = await sesionDe();

    const ocupado = await api().post('/api/auth/pin').set(token)
      .send({ current_pin: '481937', new_pin: '205864' });
    const debil = await api().post('/api/auth/pin').set(token)
      .send({ current_pin: '481937', new_pin: '123456' });

    expect(ocupado.status).toBe(422);
    expect(debil.status).toBe(422);
    expect(ocupado.body.error.message).toBe(debil.body.error.message);
    expect(ocupado.body.error.message).not.toMatch(/uso|ocupad|exist|toma/i);
  });

  it('en el cambio obligado, dejarlo igual NO es cambiarlo', async () => {
    // El PIN de un solo uso lo conoce quien lo entregó. Si "cambiarlo" pudiera dejarlo
    // igual, el de un solo uso seguiría siendo de dos personas para siempre — y esa es
    // justo la única cosa que este paso existe para terminar.
    const persona = await f.createUser(club.id, { role: 'waiter' });
    await darPin(persona.id, '481937', { mustChange: true });
    const res = await entrar('481937');
    const token = { Authorization: `Bearer ${res.body.access_token}` };

    const igual = await api().post('/api/auth/pin').set(token).send({ new_pin: '481937' });
    expect(igual.status).toBe(422);

    // Y sigue obligado a cambiarlo: el intento fallido no lo dio por hecho.
    const yo = await api().get('/api/auth/me').set(token);
    expect(yo.body.user.must_change_pin).toBe(true);

    expect((await api().post('/api/auth/pin').set(token)
      .send({ new_pin: '205864' })).status).toBe(200);
  });

  it('cambiarlo cierra las demás sesiones', async () => {
    const { persona, token } = await sesionDe();
    const vieja = await entrar('481937');
    await api().post('/api/auth/pin').set({ Authorization: `Bearer ${vieja.body.access_token}` })
      .send({ current_pin: '481937', new_pin: '205864' });

    expect((await api().post('/api/auth/refresh')
      .send({ refresh_token: vieja.body.refresh_token })).status).toBe(401);
    expect(persona.id).toBeTruthy();
    expect(token).toBeTruthy();
  });
});

describe('Sin la llave del servidor', () => {
  it('la ruta lo dice en vez de fallar de forma rara', async () => {
    const antes = process.env.PIN_LOOKUP_KEY;
    delete process.env.PIN_LOOKUP_KEY;
    try {
      const res = await entrar('481937');
      expect(res.status).toBe(501);
      expect(res.body.error.message).toMatch(/PIN_LOOKUP_KEY/);
    } finally {
      process.env.PIN_LOOKUP_KEY = antes;
    }
  });

  it('y el alta de un empleado también', async () => {
    const antes = process.env.PIN_LOOKUP_KEY;
    delete process.env.PIN_LOOKUP_KEY;
    try {
      const res = await api().post(`/api/nightclubs/${club.id}/employees`)
        .set(auth(manager)).send({
          email: 'sin-llave@ev2.mx', first_name: 'A', last_name: 'B',
          role: 'waiter', birth_date: '1995-01-01',
        });
      expect(res.status).toBe(501);
    } finally {
      process.env.PIN_LOOKUP_KEY = antes;
    }
  });
});

describe('El error dice QUÉ le pasa a la llave', () => {
  // "Falta PIN_LOOKUP_KEY" mentía en el caso más común: la llave SÍ estaba en el .env,
  // pero medía 16 caracteres. El gerente la veía escrita y el sistema insistía.
  const pins = require('../src/services/pins');

  it('sin llave dice que no llegó al servidor, y cómo arreglarlo', () => {
    const m = pins.configProblem({});
    expect(m).toMatch(/no llegó al servidor/);
    expect(m).toMatch(/openssl rand -hex 32/);
    expect(m).toMatch(/restart.*NO relee/);
  });

  it('una llave corta dice cuánto mide', () => {
    expect(pins.configProblem({ PIN_LOOKUP_KEY: '7341521895331234' }))
      .toMatch(/mide 16 caracteres y necesita 32/);
  });

  it('un comentario pegado se reconoce como tal', () => {
    expect(pins.configProblem({ PIN_LOOKUP_KEY: 'abc   # la llave del pin' })).toMatch(/comentario/);
  });

  it('una llave buena no tiene problema', () => {
    expect(pins.configProblem({ PIN_LOOKUP_KEY: 'a'.repeat(64) })).toBeNull();
  });

  it('el alta de un empleado con llave corta lo dice con el largo', async () => {
    const antes = process.env.PIN_LOOKUP_KEY;
    process.env.PIN_LOOKUP_KEY = '7341521895331234';
    try {
      const res = await api().post(`/api/nightclubs/${club.id}/employees`)
        .set(auth(manager)).send({
          email: 'nuevo.mesero@ev2.mx', first_name: 'Nuevo', last_name: 'Mesero',
          role: 'waiter', birth_date: '1995-05-05',
        });
      expect(res.status).toBe(501);
      expect(res.body.error.message).toMatch(/mide 16 caracteres/);
    } finally {
      process.env.PIN_LOOKUP_KEY = antes;
    }
  });
});
