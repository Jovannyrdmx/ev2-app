// Loaded by Jest before each test file (see jest.setupFiles in package.json).
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-characters';
process.env.ALLOWED_ORIGINS = 'http://localhost:8080';
process.env.LOG_LEVEL = 'silent';
process.env.SERVE_API_DOCS = 'false';
// Rate limits must not interfere with tests that hammer the same endpoint.
process.env.RATE_LIMIT_PER_MIN = '100000';
process.env.AUTH_RATE_LIMIT_PER_MIN = '100000';
// El acceso por PIN necesita su llave; sin ella el servicio se niega a arrancar, que
// es justo lo que debe hacer en producción.
process.env.PIN_LOOKUP_KEY = process.env.PIN_LOOKUP_KEY
  || 'test-pin-lookup-key-0123456789-0123456789-abcdef';
process.env.PIN_RATE_LIMIT_PER_MIN = '100000';
process.env.DB_NAME = process.env.TEST_DB_NAME || 'ev2_test';
