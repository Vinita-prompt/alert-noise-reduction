const buckets = new Map();

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function createRateLimiter({
  windowMs = positiveInteger(process.env.API_RATE_LIMIT_WINDOW_MS, 60_000),
  max = positiveInteger(process.env.API_RATE_LIMIT_MAX, 3_000),
} = {}) {
  return (request, response, next) => {
    const now = Date.now();
    if (buckets.size > 10_000) {
      for (const [storedKey, stored] of buckets) {
        if (stored.resetAt <= now) buckets.delete(storedKey);
      }
    }
    const key = request.ip || request.socket?.remoteAddress || 'unknown';
    const current = buckets.get(key);
    const bucket = !current || current.resetAt <= now
      ? { count: 0, resetAt: now + windowMs }
      : current;
    bucket.count += 1;
    buckets.set(key, bucket);
    response.set('RateLimit-Limit', String(max));
    response.set('RateLimit-Remaining', String(Math.max(0, max - bucket.count)));
    response.set('RateLimit-Reset', String(Math.ceil(bucket.resetAt / 1000)));
    if (bucket.count > max) {
      response.status(429).json({
        code: 'RATE_LIMIT_EXCEEDED',
        message: 'Too many requests. Try again shortly.',
        success: false,
      });
      return;
    }
    next();
  };
}

module.exports = { createRateLimiter };
