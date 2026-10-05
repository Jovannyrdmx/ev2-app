// Money the club receives outside a payment processor (docs/DECISIONES.md D28).
//
// Nothing here charges anybody. A manual payment is a claim -- "I sent you this" -- and
// it only touches the ledger when a manager confirms it against the statement. Both
// halves of that confirmation happen in one SQL transaction, so a ledger entry can never
// end up `paid` without the record of who approved it, or the other way round.
'use strict';

const { ApiError } = require('../middleware/errors');
const events = require('./events');
const tickets = require('./tickets');

const METHODS = ['cash', 'card_terminal', 'zelle', 'cash_app', 'bank_transfer', 'spei'];
// Cash is handed over in person; the rest leave a folio in a statement, which is the
// only thing that lets a manager tell a real transfer from a story.
//
// `card_terminal` is the club's own bank terminal at the table: the bank charges the
// card, the app only records that it happened and the voucher folio. It is not cash --
// it has a folio to match at closing -- but it is settled on the spot, like cash.
const CASH_METHODS = ['cash'];
// Settled the moment they are taken: the money, or an approved voucher, is already in
// hand, so there is nothing for a manager to confirm against a statement later.
const ON_THE_SPOT_METHODS = ['cash', 'card_terminal'];
const OPEN_TX_STATUSES = ['pending', 'pending_manual'];

const PAYMENT_SELECT = `
  SELECT p.id, p.nightclub_id, p.transaction_id, p.option_id, p.method,
         p.amount::text AS amount, p.currency, p.reference, p.note, p.status,
         p.rejection_reason, p.reviewed_at, p.created_at,
         p.declared_by, du.display_name AS declared_by_name,
         p.on_behalf_of, bu.display_name AS on_behalf_of_name,
         p.reviewed_by, ru.display_name AS reviewed_by_name,
         t.type AS transaction_type, t.amount::text AS transaction_amount,
         t.status AS transaction_status, t.reference_type, t.reference_id
    FROM manual_payments p
    JOIN transactions t ON t.id = p.transaction_id
    JOIN users du ON du.id = p.declared_by
    LEFT JOIN users bu ON bu.id = p.on_behalf_of
    LEFT JOIN users ru ON ru.id = p.reviewed_by`;

/** The guest never sees who reviewed it or why an internal note said what it said. */
function present(row, viewer) {
  const base = {
    id: row.id,
    transaction_id: row.transaction_id,
    method: row.method,
    amount: row.amount,
    currency: row.currency,
    reference: row.reference,
    note: row.note,
    status: row.status,
    created_at: row.created_at,
    reviewed_at: row.reviewed_at,
    rejection_reason: row.rejection_reason,
    pays_for: { type: row.transaction_type, reference_type: row.reference_type },
  };
  if (viewer !== 'manager') return base;
  return {
    ...base,
    declared_by: { id: row.declared_by, name: row.declared_by_name },
    on_behalf_of: row.on_behalf_of ? { id: row.on_behalf_of, name: row.on_behalf_of_name } : null,
    reviewed_by: row.reviewed_by ? { id: row.reviewed_by, name: row.reviewed_by_name } : null,
    transaction: {
      id: row.transaction_id,
      type: row.transaction_type,
      amount: row.transaction_amount,
      status: row.transaction_status,
      reference_type: row.reference_type,
      reference_id: row.reference_id,
    },
  };
}

/**
 * Applies what a confirmed payment means for the thing that was paid for. A reservation
 * held as `pending_payment` is what the guest actually cares about: confirming the
 * deposit is what turns it into a table that will be there when they arrive.
 */
async function applySideEffects(client, tx, nightclubId) {
  if (tx.reference_type === 'reservation' && tx.type === 'reservation_deposit') {
    const { rows } = await client.query(
      `UPDATE reservations SET status = 'confirmed', updated_at = now()
        WHERE id = $1 AND nightclub_id = $2 AND status = 'pending_payment'
        RETURNING id, user_id, table_id, event_id`,
      [tx.reference_id, nightclubId]);
    return { reservation: rows[0] || null, order: null };
  }

  // A paid drink order is a ticket for the bar. Sending it there here, and nowhere
  // else, is what keeps "paid" and "the bar knows about it" from ever coming apart:
  // whoever took the money -- the waiter at the table, the manager confirming a
  // transfer -- does not have to remember a second step.
  // 'bottle_service' is the same object with a bigger price tag: a gifted bottle is
  // still a drink order, and it has to reach the bar the same way.
  if (tx.reference_type === 'drink_order' && ['drink_order', 'bottle_service'].includes(tx.type)) {
    const { rows } = await client.query(
      `UPDATE drink_orders
          SET status = 'confirmed', confirmed_at = now(), updated_at = now()
        WHERE id = $1 AND nightclub_id = $2 AND status = 'pending'
        RETURNING id, sender_id, table_id`,
      [tx.reference_id, nightclubId]);
    // Y con el pedido llega la comanda a la barra (D53). Va exactamente aquí, pegada
    // al renglón que lo confirma, por la misma razón que dice el comentario de
    // arriba: pagar es lo que manda el trago a la barra, así que el papel que la
    // barra lee sale del mismo acto. Ponerlo en otro lado sería inventar un segundo
    // paso que alguien tendría que acordarse de dar.
    if (rows[0]) {
      await tickets.printOrder(client, {
        nightclubId, orderId: rows[0].id, userId: tx.payer_user_id || null,
      });
    }
    return { reservation: null, order: rows[0] || null };
  }

  return { reservation: null, order: null };
}

/**
 * El tipo de cambio USD->MXN vigente (pesos por un dólar), o null si el gerente nunca
 * fijó uno. Es UNO para todo el sistema: la caja (D86) y los retiros de ganancias.
 */
async function currentRate(runner) {
  const { rows } = await runner.query(
    `SELECT id, rate, effective_from, source, set_by FROM exchange_rates
      WHERE base = 'USD' AND quote = 'MXN' AND effective_from <= now()
      ORDER BY effective_from DESC, id DESC LIMIT 1`);
  return rows[0] || null;
}

/** El máximo de formas de pago para un mismo cobro (D79). */
const MAX_PARTS = 2;

const round2 = (n) => Math.round(Number(n || 0) * 100) / 100;

/**
 * Las partes YA cobradas de un renglón del libro (D79): pagos manuales confirmados y
 * cobros con terminal que Mercado Pago dio por pagados. `kind` es la forma de pago tal
 * como se compara para "dos métodos distintos": el voucher del banco (`card_terminal`)
 * y la terminal de Mercado Pago (`mercadopago_point`) son métodos distintos.
 */
async function partsOf(client, transactionId, { exceptPaymentId = null, exceptChargeId = null } = {}) {
  const { rows } = await client.query(
    `SELECT 'manual' AS source, p.id::text AS id, p.method AS kind, p.method,
            p.amount::text AS amount, p.reference,
            p.cash_received::text AS cash_received, p.change_given::text AS change_given,
            p.usd_received::text AS usd_received, p.exchange_rate::text AS exchange_rate,
            p.created_at
       FROM manual_payments p
      WHERE p.transaction_id = $1 AND p.status = 'confirmed'
        AND ($2::uuid IS NULL OR p.id <> $2::uuid)
     UNION ALL
     SELECT 'terminal', c.id::text, 'mercadopago_point', 'mercadopago_point',
            c.amount::text, c.external_order_id, NULL, NULL, NULL, NULL, c.created_at
       FROM terminal_charges c
      WHERE c.transaction_id = $1 AND c.status = 'processed'
        AND ($3::uuid IS NULL OR c.id <> $3::uuid)
      ORDER BY 11`,
    [transactionId, exceptPaymentId, exceptChargeId]);
  return rows;
}

/** Cuánto lleva pagado un renglón, sumando sus partes. */
async function paidSoFar(client, transactionId) {
  const parts = await partsOf(client, transactionId);
  return round2(parts.reduce((n, p) => n + Number(p.amount), 0));
}

/**
 * Marca pagado un cobro del libro y suelta lo que dependía de él.
 *
 * `provider`/`providerRef` son para el cobro con terminal (D47): ahí no hay un gerente
 * revisando un estado de cuenta, hay una pasarela que ya contestó, y el libro tiene que
 * decir cuál fue y con qué folio. Sin ellos se comporta como siempre — efectivo o
 * manual—, que es lo que usan las tres rutas que ya existían.
 *
 * Desde D79 un cobro puede pagarse en DOS partes con formas de pago distintas. Lo que
 * se compara ya no es "este pago contra el renglón" sino "todas las partes contra el
 * renglón": el renglón queda pagado cuando suman exacto. Con `allowPartial` (solo la
 * caja), una parte que todavía no completa el monto se acepta y el renglón sigue
 * abierto; sin él, la regla es la de siempre — lo que se paga tiene que completar.
 */
async function settle(client, {
  payment, reviewerId, nightclubId, provider = null, providerRef = null, allowPartial = false,
}) {
  const txRes = await client.query(
    `SELECT id, type, amount::text AS amount, currency, status, reference_type, reference_id,
            payer_user_id
       FROM transactions WHERE id = $1 AND nightclub_id = $2 FOR UPDATE`,
    [payment.transaction_id, nightclubId]);
  if (txRes.rowCount === 0) throw ApiError.notFound('El cobro no existe');
  const tx = txRes.rows[0];

  if (tx.status === 'paid') throw ApiError.conflict('Ese cobro ya está pagado');
  if (!OPEN_TX_STATUSES.includes(tx.status)) {
    throw ApiError.conflict(`El cobro está '${tx.status}' y ya no admite pago`);
  }
  if (payment.currency !== tx.currency) {
    throw ApiError.unprocessable('La moneda declarada no coincide con la del cobro');
  }

  // Las otras partes de este mismo cobro, sin contar la que se está asentando (que
  // según el camino ya está escrita —efectivo, terminal— o todavía no —transferencia).
  const otras = await partsOf(client, tx.id, {
    exceptPaymentId: payment.terminal_charge_id ? null : (payment.id || null),
    exceptChargeId: payment.terminal_charge_id || null,
  });
  const kind = payment.terminal_charge_id ? 'mercadopago_point' : payment.method;
  if (otras.length + 1 > MAX_PARTS) {
    throw ApiError.unprocessable(`Un cobro se paga con ${MAX_PARTS} formas de pago como máximo`);
  }
  if (otras.some((p) => p.kind === kind)) {
    throw ApiError.unprocessable('Las dos partes de un cobro tienen que ser formas de pago distintas');
  }

  const previo = round2(otras.reduce((n, p) => n + Number(p.amount), 0));
  const total = round2(previo + Number(payment.amount));
  const esperado = round2(tx.amount);
  const pendiente = round2(esperado - previo);

  // The ledger amount cannot be edited -- it is immutable by design -- so a payment for
  // a different amount is not something to reconcile silently. The manager rejects it
  // and asks for the difference.
  if (total > esperado || (total < esperado && !allowPartial)) {
    throw ApiError.unprocessable(
      previo > 0
        ? `Ese cobro ya lleva ${previo.toFixed(2)} pagado: falta ${pendiente.toFixed(2)}, no ${payment.amount}.`
        : `El monto declarado (${payment.amount}) no coincide con el cobro (${tx.amount}). `
          + 'Recházalo indicando la diferencia.',
      { declared: payment.amount, expected: tx.amount, paid: previo.toFixed(2), remaining: pendiente.toFixed(2) },
    );
  }

  // Una parte que todavía no completa: queda escrita, el renglón sigue abierto. Pero
  // solo si todavía cabe otra: la última parte tiene que completar.
  if (total < esperado && otras.length + 1 >= MAX_PARTS) {
    throw ApiError.unprocessable(
      `Un cobro se paga con ${MAX_PARTS} formas de pago como máximo: esta parte tiene que completar los ${pendiente.toFixed(2)} que faltan.`,
      { remaining: pendiente.toFixed(2) });
  }
  if (total < esperado) {
    return {
      tx, reservation: null, order: null, receipt: null,
      partial: true, paid: total.toFixed(2), remaining: round2(esperado - total).toFixed(2),
    };
  }

  await client.query(
    `UPDATE transactions
        SET status = 'paid', provider = $2::text, confirmed_by = $3,
            provider_ref = COALESCE($4::text, provider_ref),
            confirmed_at = now(), updated_at = now()
      WHERE id = $1`,
    [tx.id,
      // Con dos partes, el proveedor del libro es el de la parte que completó; el
      // detalle de cada parte vive en su propio renglón (pago manual o cobro con
      // terminal), que es donde lo lee el corte.
      provider || ([...CASH_METHODS, 'cash_usd'].includes(payment.method) ? 'cash' : 'manual'),
      reviewerId, providerRef]);

  const { reservation, order } = await applySideEffects(client, tx, nightclubId);

  // El recibo del dinero que acaba de entrar (D53). Va aquí y no en cada ruta porque
  // esta función es por donde pasan TODOS los caminos de cobro. Con dos partes (D79)
  // sale UNO, al completarse, con las dos.
  //
  // Nunca puede tumbar el cobro: `printReceipt` encola con salvaguarda y devuelve
  // `null` si algo falla. Un club sin impresoras cobra exactamente como antes.
  const estaParte = {
    kind,
    method: kind,
    amount: round2(payment.amount).toFixed(2),
    // El folio del voucher. De lo que capturó quien cobró, o —cuando cobró la
    // terminal— del folio que devolvió la pasarela.
    reference: payment.reference || providerRef || null,
    cash_received: payment.cash_received || null,
    change_given: payment.change_given || null,
    usd_received: payment.usd_received || null,
    exchange_rate: payment.exchange_rate || null,
  };
  const receipt = await tickets.printReceipt(client, {
    nightclubId,
    transactionId: tx.id,
    method: payment.method,
    reference: estaParte.reference,
    collectedBy: reviewerId,
    parts: otras.concat([estaParte]),
  });

  return { tx, reservation, order, receipt, partial: false, paid: total.toFixed(2), remaining: '0.00' };
}

async function publishConfirmed({ nightclubId, payment, tx, reservation, order }) {
  await events.publish({
    nightclubId,
    type: 'payment_confirmed',
    audience: {
      userIds: [payment.on_behalf_of || payment.declared_by, tx.payer_user_id].filter(Boolean),
      roles: ['manager'],
    },
    payload: {
      manual_payment_id: payment.id,
      transaction_id: tx.id,
      amount: payment.amount,
      currency: payment.currency,
      method: payment.method,
      pays_for: tx.type,
    },
  });
  if (reservation) {
    await events.publish({
      nightclubId,
      type: 'reservation_confirmed',
      audience: { userIds: [reservation.user_id], roles: ['hostess', 'manager'] },
      payload: { reservation_id: reservation.id, table_id: reservation.table_id },
    });
  }
  // Same shape the status route publishes, so the bar's screen has one thing to listen
  // for and does not care whether a waiter took cash or a manager cleared a transfer.
  if (order) {
    await events.publish({
      nightclubId,
      type: 'order_confirmed',
      audience: { roles: ['bartender', 'waiter', 'cashier', 'manager'], userIds: [order.sender_id] },
      payload: {
        order_id: order.id, status: 'confirmed', reason: null,
        transaction_id: tx.id, refund_due: false,
      },
    });
  } else if (tx.reference_type === 'drink_order') {
    // El pedido que se cobra en caja (D77) ya estaba en la barra: pagarlo no lo
    // confirma, solo lo salda. Se avisa igual, para que el mesero y la caja dejen de
    // verlo como pendiente.
    await events.publish({
      nightclubId,
      type: 'order_paid',
      audience: { roles: ['bartender', 'waiter', 'cashier', 'manager'] },
      payload: { order_id: tx.reference_id, transaction_id: tx.id },
    });
  }
}

module.exports = {
  METHODS, CASH_METHODS, ON_THE_SPOT_METHODS, OPEN_TX_STATUSES, PAYMENT_SELECT, currentRate,
  MAX_PARTS, present, settle, partsOf, paidSoFar, applySideEffects, publishConfirmed,
};
