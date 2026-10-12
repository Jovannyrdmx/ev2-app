'use strict';

/**
 * El voucher de tarjeta tecleado a mano (D107).
 *
 * Con la terminal Mercado Pago en cada caja, "tarjeta con folio" es el respaldo para
 * cuando la terminal falla — y era también la forma de quedarse con un pago en
 * efectivo: se registra como tarjeta con un folio inventado y ese dinero deja de
 * esperarse en el cajón. Quien cobra en el piso (cajero, anfitriona) ya no lo registra
 * solo: escribe el motivo y un gerente teclea su PIN. Gerente y admin ya son gerencia.
 */
const { ApiError } = require('../middleware/errors');
const managerAuth = require('./manager-auth');

const METHOD = 'card_terminal';
const NEEDS_AUTH_ROLES = ['cashier', 'hostess'];

const needsAuthorization = (method, role) => method === METHOD && NEEDS_AUTH_ROLES.includes(role);

/**
 * Si el cobro lo necesita, verifica motivo y PIN ANTES de abrir la transacción y
 * devuelve quién autorizó; si no, `null`.
 */
async function authorize(runner, { nightclubId, user, method, pin, reason, ip }) {
  if (!needsAuthorization(method, user.role)) return null;
  if (!pin) {
    throw ApiError.forbidden(
      'El voucher tecleado a mano necesita el PIN de un gerente. Si la terminal funciona, cobra con la terminal.');
  }
  if (!reason || String(reason).trim().length < 3) {
    throw ApiError.badRequest('Escribe por qué no se cobró con la terminal');
  }
  const autoriza = await managerAuth.authorize(runner, { nightclubId, pin, selfId: user.id, ip });
  return { ...autoriza, reason: String(reason).trim() };
}

/** Deja escrito en el pago y en la bitácora quién autorizó el voucher manual. */
async function record(client, { nightclubId, paymentId, user, authorizer, ip }) {
  if (!authorizer) return;
  await client.query(
    `UPDATE manual_payments SET authorized_by = $2, authorization_reason = $3 WHERE id = $1`,
    [paymentId, authorizer.id, authorizer.reason]);
  await client.query(
    `INSERT INTO audit_log (nightclub_id, actor_id, action, entity, entity_id, after, ip)
     VALUES ($1,$2,'payment.manual_voucher','manual_payment',$3,$4,$5)`,
    [nightclubId, user.id, paymentId,
      JSON.stringify({ authorized_by: authorizer.id, reason: authorizer.reason }), ip || null]);
}

module.exports = { METHOD, NEEDS_AUTH_ROLES, needsAuthorization, authorize, record };
