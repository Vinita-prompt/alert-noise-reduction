-- Phase 1 data-quality correction: provenance-aware Jira Incident reconciliation.
-- This table records evidence relationships only. It does not classify Noise,
-- produce ML output, or alter the retired Phase 0 decision layer.

CREATE TABLE IF NOT EXISTS incident_alert_reconciliations (
  id BIGSERIAL PRIMARY KEY,
  reconciliation_run_id TEXT NOT NULL,
  incident_key TEXT NOT NULL REFERENCES operations_incidents(incident_key) ON DELETE CASCADE,
  alert_id TEXT REFERENCES alerts(id) ON DELETE CASCADE,
  relationship_state TEXT NOT NULL CHECK (
    relationship_state IN ('CONFIRMED_MATCH', 'PROBABLE_MATCH', 'AMBIGUOUS', 'NO_MATCH')
  ),
  match_method TEXT NOT NULL,
  match_strength TEXT NOT NULL CHECK (match_strength IN ('strong', 'moderate', 'ambiguous', 'none')),
  match_confidence NUMERIC(5, 4) CHECK (
    match_confidence IS NULL OR (match_confidence >= 0 AND match_confidence <= 1)
  ),
  alert_timestamp TIMESTAMPTZ,
  incident_created_at TIMESTAMPTZ NOT NULL,
  time_delta_seconds INTEGER,
  matched_source TEXT,
  matched_service TEXT,
  matched_application TEXT,
  matched_environment TEXT,
  evidence JSONB NOT NULL DEFAULT '[]'::jsonb,
  operational_window_start TIMESTAMPTZ NOT NULL,
  operational_window_end TIMESTAMPTZ NOT NULL,
  dataset_window_start TIMESTAMPTZ NOT NULL,
  dataset_window_end TIMESTAMPTZ NOT NULL,
  current BOOLEAN NOT NULL DEFAULT true,
  reconciled_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_incident_alert_reconciliation_current_unique
  ON incident_alert_reconciliations (incident_key, COALESCE(alert_id, ''))
  WHERE current;

CREATE INDEX IF NOT EXISTS idx_incident_alert_reconciliation_alert_current
  ON incident_alert_reconciliations (alert_id, relationship_state)
  WHERE current;

CREATE INDEX IF NOT EXISTS idx_incident_alert_reconciliation_incident_current
  ON incident_alert_reconciliations (incident_created_at DESC, incident_key)
  WHERE current;

COMMENT ON TABLE incident_alert_reconciliations IS
  'Auditable Jira Incident-to-alert evidence. Probable and ambiguous rows are never authoritative training labels.';
