/**
 * Borrar la cuenta y las páginas legales, del lado del navegador (D68).
 *
 * ---------------------------------------------------------------------------
 * Lo que se vigila aquí
 * ---------------------------------------------------------------------------
 * 1. Que el panel exista, esté enganchado y nazca cerrado.
 * 2. Que los textos tengan sus DOS idiomas de verdad. Esto merece una nota: la prueba
 *    equivalente de D67 comprobaba los idiomas con `t(clave, vars, idioma)`, y `t` no
 *    recibe idioma —su segundo parámetro es el respaldo— así que estaba comprobando el
 *    español dos veces y habría dado por buena una pantalla sin traducir. Aquí se leen
 *    las dos tablas de `STRINGS` directamente.
 * 3. Que el aviso de privacidad y los términos existan como páginas públicas, con el
 *    ancla que está dada de alta en el panel de Meta y sin nada que exija sesión. Si
 *    una de las dos se rompe, Meta reprueba la revisión y el botón de Facebook se cae
 *    para todo el mundo.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const WEB = path.join(__dirname, '..', '..', 'web');
const catalogo = require(path.join(WEB, 'js', 'format.js'));
const del = require('../src/services/account-deletion');

const html = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8');
const modulo = fs.readFileSync(path.join(WEB, 'js', 'account-delete.js'), 'utf8');
const privacidad = fs.readFileSync(path.join(WEB, 'privacidad.html'), 'utf8');
const terminos = fs.readFileSync(path.join(WEB, 'terminos.html'), 'utf8');

describe('El panel de borrado', () => {
  let dom;
  beforeAll(() => { dom = new JSDOM(html); });
  afterAll(() => dom.window.close());

  it('cada identificador que busca el módulo existe en index.html', () => {
    const ids = new Set();
    for (const m of modulo.matchAll(/\$\('([a-z0-9-]+)'\)/gi)) ids.add(m[1]);
    const faltan = [...ids].filter((id) => !dom.window.document.getElementById(id));
    expect(faltan).toEqual([]);
    expect(ids.size).toBeGreaterThan(4);
  });

  it('nace cerrado: nadie llega aquí por accidente', () => {
    expect(dom.window.document.getElementById('del-panel').hasAttribute('hidden')).toBe(true);
  });

  it('el campo de confirmación nace oculto: primero se pregunta qué lo impide', () => {
    // Enseñar el campo antes de saber si el coche está en el valet convierte un aviso
    // útil en un error después de teclear.
    expect(dom.window.document.getElementById('del-form').hasAttribute('hidden')).toBe(true);
  });

  it('el módulo se carga DESPUÉS de index-screen, que es quien publica EV2Screen', () => {
    const orden = [...html.matchAll(/<script src="js\/([a-z0-9-]+)\.js"><\/script>/g)]
      .map((m) => m[1]);
    expect(orden.indexOf('account-delete')).toBeGreaterThan(orden.indexOf('index-screen'));
  });

  it('el service worker lo guarda, y guarda las dos páginas legales', () => {
    const sw = fs.readFileSync(path.join(WEB, 'sw.js'), 'utf8');
    expect(sw).toContain('js/account-delete.js');
    expect(sw).toContain('privacidad.html');
    expect(sw).toContain('terminos.html');
  });

  it('no hay confirm() del navegador: esto no se acepta de un toque', () => {
    // Se mira el CÓDIGO, sin comentarios: este archivo explica en su cabecera por qué
    // no usa `confirm()`, y esa frase no es una llamada. `$('del-confirm')` tampoco.
    const codigo = modulo.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(codigo).not.toMatch(/(?<![\w.$'-])confirm\s*\(/);
  });
});

describe('Los textos, en los dos idiomas de verdad', () => {
  // Las del módulo y las que el HTML pide con `data-i18n`: el panel se arma entre los
  // dos y una clave sin traducir en cualquiera de ellos sale igual de cruda en pantalla.
  const claves = [...new Set([
    ...[...modulo.matchAll(/'(del\.[a-zA-Z_.]+)'/g)].map((m) => m[1]),
    ...[...html.matchAll(/data-i18n="(del\.[a-zA-Z_.]+)"/g)].map((m) => m[1]),
  ])].filter((k) => !k.endsWith('.'));

  it('el módulo y el HTML usan claves, no texto duro', () => {
    expect(claves.length).toBeGreaterThan(6);
  });

  it('cada clave existe en español Y en inglés', () => {
    const faltan = [];
    for (const k of claves) {
      for (const lang of ['es', 'en']) {
        if (catalogo.STRINGS[lang][k] === undefined) faltan.push(`${k} (${lang})`);
      }
    }
    expect(faltan).toEqual([]);
  });

  it('el español y el inglés no son el mismo texto copiado', () => {
    // Una traducción olvidada se ve igual que una hecha, salvo por esto.
    const iguales = claves.filter((k) => catalogo.STRINGS.es[k] === catalogo.STRINGS.en[k]);
    expect(iguales).toEqual([]);
  });

  it('cada motivo del servidor tiene su texto en los dos idiomas', () => {
    // Si alguien agrega un motivo en el servicio y no le pone texto, el cliente leería
    // el mensaje crudo del servidor —en español, siempre— o la clave.
    const faltan = [];
    for (const motivo of Object.keys(del.MOTIVOS)) {
      for (const lang of ['es', 'en']) {
        if (catalogo.STRINGS[lang][`del.blocker.${motivo}`] === undefined) {
          faltan.push(`${motivo} (${lang})`);
        }
      }
    }
    expect(faltan).toEqual([]);
  });
});

describe('Las páginas legales', () => {
  it('el aviso de privacidad trae el ancla que está dada de alta en Meta', () => {
    // El panel de Meta apunta a privacidad.html#eliminar-datos. Si el ancla se renombra
    // aquí, ese enlace lleva al principio de la página y la revisión se cae.
    expect(privacidad).toContain('id="eliminar-datos"');
    expect(privacidad).toContain('id="delete-data"');
  });

  it('la aplicación enlaza a las dos páginas desde donde se aceptan', () => {
    expect(html).toContain('terminos.html');
    expect(html).toContain('privacidad.html#eliminar-datos');
  });

  it('son públicas: no cargan la sesión ni piden cuenta', () => {
    for (const pagina of [privacidad, terminos]) {
      expect(pagina).not.toContain('js/api.js');
      expect(pagina).not.toContain('js/client.js');
      expect(pagina).not.toContain('sw.js');
    }
  });

  it('las dos traen español e inglés completos', () => {
    for (const pagina of [privacidad, terminos]) {
      const dom = new JSDOM(pagina);
      const d = dom.window.document;
      expect(d.querySelectorAll('article[data-l="es"]').length).toBe(1);
      expect(d.querySelectorAll('article[data-l="en"]').length).toBe(1);
      // Un documento legal a medias es peor que uno solo en español: se cita entero.
      expect(d.querySelector('article[data-l="es"]').textContent.length).toBeGreaterThan(3000);
      expect(d.querySelector('article[data-l="en"]').textContent.length).toBeGreaterThan(3000);
      dom.window.close();
    }
  });

  it('el aviso dice lo que el sistema de verdad hace, no lo contrario', () => {
    // Tres afirmaciones que el código respalda hoy. Si alguna deja de ser cierta —se
    // agrega un analytics, se empieza a guardar el token de Facebook— esta prueba no
    // se entera, pero el texto sí queda señalado como lo que hay que revisar.
    expect(privacidad).toMatch(/no usa ni una|no cookies|We use no cookies/i);
    expect(privacidad).toMatch(/se descarta|discarded/i);
    expect(privacidad).toMatch(/últimos 4 dígitos|last 4 digits/i);
  });

  it('el contacto es el mismo en las dos páginas', () => {
    const correo = /mailto:([^"]+)"/;
    expect(privacidad.match(correo)[1]).toBe(terminos.match(correo)[1]);
  });
});
