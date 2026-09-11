-- Phase 14: monitoring lifecycle and historical source evidence.
--
-- Evaluation rows remain append-only and shadow-only. This migration preserves
-- the verified Phase 13 cohort and exposes Phase 14 comparisons without
-- updating any prior recommendation or human outcome.

CREATE TABLE IF NOT EXISTS shadow_policy_baselines (
  policy_version TEXT NOT NULL,
  cohort_name TEXT NOT NULL,
  total_alerts INTEGER NOT NULL CHECK (total_alerts >= 0),
  incident INTEGER NOT NULL CHECK (incident >= 0),
  noise INTEGER NOT NULL CHECK (noise >= 0),
  needs_review INTEGER NOT NULL CHECK (needs_review >= 0),
  provenance JSONB NOT NULL DEFAULT '{}'::jsonb,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (policy_version, cohort_name),
  CHECK (incident + noise + needs_review = total_alerts)
);

INSERT INTO shadow_policy_baselines (
  policy_version, cohort_name, total_alerts, incident, noise, needs_review, provenance
) VALUES (
  'PHASE13_DECISION_QUALITY_SHADOW_V1',
  'PHASE13_VERIFIED_95_ALERT_COHORT',
  95, 33, 6, 56,
  '{"source":"phase14_requirement","immutable":true,"humanReviews":0,"externalMutations":0}'::jsonb
) ON CONFLICT (policy_version, cohort_name) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_live_shadow_evaluations_phase14_history
  ON live_shadow_evaluations(alert_id, decision_policy, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_live_shadow_evaluations_monitoring_lifecycle_gin
  ON live_shadow_evaluations USING GIN ((technical_evidence->'monitoringLifecycle'));

CREATE OR REPLACE VIEW phase14_decision_changes_v1 AS
WITH phase14 AS (
  SELECT DISTINCT ON (evaluation.alert_id) evaluation.*
  FROM live_shadow_evaluations evaluation
  WHERE evaluation.decision_policy = 'PHASE14_MONITORING_LIFECYCLE_V1'
  ORDER BY evaluation.alert_id, evaluation.created_at DESC, evaluation.feature_as_of DESC
),
phase13 AS (
  SELECT DISTINCT ON (evaluation.alert_id) evaluation.*
  FROM live_shadow_evaluations evaluation
  WHERE evaluation.decision_policy = 'PHASE13_DECISION_QUALITY_SHADOW_V1'
  ORDER BY evaluation.alert_id, evaluation.created_at DESC, evaluation.feature_as_of DESC
)
SELECT
  phase14.alert_id,
  phase13.evaluation_id AS old_evaluation_id,
  phase14.evaluation_id AS new_evaluation_id,
  phase13.final_decision AS old_decision,
  phase14.final_decision AS new_decision,
  phase14.explanation->'reasons' AS reason_for_change,
  phase14.technical_evidence->'monitoringLifecycle' AS monitoring_lifecycle,
  phase14.evidence_references,
  phase14.decision_policy AS policy_version,
  phase14.created_at AS changed_at
FROM phase14
JOIN phase13 ON phase13.alert_id = phase14.alert_id
WHERE phase13.final_decision IS DISTINCT FROM phase14.final_decision;

CREATE OR REPLACE VIEW phase14_monitoring_lifecycle_v1 AS
SELECT DISTINCT ON (evaluation.alert_id)
  evaluation.alert_id,
  evaluation.evaluation_id,
  evaluation.source,
  evaluation.final_decision,
  evaluation.technical_evidence->'monitoringLifecycle' AS monitoring_lifecycle,
  evaluation.technical_evidence->'monitoringLifecycle'->'historicalBehavior' AS historical_behavior,
  evaluation.technical_evidence->'monitoringLifecycle'->'deviationFromHistory' AS deviation_from_history,
  evaluation.technical_evidence->'monitoringLifecycle'->'intervention' AS intervention,
  evaluation.technical_evidence->'monitoringLifecycle'->'signals' AS evidence_signals,
  evaluation.created_at
FROM live_shadow_evaluations evaluation
WHERE evaluation.decision_policy = 'PHASE14_MONITORING_LIFECYCLE_V1'
ORDER BY evaluation.alert_id, evaluation.created_at DESC, evaluation.feature_as_of DESC;

COMMENT ON TABLE shadow_policy_baselines IS
  'Immutable verified shadow-policy cohort totals. These are not labels and do not modify evaluation history.';
COMMENT ON VIEW phase14_decision_changes_v1 IS
  'Append-only Phase 13 to Phase 14 recommendation changes with normalized lifecycle evidence.';
COMMENT ON VIEW phase14_monitoring_lifecycle_v1 IS
  'Latest normalized monitoring lifecycle and stored 90-day historical evidence for each Phase 14 evaluation.';
