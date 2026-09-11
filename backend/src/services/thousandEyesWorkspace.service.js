const thousandEyesService = require('./thousandEyes.service');

const TEST_PAGE_SIZE = 10;
const RECORD_PAGE_SIZE = 25;
const MAX_DETAIL_PAGES = 3;
const AGENT_CACHE_TTL_MS = 5 * 60 * 1000;
const ALERT_DETAIL_CACHE_TTL_MS = 60 * 1000;
const AGENT_HYDRATION_CONCURRENCY = 5;
const ALLOWED_RANGES = new Set(['1h', '4h', '12h', '24h', '7d', '14d', '30d', '90d']);
const NON_AGENT_ALERT_TYPES = new Set(['bgp', 'network-outage', 'application-outage', 'device-device', 'device-interface']);

function asArray(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function first(...values) {
  return values.find((value) => value !== null && value !== undefined && value !== '');
}

function number(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeRange(value, fallback = '24h') {
  const range = String(value || '').trim().toLowerCase();
  return ALLOWED_RANGES.has(range) ? range : fallback;
}

function collection(payload, preferredKeys = []) {
  if (Array.isArray(payload)) return payload;
  for (const key of preferredKeys) {
    if (Array.isArray(payload?.[key])) return payload[key];
  }
  if (!payload || typeof payload !== 'object') return [];
  const candidate = Object.entries(payload).find(([key, value]) => key !== '_links' && Array.isArray(value));
  return candidate?.[1] || [];
}

function safeUrl(value) {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function linkHref(value) {
  if (typeof value === 'string') return safeUrl(value);
  return safeUrl(value?.href || value?.url);
}

function links(value) {
  return asArray(value).map(linkHref).filter(Boolean);
}

function idFromLink(value, marker) {
  const href = linkHref(value);
  if (!href) return null;
  const parts = new URL(href).pathname.split('/').filter(Boolean);
  const index = parts.lastIndexOf(marker);
  return index >= 0 ? parts[index + 1] || null : parts.at(-1) || null;
}

function apiPathFromUrl(value) {
  const href = linkHref(value);
  if (!href) return null;
  try {
    const parsed = new URL(href);
    const path = parsed.pathname.replace(/^\/v7(?=\/|$)/, '') || '/';
    return path.startsWith('/') ? path : `/${path}`;
  } catch {
    return null;
  }
}

function nextCursor(payload) {
  const href = linkHref(payload?._links?.next) || linkHref(payload?.links?.next);
  if (!href) return null;
  try {
    return new URL(href).searchParams.get('cursor');
  } catch {
    return null;
  }
}

function encodeCursor(value) {
  if (!value) return null;
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decodeCursor(value) {
  if (!value) return { offset: 0, vendorCursor: null };
  try {
    const parsed = JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8'));
    const offset = Math.max(0, Math.min(1000, Number(parsed.offset) || 0));
    const vendorCursor = typeof parsed.vendorCursor === 'string' && parsed.vendorCursor.length < 2000
      ? parsed.vendorCursor
      : null;
    return { offset, vendorCursor };
  } catch {
    const error = new Error('The ThousandEyes page cursor is invalid or expired.');
    error.status = 400;
    throw error;
  }
}

function average(values) {
  const usable = values.filter((value) => Number.isFinite(value));
  if (!usable.length) return null;
  return usable.reduce((sum, value) => sum + value, 0) / usable.length;
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
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

function timestampOf(item) {
  const raw = first(item.date, item.timestamp, item.roundDate, item.startDate, item.createdDate);
  if (!raw) return null;
  if (typeof raw === 'number' || /^\d+$/.test(String(raw))) {
    const numeric = Number(raw);
    const millis = numeric < 10_000_000_000 ? numeric * 1000 : numeric;
    const date = new Date(millis);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function resultMetrics(item) {
  const healthScore = number(item.healthScore);
  const responseCode = number(item.responseCode);
  const errorType = String(item.errorType || '').trim().toLowerCase();
  return {
    availability: healthScore !== null
      ? healthScore * (healthScore <= 1 ? 100 : 1)
      : responseCode !== null ? (responseCode >= 200 && responseCode < 400 ? 100 : 0)
        : errorType && !['none', 'no error'].includes(errorType) ? 0 : null,
    responseTime: first(number(item.responseTime), number(item.totalTime), number(item.waitTime)),
    latency: first(number(item.avgLatency), number(item.latency), number(item.roundTripTime)),
    loss: first(number(item.loss), number(item.packetLoss), number(item.packetLossPercentage)),
    jitter: first(number(item.jitter), number(item.avgJitter)),
    dnsTime: number(item.dnsTime),
    connectTime: number(item.connectTime),
    sslTime: number(item.sslTime),
    transactionTime: first(number(item.transactionTime), number(item.totalTime)),
    responseCode,
    errorType: item.errorType || null,
    timestamp: timestampOf(item),
  };
}

function buildSeries(results, maxPoints = 42) {
  const groups = new Map();
  results.forEach((result) => {
    const metric = resultMetrics(result);
    if (!metric.timestamp) return;
    const key = metric.timestamp;
    const existing = groups.get(key) || [];
    existing.push(metric);
    groups.set(key, existing);
  });
  const ordered = [...groups.entries()].sort(([left], [right]) => left.localeCompare(right));
  const step = Math.max(1, Math.ceil(ordered.length / maxPoints));
  return ordered.filter((_, index) => index % step === 0 || index === ordered.length - 1).map(([timestamp, values]) => ({
    timestamp,
    availability: average(values.map((value) => value.availability)),
    responseTime: average(values.map((value) => value.responseTime)),
    latency: average(values.map((value) => value.latency)),
    loss: average(values.map((value) => value.loss)),
    jitter: average(values.map((value) => value.jitter)),
    dnsTime: average(values.map((value) => value.dnsTime)),
    transactionTime: average(values.map((value) => value.transactionTime)),
  }));
}

function summarizeResults(results) {
  const metrics = results.map(resultMetrics);
  const latest = metrics.filter((metric) => metric.timestamp).sort((a, b) => a.timestamp.localeCompare(b.timestamp)).at(-1)
    || metrics.at(-1)
    || {};
  return {
    status: results.length ? 'data' : 'no_data',
    sampleCount: results.length,
    availability: average(metrics.map((metric) => metric.availability)),
    responseTime: average(metrics.map((metric) => metric.responseTime)),
    latency: average(metrics.map((metric) => metric.latency)),
    loss: average(metrics.map((metric) => metric.loss)),
    jitter: average(metrics.map((metric) => metric.jitter)),
    dnsTime: average(metrics.map((metric) => metric.dnsTime)),
    transactionTime: average(metrics.map((metric) => metric.transactionTime)),
    responseCode: latest.responseCode ?? null,
    errorType: latest.errorType || null,
    lastRunAt: latest.timestamp || null,
    series: buildSeries(results),
  };
}

function latestMetricSnapshot(results) {
  const ordered = results
    .map((result) => ({ result, timestamp: timestampOf(result) }))
    .sort((left, right) => String(left.timestamp || '').localeCompare(String(right.timestamp || '')));
  const latest = ordered.at(-1)?.result;
  if (!latest) return null;
  const metric = resultMetrics(latest);
  const snapshot = {
    timestamp: metric.timestamp,
    errorType: metric.errorType,
    responseCode: metric.responseCode,
    availability: metric.availability,
    responseTime: metric.responseTime,
    latency: metric.latency,
    loss: metric.loss,
  };
  return [snapshot.errorType, snapshot.responseCode, snapshot.availability, snapshot.responseTime, snapshot.latency, snapshot.loss]
    .some((value) => value !== null && value !== undefined && value !== '') ? snapshot : null;
}

function normalizeTest(test, activeAlerts = []) {
  const id = String(first(test.testId, test.id, ''));
  const type = first(test.type, test.testType, 'unknown');
  const target = first(test.url, test.server, test.domain, test.target, test.endpoint);
  const relatedAlerts = activeAlerts.filter((alert) => String(alert.testId || '') === id);
  return {
    id,
    name: first(test.testName, test.name, `Test ${id}`),
    type,
    enabled: test.enabled !== false,
    alertsEnabled: test.alertsEnabled !== false,
    interval: number(test.interval),
    target: target || null,
    protocol: test.protocol || null,
    createdDate: test.createdDate || null,
    modifiedDate: test.modifiedDate || null,
    agentCount: asArray(test.agents).length || null,
    activeAlertCount: relatedAlerts.length,
    highestSeverity: relatedAlerts.map((alert) => alert.severity).sort((left, right) => severityRank(right) - severityRank(left))[0] || null,
  };
}

function severityRank(value) {
  return { critical: 5, major: 4, minor: 3, warning: 2, info: 1 }[String(value || '').toLowerCase()] || 0;
}

function alertState(alert) {
  return String(first(alert.alertState, alert.state, '')).toLowerCase();
}

function alertTestId(alert) {
  return String(first(alert.testId, idFromLink(alert?._links?.test, 'tests') && new URL(linkHref(alert?._links?.test)).pathname.split('/').filter(Boolean).at(-1), '') || '');
}

function alertRuleId(alert) {
  return String(first(alert.alertRuleId, alert.ruleId, idFromLink(alert?._links?.rule, 'rules'), '') || '');
}

function normalizeAlert(alert, testsById = new Map(), rulesById = new Map()) {
  const testId = alertTestId(alert);
  const ruleId = alertRuleId(alert);
  const test = testsById.get(testId);
  const rule = rulesById.get(ruleId);
  const startedAt = first(alert.startDate, alert.dateStart);
  const endedAt = first(alert.endDate, alert.dateEnd);
  const derivedDuration = startedAt && endedAt && !Number.isNaN(new Date(startedAt).getTime()) && !Number.isNaN(new Date(endedAt).getTime())
    ? Math.max(0, (new Date(endedAt) - new Date(startedAt)) / 1000)
    : null;
  const liveDuration = startedAt && !endedAt && ['active', 'trigger', 'triggered'].includes(alertState(alert)) && !Number.isNaN(new Date(startedAt).getTime())
    ? Math.max(0, (Date.now() - new Date(startedAt).getTime()) / 1000)
    : null;
  const durationSeconds = first(derivedDuration, liveDuration, number(alert.duration));
  return {
    id: String(first(alert.alertId, alert.id, '')),
    name: first(alert.alertName, rule?.name, null),
    type: first(alert.alertType, alert.type, test?.type, 'Alert'),
    state: alertState(alert) || 'unknown',
    severity: String(first(alert.alertSeverity, alert.severity, rule?.severity, 'unknown')).toLowerCase(),
    startDate: startedAt || null,
    endDate: endedAt || null,
    durationSeconds,
    violationCount: number(alert.violationCount),
    suppressed: Boolean(alert.suppressed),
    testId: testId || null,
    testName: test?.name || null,
    ruleId: ruleId || null,
    ruleName: rule?.name || null,
    detectionMethod: first(alert.detectionMethod, alert.detectedBy, alert.triggerType, null),
    sourceLink: safeUrl(first(alert.permalink, linkHref(alert?._links?.appLink))),
  };
}

function normalizeRule(rule) {
  return {
    id: String(first(rule.ruleId, rule.alertRuleId, rule.id, '')),
    name: first(rule.ruleName, rule.alertRuleName, rule.name, null),
    severity: String(first(rule.severity, rule.alertSeverity, '')).toLowerCase() || null,
  };
}

function normalizeEvent(event) {
  return {
    id: String(first(event.id, event.eventId, '')),
    type: first(event.typeName, event.eventType, event.type, 'Event'),
    state: String(first(event.state, event.eventState, 'unknown')).toLowerCase(),
    severity: String(first(event.severity, 'unknown')).toLowerCase(),
    startDate: first(event.startDate, event.dateStart) || null,
    endDate: first(event.endDate, event.dateEnd) || null,
    summary: first(event.name, event.title, event.description, event.typeName, 'ThousandEyes event'),
    affectedTests: asArray(first(event.affectedTests, event.tests)),
    affectedAgents: asArray(first(event.affectedAgents, event.agents)),
    sourceLink: safeUrl(first(event.permalink, linkHref(event?._links?.appLink))),
  };
}

function normalizeAgent(agent) {
  const latitude = number(agent.coordinates?.latitude);
  const longitude = number(agent.coordinates?.longitude);
  const agentType = String(first(agent.agentType, agent.type, '')).toLowerCase();
  const publicIps = asArray(agent.publicIpAddresses);
  const interfaceIps = asArray(agent.ipAddresses);
  const privateIps = interfaceIps.filter((value) => !publicIps.includes(value));
  return {
    id: String(first(agent.agentId, agent.id, '')),
    name: first(agent.agentName, agent.name, 'Unnamed agent'),
    type: first(agent.agentType, agent.type, null),
    state: first(agent.agentState, agent.state) ? String(first(agent.agentState, agent.state)).toLowerCase() : null,
    location: first(agent.location, agent.countryId, null),
    latitude,
    longitude,
    countryId: agent.countryId || null,
    hostname: first(agent.hostname, null),
    publicIp: first(agent.publicIp, agent.publicIpAddress, publicIps.length === 1 ? publicIps[0] : null),
    privateIp: first(agent.privateIp, agent.privateIpAddress, agentType === 'enterprise' && privateIps.length === 1 ? privateIps[0] : null),
  };
}

function directMetricValue(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'object') {
    const known = first(value.message, value.error, value.errorType, value.value, value.status);
    return known === null || known === undefined ? null : String(known);
  }
  return null;
}

function affectedAgentReferences(alert) {
  const references = new Map();
  asArray(alert?.details).forEach((detail) => {
    const type = String(detail?.type || '').toLowerCase();
    const id = first(detail?.agentId, detail?.id);
    if (!id || !type.includes('agent')) return;
    const key = String(id);
    if (!references.has(key)) {
      references.set(key, {
        id: key,
        name: first(detail.name, detail.agentName, null),
        relationshipType: detail.type || null,
        alertState: detail.state || null,
        startedAt: first(detail.start?.date, detail.start?.timestamp, detail.startDate, null),
        endedAt: first(detail.end?.date, detail.end?.timestamp, detail.endDate, null),
        metricAtStart: directMetricValue(detail.start?.metrics),
        metricAtEnd: directMetricValue(detail.end?.metrics),
      });
    }
  });
  return [...references.values()];
}

function agentApplicability(alert, references) {
  if (references.length) return 'available';
  if (NON_AGENT_ALERT_TYPES.has(String(first(alert?.alertType, alert?.type, '')).toLowerCase())) return 'not_applicable';
  if (asArray(alert?.details).length) return 'not_applicable';
  return 'unavailable';
}

function resultAgentId(result) {
  return String(first(result?.agentId, result?.agent?.agentId, result?.agent?.id, '') || '');
}

function clusterAgents(agents) {
  const clusters = new Map();
  agents.filter((agent) => agent.latitude !== null && agent.longitude !== null).forEach((agent) => {
    const key = `${agent.latitude.toFixed(1)}:${agent.longitude.toFixed(1)}`;
    const existing = clusters.get(key) || {
      latitude: agent.latitude,
      longitude: agent.longitude,
      count: 0,
      online: 0,
      locations: new Set(),
    };
    existing.count += 1;
    existing.online += agent.state === 'online' ? 1 : 0;
    if (agent.location) existing.locations.add(agent.location);
    clusters.set(key, existing);
  });
  return [...clusters.values()]
    .sort((left, right) => right.count - left.count)
    .slice(0, 120)
    .map((cluster) => ({ ...cluster, locations: [...cluster.locations].slice(0, 3) }));
}

function testResultLinks(test) {
  return links(test?._links?.testResults).map((href) => {
    const path = apiPathFromUrl(href);
    const type = path?.split('/').filter(Boolean).at(-1) || 'result';
    return { href, path, type };
  }).filter((item) => item.path);
}

function primaryResultLink(test) {
  const available = testResultLinks(test);
  const testType = String(first(test.type, test.testType, '')).toLowerCase();
  return available.find((link) => link.type === testType)
    || available.find((link) => link.type === 'network')
    || available[0]
    || null;
}

function createThousandEyesWorkspaceService({ api = thousandEyesService.requestApi } = {}) {
  const agentCache = new Map();
  const alertDetailCache = new Map();

  async function request(path, params) {
    return api(path, params);
  }

  async function fetchPage(path, params, keys) {
    const response = await request(path, params);
    return {
      items: collection(response.payload, keys),
      next: nextCursor(response.payload),
      responseTimeMs: response.responseTimeMs,
      config: response.config,
      raw: response.payload,
    };
  }

  async function alertDetail(alertId) {
    const key = String(alertId);
    const cached = alertDetailCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const response = await request(`/alerts/${encodeURIComponent(key)}`, {});
    alertDetailCache.set(key, { expiresAt: Date.now() + ALERT_DETAIL_CACHE_TTL_MS, value: response.payload });
    return response.payload;
  }

  async function agentMetadata(agentId) {
    const key = String(agentId);
    const cached = agentCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    try {
      const response = await request(`/agents/${encodeURIComponent(key)}`, {});
      const normalized = normalizeAgent(response.payload);
      agentCache.set(key, { expiresAt: Date.now() + AGENT_CACHE_TTL_MS, value: normalized });
      return normalized;
    } catch (error) {
      if ([401, 403].includes(error.vendorStatus)) throw error;
      agentCache.set(key, { expiresAt: Date.now() + 30_000, value: null });
      return null;
    }
  }

  async function hydrateAffectedAgents(rawAlert, resultItems = [], alertContext = null) {
    const references = affectedAgentReferences(rawAlert);
    const hydrated = await mapWithConcurrency(references, AGENT_HYDRATION_CONCURRENCY, async (reference) => {
      const relatedResults = resultItems.filter((result) => resultAgentId(result) === reference.id);
      const resultAgent = relatedResults.find((result) => result?.agent)?.agent || null;
      const metadata = await agentMetadata(reference.id);
      const normalizedResultAgent = resultAgent ? normalizeAgent(resultAgent) : null;
      const normalized = metadata || normalizedResultAgent || { id: reference.id };
      const metrics = relatedResults.length ? summarizeResults(relatedResults) : null;
      const agent = {
        id: reference.id,
        name: first(normalized.name, reference.name, `Agent ${reference.id}`),
        location: first(normalized.location, normalizedResultAgent?.location, null),
        type: first(normalized.type, normalizedResultAgent?.type, null),
        state: normalized.state || null,
        latitude: normalized.latitude ?? null,
        longitude: normalized.longitude ?? null,
        countryId: normalized.countryId || normalizedResultAgent?.countryId || null,
        hostname: normalized.hostname || normalizedResultAgent?.hostname || null,
        publicIp: normalized.publicIp || null,
        privateIp: normalized.privateIp || null,
        alertState: reference.alertState,
        metrics: metrics ? {
          availability: metrics.availability,
          latency: metrics.latency,
          loss: metrics.loss,
          responseTime: metrics.responseTime,
          responseCode: metrics.responseCode,
          errorType: metrics.errorType,
          lastRunAt: metrics.lastRunAt,
          sampleCount: metrics.sampleCount,
        } : null,
        relationship: 'alert.details[].id',
      };
      return {
        agent,
        metricDetail: {
          agentId: reference.id,
          scope: first(reference.name, agent.name, null),
          agentName: agent.name,
          agentLocation: agent.location,
          agentHostname: agent.hostname,
          startedAt: first(reference.startedAt, alertContext?.startDate, null),
          endedAt: first(reference.endedAt, alertContext?.endDate, null),
          metricAtStart: reference.metricAtStart,
          currentMetric: latestMetricSnapshot(relatedResults) || (reference.alertState ? { state: reference.alertState } : null),
          metricAtEnd: reference.metricAtEnd,
          durationSeconds: alertContext?.durationSeconds ?? null,
        },
      };
    });
    return {
      agents: hydrated.map((item) => item.agent),
      metricDetails: hydrated.map((item) => item.metricDetail),
      applicability: agentApplicability(rawAlert, references),
      relationship: references.length ? 'alert.details[].id' : null,
    };
  }

  async function listAgentSummary(alert) {
    try {
      const raw = await alertDetail(alert.id);
      const references = affectedAgentReferences(raw);
      return {
        ...alert,
        affectedAgents: references.map((reference) => ({
          id: reference.id,
          name: reference.name,
          relationshipType: reference.relationshipType,
        })),
        affectedAgentCount: references.length,
        agentApplicability: agentApplicability(raw, references),
      };
    } catch {
      return {
        ...alert,
        affectedAgents: [],
        affectedAgentCount: 0,
        agentApplicability: 'unavailable',
      };
    }
  }

  async function inventory() {
    const [testsResponse, rulesResponse] = await Promise.all([
      fetchPage('/tests', {}, ['tests']),
      fetchPage('/alerts/rules', {}, ['alertRules', 'rules']),
    ]);
    const tests = testsResponse.items;
    const rules = rulesResponse.items.map(normalizeRule);
    const normalizedTests = tests.map((test) => normalizeTest(test));
    return {
      tests,
      rules,
      testsById: new Map(normalizedTests.map((test) => [test.id, test])),
      rulesById: new Map(rules.map((rule) => [rule.id, rule])),
      config: testsResponse.config,
    };
  }

  async function getIdentityInventory() {
    const inventoryData = await inventory();
    return {
      tests: inventoryData.tests.map((test) => normalizeTest(test)),
      rules: inventoryData.rules,
      lastUpdated: new Date().toISOString(),
      readOnly: true,
      externalMutations: 'none',
    };
  }

  async function activeAlerts(inventoryData) {
    const response = await fetchPage('/alerts', { state: 'trigger' }, ['alerts']);
    return response.items
      .filter((alert) => ['active', 'trigger', 'triggered'].includes(alertState(alert)))
      .map((alert) => normalizeAlert(alert, inventoryData.testsById, inventoryData.rulesById));
  }

  async function resultPage(test, range, link = primaryResultLink(test)) {
    if (!link) return { items: [], next: null, type: null };
    const response = await fetchPage(link.path, { window: range }, ['results', link.type]);
    return { ...response, type: link.type };
  }

  async function getDashboard(options = {}) {
    const range = normalizeRange(options.range, '1h');
    const page = Math.max(1, Number(options.page) || 1);
    const pageSize = Math.max(5, Math.min(25, Number(options.pageSize) || TEST_PAGE_SIZE));
    const search = String(options.search || '').trim().toLowerCase();
    const type = String(options.type || '').trim().toLowerCase();
    const inventoryData = await inventory();
    const [alerts, agentsResponse, historyResponse] = await Promise.all([
      activeAlerts(inventoryData),
      fetchPage('/agents', {}, ['agents']),
      fetchPage('/alerts', { state: 'clear', window: '24h' }, ['alerts']),
    ]);
    const normalizedTests = inventoryData.tests.map((test) => normalizeTest(test, alerts));
    const filtered = normalizedTests.filter((test) => {
      if (type && type !== 'all' && test.type !== type) return false;
      return !search || [test.name, test.type, test.target].filter(Boolean).some((value) => String(value).toLowerCase().includes(search));
    }).sort((left, right) => left.name.localeCompare(right.name));
    const offset = (page - 1) * pageSize;
    const selected = filtered.slice(offset, offset + pageSize);
    const rawById = new Map(inventoryData.tests.map((test) => [String(test.testId || test.id), test]));
    const testsWithMetrics = await Promise.all(selected.map(async (test) => {
      try {
        const result = await resultPage(rawById.get(test.id), range);
        return { ...test, metricType: result.type, metrics: summarizeResults(result.items) };
      } catch (error) {
        return { ...test, metricType: null, metrics: { status: 'unavailable', sampleCount: 0, series: [], error: error.message } };
      }
    }));
    const agents = agentsResponse.items.map(normalizeAgent);
    const history = historyResponse.items.map((alert) => normalizeAlert(alert, inventoryData.testsById, inventoryData.rulesById));
    const cleared24h = history.filter((alert) => ['clear', 'cleared', 'resolved'].includes(alert.state));
    const typeCounts = normalizedTests.reduce((counts, test) => ({ ...counts, [test.type]: (counts[test.type] || 0) + 1 }), {});
    const lastUpdated = new Date().toISOString();
    return {
      connection: {
        connected: true,
        credentialSource: inventoryData.config?.source || 'server',
        authentication: 'OAuth bearer · server-side',
        readOnly: true,
      },
      lastUpdated,
      range,
      summary: {
        tests: normalizedTests.length,
        enabledTests: normalizedTests.filter((test) => test.enabled).length,
        activeAlerts: alerts.length,
        clearedAlerts24h: cleared24h.length,
        agentsOnline: agents.filter((agent) => agent.state === 'online').length,
        agentsTotal: agents.length,
        testTypes: Object.keys(typeCounts).length,
      },
      typeCounts,
      alerts: alerts.slice(0, 5),
      tests: testsWithMetrics,
      pagination: {
        page,
        pageSize,
        totalItems: filtered.length,
        totalPages: Math.max(1, Math.ceil(filtered.length / pageSize)),
      },
      agents: {
        byState: agents.reduce((counts, agent) => ({ ...counts, [agent.state || 'unknown']: (counts[agent.state || 'unknown'] || 0) + 1 }), {}),
        byType: agents.reduce((counts, agent) => ({ ...counts, [agent.type || 'unknown']: (counts[agent.type || 'unknown'] || 0) + 1 }), {}),
        clusters: clusterAgents(agents),
        sample: agents.filter((agent) => agent.type === 'enterprise').slice(0, 20),
      },
      availableTypes: Object.keys(typeCounts).sort(),
    };
  }

  async function getTest(testId, options = {}) {
    const range = normalizeRange(options.range, '1h');
    const inventoryData = await inventory();
    const raw = inventoryData.tests.find((test) => String(first(test.testId, test.id)) === String(testId));
    if (!raw) {
      const error = new Error('ThousandEyes test was not found in the configured account group.');
      error.status = 404;
      throw error;
    }
    const alerts = await activeAlerts(inventoryData);
    const resultLinks = testResultLinks(raw).filter((link) => link.type !== 'path-vis' && link.type !== 'bgp').slice(0, 2);
    const resultSets = await Promise.all(resultLinks.map(async (link) => {
      const items = [];
      let cursor = null;
      let pages = 0;
      do {
        const response = await fetchPage(link.path, { cursor, window: range }, ['results', link.type]);
        items.push(...response.items);
        cursor = response.next;
        pages += 1;
      } while (cursor && pages < MAX_DETAIL_PAGES);
      return { type: link.type, items, pages, truncated: Boolean(cursor) };
    }));
    const metrics = Object.fromEntries(resultSets.map((set) => [set.type, {
      ...summarizeResults(set.items),
      pagesFetched: set.pages,
      truncated: set.truncated,
    }]));
    return {
      connection: { connected: true, readOnly: true },
      lastUpdated: new Date().toISOString(),
      range,
      test: normalizeTest(raw, alerts),
      metrics,
      activeAlerts: alerts.filter((alert) => alert.testId === String(testId)),
      availableResultTypes: testResultLinks(raw).map((link) => link.type),
      technical: {
        desiredStatusCode: raw.desiredStatusCode ?? null,
        followRedirects: raw.followRedirects ?? null,
        networkMeasurements: raw.networkMeasurements ?? null,
        probeMode: raw.probeMode ?? null,
        requestMethod: raw.requestMethod ?? null,
        verifyCertificate: raw.verifyCertificate ?? null,
      },
    };
  }

  async function getEvents(options = {}) {
    const range = normalizeRange(options.range, '24h');
    const cursor = decodeCursor(options.cursor);
    const pageSize = Math.max(10, Math.min(50, Number(options.pageSize) || RECORD_PAGE_SIZE));
    const response = await fetchPage('/events', { cursor: cursor.vendorCursor, window: range }, ['events']);
    const normalized = response.items.map(normalizeEvent);
    const search = String(options.search || '').trim().toLowerCase();
    const type = String(options.type || '').toLowerCase();
    const state = String(options.state || '').toLowerCase();
    const filtered = normalized.filter((event) => {
      if (type && type !== 'all' && event.type.toLowerCase() !== type) return false;
      if (state && state !== 'all' && event.state !== state) return false;
      return !search || [event.summary, event.type, event.id].some((value) => String(value).toLowerCase().includes(search));
    });
    const pageItems = filtered.slice(cursor.offset, cursor.offset + pageSize);
    let next = null;
    if (cursor.offset + pageSize < filtered.length) next = encodeCursor({ offset: cursor.offset + pageSize, vendorCursor: cursor.vendorCursor });
    else if (response.next) next = encodeCursor({ offset: 0, vendorCursor: response.next });
    return {
      lastUpdated: new Date().toISOString(),
      range,
      events: pageItems,
      pagination: { nextCursor: next, pageSize, returned: pageItems.length },
      filters: { types: [...new Set(normalized.map((event) => event.type))].sort() },
    };
  }

  async function getEvent(eventId) {
    const response = await request(`/events/${encodeURIComponent(eventId)}`, {});
    return {
      lastUpdated: new Date().toISOString(),
      event: normalizeEvent(response.payload),
      technical: response.payload,
    };
  }

  async function getAlerts(options = {}) {
    const view = options.view === 'active' ? 'active' : 'history';
    const range = normalizeRange(options.range, view === 'active' ? '24h' : '7d');
    const cursor = decodeCursor(options.cursor);
    const pageSize = Math.max(10, Math.min(50, Number(options.pageSize) || RECORD_PAGE_SIZE));
    const inventoryData = await inventory();
    const params = view === 'active' ? { state: 'trigger' } : { state: 'clear', window: range };
    if (cursor.vendorCursor) params.cursor = cursor.vendorCursor;
    const response = await fetchPage('/alerts', params, ['alerts']);
    const expectedStates = view === 'active' ? ['active', 'trigger', 'triggered'] : ['clear', 'cleared', 'resolved'];
    const normalized = response.items
      .filter((alert) => expectedStates.includes(alertState(alert)))
      .map((alert) => normalizeAlert(alert, inventoryData.testsById, inventoryData.rulesById));
    const search = String(options.search || '').trim().toLowerCase();
    const severity = String(options.severity || '').toLowerCase();
    const type = String(options.type || '').toLowerCase();
    const baseFiltered = normalized.filter((alert) => {
      if (severity && severity !== 'all' && alert.severity !== severity) return false;
      if (type && type !== 'all' && alert.type.toLowerCase() !== type) return false;
      return true;
    });
    let filtered;
    let enrichedPageItems;
    if (view === 'active') {
      const enrichedActive = await mapWithConcurrency(baseFiltered, AGENT_HYDRATION_CONCURRENCY, listAgentSummary);
      filtered = enrichedActive.filter((alert) => !search || [
        alert.id,
        alert.name,
        alert.testName,
        alert.ruleName,
        alert.type,
        ...(alert.affectedAgents || []).flatMap((agent) => [agent.name, agent.id]),
      ].filter(Boolean).some((value) => String(value).toLowerCase().includes(search)));
      enrichedPageItems = filtered.slice(cursor.offset, cursor.offset + pageSize);
    } else {
      filtered = baseFiltered.filter((alert) => !search || [alert.id, alert.name, alert.testName, alert.ruleName, alert.type]
        .filter(Boolean).some((value) => String(value).toLowerCase().includes(search)));
      const pageItems = filtered.slice(cursor.offset, cursor.offset + pageSize);
      enrichedPageItems = await mapWithConcurrency(pageItems, AGENT_HYDRATION_CONCURRENCY, listAgentSummary);
    }
    let next = null;
    if (cursor.offset + pageSize < filtered.length) next = encodeCursor({ offset: cursor.offset + pageSize, vendorCursor: cursor.vendorCursor });
    else if (response.next) next = encodeCursor({ offset: 0, vendorCursor: response.next });
    return {
      lastUpdated: new Date().toISOString(),
      view,
      range,
      alerts: enrichedPageItems,
      currentCount: view === 'active' && !response.next ? normalized.length : null,
      pagination: { nextCursor: next, pageSize, returned: enrichedPageItems.length },
      filters: {
        severities: [...new Set(normalized.map((alert) => alert.severity))].sort(),
        types: [...new Set(normalized.map((alert) => alert.type))].sort(),
      },
    };
  }

  async function getAlert(alertId, options = {}) {
    const range = normalizeRange(options.range, '24h');
    const inventoryData = await inventory();
    const rawAlert = await alertDetail(alertId);
    const alert = normalizeAlert(rawAlert, inventoryData.testsById, inventoryData.rulesById);
    const rawTest = inventoryData.tests.find((test) => String(first(test.testId, test.id)) === alert.testId);
    let evidence = null;
    let evidenceResults = [];
    if (rawTest && alert.startDate) {
      const start = new Date(alert.startDate);
      const end = alert.endDate ? new Date(alert.endDate) : new Date();
      if (!Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime())) {
        const padding = 15 * 60 * 1000;
        const maxSpan = 6 * 60 * 60 * 1000;
        const boundedStart = new Date(Math.max(start.getTime() - padding, end.getTime() - maxSpan));
        const boundedEnd = new Date(end.getTime() + padding);
        const link = primaryResultLink(rawTest);
        if (link) {
          try {
            const result = await fetchPage(link.path, { startDate: boundedStart.toISOString(), endDate: boundedEnd.toISOString() }, ['results', link.type]);
            evidenceResults = result.items;
            evidence = {
              type: link.type,
              startDate: boundedStart.toISOString(),
              endDate: boundedEnd.toISOString(),
              ...summarizeResults(result.items),
            };
          } catch (error) {
            evidence = { status: 'unavailable', error: error.message, series: [] };
          }
        }
      }
    }
    const affected = await hydrateAffectedAgents(rawAlert, evidenceResults, alert);
    return {
      lastUpdated: new Date().toISOString(),
      range,
      alert,
      test: rawTest ? normalizeTest(rawTest) : null,
      rule: inventoryData.rulesById.get(alert.ruleId) || null,
      evidence,
      agents: affected.agents,
      metricDetails: affected.metricDetails,
      agentApplicability: affected.applicability,
      agentRelationship: affected.relationship,
      technical: rawAlert,
    };
  }

  async function getAgent(agentId, options = {}) {
    const metadata = await agentMetadata(agentId);
    if (!metadata || metadata.id !== String(agentId)) {
      const error = new Error('ThousandEyes agent was not found in the configured account group.');
      error.status = 404;
      throw error;
    }
    let alertContext = null;
    let affectedAgent = null;
    if (options.alertId) {
      alertContext = await getAlert(options.alertId, { range: options.range });
      affectedAgent = alertContext.agents.find((agent) => agent.id === String(agentId)) || null;
      if (!affectedAgent) {
        const error = new Error('This agent is not directly associated with the selected ThousandEyes alert.');
        error.status = 404;
        throw error;
      }
    }
    return {
      lastUpdated: new Date().toISOString(),
      agent: affectedAgent ? { ...metadata, ...affectedAgent } : metadata,
      relationshipVerified: Boolean(affectedAgent),
      relatedAlerts: alertContext ? [alertContext.alert] : [],
      affectedTest: alertContext?.test || null,
      evidence: affectedAgent?.metrics || null,
    };
  }

  return {
    getAlert,
    getAlerts,
    getAgent,
    getDashboard,
    getEvent,
    getEvents,
    getIdentityInventory,
    getTest,
  };
}

module.exports = {
  affectedAgentReferences,
  createThousandEyesWorkspaceService,
  decodeCursor,
  encodeCursor,
  normalizeAlert,
  normalizeEvent,
  normalizeTest,
  summarizeResults,
  workspaceService: createThousandEyesWorkspaceService(),
};
