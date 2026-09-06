/**
 * EV2 — el personal del club, visto por el gerente (paso 5.5).
 *
 * Es la pantalla que hace que un servidor recién instalado sirva de algo: sin ella el
 * club tiene un gerente y nadie más, y no hay mesero que lleve una charola ni cantinero
 * que la prepare.
 *
 * Aquí se decide a quién se enseña, en qué orden, y qué se puede hacer con cada quien.
 * Las reglas de dinero no viven aquí: el saldo de un empleado se calcula en el servidor
 * desde `transactions` y esta pantalla nunca lo toca.
 *
 * Sin DOM a propósito: todo esto se prueba en Node.
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EV2StaffAdmin = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const EMPLOYEE_ROLES = ['waiter', 'bartender', 'hostess', 'dancer', 'dj', 'light_tech', 'valet'];

  const text = (v) => String(v === null || v === undefined ? '' : v).trim();

  /**
   * El orden de la lista.
   *
   * Primero quien está en turno: el gerente abre esto en medio de la noche para saber
   * quién está trabajando, no para revisar el archivo. Después por rol, y dentro del
   * rol por nombre, para que la lista no se reacomode sola entre recargas. Las bajas
   * hasta el final: siguen existiendo por su historial, pero ya no son la operación.
   */
  function sortStaff(staff) {
    const rank = (person) => {
      if (person.active === false) return 3;
      return person.on_shift ? 0 : 1;
    };
    const roleRank = (role) => {
      const i = EMPLOYEE_ROLES.indexOf(role);
      return i === -1 ? EMPLOYEE_ROLES.length : i;
    };
    return (staff || [])
      .filter((p) => p && p.id)
      .slice()
      .sort((a, b) => rank(a) - rank(b)
        || roleRank(a.role) - roleRank(b.role)
        || text(a.display_name).localeCompare(text(b.display_name), 'es'));
  }

  /** Cuántos hay, cuántos trabajando y cuántos dados de baja. */
  function counts(staff) {
    const list = (staff || []).filter((p) => p && p.id);
    const active = list.filter((p) => p.active !== false);
    return {
      total: list.length,
      active: active.length,
      onShift: active.filter((p) => p.on_shift).length,
      inactive: list.length - active.length,
    };
  }

  /**
   * Qué se puede hacer con esta persona.
   *
   * Un empleado dado de baja no se borra nunca: conserva su historial y su saldo, que
   * es dinero que todavía se le debe. Lo único que se le hace es reactivarlo.
   */
  function actionsFor(person) {
    const p = person || {};
    const active = p.active !== false;
    return {
      canEdit: active,
      canResetPassword: active,
      canDeactivate: active,
      canReactivate: !active,
      // Reiniciar la contraseña de quien ya la tiene pendiente no aporta nada: ya está
      // esperando a cambiarla y le daríamos una temporal nueva por gusto.
      passwordPending: Boolean(p.must_change_password),
    };
  }

  const STATUS_KEY = {
    on_shift: 'staff.stOnShift',
    off_shift: 'staff.stOffShift',
    inactive: 'staff.stInactive',
    pending_password: 'staff.stPendingPassword',
  };

  /**
   * El estado en una palabra. El orden importa: una cuenta que nunca se ha usado es
   * más urgente de ver que si esa persona está o no en turno, porque significa que
   * todavía no puede trabajar.
   */
  function statusOf(person) {
    const p = person || {};
    if (p.active === false) return STATUS_KEY.inactive;
    if (p.must_change_password && !p.last_login_at) return STATUS_KEY.pending_password;
    return p.on_shift ? STATUS_KEY.on_shift : STATUS_KEY.off_shift;
  }

  // ---------------------------------------------------------------- alta

  const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  const MIN_AGE = 18;

  /** Años cumplidos a día de hoy. Cuenta el mes y el día, no solo el año. */
  function yearsSince(isoDate, now) {
    if (!isoDate) return null;
    const born = new Date(`${isoDate}T00:00:00Z`);
    if (Number.isNaN(born.getTime())) return null;
    const today = now ? new Date(now) : new Date();
    let years = today.getUTCFullYear() - born.getUTCFullYear();
    const month = today.getUTCMonth() - born.getUTCMonth();
    if (month < 0 || (month === 0 && today.getUTCDate() < born.getUTCDate())) years -= 1;
    return years;
  }

  /**
   * Comprueba el alta antes de mandarla. Devuelve un objeto de errores por campo.
   *
   * La edad se comprueba aquí y también en el servidor. No es un capricho: es un
   * centro nocturno, y dar de alta a un menor como personal es el peor error que
   * puede cometer esta pantalla.
   */
  function validateEmployee(form, now) {
    const errors = {};
    const f = form || {};

    if (!text(f.first_name)) errors.first_name = 'staff.errRequired';
    if (!text(f.last_name)) errors.last_name = 'staff.errRequired';
    if (!EMAIL.test(text(f.email))) errors.email = 'staff.errEmail';
    if (!EMPLOYEE_ROLES.includes(f.role)) errors.role = 'staff.errRole';

    if (!/^\d{4}-\d{2}-\d{2}$/.test(text(f.birth_date))) {
      errors.birth_date = 'staff.errBirthDate';
    } else {
      const age = yearsSince(f.birth_date, now);
      if (age === null) errors.birth_date = 'staff.errBirthDate';
      else if (age < MIN_AGE) errors.birth_date = 'staff.errUnderage';
      else if (age > 100) errors.birth_date = 'staff.errBirthDate';
    }

    const phone = text(f.phone);
    // Un teléfono mal capturado no se descubre hasta la noche en que hay que llamar a
    // esa persona, así que se revisa ahora aunque el servidor lo acepte.
    if (phone && phone.replace(/\D/g, '').length < 10) errors.phone = 'staff.errPhone';

    return errors;
  }

  /** Lo que se manda al crear. El servidor genera la contraseña temporal, no nosotros. */
  function employeePayload(form) {
    const body = {
      email: text(form.email).toLowerCase(),
      first_name: text(form.first_name),
      last_name: text(form.last_name),
      role: form.role,
      country: form.country || 'MX',
      birth_date: text(form.birth_date),
    };
    const phone = text(form.phone);
    if (phone) body.phone = phone.slice(0, 30);
    // El nombre artístico solo se manda si de verdad es distinto: mandarlo igual al
    // nombre real crearía un alias que no significa nada.
    const stage = text(form.stage_name);
    if (stage && stage.toLowerCase() !== `${body.first_name} ${body.last_name}`.toLowerCase()) {
      body.stage_name = stage.slice(0, 80);
    }
    const code = text(form.employee_code);
    if (code) body.employee_code = code.slice(0, 30);
    const hire = text(form.hire_date);
    if (hire) body.hire_date = hire;
    return body;
  }

  /**
   * Cómo se enseña a alguien en la lista: el nombre que usa el club.
   *
   * Una ambientadora trabaja con nombre artístico y el gerente la conoce por ese;
   * enseñarle el nombre legal la haría irreconocible en la lista. Se enseñan los dos
   * cuando difieren, porque para nómina hace falta el real.
   */
  function displayFor(person) {
    const p = person || {};
    const legal = `${text(p.first_name)} ${text(p.last_name)}`.trim();
    const stage = text(p.stage_name);
    if (stage && stage.toLowerCase() !== legal.toLowerCase()) {
      return { primary: stage, secondary: legal };
    }
    return { primary: legal || text(p.display_name), secondary: '' };
  }

  return {
    EMPLOYEE_ROLES,
    MIN_AGE,
    yearsSince,
    sortStaff,
    counts,
    actionsFor,
    statusOf,
    validateEmployee,
    employeePayload,
    displayFor,
  };
}));
