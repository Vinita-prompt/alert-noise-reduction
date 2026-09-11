CREATE TABLE IF NOT EXISTS monitoring_records (
  id BIGSERIAL PRIMARY KEY,
  source_tool TEXT NOT NULL,
  environment TEXT NOT NULL DEFAULT 'unknown',
  application_name TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  entity_name TEXT,
  status TEXT NOT NULL DEFAULT 'unknown',
  severity TEXT NOT NULL DEFAULT 'low',
  summary TEXT NOT NULL,
  details TEXT,
  acknowledged BOOLEAN NOT NULL DEFAULT FALSE,
  active BOOLEAN,
  running BOOLEAN,
  server TEXT,
  next_run_date TIMESTAMPTZ,
  last_start_date TIMESTAMPTZ,
  last_end_date TIMESTAMPTZ,
  has_insight BOOLEAN,
  last_check TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  deep_link TEXT,
  custom_properties JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (source_tool, entity_type, entity_id)
);

CREATE INDEX IF NOT EXISTS idx_monitoring_records_tool_app
  ON monitoring_records(source_tool, application_name);

CREATE INDEX IF NOT EXISTS idx_monitoring_records_status
  ON monitoring_records(source_tool, status);

CREATE INDEX IF NOT EXISTS idx_monitoring_records_updated
  ON monitoring_records(source_tool, updated_at DESC);
