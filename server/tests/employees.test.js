'use strict';

// Empleados (D19): alta por el gerente con contraseña temporal, perfil, cuentas
// bancarias cifradas y verificadas por el gerente.

const { setupSchema, truncateAll, closePool, pool } = require('./helpers/db');
const { api, auth } = require('./helpers/api');
const f = require('./helpers/factories');
const banking = require('../src/services/banking');

process.env.BANK_ENCRYPTION_KEY = process.env.BANK_ENCRYPTION_KEY || 'test-bank-key-0123456789-0123456789-abc';

let club; let manager; let guest; let waiter; let dancer;

beforeAll(setupSchema);
afterAll(closePool);

beforeEach(async () => {
  await truncateAll();
  club = await f.createNightclub({ slug: 'ev2-emp' });
  manager = await f.createUser(club.id, { role: 'manager' });
  guest = await f.createUser(club.id, { role: 'guest' });
  waiter = await f.createUser(club.id, { role: 'waiter', display_name: 'Luis' });
  dancer = await f.createUser(club.id, { role: 'dancer', display_name: 'Nina' });
  await pool.query(
    `INSERT INTO employee_profiles (user_id, country) VALUES ($1,'MX'), ($2,'US')`, [waiter.id, dancer.id]);
});

const url = (p) => `/api/nightclubs/${club.id}${p}`;

/** Builds a CLABE with a correct check digit from 17 digits. */
function clabeFrom(first17) {
  const w = [3, 7, 1];
  let sum = 0;
  for (let i = 0; i < 17; i += 1) sum += (Number(first17[i]) * w[i % 3]) % 10;
  return first17 + String((10 - (sum % 10)) % 10);
}
const CLABE_OK = clabeFrom('01218000118359159'); // 012 = BBVA
const ABA_OK = '021000021';

const newEmployee = (over = {}) => api().post(url('/employees')).set(auth(manager)).send({
  email: `nuevo-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@ev2.mx`,
  first_name: 'Pedro', last_name: 'Ruiz', role: 'bartender', birth_date: '1996-05-04', ...over,
});

const login = (mail, pass) => api().post('/api/auth/login').send({ nightclub_slug: 'ev2-emp', email: mail, password: pass });

describe('Validación bancaria', () => {
  it('acepta una CLABE con dígito verificador correcto y rechaza la alterada', () => {
    expect(banking.isValidClabe(CLABE_OK)).toBe(true);
    const bad = CLABE_OK.slice(0, 17) + String((Number(CLABE_OK[17]) + 1) % 10);
    expect(banking.isValidClabe(bad)).toBe(false);
    expect(banking.isValidClabe('1234')).toBe(false);
    expect(banking.isValidClabe('01218000118359159X')).toBe(false);
  });

  it('valida el routing ABA con su checksum', () => {
    expect(banking.isValidAbaRouting(ABA_OK)).toBe(true);
    expect(banking.isValidAbaRouting('021000022')).toBe(false);
    expect(banking.isValidAbaRouting('12345')).toBe(false);
  });
});

describe('Alta de empleados', () => {
  it('el gerente da de alta y recibe el PIN una sola vez', async () => {
    const res = await newEmployee({ stage_name: 'Pete', country: 'MX' });
    expect(res.status).toBe(201);
    expect(res.body.employee).toMatchObject({
      role: 'bartender', country: 'MX', stage_name: 'Pete', display_name: 'Pete',
      active: true, preferred_currency: 'MXN', has_pin: true, must_change_pin: true,
    });
    expect(res.body.pin).toMatch(/^\d{6}$/);
    // Nada lo guarda en claro: ni el cifrado ni la huella con la que se busca.
    const { rows } = await pool.query(
      'SELECT pin_hash, pin_lookup FROM users WHERE id = $1', [res.body.employee.id]);
    expect(rows[0].pin_hash).not.toContain(res.body.pin);
    expect(rows[0].pin_lookup).not.toContain(res.body.pin);
  });

  it('un empleado de EE. UU. nace con moneda USD', async () => {
    const res = await newEmployee({ country: 'US' });
    expect(res.body.employee).toMatchObject({ country: 'US', preferred_currency: 'USD', preferred_payout_currency: 'USD' });
  });

  it('solo el gerente; un mesero o un cliente no', async () => {
    for (const u of [guest, waiter]) {
      const res = await api().post(url('/employees')).set(auth(u)).send({
        email: 'x@ev2.mx', first_name: 'A', last_name: 'B', role: 'waiter', birth_date: '1990-01-01',
      });
      expect(res.status).toBe(403);
    }
  });

  it('no permite roles que no son de empleado ni correos repetidos', async () => {
    expect((await newEmployee({ role: 'guest' })).status).toBe(400);
    expect((await newEmployee({ role: 'admin' })).status).toBe(400);
    const first = await newEmployee({ email: 'dup@ev2.mx' });
    expect(first.status).toBe(201);
    expect((await newEmployee({ email: 'dup@ev2.mx' })).status).toBe(409);
  });

  it('el listado filtra por rol y esconde a los dados de baja', async () => {
    const res = await api().get(url('/employees?role=waiter')).set(auth(manager));
    expect(res.status).toBe(200);
    expect(res.body.employees.map((e) => e.display_name)).toEqual(['Luis']);

    await api().patch(url(`/employees/${waiter.id}`)).set(auth(manager)).send({ active: false });
    const after = await api().get(url('/employees?role=waiter')).set(auth(manager));
    expect(after.body.employees).toHaveLength(0);
    const all = await api().get(url('/employees?role=waiter&include_inactive=true')).set(auth(manager));
    expect(all.body.employees[0]).toMatchObject({ active: false, status: 'blocked' });
  });
});

// Un gerente que puede nombrar gerentes puede nombrarse un cómplice, y desde ahí el
// permiso de gerente —caja, precios, retiros, nómina— ya no protege nada. Estas
// pruebas cuidan justo esa puerta, en las cuatro formas de abrirla.
describe('Alta y manejo de gerentes', () => {
  let admin;

  beforeEach(async () => {
    admin = await f.createUser(club.id, { role: 'admin', display_name: 'Dueño' });
  });

  const nuevoGerente = (who, over = {}) => api().post(url('/employees')).set(auth(who)).send({
    email: `ger-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@ev2.mx`,
    first_name: 'Ana', last_name: 'Solís', role: 'manager', birth_date: '1990-02-11', ...over,
  });

  it('un gerente no puede crear otro gerente; el administrador sí', async () => {
    expect((await nuevoGerente(manager)).status).toBe(403);

    const res = await nuevoGerente(admin);
    expect(res.status).toBe(201);
    expect(res.body.employee).toMatchObject({ role: 'manager', active: true, must_change_password: true });
    expect(res.body.temporary_password).toMatch(/^[A-Za-z0-9]{12}$/);

    // El alta queda en audit_log con quién la hizo: seis meses después hay que poder
    // decir quién nombró a esta persona.
    const { rows } = await pool.query(
      `SELECT actor_id, after FROM audit_log WHERE action = 'manager_created' AND entity_id = $1`,
      [res.body.employee.id]);
    expect(rows).toHaveLength(1);
    expect(rows[0].actor_id).toBe(admin.id);
  });

  it('el gerente nuevo aparece en el personal y puede entrar a lo suyo', async () => {
    const res = await nuevoGerente(admin);
    const lista = await api().get(url('/employees?role=manager')).set(auth(admin));
    expect(lista.status).toBe(200);
    expect(lista.body.employees.map((e) => e.id)).toContain(res.body.employee.id);
  });

  it('nadie crea administradores por HTTP, ni el administrador', async () => {
    expect((await nuevoGerente(admin, { role: 'admin' })).status).toBe(400);
  });

  it('un gerente no toca a otro gerente: ni rol, ni baja, ni contraseña', async () => {
    const otro = (await nuevoGerente(admin)).body.employee;
    for (const body of [{ role: 'waiter' }, { active: false }, { reset_password: true }]) {
      const res = await api().patch(url(`/employees/${otro.id}`)).set(auth(manager)).send(body);
      expect(res.status).toBe(403);
    }
    // Lo que no es la cuenta sí lo puede corregir cualquier gerente.
    const ok = await api().patch(url(`/employees/${otro.id}`)).set(auth(manager)).send({ phone: '6621234567' });
    expect(ok.status).toBe(200);
  });

  it('el administrador sí puede quitar y poner la gerencia, y queda registrado', async () => {
    const otro = (await nuevoGerente(admin)).body.employee;
    const baja = await api().patch(url(`/employees/${otro.id}`)).set(auth(admin)).send({ role: 'waiter' });
    expect(baja.status).toBe(200);
    expect(baja.body.employee.role).toBe('waiter');

    const alta = await api().patch(url(`/employees/${otro.id}`)).set(auth(admin)).send({ role: 'manager' });
    expect(alta.body.employee.role).toBe('manager');

    const { rows } = await pool.query(
      `SELECT before, after FROM audit_log
        WHERE action = 'manager_role_changed' AND entity_id = $1 ORDER BY id`, [otro.id]);
    expect(rows.map((r) => [r.before.role, r.after.role]))
      .toEqual([['manager', 'waiter'], ['waiter', 'manager']]);
  });

  it('un gerente no se asciende a sí mismo por el parche', async () => {
    const res = await api().patch(url(`/employees/${waiter.id}`)).set(auth(manager)).send({ role: 'manager' });
    expect(res.status).toBe(403);
    const { rows } = await pool.query('SELECT role FROM users WHERE id = $1', [waiter.id]);
    expect(rows[0].role).toBe('waiter');
  });
});

/**
 * El PIN de un solo uso del alta (D46).
 *
 * Lo que cambió: el piso ya NO recibe contraseña temporal. Su cuenta nace sin
 * contraseña —literalmente, `password_hash` en NULL— y con un PIN de seis dígitos que
 * sirve para entrar una vez y obliga a cambiarlo. Es la decisión del dueño, y estas
 * pruebas cuidan las dos mitades: que el PIN funcione, y que la puerta de la
 * contraseña quede CERRADA de verdad para esa persona.
 */
describe('El PIN de un solo uso', () => {
  const pinLogin = (pin) => api().post('/api/auth/pin-login')
    .send({ nightclub_slug: 'ev2-emp', pin });

  it('el alta entrega un PIN, y NO una contraseña, para el piso', async () => {
    const created = await newEmployee({ email: 'pin1@ev2.mx' });
    expect(created.status).toBe(201);
    expect(created.body.pin).toMatch(/^\d{6}$/);
    expect(created.body.temporary_password).toBeUndefined();

    // Sin contraseña en la base: `/auth/login` no es una puerta para esta persona,
    // ni con la contraseña correcta, porque no hay ninguna correcta.
    const { rows } = await pool.query('SELECT password_hash FROM users WHERE id = $1',
      [created.body.employee.id]);
    expect(rows[0].password_hash).toBeNull();
    expect((await login('pin1@ev2.mx', 'loquesea')).status).toBe(401);
  });

  it('con el PIN del alta solo se puede entrar a cambiarlo', async () => {
    const created = await newEmployee({ email: 'pin2@ev2.mx' });
    const session = await pinLogin(created.body.pin);
    expect(session.status).toBe(200);
    expect(session.body.user.must_change_pin).toBe(true);
    const token = { Authorization: `Bearer ${session.body.access_token}` };

    const blocked = await api().get('/api/employees/me').set(token);
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('pin_change_required');

    // El PIN actual NO se pide aquí: acaba de teclearlo para entrar.
    const change = await api().post('/api/auth/pin').set(token).send({ new_pin: '481937' });
    expect(change.status).toBe(200);

    const me = await api().get('/api/employees/me')
      .set({ Authorization: `Bearer ${change.body.access_token}` });
    expect(me.status).toBe(200);
    // Y el PIN viejo ya no sirve; el nuevo sí.
    expect((await pinLogin(created.body.pin)).status).toBe(401);
    expect((await pinLogin('481937')).status).toBe(200);
  });

  it('rechaza los PIN obvios y la fecha de nacimiento, con UN solo mensaje', async () => {
    const created = await newEmployee({ email: 'pin3@ev2.mx', birth_date: '1996-05-04' });
    const session = await pinLogin(created.body.pin);
    const token = { Authorization: `Bearer ${session.body.access_token}` };

    for (const malo of ['123456', '000000', '121212', '040596']) {
      // eslint-disable-next-line no-await-in-loop
      const res = await api().post('/api/auth/pin').set(token).send({ new_pin: malo });
      expect({ malo, status: res.status }).toEqual({ malo, status: 422 });
    }
  });

  it('un PIN ocupado se rechaza SIN decir que está ocupado', async () => {
    // Es la fuga propia de los PIN únicos: si el mensaje dijera "ese ya está en uso",
    // le acabaría de revelar a quien pregunta el PIN de otra persona. Débil y ocupado
    // comparten el mismo mensaje exactamente por eso.
    const uno = await newEmployee({ email: 'pin4@ev2.mx' });
    const otro = await newEmployee({ email: 'pin5@ev2.mx' });

    const sesion = await pinLogin(otro.body.pin);
    const token = { Authorization: `Bearer ${sesion.body.access_token}` };
    const ocupado = await api().post('/api/auth/pin').set(token).send({ new_pin: uno.body.pin });
    const debil = await api().post('/api/auth/pin').set(token).send({ new_pin: '123456' });

    expect(ocupado.status).toBe(422);
    expect(ocupado.body.error.message).toBe(debil.body.error.message);
    expect(ocupado.body.error.message).not.toMatch(/uso|ocupad|exist/i);
  });

  it('el gerente puede regenerarlo, y eso cierra las sesiones', async () => {
    const created = await newEmployee({ email: 'pin6@ev2.mx' });
    const primera = await pinLogin(created.body.pin);
    expect(primera.status).toBe(200);

    const reset = await api().patch(url(`/employees/${created.body.employee.id}`))
      .set(auth(manager)).send({ reset_pin: true });
    expect(reset.status).toBe(200);
    expect(reset.body.pin).toMatch(/^\d{6}$/);
    expect(reset.body.pin).not.toBe(created.body.pin);

    expect((await pinLogin(created.body.pin)).status).toBe(401);
    expect((await api().post('/api/auth/refresh')
      .send({ refresh_token: primera.body.refresh_token })).status).toBe(401);
    expect((await pinLogin(reset.body.pin)).status).toBe(200);
  });

  it('una sola sesión abierta: entrar cierra la anterior', async () => {
    // Lo pidió el dueño, y de paso es la única alarma que tiene el club: si alguien le
    // atina a un PIN, al empleado real se le cierra la sesión y lo NOTA.
    const created = await newEmployee({ email: 'pin7@ev2.mx' });
    const primera = await pinLogin(created.body.pin);
    const segunda = await pinLogin(created.body.pin);
    expect(segunda.status).toBe(200);

    expect((await api().post('/api/auth/refresh')
      .send({ refresh_token: primera.body.refresh_token })).status).toBe(401);
    expect((await api().post('/api/auth/refresh')
      .send({ refresh_token: segunda.body.refresh_token })).status).toBe(200);
  });

  it('un empleado dado de baja no entra con su PIN', async () => {
    const created = await newEmployee({ email: 'pin8@ev2.mx' });
    await api().patch(url(`/employees/${created.body.employee.id}`)).set(auth(manager))
      .send({ active: false });
    // 401 y no 403: el mensaje es el mismo que el de un PIN que no es de nadie. Una
    // respuesta distinta le diría a quien prueba que ese PIN SÍ existe.
    const res = await pinLogin(created.body.pin);
    expect(res.status).toBe(401);

    await api().patch(url(`/employees/${created.body.employee.id}`)).set(auth(manager))
      .send({ active: true });
    expect((await pinLogin(created.body.pin)).status).toBe(200);
  });

  it('un PIN que no es de nadie y uno de otro club suenan igual', async () => {
    const otro = await f.createNightclub({ slug: 'ev2-emp-2' });
    const ajeno = await f.createUser(otro.id, { role: 'manager' });
    const suyo = await api().post(`/api/nightclubs/${otro.id}/employees`).set(auth(ajeno)).send({
      email: 'ajeno@ev2.mx', first_name: 'Ana', last_name: 'Paz',
      role: 'waiter', birth_date: '1995-03-03',
    });
    const inventado = await pinLogin('481937');
    const deOtroClub = await pinLogin(suyo.body.pin);
    expect(inventado.status).toBe(401);
    expect(deOtroClub.status).toBe(401);
    expect(deOtroClub.body.error.message).toBe(inventado.body.error.message);
  });
});

describe('La contraseña de la gerencia', () => {
  it('un gerente nuevo recibe contraseña temporal Y PIN', async () => {
    // Necesita las dos: el PIN para el club, la contraseña para entrar desde fuera.
    const admin = await f.createUser(club.id, { role: 'admin' });
    const res = await api().post(url('/employees')).set(auth(admin)).send({
      email: 'ger@ev2.mx', first_name: 'Ana', last_name: 'Solís',
      role: 'manager', birth_date: '1990-02-11',
    });
    expect(res.status).toBe(201);
    expect(res.body.pin).toMatch(/^\d{6}$/);
    expect(res.body.temporary_password).toMatch(/^[A-Za-z0-9]{12}$/);
    expect((await login('ger@ev2.mx', res.body.temporary_password)).status).toBe(200);
  });

  it('con la temporal solo se puede entrar a cambiarla', async () => {
    const admin = await f.createUser(club.id, { role: 'admin' });
    const created = await api().post(url('/employees')).set(auth(admin)).send({
      email: 'ger2@ev2.mx', first_name: 'Ana', last_name: 'Solís',
      role: 'manager', birth_date: '1990-02-11',
    });
    const session = await login('ger2@ev2.mx', created.body.temporary_password);
    expect(session.body.user.must_change_password).toBe(true);
    const token = { Authorization: `Bearer ${session.body.access_token}` };

    const blocked = await api().get('/api/auth/oauth/linked').set(token);
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('password_change_required');

    expect((await api().post('/api/auth/password').set(token)
      .send({ current_password: 'incorrecta', new_password: 'MiClaveNueva99' })).status).toBe(401);
    expect((await api().post('/api/auth/password').set(token)
      .send({
        current_password: created.body.temporary_password,
        new_password: created.body.temporary_password,
      })).status).toBe(422);

    const change = await api().post('/api/auth/password').set(token)
      .send({ current_password: created.body.temporary_password, new_password: 'MiClaveNueva99' });
    expect(change.status).toBe(200);
  });
});

describe('Perfil', () => {
  it('el empleado ve y edita lo suyo', async () => {
    const me = await api().get('/api/employees/me').set(auth(waiter));
    expect(me.status).toBe(200);
    expect(me.body.employee).toMatchObject({ display_name: 'Luis', country: 'MX', on_shift: false });

    const upd = await api().put('/api/employees/me').set(auth(waiter))
      .send({ stage_name: 'Lucho', preferred_payout_currency: 'USD', phone: '6311234567' });
    expect(upd.status).toBe(200);
    expect(upd.body.employee).toMatchObject({ stage_name: 'Lucho', display_name: 'Lucho', preferred_payout_currency: 'USD', phone: '6311234567' });
  });

  it('un cliente no tiene perfil de empleado', async () => {
    expect((await api().get('/api/employees/me').set(auth(guest))).status).toBe(403);
    expect((await api().put('/api/employees/me').set(auth(guest)).send({ stage_name: 'X' })).status).toBe(403);
  });

  it('el gerente edita rol y datos, y un tercero no existe para él (404)', async () => {
    const res = await api().patch(url(`/employees/${waiter.id}`)).set(auth(manager))
      .send({ role: 'hostess', employee_code: 'E-007' });
    expect(res.body.employee).toMatchObject({ role: 'hostess', employee_code: 'E-007' });
    expect((await api().patch(url(`/employees/${guest.id}`)).set(auth(manager)).send({ role: 'waiter' })).status).toBe(404);
  });
});

describe('Cuentas bancarias', () => {
  const addAccount = (user, body) => api().post('/api/employees/me/bank-accounts').set(auth(user)).send(body);
  const mx = { type: 'clabe', bank_name: 'BBVA', holder_name: 'Luis Test', account_number: CLABE_OK };
  const us = { type: 'us_checking', bank_name: 'Chase', holder_name: 'Nina Test', account_number: '000123456789', routing_number: ABA_OK };

  it('guarda una CLABE cifrada y solo devuelve los últimos 4', async () => {
    const res = await addAccount(waiter, mx);
    expect(res.status).toBe(201);
    expect(res.body.bank_account).toMatchObject({
      country: 'MX', type: 'clabe', bank_name: 'BBVA', account_masked: `****${CLABE_OK.slice(-4)}`,
      is_default: true, verified: false,
    });
    expect(JSON.stringify(res.body)).not.toContain(CLABE_OK);

    const { rows } = await pool.query(
      `SELECT account_encrypted, account_last4,
              pgp_sym_decrypt(account_encrypted, $2) AS decrypted
         FROM employee_bank_accounts WHERE user_id = $1`, [waiter.id, process.env.BANK_ENCRYPTION_KEY]);
    expect(rows[0].account_last4).toBe(CLABE_OK.slice(-4));
    expect(Buffer.from(rows[0].account_encrypted).toString('latin1')).not.toContain(CLABE_OK);
    expect(rows[0].decrypted).toBe(CLABE_OK); // solo con la llave del servidor
  });

  it('guarda una cuenta de EE. UU. con routing cifrado', async () => {
    const res = await addAccount(dancer, us);
    expect(res.status).toBe(201);
    expect(res.body.bank_account).toMatchObject({ country: 'US', account_masked: '****6789', routing_masked: '****0021' });
    expect(JSON.stringify(res.body)).not.toContain('000123456789');
  });

  it('rechaza CLABE o routing inválidos sin guardar nada', async () => {
    const badClabe = await addAccount(waiter, { ...mx, account_number: CLABE_OK.slice(0, 17) + '0' });
    expect([400, 422]).toContain(badClabe.status);
    const badAba = await addAccount(dancer, { ...us, routing_number: '021000022' });
    expect(badAba.status).toBe(422);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM employee_bank_accounts');
    expect(rows[0].n).toBe(0);
  });

  it('solo una cuenta predeterminada; la lista nunca trae el número', async () => {
    await addAccount(waiter, mx);
    await addAccount(waiter, { ...mx, bank_name: 'Banorte', account_number: clabeFrom('07218000118359159') });
    const list = await api().get('/api/employees/me/bank-accounts').set(auth(waiter));
    expect(list.body.bank_accounts).toHaveLength(2);
    expect(list.body.bank_accounts.filter((a) => a.is_default)).toHaveLength(1);
    expect(list.body.bank_accounts[0].bank_name).toBe('Banorte');
    expect(JSON.stringify(list.body)).not.toMatch(/\d{18}/);
  });

  it('el gerente verifica la cuenta viendo solo la máscara', async () => {
    const created = await addAccount(waiter, mx);
    const id = created.body.bank_account.id;
    const seen = await api().get(url(`/employees/${waiter.id}/bank-accounts`)).set(auth(manager));
    expect(seen.body.bank_accounts[0].verified).toBe(false);
    expect(JSON.stringify(seen.body)).not.toContain(CLABE_OK);

    const ok = await api().post(url(`/employees/${waiter.id}/bank-accounts/${id}/verify`)).set(auth(manager)).send({});
    expect(ok.status).toBe(200);
    expect(ok.body.bank_account.verified).toBe(true);
    const { rows } = await pool.query('SELECT verified_by FROM employee_bank_accounts WHERE id = $1', [id]);
    expect(rows[0].verified_by).toBe(manager.id);

    const undo = await api().post(url(`/employees/${waiter.id}/bank-accounts/${id}/verify`)).set(auth(manager)).send({ verified: false });
    expect(undo.body.bank_account.verified).toBe(false);
  });

  it('un empleado no ve ni borra las cuentas de otro', async () => {
    const created = await addAccount(waiter, mx);
    expect((await api().get(url(`/employees/${waiter.id}/bank-accounts`)).set(auth(dancer))).status).toBe(403);
    expect((await api().delete(`/api/employees/me/bank-accounts/${created.body.bank_account.id}`).set(auth(dancer))).status).toBe(404);
    expect((await api().delete(`/api/employees/me/bank-accounts/${created.body.bank_account.id}`).set(auth(waiter))).status).toBe(204);
    const list = await api().get('/api/employees/me/bank-accounts').set(auth(waiter));
    expect(list.body.bank_accounts).toHaveLength(0);
  });

  it('sin llave de cifrado el servidor se niega a guardar', async () => {
    const saved = process.env.BANK_ENCRYPTION_KEY;
    delete process.env.BANK_ENCRYPTION_KEY;
    const res = await addAccount(waiter, mx);
    process.env.BANK_ENCRYPTION_KEY = saved;
    expect(res.status).toBe(500);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM employee_bank_accounts');
    expect(rows[0].n).toBe(0);
  });
});

// ---------------------------------------------------------------- parte 2

/** Propina ya cobrada al empleado, directo en el libro contable. */
async function paidTip(to, amount, cur = 'MXN', type = 'tip') {
  await pool.query(
    `INSERT INTO transactions (nightclub_id, type, direction, amount, currency, status, payer_user_id, payee_user_id, provider)
     VALUES ($1,$2,'in',$3,$4,'paid',$5,$6,'manual')`, [club.id, type, amount, cur, guest.id, to.id]);
}

async function verifiedAccount(user, over = {}) {
  const res = await api().post('/api/employees/me/bank-accounts').set(auth(user)).send({
    type: 'clabe', bank_name: 'BBVA', holder_name: 'Titular', account_number: CLABE_OK, ...over,
  });
  await api().post(url(`/employees/${user.id}/bank-accounts/${res.body.bank_account.id}/verify`)).set(auth(manager)).send({});
  return res.body.bank_account;
}

const withdraw = (user, body) => api().post('/api/employees/me/withdrawals').set(auth(user)).send(body);
const setRate = (rate) => api().put(url('/exchange-rate')).set(auth(manager)).send({ rate });

describe('Saldo y ganancias', () => {
  it('el saldo se calcula desde el libro, por moneda', async () => {
    await paidTip(waiter, 300);
    await paidTip(waiter, 200, 'MXN', 'song_request');
    await paidTip(waiter, 20, 'USD');
    const res = await api().get('/api/employees/me/earnings').set(auth(waiter));
    expect(res.status).toBe(200);
    expect(res.body.balances).toEqual([
      expect.objectContaining({ currency: 'MXN', earned: '500.00', available: '500.00', movements: 2 }),
      expect.objectContaining({ currency: 'USD', earned: '20.00', available: '20.00', movements: 1 }),
    ]);
    expect(res.body.by_type).toEqual(expect.arrayContaining([
      expect.objectContaining({ currency: 'MXN', type: 'tip', total: '300.00' }),
      expect.objectContaining({ currency: 'MXN', type: 'song_request', total: '200.00' }),
    ]));
  });

  it('solo cuenta lo efectivamente pagado', async () => {
    await paidTip(waiter, 300);
    await pool.query(
      `INSERT INTO transactions (nightclub_id, type, direction, amount, currency, status, payee_user_id, provider)
       VALUES ($1,'tip','in',999,'MXN','pending',$2,'manual')`, [club.id, waiter.id]);
    const res = await api().get('/api/employees/me/earnings').set(auth(waiter));
    expect(res.body.balances[0].earned).toBe('300.00');
  });

  it('filtra por fechas', async () => {
    // El libro es inmutable, así que la propina vieja se inserta ya con su fecha.
    await pool.query(
      `INSERT INTO transactions (nightclub_id, type, direction, amount, currency, status, payee_user_id, provider, created_at)
       VALUES ($1,'tip','in',100,'MXN','paid',$2,'manual', now() - interval '10 days')`, [club.id, waiter.id]);
    await paidTip(waiter, 50);
    const from = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);
    const res = await api().get(`/api/employees/me/earnings?from=${from}`).set(auth(waiter));
    expect(res.body.totals).toEqual([expect.objectContaining({ currency: 'MXN', total: '50.00' })]);
    expect(res.body.balances[0].earned).toBe('150.00'); // el saldo no depende del filtro
  });

  it('un empleado no ve las ganancias de otro; el gerente sí', async () => {
    await paidTip(dancer, 40, 'USD');
    expect((await api().get(url(`/employees/${dancer.id}/earnings`)).set(auth(waiter))).status).toBe(403);
    const res = await api().get(url(`/employees/${dancer.id}/earnings`)).set(auth(manager));
    expect(res.status).toBe(200);
    expect(res.body.balances[1]).toMatchObject({ currency: 'USD', earned: '40.00' });
    expect((await api().get(url(`/employees/${guest.id}/earnings`)).set(auth(manager))).status).toBe(404);
  });

  it('el tablero trae saldo, movimientos, retiro abierto y tipo de cambio', async () => {
    await setRate(18.5);
    await paidTip(waiter, 300);
    await verifiedAccount(waiter);
    await withdraw(waiter, { amount: 100, currency: 'MXN' });
    const res = await api().get('/api/employees/me/dashboard').set(auth(waiter));
    expect(res.status).toBe(200);
    expect(res.body.balances[0]).toMatchObject({ available: '200.00', reserved: '100.00' });
    expect(res.body.recent_movements).toHaveLength(1);
    expect(res.body.open_withdrawal).toMatchObject({ amount: '100.00', status: 'pending', account_masked: `****${CLABE_OK.slice(-4)}` });
    expect(Number(res.body.exchange_rate.rate)).toBe(18.5);
    expect(JSON.stringify(res.body)).not.toContain(CLABE_OK);
  });
});

describe('Tipo de cambio', () => {
  it('el gerente lo fija y queda historial con fecha y autor', async () => {
    expect((await setRate(17.9)).status).toBe(201);
    await setRate(18.2);
    const res = await api().get(url('/exchange-rate')).set(auth(manager));
    expect(Number(res.body.current.rate)).toBe(18.2);
    expect(res.body.history).toHaveLength(2);
    expect(res.body.history[0].set_by_name).toBe('manager Test');
  });

  it('un empleado ve el vigente, sin historial; no puede fijarlo', async () => {
    await setRate(18);
    const res = await api().get(url('/exchange-rate')).set(auth(waiter));
    expect(Number(res.body.current.rate)).toBe(18);
    expect(res.body.history).toEqual([]);
    expect((await api().put(url('/exchange-rate')).set(auth(waiter)).send({ rate: 1 })).status).toBe(403);
  });

  it('rechaza valores absurdos', async () => {
    expect((await setRate(0)).status).toBe(400);
    expect((await setRate(-5)).status).toBe(400);
  });
});

describe('Retiros', () => {
  beforeEach(async () => { await paidTip(waiter, 1000); });

  it('nace pendiente, reserva el saldo y no exige mínimo', async () => {
    await verifiedAccount(waiter);
    const res = await withdraw(waiter, { amount: 1, currency: 'MXN' });
    expect(res.status).toBe(201);
    expect(res.body.withdrawal).toMatchObject({ status: 'pending', amount: '1.00', currency: 'MXN', payout_currency: 'MXN' });
    const bal = (await api().get('/api/employees/me/earnings').set(auth(waiter))).body.balances[0];
    expect(bal).toMatchObject({ available: '999.00', reserved: '1.00' });
  });

  it('no excede el saldo', async () => {
    await verifiedAccount(waiter);
    const res = await withdraw(waiter, { amount: 1000.01, currency: 'MXN' });
    expect(res.status).toBe(422);
    expect(res.body.error.details.available).toBe(1000);
    expect((await withdraw(waiter, { amount: 1000, currency: 'MXN' })).status).toBe(201);
  });

  it('sin cuenta, o sin verificar, no hay retiro', async () => {
    expect((await withdraw(waiter, { amount: 10, currency: 'MXN' })).status).toBe(422);
    await api().post('/api/employees/me/bank-accounts').set(auth(waiter)).send({
      type: 'clabe', bank_name: 'BBVA', holder_name: 'Luis', account_number: CLABE_OK });
    const res = await withdraw(waiter, { amount: 10, currency: 'MXN' });
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/verificar/);
  });

  it('solo un retiro en proceso a la vez', async () => {
    await verifiedAccount(waiter);
    await withdraw(waiter, { amount: 10, currency: 'MXN' });
    expect((await withdraw(waiter, { amount: 10, currency: 'MXN' })).status).toBe(409);
  });

  it('dos peticiones simultáneas no gastan el saldo dos veces', async () => {
    await verifiedAccount(waiter);
    const results = await Promise.all([
      withdraw(waiter, { amount: 800, currency: 'MXN' }),
      withdraw(waiter, { amount: 800, currency: 'MXN' }),
    ]);
    // La segunda espera a la primera y ve el saldo ya reservado (422), o choca con el
    // índice de un retiro en proceso (409). Nunca pasan las dos.
    const statuses = results.map((r) => r.status).sort();
    expect(statuses[0]).toBe(201);
    expect([409, 422]).toContain(statuses[1]);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM withdrawals');
    expect(rows[0].n).toBe(1);
  });

  it('convierte USD a MXN con el tipo de cambio del día y lo deja escrito', async () => {
    await paidTip(dancer, 100, 'USD');
    await verifiedAccount(dancer);
    await setRate(18);
    const res = await withdraw(dancer, { amount: 100, currency: 'USD', payout_currency: 'MXN' });
    expect(res.status).toBe(201);
    expect(res.body.withdrawal).toMatchObject({ amount: '100.00', currency: 'USD', payout_currency: 'MXN', amount_paid: '1800.00' });
    expect(Number(res.body.withdrawal.exchange_rate)).toBe(18);

    // Al aprobar se vuelve a fijar con el tipo vigente en ese momento.
    await setRate(18.5);
    const ok = await api().post(url(`/withdrawals/${res.body.withdrawal.id}/approve`)).set(auth(manager)).send({});
    expect(ok.body.withdrawal.amount_paid).toBe('1850.00');
    expect(Number(ok.body.withdrawal.exchange_rate)).toBe(18.5);
  });

  it('sin tipo de cambio no se puede convertir', async () => {
    await paidTip(dancer, 100, 'USD');
    await verifiedAccount(dancer);
    const res = await withdraw(dancer, { amount: 50, currency: 'USD', payout_currency: 'MXN' });
    expect(res.status).toBe(422);
  });

  it('el gerente aprueba, marca pagado y queda el asiento de salida', async () => {
    await verifiedAccount(waiter);
    const w = (await withdraw(waiter, { amount: 400, currency: 'MXN' })).body.withdrawal;

    const paidTooSoon = await api().post(url(`/withdrawals/${w.id}/paid`)).set(auth(manager)).send({});
    expect(paidTooSoon.status).toBe(409);

    const ok = await api().post(url(`/withdrawals/${w.id}/approve`)).set(auth(manager)).send({ note: 'ok' });
    expect(ok.body.withdrawal).toMatchObject({ status: 'approved', reviewed_by_name: 'manager Test' });

    const paid = await api().post(url(`/withdrawals/${w.id}/paid`)).set(auth(manager)).send({ reference: 'SPEI 12345' });
    expect(paid.body.withdrawal).toMatchObject({ status: 'paid' });
    expect(paid.body.withdrawal.paid_at).toBeTruthy();

    const { rows } = await pool.query(
      `SELECT type, direction, amount, currency, status, payee_user_id, provider_ref FROM transactions WHERE type = 'withdrawal'`);
    expect(rows).toEqual([expect.objectContaining({
      direction: 'out', amount: '400.00', currency: 'MXN', status: 'paid', payee_user_id: waiter.id, provider_ref: 'SPEI 12345',
    })]);
    const bal = (await api().get('/api/employees/me/earnings').set(auth(waiter))).body.balances[0];
    expect(bal).toMatchObject({ earned: '1000.00', withdrawn: '400.00', reserved: '0.00', available: '600.00' });
  });

  it('rechazar devuelve el saldo y permite pedir de nuevo', async () => {
    await verifiedAccount(waiter);
    const w = (await withdraw(waiter, { amount: 400, currency: 'MXN' })).body.withdrawal;
    const noReason = await api().post(url(`/withdrawals/${w.id}/reject`)).set(auth(manager)).send({});
    expect(noReason.status).toBe(400);
    const rej = await api().post(url(`/withdrawals/${w.id}/reject`)).set(auth(manager)).send({ reason: 'Cuenta a nombre de otra persona' });
    expect(rej.body.withdrawal).toMatchObject({ status: 'rejected', rejection_reason: 'Cuenta a nombre de otra persona' });

    const bal = (await api().get('/api/employees/me/earnings').set(auth(waiter))).body.balances[0];
    expect(bal).toMatchObject({ available: '1000.00', reserved: '0.00' });
    expect((await withdraw(waiter, { amount: 400, currency: 'MXN' })).status).toBe(201);
    expect((await api().post(url(`/withdrawals/${w.id}/approve`)).set(auth(manager)).send({})).status).toBe(409);
  });

  it('solo el gerente revisa; el empleado ve solo los suyos', async () => {
    await verifiedAccount(waiter);
    const w = (await withdraw(waiter, { amount: 10, currency: 'MXN' })).body.withdrawal;
    expect((await api().post(url(`/withdrawals/${w.id}/approve`)).set(auth(waiter)).send({})).status).toBe(403);
    expect((await api().get(url('/withdrawals')).set(auth(waiter))).status).toBe(403);

    const mine = await api().get('/api/employees/me/withdrawals').set(auth(dancer));
    expect(mine.body.withdrawals).toHaveLength(0);
    const list = await api().get(url('/withdrawals?status=pending')).set(auth(manager));
    expect(list.body.withdrawals.map((x) => x.employee_name)).toEqual(['Luis']);
    expect(JSON.stringify(list.body)).not.toContain(CLABE_OK);
  });

  it('el gerente ve la nómina por empleado y moneda', async () => {
    await paidTip(dancer, 30, 'USD');
    await verifiedAccount(waiter);
    await withdraw(waiter, { amount: 250, currency: 'MXN' });
    const res = await api().get(url('/payroll')).set(auth(manager));
    expect(res.status).toBe(200);
    expect(res.body.pending_withdrawals).toBe(1);
    expect(res.body.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ display_name: 'Nina', currency: 'USD', earned: '30.00', available: '30.00' }),
      expect.objectContaining({ display_name: 'Luis', currency: 'MXN', earned: '1000.00', reserved: '250.00', available: '750.00' }),
    ]));
    expect((await api().get(url('/payroll')).set(auth(waiter))).status).toBe(403);
  });
});
