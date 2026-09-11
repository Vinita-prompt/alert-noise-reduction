CREATE TABLE IF NOT EXISTS grafana_folders (
  uid TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  url TEXT,
  dashboard_count INTEGER NOT NULL DEFAULT 0,
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS grafana_dashboards (
  uid TEXT PRIMARY KEY,
  dashboard_id TEXT,
  title TEXT NOT NULL,
  slug TEXT,
  uri TEXT,
  dashboard_url TEXT,
  folder_uid TEXT,
  folder_title TEXT,
  tags JSONB NOT NULL DEFAULT '[]'::jsonb,
  refresh_interval TEXT,
  dashboard_type TEXT,
  is_starred BOOLEAN NOT NULL DEFAULT FALSE,
  panel_count INTEGER NOT NULL DEFAULT 0,
  datasource_names JSONB NOT NULL DEFAULT '[]'::jsonb,
  dashboard_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  meta_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE grafana_dashboards
  ADD COLUMN IF NOT EXISTS refresh_interval TEXT;

CREATE TABLE IF NOT EXISTS grafana_panels (
  id BIGSERIAL PRIMARY KEY,
  dashboard_uid TEXT NOT NULL,
  panel_id TEXT NOT NULL,
  panel_uid TEXT,
  panel_title TEXT NOT NULL,
  panel_type TEXT,
  panel_order INTEGER NOT NULL DEFAULT 0,
  folder_uid TEXT,
  folder_name TEXT,
  dashboard_title TEXT,
  datasource_name TEXT,
  query_summary TEXT,
  grid_pos JSONB NOT NULL DEFAULT '{}'::jsonb,
  targets JSONB NOT NULL DEFAULT '[]'::jsonb,
  tags JSONB NOT NULL DEFAULT '[]'::jsonb,
  deep_link TEXT,
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (dashboard_uid, panel_id)
);

CREATE TABLE IF NOT EXISTS grafana_alert_rules (
  uid TEXT PRIMARY KEY,
  rule_id TEXT,
  title TEXT NOT NULL,
  folder_uid TEXT,
  folder_name TEXT,
  dashboard_uid TEXT,
  panel_id TEXT,
  condition TEXT,
  state TEXT,
  severity TEXT,
  labels JSONB NOT NULL DEFAULT '{}'::jsonb,
  annotations JSONB NOT NULL DEFAULT '{}'::jsonb,
  data JSONB NOT NULL DEFAULT '[]'::jsonb,
  deep_link TEXT,
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS grafana_alert_states (
  fingerprint TEXT PRIMARY KEY,
  rule_uid TEXT,
  rule_title TEXT,
  state TEXT,
  severity TEXT,
  starts_at TIMESTAMPTZ,
  ends_at TIMESTAMPTZ,
  labels JSONB NOT NULL DEFAULT '{}'::jsonb,
  annotations JSONB NOT NULL DEFAULT '{}'::jsonb,
  deep_link TEXT,
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS grafana_ai_features (
  source_tool TEXT NOT NULL DEFAULT 'Grafana',
  source_module TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  entity_uid TEXT,
  entity_name TEXT NOT NULL,
  dashboard_uid TEXT,
  dashboard_category TEXT,
  panel_title TEXT,
  metric_name TEXT,
  alert_rule_state TEXT,
  threshold TEXT,
  severity TEXT,
  timestamp TIMESTAMPTZ,
  recurrence_count INTEGER NOT NULL DEFAULT 0,
  ai_label TEXT NOT NULL DEFAULT 'unknown',
  ai_confidence NUMERIC,
  ai_reason TEXT,
  ai_features JSONB NOT NULL DEFAULT '{}'::jsonb,
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (source_tool, source_module, entity_id)
);

CREATE INDEX IF NOT EXISTS idx_grafana_folders_title ON grafana_folders(title);
CREATE INDEX IF NOT EXISTS idx_grafana_panels_dashboard ON grafana_panels(dashboard_uid, panel_order);
CREATE INDEX IF NOT EXISTS idx_grafana_panels_title ON grafana_panels(panel_title);
CREATE INDEX IF NOT EXISTS idx_grafana_alert_rules_dashboard ON grafana_alert_rules(dashboard_uid);
CREATE INDEX IF NOT EXISTS idx_grafana_alert_rules_state ON grafana_alert_rules(state);
CREATE INDEX IF NOT EXISTS idx_grafana_alert_states_rule ON grafana_alert_states(rule_uid);
CREATE INDEX IF NOT EXISTS idx_grafana_alert_states_state ON grafana_alert_states(state);
CREATE INDEX IF NOT EXISTS idx_grafana_ai_features_dashboard ON grafana_ai_features(dashboard_uid);
CREATE INDEX IF NOT EXISTS idx_grafana_ai_features_label ON grafana_ai_features(ai_label);
