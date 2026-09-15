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
const inventoryRoutes = require('./routes/inventory');
const supplierRoutes = require('./routes/suppliers');
const nightRoutes = require('./routes/nights');
const orderRoutes = require('./routes/orders');
const tableRoutes = require('./routes/tables');
const reservationRoutes = require('./routes/reservations');
const eventRoutes = require('./routes/events');
const flirtRoutes = require('./routes/flirts');
const employeeRoutes = require('./routes/employees');
const tipRoutes = require('./routes/tips');
const taxiRoutes = require('./routes/taxi');
const valetRoutes = require('./routes/valet');
const posRoutes = require('./routes/pos');
const paymentRoutes = require('./routes/payments');
const doorRoutes = require('./routes/door');
const passRoutes = require('./routes/passes');

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
      // Native clients send no Origin header. Browsers DO send it even for same-origin
      // POST/PUT/DELETE, so the site's own origin has to be in ALLOWED_ORIGINS even when
      // the API is behind the same proxy as the page.
      if (!origin || origins.includes(origin)) return callback(null, true);
      // A plain Error here surfaced as `500 Internal server error`, which says nothing
      // about the actual problem and is exactly what a misconfigured deployment hits on
      // its first request. It is a configuration mistake, and it now says so.
      return callback(new ApiError(403, 'origin_not_allowed',
        `El origen ${origin} no está en ALLOWED_ORIGINS. Agrégalo en .env y reinicia la API.`));
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
  //
  // Served at BOTH paths, and that is not redundancy for its own sake. Docker's
  // healthcheck talks to the container directly, so `/health` is what it needs.
  // But the proxy in front (deploy/nginx-web.conf) only forwards `/api/`, so from
  // outside the server `/health` does not exist at all — which meant the club had
  // no way to check whether its own API was alive through its own domain, and the
  // monitoring the plan calls for had nothing to point at. It also made every
  // troubleshooting instruction of the form `curl https://dominio/api/health`
  // answer 404 and send whoever was debugging down the wrong path.
  const health = (req, res) => {
    const body = { status: 'ok', service: 'ev2-api', timestamp: new Date().toISOString() };
    // Set by src/index.js when the process is running the event relay (D26). Absent in
    // tests, which import the app without starting the relay.
    const relay = req.app.locals.relay;
    if (relay) body.relay = relay.status();
    res.json(body);
  };
  app.get('/health', health);
  app.get('/api/health', health);

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

  // El enlace del pase que llega por WhatsApp no lleva sesión: el invitado no
  // tiene cuenta en el club y no la va a crear en la fila. Eso lo hace la única
  // ruta abierta que devuelve algo del club, así que se limita aparte y fuerte.
  //
  // 20 por minuto y por IP: de sobra para una familia que abre su enlace varias
  // veces en el estacionamiento, y muy poco para que sirva de ariete. Los aciertos
  // también cuentan, al contrario que en el login: aquí la petición exitosa es
  // precisamente la que se quiere frenar cuando alguien está probando enlaces.
  const passLimiter = rateLimit({
    windowMs: 60_000,
    limit: Number(process.env.PASS_RATE_LIMIT_PER_MIN || 20),
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (req, res, next) => next(ApiError.tooMany()),
  });

  app.use('/api', generalLimiter);
  app.use('/api/guest-passes', passLimiter);
  app.use('/api/auth/login', authLimiter);
  app.use('/api/auth/register', authLimiter);
  app.use('/api/auth/refresh', authLimiter);
  // Canjear el pase de mano y completar el registro social entregan una sesión, así
  // que cuentan como intentos de acceso. El `skipSuccessfulRequests` de este limitador
  // es justo lo que hace falta: la vuelta legítima de Facebook acierta y no gasta
  // cupo, y solo los fallos —alguien adivinando pases— se acumulan. No se limitan
  // `providers` ni `callback`: el callback legítimo llega desde el navegador del
  // cliente y en la puerta del club muchos comparten una sola IP.
  app.use('/api/auth/oauth/handoff', authLimiter);
  app.use('/api/auth/oauth/complete', authLimiter);

  app.use('/api/auth', authRoutes);
  app.use('/api', nightclubRoutes);
  app.use('/api', drinkRoutes);
  app.use('/api', inventoryRoutes);
  app.use('/api', supplierRoutes);
  app.use('/api', nightRoutes);
  app.use('/api', orderRoutes);
  app.use('/api', tableRoutes);
  app.use('/api', reservationRoutes);
  app.use('/api', doorRoutes);
  app.use('/api', passRoutes);
  app.use('/api', eventRoutes);
  app.use('/api', flirtRoutes);
  app.use('/api', employeeRoutes);
  app.use('/api', tipRoutes);
  app.use('/api', taxiRoutes);
  app.use('/api', valetRoutes);
  app.use('/api', posRoutes);
  app.use('/api', paymentRoutes);

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
