-- Phase 7: normalized unified evidence and decision scaffold.
--
-- The added fields remain shadow-only. evidence_score is explicitly not a
-- calibrated probability and cannot enable a production action.

ALTER TABLE live_shadow_evaluations
  ADD COLUMN IF NOT EXISTS evidence_score DOUBLE PRECISION
    CHECK (evidence_score IS NULL OR (evidence_score >= 0 AND evidence_score <= 1)),
  ADD COLUMN IF NOT EXISTS decision_confidence TEXT NOT NULL DEFAULT 'NOT_CALIBRATED'
    CHECK (decision_confidence = 'NOT_CALIBRATED'),
  ADD COLUMN IF NOT EXISTS decision_policy TEXT NOT NULL DEFAULT 'UNIFIED_EVIDENCE_SHADOW_V1',
  ADD COLUMN IF NOT EXISTS evaluation_status TEXT NOT NULL DEFAULT 'EXPERIMENTAL_SHADOW'
    CHECK (evaluation_status = 'EXPERIMENTAL_SHADOW'),
  ADD COLUMN IF NOT EXISTS feedback_status TEXT NOT NULL DEFAULT 'UNLABELED'
    CHECK (feedback_status IN ('UNLABELED', 'CONFIRMED', 'CORRECTED')),
  ADD COLUMN IF NOT EXISTS evidence_vector JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS source_details JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS source_provenance JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS observability JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_live_shadow_evaluations_evidence_score
  ON live_shadow_evaluations(evidence_score DESC, feature_as_of DESC);

CREATE OR REPLACE VIEW live_shadow_evaluations_latest_v1 AS
SELECT DISTINCT ON (evaluation.alert_id) evaluation.*
FROM live_shadow_evaluations evaluation
ORDER BY evaluation.alert_id, evaluation.created_at DESC, evaluation.feature_as_of DESC;

COMMENT ON COLUMN live_shadow_evaluations.evidence_score IS
  'Transparent Phase 7 evidence strength. Not calibrated probability or ML confidence.';
COMMENT ON COLUMN live_shadow_evaluations.decision_policy IS
  'Versioned analytical recommendation scaffold. Never a production action policy.';
COMMENT ON COLUMN live_shadow_evaluations.evidence_vector IS
  'Independent normalized evidence dimensions with reasons and provenance.';

DO $$
DECLARE
  existing_constraint TEXT;
BEGIN
  SELECT constraint_name INTO existing_constraint
  FROM information_schema.check_constraints
  WHERE constraint_schema = current_schema()
    AND constraint_name IN (
      SELECT constraint_name FROM information_schema.constraint_column_usage
      WHERE table_schema = current_schema()
        AND table_name = 'alert_occurrence_outcomes'
        AND column_name = 'reason_code'
    )
    AND check_clause LIKE '%CONFIRMED_NOISE%'
  LIMIT 1;
  IF existing_constraint IS NOT NULL THEN
    EXECUTE format('ALTER TABLE alert_occurrence_outcomes DROP CONSTRAINT %I', existing_constraint);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'alert_occurrence_outcomes'::regclass
      AND conname = 'alert_occurrence_outcomes_noise_reason_v2_check'
  ) THEN
    ALTER TABLE alert_occurrence_outcomes
      ADD CONSTRAINT alert_occurrence_outcomes_noise_reason_v2_check
      CHECK (outcome <> 'CONFIRMED_NOISE' OR reason_code IN (
        'AUTO_RESOLVED', 'DUPLICATE', 'FLAPPING', 'NON_ACTIONABLE',
        'CORRELATED', 'STALE', 'EXPECTED_ACTIVITY', 'TRANSIENT',
        'EXPECTED_BEHAVIOR', 'FALSE_POSITIVE', 'OTHER'
      ));
  END IF;
END $$;
