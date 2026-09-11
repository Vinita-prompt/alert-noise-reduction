-- Phase 13: append-only decision-quality audit surfaces.
--
-- Phase 12 rows remain immutable. Phase 13 recommendations remain shadow-only
-- and never create an operational outcome, training label, or source mutation.

CREATE INDEX IF NOT EXISTS idx_live_shadow_evaluations_policy_alert_time
  ON live_shadow_evaluations(decision_policy, alert_id, created_at DESC);

CREATE OR REPLACE VIEW phase13_decision_changes_v1 AS
WITH phase13 AS (
  SELECT DISTINCT ON (evaluation.alert_id) evaluation.*
  FROM live_shadow_evaluations evaluation
  WHERE evaluation.decision_policy = 'PHASE13_DECISION_QUALITY_SHADOW_V1'
  ORDER BY evaluation.alert_id, evaluation.created_at DESC, evaluation.feature_as_of DESC
),
phase12 AS (
  SELECT DISTINCT ON (evaluation.alert_id) evaluation.*
  FROM live_shadow_evaluations evaluation
  WHERE evaluation.decision_policy = 'PHASE12_EXHAUSTIVE_EVIDENCE_RESULTS_V2'
  ORDER BY evaluation.alert_id, evaluation.created_at DESC, evaluation.feature_as_of DESC
)
SELECT
  phase13.alert_id,
  phase12.evaluation_id AS old_evaluation_id,
  phase13.evaluation_id AS new_evaluation_id,
  phase12.final_decision AS old_decision,
  phase13.final_decision AS new_decision,
  jsonb_build_object(
    'noiseDetection', phase12.noise_detection,
    'classification', phase12.classification,
    'businessImpact', phase12.business_impact,
    'actionability', phase12.actionability,
    'underlyingEvent', phase12.underlying_event,
    'notificationRole', phase12.notification_role
  ) AS old_dimensions,
  jsonb_build_object(
    'noiseDetection', phase13.noise_detection,
    'classification', phase13.classification,
    'businessImpact', phase13.business_impact,
    'actionability', phase13.actionability,
    'underlyingEvent', phase13.underlying_event,
    'notificationRole', phase13.notification_role
  ) AS new_dimensions,
  phase13.explanation->'reasons' AS reason_for_change,
  phase13.evidence_references,
  phase13.decision_policy AS policy_version,
  phase13.created_at AS changed_at
FROM phase13
JOIN phase12 ON phase12.alert_id = phase13.alert_id
WHERE phase12.final_decision IS DISTINCT FROM phase13.final_decision;

COMMENT ON VIEW phase13_decision_changes_v1 IS
  'Append-only Phase 12 to Phase 13 shadow recommendation changes with dimensions and evidence provenance.';
