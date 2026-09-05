/**
 * EV2 — idioma y formato (paso 5.1).
 *
 * Dos cosas que se hacen mal muy fácil:
 *
 * 1. **El dinero llega como cadena decimal** (`"1500.00"`) porque un peso no cabe sin
 *    pérdida en un `number` de JavaScript en cuanto se hacen cuentas. Aquí se formatea
 *    sin convertir a float, y sumar importes se hace en centavos enteros.
 * 2. **Los ids de evento son enteros de 64 bits** y viajan como cadena. No los pases por
 *    `Number()`.
 */
(function (root, factory) {
  const lib = factory();
  if (typeof module === 'object' && module.exports) module.exports = lib;
  else root.EV2Format = lib;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const LOCALES = { es: 'es-MX', en: 'en-US' };

  const STRINGS = {
    es: {
      'error.network': 'Sin conexión. Revisa tu señal e intenta de nuevo.',
      'error.unauthorized': 'Tu sesión terminó. Vuelve a entrar.',
      'error.forbidden': 'No tienes permiso para hacer esto.',
      'error.not_found': 'No encontramos eso.',
      'error.conflict': 'Alguien se adelantó. Vuelve a intentar.',
      'error.unprocessable': 'No se puede completar con esos datos.',
      'error.too_many_requests': 'Demasiados intentos. Espera un momento.',
      'error.not_implemented': 'Todavía no está disponible.',
      'error.unknown': 'Algo salió mal. Intenta de nuevo.',
      'realtime.reconnecting': 'Reconectando…',
      'realtime.resync': 'Actualizando la pantalla…',
      'realtime.replaced': 'Abriste la app en otro lado.',
    },
    en: {
      'error.network': 'No connection. Check your signal and try again.',
      'error.unauthorized': 'Your session ended. Please sign in again.',
      'error.forbidden': "You don't have permission to do this.",
      'error.not_found': "We couldn't find that.",
      'error.conflict': 'Someone got there first. Try again.',
      'error.unprocessable': "That can't be completed with those details.",
      'error.too_many_requests': 'Too many attempts. Wait a moment.',
      'error.not_implemented': 'Not available yet.',
      'error.unknown': 'Something went wrong. Try again.',
      'realtime.reconnecting': 'Reconnecting…',
      'realtime.resync': 'Refreshing…',
      'realtime.replaced': 'You opened the app somewhere else.',
    },
  };

  let lang = 'es';

  function setLanguage(next) {
    lang = STRINGS[next] ? next : 'es';
    return lang;
  }
  const getLanguage = () => lang;
  const locale = () => LOCALES[lang];

  function t(key, fallback) {
    const table = STRINGS[lang] || STRINGS.es;
    return table[key] || fallback || key;
  }

  /**
   * El mensaje del servidor ya viene en español y suele ser más útil que uno genérico
   * (dice *por qué* no se pudo). Se usa ese, y el texto propio solo cuando no hay.
   */
  function errorMessage(err) {
    if (!err) return t('error.unknown');
    if (err.name === 'NetworkError') return t('error.network');
    if (err.message && err.code && err.code !== 'unknown' && lang === 'es') return err.message;
    return t(`error.${err.code || 'unknown'}`, err.message);
  }

  /** "1500.00" -> "$1,500.00". Nunca convierte a float para mostrar. */
  function money(amount, currency, opts = {}) {
    if (amount === null || amount === undefined || amount === '') return '—';
    const value = typeof amount === 'string' ? Number(amount) : amount;
    if (!Number.isFinite(value)) return String(amount);
    return new Intl.NumberFormat(opts.locale || locale(), {
      style: 'currency',
      currency: currency || 'MXN',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value);
  }

  /** Suma importes decimales en centavos enteros: 0.1 + 0.2 no es 0.3 en float. */
  function addMoney(...amounts) {
    const cents = amounts.reduce((sum, a) => {
      if (a === null || a === undefined || a === '') return sum;
      return sum + Math.round(Number(a) * 100);
    }, 0);
    return (cents / 100).toFixed(2);
  }

  function dateTime(iso, opts = {}) {
    if (!iso) return '—';
    return new Intl.DateTimeFormat(opts.locale || locale(), Object.assign({
      dateStyle: 'medium', timeStyle: 'short',
    }, opts.format || {})).format(new Date(iso));
  }

  function time(iso) {
    if (!iso) return '—';
    return new Intl.DateTimeFormat(locale(), { hour: '2-digit', minute: '2-digit' })
      .format(new Date(iso));
  }

  /** "llega en 8 min", "ya pasó". Para la espera del taxi y del auto en el valet. */
  function minutesUntil(iso) {
    if (!iso) return null;
    return Math.round((new Date(iso).getTime() - Date.now()) / 60000);
  }

  return {
    setLanguage, getLanguage, locale, t, errorMessage, money, addMoney, dateTime, time,
    minutesUntil, STRINGS,
  };
}));
