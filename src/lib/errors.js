'use strict';
class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message || code);
    this.status = status;
    this.code = code;
    this.details = details;
    this.expose = true;
  }
}
const E = {
  bad: (m, d) => new ApiError(400, 'VALIDATION', m, d),
  unauth: (m = 'Authentication required') => new ApiError(401, 'UNAUTHENTICATED', m),
  forbidden: (m = 'Not allowed', code = 'FORBIDDEN') => new ApiError(403, code, m),
  notFound: (what = 'Resource') => new ApiError(404, 'NOT_FOUND', what + ' not found'),
  conflict: (m, code = 'CONFLICT', d) => new ApiError(409, code, m, d),
  unprocessable: (code, m, d) => new ApiError(422, code, m, d),
  tooMany: (m = 'Too many requests', retryAfter) => { const e = new ApiError(429, 'RATE_LIMITED', m); e.retryAfter = retryAfter; return e; },
  payment: (m, code = 'PAYMENT_REQUIRED') => new ApiError(402, code, m),
  upstream: (m, d) => new ApiError(502, 'UPSTREAM_ERROR', m, d),
};
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
module.exports = { ApiError, E, wrap };
