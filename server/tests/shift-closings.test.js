/**
 * El corte de turno de quien cobra (D51).
 *
 * Lo que se prueba aquí es una sola cosa, en todas sus formas: **que el número contra
 * el que se le pide cuentas a alguien no lo haya escrito esa misma persona.** Lo
 * cobrado sale de las filas que ya existen —pagos, cobros con terminal, covers—, y lo
 * único que cada parte teclea es su propio lado: el empleado cuánto entrega, el
 * gerente cuánto contó.
 */
'use strict';

const { randomUUID } = require('crypto');
const { setupSchema, truncateAll, closePool, pool } = require('./helpers/db');
const pins = require('../src/services/pins');
const { api, auth } = require('./helpers/api');
const f = require('./helpers/factories');
const { voucherAuth } = require('./helpers/voucher');
const { fullCut, declareAndClose } = require('./helpers/cut');

let club; let manager; let luis; let sol; let guest;

beforeAll(setupSchema);
afterAll(closePool);

beforeEach(async () => {
  await truncateAll();
  club = await f.createNightclub({ slug: 'ev2-cortes' });
  manager = await f.createUser(club.id, { role: 'manager', display_name: 'Gerente' });
  // Desde D77 el mesero y el sol ya no cobran. La mecánica del corte —lo
  // cobrado, los retiros, lo contado— es la misma para todo el que cobra, y aquí se
  // prueba con la puerta (la hostess cobra el cover); la caja de cada barra, con su
  // fondo y sus pedidos pendientes, tiene su propia suite en `cashier.test.js`.
  luis = await f.createUser(club.id, { role: 'hostess', display_name: 'Luis' });
  sol = await f.createUser(club.id, { role: 'hostess', display_name: 'Sol' });
  guest = await f.createUser(club.id, { role: 'guest' });
});

const url = (p) => `/api/nightclubs/${club.id}${p}`;
const abrirTurno = (user) => api().post(url('/staff/shifts/start')).set(auth(user)).send({});
// Desde D118 la anfitriona cobra con la caja de Cover abierta: su turno con la caja.
const abrirCaja = async (user) => {
  await abrirTurno(user);
  return f.openDoorTill(club.id, { hostess: user, authorizer: manager });
};
// Los números del corte, como los ve el gerente: la anfitriona cuenta a ciegas (D105).
const miCorte = async (user) => {
  const res = await api().get(url('/shifts/me/cut')).set(auth(user));
  if (!res.body || !res.body.shift) return res;
  return { status: res.status, body: await fullCut(club.id, user) };
};

/** Un renglón del libro por cobrar, como el de un pedido. */
async function porCobrar(amount = '450.00') {
  const { rows } = await pool.query(
    `INSERT INTO transactions (nightclub_id, type, direction, amount, currency, status, payer_user_id)
     VALUES ($1,'drink_order','in',$2,'MXN','pending',$3) RETURNING id`,
    [club.id, amount, guest.id]);
  return rows[0];
}

/** Quien cobra registra el pago en el acto: efectivo o voucher de terminal. */
const cobrar = async (user, amount, method = 'cash') => api()
  .post(url('/manual-payments/register')).set(auth(user))
  .send({
    transaction_id: (await porCobrar(String(amount.toFixed ? amount.toFixed(2) : amount))).id,
    method,
    amount,
    currency: 'MXN',
    ...(method === 'cash' ? {} : {
      reference: `VCH${Math.random().toString().slice(2, 8)}`, ...(await voucherAuth(club.id)),
    }),
  });

/**
 * El código con el que un gerente autoriza. Es su PIN de acceso, el mismo que ya
 * existe: el dueño no quiso una segunda credencial que administrar.
 */
async function codigoDe(user) {
  const pin = await pins.issuePin(pool, { userId: user.id });
  // Un PIN recién emitido viene marcado para cambiarse, y mientras no se cambie el
  // servidor le bloquea a esa persona TODAS las rutas (D46). Aquí se limpia porque
  // lo que se está probando es la autorización, no el alta del PIN — pero conviene
  // saberlo: un gerente con PIN recién dado no puede entrar a su panel hasta que lo
  // cambie, aunque su código sí sirva para autorizar un retiro.
  await pool.query('UPDATE users SET must_change_pin = false WHERE id = $1', [user.id]);
  return pin;
}

/** Un retiro parcial: monto, motivo y el código de quien lo autoriza. */
const retirar = (user, amount, reason, pin) => api()
  .post(url('/shifts/me/cash-drops')).set(auth(user))
  .send({ amount, reason, manager_pin: pin });

/** El corte completo, en un acto: lo declarado, lo contado y el código. */
const cortar = (user, declared, counted, pin, extra = {}) => declareAndClose(club.id, user,
  { declared_cash: declared, counted_cash: counted, manager_pin: pin, ...extra });

const turnoAbierto = async (userId) => (await pool.query(
  'SELECT ended_at FROM staff_shifts WHERE user_id = $1', [userId])).rows[0];

describe('Lo que traigo encima', () => {
  it('sin turno abierto no es un error: lo dice', async () => {
    const res = await miCorte(luis);
    expect(res.status).toBe(200);
    expect(res.body.shift).toBeNull();
  });

  it('cuenta lo cobrado por método, y el efectivo es lo único que se entrega', async () => {
    await abrirCaja(luis);
    await cobrar(luis, 450);
    await cobrar(luis, 300);
    await cobrar(luis, 1200, 'card_terminal');

    const res = await miCorte(luis);
    expect(res.status).toBe(200);
    expect(res.body.totals.cash_collected).toBe('750.00');
    expect(res.body.totals.total_collected).toBe('1950.00');
    expect(res.body.cash_to_hand).toBe('750.00');
    const porMetodo = Object.fromEntries(res.body.totals.by_method.map((l) => [l.method, l]));
    expect(porMetodo.cash).toMatchObject({ amount: '750.00', count: 2 });
    expect(porMetodo.card_terminal).toMatchObject({ amount: '1200.00', count: 1 });
  });

  it('lo que cobró OTRA persona no aparece en mi corte', async () => {
    // Es la razón de ser de todo esto: el faltante tiene que ser de alguien. Desde D118
    // la otra anfitriona, sin la caja de Cover, ni siquiera puede cobrar.
    await abrirCaja(luis);
    await abrirTurno(sol);
    await cobrar(luis, 500);
    const deSol = await cobrar(sol, 900);
    expect(deSol.status).toBe(409);

    expect((await miCorte(luis)).body.totals.cash_collected).toBe('500.00');
    expect((await miCorte(sol)).body.totals.cash_collected).toBe('0.00');
  });

  it('sin la caja abierta no se cobra: nada queda fuera de un corte', async () => {
    const antes = await cobrar(luis, 700);
    expect(antes.status).toBe(409);
    await abrirCaja(luis);
    await cobrar(luis, 200);
    expect((await miCorte(luis)).body.totals.cash_collected).toBe('200.00');
  });

  it('la propina va aparte: no es del club y no se entrega', async () => {
    await abrirCaja(luis);
    await cobrar(luis, 400);
    await api().post(url('/tips')).set(auth(guest))
      .send({ client_request_id: randomUUID(), to_user_id: luis.id, amount: 150 });

    const res = await miCorte(luis);
    expect(res.body.totals.tips).toMatchObject({ amount: '150.00', count: 1 });
    expect(res.body.cash_to_hand).toBe('400.00');
  });
});


// ============================================================================
// Retiros parciales y corte, desde D54: siempre con un gerente presente.
// ============================================================================

describe('El retiro parcial de efectivo', () => {
  let pin;
  beforeEach(async () => { pin = await codigoDe(manager); });

  it('pide monto, motivo y código, y con los tres sale', async () => {
    await abrirCaja(luis);
    await cobrar(luis, 5000);
    const res = await retirar(luis, 3000, 'Traía mucho efectivo encima', pin);

    expect(res.status).toBe(201);
    // A ciegas (D105) la anfitriona no ve cuánto le queda.
    expect(res.body.withdrawal).toMatchObject({ amount: '3000.00', remaining: null });
    expect(res.body.withdrawal.authorized_by).toBe('Gerente');
  });

  it('queda recibido y contado en el acto: quien autoriza está ahí', async () => {
    await abrirCaja(luis);
    await cobrar(luis, 5000);
    const res = await retirar(luis, 3000, 'A la caja fuerte', pin);
    const { rows } = await pool.query(
      `SELECT status, counted_amount::text AS counted, reason, authorized_role,
              received_by = authorized_by AS mismo
         FROM shift_cash_drops WHERE id = $1`, [res.body.withdrawal.id]);
    // Dejarlo "pendiente de contar" no tendría sentido: quien lo contaría acaba de
    // firmar que lo tiene en la mano.
    expect(rows[0]).toMatchObject({
      status: 'received', counted: '3000.00', reason: 'A la caja fuerte',
      authorized_role: 'manager', mismo: true,
    });
  });

  it('descuenta de lo que falta entregar', async () => {
    await abrirCaja(luis);
    await cobrar(luis, 5000);
    await retirar(luis, 3000, 'A la caja fuerte', pin);
    expect((await miCorte(luis)).body.cash_to_hand).toBe('2000.00');
  });

  it('sin motivo no hay retiro', async () => {
    await abrirCaja(luis);
    await cobrar(luis, 5000);
    const res = await api().post(url('/shifts/me/cash-drops')).set(auth(luis))
      .send({ amount: 1000, manager_pin: pin });
    expect(res.status).toBe(400);
  });

  it('un motivo de dos letras tampoco es un motivo', async () => {
    await abrirCaja(luis);
    await cobrar(luis, 5000);
    expect((await retirar(luis, 1000, 'ok', pin)).status).toBe(400);
  });

  it('sin código no hay retiro, y un código equivocado no dice por qué', async () => {
    await abrirCaja(luis);
    await cobrar(luis, 5000);
    const sinCodigo = await api().post(url('/shifts/me/cash-drops')).set(auth(luis))
      .send({ amount: 1000, reason: 'Traía mucho' });
    expect(sinCodigo.status).toBe(400);

    const malo = await retirar(luis, 1000, 'Traía mucho', '999111');
    expect(malo.status).toBe(403);
    // "Ese PIN no es de nadie" y "ese PIN es de un mesero" son la misma respuesta:
    // distinguirlas permitiría mapear los PIN del club de a uno por intento.
    expect(malo.body.error.message).toBe('Código de autorización inválido');
  });

  it('el PIN de alguien del piso no autoriza nada', async () => {
    const pinMesero = await codigoDe(sol);
    await abrirCaja(luis);
    await cobrar(luis, 5000);
    const res = await retirar(luis, 1000, 'Traía mucho', pinMesero);
    expect(res.status).toBe(403);
    expect(res.body.error.message).toBe('Código de autorización inválido');
  });

  it('nadie se autoriza a sí mismo, y la base tampoco lo deja', async () => {
    // Hoy ninguna ruta llega a este caso —un gerente no abre turno, así que no tiene
    // corte propio— pero la garantía no puede depender de eso: mañana alguien agrega
    // otra forma de cerrar un turno y este renglón sigue siendo el que manda.
    await abrirCaja(luis);
    await cobrar(luis, 1000);
    const turno = await pool.query(
      'SELECT id FROM staff_shifts WHERE user_id = $1', [luis.id]);
    await expect(pool.query(
      `INSERT INTO shift_cash_drops
         (nightclub_id, shift_id, user_id, amount, currency, reason, status,
          counted_amount, received_by, received_at, authorized_by, authorized_at, authorized_role)
       VALUES ($1,$2,$3,500,'MXN','me lo autorizo yo','received',500,$3,now(),$3,now(),'manager')`,
      [club.id, turno.rows[0].id, luis.id]))
      .rejects.toMatchObject({ code: '23514' });
  });

  it('autorizado a medias no existe: o están los tres datos o no hay autorización', async () => {
    await abrirCaja(luis);
    await cobrar(luis, 1000);
    const turno = await pool.query(
      'SELECT id FROM staff_shifts WHERE user_id = $1', [luis.id]);
    await expect(pool.query(
      `INSERT INTO shift_cash_drops
         (nightclub_id, shift_id, user_id, amount, currency, reason, authorized_by)
       VALUES ($1,$2,$3,500,'MXN','sin fecha ni rol',$4)`,
      [club.id, turno.rows[0].id, luis.id, manager.id]))
      .rejects.toMatchObject({ code: '23514' });
  });

  it('no se retira más de lo que se trae', async () => {
    await abrirCaja(luis);
    await cobrar(luis, 1000);
    const res = await retirar(luis, 4000, 'Me equivoqué de tecla', pin);
    expect(res.status).toBe(422);
    // A ciegas (D105) el rechazo no le dice cuánto trae.
    expect(res.body.error.message).toMatch(/mayor que el efectivo/);
    expect(res.body.error.message).not.toMatch(/1000/);
  });

  it('el gerente ve los retiros con su motivo y quién los autorizó', async () => {
    await abrirCaja(luis);
    await cobrar(luis, 5000);
    await retirar(luis, 3000, 'A la caja fuerte', pin);
    const lista = await api().get(url('/cash-drops')).set(auth(manager));
    expect(lista.body.drops[0]).toMatchObject({
      amount: '3000.00', reason: 'A la caja fuerte', authorized_by_name: 'Gerente',
    });
  });

  it('un retiro escrito no se edita ni se borra', async () => {
    await abrirCaja(luis);
    await cobrar(luis, 5000);
    const res = await retirar(luis, 3000, 'A la caja fuerte', pin);
    const id = res.body.withdrawal.id;
    await expect(pool.query('DELETE FROM shift_cash_drops WHERE id = $1', [id]))
      .rejects.toMatchObject({ code: '23001' });
    await expect(pool.query(
      `UPDATE shift_cash_drops SET reason = 'otra cosa' WHERE id = $1`, [id]))
      .rejects.toMatchObject({ code: '23001' });
  });
});

describe('El corte, en un solo acto', () => {
  let pin;
  beforeEach(async () => { pin = await codigoDe(manager); });

  it('se declara, se cuenta y se cierra de una vez', async () => {
    await abrirCaja(luis);
    await cobrar(luis, 2000);
    const res = await cortar(luis, 2000, 2000, pin);

    expect(res.status).toBe(201);
    expect(res.body.closing).toMatchObject({
      status: 'confirmed', expected_cash: '2000.00', declared_cash: '2000.00',
      counted_cash: '2000.00', difference: '0.00',
    });
    expect(res.body.closing.authorized_by_name).toBe('Gerente');
    // Cerrar el corte cierra el turno: es el último paso.
    expect((await turnoAbierto(luis.id)).ended_at).not.toBeNull();
  });

  it('la diferencia se mide contra lo que TOCABA, no contra lo declarado', async () => {
    // Es el agujero obvio: declarar de menos y entregar de menos cuadraría perfecto.
    await abrirCaja(luis);
    await cobrar(luis, 2000);
    const res = await cortar(luis, 1800, 1800, pin,
      { difference_reason: 'Se me perdieron doscientos pesos' });
    expect(res.body.closing.difference).toBe('-200.00');
  });

  it('una diferencia sin motivo no se acepta', async () => {
    await abrirCaja(luis);
    await cobrar(luis, 2000);
    const res = await cortar(luis, 2000, 1900, pin);
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/Falta dinero/);
    // Y el turno sigue abierto: no se cerró nada a medias.
    expect((await turnoAbierto(luis.id)).ended_at).toBeNull();
  });

  it('un motivo de tres letras no es un motivo', async () => {
    await abrirCaja(luis);
    await cobrar(luis, 2000);
    expect((await cortar(luis, 2000, 1900, pin, { difference_reason: 'ups' })).status).toBe(422);
  });

  it('sin código no se cierra nada', async () => {
    await abrirCaja(luis);
    await cobrar(luis, 2000);
    const res = await api().post(url('/shifts/me/closing')).set(auth(luis))
      .send({ declared_cash: 2000, counted_cash: 2000 });
    expect(res.status).toBe(400);
    expect((await turnoAbierto(luis.id)).ended_at).toBeNull();
  });

  it('con un código equivocado no se escribe ni un renglón', async () => {
    await abrirCaja(luis);
    await cobrar(luis, 2000);
    expect((await cortar(luis, 2000, 2000, '111999')).status).toBe(403);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM shift_closings');
    expect(rows[0].n).toBe(0);
  });

  it('el corte descuenta los retiros de la noche', async () => {
    await abrirCaja(luis);
    await cobrar(luis, 5000);
    await retirar(luis, 3000, 'A la caja fuerte', pin);
    const res = await cortar(luis, 2000, 2000, pin);
    expect(res.body.closing).toMatchObject({
      cash_collected: '5000.00', drops_total: '3000.00', expected_cash: '2000.00',
      difference: '0.00',
    });
  });

  it('no se corta dos veces el mismo turno', async () => {
    await abrirCaja(luis);
    await cobrar(luis, 1000);
    await cortar(luis, 1000, 1000, pin);
    expect((await cortar(luis, 1000, 1000, pin)).status).toBe(409);
  });

  it('un corte cerrado no se reescribe', async () => {
    await abrirCaja(luis);
    await cobrar(luis, 1000);
    const res = await cortar(luis, 1000, 1000, pin);
    await expect(pool.query(
      `UPDATE shift_closings SET counted_cash = 999 WHERE id = $1`, [res.body.closing.id]))
      .rejects.toMatchObject({ code: '23001' });
  });

  it('quien no cobró nada puede cerrar su turno sin corte', async () => {
    await abrirTurno(sol);
    const res = await api().post(url('/staff/shifts/end')).set(auth(sol)).send({});
    expect(res.status).toBe(200);
  });

  it('quien cobró NO puede cerrar su turno sin corte', async () => {
    await abrirCaja(luis);
    await cobrar(luis, 800);
    const res = await api().post(url('/staff/shifts/end')).set(auth(luis)).send({});
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/haz tu corte/i);
  });
});

describe('El ticket del corte', () => {
  let pin;
  beforeEach(async () => {
    pin = await codigoDe(manager);
    await api().post(url('/printers')).set(auth(manager)).send({
      location_id: club.bar_id,
      name: 'Barra baja · meseros',
      purpose: 'service',
      connection: 'network',
      host: '192.168.1.50',
    });
  });

  const ticketDe = async (closingId) => {
    const { rows } = await pool.query(
      `SELECT preview FROM print_jobs WHERE ref_id = $1 AND kind = 'shift_cut'`, [closingId]);
    return rows[0] ? rows[0].preview : null;
  };

  it('sale al cerrar como CORTE Z, con el desglose por método de pago', async () => {
    await abrirCaja(luis);
    await cobrar(luis, 3000);
    await cobrar(luis, 4500, 'card_terminal');
    const res = await cortar(luis, 3000, 3000, pin);

    expect(res.body.ticket).not.toBeNull();
    const papel = await ticketDe(res.body.closing.id);
    // El corte de una caja es su cierre definitivo (D132): el papel lo dice.
    expect(papel).toContain('CORTE Z');
    expect(papel).toContain('Corte Z No. 1 · cierre definitivo');
    expect(papel).not.toContain('CORTE DE TURNO');
    expect(papel).toContain('Luis');
    expect(papel).toContain('Efectivo');
    expect(papel).toContain('$3,000.00');
    expect(papel).toContain('Tarjeta (terminal)');
    expect(papel).toContain('$4,500.00');
    expect(papel).toContain('Total cobrado');
    expect(papel).toContain('$7,500.00');
  });

  it('la respuesta dice que es un Z y que el turno quedó cerrado (D132)', async () => {
    await abrirCaja(luis);
    await cobrar(luis, 500);
    const res = await cortar(luis, 500, 500, pin);

    expect(res.status).toBe(201);
    expect(res.body.report).toBe('z');
    expect(res.body.closing.z_number).toBe(1);
    expect(res.body.shift).toMatchObject({ closed: true });
    expect(res.body.shift.ended_at).toBeTruthy();
    expect(res.body.shift.id).toBe(res.body.closing.shift_id);
    expect((await turnoAbierto(luis.id)).ended_at).not.toBeNull();
  });

  it('el consecutivo del Z sube con cada corte de la misma caja', async () => {
    await abrirCaja(luis);
    await cobrar(luis, 500);
    const primero = await cortar(luis, 500, 500, pin);
    expect(primero.body.closing.z_number).toBe(1);

    // La misma caja de Cover, otro turno, otra noche si se quiere: el Z sigue contando.
    await abrirCaja(luis);
    await cobrar(luis, 700);
    const segundo = await cortar(luis, 700, 700, pin);
    expect(segundo.status).toBe(201);
    expect(segundo.body.closing.z_number).toBe(2);
    const papel = await ticketDe(segundo.body.closing.id);
    expect(papel).toContain('Corte Z No. 2 · cierre definitivo');
    // Y el primero sigue siendo el 1 aunque se reimprima después del segundo.
    const otra = await api().post(url(`/shift-closings/${primero.body.closing.id}/ticket`))
      .set(auth(manager)).send({});
    expect(otra.status).toBe(202);
    const { rows } = await pool.query(
      `SELECT preview FROM print_jobs WHERE ref_id = $1 AND kind = 'shift_cut' ORDER BY created_at DESC`,
      [primero.body.closing.id]);
    expect(rows[0].preview).toContain('Corte Z No. 1 · cierre definitivo');
  });

  it('un turno sin caja no es un Z: zNumber contesta null', async () => {
    const cuts = require('../src/services/shift-closings');
    expect(await cuts.zNumber(pool, { location_id: null })).toBeNull();
    expect(await cuts.zNumber(pool, null)).toBeNull();
  });

  it('desglosa cada retiro parcial con su motivo y quién lo autorizó', async () => {
    await abrirCaja(luis);
    await cobrar(luis, 9000);
    await retirar(luis, 5000, 'A la caja fuerte del gerente', pin);
    await retirar(luis, 2000, 'Se pagó al proveedor del hielo', pin);
    const res = await cortar(luis, 2000, 2000, pin);

    const papel = await ticketDe(res.body.closing.id);
    expect(papel).toContain('RETIROS PARCIALES');
    expect(papel).toContain('A la caja fuerte del gerente');
    expect(papel).toContain('Se pagó al proveedor del hielo');
    expect(papel).toContain('Autorizó: Gerente');
    expect(papel).toContain('Total retirado');
    expect(papel).toContain('$7,000.00');
  });

  it('la propina aparece aparte y dice que no se entrega', async () => {
    await abrirCaja(luis);
    await cobrar(luis, 1000);
    await api().post(url('/tips')).set(auth(guest))
      .send({ client_request_id: randomUUID(), to_user_id: luis.id, amount: 250 });
    const res = await cortar(luis, 1000, 1000, pin);

    const papel = await ticketDe(res.body.closing.id);
    expect(papel).toMatch(/Propinas.*no se entregan/);
    expect(papel).toContain('$250.00');
  });

  it('cuando falta dinero, el papel lo dice con su motivo', async () => {
    await abrirCaja(luis);
    await cobrar(luis, 2000);
    const res = await cortar(luis, 2000, 1850, pin,
      { difference_reason: 'Faltó un billete de 150, no apareció al recontar' });

    const papel = await ticketDe(res.body.closing.id);
    expect(papel).toContain('FALTA');
    expect(papel).toContain('$150.00');
    expect(papel).toContain('Faltó un billete');
  });

  it('cuando cuadra, lo dice también: el silencio no es una respuesta', async () => {
    await abrirCaja(luis);
    await cobrar(luis, 2000);
    const res = await cortar(luis, 2000, 2000, pin);
    expect(await ticketDe(res.body.closing.id)).toContain('CUADRA');
  });

  it('trae las dos firmas: la de quien entrega y la de quien autoriza', async () => {
    await abrirCaja(luis);
    await cobrar(luis, 500);
    const res = await cortar(luis, 500, 500, pin);
    const papel = await ticketDe(res.body.closing.id);
    expect(papel).toContain('_______________________');
    expect(papel).toContain('Autorizó: Gerente');
  });

  it('se reimprime igual: el papel no se vuelve a calcular', async () => {
    await abrirCaja(luis);
    await cobrar(luis, 1000);
    const res = await cortar(luis, 1000, 1000, pin);

    // Esa persona sigue cobrando después de su corte, en otro turno.
    await abrirCaja(luis);
    await cobrar(luis, 4000);

    const otra = await api().post(url(`/shift-closings/${res.body.closing.id}/ticket`))
      .set(auth(manager));
    expect(otra.status).toBe(202);
    const { rows } = await pool.query(
      `SELECT payload FROM print_jobs WHERE ref_id = $1 AND kind = 'shift_cut'
        ORDER BY created_at`, [res.body.closing.id]);
    expect(rows).toHaveLength(2);
    expect(rows[0].payload.equals(rows[1].payload)).toBe(true);
  });

  it('sin impresora el corte se cierra igual, y lo dice', async () => {
    await pool.query('UPDATE printers SET active = false WHERE nightclub_id = $1', [club.id]);
    await abrirCaja(luis);
    await cobrar(luis, 1000);
    const res = await cortar(luis, 1000, 1000, pin);
    // El dinero ya se contó: que no salga el papel no puede deshacer eso.
    expect(res.status).toBe(201);
    expect(res.body.closing.status).toBe('confirmed');
    expect(res.body.ticket).toBeNull();
  });
});
