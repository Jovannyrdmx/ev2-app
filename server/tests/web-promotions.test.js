/**
 * Promociones por evento (D102), lado web: las cuentas de oferta, el total del carrito
 * (que debe cuadrar con el servidor), el panel del gerente y la cascara de la PWA.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const WEB = path.join(__dirname, '..', '..', 'web');
const read = (f) => fs.readFileSync(path.join(WEB, f), 'utf8');
const P = require(path.join(WEB, 'js', 'promotions.js'));
const Client = require(path.join(WEB, 'js', 'client.js'));
const Take = require(path.join(WEB, 'js', 'order-taking.js'));
const SO = require(path.join(WEB, 'js', 'staff-order.js'));

const beer = {
  id: 'b', name: 'Cerveza', price: 60, currency: 'MXN', stock: null,
  promo: { kind: 'n_for_m', badge: '2x1', buy_qty: 2, pay_qty: 1, unit_price: null },
};
const gin = {
  id: 'g', name: 'Gin', price: 200, currency: 'MXN', stock: null,
  promo: { kind: 'percent', badge: '-25%', unit_price: 150, starts_time: '22:00:00', ends_time: '00:30:00' },
};
const agua = { id: 'a', name: 'Agua', price: 20, currency: 'MXN', stock: null, promo: null };

describe('cuentas de oferta', () => {
  test('lineCents: 2x1, precio de oferta y sin promocion', () => {
    expect(P.lineCents(beer, 3)).toBe(12000);
    expect(P.lineCents(beer, 1)).toBe(6000);
    expect(P.lineCents(gin, 2)).toBe(30000);
    expect(P.lineCents(agua, 3)).toBe(6000);
  });

  test('etiqueta, precio por pieza y horario', () => {
    expect(P.badge(beer)).toBe('2x1');
    expect(P.badge(agua)).toBe('');
    expect(P.unitPrice(beer)).toBeNull();
    expect(P.unitPrice(gin)).toBe(150);
    expect(P.window(gin)).toBe('22:00–00:30');
    expect(P.window(beer)).toBe('');
  });

  test('priceHtml tacha el precio de carta solo con precio por pieza y escapa', () => {
    const fmt = (a) => `$${a}`;
    const esc = (s) => String(s).replace(/</g, '&lt;');
    expect(P.priceHtml(gin, fmt, esc)).toContain('line-through');
    expect(P.priceHtml(gin, fmt, esc)).toContain('$150');
    expect(P.priceHtml(beer, fmt, esc)).not.toContain('line-through');
    expect(P.priceHtml(beer, fmt, esc)).toContain('2x1');
    expect(P.priceHtml(agua, fmt, esc)).toBe('$20');
  });
});

describe('el carrito cuadra con el servidor', () => {
  test('el total del cliente usa la promocion', () => {
    const cart = Client.createCart();
    cart.add(beer, 1);
    cart.add(beer, 1);
    cart.add(agua, 1);
    expect(cart.total).toBe('80.00');
    expect(cart.lines.find((l) => l.drink.id === 'b').subtotal).toBe('60.00');
  });

  test('priceDrift no avisa de una diferencia falsa con promocion', () => {
    const lines = [{ drink: beer, quantity: 2 }];
    expect(Take.totalCents(lines)).toBe(6000);
    expect(Take.priceDrift(lines, { subtotal: '60.00' })).toBe(0);
  });

  test('personal: paga el menor entre la promocion y su descuento', () => {
    const cart = SO.createCart();
    cart.set('b', 2); // 2x1 = 60 contra 40% de 120 = 72 -> 60
    expect(SO.totals(cart, [beer], 40)).toEqual({ list: 120, deduct: 60 });
    const c2 = SO.createCart();
    c2.set('g', 1); // oferta 150 contra 40% de 200 = 120 -> 120
    expect(SO.totals(c2, [gin], 40)).toEqual({ list: 200, deduct: 120 });
    expect(SO.promoUnit(gin, 40)).toBeNull();
    expect(SO.promoUnit(gin, 10)).toBe(150);
  });
});

describe('formulario del gerente', () => {
  const base = { name: '2x1', kind: 'n_for_m', buy: '2', pay: '1', targetKind: 'drink', drinkId: 'x' };

  test('arma el cuerpo de cada tipo', () => {
    expect(P.payload(base).body).toEqual({ name: '2x1', kind: 'n_for_m', drink_id: 'x', buy_qty: 2, pay_qty: 1 });
    expect(P.payload({ ...base, kind: 'percent', pct: '20,5', targetKind: 'category', category: 'beer' }).body)
      .toEqual({ name: '2x1', kind: 'percent', category: 'beer', value: 20.5 });
    expect(P.payload({ ...base, kind: 'fixed_price', price: '45', from: '22:00', to: '01:00' }).body)
      .toMatchObject({ value: 45, starts_time: '22:00', ends_time: '01:00' });
  });

  test('dice cual campo esta mal', () => {
    expect(P.payload({ ...base, name: ' ' }).error).toBe('name');
    expect(P.payload({ ...base, drinkId: '' }).error).toBe('target');
    expect(P.payload({ ...base, pay: '2' }).error).toBe('pay');
    expect(P.payload({ ...base, buy: '1' }).error).toBe('buy');
    expect(P.payload({ ...base, kind: 'percent', pct: '0' }).error).toBe('value');
    expect(P.payload({ ...base, kind: 'percent', pct: '101' }).error).toBe('value');
    expect(P.payload({ ...base, kind: 'fixed_price', price: '' }).error).toBe('value');
    expect(P.payload({ ...base, from: '22:00' }).error).toBe('window');
    expect(P.payload({ ...base, from: '22:00', to: '22:00' }).error).toBe('window');
  });
});

describe('panel, textos y PWA', () => {
  const html = read('manager.html');
  const js = read('js/manager-screen.js');
  const { STRINGS } = require(path.join(WEB, 'js', 'format.js'));

  test('cada id que usa el panel existe en la pagina', () => {
    const start = js.indexOf('function renderPromos()');
    const body = js.slice(start, js.indexOf('const TAB_LOADERS', start));
    for (const id of new Set([...body.matchAll(/\$\('(prm-[a-z-]+|btn-prm-[a-z]+)'\)/g)].map((m) => m[1]))) {
      expect(html).toContain(`id="${id}"`);
    }
    expect(html).toContain('data-tab="promos"');
    expect(js).toMatch(/promos: \['tab-promos'\]/);
    expect(js).toMatch(/promos: \(\) => loadPromos\(\)/);
  });

  test('los textos existen en es y en', () => {
    const keys = new Set();
    for (const m of js.matchAll(/\bt\(['`](prm\.[A-Za-z.${}]+)['`]/g)) keys.add(m[1]);
    for (const k of ['prm.bad.name', 'prm.bad.value', 'prm.bad.buy', 'prm.bad.pay', 'prm.bad.target',
      'prm.bad.window', 'prm.off', 'prm.on', 'prm.d.n', 'prm.d.percent', 'prm.d.fixed']) keys.add(k);
    for (const m of html.matchAll(/data-i18n(?:-placeholder)?="(prm\.[^"]+)"/g)) keys.add(m[1]);
    for (const k of keys) {
      if (k.includes('$')) continue;
      expect(`${k}:es:${STRINGS.es[k] ? 'ok' : 'missing'}`).toBe(`${k}:es:ok`);
      expect(`${k}:en:${STRINGS.en[k] ? 'ok' : 'missing'}`).toBe(`${k}:en:ok`);
    }
  });

  test('las paginas cargan promotions.js antes que quien lo usa, y la PWA lo guarda', () => {
    for (const [page, user] of [['index.html', 'client.js'], ['staff.html', 'client.js'],
      ['caja.html', 'client.js'], ['consumo.html', 'staff-order.js'], ['manager.html', 'manager.js']]) {
      const h = read(page);
      expect(h).toContain('js/promotions.js');
      expect(h.indexOf('js/promotions.js')).toBeLessThan(h.indexOf(`js/${user}`));
    }
    expect(read('sw.js')).toContain("'js/promotions.js'");
  });
});

describe('trago especial y piezas esperadas en el formulario (D114)', () => {
  const base = { name: 'X', targetKind: 'drink', drinkId: 'd1' };
  it('el especial no lleva precio y solo va en una bebida', () => {
    expect(P.payload({ ...base, kind: 'special', price: '50' })).toEqual({ body: { name: 'X', kind: 'special', drink_id: 'd1' } });
    expect(P.payload({ ...base, kind: 'special', targetKind: 'category', category: 'Tequila' })).toEqual({ error: 'special' });
  });
  it('las piezas esperadas son enteras y solo de una bebida', () => {
    expect(P.payload({ ...base, kind: 'percent', pct: '10', expected: ' 30 ' }).body.expected_units).toBe(30);
    expect(P.payload({ ...base, kind: 'percent', pct: '10', expected: '' }).body.expected_units).toBeUndefined();
    for (const bad of ['0', '2.5', 'diez']) {
      expect(P.payload({ ...base, kind: 'percent', pct: '10', expected: bad })).toEqual({ error: 'expected' });
    }
    expect(P.payload({ name: 'X', kind: 'percent', pct: '10', targetKind: 'category', category: 'Tequila', expected: '5' }))
      .toEqual({ error: 'expectedCategory' });
  });
});
