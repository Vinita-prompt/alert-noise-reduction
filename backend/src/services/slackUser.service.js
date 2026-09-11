const integrationService = require('./integration.service');

const SLACK_API_BASE_URL = 'https://slack.com/api/';
const SLACK_USER_TIMEOUT_MS = Number(process.env.SLACK_USER_TIMEOUT_MS || 8000);
const SLACK_USER_CACHE_TTL_MS = Number(process.env.SLACK_USER_CACHE_TTL_MS || 60 * 60 * 1000);

let cachedUsers = new Map();
let cachedUserObjects = new Map();
let lastLoadedAt = 0;
let cacheBuildPromise = null;
let refreshTimerStarted = false;
let lastLoggedErrorAt = 0;
let lookupUnavailableUntil = 0;

function safeLogSlackUserError(message, error) {
  const now = Date.now();

  if (now - lastLoggedErrorAt < 60 * 1000) {
    return;
  }

  lastLoggedErrorAt = now;
  console.warn(message, {
    error: error.message,
    status: error.status || null,
    slackError: error.slackError || null,
  });
}

function isSlackUserId(value) {
  return /^[UW][A-Z0-9]{4,}$/i.test(String(value || '').trim());
}

function normalizeSlackUserId(value) {
  const text = String(value || '').trim().replace(/^@+/, '');
  const mention = text.match(/^<@([A-Z0-9]+)(?:\|[^>]+)?>$/i);
  const id = mention?.[1] || text;

  return isSlackUserId(id) ? id.toUpperCase() : null;
}

function parseManualUserMap() {
  const value = process.env.SLACK_USER_MAP;

  if (!value) {
    return {};
  }

  try {
    const parsed = JSON.parse(value);

    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch (error) {
    // Fall through to comma-separated parsing.
  }

  return String(value)
    .split(',')
    .map((entry) => entry.split('='))
    .reduce((mapping, [key, name]) => {
      const userId = normalizeSlackUserId(key);
      const displayName = String(name || '').trim();

      if (userId && displayName) {
        mapping[userId] = displayName;
      }

      return mapping;
    }, {});
}

function getManualDisplayName(userId) {
  const manualMap = parseManualUserMap();

  return manualMap[userId] || null;
}

function getDisplayName(userObject = {}) {
  const profile = userObject.profile || {};

  return [
    profile.display_name,
    profile.display_name_normalized,
    profile.real_name,
    profile.real_name_normalized,
    userObject.real_name,
    userObject.name,
  ]
    .map((value) => String(value || '').trim())
    .find(Boolean) || null;
}

function buildSlackApiUrl(path, params = {}) {
  const url = new URL(path, SLACK_API_BASE_URL);

  Object.entries(params).forEach(([key, value]) => {
    if (value !== null && value !== undefined && value !== '') {
      url.searchParams.set(key, value);
    }
  });

  return url.toString();
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), SLACK_USER_TIMEOUT_MS);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

async function getSlackToken() {
  if (process.env.SLACK_BOT_TOKEN?.trim()) {
    return process.env.SLACK_BOT_TOKEN.trim();
  }

  try {
    const config = await integrationService.getSlackRuntimeConfig();
    return config.botToken;
  } catch (error) {
    return null;
  }
}

async function slackApiGet(path, params = {}) {
  const token = await getSlackToken();

  if (!token) {
    const error = new Error('Slack bot token is not configured for user lookup.');
    error.status = 400;
    throw error;
  }

  const response = await fetchWithTimeout(buildSlackApiUrl(path, params), {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
    },
  });
  const payload = await response.json().catch(() => ({}));

  if (response.status === 429) {
    const retryAfter = Number(response.headers.get('retry-after') || 1);
    await new Promise((resolve) => setTimeout(resolve, Math.min(retryAfter, 30) * 1000));
    return slackApiGet(path, params);
  }

  if (!response.ok || !payload.ok) {
    const error = new Error(payload.error || `Slack API returned HTTP ${response.status}`);
    error.status = response.status || 502;
    error.slackError = payload.error || null;
    throw error;
  }

  return payload;
}

function applyManualUserMap(userMap = new Map()) {
  const manualMap = parseManualUserMap();

  Object.entries(manualMap).forEach(([userId, displayName]) => {
    userMap.set(userId, displayName);
  });

  return userMap;
}

async function buildSlackUserMap(options = {}) {
  const force = options.force === true;
  const now = Date.now();

  if (!force && cachedUsers.size > 0 && now - lastLoadedAt < SLACK_USER_CACHE_TTL_MS) {
    return Object.fromEntries(cachedUsers);
  }

  if (cacheBuildPromise) {
    return cacheBuildPromise;
  }

  cacheBuildPromise = (async () => {
    const nextUsers = applyManualUserMap(new Map());
    const nextUserObjects = new Map(cachedUserObjects);
    let cursor = null;

    try {
      do {
        const payload = await slackApiGet('users.list', {
          limit: 200,
          cursor,
        });

        (payload.members || []).forEach((user) => {
          if (!user?.id) {
            return;
          }

          const displayName = getDisplayName(user);

          if (displayName) {
            nextUsers.set(user.id, displayName);
          }

          nextUserObjects.set(user.id, user);
        });

        cursor = payload.response_metadata?.next_cursor || null;
      } while (cursor);

      cachedUsers = nextUsers;
      cachedUserObjects = nextUserObjects;
      lastLoadedAt = Date.now();
      return Object.fromEntries(cachedUsers);
    } catch (error) {
      applyManualUserMap(cachedUsers);
      lookupUnavailableUntil = Date.now() + 60 * 1000;
      safeLogSlackUserError('Slack user cache refresh failed; falling back to existing IDs/cache.', error);
      return Object.fromEntries(cachedUsers);
    } finally {
      cacheBuildPromise = null;
    }
  })();

  return cacheBuildPromise;
}

async function fetchSlackUserInfo(userId) {
  const payload = await slackApiGet('users.info', {
    user: userId,
  });
  const user = payload.user || {};
  const displayName = getDisplayName(user) || userId;

  cachedUsers.set(userId, displayName);
  cachedUserObjects.set(userId, user);
  lastLoadedAt = lastLoadedAt || Date.now();

  return {
    id: userId,
    name: displayName,
    email: user.profile?.email || null,
    raw: user,
  };
}

async function resolveSlackUser(userId) {
  const normalizedUserId = normalizeSlackUserId(userId);

  if (!normalizedUserId) {
    const fallback = String(userId || '').trim() || null;

    return {
      id: fallback,
      name: fallback,
      email: null,
      source: 'raw_value',
      raw: null,
    };
  }

  const manualName = getManualDisplayName(normalizedUserId);

  if (manualName) {
    return {
      id: normalizedUserId,
      name: manualName,
      email: null,
      source: 'manual_map',
      raw: cachedUserObjects.get(normalizedUserId) || null,
    };
  }

  if (cachedUsers.has(normalizedUserId)) {
    return {
      id: normalizedUserId,
      name: cachedUsers.get(normalizedUserId),
      email: cachedUserObjects.get(normalizedUserId)?.profile?.email || null,
      source: 'cache',
      raw: cachedUserObjects.get(normalizedUserId) || null,
    };
  }

  await buildSlackUserMap();

  if (cachedUsers.has(normalizedUserId)) {
    return {
      id: normalizedUserId,
      name: cachedUsers.get(normalizedUserId),
      email: cachedUserObjects.get(normalizedUserId)?.profile?.email || null,
      source: 'cache',
      raw: cachedUserObjects.get(normalizedUserId) || null,
    };
  }

  if (Date.now() < lookupUnavailableUntil) {
    return {
      id: normalizedUserId,
      name: normalizedUserId,
      email: null,
      source: 'fallback_cooldown',
      raw: null,
    };
  }

  try {
    return {
      ...(await fetchSlackUserInfo(normalizedUserId)),
      source: 'users.info',
    };
  } catch (error) {
    lookupUnavailableUntil = Date.now() + 60 * 1000;
    safeLogSlackUserError('Slack single-user lookup failed; falling back to raw Slack ID.', error);
    return {
      id: normalizedUserId,
      name: normalizedUserId,
      email: null,
      source: 'fallback',
      raw: null,
    };
  }
}

async function resolveSlackUserName(userId) {
  const user = await resolveSlackUser(userId);

  return user.name || user.id || String(userId || '').trim() || null;
}

async function resolveResponder(responder = {}) {
  if (!responder) {
    return null;
  }

  const value = typeof responder === 'string'
    ? { id: responder, name: responder }
    : responder;
  const rawUserId = normalizeSlackUserId(
    value.slackUserId
    || value.slack_user_id
    || value.responderUserId
    || value.responder_user_id
    || value.id
    || value.name
    || value.displayName
  );

  if (!rawUserId) {
    const displayName = value.displayName || value.responderName || value.name || value.id || null;

    return displayName ? {
      ...value,
      name: displayName,
      displayName,
      responderName: displayName,
      responder_name: displayName,
      responderUserId: value.responderUserId || value.responder_user_id || null,
      responder_user_id: value.responder_user_id || value.responderUserId || null,
    } : null;
  }

  const resolvedUser = await resolveSlackUser(rawUserId);
  const displayName = resolvedUser.name || rawUserId;

  return {
    ...value,
    id: rawUserId,
    slackUserId: rawUserId,
    slack_user_id: rawUserId,
    responderUserId: rawUserId,
    responder_user_id: rawUserId,
    name: displayName,
    displayName,
    responderName: displayName,
    responder_name: displayName,
    email: resolvedUser.email || value.email || null,
    slackUserLookupSource: resolvedUser.source,
    needsNameMapping: displayName === rawUserId,
  };
}

async function resolveResponders(responders = []) {
  if (!Array.isArray(responders) || responders.length === 0) {
    return [];
  }

  const resolved = await Promise.all(responders.map((responder) => resolveResponder(responder)));
  const seen = new Set();

  return resolved.filter((responder) => {
    if (!responder) {
      return false;
    }

    const key = String(
      responder.slackUserId
      || responder.responderUserId
      || responder.id
      || responder.displayName
      || responder.name
      || ''
    ).toLowerCase();

    if (!key || seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

function startSlackUserCacheRefresh() {
  if (refreshTimerStarted) {
    return;
  }

  refreshTimerStarted = true;
  setInterval(() => {
    buildSlackUserMap({ force: true }).catch((error) => {
      safeLogSlackUserError('Scheduled Slack user cache refresh failed.', error);
    });
  }, SLACK_USER_CACHE_TTL_MS).unref();
}

module.exports = {
  buildSlackUserMap,
  getDisplayName,
  isSlackUserId,
  normalizeSlackUserId,
  resolveResponder,
  resolveResponders,
  resolveSlackUser,
  resolveSlackUserName,
  startSlackUserCacheRefresh,
};
