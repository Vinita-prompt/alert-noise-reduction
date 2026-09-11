const crypto = require('node:crypto');
const { OPERATIONAL_DECISION_POLICY } = require('../config/operationalDecisionPolicy');
const { appDynamicsWorkflowEvidence, operationalRecordSemantics } = require('./sourceEvidenceAdapters.service');

function cleanText(value) {
  return String(value ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function canonical(value) {
  return cleanText(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function hash(value, length = 24) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, length);
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

function unique(values) {
  return [...new Set(values.filter(Boolean).map(cleanText).filter(Boolean))];
}

function severityRank(value) {
  const text = cleanText(value).toUpperCase();
  if (/P1|CRITICAL|FATAL|SEV[ -]?1/.test(text)) return 4;
  if (/P2|HIGH|ERROR|SEV[ -]?2/.test(text)) return 3;
  if (/P3|MEDIUM|WARN|SEV[ -]?3/.test(text)) return 2;
  return text ? 1 : 0;
}

function isTelemetry(record) {
  return /telemetry|metric/i.test(cleanText(record?.type)) || Boolean(record?.metadata?.metric);
}

function normalizeRecord(record, source) {
  const semantics = operationalRecordSemantics(source, record);
  return {
    id: cleanText(record?.id) || `source_${hash(`${source}|${record?.timestamp}|${record?.type}|${record?.title}`)}`,
    source,
    type: cleanText(record?.type || 'source_record'),
    timestamp: iso(record?.timestamp),
    title: cleanText(record?.title) || null,
    summary: cleanText(record?.summary) || null,
    severity: cleanText(record?.severity) || null,
    entity: cleanText(record?.entity) || null,
    correlationKey: cleanText(record?.correlationKey) || null,
    metadata: record?.metadata || {},
    ...semantics,
  };
}

function eventState(event, normalizedRecords) {
  const reconstructed = cleanText(event?.appDynamicsReconstruction?.state).toUpperCase();
  if (reconstructed) return reconstructed;
  const active = normalizedRecords.some((item) => item.active);
  const recovered = normalizedRecords.some((item) => item.recovered);
  if (active && recovered) return 'RECOVERED';
  if (active) return 'ACTIVE';
  if (recovered) return 'RECOVERED';
  return 'UNKNOWN';
}

function buildEventModel(event) {
  const records = (event.notifications || []).flatMap((notification) => (notification.decisionEvidence?.monitoring || [])
    .flatMap((source) => (source.records || []).map((record) => normalizeRecord(record, source.source || notification.source))));
  const reconstructed = event.appDynamicsReconstruction || null;
  const sources = unique((event.notifications || []).map((item) => item.source));
  const entities = unique((event.notifications || []).flatMap((item) => [item.canonicalEntity, item.component, item.site, ...(item.agents || [])]));
  const evidenceIds = unique([
    ...records.map((item) => item.id),
    ...(reconstructed?.provenance?.recordIds || []),
  ]);
  return {
    eventId: cleanText(event.eventId) || `operational_event_${hash((event.notifications || []).map((item) => item.alertId).join('|'))}`,
    sources,
    entities,
    condition: cleanText(event.notifications?.[0]?.pattern || event.name) || 'Operational condition',
    start: iso(reconstructed?.startAt || event.firstSignal),
    peak: reconstructed?.peak || null,
    recovery: iso(reconstructed?.recoveryAt),
    duration: Number.isFinite(reconstructed?.durationMs) ? reconstructed.durationMs : Number(event.durationMs || 0) || null,
    state: eventState(event, records),
    notifications: (event.notifications || []).map((item) => String(item.alertId)),
    representativeNotification: null,
    escalations: [],
    recoveries: [],
    confidence: reconstructed?.confidence || 'LOW',
    evidenceIds,
    flapping: reconstructed?.flapping === true,
    transitionCount: Number(reconstructed?.transitionCount || 0),
    crossSource: sources.length > 1,
  };
}

function normalizeOccurrence(notification, eventModel, event) {
  const blocks = notification.decisionEvidence?.monitoring || [];
  const sourceNativeEvidence = [];
  const telemetry = [];
  blocks.forEach((block) => {
    (block.records || []).forEach((record) => {
      const normalized = normalizeRecord(record, block.source || notification.source);
      if (isTelemetry(normalized)) telemetry.push({
        ...normalized,
        matched: block.acceptedMapping === true && block.degradation === true,
        sustained: block.sustained === true,
        transient: block.transient === true,
      });
      else sourceNativeEvidence.push(normalized);
    });
  });
  const reconstructed = event.appDynamicsReconstruction;
  const belongsToReconstruction = notification.source === 'AppDynamics'
    && reconstructed?.notificationIds?.map(String).includes(String(notification.alertId));
  if (belongsToReconstruction && reconstructed?.telemetryValidation?.status === 'MATCHED'
    && reconstructed?.telemetryValidation?.evidenceLevel === 'DIRECT' && reconstructed?.mapping?.accepted === true) {
    telemetry.push({
      id: `appd-reconstruction:${reconstructed.eventId}`,
      source: 'AppDynamics', type: 'validated_direct_telemetry', timestamp: iso(reconstructed.startAt),
      title: reconstructed.telemetryValidation.expectedIntent || reconstructed.conditionFamily,
      summary: `${reconstructed.telemetryValidation.matchedRecords || 0} direct record(s) matched the reconstructed event.`,
      entity: reconstructed.entity || reconstructed.application?.name || reconstructed.application?.id || null,
      correlationKey: reconstructed.eventId, metadata: { eventId: reconstructed.eventId },
      active: !['RECOVERED', 'TRANSIENT'].includes(reconstructed.state), authoritative: false,
      recovered: ['RECOVERED', 'TRANSIENT'].includes(reconstructed.state), matched: true,
      sustained: reconstructed.state === 'ONGOING' || Number(reconstructed.durationMs || 0) > 60_000,
      transient: reconstructed.state === 'TRANSIENT',
    });
  }
  const nonActionableEvidence = blocks.filter((block) => block.nonActionable === true && block.recovered === true
    && (block.records || []).length > 0).map((block) => ({
    source: block.source || notification.source,
    type: block.transient ? 'TRANSIENT_RECOVERED_CONDITION' : 'SOURCE_CONFIRMED_NON_ACTIONABLE',
    recovered: true, transient: block.transient === true, sustained: block.sustained === true,
    durationMs: block.durationMs, reason: cleanText(block.reason),
    evidenceIds: (block.records || []).map((record) => cleanText(record.id)).filter(Boolean),
  }));
  const identity = {
    accepted: notification.acceptedIdentity === true || notification.sourceMapping?.accepted === true,
    level: cleanText(notification.sourceMapping?.level || 'NONE').toUpperCase(),
    canonicalEntity: cleanText(notification.canonicalEntity) || null,
    sourceEntityId: cleanText(notification.sourceMapping?.sourceEntityId) || null,
    sourceEntityName: cleanText(notification.sourceMapping?.sourceEntityName) || null,
    environment: cleanText(notification.environment) || null,
    conflicts: notification.decisionEvidence?.identity?.conflicts === true || notification.signals?.conflict === true,
    candidateOnly: notification.decisionEvidence?.identity?.candidateOnly === true || notification.signals?.candidateOnly === true,
    unavailable: notification.decisionEvidence?.identity?.unavailable === true || notification.signals?.identityUnavailable === true,
  };
  const appDynamicsWorkflow = notification.source === 'AppDynamics' ? appDynamicsWorkflowEvidence({
    alert: {
      ...notification,
      application: reconstructed?.application?.name || null,
      message: notification.title || notification.pattern || null,
    },
    identity,
    monitoringBlocks: blocks,
    reconstruction: reconstructed,
  }) : null;
  const evidenceIds = unique([...sourceNativeEvidence.map((item) => item.id), ...telemetry.map((item) => item.id),
    ...(appDynamicsWorkflow?.evidenceUsed || []).map((item) => item.id),
    ...(notification.decisionEvidence?.jira?.records || []).map((item) => item.id),
    ...(notification.decisionEvidence?.slack?.records || []).map((item) => item.id)]);
  const wrongSemanticEvidence = blocks.some((block) => /MISMATCH|WRONG_METRIC|WRONG_ENTITY|UNSUPPORTED_METRIC|ENTITY_NOT_FOUND/i.test(cleanText(block.outcome)));
  return {
    occurrenceId: String(notification.alertId),
    alert: {
      id: String(notification.alertId), alertNumber: notification.alertNumber || null,
      title: notification.title || null, source: notification.source || 'Unknown',
      priority: notification.priority || null, severity: notification.severity || null,
      status: notification.status || null, createdAt: notification.createdAt || null, closedAt: notification.closedAt || null,
      patternId: notification.patternId || null, pattern: notification.pattern || notification.title || 'Operational alert',
      component: notification.component || null, site: notification.site || null, agents: notification.agents || [],
      fingerprint: notification.fingerprintHash || null,
    },
    source: { name: notification.source || 'Unknown', monitoring: OPERATIONAL_DECISION_POLICY.monitoringSources.includes(notification.source) },
    identity,
    sourceNativeEvidence,
    telemetry,
    nonActionableEvidence,
    appDynamicsWorkflow,
    event: eventModel,
    operations: notification.decisionEvidence?.operations || {},
    jira: notification.decisionEvidence?.jira || { confirmedIncident: false, confirmedProblem: false, records: [] },
    slack: notification.decisionEvidence?.slack || { concreteAction: false, operatorActivity: false, records: [] },
    notificationRole: { role: 'UNKNOWN', reasons: [], repeatedRecovery: false, exactDuplicate: false },
    evidenceStatus: {
      state: notification.decisionEvidence?.state || notification.evidenceState || 'NOT_ENRICHED',
      hasSourceEvidence: sourceNativeEvidence.length + telemetry.length + nonActionableEvidence.length > 0,
      conflict: identity.conflicts,
      wrongMetricOrEntity: wrongSemanticEvidence,
    },
    evidenceConfidence: { level: 'LOW', provenanceIds: evidenceIds },
    legacyDiagnostics: {
      actionability: notification.actionability,
      operationalSignalClassification: notification.operationalSignalClassification,
      noiseLikelihood: notification.noiseLikelihood,
      reviewRisk: notification.reviewRisk,
      correlationConfidence: notification.correlationConfidence,
    },
  };
}

function sourceProof(occurrence) {
  if (occurrence.source.name === 'AppDynamics' && occurrence.appDynamicsWorkflow) {
    return occurrence.identity.accepted
      && occurrence.appDynamicsWorkflow.realEventStatus === 'CONFIRMED'
      && occurrence.appDynamicsWorkflow.sourceRuleId === 'APPD_WORKFLOW_INCIDENT_SOURCE_NATIVE_V1';
  }
  return occurrence.identity.accepted && occurrence.sourceNativeEvidence.some((item) => item.authoritative && item.active);
}

function telemetryProof(occurrence) {
  if (occurrence.source.name === 'AppDynamics' && occurrence.appDynamicsWorkflow) {
    return occurrence.identity.accepted
      && occurrence.appDynamicsWorkflow.realEventStatus === 'CONFIRMED'
      && occurrence.appDynamicsWorkflow.sourceRuleId === 'APPD_WORKFLOW_INCIDENT_SUSTAINED_TELEMETRY_V1';
  }
  return occurrence.identity.accepted && occurrence.telemetry.some((item) => item.matched && item.sustained && item.active);
}

function recoveryProof(occurrence) {
  return occurrence.identity.accepted && (occurrence.sourceNativeEvidence.some((item) => item.recovered)
    || occurrence.telemetry.some((item) => item.recovered));
}

function positiveEventProof(occurrence) {
  return sourceProof(occurrence) || telemetryProof(occurrence);
}

function sameEntity(left, right) {
  if (!left.identity.canonicalEntity || !right.identity.canonicalEntity) return false;
  return canonical(left.identity.canonicalEntity) === canonical(right.identity.canonicalEntity);
}

function sameCondition(left, right) {
  if (left.alert.fingerprint && right.alert.fingerprint) return left.alert.fingerprint === right.alert.fingerprint;
  return canonical(left.alert.pattern) === canonical(right.alert.pattern);
}

function sharedEvidenceIdentity(left, right) {
  const rightIds = new Set([...right.sourceNativeEvidence, ...right.telemetry]
    .flatMap((item) => [item.id, item.correlationKey, item.metadata?.eventId, item.metadata?.violationId]).filter(Boolean));
  return [...left.sourceNativeEvidence, ...left.telemetry]
    .flatMap((item) => [item.id, item.correlationKey, item.metadata?.eventId, item.metadata?.violationId]).filter(Boolean)
    .some((value) => rightIds.has(value));
}

function assignNotificationRoles(event, occurrences) {
  const sorted = [...occurrences].sort((left, right) => (toMs(left.alert.createdAt) || 0) - (toMs(right.alert.createdAt) || 0)
    || left.occurrenceId.localeCompare(right.occurrenceId));
  const representative = sorted.find(positiveEventProof) || sorted.find((item) => item.nonActionableEvidence.length) || sorted[0];
  sorted.forEach((occurrence, index) => {
    const prior = sorted.slice(0, index);
    const reasons = [];
    let role = 'UNKNOWN';
    const recovery = recoveryProof(occurrence);
    if (recovery && prior.some((item) => recoveryProof(item))) {
      role = 'REDUNDANT';
      occurrence.notificationRole.repeatedRecovery = true;
      reasons.push('The same event already has a retained recovery transition.');
    } else if (recovery && prior.some(positiveEventProof)) {
      role = 'RECOVERY';
      reasons.push('Source evidence provides the first useful recovery transition for the event.');
    } else if (occurrence.occurrenceId === representative.occurrenceId) {
      role = positiveEventProof(occurrence) || occurrence.nonActionableEvidence.length ? 'REPRESENTATIVE' : 'UNKNOWN';
      reasons.push(role === 'REPRESENTATIVE' ? 'This is the earliest evidence-backed notification for the event.' : 'No notification has enough source proof to represent a confirmed event.');
    } else {
      const priorSeverity = Math.max(0, ...prior.map((item) => severityRank(item.alert.priority || item.alert.severity)));
      const newSeverity = severityRank(occurrence.alert.priority || occurrence.alert.severity) > priorSeverity && priorSeverity > 0;
      const newEntity = prior.length > 0 && !prior.some((item) => sameEntity(item, occurrence));
      const newCondition = prior.length > 0 && !prior.some((item) => sameCondition(item, occurrence));
      const newSource = positiveEventProof(occurrence) && !prior.some((item) => item.source.name === occurrence.source.name);
      const previousComponents = new Set(prior.flatMap((item) => [item.alert.component, item.alert.site, ...(item.alert.agents || [])]).map(canonical).filter(Boolean));
      const newComponent = [occurrence.alert.component, occurrence.alert.site, ...(occurrence.alert.agents || [])]
        .map(canonical).filter(Boolean).some((value) => !previousComponents.has(value));
      if (newSeverity || newEntity || newComponent) {
        role = 'ESCALATION';
        if (newSeverity) reasons.push('The notification raises operational severity.');
        if (newEntity || newComponent) reasons.push('The notification introduces a new affected entity, component, location, or agent.');
      } else if (newCondition || newSource) {
        role = 'DISTINCT_SIGNAL';
        if (newCondition) reasons.push('The notification introduces a distinct condition.');
        if (newSource) reasons.push('A new monitoring source contributes independent degradation evidence.');
      } else if (positiveEventProof(representative) && sameEntity(occurrence, representative)
        && sameCondition(occurrence, representative) && (positiveEventProof(occurrence) || sharedEvidenceIdentity(occurrence, representative))) {
        role = 'REDUNDANT';
        reasons.push('The confirmed event already has a representative and this notification adds no distinct entity, condition, severity, source, or lifecycle information.');
      } else if (positiveEventProof(occurrence)) {
        role = 'DISTINCT_SIGNAL';
        reasons.push('This evidence-backed notification cannot be proven redundant to the retained representative.');
      }
    }
    occurrence.notificationRole = {
      ...occurrence.notificationRole, role, reasons,
      exactDuplicate: role === 'REDUNDANT' && sharedEvidenceIdentity(occurrence, representative)
        && sameEntity(occurrence, representative) && sameCondition(occurrence, representative),
    };
    if (occurrence.appDynamicsWorkflow) {
      occurrence.appDynamicsWorkflow.notificationRole = role;
      if (['ESCALATION', 'DISTINCT_SIGNAL'].includes(role) && positiveEventProof(occurrence)) {
        occurrence.appDynamicsWorkflow.sourceRuleId = 'APPD_WORKFLOW_INCIDENT_ESCALATION_V1';
      }
    }
    occurrence.evidenceConfidence = {
      ...occurrence.evidenceConfidence,
      level: sourceProof(occurrence) && occurrence.identity.level === 'EXACT' ? 'HIGH'
        : positiveEventProof(occurrence) || occurrence.nonActionableEvidence.length ? 'MEDIUM' : 'LOW',
    };
  });
  event.representativeNotification = representative.occurrenceId;
  event.escalations = sorted.filter((item) => item.notificationRole.role === 'ESCALATION').map((item) => item.occurrenceId);
  event.recoveries = sorted.filter((item) => item.notificationRole.role === 'RECOVERY').map((item) => item.occurrenceId);
  event.confidence = sorted.some((item) => item.evidenceConfidence.level === 'HIGH') ? 'HIGH'
    : sorted.some((item) => item.evidenceConfidence.level === 'MEDIUM') ? 'MEDIUM' : 'LOW';
  return sorted;
}

function buildCommonEvidenceModel(snapshot) {
  const events = [];
  const occurrences = [];
  (snapshot?.events || []).forEach((legacyEvent) => {
    const event = buildEventModel(legacyEvent);
    const eventOccurrences = (legacyEvent.notifications || []).map((notification) => normalizeOccurrence(notification, event, legacyEvent));
    assignNotificationRoles(event, eventOccurrences);
    events.push(event);
    occurrences.push(...eventOccurrences);
  });
  return {
    modelVersion: OPERATIONAL_DECISION_POLICY.modelVersion,
    range: '24h',
    evaluatedAt: snapshot?.computedAt || new Date().toISOString(),
    denominator: Number(snapshot?.summary?.totalAlerts || snapshot?.coverage?.totalAlerts || occurrences.length),
    occurrences,
    events,
    legacyDiagnostics: {
      summary: snapshot?.summary || null,
      reviewBreakdown: snapshot?.reviewBreakdown || [],
      sourceEvidenceCoverage: snapshot?.sourceEvidenceCoverage || null,
      versions: {
        operationalSignal: snapshot?.operationalSignalModelVersion || null,
        actionability: snapshot?.actionabilityModelVersion || null,
        evidence: snapshot?.evidenceModelVersion || null,
        identity: snapshot?.mappingModelVersion || null,
      },
    },
  };
}

module.exports = {
  assignNotificationRoles,
  buildCommonEvidenceModel,
  buildEventModel,
  normalizeOccurrence,
  positiveEventProof,
  recoveryProof,
  sourceProof,
  telemetryProof,
};
