ALTER TABLE monitoring_records
  ADD COLUMN IF NOT EXISTS business_unit TEXT,
  ADD COLUMN IF NOT EXISTS currently_running BOOLEAN,
  ADD COLUMN IF NOT EXISTS execution_duration_seconds INTEGER,
  ADD COLUMN IF NOT EXISTS time_since_last_run_seconds INTEGER,
  ADD COLUMN IF NOT EXISTS time_until_next_run_seconds INTEGER,
  ADD COLUMN IF NOT EXISTS job_state TEXT;

CREATE TABLE IF NOT EXISTS abc_hub_daemon_ai_features (
  source_tool TEXT NOT NULL DEFAULT 'ABC Hub',
  module TEXT NOT NULL DEFAULT 'Daemon Monitor',
  entity_type TEXT NOT NULL DEFAULT 'daemon_job',
  entity_id TEXT NOT NULL,
  entity_name TEXT,
  business_unit TEXT,
  server TEXT,
  feature_timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  execution_duration_seconds INTEGER,
  average_execution_duration_seconds NUMERIC,
  maximum_execution_duration_seconds INTEGER,
  minimum_execution_duration_seconds INTEGER,
  missed_schedule_count INTEGER NOT NULL DEFAULT 0,
  late_execution_count INTEGER NOT NULL DEFAULT 0,
  recurrence_count INTEGER NOT NULL DEFAULT 0,
  stability_score NUMERIC,
  execution_frequency NUMERIC,
  downtime_score NUMERIC,
  running_duration_seconds INTEGER,
  historical_failure_count INTEGER NOT NULL DEFAULT 0,
  historical_success_count INTEGER NOT NULL DEFAULT 0,
  anomaly_score NUMERIC,
  noise_probability NUMERIC,
  incident_probability NUMERIC,
  ai_label TEXT NOT NULL DEFAULT 'unknown',
  ai_reason TEXT,
  raw_payload_reference TEXT,
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (source_tool, module, entity_id)
);

CREATE INDEX IF NOT EXISTS idx_abc_hub_daemon_ai_features_state
  ON abc_hub_daemon_ai_features(module, stability_score, feature_timestamp DESC);
