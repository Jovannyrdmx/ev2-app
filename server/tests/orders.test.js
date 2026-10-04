'use strict';

const { randomUUID } = require('crypto');
const { setupSchema, truncateAll, closePool, pool } = require('./helpers/db');
const { api, auth } = require('./helpers/api');
const f = require('./helpers/factories');

let club; let guest; let other; let bartender; let waiter; let manager; let cashier; let table;
let beer; let shot;

beforeAll(setupSchema);
afterAll(closePool);
beforeEach(async () => {
  await truncateAll();
  club = await f.createNightclub({ slug: 'ev2-orders' });
  guest = await f.createUser(club.id, { role: 'guest' });
  other = await f.createUser(club.id, { role: 'guest' });
  bartender = await f.createUser(club.id, { role: 'bartender' });
  waiter = await f.createUser(club.id, { role: 'waiter' });
  manager = await f.createUser(club.id, { role: 'manager' });
  // La caja de la barra de planta baja, que es de donde salen los pedidos de estas
  // pruebas: desde D77 el dinero de los tragos lo recibe el cajero de cada barra.
  cashier = await f.createUser(club.id, { role: 'cashier' });
  await f.openTill(club.id, { cashier, locationId: club.bar_id, authorizer: manager });
  table = await f.createTable(club.id, { code: 'T-1', capacity: 4 });
  beer = await f.createDrink(club.id, { name: 'Cerveza', price: 60, stock: 10 });
  shot = await f.createDrink(club.id, { name: 'Tequila', price: 80, stock: 3 });
});

const url = (p) => `/api/nightclubs/${club.id}${p}`;
const newOrder = (over = {}) => ({
  client_request_id: randomUUID(),
  items: [{ drink_id: beer.id, quantity: 2 }],
  ...over,
});

/**
 * Existencia real de un producto: la del INSUMO del que sale. Desde la migración 018
 * el producto no tiene contador propio, y preguntarle a uno era justo el defecto.
 */
async function stockOf(drinkId, locationId = null) {
  const { rows } = await pool.query(
    `SELECT COALESCE(sum(ss.stock), 0)::float8 AS stock
       FROM drink_supplies ds
       JOIN supplies s ON s.id = ds.supply_id
       LEFT JOIN supply_stock ss ON ss.supply_id = s.id
        AND ($2::uuid IS NULL OR ss.location_id = $2::uuid)
      WHERE ds.drink_id = $1`, [drinkId, locationId]);
  return rows.length ? Number(rows[0].stock) : null;
}

/** Lo que ve la barra del cobro de un pedido. */
async function chargeOf(orderId) {
  const { rows } = await pool.query(
    `SELECT tx.id, tx.status, tx.amount::text AS amount, tx.currency, tx.payer_user_id
       FROM transactions tx
      WHERE tx.reference_type = 'drink_order' AND tx.reference_id = $1`, [orderId]);
  return rows[0] || null;
}

/**
 * Cobra el pedido como lo hace la caja de la barra (D77): efectivo en mano, registrado
 * en el acto. Es el camino real, no un UPDATE a la tabla — si esto se rompe, se rompe
 * también para el club.
 */
async function payFor(orderId, by) {
  const charge = await chargeOf(orderId);
  return api().post(url('/manual-payments/register')).set(auth(by || cashier)).send({
    transaction_id: charge.id,
    method: 'cash',
    amount: Number(charge.amount),
    currency: charge.currency,
  });
}

describe('POST /orders', () => {
  it('crea el pedido, congela precios y descuenta existencias', async () => {
    const res = await api().post(url('/orders')).set(auth(guest))
      .send(newOrder({ table_id: table.id, items: [{ drink_id: beer.id, quantity: 2 }] }));

    expect(res.status).toBe(201);
    expect(res.body.order.status).toBe('pending');
    expect(res.body.order.subtotal).toBe('120.00');
    expect(res.body.order.items[0]).toMatchObject({ name: 'Cerveza', quantity: 2, unit_price: '60.00' });
    expect(await stockOf(beer.id)).toBe(8);
  });

  it('conserva el precio pagado aunque la bebida suba de precio después', async () => {
    const res = await api().post(url('/orders')).set(auth(guest)).send(newOrder());
    await pool.query('UPDATE drinks SET price = 999 WHERE id = $1', [beer.id]);

    const after = await api().get(url(`/orders/${res.body.order.id}`)).set(auth(guest));
    expect(after.body.order.items[0].unit_price).toBe('60.00');
    expect(after.body.order.subtotal).toBe('120.00');
  });

  it('suma varias bebidas en un mismo pedido', async () => {
    const res = await api().post(url('/orders')).set(auth(guest)).send(newOrder({
      items: [{ drink_id: beer.id, quantity: 1 }, { drink_id: shot.id, quantity: 2 }],
    }));
    expect(res.status).toBe(201);
    expect(res.body.order.subtotal).toBe('220.00'); // 60 + 160
  });

  it('es idempotente: reenviar no duplica ni descuenta dos veces', async () => {
    const body = newOrder();
    const first = await api().post(url('/orders')).set(auth(guest)).send(body);
    const second = await api().post(url('/orders')).set(auth(guest)).send(body);

    expect(second.status).toBe(200);
    expect(second.headers['idempotent-replay']).toBe('true');
    expect(second.body.order.id).toBe(first.body.order.id);
    expect(await stockOf(beer.id)).toBe(8);

    const { rows } = await pool.query('SELECT count(*)::int AS n FROM drink_orders');
    expect(rows[0].n).toBe(1);
  });

  it('rechaza si no hay existencias suficientes y no toca el inventario', async () => {
    const res = await api().post(url('/orders')).set(auth(guest))
      .send(newOrder({ items: [{ drink_id: shot.id, quantity: 5 }] }));

    expect(res.status).toBe(409);
    // El error nombra el INSUMO que faltó y cuánto queda de verdad, no un
    // "sin existencias" que obliga a adivinar cuál de los ingredientes se acabó.
    expect(res.body.error.details.supplies[0]).toMatchObject({
      reason: 'out_of_stock', available: 3, needed: 5,
    });
    expect(await stockOf(shot.id)).toBe(3);
  });

  it('rechaza una bebida marcada como no disponible', async () => {
    await pool.query('UPDATE drinks SET available = false WHERE id = $1', [beer.id]);
    const res = await api().post(url('/orders')).set(auth(guest)).send(newOrder());
    expect(res.status).toBe(409);
    expect(res.body.error.details[0].reason).toBe('unavailable');
  });

  it('no permite pedir bebidas de otro club', async () => {
    const otherClub = await f.createNightclub({ slug: 'otro-club' });
    const foreign = await f.createDrink(otherClub.id);
    const res = await api().post(url('/orders')).set(auth(guest))
      .send(newOrder({ items: [{ drink_id: foreign.id, quantity: 1 }] }));
    expect(res.status).toBe(404);
  });

  /**
   * Invitar un trago es alcanzar a una persona concreta, así que desde D65 pasa por
   * las mismas reglas que el flirteo: los dos sentados y ella con el consentimiento
   * prendido. Estas tres líneas son esas precondiciones.
   */
  async function puedenInvitarse() {
    await pool.query(
      'UPDATE user_preferences SET accept_flirts = true WHERE user_id = $1', [other.id]);
    await pool.query(
      'INSERT INTO table_occupants (table_id, user_id) VALUES ($1,$2), ($1,$3)',
      [table.id, guest.id, other.id]);
  }

  it('permite invitar una bebida a otra persona', async () => {
    await puedenInvitarse();
    const res = await api().post(url('/orders')).set(auth(guest))
      .send(newOrder({ recipient_id: other.id, message: 'Salud' }));
    expect(res.status).toBe(201);
    expect(res.body.order.recipient_id).toBe(other.id);
  });

  it('impide invitar a alguien que te bloqueó', async () => {
    await puedenInvitarse();
    await pool.query('INSERT INTO user_blocks (blocker_id, blocked_id) VALUES ($1,$2)',
      [other.id, guest.id]);
    const res = await api().post(url('/orders')).set(auth(guest))
      .send(newOrder({ recipient_id: other.id }));
    // 404 y no 403: un bloqueo contesta lo mismo que "no existe", para que quien
    // acosa no aprenda que lo bloquearon y se haga otra cuenta (D65).
    expect(res.status).toBe(404);
  });

  it('impide invitar a quien NO quiere que la contacten', async () => {
    // El hueco que D65 cerró: `accept_flirts` apagado no se miraba por este camino.
    await pool.query(
      'INSERT INTO table_occupants (table_id, user_id) VALUES ($1,$2), ($1,$3)',
      [table.id, guest.id, other.id]);
    const res = await api().post(url('/orders')).set(auth(guest))
      .send(newOrder({ recipient_id: other.id, message: 'Hola' }));
    expect(res.status).toBe(403);
    expect(res.body.error.message).toMatch(/no acepta/i);
  });

  it('valida el cuerpo de la petición', async () => {
    const res = await api().post(url('/orders')).set(auth(guest))
      .send({ client_request_id: 'no-es-uuid', items: [] });
    expect(res.status).toBe(400);
  });

  it('no deja que dos pedidos simultáneos agoten el mismo producto', async () => {
    // Solo quedan 3 tequilas: dos pedidos de 2 no pueden pasar ambos.
    const [a, b] = await Promise.all([
      api().post(url('/orders')).set(auth(guest))
        .send(newOrder({ items: [{ drink_id: shot.id, quantity: 2 }] })),
      api().post(url('/orders')).set(auth(other))
        .send(newOrder({ items: [{ drink_id: shot.id, quantity: 2 }] })),
    ]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([201, 409]);
    expect(await stockOf(shot.id)).toBe(1);
  });
});

describe('Flujo de estados', () => {
  async function makeOrder() {
    const res = await api().post(url('/orders')).set(auth(guest)).send(newOrder());
    return res.body.order.id;
  }
  const setStatus = (id, status, user) => api().post(url(`/orders/${id}/status`))
    .set(auth(user)).send({ status });

  it('recorre confirmado → preparando → listo → entregado', async () => {
    const id = await makeOrder();
    // Cobrarlo es lo que lo confirma: la barra ya no lo hace a mano.
    expect((await payFor(id)).status).toBe(201);
    for (const status of ['preparing', 'ready', 'delivered']) {
      const res = await setStatus(id, status, bartender);
      expect(res.status).toBe(200);
      expect(res.body.order.status).toBe(status);
    }
  });

  it('registra las marcas de tiempo de cada etapa', async () => {
    const id = await makeOrder();
    await payFor(id);
    await setStatus(id, 'preparing', bartender);
    await setStatus(id, 'ready', bartender);
    await setStatus(id, 'delivered', bartender);

    const { rows } = await pool.query(
      'SELECT confirmed_at, ready_at, delivered_at, bartender_id FROM drink_orders WHERE id = $1', [id]);
    expect(rows[0].confirmed_at).toBeInstanceOf(Date);
    expect(rows[0].ready_at).toBeInstanceOf(Date);
    expect(rows[0].delivered_at).toBeInstanceOf(Date);
    expect(rows[0].bartender_id).toBe(bartender.id);
  });

  it('la barra lo marca listo de un solo toque, sin pasar por "preparando" (D73)', async () => {
    const id = await makeOrder();
    await payFor(id);
    const res = await setStatus(id, 'ready', bartender);
    expect(res.status).toBe(200);
    expect(res.body.order.status).toBe('ready');
    const { rows } = await pool.query(
      'SELECT prep_started_at, ready_at, bartender_id FROM drink_orders WHERE id = $1', [id]);
    // No se inventa cuando empezo: no se sabe, y la hora queda vacia.
    expect(rows[0].prep_started_at).toBeNull();
    expect(rows[0].ready_at).toBeInstanceOf(Date);
    expect(rows[0].bartender_id).toBe(bartender.id);
  });

  it('un pedido sin pagar no se salta a listo', async () => {
    const id = await makeOrder();
    const res = await setStatus(id, 'ready', bartender);
    expect(res.status).toBe(409);
  });

  it('rechaza saltarse etapas', async () => {
    const id = await makeOrder();
    const res = await setStatus(id, 'delivered', bartender);
    expect(res.status).toBe(409);
    expect(res.body.error.details.allowed).toContain('confirmed');
  });

  it('rechaza cambios sobre un pedido ya entregado', async () => {
    const id = await makeOrder();
    await payFor(id);
    for (const s of ['preparing', 'ready', 'delivered']) await setStatus(id, s, bartender);
    const res = await setStatus(id, 'preparing', bartender);
    expect(res.status).toBe(409);
  });

  it('el cliente no puede mover pedidos', async () => {
    const id = await makeOrder();
    const res = await setStatus(id, 'ready', guest);
    expect(res.status).toBe(403);
  });

  it('el cliente sí puede cancelar el suyo mientras está pendiente, y recupera existencias', async () => {
    const id = await makeOrder();
    const res = await setStatus(id, 'cancelled', guest);
    expect(res.status).toBe(200);
    expect(await stockOf(beer.id)).toBe(10);
  });

  it('el cliente no puede cancelar el pedido de otra persona', async () => {
    const id = await makeOrder();
    const res = await setStatus(id, 'cancelled', other);
    expect(res.status).toBe(403);
  });

  it('el cliente no puede cancelar una vez confirmado', async () => {
    const id = await makeOrder();
    await payFor(id);
    const res = await setStatus(id, 'cancelled', guest);
    expect(res.status).toBe(403);
  });

  it('cancelar desde la barra también devuelve las existencias', async () => {
    const id = await makeOrder();
    await payFor(id);
    await setStatus(id, 'cancelled', bartender);
    expect(await stockOf(beer.id)).toBe(10);
  });

  it('publica un evento por cada cambio de estado', async () => {
    const id = await makeOrder();
    await payFor(id);
    // Cobrar ya lo mandó a la barra, así que confirmarlo otra vez sobra: lo que se
    // revisa aquí es que cada paso siguiente deje su propio evento.
    await setStatus(id, 'preparing', bartender);
    const { rows } = await pool.query(`SELECT type FROM events WHERE type LIKE 'order_%' ORDER BY id`);
    expect(rows.map((r) => r.type)).toEqual(['order_created', 'order_confirmed', 'order_preparing']);
  });
});

describe('Consultas de pedidos', () => {
  it('la barra ve la cola activa', async () => {
    await api().post(url('/orders')).set(auth(guest)).send(newOrder());
    const res = await api().get(url('/orders?active=true')).set(auth(bartender));
    expect(res.status).toBe(200);
    expect(res.body.orders).toHaveLength(1);
  });

  it('un cliente no puede ver la cola', async () => {
    const res = await api().get(url('/orders')).set(auth(guest));
    expect(res.status).toBe(403);
  });

  it('cada quien ve sus pedidos enviados y recibidos', async () => {
    // El regalo necesita sus precondiciones (D65): los dos sentados y ella aceptando.
    await pool.query(
      'UPDATE user_preferences SET accept_flirts = true WHERE user_id = $1', [other.id]);
    await pool.query(
      'INSERT INTO table_occupants (table_id, user_id) VALUES ($1,$2), ($1,$3)',
      [table.id, guest.id, other.id]);
    await api().post(url('/orders')).set(auth(guest)).send(newOrder({ recipient_id: other.id }));
    const mine = await api().get(url('/orders/mine')).set(auth(guest));
    const theirs = await api().get(url('/orders/mine')).set(auth(other));
    expect(mine.body.orders).toHaveLength(1);
    expect(theirs.body.orders).toHaveLength(1);
  });

  it('un tercero no puede leer un pedido ajeno', async () => {
    const res = await api().post(url('/orders')).set(auth(guest)).send(newOrder());
    const third = await f.createUser(club.id, { role: 'guest' });
    const read = await api().get(url(`/orders/${res.body.order.id}`)).set(auth(third));
    expect(read.status).toBe(403);
  });

  it('el gerente sí puede leer cualquiera', async () => {
    const res = await api().post(url('/orders')).set(auth(guest)).send(newOrder());
    const read = await api().get(url(`/orders/${res.body.order.id}`)).set(auth(manager));
    expect(read.status).toBe(200);
  });
});

/**
 * Lo que el club pidió: cada pedido se cobra al levantarlo. Aquí se prueba la regla
 * completa — nace debiendo, la barra no lo toca hasta que se pague, y pagarlo es lo
 * único que lo manda a la barra.
 */
describe('El pedido trae su cobro', () => {
  const setStatus = (id, status, user) => api().post(url(`/orders/${id}/status`))
    .set(auth(user)).send({ status });

  it('crear un pedido crea su cobro, pendiente y a nombre de quien consume', async () => {
    const res = await api().post(url('/orders')).set(auth(guest)).send(newOrder());
    const charge = await chargeOf(res.body.order.id);
    expect(charge).toMatchObject({ status: 'pending', amount: '120.00', payer_user_id: guest.id });
    expect(res.body.order.payment_status).toBe('pending');
    expect(res.body.order.transaction_id).toBe(charge.id);
  });

  it('la barra NO puede confirmar un pedido sin pagar', async () => {
    const res = await api().post(url('/orders')).set(auth(guest)).send(newOrder());
    const move = await setStatus(res.body.order.id, 'confirmed', bartender);
    expect(move.status).toBe(409);
    expect(move.body.error.details.payment_status).toBe('pending');
  });

  it('cobrarlo lo manda solo a la barra, sin que nadie apriete otro botón', async () => {
    const res = await api().post(url('/orders')).set(auth(guest)).send(newOrder());
    const id = res.body.order.id;
    const pago = await payFor(id);
    expect(pago.status).toBe(201);

    const after = await api().get(url(`/orders/${id}`)).set(auth(bartender));
    expect(after.body.order.status).toBe('confirmed');
    expect(after.body.order.payment_status).toBe('paid');
    expect(after.body.order.confirmed_at).not.toBeNull();
  });

  it('un cobro por un monto distinto al del pedido se rechaza', async () => {
    const res = await api().post(url('/orders')).set(auth(guest)).send(newOrder());
    const charge = await chargeOf(res.body.order.id);
    const pago = await api().post(url('/manual-payments/register')).set(auth(cashier)).send({
      transaction_id: charge.id, method: 'cash', amount: 100, currency: charge.currency,
    });
    expect(pago.status).toBe(422);
    expect((await chargeOf(res.body.order.id)).status).toBe('pending');
  });

  it('la terminal del club exige el folio del voucher', async () => {
    const res = await api().post(url('/orders')).set(auth(guest)).send(newOrder());
    const charge = await chargeOf(res.body.order.id);
    const sinFolio = await api().post(url('/manual-payments/register')).set(auth(cashier)).send({
      transaction_id: charge.id, method: 'card_terminal', amount: 120, currency: 'MXN',
    });
    expect(sinFolio.status).toBe(422);

    const conFolio = await api().post(url('/manual-payments/register')).set(auth(cashier)).send({
      transaction_id: charge.id, method: 'card_terminal', amount: 120, currency: 'MXN',
      reference: 'VOUCHER-448120',
    });
    expect(conFolio.status).toBe(201);
    expect((await chargeOf(res.body.order.id)).status).toBe('paid');
  });

  it('una transferencia NO se da por cobrada en la mesa: la confirma el gerente', async () => {
    const res = await api().post(url('/orders')).set(auth(guest)).send(newOrder());
    const charge = await chargeOf(res.body.order.id);
    const pago = await api().post(url('/manual-payments/register')).set(auth(cashier)).send({
      transaction_id: charge.id, method: 'spei', amount: 120, currency: 'MXN', reference: 'ABC123456',
    });
    expect(pago.status).toBe(422);
    expect((await chargeOf(res.body.order.id)).status).toBe('pending');
  });

  it('cancelar un pedido sin pagar cierra su cobro', async () => {
    const res = await api().post(url('/orders')).set(auth(guest)).send(newOrder());
    await setStatus(res.body.order.id, 'cancelled', guest);
    expect((await chargeOf(res.body.order.id)).status).toBe('cancelled');
  });

  it('cancelar un pedido YA pagado no borra el dinero: queda un reembolso pendiente', async () => {
    const res = await api().post(url('/orders')).set(auth(guest)).send(newOrder());
    const id = res.body.order.id;
    await payFor(id);
    const cancel = await setStatus(id, 'cancelled', bartender);
    expect(cancel.status).toBe(200);
    expect((await chargeOf(id)).status).toBe('paid');

    const { rows } = await pool.query(
      `SELECT payload FROM events WHERE type = 'order_cancelled' ORDER BY id DESC LIMIT 1`);
    expect(rows[0].payload.refund_due).toBe(true);
  });
});

/**
 * El mesero en la mesa. El cliente de admisión general no está registrado en la app,
 * así que alguien tiene que levantar el pedido por él — y el sistema tiene que saber
 * quién fue.
 */
describe('El mesero levanta el pedido', () => {
  it('marca quién lo levantó, y el cobro queda a su nombre si no hay cliente identificado', async () => {
    const res = await api().post(url('/orders')).set(auth(waiter))
      .send(newOrder({ table_id: table.id }));

    expect(res.status).toBe(201);
    expect(res.body.order.taken_by).toBe(waiter.id);
    expect(res.body.order.taken_by_name).toBe(waiter.display_name);
    expect(res.body.order.sender_id).toBe(waiter.id);
    expect((await chargeOf(res.body.order.id)).payer_user_id).toBe(waiter.id);
  });

  it('si nombra al cliente sentado, el cobro es del cliente y el pedido sigue siendo suyo', async () => {
    await pool.query('INSERT INTO table_occupants (table_id, user_id) VALUES ($1,$2)',
      [table.id, guest.id]);

    const res = await api().post(url('/orders')).set(auth(waiter))
      .send(newOrder({ table_id: table.id, on_behalf_of: guest.id }));

    expect(res.status).toBe(201);
    expect(res.body.order.sender_id).toBe(guest.id);
    expect(res.body.order.taken_by).toBe(waiter.id);
    expect((await chargeOf(res.body.order.id)).payer_user_id).toBe(guest.id);

    // Y el cliente lo ve como suyo en su teléfono.
    const mine = await api().get(url('/orders/mine')).set(auth(guest));
    expect(mine.body.orders.map((o) => o.id)).toContain(res.body.order.id);
  });

  it('no puede cobrarle a alguien que no está en esa mesa', async () => {
    const res = await api().post(url('/orders')).set(auth(waiter))
      .send(newOrder({ table_id: table.id, on_behalf_of: other.id }));
    expect(res.status).toBe(422);
  });

  it('un cliente no puede pedir a nombre de otro', async () => {
    const res = await api().post(url('/orders')).set(auth(guest))
      .send(newOrder({ table_id: table.id, on_behalf_of: other.id }));
    expect(res.status).toBe(403);
  });

  it('un pedido hecho desde el teléfono del cliente no lleva mesero', async () => {
    const res = await api().post(url('/orders')).set(auth(guest)).send(newOrder());
    expect(res.body.order.taken_by).toBeNull();
    expect(res.body.order.pay_at_till).toBe(false);
  });
});

/**
 * La caja de cada barra (D77). Lo que levanta el mesero entra a la barra en ese
 * momento, sin pagar; el mesero entrega, recibe el dinero y lo lleva a la caja de esa
 * barra, que es la única que lo cobra.
 */
describe('El pedido del mesero se cobra en la caja de su barra', () => {
  const setStatus = (id, status, user) => api().post(url(`/orders/${id}/status`))
    .set(auth(user)).send({ status });
  const delMesero = () => api().post(url('/orders')).set(auth(waiter))
    .send(newOrder({ table_id: table.id }));

  it('entra a la barra al levantarlo: confirmado, sin pagar y marcado para caja', async () => {
    const res = await delMesero();
    expect(res.status).toBe(201);
    expect(res.body.order.status).toBe('confirmed');
    expect(res.body.order.confirmed_at).not.toBeNull();
    expect(res.body.order.payment_status).toBe('pending');
    expect(res.body.order.pay_at_till).toBe(true);
    expect(res.body.order.bar_location_id).toBe(club.bar_id);
  });

  it('la barra lo ve en su cola de lo que se prepara y lo puede preparar sin el cobro', async () => {
    const res = await delMesero();
    const cola = await api().get(url(`/orders?bar_id=${club.bar_id}&active=true&paid_only=true`))
      .set(auth(bartender));
    expect(cola.body.orders.map((o) => o.id)).toContain(res.body.order.id);
    const listo = await setStatus(res.body.order.id, 'ready', bartender);
    expect(listo.status).toBe(200);
  });

  it('el pedido del cliente desde su teléfono sigue sin entrar a la cola hasta pagarse', async () => {
    const res = await api().post(url('/orders')).set(auth(guest)).send(newOrder());
    const cola = await api().get(url(`/orders?bar_id=${club.bar_id}&active=true&paid_only=true`))
      .set(auth(bartender));
    expect(cola.body.orders.map((o) => o.id)).not.toContain(res.body.order.id);
  });

  it('el mesero ya no cobra: ni registra efectivo ni declara pagos', async () => {
    const res = await delMesero();
    const charge = await chargeOf(res.body.order.id);
    const registrar = await api().post(url('/manual-payments/register')).set(auth(waiter)).send({
      transaction_id: charge.id, method: 'cash', amount: 120, currency: 'MXN',
    });
    expect(registrar.status).toBe(403);
    const declarar = await api().post(url('/manual-payments')).set(auth(waiter)).send({
      transaction_id: charge.id, method: 'spei', amount: 120, currency: 'MXN', reference: 'ABC123456',
    });
    expect(declarar.status).toBe(403);
    expect((await chargeOf(res.body.order.id)).status).toBe('pending');
  });

  it('el bartender tampoco cobra', async () => {
    const res = await delMesero();
    const charge = await chargeOf(res.body.order.id);
    const intento = await api().post(url('/manual-payments/register')).set(auth(bartender)).send({
      transaction_id: charge.id, method: 'cash', amount: 120, currency: 'MXN',
    });
    expect(intento.status).toBe(403);
  });

  it('el cajero de esa barra lo cobra; sigue en la barra y se avisa que ya se pagó', async () => {
    const res = await delMesero();
    const pago = await payFor(res.body.order.id);
    expect(pago.status).toBe(201);
    const after = await api().get(url(`/orders/${res.body.order.id}`)).set(auth(cashier));
    expect(after.body.order.status).toBe('confirmed');
    expect(after.body.order.payment_status).toBe('paid');

    const { rows } = await pool.query(
      `SELECT type, payload FROM events WHERE type IN ('order_paid','order_confirmed') ORDER BY id`);
    // No se vuelve a "confirmar" (ya estaba en la barra): se avisa que quedó pagado.
    expect(rows.map((r) => r.type)).toEqual(['order_paid']);
    expect(rows[0].payload.order_id).toBe(res.body.order.id);
  });

  it('el cajero de OTRA barra no lo puede cobrar', async () => {
    const res = await delMesero();
    const otroCajero = await f.createUser(club.id, { role: 'cashier' });
    await f.openTill(club.id, {
      cashier: otroCajero, locationId: club.locations['barra-alta'], authorizer: manager,
    });
    const intento = await payFor(res.body.order.id, otroCajero);
    expect(intento.status).toBe(403);
    expect(intento.body.error.message).toMatch(/otra barra/);
  });

  it('un cajero sin la caja abierta no cobra', async () => {
    const res = await delMesero();
    const sinCaja = await f.createUser(club.id, { role: 'cashier' });
    const intento = await payFor(res.body.order.id, sinCaja);
    expect(intento.status).toBe(409);
    expect(intento.body.error.message).toMatch(/Abre tu caja/);
  });

  it('la caja no cobra cosas que no son pedidos de la barra', async () => {
    const { rows } = await pool.query(
      `INSERT INTO transactions (nightclub_id, type, direction, amount, currency, status,
                                 payer_user_id, provider, reference_type, reference_id)
       VALUES ($1,'reservation_deposit','in',500,'MXN','pending',$2,'manual','reservation',$3)
       RETURNING id`, [club.id, guest.id, randomUUID()]);
    const intento = await api().post(url('/manual-payments/register')).set(auth(cashier)).send({
      transaction_id: rows[0].id, method: 'cash', amount: 500, currency: 'MXN',
    });
    expect(intento.status).toBe(403);
  });
});

/**
 * La venta en la barra.
 *
 * El cliente que llega a la barra, pide y paga ahí mismo: la mitad de la clientela de
 * una barra. Desde D77 la hace el cajero de esa barra, no el cantinero: el cantinero
 * prepara y la caja cobra.
 */
describe('Venta directa en la barra', () => {
  let barra;
  beforeEach(async () => {
    barra = await f.barOf(club.id, 'barra-baja');
  });

  const venta = (over = {}, by = cashier) => api().post(url('/orders')).set(auth(by)).send({
    client_request_id: randomUUID(),
    bar_location_id: barra,
    items: [{ drink_id: beer.id, quantity: 2 }],
    ...over,
  });

  it('se crea sin mesa y con la barra de la que sale', async () => {
    const res = await venta();
    expect(res.status).toBe(201);
    expect(res.body.order.table_id).toBeNull();
    expect(res.body.order.bar_location_id).toBe(barra);
    expect(res.body.order.bar_name).toBe('Barra planta baja');
  });

  it('nace debiendo dinero y NO entra a la barra hasta cobrarse', async () => {
    const res = await venta();
    expect(res.body.order.payment_status).toBe('pending');
    expect(res.body.order.status).toBe('pending');
    expect(res.body.order.pay_at_till).toBe(false);
    expect(res.body.order.subtotal).toBe('120.00');
  });

  it('queda a nombre del cajero: es quien recibió el dinero', async () => {
    const res = await venta();
    expect(res.body.order.taken_by).toBe(cashier.id);
    expect(res.body.order.sender_id).toBe(cashier.id);
  });

  it('el cantinero ya no vende: prepara', async () => {
    const res = await venta({}, bartender);
    expect(res.status).toBe(403);
  });

  it('el cajero sin caja abierta no vende', async () => {
    const sinCaja = await f.createUser(club.id, { role: 'cashier' });
    const res = await venta({}, sinCaja);
    expect(res.status).toBe(409);
  });

  it('el cajero la cobra en efectivo y queda confirmada de un paso', async () => {
    const res = await venta();
    const pago = await payFor(res.body.order.id, cashier);
    expect(pago.status).toBe(201);

    const after = await api().get(url(`/orders/${res.body.order.id}`)).set(auth(bartender));
    expect(after.body.order.payment_status).toBe('paid');
    expect(after.body.order.status).toBe('confirmed');
  });

  it('descuenta del estante de ESA barra', async () => {
    const antes = await f.supplyStock(beer.supply_id, barra);
    await venta();
    expect(await f.supplyStock(beer.supply_id, barra)).toBe(antes - 2);
  });

  it('no se lleva lo que no hay en esa barra', async () => {
    const arriba = await f.barOf(club.id, 'barra-alta');
    const cajeroArriba = await f.createUser(club.id, { role: 'cashier' });
    await f.openTill(club.id, { cashier: cajeroArriba, locationId: arriba, authorizer: manager });
    const res = await venta({}, cajeroArriba);
    expect(res.status).toBe(409);
    expect(res.body.error.details.supplies[0].available).toBe(0);
  });

  it('sale de la barra de SU caja aunque pida otra', async () => {
    const arriba = await f.barOf(club.id, 'barra-alta');
    const res = await venta({ bar_location_id: arriba });
    expect(res.status).toBe(201);
    expect(res.body.order.bar_location_id).toBe(barra);
  });

  it('aparece en la cola de su barra y no en la otra', async () => {
    const res = await venta();
    await payFor(res.body.order.id, cashier);
    const arriba = await f.barOf(club.id, 'barra-alta');

    const suya = await api().get(url(`/orders?bar_id=${barra}&active=true`)).set(auth(bartender));
    const otra = await api().get(url(`/orders?bar_id=${arriba}&active=true`)).set(auth(bartender));
    expect(suya.body.orders.map((o) => o.id)).toContain(res.body.order.id);
    expect(otra.body.orders.map((o) => o.id)).not.toContain(res.body.order.id);
  });

  it('es idempotente: el doble toque no cobra dos rondas', async () => {
    const key = randomUUID();
    const uno = await venta({ client_request_id: key });
    const dos = await venta({ client_request_id: key });
    expect(uno.body.order.id).toBe(dos.body.order.id);
    expect(dos.headers['idempotent-replay']).toBe('true');
  });

  it('un cliente NO puede elegir de qué barra sale su pedido', async () => {
    // Elegiría la barra que tenga existencia, no la que le toca a su mesa.
    const arriba = await f.barOf(club.id, 'barra-alta');
    const res = await api().post(url('/orders')).set(auth(guest)).send({
      client_request_id: randomUUID(),
      table_id: table.id,
      bar_location_id: arriba,
      items: [{ drink_id: beer.id, quantity: 1 }],
    });
    expect(res.status).toBe(201);
    // Se ignora lo que mandó: sale de la barra que atiende su mesa.
    expect(res.body.order.bar_location_id).toBe(barra);
  });
});
