CREATE TABLE IF NOT EXISTS operations_incidents (
  incident_key TEXT PRIMARY KEY,
  summary TEXT,
  description TEXT,
  reporter JSONB,
  priority TEXT,
  status TEXT,
  status_category TEXT,
  resolution TEXT,
  source_url TEXT,
  incident_created_at TIMESTAMPTZ,
  incident_updated_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ,
  assignee JSONB,
  labels JSONB NOT NULL DEFAULT '[]'::jsonb,
  linked_alerts JSONB NOT NULL DEFAULT '[]'::jsonb,
  root_cause_notes JSONB NOT NULL DEFAULT '[]'::jsonb,
  comments JSONB NOT NULL DEFAULT '[]'::jsonb,
  custom_fields JSONB NOT NULL DEFAULT '{}'::jsonb,
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_operations_incidents_status ON operations_incidents(status);
CREATE INDEX IF NOT EXISTS idx_operations_incidents_updated ON operations_incidents(incident_updated_at DESC);
