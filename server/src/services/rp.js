// El RP y su comision (D98, migracion 052).
//
// Aqui vive toda la regla: quien es el RP de un codigo, a que se le atribuye una mesa
// o un cover, cuanto se le debe por una noche y como se liquida. Las rutas de la puerta
// y del gerente solo llaman a estas funciones, para que ninguna invente su propia
// version de "cuanto consumieron los invitados del RP".
//
// Que cuenta como consumo de una mesa (todo lo PAGADO esa noche en esa mesa):
//   * pedidos de bebidas y botellas con el cobro `paid`, hechos en la ventana de la
//     noche (igual que el credito VIP), sin los cancelados, menos lo devuelto en parte;
//   * incluye lo pagado con Credito VIP: es consumo, el deposito no.
// Que cuenta de un cover: lo cobrado en esa venta (una cortesia no suma).
// Propinas, depositos de reservacion y devoluciones completas no cuentan.
'use strict';

const crypto = require('crypto');
const { ApiError } = require('../middleware/errors');
const eventPricing = require('./event-pricing');

const ROLE = 'rp';
const DEFAULT_PCT = 10;
// Sin 0/O, 1/I/L: el codigo se dicta en voz alta y se teclea con prisa.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const round2 = (n) => Math.round(Number(n || 0) * 100) / 100;
const money = (n) => round2(n).toFixed(2);

const normalize = (code) => String(code || '').trim().toUpperCase().replace(/[\s-]/g, '');

function randomCode(len = 6) {
  let out = '';
  for (let i = 0; i < len; i += 1) out += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return out;
}

/** El perfil de RP de un usuario, creandolo con un codigo libre si no tiene. */
async function ensureProfile(client, { nightclubId, userId }) {
  const have = await client.query('SELECT user_id FROM rp_profiles WHERE user_id = $1', [userId]);
  if (have.rowCount > 0) return;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const ins = await client.query(
      `INSERT INTO rp_profiles (user_id, nightclub_id, code, commission_pct)
       VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING user_id`,
      [userId, nightclubId, randomCode(), DEFAULT_PCT]);
    if (ins.rowCount > 0) return;
    // O el codigo choco, o otro proceso creo el perfil.
    const now = await client.query('SELECT 1 FROM rp_profiles WHERE user_id = $1', [userId]);
    if (now.rowCount > 0) return;
  }
  throw new Error('rp: no se pudo generar un codigo libre');
}

/** El RP activo dueno de un codigo, o null. */
async function findByCode(runner, { nightclubId, code }) {
  const c = normalize(code);
  if (!c) return null;
  const { rows } = await runner.query(
    `SELECT p.user_id, p.code, p.commission_pct::text AS commission_pct, u.display_name
       FROM rp_profiles p JOIN users u ON u.id = p.user_id
      LEFT JOIN employee_profiles ep ON ep.user_id = u.id
      WHERE p.nightclub_id = $1 AND p.code = $2 AND p.active AND u.status = 'active'
        AND COALESCE(ep.active, true) AND u.role = $3`,
    [nightclubId, c, ROLE]);
  return rows[0] || null;
}

/** La noche en curso (o la que abre pronto), para ventas de cover sin evento indicado. */
async function currentEventId(runner, { nightclubId }) {
  const { rows } = await runner.query(
    `SELECT id FROM events_calendar
      WHERE nightclub_id = $1 AND status NOT IN ('cancelled','finished')
        AND doors_open_at <= now() + interval '12 hours'
        AND COALESCE(closes_at, doors_open_at + interval '8 hours') > now()
      ORDER BY doors_open_at LIMIT 1`, [nightclubId]);
  return rows[0] ? rows[0].id : null;
}

async function audit(client, { nightclubId, actorId, action, entityId, after }) {
  await client.query(
    `INSERT INTO audit_log (nightclub_id, actor_id, action, entity, entity_id, after)
     VALUES ($1,$2,$3,'rp_attribution',$4,$5)`,
    [nightclubId, actorId || null, action, entityId, JSON.stringify(after || {})]);
}

/**
 * Liga una reservacion (mesa) de la noche a un RP por su codigo.
 * Devuelve `{ ok, reason, rp }`; un codigo malo NO es un error: la persona entra igual
 * y la puerta lo corrige despues. Nunca cambia un RP ya puesto (eso lo corrige el gerente).
 */
async function attachToReservation(client, { nightclubId, reservationId, code, actorId }) {
  const rp = await findByCode(client, { nightclubId, code });
  if (!rp) return { ok: false, reason: 'unknown_code' };
  const r = await client.query(
    `SELECT id, event_id, status FROM reservations
      WHERE id = $1 AND nightclub_id = $2`, [reservationId, nightclubId]);
  if (r.rowCount === 0) return { ok: false, reason: 'no_reservation' };
  const res = r.rows[0];
  if (!res.event_id) return { ok: false, reason: 'no_event' };
  if (['cancelled', 'no_show'].includes(res.status)) return { ok: false, reason: 'reservation_closed' };

  const cur = await client.query(
    'SELECT rp_user_id FROM rp_attributions WHERE reservation_id = $1', [reservationId]);
  if (cur.rowCount > 0) {
    return cur.rows[0].rp_user_id === rp.user_id
      ? { ok: true, already: true, rp }
      : { ok: false, reason: 'has_other_rp' };
  }
  const ins = await client.query(
    `INSERT INTO rp_attributions (nightclub_id, rp_user_id, event_id, kind, reservation_id,
                                  commission_pct, created_by)
     VALUES ($1,$2,$3,'table',$4,$5,$6) RETURNING id`,
    [nightclubId, rp.user_id, res.event_id, reservationId, rp.commission_pct, actorId || null]);
  await audit(client, { nightclubId, actorId, action: 'rp.attach_table', entityId: ins.rows[0].id,
    after: { rp_user_id: rp.user_id, reservation_id: reservationId } });
  return { ok: true, rp };
}

/** Liga una venta de cover a un RP. */
async function attachToAdmission(client, { nightclubId, admissionId, eventId, code, actorId }) {
  const rp = await findByCode(client, { nightclubId, code });
  if (!rp) return { ok: false, reason: 'unknown_code' };
  const event = eventId || await currentEventId(client, { nightclubId });
  if (!event) return { ok: false, reason: 'no_event' };
  const ins = await client.query(
    `INSERT INTO rp_attributions (nightclub_id, rp_user_id, event_id, kind, admission_id,
                                  commission_pct, created_by)
     VALUES ($1,$2,$3,'cover',$4,$5,$6) RETURNING id`,
    [nightclubId, rp.user_id, event, admissionId, rp.commission_pct, actorId || null]);
  await audit(client, { nightclubId, actorId, action: 'rp.attach_cover', entityId: ins.rows[0].id,
    after: { rp_user_id: rp.user_id, admission_id: admissionId } });
  return { ok: true, rp };
}

/** El gerente cambia (o quita) el RP de una mesa. Queda en la bitacora con el motivo. */
async function reassignReservation(client, { nightclubId, reservationId, code, actorId, reason }) {
  const cur = await client.query(
    `SELECT a.id, a.rp_user_id, a.event_id FROM rp_attributions a
      WHERE a.reservation_id = $1 AND a.nightclub_id = $2 FOR UPDATE`, [reservationId, nightclubId]);
  const before = cur.rows[0] || null;
  if (before) {
    const done = await client.query(
      'SELECT 1 FROM rp_settlements WHERE rp_user_id = $1 AND event_id = $2 LIMIT 1',
      [before.rp_user_id, before.event_id]);
    if (done.rowCount > 0) {
      throw ApiError.conflict('Esa noche ya se liquidó a ese RP: no se puede cambiar el RP de la mesa.');
    }
  }
  if (!code) {
    if (!before) return { removed: false };
    await client.query('DELETE FROM rp_attributions WHERE id = $1', [before.id]);
    await audit(client, { nightclubId, actorId, action: 'rp.remove_table', entityId: before.id,
      after: { reservation_id: reservationId, reason } });
    return { removed: true };
  }
  const rp = await findByCode(client, { nightclubId, code });
  if (!rp) throw ApiError.unprocessable('Ese código de RP no existe o el RP está inactivo');
  if (before) {
    await client.query(
      'UPDATE rp_attributions SET rp_user_id = $2, commission_pct = $3 WHERE id = $1',
      [before.id, rp.user_id, rp.commission_pct]);
    await audit(client, { nightclubId, actorId, action: 'rp.reassign_table', entityId: before.id,
      after: { from: before.rp_user_id, to: rp.user_id, reservation_id: reservationId, reason } });
    return { rp };
  }
  const out = await attachToReservation(client, { nightclubId, reservationId, code, actorId });
  if (!out.ok) throw ApiError.unprocessable('No se pudo ligar el RP a esa reservación');
  return { rp };
}

// ---------------------------------------------------------------- el calculo

/** Lo consumido por cada atribucion de una noche (y de un RP, si se indica). */
async function lines(runner, { nightclubId, eventId, rpUserId = null }) {
  const { rows } = await runner.query(
    `WITH base AS (
       -- mesas: todo lo pagado en la mesa durante la noche
       SELECT a.id AS attribution_id, tx.currency,
              sum(tx.amount - COALESCE(rf.refunded, 0)) AS base,
              count(DISTINCT o.id) AS items
         FROM rp_attributions a
         JOIN reservations r ON r.id = a.reservation_id
         JOIN events_calendar e ON e.id = a.event_id
         JOIN drink_orders o ON o.table_id = r.table_id AND o.nightclub_id = a.nightclub_id
          AND o.status <> 'cancelled'
          AND o.created_at >= e.doors_open_at - interval '6 hours'
          AND o.created_at < COALESCE(e.closes_at, e.doors_open_at + interval '8 hours')
         JOIN transactions tx ON tx.reference_type = 'drink_order' AND tx.reference_id = o.id
          AND tx.direction = 'in' AND tx.status = 'paid'
          AND tx.type IN ('drink_order','bottle_service')
         LEFT JOIN LATERAL (
           SELECT sum(f.amount) AS refunded FROM transactions f
            WHERE f.type = 'refund' AND f.direction = 'out' AND f.status = 'paid'
              AND f.reference_type = 'transaction' AND f.reference_id = tx.id
         ) rf ON true
        WHERE a.nightclub_id = $1 AND a.event_id = $2 AND a.kind = 'table'
        GROUP BY a.id, tx.currency
       UNION ALL
       -- cover: lo cobrado en la venta
       SELECT a.id, d.currency, d.total, d.quantity
         FROM rp_attributions a
         JOIN door_admissions d ON d.id = a.admission_id
        WHERE a.nightclub_id = $1 AND a.event_id = $2 AND a.kind = 'cover'
          AND d.payment_method <> 'courtesy' AND d.total > 0
     )
     SELECT a.id AS attribution_id, a.rp_user_id, a.kind, a.commission_pct::text AS commission_pct,
            b.currency, b.base::numeric(12,2)::text AS base, b.items::int AS items,
            round(b.base * a.commission_pct / 100, 2)::text AS commission,
            t.code AS table_code, t.section AS table_section,
            rr.guest_count, d.quantity AS cover_quantity
       FROM base b
       JOIN rp_attributions a ON a.id = b.attribution_id
       LEFT JOIN reservations rr ON rr.id = a.reservation_id
       LEFT JOIN tables t ON t.id = rr.table_id
       LEFT JOIN door_admissions d ON d.id = a.admission_id
      WHERE ($3::uuid IS NULL OR a.rp_user_id = $3::uuid)
      ORDER BY a.created_at, b.currency`,
    [nightclubId, eventId, rpUserId]);
  return rows;
}

const totalsByCurrency = (rows) => {
  const m = new Map();
  for (const r of rows) {
    const t = m.get(r.currency) || { currency: r.currency, base: 0, commission: 0 };
    t.base = round2(t.base + Number(r.base));
    t.commission = round2(t.commission + Number(r.commission));
    m.set(r.currency, t);
  }
  return [...m.values()].map((t) => ({ ...t, base: money(t.base), commission: money(t.commission) }));
};

async function eventRow(runner, { nightclubId, eventId }) {
  const { rows } = await runner.query(
    `SELECT id, name, event_date, doors_open_at, closes_at FROM events_calendar
      WHERE id = $1 AND nightclub_id = $2`, [eventId, nightclubId]);
  return rows[0] || null;
}

/** Una noche de un RP: sus mesas y covers, lo consumido, lo que lleva y si ya se liquido. */
async function nightReport(runner, { nightclubId, eventId, rpUserId }) {
  const ev = await eventRow(runner, { nightclubId, eventId });
  if (!ev) throw ApiError.notFound('Noche no encontrada');
  const ls = await lines(runner, { nightclubId, eventId, rpUserId });
  const sets = await runner.query(
    `SELECT currency, base::text AS base, amount::text AS amount, created_at
       FROM rp_settlements WHERE nightclub_id = $1 AND event_id = $2 AND rp_user_id = $3`,
    [nightclubId, eventId, rpUserId]);
  return {
    event: ev,
    night_over: eventPricing.nightIsOver(ev),
    lines: ls,
    totals: totalsByCurrency(ls),
    settlements: sets.rows,
  };
}

/** La noche que le toca ver a un RP: la ultima con atribuciones suyas. */
async function latestEventFor(runner, { nightclubId, rpUserId }) {
  const { rows } = await runner.query(
    `SELECT a.event_id FROM rp_attributions a JOIN events_calendar e ON e.id = a.event_id
      WHERE a.nightclub_id = $1 AND a.rp_user_id = $2
      ORDER BY e.doors_open_at DESC LIMIT 1`, [nightclubId, rpUserId]);
  return rows[0] ? rows[0].event_id : null;
}

/** Cada RP con lo que lleva en una noche (para la pantalla del gerente). */
async function summary(runner, { nightclubId, eventId }) {
  const ev = await eventRow(runner, { nightclubId, eventId });
  if (!ev) throw ApiError.notFound('Noche no encontrada');
  const ls = await lines(runner, { nightclubId, eventId });
  const sets = await runner.query(
    `SELECT rp_user_id, currency, amount::text AS amount FROM rp_settlements
      WHERE nightclub_id = $1 AND event_id = $2`, [nightclubId, eventId]);
  const byRp = new Map();
  for (const l of ls) {
    const e = byRp.get(l.rp_user_id) || { rp_user_id: l.rp_user_id, lines: [] };
    e.lines.push(l);
    byRp.set(l.rp_user_id, e);
  }
  const names = await runner.query(
    `SELECT p.user_id, p.code, u.display_name FROM rp_profiles p JOIN users u ON u.id = p.user_id
      WHERE p.nightclub_id = $1`, [nightclubId]);
  const nameOf = new Map(names.rows.map((n) => [n.user_id, n]));
  return {
    event: ev,
    night_over: eventPricing.nightIsOver(ev),
    rps: [...byRp.values()].map((e) => ({
      rp_user_id: e.rp_user_id,
      display_name: (nameOf.get(e.rp_user_id) || {}).display_name || null,
      code: (nameOf.get(e.rp_user_id) || {}).code || null,
      tables: e.lines.filter((l) => l.kind === 'table').length,
      covers: e.lines.filter((l) => l.kind === 'cover').length,
      totals: totalsByCurrency(e.lines),
      settled: sets.rows.filter((s) => s.rp_user_id === e.rp_user_id)
        .map((s) => ({ currency: s.currency, amount: s.amount })),
    })),
  };
}

/**
 * Liquida una noche a un RP: abona la comision a su saldo (una fila `rp_commission`
 * en el libro, que el portal del empleado ya suma y deja retirar). Solo cuando la
 * noche termino: antes el consumo todavia puede crecer o cancelarse.
 */
async function settle(client, { nightclubId, rpUserId, eventId, settledBy, note = null }) {
  const ev = await eventRow(client, { nightclubId, eventId });
  if (!ev) throw ApiError.notFound('Noche no encontrada');
  if (!eventPricing.nightIsOver(ev)) {
    throw ApiError.conflict('La noche todavía no termina: la comisión se liquida al cerrarla.');
  }
  const rp = await client.query(
    `SELECT u.id FROM users u WHERE u.id = $1 AND u.nightclub_id = $2 AND u.role = $3 FOR UPDATE`,
    [rpUserId, nightclubId, ROLE]);
  if (rp.rowCount === 0) throw ApiError.notFound('RP no encontrado');

  const ls = await lines(client, { nightclubId, eventId, rpUserId });
  const totals = totalsByCurrency(ls).filter((t) => Number(t.commission) > 0);
  if (totals.length === 0) throw ApiError.unprocessable('Ese RP no generó comisión esa noche');

  const done = [];
  for (const t of totals) {
    const dup = await client.query(
      `SELECT 1 FROM rp_settlements WHERE rp_user_id = $1 AND event_id = $2 AND currency = $3`,
      [rpUserId, eventId, t.currency]);
    if (dup.rowCount > 0) continue;
    const settlementId = crypto.randomUUID();
    const tx = await client.query(
      `INSERT INTO transactions (nightclub_id, type, direction, amount, currency, status,
                                 payee_user_id, provider, reference_type, reference_id,
                                 confirmed_by, confirmed_at, metadata)
       VALUES ($1,'rp_commission','in',$2,$3,'paid',$4,'manual','rp_settlement',$5,$6, now(),$7)
       RETURNING id`,
      [nightclubId, t.commission, t.currency, rpUserId, settlementId, settledBy,
        JSON.stringify({ event_id: eventId, base: t.base })]);
    const s = await client.query(
      `INSERT INTO rp_settlements (id, nightclub_id, rp_user_id, event_id, currency, base, amount,
                                   transaction_id, settled_by, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING id, currency, base::text AS base, amount::text AS amount`,
      [settlementId, nightclubId, rpUserId, eventId, t.currency, t.base, t.commission,
        tx.rows[0].id, settledBy, note]);
    done.push(s.rows[0]);
  }
  if (done.length === 0) throw ApiError.conflict('Esa noche ya se liquidó a ese RP');
  return done;
}

module.exports = {
  ROLE, DEFAULT_PCT, normalize, randomCode, ensureProfile, findByCode, currentEventId,
  attachToReservation, attachToAdmission, reassignReservation,
  lines, nightReport, latestEventFor, summary, settle, totalsByCurrency,
};
