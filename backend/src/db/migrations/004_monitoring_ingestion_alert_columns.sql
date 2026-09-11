ALTER TABLE alerts
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'Monitoring',
  ADD COLUMN IF NOT EXISTS raw_payload JSONB,
  ADD COLUMN IF NOT EXISTS noise_reason TEXT,
  ADD COLUMN IF NOT EXISTS classification_reason TEXT,
  ADD COLUMN IF NOT EXISTS slack_channel_id TEXT,
  ADD COLUMN IF NOT EXISTS slack_message_ts TEXT;

ALTER TABLE alerts DROP CONSTRAINT IF EXISTS alerts_environment_check;
ALTER TABLE alerts
  ADD CONSTRAINT alerts_environment_check
  CHECK (environment IN ('production', 'staging', 'development', 'unknown'));

ALTER TABLE alerts DROP CONSTRAINT IF EXISTS alerts_status_check;
ALTER TABLE alerts
  ADD CONSTRAINT alerts_status_check
  CHECK (status IN ('open', 'investigating', 'suppressed', 'auto-resolved', 'deduplicated', 'firing', 'triggered', 'resolved', 'recovered'));

ALTER TABLE alerts DROP CONSTRAINT IF EXISTS alerts_classification_check;
ALTER TABLE alerts
  ADD CONSTRAINT alerts_classification_check
  CHECK (classification IN ('incident', 'noise', 'unclassified'));

CREATE UNIQUE INDEX IF NOT EXISTS idx_alerts_slack_message
  ON alerts(slack_channel_id, slack_message_ts);
