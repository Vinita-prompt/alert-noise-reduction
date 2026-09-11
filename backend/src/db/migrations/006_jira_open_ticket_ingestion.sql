ALTER TABLE alerts ADD COLUMN IF NOT EXISTS jira_ticket_id VARCHAR(50);
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS raw_payload JSONB;
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS source_url TEXT;

CREATE INDEX IF NOT EXISTS idx_alerts_jira_ticket_id ON alerts(jira_ticket_id);
CREATE INDEX IF NOT EXISTS idx_alerts_source ON alerts(source);
