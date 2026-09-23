/**
 * EV2 — el corte de turno de quien cobra (D51).
 *
 * Responde una sola pregunta, y la responde con números que no puso quien cobra:
 * **cuánto dinero del club trae encima esta persona ahora mismo.**
 *
 * ---------------------------------------------------------------------------
 * De dónde sale lo cobrado
 * ---------------------------------------------------------------------------
 * De tres sitios, porque el dinero entra por tres puertas distintas y ninguna de las
 * tres se puede omitir sin que el corte mienta:
 *
 *   1. `manual_payments` confirmados que declaró esa persona: el efectivo de la mesa
 *      y los vouchers de la terminal del banco.
 *   2. `terminal_charges` que esa persona empezó y que Mercado Pago dio por pagados,
 *      menos lo devuelto. No es efectivo: es dinero que ya está en la cuenta del
 *      club, y por eso se enseña pero no se le pide entregarlo.
 *   3. `door_admissions` que esa persona vendió. El cover de la puerta casi siempre
 *      es efectivo y lo cobra la misma persona que recibe.
 *
 * Nada de esto lo teclea nadie: son las filas que ya existen, contadas por quien las
 * cobró y por el método con el que se cobraron. Lo ÚNICO que teclea una persona en
 * todo el corte es cuánto efectivo entrega, y lo único que teclea la otra es cuánto
 * contó. La diferencia entre esos dos números es el corte.
 *
 * ---------------------------------------------------------------------------
 * Por qué la propina va aparte y sin sumarse
 * ---------------------------------------------------------------------------
 * Porque no es del club. Sumarla a lo que la persona entrega la convertiría en un
 * faltante suyo al final de la noche; no enseñarla haría que el corte pareciera
 * incompleto justo para quien más lo mira. Va en su propio renglón.
 */
'use strict';

const { ApiError } = require('../middleware/errors');

/** Lo que el club espera recibir en la mano al final del turno. */
const CASH_METHODS = ['cash'];

/** Puestos que cobran y, por lo tanto, hacen corte. */
const COLLECTING_ROLES = ['waiter', 'bartender', 'hostess'];

const round2 = (n) => Math.round(Number(n || 0) * 100) / 100;
const money = (n) => round2(n).toFixed(2);

/**
 * Lo que una persona cobró entre dos momentos, por método de pago y por concepto.
 *
 * `to` puede ser null: significa "hasta ahora", que es lo que mira alguien a media
 * noche para saber cuánto trae encima.
 */
async function collected(runner, { nightclubId, userId, from, to = null }) {
  const hasta = to || new Date();
  const params = [nightclubId, userId, from, hasta];

  const [manuales, terminal, puerta, propinas] = await Promise.all([
    // 1. Pagos que esa persona registró: efectivo en la mesa y vouchers de terminal.
    runner.query(
      `SELECT p.method, p.currency,
              count(*)::int AS count,
              COALESCE(sum(p.amount), 0)::numeric(12,2)::text AS amount
         FROM manual_payments p
        WHERE p.nightclub_id = $1 AND p.declared_by = $2 AND p.status = 'confirmed'
          AND p.created_at >= $3 AND p.created_at <= $4
        GROUP BY p.method, p.currency`, params),
    // 2. Cobros con la terminal de Mercado Pago, menos lo devuelto.
    runner.query(
      `SELECT c.currency,
              count(*)::int AS count,
              COALESCE(sum(c.amount - LEAST(c.refunded_amount, c.amount)), 0)::numeric(12,2)::text
                AS amount
         FROM terminal_charges c
        WHERE c.nightclub_id = $1 AND c.started_by = $2
          AND c.status IN ('processed','refunded')
          AND c.created_at >= $3 AND c.created_at <= $4
        GROUP BY c.currency`, params),
    // 3. El cover que vendió en la puerta. La cortesía no es dinero.
    runner.query(
      `SELECT d.payment_method AS method, d.currency,
              count(*)::int AS count,
              COALESCE(sum(d.total), 0)::numeric(12,2)::text AS amount,
              COALESCE(sum(d.quantity), 0)::int AS people
         FROM door_admissions d
        WHERE d.nightclub_id = $1 AND d.sold_by = $2 AND d.payment_method <> 'courtesy'
          AND d.created_at >= $3 AND d.created_at <= $4
        GROUP BY d.payment_method, d.currency`, params),
    // La propina de la noche. NO es del club: va aparte y no se entrega.
    runner.query(
      `SELECT t.currency, count(*)::int AS count,
              COALESCE(sum(t.amount), 0)::numeric(12,2)::text AS amount
         FROM tips t
        WHERE t.nightclub_id = $1 AND t.to_user_id = $2
          AND t.created_at >= $3 AND t.created_at <= $4
        GROUP BY t.currency`, params),
  ]);

  const porMetodo = new Map();
  const suma = (method, currency, amount, count) => {
    const clave = `${method}|${currency}`;
    const actual = porMetodo.get(clave)
      || { method, currency, amount: 0, count: 0 };
    actual.amount = round2(actual.amount + Number(amount));
    actual.count += count;
    porMetodo.set(clave, actual);
  };

  for (const r of manuales.rows) suma(r.method, r.currency, r.amount, r.count);
  for (const r of terminal.rows) suma('card_terminal', r.currency, r.amount, r.count);
  // La puerta habla en su propio vocabulario (`card`, `transfer`); se traduce al del
  // libro para que el corte no tenga dos renglones que significan lo mismo.
  const DOOR_METHOD = { cash: 'cash', card: 'card_terminal', transfer: 'bank_transfer' };
  for (const r of puerta.rows) suma(DOOR_METHOD[r.method] || r.method, r.currency, r.amount, r.count);

  const lineas = [...porMetodo.values()]
    .map((l) => ({ ...l, amount: money(l.amount) }))
    .sort((a, b) => a.method.localeCompare(b.method));

  const currency = lineas[0] ? lineas[0].currency
    : (propinas.rows[0] ? propinas.rows[0].currency : 'MXN');
  const efectivo = lineas
    .filter((l) => CASH_METHODS.includes(l.method))
    .reduce((n, l) => round2(n + Number(l.amount)), 0);
  const total = lineas.reduce((n, l) => round2(n + Number(l.amount)), 0);

  return {
    from,
    to: hasta,
    currency,
    by_method: lineas,
    // Cuántos cobros hizo y a cuánta gente dejó entrar: lo que la persona reconoce
    // de su propia noche antes de discutir un número.
    payments_count: lineas.reduce((n, l) => n + l.count, 0),
    door_people: puerta.rows.reduce((n, r) => n + Number(r.people || 0), 0),
    cash_collected: money(efectivo),
    total_collected: money(total),
    tips: {
      amount: money(propinas.rows.reduce((n, r) => round2(n + Number(r.amount)), 0)),
      count: propinas.rows.reduce((n, r) => n + r.count, 0),
    },
  };
}

/** Las entregas parciales de un turno. */
async function dropsOf(runner, shiftId) {
  const { rows } = await runner.query(
    `SELECT d.id, d.amount::text AS amount, d.counted_amount::text AS counted_amount,
            d.currency, d.note, d.status, d.rejection_reason, d.created_at, d.received_at,
            u.display_name AS received_by_name
       FROM shift_cash_drops d
       LEFT JOIN users u ON u.id = d.received_by
      WHERE d.shift_id = $1
      ORDER BY d.created_at`,
    [shiftId]);
  return rows.map((r) => ({
    id: r.id,
    amount: r.amount,
    counted_amount: r.counted_amount,
    currency: r.currency,
    note: r.note,
    status: r.status,
    rejection_reason: r.rejection_reason,
    created_at: r.created_at,
    received_at: r.received_at,
    received_by: r.received_by_name || null,
  }));
}

/**
 * Lo entregado y ya contado. Solo cuenta lo que el gerente contó, no lo declarado:
 * hasta que alguien lo cuenta, ese dinero sigue siendo responsabilidad de quien lo
 * trae.
 */
const receivedTotal = (drops) => money(drops
  .filter((d) => d.status === 'received')
  .reduce((n, d) => round2(n + Number(d.counted_amount || 0)), 0));

const pendingDrops = (drops) => drops.filter((d) => d.status === 'declared');

/** El estado del corte de un turno: lo cobrado, lo entregado y lo que falta entregar. */
async function shiftSummary(runner, { nightclubId, shift }) {
  const totals = await collected(runner, {
    nightclubId, userId: shift.user_id, from: shift.started_at, to: shift.ended_at,
  });
  const drops = await dropsOf(runner, shift.id);
  const entregado = receivedTotal(drops);
  const { rows } = await runner.query(
    `SELECT id, status, declared_cash::text AS declared_cash, counted_cash::text AS counted_cash,
            difference::text AS difference, difference_reason, declared_at, confirmed_at
       FROM shift_closings WHERE shift_id = $1`, [shift.id]);
  return {
    shift: {
      id: shift.id,
      user_id: shift.user_id,
      section: shift.section,
      started_at: shift.started_at,
      ended_at: shift.ended_at,
    },
    totals,
    drops,
    drops_received: entregado,
    drops_pending: pendingDrops(drops).length,
    // Lo que tiene que entregar ahora mismo.
    cash_to_hand: money(round2(Number(totals.cash_collected) - Number(entregado))),
    closing: rows[0] || null,
  };
}

/**
 * Declara el corte: el empleado dice cuánto efectivo entrega.
 *
 * NO cierra el turno. El turno se cierra cuando el gerente cuenta el dinero y
 * confirma: mientras nadie lo haya contado, ese dinero sigue siendo de quien lo trae,
 * y un turno cerrado diría lo contrario.
 */
async function declare(client, { nightclubId, shift, role, declaredCash, notes }) {
  const resumen = await shiftSummary(client, { nightclubId, shift });
  if (resumen.closing) {
    throw ApiError.conflict(resumen.closing.status === 'confirmed'
      ? 'El corte de ese turno ya está confirmado'
      : 'Ya declaraste tu corte: falta que el gerente lo cuente');
  }
  const esperado = Number(resumen.cash_to_hand);
  const { rows } = await client.query(
    `INSERT INTO shift_closings (nightclub_id, shift_id, user_id, role, started_at, ended_at,
                                 currency, totals, cash_collected, drops_total, expected_cash,
                                 declared_cash, declared_notes)
     VALUES ($1,$2,$3,$4::text,$5,COALESCE($6, now()),$7::text,$8::jsonb,$9,$10,$11,$12,$13)
     RETURNING id`,
    [nightclubId, shift.id, shift.user_id, role, shift.started_at, shift.ended_at,
      resumen.totals.currency, JSON.stringify(resumen.totals), resumen.totals.cash_collected,
      resumen.drops_received, esperado.toFixed(2), Number(declaredCash).toFixed(2),
      notes || null]);
  return { id: rows[0].id, expected_cash: money(esperado) };
}

/**
 * El gerente cuenta el dinero y cierra el turno.
 *
 * La diferencia se calcula contra lo ESPERADO, no contra lo declarado: si el empleado
 * declara de menos y entrega de menos, el corte tiene que verlo igual.
 */
async function confirm(client, { nightclubId, closingId, countedCash, reason, managerId }) {
  const { rows } = await client.query(
    `SELECT c.id, c.shift_id, c.user_id, c.expected_cash::text AS expected_cash, c.status,
            c.currency
       FROM shift_closings c
      WHERE c.id = $1 AND c.nightclub_id = $2 FOR UPDATE`,
    [closingId, nightclubId]);
  if (rows.length === 0) throw ApiError.notFound('Ese corte no existe');
  const corte = rows[0];
  if (corte.status === 'confirmed') throw ApiError.conflict('Ese corte ya está confirmado');

  const pendientes = pendingDrops(await dropsOf(client, corte.shift_id));
  if (pendientes.length > 0) {
    throw ApiError.unprocessable(
      `Hay ${pendientes.length} entrega(s) de efectivo sin contar en ese turno. `
      + 'Recíbelas o recházalas antes de cerrar el corte.',
      { pending_drops: pendientes.map((d) => d.id) });
  }

  const diferencia = round2(Number(countedCash) - Number(corte.expected_cash));
  if (diferencia !== 0 && !reason) {
    throw ApiError.unprocessable(
      `${diferencia < 0 ? 'Falta' : 'Sobra'} dinero (${Math.abs(diferencia).toFixed(2)}). `
      + 'Escribe el motivo: un faltante sin explicación es lo que este corte existe para evitar.');
  }

  await client.query(
    `UPDATE shift_closings
        SET counted_cash = $2, difference = $3, difference_reason = $4::text,
            status = 'confirmed', confirmed_by = $5, confirmed_at = now(), updated_at = now()
      WHERE id = $1`,
    [corte.id, Number(countedCash).toFixed(2), diferencia.toFixed(2), reason || null, managerId]);

  // El corte es el último paso del turno: al confirmarlo, el turno queda cerrado.
  await client.query(
    'UPDATE staff_shifts SET ended_at = COALESCE(ended_at, now()) WHERE id = $1',
    [corte.shift_id]);

  return { difference: money(diferencia), userId: corte.user_id, shiftId: corte.shift_id };
}

module.exports = {
  CASH_METHODS, COLLECTING_ROLES,
  collected, dropsOf, receivedTotal, pendingDrops, shiftSummary, declare, confirm, money, round2,
};
