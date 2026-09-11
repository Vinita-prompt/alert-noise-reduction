CREATE TABLE IF NOT EXISTS incident_verification_reports (
  report_id TEXT PRIMARY KEY,
  alert_id TEXT NOT NULL REFERENCES alerts(id) ON DELETE RESTRICT,
  episode_id TEXT NOT NULL,
  evaluation_id TEXT NOT NULL,
  decision_revision TEXT NOT NULL,
  evidence_revision TEXT NOT NULL,
  alert_number TEXT,
  alert_name TEXT NOT NULL,
  reviewer_id TEXT NOT NULL,
  reviewer_name TEXT NOT NULL,
  reviewer_email TEXT,
  form_responses JSONB NOT NULL DEFAULT '{}'::jsonb,
  attachment_links JSONB NOT NULL DEFAULT '[]'::jsonb,
  human_decision TEXT NOT NULL CHECK (human_decision IN ('INCIDENT','NOISE','NEEDS_REVIEW')),
  validation_status TEXT NOT NULL,
  feedback_id TEXT,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_incident_verification_reports_alert
  ON incident_verification_reports(alert_id, submitted_at DESC);
