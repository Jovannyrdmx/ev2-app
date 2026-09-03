// Request validation with zod. Usage:
//   router.post('/x', validate({ body: schema, params: schema, query: schema }), handler)
// Parsed (and coerced) values replace req.body / req.params / req.query.
'use strict';

const { z } = require('zod');
const { ApiError } = require('./errors');

function validate(schemas) {
  return (req, res, next) => {
    for (const key of ['params', 'query', 'body']) {
      const schema = schemas[key];
      if (!schema) continue;
      const result = schema.safeParse(req[key]);
      if (!result.success) {
        const details = result.error.issues.map((i) => ({
          field: [key, ...i.path].join('.'),
          message: i.message,
        }));
        return next(ApiError.badRequest('Validation failed', details));
      }
      // req.query is a getter in Express 5; assign defensively.
      try {
        req[key] = result.data;
      } catch {
        Object.defineProperty(req, key, { value: result.data, writable: true, configurable: true });
      }
    }
    return next();
  };
}

// Reusable primitives
const uuid = z.string().uuid('must be a UUID');
const email = z.string().trim().toLowerCase().email('must be a valid email').max(255);
const password = z.string().min(8, 'must be at least 8 characters').max(200);
const currency = z.enum(['MXN', 'USD']);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD');
const pagination = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

module.exports = { validate, z, uuid, email, password, currency, isoDate, pagination };
