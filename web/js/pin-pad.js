/**
 * EV2 — el teclado de 6 dígitos con el que entra el personal (D46).
 *
 * Sin DOM y sin red: son reglas de tecleo y de qué PIN se permite, y se prueban en
 * Node. La pantalla es un reflejo de esto.
 *
 * ---------------------------------------------------------------------------
 * Por qué las reglas del PIN están repetidas aquí
 * ---------------------------------------------------------------------------
 * `server/src/services/pins.js` tiene las mismas, y **el servidor es el que manda**:
 * lo de aquí no protege nada, porque cualquiera puede llamar a la API sin pasar por
 * esta pantalla. Existe por una razón de uso: alguien escogiendo su PIN nuevo de pie
 * en la barra, con gente esperando, no debería teclear 123456, mandarlo, esperar, y
 * recibir un rechazo. Se lo decimos mientras lo escribe.
 *
 * Si las dos listas se separan, lo que pasa es que la pantalla acepta algo que el
 * servidor rechaza — molesto, no peligroso. `web-pin-pad.test.js` las compara para que
 * no se separen en silencio.
 */
/* global module */
(function (root, factory) {
  'use strict';
  const lib = factory();
  if (typeof module === 'object' && module.exports) module.exports = lib;
  root.EV2PinPad = lib;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const PIN_LENGTH = 6;

  /**
   * Una tecla → el valor nuevo.
   *
   * Nunca lanza y nunca pasa de seis: el noveno toque de alguien nervioso no debe
   * hacer nada raro, solo nada.
   */
  function press(current, key) {
    const valor = String(current || '').replace(/\D/g, '').slice(0, PIN_LENGTH);
    if (key === 'back') return valor.slice(0, -1);
    if (key === 'clear') return '';
    if (/^\d$/.test(String(key))) {
      return valor.length >= PIN_LENGTH ? valor : valor + String(key);
    }
    return valor;
  }

  const isComplete = (value) => /^\d{6}$/.test(String(value || ''));

  /**
   * Los puntos que se pintan: cuántos llenos y cuántos vacíos.
   *
   * Se enseñan puntos y no los números: el teclado se usa parado en la barra, con
   * gente al lado y con la pantalla a la vista de todos.
   */
  function dots(value) {
    const n = String(value || '').replace(/\D/g, '').length;
    return Array.from({ length: PIN_LENGTH }, (unused, i) => i < n);
  }

  // --------------------------------------------------- qué PIN se permite escoger

  /** Las mismas reglas que `services/pins.js`. El servidor vuelve a comprobarlas. */
  function isWeak(pin) {
    const s = String(pin);
    if (!/^\d{6}$/.test(s)) return true;
    if (/^(\d)\1{5}$/.test(s)) return true;
    const sube = '01234567890123456789';
    const baja = '98765432109876543210';
    if (sube.includes(s) || baja.includes(s)) return true;
    if (/^(\d{2})\1{2}$/.test(s) || /^(\d{3})\1$/.test(s)) return true;
    if (/^(\d)\1(\d)\2(\d)\3$/.test(s)) return true;
    return false;
  }

  /** ¿Es su fecha de nacimiento? Igual que en el servidor, con las mismas formas. */
  function looksLikeBirthDate(pin, birthDate) {
    if (!birthDate) return false;
    // Igual que el servidor, que recibe un `Date` de Postgres y no un "1996-05-04".
    // Aquí casi siempre llega un texto, pero las dos listas tienen que coincidir: la
    // que se separa en silencio es la que deja pasar algo que luego se rechaza.
    const texto = birthDate instanceof Date
      ? birthDate.toISOString().slice(0, 10)
      : String(birthDate).slice(0, 10);
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(texto);
    if (!m) return false;
    const [, yyyy, mm, dd] = m;
    const yy = yyyy.slice(2);
    return [
      `${dd}${mm}${yy}`, `${mm}${dd}${yy}`, `${yy}${mm}${dd}`,
      `${dd}${mm}${yyyy.slice(0, 2)}`, `${yyyy}${mm}`.slice(0, 6), `${dd}${mm}${dd}`,
    ].includes(String(pin));
  }

  /**
   * Comprueba el PIN nuevo antes de mandarlo. Devuelve la clave del mensaje, o null.
   *
   * `current` es opcional: cuando el sistema está obligando a cambiarlo, la persona
   * acaba de teclearlo para entrar y volver a pedírselo no comprueba nada.
   */
  function validateNew(next, repeat, { current = null, birthDate = null } = {}) {
    if (!isComplete(next)) return 'pin.errLength';
    if (isWeak(next)) return 'pin.errWeak';
    if (looksLikeBirthDate(next, birthDate)) return 'pin.errBirthDate';
    if (current && next === current) return 'pin.errSame';
    if (repeat !== null && repeat !== undefined && next !== repeat) return 'pin.errMismatch';
    return null;
  }

  // --------------------------------------------------- cuál de los dos accesos

  const MODES = ['client', 'staff'];

  /** El acceso contrario, para el botón que los cambia. */
  const otherMode = (mode) => (mode === 'staff' ? 'client' : 'staff');

  /**
   * Con cuál acceso abrir la pantalla.
   *
   * Se recuerda el último que se usó EN ESE APARATO: la tableta de la barra la usan
   * cuarenta empleados por turno y ninguno debería tener que tocar "soy del equipo"
   * cada vez. El teléfono de un cliente, al revés, abre en cliente para siempre.
   *
   * Recordarlo no es una decisión de seguridad —no guarda quién entró ni su PIN, solo
   * cuál de las dos formas se usó— y por eso puede vivir en el navegador.
   */
  function initialMode(stored) {
    return MODES.includes(stored) ? stored : 'client';
  }

  return {
    PIN_LENGTH,
    MODES,
    press,
    isComplete,
    dots,
    isWeak,
    looksLikeBirthDate,
    validateNew,
    otherMode,
    initialMode,
  };
}));
