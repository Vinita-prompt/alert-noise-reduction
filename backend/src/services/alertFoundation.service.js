const crypto = require('node:crypto');
const { DECISION_LAYER_STATE } = require('../config/decisionLayer');
const { service: operationsReadService } = require('./atlassian/opsReadValidation.service');
const { normalizeOperationsAlert } = require('./atlassian/operationsLiveAlerts.service');

const RANGE_MILLISECONDS = Object.freeze({
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
  '90d': 90 * 24 * 60 * 60 * 1000,
});

function cleanText(value) {
  return String(value || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function canonical(value) {
  return cleanText(value).toLowerCase();
}

function parseRange(value) {
  const range = String(value || '7d').toLowerCase();
  if (!RANGE_MILLISECONDS[range]) {
    const error = new Error('range must be 24h, 7d, 30d, or 90d.');
    error.code = 'INVALID_FOUNDATION_RANGE';
    error.status = 400;
    throw error;
  }
  return range;
}

function stableId(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 24);
}

function normalizeIdentityText(value) {
  return canonical(value)
    .replace(/\balert\s*#\s*\d+\b/gi, 'alert #<id>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, '<id>')
    .replace(/\b\d{4}-\d{2}-\d{2}[t ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?z?\b/gi, '<timestamp>')
    .replace(/\s+/g, ' ')
    .trim();
}

function sourceName(alert) {
  return cleanText(alert.sourceSystem || alert.source || alert.integration?.name || alert.integration || 'Unknown');
}

function foundationIdentity(alert) {
  const structured = alert.sourceIdentifiers || {};
  const stableSourceIdentifier = structured.eventId
    || structured.healthRule
    || structured.alertRule
    || structured.sourceIdentifier
    || alert.alias
    || null;
  return [
    canonical(sourceName(alert)),
    canonical(alert.application),
    canonical(alert.service),
    canonical(alert.environment),
    canonical(stableSourceIdentifier),
    normalizeIdentityText(alert.title || alert.message || alert.description),
  ].join('|');
}

function groupFoundationAlerts(alerts) {
  const buckets = new Map();
  alerts.forEach((alert) => {
    const identity = foundationIdentity(alert);
    const bucket = buckets.get(identity) || [];
    bucket.push(alert);
    buckets.set(identity, bucket);
  });

  return [...buckets.entries()].map(([identity, items]) => {
    const sorted = [...items].sort((left, right) => new Date(left.createdAt || 0) - new Date(right.createdAt || 0));
    const sources = [...new Set(sorted.map(sourceName).filter(Boolean))];
    return {
      alerts: sorted,
      correlationKey: identity,
      decision: null,
      foundationOnly: true,
      firstSeen: sorted[0]?.createdAt || null,
      groupId: stableId(identity),
      lastSeen: sorted.at(-1)?.updatedAt || sorted.at(-1)?.lastOccurredAt || sorted.at(-1)?.createdAt || null,
      occurrences: sorted.reduce((total, alert) => total + Math.max(1, Number(alert.occurrenceCount || alert.occurrences || 1)), 0),
      pattern: cleanText(sorted[0]?.title || sorted[0]?.message || sorted[0]?.description) || 'Alert foundation record',
      source: sources.length === 1 ? sources[0] : sources.join(' + '),
      sources,
    };
  }).sort((left, right) => new Date(right.lastSeen || 0) - new Date(left.lastSeen || 0));
}

function createAlertFoundationService({
  now = () => Date.now(),
  operationsService = operationsReadService,
  pageSize = 100,
} = {}) {
  async function fetchOperations(range) {
    const to = now();
    const from = to - RANGE_MILLISECONDS[range];
    const alertsById = new Map();
    let offset = 0;
    let pagesFetched = 0;
    let totalAvailable = null;

    while (true) {
      const page = await operationsService.listAlerts({
        from,
        offset,
        order: 'desc',
        size: pageSize,
        sort: 'createdAt',
        to,
      });
      const values = Array.isArray(page.values) ? page.values : [];
      if (totalAvailable === null) totalAvailable = Math.max(0, Number(page.count ?? values.length));
      values.forEach((item) => {
        const normalized = normalizeOperationsAlert(item);
        alertsById.set(String(normalized.id), normalized);
      });
      pagesFetched += 1;
      const hasNext = page.pagination?.hasNextPage === true || alertsById.size < totalAvailable;
      if (!values.length || !hasNext || alertsById.size >= totalAvailable) break;
      offset += pageSize;
    }

    return {
      alerts: [...alertsById.values()],
      from: new Date(from).toISOString(),
      pagesFetched,
      to: new Date(to).toISOString(),
      totalAvailable: totalAvailable ?? alertsById.size,
    };
  }

  async function analyzeRange(rangeValue = '7d') {
    const range = parseRange(rangeValue);
    const fetched = await fetchOperations(range);
    const groups = groupFoundationAlerts(fetched.alerts);
    const result = {
      analysisVersion: null,
      authoritativeSource: 'jsm_operations',
      currentPhase: DECISION_LAYER_STATE.currentPhase,
      decisionLayer: DECISION_LAYER_STATE,
      foundationOnly: true,
      groups,
      range,
      rangeFrom: fetched.from,
      rangeTo: fetched.to,
      readOnly: true,
      summary: {
        alertsAvailable: fetched.alerts.length,
        correlatedIdentityGroups: groups.length,
        sources: [...new Set(groups.flatMap((group) => group.sources))].sort(),
      },
      totalAlertsInRange: fetched.totalAvailable,
      coverage: {
        alertsRetrieved: fetched.alerts.length,
        complete: fetched.alerts.length >= fetched.totalAvailable,
        pagesFetched: fetched.pagesFetched,
        totalAvailable: fetched.totalAvailable,
      },
    };
    Object.defineProperty(result, '_normalizedAlerts', { enumerable: false, value: fetched.alerts });
    return result;
  }

  async function getGroup(groupId, options = {}) {
    const id = String(groupId || '').trim();
    if (!/^[a-f0-9]{24}$/.test(id)) {
      const error = new Error('A valid alert foundation group ID is required.');
      error.code = 'INVALID_FOUNDATION_GROUP_ID';
      error.status = 400;
      throw error;
    }
    const result = await analyzeRange(options.range || '7d');
    const group = result.groups.find((item) => item.groupId === id);
    if (!group) {
      const error = new Error('Alert foundation group was not found in the selected range.');
      error.code = 'FOUNDATION_GROUP_NOT_FOUND';
      error.status = 404;
      throw error;
    }
    return { ...result, groups: undefined, group };
  }

  async function getStatus(options = {}) {
    const result = await analyzeRange(options.range || '24h');
    return {
      currentPhase: DECISION_LAYER_STATE.currentPhase,
      decisionLayer: DECISION_LAYER_STATE,
      foundation: {
        authoritativeSource: result.authoritativeSource,
        range: result.range,
        rangeFrom: result.rangeFrom,
        rangeTo: result.rangeTo,
        ...result.summary,
        coverage: result.coverage,
        reusableData: [
          'alert identifiers', 'timestamps', 'occurrence history', 'raw alert messages',
          'source metadata', 'correlation keys', 'source identity', 'Slack context',
          'Jira Incidents', 'Jira Problems', 'monitoring-source context', 'deep links',
        ],
      },
    };
  }

  return { analyzeRange, getGroup, getStatus };
}

module.exports = {
  RANGE_MILLISECONDS,
  createAlertFoundationService,
  foundationIdentity,
  groupFoundationAlerts,
  service: createAlertFoundationService(),
};
