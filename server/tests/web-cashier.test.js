/**
 * La caja de la barra en el navegador (D77): las decisiones de `web/js/cashier.js`,
 * y la pantalla `web/caja.html` contra su controlador real.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..', '..', 'web');
const leer = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const Cashier = require(path.join(ROOT, 'js', 'cashier.js'));
const Cut = require(path.join(ROOT, 'js', 'shift-cut.js'));
const Roles = require(path.join(ROOT, 'js', 'roles.js'));
const Take = require(path.join(ROOT, 'js', 'order-taking.js'));
const catalogo = require(path.join(ROOT, 'js', 'format.js'));

const html = leer('caja.html');
const controlador = leer('js/cashier-screen.js');

// ============================================================================

describe('EV2Cashier: la fase de la caja', () => {
  it('sin asignación, asignada y cerrada, abierta', () => {
    expect(Cashier.phase(null)).toBe('no_assignment');
    expect(Cashier.phase({ till: null, assignment: null })).toBe('no_assignment');
    expect(Cashier.phase({ till: null, assignment: { location_id: 'b' } })).toBe('closed');
    expect(Cashier.phase({ till: { location_id: 'b' }, assignment: null })).toBe('open');
  });
});

describe('EV2Cashier: abrir la caja', () => {
  const asignada = { till: null, assignment: { location_id: 'b', location_name: 'Barra baja' } };

  it('pide el fondo (puede ser cero) y el código del gerente', () => {
    expect(Cashier.openBlocker({ state: asignada, amount: '', pin: '123456' })).toBe('till.errFloat');
    expect(Cashier.openBlocker({ state: asignada, amount: '-5', pin: '123456' })).toBe('till.errFloat');
    expect(Cashier.openBlocker({ state: asignada, amount: '0', pin: '12345' })).toBe('cut.errPin');
    expect(Cashier.openBlocker({ state: asignada, amount: '0', pin: '123456' })).toBeNull();
    expect(Cashier.openBlocker({ state: asignada, amount: '1500', pin: '123456' })).toBeNull();
  });

  it('sin barra asignada, o con la caja ya abierta, no se intenta', () => {
    expect(Cashier.openBlocker({ state: null, amount: '100', pin: '123456' })).toBe('till.errNoBar');
    expect(Cashier.openBlocker({
      state: { till: { location_id: 'b' } }, amount: '100', pin: '123456',
    })).toBe('till.errOpen');
  });

  it('manda el fondo como número y NUNCA la barra: la barra la decide el rol', () => {
    const body = Cashier.openPayload({ amount: '1500.555', pin: '123456' });
    expect(body).toEqual({ opening_float: 1500.56, currency: 'MXN', manager_pin: '123456' });
    expect(body).not.toHaveProperty('location_id');
  });
});

describe('EV2Cashier: lo que falta por cobrar', () => {
  const pedidos = [
    { order_id: 'o3', taken_by: 'w2', taken_by_name: 'Ana', subtotal: '80.00', created_at: '2026-10-03T23:10:00Z' },
    { order_id: 'o1', taken_by: 'w1', taken_by_name: 'Luis', subtotal: '120.00', created_at: '2026-10-03T23:00:00Z' },
    { order_id: 'o2', taken_by: 'w1', taken_by_name: 'Luis', subtotal: '60.50', created_at: '2026-10-03T23:20:00Z' },
  ];

  it('agrupa por mesero, con el total en centavos exactos', () => {
    const grupos = Cashier.groupByWaiter(pedidos);
    expect(grupos.map((g) => g.name)).toEqual(['Luis', 'Ana']);
    expect(grupos[0].orders.map((o) => o.order_id)).toEqual(['o1', 'o2']);
    expect(grupos[0].total).toBe('180.50');
    expect(grupos[1].total).toBe('80.00');
  });

  it('el grupo que lleva más tiempo sin pagar va primero', () => {
    const grupos = Cashier.groupByWaiter([pedidos[0], pedidos[2]]);
    expect(grupos.map((g) => g.name)).toEqual(['Ana', 'Luis']);
  });

  it('un pedido sin mesero se agrupa aparte con el nombre que se le dé', () => {
    const grupos = Cashier.groupByWaiter([{ order_id: 'x', subtotal: '10', created_at: null }],
      { noName: 'Sin mesero' });
    expect(grupos[0].name).toBe('Sin mesero');
  });

  it('suma y resume', () => {
    expect(Cashier.total(pedidos)).toBe('260.50');
    expect(Cashier.itemsSummary({ items: [{ name: 'Corona', quantity: 2 }, { name: 'Shot', quantity: 1 }] }))
      .toBe('2× Corona, 1× Shot');
    expect(Cashier.destination({ table_code: 'T-3' })).toBe('T-3');
    expect(Cashier.destination({ delivery_point_name: 'Pista A' })).toBe('Pista A');
    expect(Cashier.destination({})).toBeNull();
  });

  it('el cobro va por el pedido, sin `on_behalf_of`', () => {
    const order = Cashier.asChargeable({
      transaction_id: 't1', subtotal: '120.00', currency: 'MXN', sender_id: 'g1',
    });
    const body = Take.chargePayload({ order, method: 'cash', reference: '' });
    expect(body).toEqual({ transaction_id: 't1', method: 'cash', amount: 120, currency: 'MXN' });
  });
});

describe('EV2Cashier: qué eventos refrescan la caja', () => {
  const ev = (type, payload = {}) => ({ type: 'event', event_type: type, payload });

  it('los de pedidos y pagos sí; los de otras cosas no', () => {
    expect(Cashier.shouldRefresh(ev('order_paid'))).toBe(true);
    expect(Cashier.shouldRefresh(ev('order_cancelled'))).toBe(true);
    expect(Cashier.shouldRefresh(ev('payment_confirmed'))).toBe(true);
    expect(Cashier.shouldRefresh(ev('song_requested'))).toBe(false);
    expect(Cashier.shouldRefresh(null)).toBe(false);
  });

  it('un pedido nuevo de OTRA barra no la mueve', () => {
    expect(Cashier.shouldRefresh(ev('order_created', { bar_location_id: 'b2' }), { locationId: 'b1' }))
      .toBe(false);
    expect(Cashier.shouldRefresh(ev('order_created', { bar_location_id: 'b1' }), { locationId: 'b1' }))
      .toBe(true);
  });
});

describe('EV2ShiftCut con caja (D77)', () => {
  const t = (k) => k;
  const corte = (over = {}) => ({
    shift: { id: 's', location_id: 'b' },
    totals: {
      by_method: [{ method: 'cash', amount: '120.00', count: 1 }],
      tips: { amount: '0.00', count: 0 },
    },
    opening_float: '1000.00',
    cash_to_hand: '1120.00',
    pending_orders: [],
    closing: null,
    ...over,
  });

  it('el fondo es el primer renglón del corte', () => {
    const lineas = Cut.lines(corte(), t);
    expect(lineas[0]).toMatchObject({ key: 'float', value: '1000.00', cash: true });
    expect(lineas[1]).toMatchObject({ key: 'cash', value: '120.00' });
  });

  it('sin fondo, no hay renglón de fondo', () => {
    expect(Cut.lines(corte({ opening_float: '0.00' }), t).map((l) => l.key)).toEqual(['cash']);
  });

  it('con pedidos sin cobrar no cierra, salvo que el gerente lo marque', () => {
    const c = corte({ pending_orders: [{ order_id: 'o1' }] });
    expect(Cut.pendingCount(c)).toBe(1);
    expect(Cut.closeBlocker(1120, c, { pin: '123456' })).toBe('cut.errPending');
    expect(Cut.closeBlocker(1120, c, { pin: '123456', acknowledgePending: true })).toBeNull();
  });

  it('sabe si es el corte de una caja', () => {
    expect(Cut.isTill(corte())).toBe(true);
    expect(Cut.isTill(corte({ shift: { id: 's' } }))).toBe(false);
  });
});

describe('El rol de cajero', () => {
  it('entra a caja.html', () => {
    expect(Roles.describe('cashier', 'es')).toMatchObject({ label: 'Cajero', home: 'caja.html', ready: true });
  });
});

// ============================================================================

const abiertas = [];
afterEach(() => { while (abiertas.length) abiertas.pop().close(); });

function documento() {
  const dom = new JSDOM(html, { url: 'https://ev2.local/caja.html' });
  abiertas.push(dom.window);
  return dom.window.document;
}

function idsQueBusca(fuente) {
  const ids = new Set();
  const re = /\$\('([a-z0-9-]+)'\)/g;
  let m = re.exec(fuente);
  while (m) { ids.add(m[1]); m = re.exec(fuente); }
  return [...ids];
}

describe('caja.html y su controlador', () => {
  it('cada id que busca cashier-screen.js existe en caja.html', () => {
    const doc = documento();
    const faltantes = idsQueBusca(controlador).filter((id) => !doc.getElementById(id));
    expect(faltantes).toEqual([]);
  });

  it('las hojas nacen cerradas y el folio escondido', () => {
    const doc = documento();
    for (const id of ['sale-sheet', 'charge-sheet', 'screen-till', 'till-open', 'till-closed']) {
      expect({ id, hidden: doc.getElementById(id).hasAttribute('hidden') }).toEqual({ id, hidden: true });
    }
    expect(doc.getElementById('sale-reference').hasAttribute('hidden')).toBe(true);
    expect(doc.getElementById('charge-reference').hasAttribute('hidden')).toBe(true);
    expect(doc.getElementById('btn-sale-charge').hasAttribute('disabled')).toBe(true);
  });

  it('el código del gerente va enmascarado y no se autocompleta', () => {
    const pin = documento().getElementById('open-pin');
    expect(pin.getAttribute('type')).toBe('password');
    expect(pin.getAttribute('autocomplete')).toBe('off');
    expect(pin.getAttribute('maxlength')).toBe('6');
  });

  it('carga lo que usa ANTES del controlador', () => {
    const srcs = [...documento().querySelectorAll('script')].map((s) => s.getAttribute('src'));
    const yo = srcs.indexOf('js/cashier-screen.js');
    for (const src of ['js/api.js', 'js/format.js', 'js/roles.js', 'js/password-gate.js',
      'js/client.js', 'js/order-taking.js', 'js/terminal-charge.js', 'js/shift-cut.js',
      'js/cashier.js']) {
      expect({ src, antes: srcs.indexOf(src) > -1 && srcs.indexOf(src) < yo })
        .toEqual({ src, antes: true });
    }
  });

  it('la barra no se manda al abrir: la decide el rol de la noche', () => {
    expect(controlador).not.toMatch(/till\/open[^;]*location_id/);
  });

  it('el PIN se borra siempre después de usarlo', () => {
    expect(controlador).toMatch(/finally \{[^}]*\$\('open-pin'\)\.value = ''/);
  });

  it('si el cobro entró pero el recibo no salió, lo avisa en vez de felicitar (D79)', () => {
    expect(controlador).toMatch(/receipt === null[\s\S]{0,120}till\.noReceipt/);
    expect(controlador).toMatch(/chargedToast\(t\('till\.saleDone'/);
  });

  it('con una terminal ya esperando, vuelve a mostrar ese cobro en vez de atorarse (D82)', () => {
    expect(controlador).toMatch(/err\.details\s*&& \(err\.details\.charge_id \|\| err\.details\.terminal_charge_id\)/);
    expect(controlador).toMatch(/resumeLiveCharge\(err\)/);
    expect(controlador).toMatch(/avisoTerminal\(message\)/);
  });

  it('se esconde todo detrás de la puerta de la contraseña', () => {
    expect(controlador).toMatch(/PASSWORD_GATE_HIDES\s*=\s*\[[^\]]*'sale-sheet'[^\]]*'charge-sheet'/);
  });
});

describe('nada de la caja sale sin traducir', () => {
  const claves = (fuente, attr) => [...fuente.matchAll(new RegExp(`${attr}="([^"]+)"`, 'g'))]
    .map((m) => m[1]);

  it('cada data-i18n de caja.html y cada t() del controlador existe en los dos idiomas', () => {
    const usadas = new Set([...claves(html, 'data-i18n'), ...claves(html, 'data-i18n-placeholder'),
      ...claves(html, 'data-i18n-title')]);
    for (const m of controlador.matchAll(/t\('([a-zA-Z]+\.[a-zA-Z0-9_.]+)'/g)) usadas.add(m[1]);
    for (const key of Take.methodKeys()) usadas.add(`take.method.${key}`);
    for (const key of ['till.errOpen', 'till.errNoBar', 'till.errFloat', 'cut.errPin',
      'cut.float', 'cut.pending', 'cut.ackPending', 'cut.errPending']) usadas.add(key);
    // Lo que planCharge puede devolver y lo que se arma con plantillas (D79).
    for (const key of Cashier.METHOD_KEYS) usadas.add(`take.method.${key}`);
    for (const key of ['till.errNothingDue', 'till.errSplitTwice', 'till.errSplitAmount',
      'till.errSplitSame', 'till.errMethod', 'till.errReceived', 'till.errReceivedShort',
      'take.blocked.no_reference', 'take.blocked.no_terminal', 'till.payment1',
      'till.amount', 'till.received', 'prn.pTill']) usadas.add(key);
    expect(usadas.size).toBeGreaterThan(30);
    for (const lang of ['es', 'en']) {
      catalogo.setLanguage(lang);
      const faltantes = [...usadas].filter((k) => catalogo.t(k) === k);
      expect({ lang, faltantes }).toEqual({ lang, faltantes: [] });
    }
  });
});

describe('EV2Cashier: el cobro con cambio y dos formas de pago (D79)', () => {
  const pedido = (extra = {}) => ({ transaction_id: 't1', subtotal: '450.00', ...extra });
  const terminals = [{ id: 'x', active: true }];

  it('lo que falta descuenta lo ya pagado', () => {
    expect(Cashier.remainingOf(pedido())).toBe('450.00');
    expect(Cashier.remainingOf(pedido({ remaining: '150' }))).toBe('150.00');
    expect(Cashier.remainingOf(null)).toBe('0.00');
  });

  it('el crédito VIP (D97): el monto lo fija el saldo y no se manda como efectivo', () => {
    const vip = pedido({ subtotal: '120.00', vip_credit_balance: '50.00' });
    const plan = Cashier.planCharge({ order: vip, split: true, a: { method: 'vip_credit' },
      b: { method: 'cash', amount: '70', received: '100' } });
    expect(plan.steps.map((x) => [x.method, x.amount])).toEqual([['vip_credit', '50.00'], ['cash', '70.00']]);
    // Si el saldo ya paga todo, no hay que dividir.
    const todo = pedido({ subtotal: '120.00', vip_credit_balance: '500.00' });
    expect(Cashier.planCharge({ order: todo, split: true, a: { method: 'vip_credit' }, b: { method: 'cash' } }))
      .toEqual({ error: 'till.errVipCoversAll' });
    expect(Cashier.planCharge({ order: todo, a: { method: 'vip_credit' } }).steps[0])
      .toMatchObject({ method: 'vip_credit', amount: '120.00' });
    // Como segunda forma, no puede cubrir lo que no tiene.
    expect(Cashier.planCharge({ order: vip, split: true, a: { method: 'cash', amount: '40', received: '40' },
      b: { method: 'vip_credit' } })).toEqual({ error: 'till.errVipShort' });
    expect(Cashier.paymentPayload(vip, plan.steps[0], 'k')).toMatchObject({ method: 'vip_credit' });
  });

  it('una forma ya usada no se ofrece otra vez, y no se divide dos veces', () => {
    const conParte = pedido({ remaining: '150', parts: [{ method: 'cash', amount: '300' }] });
    // Sin tipo de cambio los dólares no se ofrecen (D86); con él, todas.
    // El crédito VIP (D97) solo se ofrece si la mesa tiene saldo.
    const sinVip = Cashier.METHOD_KEYS.filter((m) => m !== 'vip_credit');
    expect(Cashier.methodsFor(pedido())).toEqual(sinVip.filter((m) => m !== 'cash_usd'));
    expect(Cashier.methodsFor(pedido(), { usdRate: { id: '1', rate: '17.5' } })).toEqual(sinVip);
    expect(Cashier.methodsFor(pedido({ vip_credit_balance: '80.00' }))).toContain('vip_credit');
    expect(Cashier.methodsFor(conParte)).not.toContain('cash');
    expect(Cashier.canSplit(conParte)).toBe(false);
    expect(Cashier.planCharge({ order: conParte, split: true, a: { method: 'card_terminal', amount: 50 },
      b: { method: 'mercadopago_point' } })).toEqual({ error: 'till.errSplitTwice' });
  });

  it('calcula el cambio en centavos exactos', () => {
    expect(Cashier.change('500', '450')).toBe('50.00');
    expect(Cashier.change('0.3', '0.1')).toBe('0.20');
    expect(Cashier.change('400', '450')).toBe('-50.00');
    expect(Cashier.change('', '450')).toBeNull();
    expect(Cashier.change('abc', '450')).toBeNull();
  });

  it('un solo pago en efectivo: cobra todo lo que falta y lleva lo recibido', () => {
    const r = Cashier.planCharge({ order: pedido(), a: { method: 'cash', received: '500' } });
    expect(r.steps).toEqual([{ method: 'cash', amount: '450.00', reference: null,
      cash_received: '500.00', change: '50.00', terminal: false }]);
    expect(Cashier.paymentPayload(pedido(), r.steps[0], 'req-1')).toEqual({
      transaction_id: 't1', method: 'cash', amount: 450, cash_received: 500, client_request_id: 'req-1',
    });
  });

  it('el efectivo sin teclear lo recibido se acepta; si no alcanza, no', () => {
    expect(Cashier.planCharge({ order: pedido(), a: { method: 'cash' } }).steps[0].cash_received).toBeNull();
    expect(Cashier.planCharge({ order: pedido(), a: { method: 'cash', received: '400' } }))
      .toEqual({ error: 'till.errReceivedShort' });
    expect(Cashier.planCharge({ order: pedido(), a: { method: 'cash', received: 'x' } }))
      .toEqual({ error: 'till.errReceived' });
  });

  it('dos formas: la segunda paga el resto, y la terminal va primero', () => {
    const r = Cashier.planCharge({ order: pedido(), split: true, terminals,
      a: { method: 'cash', amount: '300', received: '500' }, b: { method: 'mercadopago_point' } });
    expect(r.steps.map((s) => [s.method, s.amount])).toEqual([
      ['mercadopago_point', '150.00'], ['cash', '300.00']]);
    expect(r.steps[1].change).toBe('200.00');
  });

  it('dos formas: rechaza montos fuera de rango, la misma forma y el folio vacío', () => {
    const base = { order: pedido(), split: true, terminals };
    for (const amount of ['0', '450', '600', '']) {
      expect(Cashier.planCharge({ ...base, a: { method: 'cash', amount }, b: { method: 'card_terminal', reference: 'F1' } }))
        .toEqual({ error: 'till.errSplitAmount' });
    }
    expect(Cashier.planCharge({ ...base, a: { method: 'cash', amount: '100' }, b: { method: 'cash' } }))
      .toEqual({ error: 'till.errSplitSame' });
    expect(Cashier.planCharge({ ...base, a: { method: 'cash', amount: '100' }, b: { method: 'card_terminal', reference: ' ' } }))
      .toEqual({ error: 'take.blocked.no_reference' });
  });

  it('sin terminal activa no se ofrece cobrar con Mercado Pago', () => {
    expect(Cashier.planCharge({ order: pedido(), terminals: [], a: { method: 'mercadopago_point' } }))
      .toEqual({ error: 'take.blocked.no_terminal' });
  });

  it('un pedido ya pagado no se cobra', () => {
    expect(Cashier.planCharge({ order: pedido({ remaining: '0' }), a: { method: 'cash' } }))
      .toEqual({ error: 'till.errNothingDue' });
  });
});

// ============================================================================
// D86: cobrar en dólares, el cambio en pesos
// ============================================================================

describe('EV2Cashier: cobrar en dólares (D86)', () => {
  const tipo = { id: '7', rate: '17.350000' };
  const pedido = (extra = {}) => ({ transaction_id: 't1', subtotal: '450.00', ...extra });

  it('convierte como Postgres: al centavo, la mitad hacia arriba, sin errores de flotante', () => {
    expect(Cashier.usdToCents(10, '17.35')).toBe(17350);
    // 17.355 × 100 en flotante es 1735.4999…; Postgres redondea a 17.36.
    expect(Cashier.usdToCents(1, '17.355')).toBe(1736);
    expect(Cashier.usdToCents(0, '17.35')).toBeNull();
    expect(Cashier.usdToCents(10, null)).toBeNull();
  });

  it('el cambio sale en pesos, redondeado hacia abajo al peso', () => {
    expect(Cashier.usdQuote(10, '17.35', '120.00'))
      .toEqual({ covers: '173.50', applied: '120.00', change: '53.00', short: null });
    expect(Cashier.usdQuote(5, '17.35', '120.00'))
      .toEqual({ covers: '86.75', applied: '86.75', change: '0.00', short: '33.25' });
    expect(Cashier.usdFor('120.00', '17.35')).toBe('6.92');
  });

  it('un solo pago en dólares: tiene que alcanzar, y manda dólares y tipo de cambio, no pesos', () => {
    const p = pedido({ subtotal: '120.00', remaining: '120.00' });
    expect(Cashier.planCharge({ order: p, a: { method: 'cash_usd', usd: '5' }, usdRate: tipo }))
      .toEqual({ error: 'till.errUsdShort' });
    const r = Cashier.planCharge({ order: p, a: { method: 'cash_usd', usd: '10' }, usdRate: tipo });
    expect(r.steps[0]).toMatchObject({
      method: 'cash_usd', amount: '120.00', change: '53.00', usd_received: '10.00', exchange_rate_id: '7',
    });
    expect(Cashier.paymentPayload(p, r.steps[0], 'k')).toEqual({
      transaction_id: 't1', method: 'cash_usd', usd_received: 10, exchange_rate_id: '7', client_request_id: 'k',
    });
  });

  it('sin tipo de cambio no hay dólares', () => {
    const p = pedido();
    expect(Cashier.planCharge({ order: p, a: { method: 'cash_usd', usd: '100' } }))
      .toEqual({ error: 'till.errNoRate' });
  });

  it('dólares como primera de dos partes: los dólares fijan cuánto paga cada una', () => {
    const p = pedido({ subtotal: '120.00', remaining: '120.00' });
    const r = Cashier.planCharge({
      order: p, split: true, a: { method: 'cash_usd', usd: '5' }, b: { method: 'cash' }, usdRate: tipo,
    });
    expect(r.steps.map((s) => [s.method, s.amount])).toEqual([['cash_usd', '86.75'], ['cash', '33.25']]);
    // Si los dólares ya pagan todo, no se divide.
    expect(Cashier.planCharge({
      order: p, split: true, a: { method: 'cash_usd', usd: '10' }, b: { method: 'cash' }, usdRate: tipo,
    })).toEqual({ error: 'till.errUsdCoversAll' });
  });

  it('dólares como segunda parte: tienen que completar', () => {
    const p = pedido({ subtotal: '120.00', remaining: '120.00' });
    const corto = Cashier.planCharge({
      order: p, split: true, a: { method: 'cash', amount: '20' }, b: { method: 'cash_usd', usd: '5' }, usdRate: tipo,
    });
    expect(corto).toEqual({ error: 'till.errUsdShort' });
    const ok = Cashier.planCharge({
      order: p, split: true, a: { method: 'cash', amount: '20' }, b: { method: 'cash_usd', usd: '10' }, usdRate: tipo,
    });
    expect(ok.steps[1]).toMatchObject({ method: 'cash_usd', amount: '100.00', change: '73.00' });
  });
});
