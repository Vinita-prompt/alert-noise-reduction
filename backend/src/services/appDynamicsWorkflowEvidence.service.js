const { APPDYNAMICS_WORKFLOW_POLICY } = require('../config/appDynamicsWorkflowPolicy');

function cleanText(value) {
  return String(value ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function canonical(value) {
  return cleanText(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function unique(values) {
  return [...new Set(values.filter(Boolean).map(cleanText).filter(Boolean))];
}

function toMs(value) {
  const parsed = value ? new Date(value).getTime() : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function toIso(value) {
  const milliseconds = toMs(value);
  return milliseconds === null ? null : new Date(milliseconds).toISOString();
}

function conditionFamily(value) {
  const text = canonical(value);
  if (/response time|latency|duration|slow/.test(text)) return 'RESPONSE_TIME';
  if (/error|exception|failure|failed/.test(text)) return 'ERROR_RATE';
  if (/calls per minute|calls min|throughput|traffic|\bload\b/.test(text)) return 'CALLS_LOAD';
  if (/\bcpu\b|processor/.test(text)) return 'CPU';
  if (/memory|heap|garbage collection|\bgc\b/.test(text)) return 'MEMORY';
  if (/business transaction|\bbt\b/.test(text)) return 'BUSINESS_TRANSACTION';
  if (/database|\bdb\b|sql|connection pool|remote service/.test(text)) return 'DATABASE';
  if (/node|jvm|machine|process/.test(text)) return 'NODE_HEALTH';
  if (/health rule|violation/.test(text)) return 'HEALTH_RULE_EVENT';
  return 'GENERAL_HEALTH';
}

function entityLevel(value) {
  const text = canonical(value);
  if (/database|\bdb\b|sql|connection pool|remote service/.test(text)) return 'DATABASE';
  if (/business transaction|\bbt\b/.test(text)) return 'BUSINESS_TRANSACTION';
  if (/\bnode\b|jvm|machine/.test(text)) return 'NODE';
  if (/\btier\b/.test(text)) return 'TIER';
  return 'APPLICATION';
}

function extractNamed(text, label) {
  const source = cleanText(text);
  const patterns = {
    node: /\b(?:For\s+)?Node\s+([a-z0-9_.:-]+)/i,
    tier: /\bTier\s+([a-z0-9_.:-]+)/i,
    businessTransaction: /\bBusiness Transaction\s+["']?([^,"']+?)(?:\s+(?:is|has|was|continues)\b|[.,;]|$)/i,
    database: /\bDatabase\s+["']?([^,"']+?)(?:\s+(?:is|has|was|continues)\b|[.,;]|$)/i,
  };
  return cleanText(source.match(patterns[label])?.[1]) || null;
}

function extractHealthRule(text) {
  const source = cleanText(text);
  const match = source.match(/\bHealth Rule\s+["']?(.+?)["']?\s+(?:has violated|continues to violate|is violating|was violated|recovered|returned to normal|cleared)\b/i);
  return cleanText(match?.[1]) || null;
}

function extractPolicy(text) {
  const source = cleanText(text);
  const match = source.match(/\bPolicy\s+["']?(.+?)["']?\s+(?:triggered|executed|opened|closed|for\b|[.;]|$)/i);
  return cleanText(match?.[1]) || null;
}

function normalizedRecord(record = {}, fallback = {}) {
  const semantic = record.semantic || record.metadata?.semantic || {};
  const metadata = record.metadata || {};
  const summary = cleanText(record.summary || record.message || record.description);
  const title = cleanText(record.title || record.metric || record.name || 'AppDynamics evidence');
  const text = [title, summary, record.transition, semantic.eventType, metadata.state, metadata.healthRule].filter(Boolean).join(' ');
  const sourceState = cleanText(semantic.eventType || metadata.eventType || metadata.state).toUpperCase();
  const recovery = /recover|resolved|cleared|returned to normal|back to normal/i.test(text)
    || /RECOVER|RESOLVED|CLOSED|CLEAR/.test(sourceState)
    || String(record.transition || '').toUpperCase() === 'RECOVERED';
  const active = !recovery && (/degrad|violat|critical|open|active|error|exception|failure|anomal/i.test(text)
    || String(record.transition || '').toUpperCase() === 'DEGRADED');
  const metric = cleanText(record.metric || metadata.metric || metadata.metricName || title) || null;
  const reportedCondition = cleanText(semantic.actualIntent || metadata.metricIntent).toUpperCase();
  const inferredCondition = conditionFamily(metric || text);
  const actualCondition = reportedCondition && reportedCondition !== 'GENERAL_HEALTH'
    ? reportedCondition : inferredCondition !== 'GENERAL_HEALTH' ? inferredCondition : reportedCondition || inferredCondition;
  const value = Number(record.value ?? metadata.value);
  const id = cleanText(record.id || metadata.eventId || metadata.violationId) || null;
  const type = cleanText(record.type || metadata.recordType || 'APPDYNAMICS_RECORD').toUpperCase();
  return {
    id,
    timestamp: toIso(record.timestamp || record.time || record.eventTime || semantic.timestamp),
    type,
    title,
    summary: summary || null,
    text,
    active,
    recovery,
    metric,
    value: Number.isFinite(value) ? value : null,
    condition: actualCondition,
    semanticStatus: cleanText(semantic.status || metadata.semanticStatus).toUpperCase() || null,
    evidenceLevel: cleanText(semantic.evidenceLevel || metadata.evidenceLevel).toUpperCase() || null,
    eventType: cleanText(semantic.eventType || metadata.eventType || metadata.state).toUpperCase() || null,
    entityType: cleanText(semantic.entityType || metadata.entityType || fallback.entityType).toUpperCase() || null,
    entityId: cleanText(semantic.entityId || metadata.entityId || record.entity || fallback.entityId) || null,
    applicationId: cleanText(semantic.applicationId || metadata.applicationId || fallback.applicationId) || null,
    healthRule: cleanText(metadata.healthRule || metadata.healthRuleName || extractHealthRule(text)) || null,
    healthRuleId: cleanText(metadata.healthRuleId) || null,
    policy: cleanText(metadata.policy || metadata.policyName || extractPolicy(text)) || null,
    policyId: cleanText(metadata.policyId) || null,
    violationId: cleanText(metadata.violationId || (id && /EVENT|VIOLATION|HEALTH_RULE|POLICY/.test(type) ? id : null)) || null,
    node: cleanText(metadata.node || metadata.nodeName || extractNamed(text, 'node')) || null,
    tier: cleanText(metadata.tier || metadata.tierName || extractNamed(text, 'tier')) || null,
    businessTransaction: cleanText(metadata.businessTransaction || metadata.businessTransactionName || extractNamed(text, 'businessTransaction')) || null,
    database: cleanText(metadata.database || metadata.databaseName || extractNamed(text, 'database')) || null,
    thresholdViolated: metadata.thresholdViolated === true || /greater than|less than|threshold|baseline.*standard deviation/i.test(text),
    sustained: metadata.sustained === true,
  };
}

function recordIsEvent(record) {
  if (/TELEMETRY|METRIC/.test(record.type)) return false;
  return /EVENT|VIOLATION|HEALTH_RULE|POLICY/.test(record.type)
    || Boolean(record.violationId || record.healthRule || record.healthRuleId || record.eventType);
}

function eventHasMeaningfulState(record) {
  return Boolean(record.active && (record.healthRule || record.healthRuleId || record.thresholdViolated
    || /POLICY|HEALTH_RULE|VIOLATION|ANOMALY/.test(record.eventType))
    && !/^\s*(?:critical|error|fatal)\s*$/i.test(record.title));
}

function sameEntityLevel(requiredLevel, record, details) {
  if (requiredLevel === 'APPLICATION') return Boolean(details.application && (record.applicationId || record.entityId || record.healthRule || record.violationId));
  if (requiredLevel === 'NODE') return Boolean(record.node || record.entityType === 'NODE');
  if (requiredLevel === 'TIER') return Boolean(record.tier || record.entityType === 'TIER');
  if (requiredLevel === 'BUSINESS_TRANSACTION') return Boolean(record.businessTransaction || record.entityType === 'BUSINESS_TRANSACTION');
  if (requiredLevel === 'DATABASE') return Boolean(record.database || record.entityType === 'DATABASE');
  return false;
}

function conditionCompatible(expected, record) {
  if (record.semanticStatus === 'MISMATCHED') return false;
  if (expected === 'GENERAL_HEALTH') return Boolean(record.healthRule || record.violationId || record.eventType
    || ['ERROR_RATE', 'RESPONSE_TIME', 'CALLS_LOAD', 'CPU', 'MEMORY', 'BUSINESS_TRANSACTION', 'DATABASE', 'NODE_HEALTH'].includes(record.condition));
  if (record.condition === expected) return true;
  if (expected === 'BUSINESS_TRANSACTION' && record.businessTransaction) return true;
  if (expected === 'DATABASE' && record.database) return true;
  if (expected === 'NODE_HEALTH' && record.node) return true;
  if (record.healthRule && conditionFamily(record.healthRule) === expected) return true;
  return false;
}

function evidenceRecord(record, type, reason) {
  return {
    id: record.id,
    source: 'AppDynamics',
    type,
    timestamp: record.timestamp,
    label: record.healthRule || record.title || 'AppDynamics source evidence',
    reason,
  };
}

function reviewRootCause({ identityAccepted, entityStatus, conditionStatus, sourceEvents, telemetry, persistenceStatus, state }) {
  if (!identityAccepted || entityStatus === 'UNRESOLVED') return 'NO_ENTITY';
  if (entityStatus === 'WRONG_ENTITY') return 'WRONG_ENTITY';
  if (conditionStatus === 'WRONG_METRIC') return 'WRONG_METRIC';
  if (!sourceEvents.length && !telemetry.length) return 'NO_TELEMETRY';
  if (!sourceEvents.length && telemetry.length && persistenceStatus === 'UNKNOWN') return 'PERSISTENCE_UNKNOWN';
  if (!sourceEvents.length) return 'NO_SOURCE_EVENT';
  if (state === 'UNKNOWN') return 'EVENT_BOUNDARY_UNKNOWN';
  return 'OTHER';
}

function evaluateAppDynamicsWorkflowEvidence({ alert = {}, identity = {}, monitoringBlocks = [], reconstruction = null, records = [] } = {}) {
  const policy = APPDYNAMICS_WORKFLOW_POLICY;
  const alertText = cleanText([alert.title, alert.pattern, alert.message].filter(Boolean).join(' '));
  const application = cleanText(reconstruction?.application?.name || alert.application || identity.canonicalEntity
    || identity.sourceEntityName || alert.canonicalEntity) || null;
  const reconstructedCondition = cleanText(reconstruction?.conditionFamily || reconstruction?.telemetryValidation?.expectedIntent);
  let expectedCondition = reconstructedCondition ? conditionFamily(reconstructedCondition) : conditionFamily(alertText);
  const requiredEntityLevel = entityLevel(alertText);
  const fallback = { applicationId: reconstruction?.application?.id || identity.sourceEntityId,
    entityId: identity.sourceEntityId || application, entityType: requiredEntityLevel };
  const reconstructionRecords = reconstruction?.telemetry || [];
  const blockRecords = monitoringBlocks.flatMap((block) => block.records || []);
  const normalized = [...records, ...blockRecords, ...reconstructionRecords].map((record) => normalizedRecord(record, fallback));
  const byId = new Map();
  normalized.forEach((record, index) => byId.set(record.id || `appd-record-${index}`, record));
  const allRecords = [...byId.values()];
  if (expectedCondition === 'GENERAL_HEALTH') {
    const activeFamilies = unique(allRecords.filter((record) => record.active && record.condition !== 'GENERAL_HEALTH')
      .map((record) => record.condition));
    if (activeFamilies.length === 1) [expectedCondition] = activeFamilies;
  }
  const sourceEvents = allRecords.filter(recordIsEvent);
  const telemetry = allRecords.filter((record) => !recordIsEvent(record));
  const activeEvents = sourceEvents.filter((record) => record.active);
  const recoveryEvents = sourceEvents.filter((record) => record.recovery);
  const identityAccepted = identity.accepted === true || reconstruction?.mapping?.accepted === true;
  const entityMatchedRecords = allRecords.filter((record) => sameEntityLevel(requiredEntityLevel, record, { application }));
  const blockWrongEntity = monitoringBlocks.some((block) => /WRONG_ENTITY|ENTITY_NOT_FOUND/i.test(cleanText(block.outcome)));
  const wrongEntityEvidence = blockWrongEntity || (identityAccepted && allRecords.length > 0
    && entityMatchedRecords.length === 0 && requiredEntityLevel !== 'APPLICATION');
  const entityStatus = !identityAccepted || (!application && !entityMatchedRecords.length) ? 'UNRESOLVED'
    : wrongEntityEvidence ? 'WRONG_ENTITY' : 'MATCHED';
  const conditionMatchedRecords = entityMatchedRecords.filter((record) => conditionCompatible(expectedCondition, record));
  const conditionMismatch = monitoringBlocks.some((block) => /WRONG_METRIC|UNSUPPORTED_METRIC|MISMATCHED/i.test(cleanText(block.outcome)))
    || allRecords.some((record) => record.semanticStatus === 'MISMATCHED')
    || (entityMatchedRecords.length > 0 && conditionMatchedRecords.length === 0 && expectedCondition !== 'GENERAL_HEALTH');
  const conditionStatus = conditionMismatch ? 'WRONG_METRIC' : conditionMatchedRecords.length ? 'MATCHED' : 'UNRESOLVED';
  const compatibleActiveEvents = activeEvents.filter((record) => sameEntityLevel(requiredEntityLevel, record, { application })
    && conditionCompatible(expectedCondition, record) && record.id && record.timestamp && eventHasMeaningfulState(record));
  const sourceNative = identityAccepted && entityStatus === 'MATCHED' && conditionStatus === 'MATCHED'
    && compatibleActiveEvents.length > 0;

  const metricRecords = conditionMatchedRecords.filter((record) => (!recordIsEvent(record)
    || (record.eventType === 'APPLICATION_ERROR' && !record.healthRule)) && record.timestamp);
  const distinctMetricTimes = unique(metricRecords.map((record) => record.timestamp));
  const errorRecords = metricRecords.filter((record) => record.condition === 'ERROR_RATE' && Number.isFinite(record.value));
  const isolatedOneOrTwoErrors = expectedCondition === 'ERROR_RATE' && errorRecords.length > 0
    && errorRecords.every((record) => record.value >= 0 && record.value <= 2) && distinctMetricTimes.length <= 2;
  const repeatedMeaningfulErrors = errorRecords.filter((record) => record.value > 2).length >= 2
    && unique(errorRecords.filter((record) => record.value > 2).map((record) => record.timestamp)).length >= 2;
  const blockSustained = monitoringBlocks.some((block) => block.acceptedMapping === true && block.degradation === true
    && block.sustained === true && block.transient !== true);
  const reconstructionSustained = reconstruction?.mapping?.accepted === true
    && reconstruction?.telemetryValidation?.status === 'MATCHED'
    && reconstruction?.telemetryValidation?.evidenceLevel === 'DIRECT'
    && (reconstruction?.state === 'ONGOING' || reconstruction?.state === 'FLAPPING'
      || Number(reconstruction?.durationMs || 0) > 0 || Number(reconstruction?.transitionCount || 0) > 1);
  const repeatedMatchingTelemetry = distinctMetricTimes.length >= 3 && metricRecords.some((record) => record.thresholdViolated || record.sustained);
  const sustained = !isolatedOneOrTwoErrors && (blockSustained || reconstructionSustained || repeatedMeaningfulErrors || repeatedMatchingTelemetry);
  const persistenceStatus = sustained || sourceEvents.some((record) => /continues to violate|last \d+ (?:minute|hour)/i.test(record.text))
    ? 'CONFIRMED' : 'UNKNOWN';
  const sustainedTelemetry = identityAccepted && entityStatus === 'MATCHED' && conditionStatus === 'MATCHED'
    && metricRecords.length > 0 && persistenceStatus === 'CONFIRMED' && !isolatedOneOrTwoErrors;
  const recoveryStatus = recoveryEvents.length || reconstruction?.recoveryAt || reconstruction?.state === 'RECOVERED'
    || reconstruction?.state === 'TRANSIENT' ? 'RECOVERED'
    : sourceNative || sustainedTelemetry || reconstruction?.state === 'ONGOING' || reconstruction?.state === 'FLAPPING' ? 'ACTIVE' : 'UNKNOWN';
  const impactStatus = sourceNative || sustainedTelemetry ? 'CONFIRMED' : 'UNKNOWN';
  const realEventStatus = sourceNative || sustainedTelemetry ? 'CONFIRMED' : 'UNKNOWN';
  const sourceRuleId = sourceNative ? policy.rules.sourceNative : sustainedTelemetry ? policy.rules.sustainedTelemetry : null;
  const evidenceUsed = sourceNative
    ? compatibleActiveEvents.slice(0, 5).map((record) => evidenceRecord(record, 'SOURCE_NATIVE_VIOLATION',
      'The AppDynamics source event has an accepted entity, matching condition, meaningful state, source identity, and compatible timestamp.'))
    : sustainedTelemetry
      ? metricRecords.slice(0, 5).map((record) => evidenceRecord(record, 'SUSTAINED_DIRECT_TELEMETRY',
        `The ${record.metric || expectedCondition} evidence matches the required ${requiredEntityLevel.toLowerCase()} condition and is part of a sustained degradation sequence.`))
      : [];
  const evidenceMissing = [];
  if (!identityAccepted || entityStatus === 'UNRESOLVED') evidenceMissing.push('NO_ENTITY');
  if (entityStatus === 'WRONG_ENTITY') evidenceMissing.push('WRONG_ENTITY');
  if (!sourceEvents.length) evidenceMissing.push('NO_SOURCE_EVENT');
  if (!telemetry.length) evidenceMissing.push('NO_TELEMETRY');
  if (conditionStatus === 'UNRESOLVED') evidenceMissing.push('CONDITION_UNRESOLVED');
  if (conditionStatus === 'WRONG_METRIC') evidenceMissing.push('WRONG_METRIC');
  if (!sourceNative && persistenceStatus === 'UNKNOWN') evidenceMissing.push('PERSISTENCE_UNKNOWN');
  if (!sourceNative && !sustainedTelemetry && recoveryStatus === 'UNKNOWN') evidenceMissing.push('EVENT_BOUNDARY_UNKNOWN');
  const details = {
    healthRule: compatibleActiveEvents.find((record) => record.healthRule)?.healthRule
      || sourceEvents.find((record) => record.healthRule)?.healthRule || null,
    policy: sourceEvents.find((record) => record.policy)?.policy || null,
    application,
    tier: sourceEvents.find((record) => record.tier)?.tier || reconstruction?.application?.tier || null,
    node: sourceEvents.find((record) => record.node)?.node || reconstruction?.application?.node || null,
    businessTransaction: sourceEvents.find((record) => record.businessTransaction)?.businessTransaction
      || reconstruction?.application?.businessTransaction || null,
    database: sourceEvents.find((record) => record.database)?.database || null,
    condition: expectedCondition,
    requiredEntityLevel,
    impact: impactStatus === 'CONFIRMED'
      ? sourceNative ? 'AppDynamics source-native violation confirms meaningful operational impact.'
        : `${metricRecords.length} matching direct telemetry record${metricRecords.length === 1 ? '' : 's'} confirm sustained operational degradation.`
      : null,
    recovery: recoveryStatus === 'RECOVERED' ? toIso(reconstruction?.recoveryAt || recoveryEvents[0]?.timestamp) : null,
  };
  const rootCause = realEventStatus === 'CONFIRMED' ? null : reviewRootCause({ identityAccepted, entityStatus,
    conditionStatus, sourceEvents, telemetry, persistenceStatus, state: cleanText(reconstruction?.state).toUpperCase() || 'UNKNOWN' });
  const reasoning = sourceNative
    ? `AppDynamics returned a meaningful ${compatibleActiveEvents[0]?.eventType || 'active'} source violation for the accepted ${requiredEntityLevel.toLowerCase()} identity. The source event matches the alert condition and timestamp.`
    : sustainedTelemetry
      ? `AppDynamics returned matching ${expectedCondition.toLowerCase().replaceAll('_', ' ')} evidence for the accepted ${requiredEntityLevel.toLowerCase()} identity across a sustained or repeated degradation sequence.`
      : isolatedOneOrTwoErrors
        ? 'Only one or two isolated errors were observed, so the AppDynamics workflow does not automatically treat this as an Incident.'
        : 'The available AppDynamics evidence does not yet establish a complete source-native violation or sustained matching telemetry condition.';
  return {
    realEventStatus,
    conditionStatus,
    entityStatus,
    persistenceStatus,
    recoveryStatus,
    impactStatus,
    evidenceUsed,
    evidenceMissing: unique(evidenceMissing),
    sourceRuleId,
    policyVersion: policy.policyVersion,
    notificationRole: 'UNKNOWN',
    reviewRootCause: rootCause,
    details,
    reasoning,
    isolatedOneOrTwoErrors,
  };
}

module.exports = {
  conditionFamily,
  entityLevel,
  evaluateAppDynamicsWorkflowEvidence,
};
