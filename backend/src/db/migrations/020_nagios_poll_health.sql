ALTER TABLE nagios_host_status
  ADD COLUMN IF NOT EXISTS entity_hash TEXT;

ALTER TABLE nagios_service_status
  ADD COLUMN IF NOT EXISTS entity_hash TEXT;

ALTER TABLE nagios_hosts
  ADD COLUMN IF NOT EXISTS entity_hash TEXT;

ALTER TABLE nagios_services
  ADD COLUMN IF NOT EXISTS entity_hash TEXT;

CREATE TABLE IF NOT EXISTS nagios_poll_history (
  id BIGSERIAL PRIMARY KEY,
  source_instance TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at TIMESTAMPTZ,
  duration_ms INTEGER,
  result TEXT NOT NULL DEFAULT 'running',
  failure_stage TEXT,
  failure_type TEXT,
  failure_reason TEXT,
  http_status INTEGER,
  response_time_ms INTEGER,
  retry_count INTEGER NOT NULL DEFAULT 0,
  records_retrieved INTEGER NOT NULL DEFAULT 0,
  records_inserted INTEGER NOT NULL DEFAULT 0,
  records_updated INTEGER NOT NULL DEFAULT 0,
  records_skipped INTEGER NOT NULL DEFAULT 0,
  records_failed INTEGER NOT NULL DEFAULT 0,
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS nagios_sync_statistics (
  source_instance TEXT PRIMARY KEY,
  total_polls INTEGER NOT NULL DEFAULT 0,
  successful_polls INTEGER NOT NULL DEFAULT 0,
  failed_polls INTEGER NOT NULL DEFAULT 0,
  last_successful_sync TIMESTAMPTZ,
  last_failed_sync TIMESTAMPTZ,
  average_response_time_ms NUMERIC,
  average_poll_duration_ms NUMERIC,
  records_retrieved INTEGER NOT NULL DEFAULT 0,
  records_inserted INTEGER NOT NULL DEFAULT 0,
  records_updated INTEGER NOT NULL DEFAULT 0,
  records_skipped INTEGER NOT NULL DEFAULT 0,
  records_failed INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS nagios_connector_health (
  source_instance TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'disconnected',
  connection_health TEXT NOT NULL DEFAULT 'disconnected',
  failure_stage TEXT,
  failure_type TEXT,
  failure_reason TEXT,
  http_status INTEGER,
  response_time_ms INTEGER,
  last_successful_poll TIMESTAMPTZ,
  last_failed_poll TIMESTAMPTZ,
  last_poll_started_at TIMESTAMPTZ,
  last_poll_ended_at TIMESTAMPTZ,
  records_retrieved INTEGER NOT NULL DEFAULT 0,
  records_inserted INTEGER NOT NULL DEFAULT 0,
  records_updated INTEGER NOT NULL DEFAULT 0,
  records_skipped INTEGER NOT NULL DEFAULT 0,
  retry_count INTEGER NOT NULL DEFAULT 0,
  next_scheduled_poll TIMESTAMPTZ,
  data_freshness_status TEXT NOT NULL DEFAULT 'red',
  data_freshness_seconds INTEGER,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_nagios_poll_history_started ON nagios_poll_history(source_instance, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_nagios_poll_history_result ON nagios_poll_history(source_instance, result, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_nagios_connector_health_status ON nagios_connector_health(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_nagios_host_status_hash ON nagios_host_status(instance_key, entity_hash);
CREATE INDEX IF NOT EXISTS idx_nagios_service_status_hash ON nagios_service_status(instance_key, entity_hash);
