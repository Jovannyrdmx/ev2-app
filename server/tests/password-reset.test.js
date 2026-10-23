/**
 * "Olvidé mi contraseña" por correo (D127).
 *
 * Lo que se prueba, en orden de lo que más cuesta si falla:
 *   1. La ruta NO delata qué correos existen: misma respuesta con cuenta y sin ella.
 *   2. El enlace del correo cambia la contraseña, se gasta, y tumba las sesiones viejas.
 *   3. Los frenos: un correo por minuto por cuenta, solo sirve el último enlace, y un
 *      enlace caducado o inventado no abre nada.
 *   4. Sin SMTP configurado se dice (501), no se finge.
 *
 * El correo se captura con un transporte falso: nada sale a la red.
 */
'use strict';

const { setupSchema, truncateAll, closePool, pool } = require('./helpers/db');
const { api } = require('./helpers/api');
const f = require('./helpers/factories');
const mailer = require('../src/services/mailer');
const reset = require('../src/services/password-reset');
const mailConfig = require('../src/config/mail');

const SLUG = 'ev2-reset';
let club; let guest;
let enviados = [];

const buzon = {
  async sendMail(msg) { enviados.push(msg); return { messageId: `test-${enviados.length}` }; },
};

beforeAll(setupSchema);
afterAll(async () => { mailer.useTransport(null); await closePool(); });

beforeEach(async () => {
  await truncateAll();
  enviados = [];
  mailer.useTransport(buzon);
  process.env.PUBLIC_WEB_URL = 'https://club.test';
  club = await f.createNightclub({ slug: SLUG, name: 'Clandestinoz' });
  guest = await f.createUser(club.id, { role: 'guest', email: 'invitado@test.mx' });
});

const pedir = (email, slug = SLUG) => api().post('/api/auth/password/forgot')
  .send({ nightclub_slug: slug, email });

/** El token tal cual viaja en el enlace del último correo. */
function tokenDelCorreo(msg = enviados[enviados.length - 1]) {
  const m = /restablecer\.html#token=([^\s"<]+)/.exec(msg.text);
  expect(m).not.toBeNull();
  return decodeURIComponent(m[1]);
}

const entrar = (email, password) => api().post('/api/auth/login')
  .send({ nightclub_slug: SLUG, email, password });

describe('Pedir el enlace', () => {
  it('manda el correo con el enlace a restablecer.html y contesta 202', async () => {
    const res = await pedir('invitado@test.mx');
    expect(res.status).toBe(202);
    expect(res.body.accepted).toBe(true);
    expect(enviados).toHaveLength(1);
    expect(enviados[0].to).toBe('invitado@test.mx');
    expect(enviados[0].subject).toMatch(/Clandestinoz/);
    expect(enviados[0].text).toContain('https://club.test/restablecer.html#token=');
    expect(enviados[0].html).toContain('https://club.test/restablecer.html#token=');
    // El token NO se guarda: solo su huella.
    const token = tokenDelCorreo();
    const { rows } = await pool.query('SELECT token_hash FROM password_resets');
    expect(rows).toHaveLength(1);
    expect(rows[0].token_hash).not.toBe(token);
    expect(rows[0].token_hash).toBe(reset.hashToken(token));
  });

  it('contesta EXACTAMENTE igual cuando el correo no tiene cuenta, y no manda nada', async () => {
    const con = await pedir('invitado@test.mx');
    const sin = await pedir('nadie@test.mx');
    expect(sin.status).toBe(202);
    expect(sin.body).toEqual(con.body);
    expect(enviados).toHaveLength(1);
  });

  it('el correo no distingue mayúsculas ni espacios', async () => {
    const res = await pedir('  Invitado@Test.MX ');
    expect(res.status).toBe(202);
    expect(enviados).toHaveLength(1);
  });

  it('a una cuenta de otro club no le llega nada aunque el correo coincida', async () => {
    await f.createNightclub({ slug: 'otro-club' });
    const res = await pedir('invitado@test.mx', 'otro-club');
    expect(res.status).toBe(202);
    expect(enviados).toHaveLength(0);
  });

  it('a una cuenta bloqueada no le llega nada (y la respuesta es la misma)', async () => {
    await pool.query("UPDATE users SET status = 'blocked' WHERE id = $1", [guest.id]);
    const res = await pedir('invitado@test.mx');
    expect(res.status).toBe(202);
    expect(enviados).toHaveLength(0);
  });

  it('le sirve a cualquier cuenta con correo: gerente, personal, y quien solo entraba con Facebook', async () => {
    await f.createUser(club.id, { role: 'manager', email: 'gerente@test.mx' });
    const fb = await f.createUser(club.id, { role: 'guest', email: 'face@test.mx' });
    await pool.query('UPDATE users SET password_hash = NULL WHERE id = $1', [fb.id]);
    await pedir('gerente@test.mx');
    await pedir('face@test.mx');
    expect(enviados.map((m) => m.to)).toEqual(['gerente@test.mx', 'face@test.mx']);
  });

  it('un correo por minuto por cuenta: pedir cinco veces manda uno', async () => {
    for (let i = 0; i < 5; i += 1) {
      const res = await pedir('invitado@test.mx');
      expect(res.status).toBe(202);
    }
    expect(enviados).toHaveLength(1);
  });

  it('escribe el correo en inglés si la cuenta está en inglés', async () => {
    await pool.query("UPDATE users SET locale = 'en-US' WHERE id = $1", [guest.id]);
    await pedir('invitado@test.mx');
    expect(enviados[0].subject).toMatch(/^Reset your/);
    expect(enviados[0].text).toContain("If you didn't ask for this");
  });

  it('rechaza un cuerpo sin correo o con un correo que no lo es', async () => {
    expect((await pedir('')).status).toBe(400);
    expect((await pedir('esto-no-es-correo')).status).toBe(400);
    const sinClub = await api().post('/api/auth/password/forgot').send({ email: 'a@b.mx' });
    expect(sinClub.status).toBe(400);
  });

  it('si el proveedor de correo falla, lo registra pero sigue sin delatar la cuenta', async () => {
    mailer.useTransport({ async sendMail() { throw new Error('SMTP 535 auth failed'); } });
    const errores = [];
    const resultado = await reset._request(pool, {
      nightclubSlug: SLUG, email: 'invitado@test.mx', baseUrl: 'https://club.test',
      logger: { error: (m) => errores.push(m) },
    });
    expect(resultado).toEqual({ sent: false, reason: 'mail_failed' });
    expect(errores[0]).toMatch(/SMTP 535/);
    const res = await pedir('invitado@test.mx');
    expect(res.status).toBe(202);
  });
});

describe('Sin correo configurado', () => {
  it('la ruta contesta 501 diciendo qué variables faltan, antes de mirar la cuenta', async () => {
    mailer.useTransport(null);
    const guardado = {};
    for (const k of ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASSWORD', 'MAIL_FROM']) {
      guardado[k] = process.env[k];
      delete process.env[k];
    }
    try {
      const res = await pedir('invitado@test.mx');
      expect(res.status).toBe(501);
      expect(res.body.error.message).toMatch(/SMTP_HOST/);
      expect(res.body.error.message).toMatch(/MAIL_FROM/);
      expect(enviados).toHaveLength(0);
      // Y el 501 sale igual para un correo que no existe: no es una pista.
      const sin = await pedir('nadie@test.mx');
      expect(sin.status).toBe(501);
      expect(sin.body.error.message).toBe(res.body.error.message);
    } finally {
      for (const [k, v] of Object.entries(guardado)) if (v !== undefined) process.env[k] = v;
    }
  });

  it('config/mail deduce TLS directo del puerto 465 y lo deja forzar', () => {
    const base = { SMTP_HOST: 'smtp.x', SMTP_USER: 'u', SMTP_PASSWORD: 'p', MAIL_FROM: 'a@x' };
    expect(mailConfig.smtpConfig({ ...base }).port).toBe(587);
    expect(mailConfig.smtpConfig({ ...base }).secure).toBe(false);
    expect(mailConfig.smtpConfig({ ...base, SMTP_PORT: '465' }).secure).toBe(true);
    expect(mailConfig.smtpConfig({ ...base, SMTP_PORT: '2525', SMTP_SECURE: 'true' }).secure).toBe(true);
    expect(mailConfig.missing({ ...base })).toEqual([]);
    expect(mailConfig.missing({ SMTP_HOST: 'smtp.x' })).toEqual(['SMTP_USER', 'SMTP_PASSWORD', 'MAIL_FROM']);
  });
});

describe('Revisar el enlace antes de enseñar el formulario', () => {
  const revisar = (token) => api().post('/api/auth/password/reset/check').send({ token });

  it('un enlace vigente dice que sirve y para qué correo (enmascarado)', async () => {
    await pedir('invitado@test.mx');
    const res = await revisar(tokenDelCorreo());
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(true);
    expect(res.body.email_masked).toBe('i***o@test.mx');
    expect(res.body.email_masked).not.toContain('invitado');
  });

  it('un enlace inventado no sirve, y no dice nada más', async () => {
    const res = await revisar('x'.repeat(43));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ valid: false });
  });

  it('un enlace caducado no sirve', async () => {
    await pedir('invitado@test.mx');
    await pool.query("UPDATE password_resets SET expires_at = now() - interval '1 minute'");
    expect((await revisar(tokenDelCorreo())).body.valid).toBe(false);
  });

  it('solo sirve el ÚLTIMO enlace: pedir otro anula el anterior', async () => {
    await pedir('invitado@test.mx');
    const primero = tokenDelCorreo();
    // Fuera del freno de un minuto.
    await pool.query("UPDATE password_resets SET created_at = now() - interval '2 minutes'");
    await pedir('invitado@test.mx');
    expect(enviados).toHaveLength(2);
    const segundo = tokenDelCorreo();
    expect(segundo).not.toBe(primero);
    expect((await revisar(primero)).body.valid).toBe(false);
    expect((await revisar(segundo)).body.valid).toBe(true);
  });
});

describe('Cambiar la contraseña con el enlace', () => {
  const cambiar = (token, newPassword) => api().post('/api/auth/password/reset')
    .send({ token, new_password: newPassword });

  it('cambia la contraseña: la nueva entra, la vieja ya no', async () => {
    await pedir('invitado@test.mx');
    const res = await cambiar(tokenDelCorreo(), 'NuevaClave2026');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ reset: true });
    // Sin sesión de regalo en la respuesta.
    expect(res.body.access_token).toBeUndefined();
    expect((await entrar('invitado@test.mx', 'NuevaClave2026')).status).toBe(200);
    expect((await entrar('invitado@test.mx', f.PASSWORD)).status).toBe(401);
  });

  it('el enlace se gasta: usarlo dos veces no cambia nada la segunda', async () => {
    await pedir('invitado@test.mx');
    const token = tokenDelCorreo();
    expect((await cambiar(token, 'NuevaClave2026')).status).toBe(200);
    const otra = await cambiar(token, 'OtraClave2026');
    expect(otra.status).toBe(401);
    expect(otra.body.error.message).toMatch(/ya no sirve/);
    expect((await entrar('invitado@test.mx', 'NuevaClave2026')).status).toBe(200);
    expect((await entrar('invitado@test.mx', 'OtraClave2026')).status).toBe(401);
  });

  it('cierra todas las sesiones que había: el refresh viejo deja de servir', async () => {
    const sesion = await entrar('invitado@test.mx', f.PASSWORD);
    expect(sesion.status).toBe(200);
    const refreshViejo = sesion.body.refresh_token;
    await pedir('invitado@test.mx');
    await cambiar(tokenDelCorreo(), 'NuevaClave2026');
    const r = await api().post('/api/auth/refresh').send({ refresh_token: refreshViejo });
    expect(r.status).toBe(401);
  });

  it('quita el "cambio obligatorio" de una contraseña temporal del gerente', async () => {
    await pool.query('UPDATE users SET must_change_password = true WHERE id = $1', [guest.id]);
    await pedir('invitado@test.mx');
    await cambiar(tokenDelCorreo(), 'NuevaClave2026');
    const { rows } = await pool.query('SELECT must_change_password FROM users WHERE id = $1', [guest.id]);
    expect(rows[0].must_change_password).toBe(false);
  });

  it('le pone contraseña a quien solo entraba con Facebook', async () => {
    await pool.query('UPDATE users SET password_hash = NULL WHERE id = $1', [guest.id]);
    expect((await entrar('invitado@test.mx', 'NuevaClave2026')).status).toBe(401);
    await pedir('invitado@test.mx');
    await cambiar(tokenDelCorreo(), 'NuevaClave2026');
    expect((await entrar('invitado@test.mx', 'NuevaClave2026')).status).toBe(200);
  });

  it('deja rastro en la bitácora', async () => {
    await pedir('invitado@test.mx');
    await cambiar(tokenDelCorreo(), 'NuevaClave2026');
    const { rows } = await pool.query(
      "SELECT actor_id, entity_id FROM audit_log WHERE action = 'password_reset_by_email'");
    expect(rows).toHaveLength(1);
    expect(rows[0].actor_id).toBe(guest.id);
    expect(rows[0].entity_id).toBe(guest.id);
  });

  it('rechaza contraseñas cortas y enlaces caducados o inventados', async () => {
    await pedir('invitado@test.mx');
    const token = tokenDelCorreo();
    expect((await cambiar(token, 'corta')).status).toBe(400);
    expect((await cambiar('y'.repeat(43), 'NuevaClave2026')).status).toBe(401);
    await pool.query("UPDATE password_resets SET expires_at = now() - interval '1 minute'");
    expect((await cambiar(token, 'NuevaClave2026')).status).toBe(401);
    // Nada de eso tocó la cuenta.
    expect((await entrar('invitado@test.mx', f.PASSWORD)).status).toBe(200);
  });

  it('no sirve si la cuenta se bloqueó después de pedir el enlace', async () => {
    await pedir('invitado@test.mx');
    await pool.query("UPDATE users SET status = 'blocked' WHERE id = $1", [guest.id]);
    expect((await cambiar(tokenDelCorreo(), 'NuevaClave2026')).status).toBe(401);
  });
});

describe('Las piezas sueltas', () => {
  it('el enlace va en el fragmento (#), no en la ruta ni en la query', () => {
    const url = reset.resetUrl('https://club.test/', 'abc+def');
    expect(url).toBe('https://club.test/restablecer.html#token=abc%2Bdef');
  });

  it('enmascarar el correo deja la primera y la última letra', () => {
    expect(reset.maskEmail('erick.lopez@gmail.com')).toBe('e***z@gmail.com');
    expect(reset.maskEmail('ab@x.mx')).toBe('a***@x.mx');
    expect(reset.maskEmail('')).toBe('***');
  });

  it('el correo trae el enlace en texto y en HTML, con el HTML escapado', () => {
    const m = reset.buildEmail({
      clubName: 'Club <Rojo>', firstName: 'Ana', url: 'https://x/restablecer.html#token=t', locale: 'es-MX',
    });
    expect(m.text).toContain('Hola Ana');
    expect(m.text).toContain('30 minutos');
    expect(m.html).toContain('Club &lt;Rojo&gt;');
    expect(m.html).not.toContain('<Rojo>');
  });
});
