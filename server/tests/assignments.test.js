/**
 * El rol de la noche: quién atiende qué.
 *
 * Lo que se prueba aquí son las reglas que, si se rompen, dejan una zona sin
 * nadie o una propina en el bolsillo equivocado:
 *
 *   1. **Asignar NO abre el turno.** Son dos tablas distintas a propósito: si
 *      asignar abriera el turno, el sistema diría que alguien está trabajando
 *      cuando todavía viene en camino, y se pierde la única forma de ver quién no
 *      llegó.
 *   2. **Un mesero cubre varias zonas; un bartender, una sola barra.** Nadie
 *      atiende dos barras a la vez, y decir que sí es cómo se acaba esperando un
 *      trago que nadie está preparando.
 *   3. **Lo que queda SIN nadie es la mitad del valor del rol.** Una zona sin
 *      mesero no se nota mirando quién está asignado: se nota mirando lo que
 *      falta.
 *   4. **Solo gerencia asigna.** Quién atiende qué zona decide las propinas de la
 *      noche.
 */
'use strict';

const { setupSchema, truncateAll, closePool, pool } = require('./helpers/db');
const { api, auth } = require('./helpers/api');
const f = require('./helpers/factories');
const assignments = require('../src/services/assignments');

let club;
let manager;
let waiter;
let bartender;
let barBaja;
let barAlta;
let night;

beforeAll(async () => {
  await setupSchema();
});
beforeEach(async () => {
  await truncateAll();
  club = await f.createNightclub({ slug: 'ev2-roster' });
  barBaja = club.locations['barra-baja'];
  barAlta = club.locations['barra-alta'];
  manager = await f.createUser(club.id, { role: 'manager' });
  waiter = await f.createUser(club.id, { role: 'waiter' });
  bartender = await f.createUser(club.id, { role: 'bartender' });
  await f.createTable(club.id, { code: '10', section: 'ZONA ROJA' });
  await f.createTable(club.id, { code: '11', section: 'TERRAZA' });
  night = await crearNoche();
});
afterAll(closePool);

const url = (p) => `/api/nightclubs/${club.id}${p}`;

/** Una noche. El club admite UNA por fecha, asi que cada noche extra corre su dia. */
let diaNoche = 0;
async function crearNoche(over = {}) {
  const dia = new Date(Date.now() + (diaNoche += 1) * 86_400_000);
  const res = await api().post(url('/events')).set(auth(manager)).send({
    name: `Noche ${Math.random().toString(16).slice(2, 8)}`,
    event_date: dia.toISOString().slice(0, 10),
    doors_open_at: new Date(Date.now() + 15 * 60_000).toISOString(),
    closes_at: new Date(Date.now() + 8 * 3_600_000).toISOString(),
    ticket_price: 100,
    status: 'published',
    ...over,
  });
  expect(res.status).toBe(201);
  return res.body.event;
}

const asignar = (body, quien = manager) => api()
  .post(url(`/nights/${night.id}/roster`)).set(auth(quien)).send(body);

const roster = (quien = manager) => api().get(url(`/nights/${night.id}/roster`)).set(auth(quien));

// ===========================================================================
// Las reglas, sin base de datos
// ===========================================================================

describe('qué se le asigna a cada puesto', () => {
  it('el mesero y la hostess atienden zonas, y pueden cubrir varias', () => {
    expect(assignments.ruleFor('waiter')).toEqual({ target: 'section', multi: true });
    expect(assignments.ruleFor('hostess')).toEqual({ target: 'section', multi: true });
  });

  it('el bartender está en UNA barra', () => {
    expect(assignments.ruleFor('bartender')).toEqual({ target: 'location', multi: false });
  });

  it('los puestos que no atienden piso no se asignan por noche', () => {
    // El almacén tiene su lugar y no cambia cada noche. Inventarle un destino
    // sería llenar el rol de filas que nadie sabe leer.
    for (const puesto of ['warehouse', 'manager', 'admin', 'guest', 'driver']) {
      expect(assignments.ruleFor(puesto)).toBeNull();
    }
  });
});

// ===========================================================================
// Asignar
// ===========================================================================

describe('POST /nights/:id/roster', () => {
  it('pone a un mesero en una zona', async () => {
    const res = await asignar({ user_id: waiter.id, section: 'ZONA ROJA' });

    expect(res.status).toBe(201);
    expect(res.body.assignment_id).toEqual(expect.any(String));
    const persona = res.body.roster.find((p) => p.user_id === waiter.id);
    expect(persona.targets.map((t) => t.section)).toEqual(['ZONA ROJA']);
  });

  it('un mesero puede cubrir DOS zonas la misma noche', async () => {
    await asignar({ user_id: waiter.id, section: 'ZONA ROJA' });
    const res = await asignar({ user_id: waiter.id, section: 'TERRAZA' });

    expect(res.status).toBe(201);
    const persona = res.body.roster.find((p) => p.user_id === waiter.id);
    // Es como trabaja un mesero de verdad; una zona por persona obligaría a
    // reasignar a media noche.
    expect(persona.targets.map((t) => t.section).sort()).toEqual(['TERRAZA', 'ZONA ROJA']);
    expect(res.body.roster).toHaveLength(1);
  });

  it('la misma zona dos veces no duplica a la persona', async () => {
    await asignar({ user_id: waiter.id, section: 'ZONA ROJA' });
    const otra = await asignar({ user_id: waiter.id, section: 'ZONA ROJA' });

    // Seguramente tocó dos veces: no vale la pena interrumpirlo, pero tampoco
    // puede quedar contado dos veces en el rol.
    expect(otra.status).toBe(200);
    expect(otra.body.already).toBe(true);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM shift_assignments');
    expect(rows[0].n).toBe(1);
  });

  it('pone a un bartender en una barra', async () => {
    const res = await asignar({ user_id: bartender.id, location_id: barBaja });
    expect(res.status).toBe(201);
    const persona = res.body.roster.find((p) => p.user_id === bartender.id);
    expect(persona.targets[0].location_name).toBe('Barra planta baja');
  });

  it('un bartender NO puede quedar en las dos barras', async () => {
    await asignar({ user_id: bartender.id, location_id: barBaja });
    const res = await asignar({ user_id: bartender.id, location_id: barAlta });

    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/dos barras/i);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM shift_assignments');
    expect(rows[0].n).toBe(1);
  });

  it('un mesero no se asigna a una barra, ni un bartender a una zona', async () => {
    const meseroEnBarra = await asignar({ user_id: waiter.id, location_id: barBaja });
    expect(meseroEnBarra.status).toBe(400);

    const barmanEnZona = await asignar({ user_id: bartender.id, section: 'ZONA ROJA' });
    expect(barmanEnZona.status).toBe(400);

    const { rows } = await pool.query('SELECT count(*)::int AS n FROM shift_assignments');
    expect(rows[0].n).toBe(0);
  });

  it('una zona que no existe en el plano se rechaza, y dice cuáles hay', async () => {
    const res = await asignar({ user_id: waiter.id, section: 'TERRAZA VIP' });

    expect(res.status).toBe(422);
    // Asignar a alguien a un lugar que no existe deja el rol viéndose completo
    // mientras una zona real queda sin nadie.
    expect(res.body.error.details.sections.sort()).toEqual(['TERRAZA', 'ZONA ROJA']);
  });

  it('un empleado dado de baja no se puede poner en el rol', async () => {
    // La baja del EMPLEADO vive en su ficha, no en la cuenta.
    await pool.query(
      `INSERT INTO employee_profiles (user_id, active) VALUES ($1,false)
       ON CONFLICT (user_id) DO UPDATE SET active = false`,
      [waiter.id]);
    const res = await asignar({ user_id: waiter.id, section: 'ZONA ROJA' });

    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/baja/i);
  });

  it('una cuenta bloqueada tampoco entra al rol', async () => {
    await pool.query(`UPDATE users SET status = 'blocked' WHERE id = $1`, [waiter.id]);
    const res = await asignar({ user_id: waiter.id, section: 'ZONA ROJA' });
    expect(res.status).toBe(422);
  });

  it('alguien sin ficha de empleado SI se puede asignar', async () => {
    // Sin ficha no esta dado de baja: simplemente no tiene ficha, y tratarlo como
    // baja dejaria fuera del rol a gente que si trabaja.
    const { rows } = await pool.query(
      'SELECT count(*)::int AS n FROM employee_profiles WHERE user_id = $1', [waiter.id]);
    expect(rows[0].n).toBe(0);
    expect((await asignar({ user_id: waiter.id, section: 'ZONA ROJA' })).status).toBe(201);
  });

  it('un puesto que no atiende piso se rechaza con la lista de los que sí', async () => {
    const almacen = await f.createUser(club.id, { role: 'warehouse' });
    const res = await asignar({ user_id: almacen.id, section: 'ZONA ROJA' });

    expect(res.status).toBe(422);
    expect(res.body.error.details.assignable).toEqual(assignments.ASSIGNABLE_ROLES);
  });

  it('alguien de otro club no entra en este rol', async () => {
    const otro = await f.createNightclub({ slug: 'otro-roster', name: 'Otro' });
    const ajeno = await f.createUser(otro.id, { role: 'waiter' });
    const res = await asignar({ user_id: ajeno.id, section: 'ZONA ROJA' });
    expect(res.status).toBe(404);
  });

  it('una noche de otro club no se puede armar desde aquí', async () => {
    const otro = await f.createNightclub({ slug: 'otro-roster-2', name: 'Otro 2' });
    const ajena = await pool.query(
      `INSERT INTO events_calendar (nightclub_id, name, event_date, doors_open_at, ticket_price)
       VALUES ($1,'Ajena',CURRENT_DATE,now(),100) RETURNING id`, [otro.id]);

    const res = await api().post(url(`/nights/${ajena.rows[0].id}/roster`)).set(auth(manager))
      .send({ user_id: waiter.id, section: 'ZONA ROJA' });
    expect(res.status).toBe(404);
  });
});

// ===========================================================================
// Asignar no es abrir el turno
// ===========================================================================

describe('asignado no es presente', () => {
  it('asignar NO abre el turno', async () => {
    await asignar({ user_id: waiter.id, section: 'ZONA ROJA' });

    const { rows } = await pool.query('SELECT count(*)::int AS n FROM staff_shifts');
    expect(rows[0].n).toBe(0);

    const lista = await roster();
    expect(lista.body.on_shift).toBe(0);
    expect(lista.body.roster[0].on_shift).toBe(false);
  });

  it('cuando el empleado marca entrada, el rol lo refleja', async () => {
    await asignar({ user_id: waiter.id, section: 'ZONA ROJA' });
    const entrada = await api().post(url('/staff/shifts/start')).set(auth(waiter)).send({});
    expect(entrada.status).toBe(201);

    const lista = await roster();
    expect(lista.body.on_shift).toBe(1);
    expect(lista.body.roster[0].on_shift).toBe(true);
    expect(lista.body.roster[0].started_at).toBeTruthy();
  });

  it('quien marcó entrada sin estar asignado no aparece en el rol', async () => {
    // El rol es lo que el gerente planeó. Quien llegó por su cuenta se ve en la
    // pestaña de personal, no aquí.
    await api().post(url('/staff/shifts/start')).set(auth(waiter)).send({});
    const lista = await roster();
    expect(lista.body.roster).toHaveLength(0);
  });
});

// ===========================================================================
// Lo que queda sin nadie
// ===========================================================================

describe('los huecos del rol', () => {
  it('con el rol vacío, todas las zonas y barras están sin nadie', async () => {
    const lista = await roster();
    expect(lista.body.gaps.sections.sort()).toEqual(['TERRAZA', 'ZONA ROJA']);
    expect(lista.body.gaps.bars).toHaveLength(2);
  });

  it('la zona que ya tiene mesero deja de ser hueco', async () => {
    await asignar({ user_id: waiter.id, section: 'ZONA ROJA' });
    const lista = await roster();
    expect(lista.body.gaps.sections).toEqual(['TERRAZA']);
  });

  it('la barra que ya tiene bartender deja de ser hueco', async () => {
    await asignar({ user_id: bartender.id, location_id: barBaja });
    const lista = await roster();
    expect(lista.body.gaps.bars.map((b) => b.name)).toEqual(['Barra planta alta']);
  });

  it('el rol completo no deja huecos', async () => {
    const otroMesero = await f.createUser(club.id, { role: 'waiter' });
    const otroBarman = await f.createUser(club.id, { role: 'bartender' });
    await asignar({ user_id: waiter.id, section: 'ZONA ROJA' });
    await asignar({ user_id: otroMesero.id, section: 'TERRAZA' });
    await asignar({ user_id: bartender.id, location_id: barBaja });
    await asignar({ user_id: otroBarman.id, location_id: barAlta });

    const lista = await roster();
    expect(lista.body.gaps).toEqual({ sections: [], bars: [] });
    expect(lista.body.assigned).toBe(4);
  });
});

// ===========================================================================
// Quitar
// ===========================================================================

describe('DELETE /roster/:id', () => {
  it('quita un destino y deja los otros', async () => {
    await asignar({ user_id: waiter.id, section: 'ZONA ROJA' });
    const segunda = await asignar({ user_id: waiter.id, section: 'TERRAZA' });
    const aQuitar = segunda.body.roster[0].targets
      .find((t) => t.section === 'TERRAZA').assignment_id;

    const res = await api().delete(url(`/roster/${aQuitar}`)).set(auth(manager));
    expect(res.status).toBe(204);

    const lista = await roster();
    expect(lista.body.roster[0].targets.map((t) => t.section)).toEqual(['ZONA ROJA']);
  });

  it('una asignación que no existe es 404', async () => {
    const res = await api().delete(url('/roster/11111111-1111-1111-1111-111111111111'))
      .set(auth(manager));
    expect(res.status).toBe(404);
  });

  it('quitar del rol NO cierra el turno de quien ya llegó', async () => {
    const puesta = await asignar({ user_id: waiter.id, section: 'ZONA ROJA' });
    await api().post(url('/staff/shifts/start')).set(auth(waiter)).send({});
    await api().delete(url(`/roster/${puesta.body.assignment_id}`)).set(auth(manager));

    // Lo que ya trabajó esa noche no se borra porque se corrija el rol.
    const { rows } = await pool.query(
      'SELECT count(*)::int AS n FROM staff_shifts WHERE ended_at IS NULL');
    expect(rows[0].n).toBe(1);
  });
});

// ===========================================================================
// Permisos
// ===========================================================================

describe('quién puede armar el rol', () => {
  it('el mesero no se asigna a sí mismo', async () => {
    const res = await asignar({ user_id: waiter.id, section: 'ZONA ROJA' }, waiter);
    expect(res.status).toBe(403);
  });

  it('el bartender tampoco', async () => {
    const res = await asignar({ user_id: bartender.id, location_id: barBaja }, bartender);
    expect(res.status).toBe(403);
  });

  it('el piso no ve el rol completo', async () => {
    expect((await roster(waiter)).status).toBe(403);
  });

  it('el cliente no ve nada de esto', async () => {
    const invitado = await f.createUser(club.id, { role: 'guest' });
    expect((await roster(invitado)).status).toBe(403);
  });
});

// ===========================================================================
// Lo que ve el empleado
// ===========================================================================

describe('GET /roster/mine', () => {
  it('el mesero ve a qué zonas quedó asignado', async () => {
    await asignar({ user_id: waiter.id, section: 'ZONA ROJA' });
    await asignar({ user_id: waiter.id, section: 'TERRAZA' });

    const res = await api().get(url('/roster/mine')).set(auth(waiter));
    expect(res.status).toBe(200);
    expect(res.body.assignments.map((a) => a.section).sort())
      .toEqual(['TERRAZA', 'ZONA ROJA']);
    expect(res.body.assignments[0].event_name).toBe(night.name);
  });

  it('el bartender ve su barra', async () => {
    await asignar({ user_id: bartender.id, location_id: barBaja });
    const res = await api().get(url('/roster/mine')).set(auth(bartender));
    expect(res.body.assignments[0].location_name).toBe('Barra planta baja');
  });

  it('solo ve LO SUYO, no el rol de los demás', async () => {
    await asignar({ user_id: waiter.id, section: 'ZONA ROJA' });
    await asignar({ user_id: bartender.id, location_id: barBaja });

    const res = await api().get(url('/roster/mine')).set(auth(bartender));
    expect(res.body.assignments).toHaveLength(1);
    expect(res.body.assignments[0].section).toBeNull();
  });

  it('sin asignación devuelve una lista vacía, no un error', async () => {
    const res = await api().get(url('/roster/mine')).set(auth(waiter));
    expect(res.status).toBe(200);
    expect(res.body.assignments).toEqual([]);
  });

  it('se puede pedir solo lo de una noche', async () => {
    const otraNoche = await crearNoche({ name: 'Otra noche' });
    await asignar({ user_id: waiter.id, section: 'ZONA ROJA' });
    await api().post(url(`/nights/${otraNoche.id}/roster`)).set(auth(manager))
      .send({ user_id: waiter.id, section: 'TERRAZA' });

    const res = await api().get(url('/roster/mine')).query({ event_id: otraNoche.id })
      .set(auth(waiter));
    expect(res.body.assignments).toHaveLength(1);
    expect(res.body.assignments[0].section).toBe('TERRAZA');
  });
});

// ===========================================================================
// El puesto congelado
// ===========================================================================

describe('el puesto se congela al asignar', () => {
  it('si la persona cambia de puesto, el rol de esa noche no cambia pero lo avisa', async () => {
    await asignar({ user_id: waiter.id, section: 'ZONA ROJA' });
    await pool.query('UPDATE users SET role = $2 WHERE id = $1', [waiter.id, 'hostess']);

    const lista = await roster();
    const persona = lista.body.roster[0];
    // El rol de aquella noche dice lo que dijo: era mesero.
    expect(persona.role).toBe('waiter');
    expect(persona.current_role).toBe('hostess');
    expect(persona.role_changed).toBe(true);
  });
});
