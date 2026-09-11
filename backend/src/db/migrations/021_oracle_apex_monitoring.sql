CREATE TABLE IF NOT EXISTS apex_jobs (
  source_tool TEXT NOT NULL DEFAULT 'oracle-apex',
  application_name TEXT NOT NULL DEFAULT 'PF & ETL Dashboard',
  entity_id TEXT NOT NULL,
  entity_name TEXT,
  environment TEXT NOT NULL DEFAULT 'production',
  entity_type TEXT NOT NULL DEFAULT 'apex_job',
  status TEXT NOT NULL DEFAULT 'unknown',
  severity TEXT NOT NULL DEFAULT 'medium',
  summary TEXT,
  timestamp TIMESTAMPTZ,
  last_updated TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  row_values JSONB NOT NULL DEFAULT '{}'::jsonb,
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  entity_hash TEXT,
  deep_link TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (source_tool, application_name, entity_id)
);

CREATE TABLE IF NOT EXISTS apex_history (
  id BIGSERIAL PRIMARY KEY,
  source_tool TEXT NOT NULL DEFAULT 'oracle-apex',
  application_name TEXT NOT NULL DEFAULT 'PF & ETL Dashboard',
  entity_id TEXT NOT NULL,
  entity_name TEXT,
  status TEXT,
  severity TEXT,
  snapshot_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  timestamp TIMESTAMPTZ,
  execution_duration_seconds INTEGER,
  row_values JSONB NOT NULL DEFAULT '{}'::jsonb,
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS apex_sync_history (
  id BIGSERIAL PRIMARY KEY,
  source_tool TEXT NOT NULL DEFAULT 'oracle-apex',
  application_name TEXT NOT NULL DEFAULT 'PF & ETL Dashboard',
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  duration_ms INTEGER,
  result TEXT NOT NULL DEFAULT 'running',
  failure_stage TEXT,
  failure_type TEXT,
  failure_reason TEXT,
  response_time_ms INTEGER,
  records_retrieved INTEGER NOT NULL DEFAULT 0,
  records_inserted INTEGER NOT NULL DEFAULT 0,
  records_updated INTEGER NOT NULL DEFAULT 0,
  records_skipped INTEGER NOT NULL DEFAULT 0,
  raw_payload_id BIGINT
);

CREATE TABLE IF NOT EXISTS apex_dynamic_columns (
  source_tool TEXT NOT NULL DEFAULT 'oracle-apex',
  application_name TEXT NOT NULL DEFAULT 'PF & ETL Dashboard',
  column_key TEXT NOT NULL,
  column_name TEXT,
  column_label TEXT,
  column_type TEXT,
  display_order INTEGER,
  hidden BOOLEAN NOT NULL DEFAULT FALSE,
  visible BOOLEAN NOT NULL DEFAULT TRUE,
  sort_info JSONB NOT NULL DEFAULT '{}'::jsonb,
  formatting JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (source_tool, application_name, column_key)
);

CREATE TABLE IF NOT EXISTS apex_ai_features (
  source_tool TEXT NOT NULL DEFAULT 'oracle-apex',
  application_name TEXT NOT NULL DEFAULT 'PF & ETL Dashboard',
  entity_id TEXT NOT NULL,
  entity_name TEXT,
  feature_timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  execution_duration_seconds INTEGER,
  average_runtime_seconds NUMERIC,
  minimum_runtime_seconds INTEGER,
  maximum_runtime_seconds INTEGER,
  runtime_variance NUMERIC,
  runtime_stddev NUMERIC,
  execution_frequency NUMERIC,
  execution_trend TEXT,
  schedule_delay_seconds INTEGER,
  schedule_compliance_score NUMERIC,
  missed_schedule_count INTEGER NOT NULL DEFAULT 0,
  consecutive_successes INTEGER NOT NULL DEFAULT 0,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  failure_rate NUMERIC,
  success_rate NUMERIC,
  historical_failure_count INTEGER NOT NULL DEFAULT 0,
  historical_success_count INTEGER NOT NULL DEFAULT 0,
  recovery_count INTEGER NOT NULL DEFAULT 0,
  recovery_time_seconds INTEGER,
  running_time_seconds INTEGER,
  current_runtime_seconds INTEGER,
  queue_wait_time_seconds INTEGER,
  dependency_count INTEGER NOT NULL DEFAULT 0,
  dependency_delay_seconds INTEGER,
  business_impact_score NUMERIC,
  job_stability_score NUMERIC,
  runtime_stability_score NUMERIC,
  historical_trend TEXT,
  alert_frequency NUMERIC,
  alert_density NUMERIC,
  recurrence_count INTEGER NOT NULL DEFAULT 0,
  execution_volatility NUMERIC,
  execution_anomaly_score NUMERIC,
  historical_percentile NUMERIC,
  runtime_percentile NUMERIC,
  failure_percentile NUMERIC,
  noise_probability NUMERIC,
  incident_probability NUMERIC,
  risk_score NUMERIC,
  root_cause_confidence NUMERIC,
  prediction_confidence NUMERIC,
  correlation_keys JSONB NOT NULL DEFAULT '{}'::jsonb,
  ai_label TEXT NOT NULL DEFAULT 'unknown',
  ai_reason TEXT,
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (source_tool, application_name, entity_id)
);

CREATE TABLE IF NOT EXISTS apex_raw_payloads (
  id BIGSERIAL PRIMARY KEY,
  source_tool TEXT NOT NULL DEFAULT 'oracle-apex',
  application_name TEXT NOT NULL DEFAULT 'PF & ETL Dashboard',
  payload_hash TEXT NOT NULL,
  page_number INTEGER,
  first_row INTEGER,
  max_rows INTEGER,
  record_count INTEGER NOT NULL DEFAULT 0,
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE monitoring_records ADD COLUMN IF NOT EXISTS entity_name TEXT;

CREATE INDEX IF NOT EXISTS idx_apex_jobs_status
  ON apex_jobs(status, last_seen_at DESC);

CREATE INDEX IF NOT EXISTS idx_apex_jobs_entity
  ON apex_jobs(entity_name);

CREATE INDEX IF NOT EXISTS idx_apex_history_entity
  ON apex_history(entity_id, snapshot_at DESC);

CREATE INDEX IF NOT EXISTS idx_apex_sync_history_started
  ON apex_sync_history(started_at DESC);

CREATE INDEX IF NOT EXISTS idx_apex_ai_features_risk
  ON apex_ai_features(risk_score, feature_timestamp DESC);
