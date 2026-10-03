/**
 * Borrar la cuenta de un cliente (D68).
 *
 * ---------------------------------------------------------------------------
 * Lo que de verdad se está probando
 * ---------------------------------------------------------------------------
 * Un borrado se juzga por dos cosas opuestas, y las dos se pueden fallar:
 *
 *   1. Que de verdad borre. No sirve de nada marcar la cuenta como borrada si el
 *      nombre, el teléfono o el destino del taxi siguen ahí. Estas pruebas van a leer
 *      la base DIRECTAMENTE después del borrado, no la respuesta de la API: la API
 *      puede estar escondiendo lo que la base todavía guarda.
 *   2. Que no se lleve por delante lo que no es suyo. La contabilidad de noches
 *      cerradas y los reportes que otras personas levantaron en su contra.
 *
 * Y una tercera que no es de privacidad sino de operación: que nadie se borre con el
 * coche en el valet, porque el sistema dejaría de saber de quién es ese auto.
 */
'use strict';

const { setupSchema, truncateAll, closePool, pool } = require('./helpers/db');
const { api, auth } = require('./helpers/api');
const f = require('./helpers/factories');
const del = require('../src/services/account-deletion');

let club; let ana; let beto; let mesero;

beforeAll(setupSchema);
afterAll(closePool);

beforeEach(async () => {
  await truncateAll();
  club = await f.createNightclub({ slug: 'ev2-borrado' });
  ana = await f.createUser(club.id, {
    role: 'guest', display_name: 'Ana', email: 'ana@ejemplo.com',
  });
  beto = await f.createUser(club.id, { role: 'guest', display_name: 'Beto' });
  mesero = await f.createUser(club.id, { role: 'waiter', display_name: 'Luis' });
});

const borrar = (quien, confirm = 'BORRAR') => api().delete('/api/auth/me')
  .set(auth(quien)).send({ confirm });

const estado = (quien) => api().get('/api/auth/me/deletion').set(auth(quien));

/** La fila cruda, sin pasar por ninguna vista de la API. */
const filaDe = async (id) => (await pool.query(
  'SELECT * FROM users WHERE id = $1', [id])).rows[0];

// ============================================================================

describe('Qué impide borrarse', () => {
  it('una cuenta de cliente limpia se puede borrar', async () => {
    const res = await estado(ana);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, blockers: [] });
  });

  it('el personal no se borra solo: su cuenta bancaria y sus propinas tienen dueño fiscal', async () => {
    const res = await estado(mesero);
    expect(res.body.ok).toBe(false);
    expect(res.body.blockers.map((b) => b.reason)).toContain('is_staff');

    const intento = await borrar(mesero);
    expect(intento.status).toBe(409);
    expect(await filaDe(mesero.id)).toMatchObject({ status: 'active' });
  });

  it('con un cobro sin pagar, no', async () => {
    await pool.query(
      `INSERT INTO transactions (nightclub_id, type, direction, amount, currency, status,
                                 payer_user_id, provider)
       VALUES ($1,'drink_order','in',250,'MXN','pending',$2,'manual')`,
      [club.id, ana.id]);
    const res = await estado(ana);
    expect(res.body.blockers.map((b) => b.reason)).toContain('unpaid');
    expect((await borrar(ana)).status).toBe(409);
  });

  it('con un pedido en curso, no', async () => {
    await pool.query(
      `INSERT INTO drink_orders (nightclub_id, sender_id, status, subtotal, client_request_id)
       VALUES ($1,$2,'preparing',180,gen_random_uuid())`, [club.id, ana.id]);
    expect((await estado(ana)).body.blockers.map((b) => b.reason)).toContain('open_order');
  });

  it('un pedido ya entregado no estorba: la noche terminó', async () => {
    await pool.query(
      `INSERT INTO drink_orders (nightclub_id, sender_id, status, subtotal, client_request_id,
                                 delivered_at)
       VALUES ($1,$2,'delivered',180,gen_random_uuid(),now())`, [club.id, ana.id]);
    expect((await estado(ana)).body.ok).toBe(true);
  });

  it('con el coche en el valet, no — el sistema dejaría de saber de quién es', async () => {
    await pool.query(
      `INSERT INTO valet_tickets (nightclub_id, code, user_id, plate, phone, status, qr_token)
       VALUES ($1,'V-01',$2,'ABC-123','6621234567','parked','tok-'||gen_random_uuid())`, [club.id, ana.id]);
    const res = await estado(ana);
    expect(res.body.blockers.map((b) => b.reason)).toContain('valet_open');
    expect((await borrar(ana)).status).toBe(409);
  });

  it('entregado el coche, ya se puede', async () => {
    await pool.query(
      `INSERT INTO valet_tickets (nightclub_id, code, user_id, plate, status, delivered_at, qr_token)
       VALUES ($1,'V-02',$2,'ABC-123','delivered',now(),'tok-'||gen_random_uuid())`, [club.id, ana.id]);
    expect((await estado(ana)).body.ok).toBe(true);
  });

  it('los motivos vienen TODOS juntos, no de uno en uno', async () => {
    // Quien tiene el coche adentro y además debe la cuenta no merece enterarse en dos
    // viajes: la pantalla enseña las dos cosas y resuelve las dos.
    await pool.query(
      `INSERT INTO valet_tickets (nightclub_id, code, user_id, plate, status, qr_token)
       VALUES ($1,'V-03',$2,'ABC-123','parked','tok-'||gen_random_uuid())`, [club.id, ana.id]);
    await pool.query(
      `INSERT INTO transactions (nightclub_id, type, direction, amount, currency, status,
                                 payer_user_id, provider)
       VALUES ($1,'drink_order','in',250,'MXN','pending_manual',$2,'manual')`,
      [club.id, ana.id]);
    const motivos = (await estado(ana)).body.blockers.map((b) => b.reason).sort();
    expect(motivos).toEqual(['unpaid', 'valet_open']);
  });
});

describe('La confirmación escrita', () => {
  it('sin la palabra no se borra nada', async () => {
    const res = await borrar(ana, 'si');
    expect(res.status).toBe(400);
    expect(await filaDe(ana.id)).toMatchObject({ status: 'active', email: 'ana@ejemplo.com' });
  });

  it('acepta minúsculas y espacios: el teclado del teléfono no decide esto', async () => {
    expect((await borrar(ana, '  borrar ')).status).toBe(200);
  });

  it('un cuerpo vacío es un 400, no un borrado', async () => {
    const res = await api().delete('/api/auth/me').set(auth(ana)).send({});
    expect(res.status).toBe(400);
    expect(await filaDe(ana.id)).toMatchObject({ status: 'active' });
  });

  it('sin sesión, 401', async () => {
    expect((await api().delete('/api/auth/me').send({ confirm: 'BORRAR' })).status).toBe(401);
  });
});

describe('Lo que se borra de verdad', () => {
  it('el nombre, el correo, el teléfono y la fecha de nacimiento dejan de estar', async () => {
    await pool.query('UPDATE users SET phone = $2 WHERE id = $1', [ana.id, '6621234567']);

    const res = await borrar(ana);
    expect(res.status).toBe(200);
    expect(res.body.deleted_at).toBeTruthy();

    // Se lee la BASE, no la respuesta: la API puede estar escondiendo lo que sigue ahí.
    const fila = await filaDe(ana.id);
    expect(fila.status).toBe('deleted');
    expect(fila.email).toBe(`${ana.id}@borrada.invalid`);
    expect(fila.phone).toBeNull();
    expect(fila.password_hash).toBeNull();
    expect(fila.display_name).toBeNull();
    expect(fila.first_name).toBe(del.DELETED_NAME);
    expect(fila.last_name).toBe('');
    expect(String(fila.birth_date.toISOString()).slice(0, 4)).toBe('1900');
    expect(fila.age_verified).toBe(false);
  });

  it('el correo real queda libre: alguien puede volver a registrarse con él', async () => {
    await borrar(ana);
    const res = await api().post('/api/auth/register').send({
      nightclub_slug: 'ev2-borrado',
      email: 'ana@ejemplo.com',
      password: 'OtraPassword123',
      first_name: 'Ana',
      birth_date: '1995-05-05',
      accept_terms: true,
    });
    expect([200, 201]).toContain(res.status);
  });

  it('las sesiones abiertas mueren en el acto', async () => {
    const login = await api().post('/api/auth/login').send({
      nightclub_slug: 'ev2-borrado', email: 'ana@ejemplo.com', password: f.PASSWORD,
    });
    expect(login.status).toBe(200);
    const refresh = login.body.refresh_token;

    await borrar(ana);

    expect((await pool.query(
      'SELECT count(*)::int AS n FROM refresh_tokens WHERE user_id = $1 AND revoked_at IS NULL',
      [ana.id])).rows[0].n).toBe(0);
    expect((await api().post('/api/auth/refresh').send({ refresh_token: refresh })).status)
      .toBe(401);
  });

  it('la cuenta de Facebook queda desligada — es lo que Meta exige', async () => {
    await pool.query(
      `INSERT INTO user_identities (user_id, provider, provider_user_id, email, display_name)
       VALUES ($1,'facebook','fb-9999','ana@ejemplo.com','Ana')`, [ana.id]);
    await borrar(ana);
    expect((await pool.query(
      'SELECT count(*)::int AS n FROM user_identities WHERE user_id = $1', [ana.id]))
      .rows[0].n).toBe(0);
  });

  it('el destino del taxi se va: es la casa de alguien', async () => {
    await pool.query(
      `INSERT INTO taxi_requests (nightclub_id, user_id, pickup_location, destination, status)
       VALUES ($1,$2,'Puerta principal','Calle Obregon 145, col. Centro','completed')`,
      [club.id, ana.id]);
    await borrar(ana);
    const t = (await pool.query(
      'SELECT pickup_location, destination FROM taxi_requests WHERE user_id = $1', [ana.id]))
      .rows[0];
    expect(t.destination).toBeNull();
    expect(t.pickup_location).toBeNull();
  });

  it('el teléfono que dejó en el valet se va, y el registro del coche se queda', async () => {
    await pool.query(
      `INSERT INTO valet_tickets (nightclub_id, code, user_id, plate, phone, status, delivered_at, qr_token)
       VALUES ($1,'V-09',$2,'XYZ-987','6621234567','delivered',now(),'tok-'||gen_random_uuid())`, [club.id, ana.id]);
    await borrar(ana);
    const v = (await pool.query(
      'SELECT plate, phone FROM valet_tickets WHERE user_id = $1', [ana.id])).rows[0];
    expect(v.phone).toBeNull();
    expect(v.plate).toBe('XYZ-987'); // el turno de esa noche ya se cerró con ese dato
  });

  it('los mensajes de flirt se van por los dos lados', async () => {
    await pool.query(
      `INSERT INTO flirts (nightclub_id, sender_id, recipient_id, type, emoji, message)
       VALUES ($1,$2,$3,'emoji','wink','hola'), ($1,$3,$2,'emoji','wink','que tal')`,
      [club.id, ana.id, beto.id]);
    await borrar(ana);
    expect((await pool.query(
      'SELECT count(*)::int AS n FROM flirts WHERE sender_id = $1 OR recipient_id = $1',
      [ana.id])).rows[0].n).toBe(0);
  });

  it('las tarjetas guardadas se van', async () => {
    await pool.query(
      `INSERT INTO payment_methods (user_id, provider, type, last4, brand)
       VALUES ($1,'mercadopago','card','4242','visa')`, [ana.id]);
    await borrar(ana);
    expect((await pool.query(
      'SELECT count(*)::int AS n FROM payment_methods WHERE user_id = $1', [ana.id]))
      .rows[0].n).toBe(0);
  });

  it('las señas que escribió en un objeto perdido dejan de tener nombre y teléfono', async () => {
    await pool.query(
      `INSERT INTO lost_items (nightclub_id, kind, category, details, reported_by,
                               reporter_name, reporter_phone)
       VALUES ($1,'lost','phone','iPhone negro',$2,'Ana','6621234567')`, [club.id, ana.id]);
    await borrar(ana);
    const li = (await pool.query(
      'SELECT reporter_name, reporter_phone FROM lost_items WHERE reported_by = $1', [ana.id]))
      .rows[0];
    expect(li.reporter_name).toBeNull();
    expect(li.reporter_phone).toBeNull();
  });
});

describe('Lo que NO se lleva por delante', () => {
  it('el libro contable se queda, sin dueño identificable', async () => {
    await pool.query(
      `INSERT INTO transactions (nightclub_id, type, direction, amount, currency, status,
                                 payer_user_id, provider)
       VALUES ($1,'drink_order','in',420,'MXN','paid',$2,'manual')`, [club.id, ana.id]);

    await borrar(ana);

    const t = (await pool.query(
      'SELECT amount::float8 AS amount, payer_user_id FROM transactions WHERE payer_user_id = $1',
      [ana.id])).rows;
    expect(t).toHaveLength(1);
    expect(t[0].amount).toBe(420);
    // Sigue apuntando a la fila, pero esa fila ya no dice quién era.
    expect((await filaDe(ana.id)).first_name).toBe(del.DELETED_NAME);
  });

  it('un reporte EN SU CONTRA sobrevive: borrarse no puede ser estrenar expediente', async () => {
    await pool.query(
      `INSERT INTO user_reports (nightclub_id, reporter_id, reported_id, reason, details)
       VALUES ($1,$2,$3,'harassment','No dejaba de insistir')`, [club.id, beto.id, ana.id]);
    await borrar(ana);
    expect((await pool.query(
      'SELECT count(*)::int AS n FROM user_reports WHERE reported_id = $1', [ana.id]))
      .rows[0].n).toBe(1);
  });

  it('un bloqueo que OTRO le puso se queda; el que puso ella se va', async () => {
    await pool.query(
      `INSERT INTO user_blocks (blocker_id, blocked_id) VALUES ($1,$2), ($2,$1)`,
      [ana.id, beto.id]);
    await borrar(ana);
    expect((await pool.query(
      'SELECT count(*)::int AS n FROM user_blocks WHERE blocker_id = $1', [ana.id]))
      .rows[0].n).toBe(0);
    expect((await pool.query(
      'SELECT count(*)::int AS n FROM user_blocks WHERE blocked_id = $1', [ana.id]))
      .rows[0].n).toBe(1);
  });
});

describe('Una cuenta borrada no revive', () => {
  it('no se puede entrar con ella', async () => {
    await borrar(ana);
    const res = await api().post('/api/auth/login').send({
      nightclub_slug: 'ev2-borrado', email: `${ana.id}@borrada.invalid`, password: f.PASSWORD,
    });
    expect([401, 403]).toContain(res.status);
  });

  it('el token que ya tenía deja de servir', async () => {
    await borrar(ana);
    expect((await api().get('/api/auth/me').set(auth(ana))).status).toBe(403);
  });

  it('ni con un UPDATE a mano en la base: el trigger lo impide', async () => {
    await borrar(ana);
    await expect(pool.query(
      "UPDATE users SET status = 'active', email = 'ana@ejemplo.com' WHERE id = $1", [ana.id]))
      .rejects.toThrow(/una cuenta borrada no se modifica/);
  });

  it('borrarse dos veces no escribe dos constancias', async () => {
    await borrar(ana);
    const segundo = await api().delete('/api/auth/me').set(auth(ana)).send({ confirm: 'BORRAR' });
    expect([401, 403]).toContain(segundo.status); // ya no hay sesión válida
    expect((await pool.query(
      'SELECT count(*)::int AS n FROM account_deletions WHERE user_id = $1', [ana.id]))
      .rows[0].n).toBe(1);
  });
});

describe('La constancia', () => {
  it('deja fecha y quién lo pidió, y ni un dato personal', async () => {
    await pool.query('UPDATE users SET phone = $2 WHERE id = $1', [ana.id, '6621234567']);
    await borrar(ana);
    const c = (await pool.query(
      'SELECT * FROM account_deletions WHERE user_id = $1', [ana.id])).rows[0];
    expect(c.requested_by).toBe('self');
    expect(c.created_at).toBeTruthy();
    // Nada de la persona: solo conteos por tabla.
    const texto = JSON.stringify(c);
    expect(texto).not.toMatch(/ana@ejemplo\.com/);
    expect(texto).not.toMatch(/6621234567/);
    expect(texto).not.toMatch(/Ana/);
  });

  it('no se puede editar ni borrar', async () => {
    await borrar(ana);
    await expect(pool.query(
      "UPDATE account_deletions SET requested_by = 'manager' WHERE user_id = $1", [ana.id]))
      .rejects.toThrow(/no se modifica/);
    await expect(pool.query(
      'DELETE FROM account_deletions WHERE user_id = $1', [ana.id]))
      .rejects.toThrow(/no se modifica/);
  });
});

describe('El inventario de tablas no se queda atrás', () => {
  it('toda tabla con un dato personal del cliente está en la lista de limpieza', async () => {
    // Esta prueba es un despertador, no una verificación: si alguien agrega una tabla
    // con `phone`, `destination` o `reporter_name` y no la agrega a LIMPIEZAS, el
    // borrado dejaría ese dato vivo y nadie se enteraría hasta que alguien pregunte.
    const { rows } = await pool.query(
      `SELECT DISTINCT c.table_name
         FROM information_schema.columns c
        WHERE c.table_schema = 'public'
          AND c.column_name IN ('phone', 'destination', 'reporter_phone', 'reporter_name')
          -- Fuera: las que guardan datos del NEGOCIO o del personal, no del cliente.
          -- El telefono del club, el de un proveedor o el de un empleado no se van
          -- porque un cliente se borre.
          AND c.table_name NOT IN ('users', 'drivers', 'emergency_contacts',
                                   'employee_profiles', 'suppliers', 'nightclubs',
                                   'manual_payment_options')`);
    const conocidas = new Set(del.TABLAS_LIMPIADAS);
    const olvidadas = rows.map((r) => r.table_name).filter((t) => !conocidas.has(t));
    expect(olvidadas).toEqual([]);
  });
});
