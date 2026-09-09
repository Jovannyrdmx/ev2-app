#!/usr/bin/env node
// Development seed data for EV2. Idempotent (safe to run repeatedly).
// Refuses to run when NODE_ENV=production. Requires SEED_PASSWORD in the environment.
'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { pool } = require('../src/db/pool');

const CLUB_ID = '00000000-0000-4000-8000-000000000001';

const SECTIONS = {
  main: { count: 8, type: 'standard', capacity: 4, x0: 100, y0: 300, dx: 90, dy: 90, cols: 4, radius: 30 },
  vip: { count: 6, type: 'vip', capacity: 6, x0: 100, y0: 80, dx: 110, dy: 100, cols: 3, radius: 38, bottle: true },
  bar: { count: 4, type: 'bar_top', capacity: 3, x0: 520, y0: 100, dx: 0, dy: 80, cols: 1, radius: 24 },
  patio: { count: 2, type: 'booth', capacity: 8, x0: 520, y0: 460, dx: 120, dy: 0, cols: 2, radius: 42 },
};

// El menú de desarrollo es el MISMO catálogo real de la caja. Antes eran treinta
// bebidas inventadas a precios inventados, y eso hacía que cada prueba a mano se
// corriera contra números que nunca iban a ser los del club.
const MENU = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'data/ev2-menu.json'), 'utf8'));
const DRINKS = MENU.items.map((i) => [i.category, i.name, i.price, i.pos_id]);


const USERS = [
  ['admin', 'Erick', 'Lopez', 'erick.x.lopez@gmail.com'],
  ['manager', 'Mariana', 'Gerente', 'manager@ev2.local'],
  ['bartender', 'Beto', 'Barra', 'bartender@ev2.local'],
  ['waiter', 'Wendy', 'Mesera', 'waiter@ev2.local'],
  ['dancer', 'Dana', 'Star', 'dancer@ev2.local', 'Dana Star'],
  ['dj', 'Diego', 'Beats', 'dj@ev2.local', 'DJ Diego'],
  ['light_tech', 'Luis', 'Luces', 'lights@ev2.local'],
  ['valet', 'Victor', 'Valet', 'valet@ev2.local'],
  ['hostess', 'Hilda', 'Host', 'hostess@ev2.local'],
  ['guest', 'Gabriel', 'Cliente', 'guest@ev2.local'],
];

const STAFF_ROLES = new Set(['waiter', 'bartender', 'dancer', 'dj', 'light_tech', 'valet', 'hostess', 'manager']);

async function seed() {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to seed: NODE_ENV=production');
  }
  const password = process.env.SEED_PASSWORD;
  if (!password || password.length < 8) {
    throw new Error('SEED_PASSWORD (min 8 chars) is required in the environment');
  }
  const passwordHash = await bcrypt.hash(password, 10);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(
      `INSERT INTO nightclubs (id, name, slug, address, city, country, timezone, currency_default, capacity)
       VALUES ($1, 'EV2 Clandestinoz', 'ev2', 'Nogales, Sonora', 'Nogales', 'MX', 'America/Hermosillo', 'MXN', 500)
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, city = EXCLUDED.city`,
      [CLUB_ID],
    );

    // Tables with layout coordinates
    let tables = 0;
    for (const [section, cfg] of Object.entries(SECTIONS)) {
      for (let i = 0; i < cfg.count; i++) {
        const code = `${section.toUpperCase()}-${i + 1}`;
        const x = cfg.x0 + (i % cfg.cols) * cfg.dx;
        const y = cfg.y0 + Math.floor(i / cfg.cols) * cfg.dy;
        await client.query(
          `INSERT INTO tables (nightclub_id, code, name, section, type, capacity, x, y, radius, bottle_service)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           ON CONFLICT (nightclub_id, code) DO UPDATE
             SET section = EXCLUDED.section, type = EXCLUDED.type, capacity = EXCLUDED.capacity`,
          [CLUB_ID, code, `Mesa ${code}`, section, cfg.type, cfg.capacity, x, y, cfg.radius, !!cfg.bottle],
        );
        tables++;
      }
    }

    // Drinks + inventory (pos_product_id is a stable dev key; real ids come from the POS sync)
    for (let i = 0; i < DRINKS.length; i++) {
      const [category, name, price, posId] = DRINKS[i];
      const { rows } = await client.query(
        `INSERT INTO drinks (nightclub_id, name, category, price, currency, pos_product_id, sort_order)
         VALUES ($1,$2,$3,$4,'MXN',$5,$6)
         ON CONFLICT (nightclub_id, pos_product_id) WHERE pos_product_id IS NOT NULL
           DO UPDATE SET name = EXCLUDED.name, category = EXCLUDED.category, price = EXCLUDED.price
         RETURNING id`,
        [CLUB_ID, name, category, price, posId, i],
      );
      await client.query(
        `INSERT INTO inventory (drink_id, quantity, unit, low_stock_threshold)
         VALUES ($1, $2, 'unit', 5)
         ON CONFLICT (drink_id) DO NOTHING`,
        [rows[0].id, category === 'Botellas' ? 12 : 100],
      );
    }

    // Users (one per role) + preferences + employee profiles
    for (const [role, first, last, email, stageName] of USERS) {
      const { rows } = await client.query(
        `INSERT INTO users (nightclub_id, email, password_hash, first_name, last_name, display_name, role,
                            birth_date, age_verified, terms_version, terms_accepted_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'1990-06-15',true,'dev',now())
         ON CONFLICT (nightclub_id, email) DO UPDATE SET role = EXCLUDED.role, first_name = EXCLUDED.first_name
         RETURNING id`,
        [CLUB_ID, email, passwordHash, first, last, stageName || `${first} ${last}`, role],
      );
      const userId = rows[0].id;
      await client.query(
        `INSERT INTO user_preferences (user_id, accept_flirts) VALUES ($1, $2)
         ON CONFLICT (user_id) DO NOTHING`,
        [userId, role === 'guest'],
      );
      if (STAFF_ROLES.has(role)) {
        await client.query(
          `INSERT INTO employee_profiles (user_id, employee_code, country, stage_name, hire_date)
           VALUES ($1, $2, 'MX', $3, '2026-01-01')
           ON CONFLICT (user_id) DO NOTHING`,
          [userId, `EMP-${role.toUpperCase()}`, stageName || null],
        );
      }
    }

    await client.query(
      `INSERT INTO reservation_rules (nightclub_id, min_party_size, max_party_size, deposit_pct, base_price_per_hour, currency)
       VALUES ($1, 2, 20, 30, 500, 'MXN') ON CONFLICT (nightclub_id) DO NOTHING`,
      [CLUB_ID],
    );

    const discounts = [
      ['BIENVENIDO', 'percentage', 10, 'Primera reservación'],
      ['VIP50', 'percentage', 50, 'Promo VIP prueba'],
      ['MENOS200', 'fixed_amount', 200, 'Descuento fijo de prueba'],
    ];
    for (const [code, type, value, desc] of discounts) {
      await client.query(
        `INSERT INTO reservation_discounts (nightclub_id, code, description, discount_type, discount_value, max_uses)
         VALUES ($1,$2,$3,$4,$5,100) ON CONFLICT (nightclub_id, code) DO NOTHING`,
        [CLUB_ID, code, desc, type, value],
      );
    }

    const pricing = [
      ['Fin de semana VIP', 'table_type', 'vip', '{5,6}', null, null, 'multiplier', 1.5, 10],
      ['Happy hour', 'drink_category', 'cocktail', '{2,3,4}', '20:00', '22:00', 'multiplier', 0.8, 20],
      ['Barra entre semana', 'section', 'bar', '{1,2,3,4}', null, null, 'multiplier', 0.9, 30],
      ['Reservación base', 'reservation', null, '{0,1,2,3,4,5,6}', null, null, 'fixed', 0, 100],
    ];
    for (const [name, applies, target, days, from, to, adj, value, priority] of pricing) {
      const exists = await client.query(
        'SELECT 1 FROM pricing_rules WHERE nightclub_id = $1 AND name = $2',
        [CLUB_ID, name],
      );
      if (exists.rowCount === 0) {
        await client.query(
          `INSERT INTO pricing_rules (nightclub_id, name, applies_to, target, days_of_week, time_from, time_to,
                                      adjustment_type, value, priority)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [CLUB_ID, name, applies, target, days, from, to, adj, value, priority],
        );
      }
    }

    const contacts = [
      ['Emergencias 911', '911', 'police', 0],
      ['Cruz Roja Nogales', '631-312-0010', 'ambulance', 1],
      ['Taxi seguro del club', '631-000-0000', 'taxi', 2],
      ['Seguridad EV2', '631-000-0001', 'club_security', 3],
    ];
    for (const [name, phone, type, order] of contacts) {
      const exists = await client.query(
        'SELECT 1 FROM emergency_contacts WHERE nightclub_id = $1 AND name = $2',
        [CLUB_ID, name],
      );
      if (exists.rowCount === 0) {
        await client.query(
          `INSERT INTO emergency_contacts (nightclub_id, name, phone, type, sort_order) VALUES ($1,$2,$3,$4,$5)`,
          [CLUB_ID, name, phone, type, order],
        );
      }
    }

    for (let i = 1; i <= 12; i++) {
      await client.query(
        `INSERT INTO parking_spots (nightclub_id, code, zone) VALUES ($1, $2, $3)
         ON CONFLICT (nightclub_id, code) DO NOTHING`,
        [CLUB_ID, `P-${String(i).padStart(2, '0')}`, i <= 6 ? 'front' : 'back'],
      );
    }

    const rate = await client.query(`SELECT 1 FROM exchange_rates WHERE base = 'USD' AND quote = 'MXN' LIMIT 1`);
    if (rate.rowCount === 0) {
      await client.query(
        `INSERT INTO exchange_rates (base, quote, rate, source) VALUES ('USD', 'MXN', 18.50, 'seed')`,
      );
    }

    await client.query('COMMIT');

    const counts = await client.query(`
      SELECT (SELECT count(*) FROM tables WHERE nightclub_id = $1) AS tables,
             (SELECT count(*) FROM drinks WHERE nightclub_id = $1) AS drinks,
             (SELECT count(*) FROM users WHERE nightclub_id = $1) AS users,
             (SELECT count(*) FROM pricing_rules WHERE nightclub_id = $1) AS pricing_rules,
             (SELECT count(*) FROM parking_spots WHERE nightclub_id = $1) AS parking_spots`, [CLUB_ID]);
    console.log('Seed complete:', counts.rows[0], `(${tables} tables processed)`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

if (require.main === module) {
  seed()
    .then(() => pool.end())
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Seed failed:', err.message);
      pool.end().finally(() => process.exit(1));
    });
}

module.exports = { seed, CLUB_ID };
