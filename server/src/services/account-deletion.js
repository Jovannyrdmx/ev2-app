/**
 * Borrar la cuenta de un cliente (D68).
 *
 * ---------------------------------------------------------------------------
 * Lo que "borrar" significa aquí, y por qué
 * ---------------------------------------------------------------------------
 * La fila de `users` NO se borra. No es una comodidad: hay 98 llaves foráneas
 * apuntando a ella, varias con `ON DELETE RESTRICT`, y el libro contable tiene el
 * borrado prohibido por trigger desde la primera migración. Un borrado literal o
 * falla, o destruye la contabilidad de noches ya cerradas.
 *
 * Lo que sí se hace, y es lo que la persona está pidiendo, es que deje de estar
 * identificada: nombre, correo, teléfono y fecha de nacimiento se sobrescriben, y
 * todo lo que la conecta con el mundo —sesiones, cuenta de Facebook ligada, tarjetas,
 * mensajes, el destino al que pidió un taxi— se borra de verdad. Los montos se quedan
 * colgando de una fila que ya no dice quién era.
 *
 * ---------------------------------------------------------------------------
 * Cuándo se niega, y por qué no es burocracia
 * ---------------------------------------------------------------------------
 * Cada negativa protege a alguien de algo concreto:
 *
 *   - **Empleado**: su cuenta bancaria, sus propinas y sus retiros tienen obligaciones
 *     fiscales que no son suyas de renunciar. Se da de baja por gerencia, no aquí.
 *   - **Debe dinero**: borrarse no puede ser la forma de no pagar la cuenta.
 *   - **Pedido abierto**: hay un trago en la barra a su nombre.
 *   - **Coche en el valet**: el sistema dejaría de saber de quién es el auto que tiene
 *     en el estacionamiento. Este es el que de verdad importa.
 *
 * Las cuatro son temporales salvo la primera: se resuelven en minutos y la persona
 * vuelve a intentarlo. Por eso `check()` existe por separado — la pantalla enseña el
 * motivo ANTES de que alguien teclee "BORRAR" y se lleve un error.
 */
'use strict';

const { pool } = require('../db/pool');

/** El correo que queda. `.invalid` está reservado por el RFC 2606: nunca existe. */
const deletedEmail = (userId) => `${userId}@borrada.invalid`;

/**
 * El nombre que queda.
 *
 * No se deja en blanco: las pantallas del personal enseñan el nombre de quien pidió, y
 * una fila vacía se lee como un error del sistema. "Cuenta borrada" se lee como lo que
 * es, y nadie va a buscar a quién pertenecía.
 */
const DELETED_NAME = 'Cuenta borrada';

/**
 * La fecha de nacimiento que queda.
 *
 * La columna es NOT NULL y no se puede vaciar. 1900-01-01 no es la fecha de nadie y
 * deja de decir la edad de esta persona, que es el dato que había que quitar.
 */
const DELETED_BIRTH_DATE = '1900-01-01';

const MOTIVOS = {
  is_staff: 'Las cuentas del personal las da de baja la gerencia',
  unpaid: 'Tienes un cobro pendiente de pagar',
  open_order: 'Tienes un pedido en curso',
  valet_open: 'Tu coche sigue en el valet',
  already_deleted: 'Esta cuenta ya está borrada',
};

/**
 * ¿Se puede borrar esta cuenta ahora?
 *
 * Devuelve `{ ok, blockers: [{ reason, message }] }` con TODOS los motivos, no solo el
 * primero: quien tiene el coche en el valet y además debe la cuenta merece enterarse
 * de las dos cosas de una vez y no en dos viajes.
 */
async function check(userId) {
  const { rows } = await pool.query(
    `SELECT
       u.role,
       u.status,
       (SELECT count(*)::int FROM transactions t
          WHERE t.payer_user_id = u.id
            AND t.status IN ('pending', 'pending_manual'))                 AS por_pagar,
       (SELECT count(*)::int FROM drink_orders o
          WHERE o.sender_id = u.id
            AND o.status NOT IN ('delivered', 'cancelled', 'pos_error'))   AS pedidos,
       (SELECT count(*)::int FROM valet_tickets v
          WHERE v.user_id = u.id
            AND v.status IN ('parked', 'requested', 'ready'))              AS valet
     FROM users u
     WHERE u.id = $1::text::uuid`,
    [String(userId)]);

  if (rows.length === 0) return null;
  const r = rows[0];
  const blockers = [];
  const bloquea = (reason) => blockers.push({ reason, message: MOTIVOS[reason] });

  if (r.status === 'deleted') bloquea('already_deleted');
  if (r.role !== 'guest') bloquea('is_staff');
  if (r.por_pagar > 0) bloquea('unpaid');
  if (r.pedidos > 0) bloquea('open_order');
  if (r.valet > 0) bloquea('valet_open');

  return { ok: blockers.length === 0, blockers };
}

/**
 * Las limpiezas, en orden, cada una con el nombre con el que se reporta.
 *
 * Están como datos y no como código suelto por una razón: cuando alguien agregue una
 * tabla con datos personales, agregarla aquí es una línea, y la prueba que cuenta las
 * tablas limpiadas le avisa si se le olvidó.
 */
const LIMPIEZAS = [
  // Formas de entrar. Primero, para que una sesión abierta no siga viva un segundo más
  // de lo necesario mientras corre el resto.
  ['refresh_tokens', 'DELETE FROM refresh_tokens WHERE user_id = $1::text::uuid'],
  ['user_identities', 'DELETE FROM user_identities WHERE user_id = $1::text::uuid'],
  ['user_devices', 'DELETE FROM user_devices WHERE user_id = $1::text::uuid'],

  // Dinero guardado para la próxima vez. No hay próxima vez.
  ['payment_methods', 'DELETE FROM payment_methods WHERE user_id = $1::text::uuid'],

  // Lo social. Los mensajes que escribió y los que le escribieron: en un flirt el
  // texto lo puso una persona y lo leyó otra, y ninguno de los dos lados tiene sentido
  // conservarlo cuando uno de los dos ya no está.
  ['user_preferences', 'DELETE FROM user_preferences WHERE user_id = $1::text::uuid'],
  ['flirt_reactions', `DELETE FROM flirt_reactions WHERE flirt_id IN (
       SELECT id FROM flirts WHERE sender_id = $1::text::uuid
                                OR recipient_id = $1::text::uuid)`],
  ['flirts', `DELETE FROM flirts WHERE sender_id = $1::text::uuid
                                    OR recipient_id = $1::text::uuid`],

  // Los bloqueos que PUSO se van; los que le pusieron a él se quedan. Quien bloqueó a
  // alguien lo hizo por algo, y ese algo no deja de ser cierto porque el otro se borre.
  ['user_blocks', 'DELETE FROM user_blocks WHERE blocker_id = $1::text::uuid'],

  // Datos personales sueltos en filas que sí se quedan.
  ['valet_tickets', `UPDATE valet_tickets SET phone = NULL, updated_at = now()
                      WHERE user_id = $1::text::uuid AND phone IS NOT NULL`],
  // El destino de un taxi es la casa de alguien. Es de lo más delicado que guarda el
  // sistema y no hay razón para conservarlo un minuto más.
  ['taxi_requests', `UPDATE taxi_requests SET destination = NULL, pickup_location = NULL,
                            updated_at = now()
                      WHERE user_id = $1::text::uuid
                        AND (destination IS NOT NULL OR pickup_location IS NOT NULL)`],
  ['reservations', `UPDATE reservations SET special_requests = NULL, updated_at = now()
                     WHERE user_id = $1::text::uuid AND special_requests IS NOT NULL`],
  ['lost_items', `UPDATE lost_items SET reporter_name = NULL, reporter_phone = NULL,
                         updated_at = now()
                   WHERE reported_by = $1::text::uuid
                     AND (reporter_name IS NOT NULL OR reporter_phone IS NOT NULL)`],
  // El nombre de pila que el titular le escribió a un invitado suyo es un dato de una
  // tercera persona que nunca tuvo cuenta aquí.
  ['guest_passes', `UPDATE guest_passes SET label = NULL
                     WHERE label IS NOT NULL
                       AND (created_by = $1::text::uuid
                            OR reservation_id IN (SELECT id FROM reservations
                                                   WHERE user_id = $1::text::uuid))`],
];

/** Las tablas que toca el borrado. La prueba la usa para avisar si alguien agrega una. */
const TABLAS_LIMPIADAS = LIMPIEZAS.map(([tabla]) => tabla);

/**
 * Borra la cuenta. Todo o nada, en una transacción.
 *
 * `requestedBy` es `self` (la persona desde su teléfono) o `manager` (gerencia
 * atendiendo una petición por escrito de alguien que ya no puede entrar).
 */
async function remove(userId, { requestedBy = 'self', actorId = null } = {}) {
  const estado = await check(userId);
  if (!estado) return { ok: false, notFound: true };
  if (!estado.ok) return { ok: false, blockers: estado.blockers };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Se relee con el candado puesto: entre el `check` y este momento alguien pudo
    // pedir un trago desde otra pantalla, y el borrado dejaría un pedido sin dueño.
    const vivo = await client.query(
      `SELECT id, nightclub_id, role, status FROM users
        WHERE id = $1::text::uuid FOR UPDATE`, [String(userId)]);
    if (vivo.rows.length === 0) { await client.query('ROLLBACK'); return { ok: false, notFound: true }; }
    if (vivo.rows[0].status === 'deleted' || vivo.rows[0].role !== 'guest') {
      await client.query('ROLLBACK');
      return { ok: false, blockers: (await check(userId)).blockers };
    }

    const cleared = {};
    for (const [tabla, sql] of LIMPIEZAS) {
      const r = await client.query(sql, [String(userId)]);
      if (r.rowCount > 0) cleared[tabla] = r.rowCount;
    }

    // La fila, vaciada. Un solo UPDATE: el trigger de 037 deja pasar el paso a
    // `deleted` y a partir de ahí ningún otro.
    await client.query(
      `UPDATE users
          SET email         = $2::text,
              phone         = NULL,
              password_hash = NULL,
              first_name    = $3::text,
              last_name     = '',
              display_name  = NULL,
              birth_date    = $4::text::date,
              age_verified  = false,
              pin_hash      = NULL,
              pin_lookup    = NULL,
              status        = 'deleted',
              updated_at    = now()
        WHERE id = $1::text::uuid`,
      [String(userId), deletedEmail(userId), DELETED_NAME, DELETED_BIRTH_DATE]);

    const constancia = await client.query(
      `INSERT INTO account_deletions (nightclub_id, user_id, requested_by, actor_id, cleared)
       VALUES ($1::text::uuid, $2::text::uuid, $3::text, $4, $5::text::jsonb)
       RETURNING id, created_at`,
      [vivo.rows[0].nightclub_id, String(userId), String(requestedBy),
        actorId ? String(actorId) : null, JSON.stringify(cleared)]);

    await client.query('COMMIT');
    return {
      ok: true,
      deleted_at: constancia.rows[0].created_at,
      cleared,
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  check,
  remove,
  deletedEmail,
  DELETED_NAME,
  DELETED_BIRTH_DATE,
  TABLAS_LIMPIADAS,
  MOTIVOS,
};
