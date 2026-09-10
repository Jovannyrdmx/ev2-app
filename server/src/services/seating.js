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
    await client.query(
      `UPDATE tables t SET status = 'available'
        WHERE t.id = $1 AND t.status = 'occupied'
          AND NOT EXISTS (
            SELECT 1 FROM table_occupants o WHERE o.table_id = t.id AND o.left_at IS NULL
          )`,
      [row.table_id],
    );
  }
  await client.query(
    'INSERT INTO table_occupants (table_id, user_id) VALUES ($1,$2)',
    [tableId, userId],
  );
  await client.query(
    `UPDATE tables SET status = 'occupied' WHERE id = $1 AND status IN ('available','reserved')`,
    [tableId],
  );
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
    await client.query(
      `UPDATE tables t SET status = 'available'
        WHERE t.id = $1 AND t.status = 'occupied'
          AND NOT EXISTS (
            SELECT 1 FROM table_occupants o WHERE o.table_id = t.id AND o.left_at IS NULL
          )`,
      [row.table_id],
    );
  }
  return rows.map((r) => r.table_id);
}

/** Levanta a TODOS los de una mesa. Es lo que pasa cuando una reservación termina. */
async function clearTable(client, { tableId }) {
  await client.query(
    `UPDATE table_occupants SET left_at = now() WHERE table_id = $1 AND left_at IS NULL`,
    [tableId],
  );
  await client.query(
    `UPDATE tables SET status = 'available' WHERE id = $1 AND status IN ('occupied','reserved')`,
    [tableId],
  );
}

module.exports = { seatUser, releaseUser, clearTable };
