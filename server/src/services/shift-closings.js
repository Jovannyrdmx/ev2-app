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
            d.reason, d.authorized_at, d.authorized_role,
            u.display_name AS received_by_name,
            a.display_name AS authorized_by_name
       FROM shift_cash_drops d
       LEFT JOIN users u ON u.id = d.received_by
       LEFT JOIN users a ON a.id = d.authorized_by
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
    // Por qué salió ese dinero y quién lo autorizó (D54). Van juntos a propósito:
    // un motivo sin nombre detrás es una frase que cualquiera pudo escribir.
    reason: r.reason,
    authorized_by: r.authorized_by_name || null,
    authorized_role: r.authorized_role,
    authorized_at: r.authorized_at,
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
 * Un retiro parcial de efectivo, autorizado en el acto (D54).
 *
 * El gerente está ahí tecleando su código, así que recibe el dinero en ese mismo
 * momento: el retiro nace `received`, con lo contado igual a lo entregado y con su
 * nombre. No tiene sentido dejarlo "pendiente de contar" cuando quien lo contaría
 * acaba de firmar que lo tiene en la mano.
 *
 * `authorizer` ya viene verificado por `manager-auth`: aquí no se ve ningún PIN.
 */
async function withdraw(client, {
  nightclubId, shift, amount, reason, authorizer, currency = 'MXN',
}) {
  const resumen = await shiftSummary(client, { nightclubId, shift });
  if (resumen.closing) throw ApiError.conflict('Ese turno ya tiene su corte hecho');

  const monto = round2(Number(amount));
  const disponible = Number(resumen.cash_to_hand);
  if (!Number.isFinite(monto) || monto <= 0) {
    throw ApiError.unprocessable('El monto del retiro tiene que ser mayor que cero');
  }
  // Retirar de más no es un descuido: o el número está mal tecleado, o ese dinero no
  // es del club. Las dos cosas se paran antes de que alguien suelte los billetes.
  if (monto > disponible) {
    throw ApiError.unprocessable(
      `Solo trae ${money(disponible)} en efectivo del club; no se pueden retirar ${money(monto)}.`,
      { available: money(disponible) });
  }

  const { rows } = await client.query(
    `INSERT INTO shift_cash_drops
       (nightclub_id, shift_id, user_id, amount, currency, reason, status,
        counted_amount, received_by, received_at,
        authorized_by, authorized_at, authorized_role)
     VALUES ($1,$2,$3,$4,$5::text,$6::text,'received',$4,$7, now(), $7, now(), $8::text)
     RETURNING id`,
    [nightclubId, shift.id, shift.user_id, monto.toFixed(2), currency,
      String(reason).trim(), authorizer.id, authorizer.role]);

  return {
    id: rows[0].id,
    amount: money(monto),
    remaining: money(round2(disponible - monto)),
    authorized_by: authorizer.name,
  };
}

/**
 * El corte del turno, en un solo acto (D54).
 *
 * El empleado declara lo que entrega, el gerente cuenta delante de él y teclea su
 * código, y ahí queda cerrado. Antes eran dos pasos —declarar y, después, que el
 * gerente confirmara en su panel—; el dueño pidió que fuera uno, porque en la barra
 * es uno: el gerente ya está parado ahí con el dinero en la mano.
 *
 * Lo que NO cambió, porque es el punto entero de la función:
 *
 *   * Lo cobrado no lo teclea nadie: sale de lo que esa persona de verdad cobró.
 *   * La diferencia se mide contra lo que le TOCABA entregar, no contra lo que
 *     declaró. Medir contra lo declarado sería el agujero obvio: declarar de menos y
 *     entregar de menos cuadraría perfecto.
 *   * Quien entrega no autoriza. Lo impide `manager-auth`, y también la base.
 */
async function close(client, {
  nightclubId, shift, role, declaredCash, countedCash, reason, notes, authorizer,
}) {
  const resumen = await shiftSummary(client, { nightclubId, shift });
  if (resumen.closing) {
    throw ApiError.conflict('El corte de ese turno ya está hecho');
  }
  const pendientes = pendingDrops(resumen.drops);
  if (pendientes.length > 0) {
    throw ApiError.unprocessable(
      `Hay ${pendientes.length} retiro(s) de efectivo sin contar en ese turno.`,
      { pending_drops: pendientes.map((d) => d.id) });
  }

  const esperado = Number(resumen.cash_to_hand);
  const contado = round2(Number(countedCash));
  const diferencia = round2(contado - esperado);
  if (diferencia !== 0 && (!reason || String(reason).trim().length < 5)) {
    throw ApiError.unprocessable(
      `${diferencia < 0 ? 'Falta' : 'Sobra'} dinero (${money(Math.abs(diferencia))}). `
      + 'Escribe el motivo: un faltante sin explicación es lo que este corte existe para evitar.',
      { difference: money(diferencia), expected: money(esperado) });
  }

  const { rows } = await client.query(
    `INSERT INTO shift_closings (nightclub_id, shift_id, user_id, role, started_at, ended_at,
                                 currency, totals, cash_collected, drops_total, expected_cash,
                                 declared_cash, declared_notes,
                                 counted_cash, difference, difference_reason,
                                 status, confirmed_by, confirmed_at,
                                 authorized_by, authorized_at, authorized_role)
     VALUES ($1,$2,$3,$4::text,$5,COALESCE($6, now()),$7::text,$8::jsonb,$9,$10,$11,$12,$13,
             $14,$15,$16::text,'confirmed',$17, now(), $17, now(), $18::text)
     RETURNING id`,
    [nightclubId, shift.id, shift.user_id, role, shift.started_at, shift.ended_at,
      resumen.totals.currency, JSON.stringify(resumen.totals), resumen.totals.cash_collected,
      resumen.drops_received, esperado.toFixed(2), round2(Number(declaredCash)).toFixed(2),
      notes || null,
      contado.toFixed(2), diferencia.toFixed(2), reason ? String(reason).trim() : null,
      authorizer.id, authorizer.role]);

  // El corte es el último paso del turno: al cerrarlo, el turno queda cerrado.
  await client.query(
    'UPDATE staff_shifts SET ended_at = COALESCE(ended_at, now()) WHERE id = $1', [shift.id]);

  return {
    id: rows[0].id,
    expected_cash: money(esperado),
    counted_cash: money(contado),
    difference: money(diferencia),
    authorized_by: authorizer.name,
  };
}

module.exports = {
  CASH_METHODS, COLLECTING_ROLES,
  collected, dropsOf, receivedTotal, pendingDrops, shiftSummary,
  withdraw, close, money, round2,
};
