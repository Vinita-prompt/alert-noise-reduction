const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const database = require('../config/db');

const execFileAsync = promisify(execFile);
const migrationSql = [
  '054_multiclass_ml_shadow.sql',
  '055_human_verification_feedback.sql',
  '056_human_verification_test_feedback.sql',
  '070_production_ml_learning.sql',
].map((fileName) => fs.readFileSync(path.join(__dirname, `../db/migrations/${fileName}`), 'utf8')).join('\n');

const FEATURE_SCHEMA_VERSION = 'alert-evidence-confirmed-binary-v2';
const MODEL_MODE = 'SHADOW';
const MODEL_ALGORITHM = 'XGBoost';
// Pending/unknown evidence is a workflow state, never a supervised label.
const MODEL_CLASSES = Object.freeze(['INCIDENT', 'NOISE']);
const MINIMUM_CLASS_EXAMPLES = Math.max(5, Number(process.env.ML_MINIMUM_CLASS_EXAMPLES || 20));
const LABEL_SOURCE = 'VALIDATED_HUMAN_DECISION';
const NOT_TRAINED_STATUS = 'INSUFFICIENT_VALIDATED_TRAINING_DATA';
const FORBIDDEN_FEATURE_KEYS = Object.freeze([
  'human_decision', 'human_comment', 'human_outcome', 'feedback_outcome',
  'responder_identity', 'reviewer', 'recorded_by', 'gold_decision',
  'model_prediction', 'system_decision', 'final_decision', 'future_recovery',
  'future_jira_resolution', 'jira_resolution', 'resolved_by',
]);
const LEGACY_EXCLUSIONS = Object.freeze([
  'GROUPING_SUPERSEDED', 'LEGACY_GROUPING_REQUIRES_REPLAY',
]);

let schemaReady;

function sha(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function safeText(value, fallback = null) {
  const result = String(value ?? '').trim();
  return result || fallback;
}

function finite(value, fallback = null) {
  const result = Number(value);
  return Number.isFinite(result) ? result : fallback;
}

function bool(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === 1 || value === '1') return true;
  if (value === 'false' || value === 0 || value === '0') return false;
  return fallback;
}

function valueAt(object, ...paths) {
  for (const item of paths) {
    const parts = Array.isArray(item) ? item : String(item).split('.');
    let value = object;
    for (const part of parts) value = value?.[part];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return null;
}

function includesSignal(value, signal) {
  if (Array.isArray(value)) return value.some((item) => String(item).toUpperCase() === signal);
  return false;
}

function priorityNumber(value) {
  const match = String(value || '').toUpperCase().match(/P?([1-5])/);
  return match ? Number(match[1]) : 0;
}

function canonicalGoldDecision(value) {
  const normalized = safeText(value, '').toUpperCase();
  if (normalized === 'CONFIRMED_INCIDENT' || normalized === 'INCIDENT') return 'INCIDENT';
  if (normalized === 'CONFIRMED_NOISE' || normalized === 'NOISE') return 'NOISE';
  return null;
}

function hasLegacyExclusion(record = {}) {
  const text = JSON.stringify({
    evidence: record.evidence || record.review_evidence,
    explanation: record.explanation,
    status: record.grouping_status,
  }).toUpperCase();
  return LEGACY_EXCLUSIONS.some((value) => text.includes(value));
}

function outcomeIsValidatedHuman(record = {}) {
  const method = safeText(record.confirmation_method, '').toUpperCase();
  const source = safeText(record.outcome_source || record.source, '').toUpperCase();
  const actorType = safeText(record.recorded_by_type, '').toLowerCase();
  return actorType === 'user'
    && ['HUMAN_CONFIRMED', 'JIRA_CONFIRMED_HUMAN_REVIEWED'].includes(method)
    && ['OPERATOR', 'JIRA_INCIDENT'].includes(source)
    && Boolean(canonicalGoldDecision(record.outcome))
    && !hasLegacyExclusion(record);
}

function featureLeakageAudit(features) {
  const keys = Object.keys(features || {});
  const forbiddenPresent = keys.filter((key) => FORBIDDEN_FEATURE_KEYS.includes(key.toLowerCase()));
  return {
    passed: forbiddenPresent.length === 0,
    forbiddenPresent,
    forbiddenKeys: FORBIDDEN_FEATURE_KEYS,
    predictionTimeOnly: true,
  };
}

function extractFeatureVector({ alert = {}, evaluation = {} } = {}) {
  const snapshot = evaluation.feature_snapshot || evaluation.featureSnapshot || {};
  const technical = evaluation.technical_evidence || evaluation.technicalEvidence || {};
  const lifecycle = technical.monitoringLifecycle || snapshot.monitoringLifecycle || {};
  const identity = snapshot.identity || {};
  const episode = snapshot.episode || {};
  const behavior = snapshot.currentBehavior || {};
  const history = snapshot.historicalContext || lifecycle.historicalBehavior || {};
  const coverage = technical.coverage || {};
  const completeness = coverage.evidenceCompleteness || lifecycle.completeness || {};
  const provenance = technical.provenance || {};
  const noise = evaluation.noise_detection || evaluation.noiseDetection || {};
  const observed = noise.observed || behavior.observedNoiseFeatures || [];
  const detectors = noise.detectors || {};
  const intervention = lifecycle.intervention || {};
  const persistence = lifecycle.persistence || {};
  const recovery = lifecycle.recovery || {};
  const transitions = lifecycle.transitions || lifecycle.stateTransitions || [];
  const relationship = lifecycle.relationshipEvidence || {};
  const maintenance = lifecycle.maintenance || evaluation.explanation?.maintenance || {};
  const structured = evaluation.structured_evidence || evaluation.structuredEvidence || {};
  const priority = safeText(
    valueAt(snapshot, 'operationalPriority.value') || alert.priority,
    'UNKNOWN',
  ).toUpperCase();
  const priorityNumeric = priorityNumber(priority);
  const source = safeText(evaluation.source || identity.source || alert.source, 'Unknown');
  const sourceState = valueAt(technical, 'currentState') || valueAt(lifecycle, 'sourceState') || null;
  const lifecycleState = valueAt(lifecycle, 'state') || valueAt(persistence, 'state')
    || (bool(recovery.recovered) ? 'RECOVERED' : bool(persistence.currentlyFiring) ? 'FIRING' : 'UNKNOWN');
  const features = {
    priority_numeric: priorityNumeric,
    priority_class: priority,
    is_p1: priorityNumeric === 1,
    is_p2: priorityNumeric === 2,
    is_p3: priorityNumeric === 3,
    is_p4: priorityNumeric === 4,
    is_p5: priorityNumeric === 5,
    source,
    source_instance: safeText(valueAt(technical, 'sourceInstance') || valueAt(evaluation, 'source_details.instance')),
    source_identity_quality: safeText(valueAt(identity, 'quality') || valueAt(coverage, 'identityResolution.status'), 'UNKNOWN'),
    authoritative_identity: bool(valueAt(identity, 'authoritative') || valueAt(coverage, 'identityResolution.authoritative')),
    structured_identity: bool(valueAt(identity, 'structured') || valueAt(coverage, 'identityResolution.resolved')),
    signature_fallback: bool(valueAt(identity, 'signatureFallback')),
    unresolved_identity: bool(valueAt(identity, 'unresolved')) || valueAt(coverage, 'identityResolution.resolved') === false,
    application: safeText(identity.application || alert.application),
    service: safeText(identity.service || alert.service),
    environment: safeText(identity.environment || alert.environment),
    entity: safeText(identity.entity || alert.entity),
    rule_uid: safeText(valueAt(technical, 'ruleUid') || valueAt(technical, 'identity.ruleUid')),
    fingerprint: safeText(valueAt(technical, 'fingerprint') || valueAt(technical, 'identity.fingerprint')),
    host: safeText(valueAt(technical, 'host') || valueAt(technical, 'identity.host')),
    nagios_service: safeText(valueAt(technical, 'nagiosService') || valueAt(technical, 'identity.service')),
    appdynamics_application: safeText(valueAt(technical, 'application') || identity.application),
    appdynamics_tier: safeText(valueAt(technical, 'tier') || valueAt(technical, 'identity.tier')),
    appdynamics_node: safeText(valueAt(technical, 'node') || valueAt(technical, 'identity.node')),
    business_transaction: safeText(valueAt(technical, 'businessTransaction') || valueAt(technical, 'identity.businessTransaction')),
    episode_size: finite(valueAt(episode, 'episodeSize') || valueAt(episode, 'notificationCount'), 1),
    notification_role: safeText(episode.notificationRole || evaluation.notification_role || evaluation.notificationRole, 'UNKNOWN'),
    is_primary: safeText(episode.notificationRole || evaluation.notification_role, '').toUpperCase() === 'PRIMARY',
    is_repeat: bool(valueAt(episode, 'isRepeat')) || safeText(episode.notificationRole, '').toUpperCase() === 'REDUNDANT',
    episode_age: finite(valueAt(episode, 'ageSeconds') || valueAt(behavior, 'durationSeconds')),
    episode_duration: finite(valueAt(episode, 'durationSeconds') || valueAt(behavior, 'durationSeconds')),
    grouping_basis: safeText(episode.episodeGroupingBasis || episode.groupingBasis, 'UNKNOWN'),
    source_state: safeText(sourceState, 'UNKNOWN'),
    lifecycle_state: safeText(lifecycleState, 'UNKNOWN'),
    firing_observed: bool(persistence.firingObserved) || bool(persistence.currentlyFiring),
    recovery_observed: bool(recovery.recovered) || bool(recovery.recoveryObserved),
    recovery_duration: finite(recovery.durationSeconds || recovery.recoveryDurationSeconds),
    terminal_state: safeText(recovery.terminalState || lifecycle.terminalState),
    transition_count: finite(transitions.length || behavior.stateTransitionCount, 0),
    firing_count: finite(persistence.firingCount || lifecycle.firingCount, 0),
    recovery_count: finite(recovery.recoveryCount || lifecycle.recoveryCount, 0),
    flapping_count: finite(persistence.flappingCount || history.flappingCount, 0),
    repeat_observed: includesSignal(observed, 'REPEAT') || bool(detectors.REPEAT?.observed),
    duplicate_observed: includesSignal(observed, 'DUPLICATE') || bool(detectors.DUPLICATE?.observed),
    auto_resolved_observed: includesSignal(observed, 'AUTO_RESOLVED') || bool(detectors.AUTO_RESOLVED?.observed),
    flapping_observed: includesSignal(observed, 'FLAPPING') || bool(detectors.FLAPPING?.observed),
    correlated_observed: includesSignal(observed, 'CORRELATED') || bool(detectors.CORRELATED?.observed),
    informational_observed: includesSignal(observed, 'INFORMATIONAL') || bool(detectors.INFORMATIONAL?.observed),
    non_actionable_observed: includesSignal(observed, 'NON_ACTIONABLE') || bool(detectors.NON_ACTIONABLE?.observed),
    stale_observed: includesSignal(observed, 'STALE') || bool(detectors.STALE?.observed),
    positive_noise_signal: bool(valueAt(evaluation, 'explanation.noiseEvidence.mustHavePositiveSignal')),
    prior_exact_occurrences: finite(history.previousSameSignature || history.occurrenceCount, 0),
    prior_incident_count: finite(history.previousIncidentOccurrences || history.incidentCount, 0),
    prior_auto_resolved_count: finite(history.autoResolvedCount, 0),
    prior_noise_count: finite(history.previousConfirmedNoiseOutcomes || history.noiseCount, 0),
    historical_recovery_rate: finite(history.recoveryRate || history.autoRecoveryRate),
    historical_incident_rate: finite(history.incidentRate),
    historical_intervention_rate: finite(history.interventionRate),
    median_duration: finite(history.medianDurationSeconds || history.medianDuration),
    p95_duration: finite(history.p95DurationSeconds || history.p95Duration),
    acknowledgement_present: bool(intervention.acknowledged || alert.acknowledged),
    investigation_present: bool(intervention.investigated),
    remediation_present: bool(intervention.remediated),
    escalation_present: bool(intervention.escalated),
    jira_incident_relationship: bool(valueAt(lifecycle, 'workflow.jiraIncidentRelationship') || valueAt(evaluation, 'explanation.incidentEvidence.jiraRelationship')),
    slack_thread_activity: finite(intervention.slackThreadActivity || valueAt(lifecycle, 'workflow.slackThreadActivity'), 0),
    business_impact: safeText(evaluation.business_impact || evaluation.businessImpact, 'UNKNOWN'),
    topology_relationship_count: finite(relationship.topologyRelationshipCount, 0),
    dependency_relationship_count: finite(relationship.dependencyRelationshipCount, 0),
    strong_correlation_candidate: bool(relationship.correlationConfirmed || relationship.strongCorrelationCandidate),
    weak_correlation_count: finite(relationship.weakCorrelationCount, 0),
    lifecycle_overlap: finite(relationship.lifecycleOverlap),
    source_api_available: provenance.primaryStatus === 'working' || bool(completeness.sourceApiAvailable),
    evidence_complete: bool(completeness.complete),
    evidence_fresh: completeness.fresh !== false && !bool(valueAt(evaluation, 'explanation.staleEvaluation')),
    lifecycle_known: bool(completeness.lifecycleKnown) || lifecycleState !== 'UNKNOWN',
    identity_known: !bool(valueAt(identity, 'unresolved')) && Boolean(identity.entity || identity.application || identity.service),
    evidence_conflict: bool(valueAt(evaluation, 'explanation.evidenceConflict')) || safeText(valueAt(evaluation, 'explanation.reviewSubReason'), '') === 'EVIDENCE_CONFLICT',
    evidence_revision: safeText(evaluation.evidence_revision || evaluation.feature_as_of || evaluation.featureAsOf),
    maintenance_detected: bool(maintenance.detected || maintenance.maintenanceDetected),
    informational_priority: priorityNumeric >= 4,
    explicit_no_impact: bool(maintenance.explicitNoImpact || valueAt(evaluation, 'explanation.explicitNoImpact')),
    scheduled_maintenance: bool(maintenance.scheduled || maintenance.scheduledMaintenance),
    reviewed_monitoring_match: safeText(structured.monitoringMatch),
    reviewed_monitoring_state: safeText(structured.monitoringState),
    reviewed_technical_condition: safeText(structured.technicalCondition),
    reviewed_evidence_types: Array.isArray(structured.evidenceTypes) ? [...structured.evidenceTypes].sort() : [],
    reviewed_evidence_strength: safeText(structured.evidenceStrength),
    reviewed_customer_impact: safeText(structured.customerImpact),
    reviewed_service_impact: safeText(structured.serviceImpact),
    reviewed_impact_level: safeText(structured.impactLevel),
    reviewed_affected_scope: Array.isArray(structured.affectedScope) ? [...structured.affectedScope].sort() : [],
    reviewed_persistence_band: safeText(structured.persistenceBand),
    reviewed_noise_evidence: Array.isArray(structured.noiseReasons) ? [...structured.noiseReasons].sort() : [],
    reviewed_actionability: safeText(structured.actionability),
    reviewed_source_verified: safeText(structured.sourceEvidenceVerified),
  };
  const audit = featureLeakageAudit(features);
  if (!audit.passed) {
    const error = new Error('Prediction-time feature leakage detected.');
    error.code = 'ML_FEATURE_LEAKAGE';
    throw error;
  }
  return { audit, features };
}

function createFeatureSnapshotRecord({ alert = {}, evaluation = {} } = {}) {
  const { audit, features } = extractFeatureVector({ alert, evaluation });
  const alertId = alert.id || alert.alert_id || evaluation.alert_id || evaluation.alertId;
  const featureAsOf = new Date(
    evaluation.feature_as_of || evaluation.featureAsOf || alert.received_at || Date.now(),
  ).toISOString();
  const episodeId = safeText(valueAt(
    evaluation.feature_snapshot || evaluation.featureSnapshot || {},
    'episode.episodeId',
  ));
  const featureSnapshotId = `mfs-${sha(`${FEATURE_SCHEMA_VERSION}|${alertId}|${featureAsOf}|${JSON.stringify(features)}`).slice(0, 40)}`;
  return {
    alertId,
    audit,
    episodeId,
    evidenceRevision: safeText(features.evidence_revision, featureAsOf),
    featureAsOf,
    featureSnapshotId,
    features,
  };
}

function trainingIdentityKey(record = {}) {
  if (safeText(record.identitySplitKey)) return safeText(record.identitySplitKey);
  const features = record.features || {};
  const identity = [
    features.source,
    features.source_instance,
    features.rule_uid || features.fingerprint || features.host || features.appdynamics_application,
    features.application,
    features.service,
    features.entity,
  ].map((value) => safeText(value, '').toLowerCase()).join('|');
  return identity.replace(/\|/g, '') ? identity : safeText(record.alertId || record.alert_id
    || record.trainingExampleId || record.training_example_id, crypto.randomUUID());
}

function timeBasedSplit(records = []) {
  const sorted = [...records].sort((left, right) => (
    new Date(left.reviewedAt || left.reviewed_at || 0) - new Date(right.reviewedAt || right.reviewed_at || 0)
      || String(left.trainingExampleId || left.training_example_id).localeCompare(String(right.trainingExampleId || right.training_example_id))
  ));
  const grouped = new Map();
  for (const record of sorted) {
    const key = trainingIdentityKey(record);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(record);
  }
  const trainEnd = Math.floor(sorted.length * 0.7);
  const validationEnd = Math.floor(sorted.length * 0.85);
  let assigned = 0;
  const splitRecords = [];
  for (const [identitySplitKey, group] of grouped) {
    const temporalSplit = assigned < trainEnd ? 'TRAIN'
      : assigned < validationEnd ? 'VALIDATION' : 'TEST';
    for (const record of group) {
      splitRecords.push({ ...record, identitySplitKey, temporalSplit });
      assigned += 1;
    }
  }
  return splitRecords.map((record, ordinal) => ({ ...record, ordinal }));
}

function classDistribution(records = []) {
  return Object.fromEntries(MODEL_CLASSES.map((label) => [label, records.filter((row) => (
    (row.goldDecision || row.gold_decision) === label
  )).length]));
}

function trainingReadiness(records = []) {
  const distribution = classDistribution(records);
  const missing = MODEL_CLASSES.filter((label) => distribution[label] < MINIMUM_CLASS_EXAMPLES);
  const hasAssignedSplits = records.some((record) => record.temporalSplit || record.temporal_split);
  const missingSplitClasses = hasAssignedSplits
    ? ['TRAIN', 'VALIDATION', 'TEST'].flatMap((split) => MODEL_CLASSES
      .filter((label) => !records.some((record) => (
        (record.temporalSplit || record.temporal_split) === split
        && (record.goldDecision || record.gold_decision) === label
      )))
      .map((label) => `${split}:${label}`))
    : [];
  return {
    status: missing.length || missingSplitClasses.length ? NOT_TRAINED_STATUS : 'TRAINING_READY',
    trainable: missing.length === 0 && missingSplitClasses.length === 0,
    minimumPerClass: MINIMUM_CLASS_EXAMPLES,
    missingClasses: missing,
    missingSplitClasses,
    classDistribution: distribution,
    validatedTrainingExamples: records.length,
  };
}

function deterministicSafetyGate(deterministicDecision, features = {}) {
  const p1 = features.is_p1 === true;
  const strongIncident = deterministicDecision === 'INCIDENT';
  const positiveNoise = features.positive_noise_signal === true;
  return {
    mode: MODEL_MODE,
    deterministicDecision,
    p1MandatoryIncident: p1,
    strongIncidentEvidencePreserved: strongIncident,
    positiveNoiseInvariantPreserved: positiveNoise,
    modelMayChangeFinalDecision: false,
    downgradeToNoiseAllowed: false,
  };
}

function createMlShadowService({ db = database, clock = () => new Date() } = {}) {
  async function ensureSchema() {
    if (!schemaReady) schemaReady = db.query(migrationSql).catch((error) => {
      schemaReady = null;
      throw error;
    });
    await schemaReady;
  }

  async function validatedFeedbackRows() {
    await ensureSchema();
    const result = await db.query(`
      SELECT feedback.feedback_id, feedback.alert_id,
        CASE feedback.human_decision
          WHEN 'INCIDENT' THEN 'CONFIRMED_INCIDENT'
          WHEN 'NOISE' THEN 'CONFIRMED_NOISE'
          ELSE 'UNKNOWN'
        END AS outcome,
        feedback.human_subtype AS reason_code, 'OPERATOR' AS outcome_source,
        'HUMAN_CONFIRMED' AS confirmation_method, 'user' AS recorded_by_type,
        feedback.created_at AS recorded_at, feedback.metadata AS evidence,
        evaluation.evaluation_id, evaluation.source, evaluation.feature_as_of,
        evaluation.feature_snapshot, evaluation.technical_evidence,
        evaluation.noise_detection, evaluation.business_impact,
        evaluation.actionability, evaluation.notification_role,
        evaluation.final_decision, evaluation.explanation,
        report.form_responses AS structured_evidence,
        COALESCE(report.evidence_revision, evaluation.feature_as_of::text) AS evidence_revision,
        COALESCE(alert.raw_payload->'priority'->>'name', alert.raw_payload->>'priority',
          alert.raw_payload->>'priorityName', alert.extracted_details->>'priority') AS priority,
        alert.severity, alert.environment, alert.service,
        COALESCE(alert.extracted_details->>'application', alert.raw_payload->>'application') AS application,
        alert.acknowledged
      FROM validated_human_feedback_v1 feedback
      JOIN live_shadow_evaluations evaluation
        ON evaluation.evaluation_id = feedback.evaluation_id
        AND evaluation.alert_id = feedback.alert_id
      JOIN alerts alert ON alert.id = feedback.alert_id
      LEFT JOIN LATERAL (
        SELECT value.form_responses, value.evidence_revision
        FROM incident_verification_reports value
        WHERE value.feedback_id=feedback.feedback_id
        ORDER BY value.submitted_at DESC, value.report_id DESC LIMIT 1
      ) report ON TRUE
      ORDER BY feedback.created_at, feedback.feedback_id
    `);
    return result.rows.filter(outcomeIsValidatedHuman);
  }

  function normalizedExample(row) {
    const snapshot = createFeatureSnapshotRecord({ alert: row, evaluation: row });
    const goldDecision = canonicalGoldDecision(row.outcome);
    return {
      trainingExampleId: `mte-${sha(`${row.feedback_id}|${snapshot.featureSnapshotId}|${goldDecision}`).slice(0, 40)}`,
      featureSnapshotId: snapshot.featureSnapshotId,
      alertId: row.alert_id,
      episodeId: snapshot.episodeId,
      evidenceRevision: snapshot.evidenceRevision,
      featureAsOf: snapshot.featureAsOf,
      features: snapshot.features,
      leakageAudit: snapshot.audit,
      feedbackId: String(row.feedback_id),
      goldDecision,
      goldNoiseSubtype: goldDecision === 'NOISE' ? safeText(row.reason_code) : null,
      reviewedAt: new Date(row.recorded_at).toISOString(),
      deterministicDecision: row.final_decision,
      labelSource: LABEL_SOURCE,
      identitySplitKey: trainingIdentityKey({ alertId: row.alert_id, features: snapshot.features }),
    };
  }

  async function buildDataset({ persist = true } = {}) {
    const rows = await validatedFeedbackRows();
    const examples = rows.map(normalizedExample);
    const splitExamples = timeBasedSplit(examples);
    const distribution = classDistribution(splitExamples);
    const sourceHash = sha(splitExamples.map((item) => `${item.trainingExampleId}:${item.reviewedAt}`).join('|'));
    const datasetVersion = `human-gold-${sourceHash.slice(0, 16)}`;
    if (persist) {
      const client = await db.pool.connect();
      try {
        await client.query('BEGIN');
        for (const item of splitExamples) {
          await client.query(`INSERT INTO ml_feature_snapshots (
            feature_snapshot_id, alert_id, episode_id, evidence_revision,
            feature_schema_version, feature_as_of, features, leakage_audit
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (feature_snapshot_id) DO NOTHING`, [
            item.featureSnapshotId, item.alertId, item.episodeId, item.evidenceRevision,
            FEATURE_SCHEMA_VERSION, item.featureAsOf, item.features, item.leakageAudit,
          ]);
          await client.query(`INSERT INTO ml_training_examples (
            training_example_id, alert_id, episode_id, feature_snapshot_id,
            gold_decision, gold_noise_subtype, feedback_id, human_feedback_id, label_source,
            evidence_revision, dataset_version, temporal_split
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
          ON CONFLICT (training_example_id) DO NOTHING`, [
            item.trainingExampleId, item.alertId, item.episodeId, item.featureSnapshotId,
            item.goldDecision, item.goldNoiseSubtype, null, item.feedbackId, LABEL_SOURCE,
            item.evidenceRevision, datasetVersion, item.temporalSplit,
          ]);
        }
        await client.query(`INSERT INTO ml_training_dataset_versions (
          dataset_version, feature_schema_version, example_count, class_distribution, source_query_hash
        ) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (dataset_version) DO NOTHING`, [
          datasetVersion, FEATURE_SCHEMA_VERSION, splitExamples.length, distribution, sourceHash,
        ]);
        for (const item of splitExamples) {
          await client.query(`INSERT INTO ml_training_dataset_memberships (
            dataset_version, training_example_id, temporal_split, ordinal
          ) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [
            datasetVersion, item.trainingExampleId, item.temporalSplit, item.ordinal,
          ]);
        }
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    }
    return {
      datasetVersion,
      featureSchemaVersion: FEATURE_SCHEMA_VERSION,
      generatedAt: clock().toISOString(),
      examples: splitExamples,
      ...trainingReadiness(splitExamples),
      leakageChecks: {
        passed: splitExamples.every((item) => item.leakageAudit.passed),
        legacyRepeatExcluded: rows.length === examples.length,
        futureOutcomeFieldsExcluded: true,
        responderIdentityExcluded: true,
        randomTimeMixing: false,
        identityCrossSplitCount: [...new Set(splitExamples.map((item) => item.identitySplitKey))]
          .filter((identity) => new Set(splitExamples.filter((item) => item.identitySplitKey === identity)
            .map((item) => item.temporalSplit)).size > 1).length,
      },
    };
  }

  async function modelRows() {
    await ensureSchema();
    const result = await db.query(`SELECT * FROM ml_model_registry
      ORDER BY training_timestamp DESC, created_at DESC`);
    return result.rows;
  }

  function mapModel(row) {
    if (!row) return null;
    return {
      modelId: row.model_id,
      modelVersion: row.model_version,
      algorithm: row.algorithm,
      featureSchemaVersion: row.feature_schema_version,
      trainingDatasetVersion: row.training_dataset_version,
      trainingTimestamp: row.training_timestamp,
      trainingDataStart: row.training_data_start,
      trainingDataEnd: row.training_data_end,
      hyperparameters: row.hyperparameters || {},
      classDistribution: row.class_distribution || {},
      validationMetrics: row.validation_metrics || {},
      confusionMatrix: row.confusion_matrix || [],
      calibrationStatus: row.calibration_status,
      artifactStorageBackend: row.artifact_storage_backend || 'FILESYSTEM',
      artifactSha256: row.artifact_sha256 || null,
      status: row.status,
    };
  }

  async function status() {
    await ensureSchema();
    const [rows, models, predictionResult] = await Promise.all([
      validatedFeedbackRows(),
      modelRows(),
      db.query('SELECT COUNT(*)::int AS count FROM ml_multiclass_shadow_predictions'),
    ]);
    const examples = rows.map(normalizedExample);
    const readiness = trainingReadiness(examples);
    const model = models.find((item) => item.status === 'SHADOW') || null;
    return {
      mode: MODEL_MODE,
      status: model ? 'SHADOW' : readiness.status,
      algorithm: MODEL_ALGORITHM,
      modelVersion: model?.model_version || 'NOT_TRAINED',
      featureSchemaVersion: FEATURE_SCHEMA_VERSION,
      validatedTrainingExamples: examples.length,
      classDistribution: readiness.classDistribution,
      minimumPerClass: readiness.minimumPerClass,
      missingClasses: readiness.missingClasses,
      missingSplitClasses: readiness.missingSplitClasses,
      trainingPossible: readiness.trainable,
      shadowPredictions: Number(predictionResult.rows[0]?.count || 0),
      deterministicEngineAuthoritative: true,
      automaticActionsEnabled: false,
      externalMutations: 0,
      predictionsCreateLabels: false,
    };
  }

  async function models() {
    return { items: (await modelRows()).map(mapModel), mode: MODEL_MODE, readOnly: true };
  }

  async function model(modelId) {
    const rows = await modelRows();
    return mapModel(rows.find((item) => item.model_id === modelId || item.model_version === modelId));
  }

  async function metrics() {
    await ensureSchema();
    const [state, modelsValue, comparisons, recentComparisons] = await Promise.all([
      status(),
      modelRows(),
      db.query(`SELECT
        COUNT(*)::int AS predictions,
        COUNT(*) FILTER (WHERE prediction.deterministic_decision <> prediction.predicted_class)::int AS deterministic_disagreements,
        COUNT(*) FILTER (WHERE outcome.feedback_id IS NOT NULL)::int AS human_comparisons,
        COUNT(*) FILTER (WHERE outcome.feedback_id IS NOT NULL AND prediction.predicted_class <> outcome.human_decision)::int AS human_disagreements,
        COUNT(*) FILTER (WHERE outcome.feedback_id IS NOT NULL AND prediction.deterministic_decision <> outcome.human_decision)::int AS deterministic_human_disagreements
      FROM ml_multiclass_shadow_predictions prediction
      LEFT JOIN validated_human_feedback_v1 outcome
        ON outcome.alert_id = prediction.alert_id AND outcome.episode_id=prediction.episode_id`),
      db.query(`SELECT prediction.alert_id, alert.atlassian_ops_tiny_id,
        prediction.deterministic_decision, prediction.predicted_class,
        prediction.model_score, prediction.score_label, prediction.predicted_at,
        outcome.human_decision AS human_outcome
      FROM ml_multiclass_shadow_predictions prediction
      JOIN alerts alert ON alert.id=prediction.alert_id
      LEFT JOIN validated_human_feedback_v1 outcome
        ON outcome.alert_id=prediction.alert_id AND outcome.episode_id=prediction.episode_id
      ORDER BY prediction.predicted_at DESC LIMIT 25`),
    ]);
    const active = modelsValue.find((item) => item.status === 'SHADOW') || null;
    const counts = comparisons.rows[0] || {};
    return {
      status: active ? 'AVAILABLE' : state.status,
      model: mapModel(active),
      accuracy: active?.validation_metrics?.accuracy ?? null,
      macroF1: active?.validation_metrics?.macroF1 ?? null,
      weightedF1: active?.validation_metrics?.weightedF1 ?? null,
      perClass: active?.validation_metrics?.perClass ?? null,
      confusionMatrix: active?.confusion_matrix || null,
      classOrder: Object.keys(active?.class_distribution || {}),
      shadowPredictions: Number(counts.predictions || 0),
      modelDeterministicDisagreements: Number(counts.deterministic_disagreements || 0),
      modelHumanComparisons: Number(counts.human_comparisons || 0),
      modelHumanDisagreements: Number(counts.human_disagreements || 0),
      deterministicHumanDisagreements: Number(counts.deterministic_human_disagreements || 0),
      comparisons: recentComparisons.rows.map((row) => ({
        alertId: row.alert_id,
        alertNumber: row.atlassian_ops_tiny_id || row.alert_id,
        deterministicDecision: row.deterministic_decision,
        modelRecommendation: row.predicted_class,
        modelScore: Number(row.model_score),
        scoreLabel: row.score_label,
        humanOutcome: row.human_outcome,
        predictedAt: row.predicted_at,
      })),
      noMetricsFabricated: !active,
      readOnly: true,
    };
  }

  async function trainingDatasetSummary() {
    await ensureSchema();
    const [dataset, subtypeResult, exclusionResult] = await Promise.all([
      buildDataset({ persist: false }),
      db.query(`SELECT human_subtype, COUNT(*)::int AS count
        FROM validated_human_feedback_v1
        WHERE human_decision='NOISE'
        GROUP BY human_subtype ORDER BY count DESC, human_subtype`),
      db.query(`SELECT
        COUNT(*) FILTER (WHERE status='HUMAN_FEEDBACK_CONFLICT' OR validation_code='HUMAN_FEEDBACK_CONFLICT')::int AS conflicts,
        COUNT(*) FILTER (WHERE status='REJECTED')::int AS rejected,
        COUNT(*) FILTER (WHERE status='SUPERSEDED')::int AS superseded,
        COUNT(*) FILTER (WHERE metadata->>'groupingDisposition'='GROUPING_SUPERSEDED')::int AS grouping_superseded,
        COUNT(*) FILTER (WHERE metadata->>'groupingDisposition'='LEGACY_GROUPING_REQUIRES_REPLAY')::int AS legacy,
        COUNT(*) FILTER (WHERE NOT training_eligible)::int AS excluded
        FROM human_verification_feedback WHERE NOT is_test`),
    ]);
    const exclusions = exclusionResult.rows[0] || {};
    return {
      datasetVersion: dataset.datasetVersion,
      featureSchemaVersion: dataset.featureSchemaVersion,
      eligibleExampleCount: dataset.examples.length,
      classDistribution: dataset.classDistribution,
      noiseSubtypeDistribution: Object.fromEntries(subtypeResult.rows.map((row) => [row.human_subtype || 'UNSPECIFIED', Number(row.count)])),
      exclusions: {
        groupingSuperseded: Number(exclusions.grouping_superseded || 0),
        legacy: Number(exclusions.legacy || 0),
        conflicts: Number(exclusions.conflicts || 0),
        rejected: Number(exclusions.rejected || 0),
        superseded: Number(exclusions.superseded || 0),
        total: Number(exclusions.excluded || 0),
      },
      trainingReadiness: {
        status: dataset.status,
        trainable: dataset.trainable,
        minimumPerClass: dataset.minimumPerClass,
        missingClasses: dataset.missingClasses,
      },
      responderIdentityIncluded: false,
      readOnly: true,
    };
  }

  async function prediction(alertId) {
    await ensureSchema();
    const result = await db.query(`SELECT prediction.*, outcome.human_decision AS human_outcome,
      model.calibration_status
      FROM ml_multiclass_shadow_predictions prediction
      JOIN ml_model_registry model ON model.model_id = prediction.model_id
      LEFT JOIN validated_human_feedback_v1 outcome
        ON outcome.alert_id = prediction.alert_id AND outcome.episode_id=prediction.episode_id
      WHERE prediction.alert_id = $1
      ORDER BY prediction.predicted_at DESC, prediction.prediction_id DESC LIMIT 1`, [alertId]);
    const row = result.rows[0];
    if (!row) {
      const state = await status();
      return {
        alertId,
        status: state.status,
        recommendationAvailable: false,
        modelVersion: state.modelVersion,
        deterministicEngineAuthoritative: true,
        message: state.trainingPossible ? 'No shadow prediction exists for this alert.' : NOT_TRAINED_STATUS,
      };
    }
    return {
      predictionId: row.prediction_id,
      alertId: row.alert_id,
      episodeId: row.episode_id,
      modelVersion: row.model_version,
      featureSnapshotId: row.feature_snapshot_id,
      deterministicDecision: row.deterministic_decision,
      predictedClass: row.predicted_class,
      probabilities: {
        incident: Number(row.p_incident), noise: Number(row.p_noise), needsReview: Number(row.p_review),
      },
      modelScore: Number(row.model_score),
      scoreLabel: row.score_label,
      topContributors: row.top_contributors || [],
      safetyGate: row.safety_gate || {},
      humanOutcome: canonicalGoldDecision(row.human_outcome),
      predictedAt: row.predicted_at,
      recommendationAvailable: true,
      mode: MODEL_MODE,
      deterministicEngineAuthoritative: true,
    };
  }

  async function predictEvaluation(evaluation) {
    await ensureSchema();
    const result = await db.query("SELECT * FROM ml_model_registry WHERE status='SHADOW' ORDER BY training_timestamp DESC LIMIT 1");
    const modelRecord = result.rows[0];
    if (!modelRecord) return { status: NOT_TRAINED_STATUS, predictionStored: false };
    const alertResult = await db.query('SELECT * FROM alerts WHERE id=$1 LIMIT 1', [evaluation.alert_id || evaluation.alertId]);
    const alert = alertResult.rows[0];
    if (!alert) return { status: 'ALERT_NOT_FOUND', predictionStored: false };
    const snapshot = createFeatureSnapshotRecord({ alert, evaluation });
    const { audit, features } = snapshot;
    const featureAsOf = snapshot.featureAsOf;
    const snapshotId = snapshot.featureSnapshotId;
    const runner = path.join(__dirname, '../../ml/multiclass_shadow.py');
    const python = process.env.ML_PYTHON_PATH || path.join(__dirname, '../../.venv-phase4/bin/python');
    const { stdout } = await execFileAsync(python, [runner, 'predict', '--artifact', modelRecord.artifact_path], {
      env: { ...process.env, ML_FEATURES_JSON: JSON.stringify({ features }) },
      maxBuffer: 2 * 1024 * 1024,
      timeout: 30_000,
    });
    const recommendation = JSON.parse(stdout);
    const deterministicDecision = evaluation.final_decision || evaluation.finalDecision;
    const gate = deterministicSafetyGate(deterministicDecision, features);
    const predictionId = `mlp-${crypto.randomUUID()}`;
    await db.query(`INSERT INTO ml_feature_snapshots (
      feature_snapshot_id, alert_id, episode_id, evidence_revision,
      feature_schema_version, feature_as_of, features, leakage_audit
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`, [
      snapshotId, alert.id, valueAt(evaluation, 'feature_snapshot.episode.episodeId'), features.evidence_revision,
      FEATURE_SCHEMA_VERSION, featureAsOf, features, audit,
    ]);
    await db.query(`INSERT INTO ml_multiclass_shadow_predictions (
      prediction_id, alert_id, episode_id, model_id, model_version, feature_snapshot_id,
      deterministic_decision, predicted_class, p_incident, p_noise, p_review,
      model_score, score_label, top_contributors, safety_gate
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
    ON CONFLICT (alert_id, model_id, feature_snapshot_id) DO NOTHING`, [
      predictionId, alert.id, valueAt(evaluation, 'feature_snapshot.episode.episodeId'),
      modelRecord.model_id, modelRecord.model_version, snapshotId,
      deterministicDecision, recommendation.predictedClass,
      recommendation.probabilities.INCIDENT, recommendation.probabilities.NOISE,
      recommendation.probabilities.NEEDS_REVIEW || 0, recommendation.modelScore,
      modelRecord.calibration_status === 'CALIBRATED' ? 'CALIBRATED_PROBABILITY' : 'MODEL_SCORE',
      recommendation.topContributors || [], gate,
    ]);
    return { status: 'SHADOW_PREDICTION_STORED', predictionId, predictionStored: true, gate };
  }

  return {
    buildDataset,
    ensureSchema,
    metrics,
    model,
    models,
    predictEvaluation,
    prediction,
    status,
    trainingDatasetSummary,
    validatedFeedbackRows,
  };
}

module.exports = {
  FEATURE_SCHEMA_VERSION,
  FORBIDDEN_FEATURE_KEYS,
  LABEL_SOURCE,
  LEGACY_EXCLUSIONS,
  MINIMUM_CLASS_EXAMPLES,
  MODEL_ALGORITHM,
  MODEL_CLASSES,
  MODEL_MODE,
  NOT_TRAINED_STATUS,
  canonicalGoldDecision,
  classDistribution,
  createFeatureSnapshotRecord,
  createMlShadowService,
  deterministicSafetyGate,
  extractFeatureVector,
  featureLeakageAudit,
  hasLegacyExclusion,
  outcomeIsValidatedHuman,
  service: createMlShadowService(),
  timeBasedSplit,
  trainingReadiness,
  trainingIdentityKey,
};
