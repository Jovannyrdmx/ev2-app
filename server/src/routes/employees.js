// Employees: accounts created by the manager, profile, encrypted bank accounts,
// earnings and withdrawals (docs/DECISIONES.md D19).
//
//   * only the manager creates employees; they get a temporary password shown once and
//     must change it on first sign-in;
//   * bank accounts are validated (CLABE check digit, ABA checksum), encrypted with
//     pgcrypto and only ever shown as ****1234 — not even the manager sees the number;
//   * the manager verifies an account before it can receive a withdrawal;
//   * every employee sees only their own data; anyone else's answers 404.
'use strict';

const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const { pool } = require('../db/pool');
const { ApiError, asyncHandler } = require('../middleware/errors');
const { validate, z, uuid, email, currency, pagination } = require('../middleware/validate');
const { authenticate, requireRole, sameNightclub } = require('../middleware/auth');
const banking = require('../services/banking');

const router = express.Router({ mergeParams: true });

const EMPLOYEE_ROLES = ['waiter', 'bartender', 'dancer', 'dj', 'light_tech', 'valet', 'hostess'];

const EMPLOYEE_SELECT = `
  SELECT u.id, u.email, u.phone, u.first_name, u.last_name, u.display_name, u.role, u.status,
         u.preferred_currency, u.must_change_password, u.last_login_at, u.created_at,
         p.employee_code, p.country, p.stage_name, p.avatar_url, p.hire_date, p.active,
         p.preferred_payout_currency, p.deactivated_at,
         (s.id IS NOT NULL) AS on_shift
    FROM users u
    JOIN employee_profiles p ON p.user_id = u.id
    LEFT JOIN staff_shifts s ON s.user_id = u.id AND s.ended_at IS NULL`;

/** 12 characters, unambiguous alphabet, shown to the manager once. */
function temporaryPassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(12);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

function isEmployee(user) {
  return EMPLOYEE_ROLES.includes(user.role);
}

// ---------------------------------------------------------------- manager: employees

router.use('/nightclubs/:nightclubId', authenticate, sameNightclub());

router.get('/nightclubs/:nightclubId/employees',
  requireRole('manager'),
  validate({
    params: z.object({ nightclubId: uuid }),
    query: pagination.extend({
      role: z.enum(EMPLOYEE_ROLES).optional(),
      include_inactive: z.coerce.boolean().default(false),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(
      `${EMPLOYEE_SELECT}
        WHERE u.nightclub_id = $1
          AND ($2::text IS NULL OR u.role = $2)
          AND ($3::boolean OR p.active)
        ORDER BY p.active DESC, u.role, COALESCE(p.stage_name, u.display_name)
        LIMIT $4 OFFSET $5`,
      [req.params.nightclubId, req.query.role || null, req.query.include_inactive,
        req.query.limit, req.query.offset]);
    res.json({ employees: rows });
  }));

const employeeCreate = z.object({
  email,
  first_name: z.string().trim().min(1).max(100),
  last_name: z.string().trim().min(1).max(100),
  role: z.enum(EMPLOYEE_ROLES),
  country: z.enum(['MX', 'US']).default('MX'),
  birth_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  phone: z.string().trim().max(30).optional(),
  stage_name: z.string().trim().max(80).optional(),
  employee_code: z.string().trim().max(30).optional(),
  hire_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  preferred_currency: currency.optional(),
});

router.post('/nightclubs/:nightclubId/employees',
  requireRole('manager'),
  validate({ params: z.object({ nightclubId: uuid }), body: employeeCreate }),
  asyncHandler(async (req, res) => {
    const { nightclubId } = req.params;
    const b = req.body;
    const temp = temporaryPassword();
    const hash = await bcrypt.hash(temp, 10);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      let user;
      try {
        const created = await client.query(
          `INSERT INTO users (nightclub_id, email, phone, password_hash, first_name, last_name, display_name,
                              role, birth_date, age_verified, preferred_currency, must_change_password,
                              created_by, terms_version, terms_accepted_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,true,$10,true,$11,NULL,NULL)
           RETURNING id`,
          [nightclubId, b.email, b.phone || null, hash, b.first_name, b.last_name,
            b.stage_name || `${b.first_name} ${b.last_name}`.trim(), b.role, b.birth_date,
            b.preferred_currency || (b.country === 'US' ? 'USD' : 'MXN'), req.user.id]);
        user = created.rows[0];
      } catch (err) {
        if (err.code === '23505') throw ApiError.conflict('Ya existe una cuenta con ese correo');
        throw err;
      }
      await client.query(
        `INSERT INTO employee_profiles (user_id, employee_code, country, stage_name, hire_date, phone,
                                        preferred_payout_currency)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [user.id, b.employee_code || null, b.country, b.stage_name || null,
          b.hire_date || null, b.phone || null, b.country === 'US' ? 'USD' : 'MXN']);
      await client.query('INSERT INTO user_preferences (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [user.id]);
      await client.query('COMMIT');

      const full = await pool.query(`${EMPLOYEE_SELECT} WHERE u.id = $1`, [user.id]);
      // The temporary password travels exactly once, here. It is never stored in clear.
      res.status(201).json({ employee: full.rows[0], temporary_password: temp });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }));

router.get('/nightclubs/:nightclubId/employees/:userId',
  requireRole('manager'),
  validate({ params: z.object({ nightclubId: uuid, userId: uuid }) }),
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(`${EMPLOYEE_SELECT} WHERE u.id = $1 AND u.nightclub_id = $2`,
      [req.params.userId, req.params.nightclubId]);
    if (rows.length === 0) throw ApiError.notFound('Employee not found');
    res.json({ employee: rows[0] });
  }));

const employeePatch = z.object({
  role: z.enum(EMPLOYEE_ROLES).optional(),
  stage_name: z.string().trim().max(80).nullable().optional(),
  employee_code: z.string().trim().max(30).nullable().optional(),
  hire_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  phone: z.string().trim().max(30).nullable().optional(),
  active: z.boolean().optional(),
  reset_password: z.boolean().optional(),
}).refine((b) => Object.keys(b).length > 0, { message: 'No fields to update' });

router.patch('/nightclubs/:nightclubId/employees/:userId',
  requireRole('manager'),
  validate({ params: z.object({ nightclubId: uuid, userId: uuid }), body: employeePatch }),
  asyncHandler(async (req, res) => {
    const { nightclubId, userId } = req.params;
    const b = req.body;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const cur = await client.query(
        `SELECT u.id, u.role, p.active FROM users u JOIN employee_profiles p ON p.user_id = u.id
          WHERE u.id = $1 AND u.nightclub_id = $2 FOR UPDATE OF u`,
        [userId, nightclubId]);
      if (cur.rowCount === 0) throw ApiError.notFound('Employee not found');

      if (b.role) await client.query('UPDATE users SET role = $2, updated_at = now() WHERE id = $1', [userId, b.role]);
      if (b.phone !== undefined) await client.query('UPDATE users SET phone = $2 WHERE id = $1', [userId, b.phone]);

      const fields = ['stage_name', 'employee_code', 'hire_date', 'phone'].filter((k) => b[k] !== undefined);
      if (fields.length) {
        const sets = fields.map((k, i) => `${k} = $${i + 2}`).join(', ');
        await client.query(`UPDATE employee_profiles SET ${sets}, updated_at = now() WHERE user_id = $1`,
          [userId, ...fields.map((k) => b[k])]);
      }
      if (b.stage_name) {
        await client.query('UPDATE users SET display_name = $2 WHERE id = $1', [userId, b.stage_name]);
      }

      let temporaryPasswordOut = null;
      if (b.reset_password) {
        temporaryPasswordOut = temporaryPassword();
        await client.query(
          'UPDATE users SET password_hash = $2, must_change_password = true, updated_at = now() WHERE id = $1',
          [userId, await bcrypt.hash(temporaryPasswordOut, 10)]);
        await client.query('DELETE FROM refresh_tokens WHERE user_id = $1', [userId]);
      }

      // Deactivating keeps history and any unpaid balance; the person just cannot sign in.
      if (b.active === false) {
        await client.query(
          `UPDATE employee_profiles SET active = false, deactivated_at = now(), updated_at = now() WHERE user_id = $1`,
          [userId]);
        await client.query(`UPDATE users SET status = 'blocked', updated_at = now() WHERE id = $1`, [userId]);
        await client.query('DELETE FROM refresh_tokens WHERE user_id = $1', [userId]);
        await client.query('UPDATE staff_shifts SET ended_at = now() WHERE user_id = $1 AND ended_at IS NULL', [userId]);
      } else if (b.active === true) {
        await client.query(
          `UPDATE employee_profiles SET active = true, deactivated_at = NULL, updated_at = now() WHERE user_id = $1`,
          [userId]);
        await client.query(`UPDATE users SET status = 'active', updated_at = now() WHERE id = $1`, [userId]);
      }
      await client.query('COMMIT');

      const full = await pool.query(`${EMPLOYEE_SELECT} WHERE u.id = $1`, [userId]);
      const out = { employee: full.rows[0] };
      if (temporaryPasswordOut) out.temporary_password = temporaryPasswordOut;
      res.json(out);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }));

// ---------------------------------------------------------------- employee: me

function requireEmployee(req, res, next) {
  if (!req.user || !isEmployee(req.user)) return next(ApiError.forbidden('Solo para empleados'));
  return next();
}

router.get('/employees/me', authenticate, requireEmployee, asyncHandler(async (req, res) => {
  const { rows } = await pool.query(`${EMPLOYEE_SELECT} WHERE u.id = $1`, [req.user.id]);
  if (rows.length === 0) throw ApiError.notFound('Employee profile not found');
  res.json({ employee: rows[0] });
}));

router.put('/employees/me', authenticate, requireEmployee,
  validate({
    body: z.object({
      stage_name: z.string().trim().max(80).nullable().optional(),
      avatar_url: z.string().url().max(500).nullable().optional(),
      phone: z.string().trim().max(30).nullable().optional(),
      preferred_currency: currency.optional(),
      preferred_payout_currency: currency.optional(),
    }).refine((b) => Object.keys(b).length > 0, { message: 'No fields to update' }),
  }),
  asyncHandler(async (req, res) => {
    const b = req.body;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const profileFields = ['stage_name', 'avatar_url', 'phone', 'preferred_payout_currency']
        .filter((k) => b[k] !== undefined);
      if (profileFields.length) {
        const sets = profileFields.map((k, i) => `${k} = $${i + 2}`).join(', ');
        await client.query(`UPDATE employee_profiles SET ${sets}, updated_at = now() WHERE user_id = $1`,
          [req.user.id, ...profileFields.map((k) => b[k])]);
      }
      if (b.preferred_currency) {
        await client.query('UPDATE users SET preferred_currency = $2 WHERE id = $1', [req.user.id, b.preferred_currency]);
      }
      if (b.stage_name) {
        await client.query('UPDATE users SET display_name = $2 WHERE id = $1', [req.user.id, b.stage_name]);
      }
      if (b.phone !== undefined) {
        await client.query('UPDATE users SET phone = $2 WHERE id = $1', [req.user.id, b.phone]);
      }
      await client.query('COMMIT');
      const { rows } = await pool.query(`${EMPLOYEE_SELECT} WHERE u.id = $1`, [req.user.id]);
      res.json({ employee: rows[0] });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }));

// ---------------------------------------------------------------- bank accounts

const ACCOUNT_COLUMNS = `id, user_id, country, type, bank_name, holder_name, account_last4, routing_last4,
                         is_default, verified_at, verified_by, created_at`;

router.get('/employees/me/bank-accounts', authenticate, requireEmployee, asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT ${ACCOUNT_COLUMNS} FROM employee_bank_accounts
      WHERE user_id = $1 AND active ORDER BY is_default DESC, created_at`,
    [req.user.id]);
  res.json({ bank_accounts: rows.map(banking.maskAccount) });
}));

const accountCreate = z.object({
  type: z.enum(['clabe', 'us_checking', 'us_savings']),
  bank_name: z.string().trim().min(1).max(80),
  holder_name: z.string().trim().min(1).max(120),
  account_number: z.string().trim().min(4).max(20),
  routing_number: z.string().trim().min(9).max(9).optional(),
  is_default: z.boolean().default(true),
});

router.post('/employees/me/bank-accounts', authenticate, requireEmployee,
  validate({ body: accountCreate }),
  asyncHandler(async (req, res) => {
    const b = req.body;
    const acct = banking.normalizeAccount(b);
    const key = banking.encryptionKey();

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (b.is_default) {
        await client.query('UPDATE employee_bank_accounts SET is_default = false WHERE user_id = $1', [req.user.id]);
      }
      const { rows } = await client.query(
        `INSERT INTO employee_bank_accounts
           (user_id, country, type, bank_name, holder_name, account_encrypted, account_last4,
            routing_encrypted, routing_last4, is_default)
         VALUES ($1,$2,$3,$4,$5, pgp_sym_encrypt($6, $10), $7,
                 CASE WHEN $8::text IS NULL THEN NULL ELSE pgp_sym_encrypt($8, $10) END, $9, $11)
         RETURNING ${ACCOUNT_COLUMNS}`,
        [req.user.id, acct.country, b.type, b.bank_name, b.holder_name, acct.account, acct.last4,
          acct.routing, acct.routingLast4, key, b.is_default]);
      await client.query('COMMIT');
      res.status(201).json({ bank_account: banking.maskAccount(rows[0]) });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }));

router.delete('/employees/me/bank-accounts/:accountId', authenticate, requireEmployee,
  validate({ params: z.object({ accountId: uuid }) }),
  asyncHandler(async (req, res) => {
    // Soft-delete: a withdrawal already paid to this account must keep pointing at it.
    const { rowCount } = await pool.query(
      `UPDATE employee_bank_accounts SET active = false, is_default = false, updated_at = now()
        WHERE id = $1 AND user_id = $2 AND active`,
      [req.params.accountId, req.user.id]);
    if (rowCount === 0) throw ApiError.notFound('Bank account not found');
    res.status(204).end();
  }));

// The manager verifies an account (after seeing a statement, for instance). Sees the mask only.
router.get('/nightclubs/:nightclubId/employees/:userId/bank-accounts',
  requireRole('manager'),
  validate({ params: z.object({ nightclubId: uuid, userId: uuid }) }),
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT ${ACCOUNT_COLUMNS} FROM employee_bank_accounts a
        WHERE a.user_id = $1 AND a.active
          AND EXISTS (SELECT 1 FROM users u WHERE u.id = a.user_id AND u.nightclub_id = $2)
        ORDER BY is_default DESC, created_at`,
      [req.params.userId, req.params.nightclubId]);
    res.json({ bank_accounts: rows.map(banking.maskAccount) });
  }));

router.post('/nightclubs/:nightclubId/employees/:userId/bank-accounts/:accountId/verify',
  requireRole('manager'),
  validate({
    params: z.object({ nightclubId: uuid, userId: uuid, accountId: uuid }),
    body: z.object({ verified: z.boolean().default(true) }).default({}),
  }),
  asyncHandler(async (req, res) => {
    const { nightclubId, userId, accountId } = req.params;
    const { rows } = await pool.query(
      `UPDATE employee_bank_accounts a
          SET verified_at = CASE WHEN $4::boolean THEN now() ELSE NULL END,
              verified_by = CASE WHEN $4::boolean THEN $3::uuid ELSE NULL END,
              updated_at = now()
        WHERE a.id = $1 AND a.user_id = $2 AND a.active
          AND EXISTS (SELECT 1 FROM users u WHERE u.id = a.user_id AND u.nightclub_id = $5)
        RETURNING ${ACCOUNT_COLUMNS}`,
      [accountId, userId, req.user.id, req.body.verified, nightclubId]);
    if (rows.length === 0) throw ApiError.notFound('Bank account not found');
    res.json({ bank_account: banking.maskAccount(rows[0]) });
  }));

module.exports = router;
module.exports.EMPLOYEE_ROLES = EMPLOYEE_ROLES;
