/**
 * Del pedido cobrado al papel en la barra: el flujo completo, de punta a punta.
 *
 * ---------------------------------------------------------------------------
 * Por qué este archivo existe aparte de los otros
 * ---------------------------------------------------------------------------
 * Las piezas ya estaban probadas cada una por su lado: `tickets.test.js` prueba que
 * se encola el papel correcto, `printing.test.js` que la cola no duplica y que cada
 * PC toma lo suyo. Y aun así, en el club, **no salía ningún ticket de pedido**.
 *
 * Porque el flujo de verdad son seis eslabones, y ninguna prueba los recorría
 * juntos:
 *
 *   mesero pide → se confirma → se encola la comanda →
 *   la PC de esa barra la toma → sale el papel → la caja cobra
 *
 * Desde D77 el pedido del mesero entra a la barra al levantarlo y lo cobra después la
 * caja de esa barra; antes, pagar era lo que lo mandaba. La comanda sale UNA vez.
 *
 * Entre el cuarto y el quinto eslabón se perdieron dos noches: la comanda se encolaba
 * para una impresora de la barra baja y la única PC estaba asignada a la barra alta,
 * así que nadie la recogía. Todo verde, cero papel.
 *
 * ---------------------------------------------------------------------------
 * Los tres silencios
 * ---------------------------------------------------------------------------
 * Hay tres formas de no imprimir un pedido, y las tres se ven igual desde el club:
 * nada de papel y ningún error. Las tres están escritas abajo, a propósito, para que
 * queden documentadas como comportamiento conocido y no vuelvan a diagnosticarse
 * desde cero:
 *
 *   1. El interruptor de comandas está apagado  → no se encola nada
 *   2. Esa barra no tiene impresora de comandas → no se encola nada
 *   3. Ninguna PC atiende la barra de la impresora → se encola y se queda esperando
 *
 * El tercero es el único que deja rastro (un trabajo `pending` que envejece), y es
 * por eso el único que el panel puede delatar.
 */
'use strict';

const { randomUUID } = require('crypto');
const { setupSchema, truncateAll, closePool, pool } = require('./helpers/db');
const { api, auth } = require('./helpers/api');
const f = require('./helpers/factories');

let club; let admin; let manager; let waiter; let bartender; let table; let beer;

beforeAll(setupSchema);
afterAll(closePool);

beforeEach(async () => {
  await truncateAll();
  cajas.clear();
  club = await f.createNightclub({ slug: 'ev2-flujo' });
  admin = await f.createUser(club.id, { role: 'admin' });
  manager = await f.createUser(club.id, { role: 'manager' });
  waiter = await f.createUser(club.id, { role: 'waiter', display_name: 'Luis' });
  bartender = await f.createUser(club.id, { role: 'bartender', display_name: 'Sol' });
  table = await f.createTable(club.id, { code: 'T-7', section: 'ZONA ROJA', capacity: 4 });
  beer = await f.createDrink(club.id, { name: 'Cerveza Coronita', price: 60, stock: 40 });
});

const url = (p) => `/api/nightclubs/${club.id}${p}`;

// --------------------------------------------------------------- el montaje

/** La zona de la mesa la atiende esta barra. Es lo que enruta el papel. */
const atender = (locationId, section = 'ZONA ROJA') => pool.query(
  `INSERT INTO zone_bars (nightclub_id, section, location_id) VALUES ($1,$2::text,$3)
   ON CONFLICT (nightclub_id, section) DO UPDATE SET location_id = EXCLUDED.location_id`,
  [club.id, section, locationId]);

const altaImpresora = async (locationId, purpose = 'orders', name = 'Barra comandas') => (
  await api().post(url('/printers')).set(auth(manager)).send({
    location_id: locationId,
    name,
    purpose,
    connection: 'windows',
    windows_name: 'Xprinter XP-230H',
  })).body.printer;

const prenderComandas = () => api().patch(url('/print-settings')).set(auth(admin))
  .send({ print_order_tickets: true });

/**
 * Surte de cerveza una barra.
 *
 * Hace falta porque en este sistema la existencia vive **por barra**: un pedido de
 * una mesa que atiende la barra de arriba se sirve del estante de arriba, y si ese
 * estante esta vacio el pedido se rechaza con 409 antes de llegar a la impresora.
 * Es la misma barra que despues recibe la comanda, y por eso aparece aqui: una
 * prueba de impresion que no surta la barra correcta no prueba la impresion, prueba
 * el inventario.
 */
const surtir = (locationId, cantidad = 50) => f.stockUp(club.id, beer.supply_id, locationId, cantidad);

/** Da de alta una PC por el camino real: el gerente emite código y la PC lo canjea. */
async function altaPC(name, area = null) {
  const { body } = await api().post(url('/print-agents/invite')).set(auth(manager))
    .send(area || {});
  const res = await api().post('/api/print-agent/pair')
    .send({ code: body.invite.code, hostname: name, version: '1.0.0' });
  return { ...res.body.agent, token: res.body.token };
}

// --------------------------------------------------------------- el pedido

/**
 * Un pedido del mesero.
 *
 * Si el servidor lo rechaza, esto falla AQUÍ diciendo por qué. Un ayudante que
 * devuelve `undefined` en silencio convierte el error siguiente en "no se puede leer
 * 'id' de undefined", que es tres pantallas más abajo y no menciona el pedido.
 */
const pedir = async (over = {}) => {
  const res = await api().post(url('/orders')).set(auth(waiter)).send({
    client_request_id: randomUUID(),
    table_id: table.id,
    items: [{ drink_id: beer.id, quantity: 2 }],
    ...over,
  });
  if (res.status !== 201) {
    throw new Error(`el pedido no se creó: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.order;
};

/**
 * La caja de la barra de ese pedido cobra (D77). Cada barra tiene su cajero; se abre
 * su caja la primera vez que hace falta.
 */
const cajas = new Map();
async function cajeroDe(locationId) {
  if (!cajas.has(locationId)) {
    const cajero = await f.createUser(club.id, { role: 'cashier' });
    await f.openTill(club.id, { cashier: cajero, locationId, authorizer: manager });
    cajas.set(locationId, cajero);
  }
  return cajas.get(locationId);
}

const cobrar = async (orderId) => {
  const { rows } = await pool.query(
    `SELECT tx.id, tx.amount::text AS amount, tx.currency, o.bar_location_id
       FROM transactions tx JOIN drink_orders o ON o.id = tx.reference_id
      WHERE tx.reference_type = 'drink_order' AND tx.reference_id = $1`, [orderId]);
  const cajero = await cajeroDe(rows[0].bar_location_id);
  return api().post(url('/manual-payments/register')).set(auth(cajero)).send({
    transaction_id: rows[0].id,
    method: 'cash',
    amount: Number(rows[0].amount),
    currency: rows[0].currency,
  });
};

// --------------------------------------------------------------- lo que se mira

const comandas = async () => {
  const { rows } = await pool.query(
    `SELECT id::text AS id, status, printer_id::text AS printer_id, payload, created_at
       FROM print_jobs WHERE nightclub_id = $1 AND kind = 'order' ORDER BY created_at`,
    [club.id]);
  return rows;
};

const estadoPedido = async (orderId) => (await pool.query(
  'SELECT status FROM drink_orders WHERE id = $1', [orderId])).rows[0].status;

/** Lo que esta PC se lleva cuando pregunta, como lo hace cada tres segundos. */
const loQueTomaLaPC = async (pc) => (await api().get('/api/print-agent/jobs')
  .set('X-Print-Agent-Token', pc.token)).body.jobs;

/** La PC avisa que salió el papel. */
const avisarImpreso = (pc, jobId) => api().post(`/api/print-agent/jobs/${jobId}/done`)
  .set('X-Print-Agent-Token', pc.token).send({});

// ============================================================================

describe('El camino feliz, eslabón por eslabón', () => {
  it('el mesero pide, el papel sale en la barra de esa zona, y la caja cobra', async () => {
    const barra = club.locations['barra-baja'];
    await atender(barra);
    const impresora = await altaImpresora(barra);
    await prenderComandas();
    const pc = await altaPC('PC barra baja', { location_id: barra, purpose: 'orders' });

    // 1 y 2. El mesero pide, y en el mismo acto el pedido entra a la barra (D77).
    const pedido = await pedir();
    expect(await estadoPedido(pedido.id)).toBe('confirmed');

    // 3. La comanda quedó encolada para la impresora de ESA barra.
    const [comanda] = await comandas();
    expect(comanda).toBeDefined();
    expect(comanda.printer_id).toBe(impresora.id);
    expect(comanda.status).toBe('pending');

    // 4. La PC de esa barra se la lleva.
    const tomados = await loQueTomaLaPC(pc);
    expect(tomados).toHaveLength(1);
    expect(tomados[0].id).toBe(comanda.id);
    expect(tomados[0].printer.windows_name).toBe('Xprinter XP-230H');

    // 5. Y lo que le llega son los bytes del ticket, no una promesa.
    const papel = Buffer.from(tomados[0].payload, 'base64').toString('latin1');
    expect(papel).toContain('T-7');
    expect(papel).toContain('Cerveza Coronita');
    expect(papel).toContain('120.00'); // dos cervezas de 60
    // Todavía no se cobra: lo cobra la caja cuando el mesero le entregue el dinero.
    expect(papel).toMatch(/POR COBRAR/);

    // 6. Sale el papel y queda constancia.
    await avisarImpreso(pc, comanda.id);
    const [despues] = await comandas();
    expect(despues.status).toBe('printed');

    // 7. La caja cobra, y NO sale una segunda comanda: la barra no prepara dos veces.
    const cobro = await cobrar(pedido.id);
    expect(cobro.status).toBeLessThan(300);
    expect(await estadoPedido(pedido.id)).toBe('confirmed');
    expect(await comandas()).toHaveLength(1);
  });

  it('lo que pide el cliente desde su teléfono sigue saliendo al pagarse', async () => {
    const barra = club.locations['barra-baja'];
    await atender(barra);
    await altaImpresora(barra);
    await prenderComandas();
    const cliente = await f.createUser(club.id, { role: 'guest' });

    const res = await api().post(url('/orders')).set(auth(cliente)).send({
      client_request_id: randomUUID(), table_id: table.id,
      items: [{ drink_id: beer.id, quantity: 1 }],
    });
    expect(res.body.order.status).toBe('pending');
    expect(await comandas()).toHaveLength(0); // sin pagar no llega a la barra

    await cobrar(res.body.order.id);
    const [comanda] = await comandas();
    expect(Buffer.from(comanda.payload).toString('latin1')).toMatch(/PAGADO/);
  });

  it('un trago de cortesía también llega a la barra, aunque no pase por caja', async () => {
    // No tiene nada que cobrar, así que no pasa por el cobro: lo confirma el personal
    // a mano y la comanda sale por ese otro camino. Si este se rompe, las cortesías
    // se preparan de palabra o no se preparan.
    const barra = club.locations['barra-baja'];
    await atender(barra);
    await altaImpresora(barra);
    await prenderComandas();
    const gratis = await f.createDrink(club.id, { name: 'Agua de la casa', price: 0, stock: 10 });

    // Ahora que el pedido del mesero entra solo a la barra, la cortesía que confirma
    // el personal a mano es la del cliente: un trago de precio cero desde su teléfono.
    const cliente = await f.createUser(club.id, { role: 'guest' });
    const { body } = await api().post(url('/orders')).set(auth(cliente)).send({
      client_request_id: randomUUID(), table_id: table.id,
      items: [{ drink_id: gratis.id, quantity: 1 }],
    });
    const pedido = body.order;
    await api().post(url(`/orders/${pedido.id}/status`))
      .set(auth(bartender)).send({ status: 'confirmed' });

    const [comanda] = await comandas();
    expect(comanda).toBeDefined();
    const papel = Buffer.from(comanda.payload).toString('latin1');
    // Sin acento a propósito: el papel va en CP850, no en UTF-8 — la Í viaja como
    // 0xD6 y buscarla acentuada aquí compara dos codificaciones distintas.
    expect(papel).toMatch(/CORTES/);
  });

  it('cada barra recibe lo suyo cuando el club tiene dos', async () => {
    // Es el club de verdad: dos barras, dos PCs, dos impresoras. Lo que no puede
    // pasar es que la comanda de una mesa de abajo salga en la barra de arriba.
    const abajo = club.locations['barra-baja'];
    const arriba = club.locations['barra-alta'];
    await atender(abajo, 'ZONA ROJA');
    await atender(arriba, 'ZONA ROSA');
    await altaImpresora(abajo, 'orders', 'Comandas abajo');
    await altaImpresora(arriba, 'orders', 'Comandas arriba');
    await prenderComandas();
    const pcAbajo = await altaPC('PC abajo', { location_id: abajo, purpose: 'orders' });
    const pcArriba = await altaPC('PC arriba', { location_id: arriba, purpose: 'orders' });

    const mesaArriba = await f.createTable(club.id, { code: 'T-20', section: 'ZONA ROSA' });
    await surtir(arriba); // el estante de arriba, que es de donde se sirve esa mesa

    // Una mesa de abajo y una de arriba, las dos cobradas.
    const uno = await pedir();
    await cobrar(uno.id);
    const dos = await pedir({ table_id: mesaArriba.id });
    await cobrar(dos.id);

    const deAbajo = await loQueTomaLaPC(pcAbajo);
    const deArriba = await loQueTomaLaPC(pcArriba);
    expect(deAbajo).toHaveLength(1);
    expect(deArriba).toHaveLength(1);
    expect(Buffer.from(deAbajo[0].payload, 'base64').toString('latin1')).toContain('T-7');
    expect(Buffer.from(deArriba[0].payload, 'base64').toString('latin1')).toContain('T-20');
  });
});

// ============================================================================

describe('Los tres silencios: cero papel y cero error', () => {
  it('1. con el interruptor apagado no se encola nada', async () => {
    // Arranca apagado a propósito: un club sin impresoras no debe llenar una cola que
    // nadie recoge. Pero prendido o apagado, desde el club se ve igual.
    const barra = club.locations['barra-baja'];
    await atender(barra);
    await altaImpresora(barra);
    // …y NO se prende el interruptor.

    const pedido = await pedir();
    await cobrar(pedido.id);

    expect(await estadoPedido(pedido.id)).toBe('confirmed'); // el pedido sí avanza
    expect(await comandas()).toHaveLength(0); // el papel no existe
  });

  it('2. sin impresora de comandas en esa barra no se encola nada', async () => {
    // Le pasó al club: las zonas de arriba apuntaban a una barra cuya única impresora
    // estaba inactiva. El pedido se cobra, el bartender lo ve en pantalla, y no hay
    // papel ni trabajo que mirar.
    const abajo = club.locations['barra-baja'];
    const arriba = club.locations['barra-alta'];
    await atender(arriba, 'ZONA ROJA'); // la mesa de la prueba va a la barra de arriba
    await surtir(arriba); // con existencia, para que el 409 de inventario no tape el caso
    await altaImpresora(abajo); // …y la única impresora está abajo
    await prenderComandas();

    const pedido = await pedir();
    await cobrar(pedido.id);

    expect(await estadoPedido(pedido.id)).toBe('confirmed');
    expect(await comandas()).toHaveLength(0);
  });

  it('3. con la PC en otra barra, la comanda se encola y se queda esperando', async () => {
    // Esto es exactamente lo que tuvo el club sin comandas: la impresora dada de alta
    // en la barra baja, la única PC asignada a la barra alta. A diferencia de los dos
    // silencios anteriores, este SÍ deja rastro —un trabajo pendiente que envejece—
    // y es por eso el único que el panel puede delatar.
    const abajo = club.locations['barra-baja'];
    const arriba = club.locations['barra-alta'];
    await atender(abajo);
    await altaImpresora(abajo);
    await prenderComandas();
    const pcDesubicada = await altaPC('PC arriba', {
      location_id: arriba, purpose: 'orders',
    });

    const pedido = await pedir();
    await cobrar(pedido.id);

    const [comanda] = await comandas();
    expect(comanda).toBeDefined(); // el trabajo SÍ existe
    expect(comanda.status).toBe('pending');
    expect(await loQueTomaLaPC(pcDesubicada)).toHaveLength(0); // y nadie lo recoge

    // Y se arregla con lo que el panel ya deja hacer: poner la PC en su barra.
    await api().patch(url(`/print-agents/${pcDesubicada.id}`)).set(auth(manager))
      .send({ area: { location_id: abajo, purpose: 'orders' } });
    expect(await loQueTomaLaPC(pcDesubicada)).toHaveLength(1);
  });

  it('una PC sin barra asignada rescata el papel de cualquier barra', async () => {
    // Es la salida de emergencia del club de una sola PC, y la razón por la que el
    // alcance admite vacío: mientras haya una PC sin asignar, nada se queda colgado.
    const abajo = club.locations['barra-baja'];
    await atender(abajo);
    await altaImpresora(abajo);
    await prenderComandas();
    const comodin = await altaPC('PC única');

    const pedido = await pedir();
    await cobrar(pedido.id);
    expect(await loQueTomaLaPC(comodin)).toHaveLength(1);
  });
});

// ============================================================================

describe('Un club sin nada de esto sigue vendiendo', () => {
  it('sin impresoras ni PCs, se pide y se cobra exactamente igual', async () => {
    // Si esto falla, la impresión dejó de ser una capacidad y pasó a ser un requisito.
    await prenderComandas();
    const pedido = await pedir();
    const cobro = await cobrar(pedido.id);
    expect(cobro.status).toBeLessThan(300);
    expect(await estadoPedido(pedido.id)).toBe('confirmed');
    expect(await comandas()).toHaveLength(0);
  });
});

// ============================================================================

/**
 * El mesero vuelve a sacar la comanda (D62).
 *
 * El papel se atascó, salió cortado, se cayó atrás de la barra, o el bartender no lo
 * vio. Hasta ahora la única salida era ir a buscar al gerente mientras la mesa espera
 * un trago que nadie está preparando.
 */
describe('Reimprimir la comanda desde el piso', () => {
  const reimprimir = (orderId, quien) => api()
    .post(url(`/orders/${orderId}/reprint`)).set(auth(quien || waiter)).send({});

  /** Montaje mínimo para que un pedido cobrado tenga a dónde imprimir. */
  async function clubListo() {
    const barra = club.locations['barra-baja'];
    await atender(barra);
    const impresora = await altaImpresora(barra);
    await prenderComandas();
    const pc = await altaPC('PC barra baja', { location_id: barra, purpose: 'orders' });
    return { barra, impresora, pc };
  }

  it('sale otra vez, marcada, y la barra no prepara dos veces', async () => {
    const { pc } = await clubListo();
    const pedido = await pedir();
    await cobrar(pedido.id);
    await loQueTomaLaPC(pc); // la primera comanda ya se la llevó la barra

    const res = await reimprimir(pedido.id);
    expect(res.status).toBe(202);

    const [, segunda] = await comandas();
    expect(segunda).toBeDefined();
    const papel = Buffer.from(segunda.payload).toString('latin1');
    // La marca va ANTES de la mesa: tiene que leerse antes que el contenido, o no
    // sirve de nada. Se comprueba la posición, no solo que esté.
    expect(papel).toContain('REIMPRESION');
    expect(papel.indexOf('REIMPRESION')).toBeLessThan(papel.indexOf('T-7'));
    // Y sigue siendo la misma comanda: mismos tragos, mismo importe.
    expect(papel).toContain('Cerveza Coronita');
    expect(papel).toContain('120.00');
  });

  it('el papel dice quién la pidió', async () => {
    // Una reimpresión tiene dueño. Si aparecen tres copias del mismo pedido, el
    // papel dice de quién fue cada una.
    await clubListo();
    const pedido = await pedir();
    await cobrar(pedido.id);
    await reimprimir(pedido.id);

    const [, segunda] = await comandas();
    expect(Buffer.from(segunda.payload).toString('latin1')).toContain('Luis');
  });

  it('la vuelve a tomar la PC de esa barra, como cualquier otra comanda', async () => {
    // No es un camino aparte: entra a la misma cola y la recoge la misma PC. Si se
    // saliera del enrutado normal, acabaría saliendo en la barra equivocada.
    const { pc, impresora } = await clubListo();
    const pedido = await pedir();
    await cobrar(pedido.id);
    await loQueTomaLaPC(pc);

    await reimprimir(pedido.id);
    const tomados = await loQueTomaLaPC(pc);
    expect(tomados).toHaveLength(1);
    expect(tomados[0].printer.id).toBe(impresora.id);
  });

  it('un pedido que todavía no llega a la barra NO se puede mandar con este botón', async () => {
    // Es el freno que impide que este botón sirva tragos gratis: lo que pide un
    // cliente desde su teléfono llega a la barra cuando se paga, y un papel reimpreso
    // se ve igual que uno legítimo.
    await clubListo();
    const cliente = await f.createUser(club.id, { role: 'guest' });
    const { body } = await api().post(url('/orders')).set(auth(cliente)).send({
      client_request_id: randomUUID(), table_id: table.id,
      items: [{ drink_id: beer.id, quantity: 1 }],
    }); // …y no se cobra

    const res = await reimprimir(body.order.id);
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/todavía no se cobra/i);
    expect(await comandas()).toHaveLength(0);
  });

  it('el pedido del mesero, que se cobra en caja, sí se reimprime sin cobrar (D77)', async () => {
    await clubListo();
    const pedido = await pedir(); // ya está en la barra, por cobrar en caja
    const res = await reimprimir(pedido.id);
    expect(res.status).toBe(202);
    expect(await comandas()).toHaveLength(2);
  });

  it('un pedido cancelado tampoco', async () => {
    await clubListo();
    const pedido = await pedir();
    await cobrar(pedido.id);
    await api().post(url(`/orders/${pedido.id}/status`))
      .set(auth(manager)).send({ status: 'cancelled', reason: 'se arrepintió' });

    const res = await reimprimir(pedido.id);
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/cancelado/i);
  });

  it('sin impresora en esa barra lo dice, en vez de callarse', async () => {
    // Es la diferencia con la comanda automática, y es deliberada: quien picó el
    // botón está esperando el papel. Un 202 mentiroso lo deja esperando para siempre.
    await atender(club.locations['barra-baja']);
    await prenderComandas();
    const pedido = await pedir();
    await cobrar(pedido.id);

    const res = await reimprimir(pedido.id);
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/impresora de comandas/i);
  });

  it('funciona aunque las comandas automáticas estén apagadas', async () => {
    // El interruptor decide si CADA pedido saca su papel solo. No puede decidir sobre
    // un papel que una persona está pidiendo a mano y en este momento.
    const barra = club.locations['barra-baja'];
    await atender(barra);
    await altaImpresora(barra);
    // …y NO se prenden las comandas automáticas.
    const pedido = await pedir();
    await cobrar(pedido.id);
    expect(await comandas()).toHaveLength(0);

    const res = await reimprimir(pedido.id);
    expect(res.status).toBe(202);
    expect(await comandas()).toHaveLength(1);
  });

  it('el bartender también puede pedirla, no solo el mesero', async () => {
    await clubListo();
    const pedido = await pedir();
    await cobrar(pedido.id);
    expect((await reimprimir(pedido.id, bartender)).status).toBe(202);
  });

  it('un cliente no puede mandar papel a la barra', async () => {
    const invitado = await f.createUser(club.id, { role: 'guest' });
    await clubListo();
    const pedido = await pedir();
    await cobrar(pedido.id);
    expect((await reimprimir(pedido.id, invitado)).status).toBe(403);
  });
});
