const crypto = require('node:crypto');
const db = require('../config/db');
const { NOISE_APPDYNAMICS_EVENT_RECONSTRUCTION_CONFIG } = require('../config/noiseAppDynamicsEventReconstruction');
const { service: enrichmentService } = require('./noiseEvidenceEnrichment.service');
const { validateTelemetry } = require('./noiseAppDynamicsTelemetrySemantics.service');

const RANGE = '24h';
const CONDITION_FAMILIES = Object.freeze([
  'RESPONSE_TIME_DEGRADATION', 'ERROR_DEGRADATION', 'LOAD_ANOMALY',
  'NODE_HEALTH_DEGRADATION', 'BUSINESS_TRANSACTION_DEGRADATION',
  'DATABASE_DEGRADATION', 'MEMORY_DEGRADATION', 'CPU_DEGRADATION',
  'HEALTH_RULE_VIOLATION', 'UNKNOWN',
]);

function cleanText(value) {
  return String(value ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function canonical(value) {
  return cleanText(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function hash(value, length = 24) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, length);
}

function unique(values) {
  return [...new Set(values.filter(Boolean).map(cleanText).filter(Boolean))];
}

function toMs(value) {
  if (Number.isFinite(value)) return Number(value);
  const parsed = value ? new Date(value).getTime() : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function iso(value) {
  const milliseconds = toMs(value);
  return milliseconds === null ? null : new Date(milliseconds).toISOString();
}

function queriesFor(record) {
  const source = record?.sources?.appDynamics;
  const queries = Array.isArray(source?.query) ? source.query : [source?.query];
  if (record?.appDynamicsEvidence?.query) queries.push(record.appDynamicsEvidence.query);
  return queries.filter((item) => item && typeof item === 'object');
}

function conditionFamily(record, query = {}) {
  const text = [query.metricIntent, record?.pattern, record?.appDynamicsEvidence?.metricIntent,
    record?.appDynamicsEvidence?.identity?.tier, record?.appDynamicsEvidence?.identity?.node]
    .filter(Boolean).join(' ').toLowerCase();
  if (/response.?time|latency|slow/.test(text)) return 'RESPONSE_TIME_DEGRADATION';
  if (/business.?transaction|\bbt\b/.test(text)) return 'BUSINESS_TRANSACTION_DEGRADATION';
  if (/database|db |sql|jdbc/.test(text)) return 'DATABASE_DEGRADATION';
  if (/memory|heap|garbage.?collection|\bgc\b/.test(text)) return 'MEMORY_DEGRADATION';
  if (/cpu/.test(text)) return 'CPU_DEGRADATION';
  if (/node|machine.?agent|server.?health/.test(text)) return 'NODE_HEALTH_DEGRADATION';
  if (/error|exception|failure|failed/.test(text)) return 'ERROR_DEGRADATION';
  if (/load|calls.?per.?minute|throughput|volume/.test(text)) return 'LOAD_ANOMALY';
  if (/health.?rule|violation/.test(text)) return 'HEALTH_RULE_VIOLATION';
  return 'UNKNOWN';
}

function recordTimestamp(record) {
  return iso(record?.timestamp || record?.time || record?.eventTime || record?.startTime || record?.metadata?.timestamp);
}

function eventTransition(record) {
  const message = [record?.title, record?.summary, record?.message, record?.eventMessage,
    record?.description, record?.name].filter(Boolean).join(' ').toLowerCase();
  const type = [record?.type, record?.eventType].filter(Boolean).join(' ').toLowerCase();
  const contradictoryViolation = /started.{0,20}violat|continues?.{0,20}violat|still.{0,20}(?:critical|violat)|now.{0,10}critical/.test(message);
  const recovery = !contradictoryViolation && /recover|return(?:ed)? to normal|clear(?:ed)?|resolv(?:ed|ing)|ended|normal state/.test(message);
  const degradation = contradictoryViolation || /critical|degrad|problem|failed|failure|exception|error/.test(`${message} ${type}`);
  return recovery ? 'RECOVERED' : degradation ? 'DEGRADED' : null;
}

function normalizeRecord(record, provenance) {
  if (!record || typeof record !== 'object') return null;
  const timestamp = recordTimestamp(record);
  if (!timestamp) return null;
  const metadata = record.metadata && typeof record.metadata === 'object' ? record.metadata : {};
  const explicitType = cleanText(record.recordType || record.type || '').toUpperCase();
  const isMetric = explicitType === 'METRIC' || /monitoring_telemetry/.test(explicitType.toLowerCase())
    || (record.metric && record.value !== undefined) || (metadata.metric && metadata.value !== undefined);
  const metric = cleanText(record.metric || metadata.metric || record.title) || null;
  const rawValue = record.value ?? metadata.value;
  const numericValue = rawValue === '' || rawValue === null || rawValue === undefined ? null : Number(rawValue);
  const summary = cleanText(record.summary || record.message || record.eventMessage || record.description || record.title || record.name);
  return {
    id: cleanText(record.id) || `appd-record-${hash(`${timestamp}|${explicitType}|${metric}|${summary}|${provenance.alertId}`)}`,
    timestamp,
    type: isMetric ? 'METRIC' : 'EVENT',
    metric,
    metricPath: cleanText(record.metricPath || metadata.metricPath) || null,
    value: Number.isFinite(numericValue) ? numericValue : null,
    unit: cleanText(record.unit || metadata.unit) || null,
    aggregation: cleanText(record.aggregation || metadata.aggregation) || null,
    rollup: cleanText(record.rollup || metadata.rollup) || null,
    eventType: isMetric ? null : cleanText(record.eventType || record.type || record.recordType) || 'APPDYNAMICS_EVENT',
    transition: isMetric ? null : eventTransition(record),
    summary: summary || (metric ? `${metric}: ${rawValue}` : 'AppDynamics source event'),
    severity: cleanText(record.severity) || null,
    entity: cleanText(record.entity || record.tierName || record.nodeName || metadata.tier || metadata.node || metadata.businessTransaction) || null,
    metadata: {
      applicationId: cleanText(metadata.applicationId || provenance.applicationId) || null,
      healthRule: cleanText(record.healthRule || record.healthRuleName || metadata.healthRule) || null,
      tier: cleanText(record.tierName || metadata.tier) || null,
      node: cleanText(record.nodeName || metadata.node) || null,
      businessTransaction: cleanText(record.businessTransaction || metadata.businessTransaction) || null,
      entityType: cleanText(record.entityType || metadata.entityType) || null,
      entityId: cleanText(record.entityId || metadata.entityId) || null,
      metricPath: cleanText(record.metricPath || metadata.metricPath) || null,
      aggregation: cleanText(record.aggregation || metadata.aggregation) || null,
      rollup: cleanText(record.rollup || metadata.rollup) || null,
    },
    provenance: { source: 'AppDynamics', alertId: provenance.alertId, queryIndex: provenance.queryIndex, recordIndex: provenance.recordIndex },
  };
}

function telemetryFor(record) {
  const points = [];
  const seen = new Set();
  queriesFor(record).forEach((query, queryIndex) => {
    const rows = Array.isArray(query.normalizedRecords) ? query.normalizedRecords
      : Array.isArray(query.rawRecords) ? query.rawRecords : [];
    rows.forEach((item, recordIndex) => {
      const normalized = normalizeRecord(item, { alertId: String(record.alertId), queryIndex, recordIndex,
        applicationId: query.applicationId || record?.appDynamicsEvidence?.identity?.applicationId });
      if (!normalized) return;
      const key = `${normalized.id}|${normalized.timestamp}|${normalized.type}|${normalized.metric || ''}|${normalized.value ?? ''}`;
      if (seen.has(key)) return;
      seen.add(key);
      points.push(normalized);
    });
  });
  return points.sort((left, right) => toMs(left.timestamp) - toMs(right.timestamp) || left.id.localeCompare(right.id));
}

function applicationIdentity(record, query = {}) {
  const evidence = record?.appDynamicsEvidence || {};
  return {
    id: cleanText(query.applicationId || evidence.identity?.applicationId || record?.mapping?.entityId) || null,
    name: cleanText(evidence.identity?.applicationName || record?.mapping?.entity || record?.identity?.canonicalName) || null,
    tier: cleanText(evidence.identity?.tier) || null,
    node: cleanText(evidence.identity?.node) || null,
    businessTransaction: cleanText(evidence.identity?.businessTransaction) || null,
  };
}

function buildCandidate(record) {
  const queries = queriesFor(record);
  const query = queries[0] || {};
  const rawTelemetry = telemetryFor(record);
  const baseFamily = conditionFamily(record, query);
  const validation = validateTelemetry(rawTelemetry, {
    conditionFamily: baseFamily,
    metricIntent: query.metricIntent || record?.appDynamicsEvidence?.metricIntent || baseFamily,
    query,
  });
  const telemetry = validation.usableRecords;
  const transitions = telemetry.filter((item) => item.transition);
  const degraded = transitions.filter((item) => item.transition === 'DEGRADED');
  const recovered = transitions.filter((item) => item.transition === 'RECOVERED');
  const accepted = ['EXACT', 'STRONG', 'CONFIRMED_LOCAL'].includes(String(record?.sourceMapping?.level || record?.mapping?.state || record?.appDynamicsEvidence?.identity?.mappingState || '').toUpperCase());
  const sourceActionable = record.newClassification === 'ACTIONABLE' || record.resultingActionability === 'ACTIONABLE'
    || record?.appDynamicsEvidence?.actionabilityClassification === 'ACTIONABLE';
  const sourceNonActionable = record.newClassification === 'NON_ACTIONABLE' || record.resultingActionability === 'NON_ACTIONABLE';
  const queryFrom = iso(query.windowStart || record?.investigationWindow?.from || record?.windowStart);
  const queryTo = iso(query.windowEnd || record?.investigationWindow?.to || record?.windowEnd);
  const telemetryFrom = telemetry[0]?.timestamp || null;
  const telemetryTo = telemetry.at(-1)?.timestamp || null;
  const boundary = validation.status === 'MISMATCHED' ? 'EVIDENCE_INVALID_METRIC'
    : degraded.length ? 'SOURCE_EVENT_TRANSITION'
    : accepted && sourceActionable && validation.evidenceLevel === 'DIRECT' && telemetry.length ? 'PERSISTED_SOURCE_ACTIONABILITY_WINDOW'
      : sourceNonActionable && recovered.length ? 'SOURCE_RECOVERY_TRANSITION' : 'DEGRADATION_BOUNDARY_UNKNOWN';
  const eventStart = degraded[0]?.timestamp || (boundary === 'PERSISTED_SOURCE_ACTIONABILITY_WINDOW' ? telemetryFrom : null);
  const recovery = recovered.find((item) => eventStart && toMs(item.timestamp) >= toMs(eventStart)) || null;
  const metrics = telemetry.filter((item) => item.type === 'METRIC' && Number.isFinite(item.value)
    && (!eventStart || toMs(item.timestamp) >= toMs(eventStart))
    && (!recovery || toMs(item.timestamp) <= toMs(recovery.timestamp)));
  const peakPoint = [...metrics].sort((left, right) => right.value - left.value || toMs(left.timestamp) - toMs(right.timestamp))[0] || null;
  const app = applicationIdentity(record, query);
  const family = baseFamily !== 'UNKNOWN' ? baseFamily
    : transitions.some((item) => /application.?error|error|exception|fail/i.test(`${item.eventType || ''} ${item.summary || ''}`)) ? 'ERROR_DEGRADATION'
      : transitions.some((item) => item.metadata?.healthRule) ? 'HEALTH_RULE_VIOLATION' : 'UNKNOWN';
  const entity = transitions.map((item) => item.entity).find(Boolean) || app.node || app.tier || app.businessTransaction || app.name || app.id;
  const conditionIdentity = cleanText(record?.appDynamicsEvidence?.identity?.healthRule || record?.appDynamicsEvidence?.healthRule
    || record?.pattern || record?.title) || family;
  const transitionSequence = transitions.map((item) => item.transition).filter((value, index, values) => index === 0 || value !== values[index - 1]);
  const flapping = transitionSequence.filter((value) => value === 'DEGRADED').length >= 2
    && transitionSequence.filter((value) => value === 'RECOVERED').length >= 2;
  return {
    alertId: String(record.alertId), alertNumber: cleanText(record.alertNumber) || null,
    patternId: cleanText(record.patternId) || null, pattern: cleanText(record.pattern) || family,
    application: app, conditionFamily: family, entity: entity || null,
    conditionIdentity,
    identityKey: `${app.id || canonical(app.name) || 'unknown'}|${canonical(entity) || 'application'}|${family}|${canonical(conditionIdentity)}`,
    acceptedMapping: accepted, sourceActionable, sourceNonActionable,
    confidence: boundary === 'SOURCE_EVENT_TRANSITION' && accepted && validation.evidenceLevel === 'DIRECT' ? 'HIGH'
      : boundary === 'PERSISTED_SOURCE_ACTIONABILITY_WINDOW' && accepted && validation.evidenceLevel === 'DIRECT' ? 'MEDIUM' : 'LOW',
    boundary, eventStart, recoveryAt: recovery?.timestamp || null,
    queryWindow: { from: queryFrom || telemetryFrom, to: queryTo || telemetryTo },
    peak: peakPoint ? { timestamp: peakPoint.timestamp, metric: peakPoint.metric, value: peakPoint.value, unit: peakPoint.unit, recordId: peakPoint.id } : null,
    telemetry, rawTelemetryCount: rawTelemetry.length, transitions, transitionCount: transitionSequence.length, flapping,
    mapping: {
      level: cleanText(record?.sourceMapping?.level || record?.mapping?.state || record?.appDynamicsEvidence?.identity?.mappingState) || 'NONE',
      accepted,
      reasons: record?.sourceMapping?.reasons || record?.mapping?.reasons || [],
    },
    telemetryValidation: validation,
  };
}

function canMerge(left, right, config) {
  if (left.identityKey !== right.identityKey || !left.eventStart || !right.eventStart) return false;
  if (left.recoveryAt && toMs(left.recoveryAt) < toMs(right.eventStart)) return false;
  const leftEnd = toMs(left.queryWindow.to || left.telemetry.at(-1)?.timestamp || left.eventStart);
  const rightStart = toMs(right.queryWindow.from || right.eventStart);
  return rightStart <= leftEnd + config.compatibleGapMs;
}

function notificationDistinctInformation(notifications) {
  const sorted = [...notifications].sort((left, right) => toMs(left.createdAt) - toMs(right.createdAt));
  return sorted.map((notification, index) => {
    if (index === 0) return { alertId: notification.alertId, distinct: ['REPRESENTATIVE_SIGNAL'] };
    const prior = sorted.slice(0, index);
    const distinct = [];
    const severityRank = (value) => /p1|critical/i.test(value || '') ? 4 : /p2|high/i.test(value || '') ? 3 : /p3|warn|medium/i.test(value || '') ? 2 : 1;
    if (severityRank(notification.priority || notification.severity) > Math.max(...prior.map((item) => severityRank(item.priority || item.severity)))) distinct.push('MATERIAL_ESCALATION');
    if (notification.component && !prior.some((item) => canonical(item.component) === canonical(notification.component))) distinct.push('NEW_AFFECTED_COMPONENT');
    return { alertId: notification.alertId, distinct };
  });
}

function mergeCandidateGroup(candidates, notifications, config) {
  const telemetry = [];
  const telemetryIds = new Set();
  candidates.flatMap((item) => item.telemetry).forEach((item) => {
    if (!telemetryIds.has(item.id)) { telemetryIds.add(item.id); telemetry.push(item); }
  });
  telemetry.sort((left, right) => toMs(left.timestamp) - toMs(right.timestamp) || left.id.localeCompare(right.id));
  const start = candidates.map((item) => item.eventStart).filter(Boolean).sort()[0] || null;
  const recoveries = candidates.map((item) => item.recoveryAt).filter((value) => value && (!start || toMs(value) >= toMs(start))).sort();
  const recoveryAt = recoveries[0] || null;
  const notificationIds = new Set(candidates.map((item) => item.alertId));
  const eventNotifications = notifications.filter((item) => notificationIds.has(String(item.alertId)))
    .sort((left, right) => toMs(left.createdAt) - toMs(right.createdAt) || left.alertId.localeCompare(right.alertId));
  const representative = eventNotifications[0] || null;
  const distinctById = new Map(notificationDistinctInformation(eventNotifications).map((item) => [item.alertId, item.distinct]));
  const peaks = candidates.map((item) => item.peak).filter(Boolean).sort((left, right) => right.value - left.value);
  const transitions = telemetry.filter((item) => item.transition);
  const transitionSequence = transitions.map((item) => item.transition).filter((value, index, values) => index === 0 || value !== values[index - 1]);
  const flapping = candidates.some((item) => item.flapping) || (transitionSequence.filter((value) => value === 'DEGRADED').length >= 2 && transitionSequence.filter((value) => value === 'RECOVERED').length >= 2);
  const confidence = candidates.some((item) => item.confidence === 'HIGH') ? 'HIGH' : candidates.some((item) => item.confidence === 'MEDIUM') ? 'MEDIUM' : 'LOW';
  const state = !start ? 'INSUFFICIENT_EVIDENCE' : flapping ? 'FLAPPING' : recoveryAt ? (toMs(recoveryAt) - toMs(start) <= config.transientMaximumMs ? 'TRANSIENT' : 'RECOVERED') : 'ONGOING';
  const first = candidates[0];
  const eventId = `appd_evt_${hash(`${config.reconstructionVersion}|${first.identityKey}|${start || candidates.map((item) => item.alertId).join('|')}`)}`;
  const notificationTimeline = eventNotifications.map((item) => ({
    id: `notification-${item.alertId}`, timestamp: item.createdAt, type: 'OPERATIONS_NOTIFICATION',
    alertId: item.alertId, alertNumber: item.alertNumber, summary: item.title,
    provenance: { source: 'JSM Operations', alertId: item.alertId },
  }));
  const transitionTimeline = transitions.map((item) => ({
    id: item.id, timestamp: item.timestamp, type: item.transition === 'RECOVERED' ? 'RECOVERY' : 'DEGRADATION',
    summary: item.summary, provenance: item.provenance,
  }));
  const peak = peaks[0] || null;
  const timeline = [...transitionTimeline, ...notificationTimeline,
    ...(peak ? [{ id: `peak-${peak.recordId}`, timestamp: peak.timestamp, type: 'PEAK', summary: `${peak.metric}: ${peak.value}${peak.unit || ''}`, provenance: { source: 'AppDynamics', recordId: peak.recordId } }] : [])]
    .sort((left, right) => toMs(left.timestamp) - toMs(right.timestamp) || left.id.localeCompare(right.id));
  return {
    eventId, reconstructionVersion: config.reconstructionVersion, application: first.application,
    conditionFamily: first.conditionFamily, entity: first.entity,
    state, confidence, boundary: first.boundary, startAt: start, peak, recoveryAt,
    mapping: first.mapping,
    telemetryValidation: {
      modelVersion: config.reconstructionVersion,
      expectedIntent: first.telemetryValidation.expectedIntent,
      status: candidates.some((item) => item.telemetryValidation.status === 'MATCHED') ? 'MATCHED'
        : candidates.some((item) => item.telemetryValidation.status === 'MISMATCHED') ? 'MISMATCHED' : 'UNKNOWN',
      evidenceLevel: candidates.some((item) => item.telemetryValidation.evidenceLevel === 'DIRECT') ? 'DIRECT'
        : candidates.some((item) => item.telemetryValidation.evidenceLevel === 'INDIRECT') ? 'INDIRECT' : 'INSUFFICIENT',
      totalRecords: candidates.reduce((sum, item) => sum + item.telemetryValidation.totalRecords, 0),
      matchedRecords: candidates.reduce((sum, item) => sum + item.telemetryValidation.matchedRecords, 0),
      mismatchedRecords: candidates.reduce((sum, item) => sum + item.telemetryValidation.mismatchedRecords, 0),
      unknownRecords: candidates.reduce((sum, item) => sum + item.telemetryValidation.unknownRecords, 0),
      validMetricRecords: candidates.reduce((sum, item) => sum + item.telemetryValidation.validMetricRecords, 0),
      invalidMetricRecords: candidates.reduce((sum, item) => sum + item.telemetryValidation.invalidMetricRecords, 0),
      metricStreams: candidates.flatMap((item) => item.telemetryValidation.metricStreams),
    },
    sourceNonActionable: candidates.every((item) => item.sourceNonActionable),
    durationMs: start && recoveryAt ? Math.max(0, toMs(recoveryAt) - toMs(start)) : null,
    ongoing: state === 'ONGOING', flapping, transitionCount: transitionSequence.length,
    notificationCount: eventNotifications.length,
    representativeAlertId: representative?.alertId || null,
    notificationIds: eventNotifications.map((item) => item.alertId),
    notifications: eventNotifications.map((item) => ({
      alertId: item.alertId, alertNumber: item.alertNumber, createdAt: item.createdAt, title: item.title,
      priority: item.priority, severity: item.severity,
      representative: item.alertId === representative?.alertId,
      distinctInformation: distinctById.get(item.alertId) || [],
    })),
    telemetry: telemetry.slice(-config.maxTimelinePoints).map((item) => ({
      id: item.id, timestamp: item.timestamp, type: item.type, metric: item.metric, metricPath: item.metricPath, value: item.value,
      unit: item.unit, aggregation: item.aggregation, rollup: item.rollup, transition: item.transition,
      semantic: item.semantic, summary: item.summary, provenance: item.provenance,
    })),
    timeline,
    provenance: { source: 'AppDynamics', evidencePackageAlertIds: candidates.map((item) => item.alertId), recordIds: telemetry.map((item) => item.id) },
    evidenceReasons: unique([
      start ? `Event start is based on ${first.boundary.toLowerCase().replaceAll('_', ' ')}.` : 'Degradation boundary is unknown.',
      recoveryAt ? 'Recovery is supported by an explicit AppDynamics recovery transition.' : 'No explicit AppDynamics recovery transition was found.',
      first.telemetryValidation.status === 'MATCHED'
        ? `${first.telemetryValidation.expectedIntent} evidence was validated against the actual AppDynamics metric/event stream.`
        : first.telemetryValidation.status === 'MISMATCHED'
          ? 'Available telemetry did not match the alert condition and was excluded from reconstruction.'
          : 'Telemetry semantics were insufficient to prove the requested alert condition.',
      flapping ? `${transitionSequence.length} alternating degradation/recovery transitions were observed.` : null,
    ]),
  };
}

function reconstructEvents(records, notifications, config = NOISE_APPDYNAMICS_EVENT_RECONSTRUCTION_CONFIG) {
  const notificationIds = new Set(notifications.filter((item) => item.source === 'AppDynamics').map((item) => String(item.alertId)));
  const candidates = records.filter((record) => notificationIds.has(String(record.alertId)) && record?.sources?.appDynamics?.applicable)
    .map(buildCandidate).sort((left, right) => toMs(left.eventStart || left.queryWindow.from) - toMs(right.eventStart || right.queryWindow.from));
  const groups = [];
  const byIdentity = new Map();
  candidates.forEach((candidate) => {
    const identityGroups = byIdentity.get(candidate.identityKey) || [];
    const previous = identityGroups.at(-1);
    if (previous && canMerge(previous.at(-1), candidate, config)) previous.push(candidate);
    else { const group = [candidate]; identityGroups.push(group); groups.push(group); }
    byIdentity.set(candidate.identityKey, identityGroups);
  });
  return groups.map((group) => mergeCandidateGroup(group, notifications, config));
}

function reviewBreakdown(notifications, events, records) {
  const eventByNotification = new Map(events.flatMap((event) => event.notificationIds.map((id) => [String(id), event])));
  const recordById = new Map(records.map((record) => [String(record.alertId), record]));
  const counts = {
    NO_ACCEPTED_MAPPING: 0, CANDIDATE_ONLY_MAPPING: 0, MAPPING_CONFLICT: 0,
    INVALID_METRIC_EVIDENCE: 0, NO_TELEMETRY: 0, TELEMETRY_BOUNDARY_UNKNOWN: 0,
    ONGOING_EVENT_WITHOUT_SUFFICIENT_EVIDENCE: 0, INSUFFICIENT_EVENT_RECONSTRUCTION: 0, OTHER: 0,
  };
  const reviewNotifications = notifications.filter((item) => item.source === 'AppDynamics'
    && (item.operationalSignalClassification === 'NEEDS_REVIEW' || item.actionability === 'NEEDS_REVIEW'));
  reviewNotifications.forEach((item) => {
    const record = recordById.get(String(item.alertId));
    const event = eventByNotification.get(String(item.alertId));
    if (item.signals?.conflict) counts.MAPPING_CONFLICT += 1;
    else if (!item.acceptedIdentity && item.signals?.candidateOnly) counts.CANDIDATE_ONLY_MAPPING += 1;
    else if (!item.acceptedIdentity) counts.NO_ACCEPTED_MAPPING += 1;
    else if (!record) counts.NO_TELEMETRY += 1;
    else if (event?.boundary === 'EVIDENCE_INVALID_METRIC' || event?.telemetryValidation?.status === 'MISMATCHED') counts.INVALID_METRIC_EVIDENCE += 1;
    else if (!event || event.telemetryValidation?.totalRecords === 0) counts.NO_TELEMETRY += 1;
    else if (event.boundary === 'DEGRADATION_BOUNDARY_UNKNOWN') counts.TELEMETRY_BOUNDARY_UNKNOWN += 1;
    else if (event.state === 'ONGOING') counts.ONGOING_EVENT_WITHOUT_SUFFICIENT_EVIDENCE += 1;
    else if (event.state === 'INSUFFICIENT_EVIDENCE' || event.confidence === 'LOW') counts.INSUFFICIENT_EVENT_RECONSTRUCTION += 1;
    else counts.OTHER += 1;
  });
  const labels = {
    NO_ACCEPTED_MAPPING: 'No accepted mapping', CANDIDATE_ONLY_MAPPING: 'Candidate-only mapping',
    MAPPING_CONFLICT: 'Mapping conflict', INVALID_METRIC_EVIDENCE: 'Invalid metric evidence',
    NO_TELEMETRY: 'No telemetry', TELEMETRY_BOUNDARY_UNKNOWN: 'Telemetry boundary unknown',
    ONGOING_EVENT_WITHOUT_SUFFICIENT_EVIDENCE: 'Ongoing event without sufficient evidence',
    INSUFFICIENT_EVENT_RECONSTRUCTION: 'Insufficient event reconstruction', OTHER: 'Other',
  };
  const rows = Object.entries(counts).map(([code, count]) => ({ code, reason: labels[code], count }));
  return { total: rows.reduce((sum, item) => sum + item.count, 0), rows, reconciliation: rows.reduce((sum, item) => sum + item.count, 0) === reviewNotifications.length };
}

function summarizeReconstruction(events, notifications, records, startedAt, now, config) {
  const confirmed = events.filter((item) => item.state !== 'INSUFFICIENT_EVIDENCE' && ['HIGH', 'MEDIUM'].includes(item.confidence)
    && item.mapping?.accepted === true && item.telemetryValidation?.status === 'MATCHED'
    && item.telemetryValidation?.evidenceLevel === 'DIRECT');
  const ids = new Set(confirmed.flatMap((item) => item.notificationIds));
  const useful = confirmed.length + confirmed.reduce((sum, item) => sum + item.notifications.filter((entry) => entry.distinctInformation.some((value) => value !== 'REPRESENTATIVE_SIGNAL')).length, 0);
  const notificationCount = confirmed.reduce((sum, item) => sum + item.notificationCount, 0);
  return {
    phase: '4.4A.2', range: RANGE, reconstructionVersion: config.reconstructionVersion,
    computedAt: new Date(now()).toISOString(),
    summary: {
      confirmedEvents: confirmed.length,
      notifications: notificationCount,
      usefulSignals: Math.min(notificationCount, useful),
      redundantNotifications: Math.max(0, notificationCount - Math.min(notificationCount, useful)),
      nonActionableEvents: confirmed.filter((item) => item.state === 'TRANSIENT' && item.sourceNonActionable === true).length,
      needsReviewEvents: events.filter((item) => item.state === 'INSUFFICIENT_EVIDENCE' || item.confidence === 'LOW').length,
      averageNotificationsPerEvent: confirmed.length ? Number((notificationCount / confirmed.length).toFixed(2)) : 0,
      notificationCoverage: ids.size,
      metricValidation: {
        matchedEvents: events.filter((item) => item.telemetryValidation?.status === 'MATCHED').length,
        mismatchedEvents: events.filter((item) => item.telemetryValidation?.status === 'MISMATCHED').length,
        unknownEvents: events.filter((item) => item.telemetryValidation?.status === 'UNKNOWN').length,
        validMetricRecords: events.reduce((sum, item) => sum + Number(item.telemetryValidation?.validMetricRecords || 0), 0),
        invalidMetricRecords: events.reduce((sum, item) => sum + Number(item.telemetryValidation?.invalidMetricRecords || 0), 0),
      },
    },
    events: events.sort((left, right) => right.notificationCount - left.notificationCount || toMs(right.startAt) - toMs(left.startAt)),
    reviewBreakdown: reviewBreakdown(notifications, events, records),
    performance: { evidencePackagesReused: records.length, additionalSourceCalls: 0, recordsProcessed: events.reduce((sum, item) => sum + item.provenance.recordIds.length, 0), executionTimeMs: Math.max(0, now() - startedAt), cacheHits: 0 },
    readOnly: true, externalMutations: 'none', aiUsed: false, automaticSuppression: 'none', automaticTuning: 'none',
  };
}

function safeSnapshot(snapshot) {
  return JSON.parse(JSON.stringify(snapshot, (key, value) => (/token|secret|password|credential|authorization|cookie|raw/i.test(key) ? '[REDACTED]' : value)));
}

function createStore({ database = db, config = NOISE_APPDYNAMICS_EVENT_RECONSTRUCTION_CONFIG } = {}) {
  let readyPromise = null;
  const ensure = () => {
    if (!readyPromise) readyPromise = database.query(`
      CREATE TABLE IF NOT EXISTS appdynamics_event_reconstruction_snapshots (
        analysis_range TEXT NOT NULL, reconstruction_version TEXT NOT NULL, analysis_version TEXT NOT NULL,
        snapshot_json JSONB NOT NULL, computed_at TIMESTAMPTZ NOT NULL, expires_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (analysis_range, reconstruction_version, analysis_version)
      )
    `).catch((error) => { readyPromise = null; throw error; });
    return readyPromise;
  };
  return {
    async load(analysisVersion) {
      await ensure();
      const result = await database.query(`SELECT snapshot_json FROM appdynamics_event_reconstruction_snapshots
        WHERE analysis_range=$1 AND reconstruction_version=$2 AND analysis_version=$3 AND expires_at > NOW() LIMIT 1`,
      [RANGE, config.reconstructionVersion, analysisVersion]);
      return result.rows[0]?.snapshot_json || null;
    },
    async save(snapshot) {
      await ensure();
      const expiresAt = new Date(toMs(snapshot.computedAt) + config.cacheTtlMs).toISOString();
      await database.query(`INSERT INTO appdynamics_event_reconstruction_snapshots
        (analysis_range,reconstruction_version,analysis_version,snapshot_json,computed_at,expires_at)
        VALUES ($1,$2,$3,$4::jsonb,$5,$6)
        ON CONFLICT (analysis_range,reconstruction_version,analysis_version) DO UPDATE SET
        snapshot_json=EXCLUDED.snapshot_json,computed_at=EXCLUDED.computed_at,expires_at=EXCLUDED.expires_at`,
      [RANGE, config.reconstructionVersion, snapshot.reconstructionInputVersion || snapshot.analysisVersion, JSON.stringify(safeSnapshot(snapshot)), snapshot.computedAt, expiresAt]);
    },
  };
}

function createNoiseAppDynamicsEventReconstructionService({
  enrichment = enrichmentService,
  config = NOISE_APPDYNAMICS_EVENT_RECONSTRUCTION_CONFIG,
  store = null,
  now = () => Date.now(),
} = {}) {
  const persistence = store || createStore({ config });
  const memory = new Map();

  async function reconstruct({ snapshot, notifications, refresh = false } = {}) {
    const analysisVersion = cleanText(snapshot?.analysisVersion) || 'unknown-analysis';
    const status = await enrichment.prepareStatus({ range: RANGE });
    const currentIds = new Set((notifications || []).map((item) => String(item.alertId)));
    const notificationById = new Map((notifications || []).map((item) => [String(item.alertId), item]));
    const records = (status.records || []).filter((item) => currentIds.has(String(item.alertId)) && item?.sources?.appDynamics?.applicable)
      .map((item) => {
        const currentMapping = notificationById.get(String(item.alertId))?.sourceMapping || { level: 'NONE', accepted: false };
        return { ...item, sourceMapping: currentMapping };
      });
    const reconstructionInputVersion = `${analysisVersion}:condition-identity-v2:${hash(records.map((item) => `${item.alertId}|${item.collectedAt || ''}|${item.sourceMapping?.level || 'NONE'}|${queriesFor(item).reduce((sum, query) => sum + Number(query.normalizedRecordCount || query.rawRecordCount || 0), 0)}`).sort().join('|'))}`;
    if (!refresh) {
      const cached = memory.get(reconstructionInputVersion);
      if (cached && now() - toMs(cached.computedAt) < config.cacheTtlMs) return { ...cached, cache: { hit: true, source: 'MEMORY' }, performance: { ...cached.performance, cacheHits: Number(cached.performance.cacheHits || 0) + 1 } };
      try {
        const persisted = await persistence.load(reconstructionInputVersion);
        if (persisted?.reconstructionVersion === config.reconstructionVersion) {
          memory.set(reconstructionInputVersion, persisted);
          return { ...persisted, cache: { hit: true, source: 'PERSISTED' }, performance: { ...persisted.performance, cacheHits: Number(persisted.performance?.cacheHits || 0) + 1 } };
        }
      } catch { /* Persistence is advisory. */ }
    }
    const startedAt = now();
    const events = reconstructEvents(records, notifications || [], config);
    const result = { ...summarizeReconstruction(events, notifications || [], records, startedAt, now, config), analysisVersion, reconstructionInputVersion, cache: { hit: false, source: 'COMPUTED' } };
    memory.set(reconstructionInputVersion, result);
    try { await persistence.save(result); result.persistence = 'SAVED'; } catch { result.persistence = 'UNAVAILABLE'; }
    return result;
  }

  function invalidate() { memory.clear(); }

  return { invalidate, reconstruct };
}

module.exports = {
  CONDITION_FAMILIES,
  buildCandidate,
  canMerge,
  conditionFamily,
  createNoiseAppDynamicsEventReconstructionService,
  eventTransition,
  normalizeRecord,
  reconstructEvents,
  service: createNoiseAppDynamicsEventReconstructionService(),
  telemetryFor,
};
