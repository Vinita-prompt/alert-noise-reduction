#!/usr/bin/env node

const db = require('../src/config/db');
const { service } = require('../src/services/liveMultiSourceEvaluation.service');

const POLICY = 'PHASE13_DECISION_QUALITY_SHADOW_V1';

const canonicalSourceSql = `CASE
  WHEN LOWER(SPLIT_PART(COALESCE(alert.raw_payload->>'integrationName', alert.raw_payload->>'source', alert.source), '|', 1)) LIKE 'appd%' THEN 'AppDynamics'
  WHEN LOWER(SPLIT_PART(COALESCE(alert.raw_payload->>'integrationName', alert.raw_payload->>'source', alert.source), '|', 1)) LIKE 'grafana%' THEN 'Grafana'
  WHEN LOWER(SPLIT_PART(COALESCE(alert.raw_payload->>'integrationName', alert.raw_payload->>'source', alert.source), '|', 1)) LIKE 'nagios%' THEN 'Nagios'
  WHEN REPLACE(LOWER(SPLIT_PART(COALESCE(alert.raw_payload->>'integrationName', alert.raw_payload->>'source', alert.source), '|', 1)), ' ', '') LIKE 'thousandeyes%' THEN 'ThousandEyes'
  ELSE 'Unsupported/Unknown' END`;

async function main() {
  await service.ensureSchema();
  const population = await service.listCandidates({ range: '24h', page: 1, pageSize: 1 });
  const [behavior, transitions, fixedCohort, fixedCohortSources, samples, duplicateAudit] = await Promise.all([
    db.query(`
      WITH current AS (
        SELECT ${canonicalSourceSql} AS source, evaluation.final_decision,
          jsonb_array_elements_text(COALESCE(evaluation.noise_detection->'observed', '[]'::jsonb)) AS behavior
        FROM alerts alert
        JOIN live_shadow_evaluations_latest_v1 evaluation ON evaluation.alert_id = alert.id
        WHERE alert.atlassian_ops_alert_id IS NOT NULL
          AND alert.received_at >= NOW() - INTERVAL '24 hours'
          AND evaluation.decision_policy = $1
      )
      SELECT behavior, final_decision, COUNT(*)::int AS count
      FROM current GROUP BY behavior, final_decision ORDER BY behavior, final_decision
    `, [POLICY]),
    db.query(`
      SELECT old_decision, new_decision, COUNT(*)::int AS count
      FROM phase13_decision_changes_v1
      GROUP BY old_decision, new_decision ORDER BY old_decision, new_decision
    `),
    db.query(`
      WITH phase12 AS (
        SELECT DISTINCT ON (evaluation.alert_id)
          evaluation.alert_id, evaluation.final_decision
        FROM live_shadow_evaluations evaluation
        WHERE evaluation.decision_policy = 'PHASE12_EXHAUSTIVE_EVIDENCE_RESULTS_V2'
        ORDER BY evaluation.alert_id, evaluation.created_at DESC, evaluation.feature_as_of DESC
      ), phase13 AS (
        SELECT DISTINCT ON (evaluation.alert_id)
          evaluation.alert_id, evaluation.final_decision,
          evaluation.explanation->'decisionBlockers' AS decision_blockers,
          evaluation.explanation->>'reviewQuestion' AS review_question,
          COALESCE((evaluation.explanation->>'evidenceExhausted')::boolean, false) AS evidence_exhausted
        FROM live_shadow_evaluations evaluation
        WHERE evaluation.decision_policy = $1
        ORDER BY evaluation.alert_id, evaluation.created_at DESC, evaluation.feature_as_of DESC
      )
      SELECT
        COUNT(*)::int AS cohort_size,
        COUNT(*) FILTER (WHERE phase12.final_decision = 'INCIDENT')::int AS phase12_incident,
        COUNT(*) FILTER (WHERE phase12.final_decision = 'NOISE')::int AS phase12_noise,
        COUNT(*) FILTER (WHERE phase12.final_decision = 'NEEDS_REVIEW')::int AS phase12_needs_review,
        COUNT(*) FILTER (WHERE phase13.final_decision = 'INCIDENT')::int AS phase13_incident,
        COUNT(*) FILTER (WHERE phase13.final_decision = 'NOISE')::int AS phase13_noise,
        COUNT(*) FILTER (WHERE phase13.final_decision = 'NEEDS_REVIEW')::int AS phase13_needs_review,
        COUNT(*) FILTER (WHERE phase12.final_decision IS DISTINCT FROM phase13.final_decision)::int AS changed,
        COUNT(*) FILTER (WHERE phase13.final_decision = 'NEEDS_REVIEW'
          AND phase13.evidence_exhausted
          AND jsonb_array_length(COALESCE(phase13.decision_blockers, '[]'::jsonb)) > 0
          AND NULLIF(phase13.review_question, '') IS NOT NULL)::int AS review_contract_complete
      FROM phase12
      JOIN phase13 ON phase13.alert_id = phase12.alert_id
    `, [POLICY]),
    db.query(`
      WITH phase12 AS (
        SELECT DISTINCT ON (evaluation.alert_id) evaluation.alert_id
        FROM live_shadow_evaluations evaluation
        WHERE evaluation.decision_policy = 'PHASE12_EXHAUSTIVE_EVIDENCE_RESULTS_V2'
        ORDER BY evaluation.alert_id, evaluation.created_at DESC, evaluation.feature_as_of DESC
      ), phase13 AS (
        SELECT DISTINCT ON (evaluation.alert_id)
          evaluation.alert_id, evaluation.final_decision
        FROM live_shadow_evaluations evaluation
        WHERE evaluation.decision_policy = $1
        ORDER BY evaluation.alert_id, evaluation.created_at DESC, evaluation.feature_as_of DESC
      )
      SELECT ${canonicalSourceSql} AS source, phase13.final_decision, COUNT(*)::int AS count
      FROM phase12
      JOIN phase13 ON phase13.alert_id = phase12.alert_id
      JOIN alerts alert ON alert.id = phase12.alert_id
      GROUP BY ${canonicalSourceSql}, phase13.final_decision
      ORDER BY ${canonicalSourceSql}, phase13.final_decision
    `, [POLICY]),
    db.query(`
      WITH ranked AS (
        SELECT alert.atlassian_ops_tiny_id AS alert_id, ${canonicalSourceSql} AS source,
          alert.title, evaluation.final_decision,
          evaluation.noise_detection->>'primary' AS primary_noise_pattern,
          evaluation.notification_role, evaluation.underlying_event,
          evaluation.actionability, evaluation.business_impact,
          evaluation.explanation->'reasons' AS reasons,
          evaluation.explanation->>'whyNoise' AS why_noise,
          evaluation.explanation->'decisionBlockers' AS decision_blockers,
          evaluation.explanation->>'reviewQuestion' AS review_question,
          ROW_NUMBER() OVER (PARTITION BY evaluation.final_decision ORDER BY alert.received_at DESC, alert.id) AS sample_rank
        FROM alerts alert
        JOIN live_shadow_evaluations_latest_v1 evaluation ON evaluation.alert_id = alert.id
        WHERE alert.atlassian_ops_alert_id IS NOT NULL
          AND alert.received_at >= NOW() - INTERVAL '24 hours'
          AND evaluation.decision_policy = $1
      )
      SELECT * FROM ranked
      WHERE (final_decision = 'NOISE' AND sample_rank <= 10)
        OR (final_decision <> 'NOISE' AND sample_rank <= 5)
      ORDER BY final_decision, sample_rank
    `, [POLICY]),
    db.query(`
      WITH current AS (
        SELECT alert.id, alert.learning_alert_signature_v1 AS signature,
          alert.learning_entity_key_v1 AS entity_key,
          ${canonicalSourceSql} AS source,
          alert.received_at AS starts_at,
          GREATEST(alert.received_at, COALESCE(alert.last_seen_at, alert.received_at)) AS ends_at
        FROM alerts alert
        WHERE alert.atlassian_ops_alert_id IS NOT NULL
          AND alert.received_at >= NOW() - INTERVAL '24 hours'
      ), pairs AS (
        SELECT first_alert.id AS first_id, second_alert.id AS second_id,
          first_alert.source, first_alert.signature, first_alert.entity_key
        FROM current first_alert
        JOIN current second_alert ON second_alert.id > first_alert.id
          AND second_alert.signature = first_alert.signature
          AND first_alert.entity_key IS NOT NULL
          AND second_alert.entity_key = first_alert.entity_key
          AND second_alert.source = first_alert.source
          AND first_alert.starts_at <= second_alert.ends_at
          AND second_alert.starts_at <= first_alert.ends_at
      )
      SELECT COUNT(*)::int AS overlapping_pairs,
        COUNT(DISTINCT first_id)::int + COUNT(DISTINCT second_id)::int AS relationship_endpoints,
        COUNT(DISTINCT signature)::int AS exact_signature_groups,
        COALESCE(jsonb_agg(jsonb_build_object(
          'firstAlertId', first_id,
          'secondAlertId', second_id,
          'source', source,
          'entityKey', entity_key
        ) ORDER BY first_id, second_id), '[]'::jsonb) AS pairs
      FROM pairs
    `),
  ]);

  const relationshipDiagnostics = await Promise.all(
    (duplicateAudit.rows[0]?.pairs || []).slice(0, 6).map(async (pair) => ({
      firstAlertId: pair.firstAlertId,
      secondAlertId: pair.secondAlertId,
      first: await service.notificationRelationship(pair.firstAlertId, pair.source),
      second: await service.notificationRelationship(pair.secondAlertId, pair.source),
    })),
  );
  const firstPair = duplicateAudit.rows[0]?.pairs?.[0];
  const relationshipRows = firstPair ? await db.query(`
    WITH target AS (
      SELECT learning_alert_signature_v1 AS signature, learning_entity_key_v1 AS entity_key
      FROM alerts WHERE id = $1
    )
    SELECT alert.id,
      COALESCE(alert.raw_payload->>'integrationName', alert.raw_payload->>'source', alert.source) AS source_name,
      alert.received_at, COALESCE(alert.last_seen_at, alert.received_at) AS last_seen_at
    FROM alerts alert CROSS JOIN target
    WHERE alert.learning_alert_signature_v1 = target.signature
      AND alert.learning_entity_key_v1 IS NOT DISTINCT FROM target.entity_key
      AND alert.atlassian_ops_alert_id IS NOT NULL
      AND alert.received_at >= NOW() - INTERVAL '24 hours'
    ORDER BY alert.received_at, alert.id
  `, [firstPair.firstAlertId]) : { rows: [] };
  process.stdout.write(`${JSON.stringify({
    policy: POLICY,
    summary: population.summary,
    behaviorDecisionMatrix: behavior.rows,
    transitions: transitions.rows,
    fixedPhase12Cohort: fixedCohort.rows[0],
    fixedPhase12CohortSources: fixedCohortSources.rows,
    representativeSamples: samples.rows,
    duplicateAudit: duplicateAudit.rows[0],
    relationshipDiagnostics,
    relationshipRows: relationshipRows.rows,
    sourceMutations: 0,
    automaticActions: 0,
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ safeError: error.code || error.message, message: error.message })}\n`);
  process.exitCode = 1;
}).finally(async () => {
  await db.pool.end();
});
