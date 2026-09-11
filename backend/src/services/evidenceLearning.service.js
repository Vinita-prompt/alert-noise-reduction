const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const database = require('../config/db');
const { service: mlShadowService } = require('./mlShadow.service');
const {
  commandCenterAlertProjectionSql,
  commandCenterAlertSql,
} = require('./commandCenterEligibility.service');

const migrationSql = [
  '058_incident_verification_reports.sql',
  '059_evidence_collection.sql',
  '060_evidence_learning_workflow.sql',
  '065_capacity_and_search_indexes.sql',
  '066_pending_evidence_outcomes.sql',
  '067_production_live_and_evidence_history.sql',
].map((file) => fs.readFileSync(path.join(__dirname, `../db/migrations/${file}`), 'utf8')).join('\n');
const MODEL_VERSION = 'EVIDENCE_PATTERN_SHADOW_V1';
const VERIFIED_LABELS = new Set(['INCIDENT', 'NOISE']);
let schemaReady;

function clean(value, fallback = null) {
  const result = String(value ?? '').trim();
  return result || fallback;
}

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function truth(value) {
  if (typeof value === 'boolean') return value;
  const normalized = clean(value, '').toUpperCase();
  if (['YES', 'TRUE', 'RECOVERED', 'AUTO_RESOLVED'].includes(normalized)) return true;
  if (['NO', 'FALSE', 'FIRING', 'ACKNOWLEDGED'].includes(normalized)) return false;
  return null;
}

function durationSeconds(value) {
  if (value === null || value === undefined || value === '') return null;
  const direct = finite(value);
  if (direct !== null) return direct;
  const match = String(value).trim().match(/([0-9]+(?:\.[0-9]+)?)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d)\b/i);
  if (!match) return null;
  const multiplier = /^d/i.test(match[2]) ? 86400
    : /^h/i.test(match[2]) ? 3600
      : /^m/i.test(match[2]) ? 60 : 1;
  return Number(match[1]) * multiplier;
}

function completenessForResponses(responses = {}) {
  if (responses.schemaVersion === 'structured-evidence-v2') {
    const required = [
      responses.monitoringMatch, responses.monitoringState, responses.technicalCondition,
      Array.isArray(responses.evidenceTypes) && responses.evidenceTypes.length,
      responses.evidenceStrength, responses.customerImpact, responses.serviceImpact,
      responses.impactLevel, Array.isArray(responses.affectedScope) && responses.affectedScope.length,
      responses.persistenceBand, Array.isArray(responses.noiseReasons) && responses.noiseReasons.length,
      responses.actionability, responses.evidenceReviewed, responses.sourceEvidenceVerified,
      responses.decisionConfidence,
    ];
    const present = required.filter(Boolean).length;
    return present === required.length ? 'COMPLETE' : present > 0 ? 'PARTIAL' : 'MISSING';
  }
  const required = [
    responses.identityStatus,
    responses.lifecycleStatus,
    responses.whatIsHappening,
    responses.evidenceDescription,
    responses.decisionJustification,
  ];
  const present = required.filter((value) => clean(value)).length;
  if (present === required.length && responses.identityStatus === 'CONFIRMED') return 'COMPLETE';
  return present > 0 ? 'PARTIAL' : 'MISSING';
}

function identityKey(source, identity = {}, identifiers = {}) {
  return [
    clean(source, 'unknown').toLowerCase(),
    clean(identifiers.eventId || identifiers.ruleUid || identifiers.rule || identifiers.healthRule, ''),
    clean(identity.application, ''), clean(identity.service, ''), clean(identity.host || identity.node, ''),
  ].map((value) => String(value).toLowerCase()).join('|');
}

function datasetSplitFor(value) {
  const bucket = Number.parseInt(crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 8), 16) % 100;
  return bucket < 70 ? 'TRAIN' : bucket < 85 ? 'VALIDATION' : 'HOLDOUT';
}

function sourceProvenanceFromRow(row = {}) {
  const raw = row.raw_payload || {};
  const extracted = row.extracted_details || {};
  const evaluation = row.technical_evidence || {};
  const normalized = extracted.normalized_alert || {};
  const values = [];
  const add = (sourceSystem, evidenceKind, value, sourceTimestamp = null) => {
    if (value === null || value === undefined || value === ''
      || (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0)) return;
    values.push({ sourceSystem, evidenceKind, value, sourceTimestamp });
  };
  add('JSM_OPERATIONS', 'ALERT_LIFECYCLE', {
    status: row.alert_status || row.status || null,
    priority: row.priority || raw.priority?.name || raw.priority || null,
    acknowledged: row.acknowledged ?? null,
  }, row.received_at || null);
  add('SLACK', 'OPERATIONAL_CONTEXT', extracted.slack || extracted.slack_enrichment || null,
    extracted.slack?.timestamp || extracted.slack_enrichment?.timestamp || null);
  add('JIRA', 'INCIDENT_RELATIONSHIP', extracted.jira || (row.jira_ticket_id ? { issueKey: row.jira_ticket_id } : null),
    extracted.jira?.updated || extracted.jira?.created || null);
  add(clean(row.monitoring_source || row.source, 'MONITORING_SOURCE').toUpperCase(), 'TECHNICAL_EVIDENCE', {
    sourceIdentity: row.source_identity || evaluation.sourceIdentity || null,
    lifecycle: evaluation.monitoringLifecycle || evaluation.lifecycle || null,
    sourceDetails: evaluation.sourceDetails || null,
    normalizedIdentifiers: {
      eventId: normalized.event_id || raw.eventId || null,
      ruleUid: normalized.rule_uid || raw.ruleUID || null,
      fingerprint: normalized.fingerprint || raw.fingerprint || null,
    },
  }, row.feature_as_of || row.received_at || null);
  return values;
}

function structuredLearningRecord({ alert = {}, evaluation = {}, report = {}, provenance = [] } = {}) {
  const responses = report.form_responses || report.formResponses || {};
  const sourceSpecific = responses.sourceSpecific || {};
  const source = clean(evaluation.source || alert.monitoring_source || alert.source);
  const identity = {
    application: clean(sourceSpecific.application || responses.exactApplication || alert.application),
    service: clean(sourceSpecific.service || responses.service || alert.service),
    host: clean(sourceSpecific.host || responses.hostNode),
    node: clean(sourceSpecific.node),
    tier: clean(sourceSpecific.tier),
    businessTransaction: clean(sourceSpecific.businessTransaction || responses.businessTransaction),
  };
  const identifiers = {
    eventId: clean(sourceSpecific.eventId),
    ruleUid: clean(sourceSpecific.ruleUid),
    rule: clean(sourceSpecific.rule || responses.alertRule),
    healthRule: clean(sourceSpecific.healthRule),
    panel: clean(sourceSpecific.panel),
    metric: clean(sourceSpecific.metric || responses.metric),
  };
  const rawDecision = clean(report.evidence_outcome_status || report.outcomeStatus
    || report.human_decision || report.humanDecision, 'PENDING_EVIDENCE').toUpperCase();
  const decision = rawDecision === 'CONFIRMED_INCIDENT' ? 'INCIDENT'
    : rawDecision === 'CONFIRMED_NOISE' ? 'NOISE'
      : rawDecision === 'PENDING_EVIDENCE' ? 'PENDING_EVIDENCE' : rawDecision;
  const completeness = clean(report.evidence_completeness || report.evidenceCompleteness)
    || completenessForResponses(responses);
  const labelStatus = VERIFIED_LABELS.has(decision) ? 'VERIFIED' : 'UNLABELED';
  const trainingEligible = labelStatus === 'VERIFIED' && completeness === 'COMPLETE';
  const occurrenceCount = finite(responses.occurrenceCount);
  const key = identityKey(source, identity, identifiers);
  return {
    source,
    priority: clean(evaluation.priority || alert.priority),
    sourceIdentity: identity,
    alertState: clean(responses.monitoringState || sourceSpecific.alertState || sourceSpecific.state || responses.lifecycleStatus || alert.status),
    durationSeconds: durationSeconds(responses.duration),
    autoResolved: truth(responses.automaticallyResolved || responses.lifecycleStatus),
    duplicateCount: responses.noiseReasons?.includes('EXACT_DUPLICATE') || responses.evidenceCategory === 'DUPLICATE_ALERT' ? Math.max(1, occurrenceCount || 1) : 0,
    repeatCount: occurrenceCount === null ? null : Math.max(0, occurrenceCount - 1),
    flapping: responses.noiseReasons?.includes('FLAPPING') || responses.evidenceCategory === 'FLAPPING_ALERT' ? true : null,
    eventIdentifiers: identifiers,
    customerBusinessImpact: clean(responses.impactLevel || responses.customerImpact || responses.businessOperationalImpact || responses.customersExperiencing),
    actionTaken: clean(responses.actionability || responses.actionsTaken || responses.remediationPerformed),
    jiraOutcome: {
      links: Array.isArray(responses.jiraLinks) ? responses.jiraLinks : [],
      relationship: clean(responses.relatedJiraIncidents),
    },
    responder: clean(report.responder_team || report.responderTeam, 'Command Center'),
    resolutionMethod: clean(responses.monitoringState || responses.serviceRestoredBy || responses.recoveryConfirmation),
    evidenceCompleteness: completeness,
    humanDecision: decision,
    labelStatus,
    trainingEligible,
    trainingExclusionReason: trainingEligible ? null
      : decision === 'PENDING_EVIDENCE' || decision === 'NEEDS_REVIEW'
        ? 'PENDING_EVIDENCE_EXCLUDED' : 'EVIDENCE_INCOMPLETE',
    datasetSplit: datasetSplitFor(key),
    featureSnapshot: {
      source,
      priority: clean(evaluation.priority || alert.priority),
      identity,
      alertState: clean(responses.monitoringState || sourceSpecific.alertState || sourceSpecific.state || responses.lifecycleStatus),
      durationSeconds: durationSeconds(responses.duration),
      autoResolved: truth(responses.automaticallyResolved || responses.lifecycleStatus),
      duplicateCount: responses.noiseReasons?.includes('EXACT_DUPLICATE') || responses.evidenceCategory === 'DUPLICATE_ALERT' ? Math.max(1, occurrenceCount || 1) : 0,
      repeatCount: occurrenceCount === null ? null : Math.max(0, occurrenceCount - 1),
      flapping: responses.noiseReasons?.includes('FLAPPING') || responses.evidenceCategory === 'FLAPPING_ALERT' ? true : null,
      eventIdentifiers: identifiers,
      impactPresent: ['CONFIRMED', 'POSSIBLE'].includes(responses.customerImpact)
        || ['CONFIRMED', 'POSSIBLE'].includes(responses.serviceImpact)
        || Boolean(clean(responses.businessOperationalImpact || responses.customersExperiencing)),
      actionTaken: ['IMMEDIATE_ACTION_REQUIRED', 'FOLLOW_UP_ACTION_REQUIRED'].includes(responses.actionability)
        || Boolean(clean(responses.actionsTaken || responses.remediationPerformed)),
      structuredEvidence: {
        monitoringMatch: responses.monitoringMatch || null,
        monitoringState: responses.monitoringState || null,
        technicalCondition: responses.technicalCondition || null,
        evidenceTypes: responses.evidenceTypes || [],
        evidenceStrength: responses.evidenceStrength || null,
        customerImpact: responses.customerImpact || null,
        serviceImpact: responses.serviceImpact || null,
        impactLevel: responses.impactLevel || null,
        affectedScope: responses.affectedScope || [],
        persistenceBand: responses.persistenceBand || null,
        noiseReasons: responses.noiseReasons || [],
        actionability: responses.actionability || null,
        evidenceReviewed: responses.evidenceReviewed || null,
        sourceEvidenceVerified: responses.sourceEvidenceVerified || null,
        decisionConfidence: responses.decisionConfidence || null,
      },
      evidenceCompleteness: completeness,
      attachmentSignalUsed: false,
      predictionUsedAsLabel: false,
    },
    evidenceProvenance: provenance,
    identityKey: key,
  };
}

function patternRecommendation(current = {}, patterns = []) {
  const missingEvidence = [];
  if (current.evidenceCompleteness !== 'COMPLETE') missingEvidence.push('EVIDENCE_INCOMPLETE');
  if (!clean(current.source)) missingEvidence.push('SOURCE_MISSING');
  if (!clean(current.identityKey)) missingEvidence.push('SOURCE_IDENTITY_MISSING');
  const exact = patterns.filter((item) => item.labelStatus === 'VERIFIED'
    && item.identityKey === current.identityKey);
  const incident = exact.filter((item) => item.humanDecision === 'INCIDENT').length;
  const noise = exact.filter((item) => item.humanDecision === 'NOISE').length;
  const contradictory = incident > 0 && noise > 0;
  let recommendation = 'NEEDS_REVIEW';
  let confidence = null;
  if (!missingEvidence.length && exact.length >= 3 && !contradictory) {
    recommendation = incident ? 'INCIDENT' : noise ? 'NOISE' : 'NEEDS_REVIEW';
    confidence = exact.length ? Math.max(incident, noise) / exact.length : null;
  }
  return {
    modelVersion: MODEL_VERSION,
    recommendation,
    confidence,
    matchingEvidencePatterns: exact.slice(0, 10).map((item) => ({
      learningRecordId: item.learningRecordId,
      humanDecision: item.humanDecision,
      source: item.source,
      priority: item.priority,
      evidenceCompleteness: item.evidenceCompleteness,
    })),
    supportingEvidence: [
      exact.length ? `${exact.length} verified exact-identity historical patterns` : null,
      incident ? `${incident} confirmed Incident` : null,
      noise ? `${noise} confirmed Noise` : null,
    ].filter(Boolean),
    missingEvidence: contradictory ? [...missingEvidence, 'CONFLICTING_HISTORICAL_OUTCOMES'] : missingEvidence,
    decisionDimensions: {
      noiseDetection: recommendation === 'NOISE' ? 'SUPPORTED_HISTORICAL_PATTERN' : 'NOT_ESTABLISHED',
      classification: current.source || 'UNKNOWN',
      businessImpact: current.featureSnapshot?.impactPresent ? 'OBSERVED' : 'UNKNOWN',
      actionability: current.featureSnapshot?.actionTaken ? 'ACTION_OBSERVED' : 'UNKNOWN',
      underlyingEvent: current.eventIdentifiers || {},
      notificationRole: 'PRIMARY_ONLY',
      finalDecision: recommendation,
    },
    shadowOnly: true,
    createsLabel: false,
  };
}

function metricsFor(rows = []) {
  const evaluated = rows.filter((row) => VERIFIED_LABELS.has(row.humanDecision));
  const incidentActual = evaluated.filter((row) => row.humanDecision === 'INCIDENT');
  const noiseActual = evaluated.filter((row) => row.humanDecision === 'NOISE');
  const incidentPredicted = evaluated.filter((row) => row.recommendation === 'INCIDENT');
  const noisePredicted = evaluated.filter((row) => row.recommendation === 'NOISE');
  const count = (items, predicate) => items.filter(predicate).length;
  const ratio = (numerator, denominator) => denominator ? numerator / denominator : null;
  const incidentTp = count(incidentPredicted, (row) => row.humanDecision === 'INCIDENT');
  const noiseTp = count(noisePredicted, (row) => row.humanDecision === 'NOISE');
  const falseNoise = count(noisePredicted, (row) => row.humanDecision === 'INCIDENT');
  return {
    sampleSize: evaluated.length,
    precision: {
      incident: ratio(incidentTp, incidentPredicted.length),
      noise: ratio(noiseTp, noisePredicted.length),
    },
    recall: {
      incident: ratio(incidentTp, incidentActual.length),
      noise: ratio(noiseTp, noiseActual.length),
    },
    falseNoiseRate: ratio(falseNoise, noisePredicted.length),
    needsReviewRate: ratio(count(evaluated, (row) => row.recommendation === 'NEEDS_REVIEW'), evaluated.length),
    evidenceCoverage: ratio(count(evaluated, (row) => row.evidenceCompleteness === 'COMPLETE'), evaluated.length),
  };
}

function createEvidenceLearningService({ db = database, ml = mlShadowService, clock = () => new Date() } = {}) {
  async function ensureSchema() {
    await ml.ensureSchema();
    if (!schemaReady) {
      schemaReady = db.query(migrationSql).catch((error) => {
        schemaReady = null;
        throw error;
      });
    }
    await schemaReady;
  }

  async function enqueueBackfill({ limit = 250 } = {}) {
    await ensureSchema();
    const boundedLimit = Math.min(Math.max(Number(limit) || 250, 1), 1000);
    const candidates = await db.query(`SELECT alert.id, alert.source, alert.status AS alert_status,
      alert.received_at, alert.acknowledged, alert.raw_payload, alert.extracted_details,
      alert.jira_ticket_id, alert.source_alert_id,
      ${commandCenterAlertProjectionSql('alert')},
      evaluation.evaluation_id, evaluation.source AS monitoring_source,
      evaluation.feature_as_of, evaluation.feature_snapshot->'identity' AS source_identity,
      evaluation.technical_evidence,
      COALESCE(alert.raw_payload->'priority'->>'name', alert.raw_payload->>'priority') AS priority
      FROM alerts alert
      JOIN live_shadow_evaluations_latest_v1 evaluation ON evaluation.alert_id=alert.id
      WHERE ${commandCenterAlertSql('alert')}
        AND alert.received_at < NOW() - INTERVAL '24 hours'
        AND NOT EXISTS (SELECT 1 FROM incident_verification_reports report WHERE report.alert_id=alert.id)
      ORDER BY alert.received_at DESC, alert.id DESC LIMIT $1`, [boundedLimit]);
    let created = 0;
    for (const row of candidates.rows) {
      const provenance = sourceProvenanceFromRow(row);
      const availableKinds = new Set(provenance.map((item) => item.sourceSystem));
      const completeness = availableKinds.size >= 3 ? 'COMPLETE' : availableKinds.size ? 'PARTIAL' : 'MISSING';
      const queueId = `backfill-${crypto.createHash('sha256').update(row.id).digest('hex').slice(0, 32)}`;
      const result = await db.query(`INSERT INTO evidence_backfill_queue (
        queue_id, alert_id, evaluation_id, reason, priority, monitoring_source,
        evidence_completeness, imported_evidence, evidence_provenance, source_timestamps
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb)
      ON CONFLICT (alert_id) DO NOTHING RETURNING queue_id`, [
        queueId, row.id, row.evaluation_id, 'HISTORICAL_EVIDENCE_REVIEW_REQUIRED',
        row.priority, row.monitoring_source || row.source, completeness,
        JSON.stringify(Object.fromEntries(provenance.map((item) => [item.sourceSystem, item.value]))),
        JSON.stringify(provenance),
        JSON.stringify(Object.fromEntries(provenance.map((item) => [item.sourceSystem, item.sourceTimestamp]))),
      ]);
      if (result.rowCount) {
        created += 1;
        for (const item of provenance) {
          await db.query(`INSERT INTO evidence_provenance_observations (
            observation_id, alert_id, queue_id, origin, source_system,
            evidence_kind, evidence_value, source_timestamp, metadata
          ) VALUES ($1,$2,$3,'BACKFILL',$4,$5,$6::jsonb,$7,$8::jsonb)`, [
            `evidence-observation-${crypto.randomUUID()}`, row.id, queueId,
            item.sourceSystem, item.evidenceKind, JSON.stringify(item.value), item.sourceTimestamp,
            JSON.stringify({ importedFromStoredData: true, externalCalls: 0 }),
          ]);
        }
      }
    }
    return { scanned: candidates.rows.length, created, preservedHistoricalAlerts: true, externalCalls: 0 };
  }

  async function listBackfill(options = {}) {
    await ensureSchema();
    const page = Math.max(Number(options.page) || 1, 1);
    const pageSize = Math.min(Math.max(Number(options.pageSize) || 25, 1), 100);
    const values = [];
    const clauses = [commandCenterAlertSql('alert')];
    const status = clean(options.status, '').toUpperCase();
    if (['PENDING', 'IN_REVIEW', 'VERIFIED', 'PENDING_EVIDENCE', 'SKIPPED'].includes(status)) {
      values.push(status); clauses.push(`queue.status=$${values.length}`);
    }
    const source = clean(options.source);
    if (source) { values.push(source); clauses.push(`LOWER(queue.monitoring_source)=LOWER($${values.length})`); }
    values.push((page - 1) * pageSize, pageSize);
    const result = await db.query(`SELECT queue.*, alert.title, alert.description,
      alert.atlassian_ops_tiny_id, alert.received_at, alert.status AS alert_status,
      ${commandCenterAlertProjectionSql('alert')}, COUNT(*) OVER() AS total_count
      FROM evidence_backfill_queue queue JOIN alerts alert ON alert.id=queue.alert_id
      WHERE ${clauses.join(' AND ')} ORDER BY queue.queued_at DESC
      OFFSET $${values.length - 1} LIMIT $${values.length}`, values);
    return {
      data: result.rows.map((row) => ({
        queueId: row.queue_id, alertId: row.alert_id,
        alertNumber: row.atlassian_ops_tiny_id, alertName: row.title || row.description,
        monitoringSource: row.monitoring_source, priority: row.priority,
        status: row.status, origin: 'BACKFILL', evidenceCompleteness: row.evidence_completeness,
        receivedAt: row.received_at, reason: row.reason,
        evidenceSources: Object.keys(row.imported_evidence || {}),
        collectEvidenceUrl: `/collect-evidence/${encodeURIComponent(row.alert_id)}?origin=BACKFILL&queueId=${encodeURIComponent(row.queue_id)}`,
      })),
      meta: { page, pageSize, total: Number(result.rows[0]?.total_count || 0) },
    };
  }

  async function selectBackfill(alertId, actor = {}) {
    await ensureSchema();
    const result = await db.query(`UPDATE evidence_backfill_queue queue SET
      status='IN_REVIEW', selected_by=$2, selected_at=COALESCE(selected_at,NOW()), updated_at=NOW()
      FROM alerts alert WHERE queue.alert_id=$1 AND alert.id=queue.alert_id
        AND ${commandCenterAlertSql('alert')}
        AND queue.status IN ('PENDING','IN_REVIEW','PENDING_EVIDENCE')
      RETURNING queue.*`, [alertId, actor.id || actor.userId || actor.name || 'operator']);
    if (!result.rows[0]) {
      const error = new Error('Backfill alert is not visible or is no longer available for review.');
      error.status = 404; error.code = 'BACKFILL_ALERT_NOT_VISIBLE';
      throw error;
    }
    return { queueId: result.rows[0].queue_id, alertId, status: 'IN_REVIEW', origin: 'BACKFILL' };
  }

  async function recordSubmission({ alert, evaluation, report, updateOfReportId = null } = {}) {
    await ensureSchema();
    const outcomeStatus = clean(report.evidence_outcome_status || report.outcomeStatus
      || report.human_decision || report.humanDecision, '').toUpperCase();
    if (['PENDING_EVIDENCE', 'NEEDS_REVIEW'].includes(outcomeStatus)) {
      if (report.origin === 'BACKFILL') {
        await db.query(`UPDATE evidence_backfill_queue SET status='PENDING_EVIDENCE',
          completed_report_id=$2, evidence_completeness=$3, updated_at=NOW()
          WHERE alert_id=$1`, [
          report.alert_id, report.report_id,
          report.evidence_completeness || completenessForResponses(report.form_responses || {}),
        ]);
      }
      return { skipped: true, reason: 'PENDING_EVIDENCE_EXCLUDED_FROM_LEARNING' };
    }
    const provenance = sourceProvenanceFromRow({ ...alert, ...evaluation });
    const structured = structuredLearningRecord({ alert, evaluation, report, provenance });
    const learningRecordId = `learning-${crypto.randomUUID()}`;
    const insertedLearning = await db.query(`INSERT INTO evidence_learning_records (
      learning_record_id, report_id, alert_id, episode_id, origin, source, priority,
      source_identity, alert_state, duration_seconds, auto_resolved, duplicate_count,
      repeat_count, flapping, event_identifiers, customer_business_impact, action_taken,
      jira_outcome, responder, resolution_method, evidence_completeness, human_decision,
      label_status, training_eligible, training_exclusion_reason, dataset_split,
      feature_snapshot, attachment_references, evidence_provenance, reviewer_id, reviewed_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14,$15::jsonb,$16,$17,
      $18::jsonb,$19,$20,$21,$22,$23,$24,$25,$26,$27::jsonb,$28::jsonb,$29::jsonb,$30,$31)
    ON CONFLICT (report_id) DO NOTHING
    RETURNING learning_record_id`, [
      learningRecordId, report.report_id, report.alert_id, report.episode_id,
      report.origin || 'LIVE', structured.source, structured.priority,
      JSON.stringify(structured.sourceIdentity), structured.alertState, structured.durationSeconds,
      structured.autoResolved, structured.duplicateCount, structured.repeatCount, structured.flapping,
      JSON.stringify(structured.eventIdentifiers), structured.customerBusinessImpact,
      structured.actionTaken, JSON.stringify(structured.jiraOutcome), structured.responder,
      structured.resolutionMethod, structured.evidenceCompleteness, structured.humanDecision,
      structured.labelStatus, structured.trainingEligible, structured.trainingExclusionReason,
      structured.datasetSplit, JSON.stringify(structured.featureSnapshot),
      JSON.stringify(report.attachment_references || []), JSON.stringify(provenance),
      report.reviewer_id, report.submitted_at,
    ]);
    if (updateOfReportId) {
      const original = await db.query('SELECT human_decision FROM incident_verification_reports WHERE report_id=$1', [updateOfReportId]);
      if (original.rows[0] && original.rows[0].human_decision !== report.human_decision) {
        await db.query(`INSERT INTO evidence_label_feedback_events (
          feedback_event_id, alert_id, original_report_id, corrected_report_id,
          original_label, corrected_label, reviewer_id, reason
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [
          `label-feedback-${crypto.randomUUID()}`, report.alert_id, updateOfReportId,
          report.report_id, original.rows[0].human_decision, report.human_decision,
          report.reviewer_id,
          report.form_responses?.decisionJustification || 'Explicit evidence update',
        ]);
      }
    }
    if (report.origin === 'BACKFILL') {
      await db.query(`UPDATE evidence_backfill_queue SET status=$2,
        completed_report_id=$3, evidence_completeness=$4, updated_at=NOW()
        WHERE alert_id=$1`, [
        report.alert_id,
        'VERIFIED',
        report.report_id, structured.evidenceCompleteness,
      ]);
    }
    await db.query(`UPDATE evidence_pattern_recommendations
      SET reviewer_outcome=$2 WHERE alert_id=$1 AND reviewer_outcome IS NULL`, [
      report.alert_id, report.human_decision,
    ]);
    let mlJobs = null;
    if (structured.trainingEligible && insertedLearning.rowCount > 0) {
      try {
        // Loaded lazily to avoid coupling evidence persistence to the worker
        // lifecycle. Evidence and its learning row are committed first.
        const { service: mlTrainingOrchestrator } = require('./mlTrainingOrchestrator.service');
        mlJobs = await mlTrainingOrchestrator.enqueueConfirmedLabel({
          reportId: report.report_id,
          alertId: report.alert_id,
          evaluationId: report.evaluation_id,
          evidenceRevision: report.evidence_revision,
        });
      } catch (error) {
        mlJobs = { queued: false, code: error.code || 'ML_JOB_ENQUEUE_FAILED' };
      }
    }
    return { learningRecordId, mlJobs, ...structured };
  }

  function currentPatternFromEvaluation(evaluation = {}) {
    const snapshot = evaluation.feature_snapshot || evaluation.featureSnapshot || {};
    const identity = snapshot.identity || {};
    const technical = evaluation.technical_evidence || evaluation.technicalEvidence || {};
    const evidenceVector = evaluation.evidence_vector || evaluation.evidenceVector || {};
    const sourceDetails = evaluation.source_details || evaluation.sourceDetails || {};
    const completeness = technical.coverage?.evidenceCompleteness?.complete === true
      ? 'COMPLETE'
      : Number(evaluation.observability?.evidenceCount || evaluation.evidence_count || 0) > 0
        || Object.keys(technical).length ? 'PARTIAL' : 'MISSING';
    const eventIdentifiers = {
      eventId: clean(sourceDetails.eventId || evidenceVector.eventId || identity.eventId),
      ruleUid: clean(sourceDetails.ruleUid || sourceDetails.ruleUID || evidenceVector.ruleUid || identity.ruleUid),
      rule: clean(sourceDetails.rule || sourceDetails.ruleTitle || identity.rule),
      healthRule: clean(sourceDetails.healthRule || identity.healthRule),
      fingerprint: clean(sourceDetails.fingerprint || evidenceVector.fingerprint || identity.fingerprint),
    };
    const sourceIdentity = {
      application: clean(identity.application || sourceDetails.application),
      service: clean(identity.service || sourceDetails.service),
      host: clean(identity.host || sourceDetails.host),
      node: clean(identity.node || sourceDetails.node),
      tier: clean(identity.tier || sourceDetails.tier),
    };
    const source = clean(evaluation.source);
    return {
      source, priority: clean(snapshot.operationalPriority?.value || sourceDetails.priority),
      sourceIdentity, eventIdentifiers, evidenceCompleteness: completeness,
      featureSnapshot: {
        impactPresent: !['UNKNOWN', null, undefined].includes(evaluation.business_impact || evaluation.businessImpact),
        actionTaken: ['ACTIONABLE', 'INTERVENTION_OBSERVED'].includes(evaluation.actionability),
      },
      identityKey: identityKey(source, sourceIdentity, eventIdentifiers),
    };
  }

  async function persistPatternRecommendation(alertId, current, featureSnapshotId) {
    const patternsResult = await db.query(`SELECT learning_record_id, source, priority,
      source_identity, event_identifiers, evidence_completeness, human_decision, label_status
      FROM evidence_learning_records WHERE label_status='VERIFIED' AND source=$1
        AND alert_id<>$2 ORDER BY reviewed_at DESC LIMIT 500`, [current.source, alertId]);
    const patterns = patternsResult.rows.map((row) => ({
      learningRecordId: row.learning_record_id, source: row.source, priority: row.priority,
      humanDecision: row.human_decision, labelStatus: row.label_status,
      evidenceCompleteness: row.evidence_completeness,
      identityKey: identityKey(row.source, row.source_identity || {}, row.event_identifiers || {}),
    }));
    const value = patternRecommendation(current, patterns);
    const recommendationId = `pattern-recommendation-${crypto.randomUUID()}`;
    await db.query(`INSERT INTO evidence_pattern_recommendations (
      recommendation_id, alert_id, model_version, feature_snapshot_id, recommendation,
      confidence, matching_patterns, supporting_evidence, missing_evidence,
      decision_dimensions, shadow_only
    ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,$10::jsonb,TRUE)`, [
      recommendationId, alertId, MODEL_VERSION,
      featureSnapshotId, value.recommendation, value.confidence,
      JSON.stringify(value.matchingEvidencePatterns), JSON.stringify(value.supportingEvidence),
      JSON.stringify(value.missingEvidence), JSON.stringify(value.decisionDimensions),
    ]);
    return { recommendationId, ...value };
  }

  async function recommendationForEvaluation(evaluation = {}) {
    await ensureSchema();
    const alertId = clean(evaluation.alert_id || evaluation.alertId);
    if (!alertId) throw new Error('alertId is required for evidence-pattern recommendation.');
    const current = currentPatternFromEvaluation(evaluation);
    const featureSnapshotId = clean(evaluation.evaluation_id || evaluation.evaluationId)
      || `evaluation-${crypto.createHash('sha256').update(`${alertId}|${evaluation.feature_as_of || ''}`).digest('hex').slice(0, 32)}`;
    return persistPatternRecommendation(alertId, current, featureSnapshotId);
  }

  async function recommendation(alertId) {
    await ensureSchema();
    const currentResult = await db.query(`SELECT evaluation.* FROM live_shadow_evaluations_latest_v1 evaluation
      JOIN alerts alert ON alert.id=evaluation.alert_id
      WHERE evaluation.alert_id=$1 AND ${commandCenterAlertSql('alert')} LIMIT 1`, [alertId]);
    if (!currentResult.rows[0]) {
      const error = new Error('The requested alert is not visible or has no current evaluation.');
      error.status = 404; error.code = 'EVIDENCE_RECOMMENDATION_ALERT_NOT_VISIBLE';
      throw error;
    }
    return recommendationForEvaluation(currentResult.rows[0]);
  }

  async function summary() {
    await ensureSchema();
    const [queue, learning, corrections] = await Promise.all([
      db.query(`SELECT status, COUNT(*)::int AS count FROM evidence_backfill_queue GROUP BY status`),
      db.query(`SELECT source, priority, human_decision, label_status, dataset_split,
        evidence_completeness, training_eligible FROM evidence_learning_records`),
      db.query('SELECT COUNT(*)::int AS count FROM evidence_label_feedback_events'),
    ]);
    const rows = learning.rows;
    return {
      mode: 'SHADOW_READ_ONLY',
      backfillQueue: Object.fromEntries(queue.rows.map((row) => [row.status, Number(row.count)])),
      learningRecords: rows.length,
      verifiedLabels: rows.filter((row) => row.label_status === 'VERIFIED').length,
      pendingEvidence: Number(queue.rows.find((row) => row.status === 'PENDING_EVIDENCE')?.count || 0),
      trainingEligible: rows.filter((row) => row.training_eligible).length,
      corrections: Number(corrections.rows[0]?.count || 0),
      splits: Object.fromEntries(['TRAIN', 'VALIDATION', 'HOLDOUT'].map((split) => [split, rows.filter((row) => row.dataset_split === split).length])),
      bySource: Object.fromEntries([...new Set(rows.map((row) => row.source || 'UNKNOWN'))].map((source) => [source, rows.filter((row) => (row.source || 'UNKNOWN') === source).length])),
      byPriority: Object.fromEntries([...new Set(rows.map((row) => row.priority || 'UNKNOWN'))].map((priority) => [priority, rows.filter((row) => (row.priority || 'UNKNOWN') === priority).length])),
      attachmentsOnlySignal: false,
      modelPredictionsCreateLabels: false,
      automaticActionsEnabled: false,
    };
  }

  async function evaluation() {
    await ensureSchema();
    const result = await db.query(`SELECT learning.source, learning.priority,
      learning.human_decision, learning.evidence_completeness,
      recommendation.recommendation, learning.dataset_split
      FROM evidence_learning_records learning
      LEFT JOIN LATERAL (
        SELECT recommendation FROM evidence_pattern_recommendations value
        WHERE value.alert_id=learning.alert_id ORDER BY value.created_at DESC LIMIT 1
      ) recommendation ON TRUE
      WHERE learning.label_status='VERIFIED'`);
    const rows = result.rows.map((row) => ({
      source: row.source || 'UNKNOWN', priority: row.priority || 'UNKNOWN',
      humanDecision: row.human_decision, evidenceCompleteness: row.evidence_completeness,
      recommendation: row.recommendation || 'NEEDS_REVIEW', datasetSplit: row.dataset_split,
    }));
    const grouped = (field) => Object.fromEntries([...new Set(rows.map((row) => row[field]))]
      .map((value) => [value, metricsFor(rows.filter((row) => row[field] === value))]));
    return {
      modelVersion: MODEL_VERSION, mode: 'SHADOW_READ_ONLY', overall: metricsFor(rows),
      bySource: grouped('source'), byPriority: grouped('priority'),
      bySplit: grouped('datasetSplit'), automaticActionsEnabled: false,
    };
  }

  return {
    ensureSchema, enqueueBackfill, evaluation, listBackfill, recommendation,
    recommendationForEvaluation, recordSubmission, selectBackfill, summary,
  };
}

const service = createEvidenceLearningService();

module.exports = {
  MODEL_VERSION,
  completenessForResponses,
  createEvidenceLearningService,
  datasetSplitFor,
  durationSeconds,
  metricsFor,
  patternRecommendation,
  service,
  sourceProvenanceFromRow,
  structuredLearningRecord,
};
