#!/usr/bin/env node

const db = require('../src/config/db');
const { service } = require('../src/services/liveMultiSourceEvaluation.service');

const POLICY = 'PHASE14_MONITORING_LIFECYCLE_V1';
const sourceSql = `CASE
  WHEN LOWER(SPLIT_PART(COALESCE(alert.raw_payload->>'integrationName', alert.raw_payload->>'source', alert.source), '|', 1)) LIKE 'appd%' THEN 'AppDynamics'
  WHEN LOWER(SPLIT_PART(COALESCE(alert.raw_payload->>'integrationName', alert.raw_payload->>'source', alert.source), '|', 1)) LIKE 'grafana%' THEN 'Grafana'
  WHEN LOWER(SPLIT_PART(COALESCE(alert.raw_payload->>'integrationName', alert.raw_payload->>'source', alert.source), '|', 1)) LIKE 'nagios%' THEN 'Nagios'
  WHEN REPLACE(LOWER(SPLIT_PART(COALESCE(alert.raw_payload->>'integrationName', alert.raw_payload->>'source', alert.source), '|', 1)), ' ', '') LIKE 'thousandeyes%' THEN 'ThousandEyes'
  ELSE 'Unsupported/Unknown' END`;

async function main() {
  await service.ensureSchema();
  const baselineBeforeArg = process.argv.find((value) => value.startsWith('--baseline-before='));
  const compact = process.argv.includes('--compact');
  const baselineBeforeValue = baselineBeforeArg?.slice('--baseline-before='.length) || null;
  const baselineBefore = baselineBeforeValue && !Number.isNaN(new Date(baselineBeforeValue).getTime())
    ? new Date(baselineBeforeValue).toISOString() : null;
  const [baseline, summary, changes, behaviors, relationships, sourceResults, priorityResults,
    reviewReasons, noiseSubtypes, samples, reviews] = await Promise.all([
    db.query(`SELECT * FROM shadow_policy_baselines WHERE policy_version = 'PHASE13_DECISION_QUALITY_SHADOW_V1' AND cohort_name = 'PHASE13_VERIFIED_95_ALERT_COHORT'`),
    db.query(`
      WITH current AS (
        SELECT DISTINCT ON (evaluation.alert_id) evaluation.*
        FROM live_shadow_evaluations evaluation
        JOIN alerts alert ON alert.id = evaluation.alert_id
        WHERE evaluation.decision_policy = $1
          AND alert.atlassian_ops_alert_id IS NOT NULL
          AND alert.received_at >= NOW() - INTERVAL '24 hours'
        ORDER BY evaluation.alert_id, evaluation.created_at DESC, evaluation.feature_as_of DESC
      )
      SELECT COUNT(*)::int AS total,
        COUNT(*)::int AS evaluated,
        COUNT(*) FILTER (WHERE final_decision = 'INCIDENT')::int AS incident,
        COUNT(*) FILTER (WHERE final_decision = 'NOISE')::int AS noise,
        COUNT(*) FILTER (WHERE final_decision = 'NEEDS_REVIEW')::int AS needs_review,
        COUNT(*) FILTER (WHERE COALESCE((technical_evidence->'monitoringLifecycle'->'historicalBehavior'->>'occurrenceCount')::int, 0) >= 1)::int AS prior_occurrence,
        COUNT(*) FILTER (WHERE technical_evidence->'monitoringLifecycle'->'historicalBehavior'->>'historyStatus' = 'SUFFICIENT_HISTORY')::int AS sufficient_history,
        COUNT(*) FILTER (WHERE COALESCE((technical_evidence->'monitoringLifecycle'->'completeness'->>'historicalEvidenceAvailable')::boolean, false))::int AS historical_profiles,
        COUNT(*) FILTER (WHERE COALESCE(technical_evidence->'monitoringLifecycle'->'signals','[]'::jsonb) ?| ARRAY['ABNORMAL_DURATION','ABNORMAL_METRIC','ABNORMAL_SEVERITY'])::int AS abnormal_history,
        COUNT(*) FILTER (WHERE COALESCE((technical_evidence->'monitoringLifecycle'->'intervention'->>'acknowledged')::boolean, false))::int AS acknowledged,
        COUNT(*) FILTER (WHERE COALESCE((technical_evidence->'monitoringLifecycle'->'intervention'->>'investigated')::boolean, false))::int AS investigated,
        COUNT(*) FILTER (WHERE COALESCE((technical_evidence->'monitoringLifecycle'->'intervention'->>'remediated')::boolean, false))::int AS remediated,
        COUNT(*) FILTER (WHERE COALESCE((technical_evidence->'monitoringLifecycle'->'intervention'->>'escalated')::boolean, false))::int AS escalated,
        COUNT(*) FILTER (WHERE NOT COALESCE((technical_evidence->'monitoringLifecycle'->'intervention'->>'operatorActionObserved')::boolean, false))::int AS no_intervention,
        COUNT(*) FILTER (WHERE COALESCE((explanation->>'fallbackResolved')::boolean, false))::int AS fallback_resolved,
        COUNT(*) FILTER (WHERE final_decision = 'NEEDS_REVIEW'
          AND COALESCE((explanation->>'genuinelyAmbiguous')::boolean, false))::int AS genuinely_ambiguous,
        COUNT(*) FILTER (WHERE COALESCE(explanation->'evidenceGaps','[]'::jsonb) @> '[{"code":"SOURCE_API_UNAVAILABLE"}]'::jsonb)::int AS source_api_evidence_gaps,
        COUNT(*) FILTER (WHERE final_decision = 'NEEDS_REVIEW'
          AND COALESCE(explanation->'decisionBlockers','[]'::jsonb) <> '[]'::jsonb
          AND NOT EXISTS (
            SELECT 1
            FROM JSONB_ARRAY_ELEMENTS(COALESCE(explanation->'decisionBlockers','[]'::jsonb)) blocker
            WHERE blocker->>'field' <> 'Authoritative monitoring state'
          ))::int AS source_unavailable_only_reviews
      FROM current
    `, [POLICY]),
    db.query(`
      WITH current AS (
        SELECT changes.* FROM phase14_decision_changes_v1 changes
        JOIN alerts alert ON alert.id = changes.alert_id
        WHERE alert.received_at >= NOW() - INTERVAL '24 hours'
      )
      SELECT old_decision, new_decision, COUNT(*)::int AS count
      FROM current GROUP BY 1,2 ORDER BY 1,2
    `),
    db.query(`
      WITH current AS (
        SELECT DISTINCT ON (evaluation.alert_id) evaluation.*
        FROM live_shadow_evaluations evaluation JOIN alerts alert ON alert.id = evaluation.alert_id
        WHERE evaluation.decision_policy = $1 AND alert.received_at >= NOW() - INTERVAL '24 hours'
        ORDER BY evaluation.alert_id, evaluation.created_at DESC
      ), behavior AS (
        SELECT evaluation.final_decision,
          JSONB_ARRAY_ELEMENTS_TEXT(COALESCE(evaluation.noise_detection->'observed','[]'::jsonb)) AS signal
        FROM current evaluation
      )
      SELECT signal, final_decision, COUNT(*)::int AS count FROM behavior
      WHERE signal IN ('AUTO_RESOLVED','FLAPPING') GROUP BY 1,2 ORDER BY 1,2
    `, [POLICY]),
    db.query(`
      WITH current AS (
        SELECT DISTINCT ON (evaluation.alert_id) evaluation.*
        FROM live_shadow_evaluations evaluation JOIN alerts alert ON alert.id = evaluation.alert_id
        WHERE evaluation.decision_policy = $1 AND alert.received_at >= NOW() - INTERVAL '24 hours'
        ORDER BY evaluation.alert_id, evaluation.created_at DESC
      ), relationship AS (
        SELECT final_decision,
          COALESCE((technical_evidence->'monitoringLifecycle'->'relationshipEvidence'->>'duplicateCandidate')::boolean, false) duplicate_candidate,
          COALESCE((technical_evidence->'monitoringLifecycle'->'relationshipEvidence'->>'duplicateConfirmed')::boolean, false) duplicate_confirmed,
          COALESCE((technical_evidence->'monitoringLifecycle'->'relationshipEvidence'->>'correlationCandidate')::boolean, false) correlation_candidate,
          COALESCE((technical_evidence->'monitoringLifecycle'->'relationshipEvidence'->>'correlationConfirmed')::boolean, false) correlation_confirmed
        FROM current
      )
      SELECT final_decision,
        COUNT(*) FILTER (WHERE duplicate_candidate)::int duplicate_candidate,
        COUNT(*) FILTER (WHERE duplicate_confirmed)::int duplicate_confirmed,
        COUNT(*) FILTER (WHERE correlation_candidate)::int correlation_candidate,
        COUNT(*) FILTER (WHERE correlation_confirmed)::int correlation_confirmed
      FROM relationship GROUP BY final_decision ORDER BY final_decision
    `, [POLICY]),
    db.query(`
      WITH current AS (
        SELECT DISTINCT ON (evaluation.alert_id) evaluation.*
        FROM live_shadow_evaluations evaluation JOIN alerts alert ON alert.id = evaluation.alert_id
        WHERE evaluation.decision_policy = $1 AND alert.received_at >= NOW() - INTERVAL '24 hours'
        ORDER BY evaluation.alert_id, evaluation.created_at DESC
      )
      SELECT source, final_decision, COUNT(*)::int AS count FROM current
      GROUP BY source, final_decision ORDER BY source, final_decision
    `, [POLICY]),
    db.query(`
      WITH current AS (
        SELECT DISTINCT ON (evaluation.alert_id)
          evaluation.*,
          COALESCE(
            alert.extracted_details->'normalized_alert'->>'priority',
            alert.raw_payload->>'priority',
            'UNKNOWN'
          ) AS priority
        FROM live_shadow_evaluations evaluation
        JOIN alerts alert ON alert.id = evaluation.alert_id
        WHERE evaluation.decision_policy = $1
          AND alert.atlassian_ops_alert_id IS NOT NULL
          AND alert.received_at >= NOW() - INTERVAL '24 hours'
        ORDER BY evaluation.alert_id, evaluation.created_at DESC, evaluation.feature_as_of DESC
      )
      SELECT priority,
        feature_snapshot->'operationalPriority'->>'signal' AS priority_signal,
        final_decision,
        COUNT(*)::int AS count
      FROM current
      GROUP BY 1,2,3
      ORDER BY CASE priority
        WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 WHEN 'P3' THEN 3
        WHEN 'P4' THEN 4 WHEN 'P5' THEN 5 ELSE 6 END,
        final_decision
    `, [POLICY]),
    db.query(`
      WITH current AS (
        SELECT DISTINCT ON (evaluation.alert_id) evaluation.*
        FROM live_shadow_evaluations evaluation
        JOIN alerts alert ON alert.id = evaluation.alert_id
        WHERE evaluation.decision_policy = $1
          AND alert.atlassian_ops_alert_id IS NOT NULL
          AND alert.received_at >= NOW() - INTERVAL '24 hours'
        ORDER BY evaluation.alert_id, evaluation.created_at DESC, evaluation.feature_as_of DESC
      )
      SELECT COALESCE(explanation->>'reviewSubReason','OTHER') AS reason,
        COUNT(*)::int AS count
      FROM current WHERE final_decision = 'NEEDS_REVIEW'
      GROUP BY 1 ORDER BY count DESC, reason
    `, [POLICY]),
    db.query(`
      WITH current AS (
        SELECT DISTINCT ON (evaluation.alert_id) evaluation.*
        FROM live_shadow_evaluations evaluation
        JOIN alerts alert ON alert.id = evaluation.alert_id
        WHERE evaluation.decision_policy = $1
          AND alert.atlassian_ops_alert_id IS NOT NULL
          AND alert.received_at >= NOW() - INTERVAL '24 hours'
        ORDER BY evaluation.alert_id, evaluation.created_at DESC, evaluation.feature_as_of DESC
      )
      SELECT source, COALESCE(explanation->>'noiseType','UNSPECIFIED') AS noise_type,
        COUNT(*)::int AS count
      FROM current WHERE final_decision = 'NOISE'
      GROUP BY 1,2 ORDER BY source, count DESC, noise_type
    `, [POLICY]),
    db.query(`
      WITH ranked AS (
        SELECT alert.atlassian_ops_tiny_id AS alert, evaluation.alert_id,
          ${sourceSql} AS source, alert.title,
          COALESCE(alert.extracted_details->'normalized_alert'->>'priority', alert.raw_payload->>'priority') AS priority,
          evaluation.final_decision,
          evaluation.feature_snapshot->'operationalPriority'->>'signal' AS priority_signal,
          evaluation.technical_evidence->'monitoringLifecycle'->'occurrence' AS occurrence,
          evaluation.technical_evidence->'monitoringLifecycle'->'persistence' AS persistence,
          evaluation.technical_evidence->'monitoringLifecycle'->'recovery' AS recovery,
          (evaluation.technical_evidence->'monitoringLifecycle'->'historicalBehavior') - 'previousAlertIds'::text AS historical_pattern,
          evaluation.technical_evidence->'monitoringLifecycle'->'signals' AS signals,
          evaluation.explanation->>'whyNoise' AS why_noise,
          evaluation.explanation->>'reviewQuestion' AS review_question,
          evaluation.explanation->'reasons' AS reasons,
          ROW_NUMBER() OVER (PARTITION BY evaluation.final_decision ORDER BY alert.received_at DESC, alert.id) AS rank
        FROM alerts alert
        JOIN live_shadow_evaluations_latest_v1 evaluation ON evaluation.alert_id = alert.id
        WHERE alert.atlassian_ops_alert_id IS NOT NULL
          AND alert.received_at >= NOW() - INTERVAL '24 hours'
          AND evaluation.decision_policy = $1
      ) SELECT * FROM ranked WHERE rank <= 5 ORDER BY final_decision, rank
    `, [POLICY]),
    db.query(`SELECT COUNT(*)::int AS count FROM alert_occurrence_outcomes`),
  ]);
  const failSoftComparison = baselineBefore ? await db.query(`
    WITH cohort AS (
      SELECT id FROM alerts
      WHERE atlassian_ops_alert_id IS NOT NULL
        AND received_at >= NOW() - INTERVAL '24 hours'
    ), old_evaluation AS (
      SELECT DISTINCT ON (evaluation.alert_id) evaluation.*
      FROM live_shadow_evaluations evaluation
      JOIN cohort ON cohort.id = evaluation.alert_id
      WHERE evaluation.decision_policy = $1
        AND evaluation.created_at < $2::timestamptz
      ORDER BY evaluation.alert_id, evaluation.created_at DESC, evaluation.feature_as_of DESC
    ), current_evaluation AS (
      SELECT evaluation.*
      FROM live_shadow_evaluations_latest_v1 evaluation
      JOIN cohort ON cohort.id = evaluation.alert_id
    ), transitions AS (
      SELECT old_evaluation.final_decision AS old_decision,
        current_evaluation.final_decision AS new_decision,
        COUNT(*)::int AS count
      FROM old_evaluation
      JOIN current_evaluation USING (alert_id)
      GROUP BY 1,2
    ), examples AS (
      SELECT alert.atlassian_ops_tiny_id AS alert,
        evaluation.source, evaluation.final_decision,
        evaluation.explanation->>'decisionBasis' AS decision_basis,
        evaluation.explanation->>'reviewSubReason' AS review_sub_reason,
        evaluation.technical_evidence->'monitoringLifecycle'->'persistence'->>'durationSeconds' AS duration_seconds,
        evaluation.technical_evidence->'monitoringLifecycle'->'historicalBehavior'->>'medianDurationSeconds' AS median_seconds,
        evaluation.technical_evidence->'monitoringLifecycle'->'historicalBehavior'->>'p95DurationSeconds' AS p95_seconds
      FROM alerts alert
      JOIN current_evaluation evaluation ON evaluation.alert_id = alert.id
      WHERE alert.atlassian_ops_tiny_id IN ('174781','174782','174805')
    )
    SELECT JSONB_BUILD_OBJECT(
      'baselineBefore', $2::timestamptz,
      'transitions', COALESCE((SELECT JSONB_AGG(transitions ORDER BY old_decision, new_decision) FROM transitions), '[]'::jsonb),
      'previousReviewBlockedOnlyByBusinessImpact', (
        SELECT COUNT(*)::int FROM old_evaluation
        WHERE final_decision = 'NEEDS_REVIEW'
          AND JSONB_ARRAY_LENGTH(COALESCE(explanation->'decisionBlockers','[]'::jsonb)) = 1
          AND explanation->'decisionBlockers'->0->>'field' = 'Business impact'
      ),
      'previousReviewBlockedOnlyByActionability', (
        SELECT COUNT(*)::int FROM old_evaluation
        WHERE final_decision = 'NEEDS_REVIEW'
          AND JSONB_ARRAY_LENGTH(COALESCE(explanation->'decisionBlockers','[]'::jsonb)) = 1
          AND explanation->'decisionBlockers'->0->>'field' = 'Actionability'
      ),
      'examples', COALESCE((SELECT JSONB_AGG(examples ORDER BY alert) FROM examples), '[]'::jsonb)
    ) AS result
  `, [POLICY, baselineBefore]) : null;
  process.stdout.write(`${JSON.stringify({
    policy: POLICY,
    phase13Baseline: baseline.rows[0] || null,
    phase14: summary.rows[0] || {},
    decisionChanges: changes.rows,
    noiseEvidence: behaviors.rows,
    relationshipEvidence: relationships.rows,
    sourceResults: sourceResults.rows,
    priorityResults: priorityResults.rows,
    needsReviewReasons: reviewReasons.rows,
    noiseBySourceAndSubtype: noiseSubtypes.rows,
    failSoftComparison: failSoftComparison?.rows[0]?.result || null,
    representativeSamples: compact ? undefined : samples.rows,
    humanReviews: Number(reviews.rows[0]?.count || 0),
    mlTrained: false,
    externalMutations: 0,
    automaticActions: 'DISABLED',
    legacyClassifier: 'RETIRED',
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ safeError: error.code || error.message })}\n`);
  process.exitCode = 1;
}).finally(async () => db.pool.end());
