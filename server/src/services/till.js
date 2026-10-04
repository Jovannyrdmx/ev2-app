/**
 * EV2 — la caja de cada barra (D77).
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
const { OPEN_TX_STATUSES } = require('./payments');

const CASHIER = 'cashier';

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
 * La barra que el gerente le asigno a esta persona para la noche en curso.
 *
 * "En curso" = la noche no se ha cancelado ni terminado, sus puertas abren dentro
 * de las proximas 12 horas o ya abrieron, y todavia no llega su hora de cierre.
 * Si hubiera dos (no deberia: una por fecha), se toma la que abre primero.
 */
async function assignedBar(runner, { nightclubId, userId }) {
  const { rows } = await runner.query(
    `SELECT a.id AS assignment_id, a.location_id, l.name AS location_name, l.code AS location_code,
            e.id AS event_id, e.name AS event_name, e.doors_open_at
       FROM shift_assignments a
       JOIN events_calendar e ON e.id = a.event_id
       JOIN supply_locations l ON l.id = a.location_id
      WHERE a.nightclub_id = $1 AND a.user_id = $2 AND a.location_id IS NOT NULL
        AND l.active AND l.kind = 'bar'
        AND e.status NOT IN ('cancelled', 'finished')
        AND e.doors_open_at <= now() + make_interval(hours => $3)
        AND COALESCE(e.closes_at, e.doors_open_at + make_interval(hours => $4)) > now()
      ORDER BY e.doors_open_at ASC
      LIMIT 1`,
    [nightclubId, userId, OPEN_BEFORE_DOORS_HOURS, DEFAULT_NIGHT_HOURS]);
  return rows[0] || null;
}

/** La caja abierta de esta persona (su turno abierto con barra), o null. */
async function openTill(runner, { nightclubId, userId }) {
  const { rows } = await runner.query(
    `SELECT s.id, s.user_id, s.section, s.started_at, s.ended_at, s.location_id,
            l.name AS location_name,
            s.opening_float::text AS opening_float, s.float_currency,
            s.float_authorized_at, s.float_authorized_role,
            fa.display_name AS float_authorized_by_name
       FROM staff_shifts s
       JOIN supply_locations l ON l.id = s.location_id
       LEFT JOIN users fa ON fa.id = s.float_authorized_by
      WHERE s.nightclub_id = $1 AND s.user_id = $2 AND s.ended_at IS NULL
        AND s.location_id IS NOT NULL`,
    [nightclubId, userId]);
  return rows[0] || null;
}

/**
 * Abre la caja: el turno, su barra y su fondo, en un solo renglon.
 *
 * `authorizer` ya viene verificado por `manager-auth` (el PIN del gerente que le
 * entrega el fondo). La barra NO viene del cuerpo: sale del rol de la noche.
 */
async function open(client, {
  nightclubId, userId, openingFloat, currency = 'MXN', authorizer,
}) {
  const yaAbierto = await client.query(
    `SELECT id, location_id FROM staff_shifts
      WHERE nightclub_id = $1 AND user_id = $2 AND ended_at IS NULL
      FOR UPDATE`,
    [nightclubId, userId]);
  if (yaAbierto.rowCount > 0) {
    throw ApiError.conflict(yaAbierto.rows[0].location_id
      ? 'Tu caja ya está abierta'
      : 'Tienes un turno abierto sin caja: ciérralo antes de abrir caja',
    { shift_id: yaAbierto.rows[0].id });
  }

  const barra = await assignedBar(client, { nightclubId, userId });
  if (!barra) {
    throw ApiError.unprocessable(
      'No tienes barra asignada para esta noche. El gerente te asigna una en el rol de la noche.');
  }

  const fondo = round2(Number(openingFloat));
  if (!Number.isFinite(fondo) || fondo < 0) {
    throw ApiError.unprocessable('El fondo no puede ser negativo');
  }

  // Una caja por barra. El índice parcial de la base es el que manda (ver abajo);
  // esta consulta solo es para decir con quién está ocupada.
  const ocupada = await client.query(
    `SELECT u.display_name FROM staff_shifts s JOIN users u ON u.id = s.user_id
      WHERE s.location_id = $1 AND s.ended_at IS NULL`, [barra.location_id]);
  if (ocupada.rowCount > 0) throw tillTaken(barra, ocupada.rows[0].display_name);

  await client.query('SAVEPOINT till_open');
  try {
    const { rows } = await client.query(
      `INSERT INTO staff_shifts (nightclub_id, user_id, section, location_id,
                                 opening_float, float_currency,
                                 float_authorized_by, float_authorized_at, float_authorized_role)
       VALUES ($1,$2,NULL,$3,$4,$5::text,$6, now(), $7::text)
       RETURNING id`,
      [nightclubId, userId, barra.location_id, fondo.toFixed(2), currency,
        authorizer.id, authorizer.role]);
    await client.query('RELEASE SAVEPOINT till_open');
    return { shiftId: rows[0].id, bar: barra, openingFloat: money(fondo) };
  } catch (err) {
    // El índice parcial: otra caja se abrió en esa barra entre la consulta y el
    // INSERT. El savepoint deja la transacción usable para contestar con claridad.
    if (err.code === '23505') {
      await client.query('ROLLBACK TO SAVEPOINT till_open');
      throw tillTaken(barra, null);
    }
    throw err;
  }
}

function tillTaken(barra, quien) {
  return ApiError.conflict(
    `${barra.location_name} ya tiene la caja abierta${quien ? ` con ${quien}` : ''}: una caja por barra.`);
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
         COALESCE(items.items, '[]'::json) AS items
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
    ) items ON true`;

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
 * Lo que se puede decir de una caja: la barra, el fondo y lo que falta por cobrar.
 * Para cualquier persona: si no es cajero o no tiene caja, lo dice sin error.
 */
async function state(runner, { nightclubId, user }) {
  const till = await openTill(runner, { nightclubId, userId: user.id });
  const assignment = till ? null : await assignedBar(runner, { nightclubId, userId: user.id });
  const pending = till
    ? await pendingOrders(runner, { nightclubId, locationId: till.location_id })
    : [];
  const awaiting = till
    ? await awaitingPayment(runner, { nightclubId, locationId: till.location_id })
    : [];
  return {
    till: till ? {
      shift_id: till.id,
      location_id: till.location_id,
      location_name: till.location_name,
      started_at: till.started_at,
      opening_float: till.opening_float,
      currency: till.float_currency,
      float_authorized_by: till.float_authorized_by_name,
      float_authorized_at: till.float_authorized_at,
    } : null,
    assignment: assignment ? {
      location_id: assignment.location_id,
      location_name: assignment.location_name,
      event_id: assignment.event_id,
      event_name: assignment.event_name,
      doors_open_at: assignment.doors_open_at,
    } : null,
    pending_orders: pending,
    pending_total: money(pending.reduce((n, o) => n + Number(o.subtotal), 0)),
    awaiting_payment: awaiting,
  };
}

/**
 * La regla del cobro (D77): quien cobra un trago en una barra es el cajero de esa
 * barra, con su caja abierta.
 *
 * Se llama en las dos puertas por donde entra el dinero de un pedido —registrar
 * efectivo o voucher, y despertar la terminal de Mercado Pago— dentro de la misma
 * transaccion que bloquea el renglon del libro. Para cualquier otro puesto no hace
 * nada: la puerta (hostess) y la gerencia siguen como estaban.
 */
async function assertCanCollect(runner, { nightclubId, user, transactionId }) {
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

module.exports = {
  CASHIER,
  OPEN_BEFORE_DOORS_HOURS,
  DEFAULT_NIGHT_HOURS,
  assignedBar,
  openTill,
  open,
  pendingOrders,
  awaitingPayment,
  state,
  assertCanCollect,
};
