// Authentication: short-lived access JWT + revocable refresh tokens stored hashed.
'use strict';

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { pool } = require('../db/pool');
const { ApiError } = require('./errors');

const ACCESS_TTL = process.env.JWT_ACCESS_TTL || '15m';
const REFRESH_TTL_DAYS = Number(process.env.JWT_REFRESH_TTL_DAYS || 30);

function jwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 16) {
    throw new Error('JWT_SECRET is missing or too short (min 16 characters)');
  }
  return secret;
}

function signAccessToken(user) {
  return jwt.sign(
    { sub: user.id, role: user.role, nc: user.nightclub_id },
    jwtSecret(),
    { expiresIn: ACCESS_TTL, issuer: 'ev2' },
  );
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

async function issueRefreshToken(userId, deviceInfo) {
  const token = crypto.randomBytes(48).toString('base64url');
  const expiresAt = new Date(Date.now() + REFRESH_TTL_DAYS * 86_400_000);
  await pool.query(
    `INSERT INTO refresh_tokens (user_id, token_hash, device_info, expires_at) VALUES ($1,$2,$3,$4)`,
    [userId, hashToken(token), deviceInfo || null, expiresAt],
  );
  return { token, expiresAt };
}

async function consumeRefreshToken(token) {
  // Single use: the row is revoked and a new one issued (rotation).
  const { rows } = await pool.query(
    `UPDATE refresh_tokens SET revoked_at = now()
      WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()
      RETURNING user_id`,
    [hashToken(token)],
  );
  if (rows.length === 0) throw ApiError.unauthorized('Invalid or expired refresh token');
  return rows[0].user_id;
}

async function revokeAllRefreshTokens(userId) {
  await pool.query(
    `UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId],
  );
}

// Verifies the access token and loads the current user (so a blocked user loses access
// immediately instead of when the token expires).
async function authenticate(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) throw ApiError.unauthorized('Missing Bearer token');

    let payload;
    try {
      payload = jwt.verify(token, jwtSecret(), { issuer: 'ev2' });
    } catch (err) {
      throw ApiError.unauthorized(err.name === 'TokenExpiredError' ? 'Token expired' : 'Invalid token');
    }

    const { rows } = await pool.query(
      `SELECT id, nightclub_id, email, first_name, last_name, display_name, role, status,
              locale, preferred_currency
         FROM users WHERE id = $1`,
      [payload.sub],
    );
    const user = rows[0];
    if (!user) throw ApiError.unauthorized('User no longer exists');
    if (user.status !== 'active') throw ApiError.forbidden('Account is not active');

    req.user = user;
    return next();
  } catch (err) {
    return next(err);
  }
}

function requireRole(...roles) {
  const allowed = new Set(roles);
  return (req, res, next) => {
    if (!req.user) return next(ApiError.unauthorized());
    if (req.user.role === 'admin' || allowed.has(req.user.role)) return next();
    return next(ApiError.forbidden(`Requires role: ${roles.join(', ')}`));
  };
}

// Rejects access to another club's data.
function sameNightclub(paramName = 'nightclubId') {
  return (req, res, next) => {
    if (!req.user) return next(ApiError.unauthorized());
    if (req.params[paramName] !== req.user.nightclub_id) {
      return next(ApiError.forbidden('Resource belongs to another nightclub'));
    }
    return next();
  };
}

module.exports = {
  signAccessToken, issueRefreshToken, consumeRefreshToken, revokeAllRefreshTokens,
  authenticate, requireRole, sameNightclub, ACCESS_TTL,
};
