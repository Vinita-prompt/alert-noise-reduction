CREATE TABLE IF NOT EXISTS monitoring_source_status (
  source_key TEXT PRIMARY KEY,
  adapter_name TEXT NOT NULL,
  connection_status TEXT NOT NULL DEFAULT 'not_configured',
  api_health TEXT NOT NULL DEFAULT 'not_configured',
  sync_status TEXT NOT NULL DEFAULT 'idle',
  last_successful_sync TIMESTAMPTZ,
  last_failed_sync TIMESTAMPTZ,
  last_alert_received_at TIMESTAMPTZ,
  total_alerts_imported INTEGER NOT NULL DEFAULT 0,
  last_sync_duration_ms INTEGER,
  response_time_ms INTEGER,
  last_error TEXT,
  sync_cursor TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_monitoring_source_status_updated
  ON monitoring_source_status(updated_at DESC);
