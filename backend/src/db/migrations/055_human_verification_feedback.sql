-- Canonical append-only human verification and Slack delivery state.
-- Human feedback remains separate from deterministic evaluations and model output.

CREATE TABLE IF NOT EXISTS human_verification_feedback (
  feedback_id TEXT PRIMARY KEY,
  alert_id TEXT NOT NULL REFERENCES alerts(id) ON DELETE RESTRICT,
  episode_id TEXT NOT NULL,
  evaluation_id TEXT NOT NULL REFERENCES live_shadow_evaluations(evaluation_id) ON DELETE RESTRICT,
  decision_revision TEXT NOT NULL,
  evidence_revision TEXT NOT NULL,
  deterministic_decision TEXT NOT NULL CHECK (
    deterministic_decision IN ('INCIDENT', 'NOISE', 'NEEDS_REVIEW')
  ),
  deterministic_subtype TEXT,
  source TEXT,
  priority TEXT,
  model_prediction TEXT CHECK (
    model_prediction IS NULL OR model_prediction IN ('INCIDENT', 'NOISE', 'NEEDS_REVIEW')
  ),
  model_version TEXT,
  model_score DOUBLE PRECISION CHECK (
    model_score IS NULL OR (model_score >= 0 AND model_score <= 1)
  ),
  model_scores JSONB NOT NULL DEFAULT '{}'::jsonb,
  human_decision TEXT NOT NULL CHECK (
    human_decision IN ('INCIDENT', 'NOISE', 'NEEDS_REVIEW')
  ),
  human_subtype TEXT,
  reason_code TEXT,
  comment TEXT,
  responder_id TEXT NOT NULL,
  responder_display_name TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('SLACK', 'WEB')),
  slack_channel_id TEXT,
  slack_message_ts TEXT,
  feature_snapshot_id TEXT REFERENCES ml_feature_snapshots(feature_snapshot_id) ON DELETE RESTRICT,
  prediction_id TEXT,
  status TEXT NOT NULL CHECK (
    status IN ('PENDING_VALIDATION', 'VALIDATED', 'REJECTED', 'SUPERSEDED', 'HUMAN_FEEDBACK_CONFLICT')
  ),
  validation_code TEXT,
  training_eligible BOOLEAN NOT NULL DEFAULT FALSE,
  training_exclusion_reason TEXT,
  is_test BOOLEAN NOT NULL DEFAULT FALSE,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Idempotent upgrades for databases that first loaded the Phase 11 draft.
ALTER TABLE human_verification_feedback ADD COLUMN IF NOT EXISTS source TEXT;
ALTER TABLE human_verification_feedback ADD COLUMN IF NOT EXISTS priority TEXT;
ALTER TABLE human_verification_feedback ADD COLUMN IF NOT EXISTS model_scores JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE human_verification_feedback ADD COLUMN IF NOT EXISTS prediction_id TEXT;
ALTER TABLE human_verification_feedback ADD COLUMN IF NOT EXISTS training_eligible BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE human_verification_feedback ADD COLUMN IF NOT EXISTS training_exclusion_reason TEXT;
ALTER TABLE human_verification_feedback ADD COLUMN IF NOT EXISTS is_test BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE human_verification_feedback DROP CONSTRAINT IF EXISTS human_verification_feedback_status_check;
ALTER TABLE human_verification_feedback ADD CONSTRAINT human_verification_feedback_status_check CHECK (
  status IN ('PENDING_VALIDATION', 'VALIDATED', 'REJECTED', 'SUPERSEDED', 'HUMAN_FEEDBACK_CONFLICT')
);

CREATE INDEX IF NOT EXISTS idx_human_verification_feedback_alert_time
  ON human_verification_feedback(alert_id, created_at DESC, feedback_id DESC);
CREATE INDEX IF NOT EXISTS idx_human_verification_feedback_episode_time
  ON human_verification_feedback(episode_id, created_at DESC, feedback_id DESC);
CREATE INDEX IF NOT EXISTS idx_human_verification_feedback_status_time
  ON human_verification_feedback(status, created_at DESC);

CREATE TABLE IF NOT EXISTS human_verification_prediction_snapshots (
  prediction_id TEXT PRIMARY KEY,
  alert_id TEXT NOT NULL REFERENCES alerts(id) ON DELETE RESTRICT,
  episode_id TEXT NOT NULL,
  evaluation_id TEXT NOT NULL REFERENCES live_shadow_evaluations(evaluation_id) ON DELETE RESTRICT,
  feature_snapshot_id TEXT NOT NULL REFERENCES ml_feature_snapshots(feature_snapshot_id) ON DELETE RESTRICT,
  model_version TEXT NOT NULL,
  prediction_status TEXT NOT NULL CHECK (prediction_status IN ('AVAILABLE', 'MODEL_NOT_TRAINED', 'PREDICTION_FAILED')),
  predicted_class TEXT CHECK (predicted_class IS NULL OR predicted_class IN ('INCIDENT', 'NOISE', 'NEEDS_REVIEW')),
  p_incident DOUBLE PRECISION,
  p_noise DOUBLE PRECISION,
  p_needs_review DOUBLE PRECISION,
  model_score DOUBLE PRECISION,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (evaluation_id, feature_snapshot_id)
);

CREATE TABLE IF NOT EXISTS human_verification_deliveries (
  delivery_id TEXT PRIMARY KEY,
  alert_id TEXT NOT NULL REFERENCES alerts(id) ON DELETE RESTRICT,
  episode_id TEXT NOT NULL,
  evaluation_id TEXT NOT NULL REFERENCES live_shadow_evaluations(evaluation_id) ON DELETE RESTRICT,
  decision_revision TEXT NOT NULL,
  evidence_revision TEXT NOT NULL,
  slack_channel_id TEXT NOT NULL,
  slack_message_ts TEXT,
  status TEXT NOT NULL CHECK (status IN (
    'PENDING', 'SENT', 'VERIFIED', 'EVIDENCE_CHANGED', 'VERIFICATION_DELIVERY_FAILED'
  )),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error_code TEXT,
  is_test BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (evaluation_id)
);
ALTER TABLE human_verification_deliveries ADD COLUMN IF NOT EXISTS is_test BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_human_verification_deliveries_status_time
  ON human_verification_deliveries(status, updated_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_human_verification_deliveries_episode
  ON human_verification_deliveries(episode_id);

CREATE TABLE IF NOT EXISTS human_verification_test_runs (
  test_run_id TEXT PRIMARY KEY,
  slack_channel_id TEXT NOT NULL,
  slack_message_ts TEXT,
  status TEXT NOT NULL CHECK (status IN (
    'PENDING', 'SENT', 'VALIDATED', 'EVIDENCE_CHANGED', 'DELIVERY_FAILED'
  )),
  synthetic_context JSONB NOT NULL,
  feedback JSONB,
  responder_id TEXT,
  responder_display_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS human_verification_security_events (
  security_event_id BIGSERIAL PRIMARY KEY,
  event_type TEXT NOT NULL CHECK (event_type IN ('INVALID_SLACK_SIGNATURE', 'SLACK_REPLAY_REJECTED')),
  safe_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_human_verification_security_events_type_time
  ON human_verification_security_events(event_type, created_at DESC);

-- Keep the existing operational-outcome projection compatible with the richer
-- canonical feedback vocabulary used by Slack and web verification.
DO $$
DECLARE
  constraint_row RECORD;
BEGIN
  FOR constraint_row IN
    SELECT constraint_name
    FROM information_schema.check_constraints
    WHERE constraint_schema = current_schema()
      AND constraint_name IN (
        SELECT constraint_name FROM information_schema.constraint_column_usage
        WHERE table_schema = current_schema()
          AND table_name = 'alert_occurrence_outcomes'
          AND column_name = 'reason_code'
      )
      AND check_clause LIKE '%CONFIRMED_NOISE%'
  LOOP
    EXECUTE format('ALTER TABLE alert_occurrence_outcomes DROP CONSTRAINT IF EXISTS %I', constraint_row.constraint_name);
  END LOOP;
END $$;
ALTER TABLE alert_occurrence_outcomes
  ADD CONSTRAINT alert_occurrence_outcomes_noise_reason_v3_check
  CHECK (outcome <> 'CONFIRMED_NOISE' OR reason_code IN (
    'REPEAT', 'DUPLICATE', 'AUTO_RESOLVED', 'FLAPPING', 'CORRELATED',
    'NON_ACTIONABLE', 'INFORMATIONAL', 'STALE', 'EXPECTED_ACTIVITY',
    'TRANSIENT', 'EXPECTED_BEHAVIOR', 'FALSE_POSITIVE', 'OTHER'
  ));

-- Existing training examples keep their legacy outcome reference for audit.
-- New supervised examples point at the canonical verification feedback row.
ALTER TABLE ml_training_examples
  ALTER COLUMN feedback_id DROP NOT NULL;
ALTER TABLE ml_training_examples
  ADD COLUMN IF NOT EXISTS human_feedback_id TEXT
    REFERENCES human_verification_feedback(feedback_id) ON DELETE RESTRICT;
ALTER TABLE ml_training_examples
  DROP CONSTRAINT IF EXISTS ml_training_examples_feedback_source_check;
ALTER TABLE ml_training_examples
  ADD CONSTRAINT ml_training_examples_feedback_source_check CHECK (
    (feedback_id IS NOT NULL AND human_feedback_id IS NULL)
    OR (feedback_id IS NULL AND human_feedback_id IS NOT NULL)
  );
CREATE UNIQUE INDEX IF NOT EXISTS idx_ml_training_examples_human_feedback_snapshot
  ON ml_training_examples(human_feedback_id, feature_snapshot_id)
  WHERE human_feedback_id IS NOT NULL;

-- Rebuild because append-only schema upgrades can add columns before the
-- ranked helper column; CREATE OR REPLACE cannot reorder an existing view.
DROP VIEW IF EXISTS validated_human_feedback_v1;
CREATE VIEW validated_human_feedback_v1 AS
WITH episode_state AS (
  SELECT alert_id, episode_id,
    COUNT(DISTINCT human_decision) FILTER (WHERE status = 'VALIDATED') AS validated_decisions,
    BOOL_OR(validation_code = 'HUMAN_FEEDBACK_CONFLICT') AS has_conflict
  FROM human_verification_feedback
  GROUP BY alert_id, episode_id
), ranked AS (
  SELECT feedback.*,
    ROW_NUMBER() OVER (
      PARTITION BY feedback.alert_id, feedback.episode_id
      ORDER BY feedback.created_at DESC, feedback.feedback_id DESC
    ) AS episode_rank
  FROM human_verification_feedback feedback
  WHERE feedback.status = 'VALIDATED'
)
SELECT ranked.*
FROM ranked
JOIN episode_state USING (alert_id, episode_id)
WHERE ranked.episode_rank = 1
  AND episode_state.validated_decisions = 1
  AND NOT episode_state.has_conflict
  AND COALESCE(ranked.metadata->>'groupingDisposition', '') NOT IN (
    'GROUPING_SUPERSEDED', 'LEGACY_GROUPING_REQUIRES_REPLAY'
  )
  AND ranked.training_eligible
  AND NOT ranked.is_test;

COMMENT ON TABLE human_verification_feedback IS
  'Append-only human decisions from authenticated web users or signature-verified Slack responders.';
COMMENT ON VIEW validated_human_feedback_v1 IS
  'One conflict-free, current-revision human gold label per canonical episode.';
