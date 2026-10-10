/**
 * El corte y el rol del lado del navegador.
 *
 * Lo que se prueba son las tres cosas que este código se NIEGA a hacer, porque
 * hacerlas daría un número creíble y falso:
 *
 *   1. **Comparar noches de distinta moneda.** Un viernes en pesos contra un
 *      sábado en dólares da una diferencia cuatro veces más grande de lo que es.
 *   2. **Inventar un porcentaje sin denominador.** Un martes sin reservaciones no
 *      tuvo 0% de no-shows: no tuvo el dato.
 *   3. **Ofrecer un botón que va a fallar.** Cerrar una noche que no empezó, o
 *      poner a un bartender en una zona.
 *
 * Y que los `id` existan: un `$('cut-body')` que no está no falla al cargar la
 * página, falla cuando el gerente abre el corte a la una de la mañana.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..', '..', 'web');
const leer = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const managerHtml = leer('manager.html');
const portalHtml = leer('employee-portal.html');
const managerJs = leer('js/manager-screen.js');
const portalJs = leer('js/employee-screen.js');
const R = require(path.join(ROOT, 'js', 'night-report.js'));
const Roster = require(path.join(ROOT, 'js', 'roster.js'));
const catalogo = require(path.join(ROOT, 'js', 'format.js'));

const abiertas = [];
afterEach(() => { while (abiertas.length) abiertas.pop().close(); });

function documento(fuente) {
  const dom = new JSDOM(fuente, { url: 'https://ev2.systems/manager.html' });
  abiertas.push(dom.window);
  return dom.window.document;
}

/** Un corte como el que manda el servidor. */
const STATS = {
  event: { id: 'e1', name: 'Viernes', event_date: '2026-09-11', doors_open_at: '2026-09-11T22:00:00Z' },
  currency: 'MXN',
  revenue: { total: 9500, tables: 6000, bar: 500, door: 3000, deposits: 1800, refunds: 0, tips_not_club_revenue: 500 },
  attendance: { total: 28, door: 20, table_guests: 8 },
  reservations: { booked: 4, arrived: 2, no_show: 2, cancelled: 0, guests_arrived: 8, revenue: 6000, deposits: 1800, refunds: 0 },
  tables: { total: 10, used: 4, occupancy: 40 },
  zones: [
    { section: 'ZONA ROJA', tables_total: 5, tables_used: 4, occupancy: 80, guests: 8, revenue: 6000, no_show: 0 },
    { section: 'TERRAZA', tables_total: 5, tables_used: 0, occupancy: 0, guests: 0, revenue: 0, no_show: 2 },
  ],
  bar: {
    orders: 3, revenue: 500, cancelled: 1, cancelled_value: 900,
    by_category: [
      { category: 'Whisky', units: 2, revenue: 400 },
      { category: 'Cerveza', units: 1, revenue: 100 },
    ],
    by_bar: [{ location_id: 'b1', name: 'Barra planta baja', orders: 3, cost: 150 }],
  },
  door: { people: 20, revenue: 3000, general: 20, general_revenue: 3000, extras: 0, extras_revenue: 0 },
  tips: { total: 500, count: 2, by_person: [{ user_id: 'u1', display_name: 'Ana', role: 'waiter', total: 500, count: 2 }] },
  shrinkage: { value: 900, counted: 0, waste: 900, courtesy: 360 },
  staff: { assigned: 3, showed_up: 2, people: [] },
  per_person: 339.29,
};

const cierre = (over = {}) => ({
  event_id: 'e1', event_name: 'Viernes', event_date: '2026-09-11', currency: 'MXN',
  revenue_total: 9500, revenue_bar: 500, revenue_door: 3000, revenue_tables: 6000,
  tips_total: 500, attendance: 28, tables_total: 10, tables_used: 4, orders_count: 3,
  reservations_booked: 4, reservations_arrived: 2, reservations_no_show: 2,
  shrinkage_value: 900, ...over,
});

// ===========================================================================
// Los id existen
// ===========================================================================

/** Los `id` que el controlador busca y nadie crea, ni en el HTML ni en sus plantillas. */
function idsPerdidos(html, js) {
  const doc = documento(html);
  const creados = new Set();
  const reCreado = /id="([a-z0-9-]+)"/g;
  let c = reCreado.exec(js);
  while (c) { creados.add(c[1]); c = reCreado.exec(js); }

  const buscados = new Set();
  const reBuscado = /\$\('([a-z0-9-]+)'\)/g;
  let m = reBuscado.exec(js);
  while (m) { buscados.add(m[1]); m = reBuscado.exec(js); }

  return [...buscados].filter((id) => doc.getElementById(id) === null && !creados.has(id));
}

describe('manager.html tiene lo que su controlador busca', () => {
  const NECESARIOS = [
    'cut-sheet', 'cut-night', 'cut-body', 'cut-note', 'cut-frozen', 'cut-error',
    'btn-cut-close', 'btn-cut-save',
    'compare-box', 'compare-a', 'compare-b', 'compare-result',
    'roster-sheet', 'roster-night', 'roster-progress', 'roster-body', 'roster-error',
    'btn-roster-close',
    'pick-sheet', 'pick-backdrop', 'pick-where', 'pick-list', 'pick-empty', 'pick-close',
  ];

  it.each(NECESARIOS)('el id "%s" existe', (id) => {
    expect(documento(managerHtml).getElementById(id)).not.toBeNull();
  });

  it('las tres hojas nuevas nacen ocultas', () => {
    const doc = documento(managerHtml);
    for (const id of ['cut-sheet', 'roster-sheet', 'pick-sheet', 'pick-backdrop', 'compare-box']) {
      expect(doc.getElementById(id).hidden).toBe(true);
    }
  });

  it('el controlador del gerente no busca ningún id que no exista', () => {
    expect(idsPerdidos(managerHtml, managerJs)).toEqual([]);
  });

  it('carga night-report.js y roster.js antes del controlador', () => {
    const report = managerHtml.indexOf('js/night-report.js');
    const roster = managerHtml.indexOf('js/roster.js');
    const screen = managerHtml.indexOf('js/manager-screen.js');
    expect(report).toBeGreaterThan(-1);
    expect(report).toBeLessThan(screen);
    expect(roster).toBeLessThan(screen);
  });
});

describe('el portal del empleado enseña su lugar', () => {
  it('el id existe y nace oculto', () => {
    const doc = documento(portalHtml);
    const el = doc.getElementById('mine-spot');
    expect(el).not.toBeNull();
    // No todos los puestos se acomodan por noche: una raya permanente sería ruido.
    expect(el.hidden).toBe(true);
  });

  it('el lugar va ANTES del botón de abrir turno', () => {
    // Es lo que la persona necesita saber al llegar: teclear su zona de memoria es
    // como alguien acaba cobrando las propinas de otra sección.
    expect(portalHtml.indexOf('id="mine-spot"'))
      .toBeLessThan(portalHtml.indexOf('id="btn-shift"'));
  });

  it('carga roster.js antes del controlador', () => {
    expect(portalHtml.indexOf('js/roster.js'))
      .toBeLessThan(portalHtml.indexOf('js/employee-screen.js'));
  });

  it('el controlador del portal no busca ningún id que no exista', () => {
    expect(idsPerdidos(portalHtml, portalJs)).toEqual([]);
  });
});

// ===========================================================================
// Textos
// ===========================================================================

describe('los textos nuevos están en los dos idiomas', () => {
  const CLAVES = [
    'cut.open', 'cut.title', 'cut.revenue', 'cut.attendance', 'cut.occupancy',
    'cut.perPerson', 'cut.watch', 'cut.money', 'cut.total', 'cut.tipsApart',
    'cut.reservations', 'cut.noShow', 'cut.zones', 'cut.byCategory', 'cut.byBar',
    'cut.staff', 'cut.close', 'cut.closed', 'cut.confirmClose', 'cut.alreadyClosed',
    'cut.compare', 'cut.notComparable',
    'roster.open', 'roster.title', 'roster.pick', 'roster.remove', 'roster.here',
    'roster.notHere', 'roster.nobody', 'roster.complete', 'roster.missing',
    'roster.noCandidates', 'roster.assignNote',
    'mine.title', 'mine.none', 'mine.assigned',
    'manager.loading', 'manager.close',
  ];

  it.each(CLAVES)('la clave "%s" está en los dos idiomas', (clave) => {
    for (const idioma of ['es', 'en']) {
      catalogo.setLanguage(idioma);
      expect(catalogo.t(clave)).not.toBe(clave);
    }
    catalogo.setLanguage('es');
  });

  it('cada aviso del corte tiene su frase', () => {
    const avisos = R.flags(STATS);
    expect(avisos.length).toBeGreaterThan(2);
    for (const aviso of avisos) {
      for (const idioma of ['es', 'en']) {
        catalogo.setLanguage(idioma);
        const clave = `cut.flag.${aviso.key === 'no_show' ? 'noShow'
          : aviso.key === 'cold_zone' ? 'coldZone'
            : aviso.key === 'cancelled_orders' ? 'cancelled'
              : aviso.key === 'missing_staff' ? 'missingStaff' : 'shrinkage'}`;
        expect(catalogo.t(clave)).not.toBe(clave);
      }
    }
    catalogo.setLanguage('es');
  });

  it('cada motivo de "no se puede cerrar" tiene su frase', () => {
    for (const motivo of ['not_started', 'already_closed', 'no_stats']) {
      for (const idioma of ['es', 'en']) {
        catalogo.setLanguage(idioma);
        expect(catalogo.t(`cut.cannot.${motivo}`)).not.toBe(`cut.cannot.${motivo}`);
      }
    }
    catalogo.setLanguage('es');
  });

  it('cada código del validador del rol tiene su frase', () => {
    for (const codigo of ['inactive', 'already_there', 'only_one_bar', 'role_not_assignable',
      'need_section', 'need_bar', 'waiter_needs_zone', 'bartender_needs_bar', 'generic']) {
      for (const idioma of ['es', 'en']) {
        catalogo.setLanguage(idioma);
        expect(catalogo.t(`roster.err.${codigo}`)).not.toBe(`roster.err.${codigo}`);
      }
    }
    catalogo.setLanguage('es');
  });
});

// ===========================================================================
// El porcentaje sin denominador
// ===========================================================================

describe('EV2NightReport.pct', () => {
  it('calcula lo normal', () => {
    expect(R.pct(2, 4)).toBe(50);
    expect(R.pct(1, 3)).toBe(33);
  });

  it('sin denominador devuelve null, NO cero', () => {
    // Una noche sin reservaciones no tuvo 0% de no-shows: no tuvo el dato, y un 0
    // lo convertiría en un resultado bueno.
    expect(R.pct(0, 0)).toBeNull();
    expect(R.pct(5, null)).toBeNull();
    expect(R.pct(5, undefined)).toBeNull();
  });
});

// ===========================================================================
// Las cuatro cifras de arriba
// ===========================================================================

describe('EV2NightReport.headline', () => {
  it('son cuatro y en orden', () => {
    const h = R.headline(STATS);
    expect(h).toEqual({
      revenue: 9500, attendance: 28, occupancy: 40, per_person: 339.29, currency: 'MXN',
    });
  });

  it('sin corte no revienta', () => {
    expect(R.headline(null)).toBeNull();
  });

  it('un corte vacío da ceros', () => {
    const h = R.headline({ revenue: {}, attendance: {}, tables: {} });
    expect(h).toMatchObject({ revenue: 0, attendance: 0, occupancy: 0, per_person: 0 });
  });
});

// ===========================================================================
// Los avisos
// ===========================================================================

describe('EV2NightReport.flags', () => {
  it('avisa de los no-show con su porcentaje', () => {
    const noShow = R.flags(STATS).find((f) => f.key === 'no_show');
    expect(noShow).toMatchObject({ count: 2, pct: 50, tone: 'warn' });
  });

  it('avisa de la zona que no se llenó a la mitad', () => {
    const fria = R.flags(STATS).find((f) => f.key === 'cold_zone');
    // Solo se nota comparándola con las demás, y es un precio mal puesto o un
    // plano mal repartido.
    expect(fria).toMatchObject({ section: 'TERRAZA', occupancy: 0 });
  });

  it('la zona llena NO sale como fría', () => {
    const frias = R.flags(STATS).filter((f) => f.key === 'cold_zone');
    expect(frias.map((f) => f.section)).not.toContain('ZONA ROJA');
  });

  it('avisa de la merma y de los pedidos cancelados', () => {
    const avisos = R.flags(STATS);
    expect(avisos.find((f) => f.key === 'shrinkage')).toMatchObject({ value: 900, tone: 'bad' });
    expect(avisos.find((f) => f.key === 'cancelled_orders')).toMatchObject({ count: 1, value: 900 });
  });

  it('avisa de quién quedó en el rol y no llegó', () => {
    const falta = R.flags(STATS).find((f) => f.key === 'missing_staff');
    expect(falta).toMatchObject({ count: 1, assigned: 3 });
  });

  it('una noche limpia no tiene avisos', () => {
    const limpia = {
      reservations: { booked: 4, no_show: 0 },
      zones: [{ section: 'A', tables_total: 4, tables_used: 4, occupancy: 100 }],
      shrinkage: { value: 0 },
      bar: { cancelled: 0, cancelled_value: 0 },
      staff: { assigned: 2, showed_up: 2 },
    };
    expect(R.flags(limpia)).toEqual([]);
  });

  it('sin corte devuelve una lista vacía', () => {
    expect(R.flags(null)).toEqual([]);
  });
});

// ===========================================================================
// Zonas y categorías
// ===========================================================================

describe('las listas del corte', () => {
  it('las zonas salen por lo que dejaron, la más fría al final', () => {
    expect(R.zonesByRevenue(STATS).map((z) => z.section)).toEqual(['ZONA ROJA', 'TERRAZA']);
  });

  it('las categorías salen por venta, y se recortan', () => {
    expect(R.topCategories(STATS, 1).map((c) => c.category)).toEqual(['Whisky']);
  });

  it('sin nada vendido las listas vienen vacías, no con ceros inventados', () => {
    expect(R.topCategories({ bar: {} })).toEqual([]);
    expect(R.zonesByRevenue({})).toEqual([]);
  });
});

// ===========================================================================
// Comparar
// ===========================================================================

describe('EV2NightReport.compare', () => {
  it('saca la diferencia y el porcentaje', () => {
    const c = R.compare(cierre({ revenue_total: 9500 }), cierre({ revenue_total: 8000 }));
    expect(c.comparable).toBe(true);
    expect(c.diff.revenue_total).toMatchObject({ from: 8000, to: 9500, delta: 1500, pct: 19 });
  });

  it('una baja sale en negativo', () => {
    const c = R.compare(cierre({ attendance: 20 }), cierre({ attendance: 28 }));
    expect(c.diff.attendance).toMatchObject({ delta: -8, pct: -29 });
  });

  it('de cero a algo NO es infinito por ciento', () => {
    const c = R.compare(cierre({ revenue_total: 5000 }), cierre({ revenue_total: 0 }));
    // "De nada a cinco mil" se dice con null, no con un porcentaje imposible.
    expect(c.diff.revenue_total.delta).toBe(5000);
    expect(c.diff.revenue_total.pct).toBeNull();
  });

  it('NO compara monedas distintas', () => {
    const c = R.compare(cierre({ currency: 'USD' }), cierre({ currency: 'MXN' }));
    // Sumar pesos con dólares da una diferencia cuatro veces más grande de lo real.
    expect(c).toEqual({ comparable: false, reason: 'different_currency' });
  });

  it('sin dos noches no compara nada', () => {
    expect(R.compare(cierre(), null)).toBeNull();
    expect(R.compare(null, cierre())).toBeNull();
  });
});

// ===========================================================================
// Cerrar
// ===========================================================================

describe('EV2NightReport.canClose', () => {
  const yaAbrio = new Date('2026-09-12T02:00:00Z');

  it('una noche que ya abrió y no está cerrada se puede cerrar', () => {
    expect(R.canClose({ stats: STATS, closed: null, now: yaAbrio })).toEqual({ ok: true });
  });

  it('una noche ya cerrada no se cierra dos veces', () => {
    expect(R.canClose({ stats: STATS, closed: { id: 'c1' }, now: yaAbrio }))
      .toEqual({ ok: false, reason: 'already_closed' });
  });

  it('una noche que no empieza todavía no se puede cortar', () => {
    // Un corte de una noche que no ha pasado son ceros presentados como hechos.
    expect(R.canClose({ stats: STATS, closed: null, now: new Date('2026-09-11T10:00:00Z') }))
      .toEqual({ ok: false, reason: 'not_started' });
  });

  it('sin corte no hay nada que cerrar', () => {
    expect(R.canClose({ stats: null }).ok).toBe(false);
  });
});

// ===========================================================================
// El rol
// ===========================================================================

describe('EV2Roster.candidates', () => {
  const STAFF = [
    { id: 'w1', display_name: 'Ana', role: 'waiter', active: true },
    { id: 'b1', display_name: 'Beto', role: 'bartender', active: true },
    { id: 'w2', display_name: 'Caro', role: 'waiter', active: false },
    { id: 'a1', display_name: 'Almacén', role: 'warehouse', active: true },
    { id: 'd1', display_name: 'DJ', role: 'dj', active: true },
  ];

  it('solo la gente cuyo puesto se acomoda por noche', () => {
    const ids = Roster.candidates(STAFF).map((p) => p.id);
    expect(ids).toContain('w1');
    expect(ids).toContain('b1');
    // El almacén tiene su lugar y el DJ su cabina: no se reparten por zonas.
    expect(ids).not.toContain('a1');
    expect(ids).not.toContain('d1');
  });

  it('los dados de baja no salen', () => {
    // Un inactivo en el rol es una mesa que nadie va a atender, y el gerente no se
    // enteraría hasta que un cliente se quejara.
    expect(Roster.candidates(STAFF).map((p) => p.id)).not.toContain('w2');
  });

  it('una lista vacía no revienta', () => {
    expect(Roster.candidates(null)).toEqual([]);
  });
});

describe('EV2Roster.check', () => {
  const ana = { id: 'w1', display_name: 'Ana', role: 'waiter', active: true };
  const beto = { id: 'b1', display_name: 'Beto', role: 'bartender', active: true };

  it('un mesero en una zona vacía está bien', () => {
    expect(Roster.check({ person: ana, section: 'ZONA ROJA', roster: [] })).toBeNull();
  });

  it('un mesero en una barra se rechaza', () => {
    expect(Roster.check({ person: ana, locationId: 'bar1', roster: [] }))
      .toMatchObject({ code: 'waiter_needs_zone' });
  });

  it('un bartender en una zona se rechaza', () => {
    expect(Roster.check({ person: beto, section: 'ZONA ROJA', roster: [] }))
      .toMatchObject({ code: 'bartender_needs_bar' });
  });

  it('el mesero puede cubrir una SEGUNDA zona', () => {
    const roster = [{ user_id: 'w1', targets: [{ section: 'ZONA ROJA' }] }];
    expect(Roster.check({ person: ana, section: 'TERRAZA', roster })).toBeNull();
  });

  it('la misma zona otra vez se avisa', () => {
    const roster = [{ user_id: 'w1', targets: [{ section: 'ZONA ROJA' }] }];
    expect(Roster.check({ person: ana, section: 'ZONA ROJA', roster }))
      .toMatchObject({ code: 'already_there', name: 'Ana' });
  });

  it('el bartender NO puede ir a una segunda barra, y dice en cuál está', () => {
    const roster = [{
      user_id: 'b1',
      targets: [{ location_id: 'bar1', location_name: 'Barra planta baja' }],
    }];
    const problema = Roster.check({ person: beto, locationId: 'bar2', roster });
    expect(problema).toMatchObject({ code: 'only_one_bar', current: 'Barra planta baja' });
  });

  it('un puesto que no se asigna se rechaza', () => {
    expect(Roster.check({ person: { id: 'a', role: 'warehouse' }, section: 'A' }))
      .toMatchObject({ code: 'role_not_assignable' });
  });

  it('un inactivo se rechaza', () => {
    expect(Roster.check({ person: { ...ana, active: false }, section: 'A' }))
      .toMatchObject({ code: 'inactive' });
  });
});

describe('EV2Roster.byTarget', () => {
  it('agrupa por zona y por barra, y la zona vacía APARECE', () => {
    const vista = Roster.byTarget({
      roster: [{
        user_id: 'w1', display_name: 'Ana', role: 'waiter', on_shift: true,
        targets: [{ assignment_id: 'a1', section: 'ZONA ROJA' }],
      }],
      sections: ['TERRAZA'],
      bars: [{ location_id: 'bar1', name: 'Barra planta baja' }],
    });

    const roja = vista.sections.find((s) => s.section === 'ZONA ROJA');
    const terraza = vista.sections.find((s) => s.section === 'TERRAZA');
    expect(roja.people[0]).toMatchObject({ display_name: 'Ana', on_shift: true });
    // La zona sin nadie tiene que verse: es la mitad del valor de armar un rol.
    expect(terraza.people).toEqual([]);
    expect(vista.bars[0].people).toEqual([]);
  });
});

describe('EV2Roster.progress', () => {
  it('el rol está completo solo cuando nada quedó sin nadie', () => {
    expect(Roster.progress({
      roster: [{ user_id: 'w1', display_name: 'Ana', on_shift: true }],
      gaps: { sections: [], bars: [] },
    })).toMatchObject({ assigned: 1, on_shift: 1, complete: true });
  });

  it('con un hueco NO está completo', () => {
    const p = Roster.progress({
      roster: [{ user_id: 'w1', display_name: 'Ana', on_shift: false }],
      gaps: { sections: ['TERRAZA'], bars: [{ location_id: 'b' }] },
    });
    expect(p).toMatchObject({ complete: false, missing_sections: 1, missing_bars: 1 });
    expect(p.not_arrived).toEqual(['Ana']);
  });

  it('un rol vacío no revienta', () => {
    expect(Roster.progress({}).assigned).toBe(0);
  });
});

describe('EV2Roster.describeMine', () => {
  it('junta dos zonas con "y"', () => {
    const mio = Roster.describeMine([
      { section: 'ZONA ROJA', event_name: 'Viernes' },
      { section: 'TERRAZA', event_name: 'Viernes' },
    ]);
    // Lo lee una persona con prisa al llegar.
    expect(mio.text).toBe('ZONA ROJA y TERRAZA');
    expect(mio.event_name).toBe('Viernes');
  });

  it('en inglés junta con "and"', () => {
    const mio = Roster.describeMine([{ section: 'A' }, { section: 'B' }], { lang: 'en' });
    expect(mio.text).toBe('A and B');
  });

  it('una sola zona va sola', () => {
    expect(Roster.describeMine([{ section: 'TERRAZA' }]).text).toBe('TERRAZA');
  });

  it('la barra también cuenta como lugar', () => {
    expect(Roster.describeMine([{ location_name: 'Barra planta alta' }]).text)
      .toBe('Barra planta alta');
  });

  it('sin asignación devuelve null: la línea no se pinta', () => {
    expect(Roster.describeMine([])).toBeNull();
    expect(Roster.describeMine(null)).toBeNull();
  });
});

describe('EV2Roster.assignBody', () => {
  it('manda la zona o la barra, nunca las dos', () => {
    expect(Roster.assignBody({ userId: 'u1', section: 'ZONA ROJA' }))
      .toEqual({ user_id: 'u1', section: 'ZONA ROJA' });
    expect(Roster.assignBody({ userId: 'u1', locationId: 'bar1' }))
      .toEqual({ user_id: 'u1', location_id: 'bar1' });
  });

  it('la nota solo si la hay', () => {
    expect(Roster.assignBody({ userId: 'u1', section: 'A', note: '  ' }).note).toBeUndefined();
    expect(Roster.assignBody({ userId: 'u1', section: 'A', note: 'Cubre el hueco' }).note)
      .toBe('Cubre el hueco');
  });
});

// ===========================================================================
// Las reglas coinciden con el servidor
// ===========================================================================

describe('el cliente y el servidor dicen lo mismo', () => {
  it('los puestos asignables son los mismos', () => {
    const servidor = require('../src/services/assignments');
    expect(Roster.ASSIGNABLE_ROLES.sort()).toEqual(servidor.ASSIGNABLE_ROLES.sort());
  });

  it('y las reglas de cada puesto también', () => {
    const servidor = require('../src/services/assignments');
    for (const role of servidor.ASSIGNABLE_ROLES) {
      // Si se separan, el gerente ve un botón que el servidor va a rechazar.
      expect(Roster.ruleFor(role)).toEqual(servidor.ruleFor(role));
    }
  });
});
