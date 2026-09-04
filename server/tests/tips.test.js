'use strict';

// Propinas, turnos y montos sugeridos (D20). Parte 2: tragos al staff y canciones.

const { randomUUID } = require('crypto');
const { setupSchema, truncateAll, closePool, pool } = require('./helpers/db');
const { api, auth } = require('./helpers/api');
const f = require('./helpers/factories');

let club; let manager; let guest; let other; let waiter; let dancer; let dj;

beforeAll(setupSchema);
afterAll(closePool);

beforeEach(async () => {
  await truncateAll();
  await pool.query('TRUNCATE tip_presets, song_request_votes CASCADE');
  club = await f.createNightclub({ slug: 'ev2-tips' });
  manager = await f.createUser(club.id, { role: 'manager' });
  guest = await f.createUser(club.id, { role: 'guest', display_name: 'Ana' });
  other = await f.createUser(club.id, { role: 'guest', display_name: 'Beto' });
  waiter = await f.createUser(club.id, { role: 'waiter', display_name: 'Luis' });
  dancer = await f.createUser(club.id, { role: 'dancer', display_name: 'Nina' });
  dj = await f.createUser(club.id, { role: 'dj', display_name: 'DJ Max' });
  await pool.query(
    `INSERT INTO employee_profiles (user_id, country, stage_name) VALUES ($1,'MX',NULL), ($2,'MX','Nina Star'), ($3,'MX',NULL)`,
    [waiter.id, dancer.id, dj.id]);
});

const url = (p) => `/api/nightclubs/${club.id}${p}`;
const startShift = (user, section) => api().post(url('/staff/shifts/start')).set(auth(user)).send(section ? { section } : {});
const tip = (from, to, over = {}) => api().post(url('/tips')).set(auth(from)).send({
  client_request_id: randomUUID(), to_user_id: to.id, amount: 100, ...over,
});

describe('Montos sugeridos', () => {
  it('nacen con los montos que el club ya usaba', async () => {
    const res = await api().get(url('/tip-presets')).set(auth(guest));
    expect(res.status).toBe(200);
    const byRole = Object.fromEntries(res.body.presets.map((p) => [p.role, p]));
    expect(byRole.waiter).toMatchObject({ min_tip: '50.00', suggested: [50, 100, 200, 500], accepts_drinks: false });
    expect(byRole.dancer).toMatchObject({ min_tip: '100.00', suggested: [100, 200, 500, 1000], accepts_drinks: true });
    expect(byRole.dj).toMatchObject({ min_tip: '100.00', suggested: [100, 200, 500, 1000] });
    expect(byRole.light_tech).toMatchObject({ min_tip: '75.00', suggested: [75, 150, 300, 750] });
  });

  it('el gerente los edita; un cliente no', async () => {
    const res = await api().put(url('/tip-presets/waiter')).set(auth(manager))
      .send({ min_tip: 80, suggested: [80, 150, 300], accepts_drinks: true });
    expect(res.status).toBe(200);
    expect(res.body.preset).toMatchObject({ min_tip: '80.00', suggested: [80, 150, 300], accepts_drinks: true });
    expect((await api().put(url('/tip-presets/waiter')).set(auth(guest)).send({ min_tip: 0 })).status).toBe(403);
  });

  it('un sugerido por debajo del mínimo se rechaza', async () => {
    const res = await api().put(url('/tip-presets/dj')).set(auth(manager)).send({ min_tip: 200, suggested: [100, 300] });
    expect(res.status).toBe(422);
  });
});

describe('Turnos', () => {
  it('el empleado abre y cierra su turno; abrir dos veces no duplica', async () => {
    const open = await startShift(waiter, 'ZONA ROJA');
    expect(open.status).toBe(201);
    expect(open.body.shift.section).toBe('ZONA ROJA');
    const again = await startShift(waiter);
    expect(again.status).toBe(200);
    expect(again.body.already_open).toBe(true);
    expect((await api().post(url('/staff/shifts/end')).set(auth(waiter))).status).toBe(200);
    expect((await api().post(url('/staff/shifts/end')).set(auth(waiter))).status).toBe(409);
  });

  it('un cliente no tiene turnos', async () => {
    expect((await startShift(guest)).status).toBe(403);
  });

  it('el gerente cierra un turno olvidado y ve la lista', async () => {
    await startShift(dancer);
    const list = await api().get(url('/staff/shifts')).set(auth(manager));
    expect(list.body.shifts.map((s) => s.display_name)).toEqual(['Nina']);
    expect((await api().post(url(`/staff/${dancer.id}/shifts/end`)).set(auth(manager))).status).toBe(200);
    expect((await api().get(url('/staff/shifts')).set(auth(manager))).body.shifts).toHaveLength(0);
    expect((await api().get(url('/staff/shifts')).set(auth(guest))).status).toBe(403);
  });

  it('el cliente ve quién está en turno con sus montos y nombre artístico', async () => {
    await startShift(dancer, 'ESCENARIO');
    await startShift(dj);
    const res = await api().get(url('/staff/on-shift')).set(auth(guest));
    expect(res.status).toBe(200);
    expect(res.body.staff.map((s) => s.display_name).sort()).toEqual(['DJ Max', 'Nina Star']);
    const nina = res.body.staff.find((s) => s.role === 'dancer');
    expect(nina).toMatchObject({ role_label: 'Ambientadora', section: 'ESCENARIO', min_tip: '100.00', accepts_drinks: true });
    expect(nina.suggested).toEqual([100, 200, 500, 1000]);
    const onlyDj = await api().get(url('/staff/on-shift?role=dj')).set(auth(guest));
    expect(onlyDj.body.staff).toHaveLength(1);
    expect(JSON.stringify(res.body)).not.toMatch(/email|phone/);
  });
});

describe('Propinas', () => {
  it('crea la propina y su asiento en la misma transacción, en pending', async () => {
    const res = await tip(guest, waiter, { message: '¡Gracias!' });
    expect(res.status).toBe(201);
    expect(res.body.tip).toMatchObject({ amount: '100.00', currency: 'MXN', status: 'pending', to_name: 'Luis', from_name: 'Ana', message: '¡Gracias!' });
    const { rows } = await pool.query(
      `SELECT type, direction, amount, status, payer_user_id, payee_user_id, reference_type, reference_id FROM transactions`);
    expect(rows).toEqual([expect.objectContaining({
      type: 'tip', direction: 'in', amount: '100.00', status: 'pending', payer_user_id: guest.id, payee_user_id: waiter.id,
      reference_type: 'tip', reference_id: res.body.tip.id,
    })]);
  });

  it('es idempotente: dos POST iguales, una fila en tips y una en transactions', async () => {
    const id = randomUUID();
    const first = await tip(guest, waiter, { client_request_id: id });
    const second = await tip(guest, waiter, { client_request_id: id });
    expect(second.status).toBe(200);
    expect(second.headers['idempotent-replay']).toBe('true');
    expect(second.body.tip.id).toBe(first.body.tip.id);
    const n = await pool.query('SELECT (SELECT count(*) FROM tips)::int AS t, (SELECT count(*) FROM transactions)::int AS x');
    expect(n.rows[0]).toEqual({ t: 1, x: 1 });
  });

  it('el libro contable no acepta cambiar el monto ni borrar', async () => {
    await tip(guest, waiter);
    await expect(pool.query(`UPDATE transactions SET amount = 1`)).rejects.toThrow(/immutable/);
    await expect(pool.query(`DELETE FROM transactions`)).rejects.toThrow();
  });

  it('respeta el mínimo por rol, y el mínimo editado', async () => {
    const low = await tip(guest, dancer, { amount: 99 });
    expect(low.status).toBe(422);
    expect(low.body.error.details.min_tip).toBe(100);
    expect((await tip(guest, dancer, { amount: 100 })).status).toBe(201);
    await api().put(url('/tip-presets/waiter')).set(auth(manager)).send({ min_tip: 20 });
    expect((await tip(guest, waiter, { amount: 20 })).status).toBe(201);
  });

  it('solo a personal del club; no a uno mismo ni a un cliente', async () => {
    expect((await tip(guest, other)).status).toBe(404);
    expect((await tip(guest, manager)).status).toBe(404);
    expect((await tip(waiter, waiter)).status).toBe(422);
    const otroClub = await f.createNightclub({ slug: 'otro' });
    const ajeno = await f.createUser(otroClub.id, { role: 'waiter' });
    expect((await tip(guest, ajeno)).status).toBe(404);
  });

  it('una propina pendiente no entra al saldo; confirmada por el gerente sí', async () => {
    const res = await tip(guest, waiter, { amount: 150 });
    let bal = (await api().get('/api/employees/me/earnings').set(auth(waiter))).body.balances[0];
    expect(bal).toMatchObject({ currency: 'MXN', earned: '0.00' });

    const ok = await api().post(url(`/tips/${res.body.tip.id}/confirm`)).set(auth(manager)).send({ provider: 'cash' });
    expect(ok.status).toBe(200);
    expect(ok.body.tip.status).toBe('paid');
    bal = (await api().get('/api/employees/me/earnings').set(auth(waiter))).body.balances[0];
    expect(bal).toMatchObject({ earned: '150.00', available: '150.00' });
    expect((await api().post(url(`/tips/${res.body.tip.id}/confirm`)).set(auth(manager)).send({})).status).toBe(409);
    expect((await api().post(url(`/tips/${res.body.tip.id}/confirm`)).set(auth(waiter)).send({})).status).toBe(403);
  });

  it('cancelar solo pendientes, con motivo, y no toca el saldo', async () => {
    const res = await tip(guest, waiter);
    expect((await api().post(url(`/tips/${res.body.tip.id}/cancel`)).set(auth(manager)).send({})).status).toBe(400);
    const c = await api().post(url(`/tips/${res.body.tip.id}/cancel`)).set(auth(manager)).send({ reason: 'Se capturó dos veces' });
    expect(c.body.tip.status).toBe('cancelled');
    const paid = await tip(guest, waiter);
    await api().post(url(`/tips/${paid.body.tip.id}/confirm`)).set(auth(manager)).send({});
    expect((await api().post(url(`/tips/${paid.body.tip.id}/cancel`)).set(auth(manager)).send({ reason: 'x' })).status).toBe(409);
  });

  it('anónima: el empleado no ve quién fue; el gerente sí', async () => {
    await tip(guest, dancer, { anonymous: true, message: 'Bailas increíble' });
    const mine = await api().get(url('/staff/me/tips')).set(auth(dancer));
    expect(mine.body.tips[0]).toMatchObject({ from_name: 'Anónimo', from_user_id: null, message: 'Bailas increíble' });
    const all = await api().get(url('/tips')).set(auth(manager));
    expect(all.body.tips[0]).toMatchObject({ from_name: 'Ana', anonymous: true });
    expect((await api().get(url('/tips')).set(auth(dancer))).status).toBe(403);
  });

  it('cada quien ve las suyas: el cliente las que dio, el empleado las que recibió', async () => {
    await tip(guest, waiter);
    await tip(other, dancer);
    expect((await api().get(url('/tips/mine')).set(auth(guest))).body.tips).toHaveLength(1);
    expect((await api().get(url('/staff/me/tips')).set(auth(waiter))).body.tips).toHaveLength(1);
    expect((await api().get(url('/staff/me/tips')).set(auth(dj))).body.tips).toHaveLength(0);
    expect((await api().get(url('/staff/me/tips')).set(auth(guest))).status).toBe(403);
  });

  it('avisa al empleado al recibirla y al cobrarse', async () => {
    const res = await tip(guest, waiter);
    await api().post(url(`/tips/${res.body.tip.id}/confirm`)).set(auth(manager)).send({});
    const { rows } = await pool.query(`SELECT type, audience FROM events WHERE type IN ('tip_received','tip_paid') ORDER BY id`);
    expect(rows.map((r) => r.type)).toEqual(['tip_received', 'tip_paid']);
    expect(rows[0].audience.userIds).toEqual([waiter.id]);
  });
});

// ---------------------------------------------------------------- parte 2

describe('Tragos al personal', () => {
  let mesa; let shot;
  const invite = (from, to, over = {}) => api().post(url(`/staff/${to.id}/drinks`)).set(auth(from)).send({
    client_request_id: randomUUID(), drink_id: shot.id, ...over,
  });
  beforeEach(async () => {
    mesa = await f.createTable(club.id, { code: '5', section: 'GENERAL' });
    shot = await f.createDrink(club.id, { name: 'Tequila shot', price: 100, stock: 10 });
    await api().post(url(`/tables/${mesa.id}/seat`)).set(auth(guest));
    await startShift(dancer);
    await startShift(waiter);
  });

  it('crea un pedido real cobrado al cliente, no reembolsable', async () => {
    const res = await invite(guest, dancer, { quantity: 2, message: 'Salud' });
    expect(res.status).toBe(201);
    expect(res.body.staff_drink).toMatchObject({
      status: 'pending', drink_name: 'Tequila shot', amount: '200.00', to_name: 'Nina', from_name: 'Ana', from_table_code: '5',
    });
    const order = (await pool.query('SELECT * FROM drink_orders')).rows[0];
    expect(order).toMatchObject({ sender_id: guest.id, recipient_id: dancer.id, table_id: mesa.id, status: 'pending' });
    expect(order.message).toMatch(/Para Nina \(Ambientadora\) de Ana, mesa 5/);
    const ledger = (await pool.query('SELECT type, amount, status, payer_user_id, metadata FROM transactions')).rows;
    expect(ledger).toEqual([expect.objectContaining({ type: 'drink_order', amount: '200.00', status: 'pending', payer_user_id: guest.id })]);
    expect(ledger[0].metadata.non_refundable).toBe(true);
    expect(Number((await pool.query('SELECT quantity FROM inventory WHERE drink_id = $1', [shot.id])).rows[0].quantity)).toBe(8);
  });

  it('solo a roles con permiso (ambientadoras), y el gerente puede cambiarlo', async () => {
    const res = await invite(guest, waiter);
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/no se le pueden invitar/);
    await api().put(url('/tip-presets/waiter')).set(auth(manager)).send({ accepts_drinks: true });
    expect((await invite(guest, waiter)).status).toBe(201);
  });

  it('solo a quien está en turno, y solo desde una mesa', async () => {
    await api().post(url('/staff/shifts/end')).set(auth(dancer));
    expect((await invite(guest, dancer)).status).toBe(422);
    await startShift(dancer);
    expect((await invite(other, dancer)).status).toBe(422); // Beto no está sentado
  });

  it('el empleado acepta, y el cliente no puede cancelar el pedido', async () => {
    const res = await invite(guest, dancer);
    const ok = await api().post(url(`/staff-drinks/${res.body.staff_drink.id}/accept`)).set(auth(dancer));
    expect(ok.body.staff_drink.status).toBe('confirmed');
    const cancel = await api().post(url(`/orders/${res.body.staff_drink.drink_order_id}/status`)).set(auth(guest)).send({ status: 'cancelled' });
    expect(cancel.status).toBe(403);
    expect((await api().post(url(`/staff-drinks/${res.body.staff_drink.id}/accept`)).set(auth(waiter))).status).toBe(404);
  });

  it('si lo rechaza, el pedido vuelve a la mesa del cliente sin reembolso', async () => {
    const res = await invite(guest, dancer);
    const no = await api().post(url(`/staff-drinks/${res.body.staff_drink.id}/decline`)).set(auth(dancer));
    expect(no.body.staff_drink).toMatchObject({ status: 'declined', returned_to_sender: true });
    const order = (await pool.query('SELECT * FROM drink_orders')).rows[0];
    expect(order).toMatchObject({ recipient_id: null, table_id: mesa.id, returned_to_sender: true, status: 'pending' });
    expect(order.message).toMatch(/entregar en mesa 5/);
    expect((await pool.query('SELECT status FROM transactions')).rows[0].status).toBe('pending');
    const mine = await api().get(url('/staff/me/drinks')).set(auth(dancer));
    expect(mine.body.staff_drinks[0].status).toBe('declined');
  });

  it('es idempotente y sin existencias no cobra', async () => {
    const id = randomUUID();
    await invite(guest, dancer, { client_request_id: id });
    const again = await invite(guest, dancer, { client_request_id: id });
    expect(again.status).toBe(200);
    expect((await pool.query('SELECT count(*)::int AS n FROM staff_drinks')).rows[0].n).toBe(1);
    const none = await invite(guest, dancer, { drink_id: (await f.createDrink(club.id, { stock: 0 })).id });
    expect(none.status).toBe(409);
    expect((await pool.query('SELECT count(*)::int AS n FROM transactions')).rows[0].n).toBe(1);
  });
});

describe('Solicitudes de canción', () => {
  const song = (from, over = {}) => api().post(url('/song-requests')).set(auth(from)).send({
    client_request_id: randomUUID(), song_title: 'La Chona', artist: 'Los Tucanes de Tijuana', ...over,
  });
  beforeEach(async () => { await startShift(dj); });

  it('llega al DJ en turno; sin DJ en turno no se puede pedir', async () => {
    const res = await song(guest, { message: 'Para la mesa 5' });
    expect(res.status).toBe(201);
    expect(res.body.merged).toBe(false);
    expect(res.body.song_request).toMatchObject({ song_title: 'La Chona', dj_name: 'DJ Max', votes: 1, status: 'requested', tips_total: '0.00' });
    expect(res.body.song_request.requesters).toEqual([expect.objectContaining({ name: 'Ana', message: 'Para la mesa 5' })]);
    await api().post(url('/staff/shifts/end')).set(auth(dj));
    expect((await song(other)).status).toBe(422);
  });

  it('la misma canción pedida por otra persona se junta en una sola con votos', async () => {
    const first = await song(guest);
    const second = await song(other, { song_title: 'la chóna!!', artist: 'LOS TUCANES DE TIJUANA', message: 'Sí!' });
    expect(second.status).toBe(200);
    expect(second.body.merged).toBe(true);
    expect(second.body.song_request.id).toBe(first.body.song_request.id);
    expect(second.body.song_request.votes).toBe(2);
    expect(second.body.song_request.requesters.map((r) => r.name)).toEqual(['Ana', 'Beto']);
    expect((await pool.query('SELECT count(*)::int AS n FROM song_requests')).rows[0].n).toBe(1);
  });

  it('la misma persona no puede pedir dos veces la misma canción', async () => {
    await song(guest);
    expect((await song(guest)).status).toBe(409);
  });

  it('la propina al DJ es aparte y se registra como propina, incluso al sumarse a una existente', async () => {
    await song(guest);
    const res = await song(other, { tip_amount: 150 });
    expect(res.status).toBe(200);
    expect(res.body.song_request).toMatchObject({ votes: 2, tips_total: '150.00', tips_count: 1 });
    const tips = (await pool.query('SELECT to_user_id, amount, status, song_request_id FROM tips')).rows;
    expect(tips).toEqual([expect.objectContaining({ to_user_id: dj.id, amount: '150.00', status: 'pending', song_request_id: res.body.song_request.id })]);
    expect((await pool.query(`SELECT type FROM transactions`)).rows[0].type).toBe('song_request');
    // Respeta el mínimo del DJ.
    expect((await song(guest, { song_title: 'Otra', tip_amount: 50 })).status).toBe(422);
  });

  it('la cola del DJ va por votos; la marca tocada y avisa a quienes la pidieron; no puede rechazar', async () => {
    await song(guest, { song_title: 'Suavemente', artist: 'Elvis Crespo' });
    const chona = await song(other);
    await song(guest);
    const queue = await api().get(url('/dj/song-requests')).set(auth(dj));
    expect(queue.body.song_requests.map((s) => [s.song_title, s.votes])).toEqual([['La Chona', 2], ['Suavemente', 1]]);

    const played = await api().post(url(`/song-requests/${chona.body.song_request.id}/play`)).set(auth(dj));
    expect(played.body.song_request.status).toBe('played');
    const ev = (await pool.query(`SELECT audience FROM events WHERE type = 'song_played'`)).rows[0];
    expect(ev.audience.userIds.sort()).toEqual([guest.id, other.id].sort());
    expect((await api().post(url(`/song-requests/${chona.body.song_request.id}/play`)).set(auth(dj))).status).toBe(409);
    expect((await api().get(url('/dj/song-requests')).set(auth(dj))).body.song_requests).toHaveLength(1);
    expect((await api().post(url(`/song-requests/${chona.body.song_request.id}/decline`)).set(auth(dj))).status).toBe(404);
  });

  it('otro DJ no toca la cola ajena; un cliente tampoco', async () => {
    const req1 = await song(guest);
    const dj2 = await f.createUser(club.id, { role: 'dj' });
    expect((await api().post(url(`/song-requests/${req1.body.song_request.id}/play`)).set(auth(dj2))).status).toBe(404);
    expect((await api().post(url(`/song-requests/${req1.body.song_request.id}/play`)).set(auth(guest))).status).toBe(403);
    expect((await api().get(url('/dj/song-requests')).set(auth(guest))).status).toBe(403);
  });

  it('los clientes ven la cola para votar, sin montos de propina', async () => {
    await song(guest, { tip_amount: 100 });
    const res = await api().get(url('/song-requests')).set(auth(other));
    expect(res.status).toBe(200);
    expect(res.body.song_requests[0]).toMatchObject({ song_title: 'La Chona', votes: 1, i_voted: false });
    expect(res.body.song_requests[0].tips_total).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain(guest.id);
    const mine = await api().get(url('/song-requests/mine')).set(auth(guest));
    expect(mine.body.song_requests).toHaveLength(1);
  });

  it('después de tocada, pedirla de nuevo abre una solicitud nueva', async () => {
    const first = await song(guest);
    await api().post(url(`/song-requests/${first.body.song_request.id}/play`)).set(auth(dj));
    const again = await song(guest);
    expect(again.status).toBe(201);
    expect(again.body.song_request.id).not.toBe(first.body.song_request.id);
  });

  it('es idempotente', async () => {
    const id = randomUUID();
    const a = await song(guest, { client_request_id: id, tip_amount: 100 });
    const b = await song(guest, { client_request_id: id, tip_amount: 100 });
    expect(b.status).toBe(200);
    expect(b.body.song_request.id).toBe(a.body.song_request.id);
    expect((await pool.query('SELECT count(*)::int AS n FROM tips')).rows[0].n).toBe(1);
  });
});

describe('Tablero de reconocimiento', () => {
  const confirm = (id) => api().post(url(`/tips/${id}/confirm`)).set(auth(manager)).send({});
  it('ordena por propinas cobradas; el cliente no ve montos', async () => {
    const a = await tip(guest, dancer, { amount: 500 });
    const b = await tip(other, dancer, { amount: 200 });
    const c = await tip(guest, waiter, { amount: 300 });
    await tip(other, waiter, { amount: 900 }); // pendiente: no cuenta
    await Promise.all([a, b, c].map((r) => confirm(r.body.tip.id)));

    const staffView = await api().get(url('/leaderboard')).set(auth(manager));
    expect(staffView.body.leaderboard).toEqual([
      expect.objectContaining({ rank: 1, display_name: 'Nina Star', total_mxn: '700.00', tips_count: 2, fans: 2 }),
      expect.objectContaining({ rank: 2, display_name: 'Luis', total_mxn: '300.00', tips_count: 1 }),
    ]);
    const guestView = await api().get(url('/leaderboard?role=dancer')).set(auth(guest));
    expect(guestView.body.leaderboard).toEqual([{ rank: 1, user_id: dancer.id, display_name: 'Nina Star', role: 'dancer', fans: 2 }]);
    expect(JSON.stringify(guestView.body)).not.toMatch(/700|total/);
  });
});
