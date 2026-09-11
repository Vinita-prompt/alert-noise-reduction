const crypto = require('node:crypto');
const db = require('../config/db');
const { NOISE_ANALYSIS_CONFIG } = require('../config/noiseAnalysis');
const {
  assessReviewRisk,
  recommendationFor: calibratedRecommendationFor,
  scoreNoiseLikelihood,
} = require('./noiseScoring.service');
const { service: operationsReadService } = require('./atlassian/opsReadValidation.service');
const { normalizeOperationsAlert } = require('./atlassian/operationsLiveAlerts.service');

const RANGE_MILLISECONDS = Object.freeze({
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
  '90d': 90 * 24 * 60 * 60 * 1000,
});
const CLASSIFICATIONS = new Set(['all', 'duplicate', 'recurring', 'flapping', 'flapping_like', 'auto_resolved', 'correlated']);
const FEEDBACK_VALUES = new Set(['useful_finding', 'not_noise', 'needs_review']);
const KNOWN_MONITORING_SOURCES = new Set(['AppDynamics', 'Grafana', 'Nagios', 'ThousandEyes']);

function safeError(message, code, status = 400) {
  const error = new Error(message);
  error.code = code;
  error.safeMessage = message;
  error.status = status;
  return error;
}

function canonical(value) {
  return String(value || '').trim().toLowerCase();
}

function cleanText(value) {
  return String(value || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

// Only occurrence-specific values are removed. Ordinary numbers, IP addresses,
// hostnames, metric names, and rule names remain part of the identity.
function normalizeVolatileText(value) {
  return cleanText(value)
    .toLowerCase()
    .replace(/\b\d{4}-\d{2}-\d{2}[t ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:z|[+-]\d{2}:?\d{2})?\b/gi, '<timestamp>')
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, '<date>')
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?(?:\s*[ap]m)?\b/gi, '<time>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, '<uuid>')
    .replace(/\b(trace|request|correlation)[-_ ]?id\s*[:=]\s*[a-z0-9._:-]+/gi, '$1-id:<volatile>')
    .replace(/\balert\s*#\s*\d+\b/gi, 'alert #<id>')
    .replace(/\b(?:occurrence|attempt|retry|count)\s*(?:#|:|=)?\s*\d+\b/gi, '$1 <count>')
    .replace(/\s+/g, ' ')
    .trim();
}

function firstNestedValue(value, keyPattern, depth = 0) {
  if (!value || depth > 4) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const match = firstNestedValue(item, keyPattern, depth + 1);
      if (match) return match;
    }
    return null;
  }
  if (typeof value !== 'object') return null;
  for (const [key, item] of Object.entries(value)) {
    if (keyPattern.test(key) && ['string', 'number'].includes(typeof item) && String(item).trim()) {
      return String(item).trim();
    }
  }
  for (const item of Object.values(value)) {
    const match = firstNestedValue(item, keyPattern, depth + 1);
    if (match) return match;
  }
  return null;
}

function sourceIdentifiers(alert) {
  const extra = alert.extraProperties || {};
  return {
    alertRule: firstNestedValue(extra, /alert.?rule|rule.?name/i),
    eventId: firstNestedValue(extra, /^event.?id$/i),
    healthRule: firstNestedValue(extra, /health.?rule/i),
    host: alert.sourceDetails?.host || firstNestedValue(extra, /^(host|hostname|host_name)$/i),
    metric: alert.sourceDetails?.metricKey || firstNestedValue(extra, /metric(?:.?key|.?name)?|condition.?name/i),
    sourceIdentifier: alert.alias || firstNestedValue(extra, /^(test|test.?id|rule.?id|source.?id|monitor.?id)$/i),
  };
}

function buildFingerprint(alert) {
  const identifiers = alert.sourceIdentifiers || sourceIdentifiers(alert);
  const normalizedMessage = normalizeVolatileText(alert.message || alert.description || alert.title);
  const identity = {
    application: canonical(alert.application),
    environment: canonical(alert.environment),
    healthRule: canonical(identifiers.healthRule),
    host: canonical(identifiers.host),
    message: normalizedMessage,
    metric: canonical(identifiers.metric),
    rule: canonical(identifiers.alertRule),
    service: canonical(alert.service),
    source: canonical(alert.sourceSystem || alert.source),
  };
  const fingerprint = Object.entries(identity).map(([key, value]) => `${key}=${value}`).join('|');
  return {
    fingerprint,
    fingerprintHash: crypto.createHash('sha256').update(fingerprint).digest('hex'),
    identity,
    normalizedMessage,
  };
}

function toMs(value) {
  const parsed = value ? new Date(value).getTime() : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function toIso(value) {
  const milliseconds = typeof value === 'number' ? value : toMs(value);
  return milliseconds === null ? null : new Date(milliseconds).toISOString();
}

function durationMs(alert) {
  const start = toMs(alert.createdAt);
  const end = toMs(alert.closeTime);
  return start !== null && end !== null && end >= start ? end - start : null;
}

function totalOccurrences(alerts) {
  return alerts.reduce((sum, alert) => sum + Math.max(1, Number(alert.occurrenceCount || alert.occurrences || 1)), 0);
}

function stableGroupId(classification, fingerprint, alerts) {
  const ids = alerts.map((alert) => alert.id).filter(Boolean).sort().join(',');
  return crypto.createHash('sha256').update(`${classification}|${fingerprint}|${ids}`).digest('hex').slice(0, 24);
}

function clusterAlerts(alerts, windowMinutes) {
  const windowMs = windowMinutes * 60 * 1000;
  const sorted = [...alerts].sort((left, right) => (toMs(left.createdAt) || 0) - (toMs(right.createdAt) || 0));
  const clusters = [];
  for (const alert of sorted) {
    const timestamp = toMs(alert.createdAt);
    const cluster = clusters.at(-1);
    const previousTimestamp = cluster ? toMs(cluster.at(-1).createdAt) : null;
    if (!cluster || timestamp === null || previousTimestamp === null || timestamp - previousTimestamp > windowMs) {
      clusters.push([alert]);
    } else {
      cluster.push(alert);
    }
  }
  return clusters;
}

function displayPattern(alert, fingerprintData) {
  return cleanText(alert.title || alert.message || alert.description) || fingerprintData.normalizedMessage || 'Operations alert pattern';
}

function alertTimelineItem(alert) {
  return {
    alertNumber: alert.tinyId || null,
    canonicalOperationsId: alert.id,
    closedAt: alert.closeTime || null,
    createdAt: alert.createdAt || null,
    durationMs: durationMs(alert),
    priority: alert.priority || null,
    status: alert.status || null,
  };
}

function buildBaseGroup(classification, fingerprintData, alerts, evidence = [], extra = {}) {
  const sorted = [...alerts].sort((left, right) => (toMs(left.createdAt) || 0) - (toMs(right.createdAt) || 0));
  const first = sorted[0];
  const last = sorted.at(-1);
  const sources = [...new Set(sorted.map((alert) => alert.sourceSystem || alert.source).filter(Boolean))];
  return {
    alerts: sorted,
    classification,
    correlations: [],
    environment: first?.environment || null,
    evidence,
    fingerprint: fingerprintData.fingerprint,
    fingerprintHash: fingerprintData.fingerprintHash,
    firstSeen: first?.createdAt || null,
    groupId: stableGroupId(classification, fingerprintData.fingerprint, sorted),
    jiraRelationships: [],
    lastSeen: last?.lastOccurredAt || last?.updatedAt || last?.createdAt || null,
    monitoringEvidence: [],
    occurrences: totalOccurrences(sorted),
    pattern: displayPattern(first || {}, fingerprintData),
    priority: sorted.map((alert) => alert.priority).filter(Boolean).sort()[0] || null,
    slackContext: { available: false, messageCount: 0, messages: [], replyCount: 0, threadCount: 0 },
    source: sources.length === 1 ? sources[0] : sources.join(' + '),
    sources,
    timeline: sorted.map(alertTimelineItem),
    ...extra,
  };
}

function normalizeLog(log = {}, index = 0) {
  const message = cleanText(log.log || log.message || log.description || log.text);
  const lower = message.toLowerCase();
  const type = cleanText(log.logType || log.type || log.eventType || 'activity');
  const actor = cleanText(log.owner || log.actor?.name || log.actor || log.user?.name || log.user) || null;
  let state = null;
  if (/unacknowledged/.test(lower)) state = 'unacknowledged';
  else if (/acknowledged/.test(lower)) state = 'acknowledged';
  else if (/\bclosed\b|\bresolved\b|\brecovered\b/.test(lower)) state = 'closed';
  else if (/\bcreated\b|\bopened\b|\btriggered\b|\breopened\b/.test(lower)) state = 'open';
  return {
    actor,
    id: log.id || log.logId || `${log.logTime || log.createdAt || 'activity'}-${index}`,
    message,
    state,
    timestamp: toIso(log.logTime || log.createdAt || log.timestamp || log.time),
    type,
  };
}

function isSystemActor(actor, type) {
  const value = `${actor || ''} ${type || ''}`.toLowerCase();
  if (!value.trim()) return false;
  if (/@/.test(actor || '')) return false;
  return /system|integration|api|appd|grafana|nagios|thousand|monitor|opsgenie|jira service|automation|connector/.test(value);
}

function lifecycleFromLogs(alert, logs = []) {
  const events = logs.map(normalizeLog).filter((event) => event.timestamp).sort((a, b) => toMs(a.timestamp) - toMs(b.timestamp));
  const created = events.find((event) => event.state === 'open') || null;
  const closedEvents = events.filter((event) => event.state === 'closed');
  const acknowledgedEvents = events.filter((event) => event.state === 'acknowledged');
  const stateEvents = events.filter((event) => event.state);
  const humanAcknowledgement = acknowledgedEvents.some((event) => event.actor && !isSystemActor(event.actor, event.type));
  const humanAction = events.some((event) => {
    if (!event.actor || isSystemActor(event.actor, event.type)) return false;
    if (/recipient|notification|routing|assignment/i.test(event.type)) return false;
    // Operations uses the generic `alertAction` type for acknowledge,
    // unacknowledge, close, and notes.  The type alone therefore cannot prove
    // that an operator performed a meaningful remediation.  In particular,
    // acknowledgement is handling evidence only and must not promote an alert
    // to Actionable.
    if (event.state === 'acknowledged' || event.state === 'open') return false;
    if (/\bunacknowledg|\backnowledg/i.test(event.message)) return false;
    if (event.state === 'closed') return true;
    return /\bescalat|\bremediat|\brestart|\broll(?:ed)? back|\brestore|\bfixed?\b|\bconfiguration\b|\bcleared?\b|\bresolved?\b|\bmitigat|\bworkaround|\badd(?:ed)? note\b/i.test(event.message);
  });
  const closure = closedEvents.at(-1) || null;
  const closedBySystem = Boolean(closure && isSystemActor(closure.actor, closure.type));
  let cycles = 0;
  let openSeen = false;
  stateEvents.forEach((event) => {
    if (event.state === 'open') openSeen = true;
    if (event.state === 'closed' && openSeen) {
      cycles += 1;
      openSeen = false;
    }
  });
  // Some Operations logs omit the explicit creation log. Do not infer a cycle
  // for flapping in that case; the lifecycle must be evidenced by both states.
  return {
    alertId: alert.id,
    closedBy: closure?.actor || null,
    closedBySystem,
    cycles,
    events,
    humanAcknowledgement,
    humanAction,
    stateSequence: stateEvents.map((event) => ({ state: event.state, timestamp: event.timestamp })),
    verifiedClosedCycle: Boolean(created && closure && toMs(closure.timestamp) >= toMs(created.timestamp)),
  };
}

function fingerprintBuckets(alerts) {
  const buckets = new Map();
  alerts.forEach((alert) => {
    const fingerprintData = alert.fingerprintData || buildFingerprint(alert);
    alert.fingerprintData = fingerprintData;
    const items = buckets.get(fingerprintData.fingerprintHash) || [];
    items.push(alert);
    buckets.set(fingerprintData.fingerprintHash, items);
  });
  return buckets;
}

function duplicateGroups(buckets, config) {
  const groups = [];
  for (const alerts of buckets.values()) {
    const fingerprintData = alerts[0].fingerprintData;
    clusterAlerts(alerts, config.duplicateWindowMinutes).filter((cluster) => cluster.length >= 2).forEach((cluster) => {
      const first = cluster[0];
      const last = cluster.at(-1);
      const minutes = Math.max(0, Math.round(((toMs(last.createdAt) || 0) - (toMs(first.createdAt) || 0)) / 60000));
      groups.push(buildBaseGroup('duplicate', fingerprintData, cluster, [
        { key: 'source', label: 'Same source', detail: first.sourceSystem || first.source },
        { key: 'fingerprint', label: 'Same normalized pattern', detail: fingerprintData.normalizedMessage },
        ...(first.service ? [{ key: 'service', label: 'Same service', detail: first.service }] : []),
        ...(first.environment ? [{ key: 'environment', label: 'Same environment', detail: first.environment }] : []),
        { key: 'window', label: `Occurred within ${config.duplicateWindowMinutes} minutes`, detail: `${cluster.length} alert records across ${minutes} minute${minutes === 1 ? '' : 's'}` },
      ], { correlationWindowMinutes: config.duplicateWindowMinutes }));
    });
  }
  return groups;
}

function recurringGroups(buckets, config) {
  const groups = [];
  for (const alerts of buckets.values()) {
    if (alerts.length < config.recurringMinimumOccurrences) continue;
    const clusters = clusterAlerts(alerts, config.duplicateWindowMinutes);
    if (clusters.length < config.recurringMinimumClusters) continue;
    const sorted = [...alerts].sort((a, b) => toMs(a.createdAt) - toMs(b.createdAt));
    const intervals = sorted.slice(1).map((alert, index) => toMs(alert.createdAt) - toMs(sorted[index].createdAt)).filter(Number.isFinite);
    const averageIntervalMs = intervals.length ? Math.round(intervals.reduce((sum, value) => sum + value, 0) / intervals.length) : null;
    const activeDays = new Set(sorted.map((alert) => alert.createdAt?.slice(0, 10)).filter(Boolean)).size;
    groups.push(buildBaseGroup('recurring', alerts[0].fingerprintData, sorted, [
      { key: 'fingerprint', label: 'Same normalized pattern', detail: alerts[0].fingerprintData.normalizedMessage },
      { key: 'occurrences', label: `${sorted.length} alert records`, detail: `Minimum required: ${config.recurringMinimumOccurrences}` },
      { key: 'clusters', label: `${clusters.length} distinct time clusters`, detail: `Clusters are separated by more than ${config.duplicateWindowMinutes} minutes` },
      { key: 'activeDays', label: `Active on ${activeDays} day${activeDays === 1 ? '' : 's'}`, detail: 'Derived from Operations creation timestamps' },
    ], { activeDays, averageIntervalMs, clusterCount: clusters.length }));
  }
  return groups;
}

function flappingGroups(buckets, lifecycleMap, config) {
  const groups = [];
  for (const alerts of buckets.values()) {
    const lifecycleAlerts = alerts.map((alert) => ({ alert, lifecycle: lifecycleMap.get(alert.id) })).filter((item) => item.lifecycle);
    const cycles = lifecycleAlerts.reduce((sum, item) => sum + item.lifecycle.cycles, 0);
    const verified = lifecycleAlerts.filter((item) => item.lifecycle.verifiedClosedCycle);
    const effectiveCycles = Math.max(cycles, verified.length);
    if (effectiveCycles < config.flappingMinimumCycles) continue;
    const stateEvents = lifecycleAlerts.flatMap((item) => item.lifecycle.stateSequence).sort((a, b) => toMs(a.timestamp) - toMs(b.timestamp));
    const firstAt = toMs(stateEvents[0]?.timestamp);
    const lastAt = toMs(stateEvents.at(-1)?.timestamp);
    if (firstAt === null || lastAt === null || lastAt - firstAt > config.flappingWindowMinutes * 60000) continue;
    groups.push(buildBaseGroup('flapping', alerts[0].fingerprintData, lifecycleAlerts.map((item) => item.alert), [
      { key: 'lifecycle', label: `${effectiveCycles} verified open → closed cycles`, detail: 'Derived from JSM Operations activity logs' },
      { key: 'window', label: `Cycles occurred within ${config.flappingWindowMinutes} minutes`, detail: `${Math.round((lastAt - firstAt) / 60000)} minute observed period` },
    ], { cycles: effectiveCycles, stateSequence: stateEvents }));
  }
  return groups;
}

function autoResolvedGroups(buckets, lifecycleMap, config) {
  const groups = [];
  for (const alerts of buckets.values()) {
    const matches = alerts.filter((alert) => {
      const lifecycle = lifecycleMap.get(alert.id);
      return lifecycle?.verifiedClosedCycle
        && lifecycle.closedBySystem
        && !lifecycle.humanAcknowledgement
        && !lifecycle.humanAction
        && alert.acknowledged !== true;
    });
    if (!matches.length) continue;
    const durations = matches.map(durationMs).filter(Number.isFinite);
    const averageActiveDurationMs = durations.length ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length) : null;
    groups.push(buildBaseGroup('auto_resolved', alerts[0].fingerprintData, matches, [
      { key: 'opened', label: 'Open lifecycle event verified', detail: 'JSM Operations activity log' },
      { key: 'closed', label: 'Closed/recovered by a system or integration', detail: matches.map((alert) => lifecycleMap.get(alert.id)?.closedBy).filter(Boolean).join(', ') },
      { key: 'humanAcknowledgement', label: 'No human acknowledgement', detail: 'No human acknowledgement event was found in inspected activity' },
      { key: 'humanAction', label: 'No meaningful human action', detail: 'Routing and notification events are not counted as human intervention' },
    ], { averageActiveDurationMs, shortDurationThresholdMinutes: config.shortDurationMinutes }));
  }
  return groups;
}

function flappingLikeGroups(buckets, config) {
  const groups = [];
  const windowMs = config.flappingWindowMinutes * 60 * 1000;
  for (const alerts of buckets.values()) {
    const sorted = [...alerts].sort((left, right) => (toMs(left.createdAt) || 0) - (toMs(right.createdAt) || 0));
    const transitions = [];
    for (let index = 1; index < sorted.length; index += 1) {
      const previous = sorted[index - 1];
      const current = sorted[index];
      const closedAt = toMs(previous.closeTime);
      const openedAt = toMs(current.createdAt);
      if (previous.id === current.id || closedAt === null || openedAt === null || openedAt < closedAt || openedAt - closedAt > windowMs) continue;
      transitions.push({
        closedAlertId: previous.id,
        closedAt: previous.closeTime,
        gapMs: openedAt - closedAt,
        openedAlertId: current.id,
        openedAt: current.createdAt,
        timestampMs: openedAt,
      });
    }
    let start = 0;
    let best = [];
    for (let end = 0; end < transitions.length; end += 1) {
      while (start < end && transitions[end].timestampMs - transitions[start].timestampMs > windowMs) start += 1;
      const candidate = transitions.slice(start, end + 1);
      if (candidate.length > best.length) best = candidate;
    }
    if (best.length < config.flappingLikeMinimumTransitions) continue;
    const involvedIds = new Set(best.flatMap((item) => [item.closedAlertId, item.openedAlertId]));
    const involved = sorted.filter((alert) => involvedIds.has(alert.id));
    const fingerprintData = alerts[0].fingerprintData || buildFingerprint(alerts[0]);
    const firstAt = Math.min(...best.map((item) => toMs(item.closedAt)).filter(Number.isFinite));
    const lastAt = Math.max(...best.map((item) => toMs(item.openedAt)).filter(Number.isFinite));
    groups.push(buildBaseGroup('flapping_like', fingerprintData, involved, [
      { key: 'fingerprint', label: 'Same deterministic fingerprint', detail: fingerprintData.normalizedMessage },
      { key: 'transitions', label: `${best.length} closed → new-alert transitions`, detail: 'Each transition uses a different canonical Operations alert ID' },
      { key: 'rollingWindow', label: `Burst found inside a rolling ${config.flappingWindowMinutes}-minute window`, detail: `${Math.max(0, Math.round((lastAt - firstAt) / 60000))} minute observed burst` },
    ], {
      flappingLikeEvidence: {
        occurrences: involved.length,
        stateSequence: involved.flatMap((alert) => [
          { alertId: alert.id, alertNumber: alert.tinyId || null, state: 'open', timestamp: alert.createdAt },
          ...(alert.closeTime ? [{ alertId: alert.id, alertNumber: alert.tinyId || null, state: 'closed', timestamp: alert.closeTime }] : []),
        ]).sort((left, right) => (toMs(left.timestamp) || 0) - (toMs(right.timestamp) || 0)),
        transitions: best.length,
        transitionEvidence: best.map(({ timestampMs, ...item }) => item),
        windowFrom: toIso(firstAt),
        windowMinutes: config.flappingWindowMinutes,
        windowTo: toIso(lastAt),
      },
    }));
  }
  return groups;
}

const PRIMARY_CLASSIFICATION_ORDER = Object.freeze(['recurring', 'flapping', 'flapping_like', 'duplicate', 'auto_resolved', 'correlated']);
const CLASSIFICATION_LABELS = Object.freeze({
  auto_resolved: 'auto_resolved',
  correlated: 'cross_alert_cluster',
  duplicate: 'duplicate',
  flapping: 'flapping',
  flapping_like: 'flapping_like',
  recurring: 'recurring',
});

function consolidatedDetectorEvidence(items) {
  const duplicateDetectors = items.filter((item) => item.classification === 'duplicate');
  const evidence = [];
  const seen = new Set();
  items.forEach((item) => {
    item.evidence.forEach((entry) => {
      if (item.classification === 'duplicate' && entry.key === 'window') return;
      const identity = item.classification === 'duplicate'
        ? `${item.classification}|${entry.key}`
        : `${item.classification}|${entry.key}|${entry.detail}`;
      if (seen.has(identity)) return;
      seen.add(identity);
      evidence.push({ ...entry, detector: item.classification });
    });
  });
  if (duplicateDetectors.length) {
    const peak = duplicateDetectors.reduce((maximum, item) => Math.max(maximum, item.alerts.length), 0);
    evidence.push({
      detail: `Largest burst contained ${peak} alert records inside the ${duplicateDetectors[0].correlationWindowMinutes}-minute duplicate window`,
      detector: 'duplicate',
      key: 'duplicateBursts',
      label: `${duplicateDetectors.length} duplicate burst${duplicateDetectors.length === 1 ? '' : 's'} detected`,
    });
  }
  return evidence;
}

function consolidatePatternGroups(detectorGroups) {
  const byFingerprint = new Map();
  detectorGroups.forEach((group) => {
    const items = byFingerprint.get(group.fingerprintHash) || [];
    items.push(group);
    byFingerprint.set(group.fingerprintHash, items);
  });
  return [...byFingerprint.values()].map((items) => {
    const classifications = new Set(items.map((item) => item.classification));
    const primaryClassification = PRIMARY_CLASSIFICATION_ORDER.find((value) => classifications.has(value)) || items[0].classification;
    const primary = items.find((item) => item.classification === primaryClassification) || items[0];
    const alertsById = new Map(items.flatMap((item) => item.alerts).map((alert) => [alert.id, alert]));
    const alerts = [...alertsById.values()];
    const fingerprintData = alerts[0]?.fingerprintData || buildFingerprint(alerts[0] || {});
    const duplicateDetectors = items.filter((item) => item.classification === 'duplicate');
    const recurringDetector = items.find((item) => item.classification === 'recurring');
    const flappingDetector = items.find((item) => item.classification === 'flapping');
    const flappingLikeDetector = items.find((item) => item.classification === 'flapping_like');
    const autoResolvedDetectors = items.filter((item) => item.classification === 'auto_resolved');
    const consolidated = buildBaseGroup(primaryClassification, fingerprintData, alerts, consolidatedDetectorEvidence(items));
    consolidated.primaryClassification = primaryClassification;
    consolidated.labels = PRIMARY_CLASSIFICATION_ORDER.filter((classification) => classifications.has(classification)).map((classification) => CLASSIFICATION_LABELS[classification]);
    consolidated.legacyGroupIds = [...new Set(items.map((item) => item.groupId).filter((id) => id !== consolidated.groupId))];
    consolidated.detectors = items.map((item) => ({ classification: item.classification, groupId: item.groupId, occurrences: item.occurrences }));
    consolidated.duplicateBurstCount = duplicateDetectors.length;
    consolidated.duplicateOccurrencePeak = duplicateDetectors.reduce((maximum, item) => Math.max(maximum, item.alerts.length), 0);
    consolidated.clusterCount = recurringDetector?.clusterCount || 1;
    consolidated.activeDays = recurringDetector?.activeDays || 1;
    consolidated.averageIntervalMs = recurringDetector?.averageIntervalMs ?? null;
    consolidated.cycles = flappingDetector?.cycles || 0;
    consolidated.stateSequence = flappingDetector?.stateSequence || [];
    consolidated.flappingLikeEvidence = flappingLikeDetector?.flappingLikeEvidence || null;
    consolidated.autoResolvedCount = new Set(autoResolvedDetectors.flatMap((item) => item.alerts.map((alert) => alert.id))).size;
    Object.defineProperty(consolidated, '_detectorGroups', { enumerable: false, value: items });
    return consolidated;
  });
}

function sharedValue(left, right, selector) {
  const leftValue = canonical(selector(left));
  const rightValue = canonical(selector(right));
  return leftValue && rightValue && leftValue === rightValue ? selector(left) : null;
}

function correlationForPair(left, right, config) {
  const weights = config.correlation.weights;
  const evidence = [];
  let score = 0;
  const add = (key, label, value, points) => {
    if (!value) return;
    score += points;
    evidence.push({ key, label, detail: String(value), points });
  };
  const leftIds = left.sourceIdentifiers || {};
  const rightIds = right.sourceIdentifiers || {};
  add('sourceIdentifier', 'Same exact source identifier', sharedValue(left, right, (alert) => alert.sourceIdentifiers?.sourceIdentifier), weights.exactSourceIdentifier);
  add('host', 'Same host', sharedValue(left, right, (alert) => alert.sourceIdentifiers?.host), weights.sameHost);
  add('service', 'Same service', sharedValue(left, right, (alert) => alert.service), weights.sameService);
  add('application', 'Same application', sharedValue(left, right, (alert) => alert.application), weights.sameApplication);
  add('environment', 'Same environment', sharedValue(left, right, (alert) => alert.environment), weights.sameEnvironment);
  const metricOrRule = sharedValue(left, right, (alert) => alert.sourceIdentifiers?.metric)
    || sharedValue(left, right, (alert) => alert.sourceIdentifiers?.healthRule)
    || sharedValue(left, right, (alert) => alert.sourceIdentifiers?.alertRule);
  add('metricOrRule', 'Same metric or monitoring rule', metricOrRule, weights.sameMetricOrRule);
  const leftAt = toMs(left.createdAt);
  const rightAt = toMs(right.createdAt);
  const differenceMs = leftAt === null || rightAt === null ? null : Math.abs(leftAt - rightAt);
  if (differenceMs !== null && differenceMs <= config.correlationWindowMinutes * 60000) {
    add('time', 'Close time proximity', `${Math.round(differenceMs / 60000)} minute difference`, weights.timeProximity);
  }
  const hasIdentityEvidence = evidence.some((item) => !['environment', 'time'].includes(item.key));
  const confidence = score >= config.correlation.confidence.high ? 'High'
    : score >= config.correlation.confidence.medium ? 'Medium' : 'Low';
  return { confidence, evidence, hasIdentityEvidence, score: Math.min(100, score) };
}

function correlationGroups(alerts, config) {
  const groups = [];
  const seen = new Set();
  const ordered = alerts
    .filter((alert) => toMs(alert.createdAt) !== null)
    .sort((left, right) => toMs(left.createdAt) - toMs(right.createdAt));
  let windowStart = 0;
  for (let rightIndex = 0; rightIndex < ordered.length; rightIndex += 1) {
    const right = ordered[rightIndex];
    const rightAt = toMs(right.createdAt);
    while (windowStart < rightIndex && rightAt - toMs(ordered[windowStart].createdAt) > config.correlationWindowMinutes * 60000) {
      windowStart += 1;
    }
    for (let leftIndex = windowStart; leftIndex < rightIndex; leftIndex += 1) {
      const left = ordered[leftIndex];
      if (canonical(left.sourceSystem || left.source) === canonical(right.sourceSystem || right.source)) continue;
      const leftAt = toMs(left.createdAt);
      if (leftAt === null || rightAt === null || Math.abs(leftAt - rightAt) > config.correlationWindowMinutes * 60000) continue;
      const correlation = correlationForPair(left, right, config);
      if (!correlation.hasIdentityEvidence || correlation.score < config.correlation.minimumScore) continue;
      const key = [left.id, right.id].sort().join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      const fingerprintData = buildFingerprint({
        ...left,
        message: `${left.service || left.application || left.source} correlated monitoring evidence`,
        sourceSystem: [left.sourceSystem || left.source, right.sourceSystem || right.source].sort().join('+'),
      });
      groups.push(buildBaseGroup('correlated', fingerprintData, [left, right], correlation.evidence, {
        confidence: correlation.confidence,
        correlationScore: correlation.score,
        correlations: [{ alertIds: [left.id, right.id], confidence: correlation.confidence, evidence: correlation.evidence, score: correlation.score }],
      }));
    }
  }
  return groups;
}

function scoreGroup(group, lifecycleMap, config) {
  const weights = config.noiseScoreWeights;
  const breakdown = [];
  const add = (signal, points, detail) => {
    if (!points) return;
    breakdown.push({ detail, points, signal });
  };
  if (group.classification === 'duplicate') {
    add('Duplicate pattern', weights.duplicateBase, 'Same fingerprint inside the duplicate window');
    add('Duplicate occurrences', Math.min(weights.duplicateOccurrenceCap, Math.max(0, group.occurrences - 1) * weights.duplicateOccurrence), `${group.occurrences} occurrences`);
  }
  if (group.classification === 'recurring') {
    add('Recurring pattern', weights.recurringBase, `${group.clusterCount} distinct time clusters`);
    add('Recurrence frequency', Math.min(weights.recurringOccurrenceCap, Math.max(0, group.occurrences - config.recurringMinimumOccurrences) * weights.recurringOccurrence), `${group.occurrences} occurrences`);
  }
  if (group.classification === 'flapping') add('Verified flapping', weights.flapping, `${group.cycles} lifecycle cycles`);
  if (group.classification === 'auto_resolved') add('Auto-resolved', weights.autoResolved, 'System/integration closure without human action');
  if (group.classification === 'correlated') add('Correlated pattern', weights.correlated, `${group.correlationScore}% deterministic correlation score`);

  const lifecycles = group.alerts.map((alert) => lifecycleMap.get(alert.id)).filter(Boolean);
  const explicitNoHumanAcknowledgement = group.alerts.some((alert) => alert.acknowledged === false) || lifecycles.length > 0;
  const humanAcknowledgement = group.alerts.some((alert) => alert.acknowledged === true)
    || lifecycles.some((lifecycle) => lifecycle.humanAcknowledgement);
  if (humanAcknowledgement) add('Human acknowledgement', weights.humanAcknowledgement, 'At least one alert was acknowledged by a human');
  else if (explicitNoHumanAcknowledgement) add('No human acknowledgement', weights.noHumanAcknowledgement, 'No human acknowledgement was found in available evidence');

  const durations = group.alerts.map(durationMs).filter(Number.isFinite);
  const averageDurationMs = durations.length ? durations.reduce((sum, value) => sum + value, 0) / durations.length : null;
  if (averageDurationMs !== null && averageDurationMs <= config.shortDurationMinutes * 60000) {
    add('Short active duration', weights.shortDuration, `Average duration ${Math.round(averageDurationMs / 60000)} minutes`);
  }
  if (averageDurationMs !== null && averageDurationMs >= config.longDurationMinutes * 60000) {
    add('Long active duration', weights.longDuration, `Average duration ${Math.round(averageDurationMs / 60000)} minutes`);
  }
  if (group.alerts.some((alert) => /^P[12]$/i.test(alert.priority || '') || /^critical$/i.test(alert.severity || ''))) {
    add('High operational priority', weights.highOperationalPriority, 'P1/P2 or Critical evidence requires conservative review');
  }
  if (group.jiraRelationships.length) add('Confirmed Jira relationship', weights.incidentOrProblem, `${group.jiraRelationships.length} exact Jira relationship(s)`);
  if (group.sources.length > 1) add('Multi-tool confirmation', weights.multiToolConfirmation, `${group.sources.length} monitoring sources confirm the pattern`);
  const rawScore = breakdown.reduce((sum, item) => sum + item.points, 0);
  if (rawScore < 0) add('Score floor', -rawScore, 'Phase 1 scores cannot be lower than 0');
  if (rawScore > 100) add('Score ceiling', 100 - rawScore, 'Phase 1 scores cannot be higher than 100');
  return {
    breakdown,
    noiseScore: Math.max(0, Math.min(100, rawScore)),
  };
}

function recommendationFor(group) {
  const critical = group.alerts.some((alert) => /^P1$/i.test(alert.priority || '') || /^critical$/i.test(alert.severity || ''));
  if (critical) {
    return group.classification === 'recurring'
      ? 'Recurring pattern detected — manual review required'
      : 'Needs more evidence — critical alert requires manual review';
  }
  if (group.classification === 'duplicate') return 'Review for deduplication';
  if (group.classification === 'recurring') return 'Investigate recurring pattern';
  if (group.classification === 'flapping') return 'Review flapping condition';
  if (group.classification === 'auto_resolved') return 'Review evaluation window';
  if (group.classification === 'correlated' && group.noiseScore < 40) return 'Likely actionable — retain';
  if (group.noiseScore >= 70) return 'Candidate for suppression review';
  return 'Needs more evidence';
}

function monitoringEvidenceFor(group) {
  return group.alerts.filter((alert) => KNOWN_MONITORING_SOURCES.has(alert.sourceSystem || alert.source)).map((alert) => ({
    alertNumber: alert.tinyId || null,
    application: alert.application || null,
    environment: alert.environment || null,
    host: alert.sourceIdentifiers?.host || null,
    metric: alert.sourceIdentifiers?.metric || null,
    service: alert.service || null,
    source: alert.sourceSystem || alert.source,
    sourceIdentifier: alert.sourceIdentifiers?.sourceIdentifier || null,
    sourceUrl: alert.sourceUrl || null,
    timestamp: alert.createdAt || null,
  }));
}

function analyzeNormalizedAlerts(alerts, lifecycleMap = new Map(), config = NOISE_ANALYSIS_CONFIG) {
  const buckets = fingerprintBuckets(alerts);
  return analyzeAlertBuckets(alerts, buckets, lifecycleMap, config);
}

function analyzeAlertBuckets(alerts, buckets, lifecycleMap = new Map(), config = NOISE_ANALYSIS_CONFIG) {
  const detectorGroups = [
    ...duplicateGroups(buckets, config),
    ...recurringGroups(buckets, config),
    ...flappingGroups(buckets, lifecycleMap, config),
    ...flappingLikeGroups(buckets, config),
    ...autoResolvedGroups(buckets, lifecycleMap, config),
    ...correlationGroups(alerts, config),
  ];
  const groups = consolidatePatternGroups(detectorGroups);
  groups.forEach((group) => {
    group.monitoringEvidence = monitoringEvidenceFor(group);
  });
  return groups;
}

function createIncrementalAlertAccumulator() {
  const alerts = [];
  const buckets = new Map();
  const seen = new Set();

  function addRawPage(values = []) {
    let added = 0;
    values.forEach((raw) => {
      const identity = raw.id || [raw.tinyId, raw.createdAt, raw.message || raw.summary].filter(Boolean).join('|');
      if (!identity || seen.has(identity)) return;
      const alert = normalizeAlert(raw);
      const fingerprintData = buildFingerprint(alert);
      alert.fingerprintData = fingerprintData;
      seen.add(identity);
      alerts.push(alert);
      const items = buckets.get(fingerprintData.fingerprintHash) || [];
      items.push(alert);
      buckets.set(fingerprintData.fingerprintHash, items);
      added += 1;
    });
    return added;
  }

  return {
    addRawPage,
    get alerts() { return alerts; },
    get buckets() { return buckets; },
    get size() { return alerts.length; },
  };
}

function normalizeAlert(raw) {
  const normalized = normalizeOperationsAlert(raw);
  const sourceIdentifierData = sourceIdentifiers(normalized);
  return {
    ...normalized,
    actions: Array.isArray(raw.actions) ? raw.actions : [],
    sourceIdentifiers: sourceIdentifierData,
  };
}

async function runInChunks(items, chunkSize, task) {
  const results = [];
  for (let index = 0; index < items.length; index += chunkSize) {
    const chunk = items.slice(index, index + chunkSize);
    results.push(...await Promise.all(chunk.map(task)));
  }
  return results;
}

function lifecycleCandidates(alerts, config) {
  const buckets = fingerprintBuckets(alerts);
  const prioritized = [];
  const seen = new Set();
  const add = (alert) => {
    if (!alert.id || seen.has(alert.id) || !alert.closeTime) return;
    seen.add(alert.id);
    prioritized.push(alert);
  };
  [...buckets.values()].filter((items) => items.length >= config.flappingMinimumCycles).forEach((items) => items.forEach(add));
  [...alerts].sort((a, b) => (toMs(b.createdAt) || 0) - (toMs(a.createdAt) || 0)).forEach(add);
  return prioritized.slice(0, config.maximumLifecycleInspections);
}

async function defaultFeedbackStore() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS noise_analysis_feedback (
      analysis_group_id TEXT PRIMARY KEY,
      feedback TEXT NOT NULL,
      user_identity TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  return {
    async getMany(groupIds) {
      if (!groupIds.length) return {};
      const result = await db.query(
        'SELECT analysis_group_id, feedback, user_identity, updated_at FROM noise_analysis_feedback WHERE analysis_group_id = ANY($1::text[])',
        [groupIds],
      );
      return Object.fromEntries(result.rows.map((row) => [row.analysis_group_id, {
        analysisGroupId: row.analysis_group_id,
        feedback: row.feedback,
        timestamp: row.updated_at,
        userIdentity: row.user_identity || null,
      }]));
    },
    async save(analysisGroupId, feedback) {
      const result = await db.query(
        `
          INSERT INTO noise_analysis_feedback (analysis_group_id, feedback, updated_at)
          VALUES ($1, $2, NOW())
          ON CONFLICT (analysis_group_id)
          DO UPDATE SET feedback = EXCLUDED.feedback, updated_at = NOW()
          RETURNING analysis_group_id, feedback, user_identity, updated_at
        `,
        [analysisGroupId, feedback],
      );
      const row = result.rows[0];
      return { analysisGroupId: row.analysis_group_id, feedback: row.feedback, timestamp: row.updated_at, userIdentity: row.user_identity || null };
    },
  };
}

function parseRange(value) {
  const range = String(value || '7d').toLowerCase();
  if (!RANGE_MILLISECONDS[range]) throw safeError('range must be 24h, 7d, 30d, or 90d.', 'INVALID_NOISE_ANALYSIS_RANGE');
  return range;
}

function parseListOptions(options = {}) {
  const classification = String(options.classification || 'all').toLowerCase();
  if (!CLASSIFICATIONS.has(classification)) throw safeError('Unsupported noise classification.', 'INVALID_NOISE_CLASSIFICATION');
  const page = Number.parseInt(options.page || '1', 10);
  const size = Number.parseInt(options.size || '25', 10);
  const minNoiseScore = Number(options.minNoiseScore || 0);
  if (!Number.isSafeInteger(page) || page < 1) throw safeError('page must be a positive integer.', 'INVALID_NOISE_PAGE');
  if (![25, 50, 100].includes(size)) throw safeError('size must be 25, 50, or 100.', 'INVALID_NOISE_PAGE_SIZE');
  if (!Number.isFinite(minNoiseScore) || minNoiseScore < 0 || minNoiseScore > 100) throw safeError('minNoiseScore must be between 0 and 100.', 'INVALID_NOISE_SCORE');
  return {
    classification,
    environment: canonical(options.environment),
    minNoiseScore,
    page,
    priority: canonical(options.priority),
    range: parseRange(options.range),
    refresh: String(options.refresh || '').toLowerCase() === 'true',
    size,
    source: canonical(options.source),
  };
}

function summaryFor(groups, alertsAnalyzed) {
  const count = (label) => groups.filter((group) => (group.labels || []).includes(label)).length;
  return {
    alertsAnalyzed,
    autoResolved: count('auto_resolved'),
    correlatedGroups: count('cross_alert_cluster'),
    duplicateGroups: count('duplicate'),
    flappingPatterns: count('flapping'),
    flappingLikePatterns: count('flapping_like'),
    highHumanToilGroups: count('high_human_toil'),
    multiLabelGroups: groups.filter((group) => (group.labels || []).length > 1).length,
    potentialNoiseGroups: groups.length,
    recurringPatterns: count('recurring'),
  };
}

function createNoiseAnalysisService({
  config = NOISE_ANALYSIS_CONFIG,
  feedbackStoreFactory = defaultFeedbackStore,
  now = () => Date.now(),
  operationsService = operationsReadService,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
} = {}) {
  const cache = new Map();
  let feedbackStorePromise = null;

  function cacheKey(range) {
    return `${config.analysisVersion}:${range}`;
  }

  function transientOperationsError(error) {
    return error?.status === 408 || error?.status === 429 || Number(error?.status) >= 500 || error?.code === 'NETWORK_OR_TLS_FAILURE';
  }

  async function listOperationsPage(options) {
    const delays = config.operationsRetryDelaysMs || [];
    let attempt = 0;
    while (true) {
      try {
        return await operationsService.listAlerts(options);
      } catch (error) {
        if (!transientOperationsError(error) || attempt >= delays.length) throw error;
        await sleep(delays[attempt]);
        attempt += 1;
      }
    }
  }

  async function fetchOperations(range) {
    const to = now();
    const from = to - RANGE_MILLISECONDS[range];
    const accumulator = createIncrementalAlertAccumulator();
    let apiRequests = 0;
    let completedTraversal = false;
    let fetchError = null;
    let peakHeapUsedBytes = process.memoryUsage().heapUsed;
    let pagesFetched = 0;
    let totalAvailable = null;
    let windowsFetched = 0;
    let windowsPartitioned = 0;

    const requestPage = async (windowFrom, windowTo, offset = 0) => {
      apiRequests += 1;
      const response = await listOperationsPage({
        from: windowFrom,
        offset,
        order: 'desc',
        size: config.operationsPageSize,
        sort: 'createdAt',
        to: windowTo,
      });
      pagesFetched += 1;
      peakHeapUsedBytes = Math.max(peakHeapUsedBytes, process.memoryUsage().heapUsed);
      return response;
    };

    const fetchWindow = async (windowFrom, windowTo, initialPage = null) => {
      const firstPage = initialPage || await requestPage(windowFrom, windowTo, 0);
      const windowTotal = Math.max(0, Number(firstPage.count ?? firstPage.values?.length ?? 0));
      if (windowTotal > config.operationsWindowMaxAlerts) {
        if (windowTo - windowFrom <= 1) {
          throw safeError('Operations history is too dense to paginate safely inside a one-millisecond window.', 'OPERATIONS_WINDOW_TOO_DENSE', 422);
        }
        windowsPartitioned += 1;
        const midpoint = Math.floor(windowFrom + (windowTo - windowFrom) / 2);
        // Newer windows are fetched first, matching the existing newest-first
        // behavior if a later request makes the overall analysis partial.
        await fetchWindow(midpoint + 1, windowTo);
        await fetchWindow(windowFrom, midpoint);
        return;
      }

      windowsFetched += 1;
      let offset = 0;
      let page = firstPage;
      let recordsVisited = 0;
      while (true) {
        const values = Array.isArray(page.values) ? page.values : [];
        accumulator.addRawPage(values);
        recordsVisited += values.length;
        peakHeapUsedBytes = Math.max(peakHeapUsedBytes, process.memoryUsage().heapUsed);
        const hasNext = page.pagination?.hasNextPage || recordsVisited < windowTotal;
        if (!values.length || !hasNext || recordsVisited >= windowTotal) break;
        offset += config.operationsPageSize;
        page = await requestPage(windowFrom, windowTo, offset);
      }
    };

    try {
      const firstPage = await requestPage(from, to, 0);
      totalAvailable = Math.max(0, Number(firstPage.count ?? firstPage.values?.length ?? 0));
      await fetchWindow(from, to, firstPage);
      completedTraversal = true;
    } catch (error) {
      if (!pagesFetched) throw error;
      fetchError = {
        code: error.code || 'OPERATIONS_PAGE_FETCH_FAILED',
        message: error.safeMessage || 'A later Operations history page could not be retrieved.',
        status: Number(error.status) || 502,
      };
    }

    accumulator.alerts.sort((left, right) => (toMs(left.createdAt) || 0) - (toMs(right.createdAt) || 0));
    const alertsFetched = accumulator.size;
    const complete = completedTraversal && totalAvailable !== null && alertsFetched >= totalAvailable;
    const coveragePercentage = totalAvailable
      ? Number(Math.min(100, alertsFetched / totalAvailable * 100).toFixed(1))
      : complete ? 100 : 0;
    return {
      accumulator,
      alerts: accumulator.alerts,
      alertsFetched,
      apiRequests,
      complete,
      coveragePercentage,
      fetchError,
      from: toIso(from),
      pagesFetched,
      peakHeapUsedBytes,
      to: toIso(to),
      totalAvailable: totalAvailable ?? alertsFetched,
      windowsFetched,
      windowsPartitioned,
    };
  }

  async function fetchLifecycles(alerts) {
    const sameIdCandidates = lifecycleCandidates(alerts, config);
    const autoResolutionCandidates = alerts.filter((alert) => (
      (Boolean(alert.closeTime) || /closed|resolved/i.test(String(alert.status || '')))
      && alert.acknowledged !== true
      && !alert.ackTime
    ));
    const candidates = [...new Map([...sameIdCandidates, ...autoResolutionCandidates].map((alert) => [alert.id, alert])).values()];
    const results = await runInChunks(candidates, config.autoResolutionConcurrency || 6, async (alert) => {
      try {
        const response = await operationsService.getLogs(alert.id, { size: 100 });
        return [alert.id, lifecycleFromLogs(alert, response.values || [])];
      } catch {
        return [alert.id, null];
      }
    });
    const lifecycleMap = new Map(results.filter(([, lifecycle]) => lifecycle));
    let proven = 0;
    let notAutoResolved = 0;
    let unknown = 0;
    autoResolutionCandidates.forEach((alert) => {
      const lifecycle = lifecycleMap.get(alert.id);
      if (!lifecycle || !lifecycle.verifiedClosedCycle || !lifecycle.closedBy) {
        unknown += 1;
      } else if (lifecycle.closedBySystem && !lifecycle.humanAcknowledgement && !lifecycle.humanAction && alert.acknowledged !== true) {
        proven += 1;
      } else {
        notAutoResolved += 1;
      }
    });
    const inspected = autoResolutionCandidates.length - results.filter(([id, lifecycle]) => autoResolutionCandidates.some((alert) => alert.id === id) && !lifecycle).length;
    return {
      attempted: candidates.length,
      autoResolution: {
        candidates: autoResolutionCandidates.length,
        inspected,
        inspectionCoveragePercentage: autoResolutionCandidates.length ? Number((inspected / autoResolutionCandidates.length * 100).toFixed(1)) : 100,
        notAutoResolved,
        proven,
        unknown,
      },
      lifecycleMap,
      sameIdCandidates: sameIdCandidates.length,
      succeeded: results.filter(([, lifecycle]) => lifecycle).length,
    };
  }

  async function getFeedbackStore() {
    if (!feedbackStorePromise) feedbackStorePromise = Promise.resolve(feedbackStoreFactory());
    return feedbackStorePromise;
  }

  async function analyzeRange(range, refresh = false) {
    const key = cacheKey(range);
    if (refresh) cache.delete(key);
    const cached = cache.get(key);
    if (!refresh && cached && now() - cached.cachedAtMs < config.cacheTtlMs) {
      const cachedResult = { ...cached, cache: { ...cached.cache, hit: true } };
      Object.defineProperty(cachedResult, '_normalizedAlerts', { enumerable: false, value: cached._normalizedAlerts || [] });
      return cachedResult;
    }
    const startedAt = now();
    const startedHeapUsedBytes = process.memoryUsage().heapUsed;
    const operations = await fetchOperations(range);
    const lifecycles = await fetchLifecycles(operations.alerts);
    operations.alerts.forEach((alert) => {
      const lifecycle = lifecycles.lifecycleMap.get(alert.id);
      if (!lifecycle) return;
      alert.actionabilityLifecycle = {
        closedBySystem: lifecycle.closedBySystem === true,
        cycles: Number(lifecycle.cycles || 0),
        humanAcknowledgement: lifecycle.humanAcknowledgement === true,
        humanAction: lifecycle.humanAction === true,
        observed: true,
        verifiedClosedCycle: lifecycle.verifiedClosedCycle === true,
      };
    });
    const groupingStartedAt = Date.now();
    const groups = analyzeAlertBuckets(operations.alerts, operations.accumulator.buckets, lifecycles.lifecycleMap, config);
    const groupingExecutionTimeMs = Date.now() - groupingStartedAt;
    groups.forEach((group) => {
      const oldVariants = (group._detectorGroups || [group]).map((detectorGroup) => ({
        classification: detectorGroup.classification,
        ...scoreGroup(detectorGroup, lifecycles.lifecycleMap, config),
      }));
      const oldScore = oldVariants.sort((left, right) => right.noiseScore - left.noiseScore)[0];
      const score = scoreNoiseLikelihood(group);
      if (score.shortLived && !group.labels.includes('short_lived')) group.labels.push('short_lived');
      if (score.humanToil.level === 'HIGH' && !group.labels.includes('high_human_toil')) group.labels.push('high_human_toil');
      if (group.alerts.some((alert) => /^P[12]$/i.test(String(alert.priority || '')) || /^critical$/i.test(String(alert.severity || ''))) && !group.labels.includes('high_priority')) group.labels.push('high_priority');
      group.oldNoiseScore = oldScore?.noiseScore ?? 0;
      group.oldScoreBreakdown = oldScore?.breakdown || [];
      group.oldScoreClassification = oldScore?.classification || group.classification;
      group.noiseLikelihood = score.noiseLikelihood;
      group.noiseScore = score.noiseLikelihood;
      group.scoreBreakdown = score.breakdown;
      group.scoreDimensions = score.dimensions;
      group.scoreNormalization = score.normalization;
      group.humanToil = score.humanToil;
      group.reviewRisk = assessReviewRisk(group);
      group.correlationConfidence = null;
      group.recommendation = calibratedRecommendationFor(group.noiseLikelihood, group.reviewRisk);
      group.readOnly = true;
    });
    groups.sort((left, right) => right.noiseLikelihood - left.noiseLikelihood || (toMs(right.lastSeen) || 0) - (toMs(left.lastSeen) || 0));
    let feedback = {};
    try {
      feedback = await (await getFeedbackStore()).getMany(groups.flatMap((group) => [group.groupId, ...(group.legacyGroupIds || [])]));
    } catch {
      feedback = {};
    }
    groups.forEach((group) => { group.feedback = feedback[group.groupId] || (group.legacyGroupIds || []).map((id) => feedback[id]).find(Boolean) || null; });
    const completedAt = now();
    const alertsAnalyzed = operations.alerts.length;
    const analysisCoverage = {
      alertsAnalyzed,
      alertsFetched: operations.alertsFetched,
      complete: operations.complete,
      coveragePercentage: operations.coveragePercentage,
      status: operations.complete ? 'COMPLETE' : 'PARTIAL',
      totalAlertsInRange: operations.totalAvailable,
    };
    const result = {
      analysisExecutionTimeMs: Math.max(0, completedAt - startedAt),
      alertsAnalyzed,
      alertsFetched: operations.alertsFetched,
      analysisCoverage,
      analysisVersion: config.analysisVersion,
      authoritativeSource: 'jsm_operations',
      bounded: false,
      cache: { hit: false, key, ttlMs: config.cacheTtlMs, version: config.analysisVersion },
      cachedAt: toIso(completedAt),
      cachedAtMs: completedAt,
      complete: operations.complete,
      coverage: {
        analysis: analysisCoverage,
        autoResolution: lifecycles.autoResolution,
        jiraEvidence: 'on_demand',
        lifecycleAlertsAttempted: lifecycles.attempted,
        lifecycleAlertsInspected: lifecycles.succeeded,
        sameIdLifecycleCandidates: lifecycles.sameIdCandidates,
        monitoringEvidence: 'operations_normalized',
        operationsApiRequests: operations.apiRequests,
        operationsPagesFetched: operations.pagesFetched,
        operationsWindowsFetched: operations.windowsFetched,
        operationsWindowsPartitioned: operations.windowsPartitioned,
        slackEvidence: 'on_demand',
      },
      coveragePercentage: operations.coveragePercentage,
      fetchError: operations.fetchError,
      groups,
      performance: {
        groupingExecutionTimeMs,
        peakHeapUsedBytes: Math.max(operations.peakHeapUsedBytes, process.memoryUsage().heapUsed),
        startedHeapUsedBytes,
      },
      range,
      rangeFrom: operations.from,
      rangeTo: operations.to,
      readOnly: true,
      summary: summaryFor(groups, alertsAnalyzed),
      totalAlertsInRange: operations.totalAvailable,
      totalOperationsAlertsInRange: operations.totalAvailable,
    };
    // Internal-only normalized records support read-only aggregate simulations
    // without expanding the public Phase 2.6 response by thousands of alerts.
    Object.defineProperty(result, '_normalizedAlerts', { enumerable: false, value: operations.alerts });
    if (operations.complete) cache.set(key, result);
    return result;
  }

  async function list(options = {}) {
    const parsed = parseListOptions(options);
    const result = await analyzeRange(parsed.range, parsed.refresh);
    const filtered = result.groups.filter((group) => (
      (!parsed.source || group.sources.some((source) => canonical(source) === parsed.source))
      && (!parsed.priority || canonical(group.priority) === parsed.priority)
      && (!parsed.environment || group.alerts.some((alert) => canonical(alert.environment) === parsed.environment))
      && (parsed.classification === 'all' || group.classification === parsed.classification || group.labels.includes(parsed.classification))
      && group.noiseLikelihood >= parsed.minNoiseScore
    ));
    const totalPages = Math.max(1, Math.ceil(filtered.length / parsed.size));
    const page = Math.min(parsed.page, totalPages);
    const start = (page - 1) * parsed.size;
    return {
      ...result,
      cachedAtMs: undefined,
      filterOptions: {
        environments: [...new Set(result.groups.flatMap((group) => group.alerts.map((alert) => alert.environment).filter(Boolean)))].sort(),
        priorities: [...new Set(result.groups.map((group) => group.priority).filter(Boolean))].sort(),
        sources: [...new Set(result.groups.flatMap((group) => group.sources))].sort(),
      },
      groups: filtered.slice(start, start + parsed.size),
      pagination: { page, size: parsed.size, total: filtered.length, totalPages },
    };
  }

  async function getGroup(groupId, options = {}) {
    const id = String(groupId || '').trim();
    if (!/^[a-f0-9]{24}$/.test(id)) throw safeError('A valid analysis group ID is required.', 'INVALID_NOISE_GROUP_ID');
    const result = await analyzeRange(parseRange(options.range), String(options.refresh || '').toLowerCase() === 'true');
    const group = result.groups.find((item) => item.groupId === id || (item.legacyGroupIds || []).includes(id));
    if (!group) throw safeError('Noise analysis group was not found in the selected range.', 'NOISE_GROUP_NOT_FOUND', 404);
    return {
      analysisExecutionTimeMs: result.analysisExecutionTimeMs,
      analysisVersion: result.analysisVersion,
      alertsAnalyzed: result.alertsAnalyzed,
      alertsFetched: result.alertsFetched,
      analysisCoverage: result.analysisCoverage,
      authoritativeSource: result.authoritativeSource,
      complete: result.complete,
      coverage: result.coverage,
      coveragePercentage: result.coveragePercentage,
      group,
      range: result.range,
      rangeFrom: result.rangeFrom,
      rangeTo: result.rangeTo,
      readOnly: true,
      totalAlertsInRange: result.totalAlertsInRange,
    };
  }

  async function saveFeedback(groupId, value) {
    const id = String(groupId || '').trim();
    const feedback = String(value || '').trim().toLowerCase();
    if (!/^[a-f0-9]{24}$/.test(id)) throw safeError('A valid analysis group ID is required.', 'INVALID_NOISE_GROUP_ID');
    if (!FEEDBACK_VALUES.has(feedback)) throw safeError('feedback must be useful_finding, not_noise, or needs_review.', 'INVALID_NOISE_FEEDBACK');
    const saved = await (await getFeedbackStore()).save(id, feedback);
    for (const result of cache.values()) {
      const group = result.groups.find((item) => item.groupId === id);
      if (group) group.feedback = saved;
    }
    return { ...saved, externalMutations: 'none', localOnly: true };
  }

  return { analyzeRange, getGroup, list, saveFeedback };
}

module.exports = {
  CLASSIFICATIONS,
  RANGE_MILLISECONDS,
  analyzeAlertBuckets,
  analyzeNormalizedAlerts,
  buildFingerprint,
  consolidatePatternGroups,
  correlationForPair,
  createIncrementalAlertAccumulator,
  createNoiseAnalysisService,
  flappingLikeGroups,
  lifecycleFromLogs,
  normalizeVolatileText,
  recommendationFor,
  scoreGroup,
  service: createNoiseAnalysisService(),
};
