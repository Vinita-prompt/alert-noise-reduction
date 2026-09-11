const DEFAULT_TIMEOUT_MS = 12000;
const MAX_ACCOUNT_GROUPS = 25;
const MAX_ALERT_RECORDS = 100;
const MAX_HISTORY_RECORDS = 5;

function normalizeBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function getApiVersion(baseUrl) {
  if (!baseUrl) return null;

  try {
    const url = new URL(baseUrl);
    const match = url.pathname.match(/(?:^|\/)v(6|7)(?:\/|$)/i);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

function readSecondaryEnvironment(env = process.env) {
  return {
    baseUrl: normalizeBaseUrl(env.THOUSANDEYES_LEGACY_BASE_URL),
    username: String(env.THOUSANDEYES_LEGACY_USERNAME || '').trim(),
    apiToken: String(env.THOUSANDEYES_LEGACY_API_TOKEN || '').trim(),
  };
}

function classifyConfiguration(config) {
  const version = getApiVersion(config.baseUrl);
  const baseUrlConfigured = Boolean(config.baseUrl);
  const usernameConfigured = Boolean(config.username);
  const apiTokenConfigured = Boolean(config.apiToken);
  const missing = [];

  if (!baseUrlConfigured) missing.push('THOUSANDEYES_LEGACY_BASE_URL');
  if (!usernameConfigured) missing.push('THOUSANDEYES_LEGACY_USERNAME');
  if (!apiTokenConfigured) missing.push('THOUSANDEYES_LEGACY_API_TOKEN');

  let credentialType = 'unknown';
  let compatibleApi = 'unknown';
  let ready = false;
  let reason = null;

  if (missing.length > 0) {
    reason = 'Secondary ThousandEyes diagnostic configuration is incomplete.';
  } else if (version === 6) {
    credentialType = 'legacy_basic_username_api_token';
    compatibleApi = 'ThousandEyes v6';
    ready = true;
  } else if (version === 7) {
    reason = 'The isolated legacy client cannot send Basic authentication to ThousandEyes v7.';
  } else {
    reason = 'The legacy base URL must explicitly identify the documented ThousandEyes v6 API.';
  }

  return {
    configured: missing.length === 0,
    ready,
    credentialType,
    compatibleApi,
    apiVersion: version,
    baseUrlConfigured,
    usernameConfigured,
    apiTokenConfigured,
    missing,
    reason,
  };
}

function getConfigurationStatus(env = process.env) {
  return classifyConfiguration(readSecondaryEnvironment(env));
}

function buildEndpoint(baseUrl, path, params = {}) {
  const url = new URL(String(path || '').replace(/^\/+/, ''), `${baseUrl}/`);

  Object.entries(params).forEach(([key, value]) => {
    if (value !== null && value !== undefined && value !== '') {
      url.searchParams.set(key, String(value));
    }
  });

  return url.toString();
}

function buildAuthorization(config, status) {
  if (status.credentialType === 'legacy_basic_username_api_token') {
    return `Basic ${Buffer.from(`${config.username}:${config.apiToken}`).toString('base64')}`;
  }

  throw new Error('Secondary ThousandEyes authentication type is not safely identifiable.');
}

function safeVendorError(httpStatus) {
  if (httpStatus === 401) return 'ThousandEyes rejected the legacy Basic credential.';
  if (httpStatus === 403) return 'ThousandEyes understood the legacy request but access to this resource is forbidden.';
  if (httpStatus === 404) return 'The configured secondary ThousandEyes API endpoint was not found.';
  if (httpStatus === 429) return 'The ThousandEyes API rate limit was reached.';
  return `The secondary ThousandEyes read request returned HTTP ${httpStatus}.`;
}

function legacyAccessForStatus(httpStatus) {
  if (httpStatus === 401) return 'authentication_rejected';
  if (httpStatus === 403) return 'forbidden';
  if (httpStatus >= 200 && httpStatus < 300) return 'allowed';
  if (httpStatus) return 'denied';
  return 'unreachable';
}

function createRequestError(message, httpStatus = null) {
  const error = new Error(message);
  error.httpStatus = httpStatus;
  error.legacyReachable = Number.isInteger(httpStatus);
  error.legacyAccess = legacyAccessForStatus(httpStatus);
  return error;
}

function toArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value.filter(Boolean) : [value];
}

function extractAlerts(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.alerts)) return payload.alerts;
  if (Array.isArray(payload?.alert)) return payload.alert;
  return [];
}

function isActiveAlert(alert) {
  const active = alert?.active;
  const state = String(alert?.alertState || alert?.state || '').toLowerCase();
  return active === 1 || active === true || state === 'active' || state === 'trigger' || state === 'triggered';
}

function isClearedAlert(alert) {
  const active = alert?.active;
  const state = String(alert?.alertState || alert?.state || '').toLowerCase();
  return active === 0 || active === false || state === 'clear' || state === 'cleared' || state === 'resolved';
}

function safeAccountGroup(alert) {
  return alert?.accountGroup?.name
    || alert?.accountGroupName
    || alert?.accountGroupId
    || alert?.aid
    || null;
}

function normalizeSafeAlert(alert) {
  const agents = toArray(alert?.agents || alert?.details);

  return {
    id: alert?.alertId || alert?.id || null,
    name: alert?.alertName || alert?.ruleName || alert?.name || alert?.rule?.name || null,
    test: alert?.testName || alert?.test?.name || null,
    state: isActiveAlert(alert) ? 'active' : isClearedAlert(alert) ? 'clear' : String(alert?.alertState || alert?.state || 'unknown'),
    startTime: alert?.dateStart || alert?.startDate || null,
    agentCount: agents.length || Number(alert?.violationCount || 0),
    accountGroup: safeAccountGroup(alert),
  };
}

function extractAccountGroups(payload) {
  const groups = payload?.accountGroups || payload?.accountGroup || payload?.groups || [];

  return toArray(groups).slice(0, MAX_ACCOUNT_GROUPS).map((group) => ({
    id: group?.aid || group?.accountGroupId || group?.id || null,
    name: group?.accountGroupName || group?.name || null,
    organizationName: group?.organizationName || group?.organization?.name || null,
  }));
}

function createLegacyBasicClient({ env = process.env, fetchImpl = global.fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const config = readSecondaryEnvironment(env);
  const status = classifyConfiguration(config);

  async function request(path, params = {}) {
    if (!status.ready) {
      throw createRequestError(status.reason || 'Secondary ThousandEyes configuration is not ready.');
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetchImpl(buildEndpoint(config.baseUrl, path, params), {
        method: 'GET',
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          Authorization: buildAuthorization(config, status),
        },
      });

      if (!response.ok) {
        throw createRequestError(safeVendorError(response.status), response.status);
      }

      let payload;
      try {
        payload = await response.json();
      } catch {
        throw createRequestError('The secondary ThousandEyes endpoint returned a non-JSON response.', response.status);
      }

      return { httpStatus: response.status, payload };
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw createRequestError('The secondary ThousandEyes read request timed out.');
      }
      if (Object.prototype.hasOwnProperty.call(error, 'httpStatus')) {
        throw error;
      }
      throw createRequestError('The legacy ThousandEyes API could not be reached.');
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async function testAuthentication() {
    const result = await request('/account-groups');
    return {
      httpStatus: result.httpStatus,
      accountGroups: extractAccountGroups(result.payload),
    };
  }

  async function fetchAlertInventory(params = {}) {
    const result = await request('/alerts', params);
    return {
      httpStatus: result.httpStatus,
      rawAlerts: extractAlerts(result.payload),
    };
  }

  function summarizeActiveAlerts(inventory) {
    const allAlerts = inventory.rawAlerts;
    const activeAlerts = status.apiVersion === 6
      ? allAlerts.filter(isActiveAlert)
      : allAlerts.filter((alert) => !isClearedAlert(alert));

    return {
      httpStatus: inventory.httpStatus,
      count: activeAlerts.length,
      alerts: activeAlerts.slice(0, MAX_ALERT_RECORDS).map(normalizeSafeAlert),
      bounded: true,
    };
  }

  async function getActiveAlerts() {
    return summarizeActiveAlerts(await fetchAlertInventory());
  }

  async function getHistoricalSample(previousInventory = null) {
    let allAlerts;
    let httpStatus;

    if (status.apiVersion === 6 && previousInventory) {
      allAlerts = previousInventory.rawAlerts;
      httpStatus = previousInventory.httpStatus;
    } else {
      const inventory = await fetchAlertInventory(status.apiVersion === 7 ? { state: 'clear', window: '7d' } : {});
      allAlerts = inventory.rawAlerts;
      httpStatus = inventory.httpStatus;
    }

    return {
      httpStatus,
      alerts: allAlerts.filter(isClearedAlert).slice(0, MAX_HISTORY_RECORDS).map(normalizeSafeAlert),
      bounded: true,
    };
  }

  async function runReadOnlyDiagnostic() {
    const safeConfiguration = getConfigurationStatus(env);

    if (!safeConfiguration.ready) {
      return {
        configuration: safeConfiguration,
        legacyConfigured: false,
        legacyReachable: false,
        legacyAuthAttempted: false,
        legacyHttpStatus: null,
        legacyAccess: 'not_tested',
        authentication: 'not_tested',
        httpStatus: null,
        accountGroups: [],
        activeAlertCount: null,
        activeAlerts: [],
        historicalAlerts: [],
        safeError: safeConfiguration.reason,
      };
    }

    try {
      const authentication = await testAuthentication();
      const inventory = await fetchAlertInventory();
      const active = summarizeActiveAlerts(inventory);
      const history = await getHistoricalSample(inventory);

      return {
        configuration: safeConfiguration,
        legacyConfigured: true,
        legacyReachable: true,
        legacyAuthAttempted: true,
        legacyHttpStatus: authentication.httpStatus,
        legacyAccess: 'allowed',
        authentication: 'success',
        httpStatus: authentication.httpStatus,
        accountGroups: authentication.accountGroups,
        activeAlertCount: active.count,
        activeAlerts: active.alerts,
        historicalAlerts: history.alerts,
        safeError: null,
      };
    } catch (error) {
      const legacyAccess = error.legacyAccess || legacyAccessForStatus(error.httpStatus);
      return {
        configuration: safeConfiguration,
        legacyConfigured: true,
        legacyReachable: Boolean(error.legacyReachable),
        legacyAuthAttempted: true,
        legacyHttpStatus: error.httpStatus || null,
        legacyAccess,
        authentication: legacyAccess === 'forbidden' ? 'access_forbidden' : 'failed',
        httpStatus: error.httpStatus || null,
        accountGroups: [],
        activeAlertCount: null,
        activeAlerts: [],
        historicalAlerts: [],
        safeError: error.message,
      };
    }
  }

  return {
    configuration: getConfigurationStatus(env),
    getActiveAlerts,
    getHistoricalSample,
    runReadOnlyDiagnostic,
    testAuthentication,
  };
}

module.exports = {
  classifyConfiguration,
  createLegacyBasicClient,
  getApiVersion,
  getConfigurationStatus,
  normalizeSafeAlert,
};
