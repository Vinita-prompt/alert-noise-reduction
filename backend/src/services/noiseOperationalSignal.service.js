const crypto = require('node:crypto');
const db = require('../config/db');
const { NOISE_OPERATIONAL_SIGNAL_CONFIG } = require('../config/noiseOperationalSignal');
const { service: actionabilityService } = require('./noiseActionability.service');
const { service: enrichmentService } = require('./noiseEvidenceEnrichment.service');
const { service: evidenceAcquisitionService } = require('./noiseEvidenceAcquisition.service');
const { service: appDynamicsEventReconstructionService } = require('./noiseAppDynamicsEventReconstruction.service');

const CLASSIFICATIONS = Object.freeze([
  'USEFUL_ACTIONABLE_SIGNAL',
  'REDUNDANT_REAL_EVENT_NOTIFICATION',
  'NON_ACTIONABLE_NOISE',
  'NEEDS_REVIEW',
]);
const ACCEPTED_MAPPINGS = new Set(['EXACT', 'STRONG', 'CONFIRMED_LOCAL']);
const SOURCE_NAMES = Object.freeze({ appd: 'AppDynamics', appdynamics: 'AppDynamics', grafana: 'Grafana', nagios: 'Nagios', thousandeyes: 'ThousandEyes' });

function cleanText(value) {
  return String(value ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function canonical(value) {
  return cleanText(value).toLowerCase();
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
  const parsed = toMs(value);
  return parsed === null ? null : new Date(parsed).toISOString();
}

function hash(value, length = 24) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, length);
}

function parseRange(value) {
  // Phase 4.3 deliberately fixes the operator-facing evaluation denominator to
  // the current 24-hour Operations snapshot. Historical source evidence may
  // still span wider windows inside the shared evidence adapters.
  void value;
  return '24h';
}

function percentage(value, total) {
  return total ? Number((Number(value || 0) / Number(total) * 100).toFixed(1)) : 0;
}

function normalizeSource(value) {
  const raw = cleanText(value) || 'Unknown';
  const key = canonical(raw).replace(/[^a-z]/g, '');
  return Object.entries(SOURCE_NAMES).find(([alias]) => key.includes(alias))?.[1] || raw;
}

function alertId(alert) {
  return cleanText(alert?.id || alert?.canonicalOperationsId || alert?.externalId);
}

function alertNumber(alert) {
  return cleanText(alert?.tinyId || alert?.alertNumber) || null;
}

function priorityRank(value) {
  const normalized = canonical(value);
  if (/p1|critical|sev[ -]?1/.test(normalized)) return 4;
  if (/p2|high|sev[ -]?2/.test(normalized)) return 3;
  if (/p3|medium|warning|sev[ -]?3/.test(normalized)) return 2;
  if (/p4|low|info/.test(normalized)) return 1;
  return 0;
}

function severityFor(alert) {
  return cleanText(alert?.monitoringSeverity || alert?.severity || alert?.priority) || null;
}

function structuredValue(alert, names) {
  const containers = [alert, alert?.details, alert?.sourceDetails, alert?.metadata, alert?.raw?.details, alert?.raw?.metadata].filter(Boolean);
  for (const container of containers) {
    for (const name of names) {
      const value = container?.[name];
      if (typeof value === 'string' || typeof value === 'number') {
        const cleaned = cleanText(value);
        if (cleaned) return cleaned;
      }
    }
  }
  return null;
}

function evidenceSignals(occurrence) {
  const evidence = occurrence?.evidence || {};
  const monitoring = Array.isArray(evidence.monitoring) ? evidence.monitoring : [];
  const coverage = occurrence?.coverage || evidence.coverage || {};
  const reasons = unique(occurrence?.reasons || occurrence?.classificationReasons || []);
  const slackEvidence = Array.isArray(evidence.slack?.evidence) ? evidence.slack.evidence : [];
  return {
    acceptedIdentity: evidence.identity?.accepted === true || ACCEPTED_MAPPINGS.has(String(occurrence?.enrichment?.sourceMapping?.level || '').toUpperCase()),
    candidateOnly: evidence.identity?.candidateOnly === true,
    conflict: evidence.identity?.conflicts === true,
    identityUnavailable: evidence.identity?.unavailable === true,
    jiraIncident: evidence.jira?.confirmedIncident === true,
    jiraProblem: evidence.jira?.confirmedProblem === true,
    jiraInspected: Number(coverage.jira?.inspected || 0) > 0,
    jiraKeys: unique((evidence.jira?.evidence || []).map((item) => item.metadata?.issueKey || item.issueKey || item.id).filter((value) => /^[A-Z][A-Z0-9]+-\d+$/.test(String(value || '')))),
    lifecycleHumanAction: evidence.lifecycle?.humanAction === true,
    monitoringActionable: monitoring.some((item) => item.actionable),
    monitoringRecovered: monitoring.some((item) => item.recovered || item.nonActionable),
    monitoringSources: unique(monitoring.filter((item) => item.evidence?.length).map((item) => item.source)),
    operatorAction: evidence.lifecycle?.humanAction === true || evidence.slack?.concreteAction === true,
    acknowledgementOnly: evidence.lifecycle?.acknowledged === true && evidence.lifecycle?.humanAction !== true && evidence.slack?.concreteAction !== true,
    slackAcknowledgementOnly: evidence.slack?.operatorActivity === true && evidence.slack?.concreteAction !== true,
    slackConcreteAction: evidence.slack?.concreteAction === true,
    slackContext: slackEvidence.length > 0 || evidence.slack?.operatorActivity === true,
    slackInspected: Number(coverage.slack?.inspected || 0) > 0,
    sourceRecords: monitoring.reduce((sum, item) => sum + Number(item.evidence?.length || 0), 0),
    sourceTelemetryInspected: Number(coverage.sourceTelemetry?.inspected || 0) > 0
      || (occurrence?.evidenceState && occurrence.evidenceState !== 'NOT_ENRICHED'),
    sourceTimeout: reasons.some((reason) => /timeout|timed out/i.test(reason)),
  };
}

function eventWindow(alert, occurrence, config = NOISE_OPERATIONAL_SIGNAL_CONFIG) {
  const created = toMs(alert?.createdAt || alert?.firstOccurredAt) || 0;
  const closed = toMs(alert?.closeTime || alert?.closedAt || alert?.resolvedAt);
  const persisted = occurrence?.enrichment?.investigationWindow;
  const from = toMs(persisted?.from) ?? created - config.beforeMinutes * 60 * 1000;
  const naturalTo = closed && closed >= created ? closed : created;
  const to = toMs(persisted?.to) ?? naturalTo + config.afterMinutes * 60 * 1000;
  return { from: Math.max(0, from), to: Math.max(from, Math.min(to, created + config.maxEventDurationMs)) };
}

function primaryContext(alert, occurrence, patternResults) {
  const id = alertId(alert);
  const fingerprintHash = alert?.fingerprintData?.fingerprintHash;
  const candidates = patternResults.filter(({ group }) => (group.alerts || []).some((item) => alertId(item) === id));
  const chosen = [...candidates].sort((left, right) => {
    const leftExact = fingerprintHash && left.group.fingerprintHash === fingerprintHash ? 1 : 0;
    const rightExact = fingerprintHash && right.group.fingerprintHash === fingerprintHash ? 1 : 0;
    const leftClass = left.actionability.occurrences?.some((item) => item.canonicalOperationsId === id && item.classification === occurrence.classification) ? 1 : 0;
    const rightClass = right.actionability.occurrences?.some((item) => item.canonicalOperationsId === id && item.classification === occurrence.classification) ? 1 : 0;
    return rightExact - leftExact || rightClass - leftClass || left.group.groupId.localeCompare(right.group.groupId);
  })[0];
  return chosen?.group || null;
}

function decisionEvidenceItem(item, source, index) {
  const metadata = item?.metadata && typeof item.metadata === 'object' ? item.metadata : {};
  return {
    id: cleanText(item?.id || item?.eventId || item?.correlationKey || `${source}-${index}`),
    source: cleanText(item?.source || source),
    type: cleanText(item?.type || 'source_record'),
    timestamp: iso(item?.timestamp),
    title: cleanText(item?.title) || null,
    summary: cleanText(item?.summary) || null,
    severity: cleanText(item?.severity) || null,
    entity: cleanText(item?.entity) || null,
    correlationKey: cleanText(item?.correlationKey) || null,
    metadata: {
      agentIds: Array.isArray(metadata.agentIds) ? unique(metadata.agentIds) : [],
      alertId: cleanText(metadata.alertId) || null,
      dashboardUid: cleanText(metadata.dashboardUid) || null,
      applicationId: cleanText(metadata.applicationId) || null,
      businessTransaction: cleanText(metadata.businessTransaction || metadata.businessTransactionName) || null,
      database: cleanText(metadata.database || metadata.databaseName) || null,
      entityId: cleanText(metadata.entityId) || null,
      entityType: cleanText(metadata.entityType) || null,
      eventId: cleanText(metadata.eventId || metadata.alertId) || null,
      eventType: cleanText(metadata.eventType) || null,
      healthRule: cleanText(metadata.healthRule) || null,
      healthRuleId: cleanText(metadata.healthRuleId) || null,
      host: cleanText(metadata.host) || null,
      metric: cleanText(metadata.metric || metadata.metricName) || null,
      metricIntent: cleanText(metadata.metricIntent) || null,
      node: cleanText(metadata.node || metadata.nodeName) || null,
      panelId: cleanText(metadata.panelId) || null,
      policy: cleanText(metadata.policy || metadata.policyName) || null,
      policyId: cleanText(metadata.policyId) || null,
      ruleUid: cleanText(metadata.ruleUid) || null,
      service: cleanText(metadata.service) || null,
      state: cleanText(metadata.state || metadata.status) || null,
      testId: cleanText(metadata.testId) || null,
      tier: cleanText(metadata.tier || metadata.tierName) || null,
      thresholdViolated: metadata.thresholdViolated === true,
      violationId: cleanText(metadata.violationId) || null,
      value: Number.isFinite(Number(metadata.value)) ? Number(metadata.value) : null,
      sustained: metadata.sustained === true,
    },
  };
}

function decisionEvidenceFor(occurrence) {
  const evidence = occurrence?.evidence || {};
  const monitoring = (evidence.monitoring || []).map((item) => ({
    source: item.source,
    acceptedMapping: item.acceptedMapping === true,
    mappingQuality: item.mappingQuality || 'NONE',
    actionable: item.actionable === true,
    nonActionable: item.nonActionable === true,
    degradation: item.degradation === true,
    recovered: item.recovered === true,
    sustained: item.sustained === true,
    transient: item.transient === true,
    durationMs: Number.isFinite(item.durationMs) ? item.durationMs : null,
    outcome: item.outcome || null,
    reason: cleanText(item.reason) || null,
    records: (item.evidence || []).map((record, index) => decisionEvidenceItem(record, item.source, index)),
  }));
  return {
    monitoring,
    operations: {
      acknowledged: evidence.lifecycle?.acknowledged === true,
      closedBySystem: evidence.lifecycle?.closedBySystem === true,
      humanAction: evidence.lifecycle?.humanAction === true,
      observed: evidence.lifecycle?.observed === true,
      verifiedClosedCycle: evidence.lifecycle?.verifiedClosedCycle === true,
      cycles: Number(evidence.lifecycle?.cycles || 0),
    },
    jira: {
      confirmedIncident: evidence.jira?.confirmedIncident === true,
      confirmedProblem: evidence.jira?.confirmedProblem === true,
      records: (evidence.jira?.evidence || []).map((record, index) => decisionEvidenceItem(record, 'ACC Jira', index)),
    },
    slack: {
      concreteAction: evidence.slack?.concreteAction === true,
      operatorActivity: evidence.slack?.operatorActivity === true,
      records: (evidence.slack?.evidence || []).map((record, index) => decisionEvidenceItem(record, 'Slack', index)),
    },
    identity: {
      accepted: evidence.identity?.accepted === true,
      candidateOnly: evidence.identity?.candidateOnly === true,
      conflicts: evidence.identity?.conflicts === true,
      unavailable: evidence.identity?.unavailable === true,
    },
    state: occurrence.evidenceState || evidence.evidenceState || 'NOT_ENRICHED',
  };
}

function notificationRecord(alert, occurrence, patternResults, config = NOISE_OPERATIONAL_SIGNAL_CONFIG) {
  const context = primaryContext(alert, occurrence, patternResults);
  const signals = evidenceSignals(occurrence);
  const source = normalizeSource(alert?.source || alert?.sourceSystem || alert?.integrationName || context?.source);
  const identity = occurrence?.enrichment?.identity;
  const canonicalEntity = cleanText(identity?.canonicalName || identity?.entityId || structuredValue(alert, ['application', 'service', 'host', 'testName', 'test', 'component', 'entity'])) || null;
  const environment = cleanText(alert?.environment || structuredValue(alert, ['environment', 'tier', 'deploymentTier'])) || null;
  const component = cleanText(structuredValue(alert, ['component', 'service', 'application', 'host', 'tier', 'testName'])) || canonicalEntity;
  const site = cleanText(structuredValue(alert, ['site', 'dataCenter', 'datacenter', 'dc', 'location', 'instance'])) || null;
  const agents = unique((occurrence?.evidence?.monitoring || []).flatMap((item) => item.evidence || []).flatMap((item) => item.metadata?.agentIds || []));
  const fingerprintHash = alert?.fingerprintData?.fingerprintHash || context?.fingerprintHash || hash(`${source}|${canonicalEntity || ''}|${cleanText(alert?.title || alert?.message)}`);
  return {
    alertId: alertId(alert),
    alertNumber: alertNumber(alert),
    source,
    environment,
    canonicalEntity,
    acceptedIdentity: signals.acceptedIdentity,
    sourceMapping: occurrence?.enrichment?.sourceMapping ? {
      level: occurrence.enrichment.sourceMapping.level || 'NONE',
      sourceEntityId: occurrence.enrichment.sourceMapping.sourceEntityId || null,
      sourceEntityName: occurrence.enrichment.sourceMapping.sourceEntityName || null,
      sourceEntityType: occurrence.enrichment.sourceMapping.sourceEntityType || null,
      accepted: signals.acceptedIdentity,
    } : { level: 'NONE', accepted: false },
    component,
    site,
    agents,
    fingerprintHash,
    patternId: context?.groupId || null,
    pattern: context?.pattern || cleanText(alert?.title || alert?.message) || 'Operational alert',
    operationClusterIds: candidatesForAlert(alertId(alert), patternResults),
    createdAt: iso(alert?.createdAt || alert?.firstOccurredAt),
    closedAt: iso(alert?.closeTime || alert?.closedAt || alert?.resolvedAt),
    window: eventWindow(alert, occurrence, config),
    priority: cleanText(alert?.priority) || null,
    severity: severityFor(alert),
    status: cleanText(alert?.status) || null,
    title: cleanText(alert?.title || alert?.message || context?.pattern) || 'Operational alert',
    actionability: occurrence.classification,
    actionabilityConfidence: occurrence.confidence || 'LOW',
    actionabilityReasons: unique(occurrence.reasons || occurrence.classificationReasons || []),
    noiseLikelihood: Number(context?.noiseLikelihood ?? context?.noiseScore ?? 0),
    reviewRisk: context?.reviewRisk || { level: 'LOW', score: 0, reasons: [] },
    correlationConfidence: Number.isFinite(context?.correlationConfidence) ? context.correlationConfidence : null,
    evidenceState: occurrence.evidenceState || 'NOT_ENRICHED',
    evidenceBasis: occurrence.evidenceBasis || 'NEEDS_REVIEW',
    evidenceReclassified: occurrence?.enrichment?.reclassified === true,
    signals,
    decisionEvidence: decisionEvidenceFor(occurrence),
  };
}

function candidatesForAlert(id, patternResults) {
  return unique(patternResults.filter(({ group }) => (group.alerts || []).some((alert) => alertId(alert) === id)).map(({ group }) => group.groupId));
}

function windowsOverlap(left, right) {
  return left.from <= right.to && right.from <= left.to;
}

function sameEnvironment(left, right) {
  return !left.environment || !right.environment || canonical(left.environment) === canonical(right.environment);
}

function shares(valuesA, valuesB) {
  const right = new Set(valuesB.map(canonical));
  return valuesA.some((value) => right.has(canonical(value)));
}

function deterministicRelationship(event, notification) {
  if (!windowsOverlap(event.window, notification.window) || !sameEnvironment(event, notification)) return null;
  if (notification.signals.jiraKeys.length && shares(event.jiraKeys, notification.signals.jiraKeys)) return 'SAME_CONFIRMED_JIRA_RELATIONSHIP';
  if (notification.source === event.primarySource && notification.fingerprintHash === event.fingerprintHash
    && (!event.canonicalEntity || !notification.canonicalEntity || canonical(event.canonicalEntity) === canonical(notification.canonicalEntity))) return 'SAME_SOURCE_ENTITY_FINGERPRINT';
  if (notification.acceptedIdentity && event.acceptedIdentity && event.canonicalEntity && notification.canonicalEntity
    && canonical(event.canonicalEntity) === canonical(notification.canonicalEntity)) return 'ACCEPTED_CROSS_SOURCE_ENTITY';
  if (shares(event.operationClusterIds, notification.operationClusterIds) && notification.fingerprintHash === event.fingerprintHash) return 'SAME_OPERATIONS_CLUSTER';
  return null;
}

function createEvent(notification, range, config) {
  return {
    eventId: `evt_${hash(`${config.operationalSignalModelVersion}|${range}|${notification.alertId}`)}`,
    name: notification.canonicalEntity ? `${notification.canonicalEntity} · ${notification.pattern}` : notification.pattern,
    canonicalEntity: notification.canonicalEntity,
    acceptedIdentity: notification.acceptedIdentity,
    environment: notification.environment,
    primarySource: notification.source,
    fingerprintHash: notification.fingerprintHash,
    jiraKeys: [...notification.signals.jiraKeys],
    operationClusterIds: [...notification.operationClusterIds],
    window: { ...notification.window },
    firstSignal: notification.createdAt,
    lastSignal: notification.createdAt,
    notifications: [{ ...notification, groupingReason: 'EVENT_ANCHOR' }],
    groupingReasons: ['EVENT_ANCHOR'],
  };
}

function groupOperationalEvents(notifications, { range = '7d', config = NOISE_OPERATIONAL_SIGNAL_CONFIG } = {}) {
  const events = [];
  [...notifications].sort((left, right) => (toMs(left.createdAt) || 0) - (toMs(right.createdAt) || 0) || left.alertId.localeCompare(right.alertId)).forEach((notification) => {
    const matches = events.flatMap((event) => {
      const relationship = deterministicRelationship(event, notification);
      return relationship ? [{ event, relationship }] : [];
    }).sort((left, right) => (toMs(right.event.lastSignal) || 0) - (toMs(left.event.lastSignal) || 0));
    if (!matches.length) {
      events.push(createEvent(notification, range, config));
      return;
    }
    const { event, relationship } = matches[0];
    event.notifications.push({ ...notification, groupingReason: relationship });
    event.groupingReasons = unique([...event.groupingReasons, relationship]);
    event.firstSignal = iso(Math.min(toMs(event.firstSignal), toMs(notification.createdAt)));
    event.lastSignal = iso(Math.max(toMs(event.lastSignal), toMs(notification.createdAt)));
    event.window.from = Math.min(event.window.from, notification.window.from);
    event.window.to = Math.min(event.window.from + config.maxEventDurationMs, Math.max(event.window.to, notification.window.to));
    event.jiraKeys = unique([...event.jiraKeys, ...notification.signals.jiraKeys]);
    event.operationClusterIds = unique([...event.operationClusterIds, ...notification.operationClusterIds]);
    event.acceptedIdentity = event.acceptedIdentity || notification.acceptedIdentity;
  });
  return events;
}

function realEvidence(notification) {
  return notification.actionability === 'ACTIONABLE'
    || notification.signals.monitoringActionable
    || notification.signals.jiraIncident
    || notification.signals.jiraProblem
    || notification.signals.operatorAction;
}

function representativeScore(notification) {
  return (notification.actionability === 'ACTIONABLE' ? 100 : 0)
    + (notification.signals.monitoringActionable ? 35 : 0)
    + ((notification.signals.jiraIncident || notification.signals.jiraProblem) ? 30 : 0)
    + (notification.signals.operatorAction ? 20 : 0)
    + (notification.actionabilityConfidence === 'HIGH' ? 5 : 0);
}

function selectRepresentative(event) {
  const reconstructed = event.notifications.find((item) => item.reconstructionRepresentative === true);
  if (reconstructed) return reconstructed;
  const meaningful = event.notifications.filter(realEvidence);
  return [...(meaningful.length ? meaningful : event.notifications)].sort((left, right) => representativeScore(right) - representativeScore(left)
    || (toMs(left.createdAt) || 0) - (toMs(right.createdAt) || 0)
    || left.alertId.localeCompare(right.alertId))[0];
}

function distinctInformation(notification, prior, representative, realEvent) {
  if (notification.alertId === representative.alertId) return ['REPRESENTATIVE_SIGNAL'];
  if (!realEvent) return [];
  const result = [...(notification.reconstructionDistinctInformation || [])];
  if (notification.signals.monitoringRecovered && prior.some(realEvidence)) result.push('USEFUL_RECOVERY');
  const priorPriority = Math.max(0, ...prior.map((item) => priorityRank(item.priority || item.severity)));
  if (priorityRank(notification.priority || notification.severity) > priorPriority && priorPriority > 0) result.push('MATERIAL_ESCALATION');
  if (notification.signals.monitoringActionable && !prior.some((item) => item.source === notification.source)) result.push('NEW_SOURCE_DEGRADATION');
  if (prior.length && notification.component && !prior.some((item) => canonical(item.component) === canonical(notification.component))) result.push('NEW_AFFECTED_COMPONENT');
  if (prior.length && notification.site && !prior.some((item) => canonical(item.site) === canonical(notification.site))) result.push('NEW_AFFECTED_LOCATION');
  const previousAgents = new Set(prior.flatMap((item) => item.agents).map(canonical));
  if (prior.length && notification.agents.some((agent) => !previousAgents.has(canonical(agent)))) result.push('NEW_AFFECTED_AGENT');
  return unique(result);
}

function confidenceFor(classification, notification, event, distinct) {
  if (classification === 'NEEDS_REVIEW') return notification.signals.conflict ? 'MEDIUM' : 'LOW';
  if (classification === 'NON_ACTIONABLE_NOISE') return notification.actionabilityConfidence === 'HIGH' ? 'HIGH' : 'MEDIUM';
  if (classification === 'REDUNDANT_REAL_EVENT_NOTIFICATION') {
    return ['SAME_SOURCE_ENTITY_FINGERPRINT', 'SAME_CONFIRMED_JIRA_RELATIONSHIP'].includes(notification.groupingReason) ? 'HIGH' : 'MEDIUM';
  }
  if (notification.actionabilityConfidence === 'HIGH' || notification.signals.monitoringActionable || notification.signals.jiraIncident || notification.signals.jiraProblem) return 'HIGH';
  return distinct.length ? 'MEDIUM' : event.confidence || 'MEDIUM';
}

function classifyEvent(event, config = NOISE_OPERATIONAL_SIGNAL_CONFIG) {
  const representative = selectRepresentative(event);
  const realEvent = event.notifications.some(realEvidence);
  const contradictions = event.notifications.some((item) => item.signals.conflict);
  const sorted = [...event.notifications].sort((left, right) => (toMs(left.createdAt) || 0) - (toMs(right.createdAt) || 0) || left.alertId.localeCompare(right.alertId));
  const classified = sorted.map((notification, index) => {
    const prior = sorted.slice(0, index);
    const distinct = distinctInformation(notification, prior, representative, realEvent);
    let classification = 'NEEDS_REVIEW';
    const reasons = [];
    if (contradictions && notification.signals.conflict) {
      reasons.push('Source identity or evidence contains an unresolved deterministic conflict.');
    } else if (!realEvent) {
      if (notification.actionability === 'NON_ACTIONABLE' && ['HIGH', 'MEDIUM'].includes(notification.actionabilityConfidence)) {
        classification = 'NON_ACTIONABLE_NOISE';
        reasons.push('Existing evidence supports a non-actionable occurrence without a confirmed real operational event.');
        reasons.push(...notification.actionabilityReasons.slice(0, 3));
      } else {
        reasons.push(notification.signals.candidateOnly ? 'Source identity is Candidate-only.' : 'The underlying operational event is not confirmed by sufficient evidence.');
        if (notification.evidenceState === 'EVIDENCE_UNAVAILABLE') reasons.push('Historical source evidence is unavailable.');
      }
    } else if (distinct.length) {
      classification = 'USEFUL_ACTIONABLE_SIGNAL';
      if (distinct.includes('REPRESENTATIVE_SIGNAL')) reasons.push('This is the representative notification for a confirmed real operational event.');
      if (distinct.includes('USEFUL_RECOVERY')) reasons.push('This notification provides a source-backed recovery transition.');
      if (distinct.includes('MATERIAL_ESCALATION')) reasons.push('This notification raises the event to a materially higher operational priority.');
      if (distinct.includes('NEW_SOURCE_DEGRADATION')) reasons.push('A new monitoring source provides distinct degradation evidence.');
      if (distinct.includes('NEW_AFFECTED_COMPONENT')) reasons.push('This notification identifies a new affected component.');
      if (distinct.includes('NEW_AFFECTED_LOCATION')) reasons.push('This notification identifies a new affected location or data center.');
      if (distinct.includes('NEW_AFFECTED_AGENT')) reasons.push('This notification identifies an additional affected agent.');
      if (distinct.includes('NEW_AFFECTED_NODE')) reasons.push('This notification identifies a new affected AppDynamics node.');
      if (distinct.includes('NEW_BUSINESS_TRANSACTION')) reasons.push('This notification identifies a new affected business transaction.');
      if (distinct.includes('NEW_CONDITION')) reasons.push('This notification provides a distinct AppDynamics condition for the reconstructed event.');
    } else if (notification.alertId !== representative.alertId) {
      classification = 'REDUNDANT_REAL_EVENT_NOTIFICATION';
      reasons.push('The underlying event is supported as real, but another notification is the event representative.');
      reasons.push({
        EVENT_ANCHOR: 'A stronger evidence-backed notification was selected as the representative for this event.',
        SAME_SOURCE_ENTITY_FINGERPRINT: 'Same source, canonical entity, fingerprint, and bounded event window.',
        SAME_CONFIRMED_JIRA_RELATIONSHIP: 'The notifications share the same confirmed Jira relationship.',
        ACCEPTED_CROSS_SOURCE_ENTITY: 'Accepted cross-source identity and timing place this notification in the same real event.',
        SAME_OPERATIONS_CLUSTER: 'The notification shares the deterministic Operations cluster and fingerprint.',
        SAME_APPDYNAMICS_DEGRADATION_EPISODE: 'Persisted AppDynamics telemetry places this notification in the same degradation episode.',
      }[notification.groupingReason]);
      reasons.push('No distinct escalation, recovery, component, location, agent, or new source degradation was found.');
    } else {
      reasons.push('The event is real, but this notification lacks enough evidence for a distinct or redundant decision.');
    }
    return {
      ...notification,
      operationalSignalClassification: classification,
      operationalSignalConfidence: confidenceFor(classification, notification, event, distinct),
      reasons: unique(reasons),
      distinctInformation: distinct,
      representative: notification.alertId === representative.alertId,
      feedbackEligible: true,
      feedbackContext: {
        classification,
        confidence: confidenceFor(classification, notification, event, distinct),
        evidenceVersion: config.evidenceModelVersion,
        eventId: event.eventId,
        patternId: notification.patternId,
      },
    };
  });
  const count = (classification) => classified.filter((item) => item.operationalSignalClassification === classification).length;
  const sources = unique(classified.map((item) => item.source));
  const sourceBacked = classified.some((item) => item.signals.sourceRecords > 0 || item.signals.monitoringActionable || item.signals.monitoringRecovered);
  const crossSource = sources.length > 1;
  const eventConfidence = realEvent
    ? classified.some((item) => item.operationalSignalConfidence === 'HIGH') ? 'HIGH' : 'MEDIUM'
    : classified.every((item) => item.operationalSignalConfidence === 'HIGH') ? 'HIGH' : contradictions ? 'MEDIUM' : 'LOW';
  return {
    ...event,
    eventStatus: realEvent ? 'REAL_EVENT_CONFIRMED' : classified.every((item) => item.operationalSignalClassification === 'NON_ACTIONABLE_NOISE') ? 'NO_REAL_EVENT_CONFIRMED' : 'EVENT_UNCONFIRMED',
    confidence: eventConfidence,
    representativeAlertId: representative.alertId,
    representativeAlertNumber: representative.alertNumber,
    representativeSource: representative.source,
    representativeReason: realEvent ? 'Strongest evidence-backed notification; earliest notification wins equal-strength ties.' : 'Earliest available notification; the event remains unconfirmed.',
    notifications: classified,
    sources,
    sourceBacked,
    crossSource,
    durationMs: Math.max(0, (toMs(event.lastSignal) || 0) - (toMs(event.firstSignal) || 0)),
    summary: {
      notifications: classified.length,
      useful: count('USEFUL_ACTIONABLE_SIGNAL'),
      redundant: count('REDUNDANT_REAL_EVENT_NOTIFICATION'),
      nonActionable: count('NON_ACTIONABLE_NOISE'),
      needsReview: count('NEEDS_REVIEW'),
    },
    jira: { confirmed: classified.some((item) => item.signals.jiraIncident || item.signals.jiraProblem), keys: unique(classified.flatMap((item) => item.signals.jiraKeys)) },
    slack: { meaningfulAction: classified.some((item) => item.signals.operatorAction), acknowledgementOnly: classified.some((item) => item.signals.acknowledgementOnly) },
    timeline: buildTimeline(classified),
  };
}

function buildTimeline(notifications) {
  return notifications.flatMap((item) => [
    { timestamp: item.createdAt, type: 'NOTIFICATION_RECEIVED', alertId: item.alertId, alertNumber: item.alertNumber, source: item.source, summary: item.title },
    item.closedAt ? { timestamp: item.closedAt, type: 'NOTIFICATION_CLOSED', alertId: item.alertId, alertNumber: item.alertNumber, source: item.source, summary: item.status || 'Closed' } : null,
  ].filter(Boolean)).sort((left, right) => (toMs(left.timestamp) || 0) - (toMs(right.timestamp) || 0));
}

function aggregatePatterns(events) {
  const groups = new Map();
  events.forEach((event) => {
    event.notifications.forEach((notification) => {
      const key = notification.patternId || `unpatterned_${hash(notification.fingerprintHash, 16)}`;
      const value = groups.get(key) || {
        patternId: key, pattern: notification.pattern, source: notification.source, occurrences: 0,
        useful: 0, redundant: 0, nonActionable: 0, needsReview: 0,
        noiseLikelihood: notification.noiseLikelihood, reviewRisk: notification.reviewRisk,
        confidenceDistribution: { HIGH: 0, MEDIUM: 0, LOW: 0 },
        evidenceBasisDistribution: {}, evidenceStateDistribution: {},
        _eventIds: new Set(), _confirmedEventIds: new Set(),
      };
      value.occurrences += 1;
      value.noiseLikelihood = Math.max(value.noiseLikelihood, notification.noiseLikelihood);
      const field = {
        USEFUL_ACTIONABLE_SIGNAL: 'useful', REDUNDANT_REAL_EVENT_NOTIFICATION: 'redundant',
        NON_ACTIONABLE_NOISE: 'nonActionable', NEEDS_REVIEW: 'needsReview',
      }[notification.operationalSignalClassification];
      value[field] += 1;
      value.confidenceDistribution[notification.operationalSignalConfidence] = (value.confidenceDistribution[notification.operationalSignalConfidence] || 0) + 1;
      value.evidenceBasisDistribution[notification.evidenceBasis] = (value.evidenceBasisDistribution[notification.evidenceBasis] || 0) + 1;
      value.evidenceStateDistribution[notification.evidenceState] = (value.evidenceStateDistribution[notification.evidenceState] || 0) + 1;
      value._eventIds.add(event.eventId);
      if (event.eventStatus === 'REAL_EVENT_CONFIRMED') value._confirmedEventIds.add(event.eventId);
      groups.set(key, value);
    });
  });
  return [...groups.values()].map((item) => {
    const populated = ['useful', 'redundant', 'nonActionable', 'needsReview'].filter((key) => item[key] > 0);
    const evidenceStates = Object.keys(item.evidenceStateDistribution);
    const { _eventIds, _confirmedEventIds, ...safeItem } = item;
    return {
      ...safeItem,
      confirmedEvents: _confirmedEventIds.size,
      eventGroups: _eventIds.size,
      confidence: item.needsReview === item.occurrences ? 'LOW'
        : item.confidenceDistribution.LOW > 0 || item.needsReview > 0 ? 'MEDIUM'
          : item.confidenceDistribution.MEDIUM > 0 ? 'MEDIUM' : 'HIGH',
      evidenceBasis: Object.keys(item.evidenceBasisDistribution).length === 1
        ? Object.keys(item.evidenceBasisDistribution)[0]
        : 'MIXED_EVIDENCE',
      evidenceState: evidenceStates.length === 1 ? evidenceStates[0] : 'MIXED',
      classification: populated.length > 1 ? 'MIXED' : populated[0]?.replace('nonActionable', 'NON_ACTIONABLE_NOISE').replace('useful', 'USEFUL_ACTIONABLE_SIGNAL').replace('redundant', 'REDUNDANT_REAL_EVENT_NOTIFICATION').replace('needsReview', 'NEEDS_REVIEW')?.toUpperCase() || 'NEEDS_REVIEW',
      recommendation: item.redundant > 0 ? 'Consolidate repeated notifications while retaining the representative signal.'
        : item.needsReview > 0 ? 'Investigate missing source evidence before tuning.'
          : item.nonActionable > 0 ? 'Potential non-actionable candidate; requires safety review.'
            : 'Alert appears actionable; do not suppress.',
    };
  }).sort((left, right) => right.redundant - left.redundant || right.nonActionable - left.nonActionable || right.occurrences - left.occurrences || left.pattern.localeCompare(right.pattern));
}

function summarize(events, expectedTotal = null) {
  const notifications = events.flatMap((event) => event.notifications);
  const count = (classification) => notifications.filter((item) => item.operationalSignalClassification === classification).length;
  const useful = count('USEFUL_ACTIONABLE_SIGNAL');
  const redundant = count('REDUNDANT_REAL_EVENT_NOTIFICATION');
  const nonActionable = count('NON_ACTIONABLE_NOISE');
  const needsReview = count('NEEDS_REVIEW');
  const classified = useful + redundant + nonActionable;
  const denominator = Number.isFinite(expectedTotal) ? Number(expectedTotal) : notifications.length;
  const realEvents = events.filter((event) => event.eventStatus === 'REAL_EVENT_CONFIRMED');
  const realEventNotifications = realEvents.reduce((sum, event) => sum + event.notifications.length, 0);
  return {
    totalAlerts: denominator,
    notificationsClassified: notifications.length,
    usefulActionableSignals: useful,
    redundantRealEventNotifications: redundant,
    nonActionableNoise: nonActionable,
    needsReview,
    classified,
    classificationCoverage: percentage(classified, denominator),
    unresolvedRate: percentage(needsReview, denominator),
    reconciliation: useful + redundant + nonActionable + needsReview === denominator,
    underlyingOperationalEvents: realEvents.length,
    notificationsInRealEvents: realEventNotifications,
    averageNotificationsPerEvent: realEvents.length ? Number((realEventNotifications / realEvents.length).toFixed(2)) : 0,
    realEventsWithRedundantNotifications: realEvents.filter((event) => event.summary.redundant > 0).length,
    potentiallyConsolidatableNotifications: redundant,
    highConfidenceNonActionable: notifications.filter((item) => item.operationalSignalClassification === 'NON_ACTIONABLE_NOISE' && item.operationalSignalConfidence === 'HIGH').length,
    highConfidenceRedundant: notifications.filter((item) => item.operationalSignalClassification === 'REDUNDANT_REAL_EVENT_NOTIFICATION' && item.operationalSignalConfidence === 'HIGH').length,
    highNoiseButActionable: notifications.filter((item) => ['USEFUL_ACTIONABLE_SIGNAL', 'REDUNDANT_REAL_EVENT_NOTIFICATION'].includes(item.operationalSignalClassification) && item.actionability === 'ACTIONABLE' && item.noiseLikelihood >= 60).length,
    sourceBackedEventGroups: events.filter((event) => event.sourceBacked).length,
    crossSourceEventGroups: events.filter((event) => event.crossSource).length,
    percentages: {
      useful: percentage(useful, denominator), redundant: percentage(redundant, denominator),
      nonActionable: percentage(nonActionable, denominator), needsReview: percentage(needsReview, denominator),
    },
  };
}

const MONITORING_SOURCES = Object.freeze(['AppDynamics', 'Grafana', 'Nagios', 'ThousandEyes']);

function reviewReasonFor(notification) {
  const reasons = canonical(notification.actionabilityReasons.join(' '));
  if (notification.signals.conflict) return 'Mapping conflict';
  if (/contradict|both degradation and recovery|conflicting/.test(reasons)) return 'Contradictory evidence';
  if (!notification.source || canonical(notification.source) === 'unknown') return 'Unknown source';
  if (!MONITORING_SOURCES.includes(notification.source)) return 'Unsupported source';
  if (notification.signals.candidateOnly) return 'No accepted source mapping';
  if (notification.signals.identityUnavailable || !notification.canonicalEntity) return 'Identity missing';
  if (notification.signals.sourceTimeout) return 'Source timeout';
  if (!notification.acceptedIdentity) return 'No accepted source mapping';
  if (notification.evidenceState === 'NOT_ENRICHED' || !notification.signals.sourceTelemetryInspected) return 'Source telemetry not queried';
  if (/outside.{0,24}(occurrence|investigation|correlation).{0,12}window/.test(reasons)) return 'Telemetry outside occurrence window';
  if (notification.signals.sourceRecords === 0) return 'No telemetry returned';
  if (!notification.signals.jiraInspected) return 'Jira relationship unavailable';
  if (!notification.signals.slackInspected && !notification.signals.slackContext) return 'Slack context unavailable';
  return 'Operations lifecycle insufficient';
}

const REVIEW_ACTIONS = Object.freeze({
  'Contradictory evidence': ['LOW', 'Reconcile the conflicting source and lifecycle evidence before changing any rule.'],
  'Identity missing': ['MEDIUM', 'Add a deterministic source identity mapping for the affected entity.'],
  'Jira relationship unavailable': ['MEDIUM', 'Inspect Jira relationships; absence alone must not be treated as non-actionable.'],
  'Mapping conflict': ['LOW', 'Resolve the deterministic mapping conflict before querying or tuning.'],
  'No accepted source mapping': ['HIGH', 'Confirm a deterministic mapping, then use the existing shared source adapter.'],
  'No telemetry returned': ['MEDIUM', 'Validate the accepted identity and bounded occurrence window in the shared adapter.'],
  'Operations lifecycle insufficient': ['LOW', 'Collect a meaningful lifecycle transition or operator action before classifying.'],
  'Slack context unavailable': ['MEDIUM', 'Inspect exact-alert Slack context; acknowledgement alone is not sufficient evidence.'],
  'Source telemetry not queried': ['HIGH', 'Query accepted mappings using the existing shared source adapter.'],
  'Source timeout': ['MEDIUM', 'Retry through the resumable bounded queue; keep the occurrence unresolved on timeout.'],
  'Telemetry outside occurrence window': ['MEDIUM', 'Review the bounded correlation window without adding historical alerts to the denominator.'],
  'Unknown source': ['LOW', 'Identify the source system before attempting deterministic evidence collection.'],
  'Unsupported source': ['LOW', 'Add a read-only shared source adapter before using source telemetry as evidence.'],
  Other: ['LOW', 'Review the preserved evidence package and record a deterministic resolution path.'],
});

function needsReviewBreakdown(events) {
  const review = events.flatMap((event) => event.notifications).filter((item) => item.operationalSignalClassification === 'NEEDS_REVIEW');
  const groups = new Map();
  review.forEach((notification) => {
    const reason = reviewReasonFor(notification) || 'Other';
    const source = notification.source || 'Unknown';
    const key = `${reason}|${source}`;
    const current = groups.get(key) || { reason, source, count: 0 };
    current.count += 1;
    groups.set(key, current);
  });
  return [...groups.values()].map((item) => ({
    ...item,
    percentage: percentage(item.count, review.length),
    resolutionPotential: (REVIEW_ACTIONS[item.reason] || REVIEW_ACTIONS.Other)[0],
    nextAction: (REVIEW_ACTIONS[item.reason] || REVIEW_ACTIONS.Other)[1],
  })).sort((left, right) => right.count - left.count || left.reason.localeCompare(right.reason) || left.source.localeCompare(right.source));
}

function sourceEvidenceCoverage(events) {
  const notifications = events.flatMap((event) => event.notifications);
  const monitoring = MONITORING_SOURCES.map((source) => {
    const items = notifications.filter((item) => item.source === source);
    return {
      source,
      alerts: items.length,
      acceptedMappings: items.filter((item) => item.acceptedIdentity).length,
      telemetryQueried: items.filter((item) => item.signals.sourceTelemetryInspected).length,
      telemetryReturned: items.filter((item) => item.signals.sourceRecords > 0).length,
      sufficientEvidence: items.filter((item) => item.operationalSignalClassification !== 'NEEDS_REVIEW' && ['SOURCE_ENRICHED', 'MIXED_EVIDENCE'].includes(item.evidenceBasis)).length,
      classificationChanges: items.filter((item) => item.evidenceReclassified).length,
    };
  });
  return {
    monitoring,
    jira: {
      inspected: notifications.filter((item) => item.signals.jiraInspected).length,
      relationshipsFound: notifications.filter((item) => item.signals.jiraIncident || item.signals.jiraProblem).length,
    },
    slack: {
      inspected: notifications.filter((item) => item.signals.slackInspected).length,
      contextFound: notifications.filter((item) => item.signals.slackContext).length,
      meaningfulHumanActions: notifications.filter((item) => item.signals.slackConcreteAction).length,
      acknowledgementOnlyRecords: notifications.filter((item) => item.signals.slackAcknowledgementOnly).length,
    },
  };
}

function sourceSummary(events) {
  const notifications = events.flatMap((event) => event.notifications);
  const sources = unique(notifications.map((item) => item.source));
  const rows = sources.map((source) => {
    const items = notifications.filter((item) => item.source === source);
    const count = (classification) => items.filter((item) => item.operationalSignalClassification === classification).length;
    return { source, notifications: items.length, useful: count('USEFUL_ACTIONABLE_SIGNAL'), redundant: count('REDUNDANT_REAL_EVENT_NOTIFICATION'), nonActionable: count('NON_ACTIONABLE_NOISE'), needsReview: count('NEEDS_REVIEW'), realEvents: events.filter((event) => event.eventStatus === 'REAL_EVENT_CONFIRMED' && event.sources.includes(source)).length };
  });
  rows.push({ source: 'Jira', confirmedRelationships: events.filter((event) => event.jira.confirmed).length });
  rows.push({ source: 'Slack', meaningfulActions: events.filter((event) => event.slack.meaningfulAction).length, acknowledgementOnly: events.filter((event) => event.slack.acknowledgementOnly && !event.slack.meaningfulAction).length });
  return rows;
}

function finalizeAppDynamicsReconstruction(snapshot, events) {
  if (!snapshot) return null;
  const descriptors = snapshot.events || [];
  const descriptorByNotification = new Map(descriptors.flatMap((event) => (event.notificationIds || []).map((id) => [String(id), event])));
  const notifications = events.flatMap((event) => event.notifications || []).filter((item) => item.source === 'AppDynamics');
  const confirmed = descriptors.filter((item) => item.state !== 'INSUFFICIENT_EVIDENCE' && ['HIGH', 'MEDIUM'].includes(item.confidence)
    && item.mapping?.accepted === true && item.telemetryValidation?.status === 'MATCHED'
    && item.telemetryValidation?.evidenceLevel === 'DIRECT');
  const confirmedIds = new Set(confirmed.flatMap((item) => item.notificationIds || []).map(String));
  const confirmedNotifications = notifications.filter((item) => confirmedIds.has(String(item.alertId)));
  const count = (classification) => notifications.filter((item) => item.operationalSignalClassification === classification).length;
  const reviewRows = {
    NO_ACCEPTED_MAPPING: 0, CANDIDATE_ONLY_MAPPING: 0, MAPPING_CONFLICT: 0,
    INVALID_METRIC_EVIDENCE: 0, NO_TELEMETRY: 0, TELEMETRY_BOUNDARY_UNKNOWN: 0,
    ONGOING_EVENT_WITHOUT_SUFFICIENT_EVIDENCE: 0, INSUFFICIENT_EVENT_RECONSTRUCTION: 0, OTHER: 0,
  };
  notifications.filter((item) => item.operationalSignalClassification === 'NEEDS_REVIEW').forEach((item) => {
    const descriptor = descriptorByNotification.get(String(item.alertId));
    if (item.signals?.conflict) reviewRows.MAPPING_CONFLICT += 1;
    else if (!item.acceptedIdentity && item.signals?.candidateOnly) reviewRows.CANDIDATE_ONLY_MAPPING += 1;
    else if (!item.acceptedIdentity) reviewRows.NO_ACCEPTED_MAPPING += 1;
    else if (!descriptor) reviewRows.NO_TELEMETRY += 1;
    else if (descriptor.boundary === 'EVIDENCE_INVALID_METRIC' || descriptor.telemetryValidation?.status === 'MISMATCHED') reviewRows.INVALID_METRIC_EVIDENCE += 1;
    else if (descriptor.telemetryValidation?.totalRecords === 0) reviewRows.NO_TELEMETRY += 1;
    else if (descriptor.boundary === 'DEGRADATION_BOUNDARY_UNKNOWN') reviewRows.TELEMETRY_BOUNDARY_UNKNOWN += 1;
    else if (descriptor.state === 'ONGOING') reviewRows.ONGOING_EVENT_WITHOUT_SUFFICIENT_EVIDENCE += 1;
    else if (descriptor.state === 'INSUFFICIENT_EVIDENCE' || descriptor.confidence === 'LOW') reviewRows.INSUFFICIENT_EVENT_RECONSTRUCTION += 1;
    else reviewRows.OTHER += 1;
  });
  const labels = {
    NO_ACCEPTED_MAPPING: 'No accepted mapping', CANDIDATE_ONLY_MAPPING: 'Candidate-only mapping',
    MAPPING_CONFLICT: 'Mapping conflict', INVALID_METRIC_EVIDENCE: 'Invalid metric evidence',
    NO_TELEMETRY: 'No telemetry', TELEMETRY_BOUNDARY_UNKNOWN: 'Telemetry boundary unknown',
    ONGOING_EVENT_WITHOUT_SUFFICIENT_EVIDENCE: 'Ongoing event without sufficient evidence',
    INSUFFICIENT_EVENT_RECONSTRUCTION: 'Insufficient event reconstruction', OTHER: 'Other',
  };
  const rows = Object.entries(reviewRows).map(([code, value]) => ({ code, reason: labels[code], count: value }));
  const reviewTotal = count('NEEDS_REVIEW');
  const classifiedById = new Map(notifications.map((item) => [String(item.alertId), item]));
  const finalizedEvents = descriptors.map((descriptor) => {
    const eventNotifications = (descriptor.notifications || []).map((item) => {
      const classified = classifiedById.get(String(item.alertId));
      return {
        ...item,
        classification: classified?.operationalSignalClassification || 'NEEDS_REVIEW',
        classificationReason: classified?.actionabilityReasons || [],
        classificationProvenance: {
          before: classified?.actionability || 'NEEDS_REVIEW',
          after: classified?.operationalSignalClassification || 'NEEDS_REVIEW',
          evidencePackageAlertId: item.alertId,
          metricIntent: descriptor.telemetryValidation?.expectedIntent || null,
          modelVersion: snapshot.reconstructionVersion,
        },
      };
    });
    const eventCount = (classification) => eventNotifications.filter((item) => item.classification === classification).length;
    return {
      ...descriptor,
      notifications: eventNotifications,
      classification: {
        useful: eventCount('USEFUL_ACTIONABLE_SIGNAL'),
        redundant: eventCount('REDUNDANT_REAL_EVENT_NOTIFICATION'),
        nonActionable: eventCount('NON_ACTIONABLE_NOISE'),
        needsReview: eventCount('NEEDS_REVIEW'),
        reconciliation: eventNotifications.length === eventCount('USEFUL_ACTIONABLE_SIGNAL') + eventCount('REDUNDANT_REAL_EVENT_NOTIFICATION')
          + eventCount('NON_ACTIONABLE_NOISE') + eventCount('NEEDS_REVIEW'),
      },
    };
  });
  return {
    ...snapshot,
    events: finalizedEvents,
    summary: {
      ...snapshot.summary,
      confirmedEvents: confirmed.length,
      notifications: confirmedNotifications.length,
      usefulSignals: count('USEFUL_ACTIONABLE_SIGNAL'),
      redundantNotifications: count('REDUNDANT_REAL_EVENT_NOTIFICATION'),
      nonActionableEvents: count('NON_ACTIONABLE_NOISE'),
      needsReviewEvents: reviewTotal,
      averageNotificationsPerEvent: confirmed.length ? Number((confirmedNotifications.length / confirmed.length).toFixed(2)) : 0,
      notificationCoverage: confirmedNotifications.length,
    },
    reviewBreakdown: { total: reviewTotal, rows, reconciliation: rows.reduce((sum, item) => sum + item.count, 0) === reviewTotal },
  };
}

function redactDeep(value, key = '', depth = 0) {
  if (depth > 14) return null;
  if (/token|secret|password|credential|authorization|cookie|raw/i.test(key)) return '[REDACTED]';
  if (typeof value === 'string') return value.replace(/(?:bearer|basic)\s+[a-z0-9._~+/=-]+/gi, '[REDACTED]');
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, key, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([nestedKey, item]) => [nestedKey, redactDeep(item, nestedKey, depth + 1)]));
  return value;
}

function createOperationalSignalStore({ database = db, config = NOISE_OPERATIONAL_SIGNAL_CONFIG } = {}) {
  let readyPromise = null;
  const ensure = () => {
    if (!readyPromise) readyPromise = database.query(`
      CREATE TABLE IF NOT EXISTS noise_operational_signal_snapshots (
        analysis_range TEXT NOT NULL,
        operational_signal_version TEXT NOT NULL,
        analysis_version TEXT NOT NULL,
        evidence_version TEXT NOT NULL,
        mapping_version TEXT NOT NULL,
        actionability_version TEXT NOT NULL,
        snapshot_json JSONB NOT NULL,
        computed_at TIMESTAMPTZ NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (analysis_range, operational_signal_version, analysis_version, evidence_version, mapping_version, actionability_version)
      )
    `).catch((error) => { readyPromise = null; throw error; });
    return readyPromise;
  };
  return {
    async load(range) {
      await ensure();
      const result = await database.query(`
        SELECT snapshot_json FROM noise_operational_signal_snapshots
        WHERE analysis_range=$1 AND operational_signal_version=$2 AND evidence_version=$3
          AND mapping_version=$4 AND actionability_version=$5 AND expires_at > NOW()
        ORDER BY computed_at DESC LIMIT 1
      `, [range, config.operationalSignalModelVersion, config.evidenceModelVersion, config.mappingModelVersion, config.actionabilityModelVersion]);
      return result.rows[0]?.snapshot_json || null;
    },
    async save(snapshot) {
      await ensure();
      const safe = redactDeep(snapshot);
      const expiresAt = new Date(toMs(snapshot.computedAt) + config.cacheTtlMs).toISOString();
      await database.query(`
        INSERT INTO noise_operational_signal_snapshots (
          analysis_range, operational_signal_version, analysis_version, evidence_version,
          mapping_version, actionability_version, snapshot_json, computed_at, expires_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)
        ON CONFLICT (analysis_range, operational_signal_version, analysis_version, evidence_version, mapping_version, actionability_version)
        DO UPDATE SET snapshot_json=EXCLUDED.snapshot_json, computed_at=EXCLUDED.computed_at, expires_at=EXCLUDED.expires_at
      `, [snapshot.range, config.operationalSignalModelVersion, snapshot.analysisVersion, config.evidenceModelVersion, config.mappingModelVersion, config.actionabilityModelVersion, JSON.stringify(safe), snapshot.computedAt, expiresAt]);
      return true;
    },
  };
}

function publicEvent(event, includeNotifications = false) {
  return {
    eventId: event.eventId, name: event.name, eventStatus: event.eventStatus, firstSignal: event.firstSignal,
    lastSignal: event.lastSignal, durationMs: event.durationMs, sources: event.sources, confidence: event.confidence,
    canonicalEntity: event.canonicalEntity, environment: event.environment, groupingReasons: event.groupingReasons,
    window: includeNotifications ? { from: iso(event.window?.from), to: iso(event.window?.to) } : undefined,
    representativeAlertId: event.representativeAlertId, representativeAlertNumber: event.representativeAlertNumber,
    representativeSource: event.representativeSource, representativeReason: event.representativeReason,
    summary: event.summary, sourceBacked: event.sourceBacked, crossSource: event.crossSource,
    jira: event.jira, slack: event.slack, timeline: includeNotifications ? event.timeline : undefined,
    appDynamicsReconstruction: includeNotifications ? event.appDynamicsReconstruction : undefined,
    notifications: includeNotifications ? event.notifications : undefined,
  };
}

function createNoiseOperationalSignalService({
  actionability = actionabilityService,
  acquisition = evidenceAcquisitionService,
  enrichment = enrichmentService,
  reconstruction = appDynamicsEventReconstructionService,
  config = NOISE_OPERATIONAL_SIGNAL_CONFIG,
  store = null,
  now = () => Date.now(),
} = {}) {
  const persistence = store || createOperationalSignalStore({ config });
  const memory = new Map();

  async function compute(range, refresh = false, providedSnapshot = null) {
    const cached = memory.get(range);
    // A caller-provided actionability snapshot is authoritative for this
    // computation. Do not return an older operator-view cache before applying
    // newly persisted evidence overrides.
    if (!providedSnapshot && !refresh && cached?.operatorViewVersion === config.operatorViewVersion && now() - toMs(cached.computedAt) < config.cacheTtlMs) return { ...cached, cache: { hit: true, source: 'MEMORY', ttlMs: config.cacheTtlMs } };
    if (!providedSnapshot && !refresh) {
      try {
        const persisted = await persistence.load(range);
        if (persisted?.operationalSignalModelVersion === config.operationalSignalModelVersion
          && persisted?.operatorViewVersion === config.operatorViewVersion) {
          memory.set(range, persisted);
          return { ...persisted, cache: { hit: true, source: 'PERSISTED', ttlMs: config.cacheTtlMs } };
        }
      } catch { /* Persistence is optional; deterministic computation remains available. */ }
    }
    const startedAt = now();
    let snapshot = providedSnapshot;
    let restoredEvidencePackages = providedSnapshot
      ? providedSnapshot.occurrences.filter((item) => item.enrichment).length
      : 0;
    if (!snapshot) {
      try { await acquisition.restore(range); } catch { /* Evidence persistence can be unavailable without changing the safe default. */ }
      const baseline = await actionability.getSnapshot({ range, refresh });
      const overrides = enrichment.getOverrides(range, baseline.analysisVersion);
      restoredEvidencePackages = overrides.size;
      snapshot = overrides.size ? await actionability.getSnapshot({ range, enrichmentOverrides: overrides }) : baseline;
    }
    const byAlert = new Map((snapshot.analysis._normalizedAlerts || []).map((alert) => [alertId(alert), alert]));
    const notifications = snapshot.occurrences.map((occurrence) => {
      const alert = byAlert.get(occurrence.canonicalOperationsId) || { id: occurrence.canonicalOperationsId, tinyId: occurrence.alertNumber };
      return notificationRecord(alert, occurrence, snapshot.patternResults, config);
    });
    let reconstructionSnapshot = null;
    let reconstructedEvents = [];
    let remainingNotifications = notifications;
    if (range === '24h' && reconstruction?.reconstruct && typeof enrichment.prepareStatus === 'function') {
      try {
        reconstructionSnapshot = await reconstruction.reconstruct({ snapshot, notifications, refresh });
        const byId = new Map(notifications.map((item) => [String(item.alertId), item]));
        const consumed = new Set();
        reconstructedEvents = (reconstructionSnapshot.events || []).filter((item) => (
          item.state !== 'INSUFFICIENT_EVIDENCE' && ['HIGH', 'MEDIUM'].includes(item.confidence)
          && item.mapping?.accepted === true && item.telemetryValidation?.status === 'MATCHED'
          && item.telemetryValidation?.evidenceLevel === 'DIRECT' && item.notificationIds?.length
        )).map((descriptor) => {
          const detailById = new Map((descriptor.notifications || []).map((item) => [String(item.alertId), item]));
          const eventNotifications = descriptor.notificationIds.map((id) => byId.get(String(id))).filter(Boolean).map((item) => {
            consumed.add(String(item.alertId));
            const detail = detailById.get(String(item.alertId));
            return {
              ...item,
              groupingReason: 'SAME_APPDYNAMICS_DEGRADATION_EPISODE',
              reconstructionRepresentative: String(item.alertId) === String(descriptor.representativeAlertId),
              reconstructionDistinctInformation: detail?.distinctInformation || [],
              signals: {
                ...item.signals,
                monitoringActionable: true,
                monitoringRecovered: descriptor.state === 'RECOVERED' || descriptor.state === 'TRANSIENT',
                monitoringSources: unique([...(item.signals.monitoringSources || []), 'AppDynamics']),
                sourceRecords: Math.max(1, Number(item.signals.sourceRecords || 0)),
                sourceTelemetryInspected: true,
              },
            };
          });
          const first = eventNotifications[0];
          const from = toMs(descriptor.startAt) || Math.min(...eventNotifications.map((item) => item.window.from));
          const to = toMs(descriptor.recoveryAt) || Math.max(...eventNotifications.map((item) => item.window.to));
          return {
            eventId: descriptor.eventId,
            name: `${descriptor.application?.name || descriptor.application?.id || first?.canonicalEntity || 'AppDynamics'} · ${descriptor.conditionFamily}`,
            canonicalEntity: descriptor.entity || descriptor.application?.name || first?.canonicalEntity || null,
            acceptedIdentity: true,
            environment: first?.environment || null,
            primarySource: 'AppDynamics',
            fingerprintHash: first?.fingerprintHash || descriptor.eventId,
            jiraKeys: unique(eventNotifications.flatMap((item) => item.signals.jiraKeys || [])),
            operationClusterIds: unique(eventNotifications.flatMap((item) => item.operationClusterIds || [])),
            window: { from, to: Math.max(from, to) },
            firstSignal: descriptor.startAt || first?.createdAt,
            lastSignal: descriptor.recoveryAt || eventNotifications.at(-1)?.createdAt,
            notifications: eventNotifications,
            groupingReasons: ['SAME_APPDYNAMICS_DEGRADATION_EPISODE'],
            appDynamicsReconstruction: descriptor,
          };
        });
        remainingNotifications = notifications.filter((item) => !consumed.has(String(item.alertId)));
      } catch { /* Reconstruction is evidence enrichment; safe default remains the existing classifier. */ }
    }
    const events = [...reconstructedEvents, ...groupOperationalEvents(remainingNotifications, { range, config })]
      .map((event) => classifyEvent(event, config));
    const finalizedReconstruction = finalizeAppDynamicsReconstruction(reconstructionSnapshot, events);
    let acquisitionStatus = null;
    if (typeof acquisition.getStatus === 'function') {
      try { acquisitionStatus = await acquisition.getStatus({ range }); } catch { /* Diagnostics are advisory and must not change classification. */ }
    }
    const expectedTotal = Number(snapshot.analysis.totalAlertsInRange || 0);
    const summary = summarize(events, expectedTotal);
    const operationsApiRequests = Number(snapshot.analysis.coverage?.operationsApiRequests || 0);
    const operationsLifecycleRequests = Number(snapshot.analysis.coverage?.lifecycleAlertsAttempted || 0);
    const externalEvidenceCalls = Number(acquisitionStatus?.performance?.externalApiCalls || 0);
    const result = {
      phase: '4.3', range, computedAt: new Date(now()).toISOString(), analysisVersion: snapshot.analysisVersion,
      operationalSignalModelVersion: config.operationalSignalModelVersion,
      operatorViewVersion: config.operatorViewVersion,
      evidenceModelVersion: config.evidenceModelVersion, mappingModelVersion: config.mappingModelVersion,
      actionabilityModelVersion: config.actionabilityModelVersion,
      evaluationWindow: { range: '24h', evidenceHistory: 'up to 90d', historicalEvidenceExpandsDenominator: false },
      summary, patterns: aggregatePatterns(events), reviewBreakdown: needsReviewBreakdown(events),
      sourceEvidenceCoverage: sourceEvidenceCoverage(events), sourceSummary: sourceSummary(events), events,
      appDynamicsEventReconstruction: finalizedReconstruction,
      coverage: {
        alertsClassified: notifications.length,
        totalAlerts: expectedTotal,
        complete: snapshot.analysis.complete && notifications.length === expectedTotal,
        percentage: percentage(notifications.length, expectedTotal),
        denominatorRange: '24h',
      },
      performance: {
        initialAnalysisLatencyMs: Math.max(0, now() - startedAt),
        executionTimeMs: Math.max(0, now() - startedAt),
        restoredEvidencePackages,
        externalCalls: operationsApiRequests + operationsLifecycleRequests + externalEvidenceCalls,
        operationsApiRequests,
        operationsLifecycleRequests,
        externalEvidenceCalls,
        cacheHits: Number(acquisitionStatus?.performance?.cacheHits || 0),
        requestsAvoided: Number(acquisitionStatus?.performance?.requestsAvoided || 0),
        sourceTimeouts: Number(acquisitionStatus?.performance?.timeouts || acquisitionStatus?.acquisition?.timeouts || 0),
        maximumConcurrency: Number(acquisitionStatus?.performance?.maxConcurrency || 3),
      },
      cache: { hit: false, source: 'COMPUTED', ttlMs: config.cacheTtlMs },
      readOnly: true, externalMutations: 'none', aiUsed: false, automaticSuppression: 'none', automaticTuning: 'none',
    };
    memory.set(range, result);
    try { await persistence.save(result); result.persistence = 'SAVED'; } catch { result.persistence = 'UNAVAILABLE'; }
    return result;
  }

  async function list(options = {}) {
    const responseStartedAt = now();
    const range = parseRange(options.range);
    const snapshot = await compute(range, String(options.refresh || '').toLowerCase() === 'true');
    const page = Math.max(1, Number.parseInt(options.page || '1', 10) || 1);
    const size = [25, 50, 100].includes(Number(options.size)) ? Number(options.size) : 25;
    const totalPages = Math.max(1, Math.ceil(snapshot.events.length / size));
    const safePage = Math.min(page, totalPages);
    const start = (safePage - 1) * size;
    return {
      ...snapshot,
      performance: {
        ...snapshot.performance,
        responseLatencyMs: Math.max(0, now() - responseStartedAt),
        cachedAnalysisLatencyMs: snapshot.cache?.hit ? Math.max(0, now() - responseStartedAt) : null,
      },
      events: undefined,
      eventGroups: snapshot.events.slice(start, start + size).map((event) => publicEvent(event)),
      pagination: { page: safePage, size, total: snapshot.events.length, totalPages },
    };
  }

  async function getEvent(eventId, options = {}) {
    const id = cleanText(eventId);
    if (!/^(?:evt|appd_evt)_[a-f0-9]{24}$/.test(id)) {
      const error = new Error('A valid operational event ID is required.'); error.code = 'INVALID_OPERATIONAL_EVENT_ID'; error.status = 400; error.safeMessage = error.message; throw error;
    }
    const snapshot = await compute(parseRange(options.range), false);
    const event = snapshot.events.find((item) => item.eventId === id);
    if (!event) { const error = new Error('Operational event was not found in the selected range.'); error.code = 'OPERATIONAL_EVENT_NOT_FOUND'; error.status = 404; error.safeMessage = error.message; throw error; }
    return { phase: '4.3', range: snapshot.range, operationalSignalModelVersion: config.operationalSignalModelVersion, operatorViewVersion: config.operatorViewVersion, event: publicEvent(event, true), readOnly: true, externalMutations: 'none' };
  }

  async function getPattern(patternId, options = {}) {
    const id = cleanText(patternId);
    const snapshot = await compute(parseRange(options.range), false);
    const pattern = snapshot.patterns.find((item) => item.patternId === id);
    if (!pattern) { const error = new Error('Operational signal pattern was not found in the selected range.'); error.code = 'OPERATIONAL_SIGNAL_PATTERN_NOT_FOUND'; error.status = 404; error.safeMessage = error.message; throw error; }
    const events = snapshot.events.filter((event) => event.notifications.some((item) => item.patternId === id));
    const eventSummary = {
      groups: events.length,
      underlyingOperationalEvents: events.filter((event) => event.eventStatus === 'REAL_EVENT_CONFIRMED').length,
      sourceBacked: events.filter((event) => event.sourceBacked).length,
      crossSource: events.filter((event) => event.crossSource).length,
      confidence: {
        HIGH: events.filter((event) => event.confidence === 'HIGH').length,
        MEDIUM: events.filter((event) => event.confidence === 'MEDIUM').length,
        LOW: events.filter((event) => event.confidence === 'LOW').length,
      },
    };
    return { phase: '4.3', range: snapshot.range, operationalSignalModelVersion: config.operationalSignalModelVersion, operatorViewVersion: config.operatorViewVersion, pattern, eventSummary, eventGroups: events.map((event) => publicEvent(event, true)), reconciliation: pattern.useful + pattern.redundant + pattern.nonActionable + pattern.needsReview === pattern.occurrences, readOnly: true, externalMutations: 'none' };
  }

  function invalidate() { memory.clear(); }
  return { compute, getEvent, getPattern, invalidate, list };
}

module.exports = {
  CLASSIFICATIONS,
  aggregatePatterns,
  classifyEvent,
  createNoiseOperationalSignalService,
  createOperationalSignalStore,
  distinctInformation,
  groupOperationalEvents,
  needsReviewBreakdown,
  notificationRecord,
  decisionEvidenceFor,
  selectRepresentative,
  service: createNoiseOperationalSignalService(),
  summarize,
  sourceEvidenceCoverage,
};
