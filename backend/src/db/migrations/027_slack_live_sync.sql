ALTER TABLE slack_raw_messages
  ADD COLUMN IF NOT EXISTS live_received_at TIMESTAMPTZ;

ALTER TABLE slack_alert_events
  ADD COLUMN IF NOT EXISTS live_received_at TIMESTAMPTZ;

ALTER TABLE slack_normalized_alerts
  ADD COLUMN IF NOT EXISTS live_received_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS slack_alert_live_sync_state (
  slack_channel_id TEXT PRIMARY KEY,
  slack_channel_name TEXT,
  workspace_name TEXT,
  connected BOOLEAN NOT NULL DEFAULT FALSE,
  poll_status TEXT NOT NULL DEFAULT 'idle',
  poll_interval_seconds INTEGER NOT NULL DEFAULT 30,
  last_processed_ts TEXT,
  last_fetch_started_at TIMESTAMPTZ,
  last_fetch_at TIMESTAMPTZ,
  last_successful_fetch_at TIMESTAMPTZ,
  last_message_at TIMESTAMPTZ,
  last_alert_at TIMESTAMPTZ,
  messages_processed BIGINT NOT NULL DEFAULT 0,
  alerts_detected BIGINT NOT NULL DEFAULT 0,
  last_batch_messages INTEGER NOT NULL DEFAULT 0,
  last_batch_alerts INTEGER NOT NULL DEFAULT 0,
  last_error_code TEXT,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_slack_raw_messages_live_received
  ON slack_raw_messages(live_received_at DESC)
  WHERE live_received_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_slack_normalized_alerts_live_received
  ON slack_normalized_alerts(live_received_at DESC)
  WHERE live_received_at IS NOT NULL;
