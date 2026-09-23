/**
 * Los tres papeles del servicio: comanda, cuenta y recibo (D53).
 *
 * La prueba que manda en este archivo es la primera: **que no salga un papel nunca
 * puede impedir que se sirva un trago o se cobre una cuenta.** Un club sin impresoras
 * —que es como está hoy, y como estará cualquier club nuevo— tiene que funcionar
 * exactamente igual que antes de esta función.
 *
 * Lo demás es qué dice cada papel y a dónde va, que es donde se nota si alguien lo
 * pensó: la comanda sin precios porque el bartender no cobra, la cuenta diciendo que
 * no es un comprobante, y el recibo saliendo por los tres caminos de cobro sin que
 * haya que acordarse de enchufarlo en cada uno.
 */
'use strict';

const { randomUUID } = require('crypto');
const { setupSchema, truncateAll, closePool, pool } = require('./helpers/db');
const { api, auth } = require('./helpers/api');
const f = require('./helpers/factories');
const tickets = require('../src/services/tickets');

let club; let guest; let waiter; let bartender; let manager; let admin; let table; let beer; let shot;

beforeAll(setupSchema);
afterAll(closePool);

beforeEach(async () => {
  await truncateAll();
  club = await f.createNightclub({ slug: 'ev2-tickets' });
  guest = await f.createUser(club.id, { role: 'guest' });
  waiter = await f.createUser(club.id, { role: 'waiter', display_name: 'Luis' });
  bartender = await f.createUser(club.id, { role: 'bartender', display_name: 'Sol' });
  manager = await f.createUser(club.id, { role: 'manager' });
  admin = await f.createUser(club.id, { role: 'admin' });
  table = await f.createTable(club.id, { code: 'T-7', section: 'TERRAZA', capacity: 4 });
  beer = await f.createDrink(club.id, { name: 'Cerveza Coronita', price: 60, stock: 40 });
  shot = await f.createDrink(club.id, { name: 'Tequila añejo', price: 180, stock: 20 });
});

const url = (p) => `/api/nightclubs/${club.id}${p}`;

/** Una impresora como la daría de alta el gerente. Por omisión, la de meseros. */
async function altaImpresora(over = {}) {
  const res = await api().post(url('/printers')).set(auth(manager)).send({
    location_id: club.bar_id,
    name: `Impresora ${Math.random().toString(16).slice(2, 8)}`,
    purpose: 'service',
    connection: 'network',
    host: '192.168.1.50',
    ...over,
  });
  return res.body.printer;
}

/** La zona de la mesa la atiende esta barra: es lo que enruta el papel. */
const atender = (locationId = club.bar_id, section = 'TERRAZA') => pool.query(
  `INSERT INTO zone_bars (nightclub_id, section, location_id) VALUES ($1,$2::text,$3)
   ON CONFLICT (nightclub_id, section) DO UPDATE SET location_id = EXCLUDED.location_id`,
  [club.id, section, locationId]);

const prenderComandas = () => api().patch(url('/print-settings')).set(auth(admin))
  .send({ print_order_tickets: true });

const pedir = (over = {}) => api().post(url('/orders')).set(auth(waiter)).send({
  client_request_id: randomUUID(),
  table_id: table.id,
  items: [{ drink_id: beer.id, quantity: 2 }],
  ...over,
});

const chargeOf = async (orderId) => {
  const { rows } = await pool.query(
    `SELECT id, amount::text AS amount, currency FROM transactions
      WHERE reference_type = 'drink_order' AND reference_id = $1`, [orderId]);
  return rows[0];
};

const cobrar = async (orderId, over = {}) => {
  const cargo = await chargeOf(orderId);
  return api().post(url('/manual-payments/register')).set(auth(waiter)).send({
    transaction_id: cargo.id,
    method: 'cash',
    amount: Number(cargo.amount),
    currency: cargo.currency,
    ...over,
  });
};

const confirmar = (orderId, by) => api().post(url(`/orders/${orderId}/status`))
  .set(auth(by || bartender)).send({ status: 'confirmed' });

const estadoDe = async (orderId) => {
  const { rows } = await pool.query('SELECT status FROM drink_orders WHERE id = $1', [orderId]);
  return rows[0].status;
};

const jobs = async (kind = null) => {
  const { rows } = await pool.query(
    `SELECT kind, preview, ref_id::text AS ref_id, printer_id::text AS printer_id, copies
       FROM print_jobs WHERE nightclub_id = $1 AND ($2::text IS NULL OR kind = $2::text)
      ORDER BY created_at`, [club.id, kind]);
  return rows;
};

// ============================================================================

describe('Un club sin impresoras sigue trabajando igual', () => {
  it('se pide y se cobra sin una sola impresora dada de alta', async () => {
    // Es el caso de HOY y el de cualquier club nuevo. Si esto falla, esta función no
    // agregó una capacidad: rompió el club.
    const pedido = await pedir();
    expect(pedido.status).toBe(201);
    const pago = await cobrar(pedido.body.order.id);
    expect(pago.status).toBe(201);
    expect(await estadoDe(pedido.body.order.id)).toBe('confirmed');
    expect(await jobs()).toHaveLength(0);
  });

  it('con las comandas prendidas pero sin impresora, el cobro pasa igual', async () => {
    await prenderComandas();
    const pedido = await pedir();
    expect((await cobrar(pedido.body.order.id)).status).toBe(201);
    expect(await estadoDe(pedido.body.order.id)).toBe('confirmed');
    expect(await jobs()).toHaveLength(0);
  });

  it('una impresora apagada no deja un cobro a medias', async () => {
    const impresora = await altaImpresora();
    await atender();
    await api().patch(url(`/printers/${impresora.id}`)).set(auth(manager))
      .send({ active: false });

    const pedido = await pedir();
    const pago = await cobrar(pedido.body.order.id);
    // El cobro es lo que NO puede fallar: el dinero ya está en la bolsa del mesero.
    expect(pago.status).toBe(201);
    const { rows } = await pool.query(
      `SELECT status FROM transactions WHERE reference_type = 'drink_order'
         AND reference_id = $1`, [pedido.body.order.id]);
    expect(rows[0].status).toBe('paid');
  });
});

describe('La comanda de la barra', () => {
  beforeEach(async () => {
    await prenderComandas();
    await altaImpresora({ purpose: 'orders', name: 'Barra · comandas' });
    await altaImpresora({ purpose: 'service', name: 'Barra · meseros', host: '192.168.1.51' });
    await atender();
  });

  it('sale al PAGAR, no al pedir: pagar es lo que manda el trago a la barra', async () => {
    const pedido = await pedir();
    expect(await jobs('order')).toHaveLength(0);

    await cobrar(pedido.body.order.id);
    const [comanda] = await jobs('order');
    expect(comanda.ref_id).toBe(pedido.body.order.id);
  });

  it('un trago de cortesía, que no se cobra, también llega en papel a la barra', async () => {
    // Sin nada que cobrar el pedido no pasa por `settle()`: lo confirma el personal a
    // mano. Ese camino también tiene que sacar su comanda, o la barra no se entera.
    const gratis = await f.createDrink(club.id, { name: 'Agua de la casa', price: 0, stock: 10 });
    const pedido = await pedir({ items: [{ drink_id: gratis.id, quantity: 1 }] });
    expect((await confirmar(pedido.body.order.id)).status).toBe(200);
    const [comanda] = await jobs('order');
    expect(comanda.preview).toContain('Agua de la casa');
  });

  it('lleva la mesa y las cantidades, y NO lleva precios', async () => {
    const pedido = await pedir({
      items: [{ drink_id: beer.id, quantity: 2 }, { drink_id: shot.id, quantity: 1 }],
    });
    await cobrar(pedido.body.order.id);
    const [comanda] = await jobs('order');

    expect(comanda.preview).toContain('MESA T-7');
    expect(comanda.preview).toContain('TERRAZA');
    expect(comanda.preview).toContain('2   Cerveza Coronita');
    expect(comanda.preview).toContain('1   Tequila añejo');
    // El bartender no cobra: un importe en la comanda es ruido en el único papel que
    // tiene que leerse de un vistazo, de lado y con las manos ocupadas.
    expect(comanda.preview).not.toContain('60.00');
    expect(comanda.preview).not.toContain('$');
  });

  it('dice quién tomó el pedido y la nota del cliente', async () => {
    const pedido = await pedir({ message: 'Sin hielo, por favor' });
    await cobrar(pedido.body.order.id);
    const [comanda] = await jobs('order');
    expect(comanda.preview).toContain('Tomó: Luis');
    expect(comanda.preview).toContain('NOTA: Sin hielo');
  });

  it('va a la impresora de comandas, no a la de meseros', async () => {
    const pedido = await pedir();
    await cobrar(pedido.body.order.id);
    const [comanda] = await jobs('order');
    const { rows } = await pool.query('SELECT purpose FROM printers WHERE id = $1',
      [comanda.printer_id]);
    expect(rows[0].purpose).toBe('orders');
  });

  it('con el interruptor apagado no sale, y el pedido se confirma igual', async () => {
    await api().patch(url('/print-settings')).set(auth(admin))
      .send({ print_order_tickets: false });
    const pedido = await pedir();
    expect((await cobrar(pedido.body.order.id)).status).toBe(201);
    expect(await jobs('order')).toHaveLength(0);
  });

  it('un pedido cancelado no manda nada a la barra', async () => {
    const pedido = await pedir();
    await api().post(url(`/orders/${pedido.body.order.id}/status`)).set(auth(waiter))
      .send({ status: 'cancelled', reason: 'se arrepintió' });
    expect(await jobs('order')).toHaveLength(0);
  });
});

describe('La cuenta de la mesa', () => {
  beforeEach(async () => {
    await altaImpresora({ purpose: 'service', name: 'Barra · meseros' });
    await atender();
  });

  it('junta todo lo de la mesa, con lo pagado aparte de lo que falta', async () => {
    const uno = await pedir({ items: [{ drink_id: beer.id, quantity: 2 }] });
    const dos = await pedir({ items: [{ drink_id: shot.id, quantity: 1 }] });
    await cobrar(uno.body.order.id);

    const res = await api().get(url(`/tables/${table.id}/bill`)).set(auth(waiter));
    expect(res.status).toBe(200);
    expect(res.body.bill).toMatchObject({ total: '300.00', paid: '120.00', due: '180.00' });
    expect(res.body.bill.lines.map((l) => l.name).sort())
      .toEqual(['Cerveza Coronita', 'Tequila añejo']);
    expect(dos.body.order.id).toBeDefined();
  });

  it('junta el mismo trago pedido dos veces en un solo renglón', async () => {
    await pedir({ items: [{ drink_id: beer.id, quantity: 2 }] });
    await pedir({ items: [{ drink_id: beer.id, quantity: 3 }] });
    const res = await api().get(url(`/tables/${table.id}/bill`)).set(auth(waiter));
    expect(res.body.bill.lines).toHaveLength(1);
    expect(res.body.bill.lines[0]).toMatchObject({ quantity: 5, amount: '300.00' });
  });

  it('lo cancelado no se cobra', async () => {
    const uno = await pedir();
    await api().post(url(`/orders/${uno.body.order.id}/status`)).set(auth(waiter))
      .send({ status: 'cancelled', reason: 'se fue' });
    const res = await api().get(url(`/tables/${table.id}/bill`)).set(auth(waiter));
    expect(res.body.bill.total).toBe('0.00');
  });

  it('cuenta desde que esa gente se sentó, no desde la medianoche', async () => {
    // Lo de los que ya se fueron no es de los que acaban de llegar. Sin esta regla, la
    // primera cuenta de la noche siguiente traería la de la mesa anterior.
    const viejo = await pedir();
    await pool.query(
      `UPDATE drink_orders SET created_at = now() - interval '3 hours' WHERE id = $1`,
      [viejo.body.order.id]);
    await api().post(url(`/tables/${table.id}/seat`)).set(auth(waiter))
      .send({ user_id: guest.id });
    await pedir({ items: [{ drink_id: shot.id, quantity: 1 }] });

    const res = await api().get(url(`/tables/${table.id}/bill`)).set(auth(waiter));
    expect(res.body.bill.seated).toBe(true);
    expect(res.body.bill.total).toBe('180.00');
  });

  it('se imprime y dice, en el papel, que no es un comprobante de pago', async () => {
    await pedir();
    const res = await api().post(url(`/tables/${table.id}/bill/print`)).set(auth(waiter));
    expect(res.status).toBe(202);
    const [cuenta] = await jobs('bill');
    expect(cuenta.preview).toContain('CUENTA');
    expect(cuenta.preview).toContain('Mesa T-7');
    expect(cuenta.preview).toContain('$120.00');
    expect(cuenta.preview).toMatch(/no es un comprobante de pago/i);
  });

  it('sin impresora para esa zona lo dice, en vez de dejar al cliente esperando', async () => {
    // Esta es la excepción de la regla: la cuenta sale porque alguien picó un botón
    // con el cliente enfrente, así que callarse es peor que fallar.
    await pool.query('UPDATE printers SET active = false WHERE nightclub_id = $1', [club.id]);
    await pedir();
    const res = await api().post(url(`/tables/${table.id}/bill/print`)).set(auth(waiter));
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/impresora/i);
  });

  it('un invitado no puede pedir la cuenta de una mesa ajena', async () => {
    expect((await api().get(url(`/tables/${table.id}/bill`)).set(auth(guest))).status).toBe(403);
  });
});

describe('El recibo de cobro', () => {
  beforeEach(async () => {
    await altaImpresora({ purpose: 'service', name: 'Barra · meseros' });
    await atender();
  });

  it('sale cuando el mesero cobra en la mesa, con el método y el folio', async () => {
    const pedido = await pedir();
    await cobrar(pedido.body.order.id, { method: 'card_terminal', reference: 'VCH-99812' });
    const [recibo] = await jobs('receipt');
    expect(recibo.preview).toContain('RECIBO');
    expect(recibo.preview).toContain('Tarjeta (terminal)');
    expect(recibo.preview).toContain('VCH-99812');
    expect(recibo.preview).toContain('$120.00');
    expect(recibo.preview).toContain('Atendió');
    expect(recibo.preview).toContain('PAGADO');
  });

  it('sale también cuando el gerente confirma una transferencia', async () => {
    // El recibo está enganchado en `settle()`, por donde pasan los tres caminos de
    // cobro. Si mañana se agrega un cuarto, sale con recibo sin que nadie se acuerde.
    await api().post(url('/manual-payment-options')).set(auth(manager)).send({
      method: 'bank_transfer', label: 'Transferencia', instructions: 'CLABE 0123', active: true,
    });
    const pedido = await pedir();
    const cargo = await chargeOf(pedido.body.order.id);
    const declarado = await api().post(url('/manual-payments')).set(auth(waiter)).send({
      transaction_id: cargo.id,
      method: 'bank_transfer',
      amount: Number(cargo.amount),
      currency: cargo.currency,
      reference: 'SPEI-4411',
    });
    expect(declarado.status).toBe(201);
    expect(await jobs('receipt')).toHaveLength(0);

    await api().post(url(`/manual-payments/${declarado.body.payment.id}/confirm`))
      .set(auth(manager)).send({});
    const [recibo] = await jobs('receipt');
    expect(recibo.preview).toContain('Transferencia');
    expect(recibo.preview).toContain('SPEI-4411');
  });

  it('dice de qué era el cobro y en qué mesa', async () => {
    const pedido = await pedir();
    await cobrar(pedido.body.order.id);
    const [recibo] = await jobs('receipt');
    expect(recibo.preview).toContain('Consumo en mesa');
    expect(recibo.preview).toContain('Mesa T-7');
  });

  it('con los recibos apagados no sale, y el cobro se asienta igual', async () => {
    await api().patch(url('/print-settings')).set(auth(admin)).send({ print_receipts: false });
    const pedido = await pedir();
    expect((await cobrar(pedido.body.order.id)).status).toBe(201);
    expect(await jobs('receipt')).toHaveLength(0);
  });
});

describe('Cómo se lee el papel', () => {
  it('los importes llevan separador de miles, y la moneda cuando no es la de casa', () => {
    expect(tickets.money('1234.5')).toBe('$1,234.50');
    expect(tickets.money('980000')).toBe('$980,000.00');
    // "$" a secas junto a dólares es la confusión que termina en una discusión.
    expect(tickets.money('50', 'USD')).toBe('USD 50.00');
  });

  it('el folio son los últimos seis, que es lo que se canta por radio', () => {
    expect(tickets.folio('9f1c0c62-1a2b-4c3d-8e9f-00a1b2c3d4e5')).toBe('C3D4E5');
  });

  it('la hora sale en la del club, no en la del servidor', () => {
    const medianocheUTC = new Date('2026-09-23T06:30:00Z');
    // Hermosillo va siete horas atrás: las 06:30 UTC del 23 son las 23:30 del 22, y
    // el ticket tiene que decir la noche en que se imprimió, no la del meridiano.
    expect(tickets.localTime(medianocheUTC, 'America/Hermosillo')).toBe('22/09/2026 23:30');
  });

  it('una zona horaria mal escrita no deja sin fecha a todos los tickets', () => {
    expect(tickets.localTime(new Date('2026-09-23T06:30:00Z'), 'Marte/Olympus'))
      .toBe('2026-09-23 06:30');
  });
});
