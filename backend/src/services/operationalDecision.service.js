const crypto = require('node:crypto');
const db = require('../config/db');
const { OPERATIONAL_DECISION_POLICY } = require('../config/operationalDecisionPolicy');
const { SOURCE_IDENTITY_CONFIG } = require('../config/sourceIdentity');
const { service: operationalSignalService } = require('./noiseOperationalSignal.service');
const {
  buildCommonEvidenceModel, positiveEventProof, recoveryProof, sourceProof, telemetryProof,
} = require('./operationalEvidenceModel.service');
const {
  buildCanonicalAlertAssessment,
  createCanonicalAssessmentAuditStore,
  createNoopCanonicalAssessmentAuditStore,
  summarizeCanonicalAssessments,
} = require('./canonicalAlertAssessment.service');
const { buildEvidencePlan, summarizeEvidenceRequirements } = require('./evidenceRequirement.service');
const { evaluateDecisionReadiness } = require('./decisionReadiness.service');
const { service: sourceIdentityService } = require('./sourceIdentity.service');

const REDUNDANT_NOISE_SUBTYPES = new Set([
  'REDUNDANT_REAL_EVENT', 'EXACT_DUPLICATE', 'FLAPPING_NOTIFICATION', 'REPEATED_RECOVERY',
]);

function cleanText(value) {
  return String(value ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') return Object.keys(value).sort().reduce((result, key) => {
    result[key] = stableValue(value[key]);
    return result;
  }, {});
  return value;
}

function hash(value, length = 32) {
  return crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(stableValue(value))).digest('hex').slice(0, length);
}

async function canonicalIdentityIndex(identityService = sourceIdentityService, options = {}) {
  try {
    const first = await identityService.getCoverage({
      range: '24h', page: 1, size: 100,
      sourceDiscovery: options.sourceDiscovery !== false,
    });
    const entities = [...(first.entities || [])];
    for (let page = 2; page <= Number(first.pagination?.totalPages || 1); page += 1) {
      const next = await identityService.getCoverage({
        range: '24h', page, size: 100,
        sourceDiscovery: options.sourceDiscovery !== false,
      });
      entities.push(...(next.entities || []));
    }
    const byOccurrence = new Map();
    entities.forEach((item) => (item.operationsIdentity?.operationsIds || []).forEach((id) => byOccurrence.set(String(id), item)));
    return { byPattern: new Map(entities.map((item) => [String(item.groupId), item])), byOccurrence, coverage: first };
  } catch (error) {
    return { byPattern: new Map(), byOccurrence: new Map(), coverage: null, safeError: cleanText(error.safeMessage || error.message) };
  }
}

function occurrenceSourceIdentity(occurrence, entity) {
  const resolved = (entity?.normalizedIdentities || []).find((item) => item.source === occurrence.source.name);
  if (resolved) return resolved;
  const state = occurrence.identity.conflicts ? 'CONFLICT' : occurrence.identity.accepted
    ? occurrence.identity.level : occurrence.identity.candidateOnly ? 'CANDIDATE' : 'UNKNOWN';
  return {
    source: occurrence.source.name, sourceEntityType: null,
    sourceEntityId: occurrence.identity.sourceEntityId, sourceEntityName: occurrence.identity.sourceEntityName || occurrence.identity.canonicalEntity,
    application: null, service: occurrence.identity.canonicalEntity, environment: occurrence.identity.environment,
    host: null, node: null, tier: null, businessTransaction: null, ruleId: null, ruleName: null,
    dashboardId: null, panelId: null, testId: null, targetId: null, hostId: null, serviceId: null,
    mappingState: state, mappingConfidence: occurrence.identity.accepted ? 75 : 0,
    evidenceUsed: occurrence.identity.accepted ? ['Existing accepted source mapping from the operational evidence model.'] : [],
    evidenceMissing: occurrence.identity.accepted ? [] : [`Deterministic ${occurrence.source.name} source identity`],
    reasoning: occurrence.identity.accepted ? 'Existing accepted source mapping remains available.' : 'No accepted deterministic source mapping is available.',
    resolverVersion: SOURCE_IDENTITY_CONFIG.resolverVersion, resolvedAt: new Date().toISOString(),
    handoffStatus: occurrence.identity.accepted ? 'IDENTITY_READY' : 'IDENTITY_INCOMPLETE',
  };
}

function evidenceRecord(tier, type, id, label, reason, source, timestamp = null) {
  return { tier, type, id: cleanText(id), label, reason, source, timestamp };
}

function sourceEvidenceUsed(occurrence) {
  if (occurrence.source.name === 'AppDynamics' && occurrence.appDynamicsWorkflow?.sourceRuleId === 'APPD_WORKFLOW_INCIDENT_SOURCE_NATIVE_V1') {
    return occurrence.appDynamicsWorkflow.evidenceUsed.map((item) => evidenceRecord(
      'A', item.type || 'SOURCE_NATIVE_VIOLATION', item.id, item.label,
      item.reason, 'AppDynamics', item.timestamp,
    ));
  }
  return occurrence.sourceNativeEvidence.filter((item) => item.authoritative && item.active).map((item) => evidenceRecord(
    'A', 'SOURCE_NATIVE_EVENT', item.id, `${item.source} source event`,
    'The accepted source identity, meaningful source state, and bounded timestamp establish an authoritative operational event.',
    item.source, item.timestamp,
  ));
}

function telemetryEvidenceUsed(occurrence) {
  if (occurrence.source.name === 'AppDynamics' && occurrence.appDynamicsWorkflow?.sourceRuleId === 'APPD_WORKFLOW_INCIDENT_SUSTAINED_TELEMETRY_V1') {
    return occurrence.appDynamicsWorkflow.evidenceUsed.map((item) => evidenceRecord(
      'B', item.type || 'SUSTAINED_DIRECT_TELEMETRY', item.id, item.label,
      item.reason, 'AppDynamics', item.timestamp,
    ));
  }
  return occurrence.telemetry.filter((item) => item.matched && item.sustained && item.active).map((item) => evidenceRecord(
    'B', 'DIRECT_TELEMETRY', item.id, `${item.source} direct telemetry`,
    'The telemetry matches the accepted entity and condition and proves sustained degradation in the bounded occurrence window.',
    item.source, item.timestamp,
  ));
}

function supportingEvidence(occurrence) {
  const rejected = [];
  (occurrence.jira.records || []).slice(0, 3).forEach((item) => rejected.push(evidenceRecord('C', 'SUPPORTING_CONTEXT', item.id,
    'Jira relationship', 'Jira is supporting evidence and did not independently choose this operator decision.', 'ACC Jira', item.timestamp)));
  (occurrence.slack.records || []).slice(0, 3).forEach((item) => rejected.push(evidenceRecord('C', 'SUPPORTING_CONTEXT', item.id,
    'Slack context', 'Slack is supporting context and did not independently choose this operator decision.', 'Slack', item.timestamp)));
  if (occurrence.operations.acknowledged) rejected.push(evidenceRecord('D', 'CONTEXT_ONLY', `operations-ack-${occurrence.occurrenceId}`,
    'Acknowledgement', 'Acknowledgement records handling but is not proof of Incident or Noise.', 'JSM Operations', occurrence.alert.createdAt));
  return rejected;
}

function reviewReason(occurrence) {
  if (occurrence.source.name === 'AppDynamics' && occurrence.appDynamicsWorkflow?.reviewRootCause) {
    const reasons = {
      NO_ENTITY: 'The AppDynamics entity required by this alert is unresolved.',
      NO_SOURCE_EVENT: 'No matching AppDynamics source event or violation establishes the event boundary.',
      NO_TELEMETRY: 'No matching AppDynamics source event or direct telemetry is available for the bounded occurrence window.',
      WRONG_METRIC: 'The returned AppDynamics metric does not match the alert condition.',
      WRONG_ENTITY: 'The AppDynamics evidence is for a different entity level than the alert.',
      PERSISTENCE_UNKNOWN: 'The AppDynamics evidence does not establish persistence or repeated degradation.',
      EVENT_BOUNDARY_UNKNOWN: 'The AppDynamics event lifecycle boundary remains unknown.',
      OTHER: 'The AppDynamics workflow evidence is incomplete or conflicting.',
    };
    return [occurrence.appDynamicsWorkflow.reviewRootCause, reasons[occurrence.appDynamicsWorkflow.reviewRootCause]];
  }
  if (occurrence.evidenceStatus.conflict) return ['CONFLICTING_EVIDENCE', 'Source identity or evidence contains an unresolved deterministic conflict.'];
  if (occurrence.identity.unavailable || occurrence.identity.candidateOnly || !occurrence.identity.accepted) return ['NO_MAPPING', 'No accepted exact, strong, or confirmed-local source mapping is available.'];
  if (occurrence.evidenceStatus.wrongMetricOrEntity) return ['WRONG_METRIC_OR_ENTITY', 'The source returned a wrong metric/entity outcome and the evidence was rejected.'];
  if (!occurrence.evidenceStatus.hasSourceEvidence) return ['NO_TELEMETRY', 'No source-native event or entity-scoped telemetry is available for the bounded occurrence window.'];
  if (occurrence.notificationRole.role === 'UNKNOWN') return ['UNKNOWN_NOTIFICATION_ROLE', 'The notification contribution cannot be proven as representative, distinct, escalation, recovery, or redundant.'];
  if (occurrence.event.state === 'UNKNOWN') return ['UNKNOWN_EVENT_BOUNDARY', 'The available source evidence does not establish a meaningful event boundary or lifecycle state.'];
  return ['NO_APPROVED_RULE', 'No approved Incident rule or positive Noise rule matches the available evidence.'];
}

function evaluateOccurrence(occurrence, allOccurrences, policy = OPERATIONAL_DECISION_POLICY, evaluatedAt = new Date().toISOString()) {
  const eventOccurrences = allOccurrences.filter((item) => item.event.eventId === occurrence.event.eventId);
  const representative = eventOccurrences.find((item) => item.occurrenceId === occurrence.event.representativeNotification) || null;
  const representativeReal = representative ? positiveEventProof(representative) : false;
  const role = occurrence.notificationRole.role;
  const evidenceUsed = [];
  const evidenceMissing = [];
  const evidenceRejected = supportingEvidence(occurrence);
  const incompatibleEvidence = occurrence.evidenceStatus.conflict || occurrence.evidenceStatus.wrongMetricOrEntity;
  const appDynamics = occurrence.source.name === 'AppDynamics' ? occurrence.appDynamicsWorkflow : null;
  let rule = policy.rules.needsReview;
  let decision = 'NEEDS_REVIEW';
  let subtype = 'EVIDENCE_GAP';

  const nonActionable = occurrence.nonActionableEvidence[0] || null;
  const operatorAction = occurrence.operations.humanAction === true || occurrence.slack.concreteAction === true;
  if (!incompatibleEvidence && occurrence.identity.accepted && nonActionable && !operatorAction
    && role === 'REPRESENTATIVE') {
    rule = nonActionable.transient ? policy.rules.transientNonActionableNoise : policy.rules.nonActionableSourceConditionNoise;
    decision = 'NOISE';
    subtype = nonActionable.transient ? 'TRANSIENT_NON_ACTIONABLE' : 'NON_ACTIONABLE_SOURCE_CONDITION';
    nonActionable.evidenceIds.forEach((id) => evidenceUsed.push(evidenceRecord('A', 'POSITIVE_NON_ACTIONABLE_SOURCE_EVIDENCE', id,
      `${nonActionable.source} non-actionable condition`, nonActionable.reason || 'The source positively identifies a recovered non-actionable condition.', nonActionable.source)));
  } else if (!incompatibleEvidence && role === 'REDUNDANT' && representativeReal
    && occurrence.identity.accepted && occurrence.notificationRole.repeatedRecovery) {
    rule = policy.rules.repeatedRecoveryNoise;
    decision = 'NOISE'; subtype = 'REPEATED_RECOVERY';
    evidenceUsed.push(evidenceRecord('A', 'REPEATED_RECOVERY_PROOF', occurrence.event.eventId,
      'Repeated source recovery', 'The first recovery remains useful; this later recovery repeats the same event state without new information.', occurrence.source.name));
  } else if (!incompatibleEvidence && role === 'REDUNDANT' && representativeReal
    && occurrence.identity.accepted && occurrence.event.flapping && occurrence.event.transitionCount >= 4) {
    rule = policy.rules.flappingNotificationNoise;
    decision = 'NOISE'; subtype = 'FLAPPING_NOTIFICATION';
    evidenceUsed.push(evidenceRecord('A', 'SOURCE_TRANSITION_SEQUENCE', occurrence.event.eventId,
      'Confirmed flapping transition sequence', `${occurrence.event.transitionCount} source-native transitions establish the retained flapping event.`, occurrence.source.name));
  } else if (!incompatibleEvidence && role === 'REDUNDANT' && representativeReal
    && occurrence.identity.accepted && occurrence.notificationRole.exactDuplicate) {
    rule = policy.rules.exactDuplicateNoise;
    decision = 'NOISE'; subtype = 'EXACT_DUPLICATE';
    evidenceUsed.push(evidenceRecord('A', 'SHARED_SOURCE_EVENT_IDENTITY', occurrence.event.eventId,
      'Exact source duplicate', 'The representative and notification share source event identity, entity, condition, state, and bounded event lifecycle.', occurrence.source.name));
  } else if (!incompatibleEvidence && role === 'REDUNDANT' && representativeReal
    && occurrence.identity.accepted) {
    rule = policy.rules.redundantRealEventNoise;
    decision = 'NOISE'; subtype = 'REDUNDANT_REAL_EVENT';
    evidenceUsed.push(evidenceRecord('B', 'CONFIRMED_EVENT_REPRESENTATIVE', occurrence.event.eventId,
      'Confirmed event with retained representative', 'The representative remains an Incident and this notification adds no new entity, condition, severity, source, or lifecycle information.', occurrence.source.name));
  } else if (!incompatibleEvidence && role === 'RECOVERY' && recoveryProof(occurrence) && representativeReal) {
    rule = policy.rules.recoveryIncident;
    decision = 'INCIDENT'; subtype = 'RECOVERY';
    evidenceUsed.push(...occurrence.sourceNativeEvidence.filter((item) => item.recovered).map((item) => evidenceRecord('A', 'SOURCE_RECOVERY', item.id,
      'Source recovery transition', 'The source workflow defines this as the first useful recovery signal for the confirmed event.', item.source, item.timestamp)));
  } else if (!incompatibleEvidence && ['ESCALATION', 'DISTINCT_SIGNAL'].includes(role)
    && occurrence.identity.accepted && (positiveEventProof(occurrence) || representativeReal)) {
    rule = appDynamics ? policy.rules.appDynamicsEscalationIncident : policy.rules.escalationIncident;
    decision = 'INCIDENT'; subtype = role;
    evidenceUsed.push(...sourceEvidenceUsed(occurrence), ...telemetryEvidenceUsed(occurrence));
    if (!evidenceUsed.length) evidenceUsed.push(evidenceRecord('B', 'CONFIRMED_EVENT_DISTINCT_INFORMATION', occurrence.event.eventId,
      'Distinct event contribution', occurrence.notificationRole.reasons.join(' '), occurrence.source.name));
  } else if (!incompatibleEvidence && sourceProof(occurrence) && role === 'REPRESENTATIVE') {
    rule = appDynamics ? policy.rules.appDynamicsSourceNativeIncident : policy.rules.sourceNativeIncident;
    decision = 'INCIDENT'; subtype = 'SOURCE_NATIVE_EVENT';
    evidenceUsed.push(...sourceEvidenceUsed(occurrence));
  } else if (!incompatibleEvidence && telemetryProof(occurrence) && role === 'REPRESENTATIVE') {
    rule = appDynamics ? policy.rules.appDynamicsSustainedTelemetryIncident : policy.rules.directTelemetryIncident;
    decision = 'INCIDENT'; subtype = appDynamics ? 'SUSTAINED_TELEMETRY' : 'DIRECT_TELEMETRY';
    evidenceUsed.push(...telemetryEvidenceUsed(occurrence));
  }

  if (decision === 'NEEDS_REVIEW') {
    const [code, reason] = reviewReason(occurrence);
    subtype = code;
    evidenceMissing.push(evidenceRecord('A', 'REQUIRED_DECISION_EVIDENCE', `missing-${occurrence.occurrenceId}`,
      'Approved Incident or positive Noise proof', reason, occurrence.source.name));
  }
  const confidence = decision === 'NEEDS_REVIEW' ? (occurrence.evidenceStatus.conflict ? 'MEDIUM' : 'LOW')
    : occurrence.evidenceConfidence.level === 'HIGH' ? 'HIGH' : 'MEDIUM';
  const reasoning = decision === 'NEEDS_REVIEW' ? `${evidenceMissing[0].reason} Missing evidence remains Needs Review; it is never converted to Noise.`
    : appDynamics && rule.id.startsWith('APPD_WORKFLOW_')
      ? `${appDynamics.reasoning} Notification role: ${role.toLowerCase().replaceAll('_', ' ')}.`
      : `${rule.description} Notification role: ${role.toLowerCase().replaceAll('_', ' ')}.`;
  const decisionInput = {
    occurrenceId: occurrence.occurrenceId, eventId: occurrence.event.eventId, role,
    identity: occurrence.identity, sourceNativeEvidence: occurrence.sourceNativeEvidence,
    telemetry: occurrence.telemetry, nonActionableEvidence: occurrence.nonActionableEvidence,
    appDynamicsWorkflow: occurrence.appDynamicsWorkflow,
    conflict: occurrence.evidenceStatus.conflict, policyVersion: policy.modelVersion,
  };
  return {
    occurrenceId: occurrence.occurrenceId, alertNumber: occurrence.alert.alertNumber,
    decision, subtype, confidence, ruleId: rule.id, ruleVersion: rule.version,
    evidenceUsed, evidenceMissing, evidenceRejected, reasoning,
    underlyingEvent: {
      eventId: occurrence.event.eventId,
      confirmed: representativeReal || positiveEventProof(occurrence),
      representativeOccurrenceId: representative?.occurrenceId || null,
      representativeAlertNumber: representative?.alert.alertNumber || null,
    },
    notificationRole: occurrence.notificationRole,
    evaluatedAt, decisionModelVersion: policy.modelVersion,
    decisionInputVersion: hash(decisionInput),
  };
}

function safeEvaluation(value) {
  return JSON.parse(JSON.stringify(value, (key, item) => /token|secret|password|credential|authorization|cookie|raw/i.test(key) ? '[REDACTED]' : item));
}

function createOperationalDecisionAuditStore({ database = db } = {}) {
  let readyPromise = null;
  const ensure = () => {
    if (!readyPromise) readyPromise = database.query(`CREATE TABLE IF NOT EXISTS operational_decision_audit (
      evaluation_id TEXT PRIMARY KEY, occurrence_id TEXT NOT NULL, alert_number TEXT,
      decision_model_version TEXT NOT NULL, input_version TEXT NOT NULL,
      decision TEXT NOT NULL, subtype TEXT NOT NULL, rule_id TEXT NOT NULL, rule_version TEXT NOT NULL,
      confidence TEXT NOT NULL, previous_decision TEXT, reason_for_change TEXT NOT NULL,
      evaluation_json JSONB NOT NULL, evaluated_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`)
      .then(() => database.query(`CREATE INDEX IF NOT EXISTS operational_decision_occurrence_time_idx
        ON operational_decision_audit(occurrence_id, evaluated_at DESC)`))
      .catch((error) => { readyPromise = null; throw error; });
    return readyPromise;
  };
  return {
    async latest(ids) {
      if (!ids.length) return new Map();
      await ensure();
      const result = await database.query(`SELECT DISTINCT ON (occurrence_id) occurrence_id, decision, rule_id,
        rule_version, input_version, evaluation_json FROM operational_decision_audit
        WHERE occurrence_id=ANY($1::text[]) ORDER BY occurrence_id, evaluated_at DESC, created_at DESC`, [ids.map(String)]);
      return new Map(result.rows.map((row) => [String(row.occurrence_id), row]));
    },
    async saveMany(evaluations, previousById) {
      await ensure();
      const rows = evaluations.map((evaluation) => {
        const previous = previousById.get(String(evaluation.occurrenceId));
        const evaluationId = `op_dec_${hash(`${evaluation.occurrenceId}|${evaluation.decisionModelVersion}|${evaluation.decisionInputVersion}`)}`;
        const reasonForChange = !previous ? 'INITIAL_DECISION_EVALUATION'
          : previous.input_version === evaluation.decisionInputVersion ? 'UNCHANGED_EVIDENCE_REPLAY'
            : previous.decision !== evaluation.decision ? 'DECISION_CHANGED_AFTER_EVIDENCE_UPDATE'
              : previous.rule_id !== evaluation.ruleId ? 'RULE_CHANGED' : 'EVIDENCE_UPDATED_DECISION_UNCHANGED';
        const audited = { ...evaluation, audit: { evaluationId, previousDecision: previous?.decision || null,
          newDecision: evaluation.decision, reasonForChange } };
        return { evaluationId, evaluation: safeEvaluation(audited), previousDecision: previous?.decision || null, reasonForChange };
      });
      if (rows.length) await database.query(`INSERT INTO operational_decision_audit
        (evaluation_id,occurrence_id,alert_number,decision_model_version,input_version,decision,subtype,
         rule_id,rule_version,confidence,previous_decision,reason_for_change,evaluation_json,evaluated_at)
        SELECT evaluation_id,occurrence_id,alert_number,decision_model_version,input_version,decision,subtype,
          rule_id,rule_version,confidence,previous_decision,reason_for_change,evaluation_json,evaluated_at
        FROM jsonb_to_recordset($1::jsonb) AS record(evaluation_id TEXT,occurrence_id TEXT,alert_number TEXT,
          decision_model_version TEXT,input_version TEXT,decision TEXT,subtype TEXT,rule_id TEXT,rule_version TEXT,
          confidence TEXT,previous_decision TEXT,reason_for_change TEXT,evaluation_json JSONB,evaluated_at TIMESTAMPTZ)
        ON CONFLICT (evaluation_id) DO NOTHING`, [JSON.stringify(rows.map((row) => ({
        evaluation_id: row.evaluationId, occurrence_id: row.evaluation.occurrenceId,
        alert_number: row.evaluation.alertNumber, decision_model_version: row.evaluation.decisionModelVersion,
        input_version: row.evaluation.decisionInputVersion, decision: row.evaluation.decision,
        subtype: row.evaluation.subtype, rule_id: row.evaluation.ruleId, rule_version: row.evaluation.ruleVersion,
        confidence: row.evaluation.confidence, previous_decision: row.previousDecision,
        reason_for_change: row.reasonForChange, evaluation_json: row.evaluation, evaluated_at: row.evaluation.evaluatedAt,
      })))]) ;
      return rows.map((row) => row.evaluation);
    },
    async history(occurrenceId, limit = 50) {
      await ensure();
      const result = await database.query(`SELECT evaluation_json FROM operational_decision_audit
        WHERE occurrence_id=$1 ORDER BY evaluated_at DESC, created_at DESC LIMIT $2`,
      [String(occurrenceId), Math.max(1, Math.min(200, Number(limit) || 50))]);
      return result.rows.map((row) => row.evaluation_json);
    },
  };
}

function groupPatterns(occurrences, decisions) {
  const groups = new Map();
  occurrences.forEach((occurrence, index) => {
    const decision = decisions[index];
    const key = occurrence.alert.patternId || `${occurrence.source.name}:${hash(occurrence.alert.pattern)}`;
    const value = groups.get(key) || {
      patternId: key, pattern: occurrence.alert.pattern, source: occurrence.source.name,
      alerts: 0, incidents: 0, noise: 0, review: 0, evidence: new Set(),
    };
    value.alerts += 1;
    value[decision.decision === 'INCIDENT' ? 'incidents' : decision.decision === 'NOISE' ? 'noise' : 'review'] += 1;
    decision.evidenceUsed.forEach((item) => value.evidence.add(item.type));
    groups.set(key, value);
  });
  return [...groups.values()].map((item) => ({
    ...item, evidence: [...item.evidence],
    recommendation: item.review > 0 ? 'Collect the missing deterministic evidence before changing any source rule.'
      : item.noise > 0 ? 'Consolidate only the proven Noise notifications while retaining each representative Incident.'
        : 'Retain the alert path; evidence confirms distinct operator value.',
  })).sort((left, right) => right.noise - left.noise || right.review - left.review || right.alerts - left.alerts);
}

function reviewBreakdown(occurrences, decisions) {
  const buckets = new Map();
  const labels = {
    NO_MAPPING: 'No mapping', NO_TELEMETRY: 'No telemetry', WRONG_METRIC_OR_ENTITY: 'Wrong metric/entity',
    UNKNOWN_EVENT_BOUNDARY: 'Unknown event boundary', CONFLICTING_EVIDENCE: 'Conflicting evidence',
    NO_ENTITY: 'No entity', NO_SOURCE_EVENT: 'No source event', WRONG_METRIC: 'Wrong metric',
    WRONG_ENTITY: 'Wrong entity', PERSISTENCE_UNKNOWN: 'Persistence unknown',
    EVENT_BOUNDARY_UNKNOWN: 'Event boundary unknown', OTHER: 'Other',
  };
  decisions.forEach((decision, index) => {
    if (decision.decision !== 'NEEDS_REVIEW') return;
    const category = labels[decision.subtype] || 'Other';
    const key = `${category}|${occurrences[index].source.name}`;
    const item = buckets.get(key) || { category, source: occurrences[index].source.name, count: 0, reasons: new Set() };
    item.count += 1; item.reasons.add(decision.reasoning); buckets.set(key, item);
  });
  return [...buckets.values()].map((item) => ({ ...item, reasons: [...item.reasons].slice(0, 3) }))
    .sort((left, right) => right.count - left.count || left.category.localeCompare(right.category));
}

function summarize(model, decisions) {
  const count = (decision) => decisions.filter((item) => item.decision === decision).length;
  const incident = count('INCIDENT'); const noise = count('NOISE'); const needsReview = count('NEEDS_REVIEW');
  const automatic = decisions.filter((item) => item.decision !== 'NEEDS_REVIEW');
  const confirmedEventIds = new Set(decisions.filter((item) => item.decision === 'INCIDENT'
    || (item.decision === 'NOISE' && REDUNDANT_NOISE_SUBTYPES.has(item.subtype)))
    .map((item) => item.underlyingEvent.eventId));
  const potentiallyConsolidatable = decisions.filter((item) => item.decision === 'NOISE'
    && REDUNDANT_NOISE_SUBTYPES.has(item.subtype)
    && decisions.some((candidate) => candidate.occurrenceId === item.underlyingEvent.representativeOccurrenceId
      && candidate.decision === 'INCIDENT')).length;
  const evidenceBacked = model.occurrences.filter((item) => item.evidenceStatus.hasSourceEvidence).length;
  const provenance = automatic.filter((item) => item.evidenceUsed.length && item.evidenceUsed.every((entry) => entry.id)).length;
  const unsupported = automatic.filter((item) => !item.ruleId || !item.evidenceUsed.length
    || (item.decision === 'NOISE' && !item.ruleId.startsWith('OPERATIONAL_NOISE_'))).length;
  return {
    total: model.denominator, evaluated: decisions.length, incident, noise, needsReview,
    classificationCoveragePercentage: model.denominator ? Number(((incident + noise) / model.denominator * 100).toFixed(1)) : 0,
    humanReviewRatePercentage: model.denominator ? Number((needsReview / model.denominator * 100).toFixed(1)) : 0,
    confirmedOperationalEvents: confirmedEventIds.size,
    notificationsPerEvent: confirmedEventIds.size
      ? Number((decisions.filter((item) => confirmedEventIds.has(item.underlyingEvent.eventId)).length / confirmedEventIds.size).toFixed(2)) : 0,
    potentiallyConsolidatable,
    evidenceCoveragePercentage: model.denominator ? Number((evidenceBacked / model.denominator * 100).toFixed(1)) : 0,
    decisionProvenanceCoveragePercentage: automatic.length ? Number((provenance / automatic.length * 100).toFixed(1)) : 100,
    unsupportedAutomaticDecisions: unsupported,
    reconciliation: decisions.length === model.denominator && incident + noise + needsReview === model.denominator,
  };
}

function appDynamicsSummary(model, decisions) {
  const rows = model.occurrences.map((occurrence, index) => ({ occurrence, decision: decisions[index] }))
    .filter((item) => item.occurrence.source.name === 'AppDynamics');
  const countRule = (ruleId) => rows.filter((item) => item.decision.ruleId === ruleId).length;
  const rootCauses = Object.fromEntries([
    'NO_ENTITY', 'NO_SOURCE_EVENT', 'NO_TELEMETRY', 'WRONG_METRIC', 'WRONG_ENTITY',
    'PERSISTENCE_UNKNOWN', 'EVENT_BOUNDARY_UNKNOWN', 'OTHER',
  ].map((code) => [code, 0]));
  rows.filter((item) => item.decision.decision === 'NEEDS_REVIEW').forEach((item) => {
    const code = item.occurrence.appDynamicsWorkflow?.reviewRootCause;
    rootCauses[Object.hasOwn(rootCauses, code) ? code : 'OTHER'] += 1;
  });
  const needsReview = rows.filter((item) => item.decision.decision === 'NEEDS_REVIEW').length;
  return {
    total: rows.length,
    sourceNative: countRule('APPD_WORKFLOW_INCIDENT_SOURCE_NATIVE_V1'),
    sustainedTelemetry: countRule('APPD_WORKFLOW_INCIDENT_SUSTAINED_TELEMETRY_V1'),
    escalation: countRule('APPD_WORKFLOW_INCIDENT_ESCALATION_V1'),
    noise: rows.filter((item) => item.decision.decision === 'NOISE').length,
    needsReview,
    reviewRootCauses: rootCauses,
    reconciliation: Object.values(rootCauses).reduce((sum, count) => sum + count, 0) === needsReview,
  };
}

function createOperationalDecisionService({
  snapshotService = operationalSignalService,
  store = null,
  canonicalStore = null,
  policy = OPERATIONAL_DECISION_POLICY,
  now = () => Date.now(),
} = {}) {
  const persistence = store || createOperationalDecisionAuditStore();
  const canonicalPersistence = canonicalStore || (store
    ? createNoopCanonicalAssessmentAuditStore()
    : createCanonicalAssessmentAuditStore());
  async function evaluate(options = {}) {
    const refresh = String(options.refresh || '').toLowerCase() === 'true';
    const snapshot = await snapshotService.compute('24h', refresh);
    const model = buildCommonEvidenceModel(snapshot);
    const identityIndex = await canonicalIdentityIndex(sourceIdentityService, {
      sourceDiscovery: options.sourceDiscovery !== false,
    });
    model.occurrences.forEach((occurrence) => {
      const entity = identityIndex.byOccurrence.get(String(occurrence.occurrenceId))
        || identityIndex.byPattern.get(String(occurrence.alert.patternId || ''));
      const resolved = occurrenceSourceIdentity(occurrence, entity);
      if (!['EXACT', 'STRONG', 'CONFIRMED_LOCAL'].includes(resolved.mappingState)) return;
      occurrence.identity = {
        ...occurrence.identity,
        accepted: true,
        level: resolved.mappingState,
        sourceEntityId: resolved.sourceEntityId,
        sourceEntityName: resolved.sourceEntityName,
        environment: resolved.environment || occurrence.identity.environment,
        conflicts: false,
        candidateOnly: false,
        unavailable: false,
      };
    });
    const evaluatedAt = new Date(now()).toISOString();
    let decisions = model.occurrences.map((occurrence) => evaluateOccurrence(occurrence, model.occurrences, policy, evaluatedAt));
    let persistenceStatus = 'SAVED'; let persistenceError = null;
    try {
      const previous = await persistence.latest(decisions.map((item) => item.occurrenceId));
      decisions = await persistence.saveMany(decisions, previous);
    } catch (error) {
      persistenceStatus = 'UNAVAILABLE';
      persistenceError = cleanText(error.safeMessage || error.message || 'Decision audit persistence is unavailable.');
    }
    const summary = summarize(model, decisions);
    const appDynamics = appDynamicsSummary(model, decisions);
    let canonicalAssessments = model.occurrences.map((occurrence, index) => {
      const assessment = buildCanonicalAlertAssessment(occurrence, decisions[index], model.occurrences, { evaluatedAt });
      const evidenceCompletion = buildEvidencePlan(occurrence, assessment);
      return {
        ...assessment,
        evidenceCompletion: {
          ...evidenceCompletion,
          readiness: evaluateDecisionReadiness(assessment, evidenceCompletion),
        },
      };
    });
    let canonicalPersistenceStatus = 'SAVED'; let canonicalPersistenceError = null;
    try {
      const previous = await canonicalPersistence.latest(canonicalAssessments.map((item) => item.alertId));
      canonicalAssessments = await canonicalPersistence.saveMany(canonicalAssessments, previous);
    } catch (error) {
      canonicalPersistenceStatus = 'UNAVAILABLE';
      canonicalPersistenceError = cleanText(error.safeMessage || error.message || 'Canonical assessment audit persistence is unavailable.');
    }
    const canonicalSummary = summarizeCanonicalAssessments(canonicalAssessments, model.denominator);
    const evidenceCoverage = summarizeEvidenceRequirements(canonicalAssessments.map((item) => item.evidenceCompletion));
    const decisionsById = new Map(decisions.map((item) => [item.occurrenceId, item]));
    const events = model.events.map((event) => ({
      ...event,
      notifications: event.notifications.map((id) => {
        const occurrence = model.occurrences.find((item) => item.occurrenceId === id);
        const decision = decisionsById.get(id);
        return { occurrenceId: id, alertNumber: occurrence?.alert.alertNumber || null, title: occurrence?.alert.title || null,
          source: occurrence?.source.name || 'Unknown', role: occurrence?.notificationRole.role || 'UNKNOWN',
          decision: decision?.decision || 'NEEDS_REVIEW', subtype: decision?.subtype || 'NO_APPROVED_RULE' };
      }),
    }));
    const publicOccurrences = model.occurrences.map((occurrence, index) => ({
      ...occurrence,
      sourceIdentity: occurrenceSourceIdentity(occurrence, identityIndex.byOccurrence.get(String(occurrence.occurrenceId))
        || identityIndex.byPattern.get(String(occurrence.alert.patternId || ''))),
      decision: decisions[index], canonicalAssessment: canonicalAssessments[index], legacyDiagnostics: undefined,
    }));
    const identityCounts = ['EXACT', 'STRONG', 'CONFIRMED_LOCAL', 'CANDIDATE', 'CONFLICT', 'UNKNOWN'].reduce((result, state) => {
      result[state] = publicOccurrences.filter((item) => item.sourceIdentity.mappingState === state
        || (state === 'UNKNOWN' && item.sourceIdentity.mappingState === 'STALE')).length;
      return result;
    }, {});
    identityCounts.ready = publicOccurrences.filter((item) => item.sourceIdentity.handoffStatus === 'IDENTITY_READY').length;
    identityCounts.coveragePercentage = model.denominator ? Number((identityCounts.ready / model.denominator * 100).toFixed(1)) : 0;
    return {
      range: '24h', evaluatedAt, decisionModelVersion: policy.modelVersion,
      canonicalAssessmentModelVersion: canonicalAssessments[0]?.modelVersion || 'canonical-alert-assessment-v1',
      summary, appDynamics, patterns: groupPatterns(model.occurrences, decisions), reviewBreakdown: reviewBreakdown(model.occurrences, decisions),
      canonical: {
        summary: canonicalSummary,
        evidenceCoverage,
        identityCoverage: identityCounts,
        rawIdentityExtraction: identityIndex.coverage?.rawPayloadFieldCoverage || null,
        sourceIdentityDiscovery: identityIndex.coverage?.sourceDiscovery || null,
      },
      events, occurrences: publicOccurrences,
      evaluationWindow: { currentAlerts: '24h', sourceEvidence: 'up to 90d', historicalEvidenceExpandsDenominator: false },
      persistence: {
        appendOnly: true, status: persistenceStatus, error: persistenceError,
        canonical: { appendOnly: true, status: canonicalPersistenceStatus, error: canonicalPersistenceError },
        sourceIdentity: { status: identityIndex.coverage ? 'AVAILABLE' : 'UNAVAILABLE', error: identityIndex.safeError || null },
      },
      technicalDiagnostics: String(options.includeDiagnostics || '').toLowerCase() === 'true' ? model.legacyDiagnostics : undefined,
      safeguards: { readOnly: true, externalMutations: 'none', aiUsed: false,
        automaticSuppression: 'none', automaticTuning: 'none', feedbackLearning: 'not implemented' },
    };
  }
  async function history(occurrenceId, limit) { return persistence.history(occurrenceId, limit); }
  return { evaluate, history };
}

module.exports = {
  createOperationalDecisionAuditStore,
  createOperationalDecisionService,
  evaluateOccurrence,
  appDynamicsSummary,
  service: createOperationalDecisionService(),
  summarize,
};
