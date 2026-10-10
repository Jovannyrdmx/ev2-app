/**
 * Objetos perdidos y encontrados (D67).
 *
 * ---------------------------------------------------------------------------
 * Lo que de verdad se está probando
 * ---------------------------------------------------------------------------
 * Guardar una lista es fácil. Lo difícil es **entregarle el objeto a su dueño y no a
 * otro**, y de ahí salen las dos mitades de este archivo:
 *
 *   1. Las señas del objeto no salen hacia un cliente que no las escribió. Si la
 *      aplicación enseñara "iPhone negro con funda roja", cualquiera lo reclama
 *      describiéndolo.
 *   2. La entrega exige un código que solo ve el dueño. Emparejar no es entregar.
 *
 * Todo lo demás —el alta, el catálogo, los estados— existe para sostener esas dos.
 */
'use strict';

const { setupSchema, truncateAll, closePool, pool } = require('./helpers/db');
const { api, auth } = require('./helpers/api');
const f = require('./helpers/factories');
const lf = require('../src/services/lost-found');

let club; let ana; let beto; let mesero; let gerente;

beforeAll(setupSchema);
afterAll(closePool);

beforeEach(async () => {
  await truncateAll();
  club = await f.createNightclub({ slug: 'ev2-perdidos' });
  ana = await f.createUser(club.id, { role: 'guest', display_name: 'Ana' });
  beto = await f.createUser(club.id, { role: 'guest', display_name: 'Beto' });
  mesero = await f.createUser(club.id, { role: 'waiter', display_name: 'Luis' });
  gerente = await f.createUser(club.id, { role: 'manager', display_name: 'Gerente' });
});

const url = (p) => `/api/nightclubs/${club.id}${p}`;

/** Ana perdió su teléfono y escribe las señas que solo ella conoce. */
const SENAS = 'iPhone negro, funda roja con una calcomania de un gato';

const reportar = (quien, cuerpo) => api().post(url('/lost-items')).set(auth(quien)).send({
  kind: 'lost', category: 'phone', details: SENAS, place: 'Terraza', ...cuerpo,
});

const entregado = (quien, cuerpo) => reportar(quien, {
  kind: 'found', details: 'Telefono negro con funda roja', place: 'Bano de abajo', ...cuerpo,
});

const comoPersonal = (quien, metodo, ruta, cuerpo) => api()[metodo](url(ruta))
  .set(auth(quien)).send(cuerpo || {});

// ============================================================================

describe('Levantar el reporte', () => {
  it('un cliente reporta lo que perdió y recupera sus propias señas', async () => {
    const res = await reportar(ana);
    expect(res.status).toBe(201);
    expect(res.body.item).toMatchObject({ kind: 'lost', status: 'open', category: 'phone' });
    // Son SUS señas: a él sí se le devuelven.
    expect(res.body.item.details).toBe(SENAS);
  });

  it('un cliente entrega algo que se encontró, y nace SIN resguardo', async () => {
    // "Alguien dijo que lo dejó" no es "está en la caja". Un cliente que ve "en
    // resguardo" y viene manejando media hora merece que eso sea cierto.
    const res = await entregado(beto);
    expect(res.status).toBe(201);
    const { rows } = await pool.query(
      'SELECT received_at, received_by FROM lost_items WHERE id = $1', [res.body.item.id]);
    expect(rows[0].received_at).toBeNull();
    expect(rows[0].received_by).toBeNull();
  });

  it('las señas son obligatorias: sin ellas no se puede comprobar nada', async () => {
    const res = await reportar(ana, { details: 'x' });
    expect(res.status).toBe(400);
  });

  it('la categoría es cerrada: un campo libre acabaría con el modelo adentro', async () => {
    const res = await reportar(ana, { category: 'iPhone 15 Pro morado' });
    expect(res.status).toBe(400);
  });

  it('el personal se entera en el momento', async () => {
    // Un teléfono que aparece a las 3 de la mañana y nadie ve hasta el día siguiente
    // es un teléfono que ya se fue.
    const res = await entregado(beto);
    const { rows } = await pool.query(
      `SELECT audience, payload FROM events
        WHERE nightclub_id = $1 AND type = 'lost_item_reported'`, [club.id]);
    expect(rows).toHaveLength(1);
    expect(rows[0].audience.roles).toContain('waiter');
    expect(rows[0].payload.item_id).toBe(res.body.item.id);
    // El aviso lleva la categoría, no las señas: va a varias personas.
    expect(JSON.stringify(rows[0].payload)).not.toContain('funda roja');
  });
});

// ============================================================================

describe('Las señas NO son públicas — es la regla que sostiene todo', () => {
  it('el catálogo enseña categoría, zona y día, y nada más', async () => {
    const creado = await entregado(beto);
    await comoPersonal(mesero, 'post', `/lost-items/${creado.body.item.id}/receive`,
      { storage_note: 'Caja detras de la barra' });

    const res = await api().get(url('/lost-items/found')).set(auth(ana));
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    const visto = res.body.items[0];
    expect(visto).toMatchObject({ category: 'phone', place: 'Bano de abajo', in_custody: true });
    // Lo que NO viaja. Si esto falla, cualquiera puede reclamar el teléfono de otro
    // describiéndolo con lo que leyó en la pantalla.
    expect(visto.details).toBeUndefined();
    expect(visto.storage_note).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain('funda roja');
    expect(JSON.stringify(res.body)).not.toContain('Caja detras');
  });

  it('tampoco se filtran las señas de un reporte de pérdida ajeno', async () => {
    await reportar(ana);
    const res = await api().get(url('/lost-items/mine')).set(auth(beto));
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(0); // no son suyos
    expect(JSON.stringify(res.body)).not.toContain('funda roja');
  });

  it('un cliente no puede leer la lista completa del personal', async () => {
    await reportar(ana);
    expect((await api().get(url('/lost-items')).set(auth(beto))).status).toBe(403);
  });

  it('el personal SÍ ve las señas: es lo que necesita para emparejar', async () => {
    await reportar(ana);
    const res = await api().get(url('/lost-items')).set(auth(mesero));
    expect(res.status).toBe(200);
    expect(res.body.items[0].details).toBe(SENAS);
  });

  it('lo ya entregado no sigue apareciendo en el catálogo', async () => {
    // Un catálogo que enseña cosas que ya no están hace que la gente venga por nada.
    const creado = await entregado(beto);
    await pool.query(
      `UPDATE lost_items SET status = 'closed', closed_reason = 'prueba' WHERE id = $1`,
      [creado.body.item.id]);
    const res = await api().get(url('/lost-items/found')).set(auth(ana));
    expect(res.body.items).toHaveLength(0);
  });
});

// ============================================================================

describe('Del reporte a la entrega', () => {
  /** El camino completo: Beto entrega, el club recibe, Ana reporta, se emparejan. */
  async function hastaElEmparejamiento() {
    const encontrado = (await entregado(beto)).body.item;
    await comoPersonal(mesero, 'post', `/lost-items/${encontrado.id}/receive`,
      { storage_note: 'Caja detras de la barra' });
    const perdido = (await reportar(ana)).body.item;
    const empar = await comoPersonal(mesero, 'post', `/lost-items/${perdido.id}/match`,
      { found_id: encontrado.id });
    return { encontrado, perdido, empar };
  }

  it('recibirlo es lo que lo pone en resguardo', async () => {
    const creado = await entregado(beto);
    const res = await comoPersonal(mesero, 'post', `/lost-items/${creado.body.item.id}/receive`,
      { storage_note: 'Caja detras de la barra' });
    expect(res.status).toBe(200);
    expect(res.body.item.received_name).toBe('Luis');
    expect(res.body.item.storage_note).toBe('Caja detras de la barra');
  });

  it('el código llega SOLO al dueño, y nunca a quien empareja', async () => {
    // Es el punto entero: si el personal pudiera ver el código, el código no probaría
    // nada, porque quien entrega y quien lo teclea serían la misma persona.
    const { perdido, empar } = await hastaElEmparejamiento();
    expect(empar.status).toBe(200);
    expect(empar.body.item.handover_code).toBeUndefined();
    expect(empar.body.item.handover_hint).toHaveLength(3);

    const { rows } = await pool.query(
      `SELECT audience, payload FROM events
        WHERE nightclub_id = $1 AND type = 'lost_item_matched'`, [club.id]);
    expect(rows).toHaveLength(1);
    expect(rows[0].audience.userIds).toEqual([ana.id]);
    expect(rows[0].payload.handover_code).toMatch(/^[0-9A-Z]{6}$/);
    expect(rows[0].payload.item_id).toBe(perdido.id);
  });

  it('el dueño lo ve en sus reportes, con dónde recogerlo', async () => {
    await hastaElEmparejamiento();
    const res = await api().get(url('/lost-items/mine')).set(auth(ana));
    const suyo = res.body.items.find((i) => i.kind === 'lost');
    expect(suyo.status).toBe('matched');
    expect(suyo.storage_note).toBe('Caja detras de la barra');
  });

  it('el código entrega el objeto, y las dos mitades quedan cerradas', async () => {
    const { encontrado, perdido } = await hastaElEmparejamiento();
    const { rows } = await pool.query(
      `SELECT payload FROM events WHERE type = 'lost_item_matched' AND nightclub_id = $1`,
      [club.id]);
    const codigo = rows[0].payload.handover_code;

    const res = await comoPersonal(mesero, 'post', `/lost-items/${perdido.id}/hand-over`,
      { code: codigo });
    expect(res.status).toBe(200);
    expect(res.body.item.status).toBe('returned');
    expect(res.body.item.returned_by).toBe(mesero.id);

    // El objeto encontrado también: si se quedara abierto, seguiría ofreciéndose.
    const { rows: otro } = await pool.query(
      'SELECT status FROM lost_items WHERE id = $1', [encontrado.id]);
    expect(otro[0].status).toBe('returned');
  });

  it('se acepta el código tecleado como sea: minúsculas, con guión o con espacios', async () => {
    const { perdido } = await hastaElEmparejamiento();
    const { rows } = await pool.query(
      `SELECT payload FROM events WHERE type = 'lost_item_matched' AND nightclub_id = $1`,
      [club.id]);
    const c = rows[0].payload.handover_code;
    const feo = `${c.slice(0, 3).toLowerCase()}- ${c.slice(3)}`;
    expect((await comoPersonal(mesero, 'post', `/lost-items/${perdido.id}/hand-over`,
      { code: feo })).status).toBe(200);
  });

  it('un código equivocado NO entrega el objeto', async () => {
    const { perdido } = await hastaElEmparejamiento();
    const res = await comoPersonal(mesero, 'post', `/lost-items/${perdido.id}/hand-over`,
      { code: 'ZZZZZZ' });
    expect(res.status).toBe(403);
    const { rows } = await pool.query('SELECT status FROM lost_items WHERE id = $1', [perdido.id]);
    expect(rows[0].status).toBe('matched');
  });

  it('sin emparejar no se entrega nada', async () => {
    // Entregar algo que nadie emparejó es entregarlo sin que nadie haya comprobado
    // que es de quien dice.
    const perdido = (await reportar(ana)).body.item;
    const res = await comoPersonal(mesero, 'post', `/lost-items/${perdido.id}/hand-over`,
      { code: 'ABC123' });
    expect(res.status).toBe(422);
  });

  it('un objeto ya entregado no se entrega dos veces', async () => {
    const { perdido } = await hastaElEmparejamiento();
    const { rows } = await pool.query(
      `SELECT payload FROM events WHERE type = 'lost_item_matched' AND nightclub_id = $1`,
      [club.id]);
    const c = rows[0].payload.handover_code;
    await comoPersonal(mesero, 'post', `/lost-items/${perdido.id}/hand-over`, { code: c });
    const otra = await comoPersonal(mesero, 'post', `/lost-items/${perdido.id}/hand-over`,
      { code: c });
    expect(otra.status).toBe(409);
  });

  it('una entrega asentada no se puede reescribir ni borrar', async () => {
    // Es la constancia de que ese objeto salió del club y con quién. Sin esto,
    // "¿a quién le entregaron mi cartera?" deja de tener respuesta.
    const { perdido } = await hastaElEmparejamiento();
    const { rows } = await pool.query(
      `SELECT payload FROM events WHERE type = 'lost_item_matched' AND nightclub_id = $1`,
      [club.id]);
    await comoPersonal(mesero, 'post', `/lost-items/${perdido.id}/hand-over`,
      { code: rows[0].payload.handover_code });

    await expect(pool.query(
      `UPDATE lost_items SET returned_by = NULL WHERE id = $1`, [perdido.id]))
      .rejects.toThrow(/ya está asentada/i);
    await expect(pool.query('DELETE FROM lost_items WHERE id = $1', [perdido.id]))
      .rejects.toThrow(/no se borra/i);
  });
});

// ============================================================================

describe('Lo que no se puede emparejar', () => {
  it('dos reportes de pérdida no se emparejan entre sí', async () => {
    const uno = (await reportar(ana)).body.item;
    const dos = (await reportar(beto)).body.item;
    const res = await comoPersonal(mesero, 'post', `/lost-items/${uno.id}/match`,
      { found_id: dos.id });
    expect(res.status).toBe(422);
  });

  it('un objeto de otro club, tampoco', async () => {
    // Sería entregar el objeto de un club en otro.
    const otro = await f.createNightclub({ slug: 'otro-club-perdidos' });
    const ajeno = await pool.query(
      `INSERT INTO lost_items (nightclub_id, kind, category, details)
       VALUES ($1,'found','phone','ajeno') RETURNING id`, [otro.id]);
    const mio = (await reportar(ana)).body.item;
    const res = await comoPersonal(mesero, 'post', `/lost-items/${mio.id}/match`,
      { found_id: ajeno.rows[0].id });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('cerrar exige motivo, y lo cierra el gerente', async () => {
    const item = (await entregado(beto)).body.item;
    expect((await comoPersonal(gerente, 'post', `/lost-items/${item.id}/close`, {})).status)
      .toBe(400);
    expect((await comoPersonal(mesero, 'post', `/lost-items/${item.id}/close`,
      { reason: 'nadie lo reclamo en 60 dias' })).status).toBe(403);

    const res = await comoPersonal(gerente, 'post', `/lost-items/${item.id}/close`,
      { reason: 'nadie lo reclamo en 60 dias' });
    expect(res.status).toBe(200);
    expect(res.body.item).toMatchObject({ status: 'closed' });
  });
});

// ============================================================================

describe('El código, por dentro', () => {
  it('son seis caracteres sin letras que se confundan', async () => {
    // A las cuatro de la mañana, en la pantalla de un teléfono, un 0 y una O son lo
    // mismo. Y una I y un 1.
    for (let i = 0; i < 200; i += 1) {
      const c = lf.newCode();
      expect(c).toHaveLength(lf.CODE_LENGTH);
      expect(c).not.toMatch(/[ILOU]/);
    }
  });

  it('no se repite', async () => {
    const vistos = new Set();
    for (let i = 0; i < 500; i += 1) vistos.add(lf.newCode());
    expect(vistos.size).toBeGreaterThan(495);
  });

  it('se guarda hasheado: con la base robada nadie recoge cosas ajenas', async () => {
    const c = lf.newCode();
    expect(lf.hashCode(c)).not.toContain(c);
    expect(lf.hashCode(c)).toHaveLength(64);
    // Y el mismo código, tecleado feo, da la misma huella.
    expect(lf.hashCode(`${c.slice(0, 3)}-${c.slice(3)}`.toLowerCase())).toBe(lf.hashCode(c));
  });

  it('la vista pública no puede filtrar un campo nuevo por descuido', async () => {
    // Si alguien agrega una columna al objeto, esta prueba obliga a decidir si va o no
    // en lo que ve un cliente ajeno, en vez de que viaje sola.
    const crudo = {
      id: 'x', category: 'phone', place: 'Terraza', happened_at: new Date(),
      received_at: new Date(), details: 'SENAS SECRETAS', storage_note: 'caja 3',
      reporter_phone: '555', handover_hash: 'abc',
    };
    expect(Object.keys(lf.publicView(crudo)).sort())
      .toEqual(['category', 'happened_at', 'id', 'in_custody', 'place']);
  });
});
