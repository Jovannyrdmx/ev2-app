/**
 * La pantalla de objetos perdidos, del lado del cliente (D67).
 *
 * Lo que se vigila aquí es lo mismo que en el servidor, visto desde el otro lado: que
 * la pantalla no tenga forma de enseñar las señas de un objeto ajeno, que los
 * identificadores que busca existan, y que cada texto tenga sus dos idiomas — un aviso
 * sin traducir sale como la clave cruda (`lf.errDetails`) en la cara del cliente.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const WEB = path.join(__dirname, '..', '..', 'web');
const catalogo = require(path.join(WEB, 'js', 'format.js'));
const lf = require('../src/services/lost-found');

const html = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8');
const modulo = fs.readFileSync(path.join(WEB, 'js', 'lost-found-screen.js'), 'utf8');

describe('La pantalla existe y está enganchada', () => {
  let dom;
  beforeAll(() => { dom = new JSDOM(html); });
  afterAll(() => dom.window.close());

  it('cada identificador que busca el módulo existe en index.html', () => {
    const ids = new Set();
    for (const m of modulo.matchAll(/\$\('([a-z0-9-]+)'\)/gi)) ids.add(m[1]);
    const faltan = [...ids].filter((id) => !dom.window.document.getElementById(id));
    expect(faltan).toEqual([]);
    expect(ids.size).toBeGreaterThan(8);
  });

  it('el panel nace cerrado: se abre cuando alguien lo pide', () => {
    // Es una función que se usa una vez cada muchas noches. Abierta de entrada, ocupa
    // media pantalla de perfil para nada.
    expect(dom.window.document.getElementById('lf-panel').hasAttribute('hidden')).toBe(true);
  });

  it('el módulo se carga DESPUÉS de index-screen, que es quien publica EV2Screen', () => {
    // Al revés, `window.EV2Screen` no existiría todavía y el módulo se saldría sin
    // engancharse: la sección se vería y ningún botón haría nada.
    const orden = [...html.matchAll(/<script src="js\/([a-z0-9-]+)\.js"><\/script>/g)]
      .map((m) => m[1]);
    expect(orden.indexOf('lost-found-screen')).toBeGreaterThan(orden.indexOf('index-screen'));
  });

  it('el service worker lo guarda: sin señal la sección no se queda sin código', () => {
    const sw = fs.readFileSync(path.join(WEB, 'sw.js'), 'utf8');
    expect(sw).toContain('js/lost-found-screen.js');
  });
});

describe('La pantalla no tiene forma de enseñar señas ajenas', () => {
  it('el módulo nunca lee `details` del catálogo de encontrados', () => {
    // El servidor ya no las manda. Esta prueba vigila el otro extremo: que nadie
    // "arregle" la pantalla leyendo un campo que algún día vuelva a viajar.
    const catalogo1 = modulo.slice(modulo.indexOf('function renderFound'),
      modulo.indexOf('function renderMine'));
    expect(catalogo1).not.toMatch(/\.details/);
    expect(catalogo1).not.toMatch(/storage_note/);
  });

  it('en SUS reportes sí las enseña: son suyas', () => {
    // La regla no es "esconder todo": es que cada quien vea lo suyo.
    const mios = modulo.slice(modulo.indexOf('function renderMine'));
    expect(mios).toMatch(/handover_code/);
  });
});

describe('Los textos', () => {
  // Todas las claves `lf.*` del módulo, vengan pegadas a `t(` o dentro de un ternario.
  // La primera versión solo veía las primeras y daba por buenas las otras sin mirarlas.
  const claves = [...new Set(
    [...modulo.matchAll(/'(lf\.[a-zA-Z.]+)'/g)].map((m) => m[1]),
  )];

  it('el módulo usa claves, no texto duro', () => {
    expect(claves.length).toBeGreaterThan(10);
  });

  it('cada clave existe en español y en inglés', () => {
    const faltan = [];
    for (const k of claves) {
      // Las de categoría y estado se arman con una variable; se comprueban aparte.
      if (k.endsWith('.')) continue;
      for (const lang of ['es', 'en']) {
        // Se leen las DOS tablas. `t(clave, respaldo)` no recibe idioma: su segundo
        // parametro es el respaldo, asi que pasarselo comprobaba el espanol dos veces
        // y habria dado por buena una pantalla sin traducir.
        if (catalogo.STRINGS[lang][k] === undefined) faltan.push(`${k} (${lang})`);
      }
    }
    expect(faltan).toEqual([]);
  });

  it('cada categoría del servidor tiene nombre en los dos idiomas', () => {
    // Si el servidor agrega una categoría y nadie le pone texto, el cliente ve
    // `lf.cat.umbrella` en el menú.
    const faltan = [];
    for (const c of lf.CATEGORIES) {
      for (const lang of ['es', 'en']) {
        if (catalogo.STRINGS[lang][`lf.cat.${c}`] === undefined) faltan.push(`${c} (${lang})`);
      }
    }
    expect(faltan).toEqual([]);
  });

  it('cada estado tiene nombre en los dos idiomas', () => {
    for (const estado of ['open', 'matched', 'returned', 'closed']) {
      for (const lang of ['es', 'en']) {
        expect(catalogo.STRINGS[lang][`lf.status.${estado}`]).toBeDefined();
      }
    }
  });
});
