// Authentication routes: register, login, refresh, logout, me.
'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const { pool } = require('../db/pool');
const { ApiError, asyncHandler } = require('../middleware/errors');
const { validate, z, email, password, isoDate } = require('../middleware/validate');
const {
  signAccessToken, issueRefreshToken, consumeRefreshToken, revokeAllRefreshTokens,
  authenticate, ACCESS_TTL,
} = require('../middleware/auth');
const crypto = require('crypto');
const oauthConfig = require('../config/oauth');
const oauth = require('../services/oauth');

const router = express.Router();

const TERMS_VERSION = process.env.TERMS_VERSION || '1.0';
const MIN_AGE_YEARS = 18;

function yearsSince(dateString) {
  const birth = new Date(`${dateString}T00:00:00Z`);
  const now = new Date();
  let age = now.getUTCFullYear() - birth.getUTCFullYear();
  const monthDiff = now.getUTCMonth() - birth.getUTCMonth();
  if (monthDiff < 0 || (monthDiff === 0 && now.getUTCDate() < birth.getUTCDate())) age -= 1;
  return age;
}

function publicUser(u) {
  return {
    id: u.id,
    nightclub_id: u.nightclub_id,
    email: u.email,
    first_name: u.first_name,
    last_name: u.last_name,
    display_name: u.display_name,
    role: u.role,
    locale: u.locale,
    preferred_currency: u.preferred_currency,
    must_change_password: !!u.must_change_password,
  };
}

const registerSchema = z.object({
  nightclub_slug: z.string().trim().min(1).max(100),
  email,
  password,
  first_name: z.string().trim().min(1).max(100),
  last_name: z.string().trim().max(100).default(''),
  phone: z.string().trim().max(30).optional(),
  birth_date: isoDate,
  accept_terms: z.literal(true, { errorMap: () => ({ message: 'Terms must be accepted' }) }),
  accept_flirts: z.boolean().default(false),
});

router.post('/register', validate({ body: registerSchema }), asyncHandler(async (req, res) => {
  const body = req.body;

  if (yearsSince(body.birth_date) < MIN_AGE_YEARS) {
    throw ApiError.forbidden(`You must be at least ${MIN_AGE_YEARS} years old`);
  }

  const club = await pool.query('SELECT id FROM nightclubs WHERE slug = $1 AND active', [body.nightclub_slug]);
  if (club.rowCount === 0) throw ApiError.notFound('Nightclub not found');
  const nightclubId = club.rows[0].id;

  const passwordHash = await bcrypt.hash(body.password, 10);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let created;
    try {
      created = await client.query(
        `INSERT INTO users (nightclub_id, email, phone, password_hash, first_name, last_name, display_name,
                            role, birth_date, age_verified, terms_version, terms_accepted_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'guest',$8,false,$9,now())
         RETURNING *`,
        [nightclubId, body.email, body.phone || null, passwordHash, body.first_name, body.last_name,
          `${body.first_name} ${body.last_name}`.trim(), body.birth_date, TERMS_VERSION],
      );
    } catch (err) {
      if (err.code === '23505') throw ApiError.conflict('An account with that email already exists');
      throw err;
    }
    const user = created.rows[0];
    await client.query(
      `INSERT INTO user_preferences (user_id, accept_flirts) VALUES ($1,$2) ON CONFLICT (user_id) DO NOTHING`,
      [user.id, body.accept_flirts],
    );
    await client.query('COMMIT');

    const refresh = await issueRefreshToken(user.id, req.headers['user-agent']);
    res.status(201).json({
      user: publicUser(user),
      access_token: signAccessToken(user),
      token_type: 'Bearer',
      expires_in: ACCESS_TTL,
      refresh_token: refresh.token,
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}));

const loginSchema = z.object({
  nightclub_slug: z.string().trim().min(1).max(100),
  email,
  password: z.string().min(1).max(200),
});

router.post('/login', validate({ body: loginSchema }), asyncHandler(async (req, res) => {
  const { nightclub_slug: slug, email: mail, password: pass } = req.body;

  const { rows } = await pool.query(
    `SELECT u.* FROM users u JOIN nightclubs n ON n.id = u.nightclub_id
      WHERE n.slug = $1 AND u.email = $2`,
    [slug, mail],
  );
  const user = rows[0];
  // Same message and similar timing whether the user exists or not.
  //
  // Desde la migración 021 `password_hash` puede ser NULL: es una cuenta que solo
  // entra con Facebook. Cae al hash falso, así que `bcrypt.compare` no revienta y
  // el intento tarda lo mismo. El mensaje sigue siendo el genérico **a
  // propósito**: decir "esa cuenta entra con Facebook" confirmaría que el correo
  // existe, y eso es justo lo que las dos líneas de arriba evitan. La pantalla de
  // acceso enseña el botón de Facebook al lado, que es donde esa persona lo va a
  // encontrar sin que el servidor delate a nadie.
  const hash = (user && user.password_hash)
    || '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinva';
  const ok = await bcrypt.compare(pass, hash);
  if (!user || !ok) throw ApiError.unauthorized('Invalid credentials');
  if (user.status !== 'active') throw ApiError.forbidden('Account is not active');

  await pool.query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);
  const refresh = await issueRefreshToken(user.id, req.headers['user-agent']);

  res.json({
    user: publicUser(user),
    access_token: signAccessToken(user),
    token_type: 'Bearer',
    expires_in: ACCESS_TTL,
    refresh_token: refresh.token,
  });
}));

router.post('/refresh', validate({ body: z.object({ refresh_token: z.string().min(20) }) }),
  asyncHandler(async (req, res) => {
    const userId = await consumeRefreshToken(req.body.refresh_token);
    const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
    const user = rows[0];
    if (!user || user.status !== 'active') throw ApiError.unauthorized('Account is not active');

    const refresh = await issueRefreshToken(user.id, req.headers['user-agent']);
    res.json({
      access_token: signAccessToken(user),
      token_type: 'Bearer',
      expires_in: ACCESS_TTL,
      refresh_token: refresh.token,
    });
  }));

router.post('/logout', authenticate, asyncHandler(async (req, res) => {
  await revokeAllRefreshTokens(req.user.id);
  res.status(204).end();
}));

// Change password. Required after a manager-issued temporary password; the current
// password is always checked, and every other session is closed.
router.post('/password', authenticate,
  validate({ body: z.object({ current_password: z.string().min(1).max(200), new_password: password }) }),
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
    const ok = await bcrypt.compare(req.body.current_password, rows[0].password_hash);
    if (!ok) throw ApiError.unauthorized('La contraseña actual no es correcta');
    if (req.body.current_password === req.body.new_password) {
      throw ApiError.unprocessable('La contraseña nueva debe ser distinta de la actual');
    }
    await pool.query(
      'UPDATE users SET password_hash = $2, must_change_password = false, updated_at = now() WHERE id = $1',
      [req.user.id, await bcrypt.hash(req.body.new_password, 10)]);
    await revokeAllRefreshTokens(req.user.id);
    const refresh = await issueRefreshToken(req.user.id, req.headers['user-agent']);
    res.json({
      changed: true,
      access_token: signAccessToken({ ...req.user, must_change_password: false }),
      token_type: 'Bearer',
      expires_in: ACCESS_TTL,
      refresh_token: refresh.token,
    });
  }));

router.get('/me', authenticate, asyncHandler(async (req, res) => {
  const prefs = await pool.query('SELECT accept_flirts, show_on_map FROM user_preferences WHERE user_id = $1',
    [req.user.id]);
  res.json({ user: publicUser(req.user), preferences: prefs.rows[0] || null });
}));

// ==========================================================================
// Entrar con una cuenta de otro (Facebook, y lo que venga)
// ==========================================================================

/**
 * Qué botones puede pintar la pantalla de acceso.
 *
 * Pública y sin secretos: la pide un navegador sin sesión. Solo dice qué
 * proveedor está encendido, y de los apagados, por qué — para que la pantalla
 * pueda explicarlo en vez de enseñar un botón que no va a funcionar.
 */
router.get('/oauth/providers', asyncHandler(async (req, res) => {
  res.json(oauthConfig.publicStatus());
}));

/** Los proveedores que esta persona ya tiene ligados. */
router.get('/oauth/linked', authenticate, asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT provider, email, display_name, linked_at, last_login_at
       FROM user_identities WHERE user_id = $1 ORDER BY linked_at`,
    [req.user.id]);
  const conPassword = await pool.query(
    'SELECT password_hash IS NOT NULL AS tiene FROM users WHERE id = $1', [req.user.id]);
  res.json({
    identities: rows,
    has_password: conPassword.rows[0].tiene,
    // Lo que la pantalla necesita para no ofrecer un botón que va a fallar: con
    // una sola manera de entrar, desvincular dejaría a la persona fuera.
    can_unlink: rows.length > (conPassword.rows[0].tiene ? 0 : 1),
  });
}));

/** El proveedor de la ruta, comprobando que exista, esté disponible y configurado. */
function requireProvider(name) {
  const config = oauthConfig.providerConfig(name);
  if (!config) throw ApiError.notFound('Ese proveedor no existe');
  if (!config.available) {
    // 501 y no 404: el proveedor existe, simplemente no se puede usar. Y el
    // motivo viaja, porque "Instagram no sirve" sin explicación se convierte en
    // la misma pregunta cada mes.
    throw new ApiError(501, 'provider_unavailable', config.unavailable_note,
      { provider: config.provider, reason: config.unavailable_reason });
  }
  if (!config.configured) {
    throw new ApiError(501, 'provider_not_configured',
      `Falta configurar ${config.label}: ${config.missing.join(', ')} en el .env del servidor`,
      { provider: config.provider, missing: config.missing });
  }
  return config;
}

/**
 * Guarda el `state` del viaje y barre los vencidos.
 *
 * El barrido va aquí, al emitir, en vez de en una tarea programada: es una línea,
 * corre justo cuando la tabla crece, y no hay nada que se pueda quedar apagado
 * sin que nadie lo note.
 */
async function nuevoState({ nightclubId, provider, redirectTo, linkUserId = null }) {
  const state = oauth.newState();
  await pool.query(
    `DELETE FROM oauth_states
      WHERE created_at < now() - make_interval(mins => $1)`,
    [oauth.STATE_TTL_MINUTES]);
  await pool.query(
    `INSERT INTO oauth_states (state, nightclub_id, provider, redirect_to, link_user_id)
     VALUES ($1,$2,$3,$4,$5)`,
    [state, nightclubId, provider, oauth.safeRedirect(redirectTo), linkUserId]);
  return state;
}

/**
 * Empezar el viaje: se manda a la persona a la pantalla de permisos del proveedor.
 *
 * Es un 302 y no un JSON con la dirección porque así se puede poner en un
 * `<a href>` sin JavaScript: la pantalla de acceso funciona igual si el
 * navegador del cliente bloqueó los scripts.
 */
router.get('/oauth/:provider/start',
  validate({
    params: z.object({ provider: z.string().trim().max(20) }),
    query: z.object({
      nightclub_slug: z.string().trim().min(1).max(100),
      redirect_to: z.string().trim().max(200).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const config = requireProvider(req.params.provider);
    const club = await pool.query('SELECT id FROM nightclubs WHERE slug = $1',
      [req.query.nightclub_slug]);
    if (club.rowCount === 0) throw ApiError.notFound('Club no encontrado');

    const state = await nuevoState({
      nightclubId: club.rows[0].id,
      provider: config.provider,
      redirectTo: req.query.redirect_to,
    });
    res.redirect(302, oauth.authorizeUrl(config, state));
  }));

/** Ligar una cuenta social a la sesión que YA existe. Devuelve a dónde ir. */
router.post('/oauth/:provider/link', authenticate,
  validate({
    params: z.object({ provider: z.string().trim().max(20) }),
    body: z.object({ redirect_to: z.string().trim().max(200).optional() }).default({}),
  }),
  asyncHandler(async (req, res) => {
    const config = requireProvider(req.params.provider);
    const state = await nuevoState({
      nightclubId: req.user.nightclub_id,
      provider: config.provider,
      redirectTo: req.body.redirect_to,
      linkUserId: req.user.id,
    });
    // Aquí sí un JSON: esto lo llama la app con su sesión puesta, y necesita
    // abrir la dirección ella misma.
    res.json({ authorize_url: oauth.authorizeUrl(config, state) });
  }));

/**
 * La vuelta del proveedor.
 *
 * Siempre termina en un 302 a una página, nunca en un JSON: la persona viene
 * rebotada de Facebook en su navegador, y un JSON en pantalla es un callejón.
 * Lo que va en la dirección es un **pase de un solo uso** (`#h=`), no la sesión:
 * el fragmento se queda en el historial, y en un teléfono prestado eso sería la
 * cuenta del cliente al alcance del siguiente.
 */
router.get('/oauth/:provider/callback',
  validate({
    params: z.object({ provider: z.string().trim().max(20) }),
    query: z.object({
      code: z.string().trim().min(1).max(2000).optional(),
      state: z.string().trim().min(10).max(64).optional(),
      error: z.string().trim().max(200).optional(),
      error_description: z.string().trim().max(500).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const base = oauthConfig.publicBaseUrl();
    const alError = (motivo) => res.redirect(302,
      `${base}/index.html#oauth_error=${encodeURIComponent(motivo)}`);

    // El cliente tocó "cancelar" en la pantalla de permisos. No es un fallo: se
    // le regresa a la pantalla de acceso sin ruido.
    if (req.query.error) return alError(req.query.error === 'access_denied' ? 'cancelled' : 'provider');
    if (!req.query.code || !req.query.state) return alError('missing_code');

    const config = oauthConfig.providerConfig(req.params.provider);
    if (!config || !config.available || !config.configured) return alError('provider_unavailable');

    // El `state` se CONSUME: el DELETE ... RETURNING lo borra y lo devuelve en la
    // misma operación, así que dos vueltas con el mismo state solo encuentran una.
    const { rows: estados } = await pool.query(
      `DELETE FROM oauth_states
        WHERE state = $1 AND provider = $2
          AND created_at > now() - make_interval(mins => $3)
        RETURNING nightclub_id, redirect_to, link_user_id`,
      [req.query.state, config.provider, oauth.STATE_TTL_MINUTES]);
    if (estados.length === 0) return alError('expired_state');
    const viaje = estados[0];

    let perfil;
    try {
      const token = await oauth.exchangeCode(config, req.query.code);
      perfil = await oauth.fetchProfile(config, token);
    } catch (err) {
      req.log?.warn({ err, provider: config.provider }, 'oauth exchange failed');
      return alError('provider');
    }

    const destino = `${base}/${oauth.safeRedirect(viaje.redirect_to)}`;

    // ---------------------------------------------------------------- ligar
    if (viaje.link_user_id) {
      try {
        await pool.query(
          `INSERT INTO user_identities (user_id, provider, provider_user_id, email, display_name)
           VALUES ($1,$2,$3,$4,$5)`,
          [viaje.link_user_id, config.provider, perfil.provider_user_id,
            perfil.email, perfil.display_name]);
      } catch (err) {
        // 23505: o esa cuenta social ya está ligada a alguien, o esta persona ya
        // tenía una de este proveedor. Las dos se explican igual.
        if (err.code !== '23505') throw err;
        return res.redirect(302, `${destino}#oauth_error=already_linked`);
      }
      return res.redirect(302, `${destino}#oauth_linked=${config.provider}`);
    }

    // ---------------------------------------------------------------- entrar
    const { rows: ligadas } = await pool.query(
      `SELECT i.user_id, u.status
         FROM user_identities i JOIN users u ON u.id = i.user_id
        WHERE i.provider = $1 AND i.provider_user_id = $2 AND u.nightclub_id = $3`,
      [config.provider, perfil.provider_user_id, viaje.nightclub_id]);

    if (ligadas.length > 0) {
      if (ligadas[0].status !== 'active') return alError('account_inactive');
      await pool.query(
        `UPDATE user_identities SET last_login_at = now(), email = COALESCE($3, email)
          WHERE provider = $1 AND provider_user_id = $2`,
        [config.provider, perfil.provider_user_id, perfil.email]);
      await pool.query('UPDATE users SET last_login_at = now() WHERE id = $1', [ligadas[0].user_id]);
      const pase = await nuevoPaseDeMano(ligadas[0].user_id);
      return res.redirect(302, `${destino}#h=${pase}`);
    }

    // Esa cuenta social no está ligada a nadie. Si el correo ya existe en el
    // club, **no** se liga sola: se le pide entrar con su contraseña y ligarla
    // desde su perfil. Un paso de más frente a un robo de cuenta -- quien
    // consiga que un proveedor le acepte un correo ajeno se quedaría con la
    // cuenta del cliente, sus reservaciones y su historial.
    if (perfil.email) {
      const existe = await pool.query(
        'SELECT 1 FROM users WHERE nightclub_id = $1 AND email = $2',
        [viaje.nightclub_id, perfil.email]);
      if (existe.rowCount > 0) {
        return res.redirect(302, `${destino}#oauth_error=email_taken`);
      }
    }

    // Cuenta nueva. NO se crea aquí: el club es 18+ y la fecha de nacimiento es
    // obligatoria; Facebook no la entrega de forma fiable e inventarla sería
    // inventar la edad de un cliente en un negocio de alcohol. Se manda un token
    // de completar y la app pide fecha y términos, como en el registro normal.
    const completar = oauth.signCompletionToken({ ...perfil, nightclub_id: viaje.nightclub_id });
    return res.redirect(302, `${destino}#oauth_signup=${encodeURIComponent(completar)}`);
  }));

/** Un pase de mano nuevo, y barrido de los vencidos en la misma pasada. */
async function nuevoPaseDeMano(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  await pool.query(`DELETE FROM oauth_handoffs WHERE created_at < now() - interval '2 minutes'`);
  await pool.query('INSERT INTO oauth_handoffs (token, user_id) VALUES ($1,$2)', [token, userId]);
  return token;
}

/**
 * Canjear el pase de mano por la sesión.
 *
 * De un solo uso: el DELETE ... RETURNING lo gasta. Lo que quede en el historial
 * del navegador es un pase muerto.
 */
router.post('/oauth/handoff',
  validate({ body: z.object({ handoff: z.string().trim().min(20).max(64) }) }),
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(
      `DELETE FROM oauth_handoffs
        WHERE token = $1 AND created_at > now() - interval '2 minutes'
        RETURNING user_id`,
      [req.body.handoff]);
    if (rows.length === 0) throw ApiError.unauthorized('Ese acceso ya venció, vuelve a entrar');

    const u = await pool.query('SELECT * FROM users WHERE id = $1', [rows[0].user_id]);
    const user = u.rows[0];
    if (!user || user.status !== 'active') throw ApiError.forbidden('Account is not active');

    const refresh = await issueRefreshToken(user.id, req.headers['user-agent']);
    res.json({
      user: publicUser(user),
      access_token: signAccessToken(user),
      token_type: 'Bearer',
      expires_in: ACCESS_TTL,
      refresh_token: refresh.token,
    });
  }));

/**
 * Completar el registro que empezó con una cuenta social.
 *
 * Pide lo que el proveedor no puede dar y el club sí necesita: la fecha de
 * nacimiento —de la que depende dejar entrar a alguien— y la aceptación de
 * términos. Misma comprobación de edad que el registro normal, en el mismo
 * lugar, para que no puedan separarse.
 */
router.post('/oauth/complete',
  validate({
    body: z.object({
      completion_token: z.string().trim().min(20).max(2000),
      birth_date: isoDate,
      accept_terms: z.literal(true, { errorMap: () => ({ message: 'Terms must be accepted' }) }),
      // Instagram nunca da correo y en Facebook el cliente puede negarlo, así que
      // se le pide aquí. Si el proveedor sí lo dio, la app lo trae ya escrito.
      email: email.optional(),
      phone: z.string().trim().max(30).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const perfil = oauth.verifyCompletionToken(req.body.completion_token);
    if (yearsSince(req.body.birth_date) < MIN_AGE_YEARS) {
      throw ApiError.unprocessable(`Tienes que tener ${MIN_AGE_YEARS} años o más`);
    }

    const correo = req.body.email || perfil.email;
    if (!correo) {
      throw ApiError.badRequest('Necesitamos tu correo para crear la cuenta', [
        { field: 'body.email', message: 'Required' },
      ]);
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const nombre = perfil.first_name || 'Invitado';
      const apellido = perfil.last_name || '';
      let user;
      try {
        const creado = await client.query(
          `INSERT INTO users (nightclub_id, email, phone, password_hash, first_name, last_name,
                              display_name, role, birth_date, age_verified, terms_version,
                              terms_accepted_at)
           VALUES ($1,$2,$3,NULL,$4,$5,$6,'guest',$7,false,$8,now())
           RETURNING *`,
          [perfil.nightclub_id, correo, req.body.phone || null, nombre, apellido,
            perfil.display_name || `${nombre} ${apellido}`.trim(), req.body.birth_date,
            TERMS_VERSION]);
        user = creado.rows[0];
      } catch (err) {
        if (err.code === '23505') throw ApiError.conflict('Ese correo ya tiene cuenta en este club');
        throw err;
      }

      try {
        await client.query(
          `INSERT INTO user_identities (user_id, provider, provider_user_id, email,
                                        display_name, last_login_at)
           VALUES ($1,$2,$3,$4,$5,now())`,
          [user.id, perfil.provider, perfil.provider_user_id, perfil.email,
            perfil.display_name]);
      } catch (err) {
        // Completar dos veces con el mismo token choca aquí, y es lo que hace que
        // el token no necesite ser de un solo uso.
        if (err.code === '23505') throw ApiError.conflict('Esa cuenta ya está registrada');
        throw err;
      }

      await client.query(
        `INSERT INTO user_preferences (user_id, accept_flirts) VALUES ($1,false)
         ON CONFLICT DO NOTHING`, [user.id]);
      await client.query('COMMIT');

      const refresh = await issueRefreshToken(user.id, req.headers['user-agent']);
      return res.status(201).json({
        user: publicUser(user),
        access_token: signAccessToken(user),
        token_type: 'Bearer',
        expires_in: ACCESS_TTL,
        refresh_token: refresh.token,
      });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }));

/**
 * Quitar una cuenta social.
 *
 * Se niega si es la única manera de entrar: dejar a alguien sin contraseña y sin
 * cuenta ligada es dejarlo fuera de su propia cuenta, con sus reservaciones
 * adentro, y la única salida sería que el gerente le reinicie la contraseña a
 * mano en la base.
 */
router.delete('/oauth/:provider', authenticate,
  validate({ params: z.object({ provider: z.string().trim().max(20) }) }),
  asyncHandler(async (req, res) => {
    const provider = String(req.params.provider).toLowerCase();
    const { rows } = await pool.query(
      `SELECT (SELECT password_hash IS NOT NULL FROM users WHERE id = $1) AS tiene_password,
              (SELECT count(*)::int FROM user_identities WHERE user_id = $1) AS cuantas`,
      [req.user.id]);
    const puede = oauth.canUnlink({
      hasPassword: rows[0].tiene_password, identityCount: rows[0].cuantas,
    });
    if (!puede.ok) {
      throw ApiError.conflict(
        'Es tu única forma de entrar: ponle una contraseña a tu cuenta antes de quitarla',
        { reason: puede.reason });
    }

    const borrada = await pool.query(
      'DELETE FROM user_identities WHERE user_id = $1 AND provider = $2 RETURNING provider',
      [req.user.id, provider]);
    if (borrada.rowCount === 0) throw ApiError.notFound('No tienes esa cuenta ligada');
    res.status(204).end();
  }));

module.exports = router;
