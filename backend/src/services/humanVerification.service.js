const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const database = require('../config/db');
const integrationService = require('./integration.service');
const operationalOutcomeService = require('./operationalOutcome.service');
const slackUserService = require('./slackUser.service');
const slackAlertStoreService = require('./slackAlertStore.service');
const liveAlertStreamService = require('./liveAlertStream.service');
const {
  FEATURE_SCHEMA_VERSION,
  MINIMUM_CLASS_EXAMPLES,
  createFeatureSnapshotRecord,
  service: mlService,
} = require('./mlShadow.service');
const {
  commandCenterAlertProjectionSql,
  isCommandCenterAlert,
} = require('./commandCenterEligibility.service');
const {
  completenessForResponses,
  service: evidenceLearningService,
} = require('./evidenceLearning.service');
const { service: evidenceAttachmentStore } = require('./evidenceAttachmentStore.service');

const HUMAN_DECISIONS = Object.freeze(['INCIDENT', 'NOISE', 'NEEDS_REVIEW']);
const NOISE_SUBTYPES = Object.freeze([
  'REPEAT', 'DUPLICATE', 'AUTO_RESOLVED', 'FLAPPING', 'CORRELATED',
  'NON_ACTIONABLE', 'INFORMATIONAL', 'STALE', 'OTHER',
]);
const INCIDENT_REASONS = Object.freeze([
  'CUSTOMER_IMPACT', 'SERVICE_DEGRADATION', 'OPERATOR_INTERVENTION',
  'ESCALATION_REQUIRED', 'CONFIRMED_JIRA_INCIDENT', 'OTHER',
]);
const NOISE_REASONS = Object.freeze([
  'SAME_ACTIVE_OCCURRENCE', 'DUPLICATE_NOTIFICATION', 'AUTHORITATIVE_RECOVERY',
  'REPEATED_FIRING_RECOVERY', 'CORRELATED_SECONDARY_SYMPTOM',
  'EXPECTED_NON_ACTIONABLE', 'SCHEDULED_MAINTENANCE', 'STALE_NOTIFICATION', 'OTHER',
]);
const REVIEW_REASONS = Object.freeze([
  'INSUFFICIENT_EVIDENCE', 'SOURCE_UNAVAILABLE', 'IDENTITY_AMBIGUOUS',
  'LIFECYCLE_CONFLICT', 'MULTIPLE_OCCURRENCES', 'OPERATIONAL_OUTCOME_UNKNOWN', 'OTHER',
]);
const FEEDBACK_STATUSES = Object.freeze([
  'PENDING_VALIDATION', 'VALIDATED', 'REJECTED', 'SUPERSEDED',
  'HUMAN_FEEDBACK_CONFLICT',
]);
const incidentReportMigrationSql = fs.readFileSync(
  path.join(__dirname, '../db/migrations/058_incident_verification_reports.sql'),
  'utf8',
);
const evidenceCollectionMigrationSql = fs.readFileSync(
  path.join(__dirname, '../db/migrations/059_evidence_collection.sql'),
  'utf8',
);
const evidenceVersionMigrationSql = fs.readFileSync(
  path.join(__dirname, '../db/migrations/061_evidence_collection_versions.sql'),
  'utf8',
);
const occurrenceVerificationMigrationSql = fs.readFileSync(
  path.join(__dirname, '../db/migrations/063_slack_occurrence_verification.sql'),
  'utf8',
);
const slackCallbackInboxMigrationSql = fs.readFileSync(
  path.join(__dirname, '../db/migrations/064_slack_callback_inbox.sql'),
  'utf8',
);
const capacityMigrationSql = fs.readFileSync(
  path.join(__dirname, '../db/migrations/065_capacity_and_search_indexes.sql'),
  'utf8',
);
const pendingEvidenceMigrationSql = fs.readFileSync(
  path.join(__dirname, '../db/migrations/066_pending_evidence_outcomes.sql'),
  'utf8',
);
const productionHistoryMigrationSql = fs.readFileSync(
  path.join(__dirname, '../db/migrations/067_production_live_and_evidence_history.sql'),
  'utf8',
);
let incidentReportSchemaReady;

const IDENTITY_CONFIRMATION_STATUSES = Object.freeze(['CONFIRMED', 'PARTIALLY_CONFIRMED', 'UNABLE_TO_CONFIRM']);
const LIFECYCLE_STATUSES = Object.freeze([
  'FIRING', 'ACKNOWLEDGED', 'RECOVERED', 'AUTO_RESOLVED', 'CLOSED', 'FLAPPING', 'UNKNOWN',
]);
const EVIDENCE_CATEGORIES = Object.freeze([
  'SOURCE_MONITORING_EVIDENCE', 'CUSTOMER_BUSINESS_IMPACT', 'ALERT_LIFECYCLE',
  'DUPLICATE_ALERT', 'FLAPPING_ALERT', 'AUTO_RESOLUTION', 'CORRELATION',
  'RECOVERY_EVIDENCE', 'ROOT_CAUSE_EVIDENCE', 'NON_ACTIONABLE_ALERT',
  'ACTIVE_INCIDENT', 'OTHER',
]);
const POSITIVE_NOISE_CATEGORIES = Object.freeze(['DUPLICATE_ALERT', 'FLAPPING_ALERT', 'AUTO_RESOLUTION']);
const REPRODUCIBILITY_STATUSES = Object.freeze(['YES', 'NO', 'UNABLE_TO_VERIFY']);
const MAX_WEB_ATTACHMENT_BYTES = 6 * 1024 * 1024;
const MAX_WEB_ATTACHMENT_COUNT = 5;
const EVIDENCE_OUTCOMES = Object.freeze([
  'CONFIRMED_INCIDENT', 'CONFIRMED_NOISE', 'PENDING_EVIDENCE',
]);
const STRUCTURED_EVIDENCE_SCHEMA_VERSION = 'structured-evidence-v2';
const choices = (items) => Object.freeze(items.map(([value, label]) => Object.freeze({ value, label })));
const STRUCTURED_EVIDENCE_SCHEMA = Object.freeze({
  version: STRUCTURED_EVIDENCE_SCHEMA_VERSION,
  monitoringSources: choices([
    ['APPDYNAMICS', 'AppDynamics'], ['GRAFANA', 'Grafana'], ['NAGIOS', 'Nagios'],
  ]),
  monitoringMatch: choices([
    ['EXACT_MATCH', 'Exact match'], ['PARTIAL_MATCH', 'Partial match'], ['NO_MATCH', 'No match'],
    ['UNABLE_TO_VERIFY', 'Unable to verify'],
  ]),
  monitoringState: choices([
    ['ACTIVE', 'Active'], ['RECOVERED', 'Recovered'], ['FLAPPING', 'Flapping'],
    ['DUPLICATE', 'Duplicate'], ['MAINTENANCE', 'Maintenance'], ['NO_DATA', 'No data'],
    ['CONFLICTING', 'Conflicting'], ['UNKNOWN', 'Unknown'],
  ]),
  technicalCondition: choices([
    ['APPLICATION_ERROR', 'Application error'], ['INFRASTRUCTURE_FAILURE', 'Infrastructure failure'],
    ['DEPENDENCY_FAILURE', 'Dependency failure'], ['NETWORK_ISSUE', 'Network issue'],
    ['CAPACITY_ISSUE', 'Capacity issue'], ['SCHEDULED_JOB_FAILURE', 'Scheduled job failure'],
    ['CONFIGURATION_DEPLOYMENT_ISSUE', 'Configuration/deployment issue'],
    ['SECURITY_EVENT', 'Security event'], ['NO_TECHNICAL_FAILURE_FOUND', 'No technical failure found'],
    ['UNKNOWN', 'Unknown'],
  ]),
  evidenceTypes: choices([
    ['ERROR_EXCEPTION', 'Error or exception'], ['HEALTH_RULE_VIOLATION', 'Health-rule violation'],
    ['FAILED_SERVICE_CHECK', 'Failed service check'], ['FAILED_HOST_CHECK', 'Failed host check'],
    ['ALERT_RULE_RESULT', 'Alert-rule result'], ['THRESHOLD_BREACH', 'Threshold breach'],
    ['RECOVERY_EVENT', 'Recovery event'], ['REPEATED_FIRING', 'Repeated firing'],
    ['DUPLICATE_MATCH', 'Duplicate match'], ['MAINTENANCE_RECORD', 'Maintenance record'],
    ['PARENT_INCIDENT_CORRELATION', 'Parent incident correlation'],
    ['NO_SUPPORTING_EVIDENCE', 'No supporting evidence'], ['CONFLICTING_EVIDENCE', 'Conflicting evidence'],
  ]),
  evidenceStrength: choices([
    ['CONFIRMED', 'Confirmed'], ['PARTIAL', 'Partial'], ['NOT_OBSERVED', 'Not observed'],
    ['UNABLE_TO_RETRIEVE', 'Unable to retrieve'], ['CONFLICTING', 'Conflicting'],
  ]),
  impact: choices([
    ['CONFIRMED', 'Confirmed'], ['POSSIBLE', 'Possible'], ['NO_IMPACT', 'No impact'], ['UNKNOWN', 'Unknown'],
  ]),
  impactLevel: choices([
    ['NONE', 'None'], ['LOW', 'Low'], ['MEDIUM', 'Medium'], ['HIGH', 'High'],
    ['CRITICAL', 'Critical'], ['UNKNOWN', 'Unknown'],
  ]),
  affectedScope: choices([
    ['SINGLE_COMPONENT', 'Single component'], ['SINGLE_APPLICATION', 'Single application'],
    ['MULTIPLE_APPLICATIONS', 'Multiple applications'], ['SHARED_PLATFORM', 'Shared platform'],
    ['MULTIPLE_ENVIRONMENTS', 'Multiple environments'], ['CUSTOMER_FACING_SERVICE', 'Customer-facing service'],
    ['INTERNAL_SERVICE', 'Internal service'], ['UNKNOWN', 'Unknown'],
  ]),
  persistence: choices([
    ['LT_5_MINUTES', 'Less than 5 minutes'], ['MINUTES_5_TO_15', '5–15 minutes'],
    ['MINUTES_15_TO_60', '15–60 minutes'], ['GT_1_HOUR', 'More than 1 hour'],
    ['GT_5_DAYS', 'More than 5 days'], ['UNKNOWN', 'Unknown'],
  ]),
  noiseReasons: choices([
    ['EXACT_DUPLICATE', 'Exact duplicate'], ['FLAPPING', 'Flapping'],
    ['AUTO_RESOLVED_WITHOUT_IMPACT', 'Auto-resolved without impact'],
    ['CORRELATED_CHILD_ALERT', 'Correlated child alert'], ['PLANNED_MAINTENANCE', 'Planned maintenance'],
    ['EXPECTED_BEHAVIOR', 'Expected behavior'],
    ['NON_ACTIONABLE_INFORMATIONAL_EVENT', 'Non-actionable informational event'],
    ['STALE_ALERT', 'Stale alert'], ['TEST_SYNTHETIC_ALERT', 'Test or synthetic alert'],
    ['NO_NOISE_PATTERN', 'No noise pattern'], ['UNKNOWN', 'Unknown'],
  ]),
  duplicateMatch: choices([
    ['SAME_EVENT_ID', 'Same event ID'], ['SAME_FINGERPRINT', 'Same fingerprint'],
    ['SAME_SOURCE_OCCURRENCE', 'Same source occurrence'], ['UNABLE_TO_VERIFY', 'Unable to verify'],
  ]),
  flappingCount: choices([
    ['TWO_TO_THREE', '2–3 firing/recovery cycles'], ['FOUR_TO_TEN', '4–10 firing/recovery cycles'],
    ['MORE_THAN_TEN', 'More than 10 cycles'], ['UNABLE_TO_VERIFY', 'Unable to verify'],
  ]),
  verification: choices([['YES', 'Yes'], ['NO', 'No'], ['UNABLE_TO_VERIFY', 'Unable to verify']]),
  referenceType: choices([
    ['ALERT_REFERENCE', 'Alert reference available'], ['INCIDENT_REFERENCE', 'Incident reference available'],
    ['CHANGE_REFERENCE', 'Change/maintenance reference available'], ['UNABLE_TO_VERIFY', 'Unable to verify'],
  ]),
  expectedEventCategory: choices([
    ['SCHEDULED_JOB', 'Approved scheduled job'], ['DEPLOYMENT', 'Approved deployment'],
    ['HEALTH_CHECK', 'Approved health check'], ['TEST_EVENT', 'Approved test event'],
    ['OTHER_APPROVED_EVENT', 'Other approved event'], ['UNABLE_TO_VERIFY', 'Unable to verify'],
  ]),
  actionability: choices([
    ['IMMEDIATE_ACTION_REQUIRED', 'Immediate action required'],
    ['FOLLOW_UP_ACTION_REQUIRED', 'Follow-up action required'], ['NO_ACTION_REQUIRED', 'No action required'],
    ['ALREADY_RESOLVED', 'Already resolved'], ['DUPLICATE_NOTIFICATION', 'Duplicate notification'],
    ['REQUIRES_MORE_EVIDENCE', 'Requires more evidence'], ['UNKNOWN', 'Unknown'],
  ]),
  notificationRoleAssessment: choices([
    ['PRIMARY_ALERT', 'Primary alert'], ['DUPLICATE_NOTIFICATION', 'Duplicate notification'],
    ['CORRELATED_SYMPTOM', 'Correlated symptom'], ['RECOVERY_NOTIFICATION', 'Recovery notification'],
    ['INFORMATIONAL_NOTIFICATION', 'Informational notification'],
  ]),
  resolutionAssessment: choices([
    ['AUTO_RESOLVED', 'Auto-resolved'], ['RESOLVED_BY_OPERATOR', 'Resolved by operator'],
    ['RESOLVED_THROUGH_INCIDENT', 'Resolved through incident activity'],
    ['EXISTING_PROBLEM_IDENTIFIED', 'Existing problem identified'],
    ['STILL_UNRESOLVED', 'Still unresolved'], ['NOT_APPLICABLE', 'Not applicable'],
  ]),
  finalDecisions: choices([
    ['CONFIRMED_INCIDENT', 'Confirmed Incident'], ['CONFIRMED_NOISE', 'Confirmed Noise'],
  ]),
  yesNo: choices([['YES', 'Yes'], ['NO', 'No']]),
  sourceVerification: choices([['YES', 'Yes'], ['NO', 'No'], ['PARTIALLY', 'Partially']]),
  confidence: choices([['HIGH', 'High'], ['MEDIUM', 'Medium'], ['LOW', 'Low']]),
});

function automaticVerificationEligibility({ alert = {}, evaluation = {} } = {}) {
  void alert;
  void evaluation;
  return { eligible: true, status: 'ELIGIBLE_ALL_OCCURRENCES' };
}
const EVIDENCE_REQUIREMENTS = Object.freeze({
  IDENTITY_CONFIRMATION: Object.freeze({
    label: 'Identity Confirmation',
    emoji: '🪪',
    prompt: 'Confirm the exact application, service, host/node, rule, metric, or source entity.',
  }),
  ALERT_LIFECYCLE: Object.freeze({
    label: 'Alert Lifecycle',
    emoji: '🔄',
    prompt: 'Confirm whether the alert is firing, acknowledged, recovered, auto-resolved, or closed.',
  }),
  DURATION_OCCURRENCES: Object.freeze({
    label: 'Duration & Occurrences',
    emoji: '📈',
    prompt: 'Provide the current duration, occurrence count, and whether notifications belong to one occurrence.',
  }),
  SEVERITY_PRIORITY: Object.freeze({
    label: 'Severity / Priority',
    emoji: '🚦',
    prompt: 'Confirm monitoring severity, Operations priority, and any priority escalation.',
  }),
  IMPACT_SYMPTOMS: Object.freeze({
    label: 'Impact / Symptoms',
    emoji: '🩺',
    prompt: 'Describe errors, latency, availability, user impact, or customer/business impact.',
  }),
  ROOT_CAUSE_INDICATORS: Object.freeze({
    label: 'Root Cause Indicators',
    emoji: '🔧',
    prompt: 'Provide relevant errors, exceptions, plugin output, health-rule details, logs, or suspected cause.',
  }),
  CORRELATIONS: Object.freeze({
    label: 'Correlations',
    emoji: '🔗',
    prompt: 'Identify related alerts, incidents, deployments, changes, releases, or affected dependencies.',
  }),
  ACTIONS_TAKEN: Object.freeze({
    label: 'Actions Taken (If Any)',
    emoji: '👤',
    prompt: 'Record investigation, escalation, remediation, restart, rollback, or other operator action.',
  }),
  RECOVERY_DETAILS: Object.freeze({
    label: 'Recovery Details',
    emoji: '↩️',
    prompt: 'Confirm whether and when it recovered, what restored it, and who or what performed the recovery.',
  }),
  ADDITIONAL_CONTEXT: Object.freeze({
    label: 'Additional Context',
    emoji: '📗',
    prompt: 'Add relevant environment, maintenance, runbook, annotation, tag, or operational context.',
  }),
});

const EVIDENCE_STATUS_PRESENTATION = Object.freeze({
  AVAILABLE: Object.freeze({ icon: '✅', label: 'Available' }),
  PARTIAL: Object.freeze({ icon: '🟠', label: 'Partial' }),
  MISSING: Object.freeze({ icon: '❌', label: 'Missing' }),
});

function verificationError(message, code, status = 400, details = null) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  error.safeMessage = message;
  if (details) error.safeDetails = details;
  return error;
}

function clean(value, maximum = 4000) {
  const result = String(value ?? '').trim();
  if (result.length > maximum) throw verificationError(`Value must be ${maximum} characters or fewer.`, 'FEEDBACK_VALUE_TOO_LONG');
  return result || null;
}

function toIso(value) {
  return value ? new Date(value).toISOString() : null;
}

function canonicalDecision(value) {
  const normalized = clean(value, 80)?.toUpperCase();
  if (normalized === 'CONFIRMED_INCIDENT') return 'INCIDENT';
  if (normalized === 'CONFIRMED_NOISE') return 'NOISE';
  if (normalized === 'UNKNOWN' || normalized === 'REVIEW') return 'NEEDS_REVIEW';
  return HUMAN_DECISIONS.includes(normalized) ? normalized : null;
}

function canonicalEvidenceOutcome(value) {
  const normalized = clean(value, 80)?.toUpperCase();
  if (normalized === 'INCIDENT') return 'CONFIRMED_INCIDENT';
  if (normalized === 'NOISE') return 'CONFIRMED_NOISE';
  if (['NEEDS_REVIEW', 'UNKNOWN', 'REVIEW', 'PENDING'].includes(normalized)) return 'PENDING_EVIDENCE';
  return EVIDENCE_OUTCOMES.includes(normalized) ? normalized : null;
}

function legacyDecisionForEvidenceOutcome(value) {
  const outcome = canonicalEvidenceOutcome(value);
  if (outcome === 'CONFIRMED_INCIDENT') return 'INCIDENT';
  if (outcome === 'CONFIRMED_NOISE') return 'NOISE';
  return 'NEEDS_REVIEW';
}

function evidenceOutcomeLabel(value) {
  const outcome = canonicalEvidenceOutcome(value) || 'PENDING_EVIDENCE';
  return outcome === 'CONFIRMED_INCIDENT' ? 'Confirmed Incident'
    : outcome === 'CONFIRMED_NOISE' ? 'Confirmed Noise' : 'Evidence Pending';
}

function schemaValues(key) {
  return new Set((STRUCTURED_EVIDENCE_SCHEMA[key] || []).map((item) => item.value));
}

function operationalOutcome(decision) {
  return decision === 'INCIDENT' ? 'CONFIRMED_INCIDENT'
    : decision === 'NOISE' ? 'CONFIRMED_NOISE' : 'UNKNOWN';
}

function revisionsFor(evaluation) {
  const episodeId = evaluation.feature_snapshot?.episode?.episodeId
    || evaluation.featureSnapshot?.episode?.episodeId
    || evaluation.alert_id || evaluation.alertId;
  return {
    alertId: evaluation.alert_id || evaluation.alertId,
    decisionRevision: evaluation.evaluation_id || evaluation.evaluationId,
    evidenceRevision: toIso(evaluation.feature_as_of || evaluation.featureAsOf),
    episodeId,
  };
}

function controlledTestRevisionChanged(expected = {}, submitted = {}) {
  return submitted.alertId !== expected.alertId
    || submitted.episodeId !== expected.episodeId
    || submitted.decisionRevision !== expected.decisionRevision
    || submitted.evidenceRevision !== expected.evidenceRevision
    || submitted.featureSnapshotId !== expected.featureSnapshotId;
}

function normalizeEvidenceKeys(values) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values
    .map((value) => String(value || '').trim().toUpperCase())
    .filter((value) => Object.hasOwn(EVIDENCE_REQUIREMENTS, value)))]
    .slice(0, Object.keys(EVIDENCE_REQUIREMENTS).length);
}

function parseActionValue(value) {
  try {
    const parsed = JSON.parse(String(value || ''));
    return {
      alertId: clean(parsed.alertId, 255),
      decisionRevision: clean(parsed.decisionRevision, 255),
      episodeId: clean(parsed.episodeId, 255),
      evaluationId: clean(parsed.evaluationId, 255),
      evidenceRevision: clean(parsed.evidenceRevision, 255),
      systemDecision: canonicalDecision(parsed.systemDecision),
      channelId: clean(parsed.channelId, 255),
      messageTs: clean(parsed.messageTs, 255),
      humanDecision: canonicalDecision(parsed.humanDecision),
      featureSnapshotId: clean(parsed.featureSnapshotId, 255),
      modelVersion: clean(parsed.modelVersion, 255),
      predictionId: clean(parsed.predictionId, 255),
      isTest: parsed.isTest === true,
      testRunId: clean(parsed.testRunId, 255),
      updateEvidence: parsed.updateEvidence === true,
      refreshEventId: clean(parsed.refreshEventId, 255),
      occurrenceId: clean(parsed.occurrenceId, 512),
      origin: String(parsed.origin || 'LIVE').toUpperCase() === 'BACKFILL' ? 'BACKFILL' : 'LIVE',
      menuAction: clean(parsed.menuAction, 80)?.toLowerCase() || null,
      missingEvidence: normalizeEvidenceKeys(parsed.missingEvidence),
      formPage: Math.min(Math.max(Number(parsed.formPage || 1), 1), 4),
      draftValues: parsed.draftValues && typeof parsed.draftValues === 'object'
        ? parsed.draftValues : {},
    };
  } catch {
    throw verificationError('The Slack verification context is invalid.', 'INVALID_SLACK_VERIFICATION_CONTEXT');
  }
}

function slackEvidenceMenuSelection(action = {}) {
  if (action.action_id === 'alert_evidence_overflow') {
    return parseActionValue(action.selected_option?.value);
  }
  if (['collect_evidence', 'update_evidence', 'view_evidence'].includes(action.action_id)) {
    return {
      ...parseActionValue(action.value),
      menuAction: action.action_id,
      updateEvidence: action.action_id === 'update_evidence' || parseActionValue(action.value).updateEvidence,
    };
  }
  return null;
}

function validateSubmission(input, systemDecision) {
  const humanDecision = canonicalDecision(input.humanDecision || input.outcome);
  if (!humanDecision) throw verificationError('A valid human decision is required.', 'INVALID_HUMAN_DECISION');
  const humanSubtype = clean(input.humanSubtype || input.subtype, 80)?.toUpperCase() || null;
  const reasonCode = clean(input.reasonCode || input.reason, 100)?.toUpperCase() || null;
  const humanEvidenceText = clean(input.humanEvidenceText || input.human_evidence_text, 4000);
  const comment = clean(input.comment || input.notes, 4000);
  const changed = humanDecision !== canonicalDecision(systemDecision);
  if (humanDecision === 'NOISE' && !NOISE_SUBTYPES.includes(humanSubtype)) {
    throw verificationError(`Noise subtype must be ${NOISE_SUBTYPES.join(', ')}.`, 'NOISE_SUBTYPE_REQUIRED');
  }
  if (humanDecision === 'INCIDENT' && reasonCode && !INCIDENT_REASONS.includes(reasonCode)) {
    throw verificationError(`Incident reason must be ${INCIDENT_REASONS.join(', ')}.`, 'INVALID_INCIDENT_REASON');
  }
  if (humanDecision === 'NOISE' && reasonCode && !NOISE_REASONS.includes(reasonCode)) {
    throw verificationError(`Noise reason must be ${NOISE_REASONS.join(', ')}.`, 'INVALID_NOISE_REASON');
  }
  if (humanDecision === 'NEEDS_REVIEW' && reasonCode && !REVIEW_REASONS.includes(reasonCode)) {
    throw verificationError(`Needs Review reason must be ${REVIEW_REASONS.join(', ')}.`, 'INVALID_REVIEW_REASON');
  }
  if (changed && !reasonCode && !comment) {
    throw verificationError('A reason is required when changing the system decision.', 'DECISION_CHANGE_REASON_REQUIRED');
  }
  if (!reasonCode) {
    throw verificationError('A reason code is required for human verification.', 'HUMAN_REASON_REQUIRED');
  }
  if (!humanEvidenceText) {
    throw verificationError('Responder evidence or operational observation is required.', 'HUMAN_EVIDENCE_REQUIRED');
  }
  if ((humanSubtype === 'OTHER' || reasonCode === 'OTHER') && !comment) {
    throw verificationError('A comment is required when OTHER is selected.', 'OTHER_REASON_COMMENT_REQUIRED');
  }
  return { changed, comment, humanDecision, humanEvidenceText, humanSubtype, reasonCode };
}

function blockText(value, fallback = 'Not available') {
  return clean(value, 2800) || fallback;
}

function signal(value) {
  return value === true ? 'YES' : value === false ? 'NO' : 'UNKNOWN';
}

function durationText(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value)) return 'Unavailable';
  if (value < 60) return `${Math.round(value)}s`;
  if (value < 3600) return `${Math.round(value / 60)}m`;
  return `${(value / 3600).toFixed(1)}h`;
}

function compactValue(value, maximum = 180) {
  const result = String(value ?? '').replace(/\s+/g, ' ').trim();
  return result ? result.slice(0, maximum) : null;
}

function meaningful(value) {
  if (value === null || value === undefined || value === '') return false;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.some(meaningful);
  if (typeof value === 'object') return Object.entries(value).some(([, item]) => meaningful(item));
  return !['UNKNOWN', 'UNAVAILABLE', 'NOT_AVAILABLE', 'NOT AVAILABLE', 'UNRESOLVED', 'NOT SUPPLIED']
    .includes(String(value).trim().toUpperCase());
}

function hasDeepEvidence(value, keyPattern, depth = 0, seen = new Set()) {
  if (!value || typeof value !== 'object' || depth > 5 || seen.has(value)) return false;
  seen.add(value);
  return Object.entries(value).some(([key, item]) => {
    if (keyPattern.test(key) && meaningful(item)) return true;
    if (Array.isArray(item)) return item.some((entry) => hasDeepEvidence(entry, keyPattern, depth + 1, seen));
    return hasDeepEvidence(item, keyPattern, depth + 1, seen);
  });
}

function statusFor(available, partial = false) {
  return available ? 'AVAILABLE' : partial ? 'PARTIAL' : 'MISSING';
}

function evidenceDetail(parts, fallback = 'Responder confirmation required.') {
  const values = parts.filter(meaningful).map((value) => compactValue(value, 120)).filter(Boolean);
  return values.length ? values.join(' · ') : fallback;
}

function evidencePresentationFor(context = {}) {
  const evaluation = context.evaluation || {};
  const alert = context.alert || {};
  const features = context.featureSnapshot?.features || {};
  const snapshot = evaluation.feature_snapshot || evaluation.featureSnapshot || {};
  const technical = evaluation.technical_evidence || evaluation.technicalEvidence || {};
  const lifecycle = technical.monitoringLifecycle || snapshot.monitoringLifecycle || {};
  const raw = alert.raw_payload || {};
  const extracted = alert.extracted_details || {};
  const identityParts = [
    features.application && `Application ${features.application}`,
    features.service && `Service ${features.service}`,
    features.entity && `Entity ${features.entity}`,
    features.host && `Host ${features.host}`,
    features.fingerprint && `Fingerprint ${features.fingerprint}`,
    features.rule_uid && `Rule ${features.rule_uid}`,
  ].filter(Boolean);
  const identityQuality = String(features.source_identity_quality || '').toUpperCase();
  const identityResolved = features.identity_known === true || features.structured_identity === true
    || features.authoritative_identity === true
    || ['STRUCTURED', 'AUTHORITATIVE', 'RESOLVED', 'MAPPED'].some((value) => identityQuality.includes(value));
  const lifecycleState = meaningful(features.lifecycle_state) ? features.lifecycle_state : null;
  const lifecycleObserved = features.firing_observed === true || features.recovery_observed === true
    || meaningful(features.terminal_state);
  const lifecycleKnown = features.lifecycle_known === true || Boolean(lifecycleState);
  const durationKnown = Number.isFinite(Number(features.episode_duration));
  const occurrenceValue = features.episode_size ?? features.prior_exact_occurrences;
  const occurrenceKnown = Number.isFinite(Number(occurrenceValue));
  const priority = meaningful(features.priority_class) ? features.priority_class
    : raw.priority?.name || raw.priority || null;
  const severity = alert.severity || extracted.severity || raw.severity
    || raw.details?.severity || technical.severity || null;
  const impactKnown = meaningful(features.business_impact) || features.explicit_no_impact === true;
  const symptomsKnown = hasDeepEvidence(technical, /(symptom|error|exception|latency|response.?time|availability|plugin.?output|violation)/i);
  const rootCauseKnown = hasDeepEvidence(technical, /(root.?cause|plugin.?output|health.?rule|exception|failure|error.?type|failure.?categor|diagnostic)/i);
  const sourceTechnicalPresent = meaningful(technical) && features.source_api_available === true;
  const relationships = lifecycle.relationshipEvidence || lifecycle.relationships
    || technical.relationshipEvidence || {};
  const correlationPositive = features.jira_incident_relationship === true
    || features.strong_correlation_candidate === true
    || Number(features.topology_relationship_count || 0) > 0
    || Number(features.dependency_relationship_count || 0) > 0;
  const correlationEvaluated = meaningful(relationships) || hasDeepEvidence(
    technical,
    /(correlation|related.?alert|related.?incident|dependency|topology)/i,
  );
  const operatorAction = features.investigation_present === true
    || features.remediation_present === true || features.escalation_present === true;
  const acknowledged = features.acknowledgement_present === true || alert.acknowledged === true;
  const recoveredState = ['RECOVERED', 'CLOSED', 'NORMAL', 'OK', 'RESOLVED']
    .includes(String(lifecycleState || features.terminal_state || '').toUpperCase());
  const recoveryAvailable = features.recovery_observed === true || recoveredState;
  const additionalParts = [
    meaningful(features.environment) && `Environment ${features.environment}`,
    features.maintenance_detected === true && 'Maintenance context',
    Number(features.slack_thread_activity || 0) > 0 && `Slack activity ${features.slack_thread_activity}`,
    hasDeepEvidence(raw, /(tag|annotation|runbook|maintenance|team)/i) && 'Source annotations',
  ].filter(Boolean);

  const definitions = [
    {
      key: 'IDENTITY_CONFIRMATION',
      status: statusFor(identityResolved && identityParts.length > 0, identityParts.length > 0 || meaningful(features.source)),
      detail: evidenceDetail(identityParts.slice(0, 3)),
    },
    {
      key: 'ALERT_LIFECYCLE',
      status: statusFor(lifecycleKnown && lifecycleObserved, lifecycleKnown || lifecycleObserved),
      detail: evidenceDetail([
        lifecycleState && `State ${lifecycleState}`,
        features.firing_observed === true && 'Firing observed',
        features.recovery_observed === true && 'Recovery observed',
      ]),
    },
    {
      key: 'DURATION_OCCURRENCES',
      status: statusFor(durationKnown && occurrenceKnown, durationKnown || occurrenceKnown),
      detail: evidenceDetail([
        durationKnown && `Duration ${durationText(features.episode_duration)}`,
        occurrenceKnown && `Occurrences ${occurrenceValue}`,
      ]),
    },
    {
      key: 'SEVERITY_PRIORITY',
      status: statusFor(meaningful(priority) && meaningful(severity), meaningful(priority) || meaningful(severity)),
      detail: evidenceDetail([
        meaningful(severity) && `Severity ${severity}`,
        meaningful(priority) && `Priority ${priority}`,
      ]),
    },
    {
      key: 'IMPACT_SYMPTOMS',
      status: statusFor(impactKnown && symptomsKnown, impactKnown || symptomsKnown),
      detail: evidenceDetail([
        impactKnown && `Impact ${features.explicit_no_impact === true ? 'Explicitly none' : features.business_impact}`,
        symptomsKnown && 'Technical symptoms present',
      ]),
    },
    {
      key: 'ROOT_CAUSE_INDICATORS',
      status: statusFor(rootCauseKnown, sourceTechnicalPresent),
      detail: evidenceDetail([
        rootCauseKnown && 'Source-native diagnostic indicators',
        !rootCauseKnown && sourceTechnicalPresent && 'Source evidence present; cause unresolved',
      ]),
    },
    {
      key: 'CORRELATIONS',
      status: statusFor(correlationPositive || correlationEvaluated, Number(features.slack_thread_activity || 0) > 0),
      detail: evidenceDetail([
        features.jira_incident_relationship === true && 'Jira Incident relationship',
        features.strong_correlation_candidate === true && 'Confirmed correlation candidate',
        correlationEvaluated && !correlationPositive && 'Correlation evidence evaluated',
        Number(features.slack_thread_activity || 0) > 0 && `Slack activity ${features.slack_thread_activity}`,
      ]),
    },
    {
      key: 'ACTIONS_TAKEN',
      status: statusFor(operatorAction, acknowledged),
      detail: evidenceDetail([
        acknowledged && 'Acknowledged',
        features.investigation_present === true && 'Investigated',
        features.remediation_present === true && 'Remediated',
        features.escalation_present === true && 'Escalated',
      ]),
    },
    {
      key: 'RECOVERY_DETAILS',
      status: statusFor(recoveryAvailable, lifecycleKnown || features.firing_observed === true),
      detail: evidenceDetail([
        recoveryAvailable && 'Recovery observed',
        Number.isFinite(Number(features.recovery_duration)) && `Recovery ${durationText(features.recovery_duration)}`,
        meaningful(features.terminal_state) && `Terminal ${features.terminal_state}`,
        !recoveryAvailable && lifecycleState && `Current ${lifecycleState}`,
      ]),
    },
    {
      key: 'ADDITIONAL_CONTEXT',
      status: statusFor(additionalParts.length >= 2, additionalParts.length === 1),
      detail: evidenceDetail(additionalParts),
    },
  ];
  const categories = definitions.map((item) => ({
    ...EVIDENCE_REQUIREMENTS[item.key],
    ...item,
  }));
  const needsResponder = categories.filter((item) => item.status !== 'AVAILABLE');
  const availableCount = categories.filter((item) => item.status === 'AVAILABLE').length;
  const overallStatus = needsResponder.length === 0 ? 'AVAILABLE'
    : availableCount > 0 ? 'PARTIAL' : 'MISSING';
  return { availableCount, categories, needsResponder, overallStatus };
}

function slackDate(value) {
  const milliseconds = new Date(value || Date.now()).getTime();
  if (!Number.isFinite(milliseconds)) return 'Timestamp unavailable';
  const seconds = Math.floor(milliseconds / 1000);
  return `<!date^${seconds}^{date_short_pretty} {time}|${new Date(milliseconds).toISOString()}>`;
}

function evidenceMenuOptions(actionContext, { eligible = true, historical = false } = {}) {
  const definitions = eligible && !historical ? [
    ['collect_evidence', 'Collect Evidence'],
    ['update_evidence', 'Update Evidence'],
    ['view_submitted_evidence', 'View Submitted Evidence'],
  ] : [
    ['open_backfill_review', 'Open Backfill Review'],
    ['view_existing_evidence', 'View Existing Evidence'],
  ];
  return definitions.map(([menuAction, label]) => ({
    text: { type: 'plain_text', text: label },
    value: JSON.stringify({
      ...actionContext,
      menuAction,
      origin: menuAction === 'open_backfill_review' ? 'BACKFILL' : actionContext.origin,
      updateEvidence: menuAction === 'update_evidence',
    }),
  }));
}

function verificationActions({ actionContext, jiraUrl }) {
  const elements = [
    { type: 'button', action_id: 'collect_evidence', style: 'primary', text: { type: 'plain_text', text: 'Collect Evidence' }, value: JSON.stringify(actionContext) },
    { type: 'button', action_id: 'view_evidence', text: { type: 'plain_text', text: 'View Evidence' }, value: JSON.stringify(actionContext) },
  ];
  if (jiraUrl) {
    elements.push({ type: 'button', action_id: 'view_jira', text: { type: 'plain_text', text: 'View Jira' }, url: jiraUrl });
  }
  return {
    type: 'actions',
    elements,
  };
}

function buildSlackVerificationCard(context, webBaseUrl = 'http://127.0.0.1:5173') {
  void webBaseUrl;
  const evaluation = context.evaluation;
  const occurrence = context.occurrence || {};
  const alert = context.alert;
  const features = context.featureSnapshot?.features || {};
  const evidence = evidencePresentationFor(context);
  const status = EVIDENCE_STATUS_PRESENTATION[evidence.overallStatus];
  const priority = blockText(occurrence.priority || features.priority_class || alert.raw_payload?.priority?.name, 'Unknown');
  const severity = blockText(alert.severity || alert.extracted_details?.severity || alert.raw_payload?.severity, 'Unknown');
  const source = blockText(occurrence.sourceSystem || features.source || evaluation.source, 'Unknown');
  const alertNumber = occurrence.alertNumber || alert.atlassian_ops_tiny_id || alert.id;
  const alertName = blockText(occurrence.title || alert.title || alert.description, 'Untitled alert');
  const normalized = alert.extracted_details?.normalized_alert || {};
  const jira = alert.extracted_details?.jira || {};
  const sourceUrl = sourceHttpUrl(evaluation.source,
    occurrence.monitoringLink,
    evaluation.technical_evidence?.coverage?.sourceResolution?.deepLink,
    evaluation.technical_evidence?.deepLink,
    evaluation.technical_evidence?.sourceSpecificEvidence,
    normalized.monitoring_event_url,
    normalized.deep_event_link,
    alert.raw_payload?.sourceUrl,
    alert.source_url,
  );
  const jiraUrl = firstHttpUrl(occurrence.jiraLink, normalized.jira_url, jira.issue_url, jira.jira_url, alert.raw_payload?.jiraUrl);
  const revisions = revisionsFor(evaluation);
  const actionContext = {
    alertId: alert.id,
    evaluationId: evaluation.evaluation_id || evaluation.evaluationId,
    decisionRevision: revisions.decisionRevision,
    evidenceRevision: revisions.evidenceRevision,
    featureSnapshotId: context.featureSnapshot?.featureSnapshotId || null,
    systemDecision: canonicalDecision(evaluation.final_decision) || 'NEEDS_REVIEW',
    missingEvidence: evidence.needsResponder.map((item) => item.key),
    origin: occurrence.evidenceWorkflow || context.origin || (isCommandCenterAlert(alert) ? 'LIVE' : 'BACKFILL'),
    occurrenceId: occurrence.occurrenceId || null,
  };
  const responder = blockText(occurrence.responder ?? alert.responderTeam ?? alert.responder ?? alert.team, 'Unassigned');
  const evidenceLabel = occurrence.evidenceStatus
    ? (canonicalEvidenceOutcome(occurrence.evidenceOutcomeStatus || occurrence.evidenceStatus)
      ? evidenceOutcomeLabel(occurrence.evidenceOutcomeStatus || occurrence.evidenceStatus)
      : blockText(occurrence.evidenceStatus).replaceAll('_', ' '))
    : `${status.label} ${evidence.availableCount}/${evidence.categories.length}`;
  const evidencePercent = Number.isFinite(Number(occurrence.evidenceCompletionPercentage))
    ? Math.max(0, Math.min(100, Number(occurrence.evidenceCompletionPercentage)))
    : Math.round((evidence.availableCount / evidence.categories.length) * 100);
  const automaticEvidence = (occurrence.automaticallyCollectedEvidence || [])
    .slice(0, 5)
    .map((item) => `• *${blockText(item.field)}:* ${blockText(item.value)}`)
    .join('\n') || 'Not available';
  return {
    text: `${alertName} (#${alertNumber})`,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: '🚨 EVIDENCE COLLECTION REQUIRED', emoji: true } },
      { type: 'section', text: { type: 'mrkdwn', text: `*${alertName}* (#${blockText(alertNumber)})` } },
      { type: 'divider' },
      { type: 'section', fields: [
        { type: 'mrkdwn', text: `*Responder*\n${responder}` },
        { type: 'mrkdwn', text: `*Source*\n${source}` },
        { type: 'mrkdwn', text: `*Priority*\n${priority}` },
        { type: 'mrkdwn', text: `*Severity*\n${severity}` },
        { type: 'mrkdwn', text: `*Environment*\n${blockText(occurrence.environment || features.environment || alert.environment, 'Unknown')}` },
        { type: 'mrkdwn', text: `*Alert timestamp*\n${slackDate(occurrence.timestamp || alert.received_at || evaluation.feature_as_of)}` },
        { type: 'mrkdwn', text: `*Current status*\n${blockText(occurrence.status || alert.status, 'Unknown')}` },
        { type: 'mrkdwn', text: `*Current system decision*\n${blockText(occurrence.currentDecision || evaluation.final_decision, 'NEEDS_REVIEW')}` },
        { type: 'mrkdwn', text: `*Evidence status*\n${status.icon} ${evidenceLabel}` },
        { type: 'mrkdwn', text: `*Evidence completion*\n${evidencePercent}%` },
      ] },
      ...(occurrence.pendingEvidenceReason ? [{
        type: 'section', text: { type: 'mrkdwn', text: `*Why evidence is pending*\n${blockText(occurrence.pendingEvidenceReason)}` },
      }] : []),
      { type: 'section', fields: [
        { type: 'mrkdwn', text: `*Source availability*\n${blockText(occurrence.sourceAvailability, 'Unable to verify').replaceAll('_', ' ')}` },
        { type: 'mrkdwn', text: `*Last refreshed*\n${slackDate(occurrence.evidenceLastRefreshedAt || evaluation.feature_as_of)}` },
      ] },
      { type: 'section', text: { type: 'mrkdwn', text: `*Automatically collected evidence*\n${automaticEvidence}` } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: `*Provenance:* Slack source message${occurrence.evidenceLastRefreshedAt ? ` · refreshed ${slackDate(occurrence.evidenceLastRefreshedAt)}` : ''}` }] },
      ...(sourceUrl ? [{
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `*Monitoring source:* <${sourceUrl}|View source alert>` }],
      }] : []),
      { type: 'divider' },
      verificationActions({
        actionContext, jiraUrl,
      }),
      { type: 'context', elements: [{ type: 'mrkdwn', text: 'Evidence is append-only. This workflow does not modify Jira or the monitoring alert.' }] },
    ],
  };
}

function buildControlledTestCard(testRunId, webBaseUrl = 'http://127.0.0.1:5173', modelState = {}) {
  void webBaseUrl;
  void modelState;
  const actionContext = {
    alertId: `TEST_ALERT_${testRunId}`,
    evaluationId: 'TEST_DECISION_V1',
    decisionRevision: 'TEST_DECISION_V1',
    evidenceRevision: 'TEST_EVIDENCE_V1',
    featureSnapshotId: `TEST_FEATURE_${testRunId}`,
    systemDecision: 'NEEDS_REVIEW', isTest: true, testRunId,
    missingEvidence: [],
  };
  return {
    text: 'TEST ALERT — NOT A PRODUCTION ALERT',
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: '🧪 TEST ALERT — NOT A PRODUCTION ALERT', emoji: true } },
      { type: 'section', text: { type: 'mrkdwn', text: `*Synthetic verification alert* (#TEST-${blockText(testRunId)})` } },
      { type: 'divider' },
      { type: 'section', fields: [
        { type: 'mrkdwn', text: '*Responder / team*\nCommand Center' },
        { type: 'mrkdwn', text: '*Source*\nTEST SOURCE' },
        { type: 'mrkdwn', text: '*Priority*\nP3' },
        { type: 'mrkdwn', text: '*Severity*\nTEST' },
        { type: 'mrkdwn', text: '*Environment*\nTest' },
        { type: 'mrkdwn', text: `*Received*\n${slackDate()}` },
        { type: 'mrkdwn', text: '*System decision*\nNEEDS_REVIEW' },
        { type: 'mrkdwn', text: '*Evidence status*\n✅ Available 10/10' },
      ] },
      { type: 'divider' },
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: '*Monitoring source:* <https://example.com/slack-controlled-test-source|Synthetic source link>' }],
      },
      verificationActions({
        actionContext,
        jiraUrl: 'https://example.com/slack-controlled-test-jira',
      }),
      { type: 'context', elements: [{ type: 'mrkdwn', text: 'Synthetic test only · No production alert or external system will be changed.' }] },
    ],
  };
}

function modalFor(decision, actionContext) {
  const changed = decision !== actionContext.systemDecision;
  const reasonOptions = decision === 'NOISE' ? NOISE_REASONS
    : decision === 'INCIDENT' ? INCIDENT_REASONS : REVIEW_REASONS;
  const missingEvidence = normalizeEvidenceKeys(actionContext.missingEvidence);
  const blocks = [];
  if (missingEvidence.length) blocks.push({
    type: 'section', block_id: 'information_needed',
    text: {
      type: 'mrkdwn',
      text: `*Information Needed From Responder*\n${missingEvidence.map((key) => `• *${EVIDENCE_REQUIREMENTS[key].label}* — ${EVIDENCE_REQUIREMENTS[key].prompt}`).join('\n')}`,
    },
  });
  if (decision === 'NOISE') blocks.push({
    type: 'input', block_id: 'human_subtype', label: { type: 'plain_text', text: 'Noise subtype' },
    element: { type: 'static_select', action_id: 'value', options: NOISE_SUBTYPES.map((value) => ({ text: { type: 'plain_text', text: value.replaceAll('_', ' ') }, value })) },
  });
  blocks.push({
    type: 'input', block_id: 'reason_code', label: { type: 'plain_text', text: changed ? 'Reason for changing the system decision' : 'Reason code' },
    element: { type: 'static_select', action_id: 'value', options: reasonOptions.map((value) => ({ text: { type: 'plain_text', text: value.replaceAll('_', ' ') }, value })) },
  });
  blocks.push({
    type: 'input', block_id: 'human_evidence',
    label: { type: 'plain_text', text: missingEvidence.length ? 'Information Needed From Responder' : 'Responder Evidence / Operational Observation' },
    hint: { type: 'plain_text', text: missingEvidence.length
      ? `Address the requested operational facts: ${missingEvidence.map((key) => EVIDENCE_REQUIREMENTS[key].label).join(', ')}.`
      : 'Record the operational facts that support your decision.' },
    element: { type: 'plain_text_input', action_id: 'value', multiline: true, max_length: 3000 },
  });
  blocks.push({
    type: 'input', optional: true, block_id: 'comment', label: { type: 'plain_text', text: 'Comment (optional)' },
    element: { type: 'plain_text_input', action_id: 'value', multiline: true, max_length: 2000 },
  });
  return {
    type: 'modal', callback_id: 'human_verification_modal',
    private_metadata: JSON.stringify({ ...actionContext, humanDecision: decision }),
    title: { type: 'plain_text', text: 'Verify alert outcome' },
    submit: { type: 'plain_text', text: 'Submit verification' },
    close: { type: 'plain_text', text: 'Cancel' }, blocks,
  };
}

function plainOption(value, label = value) {
  return { text: { type: 'plain_text', text: String(label).replaceAll('_', ' ').slice(0, 75) }, value };
}

function modalSection(text) {
  return { type: 'header', text: { type: 'plain_text', text: text.slice(0, 150), emoji: true } };
}

function textInput(blockId, label, { initialValue = null, multiline = false, optional = true, hint = null, maxLength = 2000 } = {}) {
  const element = {
    type: 'plain_text_input', action_id: 'value', multiline, max_length: maxLength,
    ...(compactValue(initialValue, maxLength) ? { initial_value: compactValue(initialValue, maxLength) } : {}),
  };
  return {
    type: 'input', block_id: blockId, optional,
    label: { type: 'plain_text', text: label.slice(0, 75) },
    ...(hint ? { hint: { type: 'plain_text', text: hint.slice(0, 2000) } } : {}),
    element,
  };
}

function selectInput(blockId, label, options, { initialValue = null, optional = true } = {}) {
  const normalized = options.map((option) => typeof option === 'string'
    ? plainOption(option)
    : plainOption(option.value, option.label));
  const optionValues = options.map((option) => typeof option === 'string' ? option : option.value);
  const selected = normalized.find((option) => option.value === initialValue);
  const element = {
    type: 'static_select', action_id: 'value', options: normalized,
    ...(initialValue && optionValues.includes(initialValue) && selected ? { initial_option: selected } : {}),
  };
  return {
    type: 'input', block_id: blockId, optional,
    label: { type: 'plain_text', text: label.slice(0, 75) }, element,
  };
}

function multiSelectInput(blockId, label, options, { initialValues = [], optional = true } = {}) {
  const normalized = options.map((option) => typeof option === 'string'
    ? plainOption(option)
    : plainOption(option.value, option.label));
  const selected = normalized.filter((option) => initialValues.includes(option.value));
  return {
    type: 'input', block_id: blockId, optional,
    label: { type: 'plain_text', text: label.slice(0, 75) },
    element: {
      type: 'multi_static_select', action_id: 'value', options: normalized,
      ...(selected.length ? { initial_options: selected } : {}),
    },
  };
}

function dateInput(blockId, label, initialDate = null, optional = true) {
  return {
    type: 'input', block_id: blockId, optional,
    label: { type: 'plain_text', text: label.slice(0, 75) },
    element: {
      type: 'datepicker', action_id: 'value',
      ...(initialDate ? { initial_date: initialDate } : {}),
    },
  };
}

function timeInput(blockId, label, initialTime = null, optional = true) {
  return {
    type: 'input', block_id: blockId, optional,
    label: { type: 'plain_text', text: label.slice(0, 75) },
    element: {
      type: 'timepicker', action_id: 'value', timezone: 'Asia/Kolkata',
      ...(initialTime ? { initial_time: initialTime } : {}),
    },
  };
}

function linkLine(label, value) {
  return value ? `*${label}*\n<${value}|Open>` : null;
}

function sourceSpecificValues(source, { alert = {}, evaluation = {}, features = {}, identity = {}, normalized = {}, technical = {} } = {}) {
  const sourceName = String(source || '').trim().toUpperCase();
  const raw = alert.raw_payload || {};
  const sourceEvidence = (Array.isArray(technical.sourceSpecificEvidence)
    ? technical.sourceSpecificEvidence : [])
    .find((item) => String(item?.source || '').trim().toUpperCase() === sourceName) || {};
  const sourceMetadata = sourceEvidence.metadata || {};
  const coverageFields = technical.coverage?.evidenceCompleteness?.fields || {};
  const technicalIdentity = technical.identity || {};
  const pick = (...values) => values.find(meaningful) ?? null;
  const field = (blockId, label, initialValue, options = {}) => ({ blockId, label, initialValue, ...options });

  if (sourceName.includes('APPDYNAMICS')) {
    return {
      label: 'AppDynamics Evidence',
      fields: [
        field('source_application', 'Application', pick(identity.application, features.application, normalized.application, sourceMetadata.applicationName, technicalIdentity.application)),
        field('source_tier', 'Tier', pick(identity.tier, features.tier, normalized.tier, technical.tier, sourceMetadata.tier)),
        field('source_node', 'Node', pick(identity.node, features.node, normalized.node, technical.node, sourceMetadata.node, sourceEvidence.entity)),
        field('source_business_transaction', 'Business transaction', pick(features.business_transaction, normalized.business_transaction, technical.businessTransaction, sourceMetadata.businessTransaction)),
        field('source_health_rule', 'Health rule', pick(features.health_rule, normalized.health_rule, technical.healthRule, sourceMetadata.healthRule, sourceMetadata.policy)),
        field('source_event_id', 'Event ID', pick(features.event_id, normalized.event_id, raw.eventId, technical.eventId, sourceMetadata.eventId, sourceMetadata.violationId)),
        field('source_violation_status', 'Violation status', pick(features.violation_status, normalized.violation_status, technical.violationStatus, sourceMetadata.currentState, sourceMetadata.occurrenceState, sourceMetadata.state)),
      ],
    };
  }
  if (sourceName.includes('GRAFANA')) {
    const grafanaLink = sourceHttpUrl(sourceName,
      coverageFields.panelDeepLink, coverageFields.dashboardDeepLink,
      technical.coverage?.sourceResolution?.deepLink, sourceEvidence.url,
      technical.deepLink, normalized.dashboard_url, raw.dashboardUrl, raw.sourceUrl,
    );
    return {
      label: 'Grafana Evidence',
      fields: [
        field('source_dashboard_url', 'Dashboard URL', pick(coverageFields.dashboardDeepLink, sourceMetadata.dashboardUrl, normalized.dashboard_url, raw.dashboardUrl, technical.dashboardUrl)),
        field('source_rule_uid', 'Rule UID', pick(coverageFields.ruleUid, sourceMetadata.ruleUid, sourceMetadata.ruleUID, features.rule_uid, normalized.rule_uid, raw.ruleUID, technical.ruleUID)),
        field('source_panel', 'Panel', pick(coverageFields.panelTitle, coverageFields.panelId, sourceMetadata.panelTitle, sourceMetadata.panelId, features.panel, normalized.panel, raw.panel, technical.panel)),
        field('source_alert_state', 'Alert state', pick(coverageFields.state, sourceMetadata.currentState, sourceMetadata.occurrenceState, sourceMetadata.state, technical.currentState, features.lifecycle_state, normalized.alert_state, technical.alertState)),
        field('source_metric', 'Metric', pick(coverageFields.metric, sourceMetadata.metric, sourceMetadata.query, sourceMetadata.datasource, features.metric, normalized.metric, technical.metric)),
        field('source_grafana_link', 'Grafana source link', grafanaLink),
        field('source_grafana_evidence_timestamp', 'Grafana evidence timestamp', pick(
          coverageFields.stateObservedAt, sourceMetadata.sourceProvenance?.evidenceAsOf,
          sourceMetadata.sourceProvenance?.sourceEventTime, sourceEvidence.timestamp,
          technical.timestamp, technical.coverage?.evidenceCompleteness?.provenance?.ruleName?.retrievedAt,
        )),
      ],
    };
  }
  if (sourceName.includes('NAGIOS')) {
    return {
      label: 'Nagios Evidence',
      fields: [
        field('source_host', 'Host', pick(identity.host, features.host, normalized.host, raw.host, sourceMetadata.host, sourceEvidence.entity)),
        field('source_service', 'Service', pick(identity.service, features.service, normalized.service, raw.service, sourceMetadata.service)),
        field('source_plugin_output', 'Plugin output', pick(normalized.plugin_output, raw.pluginOutput, raw.output, technical.pluginOutput, sourceMetadata.pluginOutput, sourceEvidence.summary), { multiline: true }),
        field('source_state', 'State', pick(features.lifecycle_state, normalized.state, raw.state, technical.state, sourceMetadata.currentState, sourceMetadata.state)),
        field('source_acknowledgement_status', 'Acknowledgement status', pick(normalized.acknowledgement_status, raw.acknowledged, alert.acknowledged, sourceMetadata.acknowledged)),
      ],
    };
  }
  if (sourceName.includes('THOUSANDEYES')) {
    return {
      label: 'ThousandEyes Evidence',
      fields: [
        field('source_test', 'Test', pick(identity.test, features.test, normalized.test, raw.testName, sourceMetadata.testName)),
        field('source_rule', 'Rule', pick(features.rule_title, normalized.rule_name, raw.ruleName, technical.rule, sourceMetadata.ruleName, sourceEvidence.title)),
        field('source_agent_location', 'Agent or location', pick(features.agent, normalized.agent, normalized.location, technical.agentLocation, sourceMetadata.agent, sourceMetadata.location)),
        field('source_metric', 'Metric', pick(features.metric, normalized.metric, technical.metric, sourceMetadata.metric)),
        field('source_alert_state', 'Alert state', pick(features.lifecycle_state, normalized.alert_state, technical.alertState, sourceMetadata.currentState, sourceMetadata.state)),
      ],
    };
  }
  return null;
}

function sourceSpecificDefaults(value) {
  if (!value) return {};
  return Object.fromEntries(value.fields.map((field) => [
    field.blockId.replace(/_([a-z])/g, (_match, letter) => letter.toUpperCase()),
    field.initialValue ?? null,
  ]));
}

function monitoringEntityChoices(sourceSpecific, identity = {}, features = {}, alert = {}) {
  const values = sourceSpecificDefaults(sourceSpecific);
  const unique = (...items) => [...new Set(items.flat().map((value) => compactValue(value, 255)).filter(Boolean))]
    .map((value) => ({ value, label: value }));
  return {
    applications: unique(values.sourceApplication, identity.application, features.application, alert.application),
    services: unique(values.sourceService, identity.service, features.service, alert.service),
    hosts: unique(values.sourceHost, values.sourceNode, identity.host, identity.node, features.host, features.node),
    tiers: unique(values.sourceTier, identity.tier, features.tier),
    rules: unique(values.sourceRule, values.sourceHealthRule, identity.rule, features.rule_title),
    instances: unique(values.sourceEventId, values.sourceRuleUid, identity.entityId, identity.entity, features.entity),
  };
}

function valueForForm(values, snakeKey, fallback = null) {
  const camelKey = snakeKey.replace(/_([a-z])/g, (_match, letter) => letter.toUpperCase());
  return firstInput(values, snakeKey, camelKey) ?? fallback;
}

function istDateTimeParts(value) {
  const date = new Date(value || Date.now());
  if (!Number.isFinite(date.getTime())) return { date: null, time: null };
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

function buildEvidenceCollectionModal(context, actionContext = {}) {
  const evaluation = context.evaluation || {};
  const alert = context.alert || {};
  const features = context.featureSnapshot?.features || {};
  const identity = evaluation.feature_snapshot?.identity || {};
  const technical = evaluation.technical_evidence || {};
  const normalized = alert.extracted_details?.normalized_alert || {};
  const jira = alert.extracted_details?.jira || {};
  const slack = alert.extracted_details?.slack || alert.extracted_details?.slack_enrichment || {};
  const evidence = evidencePresentationFor(context);
  const values = { ...(context.evidenceReview?.values || {}), ...(actionContext.draftValues || {}) };
  const page = Math.min(Math.max(Number(actionContext.formPage || 1), 1), 4);
  const alertNumber = alert.atlassian_ops_tiny_id || alert.id;
  const alertName = blockText(alert.title || alert.description, 'Untitled alert');
  const source = blockText(features.source || evaluation.source, 'Unknown');
  const priority = blockText(features.priority_class || alert.raw_payload?.priority?.name, 'Unknown');
  const sourceAlertLink = sourceHttpUrl(source,
    technical.coverage?.sourceResolution?.deepLink, technical.deepLink,
    technical.sourceSpecificEvidence,
    normalized.monitoring_event_url, normalized.deep_event_link,
    alert.raw_payload?.sourceUrl, alert.source_url,
  );
  const jiraLink = firstHttpUrl(normalized.jira_url, jira.issue_url, jira.jira_url, alert.raw_payload?.jiraUrl);
  const slackMessageLink = firstHttpUrl(slack.permalink, slack.slack_permalink, alert.raw_payload?.slackPermalink);
  const sourceSpecific = sourceSpecificValues(source, { alert, evaluation, features, identity, normalized, technical });
  const entityChoices = monitoringEntityChoices(sourceSpecific, identity, features, alert);
  const metadata = {
    ...actionContext,
    draftValues: actionContext.draftValues || {},
    alertId: alert.id,
    evaluationId: evaluation.evaluation_id || evaluation.evaluationId,
    systemDecision: canonicalDecision(evaluation.final_decision) || 'NEEDS_REVIEW',
    missingEvidence: evidence.needsResponder.map((item) => item.key),
    refreshEventId: context.evidenceReview?.refreshEventId || actionContext.refreshEventId || null,
    formPage: page,
  };
  const responder = blockText(alert.responderTeam ?? alert.responder ?? alert.team, 'Unassigned');
  const actionValue = (targetPage) => JSON.stringify({ ...metadata, formPage: targetPage });
  const navigation = (includeDraft = false) => ({
    type: 'actions', block_id: 'evidence_page_actions', elements: [
      ...(page > 1 ? [{ type: 'button', action_id: 'evidence_page_back', text: { type: 'plain_text', text: 'Back' }, value: actionValue(page - 1) }] : []),
      ...(includeDraft ? [{ type: 'button', action_id: 'evidence_save_draft', text: { type: 'plain_text', text: 'Save Draft' }, value: actionValue(page) }] : []),
      ...(page < 4 ? [{ type: 'button', action_id: 'evidence_page_next', style: 'primary', text: { type: 'plain_text', text: 'Next' }, value: actionValue(page + 1) }] : []),
    ],
  });
  const select = (id, label, schemaKey) => selectInput(id, label, STRUCTURED_EVIDENCE_SCHEMA[schemaKey], {
    initialValue: valueForForm(values, id), optional: true,
  });
  const multi = (id, label, schemaKey) => multiSelectInput(id, label, STRUCTURED_EVIDENCE_SCHEMA[schemaKey], {
    initialValues: valueForForm(values, id, []), optional: true,
  });
  const entitySelects = Object.entries({
    source_application: ['Application', entityChoices.applications],
    source_service: ['Service', entityChoices.services],
    source_host: ['Host or node', entityChoices.hosts],
    source_tier: ['Tier', entityChoices.tiers],
    source_rule: ['Rule', entityChoices.rules],
    source_event_id: ['Instance or event', entityChoices.instances],
  }).flatMap(([id, [label, options]]) => options.length ? [selectInput(id, label, options, {
    initialValue: valueForForm(values, id, options[0]?.value), optional: true,
  })] : []);
  const conditionalNotesNeeded = [
    valueForForm(values, 'monitoring_match'), valueForForm(values, 'monitoring_state'),
    valueForForm(values, 'evidence_strength'), valueForForm(values, 'source_evidence_verified'),
  ].some((value) => ['CONFLICTING', 'UNABLE_TO_VERIFY', 'UNABLE_TO_RETRIEVE'].includes(value))
    || valueForForm(values, 'evidence_types', []).includes('CONFLICTING_EVIDENCE');
  const selectedNoiseReasons = valueForForm(values, 'noise_reasons', []);
  const conditionalNoiseBlocks = [
    ...(selectedNoiseReasons.includes('EXACT_DUPLICATE') ? [select('duplicate_match', 'Matching alert occurrence', 'duplicateMatch')] : []),
    ...(selectedNoiseReasons.includes('FLAPPING') ? [
      select('flapping_count', 'Firing/recovery count', 'flappingCount'),
      select('flapping_window', 'Flapping time window', 'persistence'),
    ] : []),
    ...(selectedNoiseReasons.includes('AUTO_RESOLVED_WITHOUT_IMPACT') ? [
      select('recovery_confirmed', 'Recovery confirmed', 'verification'),
      select('no_impact_confirmed', 'No impact confirmed', 'verification'),
    ] : []),
    ...(selectedNoiseReasons.includes('CORRELATED_CHILD_ALERT') ? [select('correlation_reference', 'Parent alert or incident reference', 'referenceType')] : []),
    ...(selectedNoiseReasons.includes('PLANNED_MAINTENANCE') ? [select('maintenance_reference', 'Maintenance/change reference', 'referenceType')] : []),
    ...(selectedNoiseReasons.includes('STALE_ALERT') ? [
      dateInput('stale_last_observed_date', 'Last observed date', valueForForm(values, 'stale_last_observed_date')),
      timeInput('stale_last_observed_time', 'Last observed time (Asia/Kolkata)', valueForForm(values, 'stale_last_observed_time')),
      select('no_active_impact_confirmed', 'No active impact confirmed', 'verification'),
    ] : []),
    ...(selectedNoiseReasons.includes('EXPECTED_BEHAVIOR') ? [select('expected_event_category', 'Approved event category', 'expectedEventCategory')] : []),
  ];
  const pages = {
    1: [
      modalSection('1 of 4 · Alert Summary'),
      { type: 'section', text: { type: 'mrkdwn', text: `*${alertName}* (#${blockText(alertNumber)})\nAll identity fields are read-only and prefilled from stored source evidence.` } },
      { type: 'section', fields: [
        { type: 'mrkdwn', text: `*Monitoring source*\n${source}` }, { type: 'mrkdwn', text: `*Priority*\n${priority}` },
        { type: 'mrkdwn', text: `*Application / service / host*\n${blockText(identity.application || identity.service || identity.host || alert.service)}` },
        { type: 'mrkdwn', text: `*Environment*\n${blockText(alert.environment || features.environment, 'Unknown')}` },
        { type: 'mrkdwn', text: `*Responder*\n${responder}` },
        { type: 'mrkdwn', text: `*Alert time*\n${slackDate(alert.received_at || evaluation.feature_as_of)}` },
      ] },
      { type: 'section', fields: [
        { type: 'mrkdwn', text: `*Monitoring link*\n${sourceAlertLink ? `<${sourceAlertLink}|Open source>` : 'Not available'}` },
        { type: 'mrkdwn', text: `*Slack link*\n${slackMessageLink ? `<${slackMessageLink}|Open message>` : 'Not available'}` },
        { type: 'mrkdwn', text: `*Jira link*\n${jiraLink ? `<${jiraLink}|Open Jira>` : 'Not available'}` },
        { type: 'mrkdwn', text: `*Evidence status*\n${context.previousReports?.[0]?.outcomeLabel || 'Evidence Pending'}` },
      ] },
      navigation(),
    ],
    2: [
      modalSection('2 of 4 · Monitoring Evidence'),
      select('monitoring_match', 'Monitoring match', 'monitoringMatch'),
      select('monitoring_state', 'Monitoring state', 'monitoringState'),
      select('technical_condition', 'Technical condition', 'technicalCondition'),
      multi('evidence_types', 'Evidence type (select all that apply)', 'evidenceTypes'),
      select('evidence_strength', 'Evidence strength', 'evidenceStrength'),
      ...entitySelects,
      navigation(),
    ],
    3: [
      modalSection('3 of 4 · Impact and Noise Pattern'),
      select('customer_impact', 'Customer impact', 'impact'),
      select('service_impact', 'Service impact', 'impact'),
      select('impact_level', 'Impact level', 'impactLevel'),
      multi('affected_scope', 'Affected scope (select all that apply)', 'affectedScope'),
      select('persistence_band', 'Persistence', 'persistence'),
      multi('noise_reasons', 'Noise reason (select all that apply)', 'noiseReasons'),
      select('actionability', 'Actionability', 'actionability'),
      navigation(),
    ],
    4: [
      modalSection('4 of 4 · Final Decision and Confirmation'),
      ...conditionalNoiseBlocks,
      selectInput('human_decision', 'Final evidence-based decision', STRUCTURED_EVIDENCE_SCHEMA.finalDecisions, {
        initialValue: valueForForm(values, 'human_decision'), optional: true,
      }),
      select('evidence_reviewed', 'Evidence reviewed', 'yesNo'),
      select('source_evidence_verified', 'Source evidence verified', 'sourceVerification'),
      select('decision_confidence', 'Decision confidence', 'confidence'),
      ...(conditionalNotesNeeded ? [textInput('exception_notes', 'Conflict or unavailable-evidence note', {
        initialValue: valueForForm(values, 'exception_notes'), multiline: true, optional: true,
      })] : []),
      {
        type: 'input', block_id: 'file_attachments', optional: true,
        label: { type: 'plain_text', text: 'Supporting files (optional)' },
        element: { type: 'file_input', action_id: 'value', max_files: 5 },
      },
      navigation(true),
      { type: 'context', elements: [{ type: 'mrkdwn', text: 'Incomplete or conflicting evidence is saved as *Evidence Pending*. Priority never determines the final evidence outcome.' }] },
    ],
  };
  const blocks = pages[page];
  return {
    type: 'modal', callback_id: 'collect_evidence_modal',
    private_metadata: JSON.stringify(metadata),
    title: { type: 'plain_text', text: evidenceModalTitle(alertNumber) },
    ...(page === 4 ? { submit: { type: 'plain_text', text: 'Update Evidence' } } : {}),
    close: { type: 'plain_text', text: 'Cancel' },
    blocks,
  };
}

const REVIEW_FIELD_LABELS = Object.freeze({
  evidenceCategory: 'Evidence category',
  whatIsHappening: 'What was observed',
  lifecycleStatus: 'Current alert status',
  impactScale: 'Business/customer impact',
  customersExperiencing: 'Customer experience',
  whoImpacted: 'Who is impacted',
  reproducibility: 'Reproducibility',
  actionTaken: 'Was action taken',
  actionsTaken: 'Actions taken',
  investigationPerformed: 'Investigation notes',
  monitoringToolLinks: 'Monitoring evidence link',
  operationsAlertLinks: 'JSM Operations alert link',
  jiraLinks: 'Jira link',
  slackLinks: 'Slack link',
  humanDecision: 'Final human decision',
  decisionJustification: 'Decision justification',
  additionalComments: 'Additional comments',
});

function humanEvidenceSource(report) {
  return report?.validationStatus === 'VALIDATED' ? 'Human verified' : 'Previously submitted';
}

const SOURCE_AVAILABILITY = Object.freeze({
  AVAILABLE: Object.freeze({ icon: '✅', label: 'Available' }),
  UNAVAILABLE: Object.freeze({ icon: '🔴', label: 'Unavailable' }),
  NOT_CONFIGURED: Object.freeze({ icon: '⚪', label: 'Not configured' }),
  UNABLE_TO_VERIFY: Object.freeze({ icon: '🟡', label: 'Unable to verify' }),
});

function monitoringSourceKey(value) {
  const source = String(value || '').toUpperCase();
  if (source.includes('APPDYNAMICS')) return 'APPDYNAMICS';
  if (source.includes('GRAFANA')) return 'GRAFANA';
  if (source.includes('NAGIOS')) return 'NAGIOS';
  if (source.includes('THOUSANDEYES')) return 'THOUSANDEYES';
  return null;
}

function sourceEvidenceItems(technical, sourceKey) {
  return (Array.isArray(technical?.sourceSpecificEvidence) ? technical.sourceSpecificEvidence : [])
    .filter((item) => monitoringSourceKey(item?.source) === sourceKey);
}

function connectivityAvailability(rows = []) {
  const grouped = {};
  for (const row of rows) {
    const key = monitoringSourceKey(row.source);
    if (!key) continue;
    const status = row.source_data_usable === true || row.status === 'CONNECTED'
      ? 'AVAILABLE'
      : row.configured === false || row.status === 'NOT_CONFIGURED'
        ? 'NOT_CONFIGURED'
        : row.status
          ? 'UNAVAILABLE'
          : 'UNABLE_TO_VERIFY';
    const candidate = { status, updatedAt: toIso(row.checked_at) };
    const rank = { AVAILABLE: 4, UNAVAILABLE: 3, NOT_CONFIGURED: 2, UNABLE_TO_VERIFY: 1 };
    if (!grouped[key] || rank[candidate.status] > rank[grouped[key].status]) grouped[key] = candidate;
  }
  return grouped;
}

function monitoringAvailability(sourceKey, activeSource, technical, features, refreshedAt, knownAvailability = {}) {
  const items = sourceEvidenceItems(technical, sourceKey);
  const evidenceAt = items.map((item) => (
    item?.metadata?.sourceProvenance?.evidenceAsOf
    || item?.metadata?.sourceProvenance?.sourceEventTime
    || item?.timestamp
  )).find(Boolean);
  if (items.some((item) => meaningful(item))) {
    return { status: 'AVAILABLE', updatedAt: evidenceAt || technical.timestamp || refreshedAt };
  }
  if (sourceKey !== activeSource) {
    return knownAvailability[sourceKey] || { status: 'UNABLE_TO_VERIFY', updatedAt: refreshedAt };
  }

  const resolution = technical.coverage?.sourceResolution || {};
  const completeness = technical.coverage?.evidenceCompleteness || {};
  const failure = String(
    resolution.failureReason || technical.provenance?.primaryFailureReason || completeness.status || '',
  ).toUpperCase();
  const state = String(
    resolution.status || technical.provenance?.primaryStatus || completeness.status || '',
  ).toUpperCase();
  if (failure.includes('NOT_CONFIGURED') || state.includes('NOT_CONFIGURED')) {
    return { status: 'NOT_CONFIGURED', updatedAt: technical.timestamp || refreshedAt };
  }
  if (features.source_api_available === true
    || ['AVAILABLE', 'CONNECTED', 'READ_ONLY_SUCCESS', 'SOURCE_RESOLVED', 'WORKING'].includes(state)) {
    return { status: 'AVAILABLE', updatedAt: technical.timestamp || refreshedAt };
  }
  if (features.source_api_available === false
    || /(UNAVAILABLE|ERROR|FAILED|TIMEOUT|CIRCUIT|DNS|FORBIDDEN|AUTHENTICATION)/.test(`${state} ${failure}`)) {
    return { status: 'UNAVAILABLE', updatedAt: technical.timestamp || refreshedAt };
  }
  return knownAvailability[sourceKey]
    || { status: 'UNABLE_TO_VERIFY', updatedAt: technical.timestamp || refreshedAt };
}

function retainLastKnownStatus(current, previous) {
  if (current?.status === 'UNAVAILABLE' && previous?.status === 'AVAILABLE') {
    return {
      ...current,
      stale: true,
      lastKnownUpdatedAt: previous.updatedAt || null,
      detail: 'Source unavailable — last known evidence retained',
    };
  }
  if (current?.status !== 'UNABLE_TO_VERIFY' || !previous?.status
    || previous.status === 'UNABLE_TO_VERIFY') return current;
  return {
    ...previous,
    stale: true,
    checkedAt: current.updatedAt,
    detail: 'Source unavailable — last known evidence retained',
  };
}

function storedEvidenceSnapshot(context, previousReports = [], previousSnapshot = null, draftValues = null, refreshedAt = new Date().toISOString()) {
  const alert = context.alert || {};
  const evaluation = context.evaluation || {};
  const features = context.featureSnapshot?.features || {};
  const technical = evaluation.technical_evidence || {};
  const identity = evaluation.feature_snapshot?.identity || {};
  const normalized = alert.extracted_details?.normalized_alert || {};
  const jira = alert.extracted_details?.jira || {};
  const slack = alert.extracted_details?.slack || alert.extracted_details?.slack_enrichment || {};
  const source = String(features.source || evaluation.source || '').toUpperCase();
  const sourceSpecific = sourceSpecificValues(source, { alert, evaluation, features, identity, normalized, technical });
  const sourceUrl = sourceHttpUrl(source,
    technical.coverage?.sourceResolution?.deepLink, technical.deepLink,
    technical.sourceSpecificEvidence,
    normalized.monitoring_event_url, normalized.deep_event_link,
    alert.raw_payload?.sourceUrl, alert.source_url,
  );
  const jiraUrl = firstHttpUrl(normalized.jira_url, jira.issue_url, jira.jira_url, alert.raw_payload?.jiraUrl);
  const slackUrl = firstHttpUrl(
    context.slackMessageLink,
    slack.permalink,
    slack.slack_permalink,
    alert.raw_payload?.slackPermalink,
  );
  const operationsUrl = isAtlassianUrl(alert.source_url) ? alert.source_url : null;
  const state = String(features.lifecycle_state || alert.status || '').toUpperCase();
  const lifecycleStatus = ['RECOVERED', 'CLOSED', 'NORMAL', 'OK', 'RESOLVED'].includes(state)
    ? 'RECOVERED' : state === 'FLAPPING' ? 'FLAPPING'
      : alert.acknowledged ? 'ACKNOWLEDGED' : features.firing_observed === true ? 'FIRING' : 'UNKNOWN';
  const durationSecondsValue = Number(features.source_duration_seconds ?? features.persistence_duration_seconds
    ?? technical.monitoringLifecycle?.persistence?.durationSeconds);
  const structuredPersistence = Number.isFinite(durationSecondsValue)
    ? durationSecondsValue < 300 ? 'LT_5_MINUTES'
      : durationSecondsValue < 900 ? 'MINUTES_5_TO_15'
        : durationSecondsValue < 3600 ? 'MINUTES_15_TO_60'
          : durationSecondsValue > 432000 ? 'GT_5_DAYS' : 'GT_1_HOUR'
    : 'UNKNOWN';
  const structuredEvidenceTypes = source.includes('APPDYNAMICS') ? ['HEALTH_RULE_VIOLATION']
    : source.includes('GRAFANA') ? ['ALERT_RULE_RESULT']
      : source.includes('NAGIOS') ? ['FAILED_SERVICE_CHECK'] : [];
  if (lifecycleStatus === 'RECOVERED') structuredEvidenceTypes.push('RECOVERY_EVENT');
  if (lifecycleStatus === 'FLAPPING') structuredEvidenceTypes.push('REPEATED_FIRING');
  const autoValues = {
    schemaVersion: STRUCTURED_EVIDENCE_SCHEMA_VERSION,
    monitoringMatch: features.identity_known === true ? 'EXACT_MATCH'
      : meaningful(identity) ? 'PARTIAL_MATCH' : 'UNABLE_TO_VERIFY',
    monitoringState: lifecycleStatus === 'RECOVERED' ? 'RECOVERED'
      : lifecycleStatus === 'FLAPPING' ? 'FLAPPING'
        : lifecycleStatus === 'FIRING' || lifecycleStatus === 'ACKNOWLEDGED' ? 'ACTIVE' : 'UNKNOWN',
    technicalCondition: 'UNKNOWN',
    evidenceTypes: structuredEvidenceTypes,
    evidenceStrength: features.source_api_available === true ? 'CONFIRMED'
      : features.source_api_available === false ? 'UNABLE_TO_RETRIEVE' : 'PARTIAL',
    customerImpact: features.explicit_no_impact === true ? 'NO_IMPACT'
      : meaningful(features.customer_impact) ? 'POSSIBLE' : 'UNKNOWN',
    serviceImpact: features.explicit_no_impact === true ? 'NO_IMPACT'
      : meaningful(features.business_impact) ? 'POSSIBLE' : 'UNKNOWN',
    impactLevel: features.explicit_no_impact === true ? 'NONE'
      : ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].includes(String(features.business_impact || '').toUpperCase())
        ? String(features.business_impact).toUpperCase() : 'UNKNOWN',
    affectedScope: identity.application ? ['SINGLE_APPLICATION']
      : identity.service || identity.host || identity.node ? ['SINGLE_COMPONENT'] : ['UNKNOWN'],
    persistenceBand: structuredPersistence,
    noiseReasons: lifecycleStatus === 'FLAPPING' ? ['FLAPPING']
      : lifecycleStatus === 'RECOVERED' && features.explicit_no_impact === true
        ? ['AUTO_RESOLVED_WITHOUT_IMPACT'] : ['UNKNOWN'],
    actionability: features.investigation_present === true || features.remediation_present === true
      ? 'FOLLOW_UP_ACTION_REQUIRED'
      : lifecycleStatus === 'RECOVERED' && features.explicit_no_impact === true ? 'ALREADY_RESOLVED' : 'UNKNOWN',
    evidenceReviewed: null,
    sourceEvidenceVerified: features.source_api_available === true ? 'YES'
      : features.source_api_available === false ? 'NO' : 'PARTIALLY',
    decisionConfidence: null,
    exceptionNotes: null,
    impactedPlatforms: [source.includes('APPDYNAMICS') ? 'APPDYNAMICS'
      : source.includes('GRAFANA') ? 'GRAFANA'
        : source.includes('NAGIOS') ? 'NAGIOS'
          : source.includes('THOUSANDEYES') ? 'THOUSANDEYES' : 'OTHER'],
    evidenceCategory: 'SOURCE_MONITORING_EVIDENCE',
    whatIsHappening: alert.description || alert.title || null,
    lifecycleStatus,
    impactScale: features.explicit_no_impact === true ? 'NONE'
      : ['LOW', 'MEDIUM', 'HIGH'].includes(String(features.business_impact || '').toUpperCase())
        ? String(features.business_impact).toUpperCase() : 'UNKNOWN',
    customersExperiencing: features.customer_impact || normalized.customer_impact || null,
    whoImpacted: normalized.impacted_users || normalized.impact_scope || null,
    reproducibility: 'UNABLE_TO_VERIFY',
    actionTaken: features.investigation_present === true || features.remediation_present === true ? 'YES'
      : features.investigation_present === false && features.remediation_present === false ? 'NO' : null,
    actionsTaken: technical.actionsTaken || normalized.actions_taken || null,
    investigationPerformed: slack.investigation || technical.investigation || null,
    monitoringToolLinks: sourceUrl || null,
    operationsAlertLinks: operationsUrl || null,
    jiraLinks: jiraUrl || null,
    slackLinks: slackUrl || null,
    humanDecision: null,
    decisionJustification: null,
    additionalComments: null,
    firstObservedTime: technical.monitoringLifecycle?.firstObservedAt || alert.received_at || evaluation.feature_as_of || null,
    identityStatus: features.identity_known === true ? 'CONFIRMED'
      : meaningful(identity) ? 'PARTIALLY_CONFIRMED' : 'UNABLE_TO_CONFIRM',
    identityExplanation: features.identity_known === true ? null : 'Stored source identity is incomplete.',
    evidenceDescription: alert.description || alert.title || null,
    ...sourceSpecificDefaults(sourceSpecific),
  };
  const latestReport = previousReports[0] || null;
  const previousValues = previousSnapshot?.values || previousSnapshot?.evidenceSnapshot?.values || {};
  const reportValues = latestReport?.formResponses || {};
  const draft = draftValues || {};
  const allKeys = new Set([
    ...Object.keys(autoValues), ...Object.keys(previousValues), ...Object.keys(reportValues), ...Object.keys(draft),
  ]);
  const values = {};
  const fields = {};
  for (const key of allKeys) {
    const draftValue = firstInput(draft, key, key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`));
    const submittedValue = firstInput(reportValues, key, key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`));
    const automaticValue = autoValues[key];
    const retainedValue = previousValues[key];
    let value = draftValue ?? submittedValue ?? automaticValue;
    let sourceLabel = draftValue !== null && draftValue !== undefined ? 'Previously submitted'
      : submittedValue !== null && submittedValue !== undefined ? humanEvidenceSource(latestReport)
        : 'Automatically collected';
    let stale = false;
    if (!meaningful(value) && meaningful(retainedValue)) {
      value = retainedValue;
      sourceLabel = 'Automatically collected';
      stale = true;
    }
    values[key] = value ?? null;
    fields[key] = {
      value: value ?? null,
      source: sourceLabel,
      updatedAt: submittedValue !== null && submittedValue !== undefined
        ? latestReport?.submittedAt || refreshedAt : refreshedAt,
      stale,
    };
  }
  if (source && values.monitoringToolLinks && !sourceHttpUrl(source, values.monitoringToolLinks)) {
    if (isAtlassianUrl(firstHttpUrl(values.monitoringToolLinks))) {
      values.operationsAlertLinks ||= values.monitoringToolLinks;
      fields.operationsAlertLinks = {
        value: values.operationsAlertLinks,
        source: fields.monitoringToolLinks?.source || 'Previously submitted',
        updatedAt: fields.monitoringToolLinks?.updatedAt || refreshedAt,
        stale: fields.monitoringToolLinks?.stale || false,
      };
    }
    values.monitoringToolLinks = sourceUrl || null;
    fields.monitoringToolLinks = {
      value: sourceUrl || null,
      source: 'Automatically collected',
      updatedAt: technical.timestamp || refreshedAt,
      stale: false,
    };
  }
  const activeSource = monitoringSourceKey(source);
  const knownAvailability = context.sourceAvailability || {};
  const previousSourceStatus = previousSnapshot?.sourceStatus
    || previousSnapshot?.evidenceSnapshot?.sourceStatus || {};
  const slackStatus = meaningful(slack) || Boolean(slackUrl) || context.slackRuntimeAvailable === true
    ? { status: 'AVAILABLE', updatedAt: slack.updated_at || slack.timestamp || refreshedAt }
    : { status: 'UNABLE_TO_VERIFY', updatedAt: refreshedAt };
  const jiraError = String(alert.extracted_details?.jira_enrichment_error || '').toUpperCase();
  const jiraStatus = meaningful(jira) || Boolean(jiraUrl)
    ? { status: 'AVAILABLE', updatedAt: jira.updated_at || jira.resolved_at || refreshedAt }
    : jiraError.includes('NOT_CONFIGURED')
      ? { status: 'NOT_CONFIGURED', updatedAt: refreshedAt }
      : jiraError
        ? { status: 'UNAVAILABLE', updatedAt: refreshedAt }
        : { status: 'UNABLE_TO_VERIFY', updatedAt: refreshedAt };
  const sourceStatus = {
    DATABASE: { status: 'AVAILABLE', updatedAt: refreshedAt },
    SLACK: retainLastKnownStatus(slackStatus, previousSourceStatus.SLACK),
    JIRA: retainLastKnownStatus(jiraStatus, previousSourceStatus.JIRA),
    APPDYNAMICS: retainLastKnownStatus(
      monitoringAvailability('APPDYNAMICS', activeSource, technical, features, refreshedAt, knownAvailability),
      previousSourceStatus.APPDYNAMICS,
    ),
    GRAFANA: retainLastKnownStatus(
      monitoringAvailability('GRAFANA', activeSource, technical, features, refreshedAt, knownAvailability),
      previousSourceStatus.GRAFANA,
    ),
    NAGIOS: retainLastKnownStatus(
      monitoringAvailability('NAGIOS', activeSource, technical, features, refreshedAt, knownAvailability),
      previousSourceStatus.NAGIOS,
    ),
    THOUSANDEYES: retainLastKnownStatus(
      monitoringAvailability('THOUSANDEYES', activeSource, technical, features, refreshedAt, knownAvailability),
      previousSourceStatus.THOUSANDEYES,
    ),
  };
  return {
    evidenceStatus: evidencePresentationFor({ ...context, featureSnapshot: context.featureSnapshot }).overallStatus,
    fields,
    refreshedAt,
    sourceStatus,
    values,
  };
}

function evidenceModalTitle(alertNumber) {
  const number = compactValue(alertNumber, 40) || 'Unknown';
  const preferred = `Evidence – Alert #${number}`;
  return preferred.length <= 24 ? preferred : `Evidence – #${number}`.slice(0, 24);
}

function readOnlyEvidenceLine(label, field, { linkLabel = 'Open link' } = {}) {
  const value = Array.isArray(field?.value) ? field.value.join(', ') : field?.value;
  const source = field?.source || 'Automatically collected';
  const stale = field?.stale ? ' · stale last-known value retained' : '';
  const urls = allHttpUrls(value);
  const renderedValue = urls.length && String(value || '').trim() === urls.join(', ')
    ? urls.map((url, index) => `<${url}|${urls.length > 1 ? `${linkLabel} ${index + 1}` : linkLabel}>`).join(' · ')
    : blockText(value);
  return `*${label}*\n${renderedValue}\n_${source}${stale} · ${slackDate(field?.updatedAt)}_`;
}

function reviewFieldBlocks(review, definitions, options = {}) {
  const fields = definitions.map(([key, label, linkLabel]) => ({
    type: 'mrkdwn',
    text: readOnlyEvidenceLine(label, review.fields?.[key], { linkLabel }),
  }));
  const blocks = [];
  for (let index = 0; index < fields.length; index += 8) {
    blocks.push({ type: 'section', fields: fields.slice(index, index + 8) });
  }
  if (options.fullWidth) {
    return definitions.map(([key, label, linkLabel]) => ({
      type: 'section',
      text: { type: 'mrkdwn', text: readOnlyEvidenceLine(label, review.fields?.[key], { linkLabel }) },
    }));
  }
  return blocks;
}

function buildEvidenceReviewModal(context, actionContext = {}) {
  const alert = context.alert || {};
  const evaluation = context.evaluation || {};
  const features = context.featureSnapshot?.features || {};
  const review = context.evidenceReview || storedEvidenceSnapshot(context, context.previousReports || []);
  const alertNumber = alert.atlassian_ops_tiny_id || alert.id;
  const alertName = blockText(alert.title || alert.description, 'Untitled alert');
  const source = blockText(features.source || evaluation.source, 'Unknown');
  const responder = blockText(alert.responderTeam ?? alert.responder ?? alert.team, 'Unassigned');
  const sourceSpecific = sourceSpecificValues(source, {
    alert,
    evaluation,
    features,
    identity: evaluation.feature_snapshot?.identity || {},
    normalized: alert.extracted_details?.normalized_alert || {},
    technical: evaluation.technical_evidence || {},
  });
  const statusFields = Object.entries(review.sourceStatus || {}).map(([name, value]) => {
    const presentation = SOURCE_AVAILABILITY[value.status] || SOURCE_AVAILABILITY.UNABLE_TO_VERIFY;
    const retained = value.stale ? '\n_Source unavailable — last known evidence retained_' : '';
    return {
      type: 'mrkdwn',
      text: `${presentation.icon} *${name}*\n${presentation.label} · ${slackDate(value.updatedAt)}${retained}`,
    };
  });
  const metadata = {
    ...actionContext,
    alertId: alert.id,
    evaluationId: evaluation.evaluation_id || evaluation.evaluationId,
    refreshEventId: review.refreshEventId || null,
  };
  const actionValue = JSON.stringify(metadata);
  const evidenceSummaryBlocks = reviewFieldBlocks(review, [
    ['monitoringMatch', 'Monitoring match'],
    ['monitoringState', 'Monitoring state'],
    ['technicalCondition', 'Technical condition'],
    ['evidenceTypes', 'Evidence types'],
    ['evidenceStrength', 'Evidence strength'],
    ['customerImpact', 'Customer impact'],
    ['serviceImpact', 'Service impact'],
    ['impactLevel', 'Impact level'],
    ['affectedScope', 'Affected scope'],
    ['persistenceBand', 'Persistence'],
    ['noiseReasons', 'Noise pattern'],
    ['actionability', 'Actionability'],
    ['humanDecision', 'Human evidence outcome'],
  ]);
  const observationBlocks = reviewFieldBlocks(review, [
    ['evidenceReviewed', 'Evidence reviewed'],
    ['sourceEvidenceVerified', 'Source evidence verified'],
    ['decisionConfidence', 'Decision confidence'],
    ['exceptionNotes', 'Conflict or unavailable-evidence note'],
  ], { fullWidth: true });
  const evidenceLinkBlocks = reviewFieldBlocks(review, [
    ['monitoringToolLinks', `${source} evidence link`, `Open ${source}`],
    ['operationsAlertLinks', 'JSM Operations alert link', 'Open JSM Operations'],
    ['jiraLinks', 'Jira issue link', 'Open Jira'],
    ['slackLinks', 'Slack evidence link', 'Open Slack'],
  ]);
  const sourceEvidenceBlocks = sourceSpecific ? [
    modalSection(sourceSpecific.label),
    ...reviewFieldBlocks(review, sourceSpecific.fields.map((item) => [
      item.blockId.replace(/_([a-z])/g, (_match, letter) => letter.toUpperCase()),
      item.label,
      item.label.includes('link') || item.label.includes('URL') ? `Open ${source}` : undefined,
    ])),
  ] : [];
  const evidenceStatus = EVIDENCE_STATUS_PRESENTATION[review.evidenceStatus]
    || EVIDENCE_STATUS_PRESENTATION.PARTIAL;
  return {
    type: 'modal', callback_id: 'evidence_review_modal',
    private_metadata: JSON.stringify(metadata),
    title: { type: 'plain_text', text: evidenceModalTitle(alertNumber) },
    close: { type: 'plain_text', text: 'Close' },
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: `Evidence Collection – Alert #${blockText(alertNumber)}`.slice(0, 150), emoji: true } },
      { type: 'section', text: { type: 'mrkdwn', text: `*${alertName}*` } },
      { type: 'section', fields: [
        { type: 'mrkdwn', text: `*Source*\n${source}` },
        { type: 'mrkdwn', text: `*Priority*\n${blockText(features.priority_class || alert.raw_payload?.priority?.name)}` },
        { type: 'mrkdwn', text: `*Responder*\n${responder}` },
        { type: 'mrkdwn', text: `*Alert timestamp*\n${slackDate(alert.received_at || evaluation.feature_as_of)}` },
        { type: 'mrkdwn', text: `*Evidence status*\n${evidenceStatus.icon} ${evidenceStatus.label}` },
      ] },
      { type: 'context', elements: [{ type: 'mrkdwn', text: `🔒 Read-only evidence view · Last refreshed ${slackDate(review.refreshedAt)}` }] },
      { type: 'actions', block_id: 'evidence_review_actions', elements: [
        { type: 'button', action_id: 'evidence_refresh', text: { type: 'plain_text', text: 'Refresh Evidence' }, value: actionValue },
        { type: 'button', action_id: 'evidence_edit', text: { type: 'plain_text', text: 'Edit Evidence' }, value: actionValue },
      ] },
      { type: 'divider' },
      modalSection('Source Availability'),
      ...(statusFields.length ? [{ type: 'section', fields: statusFields.slice(0, 10) }] : [{
        type: 'section', text: { type: 'mrkdwn', text: '🟡 Unable to verify source availability.' },
      }]),
      modalSection('Evidence Summary'),
      ...evidenceSummaryBlocks,
      modalSection('Reviewer Confirmation'),
      ...observationBlocks,
      modalSection('Evidence Links'),
      ...evidenceLinkBlocks,
      ...sourceEvidenceBlocks,
      { type: 'context', elements: [{ type: 'mrkdwn', text: 'Unavailable evidence is never treated as Noise. Refreshes and updates are append-only.' }] },
    ],
  };
}

function buildEvidenceLoadingModal(actionContext = {}) {
  return {
    type: 'modal',
    callback_id: 'evidence_loading_modal',
    private_metadata: JSON.stringify(actionContext),
    title: { type: 'plain_text', text: 'Evidence Collection' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: '*Loading existing evidence…*\nCollecting the latest stored Database, Slack, Jira, and monitoring-source evidence.' } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: 'This is read-only. No alert, Jira issue, or monitoring state will be changed.' }] },
    ],
  };
}

function buildEvidenceUnavailableModal(actionContext = {}, safeMessage = null) {
  const actionValue = JSON.stringify(actionContext);
  return {
    type: 'modal',
    callback_id: 'evidence_review_modal',
    private_metadata: actionValue,
    title: { type: 'plain_text', text: 'Evidence Collection' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: '*Evidence status: Partial*\nExisting stored evidence remains preserved. Evidence that could not be loaded is shown as Not available.' } },
      { type: 'section', text: { type: 'mrkdwn', text: '*Source status*\n⚪ Unavailable' } },
      { type: 'section', text: { type: 'mrkdwn', text: `*Current source evidence*\nNot available${safeMessage ? `\n_${blockText(safeMessage, 'Evidence refresh is temporarily unavailable.')}_` : ''}` } },
      { type: 'actions', block_id: 'evidence_review_actions', elements: [
        { type: 'button', action_id: 'evidence_refresh', text: { type: 'plain_text', text: 'Refresh Evidence' }, value: actionValue },
        { type: 'button', action_id: 'evidence_edit', text: { type: 'plain_text', text: 'Edit Evidence' }, value: actionValue },
      ] },
      { type: 'context', elements: [{ type: 'mrkdwn', text: 'Unavailable evidence is never treated as Noise.' }] },
    ],
  };
}

function withoutSlackFileInput(view = {}) {
  const blocks = Array.isArray(view.blocks) ? view.blocks : [];
  let removed = false;
  const safeBlocks = blocks.flatMap((block) => {
    if (block?.type !== 'input' || block.element?.type !== 'file_input') return [block];
    removed = true;
    return [{
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '*Supporting file upload*\nNot available for the current Slack app permissions. Evidence links and comments can still be submitted.',
      },
    }];
  });
  return removed ? { ...view, blocks: safeBlocks } : view;
}

function buildEvidenceHistoryModal(context, actionContext = {}, { backfillReview = false } = {}) {
  const alert = context.alert || {};
  const evaluation = context.evaluation || {};
  const normalized = alert.extracted_details?.normalized_alert || {};
  const jira = alert.extracted_details?.jira || {};
  const sourceUrl = firstHttpUrl(
    evaluation.technical_evidence?.coverage?.sourceResolution?.deepLink,
    evaluation.technical_evidence?.deepLink,
    normalized.monitoring_event_url,
    normalized.deep_event_link,
    alert.raw_payload?.sourceUrl,
    alert.source_url,
  );
  const jiraUrl = firstHttpUrl(normalized.jira_url, jira.issue_url, jira.jira_url, alert.raw_payload?.jiraUrl);
  const alertNumber = alert.atlassian_ops_tiny_id || alert.id;
  const alertName = blockText(alert.title || alert.description, 'Untitled alert');
  const responder = blockText(alert.responderTeam ?? alert.responder ?? alert.team, 'Unassigned');
  const reports = Array.isArray(context.previousReports) ? context.previousReports.slice(0, 5) : [];
  const reportBlocks = reports.flatMap((report, index) => {
    const responses = report.formResponses || {};
    const summary = compactValue(
      responses.evidenceDescription || responses.whatIsHappening || responses.decisionJustification,
      600,
    ) || 'No narrative evidence was recorded.';
    return [
      { type: 'section', text: { type: 'mrkdwn', text: `*Submission ${index + 1}* · ${evidenceOutcomeLabel(report.outcomeStatus || report.humanDecision)}\n*Reviewer:* ${blockText(report.reviewer?.name, 'Unknown')}\n*Submitted:* ${slackDate(report.submittedAt)}\n*Evidence:* ${blockText(report.evidenceCompleteness, 'MISSING')}${report.pendingEvidenceReason ? `\n*Pending reason:* ${blockText(report.pendingEvidenceReason)}` : ''}\n${blockText(summary)}` } },
      ...(index < reports.length - 1 ? [{ type: 'divider' }] : []),
    ];
  });
  const links = [];
  if (jiraUrl) links.push({ type: 'button', action_id: 'view_jira', text: { type: 'plain_text', text: 'View Jira' }, url: jiraUrl });
  return {
    type: 'modal',
    callback_id: 'evidence_history_modal',
    private_metadata: JSON.stringify({ alertId: actionContext.alertId, menuAction: actionContext.menuAction }),
    title: { type: 'plain_text', text: backfillReview ? 'Backfill Review' : 'Submitted Evidence' },
    close: { type: 'plain_text', text: 'Close' },
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: `*${alertName}* (#${blockText(alertNumber)})\n*Responder:* ${responder}\n*Canonical alert ID:* ${blockText(alert.id)}` } },
      ...(sourceUrl ? [{
        type: 'section', text: { type: 'mrkdwn', text: `*Monitoring source:* <${sourceUrl}|View source alert>` },
      }] : []),
      ...(links.length ? [{ type: 'actions', elements: links }] : []),
      { type: 'divider' },
      ...(backfillReview ? [{
        type: 'section', text: { type: 'mrkdwn', text: '*Historical evidence review*\nThis alert can be reviewed through the append-only BACKFILL workflow.' },
      }, { type: 'divider' }] : []),
      ...(reportBlocks.length ? reportBlocks : [{
        type: 'section', text: { type: 'mrkdwn', text: '*No submitted evidence*\nNo append-only evidence submission is currently stored for this alert.' },
      }]),
      { type: 'context', elements: [{ type: 'mrkdwn', text: 'Existing records are append-only. No Jira, Slack alert-state, or monitoring-system mutation is performed.' }] },
    ],
  };
}

function slackInputValue(values, blockId) {
  const state = values?.[blockId]?.value || {};
  if (state.type === 'static_select') return state.selected_option?.value || null;
  if (state.type === 'multi_static_select') return (state.selected_options || []).map((item) => item.value);
  if (state.type === 'datepicker') return state.selected_date || null;
  if (state.type === 'timepicker') return state.selected_time || null;
  return state.value ?? null;
}

function slackFileReferences(values) {
  const state = values?.file_attachments?.value || {};
  const files = state.files || state.selected_files || [];
  return (Array.isArray(files) ? files : []).slice(0, 10).map((file) => ({
    source: 'SLACK_FILE',
    externalFileId: compactValue(file.id, 255),
    name: compactValue(file.name || file.title, 255) || 'Slack attachment',
    mimeType: compactValue(file.mimetype || file.filetype, 255),
    size: Number.isFinite(Number(file.size)) ? Number(file.size) : null,
    url: firstHttpUrl(file.permalink, file.url_private_download, file.url_private),
  }));
}

function slackEvidenceValues(values) {
  const fieldIds = [
    'monitoring_match', 'monitoring_state', 'technical_condition', 'evidence_types',
    'evidence_strength', 'customer_impact', 'service_impact', 'impact_level',
    'affected_scope', 'persistence_band', 'noise_reasons', 'actionability',
    'duplicate_match', 'flapping_count', 'flapping_window', 'recovery_confirmed',
    'no_impact_confirmed', 'correlation_reference', 'maintenance_reference',
    'stale_last_observed_date', 'stale_last_observed_time', 'no_active_impact_confirmed',
    'expected_event_category',
    'evidence_reviewed', 'source_evidence_verified', 'decision_confidence', 'exception_notes',
    'impacted_platforms', 'observed_date', 'observed_time', 'action_taken', 'edit_reason',
    'exact_application', 'service', 'host_node', 'alert_rule', 'metric', 'business_transaction',
    'identity_status', 'identity_explanation', 'lifecycle_status', 'first_observed_time',
    'acknowledged_time', 'recovery_time', 'duration', 'occurrence_count', 'continuously_active',
    'automatically_resolved', 'what_is_happening', 'customers_experiencing',
    'affected_platform_service', 'who_impacted', 'impact_scale', 'impact_ongoing', 'workaround',
    'business_operational_impact', 'related_alerts', 'related_jira_incidents', 'related_deployments',
    'related_changes_releases', 'affected_dependencies', 'source_diagnostic_indicators',
    'suspected_root_cause', 'root_cause_confidence', 'actions_taken', 'investigation_performed',
    'teams_contacted', 'escalations_made', 'remediation_performed', 'restart_rollback_workaround',
    'action_performed_by', 'service_restored_by', 'recovery_confirmation', 'evidence_description',
    'evidence_category', 'monitoring_tool_links', 'jira_links', 'slack_links', 'additional_comments',
    'human_decision', 'decision_justification',
    'reproducibility', 'source_application', 'source_tier', 'source_node',
    'source_business_transaction', 'source_health_rule', 'source_event_id', 'source_violation_status',
    'source_dashboard_url', 'source_rule_uid', 'source_panel', 'source_alert_state',
    'source_metric', 'source_grafana_link', 'source_grafana_evidence_timestamp',
    'source_host', 'source_service', 'source_plugin_output',
    'source_state', 'source_acknowledgement_status', 'source_test', 'source_rule',
    'source_agent_location',
  ];
  const result = Object.fromEntries(fieldIds.map((field) => [field, slackInputValue(values, field)]));
  if (result.observed_date && result.observed_time) {
    result.first_observed_time = `${result.observed_date}T${result.observed_time}:00+05:30`;
  }
  result.identity_status ||= result.monitoring_match === 'EXACT_MATCH' ? 'CONFIRMED' : null;
  result.evidence_description ||= Array.isArray(result.evidence_types) ? result.evidence_types.join(', ') : null;
  return result;
}

function mapFeedback(row) {
  if (!row) return null;
  return {
    feedbackId: row.feedback_id,
    alertId: row.alert_id,
    evaluationId: row.evaluation_id,
    decisionRevision: row.decision_revision,
    evidenceRevision: row.evidence_revision,
    deterministicDecision: row.deterministic_decision,
    deterministicSubtype: row.deterministic_subtype,
    source: row.source,
    priority: row.priority,
    modelPrediction: row.model_prediction,
    modelVersion: row.model_version,
    modelScore: row.model_score === null ? null : Number(row.model_score),
    modelScores: row.model_scores || {},
    humanDecision: row.human_decision,
    humanSubtype: row.human_subtype,
    outcome: operationalOutcome(row.human_decision),
    reasonCode: row.reason_code,
    humanEvidenceText: row.human_evidence_text,
    comment: row.comment,
    notes: row.comment,
    responderId: row.responder_id,
    responderDisplayName: row.responder_display_name,
    recordedBy: row.responder_display_name,
    recordedById: row.responder_id,
    channel: row.channel,
    slackChannelId: row.slack_channel_id,
    slackMessageTs: row.slack_message_ts,
    featureSnapshotId: row.feature_snapshot_id,
    predictionId: row.prediction_id,
    status: row.status,
    validationCode: row.validation_code,
    trainingEligible: Boolean(row.training_eligible),
    trainingExclusionReason: row.training_exclusion_reason || null,
    requestedEvidence: normalizeEvidenceKeys(row.metadata?.requestedEvidence),
    isTest: Boolean(row.is_test),
    createdAt: toIso(row.created_at),
    recordedAt: toIso(row.created_at),
  };
}

function mapTestFeedback(row) {
  if (!row) return null;
  return {
    feedbackId: row.feedback_id,
    testRunId: row.test_run_id,
    alertId: row.alert_id,
    source: row.source,
    priority: row.priority,
    deterministicDecision: row.system_decision,
    deterministicSubtype: row.system_subtype,
    modelPrediction: row.model_prediction,
    modelVersion: row.model_version,
    modelScores: row.model_scores || {},
    humanDecision: row.human_decision,
    humanSubtype: row.human_subtype,
    reasonCode: row.reason_code,
    humanEvidenceText: row.human_evidence_text,
    comment: row.human_comment,
    responderId: row.responder_slack_user_id,
    responderDisplayName: row.responder_display_name,
    channel: 'SLACK',
    slackChannelId: row.channel_id,
    slackMessageTs: row.message_ts,
    decisionRevision: row.decision_revision,
    evidenceRevision: row.evidence_revision,
    featureSnapshotId: row.feature_snapshot_id,
    status: row.status,
    validationCode: row.validation_code,
    trainingEligible: false,
    trainingExclusionReason: row.training_exclusion_reason,
    requestedEvidence: normalizeEvidenceKeys(row.metadata?.requestedEvidence),
    isTest: true,
    createdAt: toIso(row.created_at),
  };
}

function firstHttpUrl(...values) {
  const queue = [...values];
  while (queue.length) {
    const value = queue.shift();
    if (Array.isArray(value)) {
      queue.push(...value);
    } else if (value && typeof value === 'object') {
      queue.push(...Object.values(value));
    } else if (typeof value === 'string') {
      const match = value.match(/https?:\/\/[^\s<>"')\]]+/i);
      if (match) return match[0].replace(/[.,;:]$/, '');
    }
  }
  return null;
}

function allHttpUrls(...values) {
  const queue = [...values];
  const urls = [];
  while (queue.length) {
    const value = queue.shift();
    if (Array.isArray(value)) {
      queue.push(...value);
    } else if (value && typeof value === 'object') {
      queue.push(...Object.values(value));
    } else if (typeof value === 'string') {
      for (const match of value.matchAll(/https?:\/\/[^\s<>"')\]]+/gi)) {
        urls.push(match[0].replace(/[.,;:]$/, ''));
      }
    }
  }
  return [...new Set(urls)];
}

function sourceUrlMatches(source, value) {
  if (!value) return false;
  let host;
  try {
    host = new URL(value).hostname.toLowerCase();
  } catch {
    return false;
  }
  const normalized = String(source || '').toUpperCase();
  if (normalized.includes('GRAFANA')) return host.includes('grafana');
  if (normalized.includes('APPDYNAMICS')) return host.includes('appdynamics');
  if (normalized.includes('THOUSANDEYES')) return host.includes('thousandeyes');
  if (normalized.includes('NAGIOS')) {
    return !host.includes('atlassian.net') && !host.includes('slack.com') && !host.includes('grafana');
  }
  return !host.includes('atlassian.net') && !host.includes('slack.com');
}

function sourceHttpUrl(source, ...values) {
  return allHttpUrls(...values).find((value) => sourceUrlMatches(source, value)) || null;
}

function isAtlassianUrl(value) {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host.includes('atlassian.net') || host.includes('jira');
  } catch {
    return false;
  }
}

function normalizedLinks(value, maximum = 20) {
  const items = Array.isArray(value) ? value : String(value || '').split(/[\n,]/);
  return [...new Set(items.map((item) => clean(item, 1000)).filter((item) => {
    if (!item) return false;
    try {
      const parsed = new URL(item);
      return ['http:', 'https:'].includes(parsed.protocol);
    } catch {
      return false;
    }
  }))].slice(0, maximum);
}

function mapIncidentReport(row) {
  if (!row) return null;
  const outcomeStatus = canonicalEvidenceOutcome(row.evidence_outcome_status || row.human_decision)
    || 'PENDING_EVIDENCE';
  return {
    reportId: row.report_id,
    alertId: row.alert_id,
    alertNumber: row.alert_number,
    alertName: row.alert_name,
    reviewer: {
      id: row.reviewer_id,
      name: row.reviewer_name,
      email: row.reviewer_email || null,
    },
    formResponses: row.form_responses || {},
    attachments: row.attachment_references || row.attachment_links || [],
    attachmentLinks: row.attachment_links || [],
    responderTeam: row.responder_team || 'Unassigned',
    submissionChannel: row.submission_channel || 'WEB',
    origin: row.origin || 'LIVE',
    updateOfReportId: row.update_of_report_id || null,
    evidenceCompleteness: row.evidence_completeness || completenessForResponses(row.form_responses || {}),
    humanDecision: outcomeStatus,
    outcomeStatus,
    outcomeLabel: evidenceOutcomeLabel(outcomeStatus),
    pendingEvidenceReason: row.pending_evidence_reason || null,
    pendingEvidenceDetails: row.pending_evidence_details || {},
    formSchemaVersion: row.evidence_form_schema_version || null,
    validationStatus: row.validation_status,
    feedbackId: row.feedback_id || null,
    submittedAt: toIso(row.submitted_at),
  };
}

function reportValue(input, key, maximum = 4000, required = false) {
  const value = clean(input?.[key], maximum);
  if (required && !value) {
    throw verificationError(`${key} is required.`, 'INCIDENT_REPORT_FIELD_REQUIRED', 400, { field: key });
  }
  return value;
}

function firstInput(input, ...keys) {
  for (const key of keys) {
    if (input?.[key] !== undefined && input?.[key] !== null && input?.[key] !== '') return input[key];
  }
  return null;
}

function normalizeWebAttachments(value) {
  if (!Array.isArray(value)) return [];
  if (value.length > MAX_WEB_ATTACHMENT_COUNT) {
    throw verificationError(`A maximum of ${MAX_WEB_ATTACHMENT_COUNT} files may be attached.`, 'TOO_MANY_EVIDENCE_ATTACHMENTS');
  }
  let total = 0;
  return value.map((file) => {
    const name = clean(file?.name, 255);
    const mimeType = clean(file?.mimeType || file?.type, 255) || 'application/octet-stream';
    const encoded = clean(file?.dataBase64, 9 * 1024 * 1024);
    if (!name || !encoded || !/^[A-Za-z0-9+/=\r\n]+$/.test(encoded)) {
      throw verificationError('Each browser attachment must include a valid file name and encoded content.', 'INVALID_EVIDENCE_ATTACHMENT');
    }
    const content = Buffer.from(encoded, 'base64');
    total += content.length;
    if (content.length === 0 || total > MAX_WEB_ATTACHMENT_BYTES) {
      throw verificationError('Browser attachments may contain at most 6 MB in total.', 'EVIDENCE_ATTACHMENTS_TOO_LARGE');
    }
    return {
      source: 'WEB_UPLOAD', name, mimeType, size: content.length, content,
      sha256: crypto.createHash('sha256').update(content).digest('hex'),
    };
  });
}

function normalizeSlackAttachments(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 10).map((file) => ({
    source: 'SLACK_FILE',
    externalFileId: clean(file?.externalFileId || file?.id, 255),
    name: clean(file?.name, 255) || 'Slack attachment',
    mimeType: clean(file?.mimeType, 255),
    size: Number.isFinite(Number(file?.size)) ? Number(file.size) : null,
    url: firstHttpUrl(file?.url),
    content: null,
    sha256: null,
  }));
}

function normalizeEvidenceSubmission(input = {}) {
  const read = (keys, maximum = 4000) => clean(firstInput(input, ...(Array.isArray(keys) ? keys : [keys])), maximum);
  const list = (keys) => [...new Set((Array.isArray(firstInput(input, ...(Array.isArray(keys) ? keys : [keys])))
    ? firstInput(input, ...(Array.isArray(keys) ? keys : [keys]))
    : [firstInput(input, ...(Array.isArray(keys) ? keys : [keys]))])
    .map((value) => clean(value, 100)?.toUpperCase()).filter(Boolean))];
  const enumValue = (key, aliases, fallback = null) => {
    const value = (read(aliases, 100) || fallback)?.toUpperCase() || null;
    return schemaValues(key).has(value) ? value : null;
  };
  const legacyIdentity = read(['identityStatus', 'identity_status'], 80)?.toUpperCase();
  const legacyLifecycle = read(['lifecycleStatus', 'alertLifecycleStatus', 'lifecycle_status'], 80)?.toUpperCase();
  const legacyCategory = read(['evidenceCategory', 'evidence_category'], 100)?.toUpperCase();
  const requestedOutcome = canonicalEvidenceOutcome(firstInput(
    input, 'humanDecision', 'finalHumanDecision', 'human_decision', 'outcomeStatus',
  ));
  const noiseReasons = list(['noiseReasons', 'noise_reasons']);
  const legacyNoiseReason = {
    DUPLICATE_ALERT: 'EXACT_DUPLICATE', FLAPPING_ALERT: 'FLAPPING', AUTO_RESOLUTION: 'AUTO_RESOLVED_WITHOUT_IMPACT',
  }[legacyCategory];
  if (!noiseReasons.length && legacyNoiseReason) noiseReasons.push(legacyNoiseReason);
  const evidenceTypes = list(['evidenceTypes', 'evidence_types']);
  const legacyEvidenceType = {
    DUPLICATE_ALERT: 'DUPLICATE_MATCH', FLAPPING_ALERT: 'REPEATED_FIRING',
    AUTO_RESOLUTION: 'RECOVERY_EVENT', SOURCE_MONITORING_EVIDENCE: 'ALERT_RULE_RESULT',
    RECOVERY_EVIDENCE: 'RECOVERY_EVENT', CORRELATION: 'PARENT_INCIDENT_CORRELATION',
  }[legacyCategory];
  if (!evidenceTypes.length && legacyEvidenceType) evidenceTypes.push(legacyEvidenceType);
  const affectedScope = list(['affectedScope', 'affected_scope']);
  if (!affectedScope.length && read(['affectedPlatformService', 'affected_platform_service'])) affectedScope.push('SINGLE_COMPONENT');
  const monitoringMatch = enumValue('monitoringMatch', ['monitoringMatch', 'monitoring_match'],
    legacyIdentity === 'CONFIRMED' ? 'EXACT_MATCH'
      : legacyIdentity === 'PARTIALLY_CONFIRMED' ? 'PARTIAL_MATCH'
        : legacyIdentity === 'UNABLE_TO_CONFIRM' ? 'UNABLE_TO_VERIFY' : null);
  const monitoringState = enumValue('monitoringState', ['monitoringState', 'monitoring_state'], {
    FIRING: 'ACTIVE', ACKNOWLEDGED: 'ACTIVE', RECOVERED: 'RECOVERED', AUTO_RESOLVED: 'RECOVERED',
    CLOSED: 'RECOVERED', FLAPPING: 'FLAPPING', UNKNOWN: 'UNKNOWN',
  }[legacyLifecycle]);
  const customerImpact = enumValue('impact', ['customerImpact', 'customer_impact'],
    read(['customersExperiencing', 'customers_experiencing']) ? 'POSSIBLE' : null);
  const serviceImpact = enumValue('impact', ['serviceImpact', 'service_impact'],
    read(['businessOperationalImpact', 'businessImpact', 'business_operational_impact']) ? 'POSSIBLE' : null);
  const legacyImpact = read(['impactScale', 'impact_scale'], 100)?.toUpperCase();
  const impactLevel = enumValue('impactLevel', ['impactLevel', 'impact_level'], {
    NONE: 'NONE', LIMITED: 'LOW', MULTIPLE_CUSTOMERS: 'MEDIUM', WIDESPREAD: 'HIGH', UNKNOWN: 'UNKNOWN',
  }[legacyImpact]);
  const duration = read('duration', 200);
  const durationValue = String(duration || '').match(/\d+(?:\.\d+)?/)?.[0];
  const durationSeconds = durationValue ? Number(durationValue) * (/hour|\bh\b/i.test(duration) ? 3600 : /min|\bm\b/i.test(duration) ? 60 : 1) : null;
  const persistenceBand = enumValue('persistence', ['persistenceBand', 'persistence_band'],
    durationSeconds === null ? null : durationSeconds < 300 ? 'LT_5_MINUTES'
      : durationSeconds < 900 ? 'MINUTES_5_TO_15' : durationSeconds < 3600 ? 'MINUTES_15_TO_60'
        : durationSeconds > 432000 ? 'GT_5_DAYS' : 'GT_1_HOUR');
  const evidenceStrength = enumValue('evidenceStrength', ['evidenceStrength', 'evidence_strength'],
    legacyCategory && legacyIdentity === 'CONFIRMED' ? 'CONFIRMED' : null);
  const responses = {
    schemaVersion: STRUCTURED_EVIDENCE_SCHEMA_VERSION,
    monitoringMatch,
    monitoringState,
    technicalCondition: enumValue('technicalCondition', ['technicalCondition', 'technical_condition']),
    evidenceTypes: evidenceTypes.filter((value) => schemaValues('evidenceTypes').has(value)),
    evidenceStrength,
    customerImpact,
    serviceImpact,
    impactLevel,
    affectedScope: affectedScope.filter((value) => schemaValues('affectedScope').has(value)),
    persistenceBand,
    noiseReasons: noiseReasons.filter((value) => schemaValues('noiseReasons').has(value)),
    duplicateMatch: enumValue('duplicateMatch', ['duplicateMatch', 'duplicate_match']),
    flappingCount: enumValue('flappingCount', ['flappingCount', 'flapping_count']),
    flappingWindow: enumValue('persistence', ['flappingWindow', 'flapping_window']),
    recoveryConfirmed: enumValue('verification', ['recoveryConfirmed', 'recovery_confirmed']),
    noImpactConfirmed: enumValue('verification', ['noImpactConfirmed', 'no_impact_confirmed']),
    correlationReference: enumValue('referenceType', ['correlationReference', 'correlation_reference']),
    maintenanceReference: enumValue('referenceType', ['maintenanceReference', 'maintenance_reference']),
    staleLastObservedDate: read(['staleLastObservedDate', 'stale_last_observed_date'], 30),
    staleLastObservedTime: read(['staleLastObservedTime', 'stale_last_observed_time'], 30),
    noActiveImpactConfirmed: enumValue('verification', ['noActiveImpactConfirmed', 'no_active_impact_confirmed']),
    expectedEventCategory: enumValue('expectedEventCategory', ['expectedEventCategory', 'expected_event_category']),
    actionability: enumValue('actionability', 'actionability'),
    notificationRoleAssessment: enumValue(
      'notificationRoleAssessment',
      ['notificationRoleAssessment', 'notification_role_assessment'],
    ),
    resolutionAssessment: enumValue(
      'resolutionAssessment',
      ['resolutionAssessment', 'resolution_assessment'],
    ),
    evidenceReviewed: enumValue('yesNo', ['evidenceReviewed', 'evidence_reviewed'], requestedOutcome ? 'YES' : null),
    sourceEvidenceVerified: enumValue('sourceVerification', ['sourceEvidenceVerified', 'source_evidence_verified'],
      monitoringMatch === 'EXACT_MATCH' ? 'YES' : monitoringMatch ? 'PARTIALLY' : null),
    decisionConfidence: enumValue('confidence', ['decisionConfidence', 'decision_confidence'], requestedOutcome ? 'MEDIUM' : null),
    requestedOutcome,
    humanDecision: requestedOutcome,
    exceptionNotes: read(['exceptionNotes', 'exception_notes', 'additionalComments', 'additional_comments']),
    editReason: read(['editReason', 'edit_reason']),
    monitoringToolLinks: normalizedLinks(firstInput(input, 'monitoringToolLinks', 'monitoring_tool_links')),
    jiraLinks: normalizedLinks(firstInput(input, 'jiraLinks', 'jira_links')),
    slackLinks: normalizedLinks(firstInput(input, 'slackLinks', 'slack_links')),
    sourceSpecific: {
      application: read(['sourceApplication', 'source_application', 'exactApplication', 'exact_application']),
      tier: read(['sourceTier', 'source_tier']), node: read(['sourceNode', 'source_node', 'hostNode', 'host_node']),
      service: read(['sourceService', 'source_service', 'service']),
      businessTransaction: read(['sourceBusinessTransaction', 'source_business_transaction', 'businessTransaction', 'business_transaction']),
      healthRule: read(['sourceHealthRule', 'source_health_rule', 'alertRule', 'alert_rule']),
      eventId: read(['sourceEventId', 'source_event_id']), violationStatus: read(['sourceViolationStatus', 'source_violation_status']),
      dashboardUrl: firstHttpUrl(firstInput(input, 'sourceDashboardUrl', 'source_dashboard_url')),
      ruleUid: read(['sourceRuleUid', 'source_rule_uid']), panel: read(['sourcePanel', 'source_panel']),
      alertState: read(['sourceAlertState', 'source_alert_state']), metric: read(['sourceMetric', 'source_metric', 'metric']),
      grafanaLink: firstHttpUrl(firstInput(input, 'sourceGrafanaLink', 'source_grafana_link')),
      grafanaEvidenceTimestamp: read(['sourceGrafanaEvidenceTimestamp', 'source_grafana_evidence_timestamp'], 100),
      host: read(['sourceHost', 'source_host', 'hostNode', 'host_node']),
      pluginOutput: read(['sourcePluginOutput', 'source_plugin_output']), state: read(['sourceState', 'source_state']),
      acknowledgementStatus: read(['sourceAcknowledgementStatus', 'source_acknowledgement_status']),
      rule: read(['sourceRule', 'source_rule', 'alertRule', 'alert_rule']),
    },
    // Legacy fields are retained in the append-only response JSON for historical
    // compatibility, but current clients render only the structured codes above.
    identityStatus: monitoringMatch === 'EXACT_MATCH' ? 'CONFIRMED'
      : monitoringMatch === 'PARTIAL_MATCH' ? 'PARTIALLY_CONFIRMED' : monitoringMatch ? 'UNABLE_TO_CONFIRM' : null,
    lifecycleStatus: monitoringState === 'ACTIVE' ? 'FIRING'
      : monitoringState === 'RECOVERED' ? 'RECOVERED' : monitoringState === 'FLAPPING' ? 'FLAPPING' : 'UNKNOWN',
    evidenceCategory: legacyCategory || (noiseReasons.includes('EXACT_DUPLICATE') ? 'DUPLICATE_ALERT'
      : noiseReasons.includes('FLAPPING') ? 'FLAPPING_ALERT'
        : noiseReasons.includes('AUTO_RESOLVED_WITHOUT_IMPACT') ? 'AUTO_RESOLUTION' : 'OTHER'),
    duration,
    occurrenceCount: read(['occurrenceCount', 'occurrence_count'], 100),
    automaticallyResolved: monitoringState === 'RECOVERED' && noiseReasons.includes('AUTO_RESOLVED_WITHOUT_IMPACT') ? 'YES' : null,
    evidenceDescription: read(['evidenceDescription', 'detailedEvidenceDescription', 'evidence_description'])
      || evidenceTypes.join(', ') || null,
    decisionJustification: read(['decisionJustification', 'decision_justification'])
      || requestedOutcome || 'Evidence is incomplete, conflicting, or ambiguous.',
  };

  const required = {
    monitoringMatch: responses.monitoringMatch,
    monitoringState: responses.monitoringState,
    technicalCondition: responses.technicalCondition,
    evidenceTypes: responses.evidenceTypes.length,
    evidenceStrength: responses.evidenceStrength,
    customerImpact: responses.customerImpact,
    serviceImpact: responses.serviceImpact,
    impactLevel: responses.impactLevel,
    affectedScope: responses.affectedScope.length,
    persistenceBand: responses.persistenceBand,
    noiseReasons: responses.noiseReasons.length,
    actionability: responses.actionability,
    evidenceReviewed: responses.evidenceReviewed,
    sourceEvidenceVerified: responses.sourceEvidenceVerified,
    decisionConfidence: responses.decisionConfidence,
    finalDecision: requestedOutcome && requestedOutcome !== 'PENDING_EVIDENCE',
  };
  const missingEvidence = Object.entries(required).filter(([, value]) => !value).map(([key]) => key);
  const conflictingEvidence = [];
  if (['PARTIAL_MATCH', 'NO_MATCH', 'UNABLE_TO_VERIFY'].includes(responses.monitoringMatch)) conflictingEvidence.push('monitoringMatch');
  if (['NO_DATA', 'CONFLICTING', 'UNKNOWN'].includes(responses.monitoringState)) conflictingEvidence.push('monitoringState');
  if (['PARTIAL', 'NOT_OBSERVED', 'UNABLE_TO_RETRIEVE', 'CONFLICTING'].includes(responses.evidenceStrength)) conflictingEvidence.push('evidenceStrength');
  if (responses.evidenceTypes.includes('NO_SUPPORTING_EVIDENCE') || responses.evidenceTypes.includes('CONFLICTING_EVIDENCE')) conflictingEvidence.push('evidenceTypes');
  if (responses.sourceEvidenceVerified !== 'YES') conflictingEvidence.push('sourceEvidenceVerified');
  if (responses.evidenceReviewed !== 'YES') conflictingEvidence.push('evidenceReviewed');
  if (responses.customerImpact === 'UNKNOWN' || responses.serviceImpact === 'UNKNOWN' || responses.impactLevel === 'UNKNOWN') conflictingEvidence.push('impact');

  const positiveEvidence = responses.evidenceTypes.some((value) => !['NO_SUPPORTING_EVIDENCE', 'CONFLICTING_EVIDENCE'].includes(value));
  const impactEvidence = ['CONFIRMED', 'POSSIBLE'].includes(responses.customerImpact)
    || ['CONFIRMED', 'POSSIBLE'].includes(responses.serviceImpact);
  const positiveNoiseReasons = responses.noiseReasons.filter((value) => !['NO_NOISE_PATTERN', 'UNKNOWN'].includes(value));
  const noiseSupport = positiveNoiseReasons.every((reason) => ({
    EXACT_DUPLICATE: responses.evidenceTypes.includes('DUPLICATE_MATCH')
      && responses.duplicateMatch && responses.duplicateMatch !== 'UNABLE_TO_VERIFY',
    FLAPPING: responses.evidenceTypes.includes('REPEATED_FIRING')
      && responses.flappingCount && responses.flappingCount !== 'UNABLE_TO_VERIFY'
      && responses.flappingWindow && responses.flappingWindow !== 'UNKNOWN',
    AUTO_RESOLVED_WITHOUT_IMPACT: responses.evidenceTypes.includes('RECOVERY_EVENT')
      && responses.recoveryConfirmed === 'YES' && responses.noImpactConfirmed === 'YES'
      && responses.customerImpact === 'NO_IMPACT' && responses.serviceImpact === 'NO_IMPACT',
    CORRELATED_CHILD_ALERT: responses.evidenceTypes.includes('PARENT_INCIDENT_CORRELATION')
      && responses.correlationReference && responses.correlationReference !== 'UNABLE_TO_VERIFY',
    PLANNED_MAINTENANCE: responses.evidenceTypes.includes('MAINTENANCE_RECORD')
      && responses.maintenanceReference && responses.maintenanceReference !== 'UNABLE_TO_VERIFY',
    STALE_ALERT: responses.staleLastObservedDate && responses.noActiveImpactConfirmed === 'YES',
    EXPECTED_BEHAVIOR: responses.expectedEventCategory
      && responses.expectedEventCategory !== 'UNABLE_TO_VERIFY',
  }[reason] ?? positiveEvidence));
  if (requestedOutcome === 'CONFIRMED_INCIDENT') {
    if (!positiveEvidence || ['NO_TECHNICAL_FAILURE_FOUND', 'UNKNOWN', null].includes(responses.technicalCondition)) {
      conflictingEvidence.push('incidentTechnicalEvidence');
    }
    if (!impactEvidence) conflictingEvidence.push('incidentImpactEvidence');
  }
  if (requestedOutcome === 'CONFIRMED_NOISE') {
    if (!positiveNoiseReasons.length) conflictingEvidence.push('noiseReason');
    if (!noiseSupport || responses.evidenceStrength !== 'CONFIRMED') conflictingEvidence.push('noiseSupportingEvidence');
  }
  const saveDraft = input.saveDraft === true || input.save_draft === true;
  const pending = saveDraft || requestedOutcome === 'PENDING_EVIDENCE'
    || missingEvidence.length > 0 || conflictingEvidence.length > 0;
  const outcomeStatus = pending ? 'PENDING_EVIDENCE' : requestedOutcome;
  const pendingReasons = [...new Set([
    ...(saveDraft ? ['DRAFT_SAVED'] : []),
    ...missingEvidence.map((field) => `MISSING:${field}`),
    ...conflictingEvidence.map((field) => `CONFLICTING:${field}`),
  ])];
  const pendingEvidenceReason = pending
    ? `Evidence Pending — ${pendingReasons.join('; ') || 'required evidence is incomplete or ambiguous'}`
    : null;
  responses.outcomeStatus = outcomeStatus;
  responses.pendingEvidenceReason = pendingEvidenceReason;
  const attachmentLinks = normalizedLinks(firstInput(input, 'attachmentLinks', 'attachment_links'));
  const attachments = [
    ...normalizeWebAttachments(input.uploadedAttachments || input.uploaded_attachments),
    ...normalizeSlackAttachments(input.slackAttachments || input.slack_attachments),
    ...attachmentLinks.map((url) => ({ source: 'LINK', name: 'Supporting evidence link', url, content: null, sha256: null })),
  ];
  return {
    attachments,
    finalDecision: legacyDecisionForEvidenceOutcome(outcomeStatus),
    outcomeStatus,
    pendingEvidenceReason,
    pendingEvidenceDetails: { missingEvidence, conflictingEvidence, saveDraft },
    responses,
    validationStatus: outcomeStatus === 'PENDING_EVIDENCE' ? 'PENDING_EVIDENCE' : 'VALIDATED',
  };
}

function normalizeIncidentReport(input = {}) {
  const legacyEvidenceCategory = input.noiseSubtype === 'DUPLICATE' ? 'DUPLICATE_ALERT'
    : input.noiseSubtype === 'FLAPPING' ? 'FLAPPING_ALERT'
      : input.noiseSubtype === 'AUTO_RESOLVED' ? 'AUTO_RESOLUTION' : input.evidenceCategory || 'OTHER';
  return normalizeEvidenceSubmission({
    ...input,
    identityStatus: input.identityStatus || 'CONFIRMED',
    lifecycleStatus: input.alertLifecycleStatus || input.currentAlertStatus || 'ACKNOWLEDGED',
    evidenceCategory: legacyEvidenceCategory,
  });
}

function createHumanVerificationService({
  db = database,
  ml = mlService,
  outcomes = operationalOutcomeService,
  resolveSlackUser = slackUserService.resolveSlackUser,
  learning = evidenceLearningService,
  slackConfigProvider = integrationService.getSlackRuntimeConfig,
  fetchImpl = global.fetch,
  attachmentStore = evidenceAttachmentStore,
  sleepImpl = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  clock = () => new Date(),
  enabledSince = new Date(),
} = {}) {
  async function ensureSchema() {
    await ml.ensureSchema();
    await learning.ensureSchema();
    if (!incidentReportSchemaReady) {
      incidentReportSchemaReady = db.query(
        `${incidentReportMigrationSql}\n${evidenceCollectionMigrationSql}\n${evidenceVersionMigrationSql}\n${occurrenceVerificationMigrationSql}\n${slackCallbackInboxMigrationSql}\n${capacityMigrationSql}\n${pendingEvidenceMigrationSql}\n${productionHistoryMigrationSql}`,
      ).catch((error) => {
        incidentReportSchemaReady = null;
        throw error;
      });
    }
    await incidentReportSchemaReady;
  }

  function environmentStatus() {
    return {
      enabled: String(process.env.SLACK_HUMAN_VERIFICATION_ENABLED || 'false').toLowerCase() === 'true',
      channelConfigured: Boolean(process.env.SLACK_ALERT_VERIFICATION_CHANNEL_ID?.trim()),
      signingSecretConfigured: Boolean(process.env.SLACK_SIGNING_SECRET?.trim()),
      mode: 'HUMAN_VERIFICATION',
    };
  }

  function occurrenceSeverity(occurrence = {}) {
    const severity = String(occurrence.severity || '').trim().toLowerCase();
    if (['critical', 'high', 'medium', 'warning', 'low'].includes(severity)) return severity;
    return ({ P1: 'critical', P2: 'high', P3: 'medium', P4: 'warning', P5: 'low' })[
      String(occurrence.priority || '').trim().toUpperCase()
    ] || 'warning';
  }

  function occurrenceStatus(occurrence = {}) {
    const status = String(occurrence.status || '').trim().toLowerCase().replaceAll(' ', '-');
    if (['open', 'acknowledged', 'escalated', 'investigating', 'suppressed', 'auto-resolved',
      'deduplicated', 'firing', 'triggered', 'resolved', 'recovered', 'closed'].includes(status)) return status;
    return 'open';
  }

  function occurrenceEnvironment(occurrence = {}) {
    const environment = String(occurrence.environment || '').trim().toLowerCase();
    if (['production', 'staging', 'development'].includes(environment)) return environment;
    if (/\bprod(?:uction)?\b/.test(environment)) return 'production';
    if (/\bstag(?:ing)?\b/.test(environment)) return 'staging';
    if (/\bdev(?:elopment)?\b/.test(environment)) return 'development';
    return 'unknown';
  }

  async function ensureOccurrenceEvidenceContext(occurrence = {}) {
    if (!occurrence.occurrenceId) return occurrence;
    const contextHash = crypto.createHash('sha256')
      .update(`${occurrence.slackChannelId}:${occurrence.sourceMessageTs}`)
      .digest('hex').slice(0, 24);
    const alertId = occurrence.canonicalAlertId || `SLACK-OCCURRENCE-${contextHash}`;
    const evaluationId = occurrence.evaluationId || `slack-occurrence-eval-${contextHash}`;
    const source = clean(occurrence.sourceSystem, 255) || 'Unknown';
    const timestamp = toIso(occurrence.timestamp) || clock().toISOString();
    const title = clean(occurrence.title, 1000) || `Alert #${occurrence.alertNumber || 'Unknown'}`;
    const responder = clean(occurrence.responder || occurrence.responderTeam, 255);
    const environment = occurrenceEnvironment(occurrence);
    const service = clean(occurrence.service, 255) || 'unknown';
    const rawPayload = {
      ...(occurrence.rawPayload || {}),
      slackOccurrence: {
        occurrenceId: occurrence.occurrenceId,
        channelId: occurrence.slackChannelId,
        messageTs: occurrence.sourceMessageTs,
        eventId: occurrence.slackEventId || null,
      },
      responder,
      team: responder,
    };
    const normalizedAlert = {
      alert_number: occurrence.alertNumber || null,
      responder,
      team: responder,
      source_name: source,
      monitoring_event_url: occurrence.monitoringLink || null,
      jira_url: occurrence.jiraLink || null,
      slack_permalink: occurrence.slackPermalink || null,
    };
    await db.query(`INSERT INTO alerts (
      id,title,service,environment,severity,status,classification,noise_type,
      source,source_type,source_alert_id,source_url,slack_channel_id,slack_message_ts,
      raw_payload,extracted_details,received_at,last_seen_at,owner,signal,description,
      atlassian_ops_tiny_id
    ) VALUES ($1,$2,$3,$4,$5,$6,'unclassified','none',$7,'slack',$8,$9,$10,$11,
      $12::jsonb,$13::jsonb,$14,$14,$15,$16,$17,$18)
    ON CONFLICT (id) DO NOTHING`, [
      alertId, title, service, environment, occurrenceSeverity(occurrence), occurrenceStatus(occurrence),
      source, occurrence.slackAlertId || occurrence.sourceEventId || occurrence.occurrenceId,
      occurrence.monitoringLink || occurrence.slackPermalink || null,
      occurrence.slackChannelId, occurrence.sourceMessageTs,
      JSON.stringify(rawPayload), JSON.stringify({ normalized_alert: normalizedAlert }), timestamp,
      responder || 'Unassigned', title, occurrence.description || occurrence.rawMessage || title,
      occurrence.alertNumber || null,
    ]);
    const featureSnapshot = {
      features: {
        source, priority_class: occurrence.priority || null, environment,
        lifecycle_state: occurrence.status || null, identity_known: false,
        source_api_available: null, evidence_revision: timestamp,
      },
      identity: {
        service: occurrence.service || null,
        application: occurrence.application || null,
        environment,
      },
      operationalPriority: { value: occurrence.priority || null },
      episode: { episodeId: occurrence.occurrenceId, occurrenceCount: 1 },
      slackOccurrence: {
        channelId: occurrence.slackChannelId,
        messageTs: occurrence.sourceMessageTs,
        eventId: occurrence.slackEventId || null,
      },
    };
    await db.query(`INSERT INTO live_shadow_evaluations (
      evaluation_id,request_id,alert_id,source,source_alert_id,feature_as_of,
      model_version,model_release_status,final_decision,confidence,business_impact,
      actionability,underlying_event,notification_role,noise_detection,classification,
      feature_snapshot,technical_evidence,evidence_references,explanation,
      adapter_diagnostics,failure_reasons,evaluation_time_ms,source_mutations
    ) VALUES ($1,$2,$3,$4,$5,$6,'NOT_TRAINED','NOT_READY','NEEDS_REVIEW',NULL,
      'UNKNOWN','UNKNOWN','UNKNOWN','PRIMARY',$7::jsonb,$8::jsonb,$9::jsonb,$10::jsonb,
      $11::jsonb,$12::jsonb,'[]'::jsonb,$13::jsonb,0,0)
    ON CONFLICT (evaluation_id) DO NOTHING`, [
      evaluationId, `slack-occurrence-${contextHash}`, alertId, source,
      occurrence.slackAlertId || occurrence.sourceEventId || occurrence.occurrenceId, timestamp,
      JSON.stringify({ labels: [], status: 'EVIDENCE_INCOMPLETE' }),
      JSON.stringify({ domain: 'UNKNOWN', subtype: 'UNKNOWN' }),
      JSON.stringify(featureSnapshot),
      JSON.stringify({ coverage: { sourceResolution: { status: 'UNABLE_TO_VERIFY' }, evidenceCompleteness: { status: 'PARTIAL' } } }),
      JSON.stringify([{ type: 'SLACK_SOURCE_OCCURRENCE', channelId: occurrence.slackChannelId, messageTs: occurrence.sourceMessageTs, timestamp }]),
      JSON.stringify({ summary: 'Evidence is incomplete; human verification is required.', evidenceGap: 'CANONICAL_SOURCE_EVIDENCE_UNAVAILABLE' }),
      JSON.stringify(['SOURCE_EVIDENCE_INCOMPLETE']),
    ]);
    return {
      ...occurrence,
      alertId,
      canonicalAlertId: alertId,
      evaluationId,
      currentDecision: occurrence.currentDecision || 'NEEDS_REVIEW',
      evidenceWorkflow: isCommandCenterAlert(occurrence) ? 'LIVE' : 'BACKFILL',
    };
  }

  async function context(alertId, evaluationId = null) {
    await ensureSchema();
    const storedOccurrence = await slackAlertStoreService.getAlertOccurrence(alertId);
    let sourceOccurrence = null;
    if (storedOccurrence) {
      const materialized = await ensureOccurrenceEvidenceContext(storedOccurrence);
      sourceOccurrence = materialized;
      alertId = materialized.canonicalAlertId;
      evaluationId ||= materialized.evaluationId;
    }
    const values = [alertId];
    const evaluationClause = evaluationId ? `AND evaluation.evaluation_id = $${values.push(evaluationId)}` : '';
    const result = await db.query(`SELECT evaluation.*, alert.title, alert.description,
      alert.environment, alert.service, alert.severity, alert.status AS alert_status,
      alert.source_url,
      alert.raw_payload, alert.extracted_details,
      alert.atlassian_ops_tiny_id, alert.received_at, alert.acknowledged,
      ${commandCenterAlertProjectionSql('alert')},
      prediction.predicted_class, prediction.model_score AS prediction_model_score,
      prediction.model_version AS prediction_model_version,
      prediction.prediction_id, prediction.feature_snapshot_id AS prediction_feature_snapshot_id,
      prediction.p_incident, prediction.p_noise, prediction.p_review,
      prediction.predicted_at
      FROM live_shadow_evaluations evaluation
      JOIN alerts alert ON alert.id=evaluation.alert_id
      LEFT JOIN LATERAL (
        SELECT prediction_id, predicted_class, model_score, model_version,
          feature_snapshot_id, p_incident, p_noise, p_review, predicted_at
        FROM ml_multiclass_shadow_predictions prediction
        WHERE prediction.alert_id=evaluation.alert_id
          AND prediction.feature_snapshot_id IN (
            SELECT feature_snapshot_id FROM ml_feature_snapshots snapshot
            WHERE snapshot.alert_id=evaluation.alert_id
              AND snapshot.feature_as_of=evaluation.feature_as_of
          )
        ORDER BY prediction.predicted_at DESC LIMIT 1
      ) prediction ON TRUE
      WHERE evaluation.alert_id=$1 ${evaluationClause}
      ORDER BY evaluation.created_at DESC, evaluation.feature_as_of DESC LIMIT 1`, values);
    if (!result.rows[0]) throw verificationError('The requested evaluation was not found.', 'HUMAN_VERIFICATION_EVALUATION_NOT_FOUND', 404);
    const evaluation = result.rows[0];
    return {
      alert: {
        id: evaluation.alert_id, title: evaluation.title, description: evaluation.description,
        environment: evaluation.environment, service: evaluation.service,
        severity: evaluation.severity, status: evaluation.alert_status,
        source_url: evaluation.source_url,
        raw_payload: evaluation.raw_payload || {}, extracted_details: evaluation.extracted_details || {},
        atlassian_ops_tiny_id: evaluation.atlassian_ops_tiny_id, received_at: evaluation.received_at,
        acknowledged: evaluation.acknowledged,
        responderTeam: evaluation.visibility_responder_team,
        responder: evaluation.visibility_responder,
        team: evaluation.visibility_team,
      },
      evaluation,
      modelPrediction: evaluation.predicted_class ? {
        prediction_id: evaluation.prediction_id,
        predicted_class: evaluation.predicted_class,
        model_score: evaluation.prediction_model_score,
        model_version: evaluation.prediction_model_version,
        feature_snapshot_id: evaluation.prediction_feature_snapshot_id,
        p_incident: evaluation.p_incident,
        p_noise: evaluation.p_noise,
        p_needs_review: evaluation.p_review,
        predicted_at: evaluation.predicted_at,
      } : null,
      // Keep the selected Slack delivery/occurrence as presentation context even
      // when evidence is stored against an existing canonical alert. Multiple
      // channel deliveries can share an alert number and must not silently swap
      // timestamps, responders, links, or source fields in the UI.
      sourceOccurrence,
    };
  }

  async function incidentReportContext(alertId) {
    const value = await context(alertId);
    const evaluation = value.evaluation;
    const alert = value.alert;
    const normalized = alert.extracted_details?.normalized_alert || {};
    const jira = alert.extracted_details?.jira || {};
    const slack = alert.extracted_details?.slack || alert.extracted_details?.slack_enrichment || {};
    const technical = evaluation.technical_evidence || {};
    const occurrence = value.sourceOccurrence;
    const sourceAlertLink = sourceHttpUrl(evaluation.source,
      occurrence?.monitoringLink,
      technical.coverage?.sourceResolution?.deepLink,
      technical.deepLink,
      technical.sourceSpecificEvidence,
      normalized.monitoring_event_url,
      normalized.deep_event_link,
      alert.raw_payload?.sourceUrl,
      alert.raw_payload?.source_url,
      alert.source_url,
    );
    const jiraLink = firstHttpUrl(
      occurrence?.jiraLink,
      normalized.jira_url,
      jira.issue_url,
      jira.jira_url,
      alert.raw_payload?.jiraUrl,
    );
    const slackMessageLink = firstHttpUrl(
      occurrence?.slackPermalink,
      slack.permalink,
      slack.slack_permalink,
      alert.raw_payload?.slackPermalink,
    );
    const reports = await db.query(`SELECT * FROM incident_verification_reports
      WHERE alert_id=$1 ORDER BY submitted_at DESC, report_id DESC`, [alertId]);
    const lifecycle = technical.monitoringLifecycle || {};
    const identity = evaluation.feature_snapshot?.identity || {};
    const featureSnapshot = createFeatureSnapshotRecord({ alert, evaluation });
    const evidence = evidencePresentationFor({ ...value, featureSnapshot });
    const sourceSpecific = sourceSpecificValues(evaluation.source, {
      alert, evaluation, features: featureSnapshot.features, identity, normalized, technical,
    });
    const latestReport = reports.rows[0] || null;
    const latestOutcomeStatus = latestReport
      ? canonicalEvidenceOutcome(latestReport.evidence_outcome_status || latestReport.human_decision)
      : 'PENDING_EVIDENCE';
    const monitoredEntityChoices = monitoringEntityChoices(
      sourceSpecific, identity, featureSnapshot.features, alert,
    );
    return {
      alert: {
        alertId: alert.id,
        alertName: occurrence?.title || alert.title || alert.description || 'Untitled alert',
        alertNumber: occurrence?.alertNumber || alert.atlassian_ops_tiny_id || null,
        monitoringSource: occurrence?.sourceSystem || evaluation.source || normalized.source_name || null,
        priority: occurrence?.priority || evaluation.feature_snapshot?.operationalPriority?.value
          || alert.raw_payload?.priority?.name || alert.raw_payload?.priority || null,
        severity: occurrence?.severity || alert.severity || null,
        status: occurrence?.status || alert.status || null,
        environment: occurrence?.environment || alert.environment || null,
        service: occurrence?.service || alert.service || identity.service || null,
        application: occurrence?.application || identity.application || normalized.application || null,
        entity: identity.entity || identity.entityId || null,
        responderTeam: occurrence
          ? (occurrence.responder || occurrence.responderTeam || 'Unassigned')
          : (value.alert.responderTeam || value.alert.responder || value.alert.team || 'Unassigned'),
        receivedAt: toIso(occurrence?.timestamp) || toIso(alert.received_at),
        sourceAlertLink,
        jiraLink,
        slackMessageLink,
        currentSystemDecision: evaluation.final_decision,
        evidenceCompleteness: evidence.overallStatus,
        evidenceAvailable: evidence.availableCount,
        evidenceTotal: evidence.categories.length,
        evidenceOutcomeStatus: latestOutcomeStatus,
        evidenceOutcomeLabel: evidenceOutcomeLabel(latestOutcomeStatus),
        pendingEvidenceReason: latestReport?.pending_evidence_reason || null,
      },
      evidence: {
        status: evidence.overallStatus,
        availableCount: evidence.availableCount,
        totalCount: evidence.categories.length,
        categories: evidence.categories.map((item) => ({
          key: item.key, label: item.label, status: item.status, detail: item.detail,
        })),
        missing: evidence.needsResponder.map((item) => ({ key: item.key, label: item.label, prompt: item.prompt })),
      },
      defaults: {
        ...(latestReport?.form_responses || {}),
        ...sourceSpecificDefaults(sourceSpecific),
        exactApplication: occurrence?.application || identity.application || featureSnapshot.features.application || null,
        service: occurrence?.service || identity.service || featureSnapshot.features.service || alert.service || null,
        hostNode: identity.host || featureSnapshot.features.host || featureSnapshot.features.entity || null,
        alertRule: featureSnapshot.features.rule_title || normalized.rule_name || alert.title || null,
        metric: featureSnapshot.features.metric || normalized.metric || null,
        businessTransaction: identity.entity || identity.entityId || featureSnapshot.features.entity || null,
        identityStatus: featureSnapshot.features.identity_known === true ? 'CONFIRMED' : '',
        lifecycleStatus: lifecycle.recovery?.recovered ? 'RECOVERED'
          : lifecycle.persistence?.currentlyFiring ? 'FIRING'
            : alert.acknowledged ? 'ACKNOWLEDGED' : '',
        firstObservedTime: lifecycle.firstObservedAt || toIso(occurrence?.timestamp) || toIso(alert.received_at),
        acknowledgedTime: lifecycle.acknowledgedAt || null,
        recoveryTime: lifecycle.recovery?.recoveredAt || null,
        duration: lifecycle.persistence?.durationSeconds === null
          || lifecycle.persistence?.durationSeconds === undefined
          ? null : `${lifecycle.persistence.durationSeconds} seconds`,
        occurrenceCount: lifecycle.persistence?.occurrenceCount
          || evaluation.feature_snapshot?.episode?.occurrenceCount || null,
        affectedPlatformService: occurrence?.service || alert.service || identity.service || null,
        monitoringToolLinks: sourceAlertLink || '',
        jiraLinks: jiraLink || '',
        slackLinks: slackMessageLink || '',
        monitoringMatch: latestReport?.form_responses?.monitoringMatch
          || (featureSnapshot.features.identity_known === true ? 'EXACT_MATCH' : ''),
        monitoringState: latestReport?.form_responses?.monitoringState
          || (lifecycle.recovery?.recovered ? 'RECOVERED'
            : lifecycle.persistence?.currentlyFiring ? 'ACTIVE' : ''),
        evidenceTypes: latestReport?.form_responses?.evidenceTypes || [],
        affectedScope: latestReport?.form_responses?.affectedScope || [],
        noiseReasons: latestReport?.form_responses?.noiseReasons || [],
        humanDecision: ['CONFIRMED_INCIDENT', 'CONFIRMED_NOISE'].includes(latestOutcomeStatus)
          ? latestOutcomeStatus : '',
      },
      formSchema: { ...STRUCTURED_EVIDENCE_SCHEMA, monitoringEntityChoices: monitoredEntityChoices },
      evaluationId: evaluation.evaluation_id,
      previousReports: reports.rows.map(mapIncidentReport),
      appendOnly: true,
      origin: isCommandCenterAlert(occurrence || value.alert) ? 'LIVE' : 'BACKFILL',
      systemRecommendationSeparate: true,
      modelRecommendationSeparate: true,
    };
  }

  async function slackEvidenceHistoryContext(alertId, evaluationId = null) {
    const value = await context(alertId, evaluationId);
    const reports = await db.query(`SELECT * FROM incident_verification_reports
      WHERE alert_id=$1 ORDER BY submitted_at DESC, report_id DESC LIMIT 5`, [alertId]);
    return {
      ...value,
      previousReports: reports.rows.map(mapIncidentReport),
      appendOnly: true,
    };
  }

  async function storedSourceAvailability() {
    try {
      const result = await db.query(`SELECT DISTINCT ON (source, COALESCE(source_instance, ''))
        source, source_instance, status, configured, source_data_usable, checked_at
        FROM live_source_connectivity_checks
        ORDER BY source, COALESCE(source_instance, ''), checked_at DESC, id DESC`);
      return connectivityAvailability(result.rows);
    } catch {
      return {};
    }
  }

  async function slackEvidenceReviewContext(
    alertId,
    evaluationId = null,
    {
      actionType = 'INITIAL_LOAD', actorId = null, draftValues = null,
      channelId = null, messageTs = null, origin = 'LIVE',
    } = {},
  ) {
    const value = await context(alertId, actionType === 'REFRESH' ? null : evaluationId);
    if (!isCommandCenterAlert(value.alert) && String(origin).toUpperCase() !== 'BACKFILL') {
      throw verificationError('Non-Command-Center evidence must use the append-only backfill workflow.', 'BACKFILL_WORKFLOW_REQUIRED', 409);
    }
    const [reports, priorRefresh, sourceAvailability, slackPermalink] = await Promise.all([
      db.query(`SELECT * FROM incident_verification_reports
        WHERE alert_id=$1 ORDER BY submitted_at DESC, report_id DESC LIMIT 5`, [alertId]),
      db.query(`SELECT evidence_snapshot, source_status, refreshed_at FROM evidence_refresh_events
        WHERE alert_id=$1 ORDER BY refreshed_at DESC, refresh_event_id DESC LIMIT 1`, [alertId]),
      storedSourceAvailability(),
      channelId && messageTs
        ? slackApi('chat.getPermalink', { channel: channelId, message_ts: messageTs })
          .then((result) => firstHttpUrl(result.permalink))
          .catch(() => null)
        : Promise.resolve(null),
    ]);
    const previousReports = reports.rows.map(mapIncidentReport);
    const featureSnapshot = createFeatureSnapshotRecord({ alert: value.alert, evaluation: value.evaluation });
    const refreshedAt = clock().toISOString();
    const previousSnapshot = priorRefresh.rows[0]?.evidence_snapshot || null;
    const snapshot = storedEvidenceSnapshot(
      {
        ...value,
        featureSnapshot,
        sourceAvailability,
        slackRuntimeAvailable: true,
        slackMessageLink: slackPermalink,
      },
      previousReports, previousSnapshot, draftValues, refreshedAt,
    );
    const refreshEventId = `evidence-refresh-${crypto.randomUUID()}`;
    await db.query(`INSERT INTO evidence_refresh_events (
      refresh_event_id, alert_id, evaluation_id, action_type, evidence_snapshot,
      source_status, refreshed_by, refreshed_at
    ) VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8)`, [
      refreshEventId, alertId, value.evaluation.evaluation_id, actionType,
      JSON.stringify(snapshot), JSON.stringify(snapshot.sourceStatus), actorId, refreshedAt,
    ]);
    return {
      ...value,
      featureSnapshot,
      previousReports,
      evidenceReview: { ...snapshot, refreshEventId },
      appendOnly: true,
    };
  }

  async function submitEvidence(alertId, input, actor, options = {}) {
    await ensureSchema();
    if (options.idempotencyKey) {
      const priorCallbackReport = await db.query(`SELECT * FROM incident_verification_reports
        WHERE slack_callback_id=$1 LIMIT 1`, [options.idempotencyKey]);
      if (priorCallbackReport.rows[0]) {
        return {
          report: mapIncidentReport(priorCallbackReport.rows[0]),
          idempotentReplay: true,
          sourceMutations: 0,
        };
      }
    }
    const value = await context(alertId, input.evaluationId || input.evaluation_id || null);
    const normalized = normalizeEvidenceSubmission(input);
    const origin = String(options.origin || input.origin || 'LIVE').toUpperCase() === 'BACKFILL' ? 'BACKFILL' : 'LIVE';
    if (!isCommandCenterAlert(value.alert) && origin !== 'BACKFILL') {
      throw verificationError('Non-Command-Center evidence must use the append-only backfill workflow.', 'BACKFILL_WORKFLOW_REQUIRED', 409);
    }
    const existingReport = await db.query(`SELECT report_id, human_decision, evidence_outcome_status, form_responses FROM incident_verification_reports
      WHERE alert_id=$1 ORDER BY submitted_at DESC, report_id DESC LIMIT 1`, [alertId]);
    const updateEvidence = options.updateEvidence === true || input.updateEvidence === true || input.update_evidence === true;
    if (existingReport.rows[0] && !updateEvidence) {
      throw verificationError(
        'Evidence has already been submitted for this alert. Choose Update Evidence to add a corrected append-only submission.',
        'DUPLICATE_EVIDENCE_SUBMISSION',
        409,
        { field: 'decision_justification' },
      );
    }
    if (existingReport.rows[0] && updateEvidence && !normalized.responses.editReason) {
      normalized.responses.editReason = 'STRUCTURED_EVIDENCE_UPDATE';
    }
    const updateOfReportId = updateEvidence ? existingReport.rows[0]?.report_id || null : null;
    const revisions = revisionsFor(value.evaluation);
    const noiseByEvidence = {
      EXACT_DUPLICATE: { subtype: 'DUPLICATE', reason: 'DUPLICATE_NOTIFICATION' },
      FLAPPING: { subtype: 'FLAPPING', reason: 'REPEATED_FIRING_RECOVERY' },
      AUTO_RESOLVED_WITHOUT_IMPACT: { subtype: 'AUTO_RESOLVED', reason: 'AUTHORITATIVE_RECOVERY' },
      CORRELATED_CHILD_ALERT: { subtype: 'CORRELATED', reason: 'CORRELATED_SECONDARY_SYMPTOM' },
      PLANNED_MAINTENANCE: { subtype: 'NON_ACTIONABLE', reason: 'SCHEDULED_MAINTENANCE' },
      EXPECTED_BEHAVIOR: { subtype: 'NON_ACTIONABLE', reason: 'EXPECTED_NON_ACTIONABLE' },
      NON_ACTIONABLE_INFORMATIONAL_EVENT: { subtype: 'INFORMATIONAL', reason: 'EXPECTED_NON_ACTIONABLE' },
      STALE_ALERT: { subtype: 'STALE', reason: 'STALE_NOTIFICATION' },
      TEST_SYNTHETIC_ALERT: { subtype: 'OTHER', reason: 'OTHER' },
    };
    const noiseEvidence = noiseByEvidence[normalized.responses.noiseReasons?.[0]] || null;
    const reasonCode = normalized.finalDecision === 'INCIDENT'
      ? 'CUSTOMER_IMPACT'
      : normalized.finalDecision === 'NOISE'
        ? noiseEvidence?.reason || 'OTHER'
        : 'INSUFFICIENT_EVIDENCE';
    const feedbackResult = normalized.outcomeStatus === 'PENDING_EVIDENCE' ? { feedback: null } : await submit({
      alertId,
      evaluationId: value.evaluation.evaluation_id,
      episodeId: revisions.episodeId,
      decisionRevision: input.decisionRevision || input.decision_revision || revisions.decisionRevision,
      evidenceRevision: input.evidenceRevision || input.evidence_revision || revisions.evidenceRevision,
      humanDecision: normalized.finalDecision,
      humanSubtype: normalized.finalDecision === 'NOISE' ? noiseEvidence?.subtype || 'OTHER' : undefined,
      reasonCode,
      humanEvidenceText: normalized.responses.evidenceDescription || normalized.responses.evidenceTypes.join(', '),
      comment: normalized.responses.exceptionNotes || normalized.responses.decisionJustification,
    }, actor, {
      identityVerified: true,
      idempotencyKey: options.idempotencyKey,
      channel: options.channel === 'SLACK' ? 'SLACK' : 'WEB_EVIDENCE_COLLECTION',
      slackChannelId: options.slackChannelId,
      slackMessageTs: options.slackMessageTs,
    });
    const reportId = `evidence-${crypto.randomUUID()}`;
    const attachmentRecords = await Promise.all(normalized.attachments.map(async (attachment) => {
      const attachmentId = `evidence-file-${crypto.randomUUID()}`;
      const stored = attachment.source === 'WEB_UPLOAD' && attachment.content
        ? await attachmentStore.persist(attachmentId, attachment.content)
        : { storageBackend: null, storageKey: null };
      return {
        ...attachment,
        attachmentId,
        content: stored.storageKey ? null : attachment.content,
        ...stored,
        publicReference: attachment.source === 'WEB_UPLOAD'
          ? `/api/evidence/attachments/${encodeURIComponent(attachmentId)}`
          : attachment.url || null,
      };
    }));
    const safeAttachmentReferences = attachmentRecords.map((attachment) => ({
      attachmentId: attachment.attachmentId,
      source: attachment.source,
      externalFileId: attachment.externalFileId || null,
      name: attachment.name,
      mimeType: attachment.mimeType || null,
      size: attachment.size || null,
      url: attachment.publicReference,
    }));
    const inserted = await db.query(`INSERT INTO incident_verification_reports (
      report_id, alert_id, episode_id, evaluation_id, decision_revision, evidence_revision,
      alert_number, alert_name, reviewer_id, reviewer_name, reviewer_email,
      form_responses, attachment_links, human_decision, validation_status, feedback_id,
      responder_team, reviewer_slack_user_id, submission_channel, attachment_references,
      origin, update_of_report_id, evidence_completeness
      , slack_callback_id, evidence_outcome_status, pending_evidence_reason,
      pending_evidence_details, evidence_form_schema_version
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb,$14,$15,$16,$17,$18,$19,$20::jsonb,$21,$22,$23,$24,$25,$26,$27::jsonb,$28)
    RETURNING *`, [
      reportId, alertId, revisions.episodeId, value.evaluation.evaluation_id,
      revisions.decisionRevision, revisions.evidenceRevision,
      value.alert.atlassian_ops_tiny_id || null,
      value.alert.title || value.alert.description || 'Untitled alert',
      actor.id || actor.userId, actor.display || actor.displayName || actor.name || actor.id, actor.email || null,
      JSON.stringify(normalized.responses), JSON.stringify(safeAttachmentReferences.filter((item) => item.source === 'LINK').map((item) => item.url)),
      normalized.finalDecision, normalized.validationStatus,
      feedbackResult.feedback?.feedbackId || null,
      value.alert.responderTeam || value.alert.responder || value.alert.team || 'Unassigned', options.channel === 'SLACK' ? (actor.id || actor.userId) : null,
      options.channel === 'SLACK' ? 'SLACK' : 'WEB', JSON.stringify(safeAttachmentReferences),
      origin, updateOfReportId, completenessForResponses(normalized.responses),
      options.idempotencyKey || null,
      normalized.outcomeStatus, normalized.pendingEvidenceReason,
      JSON.stringify(normalized.pendingEvidenceDetails), STRUCTURED_EVIDENCE_SCHEMA_VERSION,
    ]);
    for (const attachment of attachmentRecords) {
      await db.query(`INSERT INTO evidence_submission_attachments (
        attachment_id, report_id, alert_id, source, external_file_id, file_name,
        mime_type, file_size, external_url, content, sha256, metadata,
        storage_backend, storage_key
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14)`, [
        attachment.attachmentId, reportId, alertId, attachment.source,
        attachment.externalFileId || null, attachment.name, attachment.mimeType || null,
        attachment.size || null, attachment.url || null, attachment.content || null,
        attachment.sha256 || null, JSON.stringify({ appendOnly: true }),
        attachment.storageBackend || null, attachment.storageKey || null,
      ]);
    }
    if (updateOfReportId) {
      const previousValues = existingReport.rows[0]?.form_responses || {};
      const newValues = normalized.responses;
      const changedFields = [...new Set([...Object.keys(previousValues), ...Object.keys(newValues)])]
        .filter((key) => JSON.stringify(previousValues[key] ?? null) !== JSON.stringify(newValues[key] ?? null))
        .sort();
      const latestRefresh = await db.query(`SELECT refresh_event_id, evidence_snapshot, source_status, refreshed_at
        FROM evidence_refresh_events WHERE alert_id=$1
        ORDER BY refreshed_at DESC, refresh_event_id DESC LIMIT 1`, [alertId]);
      const refresh = latestRefresh.rows[0] || null;
      await db.query(`INSERT INTO evidence_submission_version_events (
        version_event_id, alert_id, previous_report_id, new_report_id,
        previous_values, new_values, changed_fields, editor_id, editor_name,
        edit_reason, evidence_provenance
      ) VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::text[],$8,$9,$10,$11::jsonb)`, [
        `evidence-version-${crypto.randomUUID()}`, alertId, updateOfReportId, reportId,
        JSON.stringify(previousValues), JSON.stringify(newValues), changedFields,
        actor.id || actor.userId, actor.display || actor.displayName || actor.name || actor.id,
        normalized.responses.editReason,
        JSON.stringify(refresh ? {
          refreshEventId: refresh.refresh_event_id,
          refreshedAt: toIso(refresh.refreshed_at),
          sourceStatus: refresh.source_status || {},
        } : { refreshEventId: options.refreshEventId || input.refreshEventId || null }),
      ]);
    }
    await learning.recordSubmission({
      alert: value.alert,
      evaluation: {
        ...value.evaluation,
        priority: value.evaluation.feature_snapshot?.operationalPriority?.value
          || value.alert.raw_payload?.priority?.name || value.alert.raw_payload?.priority || null,
      },
      report: inserted.rows[0],
      updateOfReportId,
    });
    liveAlertStreamService.broadcast('evidence', {
      alertId,
      reportId,
      outcomeStatus: normalized.outcomeStatus,
      updatedAt: inserted.rows[0]?.submitted_at || clock().toISOString(),
    });
    return {
      report: mapIncidentReport(inserted.rows[0]),
      feedback: feedbackResult.feedback || null,
      appendOnly: true,
      sourceMutations: 0,
    };
  }

  async function submitIncidentReport(alertId, input, actor) {
    const value = await context(alertId);
    return submitEvidence(alertId, normalizeIncidentReport(input).responses, actor, {
      channel: 'WEB', origin: isCommandCenterAlert(value.alert) ? 'LIVE' : 'BACKFILL',
    });
  }

  async function getEvidenceAttachment(attachmentId) {
    await ensureSchema();
    const result = await db.query(`SELECT attachment.*,
      ${commandCenterAlertProjectionSql('alert')}
      FROM evidence_submission_attachments attachment
      JOIN alerts alert ON alert.id=attachment.alert_id
      WHERE attachment.attachment_id=$1 LIMIT 1`, [attachmentId]);
    const row = result.rows[0];
    if (!row) {
      throw verificationError('The requested attachment is not visible.', 'ATTACHMENT_NOT_VISIBLE', 404);
    }
    return {
      content: row.content || (row.storage_key ? await attachmentStore.read(row.storage_key) : null),
      externalUrl: row.external_url,
      fileName: row.file_name,
      mimeType: row.mime_type,
    };
  }

  async function persistFeatureSnapshot(value) {
    const snapshot = createFeatureSnapshotRecord({ alert: value.alert, evaluation: value.evaluation });
    await db.query(`INSERT INTO ml_feature_snapshots (
      feature_snapshot_id, alert_id, episode_id, evidence_revision,
      feature_schema_version, feature_as_of, features, leakage_audit
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (feature_snapshot_id) DO NOTHING`, [
      snapshot.featureSnapshotId, snapshot.alertId, snapshot.episodeId, snapshot.evidenceRevision,
      FEATURE_SCHEMA_VERSION, snapshot.featureAsOf, snapshot.features, snapshot.audit,
    ]);
    return snapshot;
  }

  async function persistPredictionSnapshot(value, snapshot) {
    const prediction = value.modelPrediction;
    const predictionId = `hvp-${crypto.randomUUID()}`;
    const status = prediction?.predicted_class ? 'AVAILABLE' : 'MODEL_NOT_TRAINED';
    const result = await db.query(`INSERT INTO human_verification_prediction_snapshots (
      prediction_id, alert_id, episode_id, evaluation_id, feature_snapshot_id,
      model_version, prediction_status, predicted_class, p_incident, p_noise,
      p_needs_review, model_score
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
    ON CONFLICT (evaluation_id, feature_snapshot_id) DO NOTHING
    RETURNING *`, [
      predictionId, snapshot.alertId, snapshot.episodeId || snapshot.alertId,
      value.evaluation.evaluation_id, snapshot.featureSnapshotId,
      prediction?.model_version || 'NOT_TRAINED', status,
      prediction?.predicted_class || null, prediction?.p_incident ?? null,
      prediction?.p_noise ?? null, prediction?.p_needs_review ?? null,
      prediction?.model_score ?? null,
    ]);
    if (result.rows[0]) return result.rows[0];
    const existing = await db.query(`SELECT * FROM human_verification_prediction_snapshots
      WHERE evaluation_id=$1 AND feature_snapshot_id=$2 LIMIT 1`, [
      value.evaluation.evaluation_id, snapshot.featureSnapshotId,
    ]);
    return existing.rows[0];
  }

  async function prepareContext(value) {
    const featureSnapshot = await persistFeatureSnapshot(value);
    const predictionSnapshot = await persistPredictionSnapshot(value, featureSnapshot);
    return { ...value, featureSnapshot, predictionSnapshot };
  }

  function eligibilityFor({ status, snapshot, evaluation, humanDecision }) {
    if (status !== 'VALIDATED') return { eligible: false, reason: status };
    if (humanDecision === 'NEEDS_REVIEW') return { eligible: false, reason: 'NEEDS_REVIEW_UNLABELED' };
    if (!snapshot?.featureSnapshotId) return { eligible: false, reason: 'FEATURE_SNAPSHOT_MISSING' };
    if (snapshot.features?.evidence_revision === null || snapshot.evidenceRevision === null) {
      return { eligible: false, reason: 'EVIDENCE_REVISION_MISSING' };
    }
    const grouping = evaluation.feature_snapshot?.episode?.legacyGroupingDisposition;
    if (['GROUPING_SUPERSEDED', 'LEGACY_GROUPING_REQUIRES_REPLAY'].includes(grouping)) {
      return { eligible: false, reason: grouping };
    }
    if (FEATURE_SCHEMA_VERSION !== 'alert-evidence-multiclass-v1') {
      return { eligible: false, reason: 'UNSUPPORTED_FEATURE_SCHEMA' };
    }
    return { eligible: true, reason: null };
  }

  function trustedResponder(actor, identityVerified) {
    if (!identityVerified || !actor) throw verificationError('An authenticated responder is required.', 'HUMAN_VERIFICATION_AUTHENTICATION_REQUIRED', 401);
    const id = clean(actor.id || actor.userId || actor.accountId || actor.email, 255);
    if (!id) throw verificationError('A verified responder ID is required.', 'HUMAN_VERIFICATION_AUTHENTICATION_REQUIRED', 401);
    return {
      id,
      display: clean(actor.displayName || actor.name || actor.email || id, 255) || id,
      email: clean(actor.email, 320),
      permissions: Array.isArray(actor.permissions) ? actor.permissions : ['outcomes:write'],
      roles: Array.isArray(actor.roles) ? actor.roles : [actor.role || 'operator'],
      type: 'user',
    };
  }

  async function insertFeedback(value) {
    const result = await db.query(`INSERT INTO human_verification_feedback (
      feedback_id, alert_id, episode_id, evaluation_id, decision_revision,
      evidence_revision, deterministic_decision, deterministic_subtype,
      source, priority, model_prediction, model_version, model_score, model_scores,
      human_decision, human_subtype,
      reason_code, human_evidence_text, comment, responder_id, responder_display_name, channel,
      slack_channel_id, slack_message_ts, feature_snapshot_id, prediction_id, status,
      validation_code, training_eligible, training_exclusion_reason, is_test, metadata
      , slack_callback_id
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33)
    RETURNING *`, [
      value.feedbackId, value.alertId, value.episodeId, value.evaluationId,
      value.decisionRevision, value.evidenceRevision, value.deterministicDecision,
      value.deterministicSubtype, value.source, value.priority,
      value.modelPrediction, value.modelVersion, value.modelScore, value.modelScores || {},
      value.humanDecision, value.humanSubtype, value.reasonCode,
      value.humanEvidenceText, value.comment, value.responderId, value.responderDisplayName, value.channel,
      value.slackChannelId, value.slackMessageTs, value.featureSnapshotId,
      value.predictionId, value.status, value.validationCode,
      value.trainingEligible === true, value.trainingExclusionReason || null,
      value.isTest === true, value.metadata || {}, value.slackCallbackId || null,
    ]);
    return result.rows[0];
  }

  async function submit(input, actorValue, options = {}) {
    await ensureSchema();
    const actor = trustedResponder(actorValue, options.identityVerified === true);
    const alertId = clean(input.alertId, 255);
    const requestedEvaluationId = clean(input.evaluationId || input.decisionRevision, 255);
    if (!alertId || !requestedEvaluationId) throw verificationError('Alert and evaluation revisions are required.', 'FEEDBACK_REVISION_REQUIRED');
    if (options.idempotencyKey) {
      const priorCallbackFeedback = await db.query(`SELECT * FROM human_verification_feedback
        WHERE slack_callback_id=$1 LIMIT 1`, [options.idempotencyKey]);
      if (priorCallbackFeedback.rows[0]) {
        return {
          feedback: mapFeedback(priorCallbackFeedback.rows[0]),
          humanFeedbackConflict: priorCallbackFeedback.rows[0].status === 'HUMAN_FEEDBACK_CONFLICT',
          goldLabelEligible: priorCallbackFeedback.rows[0].status === 'VALIDATED',
          operationalOutcome: null,
          deterministicDecisionChanged: false,
          idempotentReplay: true,
          sourceMutations: 0,
        };
      }
    }
    const [requested, latest] = await Promise.all([
      context(alertId, requestedEvaluationId), context(alertId),
    ]);
    const requestedRevision = revisionsFor(requested.evaluation);
    const latestRevision = revisionsFor(latest.evaluation);
    const submittedDecisionRevision = clean(input.decisionRevision, 255);
    const submittedEvidenceRevision = clean(input.evidenceRevision, 255);
    const submittedEpisodeId = clean(input.episodeId, 255);
    const validated = validateSubmission(input, requested.evaluation.final_decision);
    const feedbackId = `hvf-${crypto.randomUUID()}`;
    const stale = requestedRevision.decisionRevision !== latestRevision.decisionRevision
      || requestedRevision.evidenceRevision !== latestRevision.evidenceRevision
      || submittedDecisionRevision !== latestRevision.decisionRevision
      || submittedEvidenceRevision !== latestRevision.evidenceRevision
      || submittedEpisodeId !== latestRevision.episodeId;
    if (stale) {
      const rejected = await insertFeedback({
        feedbackId, alertId, episodeId: submittedEpisodeId || requestedRevision.episodeId,
        evaluationId: requested.evaluation.evaluation_id,
        decisionRevision: submittedDecisionRevision || requestedRevision.decisionRevision,
        evidenceRevision: submittedEvidenceRevision || requestedRevision.evidenceRevision,
        deterministicDecision: requested.evaluation.final_decision,
        deterministicSubtype: requested.evaluation.explanation?.noiseType || null,
        source: requested.evaluation.source,
        priority: requested.evaluation.feature_snapshot?.operationalPriority?.value || null,
        modelPrediction: requested.modelPrediction?.predicted_class || null,
        modelVersion: requested.modelPrediction?.model_version || null,
        modelScore: requested.modelPrediction?.model_score ?? null,
        modelScores: {}, predictionId: requested.modelPrediction?.prediction_id || null,
        humanDecision: validated.humanDecision, humanSubtype: validated.humanSubtype,
        reasonCode: validated.reasonCode, humanEvidenceText: validated.humanEvidenceText,
        comment: validated.comment,
        responderId: actor.id, responderDisplayName: actor.display,
        channel: options.channel || 'WEB', slackChannelId: options.slackChannelId || null,
        slackMessageTs: options.slackMessageTs || null, featureSnapshotId: null,
        status: 'REJECTED', validationCode: 'EVIDENCE_CHANGED',
        trainingEligible: false, trainingExclusionReason: 'EVIDENCE_CHANGED',
        metadata: {
          latestDecisionRevision: latestRevision.decisionRevision,
          latestEvidenceRevision: latestRevision.evidenceRevision,
          requestedEvidence: normalizeEvidenceKeys(input.missingEvidence),
        },
        slackCallbackId: options.idempotencyKey || null,
      });
      throw verificationError('Evidence changed — please review the latest evaluation.', 'EVIDENCE_CHANGED', 409, { feedbackId: rejected.feedback_id });
    }
    const prepared = await prepareContext(requested);
    const snapshot = prepared.featureSnapshot;
    const predictionSnapshot = prepared.predictionSnapshot;
    const priorResult = await db.query(`SELECT feedback_id, human_decision, human_subtype,
        responder_id, decision_revision, evidence_revision
      FROM human_verification_feedback
      WHERE alert_id=$1 AND episode_id=$2 AND status='VALIDATED'
      ORDER BY created_at DESC, feedback_id DESC`, [alertId, latestRevision.episodeId]);
    const conflicting = priorResult.rows.find((row) => row.human_decision !== validated.humanDecision);
    const duplicate = priorResult.rows.find((row) => row.responder_id === actor.id
      && row.human_decision === validated.humanDecision
      && (row.human_subtype || null) === (validated.humanSubtype || null)
      && row.decision_revision === latestRevision.decisionRevision
      && row.evidence_revision === latestRevision.evidenceRevision);
    const status = conflicting ? 'HUMAN_FEEDBACK_CONFLICT' : duplicate ? 'REJECTED' : 'VALIDATED';
    const validationCode = conflicting ? 'HUMAN_FEEDBACK_CONFLICT'
      : duplicate ? 'DUPLICATE_FEEDBACK_ATTEMPT' : 'CURRENT_REVISION_AUTHENTICATED_RESPONDER';
    const eligibility = eligibilityFor({
      status, snapshot, evaluation: requested.evaluation,
      humanDecision: validated.humanDecision,
    });
    const modelScores = predictionSnapshot?.prediction_status === 'AVAILABLE' ? {
      INCIDENT: Number(predictionSnapshot.p_incident),
      NOISE: Number(predictionSnapshot.p_noise),
      NEEDS_REVIEW: Number(predictionSnapshot.p_needs_review),
    } : {};
    const inserted = await insertFeedback({
      feedbackId, alertId, episodeId: latestRevision.episodeId,
      evaluationId: requested.evaluation.evaluation_id,
      decisionRevision: latestRevision.decisionRevision,
      evidenceRevision: latestRevision.evidenceRevision,
      deterministicDecision: requested.evaluation.final_decision,
      deterministicSubtype: requested.evaluation.explanation?.noiseType || null,
      source: requested.evaluation.source,
      priority: snapshot.features.priority_class || null,
      modelPrediction: predictionSnapshot?.predicted_class || null,
      modelVersion: predictionSnapshot?.model_version || 'NOT_TRAINED',
      modelScore: predictionSnapshot?.model_score ?? null,
      modelScores,
      humanDecision: validated.humanDecision, humanSubtype: validated.humanSubtype,
      reasonCode: validated.reasonCode, humanEvidenceText: validated.humanEvidenceText,
      comment: validated.comment,
      responderId: actor.id, responderDisplayName: actor.display,
      channel: options.channel || 'WEB', slackChannelId: options.slackChannelId || null,
      slackMessageTs: options.slackMessageTs || null, featureSnapshotId: snapshot.featureSnapshotId,
      predictionId: predictionSnapshot?.prediction_id || null,
      status, validationCode, trainingEligible: eligibility.eligible,
      trainingExclusionReason: eligibility.reason,
      metadata: {
        changedFromSystemDecision: validated.changed,
        groupingDisposition: requested.evaluation.feature_snapshot?.episode?.legacyGroupingDisposition || null,
        conflictingFeedbackId: conflicting?.feedback_id || null,
        predictionUsedAsLabel: false,
        requestedEvidence: normalizeEvidenceKeys(input.missingEvidence),
      },
      slackCallbackId: options.idempotencyKey || null,
    });
    if (status === 'VALIDATED') {
      await db.query(`UPDATE live_shadow_evaluations SET feedback_status='CONFIRMED'
        WHERE evaluation_id=$1`, [requested.evaluation.evaluation_id]);
    }
    if (duplicate) {
      throw verificationError('This responder already submitted the same outcome for the current revision.', 'DUPLICATE_FEEDBACK_ATTEMPT', 409, { feedbackId: inserted.feedback_id });
    }
    return {
      feedback: mapFeedback(inserted),
      humanFeedbackConflict: Boolean(conflicting),
      goldLabelEligible: status === 'VALIDATED',
      operationalOutcome: null,
      deterministicDecisionChanged: false,
      sourceMutations: 0,
    };
  }

  async function get(alertId) {
    await ensureSchema();
    const result = await db.query(`SELECT * FROM human_verification_feedback
      WHERE alert_id=$1 ORDER BY created_at DESC, feedback_id DESC`, [alertId]);
    const history = result.rows.map(mapFeedback);
    const conflict = history.some((item) => item.validationCode === 'HUMAN_FEEDBACK_CONFLICT');
    const current = conflict ? null : history.find((item) => item.status === 'VALIDATED') || null;
    return {
      alertId, current, history, conflict,
      status: conflict ? 'HUMAN_FEEDBACK_CONFLICT' : current ? 'HUMAN_VERIFIED' : 'UNCONFIRMED',
      predictionUsedAsLabel: false,
    };
  }

  async function getControlledTest(testRunId) {
    await ensureSchema();
    const [runResult, feedbackResult] = await Promise.all([
      db.query(`SELECT test_run_id, slack_channel_id, slack_message_ts, status,
          synthetic_context, created_at, completed_at
        FROM human_verification_test_runs WHERE test_run_id=$1 LIMIT 1`, [testRunId]),
      db.query(`SELECT * FROM human_verification_test_feedback
        WHERE test_run_id=$1 ORDER BY created_at DESC, feedback_id DESC`, [testRunId]),
    ]);
    const run = runResult.rows[0];
    if (!run) return null;
    return {
      testRunId: run.test_run_id,
      status: run.status,
      channelId: run.slack_channel_id,
      messageTs: run.slack_message_ts,
      syntheticContext: run.synthetic_context,
      feedback: feedbackResult.rows[0] ? mapTestFeedback(feedbackResult.rows[0]) : null,
      history: feedbackResult.rows.map(mapTestFeedback),
      createdAt: toIso(run.created_at),
      completedAt: toIso(run.completed_at),
      productionAlertMutations: 0,
    };
  }

  async function summary() {
    await ensureSchema();
    const [totals, comparison, modelComparison, diagnostics, todayTransitions, security, testRun, testFeedback, failedDeliveries] = await Promise.all([
      db.query(`SELECT COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE human_decision='INCIDENT')::int AS incident,
        COUNT(*) FILTER (WHERE human_decision='NOISE')::int AS noise,
        (SELECT COUNT(*)::int FROM (
          SELECT DISTINCT ON (report.alert_id) report.evidence_outcome_status
          FROM incident_verification_reports report
          ORDER BY report.alert_id, report.submitted_at DESC, report.report_id DESC
        ) current_report WHERE current_report.evidence_outcome_status='PENDING_EVIDENCE') AS pending_evidence,
        COUNT(*) FILTER (WHERE created_at >= CURRENT_DATE)::int AS today,
        COUNT(*) FILTER (WHERE created_at >= CURRENT_DATE AND human_decision='INCIDENT')::int AS today_incident,
        COUNT(*) FILTER (WHERE created_at >= CURRENT_DATE AND human_decision='NOISE')::int AS today_noise,
        (SELECT COUNT(*)::int FROM (
          SELECT DISTINCT ON (report.alert_id) report.evidence_outcome_status, report.submitted_at
          FROM incident_verification_reports report
          ORDER BY report.alert_id, report.submitted_at DESC, report.report_id DESC
        ) current_report WHERE current_report.evidence_outcome_status='PENDING_EVIDENCE'
          AND current_report.submitted_at >= CURRENT_DATE) AS today_pending_evidence
        FROM validated_human_feedback_v1`),
      db.query(`SELECT COUNT(*)::int AS compared,
        COUNT(*) FILTER (WHERE deterministic_decision=human_decision)::int AS agreements,
        COUNT(*) FILTER (WHERE deterministic_decision<>human_decision)::int AS disagreements
        FROM validated_human_feedback_v1`),
      db.query(`SELECT COUNT(*)::int AS compared,
        COUNT(*) FILTER (WHERE model_prediction=human_decision)::int AS agreements,
        COUNT(*) FILTER (WHERE model_prediction<>human_decision)::int AS disagreements
        FROM validated_human_feedback_v1 WHERE model_prediction IS NOT NULL`),
      db.query(`SELECT
        (SELECT COUNT(*) FROM live_shadow_evaluations_latest_v1 evaluation WHERE NOT EXISTS (
          SELECT 1 FROM validated_human_feedback_v1 feedback WHERE feedback.alert_id=evaluation.alert_id
        ))::int AS unconfirmed_alerts,
        COUNT(*) FILTER (WHERE validation_code='EVIDENCE_CHANGED')::int AS stale_feedback_attempts,
        COUNT(*) FILTER (WHERE validation_code='DUPLICATE_FEEDBACK_ATTEMPT')::int AS duplicate_feedback_attempts,
        COUNT(*) FILTER (WHERE validation_code='HUMAN_FEEDBACK_CONFLICT')::int AS human_feedback_conflicts,
        COUNT(*) FILTER (WHERE status='REJECTED')::int AS rejected_feedback,
        COUNT(*) FILTER (WHERE status='SUPERSEDED')::int AS superseded_feedback,
        COUNT(*) FILTER (WHERE feature_snapshot_id IS NULL)::int AS missing_feature_snapshot,
        COUNT(*) FILTER (WHERE NULLIF(evidence_revision,'') IS NULL)::int AS missing_evidence_revision,
        COUNT(*) FILTER (WHERE NOT training_eligible)::int AS training_dataset_exclusions,
        COUNT(*) FILTER (WHERE metadata->>'groupingDisposition' IN ('GROUPING_SUPERSEDED','LEGACY_GROUPING_REQUIRES_REPLAY'))::int AS legacy_grouping_excluded,
        (SELECT COUNT(*) FROM human_verification_deliveries WHERE status='VERIFICATION_DELIVERY_FAILED')::int AS verification_delivery_failed,
        (SELECT COUNT(*) FROM human_verification_deliveries WHERE status='SENT')::int AS verification_messages_sent
        FROM human_verification_feedback WHERE NOT is_test`),
      db.query(`SELECT deterministic_decision, human_decision, COUNT(*)::int AS count
        FROM validated_human_feedback_v1 WHERE created_at >= CURRENT_DATE
        GROUP BY deterministic_decision, human_decision`),
      db.query(`SELECT
        COUNT(*) FILTER (WHERE event_type='INVALID_SLACK_SIGNATURE')::int AS invalid_slack_signatures,
        COUNT(*) FILTER (WHERE event_type='SLACK_REPLAY_REJECTED')::int AS slack_replay_rejections
        FROM human_verification_security_events`),
      db.query(`SELECT test_run_id, status, created_at, completed_at
        FROM human_verification_test_runs ORDER BY created_at DESC LIMIT 1`),
      db.query(`SELECT feedback.* FROM human_verification_test_feedback feedback
        JOIN human_verification_test_runs run USING (test_run_id)
        ORDER BY run.created_at DESC, feedback.created_at DESC, feedback.feedback_id DESC
        LIMIT 1`),
      db.query(`SELECT delivery_id, alert_id, episode_id, attempt_count, last_error_code, updated_at
        FROM human_verification_deliveries
        WHERE status='VERIFICATION_DELIVERY_FAILED'
        ORDER BY updated_at DESC LIMIT 10`),
    ]);
    const counts = totals.rows[0] || {};
    const system = comparison.rows[0] || {};
    const model = modelComparison.rows[0] || {};
    const classDistribution = {
      INCIDENT: Number(counts.incident || 0), NOISE: Number(counts.noise || 0),
      PENDING_EVIDENCE: Number(counts.pending_evidence || 0),
    };
    const trainingReady = ['INCIDENT', 'NOISE']
      .every((decision) => classDistribution[decision] >= MINIMUM_CLASS_EXAMPLES);
    return {
      validatedExamples: Number(counts.total || 0),
      validatedToday: Number(counts.today || 0),
      todayClassDistribution: {
        INCIDENT: Number(counts.today_incident || 0),
        NOISE: Number(counts.today_noise || 0),
        PENDING_EVIDENCE: Number(counts.today_pending_evidence || 0),
      },
      todaySystemToHuman: Object.fromEntries(todayTransitions.rows.map((row) => [
        `${row.deterministic_decision}->${row.human_decision}`, Number(row.count),
      ])),
      classDistribution,
      trainingReadiness: { ready: trainingReady, minimumPerClass: MINIMUM_CLASS_EXAMPLES },
      systemVsHuman: {
        compared: Number(system.compared || 0), agreements: Number(system.agreements || 0),
        disagreements: Number(system.disagreements || 0),
        agreementRate: Number(system.compared || 0) ? Number(system.agreements || 0) / Number(system.compared) : null,
      },
      modelVsHuman: {
        compared: Number(model.compared || 0), agreements: Number(model.agreements || 0),
        disagreements: Number(model.disagreements || 0),
        agreementRate: Number(model.compared || 0) ? Number(model.agreements || 0) / Number(model.compared) : null,
      },
      diagnostics: {
        ...Object.fromEntries(Object.entries(diagnostics.rows[0] || {}).map(([key, value]) => [key, Number(value || 0)])),
        ...Object.fromEntries(Object.entries(security.rows[0] || {}).map(([key, value]) => [key, Number(value || 0)])),
      },
      controlledTest: testRun.rows[0] ? {
        testRunId: testRun.rows[0].test_run_id, status: testRun.rows[0].status,
        createdAt: toIso(testRun.rows[0].created_at), completedAt: toIso(testRun.rows[0].completed_at),
        feedback: testFeedback.rows[0]?.test_run_id === testRun.rows[0].test_run_id
          ? mapTestFeedback(testFeedback.rows[0]) : null,
      } : null,
      failedDeliveries: failedDeliveries.rows.map((row) => ({
        deliveryId: row.delivery_id,
        alertId: row.alert_id,
        attemptCount: Number(row.attempt_count || 0),
        safeErrorCode: row.last_error_code,
        updatedAt: toIso(row.updated_at),
      })),
      environment: environmentStatus(), automaticRetraining: false, automaticModelPromotion: false,
    };
  }

  async function slackApi(method, payload) {
    const config = await slackConfigProvider();
    const token = config?.botToken || process.env.SLACK_BOT_TOKEN;
    if (!token) throw verificationError('Slack bot token is not configured.', 'SLACK_BOT_TOKEN_MISSING', 503);
    const send = async (requestPayload) => {
      const response = await fetchImpl(`https://slack.com/api/${method}`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(requestPayload),
      });
      return { response, body: await response.json().catch(() => ({})) };
    };
    const maxAttempts = Math.min(Math.max(Number(process.env.SLACK_API_MAX_ATTEMPTS || 5), 1), 8);
    let response;
    let body;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      ({ response, body } = await send(payload));
      const retryable = response.status === 429 || body.error === 'ratelimited'
        || response.status === 502 || response.status === 503 || response.status === 504;
      if (!retryable || attempt === maxAttempts) break;
      const retryAfter = Number(response.headers?.get?.('retry-after'));
      const delayMilliseconds = Number.isFinite(retryAfter) && retryAfter >= 0
        ? Math.min(retryAfter * 1000, 60_000)
        : Math.min(2 ** (attempt - 1) * 1000, 30_000);
      console.warn({
        code: 'SLACK_API_RETRY_SCHEDULED',
        method,
        attempt,
        delayMilliseconds,
        status: response.status,
      });
      await sleepImpl(delayMilliseconds);
    }
    const responseMessages = Array.isArray(body.response_metadata?.messages)
      ? body.response_metadata.messages
      : [];
    const fileScopeMissing = responseMessages.some((message) => /file_input.*files:read scope/i.test(String(message)));
    if ((!response.ok || !body.ok) && fileScopeMissing && payload.view) {
      const safeView = withoutSlackFileInput(payload.view);
      if (safeView !== payload.view) {
        ({ response, body } = await send({ ...payload, view: safeView }));
        console.info({ code: 'SLACK_FILE_UPLOAD_UNAVAILABLE', fallback: 'EVIDENCE_FORM_WITHOUT_FILE_INPUT' });
      }
    }
    if (!response.ok || !body.ok) {
      const validationDetail = Array.isArray(body.response_metadata?.messages)
        ? body.response_metadata.messages.slice(0, 3).map((message) => blockText(message, 'invalid argument')).join('; ')
        : null;
      throw verificationError(
        `Slack API ${method} failed: ${body.error || `HTTP ${response.status}`}.${validationDetail ? ` ${validationDetail}` : ''}`,
        'SLACK_VERIFICATION_API_FAILED',
        502,
      );
    }
    return body;
  }

  async function validateControlledTestAccess() {
    await ensureSchema();
    const channelId = process.env.SLACK_ALERT_VERIFICATION_CHANNEL_ID?.trim();
    if (!channelId) {
      throw verificationError('Slack verification channel is not configured.', 'SLACK_VERIFICATION_CHANNEL_MISSING', 503);
    }
    const authentication = await slackApi('auth.test', {});
    const channelResult = await slackApi('conversations.info', { channel: channelId });
    const channel = channelResult.channel || {};
    return {
      authenticated: true,
      workspace: authentication.team || null,
      botIdentity: authentication.user || null,
      channelId,
      channelName: channel.name || null,
      private: Boolean(channel.is_private),
      member: channel.is_member !== false,
      chatWriteNotYetExercised: true,
      secretsExposed: false,
    };
  }

  async function saveDelivery(value) {
    await ensureSchema();
    await db.query(`INSERT INTO human_verification_deliveries (
      delivery_id, alert_id, episode_id, evaluation_id, decision_revision,
      evidence_revision, slack_channel_id, slack_message_ts, status,
      attempt_count, last_error_code
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    ON CONFLICT (evaluation_id) DO UPDATE SET
      slack_message_ts=COALESCE(EXCLUDED.slack_message_ts,human_verification_deliveries.slack_message_ts),
      status=EXCLUDED.status,
      attempt_count=human_verification_deliveries.attempt_count
        + CASE WHEN EXCLUDED.status='PENDING' THEN 1 ELSE 0 END,
      last_error_code=EXCLUDED.last_error_code, updated_at=NOW()`, [
      value.deliveryId, value.alertId, value.episodeId, value.evaluationId,
      value.decisionRevision, value.evidenceRevision, value.channelId,
      value.messageTs, value.status, value.attemptCount ?? 1, value.errorCode || null,
    ]);
  }

  async function saveOccurrenceDelivery(value) {
    await ensureSchema();
    await db.query(`INSERT INTO slack_occurrence_verification_deliveries (
      delivery_id, source_channel_id, source_message_ts, source_event_id,
      alert_number, canonical_alert_id, evaluation_id, evidence_workflow,
      verification_channel_id, verification_message_ts, status, attempt_count,
      last_error_code
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
    ON CONFLICT (source_channel_id,source_message_ts) DO UPDATE SET
      canonical_alert_id=COALESCE(EXCLUDED.canonical_alert_id,slack_occurrence_verification_deliveries.canonical_alert_id),
      evaluation_id=COALESCE(EXCLUDED.evaluation_id,slack_occurrence_verification_deliveries.evaluation_id),
      verification_message_ts=COALESCE(EXCLUDED.verification_message_ts,slack_occurrence_verification_deliveries.verification_message_ts),
      status=EXCLUDED.status,
      attempt_count=slack_occurrence_verification_deliveries.attempt_count
        + CASE WHEN EXCLUDED.status='PENDING' THEN 1 ELSE 0 END,
      last_error_code=EXCLUDED.last_error_code,
      updated_at=NOW()`, [
      value.deliveryId, value.sourceChannelId, value.sourceMessageTs,
      value.sourceEventId || null, value.alertNumber,
      value.canonicalAlertId || null, value.evaluationId || null,
      value.evidenceWorkflow, value.verificationChannelId,
      value.verificationMessageTs || null, value.status,
      value.attemptCount ?? 1, value.errorCode || null,
    ]);
  }

  async function claimOccurrenceDelivery(value, retry = false) {
    await ensureSchema();
    const result = await db.query(`INSERT INTO slack_occurrence_verification_deliveries (
      delivery_id, source_channel_id, source_message_ts, source_event_id,
      alert_number, canonical_alert_id, evaluation_id, evidence_workflow,
      verification_channel_id, verification_message_ts, status, attempt_count,
      last_error_code
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NULL,'PENDING',1,NULL)
    ON CONFLICT (source_channel_id,source_message_ts) DO UPDATE SET
      status='PENDING',attempt_count=slack_occurrence_verification_deliveries.attempt_count+1,
      last_error_code=NULL,updated_at=NOW()
    WHERE $10::boolean = TRUE
      AND slack_occurrence_verification_deliveries.status='VERIFICATION_DELIVERY_FAILED'
    RETURNING delivery_id`, [
      value.deliveryId, value.sourceChannelId, value.sourceMessageTs,
      value.sourceEventId || null, value.alertNumber, value.canonicalAlertId || null,
      value.evaluationId || null, value.evidenceWorkflow, value.verificationChannelId,
      retry,
    ]);
    return Boolean(result.rows[0]);
  }

  async function deliverOccurrence(occurrence, { retry = false } = {}) {
    const environment = environmentStatus();
    if (!environment.enabled) return { status: 'DISABLED' };
    if (!environment.channelConfigured || !environment.signingSecretConfigured) return { status: 'NOT_CONFIGURED' };
    if (!occurrence?.slackChannelId || !occurrence?.sourceMessageTs) {
      return { status: 'INVALID_SOURCE_OCCURRENCE' };
    }
    const channelId = process.env.SLACK_ALERT_VERIFICATION_CHANNEL_ID.trim();
    const existing = await db.query(`SELECT * FROM slack_occurrence_verification_deliveries
      WHERE source_channel_id=$1 AND source_message_ts=$2 LIMIT 1`,
    [occurrence.slackChannelId, occurrence.sourceMessageTs]);
    if (existing.rows[0]?.status === 'SENT' && !retry) {
      return { status: 'SKIPPED_EXACT_DELIVERY_DUPLICATE', deliveryId: existing.rows[0].delivery_id };
    }
    occurrence = await ensureOccurrenceEvidenceContext(occurrence);
    const value = await context(occurrence.canonicalAlertId, occurrence.evaluationId);
    const prepared = { ...(await prepareContext(value)), occurrence, origin: occurrence.evidenceWorkflow };
    const deliveryId = existing.rows[0]?.delivery_id || `sovd-${crypto.randomUUID()}`;
    const claimed = await claimOccurrenceDelivery({
      deliveryId, sourceChannelId: occurrence.slackChannelId,
      sourceMessageTs: occurrence.sourceMessageTs, sourceEventId: occurrence.slackEventId,
      alertNumber: occurrence.alertNumber, canonicalAlertId: occurrence.canonicalAlertId,
      evaluationId: occurrence.evaluationId, evidenceWorkflow: occurrence.evidenceWorkflow,
      verificationChannelId: channelId,
    }, retry);
    if (!claimed) {
      return { status: 'SKIPPED_EXACT_DELIVERY_DUPLICATE', deliveryId: existing.rows[0]?.delivery_id || null };
    }
    try {
      const card = buildSlackVerificationCard(prepared, process.env.ALERT_REDUCTION_WEB_URL || 'http://127.0.0.1:5173');
      const result = await slackApi('chat.postMessage', {
        channel: channelId,
        client_msg_id: deliveryId,
        metadata: {
          event_type: 'alert_evidence_verification',
          event_payload: { delivery_id: deliveryId },
        },
        ...card,
      });
      await saveOccurrenceDelivery({
        deliveryId, sourceChannelId: occurrence.slackChannelId,
        sourceMessageTs: occurrence.sourceMessageTs, sourceEventId: occurrence.slackEventId,
        alertNumber: occurrence.alertNumber, canonicalAlertId: occurrence.canonicalAlertId,
        evaluationId: occurrence.evaluationId, evidenceWorkflow: occurrence.evidenceWorkflow,
        verificationChannelId: channelId, verificationMessageTs: result.ts,
        status: 'SENT', attemptCount: 0,
      });
      return { status: 'SENT', deliveryId, messageTs: result.ts };
    } catch (error) {
      await saveOccurrenceDelivery({
        deliveryId, sourceChannelId: occurrence.slackChannelId,
        sourceMessageTs: occurrence.sourceMessageTs, sourceEventId: occurrence.slackEventId,
        alertNumber: occurrence.alertNumber, canonicalAlertId: occurrence.canonicalAlertId,
        evaluationId: occurrence.evaluationId, evidenceWorkflow: occurrence.evidenceWorkflow || 'BACKFILL',
        verificationChannelId: channelId, status: 'VERIFICATION_DELIVERY_FAILED',
        errorCode: error.code || 'SLACK_VERIFICATION_DELIVERY_FAILED', attemptCount: 0,
      });
      return { status: 'VERIFICATION_DELIVERY_FAILED', deliveryId, safeError: error.code || 'SLACK_VERIFICATION_DELIVERY_FAILED' };
    }
  }

  function queueOccurrence(occurrence) {
    const state = environmentStatus();
    if (!state.enabled) return { status: 'DISABLED' };
    setImmediate(() => deliverOccurrence(occurrence).catch((error) => console.error({
      code: error.code || 'SLACK_OCCURRENCE_VERIFICATION_FAILED',
      message: error.safeMessage || 'Occurrence verification delivery failed.',
    })));
    return { status: 'QUEUED' };
  }

  async function retryFailedOccurrences(limit = 25) {
    await ensureSchema();
    const boundedLimit = Math.min(Math.max(Number(limit) || 25, 1), 100);
    const failed = await db.query(`SELECT delivery_id,source_channel_id,source_message_ts,attempt_count
      FROM slack_occurrence_verification_deliveries
      WHERE status='VERIFICATION_DELIVERY_FAILED'
        AND attempt_count < 8
        AND updated_at <= NOW() - (LEAST(300,POWER(2,GREATEST(attempt_count-1,0))) * INTERVAL '1 second')
      ORDER BY updated_at ASC LIMIT $1`, [boundedLimit]);
    const results = [];
    for (const row of failed.rows) {
      const occurrenceId = slackAlertStoreService.encodeOccurrenceId(row.source_channel_id, row.source_message_ts);
      const occurrence = await slackAlertStoreService.getAlertOccurrence(occurrenceId);
      if (!occurrence) {
        results.push({ deliveryId: row.delivery_id, status: 'SOURCE_OCCURRENCE_MISSING' });
        continue;
      }
      results.push(await deliverOccurrence(occurrence, { retry: true }));
    }
    return results;
  }

  async function occurrenceDeliveryReconciliation() {
    await ensureSchema();
    const result = await db.query(`SELECT
      (SELECT COUNT(*)::integer FROM slack_alert_events) AS source_occurrences,
      COUNT(*)::integer AS delivery_records,
      COUNT(*) FILTER (WHERE status='SENT')::integer AS sent,
      COUNT(*) FILTER (WHERE status='SKIPPED_EXACT_DELIVERY_DUPLICATE')::integer AS exact_duplicates,
      COUNT(*) FILTER (WHERE status='CANONICAL_EVIDENCE_CONTEXT_MISSING')::integer AS context_missing,
      COUNT(*) FILTER (WHERE status='VERIFICATION_DELIVERY_FAILED')::integer AS failed
      FROM slack_occurrence_verification_deliveries`);
    const exclusions = await db.query(`SELECT status AS reason,COUNT(*)::integer AS count
      FROM slack_occurrence_verification_deliveries WHERE status<>'SENT' GROUP BY status ORDER BY count DESC,status`);
    return { ...result.rows[0], exclusions: exclusions.rows };
  }

  async function deliverEvaluation(evaluation, { retry = false } = {}) {
    const environment = environmentStatus();
    if (!environment.enabled) return { status: 'DISABLED' };
    if (!environment.channelConfigured || !environment.signingSecretConfigured) return { status: 'NOT_CONFIGURED' };
    if ((evaluation.notification_role || evaluation.notificationRole) !== 'PRIMARY') return { status: 'SKIPPED_NON_PRIMARY' };
    const evaluationAlertId = evaluation.alert_id || evaluation.alertId;
    const evaluationId = evaluation.evaluation_id || evaluation.evaluationId;
    const value = await context(evaluationAlertId, evaluationId);
    const eligibility = automaticVerificationEligibility({ alert: value.alert, evaluation: value.evaluation });
    if (!eligibility.eligible) return { status: eligibility.status };
    if (new Date(value.alert.received_at) < new Date(enabledSince)) return { status: 'SKIPPED_PRE_ENABLEMENT_ALERT' };
    const prepared = await prepareContext(value);
    const revisions = revisionsFor(value.evaluation);
    const existingDelivery = await db.query(`SELECT delivery_id, status
      FROM human_verification_deliveries
      WHERE episode_id=$1 OR evaluation_id=$2
      ORDER BY created_at DESC LIMIT 1`, [revisions.episodeId, evaluationId]);
    if (existingDelivery.rows[0] && !retry) {
      return { status: 'SKIPPED_EPISODE_ALREADY_DELIVERED', deliveryId: existingDelivery.rows[0].delivery_id };
    }
    if (retry && existingDelivery.rows[0]?.status !== 'VERIFICATION_DELIVERY_FAILED') {
      throw verificationError('Only failed verification deliveries can be retried.', 'VERIFICATION_DELIVERY_NOT_FAILED', 409);
    }
    const deliveryId = existingDelivery.rows[0]?.delivery_id || `hvd-${crypto.randomUUID()}`;
    const channelId = process.env.SLACK_ALERT_VERIFICATION_CHANNEL_ID.trim();
    try {
      await saveDelivery({ deliveryId, ...revisions, evaluationId, channelId, messageTs: null, status: 'PENDING', attemptCount: 0 });
      const card = buildSlackVerificationCard(prepared, process.env.ALERT_REDUCTION_WEB_URL || 'http://127.0.0.1:5173');
      const result = await slackApi('chat.postMessage', { channel: channelId, ...card });
      await saveDelivery({ deliveryId, ...revisions, evaluationId, channelId, messageTs: result.ts, status: 'SENT' });
      return { status: 'SENT', deliveryId, messageTs: result.ts };
    } catch (error) {
      await saveDelivery({ deliveryId, ...revisions, evaluationId, channelId, messageTs: null, status: 'VERIFICATION_DELIVERY_FAILED', errorCode: error.code || 'SLACK_VERIFICATION_DELIVERY_FAILED' });
      return { status: 'VERIFICATION_DELIVERY_FAILED', deliveryId, safeError: error.code || 'SLACK_VERIFICATION_DELIVERY_FAILED' };
    }
  }

  function queueEvaluation(evaluation) {
    const state = environmentStatus();
    if (!state.enabled) return { status: 'DISABLED' };
    if ((evaluation.notification_role || evaluation.notificationRole) !== 'PRIMARY') return { status: 'SKIPPED_NON_PRIMARY' };
    return { status: 'SOURCE_OCCURRENCE_DELIVERY_MANAGED' };
  }

  async function updateSlackMessage(payload, feedback = null, stale = false) {
    const channel = payload.channel?.id || payload.container?.channel_id;
    const ts = payload.message?.ts || payload.container?.message_ts;
    if (!channel || !ts) return { status: 'MESSAGE_CONTEXT_MISSING' };
    if (stale) {
      const action = payload.actions?.[0];
      let actionContext = {};
      try { actionContext = JSON.parse(action?.value || '{}'); } catch { actionContext = {}; }
      const latestUrl = `${(process.env.ALERT_REDUCTION_WEB_URL || 'http://127.0.0.1:5173').replace(/\/$/, '')}/#/noise-analysis?search=${encodeURIComponent(actionContext.alertId || '')}`;
      return slackApi('chat.update', {
        channel, ts,
        text: 'Evidence changed — please review the latest evaluation.',
        blocks: [
          { type: 'section', text: { type: 'mrkdwn', text: '*Evidence changed*\nPlease review the latest evaluation before confirming a human outcome.' } },
          { type: 'actions', elements: [{ type: 'button', action_id: 'human_verification_refresh', text: { type: 'plain_text', text: 'View Latest Evidence' }, value: action?.value || '{}', url: latestUrl }] },
        ],
      });
    }
    const conflict = feedback.status === 'HUMAN_FEEDBACK_CONFLICT';
    return slackApi('chat.update', {
      channel, ts,
      text: conflict ? 'Human feedback conflict — additional review required.' : `Human verified: ${feedback.humanDecision}`,
      blocks: [
        { type: 'header', text: { type: 'plain_text', text: conflict ? 'HUMAN FEEDBACK CONFLICT' : 'HUMAN VERIFIED', emoji: true } },
        { type: 'section', fields: [
          { type: 'mrkdwn', text: `*SYSTEM DECISION*\n${feedback.deterministicDecision}` },
          { type: 'mrkdwn', text: `*MODEL RECOMMENDATION*\n${feedback.modelPrediction || 'NOT AVAILABLE'}` },
          { type: 'mrkdwn', text: `*HUMAN OUTCOME*\n${feedback.humanDecision}${feedback.humanSubtype ? ` / ${feedback.humanSubtype}` : ''}` },
          { type: 'mrkdwn', text: `*Verified by*\n${feedback.responderDisplayName}` },
          { type: 'mrkdwn', text: `*Time*\n${feedback.createdAt}` },
          { type: 'mrkdwn', text: `*Feedback ID*\n${feedback.feedbackId}` },
        ] },
      ],
    });
  }

  async function recordSecurityEvent(eventType, safeMetadata = {}) {
    await ensureSchema();
    if (!['INVALID_SLACK_SIGNATURE', 'SLACK_REPLAY_REJECTED'].includes(eventType)) return;
    await db.query(`INSERT INTO human_verification_security_events (event_type, safe_metadata)
      VALUES ($1,$2)`, [eventType, safeMetadata]);
  }

  async function sendControlledTest() {
    await ensureSchema();
    const environment = environmentStatus();
    if (!environment.channelConfigured || !environment.signingSecretConfigured) {
      throw verificationError('Slack verification channel and signing secret must be configured.', 'SLACK_VERIFICATION_NOT_CONFIGURED', 503);
    }
    const testRunId = `hvt-${crypto.randomUUID()}`;
    const channelId = process.env.SLACK_ALERT_VERIFICATION_CHANNEL_ID.trim();
    const modelState = await ml.status();
    const syntheticContext = {
      test: true, alertId: `TEST_ALERT_${testRunId}`, episodeId: `TEST_EPISODE_${testRunId}`,
      source: 'TEST SOURCE', priority: 'P3', lifecycle: 'SYNTHETIC', evidenceStatus: 'COMPLETE',
      evidenceKey: 'TEST_EVIDENCE_KEY', featureSnapshotId: `TEST_FEATURE_${testRunId}`,
      decisionRevision: 'TEST_DECISION_V1', evidenceRevision: 'TEST_EVIDENCE_V1',
      systemDecision: 'NEEDS_REVIEW', systemSubtype: null,
      modelPrediction: null, modelVersion: modelState.modelVersion,
      modelScores: {}, modelStatus: modelState.status,
    };
    await db.query(`INSERT INTO human_verification_test_runs (
      test_run_id, slack_channel_id, status, synthetic_context
    ) VALUES ($1,$2,'PENDING',$3)`, [testRunId, channelId, syntheticContext]);
    try {
      const result = await slackApi('chat.postMessage', {
        channel: channelId,
        ...buildControlledTestCard(
          testRunId,
          process.env.ALERT_REDUCTION_WEB_URL || 'http://127.0.0.1:5173',
          modelState,
        ),
      });
      await db.query(`UPDATE human_verification_test_runs
        SET slack_message_ts=$2, status='SENT' WHERE test_run_id=$1`, [testRunId, result.ts]);
      return { testRunId, status: 'SENT', automaticVerificationEnabled: environment.enabled, productionAlertMutations: 0 };
    } catch (error) {
      await db.query(`UPDATE human_verification_test_runs SET status='DELIVERY_FAILED'
        WHERE test_run_id=$1`, [testRunId]);
      throw error;
    }
  }

  async function recordTestFeedback(actionContext, values, actor) {
    const result = await db.query(`SELECT * FROM human_verification_test_runs
      WHERE test_run_id=$1 LIMIT 1`, [actionContext.testRunId]);
    const run = result.rows[0];
    if (!run || run.status !== 'SENT') {
      throw verificationError('The controlled test run is unavailable or already completed.', 'CONTROLLED_TEST_NOT_ACTIVE', 409);
    }
    const validated = validateSubmission(values, 'NEEDS_REVIEW');
    const expected = run.synthetic_context || {};
    const submitted = {
      alertId: actionContext.alertId,
      episodeId: actionContext.episodeId,
      decisionRevision: actionContext.decisionRevision,
      evidenceRevision: actionContext.evidenceRevision,
      featureSnapshotId: actionContext.featureSnapshotId,
    };
    const stale = controlledTestRevisionChanged(expected, submitted);
    const feedbackId = `test-feedback-${crypto.randomUUID()}`;
    const status = stale ? 'REJECTED' : 'VALIDATED';
    const validationCode = stale ? 'EVIDENCE_CHANGED' : 'CURRENT_REVISION_SIGNATURE_VERIFIED_RESPONDER';
    const inserted = await db.query(`INSERT INTO human_verification_test_feedback (
      feedback_id, test_run_id, alert_id, episode_id, source, priority,
      system_decision, system_subtype, model_prediction, model_version, model_scores,
      human_decision, human_subtype, reason_code, human_evidence_text, human_comment,
      responder_slack_user_id, responder_display_name, channel_id, message_ts,
      decision_revision, evidence_revision, feature_snapshot_id, status, validation_code,
      training_eligible, training_exclusion_reason, metadata
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,FALSE,$26,$27)
    RETURNING *`, [
      feedbackId, actionContext.testRunId, submitted.alertId || expected.alertId,
      submitted.episodeId || expected.episodeId, expected.source || 'TEST SOURCE',
      expected.priority || 'P3', expected.systemDecision || 'NEEDS_REVIEW',
      expected.systemSubtype || null, expected.modelPrediction || null,
      expected.modelVersion || 'NOT_TRAINED', expected.modelScores || {},
      validated.humanDecision, validated.humanSubtype, validated.reasonCode,
      validated.humanEvidenceText, validated.comment, actor.id, actor.display,
      actionContext.channelId || run.slack_channel_id,
      actionContext.messageTs || run.slack_message_ts,
      submitted.decisionRevision || '', submitted.evidenceRevision || '',
      submitted.featureSnapshotId || '', status, validationCode,
      'SYNTHETIC_TEST', {
        synthetic: true,
        expectedRevision: expected.evidenceRevision,
        requestedEvidence: normalizeEvidenceKeys(actionContext.missingEvidence),
      },
    ]);
    const feedback = mapTestFeedback(inserted.rows[0]);
    await db.query(`UPDATE human_verification_test_runs SET status=$5, feedback=$2,
      responder_id=$3, responder_display_name=$4, completed_at=NOW()
      WHERE test_run_id=$1`, [
      actionContext.testRunId, feedback, actor.id, actor.display,
      stale ? 'EVIDENCE_CHANGED' : 'VALIDATED',
    ]);
    if (stale) {
      throw verificationError(
        'Evidence changed — please review the latest evaluation.',
        'EVIDENCE_CHANGED',
        409,
        { feedbackId },
      );
    }
    return feedback;
  }

  async function retryDelivery(deliveryId) {
    await ensureSchema();
    const result = await db.query(`SELECT evaluation.* FROM human_verification_deliveries delivery
      JOIN live_shadow_evaluations evaluation ON evaluation.evaluation_id=delivery.evaluation_id
      WHERE delivery.delivery_id=$1 AND delivery.status='VERIFICATION_DELIVERY_FAILED' LIMIT 1`, [deliveryId]);
    if (!result.rows[0]) throw verificationError('Failed verification delivery was not found.', 'VERIFICATION_DELIVERY_NOT_FOUND', 404);
    return deliverEvaluation(result.rows[0], { retry: true });
  }

  async function slackResponder(payload) {
    const id = payload.user?.id;
    if (!id) throw verificationError('Slack responder identity is missing.', 'SLACK_RESPONDER_MISSING', 401);
    const resolved = await resolveSlackUser(id).catch(() => null);
    return { id, displayName: resolved?.name || resolved?.displayName || id, email: resolved?.email || null, role: 'operator' };
  }

  async function handleSlackInteraction(payload, processing = {}) {
    if (payload.type === 'view_submission' && payload.view?.callback_id === 'collect_evidence_modal') {
      const actionContext = parseActionValue(payload.view.private_metadata);
      const values = {
        ...(actionContext.draftValues || {}),
        ...slackEvidenceValues(payload.view.state?.values || {}),
      };
      const actor = await slackResponder(payload);
      const messagePayload = {
        container: { channel_id: actionContext.channelId, message_ts: actionContext.messageTs },
        actions: [{ value: JSON.stringify(actionContext) }],
      };
      try {
        if (actionContext.isTest) {
          const category = String(values.evidence_category || '').toUpperCase();
          const noiseMap = {
            DUPLICATE_ALERT: ['DUPLICATE', 'DUPLICATE_NOTIFICATION'],
            FLAPPING_ALERT: ['FLAPPING', 'REPEATED_FIRING_RECOVERY'],
            AUTO_RESOLUTION: ['AUTO_RESOLVED', 'AUTHORITATIVE_RECOVERY'],
          };
          const mapped = noiseMap[category] || ['OTHER', 'OTHER'];
          const decision = canonicalDecision(values.human_decision);
          const feedback = await recordTestFeedback(actionContext, {
            humanDecision: decision,
            humanSubtype: decision === 'NOISE' ? mapped[0] : null,
            reasonCode: decision === 'INCIDENT' ? 'CUSTOMER_IMPACT'
              : decision === 'NOISE' ? mapped[1] : 'INSUFFICIENT_EVIDENCE',
            humanEvidenceText: values.evidence_description,
            comment: values.decision_justification,
          }, actor);
          await slackApi('chat.postMessage', {
            channel: actionContext.channelId, thread_ts: actionContext.messageTs,
            text: `✅ Evidence submitted for TEST ALERT (#TEST-${actionContext.testRunId})`,
          });
          return { response: { response_action: 'clear' }, result: { feedback, controlledTest: true } };
        }
        const result = await submitEvidence(actionContext.alertId, {
          ...values,
          alertId: actionContext.alertId,
          evaluationId: actionContext.evaluationId,
          decisionRevision: actionContext.decisionRevision,
          evidenceRevision: actionContext.evidenceRevision,
          slackAttachments: slackFileReferences(payload.view.state?.values || {}),
        }, actor, {
          channel: 'SLACK',
          idempotencyKey: processing.callbackId || null,
          slackChannelId: actionContext.channelId,
          slackMessageTs: actionContext.messageTs,
          updateEvidence: actionContext.updateEvidence,
          origin: actionContext.origin,
          refreshEventId: actionContext.refreshEventId,
        });
        await db.query(`UPDATE human_verification_deliveries SET status='EVIDENCE_SUBMITTED', updated_at=NOW()
          WHERE slack_channel_id=$1 AND slack_message_ts=$2`, [actionContext.channelId, actionContext.messageTs]);
        const report = result.report;
        const responses = report.formResponses || {};
        const evidenceComplete = report.evidenceCompleteness === 'COMPLETE'
          && report.outcomeStatus !== 'PENDING_EVIDENCE';
        const summaryMessage = {
          channel: actionContext.channelId,
          thread_ts: actionContext.messageTs,
          text: `✅ Evidence ${actionContext.updateEvidence ? 'updated' : 'submitted'} for ${report.alertName} (#${report.alertNumber || report.alertId})\n\nSubmitted by: ${report.reviewer.name}\nSubmitted at: ${report.submittedAt}\nEvidence status: ${evidenceComplete ? 'Complete' : 'Partial'}\nOutcome: ${report.outcomeLabel}`,
          blocks: [
            { type: 'section', text: { type: 'mrkdwn', text: `✅ *Evidence ${actionContext.updateEvidence ? 'updated' : 'submitted'}* for ${report.alertName} (#${report.alertNumber || report.alertId})\n*Submitted by:* ${report.reviewer.name}\n*Submitted at:* ${report.submittedAt}\n*Evidence status:* ${evidenceComplete ? 'Complete' : 'Partial'}\n*Outcome:* ${report.outcomeLabel}${report.pendingEvidenceReason ? `\n*Reason:* ${report.pendingEvidenceReason}` : ''}` } },
            verificationActions({
              actionContext: { ...actionContext, updateEvidence: true, origin: report.origin || actionContext.origin },
              sourceUrl: null,
              jiraUrl: null,
              eligible: true,
              historical: report.origin === 'BACKFILL',
            }),
          ],
        };
        await slackApi('chat.postMessage', {
          ...summaryMessage,
          client_msg_id: String(report.reportId || '').replace(/^evidence-/, '').slice(0, 36),
        });
        const refreshed = await slackEvidenceReviewContext(
          actionContext.alertId,
          actionContext.evaluationId,
          {
            actionType: 'INITIAL_LOAD', actorId: actor.id,
            channelId: actionContext.channelId, messageTs: actionContext.messageTs,
            origin: actionContext.origin,
          },
        );
        const refreshedRevisions = revisionsFor(refreshed.evaluation);
        const refreshedActionContext = {
          ...actionContext,
          updateEvidence: true,
          evaluationId: refreshed.evaluation.evaluation_id,
          decisionRevision: refreshedRevisions.decisionRevision,
          evidenceRevision: refreshedRevisions.evidenceRevision,
          refreshEventId: refreshed.evidenceReview.refreshEventId,
        };
        if (actionContext.channelId && actionContext.messageTs) {
          const storedOccurrence = actionContext.occurrenceId
            ? await slackAlertStoreService.getAlertOccurrence(actionContext.occurrenceId)
            : null;
          const refreshedCard = buildSlackVerificationCard(
            {
              ...refreshed,
              occurrence: {
                ...(storedOccurrence || {}),
                evidenceStatus: report.outcomeStatus,
                evidenceOutcomeStatus: report.outcomeStatus,
                pendingEvidenceReason: report.pendingEvidenceReason,
                evidenceCompletionPercentage: evidenceComplete ? 100
                  : storedOccurrence?.evidenceCompletionPercentage || 1,
                evidenceLastRefreshedAt: refreshed.evidenceReview.refreshedAt || report.submittedAt,
              },
            },
            process.env.ALERT_REDUCTION_WEB_URL || 'http://127.0.0.1:5173',
          );
          await slackApi('chat.update', {
            channel: actionContext.channelId,
            ts: actionContext.messageTs,
            ...refreshedCard,
          });
        }
        return {
          response: {
            response_action: 'update',
            view: buildEvidenceReviewModal(refreshed, refreshedActionContext),
          },
          result,
        };
      } catch (error) {
        if (error.code === 'EVIDENCE_CHANGED') {
          await db.query(`UPDATE human_verification_deliveries SET status='EVIDENCE_CHANGED', updated_at=NOW()
            WHERE slack_channel_id=$1 AND slack_message_ts=$2`, [actionContext.channelId, actionContext.messageTs]);
          await updateSlackMessage(messagePayload, null, true);
          return { response: { response_action: 'clear' }, errorCode: error.code };
        }
        if (error.status && error.status < 500) {
          const field = error.safeDetails?.field || 'decision_justification';
          return { response: { response_action: 'errors', errors: { [field]: error.safeMessage || error.message } }, errorCode: error.code };
        }
        throw error;
      }
    }
    if (payload.type === 'view_submission' && payload.view?.callback_id === 'human_verification_modal') {
      const actionContext = parseActionValue(payload.view.private_metadata);
      const values = payload.view.state?.values || {};
      const actor = await slackResponder(payload);
      const submittedValues = {
        ...actionContext, humanDecision: actionContext.humanDecision,
        humanSubtype: values.human_subtype?.value?.selected_option?.value,
        reasonCode: values.reason_code?.value?.selected_option?.value,
        humanEvidenceText: values.human_evidence?.value?.value,
        comment: values.comment?.value?.value,
      };
      const messagePayload = {
        container: { channel_id: actionContext.channelId, message_ts: actionContext.messageTs },
        actions: [{ value: JSON.stringify(actionContext) }],
      };
      try {
        if (actionContext.isTest) {
          const feedback = await recordTestFeedback(actionContext, submittedValues, actor);
          await updateSlackMessage(messagePayload, feedback, false);
          return { response: { response_action: 'clear' }, result: { feedback, controlledTest: true } };
        }
        const result = await submit(submittedValues, actor, {
          identityVerified: true, channel: 'SLACK',
          idempotencyKey: processing.callbackId || null,
          slackChannelId: actionContext.channelId, slackMessageTs: actionContext.messageTs,
        });
        await db.query(`UPDATE human_verification_deliveries SET status=$3, updated_at=NOW()
          WHERE slack_channel_id=$1 AND slack_message_ts=$2`, [
          actionContext.channelId, actionContext.messageTs,
          'VERIFIED',
        ]);
        await updateSlackMessage(messagePayload, result.feedback, false);
        return { response: { response_action: 'clear' }, result };
      } catch (error) {
        if (error.code === 'EVIDENCE_CHANGED') {
          await db.query(`UPDATE human_verification_deliveries SET status='EVIDENCE_CHANGED', updated_at=NOW()
            WHERE slack_channel_id=$1 AND slack_message_ts=$2`, [actionContext.channelId, actionContext.messageTs]);
          await updateSlackMessage(messagePayload, null, true);
          return { response: { response_action: 'clear' }, errorCode: error.code };
        }
        if (error.status && error.status < 500) {
          return { response: { response_action: 'errors', errors: { comment: error.safeMessage || error.message } }, errorCode: error.code };
        }
        throw error;
      }
    }
    const action = payload.actions?.[0];
    if (action?.action_id?.startsWith('evidence_')) {
      const actionContext = parseActionValue(action.value);
      const actor = await slackResponder(payload);
      const channelId = actionContext.channelId || payload.channel?.id || payload.container?.channel_id;
      const messageTs = actionContext.messageTs || payload.message?.ts || payload.container?.message_ts;
      const isRefresh = ['evidence_refresh', 'evidence_refresh_draft'].includes(action.action_id);
      const isEdit = ['evidence_edit', 'evidence_update', 'evidence_refresh_draft'].includes(action.action_id);
      const carriesDraft = ['evidence_refresh_draft', 'evidence_page_next', 'evidence_page_back', 'evidence_save_draft']
        .includes(action.action_id);
      const draftValues = carriesDraft ? {
        ...(actionContext.draftValues || {}),
        ...slackEvidenceValues(payload.view?.state?.values || {}),
      } : actionContext.draftValues || {};
      const reviewContext = await slackEvidenceReviewContext(
        actionContext.alertId,
        actionContext.evaluationId,
        {
          actionType: isRefresh ? 'REFRESH' : 'INITIAL_LOAD', actorId: actor.id, draftValues,
          channelId, messageTs, origin: actionContext.origin,
        },
      );
      const revisions = revisionsFor(reviewContext.evaluation);
      const refreshedActionContext = {
        ...actionContext,
        channelId,
        messageTs,
        evaluationId: reviewContext.evaluation.evaluation_id,
        decisionRevision: revisions.decisionRevision,
        evidenceRevision: revisions.evidenceRevision,
        refreshEventId: reviewContext.evidenceReview.refreshEventId,
        formPage: actionContext.formPage,
        draftValues,
      };
      if (action.action_id === 'evidence_save_draft') {
        const saved = await submitEvidence(actionContext.alertId, {
          ...draftValues,
          saveDraft: true,
          evaluationId: reviewContext.evaluation.evaluation_id,
          decisionRevision: revisions.decisionRevision,
          evidenceRevision: revisions.evidenceRevision,
        }, actor, {
          channel: 'SLACK', slackChannelId: channelId, slackMessageTs: messageTs,
          updateEvidence: actionContext.updateEvidence || reviewContext.previousReports.length > 0,
          origin: actionContext.origin,
        });
        const savedContext = await slackEvidenceHistoryContext(actionContext.alertId, reviewContext.evaluation.evaluation_id);
        await slackApi('views.update', {
          view_id: payload.view?.id,
          ...(payload.view?.hash ? { hash: payload.view.hash } : {}),
          view: buildEvidenceHistoryModal(savedContext, refreshedActionContext),
        });
        return { response: { ok: true, modalUpdated: true, action: action.action_id }, result: saved };
      }
      const view = action.action_id === 'evidence_refresh'
        ? buildEvidenceReviewModal(reviewContext, refreshedActionContext)
        : buildEvidenceCollectionModal(reviewContext, {
          ...refreshedActionContext,
          draftValues,
          updateEvidence: isEdit
            || actionContext.updateEvidence === true
            || reviewContext.previousReports.length > 0,
        });
      await slackApi('views.update', {
        view_id: payload.view?.id,
        ...(payload.view?.hash ? { hash: payload.view.hash } : {}),
        view,
      });
      return { response: { ok: true, modalUpdated: true, action: action.action_id } };
    }
    const evidenceMenuSelection = action ? slackEvidenceMenuSelection(action) : null;
    if (evidenceMenuSelection) {
      const actionContext = evidenceMenuSelection;
      const menuAction = actionContext.menuAction;
      const channelId = payload.channel?.id || payload.container?.channel_id;
      const messageTs = payload.message?.ts || payload.container?.message_ts;
      const loadingContext = { ...actionContext, channelId, messageTs };
      const opened = await slackApi('views.open', {
        trigger_id: payload.trigger_id,
        view: buildEvidenceLoadingModal(loadingContext),
      });
      console.info({ code: 'SLACK_EVIDENCE_LOADING_MODAL_OPENED' });
      const viewId = opened.view?.id;
      const updateView = async (view) => {
        if (!viewId) throw verificationError('Slack did not return a modal view ID.', 'SLACK_MODAL_VIEW_ID_MISSING', 502);
        const updated = await slackApi('views.update', { view_id: viewId, view });
        console.info({ code: 'SLACK_EVIDENCE_MODAL_UPDATED' });
        return updated;
      };
      try {
        const value = actionContext.isTest ? {
          alert: {
            id: actionContext.alertId,
            atlassian_ops_tiny_id: `TEST-${actionContext.testRunId}`,
            title: 'TEST ALERT — NOT A PRODUCTION ALERT',
            environment: 'Test', severity: 'TEST', responderTeam: 'Command Center', raw_payload: {}, extracted_details: {},
            received_at: clock().toISOString(),
          },
          evaluation: {
            evaluation_id: actionContext.evaluationId, source: 'TEST SOURCE', final_decision: 'NEEDS_REVIEW',
            feature_as_of: clock().toISOString(), feature_snapshot: { identity: {} }, technical_evidence: {},
          },
          featureSnapshot: { featureSnapshotId: actionContext.featureSnapshotId, features: { source: 'TEST SOURCE', priority_class: 'P3', environment: 'Test' } },
        } : await context(actionContext.alertId, actionContext.evaluationId);

        if (['view_submitted_evidence', 'view_existing_evidence'].includes(menuAction)) {
          const history = actionContext.isTest
            ? { ...value, previousReports: [] }
            : await slackEvidenceHistoryContext(actionContext.alertId, actionContext.evaluationId);
          await updateView(buildEvidenceHistoryModal(history, loadingContext));
          return { response: { ok: true, modalOpened: true, menuAction } };
        }

        const backfill = actionContext.origin === 'BACKFILL' || menuAction === 'open_backfill_review';
        if (actionContext.isTest) {
          await updateView(buildEvidenceCollectionModal(value, {
            ...loadingContext,
            origin: backfill ? 'BACKFILL' : actionContext.origin,
            updateEvidence: menuAction === 'update_evidence' || backfill || actionContext.updateEvidence,
          }));
          return { response: { ok: true, modalOpened: true, menuAction } };
        }
        const review = await slackEvidenceReviewContext(actionContext.alertId, actionContext.evaluationId, {
          actionType: 'INITIAL_LOAD',
          actorId: payload.user?.id || null,
          channelId,
          messageTs,
          origin: backfill ? 'BACKFILL' : 'LIVE',
        });
        const revisions = revisionsFor(review.evaluation);
        const reviewedActionContext = {
          ...loadingContext,
          evaluationId: review.evaluation.evaluation_id,
          decisionRevision: revisions.decisionRevision,
          evidenceRevision: revisions.evidenceRevision,
          refreshEventId: review.evidenceReview.refreshEventId,
          origin: backfill ? 'BACKFILL' : actionContext.origin,
          updateEvidence: menuAction === 'update_evidence' || backfill || actionContext.updateEvidence,
        };
        await updateView(['collect_evidence', 'update_evidence', 'open_backfill_review'].includes(menuAction)
          ? buildEvidenceCollectionModal(review, reviewedActionContext)
          : buildEvidenceReviewModal(review, reviewedActionContext));
        return { response: { ok: true, modalOpened: true, menuAction } };
      } catch (error) {
        await updateView(buildEvidenceUnavailableModal(loadingContext, error.safeMessage)).catch(() => {});
        console.error({
          code: error.code || 'SLACK_EVIDENCE_LOAD_FAILED',
          message: error.safeMessage || 'Slack evidence loading failed.',
        });
        return { response: { ok: true, modalOpened: true, menuAction, evidenceStatus: 'PARTIAL' } };
      }
    }
    if (!action || !['human_verify_incident', 'human_verify_noise', 'human_verify_review', 'human_verification_refresh'].includes(action.action_id)) {
      return { response: { ok: true, ignored: true } };
    }
    const actionContext = parseActionValue(action.value);
    if (action.action_id === 'human_verification_refresh') {
      return { response: { response_type: 'ephemeral', text: 'Open View Evidence and review the latest evaluation before confirming.' } };
    }
    const decision = action.action_id === 'human_verify_incident' ? 'INCIDENT'
      : action.action_id === 'human_verify_noise' ? 'NOISE' : 'NEEDS_REVIEW';
    await slackApi('views.open', { trigger_id: payload.trigger_id, view: modalFor(decision, {
      ...actionContext, channelId: payload.channel?.id || payload.container?.channel_id,
      messageTs: payload.message?.ts || payload.container?.message_ts,
    }) });
    return { response: { ok: true, modalOpened: true } };
  }

  return {
    deliverEvaluation, deliverOccurrence, ensureSchema, environmentStatus, get, getControlledTest, handleSlackInteraction,
    getEvidenceAttachment, incidentReportContext, submitEvidence, submitIncidentReport,
    occurrenceDeliveryReconciliation, queueEvaluation, queueOccurrence, recordSecurityEvent,
    retryDelivery, retryFailedOccurrences, sendControlledTest, submit, summary,
    validateControlledTestAccess, slackEvidenceReviewContext,
  };
}

module.exports = {
  EVIDENCE_OUTCOMES,
  EVIDENCE_REQUIREMENTS,
  EVIDENCE_CATEGORIES,
  FEEDBACK_STATUSES,
  HUMAN_DECISIONS,
  IDENTITY_CONFIRMATION_STATUSES,
  INCIDENT_REASONS,
  NOISE_REASONS,
  NOISE_SUBTYPES,
  REVIEW_REASONS,
  STRUCTURED_EVIDENCE_SCHEMA,
  STRUCTURED_EVIDENCE_SCHEMA_VERSION,
  automaticVerificationEligibility,
  buildEvidenceHistoryModal,
  buildEvidenceLoadingModal,
  buildEvidenceReviewModal,
  buildEvidenceUnavailableModal,
  withoutSlackFileInput,
  buildSlackVerificationCard,
  buildControlledTestCard,
  buildEvidenceCollectionModal,
  canonicalDecision,
  canonicalEvidenceOutcome,
  controlledTestRevisionChanged,
  createHumanVerificationService,
  evidencePresentationFor,
  evidenceOutcomeLabel,
  evidenceMenuOptions,
  modalFor,
  normalizeIncidentReport,
  normalizeEvidenceSubmission,
  normalizeEvidenceKeys,
  parseActionValue,
  revisionsFor,
  slackEvidenceMenuSelection,
  storedEvidenceSnapshot,
  service: createHumanVerificationService(),
  validateSubmission,
};
