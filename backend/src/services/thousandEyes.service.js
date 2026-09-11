const db = require('../config/db');
const integrationService = require('./integration.service');

const REQUEST_TIMEOUT_MS = Number(process.env.THOUSANDEYES_TIMEOUT_MS || 12000);
const POLL_INTERVAL_MS = Number(process.env.THOUSANDEYES_POLL_INTERVAL_MS || 30000);
const METRIC_RESULT_LIMIT = Math.max(0, Number(process.env.THOUSANDEYES_METRIC_RESULT_LIMIT || 500));
const METRIC_CONCURRENCY = Math.max(1, Number(process.env.THOUSANDEYES_METRIC_CONCURRENCY || 8));
const POLL_METRICS = /^true$/i.test(process.env.THOUSANDEYES_POLL_METRICS || 'false');
const DEFAULT_BASE_URL = 'https://api.thousandeyes.com/v7';
let pollIntervalId = null;
let syncInFlight = false;

const TEST_TYPE_ENDPOINTS = [
  'http-server',
  'page-load',
  'web-transactions',
  'transaction',
  'api',
  'network',
  'dns-server',
  'dns-trace',
  'ftp-server',
  'agent-to-agent',
];

function normalizeBaseUrl(baseUrl) {
  return String(baseUrl || DEFAULT_BASE_URL).trim().replace(/\/+$/, '');
}

function appendAccountGroup(url, accountGroupId) {
  if (!accountGroupId) {
    return url;
  }

  const target = new URL(url);
  target.searchParams.set('aid', accountGroupId);
  return target.toString();
}

function buildUrl(baseUrl, path, params = {}, accountGroupId = null) {
  const url = new URL(path.replace(/^\/+/, ''), `${normalizeBaseUrl(baseUrl)}/`);

  Object.entries(params).forEach(([key, value]) => {
    if (value !== null && value !== undefined && value !== '') {
      url.searchParams.set(key, String(value));
    }
  });

  return appendAccountGroup(url.toString(), accountGroupId);
}

function buildAbsoluteUrl(href, config, params = {}) {
  const url = new URL(href, `${normalizeBaseUrl(config.baseUrl)}/`);

  Object.entries(params).forEach(([key, value]) => {
    if (value !== null && value !== undefined && value !== '') {
      url.searchParams.set(key, String(value));
    }
  });

  return appendAccountGroup(url.toString(), config.accountGroupId);
}

function buildAuthHeaders(token) {
  return {
    Accept: 'application/hal+json, application/json',
    Authorization: `Bearer ${token}`,
  };
}

async function fetchJson(url, token) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const startedAt = Date.now();

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: buildAuthHeaders(token),
    });
    let payload = null;

    try {
      payload = await response.json();
    } catch {
      payload = null;
    }

    if (!response.ok) {
      const error = new Error(
        response.status === 401 || response.status === 403
          ? 'ThousandEyes rejected the token or the token is missing required permissions.'
          : response.status === 429
            ? 'ThousandEyes rate limit reached. Retry after the API window resets.'
            : `ThousandEyes API returned HTTP ${response.status}.`,
      );
      error.status = response.status === 401 || response.status === 403 ? 401 : 502;
      error.vendorStatus = response.status;
      error.payload = payload;
      throw error;
    }

    return {
      payload,
      responseTimeMs: Date.now() - startedAt,
    };
  } catch (error) {
    if (error.name === 'AbortError') {
      const timeoutError = new Error('ThousandEyes API request timed out. Check VPN, proxy, or API reachability.');
      timeoutError.status = 504;
      throw timeoutError;
    }

    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function getRuntimeConfig() {
  const environmentToken =
    process.env.THOUSANDEYES_API_TOKEN ||
    process.env.THOUSANDEYES_OAUTH_BEARER_TOKEN ||
    process.env.THOUSANDEYES_ACCESS_TOKEN;

  if (environmentToken) {
    return {
      baseUrl: normalizeBaseUrl(process.env.THOUSANDEYES_BASE_URL || DEFAULT_BASE_URL),
      accountGroupId: process.env.THOUSANDEYES_ACCOUNT_GROUP_ID || process.env.THOUSANDEYES_AID || null,
      token: environmentToken,
      source: 'environment',
    };
  }

  try {
    const config = await integrationService.getIntegrationRuntimeConfig('thousandeyes');
    const token = config.credentials.token || config.credentials.apiToken || config.credentials.accessToken;

    if (!config.baseUrl || !token) {
      const error = new Error('ThousandEyes base URL or token is missing.');
      error.status = 400;
      throw error;
    }

    return {
      baseUrl: normalizeBaseUrl(config.baseUrl),
      accountGroupId: config.accountIdentifier,
      token,
      source: 'integration',
    };
  } catch (error) {
    const token = environmentToken;

    if (!process.env.THOUSANDEYES_BASE_URL && !token) {
      throw error;
    }

    if (!token) {
      const envError = new Error('THOUSANDEYES_ACCESS_TOKEN or THOUSANDEYES_API_TOKEN is missing.');
      envError.status = 400;
      throw envError;
    }

    return {
      baseUrl: normalizeBaseUrl(process.env.THOUSANDEYES_BASE_URL || DEFAULT_BASE_URL),
      accountGroupId: process.env.THOUSANDEYES_ACCOUNT_GROUP_ID || process.env.THOUSANDEYES_AID || null,
      token,
      source: 'environment',
    };
  }
}

async function requestApi(path, params = {}) {
  const config = await getRuntimeConfig();
  const url = buildUrl(config.baseUrl, path, params, config.accountGroupId);
  const result = await fetchJson(url, config.token);

  return {
    payload: result.payload,
    responseTimeMs: result.responseTimeMs,
    config: {
      baseUrl: config.baseUrl,
      accountGroupId: config.accountGroupId,
      source: config.source,
    },
  };
}

function toArray(value) {
  if (!value) {
    return [];
  }

  if (Array.isArray(value)) {
    return value.filter(Boolean);
  }

  return [value];
}

function extractItems(payload, keys = []) {
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

  return payload && typeof payload === 'object' ? [payload] : [];
}

function getNextPageUrl(payload, currentUrl) {
  const next =
    payload?.next ||
    payload?.nextPage ||
    payload?.next_page ||
    payload?.links?.next ||
    payload?._links?.next?.href ||
    payload?.pagination?.next ||
    payload?.pages?.next;

  if (!next) {
    return null;
  }

  try {
    return new URL(next, currentUrl).toString();
  } catch {
    return null;
  }
}

async function fetchPaginated(startUrl, token, keys = [], options = {}) {
  const items = [];
  let url = startUrl;
  let pages = 0;
  const maxPages = options.maxPages || 100;
  let responseTimeMs = 0;
  let lastPayload = null;

  while (url && pages < maxPages) {
    const response = await fetchJson(url, token);
    lastPayload = response.payload;
    responseTimeMs = Math.max(responseTimeMs, response.responseTimeMs || 0);
    items.push(...extractItems(response.payload, keys));
    pages += 1;
    url = getNextPageUrl(response.payload, url);
  }

  return {
    items,
    pages,
    responseTimeMs,
    rawPayload: lastPayload,
  };
}

function firstValue(...values) {
  return values.find((value) => value !== null && value !== undefined && value !== '');
}

function toNumber(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }

  const match = String(value).replace(/,/g, '').match(/-?\d+(\.\d+)?/);

  return match ? Number(match[0]) : null;
}

function normalizeLookupKey(key) {
  return String(key || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function findFirstNumeric(input, keys, maxDepth = 5) {
  const wanted = keys.map(normalizeLookupKey);
  const queue = [{ value: input, depth: 0 }];
  const seen = new Set();

  while (queue.length) {
    const { value, depth } = queue.shift();

    if (!value || typeof value !== 'object' || depth > maxDepth || seen.has(value)) {
      continue;
    }

    seen.add(value);

    for (const [key, child] of Object.entries(value)) {
      const normalizedKey = normalizeLookupKey(key);
      const keyMatches = wanted.some((candidate) => (
        normalizedKey === candidate ||
        (candidate.length >= 5 && normalizedKey.endsWith(candidate)) ||
        (candidate.length >= 8 && normalizedKey.includes(candidate))
      ));

      if (keyMatches) {
        const numberValue = toNumber(child);

        if (numberValue !== null) {
          return numberValue;
        }
      }

      if (child && typeof child === 'object') {
        queue.push({ value: child, depth: depth + 1 });
      }
    }
  }

  return null;
}

function getTimestamp(item) {
  const value = firstValue(
    item?.date,
    item?.timestamp,
    item?.roundDate,
    item?.startTime,
    item?.endTime,
    item?.createdAt,
    item?.createdDate,
    item?.updatedAt,
    item?.modifiedDate,
  );

  return value || null;
}

function isValidDate(value) {
  return value && !Number.isNaN(new Date(value).getTime());
}

function sortByNewestTimestamp(items) {
  return [...items].sort((left, right) => {
    const leftTime = Date.parse(getTimestamp(left) || 0) || 0;
    const rightTime = Date.parse(getTimestamp(right) || 0) || 0;

    return rightTime - leftTime;
  });
}

function getResultItems(results) {
  return Array.isArray(results) ? sortByNewestTimestamp(results) : [];
}

function getDefaultResultRange(options = {}) {
  if (options.from || options.to) {
    return {
      from: options.from,
      to: options.to,
    };
  }

  return {
    from: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    to: new Date().toISOString(),
  };
}

function extractMetricSnapshot(results = []) {
  const items = getResultItems(results);
  const latest = items[0] || {};
  const responseCode = toNumber(latest.responseCode || latest.httpStatus || latest.statusCode);
  const errorText = String(firstValue(latest.errorType, latest.error, latest.errorDetails, '')).trim().toLowerCase();
  const hasErrorText = errorText && !['none', 'ok', 'success', 'no error', 'no errors'].includes(errorText);
  const availability = firstValue(
    findFirstNumeric(latest, ['availabilityPercent', 'availabilityPct', 'availability']),
    toNumber(latest.healthScore) !== null && Number(latest.healthScore) <= 1 ? Number(latest.healthScore) * 100 : null,
    responseCode !== null ? (responseCode >= 200 && responseCode < 400 ? 100 : 0) : null,
    typeof latest.available === 'boolean' ? (latest.available ? 100 : 0) : null,
  );
  const errorCount = firstValue(
    findFirstNumeric(latest, ['errorCount', 'numErrors', 'errors']),
    hasErrorText ? 1 : 0,
  );
  const responseTime = findFirstNumeric(latest, [
    'responseTimeMs',
    'responseTime',
    'httpResponseTime',
    'serverResponseTime',
    'totalTime',
    'loadTime',
  ]);
  const latency = findFirstNumeric(latest, ['avgLatency', 'latency', 'roundTripTime', 'rtt']);
  const packetLoss = findFirstNumeric(latest, ['packetLossPercentage', 'packetLoss', 'loss']);
  const lastRunAt = getTimestamp(latest);

  return {
    availability,
    errorCount,
    responseTime,
    latency,
    packetLoss,
    lastRunAt: isValidDate(lastRunAt) ? lastRunAt : null,
    lastUpdatedAt: isValidDate(lastRunAt) ? lastRunAt : null,
    monitoringTimestamp: new Date().toISOString(),
    latestResult: latest,
  };
}

function buildHistoricalMetrics(results = []) {
  return getResultItems(results).slice(0, 50).map((result, index) => {
    const snapshot = extractMetricSnapshot([result]);

    return {
      id: firstValue(result.roundId, result.agentId, result.locationId, index),
      timestamp: snapshot.lastRunAt || getTimestamp(result),
      availability: snapshot.availability,
      errorCount: snapshot.errorCount,
      responseTime: snapshot.responseTime,
      latency: snapshot.latency,
      packetLoss: snapshot.packetLoss,
      agentName: firstValue(result.agentName, result.agent?.agentName, result.locationName),
    };
  });
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker()),
  );

  return results;
}

function normalizeStatus(value, activeValue) {
  const rawValue = firstValue(value, activeValue);
  const normalized = rawValue === null || rawValue === undefined ? '' : String(rawValue).toLowerCase();

  if (['active', 'triggered', 'firing', 'open', 'alerting'].includes(normalized)) {
    return 'critical';
  }

  if (['warning', 'warn'].includes(normalized)) {
    return 'warning';
  }

  if (['resolved', 'inactive', 'cleared', 'closed', 'ok', 'normal'].includes(normalized)) {
    return 'ok';
  }

  return normalized || 'unknown';
}

function normalizeSeverity(value, status) {
  const normalized = String(value || status || '').toLowerCase();

  if (['critical', 'crit', 'active', 'triggered', 'firing'].includes(normalized)) {
    return 'critical';
  }

  if (['warning', 'warn'].includes(normalized)) {
    return 'warning';
  }

  if (['medium', 'minor'].includes(normalized)) {
    return 'medium';
  }

  return 'low';
}

function severityRank(severity) {
  return {
    critical: 4,
    warning: 3,
    medium: 2,
    low: 1,
  }[severity] || 0;
}

function statusRank(status) {
  return {
    critical: 5,
    warning: 4,
    unknown: 3,
    pending: 2,
    ok: 1,
  }[status] || 0;
}

function getAlertId(alert) {
  return String(firstValue(
    alert.id,
    alert.alertId,
    alert.alert_id,
    alert.alertGroupId,
    alert.alertGroupID,
    alert.ruleId,
    alert.ruleID,
    alert.alertRuleId,
    alert.permalink,
    alert.url,
    alert.name,
  ) || 'unknown-alert');
}

function getTestId(testOrAlert) {
  return String(firstValue(
    testOrAlert.testId,
    testOrAlert.testID,
    testOrAlert.id,
    testOrAlert.test?.testId,
    testOrAlert.test?.id,
  ) || '');
}

function getTestName(item) {
  return firstValue(
    item.testName,
    item.test?.testName,
    item.test?.name,
    item.name,
    item.ruleName,
    item.alertName,
    item.target,
    'ThousandEyes',
  );
}

function getThousandEyesAppBaseUrl(config) {
  try {
    const url = new URL(config.baseUrl);
    const hostname = url.hostname.replace(/^api\./i, 'app.');

    return `${url.protocol}//${hostname}`;
  } catch {
    return 'https://app.thousandeyes.com';
  }
}

function buildThousandEyesTestLink(item, config) {
  const testId = getTestId(item);

  if (!testId) {
    return null;
  }

  const testType = String(firstValue(item.testType, item.type, item.testTypeName, 'tests')).toLowerCase();
  const path = testType.includes('page')
    ? '/web/page-load'
    : testType.includes('http')
      ? '/web/http-server'
      : '/tests';
  const url = new URL(path, getThousandEyesAppBaseUrl(config));

  if (config.accountGroupId) {
    url.searchParams.set('__a', config.accountGroupId);
  }

  url.searchParams.set('testId', testId);

  return url.toString();
}

function getDeepLink(item, config) {
  return firstValue(
    item?._links?.appLink?.href,
    item?.links?.appLink,
    item?.appLink,
    item.permalink,
    item.deepLink,
    item.deep_link,
    buildThousandEyesTestLink(item, config),
    item.links?.self,
    item._links?.self?.href,
    item.test?.permalink,
    item.test?.url,
    item.url,
    getThousandEyesAppBaseUrl(config),
  );
}

function getTestResultLinks(test, config, options = {}) {
  const rawLinks = [
    test?._links?.testResults,
    test?.links?.testResults,
    test?.testResultsLink,
    test?.testResultsUrl,
    test?.resultsUrl,
  ].flatMap(toArray);

  return [...new Set(rawLinks
    .map((link) => (typeof link === 'string' ? link : firstValue(link?.href, link?.url)))
    .filter(Boolean)
    .map((href) => buildAbsoluteUrl(href, config, {
      from: options.from,
      to: options.to,
    })))];
}

function buildAlertSummaryByTest(alertRecords) {
  const summaries = new Map();

  alertRecords.forEach((record) => {
    const custom = record.customProperties || {};
    const keys = [custom.testId, custom.testName, record.applicationName].filter(Boolean);
    const active = Boolean(custom.active) && !['ok', 'resolved', 'closed'].includes(record.status);

    keys.forEach((key) => {
      const existing = summaries.get(String(key)) || {
        alertCount: 0,
        activeAlerts: 0,
        highestSeverity: 'low',
        status: 'ok',
        alertTriggeredAt: null,
        alertClearedAt: null,
        alertHistory: [],
      };

      existing.alertCount += 1;
      existing.activeAlerts += active ? 1 : 0;
      existing.highestSeverity =
        severityRank(record.severity) > severityRank(existing.highestSeverity)
          ? record.severity
          : existing.highestSeverity;
      if (statusRank(record.status) > statusRank(existing.status)) {
        existing.status = record.status;
      }
      existing.alertTriggeredAt = [existing.alertTriggeredAt, custom.startedAt, record.lastCheck]
        .filter(Boolean)
        .sort()
        .at(-1) || null;
      existing.alertClearedAt = [existing.alertClearedAt, custom.endedAt]
        .filter(Boolean)
        .sort()
        .at(-1) || null;
      existing.alertHistory = [
        {
          alertId: custom.alertId || record.entityId,
          summary: record.summary,
          status: record.status,
          severity: record.severity,
          startedAt: custom.startedAt || record.lastCheck,
          endedAt: custom.endedAt || null,
          deepLink: record.deepLink,
        },
        ...existing.alertHistory,
      ].slice(0, 25);

      summaries.set(String(key), existing);
    });
  });

  return summaries;
}

function getAlertSummaryForTest(test, summaries) {
  const testId = getTestId(test);
  const testName = getTestName(test);

  return summaries.get(String(testId)) || summaries.get(String(testName)) || {
    alertCount: 0,
    activeAlerts: 0,
    highestSeverity: 'low',
    status: 'ok',
    alertTriggeredAt: null,
    alertClearedAt: null,
    alertHistory: [],
  };
}

function deriveTestStatus(test, alertSummary, metricSnapshot) {
  if (Number(alertSummary.activeAlerts || 0) > 0) {
    return normalizeStatus(alertSummary.status, 'active');
  }

  if (test.enabled === false) {
    return 'pending';
  }

  const explicitStatus = normalizeStatus(test.status || test.state || test.health || test.enabledState);

  if (explicitStatus && explicitStatus !== 'unknown') {
    return explicitStatus;
  }

  const availability = toNumber(metricSnapshot.availability);
  const errorCount = toNumber(metricSnapshot.errorCount);

  if (availability !== null && availability < 95) {
    return 'critical';
  }

  if ((availability !== null && availability < 100) || (errorCount !== null && errorCount > 0)) {
    return 'warning';
  }

  return 'ok';
}

function buildAlertRecord(alert, config) {
  const alertId = getAlertId(alert);
  const testName = getTestName(alert);
  const status = normalizeStatus(alert.status || alert.state || alert.alertState, alert.active);
  const severity = normalizeSeverity(alert.severity || alert.priority, status);
  const startedAt = firstValue(alert.startedAt, alert.startDate, alert.startTime, alert.firstSeen, alert.createdAt, alert.date);
  const endedAt = firstValue(alert.endedAt, alert.endDate, alert.endTime, alert.clearedAt, alert.resolvedAt);
  const updatedAt = firstValue(alert.updatedAt, alert.lastSeen, alert.modifiedAt, endedAt, startedAt, new Date().toISOString());
  const summary = firstValue(
    alert.summary,
    alert.message,
    alert.description,
    alert.details,
    alert.ruleName,
    alert.alertName,
    `ThousandEyes alert for ${testName}`,
  );
  const testType = firstValue(alert.testType, alert.test?.type, alert.type, 'test');
  const target = firstValue(alert.target, alert.endpoint, alert.server, alert.url, alert.test?.target);
  const agent = firstValue(alert.agentName, alert.agent?.agentName, alert.agent?.name);
  const location = firstValue(alert.location, alert.locationName, alert.agentLocation, alert.agent?.location);

  return {
    sourceTool: 'thousandeyes',
    environment: 'production',
    applicationName: testName,
    entityType: 'alert',
    entityId: alertId,
    status,
    severity,
    summary,
    details: firstValue(alert.triggerCondition, alert.condition, alert.metric, alert.expression, alert.details, alert.description, summary),
    acknowledged: Boolean(alert.acknowledged || alert.acknowledgedAt),
    lastCheck: updatedAt,
    updatedAt,
    rawPayload: alert,
    deepLink: getDeepLink(alert, config),
    customProperties: {
      alertId,
      alertName: firstValue(alert.alertName, alert.ruleName, alert.name),
      ruleName: firstValue(alert.ruleName, alert.alertRule?.name, alert.rule?.name),
      active: Boolean(alert.active ?? ['critical', 'warning', 'unknown'].includes(status)),
      triggerCondition: firstValue(alert.triggerCondition, alert.condition, alert.expression),
      metric: firstValue(alert.metric, alert.metricName, alert.measurement),
      testId: getTestId(alert),
      testName,
      testType,
      target,
      endpoint: firstValue(alert.endpoint, target),
      agent,
      location,
      startedAt: startedAt || null,
      endedAt: endedAt || null,
      accountGroupId: config.accountGroupId || null,
    },
  };
}

function buildTestRecord(test, config, context = {}) {
  const testId = getTestId(test) || String(firstValue(test.name, test.testName, test.url, test.target));
  const testName = getTestName(test);
  const testType = firstValue(test.testType, test.type, test.testTypeName, 'test');
  const metricSnapshot = context.metricSnapshot || {};
  const alertSummary = context.alertSummary || {};
  const updatedAt = firstValue(
    metricSnapshot.lastUpdatedAt,
    test.updatedAt,
    test.modifiedDate,
    test.createdAt,
    test.createdDate,
    new Date().toISOString(),
  );
  const target = firstValue(test.target, test.url, test.server, test.domain, test.endpoint);
  const status = deriveTestStatus(test, alertSummary, metricSnapshot);
  const severity = Number(alertSummary.activeAlerts || 0) > 0
    ? alertSummary.highestSeverity
    : normalizeSeverity(test.severity || test.priority, status);

  return {
    sourceTool: 'thousandeyes',
    environment: 'production',
    applicationName: testName,
    entityType: 'test',
    entityId: testId,
    status,
    severity,
    summary: `${testName} ${testType} test`,
    details: firstValue(test.description, target, `ThousandEyes ${testType} test metadata.`),
    acknowledged: false,
    lastCheck: firstValue(metricSnapshot.lastRunAt, updatedAt),
    updatedAt,
    rawPayload: {
      test,
      latestResult: metricSnapshot.latestResult || null,
    },
    deepLink: firstValue(metricSnapshot.latestResult?._links?.appLink?.href, getDeepLink(test, config)),
    customProperties: {
      testId,
      testName,
      testType,
      target,
      endpoint: target,
      applicationName: firstValue(test.appName, test.applicationName, testName),
      alertCount: Number(alertSummary.alertCount || 0),
      activeAlerts: Number(alertSummary.activeAlerts || 0),
      availability: metricSnapshot.availability,
      errorCount: metricSnapshot.errorCount,
      responseTime: metricSnapshot.responseTime,
      latency: metricSnapshot.latency,
      packetLoss: metricSnapshot.packetLoss,
      lastRunAt: metricSnapshot.lastRunAt,
      lastUpdatedAt: updatedAt,
      alertTriggeredAt: alertSummary.alertTriggeredAt,
      alertClearedAt: alertSummary.alertClearedAt,
      monitoringTimestamp: metricSnapshot.monitoringTimestamp || new Date().toISOString(),
      alertHistory: alertSummary.alertHistory || [],
      historicalMetrics: context.historicalMetrics || [],
      interval: test.interval,
      agents: toArray(test.agents || test.agentIds || test.agentNames),
      labels: toArray(test.labels || test.tags),
      accountGroupId: config.accountGroupId || null,
    },
  };
}

function buildMetricRecords(test, results, config) {
  const testName = getTestName(test);
  const testId = getTestId(test);
  const testType = firstValue(test.testType, test.type, 'test');

  return results.slice(0, 500).map((result, index) => {
    const updatedAt = firstValue(result.date, result.timestamp, result.roundDate, result.updatedAt, new Date().toISOString());
    const status = normalizeStatus(result.status || result.state, result.available === false ? 'critical' : 'ok');
    const metric = firstValue(result.metric, result.metricName, result.measurement, result.value, result.availability, result.responseTime);

    return {
      sourceTool: 'thousandeyes',
      environment: 'production',
      applicationName: testName,
      entityType: 'metric',
      entityId: `${testId || testName}:metric:${firstValue(result.agentId, result.locationId, result.roundId, index)}`,
      status,
      severity: normalizeSeverity(result.severity, status),
      summary: `${testName} metric sample`,
      details: metric !== undefined ? `Metric value: ${metric}` : 'ThousandEyes test metric sample.',
      acknowledged: false,
      lastCheck: updatedAt,
      updatedAt,
      rawPayload: result,
      deepLink: getDeepLink(test, config),
      customProperties: {
        testId,
        testName,
        testType,
        metric,
        agentId: result.agentId,
        agentName: result.agentName,
        location: firstValue(result.location, result.locationName, result.agentName),
        target: firstValue(test.target, test.url, test.endpoint),
        accountGroupId: config.accountGroupId || null,
      },
    };
  });
}

async function ensureMonitoringStorage(client = db) {
  await client.query(`
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
  `);
}

async function upsertMonitoringRecords(records) {
  await ensureMonitoringStorage();
  let inserted = 0;
  let updated = 0;

  for (const record of records) {
    const result = await db.query(
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
        RETURNING (xmax = 0) AS inserted
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

    if (result.rows[0]?.inserted) {
      inserted += 1;
    } else {
      updated += 1;
    }
  }

  return { inserted, updated };
}

async function loadExistingTestProperties() {
  await ensureMonitoringStorage();
  const result = await db.query(
    `
      SELECT entity_id, custom_properties
      FROM monitoring_records
      WHERE source_tool = $1
        AND entity_type = $2
    `,
    ['thousandeyes', 'test'],
  );

  return new Map(result.rows.map((row) => [String(row.entity_id), row.custom_properties || {}]));
}

async function fetchAlerts(options = {}) {
  const config = await getRuntimeConfig();
  const path = options.alertId
    ? `/alerts/${encodeURIComponent(options.alertId)}`
    : '/alerts';
  const url = buildUrl(config.baseUrl, path, {
    from: options.from,
    to: options.to,
    status: options.status,
  }, config.accountGroupId);
  const result = await fetchPaginated(url, config.token, ['alerts', 'alertGroups', 'data']);

  return {
    ...result,
    config: { ...config, token: undefined },
  };
}

async function fetchTests(options = {}) {
  const config = await getRuntimeConfig();
  const allItems = [];
  const errors = [];
  let pages = 0;
  let responseTimeMs = 0;
  const baseCandidates = [
    buildUrl(config.baseUrl, '/tests', { type: options.type }, config.accountGroupId),
    ...TEST_TYPE_ENDPOINTS.map((type) => buildUrl(config.baseUrl, `/tests/${type}`, {}, config.accountGroupId)),
  ];

  for (const url of [...new Set(baseCandidates)]) {
    try {
      const result = await fetchPaginated(url, config.token, ['tests', 'data']);
      allItems.push(...result.items);
      pages += result.pages;
      responseTimeMs = Math.max(responseTimeMs, result.responseTimeMs || 0);
    } catch (error) {
      if (error.vendorStatus === 404) {
        errors.push(error.message);
        continue;
      }

      throw error;
    }
  }

  const byId = new Map();
  allItems.forEach((item) => {
    const id = getTestId(item) || JSON.stringify(item);
    byId.set(id, item);
  });

  return {
    items: [...byId.values()],
    pages,
    responseTimeMs,
    errors,
    config: { ...config, token: undefined },
  };
}

async function fetchTestResults(testId, options = {}) {
  const config = await getRuntimeConfig();
  const typeCandidates = options.testType ? [options.testType] : TEST_TYPE_ENDPOINTS;
  const resultRange = getDefaultResultRange(options);
  const results = [];
  const errors = [];
  let responseTimeMs = 0;
  const maxPages = options.maxPages || 2;
  const directUrls = options.resultLinks || getTestResultLinks(options.test || {}, config, resultRange);

  for (const url of directUrls) {
    try {
      const response = await fetchPaginated(url, config.token, [
        'results',
        'testResults',
        'data',
        'httpServer',
        'pageLoad',
        'web',
        'network',
        'dns',
        'api',
      ], { maxPages });
      results.push(...response.items);
      responseTimeMs = Math.max(responseTimeMs, response.responseTimeMs || 0);

      if (results.length) {
        return {
          items: results,
          responseTimeMs,
          config: { ...config, token: undefined },
        };
      }
    } catch (error) {
      if (error.vendorStatus === 404) {
        errors.push(`linked-results: ${error.message}`);
        continue;
      }

      throw error;
    }
  }

  for (const type of typeCandidates) {
    const candidates = [
      `/test-results/${encodeURIComponent(testId)}/${encodeURIComponent(type)}`,
      `/test-results/${encodeURIComponent(type)}/${encodeURIComponent(testId)}`,
      `/tests/${type}/${encodeURIComponent(testId)}/results`,
      `/tests/${encodeURIComponent(testId)}/results`,
    ];

    for (const path of candidates) {
      try {
        const url = buildUrl(config.baseUrl, path, {
          from: resultRange.from,
          to: resultRange.to,
        }, config.accountGroupId);
        const response = await fetchPaginated(url, config.token, [
          'results',
          'testResults',
          'data',
          'httpServer',
          'pageLoad',
          'web',
          'network',
          'dns',
          'api',
        ], { maxPages });
        results.push(...response.items);
        responseTimeMs = Math.max(responseTimeMs, response.responseTimeMs || 0);

        if (results.length) {
          return {
            items: results,
            responseTimeMs,
            config: { ...config, token: undefined },
          };
        }
      } catch (error) {
        if (error.vendorStatus === 404) {
          errors.push(`${type}: ${error.message}`);
          continue;
        }

        throw error;
      }
    }
  }

  return {
    items: results,
    responseTimeMs,
    errors,
    config: { ...config, token: undefined },
  };
}

async function syncThousandEyesData(options = {}) {
  if (syncInFlight) {
    return {
      fetched: 0,
      alertsFetched: 0,
      testsFetched: 0,
      inserted: 0,
      updated: 0,
      skipped: 1,
      pagesFetched: 0,
      metricResultsFetched: 0,
      metricErrors: 0,
      responseTimeMs: 0,
      durationMs: 0,
      message: 'ThousandEyes sync skipped because another sync is already running.',
    };
  }

  syncInFlight = true;
  const startedAt = Date.now();

  try {
    const alertResult = await fetchAlerts(options);
    const testResult = await fetchTests(options);
    const config = await getRuntimeConfig();
    const alertRecords = alertResult.items.map((alert) => buildAlertRecord(alert, config));
    const alertSummaryByTest = buildAlertSummaryByTest(alertRecords);
    let metricResultsFetched = 0;
    let metricErrors = 0;
    const includeMetrics = options.includeMetrics !== false;
    const existingTestProperties = await loadExistingTestProperties();

    const testRecords = await mapWithConcurrency(testResult.items, METRIC_CONCURRENCY, async (test, index) => {
      const testId = getTestId(test);
      const existingProperties = existingTestProperties.get(String(testId)) || {};
      let metricSnapshot = {
        availability: existingProperties.availability,
        errorCount: existingProperties.errorCount,
        responseTime: existingProperties.responseTime,
        latency: existingProperties.latency,
        packetLoss: existingProperties.packetLoss,
        lastRunAt: existingProperties.lastRunAt,
        lastUpdatedAt: existingProperties.lastUpdatedAt,
        monitoringTimestamp: existingProperties.monitoringTimestamp,
      };
      let historicalMetrics = existingProperties.historicalMetrics || [];
      const testType = firstValue(test.testType, test.type, test.testTypeName);

      if (includeMetrics && testId && index < METRIC_RESULT_LIMIT) {
        try {
          const result = await fetchTestResults(testId, {
            ...options,
            test,
          testType,
        });
        metricResultsFetched += result.items.length;
        metricSnapshot = extractMetricSnapshot(result.items);
        historicalMetrics = buildHistoricalMetrics(result.items);
        } catch (error) {
          metricErrors += 1;
        console.warn(`Unable to fetch ThousandEyes test results for ${testId}: ${error.message}`);
      }
    }

      return buildTestRecord(test, config, {
        alertSummary: getAlertSummaryForTest(test, alertSummaryByTest),
        historicalMetrics,
        metricSnapshot,
      });
    });
    const records = [...alertRecords, ...testRecords];
    const stored = await upsertMonitoringRecords(records);

    return {
      fetched: alertResult.items.length + testResult.items.length,
      alertsFetched: alertResult.items.length,
      testsFetched: testResult.items.length,
      inserted: stored.inserted,
      updated: stored.updated,
      skipped: 0,
      pagesFetched: alertResult.pages + testResult.pages,
      metricResultsFetched,
      metricErrors,
      responseTimeMs: Math.max(alertResult.responseTimeMs || 0, testResult.responseTimeMs || 0),
      durationMs: Date.now() - startedAt,
      message: `ThousandEyes sync complete: ${alertResult.items.length} alerts and ${testResult.items.length} tests fetched, ${stored.inserted} new, ${stored.updated} updated.`,
    };
  } finally {
    syncInFlight = false;
  }
}

function startThousandEyesPolling() {
  if (POLL_INTERVAL_MS <= 0 || pollIntervalId) {
    return;
  }

  pollIntervalId = setInterval(async () => {
    if (syncInFlight) {
      return;
    }

    try {
      await syncThousandEyesData({ includeMetrics: POLL_METRICS });
    } catch (error) {
      if (!/ThousandEyes base URL or token is missing|THOUSANDEYES_ACCESS_TOKEN|Integration thousandeyes is not configured/i.test(error.message)) {
        console.error('Automatic ThousandEyes sync failed', error);
      }
    }
  }, POLL_INTERVAL_MS);
}

module.exports = {
  buildAlertRecord,
  buildMetricRecords,
  buildTestRecord,
  fetchAlerts,
  fetchTestResults,
  fetchTests,
  getRuntimeConfig,
  requestApi,
  startThousandEyesPolling,
  syncThousandEyesData,
  upsertMonitoringRecords,
};
