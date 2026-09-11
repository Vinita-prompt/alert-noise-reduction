ALTER TABLE alerts ADD COLUMN IF NOT EXISTS atlassian_ops_alert_id TEXT;
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS atlassian_ops_tiny_id TEXT;
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS atlassian_ops_alias TEXT;
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS atlassian_last_synced_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS idx_alerts_jsm_ops_external_id
  ON alerts(source_alert_id)
  WHERE source = 'jsm_ops' AND source_alert_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS alert_activity_logs (
  id BIGSERIAL PRIMARY KEY,
  alert_id TEXT NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
  external_log_id TEXT,
  event_type TEXT NOT NULL DEFAULT 'activity',
  actor TEXT,
  message TEXT,
  activity_at TIMESTAMPTZ,
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (alert_id, external_log_id)
);

ALTER TABLE alert_notes ADD COLUMN IF NOT EXISTS external_note_id TEXT;
ALTER TABLE alert_notes ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'website';
ALTER TABLE alert_notes ADD COLUMN IF NOT EXISTS raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE alert_notes ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS idx_alert_notes_external_note_id
  ON alert_notes(alert_id, external_note_id)
  WHERE external_note_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS alert_responders (
  id BIGSERIAL PRIMARY KEY,
  alert_id TEXT NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
  responder_external_id TEXT,
  responder_type TEXT,
  responder_name TEXT,
  role TEXT,
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (alert_id, responder_external_id, responder_type)
);

CREATE TABLE IF NOT EXISTS alert_attachments (
  id BIGSERIAL PRIMARY KEY,
  alert_id TEXT NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
  external_attachment_id TEXT,
  file_name TEXT,
  content_type TEXT,
  size_bytes BIGINT,
  source_url TEXT,
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (alert_id, external_attachment_id)
);

CREATE TABLE IF NOT EXISTS atlassian_sync_state (
  sync_name TEXT PRIMARY KEY,
  checkpoint TIMESTAMPTZ,
  last_attempt_at TIMESTAMPTZ,
  last_successful_sync_at TIMESTAMPTZ,
  last_result TEXT,
  last_error_code TEXT,
  last_error_message TEXT,
  alerts_imported INTEGER NOT NULL DEFAULT 0,
  alerts_updated INTEGER NOT NULL DEFAULT 0,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS integration_sync_runs (
  id BIGSERIAL PRIMARY KEY,
  integration_name TEXT NOT NULL,
  sync_type TEXT NOT NULL DEFAULT 'manual',
  status TEXT NOT NULL DEFAULT 'running',
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  fetched INTEGER NOT NULL DEFAULT 0,
  inserted INTEGER NOT NULL DEFAULT 0,
  updated INTEGER NOT NULL DEFAULT 0,
  unchanged INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  error_message TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_alert_activity_logs_alert_time
  ON alert_activity_logs(alert_id, activity_at DESC);

CREATE INDEX IF NOT EXISTS idx_alert_responders_alert_id
  ON alert_responders(alert_id);

CREATE INDEX IF NOT EXISTS idx_alert_attachments_alert_id
  ON alert_attachments(alert_id);

CREATE INDEX IF NOT EXISTS idx_integration_sync_runs_atlassian
  ON integration_sync_runs(integration_name, started_at DESC);
