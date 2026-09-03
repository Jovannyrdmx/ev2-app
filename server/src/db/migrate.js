#!/usr/bin/env node
// Minimal, dependency-free SQL migration runner.
//
//   npm run migrate              apply pending migrations from server/migrations/NNN_*.sql
//   npm run migrate -- --status  show applied / pending without changing anything
//
// Each migration file runs inside one transaction managed here (files must not contain
// BEGIN/COMMIT); an advisory lock prevents two API
// instances from migrating concurrently. Files under migrations/legacy/ are ignored.
'use strict';

const fs = require('fs');
const path = require('path');
const { pool } = require('./pool');

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');
const LOCK_KEY = 7_420_026; // arbitrary, fixed application-level lock id
const FILE_RE = /^(\d{3,})_[\w-]+\.sql$/;

function listMigrationFiles() {
  return fs
    .readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((e) => e.isFile() && FILE_RE.test(e.name))
    .map((e) => e.name)
    .sort((a, b) => Number(a.match(FILE_RE)[1]) - Number(b.match(FILE_RE)[1]));
}

async function ensureTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    VARCHAR(120) PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
}

async function appliedVersions(client) {
  const { rows } = await client.query('SELECT version FROM schema_migrations ORDER BY version');
  return new Set(rows.map((r) => r.version));
}

async function run({ statusOnly = false } = {}) {
  const client = await pool.connect();
  try {
    await ensureTable(client);
    const files = listMigrationFiles();
    const applied = await appliedVersions(client);
    const pending = files.filter((f) => !applied.has(f));

    if (statusOnly) {
      for (const f of files) console.log(`${applied.has(f) ? 'applied ' : 'pending '} ${f}`);
      console.log(`${applied.size} applied, ${pending.length} pending`);
      return { applied: [...applied], pending };
    }

    if (pending.length === 0) {
      console.log('Migrations: nothing to apply (database is up to date).');
      return { applied: [...applied], pending: [] };
    }

    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    try {
      // Re-check after acquiring the lock: another instance may have migrated meanwhile.
      const nowApplied = await appliedVersions(client);
      for (const file of pending) {
        if (nowApplied.has(file)) continue;
        const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
        process.stdout.write(`Applying ${file} ... `);
        try {
          await client.query('BEGIN');
          await client.query(sql);
          await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
          await client.query('COMMIT');
          console.log('ok');
        } catch (err) {
          await client.query('ROLLBACK').catch(() => {});
          console.log('FAILED');
          throw new Error(`Migration ${file} failed: ${err.message}`);
        }
      }
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]);
    }
    console.log(`Migrations: ${pending.length} applied.`);
    return { applied: [...applied, ...pending], pending: [] };
  } finally {
    client.release();
  }
}

if (require.main === module) {
  const statusOnly = process.argv.includes('--status');
  run({ statusOnly })
    .then(() => pool.end())
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err.message);
      pool.end().finally(() => process.exit(1));
    });
}

module.exports = { run, listMigrationFiles };
