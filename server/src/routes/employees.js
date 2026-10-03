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

const express = require('express');
const bcrypt = require('bcryptjs');
const { pool } = require('../db/pool');
const { ApiError, asyncHandler } = require('../middleware/errors');
const { validate, z, uuid, email, currency, pagination } = require('../middleware/validate');
const { authenticate, requireRole, sameNightclub } = require('../middleware/auth');
const banking = require('../services/banking');
const { temporaryPassword } = require('../services/credentials');
const pins = require('../services/pins');

const router = express.Router({ mergeParams: true });

const EMPLOYEE_ROLES = ['waiter', 'bartender', 'dancer', 'dj', 'light_tech', 'valet', 'hostess'];

/**
 * `manager` se puede dar de alta por aquí, pero solo el administrador puede hacerlo.
 *
 * No es simetría con los demás roles: un gerente que puede nombrar gerentes puede
 * nombrarse un cómplice, y a partir de ahí el permiso de gerente ya no protege nada
 * —caja, precios, retiros, nómina—. El administrador es el dueño del club, y su rol
 * no lo da ninguna pantalla: solo `npm run promote` en la consola del servidor.
 *
 * `admin` NO está en la lista. Que la única forma de crear un administrador sea tener
 * acceso a la máquina es justo lo que hace que el rol signifique algo.
 */
const MANAGER_ROLE = 'manager';
const CREATABLE_ROLES = [...EMPLOYEE_ROLES, MANAGER_ROLE];

/** Quien pide el alta o el cambio, ¿puede otorgar este rol? */
function mayGrant(requester, role) {
  if (role !== MANAGER_ROLE) return true;
  return requester && requester.role === 'admin';
}

const ONLY_ADMIN = 'Solo el administrador puede dar de alta o nombrar gerentes';

const EMPLOYEE_SELECT = `
  SELECT u.id, u.email, u.phone, u.first_name, u.last_name, u.display_name, u.role, u.status,
         u.preferred_currency, u.must_change_password, u.last_login_at, u.created_at,
         (u.pin_lookup IS NOT NULL) AS has_pin, u.must_change_pin, u.pin_issued_at,
         -- El personal de piso nace sin contrasena (D46). La pantalla lo necesita para
         -- no ofrecer "reiniciar contrasena" a quien no tiene ninguna.
         (u.password_hash IS NOT NULL) AS has_password,
         p.employee_code, p.country, p.stage_name, p.avatar_url, p.hire_date, p.active,
         p.preferred_payout_currency, p.deactivated_at,
         (s.id IS NOT NULL) AS on_shift,
         -- Desde cuando, no solo si. El portal le dice al empleado cuanto lleva
         -- trabajando, y sin esta columna tendria que pedir la lista de turnos, que
         -- solo pueden leer el gerente y la anfitriona.
         s.started_at AS shift_started_at
    FROM users u
    JOIN employee_profiles p ON p.user_id = u.id
    LEFT JOIN staff_shifts s ON s.user_id = u.id AND s.ended_at IS NULL`;

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
      role: z.enum(CREATABLE_ROLES).optional(),
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
  role: z.enum(CREATABLE_ROLES),
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
    if (!mayGrant(req.user, b.role)) throw ApiError.forbidden(ONLY_ADMIN);
    if (!pins.isConfigured()) {
      throw ApiError.notImplemented('No se le puede generar un PIN a un empleado nuevo. '
        + pins.configProblem());
    }

    // El piso entra SOLO con PIN (D46), así que su cuenta nace sin contraseña: no es
    // que tenga una que nadie usa, es que no tiene. `password_hash` en NULL cierra
    // `/auth/login` para esa persona de raíz, y no hay nada que se pueda filtrar ni
    // apuntar en un papel pegado a la barra.
    //
    // La gerencia sí lleva contraseña temporal además del PIN, porque desde fuera del
    // club el PIN no le sirve y necesita cómo entrar.
    const esGerencia = b.role === MANAGER_ROLE;
    const temp = esGerencia ? temporaryPassword() : null;
    const hash = temp ? await bcrypt.hash(temp, 10) : null;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      let user;
      try {
        const created = await client.query(
          `INSERT INTO users (nightclub_id, email, phone, password_hash, first_name, last_name, display_name,
                              role, birth_date, age_verified, preferred_currency, must_change_password,
                              created_by, terms_version, terms_accepted_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,true,$10,$12,$11,NULL,NULL)
           RETURNING id`,
          [nightclubId, b.email, b.phone || null, hash, b.first_name, b.last_name,
            b.stage_name || `${b.first_name} ${b.last_name}`.trim(), b.role, b.birth_date,
            b.preferred_currency || (b.country === 'US' ? 'USD' : 'MXN'), req.user.id,
            Boolean(temp)]);
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

      // El PIN de un solo uso. Sale de aquí en claro UNA vez y no se vuelve a poder
      // leer: lo que queda guardado es el cifrado y la huella con la que se busca.
      const pin = await pins.issuePin(client, {
        userId: user.id, birthDate: b.birth_date, issuedBy: req.user.id,
      });

      // Un alta de mesero no se audita: la lista de personal ya cuenta esa historia.
      // Un gerente nuevo sí, porque es alguien que a partir de ahora puede mover la
      // caja y los precios, y seis meses después hay que poder decir quién lo nombró.
      if (b.role === MANAGER_ROLE) {
        await client.query(
          `INSERT INTO audit_log (nightclub_id, actor_id, action, entity, entity_id, after, ip)
           VALUES ($1,$2,'manager_created','user',$3,$4,$5)`,
          [nightclubId, req.user.id, user.id,
            JSON.stringify({ email: b.email, display_name: `${b.first_name} ${b.last_name}`.trim() }),
            req.ip || null]);
      }
      await client.query('COMMIT');

      const full = await pool.query(`${EMPLOYEE_SELECT} WHERE u.id = $1`, [user.id]);
      // El PIN y la contraseña temporal viajan exactamente una vez, aquí. Ninguno se
      // guarda en claro, y la pantalla tiene que enseñarlos antes de repintar nada.
      res.status(201).json({
        employee: full.rows[0],
        pin,
        ...(temp ? { temporary_password: temp } : {}),
      });
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
  role: z.enum(CREATABLE_ROLES).optional(),
  stage_name: z.string().trim().max(80).nullable().optional(),
  employee_code: z.string().trim().max(30).nullable().optional(),
  hire_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  phone: z.string().trim().max(30).nullable().optional(),
  active: z.boolean().optional(),
  reset_password: z.boolean().optional(),
  // Le genera un PIN nuevo, de un solo uso, como el del alta. Es lo que se hace cuando
  // alguien olvida el suyo: no hay forma de recuperarlo —no se guarda en claro— así
  // que se tira y se entrega otro.
  reset_pin: z.boolean().optional(),
}).refine((b) => Object.keys(b).length > 0, { message: 'No fields to update' });

router.patch('/nightclubs/:nightclubId/employees/:userId',
  requireRole('manager'),
  validate({ params: z.object({ nightclubId: uuid, userId: uuid }), body: employeePatch }),
  asyncHandler(async (req, res) => {
    const { nightclubId, userId } = req.params;
    const b = req.body;
    if (!mayGrant(req.user, b.role)) throw ApiError.forbidden(ONLY_ADMIN);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const cur = await client.query(
        `SELECT u.id, u.role, p.active FROM users u JOIN employee_profiles p ON p.user_id = u.id
          WHERE u.id = $1 AND u.nightclub_id = $2 FOR UPDATE OF u`,
        [userId, nightclubId]);
      if (cur.rowCount === 0) throw ApiError.notFound('Employee not found');

      // Tocar a un gerente es tan delicado como nombrarlo, y por las mismas tres
      // vías: cambiarle el rol, darlo de baja, o reiniciarle la contraseña —esta
      // última se la entrega a quien la pidió, así que es tomarle la cuenta—. Si un
      // gerente pudiera hacerle eso a otro, dos gerentes en desacuerdo se apagarían
      // el uno al otro a media noche. La gerencia solo la reacomoda el administrador.
      const esGerente = cur.rows[0].role === MANAGER_ROLE;
      const tocaLaCuenta = Boolean(b.role) || b.active === false
        || b.reset_password === true || b.reset_pin === true;
      if (esGerente && tocaLaCuenta && !mayGrant(req.user, MANAGER_ROLE)) {
        throw ApiError.forbidden(ONLY_ADMIN);
      }

      if (b.role) {
        await client.query('UPDATE users SET role = $2, updated_at = now() WHERE id = $1', [userId, b.role]);
        // Solo cuando la gerencia entra o sale. Mover a alguien de mesero a valet no
        // necesita rastro; quién nombró al gerente, sí.
        if (b.role === MANAGER_ROLE || esGerente) {
          await client.query(
            `INSERT INTO audit_log (nightclub_id, actor_id, action, entity, entity_id, before, after, ip)
             VALUES ($1,$2,'manager_role_changed','user',$3,$4,$5,$6)`,
            [nightclubId, req.user.id, userId,
              JSON.stringify({ role: cur.rows[0].role }), JSON.stringify({ role: b.role }),
              req.ip || null]);
        }
      }
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

      let pinOut = null;
      if (b.reset_pin) {
        if (!pins.isConfigured()) {
          throw ApiError.notImplemented(`No se puede generar el PIN. ${pins.configProblem()}`);
        }
        const { rows: quien } = await client.query(
          'SELECT birth_date FROM users WHERE id = $1', [userId]);
        pinOut = await pins.issuePin(client, {
          userId, birthDate: quien[0].birth_date, issuedBy: req.user.id,
        });
        // Se cierran sus sesiones: si pidió PIN nuevo porque olvidó el suyo, bien; y
        // si lo pidió porque alguien más lo supo, esto es lo que saca a ese alguien.
        await client.query('DELETE FROM refresh_tokens WHERE user_id = $1', [userId]);
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
      // Igual que el del alta: viaja una vez y no se vuelve a poder leer.
      if (pinOut) out.pin = pinOut;
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

// ---------------------------------------------------------------- exchange rate

/** Latest USD->MXN rate (MXN per 1 USD), or null when the manager has never set one. */
async function currentRate(runner = pool) {
  const { rows } = await runner.query(
    `SELECT id, rate, effective_from, source, set_by FROM exchange_rates
      WHERE base = 'USD' AND quote = 'MXN' AND effective_from <= now()
      ORDER BY effective_from DESC, id DESC LIMIT 1`);
  return rows[0] || null;
}

function convert(amount, from, to, rate) {
  if (from === to) return Number(amount);
  const r = Number(rate);
  return Number((from === 'USD' ? Number(amount) * r : Number(amount) / r).toFixed(2));
}

router.get('/nightclubs/:nightclubId/exchange-rate',
  validate({ params: z.object({ nightclubId: uuid }) }),
  asyncHandler(async (req, res) => {
    const current = await currentRate();
    const isManager = ['manager', 'admin'].includes(req.user.role);
    let history = [];
    if (isManager) {
      const { rows } = await pool.query(
        `SELECT r.id, r.rate, r.effective_from, r.source, u.display_name AS set_by_name
           FROM exchange_rates r LEFT JOIN users u ON u.id = r.set_by
          WHERE r.base = 'USD' AND r.quote = 'MXN'
          ORDER BY r.effective_from DESC, r.id DESC LIMIT 30`);
      history = rows;
    }
    res.json({ base: 'USD', quote: 'MXN', current, history });
  }));

router.put('/nightclubs/:nightclubId/exchange-rate',
  requireRole('manager'),
  validate({
    params: z.object({ nightclubId: uuid }),
    body: z.object({
      rate: z.number().positive().max(1000),
      effective_from: z.coerce.date().optional(),
      source: z.string().trim().max(40).default('manual'),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(
      `INSERT INTO exchange_rates (base, quote, rate, effective_from, source, set_by)
       VALUES ('USD','MXN',$1, COALESCE($2, now()), $3, $4)
       RETURNING id, rate, effective_from, source`,
      [req.body.rate, req.body.effective_from || null, req.body.source, req.user.id]);
    res.status(201).json({ rate: rows[0] });
  }));

// ---------------------------------------------------------------- earnings

/**
 * Balance per currency, always computed: everything paid to this person in the ledger
 * minus every withdrawal that is pending, approved or paid (rejected ones never counted).
 */
async function balancesFor(userId, runner = pool) {
  const { rows } = await runner.query(
    `WITH earned AS (
       SELECT currency, COALESCE(sum(amount), 0) AS total, count(*)::int AS movements
         FROM transactions
        WHERE payee_user_id = $1 AND direction = 'in' AND status = 'paid'
        GROUP BY currency),
     withdrawn AS (
       SELECT currency,
              COALESCE(sum(amount) FILTER (WHERE status = 'paid'), 0)                 AS paid,
              COALESCE(sum(amount) FILTER (WHERE status IN ('pending','approved')), 0) AS reserved
         FROM withdrawals WHERE user_id = $1 GROUP BY currency)
     SELECT c.currency,
            COALESCE(e.total, 0)::numeric(12,2)::text     AS earned,
            COALESCE(w.paid, 0)::numeric(12,2)::text      AS withdrawn,
            COALESCE(w.reserved, 0)::numeric(12,2)::text  AS reserved,
            (COALESCE(e.total, 0) - COALESCE(w.paid, 0) - COALESCE(w.reserved, 0))::numeric(12,2)::text AS available,
            COALESCE(e.movements, 0)       AS movements
       FROM (VALUES ('MXN'), ('USD')) AS c(currency)
       LEFT JOIN earned e ON e.currency = c.currency
       LEFT JOIN withdrawn w ON w.currency = c.currency
      ORDER BY c.currency`,
    [userId]);
  return rows;
}

const earningsQuery = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

async function earningsReport(userId, { from, to }) {
  const params = [userId, from || null, to || null];
  const where = `payee_user_id = $1 AND direction = 'in' AND status = 'paid'
                 AND ($2::date IS NULL OR created_at >= $2::date)
                 AND ($3::date IS NULL OR created_at < ($3::date + interval '1 day'))`;
  const [byType, byDay, totals] = await Promise.all([
    pool.query(
      `SELECT currency, type, sum(amount)::text AS total, count(*)::int AS count
         FROM transactions WHERE ${where} GROUP BY currency, type ORDER BY currency, type`, params),
    pool.query(
      `SELECT currency, (created_at AT TIME ZONE 'America/Hermosillo')::date AS day,
              sum(amount)::text AS total, count(*)::int AS count
         FROM transactions WHERE ${where} GROUP BY currency, day ORDER BY day DESC, currency`, params),
    pool.query(
      `SELECT currency, sum(amount)::text AS total, count(*)::int AS count
         FROM transactions WHERE ${where} GROUP BY currency ORDER BY currency`, params),
  ]);
  return { from: from || null, to: to || null, totals: totals.rows, by_type: byType.rows, by_day: byDay.rows };
}

router.get('/employees/me/earnings', authenticate, requireEmployee,
  validate({ query: earningsQuery }),
  asyncHandler(async (req, res) => {
    res.json({ balances: await balancesFor(req.user.id), ...(await earningsReport(req.user.id, req.query)) });
  }));

const WITHDRAWAL_SELECT = `
  SELECT w.id, w.user_id, u.display_name AS employee_name, u.role AS employee_role,
         w.amount::text, w.currency, w.payout_currency, w.exchange_rate, w.amount_paid::text,
         w.status, w.note, w.rejection_reason, w.created_at, w.reviewed_at, w.paid_at,
         w.reviewed_by, m.display_name AS reviewed_by_name, w.transaction_id,
         w.bank_account_id, a.bank_name, a.type AS bank_account_type, a.account_last4
    FROM withdrawals w
    JOIN users u ON u.id = w.user_id
    LEFT JOIN users m ON m.id = w.reviewed_by
    LEFT JOIN employee_bank_accounts a ON a.id = w.bank_account_id`;

function publicWithdrawal(row) {
  const { account_last4: last4, ...rest } = row;
  return { ...rest, account_masked: last4 ? `****${last4}` : null };
}

router.get('/employees/me/dashboard', authenticate, requireEmployee, asyncHandler(async (req, res) => {
  const [balances, recent, open, rate, profile] = await Promise.all([
    balancesFor(req.user.id),
    pool.query(
      `SELECT id, type, amount::text, currency, created_at, metadata
         FROM transactions
        WHERE payee_user_id = $1 AND direction = 'in' AND status = 'paid'
        ORDER BY created_at DESC LIMIT 10`, [req.user.id]),
    pool.query(`${WITHDRAWAL_SELECT} WHERE w.user_id = $1 AND w.status IN ('pending','approved')`, [req.user.id]),
    currentRate(),
    pool.query(`${EMPLOYEE_SELECT} WHERE u.id = $1`, [req.user.id]),
  ]);
  res.json({
    employee: profile.rows[0],
    balances,
    recent_movements: recent.rows,
    open_withdrawal: open.rows[0] ? publicWithdrawal(open.rows[0]) : null,
    exchange_rate: rate,
    generated_at: new Date().toISOString(),
  });
}));

// ---------------------------------------------------------------- withdrawals: employee

router.get('/employees/me/withdrawals', authenticate, requireEmployee,
  validate({ query: pagination }),
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(
      `${WITHDRAWAL_SELECT} WHERE w.user_id = $1 ORDER BY w.created_at DESC LIMIT $2 OFFSET $3`,
      [req.user.id, req.query.limit, req.query.offset]);
    res.json({ withdrawals: rows.map(publicWithdrawal) });
  }));

router.post('/employees/me/withdrawals', authenticate, requireEmployee,
  validate({
    body: z.object({
      amount: z.number().positive().max(1_000_000),
      currency,
      payout_currency: currency.optional(),
      bank_account_id: uuid.optional(),
      note: z.string().trim().max(300).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const b = req.body;
    const amount = Number(b.amount.toFixed(2));
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Serialize withdrawals per employee so two requests cannot both pass the balance check.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`withdrawal:${req.user.id}`]);

      const acct = await client.query(
        `SELECT id, country, verified_at FROM employee_bank_accounts
          WHERE user_id = $1 AND active AND ($2::uuid IS NULL OR id = $2)
          ORDER BY is_default DESC, created_at LIMIT 1`,
        [req.user.id, b.bank_account_id || null]);
      if (acct.rowCount === 0) throw ApiError.unprocessable('Registra una cuenta bancaria antes de pedir un retiro');
      const account = acct.rows[0];
      if (!account.verified_at) {
        throw ApiError.unprocessable('El gerente debe verificar tu cuenta bancaria antes del primer retiro');
      }

      const payoutCurrency = b.payout_currency || (account.country === 'US' ? 'USD' : 'MXN');
      const balances = await balancesFor(req.user.id, client);
      const available = Number(balances.find((x) => x.currency === b.currency).available);
      if (amount > available) {
        throw ApiError.unprocessable(`Saldo insuficiente: tienes ${available.toFixed(2)} ${b.currency} disponibles`,
          { available, currency: b.currency });
      }

      let rate = null; let amountPaid = amount;
      if (payoutCurrency !== b.currency) {
        const r = await currentRate(client);
        if (!r) throw ApiError.unprocessable('No hay tipo de cambio registrado; pide al gerente que lo capture');
        rate = Number(r.rate);
        amountPaid = convert(amount, b.currency, payoutCurrency, rate);
      }

      let created;
      try {
        created = await client.query(
          `INSERT INTO withdrawals (nightclub_id, user_id, bank_account_id, amount, currency,
                                    payout_currency, exchange_rate, amount_paid, note)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
          [req.user.nightclub_id, req.user.id, account.id, amount, b.currency,
            payoutCurrency, rate, amountPaid, b.note || null]);
      } catch (err) {
        if (err.code === '23505') throw ApiError.conflict('Ya tienes un retiro en proceso; espera a que se resuelva');
        throw err;
      }
      await client.query('COMMIT');
      const full = await pool.query(`${WITHDRAWAL_SELECT} WHERE w.id = $1`, [created.rows[0].id]);
      res.status(201).json({ withdrawal: publicWithdrawal(full.rows[0]) });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }));

// ---------------------------------------------------------------- withdrawals: manager

router.get('/nightclubs/:nightclubId/withdrawals',
  requireRole('manager'),
  validate({
    params: z.object({ nightclubId: uuid }),
    query: pagination.extend({ status: z.enum(['pending', 'approved', 'paid', 'rejected']).optional() }),
  }),
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(
      `${WITHDRAWAL_SELECT}
        WHERE w.nightclub_id = $1 AND ($2::text IS NULL OR w.status = $2)
        ORDER BY (w.status = 'pending') DESC, (w.status = 'approved') DESC, w.created_at
        LIMIT $3 OFFSET $4`,
      [req.params.nightclubId, req.query.status || null, req.query.limit, req.query.offset]);
    res.json({ withdrawals: rows.map(publicWithdrawal) });
  }));

async function lockedWithdrawal(client, id, nightclubId) {
  const { rows } = await client.query(
    'SELECT * FROM withdrawals WHERE id = $1 AND nightclub_id = $2 FOR UPDATE', [id, nightclubId]);
  if (rows.length === 0) throw ApiError.notFound('Withdrawal not found');
  return rows[0];
}

const withdrawalParams = z.object({ nightclubId: uuid, withdrawalId: uuid });

// Approval fixes the exchange rate at that moment: that is when money actually moves.
router.post('/nightclubs/:nightclubId/withdrawals/:withdrawalId/approve',
  requireRole('manager'),
  validate({ params: withdrawalParams, body: z.object({ note: z.string().trim().max(300).optional() }).default({}) }),
  asyncHandler(async (req, res) => {
    const { nightclubId, withdrawalId } = req.params;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const w = await lockedWithdrawal(client, withdrawalId, nightclubId);
      if (w.status !== 'pending') throw ApiError.conflict(`El retiro ya está '${w.status}'`);

      let rate = w.exchange_rate; let amountPaid = w.amount_paid;
      if (w.payout_currency && w.payout_currency !== w.currency) {
        const r = await currentRate(client);
        if (!r) throw ApiError.unprocessable('No hay tipo de cambio registrado');
        rate = Number(r.rate);
        amountPaid = convert(w.amount, w.currency, w.payout_currency, rate);
      }
      await client.query(
        `UPDATE withdrawals SET status = 'approved', reviewed_by = $2, reviewed_at = now(),
                exchange_rate = $3, amount_paid = $4, note = COALESCE($5, note), updated_at = now()
          WHERE id = $1`,
        [withdrawalId, req.user.id, rate, amountPaid, req.body.note || null]);
      await client.query('COMMIT');
      const full = await pool.query(`${WITHDRAWAL_SELECT} WHERE w.id = $1`, [withdrawalId]);
      res.json({ withdrawal: publicWithdrawal(full.rows[0]) });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }));

router.post('/nightclubs/:nightclubId/withdrawals/:withdrawalId/reject',
  requireRole('manager'),
  validate({ params: withdrawalParams, body: z.object({ reason: z.string().trim().min(1).max(300) }) }),
  asyncHandler(async (req, res) => {
    const { nightclubId, withdrawalId } = req.params;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const w = await lockedWithdrawal(client, withdrawalId, nightclubId);
      if (!['pending', 'approved'].includes(w.status)) throw ApiError.conflict(`El retiro ya está '${w.status}'`);
      await client.query(
        `UPDATE withdrawals SET status = 'rejected', reviewed_by = $2, reviewed_at = now(),
                rejection_reason = $3, updated_at = now() WHERE id = $1`,
        [withdrawalId, req.user.id, req.body.reason]);
      await client.query('COMMIT');
      const full = await pool.query(`${WITHDRAWAL_SELECT} WHERE w.id = $1`, [withdrawalId]);
      res.json({ withdrawal: publicWithdrawal(full.rows[0]) });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }));

// The manager made the transfer outside the system: record it in the ledger.
router.post('/nightclubs/:nightclubId/withdrawals/:withdrawalId/paid',
  requireRole('manager'),
  validate({
    params: withdrawalParams,
    body: z.object({ reference: z.string().trim().max(120).optional() }).default({}),
  }),
  asyncHandler(async (req, res) => {
    const { nightclubId, withdrawalId } = req.params;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const w = await lockedWithdrawal(client, withdrawalId, nightclubId);
      if (w.status !== 'approved') throw ApiError.conflict('Solo se marca pagado un retiro aprobado');

      const tx = await client.query(
        `INSERT INTO transactions (nightclub_id, type, direction, amount, currency, status,
                                   payee_user_id, provider, provider_ref, reference_type, reference_id,
                                   confirmed_by, confirmed_at, metadata)
         VALUES ($1,'withdrawal','out',$2,$3,'paid',$4,'manual',$5,'withdrawal',$6,$7, now(), $8)
         RETURNING id`,
        [nightclubId, w.amount_paid || w.amount, w.payout_currency || w.currency, w.user_id,
          req.body.reference || null, withdrawalId, req.user.id,
          JSON.stringify({ balance_amount: w.amount, balance_currency: w.currency, exchange_rate: w.exchange_rate })]);
      await client.query(
        `UPDATE withdrawals SET status = 'paid', paid_at = now(), transaction_id = $2, updated_at = now()
          WHERE id = $1`,
        [withdrawalId, tx.rows[0].id]);
      await client.query('COMMIT');
      const full = await pool.query(`${WITHDRAWAL_SELECT} WHERE w.id = $1`, [withdrawalId]);
      res.json({ withdrawal: publicWithdrawal(full.rows[0]) });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }));

// ---------------------------------------------------------------- manager: payroll view

router.get('/nightclubs/:nightclubId/employees/:userId/earnings',
  requireRole('manager'),
  validate({ params: z.object({ nightclubId: uuid, userId: uuid }), query: earningsQuery }),
  asyncHandler(async (req, res) => {
    const e = await pool.query(
      `SELECT 1 FROM users u JOIN employee_profiles p ON p.user_id = u.id
        WHERE u.id = $1 AND u.nightclub_id = $2`, [req.params.userId, req.params.nightclubId]);
    if (e.rowCount === 0) throw ApiError.notFound('Employee not found');
    res.json({ balances: await balancesFor(req.params.userId), ...(await earningsReport(req.params.userId, req.query)) });
  }));

router.get('/nightclubs/:nightclubId/payroll',
  requireRole('manager'),
  validate({ params: z.object({ nightclubId: uuid }) }),
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(
      `WITH earned AS (
         SELECT payee_user_id AS user_id, currency, sum(amount) AS total
           FROM transactions WHERE nightclub_id = $1 AND direction = 'in' AND status = 'paid'
            AND payee_user_id IS NOT NULL GROUP BY 1, 2),
       withdrawn AS (
         SELECT user_id, currency,
                sum(amount) FILTER (WHERE status = 'paid') AS paid,
                sum(amount) FILTER (WHERE status IN ('pending','approved')) AS reserved
           FROM withdrawals WHERE nightclub_id = $1 GROUP BY 1, 2)
       SELECT u.id AS user_id, u.display_name, u.role, p.active, c.currency,
              COALESCE(e.total, 0)::numeric(12,2)::text AS earned,
              COALESCE(w.paid, 0)::numeric(12,2)::text AS withdrawn,
              COALESCE(w.reserved, 0)::numeric(12,2)::text AS reserved,
              (COALESCE(e.total, 0) - COALESCE(w.paid, 0) - COALESCE(w.reserved, 0))::numeric(12,2)::text AS available
         FROM users u
         JOIN employee_profiles p ON p.user_id = u.id
         CROSS JOIN (VALUES ('MXN'), ('USD')) AS c(currency)
         LEFT JOIN earned e ON e.user_id = u.id AND e.currency = c.currency
         LEFT JOIN withdrawn w ON w.user_id = u.id AND w.currency = c.currency
        WHERE u.nightclub_id = $1
          AND (COALESCE(e.total, 0) <> 0 OR COALESCE(w.paid, 0) <> 0 OR COALESCE(w.reserved, 0) <> 0)
        ORDER BY u.role, u.display_name, c.currency`,
      [req.params.nightclubId]);
    const pending = await pool.query(
      `SELECT count(*)::int AS n FROM withdrawals WHERE nightclub_id = $1 AND status = 'pending'`,
      [req.params.nightclubId]);
    res.json({ rows, pending_withdrawals: pending.rows[0].n, exchange_rate: await currentRate() });
  }));

module.exports = router;
module.exports.EMPLOYEE_ROLES = EMPLOYEE_ROLES;
