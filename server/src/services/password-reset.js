/**
 * "Olvidé mi contraseña" por correo (D131).
 *
 * ---------------------------------------------------------------------------
 * Cómo funciona
 * ---------------------------------------------------------------------------
 * 1. La persona escribe su correo en la pantalla de acceso y toca "¿Olvidaste tu
 *    contraseña?". El servidor contesta **lo mismo** exista o no la cuenta: "si ese
 *    correo tiene cuenta, te mandamos un enlace". Cualquier diferencia convertiría la
 *    ruta en una forma de averiguar qué correos están registrados en el club.
 * 2. Si la cuenta existe y está activa, se genera un token de 32 bytes al azar, se
 *    guarda su SHA-256 (nunca el token) con 30 minutos de vida y se manda por correo el
 *    enlace `restablecer.html#token=...`. Va en el fragmento (`#`) para que el token no
 *    quede en los logs del servidor ni viaje en el `Referer`.
 * 3. Al abrir el enlace, la página pregunta si sigue vigente (`check`) y pide la
 *    contraseña nueva. `consume` la cambia, gasta el token, anula los demás de esa
 *    persona y **cierra todas sus sesiones**: si alguien más tenía la contraseña vieja,
 *    se queda afuera.
 *
 * Sirve para cualquier cuenta con correo —cliente, personal, gerente, administrador—
 * incluidas las que entraron con Facebook y nunca tuvieron contraseña: Facebook ya
 * verificó ese correo, así que ponerle una es darles una segunda puerta, no abrir una
 * ajena.
 *
 * ---------------------------------------------------------------------------
 * Frenos
 * ---------------------------------------------------------------------------
 *   * Un correo por cuenta por minuto. Pedir diez veces no manda diez correos: manda
 *     uno y los otros nueve se ignoran (con la misma respuesta).
 *   * Pedir uno nuevo anula los anteriores: solo sirve el último que llegó.
 *   * El freno por IP vive en la ruta (`express-rate-limit`), como en /auth/login.
 */
'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { pool } = require('../db/pool');
const { ApiError } = require('../middleware/errors');
const { revokeAllRefreshTokens } = require('../middleware/auth');
const mailer = require('./mailer');

const TOKEN_TTL_MINUTES = 30;
const RESEND_WAIT_SECONDS = 60;
const RESET_PAGE = 'restablecer.html';

const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

function newToken() {
  const token = crypto.randomBytes(32).toString('base64url');
  return { token, hash: hashToken(token) };
}

/** El enlace completo que va en el correo. */
function resetUrl(baseUrl, token) {
  return `${String(baseUrl || '').replace(/\/+$/, '')}/${RESET_PAGE}#token=${encodeURIComponent(token)}`;
}

/** `erick.lopez@gmail.com` → `e***z@gmail.com`. Para enseñarlo en la página sin regalar el correo. */
function maskEmail(email) {
  const s = String(email || '');
  const at = s.indexOf('@');
  if (at <= 0) return '***';
  const local = s.slice(0, at);
  const domain = s.slice(at);
  if (local.length <= 2) return `${local[0]}***${domain}`;
  return `${local[0]}***${local[local.length - 1]}${domain}`;
}

const isEnglish = (locale) => /^en/i.test(String(locale || ''));

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/**
 * El correo, en el idioma de la cuenta. Texto plano siempre (hay clientes que no
 * pintan HTML) y una versión HTML mínima con el botón.
 */
function buildEmail({ clubName, firstName, url, locale, minutes = TOKEN_TTL_MINUTES }) {
  const en = isEnglish(locale);
  const name = firstName ? ` ${firstName}` : '';
  const subject = en
    ? `Reset your ${clubName} password`
    : `Restablece tu contraseña de ${clubName}`;
  const lines = en ? [
    `Hi${name},`,
    '',
    `Someone (hopefully you) asked to reset the password for this email at ${clubName}.`,
    `Open this link to choose a new one. It works for ${minutes} minutes and only once:`,
    '',
    url,
    '',
    "If you didn't ask for this, ignore this email: your password hasn't changed.",
    '',
    `— ${clubName}`,
  ] : [
    `Hola${name},`,
    '',
    `Alguien (ojalá tú) pidió restablecer la contraseña de este correo en ${clubName}.`,
    `Abre este enlace para escoger una nueva. Sirve ${minutes} minutos y una sola vez:`,
    '',
    url,
    '',
    'Si tú no lo pediste, ignora este correo: tu contraseña no cambió.',
    '',
    `— ${clubName}`,
  ];
  const text = lines.join('\n');
  const button = en ? 'Choose a new password' : 'Escoger contraseña nueva';
  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#0b0b0f;color:#f5f5f7;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
<div style="max-width:480px;margin:0 auto;background:#15151c;border-radius:16px;padding:28px">
<h1 style="font-size:20px;margin:0 0 16px">${escapeHtml(clubName)}</h1>
<p style="margin:0 0 12px">${escapeHtml(lines[0])}</p>
<p style="margin:0 0 12px">${escapeHtml(lines[2])}</p>
<p style="margin:0 0 20px">${escapeHtml(lines[3])}</p>
<p style="margin:0 0 20px;text-align:center"><a href="${escapeHtml(url)}" style="display:inline-block;background:#e11d48;color:#fff;text-decoration:none;padding:14px 22px;border-radius:12px;font-weight:600">${button}</a></p>
<p style="margin:0 0 12px;font-size:13px;color:#a1a1aa">${en ? 'If the button does not work, copy this link:' : 'Si el botón no abre, copia este enlace:'}<br><a href="${escapeHtml(url)}" style="color:#fda4af;word-break:break-all">${escapeHtml(url)}</a></p>
<p style="margin:16px 0 0;font-size:13px;color:#a1a1aa">${escapeHtml(lines[7])}</p>
</div></body></html>`;
  return { subject, text, html };
}

/**
 * Pedir el enlace. Devuelve `{ sent, reason }` SOLO para la bitácora y las pruebas: la
 * ruta responde lo mismo en todos los casos.
 *
 * `reason`: 'sent' | 'no_user' | 'inactive' | 'throttled' | 'mail_failed'.
 */
async function request(db, {
  nightclubSlug, email, ip = null, userAgent = null, baseUrl, logger = console, mail = mailer,
}) {
  const { rows } = await db.query(
    `SELECT u.id, u.email, u.first_name, u.locale, u.status, n.name AS club_name
       FROM users u JOIN nightclubs n ON n.id = u.nightclub_id
      WHERE n.slug = $1 AND u.email = $2`,
    [nightclubSlug, email],
  );
  const user = rows[0];
  if (!user) return { sent: false, reason: 'no_user' };
  if (user.status !== 'active') return { sent: false, reason: 'inactive' };

  // Un correo por minuto por cuenta: el freno se mide con el último enlace vigente.
  const recent = await db.query(
    `SELECT 1 FROM password_resets
      WHERE user_id = $1 AND used_at IS NULL
        AND created_at > now() - make_interval(secs => $2)
      LIMIT 1`,
    [user.id, RESEND_WAIT_SECONDS],
  );
  if (recent.rowCount > 0) return { sent: false, reason: 'throttled' };

  const { token, hash } = newToken();
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    // Solo sirve el último enlace: los anteriores se anulan.
    await client.query(
      'UPDATE password_resets SET used_at = now() WHERE user_id = $1 AND used_at IS NULL',
      [user.id]);
    await client.query(
      `INSERT INTO password_resets (user_id, token_hash, expires_at, requested_ip, requested_ua)
       VALUES ($1, $2, now() + make_interval(mins => $3), $4, $5)`,
      [user.id, hash, TOKEN_TTL_MINUTES, ip, userAgent ? String(userAgent).slice(0, 300) : null]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  const message = buildEmail({
    clubName: user.club_name, firstName: user.first_name,
    url: resetUrl(baseUrl, token), locale: user.locale,
  });
  try {
    await mail.send({ to: user.email, ...message });
  } catch (err) {
    // No se le puede decir a quien pide (delataría que el correo existe), pero SÍ
    // queda en el log del servidor, que es donde el administrador lo va a buscar.
    logger.error?.(`Password reset mail failed for user ${user.id}: ${err.message}`);
    return { sent: false, reason: 'mail_failed' };
  }
  return { sent: true, reason: 'sent', userId: user.id };
}

/** El renglón vigente de un token, con lo que se necesita de la cuenta, o `null`. */
async function findValid(db, token) {
  if (!token) return null;
  const { rows } = await db.query(
    `SELECT r.id, r.user_id, r.expires_at, u.email, u.status, u.locale
       FROM password_resets r JOIN users u ON u.id = r.user_id
      WHERE r.token_hash = $1 AND r.used_at IS NULL AND r.expires_at > now()`,
    [hashToken(token)],
  );
  const row = rows[0];
  if (!row || row.status !== 'active') return null;
  return row;
}

/** Lo que la página necesita saber antes de enseñar el formulario. */
async function check(db, token) {
  const row = await findValid(db, token);
  if (!row) return { valid: false };
  return { valid: true, email_masked: maskEmail(row.email), expires_at: row.expires_at };
}

const INVALID_MESSAGE = 'Este enlace ya no sirve: caducó o ya se usó. Pide uno nuevo desde la pantalla de acceso.';

/**
 * Cambiar la contraseña con el token. Gasta el token, anula los demás de la persona y
 * cierra todas sus sesiones. Devuelve `{ userId }`.
 */
async function consume(db, { token, newPassword, ip = null }) {
  const row = await findValid(db, token);
  if (!row) throw ApiError.unauthorized(INVALID_MESSAGE);

  const passwordHash = await bcrypt.hash(newPassword, 10);
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    // Gastarlo con candado: dos envíos del mismo formulario no pueden cambiarla dos veces.
    const spent = await client.query(
      `UPDATE password_resets SET used_at = now()
        WHERE id = $1 AND used_at IS NULL AND expires_at > now()
        RETURNING id`,
      [row.id]);
    if (spent.rowCount === 0) {
      await client.query('ROLLBACK');
      throw ApiError.unauthorized(INVALID_MESSAGE);
    }
    await client.query(
      'UPDATE password_resets SET used_at = now() WHERE user_id = $1 AND used_at IS NULL',
      [row.user_id]);
    await client.query(
      `UPDATE users SET password_hash = $2, must_change_password = false, updated_at = now()
        WHERE id = $1`,
      [row.user_id, passwordHash]);
    await client.query(
      `INSERT INTO audit_log (nightclub_id, actor_id, action, entity, entity_id, after, ip)
       SELECT nightclub_id, id, 'password_reset_by_email', 'user', id,
              jsonb_build_object('via', 'email_link'), $2
         FROM users WHERE id = $1`,
      [row.user_id, ip]);
    await client.query('COMMIT');
  } catch (err) {
    if (!(err instanceof ApiError)) await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  await revokeAllRefreshTokens(row.user_id);
  return { userId: row.user_id };
}

module.exports = {
  TOKEN_TTL_MINUTES,
  RESEND_WAIT_SECONDS,
  RESET_PAGE,
  hashToken,
  newToken,
  resetUrl,
  maskEmail,
  buildEmail,
  request: (opts) => request(pool, opts),
  check: (token) => check(pool, token),
  consume: (opts) => consume(pool, opts),
  // Con base de datos explícita, para pruebas.
  _request: request,
  _check: check,
  _consume: consume,
};
