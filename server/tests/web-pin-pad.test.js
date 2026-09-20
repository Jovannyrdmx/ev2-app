/**
 * El teclado del PIN, y la pantalla de acceso que lo enseña (D46).
 *
 * Dos cosas distintas se prueban aquí:
 *
 *  1. Las reglas de tecleo (`web/js/pin-pad.js`), que son lo único del PIN que vive en
 *     el navegador y decide qué ve la persona mientras escribe.
 *  2. Que la copia de las reglas del servidor **siga siendo una copia**. El servidor es
 *     el que manda, y si las dos listas se separan la pantalla acepta algo que el
 *     servidor rechaza: molesto, no peligroso, pero solo se descubre con alguien de pie
 *     en la barra tecleando un PIN que no le dejan poner y sin que le digan por qué.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..', '..', 'web');
const leer = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const Pad = require(path.join(ROOT, 'js', 'pin-pad.js'));
const pins = require('../src/services/pins');
const catalogo = require(path.join(ROOT, 'js', 'format.js'));

// ---------------------------------------------------------------- teclear

describe('Teclear el PIN', () => {
  it('suma dígito a dígito hasta seis', () => {
    let v = '';
    for (const d of '482913') v = Pad.press(v, d);
    expect(v).toBe('482913');
    expect(Pad.isComplete(v)).toBe(true);
  });

  it('el séptimo toque no hace nada — ni añade ni reinicia', () => {
    // Alguien nervioso toca de más. Lo peor que puede pasar es que el PIN correcto se
    // convierta en otro sin que lo note.
    const v = Pad.press('482913', '7');
    expect(v).toBe('482913');
  });

  it('borrar quita el último y limpiar los quita todos', () => {
    expect(Pad.press('4829', 'back')).toBe('482');
    expect(Pad.press('4829', 'clear')).toBe('');
    expect(Pad.press('', 'back')).toBe('');
  });

  it('una tecla que no es un dígito se ignora en vez de romper', () => {
    expect(Pad.press('48', 'a')).toBe('48');
    expect(Pad.press('48', null)).toBe('48');
    expect(Pad.press(undefined, '4')).toBe('4');
  });

  it('nunca da por completo algo que no sean seis dígitos', () => {
    expect(Pad.isComplete('12345')).toBe(false);
    expect(Pad.isComplete('1234567')).toBe(false);
    expect(Pad.isComplete('')).toBe(false);
    expect(Pad.isComplete(null)).toBe(false);
  });

  it('los puntos dicen cuántos van, no cuáles son', () => {
    expect(Pad.dots('482')).toEqual([true, true, true, false, false, false]);
    expect(Pad.dots('')).toEqual([false, false, false, false, false, false]);
    expect(Pad.dots('482913')).toEqual([true, true, true, true, true, true]);
  });
});

// ---------------------------------------------------------------- qué PIN se deja poner

describe('Las reglas de la pantalla son las del servidor', () => {
  it('coinciden en los UN MILLÓN de PIN posibles', () => {
    // No una muestra: son un millón de combinaciones y comprobarlas todas tarda menos
    // que discutir cuál muestra sería representativa.
    const distintos = [];
    for (let n = 0; n < 1000000; n += 1) {
      const pin = String(n).padStart(6, '0');
      if (Pad.isWeak(pin) !== pins.isWeakPin(pin)) distintos.push(pin);
      if (distintos.length > 5) break;
    }
    expect(distintos).toEqual([]);
  });

  it('coinciden también en la fecha de nacimiento, venga como texto o como fecha', () => {
    // Postgres devuelve `birth_date` como Date, no como texto: por eso el servidor
    // normaliza los dos. Si la pantalla no lo hiciera igual, dejaría teclear un PIN que
    // el servidor rechaza sin que nadie entienda por qué.
    const nacimiento = '1994-03-27';
    const comoFecha = new Date(`${nacimiento}T00:00:00Z`);
    for (const pin of ['270394', '032794', '940327', '270319', '199403', '272703', '482913']) {
      expect(Pad.looksLikeBirthDate(pin, nacimiento))
        .toBe(pins.looksLikeBirthDate(pin, nacimiento));
      expect(Pad.looksLikeBirthDate(pin, comoFecha))
        .toBe(pins.looksLikeBirthDate(pin, comoFecha));
    }
  });

  it('sin fecha de nacimiento no rechaza nada por ese motivo', () => {
    expect(Pad.looksLikeBirthDate('270394', null)).toBe(false);
    expect(Pad.looksLikeBirthDate('270394', undefined)).toBe(false);
  });
});

describe('Escoger el PIN nuevo', () => {
  it('reclama antes de mandarlo, con el motivo exacto', () => {
    expect(Pad.validateNew('1234', null, {})).toBe('pin.errLength');
    expect(Pad.validateNew('123456', null, {})).toBe('pin.errWeak');
    expect(Pad.validateNew('111111', null, {})).toBe('pin.errWeak');
    expect(Pad.validateNew('270394', null, { birthDate: '1994-03-27' })).toBe('pin.errBirthDate');
    expect(Pad.validateNew('482913', null, { current: '482913' })).toBe('pin.errSame');
    expect(Pad.validateNew('482913', '482914', {})).toBe('pin.errMismatch');
  });

  it('un PIN bueno pasa', () => {
    expect(Pad.validateNew('482913', '482913', {})).toBe(null);
    expect(Pad.validateNew('482913', null, {})).toBe(null);
  });

  it('cada motivo tiene su texto, en los dos idiomas', () => {
    // Un `null` en pantalla donde debía ir el motivo deja a la persona sin saber qué
    // corregir, y con el teclado en blanco otra vez.
    for (const key of ['pin.errLength', 'pin.errWeak', 'pin.errBirthDate',
      'pin.errSame', 'pin.errMismatch']) {
      for (const idioma of catalogo.SUPPORTED) {
        expect(typeof catalogo.STRINGS[idioma][key]).toBe('string');
        expect(catalogo.STRINGS[idioma][key].trim()).not.toBe('');
      }
    }
  });
});

describe('Cuál de las dos puertas se abre', () => {
  it('lo contrario de una es la otra', () => {
    expect(Pad.otherMode('client')).toBe('staff');
    expect(Pad.otherMode('staff')).toBe('client');
  });

  it('sin nada guardado abre en cliente', () => {
    expect(Pad.initialMode(null)).toBe('client');
    expect(Pad.initialMode('')).toBe('client');
    expect(Pad.initialMode('cualquier-cosa')).toBe('client');
  });

  it('con algo guardado abre donde se quedó', () => {
    expect(Pad.initialMode('staff')).toBe('staff');
    expect(Pad.initialMode('client')).toBe('client');
  });
});

// ---------------------------------------------------------------- la pantalla

describe('La pantalla de acceso tiene lo que el controlador busca', () => {
  const html = leer('index.html');
  const controlador = leer('js/index-screen.js');
  const abiertas = [];
  afterEach(() => { while (abiertas.length) abiertas.pop().close(); });

  const documento = () => {
    const dom = new JSDOM(html, { url: 'https://ev2.local/index.html' });
    abiertas.push(dom.window);
    return dom.window.document;
  };

  it('cada id que busca index-screen.js existe en index.html', () => {
    // Un `$('pin-dots')` contra un `id="pin_dots"` no falla al cargar: deja el teclado
    // sin puntos y nadie se entera hasta que alguien intenta entrar.
    const doc = documento();
    const ids = new Set();
    const re = /\$\('([a-z0-9-]+)'\)/g;
    let m = re.exec(controlador);
    while (m) { ids.add(m[1]); m = re.exec(controlador); }
    expect([...ids].filter((id) => !doc.getElementById(id))).toEqual([]);
  });

  it('carga js/pin-pad.js antes que index-screen.js', () => {
    // El orden importa: index-screen.js usa EV2PinPad al arrancar.
    const doc = documento();
    const src = [...doc.querySelectorAll('script[src]')].map((s) => s.getAttribute('src'));
    expect(src).toContain('js/pin-pad.js');
    expect(src.indexOf('js/pin-pad.js')).toBeLessThan(src.indexOf('js/index-screen.js'));
  });

  it('el teclado arranca escondido y el formulario del cliente a la vista', () => {
    const doc = documento();
    expect(doc.getElementById('pin-pad').hasAttribute('hidden')).toBe(true);
    expect(doc.getElementById('form-login').hasAttribute('hidden')).toBe(false);
  });

  it('las siete pantallas de personal llevan al teclado', () => {
    // Quien abre bartender.html directamente ya no tiene contraseña que escribir: sin
    // este enlace se queda mirando un formulario que no puede llenar.
    for (const page of ['almacen', 'bartender', 'driver', 'employee-portal',
      'manager', 'staff', 'valet']) {
      const dom = new JSDOM(leer(`${page}.html`), { url: `https://ev2.local/${page}.html` });
      abiertas.push(dom.window);
      const enlaces = [...dom.window.document.querySelectorAll('a[href="index.html"]')];
      expect(enlaces.some((a) => a.dataset.i18n === 'pin.usePin')).toBe(true);
    }
  });

  it('el service worker guarda el teclado: sin señal, el turno entero entra igual', () => {
    expect(leer('sw.js')).toContain("'js/pin-pad.js'");
  });
});
