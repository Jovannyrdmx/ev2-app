// Test database lifecycle: migrate once, then truncate between suites.
'use strict';

const { pool } = require('../../src/db/pool');
const { run: migrate } = require('../../src/db/migrate');

// Tables that hold test data; wiped between suites. Order does not matter because
// TRUNCATE ... CASCADE handles the foreign keys in one statement.
const DATA_TABLES = [
  'audit_log', 'events', 'transactions', 'withdrawals', 'tips', 'staff_drinks', 'song_requests',
  'staff_shifts', 'valet_tickets', 'parking_spots', 'taxi_requests', 'emergency_contacts',
  'drivers', 'taxi_fares', 'taxi_settings', 'valet_settings',
  'manual_payments', 'manual_payment_options',
  'reservation_addons', 'reservations', 'reservation_discounts', 'reservation_rules',
  'drink_order_items', 'drink_orders', 'inventory', 'drinks',
  'flirt_reactions', 'flirts', 'user_blocks', 'user_reports', 'user_preferences',
  'table_occupants', 'tables', 'pricing_rules', 'pos_sync_log', 'pos_integrations',
  'employee_bank_accounts', 'employee_profiles', 'payment_methods', 'user_devices',
  'refresh_tokens', 'exchange_rates', 'users', 'nightclubs',
];

async function setupSchema() {
  await migrate();
}

async function truncateAll() {
  // Ledger and audit tables block DELETE by design, but TRUNCATE is allowed and is
  // exactly what a test reset needs.
  await pool.query(`TRUNCATE ${DATA_TABLES.join(', ')} RESTART IDENTITY CASCADE`);
}

async function closePool() {
  await pool.end();
}

module.exports = { setupSchema, truncateAll, closePool, pool };
