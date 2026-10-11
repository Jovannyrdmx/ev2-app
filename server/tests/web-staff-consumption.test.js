/**
 * Staff consumption (D101), web side: pure maths, markup/script id agreement, i18n keys in
 * both languages, service-worker precache and the manager tab wiring.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const WEB = path.join(__dirname, '..', '..', 'web');
const read = (f) => fs.readFileSync(path.join(WEB, f), 'utf8');
const SO = require(path.join(WEB, 'js', 'staff-order.js'));

describe('staff-order maths', () => {
  const drinks = [
    { id: 'a', name: 'Beta', category: 'Z', price: 60 },
    { id: 'b', name: 'Alfa', category: 'Z', price: 250.5 },
    { id: 'c', name: 'Off', category: 'A', price: 10, available: false },
  ];

  test('staffPrice applies the percentage to the cent', () => {
    expect(SO.staffPrice(60, 40)).toBe(36);
    expect(SO.staffPrice(7000, 40)).toBe(4200);
    expect(SO.staffPrice(250.5, 0)).toBe(250.5);
  });

  test('unavailable items are not orderable and groups are sorted', () => {
    const groups = SO.byCategory(drinks);
    expect(groups.map((g) => g.category)).toEqual(['Z']);
    expect(groups[0].items.map((d) => d.name)).toEqual(['Alfa', 'Beta']);
  });

  test('cart clamps quantity between 0 and 20 and exports only ids and quantities', () => {
    const cart = SO.createCart();
    cart.add('a', 2);
    cart.set('b', 99);
    expect(cart.quantity('b')).toBe(20);
    cart.set('a', 0);
    expect(cart.items()).toEqual([{ drink_id: 'b', quantity: 20 }]);
    expect(cart.count()).toBe(20);
    cart.clear();
    expect(cart.isEmpty()).toBe(true);
  });

  test('totals are exact in cents', () => {
    const cart = SO.createCart();
    cart.set('a', 2);
    cart.set('b', 1);
    expect(SO.totals(cart, drinks, 40)).toEqual({ list: 370.5, deduct: 222.3 });
  });
});

describe('consumo.html ↔ consumo-screen.js', () => {
  const html = read('consumo.html');
  const js = read('js/consumo-screen.js');
  const used = [...js.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]);

  test('every id the script reads exists in the page', () => {
    for (const id of new Set(used)) expect(html).toContain(`id="${id}"`);
  });

  test('page loads its scripts', () => {
    expect(html).toContain('js/staff-order.js');
    expect(html).toContain('js/consumo-screen.js');
  });

  test('the client never sends a price', () => {
    expect(js).not.toMatch(/price\s*:/);
  });
});

describe('i18n', () => {
  const keys = new Set();
  for (const f of ['js/manager-screen.js', 'js/consumo-screen.js']) {
    for (const m of read(f).matchAll(/\bt[f]?\('((?:scn|soc)\.[A-Za-z.]+)'/g)) keys.add(m[1]);
  }
  test('used keys exist in es and en', () => {
    const { STRINGS } = require(path.join(WEB, 'js', 'format.js'));
    for (const k of keys) {
      expect(`${k}:es:${STRINGS.es[k] ? 'ok' : 'missing'}`).toBe(`${k}:es:ok`);
      expect(`${k}:en:${STRINGS.en[k] ? 'ok' : 'missing'}`).toBe(`${k}:en:ok`);
    }
    expect(keys.size).toBeGreaterThan(0);
  });
});

describe('manager tab and PWA', () => {
  test('manager has the nav button and panel, and the script wires them', () => {
    const html = read('manager.html');
    const js = read('js/manager-screen.js');
    expect(html).toContain('data-tab="staffcons"');
    expect(html).toContain('id="tab-staffcons"');
    expect(js).toMatch(/staffcons: \['tab-staffcons'\]/);
    expect(js).toMatch(/staffcons: \(\) => loadStaffCons\(\)/);
  });

  test('service worker precaches the new files', () => {
    const sw = read('sw.js');
    for (const f of ['consumo.html', 'js/consumo-screen.js', 'js/staff-order.js']) expect(sw).toContain(`'${f}'`);
  });

  test('bartender queue labels staff orders', () => {
    expect(read('js/bartender-screen.js')).toMatch(/staff|bar\.staffOrder/);
  });
});
