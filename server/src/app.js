// Express application factory. Kept free of listen()/process concerns so tests can
// import it directly (see src/index.js for startup).
'use strict';

require('dotenv').config();

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const pinoHttp = require('pino-http');

const { errorHandler, notFoundHandler, ApiError } = require('./middleware/errors');

const authRoutes = require('./routes/auth');
const nightclubRoutes = require('./routes/nightclubs');
const drinkRoutes = require('./routes/drinks');
const orderRoutes = require('./routes/orders');
const tableRoutes = require('./routes/tables');
const reservationRoutes = require('./routes/reservations');
const eventRoutes = require('./routes/events');
const flirtRoutes = require('./routes/flirts');
const employeeRoutes = require('./routes/employees');

// The OpenAPI contract is the agreement between backend, web and mobile.
// It is served at /api/docs; a missing file must not stop the API from starting.
function loadOpenApi() {
  try {
    const YAML = require('yaml');
    return YAML.parse(fs.readFileSync(path.resolve(__dirname, '../openapi.yaml'), 'utf8'));
  } catch (err) {
    console.warn('OpenAPI spec unavailable:', err.message);
    return null;
  }
}

function buildCors() {
  const origins = (process.env.ALLOWED_ORIGINS || '')
    .split(',').map((o) => o.trim()).filter(Boolean);
  return cors({
    origin(origin, callback) {
      // Same-origin/native clients send no Origin header.
      if (!origin || origins.includes(origin)) return callback(null, true);
      return callback(new Error('Origin not allowed by CORS'));
    },
    credentials: true,
    maxAge: 86_400,
  });
}

function createApp() {
  const app = express();
  app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS || 1));
  app.disable('x-powered-by');

  app.use(helmet());
  app.use(buildCors());
  app.use(express.json({ limit: '1mb' }));

  app.use(pinoHttp({
    genReqId: (req) => req.headers['x-request-id'] || crypto.randomUUID(),
    level: process.env.LOG_LEVEL || 'info',
    autoLogging: { ignore: (req) => req.url === '/health' },
    redact: ['req.headers.authorization', 'req.headers.cookie', 'req.body.password', 'req.body.refresh_token'],
  }));

  // Health check stays outside rate limiting so monitoring never trips it.
  app.get('/health', (req, res) => {
    res.json({ status: 'ok', service: 'ev2-api', timestamp: new Date().toISOString() });
  });

  const generalLimiter = rateLimit({
    windowMs: 60_000,
    limit: Number(process.env.RATE_LIMIT_PER_MIN || 300),
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (req, res, next) => next(ApiError.tooMany()),
  });
  const authLimiter = rateLimit({
    windowMs: 60_000,
    limit: Number(process.env.AUTH_RATE_LIMIT_PER_MIN || 10),
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    handler: (req, res, next) => next(ApiError.tooMany('Too many attempts, try again in a minute')),
  });

  app.use('/api', generalLimiter);
  app.use('/api/auth/login', authLimiter);
  app.use('/api/auth/register', authLimiter);
  app.use('/api/auth/refresh', authLimiter);

  app.use('/api/auth', authRoutes);
  app.use('/api', nightclubRoutes);
  app.use('/api', drinkRoutes);
  app.use('/api', orderRoutes);
  app.use('/api', tableRoutes);
  app.use('/api', reservationRoutes);
  app.use('/api', eventRoutes);
  app.use('/api', flirtRoutes);
  app.use('/api', employeeRoutes);

  // Interactive API documentation (disable in production with SERVE_API_DOCS=false).
  if (process.env.SERVE_API_DOCS !== 'false') {
    const spec = loadOpenApi();
    if (spec) {
      const swaggerUi = require('swagger-ui-express');
      app.get('/api/openapi.yaml', (req, res) => {
        res.type('text/yaml').sendFile(path.resolve(__dirname, '../openapi.yaml'));
      });
      app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(spec, {
        customSiteTitle: 'EV2 API',
        swaggerOptions: { persistAuthorization: true },
      }));
    }
  }

  // POS webhooks are implemented in phase 4.
  app.post('/api/webhooks/pos', (req, res, next) => next(
    ApiError.notImplemented('POS webhook is implemented in phase 4 (see docs/POS_REAL.md)'),
  ));

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
