const crypto = require('crypto');
const db = require('../config/db');
const integrationService = require('./integration.service');

const INSTANCE_DEFINITIONS = {
  d01: {
    key: 'd01',
    sourceKey: 'nagios-dc01',
    label: 'Nagios D01',
    adapterName: 'Nagios D01 Adapter',
    integrationTool: 'nagios-dc01',
    baseUrlEnv: 'NAGIOS_D01_BASE_URL',
    apiKeyEnv: 'NAGIOS_D01_API_KEY',
  },
  d02: {
    key: 'd02',
    sourceKey: 'nagios-dc02',
    label: 'Nagios D02',
    adapterName: 'Nagios D02 Adapter',
    integrationTool: 'nagios-dc02',
    baseUrlEnv: 'NAGIOS_D02_BASE_URL',
    apiKeyEnv: 'NAGIOS_D02_API_KEY',
  },
};

const SERVICE_STATES = {
  0: 'ok',
  1: 'warning',
  2: 'critical',
  3: 'unknown',
};

const HOST_STATES = {
  0: 'up',
  1: 'down',
  2: 'unreachable',
};

const DEFAULT_POLL_INTERVAL_MS = 60 * 1000;
const REQUEST_TIMEOUT_MS = Number(process.env.NAGIOS_TIMEOUT_MS || 10000);
const POLL_RETRY_DELAYS_MS = [2000, 5000];
const WORKSPACE_CACHE_TTL_MS = 55 * 1000;
const WORKSPACE_PAGE_SIZE = 500;
const WORKSPACE_MAX_PAGES = 100;
const WORKSPACE_LIST_PAGE_SIZES = new Set([25, 50, 100]);
const WORKSPACE_SORT_FIELDS = new Set(['host', 'service', 'status', 'duration', 'lastCheck', 'lastStateChange']);
const HISTORY_PAGE_SIZE = 500;
const HISTORY_MAX_PAGES = 20;
const HISTORY_MAX_WINDOW_MS = 2 * 60 * 60 * 1000;
let pollingStarted = false;
let nagiosStorageReady = false;
let nagiosStorageReadyPromise = null;
const workspaceCache = new Map();
const workspaceRequests = new Map();

function getInstanceDefinition(instanceKey) {
  const definition = INSTANCE_DEFINITIONS[String(instanceKey || '').toLowerCase()];

  if (!definition) {
    const error = new Error(`Unsupported Nagios instance: ${instanceKey}`);
    error.status = 404;
    throw error;
  }

  return definition;
}

function getInstanceConfig(instanceKey) {
  const definition = getInstanceDefinition(instanceKey);
  const baseUrl = String(process.env[definition.baseUrlEnv] || '').trim().replace(/\/+$/, '');
  const apiKey = String(process.env[definition.apiKeyEnv] || '').trim();

  return {
    ...definition,
    baseUrl,
    apiKey,
    credentialSource: baseUrl && apiKey ? 'env' : 'missing',
    configured: Boolean(baseUrl && apiKey),
  };
}

async function getInstanceRuntimeConfig(instanceKey) {
  const envConfig = getInstanceConfig(instanceKey);

  if (envConfig.configured) {
    return envConfig;
  }

  try {
    const savedConfig = await integrationService.getIntegrationRuntimeConfig(envConfig.integrationTool);
    const baseUrl = savedConfig.baseUrl || envConfig.baseUrl;
    const apiKey = savedConfig.credentials.apiKey
      || savedConfig.credentials.apikey
      || savedConfig.credentials.token
      || savedConfig.credentials.apiToken
      || envConfig.apiKey;

    return {
      ...envConfig,
      baseUrl,
      apiKey,
      configured: Boolean(baseUrl && apiKey),
      credentialSource: baseUrl && apiKey ? 'settings' : 'missing',
    };
  } catch {
    return envConfig;
  }
}

function hashId(value) {
  return crypto.createHash('sha1').update(String(value || '')).digest('hex').slice(0, 16).toUpperCase();
}

function stableHash(value) {
  return crypto
    .createHash('sha1')
    .update(JSON.stringify(value || {}))
    .digest('hex');
}

function toNumber(value, fallback = 0) {
  const parsed = Number(value);

  return Number.isFinite(parsed) ? parsed : fallback;
}

function toBoolean(value) {
  if (typeof value === 'boolean') {
    return value;
  }

  const normalized = String(value ?? '').trim().toLowerCase();

  return ['1', 'true', 'yes', 'y', 'on'].includes(normalized);
}

function toOptionalBoolean(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  return toBoolean(value);
}

function coalesceValue(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '');
}

function parseDurationSeconds(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const numeric = Number(value);

  if (Number.isFinite(numeric)) {
    return Math.max(0, Math.round(numeric));
  }

  const text = String(value).trim().toLowerCase();
  let total = 0;
  const patterns = [
    [/(\d+(?:\.\d+)?)\s*d/g, 86400],
    [/(\d+(?:\.\d+)?)\s*h/g, 3600],
    [/(\d+(?:\.\d+)?)\s*m/g, 60],
    [/(\d+(?:\.\d+)?)\s*s/g, 1],
  ];

  patterns.forEach(([pattern, multiplier]) => {
    let match = pattern.exec(text);

    while (match) {
      total += Number(match[1]) * multiplier;
      match = pattern.exec(text);
    }
  });

  return total ? Math.round(total) : null;
}

function getDurationSeconds(row = {}) {
  return parseDurationSeconds(coalesceValue(
    row.duration,
    row.current_state_duration,
    row.currentStateDuration,
    row.state_duration,
    row.stateDuration,
  ));
}

function getAttemptCount(row = {}) {
  return toNumber(coalesceValue(
    row.current_attempt,
    row.currentAttempt,
    row.current_check_attempt,
    row.currentCheckAttempt,
    row.attempt,
    row.check_attempt,
  ), null);
}

function getStateType(row = {}) {
  const value = coalesceValue(row.state_type, row.stateType);

  if (value === undefined || value === null || value === '') {
    return null;
  }

  const numeric = Number(value);

  if (Number.isFinite(numeric)) {
    return numeric === 1 ? 'hard' : 'soft';
  }

  return String(value).toLowerCase();
}

function unixOrIsoToDate(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    return new Date(numeric * 1000).toISOString();
  }

  const date = new Date(value);

  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function nagiosNaiveTimestampParts(value) {
  const match = String(value || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/);
  if (!match) return null;
  return {
    year: Number(match[1]), month: Number(match[2]) - 1, day: Number(match[3]),
    hour: Number(match[4]), minute: Number(match[5]), second: Number(match[6]),
    millisecond: Number(String(match[7] || '').padEnd(3, '0') || 0),
  };
}

function inferNagiosUtcOffsetMinutes(sourceStatusTime, observedAt = Date.now()) {
  const parts = nagiosNaiveTimestampParts(sourceStatusTime);
  const observedMs = observedAt instanceof Date ? observedAt.getTime() : Number(observedAt);
  if (!parts || !Number.isFinite(observedMs)) return null;
  const sourceAsUtc = Date.UTC(parts.year, parts.month, parts.day, parts.hour, parts.minute, parts.second, parts.millisecond);
  const rawOffsetMinutes = (sourceAsUtc - observedMs) / 60000;
  const rounded = Math.round(rawOffsetMinutes / 15) * 15;
  return Math.abs(rounded) <= 14 * 60 ? rounded : null;
}

function nagiosSourceTimestampToIso(value, sourceUtcOffsetMinutes = null) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return new Date(numeric * 1000).toISOString();
  const parts = nagiosNaiveTimestampParts(value);
  if (parts && Number.isFinite(sourceUtcOffsetMinutes)) {
    const utc = Date.UTC(parts.year, parts.month, parts.day, parts.hour, parts.minute, parts.second, parts.millisecond)
      - sourceUtcOffsetMinutes * 60 * 1000;
    return new Date(utc).toISOString();
  }
  return unixOrIsoToDate(value);
}

function normalizeApiBase(baseUrl) {
  const url = new URL(baseUrl);
  const path = url.pathname.replace(/\/+$/, '');

  if (/\/api\/v1$/i.test(path)) {
    return `${url.origin}${path}`;
  }

  if (/\/nagiosxi$/i.test(path)) {
    return `${url.origin}${path}/api/v1`;
  }

  return `${url.origin}${path}/nagiosxi/api/v1`;
}

function buildNagiosUrl(config, objectPath, params = {}) {
  const url = new URL(`${normalizeApiBase(config.baseUrl)}/${objectPath.replace(/^\/+/, '')}`);
  url.searchParams.set('apikey', config.apiKey);
  url.searchParams.set('pretty', '1');

  Object.entries(params).forEach(([key, value]) => {
    if (value !== null && value !== undefined && value !== '') {
      url.searchParams.set(key, String(value));
    }
  });

  return url.toString();
}

function redactNagiosUrl(url) {
  try {
    const safeUrl = new URL(url);

    if (safeUrl.searchParams.has('apikey')) {
      safeUrl.searchParams.set('apikey', '***');
    }

    return safeUrl.toString();
  } catch {
    return String(url || '').replace(/apikey=[^&]+/gi, 'apikey=***');
  }
}

function createPollError(type, stage, message, details = {}) {
  const error = new Error(message);

  error.failureType = type;
  error.failureStage = stage;
  error.responseStatus = details.responseStatus || null;
  error.responseTimeMs = details.responseTimeMs || null;
  error.retryable = details.retryable !== undefined
    ? details.retryable
    : ['timeout', 'dns_failure', 'connection_refused', 'ssl_error', 'rate_limited', 'server_error', 'unknown_exception'].includes(type);
  error.details = details;

  return error;
}

function classifyNetworkError(error, stage = 'send_http_request') {
  if (error.name === 'AbortError') {
    return createPollError('timeout', stage, `Nagios request timed out after ${REQUEST_TIMEOUT_MS} ms.`, {
      retryable: true,
    });
  }

  const code = error.cause?.code || error.code || '';
  const message = error.cause?.message || error.message || 'Nagios request failed.';

  if (['ENOTFOUND', 'EAI_AGAIN'].includes(code)) {
    return createPollError('dns_failure', stage, `DNS lookup failed for Nagios: ${message}`, {
      retryable: true,
      code,
    });
  }

  if (code === 'ECONNREFUSED') {
    return createPollError('connection_refused', stage, `Nagios refused the connection: ${message}`, {
      retryable: true,
      code,
    });
  }

  if (['ETIMEDOUT', 'ECONNRESET', 'EPIPE'].includes(code)) {
    return createPollError('timeout', stage, `Nagios network request failed or timed out: ${message}`, {
      retryable: true,
      code,
    });
  }

  if (/certificate|ssl|tls|self.?signed|unable_to_verify|leaf/i.test(`${code} ${message}`)) {
    return createPollError('ssl_error', stage, `Nagios SSL certificate could not be verified: ${message}`, {
      retryable: false,
      code,
    });
  }

  return createPollError('unknown_exception', stage, `Nagios request failed: ${message}`, {
    retryable: true,
    code,
  });
}

function classifyHttpError(responseStatus, responseTimeMs, responseBodySample) {
  if (responseStatus === 401) {
    return createPollError('unauthorized', 'validate_http_status', 'Nagios returned 401 Unauthorized. Check the Nagios XI API key.', {
      responseStatus,
      responseTimeMs,
      responseBodySample,
      retryable: false,
    });
  }

  if (responseStatus === 403) {
    return createPollError('forbidden', 'validate_http_status', 'Nagios returned 403 Forbidden. The API key does not have permission for this endpoint.', {
      responseStatus,
      responseTimeMs,
      responseBodySample,
      retryable: false,
    });
  }

  if (responseStatus === 404) {
    return createPollError('endpoint_not_found', 'validate_http_status', 'Nagios returned 404 Endpoint Not Found. Check the Nagios XI base URL and API path.', {
      responseStatus,
      responseTimeMs,
      responseBodySample,
      retryable: false,
    });
  }

  if (responseStatus === 429) {
    return createPollError('rate_limited', 'validate_http_status', 'Nagios returned 429 Too Many Requests. The poll will retry.', {
      responseStatus,
      responseTimeMs,
      responseBodySample,
      retryable: true,
    });
  }

  if (responseStatus >= 500) {
    return createPollError('server_error', 'validate_http_status', `Nagios returned HTTP ${responseStatus}.`, {
      responseStatus,
      responseTimeMs,
      responseBodySample,
      retryable: true,
    });
  }

  return createPollError('http_error', 'validate_http_status', `Nagios returned HTTP ${responseStatus}.`, {
    responseStatus,
    responseTimeMs,
    responseBodySample,
    retryable: false,
  });
}

function describePollError(error) {
  return {
    failureType: error.failureType || 'unknown_exception',
    failureStage: error.failureStage || 'unknown_exception',
    failureReason: error.message || 'Unknown Nagios polling error.',
    httpStatus: error.responseStatus || null,
    responseTimeMs: error.responseTimeMs || null,
    retryable: Boolean(error.retryable),
    details: error.details || {},
  };
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function fetchJson(url, stage = 'send_http_request') {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const startedAt = Date.now();

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
      },
    });
    const responseTimeMs = Date.now() - startedAt;
    const bodyText = await response.text();
    const bodySample = bodyText.slice(0, 400).replace(/\s+/g, ' ');
    let payload = null;

    if (!bodyText.trim()) {
      throw createPollError('empty_response', 'validate_json', 'Nagios returned an empty response.', {
        responseStatus: response.status,
        responseTimeMs,
        retryable: true,
      });
    }

    if (!response.ok) {
      throw classifyHttpError(response.status, responseTimeMs, bodySample);
    }

    try {
      payload = JSON.parse(bodyText);
    } catch {
      throw createPollError('invalid_json', 'validate_json', 'Nagios returned content that is not valid JSON.', {
        responseStatus: response.status,
        responseTimeMs,
        responseBodySample: bodySample,
        contentType: response.headers.get('content-type'),
        retryable: false,
      });
    }

    if (payload?.error) {
      throw createPollError('forbidden', 'validate_json', `Nagios API error: ${payload.error}`, {
        responseStatus: response.status,
        responseTimeMs,
        retryable: false,
      });
    }

    return { payload, responseTimeMs, httpStatus: response.status };
  } catch (error) {
    if (error.failureType) {
      throw error;
    }

    throw classifyNetworkError(error, stage);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchOptionalRows(config, objectPath, keys, params = {}) {
  try {
    const response = await fetchJson(buildNagiosUrl(config, objectPath, params));

    return {
      rows: extractRows(response.payload, keys),
      payload: response.payload,
      responseTimeMs: response.responseTimeMs,
      warning: null,
    };
  } catch (error) {
    return {
      rows: [],
      payload: {},
      responseTimeMs: 0,
      warning: `${objectPath} unavailable: ${error.message}`,
    };
  }
}

async function fetchPaginatedRows(config, objectPath, keys) {
  const startedAt = Date.now();
  const rows = [];
  let offset = 0;
  let pages = 0;
  let responseTimeMs = 0;

  while (pages < WORKSPACE_MAX_PAGES) {
    const response = await fetchJson(buildNagiosUrl(config, objectPath, {
      pretty: 0,
      records: `${WORKSPACE_PAGE_SIZE}:${offset}`,
    }));
    const pageRows = extractRows(response.payload, keys);

    rows.push(...pageRows);
    responseTimeMs = Math.max(responseTimeMs, response.responseTimeMs || 0);
    pages += 1;

    if (pageRows.length < WORKSPACE_PAGE_SIZE) {
      return {
        rows,
        pages,
        responseTimeMs,
        durationMs: Date.now() - startedAt,
      };
    }

    offset += WORKSPACE_PAGE_SIZE;
  }

  throw createPollError(
    'pagination_limit',
    'read_workspace',
    `Nagios ${objectPath} exceeded the ${WORKSPACE_MAX_PAGES}-page safety limit.`,
    { retryable: false },
  );
}

async function fetchBoundedHistoryRows(config, objectPath, keys, params = {}) {
  const rows = [];
  let offset = 0;
  let pages = 0;
  let responseTimeMs = 0;

  while (pages < HISTORY_MAX_PAGES) {
    const response = await fetchJson(buildNagiosUrl(config, objectPath, {
      ...params,
      pretty: 0,
      records: `${HISTORY_PAGE_SIZE}:${offset}`,
    }), 'read_historical_evidence');
    const pageRows = extractRows(response.payload, keys);
    rows.push(...pageRows);
    responseTimeMs = Math.max(responseTimeMs, response.responseTimeMs || 0);
    pages += 1;
    if (pageRows.length < HISTORY_PAGE_SIZE) return { rows, pages, responseTimeMs };
    offset += HISTORY_PAGE_SIZE;
  }

  throw createPollError('pagination_limit', 'read_historical_evidence',
    `Nagios ${objectPath} exceeded the ${HISTORY_MAX_PAGES}-page historical evidence safety limit.`,
    { retryable: false });
}

function normalizeNagiosHistoryState(instanceKey, row, sourceUtcOffsetMinutes) {
  const serviceDescription = row.service_description || null;
  const type = serviceDescription ? 'service' : 'host';
  const timestamp = nagiosSourceTimestampToIso(row.state_time, sourceUtcOffsetMinutes);
  const status = getStateLabel(row, type);
  const objectId = coalesceValue(row.object_id, null);
  return {
    id: `nagios:${instanceKey}:statehistory:${hashId(`${objectId || ''}:${row.state_time || ''}:${row.host_name || ''}:${serviceDescription || ''}:${row.state || ''}:${row.current_check_attempt || ''}`)}`,
    sourceEventId: null,
    sourceEntityId: objectId === null ? null : String(objectId),
    objectId: objectId === null ? null : String(objectId),
    objectType: type,
    hostName: row.host_name || null,
    serviceDescription,
    timestamp,
    sourceTimestamp: row.state_time || null,
    state: status,
    stateCode: toNumber(row.state, null),
    stateType: getStateType(row),
    stateChange: toOptionalBoolean(row.state_change),
    attemptCount: getAttemptCount(row),
    maxAttempts: toNumber(row.max_check_attempts, null),
    lastState: toNumber(row.last_state, null),
    lastHardState: toNumber(row.last_hard_state, null),
    pluginOutput: row.output || null,
  };
}

function parseNagiosHistoryLog(instanceKey, row, sourceUtcOffsetMinutes) {
  const data = String(row.logentry_data || row.message || row.output || '').trim();
  const match = data.match(/^(SERVICE|HOST) (NOTIFICATION|ALERT|ACKNOWLEDGEMENT|FLAPPING ALERT):\s*(.*)$/i);
  const objectType = match?.[1]?.toLowerCase() || null;
  const kind = match?.[2]?.toLowerCase().replace(/\s+/g, '_') || 'log';
  const parts = match ? match[3].split(';').map((part) => part.trim()) : [];
  let cursor = kind === 'notification' || kind === 'acknowledgement' ? 1 : 0;
  const actor = cursor ? parts[0] || null : null;
  const hostName = parts[cursor] || null;
  cursor += 1;
  const serviceDescription = objectType === 'service' ? parts[cursor++] || null : null;
  const state = parts[cursor++] || null;
  const stateType = kind === 'alert' ? String(parts[cursor++] || '').toLowerCase() || null : null;
  const attemptCount = kind === 'alert' ? toNumber(parts[cursor++], null) : null;
  const command = kind === 'notification' ? parts[cursor++] || null : null;
  const output = parts.slice(cursor).join('; ') || null;
  return {
    id: row.logentry_id ? `nagios:${instanceKey}:log:${row.logentry_id}` : `nagios:${instanceKey}:log:${hashId(`${row.entry_time || ''}:${data}`)}`,
    sourceEventId: row.logentry_id ? String(row.logentry_id) : null,
    objectType,
    kind,
    timestamp: nagiosSourceTimestampToIso(row.entry_time ?? row.logentry_time, sourceUtcOffsetMinutes),
    sourceTimestamp: row.entry_time ?? row.logentry_time ?? null,
    hostName,
    serviceDescription,
    state: state ? state.toLowerCase() : null,
    stateType,
    attemptCount,
    actor,
    command,
    output,
    data,
  };
}

function exactNagiosIdentity(record, host, serviceDescription) {
  const sameHost = String(record?.hostName || '').trim().toLowerCase() === String(host || '').trim().toLowerCase();
  const sameService = serviceDescription
    ? String(record?.serviceDescription || '').trim().toLowerCase() === String(serviceDescription).trim().toLowerCase()
    : !record?.serviceDescription;
  return sameHost && sameService;
}

function isNagiosProblemState(record) {
  return !['ok', 'up', 'pending'].includes(String(record?.state || '').toLowerCase());
}

function isNagiosRecoveryState(record) {
  return ['ok', 'up'].includes(String(record?.state || '').toLowerCase());
}

async function startSyncLog(instanceKey, syncType, rawPayload = {}) {
  await ensureNagiosStorage();
  const result = await db.query(
    `
      INSERT INTO nagios_sync_logs (source_instance, sync_type, status, raw_payload)
      VALUES ($1, $2, 'running', $3::jsonb)
      RETURNING id
    `,
    [instanceKey, syncType, JSON.stringify(rawPayload || {})],
  );

  return result.rows[0]?.id;
}

async function finishSyncLog(id, status, details = {}) {
  if (!id) {
    return;
  }

  await db.query(
    `
      UPDATE nagios_sync_logs
      SET
        status = $2,
        finished_at = NOW(),
        duration_ms = GREATEST(0, ROUND(EXTRACT(EPOCH FROM (NOW() - started_at)) * 1000)::int),
        counts = COALESCE($3::jsonb, '{}'::jsonb),
        warnings = COALESCE($4::jsonb, '[]'::jsonb),
        error_message = $5,
        raw_payload = raw_payload || COALESCE($6::jsonb, '{}'::jsonb)
      WHERE id = $1
    `,
    [
      id,
      status,
      JSON.stringify(details.counts || {}),
      JSON.stringify(details.warnings || []),
      details.errorMessage || null,
      JSON.stringify(details.rawPayload || {}),
    ],
  );
}

function extractRows(payload, keys) {
  if (Array.isArray(payload)) {
    return payload;
  }

  for (const key of keys) {
    if (Array.isArray(payload?.[key])) {
      return payload[key];
    }
  }

  if (Array.isArray(payload?.data)) {
    return payload.data;
  }

  if (Array.isArray(payload?.records)) {
    return payload.records;
  }

  return [];
}

function validateExpectedRows(payload, keys, label) {
  const rows = extractRows(payload, keys);
  const recordCount = Number(payload?.recordcount ?? payload?.recordCount ?? rows.length);

  if (!rows.length && recordCount > 0) {
    throw createPollError('unexpected_response_format', 'validate_json', `Nagios ${label} response reported ${recordCount} records but did not include a readable array.`, {
      responseStatus: 200,
      retryable: false,
      keys,
    });
  }

  if (!rows.length && recordCount === 0 && ['service status', 'host status'].includes(label)) {
    throw createPollError('empty_response', 'validate_json', `Nagios ${label} response contained no records.`, {
      responseStatus: 200,
      retryable: true,
      keys,
    });
  }

  return rows;
}

function getDisplayName(row, fallback) {
  return row.display_name || row.name || row.host_name || row.service_description || fallback;
}

function getStateLabel(row, type) {
  const hasBeenChecked = row.has_been_checked ?? row.hasBeenChecked;

  if (String(hasBeenChecked) === '0') {
    return 'pending';
  }

  const state = toNumber(row.current_state ?? row.currentState ?? row.state, -1);

  if (type === 'host') {
    return HOST_STATES[state] || 'pending';
  }

  return SERVICE_STATES[state] || 'pending';
}

function mapSeverityFromStatus(status, type) {
  if (status === 'critical' || status === 'down' || status === 'unreachable') {
    return 'critical';
  }

  if (status === 'warning') {
    return 'warning';
  }

  if (status === 'unknown') {
    return 'medium';
  }

  if (status === 'pending') {
    return 'low';
  }

  return type === 'host' ? 'medium' : 'low';
}

function mapAlertStatusFromNagios(status) {
  if (['ok', 'up'].includes(status)) {
    return 'resolved';
  }

  if (status === 'pending') {
    return 'open';
  }

  return 'firing';
}

function normalizeHost(instanceKey, row = {}) {
  const hostName = row.host_name || row.host || row.name || 'unknown-host';
  const status = getStateLabel(row, 'host');
  const lastCheck = unixOrIsoToDate(row.last_check ?? row.lastCheck);
  const lastStateChange = unixOrIsoToDate(row.last_state_change ?? row.lastStateChange);
  const downtimeDepth = toNumber(row.scheduled_downtime_depth ?? row.downtime_depth, 0);

  return {
    instanceKey,
    entityId: `host:${hostName}`,
    hostName,
    displayName: getDisplayName(row, hostName),
    address: row.address || row.host_address || row.ip || null,
    status,
    currentState: toNumber(row.current_state ?? row.currentState ?? row.state, -1),
    stateType: getStateType(row),
    lastCheck,
    lastStateChange,
    durationSeconds: getDurationSeconds(row),
    attemptCount: getAttemptCount(row),
    pluginOutput: row.plugin_output || row.output || row.status_text || '',
    acknowledged: toBoolean(row.problem_has_been_acknowledged ?? row.acknowledged),
    acknowledgementType: row.acknowledgement_type || null,
    notificationsEnabled: toOptionalBoolean(row.notifications_enabled ?? row.notificationsEnabled),
    inDowntime: downtimeDepth > 0,
    downtimeDepth,
    isFlapping: toBoolean(row.is_flapping ?? row.flapping),
    rawPayload: row,
  };
}

function normalizeService(instanceKey, row = {}) {
  const hostName = row.host_name || row.host || 'unknown-host';
  const serviceDescription = row.service_description || row.service || row.description || row.name || 'unknown-service';
  const status = getStateLabel(row, 'service');
  const lastCheck = unixOrIsoToDate(row.last_check ?? row.lastCheck);
  const lastStateChange = unixOrIsoToDate(row.last_state_change ?? row.lastStateChange);

  return {
    instanceKey,
    entityId: `service:${hostName}:${serviceDescription}`,
    hostName,
    serviceDescription,
    displayName: getDisplayName(row, serviceDescription),
    status,
    currentState: toNumber(row.current_state ?? row.currentState ?? row.state, -1),
    stateType: getStateType(row),
    lastCheck,
    lastStateChange,
    durationSeconds: getDurationSeconds(row),
    attemptCount: getAttemptCount(row),
    pluginOutput: row.plugin_output || row.output || row.status_text || '',
    acknowledged: toBoolean(row.problem_has_been_acknowledged ?? row.acknowledged),
    acknowledgementType: row.acknowledgement_type || null,
    notificationsEnabled: toOptionalBoolean(row.notifications_enabled ?? row.notificationsEnabled),
    inDowntime: toNumber(row.scheduled_downtime_depth ?? row.downtime_depth, 0) > 0,
    downtimeDepth: toNumber(row.scheduled_downtime_depth ?? row.downtime_depth, 0),
    isFlapping: toBoolean(row.is_flapping ?? row.flapping),
    performanceData: row.performance_data || row.perfdata || row.performanceData || null,
    rawPayload: row,
  };
}

function normalizeEvent(instanceKey, row = {}) {
  const hostName = row.host_name || row.host || null;
  const serviceDescription = row.service_description || row.service || null;
  const eventTime = unixOrIsoToDate(row.state_time ?? row.event_time ?? row.logentry_time ?? row.entry_time ?? row.created_at) || new Date().toISOString();
  const status = getStateLabel(row, serviceDescription ? 'service' : 'host');
  const rawId = row.statehistory_id || row.logentry_id || row.event_id || `${eventTime}:${hostName}:${serviceDescription}:${row.output || row.plugin_output || ''}`;

  return {
    instanceKey,
    eventId: String(rawId),
    eventHash: hashId(`${instanceKey}:${rawId}`),
    eventTime,
    hostName,
    serviceDescription,
    eventType: row.state_type || row.event_type || row.entry_type || 'state_change',
    status,
    state: toNumber(row.state ?? row.current_state ?? row.currentState, -1),
    oldState: coalesceValue(row.old_state, row.previous_state, row.last_state, null),
    newState: coalesceValue(row.new_state, row.state, row.current_state, row.currentState, null),
    severity: mapSeverityFromStatus(status, serviceDescription ? 'service' : 'host'),
    acknowledged: toBoolean(row.problem_has_been_acknowledged ?? row.acknowledged),
    inDowntime: toNumber(row.scheduled_downtime_depth ?? row.downtime_depth, 0) > 0,
    output: row.output || row.plugin_output || row.message || '',
    rawPayload: row,
  };
}

function buildSummary(items, type) {
  const keys = type === 'host'
    ? ['up', 'down', 'unreachable', 'pending']
    : ['ok', 'warning', 'critical', 'unknown', 'pending'];
  const counts = Object.fromEntries(keys.map((key) => [key, 0]));

  items.forEach((item) => {
    counts[item.status] = (counts[item.status] || 0) + 1;
  });

  return {
    total: items.length,
    ...counts,
    acknowledged: items.filter((item) => item.acknowledged).length,
    inDowntime: items.filter((item) => item.inDowntime).length,
    problems: items.filter((item) => !['ok', 'up', 'pending'].includes(item.status)).length,
  };
}

function buildWorkspaceSummary(items, type) {
  const summary = buildSummary(items, type);
  const unhandled = items.filter((item) => (
    isProblem(item)
    && !item.acknowledged
    && !item.inDowntime
  )).length;

  return {
    ...summary,
    unhandled,
  };
}

function isProblem(item) {
  return !['ok', 'up', 'pending'].includes(item.status);
}

function buildNagiosUiUrl(config, path = '') {
  if (!config.baseUrl) {
    return null;
  }

  try {
    const url = new URL(config.baseUrl);
    const normalizedPath = url.pathname.replace(/\/+$/, '');
    const nagiosRoot = /\/nagiosxi/i.test(normalizedPath)
      ? `${url.origin}${normalizedPath.replace(/\/api\/v1$/i, '')}`
      : `${url.origin}${normalizedPath}/nagiosxi`;

    return `${nagiosRoot}${path}`;
  } catch {
    return config.baseUrl;
  }
}

function getSourceTimestamp(row, ...keys) {
  const value = coalesceValue(...keys.map((key) => row?.[key]));

  return value === undefined || value === null || value === '' ? null : String(value);
}

function deriveWorkspaceDurationSeconds(item, generatedAt) {
  const hasNagiosDuration = item.durationSeconds !== null
    && item.durationSeconds !== undefined
    && item.durationSeconds !== ''
    && Number.isFinite(Number(item.durationSeconds));

  if (hasNagiosDuration) {
    return Math.max(0, Math.round(Number(item.durationSeconds)));
  }

  if (!item.lastStateChange) {
    return null;
  }

  const start = new Date(item.lastStateChange).getTime();
  const end = new Date(generatedAt).getTime();

  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) {
    return null;
  }

  return Math.floor((end - start) / 1000);
}

function nagiosGroupNames(value) {
  if (!value) return [];
  const values = Array.isArray(value) ? value
    : typeof value === 'object' ? Object.values(value)
      : String(value).split(',');
  return [...new Set(values.flatMap((item) => {
    if (item && typeof item === 'object') {
      return [item.name, item.hostgroup_name, item.servicegroup_name, item.alias].filter(Boolean);
    }
    return String(item || '').split(',').map((entry) => entry.trim()).filter(Boolean);
  }))];
}

function safeNagiosCustomVariables(row = {}) {
  const containers = [row.custom_variables, row.customVariables, row.customvars]
    .filter((value) => value && typeof value === 'object' && !Array.isArray(value));
  const entries = containers.flatMap((value) => Object.entries(value));
  Object.entries(row).forEach(([key, value]) => {
    if (/^_[A-Z0-9_]+$/i.test(key)) entries.push([key, value]);
  });
  return Object.fromEntries(entries.map(([key, value]) => [key,
    /(pass|secret|token|key|credential|community|auth|private)/i.test(key)
      ? '[REDACTED]' : value]));
}

function safeNagiosCheckCommand(value) {
  const command = String(value || '').trim();
  return command ? command.split('!')[0] : null;
}

function mapWorkspaceEntity(item, type, generatedAt, sourceUrl) {
  const raw = item.rawPayload || {};
  const hasNagiosDuration = item.durationSeconds !== null
    && item.durationSeconds !== undefined
    && item.durationSeconds !== ''
    && Number.isFinite(Number(item.durationSeconds));

  return {
    id: item.entityId,
    type,
    hostName: item.hostName,
    ...(type === 'service' ? { serviceDescription: item.serviceDescription } : {}),
    displayName: item.displayName || null,
    address: type === 'host' ? item.address || null : null,
    hostGroups: nagiosGroupNames(raw.hostgroups || raw.host_groups || raw.hostgroup_names),
    serviceGroups: type === 'service'
      ? nagiosGroupNames(raw.servicegroups || raw.service_groups || raw.servicegroup_names) : [],
    status: item.status,
    currentState: item.currentState,
    stateType: item.stateType || null,
    statusInformation: item.pluginOutput || null,
    pluginOutput: item.pluginOutput || null,
    longPluginOutput: raw.long_plugin_output || raw.longPluginOutput || null,
    performanceData: type === 'service' ? item.performanceData || null : null,
    lastCheck: item.lastCheck,
    lastCheckSource: getSourceTimestamp(raw, 'last_check', 'lastCheck'),
    nextCheck: unixOrIsoToDate(raw.next_check ?? raw.nextCheck),
    nextCheckSource: getSourceTimestamp(raw, 'next_check', 'nextCheck'),
    lastStateChange: item.lastStateChange,
    lastStateChangeSource: getSourceTimestamp(raw, 'last_state_change', 'lastStateChange'),
    attempt: item.attemptCount,
    maxAttempts: toNumber(coalesceValue(raw.max_check_attempts, raw.maxCheckAttempts), null),
    acknowledged: Boolean(item.acknowledged),
    acknowledgementType: item.acknowledgementType || null,
    notificationsEnabled: item.notificationsEnabled,
    scheduledDowntime: Boolean(item.inDowntime),
    durationSeconds: deriveWorkspaceDurationSeconds(item, generatedAt),
    durationSource: hasNagiosDuration ? 'nagios' : 'derived',
    checkCommand: safeNagiosCheckCommand(raw.check_command || raw.checkCommand),
    customVariables: safeNagiosCustomVariables(raw),
    sourceUrl,
  };
}

function mapWorkspaceEntities(items, type, generatedAt, sourceUrl) {
  const occurrences = new Map();

  return items.map((item) => {
    const mapped = mapWorkspaceEntity(item, type, generatedAt, sourceUrl);
    const occurrence = (occurrences.get(mapped.id) || 0) + 1;

    occurrences.set(mapped.id, occurrence);

    return occurrence === 1
      ? mapped
      : { ...mapped, id: `${mapped.id}#${occurrence}` };
  });
}

function withWorkspaceCacheMetadata(snapshot, cached, cachedAt) {
  return {
    ...snapshot,
    cache: {
      cached,
      ageSeconds: Math.max(0, Math.floor((Date.now() - cachedAt) / 1000)),
      ttlSeconds: Math.round(WORKSPACE_CACHE_TTL_MS / 1000),
    },
  };
}

async function fetchWorkspaceSnapshot(instanceKey) {
  const config = await getInstanceRuntimeConfig(instanceKey);

  if (!config.configured) {
    const error = new Error(`${config.label} is not configured.`);
    error.status = 503;
    error.safeMessage = `${config.label} connection is unavailable because its backend configuration is incomplete.`;
    throw error;
  }

  const startedAt = Date.now();
  const generatedAt = new Date().toISOString();
  const [statusResponse, hostResponse, serviceResponse] = await Promise.all([
    fetchJson(buildNagiosUrl(config, 'system/status', { pretty: 0 }), 'read_workspace_status'),
    fetchPaginatedRows(config, 'objects/hoststatus', ['hoststatus', 'hosts']),
    fetchPaginatedRows(config, 'objects/servicestatus', ['servicestatus', 'services']),
  ]);
  const hosts = hostResponse.rows.map((row) => normalizeHost(config.key, row));
  const services = serviceResponse.rows.map((row) => normalizeService(config.key, row));
  const sourceUrl = buildNagiosUiUrl(config);

  return {
    instance: {
      ...mapInstanceConfig(config),
      environment: config.key === 'd02' ? 'DC02' : 'DC01',
    },
    connection: 'connected',
    readOnly: true,
    sourceUpdatedAt: statusResponse.payload?.status_update_time || null,
    sourceTimestampTimezone: null,
    fetchedAt: generatedAt,
    retrievalDurationMs: Date.now() - startedAt,
    responseTimeMs: Math.max(
      statusResponse.responseTimeMs || 0,
      hostResponse.responseTimeMs || 0,
      serviceResponse.responseTimeMs || 0,
    ),
    pagination: {
      pageSize: WORKSPACE_PAGE_SIZE,
      hosts: hostResponse.pages,
      services: serviceResponse.pages,
    },
    hostSummary: buildWorkspaceSummary(hosts, 'host'),
    serviceSummary: buildWorkspaceSummary(services, 'service'),
    hosts: mapWorkspaceEntities(hosts, 'host', generatedAt, sourceUrl),
    services: mapWorkspaceEntities(services, 'service', generatedAt, sourceUrl),
  };
}

async function getWorkspaceSnapshot(instanceKey, options = {}) {
  const key = getInstanceDefinition(instanceKey).key;
  const forceRefresh = Boolean(options.forceRefresh);
  const cached = workspaceCache.get(key);

  if (!forceRefresh && cached && Date.now() - cached.cachedAt < WORKSPACE_CACHE_TTL_MS) {
    return withWorkspaceCacheMetadata(cached.snapshot, true, cached.cachedAt);
  }

  if (workspaceRequests.has(key)) {
    return workspaceRequests.get(key);
  }

  const request = fetchWorkspaceSnapshot(key)
    .then((snapshot) => {
      const cachedAt = Date.now();
      workspaceCache.set(key, { cachedAt, snapshot });
      return withWorkspaceCacheMetadata(snapshot, false, cachedAt);
    })
    .finally(() => {
      workspaceRequests.delete(key);
    });

  workspaceRequests.set(key, request);
  return request;
}

async function getWorkspaceOverview(instanceKey, options = {}) {
  const snapshot = await getWorkspaceSnapshot(instanceKey, options);
  const { hosts, services, ...overview } = snapshot;

  return overview;
}

function workspaceProblemStates(type) {
  return type === 'host'
    ? new Set(['down', 'unreachable'])
    : new Set(['warning', 'unknown', 'critical']);
}

function matchesWorkspaceStatus(item, type, status) {
  const problemStates = workspaceProblemStates(type);

  if (status === 'all') {
    return true;
  }

  if (status === 'problems') {
    return problemStates.has(item.status);
  }

  if (status === 'unhandled') {
    return problemStates.has(item.status) && !item.acknowledged && !item.scheduledDowntime;
  }

  return item.status === status;
}

function validateWorkspaceListOptions(type, options = {}) {
  const allowedStatuses = type === 'host'
    ? new Set(['up', 'down', 'unreachable', 'pending', 'problems', 'unhandled', 'all'])
    : new Set(['ok', 'warning', 'unknown', 'critical', 'pending', 'problems', 'unhandled', 'all']);
  const status = String(options.status || 'all').toLowerCase();

  if (!['host', 'service'].includes(type)) {
    const error = new Error('Nagios record type must be host or service.');
    error.status = 400;
    throw error;
  }

  if (!allowedStatuses.has(status)) {
    const error = new Error(`Unsupported Nagios ${type} status filter: ${status}`);
    error.status = 400;
    throw error;
  }

  const requestedPageSize = Number(options.pageSize || 25);
  const pageSize = WORKSPACE_LIST_PAGE_SIZES.has(requestedPageSize) ? requestedPageSize : 25;
  const sort = WORKSPACE_SORT_FIELDS.has(options.sort) ? options.sort : (type === 'service' ? 'service' : 'host');

  return {
    status,
    search: String(options.search || '').trim().toLowerCase().slice(0, 200),
    sort,
    direction: String(options.direction || 'asc').toLowerCase() === 'desc' ? 'desc' : 'asc',
    page: Math.max(1, Number.parseInt(options.page, 10) || 1),
    pageSize,
  };
}

function workspaceSortValue(item, field) {
  if (field === 'host') return item.hostName || '';
  if (field === 'service') return item.serviceDescription || '';
  if (field === 'status') return item.status || '';
  if (field === 'duration') return Number(item.durationSeconds ?? -1);
  if (field === 'lastCheck') return item.lastCheck ? new Date(item.lastCheck).getTime() : -1;
  if (field === 'lastStateChange') return item.lastStateChange ? new Date(item.lastStateChange).getTime() : -1;
  return '';
}

function compareWorkspaceRecords(left, right, field, direction) {
  const leftValue = workspaceSortValue(left, field);
  const rightValue = workspaceSortValue(right, field);
  const comparison = typeof leftValue === 'number' && typeof rightValue === 'number'
    ? leftValue - rightValue
    : String(leftValue).localeCompare(String(rightValue), undefined, { numeric: true, sensitivity: 'base' });

  if (comparison !== 0) {
    return direction === 'desc' ? -comparison : comparison;
  }

  return String(left.id).localeCompare(String(right.id));
}

async function listWorkspaceRecords(instanceKey, type, options = {}) {
  const normalizedType = String(type || '').toLowerCase();
  const filters = validateWorkspaceListOptions(normalizedType, options);
  const snapshot = await getWorkspaceSnapshot(instanceKey, { forceRefresh: options.forceRefresh === true });
  const records = normalizedType === 'host' ? snapshot.hosts : snapshot.services;
  const filtered = records
    .filter((item) => matchesWorkspaceStatus(item, normalizedType, filters.status))
    .filter((item) => {
      if (!filters.search) return true;
      return [item.hostName, item.serviceDescription, item.statusInformation]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(filters.search));
    })
    .sort((left, right) => compareWorkspaceRecords(left, right, filters.sort, filters.direction));
  const total = filtered.length;
  const totalPages = Math.max(1, Math.ceil(total / filters.pageSize));
  const page = Math.min(filters.page, totalPages);
  const offset = (page - 1) * filters.pageSize;

  return {
    instance: snapshot.instance,
    connection: snapshot.connection,
    readOnly: true,
    sourceUpdatedAt: snapshot.sourceUpdatedAt,
    sourceTimestampTimezone: snapshot.sourceTimestampTimezone,
    fetchedAt: snapshot.fetchedAt,
    filter: {
      type: normalizedType,
      status: filters.status,
      search: filters.search,
      sort: filters.sort,
      direction: filters.direction,
    },
    pagination: {
      page,
      pageSize: filters.pageSize,
      total,
      totalPages,
      from: total ? offset + 1 : 0,
      to: Math.min(offset + filters.pageSize, total),
    },
    items: filtered.slice(offset, offset + filters.pageSize),
  };
}

async function getWorkspaceRecord(instanceKey, type, recordId) {
  const normalizedType = String(type || '').toLowerCase();

  if (!['host', 'service'].includes(normalizedType)) {
    const error = new Error('Nagios record type must be host or service.');
    error.status = 400;
    throw error;
  }

  const snapshot = await getWorkspaceSnapshot(instanceKey);
  const records = normalizedType === 'host' ? snapshot.hosts : snapshot.services;
  const item = records.find((record) => record.id === recordId);

  if (!item) {
    const error = new Error(`Nagios ${normalizedType} record was not found in the current ${snapshot.instance.environment} snapshot.`);
    error.status = 404;
    throw error;
  }

  return {
    instance: snapshot.instance,
    readOnly: true,
    sourceUpdatedAt: snapshot.sourceUpdatedAt,
    sourceTimestampTimezone: snapshot.sourceTimestampTimezone,
    fetchedAt: snapshot.fetchedAt,
    item,
  };
}

function clearNagiosWorkspaceCache() {
  workspaceCache.clear();
  workspaceRequests.clear();
}

async function runNagiosStorageSetup(client = db) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS nagios_host_status (
      instance_key TEXT NOT NULL,
      host_name TEXT NOT NULL,
      display_name TEXT,
      address TEXT,
      status TEXT NOT NULL,
      current_state INTEGER,
      last_check TIMESTAMPTZ,
      last_state_change TIMESTAMPTZ,
      plugin_output TEXT,
      acknowledged BOOLEAN NOT NULL DEFAULT FALSE,
      acknowledgement_type TEXT,
      in_downtime BOOLEAN NOT NULL DEFAULT FALSE,
      downtime_depth INTEGER NOT NULL DEFAULT 0,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      last_polled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (instance_key, host_name)
    );

    CREATE TABLE IF NOT EXISTS nagios_service_status (
      instance_key TEXT NOT NULL,
      host_name TEXT NOT NULL,
      service_description TEXT NOT NULL,
      display_name TEXT,
      status TEXT NOT NULL,
      current_state INTEGER,
      last_check TIMESTAMPTZ,
      last_state_change TIMESTAMPTZ,
      plugin_output TEXT,
      acknowledged BOOLEAN NOT NULL DEFAULT FALSE,
      acknowledgement_type TEXT,
      in_downtime BOOLEAN NOT NULL DEFAULT FALSE,
      downtime_depth INTEGER NOT NULL DEFAULT 0,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      last_polled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (instance_key, host_name, service_description)
    );

    CREATE TABLE IF NOT EXISTS nagios_active_problems (
      instance_key TEXT NOT NULL,
      problem_key TEXT NOT NULL,
      problem_type TEXT NOT NULL,
      host_name TEXT,
      service_description TEXT,
      status TEXT NOT NULL,
      severity TEXT NOT NULL,
      acknowledged BOOLEAN NOT NULL DEFAULT FALSE,
      in_downtime BOOLEAN NOT NULL DEFAULT FALSE,
      plugin_output TEXT,
      last_check TIMESTAMPTZ,
      last_state_change TIMESTAMPTZ,
      raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      last_polled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (instance_key, problem_key)
    );

    CREATE TABLE IF NOT EXISTS nagios_event_history (
      instance_key TEXT NOT NULL,
      event_hash TEXT NOT NULL,
      event_id TEXT,
      event_time TIMESTAMPTZ NOT NULL,
      host_name TEXT,
      service_description TEXT,
      event_type TEXT,
      status TEXT,
      state INTEGER,
      output TEXT,
      raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (instance_key, event_hash)
    );

    CREATE TABLE IF NOT EXISTS nagios_summary_snapshots (
      instance_key TEXT NOT NULL,
      summary_type TEXT NOT NULL,
      status_counts JSONB NOT NULL DEFAULT '{}'::jsonb,
      raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      last_polled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (instance_key, summary_type)
    );

    ALTER TABLE nagios_host_status
      ADD COLUMN IF NOT EXISTS state_type TEXT,
      ADD COLUMN IF NOT EXISTS duration_seconds INTEGER,
      ADD COLUMN IF NOT EXISTS attempt_count INTEGER,
      ADD COLUMN IF NOT EXISTS is_flapping BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE,
      ADD COLUMN IF NOT EXISTS entity_hash TEXT;

    ALTER TABLE nagios_service_status
      ADD COLUMN IF NOT EXISTS state_type TEXT,
      ADD COLUMN IF NOT EXISTS duration_seconds INTEGER,
      ADD COLUMN IF NOT EXISTS attempt_count INTEGER,
      ADD COLUMN IF NOT EXISTS is_flapping BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS performance_data TEXT,
      ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE,
      ADD COLUMN IF NOT EXISTS entity_hash TEXT;

    ALTER TABLE nagios_active_problems
      ADD COLUMN IF NOT EXISTS current_state INTEGER,
      ADD COLUMN IF NOT EXISTS duration_seconds INTEGER;

    ALTER TABLE nagios_event_history
      ADD COLUMN IF NOT EXISTS old_state TEXT,
      ADD COLUMN IF NOT EXISTS new_state TEXT,
      ADD COLUMN IF NOT EXISTS severity TEXT,
      ADD COLUMN IF NOT EXISTS acknowledged BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS in_downtime BOOLEAN NOT NULL DEFAULT FALSE;

    CREATE TABLE IF NOT EXISTS nagios_hosts (
      source_instance TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      host_name TEXT NOT NULL,
      display_name TEXT,
      address TEXT,
      state INTEGER,
      state_type TEXT,
      status TEXT NOT NULL,
      last_check TIMESTAMPTZ,
      last_state_change TIMESTAMPTZ,
      duration_seconds INTEGER,
      attempt_count INTEGER,
      output TEXT,
      acknowledged BOOLEAN NOT NULL DEFAULT FALSE,
      acknowledgement_type TEXT,
      in_downtime BOOLEAN NOT NULL DEFAULT FALSE,
      downtime_depth INTEGER NOT NULL DEFAULT 0,
      unreachable_or_down BOOLEAN NOT NULL DEFAULT FALSE,
      is_flapping BOOLEAN NOT NULL DEFAULT FALSE,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      last_polled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (source_instance, host_name)
    );

    CREATE TABLE IF NOT EXISTS nagios_services (
      source_instance TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      host_name TEXT NOT NULL,
      service_name TEXT NOT NULL,
      display_name TEXT,
      state INTEGER,
      state_type TEXT,
      status TEXT NOT NULL,
      last_check TIMESTAMPTZ,
      last_state_change TIMESTAMPTZ,
      duration_seconds INTEGER,
      attempt_count INTEGER,
      output TEXT,
      acknowledged BOOLEAN NOT NULL DEFAULT FALSE,
      acknowledgement_type TEXT,
      in_downtime BOOLEAN NOT NULL DEFAULT FALSE,
      downtime_depth INTEGER NOT NULL DEFAULT 0,
      is_flapping BOOLEAN NOT NULL DEFAULT FALSE,
      performance_data TEXT,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      last_polled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (source_instance, host_name, service_name)
    );

    ALTER TABLE nagios_hosts
      ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE,
      ADD COLUMN IF NOT EXISTS entity_hash TEXT;

    ALTER TABLE nagios_services
      ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE,
      ADD COLUMN IF NOT EXISTS entity_hash TEXT;

    CREATE TABLE IF NOT EXISTS nagios_summaries (
      source_instance TEXT NOT NULL,
      summary_type TEXT NOT NULL,
      total_count INTEGER NOT NULL DEFAULT 0,
      status_counts JSONB NOT NULL DEFAULT '{}'::jsonb,
      raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      last_updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (source_instance, summary_type)
    );

    CREATE TABLE IF NOT EXISTS nagios_problems (
      source_instance TEXT NOT NULL,
      problem_key TEXT NOT NULL,
      problem_type TEXT NOT NULL,
      host_name TEXT,
      service_name TEXT,
      severity TEXT NOT NULL,
      current_state INTEGER,
      status TEXT NOT NULL,
      first_detected_at TIMESTAMPTZ,
      last_changed_at TIMESTAMPTZ,
      duration_seconds INTEGER,
      acknowledged BOOLEAN NOT NULL DEFAULT FALSE,
      in_downtime BOOLEAN NOT NULL DEFAULT FALSE,
      output TEXT,
      deep_link TEXT,
      raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      last_polled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (source_instance, problem_key)
    );

    CREATE TABLE IF NOT EXISTS nagios_events (
      source_instance TEXT NOT NULL,
      event_hash TEXT NOT NULL,
      event_id TEXT,
      event_type TEXT,
      host_name TEXT,
      service_name TEXT,
      old_state TEXT,
      new_state TEXT,
      event_timestamp TIMESTAMPTZ NOT NULL,
      severity TEXT,
      acknowledged BOOLEAN NOT NULL DEFAULT FALSE,
      in_downtime BOOLEAN NOT NULL DEFAULT FALSE,
      output TEXT,
      raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (source_instance, event_hash)
    );

    CREATE TABLE IF NOT EXISTS nagios_downtime (
      source_instance TEXT NOT NULL,
      downtime_key TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      host_name TEXT,
      service_name TEXT,
      author TEXT,
      comment TEXT,
      start_time TIMESTAMPTZ,
      end_time TIMESTAMPTZ,
      duration_seconds INTEGER,
      fixed BOOLEAN,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      last_polled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (source_instance, downtime_key)
    );

    CREATE TABLE IF NOT EXISTS nagios_ai_features (
      source_instance TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      entity_name TEXT NOT NULL,
      feature_timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      current_state TEXT,
      previous_state TEXT,
      state_change_count INTEGER NOT NULL DEFAULT 0,
      recurrence_count INTEGER NOT NULL DEFAULT 0,
      alert_frequency NUMERIC,
      alert_density NUMERIC,
      time_since_last_change_seconds INTEGER,
      time_since_last_alert_seconds INTEGER,
      time_since_last_recovery_seconds INTEGER,
      average_problem_duration_seconds NUMERIC,
      maximum_problem_duration_seconds INTEGER,
      minimum_problem_duration_seconds INTEGER,
      recovery_time_seconds INTEGER,
      flapping_score NUMERIC,
      stability_score NUMERIC,
      downtime_count INTEGER NOT NULL DEFAULT 0,
      acknowledgement_count INTEGER NOT NULL DEFAULT 0,
      severity_score NUMERIC,
      volatility_score NUMERIC,
      trend_direction TEXT,
      noise_likelihood NUMERIC,
      incident_likelihood NUMERIC,
      flapping_likelihood NUMERIC,
      recurrence_likelihood NUMERIC,
      correlation_likelihood NUMERIC,
      correlation_placeholder JSONB NOT NULL DEFAULT '{}'::jsonb,
      ai_label TEXT NOT NULL DEFAULT 'unknown',
      ai_confidence NUMERIC,
      ai_reason TEXT,
      raw_payload_reference TEXT,
      raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (source_instance, entity_type, entity_id)
    );

    CREATE TABLE IF NOT EXISTS nagios_sync_logs (
      id BIGSERIAL PRIMARY KEY,
      source_instance TEXT NOT NULL,
      sync_type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      finished_at TIMESTAMPTZ,
      duration_ms INTEGER,
      counts JSONB NOT NULL DEFAULT '{}'::jsonb,
      warnings JSONB NOT NULL DEFAULT '[]'::jsonb,
      error_message TEXT,
      raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb
    );

    CREATE TABLE IF NOT EXISTS nagios_poll_history (
      id BIGSERIAL PRIMARY KEY,
      source_instance TEXT NOT NULL,
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ended_at TIMESTAMPTZ,
      duration_ms INTEGER,
      result TEXT NOT NULL DEFAULT 'running',
      failure_stage TEXT,
      failure_type TEXT,
      failure_reason TEXT,
      http_status INTEGER,
      response_time_ms INTEGER,
      retry_count INTEGER NOT NULL DEFAULT 0,
      records_retrieved INTEGER NOT NULL DEFAULT 0,
      records_inserted INTEGER NOT NULL DEFAULT 0,
      records_updated INTEGER NOT NULL DEFAULT 0,
      records_skipped INTEGER NOT NULL DEFAULT 0,
      records_failed INTEGER NOT NULL DEFAULT 0,
      raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS nagios_sync_statistics (
      source_instance TEXT PRIMARY KEY,
      total_polls INTEGER NOT NULL DEFAULT 0,
      successful_polls INTEGER NOT NULL DEFAULT 0,
      failed_polls INTEGER NOT NULL DEFAULT 0,
      last_successful_sync TIMESTAMPTZ,
      last_failed_sync TIMESTAMPTZ,
      average_response_time_ms NUMERIC,
      average_poll_duration_ms NUMERIC,
      records_retrieved INTEGER NOT NULL DEFAULT 0,
      records_inserted INTEGER NOT NULL DEFAULT 0,
      records_updated INTEGER NOT NULL DEFAULT 0,
      records_skipped INTEGER NOT NULL DEFAULT 0,
      records_failed INTEGER NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS nagios_connector_health (
      source_instance TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'disconnected',
      connection_health TEXT NOT NULL DEFAULT 'disconnected',
      failure_stage TEXT,
      failure_type TEXT,
      failure_reason TEXT,
      http_status INTEGER,
      response_time_ms INTEGER,
      last_successful_poll TIMESTAMPTZ,
      last_failed_poll TIMESTAMPTZ,
      last_poll_started_at TIMESTAMPTZ,
      last_poll_ended_at TIMESTAMPTZ,
      records_retrieved INTEGER NOT NULL DEFAULT 0,
      records_inserted INTEGER NOT NULL DEFAULT 0,
      records_updated INTEGER NOT NULL DEFAULT 0,
      records_skipped INTEGER NOT NULL DEFAULT 0,
      retry_count INTEGER NOT NULL DEFAULT 0,
      next_scheduled_poll TIMESTAMPTZ,
      data_freshness_status TEXT NOT NULL DEFAULT 'red',
      data_freshness_seconds INTEGER,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_nagios_service_status_status ON nagios_service_status(instance_key, status);
    CREATE INDEX IF NOT EXISTS idx_nagios_host_status_status ON nagios_host_status(instance_key, status);
    CREATE INDEX IF NOT EXISTS idx_nagios_active_problems_status ON nagios_active_problems(instance_key, status);
    CREATE INDEX IF NOT EXISTS idx_nagios_event_history_time ON nagios_event_history(instance_key, event_time DESC);
    CREATE INDEX IF NOT EXISTS idx_nagios_hosts_instance_state ON nagios_hosts(source_instance, status, last_state_change DESC);
    CREATE INDEX IF NOT EXISTS idx_nagios_hosts_name ON nagios_hosts(source_instance, host_name);
    CREATE INDEX IF NOT EXISTS idx_nagios_services_instance_state ON nagios_services(source_instance, status, last_state_change DESC);
    CREATE INDEX IF NOT EXISTS idx_nagios_services_host ON nagios_services(source_instance, host_name, service_name);
    CREATE INDEX IF NOT EXISTS idx_nagios_problems_instance_state ON nagios_problems(source_instance, status, last_changed_at DESC);
    CREATE INDEX IF NOT EXISTS idx_nagios_problems_host_service ON nagios_problems(source_instance, host_name, service_name);
    CREATE INDEX IF NOT EXISTS idx_nagios_events_instance_time ON nagios_events(source_instance, event_timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_nagios_events_host_service ON nagios_events(source_instance, host_name, service_name);
    CREATE INDEX IF NOT EXISTS idx_nagios_downtime_instance_active ON nagios_downtime(source_instance, active, start_time DESC);
    CREATE INDEX IF NOT EXISTS idx_nagios_ai_features_instance_entity ON nagios_ai_features(source_instance, entity_type, entity_name);
    CREATE INDEX IF NOT EXISTS idx_nagios_ai_features_timestamp ON nagios_ai_features(source_instance, feature_timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_nagios_sync_logs_started ON nagios_sync_logs(source_instance, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_nagios_poll_history_started ON nagios_poll_history(source_instance, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_nagios_poll_history_result ON nagios_poll_history(source_instance, result, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_nagios_connector_health_status ON nagios_connector_health(status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_nagios_host_status_hash ON nagios_host_status(instance_key, entity_hash);
    CREATE INDEX IF NOT EXISTS idx_nagios_service_status_hash ON nagios_service_status(instance_key, entity_hash);

    CREATE TABLE IF NOT EXISTS monitoring_source_status (
      source_key TEXT PRIMARY KEY,
      adapter_name TEXT NOT NULL,
      connection_status TEXT NOT NULL DEFAULT 'not_configured',
      api_health TEXT NOT NULL DEFAULT 'not_configured',
      sync_status TEXT NOT NULL DEFAULT 'idle',
      last_successful_sync TIMESTAMPTZ,
      last_failed_sync TIMESTAMPTZ,
      last_alert_received_at TIMESTAMPTZ,
      total_alerts_imported INTEGER NOT NULL DEFAULT 0,
      last_sync_duration_ms INTEGER,
      response_time_ms INTEGER,
      last_error TEXT,
      sync_cursor TEXT,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

async function ensureNagiosStorage(client = db) {
  if (client !== db) {
    await runNagiosStorageSetup(client);
    return;
  }

  if (nagiosStorageReady) {
    return;
  }

  if (!nagiosStorageReadyPromise) {
    nagiosStorageReadyPromise = runNagiosStorageSetup(db)
      .then(() => {
        nagiosStorageReady = true;
      })
      .finally(() => {
        nagiosStorageReadyPromise = null;
      });
  }

  await nagiosStorageReadyPromise;
}

async function updateSourceStatus(config, values = {}) {
  await ensureNagiosStorage();
  await db.query(
    `
      INSERT INTO monitoring_source_status (
        source_key,
        adapter_name,
        connection_status,
        api_health,
        sync_status,
        last_successful_sync,
        last_failed_sync,
        last_alert_received_at,
        total_alerts_imported,
        last_sync_duration_ms,
        response_time_ms,
        last_error,
        metadata,
        updated_at
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9, 0), $10, $11, $12, $13::jsonb, NOW()
      )
      ON CONFLICT (source_key)
      DO UPDATE SET
        adapter_name = EXCLUDED.adapter_name,
        connection_status = EXCLUDED.connection_status,
        api_health = EXCLUDED.api_health,
        sync_status = EXCLUDED.sync_status,
        last_successful_sync = COALESCE(EXCLUDED.last_successful_sync, monitoring_source_status.last_successful_sync),
        last_failed_sync = COALESCE(EXCLUDED.last_failed_sync, monitoring_source_status.last_failed_sync),
        last_alert_received_at = COALESCE(EXCLUDED.last_alert_received_at, monitoring_source_status.last_alert_received_at),
        total_alerts_imported = GREATEST(monitoring_source_status.total_alerts_imported, EXCLUDED.total_alerts_imported),
        last_sync_duration_ms = COALESCE(EXCLUDED.last_sync_duration_ms, monitoring_source_status.last_sync_duration_ms),
        response_time_ms = COALESCE(EXCLUDED.response_time_ms, monitoring_source_status.response_time_ms),
        last_error = EXCLUDED.last_error,
        metadata = monitoring_source_status.metadata || EXCLUDED.metadata,
        updated_at = NOW()
    `,
    [
      config.sourceKey,
      config.adapterName,
      values.connectionStatus || 'not_configured',
      values.apiHealth || values.connectionStatus || 'not_configured',
      values.syncStatus || 'idle',
      values.lastSuccessfulSync || null,
      values.lastFailedSync || null,
      values.lastAlertReceivedAt || null,
      Number.isFinite(values.totalAlertsImported) ? values.totalAlertsImported : null,
      Number.isFinite(values.lastSyncDurationMs) ? values.lastSyncDurationMs : null,
      Number.isFinite(values.responseTimeMs) ? values.responseTimeMs : null,
      values.lastError || null,
      JSON.stringify({
        label: config.label,
        instance: config.key,
        baseUrlConfigured: Boolean(config.baseUrl),
        apiKeyConfigured: Boolean(config.apiKey),
        ...(values.metadata || {}),
      }),
    ],
  );
}

function getPollingIntervalMs() {
  return Number(process.env.NAGIOS_POLL_INTERVAL_MS || DEFAULT_POLL_INTERVAL_MS);
}

function computeFreshness(lastSuccessfulPoll) {
  const freshnessSeconds = secondsSince(lastSuccessfulPoll);

  if (freshnessSeconds === null) {
    return {
      dataFreshnessStatus: 'red',
      dataFreshnessSeconds: null,
    };
  }

  if (freshnessSeconds < 5 * 60) {
    return {
      dataFreshnessStatus: 'green',
      dataFreshnessSeconds: freshnessSeconds,
    };
  }

  if (freshnessSeconds < 15 * 60) {
    return {
      dataFreshnessStatus: 'yellow',
      dataFreshnessSeconds: freshnessSeconds,
    };
  }

  return {
    dataFreshnessStatus: 'red',
    dataFreshnessSeconds: freshnessSeconds,
  };
}

function getNextScheduledPoll(referenceTime = new Date()) {
  const intervalMs = getPollingIntervalMs();

  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    return null;
  }

  return new Date(new Date(referenceTime).getTime() + intervalMs).toISOString();
}

async function updateConnectorHealth(config, values = {}) {
  await ensureNagiosStorage();
  const existing = await db.query(
    'SELECT last_successful_poll FROM nagios_connector_health WHERE source_instance = $1',
    [config.key],
  );
  const successfulPoll = values.lastSuccessfulPoll || null;
  const freshness = computeFreshness(
    successfulPoll || values.existingLastSuccessfulPoll || existing.rows[0]?.last_successful_poll,
  );

  await db.query(
    `
      INSERT INTO nagios_connector_health (
        source_instance,
        status,
        connection_health,
        failure_stage,
        failure_type,
        failure_reason,
        http_status,
        response_time_ms,
        last_successful_poll,
        last_failed_poll,
        last_poll_started_at,
        last_poll_ended_at,
        records_retrieved,
        records_inserted,
        records_updated,
        records_skipped,
        retry_count,
        next_scheduled_poll,
        data_freshness_status,
        data_freshness_seconds,
        metadata,
        updated_at
      )
      VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,
        COALESCE($13,0),COALESCE($14,0),COALESCE($15,0),COALESCE($16,0),COALESCE($17,0),
        $18,$19,$20,$21::jsonb,NOW()
      )
      ON CONFLICT (source_instance)
      DO UPDATE SET
        status = EXCLUDED.status,
        connection_health = EXCLUDED.connection_health,
        failure_stage = EXCLUDED.failure_stage,
        failure_type = EXCLUDED.failure_type,
        failure_reason = EXCLUDED.failure_reason,
        http_status = COALESCE(EXCLUDED.http_status, nagios_connector_health.http_status),
        response_time_ms = COALESCE(EXCLUDED.response_time_ms, nagios_connector_health.response_time_ms),
        last_successful_poll = COALESCE(EXCLUDED.last_successful_poll, nagios_connector_health.last_successful_poll),
        last_failed_poll = COALESCE(EXCLUDED.last_failed_poll, nagios_connector_health.last_failed_poll),
        last_poll_started_at = COALESCE(EXCLUDED.last_poll_started_at, nagios_connector_health.last_poll_started_at),
        last_poll_ended_at = COALESCE(EXCLUDED.last_poll_ended_at, nagios_connector_health.last_poll_ended_at),
        records_retrieved = COALESCE(EXCLUDED.records_retrieved, nagios_connector_health.records_retrieved),
        records_inserted = COALESCE(EXCLUDED.records_inserted, nagios_connector_health.records_inserted),
        records_updated = COALESCE(EXCLUDED.records_updated, nagios_connector_health.records_updated),
        records_skipped = COALESCE(EXCLUDED.records_skipped, nagios_connector_health.records_skipped),
        retry_count = COALESCE(EXCLUDED.retry_count, nagios_connector_health.retry_count),
        next_scheduled_poll = EXCLUDED.next_scheduled_poll,
        data_freshness_status = EXCLUDED.data_freshness_status,
        data_freshness_seconds = EXCLUDED.data_freshness_seconds,
        metadata = nagios_connector_health.metadata || EXCLUDED.metadata,
        updated_at = NOW()
    `,
    [
      config.key,
      values.status || 'disconnected',
      values.connectionHealth || values.status || 'disconnected',
      values.failureStage || null,
      values.failureType || null,
      values.failureReason || null,
      values.httpStatus || null,
      Number.isFinite(values.responseTimeMs) ? values.responseTimeMs : null,
      successfulPoll,
      values.lastFailedPoll || null,
      values.lastPollStartedAt || null,
      values.lastPollEndedAt || null,
      Number.isFinite(values.recordsRetrieved) ? values.recordsRetrieved : null,
      Number.isFinite(values.recordsInserted) ? values.recordsInserted : null,
      Number.isFinite(values.recordsUpdated) ? values.recordsUpdated : null,
      Number.isFinite(values.recordsSkipped) ? values.recordsSkipped : null,
      Number.isFinite(values.retryCount) ? values.retryCount : null,
      values.nextScheduledPoll || getNextScheduledPoll(values.lastPollEndedAt || new Date()),
      values.dataFreshnessStatus || freshness.dataFreshnessStatus,
      Number.isFinite(values.dataFreshnessSeconds) ? values.dataFreshnessSeconds : freshness.dataFreshnessSeconds,
      JSON.stringify({
        label: config.label,
        sourceKey: config.sourceKey,
        ...(values.metadata || {}),
      }),
    ],
  );
}

async function recordPollHistory(config, poll = {}) {
  await ensureNagiosStorage();
  const result = await db.query(
    `
      INSERT INTO nagios_poll_history (
        source_instance,
        started_at,
        ended_at,
        duration_ms,
        result,
        failure_stage,
        failure_type,
        failure_reason,
        http_status,
        response_time_ms,
        retry_count,
        records_retrieved,
        records_inserted,
        records_updated,
        records_skipped,
        records_failed,
        raw_payload
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb)
      RETURNING id
    `,
    [
      config.key,
      poll.startedAt || new Date().toISOString(),
      poll.endedAt || new Date().toISOString(),
      Number.isFinite(poll.durationMs) ? poll.durationMs : null,
      poll.result || 'failed',
      poll.failureStage || null,
      poll.failureType || null,
      poll.failureReason || null,
      poll.httpStatus || null,
      Number.isFinite(poll.responseTimeMs) ? poll.responseTimeMs : null,
      Number.isFinite(poll.retryCount) ? poll.retryCount : 0,
      Number.isFinite(poll.recordsRetrieved) ? poll.recordsRetrieved : 0,
      Number.isFinite(poll.recordsInserted) ? poll.recordsInserted : 0,
      Number.isFinite(poll.recordsUpdated) ? poll.recordsUpdated : 0,
      Number.isFinite(poll.recordsSkipped) ? poll.recordsSkipped : 0,
      Number.isFinite(poll.recordsFailed) ? poll.recordsFailed : 0,
      JSON.stringify(poll.rawPayload || {}),
    ],
  );

  return result.rows[0]?.id;
}

async function updateSyncStatistics(config, poll = {}) {
  await ensureNagiosStorage();
  const successIncrement = poll.result === 'success' ? 1 : 0;
  const failureIncrement = poll.result === 'failed' ? 1 : 0;

  await db.query(
    `
      INSERT INTO nagios_sync_statistics (
        source_instance,
        total_polls,
        successful_polls,
        failed_polls,
        last_successful_sync,
        last_failed_sync,
        average_response_time_ms,
        average_poll_duration_ms,
        records_retrieved,
        records_inserted,
        records_updated,
        records_skipped,
        records_failed,
        updated_at
      )
      VALUES ($1,1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW())
      ON CONFLICT (source_instance)
      DO UPDATE SET
        total_polls = nagios_sync_statistics.total_polls + 1,
        successful_polls = nagios_sync_statistics.successful_polls + EXCLUDED.successful_polls,
        failed_polls = nagios_sync_statistics.failed_polls + EXCLUDED.failed_polls,
        last_successful_sync = COALESCE(EXCLUDED.last_successful_sync, nagios_sync_statistics.last_successful_sync),
        last_failed_sync = COALESCE(EXCLUDED.last_failed_sync, nagios_sync_statistics.last_failed_sync),
        average_response_time_ms = CASE
          WHEN EXCLUDED.average_response_time_ms IS NULL THEN nagios_sync_statistics.average_response_time_ms
          WHEN nagios_sync_statistics.average_response_time_ms IS NULL THEN EXCLUDED.average_response_time_ms
          ELSE ROUND(((nagios_sync_statistics.average_response_time_ms * nagios_sync_statistics.total_polls) + EXCLUDED.average_response_time_ms) / (nagios_sync_statistics.total_polls + 1), 2)
        END,
        average_poll_duration_ms = CASE
          WHEN EXCLUDED.average_poll_duration_ms IS NULL THEN nagios_sync_statistics.average_poll_duration_ms
          WHEN nagios_sync_statistics.average_poll_duration_ms IS NULL THEN EXCLUDED.average_poll_duration_ms
          ELSE ROUND(((nagios_sync_statistics.average_poll_duration_ms * nagios_sync_statistics.total_polls) + EXCLUDED.average_poll_duration_ms) / (nagios_sync_statistics.total_polls + 1), 2)
        END,
        records_retrieved = nagios_sync_statistics.records_retrieved + EXCLUDED.records_retrieved,
        records_inserted = nagios_sync_statistics.records_inserted + EXCLUDED.records_inserted,
        records_updated = nagios_sync_statistics.records_updated + EXCLUDED.records_updated,
        records_skipped = nagios_sync_statistics.records_skipped + EXCLUDED.records_skipped,
        records_failed = nagios_sync_statistics.records_failed + EXCLUDED.records_failed,
        updated_at = NOW()
    `,
    [
      config.key,
      successIncrement,
      failureIncrement,
      poll.result === 'success' ? poll.endedAt : null,
      poll.result === 'failed' ? poll.endedAt : null,
      Number.isFinite(poll.responseTimeMs) ? poll.responseTimeMs : null,
      Number.isFinite(poll.durationMs) ? poll.durationMs : null,
      Number.isFinite(poll.recordsRetrieved) ? poll.recordsRetrieved : 0,
      Number.isFinite(poll.recordsInserted) ? poll.recordsInserted : 0,
      Number.isFinite(poll.recordsUpdated) ? poll.recordsUpdated : 0,
      Number.isFinite(poll.recordsSkipped) ? poll.recordsSkipped : 0,
      Number.isFinite(poll.recordsFailed) ? poll.recordsFailed : 0,
    ],
  );
}

async function markCurrentRowsInactive(client, instanceKey) {
  await client.query('UPDATE nagios_host_status SET is_active = FALSE, updated_at = NOW() WHERE instance_key = $1', [instanceKey]);
  await client.query('UPDATE nagios_service_status SET is_active = FALSE, updated_at = NOW() WHERE instance_key = $1', [instanceKey]);
  await client.query('UPDATE nagios_hosts SET is_active = FALSE, updated_at = NOW() WHERE source_instance = $1', [instanceKey]);
  await client.query('UPDATE nagios_services SET is_active = FALSE, updated_at = NOW() WHERE source_instance = $1', [instanceKey]);
}

async function upsertHosts(client, hosts) {
  const stats = { inserted: 0, updated: 0, skipped: 0, failed: 0 };

  for (const host of hosts) {
    const entityHash = stableHash({
      hostName: host.hostName,
      displayName: host.displayName,
      address: host.address,
      status: host.status,
      currentState: host.currentState,
      stateType: host.stateType,
      lastCheck: host.lastCheck,
      lastStateChange: host.lastStateChange,
      durationSeconds: host.durationSeconds,
      attemptCount: host.attemptCount,
      pluginOutput: host.pluginOutput,
      acknowledged: host.acknowledged,
      acknowledgementType: host.acknowledgementType,
      inDowntime: host.inDowntime,
      downtimeDepth: host.downtimeDepth,
      isFlapping: host.isFlapping,
    });
    const existing = await client.query(
      'SELECT entity_hash FROM nagios_host_status WHERE instance_key = $1 AND host_name = $2',
      [host.instanceKey, host.hostName],
    );

    if (existing.rows[0]?.entity_hash === entityHash) {
      await client.query(
        `
          UPDATE nagios_host_status
          SET is_active = TRUE, last_polled_at = NOW(), updated_at = NOW()
          WHERE instance_key = $1 AND host_name = $2
        `,
        [host.instanceKey, host.hostName],
      );
      stats.skipped += 1;
      continue;
    }

    await client.query(
      `
        INSERT INTO nagios_host_status (
          instance_key, host_name, display_name, address, status, current_state,
          state_type, last_check, last_state_change, duration_seconds, attempt_count,
          plugin_output, acknowledged, acknowledgement_type, in_downtime, downtime_depth,
          is_flapping, entity_hash, raw_payload,
          last_polled_at, updated_at
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19::jsonb,NOW(),NOW())
        ON CONFLICT (instance_key, host_name)
        DO UPDATE SET
          display_name = EXCLUDED.display_name,
          address = EXCLUDED.address,
          status = EXCLUDED.status,
          current_state = EXCLUDED.current_state,
          state_type = EXCLUDED.state_type,
          last_check = EXCLUDED.last_check,
          last_state_change = EXCLUDED.last_state_change,
          duration_seconds = EXCLUDED.duration_seconds,
          attempt_count = EXCLUDED.attempt_count,
          plugin_output = EXCLUDED.plugin_output,
          acknowledged = EXCLUDED.acknowledged,
          acknowledgement_type = EXCLUDED.acknowledgement_type,
          in_downtime = EXCLUDED.in_downtime,
          downtime_depth = EXCLUDED.downtime_depth,
          is_flapping = EXCLUDED.is_flapping,
          is_active = TRUE,
          entity_hash = EXCLUDED.entity_hash,
          raw_payload = EXCLUDED.raw_payload,
          last_polled_at = NOW(),
          updated_at = NOW()
      `,
      [
        host.instanceKey,
        host.hostName,
        host.displayName,
        host.address,
        host.status,
        host.currentState,
        host.stateType,
        host.lastCheck,
        host.lastStateChange,
        host.durationSeconds,
        host.attemptCount,
        host.pluginOutput,
        host.acknowledged,
        host.acknowledgementType,
        host.inDowntime,
        host.downtimeDepth,
        host.isFlapping,
        entityHash,
        JSON.stringify(host.rawPayload || {}),
      ],
    );

    if (existing.rows.length) {
      stats.updated += 1;
    } else {
      stats.inserted += 1;
    }
  }

  return stats;
}

async function upsertServices(client, services) {
  const stats = { inserted: 0, updated: 0, skipped: 0, failed: 0 };

  for (const service of services) {
    const entityHash = stableHash({
      hostName: service.hostName,
      serviceDescription: service.serviceDescription,
      displayName: service.displayName,
      status: service.status,
      currentState: service.currentState,
      stateType: service.stateType,
      lastCheck: service.lastCheck,
      lastStateChange: service.lastStateChange,
      durationSeconds: service.durationSeconds,
      attemptCount: service.attemptCount,
      pluginOutput: service.pluginOutput,
      acknowledged: service.acknowledged,
      acknowledgementType: service.acknowledgementType,
      inDowntime: service.inDowntime,
      downtimeDepth: service.downtimeDepth,
      isFlapping: service.isFlapping,
      performanceData: service.performanceData,
    });
    const existing = await client.query(
      'SELECT entity_hash FROM nagios_service_status WHERE instance_key = $1 AND host_name = $2 AND service_description = $3',
      [service.instanceKey, service.hostName, service.serviceDescription],
    );

    if (existing.rows[0]?.entity_hash === entityHash) {
      await client.query(
        `
          UPDATE nagios_service_status
          SET is_active = TRUE, last_polled_at = NOW(), updated_at = NOW()
          WHERE instance_key = $1 AND host_name = $2 AND service_description = $3
        `,
        [service.instanceKey, service.hostName, service.serviceDescription],
      );
      stats.skipped += 1;
      continue;
    }

    await client.query(
      `
        INSERT INTO nagios_service_status (
          instance_key, host_name, service_description, display_name, status,
          current_state, state_type, last_check, last_state_change, duration_seconds,
          attempt_count, plugin_output, acknowledged, acknowledgement_type, in_downtime,
          downtime_depth, is_flapping, performance_data, entity_hash, raw_payload, last_polled_at, updated_at
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20::jsonb,NOW(),NOW())
        ON CONFLICT (instance_key, host_name, service_description)
        DO UPDATE SET
          display_name = EXCLUDED.display_name,
          status = EXCLUDED.status,
          current_state = EXCLUDED.current_state,
          state_type = EXCLUDED.state_type,
          last_check = EXCLUDED.last_check,
          last_state_change = EXCLUDED.last_state_change,
          duration_seconds = EXCLUDED.duration_seconds,
          attempt_count = EXCLUDED.attempt_count,
          plugin_output = EXCLUDED.plugin_output,
          acknowledged = EXCLUDED.acknowledged,
          acknowledgement_type = EXCLUDED.acknowledgement_type,
          in_downtime = EXCLUDED.in_downtime,
          downtime_depth = EXCLUDED.downtime_depth,
          is_flapping = EXCLUDED.is_flapping,
          performance_data = EXCLUDED.performance_data,
          is_active = TRUE,
          entity_hash = EXCLUDED.entity_hash,
          raw_payload = EXCLUDED.raw_payload,
          last_polled_at = NOW(),
          updated_at = NOW()
      `,
      [
        service.instanceKey,
        service.hostName,
        service.serviceDescription,
        service.displayName,
        service.status,
        service.currentState,
        service.stateType,
        service.lastCheck,
        service.lastStateChange,
        service.durationSeconds,
        service.attemptCount,
        service.pluginOutput,
        service.acknowledged,
        service.acknowledgementType,
        service.inDowntime,
        service.downtimeDepth,
        service.isFlapping,
        service.performanceData,
        entityHash,
        JSON.stringify(service.rawPayload || {}),
      ],
    );

    if (existing.rows.length) {
      stats.updated += 1;
    } else {
      stats.inserted += 1;
    }
  }

  return stats;
}

async function replaceActiveProblems(client, instanceKey, problems) {
  await client.query('DELETE FROM nagios_active_problems WHERE instance_key = $1', [instanceKey]);

  for (const problem of problems) {
    await client.query(
      `
        INSERT INTO nagios_active_problems (
          instance_key, problem_key, problem_type, host_name, service_description,
          status, severity, current_state, duration_seconds, acknowledged, in_downtime,
          plugin_output, last_check, last_state_change, raw_payload, last_polled_at, updated_at
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,NOW(),NOW())
        ON CONFLICT (instance_key, problem_key)
        DO UPDATE SET
          status = EXCLUDED.status,
          severity = EXCLUDED.severity,
          current_state = EXCLUDED.current_state,
          duration_seconds = EXCLUDED.duration_seconds,
          acknowledged = EXCLUDED.acknowledged,
          in_downtime = EXCLUDED.in_downtime,
          plugin_output = EXCLUDED.plugin_output,
          last_check = EXCLUDED.last_check,
          last_state_change = EXCLUDED.last_state_change,
          raw_payload = EXCLUDED.raw_payload,
          last_polled_at = NOW(),
          updated_at = NOW()
      `,
      [
        problem.instanceKey,
        problem.problemKey,
        problem.problemType,
        problem.hostName,
        problem.serviceDescription,
        problem.status,
        problem.severity,
        problem.currentState,
        problem.durationSeconds,
        problem.acknowledged,
        problem.inDowntime,
        problem.pluginOutput,
        problem.lastCheck,
        problem.lastStateChange,
        JSON.stringify(problem.rawPayload || {}),
      ],
    );
  }
}

async function upsertEvents(client, events) {
  for (const event of events) {
    await client.query(
      `
        INSERT INTO nagios_event_history (
          instance_key, event_hash, event_id, event_time, host_name,
          service_description, event_type, status, state, old_state, new_state,
          severity, acknowledged, in_downtime, output, raw_payload
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb)
        ON CONFLICT (instance_key, event_hash)
        DO NOTHING
      `,
      [
        event.instanceKey,
        event.eventHash,
        event.eventId,
        event.eventTime,
        event.hostName,
        event.serviceDescription,
        event.eventType,
        event.status,
        event.state,
        event.oldState === null || event.oldState === undefined ? null : String(event.oldState),
        event.newState === null || event.newState === undefined ? null : String(event.newState),
        event.severity,
        event.acknowledged,
        event.inDowntime,
        event.output,
        JSON.stringify(event.rawPayload || {}),
      ],
    );
  }
}

async function upsertSummaries(client, instanceKey, serviceSummary, hostSummary, raw = {}) {
  for (const [summaryType, summary] of [['service', serviceSummary], ['host', hostSummary]]) {
    await client.query(
      `
        INSERT INTO nagios_summary_snapshots (instance_key, summary_type, status_counts, raw_payload, last_polled_at)
        VALUES ($1, $2, $3::jsonb, $4::jsonb, NOW())
        ON CONFLICT (instance_key, summary_type)
        DO UPDATE SET
          status_counts = EXCLUDED.status_counts,
          raw_payload = EXCLUDED.raw_payload,
          last_polled_at = NOW()
      `,
      [
        instanceKey,
        summaryType,
        JSON.stringify(summary),
        JSON.stringify(raw[summaryType] || {}),
      ],
    );
  }
}

function buildEntityDeepLink(config, hostName, serviceName = null) {
  const path = serviceName
    ? `/includes/components/xicore/status.php?show=services&host=${encodeURIComponent(hostName)}&service=${encodeURIComponent(serviceName)}`
    : `/includes/components/xicore/status.php?show=hosts&host=${encodeURIComponent(hostName)}`;

  return buildNagiosUiUrl(config, path);
}

async function upsertNormalizedHosts(client, config, hosts) {
  for (const host of hosts) {
    await client.query(
      `
        INSERT INTO nagios_hosts (
          source_instance, entity_id, host_name, display_name, address, state,
          state_type, status, last_check, last_state_change, duration_seconds,
          attempt_count, output, acknowledged, acknowledgement_type, in_downtime,
          downtime_depth, unreachable_or_down, is_flapping, raw_payload,
          last_polled_at, updated_at
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20::jsonb,NOW(),NOW())
        ON CONFLICT (source_instance, host_name)
        DO UPDATE SET
          entity_id = EXCLUDED.entity_id,
          display_name = EXCLUDED.display_name,
          address = EXCLUDED.address,
          state = EXCLUDED.state,
          state_type = EXCLUDED.state_type,
          status = EXCLUDED.status,
          last_check = EXCLUDED.last_check,
          last_state_change = EXCLUDED.last_state_change,
          duration_seconds = EXCLUDED.duration_seconds,
          attempt_count = EXCLUDED.attempt_count,
          output = EXCLUDED.output,
          acknowledged = EXCLUDED.acknowledged,
          acknowledgement_type = EXCLUDED.acknowledgement_type,
          in_downtime = EXCLUDED.in_downtime,
          downtime_depth = EXCLUDED.downtime_depth,
          unreachable_or_down = EXCLUDED.unreachable_or_down,
          is_flapping = EXCLUDED.is_flapping,
          is_active = TRUE,
          raw_payload = EXCLUDED.raw_payload,
          last_polled_at = NOW(),
          updated_at = NOW()
      `,
      [
        config.key,
        host.entityId,
        host.hostName,
        host.displayName,
        host.address,
        host.currentState,
        host.stateType,
        host.status,
        host.lastCheck,
        host.lastStateChange,
        host.durationSeconds,
        host.attemptCount,
        host.pluginOutput,
        host.acknowledged,
        host.acknowledgementType,
        host.inDowntime,
        host.downtimeDepth,
        ['down', 'unreachable'].includes(host.status),
        host.isFlapping,
        JSON.stringify(host.rawPayload || {}),
      ],
    );
  }
}

async function upsertNormalizedServices(client, config, services) {
  for (const service of services) {
    await client.query(
      `
        INSERT INTO nagios_services (
          source_instance, entity_id, host_name, service_name, display_name,
          state, state_type, status, last_check, last_state_change,
          duration_seconds, attempt_count, output, acknowledged,
          acknowledgement_type, in_downtime, downtime_depth, is_flapping,
          performance_data, raw_payload, last_polled_at, updated_at
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20::jsonb,NOW(),NOW())
        ON CONFLICT (source_instance, host_name, service_name)
        DO UPDATE SET
          entity_id = EXCLUDED.entity_id,
          display_name = EXCLUDED.display_name,
          state = EXCLUDED.state,
          state_type = EXCLUDED.state_type,
          status = EXCLUDED.status,
          last_check = EXCLUDED.last_check,
          last_state_change = EXCLUDED.last_state_change,
          duration_seconds = EXCLUDED.duration_seconds,
          attempt_count = EXCLUDED.attempt_count,
          output = EXCLUDED.output,
          acknowledged = EXCLUDED.acknowledged,
          acknowledgement_type = EXCLUDED.acknowledgement_type,
          in_downtime = EXCLUDED.in_downtime,
          downtime_depth = EXCLUDED.downtime_depth,
          is_flapping = EXCLUDED.is_flapping,
          performance_data = EXCLUDED.performance_data,
          is_active = TRUE,
          raw_payload = EXCLUDED.raw_payload,
          last_polled_at = NOW(),
          updated_at = NOW()
      `,
      [
        config.key,
        service.entityId,
        service.hostName,
        service.serviceDescription,
        service.displayName,
        service.currentState,
        service.stateType,
        service.status,
        service.lastCheck,
        service.lastStateChange,
        service.durationSeconds,
        service.attemptCount,
        service.pluginOutput,
        service.acknowledged,
        service.acknowledgementType,
        service.inDowntime,
        service.downtimeDepth,
        service.isFlapping,
        service.performanceData,
        JSON.stringify(service.rawPayload || {}),
      ],
    );
  }
}

async function upsertNormalizedSummaries(client, instanceKey, serviceSummary, hostSummary, raw = {}) {
  for (const [summaryType, summary] of [['service', serviceSummary], ['host', hostSummary]]) {
    await client.query(
      `
        INSERT INTO nagios_summaries (
          source_instance, summary_type, total_count, status_counts, raw_payload,
          last_updated_at, updated_at
        )
        VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,NOW(),NOW())
        ON CONFLICT (source_instance, summary_type)
        DO UPDATE SET
          total_count = EXCLUDED.total_count,
          status_counts = EXCLUDED.status_counts,
          raw_payload = EXCLUDED.raw_payload,
          last_updated_at = NOW(),
          updated_at = NOW()
      `,
      [
        instanceKey,
        summaryType,
        Number(summary.total || 0),
        JSON.stringify(summary || {}),
        JSON.stringify(raw[summaryType] || {}),
      ],
    );
  }
}

async function replaceNormalizedProblems(client, config, problems) {
  await client.query('DELETE FROM nagios_problems WHERE source_instance = $1', [config.key]);

  for (const problem of problems) {
    await client.query(
      `
        INSERT INTO nagios_problems (
          source_instance, problem_key, problem_type, host_name, service_name,
          severity, current_state, status, first_detected_at, last_changed_at,
          duration_seconds, acknowledged, in_downtime, output, deep_link,
          raw_payload, last_polled_at, updated_at
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,NOW(),NOW())
        ON CONFLICT (source_instance, problem_key)
        DO UPDATE SET
          severity = EXCLUDED.severity,
          current_state = EXCLUDED.current_state,
          status = EXCLUDED.status,
          first_detected_at = EXCLUDED.first_detected_at,
          last_changed_at = EXCLUDED.last_changed_at,
          duration_seconds = EXCLUDED.duration_seconds,
          acknowledged = EXCLUDED.acknowledged,
          in_downtime = EXCLUDED.in_downtime,
          output = EXCLUDED.output,
          deep_link = EXCLUDED.deep_link,
          raw_payload = EXCLUDED.raw_payload,
          last_polled_at = NOW(),
          updated_at = NOW()
      `,
      [
        config.key,
        problem.problemKey,
        problem.problemType,
        problem.hostName,
        problem.serviceDescription,
        problem.severity,
        problem.currentState,
        problem.status,
        problem.firstDetectedAt || problem.lastStateChange || problem.lastCheck,
        problem.lastStateChange || problem.lastCheck,
        problem.durationSeconds,
        problem.acknowledged,
        problem.inDowntime,
        problem.pluginOutput,
        buildEntityDeepLink(config, problem.hostName, problem.serviceDescription),
        JSON.stringify(problem.rawPayload || {}),
      ],
    );
  }
}

async function upsertNormalizedEvents(client, events) {
  for (const event of events) {
    await client.query(
      `
        INSERT INTO nagios_events (
          source_instance, event_hash, event_id, event_type, host_name,
          service_name, old_state, new_state, event_timestamp, severity,
          acknowledged, in_downtime, output, raw_payload
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb)
        ON CONFLICT (source_instance, event_hash)
        DO NOTHING
      `,
      [
        event.instanceKey,
        event.eventHash,
        event.eventId,
        event.eventType,
        event.hostName,
        event.serviceDescription,
        event.oldState === null || event.oldState === undefined ? null : String(event.oldState),
        event.newState === null || event.newState === undefined ? null : String(event.newState),
        event.eventTime,
        event.severity,
        event.acknowledged,
        event.inDowntime,
        event.output,
        JSON.stringify(event.rawPayload || {}),
      ],
    );
  }
}

function normalizeDowntime(config, row = {}) {
  const hostName = row.host_name || row.host || null;
  const serviceName = row.service_description || row.service || null;
  const entityType = serviceName ? 'service' : 'host';
  const downtimeId = row.downtime_id || row.scheduleddowntime_id || row.id || `${entityType}:${hostName}:${serviceName || 'host'}`;

  return {
    sourceInstance: config.key,
    downtimeKey: String(downtimeId),
    entityType,
    hostName,
    serviceName,
    author: row.author || row.author_name || null,
    comment: row.comment || row.comment_data || row.output || null,
    startTime: unixOrIsoToDate(row.start_time ?? row.startTime),
    endTime: unixOrIsoToDate(row.end_time ?? row.endTime),
    durationSeconds: getDurationSeconds(row),
    fixed: row.fixed === undefined ? null : toBoolean(row.fixed),
    active: row.active === undefined ? true : toBoolean(row.active),
    rawPayload: row,
  };
}

function buildSyntheticDowntimeRows(config, hosts, services) {
  const rows = [];

  hosts.filter((host) => host.inDowntime).forEach((host) => {
    rows.push({
      sourceInstance: config.key,
      downtimeKey: `current-host:${host.hostName}`,
      entityType: 'host',
      hostName: host.hostName,
      serviceName: null,
      author: null,
      comment: 'Current host downtime state from hoststatus.',
      startTime: host.lastStateChange,
      endTime: null,
      durationSeconds: host.durationSeconds,
      fixed: null,
      active: true,
      rawPayload: host.rawPayload,
    });
  });

  services.filter((service) => service.inDowntime).forEach((service) => {
    rows.push({
      sourceInstance: config.key,
      downtimeKey: `current-service:${service.hostName}:${service.serviceDescription}`,
      entityType: 'service',
      hostName: service.hostName,
      serviceName: service.serviceDescription,
      author: null,
      comment: 'Current service downtime state from servicestatus.',
      startTime: service.lastStateChange,
      endTime: null,
      durationSeconds: service.durationSeconds,
      fixed: null,
      active: true,
      rawPayload: service.rawPayload,
    });
  });

  return rows;
}

async function replaceDowntimeRows(client, instanceKey, downtimeRows) {
  await client.query('UPDATE nagios_downtime SET active = FALSE, updated_at = NOW() WHERE source_instance = $1', [instanceKey]);

  for (const downtime of downtimeRows) {
    await client.query(
      `
        INSERT INTO nagios_downtime (
          source_instance, downtime_key, entity_type, host_name, service_name,
          author, comment, start_time, end_time, duration_seconds, fixed,
          active, raw_payload, last_polled_at, updated_at
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,NOW(),NOW())
        ON CONFLICT (source_instance, downtime_key)
        DO UPDATE SET
          entity_type = EXCLUDED.entity_type,
          host_name = EXCLUDED.host_name,
          service_name = EXCLUDED.service_name,
          author = EXCLUDED.author,
          comment = EXCLUDED.comment,
          start_time = EXCLUDED.start_time,
          end_time = EXCLUDED.end_time,
          duration_seconds = EXCLUDED.duration_seconds,
          fixed = EXCLUDED.fixed,
          active = EXCLUDED.active,
          raw_payload = EXCLUDED.raw_payload,
          last_polled_at = NOW(),
          updated_at = NOW()
      `,
      [
        downtime.sourceInstance,
        downtime.downtimeKey,
        downtime.entityType,
        downtime.hostName,
        downtime.serviceName,
        downtime.author,
        downtime.comment,
        downtime.startTime,
        downtime.endTime,
        downtime.durationSeconds,
        downtime.fixed,
        downtime.active,
        JSON.stringify(downtime.rawPayload || {}),
      ],
    );
  }
}

function clamp01(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

function secondsSince(timestamp, nowMs = Date.now()) {
  if (!timestamp) {
    return null;
  }

  const time = new Date(timestamp).getTime();

  return Number.isFinite(time) ? Math.max(0, Math.round((nowMs - time) / 1000)) : null;
}

function severityScore(status) {
  if (['critical', 'down', 'unreachable'].includes(status)) return 1;
  if (status === 'warning') return 0.65;
  if (status === 'unknown') return 0.45;
  if (status === 'pending') return 0.2;
  return 0;
}

function eventEntityIds(event) {
  const ids = [];

  if (event.hostName) {
    ids.push(`host:${event.hostName}`);
  }

  if (event.hostName && event.serviceDescription) {
    ids.push(`service:${event.hostName}:${event.serviceDescription}`);
  }

  return ids;
}

function groupEventsByEntity(events = []) {
  const grouped = new Map();

  events.forEach((event) => {
    eventEntityIds(event).forEach((entityId) => {
      grouped.set(entityId, [...(grouped.get(entityId) || []), event]);
    });
  });

  grouped.forEach((items, key) => {
    grouped.set(key, items.sort((left, right) => new Date(right.eventTime) - new Date(left.eventTime)));
  });

  return grouped;
}

function buildFeatureInputFromProblem(problem) {
  return {
    entityType: 'problem',
    entityId: `problem:${problem.problemKey}`,
    entityName: problem.serviceDescription ? `${problem.hostName} / ${problem.serviceDescription}` : problem.hostName,
    status: problem.status,
    currentState: problem.currentState,
    lastStateChange: problem.lastStateChange,
    durationSeconds: problem.durationSeconds,
    acknowledged: problem.acknowledged,
    inDowntime: problem.inDowntime,
    isFlapping: false,
    rawPayload: problem.rawPayload,
    relatedEntityId: problem.serviceDescription
      ? `service:${problem.hostName}:${problem.serviceDescription}`
      : `host:${problem.hostName}`,
  };
}

function buildFeatureRecord(config, item, eventsByEntity, currentProblems, downtimeRows, nowMs = Date.now()) {
  const events = eventsByEntity.get(item.entityId) || eventsByEntity.get(item.relatedEntityId) || [];
  const currentProblem = currentProblems.find((problem) => {
    if (item.entityType === 'problem') return problem.problemKey === item.entityId.replace(/^problem:/, '');
    if (item.entityType === 'host') return problem.problemType === 'host' && problem.hostName === item.hostName;
    return problem.problemType === 'service' && problem.hostName === item.hostName && problem.serviceDescription === item.serviceDescription;
  });
  const relatedDowntime = downtimeRows.filter((downtime) => {
    if (item.entityType === 'host') return downtime.hostName === item.hostName && !downtime.serviceName && downtime.active;
    if (item.entityType === 'service') return downtime.hostName === item.hostName && downtime.serviceName === item.serviceDescription && downtime.active;
    return item.relatedEntityId?.includes(downtime.hostName || '__none__');
  });
  const stateChangeCount = events.length;
  const alertEvents = events.filter((event) => !['ok', 'up', 'pending'].includes(event.status));
  const recoveryEvents = events.filter((event) => ['ok', 'up'].includes(event.status));
  const currentSeverityScore = severityScore(item.status);
  const volatilityScore = clamp01((stateChangeCount / 20) + (currentSeverityScore * 0.35));
  const flappingScore = item.isFlapping ? 0.95 : clamp01(stateChangeCount / 12);
  const recurrenceCount = alertEvents.length + (currentProblem ? 1 : 0);
  const problemDurations = [currentProblem?.durationSeconds, item.durationSeconds].filter((value) => Number.isFinite(Number(value))).map(Number);
  const averageProblemDuration = problemDurations.length
    ? problemDurations.reduce((sum, value) => sum + value, 0) / problemDurations.length
    : null;
  const previousState = events[0]?.oldState || events[1]?.newState || null;
  const trendDirection = previousState && String(previousState) !== String(item.currentState ?? item.status)
    ? currentSeverityScore > severityScore(events[0]?.status) ? 'worsening' : 'changed'
    : currentProblem ? 'active_problem' : 'stable';
  const noiseLikelihood = clamp01((item.acknowledged ? 0.2 : 0) + (item.inDowntime ? 0.25 : 0) + (flappingScore * 0.35) + (currentSeverityScore < 0.5 ? 0.15 : 0));
  const incidentLikelihood = clamp01((currentSeverityScore * 0.7) + (currentProblem && !item.acknowledged && !item.inDowntime ? 0.25 : 0));

  return {
    sourceInstance: config.key,
    entityType: item.entityType,
    entityId: item.entityId,
    entityName: item.entityName || item.displayName || item.hostName || item.serviceDescription || item.entityId,
    currentState: item.status,
    previousState,
    stateChangeCount,
    recurrenceCount,
    alertFrequency: events.length ? Number((alertEvents.length / Math.max(1, events.length)).toFixed(4)) : 0,
    alertDensity: events.length ? Number((alertEvents.length / Math.max(1, stateChangeCount || 1)).toFixed(4)) : 0,
    timeSinceLastChangeSeconds: secondsSince(item.lastStateChange, nowMs),
    timeSinceLastAlertSeconds: secondsSince(alertEvents[0]?.eventTime || currentProblem?.lastStateChange, nowMs),
    timeSinceLastRecoverySeconds: secondsSince(recoveryEvents[0]?.eventTime, nowMs),
    averageProblemDurationSeconds: averageProblemDuration,
    maximumProblemDurationSeconds: problemDurations.length ? Math.max(...problemDurations) : null,
    minimumProblemDurationSeconds: problemDurations.length ? Math.min(...problemDurations) : null,
    recoveryTimeSeconds: recoveryEvents[0] && alertEvents[0]
      ? Math.abs(Math.round((new Date(recoveryEvents[0].eventTime) - new Date(alertEvents[0].eventTime)) / 1000))
      : null,
    flappingScore,
    stabilityScore: clamp01(1 - volatilityScore),
    downtimeCount: relatedDowntime.length + (item.inDowntime ? 1 : 0),
    acknowledgementCount: item.acknowledged || currentProblem?.acknowledged ? 1 : 0,
    severityScore: currentSeverityScore,
    volatilityScore,
    trendDirection,
    noiseLikelihood,
    incidentLikelihood,
    flappingLikelihood: flappingScore,
    recurrenceLikelihood: clamp01(recurrenceCount / 10),
    correlationLikelihood: clamp01((currentProblems.filter((problem) => problem.hostName === item.hostName).length - 1) / 10),
    correlationPlaceholder: {
      source: 'nagios',
      hostName: item.hostName,
      serviceName: item.serviceDescription || null,
      relatedActiveProblems: currentProblems.filter((problem) => problem.hostName === item.hostName).length,
    },
    aiLabel: 'unknown',
    aiConfidence: null,
    aiReason: 'AI model is not enabled yet. Nagios features are prepared for later noise vs incident classification.',
    rawPayloadReference: `${config.key}:${item.entityType}:${item.entityId}`,
    rawPayload: item.rawPayload || {},
  };
}

async function upsertNagiosAiFeatures(client, config, hosts, services, problems, downtimeRows) {
  const eventResult = await client.query(
    `
      SELECT
        event_hash,
        event_id,
        event_type,
        host_name,
        service_name AS service_description,
        old_state,
        new_state,
        event_timestamp AS event_time,
        severity,
        acknowledged,
        in_downtime,
        output,
        raw_payload
      FROM nagios_events
      WHERE source_instance = $1
      ORDER BY event_timestamp DESC
      LIMIT 10000
    `,
    [config.key],
  );
  const events = eventResult.rows.map((row) => ({
    ...row,
    eventTime: row.event_time,
    hostName: row.host_name,
    serviceDescription: row.service_description,
    status: getStateLabel({ current_state: row.new_state }, row.service_description ? 'service' : 'host'),
  }));
  const eventsByEntity = groupEventsByEntity(events);
  const featureInputs = [
    ...hosts.map((host) => ({ ...host, entityType: 'host', entityName: host.displayName || host.hostName })),
    ...services.map((service) => ({ ...service, entityType: 'service', entityName: service.displayName || service.serviceDescription })),
    ...problems.map(buildFeatureInputFromProblem),
  ];
  const nowMs = Date.now();

  for (const item of featureInputs) {
    const feature = buildFeatureRecord(config, item, eventsByEntity, problems, downtimeRows, nowMs);

    await client.query(
      `
        INSERT INTO nagios_ai_features (
          source_instance,
          entity_type,
          entity_id,
          entity_name,
          feature_timestamp,
          current_state,
          previous_state,
          state_change_count,
          recurrence_count,
          alert_frequency,
          alert_density,
          time_since_last_change_seconds,
          time_since_last_alert_seconds,
          time_since_last_recovery_seconds,
          average_problem_duration_seconds,
          maximum_problem_duration_seconds,
          minimum_problem_duration_seconds,
          recovery_time_seconds,
          flapping_score,
          stability_score,
          downtime_count,
          acknowledgement_count,
          severity_score,
          volatility_score,
          trend_direction,
          noise_likelihood,
          incident_likelihood,
          flapping_likelihood,
          recurrence_likelihood,
          correlation_likelihood,
          correlation_placeholder,
          ai_label,
          ai_confidence,
          ai_reason,
          raw_payload_reference,
          raw_payload,
          updated_at
        )
        VALUES ($1,$2,$3,$4,NOW(),$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30::jsonb,$31,$32,$33,$34,$35::jsonb,NOW())
        ON CONFLICT (source_instance, entity_type, entity_id)
        DO UPDATE SET
          entity_name = EXCLUDED.entity_name,
          feature_timestamp = NOW(),
          current_state = EXCLUDED.current_state,
          previous_state = EXCLUDED.previous_state,
          state_change_count = EXCLUDED.state_change_count,
          recurrence_count = EXCLUDED.recurrence_count,
          alert_frequency = EXCLUDED.alert_frequency,
          alert_density = EXCLUDED.alert_density,
          time_since_last_change_seconds = EXCLUDED.time_since_last_change_seconds,
          time_since_last_alert_seconds = EXCLUDED.time_since_last_alert_seconds,
          time_since_last_recovery_seconds = EXCLUDED.time_since_last_recovery_seconds,
          average_problem_duration_seconds = EXCLUDED.average_problem_duration_seconds,
          maximum_problem_duration_seconds = EXCLUDED.maximum_problem_duration_seconds,
          minimum_problem_duration_seconds = EXCLUDED.minimum_problem_duration_seconds,
          recovery_time_seconds = EXCLUDED.recovery_time_seconds,
          flapping_score = EXCLUDED.flapping_score,
          stability_score = EXCLUDED.stability_score,
          downtime_count = EXCLUDED.downtime_count,
          acknowledgement_count = EXCLUDED.acknowledgement_count,
          severity_score = EXCLUDED.severity_score,
          volatility_score = EXCLUDED.volatility_score,
          trend_direction = EXCLUDED.trend_direction,
          noise_likelihood = EXCLUDED.noise_likelihood,
          incident_likelihood = EXCLUDED.incident_likelihood,
          flapping_likelihood = EXCLUDED.flapping_likelihood,
          recurrence_likelihood = EXCLUDED.recurrence_likelihood,
          correlation_likelihood = EXCLUDED.correlation_likelihood,
          correlation_placeholder = EXCLUDED.correlation_placeholder,
          ai_label = EXCLUDED.ai_label,
          ai_confidence = EXCLUDED.ai_confidence,
          ai_reason = EXCLUDED.ai_reason,
          raw_payload_reference = EXCLUDED.raw_payload_reference,
          raw_payload = EXCLUDED.raw_payload,
          updated_at = NOW()
      `,
      [
        feature.sourceInstance,
        feature.entityType,
        feature.entityId,
        feature.entityName,
        feature.currentState,
        feature.previousState,
        feature.stateChangeCount,
        feature.recurrenceCount,
        feature.alertFrequency,
        feature.alertDensity,
        feature.timeSinceLastChangeSeconds,
        feature.timeSinceLastAlertSeconds,
        feature.timeSinceLastRecoverySeconds,
        feature.averageProblemDurationSeconds,
        feature.maximumProblemDurationSeconds,
        feature.minimumProblemDurationSeconds,
        feature.recoveryTimeSeconds,
        feature.flappingScore,
        feature.stabilityScore,
        feature.downtimeCount,
        feature.acknowledgementCount,
        feature.severityScore,
        feature.volatilityScore,
        feature.trendDirection,
        feature.noiseLikelihood,
        feature.incidentLikelihood,
        feature.flappingLikelihood,
        feature.recurrenceLikelihood,
        feature.correlationLikelihood,
        JSON.stringify(feature.correlationPlaceholder),
        feature.aiLabel,
        feature.aiConfidence,
        feature.aiReason,
        feature.rawPayloadReference,
        JSON.stringify(feature.rawPayload || {}),
      ],
    );
  }

  return featureInputs.length;
}

async function upsertAlertForProblem(client, config, problem) {
  const isHost = problem.problemType === 'host';
  const alertId = `NAGIOS-${config.key.toUpperCase()}-${hashId(problem.problemKey)}`;
  const title = isHost
    ? `${problem.hostName} is ${problem.status.toUpperCase()}`
    : `${problem.hostName} / ${problem.serviceDescription} is ${problem.status.toUpperCase()}`;
  const sourceUrl = buildNagiosUiUrl(config, isHost ? '/includes/components/xicore/status.php' : '/includes/components/xicore/status.php');
  const duplicateSignature = crypto
    .createHash('sha1')
    .update([config.sourceKey, problem.hostName, problem.serviceDescription || 'host', problem.status].join('|').toLowerCase())
    .digest('hex');

  await client.query(
    `
      INSERT INTO alerts (
        id, title, service, environment, severity, status, classification,
        noise_type, source, source_type, source_alert_id, source_url,
        raw_payload, extracted_details, noise_reason, classification_reason,
        duplicate_signature, correlation_id, received_at, last_seen_at,
        occurrences, owner, signal, description, recurring_incident, related_alerts
      )
      VALUES (
        $1,$2,$3,'production',$4,$5,'needs_review','none',$6,'monitoring',$7,$8,
        $9::jsonb,$10::jsonb,NULL,'Stored from Nagios and awaiting classification.',
        $11,$7,COALESCE($12,NOW()),COALESCE($13,NOW()),1,'Command Center',$14,$15,false,'[]'::jsonb
      )
      ON CONFLICT (id)
      DO UPDATE SET
        title = EXCLUDED.title,
        service = EXCLUDED.service,
        severity = EXCLUDED.severity,
        status = EXCLUDED.status,
        source = EXCLUDED.source,
        source_type = EXCLUDED.source_type,
        source_alert_id = EXCLUDED.source_alert_id,
        source_url = EXCLUDED.source_url,
        raw_payload = EXCLUDED.raw_payload,
        extracted_details = EXCLUDED.extracted_details,
        duplicate_signature = EXCLUDED.duplicate_signature,
        last_seen_at = EXCLUDED.last_seen_at,
        occurrences = alerts.occurrences + 1,
        signal = EXCLUDED.signal,
        description = EXCLUDED.description,
        updated_at = NOW()
    `,
    [
      alertId,
      title,
      isHost ? problem.hostName : problem.serviceDescription,
      problem.severity,
      mapAlertStatusFromNagios(problem.status),
      config.sourceKey,
      problem.problemKey,
      sourceUrl,
      JSON.stringify(problem.rawPayload || {}),
      JSON.stringify({
        normalized_alert: {
          alert_id: problem.problemKey,
          source_tool: config.sourceKey,
          source_name: config.label,
          source_instance: config.key,
          service: isHost ? problem.hostName : problem.serviceDescription,
          entity: problem.hostName,
          summary: title,
          description: problem.pluginOutput,
          severity: problem.severity,
          status: problem.status,
          acknowledged: problem.acknowledged,
          downtime_state: problem.inDowntime,
          event_link: sourceUrl,
          deep_event_link: sourceUrl,
        },
        custom_properties: {
          nagios_instance: config.key,
          problem_type: problem.problemType,
          host_name: problem.hostName,
          service_description: problem.serviceDescription,
          acknowledged: problem.acknowledged,
          in_downtime: problem.inDowntime,
        },
      }),
      duplicateSignature,
      problem.lastStateChange || problem.lastCheck,
      problem.lastCheck || problem.lastStateChange,
      title,
      problem.pluginOutput || title,
    ],
  );
}

function buildProblemFromHost(host) {
  return {
    instanceKey: host.instanceKey,
    problemKey: `host:${host.hostName}`,
    problemType: 'host',
    hostName: host.hostName,
    serviceDescription: null,
    status: host.status,
    currentState: host.currentState,
    severity: mapSeverityFromStatus(host.status, 'host'),
    acknowledged: host.acknowledged,
    inDowntime: host.inDowntime,
    pluginOutput: host.pluginOutput,
    lastCheck: host.lastCheck,
    lastStateChange: host.lastStateChange,
    firstDetectedAt: host.lastStateChange || host.lastCheck,
    durationSeconds: host.durationSeconds,
    rawPayload: host.rawPayload,
  };
}

function buildProblemFromService(service) {
  return {
    instanceKey: service.instanceKey,
    problemKey: `service:${service.hostName}:${service.serviceDescription}`,
    problemType: 'service',
    hostName: service.hostName,
    serviceDescription: service.serviceDescription,
    status: service.status,
    currentState: service.currentState,
    severity: mapSeverityFromStatus(service.status, 'service'),
    acknowledged: service.acknowledged,
    inDowntime: service.inDowntime,
    pluginOutput: service.pluginOutput,
    lastCheck: service.lastCheck,
    lastStateChange: service.lastStateChange,
    firstDetectedAt: service.lastStateChange || service.lastCheck,
    durationSeconds: service.durationSeconds,
    rawPayload: service.rawPayload,
  };
}

async function fetchInstanceSnapshot(instanceKey) {
  const config = await getInstanceRuntimeConfig(instanceKey);

  if (!config.configured) {
    await updateSourceStatus(config, {
      connectionStatus: 'not_configured',
      apiHealth: 'not_configured',
      syncStatus: 'idle',
      lastError: `Configure ${config.baseUrlEnv}/${config.apiKeyEnv} or save ${config.label} credentials in Settings.`,
    });

    return {
      config,
      hosts: [],
      services: [],
      events: [],
      serviceSummary: buildSummary([], 'service'),
      hostSummary: buildSummary([], 'host'),
      problems: [],
      responseTimeMs: null,
      durationMs: 0,
      configured: false,
    };
  }

  const startedAt = Date.now();
  await updateSourceStatus(config, {
    connectionStatus: 'checking',
    apiHealth: 'checking',
    syncStatus: 'syncing',
  });
  await updateConnectorHealth(config, {
    status: 'polling',
    connectionHealth: 'polling',
    lastPollStartedAt: new Date(startedAt).toISOString(),
    existingLastSuccessfulPoll: null,
    metadata: {
      stage: 'start_poll',
    },
  });

  try {
    const [servicesResponse, hostsResponse, eventsResponse, notificationsResponse, logEntriesResponse, downtimeResponse] = await Promise.all([
      fetchJson(buildNagiosUrl(config, 'objects/servicestatus'), 'send_http_request'),
      fetchJson(buildNagiosUrl(config, 'objects/hoststatus'), 'send_http_request'),
      fetchJson(buildNagiosUrl(config, 'objects/statehistory', { limitrecords: 100 }), 'send_http_request'),
      fetchOptionalRows(config, 'objects/notifications', ['notifications', 'notification'], { limitrecords: 100 }),
      fetchOptionalRows(config, 'objects/logentries', ['logentry', 'logentries', 'events'], { limitrecords: 100 }),
      fetchOptionalRows(config, 'objects/scheduleddowntime', ['scheduleddowntime', 'downtime', 'scheduled_downtime'], { limitrecords: 500 }),
    ]);
    const serviceRows = validateExpectedRows(servicesResponse.payload, ['servicestatus', 'services'], 'service status');
    const hostRows = validateExpectedRows(hostsResponse.payload, ['hoststatus', 'hosts'], 'host status');
    const services = serviceRows.map((row) => normalizeService(config.key, row));
    const hosts = hostRows.map((row) => normalizeHost(config.key, row));
    const stateEvents = extractRows(eventsResponse.payload, ['stateentry', 'statehistory', 'events', 'logentries']).map((row) => normalizeEvent(config.key, row));
    const notificationEvents = notificationsResponse.rows.map((row) => normalizeEvent(config.key, { ...row, event_type: 'notification' }));
    const logEvents = logEntriesResponse.rows.map((row) => normalizeEvent(config.key, { ...row, event_type: row.event_type || 'logentry' }));
    const events = [...stateEvents, ...notificationEvents, ...logEvents];
    const downtimeRows = downtimeResponse.rows.map((row) => normalizeDowntime(config, row));
    const warnings = [notificationsResponse.warning, logEntriesResponse.warning, downtimeResponse.warning].filter(Boolean);
    const serviceSummary = buildSummary(services, 'service');
    const hostSummary = buildSummary(hosts, 'host');
    const problems = [
      ...hosts.filter(isProblem).map(buildProblemFromHost),
      ...services.filter(isProblem).map(buildProblemFromService),
    ];
    const responseTimeMs = Math.max(
      servicesResponse.responseTimeMs || 0,
      hostsResponse.responseTimeMs || 0,
      eventsResponse.responseTimeMs || 0,
      notificationsResponse.responseTimeMs || 0,
      logEntriesResponse.responseTimeMs || 0,
      downtimeResponse.responseTimeMs || 0,
    );

    return {
      config,
      hosts,
      services,
      events,
      downtimeRows,
      serviceSummary,
      hostSummary,
      problems,
      warnings,
      responseTimeMs,
      httpStatus: Math.max(
        servicesResponse.httpStatus || 0,
        hostsResponse.httpStatus || 0,
        eventsResponse.httpStatus || 0,
      ) || 200,
      durationMs: Date.now() - startedAt,
      configured: true,
      raw: {
        service: servicesResponse.payload,
        host: hostsResponse.payload,
        events: eventsResponse.payload,
        notifications: notificationsResponse.payload,
        logEntries: logEntriesResponse.payload,
        downtime: downtimeResponse.payload,
      },
    };
  } catch (error) {
    const pollError = describePollError(error);
    await updateSourceStatus(config, {
      connectionStatus: 'disconnected',
      apiHealth: 'disconnected',
      syncStatus: 'failed',
      lastFailedSync: new Date().toISOString(),
      lastSyncDurationMs: Date.now() - startedAt,
      lastError: error.message,
      responseTimeMs: pollError.responseTimeMs,
      metadata: {
        failureStage: pollError.failureStage,
        failureType: pollError.failureType,
        httpStatus: pollError.httpStatus,
      },
    });
    await updateConnectorHealth(config, {
      status: 'failed',
      connectionHealth: 'failed',
      failureStage: pollError.failureStage,
      failureType: pollError.failureType,
      failureReason: pollError.failureReason,
      httpStatus: pollError.httpStatus,
      responseTimeMs: pollError.responseTimeMs,
      lastFailedPoll: new Date().toISOString(),
      lastPollEndedAt: new Date().toISOString(),
      metadata: {
        stage: pollError.failureStage,
      },
    });
    throw error;
  }
}

async function pollInstance(instanceKey) {
  await ensureNagiosStorage();
  const configForLog = await getInstanceRuntimeConfig(instanceKey);
  const pollStartedAt = new Date();
  const syncLogId = await startSyncLog(configForLog.key, 'nagios_poll', {
    sourceKey: configForLog.sourceKey,
    configured: configForLog.configured,
  });
  let snapshot;
  let lastPollError = null;
  const attempts = [];

  for (let attemptIndex = 0; attemptIndex < 3; attemptIndex += 1) {
    try {
      snapshot = await fetchInstanceSnapshot(instanceKey);
      break;
    } catch (error) {
      lastPollError = error;
      const detail = describePollError(error);
      attempts.push({
        attempt: attemptIndex + 1,
        ...detail,
      });

      if (!detail.retryable || attemptIndex === 2) {
        break;
      }

      await sleep(POLL_RETRY_DELAYS_MS[attemptIndex] || 0);
    }
  }

  if (!snapshot && lastPollError) {
    const detail = describePollError(lastPollError);
    const endedAt = new Date();
    const durationMs = endedAt.getTime() - pollStartedAt.getTime();
    const pollSummary = {
      result: 'failed',
      startedAt: pollStartedAt.toISOString(),
      endedAt: endedAt.toISOString(),
      durationMs,
      failureStage: detail.failureStage,
      failureType: detail.failureType,
      failureReason: detail.failureReason,
      httpStatus: detail.httpStatus,
      responseTimeMs: detail.responseTimeMs,
      retryCount: Math.max(0, attempts.length - 1),
      recordsRetrieved: 0,
      recordsInserted: 0,
      recordsUpdated: 0,
      recordsSkipped: 0,
      recordsFailed: 0,
      rawPayload: {
        attempts,
      },
    };

    await finishSyncLog(syncLogId, 'failed', {
      counts: { fetched: 0, stored: 0, retryCount: pollSummary.retryCount },
      warnings: [],
      errorMessage: detail.failureReason,
      rawPayload: { attempts },
    });
    await recordPollHistory(configForLog, pollSummary);
    await updateSyncStatistics(configForLog, pollSummary);
    await updateConnectorHealth(configForLog, {
      status: 'failed',
      connectionHealth: 'failed',
      failureStage: detail.failureStage,
      failureType: detail.failureType,
      failureReason: detail.failureReason,
      httpStatus: detail.httpStatus,
      responseTimeMs: detail.responseTimeMs,
      lastFailedPoll: endedAt.toISOString(),
      lastPollStartedAt: pollStartedAt.toISOString(),
      lastPollEndedAt: endedAt.toISOString(),
      retryCount: pollSummary.retryCount,
      metadata: {
        attempts,
      },
    });

    throw lastPollError;
  }

  if (!snapshot.configured) {
    const endedAt = new Date();
    const durationMs = endedAt.getTime() - pollStartedAt.getTime();
    const pollSummary = {
      result: 'skipped',
      startedAt: pollStartedAt.toISOString(),
      endedAt: endedAt.toISOString(),
      durationMs,
      failureStage: 'load_configuration',
      failureType: 'not_configured',
      failureReason: `${snapshot.config.label} is not configured.`,
      recordsRetrieved: 0,
      recordsInserted: 0,
      recordsUpdated: 0,
      recordsSkipped: 0,
      recordsFailed: 0,
    };

    await finishSyncLog(syncLogId, 'skipped', {
      counts: { fetched: 0, stored: 0 },
      warnings: [snapshot.status?.lastError || `${snapshot.config.label} is not configured.`],
    });
    await recordPollHistory(snapshot.config, pollSummary);
    await updateConnectorHealth(snapshot.config, {
      status: 'disconnected',
      connectionHealth: 'not_configured',
      failureStage: 'load_configuration',
      failureType: 'not_configured',
      failureReason: `${snapshot.config.label} is missing a Nagios XI Base URL or API key.`,
      lastPollStartedAt: pollStartedAt.toISOString(),
      lastPollEndedAt: endedAt.toISOString(),
    });

    return {
      instance: mapInstanceConfig(snapshot.config),
      fetched: 0,
      stored: 0,
      problems: 0,
      message: `${snapshot.config.label} is not configured.`,
    };
  }

  const client = await db.pool.connect();
  let aiFeatureCount = 0;
  let hostWriteStats = { inserted: 0, updated: 0, skipped: 0, failed: 0 };
  let serviceWriteStats = { inserted: 0, updated: 0, skipped: 0, failed: 0 };
  const downtimeRows = [
    ...(snapshot.downtimeRows || []),
    ...buildSyntheticDowntimeRows(snapshot.config, snapshot.hosts, snapshot.services),
  ];

  try {
    await client.query('BEGIN');
    await markCurrentRowsInactive(client, snapshot.config.key);
    hostWriteStats = await upsertHosts(client, snapshot.hosts);
    serviceWriteStats = await upsertServices(client, snapshot.services);
    await replaceActiveProblems(client, snapshot.config.key, snapshot.problems);
    await upsertEvents(client, snapshot.events);
    await upsertSummaries(client, snapshot.config.key, snapshot.serviceSummary, snapshot.hostSummary, snapshot.raw);
    await upsertNormalizedHosts(client, snapshot.config, snapshot.hosts);
    await upsertNormalizedServices(client, snapshot.config, snapshot.services);
    await replaceNormalizedProblems(client, snapshot.config, snapshot.problems);
    await upsertNormalizedEvents(client, snapshot.events);
    await upsertNormalizedSummaries(client, snapshot.config.key, snapshot.serviceSummary, snapshot.hostSummary, snapshot.raw);
    await replaceDowntimeRows(client, snapshot.config.key, downtimeRows);
    aiFeatureCount = await upsertNagiosAiFeatures(client, snapshot.config, snapshot.hosts, snapshot.services, snapshot.problems, downtimeRows);

    for (const problem of snapshot.problems) {
      await upsertAlertForProblem(client, snapshot.config, problem);
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    const dbError = createPollError('database_insert_failure', 'update_database', `Nagios database update failed: ${error.message}`, {
      retryable: false,
    });
    const detail = describePollError(dbError);
    const endedAt = new Date();
    const durationMs = endedAt.getTime() - pollStartedAt.getTime();
    const pollSummary = {
      result: 'failed',
      startedAt: pollStartedAt.toISOString(),
      endedAt: endedAt.toISOString(),
      durationMs,
      failureStage: detail.failureStage,
      failureType: detail.failureType,
      failureReason: detail.failureReason,
      retryCount: attempts.length,
      recordsRetrieved: snapshot.hosts.length + snapshot.services.length + snapshot.events.length + snapshot.problems.length,
      recordsInserted: hostWriteStats.inserted + serviceWriteStats.inserted,
      recordsUpdated: hostWriteStats.updated + serviceWriteStats.updated,
      recordsSkipped: hostWriteStats.skipped + serviceWriteStats.skipped,
      recordsFailed: snapshot.hosts.length + snapshot.services.length,
      rawPayload: {
        originalError: error.message,
      },
    };

    await finishSyncLog(syncLogId, 'failed', {
      counts: {
        hosts: snapshot.hosts.length,
        services: snapshot.services.length,
        problems: snapshot.problems.length,
        events: snapshot.events.length,
      },
      warnings: snapshot.warnings || [],
      errorMessage: detail.failureReason,
    });
    await recordPollHistory(snapshot.config, pollSummary);
    await updateSyncStatistics(snapshot.config, pollSummary);
    await updateConnectorHealth(snapshot.config, {
      status: 'failed',
      connectionHealth: 'failed',
      failureStage: detail.failureStage,
      failureType: detail.failureType,
      failureReason: detail.failureReason,
      lastFailedPoll: endedAt.toISOString(),
      lastPollStartedAt: pollStartedAt.toISOString(),
      lastPollEndedAt: endedAt.toISOString(),
      recordsRetrieved: pollSummary.recordsRetrieved,
      recordsInserted: pollSummary.recordsInserted,
      recordsUpdated: pollSummary.recordsUpdated,
      recordsSkipped: pollSummary.recordsSkipped,
      retryCount: pollSummary.retryCount,
    });
    throw dbError;
  } finally {
    client.release();
  }

  const endedAt = new Date();
  const now = endedAt.toISOString();
  const pollDurationMs = endedAt.getTime() - pollStartedAt.getTime();
  const recordsRetrieved = snapshot.services.length + snapshot.hosts.length + snapshot.events.length + snapshot.problems.length + downtimeRows.length;
  const recordsInserted = hostWriteStats.inserted + serviceWriteStats.inserted;
  const recordsUpdated = hostWriteStats.updated + serviceWriteStats.updated;
  const recordsSkipped = hostWriteStats.skipped + serviceWriteStats.skipped;
  const retryCount = attempts.length;

  await updateSourceStatus(snapshot.config, {
    connectionStatus: 'connected',
    apiHealth: 'connected',
    syncStatus: 'idle',
    lastSuccessfulSync: now,
    lastAlertReceivedAt: snapshot.problems.length ? now : null,
    totalAlertsImported: snapshot.problems.length,
    lastSyncDurationMs: pollDurationMs,
    responseTimeMs: snapshot.responseTimeMs,
    lastError: null,
    metadata: {
      services: snapshot.services.length,
      hosts: snapshot.hosts.length,
      problems: snapshot.problems.length,
      events: snapshot.events.length,
      downtime: downtimeRows.length,
      aiFeatures: aiFeatureCount,
      recordsRetrieved,
      recordsInserted,
      recordsUpdated,
      recordsSkipped,
      retryCount,
      warnings: snapshot.warnings || [],
    },
  });

  await finishSyncLog(syncLogId, 'success', {
    counts: {
      hosts: snapshot.hosts.length,
      services: snapshot.services.length,
      problems: snapshot.problems.length,
      events: snapshot.events.length,
      downtime: downtimeRows.length,
      aiFeatures: aiFeatureCount,
      inserted: recordsInserted,
      updated: recordsUpdated,
      skipped: recordsSkipped,
      retryCount,
      stored: snapshot.services.length + snapshot.hosts.length + snapshot.events.length + snapshot.problems.length + downtimeRows.length + aiFeatureCount,
    },
    warnings: snapshot.warnings || [],
  });

  const pollSummary = {
    result: 'success',
    startedAt: pollStartedAt.toISOString(),
    endedAt: now,
    durationMs: pollDurationMs,
    httpStatus: snapshot.httpStatus || 200,
    responseTimeMs: snapshot.responseTimeMs,
    retryCount,
    recordsRetrieved,
    recordsInserted,
    recordsUpdated,
    recordsSkipped,
    recordsFailed: 0,
    rawPayload: {
      warnings: snapshot.warnings || [],
      attempts,
    },
  };

  await recordPollHistory(snapshot.config, pollSummary);
  await updateSyncStatistics(snapshot.config, pollSummary);
  await updateConnectorHealth(snapshot.config, {
    status: 'healthy',
    connectionHealth: 'healthy',
    failureStage: null,
    failureType: null,
    failureReason: null,
    httpStatus: snapshot.httpStatus || 200,
    responseTimeMs: snapshot.responseTimeMs,
    lastSuccessfulPoll: now,
    lastPollStartedAt: pollStartedAt.toISOString(),
    lastPollEndedAt: now,
    recordsRetrieved,
    recordsInserted,
    recordsUpdated,
    recordsSkipped,
    retryCount,
    nextScheduledPoll: getNextScheduledPoll(now),
    metadata: {
      services: snapshot.services.length,
      hosts: snapshot.hosts.length,
      problems: snapshot.problems.length,
      events: snapshot.events.length,
      downtime: downtimeRows.length,
      aiFeatures: aiFeatureCount,
      warnings: snapshot.warnings || [],
    },
  });

  return {
    instance: mapInstanceConfig(snapshot.config),
    fetched: recordsRetrieved,
    stored: snapshot.services.length + snapshot.hosts.length + snapshot.events.length + snapshot.problems.length + downtimeRows.length + aiFeatureCount,
    inserted: recordsInserted,
    updated: recordsUpdated,
    skipped: recordsSkipped,
    problems: snapshot.problems.length,
    downtime: downtimeRows.length,
    aiFeatures: aiFeatureCount,
    warnings: snapshot.warnings || [],
    retryCount,
    durationMs: pollDurationMs,
    responseTimeMs: snapshot.responseTimeMs,
    message: `${snapshot.config.label} poll complete: ${snapshot.hosts.length} hosts, ${snapshot.services.length} services, ${snapshot.problems.length} active problems, ${aiFeatureCount} AI feature rows. ${recordsInserted} inserted, ${recordsUpdated} updated, ${recordsSkipped} unchanged.`,
  };
}

async function testInstanceConnection(instanceKey) {
  try {
    await ensureNagiosStorage();
    const snapshot = await fetchInstanceSnapshot(instanceKey);

    if (!snapshot.configured) {
      return {
        ok: false,
        status: 'authentication_required',
        mode: 'blocked_by_auth',
        instance: mapInstanceConfig(snapshot.config),
        message: `${snapshot.config.label} is missing a Nagios XI Base URL or API key.`,
      };
    }

    await updateSourceStatus(snapshot.config, {
      connectionStatus: 'connected',
      apiHealth: 'connected',
      syncStatus: 'idle',
      lastSuccessfulSync: new Date().toISOString(),
      lastSyncDurationMs: snapshot.durationMs,
      responseTimeMs: snapshot.responseTimeMs,
      lastError: null,
    });

    return {
      ok: true,
      status: 'connected',
      mode: 'live',
      instance: mapInstanceConfig(snapshot.config),
      fetched: snapshot.hosts.length + snapshot.services.length + snapshot.events.length,
      hosts: snapshot.hosts.length,
      services: snapshot.services.length,
      events: snapshot.events.length,
      problems: snapshot.problems.length,
      responseTimeMs: snapshot.responseTimeMs,
      message: `${snapshot.config.label} connected. Fetched ${snapshot.hosts.length} hosts, ${snapshot.services.length} services, and ${snapshot.problems.length} active problems.`,
    };
  } catch (error) {
    const detail = describePollError(error);

    return {
      ok: false,
      status: 'connection_failed',
      mode: 'connection_failed',
      failureStage: detail.failureStage,
      failureType: detail.failureType,
      httpStatus: detail.httpStatus,
      responseTimeMs: detail.responseTimeMs,
      retryable: detail.retryable,
      message: `Nagios connection failed at ${detail.failureStage}: ${detail.failureReason}`,
    };
  }
}

async function pollAllInstances() {
  const results = [];

  for (const key of Object.keys(INSTANCE_DEFINITIONS)) {
    const config = await getInstanceRuntimeConfig(key);

    if (!config.configured) {
      await updateSourceStatus(config, {
        connectionStatus: 'not_configured',
        apiHealth: 'not_configured',
        syncStatus: 'idle',
        lastError: `Configure ${config.baseUrlEnv}/${config.apiKeyEnv} or save ${config.label} credentials in Settings.`,
      });
      results.push({
        instance: mapInstanceConfig(config),
        skipped: true,
        message: `${config.label} is not configured.`,
      });
      continue;
    }

    try {
      results.push(await pollInstance(key));
    } catch (error) {
      results.push({
        instance: mapInstanceConfig(config),
        skipped: false,
        error: error.message,
      });
    }
  }

  return results;
}

function startNagiosPolling() {
  if (pollingStarted) {
    return;
  }

  pollingStarted = true;
  const intervalMs = Number(process.env.NAGIOS_POLL_INTERVAL_MS || DEFAULT_POLL_INTERVAL_MS);

  if (intervalMs <= 0) {
    return;
  }

  setTimeout(() => {
    pollAllInstances().catch((error) => {
      console.error('Initial Nagios poll failed', error);
    });
  }, 5000);

  setInterval(() => {
    pollAllInstances().catch((error) => {
      console.error('Nagios periodic poll failed', error);
    });
  }, intervalMs);
}

function mapInstanceConfig(config) {
  return {
    key: config.key,
    label: config.label,
    sourceKey: config.sourceKey,
    configured: config.configured,
    baseUrlConfigured: Boolean(config.baseUrl),
    apiKeyConfigured: Boolean(config.apiKey),
    credentialSource: config.credentialSource,
    nagiosUrl: buildNagiosUiUrl(config),
  };
}

function mapHostRow(row) {
  return {
    instanceKey: row.instance_key,
    hostName: row.host_name,
    displayName: row.display_name,
    address: row.address,
    status: row.status,
    currentState: row.current_state,
    stateType: row.state_type,
    lastCheck: row.last_check,
    lastStateChange: row.last_state_change,
    durationSeconds: row.duration_seconds,
    attemptCount: row.attempt_count,
    pluginOutput: row.plugin_output,
    acknowledged: row.acknowledged,
    acknowledgementType: row.acknowledgement_type,
    inDowntime: row.in_downtime,
    downtimeDepth: row.downtime_depth,
    isFlapping: row.is_flapping,
    rawPayload: row.raw_payload,
    lastPolledAt: row.last_polled_at,
    updatedAt: row.updated_at,
  };
}

function mapServiceRow(row) {
  return {
    instanceKey: row.instance_key,
    hostName: row.host_name,
    serviceDescription: row.service_description,
    displayName: row.display_name,
    status: row.status,
    currentState: row.current_state,
    stateType: row.state_type,
    lastCheck: row.last_check,
    lastStateChange: row.last_state_change,
    durationSeconds: row.duration_seconds,
    attemptCount: row.attempt_count,
    pluginOutput: row.plugin_output,
    acknowledged: row.acknowledged,
    acknowledgementType: row.acknowledgement_type,
    inDowntime: row.in_downtime,
    downtimeDepth: row.downtime_depth,
    isFlapping: row.is_flapping,
    performanceData: row.performance_data,
    rawPayload: row.raw_payload,
    lastPolledAt: row.last_polled_at,
    updatedAt: row.updated_at,
  };
}

function mapProblemRow(row) {
  return {
    instanceKey: row.instance_key,
    problemKey: row.problem_key,
    problemType: row.problem_type,
    hostName: row.host_name,
    serviceDescription: row.service_description,
    status: row.status,
    severity: row.severity,
    currentState: row.current_state,
    acknowledged: row.acknowledged,
    inDowntime: row.in_downtime,
    pluginOutput: row.plugin_output,
    lastCheck: row.last_check,
    lastStateChange: row.last_state_change,
    durationSeconds: row.duration_seconds,
    rawPayload: row.raw_payload,
    lastPolledAt: row.last_polled_at,
    updatedAt: row.updated_at,
  };
}

function mapEventRow(row) {
  return {
    instanceKey: row.instance_key,
    eventHash: row.event_hash,
    eventId: row.event_id,
    eventTime: row.event_time,
    hostName: row.host_name,
    serviceDescription: row.service_description,
    eventType: row.event_type,
    status: row.status,
    state: row.state,
    oldState: row.old_state,
    newState: row.new_state,
    severity: row.severity,
    acknowledged: row.acknowledged,
    inDowntime: row.in_downtime,
    output: row.output,
    rawPayload: row.raw_payload,
    createdAt: row.created_at,
  };
}

function mapDowntimeRow(row) {
  return {
    sourceInstance: row.source_instance,
    downtimeKey: row.downtime_key,
    entityType: row.entity_type,
    hostName: row.host_name,
    serviceName: row.service_name,
    author: row.author,
    comment: row.comment,
    startTime: row.start_time,
    endTime: row.end_time,
    durationSeconds: row.duration_seconds,
    fixed: row.fixed,
    active: row.active,
    rawPayload: row.raw_payload || {},
    lastPolledAt: row.last_polled_at,
    updatedAt: row.updated_at,
  };
}

function mapAiFeatureRow(row) {
  return {
    sourceInstance: row.source_instance,
    entityType: row.entity_type,
    entityId: row.entity_id,
    entityName: row.entity_name,
    featureTimestamp: row.feature_timestamp,
    currentState: row.current_state,
    previousState: row.previous_state,
    stateChangeCount: row.state_change_count,
    recurrenceCount: row.recurrence_count,
    alertFrequency: row.alert_frequency,
    alertDensity: row.alert_density,
    timeSinceLastChangeSeconds: row.time_since_last_change_seconds,
    timeSinceLastAlertSeconds: row.time_since_last_alert_seconds,
    timeSinceLastRecoverySeconds: row.time_since_last_recovery_seconds,
    averageProblemDurationSeconds: row.average_problem_duration_seconds,
    maximumProblemDurationSeconds: row.maximum_problem_duration_seconds,
    minimumProblemDurationSeconds: row.minimum_problem_duration_seconds,
    recoveryTimeSeconds: row.recovery_time_seconds,
    flappingScore: row.flapping_score,
    stabilityScore: row.stability_score,
    downtimeCount: row.downtime_count,
    acknowledgementCount: row.acknowledgement_count,
    severityScore: row.severity_score,
    volatilityScore: row.volatility_score,
    trendDirection: row.trend_direction,
    noiseLikelihood: row.noise_likelihood,
    incidentLikelihood: row.incident_likelihood,
    flappingLikelihood: row.flapping_likelihood,
    recurrenceLikelihood: row.recurrence_likelihood,
    correlationLikelihood: row.correlation_likelihood,
    correlationPlaceholder: row.correlation_placeholder || {},
    aiLabel: row.ai_label,
    aiConfidence: row.ai_confidence,
    aiReason: row.ai_reason,
    rawPayloadReference: row.raw_payload_reference,
    rawPayload: row.raw_payload || {},
    updatedAt: row.updated_at,
  };
}

function mapSyncLogRow(row) {
  return {
    id: row.id,
    sourceInstance: row.source_instance,
    syncType: row.sync_type,
    status: row.status,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    durationMs: row.duration_ms,
    counts: row.counts || {},
    warnings: row.warnings || [],
    errorMessage: row.error_message,
    rawPayload: row.raw_payload || {},
  };
}

function mapPollHistoryRow(row) {
  return {
    id: row.id,
    sourceInstance: row.source_instance,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    durationMs: row.duration_ms,
    result: row.result,
    failureStage: row.failure_stage,
    failureType: row.failure_type,
    failureReason: row.failure_reason,
    httpStatus: row.http_status,
    responseTimeMs: row.response_time_ms,
    retryCount: row.retry_count,
    recordsRetrieved: row.records_retrieved,
    recordsInserted: row.records_inserted,
    recordsUpdated: row.records_updated,
    recordsSkipped: row.records_skipped,
    recordsFailed: row.records_failed,
    rawPayload: row.raw_payload || {},
  };
}

function mapSyncStatisticsRow(row) {
  if (!row) {
    return {
      totalPolls: 0,
      successfulPolls: 0,
      failedPolls: 0,
      lastSuccessfulSync: null,
      lastFailedSync: null,
      averageResponseTimeMs: null,
      averagePollDurationMs: null,
      recordsRetrieved: 0,
      recordsInserted: 0,
      recordsUpdated: 0,
      recordsSkipped: 0,
      recordsFailed: 0,
    };
  }

  return {
    sourceInstance: row.source_instance,
    totalPolls: row.total_polls,
    successfulPolls: row.successful_polls,
    failedPolls: row.failed_polls,
    lastSuccessfulSync: row.last_successful_sync,
    lastFailedSync: row.last_failed_sync,
    averageResponseTimeMs: row.average_response_time_ms,
    averagePollDurationMs: row.average_poll_duration_ms,
    recordsRetrieved: row.records_retrieved,
    recordsInserted: row.records_inserted,
    recordsUpdated: row.records_updated,
    recordsSkipped: row.records_skipped,
    recordsFailed: row.records_failed,
    updatedAt: row.updated_at,
  };
}

function mapConnectorHealthRow(row, config) {
  const freshness = computeFreshness(row?.last_successful_poll);

  return {
    sourceInstance: config.key,
    label: config.label,
    sourceKey: config.sourceKey,
    status: row?.status || (config.configured ? 'disconnected' : 'not_configured'),
    connectionHealth: row?.connection_health || (config.configured ? 'disconnected' : 'not_configured'),
    failureStage: row?.failure_stage || null,
    failureType: row?.failure_type || null,
    failureReason: row?.failure_reason || null,
    httpStatus: row?.http_status || null,
    responseTimeMs: row?.response_time_ms || null,
    lastSuccessfulPoll: row?.last_successful_poll || null,
    lastFailedPoll: row?.last_failed_poll || null,
    lastPollStartedAt: row?.last_poll_started_at || null,
    lastPollEndedAt: row?.last_poll_ended_at || null,
    recordsRetrieved: row?.records_retrieved || 0,
    recordsInserted: row?.records_inserted || 0,
    recordsUpdated: row?.records_updated || 0,
    recordsSkipped: row?.records_skipped || 0,
    retryCount: row?.retry_count || 0,
    nextScheduledPoll: row?.next_scheduled_poll || getNextScheduledPoll(row?.last_poll_ended_at || new Date()),
    dataFreshnessStatus: row?.data_freshness_status || freshness.dataFreshnessStatus,
    dataFreshnessSeconds: row?.data_freshness_seconds ?? freshness.dataFreshnessSeconds,
    metadata: row?.metadata || {},
    updatedAt: row?.updated_at || null,
  };
}

async function getNagiosHealth(instanceKey = null) {
  await ensureNagiosStorage();
  const instanceKeys = instanceKey ? [getInstanceDefinition(instanceKey).key] : Object.keys(INSTANCE_DEFINITIONS);
  const items = [];

  for (const key of instanceKeys) {
    const config = await getInstanceRuntimeConfig(key);
    const [healthResult, statisticsResult, historyResult] = await Promise.all([
      db.query('SELECT * FROM nagios_connector_health WHERE source_instance = $1', [config.key]),
      db.query('SELECT * FROM nagios_sync_statistics WHERE source_instance = $1', [config.key]),
      db.query('SELECT * FROM nagios_poll_history WHERE source_instance = $1 ORDER BY started_at DESC LIMIT 20', [config.key]),
    ]);

    items.push({
      instance: mapInstanceConfig(config),
      health: mapConnectorHealthRow(healthResult.rows[0], config),
      statistics: mapSyncStatisticsRow(statisticsResult.rows[0]),
      pollHistory: historyResult.rows.map(mapPollHistoryRow),
    });
  }

  const failed = items.filter((item) => ['failed', 'disconnected'].includes(item.health.status)).length;
  const polling = items.filter((item) => item.health.status === 'polling').length;
  const healthy = items.filter((item) => item.health.status === 'healthy').length;
  const notConfigured = items.filter((item) => item.health.status === 'not_configured').length;

  return {
    overallStatus: failed > 0 ? 'warning' : polling > 0 ? 'polling' : healthy > 0 && notConfigured === 0 ? 'healthy' : 'warning',
    generatedAt: new Date().toISOString(),
    connectedInstances: healthy,
    totalInstances: items.length,
    instances: items,
  };
}

function emptySummary(type) {
  return buildSummary([], type);
}

async function getSourceStatus(config) {
  await ensureNagiosStorage();
  const result = await db.query('SELECT * FROM monitoring_source_status WHERE source_key = $1', [config.sourceKey]);
  const row = result.rows[0];

  return {
    connectionStatus: row?.connection_status || (config.configured ? 'checking' : 'not_configured'),
    apiHealth: row?.api_health || (config.configured ? 'checking' : 'not_configured'),
    syncStatus: row?.sync_status || 'idle',
    lastSuccessfulSync: row?.last_successful_sync || null,
    lastFailedSync: row?.last_failed_sync || null,
    lastAlertReceivedAt: row?.last_alert_received_at || null,
    totalAlertsImported: Number(row?.total_alerts_imported || 0),
    lastSyncDurationMs: row?.last_sync_duration_ms || null,
    responseTimeMs: row?.response_time_ms || null,
    lastError: row?.last_error || null,
    metadata: row?.metadata || {},
  };
}

async function getInstanceSnapshot(instanceKey) {
  await ensureNagiosStorage();
  const config = await getInstanceRuntimeConfig(instanceKey);
  const [hostRows, serviceRows, problemRows, eventRows, serviceSummaryRows, hostSummaryRows, downtimeRows, aiFeatureRows, syncLogRows, sourceStatus, connectorHealthRows, syncStatisticsRows, pollHistoryRows] = await Promise.all([
    db.query('SELECT * FROM nagios_host_status WHERE instance_key = $1 AND is_active = TRUE ORDER BY host_name LIMIT 1000', [config.key]),
    db.query('SELECT * FROM nagios_service_status WHERE instance_key = $1 AND is_active = TRUE ORDER BY host_name, service_description LIMIT 2000', [config.key]),
    db.query('SELECT * FROM nagios_active_problems WHERE instance_key = $1 ORDER BY severity, host_name, service_description LIMIT 500', [config.key]),
    db.query('SELECT * FROM nagios_event_history WHERE instance_key = $1 ORDER BY event_time DESC LIMIT 200', [config.key]),
    db.query('SELECT * FROM nagios_summary_snapshots WHERE instance_key = $1 AND summary_type = $2', [config.key, 'service']),
    db.query('SELECT * FROM nagios_summary_snapshots WHERE instance_key = $1 AND summary_type = $2', [config.key, 'host']),
    db.query('SELECT * FROM nagios_downtime WHERE source_instance = $1 ORDER BY active DESC, start_time DESC NULLS LAST LIMIT 300', [config.key]),
    db.query('SELECT * FROM nagios_ai_features WHERE source_instance = $1 ORDER BY severity_score DESC NULLS LAST, volatility_score DESC NULLS LAST, entity_name LIMIT 500', [config.key]),
    db.query('SELECT * FROM nagios_sync_logs WHERE source_instance = $1 ORDER BY started_at DESC LIMIT 20', [config.key]),
    getSourceStatus(config),
    db.query('SELECT * FROM nagios_connector_health WHERE source_instance = $1', [config.key]),
    db.query('SELECT * FROM nagios_sync_statistics WHERE source_instance = $1', [config.key]),
    db.query('SELECT * FROM nagios_poll_history WHERE source_instance = $1 ORDER BY started_at DESC LIMIT 20', [config.key]),
  ]);

  const hosts = hostRows.rows.map(mapHostRow);
  const services = serviceRows.rows.map(mapServiceRow);

  return {
    instance: mapInstanceConfig(config),
    status: sourceStatus,
    connectorHealth: mapConnectorHealthRow(connectorHealthRows.rows[0], config),
    syncStatistics: mapSyncStatisticsRow(syncStatisticsRows.rows[0]),
    serviceSummary: serviceSummaryRows.rows[0]?.status_counts || buildSummary(services, 'service'),
    hostSummary: hostSummaryRows.rows[0]?.status_counts || buildSummary(hosts, 'host'),
    services,
    hosts,
    problems: problemRows.rows.map(mapProblemRow),
    events: eventRows.rows.map(mapEventRow),
    downtime: downtimeRows.rows.map(mapDowntimeRow),
    aiFeatures: aiFeatureRows.rows.map(mapAiFeatureRow),
    syncLogs: syncLogRows.rows.map(mapSyncLogRow),
    pollHistory: pollHistoryRows.rows.map(mapPollHistoryRow),
  };
}

async function getServiceSummary(instanceKey) {
  return (await getInstanceSnapshot(instanceKey)).serviceSummary || emptySummary('service');
}

async function getHostSummary(instanceKey) {
  return (await getInstanceSnapshot(instanceKey)).hostSummary || emptySummary('host');
}

async function getServices(instanceKey) {
  const snapshot = await getInstanceSnapshot(instanceKey);

  return {
    instance: snapshot.instance,
    data: snapshot.services,
  };
}

async function getHosts(instanceKey) {
  const snapshot = await getInstanceSnapshot(instanceKey);

  return {
    instance: snapshot.instance,
    data: snapshot.hosts,
  };
}

async function getProblems(instanceKey) {
  const snapshot = await getInstanceSnapshot(instanceKey);

  return {
    instance: snapshot.instance,
    status: snapshot.status,
    data: snapshot.problems,
  };
}

async function getEvents(instanceKey) {
  const snapshot = await getInstanceSnapshot(instanceKey);

  return {
    instance: snapshot.instance,
    data: snapshot.events,
  };
}

async function getHistoricalOccurrenceEvidence(instanceKey, options = {}) {
  const config = await getInstanceRuntimeConfig(instanceKey);
  if (!config.configured) {
    const error = new Error(`${config.label} is not configured.`);
    error.status = 503;
    error.safeMessage = `${config.label} historical evidence is unavailable because its backend configuration is incomplete.`;
    throw error;
  }

  const host = String(options.host || '').trim();
  const serviceDescription = String(options.service || '').trim() || null;
  const fromMs = new Date(options.from).getTime();
  const toMs = new Date(options.to).getTime();
  const anchorMs = new Date(options.anchor || options.from).getTime();
  if (!host || !Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs > toMs) {
    const error = new Error('A host and valid bounded time window are required for Nagios historical evidence.');
    error.status = 400;
    throw error;
  }
  if ((toMs - fromMs) > HISTORY_MAX_WINDOW_MS + 5 * 60 * 1000) {
    const error = new Error('Nagios historical evidence windows are limited to two hours plus the occurrence lead-in.');
    error.status = 400;
    throw error;
  }

  const query = {
    starttime: Math.floor(fromMs / 1000),
    endtime: Math.ceil(toMs / 1000),
    host_name: host,
    ...(serviceDescription ? { service_description: serviceDescription } : {}),
  };
  const startedAt = Date.now();
  const [statusResponse, stateResponse, logResponse] = await Promise.all([
    fetchJson(buildNagiosUrl(config, 'system/status', { pretty: 0 }), 'read_historical_clock'),
    fetchBoundedHistoryRows(config, 'objects/statehistory', ['stateentry', 'statehistory', 'events'], query),
    fetchBoundedHistoryRows(config, 'objects/logentries', ['logentry', 'logentries', 'events'], query),
  ]);
  const retrievedAt = new Date().toISOString();
  const sourceStatusTime = statusResponse.payload?.status_update_time || null;
  const sourceUtcOffsetMinutes = inferNagiosUtcOffsetMinutes(sourceStatusTime, Date.now());
  const states = stateResponse.rows
    .map((row) => normalizeNagiosHistoryState(config.key, row, sourceUtcOffsetMinutes))
    .filter((row) => row.timestamp && exactNagiosIdentity(row, host, serviceDescription))
    .sort((left, right) => new Date(left.timestamp) - new Date(right.timestamp));
  const logs = logResponse.rows
    .map((row) => parseNagiosHistoryLog(config.key, row, sourceUtcOffsetMinutes))
    .filter((row) => row.timestamp && exactNagiosIdentity(row, host, serviceDescription))
    .sort((left, right) => new Date(left.timestamp) - new Date(right.timestamp));
  const candidates = states.filter((row) => isNagiosProblemState(row)
    && Math.abs(new Date(row.timestamp).getTime() - anchorMs) <= 10 * 60 * 1000);
  const hardCandidates = candidates.filter((row) => row.stateType === 'hard');
  const occurrence = (hardCandidates.length ? hardCandidates : candidates)
    .map((row) => ({ row, distance: Math.abs(new Date(row.timestamp).getTime() - anchorMs), hardRank: row.stateType === 'hard' ? 0 : 1 }))
    .sort((left, right) => left.distance - right.distance || left.hardRank - right.hardRank)[0]?.row || null;
  const occurrenceMs = occurrence ? new Date(occurrence.timestamp).getTime() : null;
  const recovery = occurrenceMs === null ? null : states.find((row) => (
    new Date(row.timestamp).getTime() > occurrenceMs && row.stateType === 'hard' && isNagiosRecoveryState(row)
  )) || null;
  const notification = occurrenceMs === null ? null : logs.find((row) => (
    row.kind === 'notification'
      && Math.abs(new Date(row.timestamp).getTime() - occurrenceMs) <= 90 * 1000
      && String(row.state || '').toLowerCase() === String(occurrence.state || '').toLowerCase()
  )) || null;
  const acknowledgement = occurrenceMs === null ? null : logs.find((row) => (
    row.kind === 'acknowledgement' && new Date(row.timestamp).getTime() >= occurrenceMs
  )) || null;
  const flapping = logs.filter((row) => row.kind === 'flapping_alert');
  const recoveryMs = recovery ? new Date(recovery.timestamp).getTime() : null;

  return {
    instance: config.key,
    host,
    service: serviceDescription,
    objectType: serviceDescription ? 'service' : 'host',
    occurrence,
    recovery,
    notification,
    acknowledgement,
    flapping,
    currentState: null,
    durationSeconds: occurrenceMs !== null && recoveryMs !== null
      ? Math.max(0, Math.round((recoveryMs - occurrenceMs) / 1000)) : null,
    stateHistory: states,
    activity: logs,
    sourceUrl: buildNagiosUiUrl(config),
    retrievedAt,
    sourceProvenance: {
      source: config.label,
      instance: config.key,
      sourceEntityType: 'HISTORICAL_SOURCE_ENTITY',
      endpoints: ['objects/statehistory', 'objects/logentries', 'system/status'],
      queryWindow: { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() },
      exactIdentity: { host, service: serviceDescription },
      sourceStatusTime,
      sourceUtcOffsetMinutes,
      timestampMethod: Number.isFinite(sourceUtcOffsetMinutes)
        ? 'NAGIOS_SERVER_CLOCK_OFFSET' : 'SOURCE_TIMESTAMP_DIRECT_PARSE',
      stateHistoryPages: stateResponse.pages,
      logEntryPages: logResponse.pages,
      readOnly: true,
      fetchedAt: retrievedAt,
      retrievalDurationMs: Date.now() - startedAt,
    },
  };
}

async function getDowntime(instanceKey) {
  const snapshot = await getInstanceSnapshot(instanceKey);

  return {
    instance: snapshot.instance,
    data: snapshot.downtime,
  };
}

async function getAiFeatures(instanceKey) {
  const snapshot = await getInstanceSnapshot(instanceKey);

  return {
    instance: snapshot.instance,
    data: snapshot.aiFeatures,
  };
}

async function getSyncLogs(instanceKey) {
  const snapshot = await getInstanceSnapshot(instanceKey);

  return {
    instance: snapshot.instance,
    data: snapshot.syncLogs,
  };
}

module.exports = {
  clearNagiosWorkspaceCache,
  getAiFeatures,
  getDowntime,
  getEvents,
  getHistoricalOccurrenceEvidence,
  getHostSummary,
  getHosts,
  getInstanceConfig,
  getInstanceSnapshot,
  getNagiosHealth,
  getProblems,
  getServiceSummary,
  getServices,
  getSyncLogs,
  getWorkspaceOverview,
  getWorkspaceRecord,
  getWorkspaceSnapshot,
  listWorkspaceRecords,
  pollAllInstances,
  pollInstance,
  startNagiosPolling,
  testInstanceConnection,
  inferNagiosUtcOffsetMinutes,
  nagiosSourceTimestampToIso,
};
