/**
 * Sentar y levantar gente de una mesa.
 *
 * Vive aparte porque hay tres caminos que llevan a lo mismo —la puerta escanea un
 * pase, el gerente cambia el estado de una reservación a mano, el personal sienta
 * a alguien— y los tres tienen que dejar la mesa EXACTAMENTE igual. Cuando esto
 * estaba copiado en dos lugares, uno de ellos pintaba la mesa de ocupada sin meter
 * a nadie en `table_occupants`, y el cliente quedaba "sentado" para el mapa pero
 * sin poder pedir un trago.
 *
 * Estar sentado no es adorno: es lo que habilita pedir del menú, que el trago
 * llegue a la mesa correcta y aparecer en Conecta.
 */
'use strict';

const events = require('./events');

const VIP_TYPES = ['vip', 'premium', 'booth'];

/** Avisa al gerente cuando una mesa VIP se ocupa o se desocupa (D113). */
async function announceVip(client, tableId, action) {
  const { rows } = await client.query(
    'SELECT nightclub_id, code, section, type FROM tables WHERE id = $1', [tableId]);
  const t = rows[0];
  if (!t || !VIP_TYPES.includes(t.type)) return;
  await events.publish({
    nightclubId: t.nightclub_id, type: `vip_table_${action}`, client,
    audience: { roles: ['manager', 'admin'] },
    payload: { table_id: tableId, code: t.code, section: t.section, action },
  });
}

/**
 * Sienta a una persona en una mesa, dentro de la transacción de quien llama.
 *
 * Deja cualquier otra mesa donde estuviera —una persona está en una mesa a la
 * vez— y libera esa mesa anterior si se queda vacía, porque si no el mapa muestra
 * mesas ocupadas por nadie el resto de la noche.
 */
async function seatUser(client, { tableId, userId }) {
  const dejadas = await client.query(
    `UPDATE table_occupants SET left_at = now()
      WHERE user_id = $1 AND left_at IS NULL
      RETURNING table_id`,
    [userId],
  );
  for (const row of dejadas.rows) {
    if (row.table_id === tableId) continue;
    const libre = await client.query(
      `UPDATE tables t SET status = 'available'
        WHERE t.id = $1 AND t.status = 'occupied'
          AND NOT EXISTS (
            SELECT 1 FROM table_occupants o WHERE o.table_id = t.id AND o.left_at IS NULL
          )`,
      [row.table_id],
    );
    if (libre.rowCount > 0) await announceVip(client, row.table_id, 'released');
  }
  await client.query(
    'INSERT INTO table_occupants (table_id, user_id) VALUES ($1,$2)',
    [tableId, userId],
  );
  const ocupada = await client.query(
    `UPDATE tables SET status = 'occupied' WHERE id = $1 AND status IN ('available','reserved')`,
    [tableId],
  );
  if (ocupada.rowCount > 0) await announceVip(client, tableId, 'occupied');
}

/**
 * Levanta a una persona de la mesa donde esté, y libera la mesa si se vació.
 * Devuelve las mesas que tocó, para que quien llame publique lo que corresponda.
 */
async function releaseUser(client, { userId }) {
  const { rows } = await client.query(
    `UPDATE table_occupants SET left_at = now()
      WHERE user_id = $1 AND left_at IS NULL
      RETURNING table_id`,
    [userId],
  );
  for (const row of rows) {
    const libre = await client.query(
      `UPDATE tables t SET status = 'available'
        WHERE t.id = $1 AND t.status = 'occupied'
          AND NOT EXISTS (
            SELECT 1 FROM table_occupants o WHERE o.table_id = t.id AND o.left_at IS NULL
          )`,
      [row.table_id],
    );
    if (libre.rowCount > 0) await announceVip(client, row.table_id, 'released');
  }
  return rows.map((r) => r.table_id);
}

/** Levanta a TODOS los de una mesa. Es lo que pasa cuando una reservación termina. */
async function clearTable(client, { tableId }) {
  await client.query(
    `UPDATE table_occupants SET left_at = now() WHERE table_id = $1 AND left_at IS NULL`,
    [tableId],
  );
  const libre = await client.query(
    `UPDATE tables SET status = 'available' WHERE id = $1 AND status IN ('occupied','reserved')`,
    [tableId],
  );
  if (libre.rowCount > 0) await announceVip(client, tableId, 'released');
}

module.exports = { seatUser, releaseUser, clearTable, announceVip };
