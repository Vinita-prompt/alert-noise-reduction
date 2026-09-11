const crypto = require('node:crypto');
const db = require('../config/db');
const integrationService = require('./integration.service');

const TOOL_NAME = 'splunk-appdynamics';
const SOURCE_TOOL = 'appdynamics';
const DEFAULT_APPLICATIONS_PATH = '/controller/rest/applications';
const DEFAULT_HEALTH_RULES_PATH = '/controller/alerting/rest/v1/applications/:applicationId/health-rules';
const DEFAULT_POLICIES_PATH = '/controller/alerting/rest/v1/applications/:applicationId/policies';
const DEFAULT_EVENTS_PATH = '/controller/rest/applications/:applicationId/events';
const DEFAULT_VIOLATIONS_PATH = '/controller/rest/applications/:applicationId/problems/healthrule-violations';
const DEFAULT_BUSINESS_TRANSACTIONS_PATH = '/controller/rest/applications/:applicationName/business-transactions';
const DEFAULT_TIERS_PATH = '/controller/rest/applications/:applicationName/tiers';
const DEFAULT_NODES_PATH = '/controller/rest/applications/:applicationName/nodes';
const DEFAULT_SNAPSHOTS_PATH = '/controller/rest/applications/:applicationName/request-snapshots';
const DEFAULT_METRIC_DATA_PATH = '/controller/rest/applications/:applicationName/metric-data';
const DEFAULT_OAUTH_PATH = '/controller/api/oauth/access_token';
const DEFAULT_TIMEOUT_MS = 12000;
const OAUTH_REFRESH_MARGIN_MS = 60000;
const DEFAULT_EVENT_TYPES = [
  'ANOMALY_OPEN_CRITICAL',
  'ANOMALY_CLOSE_CRITICAL',
  'POLICY_OPEN_CRITICAL',
  'POLICY_OPEN_WARNING',
  'POLICY_CONTINUES_CRITICAL',
  'POLICY_CONTINUES_WARNING',
  'POLICY_UPGRADED',
  'POLICY_DOWNGRADED',
  'POLICY_CLOSE_CRITICAL',
  'POLICY_CLOSE_WARNING',
  'APPLICATION_ERROR',
];
const WORKSPACE_CACHE_TTL_MS = 60000;
const WORKSPACE_STATIC_CACHE_TTL_MS = 300000;
const WORKSPACE_PAGE_SIZE = 25;
const WORKSPACE_SUMMARY_CONCURRENCY = 6;
const WORKSPACE_HEALTH_CACHE_TTL_MS = 60000;
const WORKSPACE_HEALTH_DURATION_MINUTES = 15;
const WORKSPACE_EVENT_PAGE_SIZE = 100;
const WORKSPACE_EVENT_CONTROLLER_LIMIT = 600;
const DAY_MINUTES = 24 * 60;
const WORKSPACE_RANGE_CONFIG = Object.freeze({
  '15m': Object.freeze({ aggregationLabel: '1-minute controller granularity', bucketMinutes: 1, cacheTtlMs: 45000, durationMinutes: 15, key: '15m', label: 'Last 15 minutes', queryMode: 'BEFORE_NOW', targetPoints: 15, timeoutMs: 12000 }),
  '30m': Object.freeze({ aggregationLabel: '1-minute controller granularity', bucketMinutes: 1, cacheTtlMs: 45000, durationMinutes: 30, key: '30m', label: 'Last 30 minutes', queryMode: 'BEFORE_NOW', targetPoints: 30, timeoutMs: 12000 }),
  '1h': Object.freeze({ aggregationLabel: '1-minute controller granularity', bucketMinutes: 1, cacheTtlMs: 60000, durationMinutes: 60, key: '1h', label: 'Last hour', queryMode: 'BEFORE_NOW', targetPoints: 60, timeoutMs: 12000 }),
  '4h': Object.freeze({ aggregationLabel: '5-minute aggregation', bucketMinutes: 5, cacheTtlMs: 60000, durationMinutes: 4 * 60, key: '4h', label: 'Last 4 hours', queryMode: 'BEFORE_NOW', targetPoints: 48, timeoutMs: 12000 }),
  '24h': Object.freeze({ aggregationLabel: '15-minute aggregation', bucketMinutes: 15, cacheTtlMs: 120000, durationMinutes: DAY_MINUTES, key: '24h', label: 'Last 24 hours', queryMode: 'BEFORE_NOW', targetPoints: 96, timeoutMs: 18000 }),
  '7d': Object.freeze({ aggregationLabel: 'Hourly controller granularity', bucketMinutes: 60, cacheTtlMs: 300000, durationMinutes: 7 * DAY_MINUTES, key: '7d', label: 'Last 7 days', queryMode: 'BETWEEN_TIMES', targetPoints: 168, timeoutMs: 30000 }),
  '30d': Object.freeze({ aggregationLabel: '6-hour aggregation', bucketMinutes: 6 * 60, cacheTtlMs: 600000, durationMinutes: 30 * DAY_MINUTES, key: '30d', label: 'Last 30 days', queryMode: 'BETWEEN_TIMES', targetPoints: 120, timeoutMs: 30000 }),
  '90d': Object.freeze({ aggregationLabel: 'Daily aggregation', bucketMinutes: DAY_MINUTES, cacheTtlMs: 900000, durationMinutes: 90 * DAY_MINUTES, key: '90d', label: 'Last 90 days', queryMode: 'BETWEEN_TIMES', targetPoints: 90, timeoutMs: 30000 }),
  '6mo': Object.freeze({ aggregationLabel: 'Daily aggregation', bucketMinutes: DAY_MINUTES, cacheTtlMs: 1800000, durationMinutes: 180 * DAY_MINUTES, key: '6mo', label: 'Last 6 months', queryMode: 'BETWEEN_TIMES', targetPoints: 180, timeoutMs: 45000 }),
  '1y': Object.freeze({ aggregationLabel: '2-day aggregation', bucketMinutes: 2 * DAY_MINUTES, cacheTtlMs: 3600000, durationMinutes: 365 * DAY_MINUTES, key: '1y', label: 'Last year', queryMode: 'BETWEEN_TIMES', targetPoints: 183, timeoutMs: 45000 }),
});
const WORKSPACE_RANGE_ALIASES = Object.freeze({
  15: '15m',
  30: '30m',
  60: '1h',
  240: '4h',
  1440: '24h',
});
const OVERALL_METRIC_WILDCARD = 'Overall Application Performance|*';
const BUSINESS_TRANSACTION_METRICS = [
  'Average Response Time (ms)',
  'Calls per Minute',
  'Errors per Minute',
];
const DATABASE_EXIT_POINT_PATTERN = /jdbc|database|db2|oracle|mysql|postgres|sql|mongo|cassandra|redis|memcache/i;
const DEFAULT_METRIC_PATHS = [
  'Overall Application Performance|Calls per Minute',
  'Overall Application Performance|Average Response Time (ms)',
  'Overall Application Performance|Errors per Minute',
  'Overall Application Performance|Error %',
  'Overall Application Performance|Exceptions per Minute',
];
let pollingTimer = null;
let pollingSyncInProgress = false;
let oauthTokenCache = {
  accessToken: null,
  cacheKey: null,
  expiresAt: 0,
  tokenType: null,
};
let oauthRefreshPromise = null;
let lastSuccessfulReadAt = null;
let lastReadError = null;
let lastControllerReachable = null;
const workspaceCache = new Map();

function normalizeBaseUrl(value) {
  return String(value || '')
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/controller$/i, '');
}

function normalizePath(value, fallback) {
  const path = String(value || fallback || '').trim() || fallback;

  return path.startsWith('/') ? path : `/${path}`;
}

function buildUrl(baseUrl, path, query = {}) {
  const url = new URL(normalizePath(path, '/'), `${normalizeBaseUrl(baseUrl)}/`);

  Object.entries(query).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  });

  return url.toString();
}

function maskSecret(value) {
  return value ? '********' : '';
}

function firstValue(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '');
}

function toArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.items)) return value.items;
  if (Array.isArray(value?.data)) return value.data;
  if (Array.isArray(value?.applications)) return value.applications;
  if (Array.isArray(value?.events)) return value.events;
  if (Array.isArray(value?.healthRules)) return value.healthRules;
  if (Array.isArray(value?.policyViolations)) return value.policyViolations;
  if (Array.isArray(value?.['policy-violations'])) return value['policy-violations'];
  if (Array.isArray(value?.violations)) return value.violations;
  return [];
}

function safeInteger(value, fallback) {
  const parsed = Number(value);

  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseMetricPaths(value) {
  if (Array.isArray(value)) {
    return value.map(String).map((item) => item.trim()).filter(Boolean);
  }

  return String(value || '')
    .split(/\r?\n|,/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function safeNumber(value, fallback = null) {
  const numeric = Number(value);

  return Number.isFinite(numeric) ? numeric : fallback;
}

function safeBoolean(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (value === undefined || value === null || value === '') return fallback;

  return ['true', '1', 'yes', 'y', 'enabled'].includes(String(value).toLowerCase());
}

function timestampFromMillis(value, fallback = null) {
  const numeric = Number(value);

  if (!Number.isFinite(numeric)) {
    return fallback;
  }

  return new Date(numeric).toISOString();
}

function appDynamicsNetworkMessage(error) {
  const code = error.cause?.code || error.code;

  if (error.name === 'AbortError') {
    return 'AppDynamics controller timed out. Check VPN/network access and the Controller URL.';
  }

  if (code === 'ENOTFOUND') {
    return 'AppDynamics controller host could not be found. Check the Controller URL.';
  }

  if (code === 'ECONNREFUSED') {
    return 'AppDynamics controller refused the connection. Check network access and the Controller URL.';
  }

  if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') {
    return 'AppDynamics connection timed out. Check VPN, proxy, and firewall rules.';
  }

  if (
    code === 'SELF_SIGNED_CERT_IN_CHAIN' ||
    code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
    code === 'CERT_HAS_EXPIRED'
  ) {
    return 'AppDynamics SSL certificate could not be verified. Add the corporate root CA to NODE_EXTRA_CA_CERTS before testing.';
  }

  return `Unable to reach AppDynamics. ${code ? `Error: ${code}.` : error.message}`;
}

function statusForHttp(response, text = '') {
  if (response.status === 401) {
    return {
      status: 'invalid_credentials',
      message: 'AppDynamics rejected the configured credentials. Check the username, credential, account name, and configured authentication mode.',
    };
  }

  if (response.status === 403) {
    return {
      status: 'unauthorized',
      message: 'AppDynamics credentials are valid but do not have permission for this controller/API.',
    };
  }

  if (response.status === 404) {
    return {
      status: 'controller_unreachable',
      message: 'AppDynamics endpoint was not found. Check the Controller URL and API path.',
    };
  }

  if (response.status === 406) {
    return {
      status: 'not_acceptable',
      message: 'AppDynamics rejected the requested response media type (HTTP 406).',
    };
  }

  if (response.status === 429) {
    return {
      status: 'rate_limited',
      message: 'AppDynamics rate limited the read request. Retry after the controller-provided window.',
    };
  }

  if (response.status >= 500) {
    return {
      status: 'controller_unavailable',
      message: `AppDynamics returned a temporary server error (HTTP ${response.status}).`,
    };
  }

  if (/<!doctype html|<html/i.test(text)) {
    return {
      status: 'session_expired',
      message: 'AppDynamics returned an HTML login page. The session is expired or the API URL requires authentication.',
    };
  }

  return {
    status: 'controller_unreachable',
    message: `AppDynamics returned HTTP ${response.status}.`,
  };
}

async function readJsonResponse(response) {
  const text = await response.text().catch(() => '');

  if (!text) {
    return { text, payload: null };
  }

  try {
    return { text, payload: JSON.parse(text) };
  } catch {
    return { text, payload: null };
  }
}

async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const {
    suppressDefaultAccept = false,
    ...requestOptions
  } = options;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...requestOptions,
      signal: controller.signal,
      headers: {
        ...(suppressDefaultAccept ? {} : { Accept: 'application/json' }),
        ...requestOptions.headers,
      },
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

function buildBasicUsername(username, accountName) {
  const value = String(username || '').trim();

  if (!value || value.includes('@') || !accountName) {
    return value;
  }

  return `${value}@${accountName}`;
}

function buildBasicAuthHeader(username, password, accountName) {
  const basicUsername = buildBasicUsername(username, accountName);

  return `Basic ${Buffer.from(`${basicUsername}:${password}`).toString('base64')}`;
}

function buildApiClientId(clientId, accountName) {
  const value = String(clientId || '').trim();

  if (!value || value.includes('@') || !accountName) {
    return value;
  }

  return `${value}@${accountName}`;
}

function getEnvConfig() {
  const baseUrl = normalizeBaseUrl(process.env.APPDYNAMICS_CONTROLLER_URL || process.env.APPDYNAMICS_BASE_URL);
  const accountName = process.env.APPDYNAMICS_ACCOUNT_NAME || process.env.APPDYNAMICS_ACCOUNT || '';
  const username = process.env.APPDYNAMICS_USERNAME || '';
  // The company-managed API client uses the existing Username/Credential names.
  // Keep the older aliases so existing deployments can migrate without copying
  // secrets into new environment variables.
  const credential = process.env.APPDYNAMICS_CREDENTIAL || process.env.APPDYNAMICS_PASSWORD || '';
  const password = credential;
  const clientId = process.env.APPDYNAMICS_CLIENT_ID || username;
  const clientSecret = process.env.APPDYNAMICS_CLIENT_SECRET || credential;

  if (!baseUrl && !accountName && !username && !password && !clientId && !clientSecret) {
    return null;
  }

  return {
    toolName: TOOL_NAME,
    baseUrl,
    accountIdentifier: accountName,
    isEnabled: process.env.APPDYNAMICS_ENABLED !== 'false',
    status: 'not_connected',
    credentials: {
      authMode: process.env.APPDYNAMICS_AUTH_MODE || 'api_client',
      username,
      password,
      clientId,
      clientSecret,
      applicationsPath: process.env.APPDYNAMICS_APPLICATIONS_PATH || DEFAULT_APPLICATIONS_PATH,
      healthRulesPath: process.env.APPDYNAMICS_HEALTH_RULES_PATH || DEFAULT_HEALTH_RULES_PATH,
      policiesPath: process.env.APPDYNAMICS_POLICIES_PATH || DEFAULT_POLICIES_PATH,
      eventsPath: process.env.APPDYNAMICS_EVENTS_PATH || DEFAULT_EVENTS_PATH,
      violationsPath: process.env.APPDYNAMICS_VIOLATIONS_PATH || DEFAULT_VIOLATIONS_PATH,
      eventTypes: parseMetricPaths(process.env.APPDYNAMICS_EVENT_TYPES).length
        ? parseMetricPaths(process.env.APPDYNAMICS_EVENT_TYPES)
        : DEFAULT_EVENT_TYPES,
      eventSeverities: process.env.APPDYNAMICS_EVENT_SEVERITIES || 'INFO,WARN,ERROR',
      businessTransactionsPath: process.env.APPDYNAMICS_BUSINESS_TRANSACTIONS_PATH || DEFAULT_BUSINESS_TRANSACTIONS_PATH,
      tiersPath: process.env.APPDYNAMICS_TIERS_PATH || DEFAULT_TIERS_PATH,
      nodesPath: process.env.APPDYNAMICS_NODES_PATH || DEFAULT_NODES_PATH,
      snapshotsPath: process.env.APPDYNAMICS_SNAPSHOTS_PATH || DEFAULT_SNAPSHOTS_PATH,
      metricDataPath: process.env.APPDYNAMICS_METRIC_DATA_PATH || DEFAULT_METRIC_DATA_PATH,
      metricPaths: parseMetricPaths(process.env.APPDYNAMICS_METRIC_PATHS).length
        ? parseMetricPaths(process.env.APPDYNAMICS_METRIC_PATHS)
        : DEFAULT_METRIC_PATHS,
      oauthPath: process.env.APPDYNAMICS_OAUTH_PATH || DEFAULT_OAUTH_PATH,
      syncApplicationLimit: process.env.APPDYNAMICS_SYNC_APPLICATION_LIMIT || 100,
      eventDurationMinutes: process.env.APPDYNAMICS_EVENT_DURATION_MINUTES || 60,
      metricDurationMinutes: process.env.APPDYNAMICS_METRIC_DURATION_MINUTES || 60,
      snapshotDurationMinutes: process.env.APPDYNAMICS_SNAPSHOT_DURATION_MINUTES || 60,
      automaticSyncIntervalSeconds: process.env.APPDYNAMICS_SYNC_INTERVAL_SECONDS || 60,
      liveImportMode: process.env.APPDYNAMICS_LIVE_IMPORT_MODE === 'true',
    },
    source: 'environment',
  };
}

async function getRuntimeConfig() {
  let stored = null;

  try {
    stored = await integrationService.getIntegrationRuntimeConfig(TOOL_NAME);
  } catch (error) {
    if (error.status !== 404) {
      throw error;
    }
  }

  const env = getEnvConfig();
  const baseUrl = normalizeBaseUrl(stored?.baseUrl || env?.baseUrl);
  const accountName = stored?.accountIdentifier || env?.accountIdentifier || '';
  const credentials = {
    ...(env?.credentials || {}),
    ...(stored?.credentials || {}),
  };
  credentials.authMode = 'api_client';
  credentials.clientId = credentials.clientId || credentials.username || env?.credentials.clientId || '';
  credentials.clientSecret = credentials.clientSecret || credentials.password || env?.credentials.clientSecret || '';
  credentials.applicationsPath = normalizePath(credentials.applicationsPath, DEFAULT_APPLICATIONS_PATH);
  credentials.healthRulesPath = normalizePath(credentials.healthRulesPath, DEFAULT_HEALTH_RULES_PATH);
  credentials.policiesPath = normalizePath(credentials.policiesPath, DEFAULT_POLICIES_PATH);
  credentials.eventsPath = normalizePath(credentials.eventsPath, DEFAULT_EVENTS_PATH);
  credentials.violationsPath = normalizePath(credentials.violationsPath, DEFAULT_VIOLATIONS_PATH);
  credentials.eventTypes = parseMetricPaths(credentials.eventTypes).length
    ? parseMetricPaths(credentials.eventTypes)
    : DEFAULT_EVENT_TYPES;
  credentials.eventSeverities = credentials.eventSeverities || 'INFO,WARN,ERROR';
  credentials.businessTransactionsPath = normalizePath(credentials.businessTransactionsPath, DEFAULT_BUSINESS_TRANSACTIONS_PATH);
  credentials.tiersPath = normalizePath(credentials.tiersPath, DEFAULT_TIERS_PATH);
  credentials.nodesPath = normalizePath(credentials.nodesPath, DEFAULT_NODES_PATH);
  credentials.snapshotsPath = normalizePath(credentials.snapshotsPath, DEFAULT_SNAPSHOTS_PATH);
  credentials.metricDataPath = normalizePath(credentials.metricDataPath, DEFAULT_METRIC_DATA_PATH);
  credentials.metricPaths = parseMetricPaths(credentials.metricPaths).length
    ? parseMetricPaths(credentials.metricPaths)
    : DEFAULT_METRIC_PATHS;
  credentials.oauthPath = normalizePath(credentials.oauthPath, DEFAULT_OAUTH_PATH);
  credentials.syncApplicationLimit = safeInteger(credentials.syncApplicationLimit, 100);
  credentials.eventDurationMinutes = safeInteger(credentials.eventDurationMinutes, 60);
  credentials.metricDurationMinutes = safeInteger(credentials.metricDurationMinutes, 60);
  credentials.snapshotDurationMinutes = safeInteger(credentials.snapshotDurationMinutes, 60);
  credentials.automaticSyncIntervalSeconds = safeInteger(credentials.automaticSyncIntervalSeconds, 60);

  const missing = [];
  if (!baseUrl) missing.push('Controller URL');
  if (!accountName) missing.push('Account name');
  if (credentials.authMode === 'api_client') {
    if (!credentials.clientId) missing.push('Client ID');
    if (!credentials.clientSecret) missing.push('Client Secret');
  } else {
    if (!credentials.username) missing.push('Username');
    if (!credentials.password) missing.push('Password');
  }

  return {
    toolName: TOOL_NAME,
    baseUrl,
    accountName,
    credentials,
    isEnabled: stored?.isEnabled ?? env?.isEnabled ?? false,
    source: stored ? 'settings' : env?.source || 'environment',
    missing,
  };
}

async function ensureAppDynamicsStorage(client = db) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS appdynamics_connection_state (
      integration_tool_name TEXT PRIMARY KEY,
      controller_url TEXT,
      account_name TEXT,
      auth_mode TEXT,
      connection_status TEXT NOT NULL DEFAULT 'disconnected',
      connected_user_display_name TEXT,
      token_expires_at TIMESTAMPTZ,
      last_successful_sync TIMESTAMPTZ,
      last_failed_sync TIMESTAMPTZ,
      last_error TEXT,
      response_time_ms INTEGER,
      last_checked_at TIMESTAMPTZ,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS monitoring_records (
      id BIGSERIAL PRIMARY KEY,
      source_tool TEXT NOT NULL,
      environment TEXT NOT NULL DEFAULT 'unknown',
      application_name TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'unknown',
      severity TEXT NOT NULL DEFAULT 'low',
      summary TEXT NOT NULL,
      details TEXT,
      acknowledged BOOLEAN NOT NULL DEFAULT FALSE,
      last_check TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      deep_link TEXT,
      custom_properties JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (source_tool, entity_type, entity_id)
    );

    CREATE INDEX IF NOT EXISTS idx_monitoring_records_tool_app
      ON monitoring_records(source_tool, application_name);
    CREATE INDEX IF NOT EXISTS idx_monitoring_records_status
      ON monitoring_records(source_tool, status);
    CREATE INDEX IF NOT EXISTS idx_monitoring_records_updated
      ON monitoring_records(source_tool, updated_at DESC);

    CREATE TABLE IF NOT EXISTS appdynamics_applications (
      application_id TEXT PRIMARY KEY,
      application_name TEXT NOT NULL,
      health TEXT NOT NULL DEFAULT 'unknown',
      health_color TEXT,
      response_time DOUBLE PRECISION,
      calls DOUBLE PRECISION,
      calls_per_minute DOUBLE PRECISION,
      errors DOUBLE PRECISION,
      errors_per_minute DOUBLE PRECISION,
      last_updated TIMESTAMPTZ,
      time_window TEXT,
      status TEXT NOT NULL DEFAULT 'ok',
      tags JSONB NOT NULL DEFAULT '[]'::jsonb,
      description TEXT,
      raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS appdynamics_tiers (
      id BIGSERIAL PRIMARY KEY,
      application_id TEXT NOT NULL,
      tier_id TEXT NOT NULL,
      tier_name TEXT NOT NULL,
      tier_type TEXT,
      agent_type TEXT,
      number_of_nodes INTEGER,
      health TEXT NOT NULL DEFAULT 'unknown',
      raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (application_id, tier_id)
    );

    CREATE TABLE IF NOT EXISTS appdynamics_business_transactions (
      id BIGSERIAL PRIMARY KEY,
      application_id TEXT NOT NULL,
      business_transaction_id TEXT NOT NULL,
      business_transaction_name TEXT NOT NULL,
      tier_name TEXT,
      health TEXT NOT NULL DEFAULT 'unknown',
      response_time DOUBLE PRECISION,
      calls DOUBLE PRECISION,
      calls_per_minute DOUBLE PRECISION,
      errors DOUBLE PRECISION,
      errors_per_minute DOUBLE PRECISION,
      error_percent DOUBLE PRECISION,
      slow_percent DOUBLE PRECISION,
      very_slow_percent DOUBLE PRECISION,
      stall_percent DOUBLE PRECISION,
      normal_percent DOUBLE PRECISION,
      last_seen_at TIMESTAMPTZ,
      raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (application_id, business_transaction_id)
    );

    CREATE TABLE IF NOT EXISTS appdynamics_nodes (
      id BIGSERIAL PRIMARY KEY,
      application_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      node_name TEXT NOT NULL,
      tier_id TEXT,
      tier_name TEXT,
      server_name TEXT,
      health TEXT NOT NULL DEFAULT 'unknown',
      response_time DOUBLE PRECISION,
      calls DOUBLE PRECISION,
      errors DOUBLE PRECISION,
      availability DOUBLE PRECISION,
      cpu DOUBLE PRECISION,
      memory DOUBLE PRECISION,
      agent_version TEXT,
      raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (application_id, node_id)
    );

    CREATE TABLE IF NOT EXISTS appdynamics_events (
      id BIGSERIAL PRIMARY KEY,
      application_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'medium',
      status TEXT NOT NULL DEFAULT 'warning',
      event_type TEXT,
      tier_name TEXT,
      node_name TEXT,
      summary TEXT NOT NULL,
      description TEXT,
      event_time TIMESTAMPTZ,
      category TEXT,
      raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (application_id, event_id)
    );

    CREATE TABLE IF NOT EXISTS appdynamics_snapshots (
      id BIGSERIAL PRIMARY KEY,
      application_id TEXT NOT NULL,
      snapshot_id TEXT NOT NULL,
      business_transaction_id TEXT,
      business_transaction_name TEXT,
      snapshot_type TEXT,
      execution_time_ms DOUBLE PRECISION,
      sql_call_count INTEGER,
      remote_call_count INTEGER,
      exception_count INTEGER,
      started_at TIMESTAMPTZ,
      raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (application_id, snapshot_id)
    );

    CREATE TABLE IF NOT EXISTS appdynamics_health_rules (
      id BIGSERIAL PRIMARY KEY,
      application_id TEXT NOT NULL,
      health_rule_id TEXT NOT NULL,
      health_rule_name TEXT NOT NULL,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      severity TEXT NOT NULL DEFAULT 'low',
      status TEXT NOT NULL DEFAULT 'ok',
      raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (application_id, health_rule_id)
    );

    CREATE TABLE IF NOT EXISTS appdynamics_metrics (
      id BIGSERIAL PRIMARY KEY,
      application_id TEXT NOT NULL,
      metric_path TEXT NOT NULL,
      metric_name TEXT NOT NULL,
      metric_value DOUBLE PRECISION,
      metric_timestamp TIMESTAMPTZ NOT NULL,
      time_window TEXT,
      raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (application_id, metric_path, metric_timestamp)
    );

    CREATE TABLE IF NOT EXISTS appdynamics_flow_map (
      id BIGSERIAL PRIMARY KEY,
      application_id TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_name TEXT NOT NULL,
      source_entity_id TEXT,
      target_entity_id TEXT,
      health TEXT NOT NULL DEFAULT 'unknown',
      latency DOUBLE PRECISION,
      calls DOUBLE PRECISION,
      errors DOUBLE PRECISION,
      raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (application_id, entity_type, entity_id)
    );

    CREATE TABLE IF NOT EXISTS appdynamics_ai_features (
      id BIGSERIAL PRIMARY KEY,
      application_id TEXT NOT NULL,
      source_module TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      entity_name TEXT NOT NULL,
      ai_label TEXT NOT NULL DEFAULT 'unknown',
      ai_confidence DOUBLE PRECISION,
      ai_reason TEXT,
      ai_features JSONB NOT NULL DEFAULT '{}'::jsonb,
      raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (application_id, source_module, entity_id)
    );

    CREATE INDEX IF NOT EXISTS idx_appdynamics_bt_app
      ON appdynamics_business_transactions(application_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_appdynamics_nodes_app
      ON appdynamics_nodes(application_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_appdynamics_events_app_time
      ON appdynamics_events(application_id, event_time DESC);
    CREATE INDEX IF NOT EXISTS idx_appdynamics_metrics_app_time
      ON appdynamics_metrics(application_id, metric_timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_appdynamics_ai_app
      ON appdynamics_ai_features(application_id, source_module);
  `);
}

async function updateConnectionState(values = {}) {
  await ensureAppDynamicsStorage();
  await db.query(
    `
      INSERT INTO appdynamics_connection_state (
        integration_tool_name,
        controller_url,
        account_name,
        auth_mode,
        connection_status,
        connected_user_display_name,
        token_expires_at,
        last_successful_sync,
        last_failed_sync,
        last_error,
        response_time_ms,
        last_checked_at,
        metadata,
        updated_at
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW(),$12::jsonb,NOW())
      ON CONFLICT (integration_tool_name)
      DO UPDATE SET
        controller_url = COALESCE(EXCLUDED.controller_url, appdynamics_connection_state.controller_url),
        account_name = COALESCE(EXCLUDED.account_name, appdynamics_connection_state.account_name),
        auth_mode = COALESCE(EXCLUDED.auth_mode, appdynamics_connection_state.auth_mode),
        connection_status = EXCLUDED.connection_status,
        connected_user_display_name = COALESCE(EXCLUDED.connected_user_display_name, appdynamics_connection_state.connected_user_display_name),
        token_expires_at = COALESCE(EXCLUDED.token_expires_at, appdynamics_connection_state.token_expires_at),
        last_successful_sync = COALESCE(EXCLUDED.last_successful_sync, appdynamics_connection_state.last_successful_sync),
        last_failed_sync = COALESCE(EXCLUDED.last_failed_sync, appdynamics_connection_state.last_failed_sync),
        last_error = EXCLUDED.last_error,
        response_time_ms = COALESCE(EXCLUDED.response_time_ms, appdynamics_connection_state.response_time_ms),
        last_checked_at = NOW(),
        metadata = appdynamics_connection_state.metadata || EXCLUDED.metadata,
        updated_at = NOW()
    `,
    [
      TOOL_NAME,
      values.controllerUrl || null,
      values.accountName || null,
      values.authMode || null,
      values.connectionStatus || 'disconnected',
      values.connectedUserDisplayName || null,
      values.tokenExpiresAt || null,
      values.lastSuccessfulSync || null,
      values.lastFailedSync || null,
      values.lastError || null,
      Number.isFinite(values.responseTimeMs) ? values.responseTimeMs : null,
      JSON.stringify(values.metadata || {}),
    ],
  );
}

async function getConnectionState() {
  await ensureAppDynamicsStorage();
  const result = await db.query(
    'SELECT * FROM appdynamics_connection_state WHERE integration_tool_name = $1',
    [TOOL_NAME],
  );

  return result.rows[0] || null;
}

function oauthCacheKey(config) {
  return crypto
    .createHash('sha256')
    .update([
      normalizeBaseUrl(config.baseUrl),
      config.accountName || '',
      config.credentials.clientId || '',
      config.credentials.clientSecret || '',
    ].join('\u0000'))
    .digest('hex');
}

function clearOAuthTokenCache(config = null) {
  if (config && oauthTokenCache.cacheKey !== oauthCacheKey(config)) {
    return;
  }

  oauthTokenCache = {
    accessToken: null,
    cacheKey: null,
    expiresAt: 0,
    tokenType: null,
  };
}

function getOAuthTokenStatus() {
  const now = Date.now();
  const expiresAt = oauthTokenCache.expiresAt || 0;
  const remainingLifetimeSeconds = expiresAt
    ? Math.max(0, Math.floor((expiresAt - now) / 1000))
    : 0;

  return {
    cached: Boolean(oauthTokenCache.accessToken && expiresAt > now),
    expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
    refreshInProgress: Boolean(oauthRefreshPromise),
    remainingLifetimeSeconds,
  };
}

async function requestAccessToken(config) {
  const url = buildUrl(config.baseUrl, config.credentials.oauthPath);
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: buildApiClientId(config.credentials.clientId, config.accountName),
    client_secret: config.credentials.clientSecret,
  });
  const startedAt = Date.now();
  const response = await fetchWithTimeout(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
    suppressDefaultAccept: true,
  });
  const { text, payload } = await readJsonResponse(response);

  if (!response.ok || !payload?.access_token) {
    const mapped = statusForHttp(response, text);
    const error = new Error(mapped.message);
    error.status = response.status || 502;
    error.connectionStatus = mapped.status;
    throw error;
  }

  const returnedExpiresIn = Number(payload.expires_in || payload.expires || 0);
  const expiresInSeconds = Number.isFinite(returnedExpiresIn) && returnedExpiresIn > 0
    ? returnedExpiresIn
    : 300;
  const expiresAt = Date.now() + expiresInSeconds * 1000;

  return {
    accessToken: payload.access_token,
    expiresAt,
    responseTimeMs: Date.now() - startedAt,
    tokenType: typeof payload.token_type === 'string' ? payload.token_type : null,
  };
}

async function getAccessToken(config, options = {}) {
  const cacheKey = oauthCacheKey(config);
  const now = Date.now();
  const tokenIsFresh = (
    oauthTokenCache.cacheKey === cacheKey
    && oauthTokenCache.accessToken
    && oauthTokenCache.expiresAt - OAUTH_REFRESH_MARGIN_MS > now
  );

  if (!options.forceRefresh && tokenIsFresh) {
    return {
      ...oauthTokenCache,
      responseTimeMs: null,
    };
  }

  if (oauthRefreshPromise?.cacheKey === cacheKey) {
    return oauthRefreshPromise.promise;
  }

  const refresh = requestAccessToken(config).then((token) => {
    oauthTokenCache = {
      accessToken: token.accessToken,
      cacheKey,
      expiresAt: token.expiresAt,
      tokenType: token.tokenType,
    };

    return {
      ...oauthTokenCache,
      responseTimeMs: token.responseTimeMs,
    };
  });

  oauthRefreshPromise = { cacheKey, promise: refresh };

  try {
    return await refresh;
  } finally {
    if (oauthRefreshPromise?.promise === refresh) {
      oauthRefreshPromise = null;
    }
  }
}

async function getAuthContext(config, options = {}) {
  if (config.credentials.authMode === 'api_client') {
    const token = await getAccessToken(config, options);

    return {
      headers: {
        Authorization: `Bearer ${token.accessToken}`,
      },
      tokenExpiresAt: new Date(token.expiresAt).toISOString(),
      responseTimeMs: token.responseTimeMs,
    };
  }

  return {
    headers: {
      Authorization: buildBasicAuthHeader(
        config.credentials.username,
        config.credentials.password,
        config.accountName,
      ),
    },
    tokenExpiresAt: null,
    responseTimeMs: null,
  };
}

async function appDynamicsFetch(config, path, query = {}, options = {}) {
  const url = buildUrl(config.baseUrl, path, query);
  const startedAt = Date.now();

  try {
    let auth = options.auth || await getAuthContext(config);
    const performRead = async () => {
      const response = await fetchWithTimeout(url, {
        method: 'GET',
        headers: {
          ...auth.headers,
          Accept: 'application/json',
        },
      }, options.timeoutMs || DEFAULT_TIMEOUT_MS);
      const body = await readJsonResponse(response);

      return { response, ...body };
    };

    let read = await performRead();

    if (
      read.response.status === 401
      && config.credentials.authMode === 'api_client'
      && options.retryAuthentication !== false
    ) {
      clearOAuthTokenCache(config);
      auth = await getAuthContext(config, { forceRefresh: true });
      if (options.auth) {
        Object.assign(options.auth, auth);
      }
      read = await performRead();
    }

    const { response, text, payload } = read;
    const responseTimeMs = Date.now() - startedAt;

    if (!response.ok || /<!doctype html|<html/i.test(text)) {
      const mapped = statusForHttp(response, text);
      const error = new Error(mapped.message);
      error.status = response.status || 502;
      error.connectionStatus = mapped.status;
      throw error;
    }

    lastControllerReachable = true;
    lastReadError = null;
    lastSuccessfulReadAt = new Date().toISOString();

    return {
      httpStatus: response.status,
      payload,
      responseTimeMs,
      tokenExpiresAt: auth.tokenExpiresAt,
    };
  } catch (error) {
    if (error.connectionStatus) {
      lastControllerReachable = error.connectionStatus !== 'controller_unreachable';
      lastReadError = error.message;
      throw error;
    }

    const wrapped = new Error(appDynamicsNetworkMessage(error));
    wrapped.status = 502;
    wrapped.connectionStatus = 'controller_unreachable';
    lastControllerReachable = false;
    lastReadError = wrapped.message;
    throw wrapped;
  }
}

/**
 * Internal, GET-only controller request used by bounded evidence collectors.
 * Authentication remains inside this service and is never returned to callers.
 */
async function readOnlyRequest(path, query = {}, options = {}) {
  const normalizedPath = normalizePath(path, '/');
  if (!normalizedPath.startsWith('/controller/')) {
    const error = new Error('AppDynamics read-only requests must target a controller API path.');
    error.status = 400;
    throw error;
  }

  const config = await getRuntimeConfig();
  if (!config.isEnabled) {
    const error = new Error('AppDynamics integration is disabled.');
    error.status = 400;
    throw error;
  }
  if (config.missing.length > 0) {
    const error = new Error(`AppDynamics is missing required fields: ${config.missing.join(', ')}.`);
    error.status = 400;
    throw error;
  }

  return appDynamicsFetch(config, normalizedPath, query, {
    retryAuthentication: options.retryAuthentication,
    timeoutMs: options.timeoutMs,
  });
}

function getApplicationName(application) {
  return String(application.name || application.applicationName || application.id || 'Unknown application');
}

function getApplicationId(application) {
  return String(application.id || application.applicationId || application.name || getApplicationName(application));
}

function buildApplicationDeepLink(config, appId) {
  return `${normalizeBaseUrl(config.baseUrl)}/controller/#/location=APP_DASHBOARD&application=${encodeURIComponent(appId)}`;
}

function buildEventDeepLink(config, eventId) {
  if (!eventId) return null;
  return `${normalizeBaseUrl(config.baseUrl)}/#location=APP_EVENT_VIEWER_MODAL&eventSummary=${encodeURIComponent(eventId)}`;
}

function mapSeverity(value) {
  const normalized = String(value || '').toLowerCase();

  if (normalized.includes('critical') || normalized.includes('severe') || normalized === 'error') return 'critical';
  if (normalized.includes('warning') || normalized.includes('warn')) return 'warning';
  if (normalized.includes('info')) return 'low';
  return 'medium';
}

function mapStatus(value, fallback = 'ok') {
  const normalized = String(value || '').toLowerCase();

  if (['critical', 'error', 'failed', 'down', 'open', 'active'].includes(normalized)) return 'critical';
  if (['warning', 'warn', 'started', 'ongoing'].includes(normalized)) return 'warning';
  if (['resolved', 'closed', 'normal', 'ok', 'healthy'].includes(normalized)) return 'ok';
  if (['disabled', 'inactive'].includes(normalized)) return 'unknown';
  return fallback;
}

function mapApplicationRecord(config, application) {
  const appId = getApplicationId(application);
  const name = getApplicationName(application);

  return {
    sourceTool: SOURCE_TOOL,
    environment: 'production',
    applicationName: name,
    entityType: 'application',
    entityId: appId,
    status: 'ok',
    severity: 'low',
    summary: `${name} application is available from AppDynamics.`,
    details: `AppDynamics application ${name}.`,
    acknowledged: false,
    lastCheck: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    rawPayload: application,
    deepLink: buildApplicationDeepLink(config, appId),
    customProperties: {
      appDynamicsApplicationId: appId,
      appDynamicsApplicationName: name,
      accountName: config.accountName,
      controllerUrl: config.baseUrl,
      sourceKind: 'application',
    },
  };
}

function mapHealthRuleRecord(config, application, rule) {
  const appId = getApplicationId(application);
  const appName = getApplicationName(application);
  const ruleId = String(rule.id || rule.healthRuleId || rule.name || `${appId}:${rule.displayName || 'rule'}`);
  const ruleName = String(rule.name || rule.displayName || `Health rule ${ruleId}`);
  const enabled = rule.enabled !== false;

  return {
    sourceTool: SOURCE_TOOL,
    environment: 'production',
    applicationName: appName,
    entityType: 'health_rule',
    entityId: `${appId}:${ruleId}`,
    status: enabled ? 'ok' : 'unknown',
    severity: enabled ? 'low' : 'medium',
    summary: `${ruleName} health rule is ${enabled ? 'enabled' : 'disabled'}.`,
    details: rule.description || rule.summary || '',
    acknowledged: false,
    lastCheck: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    rawPayload: rule,
    deepLink: buildApplicationDeepLink(config, appId),
    customProperties: {
      appDynamicsApplicationId: appId,
      healthRuleId: ruleId,
      healthRuleName: ruleName,
      enabled,
      sourceKind: 'health_rule',
    },
  };
}

function mapEventRecord(config, application, event) {
  const appId = getApplicationId(application);
  const appName = getApplicationName(application);
  const eventId = String(event.id || event.eventId || event.guid || `${appId}:${event.eventTime || event.eventTimeString || event.summary || Date.now()}`);
  const eventType = event.eventType || event.type || event.eventTypeKey || 'event';
  const severity = mapSeverity(event.severity || event.eventSeverity || eventType);
  const status = mapStatus(event.severity || event.eventSeverity || event.status || eventType, severity === 'critical' ? 'critical' : 'warning');
  const timestamp = firstValue(event.eventTimeString, event.eventTime, event.timestamp, event.createdAt, new Date().toISOString());

  return {
    sourceTool: SOURCE_TOOL,
    environment: 'production',
    applicationName: appName,
    entityType: 'event',
    entityId: `${appId}:${eventId}`,
    status,
    severity,
    summary: event.summary || event.description || `${eventType} event for ${appName}`,
    details: event.description || event.eventMessage || event.deepLink || '',
    acknowledged: Boolean(event.acknowledged),
    lastCheck: timestamp,
    updatedAt: new Date().toISOString(),
    rawPayload: event,
    deepLink: event.deepLink || event.eventUrl || buildApplicationDeepLink(config, appId),
    customProperties: {
      appDynamicsApplicationId: appId,
      eventId,
      eventType,
      eventSeverity: event.severity || event.eventSeverity,
      sourceKind: 'event',
    },
  };
}

function replaceApplicationTokens(path, application) {
  const appId = getApplicationId(application);
  const appName = getApplicationName(application);

  return normalizePath(path, '/')
    .replace(/:applicationId/g, encodeURIComponent(appId))
    .replace(/:applicationName/g, encodeURIComponent(appName));
}

function appDynamicsTimeQuery(durationMinutes) {
  return {
    'time-range-type': 'BEFORE_NOW',
    'duration-in-mins': safeInteger(durationMinutes, 60),
    output: 'JSON',
  };
}

async function optionalAppDynamicsFetch(config, path, query = {}, auth = null) {
  try {
    const response = await appDynamicsFetch(config, path, query, { auth });

    return toArray(response.payload);
  } catch (error) {
    if (error.status === 404 || error.status === 403) {
      return [];
    }

    throw error;
  }
}

function appDynamicsTimestamp(...values) {
  for (const value of values) {
    if (value === undefined || value === null || value === '') {
      continue;
    }

    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 1000000000) {
      return timestampFromMillis(numeric);
    }

    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) {
      return date.toISOString();
    }
  }

  return null;
}

function normalizeApplicationRow(application) {
  const appId = getApplicationId(application);
  const appName = getApplicationName(application);

  return {
    applicationId: appId,
    applicationName: appName,
    health: String(application.health || application.healthStatus || application.status || 'unknown').toLowerCase(),
    healthColor: application.healthColor || application.color || null,
    responseTime: safeNumber(application.responseTime || application.averageResponseTime || application.averageResponseTimeInMillis),
    calls: safeNumber(application.calls || application.callCount || application.totalCalls),
    callsPerMinute: safeNumber(application.callsPerMinute || application.cpm || application.callsPerMin),
    errors: safeNumber(application.errors || application.errorCount || application.totalErrors),
    errorsPerMinute: safeNumber(application.errorsPerMinute || application.epm || application.errorsPerMin),
    lastUpdated: appDynamicsTimestamp(application.updatedAt, application.lastUpdated, application.lastUpdatedTime) || new Date().toISOString(),
    timeWindow: application.timeWindow || application.timeRange || null,
    status: mapStatus(application.health || application.healthStatus || application.status, 'ok'),
    tags: application.tags || [],
    description: application.description || '',
    rawPayload: application,
  };
}

function normalizeTierRow(application, tier) {
  const appId = getApplicationId(application);
  const tierId = String(tier.id || tier.tierId || tier.name || tier.tierName || `${appId}:tier`);
  const tierName = String(tier.name || tier.tierName || tier.displayName || `Tier ${tierId}`);

  return {
    applicationId: appId,
    tierId,
    tierName,
    tierType: tier.type || tier.tierType || tier.entryPointType || null,
    agentType: tier.agentType || tier.agentTypeName || null,
    numberOfNodes: safeInteger(tier.numberOfNodes || tier.nodeCount, 0),
    health: mapStatus(tier.health || tier.status || tier.healthStatus, 'unknown'),
    rawPayload: tier,
  };
}

function normalizeNodeRow(application, node) {
  const appId = getApplicationId(application);
  const nodeId = String(node.id || node.nodeId || node.name || node.nodeName || `${appId}:node`);
  const nodeName = String(node.name || node.nodeName || node.displayName || `Node ${nodeId}`);

  return {
    applicationId: appId,
    nodeId,
    nodeName,
    tierId: node.tierId ? String(node.tierId) : null,
    tierName: node.tierName || node.tier || node.tierDisplayName || null,
    serverName: node.machineName || node.serverName || node.hostName || node.host || null,
    health: mapStatus(node.health || node.healthStatus || node.status, 'unknown'),
    responseTime: safeNumber(node.responseTime || node.averageResponseTime || node.averageResponseTimeInMillis),
    calls: safeNumber(node.calls || node.callCount || node.totalCalls),
    errors: safeNumber(node.errors || node.errorCount || node.totalErrors),
    availability: safeNumber(node.availability || node.availabilityPercent),
    cpu: safeNumber(node.cpu || node.cpuPercent || node.cpuUsage),
    memory: safeNumber(node.memory || node.memoryPercent || node.memoryUsage),
    agentVersion: node.agentVersion || node.appAgentVersion || null,
    rawPayload: node,
  };
}

function normalizeBusinessTransactionRow(application, transaction) {
  const appId = getApplicationId(application);
  const transactionId = String(
    transaction.id
    || transaction.businessTransactionId
    || transaction.internalName
    || transaction.name
    || transaction.businessTransactionName
    || `${appId}:bt`,
  );
  const transactionName = String(
    transaction.name
    || transaction.businessTransactionName
    || transaction.displayName
    || `Business transaction ${transactionId}`,
  );

  return {
    applicationId: appId,
    businessTransactionId: transactionId,
    businessTransactionName: transactionName,
    tierName: transaction.tierName || transaction.tier || transaction.entryPoint || null,
    health: mapStatus(transaction.health || transaction.healthStatus || transaction.status, 'unknown'),
    responseTime: safeNumber(transaction.responseTime || transaction.averageResponseTime || transaction.averageResponseTimeInMillis),
    calls: safeNumber(transaction.calls || transaction.callCount || transaction.totalCalls),
    callsPerMinute: safeNumber(transaction.callsPerMinute || transaction.cpm || transaction.callsPerMin),
    errors: safeNumber(transaction.errors || transaction.errorCount || transaction.totalErrors),
    errorsPerMinute: safeNumber(transaction.errorsPerMinute || transaction.epm || transaction.errorsPerMin),
    errorPercent: safeNumber(transaction.errorPercent || transaction.errorPercentage),
    slowPercent: safeNumber(transaction.slowPercent),
    verySlowPercent: safeNumber(transaction.verySlowPercent),
    stallPercent: safeNumber(transaction.stallPercent),
    normalPercent: safeNumber(transaction.normalPercent),
    lastSeenAt: appDynamicsTimestamp(transaction.lastSeenAt, transaction.lastSeenTime, transaction.updatedAt) || new Date().toISOString(),
    rawPayload: transaction,
  };
}

function normalizeHealthRuleRow(application, rule) {
  const appId = getApplicationId(application);
  const ruleId = String(rule.id || rule.healthRuleId || rule.name || rule.displayName || `${appId}:rule`);
  const ruleName = String(rule.name || rule.displayName || `Health rule ${ruleId}`);
  const enabled = rule.enabled !== false;

  return {
    applicationId: appId,
    healthRuleId: ruleId,
    healthRuleName: ruleName,
    enabled,
    severity: enabled ? 'low' : 'medium',
    status: enabled ? 'ok' : 'unknown',
    rawPayload: rule,
  };
}

function normalizeEventRow(application, event) {
  const appId = getApplicationId(application);
  const eventId = String(event.id || event.eventId || event.guid || `${appId}:${event.eventTime || event.eventTimeString || event.summary || Date.now()}`);
  const eventType = event.eventType || event.type || event.eventTypeKey || 'event';
  const severity = mapSeverity(event.severity || event.eventSeverity || eventType);
  const status = mapStatus(event.severity || event.eventSeverity || event.status || eventType, severity === 'critical' ? 'critical' : 'warning');

  return {
    applicationId: appId,
    eventId,
    severity,
    status,
    eventType,
    tierName: event.tierName || event.tier || null,
    nodeName: event.nodeName || event.node || null,
    summary: event.summary || event.description || `${eventType} event`,
    description: event.description || event.eventMessage || '',
    eventTime: appDynamicsTimestamp(event.eventTime, event.eventTimeString, event.timestamp, event.createdAt) || new Date().toISOString(),
    category: event.category || event.eventTypeKey || null,
    rawPayload: event,
  };
}

function normalizeSnapshotRow(application, snapshot) {
  const appId = getApplicationId(application);
  const snapshotId = String(
    snapshot.id
    || snapshot.requestGuid
    || snapshot.requestGUID
    || snapshot.snapshotId
    || snapshot.guid
    || `${appId}:${snapshot.startTime || snapshot.serverStartTime || Date.now()}`,
  );

  return {
    applicationId: appId,
    snapshotId,
    businessTransactionId: snapshot.businessTransactionId ? String(snapshot.businessTransactionId) : null,
    businessTransactionName: snapshot.businessTransactionName || snapshot.businessTransaction || snapshot.btName || null,
    snapshotType: snapshot.snapshotType || snapshot.type || snapshot.requestType || null,
    executionTimeMs: safeNumber(snapshot.executionTimeInMillis || snapshot.executionTime || snapshot.responseTime),
    sqlCallCount: safeInteger(snapshot.sqlCallCount || snapshot.sqlCalls, 0),
    remoteCallCount: safeInteger(snapshot.remoteCallCount || snapshot.remoteCalls, 0),
    exceptionCount: safeInteger(snapshot.exceptionCount || snapshot.exceptions, 0),
    startedAt: appDynamicsTimestamp(snapshot.startTime, snapshot.startTimeInMillis, snapshot.serverStartTime) || new Date().toISOString(),
    rawPayload: snapshot,
  };
}

function normalizeMetricRows(application, metricPath, payload) {
  const appId = getApplicationId(application);
  const metricItems = toArray(payload);
  const rows = [];

  metricItems.forEach((item) => {
    const resolvedPath = item.metricPath || metricPath;
    const metricName = item.metricName || String(resolvedPath).split('|').at(-1) || 'Metric';
    const values = item.metricValues || item.values || item.data || [];

    values.forEach((point) => {
      const metricTimestamp = appDynamicsTimestamp(
        point.startTimeInMillis,
        point.startTime,
        point.timestamp,
      ) || new Date().toISOString();
      const metricValue = safeNumber(
        point.value
        ?? point.current
        ?? point.sum
        ?? point.count
        ?? point.min
        ?? point.max,
      );

      if (metricValue === null) {
        return;
      }

      rows.push({
        applicationId: appId,
        metricPath: resolvedPath,
        metricName,
        metricValue,
        metricTimestamp,
        timeWindow: item.timeWindow || null,
        rawPayload: point,
      });
    });
  });

  return rows;
}

function normalizeFlowMapRows(application, tiers = [], nodes = []) {
  const appId = getApplicationId(application);
  const rows = [];

  tiers.forEach((tier) => {
    rows.push({
      applicationId: appId,
      entityId: `tier:${tier.tierId}`,
      entityType: 'tier',
      entityName: tier.tierName,
      sourceEntityId: null,
      targetEntityId: null,
      health: tier.health || 'unknown',
      latency: null,
      calls: null,
      errors: null,
      rawPayload: tier.rawPayload || tier,
    });
  });

  nodes.forEach((node) => {
    rows.push({
      applicationId: appId,
      entityId: `node:${node.nodeId}`,
      entityType: 'node',
      entityName: node.nodeName,
      sourceEntityId: node.tierId ? `tier:${node.tierId}` : null,
      targetEntityId: null,
      health: node.health || 'unknown',
      latency: node.responseTime,
      calls: node.calls,
      errors: node.errors,
      rawPayload: node.rawPayload || node,
    });
  });

  return rows;
}

function buildAiFeatureRows(application, { businessTransactions = [], nodes = [], events = [], metrics = [] } = {}) {
  const appId = getApplicationId(application);
  const rows = [];
  const criticalEventCount = events.filter((event) => event.severity === 'critical' || event.status === 'critical').length;
  const warningEventCount = events.filter((event) => event.severity === 'warning' || event.status === 'warning').length;

  rows.push({
    applicationId: appId,
    sourceModule: 'application',
    entityId: appId,
    entityName: getApplicationName(application),
    aiLabel: criticalEventCount ? 'incident' : warningEventCount ? 'unknown' : 'unknown',
    aiConfidence: criticalEventCount ? 0.65 : 0.35,
    aiReason: criticalEventCount
      ? 'Recent AppDynamics critical events are present for this application.'
      : 'Application topology is stored; more metric history is needed before automated classification.',
    aiFeatures: {
      criticalEventCount,
      warningEventCount,
      businessTransactionCount: businessTransactions.length,
      nodeCount: nodes.length,
      metricPointCount: metrics.length,
    },
    rawPayload: application,
  });

  businessTransactions.forEach((transaction) => {
    const errorRate = safeNumber(transaction.errorPercent, 0);
    rows.push({
      applicationId: appId,
      sourceModule: 'business_transaction',
      entityId: transaction.businessTransactionId,
      entityName: transaction.businessTransactionName,
      aiLabel: errorRate >= 5 || transaction.health === 'critical' ? 'incident' : 'unknown',
      aiConfidence: errorRate >= 5 ? 0.7 : 0.3,
      aiReason: errorRate >= 5
        ? 'Business transaction error rate is above the initial review threshold.'
        : 'Business transaction metadata is available for future trend comparison.',
      aiFeatures: {
        responseTime: transaction.responseTime,
        callsPerMinute: transaction.callsPerMinute,
        errorsPerMinute: transaction.errorsPerMinute,
        errorPercent: transaction.errorPercent,
        health: transaction.health,
      },
      rawPayload: transaction.rawPayload || transaction,
    });
  });

  nodes.forEach((node) => {
    rows.push({
      applicationId: appId,
      sourceModule: 'node',
      entityId: node.nodeId,
      entityName: node.nodeName,
      aiLabel: node.health === 'critical' ? 'incident' : 'unknown',
      aiConfidence: node.health === 'critical' ? 0.6 : 0.25,
      aiReason: node.health === 'critical'
        ? 'Node health is critical in AppDynamics.'
        : 'Node inventory and current health are stored for later recurrence analysis.',
      aiFeatures: {
        tierName: node.tierName,
        serverName: node.serverName,
        cpu: node.cpu,
        memory: node.memory,
        availability: node.availability,
        health: node.health,
      },
      rawPayload: node.rawPayload || node,
    });
  });

  return rows;
}

function mapBusinessTransactionRecord(config, application, transaction) {
  const appId = getApplicationId(application);
  const appName = getApplicationName(application);

  return {
    sourceTool: SOURCE_TOOL,
    environment: 'production',
    applicationName: appName,
    entityType: 'business_transaction',
    entityId: `${appId}:${transaction.businessTransactionId}`,
    status: transaction.health === 'critical' ? 'critical' : transaction.health === 'warning' ? 'warning' : 'ok',
    severity: transaction.health === 'critical' ? 'critical' : transaction.health === 'warning' ? 'warning' : 'low',
    summary: transaction.businessTransactionName,
    details: `${transaction.tierName || 'Unknown tier'} · ${transaction.callsPerMinute ?? 'n/a'} calls/min · ${transaction.errorsPerMinute ?? 'n/a'} errors/min`,
    acknowledged: false,
    lastCheck: transaction.lastSeenAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    rawPayload: transaction.rawPayload || transaction,
    deepLink: buildApplicationDeepLink(config, appId),
    customProperties: {
      appDynamicsApplicationId: appId,
      businessTransactionId: transaction.businessTransactionId,
      tierName: transaction.tierName,
      responseTime: transaction.responseTime,
      callsPerMinute: transaction.callsPerMinute,
      errorsPerMinute: transaction.errorsPerMinute,
      errorPercent: transaction.errorPercent,
      sourceKind: 'business_transaction',
    },
  };
}

function mapNodeRecord(config, application, node) {
  const appId = getApplicationId(application);
  const appName = getApplicationName(application);

  return {
    sourceTool: SOURCE_TOOL,
    environment: 'production',
    applicationName: appName,
    entityType: 'node',
    entityId: `${appId}:${node.nodeId}`,
    status: node.health === 'critical' ? 'critical' : node.health === 'warning' ? 'warning' : 'ok',
    severity: node.health === 'critical' ? 'critical' : node.health === 'warning' ? 'warning' : 'low',
    summary: node.nodeName,
    details: `${node.tierName || 'Unknown tier'}${node.serverName ? ` · ${node.serverName}` : ''}`,
    acknowledged: false,
    lastCheck: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    rawPayload: node.rawPayload || node,
    deepLink: buildApplicationDeepLink(config, appId),
    customProperties: {
      appDynamicsApplicationId: appId,
      nodeId: node.nodeId,
      tierName: node.tierName,
      serverName: node.serverName,
      cpu: node.cpu,
      memory: node.memory,
      availability: node.availability,
      sourceKind: 'node',
    },
  };
}

async function upsertMonitoringRecords(records = []) {
  await ensureAppDynamicsStorage();

  for (const record of records) {
    await db.query(
      `
        INSERT INTO monitoring_records (
          source_tool,
          environment,
          application_name,
          entity_type,
          entity_id,
          status,
          severity,
          summary,
          details,
          acknowledged,
          last_check,
          updated_at,
          raw_payload,
          deep_link,
          custom_properties
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,COALESCE($12,NOW()),$13::jsonb,$14,$15::jsonb)
        ON CONFLICT (source_tool, entity_type, entity_id)
        DO UPDATE SET
          environment = EXCLUDED.environment,
          application_name = EXCLUDED.application_name,
          status = EXCLUDED.status,
          severity = EXCLUDED.severity,
          summary = EXCLUDED.summary,
          details = EXCLUDED.details,
          acknowledged = EXCLUDED.acknowledged,
          last_check = EXCLUDED.last_check,
          updated_at = COALESCE(EXCLUDED.updated_at, NOW()),
          raw_payload = EXCLUDED.raw_payload,
          deep_link = EXCLUDED.deep_link,
          custom_properties = EXCLUDED.custom_properties
      `,
      [
        record.sourceTool,
        record.environment,
        record.applicationName,
        record.entityType,
        record.entityId,
        record.status,
        record.severity,
        record.summary,
        record.details,
        record.acknowledged,
        record.lastCheck,
        record.updatedAt,
        JSON.stringify(record.rawPayload || {}),
        record.deepLink,
        JSON.stringify(record.customProperties || {}),
      ],
    );
  }
}

async function upsertAppDynamicsApplications(rows = []) {
  for (const row of rows) {
    await db.query(
      `
        INSERT INTO appdynamics_applications (
          application_id,
          application_name,
          health,
          health_color,
          response_time,
          calls,
          calls_per_minute,
          errors,
          errors_per_minute,
          last_updated,
          time_window,
          status,
          tags,
          description,
          raw_payload,
          updated_at
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15::jsonb,NOW())
        ON CONFLICT (application_id)
        DO UPDATE SET
          application_name = EXCLUDED.application_name,
          health = EXCLUDED.health,
          health_color = EXCLUDED.health_color,
          response_time = EXCLUDED.response_time,
          calls = EXCLUDED.calls,
          calls_per_minute = EXCLUDED.calls_per_minute,
          errors = EXCLUDED.errors,
          errors_per_minute = EXCLUDED.errors_per_minute,
          last_updated = EXCLUDED.last_updated,
          time_window = EXCLUDED.time_window,
          status = EXCLUDED.status,
          tags = EXCLUDED.tags,
          description = EXCLUDED.description,
          raw_payload = EXCLUDED.raw_payload,
          updated_at = NOW()
      `,
      [
        row.applicationId,
        row.applicationName,
        row.health,
        row.healthColor,
        row.responseTime,
        row.calls,
        row.callsPerMinute,
        row.errors,
        row.errorsPerMinute,
        row.lastUpdated,
        row.timeWindow,
        row.status,
        JSON.stringify(row.tags || []),
        row.description,
        JSON.stringify(row.rawPayload || {}),
      ],
    );
  }
}

async function upsertAppDynamicsTiers(rows = []) {
  for (const row of rows) {
    await db.query(
      `
        INSERT INTO appdynamics_tiers (
          application_id,
          tier_id,
          tier_name,
          tier_type,
          agent_type,
          number_of_nodes,
          health,
          raw_payload,
          updated_at
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,NOW())
        ON CONFLICT (application_id, tier_id)
        DO UPDATE SET
          tier_name = EXCLUDED.tier_name,
          tier_type = EXCLUDED.tier_type,
          agent_type = EXCLUDED.agent_type,
          number_of_nodes = EXCLUDED.number_of_nodes,
          health = EXCLUDED.health,
          raw_payload = EXCLUDED.raw_payload,
          updated_at = NOW()
      `,
      [
        row.applicationId,
        row.tierId,
        row.tierName,
        row.tierType,
        row.agentType,
        row.numberOfNodes,
        row.health,
        JSON.stringify(row.rawPayload || {}),
      ],
    );
  }
}

async function upsertAppDynamicsBusinessTransactions(rows = []) {
  for (const row of rows) {
    await db.query(
      `
        INSERT INTO appdynamics_business_transactions (
          application_id,
          business_transaction_id,
          business_transaction_name,
          tier_name,
          health,
          response_time,
          calls,
          calls_per_minute,
          errors,
          errors_per_minute,
          error_percent,
          slow_percent,
          very_slow_percent,
          stall_percent,
          normal_percent,
          last_seen_at,
          raw_payload,
          updated_at
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb,NOW())
        ON CONFLICT (application_id, business_transaction_id)
        DO UPDATE SET
          business_transaction_name = EXCLUDED.business_transaction_name,
          tier_name = EXCLUDED.tier_name,
          health = EXCLUDED.health,
          response_time = EXCLUDED.response_time,
          calls = EXCLUDED.calls,
          calls_per_minute = EXCLUDED.calls_per_minute,
          errors = EXCLUDED.errors,
          errors_per_minute = EXCLUDED.errors_per_minute,
          error_percent = EXCLUDED.error_percent,
          slow_percent = EXCLUDED.slow_percent,
          very_slow_percent = EXCLUDED.very_slow_percent,
          stall_percent = EXCLUDED.stall_percent,
          normal_percent = EXCLUDED.normal_percent,
          last_seen_at = EXCLUDED.last_seen_at,
          raw_payload = EXCLUDED.raw_payload,
          updated_at = NOW()
      `,
      [
        row.applicationId,
        row.businessTransactionId,
        row.businessTransactionName,
        row.tierName,
        row.health,
        row.responseTime,
        row.calls,
        row.callsPerMinute,
        row.errors,
        row.errorsPerMinute,
        row.errorPercent,
        row.slowPercent,
        row.verySlowPercent,
        row.stallPercent,
        row.normalPercent,
        row.lastSeenAt,
        JSON.stringify(row.rawPayload || {}),
      ],
    );
  }
}

async function upsertAppDynamicsNodes(rows = []) {
  for (const row of rows) {
    await db.query(
      `
        INSERT INTO appdynamics_nodes (
          application_id,
          node_id,
          node_name,
          tier_id,
          tier_name,
          server_name,
          health,
          response_time,
          calls,
          errors,
          availability,
          cpu,
          memory,
          agent_version,
          raw_payload,
          updated_at
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,NOW())
        ON CONFLICT (application_id, node_id)
        DO UPDATE SET
          node_name = EXCLUDED.node_name,
          tier_id = EXCLUDED.tier_id,
          tier_name = EXCLUDED.tier_name,
          server_name = EXCLUDED.server_name,
          health = EXCLUDED.health,
          response_time = EXCLUDED.response_time,
          calls = EXCLUDED.calls,
          errors = EXCLUDED.errors,
          availability = EXCLUDED.availability,
          cpu = EXCLUDED.cpu,
          memory = EXCLUDED.memory,
          agent_version = EXCLUDED.agent_version,
          raw_payload = EXCLUDED.raw_payload,
          updated_at = NOW()
      `,
      [
        row.applicationId,
        row.nodeId,
        row.nodeName,
        row.tierId,
        row.tierName,
        row.serverName,
        row.health,
        row.responseTime,
        row.calls,
        row.errors,
        row.availability,
        row.cpu,
        row.memory,
        row.agentVersion,
        JSON.stringify(row.rawPayload || {}),
      ],
    );
  }
}

async function upsertAppDynamicsEvents(rows = []) {
  for (const row of rows) {
    await db.query(
      `
        INSERT INTO appdynamics_events (
          application_id,
          event_id,
          severity,
          status,
          event_type,
          tier_name,
          node_name,
          summary,
          description,
          event_time,
          category,
          raw_payload,
          updated_at
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,NOW())
        ON CONFLICT (application_id, event_id)
        DO UPDATE SET
          severity = EXCLUDED.severity,
          status = EXCLUDED.status,
          event_type = EXCLUDED.event_type,
          tier_name = EXCLUDED.tier_name,
          node_name = EXCLUDED.node_name,
          summary = EXCLUDED.summary,
          description = EXCLUDED.description,
          event_time = EXCLUDED.event_time,
          category = EXCLUDED.category,
          raw_payload = EXCLUDED.raw_payload,
          updated_at = NOW()
      `,
      [
        row.applicationId,
        row.eventId,
        row.severity,
        row.status,
        row.eventType,
        row.tierName,
        row.nodeName,
        row.summary,
        row.description,
        row.eventTime,
        row.category,
        JSON.stringify(row.rawPayload || {}),
      ],
    );
  }
}

async function upsertAppDynamicsSnapshots(rows = []) {
  for (const row of rows) {
    await db.query(
      `
        INSERT INTO appdynamics_snapshots (
          application_id,
          snapshot_id,
          business_transaction_id,
          business_transaction_name,
          snapshot_type,
          execution_time_ms,
          sql_call_count,
          remote_call_count,
          exception_count,
          started_at,
          raw_payload,
          updated_at
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,NOW())
        ON CONFLICT (application_id, snapshot_id)
        DO UPDATE SET
          business_transaction_id = EXCLUDED.business_transaction_id,
          business_transaction_name = EXCLUDED.business_transaction_name,
          snapshot_type = EXCLUDED.snapshot_type,
          execution_time_ms = EXCLUDED.execution_time_ms,
          sql_call_count = EXCLUDED.sql_call_count,
          remote_call_count = EXCLUDED.remote_call_count,
          exception_count = EXCLUDED.exception_count,
          started_at = EXCLUDED.started_at,
          raw_payload = EXCLUDED.raw_payload,
          updated_at = NOW()
      `,
      [
        row.applicationId,
        row.snapshotId,
        row.businessTransactionId,
        row.businessTransactionName,
        row.snapshotType,
        row.executionTimeMs,
        row.sqlCallCount,
        row.remoteCallCount,
        row.exceptionCount,
        row.startedAt,
        JSON.stringify(row.rawPayload || {}),
      ],
    );
  }
}

async function upsertAppDynamicsHealthRules(rows = []) {
  for (const row of rows) {
    await db.query(
      `
        INSERT INTO appdynamics_health_rules (
          application_id,
          health_rule_id,
          health_rule_name,
          enabled,
          severity,
          status,
          raw_payload,
          updated_at
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,NOW())
        ON CONFLICT (application_id, health_rule_id)
        DO UPDATE SET
          health_rule_name = EXCLUDED.health_rule_name,
          enabled = EXCLUDED.enabled,
          severity = EXCLUDED.severity,
          status = EXCLUDED.status,
          raw_payload = EXCLUDED.raw_payload,
          updated_at = NOW()
      `,
      [
        row.applicationId,
        row.healthRuleId,
        row.healthRuleName,
        row.enabled,
        row.severity,
        row.status,
        JSON.stringify(row.rawPayload || {}),
      ],
    );
  }
}

async function upsertAppDynamicsMetrics(rows = []) {
  for (const row of rows) {
    await db.query(
      `
        INSERT INTO appdynamics_metrics (
          application_id,
          metric_path,
          metric_name,
          metric_value,
          metric_timestamp,
          time_window,
          raw_payload,
          updated_at
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,NOW())
        ON CONFLICT (application_id, metric_path, metric_timestamp)
        DO UPDATE SET
          metric_name = EXCLUDED.metric_name,
          metric_value = EXCLUDED.metric_value,
          time_window = EXCLUDED.time_window,
          raw_payload = EXCLUDED.raw_payload,
          updated_at = NOW()
      `,
      [
        row.applicationId,
        row.metricPath,
        row.metricName,
        row.metricValue,
        row.metricTimestamp,
        row.timeWindow,
        JSON.stringify(row.rawPayload || {}),
      ],
    );
  }
}

async function upsertAppDynamicsFlowMap(rows = []) {
  for (const row of rows) {
    await db.query(
      `
        INSERT INTO appdynamics_flow_map (
          application_id,
          entity_id,
          entity_type,
          entity_name,
          source_entity_id,
          target_entity_id,
          health,
          latency,
          calls,
          errors,
          raw_payload,
          updated_at
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,NOW())
        ON CONFLICT (application_id, entity_type, entity_id)
        DO UPDATE SET
          entity_name = EXCLUDED.entity_name,
          source_entity_id = EXCLUDED.source_entity_id,
          target_entity_id = EXCLUDED.target_entity_id,
          health = EXCLUDED.health,
          latency = EXCLUDED.latency,
          calls = EXCLUDED.calls,
          errors = EXCLUDED.errors,
          raw_payload = EXCLUDED.raw_payload,
          updated_at = NOW()
      `,
      [
        row.applicationId,
        row.entityId,
        row.entityType,
        row.entityName,
        row.sourceEntityId,
        row.targetEntityId,
        row.health,
        row.latency,
        row.calls,
        row.errors,
        JSON.stringify(row.rawPayload || {}),
      ],
    );
  }
}

async function upsertAppDynamicsAiFeatures(rows = []) {
  for (const row of rows) {
    await db.query(
      `
        INSERT INTO appdynamics_ai_features (
          application_id,
          source_module,
          entity_id,
          entity_name,
          ai_label,
          ai_confidence,
          ai_reason,
          ai_features,
          raw_payload,
          updated_at
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,NOW())
        ON CONFLICT (application_id, source_module, entity_id)
        DO UPDATE SET
          entity_name = EXCLUDED.entity_name,
          ai_label = EXCLUDED.ai_label,
          ai_confidence = EXCLUDED.ai_confidence,
          ai_reason = EXCLUDED.ai_reason,
          ai_features = EXCLUDED.ai_features,
          raw_payload = EXCLUDED.raw_payload,
          updated_at = NOW()
      `,
      [
        row.applicationId,
        row.sourceModule,
        row.entityId,
        row.entityName,
        row.aiLabel,
        row.aiConfidence,
        row.aiReason,
        JSON.stringify(row.aiFeatures || {}),
        JSON.stringify(row.rawPayload || {}),
      ],
    );
  }
}

async function fetchApplications(config, auth = null) {
  const response = await appDynamicsFetch(
    config,
    config.credentials.applicationsPath,
    { output: 'JSON' },
    { auth },
  );

  return {
    ...response,
    applications: toArray(response.payload),
  };
}

async function fetchWorkspaceApplicationInventory(config, auth = null, refresh = false) {
  const key = 'workspace-application-inventory';
  const cached = cachedWorkspaceValue(key);
  if (cached && !refresh) return cached;

  const response = await fetchApplications(config, auth);
  return cacheWorkspaceValue(key, response, WORKSPACE_STATIC_CACHE_TTL_MS);
}

async function resolveLiveApplication(config, applicationIdOrName, auth = null) {
  const response = await fetchApplications(config, auth);
  const requested = String(applicationIdOrName || '').trim();
  const application = response.applications.find((item) => (
    getApplicationId(item) === requested
    || getApplicationName(item) === requested
  ));

  if (!application) {
    const error = new Error('AppDynamics application was not found.');
    error.status = 404;
    throw error;
  }

  return application;
}

async function fetchHealthRules(config, application, auth = null) {
  const path = replaceApplicationTokens(config.credentials.healthRulesPath, application);

  try {
    const response = await appDynamicsFetch(config, path, {}, { auth });
    return toArray(response.payload);
  } catch (error) {
    if (error.status === 404 || error.status === 403) {
      return [];
    }

    throw error;
  }
}

async function fetchPolicies(config, application, auth = null) {
  const path = replaceApplicationTokens(config.credentials.policiesPath, application);
  const response = await appDynamicsFetch(config, path, {}, { auth });

  return toArray(response.payload);
}

async function getApplicationPoliciesReadOnly(applicationIdOrName) {
  const config = await getRuntimeConfig();
  const application = await resolveLiveApplication(config, applicationIdOrName);
  const policies = await fetchPolicies(config, application);

  return {
    application: {
      id: getApplicationId(application),
      name: getApplicationName(application),
    },
    policies: policies.slice(0, 100),
  };
}

async function fetchEvents(config, application, auth = null) {
  const path = replaceApplicationTokens(config.credentials.eventsPath, application);

  try {
    const response = await appDynamicsFetch(
      config,
      path,
      {
        'time-range-type': 'BEFORE_NOW',
        'duration-in-mins': config.credentials.eventDurationMinutes,
        'event-types': config.credentials.eventTypes.join(','),
        severities: config.credentials.eventSeverities,
        output: 'JSON',
      },
      { auth },
    );
    return toArray(response.payload);
  } catch (error) {
    if (error.status === 404 || error.status === 403) {
      return [];
    }

    throw error;
  }
}

async function fetchViolations(config, application, auth = null) {
  const path = replaceApplicationTokens(config.credentials.violationsPath, application);
  const response = await appDynamicsFetch(
    config,
    path,
    {
      'time-range-type': 'BEFORE_NOW',
      'duration-in-mins': config.credentials.eventDurationMinutes,
      output: 'JSON',
    },
    { auth },
  );

  return toArray(response.payload);
}

async function fetchBusinessTransactions(config, application, auth = null) {
  return optionalAppDynamicsFetch(
    config,
    replaceApplicationTokens(config.credentials.businessTransactionsPath, application),
    { output: 'JSON' },
    auth,
  );
}

async function fetchTiers(config, application, auth = null) {
  return optionalAppDynamicsFetch(
    config,
    replaceApplicationTokens(config.credentials.tiersPath, application),
    { output: 'JSON' },
    auth,
  );
}

async function fetchNodes(config, application, auth = null) {
  return optionalAppDynamicsFetch(
    config,
    replaceApplicationTokens(config.credentials.nodesPath, application),
    { output: 'JSON' },
    auth,
  );
}

async function fetchSnapshots(config, application, auth = null) {
  return optionalAppDynamicsFetch(
    config,
    replaceApplicationTokens(config.credentials.snapshotsPath, application),
    appDynamicsTimeQuery(config.credentials.snapshotDurationMinutes),
    auth,
  );
}

async function fetchMetricData(config, application, metricPath, auth = null) {
  const path = replaceApplicationTokens(config.credentials.metricDataPath, application);

  try {
    const response = await appDynamicsFetch(
      config,
      path,
      {
        ...appDynamicsTimeQuery(config.credentials.metricDurationMinutes),
        'metric-path': metricPath,
      },
      { auth },
    );

    return normalizeMetricRows(application, metricPath, response.payload);
  } catch (error) {
    if (error.status === 404 || error.status === 403) {
      return [];
    }

    throw error;
  }
}

function hasReturnedField(value, names = []) {
  if (!value || typeof value !== 'object') return false;
  return names.some((name) => value[name] !== undefined && value[name] !== null && value[name] !== '');
}

function returnedLink(value) {
  if (!value || typeof value !== 'object') return null;
  return value.deepLinkUrl || value.deepLink || value.eventUrl || value.url || value.href || null;
}

function safeDiscoveryError(error) {
  return {
    error: error.message || 'AppDynamics read failed.',
    httpStatus: error.status || null,
    ok: false,
  };
}

async function attemptRead(read) {
  try {
    const response = await read();
    return {
      httpStatus: response.httpStatus || 200,
      ok: true,
      payload: response.payload,
      responseSizeBytes: Buffer.byteLength(JSON.stringify(response.payload ?? null)),
      responseTimeMs: response.responseTimeMs || null,
    };
  } catch (error) {
    return safeDiscoveryError(error);
  }
}

async function attemptValue(read) {
  try {
    return {
      httpStatus: 200,
      ok: true,
      payload: await read(),
    };
  } catch (error) {
    return safeDiscoveryError(error);
  }
}

function workspaceResultStatus(result, records = []) {
  if (!result?.ok) {
    return {
      status: result?.httpStatus === 403 || result?.httpStatus === 404 ? 'unavailable' : 'error',
    };
  }

  return {
    status: records.length > 0 ? 'data' : 'no_data',
  };
}

function addAvailableField(fields, condition, label) {
  if (condition) fields.add(label);
}

function workspaceRange(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  const key = WORKSPACE_RANGE_CONFIG[raw] ? raw : WORKSPACE_RANGE_ALIASES[raw] || '15m';
  return WORKSPACE_RANGE_CONFIG[key];
}

function workspaceTimeQuery(range, now = Date.now()) {
  const explicitStart = Number(range.startTime);
  const explicitEnd = Number(range.endTime);
  if (Number.isFinite(explicitStart) && Number.isFinite(explicitEnd) && explicitEnd > explicitStart) {
    return {
      'end-time': explicitEnd,
      'start-time': explicitStart,
      'time-range-type': 'BETWEEN_TIMES',
    };
  }
  const endTime = Math.floor(now / 60000) * 60000;

  if (range.queryMode === 'BETWEEN_TIMES') {
    return {
      'end-time': endTime,
      'start-time': endTime - (range.durationMinutes * 60000),
      'time-range-type': 'BETWEEN_TIMES',
    };
  }

  return {
    'duration-in-mins': range.durationMinutes,
    'time-range-type': 'BEFORE_NOW',
  };
}

function publicWorkspaceRange(range) {
  return {
    aggregationLabel: range.aggregationLabel,
    durationMinutes: range.durationMinutes,
    key: range.key,
    label: range.label,
    queryMode: range.queryMode,
    targetPoints: range.targetPoints,
  };
}

function cachedWorkspaceValue(key) {
  const cached = workspaceCache.get(key);

  if (!cached || cached.expiresAt <= Date.now()) {
    workspaceCache.delete(key);
    return null;
  }

  return cached.value;
}

function cacheWorkspaceValue(key, value, ttl = WORKSPACE_CACHE_TTL_MS) {
  workspaceCache.set(key, { expiresAt: Date.now() + ttl, value });
  return value;
}

function metricPoints(item) {
  return toArray(item?.metricValues || item?.values || item?.data)
    .map((point) => ({
      timestamp: appDynamicsTimestamp(point.startTimeInMillis, point.startTime, point.timestamp),
      value: safeNumber(point.value ?? point.current ?? point.sum ?? point.count),
    }))
    .filter((point) => point.timestamp && point.value !== null)
    .sort((left, right) => left.timestamp.localeCompare(right.timestamp));
}

function aggregateMetricPoints(points, bucketMinutes) {
  if (!Array.isArray(points) || points.length === 0 || bucketMinutes <= 1) return points || [];
  const bucketMs = bucketMinutes * 60000;
  const buckets = new Map();

  points.forEach((point) => {
    const timestamp = new Date(point.timestamp).getTime();
    if (!Number.isFinite(timestamp)) return;
    const bucketStart = Math.floor(timestamp / bucketMs) * bucketMs;
    const bucket = buckets.get(bucketStart) || { count: 0, sum: 0 };
    bucket.count += 1;
    bucket.sum += point.value;
    buckets.set(bucketStart, bucket);
  });

  return [...buckets.entries()]
    .sort(([left], [right]) => left - right)
    .map(([timestamp, bucket]) => ({
      timestamp: new Date(timestamp).toISOString(),
      value: bucket.sum / bucket.count,
    }));
}

function paginateWorkspaceRecords(records, requestedPage, pageSize) {
  const pageCount = Math.max(1, Math.ceil(records.length / pageSize));
  const page = Math.min(Math.max(1, requestedPage), pageCount);
  const start = (page - 1) * pageSize;

  return {
    items: records.slice(start, start + pageSize),
    page,
    pageCount,
  };
}

function metricKey(item) {
  return String(item?.metricPath || item?.metricName || '').split('|').at(-1) || '';
}

function metricValues(item) {
  return toArray(item?.metricValues || item?.values || item?.data);
}

function metricState(metric, range) {
  return {
    pointCount: metric?.points?.length || 0,
    range: range.key,
    rawPointCount: metric?.rawPointCount || metric?.points?.length || 0,
    status: metric?.points?.length ? 'data' : 'no_data',
  };
}

function metricSummary(payload, rangeValue = '15m') {
  const range = typeof rangeValue === 'object' ? rangeValue : workspaceRange(rangeValue);
  const metrics = {};

  toArray(payload).forEach((item) => {
    const key = metricKey(item);
    const rawPoints = metricPoints(item);
    const points = aggregateMetricPoints(rawPoints, range.bucketMinutes);

    if (!key || points.length === 0) return;

    metrics[key] = {
      latest: points.at(-1)?.value ?? null,
      points,
      rawPointCount: rawPoints.length,
      total: rawPoints.reduce((sum, point) => sum + point.value, 0),
    };
  });

  const callsPerMinute = metrics['Calls per Minute'] || null;
  const errorsPerMinute = metrics['Errors per Minute'] || null;
  const responseTime = metrics['Average Response Time (ms)'] || null;
  const returnedErrorPercent = metrics['Error %'] || null;
  const derivedErrorPercent = callsPerMinute?.latest > 0 && errorsPerMinute?.latest != null
    ? (errorsPerMinute.latest / callsPerMinute.latest) * 100
    : null;
  const hasDerivedErrorPercent = derivedErrorPercent !== null;
  const states = {
    callsPerMinute: metricState(callsPerMinute, range),
    errorPercent: returnedErrorPercent
      ? metricState(returnedErrorPercent, range)
      : {
        pointCount: hasDerivedErrorPercent ? Math.min(callsPerMinute.points.length, errorsPerMinute.points.length) : 0,
        range: range.key,
        rawPointCount: hasDerivedErrorPercent ? Math.min(callsPerMinute.rawPointCount, errorsPerMinute.rawPointCount) : 0,
        status: hasDerivedErrorPercent ? 'data' : 'no_data',
      },
    errorsPerMinute: metricState(errorsPerMinute, range),
    responseTime: metricState(responseTime, range),
  };
  const requestStatus = Object.values(states).some((state) => state.status === 'data') ? 'data' : 'no_data';

  return {
    calls: callsPerMinute?.total ?? null,
    callsPerMinute: callsPerMinute?.latest ?? null,
    errorPercent: returnedErrorPercent?.latest ?? derivedErrorPercent,
    errors: errorsPerMinute?.total ?? null,
    errorsPerMinute: errorsPerMinute?.latest ?? null,
    requestStatus,
    aggregation: publicWorkspaceRange(range),
    responseTime: responseTime?.latest ?? null,
    series: {
      callsPerMinute: callsPerMinute?.points || [],
      errorsPerMinute: errorsPerMinute?.points || [],
      responseTime: responseTime?.points || [],
    },
    states,
  };
}

function failedMetricSummary(error, rangeValue = '15m') {
  const range = typeof rangeValue === 'object' ? rangeValue : workspaceRange(rangeValue);
  const status = error?.status === 403 || error?.status === 404 ? 'unavailable' : 'error';
  const state = { pointCount: 0, range: range.key, rawPointCount: 0, status };

  return {
    calls: null,
    callsPerMinute: null,
    errorPercent: null,
    errors: null,
    errorsPerMinute: null,
    aggregation: publicWorkspaceRange(range),
    requestStatus: status,
    responseTime: null,
    series: {
      callsPerMinute: [],
      errorsPerMinute: [],
      responseTime: [],
    },
    states: {
      callsPerMinute: { ...state },
      errorPercent: { ...state },
      errorsPerMinute: { ...state },
      responseTime: { ...state },
    },
  };
}

function rollupMetricSummary(payload, rangeValue = '15m') {
  const range = typeof rangeValue === 'object' ? rangeValue : workspaceRange(rangeValue);
  const metrics = {};

  toArray(payload).forEach((item) => {
    const key = metricKey(item);
    const values = metricValues(item);
    if (!key || values.length === 0) return;

    const value = values.at(-1);
    const current = safeNumber(value.value ?? value.current ?? value.sum ?? value.count);
    if (current === null) return;

    metrics[key] = {
      current,
      pointCount: values.length,
      sum: safeNumber(value.sum),
    };
  });

  const callsPerMinute = metrics['Calls per Minute'] || null;
  const errorsPerMinute = metrics['Errors per Minute'] || null;
  const responseTime = metrics['Average Response Time (ms)'] || null;
  const returnedErrorPercent = metrics['Error %'] || null;
  const derivedErrorPercent = callsPerMinute?.current > 0 && errorsPerMinute?.current != null
    ? (errorsPerMinute.current / callsPerMinute.current) * 100
    : null;
  const dataState = (metric, derived = false) => ({
    pointCount: metric?.pointCount || (derived ? 1 : 0),
    range: range.key,
    rawPointCount: metric?.pointCount || (derived ? 1 : 0),
    status: metric || derived ? 'data' : 'no_data',
  });
  const states = {
    calls: dataState(callsPerMinute),
    callsPerMinute: dataState(callsPerMinute),
    errorPercent: dataState(returnedErrorPercent, derivedErrorPercent !== null),
    errors: dataState(errorsPerMinute),
    errorsPerMinute: dataState(errorsPerMinute),
    responseTime: dataState(responseTime),
  };

  return {
    calls: callsPerMinute?.sum ?? null,
    callsPerMinute: callsPerMinute?.current ?? null,
    errorPercent: returnedErrorPercent?.current ?? derivedErrorPercent,
    errors: errorsPerMinute?.sum ?? null,
    errorsPerMinute: errorsPerMinute?.current ?? null,
    requestStatus: Object.values(states).some((state) => state.status === 'data') ? 'data' : 'no_data',
    aggregation: publicWorkspaceRange(range),
    responseTime: responseTime?.current ?? null,
    states,
  };
}

function applicationHealth(application) {
  const candidates = [
    ['healthStatus', application?.healthStatus],
    ['health', application?.health],
    ['status', application?.status],
    ['healthColor', application?.healthColor],
    ['color', application?.color],
  ];

  for (const [source, rawValue] of candidates) {
    const value = String(rawValue || '').trim().toLowerCase();
    if (!value) continue;
    if (/critical|severe|fatal|failed|red/.test(value)) return { source, state: 'critical' };
    if (/warning|warn|amber|yellow/.test(value)) return { source, state: 'warning' };
    if (/normal|healthy|^ok$|green/.test(value)) return { source, state: 'healthy' };
  }

  return { source: null, state: 'unknown' };
}

function healthFromViolations(payload) {
  const active = toArray(payload).filter((violation) => {
    const status = String(violation?.incidentStatus || violation?.status || '').trim().toUpperCase();
    return ['OPEN', 'ACTIVE', 'ONGOING'].includes(status);
  });
  const severities = active.map((violation) => (
    String(violation?.severity || violation?.eventSeverity || '').trim().toUpperCase()
  ));

  if (severities.some((severity) => ['CRITICAL', 'ERROR', 'SEVERE'].includes(severity))) {
    return { activeViolationCount: active.length, source: 'active_health_rule_violation', state: 'critical' };
  }
  if (severities.some((severity) => ['WARNING', 'WARN'].includes(severity))) {
    return { activeViolationCount: active.length, source: 'active_health_rule_violation', state: 'warning' };
  }

  return { activeViolationCount: active.length, source: null, state: 'unknown' };
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  }

  await Promise.all(Array.from(
    { length: Math.min(Math.max(1, concurrency), items.length) },
    () => worker(),
  ));
  return results;
}

async function fetchOverallMetrics(config, application, range, auth = null, refresh = false) {
  const applicationId = getApplicationId(application);
  const key = `overall:${applicationId}:${range.key}`;
  const cached = cachedWorkspaceValue(key);
  if (cached && !refresh) return cached;

  try {
    const response = await appDynamicsFetch(
      config,
      replaceApplicationTokens(config.credentials.metricDataPath, application),
      {
        ...workspaceTimeQuery(range),
        'metric-path': OVERALL_METRIC_WILDCARD,
        output: 'JSON',
        rollup: false,
      },
      { auth, timeoutMs: range.timeoutMs },
    );
    const summary = metricSummary(response.payload, range);
    summary.query = {
      aggregationLabel: range.aggregationLabel,
      httpStatus: response.httpStatus,
      queryMode: range.queryMode,
      responseSizeBytes: Buffer.byteLength(JSON.stringify(response.payload ?? null)),
      responseTimeMs: response.responseTimeMs,
    };

    return cacheWorkspaceValue(key, summary, range.cacheTtlMs);
  } catch (error) {
    const summary = failedMetricSummary(error, range);
    summary.query = {
      aggregationLabel: range.aggregationLabel,
      httpStatus: error.status || null,
      queryMode: range.queryMode,
      responseSizeBytes: null,
      responseTimeMs: null,
    };
    return summary;
  }
}

async function fetchApplicationSummaryMetrics(config, application, range, auth = null, refresh = false) {
  const applicationId = getApplicationId(application);
  const key = `overall-summary:${applicationId}:${range.key}`;
  const cached = cachedWorkspaceValue(key);
  if (cached && !refresh) return cached;

  try {
    const response = await appDynamicsFetch(
      config,
      replaceApplicationTokens(config.credentials.metricDataPath, application),
      {
        ...workspaceTimeQuery(range),
        'metric-path': OVERALL_METRIC_WILDCARD,
        output: 'JSON',
        rollup: true,
      },
      { auth, timeoutMs: Math.min(range.timeoutMs, 18000) },
    );
    const summary = rollupMetricSummary(response.payload, range);
    summary.query = {
      httpStatus: response.httpStatus,
      queryMode: range.queryMode,
      responseTimeMs: response.responseTimeMs,
      rollup: true,
    };
    return cacheWorkspaceValue(key, summary, range.cacheTtlMs);
  } catch (error) {
    const summary = failedMetricSummary(error, range);
    summary.query = {
      httpStatus: error.status || null,
      queryMode: range.queryMode,
      responseTimeMs: null,
      rollup: true,
    };
    return cacheWorkspaceValue(key, summary, range.cacheTtlMs);
  }
}

async function fetchApplicationHealth(config, application, auth = null, refresh = false) {
  const applicationId = getApplicationId(application);
  const key = `current-health:${applicationId}`;
  const cached = cachedWorkspaceValue(key);
  if (cached && !refresh) return cached;

  try {
    const response = await appDynamicsFetch(
      config,
      replaceApplicationTokens(config.credentials.violationsPath, application),
      {
        'duration-in-mins': WORKSPACE_HEALTH_DURATION_MINUTES,
        output: 'JSON',
        'time-range-type': 'BEFORE_NOW',
      },
      { auth, timeoutMs: 12000 },
    );
    const health = healthFromViolations(response.payload);
    return cacheWorkspaceValue(key, {
      ...health,
      query: {
        durationMinutes: WORKSPACE_HEALTH_DURATION_MINUTES,
        httpStatus: response.httpStatus,
        responseTimeMs: response.responseTimeMs,
      },
    }, WORKSPACE_HEALTH_CACHE_TTL_MS);
  } catch (error) {
    return cacheWorkspaceValue(key, {
      activeViolationCount: 0,
      query: {
        durationMinutes: WORKSPACE_HEALTH_DURATION_MINUTES,
        httpStatus: error.status || null,
        responseTimeMs: null,
      },
      source: null,
      state: 'unknown',
    }, WORKSPACE_HEALTH_CACHE_TTL_MS);
  }
}

function applicationWorkspaceItem(config, application, metrics = null, includeSeries = true, health = null) {
  const id = getApplicationId(application);
  const presentationMetrics = metrics && !includeSeries
    ? {
      calls: metrics.calls,
      callsPerMinute: metrics.callsPerMinute,
      errorPercent: metrics.errorPercent,
      errors: metrics.errors,
      errorsPerMinute: metrics.errorsPerMinute,
      responseTime: metrics.responseTime,
      states: metrics.states,
    }
    : metrics;

  return {
    id,
    name: getApplicationName(application),
    description: application.description || null,
    health: health || applicationHealth(application),
    metrics: presentationMetrics,
    performanceStatus: metrics?.requestStatus || 'not_requested',
    sourceUrl: buildApplicationDeepLink(config, id),
  };
}

async function getWorkspaceApplications(options = {}) {
  const config = await getRuntimeConfig();
  const page = Math.max(1, Number.parseInt(options.page, 10) || 1);
  const pageSize = WORKSPACE_PAGE_SIZE;
  const range = workspaceRange(options.range);
  const search = String(options.search || '').trim().toLowerCase();
  const sort = 'name';
  const direction = options.direction === 'desc' ? 'desc' : 'asc';
  const applicationsResponse = await fetchWorkspaceApplicationInventory(config, null, options.refresh === true);
  const filtered = applicationsResponse.applications.filter((application) => (
    !search || getApplicationName(application).toLowerCase().includes(search)
  ));
  filtered.sort((left, right) => getApplicationName(left).localeCompare(getApplicationName(right)));

  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, pageCount);
  const start = (safePage - 1) * pageSize;
  const selected = filtered.slice(start, start + pageSize);
  const auth = await getAuthContext(config);
  const summaries = await mapWithConcurrency(
    selected,
    WORKSPACE_SUMMARY_CONCURRENCY,
    async (application) => {
      const directHealth = applicationHealth(application);
      const [metrics, violationHealth] = await Promise.all([
        fetchApplicationSummaryMetrics(
          config,
          application,
          range,
          auth,
          options.refresh === true,
        ),
        directHealth.state === 'unknown'
          ? fetchApplicationHealth(config, application, auth, options.refresh === true)
          : Promise.resolve(directHealth),
      ]);
      return {
        health: directHealth.state === 'unknown' ? violationHealth : directHealth,
        metrics,
      };
    },
  );
  const items = selected.map((application, index) => (
    applicationWorkspaceItem(
      config,
      application,
      summaries[index].metrics,
      false,
      summaries[index].health,
    )
  ));

  items.sort((left, right) => left.name.localeCompare(right.name));

  if (direction === 'desc' && sort === 'name') items.reverse();

  return {
    applications: items,
    connection: {
      applicationCount: applicationsResponse.applications.length,
      authenticationMode: 'oauth',
      connected: true,
      dataMode: 'live_read_only',
    },
    lastUpdated: new Date().toISOString(),
    pagination: {
      page: safePage,
      pageCount,
      pageSize,
      total: filtered.length,
    },
    query: { direction, range: range.key, search: options.search || '', sort },
    summary: {
      concurrency: WORKSPACE_SUMMARY_CONCURRENCY,
      healthCacheTtlMs: WORKSPACE_HEALTH_CACHE_TTL_MS,
      healthDurationMinutes: WORKSPACE_HEALTH_DURATION_MINUTES,
      healthStrategy: 'visible_page_active_health_rule_violations',
      requested: selected.length,
      rollup: true,
    },
    sortScope: 'all_matching_applications',
  };
}

async function getApplicationIdentityInventory(options = {}) {
  const config = await getRuntimeConfig();
  const response = await fetchWorkspaceApplicationInventory(config, null, options.refresh === true);
  return {
    applications: response.applications.map((application) => ({
      id: getApplicationId(application),
      name: getApplicationName(application),
      sourceUrl: buildApplicationDeepLink(config, getApplicationId(application)),
    })),
    lastUpdated: new Date().toISOString(),
    readOnly: true,
  };
}

function businessTransactionIdentityFromMetric(item) {
  const metricName = String(item?.metricName || '');
  const id = metricName.match(/(?:^|\|)BT:(\d+)(?:\||$)/)?.[1] || null;
  const segments = String(item?.metricPath || '').split('|');

  return {
    id,
    name: segments.length >= 5 ? segments.at(-2) : null,
    tierName: segments.length >= 5 ? segments.at(-3) : null,
  };
}

async function fetchBusinessTransactionMetricMap(config, application, range, auth = null, refresh = false) {
  const applicationId = getApplicationId(application);
  const key = `bt-metrics:${applicationId}:${range.key}`;
  const cached = cachedWorkspaceValue(key);
  if (cached && !refresh) return cached;

  const responses = await Promise.all(BUSINESS_TRANSACTION_METRICS.map(async (metricName) => {
    const response = await appDynamicsFetch(
      config,
      replaceApplicationTokens(config.credentials.metricDataPath, application),
      {
        ...workspaceTimeQuery(range),
        'metric-path': `Business Transaction Performance|Business Transactions|*|*|${metricName}`,
        output: 'JSON',
        rollup: range.durationMinutes >= DAY_MINUTES,
      },
      { auth, timeoutMs: range.timeoutMs },
    );
    return { metricName, payload: response.payload, response };
  }));
  const map = new Map();

  responses.forEach(({ metricName, payload }) => {
    toArray(payload).forEach((item) => {
      const identity = businessTransactionIdentityFromMetric(item);
      const keyValue = identity.id || `${identity.tierName || ''}:${identity.name || ''}`;
      if (!keyValue) return;
      const points = metricPoints(item);
      if (points.length === 0) return;
      const current = map.get(keyValue) || { ...identity };
      current[metricName] = points.at(-1).value;
      current.series = { ...(current.series || {}), [metricName]: points };
      map.set(keyValue, current);
    });
  });

  return cacheWorkspaceValue(key, {
    map,
    query: {
      aggregationLabel: range.durationMinutes >= DAY_MINUTES ? 'Single AppDynamics rollup per transaction' : range.aggregationLabel,
      queryMode: range.queryMode,
      responseSizeBytes: responses.reduce((sum, item) => sum + Buffer.byteLength(JSON.stringify(item.payload ?? null)), 0),
      responseTimeMs: responses.reduce((sum, item) => sum + (item.response.responseTimeMs || 0), 0),
      rollup: range.durationMinutes >= DAY_MINUTES,
    },
    status: map.size > 0 ? 'data' : 'no_data',
  }, range.cacheTtlMs);
}

function backendPropertyMap(backend) {
  const result = {};
  const properties = Array.isArray(backend.properties)
    ? backend.properties
    : Array.isArray(backend.properties?.property)
      ? backend.properties.property
      : Array.isArray(backend.properties?.['name-value'])
        ? backend.properties['name-value']
        : [];

  properties.forEach((property) => {
    if (property?.name && property?.value !== undefined) {
      result[property.name] = property.value;
    }
  });
  return result;
}

function normalizeWorkspaceBackend(backend, tiersById) {
  const type = backend.exitPointType || backend.type || null;
  return {
    id: String(backend.id || backend.backendId || backend.name),
    name: backend.name || `Backend ${backend.id}`,
    properties: backendPropertyMap(backend),
    tierId: backend.tierId ? String(backend.tierId) : null,
    tierName: tiersById.get(String(backend.tierId))?.name || null,
    type,
  };
}

function normalizedWorkspaceEvent(event, application = null, endpointCategory = null) {
  const affected = toArray(event.affectedEntities || event.affectedEntityDefinitions);
  const affectedEntity = event.affectedEntityDefinition || event.triggeredEntity || affected[0] || null;
  const entityOfType = (pattern) => affected.find((entity) => pattern.test(String(entity.entityType || entity.type || '')));
  const tier = entityOfType(/APPLICATION_COMPONENT$/i);
  const node = entityOfType(/NODE/i);
  const businessTransaction = entityOfType(/BUSINESS_TRANSACTION/i);

  const type = event.type || event.eventType || event.eventTypeKey || event.incidentStatus || null;
  const normalizedType = String(type || event.state || event.status || '').toUpperCase();
  const terminal = /(?:^|_)(RESOLVED|RECOVERED|CANCELLED|ENDED|CLOSE|CLOSED)(?:_|$)/.test(normalizedType)
    || /^(RESOLVED|RECOVERED|CANCELLED|ENDED|CLOSE|CLOSED)$/.test(normalizedType);
  const startedAt = appDynamicsTimestamp(event.startTimeInMillis, event.startTime, event.detectedTimeInMillis,
    event.eventTime, event.eventTimeString, event.timestamp);
  const endedAt = appDynamicsTimestamp(event.endTimeInMillis, event.resolvedTimeInMillis,
    event.cancelledTimeInMillis, event.endTime, event.resolvedAt, event.cancelledAt,
    terminal ? event.eventTime : null, terminal ? event.eventTimeString : null);
  const applicationId = application ? getApplicationId(application) : event.applicationId || null;
  const applicationName = application ? getApplicationName(application) : event.applicationName || null;

  return {
    applicationId,
    applicationName,
    affectedEntity: affectedEntity?.name || null,
    affectedEntityId: affectedEntity?.entityId || affectedEntity?.id || event.affectedEntityId || null,
    businessTransaction: businessTransaction?.name || event.businessTransactionName || null,
    businessTransactionId: businessTransaction?.entityId || businessTransaction?.id || event.businessTransactionId || null,
    deepLink: returnedLink(event),
    healthRule: event.healthRuleName || event.name || null,
    healthRuleId: event.healthRuleId || event.healthRule?.id || null,
    id: String(event.id || event.eventId || event.guid || ''),
    eventId: endpointCategory === 'events' ? String(event.id || event.eventId || event.guid || '') : null,
    violationId: endpointCategory === 'healthrule-violations'
      ? String(event.id || event.eventId || event.guid || '') : event.violationId || null,
    message: event.summary || event.description || event.eventMessage || null,
    node: node?.name || event.nodeName || null,
    nodeId: node?.entityId || node?.id || event.nodeId || null,
    policy: event.policyName || event.triggeredEntityDefinition?.name || null,
    policyId: event.policyId || event.policy?.id || null,
    severity: event.severity || event.eventSeverity || null,
    state: event.state || event.status || event.incidentStatus || type || null,
    currentState: terminal ? 'RECOVERED' : 'FIRING',
    terminal,
    terminalState: terminal ? normalizedType : null,
    startedAt,
    endedAt,
    recoveryAt: terminal ? endedAt : null,
    resolvedAt: /RESOLVED|RECOVERED|CLOSE|CLOSED/.test(normalizedType) ? endedAt : null,
    cancelledAt: /CANCELLED/.test(normalizedType) ? endedAt : null,
    tier: tier?.name || event.tierName || null,
    tierId: tier?.entityId || tier?.id || event.tierId || null,
    time: startedAt,
    type,
    rawPayload: event,
  };
}

async function fetchWorkspaceStaticData(config, application, auth, refresh = false) {
  const applicationId = getApplicationId(application);
  const key = `workspace-static:${applicationId}`;
  const cached = cachedWorkspaceValue(key);
  if (cached && !refresh) return cached;

  const [tiersResult, nodesResult, transactionsResult, healthRulesResult, policiesResult, backendsResult] = await Promise.all([
    attemptValue(() => fetchTiers(config, application, auth)),
    attemptValue(() => fetchNodes(config, application, auth)),
    attemptValue(() => fetchBusinessTransactions(config, application, auth)),
    attemptRead(() => appDynamicsFetch(config, replaceApplicationTokens(config.credentials.healthRulesPath, application), {}, { auth })),
    attemptRead(() => appDynamicsFetch(config, replaceApplicationTokens(config.credentials.policiesPath, application), {}, { auth })),
    attemptRead(() => appDynamicsFetch(config, `/controller/rest/applications/${encodeURIComponent(applicationId)}/backends`, { output: 'JSON' }, { auth })),
  ]);

  return cacheWorkspaceValue(key, {
    backendsResult,
    healthRulesResult,
    nodesResult,
    policiesResult,
    tiersResult,
    transactionsResult,
  }, WORKSPACE_STATIC_CACHE_TTL_MS);
}

async function fetchWorkspaceEvents(config, application, range, auth, refresh = false) {
  const applicationId = getApplicationId(application);
  const key = `workspace-events:${applicationId}:${range.key}`;
  const cached = cachedWorkspaceValue(key);
  if (cached && !refresh) return cached;
  const timeQuery = workspaceTimeQuery(range);
  const eventTimeoutMs = Math.min(range.timeoutMs, 15000);
  const [eventsResult, violationsResult] = await Promise.all([
    attemptRead(() => appDynamicsFetch(config, replaceApplicationTokens(config.credentials.eventsPath, application), {
      ...timeQuery,
      'event-types': config.credentials.eventTypes.join(','),
      output: 'JSON',
      severities: config.credentials.eventSeverities,
    }, { auth, timeoutMs: eventTimeoutMs })),
    attemptRead(() => appDynamicsFetch(config, replaceApplicationTokens(config.credentials.violationsPath, application), {
      ...timeQuery,
      output: 'JSON',
    }, { auth, timeoutMs: eventTimeoutMs })),
  ]);
  const eventRecords = eventsResult.ok ? toArray(eventsResult.payload).map((event) => {
    const normalized = normalizedWorkspaceEvent(event, application, 'events');
    return {
      ...normalized,
      deepLink: normalized.deepLink || buildEventDeepLink(config, normalized.id),
      endpointCategory: 'events',
    };
  }) : [];
  const violationRecords = violationsResult.ok ? toArray(violationsResult.payload).map((event) => {
    const normalized = normalizedWorkspaceEvent(event, application, 'healthrule-violations');
    return {
      ...normalized,
      deepLink: normalized.deepLink || buildEventDeepLink(config, normalized.id),
      endpointCategory: 'healthrule-violations',
    };
  }) : [];
  const records = [...eventRecords, ...violationRecords]
    .filter((event) => event.id || event.message)
    .sort((left, right) => String(right.time || '').localeCompare(String(left.time || '')));
  const readResult = eventsResult.ok || violationsResult.ok
    ? { ok: true }
    : { httpStatus: eventsResult.httpStatus || violationsResult.httpStatus, ok: false };

  return cacheWorkspaceValue(key, {
    controllerTruncated: eventRecords.length >= WORKSPACE_EVENT_CONTROLLER_LIMIT || violationRecords.length >= WORKSPACE_EVENT_CONTROLLER_LIMIT,
    query: {
      httpStatus: eventsResult.ok || violationsResult.ok ? 200 : eventsResult.httpStatus || violationsResult.httpStatus || null,
      httpStatuses: {
        events: eventsResult.httpStatus || null,
        violations: violationsResult.httpStatus || null,
      },
      partial: eventsResult.ok !== violationsResult.ok,
      queryMode: range.queryMode,
      responseSizeBytes: (eventsResult.responseSizeBytes || 0) + (violationsResult.responseSizeBytes || 0),
      responseTimeMs: (eventsResult.responseTimeMs || 0) + (violationsResult.responseTimeMs || 0),
    },
    readResult,
    records,
  }, range.cacheTtlMs);
}

async function getWorkspaceApplication(applicationIdOrName, options = {}) {
  const config = await getRuntimeConfig();
  const range = workspaceRange(options.range);
  const eventPage = Math.max(1, Number.parseInt(options.eventPage, 10) || 1);
  const eventPageSize = Math.min(WORKSPACE_EVENT_PAGE_SIZE, Math.max(25, Number.parseInt(options.eventPageSize, 10) || WORKSPACE_EVENT_PAGE_SIZE));
  const requested = String(applicationIdOrName || '').trim();
  const cacheKey = `workspace-detail:${requested}:${range.key}:events-${eventPage}-${eventPageSize}`;
  if (!options.refresh) {
    const cached = cachedWorkspaceValue(cacheKey);
    if (cached) return cached;
  }

  const auth = await getAuthContext(config);
  const applicationsResponse = await fetchWorkspaceApplicationInventory(config, auth);
  const application = applicationsResponse.applications.find((item) => (
    getApplicationId(item) === requested || getApplicationName(item) === requested
  ));
  if (!application) {
    const error = new Error('AppDynamics application was not found.');
    error.status = 404;
    throw error;
  }
  const [
    metrics,
    staticData,
    eventData,
    transactionMetricsResult,
  ] = await Promise.all([
    fetchOverallMetrics(config, application, range, auth, options.refresh === true),
    fetchWorkspaceStaticData(config, application, auth, options.refreshStatic === true),
    fetchWorkspaceEvents(config, application, range, auth, options.refresh === true),
    fetchBusinessTransactionMetricMap(config, application, range, auth, options.refresh === true)
      .then((payload) => ({ ok: true, payload }))
      .catch((error) => safeDiscoveryError(error)),
  ]);

  const {
    backendsResult,
    healthRulesResult,
    nodesResult,
    policiesResult,
    tiersResult,
    transactionsResult,
  } = staticData;
  const tiersRaw = tiersResult.ok ? toArray(tiersResult.payload) : [];
  const nodesRaw = nodesResult.ok ? toArray(nodesResult.payload) : [];
  const transactionsRaw = transactionsResult.ok ? toArray(transactionsResult.payload) : [];

  const tiers = tiersRaw.map((tier) => ({
    agentType: tier.agentType || tier.agentTypeName || null,
    id: String(tier.id || tier.tierId || tier.name),
    name: tier.name || tier.tierName || null,
    numberOfNodes: safeNumber(tier.numberOfNodes ?? tier.nodeCount),
    type: tier.type || tier.tierType || null,
  }));
  const tiersById = new Map(tiers.map((tier) => [tier.id, tier]));
  const nodes = nodesRaw.map((node) => ({
    agentPresent: safeBoolean(node.appAgentPresent, false),
    agentType: node.agentType || null,
    agentVersion: node.appAgentVersion || node.agentVersion || null,
    host: node.machineName || node.serverName || node.hostName || null,
    id: String(node.id || node.nodeId || node.name),
    jvm: node.jvmVersion || node.javaVersion || null,
    machineAgentPresent: node.machineAgentPresent === undefined ? null : safeBoolean(node.machineAgentPresent),
    name: node.name || node.nodeName || null,
    operatingSystem: node.machineOSType || node.operatingSystem || null,
    tierId: node.tierId ? String(node.tierId) : null,
    tierName: node.tierName || tiersById.get(String(node.tierId))?.name || null,
    type: node.type || null,
  }));
  const transactionMetrics = transactionMetricsResult.ok && transactionMetricsResult.payload?.map instanceof Map
    ? transactionMetricsResult.payload.map
    : new Map();
  const transactionMetricReadStatus = transactionMetricsResult.ok
    ? transactionMetricsResult.payload?.status || 'no_data'
    : workspaceResultStatus(transactionMetricsResult).status;
  const businessTransactions = transactionsRaw.map((transaction) => {
    const id = String(transaction.id || transaction.businessTransactionId || transaction.name);
    const fallbackKey = `${transaction.tierName || transaction.tier || ''}:${transaction.name || transaction.businessTransactionName || ''}`;
    const performance = transactionMetrics.get(id) || transactionMetrics.get(fallbackKey) || {};
    const callsPerMinute = safeNumber(performance['Calls per Minute']);
    const errorsPerMinute = safeNumber(performance['Errors per Minute']);
    const responseTime = safeNumber(performance['Average Response Time (ms)']);
    const hasMetricData = callsPerMinute !== null || errorsPerMinute !== null || responseTime !== null;
    return {
      callsPerMinute,
      entryPointType: transaction.entryPointType || transaction.type || null,
      errorPercent: callsPerMinute > 0 && errorsPerMinute !== null ? (errorsPerMinute / callsPerMinute) * 100 : null,
      errorsPerMinute,
      id,
      metricStatus: hasMetricData ? 'data' : transactionMetricReadStatus === 'data' ? 'no_data' : transactionMetricReadStatus,
      name: transaction.name || transaction.businessTransactionName || null,
      responseTime,
      tierName: transaction.tierName || transaction.tier || null,
    };
  });
  const healthRules = healthRulesResult.ok ? toArray(healthRulesResult.payload).slice(0, 200).map((rule) => ({
    enabled: rule.enabled !== false,
    id: String(rule.id || rule.healthRuleId || rule.name),
    name: rule.name || rule.displayName || null,
  })) : [];
  const policies = policiesResult.ok ? toArray(policiesResult.payload).slice(0, 200).map((policy) => ({
    enabled: policy.enabled !== false,
    id: String(policy.id || policy.policyId || policy.name),
    name: policy.name || policy.displayName || null,
  })) : [];
  const backends = backendsResult.ok
    ? toArray(backendsResult.payload).map((backend) => normalizeWorkspaceBackend(backend, tiersById))
    : [];
  const databaseCalls = backends.filter((backend) => DATABASE_EXIT_POINT_PATTERN.test(String(backend.type || backend.name || '')));
  const remoteServices = backends.filter((backend) => !DATABASE_EXIT_POINT_PATTERN.test(String(backend.type || backend.name || '')));
  const dependencyNodes = [
    { id: `application:${getApplicationId(application)}`, label: getApplicationName(application), type: 'application' },
    ...tiers.map((tier) => ({ id: `tier:${tier.id}`, label: tier.name, type: 'tier' })),
    ...backends.map((backend) => ({
      id: `backend:${backend.id}`,
      label: backend.name,
      type: databaseCalls.some((item) => item.id === backend.id) ? 'database' : 'remote_service',
    })),
  ];
  const dependencyEdges = [
    ...tiers.map((tier) => ({ source: `application:${getApplicationId(application)}`, target: `tier:${tier.id}` })),
    ...backends.filter((backend) => backend.tierId).map((backend) => ({ source: `tier:${backend.tierId}`, target: `backend:${backend.id}` })),
  ];
  const eventResultPage = paginateWorkspaceRecords(eventData.records, eventPage, eventPageSize);
  const backendStatus = workspaceResultStatus(backendsResult, backends).status;
  const resourceStatus = {
    backends: { status: backendStatus },
    businessTransactionMetrics: { status: transactionMetricReadStatus },
    businessTransactions: workspaceResultStatus(transactionsResult, businessTransactions),
    databaseCalls: { status: backendStatus === 'data' ? (databaseCalls.length ? 'data' : 'no_data') : backendStatus },
    events: {
      ...workspaceResultStatus(eventData.readResult, eventData.records),
      partial: eventData.query.partial,
    },
    healthRules: workspaceResultStatus(healthRulesResult, healthRules),
    metrics: { status: metrics.requestStatus },
    nodes: workspaceResultStatus(nodesResult, nodes),
    policies: workspaceResultStatus(policiesResult, policies),
    remoteServices: { status: backendStatus === 'data' ? (remoteServices.length ? 'data' : 'no_data') : backendStatus },
    serviceEndpoints: { status: 'unavailable' },
    tiers: workspaceResultStatus(tiersResult, tiers),
  };

  const result = {
    application: applicationWorkspaceItem(config, application, metrics),
    backends,
    businessTransactions,
    capabilities: {
      databaseCalls: backendsResult.ok,
      dependencyRelationships: backendsResult.ok && dependencyEdges.length > tiers.length,
      events: eventData.readResult.ok,
      healthRules: healthRulesResult.ok,
      policies: policiesResult.ok,
      remoteServices: backendsResult.ok,
      serviceEndpoints: false,
    },
    connection: {
      authenticationMode: 'oauth',
      connected: true,
      dataMode: 'live_read_only',
    },
    databaseCalls,
    dependencySummary: { edges: dependencyEdges, nodes: dependencyNodes },
    eventPagination: {
      bounded: true,
      controllerMaximumPerRequest: WORKSPACE_EVENT_CONTROLLER_LIMIT,
      controllerTruncated: eventData.controllerTruncated,
      page: eventResultPage.page,
      pageCount: eventResultPage.pageCount,
      pageSize: eventPageSize,
      returned: eventResultPage.items.length,
      totalAvailableInResponse: eventData.records.length,
    },
    events: eventResultPage.items,
    healthRules,
    lastUpdated: new Date().toISOString(),
    nodes,
    policies,
    queryDiagnostics: {
      businessTransactionMetrics: transactionMetricsResult.payload?.query || null,
      events: eventData.query,
      metrics: metrics.query || null,
    },
    range: range.key,
    rangeConfig: publicWorkspaceRange(range),
    remoteServices,
    resources: resourceStatus,
    telemetryProfile: {
      agentTypes: [...new Set(tiers.map((tier) => tier.agentType).filter(Boolean))],
      metrics: metrics.requestStatus,
      nodeReporting: resourceStatus.nodes.status,
      tierTypes: [...new Set(tiers.map((tier) => tier.type).filter(Boolean))],
    },
    tiers,
  };

  return cacheWorkspaceValue(cacheKey, result, range.cacheTtlMs);
}

async function queryApplicationEvidence(applicationIdOrName, options = {}) {
  const from = new Date(options.from || 0).getTime();
  const to = new Date(options.to || 0).getTime();
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
    const error = new Error('A valid bounded AppDynamics evidence window is required.');
    error.status = 400;
    throw error;
  }

  const config = await getRuntimeConfig();
  const auth = await getAuthContext(config);
  const applicationsResponse = await fetchWorkspaceApplicationInventory(config, auth);
  const requested = String(applicationIdOrName || '').trim();
  const application = applicationsResponse.applications.find((item) => (
    getApplicationId(item) === requested || getApplicationName(item) === requested
  ));
  if (!application) {
    const error = new Error('AppDynamics application was not found.');
    error.status = 404;
    throw error;
  }

  const baseRange = workspaceRange('15m');
  const range = {
    ...baseRange,
    durationMinutes: Math.max(1, Math.ceil((to - from) / 60000)),
    endTime: to,
    key: `evidence-${from}-${to}`,
    queryMode: 'BETWEEN_TIMES',
    startTime: from,
  };
  const [metrics, eventData] = await Promise.all([
    fetchOverallMetrics(config, application, range, auth, options.refresh === true),
    fetchWorkspaceEvents(config, application, range, auth, options.refresh === true),
  ]);

  return {
    application: applicationWorkspaceItem(config, application, metrics),
    events: eventData.records,
    metrics,
    queryDiagnostics: {
      events: eventData.query,
      metrics: metrics.query || null,
      window: { from: new Date(from).toISOString(), to: new Date(to).toISOString() },
    },
    readOnly: true,
  };
}

/**
 * Performs bounded, GET-only discovery against AppDynamics. It deliberately
 * avoids connection-state updates, sync/storage writes, and all controller
 * mutation endpoints.
 */
async function validateReadOnlyConnection(options = {}) {
  const config = await getRuntimeConfig();
  const maxApplications = Math.min(safeInteger(options.maxApplications, 5), 5);
  const maxItems = Math.min(safeInteger(options.maxItems, 5), 5);

  if (config.missing.length > 0) {
    const error = new Error(`AppDynamics is missing required fields: ${config.missing.join(', ')}.`);
    error.status = 400;
    error.connectionStatus = 'authentication_required';
    throw error;
  }

  if (config.credentials.authMode !== 'api_client') {
    const error = new Error('AppDynamics read validation requires OAuth API-client authentication mode.');
    error.status = 400;
    error.connectionStatus = 'unsupported_authentication_mode';
    throw error;
  }

  const auth = await getAuthContext(config);
  const applicationsResponse = await appDynamicsFetch(
    config,
    config.credentials.applicationsPath,
    { output: 'JSON' },
    { auth },
  );
  const allApplications = toArray(applicationsResponse.payload);
  const applications = allApplications.slice(0, maxApplications);
  const selectedIdentifier = String(options.applicationId || options.applicationName || '').trim();
  const application = (
    selectedIdentifier
      ? applications.find((item) => (
        getApplicationId(item) === selectedIdentifier
        || getApplicationName(item) === selectedIdentifier
      ))
      : null
  ) || applications[0] || null;
  const usefulFields = new Set();
  const sourceLinks = [];

  applications.forEach((item) => {
    addAvailableField(usefulFields, hasReturnedField(item, ['name', 'applicationName']), 'Application');
    addAvailableField(usefulFields, hasReturnedField(item, ['id', 'applicationId']), 'Application ID');
    addAvailableField(usefulFields, hasReturnedField(item, ['description']), 'Application description');
    if (returnedLink(item)) sourceLinks.push(returnedLink(item));
  });

  const result = {
    applications: {
      count: applications.length,
      items: applications.map((item) => ({
        id: getApplicationId(item),
        name: getApplicationName(item),
      })),
      names: applications.map(getApplicationName),
      ok: true,
      totalVisible: allApplications.length,
    },
    authentication: 'success',
    authenticationModel: 'oauth_api_client',
    controllerReachable: true,
    httpStatus: applicationsResponse.httpStatus || 200,
    selectedApplication: application
      ? { id: getApplicationId(application), name: getApplicationName(application) }
      : null,
    sourceLinksAvailable: false,
  };

  if (!application) {
    return {
      ...result,
      businessTransactions: { ok: true, count: 0, httpStatus: null },
      events: { ok: true, count: 0, httpStatus: null },
      healthRules: { ok: true, count: 0, httpStatus: null },
      metrics: { ok: true, count: 0, httpStatus: null },
      nodes: { ok: true, count: 0, httpStatus: null },
      policies: { ok: true, count: 0, httpStatus: null },
      tiers: { ok: true, count: 0, httpStatus: null },
      violations: { ok: true, count: 0, httpStatus: null },
      usefulFields: [...usefulFields],
    };
  }

  const tiersRead = await attemptRead(() => appDynamicsFetch(
    config,
    replaceApplicationTokens(config.credentials.tiersPath, application),
    { output: 'JSON' },
    { auth },
  ));
  const tiers = tiersRead.ok ? toArray(tiersRead.payload).slice(0, maxItems) : [];
  tiers.forEach((item) => {
    addAvailableField(usefulFields, hasReturnedField(item, ['name', 'tierName', 'displayName']), 'Tier');
    addAvailableField(usefulFields, hasReturnedField(item, ['id', 'tierId']), 'Tier ID');
    addAvailableField(usefulFields, hasReturnedField(item, ['type', 'tierType', 'entryPointType']), 'Tier Type');
    addAvailableField(usefulFields, hasReturnedField(item, ['health', 'status', 'healthStatus']), 'Tier health/status');
    addAvailableField(usefulFields, hasReturnedField(item, ['agentType', 'agentTypeName']), 'Tier agent type');
    if (returnedLink(item)) sourceLinks.push(returnedLink(item));
  });
  result.tiers = tiersRead.ok
    ? { count: tiers.length, httpStatus: tiersRead.httpStatus, ok: true }
    : tiersRead;

  const nodesRead = await attemptRead(() => appDynamicsFetch(
    config,
    replaceApplicationTokens(config.credentials.nodesPath, application),
    { output: 'JSON' },
    { auth },
  ));
  const nodes = nodesRead.ok ? toArray(nodesRead.payload).slice(0, maxItems) : [];
  nodes.forEach((item) => {
    addAvailableField(usefulFields, hasReturnedField(item, ['name', 'nodeName', 'displayName']), 'Node');
    addAvailableField(usefulFields, hasReturnedField(item, ['id', 'nodeId']), 'Node ID');
    addAvailableField(usefulFields, hasReturnedField(item, ['tierName', 'tier', 'tierId']), 'Node tier');
    addAvailableField(usefulFields, hasReturnedField(item, ['appAgentVersion', 'agentVersion']), 'Agent version');
    addAvailableField(usefulFields, hasReturnedField(item, ['machineName', 'serverName', 'hostName']), 'Host/server');
    addAvailableField(usefulFields, hasReturnedField(item, ['health', 'status', 'healthStatus']), 'Node health/status');
    addAvailableField(usefulFields, hasReturnedField(item, ['environment']), 'Environment');
    if (returnedLink(item)) sourceLinks.push(returnedLink(item));
  });
  result.nodes = nodesRead.ok
    ? { count: nodes.length, httpStatus: nodesRead.httpStatus, ok: true }
    : nodesRead;

  const businessTransactionsRead = await attemptRead(() => appDynamicsFetch(
    config,
    replaceApplicationTokens(config.credentials.businessTransactionsPath, application),
    { output: 'JSON' },
    { auth },
  ));
  const businessTransactions = businessTransactionsRead.ok
    ? toArray(businessTransactionsRead.payload).slice(0, maxItems)
    : [];
  businessTransactions.forEach((item) => {
    addAvailableField(usefulFields, hasReturnedField(item, ['name', 'businessTransactionName', 'displayName']), 'Business Transaction');
    addAvailableField(usefulFields, hasReturnedField(item, ['id', 'businessTransactionId']), 'Business Transaction ID');
    addAvailableField(usefulFields, hasReturnedField(item, ['tierName', 'tier']), 'Business Transaction tier');
    addAvailableField(usefulFields, hasReturnedField(item, ['entryPoint', 'entryPointType', 'type']), 'Business Transaction entry point/type');
    addAvailableField(usefulFields, hasReturnedField(item, ['health', 'healthStatus', 'status']), 'Business Transaction health');
    addAvailableField(usefulFields, hasReturnedField(item, ['calls', 'callCount', 'callsPerMinute', 'cpm']), 'Business Transaction calls/load');
    addAvailableField(usefulFields, hasReturnedField(item, ['responseTime', 'averageResponseTime', 'averageResponseTimeInMillis']), 'Business Transaction response time');
    addAvailableField(usefulFields, hasReturnedField(item, ['errors', 'errorCount', 'errorsPerMinute', 'errorPercent']), 'Business Transaction errors/error rate');
    if (returnedLink(item)) sourceLinks.push(returnedLink(item));
  });
  result.businessTransactions = businessTransactionsRead.ok
    ? { count: businessTransactions.length, httpStatus: businessTransactionsRead.httpStatus, ok: true }
    : businessTransactionsRead;

  const eventsRead = await attemptRead(() => appDynamicsFetch(
    config,
    replaceApplicationTokens(config.credentials.eventsPath, application),
    {
      'duration-in-mins': Math.min(safeInteger(options.eventDurationMinutes, 15), 60),
      'event-types': config.credentials.eventTypes.join(','),
      output: 'JSON',
      severities: config.credentials.eventSeverities,
      'time-range-type': 'BEFORE_NOW',
    },
    { auth },
  ));
  const events = eventsRead.ok ? toArray(eventsRead.payload).slice(0, maxItems) : [];
  events.forEach((item) => {
    addAvailableField(usefulFields, hasReturnedField(item, ['id', 'eventId', 'guid']), 'Event ID');
    addAvailableField(usefulFields, hasReturnedField(item, ['type', 'eventType', 'eventTypeKey']), 'Event Type');
    addAvailableField(usefulFields, hasReturnedField(item, ['summary', 'description', 'eventMessage']), 'Event Message');
    addAvailableField(usefulFields, hasReturnedField(item, ['severity', 'eventSeverity']), 'Severity');
    addAvailableField(usefulFields, hasReturnedField(item, ['eventTime', 'eventTimeString', 'timestamp']), 'Event Time');
    addAvailableField(usefulFields, hasReturnedField(item, ['applicationName', 'application']), 'Event application');
    addAvailableField(usefulFields, hasReturnedField(item, ['tierName', 'tier']), 'Event tier');
    addAvailableField(usefulFields, hasReturnedField(item, ['nodeName', 'node']), 'Event node');
    addAvailableField(usefulFields, hasReturnedField(item, ['healthRuleName', 'healthRule', 'healthRuleId']), 'Health Rule');
    addAvailableField(usefulFields, hasReturnedField(item, ['policyName', 'policy', 'policyId']), 'Policy');
    addAvailableField(usefulFields, hasReturnedField(item, ['violationId', 'violationStatus', 'healthRuleEvent']), 'Violation information');
    addAvailableField(usefulFields, hasReturnedField(item, ['affectedEntities', 'affectedEntityDefinition', 'triggeredEntity']), 'Affected entity');
    addAvailableField(usefulFields, hasReturnedField(item, ['environment']), 'Environment');
    if (returnedLink(item)) sourceLinks.push(returnedLink(item));
  });
  result.events = eventsRead.ok
    ? { count: events.length, httpStatus: eventsRead.httpStatus, ok: true }
    : eventsRead;

  const violationsRead = await attemptRead(() => appDynamicsFetch(
    config,
    replaceApplicationTokens(config.credentials.violationsPath, application),
    {
      'duration-in-mins': Math.min(safeInteger(options.eventDurationMinutes, 15), 60),
      output: 'JSON',
      'time-range-type': 'BEFORE_NOW',
    },
    { auth },
  ));
  const violations = violationsRead.ok ? toArray(violationsRead.payload).slice(0, maxItems) : [];
  violations.forEach((item) => {
    addAvailableField(usefulFields, hasReturnedField(item, ['id', 'eventId', 'guid']), 'Violation ID');
    addAvailableField(usefulFields, hasReturnedField(item, ['name', 'summary', 'description']), 'Violation message');
    addAvailableField(usefulFields, hasReturnedField(item, ['severity']), 'Violation severity');
    addAvailableField(usefulFields, hasReturnedField(item, ['startTimeInMillis', 'detectedTimeInMillis', 'eventTime']), 'Violation time');
    addAvailableField(usefulFields, hasReturnedField(item, ['incidentStatus', 'status']), 'Violation status');
    addAvailableField(usefulFields, hasReturnedField(item, ['triggeredEntityDefinition', 'affectedEntityDefinition']), 'Affected entity');
    addAvailableField(usefulFields, hasReturnedField(item, ['name', 'healthRuleName']), 'Health Rule');
    if (returnedLink(item)) sourceLinks.push(returnedLink(item));
  });
  result.violations = violationsRead.ok
    ? { count: violations.length, httpStatus: violationsRead.httpStatus, ok: true }
    : violationsRead;

  const healthRulesRead = await attemptRead(() => appDynamicsFetch(
    config,
    replaceApplicationTokens(config.credentials.healthRulesPath, application),
    {},
    { auth },
  ));
  const healthRules = healthRulesRead.ok ? toArray(healthRulesRead.payload).slice(0, maxItems) : [];
  healthRules.forEach((item) => {
    addAvailableField(usefulFields, hasReturnedField(item, ['name', 'displayName']), 'Health Rule');
    addAvailableField(usefulFields, hasReturnedField(item, ['id', 'healthRuleId']), 'Health Rule ID');
  });
  result.healthRules = healthRulesRead.ok
    ? { count: healthRules.length, httpStatus: healthRulesRead.httpStatus, ok: true }
    : healthRulesRead;

  const policiesRead = await attemptRead(() => appDynamicsFetch(
    config,
    replaceApplicationTokens(config.credentials.policiesPath, application),
    {},
    { auth },
  ));
  const policies = policiesRead.ok ? toArray(policiesRead.payload).slice(0, maxItems) : [];
  policies.forEach((item) => {
    addAvailableField(usefulFields, hasReturnedField(item, ['id', 'policyId']), 'Policy ID');
    addAvailableField(usefulFields, hasReturnedField(item, ['name', 'displayName']), 'Policy');
    addAvailableField(usefulFields, hasReturnedField(item, ['enabled']), 'Policy enabled status');
  });
  result.policies = policiesRead.ok
    ? { count: policies.length, httpStatus: policiesRead.httpStatus, ok: true }
    : policiesRead;

  const metricPaths = config.credentials.metricPaths.slice(0, 5);
  const metricResults = [];
  for (const metricPath of metricPaths) {
    const metricRead = await attemptRead(() => appDynamicsFetch(
      config,
      replaceApplicationTokens(config.credentials.metricDataPath, application),
      {
        'duration-in-mins': Math.min(safeInteger(options.metricDurationMinutes, 5), 15),
        'metric-path': metricPath,
        output: 'JSON',
        rollup: false,
        'time-range-type': 'BEFORE_NOW',
      },
      { auth },
    ));
    const series = metricRead.ok ? toArray(metricRead.payload).slice(0, 1) : [];
    const pointCount = series.reduce((total, item) => (
      total + toArray(item.metricValues || item.values || item.data).length
    ), 0);

    if (series.length > 0) {
      addAvailableField(usefulFields, /calls per minute/i.test(metricPath), 'Load (calls per minute)');
      addAvailableField(usefulFields, /response time/i.test(metricPath), 'Response Time');
      addAvailableField(usefulFields, /errors per minute/i.test(metricPath), 'Errors');
      addAvailableField(usefulFields, /error %/i.test(metricPath), 'Error Rate');
      addAvailableField(usefulFields, true, 'Historical metric timestamp');
    }

    metricResults.push({
      httpStatus: metricRead.httpStatus || null,
      metricPath,
      ok: metricRead.ok,
      pointCount,
      ...(metricRead.ok ? {} : { error: metricRead.error }),
    });
  }
  result.metrics = {
    count: metricResults.reduce((total, item) => total + item.pointCount, 0),
    metricPaths: metricResults,
    ok: metricResults.some((item) => item.ok),
  };

  result.sourceLinksAvailable = sourceLinks.length > 0;
  result.usefulFields = [...usefulFields];
  return result;
}

async function testConnection() {
  const config = await getRuntimeConfig();

  if (!config.isEnabled) {
    return {
      ok: false,
      status: 'disconnected',
      mode: 'disabled',
      message: 'AppDynamics integration is disabled in Settings.',
    };
  }

  if (config.missing.length > 0) {
    await updateConnectionState({
      controllerUrl: config.baseUrl,
      accountName: config.accountName,
      authMode: config.credentials.authMode,
      connectionStatus: 'disconnected',
      lastError: `Missing required fields: ${config.missing.join(', ')}`,
    });

    return {
      ok: false,
      status: 'authentication_required',
      mode: 'blocked_by_auth',
      message: `AppDynamics is missing required fields: ${config.missing.join(', ')}.`,
    };
  }

  const startedAt = Date.now();

  try {
    const auth = await getAuthContext(config);
    const response = await fetchApplications(config, auth);
    const applications = response.applications;
    const connectedUserDisplayName = config.credentials.username
      ? String(config.credentials.username).replace(/@.*/, '')
      : config.credentials.clientId || 'AppDynamics API client';
    const responseTimeMs = response.responseTimeMs || auth.responseTimeMs || Date.now() - startedAt;

    await updateConnectionState({
      controllerUrl: config.baseUrl,
      accountName: config.accountName,
      authMode: config.credentials.authMode,
      connectionStatus: 'connected',
      connectedUserDisplayName,
      tokenExpiresAt: response.tokenExpiresAt || auth.tokenExpiresAt || null,
      lastSuccessfulSync: lastSuccessfulReadAt || new Date().toISOString(),
      responseTimeMs,
      lastError: null,
      metadata: {
        credentialSource: config.source,
        applicationCount: applications.length,
      },
    });
    await integrationService.updateIntegrationStatus(TOOL_NAME, 'connected');

    return {
      ok: true,
      status: 'connected',
      mode: 'live',
      message: `AppDynamics connection successful. ${applications.length} application${applications.length === 1 ? '' : 's'} visible.`,
      applicationCount: applications.length,
      connectedUserDisplayName,
      responseTimeMs,
      tokenExpiresAt: response.tokenExpiresAt || auth.tokenExpiresAt || null,
    };
  } catch (error) {
    const connectionStatus = error.connectionStatus || 'controller_unreachable';

    await updateConnectionState({
      controllerUrl: config.baseUrl,
      accountName: config.accountName,
      authMode: config.credentials.authMode,
      connectionStatus,
      lastFailedSync: new Date().toISOString(),
      lastError: error.message,
      responseTimeMs: Date.now() - startedAt,
      metadata: {
        credentialSource: config.source,
      },
    });
    await integrationService.updateIntegrationStatus(TOOL_NAME, 'error');

    return {
      ok: false,
      status: connectionStatus,
      mode: connectionStatus === 'invalid_credentials' ? 'invalid_credentials' : 'connection_failed',
      message: error.message,
      responseTimeMs: Date.now() - startedAt,
    };
  }
}

async function syncAppDynamicsData(options = {}) {
  await ensureAppDynamicsStorage();
  const config = await getRuntimeConfig();

  if (!config.isEnabled) {
    const error = new Error('AppDynamics integration is disabled in Settings.');
    error.status = 400;
    throw error;
  }

  if (config.missing.length > 0) {
    const error = new Error(`AppDynamics is missing required fields: ${config.missing.join(', ')}.`);
    error.status = 400;
    error.connectionStatus = 'disconnected';
    throw error;
  }

  const startedAt = Date.now();
  const auth = await getAuthContext(config);
  const applicationResponse = await fetchApplications(config, auth);
  const applicationLimit = safeInteger(options.applicationLimit || config.credentials.syncApplicationLimit, 100);
  const applications = applicationResponse.applications.slice(0, applicationLimit);
  const records = [];
  const applicationRows = applications.map(normalizeApplicationRow);
  const tierRows = [];
  const businessTransactionRows = [];
  const nodeRows = [];
  const eventRows = [];
  const snapshotRows = [];
  const healthRuleRows = [];
  const metricRows = [];
  const flowMapRows = [];
  const aiFeatureRows = [];
  let healthRuleCount = 0;
  let eventCount = 0;
  let businessTransactionCount = 0;
  let tierCount = 0;
  let nodeCount = 0;
  let snapshotCount = 0;
  let metricPointCount = 0;

  for (const application of applications) {
    records.push(mapApplicationRecord(config, application));

    const tiers = (await fetchTiers(config, application, auth)).map((tier) => normalizeTierRow(application, tier));
    tierCount += tiers.length;
    tierRows.push(...tiers);

    const businessTransactions = (await fetchBusinessTransactions(config, application, auth))
      .map((transaction) => normalizeBusinessTransactionRow(application, transaction));
    businessTransactionCount += businessTransactions.length;
    businessTransactionRows.push(...businessTransactions);
    records.push(...businessTransactions.map((transaction) => mapBusinessTransactionRecord(config, application, transaction)));

    const nodes = (await fetchNodes(config, application, auth)).map((node) => normalizeNodeRow(application, node));
    nodeCount += nodes.length;
    nodeRows.push(...nodes);
    records.push(...nodes.map((node) => mapNodeRecord(config, application, node)));

    const healthRules = await fetchHealthRules(config, application, auth);
    healthRuleCount += healthRules.length;
    records.push(...healthRules.map((rule) => mapHealthRuleRecord(config, application, rule)));
    healthRuleRows.push(...healthRules.map((rule) => normalizeHealthRuleRow(application, rule)));

    const events = await fetchEvents(config, application, auth);
    eventCount += events.length;
    records.push(...events.map((event) => mapEventRecord(config, application, event)));
    const normalizedEvents = events.map((event) => normalizeEventRow(application, event));
    eventRows.push(...normalizedEvents);

    const snapshots = (await fetchSnapshots(config, application, auth)).map((snapshot) => normalizeSnapshotRow(application, snapshot));
    snapshotCount += snapshots.length;
    snapshotRows.push(...snapshots);

    for (const metricPath of config.credentials.metricPaths) {
      const rows = await fetchMetricData(config, application, metricPath, auth);
      metricPointCount += rows.length;
      metricRows.push(...rows);
    }

    flowMapRows.push(...normalizeFlowMapRows(application, tiers, nodes));
    aiFeatureRows.push(...buildAiFeatureRows(application, {
      businessTransactions,
      nodes,
      events: normalizedEvents,
      metrics: metricRows.filter((metric) => metric.applicationId === getApplicationId(application)),
    }));
  }

  await upsertAppDynamicsApplications(applicationRows);
  await upsertAppDynamicsTiers(tierRows);
  await upsertAppDynamicsBusinessTransactions(businessTransactionRows);
  await upsertAppDynamicsNodes(nodeRows);
  await upsertAppDynamicsEvents(eventRows);
  await upsertAppDynamicsSnapshots(snapshotRows);
  await upsertAppDynamicsHealthRules(healthRuleRows);
  await upsertAppDynamicsMetrics(metricRows);
  await upsertAppDynamicsFlowMap(flowMapRows);
  await upsertAppDynamicsAiFeatures(aiFeatureRows);
  await upsertMonitoringRecords(records);

  const durationMs = Date.now() - startedAt;
  await updateConnectionState({
    controllerUrl: config.baseUrl,
    accountName: config.accountName,
    authMode: config.credentials.authMode,
    connectionStatus: 'connected',
    tokenExpiresAt: auth.tokenExpiresAt || null,
    lastSuccessfulSync: new Date().toISOString(),
    responseTimeMs: applicationResponse.responseTimeMs || auth.responseTimeMs || null,
    lastError: null,
    metadata: {
      credentialSource: config.source,
      applicationCount: applications.length,
      businessTransactionCount,
      tierCount,
      nodeCount,
      healthRuleCount,
      eventCount,
      snapshotCount,
      metricPointCount,
      flowMapCount: flowMapRows.length,
      aiFeatureCount: aiFeatureRows.length,
      recordsStored: records.length,
      durationMs,
    },
  });
  await integrationService.updateIntegrationStatus(TOOL_NAME, 'connected');

  return {
    tool: SOURCE_TOOL,
    sourceKey: SOURCE_TOOL,
    label: 'AppDynamics',
    fetched: applicationResponse.applications.length + healthRuleCount + eventCount + businessTransactionCount + tierCount + nodeCount + snapshotCount + metricPointCount,
    inserted: 0,
    updated: records.length + metricPointCount + snapshotCount,
    skipped: 0,
    stored: records.length + metricPointCount + snapshotCount,
    applicationCount: applications.length,
    businessTransactionCount,
    tierCount,
    nodeCount,
    healthRuleCount,
    eventCount,
    snapshotCount,
    metricPointCount,
    flowMapCount: flowMapRows.length,
    aiFeatureCount: aiFeatureRows.length,
    durationMs,
    responseTimeMs: applicationResponse.responseTimeMs || auth.responseTimeMs || null,
    message: `AppDynamics sync complete: ${applications.length} applications, ${businessTransactionCount} business transactions, ${nodeCount} nodes, ${snapshotCount} snapshots, ${healthRuleCount} health rules, ${eventCount} events, and ${metricPointCount} metric points stored.`,
  };
}

async function listApplications() {
  await ensureAppDynamicsStorage();
  const cachedCount = await db.query(
    'SELECT COUNT(*)::int AS count FROM appdynamics_applications',
  );

  if (Number(cachedCount.rows[0]?.count || 0) === 0) {
    try {
      await syncAppDynamicsData({ applicationLimit: 50 });
    } catch {
      // Cache-first for Monitoring page. Connection errors are shown through Settings/Test Connection.
    }
  }

  const result = await db.query(
    `
      SELECT
        app.application_id,
        app.application_name,
        app.status,
        app.health,
        app.last_updated,
        app.updated_at,
        COUNT(DISTINCT record.id)::int AS record_count,
        COUNT(DISTINCT bt.id)::int AS business_transaction_count,
        COUNT(DISTINCT node.id)::int AS node_count,
        COUNT(DISTINCT event.id)::int AS event_count
      FROM appdynamics_applications app
      LEFT JOIN monitoring_records record
        ON record.source_tool = $1
       AND record.custom_properties->>'appDynamicsApplicationId' = app.application_id
      LEFT JOIN appdynamics_business_transactions bt
        ON bt.application_id = app.application_id
      LEFT JOIN appdynamics_nodes node
        ON node.application_id = app.application_id
      LEFT JOIN appdynamics_events event
        ON event.application_id = app.application_id
      GROUP BY app.application_id, app.application_name, app.status, app.health, app.last_updated, app.updated_at
      ORDER BY app.application_name
      LIMIT 5000
    `,
    [SOURCE_TOOL],
  );

  return result.rows.map((row) => ({
    id: row.application_id,
    label: row.application_name,
    entityType: 'application',
    recordCount: row.record_count,
    status: row.status || 'ok',
    statusCounts: {},
    lastUpdatedAt: row.last_updated || row.updated_at,
    metadata: {
      applicationId: row.application_id,
      applicationName: row.application_name,
      health: row.health,
      businessTransactionCount: row.business_transaction_count,
      nodeCount: row.node_count,
      eventCount: row.event_count,
    },
  }));
}

function normalizeMonitoringRow(row) {
  return {
    id: row.id,
    sourceTool: row.source_tool,
    environment: row.environment,
    applicationName: row.application_name,
    entityType: row.entity_type,
    entityId: row.entity_id,
    status: row.status,
    severity: row.severity,
    summary: row.summary,
    details: row.details,
    acknowledged: row.acknowledged,
    lastCheck: row.last_check,
    updatedAt: row.updated_at,
    rawPayload: row.raw_payload || {},
    deepLink: row.deep_link,
    customProperties: row.custom_properties || {},
  };
}

async function findApplication(applicationIdOrName) {
  const result = await db.query(
    `
      SELECT *
      FROM appdynamics_applications
      WHERE application_id = $1 OR application_name = $1
      LIMIT 1
    `,
    [applicationIdOrName],
  );

  return result.rows[0] || null;
}

function normalizeMetricSeries(rows = []) {
  const metricLabel = (path) => String(path || '').split('|').at(-1) || path;
  const byMetric = rows.reduce((result, row) => {
    const key = row.metric_path;
    result[key] = result[key] || {
      metricPath: row.metric_path,
      metricName: row.metric_name || metricLabel(row.metric_path),
      points: [],
    };
    result[key].points.push({
      timestamp: row.metric_timestamp,
      value: Number(row.metric_value),
    });
    return result;
  }, {});

  return Object.values(byMetric).map((series) => ({
    ...series,
    points: series.points.sort((left, right) => new Date(left.timestamp) - new Date(right.timestamp)),
  }));
}

function buildAppDynamicsTimeline(metricRows = []) {
  const buckets = new Map();

  metricRows.forEach((row) => {
    const timestamp = new Date(row.metric_timestamp).toISOString();
    const bucket = buckets.get(timestamp) || {
      timestamp,
      label: timestamp,
      responseTime: null,
      callsPerMinute: null,
      errorsPerMinute: null,
      errorPercent: null,
      exceptionsPerMinute: null,
    };
    const name = `${row.metric_name || ''} ${row.metric_path || ''}`.toLowerCase();

    if (name.includes('response time')) bucket.responseTime = Number(row.metric_value);
    else if (name.includes('calls per minute')) bucket.callsPerMinute = Number(row.metric_value);
    else if (name.includes('errors per minute')) bucket.errorsPerMinute = Number(row.metric_value);
    else if (name.includes('error %') || name.includes('error percent')) bucket.errorPercent = Number(row.metric_value);
    else if (name.includes('exceptions')) bucket.exceptionsPerMinute = Number(row.metric_value);

    buckets.set(timestamp, bucket);
  });

  return [...buckets.values()].sort((left, right) => new Date(left.timestamp) - new Date(right.timestamp));
}

function buildTransactionScore(transactions = []) {
  const totals = transactions.reduce((result, row) => {
    result.calls += Number(row.calls || 0);
    result.callsPerMinute += Number(row.calls_per_minute || 0);
    result.errors += Number(row.errors || 0);
    result.errorsPerMinute += Number(row.errors_per_minute || 0);
    result.responseTimeValues.push(Number(row.response_time));
    result.critical += row.health === 'critical' ? 1 : 0;
    result.warning += row.health === 'warning' ? 1 : 0;
    return result;
  }, {
    calls: 0,
    callsPerMinute: 0,
    errors: 0,
    errorsPerMinute: 0,
    responseTimeValues: [],
    critical: 0,
    warning: 0,
  });
  const validResponseTimes = totals.responseTimeValues.filter(Number.isFinite);
  const averageResponseTime = validResponseTimes.length
    ? validResponseTimes.reduce((sum, value) => sum + value, 0) / validResponseTimes.length
    : null;

  return {
    calls: totals.calls,
    callsPerMinute: totals.callsPerMinute,
    errors: totals.errors,
    errorsPerMinute: totals.errorsPerMinute,
    averageResponseTime,
    criticalTransactions: totals.critical,
    warningTransactions: totals.warning,
    totalTransactions: transactions.length,
  };
}

async function getApplicationDetails(applicationIdOrName) {
  await ensureAppDynamicsStorage();
  const application = await findApplication(applicationIdOrName);
  const applicationId = application?.application_id || applicationIdOrName;
  const applicationName = application?.application_name || applicationIdOrName;
  const result = await db.query(
    `
      SELECT *
      FROM monitoring_records
      WHERE source_tool = $1
        AND (
          application_name = $2
          OR custom_properties->>'appDynamicsApplicationId' = $3
        )
      ORDER BY
        CASE entity_type WHEN 'application' THEN 0 WHEN 'event' THEN 1 WHEN 'health_rule' THEN 2 ELSE 3 END,
        updated_at DESC
      LIMIT 1000
    `,
    [SOURCE_TOOL, applicationName, applicationId],
  );
  const records = result.rows.map(normalizeMonitoringRow);
  const events = records.filter((record) => record.entityType === 'event');
  const healthRules = records.filter((record) => record.entityType === 'health_rule');
  const [
    businessTransactionsResult,
    tiersResult,
    nodesResult,
    appEventsResult,
    snapshotsResult,
    appHealthRulesResult,
    metricsResult,
    flowMapResult,
    aiFeaturesResult,
  ] = await Promise.all([
    db.query('SELECT * FROM appdynamics_business_transactions WHERE application_id = $1 ORDER BY updated_at DESC LIMIT 1000', [applicationId]),
    db.query('SELECT * FROM appdynamics_tiers WHERE application_id = $1 ORDER BY tier_name LIMIT 1000', [applicationId]),
    db.query('SELECT * FROM appdynamics_nodes WHERE application_id = $1 ORDER BY tier_name NULLS LAST, node_name LIMIT 1000', [applicationId]),
    db.query('SELECT * FROM appdynamics_events WHERE application_id = $1 ORDER BY event_time DESC NULLS LAST LIMIT 500', [applicationId]),
    db.query('SELECT * FROM appdynamics_snapshots WHERE application_id = $1 ORDER BY started_at DESC NULLS LAST LIMIT 500', [applicationId]),
    db.query('SELECT * FROM appdynamics_health_rules WHERE application_id = $1 ORDER BY health_rule_name LIMIT 1000', [applicationId]),
    db.query('SELECT * FROM appdynamics_metrics WHERE application_id = $1 ORDER BY metric_timestamp ASC LIMIT 5000', [applicationId]),
    db.query('SELECT * FROM appdynamics_flow_map WHERE application_id = $1 ORDER BY entity_type, entity_name LIMIT 2000', [applicationId]),
    db.query('SELECT * FROM appdynamics_ai_features WHERE application_id = $1 ORDER BY source_module, entity_name LIMIT 2000', [applicationId]),
  ]);
  const transactionScore = buildTransactionScore(businessTransactionsResult.rows);
  const metricSeries = normalizeMetricSeries(metricsResult.rows);
  const metricTimeline = buildAppDynamicsTimeline(metricsResult.rows);
  const servers = nodesResult.rows.reduce((items, node) => {
    const serverName = node.server_name || 'Unknown server';
    const current = items.get(serverName) || {
      serverName,
      nodeCount: 0,
      health: 'ok',
      nodes: [],
    };

    current.nodeCount += 1;
    current.health = [current.health, node.health].includes('critical') ? 'critical' : [current.health, node.health].includes('warning') ? 'warning' : current.health;
    current.nodes.push(node);
    items.set(serverName, current);
    return items;
  }, new Map());
  const appOverview = application ? {
    applicationId: application.application_id,
    applicationName: application.application_name,
    health: application.health,
    healthColor: application.health_color,
    responseTime: application.response_time,
    calls: application.calls,
    callsPerMinute: application.calls_per_minute,
    errors: application.errors,
    errorsPerMinute: application.errors_per_minute,
    lastUpdated: application.last_updated,
    timeWindow: application.time_window,
    status: application.status,
    tags: application.tags || [],
    description: application.description,
    rawPayload: application.raw_payload || {},
  } : {
    applicationId,
    applicationName,
    status: records.some((record) => record.status === 'critical') ? 'critical' : records.some((record) => record.status === 'warning') ? 'warning' : 'ok',
  };

  return {
    tool: {
      key: SOURCE_TOOL,
      label: 'AppDynamics',
      adapterName: 'AppDynamics Adapter',
    },
    application: {
      id: applicationId,
      label: applicationName,
      entityType: 'application',
    },
    kind: 'appdynamics_dashboard',
    summary: {
      total: records.length,
      status: records.some((record) => record.status === 'critical') ? 'critical' : records.some((record) => record.status === 'warning') ? 'warning' : 'ok',
      statusCounts: records.reduce((counts, record) => {
        counts[record.status] = (counts[record.status] || 0) + 1;
        return counts;
      }, {}),
      severityCounts: records.reduce((counts, record) => {
        counts[record.severity] = (counts[record.severity] || 0) + 1;
        return counts;
      }, {}),
      acknowledged: records.filter((record) => record.acknowledged).length,
      problems: records.filter((record) => !['ok', 'up', 'pending'].includes(record.status)).length,
      lastCheck: records.map((record) => record.lastCheck).filter(Boolean).sort().at(-1) || null,
    },
    keyMetrics: [
      { label: 'Business transactions', value: businessTransactionsResult.rows.length },
      { label: 'Nodes', value: nodesResult.rows.length },
      { label: 'Servers', value: servers.size },
      { label: 'Snapshots', value: snapshotsResult.rows.length },
      { label: 'Health rules', value: appHealthRulesResult.rows.length || healthRules.length },
      { label: 'Recent events', value: appEventsResult.rows.length || events.length },
      { label: 'Problems', value: records.filter((record) => !['ok', 'up', 'pending'].includes(record.status)).length },
    ],
    entities: records,
    activeProblems: events.filter((event) => !['ok', 'resolved', 'closed'].includes(event.status)).slice(0, 100),
    recentEvents: events.slice(0, 100),
    healthRules,
    deepLink: records[0]?.deepLink || null,
    lastUpdatedAt: records.map((record) => record.updatedAt).filter(Boolean).sort().at(-1) || null,
    connectionState: await getConnectionState(),
    dashboard: {
      overview: appOverview,
      transactionScore,
      metricSeries,
      metricTimeline,
      businessTransactions: businessTransactionsResult.rows,
      tiers: tiersResult.rows,
      nodes: nodesResult.rows,
      servers: [...servers.values()],
      events: appEventsResult.rows,
      snapshots: snapshotsResult.rows,
      healthRules: appHealthRulesResult.rows,
      metrics: metricsResult.rows,
      flowMap: flowMapResult.rows,
      aiFeatures: aiFeaturesResult.rows,
    },
    businessTransactions: businessTransactionsResult.rows,
    tiers: tiersResult.rows,
    nodes: nodesResult.rows,
    servers: [...servers.values()],
    appDynamicsEvents: appEventsResult.rows,
    snapshots: snapshotsResult.rows,
    metrics: metricsResult.rows,
    metricSeries,
    metricTimeline,
    flowMap: flowMapResult.rows,
    aiFeatures: aiFeaturesResult.rows,
    transactionScore,
  };
}

async function getApplicationDashboard(applicationIdOrName) {
  return getApplicationDetails(applicationIdOrName);
}

async function getApplicationFlowMap(applicationIdOrName) {
  const details = await getApplicationDetails(applicationIdOrName);

  return {
    application: details.application,
    flowMap: details.flowMap || [],
    tiers: details.tiers || [],
    nodes: details.nodes || [],
  };
}

async function getApplicationBusinessTransactions(applicationIdOrName) {
  const details = await getApplicationDetails(applicationIdOrName);

  return {
    application: details.application,
    transactionScore: details.transactionScore,
    businessTransactions: details.businessTransactions || [],
  };
}

async function getApplicationNodes(applicationIdOrName) {
  const details = await getApplicationDetails(applicationIdOrName);

  return {
    application: details.application,
    nodes: details.nodes || [],
  };
}

async function getApplicationServers(applicationIdOrName) {
  const details = await getApplicationDetails(applicationIdOrName);

  return {
    application: details.application,
    servers: details.servers || [],
  };
}

async function getApplicationEvents(applicationIdOrName) {
  const details = await getApplicationDetails(applicationIdOrName);

  return {
    application: details.application,
    events: details.appDynamicsEvents || [],
  };
}

async function getApplicationSnapshots(applicationIdOrName) {
  const details = await getApplicationDetails(applicationIdOrName);

  return {
    application: details.application,
    snapshots: details.snapshots || [],
  };
}

async function getApplicationMetrics(applicationIdOrName) {
  const details = await getApplicationDetails(applicationIdOrName);

  return {
    application: details.application,
    metrics: details.metrics || [],
    metricSeries: details.metricSeries || [],
    metricTimeline: details.metricTimeline || [],
  };
}

async function getApplicationTransactionScore(applicationIdOrName) {
  const details = await getApplicationDetails(applicationIdOrName);

  return {
    application: details.application,
    transactionScore: details.transactionScore,
    aiFeatures: details.aiFeatures || [],
  };
}

function startAppDynamicsPolling() {
  if (pollingTimer) {
    return pollingTimer;
  }

  pollingTimer = setInterval(async () => {
    if (pollingSyncInProgress) {
      return;
    }

    let config;

    try {
      config = await getRuntimeConfig();
    } catch {
      return;
    }

    if (!config.isEnabled || config.missing.length > 0 || config.credentials.liveImportMode === false) {
      return;
    }

    pollingSyncInProgress = true;

    try {
      await syncAppDynamicsData({
        applicationLimit: config.credentials.syncApplicationLimit,
      });
    } catch (error) {
      await updateConnectionState({
        controllerUrl: config.baseUrl,
        accountName: config.accountName,
        authMode: config.credentials.authMode,
        connectionStatus: error.connectionStatus || 'controller_unreachable',
        lastFailedSync: new Date().toISOString(),
        lastError: error.message,
      });
      await integrationService.updateIntegrationStatus(TOOL_NAME, 'error');
    } finally {
      pollingSyncInProgress = false;
    }
  }, 60000);

  pollingTimer.unref?.();

  return pollingTimer;
}

async function disconnect() {
  clearOAuthTokenCache();
  await ensureAppDynamicsStorage();
  await db.query(
    `
      UPDATE integrations
      SET is_enabled = false,
          status = 'not_connected',
          updated_at = NOW()
      WHERE tool_name = $1
    `,
    [TOOL_NAME],
  );
  await updateConnectionState({
    connectionStatus: 'disconnected',
    lastError: null,
  });

  return {
    disconnected: true,
    message: 'AppDynamics disconnected. Stored credentials remain encrypted; disable/delete them from Settings if you want to remove them.',
  };
}

async function getSafeConfigPreview() {
  const config = await getRuntimeConfig();
  const connectionState = await getConnectionState();
  const token = getOAuthTokenStatus();
  const connectionStatus = connectionState?.connection_status || null;

  return {
    authenticated: token.cached || connectionStatus === 'connected',
    authenticationMode: config.credentials.authMode === 'api_client' ? 'oauth' : config.credentials.authMode,
    configured: config.missing.length === 0,
    controllerReachable: lastControllerReachable ?? (
      connectionStatus
        ? !['controller_unreachable', 'controller_unavailable'].includes(connectionStatus)
        : null
    ),
    toolName: TOOL_NAME,
    controllerUrl: config.baseUrl,
    credentialSource: config.source,
    isEnabled: config.isEnabled,
    lastError: lastReadError || connectionState?.last_error || null,
    lastSuccessfulRead: lastSuccessfulReadAt || connectionState?.last_successful_sync || null,
    missing: config.missing,
    token: {
      cached: token.cached,
      expiresAt: token.expiresAt || connectionState?.token_expires_at || null,
      refreshInProgress: token.refreshInProgress,
      remainingLifetimeSeconds: token.remainingLifetimeSeconds,
    },
  };
}

module.exports = {
  disconnect,
  getApplicationIdentityInventory,
  getApplicationBusinessTransactions,
  getApplicationDashboard,
  getApplicationDetails,
  getApplicationEvents,
  getApplicationFlowMap,
  getApplicationMetrics,
  getApplicationNodes,
  getApplicationPoliciesReadOnly,
  getApplicationServers,
  getApplicationSnapshots,
  getApplicationTransactionScore,
  getConnectionState,
  getRuntimeConfig,
  getSafeConfigPreview,
  queryApplicationEvidence,
  readOnlyRequest,
  getWorkspaceApplication,
  getWorkspaceApplications,
  listApplications,
  startAppDynamicsPolling,
  syncAppDynamicsData,
  testConnection,
  validateReadOnlyConnection,
  _test: {
    appDynamicsFetch,
    applicationHealth,
    aggregateMetricPoints,
    clearOAuthTokenCache,
    fetchWithTimeout,
    failedMetricSummary,
    getAccessToken,
    getAuthContext,
    getOAuthTokenStatus,
    healthFromViolations,
    metricSummary,
    paginateWorkspaceRecords,
    requestAccessToken,
    rollupMetricSummary,
    workspaceRange,
    workspaceResultStatus,
    workspaceTimeQuery,
    normalizedWorkspaceEvent,
  },
};
