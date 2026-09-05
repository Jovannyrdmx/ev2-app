// EV2 API entry point: verifies dependencies, starts the HTTP server, shuts down cleanly.
'use strict';

require('dotenv').config();

const http = require('http');
const { createApp } = require('./app');
const { pool } = require('./db/pool');
const { redis } = require('./db/redis');
const { EventRelay } = require('./realtime/relay');
const paymentConfig = require('./config/payments');

const PORT = Number(process.env.PORT || 3000);

const app = createApp();
const server = http.createServer(app);
let relay = null;

async function start() {
  try {
    if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 16) {
      throw new Error('JWT_SECRET is missing or shorter than 16 characters');
    }
    if (!process.env.BANK_ENCRYPTION_KEY || process.env.BANK_ENCRYPTION_KEY.length < 32) {
      throw new Error('BANK_ENCRYPTION_KEY is missing or shorter than 32 characters (employee bank accounts)');
    }
    // Refuses to start with live payment keys outside production, which is the mistake
    // that charges a real card during a demo.
    paymentConfig.assertSafeMode();
    await pool.query('SELECT 1');
    console.log(`PostgreSQL connected (${process.env.DB_HOST || 'localhost'}:${process.env.DB_PORT || 5432})`);
    await redis.connect();
    console.log(`Redis connected (${process.env.REDIS_HOST || 'localhost'}:${process.env.REDIS_PORT || 6379})`);
    // Committed events reach the sockets through this relay (D26). Exactly one API
    // process leads; the rest stand by and take over if it dies.
    relay = await new EventRelay({ redis }).start();
    app.locals.relay = relay;
    console.log(relay.isLeader
      ? `Realtime relay: leading from event ${relay.cursor}`
      : 'Realtime relay: standing by (another instance is leading)');
  } catch (err) {
    console.error('Startup failed:', err.message);
    process.exit(1);
  }

  const pay = paymentConfig.status();
  for (const p of pay.providers) {
    console.log(p.configured
      ? `Payments: ${p.provider} configured (${p.mode} mode)`
      : `Payments: ${p.provider} NOT configured — falta ${p.missing.join(', ')} (docs/PAGOS_SETUP.md)`);
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
  if (relay) await relay.stop().catch(() => {});
  await Promise.allSettled([redis.quit(), pool.end()]);
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
});

if (require.main === module) start();

module.exports = { app, server, start, relay: () => relay };
