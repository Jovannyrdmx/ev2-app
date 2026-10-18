/**
 * Entrada de efectivo, corte X y copia de recibo (D122).
 *
 *   * Meter efectivo a una caja abierta: con PIN de gerente, abre el cajón, saca su
 *     ticket y suma a lo que la caja debe entregar en el corte.
 *   * Corte X: cómo va la caja sin cerrarla. Lo pide el gerente (PIN en la caja o desde
 *     su panel); la pantalla de la caja nunca recibe el esperado (D105).
 *   * Copia de recibo: el cajero reimprime un recibo de SU caja en ESTE turno, marcado
 *     como copia; el ticket de acceso del cover nunca se copia.
 */
'use strict';

const { randomUUID } = require('crypto');
const { setupSchema, truncateAll, closePool, pool } = require('./helpers/db');
const { api, auth } = require('./helpers/api');
const f = require('./helpers/factories');
const { fullCut, declareAndClose } = require('./helpers/cut');
const pins = require('../src/services/pins');

let club; let manager; let cajero; let otroCajero; let waiter; let table; let beer;
let pinGerente; let impresora;

beforeAll(setupSchema);
afterAll(closePool);

const url = (p) => `/api/nightclubs/${club.id}${p}`;

async function codigoDe(user) {
  const pin = await pins.issuePin(pool, { userId: user.id });
  await pool.query('UPDATE users SET must_change_pin = false WHERE id = $1', [user.id]);
  return pin;
}

beforeEach(async () => {
  await truncateAll();
  club = await f.createNightclub({ slug: 'ev2-caja-x' });
  manager = await f.createUser(club.id, { role: 'manager', display_name: 'Gerente Ana' });
  cajero = await f.createUser(club.id, { role: 'cashier', display_name: 'Caja PB' });
  otroCajero = await f.createUser(club.id, { role: 'cashier', display_name: 'Caja VIP' });
  waiter = await f.createUser(club.id, { role: 'waiter', on_shift: true, display_name: 'Luis' });
  table = await f.createTable(club.id, { code: 'T-1', section: 'ZONA ROJA', capacity: 4 });
  beer = await f.createDrink(club.id, { name: 'Cerveza', price: 60, stock: 40 });
  await pool.query(
    `INSERT INTO zone_bars (nightclub_id, section, location_id) VALUES ($1,'ZONA ROJA',$2)`,
    [club.id, club.bar_id]);
  pinGerente = await codigoDe(manager);
  await f.openTill(club.id, { cashier: cajero, locationId: club.bar_id, authorizer: manager, openingFloat: 1000 });
  const res = await api().post(url('/printers')).set(auth(manager)).send({
    location_id: club.bar_id, name: 'Caja PB', purpose: 'till', connection: 'network',
    host: '192.168.1.52', drawer_pin: 2,
  });
  impresora = res.body.printer;
});

const jobs = async (kind) => (await pool.query(
  `SELECT id::text AS id, kind, preview, printer_id::text AS printer_id FROM print_jobs
    WHERE nightclub_id = $1 AND kind = $2::text ORDER BY created_at`, [club.id, kind])).rows;

const meter = (body = {}, user = cajero) => api().post(url('/shifts/me/cash-ins')).set(auth(user))
  .send({ amount: 500, reason: 'Cambio en monedas', manager_pin: pinGerente, ...body });

async function cobrarPedido() {
  const pedido = await api().post(url('/orders')).set(auth(waiter)).send({
    client_request_id: randomUUID(), table_id: table.id, items: [{ drink_id: beer.id, quantity: 2 }],
  });
  const res = await api().post(url('/till/payments')).set(auth(cajero))
    .send({ transaction_id: pedido.body.order.transaction_id, method: 'cash', amount: 120, cash_received: 200 });
  expect(res.status).toBe(201);
  return pedido.body.order;
}

describe('Meter efectivo a la caja (D122)', () => {
  it('con PIN del gerente: suma a lo que debe tener, abre el cajón y saca su ticket', async () => {
    const antes = await fullCut(club.id, cajero);
    expect(antes.cash_to_hand).toBe('1000.00');

    const res = await meter();
    expect(res.status).toBe(201);
    expect(res.body.cash_in).toMatchObject({ amount: '500.00', currency: 'MXN', authorized_by: 'Gerente Ana' });
    expect(res.body.drawer.status).toBe('queued');
    expect(res.body.ticket).not.toBeNull();

    const despues = await fullCut(club.id, cajero);
    expect(despues.cash_to_hand).toBe('1500.00');
    expect(despues.cash_ins_total).toBe('500.00');

    const [papel] = await jobs('cash_in');
    expect(papel.printer_id).toBe(impresora.id);
    expect(papel.preview).toContain('ENTRADA DE EFECTIVO');
    expect(papel.preview).toMatch(/ENTRA\s+\$500\.00/);
    expect(papel.preview).toContain('Cambio en monedas');
    expect(papel.preview).toContain('Autorizó: Gerente Ana');
    expect(await jobs('drawer')).toHaveLength(1);

    const { rows } = await pool.query(
      `SELECT action FROM audit_log WHERE nightclub_id = $1 AND action = 'till.cash_in'`, [club.id]);
    expect(rows).toHaveLength(1);
  });

  it('el corte la cuenta en lo que debía entregar y la imprime', async () => {
    await meter({ amount: 300 });
    await cobrarPedido(); // +120 en efectivo
    const corte = await declareAndClose(club.id, cajero, {
      declared_cash: 1420, counted_cash: 1420, manager_pin: pinGerente,
    });
    expect(corte.status).toBe(201);
    const { rows } = await pool.query(
      `SELECT expected_cash::text AS e, difference::text AS d, cash_ins_total::text AS i
         FROM shift_closings WHERE user_id = $1`, [cajero.id]);
    expect(rows[0]).toEqual({ e: '1420.00', d: '0.00', i: '300.00' });
    const [papel] = await jobs('shift_cut');
    expect(papel.preview).toContain('ENTRADAS DE EFECTIVO');
    expect(papel.preview).toMatch(/Entradas de efectivo\s+\$300\.00/);
  });

  it('sin PIN válido, sin motivo, sin caja o con un rol sin caja, no entra nada', async () => {
    const otro = pinGerente === '000000' ? '111111' : '000000';
    expect((await meter({ manager_pin: otro })).status).toBeGreaterThanOrEqual(400);
    expect((await meter({ reason: 'x' })).status).toBe(400);
    expect((await meter({}, otroCajero)).status).toBe(409);
    expect((await meter({}, waiter)).status).toBe(403);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM shift_cash_ins');
    expect(rows[0].n).toBe(0);
  });

  it('una entrada no se edita ni se borra', async () => {
    const res = await meter();
    await expect(pool.query('UPDATE shift_cash_ins SET amount = 1 WHERE id = $1', [res.body.cash_in.id]))
      .rejects.toThrow(/no se edita/);
    await expect(pool.query('DELETE FROM shift_cash_ins WHERE id = $1', [res.body.cash_in.id]))
      .rejects.toThrow(/no se edita/);
  });

  it('en dólares suma a los dólares, no a los pesos', async () => {
    const res = await meter({ amount: 40, currency: 'USD' });
    expect(res.status).toBe(201);
    const cut = await fullCut(club.id, cajero);
    expect(cut.cash_to_hand).toBe('1000.00');
    expect(cut.usd_to_hand).toBe('40.00');
    expect(cut.has_usd).toBe(true);
  });
});

describe('Corte X (D122)', () => {
  it('el cajero lo saca con el PIN del gerente; sale en su caja y la respuesta no trae números', async () => {
    await meter({ amount: 200 });
    await cobrarPedido();
    const res = await api().post(url('/till/x-report')).set(auth(cajero)).send({ manager_pin: pinGerente });
    expect(res.status).toBe(202);
    expect(JSON.stringify(res.body)).not.toMatch(/1320|cash_to_hand/);

    const [papel] = await jobs('x_report');
    expect(papel.printer_id).toBe(impresora.id);
    const p = papel.preview;
    expect(p).toContain('CORTE X');
    expect(p).toContain('la caja sigue abierta');
    expect(p).toMatch(/Fondo de caja\s+\$1,000\.00/);
    expect(p).toMatch(/Efectivo cobrado\s+\$120\.00/);
    expect(p).toMatch(/Entradas de efectivo\s+\$200\.00/);
    expect(p).toMatch(/DEBE TENER\s+\$1,320\.00/);
    expect(p).toMatch(/Pidió\s+Gerente Ana/);
    for (const linea of p.split('\n')) expect(linea.length).toBeLessThanOrEqual(48);
    // La caja sigue abierta.
    expect((await fullCut(club.id, cajero)).closing).toBeNull();
  });

  it('sin el PIN del gerente no sale', async () => {
    expect((await api().post(url('/till/x-report')).set(auth(cajero)).send({})).status).toBe(400);
    const otro = pinGerente === '000000' ? '111111' : '000000';
    expect((await api().post(url('/till/x-report')).set(auth(cajero)).send({ manager_pin: otro })).status)
      .toBeGreaterThanOrEqual(400);
    expect(await jobs('x_report')).toHaveLength(0);
  });

  it('el gerente lo saca desde su panel para cualquier caja abierta; un mesero no', async () => {
    const { rows } = await pool.query('SELECT id FROM staff_shifts WHERE user_id = $1', [cajero.id]);
    const res = await api().post(url(`/tills/${rows[0].id}/x-report`)).set(auth(manager));
    expect(res.status).toBe(202);
    expect(await jobs('x_report')).toHaveLength(1);
    expect((await api().post(url(`/tills/${rows[0].id}/x-report`)).set(auth(waiter))).status).toBe(403);
    expect((await api().post(url(`/tills/${randomUUID()}/x-report`)).set(auth(manager))).status).toBe(404);
  });

  it('una caja ya cortada no tiene corte X', async () => {
    await declareAndClose(club.id, cajero, { declared_cash: 1000, counted_cash: 1000, manager_pin: pinGerente });
    const { rows } = await pool.query('SELECT id FROM staff_shifts WHERE user_id = $1', [cajero.id]);
    expect((await api().post(url(`/tills/${rows[0].id}/x-report`)).set(auth(manager))).status).toBe(409);
  });
});

describe('Copia de recibo para el cajero (D122)', () => {
  it('lista los recibos de su turno y saca una copia marcada, anotada en la bitácora', async () => {
    await cobrarPedido();
    const lista = await api().get(url('/till/receipts')).set(auth(cajero));
    expect(lista.status).toBe(200);
    expect(lista.body.receipts).toHaveLength(1);
    const [r] = lista.body.receipts;
    expect(r).toMatchObject({ amount: '120.00', currency: 'MXN' });
    expect(r.folio).toHaveLength(6);

    const copia = await api().post(url(`/till/receipts/${r.id}/reprint`)).set(auth(cajero));
    expect(copia.status).toBe(202);
    const recibos = await jobs('receipt');
    expect(recibos).toHaveLength(2);
    expect(recibos[1].preview).toContain('** COPIA - REIMPRESION **');
    expect(recibos[1].preview).toContain('Reimprimió: Caja PB');
    expect(recibos[1].preview).toContain('RECIBO DE PAGO');
    // La copia no se vuelve a listar ni se copia.
    expect((await api().get(url('/till/receipts')).set(auth(cajero))).body.receipts).toHaveLength(1);
    expect((await api().post(url(`/till/receipts/${recibos[1].id}/reprint`)).set(auth(cajero))).status).toBe(400);
    const { rows } = await pool.query(
      `SELECT 1 FROM audit_log WHERE nightclub_id = $1 AND action = 'receipt.reprint'`, [club.id]);
    expect(rows).toHaveLength(1);
  });

  it('no copia recibos de otra caja, ni sin caja abierta, ni un mesero', async () => {
    await cobrarPedido();
    const [r] = (await api().get(url('/till/receipts')).set(auth(cajero))).body.receipts;
    // Sin caja abierta: no hay copia.
    expect((await api().post(url(`/till/receipts/${r.id}/reprint`)).set(auth(otroCajero))).status).toBe(409);
    // Con SU caja abierta en otra barra, el recibo de la caja de al lado no es suyo.
    await f.openTill(club.id, { cashier: otroCajero, locationId: club.locations['barra-alta'], authorizer: manager });
    expect((await api().post(url(`/till/receipts/${r.id}/reprint`)).set(auth(otroCajero))).status).toBe(404);
    expect((await api().post(url(`/till/receipts/${r.id}/reprint`)).set(auth(waiter))).status).toBe(403);
    expect(await jobs('receipt')).toHaveLength(1);
  });

  it('el ticket de acceso del cover nunca se lista para copiar', async () => {
    const hostess = await f.createUser(club.id, { role: 'hostess', display_name: 'Anfitriona' });
    await f.openDoorTill(club.id, { hostess, authorizer: manager });
    const coverId = await f.coverOf(club.id);
    await pool.query(
      `INSERT INTO print_jobs (nightclub_id, printer_id, kind, ref_id, payload, preview, created_by)
       VALUES ($1,$2,'receipt',$3,'\\x00','ACCESOS: 3',$4)`,
      [club.id, impresora.id, randomUUID(), hostess.id]);
    expect(coverId).toBeTruthy();
    const lista = await api().get(url('/till/receipts')).set(auth(hostess));
    expect(lista.status).toBe(200);
    expect(lista.body.receipts).toHaveLength(0);
  });
});
