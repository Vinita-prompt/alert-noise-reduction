const crypto = require('crypto');

const REDACTED = '[REDACTED]';
const SENSITIVE_KEY = /authorization|cookie|password|secret|token|api[_-]?key|credential|session/i;

function sanitize(value, depth = 0) {
  if (depth > 6) return '[MAX_DEPTH]';
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => sanitize(item, depth + 1));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    SENSITIVE_KEY.test(key) ? REDACTED : sanitize(item, depth + 1),
  ]));
}

function write(level, event, fields = {}) {
  const record = sanitize({
    timestamp: new Date().toISOString(),
    level,
    event,
    ...fields,
  });
  const target = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  target(JSON.stringify(record));
}

function requestId(request) {
  const supplied = String(request.get('X-Request-Id') || '').trim();
  return /^[A-Za-z0-9._:-]{8,128}$/.test(supplied) ? supplied : crypto.randomUUID();
}

function requestLoggingMiddleware(request, response, next) {
  const startedAt = Date.now();
  request.requestId = requestId(request);
  response.set('X-Request-Id', request.requestId);
  response.once('finish', () => {
    write(response.statusCode >= 500 ? 'error' : response.statusCode >= 400 ? 'warn' : 'info', 'http_request', {
      requestId: request.requestId,
      method: request.method,
      path: request.originalUrl.split('?')[0],
      status: response.statusCode,
      durationMs: Date.now() - startedAt,
    });
  });
  next();
}

module.exports = { REDACTED, requestLoggingMiddleware, sanitize, write };
