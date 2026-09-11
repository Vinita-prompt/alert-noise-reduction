-- Additive production indexes for the rolling live view and retained evidence
-- history. No alert, evidence, decision, or audit row is changed or deleted.

CREATE INDEX IF NOT EXISTS idx_slack_alert_events_application_time
  ON slack_alert_events(LOWER(COALESCE(application, '')), message_at DESC, source_message_ts DESC);

CREATE INDEX IF NOT EXISTS idx_slack_alert_events_received_24h
  ON slack_alert_events(message_at DESC, slack_channel_id, source_message_ts);

CREATE INDEX IF NOT EXISTS idx_incident_reports_submitted_history
  ON incident_verification_reports(submitted_at DESC, alert_id, report_id);

CREATE INDEX IF NOT EXISTS idx_incident_reports_alert_number_history
  ON incident_verification_reports(alert_number, submitted_at DESC);

CREATE INDEX IF NOT EXISTS idx_incident_reports_reviewer_history
  ON incident_verification_reports(LOWER(reviewer_name), submitted_at DESC);

CREATE INDEX IF NOT EXISTS idx_incident_reports_confidence_history
  ON incident_verification_reports((form_responses->>'decisionConfidence'), submitted_at DESC);

CREATE INDEX IF NOT EXISTS idx_live_shadow_evaluations_decision_time
  ON live_shadow_evaluations(final_decision, created_at DESC, alert_id);

CREATE INDEX IF NOT EXISTS idx_alerts_received_archive
  ON alerts(received_at DESC, id);

CREATE INDEX IF NOT EXISTS idx_alerts_source_received
  ON alerts(LOWER(source), received_at DESC, id);

CREATE INDEX IF NOT EXISTS idx_alerts_classification_received
  ON alerts(classification, received_at DESC, id);

COMMENT ON INDEX idx_incident_reports_submitted_history IS
  'Supports configurable retained Evidence History without changing append-only report semantics.';
