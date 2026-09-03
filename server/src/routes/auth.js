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
  const hash = user ? user.password_hash : '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinva';
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

router.get('/me', authenticate, asyncHandler(async (req, res) => {
  const prefs = await pool.query('SELECT accept_flirts, show_on_map FROM user_preferences WHERE user_id = $1',
    [req.user.id]);
  res.json({ user: publicUser(req.user), preferences: prefs.rows[0] || null });
}));

module.exports = router;
