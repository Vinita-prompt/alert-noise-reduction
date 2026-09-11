CREATE INDEX IF NOT EXISTS idx_slack_normalized_alerts_alert_number_last_seen
  ON slack_normalized_alerts(alert_number, last_seen DESC);

CREATE INDEX IF NOT EXISTS idx_slack_normalized_alerts_command_center
  ON slack_normalized_alerts(alert_number)
  WHERE LOWER(BTRIM(COALESCE(responder, team, ''))) = 'command center';

CREATE INDEX IF NOT EXISTS idx_alerts_ops_tiny_id
  ON alerts(atlassian_ops_tiny_id);
