-- Phase 11: authoritative human gold review over immutable shadow evaluations.
--
-- Reviews remain append-only in alert_occurrence_outcomes. The reviewed
-- evaluation is referenced from evidence.evaluationId so later shadow runs
-- cannot overwrite the original recommendation or prediction-time features.

DO $$
DECLARE
  constraint_row RECORD;
BEGIN
  FOR constraint_row IN
    SELECT constraint_name
    FROM information_schema.check_constraints
    WHERE constraint_schema = current_schema()
      AND constraint_name IN (
        SELECT constraint_name
        FROM information_schema.constraint_column_usage
        WHERE table_schema = current_schema()
          AND table_name = 'alert_occurrence_outcomes'
      )
      AND (
        check_clause LIKE '%confirmation_method%'
        OR (check_clause LIKE '%CONFIRMED_INCIDENT%' AND check_clause LIKE '%linked_incident_key%')
      )
  LOOP
    EXECUTE format(
      'ALTER TABLE alert_occurrence_outcomes DROP CONSTRAINT IF EXISTS %I',
      constraint_row.constraint_name
    );
  END LOOP;
END $$;

ALTER TABLE alert_occurrence_outcomes
  DROP CONSTRAINT IF EXISTS alert_occurrence_outcomes_confirmation_method_phase11_check;

ALTER TABLE alert_occurrence_outcomes
  ADD CONSTRAINT alert_occurrence_outcomes_confirmation_method_phase11_check
  CHECK (confirmation_method IN (
    'HUMAN_CONFIRMED',
    'JIRA_CONFIRMED',
    'JIRA_CONFIRMED_HUMAN_REVIEWED'
  ));

CREATE INDEX IF NOT EXISTS idx_alert_occurrence_outcomes_reviewed_evaluation
  ON alert_occurrence_outcomes ((evidence->>'evaluationId'))
  WHERE evidence ? 'evaluationId';

CREATE OR REPLACE VIEW gold_review_dataset_v1 AS
SELECT
  outcome.id AS review_id,
  outcome.alert_id,
  outcome.outcome AS review_outcome,
  outcome.reason AS review_reason,
  outcome.reason_code,
  outcome.notes,
  outcome.recorded_by_id AS reviewer_id,
  outcome.recorded_by AS reviewer_name,
  outcome.recorded_at AS reviewed_at,
  outcome.supersedes_id AS previous_review_id,
  outcome.is_current,
  outcome.confirmation_method,
  outcome.linked_incident_id,
  outcome.linked_incident_key,
  outcome.evidence AS review_evidence,
  evaluation.evaluation_id,
  evaluation.source,
  evaluation.feature_as_of,
  evaluation.final_decision AS system_recommendation,
  evaluation.evidence_score AS system_evidence_score,
  evaluation.decision_policy AS system_policy_version,
  evaluation.model_version,
  evaluation.noise_detection,
  evaluation.classification,
  evaluation.business_impact,
  evaluation.actionability,
  evaluation.underlying_event,
  evaluation.notification_role,
  evaluation.feature_snapshot,
  evaluation.evidence_references,
  evaluation.source_provenance
FROM alert_occurrence_outcomes outcome
JOIN live_shadow_evaluations evaluation
  ON evaluation.evaluation_id = outcome.evidence->>'evaluationId'
  AND evaluation.alert_id = outcome.alert_id;

CREATE OR REPLACE VIEW training_dataset_preview_v1 AS
SELECT
  review_id,
  alert_id,
  CASE review_outcome
    WHEN 'CONFIRMED_NOISE' THEN 'NOISE'
    WHEN 'CONFIRMED_INCIDENT' THEN 'INCIDENT'
    ELSE NULL
  END AS label,
  source,
  feature_as_of,
  feature_snapshot,
  reviewer_id,
  reviewed_at,
  evaluation_id,
  system_recommendation,
  system_policy_version,
  evidence_references,
  source_provenance
FROM gold_review_dataset_v1
WHERE is_current
  AND review_outcome IN ('CONFIRMED_NOISE', 'CONFIRMED_INCIDENT');

COMMENT ON VIEW gold_review_dataset_v1 IS
  'Append-only human reviews joined to the exact immutable shadow evaluation reviewed by the operator.';

COMMENT ON VIEW training_dataset_preview_v1 IS
  'Read-only preview using original prediction-time features and explicit confirmed human outcomes only.';
