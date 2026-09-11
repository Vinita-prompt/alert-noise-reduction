ALTER TABLE slack_alert_events
  ADD COLUMN IF NOT EXISTS slack_event_id TEXT,
  ADD COLUMN IF NOT EXISTS event_received_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS normalized_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS frontend_delivered_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS delivery_mode TEXT;

ALTER TABLE slack_normalized_alerts
  ADD COLUMN IF NOT EXISTS slack_event_id TEXT,
  ADD COLUMN IF NOT EXISTS event_received_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS normalized_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS frontend_delivered_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS delivery_mode TEXT;

CREATE INDEX IF NOT EXISTS idx_slack_alert_events_event_id
  ON slack_alert_events(slack_event_id)
  WHERE slack_event_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS slack_event_stream_state (
  slack_channel_id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'awaiting_event',
  last_event_received_at TIMESTAMPTZ,
  last_alert_received_at TIMESTAMPTZ,
  last_normalized_at TIMESTAMPTZ,
  last_frontend_delivered_at TIMESTAMPTZ,
  last_event_id TEXT,
  events_received BIGINT NOT NULL DEFAULT 0,
  alert_events_received BIGINT NOT NULL DEFAULT 0,
  duplicate_events BIGINT NOT NULL DEFAULT 0,
  last_detection_latency_ms INTEGER,
  last_delivery_latency_ms INTEGER,
  last_error_code TEXT,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
