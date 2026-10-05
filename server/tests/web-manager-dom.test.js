/**
 * El panel del gerente contra el `web/manager.html` REAL.
 *
 * Existe por la pestaña de inventario, que es la primera vez que el gerente puede
 * corregir una receta sin que alguien escriba un curl. Pero comprueba el panel entero:
 * un `$('inv-value')` contra un `id="inv_value"` no rompe nada al cargar y deja la
 * pestaña muerta, y una pestaña que no está en `TABS` nunca se muestra aunque su botón
 * exista.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..', '..', 'web');
const leer = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const html = leer('manager.html');
const controlador = leer('js/manager-screen.js');
const catalogo = require(path.join(ROOT, 'js', 'format.js'));

const abiertas = [];
afterEach(() => { while (abiertas.length) abiertas.pop().close(); });

function documento() {
  const dom = new JSDOM(html, { url: 'https://ev2.local/manager.html' });
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
  it('cada id que busca manager-screen.js existe en manager.html', () => {
    const doc = documento();
    const faltantes = idsQueBusca(controlador).filter((id) => !doc.getElementById(id));
    expect(faltantes).toEqual([]);
  });

  // D88: una sección del menú puede mostrar varios paneles (Salida = choferes + taxis).
  const panelesPorPestana = () => {
    const cuerpo = /const TAB_PANELS = \{([^}]+)\}/.exec(controlador)[1];
    const mapa = {};
    for (const m of cuerpo.matchAll(/(\w+):\s*\[([^\]]*)\]/g)) {
      mapa[m[1]] = m[2].split(',').map((x) => x.trim().replace(/'/g, '')).filter(Boolean);
    }
    return mapa;
  };

  it('cada pestaña con botón tiene sus paneles, y cada panel tiene su pestaña', () => {
    const doc = documento();
    const mapa = panelesPorPestana();
    const botones = [...new Set([...doc.querySelectorAll('[data-tab]')].map((b) => b.dataset.tab))];
    const paneles = [...doc.querySelectorAll('[id^="tab-"]')].map((p) => p.id);
    expect(botones.filter((t) => !mapa[t])).toEqual([]);
    expect(Object.keys(mapa).filter((t) => !botones.includes(t))).toEqual([]);
    const declarados = Object.values(mapa).flat();
    expect(declarados.filter((id) => !doc.getElementById(id))).toEqual([]);
    expect(paneles.filter((id) => !declarados.includes(id))).toEqual([]);
  });

  it('los nombres viejos de pestaña (choferes, taxis) llevan a Salida', () => {
    expect(controlador).toMatch(/const TAB_ALIAS = \{\s*drivers: 'exit', taxi: 'exit'\s*\}/);
  });
});

describe('la pestaña de inventario', () => {
  it('tiene su botón y su panel, y el panel arranca escondido', () => {
    const doc = documento();
    expect(doc.querySelector('[data-tab="inventory"]')).not.toBeNull();
    expect(doc.getElementById('tab-inventory').hasAttribute('hidden')).toBe(true);
  });

  it('trae las cuatro vistas y abre en existencias', () => {
    // `menu` es de D66: dar de alta un trago y cambiar un precio ya no exige tocar la
    // base de datos. Abrir en existencias sigue siendo lo correcto — es lo que el
    // gerente mira cada noche; la carta se toca una vez cada tanto.
    const doc = documento();
    const vistas = [...doc.querySelectorAll('[data-inv]')].map((b) => b.dataset.inv);
    expect(vistas).toEqual(['stock', 'recipes', 'kardex', 'menu']);
    expect(doc.querySelector('[data-inv].on').dataset.inv).toBe('stock');
  });

  it('el alta de un trago nace escondida: solo se ve en la carta', () => {
    expect(documento().getElementById('menu-add').hasAttribute('hidden')).toBe(true);
  });

  it('el editor de receta nace cerrado', () => {
    expect(documento().getElementById('recipe-sheet').hasAttribute('hidden')).toBe(true);
  });

  // Esta pestaña solo MIRA el inventario. Recibir mercancía, surtir las barras y contar
  // se hace en `almacen.html`, y hasta ahora nada en esta pantalla decía que esa
  // pantalla existe: el gerente tenía que teclear la URL para entrar a su propio
  // almacén. Desde D88 es UNA puerta, con su nombre, dentro de la pestaña: el ícono
  // del encabezado hacía lo mismo sin decir qué era.
  it('hay una puerta al almacén en la pestaña, y no está repetida', () => {
    const doc = documento();
    const puerta = doc.getElementById('btn-open-warehouse');
    expect(puerta).not.toBeNull();
    expect(puerta.tagName).toBe('A');
    expect(puerta.getAttribute('href')).toBe('almacen.html');
    expect(puerta.hasAttribute('hidden')).toBe(false);
    expect(doc.querySelectorAll('a[href="almacen.html"]')).toHaveLength(1);
  });

  it('el almacén tiene la vuelta al panel, y nace escondida hasta saber quién entró', () => {
    const dom = new JSDOM(leer('almacen.html'), { url: 'https://ev2.local/almacen.html' });
    abiertas.push(dom.window);
    const volver = dom.window.document.getElementById('btn-back-manager');
    expect(volver).not.toBeNull();
    expect(volver.getAttribute('href')).toBe('manager.html');
    // A un almacenista no se le ofrece una puerta que el servidor le va a cerrar: el
    // controlador la descubre solo para el gerente y el administrador.
    expect(volver.hasAttribute('hidden')).toBe(true);
    const wh = leer('js/warehouse-screen.js');
    expect(wh).toContain("$('btn-back-manager').hidden");
  });

  it('el aviso de presentaciones sin confirmar nace escondido', () => {
    expect(documento().getElementById('inv-unconfirmed').hasAttribute('hidden')).toBe(true);
  });

  it('no trae ningún número escrito a mano', () => {
    const doc = documento();
    for (const id of ['inv-value', 'inv-low', 'inv-norecipe']) {
      expect(doc.getElementById(id).textContent.trim()).toBe('—');
    }
    expect(doc.getElementById('inv-list').textContent.trim()).toBe('');
  });

  it('carga warehouse.js ANTES del controlador: la pestaña reusa su aritmética', () => {
    const doc = documento();
    const srcs = [...doc.querySelectorAll('script')].map((s) => s.getAttribute('src'));
    expect(srcs).toContain('js/warehouse.js');
    expect(srcs.indexOf('js/warehouse.js')).toBeLessThan(srcs.indexOf('js/manager-screen.js'));
  });

  it('el gerente lee el inventario por la API, nunca con números de la pantalla', () => {
    // Las cuatro consultas que alimentan la pestaña. Si alguien las quita, la pestaña
    // se queda pintando un estado vacío y nadie se entera.
    for (const ruta of ['/supply-locations', '/supplies', '/recipes', '/supply-movements']) {
      expect(controlador).toContain(ruta);
    }
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

  it('cada data-i18n de manager.html está en español y en inglés', () => {
    const usadas = [...claves(html, 'data-i18n'), ...claves(html, 'data-i18n-placeholder'),
      ...claves(html, 'data-i18n-title')];
    for (const lang of ['es', 'en']) {
      catalogo.setLanguage(lang);
      const faltantes = usadas.filter((k) => catalogo.t(k) === k);
      expect({ lang, faltantes }).toEqual({ lang, faltantes: [] });
    }
  });

  it('cada texto del inventario que pide el controlador existe en los dos idiomas', () => {
    const usadas = new Set();
    const re = /t\('(inv\.[a-zA-Z0-9_.]+)'/g;
    let m = re.exec(controlador);
    while (m) { usadas.add(m[1]); m = re.exec(controlador); }
    expect(usadas.size).toBeGreaterThanOrEqual(15);
    for (const lang of ['es', 'en']) {
      catalogo.setLanguage(lang);
      const faltantes = [...usadas].filter((k) => catalogo.t(k) === k);
      expect({ lang, faltantes }).toEqual({ lang, faltantes: [] });
    }
  });

  it('los tipos de movimiento del kardex tienen nombre: el gerente ve los mismos', () => {
    const wh = require(path.join(ROOT, 'js', 'warehouse.js'));
    const kinds = wh.movementKeys().concat(['consumption', 'return', 'transfer_in', 'transfer_out']);
    for (const lang of ['es', 'en']) {
      catalogo.setLanguage(lang);
      const faltantes = kinds.filter((k) => catalogo.t(`wh.kind.${k}`) === `wh.kind.${k}`);
      expect({ lang, faltantes }).toEqual({ lang, faltantes: [] });
    }
  });
});

// ---------------------------------------------------------------- las terminales

describe('los botones de las terminales nunca se quedan callados', () => {
  // El 21 de septiembre de 2026 el gerente reportó dos veces "el botón no funciona". Las
  // dos se reprodujeron en Chromium contra la API real y eran ciertas: había cuatro
  // caminos en los que tocar no producía nada visible. Estas pruebas cuidan que no
  // vuelvan. La reproducción completa, con los clics, está en docs/AVANCE.md.

  it('cada texto de terminales que pide el controlador existe en los dos idiomas', () => {
    const usadas = new Set();
    const re = /'(term\.[a-zA-Z]+)'/g;
    let m = re.exec(controlador);
    while (m) { usadas.add(m[1]); m = re.exec(controlador); }
    for (const k of ['term.searching', 'term.registering', 'term.needName', 'term.noneFound',
      'term.sandboxReady', 'term.savedPending', 'term.fixing']) {
      expect(usadas.has(k)).toBe(true);
    }
    for (const lang of ['es', 'en']) {
      catalogo.setLanguage(lang);
      const faltantes = [...usadas].filter((k) => catalogo.t(k) === k);
      expect({ lang, faltantes }).toEqual({ lang, faltantes: [] });
    }
  });

  it('"Buscar en Mercado Pago" ya no se apaga por falta de credenciales', () => {
    // Apagado se veía igual y no respondía. Ahora al tocarlo explica qué falta.
    expect(controlador).not.toMatch(/btn-term-discover'\)\.disabled = Boolean/);
    expect(controlador).toMatch(/btn-term-discover'\)\.disabled = false/);
  });

  it('dar de alta sin nombre lo DICE, no solo pinta el borde', () => {
    const bloque = controlador.slice(controlador.indexOf('function renderFoundTerminals'));
    const sinNombre = bloque.slice(bloque.indexOf('if (!label)'), bloque.indexOf('if (!label)') + 200);
    expect(sinNombre).toMatch(/term\.needName/);
  });

  it('una búsqueda vacía también contesta', () => {
    expect(controlador).toMatch(/terminals\.found\.length === 0\) avisar\(error, t\('term\.noneFound'\)/);
  });
});
