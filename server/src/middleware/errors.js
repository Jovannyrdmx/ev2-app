// Central error handling. Routes throw ApiError (or any Error) and this turns it
// into a consistent JSON response. Stack traces are never sent to clients.
'use strict';

class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
  static badRequest(msg, details) { return new ApiError(400, 'bad_request', msg, details); }
  static unauthorized(msg = 'Authentication required') { return new ApiError(401, 'unauthorized', msg); }
  static forbidden(msg = 'Not allowed') { return new ApiError(403, 'forbidden', msg); }
  static notFound(msg = 'Not found') { return new ApiError(404, 'not_found', msg); }
  static conflict(msg, details) { return new ApiError(409, 'conflict', msg, details); }
  static unprocessable(msg, details) { return new ApiError(422, 'unprocessable', msg, details); }
  static tooMany(msg = 'Too many requests') { return new ApiError(429, 'too_many_requests', msg); }
  static notImplemented(msg = 'Not implemented yet') { return new ApiError(501, 'not_implemented', msg); }
}

// Wraps async route handlers so rejected promises reach the error middleware.
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function notFoundHandler(req, res) {
  res.status(404).json({ error: { code: 'not_found', message: `No route for ${req.method} ${req.path}` } });
}

// eslint-disable-next-line no-unused-vars -- Express identifies error handlers by arity (4 args)
function errorHandler(err, req, res, next) {
  const status = err.status || 500;
  const body = {
    error: {
      code: err.code || 'internal_error',
      message: status === 500 ? 'Internal server error' : err.message,
    },
  };
  if (err.details) body.error.details = err.details;
  if (req.id) body.error.request_id = req.id;

  if (status >= 500) {
    (req.log ? req.log.error.bind(req.log) : console.error)({ err }, 'Unhandled error');
  }
  res.status(status).json(body);
}

module.exports = { ApiError, asyncHandler, errorHandler, notFoundHandler };
