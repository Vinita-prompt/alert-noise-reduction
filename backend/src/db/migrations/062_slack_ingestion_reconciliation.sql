-- Slack ingestion durability and reconciliation metadata.
-- No existing Slack message, alert, or evidence record is deleted or rewritten.

ALTER TABLE slack_raw_messages ADD COLUMN IF NOT EXISTS slack_event_id TEXT;
ALTER TABLE slack_raw_messages ADD COLUMN IF NOT EXISTS ingestion_received_at TIMESTAMPTZ;
ALTER TABLE slack_raw_messages ADD COLUMN IF NOT EXISTS parsing_status TEXT NOT NULL DEFAULT 'UNASSESSED';
ALTER TABLE slack_raw_messages ADD COLUMN IF NOT EXISTS ingestion_error_code TEXT;
ALTER TABLE slack_raw_messages ADD COLUMN IF NOT EXISTS ingestion_error TEXT;
ALTER TABLE slack_raw_messages ADD COLUMN IF NOT EXISTS parsed_alert_number TEXT;
ALTER TABLE slack_raw_messages ADD COLUMN IF NOT EXISTS parsed_alert_name TEXT;
ALTER TABLE slack_raw_messages ADD COLUMN IF NOT EXISTS parsed_source TEXT;
ALTER TABLE slack_raw_messages ADD COLUMN IF NOT EXISTS parsed_priority TEXT;
ALTER TABLE slack_raw_messages ADD COLUMN IF NOT EXISTS parsed_responder TEXT;
ALTER TABLE slack_raw_messages ADD COLUMN IF NOT EXISTS ingestion_mode TEXT NOT NULL DEFAULT 'historical';
ALTER TABLE slack_raw_messages ADD COLUMN IF NOT EXISTS archive_scope TEXT NOT NULL DEFAULT 'OPERATIONAL';

CREATE TABLE IF NOT EXISTS slack_ingestion_cycles (
  cycle_id TEXT PRIMARY KEY,
  slack_channel_id TEXT NOT NULL,
  ingestion_mode TEXT NOT NULL,
  archive_mode_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  status TEXT NOT NULL DEFAULT 'running',
  pages_fetched INTEGER NOT NULL DEFAULT 0,
  messages_found INTEGER NOT NULL DEFAULT 0,
  raw_messages_stored INTEGER NOT NULL DEFAULT 0,
  alerts_stored INTEGER NOT NULL DEFAULT 0,
  duplicates INTEGER NOT NULL DEFAULT 0,
  parse_failures INTEGER NOT NULL DEFAULT 0,
  permission_failures INTEGER NOT NULL DEFAULT 0,
  missing_records INTEGER NOT NULL DEFAULT 0,
  last_successful_cursor TEXT,
  safe_error_code TEXT,
  safe_error TEXT,
  started_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS slack_ingestion_errors (
  ingestion_error_id BIGSERIAL PRIMARY KEY,
  slack_event_id TEXT,
  slack_channel_id TEXT NOT NULL,
  message_ts TEXT NOT NULL,
  parsing_status TEXT NOT NULL,
  error_code TEXT NOT NULL,
  safe_error TEXT NOT NULL,
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  received_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (slack_channel_id, message_ts)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_slack_raw_messages_event_id_unique
  ON slack_raw_messages(slack_event_id)
  WHERE slack_event_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_slack_raw_messages_parsing_status
  ON slack_raw_messages(slack_channel_id, parsing_status, message_at DESC);

CREATE INDEX IF NOT EXISTS idx_slack_ingestion_cycles_channel_time
  ON slack_ingestion_cycles(slack_channel_id, started_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_slack_ingestion_errors_event_id_unique
  ON slack_ingestion_errors(slack_event_id)
  WHERE slack_event_id IS NOT NULL;
