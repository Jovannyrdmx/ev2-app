/**
 * EV2 — el rol de la noche del lado del navegador.
 *
 * Quién puede ir a qué, qué queda sin nadie, y qué está mal antes de mandarlo. Sin
 * DOM y sin red, porque son reglas y no pintado.
 *
 * El servidor las valida todas otra vez. Esto existe para que el gerente no arme
 * un rol de doce personas y descubra al final que puso al bartender en una zona.
 */
/* global module */
(function (root, factory) {
  'use strict';
  const lib = factory();
  if (typeof module === 'object' && module.exports) module.exports = lib;
  root.EV2Roster = lib;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /**
   * Qué se le asigna a cada puesto, igual que en el servidor.
   *
   * `multi: true` = puede cubrir varios destinos. Un mesero sí (Zona Roja y
   * Terraza); un bartender no, porque nadie atiende dos barras a la vez y decir
   * que sí es cómo se acaba esperando un trago que nadie está preparando.
   */
  const ASSIGNABLE = {
    waiter: { target: 'section', multi: true },
    hostess: { target: 'section', multi: true },
    bartender: { target: 'location', multi: false },
  };

  const ASSIGNABLE_ROLES = Object.keys(ASSIGNABLE);

  const ruleFor = (role) => ASSIGNABLE[String(role || '')] || null;

  /** ¿Este puesto se acomoda cada noche? El almacén y la gerencia, no. */
  const isAssignable = (role) => ruleFor(role) !== null;

  /**
   * La gente que se puede poner en el rol, de la lista de personal.
   *
   * Se filtra a los dados de baja: un empleado inactivo en el rol es una mesa que
   * nadie va a atender, y el gerente no se enteraría hasta que un cliente se
   * quejara.
   */
  function candidates(staff) {
    return (staff || [])
      .filter((p) => isAssignable(p.role) && p.active !== false && p.status !== 'blocked')
      .slice()
      .sort((a, b) => String(a.role).localeCompare(String(b.role))
        || String(a.display_name || '').localeCompare(String(b.display_name || '')));
  }

  /** Los candidatos agrupados por puesto, que es como el gerente los busca. */
  function candidatesByRole(staff) {
    const grupos = new Map();
    for (const person of candidates(staff)) {
      if (!grupos.has(person.role)) grupos.set(person.role, []);
      grupos.get(person.role).push(person);
    }
    return [...grupos.entries()].map(([role, people]) => ({ role, people }));
  }

  /**
   * ¿Se puede poner a esta persona en este destino? Devuelve el problema, o null.
   *
   * Los códigos los traduce la pantalla. Se devuelve UNO porque es una sola
   * decisión: o se puede o no, y decir dos razones a la vez confunde más que
   * ayuda.
   */
  function check({ person, section = null, locationId = null, roster = [] }) {
    if (!person) return { code: 'no_person' };
    const rule = ruleFor(person.role);
    if (!rule) return { code: 'role_not_assignable', role: person.role };
    if (person.active === false) return { code: 'inactive', name: person.display_name };

    // El destino EQUIVOCADO se avisa antes que el destino que falta: si alguien
    // arrastró un mesero a una barra, "a un mesero se le asigna una zona" le dice
    // qué pasó, y "falta la zona" le hace buscar un campo que no está mal.
    if (rule.target === 'section') {
      if (locationId) return { code: 'waiter_needs_zone' };
      if (!section) return { code: 'need_section' };
    } else {
      if (section) return { code: 'bartender_needs_bar' };
      if (!locationId) return { code: 'need_bar' };
    }

    const ya = (roster || []).find((p) => p.user_id === person.id || p.user_id === person.user_id);
    if (ya) {
      const mismo = (ya.targets || []).some((t) => (section && t.section === section)
        || (locationId && t.location_id === locationId));
      if (mismo) return { code: 'already_there', name: person.display_name };
      if (!rule.multi) {
        const donde = (ya.targets || [])[0];
        return {
          code: 'only_one_bar',
          name: person.display_name,
          current: donde ? donde.location_name : null,
        };
      }
    }
    return null;
  }

  /**
   * El rol agrupado por destino: qué zona tiene a quién.
   *
   * Es la vista que de verdad usa el gerente al armarlo —piensa en zonas, no en
   * personas— y la lista por persona no la contesta sin leerla entera.
   */
  function byTarget({ roster = [], sections = [], bars = [] }) {
    const zonas = new Map(sections.map((s) => [s, []]));
    const barras = new Map(bars.map((b) => [b.location_id, { name: b.name, people: [] }]));

    for (const person of roster) {
      for (const target of person.targets || []) {
        if (target.section) {
          if (!zonas.has(target.section)) zonas.set(target.section, []);
          zonas.get(target.section).push({
            user_id: person.user_id,
            display_name: person.display_name,
            role: person.role,
            on_shift: person.on_shift === true,
            assignment_id: target.assignment_id,
          });
        } else if (target.location_id) {
          if (!barras.has(target.location_id)) {
            barras.set(target.location_id, { name: target.location_name, people: [] });
          }
          barras.get(target.location_id).people.push({
            user_id: person.user_id,
            display_name: person.display_name,
            role: person.role,
            on_shift: person.on_shift === true,
            assignment_id: target.assignment_id,
          });
        }
      }
    }

    return {
      sections: [...zonas.entries()]
        .map(([section, people]) => ({ section, people }))
        .sort((a, b) => a.section.localeCompare(b.section)),
      bars: [...barras.entries()]
        .map(([locationId, info]) => ({ location_id: locationId, ...info }))
        .sort((a, b) => String(a.name).localeCompare(String(b.name))),
    };
  }

  /**
   * Cómo va el rol: cuánto falta y qué falta.
   *
   * `complete` solo cuando NADA quedó sin nadie. Una zona sin mesero no se nota
   * mirando la lista de asignados: se nota mirando lo que falta, y es la mitad del
   * valor de armar un rol.
   */
  function progress({ roster = [], gaps = { sections: [], bars: [] } }) {
    const faltanZonas = (gaps.sections || []).length;
    const faltanBarras = (gaps.bars || []).length;
    return {
      assigned: roster.length,
      on_shift: roster.filter((p) => p.on_shift).length,
      missing_sections: faltanZonas,
      missing_bars: faltanBarras,
      complete: faltanZonas === 0 && faltanBarras === 0,
      // Quien quedó en el rol y no marcó entrada. Es lo que el gerente revisa a
      // las once de la noche.
      not_arrived: roster.filter((p) => !p.on_shift).map((p) => p.display_name),
    };
  }

  /** El cuerpo de `POST /nights/:id/roster`. */
  function assignBody({ userId, section = null, locationId = null, note = null }) {
    return {
      user_id: userId,
      ...(section ? { section } : {}),
      ...(locationId ? { location_id: locationId } : {}),
      ...(note && String(note).trim() ? { note: String(note).trim() } : {}),
    };
  }

  /** Lo que ve el empleado al llegar: a qué quedó asignado, en una línea. */
  function describeMine(assignments, { lang = 'es' } = {}) {
    const lista = assignments || [];
    if (lista.length === 0) return null;
    const zonas = lista.map((a) => a.section).filter(Boolean);
    const barras = lista.map((a) => a.location_name).filter(Boolean);
    const partes = zonas.concat(barras);
    return {
      targets: partes,
      // Se junta con "y" y no con comas a secas: lo lee una persona con prisa.
      text: partes.length > 1
        ? `${partes.slice(0, -1).join(', ')} ${lang === 'en' ? 'and' : 'y'} ${partes[partes.length - 1]}`
        : partes[0],
      event_name: lista[0].event_name || null,
      note: lista.map((a) => a.note).filter(Boolean)[0] || null,
    };
  }

  return {
    ASSIGNABLE,
    ASSIGNABLE_ROLES,
    ruleFor,
    isAssignable,
    candidates,
    candidatesByRole,
    check,
    byTarget,
    progress,
    assignBody,
    describeMine,
  };
}));
