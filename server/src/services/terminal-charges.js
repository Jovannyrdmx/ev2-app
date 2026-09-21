/**
 * EV2 — cobrar una tarjeta en la terminal del club (D47).
 *
 * Aquí vive la única decisión que importa: **cuándo un cobro se da por pagado**. La
 * respuesta es siempre la misma y no tiene excepciones — cuando `GET /v1/orders/{id}`,
 * pedido con NUESTRO token, contesta `processed`. Ni cuando el webhook lo dice, ni
 * cuando la terminal lo enseña en pantalla, ni cuando el mesero jura que sí pasó.
 *
 * ---------------------------------------------------------------------------
 * Por qué el cobro se parte en dos transacciones de base de datos
 * ---------------------------------------------------------------------------
 * Llamar a Mercado Pago DENTRO de una transacción SQL deja la fila del libro bloqueada
 * durante toda la llamada de red. Con una noche llena y la señal del club, eso es una
 * cola de meseros esperando a que se suelte un renglón.
 *
 * Así que: primero se aparta el cobro (una transacción corta, y el índice único es lo
 * que impide que dos meseros abran dos cobros del mismo renglón), después se habla con
 * Mercado Pago, y al final se anota lo que contestó.
 *
 * ---------------------------------------------------------------------------
 * El caso feo: no sabemos si se creó
 * ---------------------------------------------------------------------------
 * Si la red se cae entre nuestra petición y su respuesta, la orden puede existir del
 * otro lado. Por eso la llave de idempotencia se guarda ANTES de llamar: el repaso de
 * respaldo (`sweep`) vuelve a mandar la MISMA petición con la MISMA llave, y Mercado
 * Pago devuelve la orden que ya había en vez de crear otra. Reintentar sin esa llave es
 * cobrarle dos veces a alguien que está de pie frente a ti.
 *
 * Ese reintento estuvo prometido aquí y sin escribir durante un día entero: la llave se
 * guardaba y nunca se volvía a usar. Un comentario que promete una protección que no
 * existe es peor que no tenerla, porque quien lo lee deja de buscar el problema ahí.
 */
'use strict';

const crypto = require('crypto');
const { ApiError } = require('../middleware/errors');
const mp = require('./mercadopago');
const payments = require('./payments');
const events = require('./events');

/** Lo que el libro admite cobrar. Igual que el pago manual. */
const OPEN_TX_STATUSES = payments.OPEN_TX_STATUSES;

/** Cuánto vive una orden en la terminal antes de vencer sola. */
const EXPIRATION_SECONDS = Number(process.env.MERCADOPAGO_ORDER_TTL_S || 180);

/**
 * Cuánto esperamos antes de dar por perdido un cobro que nunca llegó a tener id.
 *
 * Corto: pasado ese rato la persona ya se cansó y el mesero va a cobrar de otra forma.
 * Lo que NO se hace es marcarlo como fallido —no lo sabemos— sino como `error`, que en
 * esta tabla significa exactamente "hay que mirarlo en el panel de Mercado Pago".
 */
const RECOVERY_WINDOW_MS = Number(process.env.MERCADOPAGO_RECOVERY_MS || 60000);

const CHARGE_SELECT = `
  SELECT c.id, c.nightclub_id, c.transaction_id, c.terminal_id, c.provider,
         c.external_order_id, c.idempotency_key, c.amount::text AS amount, c.currency,
         c.status, c.status_detail, c.payment_method_type, c.payment_method_id,
         c.installments, c.started_by, c.expires_at, c.settled_at, c.created_at,
         c.tip_amount::text AS tip_amount, c.refunded_amount::text AS refunded_amount,
         c.payment_transaction_id,
         t.label AS terminal_label, t.external_id AS terminal_external_id,
         u.display_name AS started_by_name
    FROM terminal_charges c
    JOIN payment_terminals t ON t.id = c.terminal_id
    JOIN users u ON u.id = c.started_by`;

/** Lo que ve una pantalla. Sin la llave de idempotencia: no le sirve a nadie de fuera. */
function present(row) {
  if (!row) return null;
  return {
    id: row.id,
    transaction_id: row.transaction_id,
    amount: row.amount,
    currency: row.currency,
    status: row.status,
    status_detail: row.status_detail,
    card: row.payment_method_id
      ? { brand: row.payment_method_id, type: row.payment_method_type,
        installments: row.installments }
      : null,
    terminal: { id: row.terminal_id, label: row.terminal_label },
    started_by: { id: row.started_by, name: row.started_by_name },
    expires_at: row.expires_at,
    settled_at: row.settled_at,
    created_at: row.created_at,
    // Lo que la terminal cobró encima, si el cliente dejó propina en el aparato.
    tip_amount: row.tip_amount || null,
    refunded_amount: row.refunded_amount || '0.00',
    // La terminal ya enseña el cobro: el cliente tiene el aparato en la mano.
    at_terminal: row.status === 'waiting' && row.status_detail === 'at_terminal',
    // Para que la pantalla sepa si sigue esperando o ya puede dejar de mirar.
    is_final: mp.FINAL_STATUSES.includes(row.status) || row.status === 'error',
    refundable: row.status === 'processed' && Boolean(row.external_order_id)
      && Number(row.refunded_amount || 0) < chargedTotal(row),
  };
}

/** Lo que salió de la tarjeta: el cobro más la propina, si la hubo. */
const chargedTotal = (row) => round2(Number(row.amount) + Number(row.tip_amount || 0));
const round2 = (n) => Math.round(Number(n) * 100) / 100;

/** Anota un paso. Nunca tira la operación: un renglón de bitácora no vale un cobro. */
async function record(runner, { chargeId, source, action, status = null, requestId = null, payload = {} }) {
  try {
    await runner.query(
      `INSERT INTO terminal_charge_events (charge_id, source, action, status, request_id, payload)
       VALUES ($1,$2::text,$3::text,$4::text,$5::text,$6::jsonb)
       ON CONFLICT DO NOTHING`,
      [chargeId, source, action, status, requestId, JSON.stringify(payload || {})]);
  } catch {
    /* la bitácora es lo primero que se sacrifica, nunca el cobro */
  }
}

// ---------------------------------------------------------------- empezar un cobro

/**
 * Aparta el cobro en la base. Transacción corta, sin red de por medio.
 *
 * Devuelve la fila recién creada en `creating`. Todavía no existe nada en Mercado Pago.
 */
async function reserve(client, { nightclubId, transactionId, terminalId, userId }) {
  const txRes = await client.query(
    `SELECT id, type, amount::text AS amount, currency, status
       FROM transactions WHERE id = $1 AND nightclub_id = $2 FOR UPDATE`,
    [transactionId, nightclubId]);
  if (txRes.rowCount === 0) throw ApiError.notFound('El cobro no existe');
  const tx = txRes.rows[0];

  if (tx.status === 'paid') throw ApiError.conflict('Ese cobro ya está pagado');
  if (!OPEN_TX_STATUSES.includes(tx.status)) {
    throw ApiError.conflict(`El cobro está '${tx.status}' y ya no admite pago`);
  }

  const termRes = await client.query(
    `SELECT id, external_id, label, operating_mode, active
       FROM payment_terminals
      WHERE id = $1 AND nightclub_id = $2 AND provider = 'mercadopago'`,
    [terminalId, nightclubId]);
  if (termRes.rowCount === 0) throw ApiError.notFound('Esa terminal no está dada de alta');
  const terminal = termRes.rows[0];
  if (!terminal.active) throw ApiError.unprocessable(`La terminal "${terminal.label}" está dada de baja`);
  // STANDALONE es el modo de fábrica, y en ese modo la terminal IGNORA las órdenes de la
  // API sin decir nada. Decirlo aquí ahorra la media hora de "no pasa nada al cobrar".
  if (terminal.operating_mode === 'STANDALONE') {
    throw ApiError.unprocessable(
      `La terminal "${terminal.label}" está en modo STANDALONE: no obedece al sistema. `
      + 'Cámbiala a PDV desde el panel del gerente y reiníciala.',
      { terminal_id: terminal.id, operating_mode: terminal.operating_mode });
  }
  // Modo sin confirmar: se dio de alta pero Mercado Pago no dejó pasarla a PDV (ver
  // `tryPdv` en routes/payments.js). Es el mismo "no pasa nada al cobrar" que el caso de
  // arriba, solo que sin saber todavía por qué, así que tampoco se intenta.
  if (terminal.operating_mode !== 'PDV') {
    throw ApiError.unprocessable(
      `La terminal "${terminal.label}" todavía no está confirmada en modo PDV, y sin eso `
      + 'no obedece al sistema. En el panel del gerente, Pagos: tócale "Pasarla a PDV".',
      { terminal_id: terminal.id, operating_mode: terminal.operating_mode });
  }

  try {
    const { rows } = await client.query(
      `INSERT INTO terminal_charges
         (nightclub_id, transaction_id, terminal_id, idempotency_key, amount, currency,
          status, started_by, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,'creating',$7, now() + make_interval(secs => $8))
       RETURNING id, idempotency_key, amount::text AS amount, currency, expires_at`,
      [nightclubId, tx.id, terminal.id, crypto.randomUUID(), tx.amount, tx.currency,
        userId, EXPIRATION_SECONDS]);
    return { charge: rows[0], tx, terminal };
  } catch (err) {
    // El índice parcial. Dos meseros tocaron cobrar en el mismo renglón: el segundo se
    // entera aquí y no despertando una segunda terminal.
    if (err.code === '23505') {
      throw ApiError.conflict('Ese cobro ya tiene una terminal esperando. Revisa la pantalla '
        + 'o cancélalo antes de empezar otro.');
    }
    throw err;
  }
}

/**
 * Le dice a Mercado Pago que despierte la terminal, y anota lo que conteste.
 *
 * Fuera de transacción a propósito. Si esto falla, el cobro se queda en `creating` y lo
 * recoge el repaso: NO se marca fallido, porque un fallo de red no es una tarjeta
 * rechazada y tratarlos igual es lo que produce un cobro fantasma.
 */
async function push(pool, { charge, tx, terminal, nightclubId }) {
  let order;
  try {
    order = await mp.createPointOrder({
      terminalExternalId: terminal.external_id,
      amount: charge.amount,
      currency: charge.currency,
      externalReference: charge.id,
      description: `EV2 ${tx.type}`,
      idempotencyKey: charge.idempotency_key,
      expirationSeconds: EXPIRATION_SECONDS,
    });
  } catch (err) {
    await record(pool, {
      chargeId: charge.id, source: 'api', action: 'create_failed',
      payload: { message: err.message, code: err.code || null },
    });
    // 504 es "no sabemos": se deja en creating para que el repaso lo reintente con la
    // misma llave. Cualquier otro error sí es una negativa clara de Mercado Pago.
    if (err.status !== 504) {
      await pool.query(
        `UPDATE terminal_charges SET status = 'error', status_detail = $2::text, updated_at = now()
          WHERE id = $1 AND status = 'creating'`,
        [charge.id, String(err.message).slice(0, 80)]);
    }
    throw err;
  }

  const read = mp.readOrder(order);
  await pool.query(
    `UPDATE terminal_charges
        SET external_order_id = $2::text, status = 'waiting', updated_at = now()
      WHERE id = $1 AND status = 'creating'`,
    [charge.id, read.external_order_id]);
  await record(pool, {
    chargeId: charge.id, source: 'api', action: 'created', status: 'waiting',
    payload: order,
  });

  await events.publish({
    nightclubId,
    type: 'terminal_charge_started',
    audience: { roles: ['manager', 'bartender', 'waiter', 'hostess'], userIds: [charge.started_by] },
    payload: { charge_id: charge.id, transaction_id: tx.id, terminal: terminal.label },
  });

  return read;
}

// ---------------------------------------------------------------- aplicar el resultado

/**
 * Lo que Mercado Pago contestó, guardado — y, si cobró, el libro movido.
 *
 * Todo en UNA transacción SQL: o queda el cobro marcado y el renglón del libro pagado, o
 * no queda ninguna de las dos cosas. La mitad de eso —un cobro cobrado que el libro no
 * refleja— es la clase de descuadre que aparece en el corte de la noche y nadie sabe
 * explicar.
 *
 * Es idempotente: aplicar dos veces el mismo `processed` no cobra dos veces, porque el
 * segundo intento encuentra el cobro ya en estado final y se sale.
 */
async function apply(pool, { chargeId, read, source, requestId = null, rawPayload = null }) {
  // Lo que Mercado Pago dijo se anota ANTES de abrir la transacción, con su propia
  // conexión. No es un detalle de orden: si lo de abajo falla y se deshace, este
  // renglón tiene que sobrevivir.
  //
  // Aquí había un defecto que encontré revisando: este `record` vivía DENTRO de la
  // transacción, así que cuando `settle()` reventaba —porque el renglón ya lo había
  // pagado alguien en efectivo— el ROLLBACK borraba el cobro Y el recibo de Mercado
  // Pago. Un cargo real a una tarjeta sin rastro en la tabla que la migración 026
  // promete como única respuesta a "me cobró dos veces".
  await record(pool, {
    chargeId,
    source,
    action: `reported_${read.mp_status || read.status || 'unknown'}`,
    status: read.status || null,
    requestId,
    payload: rawPayload || read,
  });

  const client = await pool.connect();
  let outcome = null;
  try {
    await client.query('BEGIN');
    const found = await client.query(
      `SELECT id, nightclub_id, transaction_id, amount::text AS amount, currency, status,
              started_by, external_order_id, refunded_amount::text AS refunded_amount,
              tip_amount::text AS tip_amount
         FROM terminal_charges WHERE id = $1 FOR UPDATE`,
      [chargeId]);
    if (found.rowCount === 0) throw ApiError.notFound('Ese cobro no existe');
    const charge = found.rows[0];

    // Ya terminó. Un webhook repetido, o el repaso llegando tarde: no se toca nada...
    // salvo una devolución. Un cobro pagado SÍ puede cambiar después: `order.refunded`
    // llega cuando alguien lo devuelve, desde este sistema o desde el panel de Mercado
    // Pago. Antes este `return` tiraba ese aviso, y el libro seguía diciendo que el
    // dinero había entrado.
    if (mp.FINAL_STATUSES.includes(charge.status)) {
      let refund = null;
      if (['processed', 'refunded'].includes(charge.status)) {
        refund = await bookRefunds(client, { charge, read, source });
      }
      await client.query('COMMIT');
      return {
        charge,
        changed: Boolean(refund && refund.booked),
        status: (refund && refund.status) || charge.status,
        refund,
      };
    }

    const status = read.status || 'error';
    await client.query(
      `UPDATE terminal_charges
          SET status = $2::text, status_detail = $3::text,
              payment_method_type = COALESCE($4::text, payment_method_type),
              payment_method_id = COALESCE($5::text, payment_method_id),
              installments = COALESCE($6::smallint, installments),
              external_order_id = COALESCE(external_order_id, $7::text),
              payment_transaction_id = COALESCE($8::text, payment_transaction_id),
              tip_amount = COALESCE($9::numeric, tip_amount),
              settled_at = CASE WHEN $2::text = 'processed' THEN now() ELSE settled_at END,
              updated_at = now()
        WHERE id = $1`,
      [charge.id, status, read.status_detail, read.payment_method_type,
        read.payment_method_id, read.installments, read.external_order_id,
        read.payment_transaction_id || null, read.tip_amount || null]);

    // Sin `requestId`: ese ya lo lleva el renglón de arriba, y el índice único
    // (cobro, notificación) haría que este se perdiera en silencio.
    await record(client, {
      chargeId: charge.id, source, action: `status_${status}`, status,
    });

    if (status === 'processed') {
      // Lo que Mercado Pago dice que cobró, contra lo que el libro dice que vale. Si no
      // coincide, NO se da por pagado: se deja marcado para que lo mire una persona.
      // Un renglón pagado por menos de lo que cuesta es dinero que el club no cobró y
      // que ya nadie va a reclamar.
      //
      // La propina: la terminal puede cobrarla encima (la respuesta trae `tip_amount`
      // por pago). La guía no dice si `paid_amount` la incluye, así que se aceptan las
      // dos lecturas — pero SOLO esas dos: lo cobrado es exactamente lo esperado, o es
      // exactamente lo esperado más la propina que el propio Mercado Pago reporta.
      // Cualquier otra diferencia sigue siendo un descuadre que mira una persona.
      const cobrado = read.paid_amount == null ? Number(charge.amount) : Number(read.paid_amount);
      const propina = Number(read.tip_amount || 0);
      const esperado = Number(Number(charge.amount).toFixed(2));
      const cuadra = Number(cobrado.toFixed(2)) === esperado
        || (propina > 0 && Number((cobrado - propina).toFixed(2)) === esperado);
      if (!cuadra) {
        await client.query(
          `UPDATE terminal_charges SET status = 'error',
                  status_detail = $2::text, updated_at = now() WHERE id = $1`,
          [charge.id, `cobrado ${cobrado} != esperado ${charge.amount}`]);
        await record(client, {
          chargeId: charge.id, source, action: 'amount_mismatch', status: 'error',
          payload: { charged: cobrado, expected: charge.amount, tip: read.tip_amount || null },
        });
        await client.query('COMMIT');
        return { charge, changed: true, mismatch: true };
      }

      const settled = await payments.settle(client, {
        payment: {
          transaction_id: charge.transaction_id,
          amount: charge.amount,
          currency: charge.currency,
          method: 'card_terminal',
        },
        // Quien inició el cobro. Nadie "aprobó" nada: lo aprobó la tarjeta.
        reviewerId: charge.started_by,
        nightclubId: charge.nightclub_id,
        provider: 'mercadopago',
        providerRef: read.external_order_id || charge.external_order_id,
      });
      outcome = settled;
    }

    await client.query('COMMIT');
    return { charge, changed: true, status, outcome };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    // La tarjeta SÍ cobró y no pudimos asentarlo. El caso típico es que el renglón ya
    // estuviera pagado por otra vía. Da igual el motivo: hay dinero cobrado que el
    // libro no refleja, y eso tiene que quedar marcado y visible en vez de perderse
    // con el ROLLBACK. Se escribe con `pool`, fuera de la transacción que acaba de
    // deshacerse.
    if (read && read.status === 'processed') {
      await pool.query(
        `UPDATE terminal_charges
            SET status = 'error', status_detail = $2::text, updated_at = now()
          WHERE id = $1 AND status NOT IN ('processed','refunded')`,
        [chargeId, `cobrado pero no se pudo asentar: ${String(err.message).slice(0, 50)}`],
      ).catch(() => {});
      await record(pool, {
        chargeId, source, action: 'settle_failed', status: 'error',
        payload: { message: err.message, code: err.code || null, read },
      });
    }
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------- devolver

/** Cuánto vive el derecho a devolver, según la guía de Mercado Pago. */
const REFUND_WINDOW_DAYS = 90;

const REFUND_STATUS = (mpStatus) => (mpStatus === 'processed' ? 'processed' : 'processing');

/**
 * Asienta lo que Mercado Pago dice que YA se devolvió de un cobro.
 *
 * Corre dentro de la transacción de quien llama y con la fila del cobro bloqueada
 * (`FOR UPDATE`). Es idempotente por construcción: nunca asienta "un reembolso", asienta
 * la DIFERENCIA entre lo que Mercado Pago reporta devuelto y lo que ya teníamos anotado.
 * Nuestra propia respuesta y su webhook `order.refunded` describen la misma devolución;
 * el que llegue segundo encuentra la diferencia en cero y no hace nada. Contar
 * reembolsos, en vez de restar montos, es como se devuelve dos veces en el libro.
 *
 * El libro solo ve la parte del cobro que entró al libro. La propina nunca se asentó
 * (va aparte, `tip_amount`), así que tampoco se descuenta de él: lo que se devuelve al
 * libro se topa en el monto del cobro.
 */
async function bookRefunds(client, { charge, read, source, staffRefundId = null }) {
  const refunds = (read && read.refunds) || [];

  // Un reembolso que ya teníamos y que Mercado Pago ya terminó de procesar.
  for (const r of refunds) {
    if (r.id && r.status === 'processed') {
      await client.query(
        `UPDATE terminal_refunds SET status = 'processed', updated_at = now()
          WHERE charge_id = $1 AND external_refund_id = $2::text AND status = 'processing'`,
        [charge.id, r.id]);
    }
  }

  let total = round2(read && read.refunded_amount != null ? read.refunded_amount : 0);
  // Dice "devuelta" pero no dice cuánto: una devolución total es la única lectura que
  // no inventa un monto.
  if (!(total > 0) && read && read.mp_status === 'refunded') total = chargedTotal(charge);
  const ya = round2(charge.refunded_amount || 0);
  const delta = round2(total - ya);
  if (!(delta > 0)) return { booked: false, status: charge.status };

  const monto = Number(charge.amount);
  const libroDelta = round2(Math.min(total, monto) - Math.min(ya, monto));
  const completo = Math.min(total, monto) >= monto;
  const ultimo = refunds.length ? refunds[refunds.length - 1] : null;

  let refundTxId = null;
  const orig = await client.query(
    `SELECT id, type, status, payer_user_id FROM transactions
      WHERE id = $1 AND nightclub_id = $2 FOR UPDATE`,
    [charge.transaction_id, charge.nightclub_id]);
  const original = orig.rows[0];
  if (libroDelta > 0 && original && ['paid', 'refunded'].includes(original.status)) {
    // El dinero que sale se asienta como SALIDA, en su propio renglón, apuntando al que
    // se cobró. El renglón original no se edita: solo cambia de estado si la devolución
    // fue completa, que es lo que lo saca del ingreso del día.
    const { rows } = await client.query(
      `INSERT INTO transactions (nightclub_id, type, direction, amount, currency, status,
                                 payee_user_id, provider, provider_ref, reference_type,
                                 reference_id, metadata, confirmed_at)
       VALUES ($1,'refund','out',$2,$3,'paid',$4,'mercadopago',$5::text,'transaction',$6,
               $7::jsonb, now())
       RETURNING id`,
      [charge.nightclub_id, libroDelta, charge.currency, original.payer_user_id,
        (ultimo && ultimo.id) || charge.external_order_id, original.id,
        JSON.stringify({
          terminal_charge_id: charge.id, refunds_type: original.type, source,
          partial: !completo,
        })]);
    refundTxId = rows[0].id;
    if (completo && original.status !== 'refunded') {
      await client.query(
        "UPDATE transactions SET status = 'refunded', updated_at = now() WHERE id = $1",
        [original.id]);
    }
  }

  // ¿De quién es esta devolución? De la que se pidió aquí si hay una abierta; si no,
  // se hizo desde el panel o la terminal y se anota como externa. Se asienta igual:
  // el dinero salió.
  let refundRowId = staffRefundId;
  if (!refundRowId) {
    const abierta = await client.query(
      `SELECT id FROM terminal_refunds
        WHERE charge_id = $1 AND source = 'staff' AND status IN ('requested','processing')
          AND refund_transaction_id IS NULL
        ORDER BY created_at LIMIT 1`,
      [charge.id]);
    refundRowId = abierta.rows[0] ? abierta.rows[0].id : null;
  }
  const externalId = ultimo && ultimo.id ? ultimo.id : null;
  const yaUsado = externalId ? (await client.query(
    'SELECT 1 FROM terminal_refunds WHERE external_refund_id = $1::text AND id IS DISTINCT FROM $2',
    [externalId, refundRowId])).rowCount > 0 : false;
  const estado = REFUND_STATUS(ultimo && ultimo.status);

  if (refundRowId) {
    await client.query(
      `UPDATE terminal_refunds
          SET status = $2::text, external_refund_id = COALESCE(external_refund_id, $3::text),
              refund_transaction_id = COALESCE(refund_transaction_id, $4), updated_at = now()
        WHERE id = $1`,
      [refundRowId, estado, yaUsado ? null : externalId, refundTxId]);
  } else {
    await client.query(
      `INSERT INTO terminal_refunds (nightclub_id, charge_id, transaction_id,
                                     refund_transaction_id, amount, currency, source,
                                     idempotency_key, external_refund_id, status, status_detail)
       VALUES ($1,$2,$3,$4,$5,$6,'external',$7,$8::text,$9::text,$10::text)`,
      [charge.nightclub_id, charge.id, charge.transaction_id, refundTxId, delta,
        charge.currency, crypto.randomUUID(), yaUsado ? null : externalId, estado,
        'hecha fuera del sistema (panel o terminal de Mercado Pago)']);
  }

  await client.query(
    `UPDATE terminal_charges
        SET refunded_amount = $2,
            status = CASE WHEN $3::boolean THEN 'refunded' ELSE status END,
            status_detail = $4::text, updated_at = now()
      WHERE id = $1`,
    [charge.id, total, completo,
      completo ? 'devuelto' : `devuelto en parte: ${total.toFixed(2)}`]);
  await record(client, {
    chargeId: charge.id, source, action: 'refund_booked', status: completo ? 'refunded' : null,
    payload: { delta, total, ledger: libroDelta, refund_transaction_id: refundTxId },
  });
  return {
    booked: true, status: completo ? 'refunded' : charge.status, amount: delta.toFixed(2),
    refund_transaction_id: refundTxId,
  };
}

/** Le pide la devolución a Mercado Pago y, si la acepta, la asienta. */
async function sendRefund(pool, refund) {
  let res;
  try {
    res = await mp.refundOrder(refund.external_order_id, { idempotencyKey: refund.idempotency_key });
  } catch (err) {
    if (err.code === 'already_refunded') {
      // Ya estaba devuelto (desde el panel, o nuestra primera petición sí entró). Se lee
      // la orden y se asienta lo que diga: la respuesta correcta es sincronizar.
      const order = await mp.getOrder(refund.external_order_id);
      if (order) {
        await apply(pool, {
          chargeId: refund.charge_id, read: mp.readOrder(order), source: 'staff', rawPayload: order,
        });
      }
      return { status: 'synced' };
    }
    if (err.status === 504) {
      // No sabemos si entró. Se queda `requested` y el repaso la reintenta con la MISMA
      // llave; Mercado Pago no devuelve dos veces con la misma llave en 24 horas.
      await record(pool, {
        chargeId: refund.charge_id, source: 'staff', action: 'refund_timeout',
        payload: { refund_id: refund.id, message: err.message },
      });
      return { status: 'pending' };
    }
    await pool.query(
      `UPDATE terminal_refunds SET status = 'failed', status_detail = $2::text, updated_at = now()
        WHERE id = $1 AND status = 'requested'`,
      [refund.id, String(err.message).slice(0, 200)]);
    await record(pool, {
      chargeId: refund.charge_id, source: 'staff', action: 'refund_failed',
      payload: { refund_id: refund.id, message: err.message, code: (err.details || {}).code || null },
    });
    throw err;
  }

  const read = mp.readOrder(res);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const found = await client.query(
      `SELECT id, nightclub_id, transaction_id, amount::text AS amount, currency, status,
              started_by, external_order_id, refunded_amount::text AS refunded_amount,
              tip_amount::text AS tip_amount
         FROM terminal_charges WHERE id = $1 FOR UPDATE`,
      [refund.charge_id]);
    const charge = found.rows[0];
    const booked = await bookRefunds(client, {
      charge, read: { ...read, mp_status: read.mp_status || 'refunded' },
      source: 'staff', staffRefundId: refund.id,
    });
    await client.query('COMMIT');
    await announce({
      nightclubId: charge.nightclub_id, chargeId: charge.id,
      status: booked.status, outcome: null, startedBy: charge.started_by,
    });
    return { status: 'accepted', booked };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Devolver un cobro con terminal, completo. Solo el gerente (lo decide la ruta).
 *
 * Dos pasos, como el cobro: primero se aparta la devolución en la base (una
 * transacción corta, y el índice único impide que dos gerentes devuelvan el mismo cobro
 * a la vez), después se le pide a Mercado Pago, y al final se asienta lo que conteste.
 */
async function requestRefund(pool, { nightclubId, chargeId, userId, reason }) {
  const client = await pool.connect();
  let refund;
  try {
    await client.query('BEGIN');
    const found = await client.query(
      `SELECT id, nightclub_id, transaction_id, amount::text AS amount, currency, status,
              external_order_id, refunded_amount::text AS refunded_amount,
              tip_amount::text AS tip_amount, settled_at
         FROM terminal_charges WHERE id = $1 AND nightclub_id = $2 FOR UPDATE`,
      [chargeId, nightclubId]);
    if (found.rowCount === 0) throw ApiError.notFound('Ese cobro no existe');
    const charge = found.rows[0];
    if (charge.status === 'refunded') throw ApiError.conflict('Ese cobro ya está devuelto');
    if (charge.status !== 'processed' || !charge.external_order_id) {
      throw ApiError.conflict('Solo se devuelve un cobro que la tarjeta ya pagó');
    }
    const pendiente = round2(chargedTotal(charge) - Number(charge.refunded_amount || 0));
    if (!(pendiente > 0)) throw ApiError.conflict('Ese cobro ya está devuelto');
    const dias = (Date.now() - new Date(charge.settled_at).getTime()) / 86400000;
    if (charge.settled_at && dias > REFUND_WINDOW_DAYS) {
      throw ApiError.unprocessable(
        `Ya pasaron más de ${REFUND_WINDOW_DAYS} días desde el cobro: Mercado Pago ya no permite devolverlo.`);
    }
    try {
      const { rows } = await client.query(
        `INSERT INTO terminal_refunds (nightclub_id, charge_id, transaction_id, amount, currency,
                                       source, reason, requested_by, idempotency_key)
         VALUES ($1,$2,$3,$4,$5,'staff',$6::text,$7,$8)
         RETURNING id, charge_id, idempotency_key`,
        [nightclubId, charge.id, charge.transaction_id, pendiente, charge.currency, reason,
          userId, crypto.randomUUID()]);
      refund = { ...rows[0], external_order_id: charge.external_order_id };
    } catch (err) {
      if (err.code === '23505') {
        throw ApiError.conflict('Ya se pidió la devolución de este cobro. Espera a que Mercado Pago conteste.');
      }
      throw err;
    }
    await record(client, {
      chargeId: charge.id, source: 'staff', action: 'refund_requested',
      payload: { refund_id: refund.id, amount: pendiente.toFixed(2), reason, by: userId },
    });
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  const result = await sendRefund(pool, refund);
  return { refundId: refund.id, ...result };
}

/** Las devoluciones de un cobro, para enseñarlas junto a él. */
async function refundsOf(runner, chargeIds) {
  if (!chargeIds.length) return new Map();
  const { rows } = await runner.query(
    `SELECT r.id, r.charge_id, r.amount::text AS amount, r.currency, r.source, r.reason,
            r.status, r.status_detail, r.created_at, u.display_name AS requested_by_name
       FROM terminal_refunds r LEFT JOIN users u ON u.id = r.requested_by
      WHERE r.charge_id = ANY($1::uuid[])
      ORDER BY r.created_at`,
    [chargeIds]);
  const out = new Map();
  for (const r of rows) {
    if (!out.has(r.charge_id)) out.set(r.charge_id, []);
    out.get(r.charge_id).push({
      id: r.id, amount: r.amount, currency: r.currency, source: r.source, reason: r.reason,
      status: r.status, status_detail: r.status_detail, created_at: r.created_at,
      requested_by: r.requested_by_name || null,
    });
  }
  return out;
}

/** El aviso a las pantallas, después de que la base ya quedó consistente. */
async function announce({ nightclubId, chargeId, status, outcome, startedBy }) {
  await events.publish({
    nightclubId,
    type: 'terminal_charge_updated',
    audience: {
      roles: ['manager', 'bartender', 'waiter', 'hostess'],
      userIds: [startedBy, outcome && outcome.tx ? outcome.tx.payer_user_id : null].filter(Boolean),
    },
    payload: { charge_id: chargeId, status },
  });
  if (outcome && outcome.tx) {
    await payments.publishConfirmed({
      nightclubId,
      payment: {
        id: chargeId,
        declared_by: startedBy,
        on_behalf_of: null,
        amount: outcome.tx.amount,
        currency: outcome.tx.currency,
        method: 'card_terminal',
      },
      ...outcome,
    });
  }
}

// ---------------------------------------------------------------- el respaldo

/**
 * El repaso: los cobros que llevan rato sin noticias.
 *
 * Existe porque el webhook es de ellos, no nuestro, y una noche de mala señal no puede
 * dejar un cobro en el limbo: el cliente ya pagó y el mesero está mirando una pantalla
 * que dice "esperando". Pregunta directamente por la orden, que es la única fuente que
 * este sistema cree de todos modos.
 */
async function sweep(pool, { limit = 20 } = {}) {
  const { rows } = await pool.query(
    `SELECT c.id, c.nightclub_id, c.transaction_id, c.terminal_id, c.external_order_id,
            c.idempotency_key, c.amount::text AS amount, c.currency, c.status, c.status_detail,
            c.started_by, c.created_at, c.expires_at,
            t.external_id AS terminal_external_id
       FROM terminal_charges c
       JOIN payment_terminals t ON t.id = c.terminal_id
      WHERE c.status IN ('creating','waiting','action_required')
        AND (c.last_polled_at IS NULL OR c.last_polled_at < now() - interval '10 seconds')
      ORDER BY c.created_at
      LIMIT $1`,
    [limit]);
  // Sin FOR UPDATE a propósito: fuera de una transacción explícita ese bloqueo dura lo
  // que dura la consulta y no serviría de nada. Lo que de verdad impide que dos
  // instancias apliquen el mismo resultado dos veces es `apply()`, que bloquea la fila
  // DENTRO de su transacción y se sale si el cobro ya está en estado final. El
  // `last_polled_at` de aquí abajo solo evita preguntarle a Mercado Pago de más.

  // En serie a proposito: son pocos y cada uno habla con Mercado Pago. Veinte
  // peticiones a la vez contra su API es la forma de que nos frene a todos.
  const results = [];
  for (const charge of rows) {
    await pool.query('UPDATE terminal_charges SET last_polled_at = now() WHERE id = $1', [charge.id]);
    try {
      if (!charge.external_order_id) {
        // Nunca supimos su id: la llamada original se cortó a media respuesta. Dentro de
        // la ventana no se hace nada, porque esa llamada puede seguir en vuelo.
        const edad = Date.now() - new Date(charge.created_at).getTime();
        if (edad < RECOVERY_WINDOW_MS) continue;

        // Pasada la ventana, se vuelve a mandar la MISMA petición con la MISMA llave.
        // Esto es lo que el encabezado de este archivo prometía y NO existía: la llave
        // se guardaba y nunca se volvía a usar, así que el cobro se marcaba `error`, y
        // `error` no está en el índice único — el mesero podía empezar un segundo cobro
        // con la primera orden todavía viva en la terminal. Mercado Pago devuelve la
        // orden que ya existe en vez de crear otra, que es justo para lo que sirve.
        try {
          const order = await mp.createPointOrder({
            terminalExternalId: charge.terminal_external_id,
            amount: charge.amount,
            currency: charge.currency,
            externalReference: charge.id,
            idempotencyKey: charge.idempotency_key,
            expirationSeconds: EXPIRATION_SECONDS,
          });
          const leida = mp.readOrder(order);
          await pool.query(
            `UPDATE terminal_charges
                SET external_order_id = $2::text, status = 'waiting', updated_at = now()
              WHERE id = $1 AND status = 'creating'`,
            [charge.id, leida.external_order_id]);
          await record(pool, {
            chargeId: charge.id, source: 'poll', action: 'recovered', status: 'waiting',
            payload: order,
          });
          results.push({ id: charge.id, status: 'waiting', recovered: true });
          continue;
        } catch (err) {
          // Sigue sin contestar. Solo se da por perdido cuando la orden ya no puede
          // estar viva en la terminal: mientras pueda estarlo, soltar el índice sería
          // permitir un segundo cobro encima del primero.
          const vencida = edad > (EXPIRATION_SECONDS * 1000) + RECOVERY_WINDOW_MS;
          await record(pool, {
            chargeId: charge.id, source: 'poll', action: 'recover_failed',
            payload: { message: err.message, expired: vencida },
          });
          if (!vencida) continue;
          await pool.query(
            `UPDATE terminal_charges SET status = 'error', status_detail = $2::text,
                    updated_at = now()
              WHERE id = $1 AND status = 'creating'`,
            [charge.id, 'sin respuesta de Mercado Pago al crearlo']);
          results.push({ id: charge.id, status: 'error' });
          continue;
        }
      }

      const order = await mp.getOrder(charge.external_order_id);
      if (!order) continue;
      const read = mp.readOrder(order);
      // Sin cambios: ni de estado ni de paso (`created` → `at_terminal` es el mismo
      // "esperando" para esta base, pero sí es algo que la pantalla quiere saber).
      if (!read.is_final && read.status === charge.status
        && read.status_detail === charge.status_detail) continue;

      const applied = await apply(pool, {
        chargeId: charge.id, read, source: 'poll', rawPayload: order,
      });
      if (applied.changed) {
        await announce({
          nightclubId: charge.nightclub_id,
          chargeId: charge.id,
          status: applied.status,
          outcome: applied.outcome,
          startedBy: charge.started_by,
        });
      }
      results.push({ id: charge.id, status: read.status });
    } catch (err) {
      // Un cobro que no se pudo consultar no puede detener el repaso de los demás.
      await record(pool, {
        chargeId: charge.id, source: 'poll', action: 'poll_failed',
        payload: { message: err.message },
      });
    }
  }

  // Las devoluciones cuya respuesta se perdió. Se reintentan con la MISMA llave: Mercado
  // Pago la respeta 24 horas, así que reintentar no devuelve dos veces.
  const colgadas = await pool.query(
    `SELECT r.id, r.charge_id, r.idempotency_key, c.external_order_id
       FROM terminal_refunds r JOIN terminal_charges c ON c.id = r.charge_id
      WHERE r.status = 'requested' AND r.source = 'staff'
        AND r.last_attempt_at < now() - make_interval(secs => $1)
      ORDER BY r.created_at
      LIMIT $2`,
    [Math.round(RECOVERY_WINDOW_MS / 1000), limit]);
  for (const refund of colgadas.rows) {
    await pool.query('UPDATE terminal_refunds SET last_attempt_at = now() WHERE id = $1', [refund.id]);
    try {
      const r = await sendRefund(pool, refund);
      results.push({ refund_id: refund.id, status: r.status });
    } catch {
      results.push({ refund_id: refund.id, status: 'failed' });
    }
  }
  return results;
}

module.exports = {
  CHARGE_SELECT, EXPIRATION_SECONDS, RECOVERY_WINDOW_MS, REFUND_WINDOW_DAYS,
  present, record, reserve, push, apply, announce, sweep,
  bookRefunds, requestRefund, refundsOf,
};
