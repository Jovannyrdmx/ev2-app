// El voucher de tarjeta tecleado a mano necesita un gerente que lo autorice (D107).
// Las pruebas que registran vouchers como cajero o anfitriona piden aquí un gerente
// propio con su PIN, sin tocar el del gerente de la prueba.
'use strict';

const { pool } = require('../../src/db/pool');
const pins = require('../../src/services/pins');
const f = require('./factories');

/** Un gerente nuevo con su PIN listo para autorizar. */
async function managerPin(nightclubId) {
  const manager = await f.createUser(nightclubId, { role: 'manager', display_name: 'Gerente autoriza' });
  const pin = await pins.issuePin(pool, { userId: manager.id });
  await pool.query('UPDATE users SET must_change_pin = false WHERE id = $1', [manager.id]);
  return { pin, manager };
}

async function voucherAuth(nightclubId, reason = 'La terminal no tenía señal') {
  const { pin } = await managerPin(nightclubId);
  return { manager_pin: pin, voucher_reason: reason };
}

module.exports = { voucherAuth, managerPin };
