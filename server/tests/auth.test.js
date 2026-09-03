'use strict';

const { setupSchema, truncateAll, closePool, pool } = require('./helpers/db');
const { api, auth } = require('./helpers/api');
const f = require('./helpers/factories');

let club;

beforeAll(async () => {
  await setupSchema();
});
beforeEach(async () => {
  await truncateAll();
  club = await f.createNightclub({ slug: 'ev2-auth' });
});
afterAll(closePool);

const registerBody = (over = {}) => ({
  nightclub_slug: 'ev2-auth',
  email: 'nuevo@test.mx',
  password: 'Password123',
  first_name: 'Nuevo',
  last_name: 'Cliente',
  birth_date: '1995-06-15',
  accept_terms: true,
  ...over,
});

describe('POST /api/auth/register', () => {
  it('crea una cuenta de cliente y entrega tokens', async () => {
    const res = await api().post('/api/auth/register').send(registerBody());

    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({ email: 'nuevo@test.mx', role: 'guest' });
    expect(res.body.access_token).toEqual(expect.any(String));
    expect(res.body.refresh_token).toEqual(expect.any(String));
    // La contraseña nunca sale en la respuesta.
    expect(JSON.stringify(res.body)).not.toContain('Password123');
  });

  it('guarda la versión de términos aceptada', async () => {
    await api().post('/api/auth/register').send(registerBody());
    const { rows } = await pool.query('SELECT terms_version, terms_accepted_at FROM users');
    expect(rows[0].terms_version).toBeTruthy();
    expect(rows[0].terms_accepted_at).toBeInstanceOf(Date);
  });

  it('respeta el consentimiento de flirt (opt-in)', async () => {
    await api().post('/api/auth/register').send(registerBody({ accept_flirts: true }));
    const { rows } = await pool.query('SELECT accept_flirts FROM user_preferences');
    expect(rows[0].accept_flirts).toBe(true);
  });

  it('por defecto NO acepta flirts', async () => {
    await api().post('/api/auth/register').send(registerBody({ email: 'b@test.mx' }));
    const { rows } = await pool.query('SELECT accept_flirts FROM user_preferences');
    expect(rows[0].accept_flirts).toBe(false);
  });

  it('rechaza a menores de 18 años', async () => {
    const res = await api().post('/api/auth/register')
      .send(registerBody({ birth_date: '2012-01-01' }));
    expect(res.status).toBe(403);
    expect(res.body.error.message).toMatch(/18/);
  });

  it('rechaza a quien cumple 18 mañana', async () => {
    const tomorrow = new Date();
    tomorrow.setUTCFullYear(tomorrow.getUTCFullYear() - 18);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    const res = await api().post('/api/auth/register')
      .send(registerBody({ birth_date: tomorrow.toISOString().slice(0, 10) }));
    expect(res.status).toBe(403);
  });

  it('acepta a quien cumplió 18 ayer', async () => {
    const yesterday = new Date();
    yesterday.setUTCFullYear(yesterday.getUTCFullYear() - 18);
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    const res = await api().post('/api/auth/register')
      .send(registerBody({ birth_date: yesterday.toISOString().slice(0, 10) }));
    expect(res.status).toBe(201);
  });

  it('exige aceptar los términos', async () => {
    const res = await api().post('/api/auth/register').send(registerBody({ accept_terms: false }));
    expect(res.status).toBe(400);
  });

  it('rechaza contraseñas cortas', async () => {
    const res = await api().post('/api/auth/register').send(registerBody({ password: '123' }));
    expect(res.status).toBe(400);
    expect(res.body.error.details[0].field).toBe('body.password');
  });

  it('rechaza correos duplicados en el mismo club', async () => {
    await api().post('/api/auth/register').send(registerBody());
    const res = await api().post('/api/auth/register').send(registerBody());
    expect(res.status).toBe(409);
  });

  it('devuelve 404 si el club no existe', async () => {
    const res = await api().post('/api/auth/register')
      .send(registerBody({ nightclub_slug: 'no-existe' }));
    expect(res.status).toBe(404);
  });
});

describe('POST /api/auth/login', () => {
  it('inicia sesión con credenciales válidas', async () => {
    const user = await f.createUser(club.id, { email: 'ana@test.mx' });
    const res = await api().post('/api/auth/login')
      .send({ nightclub_slug: club.slug, email: 'ana@test.mx', password: f.PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(user.id);
    expect(res.body.access_token).toEqual(expect.any(String));
  });

  it('registra la fecha del último acceso', async () => {
    await f.createUser(club.id, { email: 'ana@test.mx' });
    await api().post('/api/auth/login')
      .send({ nightclub_slug: club.slug, email: 'ana@test.mx', password: f.PASSWORD });
    const { rows } = await pool.query('SELECT last_login_at FROM users WHERE email = $1', ['ana@test.mx']);
    expect(rows[0].last_login_at).toBeInstanceOf(Date);
  });

  it('rechaza contraseña incorrecta', async () => {
    await f.createUser(club.id, { email: 'ana@test.mx' });
    const res = await api().post('/api/auth/login')
      .send({ nightclub_slug: club.slug, email: 'ana@test.mx', password: 'incorrecta' });
    expect(res.status).toBe(401);
  });

  it('da el mismo error para un usuario inexistente (no revela si existe)', async () => {
    await f.createUser(club.id, { email: 'ana@test.mx' });
    const malPass = await api().post('/api/auth/login')
      .send({ nightclub_slug: club.slug, email: 'ana@test.mx', password: 'incorrecta' });
    const noExiste = await api().post('/api/auth/login')
      .send({ nightclub_slug: club.slug, email: 'nadie@test.mx', password: 'incorrecta' });

    expect(noExiste.status).toBe(malPass.status);
    expect(noExiste.body.error.message).toBe(malPass.body.error.message);
  });

  it('rechaza a una cuenta bloqueada', async () => {
    const user = await f.createUser(club.id, { email: 'ana@test.mx' });
    await pool.query(`UPDATE users SET status = 'blocked' WHERE id = $1`, [user.id]);
    const res = await api().post('/api/auth/login')
      .send({ nightclub_slug: club.slug, email: 'ana@test.mx', password: f.PASSWORD });
    expect(res.status).toBe(403);
  });
});

describe('Refresh tokens', () => {
  async function login() {
    await f.createUser(club.id, { email: 'ana@test.mx' });
    const res = await api().post('/api/auth/login')
      .send({ nightclub_slug: club.slug, email: 'ana@test.mx', password: f.PASSWORD });
    return res.body;
  }

  it('renueva el acceso y rota el refresh token', async () => {
    const { refresh_token: original } = await login();
    const res = await api().post('/api/auth/refresh').send({ refresh_token: original });

    expect(res.status).toBe(200);
    expect(res.body.access_token).toEqual(expect.any(String));
    expect(res.body.refresh_token).not.toBe(original);
  });

  it('invalida el refresh token usado (un solo uso)', async () => {
    const { refresh_token: original } = await login();
    await api().post('/api/auth/refresh').send({ refresh_token: original });
    const reuse = await api().post('/api/auth/refresh').send({ refresh_token: original });
    expect(reuse.status).toBe(401);
  });

  it('rechaza un refresh token inventado', async () => {
    const res = await api().post('/api/auth/refresh').send({ refresh_token: 'x'.repeat(60) });
    expect(res.status).toBe(401);
  });

  it('rechaza un refresh token expirado', async () => {
    const { refresh_token: token } = await login();
    await pool.query(`UPDATE refresh_tokens SET expires_at = now() - interval '1 day'`);
    const res = await api().post('/api/auth/refresh').send({ refresh_token: token });
    expect(res.status).toBe(401);
  });

  it('logout revoca todas las sesiones', async () => {
    const session = await login();
    const second = await api().post('/api/auth/login')
      .send({ nightclub_slug: club.slug, email: 'ana@test.mx', password: f.PASSWORD });

    const out = await api().post('/api/auth/logout')
      .set('Authorization', `Bearer ${session.access_token}`);
    expect(out.status).toBe(204);

    for (const token of [session.refresh_token, second.body.refresh_token]) {
      const res = await api().post('/api/auth/refresh').send({ refresh_token: token });
      expect(res.status).toBe(401);
    }
  });
});

describe('Autenticación de peticiones', () => {
  it('rechaza sin cabecera Authorization', async () => {
    const res = await api().get('/api/auth/me');
    expect(res.status).toBe(401);
  });

  it('rechaza un token corrupto', async () => {
    const res = await api().get('/api/auth/me').set('Authorization', 'Bearer no-es-un-jwt');
    expect(res.status).toBe(401);
  });

  it('rechaza un token firmado con otro secreto', async () => {
    const jwt = require('jsonwebtoken');
    const user = await f.createUser(club.id);
    const fake = jwt.sign({ sub: user.id, role: 'admin' }, 'otro-secreto-cualquiera', { issuer: 'ev2' });
    const res = await api().get('/api/auth/me').set('Authorization', `Bearer ${fake}`);
    expect(res.status).toBe(401);
  });

  it('bloquea inmediatamente a un usuario suspendido, sin esperar a que expire su token', async () => {
    const user = await f.createUser(club.id);
    const headers = auth(user);
    expect((await api().get('/api/auth/me').set(headers)).status).toBe(200);

    await pool.query(`UPDATE users SET status = 'blocked' WHERE id = $1`, [user.id]);
    expect((await api().get('/api/auth/me').set(headers)).status).toBe(403);
  });

  it('devuelve el usuario y sus preferencias', async () => {
    const user = await f.createUser(club.id, { accept_flirts: true });
    const res = await api().get('/api/auth/me').set(auth(user));
    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(user.id);
    expect(res.body.preferences.accept_flirts).toBe(true);
  });
});

describe('Rutas desconocidas', () => {
  it('responde 404 con la forma de error estándar', async () => {
    const res = await api().get('/api/no-existe');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_found');
  });
});
