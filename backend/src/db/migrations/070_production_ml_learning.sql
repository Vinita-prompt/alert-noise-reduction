-- Durable, restart-safe shadow learning jobs and persistent model metadata.
-- Pending evidence and unconfirmed outcomes are never admitted as labels.

ALTER TABLE ml_model_registry
  ADD COLUMN IF NOT EXISTS training_data_start TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS training_data_end TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS artifact_storage_backend TEXT NOT NULL DEFAULT 'FILESYSTEM',
  ADD COLUMN IF NOT EXISTS artifact_sha256 TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ml_training_examples_confirmed_labels_only_check'
  ) THEN
    ALTER TABLE ml_training_examples
      ADD CONSTRAINT ml_training_examples_confirmed_labels_only_check
      CHECK (gold_decision IN ('INCIDENT', 'NOISE')) NOT VALID;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS ml_learning_jobs (
  job_id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  job_type TEXT NOT NULL CHECK (job_type IN ('RETRAIN', 'PREDICT')),
  trigger_type TEXT NOT NULL CHECK (trigger_type IN (
    'CONFIRMED_LABEL', 'EVIDENCE_REVISION', 'SCHEDULED', 'MANUAL'
  )),
  trigger_reference TEXT,
  alert_id TEXT REFERENCES alerts(id) ON DELETE RESTRICT,
  evaluation_id TEXT REFERENCES live_shadow_evaluations(evaluation_id) ON DELETE RESTRICT,
  evidence_revision TEXT,
  status TEXT NOT NULL DEFAULT 'QUEUED' CHECK (status IN (
    'QUEUED', 'RUNNING', 'RETRY', 'SUCCEEDED', 'SKIPPED', 'FAILED'
  )),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  lease_until TIMESTAMPTZ,
  worker_id TEXT,
  model_id TEXT REFERENCES ml_model_registry(model_id) ON DELETE RESTRICT,
  dataset_version TEXT,
  result JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_error_code TEXT,
  last_error TEXT,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ml_learning_jobs_work
  ON ml_learning_jobs(status, available_at, requested_at)
  WHERE status IN ('QUEUED', 'RETRY', 'RUNNING');

CREATE INDEX IF NOT EXISTS idx_ml_learning_jobs_alert_time
  ON ml_learning_jobs(alert_id, requested_at DESC)
  WHERE alert_id IS NOT NULL;

COMMENT ON TABLE ml_learning_jobs IS
  'Durable shadow-only retraining and prediction work. Evidence is committed before jobs are queued.';
COMMENT ON CONSTRAINT ml_training_examples_confirmed_labels_only_check ON ml_training_examples IS
  'New supervised examples must be confirmed human Incident or Noise labels; historical rows remain auditable.';
