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
  it('el gerente da de alta y recibe la contraseña temporal una sola vez', async () => {
    const res = await newEmployee({ stage_name: 'Pete', country: 'MX' });
    expect(res.status).toBe(201);
    expect(res.body.employee).toMatchObject({
      role: 'bartender', country: 'MX', stage_name: 'Pete', display_name: 'Pete',
      must_change_password: true, active: true, preferred_currency: 'MXN',
    });
    expect(res.body.temporary_password).toMatch(/^[A-Za-z0-9]{12}$/);
    // Nada la guarda en claro.
    const { rows } = await pool.query('SELECT password_hash FROM users WHERE id = $1', [res.body.employee.id]);
    expect(rows[0].password_hash).not.toContain(res.body.temporary_password);
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
    expect((await newEmployee({ role: 'manager' })).status).toBe(400);
    expect((await newEmployee({ role: 'guest' })).status).toBe(400);
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

describe('Contraseña temporal', () => {
  it('con la temporal solo se puede entrar a cambiarla', async () => {
    const created = await newEmployee({ email: 'pete@ev2.mx' });
    const session = await login('pete@ev2.mx', created.body.temporary_password);
    expect(session.status).toBe(200);
    expect(session.body.user.must_change_password).toBe(true);
    const token = { Authorization: `Bearer ${session.body.access_token}` };

    const blocked = await api().get('/api/employees/me').set(token);
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('password_change_required');

    const change = await api().post('/api/auth/password').set(token)
      .send({ current_password: created.body.temporary_password, new_password: 'MiClaveNueva99' });
    expect(change.status).toBe(200);
    expect(change.body.access_token).toBeTruthy();

    const me = await api().get('/api/employees/me').set({ Authorization: `Bearer ${change.body.access_token}` });
    expect(me.status).toBe(200);
    expect(me.body.employee.must_change_password).toBe(false);
  });

  it('exige la contraseña actual y una distinta', async () => {
    const created = await newEmployee({ email: 'pete2@ev2.mx' });
    const session = await login('pete2@ev2.mx', created.body.temporary_password);
    const token = { Authorization: `Bearer ${session.body.access_token}` };
    expect((await api().post('/api/auth/password').set(token)
      .send({ current_password: 'incorrecta', new_password: 'MiClaveNueva99' })).status).toBe(401);
    expect((await api().post('/api/auth/password').set(token)
      .send({ current_password: created.body.temporary_password, new_password: created.body.temporary_password })).status).toBe(422);
    expect((await api().post('/api/auth/password').set(token)
      .send({ current_password: created.body.temporary_password, new_password: 'corta' })).status).toBe(400);
  });

  it('el gerente puede reiniciarla y cierra las sesiones', async () => {
    const created = await newEmployee({ email: 'pete3@ev2.mx' });
    const first = await login('pete3@ev2.mx', created.body.temporary_password);
    const reset = await api().patch(url(`/employees/${created.body.employee.id}`)).set(auth(manager))
      .send({ reset_password: true });
    expect(reset.status).toBe(200);
    expect(reset.body.temporary_password).toMatch(/^[A-Za-z0-9]{12}$/);
    expect(reset.body.temporary_password).not.toBe(created.body.temporary_password);

    expect((await login('pete3@ev2.mx', created.body.temporary_password)).status).toBe(401);
    expect((await api().post('/api/auth/refresh').send({ refresh_token: first.body.refresh_token })).status).toBe(401);
    expect((await login('pete3@ev2.mx', reset.body.temporary_password)).status).toBe(200);
  });

  it('un empleado dado de baja no puede entrar', async () => {
    const created = await newEmployee({ email: 'pete4@ev2.mx' });
    await api().patch(url(`/employees/${created.body.employee.id}`)).set(auth(manager)).send({ active: false });
    expect((await login('pete4@ev2.mx', created.body.temporary_password)).status).toBe(403);
    await api().patch(url(`/employees/${created.body.employee.id}`)).set(auth(manager)).send({ active: true });
    expect((await login('pete4@ev2.mx', created.body.temporary_password)).status).toBe(200);
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
