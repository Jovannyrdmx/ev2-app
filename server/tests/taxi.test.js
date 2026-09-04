'use strict';

// Salida segura, parte 1 (D21): alta de conductores de confianza por el gerente,
// disponibilidad declarada por el conductor, tarifas por zona y ajustes del módulo.

const { setupSchema, truncateAll, closePool, pool } = require('./helpers/db');
const { api, auth } = require('./helpers/api');
const f = require('./helpers/factories');

let club; let otherClub; let manager; let guest; let otherManager;

beforeAll(setupSchema);
afterAll(closePool);

beforeEach(async () => {
  await truncateAll();
  club = await f.createNightclub({ slug: 'ev2-taxi' });
  otherClub = await f.createNightclub({ name: 'Otro', slug: 'otro-taxi' });
  manager = await f.createUser(club.id, { role: 'manager' });
  guest = await f.createUser(club.id, { role: 'guest', display_name: 'Ana' });
  otherManager = await f.createUser(otherClub.id, { role: 'manager' });
});

const url = (p) => `/api/nightclubs/${club.id}${p}`;
let seq = 0;

const newDriver = (over = {}) => {
  seq += 1;
  return api().post(url('/drivers')).set(auth(manager)).send({
    email: `chofer-${Date.now()}-${seq}@ev2.mx`,
    first_name: 'Raúl',
    last_name: 'Mendoza',
    birth_date: '1985-03-12',
    phone: '+526311234567',
    vehicle_plate: `abc-${1000 + seq}`,
    vehicle_make: 'Nissan',
    vehicle_model: 'Tsuru',
    vehicle_color: 'Blanco',
    ...over,
  });
};

/** Creates a driver and returns its row plus a signed-in user object. */
async function trustedDriver(over = {}) {
  const created = await newDriver(over);
  const driver = created.body.driver;
  await api().patch(url(`/drivers/${driver.id}`)).set(auth(manager)).send({ trusted: true });
  await pool.query('UPDATE users SET must_change_password = false WHERE id = $1', [driver.user_id]);
  const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [driver.user_id]);
  return { driver, user: rows[0], temporary_password: created.body.temporary_password };
}

const login = (email, password, slug = 'ev2-taxi') => api().post('/api/auth/login')
  .send({ nightclub_slug: slug, email, password });

// ---------------------------------------------------------------- alta

describe('Alta de conductores', () => {
  it('el gerente da de alta un conductor y recibe una contraseña temporal una sola vez', async () => {
    const res = await newDriver();
    expect(res.status).toBe(201);
    expect(res.body.driver).toMatchObject({
      first_name: 'Raúl', vehicle_make: 'Nissan', seats: 4,
      trusted: false, active: true, availability: 'off', at_venue: false,
      must_change_password: true, rides_completed: 0,
    });
    // Las placas se guardan en mayúsculas: el cliente identifica el auto por ellas.
    expect(res.body.driver.vehicle_plate).toMatch(/^ABC-/);
    expect(res.body.driver.verified_at).toBeNull();
    expect(res.body.temporary_password).toHaveLength(12);

    const stored = await pool.query('SELECT password_hash, role FROM users WHERE id = $1',
      [res.body.driver.user_id]);
    expect(stored.rows[0].role).toBe('driver');
    expect(stored.rows[0].password_hash).not.toContain(res.body.temporary_password);
  });

  it('un cliente no puede dar de alta conductores', async () => {
    const res = await api().post(url('/drivers')).set(auth(guest)).send({
      email: 'x@ev2.mx', first_name: 'X', last_name: 'Y', birth_date: '1990-01-01',
      phone: '+526311234567', vehicle_plate: 'XYZ-1',
    });
    expect(res.status).toBe(403);
  });

  it('rechaza correo repetido (409) y placas de otro conductor activo (409)', async () => {
    const first = await newDriver();
    const sameEmail = await newDriver({ email: first.body.driver.email });
    expect(sameEmail.status).toBe(409);

    const samePlate = await newDriver({ vehicle_plate: first.body.driver.vehicle_plate.toLowerCase() });
    expect(samePlate.status).toBe(409);
    expect(samePlate.body.error.message).toMatch(/placas/i);
  });

  it('rechaza un conductor menor de edad (422) y datos inválidos (400)', async () => {
    const minor = await newDriver({ birth_date: '2012-01-01' });
    expect(minor.status).toBe(422);

    const bad = await newDriver({ phone: '12' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.details.map((d) => d.field)).toContain('body.phone');
  });

  it('la contraseña temporal solo abre la puerta para cambiarla', async () => {
    const created = await newDriver();
    const { email } = created.body.driver;
    const temp = created.body.temporary_password;

    const signedIn = await login(email, temp);
    expect(signedIn.status).toBe(200);
    const token = { Authorization: `Bearer ${signedIn.body.access_token}` };

    const blocked = await api().get(url('/taxi/me')).set(token);
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('password_change_required');

    const changed = await api().post('/api/auth/password').set(token)
      .send({ current_password: temp, new_password: 'ChoferSeguro123' });
    expect(changed.status).toBe(200);

    const after = { Authorization: `Bearer ${changed.body.access_token}` };
    const profile = await api().get(url('/taxi/me')).set(after);
    expect(profile.status).toBe(200);
    expect(profile.body.driver.must_change_password).toBe(false);
  });
});

// ---------------------------------------------------------------- verificación y baja

describe('Verificación, baja y reinicio de contraseña', () => {
  it('marcar trusted deja constancia de quién verificó y cuándo', async () => {
    const created = await newDriver();
    const res = await api().patch(url(`/drivers/${created.body.driver.id}`))
      .set(auth(manager)).send({ trusted: true });
    expect(res.status).toBe(200);
    expect(res.body.driver.trusted).toBe(true);
    expect(res.body.driver.verified_at).not.toBeNull();

    const { rows } = await pool.query('SELECT verified_by FROM drivers WHERE id = $1',
      [created.body.driver.id]);
    expect(rows[0].verified_by).toBe(manager.id);
  });

  it('dar de baja bloquea la cuenta y reactivar la devuelve', async () => {
    const { driver, user } = await trustedDriver();
    await pool.query('UPDATE users SET password_hash = $2 WHERE id = $1',
      [user.id, (await pool.query('SELECT password_hash FROM users WHERE id = $1', [manager.id])).rows[0].password_hash]);

    const down = await api().patch(url(`/drivers/${driver.id}`)).set(auth(manager)).send({ active: false });
    expect(down.status).toBe(200);
    expect(down.body.driver.active).toBe(false);
    expect(down.body.driver.availability).toBe('off');
    expect((await login(user.email, f.PASSWORD)).status).toBe(403);

    const up = await api().patch(url(`/drivers/${driver.id}`)).set(auth(manager)).send({ active: true });
    expect(up.status).toBe(200);
    expect((await login(user.email, f.PASSWORD)).status).toBe(200);
  });

  it('quitar la verificación deja al conductor fuera de la lista de disponibles', async () => {
    const { driver, user } = await trustedDriver();
    await api().put(url('/taxi/me/availability')).set(auth(user))
      .send({ availability: 'available', at_venue: true });

    const res = await api().patch(url(`/drivers/${driver.id}`)).set(auth(manager)).send({ trusted: false });
    expect(res.body.driver.availability).toBe('off');
    expect(res.body.driver.at_venue).toBe(false);

    const state = await api().get(url('/taxi/availability')).set(auth(guest));
    expect(state.body.available_drivers).toBe(0);
  });

  it('el reinicio de contraseña entrega una nueva temporal y exige cambiarla', async () => {
    const { driver, user } = await trustedDriver();
    const res = await api().post(url(`/drivers/${driver.id}/reset-password`)).set(auth(manager));
    expect(res.status).toBe(200);
    expect(res.body.temporary_password).toHaveLength(12);

    const signedIn = await login(user.email, res.body.temporary_password);
    expect(signedIn.status).toBe(200);
    const blocked = await api().get(url('/taxi/me'))
      .set({ Authorization: `Bearer ${signedIn.body.access_token}` });
    expect(blocked.body.error.code).toBe('password_change_required');
  });

  it('el gerente de otro club no ve ni toca a estos conductores', async () => {
    const created = await newDriver();
    expect((await api().get(url('/drivers')).set(auth(otherManager))).status).toBe(403);
    expect((await api().get(url(`/drivers/${created.body.driver.id}`)).set(auth(otherManager))).status).toBe(403);
    const listed = await api().get(`/api/nightclubs/${otherClub.id}/drivers`).set(auth(otherManager));
    expect(listed.body.drivers).toHaveLength(0);
  });

  it('un conductor inexistente responde 404', async () => {
    const res = await api().get(url('/drivers/00000000-0000-0000-0000-000000000000')).set(auth(manager));
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------- disponibilidad del conductor

describe('Disponibilidad declarada por el conductor', () => {
  it('un conductor sin verificar no puede marcarse disponible', async () => {
    const created = await newDriver();
    await pool.query('UPDATE users SET must_change_password = false WHERE id = $1',
      [created.body.driver.user_id]);
    const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [created.body.driver.user_id]);
    const res = await api().put(url('/taxi/me/availability')).set(auth(rows[0]))
      .send({ availability: 'available' });
    expect(res.status).toBe(403);
  });

  it('marcarse disponible fija la hora y apagar la limpia', async () => {
    const { user } = await trustedDriver();
    const on = await api().put(url('/taxi/me/availability')).set(auth(user))
      .send({ availability: 'available', at_venue: true });
    expect(on.status).toBe(200);
    expect(on.body.availability).toMatchObject({ availability: 'available', at_venue: true });
    expect(on.body.availability.available_since).not.toBeNull();

    const off = await api().put(url('/taxi/me/availability')).set(auth(user))
      .send({ availability: 'off', at_venue: true });
    // Apagarse siempre saca al conductor de la salida, aunque el cuerpo diga otra cosa.
    expect(off.body.availability).toMatchObject({ availability: 'off', at_venue: false });
    expect(off.body.availability.available_since).toBeNull();
  });

  it('un cliente no entra a la sección del conductor', async () => {
    const res = await api().get(url('/taxi/me')).set(auth(guest));
    expect(res.status).toBe(403);
  });

  it('con el módulo apagado el conductor no puede ponerse disponible', async () => {
    const { user } = await trustedDriver();
    await api().put(url('/taxi-settings')).set(auth(manager)).send({ enabled: false });
    const res = await api().put(url('/taxi/me/availability')).set(auth(user))
      .send({ availability: 'available' });
    expect(res.status).toBe(422);
  });

  it('el cambio de disponibilidad avisa al gerente y a la anfitriona', async () => {
    const { user, driver } = await trustedDriver();
    await api().put(url('/taxi/me/availability')).set(auth(user)).send({ availability: 'available' });
    const { rows } = await pool.query(
      `SELECT type, audience, payload FROM events WHERE nightclub_id = $1 AND type = 'taxi_driver_availability'`,
      [club.id]);
    expect(rows).toHaveLength(1);
    expect(rows[0].audience.roles).toEqual(['manager', 'hostess']);
    expect(rows[0].payload.driver_id).toBe(driver.id);
  });
});

// ---------------------------------------------------------------- disponibilidad para el cliente

describe('Lo que ve el cliente antes de pedir', () => {
  it('sin conductores disponibles lo dice sin mentir sobre el tiempo', async () => {
    const res = await api().get(url('/taxi/availability')).set(auth(guest));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      enabled: true, available_drivers: 0, drivers_at_venue: 0, wait_at_exit: false,
      estimated_wait_minutes: null, pickup_point: 'Salida principal',
    });
  });

  it('un conductor disponible sin historial no inventa un tiempo estimado', async () => {
    const { user } = await trustedDriver();
    await api().put(url('/taxi/me/availability')).set(auth(user)).send({ availability: 'available' });
    const res = await api().get(url('/taxi/availability')).set(auth(guest));
    expect(res.body.available_drivers).toBe(1);
    expect(res.body.wait_at_exit).toBe(false);
    expect(res.body.estimated_wait_minutes).toBeNull();
  });

  it('un conductor esperando en la salida se anuncia como espera cero', async () => {
    const { user } = await trustedDriver();
    await api().put(url('/taxi/me/availability')).set(auth(user))
      .send({ availability: 'available', at_venue: true });
    const res = await api().get(url('/taxi/availability')).set(auth(guest));
    expect(res.body).toMatchObject({
      available_drivers: 1, drivers_at_venue: 1, wait_at_exit: true, estimated_wait_minutes: 0,
    });
    expect(res.body.message).toMatch(/salida/i);
  });

  it('usa el promedio real del conductor cuando ya tiene viajes', async () => {
    const { user, driver } = await trustedDriver();
    await api().put(url('/taxi/me/availability')).set(auth(user)).send({ availability: 'available' });
    // Dos recogidas anteriores: 8 y 12 minutos entre aceptar y llegar.
    for (const minutes of [8, 12]) {
      await pool.query(
        `INSERT INTO taxi_requests (nightclub_id, user_id, driver_id, status, accepted_at, arrived_at,
                                    started_at, ended_at, completed_at)
         VALUES ($1,$2,$3,'completed', now() - ($4 || ' minutes')::interval, now(),
                 now(), now(), now())`,
        [club.id, guest.id, driver.id, String(minutes)]);
    }
    const res = await api().get(url('/taxi/availability')).set(auth(guest));
    expect(res.body.estimated_wait_minutes).toBe(10);
  });

  it('un conductor inactivo o sin verificar no cuenta como disponible', async () => {
    const { user, driver } = await trustedDriver();
    await api().put(url('/taxi/me/availability')).set(auth(user)).send({ availability: 'available' });
    await pool.query('UPDATE drivers SET active = false WHERE id = $1', [driver.id]);
    const res = await api().get(url('/taxi/availability')).set(auth(guest));
    expect(res.body.available_drivers).toBe(0);
  });

  it('con el módulo apagado el cliente ve el servicio cerrado', async () => {
    await api().put(url('/taxi-settings')).set(auth(manager)).send({ enabled: false });
    const res = await api().get(url('/taxi/availability')).set(auth(guest));
    expect(res.body.enabled).toBe(false);
    expect(res.body.available_drivers).toBe(0);
  });
});

// ---------------------------------------------------------------- ajustes

describe('Ajustes del módulo', () => {
  it('el cliente no ve la comisión ni los plazos internos; el gerente sí', async () => {
    const asGuest = await api().get(url('/taxi-settings')).set(auth(guest));
    expect(asGuest.status).toBe(200);
    expect(asGuest.body.settings).toHaveProperty('pickup_point');
    expect(asGuest.body.settings).not.toHaveProperty('club_commission_pct');
    expect(asGuest.body.settings).not.toHaveProperty('certificate_ttl_minutes');

    const asManager = await api().get(url('/taxi-settings')).set(auth(manager));
    expect(asManager.body.settings).toMatchObject({
      club_commission_pct: '0.00', certificate_ttl_minutes: 120, request_timeout_minutes: 15,
    });
  });

  it('el gerente edita el punto de encuentro y la vigencia de la constancia', async () => {
    const res = await api().put(url('/taxi-settings')).set(auth(manager))
      .send({ pickup_point: 'Puerta lateral', certificate_ttl_minutes: 45 });
    expect(res.status).toBe(200);
    expect(res.body.settings).toMatchObject({ pickup_point: 'Puerta lateral', certificate_ttl_minutes: 45 });

    const bad = await api().put(url('/taxi-settings')).set(auth(manager))
      .send({ certificate_ttl_minutes: 5 });
    expect(bad.status).toBe(400);
  });

  it('un cliente no puede cambiar los ajustes', async () => {
    const res = await api().put(url('/taxi-settings')).set(auth(guest)).send({ enabled: false });
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------- tarifas

describe('Tarifas por zona', () => {
  const fare = (over = {}) => api().post(url('/taxi-fares')).set(auth(manager))
    .send({ zone: 'Centro', amount: 120, ...over });

  it('el gerente carga una tarifa y la zona repetida responde 409', async () => {
    const res = await fare({ description: 'Zona centro y alrededores' });
    expect(res.status).toBe(201);
    expect(res.body.fare).toMatchObject({ zone: 'Centro', amount: '120.00', currency: 'MXN', active: true });
    expect((await fare()).status).toBe(409);
  });

  it('el cliente ve la lista pero no la puede modificar', async () => {
    await fare();
    const listed = await api().get(url('/taxi-fares')).set(auth(guest));
    expect(listed.body.fares).toHaveLength(1);
    expect((await api().post(url('/taxi-fares')).set(auth(guest)).send({ zone: 'X', amount: 10 })).status)
      .toBe(403);
  });

  it('actualizar cambia el monto y retirar la saca de la lista del cliente', async () => {
    const created = await fare();
    const updated = await api().put(url(`/taxi-fares/${created.body.fare.id}`)).set(auth(manager))
      .send({ amount: 150 });
    expect(updated.body.fare.amount).toBe('150.00');

    const removed = await api().delete(url(`/taxi-fares/${created.body.fare.id}`)).set(auth(manager));
    expect(removed.status).toBe(200);
    expect(removed.body.fare.active).toBe(false);

    const asGuest = await api().get(url('/taxi-fares')).set(auth(guest));
    expect(asGuest.body.fares).toHaveLength(0);
    // El gerente todavía la ve para poder reactivarla; la tarifa nunca se borra
    // porque los viajes pasados se cotizaron con ella.
    const asManager = await api().get(url('/taxi-fares?include_inactive=true')).set(auth(manager));
    expect(asManager.body.fares).toHaveLength(1);
  });

  it('una tarifa de otro club no se puede editar desde aquí', async () => {
    const created = await fare();
    const res = await api().put(`/api/nightclubs/${otherClub.id}/taxi-fares/${created.body.fare.id}`)
      .set(auth(otherManager)).send({ amount: 999 });
    expect(res.status).toBe(404);
  });
});
