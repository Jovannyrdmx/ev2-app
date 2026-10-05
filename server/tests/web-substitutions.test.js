/**
 * Sustituir un insumo (D84): las decisiones de `web/js/substitutions.js`.
 */
'use strict';

const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..', '..', 'web');
const S = require(path.join(ROOT, 'js', 'substitutions.js'));
const catalogo = require(path.join(ROOT, 'js', 'format.js'));

describe('Qué sustitutos se ofrecen', () => {
  const buch = { id: 'a', name: "Buchanan's", unit: 'ml', stock: 0 };
  const ops = [
    buch,
    { id: 'b', name: 'Black Label', unit: 'ml', stock: 750 },
    { id: 'c', name: 'Lata', unit: 'pza', stock: 10 },
    { id: 'd', name: 'Chivas', unit: 'ml', stock: 0 },
  ];
  it('misma unidad, otro insumo, con existencia', () => {
    expect(S.candidatesFor(buch, ops).map((x) => x.id)).toEqual(['b']);
  });
  it('sin insumo escogido, nada', () => {
    expect(S.candidatesFor(null, ops)).toEqual([]);
  });
});

describe('Qué falta para mandar', () => {
  it('barra, insumo, sustituto y que no sean el mismo', () => {
    expect(S.blocker({})).toBe('sub.errBar');
    expect(S.blocker({ barId: 'x' })).toBe('sub.errSupply');
    expect(S.blocker({ barId: 'x', supplyId: 'a' })).toBe('sub.errSubstitute');
    expect(S.blocker({ barId: 'x', supplyId: 'a', substituteId: 'a' })).toBe('sub.errSame');
    expect(S.blocker({ barId: 'x', supplyId: 'a', substituteId: 'b' })).toBeNull();
  });
});

describe('Pantallas', () => {
  const leer = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
  it('el bartender y el gerente cargan el módulo antes de su controlador', () => {
    for (const [html, ctl] of [['bartender.html', 'js/bartender-screen.js'], ['manager.html', 'js/manager-screen.js']]) {
      const src = leer(html);
      expect(src.indexOf('js/substitutions.js')).toBeGreaterThan(-1);
      expect(src.indexOf('js/substitutions.js')).toBeLessThan(src.indexOf(ctl));
    }
  });
  it('cada texto existe en los dos idiomas', () => {
    const fuente = leer('js/substitutions.js') + leer('js/bartender-screen.js');
    const claves = new Set([...fuente.matchAll(/t\('(sub\.[a-zA-Z]+)'/g)].map((m) => m[1]));
    for (const k of ['sub.errBar', 'sub.errSupply', 'sub.errSubstitute', 'sub.errSame', 'sub.open', 'sub.title', 'sub.subtitle']) claves.add(k);
    expect(claves.size).toBeGreaterThan(10);
    for (const lang of ['es', 'en']) {
      catalogo.setLanguage(lang);
      const faltan = [...claves].filter((k) => catalogo.t(k) === k);
      expect({ lang, faltan }).toEqual({ lang, faltan: [] });
    }
  });
});
