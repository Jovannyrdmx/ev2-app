/**
 * La puerta, de punta a punta.
 *
 * Lo que se prueba aquí es lo que la fila de la entrada no perdona: que escanear
 * un pase deje al cliente REALMENTE sentado —pudiendo pedir desde su teléfono, no
 * solo con la mesa pintada de ocupada—, que el mismo QR reenviado no meta a dos
 * personas, y que cada peso cobrado en la puerta caiga en el libro.
 *
 * A partir de la migración 019 el escaneo exige una revisión de identificación
 * previa, así que casi todo pasa por `entrar()`: registrar la INE y luego
 * escanear, en ese orden, que es el orden que el backend obliga.
 */
'use strict';

const { setupSchema, truncateAll, closePool, pool } = require('./helpers/db');
const { api, auth } = require('./helpers/api');
const f = require('./helpers/factories');
const { loadPriceList } = require('../seeds/price-list');
const guestPasses = require('../src/services/guest-passes');

let club; let guest; let hostess; let manager; let waiter; let mesa;

beforeAll(setupSchema);
afterAll(closePool);

beforeEach(async () => {
  await truncateAll();
  club = await f.createNightclub({ slug: 'ev2' });
  guest = await f.createUser(club.id, { role: 'guest' });
  hostess = await f.createUser(club.id, { role: 'hostess' });
  manager = await f.createUser(club.id, { role: 'manager' });
  waiter = await f.createUser(club.id, { role: 'waiter' });
  await loadPriceList({ slug: 'ev2' });
  mesa = await f.createTable(club.id, { code: '39', section: 'ZONA ROJA', capacity: 8, type: 'booth' });
});

const url = (p) => `/api/nightclubs/${club.id}${p}`;

/**
 * Una reservación viva esta noche, con sus pases, escrita directo para no
 * depender del flujo de cobro. `pass_code` es el del titular, que es el mismo
 * código de la reservación.
 */
async function reservar(over = {}) {
  const starts = over.starts_at || new Date(Date.now() + 30 * 60_000);
  const nightclubId = over.nightclub_id || club.id;
  const { rows } = await pool.query(
    `INSERT INTO reservations (nightclub_id, user_id, table_id, starts_at, duration_minutes,
                               guest_count, status, currency, pass_code)
     VALUES ($1,$2,$3,$4,240,$5,$6,'MXN',$7)
     RETURNING id, nightclub_id, pass_code, status, guest_count`,
    [nightclubId, over.user_id || guest.id, over.table_id || mesa.id, starts,
      over.guest_count || 8, over.status || 'confirmed',
      over.pass_code || require('../src/services/door').generatePassCode()],
  );
  await guestPasses.issueForReservation(pool, { reservation: rows[0] });
  return rows[0];
}

/** Los pases de una reservación, en el orden en que se emitieron. */
async function pasesDe(reservationId) {
  const { rows } = await pool.query(
    `SELECT id, code, kind, status FROM guest_passes
      WHERE reservation_id = $1 ORDER BY kind DESC, created_at`,
    [reservationId]);
  return rows;
}

/** La revisión de identificación: lo que va ANTES del escaneo. */
async function revisarIne(staff, over = {}) {
  const res = await api().post(url('/door/id-checks')).set(auth(staff)).send({
    document: 'ine', adult: true, decision: 'accepted', ...over,
  });
  return res;
}

/** Revisar la INE y escanear, en ese orden. Es el camino normal de la puerta. */
async function entrar(code, staff = null) {
  const quien = staff || hostess;
  const rev = await revisarIne(quien);
  return api().post(url('/door/check-in')).set(auth(quien))
    .send({ code, id_check_id: rev.body.id_check.id });
}

const sentado = async (userId) => {
  const { rows } = await pool.query(
    'SELECT table_id FROM table_occupants WHERE user_id = $1 AND left_at IS NULL', [userId]);
  return rows[0] || null;
};

// ---------------------------------------------------------------- escanear

describe('escanear el pase', () => {
  it('sienta DE VERDAD: el cliente queda en la mesa, no solo la mesa pintada', async () => {
    // Este es el fallo que originó todo el cambio: antes "Llegó" ponía la mesa en
    // ocupada y no metía a nadie, así que el cliente no podía pedir un trago.
    const r = await reservar();
    const res = await entrar(r.pass_code);

    expect(res.status).toBe(200);
    expect(res.body.seated).toBe(true);
    expect(res.body.pass.result).toBe('ok');

    const ocupacion = await sentado(guest.id);
    expect(ocupacion).not.toBeNull();
    expect(ocupacion.table_id).toBe(mesa.id);

    const { rows } = await pool.query('SELECT status FROM tables WHERE id = $1', [mesa.id]);
    expect(rows[0].status).toBe('occupied');
  });

  it('deja escrito quién y cuándo dejó entrar', async () => {
    const r = await reservar();
    await entrar(r.pass_code);
    const { rows } = await pool.query(
      'SELECT status, checked_in_at, checked_in_by FROM reservations WHERE id = $1', [r.id]);
    expect(rows[0].status).toBe('seated');
    expect(rows[0].checked_in_at).toBeInstanceOf(Date);
    expect(rows[0].checked_in_by).toBe(hostess.id);
  });

  it('el mismo pase no abre dos veces', async () => {
    // Un QR reenviado por WhatsApp no puede meter a dos personas con un pase.
    const r = await reservar();
    await entrar(r.pass_code);
    const segunda = await entrar(r.pass_code);
    expect(segunda.status).toBe(200);
    expect(segunda.body.pass.result).toBe('used');
    expect(segunda.body.admitted).toBeUndefined();
  });

  it('pero los OTROS pases de la mesa sí abren: eso es el punto de emitir uno por persona', async () => {
    // El fallo que originó la migración 019: ocho personas con un solo código, y
    // el primero que llegaba lo gastaba.
    const r = await reservar({ guest_count: 3 });
    const pases = await pasesDe(r.id);
    expect(pases).toHaveLength(3);

    for (const p of pases) {
      const res = await entrar(p.code);
      expect(res.body.admitted).toBe(true);
    }
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM guest_passes WHERE reservation_id = $1 AND status = 'used'`,
      [r.id]);
    expect(rows[0].n).toBe(3);
  });

  it('acepta el código tecleado con espacios y en minúsculas', async () => {
    const r = await reservar();
    const tecleado = r.pass_code.toLowerCase().replace(/-/g, ' ');
    const res = await entrar(tecleado);
    expect(res.body.seated).toBe(true);
  });

  it('acepta el payload firmado que trae el QR', async () => {
    const r = await reservar();
    const res = await entrar(guestPasses.payload(r.pass_code));
    expect(res.body.seated).toBe(true);
  });

  it('acepta el enlace de WhatsApp escaneado con la cámara del teléfono', async () => {
    const r = await reservar();
    const enlace = guestPasses.shareLink('https://ev2clandestinoz.com', r.pass_code);
    const res = await entrar(enlace);
    expect(res.body.seated).toBe(true);
  });

  it('un QR con la firma cambiada NO abre: es un código fabricado', async () => {
    const r = await reservar();
    const falso = `EV2P.${r.pass_code}.AAAAAAAAAA`;
    const res = await entrar(falso);
    expect(res.status).toBe(200);
    expect(res.body.result).toBe('forged');
    expect(await sentado(guest.id)).toBeNull();
  });

  it('un código inventado contesta 200 con el motivo, no un error que detiene la fila', async () => {
    const res = await entrar('EV2-ZZZZ-ZZZZ');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.result).toBe('not_found');
  });

  it('una reservación sin pagar se distingue de una cancelada', async () => {
    const r = await reservar({ status: 'pending_payment' });
    const res = await entrar(r.pass_code);
    expect(res.body.pass.result).toBe('unpaid');
    expect(await sentado(guest.id)).toBeNull();
  });

  it('la de mañana no abre hoy, y nadie queda sentado', async () => {
    const r = await reservar({ starts_at: new Date(Date.now() + 30 * 3_600_000) });
    const res = await entrar(r.pass_code);
    expect(res.body.pass.result).toBe('not_tonight');
    expect(await sentado(guest.id)).toBeNull();
  });

  it('el pase de otro club no abre en este', async () => {
    const otro = await f.createNightclub({ slug: 'otro' });
    const suGuest = await f.createUser(otro.id, { role: 'guest' });
    const suMesa = await f.createTable(otro.id, { code: 'X1', section: 'GENERAL', capacity: 4 });
    const ajena = await reservar({
      nightclub_id: otro.id, user_id: suGuest.id, table_id: suMesa.id,
    });

    const res = await entrar(ajena.pass_code);
    expect(res.body.result).toBe('not_found');
  });

  it('un cliente no puede escanear pases', async () => {
    const r = await reservar();
    const res = await api().post(url('/door/check-in')).set(auth(guest))
      .send({ code: r.pass_code, id_check_id: r.id });
    expect(res.status).toBe(403);
  });

  it('ni registrar una revisión de identificación', async () => {
    const res = await revisarIne(guest);
    expect(res.status).toBe(403);
  });

  it('mirar un pase no lo gasta', async () => {
    const r = await reservar();
    const mirada = await api().get(url(`/door/pass/${r.pass_code}`)).set(auth(hostess));
    expect(mirada.body.pass.ok).toBe(true);
    expect(await sentado(guest.id)).toBeNull();
  });
});

// ---------------------------------------------------------------- sentarse solo, ya no

describe('el cliente ya no se sienta solo', () => {
  it('un cliente no puede sentarse tocando el mapa', async () => {
    const res = await api().post(url(`/tables/${mesa.id}/seat`)).set(auth(guest))
      .send({ user_id: guest.id });
    expect(res.status).toBe(403);
    expect(await sentado(guest.id)).toBeNull();
  });

  it('el personal sí puede sentar a alguien a mano', async () => {
    const res = await api().post(url(`/tables/${mesa.id}/seat`)).set(auth(hostess))
      .send({ user_id: guest.id });
    expect(res.status).toBe(201);
    expect((await sentado(guest.id)).table_id).toBe(mesa.id);
  });

  it('y levantarlo', async () => {
    await api().post(url(`/tables/${mesa.id}/seat`)).set(auth(hostess)).send({ user_id: guest.id });
    const res = await api().post(url(`/tables/${mesa.id}/release`)).set(auth(waiter))
      .send({ user_id: guest.id });
    expect(res.status).toBe(200);
    expect(await sentado(guest.id)).toBeNull();
  });
});

// ---------------------------------------------------------------- cerrar la mesa

describe('cerrar la reservación', () => {
  it('al terminar, la mesa se vacía: si no, sigue recibiendo pedidos de quien ya se fue', async () => {
    const r = await reservar();
    await entrar(r.pass_code);
    await api().post(url(`/reservations/${r.id}/status`)).set(auth(manager)).send({ status: 'completed' });

    expect(await sentado(guest.id)).toBeNull();
    const { rows } = await pool.query('SELECT status FROM tables WHERE id = $1', [mesa.id]);
    expect(rows[0].status).toBe('available');
  });
});

// ---------------------------------------------------------------- la venta

describe('lo que se vende en la entrada', () => {
  it('un cover general se registra y cae en el libro', async () => {
    const res = await api().post(url('/door/admissions')).set(auth(hostess))
      .send({ kind: 'general', quantity: 3, unit_price: 150, payment_method: 'cash' });

    expect(res.status).toBe(201);
    expect(res.body.admission.total).toBe('450.00');

    const { rows } = await pool.query(
      `SELECT type, amount::text, status, provider FROM transactions WHERE type = 'cover'`);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ amount: '450.00', status: 'paid', provider: 'cash' });
  });

  it('un extra VIP queda pegado a su reservación: así se responde "reservó 8, entraron 10"', async () => {
    const r = await reservar();
    await api().post(url('/door/admissions')).set(auth(hostess))
      .send({ kind: 'vip_extra', reservation_id: r.id, quantity: 2, unit_price: 100 });

    const res = await api().get(url(`/door/pass/${r.pass_code}`)).set(auth(hostess));
    expect(res.body.pass.guest_count).toBe(8);
    expect(res.body.pass.extras_bought).toBe(2);
  });

  it('un extra VIP sin reservación se rechaza: sería dinero que no se le puede cobrar a nadie', async () => {
    const res = await api().post(url('/door/admissions')).set(auth(hostess))
      .send({ kind: 'vip_extra', quantity: 1, unit_price: 100 });
    expect(res.status).toBe(400);
  });

  it('una cortesía se registra pero NO inventa un cobro de cero pesos', async () => {
    const res = await api().post(url('/door/admissions')).set(auth(hostess))
      .send({ kind: 'general', quantity: 1, unit_price: 0, payment_method: 'courtesy' });
    expect(res.status).toBe(201);
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM transactions WHERE type = 'cover'`);
    expect(rows[0].n).toBe(0);
  });

  it('un cliente no puede vender accesos', async () => {
    const res = await api().post(url('/door/admissions')).set(auth(guest))
      .send({ kind: 'general', quantity: 1, unit_price: 150 });
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------- el aforo

describe('el aforo', () => {
  it('cuenta por separado lo reservado y lo vendido en la puerta', async () => {
    const r = await reservar();
    await entrar(r.pass_code);
    await api().post(url('/door/admissions')).set(auth(hostess))
      .send({ kind: 'general', quantity: 20, unit_price: 150 });
    await api().post(url('/door/admissions')).set(auth(hostess))
      .send({ kind: 'vip_extra', reservation_id: r.id, quantity: 2, unit_price: 100 });

    const res = await api().get(url('/door/summary')).set(auth(manager));
    expect(res.status).toBe(200);
    expect(res.body.reservations.adentro).toBe(1);
    expect(res.body.reservations.personas_vip).toBe(8);
    expect(res.body.door.generales).toBe(20);
    expect(res.body.door.extras_vip).toBe(2);
    // 8 de la mesa + 20 generales + 2 extras.
    expect(res.body.inside).toBe(30);
  });
});

// ---------------------------------------------------------------- el precio y el doble toque

describe('El precio del cover ya no se teclea', () => {
  /**
   * Nace de un defecto que costaba dinero todas las noches: la ruta aceptaba
   * `unit_price` del cuerpo y lo asentaba en el libro sin compararlo con nada. El cover
   * son $300, el cadenero cobra $300 y teclea 150 — y al cierre la caja CUADRA, contra
   * un total que él mismo escribió.
   */
  async function altaCover(name = 'COVER', amount = 300) {
    const res = await api().post(url('/cover-prices')).set(auth(manager))
      .send({ name, amount });
    expect(res.status).toBe(201);
    return res.body.cover_price;
  }

  it('con catálogo, el precio sale del catálogo y no de lo que se teclee', async () => {
    const cover = await altaCover('COVER', 300);
    const res = await api().post(url('/door/admissions')).set(auth(hostess))
      .send({ kind: 'general', quantity: 2, cover_price_id: cover.id, payment_method: 'cash' });

    expect(res.status).toBe(201);
    expect(res.body.admission.total).toBe('600.00');
    expect(res.body.admission.price_source).toBe('catalog');
    const { rows } = await pool.query(
      "SELECT amount::text FROM transactions WHERE type = 'cover'");
    expect(rows[0].amount).toBe('600.00');
  });

  it('teclear un precio DISTINTO del catálogo se rechaza, y dice el correcto', async () => {
    // Puede ser un descuento legítimo. Esa decisión es del gerente y tiene que quedar
    // escrita, no resolverse en la puerta tecleando otro número.
    const cover = await altaCover('COVER', 300);
    const res = await api().post(url('/door/admissions')).set(auth(hostess))
      .send({ kind: 'general', quantity: 1, cover_price_id: cover.id, unit_price: 150 });
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/300/);
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM transactions WHERE type = 'cover'");
    expect(rows[0].n).toBe(0);
  });

  it('con catálogo dado de alta, ya NO se acepta un precio suelto', async () => {
    await altaCover('COVER', 300);
    const res = await api().post(url('/door/admissions')).set(auth(hostess))
      .send({ kind: 'general', quantity: 1, unit_price: 150 });
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/covers del club/i);
  });

  it('sin catálogo todavía, la puerta sigue vendiendo — y queda marcado como tecleado', async () => {
    // Un club que actualiza a media noche no se puede quedar sin poder cobrar. Pero la
    // venta queda distinguible en el corte.
    const res = await api().post(url('/door/admissions')).set(auth(hostess))
      .send({ kind: 'general', quantity: 1, unit_price: 150 });
    expect(res.status).toBe(201);
    expect(res.body.admission.price_source).toBe('manual');
    const { rows } = await pool.query(
      "SELECT metadata->>'price_source' AS src FROM transactions WHERE type = 'cover'");
    expect(rows[0].src).toBe('manual');
  });

  it('un cover dado de baja no se puede cobrar', async () => {
    const cover = await altaCover('COVER S', 100);
    await api().patch(url(`/cover-prices/${cover.id}`)).set(auth(manager)).send({ active: false });
    const res = await api().post(url('/door/admissions')).set(auth(hostess))
      .send({ kind: 'general', quantity: 1, cover_price_id: cover.id });
    expect(res.status).toBe(422);
  });

  it('solo el gerente da de alta covers; la puerta los lee', async () => {
    expect((await api().post(url('/cover-prices')).set(auth(hostess))
      .send({ name: 'MÍO', amount: 1 })).status).toBe(403);
    await altaCover();
    expect((await api().get(url('/cover-prices')).set(auth(hostess))).status).toBe(200);
  });

  it('cambiar el precio NO toca lo ya vendido', async () => {
    const cover = await altaCover('COVER', 300);
    await api().post(url('/door/admissions')).set(auth(hostess))
      .send({ kind: 'general', quantity: 1, cover_price_id: cover.id });
    await api().patch(url(`/cover-prices/${cover.id}`)).set(auth(manager)).send({ amount: 500 });

    const { rows } = await pool.query(
      "SELECT amount::text FROM transactions WHERE type = 'cover'");
    expect(rows[0].amount).toBe('300.00');
  });
});

describe('El doble toque de la puerta', () => {
  it('la misma clave NO vende dos veces', async () => {
    // Con mal wifi la pantalla se queda pensando y el cadenero toca otra vez. Sin esto
    // son dos entradas, dos renglones en el libro y dos juegos de QR — y al cierre la
    // caja aparece corta por la diferencia, que se la carga él.
    const clave = require('crypto').randomUUID();
    const cuerpo = {
      kind: 'general', quantity: 2, unit_price: 150, payment_method: 'cash',
      client_request_id: clave,
    };
    const uno = await api().post(url('/door/admissions')).set(auth(hostess)).send(cuerpo);
    const dos = await api().post(url('/door/admissions')).set(auth(hostess)).send(cuerpo);

    expect(uno.status).toBe(201);
    expect(dos.status).toBe(200);
    expect(dos.body.idempotent).toBe(true);
    expect(dos.body.admission.id).toBe(uno.body.admission.id);

    const libro = await pool.query(
      "SELECT count(*)::int AS n, sum(amount)::text AS total FROM transactions WHERE type = 'cover'");
    expect(libro.rows[0].n).toBe(1);
    expect(libro.rows[0].total).toBe('300.00');
    const entradas = await pool.query('SELECT count(*)::int AS n FROM door_admissions');
    expect(entradas.rows[0].n).toBe(1);
  });

  it('dos toques a la vez tampoco: el índice único para al segundo', async () => {
    const clave = require('crypto').randomUUID();
    const cuerpo = {
      kind: 'general', quantity: 1, unit_price: 150, client_request_id: clave,
    };
    const [a, b] = await Promise.all([
      api().post(url('/door/admissions')).set(auth(hostess)).send(cuerpo),
      api().post(url('/door/admissions')).set(auth(hostess)).send(cuerpo),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 201]);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM door_admissions');
    expect(rows[0].n).toBe(1);
  });

  it('un extra VIP repetido tampoco emite dos juegos de pases', async () => {
    const r = await reservar();
    const clave = require('crypto').randomUUID();
    const cuerpo = {
      kind: 'vip_extra', reservation_id: r.id, quantity: 2, unit_price: 100,
      client_request_id: clave,
    };
    const uno = await api().post(url('/door/admissions')).set(auth(hostess)).send(cuerpo);
    await api().post(url('/door/admissions')).set(auth(hostess)).send(cuerpo);
    expect(uno.status).toBe(201);

    const pases = await pool.query(
      'SELECT count(*)::int AS n FROM guest_passes WHERE admission_id IS NOT NULL');
    expect(pases.rows[0].n).toBe(2);
  });
});
