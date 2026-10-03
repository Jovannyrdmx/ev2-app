/**
 * Lo que un cliente alcanza de OTRA persona (auditoría del 28/09/2026).
 *
 * ---------------------------------------------------------------------------
 * Qué se está probando y por qué importa
 * ---------------------------------------------------------------------------
 * El módulo de flirteo (`routes/flirts.js`) está construido con cuidado: para
 * mandarle algo a alguien hay que estar sentado, que la otra persona tenga el
 * consentimiento prendido (`accept_flirts`), que sea mayor de edad, que no haya
 * bloqueo en ninguna dirección, y hay topes por hora y por noche. Es la pieza que
 * protege a una clienta de que un desconocido la contacte toda la noche.
 *
 * El problema es que `POST /orders` llega al MISMO efecto —un trago con mensaje de
 * 280 caracteres que le llega a una persona concreta— por otro camino, y ese camino
 * no comprueba casi nada. Y `GET /tables` reparte el nombre y el identificador de
 * todo el que esté sentado a cualquiera que pregunte, que es de donde salen los
 * identificadores que hacen falta para usarlo.
 *
 * Estas pruebas nacieron documentando los defectos (auditoría del 28/09) y se
 * invirtieron al arreglarlos (D65). Siguen aquí, y con el mismo detalle, porque un
 * hueco de consentimiento no se cierra una vez: se cierra y **se queda vigilado**. La
 * forma de que vuelva es que alguien agregue una tercera ruta que alcance a una
 * persona sin pasar por `services/consent.js`.
 *
 * Por eso cada prueba afirma las dos mitades: que el camino del pedido rechaza, Y que
 * el del flirteo rechaza igual. Si un día se separan, la que falle dice cuál.
 */
'use strict';

const { randomUUID } = require('crypto');
const { setupSchema, truncateAll, closePool, pool } = require('./helpers/db');
const { api, auth } = require('./helpers/api');
const f = require('./helpers/factories');

let club; let mesa; let trago;
let ana; let beto; let bailarina; let mesero;

beforeAll(setupSchema);
afterAll(closePool);

beforeEach(async () => {
  await truncateAll();
  club = await f.createNightclub({ slug: 'ev2-consent' });
  mesa = await f.createTable(club.id, { code: 'T-1', section: 'ZONA ROJA', capacity: 6 });
  trago = await f.createDrink(club.id, { name: 'Cerveza', price: 60, stock: 80 });

  // Ana NO quiere que la contacten: apagó el consentimiento. Es el caso entero.
  ana = await f.createUser(club.id, { role: 'guest', display_name: 'Ana', accept_flirts: false });
  beto = await f.createUser(club.id, { role: 'guest', display_name: 'Beto', accept_flirts: true });
  bailarina = await f.createUser(club.id, { role: 'dancer', display_name: 'Sol' });
  mesero = await f.createUser(club.id, { role: 'waiter', display_name: 'Luis' });
});

const url = (p) => `/api/nightclubs/${club.id}${p}`;

const sentar = (userId) => pool.query(
  'INSERT INTO table_occupants (table_id, user_id) VALUES ($1,$2)', [mesa.id, userId]);

/** Un pedido con destinatario: el camino que no comprueba nada. */
const regalar = (de, paraId, mensaje) => api().post(url('/orders')).set(auth(de)).send({
  client_request_id: randomUUID(),
  table_id: mesa.id,
  items: [{ drink_id: trago.id, quantity: 1 }],
  recipient_id: paraId,
  ...(mensaje ? { message: mensaje } : {}),
});

// ============================================================================

describe('El consentimiento del flirteo se puede rodear por POST /orders', () => {
  it('a quien apagó el consentimiento NO se le manda nada, ni por pedido', async () => {
    // Éste es el defecto que se arregló. Una persona que dijo "no quiero que me
    // contacten" recibía mensajes de 280 caracteres, uno por trago, sin límite.
    await sentar(beto.id);
    await sentar(ana.id);

    const res = await regalar(beto, ana.id, 'Hola, te invito algo');
    expect(res.status).toBe(403);
    expect(res.body.error.message).toMatch(/no acepta/i);

    // Y no quedó nada escrito: el pedido no existe a medias.
    const { rows } = await pool.query(
      'SELECT count(*)::int AS n FROM drink_orders WHERE recipient_id = $1', [ana.id]);
    expect(rows[0].n).toBe(0);
  });

  it('con el consentimiento prendido SÍ se puede, que es el punto', async () => {
    // El arreglo no puede ser "prohibir todo": Beto sí acepta, y a Beto sí se le
    // puede invitar. Sin esta prueba, cerrar la puerta a cal y canto también pasaría.
    const carla = await f.createUser(club.id, {
      role: 'guest', display_name: 'Carla', accept_flirts: true,
    });
    await sentar(carla.id);
    await sentar(beto.id);

    const res = await regalar(carla, beto.id, 'Salud');
    expect(res.status).toBe(201);
    const { rows } = await pool.query(
      'SELECT recipient_id::text AS recipient_id, message FROM drink_orders WHERE id = $1',
      [res.body.order.id]);
    expect(rows[0].recipient_id).toBe(beto.id);
    expect(rows[0].message).toBe('Salud');
  });

  it('el camino del flirteo SÍ lo rechaza — o sea que la regla existe y se rodea', async () => {
    // Esta es la prueba que le da peso a la anterior. Si esto pasara, no habría
    // defecto: habría una decisión de producto de no pedir consentimiento.
    await sentar(beto.id);
    await sentar(ana.id);
    const res = await api().post(url('/flirts')).set(auth(beto)).send({
      recipient_id: ana.id, kind: 'drink', drink_id: trago.id,
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('hay que estar sentado para mandar, igual que en el flirteo', async () => {
    // Estar sentado es lo que ata a una persona a una mesa y a una noche. Sin eso,
    // alguien puede mandar desde la calle.
    const carla = await f.createUser(club.id, {
      role: 'guest', display_name: 'Carla', accept_flirts: true,
    });
    await sentar(carla.id); // la destinataria sí está
    const res = await regalar(beto, carla.id, 'Desde la barra'); // Beto no
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/sentado/i);
  });

  it('y la otra persona también tiene que estar en el club', async () => {
    const carla = await f.createUser(club.id, {
      role: 'guest', display_name: 'Carla', accept_flirts: true,
    });
    await sentar(beto.id); // solo Beto
    const res = await regalar(beto, carla.id, 'Hola');
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/ya no está en el club/i);
  });

  it('el bloqueo se respeta en las DOS direcciones', async () => {
    // Antes solo se miraba una dirección. Quien fue bloqueado tampoco debe poder
    // seguir mandando, y el mensaje es el neutro: no confirma que lo bloquearon.
    const carla = await f.createUser(club.id, {
      role: 'guest', display_name: 'Carla', accept_flirts: true,
    });
    await sentar(beto.id);
    await sentar(carla.id);
    await pool.query('INSERT INTO user_blocks (blocker_id, blocked_id) VALUES ($1,$2)',
      [beto.id, carla.id]); // BETO bloqueó a Carla, y Beto es quien manda
    const res = await regalar(beto, carla.id, 'Otra vez');
    expect(res.status).toBe(404);
    expect(res.body.error.message).toMatch(/no está disponible/i);
  });
});

describe('Las protecciones de "invitarle un trago al personal" también se rodean', () => {
  it('al personal no se le llega por el camino del pedido: se manda a su puerta', async () => {
    // Antes esto pasaba y dejaba a la persona SIN forma de rechazar el trago: no se
    // creaba la fila de `staff_drinks`, que es donde vive el botón de rechazar.
    //
    // El error no es un "no puedes" seco: dice dónde está el botón correcto, porque
    // quien lo lee está en el club queriendo invitar algo, no atacando nada.
    await sentar(beto.id);
    const res = await regalar(beto, bailarina.id, 'Para ti');
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/personal/i);

    const { rows } = await pool.query(
      'SELECT count(*)::int AS n FROM drink_orders WHERE recipient_id = $1', [bailarina.id]);
    expect(rows[0].n).toBe(0);
  });

  it('el camino del personal SÍ lo rechaza fuera de turno', async () => {
    await sentar(beto.id);
    const res = await api().post(url(`/staff/${bailarina.id}/drinks`)).set(auth(beto)).send({
      drink_id: trago.id, quantity: 1,
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('lo mismo con cualquier otro rol, no solo con las bailarinas', async () => {
    await sentar(beto.id);
    const res = await regalar(beto, mesero.id, 'Para el mesero');
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/personal/i);
  });
});

describe('GET /tables reparte quién está sentado y en qué mesa', () => {
  it('a un cliente no le dice quién está sentado', async () => {
    // De aquí salían los identificadores para alcanzar a alguien. El conteo sigue
    // siendo exacto —es lo que pinta el plano— pero sin nombres ni identificadores.
    await sentar(ana.id);
    const res = await api().get(url('/tables')).set(auth(beto));
    expect(res.status).toBe(200);

    const conGente = res.body.tables.find((t) => t.occupants && t.occupants.length);
    expect(conGente).toBeDefined();
    expect(conGente.occupants).toHaveLength(1); // el conteo no se pierde
    expect(conGente.occupants[0].display_name).toBeNull();
    expect(conGente.occupants[0].user_id).toBeNull();
    expect(JSON.stringify(res.body)).not.toContain('Ana');
    expect(JSON.stringify(res.body)).not.toContain(ana.id);
  });

  it('pero SÍ le dice en qué mesa está él mismo', async () => {
    // La aplicación lo usa para enseñar "estás en la mesa T-1". Borrarlo entero
    // rompería eso, y no filtra nada de nadie más.
    await sentar(beto.id);
    const res = await api().get(url('/tables')).set(auth(beto));
    const mia = res.body.tables.find((t) => (t.occupants || [])
      .some((o) => o.user_id === beto.id));
    expect(mia).toBeDefined();
    expect(mia.code).toBe('T-1');
  });

  it('al personal SÍ le dice quién está: lo necesita para atender', async () => {
    // El arreglo no puede ser "esconderlo de todos": el mesero tiene que saber a
    // quién le lleva el trago y a quién le cobra.
    await sentar(ana.id);
    const res = await api().get(url('/tables')).set(auth(mesero));
    const conGente = res.body.tables.find((t) => (t.occupants || []).length);
    expect(conGente.occupants[0]).toMatchObject({ display_name: 'Ana', user_id: ana.id });
  });

  it('quien la bloqueó ya no la ve, que es para lo que existe el bloqueo', async () => {
    // Éste era el que más importaba: `user_blocks` existe para cortar exactamente
    // esto, y esta ruta no lo consultaba. Ahora no hace falta consultarlo — a un
    // cliente no se le dice el nombre de NADIE, así que el bloqueo se respeta por
    // construcción y no por una comprobación que alguien pueda olvidar.
    await sentar(ana.id);
    await pool.query('INSERT INTO user_blocks (blocker_id, blocked_id) VALUES ($1,$2)',
      [ana.id, beto.id]);

    const res = await api().get(url('/tables')).set(auth(beto));
    expect(JSON.stringify(res.body)).not.toContain('Ana');
  });

  it('el camino del flirteo SÍ filtra por bloqueo y por consentimiento', async () => {
    // La contraparte: `GET /flirts/people` sirve los mismos datos con cuatro filtros.
    await sentar(ana.id);
    await sentar(beto.id);
    await pool.query('INSERT INTO user_blocks (blocker_id, blocked_id) VALUES ($1,$2)',
      [ana.id, beto.id]);

    const res = await api().get(url('/flirts/people')).set(auth(beto));
    if (res.status === 200) {
      const nombres = (res.body.people || []).map((p) => p.display_name);
      expect(nombres).not.toContain('Ana');
    } else {
      // Si contesta 422 es porque exige estar sentado, que también es un filtro.
      expect(res.status).toBe(422);
    }
  });

  it('el plano SÍ está bien: solo cuenta cabezas, sin identidades', async () => {
    // La prueba de que el patrón correcto ya existe en el mismo archivo.
    await sentar(ana.id);
    const res = await api().get(url('/floor-plan')).set(auth(beto));
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain(ana.id);
    expect(JSON.stringify(res.body)).not.toContain('Ana');
  });
});

describe('Los avisos en vivo de quién se sienta van a todo el club', () => {
  it('`table_updated` va al personal y a la persona, no a todo el club', async () => {
    // Antes iba sin audiencia, y `matchesAudience` trataba eso como "para todos":
    // cada vez que alguien se sentaba, su identificador y su mesa le llegaban en vivo
    // a cualquier cliente con el socket abierto.
    await sentar(beto.id);
    const antes = await pool.query(
      "SELECT max(id) AS id FROM events WHERE nightclub_id = $1", [club.id]);

    await api().post(url(`/tables/${mesa.id}/seat`)).set(auth(mesero))
      .send({ user_id: ana.id });

    const { rows } = await pool.query(
      `SELECT type, audience, payload FROM events
        WHERE nightclub_id = $1 AND id > COALESCE($2, 0) AND type = 'table_updated'`,
      [club.id, antes.rows[0].id]);
    expect(rows).toHaveLength(1);
    expect(rows[0].audience).not.toBeNull();
    expect(rows[0].audience.roles).toContain('waiter');
    // Y la persona que se sentó también lo recibe: es sobre ella.
    expect(rows[0].audience.userIds).toContain(ana.id);
    // Un cliente cualquiera, no.
    const events = require('../src/services/events');
    expect(events.matchesAudience(rows[0].audience, { id: beto.id, role: 'guest' })).toBe(false);
    expect(events.matchesAudience(rows[0].audience, { id: mesero.id, role: 'waiter' })).toBe(true);
  });

  it('el resto del sistema SÍ declara audiencia — esto es el olvido, no la regla', async () => {
    // Se comprueba contra un evento de dinero, que es donde más importa.
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM events
        WHERE nightclub_id = $1 AND audience IS NOT NULL`, [club.id]);
    expect(rows[0].n).toBeGreaterThanOrEqual(0); // se afirma abajo con uno real

    await sentar(beto.id);
    const pedido = await api().post(url('/orders')).set(auth(beto)).send({
      client_request_id: randomUUID(),
      table_id: mesa.id,
      items: [{ drink_id: trago.id, quantity: 1 }],
    });
    expect(pedido.status).toBe(201);
    const creado = await pool.query(
      `SELECT audience FROM events WHERE nightclub_id = $1 AND type = 'order_created'
        ORDER BY id DESC LIMIT 1`, [club.id]);
    expect(creado.rows[0].audience).not.toBeNull();
    expect(Object.keys(creado.rows[0].audience).length).toBeGreaterThan(0);
  });
});
