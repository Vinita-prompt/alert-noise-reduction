const crypto = require('node:crypto');
const { service: authAccountService } = require('./authAccount.service');

const DEFAULT_COOKIE_NAME = 'anr_dev_session';
const DEFAULT_SESSION_TTL_SECONDS = 8 * 60 * 60;
const MAX_LOGIN_FAILURES = 5;
const LOGIN_FAILURE_WINDOW_MS = 15 * 60 * 1000;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function authError(message, code, status, safeDetails) {
  const result = new Error(message);
  result.code = code;
  result.status = status;
  result.safeMessage = message;
  if (safeDetails) result.safeDetails = safeDetails;
  return result;
}

function toBase64Url(value) {
  return Buffer.from(value).toString('base64url');
}

function fromBase64Url(value) {
  return Buffer.from(value, 'base64url').toString('utf8');
}

function safeArray(value) {
  return Array.isArray(value)
    ? [...new Set(value.map((item) => String(item || '').trim().toLowerCase()).filter(Boolean))]
    : [];
}

function parseCookies(header = '') {
  return String(header).split(';').reduce((result, item) => {
    const separator = item.indexOf('=');
    if (separator < 1) return result;
    const key = item.slice(0, separator).trim();
    const value = item.slice(separator + 1).trim();
    if (key) result[key] = decodeURIComponent(value);
    return result;
  }, {});
}

function hashDevelopmentPassword(password, salt = crypto.randomBytes(16)) {
  const normalized = String(password || '');
  if (normalized.length < 12) {
    throw authError('Development authentication passwords must contain at least 12 characters.', 'AUTH_PASSWORD_TOO_SHORT', 400);
  }
  const derived = crypto.scryptSync(normalized, salt, 64);
  return `scrypt$${Buffer.from(salt).toString('base64url')}$${derived.toString('base64url')}`;
}

function verifyDevelopmentPassword(password, encodedHash) {
  const [algorithm, saltValue, expectedValue] = String(encodedHash || '').split('$');
  if (algorithm !== 'scrypt' || !saltValue || !expectedValue) return false;
  try {
    const expected = Buffer.from(expectedValue, 'base64url');
    const actual = crypto.scryptSync(String(password || ''), Buffer.from(saltValue, 'base64url'), expected.length);
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

function publicUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    roles: [...user.roles],
    permissions: [...user.permissions],
  };
}

function parseDevelopmentUsers(value) {
  if (!String(value || '').trim()) return [];
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const seenIds = new Set();
  const seenEmails = new Set();
  return parsed.flatMap((item) => {
    const id = String(item?.id || '').trim();
    const name = String(item?.name || item?.displayName || '').trim();
    const email = String(item?.email || '').trim().toLowerCase();
    const passwordHash = String(item?.passwordHash || '').trim();
    if (!id || !name || !EMAIL_PATTERN.test(email) || !passwordHash.startsWith('scrypt$')) return [];
    if (seenIds.has(id) || seenEmails.has(email)) return [];
    seenIds.add(id); seenEmails.add(email);
    return [{
      id,
      name,
      email,
      passwordHash,
      roles: safeArray(item.roles),
      permissions: safeArray(item.permissions),
    }];
  });
}

function isLoopbackRequest(request) {
  const hostname = String(request.hostname || request.socket?.localAddress || '').replace(/^::ffff:/, '').toLowerCase();
  return ['127.0.0.1', '::1', 'localhost'].includes(hostname);
}

function createAuthenticationService({ accountStore = authAccountService, env = process.env, now = () => Date.now() } = {}) {
  const cookieName = String(env.AUTH_DEVELOPMENT_COOKIE_NAME || DEFAULT_COOKIE_NAME).trim();
  const enabledFlag = String(env.AUTH_DEVELOPMENT_ENABLED || '').toLowerCase() === 'true';
  const production = String(env.NODE_ENV || '').toLowerCase() === 'production';
  const secret = String(env.AUTH_DEVELOPMENT_SESSION_SECRET || '');
  const users = parseDevelopmentUsers(env.AUTH_DEVELOPMENT_USERS_JSON);
  const requestedTtl = Number(env.AUTH_DEVELOPMENT_SESSION_TTL_SECONDS || DEFAULT_SESSION_TTL_SECONDS);
  const ttlSeconds = Math.min(
    24 * 60 * 60,
    Math.max(15 * 60, Number.isFinite(requestedTtl) ? requestedTtl : DEFAULT_SESSION_TTL_SECONDS),
  );
  const failedLogins = new Map();

  function configuration() {
    if (production && enabledFlag) {
      return { available: false, code: 'DEVELOPMENT_AUTH_DISABLED_IN_PRODUCTION', reason: 'Development authentication is disabled in production.' };
    }
    if (!enabledFlag) {
      return { available: false, code: 'AUTHENTICATION_NOT_CONFIGURED', reason: 'No application authentication provider is configured.' };
    }
    if (secret.length < 32) {
      return { available: false, code: 'AUTH_SESSION_SECRET_MISSING', reason: 'Development authentication requires a 32+ character session secret.' };
    }
    return { available: true, code: 'DEVELOPMENT_AUTH_AVAILABLE', reason: null };
  }

  function sign(payload) {
    const body = toBase64Url(JSON.stringify(payload));
    const signature = crypto.createHmac('sha256', secret).update(body).digest('base64url');
    return `${body}.${signature}`;
  }

  function verify(token) {
    const [body, signature] = String(token || '').split('.');
    if (!body || !signature || configuration().available !== true) return null;
    const expected = crypto.createHmac('sha256', secret).update(body).digest();
    let received;
    try { received = Buffer.from(signature, 'base64url'); } catch { return null; }
    if (received.length !== expected.length || !crypto.timingSafeEqual(received, expected)) return null;
    let payload;
    try { payload = JSON.parse(fromBase64Url(body)); } catch { return null; }
    if (!payload?.sub || !payload.csrf || !payload.exp || Number(payload.exp) <= Math.floor(now() / 1000)) return null;
    return payload;
  }

  function cookie(value, { clear = false } = {}) {
    const attributes = [
      `${cookieName}=${encodeURIComponent(value)}`,
      'HttpOnly',
      'Path=/',
      'SameSite=Lax',
      clear ? 'Max-Age=0' : `Max-Age=${ttlSeconds}`,
    ];
    if (production) attributes.push('Secure');
    return attributes.join('; ');
  }

  function middleware(request, response, next) {
    try {
      const configured = configuration();
      const sessionToken = parseCookies(request.headers?.cookie || '')[cookieName] || null;
      const payload = configured.available && isLoopbackRequest(request) ? verify(sessionToken) : null;

      const finish = (user) => {
        const validSession = Boolean(payload && user);
        request.auth = {
          configured,
          method: validSession ? 'development_local_session' : null,
          session: validSession
            ? { csrfToken: payload.csrf, expiresAt: new Date(Number(payload.exp) * 1000).toISOString() }
            : null,
          sessionExpired: Boolean(configured.available && sessionToken && !validSession),
          user: validSession ? publicUser(user) : null,
          verified: validSession,
        };
        next();
      };

      if (!payload) {
        finish(null);
        return;
      }

      if (payload.src === 'database') {
        Promise.resolve(accountStore.findById(payload.sub))
          .then(finish)
          .catch(() => next(authError(
            'Backend connection failed. Account storage is unavailable.',
            'AUTH_DATABASE_UNAVAILABLE',
            503,
          )));
        return;
      }

      finish(users.find((candidate) => candidate.id === payload.sub) || null);
    } catch (error) {
      next(error);
    }
  }

  function getCurrentUser(request) {
    if (!request.auth?.verified || !request.auth.user) {
      const configured = request.auth?.configured || configuration();
      if (request.auth?.sessionExpired) {
        throw authError('Session expired.', 'AUTH_SESSION_EXPIRED', 401, {
          loginAvailable: Boolean(configured.available),
          reason: 'Sign in again to continue.',
        });
      }
      throw authError(
        configured.available ? 'Authentication is required.' : 'Outcome capture is unavailable because application authentication is not configured.',
        'AUTHENTICATION_REQUIRED',
        401,
        { loginAvailable: Boolean(configured.available), reason: configured.reason || 'Sign in to continue.' },
      );
    }
    return {
      authenticated: true,
      csrfToken: request.auth.session.csrfToken,
      expiresAt: request.auth.session.expiresAt,
      method: request.auth.method,
      user: request.auth.user,
    };
  }

  async function login(request, response) {
    const configured = configuration();
    if (!configured.available || !isLoopbackRequest(request)) {
      throw authError(configured.reason || 'Development authentication is available only on localhost.', configured.code, 503, {
        loginAvailable: false,
        reason: configured.reason || 'Development authentication is available only on localhost.',
      });
    }
    const email = String(request.body?.email || '').trim().toLowerCase();
    const password = String(request.body?.password || '');
    const failureKey = `${request.ip || request.socket?.remoteAddress || 'local'}:${email}`;
    const failure = failedLogins.get(failureKey);
    if (failure && failure.expiresAt > now() && failure.count >= MAX_LOGIN_FAILURES) {
      throw authError('Too many failed sign-in attempts. Try again later.', 'AUTH_RATE_LIMITED', 429);
    }
    let source = 'database';
    let user;
    try {
      user = await accountStore.findByEmail(email);
    } catch {
      throw authError(
        'Backend connection failed. Account storage is unavailable.',
        'AUTH_DATABASE_UNAVAILABLE',
        503,
      );
    }
    if (!user) {
      source = 'environment';
      user = users.find((candidate) => candidate.email === email);
    }
    if (!user) {
      const current = failure && failure.expiresAt > now() ? failure.count : 0;
      failedLogins.set(failureKey, { count: current + 1, expiresAt: now() + LOGIN_FAILURE_WINDOW_MS });
      throw authError('Account not found.', 'AUTH_ACCOUNT_NOT_FOUND', 401);
    }
    if (!verifyDevelopmentPassword(password, user.passwordHash)) {
      const current = failure && failure.expiresAt > now() ? failure.count : 0;
      failedLogins.set(failureKey, { count: current + 1, expiresAt: now() + LOGIN_FAILURE_WINDOW_MS });
      throw authError('Invalid email or password.', 'AUTHENTICATION_FAILED', 401);
    }
    failedLogins.delete(failureKey);
    const issuedAt = Math.floor(now() / 1000);
    const csrfToken = crypto.randomBytes(24).toString('base64url');
    const token = sign({ csrf: csrfToken, exp: issuedAt + ttlSeconds, iat: issuedAt, jti: crypto.randomUUID(), src: source, sub: user.id });
    response.setHeader('Set-Cookie', cookie(token));
    return {
      authenticated: true,
      csrfToken,
      expiresAt: new Date((issuedAt + ttlSeconds) * 1000).toISOString(),
      method: 'development_local_session',
      user: publicUser(user),
    };
  }

  async function signup(request) {
    const configured = configuration();
    if (!configured.available || !isLoopbackRequest(request)) {
      throw authError(configured.reason || 'Account creation is available only on localhost.', configured.code, 503, {
        signupAvailable: false,
        reason: configured.reason || 'Account creation is available only on localhost.',
      });
    }

    const name = String(request.body?.name || '').trim();
    const email = String(request.body?.email || '').trim().toLowerCase();
    const password = String(request.body?.password || '');
    const confirmPassword = String(request.body?.confirmPassword || '');

    if (name.length < 2 || name.length > 120) {
      throw authError('Enter your full name.', 'AUTH_NAME_INVALID', 400);
    }
    if (!EMAIL_PATTERN.test(email) || email.length > 254) {
      throw authError('Enter a valid company email address.', 'AUTH_EMAIL_INVALID', 400);
    }
    if (password !== confirmPassword) {
      throw authError('Passwords do not match.', 'AUTH_PASSWORD_MISMATCH', 400);
    }

    const passwordHash = hashDevelopmentPassword(password);
    try {
      if (await accountStore.findByEmail(email)) {
        throw authError('An account already exists for this email. Please log in.', 'AUTH_ACCOUNT_EXISTS', 409);
      }
      const user = await accountStore.create({ email, name, passwordHash });
      return {
        created: true,
        redirect: '/login',
        user: publicUser(user),
      };
    } catch (error) {
      if (error?.code === 'AUTH_ACCOUNT_EXISTS' || error?.code === '23505') {
        throw authError('An account already exists for this email. Please log in.', 'AUTH_ACCOUNT_EXISTS', 409);
      }
      throw authError(
        'Backend connection failed. Account storage is unavailable.',
        'AUTH_DATABASE_UNAVAILABLE',
        503,
      );
    }
  }

  function logout(request, response) {
    response.setHeader('Set-Cookie', cookie('', { clear: true }));
    return { authenticated: false };
  }

  function requireCsrf(request, response, next) {
    try {
      const expected = String(request.auth?.session?.csrfToken || '');
      const received = String(request.get?.('X-CSRF-Token') || request.headers?.['x-csrf-token'] || '');
      if (!request.auth?.verified || !expected || !received || expected.length !== received.length
        || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(received))) {
        throw authError('The authenticated session could not validate this write request.', 'CSRF_VALIDATION_FAILED', 403);
      }
      next();
    } catch (requestError) {
      next(requestError);
    }
  }

  function requireAuthenticated(request, response, next) {
    if (!request.auth?.verified || !request.auth.user) {
      next(request.auth?.sessionExpired
        ? authError('Session expired.', 'AUTH_SESSION_EXPIRED', 401)
        : authError('Authentication is required.', 'AUTHENTICATION_REQUIRED', 401));
      return;
    }
    next();
  }

  function requireAdministrator(request, response, next) {
    const roles = safeArray(request.auth?.user?.roles);
    if (!request.auth?.verified || !request.auth.user) {
      next(request.auth?.sessionExpired
        ? authError('Session expired.', 'AUTH_SESSION_EXPIRED', 401)
        : authError('Authentication is required.', 'AUTHENTICATION_REQUIRED', 401));
      return;
    }
    if (!roles.some((role) => ['admin', 'administrator'].includes(role))) {
      next(authError('Administrator access is required.', 'ADMINISTRATOR_REQUIRED', 403));
      return;
    }
    next();
  }

  return {
    configuration,
    getCurrentUser,
    login,
    logout,
    middleware,
    requireCsrf,
    requireAuthenticated,
    requireAdministrator,
    signup,
    verify,
  };
}

module.exports = {
  createAuthenticationService,
  hashDevelopmentPassword,
  parseDevelopmentUsers,
  service: createAuthenticationService(),
  verifyDevelopmentPassword,
};
