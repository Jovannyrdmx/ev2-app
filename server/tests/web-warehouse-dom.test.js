/**
 * La pantalla de almacén contra el `web/almacen.html` REAL.
 *
 * Lo que se prueba aquí es lo que ninguna prueba de módulo ve: que el controlador y el
 * HTML se encuentren. Un `$('sheet-amount')` contra un `id="sheet_amount"` no rompe
 * nada al cargar — revienta cuando el almacenista ya capturó treinta renglones. Y un
 * texto sin traducir aparece como la clave cruda en la pantalla.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..', '..', 'web');
const leer = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const html = leer('almacen.html');
const controlador = leer('js/warehouse-screen.js');
const catalogo = require(path.join(ROOT, 'js', 'format.js'));
const wh = require(path.join(ROOT, 'js', 'warehouse.js'));

const abiertas = [];
afterEach(() => { while (abiertas.length) abiertas.pop().close(); });

function documento() {
  const dom = new JSDOM(html, { url: 'https://ev2.local/almacen.html' });
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

describe('el controlador y el HTML se encuentran', () => {
  it('cada id que busca warehouse-screen.js existe en almacen.html', () => {
    const doc = documento();
    const faltantes = idsQueBusca(controlador).filter((id) => !doc.getElementById(id));
    expect(faltantes).toEqual([]);
  });

  it('la hoja de captura nace cerrada, con su fondo', () => {
    const doc = documento();
    expect(doc.getElementById('sheet').hasAttribute('hidden')).toBe(true);
    expect(doc.getElementById('sheet-backdrop').hasAttribute('hidden')).toBe(true);
  });

  it('el destino y el costo nacen escondidos: solo los pide el movimiento que los usa', () => {
    const doc = documento();
    expect(doc.getElementById('sheet-to-wrap').hasAttribute('hidden')).toBe(true);
    expect(doc.getElementById('sheet-cost-wrap').hasAttribute('hidden')).toBe(true);
  });

  it('la pantalla de almacén arranca escondida: primero se entra', () => {
    const doc = documento();
    expect(doc.getElementById('screen-warehouse').hasAttribute('hidden')).toBe(true);
    expect(doc.getElementById('screen-auth').hasAttribute('hidden')).toBe(false);
  });

  it('están las tres pestañas y la de existencias es la que abre', () => {
    const doc = documento();
    const tabs = [...doc.querySelectorAll('[data-tab]')].map((t) => t.dataset.tab);
    expect(tabs).toEqual(['stock', 'restock', 'kardex']);
    expect(doc.querySelector('.tab.active').dataset.tab).toBe('stock');
  });

  it('carga los módulos que necesita, y el de decisiones antes del controlador', () => {
    const doc = documento();
    const srcs = [...doc.querySelectorAll('script')].map((s) => s.getAttribute('src'));
    for (const src of ['js/api.js', 'js/format.js', 'js/roles.js', 'js/warehouse.js',
      'js/warehouse-screen.js']) {
      expect(srcs).toContain(src);
    }
    expect(srcs.indexOf('js/warehouse.js')).toBeLessThan(srcs.indexOf('js/warehouse-screen.js'));
  });

  it('no trae ningún número escrito a mano en el HTML', () => {
    // Un saldo pintado en el HTML es un dato inventado esperando a que alguien lo
    // crea. Los contadores arrancan en raya o en cero y los llena la API.
    const doc = documento();
    for (const id of ['stat-low', 'stat-value', 'stat-unconfirmed']) {
      expect(doc.getElementById(id).textContent.trim()).toBe('—');
    }
    expect(doc.getElementById('list').textContent.trim()).toBe('');
  });
});

describe('nada sale sin traducir', () => {
  const claves = (fuente, attr) => {
    const out = new Set();
    const re = new RegExp(`${attr}="([^"]+)"`, 'g');
    let m = re.exec(fuente);
    while (m) { out.add(m[1]); m = re.exec(fuente); }
    return [...out];
  };

  it('cada data-i18n de almacen.html está en español y en inglés', () => {
    const usadas = [...claves(html, 'data-i18n'), ...claves(html, 'data-i18n-placeholder'),
      ...claves(html, 'data-i18n-title')];
    expect(usadas.length).toBeGreaterThan(15);
    for (const lang of ['es', 'en']) {
      catalogo.setLanguage(lang);
      const faltantes = usadas.filter((k) => catalogo.t(k) === k);
      expect({ lang, faltantes }).toEqual({ lang, faltantes: [] });
    }
  });

  it('cada texto que pide el controlador existe en los dos idiomas', () => {
    const usadas = new Set();
    const re = /t\('(wh\.[a-zA-Z0-9_.]+)'/g;
    let m = re.exec(controlador);
    while (m) { usadas.add(m[1]); m = re.exec(controlador); }
    expect(usadas.size).toBeGreaterThanOrEqual(15);
    for (const lang of ['es', 'en']) {
      catalogo.setLanguage(lang);
      const faltantes = [...usadas].filter((k) => catalogo.t(k) === k);
      expect({ lang, faltantes }).toEqual({ lang, faltantes: [] });
    }
  });

  it('cada tipo de movimiento tiene nombre en los dos idiomas', () => {
    // Incluye los que NO se capturan a mano (venta, devolución, los dos lados de un
    // traspaso): el kardex los enseña igual, y sin texto saldría `wh.kind.consumption`.
    const kinds = wh.movementKeys().concat(['consumption', 'return', 'transfer_in', 'transfer_out']);
    for (const lang of ['es', 'en']) {
      catalogo.setLanguage(lang);
      const faltantes = kinds.filter((k) => catalogo.t(`wh.kind.${k}`) === `wh.kind.${k}`);
      expect({ lang, faltantes }).toEqual({ lang, faltantes: [] });
    }
  });

  it('cada problema de validación tiene su explicación', () => {
    const codes = ['required', 'zero', 'negative', 'same_place', 'not_enough', 'unknown_movement'];
    for (const lang of ['es', 'en']) {
      catalogo.setLanguage(lang);
      const faltantes = codes.filter((c) => catalogo.t(`wh.err.${c}`) === `wh.err.${c}`);
      expect({ lang, faltantes }).toEqual({ lang, faltantes: [] });
    }
  });
});

describe('el almacén tiene su propia puerta', () => {
  it('el rol de almacén manda a almacen.html', () => {
    const roles = require(path.join(ROOT, 'js', 'roles.js'));
    const info = roles.describe('warehouse', 'es');
    expect(info.home).toBe('almacen.html');
    expect(info.ready).toBe(true);
  });

  it('la pantalla queda precargada para poder trabajar con mala señal', () => {
    const sw = leer('sw.js');
    expect(sw).toContain('almacen.html');
    expect(sw).toContain('js/warehouse.js');
    expect(sw).toContain('js/warehouse-screen.js');
  });
});
