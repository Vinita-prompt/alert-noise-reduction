const fs = require('node:fs');
const path = require('node:path');
const db = require('../config/db');
const appDynamicsService = require('./appDynamics.service');
const alertEpisodeService = require('./alertEpisode.service').service;
const identityRelationshipEnrichmentService = require('./identityRelationshipEnrichment.service').service;

const migrationSql = fs.readFileSync(
  path.join(__dirname, '../db/migrations/049_appdynamics_source_evidence.sql'),
  'utf8',
);
const KNOWN_REGRESSION_ALERTS = Object.freeze(['174781', '174797', '174768', '174816', '174817', '174810', '174765']);
const MAX_WINDOW_MS = 48 * 60 * 60 * 1000;
const OCCURRENCE_MATCH_WINDOW_MS = 10 * 60 * 1000;
const PAIR_WINDOW_MS = 2 * 60 * 1000;
const ENVIRONMENT_PREFIX = /^(?:prod(?:uction)?|dev(?:elopment)?|qa|test|stage|staging|nonprod|non-production)[-_]/i;

let schemaPromise = null;

function clean(value) {
  return String(value ?? '').trim();
}

function safeNumber(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function toIso(value) {
  if (value === undefined || value === null || value === '') return null;
  const numeric = Number(value);
  const date = Number.isFinite(numeric) && numeric > 1_000_000_000
    ? new Date(numeric)
    : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function unique(values) {
  return [...new Set(values.filter((value) => value !== undefined && value !== null && value !== '').map(String))];
}

function toArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  for (const key of ['items', 'data', 'applications', 'events', 'healthRules', 'policyViolations', 'policy-violations', 'violations']) {
    if (Array.isArray(value[key])) return value[key];
  }
  return [];
}

function replaceApplicationTokens(value, application) {
  return clean(value)
    .replace(/:applicationId/g, encodeURIComponent(application.id))
    .replace(/:applicationName/g, encodeURIComponent(application.name));
}

function applicationAlias(value) {
  return clean(value).replace(ENVIRONMENT_PREFIX, '').toLowerCase();
}

function normalizedText(value) {
  return clean(value)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\bis\s+(?:critical|warning|normal)\.?$/i, '')
    .replace(/\b(?:has violated|started violating|is no longer violating)\b/gi, '')
    .replace(/[^a-z0-9]+/gi, ' ')
    .trim()
    .toLowerCase();
}

function conditionSemantic(condition) {
  const value = normalizedText(condition);
  if (value === 'new critical anomaly') {
    return {
      code: 'APPDYNAMICS_NEW_CRITICAL_ANOMALY',
      triggerTypes: ['ANOMALY_OPEN_CRITICAL'],
      recoveryTypes: ['ANOMALY_CLOSE_CRITICAL'],
    };
  }
  if (value === 'anomaly state changed from warning to critical') {
    return {
      code: 'APPDYNAMICS_ANOMALY_WARNING_TO_CRITICAL',
      triggerTypes: ['ANOMALY_UPGRADED', 'ANOMALY_UPGRADED_CRITICAL', 'ANOMALY_WARNING_TO_CRITICAL'],
      recoveryTypes: ['ANOMALY_CLOSE_CRITICAL'],
    };
  }
  return null;
}

function eventConditionValues(event) {
  return unique([
    event.healthRule,
    event.policy,
    event.affectedEntity,
    event.message?.match(/Health Rule\s+(.+?)\s+(?:has violated|started violating|is no longer violating|state changed)/i)?.[1],
  ].map(normalizedText).filter(Boolean));
}

function eventMatchesCondition(event, condition) {
  const expected = normalizedText(condition);
  if (!expected) return false;
  const semantic = conditionSemantic(condition);
  if (semantic) {
    const acceptedTypes = event.isRecovery ? semantic.recoveryTypes : semantic.triggerTypes;
    return acceptedTypes.includes(clean(event.type).toUpperCase());
  }
  const values = eventConditionValues(event);
  if (values.includes(expected)) return true;
  return values.some((value) => value.includes(expected) || expected.includes(value))
    || normalizedText(event.message).includes(expected);
}

function sourceEventTime(value) {
  return toIso(
    value.eventTime
      ?? value.eventTimeString
      ?? value.startTimeInMillis
      ?? value.detectedTimeInMillis
      ?? value.timestamp,
  );
}

function sourceRecoveryTime(value) {
  return toIso(
    value.endTimeInMillis
      ?? value.resolvedTimeInMillis
      ?? value.endTime
      ?? value.resolvedAt,
  );
}

function entityOfType(entities, pattern) {
  return entities.find((entity) => pattern.test(clean(entity?.entityType || entity?.type)));
}

function normalizeSourceEvent(application, value, endpointCategory, controllerBaseUrl) {
  const affectedEntities = toArray(value.affectedEntities || value.affectedEntityDefinitions);
  const affectedEntity = value.affectedEntityDefinition || value.triggeredEntityDefinition || affectedEntities[0] || null;
  const tier = entityOfType(affectedEntities, /APPLICATION_COMPONENT$/i);
  const node = entityOfType(affectedEntities, /NODE/i);
  const transaction = entityOfType(affectedEntities, /BUSINESS_TRANSACTION/i);
  const type = clean(value.type || value.eventType || value.eventTypeKey || value.incidentStatus || value.status).toUpperCase() || null;
  const id = clean(value.id || value.eventId || value.guid) || null;
  const isRecovery = endpointCategory === 'healthrule-violations'
    ? /RESOLVED|CLOSED|ENDED|RECOVERED/.test(type)
    : /CLOSE|RESOLVED|RECOVERED|CLEAR/.test(type);
  const isFiring = endpointCategory === 'healthrule-violations'
    ? !isRecovery
    : /OPEN|CONTINUES|UPGRADED|VIOLAT|CRITICAL|WARNING/.test(type) && !isRecovery;
  const deepLink = clean(value.deepLinkUrl || value.deepLink || value.eventUrl || value.url || value.href) || (
    id ? `${clean(controllerBaseUrl).replace(/\/controller\/?$/i, '')}/#location=APP_EVENT_VIEWER_MODAL&eventSummary=${encodeURIComponent(id)}` : null
  );

  return {
    applicationId: application.id,
    applicationName: application.name,
    id,
    eventId: endpointCategory === 'events' ? id : null,
    violationId: endpointCategory === 'healthrule-violations' ? id : null,
    endpointCategory,
    type,
    occurrenceState: type,
    firingAt: sourceEventTime(value),
    recoveryAt: sourceRecoveryTime(value) || (isRecovery ? sourceEventTime(value) : null),
    currentState: isRecovery ? 'RECOVERED' : isFiring ? 'FIRING' : 'UNKNOWN',
    isFiring,
    isRecovery,
    severity: clean(value.severity || value.eventSeverity) || null,
    message: clean(value.summary || value.description || value.eventMessage) || null,
    affectedEntity: clean(affectedEntity?.name || value.affectedEntity || value.triggeredEntity) || null,
    tierId: clean(tier?.entityId || tier?.id || value.tierId) || null,
    tier: clean(tier?.name || value.tierName) || null,
    nodeId: clean(node?.entityId || node?.id || value.nodeId) || null,
    node: clean(node?.name || value.nodeName) || null,
    businessTransactionId: clean(transaction?.entityId || transaction?.id || value.businessTransactionId) || null,
    businessTransaction: clean(transaction?.name || value.businessTransactionName) || null,
    healthRuleId: clean(value.healthRuleId || value.healthRule?.id) || null,
    healthRule: clean(value.healthRuleName || (endpointCategory === 'healthrule-violations' ? value.name : null)) || null,
    policyId: clean(value.policyId || value.policy?.id) || null,
    policy: clean(value.policyName || value.policy?.name) || null,
    deepLink,
    rawPayload: value,
    provenance: {
      source: 'AppDynamics Controller API',
      endpointCategory,
      applicationId: application.id,
      sourceRecordId: id,
      readOnly: true,
    },
  };
}

function triggerEvent(event) {
  return event.endpointCategory === 'healthrule-violations'
    || (event.isFiring && !event.isRecovery);
}

function recoveryEvent(event) {
  return event.isRecovery || Boolean(event.recoveryAt);
}

function candidateScore(event, alertAt, condition) {
  if (!event?.firingAt || !eventMatchesCondition(event, condition) || !triggerEvent(event)) return null;
  const differenceMs = Math.abs(new Date(event.firingAt).getTime() - alertAt);
  if (!Number.isFinite(differenceMs) || differenceMs > OCCURRENCE_MATCH_WINDOW_MS) return null;
  const timePoints = differenceMs <= 2 * 60 * 1000 ? 35 : differenceMs <= 5 * 60 * 1000 ? 25 : 15;
  const expected = normalizedText(condition);
  // A documented source notification semantic is an exact condition match.
  // It must not lose authority merely because anomaly events identify the
  // notification in `type` rather than repeating its label in `message`.
  const exactCondition = Boolean(conditionSemantic(condition))
    || eventConditionValues(event).includes(expected);
  return {
    event,
    differenceMs,
    score: 40 + timePoints + (exactCondition ? 25 : 18) + (event.endpointCategory === 'healthrule-violations' ? 5 : 0),
  };
}

function selectCandidate(events, alertAt, condition, endpointCategory, preferredIds = []) {
  const candidates = events
    .filter((event) => event.endpointCategory === endpointCategory)
    .map((event) => candidateScore(event, alertAt, condition))
    .filter(Boolean)
    .sort((left, right) => right.score - left.score || left.differenceMs - right.differenceMs);
  if (!candidates.length || candidates[0].score < 75) return { candidate: null, ambiguous: false, candidates };
  const preferred = candidates.filter((candidate) => preferredIds.map(clean).includes(clean(candidate.event.id)));
  if (preferred.length === 1) {
    return { candidate: preferred[0], ambiguous: false, candidates, selectedByExistingSourceId: true };
  }
  // Time proximity ranks diagnostic candidates, but cannot distinguish two
  // real occurrences with the same application and condition. Without an
  // existing exact source ID, every such case remains ambiguous.
  const ambiguous = candidates.length > 1;
  return { candidate: ambiguous ? null : candidates[0], ambiguous, candidates, selectedByExistingSourceId: false };
}

function sameOccurrenceIdentity(left, right) {
  const fields = ['healthRule', 'policy', 'affectedEntity', 'node', 'businessTransaction'];
  const comparable = fields.filter((field) => left[field] && right[field]);
  return comparable.length === 0 || comparable.some((field) => normalizedText(left[field]) === normalizedText(right[field]));
}

function findRecovery(events, trigger, condition) {
  if (!trigger?.firingAt) return null;
  if (trigger.recoveryAt) return trigger;
  const start = new Date(trigger.firingAt).getTime();
  return events
    .filter((event) => event.endpointCategory === 'events' && recoveryEvent(event) && event.firingAt)
    .filter((event) => {
      const time = new Date(event.recoveryAt || event.firingAt).getTime();
      return time >= start && time - start <= MAX_WINDOW_MS
        && eventMatchesCondition(event, condition)
        && sameOccurrenceIdentity(trigger, event);
    })
    .sort((left, right) => new Date(left.recoveryAt || left.firingAt) - new Date(right.recoveryAt || right.firingAt))[0] || null;
}

function candidateIdentity(event) {
  return clean(event?.businessTransactionId || event?.nodeId || event?.tierId
    || event?.healthRuleId || event?.policyId) || null;
}

function candidateDiagnostic(candidate, alertAt) {
  if (!candidate?.event) return null;
  const event = candidate.event;
  return {
    id: event.id,
    endpointCategory: event.endpointCategory,
    eventType: event.type,
    timestamp: event.firingAt,
    timestampDifferenceSeconds: Number((candidate.differenceMs / 1000).toFixed(3)),
    sourceEntityId: candidateIdentity(event),
    affectedEntity: event.affectedEntity || null,
    tier: event.tier || null,
    node: event.node || null,
    businessTransaction: event.businessTransaction || null,
    healthRule: event.healthRule || null,
    policy: event.policy || null,
    message: event.message || null,
    withinBoundedWindow: candidate.differenceMs <= OCCURRENCE_MATCH_WINDOW_MS,
    normalizedAgainst: new Date(alertAt).toISOString(),
  };
}

function unmatchedDiagnostic({ alert, episodeId, application, condition, events, eventSelection, violationSelection }) {
  const alertAt = new Date(alert.received_at).getTime();
  const sourceEvents = (events || []).filter((event) => event?.firingAt && triggerEvent(event));
  const ranked = sourceEvents.map((event) => ({
    event,
    differenceMs: Math.abs(new Date(event.firingAt).getTime() - alertAt),
  })).filter((candidate) => Number.isFinite(candidate.differenceMs))
    .sort((left, right) => left.differenceMs - right.differenceMs);
  const conditionCandidates = ranked.filter((candidate) => eventMatchesCondition(candidate.event, condition));
  const boundedSourceCandidates = ranked.filter((candidate) => candidate.differenceMs <= OCCURRENCE_MATCH_WINDOW_MS);
  const accepted = [...(eventSelection?.candidates || []), ...(violationSelection?.candidates || [])];
  const closest = accepted[0] || conditionCandidates[0] || boundedSourceCandidates[0] || ranked[0] || null;
  let failureClassification = 'NO_CANDIDATE';
  let rejectionReason = 'No AppDynamics occurrence candidate was returned for the resolved application.';
  if (!application) {
    failureClassification = 'APPLICATION_MISMATCH';
    rejectionReason = 'No unique controller application matched the stored alert identity.';
  } else if (!condition) {
    failureClassification = 'MISSING_SOURCE_ID';
    rejectionReason = 'The alert did not contain a deterministic source condition or occurrence identifier.';
  } else if (eventSelection?.ambiguous || violationSelection?.ambiguous) {
    failureClassification = 'MULTIPLE_CANDIDATES';
    rejectionReason = 'Multiple source occurrences share the application, deterministic condition, and bounded time; proximity alone cannot select one.';
  } else if (conditionCandidates[0]?.differenceMs > OCCURRENCE_MATCH_WINDOW_MS) {
    failureClassification = 'TIMESTAMP_MISMATCH';
    rejectionReason = 'A condition-compatible source occurrence exists, but it is outside the unchanged ten-minute matching window.';
  } else if (boundedSourceCandidates.length > 0 && accepted.length === 0) {
    failureClassification = 'CONDITION_MISMATCH';
    rejectionReason = 'Source events exist in the bounded window, but none match the deterministic condition or notification type.';
  }
  const raw = alert.raw_payload && typeof alert.raw_payload === 'object' ? alert.raw_payload : {};
  return {
    failureClassification,
    alertId: clean(alert.atlassian_ops_tiny_id) || alert.id,
    canonicalAlertId: alert.id,
    episodeId,
    alertTimestamp: toIso(alert.received_at),
    jsmCreatedTimestamp: toIso(raw.createdAt || alert.received_at),
    slackTimestamp: toIso(alert.slack_message_at),
    acknowledgementTimestamp: toIso(raw.ackTime),
    normalizedEventTime: closest?.event?.firingAt || null,
    timezoneNormalization: 'UTC_ISO_8601',
    application: application?.name || null,
    sourceApplicationId: application?.id || null,
    sourceCondition: condition || null,
    conditionSemantic: conditionSemantic(condition)?.code || null,
    alertTitle: alert.title || null,
    alertMessage: clean(raw.message || alert.title) || null,
    sourceEntityId: candidateIdentity(closest?.event),
    candidateEventCount: eventSelection?.candidates?.length || 0,
    candidateViolationCount: violationSelection?.candidates?.length || 0,
    closestCandidate: candidateDiagnostic(closest, alertAt),
    candidateIds: accepted.map((candidate) => ({
      id: candidate.event.id,
      endpointCategory: candidate.event.endpointCategory,
      eventType: candidate.event.type,
      timestamp: candidate.event.firingAt,
      timestampDifferenceSeconds: Number((candidate.differenceMs / 1000).toFixed(3)),
      sourceEntityId: candidateIdentity(candidate.event),
    })),
    rejectionReason,
    matchingWindowSeconds: OCCURRENCE_MATCH_WINDOW_MS / 1000,
  };
}

function reconcileOccurrence({ alert, episodeId, application, condition, events, priorOccurrence = null }) {
  const alertAt = new Date(alert.received_at).getTime();
  if (!application || !condition || !Number.isFinite(alertAt)) {
    const diagnostic = unmatchedDiagnostic({ alert, episodeId, application, condition, events });
    return {
      alertId: alert.id,
      episodeId,
      applicationId: application?.id || null,
      applicationName: application?.name || null,
      mappingStatus: application ? 'OCCURRENCE_IDENTITY_INSUFFICIENT' : 'APPLICATION_UNRESOLVED',
      sourceResolved: false,
      technicalEvidenceComplete: false,
      evaluable: false,
      matchMethod: null,
      matchConfidence: null,
      blocker: application ? 'A structured alert condition was not available.' : 'No unique AppDynamics application matched the stored alert identity.',
      provenance: [],
      evidence: { unmatchedDiagnostic: diagnostic },
    };
  }

  const eventSelection = selectCandidate(events, alertAt, condition, 'events', [priorOccurrence?.event_id].filter(Boolean));
  const violationSelection = selectCandidate(events, alertAt, condition, 'healthrule-violations', [priorOccurrence?.violation_id].filter(Boolean));
  if (eventSelection.ambiguous || violationSelection.ambiguous) {
    const diagnostic = unmatchedDiagnostic({
      alert, episodeId, application, condition, events, eventSelection, violationSelection,
    });
    return {
      alertId: alert.id,
      episodeId,
      applicationId: application.id,
      applicationName: application.name,
      mappingStatus: 'MULTIPLE_CANDIDATES',
      sourceResolved: false,
      technicalEvidenceComplete: false,
      evaluable: false,
      matchMethod: 'applicationId+condition+boundedEventTime',
      matchConfidence: null,
      blocker: 'Multiple AppDynamics source occurrences matched the same application, condition, and bounded time without a unique source identifier.',
      provenance: [],
      evidence: { unmatchedDiagnostic: diagnostic },
    };
  }

  let event = eventSelection.candidate?.event || null;
  let violation = violationSelection.candidate?.event || null;
  if (event && violation) {
    const paired = Math.abs(new Date(event.firingAt) - new Date(violation.firingAt)) <= PAIR_WINDOW_MS
      && eventMatchesCondition(event, condition)
      && eventMatchesCondition(violation, condition);
    if (!paired) {
      if (eventSelection.candidate.score >= violationSelection.candidate.score) violation = null;
      else event = null;
    }
  }
  const trigger = violation || event;
  if (!trigger) {
    const diagnostic = unmatchedDiagnostic({
      alert, episodeId, application, condition, events, eventSelection, violationSelection,
    });
    return {
      alertId: alert.id,
      episodeId,
      applicationId: application.id,
      applicationName: application.name,
      mappingStatus: 'NO_EXACT_OCCURRENCE_MATCH',
      sourceResolved: false,
      technicalEvidenceComplete: false,
      evaluable: false,
      matchMethod: 'applicationId+condition+boundedEventTime',
      matchConfidence: null,
      blocker: 'No unique AppDynamics event/violation matched the application, condition, and bounded alert time.',
      provenance: [],
      evidence: { unmatchedDiagnostic: diagnostic },
    };
  }

  const recovery = findRecovery(events, trigger, condition);
  const recoveryAt = trigger.recoveryAt || recovery?.recoveryAt || recovery?.firingAt || null;
  const currentState = recoveryAt ? 'RECOVERED' : 'FIRING';
  const entity = violation || event;
  const sourceOccurrenceId = violation?.violationId || event?.eventId || trigger.id;
  const sourceResolved = Boolean(sourceOccurrenceId && trigger.firingAt);
  const identityAvailable = Boolean(
    entity.affectedEntity || entity.healthRule || entity.policy || entity.tier
      || entity.node || entity.businessTransaction,
  );
  const technicalEvidenceComplete = sourceResolved && identityAvailable && Boolean(currentState);
  const score = Math.max(eventSelection.candidate?.score || 0, violationSelection.candidate?.score || 0);
  const matchConfidence = Math.min(100, score + (event && violation ? 5 : 0));
  const provenance = unique([event, violation, recovery].filter(Boolean).map((item) => (
    `${item.endpointCategory}:${item.id}`
  ))).map((reference) => ({ reference, source: 'AppDynamics Controller API', readOnly: true }));

  return {
    alertId: alert.id,
    episodeId,
    applicationId: application.id,
    applicationName: application.name,
    sourceOccurrenceId,
    eventId: event?.eventId || null,
    violationId: violation?.violationId || null,
    tierId: entity.tierId || event?.tierId || null,
    tierName: entity.tier || event?.tier || null,
    nodeId: entity.nodeId || event?.nodeId || null,
    nodeName: entity.node || event?.node || null,
    businessTransactionId: entity.businessTransactionId || event?.businessTransactionId || null,
    businessTransactionName: entity.businessTransaction || event?.businessTransaction || null,
    healthRuleId: entity.healthRuleId || event?.healthRuleId || null,
    healthRuleName: entity.healthRule || event?.healthRule || condition,
    policyId: entity.policyId || event?.policyId || null,
    policyName: entity.policy || event?.policy || null,
    affectedEntity: entity.affectedEntity || event?.affectedEntity || null,
    eventType: event?.type || trigger.type,
    occurrenceState: trigger.occurrenceState,
    currentState,
    firingAt: trigger.firingAt,
    recoveryAt,
    deepLink: violation?.deepLink || event?.deepLink || trigger.deepLink || null,
    mappingStatus: 'EXACT_OCCURRENCE_RESOLVED',
    sourceResolved,
    technicalEvidenceComplete,
    evaluable: technicalEvidenceComplete,
    matchMethod: eventSelection.selectedByExistingSourceId || violationSelection.selectedByExistingSourceId
      ? 'existingExactSourceIdRevalidated+applicationId+condition+boundedEventTime'
      : conditionSemantic(condition)
        ? 'exactApplicationId+deterministicNotificationType+boundedEventTime+sourceLifecycle'
        : 'exactApplicationId+exactCondition+boundedEventTime+sourceLifecycle',
    matchConfidence,
    blocker: null,
    condition,
    provenance,
    evidence: {
      event: event ? { id: event.id, endpointCategory: event.endpointCategory, type: event.type, time: event.firingAt } : null,
      violation: violation ? { id: violation.id, endpointCategory: violation.endpointCategory, state: violation.occurrenceState, start: violation.firingAt, end: violation.recoveryAt } : null,
      recovery: recovery ? { id: recovery.id, endpointCategory: recovery.endpointCategory, type: recovery.type, time: recovery.recoveryAt || recovery.firingAt } : null,
      matchingInputs: { applicationId: application.id, condition, alertTimestamp: toIso(alert.received_at) },
    },
  };
}

async function ensureSchema(database = db) {
  if (!schemaPromise) {
    schemaPromise = appDynamicsService.getConnectionState()
      .then(() => database.query(migrationSql))
      .catch((error) => {
        schemaPromise = null;
        throw error;
      });
  }
  await schemaPromise;
}

async function safeRead(client, pathValue, query = {}, options = {}) {
  try {
    const response = await client.readOnlyRequest(pathValue, query, options);
    return {
      ok: true,
      httpStatus: response.httpStatus,
      payload: response.payload,
      count: toArray(response.payload).length,
    };
  } catch (error) {
    return {
      ok: false,
      httpStatus: error.status || null,
      payload: null,
      count: 0,
      error: error.message || 'AppDynamics read failed.',
    };
  }
}

function applicationRecord(value) {
  return {
    id: clean(value.id || value.applicationId || value.name),
    name: clean(value.name || value.applicationName || value.id),
    rawPayload: value,
  };
}

function resolveApplicationTargets(applications, identifiers) {
  const requested = unique(identifiers.flatMap((item) => [item.id, item.name]));
  const selected = [];
  const unresolved = [];
  requested.forEach((identifier) => {
    const exact = applications.filter((application) => (
      clean(application.id) === clean(identifier)
      || application.name.toLowerCase() === clean(identifier).toLowerCase()
    ));
    const aliases = exact.length ? exact : applications.filter((application) => (
      applicationAlias(application.name) === applicationAlias(identifier)
    ));
    if (aliases.length === 1) selected.push(aliases[0]);
    else unresolved.push({ identifier, matches: aliases.length });
  });
  return {
    selected: [...new Map(selected.map((application) => [application.id, application])).values()],
    unresolved,
  };
}

function rawId(value, fallback) {
  return clean(value.id || value[`${fallback}Id`] || value.name || value.displayName) || null;
}

function rawName(value, fallback) {
  return clean(value.name || value[`${fallback}Name`] || value.displayName || rawId(value, fallback)) || null;
}

function backendRows(application, backends, tiers) {
  const tiersById = new Map(tiers.map((tier) => [clean(tier.id || tier.tierId), rawName(tier, 'tier')]));
  return backends.map((backend) => {
    const id = rawId(backend, 'backend');
    const name = rawName(backend, 'backend');
    const tierId = clean(backend.tierId) || null;
    const type = clean(backend.exitPointType || backend.type) || 'backend';
    return {
      applicationId: application.id,
      entityId: `backend:${id}`,
      entityType: /jdbc|database|db2|oracle|mysql|postgres|sql|mongo|cassandra|redis/i.test(`${type} ${name}`) ? 'database_dependency' : 'backend_dependency',
      entityName: name,
      sourceEntityId: tierId ? `tier:${tierId}` : `application:${application.id}`,
      targetEntityId: `backend:${id}`,
      rawPayload: { ...backend, relationshipProvenance: 'AppDynamics backends endpoint', tierName: tiersById.get(tierId) || null },
    };
  }).filter((row) => row.entityId !== 'backend:null');
}

function topologyRows(application, data) {
  const rows = [];
  const tiersByName = new Map(data.tiers.map((tier) => [rawName(tier, 'tier').toLowerCase(), rawId(tier, 'tier')]));
  data.tiers.forEach((tier) => {
    const id = rawId(tier, 'tier');
    rows.push({ applicationId: application.id, entityId: `tier:${id}`, entityType: 'tier', entityName: rawName(tier, 'tier'), sourceEntityId: `application:${application.id}`, targetEntityId: `tier:${id}`, rawPayload: { ...tier, relationshipProvenance: 'AppDynamics tiers endpoint' } });
  });
  data.nodes.forEach((node) => {
    const id = rawId(node, 'node');
    const tierId = clean(node.tierId) || tiersByName.get(clean(node.tierName || node.tier).toLowerCase()) || null;
    rows.push({ applicationId: application.id, entityId: `node:${id}`, entityType: 'node', entityName: rawName(node, 'node'), sourceEntityId: tierId ? `tier:${tierId}` : `application:${application.id}`, targetEntityId: `node:${id}`, rawPayload: { ...node, relationshipProvenance: 'AppDynamics nodes endpoint' } });
  });
  data.businessTransactions.forEach((transaction) => {
    const id = rawId(transaction, 'businessTransaction');
    const tierId = tiersByName.get(clean(transaction.tierName || transaction.tier).toLowerCase()) || null;
    rows.push({ applicationId: application.id, entityId: `transaction:${id}`, entityType: 'business_transaction', entityName: rawName(transaction, 'businessTransaction'), sourceEntityId: tierId ? `tier:${tierId}` : `application:${application.id}`, targetEntityId: `transaction:${id}`, rawPayload: { ...transaction, relationshipProvenance: 'AppDynamics business-transactions endpoint' } });
  });
  data.healthRules.forEach((rule) => {
    const id = rawId(rule, 'healthRule');
    rows.push({ applicationId: application.id, entityId: `health-rule:${id}`, entityType: 'health_rule', entityName: rawName(rule, 'healthRule'), sourceEntityId: `application:${application.id}`, targetEntityId: `health-rule:${id}`, rawPayload: { ...rule, relationshipProvenance: 'AppDynamics health-rules endpoint' } });
  });
  data.policies.forEach((policy) => {
    const id = rawId(policy, 'policy');
    rows.push({ applicationId: application.id, entityId: `policy:${id}`, entityType: 'policy', entityName: rawName(policy, 'policy'), sourceEntityId: `application:${application.id}`, targetEntityId: `policy:${id}`, rawPayload: { ...policy, relationshipProvenance: 'AppDynamics policies endpoint' } });
  });
  rows.push(...backendRows(application, data.backends, data.tiers));
  return rows.filter((row) => !/:null$/.test(row.entityId));
}

async function writeRows(rows, writer, concurrency = 8) {
  let index = 0;
  async function worker() {
    while (index < rows.length) {
      const row = rows[index];
      index += 1;
      await writer(row);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, rows.length)) }, worker));
}

async function persistInventory(database, applications, bundles) {
  await writeRows(applications, (application) => database.query(`
    INSERT INTO appdynamics_applications (application_id, application_name, raw_payload, last_updated, updated_at)
    VALUES ($1,$2,$3::jsonb,NOW(),NOW())
    ON CONFLICT (application_id) DO UPDATE SET application_name=EXCLUDED.application_name,
      raw_payload=EXCLUDED.raw_payload, last_updated=NOW(), updated_at=NOW()
  `, [application.id, application.name, JSON.stringify(application.rawPayload || {})]));

  for (const bundle of bundles) {
    const { application, data } = bundle;
    await writeRows(data.tiers, (value) => database.query(`
      INSERT INTO appdynamics_tiers (application_id,tier_id,tier_name,tier_type,agent_type,number_of_nodes,raw_payload,updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,NOW()) ON CONFLICT (application_id,tier_id) DO UPDATE SET
        tier_name=EXCLUDED.tier_name,tier_type=EXCLUDED.tier_type,agent_type=EXCLUDED.agent_type,
        number_of_nodes=EXCLUDED.number_of_nodes,raw_payload=EXCLUDED.raw_payload,updated_at=NOW()
    `, [application.id, rawId(value, 'tier'), rawName(value, 'tier'), value.type || value.tierType || null, value.agentType || value.agentTypeName || null, safeNumber(value.numberOfNodes ?? value.nodeCount, 0), JSON.stringify(value)]));
    await writeRows(data.nodes, (value) => database.query(`
      INSERT INTO appdynamics_nodes (application_id,node_id,node_name,tier_id,tier_name,server_name,raw_payload,updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,NOW()) ON CONFLICT (application_id,node_id) DO UPDATE SET
        node_name=EXCLUDED.node_name,tier_id=EXCLUDED.tier_id,tier_name=EXCLUDED.tier_name,
        server_name=EXCLUDED.server_name,raw_payload=EXCLUDED.raw_payload,updated_at=NOW()
    `, [application.id, rawId(value, 'node'), rawName(value, 'node'), clean(value.tierId) || null, clean(value.tierName || value.tier) || null, clean(value.machineName || value.serverName || value.hostName) || null, JSON.stringify(value)]));
    await writeRows(data.businessTransactions, (value) => database.query(`
      INSERT INTO appdynamics_business_transactions (application_id,business_transaction_id,business_transaction_name,tier_name,last_seen_at,raw_payload,updated_at)
      VALUES ($1,$2,$3,$4,NOW(),$5::jsonb,NOW()) ON CONFLICT (application_id,business_transaction_id) DO UPDATE SET
        business_transaction_name=EXCLUDED.business_transaction_name,tier_name=EXCLUDED.tier_name,
        last_seen_at=NOW(),raw_payload=EXCLUDED.raw_payload,updated_at=NOW()
    `, [application.id, rawId(value, 'businessTransaction'), rawName(value, 'businessTransaction'), clean(value.tierName || value.tier) || null, JSON.stringify(value)]));
    await writeRows(data.healthRules, (value) => database.query(`
      INSERT INTO appdynamics_health_rules (application_id,health_rule_id,health_rule_name,enabled,raw_payload,updated_at)
      VALUES ($1,$2,$3,$4,$5::jsonb,NOW()) ON CONFLICT (application_id,health_rule_id) DO UPDATE SET
        health_rule_name=EXCLUDED.health_rule_name,enabled=EXCLUDED.enabled,raw_payload=EXCLUDED.raw_payload,updated_at=NOW()
    `, [application.id, rawId(value, 'healthRule'), rawName(value, 'healthRule'), value.enabled !== false, JSON.stringify(value)]));
    await writeRows(data.policies, (value) => database.query(`
      INSERT INTO appdynamics_policies (application_id,policy_id,policy_name,enabled,raw_payload,updated_at)
      VALUES ($1,$2,$3,$4,$5::jsonb,NOW()) ON CONFLICT (application_id,policy_id) DO UPDATE SET
        policy_name=EXCLUDED.policy_name,enabled=EXCLUDED.enabled,raw_payload=EXCLUDED.raw_payload,updated_at=NOW()
    `, [application.id, rawId(value, 'policy'), rawName(value, 'policy'), value.enabled === undefined ? null : value.enabled !== false, JSON.stringify(value)]));
    await writeRows(data.events, (event) => database.query(`
      INSERT INTO appdynamics_events (application_id,event_id,severity,status,event_type,tier_name,node_name,summary,description,event_time,category,raw_payload,updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,NOW()) ON CONFLICT (application_id,event_id) DO UPDATE SET
        severity=EXCLUDED.severity,status=EXCLUDED.status,event_type=EXCLUDED.event_type,tier_name=EXCLUDED.tier_name,
        node_name=EXCLUDED.node_name,summary=EXCLUDED.summary,description=EXCLUDED.description,event_time=EXCLUDED.event_time,
        category=EXCLUDED.category,raw_payload=EXCLUDED.raw_payload,updated_at=NOW()
    `, [application.id, event.id, clean(event.severity).toLowerCase() || 'unknown', clean(event.currentState).toLowerCase() || 'unknown', event.type, event.tier, event.node, event.message || `${event.type || 'AppDynamics'} event`, event.message || '', event.firingAt || new Date().toISOString(), event.endpointCategory, JSON.stringify({ ...event.rawPayload, sourceEvidenceProvenance: event.provenance })]));
    await writeRows(topologyRows(application, data), (row) => database.query(`
      INSERT INTO appdynamics_flow_map (application_id,entity_id,entity_type,entity_name,source_entity_id,target_entity_id,raw_payload,updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,NOW()) ON CONFLICT (application_id,entity_type,entity_id) DO UPDATE SET
        entity_name=EXCLUDED.entity_name,source_entity_id=EXCLUDED.source_entity_id,
        target_entity_id=EXCLUDED.target_entity_id,raw_payload=EXCLUDED.raw_payload,updated_at=NOW()
    `, [row.applicationId, row.entityId, row.entityType, row.entityName, row.sourceEntityId, row.targetEntityId, JSON.stringify(row.rawPayload || {})]));
  }
}

async function persistOccurrences(database, rows) {
  await writeRows(rows, (row) => database.query(`
    INSERT INTO appdynamics_alert_occurrence_evidence (
      alert_id,episode_id,application_id,application_name,source_occurrence_id,event_id,violation_id,
      tier_id,tier_name,node_id,node_name,business_transaction_id,business_transaction_name,
      health_rule_id,health_rule_name,policy_id,policy_name,affected_entity,event_type,occurrence_state,
      current_state,firing_at,recovery_at,deep_link,match_method,match_confidence,mapping_status,
      source_resolved,technical_evidence_complete,evaluable,evidence,provenance,observed_at,updated_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31::jsonb,$32::jsonb,NOW(),NOW())
    ON CONFLICT (alert_id) DO UPDATE SET
      episode_id=EXCLUDED.episode_id,application_id=EXCLUDED.application_id,application_name=EXCLUDED.application_name,
      source_occurrence_id=EXCLUDED.source_occurrence_id,event_id=EXCLUDED.event_id,violation_id=EXCLUDED.violation_id,
      tier_id=EXCLUDED.tier_id,tier_name=EXCLUDED.tier_name,node_id=EXCLUDED.node_id,node_name=EXCLUDED.node_name,
      business_transaction_id=EXCLUDED.business_transaction_id,business_transaction_name=EXCLUDED.business_transaction_name,
      health_rule_id=EXCLUDED.health_rule_id,health_rule_name=EXCLUDED.health_rule_name,policy_id=EXCLUDED.policy_id,
      policy_name=EXCLUDED.policy_name,affected_entity=EXCLUDED.affected_entity,event_type=EXCLUDED.event_type,
      occurrence_state=EXCLUDED.occurrence_state,current_state=EXCLUDED.current_state,firing_at=EXCLUDED.firing_at,
      recovery_at=EXCLUDED.recovery_at,deep_link=EXCLUDED.deep_link,match_method=EXCLUDED.match_method,
      match_confidence=EXCLUDED.match_confidence,mapping_status=EXCLUDED.mapping_status,
      source_resolved=EXCLUDED.source_resolved,technical_evidence_complete=EXCLUDED.technical_evidence_complete,
      evaluable=EXCLUDED.evaluable,evidence=EXCLUDED.evidence,provenance=EXCLUDED.provenance,observed_at=NOW(),updated_at=NOW()
  `, [row.alertId,row.episodeId,row.applicationId,row.applicationName,row.sourceOccurrenceId||null,row.eventId||null,row.violationId||null,
    row.tierId||null,row.tierName||null,row.nodeId||null,row.nodeName||null,row.businessTransactionId||null,row.businessTransactionName||null,
    row.healthRuleId||null,row.healthRuleName||null,row.policyId||null,row.policyName||null,row.affectedEntity||null,row.eventType||null,
    row.occurrenceState||null,row.currentState||null,row.firingAt||null,row.recoveryAt||null,row.deepLink||null,row.matchMethod||null,
    row.matchConfidence??null,row.mappingStatus,row.sourceResolved===true,row.technicalEvidenceComplete===true,row.evaluable===true,
    JSON.stringify({...(row.evidence||{}),blocker:row.blocker||null}),JSON.stringify(row.provenance||[])]));
}

function titleApplicationMatch(title, applications) {
  const body = clean(title).replace(/^\[AppD(?:ynamics)?\]\s*/i, '');
  const matches = applications.map((application) => ({
    application,
    aliases: unique([application.name, applicationAlias(application.name)]).sort((left, right) => right.length - left.length),
  })).flatMap(({ application, aliases }) => aliases.map((alias) => ({ application, alias })))
    .filter(({ alias }) => body.toLowerCase().startsWith(`${alias.toLowerCase()} `))
    .sort((left, right) => right.alias.length - left.alias.length);
  if (!matches.length) return null;
  const bestLength = matches[0].alias.length;
  const best = matches.filter((match) => match.alias.length === bestLength);
  return unique(best.map((match) => match.application.id)).length === 1 ? best[0] : null;
}

function alertCondition(title, applicationName, matchedAlias = null) {
  let body = clean(title).replace(/^\[AppD(?:ynamics)?\]\s*/i, '');
  const aliases = unique([matchedAlias, applicationName, applicationAlias(applicationName)]).sort((left, right) => right.length - left.length);
  const alias = aliases.find((value) => body.toLowerCase().startsWith(`${value.toLowerCase()} `));
  if (alias) body = body.slice(alias.length).trim();
  return body.replace(/\s+is\s+(?:critical|warning|normal)\.?$/i, '').trim() || null;
}

async function acquireEvidence({ database, client, applications, from, to }) {
  const config = await client.getRuntimeConfig();
  const timeQuery = {
    'time-range-type': 'BETWEEN_TIMES',
    'start-time': new Date(from).getTime(),
    'end-time': new Date(to).getTime(),
    output: 'JSON',
  };
  const bundles = [];
  for (const application of applications) {
    const reads = await Promise.all([
      safeRead(client, replaceApplicationTokens(config.credentials.tiersPath, application), { output: 'JSON' }),
      safeRead(client, replaceApplicationTokens(config.credentials.nodesPath, application), { output: 'JSON' }),
      safeRead(client, replaceApplicationTokens(config.credentials.businessTransactionsPath, application), { output: 'JSON' }),
      safeRead(client, replaceApplicationTokens(config.credentials.healthRulesPath, application)),
      safeRead(client, replaceApplicationTokens(config.credentials.policiesPath, application)),
      safeRead(client, `/controller/rest/applications/${encodeURIComponent(application.id)}/backends`, { output: 'JSON' }),
      safeRead(client, replaceApplicationTokens(config.credentials.eventsPath, application), {
        ...timeQuery,
        'event-types': config.credentials.eventTypes.join(','),
        severities: config.credentials.eventSeverities,
      }, { timeoutMs: 20_000 }),
      safeRead(client, replaceApplicationTokens(config.credentials.violationsPath, application), timeQuery, { timeoutMs: 20_000 }),
    ]);
    const categories = ['tiers','nodes','businessTransactions','healthRules','policies','backends','events','violations'];
    const diagnostics = Object.fromEntries(categories.map((category, index) => [category, {
      ok: reads[index].ok,
      httpStatus: reads[index].httpStatus,
      count: reads[index].count,
      ...(reads[index].ok ? {} : { error: reads[index].error }),
    }]));
    const rawEvents = toArray(reads[6].payload).map((value) => normalizeSourceEvent(application, value, 'events', config.baseUrl));
    const violations = toArray(reads[7].payload).map((value) => normalizeSourceEvent(application, value, 'healthrule-violations', config.baseUrl));
    bundles.push({
      application,
      diagnostics,
      data: {
        tiers: toArray(reads[0].payload),
        nodes: toArray(reads[1].payload),
        businessTransactions: toArray(reads[2].payload),
        healthRules: toArray(reads[3].payload),
        policies: toArray(reads[4].payload),
        backends: toArray(reads[5].payload),
        events: [...rawEvents, ...violations].filter((event) => event.id),
      },
    });
  }
  await persistInventory(database, [], bundles);
  return bundles;
}

function coverageFor(rows, predicate) {
  const count = rows.filter(predicate).length;
  return { count, total: rows.length, percentage: rows.length ? Number((count / rows.length * 100).toFixed(1)) : 0 };
}

function sourceCoverage(rows) {
  return {
    exactOccurrence: coverageFor(rows, (row) => row.sourceResolved),
    application: coverageFor(rows, (row) => Boolean(row.applicationId)),
    tier: coverageFor(rows, (row) => Boolean(row.tierId || row.tierName)),
    node: coverageFor(rows, (row) => Boolean(row.nodeId || row.nodeName)),
    businessTransaction: coverageFor(rows, (row) => Boolean(row.businessTransactionId || row.businessTransactionName)),
    healthRuleOrPolicy: coverageFor(rows, (row) => Boolean(row.healthRuleId || row.healthRuleName || row.policyId || row.policyName)),
    event: coverageFor(rows, (row) => Boolean(row.eventId)),
    violation: coverageFor(rows, (row) => Boolean(row.violationId)),
    lifecycle: coverageFor(rows, (row) => Boolean(row.firingAt && row.currentState)),
    recovery: coverageFor(rows, (row) => Boolean(row.recoveryAt)),
    technicalEvidenceComplete: coverageFor(rows, (row) => row.technicalEvidenceComplete),
    evaluable: coverageFor(rows, (row) => row.evaluable),
  };
}

function distribution(values) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  const percentile = (ratio) => sorted.length ? sorted[Math.floor((sorted.length - 1) * ratio)] : null;
  return {
    count: sorted.length,
    minSeconds: sorted[0] ?? null,
    medianSeconds: percentile(0.5),
    p95Seconds: percentile(0.95),
    maxSeconds: sorted.at(-1) ?? null,
  };
}

function timestampAlignment(rows, alertById) {
  const seconds = (later, earlier) => {
    if (!later || !earlier) return null;
    const difference = new Date(later).getTime() - new Date(earlier).getTime();
    return Number.isFinite(difference) ? Number((difference / 1000).toFixed(3)) : null;
  };
  const matched = rows.filter((row) => row.sourceResolved && row.firingAt);
  return {
    normalization: 'All source, JSM, Slack, acknowledgement, and database timestamps were converted to UTC ISO-8601 in memory; stored timestamps were not changed.',
    matchingWindowSeconds: OCCURRENCE_MATCH_WINDOW_MS / 1000,
    sourceOccurrenceToJsmCreated: distribution(matched.map((row) => {
      const alert = alertById.get(row.alertId);
      const raw = alert?.raw_payload && typeof alert.raw_payload === 'object' ? alert.raw_payload : {};
      return seconds(raw.createdAt || alert?.received_at, row.firingAt);
    })),
    sourceEventToJsmCreated: distribution(matched.map((row) => {
      const alert = alertById.get(row.alertId);
      const raw = alert?.raw_payload && typeof alert.raw_payload === 'object' ? alert.raw_payload : {};
      return seconds(raw.createdAt || alert?.received_at, row.evidence?.event?.time);
    })),
    violationStartToJsmCreated: distribution(matched.map((row) => {
      const alert = alertById.get(row.alertId);
      const raw = alert?.raw_payload && typeof alert.raw_payload === 'object' ? alert.raw_payload : {};
      return seconds(raw.createdAt || alert?.received_at, row.evidence?.violation?.start);
    })),
    sourceEventToViolationStart: distribution(matched.map((row) => (
      seconds(row.evidence?.violation?.start, row.evidence?.event?.time)
    ))),
    jsmCreatedToSlack: distribution(rows.map((row) => {
      const alert = alertById.get(row.alertId);
      const raw = alert?.raw_payload && typeof alert.raw_payload === 'object' ? alert.raw_payload : {};
      return seconds(alert?.slack_message_at, raw.createdAt || alert?.received_at);
    })),
    jsmCreatedToAcknowledgement: distribution(rows.map((row) => {
      const alert = alertById.get(row.alertId);
      const raw = alert?.raw_payload && typeof alert.raw_payload === 'object' ? alert.raw_payload : {};
      return seconds(raw.ackTime, raw.createdAt || alert?.received_at);
    })),
    timezoneMismatchDetected: false,
    windowWidened: false,
  };
}

function groupRemainingReviews(reviewRows, alertById) {
  const groups = {
    activeFiringWithExactLifecycle: [],
    recoveredButOccurrenceIdentityUnresolved: [],
    sourceApiDataInsufficient: [],
    multipleMatchingOccurrences: [],
    genuineAmbiguity: [],
  };
  const byEpisode = new Map();
  reviewRows.forEach((row) => {
    if (!byEpisode.has(row.episodeId)) byEpisode.set(row.episodeId, []);
    byEpisode.get(row.episodeId).push(row);
  });
  [...byEpisode.entries()].forEach(([episodeId, rows]) => {
    const alertIds = rows.map((row) => clean(alertById.get(row.alertId)?.atlassian_ops_tiny_id) || row.alertId);
    const exact = rows.filter((row) => row.sourceResolved);
    const unresolved = rows.filter((row) => !row.sourceResolved);
    if (exact.some((row) => row.currentState === 'FIRING')) {
      groups.activeFiringWithExactLifecycle.push({ episodeId, alertIds });
    }
    if (!unresolved.length) return;
    const classifications = unique(unresolved.map((row) => row.evidence?.unmatchedDiagnostic?.failureClassification || 'OTHER'));
    const summary = { episodeId, alertIds, failureClassifications: classifications };
    if (classifications.includes('MULTIPLE_CANDIDATES')) groups.multipleMatchingOccurrences.push(summary);
    else if (classifications.some((value) => ['NO_CANDIDATE', 'CONDITION_MISMATCH', 'TIMESTAMP_MISMATCH', 'MISSING_SOURCE_ID'].includes(value))) {
      groups.sourceApiDataInsufficient.push(summary);
    } else groups.genuineAmbiguity.push(summary);
    // JSM status is intentionally not used to populate the recovered group.
    // Only an exact source occurrence with source recovery may be recovered.
  });
  return groups;
}

function createAppDynamicsEvidenceAcquisitionService({
  database = db,
  client = appDynamicsService,
  episodes = alertEpisodeService,
  identity = identityRelationshipEnrichmentService,
  clock = () => Date.now(),
} = {}) {
  async function reconcile(options = {}) {
    await ensureSchema(database);
    const now = clock();
    const from = new Date(options.from || now - 24 * 60 * 60 * 1000).getTime();
    const to = new Date(options.to || now).getTime();
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from || to - from > MAX_WINDOW_MS) {
      const error = new Error('A valid AppDynamics evidence window of at most 48 hours is required.');
      error.status = 400;
      throw error;
    }

    const before = await identity.analyze({ refresh: options.refresh === true, limit: 100 });
    const snapshot = await episodes.buildSnapshot({ refresh: false });
    const currentAppDynamicsEpisodes = (snapshot.episodes || []).filter((episode) => episode.source === 'AppDynamics');
    const currentAlertIds = unique(currentAppDynamicsEpisodes.flatMap((episode) => episode.alertIds));
    const alertRows = currentAlertIds.length ? (await database.query(`
      SELECT alerts.id,alerts.atlassian_ops_tiny_id,alerts.title,alerts.status,
             alerts.received_at,alerts.last_seen_at,alerts.raw_payload,
             slack.message_at AS slack_message_at
      FROM alerts
      LEFT JOIN LATERAL (
        SELECT message_at
        FROM slack_alert_events
        WHERE alert_number=alerts.atlassian_ops_tiny_id
        ORDER BY message_at ASC
        LIMIT 1
      ) slack ON TRUE
      WHERE alerts.id = ANY($1::text[])
    `, [currentAlertIds])).rows : [];
    const priorOccurrences = currentAlertIds.length ? (await database.query(`
      SELECT alert_id,event_id,violation_id,source_occurrence_id,source_resolved,
             firing_at,recovery_at,match_method,mapping_status
      FROM appdynamics_alert_occurrence_evidence
      WHERE alert_id = ANY($1::text[])
    `, [currentAlertIds])).rows : [];
    const priorOccurrenceByAlert = new Map(priorOccurrences.map((row) => [row.alert_id, row]));

    const config = await client.getRuntimeConfig();
    const inventoryRead = await safeRead(client, config.credentials.applicationsPath, { output: 'JSON' });
    if (!inventoryRead.ok) {
      const error = new Error(inventoryRead.error || 'AppDynamics application inventory retrieval failed.');
      error.status = inventoryRead.httpStatus || 502;
      throw error;
    }
    const applications = toArray(inventoryRead.payload).map(applicationRecord).filter((application) => application.id && application.name);
    await persistInventory(database, applications, []);
    const beforeByEpisode = new Map((before.episodes || []).map((item) => [item.episodeId, item]));
    const episodeByAlert = new Map(currentAppDynamicsEpisodes.flatMap((episode) => episode.alertIds.map((alertId) => [alertId, episode])));
    const applicationByAlert = new Map();
    const targetReferences = [];
    alertRows.forEach((alert) => {
      const episode = episodeByAlert.get(alert.id);
      const enrichment = beforeByEpisode.get(episode?.episodeId);
      const applicationId = enrichment?.fields?.applicationId?.value || null;
      const applicationName = enrichment?.fields?.application?.value || null;
      let application = applications.find((item) => item.id === clean(applicationId)) || null;
      let matchedAlias = null;
      let mappingMethod = application ? 'existingValidatedApplicationId' : null;
      if (!application && applicationName) {
        const matches = applications.filter((item) => applicationAlias(item.name) === applicationAlias(applicationName));
        if (matches.length === 1) {
          [application] = matches;
          matchedAlias = applicationName;
          mappingMethod = 'existingStructuredApplicationName+controllerInventory';
        }
      }
      if (!application) {
        const titleMatch = titleApplicationMatch(alert.title, applications);
        application = titleMatch?.application || null;
        matchedAlias = titleMatch?.alias || null;
        mappingMethod = application ? 'exactAlertTemplateApplicationName+controllerInventory' : null;
      }
      applicationByAlert.set(alert.id, {
        application,
        matchedAlias,
        mappingMethod,
        condition: application ? alertCondition(alert.title, application.name, matchedAlias || applicationName) : null,
      });
      if (application) targetReferences.push({ id: application.id, name: application.name });
    });

    const targets = resolveApplicationTargets(applications, targetReferences);
    const bundles = await acquireEvidence({ database, client, applications: targets.selected, from, to });
    const bundleByApplication = new Map(bundles.map((bundle) => [bundle.application.id, bundle]));
    const occurrenceRows = alertRows.map((alert) => {
      const episode = episodeByAlert.get(alert.id);
      const target = applicationByAlert.get(alert.id) || {};
      const bundle = target.application ? bundleByApplication.get(target.application.id) : null;
      const row = reconcileOccurrence({
        alert,
        episodeId: episode?.episodeId || null,
        application: target.application,
        condition: target.condition,
        events: bundle?.data?.events || [],
        priorOccurrence: priorOccurrenceByAlert.get(alert.id) || null,
      });
      return {
        ...row,
        evidence: { ...(row.evidence || {}), applicationMappingMethod: target.mappingMethod },
      };
    });
    await persistOccurrences(database, occurrenceRows);
    require('./liveOccurrenceAutomation.service').service.enqueue(
      occurrenceRows.map((row) => row.alertId),
      'SOURCE_EVIDENCE_REVISION',
    );

    const after = await identity.analyze({ refresh: true, limit: 100 });
    const reviewAlertIds = new Set((before.episodes || []).filter((item) => item.source === 'AppDynamics' && item.currentDecision === 'REVIEW')
      .flatMap((item) => item.alertIds));
    const reviewRows = occurrenceRows.filter((row) => reviewAlertIds.has(row.alertId));
    const alertById = new Map(alertRows.map((row) => [row.id, row]));
    const priorReviewRows = [...reviewAlertIds].map((alertId) => priorOccurrenceByAlert.get(alertId)).filter(Boolean);
    const newlyResolvedOccurrences = reviewRows.filter((row) => (
      row.sourceResolved && priorOccurrenceByAlert.get(row.alertId)?.source_resolved !== true
    )).map((row) => ({
      alertId: clean(alertById.get(row.alertId)?.atlassian_ops_tiny_id) || row.alertId,
      episodeId: row.episodeId,
      application: row.applicationName,
      healthRuleOrPolicy: row.healthRuleName || row.policyName || null,
      sourceOccurrenceId: row.sourceOccurrenceId,
      eventId: row.eventId || null,
      violationId: row.violationId || null,
      occurrenceStart: row.firingAt,
      recoveryTimestamp: row.recoveryAt || null,
      matchingMethod: row.matchMethod,
      evidenceProvenance: row.provenance,
      confidence: row.matchConfidence,
    }));
    const unmatchedDiagnostics = reviewRows.filter((row) => !row.sourceResolved)
      .map((row) => row.evidence?.unmatchedDiagnostic).filter(Boolean);
    const known = KNOWN_REGRESSION_ALERTS.map((tinyId) => {
      const alert = alertRows.find((row) => clean(row.atlassian_ops_tiny_id) === tinyId);
      const row = occurrenceRows.find((item) => item.alertId === alert?.id);
      return {
        alertId: tinyId,
        availableInWindow: Boolean(alert),
        sourceOccurrenceId: row?.sourceOccurrenceId || null,
        application: row?.applicationName || null,
        tier: row?.tierName || null,
        node: row?.nodeName || null,
        businessTransaction: row?.businessTransactionName || null,
        healthRuleOrPolicy: row?.healthRuleName || row?.policyName || null,
        eventId: row?.eventId || null,
        violationId: row?.violationId || null,
        occurrenceState: row?.occurrenceState || null,
        currentState: row?.currentState || null,
        firingTime: row?.firingAt || null,
        recoveryTime: row?.recoveryAt || null,
        technicalEvidenceStatus: row?.technicalEvidenceComplete ? 'COMPLETE' : row?.mappingStatus || 'NOT_AVAILABLE',
        mappingMethod: row?.matchMethod || null,
        mappingConfidence: row?.matchConfidence ?? null,
        blocker: row?.blocker || null,
      };
    });

    const endpointFailures = bundles.flatMap((bundle) => Object.entries(bundle.diagnostics)
      .filter(([, diagnostic]) => !diagnostic.ok)
      .map(([category, diagnostic]) => ({ applicationId: bundle.application.id, category, httpStatus: diagnostic.httpStatus, error: diagnostic.error })));
    const totals = bundles.reduce((summary, bundle) => {
      const data = bundle.data;
      summary.tiers += data.tiers.length;
      summary.nodes += data.nodes.length;
      summary.businessTransactions += data.businessTransactions.length;
      summary.healthRules += data.healthRules.length;
      summary.policies += data.policies.length;
      summary.backends += data.backends.length;
      summary.events += data.events.filter((item) => item.endpointCategory === 'events').length;
      summary.violations += data.events.filter((item) => item.endpointCategory === 'healthrule-violations').length;
      return summary;
    }, { applications: applications.length, targetedApplications: bundles.length, tiers: 0, nodes: 0, businessTransactions: 0, healthRules: 0, policies: 0, backends: 0, events: 0, violations: 0 });

    return {
      generatedAt: new Date(clock()).toISOString(),
      mode: 'READ_ONLY_SHADOW_OBSERVATION',
      window: { from: new Date(from).toISOString(), to: new Date(to).toISOString(), bounded: true },
      connectivity: { controllerReachable: true, authentication: 'success', httpStatus: inventoryRead.httpStatus },
      retrieved: totals,
      endpointFailures,
      targetResolution: { requested: targetReferences.length, uniqueResolvedApplications: targets.selected.length, unresolved: targets.unresolved },
      appDynamicsReviews: { alerts: reviewRows.length, episodes: new Set(reviewRows.map((row) => row.episodeId)).size },
      reconciliationDelta: {
        before: {
          exactOccurrences: priorReviewRows.filter((row) => row.source_resolved).length,
          recoveries: priorReviewRows.filter((row) => row.recovery_at).length,
          denominator: reviewRows.length,
        },
        after: {
          exactOccurrences: reviewRows.filter((row) => row.sourceResolved).length,
          recoveries: reviewRows.filter((row) => row.recoveryAt).length,
          denominator: reviewRows.length,
        },
        newlyResolvedOccurrences,
      },
      timestampAlignment: timestampAlignment(occurrenceRows, alertById),
      unmatchedDiagnostics,
      unmatchedFailureBreakdown: unmatchedDiagnostics.reduce((summary, diagnostic) => {
        summary[diagnostic.failureClassification] = (summary[diagnostic.failureClassification] || 0) + 1;
        return summary;
      }, {}),
      remainingReviewGroups: groupRemainingReviews(reviewRows, alertById),
      coverage: {
        before: {
          identity: before.identityDiagnostics.before,
          topology: before.identityDiagnostics.coverage.appDynamicsTopology,
          occurrence: sourceCoverage(reviewRows.map((row) => ({ ...row, sourceResolved: false, technicalEvidenceComplete: false, evaluable: false, firingAt: null, recoveryAt: null, eventId: null, violationId: null, tierId: null, tierName: null, nodeId: null, nodeName: null, businessTransactionId: null, businessTransactionName: null, healthRuleId: null, healthRuleName: null, policyId: null, policyName: null }))),
        },
        after: {
          identity: after.identityDiagnostics.after,
          topology: after.identityDiagnostics.coverage.appDynamicsTopology,
          occurrence: sourceCoverage(reviewRows),
        },
      },
      knownRegressionAlerts: known,
      occurrenceResults: reviewRows.map((row) => ({
        alertId: row.alertId,
        episodeId: row.episodeId,
        applicationId: row.applicationId,
        sourceOccurrenceId: row.sourceOccurrenceId || null,
        eventId: row.eventId || null,
        violationId: row.violationId || null,
        currentState: row.currentState || null,
        firingAt: row.firingAt || null,
        recoveryAt: row.recoveryAt || null,
        mappingStatus: row.mappingStatus,
        matchMethod: row.matchMethod || null,
        matchConfidence: row.matchConfidence ?? null,
        sourceResolved: row.sourceResolved,
        technicalEvidenceComplete: row.technicalEvidenceComplete,
        evaluable: row.evaluable,
        blocker: row.blocker || null,
        failureClassification: row.evidence?.unmatchedDiagnostic?.failureClassification || null,
      })),
      identityDiagnostics: { before: before.identityDiagnostics, after: after.identityDiagnostics },
      correlationDiagnostics: after.correlationDiscovery,
      observationOnly: after.observationMode,
      safeguards: {
        appDynamicsRequests: 'GET_ONLY',
        controllerMutations: 0,
        classificationRulesChanged: false,
        classificationWrites: 0,
        humanOutcomeWrites: 0,
        historicalLabelChanges: 0,
        jiraWrites: 0,
        slackWrites: 0,
        automaticActionsEnabled: false,
      },
    };
  }

  return { reconcile };
}

module.exports = {
  KNOWN_REGRESSION_ALERTS,
  applicationAlias,
  alertCondition,
  candidateScore,
  conditionSemantic,
  createAppDynamicsEvidenceAcquisitionService,
  eventMatchesCondition,
  normalizeSourceEvent,
  reconcileOccurrence,
  selectCandidate,
  service: createAppDynamicsEvidenceAcquisitionService(),
  sourceCoverage,
  timestampAlignment,
  titleApplicationMatch,
  unmatchedDiagnostic,
};
