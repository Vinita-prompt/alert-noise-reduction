ALTER TABLE alerts ADD COLUMN IF NOT EXISTS source_type TEXT NOT NULL DEFAULT 'monitoring';
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS source_alert_id TEXT;
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS confidence_score INTEGER CHECK (confidence_score BETWEEN 0 AND 100);
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS duplicate_signature TEXT;
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS correlation_id TEXT;

ALTER TABLE alerts DROP CONSTRAINT IF EXISTS alerts_classification_check;
ALTER TABLE alerts
  ADD CONSTRAINT alerts_classification_check
  CHECK (classification IN ('incident', 'noise', 'needs_review', 'unclassified'));

CREATE TABLE IF NOT EXISTS raw_alerts (
  id BIGSERIAL PRIMARY KEY,
  source_tool TEXT NOT NULL,
  source_type TEXT NOT NULL DEFAULT 'monitoring',
  source_alert_id TEXT,
  normalized_alert_id TEXT REFERENCES alerts(id) ON DELETE SET NULL,
  raw_payload JSONB NOT NULL,
  processing_status TEXT NOT NULL DEFAULT 'stored' CHECK (processing_status IN ('stored', 'normalized', 'classification_failed')),
  error_message TEXT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS alert_classification_history (
  id BIGSERIAL PRIMARY KEY,
  alert_id TEXT NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
  classification TEXT NOT NULL CHECK (classification IN ('incident', 'noise', 'needs_review', 'unclassified')),
  noise_type TEXT NOT NULL DEFAULT 'none',
  confidence_score INTEGER CHECK (confidence_score BETWEEN 0 AND 100),
  justification TEXT NOT NULL,
  noise_reason TEXT,
  classified_by TEXT NOT NULL DEFAULT 'system',
  classified_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS alert_correlation_history (
  id BIGSERIAL PRIMARY KEY,
  alert_id TEXT NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
  duplicate_signature TEXT,
  correlation_id TEXT,
  duplicate_count INTEGER NOT NULL DEFAULT 1,
  related_alerts JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS alert_incident_mappings (
  id BIGSERIAL PRIMARY KEY,
  alert_id TEXT NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
  incident_id BIGINT REFERENCES incidents(id) ON DELETE CASCADE,
  jira_ticket_id TEXT,
  mapping_reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_alerts_source_alert_id ON alerts(source, source_alert_id);
CREATE INDEX IF NOT EXISTS idx_alerts_duplicate_signature ON alerts(duplicate_signature);
CREATE INDEX IF NOT EXISTS idx_alerts_correlation_id ON alerts(correlation_id);
CREATE INDEX IF NOT EXISTS idx_raw_alerts_source ON raw_alerts(source_tool, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_raw_alerts_normalized_alert_id ON raw_alerts(normalized_alert_id);
CREATE INDEX IF NOT EXISTS idx_alert_classification_history_alert_id ON alert_classification_history(alert_id, classified_at DESC);
CREATE INDEX IF NOT EXISTS idx_alert_correlation_history_alert_id ON alert_correlation_history(alert_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_alert_incident_mappings_alert_id ON alert_incident_mappings(alert_id);
