// Shared Redis client (node-redis v4). Used for caching and, from step 3.2, pub/sub.
'use strict';

require('dotenv').config();
const { createClient } = require('redis');

const redis = createClient({
  socket: {
    host: process.env.REDIS_HOST || 'localhost',
    port: Number(process.env.REDIS_PORT || 6379),
    // Give up after ~1 minute so the process exits and the supervisor restarts it.
    reconnectStrategy: (retries) => (retries > 20 ? new Error('Redis unreachable') : Math.min(retries * 100, 3000)),
  },
});

redis.on('error', (err) => console.error('Redis error:', err.message));
redis.on('reconnecting', () => console.warn('Redis reconnecting...'));

module.exports = { redis };
