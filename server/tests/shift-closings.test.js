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
const { api, auth } = require('./helpers/api');
const f = require('./helpers/factories');

let club; let manager; let waiter; let bartender; let guest;

beforeAll(setupSchema);
afterAll(closePool);

beforeEach(async () => {
  await truncateAll();
  club = await f.createNightclub({ slug: 'ev2-cortes' });
  manager = await f.createUser(club.id, { role: 'manager', display_name: 'Gerente' });
  waiter = await f.createUser(club.id, { role: 'waiter', display_name: 'Luis' });
  bartender = await f.createUser(club.id, { role: 'bartender', display_name: 'Sol' });
  guest = await f.createUser(club.id, { role: 'guest' });
});

const url = (p) => `/api/nightclubs/${club.id}${p}`;
const abrirTurno = (user) => api().post(url('/staff/shifts/start')).set(auth(user)).send({});
const miCorte = (user) => api().get(url('/shifts/me/cut')).set(auth(user));

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
    ...(method === 'cash' ? {} : { reference: `VCH${Math.random().toString().slice(2, 8)}` }),
  });

const entregar = (user, amount, note) => api()
  .post(url('/shifts/me/cash-drops')).set(auth(user)).send({ amount, ...(note ? { note } : {}) });
const recibir = (dropId, body = {}) => api()
  .post(url(`/cash-drops/${dropId}/receive`)).set(auth(manager)).send(body);
const declarar = (user, declared, notes) => api()
  .post(url('/shifts/me/closing')).set(auth(user))
  .send({ declared_cash: declared, ...(notes ? { notes } : {}) });
const confirmar = (closingId, counted, reason) => api()
  .post(url(`/shift-closings/${closingId}/confirm`)).set(auth(manager))
  .send({ counted_cash: counted, ...(reason ? { reason } : {}) });

const turnoAbierto = async (userId) => (await pool.query(
  'SELECT ended_at FROM staff_shifts WHERE user_id = $1', [userId])).rows[0];

describe('Lo que traigo encima', () => {
  it('sin turno abierto no es un error: lo dice', async () => {
    const res = await miCorte(waiter);
    expect(res.status).toBe(200);
    expect(res.body.shift).toBeNull();
  });

  it('cuenta lo cobrado por método, y el efectivo es lo único que se entrega', async () => {
    await abrirTurno(waiter);
    await cobrar(waiter, 450);
    await cobrar(waiter, 300);
    await cobrar(waiter, 1200, 'card_terminal');

    const res = await miCorte(waiter);
    expect(res.status).toBe(200);
    expect(res.body.totals.cash_collected).toBe('750.00');
    expect(res.body.totals.total_collected).toBe('1950.00');
    expect(res.body.cash_to_hand).toBe('750.00');
    const porMetodo = Object.fromEntries(res.body.totals.by_method.map((l) => [l.method, l]));
    expect(porMetodo.cash).toMatchObject({ amount: '750.00', count: 2 });
    expect(porMetodo.card_terminal).toMatchObject({ amount: '1200.00', count: 1 });
  });

  it('lo que cobró OTRA persona no aparece en mi corte', async () => {
    // Es la razón de ser de todo esto: el faltante tiene que ser de alguien.
    await abrirTurno(waiter);
    await abrirTurno(bartender);
    await cobrar(waiter, 500);
    await cobrar(bartender, 900);

    expect((await miCorte(waiter)).body.totals.cash_collected).toBe('500.00');
    expect((await miCorte(bartender)).body.totals.cash_collected).toBe('900.00');
  });

  it('lo cobrado ANTES de abrir el turno no cuenta en este turno', async () => {
    await cobrar(waiter, 700);
    await abrirTurno(waiter);
    await cobrar(waiter, 200);
    expect((await miCorte(waiter)).body.totals.cash_collected).toBe('200.00');
  });

  it('la propina va aparte: no es del club y no se entrega', async () => {
    await abrirTurno(waiter);
    await cobrar(waiter, 400);
    await api().post(url('/tips')).set(auth(guest))
      .send({ client_request_id: randomUUID(), to_user_id: waiter.id, amount: 150 });

    const res = await miCorte(waiter);
    expect(res.body.totals.tips).toMatchObject({ amount: '150.00', count: 1 });
    expect(res.body.cash_to_hand).toBe('400.00');
  });
});

describe('Entregar efectivo a media noche', () => {
  it('el mesero entrega, el gerente cuenta, y deja de deberlo', async () => {
    await abrirTurno(waiter);
    await cobrar(waiter, 5000);
    const drop = await entregar(waiter, 3000, 'Va con el de seguridad');
    expect(drop.status).toBe(201);

    // Declarada todavía no es entregada: hasta que alguien la cuenta, el dinero es suyo.
    expect((await miCorte(waiter)).body.cash_to_hand).toBe('5000.00');

    expect((await recibir(drop.body.drop.id)).status).toBe(200);
    const despues = await miCorte(waiter);
    expect(despues.body.drops_received).toBe('3000.00');
    expect(despues.body.cash_to_hand).toBe('2000.00');
  });

  it('el gerente puede contar MENOS de lo declarado, y eso es lo que vale', async () => {
    await abrirTurno(waiter);
    await cobrar(waiter, 5000);
    const drop = await entregar(waiter, 3000);
    await recibir(drop.body.drop.id, { counted_amount: 2800 });

    const res = await miCorte(waiter);
    expect(res.body.drops_received).toBe('2800.00');
    expect(res.body.cash_to_hand).toBe('2200.00');
  });

  it('una entrega rechazada no descuenta nada, y dice por qué', async () => {
    await abrirTurno(waiter);
    await cobrar(waiter, 1000);
    const drop = await entregar(waiter, 800);
    const res = await api().post(url(`/cash-drops/${drop.body.drop.id}/reject`))
      .set(auth(manager)).send({ reason: 'Los billetes no coinciden con lo declarado' });
    expect(res.status).toBe(200);
    expect((await miCorte(waiter)).body.cash_to_hand).toBe('1000.00');
  });

  it('la misma entrega no se cuenta dos veces', async () => {
    await abrirTurno(waiter);
    await cobrar(waiter, 1000);
    const drop = await entregar(waiter, 500);
    expect((await recibir(drop.body.drop.id)).status).toBe(200);
    expect((await recibir(drop.body.drop.id)).status).toBe(409);
    expect((await miCorte(waiter)).body.drops_received).toBe('500.00');
  });

  it('solo el gerente recibe, y solo dentro de un turno se entrega', async () => {
    await abrirTurno(waiter);
    await cobrar(waiter, 1000);
    const drop = await entregar(waiter, 500);
    expect((await api().post(url(`/cash-drops/${drop.body.drop.id}/receive`))
      .set(auth(bartender)).send({})).status).toBe(403);
    expect((await entregar(bartender, 100)).status).toBe(409);
  });
});

describe('El corte', () => {
  it('el empleado declara, el gerente cuenta, y el turno se cierra solo', async () => {
    await abrirTurno(waiter);
    await cobrar(waiter, 450);
    await cobrar(waiter, 550);

    const declarado = await declarar(waiter, 1000, 'Todo en billetes de 500');
    expect(declarado.status).toBe(201);
    expect(declarado.body.closing).toMatchObject({
      status: 'declared', declared_cash: '1000.00', expected_cash: '1000.00',
    });
    // Declarar NO cierra el turno: el dinero sigue siendo suyo hasta que lo cuenten.
    expect((await turnoAbierto(waiter.id)).ended_at).toBeNull();

    const res = await confirmar(declarado.body.closing.id, 1000);
    expect(res.status).toBe(200);
    expect(res.body.closing).toMatchObject({
      status: 'confirmed', counted_cash: '1000.00', difference: '0.00',
      confirmed_by_name: 'Gerente',
    });
    expect((await turnoAbierto(waiter.id)).ended_at).not.toBeNull();
  });

  it('un faltante SIN motivo no se puede cerrar', async () => {
    await abrirTurno(bartender);
    await cobrar(bartender, 2000);
    const declarado = await declarar(bartender, 1800);

    const sinMotivo = await confirmar(declarado.body.closing.id, 1800);
    expect(sinMotivo.status).toBe(422);
    expect(sinMotivo.body.error.message).toMatch(/Falta dinero \(200/);

    const conMotivo = await confirmar(declarado.body.closing.id, 1800, 'Le fio a la mesa 4, lo paga mañana');
    expect(conMotivo.status).toBe(200);
    expect(conMotivo.body.closing.difference).toBe('-200.00');
    expect(conMotivo.body.closing.difference_reason).toMatch(/mesa 4/);
  });

  it('un sobrante también pide motivo: sobra dinero de alguien', async () => {
    await abrirTurno(waiter);
    await cobrar(waiter, 1000);
    const declarado = await declarar(waiter, 1200);
    expect((await confirmar(declarado.body.closing.id, 1200)).status).toBe(422);
    const ok = await confirmar(declarado.body.closing.id, 1200, 'Propina en efectivo que entró a la caja');
    expect(ok.body.closing.difference).toBe('200.00');
  });

  it('la diferencia se mide contra lo COBRADO, no contra lo que el empleado declaró', async () => {
    // Si se midiera contra lo declarado, declarar de menos y entregar de menos
    // cuadraría perfecto, que es la forma más fácil de robar de un corte.
    await abrirTurno(waiter);
    await cobrar(waiter, 3000);
    const declarado = await declarar(waiter, 2500);
    expect(declarado.body.closing.expected_cash).toBe('3000.00');
    const res = await confirmar(declarado.body.closing.id, 2500, 'Dice que se le perdió un billete');
    expect(res.body.closing.difference).toBe('-500.00');
  });

  it('lo ya entregado durante el turno no se le vuelve a pedir', async () => {
    await abrirTurno(waiter);
    await cobrar(waiter, 5000);
    const drop = await entregar(waiter, 4000);
    await recibir(drop.body.drop.id);

    const declarado = await declarar(waiter, 1000);
    expect(declarado.body.closing.expected_cash).toBe('1000.00');
    const res = await confirmar(declarado.body.closing.id, 1000);
    expect(res.body.closing).toMatchObject({ difference: '0.00', drops_total: '4000.00' });
  });

  it('no se cierra un corte con entregas sin contar', async () => {
    await abrirTurno(waiter);
    await cobrar(waiter, 5000);
    await entregar(waiter, 2000);
    const declarado = await declarar(waiter, 3000);
    const res = await confirmar(declarado.body.closing.id, 3000);
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/sin contar/);
  });

  it('nadie confirma su propio corte, ni el de otro sin ser gerente', async () => {
    await abrirTurno(waiter);
    await cobrar(waiter, 500);
    const declarado = await declarar(waiter, 500);
    expect((await api().post(url(`/shift-closings/${declarado.body.closing.id}/confirm`))
      .set(auth(waiter)).send({ counted_cash: 500 })).status).toBe(403);
    expect((await api().post(url(`/shift-closings/${declarado.body.closing.id}/confirm`))
      .set(auth(bartender)).send({ counted_cash: 500 })).status).toBe(403);
  });

  it('un corte no se declara ni se confirma dos veces', async () => {
    await abrirTurno(waiter);
    await cobrar(waiter, 500);
    const declarado = await declarar(waiter, 500);
    expect((await declarar(waiter, 500)).status).toBe(409);
    expect((await confirmar(declarado.body.closing.id, 500)).status).toBe(200);
    expect((await confirmar(declarado.body.closing.id, 500)).status).toBe(409);
  });

  it('lo cobrado queda CONGELADO al declarar: lo de después es otro turno', async () => {
    await abrirTurno(waiter);
    await cobrar(waiter, 1000);
    const declarado = await declarar(waiter, 1000);
    await cobrar(waiter, 700); // sigue cobrando mientras espera al gerente
    const res = await confirmar(declarado.body.closing.id, 1000);
    expect(res.body.closing.cash_collected).toBe('1000.00');
    expect(res.body.closing.difference).toBe('0.00');
  });

  it('el gerente ve los cortes que esperan, con nombre y diferencia', async () => {
    await abrirTurno(waiter);
    await cobrar(waiter, 800);
    await declarar(waiter, 800);

    const lista = await api().get(url('/shift-closings?status=declared')).set(auth(manager));
    expect(lista.status).toBe(200);
    expect(lista.body.closings[0]).toMatchObject({
      user_name: 'Luis', role: 'waiter', expected_cash: '800.00', status: 'declared',
    });
    expect((await api().get(url('/shift-closings')).set(auth(waiter))).status).toBe(403);
  });

  it('cada quien ve su corte; el de otro, no', async () => {
    await abrirTurno(waiter);
    await cobrar(waiter, 300);
    const declarado = await declarar(waiter, 300);
    const id = declarado.body.closing.id;
    expect((await api().get(url(`/shift-closings/${id}`)).set(auth(waiter))).status).toBe(200);
    expect((await api().get(url(`/shift-closings/${id}`)).set(auth(bartender))).status).toBe(403);
    expect((await api().get(url(`/shift-closings/${id}`)).set(auth(manager))).status).toBe(200);
  });
});

describe('Cerrar el turno', () => {
  it('quien cobró no cierra su turno sin corte', async () => {
    await abrirTurno(waiter);
    await cobrar(waiter, 600);
    const res = await api().post(url('/staff/shifts/end')).set(auth(waiter)).send({});
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/haz tu corte/);
    expect((await turnoAbierto(waiter.id)).ended_at).toBeNull();
  });

  it('con el corte declarado pero sin contar, tampoco', async () => {
    await abrirTurno(waiter);
    await cobrar(waiter, 600);
    await declarar(waiter, 600);
    const res = await api().post(url('/staff/shifts/end')).set(auth(waiter)).send({});
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/falta que el gerente/);
  });

  it('quien no cobró nada cierra su turno como siempre', async () => {
    await abrirTurno(bartender);
    const res = await api().post(url('/staff/shifts/end')).set(auth(bartender)).send({});
    expect(res.status).toBe(200);
    expect((await turnoAbierto(bartender.id)).ended_at).not.toBeNull();
  });

  it('el turno cerrado por el gerente deja el corte pendiente, y se puede hacer después', async () => {
    // El gerente cierra turnos olvidados. Eso NO borra el dinero que esa persona cobró.
    await abrirTurno(waiter);
    await cobrar(waiter, 900);
    expect((await api().post(url(`/staff/${waiter.id}/shifts/end`)).set(auth(manager)).send({}))
      .status).toBe(200);

    const pendiente = await miCorte(waiter);
    expect(pendiente.body.shift).not.toBeNull();
    expect(pendiente.body.cash_to_hand).toBe('900.00');
    const declarado = await declarar(waiter, 900);
    expect((await confirmar(declarado.body.closing.id, 900)).status).toBe(200);
  });
});
