-- One verification-channel delivery per source Slack alert occurrence.
-- Delivery identity is intentionally limited to Slack event ID or channel + message timestamp.

CREATE TABLE IF NOT EXISTS slack_occurrence_verification_deliveries (
  delivery_id TEXT PRIMARY KEY,
  source_channel_id TEXT NOT NULL,
  source_message_ts TEXT NOT NULL,
  source_event_id TEXT,
  alert_number TEXT NOT NULL,
  canonical_alert_id TEXT REFERENCES alerts(id) ON DELETE RESTRICT,
  evaluation_id TEXT REFERENCES live_shadow_evaluations(evaluation_id) ON DELETE RESTRICT,
  evidence_workflow TEXT NOT NULL CHECK (evidence_workflow IN ('LIVE','BACKFILL')),
  verification_channel_id TEXT NOT NULL,
  verification_message_ts TEXT,
  status TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (source_channel_id, source_message_ts)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_slack_occurrence_verification_event
  ON slack_occurrence_verification_deliveries(source_event_id)
  WHERE source_event_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_slack_occurrence_verification_status
  ON slack_occurrence_verification_deliveries(status, created_at DESC);

COMMENT ON TABLE slack_occurrence_verification_deliveries IS
  'Append-only source occurrence delivery ledger. Legitimate repeated alert numbers remain independent deliveries.';
