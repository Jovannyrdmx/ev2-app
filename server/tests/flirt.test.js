'use strict';

// Flirt: preferencias, personas de la noche, envío, bandeja, reacciones, bloqueos,
// reportes, trago/botella con devolución al emisor y panel del gerente (D18).

const { randomUUID } = require('crypto');
const { setupSchema, truncateAll, closePool, pool } = require('./helpers/db');
const { api, auth } = require('./helpers/api');
const f = require('./helpers/factories');
const { LIMITS } = require('../src/routes/flirts');

let club; let ana; let beto; let carla; let waiter; let manager; let bartender;
let mesaA; let mesaB; let mesaC; let cerveza; let botella;

beforeAll(setupSchema);
afterAll(closePool);

beforeEach(async () => {
  await truncateAll();
  club = await f.createNightclub({ slug: 'ev2-flirt' });
  ana = await f.createUser(club.id, { role: 'guest', display_name: 'Ana', accept_flirts: true });
  beto = await f.createUser(club.id, { role: 'guest', display_name: 'Beto', accept_flirts: true });
  carla = await f.createUser(club.id, { role: 'guest', display_name: 'Carla', accept_flirts: false });
  waiter = await f.createUser(club.id, { role: 'waiter' });
  manager = await f.createUser(club.id, { role: 'manager' });
  bartender = await f.createUser(club.id, { role: 'bartender' });
  cerveza = await f.createDrink(club.id, { name: 'Cerveza', price: 120, stock: 10 });
  botella = await f.createDrink(club.id, { name: 'Botella de tequila', category: 'bottle', price: 1400, stock: 3 });

  mesaA = await f.createTable(club.id, { code: '5', section: 'GENERAL' });
  mesaB = await f.createTable(club.id, { code: '39', section: 'ZONA ROJA' });
  mesaC = await f.createTable(club.id, { code: 'AZ13', section: 'ZONA AZUL' });

  // Todos visibles en la lista salvo que una prueba diga lo contrario.
  await pool.query('UPDATE user_preferences SET discoverable = true WHERE user_id = ANY($1::uuid[])',
    [[ana.id, beto.id, carla.id]]);
});

const url = (p) => `/api/nightclubs/${club.id}${p}`;
// Sentar es cosa del personal desde que la entrada se controla en la puerta: el
// cliente ya no se sienta solo. Conecta sigue dependiendo de estar sentado.
const seat = (user, table) => api().post(url(`/tables/${table.id}/seat`))
  .set(auth(manager)).send({ user_id: user.id });

/**
 * Cobra el pedido de una invitación. Desde que cada pedido nace con su cobro, la barra
 * no lo prepara hasta que alguien paga — y en una invitación paga quien la manda.
 */
async function payOrder(orderId) {
  const { rows } = await pool.query(
    `SELECT id, amount::text AS amount, currency FROM transactions
      WHERE reference_type = 'drink_order' AND reference_id = $1`, [orderId]);
  return api().post(url('/manual-payments/register')).set(auth(waiter)).send({
    transaction_id: rows[0].id,
    method: 'cash',
    amount: Number(rows[0].amount),
    currency: rows[0].currency,
  });
}
const prefs = (user, body) => api().put('/api/me/preferences').set(auth(user)).send(body);

const send = (from, to, over = {}) => api().post(url('/flirts')).set(auth(from)).send({
  client_request_id: randomUUID(),
  recipient_id: to.id,
  type: 'emoji',
  emoji: 'wave',
  ...over,
});

async function seatEveryone() {
  await seat(ana, mesaA);
  await seat(beto, mesaB);
  await seat(carla, mesaC);
}

describe('Preferencias', () => {
  it('nacen apagadas: nadie recibe ni aparece sin pedirlo', async () => {
    const nuevo = await f.createUser(club.id, { role: 'guest' });
    const res = await api().get('/api/me/preferences').set(auth(nuevo));
    expect(res.status).toBe(200);
    expect(res.body.preferences).toMatchObject({ accept_flirts: false, discoverable: false });
  });

  it('cada quien activa o apaga lo suyo', async () => {
    const on = await prefs(carla, { accept_flirts: true, discoverable: true });
    expect(on.status).toBe(200);
    expect(on.body.preferences).toMatchObject({ accept_flirts: true, discoverable: true });

    const off = await prefs(carla, { accept_flirts: false });
    expect(off.body.preferences).toMatchObject({ accept_flirts: false, discoverable: true });
  });

  it('rechaza un cuerpo vacío', async () => {
    expect((await prefs(carla, {})).status).toBe(400);
  });
});

describe('Personas esta noche', () => {
  it('solo muestra a quienes están sentados y quieren aparecer', async () => {
    await seat(ana, mesaA);
    await seat(beto, mesaB);
    // Carla está en la lista pero no se sentó.
    const res = await api().get(url('/flirts/people')).set(auth(ana));
    expect(res.status).toBe(200);
    expect(res.body.people.map((p) => p.display_name)).toEqual(['Beto']);
    expect(res.body.people[0]).toMatchObject({ table_code: '39', section: 'ZONA ROJA', accept_flirts: true });
  });

  it('nunca expone teléfono, correo ni fecha de nacimiento', async () => {
    await seatEveryone();
    const res = await api().get(url('/flirts/people')).set(auth(ana));
    const text = JSON.stringify(res.body);
    expect(text).not.toMatch(/email|phone|birth_date|@test\.mx/);
  });

  it('oculta a quien apagó "aparecer en la lista"', async () => {
    await seatEveryone();
    await prefs(beto, { discoverable: false });
    const res = await api().get(url('/flirts/people')).set(auth(ana));
    expect(res.body.people.map((p) => p.display_name)).toEqual(['Carla']);
  });

  it('hay que estar sentado para ver la lista', async () => {
    await seat(beto, mesaB);
    const res = await api().get(url('/flirts/people')).set(auth(ana));
    expect(res.status).toBe(422);
  });

  it('no lista al personal aunque esté en una mesa', async () => {
    await seatEveryone();
    await seat(waiter, mesaC);
    await pool.query('UPDATE user_preferences SET discoverable = true WHERE user_id = $1', [waiter.id]);
    const res = await api().get(url('/flirts/people')).set(auth(ana));
    expect(res.body.people.map((p) => p.display_name)).not.toContain('waiter Test');
  });

  it('filtra por zona', async () => {
    await seatEveryone();
    const res = await api().get(url('/flirts/people?section=ZONA AZUL')).set(auth(ana));
    expect(res.body.people.map((p) => p.display_name)).toEqual(['Carla']);
  });

  it('el catálogo de emojis y los límites son públicos para el cliente', async () => {
    const res = await api().get(url('/flirts/catalogue')).set(auth(ana));
    expect(res.body.emojis.map((e) => e.key)).toEqual(['wave', 'wink', 'kiss', 'fire', 'heart', 'dance', 'star']);
    expect(res.body.limits.per_hour).toBe(20);
  });
});

describe('Enviar un flirt', () => {
  beforeEach(seatEveryone);

  it('crea el flirt con la mesa del emisor y avisa al receptor', async () => {
    const res = await send(ana, beto, { emoji: 'wink', message: 'Hola 👋' });
    expect(res.status).toBe(201);
    expect(res.body.flirt).toMatchObject({
      type: 'emoji', emoji: 'wink', message: 'Hola 👋', status: 'sent',
      sender_name: 'Ana', recipient_name: 'Beto', sender_table_code: '5', sender_section: 'GENERAL',
    });
    const { rows } = await pool.query(`SELECT type, audience FROM events WHERE type = 'flirt_received'`);
    expect(rows).toHaveLength(1);
    expect(rows[0].audience.userIds).toEqual([beto.id]);
  });

  it('un "meet" lleva la invitación a la mesa del emisor', async () => {
    const res = await send(ana, beto, { type: 'meet', emoji: undefined, message: '¿Vienes a la 5?' });
    expect(res.status).toBe(201);
    expect(res.body.flirt.type).toBe('meet');
    expect(res.body.flirt.sender_table_code).toBe('5');
  });

  it('es idempotente', async () => {
    const id = randomUUID();
    const first = await send(ana, beto, { client_request_id: id });
    const again = await send(ana, beto, { client_request_id: id });
    expect(again.status).toBe(200);
    expect(again.headers['idempotent-replay']).toBe('true');
    expect(again.body.flirt.id).toBe(first.body.flirt.id);
  });

  it('sin opt-in del receptor no se envía (403)', async () => {
    const res = await send(ana, carla);
    expect(res.status).toBe(403);
  });

  it('el receptor puede apagarlo a media noche y deja de recibir', async () => {
    expect((await send(ana, beto)).status).toBe(201);
    await prefs(beto, { accept_flirts: false });
    expect((await send(ana, beto)).status).toBe(403);
  });

  it('el emisor tiene que estar sentado', async () => {
    const suelto = await f.createUser(club.id, { role: 'guest', accept_flirts: true });
    const res = await send(suelto, beto);
    expect(res.status).toBe(422);
  });

  it('el receptor tiene que seguir en el club', async () => {
    await pool.query('UPDATE table_occupants SET left_at = now() WHERE user_id = $1', [beto.id]);
    const res = await send(ana, beto);
    expect(res.status).toBe(422);
  });

  it('no se puede enviar a uno mismo', async () => {
    expect((await send(ana, ana)).status).toBe(422);
  });

  it('un emoji fuera del catálogo se rechaza', async () => {
    expect((await send(ana, beto, { emoji: 'eggplant' })).status).toBe(400);
  });

  it('un mensaje más largo de lo permitido se rechaza', async () => {
    expect((await send(ana, beto, { message: 'x'.repeat(LIMITS.messageMax + 1) })).status).toBe(400);
  });

  it('el personal no envía flirts', async () => {
    await seat(waiter, mesaC);
    expect((await send(waiter, beto)).status).toBe(403);
    expect((await send(manager, beto)).status).toBe(403);
  });

  it('un trago sin drink_id se rechaza', async () => {
    const res = await send(ana, beto, { type: 'drink', emoji: undefined });
    expect(res.status).toBe(400);
  });
});

describe('Invitar trago o botella', () => {
  beforeEach(seatEveryone);
  const gift = (over = {}) => send(ana, beto, { type: 'drink', emoji: undefined, drink_id: cerveza.id, ...over });
  const react = (flirtId, user, reaction) => api().post(url(`/flirts/${flirtId}/react`)).set(auth(user)).send({ reaction });
  const orderOf = async (flirtId) => (await pool.query(
    'SELECT o.* FROM drink_orders o JOIN flirts f ON f.drink_order_id = o.id WHERE f.id = $1', [flirtId])).rows[0];

  it('crea un pedido real para la mesa del receptor, cobrado al emisor', async () => {
    const res = await gift({ quantity: 2 });
    expect(res.status).toBe(201);
    expect(res.body.flirt.type).toBe('drink');
    const order = await orderOf(res.body.flirt.id);
    expect(order).toMatchObject({ sender_id: ana.id, recipient_id: beto.id, table_id: mesaB.id, status: 'pending' });
    expect(order.subtotal).toBe('240.00');
    expect(order.message).toMatch(/Invitación de Ana \(mesa 5\)/);

    const ledger = await pool.query('SELECT type, direction, amount, status, payer_user_id, metadata FROM transactions');
    expect(ledger.rows).toHaveLength(1);
    expect(ledger.rows[0]).toMatchObject({
      type: 'drink_order', direction: 'in', amount: '240.00', status: 'pending', payer_user_id: ana.id,
    });
    expect(ledger.rows[0].metadata.non_refundable).toBe(true);

    const stock = await pool.query('SELECT quantity FROM inventory WHERE drink_id = $1', [cerveza.id]);
    expect(Number(stock.rows[0].quantity)).toBe(8);
  });

  it('una botella se asienta como servicio de botella', async () => {
    const res = await gift({ type: 'bottle', drink_id: botella.id });
    expect(res.status).toBe(201);
    const ledger = await pool.query('SELECT type, amount FROM transactions');
    expect(ledger.rows[0]).toMatchObject({ type: 'bottle_service', amount: '1400.00' });
  });

  it('la barra lo ve en su cola como cualquier pedido', async () => {
    const res = await gift();
    const queue = await api().get(url('/orders')).set(auth(bartender));
    const order = queue.body.orders.find((o) => o.id === res.body.flirt.drink_order_id);
    expect(order).toBeTruthy();
    expect(order.table_code).toBe('39');
    expect(order.recipient_name).toBe('Beto');
  });

  it('si el receptor lo rechaza, el pedido vuelve a la mesa del emisor y no se reembolsa', async () => {
    const res = await gift();
    // Pagarlo es lo que lo manda a la barra.
    expect((await payOrder(res.body.flirt.drink_order_id)).status).toBe(201);

    const declined = await react(res.body.flirt.id, beto, 'not_interested');
    expect(declined.status).toBe(200);
    expect(declined.body.flirt.status).toBe('declined');

    const order = await orderOf(res.body.flirt.id);
    expect(order).toMatchObject({ status: 'confirmed', table_id: mesaA.id, recipient_id: null, returned_to_sender: true });
    expect(order.returned_at).toBeTruthy();
    expect(order.message).toMatch(/devolver a mesa 5/);

    const ledger = await pool.query(
      `SELECT status FROM transactions WHERE reference_type = 'drink_order'`);
    expect(ledger.rows).toEqual([{ status: 'paid' }]); // ni cancelado ni reembolsado
    const stock = await pool.query('SELECT quantity FROM inventory WHERE drink_id = $1', [cerveza.id]);
    expect(Number(stock.rows[0].quantity)).toBe(9); // el trago sigue preparándose

    const ev = await pool.query(`SELECT payload FROM events WHERE type = 'order_returned'`);
    expect(ev.rows[0].payload.return_to_table).toBe('5');
  });

  it('un rechazo después de entregado no mueve nada', async () => {
    const res = await gift();
    const id = res.body.flirt.drink_order_id;
    await payOrder(id);
    for (const status of ['preparing', 'ready', 'delivered']) {
      await api().post(url(`/orders/${id}/status`)).set(auth(bartender)).send({ status });
    }
    await react(res.body.flirt.id, beto, 'not_interested');
    const order = await orderOf(res.body.flirt.id);
    expect(order).toMatchObject({ status: 'delivered', table_id: mesaB.id, returned_to_sender: false });
  });

  it('el emisor no puede cancelar la invitación', async () => {
    const res = await gift();
    const cancel = await api().post(url(`/orders/${res.body.flirt.drink_order_id}/status`))
      .set(auth(ana)).send({ status: 'cancelled' });
    expect(cancel.status).toBe(403);
    expect(cancel.body.error.message).toMatch(/no se cancela ni se reembolsa/);
  });

  it('sin existencias no se cobra ni se crea el flirt', async () => {
    const res = await gift({ quantity: 10, drink_id: botella.id, type: 'bottle' });
    expect(res.status).toBe(409);
    const n = await pool.query('SELECT (SELECT count(*) FROM flirts)::int AS f, (SELECT count(*) FROM transactions)::int AS t');
    expect(n.rows[0]).toEqual({ f: 0, t: 0 });
  });

  it('respeta el opt-in y el bloqueo igual que un emoji', async () => {
    expect((await send(ana, carla, { type: 'drink', emoji: undefined, drink_id: cerveza.id })).status).toBe(403);
    await api().post(`/api/me/blocks/${ana.id}`).set(auth(beto));
    expect((await gift()).status).toBe(404);
    const n = await pool.query('SELECT count(*)::int AS n FROM drink_orders');
    expect(n.rows[0].n).toBe(0);
  });

  it('es idempotente: reenviar no cobra dos veces', async () => {
    const id = randomUUID();
    await gift({ client_request_id: id });
    const again = await gift({ client_request_id: id });
    expect(again.status).toBe(200);
    const n = await pool.query('SELECT (SELECT count(*) FROM drink_orders)::int AS o, (SELECT count(*) FROM transactions)::int AS t');
    expect(n.rows[0]).toEqual({ o: 1, t: 1 });
  });
});

describe('Bloqueos', () => {
  beforeEach(seatEveryone);
  const block = (who, whom) => api().post(`/api/me/blocks/${whom.id}`).set(auth(who));

  it('bloquear oculta a ambos en la lista y cierra lo pendiente', async () => {
    const pending = await send(ana, beto);
    expect((await block(beto, ana)).status).toBe(201);

    const listaBeto = await api().get(url('/flirts/people')).set(auth(beto));
    expect(listaBeto.body.people.map((p) => p.display_name)).not.toContain('Ana');
    const listaAna = await api().get(url('/flirts/people')).set(auth(ana));
    expect(listaAna.body.people.map((p) => p.display_name)).not.toContain('Beto');

    const { rows } = await pool.query('SELECT status FROM flirts WHERE id = $1', [pending.body.flirt.id]);
    expect(rows[0].status).toBe('declined');
  });

  it('el bloqueado recibe un 404 neutro al intentar enviar, y también al revés', async () => {
    await block(beto, ana);
    const res = await send(ana, beto);
    expect(res.status).toBe(404);
    expect(res.body.error.message).not.toMatch(/bloque/i);
    expect((await send(beto, ana)).status).toBe(404);
  });

  it('se puede listar y deshacer', async () => {
    await block(beto, ana);
    const list = await api().get('/api/me/blocks').set(auth(beto));
    expect(list.body.blocks.map((b) => b.display_name)).toEqual(['Ana']);
    expect((await api().delete(`/api/me/blocks/${ana.id}`).set(auth(beto))).status).toBe(204);
    expect((await send(ana, beto)).status).toBe(201);
  });

  it('bloquearse a uno mismo o a alguien de otro club falla', async () => {
    expect((await block(beto, beto)).status).toBe(422);
    const otro = await f.createNightclub({ slug: 'otro-club' });
    const ajeno = await f.createUser(otro.id, { role: 'guest' });
    expect((await block(beto, ajeno)).status).toBe(404);
  });
});

describe('Reportes', () => {
  beforeEach(seatEveryone);
  const report = (who, whom, body = { reason: 'harassment' }) =>
    api().post(url(`/users/${whom.id}/report`)).set(auth(who)).send(body);

  it('se registra con motivo y avisa al gerente', async () => {
    const res = await report(beto, ana, { reason: 'harassment', details: 'Insiste aunque le dije que no' });
    expect(res.status).toBe(201);
    expect(res.body.report).toMatchObject({ reason: 'harassment', status: 'open' });
    const ev = await pool.query(`SELECT audience FROM events WHERE type = 'user_reported'`);
    expect(ev.rows[0].audience.roles).toEqual(['manager']);
  });

  it('un motivo fuera de la lista se rechaza', async () => {
    expect((await report(beto, ana, { reason: 'feo' })).status).toBe(400);
  });

  it('solo un reporte abierto por persona', async () => {
    await report(beto, ana);
    expect((await report(beto, ana)).status).toBe(409);
  });

  it('puede adjuntar el flirt recibido como evidencia, pero no uno ajeno', async () => {
    const mine = await send(ana, beto);
    expect((await report(beto, ana, { reason: 'harassment', flirt_id: mine.body.flirt.id })).status).toBe(201);
    expect((await report(carla, ana, { reason: 'harassment', flirt_id: mine.body.flirt.id })).status).toBe(404);
  });

  it('con dos reportes abiertos la persona desaparece de la lista y no recibe', async () => {
    await report(beto, ana);
    await report(carla, ana);
    const list = await api().get(url('/flirts/people')).set(auth(beto));
    expect(list.body.people.map((p) => p.display_name)).not.toContain('Ana');
    expect((await send(beto, ana)).status).toBe(404);
  });

  it('el gerente ve los reportes sin el mensaje del flirt', async () => {
    const mine = await send(ana, beto, { message: 'texto privado' });
    await report(beto, ana, { reason: 'harassment', details: 'me incomoda', flirt_id: mine.body.flirt.id });

    const res = await api().get(url('/reports')).set(auth(manager));
    expect(res.status).toBe(200);
    expect(res.body.reports).toHaveLength(1);
    expect(res.body.reports[0]).toMatchObject({ reporter_name: 'Beto', reported_name: 'Ana', flirt_type: 'emoji' });
    expect(JSON.stringify(res.body)).not.toContain('texto privado');
    expect((await api().get(url('/reports')).set(auth(ana))).status).toBe(403);
  });

  it('marcar "actioned" bloquea la cuenta y la saca del club', async () => {
    const r = await report(beto, ana);
    const res = await api().patch(url(`/reports/${r.body.report.id}`)).set(auth(manager))
      .send({ status: 'actioned', resolution_note: 'Expulsado esta noche' });
    expect(res.status).toBe(200);
    expect(res.body.report).toMatchObject({ status: 'actioned', reported_account_status: 'blocked', reviewed_by_name: 'manager Test' });

    expect((await api().get('/api/me/preferences').set(auth(ana))).status).toBe(403);
    const seated = await pool.query('SELECT count(*)::int AS n FROM table_occupants WHERE user_id = $1 AND left_at IS NULL', [ana.id]);
    expect(seated.rows[0].n).toBe(0);
  });

  it('desestimar un reporte vuelve a mostrar a la persona', async () => {
    const a = await report(beto, ana);
    await report(carla, ana);
    await api().patch(url(`/reports/${a.body.report.id}`)).set(auth(manager)).send({ status: 'dismissed' });
    const list = await api().get(url('/flirts/people')).set(auth(carla));
    expect(list.body.people.map((p) => p.display_name)).toContain('Ana');
  });
});

describe('Panel del gerente', () => {
  beforeEach(seatEveryone);

  it('solo conteos: nada de nombres ni mensajes', async () => {
    const a = await send(ana, beto, { message: 'secreto' });
    await send(beto, ana, { type: 'drink', emoji: undefined, drink_id: cerveza.id });
    await api().post(url(`/flirts/${a.body.flirt.id}/react`)).set(auth(beto)).send({ reaction: 'like' });

    const res = await api().get(url('/flirts/stats')).set(auth(manager));
    expect(res.status).toBe(200);
    expect(res.body.flirts).toMatchObject({ sent: 2, accepted: 1, declined: 0, emoji: 1, senders: 2 });
    expect(res.body.gifts).toMatchObject({ orders: 1, returned: 0, total: '120.00' });
    expect(res.body.opt_in).toMatchObject({ accepting: 2, discoverable: 3 });
    const text = JSON.stringify(res.body);
    expect(text).not.toMatch(/secreto|Ana|Beto/);
  });

  it('el personal de piso no lo ve', async () => {
    expect((await api().get(url('/flirts/stats')).set(auth(waiter))).status).toBe(403);
  });
});

describe('Límites contra el acoso', () => {
  beforeEach(seatEveryone);

  it('a la cuarta sin respuesta a la misma persona responde 429', async () => {
    for (let i = 0; i < LIMITS.unansweredPerNight; i += 1) {
      expect((await send(ana, beto)).status).toBe(201);
    }
    const res = await send(ana, beto);
    expect(res.status).toBe(429);
    expect(res.body.error.message).toMatch(/sin respuesta/);
  });

  it('cuando la otra persona responde, se puede seguir', async () => {
    const first = await send(ana, beto);
    await send(ana, beto);
    await send(ana, beto);
    await api().post(url(`/flirts/${first.body.flirt.id}/react`)).set(auth(beto)).send({ reaction: 'like' });
    expect((await send(ana, beto)).status).toBe(201);
  });

  it('el tope de 20 por hora responde 429 aunque sea a personas distintas', async () => {
    // Se rellenan 19 directamente en la base para no depender del tope por persona.
    const values = Array.from({ length: LIMITS.perHour - 1 }, () =>
      `('${club.id}','${ana.id}','${carla.id}','emoji','wave')`).join(',');
    await pool.query(
      `INSERT INTO flirts (nightclub_id, sender_id, recipient_id, type, emoji) VALUES ${values}`);

    expect((await send(ana, beto)).status).toBe(201); // el 20
    const res = await send(ana, beto);
    expect(res.status).toBe(429);
    expect(res.body.error.message).toMatch(/por hora/);
  });

  it('"no me interesa" corta al emisor por el resto de la noche', async () => {
    const first = await send(ana, beto);
    const react = await api().post(url(`/flirts/${first.body.flirt.id}/react`))
      .set(auth(beto)).send({ reaction: 'not_interested' });
    expect(react.status).toBe(200);
    expect(react.body.flirt.status).toBe('declined');

    const res = await send(ana, beto);
    expect(res.status).toBe(403);
    // Beto sí puede escribirle a Ana: el silencio es en un solo sentido.
    expect((await send(beto, ana)).status).toBe(201);
  });
});

describe('Bandeja y reacciones', () => {
  beforeEach(seatEveryone);

  it('cada quien ve lo que recibió y lo que envió', async () => {
    await send(ana, beto);
    await send(carla, ana).catch(() => {}); // carla no acepta, pero sí puede enviar
    const recibidos = await api().get(url('/flirts/received')).set(auth(beto));
    const enviados = await api().get(url('/flirts/sent')).set(auth(ana));
    expect(recibidos.body.flirts).toHaveLength(1);
    expect(recibidos.body.flirts[0].sender_name).toBe('Ana');
    expect(enviados.body.flirts).toHaveLength(1);
  });

  it('quien apagó los flirts ve la bandeja vacía', async () => {
    await send(ana, beto);
    await prefs(beto, { accept_flirts: false });
    const res = await api().get(url('/flirts/received')).set(auth(beto));
    expect(res.body).toEqual({ flirts: [], accept_flirts: false });
  });

  it('marcar visto cambia el estado una sola vez', async () => {
    const { body } = await send(ana, beto);
    const seen = await api().post(url(`/flirts/${body.flirt.id}/view`)).set(auth(beto));
    expect(seen.body.flirt.status).toBe('viewed');
    const viewedAt = seen.body.flirt.viewed_at;
    const again = await api().post(url(`/flirts/${body.flirt.id}/view`)).set(auth(beto));
    expect(again.body.flirt.viewed_at).toBe(viewedAt);
  });

  it('reaccionar acepta el flirt y avisa al emisor', async () => {
    const { body } = await send(ana, beto);
    const res = await api().post(url(`/flirts/${body.flirt.id}/react`)).set(auth(beto)).send({ reaction: 'fire' });
    expect(res.status).toBe(200);
    expect(res.body.flirt).toMatchObject({ status: 'accepted', reaction: 'fire' });
    const { rows } = await pool.query(`SELECT audience FROM events WHERE type = 'flirt_reaction'`);
    expect(rows[0].audience.userIds).toEqual([ana.id]);
  });

  it('solo el receptor puede ver o reaccionar; un tercero recibe 404', async () => {
    const { body } = await send(ana, beto);
    expect((await api().post(url(`/flirts/${body.flirt.id}/react`)).set(auth(carla))
      .send({ reaction: 'like' })).status).toBe(404);
    expect((await api().post(url(`/flirts/${body.flirt.id}/view`)).set(auth(ana))).status).toBe(404);
  });

  it('una reacción inventada se rechaza', async () => {
    const { body } = await send(ana, beto);
    expect((await api().post(url(`/flirts/${body.flirt.id}/react`)).set(auth(beto))
      .send({ reaction: 'marry_me' })).status).toBe(400);
  });

  it('los flirts caducan con la noche y desaparecen de la bandeja', async () => {
    const { body } = await send(ana, beto);
    await pool.query(`UPDATE flirts SET expires_at = now() - interval '1 minute' WHERE id = $1`, [body.flirt.id]);
    const inbox = await api().get(url('/flirts/received')).set(auth(beto));
    expect(inbox.body.flirts).toHaveLength(0);
    const react = await api().post(url(`/flirts/${body.flirt.id}/react`)).set(auth(beto)).send({ reaction: 'like' });
    expect(react.status).toBe(409);
  });

  it('el gerente no tiene acceso a la bandeja de nadie', async () => {
    const { body } = await send(ana, beto);
    const res = await api().post(url(`/flirts/${body.flirt.id}/view`)).set(auth(manager));
    expect(res.status).toBe(404);
  });
});
