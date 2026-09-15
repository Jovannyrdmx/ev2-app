/**
 * El rol de la noche: quién atiende qué.
 *
 * Antes de esto, el gerente veía a su gente y su estado pero no podía decir "este
 * mesero atiende Zona Roja y Terraza". `staff_shifts` guarda UNA sola zona y solo
 * el propio empleado puede abrir su turno, así que el rol se armaba de palabra — y
 * a las dos de la mañana nadie podía decir quién atendía la Terraza, que es justo
 * el dato del que dependen las propinas y la responsabilidad de una mesa mal
 * atendida.
 *
 * ---------------------------------------------------------------------------
 * Asignar NO es abrir el turno
 * ---------------------------------------------------------------------------
 * Son dos cosas distintas y viven en dos tablas distintas a propósito. El gerente
 * arma el rol por adelantado (`shift_assignments`); el empleado marca su entrada
 * al llegar (`staff_shifts`). Si asignar abriera el turno, el sistema diría que
 * alguien está trabajando cuando todavía viene en camino — y entonces se pierde
 * la única manera de ver quién no llegó.
 *
 * ---------------------------------------------------------------------------
 * Cada puesto se asigna a lo que de verdad atiende
 * ---------------------------------------------------------------------------
 * Un mesero atiende ZONAS del plano, y puede cubrir varias. Un bartender está en
 * una BARRA. Poner a un bartender en una zona no significa nada: no hay mesas que
 * atender desde una barra, y aceptarlo dejaría filas que nadie sabe leer. El
 * `CHECK` de la migración lo impide en la base; aquí se explica en palabras para
 * que el gerente sepa qué corregir.
 */
'use strict';

const { ApiError } = require('../middleware/errors');

/**
 * Qué se le asigna a cada puesto.
 *
 * `multi` dice si esa persona puede cubrir varios destinos la misma noche: un
 * mesero sí (Zona Roja y Terraza), un bartender no (no puede estar en las dos
 * barras a la vez, y decir que sí es cómo se acaba esperando un trago que nadie
 * está preparando).
 */
const ASSIGNABLE = {
  waiter: { target: 'section', multi: true },
  hostess: { target: 'section', multi: true },
  bartender: { target: 'location', multi: false },
  // El almacén no atiende piso ni barra: su lugar es el almacén y no se asigna
  // por noche. Se deja fuera a propósito en vez de inventarle un destino.
};

const ASSIGNABLE_ROLES = Object.keys(ASSIGNABLE);

/** Qué le toca a este puesto, o null si no se asigna por noche. */
function ruleFor(role) {
  return ASSIGNABLE[String(role || '')] || null;
}

/**
 * La persona existe, es de este club, está activa y su puesto se asigna.
 *
 * Se niega a asignar a alguien inactivo: un empleado dado de baja en el rol de la
 * noche es una mesa que nadie va a atender, y el gerente no se enteraría hasta
 * que un cliente se quejara.
 */
async function loadPerson(runner, { nightclubId, userId }) {
  // `active` vive en `employee_profiles`, no en `users`: es la baja del EMPLEADO,
  // distinta de `users.status`, que es la de la cuenta. Las dos impiden asignar, y
  // el `LEFT JOIN` con `COALESCE` es a proposito: alguien sin ficha de empleado no
  // esta dado de baja -- simplemente no tiene ficha, y tratarlo como baja dejaria
  // fuera del rol a gente que si trabaja.
  const { rows } = await runner.query(
    `SELECT u.id, u.display_name, u.role, u.status,
            COALESCE(p.active, true) AS active
       FROM users u
       LEFT JOIN employee_profiles p ON p.user_id = u.id
      WHERE u.id = $1 AND u.nightclub_id = $2`,
    [userId, nightclubId],
  );
  if (rows.length === 0) throw ApiError.notFound('Esa persona no es de este club');
  const person = rows[0];

  if (person.active === false || person.status !== 'active') {
    throw ApiError.unprocessable(
      `${person.display_name} está dado de baja: reactívalo antes de ponerlo en el rol`,
      { user_id: person.id });
  }
  const rule = ruleFor(person.role);
  if (!rule) {
    throw ApiError.unprocessable(
      `El puesto "${person.role}" no se asigna por noche`,
      { role: person.role, assignable: ASSIGNABLE_ROLES });
  }
  return { person, rule };
}

/** La noche existe y es de este club. */
async function loadEvent(runner, { nightclubId, eventId }) {
  const { rows } = await runner.query(
    'SELECT id, name, event_date, doors_open_at FROM events_calendar WHERE id = $1 AND nightclub_id = $2',
    [eventId, nightclubId],
  );
  if (rows.length === 0) throw ApiError.notFound('Esa noche no existe');
  return rows[0];
}

/**
 * Comprueba el destino y lo devuelve normalizado.
 *
 * Una zona tiene que existir EN EL PLANO: asignar a alguien a "Terraza" cuando la
 * zona se llama "TERRAZA VIP" deja a esa persona asignada a un lugar que no
 * existe, y el rol se ve completo mientras una zona real queda sin nadie.
 */
async function checkTarget(runner, { nightclubId, rule, section, locationId }) {
  if (rule.target === 'section') {
    if (!section) throw ApiError.badRequest('Falta la zona', [{ field: 'section', message: 'Required' }]);
    if (locationId) throw ApiError.unprocessable('A un mesero se le asigna una zona, no una barra');
    const { rows } = await runner.query(
      `SELECT DISTINCT section FROM tables
        WHERE nightclub_id = $1 AND active AND section = $2::text`,
      [nightclubId, section],
    );
    if (rows.length === 0) {
      const todas = await runner.query(
        'SELECT DISTINCT section FROM tables WHERE nightclub_id = $1 AND active ORDER BY section',
        [nightclubId]);
      throw ApiError.unprocessable(`La zona "${section}" no existe en el plano`,
        { sections: todas.rows.map((r) => r.section) });
    }
    return { section, locationId: null };
  }

  if (!locationId) {
    throw ApiError.badRequest('Falta la barra', [{ field: 'location_id', message: 'Required' }]);
  }
  if (section) throw ApiError.unprocessable('A un bartender se le asigna una barra, no una zona');
  const { rows } = await runner.query(
    `SELECT id, kind FROM supply_locations
      WHERE id = $1 AND nightclub_id = $2 AND active`,
    [locationId, nightclubId],
  );
  if (rows.length === 0) throw ApiError.notFound('Esa barra no existe');
  if (rows[0].kind !== 'bar') {
    throw ApiError.unprocessable('Ese lugar no es una barra');
  }
  return { section: null, locationId };
}

/**
 * Pone a alguien en el rol de una noche.
 *
 * Idempotente por diseño: asignar dos veces lo mismo no es un error que valga la
 * pena interrumpir al gerente —seguramente tocó dos veces— así que devuelve la
 * fila que ya estaba. Lo que sí se niega es un SEGUNDO destino para un puesto que
 * solo puede estar en uno.
 */
async function assign(runner, { nightclubId, eventId, userId, section = null,
  locationId = null, note = null, assignedBy }) {
  await loadEvent(runner, { nightclubId, eventId });
  const { person, rule } = await loadPerson(runner, { nightclubId, userId });
  const destino = await checkTarget(runner, {
    nightclubId, rule, section, locationId,
  });

  if (!rule.multi) {
    const { rows } = await runner.query(
      `SELECT a.id, l.name AS bar_name FROM shift_assignments a
         LEFT JOIN supply_locations l ON l.id = a.location_id
        WHERE a.event_id = $1 AND a.user_id = $2
          AND a.location_id IS DISTINCT FROM $3::uuid`,
      [eventId, userId, destino.locationId],
    );
    if (rows.length > 0) {
      throw ApiError.conflict(
        `${person.display_name} ya está en ${rows[0].bar_name} esa noche: nadie atiende dos barras a la vez`,
        { assignment_id: rows[0].id });
    }
  }

  const { rows } = await runner.query(
    `INSERT INTO shift_assignments (nightclub_id, event_id, user_id, role, section,
                                    location_id, note, assigned_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [nightclubId, eventId, userId, person.role, destino.section, destino.locationId,
      note, assignedBy],
  );

  // `ON CONFLICT DO NOTHING` no devuelve fila cuando ya existía: se busca la que
  // hay para contestar lo mismo que la primera vez.
  if (rows.length === 0) {
    const previa = await runner.query(
      `SELECT id FROM shift_assignments
        WHERE event_id = $1 AND user_id = $2
          AND section IS NOT DISTINCT FROM $3::text
          AND location_id IS NOT DISTINCT FROM $4::uuid`,
      [eventId, userId, destino.section, destino.locationId]);
    return { id: previa.rows[0] ? previa.rows[0].id : null, already: true };
  }
  return { id: rows[0].id, already: false };
}

/** Quita a alguien de un destino. Lo que ya trabajó esa noche no se borra. */
async function unassign(runner, { nightclubId, assignmentId }) {
  const { rows } = await runner.query(
    `DELETE FROM shift_assignments
      WHERE id = $1 AND nightclub_id = $2
      RETURNING user_id, section, location_id`,
    [assignmentId, nightclubId],
  );
  if (rows.length === 0) throw ApiError.notFound('Esa asignación no existe');
  return rows[0];
}

/**
 * El rol de una noche, agrupado por persona.
 *
 * Trae si cada quien marcó entrada, porque **asignado y presente son dos cosas
 * distintas** y esta lista es la única que lo dice. Un rol que enseña a todos
 * iguales no sirve para notar que falta un mesero a las once de la noche.
 */
async function rosterFor(runner, { nightclubId, eventId }) {
  const { rows } = await runner.query(
    `SELECT a.user_id, u.display_name, u.role AS current_role, a.role AS assigned_role,
            json_agg(json_build_object(
              'assignment_id', a.id,
              'section', a.section,
              'location_id', a.location_id,
              'location_name', l.name,
              'note', a.note
            ) ORDER BY a.section, l.name) AS targets,
            (s.id IS NOT NULL) AS on_shift,
            s.started_at
       FROM shift_assignments a
       JOIN users u ON u.id = a.user_id
       LEFT JOIN supply_locations l ON l.id = a.location_id
       LEFT JOIN staff_shifts s ON s.user_id = a.user_id AND s.ended_at IS NULL
      WHERE a.nightclub_id = $1 AND a.event_id = $2
      GROUP BY a.user_id, u.display_name, u.role, a.role, s.id, s.started_at
      ORDER BY a.role, u.display_name`,
    [nightclubId, eventId],
  );
  return rows.map((r) => ({
    user_id: r.user_id,
    display_name: r.display_name,
    role: r.assigned_role,
    // Si la persona cambió de puesto desde que se le asignó, se dice: el rol de
    // aquella noche no cambia, pero el gerente necesita saberlo.
    role_changed: r.current_role !== r.assigned_role,
    current_role: r.current_role,
    targets: r.targets || [],
    on_shift: r.on_shift === true,
    started_at: r.started_at,
  }));
}

/**
 * Las zonas que quedaron SIN nadie, y las barras también.
 *
 * Es la mitad del valor de armar un rol: una zona sin mesero no se nota mirando
 * la lista de quién está asignado — se nota mirando lo que falta.
 */
async function gapsFor(runner, { nightclubId, eventId }) {
  const zonas = await runner.query(
    `SELECT DISTINCT t.section
       FROM tables t
      WHERE t.nightclub_id = $1 AND t.active
        AND NOT EXISTS (
          SELECT 1 FROM shift_assignments a
           WHERE a.event_id = $2 AND a.section = t.section
        )
      ORDER BY t.section`,
    [nightclubId, eventId],
  );
  const barras = await runner.query(
    `SELECT l.id, l.name
       FROM supply_locations l
      WHERE l.nightclub_id = $1 AND l.kind = 'bar' AND l.active
        AND NOT EXISTS (
          SELECT 1 FROM shift_assignments a
           WHERE a.event_id = $2 AND a.location_id = l.id
        )
      ORDER BY l.name`,
    [nightclubId, eventId],
  );
  return {
    sections: zonas.rows.map((r) => r.section),
    bars: barras.rows.map((r) => ({ location_id: r.id, name: r.name })),
  };
}

/** A qué quedó asignada una persona esa noche. Lo que ve el empleado al llegar. */
async function myAssignments(runner, { nightclubId, userId, eventId }) {
  const { rows } = await runner.query(
    `SELECT a.id, a.event_id, e.name AS event_name, e.event_date, e.doors_open_at,
            a.section, a.location_id, l.name AS location_name, a.note
       FROM shift_assignments a
       JOIN events_calendar e ON e.id = a.event_id
       LEFT JOIN supply_locations l ON l.id = a.location_id
      WHERE a.nightclub_id = $1 AND a.user_id = $2
        AND ($3::uuid IS NULL OR a.event_id = $3::uuid)
      ORDER BY e.event_date DESC, a.section, l.name`,
    [nightclubId, userId, eventId || null],
  );
  return rows;
}

module.exports = {
  ASSIGNABLE,
  ASSIGNABLE_ROLES,
  ruleFor,
  loadPerson,
  loadEvent,
  checkTarget,
  assign,
  unassign,
  rosterFor,
  gapsFor,
  myAssignments,
};
