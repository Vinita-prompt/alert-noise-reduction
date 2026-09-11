-- Separate operational observation text from general comments and retain
-- controlled Slack validation feedback in an append-only, non-training table.

ALTER TABLE human_verification_feedback
  ADD COLUMN IF NOT EXISTS human_evidence_text TEXT;

CREATE TABLE IF NOT EXISTS human_verification_test_feedback (
  feedback_id TEXT PRIMARY KEY,
  test_run_id TEXT NOT NULL REFERENCES human_verification_test_runs(test_run_id) ON DELETE RESTRICT,
  alert_id TEXT NOT NULL,
  episode_id TEXT NOT NULL,
  source TEXT NOT NULL,
  priority TEXT NOT NULL,
  system_decision TEXT NOT NULL CHECK (system_decision IN ('INCIDENT', 'NOISE', 'NEEDS_REVIEW')),
  system_subtype TEXT,
  model_prediction TEXT CHECK (model_prediction IS NULL OR model_prediction IN ('INCIDENT', 'NOISE', 'NEEDS_REVIEW')),
  model_version TEXT NOT NULL,
  model_scores JSONB NOT NULL DEFAULT '{}'::jsonb,
  human_decision TEXT NOT NULL CHECK (human_decision IN ('INCIDENT', 'NOISE', 'NEEDS_REVIEW')),
  human_subtype TEXT,
  reason_code TEXT NOT NULL,
  human_evidence_text TEXT NOT NULL,
  human_comment TEXT,
  responder_slack_user_id TEXT NOT NULL,
  responder_display_name TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message_ts TEXT NOT NULL,
  decision_revision TEXT NOT NULL,
  evidence_revision TEXT NOT NULL,
  feature_snapshot_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('VALIDATED', 'REJECTED')),
  validation_code TEXT NOT NULL,
  training_eligible BOOLEAN NOT NULL DEFAULT FALSE CHECK (training_eligible = FALSE),
  training_exclusion_reason TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_human_verification_test_feedback_run_time
  ON human_verification_test_feedback(test_run_id, created_at DESC, feedback_id DESC);

COMMENT ON TABLE human_verification_test_feedback IS
  'Append-only synthetic controlled-test feedback. Rows are structurally prohibited from becoming training eligible.';
