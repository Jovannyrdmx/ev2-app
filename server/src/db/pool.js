// Shared PostgreSQL connection pool.
// Accepts DATABASE_URL or the discrete DB_* variables used by docker-compose.
'use strict';

require('dotenv').config();
const { Pool } = require('pg');

function buildConfig() {
  if (process.env.DATABASE_URL) {
    return { connectionString: process.env.DATABASE_URL };
  }
  return {
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 5432),
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || 'ev2',
  };
}

const pool = new Pool({
  ...buildConfig(),
  max: Number(process.env.DB_POOL_MAX || 10),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on('error', (err) => {
  console.error('PostgreSQL pool error:', err.message);
});

module.exports = { pool, buildConfig };
