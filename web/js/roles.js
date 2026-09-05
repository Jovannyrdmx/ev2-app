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
      label: 'Invitado', home: GUEST_HOME, ready: true,
    },
    waiter: {
      label: 'Mesero', home: 'staff.html', ready: false, step: '5.7',
      does: 'Recibir los pedidos de sus mesas, marcarlos entregados y ver sus propinas.',
    },
    bartender: {
      label: 'Bartender', home: 'bartender.html', ready: false, step: '5.7',
      does: 'La cola de pedidos de la barra en tiempo real: preparar, marcar listo.',
    },
    hostess: {
      label: 'Hostess', home: 'staff.html', ready: false, step: '5.7',
      does: 'Acomodar gente en las mesas y ver qué zonas están llenas.',
    },
    dancer: {
      label: 'Bailarina', home: 'employee-portal.html', ready: false, step: '5.4',
      does: 'Sus propinas, sus ganancias y el registro de su cuenta para el retiro.',
    },
    dj: {
      label: 'DJ', home: 'employee-portal.html', ready: false, step: '5.4',
      does: 'Las canciones que le pidieron y lo que lleva ganado por ellas.',
    },
    light_tech: {
      label: 'Iluminación', home: 'employee-portal.html', ready: false, step: '5.4',
      does: 'Sus turnos y sus ganancias.',
    },
    valet: {
      label: 'Valet', home: 'valet.html', ready: false, step: '5.6',
      does: 'Entregar y devolver autos con el boleto, y ver los cajones ocupados.',
    },
    driver: {
      label: 'Conductor', home: 'driver.html', ready: false, step: '5.6',
      does: 'Aceptar viajes, confirmar inicio y fin, y ver lo cobrado.',
    },
    manager: {
      label: 'Gerente', home: 'manager.html', ready: false, step: '5.5',
      does: 'Precios, plano, empleados, caja del turno y aprobación de retiros.',
    },
    admin: {
      label: 'Administrador', home: 'manager.html', ready: false, step: '5.5',
      does: 'Todo lo del gerente, más conductores, integraciones y cuentas de pago.',
    },
  };

  const UNKNOWN = {
    label: 'Sin rol asignado', home: null, ready: false, step: null,
    does: 'Este usuario tiene un rol que la app todavía no conoce.',
  };

  /** Lo que se sabe del rol. Nunca devuelve `undefined`: un rol nuevo en la base no
   *  debe dejar la pantalla en blanco. */
  function describe(role) {
    return Object.assign({ role: role || null }, ROLES[role] || UNKNOWN);
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
  function route(role, currentPage) {
    const info = describe(role);
    const page = String(currentPage || '').split('/').pop() || GUEST_HOME;

    if (!info.ready) return { action: 'pending', info };
    if (info.home === page) return { action: 'stay', info };
    return { action: 'redirect', to: info.home, info };
  }

  return { ROLES, GUEST_HOME, describe, isGuest, route };
}));
