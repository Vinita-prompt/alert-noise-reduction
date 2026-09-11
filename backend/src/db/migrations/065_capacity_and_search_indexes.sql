-- Capacity indexes for the permanent alert/evidence archive.
-- These indexes are additive: no alert, evidence, or classification row is
-- updated or deleted.

CREATE INDEX IF NOT EXISTS idx_slack_alert_events_alert_time
  ON slack_alert_events(alert_id, message_at DESC)
  WHERE alert_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_slack_alert_events_history_time
  ON slack_alert_events(message_at DESC, source_message_ts DESC);

CREATE INDEX IF NOT EXISTS idx_slack_alert_events_source_time
  ON slack_alert_events(LOWER(source_system), message_at DESC, source_message_ts DESC);

CREATE INDEX IF NOT EXISTS idx_slack_alert_events_priority_time
  ON slack_alert_events(LOWER(COALESCE(priority, '')), message_at DESC, source_message_ts DESC);

CREATE INDEX IF NOT EXISTS idx_slack_alert_events_status_time
  ON slack_alert_events(LOWER(COALESCE(status, '')), message_at DESC, source_message_ts DESC);

CREATE INDEX IF NOT EXISTS idx_slack_alert_events_responder_time
  ON slack_alert_events(LOWER(BTRIM(COALESCE(responder, team, ''))), message_at DESC, source_message_ts DESC);

CREATE INDEX IF NOT EXISTS idx_slack_alert_events_environment_time
  ON slack_alert_events(LOWER(COALESCE(environment, '')), message_at DESC, source_message_ts DESC);

CREATE INDEX IF NOT EXISTS idx_slack_alert_events_search
  ON slack_alert_events USING GIN (to_tsvector(
    'simple',
    COALESCE(alert_number, '') || ' ' ||
    COALESCE(title, '') || ' ' ||
    COALESCE(raw_message, '') || ' ' ||
    COALESCE(responder, team, '') || ' ' ||
    COALESCE(service, '') || ' ' ||
    COALESCE(application, '')
  ));

CREATE INDEX IF NOT EXISTS idx_incident_reports_evidence_status_time
  ON incident_verification_reports(
    evidence_completeness,
    human_decision,
    submitted_at DESC,
    alert_id
  );

CREATE INDEX IF NOT EXISTS idx_evidence_learning_source_priority_decision
  ON evidence_learning_records(source, priority, human_decision, created_at DESC);

ALTER TABLE evidence_submission_attachments
  ADD COLUMN IF NOT EXISTS storage_backend TEXT,
  ADD COLUMN IF NOT EXISTS storage_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_evidence_attachments_storage_key
  ON evidence_submission_attachments(storage_key)
  WHERE storage_key IS NOT NULL;

COMMENT ON COLUMN evidence_submission_attachments.storage_key IS
  'Opaque key for attachment content in the configured durable attachment store; PostgreSQL retains metadata and provenance.';
