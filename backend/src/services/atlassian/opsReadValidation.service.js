const { opsReadClient, sanitizeError } = require('./clients');
const { redactRawPayload } = require('../rawOperationsIdentity.service');

const DEFAULT_PAGE_SIZE = 10;
const MAX_PAGE_SIZE = 100;
const MAX_OFFSET_AND_SIZE = 20000;

function boundedInteger(value, fallback, minimum, maximum) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    const error = new Error(`Expected an integer between ${minimum} and ${maximum}.`);
    error.status = 400;
    error.code = 'INVALID_PAGINATION_PARAMETER';
    error.safeMessage = error.message;
    throw error;
  }
  return parsed;
}

function optionalEpochMilliseconds(value, name) {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    const error = new Error(`${name} must be a non-negative Unix timestamp in milliseconds.`);
    error.status = 400;
    error.code = 'INVALID_TIME_PARAMETER';
    error.safeMessage = error.message;
    throw error;
  }
  return parsed;
}

function cleanQuery(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const query = String(value).trim();
  if (query.length > 1000) {
    const error = new Error('Operations alert query must be 1000 characters or fewer.');
    error.status = 400;
    error.code = 'QUERY_TOO_LONG';
    error.safeMessage = error.message;
    throw error;
  }
  return query || undefined;
}

function cleanSort(value) {
  const sort = String(value || 'updatedAt').trim();
  if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(sort)) {
    const error = new Error('Invalid Operations sort field.');
    error.status = 400;
    error.code = 'INVALID_SORT_PARAMETER';
    error.safeMessage = error.message;
    throw error;
  }
  return sort;
}

function cleanOrder(value) {
  const order = String(value || 'desc').toLowerCase();
  if (!['asc', 'desc'].includes(order)) {
    const error = new Error('Operations order must be asc or desc.');
    error.status = 400;
    error.code = 'INVALID_ORDER_PARAMETER';
    error.safeMessage = error.message;
    throw error;
  }
  return order;
}

function getValues(payload) {
  if (Array.isArray(payload?.values)) return payload.values;
  if (Array.isArray(payload?.alerts)) return payload.alerts;
  if (Array.isArray(payload)) return payload;

  const error = new Error('JSM Operations list response did not contain a values array.');
  error.status = 502;
  error.code = 'MALFORMED_OPERATIONS_RESPONSE';
  error.safeMessage = error.message;
  throw error;
}

function mapAlert(alert = {}) {
  const tinyId = alert.tinyId === undefined || alert.tinyId === null
    ? null
    : String(alert.tinyId);

  return {
    id: alert.id || null,
    tinyId,
    displayId: tinyId ? `#${tinyId}` : null,
    alias: alert.alias || null,
    message: alert.message || null,
    summary: alert.summary || alert.message || null,
    description: alert.description || null,
    status: alert.status || null,
    acknowledged: alert.acknowledged ?? null,
    ackTime: alert.ackTime || null,
    closeTime: alert.closeTime || null,
    priority: alert.priority || null,
    source: alert.source || null,
    entity: alert.entity || null,
    integrationType: alert.integrationType || null,
    integrationName: alert.integrationName || null,
    owner: alert.owner || null,
    responders: Array.isArray(alert.responders) ? alert.responders : [],
    services: Array.isArray(alert.services) ? alert.services : [],
    tags: Array.isArray(alert.tags) ? alert.tags : [],
    createdAt: alert.createdAt || null,
    updatedAt: alert.updatedAt || null,
    lastOccurredAt: alert.lastOccuredAt || alert.lastOccurredAt || null,
    count: alert.count ?? null,
    snoozed: alert.snoozed ?? null,
    snoozedUntil: alert.snoozedUntil || null,
    seen: alert.seen ?? null,
    actions: Array.isArray(alert.actions) ? alert.actions : [],
    extraProperties: alert.extraProperties && typeof alert.extraProperties === 'object'
      ? alert.extraProperties
      : {},
    returnedFields: Object.keys(alert).sort(),
    rawOperationsPayload: redactRawPayload(alert),
  };
}

function mapPage(payload, request) {
  const values = getValues(payload);
  return {
    values: values.map(mapAlert),
    count: Number(payload?.count ?? values.length),
    links: payload?.links || {},
    pagination: {
      offset: request.offset,
      requestedSize: request.size,
      returnedSize: values.length,
      hasNextPage: Boolean(payload?.links?.next || payload?.next),
      retrievalBoundary: 'offset + size must be lower than 20000',
    },
    request: {
      from: request.from ?? null,
      offset: request.offset,
      order: request.order,
      query: request.query ?? null,
      size: request.size,
      sort: request.sort,
      to: request.to ?? null,
    },
    responseShape: {
      listProperty: Array.isArray(payload?.values) ? 'values' : Array.isArray(payload?.alerts) ? 'alerts' : 'array',
      topLevelFields: payload && typeof payload === 'object' ? Object.keys(payload).sort() : [],
      alertFields: [...new Set(values.flatMap((alert) => Object.keys(alert || {})))].sort(),
    },
  };
}

function buildListQuery(options = {}) {
  const size = boundedInteger(options.size, DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE);
  const offset = boundedInteger(options.offset, 0, 0, MAX_OFFSET_AND_SIZE - 1);
  if (offset + size >= MAX_OFFSET_AND_SIZE) {
    const error = new Error('Operations requires offset + size to be lower than 20000. Use a smaller page or time window.');
    error.status = 422;
    error.code = 'OPERATIONS_RETRIEVAL_BOUNDARY';
    error.safeMessage = error.message;
    throw error;
  }

  const from = optionalEpochMilliseconds(options.from, 'from');
  const to = optionalEpochMilliseconds(options.to, 'to');
  if (from !== undefined && to !== undefined && from > to) {
    const error = new Error('Operations from timestamp must be earlier than or equal to to timestamp.');
    error.status = 400;
    error.code = 'INVALID_TIME_RANGE';
    error.safeMessage = error.message;
    throw error;
  }

  return {
    from,
    offset,
    order: cleanOrder(options.order),
    query: cleanQuery(options.query),
    size,
    sort: cleanSort(options.sort),
    to,
  };
}

function safeConfiguration(config) {
  return {
    cloudId: Boolean(config.cloudId),
    email: Boolean(config.email),
    opsReadToken: Boolean(config.token),
    configured: config.missing.length === 0,
    missing: config.missing,
    credentialLocation: process.env.ATLASSIAN_CLOUD_ID
      || process.env.ATLASSIAN_EMAIL
      || process.env.ATLASSIAN_OPS_READ_TOKEN
      ? 'backend_environment'
      : config.missing.length === 0 ? 'encrypted_integration_settings' : 'not_configured',
    environment: {
      ATLASSIAN_CLOUD_ID: Boolean(process.env.ATLASSIAN_CLOUD_ID),
      ATLASSIAN_EMAIL: Boolean(process.env.ATLASSIAN_EMAIL),
      ATLASSIAN_OPS_READ_TOKEN: Boolean(process.env.ATLASSIAN_OPS_READ_TOKEN),
    },
  };
}

function createOpsReadValidationService({ client = opsReadClient } = {}) {
  async function read(path, query = {}) {
    return client.request(path, { method: 'GET', query });
  }

  async function getConfiguration() {
    const config = await client.getRuntimeConfigAsync();
    return safeConfiguration(config);
  }

  async function testConnection() {
    const configuration = await getConfiguration();
    if (!configuration.configured) {
      return {
        authentication: 'not_tested',
        configuration,
        operationsApi: 'not_tested',
        listAlerts: 'not_tested',
        readOnly: true,
      };
    }

    try {
      const request = buildListQuery({ size: 1, offset: 0, sort: 'updatedAt', order: 'desc' });
      const response = await read('/v1/alerts', request);
      const page = mapPage(response.body, request);
      return {
        authentication: 'success',
        configuration,
        httpStatus: response.status,
        listAlerts: 'success',
        operationsApi: 'reachable',
        readOnly: true,
        sampleCount: page.values.length,
        responseShape: page.responseShape,
      };
    } catch (error) {
      return {
        authentication: [401, 403].includes(error.status) ? 'failed' : 'unknown',
        configuration,
        error: sanitizeError(error),
        listAlerts: 'failed',
        operationsApi: error.code === 'NETWORK_OR_TLS_FAILURE' ? 'unreachable' : 'reachable_with_error',
        readOnly: true,
      };
    }
  }

  async function listAlerts(options = {}) {
    const request = buildListQuery(options);
    const response = await read('/v1/alerts', request);
    return {
      ...mapPage(response.body, request),
      httpStatus: response.status,
      readOnly: true,
    };
  }

  async function getAlert(alertId) {
    const response = await read(`/v1/alerts/${encodeURIComponent(alertId)}`);
    return {
      alert: {
        ...mapAlert(response.body || {}),
        // The raw Operations object is exposed only by this single-alert read.
        // List responses stay normalized and intentionally omit raw payloads.
        rawOperationsPayload: response.body || {},
      },
      httpStatus: response.status,
      readOnly: true,
    };
  }

  async function findByTinyId(tinyId) {
    const normalizedTinyId = String(tinyId || '').replace(/^#/, '').trim();
    if (!/^\d+$/.test(normalizedTinyId)) {
      const error = new Error('Known alert identifier must contain only its numeric tinyId.');
      error.status = 400;
      error.code = 'INVALID_TINY_ID';
      error.safeMessage = error.message;
      throw error;
    }

    const page = await listAlerts({
      offset: 0,
      order: 'desc',
      query: normalizedTinyId,
      size: 25,
      sort: 'updatedAt',
    });
    const alert = page.values.find((item) => item.tinyId === normalizedTinyId) || null;
    return {
      alert,
      found: Boolean(alert),
      queryUsed: normalizedTinyId,
      readOnly: true,
      resultCount: page.values.length,
    };
  }

  async function getChildCollection(alertId, collection, options = {}) {
    const size = boundedInteger(options.size, 25, 1, MAX_PAGE_SIZE);
    const after = options.after ? String(options.after).slice(0, 500) : undefined;
    const response = await read(
      `/v1/alerts/${encodeURIComponent(alertId)}/${collection}`,
      { after, size },
    );
    const values = Array.isArray(response.body?.values) ? response.body.values : [];
    return {
      values,
      links: response.body?.links || {},
      pagination: {
        after: after || null,
        hasNextPage: Boolean(response.body?.links?.next),
        requestedSize: size,
        returnedSize: values.length,
      },
      returnedFields: [...new Set(values.flatMap((value) => Object.keys(value || {})))].sort(),
      httpStatus: response.status,
      readOnly: true,
    };
  }

  return {
    findByTinyId,
    getAlert,
    getConfiguration,
    getLogs: (alertId, options) => getChildCollection(alertId, 'logs', options),
    getNotes: (alertId, options) => getChildCollection(alertId, 'notes', options),
    listAlerts,
    testConnection,
  };
}

module.exports = {
  MAX_OFFSET_AND_SIZE,
  MAX_PAGE_SIZE,
  buildListQuery,
  createOpsReadValidationService,
  mapAlert,
  service: createOpsReadValidationService(),
};
