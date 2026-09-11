ALTER TABLE incident_verification_reports
  ADD COLUMN IF NOT EXISTS responder_team TEXT,
  ADD COLUMN IF NOT EXISTS reviewer_slack_user_id TEXT,
  ADD COLUMN IF NOT EXISTS submission_channel TEXT NOT NULL DEFAULT 'WEB',
  ADD COLUMN IF NOT EXISTS attachment_references JSONB NOT NULL DEFAULT '[]'::jsonb;

CREATE TABLE IF NOT EXISTS evidence_submission_attachments (
  attachment_id TEXT PRIMARY KEY,
  report_id TEXT NOT NULL REFERENCES incident_verification_reports(report_id) ON DELETE RESTRICT,
  alert_id TEXT NOT NULL REFERENCES alerts(id) ON DELETE RESTRICT,
  source TEXT NOT NULL CHECK (source IN ('WEB_UPLOAD', 'SLACK_FILE', 'LINK')),
  external_file_id TEXT,
  file_name TEXT NOT NULL,
  mime_type TEXT,
  file_size BIGINT,
  external_url TEXT,
  content BYTEA,
  sha256 TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_evidence_submission_attachments_report
  ON evidence_submission_attachments(report_id, created_at ASC);

CREATE INDEX IF NOT EXISTS idx_evidence_submission_attachments_alert
  ON evidence_submission_attachments(alert_id, created_at DESC);
