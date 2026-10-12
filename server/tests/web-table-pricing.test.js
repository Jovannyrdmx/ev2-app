/**
 * Precio y personas por mesa VIP (D103), lado web: agrupar por zona, lo que verá el
 * cliente, qué se manda al guardar, y que la pestaña esté bien cableada.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const WEB = path.join(__dirname, '..', '..', 'web');
const read = (f) => fs.readFileSync(path.join(WEB, f), 'utf8');
const TP = require(path.join(WEB, 'js', 'table-pricing.js'));

const zones = [
  { section: 'ZONA AZUL', base_price: '4500.00', included_tickets: 10, reservable: true },
  { section: 'DIAMANTE SUITE', base_price: '5000.00', included_tickets: 6, reservable: true },
  { section: 'GENERAL', base_price: '0.00', included_tickets: 4, reservable: false },
];
const tables = [
  { id: 't39', code: '39', table_number: 39, section: 'DIAMANTE SUITE', vip_price: '8000.00', vip_capacity: 8 },
  { id: 't38', code: '38', table_number: 38, section: 'DIAMANTE SUITE', vip_price: null, vip_capacity: null },
  { id: 't10', code: '10', table_number: 10, section: 'ZONA AZUL', vip_price: null, vip_capacity: null },
  { id: 'g1', code: '1', table_number: 1, section: 'GENERAL', vip_price: null, vip_capacity: null },
  { id: 'x', code: 'X', table_number: 5, section: 'SIN ZONA', vip_price: null, vip_capacity: null },
];

describe('groupByZone', () => {
  test('sigue el orden de las zonas, ordena por número y deja fuera lo que no se reserva', () => {
    const g = TP.groupByZone(tables, zones);
    expect(g.map((x) => x.section)).toEqual(['ZONA AZUL', 'DIAMANTE SUITE']);
    expect(g[1].tables.map((t) => t.id)).toEqual(['t38', 't39']);
  });
});

describe('effective', () => {
  test('la mesa manda; vacío usa la zona; 0 es un precio', () => {
    expect(TP.effective(tables[0], zones[1]))
      .toEqual({ price: 8000, people: 8, priceFromTable: true, peopleFromTable: true });
    expect(TP.effective(tables[1], zones[1]))
      .toEqual({ price: 5000, people: 6, priceFromTable: false, peopleFromTable: false });
    expect(TP.effective({ vip_price: '0.00', vip_capacity: null }, zones[0]).price).toBe(0);
  });
});

describe('parseField', () => {
  test('vacío es null; acepta coma decimal; rechaza lo inválido', () => {
    expect(TP.parseField('price', '')).toEqual({ value: null });
    expect(TP.parseField('price', ' 5000,50 ')).toEqual({ value: 5000.5 });
    expect(TP.parseField('price', '0')).toEqual({ value: 0 });
    expect(TP.parseField('price', '-1')).toEqual({ error: 'price' });
    expect(TP.parseField('price', 'abc')).toEqual({ error: 'price' });
    expect(TP.parseField('people', '8')).toEqual({ value: 8 });
    expect(TP.parseField('people', '0')).toEqual({ error: 'people' });
    expect(TP.parseField('people', '2.5')).toEqual({ error: 'people' });
    expect(TP.parseField('people', '51')).toEqual({ error: 'people' });
  });
});

describe('diff', () => {
  test('solo manda las mesas que cambiaron', () => {
    const edits = new Map([
      ['t38', { price: '5000', people: '6' }],
      ['t39', { price: '8000', people: '8' }], // igual a lo guardado
      ['t10', { price: '', people: '' }], // igual a lo guardado (vacío)
    ]);
    expect(TP.diff(tables, edits)).toEqual({
      changes: [{ id: 't38', vip_price: 5000, vip_capacity: 6 }], errors: [],
    });
  });

  test('vaciar los campos manda null para volver a la zona', () => {
    const r = TP.diff(tables, new Map([['t39', { price: '', people: '' }]]));
    expect(r.changes).toEqual([{ id: 't39', vip_price: null, vip_capacity: null }]);
  });

  test('un campo inválido da error y señala cuál', () => {
    const r = TP.diff(tables, new Map([['t38', { price: 'x', people: '6' }], ['t10', { price: '5', people: '0' }]]));
    expect(r.errors).toEqual([{ id: 't38', field: 'price' }, { id: 't10', field: 'people' }]);
    expect(r.changes).toEqual([]);
  });
});

describe('pestaña y textos', () => {
  const html = read('manager.html');
  const js = read('js/manager-screen.js');
  const { STRINGS } = require(path.join(WEB, 'js', 'format.js'));

  test('cada id que usa la pantalla existe y la pestaña está conectada', () => {
    const start = js.indexOf('function renderTablePrices()');
    const body = js.slice(start - 3000, js.indexOf('// ---------------------------------------------------------------- promociones'));
    for (const id of new Set([...body.matchAll(/\$\('((?:tpr-|btn-tpr-)[a-z-]+)'\)/g)].map((m) => m[1]))) {
      expect(html).toContain(`id="${id}"`);
    }
    expect(html).toContain('data-tab="tableprice"');
    expect(html).toContain('id="tab-tableprice"');
    expect(js).toMatch(/tableprice: \['tab-tableprice'\]/);
    expect(js).toMatch(/tableprice: \(\) => loadTablePrices\(\)/);
    expect(js).toContain('/tables/vip-pricing');
  });

  test('los textos existen en es y en', () => {
    const keys = new Set();
    for (const m of js.matchAll(/\bt\(['`](tpr\.[A-Za-z.]+)['`]/g)) keys.add(m[1]);
    for (const m of js.matchAll(/t\(`(tpr\.bad)\.\$\{/g)) { keys.add('tpr.bad.price'); keys.add('tpr.bad.people'); void m; }
    for (const m of html.matchAll(/data-i18n="(tpr\.[^"]+)"/g)) keys.add(m[1]);
    expect(keys.size).toBeGreaterThan(8);
    for (const k of keys) {
      expect(`${k}:es:${STRINGS.es[k] ? 'ok' : 'missing'}`).toBe(`${k}:es:ok`);
      expect(`${k}:en:${STRINGS.en[k] ? 'ok' : 'missing'}`).toBe(`${k}:en:ok`);
    }
  });

  test('la PWA guarda el módulo y la página lo carga antes del panel', () => {
    expect(read('sw.js')).toContain("'js/table-pricing.js'");
    expect(html.indexOf('js/table-pricing.js')).toBeGreaterThan(-1);
    expect(html.indexOf('js/table-pricing.js')).toBeLessThan(html.indexOf('js/manager.js'));
  });
});
