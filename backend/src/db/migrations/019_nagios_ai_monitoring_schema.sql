ALTER TABLE nagios_host_status
  ADD COLUMN IF NOT EXISTS state_type TEXT,
  ADD COLUMN IF NOT EXISTS duration_seconds INTEGER,
  ADD COLUMN IF NOT EXISTS attempt_count INTEGER,
  ADD COLUMN IF NOT EXISTS is_flapping BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE nagios_service_status
  ADD COLUMN IF NOT EXISTS state_type TEXT,
  ADD COLUMN IF NOT EXISTS duration_seconds INTEGER,
  ADD COLUMN IF NOT EXISTS attempt_count INTEGER,
  ADD COLUMN IF NOT EXISTS is_flapping BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS performance_data TEXT,
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE nagios_active_problems
  ADD COLUMN IF NOT EXISTS current_state INTEGER,
  ADD COLUMN IF NOT EXISTS duration_seconds INTEGER;

ALTER TABLE nagios_event_history
  ADD COLUMN IF NOT EXISTS old_state TEXT,
  ADD COLUMN IF NOT EXISTS new_state TEXT,
  ADD COLUMN IF NOT EXISTS severity TEXT,
  ADD COLUMN IF NOT EXISTS acknowledged BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS in_downtime BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS nagios_hosts (
  source_instance TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  host_name TEXT NOT NULL,
  display_name TEXT,
  address TEXT,
  state INTEGER,
  state_type TEXT,
  status TEXT NOT NULL,
  last_check TIMESTAMPTZ,
  last_state_change TIMESTAMPTZ,
  duration_seconds INTEGER,
  attempt_count INTEGER,
  output TEXT,
  acknowledged BOOLEAN NOT NULL DEFAULT FALSE,
  acknowledgement_type TEXT,
  in_downtime BOOLEAN NOT NULL DEFAULT FALSE,
  downtime_depth INTEGER NOT NULL DEFAULT 0,
  unreachable_or_down BOOLEAN NOT NULL DEFAULT FALSE,
  is_flapping BOOLEAN NOT NULL DEFAULT FALSE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_polled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (source_instance, host_name)
);

CREATE TABLE IF NOT EXISTS nagios_services (
  source_instance TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  host_name TEXT NOT NULL,
  service_name TEXT NOT NULL,
  display_name TEXT,
  state INTEGER,
  state_type TEXT,
  status TEXT NOT NULL,
  last_check TIMESTAMPTZ,
  last_state_change TIMESTAMPTZ,
  duration_seconds INTEGER,
  attempt_count INTEGER,
  output TEXT,
  acknowledged BOOLEAN NOT NULL DEFAULT FALSE,
  acknowledgement_type TEXT,
  in_downtime BOOLEAN NOT NULL DEFAULT FALSE,
  downtime_depth INTEGER NOT NULL DEFAULT 0,
  is_flapping BOOLEAN NOT NULL DEFAULT FALSE,
  performance_data TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_polled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (source_instance, host_name, service_name)
);

ALTER TABLE nagios_hosts
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE nagios_services
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;

CREATE TABLE IF NOT EXISTS nagios_summaries (
  source_instance TEXT NOT NULL,
  summary_type TEXT NOT NULL,
  total_count INTEGER NOT NULL DEFAULT 0,
  status_counts JSONB NOT NULL DEFAULT '{}'::jsonb,
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (source_instance, summary_type)
);

CREATE TABLE IF NOT EXISTS nagios_problems (
  source_instance TEXT NOT NULL,
  problem_key TEXT NOT NULL,
  problem_type TEXT NOT NULL,
  host_name TEXT,
  service_name TEXT,
  severity TEXT NOT NULL,
  current_state INTEGER,
  status TEXT NOT NULL,
  first_detected_at TIMESTAMPTZ,
  last_changed_at TIMESTAMPTZ,
  duration_seconds INTEGER,
  acknowledged BOOLEAN NOT NULL DEFAULT FALSE,
  in_downtime BOOLEAN NOT NULL DEFAULT FALSE,
  output TEXT,
  deep_link TEXT,
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_polled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (source_instance, problem_key)
);

CREATE TABLE IF NOT EXISTS nagios_events (
  source_instance TEXT NOT NULL,
  event_hash TEXT NOT NULL,
  event_id TEXT,
  event_type TEXT,
  host_name TEXT,
  service_name TEXT,
  old_state TEXT,
  new_state TEXT,
  event_timestamp TIMESTAMPTZ NOT NULL,
  severity TEXT,
  acknowledged BOOLEAN NOT NULL DEFAULT FALSE,
  in_downtime BOOLEAN NOT NULL DEFAULT FALSE,
  output TEXT,
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (source_instance, event_hash)
);

CREATE TABLE IF NOT EXISTS nagios_downtime (
  source_instance TEXT NOT NULL,
  downtime_key TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  host_name TEXT,
  service_name TEXT,
  author TEXT,
  comment TEXT,
  start_time TIMESTAMPTZ,
  end_time TIMESTAMPTZ,
  duration_seconds INTEGER,
  fixed BOOLEAN,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_polled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (source_instance, downtime_key)
);

CREATE TABLE IF NOT EXISTS nagios_ai_features (
  source_instance TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  entity_name TEXT NOT NULL,
  feature_timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  current_state TEXT,
  previous_state TEXT,
  state_change_count INTEGER NOT NULL DEFAULT 0,
  recurrence_count INTEGER NOT NULL DEFAULT 0,
  alert_frequency NUMERIC,
  alert_density NUMERIC,
  time_since_last_change_seconds INTEGER,
  time_since_last_alert_seconds INTEGER,
  time_since_last_recovery_seconds INTEGER,
  average_problem_duration_seconds NUMERIC,
  maximum_problem_duration_seconds INTEGER,
  minimum_problem_duration_seconds INTEGER,
  recovery_time_seconds INTEGER,
  flapping_score NUMERIC,
  stability_score NUMERIC,
  downtime_count INTEGER NOT NULL DEFAULT 0,
  acknowledgement_count INTEGER NOT NULL DEFAULT 0,
  severity_score NUMERIC,
  volatility_score NUMERIC,
  trend_direction TEXT,
  noise_likelihood NUMERIC,
  incident_likelihood NUMERIC,
  flapping_likelihood NUMERIC,
  recurrence_likelihood NUMERIC,
  correlation_likelihood NUMERIC,
  correlation_placeholder JSONB NOT NULL DEFAULT '{}'::jsonb,
  ai_label TEXT NOT NULL DEFAULT 'unknown',
  ai_confidence NUMERIC,
  ai_reason TEXT,
  raw_payload_reference TEXT,
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (source_instance, entity_type, entity_id)
);

CREATE TABLE IF NOT EXISTS nagios_sync_logs (
  id BIGSERIAL PRIMARY KEY,
  source_instance TEXT NOT NULL,
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

CREATE INDEX IF NOT EXISTS idx_nagios_hosts_instance_state ON nagios_hosts(source_instance, status, last_state_change DESC);
CREATE INDEX IF NOT EXISTS idx_nagios_hosts_name ON nagios_hosts(source_instance, host_name);
CREATE INDEX IF NOT EXISTS idx_nagios_services_instance_state ON nagios_services(source_instance, status, last_state_change DESC);
CREATE INDEX IF NOT EXISTS idx_nagios_services_host ON nagios_services(source_instance, host_name, service_name);
CREATE INDEX IF NOT EXISTS idx_nagios_problems_instance_state ON nagios_problems(source_instance, status, last_changed_at DESC);
CREATE INDEX IF NOT EXISTS idx_nagios_problems_host_service ON nagios_problems(source_instance, host_name, service_name);
CREATE INDEX IF NOT EXISTS idx_nagios_events_instance_time ON nagios_events(source_instance, event_timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_nagios_events_host_service ON nagios_events(source_instance, host_name, service_name);
CREATE INDEX IF NOT EXISTS idx_nagios_downtime_instance_active ON nagios_downtime(source_instance, active, start_time DESC);
CREATE INDEX IF NOT EXISTS idx_nagios_ai_features_instance_entity ON nagios_ai_features(source_instance, entity_type, entity_name);
CREATE INDEX IF NOT EXISTS idx_nagios_ai_features_timestamp ON nagios_ai_features(source_instance, feature_timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_nagios_sync_logs_started ON nagios_sync_logs(source_instance, started_at DESC);
