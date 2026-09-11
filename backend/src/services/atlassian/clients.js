const DEFAULT_TIMEOUT_MS = 15000;

const JIRA_GATEWAY = 'https://api.atlassian.com/ex/jira';
const OPS_GATEWAY = 'https://api.atlassian.com/jsm/ops/api';

function stripTrailingSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}

function isEnabled(value) {
  return String(value || '').toLowerCase() === 'true';
}

function isOperationsWriteEnabled() {
  return process.env.ATLASSIAN_OPS_WRITE_ENABLED === 'true';
}

function envFlag(name) {
  return process.env[name] === undefined ? undefined : isEnabled(process.env[name]);
}

function buildGatewayConfig({
  cloudId,
  email,
  flags = {},
  initialSyncDays = 30,
  opsPollingEnabled = false,
  opsPollIntervalSeconds = 30,
  siteUrl = '',
  tokens = {},
}) {
  return {
    cloudId: cloudId || '',
    email: email || '',
    initialSyncDays: Math.max(Number(initialSyncDays || 30), 1),
    jiraGatewayBaseUrl: cloudId ? `${JIRA_GATEWAY}/${encodeURIComponent(cloudId)}` : '',
    opsGatewayBaseUrl: cloudId ? `${OPS_GATEWAY}/${encodeURIComponent(cloudId)}` : '',
    opsPollingEnabled: Boolean(opsPollingEnabled),
    opsPollIntervalSeconds: Math.max(Number(opsPollIntervalSeconds || 30), 5),
    siteUrl: stripTrailingSlash(siteUrl || ''),
    tokens: {
      jiraRead: tokens.jiraRead || '',
      jiraWrite: tokens.jiraWrite || '',
      operationsRead: tokens.operationsRead || '',
      operationsWrite: tokens.operationsWrite || '',
      jsmRead: tokens.jsmRead || '',
      jsmWrite: tokens.jsmWrite || '',
    },
    flags: {
      jiraWriteEnabled: Boolean(flags.jiraWriteEnabled),
      operationsWriteEnabled: Boolean(flags.operationsWriteEnabled),
      jsmWriteEnabled: Boolean(flags.jsmWriteEnabled),
    },
  };
}

function getConfig() {
  const cloudId = process.env.ATLASSIAN_CLOUD_ID || '';
  const email = process.env.ATLASSIAN_EMAIL || '';
  const siteUrl = stripTrailingSlash(process.env.ATLASSIAN_SITE_URL || '');

  return buildGatewayConfig({
    cloudId,
    email,
    initialSyncDays: process.env.ATLASSIAN_OPS_INITIAL_SYNC_DAYS || 30,
    opsPollingEnabled: isEnabled(process.env.ATLASSIAN_OPS_POLLING_ENABLED),
    opsPollIntervalSeconds: process.env.ATLASSIAN_OPS_POLL_INTERVAL_SECONDS || 30,
    siteUrl,
    tokens: {
      jiraRead: process.env.ATLASSIAN_JIRA_READ_TOKEN || '',
      jiraWrite: process.env.ATLASSIAN_JIRA_WRITE_TOKEN || '',
      operationsRead: process.env.ATLASSIAN_OPS_READ_TOKEN || '',
      operationsWrite: process.env.ATLASSIAN_OPS_WRITE_TOKEN || '',
      jsmRead: process.env.ATLASSIAN_JSM_READ_TOKEN || '',
      jsmWrite: process.env.ATLASSIAN_JSM_WRITE_TOKEN || '',
    },
    flags: {
      jiraWriteEnabled: isEnabled(process.env.ATLASSIAN_JIRA_WRITE_ENABLED),
      operationsWriteEnabled: isOperationsWriteEnabled(),
      jsmWriteEnabled: isEnabled(process.env.ATLASSIAN_JSM_WRITE_ENABLED),
    },
  });
}

async function getStoredAtlassianConfig() {
  try {
    const integrationService = require('../integration.service');
    const runtime = await integrationService.getIntegrationRuntimeConfig('atlassian');

    if (!runtime.isEnabled) {
      return null;
    }

    const credentials = runtime.credentials || {};

    return buildGatewayConfig({
      cloudId: runtime.accountIdentifier || credentials.cloudId || '',
      email: credentials.email || '',
      flags: {
        jiraWriteEnabled: isEnabled(credentials.jiraWriteEnabled),
        operationsWriteEnabled: isEnabled(credentials.operationsWriteEnabled),
        jsmWriteEnabled: isEnabled(credentials.jsmWriteEnabled),
      },
      initialSyncDays: credentials.opsInitialSyncDays || 30,
      opsPollingEnabled: isEnabled(credentials.opsPollingEnabled),
      opsPollIntervalSeconds: credentials.opsPollIntervalSeconds || 30,
      siteUrl: runtime.baseUrl || credentials.siteUrl || '',
      tokens: {
        jiraRead: credentials.jiraReadToken || '',
        jiraWrite: credentials.jiraWriteToken || '',
        operationsRead: credentials.opsReadToken || '',
        operationsWrite: credentials.opsWriteToken || '',
        jsmRead: credentials.jsmReadToken || '',
        jsmWrite: credentials.jsmWriteToken || '',
      },
    });
  } catch {
    return null;
  }
}

async function getConfigAsync() {
  const envConfig = getConfig();
  const storedConfig = await getStoredAtlassianConfig();

  if (!storedConfig) {
    return envConfig;
  }

  return buildGatewayConfig({
    cloudId: envConfig.cloudId || storedConfig.cloudId,
    email: envConfig.email || storedConfig.email,
    flags: {
      jiraWriteEnabled: envFlag('ATLASSIAN_JIRA_WRITE_ENABLED') ?? storedConfig.flags.jiraWriteEnabled,
      // Operations writes are intentionally fail-closed. Unlike the other
      // integrations, a database setting must never enable them when the
      // process environment does not contain the exact value "true".
      operationsWriteEnabled: isOperationsWriteEnabled(),
      jsmWriteEnabled: envFlag('ATLASSIAN_JSM_WRITE_ENABLED') ?? storedConfig.flags.jsmWriteEnabled,
    },
    initialSyncDays: process.env.ATLASSIAN_OPS_INITIAL_SYNC_DAYS || storedConfig.initialSyncDays,
    opsPollingEnabled: envFlag('ATLASSIAN_OPS_POLLING_ENABLED') ?? storedConfig.opsPollingEnabled,
    opsPollIntervalSeconds: process.env.ATLASSIAN_OPS_POLL_INTERVAL_SECONDS || storedConfig.opsPollIntervalSeconds,
    siteUrl: envConfig.siteUrl || storedConfig.siteUrl,
    tokens: {
      jiraRead: envConfig.tokens.jiraRead || storedConfig.tokens.jiraRead,
      jiraWrite: envConfig.tokens.jiraWrite || storedConfig.tokens.jiraWrite,
      operationsRead: envConfig.tokens.operationsRead || storedConfig.tokens.operationsRead,
      operationsWrite: envConfig.tokens.operationsWrite || storedConfig.tokens.operationsWrite,
      jsmRead: envConfig.tokens.jsmRead || storedConfig.tokens.jsmRead,
      jsmWrite: envConfig.tokens.jsmWrite || storedConfig.tokens.jsmWrite,
    },
  });
}

function sanitizeError(error) {
  return {
    code: error.code || (error.status ? `HTTP_${error.status}` : 'REQUEST_FAILED'),
    message: error.safeMessage || error.message || 'Atlassian request failed.',
    status: error.status || null,
  };
}

function getHttpErrorMessage(status, payload, label) {
  if (status === 401) return `${label} authentication failed. Check the configured token and Atlassian email.`;
  if (status === 403) return `${label} refused this request. The token may be missing scope or account permission.`;
  if (status === 404) return `${label} endpoint or object was not found. Check cloud ID, route, and permissions.`;
  if (status === 429) return `${label} rate limit reached. Retry after the returned Retry-After window.`;
  if (status >= 500) return `${label} returned a temporary server error.`;

  return payload?.message
    || payload?.error
    || payload?.errorMessage
    || payload?.errorMessages?.join(', ')
    || `${label} returned HTTP ${status}.`;
}

function makeBasicAuth(email, token) {
  return `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`;
}

function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function readJsonResponse(response, label) {
  const text = await response.text();

  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    const error = new Error(`${label} returned a non-JSON response. This can happen with invalid auth, an HTML login page, a proxy, or a permission redirect.`);
    error.status = response.status;
    error.code = 'INVALID_JSON_RESPONSE';
    error.safeMessage = error.message;
    throw error;
  }
}

function buildUrl(baseUrl, path, query = {}) {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const url = new URL(`${baseUrl}${normalizedPath}`);

  Object.entries(query).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') {
      return;
    }

    if (Array.isArray(value)) {
      value.forEach((item) => url.searchParams.append(key, String(item)));
      return;
    }

    url.searchParams.set(key, String(value));
  });

  return url.toString();
}

class AtlassianClient {
  constructor({ base, displayName, flagName = null, isWrite = false, key, tokenName }) {
    this.base = base;
    this.displayName = displayName;
    this.flagName = flagName;
    this.isWrite = isWrite;
    this.key = key;
    this.tokenName = tokenName;
  }

  getRuntimeConfig() {
    const config = getConfig();
    return this.buildRuntimeConfig(config);
  }

  async getRuntimeConfigAsync() {
    const config = await getConfigAsync();
    return this.buildRuntimeConfig(config);
  }

  buildRuntimeConfig(config) {
    const token = config.tokens[this.key] || '';
    const baseUrl = this.base === 'ops' ? config.opsGatewayBaseUrl : config.jiraGatewayBaseUrl;
    const enabled = this.flagName ? Boolean(config.flags[this.flagName]) : true;
    const missing = [];

    if (!config.email) missing.push('ATLASSIAN_EMAIL');
    if (!config.cloudId) missing.push('ATLASSIAN_CLOUD_ID');
    if (!token) missing.push(this.tokenName);

    return {
      ...config,
      baseUrl,
      enabled,
      missing,
      token,
    };
  }

  getStatus() {
    const config = this.getRuntimeConfig();
    return this.buildStatus(config);
  }

  async getStatusAsync() {
    const config = await this.getRuntimeConfigAsync();
    return this.buildStatus(config);
  }

  buildStatus(config) {
    return {
      configured: config.missing.length === 0,
      connected: false,
      connectionTested: false,
      enabled: this.isWrite ? config.enabled : true,
      error: config.missing.length > 0 ? `Missing ${config.missing.join(', ')}` : null,
      missingConfig: config.missing,
      readOnly: !this.isWrite,
      tokenName: this.tokenName,
      write: this.isWrite,
    };
  }

  assertConfigured(config = this.getRuntimeConfig()) {
    if (config.missing.length > 0) {
      const error = new Error(`${this.displayName} configuration is missing: ${config.missing.join(', ')}.`);
      error.status = 400;
      error.code = 'MISSING_CONFIGURATION';
      error.safeMessage = error.message;
      throw error;
    }

    if (this.isWrite && !config.enabled) {
      const disabledMessage = this.key === 'operationsWrite'
        ? 'Operations write actions are currently disabled.'
        : this.key === 'jiraWrite'
          ? 'Jira write actions are currently disabled.'
          : 'JSM request write actions are currently disabled.';
      const error = new Error(disabledMessage);
      error.status = 403;
      error.code = 'WRITE_INTEGRATION_DISABLED';
      error.safeMessage = disabledMessage;
      throw error;
    }
  }

  assertEnvironmentWriteEnabled() {
    if (this.key !== 'operationsWrite' || isOperationsWriteEnabled()) {
      return;
    }

    const error = new Error('Operations write actions are currently disabled.');
    error.status = 403;
    error.code = 'WRITE_INTEGRATION_DISABLED';
    error.safeMessage = error.message;
    throw error;
  }

  async request(path, options = {}) {
    // Check the process-level kill switch before consulting stored settings or
    // attempting any network request. This keeps a missing flag fail-closed.
    this.assertEnvironmentWriteEnabled();
    const config = await this.getRuntimeConfigAsync();

    this.assertConfigured(config);

    const method = options.method || 'GET';
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs || DEFAULT_TIMEOUT_MS);
    const url = buildUrl(config.baseUrl, path, options.query || {});
    const retryCount = options.retryCount || 0;

    console.log('Atlassian API request', {
      client: this.displayName,
      method,
      path,
    });

    try {
      const response = await fetch(url, {
        method,
        headers: {
          Accept: 'application/json',
          Authorization: makeBasicAuth(config.email, config.token),
          ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(options.headers || {}),
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal,
      });
      const payload = await readJsonResponse(response, this.displayName);

      console.log('Atlassian API response', {
        client: this.displayName,
        method,
        path,
        status: response.status,
      });

      if (!response.ok) {
        if (options.retry !== false && response.status === 429 && retryCount < 3) {
          const retryAfterSeconds = Number(response.headers.get('retry-after') || 0);
          const delayMs = retryAfterSeconds > 0 ? retryAfterSeconds * 1000 : (retryCount + 1) * 1500;

          await wait(delayMs);
          return this.request(path, { ...options, retryCount: retryCount + 1 });
        }

        if (options.retry !== false && response.status >= 500 && retryCount < 2) {
          await wait((retryCount + 1) * 1000);
          return this.request(path, { ...options, retryCount: retryCount + 1 });
        }

        const error = new Error(getHttpErrorMessage(response.status, payload, this.displayName));
        error.status = response.status;
        error.code = `HTTP_${response.status}`;
        error.safeMessage = error.message;
        throw error;
      }

      return {
        body: payload,
        headers: response.headers,
        status: response.status,
      };
    } catch (error) {
      if (error.name === 'AbortError') {
        const timeoutError = new Error(`${this.displayName} request timed out.`);
        timeoutError.status = 504;
        timeoutError.code = 'REQUEST_TIMEOUT';
        timeoutError.safeMessage = timeoutError.message;
        throw timeoutError;
      }

      if (error.status || error.code) {
        throw error;
      }

      const networkError = new Error(`Unable to reach ${this.displayName}. ${error.message}`);
      networkError.status = 502;
      networkError.code = 'NETWORK_OR_TLS_FAILURE';
      networkError.safeMessage = networkError.message;
      throw networkError;
    } finally {
      clearTimeout(timeout);
    }
  }
}

const jiraReadClient = new AtlassianClient({
  base: 'jira',
  displayName: 'Jira Read API',
  key: 'jiraRead',
  tokenName: 'ATLASSIAN_JIRA_READ_TOKEN',
});

const jiraWriteClient = new AtlassianClient({
  base: 'jira',
  displayName: 'Jira Write API',
  flagName: 'jiraWriteEnabled',
  isWrite: true,
  key: 'jiraWrite',
  tokenName: 'ATLASSIAN_JIRA_WRITE_TOKEN',
});

const opsReadClient = new AtlassianClient({
  base: 'ops',
  displayName: 'JSM Operations Read API',
  key: 'operationsRead',
  tokenName: 'ATLASSIAN_OPS_READ_TOKEN',
});

const opsWriteClient = new AtlassianClient({
  base: 'ops',
  displayName: 'JSM Operations Write API',
  flagName: 'operationsWriteEnabled',
  isWrite: true,
  key: 'operationsWrite',
  tokenName: 'ATLASSIAN_OPS_WRITE_TOKEN',
});

const jsmReadClient = new AtlassianClient({
  base: 'jira',
  displayName: 'JSM Request Read API',
  key: 'jsmRead',
  tokenName: 'ATLASSIAN_JSM_READ_TOKEN',
});

const jsmWriteClient = new AtlassianClient({
  base: 'jira',
  displayName: 'JSM Request Write API',
  flagName: 'jsmWriteEnabled',
  isWrite: true,
  key: 'jsmWrite',
  tokenName: 'ATLASSIAN_JSM_WRITE_TOKEN',
});

function getClientStatuses() {
  return {
    jiraRead: jiraReadClient.getStatus(),
    operationsRead: opsReadClient.getStatus(),
    operationsWrite: opsWriteClient.getStatus(),
    jiraWrite: jiraWriteClient.getStatus(),
    jsmRead: jsmReadClient.getStatus(),
    jsmWrite: jsmWriteClient.getStatus(),
  };
}

async function getClientStatusesAsync() {
  const [
    jiraRead,
    operationsRead,
    operationsWrite,
    jiraWrite,
    jsmRead,
    jsmWrite,
  ] = await Promise.all([
    jiraReadClient.getStatusAsync(),
    opsReadClient.getStatusAsync(),
    opsWriteClient.getStatusAsync(),
    jiraWriteClient.getStatusAsync(),
    jsmReadClient.getStatusAsync(),
    jsmWriteClient.getStatusAsync(),
  ]);

  return {
    jiraRead,
    operationsRead,
    operationsWrite,
    jiraWrite,
    jsmRead,
    jsmWrite,
  };
}

function toDisabledWriteResponse(message = 'Write actions are currently disabled.') {
  return {
    code: 'WRITE_INTEGRATION_DISABLED',
    message,
    success: false,
  };
}

module.exports = {
  AtlassianClient,
  buildUrl,
  getClientStatuses,
  getClientStatusesAsync,
  getConfig,
  getConfigAsync,
  isEnabled,
  isOperationsWriteEnabled,
  jiraReadClient,
  jiraWriteClient,
  jsmReadClient,
  jsmWriteClient,
  opsReadClient,
  opsWriteClient,
  sanitizeError,
  toDisabledWriteResponse,
};
