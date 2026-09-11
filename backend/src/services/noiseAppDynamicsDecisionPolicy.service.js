const crypto = require('node:crypto');
const db = require('../config/db');
const { NOISE_APPDYNAMICS_DECISION_POLICY } = require('../config/noiseAppDynamicsDecisionPolicy');
const { evaluatePositiveNoiseProof } = require('./noiseAppDynamicsPositiveNoiseProof.service');

const DECISIONS = Object.freeze(['INCIDENT', 'NOISE', 'NEEDS_REVIEW']);
const EVENT_STATES = Object.freeze(['CONFIRMED', 'NOT_CONFIRMED', 'UNKNOWN']);
const NOTIFICATION_ROLES = Object.freeze([
  'REPRESENTATIVE', 'DISTINCT_NEW_SIGNAL', 'ESCALATION', 'RECOVERY', 'REDUNDANT', 'UNKNOWN',
]);

function cleanText(value) {
  return String(value ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function canonical(value) {
  return cleanText(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function hash(value, length = 32) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, length);
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') return Object.keys(value).sort().reduce((result, key) => {
    result[key] = stableValue(value[key]);
    return result;
  }, {});
  return value;
}

function stableStringify(value) {
  return JSON.stringify(stableValue(value));
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

function evidence(tier, id, type, label, reason, source = 'AppDynamics', timestamp = null, provenance = null) {
  return { tier, id, type, label, reason, source, timestamp: iso(timestamp), provenance };
}

function queriesFor(record) {
  const queries = [];
  const sourceQuery = record?.sources?.appDynamics?.query;
  (Array.isArray(sourceQuery) ? sourceQuery : [sourceQuery]).filter(Boolean).forEach((item) => queries.push(item));
  const evidenceQuery = record?.appDynamicsEvidence?.query;
  (Array.isArray(evidenceQuery) ? evidenceQuery : [evidenceQuery]).filter(Boolean).forEach((item) => queries.push(item));
  const seen = new Set();
  return queries.filter((item) => {
    const key = stableStringify({
      applicationId: item?.applicationId,
      windowStart: item?.windowStart,
      windowEnd: item?.windowEnd,
      rawRecordCount: item?.rawRecordCount,
      normalizedRecordCount: item?.normalizedRecordCount,
      rawIds: (item?.rawRecords || []).map((row) => row?.id || row?.eventId),
    });
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sourceRecordTimestamp(record) {
  return iso(record?.time || record?.timestamp || record?.eventTime || record?.startTime || record?.eventTimestamp || record?.metadata?.timestamp);
}

function sourceRecordType(record) {
  return cleanText(record?.recordType || record?.eventType || record?.type || record?.status || record?.name).toUpperCase();
}

function isMetricRecord(record) {
  const type = sourceRecordType(record);
  return type === 'METRIC' || type.includes('MONITORING_TELEMETRY')
    || Boolean(record?.metric && record?.value !== undefined)
    || Boolean(record?.metadata?.metric && record?.metadata?.value !== undefined);
}

function transitionFor(record, config = NOISE_APPDYNAMICS_DECISION_POLICY) {
  const text = [sourceRecordType(record), record?.title, record?.summary, record?.message,
    record?.eventMessage, record?.description, record?.name].filter(Boolean).join(' ').toUpperCase();
  if (config.recoveryEventStates.some((state) => text.includes(state))
    || /RECOVER|RETURN(?:ED)? TO NORMAL|CLEAR(?:ED)?|RESOLV(?:ED|ING)|ENDED/.test(text)) return 'RECOVERY';
  if (config.activeEventStates.some((state) => text.includes(state))
    || /VIOLAT|DEGRAD|PROBLEM|FAIL|ERROR|CRITICAL|WARN/.test(text)) return 'ACTIVE';
  return 'UNKNOWN';
}

function conditionFamily(value) {
  const text = canonical(value);
  if (/response time|latency|slow/.test(text)) return 'RESPONSE_TIME_DEGRADATION';
  if (/business transaction|\bbt\b/.test(text)) return 'BUSINESS_TRANSACTION_DEGRADATION';
  if (/database|\bdb\b|sql|jdbc/.test(text)) return 'DATABASE_DEGRADATION';
  if (/memory|heap|garbage collection|\bgc\b/.test(text)) return 'MEMORY_DEGRADATION';
  if (/\bcpu\b/.test(text)) return 'CPU_DEGRADATION';
  if (/node|machine agent|server health|host/.test(text)) return 'NODE_HEALTH_DEGRADATION';
  if (/error|exception|failure|failed/.test(text)) return 'ERROR_DEGRADATION';
  if (/load|calls per minute|throughput|volume/.test(text)) return 'LOAD_ANOMALY';
  if (/health rule|violation/.test(text)) return 'HEALTH_RULE_VIOLATION';
  return 'UNKNOWN';
}

function usefulWords(value) {
  const ignored = new Set(['appd', 'appdynamics', 'application', 'alert', 'critical', 'warning', 'high', 'normal', 'is', 'the', 'a', 'an', 'and', 'of', 'for', 'to']);
  return canonical(value).split(' ').filter((word) => word.length > 2 && !ignored.has(word));
}

function compatibleCondition(alert, sourceEvent) {
  const alertText = [alert?.alertCondition?.name, alert?.alertCondition?.healthRule, alert?.alertCondition?.metric, alert?.title].filter(Boolean).join(' ');
  const eventText = [sourceEvent?.healthRule, sourceEvent?.message, sourceEvent?.type].filter(Boolean).join(' ');
  const alertFamily = conditionFamily(alertText);
  const eventFamily = conditionFamily(eventText);
  if (alertFamily !== 'UNKNOWN' && eventFamily !== 'UNKNOWN') {
    if (alertFamily === eventFamily) return true;
    if (alertFamily === 'NODE_HEALTH_DEGRADATION' && /response time/.test(canonical(eventText))) return true;
    return false;
  }
  const sourceWords = new Set(usefulWords(eventText));
  return usefulWords(alertText).filter((word) => sourceWords.has(word)).length >= 2;
}

function compatibleEntity(alert, sourceEvent) {
  const required = cleanText(alert?.operationsIdentity?.businessTransaction || alert?.operationsIdentity?.node
    || alert?.operationsIdentity?.tier || alert?.sourceIdentity?.businessTransaction || alert?.sourceIdentity?.node || alert?.sourceIdentity?.tier);
  const actual = cleanText(sourceEvent?.businessTransaction || sourceEvent?.node || sourceEvent?.tier || sourceEvent?.entity);
  if (!actual) return false;
  if (required) {
    const left = canonical(required).replaceAll(' ', '');
    const right = canonical(actual).replaceAll(' ', '');
    return left === right || left.startsWith(right) || right.startsWith(left);
  }
  const application = canonical(alert?.sourceIdentity?.service || alert?.operationsIdentity?.service
    || alert?.application?.name || alert?.operationsIdentity?.application).replaceAll(' ', '');
  const entity = canonical(actual).replaceAll(' ', '');
  return Boolean(application && entity && (entity.startsWith(application) || application.startsWith(entity.replace(/\d+$/, ''))));
}

function normalizeSourceEvent(record, query, index) {
  if (!record || typeof record !== 'object' || isMetricRecord(record)) return null;
  const timestamp = sourceRecordTimestamp(record);
  if (!timestamp) return null;
  const metadata = record.metadata && typeof record.metadata === 'object' ? record.metadata : {};
  const type = sourceRecordType(record) || 'APPDYNAMICS_EVENT';
  const message = cleanText(record.summary || record.message || record.eventMessage || record.description || record.title || record.name);
  const affectedEntity = cleanText(record.affectedEntity || metadata.affectedEntity);
  const node = cleanText(record.node || record.nodeName || metadata.node || (/node/i.test(affectedEntity) ? affectedEntity.replace(/^node\s*[:=-]?\s*/i, '') : '')) || null;
  const tier = cleanText(record.tier || record.tierName || metadata.tier) || null;
  const businessTransaction = cleanText(record.businessTransaction || record.businessTransactionName || metadata.businessTransaction) || null;
  const entity = node || tier || businessTransaction || cleanText(record.entity || affectedEntity || metadata.entity) || null;
  return {
    id: cleanText(record.id || record.eventId || record.violationId || record.incidentId) || null,
    violationId: cleanText(record.violationId || record.incidentId || record.id) || null,
    applicationId: cleanText(record.applicationId || metadata.applicationId || query?.applicationId) || null,
    timestamp,
    type,
    transition: transitionFor(record),
    severity: cleanText(record.severity || record.eventSeverity || metadata.severity) || null,
    healthRule: cleanText(record.healthRule || record.healthRuleName || record.policy || record.policyName || metadata.healthRule) || null,
    node, tier, businessTransaction, entity, message,
    queryWindow: { from: iso(query?.windowStart), to: iso(query?.windowEnd) },
    provenance: { queryIndex: index.queryIndex, recordIndex: index.recordIndex },
  };
}

function mergeSourceEventGroup(records) {
  const sorted = [...records].sort((left, right) => toMs(left.timestamp) - toMs(right.timestamp) || String(left.id).localeCompare(String(right.id)));
  const first = sorted[0];
  const value = (field) => sorted.map((item) => item[field]).find(Boolean) || null;
  const transition = sorted.some((item) => item.transition === 'RECOVERY') && !sorted.some((item) => item.transition === 'ACTIVE')
    ? 'RECOVERY' : sorted.some((item) => item.transition === 'ACTIVE') ? 'ACTIVE' : 'UNKNOWN';
  return {
    ids: unique(sorted.map((item) => item.id)),
    violationIds: unique(sorted.map((item) => item.violationId)),
    applicationId: value('applicationId'),
    timestamp: first.timestamp,
    type: unique(sorted.map((item) => item.type)).join(' + '),
    transition,
    severity: value('severity'), healthRule: value('healthRule'), node: value('node'), tier: value('tier'),
    businessTransaction: value('businessTransaction'), entity: value('entity'),
    message: unique(sorted.map((item) => item.message)).join(' · '),
    queryWindow: first.queryWindow,
    recordCount: sorted.length,
    provenance: sorted.map((item) => item.provenance),
  };
}

function sourceEventGroups(record) {
  const rows = [];
  queriesFor(record).forEach((query, queryIndex) => {
    const records = Array.isArray(query.rawRecords) ? query.rawRecords
      : Array.isArray(query.normalizedRecords) ? query.normalizedRecords : [];
    records.forEach((item, recordIndex) => {
      const normalized = normalizeSourceEvent(item, query, { queryIndex, recordIndex });
      if (normalized) rows.push(normalized);
    });
  });
  const groups = [];
  rows.sort((left, right) => toMs(left.timestamp) - toMs(right.timestamp)).forEach((row) => {
    const previous = groups.at(-1);
    if (previous && previous[0].applicationId === row.applicationId && Math.abs(toMs(previous[0].timestamp) - toMs(row.timestamp)) <= 3000) previous.push(row);
    else groups.push([row]);
  });
  return groups.map(mergeSourceEventGroup);
}

function directEventFor(alert, operationalEvents) {
  return (operationalEvents?.events || []).find((event) => (event.notifications || []).some((item) => String(item.alertId) === String(alert.id))) || null;
}

function directNotificationFor(alert, event) {
  return (event?.notifications || []).find((item) => String(item.alertId) === String(alert.id)) || null;
}

function corroborationFor(record) {
  const jira = record?.sources?.jira || record?.jira || record?.appDynamicsEvidence?.jira;
  const slack = record?.sources?.slack || record?.slack || record?.appDynamicsEvidence?.slack;
  const jiraEvidence = (jira?.evidence || []).filter((item) => item?.type === 'confirmed_issue_relationship'
    || item?.metadata?.relationship === 'confirmed');
  const slackEvidence = (slack?.evidence || []).filter((item) => item?.metadata?.meaningfulAction === true
    && item?.metadata?.actorType === 'HUMAN');
  const slackContext = (slack?.evidence || []).filter((item) => !slackEvidence.includes(item));
  return { jiraEvidence, slackEvidence, slackContext };
}

function isBusinessTransactionAlert(alert) {
  return /business.?transaction|\bbt\b/i.test([alert?.title, alert?.alertCondition?.name].filter(Boolean).join(' '));
}

function buildFacts(alert, record, operationalEvents, config = NOISE_APPDYNAMICS_DECISION_POLICY) {
  const alertTime = toMs(alert.createdAt);
  const mappedApplicationId = cleanText(alert?.application?.id || alert?.mapping?.sourceEntityId || alert?.operationsIdentity?.applicationId);
  const candidates = sourceEventGroups(record).map((sourceEvent) => {
    const eventTime = toMs(sourceEvent.timestamp);
    const timeDeltaMs = alertTime === null || eventTime === null ? null : Math.abs(alertTime - eventTime);
    const appCompatible = Boolean(mappedApplicationId && sourceEvent.applicationId && mappedApplicationId === sourceEvent.applicationId);
    const timeCompatible = Number.isFinite(timeDeltaMs) && timeDeltaMs <= config.sourceEventCompatibilityMs;
    const entityCompatible = compatibleEntity(alert, sourceEvent);
    const conditionCompatible = compatibleCondition(alert, sourceEvent);
    const severityMeaningful = config.meaningfulSeverities.some((severity) => cleanText(sourceEvent.severity).toUpperCase().includes(severity));
    const valid = Boolean(
      alert?.mapping?.accepted
      && sourceEvent.ids.length
      && sourceEvent.applicationId
      && appCompatible
      && sourceEvent.entity
      && entityCompatible
      && sourceEvent.healthRule
      && conditionCompatible
      && sourceEvent.transition !== 'UNKNOWN'
      && severityMeaningful
      && timeCompatible
    );
    return { ...sourceEvent, timeDeltaMs, appCompatible, timeCompatible, entityCompatible, conditionCompatible, severityMeaningful, valid };
  }).sort((left, right) => Number(right.valid) - Number(left.valid) || (left.timeDeltaMs ?? Infinity) - (right.timeDeltaMs ?? Infinity));
  const sourceEvent = candidates[0] || null;
  const directEvent = directEventFor(alert, operationalEvents);
  const directNotification = directNotificationFor(alert, directEvent);
  const directTelemetry = Boolean(directEvent?.mapping?.accepted === true
    && directEvent?.telemetryValidation?.status === 'MATCHED'
    && directEvent?.telemetryValidation?.evidenceLevel === 'DIRECT'
    && directEvent?.startAt);
  const telemetryMismatch = directEvent?.telemetryValidation?.status === 'MISMATCHED';
  const btIdentity = cleanText(alert?.operationsIdentity?.businessTransaction || alert?.sourceIdentity?.businessTransaction || sourceEvent?.businessTransaction);
  const businessTransactionSafe = !isBusinessTransactionAlert(alert) || Boolean(btIdentity);
  return {
    sourceEvent, sourceCandidates: candidates, directEvent, directNotification, directTelemetry, telemetryMismatch,
    evidenceConflict: Boolean(sourceEvent?.valid && telemetryMismatch),
    corroboration: corroborationFor(record),
    businessTransactionSafe,
    acceptedMapping: Boolean(alert?.mapping?.accepted),
    mappingLevel: cleanText(alert?.mapping?.level).toUpperCase() || 'NONE',
  };
}

function severityRank(value) {
  const text = cleanText(value).toUpperCase();
  if (/P1|CRITICAL|FATAL/.test(text)) return 4;
  if (/P2|HIGH|ERROR/.test(text)) return 3;
  if (/P3|MEDIUM|WARN/.test(text)) return 2;
  return 1;
}

function isRecoveryNotification(item) {
  if (item.facts.sourceEvent?.transition === 'RECOVERY') return true;
  const recoveryAt = toMs(item.facts.directEvent?.recoveryAt);
  const notificationAt = toMs(item.alert.createdAt);
  return recoveryAt !== null && notificationAt !== null && notificationAt >= recoveryAt;
}

function assignRoles(items) {
  const grouped = new Map();
  items.forEach((item) => {
    const directEventId = item.facts.directEvent?.eventId;
    const sourceIds = item.facts.sourceEvent?.ids || [];
    const key = directEventId || (sourceIds.length ? `source:${sourceIds.slice().sort().join('|')}` : null);
    if (!key) return;
    const records = grouped.get(key) || [];
    records.push(item);
    grouped.set(key, records);
  });
  items.forEach((item) => {
    item.notificationRole = 'UNKNOWN';
    item.eventGroup = [];
    item.eventKey = null;
    item.representativeAlertId = null;
    item.repeatedRecovery = false;
  });
  grouped.forEach((records, key) => {
    records.sort((left, right) => toMs(left.alert.createdAt) - toMs(right.alert.createdAt) || String(left.alert.id).localeCompare(String(right.alert.id)));
    const representative = records.find((item) => item.facts.directNotification?.representative === true)
      || records.find((item) => !isRecoveryNotification(item)) || records[0];
    let recoverySeen = false;
    records.forEach((item) => {
      item.eventGroup = records;
      item.eventKey = key;
      item.representativeAlertId = String(representative.alert.id);
      if (isRecoveryNotification(item)) {
        item.repeatedRecovery = recoverySeen;
        item.notificationRole = recoverySeen ? 'REDUNDANT' : 'RECOVERY';
        recoverySeen = true;
        return;
      }
      const direct = item.facts.directNotification;
      if (String(item.alert.id) === String(representative.alert.id)) item.notificationRole = 'REPRESENTATIVE';
      else if ((direct?.distinctInformation || []).includes('MATERIAL_ESCALATION')
        || severityRank(item.alert.priority || item.alert.severity) > severityRank(representative.alert.priority || representative.alert.severity)) item.notificationRole = 'ESCALATION';
      else if ((direct?.distinctInformation || []).some((value) => value !== 'REPRESENTATIVE_SIGNAL')) item.notificationRole = 'DISTINCT_NEW_SIGNAL';
      else item.notificationRole = 'REDUNDANT';
    });
  });
  return items;
}

function reviewReason(facts) {
  if (!facts.businessTransactionSafe) return ['BT_IDENTITY_UNAVAILABLE', 'The alert names a Business Transaction condition without an exact Business Transaction identity.'];
  if (!facts.acceptedMapping) return ['MAPPING_NOT_ACCEPTED', 'No exact, strong, or locally confirmed AppDynamics identity mapping is available.'];
  if (facts.evidenceConflict) return ['CONFLICTING_SOURCE_EVIDENCE', 'Source-native event evidence and direct telemetry validation conflict for this notification.'];
  if (facts.sourceEvent && !facts.sourceEvent.timeCompatible) return ['SOURCE_EVENT_TIMESTAMP_MISMATCH', 'The available AppDynamics event is outside the notification compatibility window.'];
  if (facts.sourceEvent && !facts.sourceEvent.entityCompatible) return ['SOURCE_EVENT_ENTITY_MISMATCH', 'The AppDynamics event entity does not match the notification identity.'];
  if (facts.sourceEvent && !facts.sourceEvent.conditionCompatible) return ['SOURCE_EVENT_CONDITION_MISMATCH', 'The AppDynamics health rule or condition does not match the notification condition.'];
  if (facts.telemetryMismatch) return ['TELEMETRY_SEMANTIC_MISMATCH', 'Returned telemetry does not match the alert condition and was rejected.'];
  if (!facts.sourceEvent && !facts.directEvent) return ['NO_SOURCE_EVIDENCE', 'No source-native event or validated direct telemetry is available in the bounded window.'];
  if (!facts.sourceEvent?.ids?.length) return ['SOURCE_EVENT_ID_MISSING', 'The source event does not provide a stable event or violation identifier.'];
  if (!facts.sourceEvent?.healthRule) return ['HEALTH_RULE_MISSING', 'The source-native event chain does not identify the triggering health rule or policy.'];
  if (!facts.sourceEvent?.entity) return ['SOURCE_ENTITY_MISSING', 'The source-native event chain does not identify the affected entity.'];
  return ['EVIDENCE_CHAIN_INCOMPLETE', 'The source evidence chain is incomplete for an automatic incident or noise decision.'];
}

function evaluateItem(item, config = NOISE_APPDYNAMICS_DECISION_POLICY, evaluatedAt = new Date().toISOString()) {
  const { alert, facts, notificationRole } = item;
  const sourceConfirmed = facts.sourceEvent?.valid === true;
  const directConfirmed = facts.directTelemetry === true;
  const sourceDecisionEligible = sourceConfirmed && facts.businessTransactionSafe;
  const directDecisionEligible = directConfirmed && facts.businessTransactionSafe;
  const realEventStatus = sourceConfirmed || directConfirmed ? 'CONFIRMED' : 'UNKNOWN';
  const evidenceUsed = [];
  const evidenceMissing = [];
  const evidenceRejected = [];
  if (sourceConfirmed) {
    evidenceUsed.push(evidence('A', `appd-source-${hash(facts.sourceEvent.ids.join('|'))}`, 'SOURCE_NATIVE_EVENT',
      'AppDynamics event chain', `Event ${facts.sourceEvent.ids.join(', ')} identifies application ${facts.sourceEvent.applicationId}, entity ${facts.sourceEvent.entity}, health rule ${facts.sourceEvent.healthRule}, ${facts.sourceEvent.transition.toLowerCase()} state, severity ${facts.sourceEvent.severity}, and a compatible timestamp.`,
      'AppDynamics', facts.sourceEvent.timestamp, { eventIds: facts.sourceEvent.ids, violationIds: facts.sourceEvent.violationIds }));
  } else {
    evidenceMissing.push(evidence('A', 'appd-source-chain-missing', 'SOURCE_NATIVE_EVENT', 'Complete AppDynamics event chain',
      'A compatible source event ID, application, entity, health rule, active/recovery state, severity, and timestamp were not all proven.'));
    (facts.sourceCandidates || []).slice(0, 2).forEach((candidate, index) => evidenceRejected.push(evidence('A', `appd-source-rejected-${index}`,
      'SOURCE_NATIVE_EVENT', 'Rejected AppDynamics event candidate', unique([
        !candidate.timeCompatible ? 'timestamp mismatch' : null,
        !candidate.appCompatible ? 'application mismatch' : null,
        !candidate.entityCompatible ? 'entity mismatch' : null,
        !candidate.conditionCompatible ? 'condition mismatch' : null,
        !candidate.severityMeaningful ? 'meaningful severity missing' : null,
        !candidate.healthRule ? 'health rule missing' : null,
        !candidate.ids.length ? 'event ID missing' : null,
      ]).join(', ') || 'source chain incomplete', 'AppDynamics', candidate.timestamp, { eventIds: candidate.ids })));
  }
  if (directConfirmed) {
    evidenceUsed.push(evidence('B', `appd-direct-${facts.directEvent.eventId}`, 'DIRECT_TELEMETRY', 'Entity-scoped direct telemetry',
      `${facts.directEvent.telemetryValidation.expectedIntent || 'Requested'} telemetry matched the alert condition with ${facts.directEvent.telemetryValidation.matchedRecords || 0} matched record(s).`,
      'AppDynamics', facts.directEvent.startAt, { eventId: facts.directEvent.eventId }));
  } else if (facts.telemetryMismatch) {
    evidenceRejected.push(evidence('B', `appd-direct-mismatch-${facts.directEvent?.eventId || alert.id}`, 'DIRECT_TELEMETRY',
      'Rejected telemetry', 'Telemetry semantics did not match the alert condition; the records cannot support an automatic decision.', 'AppDynamics', facts.directEvent?.startAt));
  } else {
    evidenceMissing.push(evidence('B', 'appd-direct-telemetry-missing', 'DIRECT_TELEMETRY', 'Validated direct telemetry',
      'No entity-scoped direct telemetry matched the requested condition in the evidence window.'));
  }
  (facts.corroboration?.jiraEvidence || []).slice(0, 3).forEach((item, index) => evidenceUsed.push(evidence('C', item.id || `jira-corroboration-${index}`,
    'CORROBORATION', 'Confirmed Jira relationship', 'Jira contains an exact alert-number or issue-key relationship. This supports, but does not replace, AppDynamics source proof.',
    'ACC Jira', item.timestamp, { issueKey: item.metadata?.issueKey || null })));
  (facts.corroboration?.slackEvidence || []).slice(0, 3).forEach((item, index) => evidenceUsed.push(evidence('C', item.id || `slack-corroboration-${index}`,
    'CORROBORATION', 'Meaningful human remediation in Slack', 'A human remediation action references the exact alert. This supports, but does not replace, AppDynamics source proof.',
    'Slack', item.timestamp, { messageId: item.metadata?.messageId || null })));
  (facts.corroboration?.slackContext || []).slice(0, 3).forEach((item, index) => evidenceRejected.push(evidence('D', item.id || `slack-context-${index}`,
    'CONTEXT_ONLY', 'Slack discussion / acknowledgement', 'Slack acknowledgement, automation, or discussion is context only and cannot prove the monitored condition.',
    'Slack', item.timestamp, { messageId: item.metadata?.messageId || null })));
  evidenceRejected.push(evidence('D', `operations-priority-${alert.id}`, 'CONTEXT_ONLY', 'Operations priority / monitoring severity',
    'Priority and severity describe urgency but cannot prove that the source event is real or that a notification is noise.', 'JSM Operations', alert.createdAt));
  if (/acknowledg/i.test(cleanText(alert.status))) evidenceRejected.push(evidence('D', `operations-ack-${alert.id}`, 'CONTEXT_ONLY',
    'Acknowledgement', 'Acknowledgement is operator context only and is not source evidence of the monitored condition.', 'JSM Operations', alert.createdAt));

  let rule = config.rules.needsReview;
  let decision = 'NEEDS_REVIEW';
  let subtype = 'EVIDENCE_GAP';
  const noiseProof = evaluatePositiveNoiseProof(item, config, evaluatedAt);
  if (noiseProof) {
    rule = { id: noiseProof.ruleId, version: noiseProof.ruleVersion, description: noiseProof.reasoning };
    decision = 'NOISE';
    subtype = noiseProof.subtype;
  } else if (sourceDecisionEligible && !facts.evidenceConflict && notificationRole !== 'UNKNOWN') {
    rule = config.rules.sourceNativeIncident;
    decision = 'INCIDENT';
    subtype = notificationRole === 'RECOVERY' ? 'RECOVERY_SIGNAL'
      : notificationRole === 'ESCALATION' ? 'MATERIAL_ESCALATION'
        : notificationRole === 'DISTINCT_NEW_SIGNAL' ? 'DISTINCT_NEW_SIGNAL' : 'SOURCE_NATIVE_VIOLATION';
  } else if (directDecisionEligible && !facts.evidenceConflict && notificationRole !== 'UNKNOWN') {
    rule = config.rules.directTelemetryIncident;
    decision = 'INCIDENT';
    subtype = notificationRole === 'RECOVERY' ? 'RECOVERY_SIGNAL' : 'DIRECT_TELEMETRY_DEGRADATION';
  }
  const [reviewCode, reviewText] = decision === 'NEEDS_REVIEW' ? reviewReason(facts) : [null, null];
  if (decision === 'NEEDS_REVIEW') subtype = reviewCode;
  const confidence = noiseProof?.confidence || (decision === 'NEEDS_REVIEW' ? 'LOW'
    : facts.mappingLevel === 'EXACT' || facts.mappingLevel === 'CONFIRMED_LOCAL' ? 'HIGH' : 'MEDIUM');
  const reasoning = decision === 'INCIDENT'
    ? `${rule.description} Notification role: ${notificationRole.toLowerCase().replaceAll('_', ' ')}.`
    : decision === 'NOISE'
      ? noiseProof.reasoning
      : `${reviewText} The policy did not use confidence, priority, acknowledgement, Jira, or Slack context as a substitute for missing source proof.`;
  const decisionInput = {
    alertId: alert.id, alertNumber: alert.alertNumber, mappingLevel: facts.mappingLevel,
    sourceEvent: facts.sourceEvent ? {
      ids: facts.sourceEvent.ids, applicationId: facts.sourceEvent.applicationId, timestamp: facts.sourceEvent.timestamp,
      entity: facts.sourceEvent.entity, healthRule: facts.sourceEvent.healthRule, transition: facts.sourceEvent.transition,
      severity: facts.sourceEvent.severity, valid: facts.sourceEvent.valid,
    } : null,
    directEvent: facts.directEvent ? {
      eventId: facts.directEvent.eventId, state: facts.directEvent.state, startAt: facts.directEvent.startAt,
      validation: facts.directEvent.telemetryValidation, sourceNonActionable: facts.directEvent.sourceNonActionable,
    } : null,
    businessTransactionSafe: facts.businessTransactionSafe, notificationRole,
    noiseProof: noiseProof ? {
      subtype: noiseProof.subtype,
      underlyingEvent: noiseProof.underlyingEvent,
      distinctInformationCheck: noiseProof.distinctInformationCheck,
    } : null,
    policyVersion: config.policyVersion,
  };
  return {
    decision, subtype, confidence, ruleId: rule.id, ruleVersion: rule.version, policyVersion: config.policyVersion,
    realEventStatus, notificationRole, evidenceUsed, evidenceMissing, evidenceRejected, reasoning,
    noiseProof,
    evaluatedAt, decisionInputVersion: hash(stableStringify(decisionInput)),
  };
}

function previousDecisionFor(alert) {
  if (alert?.classification === 'USEFUL_ACTIONABLE_SIGNAL') return 'INCIDENT';
  if (['REDUNDANT_REAL_EVENT_NOTIFICATION', 'NON_ACTIONABLE_NOISE'].includes(alert?.classification)) return 'NOISE';
  return 'NEEDS_REVIEW';
}

function decisionCounts(items) {
  const counts = { total: items.length, incident: 0, noise: 0, needsReview: 0 };
  items.forEach((item) => {
    if (item === 'INCIDENT') counts.incident += 1;
    else if (item === 'NOISE') counts.noise += 1;
    else counts.needsReview += 1;
  });
  counts.automaticCoveragePercentage = counts.total ? Number(((counts.incident + counts.noise) / counts.total * 100).toFixed(1)) : 0;
  counts.humanReviewRatePercentage = counts.total ? Number((counts.needsReview / counts.total * 100).toFixed(1)) : 0;
  counts.reconciliation = counts.incident + counts.noise + counts.needsReview === counts.total;
  return counts;
}

function buildEventGroups(work, evaluations) {
  const groups = new Map();
  work.forEach((item, index) => {
    if (!item.eventKey) return;
    const records = groups.get(item.eventKey) || [];
    records.push({ item, evaluation: evaluations[index] });
    groups.set(item.eventKey, records);
  });
  return [...groups.entries()].map(([eventId, records]) => {
    const representative = records.find(({ item }) => String(item.alert.id) === String(item.representativeAlertId)) || records[0];
    const notifications = records.map(({ item, evaluation }) => ({
      alertId: String(item.alert.id), alertNumber: item.alert.alertNumber || null,
      title: item.alert.title || null, createdAt: item.alert.createdAt || null,
      role: evaluation.notificationRole, decision: evaluation.decision,
      subtype: evaluation.subtype, confidence: evaluation.confidence,
      representative: String(item.alert.id) === String(representative.item.alert.id),
    }));
    return {
      eventId,
      underlyingEventConfirmed: records.some(({ evaluation }) => evaluation.realEventStatus === 'CONFIRMED'),
      representative: notifications.find((item) => item.representative) || notifications[0],
      additionalNotifications: notifications.filter((item) => !item.representative),
      incidentNotifications: notifications.filter((item) => item.decision === 'INCIDENT').length,
      noiseNotifications: notifications.filter((item) => item.decision === 'NOISE').length,
      needsReviewNotifications: notifications.filter((item) => item.decision === 'NEEDS_REVIEW').length,
      representativeIncidentPreserved: notifications.some((item) => item.representative && item.decision === 'INCIDENT'),
    };
  }).sort((left, right) => right.noiseNotifications - left.noiseNotifications
    || right.additionalNotifications.length - left.additionalNotifications.length
    || left.eventId.localeCompare(right.eventId));
}

function safeEvaluation(value) {
  return JSON.parse(JSON.stringify(value, (key, item) => /token|secret|password|credential|authorization|cookie|rawPayload/i.test(key) ? '[REDACTED]' : item));
}

function createDecisionAuditStore({ database = db } = {}) {
  let readyPromise = null;
  const ensure = () => {
    if (!readyPromise) readyPromise = database.query(`
      CREATE TABLE IF NOT EXISTS noise_appdynamics_decision_audit (
        evaluation_id TEXT PRIMARY KEY,
        alert_id TEXT NOT NULL,
        alert_number TEXT,
        policy_version TEXT NOT NULL,
        input_version TEXT NOT NULL,
        decision TEXT NOT NULL,
        rule_id TEXT NOT NULL,
        rule_version TEXT NOT NULL,
        confidence TEXT NOT NULL,
        previous_decision TEXT,
        reason_for_change TEXT NOT NULL,
        evaluation_json JSONB NOT NULL,
        evaluated_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `).then(() => database.query(`CREATE INDEX IF NOT EXISTS noise_appd_decision_alert_time_idx
      ON noise_appdynamics_decision_audit(alert_id, evaluated_at DESC)`)).catch((error) => { readyPromise = null; throw error; });
    return readyPromise;
  };
  const prepare = (alert, evaluation, previous) => {
    const evaluationId = `appd_dec_${hash(`${alert.id}|${evaluation.policyVersion}|${evaluation.decisionInputVersion}`)}`;
    const previousDecision = previous?.decision || null;
    const reasonForChange = !previous ? 'INITIAL_POLICY_EVALUATION'
      : previous.input_version === evaluation.decisionInputVersion ? 'UNCHANGED_EVIDENCE_REPLAY'
        : previous.decision !== evaluation.decision ? 'DECISION_CHANGED_AFTER_EVIDENCE_UPDATE'
          : previous.rule_id !== evaluation.ruleId || previous.rule_version !== evaluation.ruleVersion ? 'RULE_VERSION_CHANGED'
            : 'EVIDENCE_UPDATED_DECISION_UNCHANGED';
    const audited = { ...evaluation, audit: { evaluationId, previousDecision, newDecision: evaluation.decision, reasonForChange } };
    return {
      evaluationId, alertId: String(alert.id), alertNumber: alert.alertNumber || null,
      policyVersion: evaluation.policyVersion, inputVersion: evaluation.decisionInputVersion,
      decision: evaluation.decision, ruleId: evaluation.ruleId, ruleVersion: evaluation.ruleVersion,
      confidence: evaluation.confidence, previousDecision, reasonForChange,
      evaluationJson: safeEvaluation(audited), evaluatedAt: evaluation.evaluatedAt, audited,
    };
  };
  return {
    async latest(alertIds = []) {
      if (!alertIds.length) return new Map();
      await ensure();
      const result = await database.query(`SELECT DISTINCT ON (alert_id) alert_id, decision, rule_id, rule_version,
        policy_version, input_version, evaluation_json, evaluated_at
        FROM noise_appdynamics_decision_audit WHERE alert_id = ANY($1::text[])
        ORDER BY alert_id, evaluated_at DESC, created_at DESC`, [alertIds.map(String)]);
      return new Map(result.rows.map((row) => [String(row.alert_id), row]));
    },
    async save(alert, evaluation, previous) {
      await ensure();
      const row = prepare(alert, evaluation, previous);
      await database.query(`INSERT INTO noise_appdynamics_decision_audit
        (evaluation_id,alert_id,alert_number,policy_version,input_version,decision,rule_id,rule_version,confidence,
         previous_decision,reason_for_change,evaluation_json,evaluated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13)
        ON CONFLICT (evaluation_id) DO NOTHING`, [row.evaluationId, row.alertId, row.alertNumber,
        row.policyVersion, row.inputVersion, row.decision, row.ruleId, row.ruleVersion, row.confidence,
        row.previousDecision, row.reasonForChange, JSON.stringify(row.evaluationJson), row.evaluatedAt]);
      return row.audited;
    },
    async saveMany(alerts, evaluations, previousById) {
      await ensure();
      const rows = alerts.map((alert, index) => prepare(alert, evaluations[index], previousById.get(String(alert.id))));
      if (!rows.length) return [];
      await database.query(`INSERT INTO noise_appdynamics_decision_audit
        (evaluation_id,alert_id,alert_number,policy_version,input_version,decision,rule_id,rule_version,confidence,
         previous_decision,reason_for_change,evaluation_json,evaluated_at)
        SELECT evaluation_id,alert_id,alert_number,policy_version,input_version,decision,rule_id,rule_version,confidence,
          previous_decision,reason_for_change,evaluation_json,evaluated_at
        FROM jsonb_to_recordset($1::jsonb) AS record(
          evaluation_id TEXT, alert_id TEXT, alert_number TEXT, policy_version TEXT, input_version TEXT,
          decision TEXT, rule_id TEXT, rule_version TEXT, confidence TEXT, previous_decision TEXT,
          reason_for_change TEXT, evaluation_json JSONB, evaluated_at TIMESTAMPTZ)
        ON CONFLICT (evaluation_id) DO NOTHING`, [JSON.stringify(rows.map((row) => ({
        evaluation_id: row.evaluationId, alert_id: row.alertId, alert_number: row.alertNumber,
        policy_version: row.policyVersion, input_version: row.inputVersion, decision: row.decision,
        rule_id: row.ruleId, rule_version: row.ruleVersion, confidence: row.confidence,
        previous_decision: row.previousDecision, reason_for_change: row.reasonForChange,
        evaluation_json: row.evaluationJson, evaluated_at: row.evaluatedAt,
      })))]);
      return rows.map((row) => row.audited);
    },
    async history(alertId, limit = 50) {
      await ensure();
      const result = await database.query(`SELECT evaluation_json FROM noise_appdynamics_decision_audit
        WHERE alert_id=$1 ORDER BY evaluated_at DESC, created_at DESC LIMIT $2`, [String(alertId), Math.max(1, Math.min(200, Number(limit) || 50))]);
      return result.rows.map((row) => row.evaluation_json);
    },
    async historicalNoiseContext(days = 90) {
      await ensure();
      const boundedDays = Math.max(1, Math.min(365, Number(days) || 90));
      const result = await database.query(`SELECT DISTINCT ON (alert_id) evaluation_json
        FROM noise_appdynamics_decision_audit
        WHERE decision='NOISE' AND evaluated_at >= NOW() - ($1::int * INTERVAL '1 day')
        ORDER BY alert_id, evaluated_at DESC, created_at DESC`, [boundedDays]);
      const provenRedundancy = result.rows.map((row) => row.evaluation_json).filter((item) => item?.noiseProof
        && ['REDUNDANT_REAL_EVENT', 'EXACT_DUPLICATE_NOTIFICATION', 'FLAPPING_NOTIFICATION',
          'REPEATED_RECOVERY_NOTIFICATION'].includes(item.noiseProof.subtype));
      const patterns = new Map();
      provenRedundancy.forEach((item) => {
        const key = item.noiseProof.pattern || item.noiseProof.underlyingEvent?.eventId || item.noiseProof.subtype;
        const record = patterns.get(key) || { pattern: key, notifications: 0, subtypes: new Set(), lastEvaluatedAt: null };
        record.notifications += 1;
        record.subtypes.add(item.noiseProof.subtype);
        if (!record.lastEvaluatedAt || toMs(item.evaluatedAt) > toMs(record.lastEvaluatedAt)) record.lastEvaluatedAt = item.evaluatedAt;
        patterns.set(key, record);
      });
      return {
        window: `${boundedDays}d`, label: 'Historical context only — never used alone for automatic classification',
        provenRedundantNotifications: provenRedundancy.length,
        patterns: [...patterns.values()].map((item) => ({ ...item, subtypes: [...item.subtypes] }))
          .sort((left, right) => right.notifications - left.notifications).slice(0, 20),
      };
    },
  };
}

function createNoiseAppDynamicsDecisionPolicyService({
  config = NOISE_APPDYNAMICS_DECISION_POLICY,
  store = null,
  now = () => Date.now(),
} = {}) {
  const persistence = store || createDecisionAuditStore();

  async function evaluatePopulation({ alerts = [], packages = [], operationalEvents = null } = {}) {
    const evaluatedAt = new Date(now()).toISOString();
    const packagesById = new Map(packages.map((item) => [String(item.alertId), item]));
    const work = alerts.map((alert) => ({
      alert,
      facts: buildFacts(alert, packagesById.get(String(alert.id)), operationalEvents, config),
      notificationRole: 'UNKNOWN',
    }));
    assignRoles(work);
    const evaluations = work.map((item) => evaluateItem(item, config, evaluatedAt));
    let persisted = true;
    let persistenceError = null;
    try {
      const previous = await persistence.latest(alerts.map((alert) => alert.id));
      if (typeof persistence.saveMany === 'function') {
        const saved = await persistence.saveMany(alerts, evaluations, previous);
        saved.forEach((item, index) => { evaluations[index] = item; });
      } else {
        for (let index = 0; index < alerts.length; index += 1) {
          evaluations[index] = await persistence.save(alerts[index], evaluations[index], previous.get(String(alerts[index].id)));
        }
      }
    } catch (error) {
      persisted = false;
      persistenceError = cleanText(error.safeMessage || error.message || 'Decision audit persistence is unavailable.');
    }
    let historicalNoiseContext = {
      window: '90d', label: 'Historical context only — never used alone for automatic classification',
      provenRedundantNotifications: 0, patterns: [],
    };
    try {
      if (typeof persistence.historicalNoiseContext === 'function') historicalNoiseContext = await persistence.historicalNoiseContext(90);
    } catch { /* Historical context is advisory and never changes the current decision. */ }
    const enrichedAlerts = alerts.map((alert, index) => ({ ...alert, decisionPolicy: evaluations[index] }));
    const before = decisionCounts(alerts.map(previousDecisionFor));
    const after = decisionCounts(evaluations.map((item) => item.decision));
    const byRule = new Map();
    const bySubtype = new Map();
    const reviewReasons = new Map();
    evaluations.forEach((item) => {
      byRule.set(item.ruleId, Number(byRule.get(item.ruleId) || 0) + 1);
      bySubtype.set(item.subtype, Number(bySubtype.get(item.subtype) || 0) + 1);
      if (item.decision === 'NEEDS_REVIEW') reviewReasons.set(item.subtype, Number(reviewReasons.get(item.subtype) || 0) + 1);
    });
    const automatic = evaluations.filter((item) => item.decision !== 'NEEDS_REVIEW');
    const unsupported = automatic.filter((item) => !item.ruleId || item.ruleId === config.rules.needsReview.id || !item.evidenceUsed.length);
    const deterministicRuleCount = automatic.filter((item) => item.ruleId && item.ruleId !== config.rules.needsReview.id).length;
    const evidenceProvenanceCount = automatic.filter((item) => item.evidenceUsed.some((entry) => ['A', 'B'].includes(entry.tier))).length;
    const eventGroups = buildEventGroups(work, evaluations);
    const noiseEvaluations = evaluations.filter((item) => item.decision === 'NOISE');
    const consolidatableSubtypes = new Set(['REDUNDANT_REAL_EVENT', 'EXACT_DUPLICATE_NOTIFICATION',
      'FLAPPING_NOTIFICATION', 'REPEATED_RECOVERY_NOTIFICATION']);
    const potentiallyConsolidatable = noiseEvaluations.filter((item) => consolidatableSubtypes.has(item.subtype)
      && ['HIGH', 'MEDIUM'].includes(item.confidence)
      && eventGroups.some((group) => group.representativeIncidentPreserved
        && group.additionalNotifications.some((notification) => notification.alertId === item.noiseProof?.alertId))).length;
    const absenceOnlyNoise = noiseEvaluations.filter((item) => !(item.noiseProof?.evidenceUsed || []).some((entry) => ['A', 'B'].includes(entry.tier))).length;
    const lowConfidenceNoise = noiseEvaluations.filter((item) => item.confidence === 'LOW').length;
    const representativeIncidentSuppressed = eventGroups.filter((group) => group.noiseNotifications > 0
      && group.additionalNotifications.length > 0 && !group.representativeIncidentPreserved).length;
    return {
      alerts: enrichedAlerts,
      summary: {
        phase: config.phase, policyVersion: config.policyVersion, evaluatedAt, before, after,
        byRule: [...byRule.entries()].map(([ruleId, count]) => ({ ruleId, count })).sort((left, right) => right.count - left.count),
        bySubtype: [...bySubtype.entries()].map(([subtype, count]) => ({ subtype, count })).sort((left, right) => right.count - left.count),
        reviewReasons: [...reviewReasons.entries()].map(([reason, count]) => ({ reason, count })).sort((left, right) => right.count - left.count),
        noiseBreakdown: [...bySubtype.entries()].filter(([subtype]) => noiseEvaluations.some((item) => item.subtype === subtype))
          .map(([subtype, count]) => ({ subtype, count })).sort((left, right) => right.count - left.count),
        eventGroups,
        historicalNoiseContext,
        impact: {
          automaticNoiseCoveragePercentage: after.total ? Number((after.noise / after.total * 100).toFixed(1)) : 0,
          humanReviewRatePercentage: after.humanReviewRatePercentage,
          potentiallyConsolidatable,
          representativeIncidentsPreserved: eventGroups.filter((group) => group.noiseNotifications > 0
            && group.representativeIncidentPreserved).length,
        },
        safety: {
          unsupportedAutomaticDecisions: unsupported.length,
          automaticDecisions: automatic.length,
          automaticDecisionsWithDeterministicRule: deterministicRuleCount,
          automaticDecisionsWithDeterministicRulePercentage: automatic.length ? Number((deterministicRuleCount / automatic.length * 100).toFixed(1)) : 100,
          automaticDecisionsWithEvidenceProvenance: evidenceProvenanceCount,
          automaticDecisionsWithEvidenceProvenancePercentage: automatic.length ? Number((evidenceProvenanceCount / automatic.length * 100).toFixed(1)) : 100,
          everyAlertHasExactlyOneDecision: evaluations.length === alerts.length && evaluations.every((item) => DECISIONS.includes(item.decision)),
          validEventStates: evaluations.every((item) => EVENT_STATES.includes(item.realEventStatus)),
          validNotificationRoles: evaluations.every((item) => NOTIFICATION_ROLES.includes(item.notificationRole)),
          sourceNativeOrDirectEvidenceRequired: unsupported.length === 0,
          deterministicNoiseRulePercentage: noiseEvaluations.length
            ? Number((noiseEvaluations.filter((item) => item.ruleId?.startsWith('APPD_NOISE_')).length / noiseEvaluations.length * 100).toFixed(1)) : 100,
          noiseEvidenceProvenancePercentage: noiseEvaluations.length
            ? Number((noiseEvaluations.filter((item) => (item.noiseProof?.evidenceUsed || []).some((entry) => ['A', 'B'].includes(entry.tier))).length / noiseEvaluations.length * 100).toFixed(1)) : 100,
          absenceOnlyNoiseDecisions: absenceOnlyNoise,
          lowConfidenceAutomaticNoise: lowConfidenceNoise,
          representativeIncidentsAccidentallySuppressed: representativeIncidentSuppressed,
          confidenceIsNotDecisionLogic: true,
          externalMutations: 'none', aiUsed: false, automaticSuppression: 'none', scoreChanges: 'none',
        },
        persistence: { appendOnly: true, status: persisted ? 'SAVED' : 'UNAVAILABLE', error: persistenceError },
      },
    };
  }

  async function history(alertId, limit) {
    return persistence.history(alertId, limit);
  }

  return { evaluatePopulation, history };
}

module.exports = {
  DECISIONS,
  EVENT_STATES,
  NOTIFICATION_ROLES,
  assignRoles,
  buildFacts,
  conditionFamily,
  createDecisionAuditStore,
  createNoiseAppDynamicsDecisionPolicyService,
  evaluateItem,
  service: createNoiseAppDynamicsDecisionPolicyService(),
  sourceEventGroups,
};
