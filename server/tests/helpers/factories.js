// Minimal fixtures: one club plus whatever each suite asks for.
'use strict';

const bcrypt = require('bcryptjs');
const { randomUUID } = require('crypto');
const { pool } = require('../../src/db/pool');

const PASSWORD = 'TestPassword123';
let cachedHash = null;

async function passwordHash() {
  if (!cachedHash) cachedHash = await bcrypt.hash(PASSWORD, 4); // low cost: tests only
  return cachedHash;
}

async function createNightclub(overrides = {}) {
  const { rows } = await pool.query(
    `INSERT INTO nightclubs (name, slug, city, country, timezone, currency_default, capacity)
     VALUES ($1,$2,'Nogales','MX','America/Hermosillo','MXN',500) RETURNING *`,
    [overrides.name || 'EV2 Test', overrides.slug || 'ev2-test'],
  );
  return rows[0];
}

async function createUser(nightclubId, overrides = {}) {
  const role = overrides.role || 'guest';
  const { rows } = await pool.query(
    `INSERT INTO users (nightclub_id, email, password_hash, first_name, last_name, display_name,
                        role, birth_date, terms_version, terms_accepted_at)
     VALUES ($1,$2,$3,$4,'Test',$5,$6,$7,'test',now()) RETURNING *`,
    [
      nightclubId,
      overrides.email || `${role}-${randomUUID().slice(0, 8)}@test.mx`,
      await passwordHash(),
      overrides.first_name || role,
      overrides.display_name || `${role} Test`,
      role,
      overrides.birth_date || '1995-01-01',
    ],
  );
  await pool.query(
    `INSERT INTO user_preferences (user_id, accept_flirts) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
    [rows[0].id, overrides.accept_flirts ?? false],
  );
  return rows[0];
}

async function createTable(nightclubId, overrides = {}) {
  const { rows } = await pool.query(
    `INSERT INTO tables (nightclub_id, code, section, type, capacity, x, y, radius, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [nightclubId, overrides.code || `T-${randomUUID().slice(0, 6)}`, overrides.section || 'main',
      overrides.type || 'standard', overrides.capacity ?? 4, overrides.x ?? 0, overrides.y ?? 0,
      overrides.radius ?? 1, overrides.status || 'available'],
  );
  return rows[0];
}

async function createDrink(nightclubId, overrides = {}) {
  const { rows } = await pool.query(
    `INSERT INTO drinks (nightclub_id, name, category, price, currency, available)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [nightclubId, overrides.name || `Bebida ${randomUUID().slice(0, 6)}`,
      overrides.category || 'beer', overrides.price ?? 100, overrides.currency || 'MXN',
      overrides.available ?? true],
  );
  await pool.query(
    `INSERT INTO inventory (drink_id, quantity, low_stock_threshold) VALUES ($1,$2,$3)`,
    [rows[0].id, overrides.stock ?? 50, overrides.low_stock_threshold ?? 5],
  );
  return rows[0];
}

async function createReservationRules(nightclubId, overrides = {}) {
  const { rows } = await pool.query(
    `INSERT INTO reservation_rules (nightclub_id, min_party_size, max_party_size, deposit_pct,
                                    base_price_per_hour, currency, min_advance_hours, max_duration_minutes)
     VALUES ($1,$2,$3,$4,$5,'MXN',$6,360)
     ON CONFLICT (nightclub_id) DO UPDATE SET deposit_pct = EXCLUDED.deposit_pct RETURNING *`,
    [nightclubId, overrides.min_party_size ?? 2, overrides.max_party_size ?? 12,
      overrides.deposit_pct ?? 30, overrides.base_price_per_hour ?? 500,
      overrides.min_advance_hours ?? 2],
  );
  return rows[0];
}

/** A Date `hours` from now, as an ISO string the API accepts. */
function hoursFromNow(hours) {
  return new Date(Date.now() + hours * 3_600_000).toISOString();
}

module.exports = {
  PASSWORD, createNightclub, createUser, createTable, createDrink,
  createReservationRules, hoursFromNow,
};
