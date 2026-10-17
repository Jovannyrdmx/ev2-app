/**
 * El RP y su comisión sobre lo que consumen sus invitados (D98).
 *
 * El sistema no identifica a cada cliente, así que el vínculo es una MESA (la puerta
 * captura el código del RP) o un COVER vendido con el código. Lo que se prueba:
 *   * el RP nace con su código al darlo de alta, y solo él ve lo suyo;
 *   * la mesa/cover quedan ligados a UN solo RP, y solo el gerente lo corrige;
 *   * la comisión es el 10% (configurable, copiado al ligar) de lo PAGADO esa noche;
 *   * se liquida una vez por noche, con la noche terminada, y llega al saldo del RP.
 */
'use strict';

const { randomUUID } = require('crypto');
const { setupSchema, truncateAll, closePool, pool } = require('./helpers/db');
const { api, auth } = require('./helpers/api');
const f = require('./helpers/factories');
const { managerPin } = require('./helpers/voucher');

let club; let manager; let hostess; let waiter; let guest; let rpA; let rpB;
let table; let otherTable; let beer; let night; let reservationId;

beforeAll(setupSchema);
afterAll(closePool);

const url = (p) => `/api/nightclubs/${club.id}${p}`;
const wait = (ms) => new Promise((r) => { setTimeout(r, ms); });

beforeEach(async () => {
  await truncateAll();
  club = await f.createNightclub({ slug: 'ev2-rp' });
  manager = await f.createUser(club.id, { role: 'manager', display_name: 'Gerente' });
  hostess = await f.createUser(club.id, { role: 'hostess' });
  // Desde D118 en la puerta cobra la anfitriona con la caja de Cover abierta.
  await f.openDoorTill(club.id, { hostess, authorizer: manager });
  waiter = await f.createUser(club.id, { role: 'waiter', on_shift: true, display_name: 'Luis' });
  guest = await f.createUser(club.id, { role: 'guest', display_name: 'Ana' });
  rpA = await f.createUser(club.id, { role: 'rp', display_name: 'Rafa RP' });
  rpB = await f.createUser(club.id, { role: 'rp', display_name: 'Beto RP' });
  const rp = require('../src/services/rp');
  await rp.ensureProfile(pool, { nightclubId: club.id, userId: rpA.id });
  await rp.ensureProfile(pool, { nightclubId: club.id, userId: rpB.id });
  table = await f.createTable(club.id, { code: 'V-1', section: 'VIP', capacity: 8 });
  otherTable = await f.createTable(club.id, { code: 'T-9', section: 'ZONA ROJA', capacity: 4 });
  beer = await f.createDrink(club.id, { name: 'Cerveza', price: 60, stock: 200 });
  const ev = await pool.query(
    `INSERT INTO events_calendar (nightclub_id, name, event_date, doors_open_at, ticket_price, status)
     VALUES ($1,'Viernes',(now() - interval '1 hour')::date, now() - interval '1 hour', 0, 'published')
     RETURNING id`, [club.id]);
  night = ev.rows[0];
  const r = await pool.query(
    `INSERT INTO reservations (nightclub_id, user_id, table_id, event_id, guest_count, status,
                               currency, total_estimated, deposit_amount, starts_at, duration_minutes)
     VALUES ($1,$2,$3,$4,6,'confirmed','MXN',4000,1200, now(), 180) RETURNING id`,
    [club.id, guest.id, table.id, night.id]);
  reservationId = r.rows[0].id;
});

const codeOf = async (user) => (await pool.query(
  'SELECT code FROM rp_profiles WHERE user_id = $1', [user.id])).rows[0].code;

const attach = (code, as = hostess, id = reservationId) => api()
  .post(url(`/reservations/${id}/rp`)).set(auth(as)).send({ code });

/** Una orden de 2 cervezas ($120) en la mesa, cobrada en efectivo por el gerente. */
async function consumo(tableId = table.id, { pay = true } = {}) {
  const res = await api().post(url('/orders')).set(auth(waiter)).send({
    client_request_id: randomUUID(), table_id: tableId, items: [{ drink_id: beer.id, quantity: 2 }],
  });
  if (res.status !== 201) throw new Error(`pedido: ${res.status} ${JSON.stringify(res.body)}`);
  const order = res.body.order;
  if (pay) {
    const p = await api().post(url('/manual-payments/register')).set(auth(manager)).send({
      transaction_id: order.transaction_id, method: 'cash', amount: Number(order.subtotal),
      currency: order.currency,
    });
    if (p.status >= 300) throw new Error(`cobro: ${p.status} ${JSON.stringify(p.body)}`);
  }
  return order;
}

const miNoche = (rp, query = '') => api().get(url(`/rp/me${query}`)).set(auth(rp));
const cerrarNoche = async () => {
  await pool.query(`UPDATE events_calendar SET closes_at = now() + interval '1 second' WHERE id = $1`, [night.id]);
  await wait(1300);
};

describe('El alta del RP', () => {
  it('nace con su código personal y su 10%', async () => {
    const res = await api().post(url('/employees')).set(auth(manager)).send({
      email: 'nuevo.rp@ev2.mx', first_name: 'Nico', last_name: 'RP', role: 'rp',
      birth_date: '1995-05-05', country: 'MX',
    });
    expect(res.status).toBe(201);
    expect(res.body.employee.role).toBe('rp');
    const { rows } = await pool.query(
      `SELECT code, commission_pct::text AS pct, active FROM rp_profiles WHERE user_id = $1`,
      [res.body.employee.id]);
    expect(rows[0].code).toMatch(/^[A-Z2-9]{6}$/);
    expect(rows[0]).toMatchObject({ pct: '10.00', active: true });
  });

  it('el gerente lista a sus RPs y cambia el porcentaje; nadie más puede', async () => {
    const lista = await api().get(url('/rps')).set(auth(manager));
    expect(lista.body.rps.map((r) => r.display_name).sort()).toEqual(['Beto RP', 'Rafa RP']);
    const patch = await api().patch(url(`/rps/${rpA.id}`)).set(auth(manager)).send({ commission_pct: 12.5 });
    expect(patch.status).toBe(200);
    expect(patch.body.profile.commission_pct).toBe('12.50');
    expect((await api().patch(url(`/rps/${rpA.id}`)).set(auth(hostess)).send({ commission_pct: 50 })).status).toBe(403);
    expect((await api().patch(url(`/rps/${rpA.id}`)).set(auth(rpA)).send({ commission_pct: 50 })).status).toBe(403);
  });
});

describe('Ligar la mesa a un RP', () => {
  it('la puerta captura el código y la mesa queda ligada a un solo RP', async () => {
    const buscar = await api().get(url(`/rp/lookup?code=${await codeOf(rpA)}`)).set(auth(hostess));
    expect(buscar.body.rp.display_name).toBe('Rafa RP');
    const ok = await attach((await codeOf(rpA)).toLowerCase());
    expect(ok.body).toMatchObject({ ok: true, rp: { display_name: 'Rafa RP' } });
    // Repetir el mismo no estorba; otro distinto lo rechaza la puerta.
    expect((await attach(await codeOf(rpA))).body.ok).toBe(true);
    const otro = await attach(await codeOf(rpB));
    expect(otro.body).toMatchObject({ ok: false, reason: 'has_other_rp' });
    const mala = await attach('ZZZZZZ');
    expect(mala.body).toMatchObject({ ok: false, reason: 'unknown_code' });
  });

  it('solo el gerente corrige el RP de una mesa, con motivo, y queda en la bitácora', async () => {
    await attach(await codeOf(rpA));
    const sinMotivo = await api().put(url(`/reservations/${reservationId}/rp`)).set(auth(manager))
      .send({ code: await codeOf(rpB), reason: '' });
    expect(sinMotivo.status).toBe(400);
    expect((await api().put(url(`/reservations/${reservationId}/rp`)).set(auth(hostess))
      .send({ code: await codeOf(rpB), reason: 'error de captura' })).status).toBe(403);
    const ok = await api().put(url(`/reservations/${reservationId}/rp`)).set(auth(manager))
      .send({ code: await codeOf(rpB), reason: 'error de captura' });
    expect(ok.status).toBe(200);
    const { rows } = await pool.query('SELECT rp_user_id FROM rp_attributions WHERE reservation_id = $1', [reservationId]);
    expect(rows[0].rp_user_id).toBe(rpB.id);
    const log = await pool.query(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'rp.reassign_table'`);
    expect(log.rows[0].n).toBe(1);
  });

  it('un RP inactivo ya no sirve en la puerta', async () => {
    const code = await codeOf(rpA);
    await api().patch(url(`/rps/${rpA.id}`)).set(auth(manager)).send({ active: false });
    expect((await attach(code)).body.reason).toBe('unknown_code');
  });
});

describe('La comisión', () => {
  it('es el 10% de todo lo pagado en la mesa esa noche; lo de otras mesas y lo sin pagar no cuenta', async () => {
    await attach(await codeOf(rpA));
    await consumo();                       // 120 pagado en su mesa
    await consumo();                       // otros 120
    await consumo(table.id, { pay: false }); // sin pagar: no cuenta
    await consumo(otherTable.id);          // otra mesa: no cuenta
    const res = await miNoche(rpA);
    expect(res.status).toBe(200);
    expect(res.body.night.totals).toEqual([{ currency: 'MXN', base: '240.00', commission: '24.00' }]);
    expect(res.body.night.lines[0]).toMatchObject({ kind: 'table', table_code: 'V-1', items: 2 });
  });

  it('un pedido cancelado deja de contar', async () => {
    await attach(await codeOf(rpA));
    const o1 = await consumo();
    await consumo();
    const c = await api().post(url(`/orders/${o1.id}/status`)).set(auth(manager))
      .send({ status: 'cancelled', reason: 'se acabó' });
    expect(c.status).toBe(200);
    const res = await miNoche(rpA);
    expect(res.body.night.totals[0]).toMatchObject({ base: '120.00', commission: '12.00' });
  });

  it('el cover vendido con su código suma, y una cortesía no', async () => {
    const code = await codeOf(rpA);
    const venta = (over = {}) => api().post(url('/door/admissions')).set(auth(hostess)).send({
      kind: 'general', quantity: 2, unit_price: 200, payment_method: 'cash', event_id: night.id,
      rp_code: code, ...over,
    });
    const a = await venta();
    expect(a.status).toBe(201);
    expect(a.body.rp).toMatchObject({ ok: true, display_name: 'Rafa RP' });
    // La cortesía la autoriza un gerente, con su motivo (D109).
    const c = await venta({ payment_method: 'courtesy', notes: 'invitado del DJ',
      manager_pin: (await managerPin(club.id)).pin });
    expect(c.status).toBe(201);
    const mala = await venta({ rp_code: 'ZZZZZZ' });
    expect(mala.status).toBe(201);               // el cover se vende igual
    expect(mala.body.rp).toMatchObject({ ok: false, reason: 'unknown_code' });
    const res = await miNoche(rpA);
    expect(res.body.night.totals).toEqual([{ currency: 'MXN', base: '400.00', commission: '40.00' }]);
  });

  it('cambiarle el porcentaje al RP no reescribe lo ya ligado', async () => {
    await attach(await codeOf(rpA));
    await consumo();
    await api().patch(url(`/rps/${rpA.id}`)).set(auth(manager)).send({ commission_pct: 50 });
    const res = await miNoche(rpA);
    expect(res.body.night.totals[0].commission).toBe('12.00');
  });

  it('cada RP ve solo lo suyo y el resto de roles no entra', async () => {
    await attach(await codeOf(rpA));
    await consumo();
    const b = await miNoche(rpB);
    expect(b.body.night === null || b.body.night.lines.length === 0).toBe(true);
    // D120: sin código de RP no hay nada que ver (404); con código, cualquier puesto entra.
    expect((await miNoche(waiter)).status).toBe(404);
    expect((await api().get(url('/rp/summary')).set(auth(rpA))).status).toBe(403);
    const resumen = await api().get(url('/rp/summary')).set(auth(manager));
    expect(resumen.body.rps).toHaveLength(1);
    expect(resumen.body.rps[0]).toMatchObject({ display_name: 'Rafa RP', tables: 1, covers: 0 });
  });
});

describe('Liquidar la noche', () => {
  const liquidar = (as = manager, over = {}) => api().post(url('/rp/settle')).set(auth(as))
    .send({ rp_user_id: rpA.id, event_id: night.id, ...over });

  it('no se liquida con la noche abierta', async () => {
    await attach(await codeOf(rpA));
    await consumo();
    const res = await liquidar();
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/todavía no termina/);
  });

  it('al cerrar la noche abona al saldo del RP, una sola vez', async () => {
    await attach(await codeOf(rpA));
    await consumo();
    await consumo();
    await cerrarNoche();
    expect((await liquidar(hostess)).status).toBe(403);
    const res = await liquidar(manager, { note: 'pagado en efectivo' });
    expect(res.status).toBe(201);
    expect(res.body.settlements[0]).toMatchObject({ currency: 'MXN', base: '240.00', amount: '24.00' });

    // Llega al libro como dinero del empleado y su portal ya lo suma.
    const tx = await pool.query(
      `SELECT type, direction, status, amount::text AS amount FROM transactions
        WHERE payee_user_id = $1`, [rpA.id]);
    expect(tx.rows).toEqual([{ type: 'rp_commission', direction: 'in', status: 'paid', amount: '24.00' }]);
    const earn = await api().get('/api/employees/me/earnings').set(auth(rpA));
    expect(earn.status).toBe(200);
    expect(earn.body.balances.find((b) => b.currency === 'MXN').available).toBe('24.00');

    const otra = await liquidar();
    expect(otra.status).toBe(409);
    // Ya liquidada, la mesa no se reasigna.
    const cambio = await api().put(url(`/reservations/${reservationId}/rp`)).set(auth(manager))
      .send({ code: await codeOf(rpB), reason: 'tarde' });
    expect(cambio.status).toBe(409);
    // Y la liquidación no se edita ni se borra.
    await expect(pool.query('UPDATE rp_settlements SET amount = 1')).rejects.toThrow();
    await expect(pool.query('DELETE FROM rp_settlements')).rejects.toThrow();
  });

  it('un RP sin consumo no genera liquidación', async () => {
    await cerrarNoche();
    const res = await liquidar();
    expect(res.status).toBe(422);
  });
});

describe('Todo el personal como RP sin dejar su puesto (D120)', () => {
  const enroll = require('../scripts/rp-enroll-all');
  const quiet = () => {};
  let admin;

  beforeEach(async () => {
    admin = await f.createUser(club.id, { role: 'admin', display_name: 'Dueño' });
  });

  const profiles = async () => (await pool.query(
    `SELECT u.display_name, u.role, p.code, p.commission_pct::text AS pct
       FROM rp_profiles p JOIN users u ON u.id = p.user_id ORDER BY u.display_name`)).rows;

  it('da código a empleados y gerentes con el % indicado; no a clientes ni al dueño; no toca los existentes', async () => {
    const antes = await codeOf(rpA);
    const r = await enroll.run({ pct: 5, log: quiet });
    expect(r).toMatchObject({ created: 3, dry: false }); // gerente, anfitriona y mesero
    const all = await profiles();
    const byName = Object.fromEntries(all.map((p) => [p.display_name, p]));
    expect(Object.keys(byName).sort()).toEqual(['Beto RP', 'Gerente', 'Luis', 'Rafa RP', 'hostess Test']);
    expect(byName.Luis).toMatchObject({ role: 'waiter', pct: '5.00' });
    expect(byName.Gerente).toMatchObject({ role: 'manager', pct: '5.00' });
    expect(byName['Rafa RP']).toMatchObject({ role: 'rp', pct: '10.00', code: antes });
    expect(new Set(all.map((p) => p.code)).size).toBe(all.length);
    for (const p of all) expect(p.code).toMatch(/^[A-HJKMNP-Z2-9]{6}$/);
    expect(all.find((p) => p.role === 'guest' || p.role === 'admin')).toBeUndefined();
    expect(admin).toBeTruthy();

    // Repetirlo no crea ni cambia nada.
    expect((await enroll.run({ pct: 5, log: quiet })).created).toBe(0);
    expect(await profiles()).toEqual(all);
    const log = await pool.query(
      `SELECT count(*)::int AS n FROM audit_log WHERE action = 'rp.enroll_all_from_console'`);
    expect(log.rows[0].n).toBe(1);
  });

  it('en simulación no guarda nada, y sin % no corre', async () => {
    expect((await enroll.run({ pct: 5, dry: true, log: quiet })).created).toBe(3);
    expect((await profiles()).length).toBe(2);
    await expect(enroll.run({ log: quiet })).rejects.toThrow(/--pct/);
    await expect(enroll.run({ pct: 101, log: quiet })).rejects.toThrow(/--pct/);
  });

  it('la lista en CSV trae nombre, puesto, código y %', async () => {
    const out = [];
    await enroll.run({ pct: 5, csv: true, log: (l) => out.push(l) });
    expect(out[0]).toBe('nombre,puesto,codigo,comision_pct,activo,nuevo');
    expect(out).toHaveLength(6);
    expect(out.find((l) => l.startsWith('Luis,waiter,'))).toMatch(/^Luis,waiter,[A-Z2-9]{6},5\.00,si,si$/);
  });

  it('el mesero con código sigue siendo mesero, la puerta le liga la mesa y cobra su %', async () => {
    await enroll.run({ pct: 5, log: quiet });
    const code = await codeOf(waiter);
    const res = await attach(code);
    expect(res.body).toMatchObject({ ok: true, rp: { display_name: 'Luis', code } });
    await consumo();

    const mia = await miNoche(waiter);
    expect(mia.status).toBe(200);
    expect(mia.body.profile).toMatchObject({ code, commission_pct: '5.00' });
    expect(mia.body.night.totals).toEqual([{ currency: 'MXN', base: '120.00', commission: '6.00' }]);
    expect((await api().get(url('/rp/me/nights')).set(auth(waiter))).status).toBe(200);

    // Su puesto no cambió: sigue levantando pedidos.
    expect((await pool.query('SELECT role FROM users WHERE id = $1', [waiter.id])).rows[0].role).toBe('waiter');
    await consumo();

    // El gerente lo ve en la lista con su puesto y le puede cambiar el %.
    const lista = await api().get(url('/rps')).set(auth(manager));
    expect(lista.body.rps.find((r) => r.user_id === waiter.id)).toMatchObject({ role: 'waiter', code });
    const patch = await api().patch(url(`/rps/${waiter.id}`)).set(auth(manager)).send({ commission_pct: 7 });
    expect(patch.status).toBe(200);

    // Y se le liquida como a cualquier RP (5% copiado al ligar: 240 → 12).
    await cerrarNoche();
    const liq = await api().post(url('/rp/settle')).set(auth(manager))
      .send({ rp_user_id: waiter.id, event_id: night.id });
    expect(liq.status).toBe(201);
    expect(liq.body.settlements[0]).toMatchObject({ currency: 'MXN', base: '240.00', amount: '12.00' });
  });

  it('un cliente o un empleado sin código no es RP', async () => {
    expect((await miNoche(guest)).status).toBe(404);
    expect((await api().get(url('/rp/me/nights')).set(auth(waiter))).status).toBe(404);
    expect((await api().patch(url(`/rps/${waiter.id}`)).set(auth(manager)).send({ active: false })).status).toBe(404);
    await cerrarNoche();
    const settle = await api().post(url('/rp/settle')).set(auth(manager))
      .send({ rp_user_id: waiter.id, event_id: night.id });
    expect(settle.status).toBe(404);
  });
});
