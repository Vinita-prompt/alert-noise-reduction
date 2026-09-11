const crypto = require('node:crypto');
const db = require('../config/db');
const {
  acceptedPersistedRow,
  recoveryIsAuthoritative,
} = require('./occurrenceEvidenceConsumption.service');

const EPISODE_POLICY_VERSION = 'OCCURRENCE_AWARE_EPISODE_SHADOW_V2';
const LEGACY_EPISODE_POLICY_VERSION = 'EPISODE_BASED_SHADOW_V1';
const EPISODE_WINDOW_HOURS = 24;
const EPISODE_HISTORY_DAYS = 90;
const EPISODE_INACTIVITY_MS = 30 * 60 * 1000;
const MAX_HISTORY_PER_IDENTITY = 500;
const SNAPSHOT_CACHE_MS = 15_000;
const OPERATIONAL_HISTORY_MIN_EPISODES = 5;
const OPERATIONAL_HISTORY_MIN_ACKNOWLEDGED_RATE = 0.8;
const OPERATIONAL_HISTORY_MIN_CLOSED_WITHOUT_ACTION_RATE = 0.8;
const EPISODE_GROUPING_BASIS = Object.freeze({
  EXACT_SOURCE_OCCURRENCE: 'EXACT_SOURCE_OCCURRENCE',
  STRUCTURED_IDENTITY_CONTINUITY: 'STRUCTURED_IDENTITY_CONTINUITY',
  EXPLICIT_RENOTIFICATION: 'EXPLICIT_RENOTIFICATION',
  // Backward-compatible property name for callers compiled against the
  // pre-activation shadow spelling. The persisted value is the corrected
  // production contract above.
  EXPLICIT_RERNOTIFICATION: 'EXPLICIT_RENOTIFICATION',
  UNRESOLVED_IDENTITY_ISOLATED: 'UNRESOLVED_IDENTITY_ISOLATED',
  DUPLICATE_UNDERLYING_OCCURRENCE: 'DUPLICATE_UNDERLYING_OCCURRENCE',
});

function clean(value) {
  return String(value ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function normalize(value) {
  const result = clean(value).toLowerCase().replace(/[^a-z0-9._:-]+/g, '-').replace(/^-+|-+$/g, '');
  return /^(unknown|unknown-service|not-available|n-a|null|undefined)$/.test(result) ? '' : result;
}

function usable(value) {
  return normalize(value) ? clean(value) : '';
}

function canonicalSource(value) {
  const candidate = clean(value).split('|')[0].toLowerCase().replace(/[\s_-]+/g, '');
  if (['appd', 'appdynamics'].includes(candidate)) return 'AppDynamics';
  if (candidate === 'grafana') return 'Grafana';
  if (['nagios', 'nagiosxi', 'nagiosxiv2'].includes(candidate)) return 'Nagios';
  if (candidate === 'thousandeyes') return 'ThousandEyes';
  return null;
}

function hash(value, length = 40) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, length);
}

function toMs(value) {
  const parsed = value ? new Date(value).getTime() : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function toIso(value) {
  const parsed = toMs(value);
  return parsed === null ? null : new Date(parsed).toISOString();
}

function recursiveField(value, names, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 7) return null;
  const wanted = new Set(names.map((name) => String(name).toLowerCase()));
  for (const [key, item] of Object.entries(value)) {
    if (wanted.has(key.toLowerCase()) && item !== null && item !== undefined && clean(item)) return item;
  }
  for (const item of Object.values(value)) {
    const found = recursiveField(item, names, depth + 1);
    if (found !== null && found !== undefined && clean(found)) return found;
  }
  return null;
}

function unique(values) {
  return [...new Set((values || []).map(clean).filter(Boolean))];
}

function safeObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function stableObjectEntries(value) {
  return Object.entries(safeObject(value))
    .filter(([, item]) => item !== null && item !== undefined && typeof item !== 'object')
    .map(([key, item]) => `${normalize(key)}:${normalize(item)}`)
    .filter((item) => !item.endsWith(':'))
    .sort();
}

function booleanTrue(value) {
  return value === true || /^(true|yes|1)$/i.test(clean(value));
}

function percentile(values, fraction) {
  const numbers = (values || []).map(Number).filter(Number.isFinite).sort((left, right) => left - right);
  if (!numbers.length) return null;
  const index = Math.min(numbers.length - 1, Math.max(0, Math.ceil(numbers.length * fraction) - 1));
  return numbers[index];
}

function evaluationFor(row) {
  return {
    finalDecision: row.evaluation_final_decision || row.evaluation?.finalDecision || null,
    notificationRole: row.evaluation_notification_role || row.evaluation?.notificationRole || null,
    featureSnapshot: row.evaluation_feature_snapshot || row.evaluation?.featureSnapshot || {},
    technicalEvidence: row.evaluation_technical_evidence || row.evaluation?.technicalEvidence || {},
    explanation: row.evaluation_explanation || row.evaluation?.explanation || {},
    evidenceReferences: row.evaluation_evidence_references || row.evaluation?.evidenceReferences || [],
  };
}

function persistedOccurrenceFor(row, source) {
  const value = source === 'AppDynamics' ? row.appdynamics_occurrence_evidence
    : source === 'Grafana' ? row.grafana_occurrence_evidence
      : source === 'Nagios' ? row.nagios_occurrence_evidence : null;
  const evidence = safeObject(value);
  return acceptedPersistedRow(source, evidence) ? evidence : null;
}

function explicitRenotificationFor(raw, extracted) {
  const roots = [raw, extracted];
  const flagNames = [
    'isRenotification', 'isReNotification', 'renotification', 'reNotification',
    'repeatNotification', 'isRepeatNotification', 'isReminder', 'reminder',
  ];
  const typeNames = ['notificationReason', 'notificationKind', 'notificationType', 'deliveryReason'];
  const relationshipNames = ['renotificationOf', 'reNotificationOf', 'reminderOf', 'repeatOfOccurrenceId'];
  const explicitFlag = roots.some((root) => booleanTrue(recursiveField(root, flagNames)));
  const explicitType = roots.map((root) => clean(recursiveField(root, typeNames))).find((value) => (
    /^(?:re-?notification|reminder|repeat-notification)$/i.test(value)
  )) || null;
  const relationship = roots.map((root) => usable(recursiveField(root, relationshipNames))).find(Boolean) || null;
  return {
    observed: explicitFlag || Boolean(explicitType) || Boolean(relationship),
    relationship,
    reason: relationship ? 'The source explicitly links this notification to an earlier occurrence.'
      : explicitFlag || explicitType ? 'The source explicitly marks this notification as a reminder or re-notification.' : null,
  };
}

function authoritativeLifecycleFor(row, evaluation, source, persistedOccurrence) {
  if (persistedOccurrence) {
    const currentState = clean(persistedOccurrence.current_state).toUpperCase();
    const recovered = recoveryIsAuthoritative(source, persistedOccurrence);
    return {
      available: true,
      currentlyFiring: currentState === 'FIRING' && !recovered,
      recovered,
      recoveredAt: recovered ? toIso(persistedOccurrence.recovery_at) : null,
      startedAt: toIso(persistedOccurrence.firing_at),
      occurrenceId: usable(persistedOccurrence.source_occurrence_id),
      stateType: usable(persistedOccurrence.occurrence_state_type || persistedOccurrence.current_state_type),
      provenance: `${source} persisted exact occurrence evidence`,
    };
  }
  const lifecycle = evaluation.technicalEvidence?.monitoringLifecycle || {};
  const sourceEvidenceIds = unique(lifecycle.provenance?.sourceEvidenceIds || []);
  const occurrence = lifecycle.occurrence || {};
  const lifecycleAvailable = lifecycle.completeness?.lifecycleEvidenceAvailable === true
    && sourceEvidenceIds.length > 0
    && Boolean(toIso(occurrence.startedAt));
  const recovered = lifecycleAvailable && lifecycle.recovery?.recovered === true
    && Boolean(toIso(lifecycle.recovery?.recoveredAt));
  return {
    available: lifecycleAvailable,
    currentlyFiring: lifecycleAvailable && lifecycle.persistence?.currentlyFiring === true && !recovered,
    recovered,
    recoveredAt: recovered ? toIso(lifecycle.recovery?.recoveredAt) : null,
    startedAt: lifecycleAvailable ? toIso(occurrence.startedAt) : null,
    occurrenceId: lifecycleAvailable ? usable(occurrence.sourceOccurrenceId) : null,
    stateType: lifecycleAvailable ? usable(occurrence.stateType) : null,
    provenance: lifecycleAvailable ? usable(lifecycle.provenance?.lifecycleSource) || 'Stored authoritative source lifecycle' : null,
  };
}

function sourceAndIdentity(row, { occurrenceAware = true } = {}) {
  const raw = row.raw_payload || row.rawPayload || {};
  const extracted = row.extracted_details || row.extractedDetails || {};
  const normalizedAlert = extracted.normalized_alert || extracted.normalizedAlert || {};
  const evaluation = evaluationFor(row);
  const featureIdentity = evaluation.featureSnapshot?.identity || {};
  const get = (names) => recursiveField(extracted, names) ?? recursiveField(raw, names);
  const source = [
    raw.integrationName, raw.integrationType, raw.source, normalizedAlert.source,
    normalizedAlert.monitoring_tool, row.evaluation_source, featureIdentity.source, row.source,
  ].map(canonicalSource).find(Boolean) || null;
  const environment = normalize(
    normalizedAlert.environment || row.environment || featureIdentity.environment || get(['environment', 'env', 'tier']),
  ) || 'unknown';
  const genericEntity = [
    normalizedAlert.entity, normalizedAlert.service, row.service, featureIdentity.entity,
    featureIdentity.service, row.learning_entity_key_v1, row.entityKey,
  ].map(usable).find(Boolean) || '';
  const signature = clean(row.learning_alert_signature_v1 || row.alertSignature);
  const message = clean(normalizedAlert.message || row.description || row.signal || row.title);
  const persistedOccurrence = occurrenceAware ? persistedOccurrenceFor(row, source) : null;
  const sourceAlias = usable(raw.alias || extracted.alias);
  const explicitRenotification = explicitRenotificationFor(raw, extracted);
  const notificationPath = usable(
    recursiveField(extracted, ['notificationPath', 'notificationRoute', 'receiver', 'contactPoint', 'routeId'])
      ?? recursiveField(raw, ['notificationPath', 'notificationRoute', 'receiver', 'contactPoint', 'routeId']),
  ) || null;

  let entityParts = [];
  let ruleParts = [];
  let historicalRuleParts = [];
  let structuredLabels = [];
  let nativeOccurrenceId = null;
  let authoritativeOccurrenceIdentity = false;
  let structuredIdentityComplete = false;
  let canonicalEntity = genericEntity || null;
  let ruleEvent = null;
  let identityStrength = 'SIGNATURE_FALLBACK';

  if (source === 'AppDynamics') {
    const applicationId = usable(persistedOccurrence?.application_id || get(['applicationId', 'application_id']) || featureIdentity.applicationId);
    const application = usable(persistedOccurrence?.application_name || get(['applicationName', 'application_name']) || normalizedAlert.application || featureIdentity.application);
    const tier = usable(persistedOccurrence?.tier_name || get(['tierName', 'tier']));
    const node = usable(persistedOccurrence?.node_name || get(['nodeName', 'node']));
    const transaction = usable(persistedOccurrence?.business_transaction_name
      || get(['businessTransactionName', 'businessTransaction', 'business_transaction']));
    const healthRule = usable(persistedOccurrence?.health_rule_name || get(['healthRuleName', 'healthRule', 'health_rule']));
    const eventId = usable(persistedOccurrence?.event_id || get(['eventId', 'event_id']));
    const violationId = usable(persistedOccurrence?.violation_id || get(['violationId', 'violation_id']));
    entityParts = unique([
      applicationId ? `application-id:${normalize(applicationId)}` : null,
      application ? `application:${normalize(application)}` : null,
      tier ? `tier:${normalize(tier)}` : null,
      node ? `node:${normalize(node)}` : null,
      transaction ? `transaction:${normalize(transaction)}` : null,
      !applicationId && !application ? normalize(genericEntity) : null,
    ]);
    ruleParts = unique([
      eventId ? `event:${normalize(eventId)}` : null,
      violationId ? `violation:${normalize(violationId)}` : null,
      healthRule ? `health-rule:${normalize(healthRule)}` : null,
    ]);
    historicalRuleParts = unique([healthRule ? `health-rule:${normalize(healthRule)}` : null]);
    nativeOccurrenceId = usable(persistedOccurrence?.source_occurrence_id) || eventId || violationId || null;
    authoritativeOccurrenceIdentity = Boolean(nativeOccurrenceId);
    structuredIdentityComplete = Boolean((applicationId || application) && (node || tier || transaction || genericEntity) && healthRule);
    canonicalEntity = [application || applicationId, tier, node, transaction].filter(Boolean).join(' / ') || genericEntity || null;
    ruleEvent = eventId || healthRule || null;
    if (applicationId || eventId) identityStrength = 'AUTHORITATIVE_SOURCE_IDENTITY';
    else if (entityParts.length && (healthRule || message)) identityStrength = 'STRUCTURED_SOURCE_IDENTITY';
  } else if (source === 'Grafana') {
    const ruleUid = usable(persistedOccurrence?.rule_uid || get(['ruleUid', 'rule_uid', 'alertRuleUid']));
    const dashboardUid = usable(persistedOccurrence?.dashboard_uid || get(['dashboardUid', 'dashboard_uid']));
    const panelId = usable(persistedOccurrence?.panel_id || get(['panelId', 'panel_id']));
    const ruleName = usable(persistedOccurrence?.rule_name || get(['alertName', 'alertname', 'ruleName'])
      || normalizedAlert.rule || normalizedAlert.alert_name);
    const instance = usable(persistedOccurrence?.integration_host || persistedOccurrence?.workspace_host
      || get(['sourceHost', 'grafanaSourceHost', 'instance', 'integrationHost']));
    const service = [normalizedAlert.service, row.service, featureIdentity.service].map(usable).find(Boolean) || '';
    structuredLabels = stableObjectEntries(persistedOccurrence?.instance_labels || get(['labels', 'instanceLabels']));
    entityParts = unique([
      instance ? `instance:${normalize(instance)}` : null,
      service ? `service:${normalize(service)}` : null,
      dashboardUid ? `dashboard:${normalize(dashboardUid)}` : null,
      panelId ? `panel:${normalize(panelId)}` : null,
      !instance && !service && !dashboardUid ? normalize(genericEntity) : null,
    ]);
    ruleParts = unique([
      ruleUid ? `rule-uid:${normalize(ruleUid)}` : null,
      ruleName ? `rule:${normalize(ruleName)}` : null,
      occurrenceAware && structuredLabels.length ? `labels:${hash(structuredLabels.join('|'))}` : null,
    ]);
    historicalRuleParts = unique([ruleUid ? `rule-uid:${normalize(ruleUid)}` : null, ruleName ? `rule:${normalize(ruleName)}` : null]);
    const grafanaFingerprint = usable(persistedOccurrence?.fingerprint || get(['fingerprint']));
    nativeOccurrenceId = occurrenceAware
      ? usable(persistedOccurrence?.source_occurrence_id) || grafanaFingerprint || null
      : usable(get(['fingerprint', 'sourceAlertId', 'source_alert_id'])) || null;
    authoritativeOccurrenceIdentity = Boolean(persistedOccurrence || (ruleUid && grafanaFingerprint));
    structuredIdentityComplete = Boolean((ruleUid || ruleName) && structuredLabels.length && (instance || service));
    canonicalEntity = service || instance || genericEntity || null;
    ruleEvent = ruleUid || ruleName || null;
    if (ruleUid) identityStrength = 'AUTHORITATIVE_SOURCE_IDENTITY';
    else if (ruleName && entityParts.length) identityStrength = 'STRUCTURED_SOURCE_IDENTITY';
  } else if (source === 'Nagios') {
    const host = usable(persistedOccurrence?.host_name || get(['hostName', 'host', 'hostname']) || normalizedAlert.host);
    const service = usable(persistedOccurrence?.service_description
      || get(['serviceDescription', 'service_name', 'service']) || normalizedAlert.service);
    const instance = usable(persistedOccurrence?.source_instance
      || get(['instanceKey', 'sourceInstance', 'nagiosEnvironment', 'nagiosServer']));
    entityParts = unique([
      instance ? `instance:${normalize(instance)}` : null,
      host ? `host:${normalize(host)}` : null,
      service ? `service:${normalize(service)}` : null,
    ]);
    ruleParts = unique([service ? `check:${normalize(service)}` : null]);
    historicalRuleParts = [...ruleParts];
    const stateType = usable(persistedOccurrence?.occurrence_state_type || persistedOccurrence?.current_state_type
      || get(['stateType', 'state_type']));
    const rawOccurrenceId = usable(get(['eventId', 'event_id', 'problemId', 'problem_id']));
    nativeOccurrenceId = occurrenceAware
      ? usable(persistedOccurrence?.source_occurrence_id) || (/^HARD$/i.test(stateType) ? rawOccurrenceId : null)
      : usable(get(['eventId', 'event_id', 'sourceAlertId', 'source_alert_id'])) || null;
    authoritativeOccurrenceIdentity = Boolean(persistedOccurrence || (nativeOccurrenceId && /^HARD$/i.test(stateType)));
    structuredIdentityComplete = Boolean(instance && host && (service || persistedOccurrence?.object_type === 'host') && /^HARD$/i.test(stateType));
    canonicalEntity = [host, service].filter(Boolean).join(' / ') || genericEntity || null;
    ruleEvent = service || null;
    if (host) identityStrength = 'AUTHORITATIVE_SOURCE_IDENTITY';
  } else if (source === 'ThousandEyes') {
    const testId = usable(get(['testId', 'test_id']));
    const alertId = usable(get(['alertId', 'alert_id', 'eventId']));
    const ruleId = usable(get(['ruleId', 'rule_id']));
    const testName = usable(get(['testName', 'test_name']) || normalizedAlert.service);
    entityParts = unique([testId ? `test-id:${normalize(testId)}` : null, testName ? `test:${normalize(testName)}` : null]);
    ruleParts = unique([ruleId ? `rule-id:${normalize(ruleId)}` : null, alertId ? `alert-id:${normalize(alertId)}` : null]);
    historicalRuleParts = unique([ruleId ? `rule-id:${normalize(ruleId)}` : null]);
    nativeOccurrenceId = alertId || null;
    authoritativeOccurrenceIdentity = Boolean(alertId);
    structuredIdentityComplete = Boolean(testId && ruleId);
    canonicalEntity = testName || testId || genericEntity || null;
    ruleEvent = ruleId || alertId || null;
    if (testId || alertId) identityStrength = 'AUTHORITATIVE_SOURCE_IDENTITY';
  }

  if (!entityParts.length && normalize(genericEntity)) entityParts.push(`entity:${normalize(genericEntity)}`);
  if (!ruleParts.length && signature) ruleParts.push(`signature:${normalize(signature)}`);
  if (!ruleParts.length && message) ruleParts.push(`message:${hash(normalize(message), 24)}`);
  if (!historicalRuleParts.length && signature) historicalRuleParts.push(`signature:${normalize(signature)}`);
  if (!historicalRuleParts.length && message) historicalRuleParts.push(`message:${hash(normalize(message), 24)}`);
  const validSource = Boolean(source);
  const identityAmbiguous = !validSource || (!entityParts.length && !ruleParts.length);
  const lifecycle = authoritativeLifecycleFor(row, evaluation, source, persistedOccurrence);
  if (lifecycle.occurrenceId && !nativeOccurrenceId) {
    nativeOccurrenceId = lifecycle.occurrenceId;
    authoritativeOccurrenceIdentity = true;
  }
  const exactOccurrenceKey = occurrenceAware && authoritativeOccurrenceIdentity && nativeOccurrenceId
    ? `${source}|occurrence:${normalize(nativeOccurrenceId)}` : null;
  const structuredIdentityParts = [source || 'Unsupported', ...entityParts, ...historicalRuleParts,
    ...structuredLabels.map((item) => `label:${item}`), `environment:${environment}`];
  const structuredIdentityKey = structuredIdentityComplete ? hash(structuredIdentityParts.join('|')) : null;
  const structuredLifecycleKey = occurrenceAware && structuredIdentityKey && lifecycle.available && lifecycle.startedAt
    ? `${source}|structured:${structuredIdentityKey}|started:${lifecycle.startedAt}` : null;
  const fingerprintParts = exactOccurrenceKey ? [exactOccurrenceKey]
    : structuredLifecycleKey ? [structuredLifecycleKey]
      : [source || 'Unsupported', ...entityParts, ...ruleParts, `environment:${environment}`];
  const identityUnconfirmed = occurrenceAware && !exactOccurrenceKey && !structuredLifecycleKey;
  if (identityAmbiguous || identityUnconfirmed) fingerprintParts.push(`alert:${row.id}`);
  const entityPartsForHash = [source || 'Unsupported', ...entityParts, `environment:${environment}`];
  const historicalIdentityParts = [source || 'Unsupported', ...entityParts, ...historicalRuleParts,
    `environment:${environment}`];
  const continuityBucketKey = exactOccurrenceKey || structuredLifecycleKey
    || (sourceAlias ? `${source || 'Unsupported'}|unconfirmed-hint:${normalize(sourceAlias)}` : `isolated:${row.id}`);
  return {
    source,
    environment,
    canonicalEntity,
    ruleEvent,
    nativeOccurrenceId,
    authoritativeOccurrenceIdentity,
    authoritativeLifecycle: lifecycle,
    exactOccurrenceKey,
    structuredIdentityKey,
    structuredLifecycleKey,
    continuityBucketKey,
    identityStatus: identityUnconfirmed ? 'IDENTITY_UNCONFIRMED' : 'IDENTITY_CONFIRMED',
    sourceAlias: sourceAlias || null,
    explicitRenotification,
    notificationPath,
    signature,
    normalizedMessage: normalize(message),
    identityStrength: identityAmbiguous ? 'AMBIGUOUS' : identityStrength,
    identityAmbiguous,
    fingerprint: fingerprintParts.join('|'),
    fingerprintHash: hash(fingerprintParts.join('|')),
    historicalFingerprintHash: hash(historicalIdentityParts.join('|')),
    entityFingerprint: hash(entityPartsForHash.join('|')),
    fingerprintComponents: {
      source: source || 'Unsupported/Unknown',
      entity: entityParts,
      ruleEvent: ruleParts,
      authoritativeOccurrence: exactOccurrenceKey,
      structuredLabels,
      unconfirmedSourceAlias: identityUnconfirmed ? sourceAlias || null : null,
      environment,
    },
  };
}

function groupingEvidenceIds(candidate, basis) {
  if (!candidate) return [];
  if (basis === EPISODE_GROUPING_BASIS.EXACT_SOURCE_OCCURRENCE) {
    return unique([
      candidate.nativeOccurrenceId ? `${candidate.source}:occurrence:${candidate.nativeOccurrenceId}` : null,
      candidate.authoritativeLifecycle?.provenance,
    ]);
  }
  if (basis === EPISODE_GROUPING_BASIS.STRUCTURED_IDENTITY_CONTINUITY) {
    return unique([
      candidate.structuredIdentityKey ? `${candidate.source}:structured-identity:${candidate.structuredIdentityKey}` : null,
      candidate.authoritativeLifecycle?.startedAt
        ? `${candidate.source}:lifecycle-start:${candidate.authoritativeLifecycle.startedAt}` : null,
    ]);
  }
  if (basis === EPISODE_GROUPING_BASIS.EXPLICIT_RENOTIFICATION) {
    return unique([
      candidate.explicitRenotification?.relationship
        ? `${candidate.source}:renotification-of:${candidate.explicitRenotification.relationship}` : null,
      candidate.nativeOccurrenceId ? `${candidate.source}:occurrence:${candidate.nativeOccurrenceId}` : null,
    ]);
  }
  if (basis === EPISODE_GROUPING_BASIS.DUPLICATE_UNDERLYING_OCCURRENCE) {
    return unique([
      candidate.duplicateOf ? `${candidate.source}:duplicate-of:${candidate.duplicateOf}` : null,
      candidate.nativeOccurrenceId ? `${candidate.source}:occurrence:${candidate.nativeOccurrenceId}` : null,
      candidate.notificationPath ? `${candidate.source}:notification-path:${candidate.notificationPath}` : null,
    ]);
  }
  return unique([`alert:${candidate.alertId}:identity-unresolved`]);
}

function episodeObservation(row, { occurrenceAware = true } = {}) {
  const evaluation = evaluationFor(row);
  const lifecycle = evaluation.technicalEvidence?.monitoringLifecycle || {};
  const intervention = lifecycle.intervention || {};
  const relationship = lifecycle.relationshipEvidence || {};
  const sourceIdentity = sourceAndIdentity(row, { occurrenceAware });
  const firstSeen = toIso(row.received_at || row.receivedAt || row.created_at || row.createdAt);
  const lastSeen = toIso(row.last_seen_at || row.lastSeenAt || firstSeen);
  const recovered = sourceIdentity.authoritativeLifecycle.recovered === true
    || lifecycle.recovery?.recovered === true;
  const recoveredAt = recovered ? sourceIdentity.authoritativeLifecycle.recoveredAt
    || toIso(lifecycle.recovery?.recoveredAt) : null;
  const currentlyFiring = sourceIdentity.authoritativeLifecycle.available
    ? sourceIdentity.authoritativeLifecycle.currentlyFiring === true
    : lifecycle.persistence?.currentlyFiring === true;
  const explicitIncident = row.explicit_incident === true || row.explicitIncident === true
    || evaluation.explanation?.dimensions?.confirmedJiraRelationships > 0
    || evaluation.underlyingEvent === 'CONFIRMED_INCIDENT';
  const confirmedNoise = row.confirmed_noise === true || row.confirmedNoise === true;
  const investigated = intervention.investigated === true;
  const remediated = intervention.remediated === true;
  const escalated = intervention.escalated === true || row.escalation_status === true || row.escalated === true;
  const operatorActionObserved = intervention.operatorActionObserved === true || investigated || remediated || escalated;
  const correlationConfirmed = relationship.correlationConfirmed === true
    || evaluation.explanation?.episode?.correlationConfirmed === true;
  const duplicateOf = evaluation.featureSnapshot?.currentBehavior?.notificationRelationship?.duplicateOf
    || evaluation.explanation?.episode?.duplicateOf || null;
  return {
    alertId: row.id,
    tinyId: clean(row.atlassian_ops_tiny_id || row.tinyId) || null,
    title: clean(row.title || row.description) || null,
    priority: clean(row.priority || row.extracted_details?.normalized_alert?.priority || row.extractedDetails?.normalized_alert?.priority).toUpperCase() || null,
    status: clean(row.status).toUpperCase() || null,
    firstSeen,
    lastSeen,
    startMs: toMs(firstSeen) || 0,
    endMs: Math.max(toMs(lastSeen) || 0, toMs(firstSeen) || 0),
    recovered,
    recoveredAt,
    currentlyFiring,
    flapping: lifecycle.persistence?.flapping === true,
    acknowledged: intervention.acknowledged === true || row.acknowledged === true,
    investigated,
    remediated,
    escalated,
    operatorActionObserved,
    explicitIncident,
    confirmedNoise,
    correlationConfirmed,
    duplicateOf,
    addsOperationalInformation: explicitIncident || investigated || remediated || escalated || recovered,
    latestDecision: evaluation.finalDecision,
    decisionBasis: evaluation.explanation?.decisionBasis || null,
    noiseType: evaluation.explanation?.noiseType || null,
    episodeDecision: evaluation.explanation?.episode?.episodeDecision || null,
    episodeDecisionBasis: evaluation.explanation?.episode?.episodeDecisionBasis || null,
    ...sourceIdentity,
  };
}

function episodeSummary(episode, roles, episodeGroupingBasis, options = {}) {
  const members = episode.members;
  const durations = members.map((item) => item.endMs).filter(Number.isFinite);
  const firstSeenMs = Math.min(...members.map((item) => item.startMs));
  const lastSeenMs = Math.max(...durations, firstSeenMs);
  const latest = [...members].sort((left, right) => right.startMs - left.startMs)[0];
  const recordedEpisodeDecision = members.find((item) => item.episodeDecision)?.episodeDecision || null;
  const recordedEpisodeDecisionBasis = members.find((item) => item.episodeDecisionBasis)?.episodeDecisionBasis || null;
  return {
    episodeId: episode.episodeId,
    fingerprintHash: episode.fingerprintHash,
    historicalFingerprintHash: members[0].historicalFingerprintHash || episode.fingerprintHash,
    fingerprintStrength: members[0].identityStrength,
    fingerprintComponents: members[0].fingerprintComponents,
    source: members[0].source || 'Unsupported/Unknown',
    canonicalEntity: members[0].canonicalEntity,
    entityFingerprint: members[0].entityFingerprint,
    ruleEvent: members[0].ruleEvent,
    environment: members[0].environment,
    firstSeen: toIso(firstSeenMs),
    lastSeen: toIso(lastSeenMs),
    durationSeconds: Math.max(0, Math.round((lastSeenMs - firstSeenMs) / 1000)),
    notificationCount: members.length,
    alertIds: members.map((item) => item.alertId),
    episodeGroupingBasis,
    episodeIdentityStatus: episodeGroupingBasis === EPISODE_GROUPING_BASIS.UNRESOLVED_IDENTITY_ISOLATED
      ? 'IDENTITY_UNCONFIRMED' : 'IDENTITY_CONFIRMED',
    groupingEvidence: unique(members.map((item) => item.groupingReason)),
    groupingEvidenceIds: unique(members.flatMap((item) => item.groupingEvidenceIds || [])),
    migrationRequired: options.migrationRequired === true,
    legacyGroupingDisposition: options.migrationRequired === true
      ? 'LEGACY_GROUPING_REQUIRES_REPLAY' : null,
    roles,
    lifecycle: {
      currentlyFiring: members.some((item) => item.currentlyFiring) && !latest.recovered,
      recovered: members.some((item) => item.recovered),
      recoveredAt: members.map((item) => item.recoveredAt).filter(Boolean).sort().at(-1) || null,
      flapping: members.some((item) => item.flapping),
      firingObservations: members.filter((item) => item.currentlyFiring).length,
      recoveryObservations: members.filter((item) => item.recovered).length,
    },
    intervention: {
      acknowledged: members.some((item) => item.acknowledged),
      investigated: members.some((item) => item.investigated),
      remediated: members.some((item) => item.remediated),
      escalated: members.some((item) => item.escalated),
      operatorActionObserved: members.some((item) => item.operatorActionObserved),
    },
    relationships: {
      jiraIncident: members.some((item) => item.explicitIncident),
      slackAcknowledgement: members.some((item) => item.acknowledged),
      correlated: members.some((item) => item.correlationConfirmed),
    },
    humanOutcome: {
      confirmedIncident: members.some((item) => item.explicitIncident),
      confirmedNoise: members.some((item) => item.confirmedNoise),
    },
    episodeDecision: recordedEpisodeDecision,
    episodeDecisionBasis: recordedEpisodeDecisionBasis,
    members,
  };
}

function summarizeLegacyEpisode(episode) {
  const members = episode.members;
  const roles = {};
  members.forEach((member, index) => {
    let role = 'PRIMARY';
    if (index > 0 && member.recovered) role = 'RECOVERY';
    else if (index > 0 && member.correlationConfirmed) role = 'CORRELATED';
    else if (index > 0) {
      const sameNativeOccurrence = member.nativeOccurrenceId && members.slice(0, index)
        .some((candidate) => candidate.nativeOccurrenceId === member.nativeOccurrenceId);
      const explicitDuplicate = Boolean(member.duplicateOf);
      role = (sameNativeOccurrence || explicitDuplicate) && !member.addsOperationalInformation ? 'DUPLICATE' : 'REPEAT';
    }
    roles[member.alertId] = {
      role,
      addsOperationalInformation: member.addsOperationalInformation,
      duplicateOf: role === 'DUPLICATE' ? (member.duplicateOf || members[0].alertId) : null,
      primaryAlertId: members[0].alertId,
      reason: role === 'PRIMARY' ? 'First independently useful notification for this legacy time-window episode.'
        : role === 'RECOVERY' ? 'Stored lifecycle indicates recovery inside the legacy episode.'
          : role === 'CORRELATED' ? 'Stored correlation marked this alert as related.'
            : role === 'DUPLICATE' ? 'Legacy grouping treated the same source occurrence as a duplicate.'
              : 'Legacy grouping treated this later, time-adjacent notification as a repeat.',
      episodeGroupingBasis: 'TIME_WINDOW_ONLY',
    };
  });
  return episodeSummary(episode, roles, 'TIME_WINDOW_ONLY', { migrationRequired: true });
}

function buildEpisodesLegacy(rows = [], { inactivityMs = EPISODE_INACTIVITY_MS } = {}) {
  const observations = rows.map((row) => episodeObservation(row, { occurrenceAware: false }))
    .filter((item) => item.startMs > 0);
  const groups = new Map();
  observations.forEach((item) => {
    if (!groups.has(item.fingerprintHash)) groups.set(item.fingerprintHash, []);
    groups.get(item.fingerprintHash).push(item);
  });
  const episodes = [];
  for (const [fingerprintHash, candidates] of groups) {
    candidates.sort((left, right) => left.startMs - right.startMs || left.alertId.localeCompare(right.alertId));
    let current = null;
    for (const candidate of candidates) {
      const recoveredBoundary = current?.members.map((item) => toMs(item.recoveredAt)).filter(Number.isFinite).sort((a, b) => b - a)[0];
      const beyondRecovery = current && Number.isFinite(recoveredBoundary) && candidate.startMs > recoveredBoundary;
      const beyondInactivity = current && candidate.startMs > current.lastActivityMs + inactivityMs;
      if (!current || beyondRecovery || beyondInactivity) {
        if (current) episodes.push(summarizeLegacyEpisode(current));
        current = {
          episodeId: `episode-${hash(`${fingerprintHash}|${candidate.alertId}|${candidate.firstSeen}`)}`,
          fingerprintHash,
          members: [],
          lastActivityMs: candidate.endMs,
        };
      }
      current.members.push(candidate);
      current.lastActivityMs = Math.max(current.lastActivityMs, candidate.endMs);
    }
    if (current) episodes.push(summarizeLegacyEpisode(current));
  }
  episodes.sort((left, right) => toMs(right.firstSeen) - toMs(left.firstSeen));
  const membership = new Map();
  episodes.forEach((episode) => episode.alertIds.forEach((alertId) => membership.set(alertId, {
    ...episode,
    notificationRole: episode.roles[alertId],
    members: undefined,
    roles: undefined,
  })));
  return { episodes, membership, observations, policyVersion: LEGACY_EPISODE_POLICY_VERSION };
}

function duplicateTargetPresent(candidate, members) {
  if (!candidate.duplicateOf) return false;
  const target = clean(candidate.duplicateOf);
  return members.some((member) => [member.alertId, member.tinyId].map(clean).includes(target));
}

function sourceIdentityCompatible(left, right) {
  if (!left || !right || left.source !== right.source) return false;
  if (left.exactOccurrenceKey || right.exactOccurrenceKey) {
    return Boolean(left.exactOccurrenceKey && left.exactOccurrenceKey === right.exactOccurrenceKey);
  }
  if (left.structuredLifecycleKey || right.structuredLifecycleKey) {
    return Boolean(left.structuredLifecycleKey && left.structuredLifecycleKey === right.structuredLifecycleKey);
  }
  return Boolean(left.sourceAlias && right.sourceAlias && normalize(left.sourceAlias) === normalize(right.sourceAlias));
}

function afterRecoveryBoundary(current, candidate) {
  const recoveredAt = current.members.map((member) => toMs(member.recoveredAt))
    .filter(Number.isFinite).sort((left, right) => right - left)[0];
  if (!Number.isFinite(recoveredAt)) return false;
  return candidate.startMs > recoveredAt || (candidate.startMs === recoveredAt && !candidate.recovered);
}

function episodeContinuation(current, candidate) {
  if (!current || afterRecoveryBoundary(current, candidate)) return null;
  const compatible = current.members.filter((member) => sourceIdentityCompatible(member, candidate));
  if (!compatible.length) return null;
  const relationshipTarget = candidate.explicitRenotification.relationship;
  const relationshipMatches = relationshipTarget && compatible.some((member) => (
    [member.alertId, member.tinyId, member.nativeOccurrenceId, member.sourceAlias].map(clean)
      .includes(clean(relationshipTarget))
  ));
  if (candidate.explicitRenotification.observed
    && (relationshipMatches || candidate.exactOccurrenceKey || candidate.structuredLifecycleKey || candidate.sourceAlias)) {
    return {
      basis: EPISODE_GROUPING_BASIS.EXPLICIT_RENOTIFICATION,
      reason: candidate.explicitRenotification.reason,
    };
  }
  const explicitDuplicate = duplicateTargetPresent(candidate, compatible);
  const differentNotificationPath = candidate.notificationPath && compatible.some((member) => (
    member.notificationPath && normalize(member.notificationPath) !== normalize(candidate.notificationPath)
  ));
  if (explicitDuplicate || (candidate.exactOccurrenceKey && differentNotificationPath)) {
    return {
      basis: EPISODE_GROUPING_BASIS.DUPLICATE_UNDERLYING_OCCURRENCE,
      reason: explicitDuplicate
        ? 'An explicit relationship proves an independent notification of the same exact source occurrence.'
        : 'The exact source occurrence was delivered through a different independently identified notification path.',
    };
  }
  if (candidate.exactOccurrenceKey) {
    const lifecycleProvesContinuation = candidate.authoritativeLifecycle.available
      && (candidate.authoritativeLifecycle.currentlyFiring || candidate.authoritativeLifecycle.recovered);
    if (lifecycleProvesContinuation) {
      return {
        basis: EPISODE_GROUPING_BASIS.EXACT_SOURCE_OCCURRENCE,
        reason: candidate.recovered
          ? 'Authoritative recovery belongs to the same exact source occurrence.'
          : 'The exact source occurrence identity remains authoritatively active.',
      };
    }
    return null;
  }
  if (candidate.structuredLifecycleKey) {
    const lifecycleProvesContinuation = candidate.authoritativeLifecycle.available
      && (candidate.authoritativeLifecycle.currentlyFiring || candidate.authoritativeLifecycle.recovered);
    if (lifecycleProvesContinuation) {
      return {
        basis: EPISODE_GROUPING_BASIS.STRUCTURED_IDENTITY_CONTINUITY,
        reason: 'Exact structured source identity and the same authoritative lifecycle start establish continuity.',
      };
    }
  }
  return null;
}

function initialGroupingBasis(candidate) {
  if (candidate.exactOccurrenceKey) return EPISODE_GROUPING_BASIS.EXACT_SOURCE_OCCURRENCE;
  if (candidate.structuredLifecycleKey) return EPISODE_GROUPING_BASIS.STRUCTURED_IDENTITY_CONTINUITY;
  return EPISODE_GROUPING_BASIS.UNRESOLVED_IDENTITY_ISOLATED;
}

function summarizeOccurrenceAwareEpisode(episode) {
  const members = episode.members;
  const roles = {};
  members.forEach((member, index) => {
    let role = 'PRIMARY';
    if (index > 0 && member.recovered) role = 'RECOVERY';
    else if (index > 0 && member.correlationConfirmed) role = 'CORRELATED';
    else if (index > 0 && (
      member.groupingBasis === EPISODE_GROUPING_BASIS.DUPLICATE_UNDERLYING_OCCURRENCE
      || duplicateTargetPresent(member, members.slice(0, index))
    )) role = 'DUPLICATE';
    else if (index > 0) role = 'REPEAT';
    roles[member.alertId] = {
      role,
      addsOperationalInformation: member.addsOperationalInformation,
      duplicateOf: role === 'DUPLICATE' ? member.duplicateOf : null,
      primaryAlertId: members[0].alertId,
      reason: role === 'PRIMARY' ? (member.identityStatus === 'IDENTITY_UNCONFIRMED'
        ? 'Identity is unconfirmed, so this alert is isolated as its own primary episode.'
        : 'This is the first independently useful notification for the confirmed source occurrence.')
        : role === 'RECOVERY' ? 'Authoritative source lifecycle proves recovery for this same occurrence.'
          : role === 'CORRELATED' ? 'Confirmed structured correlation adds evidence to this exact occurrence.'
            : role === 'DUPLICATE' ? 'An explicit relationship proves an independent notification of the same source occurrence.'
              : member.groupingReason || 'The same confirmed occurrence remains active and generated a later notification.',
      episodeGroupingBasis: member.groupingBasis,
      groupingEvidenceIds: member.groupingEvidenceIds || [],
    };
  });
  const continuationBases = unique(members.slice(1).map((member) => member.groupingBasis));
  const episodeGroupingBasis = continuationBases.length === 1
    ? continuationBases[0] : members[0].groupingBasis;
  return episodeSummary(episode, roles, episodeGroupingBasis);
}

function buildEpisodes(rows = []) {
  const observations = rows.map((row) => episodeObservation(row, { occurrenceAware: true }))
    .filter((item) => item.startMs > 0);
  const groups = new Map();
  observations.forEach((item) => {
    if (!groups.has(item.continuityBucketKey)) groups.set(item.continuityBucketKey, []);
    groups.get(item.continuityBucketKey).push(item);
  });
  const episodes = [];
  for (const [continuityBucketKey, candidates] of groups) {
    candidates.sort((left, right) => left.startMs - right.startMs || left.alertId.localeCompare(right.alertId));
    let current = null;
    for (const candidate of candidates) {
      const continuation = episodeContinuation(current, candidate);
      if (!current || !continuation) {
        if (current) episodes.push(summarizeOccurrenceAwareEpisode(current));
        candidate.groupingBasis = initialGroupingBasis(candidate);
        candidate.groupingReason = candidate.groupingBasis === EPISODE_GROUPING_BASIS.UNRESOLVED_IDENTITY_ISOLATED
          ? 'No authoritative occurrence identity and continuous source lifecycle were available; time proximity was ignored.'
          : candidate.groupingBasis === EPISODE_GROUPING_BASIS.EXACT_SOURCE_OCCURRENCE
            ? 'The episode is anchored to an authoritative source occurrence identity.'
            : 'The episode is anchored to exact structured identity and authoritative lifecycle evidence.';
        candidate.groupingEvidenceIds = groupingEvidenceIds(candidate, candidate.groupingBasis);
        current = {
          episodeId: `episode-${hash(`${continuityBucketKey}|${candidate.alertId}|${candidate.firstSeen}`)}`,
          fingerprintHash: candidate.fingerprintHash,
          members: [candidate],
        };
        continue;
      }
      candidate.groupingBasis = continuation.basis;
      candidate.groupingReason = continuation.reason;
      candidate.groupingEvidenceIds = groupingEvidenceIds(candidate, continuation.basis);
      current.members.push(candidate);
    }
    if (current) episodes.push(summarizeOccurrenceAwareEpisode(current));
  }
  episodes.sort((left, right) => toMs(right.firstSeen) - toMs(left.firstSeen));
  const membership = new Map();
  episodes.forEach((episode) => episode.alertIds.forEach((alertId) => membership.set(alertId, {
    ...episode,
    notificationRole: episode.roles[alertId],
    members: undefined,
    roles: undefined,
  })));
  return { episodes, membership, observations, policyVersion: EPISODE_POLICY_VERSION };
}

function historicalBehaviorFor(currentEpisode, historicalEpisodes = []) {
  const currentHistoricalFingerprint = currentEpisode.historicalFingerprintHash || currentEpisode.fingerprintHash;
  const prior = historicalEpisodes.filter((episode) => (
    episode.historicalFingerprintHash || episode.fingerprintHash
  ) === currentHistoricalFingerprint
    && toMs(episode.firstSeen) < toMs(currentEpisode.firstSeen)
    && episode.episodeId !== currentEpisode.episodeId);
  const notifications = prior.reduce((sum, episode) => sum + episode.notificationCount, 0);
  const repeats = prior.reduce((sum, episode) => sum + Object.values(episode.roles).filter((item) => item.role === 'REPEAT').length, 0);
  const duplicates = prior.reduce((sum, episode) => sum + Object.values(episode.roles).filter((item) => item.role === 'DUPLICATE').length, 0);
  const durations = prior.map((episode) => episode.durationSeconds).filter(Number.isFinite);
  const count = prior.length;
  const rate = (value) => count ? Number((value / count).toFixed(6)) : null;
  const isClosed = (episode) => episode.members.some((member) => (
    /^(CLOSED|RESOLVED|RECOVERED|CLEARED)$/.test(member.status || '')
  ));
  const acknowledgedCount = prior.filter((episode) => episode.intervention.acknowledged).length;
  const investigatedCount = prior.filter((episode) => episode.intervention.investigated).length;
  const remediatedCount = prior.filter((episode) => episode.intervention.remediated).length;
  const escalatedCount = prior.filter((episode) => episode.intervention.escalated).length;
  const jiraIncidentAssociationCount = prior.filter((episode) => episode.relationships.jiraIncident).length;
  const closedWithoutInvestigationCount = prior.filter((episode) => (
    isClosed(episode) && !episode.intervention.investigated
  )).length;
  const closedWithoutRemediationCount = prior.filter((episode) => (
    isClosed(episode) && !episode.intervention.remediated
  )).length;
  const closedWithoutEscalationCount = prior.filter((episode) => (
    isClosed(episode) && !episode.intervention.escalated
  )).length;
  const closedWithoutAnyMeaningfulActionCount = prior.filter((episode) => (
    isClosed(episode)
      && !episode.intervention.investigated
      && !episode.intervention.remediated
      && !episode.intervention.escalated
      && !episode.relationships.jiraIncident
  )).length;
  const acknowledgedRate = rate(acknowledgedCount);
  const closedWithoutAnyMeaningfulActionRate = rate(closedWithoutAnyMeaningfulActionCount);
  const strongOperationalNonActionability = count >= OPERATIONAL_HISTORY_MIN_EPISODES
    && Number(acknowledgedRate || 0) >= OPERATIONAL_HISTORY_MIN_ACKNOWLEDGED_RATE
    && Number(closedWithoutAnyMeaningfulActionRate || 0) >= OPERATIONAL_HISTORY_MIN_CLOSED_WITHOUT_ACTION_RATE
    && investigatedCount === 0
    && remediatedCount === 0
    && escalatedCount === 0
    && jiraIncidentAssociationCount === 0;
  return {
    windowDays: EPISODE_HISTORY_DAYS,
    matchMethod: 'EXACT_SOURCE_IDENTITY_EPISODE_FINGERPRINT',
    episodeCount: count,
    notificationsPerEpisode: count ? Number((notifications / count).toFixed(4)) : null,
    repeatRate: notifications ? Number((repeats / notifications).toFixed(6)) : null,
    duplicateRate: notifications ? Number((duplicates / notifications).toFixed(6)) : null,
    autoRecoveryRate: rate(prior.filter((episode) => episode.lifecycle.recovered
      && !episode.intervention.operatorActionObserved).length),
    flappingRate: rate(prior.filter((episode) => episode.lifecycle.flapping).length),
    medianEpisodeDurationSeconds: percentile(durations, 0.5),
    p95EpisodeDurationSeconds: percentile(durations, 0.95),
    incidentAssociationRate: rate(jiraIncidentAssociationCount),
    noiseAssociationRate: rate(prior.filter((episode) => episode.humanOutcome.confirmedNoise).length),
    interventionRate: rate(prior.filter((episode) => episode.intervention.operatorActionObserved).length),
    operationalHandling: {
      totalEpisodeCount: count,
      acknowledgedCount,
      acknowledgedRate,
      investigatedCount,
      investigatedRate: rate(investigatedCount),
      remediatedCount,
      remediatedRate: rate(remediatedCount),
      escalatedCount,
      escalatedRate: rate(escalatedCount),
      jiraIncidentAssociationCount,
      jiraIncidentAssociationRate: rate(jiraIncidentAssociationCount),
      closedWithoutInvestigationCount,
      closedWithoutInvestigationRate: rate(closedWithoutInvestigationCount),
      closedWithoutRemediationCount,
      closedWithoutRemediationRate: rate(closedWithoutRemediationCount),
      closedWithoutEscalationCount,
      closedWithoutEscalationRate: rate(closedWithoutEscalationCount),
      closedWithoutAnyMeaningfulActionCount,
      closedWithoutAnyMeaningfulActionRate,
    },
    strongOperationalNonActionability: {
      supported: strongOperationalNonActionability,
      supportRole: 'SUPPORTING_EVIDENCE_ONLY',
      threshold: {
        minimumExactPriorEpisodes: OPERATIONAL_HISTORY_MIN_EPISODES,
        minimumAcknowledgedRate: OPERATIONAL_HISTORY_MIN_ACKNOWLEDGED_RATE,
        minimumClosedWithoutAnyMeaningfulActionRate: OPERATIONAL_HISTORY_MIN_CLOSED_WITHOUT_ACTION_RATE,
        maximumInvestigatedCount: 0,
        maximumRemediatedCount: 0,
        maximumEscalatedCount: 0,
        maximumJiraIncidentAssociationCount: 0,
      },
      canOverrideCurrentOpenOrFiringLifecycle: false,
    },
    provenance: 'Stored exact-fingerprint episodes only; missing source lifecycle remains unavailable.',
  };
}

function episodeDiagnostics(snapshot, incidentBaseline = null) {
  const episodes = snapshot.episodes || [];
  const memberships = [...snapshot.membership.values()];
  const roleCount = (role) => memberships.filter((item) => item.notificationRole?.role === role).length;
  const episodeDecision = (episode) => episode.episodeDecision || 'REVIEW';
  const incidentEpisodes = episodes.filter((item) => episodeDecision(item) === 'INCIDENT').length;
  const baselineP95 = incidentBaseline?.p95 ?? null;
  const anomaly = baselineP95 !== null && incidentBaseline?.daysObserved >= 14 && incidentEpisodes > baselineP95;
  const countBy = (values) => [...values.reduce((counts, value) => {
    if (value) counts.set(value, Number(counts.get(value) || 0) + 1);
    return counts;
  }, new Map())].map(([key, count]) => ({ key, count }))
    .sort((left, right) => right.count - left.count || left.key.localeCompare(right.key));
  const representative = (decision) => episodes.filter((item) => episodeDecision(item) === decision)
    .slice(0, 3).map((item) => ({
      episodeId: item.episodeId,
      source: item.source,
      canonicalEntity: item.canonicalEntity,
      ruleEvent: item.ruleEvent,
      firstSeen: item.firstSeen,
      lastSeen: item.lastSeen,
      notificationCount: item.notificationCount,
      alertIds: item.members.map((member) => member.tinyId || member.alertId),
      decision,
      decisionBasis: item.episodeDecisionBasis,
      lifecycle: item.lifecycle,
      intervention: item.intervention,
      relationships: item.relationships,
    }));
  return {
    generatedAt: new Date().toISOString(),
    window: { hours: EPISODE_WINDOW_HOURS, inactivityMinutes: EPISODE_INACTIVITY_MS / 60000 },
    groupingActivation: {
      mode: snapshot.groupingActivationMode || null,
      enabled: snapshot.occurrenceAwareGroupingEnabled === true,
      activatedAt: snapshot.activationAt || null,
      preActivationAlertsPreserved: Number(snapshot.preActivationAlertCount || 0),
      legacyAlertsRequiringReplay: Number(snapshot.legacyAlertCount || 0),
      legacyDisposition: snapshot.legacyGroupingDisposition || null,
    },
    totalAlerts: snapshot.observations.length,
    totalEpisodes: episodes.length,
    averageNotificationsPerEpisode: episodes.length
      ? Number((snapshot.observations.length / episodes.length).toFixed(4)) : null,
    alertsToEpisodesCompressionRatio: snapshot.observations.length
      ? Number((episodes.length / snapshot.observations.length).toFixed(6)) : null,
    episodesWithMultipleNotifications: episodes.filter((item) => item.notificationCount > 1).length,
    notificationRoles: {
      primary: roleCount('PRIMARY'), repeat: roleCount('REPEAT'), duplicate: roleCount('DUPLICATE'),
      correlated: roleCount('CORRELATED'), recovery: roleCount('RECOVERY'),
    },
    lifecycle: {
      recoveredEpisodes: episodes.filter((item) => item.lifecycle.recovered).length,
      flappingEpisodes: episodes.filter((item) => item.lifecycle.flapping).length,
      autoResolvedEpisodes: episodes.filter((item) => item.lifecycle.recovered
        && !item.intervention.operatorActionObserved).length,
      informationalEpisodes: episodes.filter((item) => item.members.some((member) => ['P4', 'P5'].includes(member.priority))).length,
      operationallyNonActionableEpisodes: episodes.filter((item) => item.members.some((member) => (
        member.noiseType === 'OPERATIONALLY_NON_ACTIONABLE'
      ))).length,
    },
    episodeDecisions: {
      incident: incidentEpisodes,
      noise: episodes.filter((item) => episodeDecision(item) === 'NOISE').length,
      review: episodes.filter((item) => episodeDecision(item) === 'REVIEW').length,
    },
    topRepeatedSourceEntities: episodes.filter((item) => item.notificationCount > 1)
      .sort((left, right) => right.notificationCount - left.notificationCount
        || String(left.source).localeCompare(String(right.source)))
      .slice(0, 10).map((item) => ({
        source: item.source,
        canonicalEntity: item.canonicalEntity,
        ruleEvent: item.ruleEvent,
        identity: item.canonicalEntity || item.ruleEvent
          || item.fingerprintComponents?.ruleEvent?.[0] || 'UNRESOLVED',
        representativeAlert: item.members[0]?.title || null,
        notificationCount: item.notificationCount,
        episodeId: item.episodeId,
      })),
    topNoiseReasons: countBy(episodes.flatMap((item) => item.members)
      .filter((member) => member.latestDecision === 'NOISE')
      .map((member) => member.noiseType || member.decisionBasis || 'UNSPECIFIED')),
    incidentDecisionPaths: countBy(episodes.filter((item) => episodeDecision(item) === 'INCIDENT')
      .map((item) => item.episodeDecisionBasis || 'UNSPECIFIED')),
    representativeEpisodes: {
      incident: representative('INCIDENT'),
      noise: representative('NOISE'),
      review: representative('REVIEW'),
    },
    expectedIncidentVolumeAnomaly: {
      metric: 'EXPECTED_INCIDENT_VOLUME_ANOMALY',
      triggered: anomaly,
      currentIncidentEpisodes: incidentEpisodes,
      historicalDailyMedian: incidentBaseline?.median ?? null,
      historicalDailyP95: baselineP95,
      historicalDaysObserved: incidentBaseline?.daysObserved ?? 0,
      classificationEffect: 'NONE',
    },
    readOnly: true,
    automaticActions: 'DISABLED',
    externalMutations: 0,
  };
}

const SELECT_COLUMNS = `
  alert.id, alert.atlassian_ops_tiny_id, alert.title, alert.description, alert.signal,
  alert.source, alert.raw_payload, alert.extracted_details, alert.received_at, alert.last_seen_at,
  alert.status, alert.severity, alert.environment, alert.service, alert.acknowledged,
  alert.escalation_status, alert.learning_alert_signature_v1, alert.learning_entity_key_v1,
  evaluation.final_decision AS evaluation_final_decision,
  evaluation.source AS evaluation_source,
  evaluation.notification_role AS evaluation_notification_role,
  evaluation.feature_snapshot AS evaluation_feature_snapshot,
  evaluation.technical_evidence AS evaluation_technical_evidence,
  evaluation.explanation AS evaluation_explanation,
  evaluation.evidence_references AS evaluation_evidence_references,
  TO_JSONB(appd_occurrence) AS appdynamics_occurrence_evidence,
  TO_JSONB(grafana_occurrence) AS grafana_occurrence_evidence,
  TO_JSONB(nagios_occurrence) AS nagios_occurrence_evidence,
  EXISTS (SELECT 1 FROM alert_incident_mappings mapping WHERE mapping.alert_id = alert.id)
    OR EXISTS (SELECT 1 FROM incident_alert_reconciliations reconciliation
      WHERE reconciliation.alert_id = alert.id AND reconciliation.current
        AND reconciliation.relationship_state = 'CONFIRMED_MATCH') AS explicit_incident,
  EXISTS (SELECT 1 FROM alert_occurrence_outcomes outcome
    WHERE outcome.alert_id = alert.id AND outcome.is_current
      AND outcome.outcome = 'CONFIRMED_NOISE') AS confirmed_noise`;

function createAlertEpisodeService({
  database = db,
  now = () => Date.now(),
  occurrenceAware = String(process.env.OCCURRENCE_AWARE_EPISODE_GROUPING_ENABLED || 'false').toLowerCase() === 'true',
  activationAt = process.env.OCCURRENCE_AWARE_EPISODE_GROUPING_ACTIVATED_AT || null,
} = {}) {
  let cache = { expiresAt: 0, promise: null };
  const episodeBuilder = occurrenceAware ? buildEpisodes : buildEpisodesLegacy;
  const activationMs = toMs(activationAt);

  function currentGroupingSnapshot(rows) {
    const unboundedSnapshot = episodeBuilder(rows);
    if (!occurrenceAware || activationMs === null) return {
      ...unboundedSnapshot,
      legacyAlertCount: occurrenceAware ? 0 : rows.length,
      legacyGroupingDisposition: occurrenceAware ? null : 'LEGACY_GROUPING_PRESERVED',
    };

    const legacyRows = rows.filter((row) => {
      const receivedAt = toMs(row.received_at || row.receivedAt || row.created_at || row.createdAt);
      return receivedAt !== null && receivedAt < activationMs;
    });
    if (!legacyRows.length) return {
      ...unboundedSnapshot,
      activationAt: toIso(activationMs),
      legacyAlertCount: 0,
      legacyGroupingDisposition: null,
    };

    const liveRows = rows.filter((row) => {
      const receivedAt = toMs(row.received_at || row.receivedAt || row.created_at || row.createdAt);
      return receivedAt !== null && receivedAt >= activationMs;
    });
    const legacy = buildEpisodesLegacy(legacyRows);
    const live = buildEpisodes(liveRows);
    const membership = new Map(live.membership);
    const replayRequiredAlertIds = new Set(legacy.episodes.flatMap((episode) => episode.members)
      .filter((member) => member.latestDecision === 'NOISE' && member.noiseType === 'REPEAT')
      .map((member) => member.alertId));
    legacy.membership.forEach((context, alertId) => membership.set(alertId, {
      ...context,
      migrationRequired: replayRequiredAlertIds.has(alertId),
      legacyGroupingDisposition: replayRequiredAlertIds.has(alertId)
        ? 'LEGACY_GROUPING_REQUIRES_REPLAY' : 'LEGACY_GROUPING_PRESERVED',
    }));
    const legacyEpisodes = legacy.episodes.map((episode) => {
      const migrationRequired = episode.alertIds.some((alertId) => replayRequiredAlertIds.has(alertId));
      return {
        ...episode,
        migrationRequired,
        legacyGroupingDisposition: migrationRequired
          ? 'LEGACY_GROUPING_REQUIRES_REPLAY' : 'LEGACY_GROUPING_PRESERVED',
      };
    });
    const episodes = [...legacyEpisodes, ...live.episodes]
      .sort((left, right) => toMs(right.firstSeen) - toMs(left.firstSeen));
    return {
      episodes,
      membership,
      observations: [...legacy.observations, ...live.observations],
      policyVersion: EPISODE_POLICY_VERSION,
      activationAt: toIso(activationMs),
      preActivationAlertCount: legacyRows.length,
      legacyAlertCount: replayRequiredAlertIds.size,
      legacyGroupingDisposition: replayRequiredAlertIds.size
        ? 'LEGACY_GROUPING_REQUIRES_REPLAY' : 'LEGACY_GROUPING_PRESERVED',
    };
  }

  async function incidentBaseline() {
    const result = await database.query(`
      WITH days AS (
        SELECT GENERATE_SERIES(
          DATE_TRUNC('day', NOW()) - INTERVAL '89 days',
          DATE_TRUNC('day', NOW()), INTERVAL '1 day'
        ) AS day
      ), counts AS (
        SELECT DATE_TRUNC('day', incident_created_at) AS day, COUNT(*)::int AS count
        FROM operations_incidents
        WHERE incident_created_at >= NOW() - INTERVAL '90 days'
        GROUP BY 1
      ), population AS (
        SELECT days.day, COALESCE(counts.count, 0)::int AS count
        FROM days LEFT JOIN counts USING (day)
      )
      SELECT COUNT(*)::int AS days_observed,
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY count)::numeric AS median,
        PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY count)::numeric AS p95
      FROM population
    `);
    return {
      daysObserved: Number(result.rows[0]?.days_observed || 0),
      median: result.rows[0]?.median === null ? null : Number(result.rows[0]?.median),
      p95: result.rows[0]?.p95 === null ? null : Number(result.rows[0]?.p95),
    };
  }

  async function buildSnapshot({ refresh = false } = {}) {
    if (!refresh && cache.promise && cache.expiresAt > now()) return cache.promise;
    const promise = (async () => {
      const currentResult = await database.query(`
        SELECT ${SELECT_COLUMNS}
        FROM alerts alert
        LEFT JOIN live_shadow_evaluations_latest_v1 evaluation ON evaluation.alert_id = alert.id
        LEFT JOIN appdynamics_alert_occurrence_evidence appd_occurrence ON appd_occurrence.alert_id = alert.id
        LEFT JOIN grafana_alert_occurrence_evidence grafana_occurrence ON grafana_occurrence.alert_id = alert.id
        LEFT JOIN nagios_alert_occurrence_evidence nagios_occurrence ON nagios_occurrence.alert_id = alert.id
        WHERE alert.atlassian_ops_alert_id IS NOT NULL
          AND alert.received_at >= NOW() - INTERVAL '${EPISODE_WINDOW_HOURS} hours'
        ORDER BY alert.received_at, alert.id
      `);
      const current = currentGroupingSnapshot(currentResult.rows);
      const signatures = unique(currentResult.rows.map((row) => row.learning_alert_signature_v1));
      const entities = unique(currentResult.rows.map((row) => row.learning_entity_key_v1));
      let historicalEpisodes = [];
      if (signatures.length || entities.length) {
        const historyResult = await database.query(`
          WITH ranked AS (
            SELECT alert.*,
              ROW_NUMBER() OVER (
                PARTITION BY COALESCE(alert.learning_entity_key_v1, alert.learning_alert_signature_v1, alert.id)
                ORDER BY alert.received_at DESC, alert.id
              ) AS identity_rank
            FROM alerts alert
            WHERE alert.atlassian_ops_alert_id IS NOT NULL
              AND alert.received_at >= NOW() - INTERVAL '${EPISODE_HISTORY_DAYS} days'
              AND (alert.learning_alert_signature_v1 = ANY($1::text[])
                OR alert.learning_entity_key_v1 = ANY($2::text[]))
          )
          SELECT ${SELECT_COLUMNS.replaceAll('alert.', 'ranked.')}
          FROM ranked
          LEFT JOIN live_shadow_evaluations_latest_v1 evaluation ON evaluation.alert_id = ranked.id
          LEFT JOIN appdynamics_alert_occurrence_evidence appd_occurrence ON appd_occurrence.alert_id = ranked.id
          LEFT JOIN grafana_alert_occurrence_evidence grafana_occurrence ON grafana_occurrence.alert_id = ranked.id
          LEFT JOIN nagios_alert_occurrence_evidence nagios_occurrence ON nagios_occurrence.alert_id = ranked.id
          WHERE ranked.identity_rank <= ${MAX_HISTORY_PER_IDENTITY}
          ORDER BY ranked.received_at, ranked.id
        `, [signatures, entities]);
        historicalEpisodes = episodeBuilder(historyResult.rows).episodes;
      }
      const episodes = current.episodes.map((episode) => ({
        ...episode,
        historicalBehavior: historicalBehaviorFor(episode, historicalEpisodes),
      }));
      const membership = new Map();
      episodes.forEach((episode) => episode.alertIds.forEach((alertId) => membership.set(alertId, {
        ...episode,
        notificationRole: episode.roles[alertId],
        members: undefined,
        roles: undefined,
      })));
      current.membership.forEach((context, alertId) => {
        if (String(context.legacyGroupingDisposition || '').startsWith('LEGACY_GROUPING_')) {
          membership.set(alertId, context);
        }
      });
      return {
        ...current,
        episodes,
        membership,
        historicalEpisodes,
        occurrenceAwareGroupingEnabled: occurrenceAware,
        groupingActivationMode: occurrenceAware
          ? activationMs === null ? 'OCCURRENCE_AWARE' : 'OCCURRENCE_AWARE_NEW_ALERTS_ONLY'
          : 'LEGACY_PRESERVED',
        activationAt: activationMs === null ? null : toIso(activationMs),
        legacyAlertCount: current.legacyAlertCount || 0,
        preActivationAlertCount: current.preActivationAlertCount || 0,
        legacyGroupingDisposition: current.legacyGroupingDisposition || null,
      };
    })();
    cache = { expiresAt: now() + SNAPSHOT_CACHE_MS, promise };
    try { return await promise; } catch (error) {
      cache = { expiresAt: 0, promise: null };
      throw error;
    }
  }

  async function contextForAlert(alertId, options = {}) {
    const snapshot = await buildSnapshot(options);
    return snapshot.membership.get(alertId) || null;
  }

  async function diagnostics(options = {}) {
    const snapshot = await buildSnapshot(options);
    const baseline = await incidentBaseline();
    return episodeDiagnostics(snapshot, baseline);
  }

  function invalidate() {
    cache = { expiresAt: 0, promise: null };
  }

  return { buildSnapshot, contextForAlert, diagnostics, incidentBaseline, invalidate };
}

module.exports = {
  EPISODE_GROUPING_BASIS,
  EPISODE_HISTORY_DAYS,
  EPISODE_INACTIVITY_MS,
  EPISODE_POLICY_VERSION,
  LEGACY_EPISODE_POLICY_VERSION,
  buildEpisodes,
  buildEpisodesLegacy,
  canonicalSource,
  createAlertEpisodeService,
  episodeDiagnostics,
  episodeObservation,
  historicalBehaviorFor,
  sourceAndIdentity,
  service: createAlertEpisodeService(),
};
