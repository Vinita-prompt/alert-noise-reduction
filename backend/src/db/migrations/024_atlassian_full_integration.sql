ALTER TABLE alerts ADD COLUMN IF NOT EXISTS atlassian_ops_alert_id TEXT;
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS atlassian_ops_tiny_id TEXT;
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS atlassian_ops_alias TEXT;
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS atlassian_last_synced_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS idx_alerts_jsm_ops_source_external
  ON alerts(source, source_alert_id)
  WHERE source = 'jsm_ops' AND source_alert_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS alert_external_links (
  id BIGSERIAL PRIMARY KEY,
  alert_id TEXT NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
  link_type TEXT NOT NULL,
  external_id TEXT,
  url TEXT,
  title TEXT,
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (alert_id, link_type, external_id)
);

CREATE TABLE IF NOT EXISTS atlassian_jsm_service_desks (
  service_desk_id TEXT PRIMARY KEY,
  project_id TEXT,
  project_key TEXT,
  project_name TEXT,
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS atlassian_jsm_queues (
  id BIGSERIAL PRIMARY KEY,
  service_desk_id TEXT,
  queue_id TEXT NOT NULL,
  queue_name TEXT,
  issue_count INTEGER,
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (service_desk_id, queue_id)
);

CREATE TABLE IF NOT EXISTS atlassian_jsm_requests (
  issue_id TEXT,
  issue_key TEXT PRIMARY KEY,
  request_type_id TEXT,
  request_type_name TEXT,
  service_desk_id TEXT,
  service_desk_name TEXT,
  summary TEXT,
  status TEXT,
  reporter JSONB,
  request_participants JSONB NOT NULL DEFAULT '[]'::jsonb,
  current_sla JSONB NOT NULL DEFAULT '[]'::jsonb,
  approvals JSONB NOT NULL DEFAULT '[]'::jsonb,
  comments JSONB NOT NULL DEFAULT '[]'::jsonb,
  attachments JSONB NOT NULL DEFAULT '[]'::jsonb,
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  request_created_at TIMESTAMPTZ,
  request_updated_at TIMESTAMPTZ,
  last_synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS integration_errors (
  id BIGSERIAL PRIMARY KEY,
  integration_name TEXT NOT NULL,
  operation TEXT NOT NULL,
  error_code TEXT,
  error_message TEXT,
  context JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_alert_external_links_alert_id ON alert_external_links(alert_id);
CREATE INDEX IF NOT EXISTS idx_alert_external_links_type ON alert_external_links(link_type);
CREATE INDEX IF NOT EXISTS idx_atlassian_jsm_requests_status ON atlassian_jsm_requests(status);
CREATE INDEX IF NOT EXISTS idx_atlassian_jsm_requests_updated ON atlassian_jsm_requests(request_updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_integration_errors_name_created ON integration_errors(integration_name, created_at DESC);
