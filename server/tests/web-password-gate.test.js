/**
 * La puerta de credencial temporal (D46), y los identificadores de las dos pantallas
 * que nadie estaba vigilando (auditoría del 28/09).
 *
 * ---------------------------------------------------------------------------
 * Por qué este archivo existe
 * ---------------------------------------------------------------------------
 * `password-gate.js` es un módulo de **seguridad**: decide si a una persona se le
 * exige cambiar su contraseña o su PIN antes de dejarla trabajar, y se carga en las
 * siete pantallas de personal. No tenía una sola aserción.
 *
 * Y `driver-screen.js` y `valet-screen.js` eran las dos únicas pantallas completas sin
 * prueba de que los identificadores que buscan existan de verdad en su HTML. Un `id`
 * renombrado en el HTML no rompe nada al cargar: rompe cuando el chofer toca el botón,
 * a mitad de un viaje, y en la consola de su teléfono que nadie está mirando.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const WEB = path.join(__dirname, '..', '..', 'web');
const Gate = require(path.join(WEB, 'js', 'password-gate.js'));
const catalogo = require(path.join(WEB, 'js', 'format.js'));

describe('Cuándo hay que cambiar la credencial antes de trabajar', () => {
  it('con la contraseña temporal pendiente, sí', () => {
    expect(Gate.isRequired({ must_change_password: true })).toBe(true);
    expect(Gate.isRequired({ must_change_password: false })).toBe(false);
  });

  it('sin usuario no revienta: contesta que no', () => {
    // La pantalla llama a esto antes de tener sesión más veces de las que parece.
    expect(Gate.isRequired(null)).toBe(false);
    expect(Gate.isRequired(undefined)).toBe(false);
    expect(Gate.isRequired({})).toBe(false);
  });

  it('el PIN se reconoce aparte de la contraseña', () => {
    // Son dos puertas distintas: el piso entra con PIN y no tiene contraseña; la
    // gerencia nace con las dos pendientes. Confundirlas manda a alguien al teclado
    // equivocado.
    expect(Gate.mustChangePin({ must_change_pin: true })).toBe(true);
    expect(Gate.mustChangePin({ must_change_password: true })).toBe(false);
    expect(Gate.mustChangePin(null)).toBe(false);
  });

  it('el teclado del PIN vive en una sola dirección', () => {
    // Siete pantallas mandan ahí. Si cada una la inventara, cambiarla sería siete
    // cambios y seis olvidos.
    expect(Gate.PIN_PAGE).toBe('index.html');
  });
});

describe('Lo que se comprueba antes de mandar la contraseña nueva', () => {
  const ok = (c, n, r) => Gate.validate(c, n, r);

  it('una contraseña bien puesta pasa', () => {
    expect(ok('temporal1', 'unaBuena2026', 'unaBuena2026')).toBeNull();
  });

  it('sin la actual no se manda: el servidor la va a pedir', () => {
    expect(ok('', 'unaBuena2026', 'unaBuena2026')).toBe('gate.errCurrent');
  });

  it('corta se detiene aquí, con el mínimo escrito en un solo lugar', () => {
    const corta = 'a'.repeat(Gate.MIN_LENGTH - 1);
    expect(ok('temporal1', corta, corta)).toBe('gate.errShort');
    const justa = 'a'.repeat(Gate.MIN_LENGTH);
    expect(ok('temporal1', justa, justa)).toBeNull();
    expect(Gate.MIN_LENGTH).toBe(8);
  });

  it('repetir la temporal NO es cambiarla', () => {
    // El servidor lo rechaza igual. Decirlo aquí ahorra el viaje y el susto de ver un
    // error rojo después de haber creído que ya quedó.
    expect(ok('temporal1', 'temporal1', 'temporal1')).toBe('gate.errSame');
  });

  it('las dos veces tienen que coincidir', () => {
    expect(ok('temporal1', 'unaBuena2026', 'unaBuena2027')).toBe('gate.errMismatch');
  });

  it('el orden de los avisos es el útil: primero lo que falta, luego lo que no cuadra', () => {
    // Con todo mal a la vez, decir "no coinciden" antes que "falta la actual" manda a
    // corregir lo de abajo mientras lo de arriba sigue vacío.
    expect(ok('', '', '')).toBe('gate.errCurrent');
    expect(ok('temporal1', 'abc', 'xyz')).toBe('gate.errShort');
  });

  it('cada mensaje que puede devolver existe en los dos idiomas', () => {
    // Un aviso sin texto sale como la clave cruda ('gate.errShort') en la pantalla.
    const claves = ['gate.errCurrent', 'gate.errShort', 'gate.errSame', 'gate.errMismatch'];
    for (const clave of claves) {
      expect(typeof catalogo.t(clave, {}, 'es')).toBe('string');
      expect(catalogo.t(clave, {}, 'es')).not.toBe(clave);
      expect(catalogo.t(clave, {}, 'en')).not.toBe(clave);
    }
  });
});

// ============================================================================

/**
 * Los identificadores que cada pantalla busca tienen que existir en su HTML.
 *
 * Es la misma prueba que ya protege a bartender, manager y almacén. Estas dos se
 * habían quedado fuera, y son justo las de quien trabaja solo y en la calle: el
 * chofer y el del valet parking.
 */
describe('Los identificadores de driver.html y valet.html', () => {
  /** Todo `$('algo')` o `getElementById('algo')` del módulo. */
  function idsQueBusca(fuente) {
    const ids = new Set();
    for (const m of fuente.matchAll(/\$\('([a-z0-9-]+)'\)/gi)) ids.add(m[1]);
    for (const m of fuente.matchAll(/getElementById\('([a-z0-9-]+)'\)/gi)) ids.add(m[1]);
    return [...ids];
  }

  const comprobar = (pagina, modulo) => {
    const html = fs.readFileSync(path.join(WEB, pagina), 'utf8');
    const js = fs.readFileSync(path.join(WEB, 'js', modulo), 'utf8');
    const dom = new JSDOM(html);
    const faltan = idsQueBusca(js)
      .filter((id) => !dom.window.document.getElementById(id));
    dom.window.close();
    return faltan;
  };

  it('driver.html tiene todo lo que driver-screen.js busca', () => {
    expect(comprobar('driver.html', 'driver-screen.js')).toEqual([]);
  });

  it('valet.html tiene todo lo que valet-screen.js busca', () => {
    expect(comprobar('valet.html', 'valet-screen.js')).toEqual([]);
  });

  it('y la prueba de verdad mira algo: encuentra identificadores', () => {
    // Una expresión regular rota daría lista vacía y las dos de arriba pasarían sin
    // comprobar nada.
    const js = fs.readFileSync(path.join(WEB, 'js', 'driver-screen.js'), 'utf8');
    expect(idsQueBusca(js).length).toBeGreaterThan(10);
  });
});
