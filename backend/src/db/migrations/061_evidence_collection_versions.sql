-- Append-only refresh and edit history for Slack evidence collection.
-- This migration never updates alert state, historical classifications, Jira,
-- Slack alert state, or monitoring systems.

CREATE TABLE IF NOT EXISTS evidence_refresh_events (
  refresh_event_id TEXT PRIMARY KEY,
  alert_id TEXT NOT NULL REFERENCES alerts(id) ON DELETE RESTRICT,
  evaluation_id TEXT,
  action_type TEXT NOT NULL CHECK (action_type IN ('INITIAL_LOAD', 'REFRESH')),
  evidence_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_status JSONB NOT NULL DEFAULT '{}'::jsonb,
  refreshed_by TEXT,
  refreshed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_evidence_refresh_events_alert_time
  ON evidence_refresh_events(alert_id, refreshed_at DESC);

CREATE TABLE IF NOT EXISTS evidence_submission_version_events (
  version_event_id TEXT PRIMARY KEY,
  alert_id TEXT NOT NULL REFERENCES alerts(id) ON DELETE RESTRICT,
  previous_report_id TEXT NOT NULL REFERENCES incident_verification_reports(report_id) ON DELETE RESTRICT,
  new_report_id TEXT NOT NULL REFERENCES incident_verification_reports(report_id) ON DELETE RESTRICT,
  previous_values JSONB NOT NULL,
  new_values JSONB NOT NULL,
  changed_fields TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  editor_id TEXT NOT NULL,
  editor_name TEXT NOT NULL,
  edit_reason TEXT NOT NULL,
  evidence_provenance JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (new_report_id)
);

CREATE INDEX IF NOT EXISTS idx_evidence_submission_versions_alert_time
  ON evidence_submission_version_events(alert_id, created_at DESC);

COMMENT ON TABLE evidence_refresh_events IS
  'Append-only snapshots of stored read-only evidence shown during Slack initial load and refresh.';
COMMENT ON TABLE evidence_submission_version_events IS
  'Append-only before/after audit events for explicit Update Evidence submissions.';
