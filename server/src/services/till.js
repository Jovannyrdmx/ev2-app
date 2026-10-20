/**
 * EV2 — la caja de cada barra (D77) y la de Cover (D118).
 *
 * Desde D118 la puerta también es una caja: la anfitriona que el gerente puso en Cover
 * la abre con su fondo, es la única que cobra en la puerta, y hace su corte como el
 * cajero. Todo lo de abajo vale igual para las dos; donde no, lo dice.
 *
 * El cajero es la UNICA persona que recibe dinero de los tragos en una barra: el
 * mesero levanta el pedido, la barra lo prepara al momento, el mesero entrega y
 * trae lo cobrado a la caja de esa barra. Este modulo responde tres preguntas y
 * nada mas:
 *
 *   1. ¿A que barra le toca a este cajero esta noche? Lo dice el rol de la noche
 *      que arma el gerente (`shift_assignments`); el cajero no la elige.
 *   2. ¿Tiene la caja abierta, con que fondo y quien se lo entrego?
 *   3. ¿Que pedidos de su barra siguen sin cobrar?
 *
 * Y una regla: un cajero solo cobra pedidos de SU barra, con la caja abierta. Sin
 * esto, dos cajas cobran el mismo pedido o ninguna lo cobra, y el corte de las dos
 * deja de cuadrar.
 */
'use strict';

const { ApiError } = require('../middleware/errors');
const payments = require('./payments');
const vipCredit = require('./vip-credit');

const { OPEN_TX_STATUSES } = payments;

const CASHIER = 'cashier';
const HOSTESS = 'hostess';

/**
 * Dónde está la caja de cada puesto: el cajero en una barra, la anfitriona en Cover
 * (la puerta, `kind = 'door'`). Un puesto que no está aquí no tiene caja.
 */
const TILL_KIND = { [CASHIER]: 'bar', [HOSTESS]: 'door' };
const TILL_ROLES = Object.keys(TILL_KIND);
const tillKindFor = (role) => TILL_KIND[String(role || '')] || null;

/**
 * Cuanto antes de abrir puertas puede abrir caja un cajero. La caja se cuenta y se
 * acomoda antes de que entre el primer cliente; doce horas cubre cualquier llegada
 * temprana sin dejar que el rol de una noche se use en la siguiente.
 */
const OPEN_BEFORE_DOORS_HOURS = 12;

/** Lo que dura una noche sin hora de cierre, igual que en `routes/events.js`. */
const DEFAULT_NIGHT_HOURS = 8;

const round2 = (n) => Math.round(Number(n || 0) * 100) / 100;
const money = (n) => round2(n).toFixed(2);

/**
 * El lugar de caja que el gerente le asigno a esta persona para la noche en curso:
 * una barra si es cajero, Cover si es anfitriona.
 *
 * "En curso" = la noche no se ha cancelado ni terminado, sus puertas abren dentro
 * de las proximas 12 horas o ya abrieron, y todavia no llega su hora de cierre.
 * Si hubiera dos (no deberia: una por fecha), se toma la que abre primero.
 */
async function assignedTill(runner, { nightclubId, userId, role = CASHIER }) {
  const kind = tillKindFor(role);
  if (!kind) return null;
  const { rows } = await runner.query(
    `SELECT a.id AS assignment_id, a.location_id, l.name AS location_name, l.code AS location_code,
            l.kind AS location_kind,
            -- La caja (D126). Sin caja en el rol, la única activa del lugar; con varias,
            -- NULL: el gerente tiene que decir cuál.
            COALESCE(a.till_id, till_of_location(a.location_id)) AS till_id,
            tt.name AS till_name, tt.device AS till_device,
            e.id AS event_id, e.name AS event_name, e.doors_open_at
       FROM shift_assignments a
       JOIN events_calendar e ON e.id = a.event_id
       JOIN supply_locations l ON l.id = a.location_id
       LEFT JOIN tills tt ON tt.id = COALESCE(a.till_id, till_of_location(a.location_id))
      WHERE a.nightclub_id = $1 AND a.user_id = $2 AND a.location_id IS NOT NULL
        AND l.active AND l.kind = $5::text
        AND e.status NOT IN ('cancelled', 'finished')
        AND e.doors_open_at <= now() + make_interval(hours => $3)
        AND COALESCE(e.closes_at, e.doors_open_at + make_interval(hours => $4)) > now()
      ORDER BY e.doors_open_at ASC
      LIMIT 1`,
    [nightclubId, userId, OPEN_BEFORE_DOORS_HOURS, DEFAULT_NIGHT_HOURS, kind]);
  return rows[0] || null;
}

/** La barra del cajero (lo de antes de D118; se queda para quien solo pregunta eso). */
function assignedBar(runner, { nightclubId, userId }) {
  return assignedTill(runner, { nightclubId, userId, role: CASHIER });
}

/** Lo que se le dice al cajero cuya barra tiene varias cajas y no le dijeron cuál (D126). */
function noTillMessage(lugar) {
  return `${lugar.location_name} tiene varias cajas. El gerente te asigna una en el rol de la noche.`;
}

/** Lo que se le dice a quien no tiene lugar de caja asignado esta noche. */
function noAssignmentMessage(role) {
  return role === HOSTESS
    ? 'No te asignaron Cover esta noche. El gerente te pone en Cover en el rol de la noche.'
    : 'No tienes barra asignada para esta noche. El gerente te asigna una en el rol de la noche.';
}

/** La caja abierta de esta persona (su turno abierto con barra), o null. */
async function openTill(runner, { nightclubId, userId }) {
  const { rows } = await runner.query(
    `SELECT s.id, s.user_id, s.section, s.started_at, s.ended_at, s.location_id,
            l.name AS location_name, l.kind AS location_kind,
            s.till_id, tt.name AS till_name, tt.device AS till_device,
            s.opening_float::text AS opening_float, s.float_currency,
            s.opening_float_usd::text AS opening_float_usd,
            s.float_authorized_at, s.float_authorized_role,
            fa.display_name AS float_authorized_by_name
       FROM staff_shifts s
       JOIN supply_locations l ON l.id = s.location_id
       LEFT JOIN tills tt ON tt.id = s.till_id
       LEFT JOIN users fa ON fa.id = s.float_authorized_by
      WHERE s.nightclub_id = $1 AND s.user_id = $2 AND s.ended_at IS NULL
        AND s.location_id IS NOT NULL`,
    [nightclubId, userId]);
  return rows[0] || null;
}

/**
 * Abre la caja: el turno, su lugar y su fondo, en un solo renglon.
 *
 * `authorizer` ya viene verificado por `manager-auth` (el PIN del gerente que le
 * entrega el fondo). El lugar NO viene del cuerpo: sale del rol de la noche.
 *
 * La anfitriona casi siempre llega con el turno ya abierto (lo abre su huella o el
 * boton de su telefono, D94). Su caja se le pone a ESE turno en vez de pedirle que lo
 * cierre: es el mismo turno de trabajo, ahora con cajon. Al cajero no le pasa, porque
 * su turno nace con la caja.
 */
async function open(client, {
  nightclubId, userId, role = CASHIER, openingFloat, openingFloatUsd = null,
  currency = 'MXN', authorizer,
}) {
  const yaAbierto = await client.query(
    `SELECT id, location_id FROM staff_shifts
      WHERE nightclub_id = $1 AND user_id = $2 AND ended_at IS NULL
      FOR UPDATE`,
    [nightclubId, userId]);
  const turnoSinCaja = yaAbierto.rowCount > 0 && !yaAbierto.rows[0].location_id
    ? yaAbierto.rows[0] : null;
  if (yaAbierto.rowCount > 0 && !(turnoSinCaja && role === HOSTESS)) {
    throw ApiError.conflict(yaAbierto.rows[0].location_id
      ? 'Tu caja ya está abierta'
      : 'Tienes un turno abierto sin caja: ciérralo antes de abrir caja',
    { shift_id: yaAbierto.rows[0].id });
  }

  const lugar = await assignedTill(client, { nightclubId, userId, role });
  if (!lugar) throw ApiError.unprocessable(noAssignmentMessage(role));
  if (!lugar.till_id) throw ApiError.unprocessable(noTillMessage(lugar), { reason: 'till_not_assigned' });

  const fondo = round2(Number(openingFloat));
  if (!Number.isFinite(fondo) || fondo < 0) {
    throw ApiError.unprocessable('El fondo no puede ser negativo');
  }
  const conDolares = openingFloatUsd !== null && openingFloatUsd !== undefined;
  const fondoUsd = conDolares ? round2(Number(openingFloatUsd)) : null;
  if (conDolares && (!Number.isFinite(fondoUsd) || fondoUsd < 0)) {
    throw ApiError.unprocessable('El fondo en dólares no puede ser negativo');
  }

  // Una abierta por caja (D126). El índice parcial de la base es el que manda (ver
  // abajo); esta consulta solo es para decir con quién está ocupada.
  const ocupada = await client.query(
    `SELECT u.display_name FROM staff_shifts s JOIN users u ON u.id = s.user_id
      WHERE s.till_id = $1 AND s.ended_at IS NULL`, [lugar.till_id]);
  if (ocupada.rowCount > 0) throw tillTaken(lugar, ocupada.rows[0].display_name);

  await client.query('SAVEPOINT till_open');
  try {
    const params = [lugar.location_id, fondo.toFixed(2), currency,
      authorizer.id, authorizer.role, fondoUsd === null ? null : fondoUsd.toFixed(2), lugar.till_id];
    const { rows } = turnoSinCaja
      ? await client.query(
        `UPDATE staff_shifts
            SET location_id = $1, opening_float = $2, float_currency = $3::text,
                float_authorized_by = $4, float_authorized_at = now(),
                float_authorized_role = $5::text, opening_float_usd = $6, till_id = $7
          WHERE id = $8 AND ended_at IS NULL AND location_id IS NULL
          RETURNING id`,
        [...params, turnoSinCaja.id])
      : await client.query(
        `INSERT INTO staff_shifts (nightclub_id, user_id, section, location_id,
                                   opening_float, float_currency,
                                   float_authorized_by, float_authorized_at, float_authorized_role,
                                   opening_float_usd, till_id)
         VALUES ($8,$9,NULL,$1,$2,$3::text,$4, now(), $5::text, $6, $7)
         RETURNING id`,
        [...params, nightclubId, userId]);
    if (rows.length === 0) throw ApiError.conflict('Tu turno cambió mientras abrías la caja; vuelve a intentarlo');
    await client.query('RELEASE SAVEPOINT till_open');
    return {
      shiftId: rows[0].id,
      bar: lugar,
      location: lugar,
      openingFloat: money(fondo),
      openingFloatUsd: fondoUsd === null ? null : money(fondoUsd),
      attachedToShift: Boolean(turnoSinCaja),
    };
  } catch (err) {
    // El índice parcial: otra caja se abrió en ese lugar entre la consulta y el
    // INSERT. El savepoint deja la transacción usable para contestar con claridad.
    if (err.code === '23505') {
      await client.query('ROLLBACK TO SAVEPOINT till_open');
      throw tillTaken(lugar, null);
    }
    throw err;
  }
}

function tillTaken(lugar, quien) {
  if (lugar.location_kind === 'door') {
    return ApiError.conflict(
      `La caja de ${lugar.location_name} ya está abierta${quien ? ` con ${quien}` : ''}: `
      + 'solo una anfitriona cobra en la puerta.');
  }
  const caja = lugar.till_name && lugar.till_name !== lugar.location_name
    ? `La caja ${lugar.till_name} (${lugar.location_name})` : `${lugar.location_name}`;
  return ApiError.conflict(
    `${caja} ya está abierta${quien ? ` con ${quien}` : ''}: una persona por caja.`);
}

/**
 * Quién tiene abierta esa caja ahora mismo, o null. Con `tillId` es esa caja (D126);
 * con solo el lugar, cualquier caja abierta de ese lugar (lo de antes).
 */
async function holderOf(runner, { locationId = null, tillId = null }) {
  if (!locationId && !tillId) return null;
  const { rows } = await runner.query(
    `SELECT s.id AS shift_id, s.user_id, u.display_name AS user_name, s.started_at
       FROM staff_shifts s JOIN users u ON u.id = s.user_id
      WHERE s.ended_at IS NULL
        AND (($2::uuid IS NOT NULL AND s.till_id = $2::uuid)
             OR ($2::uuid IS NULL AND s.location_id = $1::uuid))
      ORDER BY s.started_at LIMIT 1`, [locationId, tillId]);
  return rows[0] || null;
}

/**
 * Los pedidos de una barra que siguen sin cobrar.
 *
 * Solo los que se cobran en caja (`pay_at_till`): lo que un cliente pidio desde su
 * telefono se paga ahi mismo y no le toca a la caja. Un pedido cancelado ya no se
 * cobra; uno con el cobro en revision del gerente (`pending_manual`) todavia si
 * cuenta como pendiente.
 */
const OPEN_ORDER_SELECT = `
  SELECT o.id AS order_id, o.status, o.created_at, o.subtotal::text AS subtotal, o.currency,
         o.pay_at_till, o.table_id, t.code AS table_code, t.section AS table_section,
         dp.name AS delivery_point_name,
         o.taken_by, w.display_name AS taken_by_name, s.display_name AS sender_name,
         tx.id AS transaction_id, tx.status AS payment_status,
         COALESCE(items.items, '[]'::json) AS items,
         -- Lo que ya se pagó de este pedido y con qué (D79: hasta dos formas de pago),
         -- y lo que falta. Lo que la caja cobra es lo que FALTA.
         COALESCE(partes.paid, 0)::numeric(12,2)::text AS paid_amount,
         (o.subtotal - COALESCE(partes.paid, 0))::numeric(12,2)::text AS remaining,
         COALESCE(partes.parts, '[]'::json) AS parts,
         vip.balance AS vip_credit_balance
    FROM drink_orders o
    JOIN transactions tx ON tx.reference_type = 'drink_order' AND tx.reference_id = o.id
    LEFT JOIN tables t ON t.id = o.table_id
    LEFT JOIN delivery_points dp ON dp.id = o.delivery_point_id
    LEFT JOIN users w ON w.id = o.taken_by
    LEFT JOIN users s ON s.id = o.sender_id
    LEFT JOIN LATERAL (
      SELECT json_agg(json_build_object('name', d.name, 'quantity', oi.quantity)
                      ORDER BY d.name) AS items
        FROM drink_order_items oi JOIN drinks d ON d.id = oi.drink_id
       WHERE oi.order_id = o.id
    ) items ON true
    LEFT JOIN LATERAL (
      SELECT sum(x.amount) AS paid,
             json_agg(json_build_object('method', x.method, 'amount', x.amount::text)) AS parts
        FROM (
          SELECT p.method, p.amount FROM manual_payments p
           WHERE p.transaction_id = tx.id AND p.status = 'confirmed'
          UNION ALL
          SELECT 'mercadopago_point', c.amount FROM terminal_charges c
           WHERE c.transaction_id = tx.id AND c.status = 'processed'
        ) x
    ) partes ON true
    -- Credito VIP (D97): lo que le queda a la mesa reservada para esta cuenta. Las
    -- mismas condiciones que \`vip-credit.quote\`, que es la que manda al cobrar.
    LEFT JOIN LATERAL (
      SELECT GREATEST(c.granted - c.spent, 0)::numeric(12,2)::text AS balance
        FROM reservations rv
        JOIN reservation_credits c ON c.reservation_id = rv.id
        JOIN events_calendar ev ON ev.id = c.event_id
        JOIN users su ON su.id = o.sender_id
       WHERE rv.table_id = o.table_id AND rv.nightclub_id = o.nightclub_id
         AND rv.status NOT IN ('cancelled','no_show','pending_payment')
         AND c.voided_at IS NULL AND c.expires_at > now() AND c.granted > c.spent
         AND c.currency = o.currency
         AND (o.sender_id = c.user_id OR su.role <> 'guest')
         AND o.created_at >= ev.doors_open_at - interval '6 hours'
         AND o.created_at < c.expires_at
       ORDER BY c.expires_at
       LIMIT 1
    ) vip ON true`;

async function pendingOrders(runner, { nightclubId, locationId }) {
  const { rows } = await runner.query(
    `${OPEN_ORDER_SELECT}
      WHERE o.nightclub_id = $1 AND o.bar_location_id = $2
        AND o.pay_at_till
        AND o.status <> 'cancelled'
        AND tx.status = ANY($3::text[])
      ORDER BY o.created_at ASC, o.id ASC`,
    [nightclubId, locationId, OPEN_TX_STATUSES]);
  return rows;
}

/**
 * Lo que un cliente pidió desde su teléfono para esta barra y sigue sin pagar.
 *
 * Eso NO está en la barra —llega solo ya cobrado— y no es un pendiente del corte: no
 * se ha servido nada. Se le enseña a la caja porque, mientras el club no cobre en
 * línea, el cliente paga con el mesero y el mesero trae el dinero a la caja. Solo lo
 * de las últimas 12 horas: un pedido de anoche sin pagar ya no lo va a pagar nadie.
 */
async function awaitingPayment(runner, { nightclubId, locationId }) {
  const { rows } = await runner.query(
    `${OPEN_ORDER_SELECT}
      WHERE o.nightclub_id = $1 AND o.bar_location_id = $2
        AND NOT o.pay_at_till
        AND o.status = 'pending'
        AND tx.status = ANY($3::text[])
        AND o.created_at > now() - interval '12 hours'
      ORDER BY o.created_at ASC, o.id ASC`,
    [nightclubId, locationId, OPEN_TX_STATUSES]);
  return rows;
}

/**
 * Lo que se puede decir de una caja: el lugar, el fondo y lo que falta por cobrar.
 * Para cualquier persona: si no tiene caja, lo dice sin error. La caja de Cover no
 * tiene pedidos que cobrar: lo suyo son las entradas y el resto de las mesas.
 */
async function state(runner, { nightclubId, user }) {
  const till = await openTill(runner, { nightclubId, userId: user.id });
  const assignment = till ? null
    : await assignedTill(runner, { nightclubId, userId: user.id, role: user.role });
  const deBarra = till && till.location_kind !== 'door';
  const pending = deBarra
    ? await pendingOrders(runner, { nightclubId, locationId: till.location_id })
    : [];
  const awaiting = deBarra
    ? await awaitingPayment(runner, { nightclubId, locationId: till.location_id })
    : [];
  // Sin caja propia: si el lugar que le tocaba ya lo tiene otra persona, se dice
  // quién, para que no intente abrir una segunda caja ahí.
  const ocupada = assignment && assignment.till_id
    ? await holderOf(runner, { tillId: assignment.till_id })
    : null;
  return {
    till: till ? {
      shift_id: till.id,
      till_id: till.till_id,
      till_name: till.till_name,
      device: till.till_device,
      location_id: till.location_id,
      location_name: till.location_name,
      location_kind: till.location_kind,
      started_at: till.started_at,
      opening_float: till.opening_float,
      opening_float_usd: till.opening_float_usd,
      currency: till.float_currency,
      float_authorized_by: till.float_authorized_by_name,
      float_authorized_at: till.float_authorized_at,
    } : null,
    assignment: assignment ? {
      till_id: assignment.till_id,
      till_name: assignment.till_name,
      device: assignment.till_device,
      // La barra tiene varias cajas y el gerente no dijo cuál (D126): no se puede abrir.
      needs_till: !assignment.till_id,
      location_id: assignment.location_id,
      location_name: assignment.location_name,
      location_kind: assignment.location_kind,
      event_id: assignment.event_id,
      event_name: assignment.event_name,
      doors_open_at: assignment.doors_open_at,
      held_by: ocupada && ocupada.user_id !== user.id ? ocupada.user_name : null,
    } : null,
    pending_orders: pending,
    pending_total: money(pending.reduce((n, o) => n + Number(o.remaining), 0)),
    awaiting_payment: awaiting,
  };
}

/**
 * La caja de Cover de quien cobra en la puerta (D118).
 *
 * En la puerta solo cobra la anfitriona que tiene la caja de Cover abierta: vender un
 * cover, cobrar el resto de una mesa o despertar la terminal de Cover. La gerencia
 * y las demás anfitrionas siguen escaneando pases, pero el dinero entra a UNA caja,
 * con fondo y corte, y no a la bolsa de quien estaba más cerca.
 */
async function assertDoorTill(runner, { nightclubId, user }) {
  if (user.role !== HOSTESS) {
    throw ApiError.forbidden(
      'En la puerta cobra la anfitriona que tiene la caja de Cover abierta.');
  }
  const till = await openTill(runner, { nightclubId, userId: user.id });
  if (!till) {
    throw ApiError.conflict('Abre la caja de Cover antes de cobrar.', { reason: 'door_till_closed' });
  }
  if (till.location_kind !== 'door') {
    throw ApiError.forbidden(`Tu caja es ${till.location_name}, no la de la puerta.`);
  }
  return till;
}

/**
 * La regla del cobro (D77): quien cobra un trago en una barra es el cajero de esa
 * barra, con su caja abierta.
 *
 * Se llama en las dos puertas por donde entra el dinero de un pedido —registrar
 * efectivo o voucher, y despertar la terminal de Mercado Pago— dentro de la misma
 * transaccion que bloquea el renglon del libro. La anfitriona cobra solo con su caja
 * de Cover abierta (D118). Para la gerencia no hace nada.
 */
async function assertCanCollect(runner, { nightclubId, user, transactionId }) {
  // La anfitriona cobra con la caja de Cover abierta (D118); lo que cobre entra a esa
  // caja y a su corte, sea una entrada, el resto de una mesa o un pedido.
  if (user.role === HOSTESS) return assertDoorTill(runner, { nightclubId, user });
  if (user.role !== CASHIER) return null;

  const till = await openTill(runner, { nightclubId, userId: user.id });
  if (!till) throw ApiError.conflict('Abre tu caja antes de cobrar');

  const { rows } = await runner.query(
    `SELECT tx.reference_type, o.bar_location_id
       FROM transactions tx
       LEFT JOIN drink_orders o
              ON tx.reference_type = 'drink_order' AND o.id = tx.reference_id
      WHERE tx.id = $1 AND tx.nightclub_id = $2`,
    [transactionId, nightclubId]);
  if (rows.length === 0) throw ApiError.notFound('Cobro no encontrado');
  if (rows[0].reference_type !== 'drink_order') {
    throw ApiError.forbidden('La caja cobra pedidos de la barra; ese cobro no es de un pedido');
  }
  if (rows[0].bar_location_id !== till.location_id) {
    throw ApiError.forbidden(`Ese pedido es de otra barra; tu caja es ${till.location_name}`);
  }
  return till;
}

/**
 * La caja cobra una parte (o el total) de un pedido de su barra (D79).
 *
 * Una parte = una forma de pago: efectivo o voucher de la terminal del banco. La
 * terminal de Mercado Pago va por su propia ruta (`POST /terminal-charges` con
 * `amount`) porque esa sí cobra y hay que esperarla. Las dos formas de un mismo cobro
 * son distintas, y entre las dos suman exacto el pedido.
 *
 * Con efectivo, `cashReceived` es lo que el cliente entregó: el cambio lo calcula el
 * servidor y se guarda con el pago. Nunca se acepta recibir menos de lo que se cobra
 * en efectivo: eso no es "dar cambio", es cobrar de menos.
 */
async function collect(client, {
  nightclubId, user, transactionId, method, amount = null, reference = null, cashReceived = null,
  usdReceived = null, exchangeRateId = null, clientRequestId = null,
}) {
  const till = await assertCanCollect(client, { nightclubId, user, transactionId });

  const txRes = await client.query(
    `SELECT id, amount::text AS amount, currency, status, payer_user_id
       FROM transactions WHERE id = $1 AND nightclub_id = $2 FOR UPDATE`,
    [transactionId, nightclubId]);
  if (txRes.rowCount === 0) throw ApiError.notFound('Cobro no encontrado');
  const tx = txRes.rows[0];
  if (tx.status === 'paid') throw ApiError.conflict('Ese cobro ya está pagado');
  if (!OPEN_TX_STATUSES.includes(tx.status)) {
    throw ApiError.conflict(`El cobro está '${tx.status}' y ya no admite pago`);
  }

  // La terminal esperando la tarjeta: cobrar por aquí al mismo tiempo es cobrar dos
  // veces lo mismo si la tarjeta pasa.
  const enTerminal = await client.query(
    `SELECT c.id FROM terminal_charges c
      WHERE c.transaction_id = $1 AND c.status IN ('creating','waiting','action_required')`,
    [tx.id]);
  if (enTerminal.rowCount > 0) {
    throw ApiError.conflict(
      'Ese cobro tiene la terminal esperando la tarjeta. Espera a que termine o cancélalo.',
      { terminal_charge_id: enTerminal.rows[0].id });
  }

  // Dos partes con la misma forma de pago no son "dos métodos": se dice antes de
  // escribir nada, con el mismo mensaje que daría el libro.
  const previas = await payments.partsOf(client, tx.id);
  if (previas.some((p) => p.kind === method)) {
    throw ApiError.unprocessable('Las dos partes de un cobro tienen que ser formas de pago distintas');
  }

  // Credito VIP (D97): el monto lo decide el saldo, no el cajero.
  if (method === vipCredit.METHOD) {
    if (cashReceived !== null && cashReceived !== undefined) {
      throw ApiError.unprocessable('El efectivo recibido no aplica al crédito VIP');
    }
    if (usdReceived !== null && usdReceived !== undefined) {
      throw ApiError.unprocessable('Los dólares recibidos solo aplican al pago en dólares');
    }
    const pendiente = round2(Number(tx.amount) - await payments.paidSoFar(client, tx.id));
    const q = await vipCredit.quote(client, {
      nightclubId, transactionId: tx.id, pending: pendiente, currency: tx.currency,
    });
    return insertAndSettle(client, {
      nightclubId, till, user, tx, method, amount: q.amount, reference: null,
      clientRequestId, cashReceived: null, change: null, usd: null, vip: q.credit,
    });
  }

  // Dólares (D86): lo que cubren se calcula aquí, no se teclea. El tipo de cambio es
  // el vigente, y tiene que ser el mismo que el cajero vio en su pantalla: si el
  // gerente lo cambió mientras tanto, se para y se le enseña el nuevo.
  if (method === 'cash_usd') {
    const usd = await usdPart(client, {
      transactionId: tx.id, txAmount: tx.amount, usdReceived, exchangeRateId,
    });
    return insertAndSettle(client, {
      nightclubId, till, user, tx, method, amount: usd.amount, reference: null,
      clientRequestId, cashReceived: null, change: usd.change, usd,
    });
  }
  if (usdReceived !== null && usdReceived !== undefined) {
    throw ApiError.unprocessable('Los dólares recibidos solo aplican al pago en dólares');
  }
  if (amount === null || amount === undefined) {
    throw ApiError.unprocessable('Indica el monto a cobrar');
  }

  const monto = round2(amount);
  let recibido = null;
  let cambio = null;
  if (cashReceived !== null && cashReceived !== undefined) {
    if (method !== 'cash') {
      throw ApiError.unprocessable('El efectivo recibido solo aplica al pago en efectivo');
    }
    recibido = round2(cashReceived);
    if (recibido < monto) {
      throw ApiError.unprocessable(
        `Recibiste ${money(recibido)} y el efectivo a cobrar es ${money(monto)}: faltan ${money(monto - recibido)}.`,
        { cash_received: money(recibido), amount: money(monto) });
    }
    cambio = round2(recibido - monto);
  }
  if (method === 'card_terminal' && !String(reference || '').trim()) {
    throw ApiError.unprocessable('Captura el folio del voucher de la terminal');
  }

  return insertAndSettle(client, {
    nightclubId, till, user, tx, method, amount: money(monto), reference, clientRequestId,
    cashReceived: recibido === null ? null : money(recibido),
    change: cambio === null ? null : money(cambio), usd: null,
  });
}

/**
 * Cuánto cubren los dólares que entregó el cliente (D86).
 *
 * La cuenta la hace Postgres con NUMERIC, la misma aritmética que la regla de la
 * tabla: pesos = dólares × tipo de cambio redondeado al centavo; se aplica lo que
 * falte del cobro (o todo, si no alcanza: entonces la otra forma de pago paga el
 * resto), y el cambio es lo que sobra, redondeado HACIA ABAJO al peso. Los centavos se
 * quedan en el club, como pidió el dueño.
 */
async function usdPart(client, { transactionId, txAmount, usdReceived, exchangeRateId }) {
  if (usdReceived === null || usdReceived === undefined || !(Number(usdReceived) > 0)) {
    throw ApiError.unprocessable('Captura cuántos dólares te entregó el cliente');
  }
  const rate = await payments.currentRate(client);
  if (!rate) {
    throw ApiError.unprocessable(
      'El gerente no ha fijado el tipo de cambio: por ahora no se puede cobrar en dólares.');
  }
  if (!exchangeRateId || String(exchangeRateId) !== String(rate.id)) {
    throw ApiError.conflict(
      `El tipo de cambio cambió a ${Number(rate.rate).toFixed(2)}. Revisa el cobro con el nuevo valor.`,
      { exchange_rate: { id: String(rate.id), rate: rate.rate } });
  }
  const pendiente = round2(Number(txAmount) - await payments.paidSoFar(client, transactionId));
  const { rows } = await client.query(
    `SELECT round($1::numeric * $2::numeric, 2) AS mxn,
            LEAST(round($1::numeric * $2::numeric, 2), $3::numeric) AS amount,
            floor(round($1::numeric * $2::numeric, 2)
                  - LEAST(round($1::numeric * $2::numeric, 2), $3::numeric)) AS change`,
    [money(usdReceived), String(rate.rate), money(pendiente)]);
  const r = rows[0];
  if (!(Number(r.amount) > 0)) throw ApiError.conflict('Ese cobro ya está pagado');
  return {
    usdReceived: money(usdReceived),
    rate: String(rate.rate),
    rateId: String(rate.id),
    mxn: money(r.mxn),
    amount: money(r.amount),
    change: money(r.change),
  };
}

async function insertAndSettle(client, {
  nightclubId, till, user, tx, method, amount, reference, clientRequestId, cashReceived, change, usd,
  vip = null,
}) {
  let created;
  try {
    const { rows } = await client.query(
      `INSERT INTO manual_payments (nightclub_id, transaction_id, method, declared_by, amount,
                                    currency, reference, status, reviewed_by, reviewed_at,
                                    client_request_id, cash_received, change_given,
                                    usd_received, exchange_rate, exchange_rate_id,
                                    till_shift_id)
       VALUES ($1,$2,$3::text,$4,$5,$6,$7,'confirmed',$4,now(),$8,$9,$10,$11,$12,$13,$14)
       RETURNING id, transaction_id, method, amount::text AS amount, currency, status,
                 declared_by, reference, cash_received::text AS cash_received,
                 change_given::text AS change_given, usd_received::text AS usd_received,
                 exchange_rate::text AS exchange_rate`,
      [nightclubId, tx.id, method, user.id, amount, tx.currency,
        reference ? String(reference).trim() : null, clientRequestId,
        cashReceived, change,
        usd ? usd.usdReceived : null, usd ? usd.rate : null, usd ? usd.rateId : null,
        till ? till.id : null]);
    created = rows[0];
  } catch (err) {
    if (err.code === '23505') {
      throw ApiError.conflict('Ese cobro ya tiene un pago con esa forma de pago');
    }
    throw err;
  }

  if (vip) {
    await vipCredit.spend(client, {
      credit: vip, amount: created.amount, paymentId: created.id,
      transactionId: tx.id, userId: user.id,
    });
  }
  const settled = await payments.settle(client, {
    payment: created, reviewerId: user.id, nightclubId, allowPartial: true,
  });
  return { till, payment: created, ...settled };
}

/**
 * La caja de esa barra ya cerró esta noche y no hay otra abierta (D111).
 *
 * Un pedido que se cobra en caja y entra a una barra sin caja ya no lo cobra nadie
 * esta noche. Antes de que abra la primera caja no se bloquea: lo que se pida se
 * cobra en cuanto abra.
 */
async function closedTonight(runner, { nightclubId, locationId }) {
  if (!locationId) return null;
  const { rows } = await runner.query(
    `SELECT l.name AS location_name,
            bool_or(s.ended_at IS NULL) AS hay_abierta,
            bool_or(s.ended_at IS NOT NULL) AS hubo_cerrada
       FROM supply_locations l
       LEFT JOIN staff_shifts s
              ON s.location_id = l.id AND s.nightclub_id = l.nightclub_id
             AND s.started_at > now() - interval '18 hours'
      WHERE l.id = $1 AND l.nightclub_id = $2
      GROUP BY l.name`,
    [locationId, nightclubId]);
  const r = rows[0];
  if (!r || r.hay_abierta || !r.hubo_cerrada) return null;
  return { location_name: r.location_name };
}

module.exports = {
  CASHIER,
  HOSTESS,
  TILL_ROLES,
  tillKindFor,
  closedTonight,
  OPEN_BEFORE_DOORS_HOURS,
  DEFAULT_NIGHT_HOURS,
  assignedBar,
  assignedTill,
  noAssignmentMessage,
  noTillMessage,
  holderOf,
  assertDoorTill,
  openTill,
  open,
  pendingOrders,
  awaitingPayment,
  state,
  assertCanCollect,
  collect,
};
