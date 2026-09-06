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

// ---------------------------------------------------------------- ciclo del viaje

describe('Solicitud del cliente', () => {
  let fare;
  beforeEach(async () => {
    const created = await api().post(url('/taxi-fares')).set(auth(manager))
      .send({ zone: 'Centro', amount: 120 });
    fare = created.body.fare;
  });

  it('crea la solicitud con la tarifa de la zona y el punto de encuentro', async () => {
    const res = await api().post(url('/taxi/rides')).set(auth(guest))
      .send({ fare_id: fare.id, passengers: 2, destination: 'Calle Obregón 45' });
    expect(res.status).toBe(201);
    expect(res.body.ride).toMatchObject({
      status: 'requested', passengers: 2, destination_zone: 'Centro',
      quoted_amount: '120.00', currency: 'MXN', pickup_location: 'Salida principal',
      driver: null, eta_minutes: null,
    });
    expect(res.body.availability.available_drivers).toBe(0);
  });

  it('sin zona no inventa un precio', async () => {
    const res = await api().post(url('/taxi/rides')).set(auth(guest))
      .send({ destination: 'Rancho fuera de la ciudad' });
    expect(res.body.ride.quoted_amount).toBeNull();
    expect(res.body.ride.destination_zone).toBeNull();
  });

  it('el mismo client_request_id no crea dos solicitudes', async () => {
    const key = '77777777-7777-4777-8777-777777777777';
    const first = await api().post(url('/taxi/rides')).set(auth(guest))
      .send({ client_request_id: key, fare_id: fare.id });
    const second = await api().post(url('/taxi/rides')).set(auth(guest))
      .send({ client_request_id: key, fare_id: fare.id });
    expect(second.status).toBe(200);
    expect(second.body.idempotent).toBe(true);
    expect(second.body.ride.id).toBe(first.body.ride.id);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM taxi_requests');
    expect(rows[0].n).toBe(1);
  });

  it('una segunda solicitud abierta responde 409', async () => {
    await api().post(url('/taxi/rides')).set(auth(guest)).send({ fare_id: fare.id });
    const second = await api().post(url('/taxi/rides')).set(auth(guest)).send({ fare_id: fare.id });
    expect(second.status).toBe(409);
  });

  it('un conductor no pide taxi desde su cuenta y una zona inexistente responde 422', async () => {
    const { user } = await trustedDriver();
    expect((await api().post(url('/taxi/rides')).set(auth(user)).send({})).status).toBe(403);
    const bad = await api().post(url('/taxi/rides')).set(auth(guest))
      .send({ fare_id: '00000000-0000-4000-8000-000000000000' });
    expect(bad.status).toBe(422);
  });

  it('con el módulo apagado no se puede solicitar', async () => {
    await api().put(url('/taxi-settings')).set(auth(manager)).send({ enabled: false });
    const res = await api().post(url('/taxi/rides')).set(auth(guest)).send({});
    expect(res.status).toBe(422);
  });

  // El código de conducta: si el club publicó reglas, no hay viaje sin aceptarlas, y la
  // aceptación se guarda con su hora. Es la mitad que protege al club — la constancia
  // protege al cliente, esto respalda al club la noche que algo pasa en un coche.
  describe('código de conducta', () => {
    const REGLAS = 'No se permite fumar ni consumir alcohol dentro del vehículo.';

    it('sin reglas publicadas no se pide nada y no se guarda aceptación', async () => {
      const res = await api().post(url('/taxi/rides')).set(auth(guest)).send({ fare_id: fare.id });
      expect(res.status).toBe(201);
      expect(res.body.ride.conduct_accepted_at).toBeNull();
    });

    it('con reglas publicadas, pedir sin aceptar responde 422 y NO crea el viaje', async () => {
      await api().put(url('/taxi-settings')).set(auth(manager)).send({ conduct_terms: REGLAS });
      const res = await api().post(url('/taxi/rides')).set(auth(guest)).send({ fare_id: fare.id });
      expect(res.status).toBe(422);
      const { rows } = await pool.query('SELECT count(*)::int AS n FROM taxi_requests');
      expect(rows[0].n).toBe(0);
    });

    it('aceptando, el viaje se crea y queda la hora en que se aceptó', async () => {
      await api().put(url('/taxi-settings')).set(auth(manager)).send({ conduct_terms: REGLAS });
      const res = await api().post(url('/taxi/rides')).set(auth(guest))
        .send({ fare_id: fare.id, conduct_accepted: true });
      expect(res.status).toBe(201);
      expect(res.body.ride.conduct_accepted_at).toEqual(expect.any(String));
      const { rows } = await pool.query('SELECT conduct_accepted_at FROM taxi_requests');
      expect(rows[0].conduct_accepted_at).toBeInstanceOf(Date);
    });

    it('`false` no es aceptar', async () => {
      await api().put(url('/taxi-settings')).set(auth(manager)).send({ conduct_terms: REGLAS });
      const res = await api().post(url('/taxi/rides')).set(auth(guest))
        .send({ fare_id: fare.id, conduct_accepted: false });
      expect(res.status).toBe(422);
    });

    it('el club puede quitar las reglas, y entonces deja de pedirse', async () => {
      await api().put(url('/taxi-settings')).set(auth(manager)).send({ conduct_terms: REGLAS });
      await api().put(url('/taxi-settings')).set(auth(manager)).send({ conduct_terms: null });
      const res = await api().post(url('/taxi/rides')).set(auth(guest)).send({ fare_id: fare.id });
      expect(res.status).toBe(201);
    });

    it('el texto llega al cliente para que pueda leerlo antes de aceptar', async () => {
      await api().put(url('/taxi-settings')).set(auth(manager)).send({ conduct_terms: REGLAS });
      const res = await api().get(url('/taxi-settings')).set(auth(guest));
      expect(res.status).toBe(200);
      expect(res.body.settings.conduct_terms).toBe(REGLAS);
    });
  });
});

// ---------------------------------------------------------------- asignación

describe('Aceptar y asignar', () => {
  let driverA; let driverB; let ride;

  beforeEach(async () => {
    driverA = await trustedDriver();
    driverB = await trustedDriver();
    for (const d of [driverA, driverB]) {
      await api().put(url('/taxi/me/availability')).set(auth(d.user)).send({ availability: 'available' });
    }
    const created = await api().post(url('/taxi/rides')).set(auth(guest)).send({ passengers: 1 });
    ride = created.body.ride;
  });

  it('la solicitud abierta se ofrece a todos los conductores disponibles', async () => {
    for (const d of [driverA, driverB]) {
      const res = await api().get(url('/taxi/me/offers')).set(auth(d.user));
      expect(res.status).toBe(200);
      expect(res.body.offers.map((o) => o.id)).toContain(ride.id);
      // El conductor ve a quién recoge, no su teléfono.
      expect(res.body.offers[0].guest).toEqual({ name: 'Ana' });
      expect(res.body.offers[0]).not.toHaveProperty('guest_phone');
    }
  });

  it('aceptar declara los minutos y calcula la hora esperada', async () => {
    const res = await api().post(url(`/taxi/rides/${ride.id}/accept`)).set(auth(driverA.user))
      .send({ eta_minutes: 10 });
    expect(res.status).toBe(200);
    expect(res.body.ride).toMatchObject({ status: 'assigned', eta_minutes: 10 });
    const expected = new Date(res.body.ride.expected_arrival_at) - new Date(res.body.ride.accepted_at);
    expect(Math.round(expected / 60000)).toBe(10);

    const { rows } = await pool.query('SELECT availability, at_venue FROM drivers WHERE id = $1',
      [driverA.driver.id]);
    expect(rows[0]).toMatchObject({ availability: 'on_trip', at_venue: false });
  });

  it('el segundo conductor que acepta recibe 409 y el viaje no cambia de dueño', async () => {
    await api().post(url(`/taxi/rides/${ride.id}/accept`)).set(auth(driverA.user))
      .send({ eta_minutes: 5 });
    const late = await api().post(url(`/taxi/rides/${ride.id}/accept`)).set(auth(driverB.user))
      .send({ eta_minutes: 5 });
    expect(late.status).toBe(409);
    const { rows } = await pool.query('SELECT driver_id FROM taxi_requests WHERE id = $1', [ride.id]);
    expect(rows[0].driver_id).toBe(driverA.driver.id);
  });

  it('rechazar saca la oferta de mi lista pero no de la del otro conductor', async () => {
    const declined = await api().post(url(`/taxi/rides/${ride.id}/decline`)).set(auth(driverA.user));
    expect(declined.status).toBe(200);
    expect((await api().get(url('/taxi/me/offers')).set(auth(driverA.user))).body.offers).toHaveLength(0);
    expect((await api().get(url('/taxi/me/offers')).set(auth(driverB.user))).body.offers).toHaveLength(1);
    // Rechazar dos veces no es un error.
    expect((await api().post(url(`/taxi/rides/${ride.id}/decline`)).set(auth(driverA.user))).status).toBe(200);
  });

  it('con un viaje en curso no se puede aceptar otro', async () => {
    await api().post(url(`/taxi/rides/${ride.id}/accept`)).set(auth(driverA.user)).send({ eta_minutes: 5 });
    const otherGuest = await f.createUser(club.id, { role: 'guest' });
    const second = await api().post(url('/taxi/rides')).set(auth(otherGuest)).send({});
    const res = await api().post(url(`/taxi/rides/${second.body.ride.id}/accept`))
      .set(auth(driverA.user)).send({ eta_minutes: 5 });
    expect(res.status).toBe(409);
  });

  it('el cliente ve el auto y el teléfono solo cuando ya hay conductor asignado', async () => {
    const before = await api().get(url(`/taxi/rides/${ride.id}`)).set(auth(guest));
    expect(before.body.ride.driver).toBeNull();

    await api().post(url(`/taxi/rides/${ride.id}/accept`)).set(auth(driverA.user)).send({ eta_minutes: 8 });
    const after = await api().get(url(`/taxi/rides/${ride.id}`)).set(auth(guest));
    expect(after.body.ride.driver).toMatchObject({ first_name: 'Raúl', phone: '+526311234567' });
    expect(after.body.ride.driver.vehicle.plate).toMatch(/^ABC-/);
  });
});

// ---------------------------------------------------------------- llegada, inicio y fin

describe('El conductor confirma llegada, inicio y fin', () => {
  let driver; let ride;

  beforeEach(async () => {
    driver = await trustedDriver();
    await api().put(url('/taxi/me/availability')).set(auth(driver.user)).send({ availability: 'available' });
    const fare = await api().post(url('/taxi-fares')).set(auth(manager))
      .send({ zone: 'Centro', amount: 120 });
    const created = await api().post(url('/taxi/rides')).set(auth(guest))
      .send({ fare_id: fare.body.fare.id });
    ride = created.body.ride;
    await api().post(url(`/taxi/rides/${ride.id}/accept`)).set(auth(driver.user)).send({ eta_minutes: 10 });
  });

  const step = (name, as = driver.user, body = {}) => api()
    .post(url(`/taxi/rides/${ride.id}/${name}`)).set(auth(as)).send(body);

  it('avisar que llegó le dice al cliente dónde esperar', async () => {
    const res = await api().post(url(`/taxi/rides/${ride.id}/arrived`)).set(auth(driver.user));
    expect(res.status).toBe(200);
    expect(res.body.ride.status).toBe('driver_arrived');

    const { rows } = await pool.query(
      `SELECT audience, payload FROM events WHERE type = 'taxi_driver_arrived'`);
    expect(rows).toHaveLength(1);
    expect(rows[0].audience.userIds).toEqual([guest.id]);
    expect(rows[0].payload.message).toContain('Salida principal');
  });

  it('no se puede saltar un paso del ciclo', async () => {
    // Iniciar sin haber llegado.
    expect((await api().post(url(`/taxi/rides/${ride.id}/start`)).set(auth(driver.user))).status).toBe(409);
    await api().post(url(`/taxi/rides/${ride.id}/arrived`)).set(auth(driver.user));
    // Llegar dos veces.
    expect((await api().post(url(`/taxi/rides/${ride.id}/arrived`)).set(auth(driver.user))).status).toBe(409);
    // Cerrar sin haber iniciado.
    const early = await api().post(url(`/taxi/rides/${ride.id}/finish`)).set(auth(driver.user))
      .send({ final_amount: 120, payment_method: 'cash' });
    expect(early.status).toBe(409);
  });

  it('iniciar el viaje emite la constancia con folio y vigencia', async () => {
    await api().post(url(`/taxi/rides/${ride.id}/arrived`)).set(auth(driver.user));
    const res = await api().post(url(`/taxi/rides/${ride.id}/start`)).set(auth(driver.user));
    expect(res.status).toBe(200);
    expect(res.body.ride.status).toBe('in_progress');
    expect(res.body.certificate.folio).toMatch(/^EV2-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(res.body.certificate.valid).toBe(true);
    expect(res.body.certificate.disclaimer).toMatch(/no.*efecto legal/i);

    const mine = await api().get(url(`/taxi/rides/${ride.id}/certificate`)).set(auth(guest));
    expect(mine.body.certificate.folio).toBe(res.body.certificate.folio);
    expect(mine.body.certificate.nightclub).toBe('EV2 Test');
    // Nombre corto: suficiente para identificar, no para perfilar.
    expect(mine.body.certificate.guest).toBe('guest T.');
  });

  it('cerrar en efectivo asienta el cobro y devuelve al conductor a la lista', async () => {
    await api().post(url(`/taxi/rides/${ride.id}/arrived`)).set(auth(driver.user));
    await api().post(url(`/taxi/rides/${ride.id}/start`)).set(auth(driver.user));
    const res = await api().post(url(`/taxi/rides/${ride.id}/finish`)).set(auth(driver.user))
      .send({ final_amount: 150, payment_method: 'cash' });
    expect(res.status).toBe(200);
    expect(res.body.ride).toMatchObject({
      status: 'completed', final_amount: '150.00', payment_method: 'cash', quoted_amount: '120.00',
    });

    const tx = await pool.query(
      `SELECT type, direction, amount::text, currency, status, provider, payer_user_id,
              payee_user_id, reference_type, reference_id, metadata
         FROM transactions WHERE reference_id = $1`, [ride.id]);
    expect(tx.rows).toHaveLength(1);
    expect(tx.rows[0]).toMatchObject({
      type: 'taxi_ride', direction: 'in', amount: '150.00', currency: 'MXN', status: 'paid',
      provider: 'cash', payer_user_id: guest.id, payee_user_id: driver.driver.user_id,
      reference_type: 'taxi_request', reference_id: ride.id,
    });
    // El dinero pasó de mano a mano: el club nunca lo tuvo, y el asiento lo dice.
    expect(tx.rows[0].metadata).toMatchObject({
      settled_directly_with_driver: true, quoted_amount: '120.00', club_commission_amount: '0.00',
    });

    const d = await pool.query('SELECT availability, at_venue FROM drivers WHERE id = $1',
      [driver.driver.id]);
    expect(d.rows[0]).toMatchObject({ availability: 'available', at_venue: false });
  });

  it('el asiento del viaje es inmutable como el resto del libro', async () => {
    await api().post(url(`/taxi/rides/${ride.id}/arrived`)).set(auth(driver.user));
    await api().post(url(`/taxi/rides/${ride.id}/start`)).set(auth(driver.user));
    await api().post(url(`/taxi/rides/${ride.id}/finish`)).set(auth(driver.user))
      .send({ final_amount: 150, payment_method: 'cash' });
    await expect(pool.query(`UPDATE transactions SET amount = 1 WHERE reference_id = $1`, [ride.id]))
      .rejects.toThrow(/immutable/i);
    await expect(pool.query(`DELETE FROM transactions WHERE reference_id = $1`, [ride.id]))
      .rejects.toThrow();
  });

  it('la tarjeta todavía no cobra y la cortesía no lleva monto', async () => {
    await api().post(url(`/taxi/rides/${ride.id}/arrived`)).set(auth(driver.user));
    await api().post(url(`/taxi/rides/${ride.id}/start`)).set(auth(driver.user));

    const card = await api().post(url(`/taxi/rides/${ride.id}/finish`)).set(auth(driver.user))
      .send({ final_amount: 150, payment_method: 'card' });
    expect(card.status).toBe(501);

    const badCourtesy = await api().post(url(`/taxi/rides/${ride.id}/finish`)).set(auth(driver.user))
      .send({ final_amount: 150, payment_method: 'courtesy' });
    expect(badCourtesy.status).toBe(422);

    const zeroCash = await api().post(url(`/taxi/rides/${ride.id}/finish`)).set(auth(driver.user))
      .send({ final_amount: 0, payment_method: 'cash' });
    expect(zeroCash.status).toBe(422);

    const courtesy = await api().post(url(`/taxi/rides/${ride.id}/finish`)).set(auth(driver.user))
      .send({ final_amount: 0, payment_method: 'courtesy' });
    expect(courtesy.status).toBe(200);
    const tx = await pool.query('SELECT count(*)::int AS n FROM transactions WHERE reference_id = $1',
      [ride.id]);
    expect(tx.rows[0].n).toBe(0);
  });

  it('otro conductor no puede mover mi viaje', async () => {
    const other = await trustedDriver();
    const res = await api().post(url(`/taxi/rides/${ride.id}/arrived`)).set(auth(other.user));
    expect(res.status).toBe(409);
    expect(step).toBeDefined();
  });

  it('el cobro del viaje no entra en la nómina: el conductor no es empleado', async () => {
    await api().post(url(`/taxi/rides/${ride.id}/arrived`)).set(auth(driver.user));
    await api().post(url(`/taxi/rides/${ride.id}/start`)).set(auth(driver.user));
    await api().post(url(`/taxi/rides/${ride.id}/finish`)).set(auth(driver.user))
      .send({ final_amount: 150, payment_method: 'cash' });
    const payroll = await api().get(url('/payroll')).set(auth(manager));
    expect(payroll.status).toBe(200);
    expect(payroll.body.rows.map((p) => p.user_id)).not.toContain(driver.driver.user_id);
  });
});

// ---------------------------------------------------------------- cancelar y calificar

describe('Cancelación y calificación', () => {
  let driver; let ride;

  beforeEach(async () => {
    driver = await trustedDriver();
    await api().put(url('/taxi/me/availability')).set(auth(driver.user)).send({ availability: 'available' });
    ride = (await api().post(url('/taxi/rides')).set(auth(guest)).send({})).body.ride;
  });

  it('el cliente cancela y el conductor vuelve a estar disponible', async () => {
    await api().post(url(`/taxi/rides/${ride.id}/accept`)).set(auth(driver.user)).send({ eta_minutes: 10 });
    const res = await api().post(url(`/taxi/rides/${ride.id}/cancel`)).set(auth(guest))
      .send({ reason: 'Me fui con un amigo' });
    expect(res.status).toBe(200);
    expect(res.body.ride).toMatchObject({ status: 'cancelled', cancel_reason: 'Me fui con un amigo' });
    const d = await pool.query('SELECT availability FROM drivers WHERE id = $1', [driver.driver.id]);
    expect(d.rows[0].availability).toBe('available');
    // Cancelado deja de ser un viaje vivo: se puede pedir otro.
    expect((await api().post(url('/taxi/rides')).set(auth(guest)).send({})).status).toBe(201);
  });

  it('un viaje ya iniciado no se cancela y el conductor tampoco cancela', async () => {
    await api().post(url(`/taxi/rides/${ride.id}/accept`)).set(auth(driver.user)).send({ eta_minutes: 5 });
    expect((await api().post(url(`/taxi/rides/${ride.id}/cancel`)).set(auth(driver.user)).send({})).status)
      .toBe(403);
    await api().post(url(`/taxi/rides/${ride.id}/arrived`)).set(auth(driver.user));
    await api().post(url(`/taxi/rides/${ride.id}/start`)).set(auth(driver.user));
    const res = await api().post(url(`/taxi/rides/${ride.id}/cancel`)).set(auth(guest)).send({});
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/ya comenzó/i);
  });

  it('solo se califica un viaje terminado, una sola vez y por quien viajó', async () => {
    await api().post(url(`/taxi/rides/${ride.id}/accept`)).set(auth(driver.user)).send({ eta_minutes: 5 });
    const early = await api().post(url(`/taxi/rides/${ride.id}/rate`)).set(auth(guest)).send({ rating: 5 });
    expect(early.status).toBe(409);

    await api().post(url(`/taxi/rides/${ride.id}/arrived`)).set(auth(driver.user));
    await api().post(url(`/taxi/rides/${ride.id}/start`)).set(auth(driver.user));
    await api().post(url(`/taxi/rides/${ride.id}/finish`)).set(auth(driver.user))
      .send({ final_amount: 100, payment_method: 'cash' });

    const ok = await api().post(url(`/taxi/rides/${ride.id}/rate`)).set(auth(guest))
      .send({ rating: 5, comment: 'Puntual' });
    expect(ok.status).toBe(200);
    expect((await api().post(url(`/taxi/rides/${ride.id}/rate`)).set(auth(guest)).send({ rating: 1 })).status)
      .toBe(409);

    const stranger = await f.createUser(club.id, { role: 'guest' });
    expect((await api().get(url(`/taxi/rides/${ride.id}`)).set(auth(stranger))).status).toBe(404);
  });
});

// ---------------------------------------------------------------- constancia pública

describe('Verificación pública de la constancia', () => {
  let driver; let ride; let folio;

  beforeEach(async () => {
    driver = await trustedDriver();
    await api().put(url('/taxi/me/availability')).set(auth(driver.user)).send({ availability: 'available' });
    ride = (await api().post(url('/taxi/rides')).set(auth(guest)).send({ destination: 'Calle Obregón 45' })).body.ride;
    await api().post(url(`/taxi/rides/${ride.id}/accept`)).set(auth(driver.user)).send({ eta_minutes: 5 });
    await api().post(url(`/taxi/rides/${ride.id}/arrived`)).set(auth(driver.user));
    const started = await api().post(url(`/taxi/rides/${ride.id}/start`)).set(auth(driver.user));
    folio = started.body.certificate.folio;
  });

  it('cualquiera con el folio verifica lo mínimo, sin sesión', async () => {
    const res = await api().get(`/api/taxi/verify/${folio}`);
    expect(res.status).toBe(200);
    const c = res.body.certificate;
    expect(c).toMatchObject({ folio, nightclub: 'EV2 Test', valid: true, guest: 'guest T.', driver: 'Raúl' });
    expect(c.vehicle.plate).toMatch(/^ABC-/);
    // Lo que la constancia NO dice.
    expect(JSON.stringify(c)).not.toContain('Obregón');
    expect(JSON.stringify(c)).not.toContain('+526311234567');
    expect(c).not.toHaveProperty('final_amount');
    expect(c).not.toHaveProperty('destination');
  });

  it('el folio no distingue mayúsculas y uno inexistente responde 404', async () => {
    expect((await api().get(`/api/taxi/verify/${folio.toLowerCase()}`)).status).toBe(200);
    const missing = await api().get('/api/taxi/verify/EV2-ZZZZ-ZZZZ');
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('not_found');
  });

  it('una constancia vencida se reporta como no vigente, no desaparece', async () => {
    await pool.query(`UPDATE taxi_requests SET code_expires_at = now() - interval '1 minute' WHERE id = $1`,
      [ride.id]);
    const res = await api().get(`/api/taxi/verify/${folio}`);
    expect(res.status).toBe(200);
    expect(res.body.certificate.valid).toBe(false);
  });

  it('la constancia no existe antes de que el viaje empiece', async () => {
    const other = await f.createUser(club.id, { role: 'guest' });
    const fresh = (await api().post(url('/taxi/rides')).set(auth(other)).send({})).body.ride;
    const res = await api().get(url(`/taxi/rides/${fresh.id}/certificate`)).set(auth(other));
    expect(res.status).toBe(409);
  });
});

// ---------------------------------------------------------------- tablero del gerente

describe('Tablero y números del gerente', () => {
  let driver;

  beforeEach(async () => {
    driver = await trustedDriver();
    await api().put(url('/taxi/me/availability')).set(auth(driver.user)).send({ availability: 'available' });
  });

  /** Runs one full ride for `who` and returns it completed. */
  async function fullRide(who, amount = 120) {
    const ride = (await api().post(url('/taxi/rides')).set(auth(who)).send({})).body.ride;
    await api().post(url(`/taxi/rides/${ride.id}/accept`)).set(auth(driver.user)).send({ eta_minutes: 10 });
    await pool.query(`UPDATE taxi_requests SET accepted_at = now() - interval '9 minutes' WHERE id = $1`,
      [ride.id]);
    await api().post(url(`/taxi/rides/${ride.id}/arrived`)).set(auth(driver.user));
    await api().post(url(`/taxi/rides/${ride.id}/start`)).set(auth(driver.user));
    await api().post(url(`/taxi/rides/${ride.id}/finish`)).set(auth(driver.user))
      .send({ final_amount: amount, payment_method: 'cash' });
    return ride;
  }

  it('el tablero filtra por viaje vivo y por conductor', async () => {
    await fullRide(guest, 120);
    const other = await f.createUser(club.id, { role: 'guest' });
    const live = (await api().post(url('/taxi/rides')).set(auth(other)).send({})).body.ride;

    const all = await api().get(url('/taxi/rides')).set(auth(manager));
    expect(all.body.rides).toHaveLength(2);
    // El gerente sí necesita el teléfono del pasajero para localizarlo.
    expect(all.body.rides[0].guest).toHaveProperty('phone');

    const onlyLive = await api().get(url('/taxi/rides?live=true')).set(auth(manager));
    expect(onlyLive.body.rides.map((r) => r.id)).toEqual([live.id]);

    const byDriver = await api().get(url(`/taxi/rides?driver_id=${driver.driver.id}`)).set(auth(manager));
    expect(byDriver.body.rides).toHaveLength(1);
  });

  it('las estadísticas suman lo cobrado y el promedio real de recogida', async () => {
    await fullRide(guest, 120);
    const other = await f.createUser(club.id, { role: 'guest' });
    await fullRide(other, 180);

    const res = await api().get(url('/taxi/stats')).set(auth(manager));
    expect(res.status).toBe(200);
    expect(res.body.totals).toMatchObject({
      rides: 2, completed: 2, paid_cash: 2, charged: '300.00', avg_pickup_minutes: 9,
    });
    expect(res.body.drivers[0]).toMatchObject({
      driver_id: driver.driver.id, rides: 2, charged: '300.00', avg_pickup_minutes: 9,
    });
  });

  it('las solicitudes que nadie tomó se cierran como sin conductor', async () => {
    const ride = (await api().post(url('/taxi/rides')).set(auth(guest)).send({})).body.ride;
    // Todavía dentro del plazo: no se cierra nada.
    expect((await api().post(url('/taxi/rides/expire')).set(auth(manager))).body.expired).toBe(0);

    await pool.query(`UPDATE taxi_requests SET created_at = now() - interval '30 minutes' WHERE id = $1`,
      [ride.id]);
    const res = await api().post(url('/taxi/rides/expire')).set(auth(manager));
    expect(res.body.expired).toBe(1);
    // Idempotente.
    expect((await api().post(url('/taxi/rides/expire')).set(auth(manager))).body.expired).toBe(0);

    const after = await api().get(url(`/taxi/rides/${ride.id}`)).set(auth(guest));
    expect(after.body.ride.status).toBe('no_driver');
    // Cerrada la anterior, el cliente puede volver a pedir.
    expect((await api().post(url('/taxi/rides')).set(auth(guest)).send({})).status).toBe(201);
  });

  it('un cliente no ve el tablero ni las estadísticas', async () => {
    expect((await api().get(url('/taxi/rides')).set(auth(guest))).status).toBe(403);
    expect((await api().get(url('/taxi/stats')).set(auth(guest))).status).toBe(403);
  });
});
