const crypto = require('crypto');
const integrationService = require('./integration.service');
const db = require('../config/db');
const {
  notEvaluatedMetadata,
  unclassifiedFoundationState,
} = require('../config/decisionLayer');
const { adfToText } = require('../utils/jiraAdf');
const jiraFieldMapper = require('../utils/jiraFieldMapper');

const JIRA_TIMEOUT_MS = 8000;
const JIRA_PAGE_SIZE = 50;
const JIRA_MAX_RETRIES = 3;
const JSM_OPERATIONS_PAGE_SIZE = 100;
const JSM_OPERATIONS_DETAIL_BATCH_SIZE = 10;
const DEFAULT_PROJECT_KEY = 'ACC';
const JSM_OPERATIONS_SYNC_NAME = 'jsm_operations_backfill';
const JIRA_INCIDENTS_SYNC_NAME = 'jira_incidents_backfill';
const JIRA_FIELD_CACHE_MS = 10 * 60 * 1000;

let jiraFieldLookupCache = null;

function normalizeText(value, fallback = 'Not available') {
  if (value === null || value === undefined || value === '') {
    return fallback;
  }

  return String(value);
}

function normalizeSummary(alert) {
  const severity = normalizeText(alert.severity, 'unknown').toUpperCase();
  const title = normalizeText(alert.title, 'Alert requires investigation');
  const summary = `[${severity}] ${title}`;

  return summary.length > 255 ? `${summary.slice(0, 252)}...` : summary;
}

function normalizeLabel(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 255);
}

function buildLabels(alert) {
  return [
    'alert-noise-reduction',
    normalizeLabel(alert.service),
    normalizeLabel(alert.environment),
    normalizeLabel(alert.severity),
  ].filter(Boolean);
}

function buildDescriptionText(alert) {
  return [
    `Alert ID: ${normalizeText(alert.id)}`,
    `Title: ${normalizeText(alert.title)}`,
    `Severity: ${normalizeText(alert.severity)}`,
    `Service: ${normalizeText(alert.service)}`,
    `Environment: ${normalizeText(alert.environment)}`,
    `Status: ${normalizeText(alert.status)}`,
    `Classification: ${normalizeText(alert.classification)}`,
    `Source: ${normalizeText(alert.source)}`,
    `Occurrences: ${normalizeText(alert.occurrences)}`,
    `Owner: ${normalizeText(alert.owner)}`,
    `Received: ${normalizeText(alert.receivedAt)}`,
    '',
    'Signal',
    normalizeText(alert.signal),
    '',
    'Description',
    normalizeText(alert.description),
    '',
    'Classification reason',
    normalizeText(alert.classificationReason, 'No classification reason is available yet.'),
  ].join('\n');
}

function getFieldText(value) {
  return adfToText(value);
}

function getJiraConfigFromEnv() {
  const baseUrl = process.env.JIRA_BASE_URL?.trim();
  const email = process.env.JIRA_EMAIL?.trim();
  const apiToken = process.env.JIRA_API_TOKEN?.trim();
  const projectKey = process.env.JIRA_PROJECT_KEY?.trim();
  const alertsJql = process.env.JIRA_ALERTS_JQL?.trim();
  const incidentsJql = process.env.JIRA_INCIDENTS_JQL?.trim();

  if (!baseUrl && !email && !apiToken && !projectKey) {
    return null;
  }

  const missing = [
    ['JIRA_BASE_URL', baseUrl],
    ['JIRA_EMAIL', email],
    ['JIRA_API_TOKEN', apiToken],
    ['JIRA_PROJECT_KEY', projectKey],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);

  if (missing.length > 0) {
    const error = new Error(`Jira environment configuration is missing: ${missing.join(', ')}`);
    error.status = 400;
    throw error;
  }

  return {
    baseUrl,
    projectKey,
    email,
    apiToken,
    alertsJql,
    incidentsJql,
    source: 'env',
  };
}

async function getJiraRuntimeConfig() {
  const envConfig = getJiraConfigFromEnv();

  if (envConfig) {
    return envConfig;
  }

  const integrationConfig = await integrationService.getIntegrationRuntimeConfig('jira');

  return {
    baseUrl: integrationConfig.baseUrl,
    projectKey: integrationConfig.accountIdentifier,
    email: integrationConfig.credentials.email,
    apiToken: integrationConfig.credentials.apiToken,
    alertsJql: integrationConfig.credentials.alertsJql,
    incidentsJql: integrationConfig.credentials.incidentsJql,
    source: 'integration',
  };
}

async function getJsmOperationsRuntimeConfig() {
  const envConfig = getJiraConfigFromEnv();

  if (envConfig) {
    return envConfig;
  }

  return getJiraRuntimeConfig();
}

function getJiraAlertBaseJql(config) {
  const projectKey = config.projectKey || DEFAULT_PROJECT_KEY;

  return config.alertsJql?.trim() || process.env.JIRA_ALERTS_JQL?.trim() || `project = ${projectKey}`;
}

function getJiraIncidentBaseJql(config) {
  const projectKey = config.projectKey || DEFAULT_PROJECT_KEY;

  return config.incidentsJql?.trim()
    || process.env.JIRA_INCIDENTS_JQL?.trim()
    || `project = ${projectKey}`;
}

function buildProjectOnlyIncidentJql(config) {
  const projectKey = config.projectKey || DEFAULT_PROJECT_KEY;

  return `project = ${projectKey} ORDER BY created ASC`;
}

function splitJqlOrderBy(jql) {
  const match = String(jql).match(/\s+ORDER\s+BY\s+/i);

  if (!match) {
    return {
      query: String(jql).trim(),
      orderBy: 'ORDER BY created DESC',
    };
  }

  return {
    query: String(jql).slice(0, match.index).trim(),
    orderBy: `ORDER BY ${String(jql).slice(match.index + match[0].length).trim()}`,
  };
}

function toJiraDate(value, endOfDay = false) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null;
  }

  return endOfDay ? `${value} 23:59` : value;
}

function toJiraDateTime(value) {
  const timestamp = new Date(value || '').getTime();

  if (!Number.isFinite(timestamp)) {
    return null;
  }

  return new Date(timestamp).toISOString().slice(0, 16).replace('T', ' ');
}

function getDateRangeClause(options = {}) {
  if (options.updatedFrom) {
    const updatedFrom = toJiraDateTime(options.updatedFrom);

    return updatedFrom ? `updated >= "${updatedFrom}"` : '';
  }

  if (options.range === '1d') {
    return 'created >= -1d';
  }

  if (options.range === '1w') {
    return 'created >= -1w';
  }

  if (options.range === '1m') {
    return 'created >= -30d';
  }

  if (options.range === 'custom') {
    const clauses = [];
    const fromDate = toJiraDate(options.from);
    const toDate = toJiraDate(options.to, true);

    if (fromDate) {
      clauses.push(`created >= "${fromDate}"`);
    }

    if (toDate) {
      clauses.push(`created <= "${toDate}"`);
    }

    return clauses.join(' AND ');
  }

  return '';
}

function buildJiraAlertIssuesJql(config, options = {}) {
  const baseJql = options.jql?.trim() || getJiraAlertBaseJql(config);
  const { query, orderBy } = splitJqlOrderBy(baseJql);
  const dateRangeClause = getDateRangeClause(options);
  const clauses = dateRangeClause ? [`(${query})`, dateRangeClause] : [query];

  return `${clauses.join(' AND ')} ${orderBy}`;
}

function buildJiraIncidentIssuesJql(config, options = {}) {
  const baseJql = options.incidentsJql?.trim() || getJiraIncidentBaseJql(config);
  const { query, orderBy } = splitJqlOrderBy(baseJql);
  const dateRangeClause = getDateRangeClause(options);
  const clauses = dateRangeClause ? [`(${query})`, dateRangeClause] : [query];
  const resolvedOrderBy = options.incremental || options.updatedFrom
    ? 'ORDER BY updated ASC'
    : options.chronological
      ? 'ORDER BY created ASC'
      : orderBy;

  return `${clauses.join(' AND ')} ${resolvedOrderBy}`;
}

function getSearchFields() {
  return [
    'summary',
    'description',
    'status',
    'priority',
    'project',
    'assignee',
    'reporter',
    'created',
    'updated',
    'resolution',
    'resolutiondate',
    'labels',
    'components',
    'issuetype',
    'comment',
    'attachment',
    'issuelinks',
    'parent',
    'subtasks',
    '*all',
  ];
}

async function readJsonResponse(response) {
  const bodyText = await response.text();

  if (!bodyText) {
    return {};
  }

  try {
    return JSON.parse(bodyText);
  } catch {
    return { raw: bodyText };
  }
}

function cleanVendorMessage(value) {
  if (!value) {
    return '';
  }

  return String(value)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 280);
}

function getIssueErrorMessage(response, payload) {
  const messages = [
    ...(payload.errorMessages || []),
    ...Object.values(payload.errors || {}),
  ].filter(Boolean);

  if (response.status === 401) {
    return 'Jira rejected the credentials. Check JIRA_EMAIL and JIRA_API_TOKEN.';
  }

  if (response.status === 403) {
    return 'Jira returned 403. The account may be missing Browse Projects permission or issue-level security visibility for this incident.';
  }

  if (response.status === 400) {
    return messages.length > 0
      ? `Jira rejected the JQL: ${messages.join(' ')}`
      : 'Jira rejected the JQL request. Check the project key and query.';
  }

  return messages.length > 0
    ? `Jira returned HTTP ${response.status}: ${messages.join(' ')}`
    : `Jira returned HTTP ${response.status}.`;
}

async function fetchJiraSearchPage(config, jql, nextPageToken = null) {
  const searchUrl = integrationService.buildJiraApiUrl(config.baseUrl, '/rest/api/3/search/jql');
  const requestBody = {
    fields: getSearchFields(),
    jql,
    maxResults: JIRA_PAGE_SIZE,
  };

  if (nextPageToken) {
    requestBody.nextPageToken = nextPageToken;
  }

  try {
    for (let attempt = 0; attempt <= JIRA_MAX_RETRIES; attempt += 1) {
      const response = await fetchWithTimeout(searchUrl, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          Authorization: integrationService.buildBasicAuthHeader(config.email, config.apiToken),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
      });
      const payload = await readJsonResponse(response);

      if (response.status === 429 && attempt < JIRA_MAX_RETRIES) {
        const retryAfter = Number(response.headers.get('retry-after') || 0);
        const delayMs = (Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * (attempt + 1));

        await new Promise((resolve) => {
          setTimeout(resolve, delayMs);
        });
        continue;
      }

      if (!response.ok) {
        const error = new Error(getIssueErrorMessage(response, payload));
        error.status = response.status >= 500 ? 502 : 400;
        throw error;
      }

      return payload;
    }

    const error = new Error('Jira rate limit did not clear after retries. Re-run the backfill to continue.');
    error.status = 429;
    throw error;
  } catch (error) {
    if (error.status) {
      throw error;
    }

    const networkError = new Error(getNetworkErrorMessage(error, config.baseUrl));
    networkError.status = 502;
    throw networkError;
  }
}

async function fetchJiraAlertIssues(options = {}) {
  const config = await getJsmOperationsRuntimeConfig();
  const jql = buildJiraAlertIssuesJql(config, options);
  const issues = [];
  let nextPageToken = null;
  let pageCount = 0;

  console.log(`Jira alert import search started. JQL: ${jql}`);

  do {
    const page = await fetchJiraSearchPage(config, jql, nextPageToken);
    const pageIssues = page.issues || [];

    issues.push(...pageIssues);
    nextPageToken = page.nextPageToken || null;
    pageCount += 1;

    if (page.isLast || pageIssues.length === 0) {
      break;
    }
  } while (nextPageToken);

  console.log(`Jira alert issues fetched: ${issues.length} across ${pageCount} page(s).`);

  return {
    config,
    issues,
    jql,
  };
}

async function fetchJiraIncidentIssues(options = {}, configOverride = null) {
  const config = configOverride || await getJsmOperationsRuntimeConfig();
  const jql = options.forceProjectOnly
    ? buildJiraIncidentIssuesJql(config, {
        ...options,
        incidentsJql: buildProjectOnlyIncidentJql(config),
      })
    : buildJiraIncidentIssuesJql(config, options);
  const issues = [];
  let nextPageToken = null;
  let pageCount = 0;

  console.log(`JSM Operations incident import search started. JQL: ${jql}`);

  do {
    const page = await fetchJiraSearchPage(config, jql, nextPageToken);
    const pageIssues = page.issues || [];

    issues.push(...pageIssues);
    nextPageToken = page.nextPageToken || null;
    pageCount += 1;

    if (page.isLast || pageIssues.length === 0) {
      break;
    }
  } while (nextPageToken);

  console.log(`JSM Operations incidents fetched: ${issues.length} across ${pageCount} page(s).`);

  return {
    config,
    issues,
    jql,
  };
}

async function fetchJiraIncidentIssuesWithFallback(options = {}, configOverride = null) {
  const config = configOverride || await getJsmOperationsRuntimeConfig();
  const primaryResult = await fetchJiraIncidentIssues(options, config);

  if (primaryResult.issues.length > 0 || options.forceProjectOnly) {
    return {
      ...primaryResult,
      fallbackUsed: false,
      primaryJql: primaryResult.jql,
    };
  }

  const fallbackResult = await fetchJiraIncidentIssues(
    {
      ...options,
      forceProjectOnly: true,
    },
    config,
  );

  return {
    ...fallbackResult,
    fallbackUsed: fallbackResult.issues.length > 0,
    primaryJql: primaryResult.jql,
  };
}

async function fetchOptionalJiraIncidentIssues(options = {}) {
  try {
    const config = await getJsmOperationsRuntimeConfig();
    const incidentsResult = await fetchJiraIncidentIssues(options, config);
    const fieldLookup = buildIssueFieldLookup(payload, await fetchJiraFieldLookup(config));

    return {
      ...incidentsResult,
      fieldLookup,
    };
  } catch (error) {
    if (error.status && error.status !== 404) {
      console.warn(`Jira incident backfill skipped: ${error.message}`);
      return {
        config: null,
        fieldLookup: buildFieldLookup([]),
        issues: [],
        jql: null,
        error: error.message,
      };
    }

    return {
      config: null,
      fieldLookup: buildFieldLookup([]),
      issues: [],
      jql: null,
      error: error.message,
    };
  }
}

async function getOperationsAlertRuntimeConfig() {
  const config = await getJsmOperationsRuntimeConfig();

  return {
    ...config,
    query: '',
    isEnabled: true,
    authHeader: integrationService.buildBasicAuthHeader(config.email, config.apiToken),
  };
}

function buildJsmOperationsApiUrl(config, path) {
  const normalizedBaseUrl = (config.baseUrl || '')
    .trim()
    .replace(/\/+$/, '');

  if (!normalizedBaseUrl) {
    const error = new Error('Jira site URL is not configured for JSM Operations alert import.');
    error.status = 400;
    throw error;
  }

  return new URL(path, `${normalizedBaseUrl}/`).toString();
}

function buildOperationsAlertListUrlCandidates(config) {
  return [
    '/rest/servicedeskapi/ops/alerts',
    '/rest/servicedeskapi/alerts',
    '/rest/ops/1.0/alerts',
    '/v2/alerts',
  ].map((path) => ({
    path,
    url: buildJsmOperationsApiUrl(config, path),
  }));
}

function buildOperationsAlertDetailUrlCandidates(config, identifier) {
  const encodedIdentifier = encodeURIComponent(identifier.value);

  return [
    {
      path: `/rest/servicedeskapi/ops/alerts/${encodedIdentifier}`,
      url: buildJsmOperationsApiUrl(config, `/rest/servicedeskapi/ops/alerts/${encodedIdentifier}`),
    },
    {
      path: `/rest/servicedeskapi/alerts/${encodedIdentifier}`,
      url: buildJsmOperationsApiUrl(config, `/rest/servicedeskapi/alerts/${encodedIdentifier}`),
    },
    {
      path: `/rest/ops/1.0/alerts/${encodedIdentifier}`,
      url: buildJsmOperationsApiUrl(config, `/rest/ops/1.0/alerts/${encodedIdentifier}`),
    },
    {
      path: `/v2/alerts/${encodedIdentifier}`,
      url: buildJsmOperationsApiUrl(config, `/v2/alerts/${encodedIdentifier}`),
    },
  ];
}

function getOperationsDateRange(options = {}) {
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;

  if (options.range === '1d') {
    return { start: now - dayMs, end: null };
  }

  if (options.range === '1w') {
    return { start: now - 7 * dayMs, end: null };
  }

  if (options.range === '1m') {
    return { start: now - 30 * dayMs, end: null };
  }

  if (options.range === 'custom') {
    const start = options.from ? new Date(`${options.from}T00:00:00.000Z`).getTime() : null;
    const end = options.to ? new Date(`${options.to}T23:59:59.999Z`).getTime() : null;

    return {
      start: Number.isFinite(start) ? start : null,
      end: Number.isFinite(end) ? end : null,
    };
  }

  return { start: null, end: null };
}

function getOperationsAlertTimestamp(alert) {
  const value = alert.createdAt || alert.created_at || alert.receivedAt || alert.updatedAt || alert.updated_at;
  const timestamp = new Date(value || Date.now()).getTime();

  return Number.isFinite(timestamp) ? timestamp : Date.now();
}

function isOperationsAlertInRange(alert, range) {
  const timestamp = getOperationsAlertTimestamp(alert);

  if (range.start && timestamp < range.start) {
    return false;
  }

  if (range.end && timestamp > range.end) {
    return false;
  }

  return true;
}

function shouldStopOperationsPaging(pageAlerts, range) {
  if (!range.start || pageAlerts.length === 0) {
    return false;
  }

  return pageAlerts.every((alert) => getOperationsAlertTimestamp(alert) < range.start);
}

function getOperationsAlertErrorMessage(response, payload) {
  const message = cleanVendorMessage(payload.message || payload.error || payload.raw);

  if (response.status === 401 || response.status === 403) {
    return 'JSM Operations rejected the existing Jira email/API token or the account does not have alert API access.';
  }

  if (response.status === 404) {
    return 'This route is not available from the Jira site REST API.';
  }

  if (response.status === 410) {
    return 'This route has been removed by Atlassian.';
  }

  if (response.status === 400) {
    return message
      ? `JSM Operations rejected the alert query: ${message}`
      : 'JSM Operations rejected the alert query.';
  }

  return message
    ? `JSM Operations returned HTTP ${response.status}: ${message}`
    : `JSM Operations returned HTTP ${response.status}.`;
}

function extractOperationsAlertsFromPayload(payload) {
  if (Array.isArray(payload.data)) {
    return payload.data;
  }

  if (Array.isArray(payload.values)) {
    return payload.values;
  }

  if (Array.isArray(payload.alerts)) {
    return payload.alerts;
  }

  if (Array.isArray(payload.items)) {
    return payload.items;
  }

  if (Array.isArray(payload.results)) {
    return payload.results;
  }

  return [];
}

function hasOperationsAlertCollection(payload) {
  return ['data', 'values', 'alerts', 'items', 'results'].some((field) => Array.isArray(payload[field]));
}

async function fetchOperationsAlertPage(config, query, offset) {
  const candidates = config.operationsAlertListPath
    ? [{ path: config.operationsAlertListPath, url: buildJsmOperationsApiUrl(config, config.operationsAlertListPath) }]
    : buildOperationsAlertListUrlCandidates(config);
  const errors = [];

  try {
    for (const candidate of candidates) {
      const apiUrl = new URL(candidate.url);

      apiUrl.searchParams.set('limit', String(JSM_OPERATIONS_PAGE_SIZE));
      apiUrl.searchParams.set('offset', String(offset));
      apiUrl.searchParams.set('sort', 'createdAt');
      apiUrl.searchParams.set('order', 'desc');

      if (query) {
        apiUrl.searchParams.set('query', query);
      }

      for (let attempt = 0; attempt <= JIRA_MAX_RETRIES; attempt += 1) {
        const response = await fetchWithTimeout(apiUrl.toString(), {
          headers: {
            Accept: 'application/json',
            Authorization: config.authHeader,
          },
        });
        const payload = await readJsonResponse(response);

        if (response.status === 429 && attempt < JIRA_MAX_RETRIES) {
          const retryAfter = Number(response.headers.get('retry-after') || 0);
          const delayMs = (Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * (attempt + 1));

          await new Promise((resolve) => {
            setTimeout(resolve, delayMs);
          });
          continue;
        }

        if (response.ok && hasOperationsAlertCollection(payload)) {
          config.operationsAlertListPath = candidate.path;
          return payload;
        }

        if (response.ok) {
          errors.push(`${candidate.path}: response did not contain an alert collection`);
          break;
        }

        const message = getOperationsAlertErrorMessage(response, payload);
        errors.push(`${candidate.path}: ${message}`);

        if (![404, 405, 410].includes(response.status)) {
          const error = new Error(message);
          error.status = response.status >= 500 ? 502 : 400;
          throw error;
        }

        break;
      }
    }

    const error = new Error(
      'Jira Service Management did not expose #number Operations Alerts through the Jira REST API using the current JIRA_BASE_URL, JIRA_EMAIL, and JIRA_API_TOKEN setup. ACC incidents can still be imported through Jira issue search, but the #number Operations Alerts need an official JSM Operations export/API route from Atlassian or a monitoring-source ingestion path.',
    );
    error.status = 400;
    error.details = errors;
    throw error;
  } catch (error) {
    if (error.status) {
      throw error;
    }

    const networkError = new Error(getNetworkErrorMessage(error, config.baseUrl).replaceAll('Jira', 'JSM Operations'));
    networkError.status = 502;
    throw networkError;
  }
}

function getOperationsAlertIdentifier(alert) {
  if (alert.id) {
    return { value: alert.id, type: 'id' };
  }

  if (alert.tinyId || alert.tiny_id) {
    return { value: alert.tinyId || alert.tiny_id, type: 'tiny' };
  }

  if (alert.alias) {
    return { value: alert.alias, type: 'alias' };
  }

  return { value: null, type: 'id' };
}

async function fetchOperationsAlertDetail(config, alert) {
  const identifier = getOperationsAlertIdentifier(alert);

  if (!identifier.value) {
    return alert;
  }

  try {
    for (const candidate of buildOperationsAlertDetailUrlCandidates(config, identifier)) {
      const apiUrl = new URL(candidate.url);

      apiUrl.searchParams.set('identifierType', identifier.type);

      const response = await fetchWithTimeout(apiUrl.toString(), {
        headers: {
          Accept: 'application/json',
          Authorization: config.authHeader,
        },
      });
      const payload = await readJsonResponse(response);

      if (!response.ok) {
        if ([404, 405, 410].includes(response.status)) {
          continue;
        }

        return {
          ...alert,
          detailFetchError: getOperationsAlertErrorMessage(response, payload),
        };
      }

      return {
        ...alert,
        ...(payload.data || payload),
        listPayload: alert,
      };
    }

    return {
      ...alert,
      detailFetchError: 'JSM Operations detail route was not available through the existing Jira API token.',
    };
  } catch (error) {
    return {
      ...alert,
      detailFetchError: getNetworkErrorMessage(error, config.baseUrl).replaceAll('Jira', 'JSM Operations'),
    };
  }
}

async function enrichOperationsAlerts(config, alerts) {
  const enriched = [];

  for (let index = 0; index < alerts.length; index += JSM_OPERATIONS_DETAIL_BATCH_SIZE) {
    const batch = alerts.slice(index, index + JSM_OPERATIONS_DETAIL_BATCH_SIZE);
    const details = await Promise.all(batch.map((alert) => fetchOperationsAlertDetail(config, alert)));

    enriched.push(...details);
  }

  return enriched;
}

async function fetchOperationsAlerts(options = {}) {
  const config = await getOperationsAlertRuntimeConfig();
  const query = options.query?.trim() || options.jql?.trim() || config.query;
  const range = getOperationsDateRange(options);
  const alerts = [];
  let offset = 0;
  let pageCount = 0;

  console.log(`JSM Operations alert import started. Query: ${query || 'all alerts'}`);

  while (true) {
    const page = await fetchOperationsAlertPage(config, query, offset);
    const pageAlerts = extractOperationsAlertsFromPayload(page);
    const enrichedPageAlerts = await enrichOperationsAlerts(config, pageAlerts);

    alerts.push(...enrichedPageAlerts.filter((alert) => isOperationsAlertInRange(alert, range)));
    pageCount += 1;

    if (
      pageAlerts.length < JSM_OPERATIONS_PAGE_SIZE ||
      shouldStopOperationsPaging(pageAlerts, range)
    ) {
      break;
    }

    offset += pageAlerts.length;
  }

  console.log(`JSM Operations alerts fetched: ${alerts.length} across ${pageCount} page(s).`);

  return {
    config,
    alerts,
    query,
  };
}

function collectIssueText(issue) {
  const fields = issue.fields || {};
  const comments = Array.isArray(fields.comment)
    ? fields.comment
    : fields.comment?.comments || [];
  const components = fields.components || [];
  const labels = fields.labels || [];
  const customText = Object.entries(fields)
    .filter(([key]) => key.startsWith('customfield_'))
    .map(([, value]) => getFieldText(value))
    .filter(Boolean)
    .join(' ');

  return [
    issue.key,
    fields.summary,
    getFieldText(fields.description),
    getFieldText(fields.environment),
    getFieldText(issue.renderedFields?.description),
    getFieldText(issue.renderedFields?.environment),
    labels.join(' '),
    components.map((component) => component.name).join(' '),
    comments.map((comment) => getFieldText(comment.body)).join(' '),
    customText,
  ].filter(Boolean).join(' ');
}

function detectSourceTool(text) {
  const normalized = text.toLowerCase();

  if (normalized.includes('splunk appdynamics')) {
    return 'Splunk AppDynamics';
  }

  if (normalized.includes('appdynamics') || normalized.includes('app dynamics') || normalized.includes('appd')) {
    return 'AppDynamics';
  }

  if (normalized.includes('thousandeyes') || normalized.includes('thousand eyes')) {
    return 'ThousandEyes';
  }

  if (normalized.includes('grafana')) {
    return 'Grafana';
  }

  if (normalized.includes('slack')) {
    return 'Slack';
  }

  return 'Jira';
}

function detectEnvironment(text) {
  const normalized = text.toLowerCase();

  if (/\b(prod|production)\b/.test(normalized)) {
    return 'production';
  }

  if (/\bstag(e|ing)?\b/.test(normalized)) {
    return 'staging';
  }

  if (/\b(dev|development)\b/.test(normalized)) {
    return 'development';
  }

  if (/\b(test|qa)\b/.test(normalized)) {
    return 'staging';
  }

  return 'unknown';
}

function detectSeverity(text, priority) {
  const normalized = text.toLowerCase();
  const priorityText = String(priority || '').toLowerCase();
  const combined = `${normalized} ${priorityText}`;

  if (/\b(critical|sev1|p1|highest|blocker)\b/.test(combined)) {
    return 'critical';
  }

  if (/\b(high|sev2|p2)\b/.test(combined)) {
    return 'high';
  }

  if (/\b(medium|sev3|p3|major)\b/.test(combined)) {
    return 'medium';
  }

  if (/\b(warning|warn)\b/.test(combined)) {
    return 'warning';
  }

  if (/\b(low|sev4|p4|minor|info|informational)\b/.test(combined)) {
    return 'low';
  }

  return 'medium';
}

function detectService(issue, text) {
  const fields = issue.fields || {};
  const componentName = fields.components?.[0]?.name;
  const servicePattern = text.match(/\b(?:service|application|app)\s*[:=]\s*([a-zA-Z0-9._/-]+)/i);

  return servicePattern?.[1] || componentName || fields.project?.name || 'Unknown';
}

function detectOccurrences(text) {
  const match = text.match(/\b(?:occurrences?|repeated|seen|happened)\s*[:=]?\s*(\d+)\b/i)
    || text.match(/\b(\d+)\s*(?:times|occurrences?)\b/i);

  return match ? Math.max(Number(match[1]), 1) : 1;
}

function detectRelatedAlerts(text) {
  const matches = text.match(/\b(?:ALRT|DEMO|GRAFANA|SLACK|JIRA|INC|OPS|ACC)-[A-Z0-9-]+\b/gi) || [];

  return [...new Set(matches.map((match) => match.toUpperCase()))].slice(0, 12);
}

function detectCorrelationId(text, issue) {
  const match = text.match(/\b(?:correlation[_ -]?id|correlation|trace[_ -]?id|request[_ -]?id|incident[_ -]?id)\s*[:=]\s*([a-zA-Z0-9._:/-]+)/i);

  return match?.[1] || issue.fields?.parent?.key || issue.key || '';
}

function buildDuplicateSignature(alert) {
  return crypto
    .createHash('sha1')
    .update([
      alert.source,
      alert.service,
      alert.environment,
      alert.severity,
      alert.title,
    ].map((value) => String(value || '').trim().toLowerCase()).join('|'))
    .digest('hex');
}

function mapJiraUser(user) {
  if (!user) {
    return null;
  }

  return {
    accountId: user.accountId || '',
    displayName: user.displayName || '',
    emailAddress: user.emailAddress || '',
    active: user.active ?? null,
  };
}

function emptyToNull(value) {
  if (value === undefined || value === '') {
    return null;
  }

  return value;
}

function uniqueValues(values) {
  return [...new Set(values.filter(Boolean))];
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeFieldName(value) {
  return jiraFieldMapper.normalizeFieldName(value);
}

function buildFieldLookup(fields = []) {
  return jiraFieldMapper.buildFieldLookup(fields);
}

function buildIssueFieldLookup(issuePayload = {}, baseLookup = buildFieldLookup([])) {
  const issueFields = Object.entries(issuePayload.names || {}).map(([id, name]) => ({
    id,
    name,
    schema: issuePayload.schema?.[id] || null,
  }));
  const issueLookup = buildFieldLookup(issueFields);

  return {
    byId: {
      ...issueLookup.byId,
      ...baseLookup.byId,
    },
    byName: {
      ...issueLookup.byName,
      ...baseLookup.byName,
    },
  };
}

async function fetchJiraFieldLookup(config) {
  const cacheKey = [
    config.baseUrl,
    config.email,
  ].filter(Boolean).join('|');

  if (
    jiraFieldLookupCache
    && jiraFieldLookupCache.cacheKey === cacheKey
    && Date.now() - jiraFieldLookupCache.loadedAt < JIRA_FIELD_CACHE_MS
  ) {
    return jiraFieldLookupCache.lookup;
  }

  const fieldUrl = integrationService.buildJiraApiUrl(config.baseUrl, '/rest/api/3/field');

  try {
    const response = await fetchWithTimeout(fieldUrl, {
      headers: {
        Accept: 'application/json',
        Authorization: integrationService.buildBasicAuthHeader(config.email, config.apiToken),
      },
    });
    const payload = await readJsonResponse(response);

    if (!response.ok || !Array.isArray(payload)) {
      console.warn('Jira field metadata could not be loaded. Custom fields will be preserved by id.');
      return buildFieldLookup([]);
    }

    const lookup = buildFieldLookup(payload);

    jiraFieldLookupCache = {
      cacheKey,
      loadedAt: Date.now(),
      lookup,
    };

    return lookup;
  } catch (error) {
    console.warn(`Jira field metadata lookup skipped: ${error.message}`);
    return buildFieldLookup([]);
  }
}

function getCustomFieldValue(fields, fieldLookup = buildFieldLookup([]), names = []) {
  for (const name of names) {
    const fieldId = fieldLookup.byName?.[normalizeFieldName(name)];

    if (fieldId && fields[fieldId] !== undefined && fields[fieldId] !== null) {
      return getFieldText(fields[fieldId]) || fields[fieldId];
    }
  }

  const normalizedNames = names.map(normalizeFieldName);
  const match = Object.entries(fields)
    .filter(([key]) => key.startsWith('customfield_'))
    .find(([key]) => {
      const fieldName = fieldLookup.byId?.[key]?.name;

      return fieldName && normalizedNames.includes(normalizeFieldName(fieldName));
    });

  if (match) {
    return getFieldText(match[1]) || match[1];
  }

  return null;
}

function getLabelledValue(text, names = []) {
  for (const name of names) {
    const pattern = new RegExp(`(?:^|\\n|\\b)${escapeRegExp(name)}\\s*[:=-]\\s*([^\\n|]+)`, 'i');
    const match = String(text || '').match(pattern);

    if (match?.[1]) {
      return match[1].trim();
    }
  }

  return null;
}

function getIssueDetail(fields, fieldLookup, names, text) {
  return emptyToNull(
    getCustomFieldValue(fields, fieldLookup, names)
      || getLabelledValue(text, names),
  );
}

function splitListValue(value) {
  if (!value) {
    return [];
  }

  if (Array.isArray(value)) {
    return uniqueValues(value.map((item) => getFieldText(item) || item).filter(Boolean).map(String));
  }

  if (typeof value === 'object') {
    const text = getFieldText(value);

    return text ? splitListValue(text) : [];
  }

  return uniqueValues(
    String(value)
      .split(/[,;\n|]+/)
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

function getFirstUrlByPattern(text, pattern) {
  return getUrlCandidates(text).find((url) => pattern.test(url)) || null;
}

function formatDurationMs(durationMs) {
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    return null;
  }

  const minutes = Math.floor(durationMs / 60000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    return `${days}d ${hours % 24}h`;
  }

  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  }

  return `${Math.max(minutes, 1)}m`;
}

function deriveElapsedTime(start, end) {
  const startMs = new Date(start || '').getTime();
  const endMs = new Date(end || '').getTime();

  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    return null;
  }

  return formatDurationMs(endMs - startMs);
}

function getRuntimeTimezone() {
  return process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

function getObjectValueByNames(object, names = []) {
  if (!object || typeof object !== 'object') {
    return null;
  }

  const entries = Object.entries(object).map(([key, value]) => [
    normalizeFieldName(key),
    value,
  ]);

  for (const name of names) {
    const match = entries.find(([key]) => key === normalizeFieldName(name));

    if (match) {
      return getFieldText(match[1]) || match[1];
    }
  }

  return null;
}

function getUrlCandidates(text) {
  return uniqueValues(String(text || '').match(/https?:\/\/[^\s)>,"]+/gi) || []);
}

function detectDeepEventLink(text, fields, sourceUrl) {
  const urls = getUrlCandidates(text);
  const preferred = urls.find((url) => (
    /grafana|thousandeyes|appd|appdynamics|nagios|splunk|monitor|alert|event/i.test(url)
  ));

  return preferred || urls[0] || fields.customfield_10000?.self || sourceUrl || null;
}

function detectAlertIdentifiers(text, issueKey) {
  const ids = [
    ...(text.match(/\b(?:alert[_ -]?id|event[_ -]?id|problem[_ -]?id|monitor[_ -]?id)\s*[:=]\s*([a-zA-Z0-9._:/-]+)/gi) || [])
      .map((match) => match.split(/[:=]/).slice(1).join('=').trim()),
    ...detectRelatedAlerts(text),
    issueKey,
  ];

  return uniqueValues(ids).slice(0, 20);
}

function detectDuplicateReferences(text) {
  const duplicatePattern = /\b(?:duplicate(?:s)?|dupe|dedupe|same as|repeated)\b[^.\n]*/gi;

  return uniqueValues(text.match(duplicatePattern) || []).slice(0, 12);
}

function detectIncidentReferences(text) {
  const matches = text.match(/\b(?:INC|OPS|ACC)-[A-Z0-9-]+\b/gi) || [];

  return uniqueValues(matches.map((match) => match.toUpperCase())).slice(0, 20);
}

function detectNotesByKeywords(comments, description, keywords) {
  const textBlocks = [
    description,
    ...comments.map((comment) => comment.body),
  ].filter(Boolean);

  return textBlocks
    .filter((text) => keywords.some((keyword) => String(text).toLowerCase().includes(keyword)))
    .map((text) => String(text).trim())
    .slice(0, 8);
}

function detectAssignedTeam(fields, text) {
  const component = fields.components?.[0]?.name;
  const labelTeam = (fields.labels || []).find((label) => /^team[-_:]/i.test(label));
  const textTeam = text.match(/\b(?:team|owner|assigned[_ -]?team)\s*[:=]\s*([a-zA-Z0-9._ /-]+)/i)?.[1];

  return emptyToNull(textTeam || labelTeam?.replace(/^team[-_:]/i, '') || component);
}

function mapIssueReference(issue, config) {
  if (!issue) {
    return null;
  }

  const fields = issue.fields || {};
  const key = issue.key || '';

  return {
    issue_key: key || null,
    summary: fields.summary || null,
    status: fields.status?.name || null,
    priority: fields.priority?.name || null,
    issue_type: fields.issuetype?.name || null,
    url: key ? `${config.baseUrl.replace(/\/+$/, '')}/browse/${key}` : null,
    raw: issue,
  };
}

function mapParentIssue(fields, config) {
  return mapIssueReference(fields.parent, config);
}

function mapSubtasks(fields, config) {
  return (fields.subtasks || [])
    .map((subtask) => mapIssueReference(subtask, config))
    .filter(Boolean);
}

function getStatusState(status, statusCategoryName, resolutionDate) {
  const category = String(statusCategoryName || '').toLowerCase();
  const normalizedStatus = String(status || '').toLowerCase();

  if (
    category === 'done' ||
    resolutionDate ||
    normalizedStatus.includes('closed') ||
    normalizedStatus.includes('done') ||
    normalizedStatus.includes('resolved')
  ) {
    return 'closed';
  }

  return 'open';
}

function buildReasonCodes({ alert, fields, sourceTool, duplicateCount, deepEventLink, linkedIncidentKey }) {
  return [
    'source=JSM_Operations_Alerts',
    `jira_status=${fields.status?.name || 'unknown'}`,
    `jira_state=${getStatusState(fields.status?.name, fields.status?.statusCategory?.name, fields.resolutiondate)}`,
    `priority=${fields.priority?.name || 'unknown'}`,
    `severity=${alert.severity}`,
    `source_tool=${sourceTool || 'unknown'}`,
    `deep_event_link_found=${Boolean(deepEventLink)}`,
    `incident_link_found=${Boolean(linkedIncidentKey)}`,
    linkedIncidentKey ? `jira_incident_key=${linkedIncidentKey}` : null,
    `duplicate_count=${duplicateCount}`,
    alert.environment ? `environment=${alert.environment}` : null,
  ].filter(Boolean);
}

function classifyJiraAlertRecord({ alert, fields, text, duplicateCount, deepEventLink, linkedIncidentKey }) {
  const state = getStatusState(fields.status?.name, fields.status?.statusCategory?.name, fields.resolutiondate);
  const priority = String(fields.priority?.name || '').toLowerCase();
  const status = String(fields.status?.name || '').toLowerCase();
  const lowSignal = /\b(info only|informational|no action|non-actionable|test alert|false positive)\b/i.test(text);
  const autoResolved = state === 'closed' && /\b(auto[- ]?resolved|recovered|self[- ]?resolved|resolved automatically)\b/i.test(text);
  const repetitive = duplicateCount >= 3 || /\b(duplicate|repeated|flapping|same as)\b/i.test(text);
  const highPriority = ['highest', 'high', 'critical', 'blocker', 'major'].some((item) => priority.includes(item));
  const active = state === 'open' || ['open', 'in progress', 'investigating', 'acknowledged'].some((item) => status.includes(item));
  const sourceTool = alert.source || 'unknown';
  const reasonCodes = buildReasonCodes({
    alert,
    fields,
    sourceTool,
    duplicateCount,
    deepEventLink,
    linkedIncidentKey,
  });

  if (linkedIncidentKey) {
    return {
      classification: 'incident',
      confidenceScore: active && (highPriority || ['critical', 'high'].includes(alert.severity)) ? 94 : 88,
      noiseType: 'none',
      noiseReason: null,
      reasonCodes,
      justification: `The alert came from JSM Operations Alerts, is ${fields.priority?.name || alert.severity || 'unknown'} priority/severity, is ${state}, and is linked to incident ${linkedIncidentKey}. It represents incident history and should stay searchable as an incident-backed alert.`,
      recommendedAction: active
        ? 'Review the linked Operations incident and continue the incident workflow'
        : 'Keep as historical incident evidence and use it for future pattern matching',
      reviewStatus: 'classified',
    };
  }

  if ((autoResolved || lowSignal || repetitive) && !active) {
    return {
      classification: 'noise',
      confidenceScore: repetitive ? 88 : 84,
      noiseType: repetitive ? 'duplicate' : autoResolved ? 'auto-resolved' : 'non-actionable',
      noiseReason: repetitive
        ? 'Jira history shows duplicate or repetitive alert language.'
        : autoResolved
          ? 'Jira history shows the alert recovered or auto-resolved before active incident work was needed.'
          : 'Jira history shows low-signal or non-actionable language.',
      reasonCodes,
      justification: `This Jira alert is ${state}, associated with ${sourceTool}, and appears ${repetitive ? 'duplicate/repetitive' : autoResolved ? 'auto-resolved' : 'non-actionable'}. It should be treated as noise for reduction analysis.`,
      recommendedAction: repetitive
        ? 'Group with the related alert pattern and tune duplicate suppression'
        : 'Keep for history and monitor for recurrence',
      reviewStatus: 'classified',
    };
  }

  if (active && (highPriority || ['critical', 'high'].includes(alert.severity))) {
    return {
      classification: 'incident',
      confidenceScore: highPriority ? 93 : 88,
      noiseType: 'none',
      noiseReason: null,
      reasonCodes,
      justification: `This Jira alert is ${state}, ${fields.priority?.name || alert.severity} priority/severity, and associated with ${sourceTool}. It should be treated as an actionable incident.`,
      recommendedAction: 'Review and continue incident workflow',
      reviewStatus: 'classified',
    };
  }

  if (active && deepEventLink) {
    return {
      classification: 'incident',
      confidenceScore: 78,
      noiseType: 'none',
      noiseReason: null,
      reasonCodes,
      justification: `This Jira alert is still ${state} and has a linked monitoring event from ${sourceTool}. It needs operator review before suppression.`,
      recommendedAction: 'Review linked event and decide incident ownership',
      reviewStatus: 'review_required',
    };
  }

  return {
    classification: 'needs_review',
    confidenceScore: 58,
    noiseType: 'none',
    noiseReason: null,
    reasonCodes,
    justification: `This Jira alert has incomplete or ambiguous context. It is ${state}, associated with ${sourceTool}, and does not strongly match an incident or noise rule.`,
    recommendedAction: 'Review Jira fields, comments, and linked events before deciding',
    reviewStatus: 'needs_review',
  };
}

function buildOperationsReasonCodes({ alert, rawAlert, duplicateCount }) {
  return [
    `operations_status=${rawAlert.status || alert.status || 'unknown'}`,
    `priority=${rawAlert.priority || 'unknown'}`,
    `severity=${alert.severity}`,
    `source_tool=${alert.source || 'JSM Operations'}`,
    `source_type=${alert.source_type || 'jira_operations_alert'}`,
    rawAlert.tinyId || rawAlert.tiny_id ? `tiny_id=${rawAlert.tinyId || rawAlert.tiny_id}` : null,
    alert.environment ? `environment=${alert.environment}` : null,
    `duplicate_count=${duplicateCount}`,
    `acc_incident_linked=${Boolean(alert.jira_ticket_id)}`,
  ].filter(Boolean);
}

function classifyOperationsAlertRecord({ alert, rawAlert, text, duplicateCount }) {
  const status = String(rawAlert.status || alert.status || '').toLowerCase();
  const priority = String(rawAlert.priority || '').toLowerCase();
  const active = ['open', 'firing', 'triggered', 'acknowledged', 'investigating'].some((item) => status.includes(item))
    || ['open', 'firing', 'triggered', 'investigating'].includes(alert.status);
  const resolved = ['closed', 'resolved', 'recovered'].some((item) => status.includes(item))
    || ['resolved', 'recovered', 'auto-resolved'].includes(alert.status);
  const highPriority = ['p1', 'p2'].includes(priority) || ['critical', 'high'].includes(alert.severity);
  const lowSignal = /\b(info only|informational|no action|non-actionable|test alert|false positive|maintenance)\b/i.test(text);
  const repetitive = duplicateCount >= 3 || Number(alert.occurrences || 1) >= 3 || /\b(duplicate|repeated|flapping|same as)\b/i.test(text);
  const reasonCodes = buildOperationsReasonCodes({
    alert,
    rawAlert,
    duplicateCount,
  });

  if (resolved) {
    return {
      classification: 'noise',
      confidenceScore: 86,
      noiseType: 'auto-resolved',
      noiseReason: 'JSM Operations shows the source alert is already closed or recovered.',
      reasonCodes,
      justification: 'This Operations alert is stored in the backend and marked as noise because the source status is resolved/recovered before ACC incident creation is needed.',
      recommendedAction: 'Keep the alert for history and recurrence analysis; do not create an ACC incident.',
      reviewStatus: 'classified',
    };
  }

  if (lowSignal) {
    return {
      classification: 'noise',
      confidenceScore: 82,
      noiseType: 'non-actionable',
      noiseReason: 'The alert text indicates informational, maintenance, test, false-positive, or no-action context.',
      reasonCodes,
      justification: 'This Operations alert is stored in the backend and classified as non-actionable noise based on the alert message/details.',
      recommendedAction: 'Suppress or route to low-priority review; do not create an ACC incident.',
      reviewStatus: 'classified',
    };
  }

  if (repetitive && !highPriority) {
    return {
      classification: 'noise',
      confidenceScore: 88,
      noiseType: 'duplicate',
      noiseReason: 'The backend found repeated matching alerts for the same source/service/severity pattern.',
      reasonCodes,
      justification: 'This Operations alert is stored in the backend and classified as duplicate/repetitive noise because matching alerts already exist for the same signal pattern.',
      recommendedAction: 'Group this alert with the existing duplicate pattern and tune suppression rules.',
      reviewStatus: 'classified',
    };
  }

  if (active && highPriority) {
    return {
      classification: 'incident',
      confidenceScore: priority === 'p1' || alert.severity === 'critical' ? 94 : 89,
      noiseType: 'none',
      noiseReason: null,
      reasonCodes,
      justification: 'This Operations alert is stored in the backend and classified as an incident because it is active and has high priority/severity. ACC should be used only now as the incident destination.',
      recommendedAction: 'Create or link an ACC incident and assign the service owner.',
      reviewStatus: 'classified',
    };
  }

  if (active) {
    return {
      classification: 'needs_review',
      confidenceScore: 64,
      noiseType: 'none',
      noiseReason: null,
      reasonCodes,
      justification: 'This Operations alert is active, but priority/severity and history are not strong enough to classify it automatically as incident or noise.',
      recommendedAction: 'Review source details, duplicate history, and service impact before creating an ACC incident.',
      reviewStatus: 'needs_review',
    };
  }

  return {
    classification: 'needs_review',
    confidenceScore: 58,
    noiseType: 'none',
    noiseReason: null,
    reasonCodes,
    justification: 'This Operations alert has been stored, but the source evidence is ambiguous. It needs review before suppression or incident creation.',
    recommendedAction: 'Review the raw Operations alert details and related history.',
    reviewStatus: 'needs_review',
  };
}

function mapJiraComment(comment) {
  return {
    id: comment.id || '',
    author: mapJiraUser(comment.author),
    body: getFieldText(comment.body),
    created: comment.created || '',
    updated: comment.updated || '',
    visibility: comment.visibility || null,
    raw: comment,
    raw_payload: comment,
  };
}

function mapComments(fields) {
  const comments = Array.isArray(fields.comment)
    ? fields.comment
    : fields.comment?.comments || [];

  return comments.map(mapJiraComment);
}

function mapChangelogItem(item = {}) {
  return {
    field: item.field || '',
    fieldId: item.fieldId || '',
    fieldType: item.fieldtype || '',
    from: item.from || null,
    fromString: item.fromString || null,
    to: item.to || null,
    toString: item.toString || null,
    raw: item,
  };
}

function mapChangelogHistory(history = {}) {
  return {
    id: history.id || '',
    author: mapJiraUser(history.author),
    created: history.created || '',
    items: (history.items || []).map(mapChangelogItem),
    raw: history,
  };
}

function getChangelogMatches(histories = [], predicate) {
  return histories
    .flatMap((history) => (
      history.items
        .filter(predicate)
        .map((item) => ({
          created: history.created,
          author: history.author,
          field: item.field,
          from: item.fromString || item.from,
          to: item.toString || item.to,
          raw: item.raw,
        }))
    ));
}

function summarizeChangelog(histories = []) {
  const isStatus = (item) => String(item.field || '').toLowerCase() === 'status';
  const isAssignee = (item) => String(item.field || '').toLowerCase() === 'assignee';
  const isPriority = (item) => String(item.field || '').toLowerCase() === 'priority';
  const isAcknowledgement = (item) => {
    const text = [
      item.field,
      item.fromString,
      item.toString,
    ].filter(Boolean).join(' ').toLowerCase();

    return /acknowledg|acknowledged|responder/.test(text);
  };

  return {
    status_changes: getChangelogMatches(histories, isStatus),
    assignee_changes: getChangelogMatches(histories, isAssignee),
    priority_changes: getChangelogMatches(histories, isPriority),
    acknowledgement_updates: getChangelogMatches(histories, isAcknowledgement),
  };
}

function getLinkedIssue(link) {
  if (link.outwardIssue) {
    return {
      direction: 'outward',
      issue: link.outwardIssue,
      relationship: link.type?.outward || link.type?.name || '',
    };
  }

  if (link.inwardIssue) {
    return {
      direction: 'inward',
      issue: link.inwardIssue,
      relationship: link.type?.inward || link.type?.name || '',
    };
  }

  return {
    direction: '',
    issue: null,
    relationship: link.type?.name || '',
  };
}

function mapLinkedIssues(fields, config) {
  return (fields.issuelinks || []).map((link) => {
    const linked = getLinkedIssue(link);
    const linkedFields = linked.issue?.fields || {};
    const key = linked.issue?.key || '';

    return {
      id: link.id || '',
      direction: linked.direction,
      relationship: linked.relationship,
      issue_key: key,
      summary: linkedFields.summary || '',
      status: linkedFields.status?.name || '',
      priority: linkedFields.priority?.name || '',
      url: key ? `${config.baseUrl.replace(/\/+$/, '')}/browse/${key}` : '',
      raw: link,
    };
  });
}

function mapAttachments(fields) {
  return (fields.attachment || []).map((attachment) => ({
    id: attachment.id || '',
    filename: attachment.filename || '',
    mimeType: attachment.mimeType || '',
    size: attachment.size || 0,
    created: attachment.created || '',
    author: mapJiraUser(attachment.author),
    content: attachment.content || '',
    thumbnail: attachment.thumbnail || '',
    raw: attachment,
  }));
}

function mapCustomFields(fields, fieldLookup = buildFieldLookup([])) {
  return jiraFieldMapper.mapCustomFields(fields, fieldLookup, getFieldText);
}

function buildClassificationSchema(alert, decision = {}) {
  if (!decision.classification && alert.classification === 'unclassified') {
    return notEvaluatedMetadata();
  }

  const confidence = decision.confidence ?? (
    Number.isFinite(Number(alert.confidenceScore)) ? Number(alert.confidenceScore) / 100 : null
  );

  return {
    label: decision.classification || alert.classification || 'unclassified',
    confidence,
    justification: decision.justification || alert.classificationReason || null,
    reason_codes: decision.reason_codes || [],
    recommended_action: decision.recommended_action || null,
  };
}

function buildAlertSchemaFromIssue({
  issue,
  config,
  alert,
  text,
  fieldLookup,
  deepEventLink,
  duplicateReferences,
  tags,
}) {
  const fields = issue.fields || {};
  const integration = getIssueDetail(fields, fieldLookup, ['Integration', 'Monitoring Integration', 'Source Integration'], text)
    || detectSourceTool(text);
  const alias = getIssueDetail(fields, fieldLookup, ['Alias', 'Alert Alias', 'Deduplication Alias'], text)
    || issue.key
    || alert.sourceAlertId;
  const entity = getIssueDetail(fields, fieldLookup, ['Entity', 'Affected Entity', 'Object', 'Affected Object'], text)
    || alert.service;
  const controllerUrl = getIssueDetail(fields, fieldLookup, ['Controller URL', 'Controller Url', 'Controller'], text)
    || getFirstUrlByPattern(text, /controller|appdynamics|appd/i);
  const healthRuleId = getIssueDetail(fields, fieldLookup, ['Health Rule ID', 'Health Rule Id', 'Health Rule'], text);
  const lastDuplicatedAt = getIssueDetail(fields, fieldLookup, ['Last duplicated', 'Last duplicated at', 'Last duplicate'], text);
  const responders = splitListValue(
    getIssueDetail(fields, fieldLookup, ['Responders', 'Responder', 'People involved'], text),
  );
  const assignee = mapJiraUser(fields.assignee)?.displayName || alert.owner || null;
  const duplicateCount = duplicateReferences.length || alert.occurrences || 1;
  const createdAt = fields.created || alert.receivedAt || null;
  const updatedAt = fields.updated || alert.lastSeenAt || null;
  const timezone = getIssueDetail(fields, fieldLookup, ['Timezone', 'Time zone'], text) || getRuntimeTimezone();
  const deduplication = {
    is_duplicate: duplicateCount > 1 || Boolean(lastDuplicatedAt),
    duplicate_count: duplicateCount,
    duplicate_group_id: alert.duplicateSignature || null,
    last_duplicated_at: lastDuplicatedAt || null,
  };
  const extraProperties = {
    controller_url: controllerUrl || null,
    entity: entity || null,
    event_deep_link: deepEventLink || alert.sourceUrl || null,
    health_rule_id: healthRuleId || null,
  };

  return {
    alert_id: alert.id,
    summary: fields.summary || alert.title,
    source: alert.source,
    integration,
    alias,
    entity,
    event_deep_link: deepEventLink || alert.sourceUrl || null,
    controller_url: controllerUrl || null,
    health_rule_id: healthRuleId || null,
    tags,
    deduplication,
    people: {
      assignee,
      responders,
    },
    timings: {
      elapsed_time: getIssueDetail(fields, fieldLookup, ['Elapsed time', 'Elapsed Time'], text)
        || deriveElapsedTime(createdAt, updatedAt),
      created_at: createdAt,
      last_updated_at: updatedAt,
      last_duplicated_at: lastDuplicatedAt || null,
      timezone,
    },
    details: {
      source: alert.source,
      integration,
      alias,
      tags,
      deduplication,
    },
    extra_properties: extraProperties,
    raw_payload: issue,
    classification: buildClassificationSchema(alert),
    jira_incident_key: alert.jiraTicketId || null,
    status: alert.status,
    severity: alert.severity,
    priority: fields.priority?.name || null,
    created_at: createdAt,
    updated_at: updatedAt,
  };
}

function buildAlertSchemaFromOperationsAlert({ alert: rawAlert, normalizedAlert, text, deepEventLink, tags }) {
  const integration = rawAlert.integration?.name
    || getObjectValueByNames(rawAlert.details, ['Integration'])
    || getObjectValueByNames(rawAlert.extraProperties, ['Integration'])
    || rawAlert.source
    || normalizedAlert.source;
  const alias = rawAlert.alias || getOperationsSourceAlertId(rawAlert) || normalizedAlert.sourceAlertId || normalizedAlert.id;
  const entity = rawAlert.entity
    || getObjectValueByNames(rawAlert.details, ['Entity'])
    || getObjectValueByNames(rawAlert.extraProperties, ['Entity'])
    || normalizedAlert.service;
  const controllerUrl = getObjectValueByNames(rawAlert.extraProperties, ['Controller URL', 'Controller'])
    || getObjectValueByNames(rawAlert.details, ['Controller URL', 'Controller'])
    || getFirstUrlByPattern(text, /controller|appdynamics|appd/i);
  const healthRuleId = getObjectValueByNames(rawAlert.extraProperties, ['Health Rule ID', 'Health Rule'])
    || getObjectValueByNames(rawAlert.details, ['Health Rule ID', 'Health Rule']);
  const lastDuplicatedAt = rawAlert.lastDuplicatedAt
    || getObjectValueByNames(rawAlert.details, ['Last duplicated', 'Last duplicate'])
    || getObjectValueByNames(rawAlert.extraProperties, ['Last duplicated', 'Last duplicate']);
  const responders = splitListValue(rawAlert.responders || rawAlert.teams || []);
  const deduplication = {
    is_duplicate: Number(normalizedAlert.occurrences || 1) > 1 || Boolean(lastDuplicatedAt),
    duplicate_count: normalizedAlert.occurrences || 1,
    duplicate_group_id: normalizedAlert.duplicateSignature || null,
    last_duplicated_at: lastDuplicatedAt || null,
  };

  return {
    alert_id: normalizedAlert.id,
    summary: normalizedAlert.title,
    source: normalizedAlert.source,
    integration,
    alias,
    entity,
    event_deep_link: deepEventLink || normalizedAlert.sourceUrl || null,
    controller_url: controllerUrl || null,
    health_rule_id: healthRuleId || null,
    tags,
    deduplication,
    people: {
      assignee: normalizedAlert.owner,
      responders,
    },
    timings: {
      elapsed_time: deriveElapsedTime(normalizedAlert.receivedAt, normalizedAlert.lastSeenAt),
      created_at: normalizedAlert.receivedAt,
      last_updated_at: normalizedAlert.lastSeenAt,
      last_duplicated_at: lastDuplicatedAt || null,
      timezone: getRuntimeTimezone(),
    },
    details: {
      source: rawAlert.source || normalizedAlert.source,
      integration,
      alias,
      tags,
      deduplication,
    },
    extra_properties: {
      controller_url: controllerUrl || null,
      entity: entity || null,
      event_deep_link: deepEventLink || normalizedAlert.sourceUrl || null,
      health_rule_id: healthRuleId || null,
    },
    raw_payload: rawAlert,
    classification: buildClassificationSchema(normalizedAlert),
    jira_incident_key: normalizedAlert.jiraTicketId || null,
    status: normalizedAlert.status,
    severity: normalizedAlert.severity,
    priority: rawAlert.priority || null,
    created_at: normalizedAlert.receivedAt,
    updated_at: normalizedAlert.lastSeenAt,
  };
}

function getIssueUrl(config, issueKey) {
  return issueKey ? `${config.baseUrl.replace(/\/+$/, '')}/browse/${issueKey}` : null;
}

async function fetchJiraJson(config, path, searchParams = {}) {
  const apiUrl = integrationService.buildJiraApiUrl(config.baseUrl, path);
  const url = new URL(apiUrl);

  Object.entries(searchParams)
    .filter(([, value]) => value !== null && value !== undefined && value !== '')
    .forEach(([key, value]) => {
      url.searchParams.set(key, String(value));
    });

  const response = await fetchWithTimeout(url.toString(), {
    headers: {
      Accept: 'application/json',
      Authorization: integrationService.buildBasicAuthHeader(config.email, config.apiToken),
    },
  });
  const payload = await readJsonResponse(response);

  if (!response.ok) {
    const error = new Error(getIssueErrorMessage(response, payload));
    error.status = response.status;
    error.payload = payload;
    throw error;
  }

  return payload;
}

async function fetchIssueComments(config, issueKey) {
  const comments = [];
  const rawPages = [];
  let startAt = 0;

  while (true) {
    const page = await fetchJiraJson(
      config,
      `/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment`,
      {
        startAt,
        maxResults: 100,
        orderBy: 'created',
      },
    );
    const pageComments = page.comments || page.values || [];

    rawPages.push(page);
    comments.push(...pageComments.map(mapJiraComment));

    const maxResults = Number(page.maxResults || pageComments.length || 0);
    const total = Number(page.total || comments.length);

    if (pageComments.length === 0 || comments.length >= total || page.isLast) {
      break;
    }

    startAt += maxResults || pageComments.length;
  }

  return {
    comments,
    rawPages,
  };
}

async function fetchIssueChangelog(config, issueKey) {
  const histories = [];
  const rawPages = [];
  let startAt = 0;

  while (true) {
    const page = await fetchJiraJson(
      config,
      `/rest/api/3/issue/${encodeURIComponent(issueKey)}/changelog`,
      {
        startAt,
        maxResults: 100,
      },
    );
    const pageHistories = page.values || page.histories || [];

    rawPages.push(page);
    histories.push(...pageHistories.map(mapChangelogHistory));

    const maxResults = Number(page.maxResults || pageHistories.length || 0);
    const total = Number(page.total || histories.length);

    if (pageHistories.length === 0 || histories.length >= total || page.isLast) {
      break;
    }

    startAt += maxResults || pageHistories.length;
  }

  return {
    histories,
    rawPages,
  };
}

async function fetchOptionalJiraCollection(label, fetcher) {
  try {
    return {
      ...(await fetcher()),
      error: null,
    };
  } catch (error) {
    console.warn(`Jira ${label} enrichment skipped: ${error.message}`);
    return {
      comments: [],
      histories: [],
      rawPages: [],
      error: error.message,
    };
  }
}

async function getIssueDetails(issueKey) {
  const normalizedIssueKey = String(issueKey || '').trim().toUpperCase();

  if (!/^[A-Z][A-Z0-9]+-\d+$/.test(normalizedIssueKey)) {
    return null;
  }

  const config = await getJiraRuntimeConfig();
  const issueUrl = integrationService.buildJiraApiUrl(
    config.baseUrl,
    `/rest/api/3/issue/${encodeURIComponent(normalizedIssueKey)}`,
  );
  const url = new URL(issueUrl);
  url.searchParams.set('fields', getSearchFields().join(','));
  url.searchParams.set('expand', 'names,schema,renderedFields');

  try {
    const response = await fetchWithTimeout(url.toString(), {
      headers: {
        Accept: 'application/json',
        Authorization: integrationService.buildBasicAuthHeader(config.email, config.apiToken),
      },
    });
    const payload = await readJsonResponse(response);

    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      const error = new Error(getIssueErrorMessage(response, payload));
      error.status = response.status;
      throw error;
    }

    const fieldLookup = await fetchJiraFieldLookup(config);
    const commentsResult = await fetchOptionalJiraCollection(
      'comments',
      () => fetchIssueComments(config, payload.key || normalizedIssueKey),
    );
    const changelogResult = await fetchOptionalJiraCollection(
      'changelog',
      () => fetchIssueChangelog(config, payload.key || normalizedIssueKey),
    );
    const fields = payload.fields || {};
    const text = collectIssueText(payload);
    const sourceUrl = getIssueUrl(config, payload.key || normalizedIssueKey);
    const embeddedComments = mapComments(fields);
    const comments = commentsResult.comments?.length ? commentsResult.comments : embeddedComments;
    const changelog = changelogResult.histories || [];
    const changelogSummary = summarizeChangelog(changelog);
    const linkedIssues = mapLinkedIssues(fields, config);
    const attachments = mapAttachments(fields);
    const customFields = mapCustomFields(fields, fieldLookup);
    const parentIssue = mapParentIssue(fields, config);
    const subtasks = mapSubtasks(fields, config);
    const fieldMetadata = Object.fromEntries(
      Object.entries(customFields).map(([key, value]) => [
        key,
        fieldLookup.byId?.[key] || {
          id: key,
          name: value.name || key,
        },
      ]),
    );

    return {
      issue_key: payload.key || normalizedIssueKey,
      project_key: fields.project?.key || String(payload.key || normalizedIssueKey).split('-')[0],
      summary: fields.summary || payload.key || normalizedIssueKey,
      description: getFieldText(fields.description),
      environment: getFieldText(fields.environment) || null,
      status: fields.status?.name || null,
      status_category: fields.status?.statusCategory?.name || null,
      priority: fields.priority?.name || null,
      issue_type: fields.issuetype?.name || null,
      assignee: mapJiraUser(fields.assignee),
      reporter: mapJiraUser(fields.reporter),
      created: fields.created || null,
      updated: fields.updated || null,
      resolution: fields.resolution?.name || null,
      resolution_date: fields.resolutiondate || null,
      labels: fields.labels || [],
      components: (fields.components || []).map((component) => component.name).filter(Boolean),
      linked_issues: linkedIssues,
      parent_issue: parentIssue,
      sub_tasks: subtasks,
      comments,
      changelog,
      changelog_summary: changelogSummary,
      attachments,
      custom_fields: customFields,
      field_metadata: fieldMetadata,
      event_link: sourceUrl,
      issue_url: sourceUrl,
      jira_url: sourceUrl,
      deep_event_link: detectDeepEventLink(text, fields, sourceUrl),
      source_tool: detectSourceTool(text),
      raw_payload: payload,
      raw_issue_payload: payload,
      raw_comments_payload: commentsResult.rawPages || [],
      raw_changelog_payload: changelogResult.rawPages || [],
      raw_rendered_fields_payload: payload.renderedFields || null,
      raw_field_names_payload: payload.names || {},
      raw_field_schema_payload: payload.schema || {},
      comments_error: commentsResult.error || null,
      changelog_error: changelogResult.error || null,
    };
  } catch (error) {
    if (error.status === 404) {
      return null;
    }

    if (error.status) {
      throw error;
    }

    const networkError = new Error(getNetworkErrorMessage(error, config.baseUrl));
    networkError.status = error.status || 502;
    throw networkError;
  }
}

function getIssueKeyCandidates(text) {
  return uniqueValues(String(text || '').match(/\b[A-Z][A-Z0-9]+-\d+\b/g) || []);
}

function isIncidentIssue(issue) {
  const fields = issue?.fields || {};
  const issueType = String(fields.issuetype?.name || '').toLowerCase();

  return issueType.includes('incident');
}

function detectLinkedIncidentKey(issue, text, incidentLookup = new Map()) {
  const fields = issue.fields || {};
  const linkedIncident = (fields.issuelinks || [])
    .map((link) => getLinkedIssue(link).issue)
    .find((linkedIssue) => {
      const key = linkedIssue?.key;

      return key && (incidentLookup.has(key) || isIncidentIssue(linkedIssue));
    });

  if (linkedIncident?.key) {
    return linkedIncident.key;
  }

  return getIssueKeyCandidates(text).find((candidate) => (
    candidate !== issue.key && incidentLookup.has(candidate)
  )) || null;
}

function detectLinkedAlertKeys(issue, text) {
  const fields = issue.fields || {};
  const linkedKeys = (fields.issuelinks || [])
    .map((link) => getLinkedIssue(link).issue?.key)
    .filter(Boolean);
  const textKeys = getIssueKeyCandidates(text).filter((key) => key !== issue.key);

  return uniqueValues([...linkedKeys, ...textKeys]).slice(0, 50);
}

function buildIncidentSchema({ issue, config, fieldLookup, comments, attachments, linkedAlerts }) {
  const fields = issue.fields || {};
  const descriptionText = getFieldText(fields.description);
  const text = collectIssueText(issue);
  const sourceUrl = getIssueUrl(config, issue.key);
  const getValue = (names) => getIssueDetail(fields, fieldLookup, names, text);
  const meetingLinks = splitListValue(getValue(['Meeting / Chat Links', 'Meeting Chat Links', 'Meeting Link', 'Chat Link']))
    .concat(getUrlCandidates(descriptionText).filter((url) => /slack|teams|meet|zoom|bridge|chat/i.test(url)));
  const peopleFromComments = comments.map((comment) => comment.author?.displayName).filter(Boolean);
  const teamsFromLabels = (fields.labels || [])
    .filter((label) => /^team[-_:]/i.test(label))
    .map((label) => label.replace(/^team[-_:]/i, ''));
  const rootCauseNotes = detectNotesByKeywords(comments, descriptionText, [
    'root cause',
    'rca',
    'cause',
    'postmortem',
  ]);
  const recoveryNotes = detectNotesByKeywords(comments, descriptionText, [
    'recovery',
    'restored',
    'mitigation',
  ]);
  const preventativeNotes = detectNotesByKeywords(comments, descriptionText, [
    'preventative',
    'preventive',
    'follow up',
    'follow-up',
    'action item',
  ]);

  return {
    incident_key: issue.key,
    assignee: mapJiraUser(fields.assignee)?.displayName || null,
    raised_via: getValue(['Raised this request via Jira', 'Raised via', 'Request channel']) || 'Jira',
    priority: fields.priority?.name || null,
    platform: getValue(['Platform', 'Application Platform']) || null,
    incident_executive_summary: getValue(['Incident Executive Summary', 'Executive Summary']) || fields.summary || null,
    incident_duration: getValue(['Incident Duration', 'Duration']) || deriveElapsedTime(fields.created, fields.resolutiondate || fields.updated),
    urgency: getValue(['Urgency', 'Incident Urgency']) || null,
    impact: getValue(['Impact', 'Incident Impact']) || null,
    start_time: getValue(['Start Time', 'Incident Start Time', 'Started']) || fields.created || null,
    end_time: getValue(['End Time', 'Incident End Time', 'Ended']) || fields.resolutiondate || null,
    change_related: getValue(['Change Related', 'Change related?']) || null,
    root_cause_category: getValue(['Root Cause Category', 'RCA Category']) || null,
    root_cause_owner_team: getValue(['Root Cause Owner Team', 'Owner Team']) || null,
    excluded_or_nonexcluded: getValue(['Excluded / Nonexcluded', 'Excluded or Nonexcluded', 'Excluded']) || null,
    affected_products: splitListValue(getValue(['Affected Products', 'Products'])),
    affected_business_services: splitListValue(getValue(['Affected Business Services', 'Business Services'])),
    affected_objects: splitListValue(getValue(['Affected Objects', 'Affected Object', 'Objects'])),
    description: {
      category: getValue(['Category', 'Description Category']) || null,
      urgency: getValue(['Description Urgency', 'Urgency']) || null,
      impact: getValue(['Description Impact', 'Impact']) || null,
      impact_to_operations: getValue(['Impact to Operations', 'Operations Impact']) || null,
      meeting_chat_links: uniqueValues(meetingLinks),
      teams_bridge: getValue(['Teams Bridge', 'Bridge']) || null,
      slack_thread_started: getValue(['Slack Thread Started', 'Slack Thread']) || null,
      business_impact: getValue(['Business Impact']) || null,
    },
    root_cause: getValue(['Root cause notes', 'Root Cause', 'Root Cause Notes']) || rootCauseNotes[0] || null,
    recovery_actions: getValue(['Recovery Actions', 'Recovery Action']) || recoveryNotes[0] || null,
    preventative_measures: getValue(['Preventative Measures', 'Preventive Measures']) || preventativeNotes[0] || null,
    people_involved: uniqueValues([
      mapJiraUser(fields.assignee)?.displayName,
      mapJiraUser(fields.reporter)?.displayName,
      ...splitListValue(getValue(['People involved', 'People and Teams', 'People'])),
      ...peopleFromComments,
    ]),
    teams_involved: uniqueValues([
      ...(fields.components || []).map((component) => component.name),
      ...teamsFromLabels,
      ...splitListValue(getValue(['Teams involved', 'Teams'])),
    ]),
    timeline: [
      fields.created ? {
        time: fields.created,
        event: 'Incident created',
        actor: mapJiraUser(fields.reporter)?.displayName || 'Jira',
      } : null,
      ...comments.map((comment) => ({
        time: comment.created,
        event: comment.body,
        actor: comment.author?.displayName || 'Unknown',
      })),
      fields.resolutiondate ? {
        time: fields.resolutiondate,
        event: fields.resolution?.name || 'Incident resolved',
        actor: mapJiraUser(fields.assignee)?.displayName || 'Jira',
      } : null,
    ].filter(Boolean),
    attachments: attachments.map((attachment) => ({
      name: attachment.filename,
      url: attachment.content,
      type: attachment.mimeType,
    })),
    linked_alerts: linkedAlerts,
    source_url: sourceUrl,
    raw_payload: issue,
    created_at: fields.created || null,
    updated_at: fields.updated || null,
    status: fields.status?.name || null,
    resolution: fields.resolution?.name || null,
  };
}

function normalizeIncidentIssue(issue, config, fieldLookup = buildFieldLookup([])) {
  const fields = issue.fields || {};
  const comments = mapComments(fields);
  const descriptionText = getFieldText(fields.description);
  const text = collectIssueText(issue);
  const rootCauseNotes = detectNotesByKeywords(comments, descriptionText, [
    'root cause',
    'rca',
    'cause',
    'postmortem',
  ]);
  const attachments = mapAttachments(fields);
  const linkedAlerts = detectLinkedAlertKeys(issue, text);
  const incidentDetails = buildIncidentSchema({
    issue,
    config,
    fieldLookup,
    comments,
    attachments,
    linkedAlerts,
  });

  return {
    incidentKey: issue.key,
    summary: fields.summary || `JSM incident ${issue.key}`,
    description: descriptionText || fields.summary || '',
    reporter: mapJiraUser(fields.reporter),
    priority: fields.priority?.name || null,
    status: fields.status?.name || null,
    statusCategory: fields.status?.statusCategory?.name || null,
    resolution: fields.resolution?.name || null,
    createdAt: fields.created || new Date().toISOString(),
    updatedAt: fields.updated || fields.created || new Date().toISOString(),
    closedAt: fields.resolutiondate || null,
    assignee: mapJiraUser(fields.assignee),
    labels: fields.labels || [],
    linkedAlerts,
    rootCauseNotes,
    comments,
    attachments,
    customFields: mapCustomFields(fields, fieldLookup),
    incidentDetails,
    sourceUrl: getIssueUrl(config, issue.key),
    rawPayload: issue,
  };
}

function mapIncidentForDetails(incident) {
  if (!incident) {
    return null;
  }

  return {
    incident_key: incident.incidentKey,
    summary: incident.summary,
    description: incident.description,
    reporter: incident.reporter,
    priority: incident.priority,
    status: incident.status,
    status_category: incident.statusCategory,
    resolution: incident.resolution,
    created_at: incident.createdAt,
    updated_at: incident.updatedAt,
    closed_at: incident.closedAt,
    assignee: incident.assignee,
    labels: incident.labels,
    linked_alerts: incident.linkedAlerts,
    root_cause_notes: incident.rootCauseNotes,
    comments: incident.comments,
    attachments: incident.attachments,
    custom_fields: incident.customFields,
    incident_details: incident.incidentDetails,
    source_url: incident.sourceUrl,
    raw_payload: incident.rawPayload,
  };
}

function buildExtractedDetails(issue, config, alert, text, fieldLookup = buildFieldLookup([])) {
  const fields = issue.fields || {};
  const sourceUrl = alert.sourceUrl;
  const comments = mapComments(fields);
  const linkedIssues = mapLinkedIssues(fields, config);
  const attachments = mapAttachments(fields);
  const customFields = mapCustomFields(fields, fieldLookup);
  const parentIssue = mapParentIssue(fields, config);
  const subtasks = mapSubtasks(fields, config);
  const deepEventLink = detectDeepEventLink(text, fields, sourceUrl);
  const duplicateReferences = detectDuplicateReferences(text);
  const incidentReferences = detectIncidentReferences(text);
  const closureNotes = detectNotesByKeywords(comments, getFieldText(fields.description), [
    'closure',
    'closed',
    'resolution',
    'resolved',
  ]);
  const rootCauseNotes = detectNotesByKeywords(comments, getFieldText(fields.description), [
    'root cause',
    'rca',
    'cause',
    'postmortem',
  ]);
  const statusState = getStatusState(fields.status?.name, fields.status?.statusCategory?.name, fields.resolutiondate);
  const sourceName = alert.source || null;
  const assignedTeam = detectAssignedTeam(fields, text);
  const alertIdentifiers = detectAlertIdentifiers(text, issue.key);
  const incidentHistory = alert.linkedIncident ? [mapIncidentForDetails(alert.linkedIncident)] : [];
  const tags = uniqueValues([
    ...(fields.labels || []),
    ...((fields.components || []).map((component) => component.name)),
    sourceName,
    assignedTeam,
  ]);
  const structuredAlert = buildAlertSchemaFromIssue({
    issue,
    config,
    alert,
    text,
    fieldLookup,
    deepEventLink,
    duplicateReferences,
    tags,
  });
  const normalizedAlert = {
    alert_id: alert.id,
    jira_issue_key: issue.key || null,
    jira_incident_key: alert.jiraTicketId || null,
    source_tool: sourceName,
    source_type: alert.sourceType,
    source_name: sourceName,
    priority: fields.priority?.name || null,
    severity: alert.severity || null,
    status: alert.status || null,
    jira_status: fields.status?.name || null,
    jira_status_category: fields.status?.statusCategory?.name || null,
    state: statusState,
    message: alert.title || null,
    summary: fields.summary || null,
    description: getFieldText(fields.description) || null,
    service: alert.service || null,
    application: alert.service || null,
    environment: alert.environment || null,
    owner: alert.owner || null,
    timestamp: alert.receivedAt || null,
    created_at: fields.created || null,
    updated_at: fields.updated || null,
    occurrences: alert.occurrences || 1,
    duplicate_count: duplicateReferences.length || alert.occurrences || 1,
    correlation_id: alert.correlationId || null,
    duplicate_signature: alert.duplicateSignature || null,
    related_alerts: alert.relatedAlerts || [],
    raw_payload: issue,
    event_link: sourceUrl || null,
    deep_event_link: deepEventLink,
    classification: alert.classification || 'needs_review',
    confidence: Number.isFinite(Number(alert.confidenceScore)) ? Number(alert.confidenceScore) / 100 : null,
    justification: alert.classificationReason || null,
    reason_codes: [],
    recommended_action: 'Review Jira alert context',
    review_status: alert.classification === 'needs_review' ? 'needs_review' : 'classified',
    resolved_at: fields.resolutiondate || null,
    closed_at: statusState === 'closed' ? fields.resolutiondate || fields.updated || null : null,
    assigned_team: assignedTeam,
    assignee: mapJiraUser(fields.assignee),
    reporter: mapJiraUser(fields.reporter),
    tags,
    labels: fields.labels || [],
    notes: comments.map((comment) => comment.body).filter(Boolean),
  };

  return {
    structured_alert: structuredAlert,
    normalized_alert: normalizedAlert,
    classification: {
      classification: normalizedAlert.classification,
      label: normalizedAlert.classification,
      confidence: normalizedAlert.confidence,
      justification: normalizedAlert.justification,
      reason_codes: normalizedAlert.reason_codes,
      recommended_action: normalizedAlert.recommended_action,
      review_status: normalizedAlert.review_status,
    },
    alert: {
      alert_id: alert.id,
      source_tool: alert.source,
      source_type: alert.sourceType,
      source_name: sourceName,
      service: alert.service,
      application: alert.service,
      environment: alert.environment,
      severity: alert.severity,
      priority: fields.priority?.name || null,
      message: alert.title,
      timestamp: alert.receivedAt,
      status: alert.status,
      jira_status: fields.status?.name || null,
      state: statusState,
      occurrences: alert.occurrences,
      duplicate_count: duplicateReferences.length || alert.occurrences || 1,
      event_link: sourceUrl,
      deep_event_link: deepEventLink || issue.self || sourceUrl,
      raw_payload: issue,
      owner: alert.owner,
      assigned_team: assignedTeam,
      correlation_id: alert.correlationId,
      duplicate_signature: alert.duplicateSignature || buildDuplicateSignature(alert),
      related_alerts: alert.relatedAlerts,
      jira_key: alert.jiraTicketId,
      jira_incident_key: alert.jiraTicketId,
      alert_identifiers: alertIdentifiers,
      duplicate_references: duplicateReferences,
      incident_references: incidentReferences,
      closure_notes: closureNotes,
      root_cause_notes: rootCauseNotes,
    },
    jira: {
      issue_key: issue.key || '',
      summary: fields.summary || '',
      description: getFieldText(fields.description),
      status: fields.status?.name || '',
      status_category: fields.status?.statusCategory?.name || '',
      priority: fields.priority?.name || '',
      issue_type: fields.issuetype?.name || '',
      assignee: mapJiraUser(fields.assignee),
      reporter: mapJiraUser(fields.reporter),
      created: fields.created || '',
      updated: fields.updated || '',
      resolution: fields.resolution?.name || '',
      resolution_date: fields.resolutiondate || '',
      labels: fields.labels || [],
      environment: alert.environment || null,
      service: alert.service || null,
      source_tool: sourceName,
      monitoring_system_name: sourceName,
      parent_issue: parentIssue,
      sub_tasks: subtasks,
      components: (fields.components || []).map((component) => ({
        id: component.id || '',
        name: component.name || '',
        description: component.description || '',
        self: component.self || '',
      })),
      linked_issues: linkedIssues,
      comments,
      attachments,
      custom_fields: customFields,
      raw_payload: issue,
    },
    incident_history: incidentHistory,
  };
}

function mapJiraStatus(statusName, statusCategoryName) {
  const status = String(statusName || '').toLowerCase();
  const category = String(statusCategoryName || '').toLowerCase();

  if (category === 'done' || status.includes('done') || status.includes('closed') || status.includes('resolved')) {
    return 'resolved';
  }

  if (status.includes('progress') || status.includes('investigat') || status.includes('ack')) {
    return 'investigating';
  }

  return 'open';
}

function normalizeIssue(issue, config, incidentLookup = new Map(), fieldLookup = buildFieldLookup([])) {
  const fields = issue.fields || {};
  const text = collectIssueText(issue);
  const source = 'JSM Operations Alerts';
  const service = detectService(issue, text);
  const environment = detectEnvironment(text);
  const severity = detectSeverity(text, fields.priority?.name);
  const status = mapJiraStatus(fields.status?.name, fields.status?.statusCategory?.name);
  const assigneeName = fields.assignee?.displayName || 'Unassigned';
  const sourceUrl = getIssueUrl(config, issue.key);
  const summary = fields.summary || `Jira issue ${issue.key}`;
  const descriptionText = getFieldText(fields.description) || summary;
  const linkedIncidentKey = detectLinkedIncidentKey(issue, text, incidentLookup);
  const linkedIncident = linkedIncidentKey ? incidentLookup.get(linkedIncidentKey) : null;

  console.log(`JSM Operations alert processed: ${issue.key} source=${source} service=${service}`);

  const foundationState = unclassifiedFoundationState();
  const alert = {
    id: issue.key,
    title: summary,
    service,
    environment,
    severity,
    status,
    classification: foundationState.classification,
    noiseType: foundationState.noiseType,
    source,
    sourceType: 'jsm_operations_alert',
    sourceAlertId: issue.key,
    sourceUrl,
    rawPayload: issue,
    noiseReason: foundationState.noiseReason,
    classificationReason: foundationState.classificationReason,
    confidenceScore: foundationState.confidenceScore,
    duplicateSignature: null,
    correlationId: detectCorrelationId(text, issue),
    receivedAt: fields.created || new Date().toISOString(),
    lastSeenAt: fields.updated || fields.created || new Date().toISOString(),
    occurrences: detectOccurrences(text),
    owner: assigneeName,
    signal: summary,
    description: [
      descriptionText,
      fields.reporter?.displayName ? `Reporter: ${fields.reporter.displayName}` : null,
      fields.issuetype?.name ? `Issue Type: ${fields.issuetype.name}` : null,
      fields.labels?.length ? `Labels: ${fields.labels.join(', ')}` : null,
      fields.components?.length ? `Components: ${fields.components.map((component) => component.name).join(', ')}` : null,
    ].filter(Boolean).join('\n'),
    jiraTicketId: linkedIncidentKey,
    recurringIncident: false,
    relatedAlerts: detectRelatedAlerts(text).filter((id) => id !== issue.key.toUpperCase()),
    linkedIncident,
  };

  alert.duplicateSignature = buildDuplicateSignature(alert);
  alert.extractedDetails = buildExtractedDetails(issue, config, alert, text, fieldLookup);

  return alert;
}

function collectOperationsAlertText(alert) {
  return [
    alert.tinyId,
    alert.id,
    alert.alias,
    alert.message,
    alert.description,
    alert.entity,
    alert.source,
    alert.priority,
    alert.status,
    ...(alert.tags || []),
    ...Object.entries(alert.details || {}).map(([key, value]) => `${key} ${value}`),
    ...Object.entries(alert.extraProperties || {}).map(([key, value]) => `${key} ${value}`),
  ].filter(Boolean).join(' ');
}

function getDetailValue(alert, names) {
  const details = {
    ...(alert.details || {}),
    ...(alert.extraProperties || {}),
  };
  const normalizedEntries = Object.entries(details).map(([key, value]) => [
    key.toLowerCase().replace(/[^a-z0-9]+/g, ''),
    value,
  ]);

  for (const name of names) {
    const normalizedName = name.toLowerCase().replace(/[^a-z0-9]+/g, '');
    const match = normalizedEntries.find(([key]) => key === normalizedName);

    if (match && match[1]) {
      return String(match[1]);
    }
  }

  return null;
}

function sanitizeAlertId(value) {
  return String(value || '')
    .replace(/^#+/, '')
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function getOperationsSourceAlertId(alert) {
  return alert.id || alert.alertId || alert.tinyId || alert.tiny_id || alert.alias || null;
}

function buildOperationsAlertId(alert) {
  const tinyId = alert.tinyId || alert.tiny_id;

  if (tinyId) {
    return `OPS-${sanitizeAlertId(tinyId)}`;
  }

  const sourceAlertId = getOperationsSourceAlertId(alert);

  if (sourceAlertId) {
    return `OPS-${sanitizeAlertId(sourceAlertId)}`;
  }

  return `OPS-${crypto.createHash('sha1').update(JSON.stringify(alert)).digest('hex').slice(0, 12)}`;
}

function mapOperationsSeverity(priority, text) {
  const priorityText = String(priority || '').toLowerCase();

  if (priorityText === 'p1') {
    return 'critical';
  }

  if (priorityText === 'p2') {
    return 'high';
  }

  if (priorityText === 'p3') {
    return 'medium';
  }

  if (priorityText === 'p4') {
    return 'warning';
  }

  if (priorityText === 'p5') {
    return 'low';
  }

  return detectSeverity(text, priority);
}

function mapOperationsStatus(statusValue, acknowledged) {
  const status = String(statusValue || '').toLowerCase();

  if (status.includes('closed') || status.includes('resolved')) {
    return 'resolved';
  }

  if (status.includes('ack') || acknowledged) {
    return 'investigating';
  }

  if (status.includes('open')) {
    return 'open';
  }

  return 'firing';
}

function getOperationsSourceUrl(alert, config) {
  const links = alert.links || {};
  const webLink = links.web || links.webUrl || links.alert || alert.url || alert.webUrl;

  if (webLink) {
    return webLink;
  }

  const jiraBaseUrl = process.env.JIRA_BASE_URL?.trim();
  const sourceAlertId = getOperationsSourceAlertId(alert);

  if (jiraBaseUrl && sourceAlertId) {
    return `${jiraBaseUrl.replace(/\/+$/, '')}/jira/ops/alerts/${encodeURIComponent(sourceAlertId)}`;
  }

  return config.baseUrl || jiraBaseUrl || null;
}

function mapResponderName(responder) {
  if (!responder) {
    return null;
  }

  return responder.name || responder.username || responder.displayName || responder.id || null;
}

function getOperationsOwner(alert) {
  return (
    mapResponderName(alert.owner) ||
    mapResponderName(alert.assignee) ||
    mapResponderName(alert.responders?.[0]) ||
    mapResponderName(alert.teams?.[0]) ||
    'Unassigned'
  );
}

function getOperationsService(alert, text) {
  return (
    getDetailValue(alert, ['service', 'application', 'app', 'component']) ||
    alert.entity ||
    alert.integration?.name ||
    text.match(/\b(?:service|application|app|component)\s*[:=]\s*([a-zA-Z0-9._/-]+)/i)?.[1] ||
    'Unknown'
  );
}

function getOperationsEnvironment(alert, text) {
  const explicitEnvironment = getDetailValue(alert, ['environment', 'env', 'tier']);

  if (explicitEnvironment) {
    return detectEnvironment(explicitEnvironment);
  }

  return detectEnvironment(text);
}

function getOperationsOccurrences(alert) {
  const occurrenceCount = Number(alert.count || alert.occurrences || alert.occurrenceCount || 1);

  return Number.isFinite(occurrenceCount) ? Math.max(occurrenceCount, 1) : 1;
}

function getOperationsRelatedAlerts(alert, text) {
  return uniqueValues([
    ...(alert.relatedAlerts || []),
    ...(alert.related_alerts || []),
    ...detectRelatedAlerts(text),
  ]).slice(0, 20);
}

function buildOperationsExtractedDetails(alert, config, normalizedAlert, text) {
  const tags = uniqueValues([
    ...(alert.tags || []),
    ...(alert.teams || []).map((team) => team.name || team),
    normalizedAlert.source,
    normalizedAlert.service,
    normalizedAlert.environment,
  ]);
  const priority = alert.priority || null;
  const statusState = ['resolved', 'recovered', 'auto-resolved'].includes(normalizedAlert.status)
    ? 'closed'
    : 'open';
  const deepEventLink = detectDeepEventLink(text, {}, normalizedAlert.sourceUrl);
  const structuredAlert = buildAlertSchemaFromOperationsAlert({
    alert,
    normalizedAlert,
    text,
    deepEventLink,
    tags,
  });

  return {
    structured_alert: structuredAlert,
    normalized_alert: {
      alert_id: normalizedAlert.id,
      jira_issue_key: null,
      source_tool: normalizedAlert.source,
      source_type: normalizedAlert.sourceType,
      source_name: normalizedAlert.source,
      source_alert_id: normalizedAlert.sourceAlertId,
      tiny_id: alert.tinyId || alert.tiny_id || null,
      alias: alert.alias || null,
      priority,
      severity: normalizedAlert.severity,
      status: normalizedAlert.status,
      state: statusState,
      message: normalizedAlert.title,
      summary: alert.message || normalizedAlert.title,
      description: alert.description || null,
      service: normalizedAlert.service,
      application: normalizedAlert.service,
      environment: normalizedAlert.environment,
      owner: normalizedAlert.owner,
      timestamp: normalizedAlert.receivedAt,
      created_at: alert.createdAt || normalizedAlert.receivedAt,
      updated_at: alert.updatedAt || normalizedAlert.lastSeenAt,
      occurrences: normalizedAlert.occurrences,
      duplicate_count: normalizedAlert.occurrences,
      correlation_id: normalizedAlert.correlationId,
      duplicate_signature: normalizedAlert.duplicateSignature,
      related_alerts: normalizedAlert.relatedAlerts,
      raw_payload: alert,
      event_link: normalizedAlert.sourceUrl,
      deep_event_link: deepEventLink,
      classification: normalizedAlert.classification,
      confidence: null,
      justification: normalizedAlert.classificationReason,
      reason_codes: [],
      recommended_action: 'Store and classify before creating an ACC incident',
      review_status: 'needs_review',
      resolved_at: statusState === 'closed' ? alert.updatedAt || alert.closedAt || null : null,
      closed_at: statusState === 'closed' ? alert.updatedAt || alert.closedAt || null : null,
      assigned_team: alert.teams?.[0]?.name || null,
      assignee: null,
      reporter: null,
      tags,
      labels: tags,
      notes: [],
    },
    classification: {
      classification: normalizedAlert.classification,
      label: normalizedAlert.classification,
      confidence: null,
      justification: normalizedAlert.classificationReason,
      reason_codes: [],
      recommended_action: 'Store and classify before creating an ACC incident',
      review_status: 'needs_review',
    },
    alert: {
      alert_id: normalizedAlert.id,
      source_tool: normalizedAlert.source,
      source_type: normalizedAlert.sourceType,
      service: normalizedAlert.service,
      environment: normalizedAlert.environment,
      severity: normalizedAlert.severity,
      message: normalizedAlert.title,
      timestamp: normalizedAlert.receivedAt,
      status: normalizedAlert.status,
      occurrences: normalizedAlert.occurrences,
      event_link: normalizedAlert.sourceUrl,
      deep_event_link: deepEventLink,
      raw_payload: alert,
      owner: normalizedAlert.owner,
      correlation_id: normalizedAlert.correlationId,
      duplicate_signature: normalizedAlert.duplicateSignature,
      related_alerts: normalizedAlert.relatedAlerts,
      jira_key: null,
    },
    jira: {
      issue_key: '',
      summary: '',
      description: '',
      status: '',
      priority: '',
      issue_type: '',
      assignee: null,
      reporter: null,
      created: '',
      updated: '',
      resolution: '',
      resolution_date: '',
      labels: [],
      components: [],
      linked_issues: [],
      comments: [],
      attachments: [],
      custom_fields: {},
      note: 'ACC Jira incidents are linked only after an alert is classified as an incident.',
    },
    operations_alert: {
      id: alert.id || null,
      tiny_id: alert.tinyId || alert.tiny_id || null,
      alias: alert.alias || null,
      message: alert.message || null,
      description: alert.description || null,
      status: alert.status || null,
      acknowledged: Boolean(alert.acknowledged),
      priority,
      source: alert.source || null,
      entity: alert.entity || null,
      tags: alert.tags || [],
      teams: alert.teams || [],
      responders: alert.responders || [],
      integration: alert.integration || null,
      details: alert.details || {},
      extra_properties: alert.extraProperties || {},
      created_at: alert.createdAt || null,
      updated_at: alert.updatedAt || null,
      raw_payload: alert,
    },
  };
}

function normalizeOperationsAlert(alert, config) {
  const text = collectOperationsAlertText(alert);
  const title = alert.message || alert.alias || `Operations alert ${alert.tinyId || alert.id || ''}`.trim();
  const service = getOperationsService(alert, text);
  const environment = getOperationsEnvironment(alert, text);
  const severity = mapOperationsSeverity(alert.priority, text);
  const status = mapOperationsStatus(alert.status, alert.acknowledged);
  const sourceAlertId = getOperationsSourceAlertId(alert);
  const sourceUrl = getOperationsSourceUrl(alert, config);
  const receivedAt = alert.createdAt || new Date(getOperationsAlertTimestamp(alert)).toISOString();
  const lastSeenAt = alert.updatedAt || alert.lastOccurredAt || receivedAt;
  const foundationState = unclassifiedFoundationState();
  const normalizedAlert = {
    id: buildOperationsAlertId(alert),
    title,
    service,
    environment,
    severity,
    status,
    classification: foundationState.classification,
    noiseType: foundationState.noiseType,
    source: 'JSM Operations',
    sourceType: 'jira_operations_alert',
    sourceAlertId,
    sourceUrl,
    rawPayload: alert,
    noiseReason: foundationState.noiseReason,
    classificationReason: foundationState.classificationReason,
    confidenceScore: foundationState.confidenceScore,
    duplicateSignature: null,
    correlationId: alert.alias || sourceAlertId || '',
    receivedAt,
    lastSeenAt,
    occurrences: getOperationsOccurrences(alert),
    owner: getOperationsOwner(alert),
    signal: title,
    description: [
      alert.description || title,
      alert.priority ? `Priority: ${alert.priority}` : null,
      alert.status ? `Operations Status: ${alert.status}` : null,
      alert.entity ? `Entity: ${alert.entity}` : null,
      alert.tags?.length ? `Tags: ${alert.tags.join(', ')}` : null,
      alert.detailFetchError ? `Detail fetch note: ${alert.detailFetchError}` : null,
    ].filter(Boolean).join('\n'),
    jiraTicketId: null,
    recurringIncident: false,
    relatedAlerts: getOperationsRelatedAlerts(alert, text),
  };

  normalizedAlert.duplicateSignature = buildDuplicateSignature(normalizedAlert);
  normalizedAlert.extractedDetails = buildOperationsExtractedDetails(alert, config, normalizedAlert, text);

  return normalizedAlert;
}

async function ensureJiraAlertColumns(client = db) {
  await client.query(`
    ALTER TABLE alerts ADD COLUMN IF NOT EXISTS jira_ticket_id VARCHAR(50);
    ALTER TABLE alerts ADD COLUMN IF NOT EXISTS raw_payload JSONB;
    ALTER TABLE alerts ADD COLUMN IF NOT EXISTS extracted_details JSONB;
    ALTER TABLE alerts ADD COLUMN IF NOT EXISTS source_url TEXT;
    ALTER TABLE alerts ADD COLUMN IF NOT EXISTS source_type TEXT NOT NULL DEFAULT 'monitoring';
    ALTER TABLE alerts ADD COLUMN IF NOT EXISTS source_alert_id TEXT;
    ALTER TABLE alerts ADD COLUMN IF NOT EXISTS confidence_score INTEGER;
    ALTER TABLE alerts ADD COLUMN IF NOT EXISTS duplicate_signature TEXT;
    ALTER TABLE alerts ADD COLUMN IF NOT EXISTS correlation_id TEXT;
    ALTER TABLE alerts ADD COLUMN IF NOT EXISTS classification_is_legacy BOOLEAN NOT NULL DEFAULT false;

    ALTER TABLE alerts DROP CONSTRAINT IF EXISTS alerts_classification_check;
    ALTER TABLE alerts
      ADD CONSTRAINT alerts_classification_check
      CHECK (classification IN ('incident', 'noise', 'needs_review', 'unclassified'));
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS raw_alerts (
      id BIGSERIAL PRIMARY KEY,
      source_tool TEXT NOT NULL,
      source_type TEXT NOT NULL DEFAULT 'monitoring',
      source_alert_id TEXT,
      normalized_alert_id TEXT REFERENCES alerts(id) ON DELETE SET NULL,
      raw_payload JSONB NOT NULL,
      processing_status TEXT NOT NULL DEFAULT 'stored',
      error_message TEXT,
      received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    ALTER TABLE raw_alerts DROP CONSTRAINT IF EXISTS raw_alerts_processing_status_check;
    ALTER TABLE raw_alerts
      ADD CONSTRAINT raw_alerts_processing_status_check
      CHECK (processing_status IN ('stored', 'normalized', 'normalization_failed', 'classification_failed'));

    CREATE TABLE IF NOT EXISTS alert_classification_history (
      id BIGSERIAL PRIMARY KEY,
      alert_id TEXT NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
      classification TEXT NOT NULL,
      noise_type TEXT NOT NULL DEFAULT 'none',
      confidence_score INTEGER,
      justification TEXT NOT NULL,
      noise_reason TEXT,
      classified_by TEXT NOT NULL DEFAULT 'system',
      classified_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS alert_correlation_history (
      id BIGSERIAL PRIMARY KEY,
      alert_id TEXT NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
      duplicate_signature TEXT,
      correlation_id TEXT,
      duplicate_count INTEGER NOT NULL DEFAULT 1,
      related_alerts JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS alert_incident_mappings (
      id BIGSERIAL PRIMARY KEY,
      alert_id TEXT NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
      incident_id BIGINT REFERENCES incidents(id) ON DELETE CASCADE,
      jira_ticket_id TEXT,
      mapping_reason TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS operations_incidents (
      incident_key TEXT PRIMARY KEY,
      summary TEXT,
      description TEXT,
      reporter JSONB,
      priority TEXT,
      status TEXT,
      status_category TEXT,
      resolution TEXT,
      source_url TEXT,
      incident_created_at TIMESTAMPTZ,
      incident_updated_at TIMESTAMPTZ,
      closed_at TIMESTAMPTZ,
      assignee JSONB,
      labels JSONB NOT NULL DEFAULT '[]'::jsonb,
      linked_alerts JSONB NOT NULL DEFAULT '[]'::jsonb,
      root_cause_notes JSONB NOT NULL DEFAULT '[]'::jsonb,
      comments JSONB NOT NULL DEFAULT '[]'::jsonb,
      attachments JSONB NOT NULL DEFAULT '[]'::jsonb,
      custom_fields JSONB NOT NULL DEFAULT '{}'::jsonb,
      incident_details JSONB NOT NULL DEFAULT '{}'::jsonb,
      raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    ALTER TABLE operations_incidents ADD COLUMN IF NOT EXISTS attachments JSONB NOT NULL DEFAULT '[]'::jsonb;
    ALTER TABLE operations_incidents ADD COLUMN IF NOT EXISTS incident_details JSONB NOT NULL DEFAULT '{}'::jsonb;

    CREATE TABLE IF NOT EXISTS sync_runs (
      id BIGSERIAL PRIMARY KEY,
      sync_name TEXT NOT NULL,
      source TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'historical_backfill',
      status TEXT NOT NULL DEFAULT 'running',
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      finished_at TIMESTAMPTZ,
      alerts_fetched INTEGER NOT NULL DEFAULT 0,
      alerts_inserted INTEGER NOT NULL DEFAULT 0,
      alerts_updated INTEGER NOT NULL DEFAULT 0,
      alerts_skipped INTEGER NOT NULL DEFAULT 0,
      incidents_fetched INTEGER NOT NULL DEFAULT 0,
      incidents_stored INTEGER NOT NULL DEFAULT 0,
      incident_links_created INTEGER NOT NULL DEFAULT 0,
      cursor_value TEXT,
      request_options JSONB NOT NULL DEFAULT '{}'::jsonb,
      error_message TEXT
    );

    CREATE TABLE IF NOT EXISTS sync_state (
      sync_name TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      cursor_value TEXT,
      last_successful_run_id BIGINT REFERENCES sync_runs(id) ON DELETE SET NULL,
      last_successful_at TIMESTAMPTZ,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_operations_incidents_status ON operations_incidents(status);
    CREATE INDEX IF NOT EXISTS idx_operations_incidents_updated ON operations_incidents(incident_updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_sync_runs_sync_name ON sync_runs(sync_name, started_at DESC);
  `);
}

async function startSyncRun(options = {}) {
  const syncName = options.syncName || JSM_OPERATIONS_SYNC_NAME;
  const source = options.syncSource || 'Jira Service Management Operations';
  const result = await db.query(
    `
      INSERT INTO sync_runs (
        sync_name,
        source,
        mode,
        status,
        request_options
      )
      VALUES ($1, $2, $3, 'running', $4::jsonb)
      RETURNING id
    `,
    [
      syncName,
      source,
      options.incremental ? 'incremental_refresh' : 'historical_backfill',
      JSON.stringify(options),
    ],
  );

  return result.rows[0].id;
}

async function finishSyncRun(runId, summary, cursorValue) {
  if (!runId) {
    return;
  }

  const syncName = summary.syncName || JSM_OPERATIONS_SYNC_NAME;
  const source = summary.syncSource || 'Jira Service Management Operations';

  await db.query(
    `
      UPDATE sync_runs
      SET
        status = 'success',
        finished_at = NOW(),
        alerts_fetched = $2,
        alerts_inserted = $3,
        alerts_updated = $4,
        alerts_skipped = $5,
        incidents_fetched = $6,
        incidents_stored = $7,
        incident_links_created = $8,
        cursor_value = $9
      WHERE id = $1
    `,
    [
      runId,
      summary.totalFetched || 0,
      summary.inserted || 0,
      summary.updated || 0,
      summary.skipped || 0,
      summary.incidentsFetched || 0,
      summary.incidentsStored || 0,
      summary.incidentLinksCreated || 0,
      cursorValue || null,
    ],
  );

  await db.query(
    `
      INSERT INTO sync_state (
        sync_name,
        source,
        cursor_value,
        last_successful_run_id,
        last_successful_at,
        metadata,
        updated_at
      )
      VALUES ($1, $2, $3, $4, NOW(), $5::jsonb, NOW())
      ON CONFLICT (sync_name)
      DO UPDATE SET
        cursor_value = EXCLUDED.cursor_value,
        last_successful_run_id = EXCLUDED.last_successful_run_id,
        last_successful_at = EXCLUDED.last_successful_at,
        metadata = EXCLUDED.metadata,
        updated_at = NOW()
    `,
    [
      syncName,
      source,
      cursorValue || null,
      runId,
      JSON.stringify(summary),
    ],
  );
}

async function failSyncRun(runId, error) {
  if (!runId) {
    return;
  }

  await db.query(
    `
      UPDATE sync_runs
      SET
        status = 'failed',
        finished_at = NOW(),
        error_message = $2
      WHERE id = $1
    `,
    [runId, error.message],
  );
}

async function getStoredSyncCursor(syncName = JSM_OPERATIONS_SYNC_NAME) {
  await ensureJiraAlertColumns();
  const result = await db.query(
    `
      SELECT cursor_value
      FROM sync_state
      WHERE sync_name = $1
    `,
    [syncName],
  );

  return result.rows[0]?.cursor_value || null;
}

async function getBackfillStatus() {
  await ensureJiraAlertColumns();
  const stateResult = await db.query(
    `
      SELECT *
      FROM sync_state
      WHERE sync_name IN ($1, $2)
      ORDER BY sync_name ASC
    `,
    [JSM_OPERATIONS_SYNC_NAME, JIRA_INCIDENTS_SYNC_NAME],
  );
  const runsResult = await db.query(
    `
      SELECT *
      FROM sync_runs
      WHERE sync_name IN ($1, $2)
      ORDER BY started_at DESC
      LIMIT 10
    `,
    [JSM_OPERATIONS_SYNC_NAME, JIRA_INCIDENTS_SYNC_NAME],
  );

  return {
    state: stateResult.rows[0] || null,
    states: stateResult.rows,
    recentRuns: runsResult.rows,
  };
}

async function resolveBackfillOptions(options = {}) {
  if (!options.incremental) {
    return {
      ...options,
      range: options.range || 'all',
    };
  }

  const cursor = await getStoredSyncCursor(options.syncName || JSM_OPERATIONS_SYNC_NAME);

  return {
    ...options,
    range: 'incremental',
    updatedFrom: options.updatedFrom || cursor || null,
  };
}

function getSyncCursorFromIssues(issues = [], incidents = []) {
  const timestamps = [...issues, ...incidents]
    .map((issue) => issue.fields?.updated || issue.fields?.created)
    .map((value) => new Date(value || '').getTime())
    .filter(Number.isFinite);

  if (timestamps.length === 0) {
    return null;
  }

  return new Date(Math.max(...timestamps)).toISOString();
}

function getIssueKeyNumber(issueKey) {
  const match = String(issueKey || '').match(/-(\d+)$/);

  if (!match) {
    return null;
  }

  const value = Number(match[1]);

  return Number.isFinite(value) ? value : null;
}

function summarizeJiraIssues(issues = []) {
  const issueNumbers = issues
    .map((issue) => ({
      key: issue.key,
      number: getIssueKeyNumber(issue.key),
    }))
    .filter((item) => Number.isFinite(item.number));
  const sortedNumbers = [...issueNumbers].sort((first, second) => first.number - second.number);
  const issueTypeCounts = {};
  const statusCategoryCounts = {};
  const statusCounts = {};

  issues.forEach((issue) => {
    const issueType = issue.fields?.issuetype?.name || 'Unknown';
    const status = issue.fields?.status?.name || 'Unknown';
    const statusCategory = issue.fields?.status?.statusCategory?.name || 'Unknown';

    issueTypeCounts[issueType] = (issueTypeCounts[issueType] || 0) + 1;
    statusCounts[status] = (statusCounts[status] || 0) + 1;
    statusCategoryCounts[statusCategory] = (statusCategoryCounts[statusCategory] || 0) + 1;
  });

  return {
    fetchedIssueCount: issues.length,
    lowestIssueKey: sortedNumbers[0]?.key || null,
    lowestIssueNumber: sortedNumbers[0]?.number || null,
    highestIssueKey: sortedNumbers[sortedNumbers.length - 1]?.key || null,
    highestIssueNumber: sortedNumbers[sortedNumbers.length - 1]?.number || null,
    issueTypeCounts,
    statusCategoryCounts,
    statusCounts,
  };
}

async function upsertRawJiraAlert(client, issue) {
  const existing = await client.query(
    `
      SELECT id
      FROM raw_alerts
      WHERE source_tool = 'jira'
        AND source_alert_id = $1
      LIMIT 1
    `,
    [issue.key],
  );

  if (existing.rows[0]) {
    await client.query(
      `
        UPDATE raw_alerts
        SET
          raw_payload = $2::jsonb,
          processing_status = 'stored',
          error_message = NULL,
          received_at = $3
        WHERE id = $1
      `,
      [
        existing.rows[0].id,
        JSON.stringify(issue),
        issue.fields?.created || new Date().toISOString(),
      ],
    );

    return existing.rows[0].id;
  }

  const inserted = await client.query(
    `
      INSERT INTO raw_alerts (
        source_tool,
        source_type,
        source_alert_id,
        raw_payload,
        processing_status,
        received_at
      )
      VALUES ('jira', 'jira_alert_issue', $1, $2::jsonb, 'stored', $3)
      RETURNING id
    `,
    [
      issue.key,
      JSON.stringify(issue),
      issue.fields?.created || new Date().toISOString(),
    ],
  );

  return inserted.rows[0].id;
}

async function upsertRawOperationsAlert(client, operationsAlert) {
  const sourceAlertId = getOperationsSourceAlertId(operationsAlert) || buildOperationsAlertId(operationsAlert);
  const receivedAt = operationsAlert.createdAt || new Date(getOperationsAlertTimestamp(operationsAlert)).toISOString();
  const existing = await client.query(
    `
      SELECT id
      FROM raw_alerts
      WHERE source_tool = 'jira_operations'
        AND source_alert_id = $1
      LIMIT 1
    `,
    [sourceAlertId],
  );

  if (existing.rows[0]) {
    await client.query(
      `
        UPDATE raw_alerts
        SET
          raw_payload = $2::jsonb,
          processing_status = 'stored',
          error_message = NULL,
          received_at = $3
        WHERE id = $1
      `,
      [
        existing.rows[0].id,
        JSON.stringify(operationsAlert),
        receivedAt,
      ],
    );

    return existing.rows[0].id;
  }

  const inserted = await client.query(
    `
      INSERT INTO raw_alerts (
        source_tool,
        source_type,
        source_alert_id,
        raw_payload,
        processing_status,
        received_at
      )
      VALUES ('jira_operations', 'jira_operations_alert', $1, $2::jsonb, 'stored', $3)
      RETURNING id
    `,
    [
      sourceAlertId,
      JSON.stringify(operationsAlert),
      receivedAt,
    ],
  );

  return inserted.rows[0].id;
}

async function upsertOperationsIncident(client, incident) {
  await client.query(
    `
      INSERT INTO operations_incidents (
        incident_key,
        summary,
        description,
        reporter,
        priority,
        status,
        status_category,
        resolution,
        source_url,
        incident_created_at,
        incident_updated_at,
        closed_at,
        assignee,
        labels,
        linked_alerts,
        root_cause_notes,
        comments,
        attachments,
        custom_fields,
        incident_details,
        raw_payload,
        updated_at
      )
      VALUES (
        $1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10, $11,
        $12, $13::jsonb, $14::jsonb, $15::jsonb, $16::jsonb, $17::jsonb,
        $18::jsonb, $19::jsonb, $20::jsonb, $21::jsonb, NOW()
      )
      ON CONFLICT (incident_key)
      DO UPDATE SET
        summary = EXCLUDED.summary,
        description = EXCLUDED.description,
        reporter = EXCLUDED.reporter,
        priority = EXCLUDED.priority,
        status = EXCLUDED.status,
        status_category = EXCLUDED.status_category,
        resolution = EXCLUDED.resolution,
        source_url = EXCLUDED.source_url,
        incident_created_at = EXCLUDED.incident_created_at,
        incident_updated_at = EXCLUDED.incident_updated_at,
        closed_at = EXCLUDED.closed_at,
        assignee = EXCLUDED.assignee,
        labels = EXCLUDED.labels,
        linked_alerts = EXCLUDED.linked_alerts,
        root_cause_notes = EXCLUDED.root_cause_notes,
        comments = EXCLUDED.comments,
        attachments = EXCLUDED.attachments,
        custom_fields = EXCLUDED.custom_fields,
        incident_details = EXCLUDED.incident_details,
        raw_payload = EXCLUDED.raw_payload,
        updated_at = NOW()
    `,
    [
      incident.incidentKey,
      incident.summary,
      incident.description,
      JSON.stringify(incident.reporter),
      incident.priority,
      incident.status,
      incident.statusCategory,
      incident.resolution,
      incident.sourceUrl,
      incident.createdAt,
      incident.updatedAt,
      incident.closedAt,
      JSON.stringify(incident.assignee),
      JSON.stringify(incident.labels),
      JSON.stringify(incident.linkedAlerts),
      JSON.stringify(incident.rootCauseNotes),
      JSON.stringify(incident.comments),
      JSON.stringify(incident.attachments),
      JSON.stringify(incident.customFields),
      JSON.stringify(incident.incidentDetails),
      JSON.stringify(incident.rawPayload),
    ],
  );
}

async function getExistingOperationsIncidentKeys(client, incidentKeys = []) {
  const keys = [...new Set(incidentKeys.filter(Boolean))];

  if (keys.length === 0) {
    return new Set();
  }

  const result = await client.query(
    `
      SELECT incident_key
      FROM operations_incidents
      WHERE incident_key = ANY($1::text[])
    `,
    [keys],
  );

  return new Set(result.rows.map((row) => row.incident_key));
}

async function upsertJiraAlert(client, alert) {
  const existing = await client.query(
    `
      SELECT id
      FROM alerts
      WHERE id = $1
        OR (source_alert_id IS NOT NULL AND source_alert_id = $2)
        OR ($3::text IS NOT NULL AND jira_ticket_id = $3)
      ORDER BY
        CASE
          WHEN id = $1 THEN 0
          WHEN source_alert_id = $2 THEN 1
          ELSE 2
        END
      LIMIT 1
    `,
    [alert.id, alert.sourceAlertId, alert.jiraTicketId || null],
  );

  if (existing.rows[0]) {
    await client.query(
      `
        UPDATE alerts
        SET
          title = $2,
          service = $3,
          environment = $4,
          severity = $5,
          status = $6,
          source = $9,
          source_url = $10,
          source_type = $11,
          source_alert_id = $12,
          raw_payload = $13,
          extracted_details = COALESCE(alerts.extracted_details, '{}'::jsonb) || ($14::jsonb - 'classification'),
          duplicate_signature = $18,
          correlation_id = $19,
          last_seen_at = $20,
          occurrences = $21,
          owner = $22,
          signal = $23,
          description = $24,
          jira_ticket_id = $25,
          recurring_incident = $26,
          related_alerts = $27,
          updated_at = NOW()
        WHERE id = $1
      `,
      [
        existing.rows[0].id,
        alert.title,
        alert.service,
        alert.environment,
        alert.severity,
        alert.status,
        alert.classification,
        alert.noiseType,
        alert.source,
        alert.sourceUrl,
        alert.sourceType,
        alert.sourceAlertId,
        JSON.stringify(alert.rawPayload),
        JSON.stringify(alert.extractedDetails),
        alert.noiseReason,
        alert.classificationReason,
        alert.confidenceScore,
        alert.duplicateSignature,
        alert.correlationId,
        alert.lastSeenAt,
        alert.occurrences,
        alert.owner,
        alert.signal,
        alert.description,
        alert.jiraTicketId,
        alert.recurringIncident,
        JSON.stringify(alert.relatedAlerts),
      ],
    );

    return {
      alertId: existing.rows[0].id,
      result: 'updated',
    };
  }

  await client.query(
    `
      INSERT INTO alerts (
        id,
        title,
        service,
        environment,
        severity,
        status,
        classification,
        noise_type,
        source,
        source_type,
        source_alert_id,
        source_url,
        raw_payload,
        extracted_details,
        noise_reason,
        classification_reason,
        confidence_score,
        duplicate_signature,
        correlation_id,
        received_at,
        last_seen_at,
        occurrences,
        owner,
        signal,
        description,
        jira_ticket_id,
        recurring_incident,
        related_alerts
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
        $11, $12, $13, $14, $15, $16, $17, $18, $19,
        $20, $21, $22, $23, $24, $25, $26, $27, $28
      )
    `,
    [
      alert.id,
      alert.title,
      alert.service,
      alert.environment,
      alert.severity,
      alert.status,
      alert.classification,
      alert.noiseType,
      alert.source,
      alert.sourceType,
      alert.sourceAlertId,
      alert.sourceUrl,
      JSON.stringify(alert.rawPayload),
      JSON.stringify(alert.extractedDetails),
      alert.noiseReason,
      alert.classificationReason,
      alert.confidenceScore,
      alert.duplicateSignature,
      alert.correlationId,
      alert.receivedAt,
      alert.lastSeenAt,
      alert.occurrences,
      alert.owner,
      alert.signal,
      alert.description,
      alert.jiraTicketId,
      alert.recurringIncident,
      JSON.stringify(alert.relatedAlerts),
    ],
  );

  return {
    alertId: alert.id,
    result: 'inserted',
  };
}

async function syncIncidentForJiraAlert(client, alertId, alert) {
  if (alert.classification !== 'incident') {
    await client.query('DELETE FROM incidents WHERE alert_id = $1', [alertId]);
    return;
  }

  const incidentResult = await client.query(
    `
      INSERT INTO incidents (alert_id, recurring_incident, jira_ticket_id, updated_at)
      VALUES ($1, $2, $3, NOW())
      ON CONFLICT (alert_id)
      DO UPDATE SET
        recurring_incident = EXCLUDED.recurring_incident,
        jira_ticket_id = EXCLUDED.jira_ticket_id,
        updated_at = NOW()
      RETURNING id
    `,
    [alertId, alert.recurringIncident, alert.jiraTicketId],
  );

  await client.query(
    `
      INSERT INTO alert_incident_mappings (alert_id, incident_id, jira_ticket_id, mapping_reason)
      VALUES ($1, $2, $3, $4)
    `,
    [
      alertId,
      incidentResult.rows[0]?.id || null,
      alert.jiraTicketId,
      'Jira alert issue was classified as an incident after being stored in the backend.',
    ],
  );
}

async function linkAlertsToOperationsIncidents(client) {
  const alertsResult = await client.query(
    `
      SELECT id, source_alert_id, jira_ticket_id, extracted_details
      FROM alerts
      WHERE source_type IN ('jsm_operations_alert', 'jira_alert_issue', 'jira_operations_alert')
    `,
  );
  const incidentsResult = await client.query(
    `
      SELECT incident_key, linked_alerts
      FROM operations_incidents
    `,
  );
  let linked = 0;

  for (const alert of alertsResult.rows) {
    const alertKeys = new Set([
      alert.id,
      alert.source_alert_id,
      ...(alert.extracted_details?.alert?.alert_identifiers || []),
    ].filter(Boolean));
    const directIncidentKey = alert.jira_ticket_id;
    const matchingIncidents = incidentsResult.rows.filter((incident) => {
      if (directIncidentKey && incident.incident_key === directIncidentKey) {
        return true;
      }

      return (incident.linked_alerts || []).some((linkedAlert) => alertKeys.has(linkedAlert));
    });

    for (const incident of matchingIncidents) {
      await client.query(
        `
          INSERT INTO alert_incident_mappings (alert_id, incident_id, jira_ticket_id, mapping_reason)
          SELECT $1, NULL, $2, $3
          WHERE NOT EXISTS (
            SELECT 1
            FROM alert_incident_mappings
            WHERE alert_id = $1
              AND jira_ticket_id = $2
              AND mapping_reason = $3
          )
        `,
        [
          alert.id,
          incident.incident_key,
          'JSM Operations alert was linked to a stored Operations incident during enrichment.',
        ],
      );
      linked += 1;
    }
  }

  return linked;
}

async function updateRawJiraAlertStatus(client, rawAlertId, alertId, status, errorMessage = null) {
  if (!rawAlertId) {
    return;
  }

  await client.query(
    `
      UPDATE raw_alerts
      SET
        normalized_alert_id = $2,
        processing_status = $3,
        error_message = $4
      WHERE id = $1
    `,
    [rawAlertId, alertId, status, errorMessage],
  );
}

async function recordJiraClassification(client, alert, classifiedBy = 'system') {
  await client.query(
    `
      INSERT INTO alert_classification_history (
        alert_id,
        classification,
        noise_type,
        confidence_score,
        justification,
        noise_reason,
        classified_by
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `,
    [
      alert.id,
      alert.classification,
      alert.noise_type,
      alert.confidence_score,
      alert.classification_reason || 'Classification reason was not provided.',
      alert.noise_reason,
      classifiedBy,
    ],
  );
}

async function recordJiraCorrelation(client, alert, duplicateCount) {
  await client.query(
    `
      INSERT INTO alert_correlation_history (
        alert_id,
        duplicate_signature,
        correlation_id,
        duplicate_count,
        related_alerts
      )
      VALUES ($1, $2, $3, $4, $5)
    `,
    [
      alert.id,
      alert.duplicate_signature,
      alert.correlation_id,
      duplicateCount,
      JSON.stringify(alert.related_alerts || []),
    ],
  );
}

function applyJiraDecisionToDetails(details, decision, alertRow) {
  const existingDetails = details && typeof details === 'object' ? details : {};
  const confidence = Number.isFinite(Number(decision.confidenceScore))
    ? Number(decision.confidenceScore) / 100
    : null;
  const classification = {
    classification: decision.classification,
    label: decision.classification,
    confidence,
    justification: decision.justification,
    reason_codes: decision.reasonCodes || [],
    recommended_action: decision.recommendedAction,
    review_status: decision.reviewStatus,
    noise_type: decision.noiseType,
    noise_reason: decision.noiseReason,
  };

  return {
    ...existingDetails,
    classification,
    structured_alert: existingDetails.structured_alert
      ? {
          ...existingDetails.structured_alert,
          classification: {
            label: decision.classification,
            confidence,
            justification: decision.justification,
            reason_codes: decision.reasonCodes || [],
            recommended_action: decision.recommendedAction,
          },
          jira_incident_key: alertRow.jira_ticket_id || existingDetails.structured_alert.jira_incident_key || null,
        }
      : existingDetails.structured_alert,
    normalized_alert: {
      ...(existingDetails.normalized_alert || {}),
      classification: decision.classification,
      confidence,
      justification: decision.justification,
      reason_codes: decision.reasonCodes || [],
      recommended_action: decision.recommendedAction,
      review_status: decision.reviewStatus,
      duplicate_count: Number(alertRow.occurrences || 1),
      related_alerts: alertRow.related_alerts || [],
    },
    alert: {
      ...(existingDetails.alert || {}),
      classification: decision.classification,
      confidence,
      justification: decision.justification,
      reason_codes: decision.reasonCodes || [],
      recommended_action: decision.recommendedAction,
      duplicate_count: Number(alertRow.occurrences || 1),
      related_alerts: alertRow.related_alerts || [],
    },
  };
}

async function classifyStoredJiraAlert(client, alertId) {
  const currentResult = await client.query(
    `
      SELECT *
      FROM alerts
      WHERE id = $1
      FOR UPDATE
    `,
    [alertId],
  );
  const currentAlert = currentResult.rows[0];

  if (!currentAlert) {
    return null;
  }

  const matchingResult = await client.query(
    `
      SELECT *
      FROM alerts
      WHERE duplicate_signature = $1
      ORDER BY last_seen_at DESC
    `,
    [currentAlert.duplicate_signature],
  );
  const relatedAlerts = matchingResult.rows
    .map((row) => row.id)
    .filter((id) => id !== alertId)
    .slice(0, 20);
  const jiraFields = currentAlert.raw_payload?.fields || {};
  const details = currentAlert.extracted_details || {};
  const isOperationsAlert = currentAlert.source_type === 'jira_operations_alert';
  const fullText = isOperationsAlert
    ? collectOperationsAlertText(currentAlert.raw_payload || {})
    : collectIssueText(currentAlert.raw_payload || { key: alertId, fields: jiraFields });
  const decision = isOperationsAlert
    ? classifyOperationsAlertRecord({
        alert: currentAlert,
        rawAlert: currentAlert.raw_payload || {},
        text: fullText,
        duplicateCount: matchingResult.rows.length,
      })
    : classifyJiraAlertRecord({
        alert: {
          ...currentAlert,
          source: currentAlert.source,
          severity: currentAlert.severity,
          environment: currentAlert.environment,
        },
        fields: jiraFields,
        text: fullText,
        duplicateCount: matchingResult.rows.length,
        deepEventLink: details.normalized_alert?.deep_event_link || details.alert?.deep_event_link || currentAlert.source_url,
        linkedIncidentKey: currentAlert.jira_ticket_id || details.normalized_alert?.jira_incident_key || details.alert?.jira_incident_key,
      });
  const updatedDetails = applyJiraDecisionToDetails(
    details,
    decision,
    {
      ...currentAlert,
      related_alerts: relatedAlerts,
    },
  );
  const updatedResult = await client.query(
    `
      UPDATE alerts
      SET
        classification = $2,
        noise_type = $3,
        noise_reason = $4,
        classification_reason = $5,
        confidence_score = $6,
        related_alerts = $7::jsonb,
        extracted_details = $8::jsonb,
        updated_at = NOW()
      WHERE id = $1
      RETURNING *
    `,
    [
      alertId,
      decision.classification,
      decision.noiseType,
      decision.noiseReason,
      decision.justification,
      decision.confidenceScore,
      JSON.stringify(relatedAlerts),
      JSON.stringify(updatedDetails),
    ],
  );
  const updatedAlert = updatedResult.rows[0];

  await recordJiraClassification(client, updatedAlert, 'system');
  await recordJiraCorrelation(client, updatedAlert, matchingResult.rows.length);
  await syncIncidentForJiraAlert(client, alertId, {
    classification: updatedAlert.classification,
    recurringIncident: updatedAlert.recurring_incident,
    jiraTicketId: updatedAlert.jira_ticket_id,
  });

  return updatedAlert;
}

async function correlateStoredJiraAlert(client, alertId) {
  const currentResult = await client.query(
    `
      SELECT *
      FROM alerts
      WHERE id = $1
      FOR UPDATE
    `,
    [alertId],
  );
  const currentAlert = currentResult.rows[0];
  if (!currentAlert) return null;

  const matchingResult = await client.query(
    `
      SELECT id
      FROM alerts
      WHERE duplicate_signature = $1
      ORDER BY last_seen_at DESC
    `,
    [currentAlert.duplicate_signature],
  );
  const relatedAlerts = matchingResult.rows
    .map((row) => row.id)
    .filter((id) => id !== alertId)
    .slice(0, 20);
  const updatedResult = await client.query(
    `
      UPDATE alerts
      SET related_alerts = $2::jsonb, updated_at = NOW()
      WHERE id = $1
      RETURNING *
    `,
    [alertId, JSON.stringify(relatedAlerts)],
  );
  await recordJiraCorrelation(client, updatedResult.rows[0], matchingResult.rows.length);
  return updatedResult.rows[0];
}

async function importJiraIssueAlerts(options = {}) {
  console.log('JSM Operations alert import started.');
  const resolvedOptions = await resolveBackfillOptions(options);
  await ensureJiraAlertColumns();
  const syncRunId = await startSyncRun(resolvedOptions);
  let client = null;

  try {
    const { config, issues, jql } = await fetchJiraAlertIssues(resolvedOptions);
    const incidentsResult = await fetchJiraIncidentIssuesWithFallback(resolvedOptions, config);
    const fieldLookup = await fetchJiraFieldLookup(config);
    const normalizedIncidents = incidentsResult.issues.map((issue) => normalizeIncidentIssue(issue, config, fieldLookup));
    const incidentLookup = new Map(normalizedIncidents.map((incident) => [incident.incidentKey, incident]));
    const summary = {
      source: 'jsm_operations',
      mode: resolvedOptions.incremental ? 'incremental_refresh' : 'historical_backfill',
      range: resolvedOptions.range || 'all',
      from: resolvedOptions.from || null,
      to: resolvedOptions.to || null,
      updatedFrom: resolvedOptions.updatedFrom || null,
      totalFetched: issues.length,
      incidentsFetched: normalizedIncidents.length,
      incidentsStored: 0,
      incidentLinksCreated: 0,
      inserted: 0,
      updated: 0,
      skipped: 0,
      errors: [],
    };
    client = await db.pool.connect();
    await client.query('BEGIN');
    await ensureJiraAlertColumns(client);
    const existingIncidentKeys = await getExistingOperationsIncidentKeys(
      client,
      normalizedIncidents.map((incident) => incident.incidentKey),
    );

    for (const incident of normalizedIncidents) {
      const result = existingIncidentKeys.has(incident.incidentKey) ? 'updated' : 'inserted';

      await upsertOperationsIncident(client, incident);
      summary.incidentsStored += 1;
      summary[result] += 1;
      existingIncidentKeys.add(incident.incidentKey);
    }

    for (const issue of issues) {
      let rawAlertId = null;

      try {
        if (incidentLookup.has(issue.key) || isIncidentIssue(issue)) {
          summary.skipped += 1;
          console.log(`JSM Operations issue ${issue.key} skipped as alert because it is an incident record.`);
          continue;
        }

        rawAlertId = await upsertRawJiraAlert(client, issue);
        const alert = normalizeIssue(issue, config, incidentLookup, fieldLookup);
        const { alertId, result } = await upsertJiraAlert(client, alert);

        await updateRawJiraAlertStatus(client, rawAlertId, alertId, 'normalized');
        await correlateStoredJiraAlert(client, alertId);
        summary[result] += 1;
        console.log(`Jira alert issue ${issue.key} ${result}.`);
      } catch (error) {
        if (rawAlertId) {
          await updateRawJiraAlertStatus(client, rawAlertId, null, 'normalization_failed', error.message);
        }

        summary.skipped += 1;
        summary.errors.push({
          issueKey: issue.key,
          message: error.message,
        });
        console.error(`Jira alert issue ${issue.key} skipped: ${error.message}`);
      }
    }

    summary.incidentLinksCreated = await linkAlertsToOperationsIncidents(client);
    await client.query('COMMIT');
    const cursorValue = getSyncCursorFromIssues(issues, incidentsResult.issues);

    await finishSyncRun(syncRunId, summary, cursorValue);
    summary.syncRunId = syncRunId;
    summary.cursorValue = cursorValue;
    console.log(`JSM Operations alert import completed. alerts=${summary.totalFetched} incidents=${summary.incidentsFetched} inserted=${summary.inserted} updated=${summary.updated} skipped=${summary.skipped}`);

    return {
      jql,
      incidentsJql: incidentsResult.jql,
      ...summary,
    };
  } catch (error) {
    if (client) {
      await client.query('ROLLBACK');
    }
    await failSyncRun(syncRunId, error);
    throw error;
  } finally {
    if (client) {
      client.release();
    }
  }
}

async function importJiraIncidents(options = {}) {
  console.log('Jira incident-only backfill started.');
  const resolvedOptions = await resolveBackfillOptions({
    ...options,
    chronological: !options.incremental,
    syncName: JIRA_INCIDENTS_SYNC_NAME,
    syncSource: 'Jira Incident Tickets',
  });
  await ensureJiraAlertColumns();
  const syncRunId = await startSyncRun({
    ...resolvedOptions,
    source: 'jira_operations_incidents_api',
    dataset: 'incidents_only',
  });
  let client = null;

  try {
    const config = await getJsmOperationsRuntimeConfig();
    const incidentsResult = await fetchJiraIncidentIssuesWithFallback(resolvedOptions, config);
    const fieldLookup = await fetchJiraFieldLookup(config);
    const normalizedIncidents = incidentsResult.issues.map((issue) => (
      normalizeIncidentIssue(issue, config, fieldLookup)
    ));
    const issueSummary = summarizeJiraIssues(incidentsResult.issues);
    const summary = {
      source: 'jira_incidents',
      mode: resolvedOptions.incremental ? 'incremental_refresh' : 'historical_backfill',
      range: resolvedOptions.range || 'all',
      from: resolvedOptions.from || null,
      to: resolvedOptions.to || null,
      updatedFrom: resolvedOptions.updatedFrom || null,
      syncName: JIRA_INCIDENTS_SYNC_NAME,
      syncSource: 'Jira Incident Tickets',
      primaryJql: incidentsResult.primaryJql || incidentsResult.jql,
      fallbackUsed: Boolean(incidentsResult.fallbackUsed),
      totalFetched: 0,
      incidentsFetched: normalizedIncidents.length,
      incidentsStored: 0,
      incidentLinksCreated: 0,
      inserted: 0,
      updated: 0,
      skipped: 0,
      errors: [],
      ...issueSummary,
    };

    client = await db.pool.connect();
    await client.query('BEGIN');
    await ensureJiraAlertColumns(client);
    const existingIncidentKeys = await getExistingOperationsIncidentKeys(
      client,
      normalizedIncidents.map((incident) => incident.incidentKey),
    );

    for (const incident of normalizedIncidents) {
      const result = existingIncidentKeys.has(incident.incidentKey) ? 'updated' : 'inserted';

      await upsertOperationsIncident(client, incident);
      summary.incidentsStored += 1;
      summary[result] += 1;
      existingIncidentKeys.add(incident.incidentKey);
    }

    summary.incidentLinksCreated = await linkAlertsToOperationsIncidents(client);
    await client.query('COMMIT');
    const cursorValue = getSyncCursorFromIssues([], incidentsResult.issues);

    await finishSyncRun(syncRunId, summary, cursorValue);
    summary.syncRunId = syncRunId;
    summary.cursorValue = cursorValue;
    console.log(`Jira incident-only backfill completed. incidents=${summary.incidentsFetched} stored=${summary.incidentsStored}`);

    return {
      incidentsJql: incidentsResult.jql,
      primaryJql: incidentsResult.primaryJql || incidentsResult.jql,
      fallbackUsed: Boolean(incidentsResult.fallbackUsed),
      ...summary,
    };
  } catch (error) {
    if (client) {
      await client.query('ROLLBACK');
    }
    await failSyncRun(syncRunId, error);
    throw error;
  } finally {
    if (client) {
      client.release();
    }
  }
}

async function importOperationsAlerts(options = {}) {
  await ensureJiraAlertColumns();
  const syncRunId = await startSyncRun({
    ...options,
    source: 'jira_operations_alerts_api',
  });
  let client = null;

  try {
    const { config, alerts, query } = await fetchOperationsAlerts(options);
    const incidentsResult = await fetchOptionalJiraIncidentIssues(options);
    const normalizedIncidents = incidentsResult.issues.map((issue) => (
      normalizeIncidentIssue(issue, incidentsResult.config, incidentsResult.fieldLookup)
    ));
    const tinyIds = alerts
      .map((alert) => Number(alert.tinyId || alert.tiny_id))
      .filter(Number.isFinite);
    const summary = {
      source: 'jira_operations',
      mode: options.incremental ? 'incremental_refresh' : 'historical_backfill',
      range: options.range || 'all',
      from: options.from || null,
      to: options.to || null,
      totalFetched: alerts.length,
      minTinyId: tinyIds.length > 0 ? Math.min(...tinyIds) : null,
      maxTinyId: tinyIds.length > 0 ? Math.max(...tinyIds) : null,
      incidentsFetched: normalizedIncidents.length,
      incidentsStored: 0,
      incidentLinksCreated: 0,
      inserted: 0,
      updated: 0,
      skipped: 0,
      errors: [],
    };

    client = await db.pool.connect();
    await client.query('BEGIN');
    await ensureJiraAlertColumns(client);

    for (const incident of normalizedIncidents) {
      await upsertOperationsIncident(client, incident);
      summary.incidentsStored += 1;
    }

    for (const operationsAlert of alerts) {
      let rawAlertId = null;
      const sourceAlertId = getOperationsSourceAlertId(operationsAlert) || buildOperationsAlertId(operationsAlert);

      try {
        rawAlertId = await upsertRawOperationsAlert(client, operationsAlert);
        const alert = normalizeOperationsAlert(operationsAlert, config);
        const { alertId, result } = await upsertJiraAlert(client, alert);

        await updateRawJiraAlertStatus(client, rawAlertId, alertId, 'normalized');
        await correlateStoredJiraAlert(client, alertId);
        summary[result] += 1;
        console.log(`JSM Operations alert ${sourceAlertId} ${result}.`);
      } catch (error) {
        if (rawAlertId) {
          await updateRawJiraAlertStatus(client, rawAlertId, null, 'normalization_failed', error.message);
        }

        summary.skipped += 1;
        summary.errors.push({
          sourceAlertId,
          message: error.message,
        });
        console.error(`JSM Operations alert ${sourceAlertId} skipped: ${error.message}`);
      }
    }

    summary.incidentLinksCreated = await linkAlertsToOperationsIncidents(client);
    await client.query('COMMIT');
    const cursorValue = alerts
      .map((alert) => alert.updatedAt || alert.createdAt || alert.lastOccurredAt)
      .map((value) => new Date(value || '').getTime())
      .filter(Number.isFinite)
      .sort((a, b) => b - a)[0];
    const cursorIso = Number.isFinite(cursorValue) ? new Date(cursorValue).toISOString() : null;

    await finishSyncRun(syncRunId, summary, cursorIso);
    summary.syncRunId = syncRunId;
    summary.cursorValue = cursorIso;
    console.log(`JSM Operations alert import completed. fetched=${summary.totalFetched} inserted=${summary.inserted} updated=${summary.updated} skipped=${summary.skipped}`);

    return {
      query,
      incidentsJql: incidentsResult.jql,
      incidentImportError: incidentsResult.error || null,
      ...summary,
    };
  } catch (error) {
    if (client) {
      await client.query('ROLLBACK');
    }
    await failSyncRun(syncRunId, error);
    throw error;
  } finally {
    if (client) {
      client.release();
    }
  }
}

async function hasOperationsAlertApiConfig() {
  try {
    await getOperationsAlertRuntimeConfig();
    return true;
  } catch (error) {
    if (error.status && error.status !== 404) {
      throw error;
    }

    return false;
  }
}

async function importJiraAlertIssues(options = {}) {
  if (await hasOperationsAlertApiConfig()) {
    return importOperationsAlerts(options);
  }

  try {
    await getJsmOperationsRuntimeConfig();
    return importJiraIssueAlerts(options);
  } catch (error) {
    if (error.status && error.status !== 404) {
      throw error;
    }
  }

  const configError = new Error(
    'Operations alert import is not configured. Configure JIRA_BASE_URL, JIRA_EMAIL, and JIRA_API_TOKEN. ACC/Jira project JQL is only for incidents and must not be treated as the full #number alert source.',
  );
  configError.status = 400;
  throw configError;
}

async function getStatus() {
  let config;

  try {
    config = await getJiraRuntimeConfig();
  } catch (error) {
    return {
      configured: false,
      reachable: false,
      message: error.message,
    };
  }

  const projectUrl = integrationService.buildJiraApiUrl(
    config.baseUrl,
    `/rest/api/3/project/${encodeURIComponent(config.projectKey)}`,
  );

  try {
    const response = await fetchWithTimeout(projectUrl, {
      headers: {
        Accept: 'application/json',
        Authorization: integrationService.buildBasicAuthHeader(config.email, config.apiToken),
      },
    });
    const payload = await readJsonResponse(response);

    if (response.ok) {
      return {
        configured: true,
        reachable: true,
        baseUrl: config.baseUrl,
        projectKey: config.projectKey,
        source: config.source,
        message: `Jira connection successful. Project ${config.projectKey} is reachable.`,
      };
    }

    return {
      configured: true,
      reachable: false,
      baseUrl: config.baseUrl,
      projectKey: config.projectKey,
      source: config.source,
      message: getIssueErrorMessage(response, payload),
    };
  } catch (error) {
    return {
      configured: true,
      reachable: false,
      baseUrl: config.baseUrl,
      projectKey: config.projectKey,
      source: config.source,
      message: getNetworkErrorMessage(error, config.baseUrl),
    };
  }
}

function toAtlassianDocument(text) {
  const lines = String(text).split('\n');

  return {
    type: 'doc',
    version: 1,
    content: lines.map((line) => ({
      type: 'paragraph',
      content: line ? [{ type: 'text', text: line }] : [],
    })),
  };
}

function buildIssuePayload(config, alert) {
  const issueType = config.credentials.issueType?.trim() || 'Task';

  return {
    fields: {
      project: {
        key: config.accountIdentifier,
      },
      issuetype: {
        name: issueType,
      },
      summary: normalizeSummary(alert),
      description: toAtlassianDocument(buildDescriptionText(alert)),
      labels: buildLabels(alert),
    },
  };
}

function getJiraErrorMessage(response, bodyText) {
  let parsed = null;

  try {
    parsed = bodyText ? JSON.parse(bodyText) : null;
  } catch {
    parsed = null;
  }

  const errorMessages = [
    ...(parsed?.errorMessages || []),
    ...Object.values(parsed?.errors || {}),
  ].filter(Boolean);

  if (response.status === 400 || response.status === 422) {
    return errorMessages.length > 0
      ? `Jira could not create the issue: ${errorMessages.join(' ')}`
      : 'Jira could not create the issue. Check project key, issue type, and required Jira fields.';
  }

  if (response.status === 401 || response.status === 403) {
    return 'Jira rejected the email/API token or the account does not have permission to create issues.';
  }

  if (response.status === 404) {
    return 'Jira project or create issue endpoint was not found. Check the Jira site URL and project key.';
  }

  return errorMessages.length > 0
    ? `Jira returned HTTP ${response.status}: ${errorMessages.join(' ')}`
    : `Jira returned HTTP ${response.status} while creating the issue.`;
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), JIRA_TIMEOUT_MS);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

function getNetworkErrorMessage(error, baseUrl) {
  const code = error.cause?.code || error.code;
  const detail = error.cause?.message || error.message;

  if (error.name === 'AbortError') {
    return 'Jira request timed out. Check VPN/network access and confirm the Jira site is reachable.';
  }

  if (
    code === 'SELF_SIGNED_CERT_IN_CHAIN' ||
    code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
    code === 'CERT_HAS_EXPIRED'
  ) {
    return 'Jira SSL certificate could not be verified. This can happen with corporate proxies or internal certificates.';
  }

  if (code === 'ENOTFOUND') {
    return `Jira host could not be found. Check the Jira site URL: ${baseUrl}`;
  }

  if (code === 'ECONNREFUSED') {
    return `Jira refused the connection. Check whether Jira is reachable: ${baseUrl}`;
  }

  return `Unable to reach Jira from the backend. ${code ? `Error: ${code}.` : `Detail: ${detail}`}`;
}

async function createIssueForAlert(alert) {
  const config = await integrationService.getIntegrationRuntimeConfig('jira');

  if (!config.isEnabled) {
    const error = new Error('Jira integration is saved but disabled. Enable it in Settings before creating incidents.');
    error.status = 400;
    throw error;
  }

  const apiUrl = integrationService.buildJiraApiUrl(config.baseUrl, '/rest/api/3/issue');

  if (!apiUrl) {
    const error = new Error('Jira site URL is invalid. Update the Jira integration in Settings.');
    error.status = 400;
    throw error;
  }

  try {
    const response = await fetchWithTimeout(apiUrl, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: integrationService.buildBasicAuthHeader(
          config.credentials.email,
          config.credentials.apiToken,
        ),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(buildIssuePayload(config, alert)),
    });
    const bodyText = await response.text();

    if (!response.ok) {
      const error = new Error(getJiraErrorMessage(response, bodyText));
      error.status = response.status >= 500 ? 502 : 400;
      throw error;
    }

    const payload = bodyText ? JSON.parse(bodyText) : {};

    if (!payload.key) {
      const error = new Error('Jira created a response without an issue key. Check Jira manually before retrying.');
      error.status = 502;
      throw error;
    }

    return payload.key;
  } catch (error) {
    if (error.status) {
      throw error;
    }

    const networkError = new Error(getNetworkErrorMessage(error, config.baseUrl));
    networkError.status = 502;
    throw networkError;
  }
}

module.exports = {
  createIssueForAlert,
  getBackfillStatus,
  getIssueDetails,
  getStatus,
  importJiraIncidents,
  importJiraAlertIssues,
};
