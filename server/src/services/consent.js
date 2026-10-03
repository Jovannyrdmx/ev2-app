/**
 * EV2 — quién puede alcanzar a quién (D65).
 *
 * ---------------------------------------------------------------------------
 * Por qué esto existe como servicio y no dentro de una ruta
 * ---------------------------------------------------------------------------
 * Estas reglas vivían dentro de `routes/flirts.js`, y ahí funcionaban perfectamente:
 * para mandarle algo a una persona hacía falta estar sentado, que ella tuviera el
 * consentimiento prendido, que fuera mayor de edad, que no hubiera bloqueo en ninguna
 * dirección, y respetar los topes por hora y por noche.
 *
 * El problema es que **`POST /orders` llegaba al mismo efecto por otro camino**. Un
 * pedido con `recipient_id` le entrega a una persona concreta un trago con un mensaje
 * libre de 280 caracteres, exactamente igual que un flirt de tipo regalo — pero de las
 * ocho comprobaciones solo hacía una, la del bloqueo, que es reactiva: solo sirve
 * *después* de que ya la contactaron la primera vez.
 *
 * Una clienta que apagó el consentimiento —o sea, que dijo expresamente "no quiero que
 * me contacten"— seguía recibiendo mensajes, uno por trago, sin límite por hora.
 *
 * La regla se movió aquí porque el defecto no estaba en las reglas: estaba en que
 * había **dos puertas a la misma habitación y solo una tenía cerradura**. Mientras la
 * comprobación viva dentro de una ruta, la siguiente ruta que haga lo mismo va a
 * volver a nacer sin ella.
 *
 * ---------------------------------------------------------------------------
 * Lo que este archivo NO decide
 * ---------------------------------------------------------------------------
 * No decide si se puede cobrar, ni si hay existencia, ni a qué barra va el trago. Solo
 * contesta una pregunta: **¿esta persona puede mandarle algo a esta otra?**
 */
'use strict';

const { pool } = require('../db/pool');
const { ApiError } = require('../middleware/errors');

/**
 * Los topes, en un solo lugar.
 *
 * Están aquí y no en la ruta para que las pruebas y el contrato citen los mismos
 * números, y para que subirlos sea un cambio de una línea y no una cacería.
 */
const LIMITS = {
  perHour: 20,
  unansweredPerNight: 3,
  nightHours: 12, // un flirt vive esto como máximo
  openReportsToHide: 2,
  messageMax: 140,
};

/** La mesa donde está sentada esta persona ahora mismo, o null. */
async function seatedAt(userId, runner = pool) {
  const { rows } = await runner.query(
    `SELECT t.id, t.code, t.section, t.floor
       FROM table_occupants o JOIN tables t ON t.id = o.table_id
      WHERE o.user_id = $1 AND o.left_at IS NULL`,
    [userId]);
  return rows[0] || null;
}

/**
 * ¿Hay bloqueo entre estas dos personas, en cualquier dirección?
 *
 * En las dos a propósito: quien bloqueó no quiere recibir, y quien fue bloqueado
 * tampoco debería poder seguir mandando. Comprobar una sola dirección deja media
 * puerta abierta.
 */
async function blockedEitherWay(a, b, runner = pool) {
  const { rows } = await runner.query(
    `SELECT 1 FROM user_blocks
      WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1)
      LIMIT 1`,
    [a, b]);
  return rows.length > 0;
}

/**
 * ¿Puede esta persona mandarle algo a esta otra? Si no, lanza y dice por qué.
 *
 * ---------------------------------------------------------------------------
 * Por qué unos errores dicen la verdad y otros no
 * ---------------------------------------------------------------------------
 * Un bloqueo, un destinatario escondido por reportes y un destinatario que no existe
 * contestan **lo mismo**: "Esa persona no está disponible". Es deliberado. Si el
 * bloqueo dijera "te bloquearon", quien acosa lo sabría y se crearía otra cuenta; y
 * distinguir "no existe" de "existe pero te bloqueó" convierte esta ruta en una forma
 * de averiguar quién está en el club, de a una persona por intento.
 *
 * En cambio "esa persona no acepta flirts" y los topes **sí** se dicen tal cual: quien
 * llegó hasta ahí ya demostró que el destinatario existe y está disponible, así que no
 * hay nada que filtrar, y alguien que no entiende por qué no puede mandar nada merece
 * que se lo digan.
 */
async function assertCanSend({ nightclubId, sender, recipientId, runner = pool }) {
  if (sender.id === recipientId) {
    throw ApiError.unprocessable('No puedes enviarte un flirt a ti mismo');
  }

  const senderTable = await seatedAt(sender.id, runner);
  if (!senderTable) {
    throw ApiError.unprocessable('Tienes que estar sentado en una mesa para enviar un flirt');
  }

  const rec = await runner.query(
    `SELECT u.id, u.display_name, u.status, u.role,
            p.accept_flirts,
            (SELECT count(*)::int FROM user_reports r
              WHERE r.reported_id = u.id AND r.status = 'open') AS open_reports
       FROM users u LEFT JOIN user_preferences p ON p.user_id = u.id
      WHERE u.id = $1 AND u.nightclub_id = $2`,
    [recipientId, nightclubId]);
  const recipient = rec.rows[0];
  const unavailable = ApiError.notFound('Esa persona no está disponible');
  if (!recipient || recipient.status !== 'active' || recipient.role !== 'guest') throw unavailable;
  if (recipient.open_reports >= LIMITS.openReportsToHide) throw unavailable;
  if (await blockedEitherWay(sender.id, recipientId, runner)) throw unavailable;

  if (!recipient.accept_flirts) throw ApiError.forbidden('Esa persona no acepta flirts');

  const recipientTable = await seatedAt(recipientId, runner);
  if (!recipientTable) throw ApiError.unprocessable('Esa persona ya no está en el club');

  // "No me interesa" cierra la conversación por esa noche.
  const silenced = await runner.query(
    `SELECT 1 FROM flirt_reactions r JOIN flirts f ON f.id = r.flirt_id
      WHERE f.sender_id = $1 AND f.recipient_id = $2 AND r.user_id = $2
        AND r.reaction = 'not_interested' AND r.created_at > now() - make_interval(hours => $3)
      LIMIT 1`,
    [sender.id, recipientId, LIMITS.nightHours]);
  if (silenced.rows.length > 0) {
    throw ApiError.forbidden('Esa persona pidió no recibir más flirts tuyos esta noche');
  }

  const hourly = await runner.query(
    `SELECT count(*)::int AS n FROM flirts
      WHERE sender_id = $1 AND created_at > now() - interval '1 hour'`,
    [sender.id]);
  if (hourly.rows[0].n >= LIMITS.perHour) {
    throw ApiError.tooMany(`Máximo ${LIMITS.perHour} flirts por hora`);
  }

  const unanswered = await runner.query(
    `SELECT count(*)::int AS n FROM flirts f
      WHERE f.sender_id = $1 AND f.recipient_id = $2
        AND f.created_at > now() - make_interval(hours => $3)
        AND f.status IN ('sent', 'viewed')
        AND NOT EXISTS (SELECT 1 FROM flirt_reactions r WHERE r.flirt_id = f.id AND r.user_id = $2)`,
    [sender.id, recipientId, LIMITS.nightHours]);
  if (unanswered.rows[0].n >= LIMITS.unansweredPerNight) {
    throw ApiError.tooMany(
      `Ya enviaste ${LIMITS.unansweredPerNight} flirts sin respuesta a esa persona; espera a que responda`);
  }

  return { senderTable, recipient, recipientTable };
}

/**
 * Los roles que NO son cliente: para ellos hay otra puerta, con otras reglas.
 *
 * Invitarle un trago a alguien del personal tiene su propio camino
 * (`POST /staff/:userId/drinks`), y ese camino hace tres cosas que ésta no puede
 * hacer: comprueba que el rol de esa persona acepte tragos, que **esté en turno**, y
 * —lo que de verdad importa— deja el trago en `staff_drinks` en estado pendiente,
 * **con botón de rechazar** y devolución del dinero a quien invitó.
 *
 * Mandarlo por el camino del pedido se veía igual desde afuera y dejaba a la persona
 * sin esa salida: el trago le llegaba y no tenía cómo decir que no.
 */
const STAFF_GIFT_PATH = 'Para invitarle un trago a alguien del personal, usa el botón de su perfil: '
  + 'así esa persona puede aceptarlo o rechazarlo.';

module.exports = { LIMITS, seatedAt, blockedEitherWay, assertCanSend, STAFF_GIFT_PATH };
