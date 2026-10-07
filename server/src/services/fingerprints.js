/**
 * EV2 — checador de huella (D94).
 *
 * ---------------------------------------------------------------------------
 * Qué hace
 * ---------------------------------------------------------------------------
 * Cada empleado marca entrada y salida poniendo el dedo en el lector de la caja de
 * la barra de abajo. La página captura la huella como imagen PNG (con el agente
 * oficial de HID) y la manda aquí; este archivo la identifica contra las huellas
 * registradas del club y marca la asistencia. A quien tiene turno "normal"
 * (mesero, barman, …) la huella además le abre y cierra el turno. Al cajero solo le
 * marca asistencia: su turno nace con la caja y el fondo (D51).
 *
 * ---------------------------------------------------------------------------
 * Lo que se guarda, y lo que no
 * ---------------------------------------------------------------------------
 * La huella es un dato personal sensible (LFPDPPP). Por eso:
 *   * NUNCA se guarda la imagen. Solo la plantilla de SourceAFIS (un resumen de los
 *     puntos de la huella), cifrada con pgcrypto y la llave `FINGERPRINT_KEY`.
 *   * Sin consentimiento expreso no hay registro, y el consentimiento lo confirma el
 *     propio empleado con SU PIN delante del gerente.
 *   * Al dar de baja al empleado, o si retira su consentimiento, sus plantillas se
 *     borran. La asistencia (`clock_events`) se queda: es un registro laboral y no
 *     contiene nada de la huella.
 *
 * La comparación la hace un servicio aparte (`matcher/`, Java + SourceAFIS) que solo
 * es accesible dentro de la red de Docker. No guarda nada: recibe la imagen y las
 * plantillas en cada petición y contesta puntajes.
 */
'use strict';

const crypto = require('crypto');
const { ApiError } = require('../middleware/errors');
const pins = require('./pins');
const staffShifts = require('./staff-shifts');
const events = require('./events');

/** La versión del aviso de privacidad que se acepta (web/privacidad.html, sección biometría). */
const NOTICE_VERSION = '2026-10';

/** Capturas del mismo dedo al registrarlo. */
const CAPTURES_PER_FINGER = 3;
/** Dedos por persona (decisión del dueño, D94). */
const FINGERS_PER_PERSON = 2;
const FINGERS = ['right_thumb', 'right_index', 'right_middle', 'right_ring', 'right_little',
  'left_thumb', 'left_index', 'left_middle', 'left_ring', 'left_little'];

/** Una marca repetida dentro de este tiempo es la misma marca (el dedo se puso dos veces). */
const REPEAT_SECONDS = 60;
/** Una entrada más vieja que esto ya no se cierra con la siguiente huella: es un olvido. */
const OPEN_ENTRY_HOURS = 16;

const MATCHER_TIMEOUT_MS = 8000;
/** Tamaño máximo de una imagen en base64. Una huella del 4500 pesa decenas de KB. */
const MAX_IMAGE_B64 = 400 * 1024;

// ---------------------------------------------------------------- configuración

/**
 * El umbral de SourceAFIS. Su documentación: "40 corresponde a FMR 0.01%" (una
 * coincidencia falsa en diez mil). Se puede subir desde el .env sin reconstruir.
 */
function threshold() {
  const n = Number(process.env.FINGERPRINT_THRESHOLD || 40);
  return Number.isFinite(n) && n >= 20 && n <= 200 ? n : 40;
}

/** Resolución del lector. La del DigitalPersona 4500 es 512 dpi (ficha del fabricante). */
function dpi() {
  const n = Number(process.env.FINGERPRINT_DPI || 512);
  return Number.isFinite(n) && n >= 300 && n <= 1200 ? n : 512;
}

/** Qué falta para que funcione, o null. Se dice con palabras, para el gerente. */
function configProblem(env = process.env) {
  if (!env.FINGERPRINT_KEY || env.FINGERPRINT_KEY.length < 32) {
    return 'Falta FINGERPRINT_KEY (32 caracteres o más) en el .env del servidor.';
  }
  if (!env.MATCHER_URL) return 'Falta MATCHER_URL en el .env del servidor.';
  if (!env.MATCHER_TOKEN || env.MATCHER_TOKEN.length < 32) {
    return 'Falta MATCHER_TOKEN (32 caracteres o más) en el .env del servidor.';
  }
  return null;
}

const isConfigured = (env = process.env) => configProblem(env) === null;

function requireConfigured() {
  const problema = configProblem();
  if (problema) throw ApiError.notImplemented(`El checador de huella no está configurado. ${problema}`);
}

const key = () => process.env.FINGERPRINT_KEY;

// ---------------------------------------------------------------- el comparador

/**
 * Llama al comparador. Cualquier falla de red se dice como 503 con palabras: el
 * empleado frente al lector necesita saber que no es su dedo.
 */
async function callMatcher(path, body) {
  const url = `${String(process.env.MATCHER_URL).replace(/\/+$/, '')}${path}`;
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-matcher-token': process.env.MATCHER_TOKEN },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(MATCHER_TIMEOUT_MS),
    });
  } catch {
    throw new ApiError(503, 'service_unavailable', 'El comparador de huellas no responde. Avisa al gerente.');
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 422) {
    // La imagen no sirvió (vacía, borrosa, no es una huella). Es del dedo, no del sistema.
    throw ApiError.unprocessable('No se pudo leer la huella. Limpia el lector y vuelve a poner el dedo.',
      { reason: data.error || 'bad_image' });
  }
  if (!res.ok) {
    throw new ApiError(503, 'service_unavailable', 'El comparador de huellas falló. Avisa al gerente.');
  }
  return data;
}

/** Una imagen como llega del navegador: base64 o base64url, con o sin prefijo data:. */
function cleanImage(image) {
  let s = String(image || '').trim();
  const coma = s.indexOf(',');
  if (s.startsWith('data:') && coma > 0) s = s.slice(coma + 1);
  s = s.replace(/-/g, '+').replace(/_/g, '/').replace(/\s+/g, '');
  if (!s || s.length > MAX_IMAGE_B64 || !/^[A-Za-z0-9+/]+=*$/.test(s)) {
    throw ApiError.badRequest('La imagen de la huella no es válida');
  }
  while (s.length % 4) s += '=';
  return s;
}

// ---------------------------------------------------------------- consentimiento

async function activeConsent(runner, { userId }) {
  const { rows } = await runner.query(
    `SELECT id, notice_version, accepted_at, witnessed_by
       FROM biometric_consents WHERE user_id = $1 AND revoked_at IS NULL`, [userId]);
  return rows[0] || null;
}

/**
 * El empleado acepta, confirmando con SU PIN, delante del gerente que registra.
 *
 * El PIN pasa por el mismo freno del club que el acceso (`pins`): si no, esta ruta
 * sería una puerta lateral para adivinar PINes.
 */
async function giveConsent(runner, {
  nightclubId, employee, pin, witnessId, ip = null,
}) {
  if (!/^\d{6}$/.test(String(pin || ''))) {
    throw ApiError.forbidden('PIN incorrecto');
  }
  const fallos = await pins.recentFailures(runner, { nightclubId });
  const espera = pins.delayFor(fallos);
  if (espera > 0) await new Promise((r) => { setTimeout(r, espera); });
  const { user } = await pins.findByPin(runner, { nightclubId, pin });
  const vale = Boolean(user) && user.id === employee.id;
  await pins.recordAttempt(runner, {
    nightclubId, ip, ok: vale, userId: user ? user.id : null,
  });
  if (!vale) throw ApiError.forbidden('PIN incorrecto');

  const ya = await activeConsent(runner, { userId: employee.id });
  if (ya) return ya;
  const { rows } = await runner.query(
    `INSERT INTO biometric_consents (nightclub_id, user_id, notice_version, witnessed_by, ip)
     VALUES ($1,$2,$3::text,$4,$5::text)
     RETURNING id, notice_version, accepted_at, witnessed_by`,
    [nightclubId, employee.id, NOTICE_VERSION, witnessId, ip]);
  return rows[0];
}

/**
 * Retira el consentimiento y borra sus huellas. Lo usan el gerente (a petición del
 * empleado) y la baja del empleado (`reason = 'terminated'`).
 */
async function revokeAndErase(runner, { userId, revokedBy = null, reason = 'requested' }) {
  const borradas = await runner.query('DELETE FROM staff_fingerprints WHERE user_id = $1', [userId]);
  await runner.query(
    `UPDATE biometric_consents SET revoked_at = now(), revoked_by = $2, revoke_reason = $3::text
      WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId, revokedBy, reason]);
  return { fingerprints_deleted: borradas.rowCount };
}

// ---------------------------------------------------------------- registro de huellas

/** Las plantillas de todo el club, descifradas, para comparar. */
async function clubTemplates(runner, { nightclubId, exceptUserId = null }) {
  const { rows } = await runner.query(
    `SELECT f.id::text AS id, f.user_id::text AS user_id, f.finger,
            pgp_sym_decrypt(f.template_enc, $2::text) AS templates
       FROM staff_fingerprints f
       JOIN users u ON u.id = f.user_id
       JOIN biometric_consents c ON c.id = f.consent_id AND c.revoked_at IS NULL
      WHERE f.nightclub_id = $1 AND u.status = 'active'
        AND ($3::uuid IS NULL OR f.user_id <> $3::uuid)`,
    [nightclubId, key(), exceptUserId]);
  const candidatos = [];
  for (const r of rows) {
    JSON.parse(r.templates).forEach((t, i) => {
      candidatos.push({ id: `${r.id}:${i}`, template: t, userId: r.user_id, finger: r.finger });
    });
  }
  return candidatos;
}

/** Agrupa los puntajes por persona y se queda con el mejor de cada una. */
function bestByUser(top, candidatos) {
  const porId = new Map(candidatos.map((c) => [c.id, c]));
  const porUsuario = new Map();
  for (const t of top || []) {
    const c = porId.get(t.id);
    if (!c) continue;
    const prev = porUsuario.get(c.userId);
    if (!prev || t.score > prev.score) porUsuario.set(c.userId, { userId: c.userId, score: t.score });
  }
  return [...porUsuario.values()].sort((a, b) => b.score - a.score);
}

/**
 * Registra un dedo: tres capturas que tienen que parecerse entre sí, y que no se
 * parezcan a la huella de NADIE más del club.
 *
 * Que las capturas coincidan entre sí es lo que asegura que se registró un dedo bien
 * puesto y no tres manchas. Que no coincidan con otra persona es lo que impide que
 * alguien registre su dedo a nombre de otro y marque por él.
 */
async function enrollFinger(runner, {
  nightclubId, employee, finger, images, enrolledBy,
}) {
  requireConfigured();
  if (!FINGERS.includes(finger)) throw ApiError.badRequest('Dedo inválido');
  if (!Array.isArray(images) || images.length !== CAPTURES_PER_FINGER) {
    throw ApiError.badRequest(`Hacen falta ${CAPTURES_PER_FINGER} capturas del mismo dedo`);
  }
  const consent = await activeConsent(runner, { userId: employee.id });
  if (!consent) {
    throw ApiError.unprocessable('Primero el empleado tiene que aceptar el aviso de privacidad con su PIN');
  }
  const { rows: tiene } = await runner.query(
    'SELECT finger FROM staff_fingerprints WHERE user_id = $1', [employee.id]);
  const otros = tiene.filter((r) => r.finger !== finger);
  if (otros.length >= FINGERS_PER_PERSON) {
    throw ApiError.unprocessable(
      `Ya tiene ${FINGERS_PER_PERSON} dedos registrados. Borra uno para registrar otro.`);
  }

  const limpias = images.map(cleanImage);
  const extraido = await callMatcher('/extract', { dpi: dpi(), images: limpias });
  const umbral = threshold();
  const peor = Math.min(...(extraido.pairs || []).map((p) => Number(p[2])));
  if (!Number.isFinite(peor) || peor < umbral) {
    throw ApiError.unprocessable(
      'Las capturas no se parecen entre sí. Pon el mismo dedo, plano y centrado, las tres veces.',
      { worst_pair_score: Number.isFinite(peor) ? peor : null, threshold: umbral });
  }

  // Ni a nombre de otro, ni repitiendo el otro dedo de la misma persona.
  const candidatos = await clubTemplates(runner, { nightclubId });
  if (candidatos.length > 0) {
    for (const imagen of limpias) {
      const r = await callMatcher('/identify', {
        dpi: dpi(), image: imagen, candidates: candidatos.map(({ id, template }) => ({ id, template })),
      });
      const mejor = bestByUser(r.top, candidatos)[0];
      if (mejor && mejor.score >= umbral) {
        if (mejor.userId !== employee.id) {
          const { rows: quien } = await runner.query(
            'SELECT display_name, first_name FROM users WHERE id = $1', [mejor.userId]);
          const nombre = quien[0] ? (quien[0].display_name || quien[0].first_name) : 'otra persona';
          throw ApiError.conflict(`Esa huella ya está registrada a nombre de ${nombre}.`);
        }
        const mismo = candidatos.find((c) => c.userId === employee.id && c.finger !== finger
          && r.top.some((t) => t.id === c.id && t.score >= umbral));
        if (mismo) throw ApiError.conflict('Ese dedo ya está registrado. Usa un dedo de la otra mano.');
      }
    }
  }

  const { rows } = await runner.query(
    `INSERT INTO staff_fingerprints
       (nightclub_id, user_id, finger, template_enc, captures, consent_id, enrolled_by)
     VALUES ($1,$2,$3::text, pgp_sym_encrypt($4::text, $5::text), $6, $7, $8)
     ON CONFLICT (user_id, finger) DO UPDATE
       SET template_enc = EXCLUDED.template_enc, captures = EXCLUDED.captures,
           consent_id = EXCLUDED.consent_id, enrolled_by = EXCLUDED.enrolled_by, created_at = now()
     RETURNING id::text AS id, finger, captures, created_at`,
    [nightclubId, employee.id, finger, JSON.stringify(extraido.templates), key(),
      extraido.templates.length, consent.id, enrolledBy]);
  return { fingerprint: rows[0], quality: { worst_pair_score: peor, threshold: umbral } };
}

async function deleteFinger(runner, { userId, finger }) {
  const { rowCount } = await runner.query(
    'DELETE FROM staff_fingerprints WHERE user_id = $1 AND finger = $2::text', [userId, finger]);
  if (rowCount === 0) throw ApiError.notFound('Ese dedo no está registrado');
}

/** Quién tiene qué, para el panel del gerente. Sin plantillas, claro. */
async function enrollmentStatus(runner, { nightclubId }) {
  const { rows } = await runner.query(
    `SELECT u.id::text AS user_id, COALESCE(u.display_name, u.first_name) AS name, u.role,
            c.accepted_at AS consent_at,
            COALESCE(json_agg(json_build_object('finger', f.finger, 'created_at', f.created_at)
                              ORDER BY f.created_at) FILTER (WHERE f.id IS NOT NULL), '[]') AS fingers
       FROM users u
       JOIN employee_profiles p ON p.user_id = u.id AND p.active
       LEFT JOIN biometric_consents c ON c.user_id = u.id AND c.revoked_at IS NULL
       LEFT JOIN staff_fingerprints f ON f.user_id = u.id
      WHERE u.nightclub_id = $1 AND u.status = 'active'
      GROUP BY u.id, c.accepted_at
      ORDER BY COALESCE(u.display_name, u.first_name)`,
    [nightclubId]);
  return rows;
}

// ---------------------------------------------------------------- PC checadora

const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

async function createStation(runner, { nightclubId, name, createdBy }) {
  const token = crypto.randomBytes(24).toString('base64url');
  const { rows } = await runner.query(
    `INSERT INTO clock_stations (nightclub_id, name, token_hash, token_hint, created_by)
     VALUES ($1,$2::text,$3,$4::text,$5)
     RETURNING id::text AS id, name, token_hint, active, created_at`,
    [nightclubId, name, hashToken(token), token.slice(-6), createdBy]);
  // El token sale una sola vez: lo guarda la PC checadora. La base guarda su huella.
  return { station: rows[0], token };
}

async function stationByToken(runner, token) {
  if (!token || String(token).length < 20) return null;
  const { rows } = await runner.query(
    `SELECT s.id::text AS id, s.nightclub_id::text AS nightclub_id, s.name, s.active,
            n.name AS club_name
       FROM clock_stations s JOIN nightclubs n ON n.id = s.nightclub_id
      WHERE s.token_hash = $1`, [hashToken(token)]);
  const st = rows[0];
  if (!st || !st.active) return null;
  await runner.query('UPDATE clock_stations SET last_seen_at = now() WHERE id = $1', [st.id]);
  return st;
}

async function listStations(runner, { nightclubId }) {
  const { rows } = await runner.query(
    `SELECT id::text AS id, name, token_hint, active, created_at, last_seen_at, revoked_at
       FROM clock_stations WHERE nightclub_id = $1 ORDER BY active DESC, created_at DESC`,
    [nightclubId]);
  return rows;
}

async function revokeStation(runner, { nightclubId, stationId, revokedBy }) {
  const { rowCount } = await runner.query(
    `UPDATE clock_stations SET active = false, revoked_at = now(), revoked_by = $3
      WHERE id = $2 AND nightclub_id = $1 AND active`,
    [nightclubId, stationId, revokedBy]);
  if (rowCount === 0) throw ApiError.notFound('Esa PC checadora no existe o ya estaba dada de baja');
}

// ---------------------------------------------------------------- marcar

/** A quién corresponde esta huella, o un error que se entiende frente al lector. */
async function identify(runner, { nightclubId, image }) {
  requireConfigured();
  const limpia = cleanImage(image);
  const candidatos = await clubTemplates(runner, { nightclubId });
  if (candidatos.length === 0) {
    throw ApiError.unprocessable('Todavía no hay huellas registradas en el club.');
  }
  const r = await callMatcher('/identify', {
    dpi: dpi(), image: limpia, candidates: candidatos.map(({ id, template }) => ({ id, template })),
  });
  const umbral = threshold();
  const [primero, segundo] = bestByUser(r.top, candidatos);
  if (!primero || primero.score < umbral) {
    throw ApiError.notFound('No te reconocí. Vuelve a poner el dedo, plano y centrado.');
  }
  // Dos personas distintas por encima del umbral: no se adivina cuál era.
  if (segundo && segundo.score >= umbral) {
    throw ApiError.conflict('La huella se parece a dos personas. Vuelve a poner el dedo o avisa al gerente.');
  }
  return primero;
}

/**
 * Marca entrada o salida. La siguiente marca es salida si la última fue una entrada
 * de las últimas `OPEN_ENTRY_HOURS` horas; si no, es entrada.
 */
async function punch(client, { station, image }) {
  const quien = await identify(client, { nightclubId: station.nightclub_id, image });

  // Una persona a la vez: dos marcas suyas al mismo tiempo no deben pisarse.
  const { rows: personas } = await client.query(
    `SELECT id::text AS id, role, COALESCE(display_name, first_name) AS name
       FROM users WHERE id = $1 FOR UPDATE`, [quien.userId]);
  const user = personas[0];

  const { rows: ultimas } = await client.query(
    `SELECT kind, created_at, (now() - created_at) < make_interval(secs => $2::int) AS repeated,
            (now() - created_at) < make_interval(hours => $3::int) AS recent
       FROM clock_events WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1`,
    [user.id, REPEAT_SECONDS, OPEN_ENTRY_HOURS]);
  const ultima = ultimas[0];
  if (ultima && ultima.repeated) {
    return {
      user, kind: ultima.kind, at: ultima.created_at, repeated: true, score: quien.score,
    };
  }
  const kind = ultima && ultima.kind === 'in' && ultima.recent ? 'out' : 'in';
  const usaTurno = staffShifts.SHIFT_ROLES.includes(user.role);

  let shiftId = null;
  if (kind === 'in') {
    if (usaTurno) {
      const { shift } = await staffShifts.start(client, { nightclubId: station.nightclub_id, user });
      shiftId = shift.id;
    }
  } else {
    // Cualquier turno abierto —normal o de caja— tiene que poder cerrarse antes de
    // marcar la salida. La caja se cierra con su corte (D54), no con la huella.
    const { rows: abiertos } = await client.query(
      `SELECT id, user_id, section, started_at, ended_at, location_id FROM staff_shifts
        WHERE user_id = $1 AND nightclub_id = $2 AND ended_at IS NULL`,
      [user.id, station.nightclub_id]);
    const abierto = abiertos[0];
    if (abierto && abierto.location_id) {
      const err = ApiError.unprocessable(
        'Haz tu corte primero: tu caja sigue abierta. Al cerrar el corte, vuelve a poner el dedo.');
      err.needsCut = true;
      throw err;
    }
    if (abierto) {
      try {
        const cerrado = await staffShifts.end(client, { nightclubId: station.nightclub_id, userId: user.id });
        shiftId = cerrado.id;
      } catch (err) {
        if (err.needsCut) {
          throw ApiError.unprocessable(
            'Haz tu corte primero: cobraste en este turno. Al cerrar el corte, vuelve a poner el dedo.',
            err.details);
        }
        throw err;
      }
    }
  }

  const { rows } = await client.query(
    `INSERT INTO clock_events (nightclub_id, user_id, station_id, kind, shift_id, score)
     VALUES ($1,$2,$3,$4::text,$5,$6) RETURNING id::text AS id, kind, created_at`,
    [station.nightclub_id, user.id, station.id, kind, shiftId, quien.score]);

  await events.publish({
    nightclubId: station.nightclub_id,
    type: 'clock_punch',
    audience: { roles: ['manager', 'admin'] },
    payload: { user_id: user.id, name: user.name, role: user.role, kind, at: rows[0].created_at },
    client,
  });
  return {
    user, kind, at: rows[0].created_at, repeated: false, score: quien.score, shift_id: shiftId,
  };
}

/** La asistencia, para el gerente. */
async function attendance(runner, { nightclubId, since, until, limit = 500 }) {
  const { rows } = await runner.query(
    `SELECT e.id::text AS id, e.user_id::text AS user_id,
            COALESCE(u.display_name, u.first_name) AS name, u.role,
            e.kind, e.created_at, s.name AS station_name
       FROM clock_events e
       JOIN users u ON u.id = e.user_id
       LEFT JOIN clock_stations s ON s.id = e.station_id
      WHERE e.nightclub_id = $1 AND e.created_at >= $2::timestamptz AND e.created_at < $3::timestamptz
      ORDER BY e.created_at DESC, e.id DESC
      LIMIT $4`,
    [nightclubId, since, until, limit]);
  return rows;
}

module.exports = {
  NOTICE_VERSION, CAPTURES_PER_FINGER, FINGERS_PER_PERSON, FINGERS,
  REPEAT_SECONDS, OPEN_ENTRY_HOURS,
  threshold, dpi, configProblem, isConfigured, cleanImage, bestByUser,
  activeConsent, giveConsent, revokeAndErase,
  enrollFinger, deleteFinger, enrollmentStatus,
  hashToken, createStation, stationByToken, listStations, revokeStation,
  identify, punch, attendance,
};
