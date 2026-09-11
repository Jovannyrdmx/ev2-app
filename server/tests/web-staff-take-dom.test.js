/**
 * La pantalla del mesero contra el `web/staff.html` REAL.
 *
 * Lo que se prueba aquí es lo que ninguna prueba de módulo puede ver: que el
 * controlador y el HTML se encuentren. Un `$('take-total')` contra un `id="take_total"`
 * no rompe nada al cargar — revienta de noche, con el cliente enfrente, cuando alguien
 * toca el botón. Y un texto sin traducir aparece como la clave cruda en la pantalla.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..', '..', 'web');
const leer = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const html = leer('staff.html');
const controlador = leer('js/staff-screen.js');
const catalogo = require(path.join(ROOT, 'js', 'format.js'));

const abiertas = [];
afterEach(() => { while (abiertas.length) abiertas.pop().close(); });

function documento() {
  const dom = new JSDOM(html, { url: 'https://ev2.local/staff.html' });
  abiertas.push(dom.window);
  return dom.window.document;
}

/** Todos los `$('algo')` que el controlador busca por id. */
function idsQueBusca(fuente) {
  const ids = new Set();
  const re = /\$\('([a-z0-9-]+)'\)/g;
  let m = re.exec(fuente);
  while (m) { ids.add(m[1]); m = re.exec(fuente); }
  return [...ids];
}

describe('el controlador y el HTML se encuentran', () => {
  it('cada id que busca staff-screen.js existe en staff.html', () => {
    const doc = documento();
    const faltantes = idsQueBusca(controlador).filter((id) => !doc.getElementById(id));
    expect(faltantes).toEqual([]);
  });

  it('la hoja para levantar el pedido existe y arranca cerrada', () => {
    const doc = documento();
    const hoja = doc.getElementById('take-sheet');
    expect(hoja).not.toBeNull();
    expect(hoja.hasAttribute('hidden')).toBe(true);
  });

  it('el bloque de "por cobrar" también arranca cerrado', () => {
    expect(documento().getElementById('unpaid-block').hasAttribute('hidden')).toBe(true);
  });

  it('el campo del folio nace escondido: solo lo pide la terminal', () => {
    expect(documento().getElementById('take-reference').hasAttribute('hidden')).toBe(true);
  });

  it('el botón de levantar nace apagado: todavía no hay nada pedido', () => {
    expect(documento().getElementById('btn-take-send').hasAttribute('disabled')).toBe(true);
  });

  it('carga los módulos que la hoja necesita', () => {
    const doc = documento();
    const srcs = [...doc.querySelectorAll('script')].map((s) => s.getAttribute('src'));
    for (const src of ['js/client.js', 'js/drink-art.js', 'js/order-taking.js']) {
      expect(srcs).toContain(src);
    }
    // Y antes del controlador, o al cargar no existirían todavía.
    expect(srcs.indexOf('js/order-taking.js')).toBeLessThan(srcs.indexOf('js/staff-screen.js'));
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

  it('cada data-i18n de staff.html está en español y en inglés', () => {
    const usadas = [...claves(html, 'data-i18n'), ...claves(html, 'data-i18n-placeholder')];
    for (const lang of ['es', 'en']) {
      catalogo.setLanguage(lang);
      const faltantes = usadas.filter((k) => catalogo.t(k) === k);
      expect({ lang, faltantes }).toEqual({ lang, faltantes: [] });
    }
  });

  it('cada texto que pide el controlador para la hoja existe en los dos idiomas', () => {
    const usadas = new Set();
    const re = /t\('(take\.[a-zA-Z0-9_.]+)'\)/g;
    let m = re.exec(controlador);
    while (m) { usadas.add(m[1]); m = re.exec(controlador); }
    // Las formas de pago se arman con plantilla; se comprueban una por una.
    const Take = require(path.join(ROOT, 'js', 'order-taking.js'));
    for (const key of Take.methodKeys()) usadas.add(`take.method.${key}`);

    expect(usadas.size).toBeGreaterThanOrEqual(8);
    for (const lang of ['es', 'en']) {
      catalogo.setLanguage(lang);
      const faltantes = [...usadas].filter((k) => catalogo.t(k) === k);
      expect({ lang, faltantes }).toEqual({ lang, faltantes: [] });
    }
  });

  it('cada motivo por el que la hoja se bloquea tiene su texto', () => {
    for (const motivo of ['no_table', 'empty_cart', 'no_charge', 'already_paid', 'no_method', 'no_reference']) {
      for (const lang of ['es', 'en']) {
        catalogo.setLanguage(lang);
        expect(catalogo.t(`take.blocked.${motivo}`)).not.toBe(`take.blocked.${motivo}`);
      }
    }
  });
});
