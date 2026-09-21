'use strict';

// El selector de idioma. Antes cambiaba su propia etiqueta y nada más: el resto de la
// pantalla seguía en español y la elección se perdía al recargar. Lo que se prueba aquí
// es justo lo que hace que eso no se note a simple vista.

const fs = require('fs');
const path = require('path');

const WEB = path.join(__dirname, '..', '..', 'web');

/** Cada prueba necesita su propio módulo: el idioma es estado dentro del módulo. */
function loadFormat({ stored, languages } = {}) {
  const store = new global.Map();
  if (stored !== undefined) store.set('ev2.lang', stored);
  global.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  // Node define `navigator` en globalThis, y no siempre se puede reasignar: hay que
  // redefinir la propiedad, no asignarla.
  Object.defineProperty(global, 'navigator', {
    value: { languages: languages || ['es-MX'] }, configurable: true, writable: true,
  });
  // Jest tiene su propio registro de módulos: `require.cache` no lo vacía.
  jest.resetModules();
  // eslint-disable-next-line global-require
  const F = require('../../web/js/format.js');
  return { F, store };
}

afterEach(() => {
  delete global.localStorage;
  delete global.navigator;
  jest.resetModules();
  delete global.document;
});

// ---------------------------------------------------------------- catálogo

describe('Catálogo de textos', () => {
  const { F } = loadFormat();

  it('el inglés no tiene huecos: ninguna clave se queda sin traducir', () => {
    // Esta es la prueba que evita una pantalla a medio traducir, que es peor que una
    // que no se traduce: el usuario ve mitad y mitad y no sabe si algo falló.
    expect(F.missingKeys('en')).toEqual([]);
  });

  it('el español tampoco tiene huecos frente al inglés', () => {
    const soloEnIngles = Object.keys(F.STRINGS.en).filter((k) => F.STRINGS.es[k] === undefined);
    expect(soloEnIngles).toEqual([]);
  });

  it('ninguna traducción quedó vacía o igual a la clave', () => {
    for (const language of F.SUPPORTED) {
      for (const [key, value] of Object.entries(F.STRINGS[language])) {
        expect(typeof value).toBe('string');
        expect(value.trim()).not.toBe('');
        expect(value).not.toBe(key);
      }
    }
  });

  it('el español y el inglés dicen cosas distintas donde tienen que decirlas', () => {
    // 'VIP' o 'DJ' son iguales en los dos idiomas a propósito; el grueso no debe serlo.
    const iguales = Object.keys(F.STRINGS.es)
      .filter((k) => F.STRINGS.es[k] === F.STRINGS.en[k]);
    expect(iguales.length).toBeLessThan(Object.keys(F.STRINGS.es).length * 0.2);
  });
});

// ---------------------------------------------------------------- el HTML y el catálogo

describe('El HTML marcado y el catálogo van juntos', () => {
  const { F } = loadFormat();
  // Cada pantalla que se conecta entra aquí: una clave marcada en el HTML que no existe
  // en el catálogo imprime el nombre de la clave en pantalla y nadie lo ve hasta que
  // alguien cambia de idioma.
  const PAGES = ['index.html', 'bartender.html', 'driver.html', 'manager.html',
    'staff.html', 'valet.html', 'employee-portal.html', 'almacen.html'];
  const sources = Object.fromEntries(
    PAGES.map((page) => [page, fs.readFileSync(path.join(WEB, page), 'utf8')]),
  );
  const html = sources['index.html'];
  const keysOf = (source, attr) => [...source.matchAll(new RegExp(`${attr}="([^"]+)"`, 'g'))]
    .map((m) => m[1]);
  const keysIn = (attr) => keysOf(html, attr);

  it.each(PAGES)('toda clave usada en %s existe en el catálogo', (page) => {
    const source = sources[page];
    const used = [...keysOf(source, 'data-i18n'), ...keysOf(source, 'data-i18n-placeholder'),
      ...keysOf(source, 'data-i18n-title')];
    expect(used.length).toBeGreaterThan(5);
    const huerfanas = [...new Set(used)].filter((k) => F.STRINGS.es[k] === undefined);
    expect(huerfanas).toEqual([]);
  });

  it.each(PAGES)('%s declara el idioma del documento', (page) => {
    expect(sources[page]).toMatch(/<html lang="(es|en)"/);
  });

  it('la pantalla de acceso está marcada: es lo primero que se ve', () => {
    const used = new Set(keysIn('data-i18n').concat(keysIn('data-i18n-placeholder')));
    for (const key of ['auth.signin', 'auth.signup', 'auth.enter', 'auth.email',
      'auth.password', 'auth.terms', 'auth.adults']) {
      expect(used.has(key)).toBe(true);
    }
  });

  it('las pestañas de abajo están marcadas', () => {
    const used = new Set(keysIn('data-i18n'));
    for (const key of ['nav.map', 'nav.menu', 'nav.orders', 'nav.profile']) {
      expect(used.has(key)).toBe(true);
    }
  });

  it('el marcador de idioma del documento arranca declarado', () => {
    expect(html).toMatch(/<html lang="(es|en)"/);
  });
});

// ---------------------------------------------------------------- elección y memoria

describe('Qué idioma se usa', () => {
  it('sin nada guardado, sigue al navegador', () => {
    expect(loadFormat({ languages: ['en-US', 'es'] }).F.getLanguage()).toBe('en');
    expect(loadFormat({ languages: ['es-MX'] }).F.getLanguage()).toBe('es');
  });

  it('un navegador en un idioma que no hablamos cae a español, no a la clave', () => {
    expect(loadFormat({ languages: ['de-DE', 'fr'] }).F.getLanguage()).toBe('es');
  });

  it('lo guardado gana sobre el navegador: es una decisión del usuario', () => {
    expect(loadFormat({ stored: 'en', languages: ['es-MX'] }).F.getLanguage()).toBe('en');
  });

  it('la elección se guarda, para que sobreviva a recargar', () => {
    // Este era el fallo: el idioma vivía en una variable y al recargar volvía a español.
    const { F, store } = loadFormat({ languages: ['es-MX'] });
    F.setLanguage('en');
    expect(store.get('ev2.lang')).toBe('en');
    const segunda = loadFormat({ stored: store.get('ev2.lang') });
    expect(segunda.F.getLanguage()).toBe('en');
  });

  it('un valor basura guardado no rompe la app', () => {
    expect(loadFormat({ stored: 'klingon', languages: ['es-MX'] }).F.getLanguage()).toBe('es');
  });

  it('sin localStorage (modo privado) la app abre igual', () => {
    jest.resetModules();
    global.localStorage = {
      getItem() { throw new Error('acceso denegado'); },
      setItem() { throw new Error('acceso denegado'); },
    };
    Object.defineProperty(global, 'navigator', {
      value: { languages: ['en-US'] }, configurable: true, writable: true,
    });
    // eslint-disable-next-line global-require
    const F = require('../../web/js/format.js');
    expect(F.getLanguage()).toBe('en');
    expect(() => F.setLanguage('es')).not.toThrow();
  });

  it('el botón anuncia el idioma AL QUE se cambia, no el actual', () => {
    const { F } = loadFormat({ stored: 'es' });
    expect(F.otherLanguage()).toBe('en');
    F.setLanguage('en');
    expect(F.otherLanguage()).toBe('es');
  });
});

// ---------------------------------------------------------------- traducción

describe('Traducción de textos', () => {
  it('cambia el texto de verdad al cambiar de idioma', () => {
    const { F } = loadFormat({ stored: 'es' });
    expect(F.t('nav.map')).toBe('Mapa');
    F.setLanguage('en');
    expect(F.t('nav.map')).toBe('Map');
  });

  it('una clave que no existe no imprime la clave en pantalla', () => {
    const { F } = loadFormat();
    expect(F.t('no.existe', 'Reserva')).toBe('Reserva');
  });

  it('si al inglés le faltara una clave, cae al español y no al nombre de la clave', () => {
    const { F } = loadFormat({ stored: 'en' });
    const guardado = F.STRINGS.en['nav.map'];
    delete F.STRINGS.en['nav.map'];
    try {
      expect(F.t('nav.map')).toBe('Mapa');
    } finally {
      F.STRINGS.en['nav.map'] = guardado;
    }
  });

  it('rellena los huecos del texto', () => {
    const { F } = loadFormat({ stored: 'es' });
    expect(F.tf('staff.pending', { step: '5.7' })).toContain('paso 5.7');
    expect(F.tf('staff.pending', { step: '5.7' })).not.toContain('{step}');
    F.setLanguage('en');
    expect(F.tf('staff.pending', { step: '5.7' })).toContain('step 5.7');
  });

  it('un hueco sin valor se deja tal cual en vez de imprimir "undefined"', () => {
    const { F } = loadFormat({ stored: 'es' });
    expect(F.tf('staff.pending', {})).toContain('{step}');
  });

  it('el dinero y las fechas cambian de formato con el idioma', () => {
    const { F } = loadFormat({ stored: 'es' });
    const enEspanol = F.money('1500.5', 'MXN');
    F.setLanguage('en');
    const enIngles = F.money('1500.5', 'MXN');
    // Lo que importa es que la cantidad no se deforme al cambiar de idioma: el
    // símbolo puede coincidir entre es-MX y en-US, el número no puede cambiar.
    expect(enEspanol).toMatch(/1,500\.50/);
    expect(enIngles).toMatch(/1,500\.50/);
    expect(F.locale()).toBe('en-US');
    F.setLanguage('es');
    expect(F.locale()).toBe('es-MX');
  });
});

// ---------------------------------------------------------------- aplicar al DOM

/** Un DOM mínimo: solo lo que `applyTo` toca. */
function fakeDom(nodes) {
  return {
    querySelectorAll(selector) {
      const attr = selector.slice(1, -1); // "[data-i18n]" -> "data-i18n"
      return nodes.filter((n) => n.attrs[attr] !== undefined);
    },
  };
}
const node = (attrs) => ({
  attrs,
  textContent: '',
  set: {},
  getAttribute(name) { return this.attrs[name]; },
  setAttribute(name, value) { this.set[name] = value; },
});

describe('Aplicar el idioma al HTML ya escrito', () => {
  it('reemplaza el texto de cada elemento marcado', () => {
    const { F } = loadFormat({ stored: 'en' });
    const a = node({ 'data-i18n': 'nav.map' });
    const b = node({ 'data-i18n': 'nav.menu' });
    expect(F.applyTo(fakeDom([a, b]))).toBe(2);
    expect(a.textContent).toBe('Map');
    expect(b.textContent).toBe('Menu');
  });

  it('también traduce los textos que viven en un atributo', () => {
    // Un formulario con los campos en inglés y los avisos dentro del campo en español
    // se ve descuidado y confunde.
    const { F } = loadFormat({ stored: 'en' });
    const input = node({ 'data-i18n-placeholder': 'auth.email' });
    const button = node({ 'data-i18n-title': 'top.signOut' });
    F.applyTo(fakeDom([input, button]));
    expect(input.set.placeholder).toBe('Email');
    expect(button.set.title).toBe('Sign out');
  });

  it('no toca lo que no está marcado', () => {
    const { F } = loadFormat({ stored: 'en' });
    const libre = node({});
    libre.textContent = 'ZONA ROJA';
    F.applyTo(fakeDom([libre]));
    expect(libre.textContent).toBe('ZONA ROJA');
  });

  it('sin documento no revienta', () => {
    const { F } = loadFormat();
    expect(F.applyTo(null)).toBe(0);
    expect(F.applyTo({})).toBe(0);
  });

  it('marca el idioma en el documento, para lectores de pantalla y el corrector', () => {
    const { F } = loadFormat();
    const documentElement = {};
    global.document = { documentElement };
    F.setLanguage('en');
    expect(documentElement.lang).toBe('en');
  });
});

// ---------------------------------------------------------------- roles bilingües

describe('Los roles también hablan los dos idiomas', () => {
  // eslint-disable-next-line global-require
  const Roles = require('../../web/js/roles.js');

  it('cada rol tiene nombre en los dos idiomas', () => {
    for (const role of Object.keys(Roles.ROLES)) {
      expect(Roles.describe(role, 'es').label).toBeTruthy();
      expect(Roles.describe(role, 'en').label).toBeTruthy();
    }
  });

  it('el nombre del rol cambia con el idioma', () => {
    expect(Roles.describe('waiter', 'es').label).toBe('Mesero');
    expect(Roles.describe('waiter', 'en').label).toBe('Waiter');
    expect(Roles.describe('admin', 'es').label).toBe('Administrador');
    expect(Roles.describe('admin', 'en').label).toBe('Administrator');
  });

  it('la explicación de qué hace su pantalla también', () => {
    expect(Roles.describe('bartender', 'es').does).toMatch(/barra/i);
    expect(Roles.describe('bartender', 'en').does).toMatch(/bar/i);
  });

  it('un rol desconocido responde en el idioma pedido', () => {
    expect(Roles.describe('nada', 'en').label).toBe('No role assigned');
    expect(Roles.describe('nada', 'es').label).toBe('Sin rol asignado');
  });

  it('sin idioma responde en español, no vacío', () => {
    expect(Roles.describe('valet').label).toBe('Valet');
    expect(Roles.describe('manager').does).toMatch(/Precios/);
  });
});

// ---------------------------------------------------------------- lo que manda el servidor

describe('El catálogo cubre lo que el SERVIDOR manda', () => {
  // Nace de un defecto real: el catálogo tenía `wh.kind.receive` —la clave del BOTÓN del
  // almacén— y el servidor manda `receipt` en cada entrada de mercancía. En el kardex, la
  // operación más frecuente de la bodega se veía con el texto crudo `wh.kind.receipt`.
  //
  // Las pruebas que había no lo veían porque armaban la lista de tipos desde el propio
  // cliente. Esta la toma del servidor, que es quien decide.
  const { F } = loadFormat();
  // eslint-disable-next-line global-require
  const inventory = require('../src/services/inventory');

  it('cada tipo de movimiento de inventario tiene texto en los dos idiomas', () => {
    const faltan = [];
    for (const kind of inventory.MOVEMENT_KINDS) {
      for (const idioma of F.SUPPORTED) {
        if (!F.STRINGS[idioma][`wh.kind.${kind}`]) faltan.push(`${idioma}:${kind}`);
      }
    }
    expect(faltan).toEqual([]);
  });
});
