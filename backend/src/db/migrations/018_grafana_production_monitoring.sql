ALTER TABLE grafana_folders
  ADD COLUMN IF NOT EXISTS folder_id TEXT,
  ADD COLUMN IF NOT EXISTS parent_uid TEXT,
  ADD COLUMN IF NOT EXISTS permissions JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS grafana_created_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS grafana_updated_at TIMESTAMPTZ;

ALTER TABLE grafana_dashboards
  ADD COLUMN IF NOT EXISTS description TEXT,
  ADD COLUMN IF NOT EXISTS timezone TEXT,
  ADD COLUMN IF NOT EXISTS editable BOOLEAN,
  ADD COLUMN IF NOT EXISTS version INTEGER,
  ADD COLUMN IF NOT EXISTS schema_version INTEGER,
  ADD COLUMN IF NOT EXISTS created_by TEXT,
  ADD COLUMN IF NOT EXISTS updated_by TEXT,
  ADD COLUMN IF NOT EXISTS grafana_created_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS grafana_updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS templating_variables JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS annotations JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS dashboard_links JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS entity_hash TEXT;

ALTER TABLE grafana_panels
  ADD COLUMN IF NOT EXISTS panel_description TEXT,
  ADD COLUMN IF NOT EXISTS visualization_type TEXT,
  ADD COLUMN IF NOT EXISTS datasource_uid TEXT,
  ADD COLUMN IF NOT EXISTS queries JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS expressions JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS transformations JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS thresholds JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS overrides JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS field_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS legend TEXT,
  ADD COLUMN IF NOT EXISTS unit TEXT,
  ADD COLUMN IF NOT EXISTS decimals INTEGER,
  ADD COLUMN IF NOT EXISTS color_scheme TEXT,
  ADD COLUMN IF NOT EXISTS display_mode TEXT,
  ADD COLUMN IF NOT EXISTS min_value NUMERIC,
  ADD COLUMN IF NOT EXISTS max_value NUMERIC,
  ADD COLUMN IF NOT EXISTS current_value NUMERIC,
  ADD COLUMN IF NOT EXISTS metric_stats JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE grafana_alert_rules
  ADD COLUMN IF NOT EXISTS threshold TEXT,
  ADD COLUMN IF NOT EXISTS reducer TEXT,
  ADD COLUMN IF NOT EXISTS operator TEXT,
  ADD COLUMN IF NOT EXISTS health TEXT,
  ADD COLUMN IF NOT EXISTS no_data_state TEXT,
  ADD COLUMN IF NOT EXISTS exec_error_state TEXT,
  ADD COLUMN IF NOT EXISTS rule_group TEXT,
  ADD COLUMN IF NOT EXISTS evaluation_interval TEXT,
  ADD COLUMN IF NOT EXISTS summary TEXT,
  ADD COLUMN IF NOT EXISTS description TEXT,
  ADD COLUMN IF NOT EXISTS last_evaluation_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS next_evaluation_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS silenced BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS paused BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE grafana_ai_features
  ADD COLUMN IF NOT EXISTS computed_features JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS correlation_features JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS prediction_placeholder TEXT,
  ADD COLUMN IF NOT EXISTS confidence_placeholder NUMERIC,
  ADD COLUMN IF NOT EXISTS explanation_placeholder TEXT;

CREATE TABLE IF NOT EXISTS grafana_alert_state_history (
  id BIGSERIAL PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  rule_uid TEXT,
  rule_title TEXT,
  previous_state TEXT,
  state TEXT NOT NULL,
  severity TEXT,
  transitioned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  starts_at TIMESTAMPTZ,
  ends_at TIMESTAMPTZ,
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS grafana_annotations (
  annotation_id TEXT PRIMARY KEY,
  dashboard_uid TEXT,
  panel_id TEXT,
  text TEXT,
  tags JSONB NOT NULL DEFAULT '[]'::jsonb,
  annotation_time TIMESTAMPTZ,
  created_by TEXT,
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS grafana_variables (
  id BIGSERIAL PRIMARY KEY,
  dashboard_uid TEXT NOT NULL,
  variable_name TEXT NOT NULL,
  variable_type TEXT,
  datasource_uid TEXT,
  current_value JSONB NOT NULL DEFAULT '{}'::jsonb,
  options JSONB NOT NULL DEFAULT '[]'::jsonb,
  refresh_mode TEXT,
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (dashboard_uid, variable_name)
);

CREATE TABLE IF NOT EXISTS grafana_datasources (
  uid TEXT PRIMARY KEY,
  datasource_id TEXT,
  name TEXT NOT NULL,
  type TEXT,
  url TEXT,
  access TEXT,
  is_default BOOLEAN,
  json_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS grafana_panel_metric_points (
  id BIGSERIAL PRIMARY KEY,
  dashboard_uid TEXT NOT NULL,
  panel_id TEXT NOT NULL,
  datasource_uid TEXT,
  series_name TEXT NOT NULL,
  metric_name TEXT NOT NULL,
  metric_labels JSONB NOT NULL DEFAULT '{}'::jsonb,
  metric_timestamp TIMESTAMPTZ NOT NULL,
  value NUMERIC,
  value_type TEXT,
  unit TEXT,
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (dashboard_uid, panel_id, series_name, metric_name, metric_timestamp)
);

CREATE TABLE IF NOT EXISTS grafana_panel_metric_summaries (
  dashboard_uid TEXT NOT NULL,
  panel_id TEXT NOT NULL,
  series_name TEXT NOT NULL,
  metric_name TEXT NOT NULL,
  datasource_uid TEXT,
  current_value NUMERIC,
  min_value NUMERIC,
  max_value NUMERIC,
  average_value NUMERIC,
  median_value NUMERIC,
  p95_value NUMERIC,
  p99_value NUMERIC,
  stddev_value NUMERIC,
  sample_count INTEGER NOT NULL DEFAULT 0,
  first_timestamp TIMESTAMPTZ,
  last_timestamp TIMESTAMPTZ,
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (dashboard_uid, panel_id, series_name, metric_name)
);

CREATE TABLE IF NOT EXISTS grafana_correlation_features (
  id BIGSERIAL PRIMARY KEY,
  source_tool TEXT NOT NULL DEFAULT 'Grafana',
  entity_a TEXT NOT NULL,
  entity_b TEXT NOT NULL,
  dashboard_uid_a TEXT,
  dashboard_uid_b TEXT,
  correlation_scope TEXT NOT NULL,
  shared_datasource BOOLEAN NOT NULL DEFAULT FALSE,
  shared_alert_rules INTEGER NOT NULL DEFAULT 0,
  shared_tags JSONB NOT NULL DEFAULT '[]'::jsonb,
  shared_folder BOOLEAN NOT NULL DEFAULT FALSE,
  temporal_correlation NUMERIC,
  dependency_score NUMERIC,
  potential_root_cause_score NUMERIC,
  correlation_confidence NUMERIC,
  correlation_features JSONB NOT NULL DEFAULT '{}'::jsonb,
  feature_timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (source_tool, entity_a, entity_b, correlation_scope)
);

CREATE TABLE IF NOT EXISTS grafana_raw_payload_archive (
  id BIGSERIAL PRIMARY KEY,
  source_type TEXT NOT NULL,
  entity_uid TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (source_type, entity_uid, payload_hash)
);

CREATE TABLE IF NOT EXISTS grafana_sync_logs (
  id BIGSERIAL PRIMARY KEY,
  sync_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  duration_ms INTEGER,
  counts JSONB NOT NULL DEFAULT '{}'::jsonb,
  warnings JSONB NOT NULL DEFAULT '[]'::jsonb,
  error_message TEXT,
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_grafana_alert_state_history_fingerprint
  ON grafana_alert_state_history(fingerprint, transitioned_at DESC);
CREATE INDEX IF NOT EXISTS idx_grafana_alert_state_history_rule
  ON grafana_alert_state_history(rule_uid, transitioned_at DESC);
CREATE INDEX IF NOT EXISTS idx_grafana_annotations_dashboard
  ON grafana_annotations(dashboard_uid, annotation_time DESC);
CREATE INDEX IF NOT EXISTS idx_grafana_variables_dashboard
  ON grafana_variables(dashboard_uid, variable_name);
CREATE INDEX IF NOT EXISTS idx_grafana_panel_metric_points_panel
  ON grafana_panel_metric_points(dashboard_uid, panel_id, metric_timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_grafana_panel_metric_points_metric
  ON grafana_panel_metric_points(metric_name, metric_timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_grafana_correlation_features_dashboard
  ON grafana_correlation_features(dashboard_uid_a, dashboard_uid_b);
CREATE INDEX IF NOT EXISTS idx_grafana_raw_payload_archive_entity
  ON grafana_raw_payload_archive(source_type, entity_uid, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_grafana_sync_logs_started
  ON grafana_sync_logs(sync_type, started_at DESC);
