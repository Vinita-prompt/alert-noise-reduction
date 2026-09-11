CREATE TABLE IF NOT EXISTS slack_raw_messages (
  slack_channel_id TEXT NOT NULL,
  message_ts TEXT NOT NULL,
  slack_channel_name TEXT,
  thread_ts TEXT,
  parent_message_ts TEXT,
  message_type TEXT NOT NULL DEFAULT 'message',
  author_id TEXT,
  author_name TEXT,
  message_text TEXT,
  complete_text TEXT,
  message_at TIMESTAMPTZ,
  reply_count INTEGER NOT NULL DEFAULT 0,
  reactions JSONB NOT NULL DEFAULT '[]'::jsonb,
  links JSONB NOT NULL DEFAULT '[]'::jsonb,
  permalink TEXT,
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  first_stored_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (slack_channel_id, message_ts)
);

CREATE TABLE IF NOT EXISTS slack_alert_events (
  slack_channel_id TEXT NOT NULL,
  source_message_ts TEXT NOT NULL,
  alert_id TEXT NOT NULL,
  alert_number TEXT NOT NULL,
  slack_channel_name TEXT,
  title TEXT,
  source_system TEXT NOT NULL DEFAULT 'Unknown',
  severity TEXT,
  priority TEXT,
  service TEXT,
  application TEXT,
  environment TEXT,
  tier TEXT,
  responder TEXT,
  status TEXT,
  tags JSONB NOT NULL DEFAULT '[]'::jsonb,
  description TEXT,
  message_at TIMESTAMPTZ,
  slack_permalink TEXT,
  thread_ts TEXT,
  reply_count INTEGER NOT NULL DEFAULT 0,
  author_id TEXT,
  author_name TEXT,
  links JSONB NOT NULL DEFAULT '[]'::jsonb,
  raw_message TEXT NOT NULL,
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (slack_channel_id, source_message_ts)
);

CREATE TABLE IF NOT EXISTS slack_normalized_alerts (
  id TEXT PRIMARY KEY,
  slack_channel_id TEXT NOT NULL,
  slack_channel_name TEXT,
  source_message_ts TEXT NOT NULL,
  alert_number TEXT NOT NULL,
  title TEXT,
  source_system TEXT NOT NULL DEFAULT 'Unknown',
  severity TEXT,
  priority TEXT,
  service TEXT,
  application TEXT,
  environment TEXT,
  tier TEXT,
  responder TEXT,
  status TEXT,
  tags JSONB NOT NULL DEFAULT '[]'::jsonb,
  description TEXT,
  first_seen TIMESTAMPTZ,
  last_seen TIMESTAMPTZ,
  occurrence_count INTEGER NOT NULL DEFAULT 1,
  source TEXT NOT NULL DEFAULT 'slack',
  slack_permalink TEXT,
  thread_ts TEXT,
  reply_count INTEGER NOT NULL DEFAULT 0,
  author_id TEXT,
  author_name TEXT,
  links JSONB NOT NULL DEFAULT '[]'::jsonb,
  raw_message TEXT NOT NULL,
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (slack_channel_id, alert_number)
);

CREATE TABLE IF NOT EXISTS slack_alert_extraction_state (
  slack_channel_id TEXT PRIMARY KEY,
  slack_channel_name TEXT,
  workspace_name TEXT,
  status TEXT NOT NULL DEFAULT 'idle',
  pages_scanned INTEGER NOT NULL DEFAULT 0,
  messages_scanned INTEGER NOT NULL DEFAULT 0,
  alert_messages_detected INTEGER NOT NULL DEFAULT 0,
  unique_alert_numbers INTEGER NOT NULL DEFAULT 0,
  source_counts JSONB NOT NULL DEFAULT '{}'::jsonb,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  last_error TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_slack_raw_messages_time
  ON slack_raw_messages(slack_channel_id, message_at DESC);
CREATE INDEX IF NOT EXISTS idx_slack_alert_events_number
  ON slack_alert_events(slack_channel_id, alert_number);
CREATE INDEX IF NOT EXISTS idx_slack_alert_events_time
  ON slack_alert_events(message_at DESC);
CREATE INDEX IF NOT EXISTS idx_slack_normalized_alerts_time
  ON slack_normalized_alerts(last_seen DESC);
CREATE INDEX IF NOT EXISTS idx_slack_normalized_alerts_source
  ON slack_normalized_alerts(source_system);
CREATE INDEX IF NOT EXISTS idx_slack_normalized_alerts_severity
  ON slack_normalized_alerts(severity);
