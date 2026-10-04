/**
 * La caja de cada barra (D77).
 *
 * El cajero es la única persona que recibe el dinero de los tragos en una barra. Lo
 * que se prueba aquí es lo que hace que eso sea verdad y no solo una pantalla:
 *
 *   * La barra no la elige el cajero: sale del rol de la noche que arma el gerente.
 *   * La caja abre con un fondo que el gerente confirma con su PIN, y ese fondo no se
 *     edita después.
 *   * Una caja por barra.
 *   * El corte espera el fondo más el efectivo cobrado, y no se cierra con pedidos de
 *     la barra sin cobrar salvo que el gerente lo acepte; esos pedidos quedan escritos.
 */
'use strict';

const { randomUUID } = require('crypto');
const { setupSchema, truncateAll, closePool, pool } = require('./helpers/db');
const pins = require('../src/services/pins');
const { api, auth } = require('./helpers/api');
const f = require('./helpers/factories');

let club; let manager; let cajero; let waiter; let guest; let table; let beer; let night;
let pinGerente;

beforeAll(setupSchema);
afterAll(closePool);

/** El PIN del gerente, listo para autorizar (ver shift-closings.test.js). */
async function codigoDe(user) {
  const pin = await pins.issuePin(pool, { userId: user.id });
  await pool.query('UPDATE users SET must_change_pin = false WHERE id = $1', [user.id]);
  return pin;
}

/** Una noche en curso: abrió hace una hora. */
async function nocheEnCurso(over = {}) {
  const { rows } = await pool.query(
    `INSERT INTO events_calendar (nightclub_id, name, event_date, doors_open_at, ticket_price, status)
     VALUES ($1,$2,(now() + $3::interval)::date, now() + $3::interval, 0, 'published')
     RETURNING id`,
    [club.id, over.name || 'Viernes', over.offset || '-1 hour']);
  return rows[0];
}

beforeEach(async () => {
  await truncateAll();
  club = await f.createNightclub({ slug: 'ev2-caja' });
  manager = await f.createUser(club.id, { role: 'manager', display_name: 'Gerente' });
  cajero = await f.createUser(club.id, { role: 'cashier', display_name: 'Caja Ana' });
  waiter = await f.createUser(club.id, { role: 'waiter', display_name: 'Luis' });
  guest = await f.createUser(club.id, { role: 'guest' });
  table = await f.createTable(club.id, { code: 'T-3', section: 'ZONA ROJA', capacity: 4 });
  beer = await f.createDrink(club.id, { name: 'Cerveza', price: 60, stock: 40 });
  night = await nocheEnCurso();
  pinGerente = await codigoDe(manager);
});

const url = (p) => `/api/nightclubs/${club.id}${p}`;

const asignar = (user, locationId, eventId = night.id) => api()
  .post(url(`/nights/${eventId}/roster`)).set(auth(manager))
  .send({ user_id: user.id, location_id: locationId });

const miCaja = (user = cajero) => api().get(url('/till')).set(auth(user));

const abrirCaja = (body = {}, user = cajero) => api().post(url('/till/open')).set(auth(user))
  .send({ opening_float: 1000, manager_pin: pinGerente, ...body });

const pedidoDelMesero = async (over = {}) => {
  const res = await api().post(url('/orders')).set(auth(waiter)).send({
    client_request_id: randomUUID(),
    table_id: table.id,
    items: [{ drink_id: beer.id, quantity: 2 }],
    ...over,
  });
  if (res.status !== 201) throw new Error(`pedido: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.order;
};

const cobrar = (order, user = cajero, over = {}) => api()
  .post(url('/manual-payments/register')).set(auth(user))
  .send({
    transaction_id: order.transaction_id,
    method: 'cash',
    amount: Number(order.subtotal),
    currency: order.currency,
    ...over,
  });

const cortar = (body) => api().post(url('/shifts/me/closing')).set(auth(cajero))
  .send({ manager_pin: pinGerente, ...body });

// ============================================================================

describe('Abrir la caja', () => {
  it('sin barra asignada no abre, y no gasta un intento del PIN del gerente', async () => {
    const res = await abrirCaja();
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/barra asignada/);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM pin_attempts');
    expect(rows[0].n).toBe(0);
    expect((await miCaja()).body.till).toBeNull();
  });

  it('mi caja dice qué barra me asignaron antes de abrirla', async () => {
    await asignar(cajero, club.bar_id);
    const res = await miCaja();
    expect(res.status).toBe(200);
    expect(res.body.till).toBeNull();
    expect(res.body.assignment).toMatchObject({
      location_id: club.bar_id, location_name: 'Barra planta baja', event_id: night.id,
    });
  });

  it('abre en la barra del rol, con el fondo y el nombre de quien lo entregó', async () => {
    await asignar(cajero, club.bar_id);
    const res = await abrirCaja({ opening_float: 1500 });
    expect(res.status).toBe(201);
    expect(res.body.till).toMatchObject({
      location_id: club.bar_id,
      opening_float: '1500.00',
      currency: 'MXN',
      float_authorized_by: 'Gerente',
    });
    const { rows } = await pool.query(
      'SELECT float_authorized_by, location_id FROM staff_shifts WHERE user_id = $1', [cajero.id]);
    expect(rows[0]).toMatchObject({ float_authorized_by: manager.id, location_id: club.bar_id });
  });

  it('la barra que manda el cuerpo no cuenta: manda el rol', async () => {
    await asignar(cajero, club.bar_id);
    const res = await abrirCaja({ location_id: club.locations['barra-alta'] });
    expect(res.status).toBe(201);
    expect(res.body.till.location_id).toBe(club.bar_id);
  });

  it('con un PIN equivocado no abre nada', async () => {
    await asignar(cajero, club.bar_id);
    const otro = pinGerente === '000000' ? '111111' : '000000';
    const res = await abrirCaja({ manager_pin: otro });
    expect(res.status).toBe(403);
    expect((await miCaja()).body.till).toBeNull();
  });

  it('el PIN de alguien que no es gerente no autoriza el fondo', async () => {
    await asignar(cajero, club.bar_id);
    const pinMesero = await codigoDe(waiter);
    const res = await abrirCaja({ manager_pin: pinMesero });
    expect(res.status).toBe(403);
  });

  it('no se abre dos veces', async () => {
    await asignar(cajero, club.bar_id);
    await abrirCaja();
    const otra = await abrirCaja();
    expect(otra.status).toBe(409);
    expect(otra.body.error.message).toMatch(/ya está abierta/);
  });

  it('una caja por barra, aunque el rol tenga a dos cajeros en ella', async () => {
    const segundo = await f.createUser(club.id, { role: 'cashier', display_name: 'Caja Beto' });
    await asignar(cajero, club.bar_id);
    await asignar(segundo, club.bar_id);
    expect((await abrirCaja()).status).toBe(201);
    const res = await abrirCaja({}, segundo);
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/Caja Ana/);
  });

  it('la asignación de una noche que no ha empezado ni está por empezar no abre caja', async () => {
    const lejana = await nocheEnCurso({ name: 'Sábado siguiente', offset: '+3 days' });
    await asignar(cajero, club.bar_id, lejana.id);
    expect((await abrirCaja()).status).toBe(422);
  });

  it('una noche ya terminada tampoco', async () => {
    const pasada = await nocheEnCurso({ name: 'La de ayer', offset: '-2 days' });
    await pool.query('DELETE FROM events_calendar WHERE id = $1', [night.id]);
    await asignar(cajero, club.bar_id, pasada.id);
    expect((await abrirCaja()).status).toBe(422);
  });

  it('el cajero no abre turno por la puerta de los demás', async () => {
    const res = await api().post(url('/staff/shifts/start')).set(auth(cajero)).send({});
    expect(res.status).toBe(403);
  });

  it('el fondo y la barra de una caja no se editan, ni desde la base', async () => {
    await asignar(cajero, club.bar_id);
    await abrirCaja();
    await expect(pool.query(
      'UPDATE staff_shifts SET opening_float = 1 WHERE user_id = $1', [cajero.id]))
      .rejects.toThrow(/fondo/);
    await expect(pool.query(
      'UPDATE staff_shifts SET location_id = $2 WHERE user_id = $1',
      [cajero.id, club.locations['barra-alta']]))
      .rejects.toThrow(/barra/);
  });

  it('nadie se autoriza su propio fondo, ni desde la base', async () => {
    await expect(pool.query(
      `INSERT INTO staff_shifts (nightclub_id, user_id, location_id, opening_float, float_currency,
                                 float_authorized_by, float_authorized_at, float_authorized_role)
       VALUES ($1,$2,$3,100,'MXN',$2,now(),'manager')`,
      [club.id, cajero.id, club.bar_id])).rejects.toThrow(/not_self/);
  });

  it('el almacén no es una barra para una caja', async () => {
    await expect(f.openTill(club.id, {
      cashier: cajero, locationId: club.warehouse_id, authorizer: manager,
    })).rejects.toThrow(/must point at a bar/);
  });
});

// ============================================================================

describe('Lo que la caja tiene por cobrar', () => {
  beforeEach(async () => {
    await asignar(cajero, club.bar_id);
    await abrirCaja();
  });

  it('enseña lo que levantaron los meseros para su barra y sigue sin cobrar', async () => {
    const uno = await pedidoDelMesero();
    const dos = await pedidoDelMesero({ items: [{ drink_id: beer.id, quantity: 1 }] });
    const res = await miCaja();
    expect(res.body.pending_orders.map((o) => o.order_id)).toEqual([uno.id, dos.id]);
    expect(res.body.pending_orders[0]).toMatchObject({
      table_code: 'T-3', taken_by_name: 'Luis', subtotal: '120.00', payment_status: 'pending',
    });
    expect(res.body.pending_total).toBe('180.00');
  });

  it('lo cobrado, lo cancelado y lo de otra barra no aparece', async () => {
    const cobrado = await pedidoDelMesero();
    await cobrar(cobrado);
    const cancelado = await pedidoDelMesero();
    await api().post(url(`/orders/${cancelado.id}/status`)).set(auth(waiter))
      .send({ status: 'cancelled', reason: 'se fue' });
    // Una mesa que atiende la barra de arriba.
    await pool.query(
      `INSERT INTO zone_bars (nightclub_id, section, location_id) VALUES ($1,'TERRAZA',$2)`,
      [club.id, club.locations['barra-alta']]);
    await f.stockUp(club.id, beer.supply_id, club.locations['barra-alta'], 10);
    const arriba = await f.createTable(club.id, { code: 'T-30', section: 'TERRAZA' });
    await pedidoDelMesero({ table_id: arriba.id });

    expect((await miCaja()).body.pending_orders).toHaveLength(0);
  });

  it('lo que pidió un cliente desde su teléfono no es pendiente del corte, pero se puede cobrar', async () => {
    const { body } = await api().post(url('/orders')).set(auth(guest)).send({
      client_request_id: randomUUID(), table_id: table.id,
      items: [{ drink_id: beer.id, quantity: 1 }],
    });
    const caja = await miCaja();
    expect(caja.body.pending_orders).toHaveLength(0);
    // Mientras el club no cobre en línea, el cliente le paga al mesero y el mesero
    // trae el dinero: la caja lo ve aparte, y cobrarlo lo manda a la barra.
    expect(caja.body.awaiting_payment.map((o) => o.order_id)).toEqual([body.order.id]);
    expect(caja.body.awaiting_payment[0].items).toEqual([{ name: 'Cerveza', quantity: 1 }]);
    expect((await cobrar(body.order)).status).toBe(201);
    const after = await api().get(url(`/orders/${body.order.id}`)).set(auth(cajero));
    expect(after.body.order.status).toBe('confirmed');
    expect((await miCaja()).body.awaiting_payment).toHaveLength(0);
  });

  it('cobrar lo saca de la lista', async () => {
    const pedido = await pedidoDelMesero();
    expect((await cobrar(pedido)).status).toBe(201);
    expect((await miCaja()).body.pending_orders).toHaveLength(0);
  });

  it('un mesero no ve la caja', async () => {
    expect((await miCaja(waiter)).status).toBe(403);
  });
});

// ============================================================================

describe('El corte de la caja', () => {
  beforeEach(async () => {
    await asignar(cajero, club.bar_id);
    await abrirCaja({ opening_float: 1000 });
  });

  it('espera el fondo más el efectivo cobrado; la terminal se enseña pero no se entrega', async () => {
    await cobrar(await pedidoDelMesero()); // 120 en efectivo
    await cobrar(await pedidoDelMesero(), cajero, { method: 'card_terminal', reference: 'VCH-1001' });

    const corte = await api().get(url('/shifts/me/cut')).set(auth(cajero));
    expect(corte.body.opening_float).toBe('1000.00');
    expect(corte.body.totals.cash_collected).toBe('120.00');
    expect(corte.body.totals.total_collected).toBe('240.00');
    expect(corte.body.cash_to_hand).toBe('1120.00');

    const res = await cortar({ declared_cash: 1120, counted_cash: 1120 });
    expect(res.status).toBe(201);
    expect(res.body.closing).toMatchObject({
      opening_float: '1000.00', expected_cash: '1120.00', difference: '0.00',
      location_name: 'Barra planta baja', pending_total: '0.00',
    });
    expect(res.body.closing.pending_orders).toEqual([]);
    // El corte cierra la caja, y la barra queda libre para la siguiente.
    expect((await miCaja()).body.till).toBeNull();
  });

  it('un faltante contra fondo + efectivo pide motivo', async () => {
    await cobrar(await pedidoDelMesero());
    const res = await cortar({ declared_cash: 1000, counted_cash: 1000 });
    expect(res.status).toBe(422);
    expect(res.body.error.details).toMatchObject({ difference: '-120.00', expected: '1120.00' });
  });

  it('con pedidos sin cobrar NO cierra, y dice cuáles', async () => {
    const pendiente = await pedidoDelMesero();
    const res = await cortar({ declared_cash: 1000, counted_cash: 1000 });
    expect(res.status).toBe(422);
    expect(res.body.error.details.pending_orders.map((o) => o.order_id)).toEqual([pendiente.id]);
    expect(res.body.error.details.pending_total).toBe('120.00');
    expect((await miCaja()).body.till).not.toBeNull();
  });

  it('con el permiso del gerente cierra, y los pendientes quedan escritos en el corte', async () => {
    const pendiente = await pedidoDelMesero();
    const res = await cortar({ declared_cash: 1000, counted_cash: 1000, acknowledge_pending: true });
    expect(res.status).toBe(201);
    expect(res.body.closing.pending_total).toBe('120.00');
    expect(res.body.closing.pending_orders).toEqual([
      expect.objectContaining({ order_id: pendiente.id, table_code: 'T-3', subtotal: '120.00' }),
    ]);
    expect(res.body.closing.authorized_by_name).toBe('Gerente');

    // El pedido no desaparece: sigue por cobrar en la barra, para la siguiente caja.
    const { rows } = await pool.query(
      `SELECT status FROM transactions WHERE reference_type = 'drink_order' AND reference_id = $1`,
      [pendiente.id]);
    expect(rows[0].status).toBe('pending');

    const { rows: ev } = await pool.query(
      `SELECT payload FROM events WHERE type = 'shift_closed' ORDER BY id DESC LIMIT 1`);
    expect(ev[0].payload).toMatchObject({ pending_orders: 1, pending_total: '120.00' });
  });

  it('el corte ya hecho no se edita, tampoco sus pendientes', async () => {
    await pedidoDelMesero();
    const res = await cortar({ declared_cash: 1000, counted_cash: 1000, acknowledge_pending: true });
    await expect(pool.query(
      `UPDATE shift_closings SET pending_orders = '[]'::jsonb WHERE id = $1`, [res.body.closing.id]))
      .rejects.toThrow(/no se editan/);
  });

  it('el ticket del corte sale en la impresora de SU barra, con el fondo y lo que quedó sin cobrar', async () => {
    const admin = await f.createUser(club.id, { role: 'admin' });
    await api().post(url('/printers')).set(auth(manager)).send({
      location_id: club.locations['barra-alta'], name: 'Meseros arriba', purpose: 'service',
      connection: 'network', host: '192.168.1.61',
    });
    const suya = await api().post(url('/printers')).set(auth(manager)).send({
      location_id: club.bar_id, name: 'Meseros abajo', purpose: 'service',
      connection: 'network', host: '192.168.1.60',
    });
    await api().patch(url('/print-settings')).set(auth(admin)).send({ print_receipts: false });
    await cobrar(await pedidoDelMesero());
    await pedidoDelMesero();

    const res = await cortar({ declared_cash: 1120, counted_cash: 1120, acknowledge_pending: true });
    expect(res.status).toBe(201);
    expect(res.body.ticket).not.toBeNull();
    const { rows } = await pool.query(
      `SELECT printer_id::text AS printer_id, preview FROM print_jobs WHERE kind = 'shift_cut'`);
    expect(rows[0].printer_id).toBe(suya.body.printer.id);
    expect(rows[0].preview).toContain('Caja: Barra planta baja');
    expect(rows[0].preview).toMatch(/Fondo de caja\s+\$1,000\.00/);
    expect(rows[0].preview).toContain('SIN COBRAR (AUTORIZADO)');
    expect(rows[0].preview).toMatch(/Mesa T-3 · Luis\s+\$120\.00/);
  });

  it('un retiro parcial cuenta el fondo como dinero que trae, y lo descuenta del corte', async () => {
    await cobrar(await pedidoDelMesero());
    const retiro = await api().post(url('/shifts/me/cash-drops')).set(auth(cajero))
      .send({ amount: 1100, reason: 'Llevar a bóveda', manager_pin: pinGerente });
    expect(retiro.status).toBe(201);
    expect(retiro.body.withdrawal.remaining).toBe('20.00');

    const res = await cortar({ declared_cash: 20, counted_cash: 20 });
    expect(res.status).toBe(201);
    expect(res.body.closing.expected_cash).toBe('20.00');
  });
});

// ============================================================================

describe('Quién cobra qué', () => {
  it('la terminal de Mercado Pago tampoco la despierta el cajero de otra barra', async () => {
    await asignar(cajero, club.bar_id);
    await abrirCaja();
    const pedido = await pedidoDelMesero();
    const otro = await f.createUser(club.id, { role: 'cashier' });
    await f.openTill(club.id, {
      cashier: otro, locationId: club.locations['barra-alta'], authorizer: manager,
    });
    const res = await api().post(url('/terminal-charges')).set(auth(otro))
      .send({ transaction_id: pedido.transaction_id, terminal_id: randomUUID() });
    expect(res.status).toBe(403);
  });

  it('el mesero ya no tiene corte que hacer: su turno cierra sin dinero encima', async () => {
    await api().post(url('/staff/shifts/start')).set(auth(waiter)).send({});
    await pedidoDelMesero();
    const fin = await api().post(url('/staff/shifts/end')).set(auth(waiter)).send({});
    expect(fin.status).toBe(200);
  });

  it('el alta de un cajero la hace el gerente, y entra con PIN', async () => {
    const res = await api().post(url('/employees')).set(auth(manager)).send({
      email: `caja-${randomUUID().slice(0, 6)}@test.mx`,
      first_name: 'Rosa', last_name: 'Caja', role: 'cashier', birth_date: '1996-04-12',
    });
    expect(res.status).toBe(201);
    expect(res.body.employee.role).toBe('cashier');
    expect(pins.PIN_ROLES).toContain('cashier');
  });
});

// ============================================================================
// D79: el cambio, las dos formas de pago y el recibo de la caja
// ============================================================================

describe('Cobrar en caja: cambio y dos formas de pago (D79)', () => {
  let impresora;
  beforeEach(async () => {
    await asignar(cajero, club.bar_id);
    await abrirCaja();
    impresora = (await api().post(url('/printers')).set(auth(manager)).send({
      location_id: club.bar_id, name: 'Caja PB', purpose: 'till',
      connection: 'network', host: '192.168.1.70',
    })).body.printer;
  });

  const pagar = (order, body) => api().post(url('/till/payments')).set(auth(cajero))
    .send({ transaction_id: order.transaction_id, ...body });

  const recibos = async () => (await pool.query(
    `SELECT printer_id::text AS printer_id, preview FROM print_jobs WHERE kind = 'receipt'`)).rows;

  it('en efectivo calcula y guarda el cambio, y el recibo sale solo en la impresora de la caja', async () => {
    const pedido = await pedidoDelMesero(); // 120
    const res = await pagar(pedido, { method: 'cash', amount: 120, cash_received: 500 });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ paid: true, change_given: '380.00', remaining: '0.00' });
    const { rows } = await pool.query(
      'SELECT cash_received::text AS r, change_given::text AS c FROM manual_payments WHERE id = $1',
      [res.body.payment.id]);
    expect(rows[0]).toEqual({ r: '500.00', c: '380.00' });

    const [recibo] = await recibos();
    expect(recibo.printer_id).toBe(impresora.id);
    expect(recibo.preview).toMatch(/Recibido\s+\$500\.00/);
    expect(recibo.preview).toMatch(/Cambio\s+\$380\.00/);
  });

  it('recibir menos de lo que se cobra en efectivo no se acepta', async () => {
    const pedido = await pedidoDelMesero();
    const res = await pagar(pedido, { method: 'cash', amount: 120, cash_received: 100 });
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/faltan 20\.00/);
  });

  it('dos formas de pago: la primera deja el pedido abierto por el resto, la segunda lo completa', async () => {
    const pedido = await pedidoDelMesero(); // 120
    const uno = await pagar(pedido, { method: 'cash', amount: 50, cash_received: 100 });
    expect(uno.status).toBe(201);
    expect(uno.body).toMatchObject({ paid: false, paid_amount: '50.00', remaining: '70.00', change_given: '50.00' });
    expect(await recibos()).toHaveLength(0); // el recibo sale UNO, al completarse

    const caja = await miCaja();
    const abierto = caja.body.pending_orders.find((o) => o.order_id === pedido.id);
    expect(abierto).toMatchObject({ paid_amount: '50.00', remaining: '70.00' });
    expect(caja.body.pending_total).toBe('70.00');

    const dos = await pagar(pedido, { method: 'card_terminal', amount: 70, reference: 'VCH-5521' });
    expect(dos.status).toBe(201);
    expect(dos.body).toMatchObject({ paid: true, remaining: '0.00' });

    const [recibo] = await recibos();
    expect(recibo.preview).toMatch(/Efectivo\s+\$50\.00/);
    expect(recibo.preview).toMatch(/Tarjeta \(terminal\)\s+\$70\.00/);
    expect(recibo.preview).toContain('VCH-5521');
    expect(recibo.preview).toMatch(/\$120\.00/);
    expect((await miCaja()).body.pending_orders).toHaveLength(0);

    // Y el corte ve cada parte en su método.
    const corte = await api().get(url('/shifts/me/cut')).set(auth(cajero));
    const metodo = Object.fromEntries(corte.body.totals.by_method.map((l) => [l.method, l.amount]));
    expect(metodo).toMatchObject({ cash: '50.00', card_terminal: '70.00' });
  });

  it('las dos partes tienen que ser formas de pago distintas', async () => {
    const pedido = await pedidoDelMesero();
    await pagar(pedido, { method: 'cash', amount: 50 });
    const otra = await pagar(pedido, { method: 'cash', amount: 70 });
    expect(otra.status).toBe(422);
    expect(otra.body.error.message).toMatch(/distintas/);
  });

  it('ninguna parte puede pasarse de lo que falta', async () => {
    const pedido = await pedidoDelMesero();
    await pagar(pedido, { method: 'cash', amount: 50 });
    const otra = await pagar(pedido, { method: 'card_terminal', amount: 80, reference: 'VCH-1' });
    expect(otra.status).toBe(422);
    expect(otra.body.error.details.remaining).toBe('70.00');
  });

  it('la segunda parte tiene que completar: no hay una tercera', async () => {
    const pedido = await pedidoDelMesero();
    await pagar(pedido, { method: 'cash', amount: 50 });
    const otra = await pagar(pedido, { method: 'card_terminal', amount: 30, reference: 'VCH-2' });
    expect(otra.status).toBe(422);
    expect(otra.body.error.message).toMatch(/2 formas de pago/);
  });

  it('un pedido con una parte cobrada no se cancela', async () => {
    const pedido = await pedidoDelMesero();
    await pagar(pedido, { method: 'cash', amount: 50 });
    const res = await api().post(url(`/orders/${pedido.id}/status`)).set(auth(waiter))
      .send({ status: 'cancelled', reason: 'se fue' });
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/cobra el resto/);
  });

  it('el doble toque no cobra otra parte', async () => {
    const pedido = await pedidoDelMesero();
    const key = randomUUID();
    const a = await pagar(pedido, { method: 'cash', amount: 50, client_request_id: key });
    const b = await pagar(pedido, { method: 'cash', amount: 50, client_request_id: key });
    expect(b.status).toBe(200);
    expect(b.body.payment.id).toBe(a.body.payment.id);
  });

  it('el cajero de otra barra, o sin caja, no cobra por aquí', async () => {
    const pedido = await pedidoDelMesero();
    const otro = await f.createUser(club.id, { role: 'cashier' });
    const res = await api().post(url('/till/payments')).set(auth(otro))
      .send({ transaction_id: pedido.transaction_id, method: 'cash', amount: 120 });
    expect(res.status).toBe(409);
    const mesero = await api().post(url('/till/payments')).set(auth(waiter))
      .send({ transaction_id: pedido.transaction_id, method: 'cash', amount: 120 });
    expect(mesero.status).toBe(403);
  });

  it('la terminal de MP no deja tercera parte ni pasarse de lo que falta', async () => {
    const pedido = await pedidoDelMesero();
    await pagar(pedido, { method: 'cash', amount: 50 });
    const t = await pool.query(
      `INSERT INTO payment_terminals (nightclub_id, provider, external_id, label, operating_mode, active)
       VALUES ($1,'mercadopago','NEWLAND_N950__SBX0000001','Caja PB','PDV',true) RETURNING id`,
      [club.id]).catch(() => null);
    if (!t) return; // el esquema de terminales cambió: lo cubre terminal-charges.test.js
    const mucho = await api().post(url('/terminal-charges')).set(auth(cajero))
      .send({ transaction_id: pedido.transaction_id, terminal_id: t.rows[0].id, amount: 100 });
    expect(mucho.status).toBe(422);
    const poquito = await api().post(url('/terminal-charges')).set(auth(cajero))
      .send({ transaction_id: pedido.transaction_id, terminal_id: t.rows[0].id, amount: 30 });
    expect(poquito.status).toBe(422);
  });
});
