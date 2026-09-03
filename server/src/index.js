// EV2 API entry point: verifies dependencies, starts the HTTP server, shuts down cleanly.
'use strict';

require('dotenv').config();

const http = require('http');
const { createApp } = require('./app');
const { pool } = require('./db/pool');
const { redis } = require('./db/redis');

const PORT = Number(process.env.PORT || 3000);

const app = createApp();
const server = http.createServer(app);

async function start() {
  try {
    if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 16) {
      throw new Error('JWT_SECRET is missing or shorter than 16 characters');
    }
    await pool.query('SELECT 1');
    console.log(`PostgreSQL connected (${process.env.DB_HOST || 'localhost'}:${process.env.DB_PORT || 5432})`);
    await redis.connect();
    console.log(`Redis connected (${process.env.REDIS_HOST || 'localhost'}:${process.env.REDIS_PORT || 6379})`);
  } catch (err) {
    console.error('Startup failed:', err.message);
    process.exit(1);
  }

  server.listen(PORT, () => {
    console.log(`EV2 API listening on port ${PORT} (${process.env.NODE_ENV || 'development'})`);
  });
}

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received, shutting down...`);
  server.close();
  await Promise.allSettled([redis.quit(), pool.end()]);
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
});

if (require.main === module) start();

module.exports = { app, server, start };
