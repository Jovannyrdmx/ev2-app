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
 * Estas pruebas NO afirman que el sistema esté bien. Afirman lo que HOY hace, para
 * que quede escrito en negro sobre blanco y no se discuta. Cada una lleva marcado si
 * el comportamiento actual es el correcto o es el defecto.
 *
 * Las que documentan un defecto llevan `DEFECTO` en el nombre. Cuando se arreglen,
 * estas pruebas fallan, y ahí es cuando hay que invertirlas.
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
  it('DEFECTO: se le manda un trago con mensaje a quien apagó el consentimiento', async () => {
    // Por el camino de flirts esto se rechaza: `assertCanSend` exige `accept_flirts`.
    // Por el camino de pedidos pasa sin que nadie pregunte.
    await sentar(beto.id);
    await sentar(ana.id);

    const res = await regalar(beto, ana.id, 'Hola, te invito algo');
    expect(res.status).toBe(201);

    // Y el mensaje le llega de verdad: no se queda en la base sin salir.
    const { rows } = await pool.query(
      'SELECT recipient_id::text AS recipient_id, message FROM drink_orders WHERE id = $1',
      [res.body.order.id]);
    expect(rows[0].recipient_id).toBe(ana.id);
    expect(rows[0].message).toBe('Hola, te invito algo');
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

  it('DEFECTO: ni siquiera hace falta estar sentado', async () => {
    // El flirteo exige que las dos personas estén sentadas. Aquí quien manda puede
    // estar parado en la barra, o no estar en el club.
    await sentar(ana.id);
    const res = await regalar(beto, ana.id, 'Desde la barra');
    expect(res.status).toBe(201);
  });

  it('el bloqueo SÍ se respeta, que es lo único que sí comprueba', async () => {
    // Importante decirlo: no está todo roto. Pero el bloqueo es reactivo — solo
    // sirve DESPUÉS de que ya la contactaron una primera vez.
    await sentar(beto.id);
    await sentar(ana.id);
    await pool.query('INSERT INTO user_blocks (blocker_id, blocked_id) VALUES ($1,$2)',
      [ana.id, beto.id]);
    const res = await regalar(beto, ana.id, 'Otra vez');
    expect(res.status).toBe(403);
  });
});

describe('Las protecciones de "invitarle un trago al personal" también se rodean', () => {
  it('DEFECTO: se le manda un trago a una bailarina fuera de turno', async () => {
    // `POST /staff/:id/drinks` exige tres cosas: que su rol acepte tragos, que esté
    // EN TURNO, y que quien invita esté sentado. Además el trago entra a
    // `staff_drinks` en estado pendiente, con botón de RECHAZAR.
    //
    // Por `POST /orders` no se comprueba ninguna, y no se crea la fila de
    // `staff_drinks`: la persona no tiene cómo rechazarlo.
    await sentar(beto.id);
    const res = await regalar(beto, bailarina.id, 'Para ti');
    expect(res.status).toBe(201);

    const { rows } = await pool.query(
      'SELECT count(*)::int AS n FROM staff_drinks WHERE to_user_id = $1', [bailarina.id]);
    expect(rows[0].n).toBe(0); // sin fila, sin forma de rechazarlo
  });

  it('el camino del personal SÍ lo rechaza fuera de turno', async () => {
    await sentar(beto.id);
    const res = await api().post(url(`/staff/${bailarina.id}/drinks`)).set(auth(beto)).send({
      drink_id: trago.id, quantity: 1,
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('DEFECTO: `recipient_id` no filtra por rol, así que acepta a cualquier empleado', async () => {
    await sentar(beto.id);
    expect((await regalar(beto, mesero.id, 'Para el mesero')).status).toBe(201);
  });
});

describe('GET /tables reparte quién está sentado y en qué mesa', () => {
  it('DEFECTO: un cliente obtiene el identificador y el nombre de todos los sentados', async () => {
    // De aquí salen los `recipient_id` que hacen triviales los defectos de arriba.
    await sentar(ana.id);
    const res = await api().get(url('/tables')).set(auth(beto));
    expect(res.status).toBe(200);

    const conGente = res.body.tables.find((t) => t.occupants && t.occupants.length);
    expect(conGente).toBeDefined();
    expect(conGente.occupants[0]).toMatchObject({ display_name: 'Ana' });
    expect(conGente.occupants[0].user_id).toBe(ana.id);
  });

  it('DEFECTO: sigue apareciendo aunque lo haya bloqueado', async () => {
    // Éste es el que más importa. `user_blocks` existe para cortar exactamente esto,
    // y aquí no se consulta: quien bloqueó a alguien le sigue diciendo en qué mesa
    // está y desde qué hora.
    await sentar(ana.id);
    await pool.query('INSERT INTO user_blocks (blocker_id, blocked_id) VALUES ($1,$2)',
      [ana.id, beto.id]);

    const res = await api().get(url('/tables')).set(auth(beto));
    const conGente = res.body.tables.find((t) => t.occupants && t.occupants.length);
    expect(conGente.occupants.map((o) => o.display_name)).toContain('Ana');
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
  it('DEFECTO: `table_updated` se publica sin audiencia, o sea para todos', async () => {
    // `matchesAudience` (services/events.js) devuelve `true` cuando no hay audiencia:
    // sin el campo, el evento es para cualquiera con el socket abierto. Son los
    // únicos tres `publish` del sistema sin audiencia; los otros ~60 la declaran.
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
    // Sin audiencia: llega a todos, con el identificador de quien se sentó.
    expect(rows[0].audience === null || Object.keys(rows[0].audience).length === 0).toBe(true);
    expect(rows[0].payload.user_id).toBe(ana.id);
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
