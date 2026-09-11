CREATE TABLE IF NOT EXISTS appdynamics_applications (
  application_id TEXT PRIMARY KEY,
  application_name TEXT NOT NULL,
  health TEXT NOT NULL DEFAULT 'unknown',
  health_color TEXT,
  response_time DOUBLE PRECISION,
  calls DOUBLE PRECISION,
  calls_per_minute DOUBLE PRECISION,
  errors DOUBLE PRECISION,
  errors_per_minute DOUBLE PRECISION,
  last_updated TIMESTAMPTZ,
  time_window TEXT,
  status TEXT NOT NULL DEFAULT 'ok',
  tags JSONB NOT NULL DEFAULT '[]'::jsonb,
  description TEXT,
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS appdynamics_tiers (
  id BIGSERIAL PRIMARY KEY,
  application_id TEXT NOT NULL,
  tier_id TEXT NOT NULL,
  tier_name TEXT NOT NULL,
  tier_type TEXT,
  agent_type TEXT,
  number_of_nodes INTEGER,
  health TEXT NOT NULL DEFAULT 'unknown',
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (application_id, tier_id)
);

CREATE TABLE IF NOT EXISTS appdynamics_business_transactions (
  id BIGSERIAL PRIMARY KEY,
  application_id TEXT NOT NULL,
  business_transaction_id TEXT NOT NULL,
  business_transaction_name TEXT NOT NULL,
  tier_name TEXT,
  health TEXT NOT NULL DEFAULT 'unknown',
  response_time DOUBLE PRECISION,
  calls DOUBLE PRECISION,
  calls_per_minute DOUBLE PRECISION,
  errors DOUBLE PRECISION,
  errors_per_minute DOUBLE PRECISION,
  error_percent DOUBLE PRECISION,
  slow_percent DOUBLE PRECISION,
  very_slow_percent DOUBLE PRECISION,
  stall_percent DOUBLE PRECISION,
  normal_percent DOUBLE PRECISION,
  last_seen_at TIMESTAMPTZ,
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (application_id, business_transaction_id)
);

CREATE TABLE IF NOT EXISTS appdynamics_nodes (
  id BIGSERIAL PRIMARY KEY,
  application_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  node_name TEXT NOT NULL,
  tier_id TEXT,
  tier_name TEXT,
  server_name TEXT,
  health TEXT NOT NULL DEFAULT 'unknown',
  response_time DOUBLE PRECISION,
  calls DOUBLE PRECISION,
  errors DOUBLE PRECISION,
  availability DOUBLE PRECISION,
  cpu DOUBLE PRECISION,
  memory DOUBLE PRECISION,
  agent_version TEXT,
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (application_id, node_id)
);

CREATE TABLE IF NOT EXISTS appdynamics_events (
  id BIGSERIAL PRIMARY KEY,
  application_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'medium',
  status TEXT NOT NULL DEFAULT 'warning',
  event_type TEXT,
  tier_name TEXT,
  node_name TEXT,
  summary TEXT NOT NULL,
  description TEXT,
  event_time TIMESTAMPTZ,
  category TEXT,
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (application_id, event_id)
);

CREATE TABLE IF NOT EXISTS appdynamics_snapshots (
  id BIGSERIAL PRIMARY KEY,
  application_id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  business_transaction_id TEXT,
  business_transaction_name TEXT,
  snapshot_type TEXT,
  execution_time_ms DOUBLE PRECISION,
  sql_call_count INTEGER,
  remote_call_count INTEGER,
  exception_count INTEGER,
  started_at TIMESTAMPTZ,
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (application_id, snapshot_id)
);

CREATE TABLE IF NOT EXISTS appdynamics_health_rules (
  id BIGSERIAL PRIMARY KEY,
  application_id TEXT NOT NULL,
  health_rule_id TEXT NOT NULL,
  health_rule_name TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  severity TEXT NOT NULL DEFAULT 'low',
  status TEXT NOT NULL DEFAULT 'ok',
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (application_id, health_rule_id)
);

CREATE TABLE IF NOT EXISTS appdynamics_metrics (
  id BIGSERIAL PRIMARY KEY,
  application_id TEXT NOT NULL,
  metric_path TEXT NOT NULL,
  metric_name TEXT NOT NULL,
  metric_value DOUBLE PRECISION,
  metric_timestamp TIMESTAMPTZ NOT NULL,
  time_window TEXT,
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (application_id, metric_path, metric_timestamp)
);

CREATE TABLE IF NOT EXISTS appdynamics_flow_map (
  id BIGSERIAL PRIMARY KEY,
  application_id TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_name TEXT NOT NULL,
  source_entity_id TEXT,
  target_entity_id TEXT,
  health TEXT NOT NULL DEFAULT 'unknown',
  latency DOUBLE PRECISION,
  calls DOUBLE PRECISION,
  errors DOUBLE PRECISION,
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (application_id, entity_type, entity_id)
);

CREATE TABLE IF NOT EXISTS appdynamics_ai_features (
  id BIGSERIAL PRIMARY KEY,
  application_id TEXT NOT NULL,
  source_module TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  entity_name TEXT NOT NULL,
  ai_label TEXT NOT NULL DEFAULT 'unknown',
  ai_confidence DOUBLE PRECISION,
  ai_reason TEXT,
  ai_features JSONB NOT NULL DEFAULT '{}'::jsonb,
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (application_id, source_module, entity_id)
);

CREATE INDEX IF NOT EXISTS idx_appdynamics_bt_app
  ON appdynamics_business_transactions(application_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_appdynamics_nodes_app
  ON appdynamics_nodes(application_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_appdynamics_events_app_time
  ON appdynamics_events(application_id, event_time DESC);
CREATE INDEX IF NOT EXISTS idx_appdynamics_metrics_app_time
  ON appdynamics_metrics(application_id, metric_timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_appdynamics_ai_app
  ON appdynamics_ai_features(application_id, source_module);
