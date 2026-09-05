/**
 * EV2 — a qué pantalla pertenece cada rol.
 *
 * Hasta ahora el login mandaba a todo el mundo a la pantalla del invitado: un
 * bartender entraba y veía el plano de mesas para sentarse. Aquí vive la decisión, en
 * un solo lugar y comprobable, de a dónde va cada quien.
 *
 * `ready: false` significa que la pantalla de ese rol todavía no está conectada a la
 * API. En ese caso NO se redirige: los archivos que existen en `web/` para esos roles
 * siguen mostrando datos inventados, y mandar a un empleado a una pantalla con números
 * falsos es peor que decirle la verdad. Se le muestra qué falta y de qué paso del plan
 * depende. Conforme cada pantalla se conecte se cambia su `ready` a true.
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EV2Roles = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const GUEST_HOME = 'index.html';

  // El orden de las claves sigue el CHECK de `users.role` en la migración 009.
  const ROLES = {
    guest: {
      label: { es: 'Invitado', en: 'Guest' }, home: GUEST_HOME, ready: true,
    },
    waiter: {
      label: { es: 'Mesero', en: 'Waiter' }, home: 'staff.html', ready: false, step: '5.7',
      does: { es: 'Recibir los pedidos de sus mesas, marcarlos entregados y ver sus propinas.', en: 'Take orders from their tables, mark them delivered and see their tips.' },
    },
    bartender: {
      label: { es: 'Bartender', en: 'Bartender' }, home: 'bartender.html', ready: false, step: '5.7',
      does: { es: 'La cola de pedidos de la barra en tiempo real: preparar, marcar listo.', en: "The bar's live order queue: prepare, mark ready." },
    },
    hostess: {
      label: { es: 'Hostess', en: 'Hostess' }, home: 'staff.html', ready: false, step: '5.7',
      does: { es: 'Acomodar gente en las mesas y ver qué zonas están llenas.', en: 'Seat people at tables and see which zones are full.' },
    },
    dancer: {
      label: { es: 'Bailarina', en: 'Dancer' }, home: 'employee-portal.html', ready: false, step: '5.4',
      does: { es: 'Sus propinas, sus ganancias y el registro de su cuenta para el retiro.', en: 'Their tips, their earnings and the bank account for payouts.' },
    },
    dj: {
      label: { es: 'DJ', en: 'DJ' }, home: 'employee-portal.html', ready: false, step: '5.4',
      does: { es: 'Las canciones que le pidieron y lo que lleva ganado por ellas.', en: 'The songs people requested and what they have earned from them.' },
    },
    light_tech: {
      label: { es: 'Iluminación', en: 'Lighting' }, home: 'employee-portal.html', ready: false, step: '5.4',
      does: { es: 'Sus turnos y sus ganancias.', en: 'Their shifts and their earnings.' },
    },
    valet: {
      label: { es: 'Valet', en: 'Valet' }, home: 'valet.html', ready: false, step: '5.6',
      does: { es: 'Entregar y devolver autos con el boleto, y ver los cajones ocupados.', en: 'Hand over and return cars with the ticket, and see which spots are taken.' },
    },
    driver: {
      label: { es: 'Conductor', en: 'Driver' }, home: 'driver.html', ready: false, step: '5.6',
      does: { es: 'Aceptar viajes, confirmar inicio y fin, y ver lo cobrado.', en: 'Accept rides, confirm start and end, and see what was charged.' },
    },
    manager: {
      label: { es: 'Gerente', en: 'Manager' }, home: 'manager.html', ready: false, step: '5.5',
      does: { es: 'Precios, plano, empleados, caja del turno y aprobación de retiros.', en: "Prices, floor plan, staff, the shift's till and payout approvals." },
    },
    admin: {
      label: { es: 'Administrador', en: 'Administrator' }, home: 'manager.html', ready: false, step: '5.5',
      does: { es: 'Todo lo del gerente, más conductores, integraciones y cuentas de pago.', en: 'Everything the manager has, plus drivers, integrations and payment accounts.' },
    },
  };

  const UNKNOWN = {
    label: { es: 'Sin rol asignado', en: 'No role assigned' },
    home: null,
    ready: false,
    step: null,
    does: {
      es: 'Este usuario tiene un rol que la app todavía no conoce.',
      en: 'This user has a role the app does not know yet.',
    },
  };

  const pick = (value, lang) => {
    if (value === null || value === undefined) return value;
    if (typeof value === 'string') return value;
    // Si a un idioma le falta la traducción, español antes que vacío.
    return value[lang] !== undefined ? value[lang] : value.es;
  };

  /**
   * Lo que se sabe del rol, ya en el idioma pedido. Nunca devuelve `undefined`: un rol
   * nuevo en la base no debe dejar la pantalla en blanco.
   */
  function describe(role, lang) {
    const source = ROLES[role] || UNKNOWN;
    const language = lang === 'en' ? 'en' : 'es';
    return {
      role: role || null,
      label: pick(source.label, language),
      does: pick(source.does, language),
      home: source.home,
      ready: source.ready,
      step: source.step === undefined ? null : source.step,
    };
  }

  const isGuest = (role) => role === 'guest';

  /**
   * A dónde mandar a alguien que acaba de entrar, estando en `currentPage`.
   *
   * Devuelve `{ action }`:
   *   'stay'     — ya está donde le toca.
   *   'redirect' — hay pantalla conectada para su rol y no es esta; `to` la nombra.
   *   'pending'  — su pantalla todavía no existe; hay que explicárselo.
   */
  function route(role, currentPage, lang) {
    const info = describe(role, lang);
    const page = String(currentPage || '').split('/').pop() || GUEST_HOME;

    if (!info.ready) return { action: 'pending', info };
    if (info.home === page) return { action: 'stay', info };
    return { action: 'redirect', to: info.home, info };
  }

  return { ROLES, GUEST_HOME, describe, isGuest, route };
}));
