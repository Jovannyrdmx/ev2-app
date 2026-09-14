// Los pases de una reservación: verlos, ponerles nombre, repartirlos, revocarlos
// y reasignarlos.
//
// Esto es lo que el titular de la mesa hace desde su teléfono, y lo que la puerta
// puede hacer en su nombre cuando el titular está enfrente pidiéndolo. Dos
// decisiones que atraviesan todo el archivo:
//
//   * el titular manda sobre sus pases y nadie más los ve. Un pase ajeno es una
//     entrada ajena, así que a quien no es el dueño ni personal de la puerta se
//     le contesta 404, no 403: un 403 confirma que la reservación existe;
//   * revocar no borra. El pase viejo se queda muerto, con motivo y con hora, y
//     el nuevo apunta a cuál sustituyó. Es lo único que permite contestar "este
//     QR ya no servía porque el titular lo canceló a las 10:15" en vez de "no
//     sé".
'use strict';

const express = require('express');
const QRCode = require('qrcode');
const { pool } = require('../db/pool');
const { ApiError, asyncHandler } = require('../middleware/errors');
const { validate, z, uuid } = require('../middleware/validate');
const { authenticate, sameNightclub } = require('../middleware/auth');
const passes = require('../services/guest-passes');
const events = require('../services/events');

const router = express.Router({ mergeParams: true });

const DOOR_ROLES = ['hostess', 'manager', 'admin'];

const PASS_SELECT = `
  SELECT p.id, p.code, p.kind, p.status, p.label, p.expires_at, p.used_at,
         p.revoked_at, p.revoke_reason, p.replaces_id, p.share_count,
         p.last_shared_at, p.created_at, p.reservation_id, p.admission_id,
         p.nightclub_id,
         r.starts_at, r.status AS reservation_status, r.guest_count,
         t.code AS table_code, t.section, t.floor,
         n.name AS club_name,
         u.display_name AS used_by_name
    FROM guest_passes p
    JOIN nightclubs n ON n.id = p.nightclub_id
    LEFT JOIN reservations r ON r.id = p.reservation_id
    LEFT JOIN tables t ON t.id = r.table_id
    LEFT JOIN users u ON u.id = p.used_by`;

/**
 * Lo que se enseña de un pase.
 *
 * `code` va siempre —el titular lo tiene que poder dictar— pero el `payload`
 * firmado solo cuando alguien va a dibujar el QR. No es paranoia: el payload es
 * la credencial, y mandarlo en cada renglón de una lista es dejarlo en la caché
 * del navegador, en el historial y en cualquier registro que guarde respuestas.
 */
function present(row, { withPayload = false } = {}) {
  return {
    id: row.id,
    code: row.code,
    kind: row.kind,
    status: row.status,
    label: row.label,
    expires_at: row.expires_at,
    used_at: row.used_at,
    used_by_name: row.used_by_name || null,
    revoked_at: row.revoked_at,
    revoke_reason: row.revoke_reason,
    replaces_id: row.replaces_id,
    share_count: row.share_count,
    last_shared_at: row.last_shared_at,
    created_at: row.created_at,
    reservation_id: row.reservation_id,
    table_code: row.table_code || null,
    section: row.section || null,
    starts_at: row.starts_at || null,
    ...(withPayload ? { payload: passes.payload(row.code) } : {}),
  };
}

/**
 * De dónde sale el enlace que se manda por WhatsApp.
 *
 * Del servidor, nunca de lo que mande el cliente. Un enlace armado con la
 * cabecera `Host` o con un campo del body es un enlace a donde quiera el que
 * pide, y ese enlace sale del teléfono del titular con la credencial adentro y
 * la cara del club encima.
 *
 * `PUBLIC_WEB_URL` si está; si no, el primer origen de `ALLOWED_ORIGINS`, que en
 * un servidor es obligatorio y es exactamente el dominio de la web. Así esto
 * funciona en producción sin agregar una variable más que se pueda olvidar.
 */
function publicBaseUrl() {
  if (process.env.PUBLIC_WEB_URL) return process.env.PUBLIC_WEB_URL.replace(/\/+$/, '');
  const primero = (process.env.ALLOWED_ORIGINS || '').split(',')[0].trim();
  return primero.replace(/\/+$/, '');
}

/**
 * ¿Puede este usuario tocar los pases de esta reservación?
 *
 * El dueño sí. El personal de la puerta sí, porque el titular se les para
 * enfrente a pedir que le reasignen un pase y no va a sacar su teléfono para
 * hacerlo él. Nadie más, y a nadie más se le dice que la reservación existe.
 */
async function loadReservation(client, { nightclubId, reservationId, user }) {
  const { rows } = await (client || pool).query(
    `SELECT r.id, r.user_id, r.nightclub_id, r.status, r.starts_at, r.ends_at,
            r.guest_count, r.pass_code, t.code AS table_code, t.section,
            n.name AS club_name
       FROM reservations r
       JOIN tables t ON t.id = r.table_id
       JOIN nightclubs n ON n.id = r.nightclub_id
      WHERE r.id = $1 AND r.nightclub_id = $2`,
    [reservationId, nightclubId],
  );
  if (rows.length === 0) throw ApiError.notFound('Reservación no encontrada');
  const r = rows[0];
  const esSuyo = r.user_id === user.id;
  if (!esSuyo && !DOOR_ROLES.includes(user.role)) {
    throw ApiError.notFound('Reservación no encontrada');
  }
  return { reservation: r, isOwner: esSuyo };
}

// ==========================================================================
// El enlace que abre el invitado. SIN sesión.
// ==========================================================================

/**
 * Lo que ve quien recibe el pase por WhatsApp.
 *
 * No lleva autenticación, y eso es la decisión, no un descuido: el invitado no
 * tiene cuenta en el club y no la va a crear en la fila. El enlace ES la
 * credencial, igual que un boleto de avión: quien lo tiene, entra. Por eso:
 *
 *   * exige la firma. Sin firma válida no se toca la base;
 *   * enseña lo mínimo para poder entrar —el QR, la mesa, la hora, el nombre del
 *     club— y NADA de la persona. Ni el nombre del titular, ni el teléfono, ni
 *     quién más está invitado. El `label` que se muestra es el que el propio
 *     titular escribió para esta persona, que es quien va a leer la pantalla;
 *   * cada apertura queda registrada. Si un pase se comparte de más, el titular
 *     lo va a ver en el conteo y lo puede revocar.
 */
router.get('/guest-passes/:payload',
  validate({ params: z.object({ payload: z.string().trim().min(8).max(200) }) }),
  asyncHandler(async (req, res) => {
    const leido = passes.parse(req.params.payload);
    // Un enlace sin firma no es un enlace: es un código tecleado en la barra de
    // direcciones. Ese camino existe en la puerta, con un guardia enfrente, no
    // aquí donde no hay nadie mirando.
    if (!leido.signed || !passes.verifySignature(leido.code, leido.signature)) {
      throw ApiError.notFound('Pase no encontrado');
    }

    const { rows } = await pool.query(`${PASS_SELECT} WHERE p.code = $1`, [leido.code]);
    if (rows.length === 0) throw ApiError.notFound('Pase no encontrado');
    const row = rows[0];

    const estado = passes.check(row, row.reservation_id ? {
      status: row.reservation_status, starts_at: row.starts_at,
      ends_at: row.starts_at ? new Date(new Date(row.starts_at).getTime() + 12 * 3_600_000) : null,
    } : null);

    const qr = await QRCode.toString(passes.payload(row.code), {
      type: 'svg', errorCorrectionLevel: 'M', margin: 1, width: 320,
      color: { dark: '#000000', light: '#ffffff' },
    });

    // La vista se registra sin bloquear la respuesta: el invitado está en la fila.
    passes.audit(pool, { passId: row.id, kind: 'viewed',
      metadata: { user_agent: String(req.headers['user-agent'] || '').slice(0, 120) } })
      .catch(() => {});
    await pool.query(
      'UPDATE guest_passes SET updated_at = now() WHERE id = $1', [row.id]).catch(() => {});

    res.json({
      pass: {
        code: row.code,
        qr_svg: qr,
        kind: row.kind,
        status: row.status,
        label: row.label,
        club_name: row.club_name,
        table_code: row.table_code,
        section: row.section,
        starts_at: row.starts_at,
        expires_at: row.expires_at,
        used_at: row.used_at,
        // Lo que el invitado necesita saber antes de salir de su casa.
        usable: estado.ok,
        result: estado.status,
      },
    });
  }));

// ==========================================================================
// Los pases de una reservación
// ==========================================================================

router.use('/nightclubs/:nightclubId', authenticate, sameNightclub());

/** La lista. Sin payloads firmados: ver la lista no es repartirla. */
router.get('/nightclubs/:nightclubId/reservations/:reservationId/passes',
  validate({ params: z.object({ nightclubId: uuid, reservationId: uuid }) }),
  asyncHandler(async (req, res) => {
    const { nightclubId, reservationId } = req.params;
    await loadReservation(null, { nightclubId, reservationId, user: req.user });

    const { rows } = await pool.query(
      `${PASS_SELECT}
        WHERE p.reservation_id = $1
        ORDER BY CASE p.kind WHEN 'holder' THEN 0 WHEN 'guest' THEN 1
                             WHEN 'extra' THEN 2 ELSE 3 END,
                 p.created_at`,
      [reservationId],
    );
    res.json({
      passes: rows.map((r) => present(r)),
      summary: {
        total: rows.length,
        active: rows.filter((r) => r.status === 'active').length,
        used: rows.filter((r) => r.status === 'used').length,
        revoked: rows.filter((r) => r.status === 'revoked').length,
        shared: rows.filter((r) => r.share_count > 0).length,
      },
    });
  }));

/** Uno, con su QR dibujado. Aquí sí va el payload: es para enseñarlo. */
router.get('/nightclubs/:nightclubId/reservations/:reservationId/passes/:passId',
  validate({ params: z.object({ nightclubId: uuid, reservationId: uuid, passId: uuid }) }),
  asyncHandler(async (req, res) => {
    const { nightclubId, reservationId, passId } = req.params;
    await loadReservation(null, { nightclubId, reservationId, user: req.user });

    const { rows } = await pool.query(
      `${PASS_SELECT} WHERE p.id = $1 AND p.reservation_id = $2`, [passId, reservationId]);
    if (rows.length === 0) throw ApiError.notFound('Pase no encontrado');

    const qr = await QRCode.toString(passes.payload(rows[0].code), {
      type: 'svg', errorCorrectionLevel: 'M', margin: 1, width: 320,
      color: { dark: '#000000', light: '#ffffff' },
    });
    res.json({ pass: { ...present(rows[0], { withPayload: true }), qr_svg: qr } });
  }));

/** El nombre del invitado. Lo escribe el titular para que la puerta lo reconozca. */
router.patch('/nightclubs/:nightclubId/reservations/:reservationId/passes/:passId',
  validate({
    params: z.object({ nightclubId: uuid, reservationId: uuid, passId: uuid }),
    body: z.object({ label: z.string().trim().max(60).nullable() }),
  }),
  asyncHandler(async (req, res) => {
    const { nightclubId, reservationId, passId } = req.params;
    await loadReservation(null, { nightclubId, reservationId, user: req.user });

    const { rows } = await pool.query(
      `UPDATE guest_passes SET label = $3
        WHERE id = $1 AND reservation_id = $2 AND status <> 'revoked'
        RETURNING id`,
      [passId, reservationId, req.body.label || null]);
    if (rows.length === 0) throw ApiError.notFound('Pase no encontrado');

    const fresco = await pool.query(`${PASS_SELECT} WHERE p.id = $1`, [passId]);
    res.json({ pass: present(fresco.rows[0]) });
  }));

/**
 * Repartirlo.
 *
 * No manda nada por WhatsApp desde el servidor: devuelve el texto y el enlace
 * `wa.me`, y el teléfono del titular abre su propia app. Mandarlo desde aquí
 * necesitaría la API de WhatsApp Business, una cuenta verificada, plantillas
 * aprobadas y un costo por mensaje — y sobre todo, el mensaje le llegaría al
 * invitado de un número desconocido en vez del teléfono de su amigo, que es
 * precisamente el número del que hace caso.
 *
 * Un pase gastado o revocado no se comparte: mandarlo sería que alguien se
 * presente con un QR muerto y una explicación que dar.
 */
router.post('/nightclubs/:nightclubId/reservations/:reservationId/passes/:passId/share',
  validate({
    params: z.object({ nightclubId: uuid, reservationId: uuid, passId: uuid }),
    body: z.object({
      lang: z.enum(['es', 'en']).default('es'),
      label: z.string().trim().max(60).optional(),
    }).default({ lang: 'es' }),
  }),
  asyncHandler(async (req, res) => {
    const { nightclubId, reservationId, passId } = req.params;
    const { reservation } = await loadReservation(null, { nightclubId, reservationId, user: req.user });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `SELECT id, code, kind, status, label, used_at
           FROM guest_passes
          WHERE id = $1 AND reservation_id = $2 FOR UPDATE`,
        [passId, reservationId]);
      if (rows.length === 0) throw ApiError.notFound('Pase no encontrado');
      const p = rows[0];
      if (p.status === 'revoked') throw ApiError.conflict('Ese pase está revocado');
      if (p.status === 'used') throw ApiError.conflict('Ese pase ya se usó');

      const label = req.body.label !== undefined ? (req.body.label || null) : p.label;
      const act = await client.query(
        `UPDATE guest_passes
            SET share_count = share_count + 1, last_shared_at = now(), label = $2
          WHERE id = $1
          RETURNING share_count, last_shared_at, label`,
        [passId, label]);

      await passes.audit(client, {
        passId, kind: 'shared', actorId: req.user.id,
        metadata: { share_count: act.rows[0].share_count, lang: req.body.lang },
      });
      await client.query('COMMIT');

      const cuando = reservation.starts_at
        ? new Date(reservation.starts_at).toISOString()
        : null;
      const msg = passes.shareMessage({
        code: p.code,
        label: act.rows[0].label,
        club: reservation.club_name,
        table: reservation.table_code,
        when: cuando,
        baseUrl: publicBaseUrl(),
        lang: req.body.lang,
      });
      res.json({
        share: msg,
        pass: { id: passId, code: p.code, label: act.rows[0].label,
          share_count: act.rows[0].share_count, last_shared_at: act.rows[0].last_shared_at },
      });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }));

/**
 * Revocarlo: el invitado ya no va, o el QR se filtró.
 *
 * El motivo es obligatorio. Un pase muerto sin motivo es una discusión en la
 * puerta que nadie puede resolver, y a la semana nadie se acuerda.
 *
 * Un pase ya usado NO se revoca. La persona ya está adentro; marcar su pase como
 * revocado sería escribir que no entró.
 */
router.post('/nightclubs/:nightclubId/reservations/:reservationId/passes/:passId/revoke',
  validate({
    params: z.object({ nightclubId: uuid, reservationId: uuid, passId: uuid }),
    body: z.object({ reason: z.string().trim().min(3).max(200) }),
  }),
  asyncHandler(async (req, res) => {
    const { nightclubId, reservationId, passId } = req.params;
    await loadReservation(null, { nightclubId, reservationId, user: req.user });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `SELECT id, status, kind FROM guest_passes
          WHERE id = $1 AND reservation_id = $2 FOR UPDATE`,
        [passId, reservationId]);
      if (rows.length === 0) throw ApiError.notFound('Pase no encontrado');
      if (rows[0].status === 'used') throw ApiError.conflict('Ese pase ya se usó: esa persona está adentro');
      if (rows[0].status === 'revoked') throw ApiError.conflict('Ese pase ya estaba revocado');

      await client.query(
        `UPDATE guest_passes
            SET status = 'revoked', revoked_at = now(), revoked_by = $2, revoke_reason = $3
          WHERE id = $1`,
        [passId, req.user.id, req.body.reason]);
      await passes.audit(client, { passId, kind: 'revoked', reason: req.body.reason,
        actorId: req.user.id });
      await events.publish({
        nightclubId, type: 'guest_pass_revoked', client,
        audience: { roles: ['hostess', 'manager'] },
        payload: { pass_id: passId, reservation_id: reservationId },
      });
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    const fresco = await pool.query(`${PASS_SELECT} WHERE p.id = $1`, [passId]);
    res.json({ pass: present(fresco.rows[0]) });
  }));

/**
 * Reasignarlo: va otra persona en lugar de la que no vino.
 *
 * Es revocar y emitir en un solo acto, y tiene que ser un solo acto: si fueran
 * dos llamadas, una reservación podría quedarse con el pase muerto y sin el
 * nuevo —justo cuando el invitado de repuesto ya está en camino— porque el
 * teléfono del titular perdió la señal entre una y otra.
 *
 * El pase nuevo apunta al viejo con `replaces_id`. Eso es lo que permite seguir
 * una cadena de reasignaciones hasta el original.
 */
router.post('/nightclubs/:nightclubId/reservations/:reservationId/passes/:passId/reassign',
  validate({
    params: z.object({ nightclubId: uuid, reservationId: uuid, passId: uuid }),
    body: z.object({
      label: z.string().trim().max(60).optional(),
      reason: z.string().trim().min(3).max(200).default('reasignado a otro invitado'),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { nightclubId, reservationId, passId } = req.params;
    const { reservation } = await loadReservation(null, { nightclubId, reservationId, user: req.user });

    const client = await pool.connect();
    let nuevo = null;
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `SELECT id, status, kind FROM guest_passes
          WHERE id = $1 AND reservation_id = $2 FOR UPDATE`,
        [passId, reservationId]);
      if (rows.length === 0) throw ApiError.notFound('Pase no encontrado');
      const viejo = rows[0];
      if (viejo.status === 'used') {
        throw ApiError.conflict('Ese pase ya se usó: esa persona está adentro');
      }
      if (viejo.status === 'revoked') {
        throw ApiError.conflict('Ese pase ya estaba revocado: el titular tiene que emitir otro');
      }

      await client.query(
        `UPDATE guest_passes
            SET status = 'revoked', revoked_at = now(), revoked_by = $2, revoke_reason = $3
          WHERE id = $1`,
        [passId, req.user.id, req.body.reason]);

      // Un código nuevo, no el mismo: el QR viejo ya salió del teléfono del
      // titular y puede estar en la conversación de alguien que ya no viene.
      for (let intento = 0; intento < 5 && !nuevo; intento += 1) {
        try {
          const ins = await client.query(
            `INSERT INTO guest_passes (nightclub_id, reservation_id, code, kind, label,
                                       replaces_id, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7)
             RETURNING id`,
            [nightclubId, reservationId, passes.generateCode(), viejo.kind,
              req.body.label || null, passId, req.user.id]);
          nuevo = ins.rows[0].id;
        } catch (err) {
          if (err.code !== '23505') throw err;
        }
      }
      if (!nuevo) throw ApiError.conflict('No se pudo generar un código nuevo, inténtalo otra vez');

      await passes.audit(client, { passId, kind: 'reassigned', reason: req.body.reason,
        actorId: req.user.id, metadata: { replaced_by: nuevo } });
      await passes.audit(client, { passId: nuevo, kind: 'issued', reason: 'reassign',
        actorId: req.user.id, metadata: { replaces: passId } });
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    const [viejoF, nuevoF] = await Promise.all([
      pool.query(`${PASS_SELECT} WHERE p.id = $1`, [passId]),
      pool.query(`${PASS_SELECT} WHERE p.id = $1`, [nuevo]),
    ]);
    // Y el mensaje listo para mandárselo al de repuesto, que es lo siguiente que
    // el titular va a querer hacer.
    const msg = passes.shareMessage({
      code: nuevoF.rows[0].code,
      label: nuevoF.rows[0].label,
      club: reservation.club_name,
      table: reservation.table_code,
      when: reservation.starts_at ? new Date(reservation.starts_at).toISOString() : null,
      baseUrl: publicBaseUrl(),
    });
    res.status(201).json({
      revoked: present(viejoF.rows[0]),
      pass: present(nuevoF.rows[0], { withPayload: true }),
      share: msg,
    });
  }));

/**
 * La historia de un pase.
 *
 * La pide el titular para su propio pase y la puerta para cualquiera. Es la
 * respuesta a "¿quién entró con esto y a qué hora?", y por eso la tabla de atrás
 * es insert-only.
 */
router.get('/nightclubs/:nightclubId/reservations/:reservationId/passes/:passId/history',
  validate({ params: z.object({ nightclubId: uuid, reservationId: uuid, passId: uuid }) }),
  asyncHandler(async (req, res) => {
    const { nightclubId, reservationId, passId } = req.params;
    await loadReservation(null, { nightclubId, reservationId, user: req.user });

    const existe = await pool.query(
      'SELECT id FROM guest_passes WHERE id = $1 AND reservation_id = $2', [passId, reservationId]);
    if (existe.rowCount === 0) throw ApiError.notFound('Pase no encontrado');

    const { rows } = await pool.query(
      `SELECT e.kind, e.reason, e.created_at, u.display_name AS actor_name,
              c.document, c.adult
         FROM guest_pass_events e
         LEFT JOIN users u ON u.id = e.actor_id
         LEFT JOIN door_id_checks c ON c.id = e.id_check_id
        WHERE e.pass_id = $1
        ORDER BY e.created_at DESC, e.id DESC
        LIMIT 100`,
      [passId]);
    // El nombre de quien actuó, nunca su correo: esto lo ve el titular de la mesa.
    res.json({ history: rows });
  }));

module.exports = router;
module.exports.PASS_SELECT = PASS_SELECT;
module.exports.publicBaseUrl = publicBaseUrl;
module.exports.present = present;
