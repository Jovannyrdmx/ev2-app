// La puerta: escanear el pase de una reservación, y vender la entrada.
//
// Todo lo de aquí lo hace el personal de la entrada con un teléfono en la mano y
// una fila enfrente. Eso manda en dos decisiones:
//
//   * un pase que no abre devuelve SIEMPRE 200 con un motivo en palabras, no un
//     error. "Esta reservación es de mañana" o "ya entraron a las 11:40" se
//     resuelven hablando; un 404 rojo solo detiene la fila;
//   * lo que se vende se registra en el mismo instante y en el mismo libro que
//     todo lo demás (`transactions`), porque al cierre nadie va a recordar
//     cuántos covers se cobraron.
'use strict';

const express = require('express');
const { pool } = require('../db/pool');
const { ApiError, asyncHandler } = require('../middleware/errors');
const { validate, z, uuid } = require('../middleware/validate');
const { authenticate, requireRole, sameNightclub } = require('../middleware/auth');
const events = require('../services/events');
const door = require('../services/door');
const passes = require('../services/guest-passes');
const QRCode = require('qrcode');
const seating = require('../services/seating');

const router = express.Router({ mergeParams: true });

router.use('/nightclubs/:nightclubId', authenticate, sameNightclub());

const DOOR_ROLES = ['hostess', 'manager', 'admin'];

// Lo que la puerta necesita ver de un pase: quién, qué mesa, cuántos.
const PASS_SELECT = `
  SELECT r.id, r.status, r.starts_at, r.ends_at, r.guest_count, r.pass_code,
         r.checked_in_at, r.special_requests, r.nightclub_id,
         r.user_id, u.display_name AS guest_name, u.phone AS guest_phone,
         t.id AS table_id, t.code AS table_code, t.section, t.floor, t.capacity,
         COALESCE(x.extras, 0)::int AS extras_bought
    FROM reservations r
    JOIN users u ON u.id = r.user_id
    JOIN tables t ON t.id = r.table_id
    LEFT JOIN LATERAL (
      SELECT sum(quantity) AS extras FROM door_admissions a
       WHERE a.reservation_id = r.id AND a.kind = 'vip_extra'
    ) x ON true`;

function presentPass(row, check) {
  return {
    reservation_id: row.id,
    status: row.status,
    pass_code: row.pass_code,
    guest: { id: row.user_id, name: row.guest_name },
    table: {
      id: row.table_id, code: row.table_code, section: row.section,
      floor: row.floor, capacity: row.capacity,
    },
    guest_count: row.guest_count,
    extras_bought: row.extras_bought,
    starts_at: row.starts_at,
    checked_in_at: row.checked_in_at,
    special_requests: row.special_requests || null,
    result: check.status,
    ok: check.ok,
  };
}

// ------------------------------------------------------------------ el pase del cliente

/**
 * El pase que el cliente enseña en la puerta: su código y el QR.
 *
 * El QR se dibuja aquí y no en el teléfono a propósito. Un generador en el
 * navegador serían doscientas líneas de aritmética de Reed-Solomon que nadie va a
 * revisar, y un QR mal generado no falla: se ve bien y no lee. Aquí lo hace una
 * librería probada, y el cliente recibe un SVG que puede guardar, imprimir o
 * enseñar en pantalla.
 *
 * Lo puede pedir el dueño de la reservación y el personal de la puerta. Nadie más:
 * un pase ajeno es una entrada ajena.
 */
router.get('/nightclubs/:nightclubId/reservations/:reservationId/pass',
  validate({ params: z.object({ nightclubId: uuid, reservationId: uuid }) }),
  asyncHandler(async (req, res) => {
    const { nightclubId, reservationId } = req.params;
    const { rows } = await pool.query(
      `${PASS_SELECT} WHERE r.id = $1 AND r.nightclub_id = $2`,
      [reservationId, nightclubId]);
    if (rows.length === 0) throw ApiError.notFound('Reservación no encontrada');
    const row = rows[0];

    const esSuyo = row.user_id === req.user.id;
    const esPersonal = DOOR_ROLES.includes(req.user.role);
    if (!esSuyo && !esPersonal) throw ApiError.notFound('Reservación no encontrada');

    if (!row.pass_code) throw ApiError.conflict('Esta reservación todavía no tiene pase');

    // El QR lleva el código pelón, no una dirección: así lo lee cualquier lector,
    // y si el cliente enseña la pantalla apagada el código sigue debajo, escrito.
    const qr = await QRCode.toString(row.pass_code, {
      type: 'svg', errorCorrectionLevel: 'M', margin: 1, width: 320,
      color: { dark: '#000000', light: '#ffffff' },
    });

    res.json({
      pass: {
        code: row.pass_code,
        qr_svg: qr,
        guest_name: row.guest_name,
        table_code: row.table_code,
        section: row.section,
        guest_count: row.guest_count,
        starts_at: row.starts_at,
        status: row.status,
        checked_in_at: row.checked_in_at,
      },
    });
  }));

// ------------------------------------------------------------------ leer un pase

/**
 * Mirar sin dejar entrar. Sirve para que la puerta compruebe un pase dudoso —o
 * conteste "¿a qué hora es mi reservación?"— sin gastarlo.
 */
router.get('/nightclubs/:nightclubId/door/pass/:code',
  requireRole(...DOOR_ROLES),
  validate({ params: z.object({ nightclubId: uuid, code: z.string().trim().min(4).max(30) }) }),
  asyncHandler(async (req, res) => {
    const code = door.normalizePassCode(req.params.code);
    const { rows } = await pool.query(
      `${PASS_SELECT} WHERE r.pass_code = $1 AND r.nightclub_id = $2`,
      [code, req.params.nightclubId]);
    if (rows.length === 0) {
      return res.json({ pass: null, result: door.PASS_STATUS.notFound, ok: false });
    }
    return res.json({ pass: presentPass(rows[0], door.checkPass(rows[0])) });
  }));

// ------------------------------------------------------------------ la identificación

/**
 * La revisión de la identificación, que va ANTES del escaneo.
 *
 * Este es el orden que pidió el club y el que el backend obliga: seguridad pide
 * la INE, la mira, la registra aquí, y solo entonces escanea el QR. No es un
 * paso de papel: `check-in` se niega sin una revisión aceptada, fresca y sin
 * gastar. Eso compra dos cosas concretas:
 *
 *   * un menor de edad o una identificación inválida NO queman el pase. Se
 *     registra el rechazo, el pase sigue vivo, y el titular lo puede reasignar a
 *     alguien más esa misma noche;
 *   * "¿quién dejó entrar a esta persona?" tiene respuesta con nombre y hora,
 *     sin que el club guarde el número de una sola credencial.
 *
 * Lo que NO se guarda, a propósito: el número de la identificación, la fecha de
 * nacimiento y cualquier foto. Se guarda qué documento se enseñó, si era mayor
 * de edad, si se aceptó, por qué no, y quién lo revisó.
 */
router.post('/nightclubs/:nightclubId/door/id-checks',
  requireRole(...DOOR_ROLES),
  validate({
    params: z.object({ nightclubId: uuid }),
    body: z.object({
      document: z.enum(['ine', 'passport', 'license', 'other', 'none']),
      adult: z.boolean(),
      decision: z.enum(['accepted', 'rejected']),
      reason: z.string().trim().max(200).optional(),
    })
      // Una revisión aceptada de un menor de edad no existe. Se contesta 400 y no
      // 200: no es un pase que no abre, es una petición que se contradice.
      .refine((b) => b.decision === 'rejected' || b.adult, {
        message: 'Un menor de edad no se acepta', path: ['adult'],
      })
      .refine((b) => b.decision === 'accepted' || (b.reason && b.reason.length >= 3), {
        message: 'Un rechazo lleva motivo', path: ['reason'],
      }),
  }),
  asyncHandler(async (req, res) => {
    const b = req.body;
    const { rows } = await pool.query(
      `INSERT INTO door_id_checks (nightclub_id, document, adult, decision, reason, checked_by)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING id, document, adult, decision, reason, created_at`,
      [req.params.nightclubId, b.document, b.adult, b.decision,
        b.decision === 'rejected' ? b.reason : (b.reason || null), req.user.id],
    );
    const check = rows[0];
    res.status(201).json({
      id_check: {
        ...check,
        // Cuánto le queda de vida. La pantalla lo usa para avisar antes de que se
        // venza, en vez de dejar que el escaneo falle con la fila esperando.
        expires_at: new Date(new Date(check.created_at).getTime()
          + passes.ID_CHECK_MINUTES * 60_000).toISOString(),
        valid_minutes: passes.ID_CHECK_MINUTES,
      },
    });
  }));

// ------------------------------------------------------------------ dejar entrar

// Lo que la puerta necesita del pase individual, y de la reservación detrás.
const GUEST_PASS_SELECT = `
  SELECT p.id, p.code, p.kind, p.status, p.label, p.expires_at, p.used_at, p.used_by,
         p.revoke_reason, p.nightclub_id, p.reservation_id, p.admission_id,
         r.status AS reservation_status, r.starts_at, r.ends_at, r.guest_count,
         r.user_id AS holder_id, r.checked_in_at,
         hu.display_name AS holder_name,
         t.id AS table_id, t.code AS table_code, t.section, t.floor, t.capacity,
         COALESCE(inside.n, 0)::int AS already_inside
    FROM guest_passes p
    LEFT JOIN reservations r ON r.id = p.reservation_id
    LEFT JOIN users hu ON hu.id = r.user_id
    LEFT JOIN tables t ON t.id = r.table_id
    LEFT JOIN LATERAL (
      SELECT count(*) AS n FROM guest_passes q
       WHERE q.reservation_id = p.reservation_id AND q.status = 'used'
    ) inside ON true`;

function presentGuestPass(row, check) {
  return {
    id: row.id,
    code: row.code,
    kind: row.kind,
    status: row.status,
    label: row.label,
    expires_at: row.expires_at,
    used_at: row.used_at,
    reservation_id: row.reservation_id,
    holder_name: row.holder_name || null,
    guest_count: row.guest_count,
    already_inside: row.already_inside,
    table: row.table_id ? {
      id: row.table_id, code: row.table_code, section: row.section,
      floor: row.floor, capacity: row.capacity,
    } : null,
    starts_at: row.starts_at,
    result: check.status,
    ok: check.ok,
    reason: check.reason || null,
  };
}

/**
 * El escaneo de la entrada. Entra UNA persona por pase, y el pase se gasta.
 *
 * Un pase que no abre NO es un error: se contesta 200 con el motivo en palabras,
 * porque la persona de la puerta necesita leerlo y explicarlo, no un código de
 * estado. Los únicos 4xx de aquí son los que no puede resolver hablando: no
 * mandaste la revisión de identificación, o la revisión ya se gastó.
 *
 * La mesa se sienta con el PRIMER pase que entra, no con el del titular: los
 * amigos llegan antes que el que reservó más veces de las que nadie quisiera
 * admitir, y hacerlos esperar afuera con su pase válido es la pelea de la
 * entrada.
 */
router.post('/nightclubs/:nightclubId/door/check-in',
  requireRole(...DOOR_ROLES),
  validate({
    params: z.object({ nightclubId: uuid }),
    body: z.object({
      code: z.string().trim().min(4).max(200),
      id_check_id: uuid,
    }),
  }),
  asyncHandler(async (req, res) => {
    const { nightclubId } = req.params;
    // Lo que llega puede ser el payload firmado del QR, un enlace, o el código
    // pelón tecleado cuando la pantalla está rota.
    const leido = passes.parse(req.body.code);
    if (!leido.code) {
      return res.json({ pass: null, result: passes.PASS_STATUS.notFound, ok: false });
    }
    // Una firma que no cuadra se rechaza sin tocar la base: es un QR fabricado.
    if (leido.signed && !passes.verifySignature(leido.code, leido.signature)) {
      return res.json({ pass: null, result: passes.PASS_STATUS.forged, ok: false });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // La revisión de identificación primero, y bloqueada: dos guardias
      // escaneando a la vez con la misma revisión es justo la carrera que esto
      // cierra. `FOR UPDATE` en la revisión, no en el pase, porque la revisión es
      // lo único que los dos comparten.
      const rev = await client.query(
        `SELECT id, adult, decision, consumed_by, checked_by, created_at
           FROM door_id_checks
          WHERE id = $1 AND nightclub_id = $2 FOR UPDATE`,
        [req.body.id_check_id, nightclubId]);
      if (rev.rowCount === 0) {
        await client.query('ROLLBACK');
        throw ApiError.notFound('Esa revisión de identificación no existe');
      }
      const usable = passes.idCheckIsUsable(rev.rows[0], { staffId: req.user.id });

      const { rows } = await client.query(
        `${GUEST_PASS_SELECT} WHERE p.code = $1 AND p.nightclub_id = $2 FOR UPDATE OF p`,
        [leido.code, nightclubId]);
      if (rows.length === 0) {
        await client.query('ROLLBACK');
        return res.json({ pass: null, result: passes.PASS_STATUS.notFound, ok: false });
      }
      const row = rows[0];

      // El pase se juzga primero para poder registrar POR QUÉ no abrió, aunque la
      // revisión también estuviera mal: en la puerta importa más "este QR ya se
      // usó a las 11:40" que "te falta la revisión".
      // La reservación se arma aparte y no se pasa `row` entero: `row.status` es el
      // del PASE, y confundirlo con el de la reservación dejaba entrar a una mesa
      // sin pagar. Lo encontró la prueba de "sin pagar se distingue de cancelada".
      const reserva = row.reservation_id ? {
        status: row.reservation_status,
        starts_at: row.starts_at,
        ends_at: row.ends_at,
        checked_in_at: row.checked_in_at,
      } : null;
      const check = passes.check(row, reserva, { scan: leido });
      if (!check.ok) {
        await passes.audit(client, { passId: row.id, kind: 'denied', reason: check.status,
          actorId: req.user.id, idCheckId: rev.rows[0].id });
        await client.query('COMMIT');
        return res.json({ pass: presentGuestPass(row, check) });
      }

      if (!usable.ok) {
        // El pase está bien y la revisión no. Se registra el intento y NO se gasta
        // el pase: esa persona puede volver con su identificación, o el titular le
        // reasigna el lugar a alguien más.
        await passes.audit(client, { passId: row.id, kind: 'denied', reason: usable.reason,
          actorId: req.user.id, idCheckId: rev.rows[0].id });
        await client.query('COMMIT');
        return res.json({
          pass: presentGuestPass(row, { status: passes.PASS_STATUS.noIdCheck, ok: false }),
          id_check: { ok: false, reason: usable.reason },
        });
      }

      // Gastar el pase y gastar la revisión, en la misma transacción.
      await client.query(
        `UPDATE guest_passes SET status = 'used', used_at = now(), used_by = $2 WHERE id = $1`,
        [row.id, req.user.id]);
      await client.query(
        'UPDATE door_id_checks SET consumed_by = $2, consumed_at = now() WHERE id = $1',
        [rev.rows[0].id, row.id]);
      await passes.audit(client, { passId: row.id, kind: 'admitted', actorId: req.user.id,
        idCheckId: rev.rows[0].id, metadata: { kind: row.kind } });

      // Y sentar la mesa, si este es el primero que entra.
      let seated = false;
      if (row.reservation_id && row.reservation_status !== 'seated') {
        await client.query(
          `UPDATE reservations
              SET status = 'seated', checked_in_at = COALESCE(checked_in_at, now()),
                  checked_in_by = $2, updated_at = now()
            WHERE id = $1`,
          [row.reservation_id, req.user.id]);
        // Sentar de verdad al titular: sin esto la mesa se pinta ocupada y el
        // cliente sigue sin poder pedir nada desde su teléfono.
        if (row.table_id && row.holder_id) {
          await seating.seatUser(client, { tableId: row.table_id, userId: row.holder_id });
        }
        seated = true;
        await events.publish({
          nightclubId, type: 'reservation_seated', client,
          audience: { roles: ['hostess', 'manager', 'waiter'], userIds: [row.holder_id] },
          payload: {
            reservation_id: row.reservation_id, table_id: row.table_id,
            table_code: row.table_code, guest_count: row.guest_count,
            first_entry: true,
          },
        });
      }

      await events.publish({
        nightclubId, type: 'guest_pass_admitted', client,
        audience: { roles: ['hostess', 'manager'] },
        payload: {
          pass_id: row.id, kind: row.kind, reservation_id: row.reservation_id,
          table_code: row.table_code, inside: row.already_inside + 1,
        },
      });
      await client.query('COMMIT');

      const fresco = await pool.query(`${GUEST_PASS_SELECT} WHERE p.id = $1`, [row.id]);
      return res.status(200).json({
        pass: presentGuestPass(fresco.rows[0], { status: passes.PASS_STATUS.ok, ok: true }),
        admitted: true,
        seated,
      });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }));

// ------------------------------------------------------------------ sin QR en la mano

/**
 * Buscar a alguien que llega sin su QR: teléfono muerto, pantalla rota, nunca le
 * llegó el mensaje.
 *
 * Se busca por folio (el código de la reservación), nombre o teléfono. Es
 * personal de la puerta con la fila enfrente, así que se contesta con lo mínimo
 * para reconocer a la persona y nada más: el nombre del titular, la mesa, la
 * hora y cómo van sus pases.
 *
 * El teléfono se busca por sus últimos dígitos y NO se devuelve: la puerta
 * pregunta "¿tu teléfono termina en 4821?" y compara. Devolverlo convertiría
 * esta ruta en un directorio de los clientes del club.
 */
router.get('/nightclubs/:nightclubId/door/lookup',
  requireRole(...DOOR_ROLES),
  validate({
    params: z.object({ nightclubId: uuid }),
    query: z.object({ q: z.string().trim().min(3).max(60) }),
  }),
  asyncHandler(async (req, res) => {
    const { nightclubId } = req.params;
    const q = req.query.q;
    const digitos = q.replace(/\D/g, '');
    const { rows } = await pool.query(
      `SELECT r.id, r.status, r.starts_at, r.guest_count, r.pass_code,
              u.display_name AS holder_name,
              right(regexp_replace(COALESCE(u.phone, ''), '\\D', '', 'g'), 4) AS phone_last4,
              t.code AS table_code, t.section, t.floor,
              COALESCE(pz.total, 0)::int   AS passes_total,
              COALESCE(pz.used, 0)::int    AS passes_used,
              COALESCE(pz.active, 0)::int  AS passes_active
         FROM reservations r
         JOIN users u ON u.id = r.user_id
         JOIN tables t ON t.id = r.table_id
         LEFT JOIN LATERAL (
           SELECT count(*) AS total,
                  count(*) FILTER (WHERE status = 'used') AS used,
                  count(*) FILTER (WHERE status = 'active') AS active
             FROM guest_passes g WHERE g.reservation_id = r.id
         ) pz ON true
        WHERE r.nightclub_id = $1
          AND r.status IN ('pending_payment','confirmed','seated')
          AND r.starts_at > now() - interval '12 hours'
          AND (
            r.pass_code = $2
            OR u.display_name ILIKE '%' || $3 || '%'
            OR ($4 <> '' AND regexp_replace(COALESCE(u.phone, ''), '\\D', '', 'g') LIKE '%' || $4)
          )
        ORDER BY r.starts_at
        LIMIT 20`,
      [nightclubId, door.normalizePassCode(q), q, digitos]);
    res.json({ reservations: rows });
  }));

/**
 * El pase de contingencia: temporal, de un uso, con motivo y con nombre de quién
 * lo emitió.
 *
 * Existe porque la alternativa real es peor. Sin esto, el invitado que llega sin
 * su QR entra porque el de la puerta lo deja pasar de palabra, y de eso no queda
 * registro de ninguna clase. Con esto queda: quién lo emitió, por qué, a nombre
 * de quién, y que se venció a los 45 minutos aunque no se haya usado.
 *
 * No consume un pase de la reservación ni se lo quita a nadie. Es una entrada
 * más, y el gerente tiene que poder ver cuántas se emitieron en una noche: una
 * puerta que emite treinta contingencias es una puerta que está regalando
 * entradas.
 */
router.post('/nightclubs/:nightclubId/door/passes/contingency',
  requireRole(...DOOR_ROLES),
  validate({
    params: z.object({ nightclubId: uuid }),
    body: z.object({
      reservation_id: uuid,
      label: z.string().trim().max(60).optional(),
      reason: z.string().trim().min(5).max(200),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { nightclubId } = req.params;
    const b = req.body;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const r = await client.query(
        `SELECT id, status, starts_at FROM reservations
          WHERE id = $1 AND nightclub_id = $2`,
        [b.reservation_id, nightclubId]);
      if (r.rowCount === 0) throw ApiError.notFound('Reservación no encontrada');
      if (!['confirmed', 'seated'].includes(r.rows[0].status)) {
        // Una reservación sin pagar no genera entradas ni por la puerta de atrás.
        throw ApiError.conflict('Esa reservación no está confirmada', { status: r.rows[0].status });
      }

      let creado = null;
      for (let intento = 0; intento < 5 && !creado; intento += 1) {
        try {
          const ins = await client.query(
            `INSERT INTO guest_passes (nightclub_id, reservation_id, code, kind, label,
                                       expires_at, created_by)
             VALUES ($1,$2,$3,'contingency',$4,$5,$6)
             RETURNING id, code, kind, status, label, expires_at, created_at`,
            [nightclubId, b.reservation_id, passes.generateCode(), b.label || null,
              passes.contingencyExpiry(), req.user.id]);
          creado = ins.rows[0];
        } catch (err) {
          if (err.code !== '23505') throw err;
        }
      }
      if (!creado) throw ApiError.conflict('No se pudo generar el pase, inténtalo otra vez');

      await passes.audit(client, { passId: creado.id, kind: 'issued', reason: b.reason,
        actorId: req.user.id, metadata: { kind: 'contingency' } });
      await events.publish({
        nightclubId, type: 'guest_pass_contingency', client,
        audience: { roles: ['manager', 'admin'] },
        payload: { pass_id: creado.id, reservation_id: b.reservation_id, reason: b.reason },
      });
      await client.query('COMMIT');

      // El payload firmado va aquí porque la pantalla de la puerta va a dibujar
      // el QR en el acto y se lo va a enseñar a la persona.
      return res.status(201).json({
        pass: { ...creado, payload: passes.payload(creado.code) },
        valid_minutes: passes.CONTINGENCY_MINUTES,
      });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }));

// ------------------------------------------------------------------ los covers del club

/**
 * El catálogo de entradas (migración 027).
 *
 * Nace vacío a propósito. Antes los tres covers del club vivían escritos dentro de
 * `web/js/staff-screen.js` —$150, $100, $50— y el servidor aceptaba cualquier número
 * que llegara, porque no tenía con qué compararlo. Inventar aquí esos tres precios
 * sería mudar el mismo defecto de archivo.
 */
router.get('/nightclubs/:nightclubId/cover-prices',
  requireRole(...DOOR_ROLES),
  validate({ params: z.object({ nightclubId: uuid }) }),
  asyncHandler(async (req, res) => {
    const gerente = req.user.role === 'manager' || req.user.role === 'admin';
    const { rows } = await pool.query(
      `SELECT id, name, amount::text AS amount, currency, active, sort_order
         FROM cover_prices
        WHERE nightclub_id = $1 AND ($2::boolean OR active)
        ORDER BY active DESC, sort_order, name`,
      [req.params.nightclubId, gerente]);
    res.json({ cover_prices: rows });
  }));

router.post('/nightclubs/:nightclubId/cover-prices',
  requireRole('manager'),
  validate({
    params: z.object({ nightclubId: uuid }),
    body: z.object({
      name: z.string().trim().min(1).max(40),
      amount: z.number().min(0).max(100000),
      currency: z.enum(['MXN', 'USD']).default('MXN'),
      sort_order: z.number().int().min(0).max(999).default(0),
    }),
  }),
  asyncHandler(async (req, res) => {
    const b = req.body;
    try {
      const { rows } = await pool.query(
        `INSERT INTO cover_prices (nightclub_id, name, amount, currency, sort_order, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6)
         RETURNING id, name, amount::text AS amount, currency, active, sort_order`,
        [req.params.nightclubId, b.name, b.amount, b.currency, b.sort_order, req.user.id]);
      res.status(201).json({ cover_price: rows[0] });
    } catch (err) {
      if (err.code === '23505') throw ApiError.conflict('Ya hay un cover con ese nombre');
      throw err;
    }
  }));

/**
 * Cambiar un cover.
 *
 * El precio se puede corregir, y eso NO toca las entradas ya vendidas: cada una guarda
 * su `unit_price` en la fila. Subir el cover a media noche cobra distinto de ahí en
 * adelante, no hacia atrás.
 */
router.patch('/nightclubs/:nightclubId/cover-prices/:coverId',
  requireRole('manager'),
  validate({
    params: z.object({ nightclubId: uuid, coverId: uuid }),
    body: z.object({
      name: z.string().trim().min(1).max(40).optional(),
      amount: z.number().min(0).max(100000).optional(),
      active: z.boolean().optional(),
      sort_order: z.number().int().min(0).max(999).optional(),
    }).refine((v) => Object.keys(v).length > 0, { message: 'No hay nada que cambiar' }),
  }),
  asyncHandler(async (req, res) => {
    const b = req.body;
    const { rows } = await pool.query(
      `UPDATE cover_prices
          SET name = COALESCE($3::text, name),
              amount = COALESCE($4::numeric, amount),
              active = COALESCE($5::boolean, active),
              sort_order = COALESCE($6::int, sort_order),
              updated_by = $7, updated_at = now()
        WHERE id = $1 AND nightclub_id = $2
        RETURNING id, name, amount::text AS amount, currency, active, sort_order`,
      [req.params.coverId, req.params.nightclubId, b.name ?? null, b.amount ?? null,
        b.active ?? null, b.sort_order ?? null, req.user.id]);
    if (rows.length === 0) throw ApiError.notFound('Ese cover no existe');
    res.json({ cover_price: rows[0] });
  }));

// ------------------------------------------------------------------ vender la entrada

const admissionSchema = z.object({
  client_request_id: uuid.optional(),
  kind: z.enum(['general', 'vip_extra']),
  reservation_id: uuid.optional(),
  quantity: z.number().int().min(1).max(50).default(1),
  // Cuál de los covers del club. Es la forma correcta de vender una entrada
  // general: el precio sale del catálogo y no de lo que teclee quien cobra.
  cover_price_id: uuid.optional(),
  // El precio tecleado. Ya NO se cree por sí solo (ver `resolvePrice`): solo se
  // acepta cuando el club todavía no tiene covers dados de alta, y entonces queda
  // marcado como `manual` para que el corte lo distinga.
  unit_price: z.number().min(0).max(100000).optional(),
  currency: z.enum(['MXN', 'USD']).default('MXN'),
  payment_method: z.enum(['cash', 'card', 'transfer', 'courtesy']).default('cash'),
  notes: z.string().trim().max(200).optional(),
  event_id: uuid.optional(),
  // Los nombres de los invitados extra, en el orden en que se emiten sus pases.
  // Opcional: en la puerta a veces no hay tiempo de teclear nada.
  labels: z.array(z.string().trim().max(60)).max(50).optional(),
}).refine((b) => b.kind !== 'vip_extra' || b.reservation_id, {
  message: 'Un extra VIP va contra una reservación', path: ['reservation_id'],
});

/**
 * De dónde sale el precio de una entrada.
 *
 * Esta función existe por un defecto que costaba dinero todas las noches: la ruta
 * aceptaba `unit_price` del cuerpo y lo asentaba en el libro sin compararlo con nada.
 * Quien cobra ponía el precio, y al cierre la caja cuadraba contra un total que él
 * mismo había escrito.
 *
 * El orden es deliberado:
 *
 *   1. `cover_price_id` — el catálogo del club. Es la forma correcta.
 *   2. Un extra VIP se cobra a la tarifa de ESA noche (`events_calendar.ticket_price`),
 *      que es la misma que usa la cotización de la reservación para las personas de
 *      más. Si las dos no salieran del mismo sitio, un extra comprado en la puerta y
 *      uno reservado costarían distinto.
 *   3. Tecleado — solo si el club no tiene covers dados de alta todavía. Se marca
 *      `manual` y se guarda así en la fila y en el libro.
 *
 * Un precio tecleado que NO coincide con el del catálogo se rechaza: puede ser un
 * descuento legítimo, pero esa decisión es del gerente y tiene que quedar escrita,
 * no resuelta en la puerta tecleando otro número.
 */
async function resolvePrice(client, { nightclubId, body }) {
  if (body.cover_price_id) {
    const { rows } = await client.query(
      `SELECT id, name, amount::text AS amount, currency, active
         FROM cover_prices WHERE id = $1 AND nightclub_id = $2`,
      [body.cover_price_id, nightclubId]);
    if (rows.length === 0) throw ApiError.notFound('Ese cover no existe');
    const cover = rows[0];
    if (!cover.active) throw ApiError.unprocessable(`El cover "${cover.name}" está dado de baja`);
    if (body.unit_price !== undefined
      && Number(body.unit_price).toFixed(2) !== Number(cover.amount).toFixed(2)) {
      throw ApiError.unprocessable(
        `El cover "${cover.name}" cuesta ${cover.amount}, no ${body.unit_price}. `
        + 'Un precio distinto lo autoriza el gerente, no la puerta.',
        { expected: cover.amount, sent: String(body.unit_price) });
    }
    return {
      unitPrice: Number(cover.amount), currency: cover.currency,
      source: 'catalog', coverPriceId: cover.id,
    };
  }

  if (body.kind === 'vip_extra' && body.reservation_id) {
    const { rows } = await client.query(
      `SELECT e.ticket_price::text AS ticket_price, e.currency
         FROM reservations r JOIN events_calendar e ON e.id = r.event_id
        WHERE r.id = $1 AND r.nightclub_id = $2`,
      [body.reservation_id, nightclubId]);
    if (rows.length > 0 && rows[0].ticket_price !== null) {
      const noche = rows[0];
      if (body.unit_price !== undefined
        && Number(body.unit_price).toFixed(2) !== Number(noche.ticket_price).toFixed(2)) {
        throw ApiError.unprocessable(
          `Un extra de esta noche cuesta ${noche.ticket_price}, no ${body.unit_price}.`,
          { expected: noche.ticket_price, sent: String(body.unit_price) });
      }
      return {
        unitPrice: Number(noche.ticket_price), currency: noche.currency || body.currency,
        source: 'event', coverPriceId: null,
      };
    }
  }

  // El club todavía no tiene catálogo. Se acepta lo tecleado para no dejar la puerta
  // sin poder vender, y se marca para que se vea en el corte.
  const { rows } = await client.query(
    'SELECT count(*)::int AS n FROM cover_prices WHERE nightclub_id = $1 AND active',
    [nightclubId]);
  if (rows[0].n > 0) {
    throw ApiError.unprocessable(
      'Escoge uno de los covers del club. El precio ya no se teclea en la puerta.',
      { covers_registered: rows[0].n });
  }
  if (body.unit_price === undefined) {
    throw ApiError.unprocessable('Falta el precio: escoge un cover o captura el importe');
  }
  return {
    unitPrice: body.unit_price, currency: body.currency, source: 'manual', coverPriceId: null,
  };
}

router.post('/nightclubs/:nightclubId/door/admissions',
  requireRole(...DOOR_ROLES),
  validate({ params: z.object({ nightclubId: uuid }), body: admissionSchema }),
  asyncHandler(async (req, res) => {
    const { nightclubId } = req.params;
    const b = req.body;

    // El doble toque de la puerta. Con mal wifi la pantalla se queda pensando y el
    // cadenero toca otra vez: sin esto son dos entradas, dos renglones en el libro y
    // dos juegos de QR válidos, y al cierre la caja aparece corta por la diferencia.
    // La clave estaba declarada en el esquema desde el principio y nunca se leía.
    if (b.client_request_id) {
      const yaEsta = await pool.query(
        `SELECT id, kind, quantity, unit_price::text, total::text, currency,
                payment_method, reservation_id, created_at
           FROM door_admissions WHERE client_request_id = $1 AND nightclub_id = $2`,
        [b.client_request_id, nightclubId]);
      if (yaEsta.rowCount > 0) {
        res.set('Idempotent-Replay', 'true');
        return res.status(200).json({ admission: yaEsta.rows[0], passes: [], idempotent: true });
      }
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const precio = await resolvePrice(client, { nightclubId, body: b });
      const total = Math.round(precio.unitPrice * b.quantity * 100) / 100;

      if (b.reservation_id) {
        const r = await client.query(
          'SELECT id FROM reservations WHERE id = $1 AND nightclub_id = $2',
          [b.reservation_id, nightclubId]);
        if (r.rowCount === 0) throw ApiError.notFound('Reservación no encontrada');
      }

      // Una cortesía no es dinero: se registra el acceso, pero no se inventa un
      // renglón de cobro por cero pesos en el libro.
      let transactionId = null;
      if (b.payment_method !== 'courtesy' && total > 0) {
        const tx = await client.query(
          `INSERT INTO transactions (nightclub_id, type, direction, amount, currency, status,
                                     provider, reference_type, metadata)
           VALUES ($1,'cover','in',$2,$3,'paid',$4,'door_admission',$5)
           RETURNING id`,
          [nightclubId, total, precio.currency,
            b.payment_method === 'cash' ? 'cash' : 'manual',
            JSON.stringify({
              kind: b.kind, quantity: b.quantity, payment_method: b.payment_method,
              reservation_id: b.reservation_id || null, sold_by: req.user.id,
              // De dónde salió el precio. Un 'manual' en el corte es un renglón que
              // alguien tecleó, y eso se puede mirar.
              price_source: precio.source,
            })],
        );
        transactionId = tx.rows[0].id;
      }

      const { rows } = await client.query(
        `INSERT INTO door_admissions (nightclub_id, event_id, kind, reservation_id, quantity,
                                      unit_price, total, currency, payment_method,
                                      transaction_id, sold_by, notes,
                                      client_request_id, price_source, cover_price_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::text,$15)
         RETURNING id, kind, quantity, unit_price::text, total::text, currency,
                   payment_method, reservation_id, price_source, created_at`,
        [nightclubId, b.event_id || null, b.kind, b.reservation_id || null, b.quantity,
          precio.unitPrice, total, precio.currency, b.payment_method, transactionId,
          req.user.id, b.notes || null,
          b.client_request_id || null, precio.source, precio.coverPriceId],
      );

      // Cada extra pagado se lleva su propio QR. Sin esto, "pagué dos extras" se
      // resolvía dejando pasar a dos personas de palabra, y el conteo de adentro y
      // el del cobro dejaban de cuadrar en cuanto alguien salía a fumar y volvía.
      //
      // Un cover general NO lleva pase: esa persona no tiene mesa, entra y se para
      // donde quiera, y emitirle un QR que nadie va a volver a escanear sería
      // papeleo que finge control.
      let emitidos = [];
      if (b.kind === 'vip_extra') {
        emitidos = await passes.issueForAdmission(client, {
          nightclubId,
          admissionId: rows[0].id,
          reservationId: b.reservation_id || null,
          quantity: b.quantity,
          actorId: req.user.id,
          labels: b.labels || [],
        });
      }

      await events.publish({
        nightclubId, type: 'door_admission', client,
        audience: { roles: ['hostess', 'manager'] },
        payload: { kind: b.kind, quantity: b.quantity, total: String(total) },
      });
      await client.query('COMMIT');
      return res.status(201).json({
        admission: rows[0],
        // Con el payload firmado: la pantalla de la puerta dibuja el QR y se lo
        // enseña a la persona que acaba de pagar.
        passes: emitidos.map((p) => ({ ...p, payload: passes.payload(p.code) })),
      });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      // Los dos toques llegaron a la vez y el índice único paró al segundo. No es un
      // error para quien está en la puerta: la entrada SÍ se vendió.
      if (err.code === '23505' && b.client_request_id) {
        const yaEsta = await pool.query(
          `SELECT id, kind, quantity, unit_price::text, total::text, currency,
                  payment_method, reservation_id, created_at
             FROM door_admissions WHERE client_request_id = $1 AND nightclub_id = $2`,
          [b.client_request_id, nightclubId]);
        if (yaEsta.rowCount > 0) {
          res.set('Idempotent-Replay', 'true');
          return res.status(200).json({ admission: yaEsta.rows[0], passes: [], idempotent: true });
        }
      }
      throw err;
    } finally {
      client.release();
    }
  }));

// ------------------------------------------------------------------ el aforo

/**
 * Cuánta gente hay adentro, ahora.
 *
 * Se cuenta por separado lo reservado y lo vendido en la puerta porque son dos
 * negocios distintos: una noche puede ir floja de mesas y llena de general, y un
 * solo número escondería eso.
 */
router.get('/nightclubs/:nightclubId/door/summary',
  requireRole(...DOOR_ROLES),
  validate({ params: z.object({ nightclubId: uuid }) }),
  asyncHandler(async (req, res) => {
    const id = req.params.nightclubId;
    const [reservas, ventas, mesas] = await Promise.all([
      pool.query(
        `SELECT count(*) FILTER (WHERE status IN ('confirmed','pending_payment'))::int AS esperadas,
                count(*) FILTER (WHERE status = 'seated')::int AS adentro,
                count(*) FILTER (WHERE status = 'no_show')::int AS no_llegaron,
                COALESCE(sum(guest_count) FILTER (WHERE status = 'seated'), 0)::int AS personas_vip
           FROM reservations
          WHERE nightclub_id = $1 AND starts_at > now() - interval '12 hours'`,
        [id]),
      pool.query(
        `SELECT COALESCE(sum(quantity) FILTER (WHERE kind = 'general'), 0)::int AS generales,
                COALESCE(sum(quantity) FILTER (WHERE kind = 'vip_extra'), 0)::int AS extras_vip,
                COALESCE(sum(total), 0)::text AS cobrado,
                COALESCE(max(currency), 'MXN') AS currency
           FROM door_admissions
          WHERE nightclub_id = $1 AND created_at > now() - interval '12 hours'`,
        [id]),
      pool.query(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE status = 'occupied')::int AS ocupadas
           FROM tables WHERE nightclub_id = $1 AND active`,
        [id]),
    ]);
    const r = reservas.rows[0];
    const v = ventas.rows[0];
    res.json({
      reservations: r,
      door: v,
      tables: mesas.rows[0],
      inside: r.personas_vip + v.generales + v.extras_vip,
      generated_at: new Date().toISOString(),
    });
  }));

module.exports = router;
module.exports.PASS_SELECT = PASS_SELECT;
