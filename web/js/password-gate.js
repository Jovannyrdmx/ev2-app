/**
 * EV2 — cambio de contraseña obligatorio.
 *
 * Un empleado o conductor que el gerente acaba de dar de alta entra con una contraseña
 * temporal, y el servidor le bloquea TODO hasta que la cambie (`must_change_password`,
 * middleware/auth.js). Sin esta pantalla, esa persona entra y no puede hacer nada: ve
 * errores sin explicación en cada llamada.
 *
 * Se monta igual en todas las pantallas de personal, así que vive aquí y no repetido
 * en cada una.
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EV2PasswordGate = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MIN_LENGTH = 8;

  /**
   * Comprueba lo que el servidor va a comprobar, antes de mandarlo. Devuelve la clave
   * del mensaje, o null si está bien.
   */
  function validate(current, next, repeat) {
    if (!current) return 'gate.errCurrent';
    if (!next || next.length < MIN_LENGTH) return 'gate.errShort';
    // El servidor rechaza repetir la temporal: decirlo aquí ahorra un viaje y un susto.
    if (next === current) return 'gate.errSame';
    if (next !== repeat) return 'gate.errMismatch';
    return null;
  }

  /** Si a este usuario hay que pedirle el cambio antes de dejarlo trabajar. */
  const isRequired = (user) => Boolean(user && user.must_change_password);

  return { MIN_LENGTH, validate, isRequired };
}));
