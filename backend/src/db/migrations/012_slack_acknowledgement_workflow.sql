ALTER TABLE alerts ADD COLUMN IF NOT EXISTS acknowledged BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS acknowledged_by TEXT;
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS acknowledged_at TIMESTAMPTZ;
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS acknowledgement_source TEXT;
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS escalation_status BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS escalated_at TIMESTAMPTZ;
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS escalation_reason TEXT;
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS responders JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE alerts DROP CONSTRAINT IF EXISTS alerts_status_check;
ALTER TABLE alerts
  ADD CONSTRAINT alerts_status_check
  CHECK (status IN ('open', 'acknowledged', 'escalated', 'investigating', 'suppressed', 'auto-resolved', 'deduplicated', 'firing', 'triggered', 'resolved', 'recovered', 'closed'));

CREATE TABLE IF NOT EXISTS alert_acknowledgements (
  id BIGSERIAL PRIMARY KEY,
  alert_id TEXT NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
  acknowledged_by TEXT NOT NULL,
  slack_user_id TEXT,
  acknowledgement_source TEXT NOT NULL DEFAULT 'slack',
  acknowledged_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS alert_escalations (
  id BIGSERIAL PRIMARY KEY,
  alert_id TEXT NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
  escalation_reason TEXT NOT NULL,
  previous_severity TEXT,
  new_severity TEXT,
  responder_team TEXT,
  escalated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS alert_relations (
  id BIGSERIAL PRIMARY KEY,
  alert_id TEXT NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
  related_alert_id TEXT,
  relation_type TEXT NOT NULL DEFAULT 'related',
  relation_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS audit_events (
  id BIGSERIAL PRIMARY KEY,
  alert_id TEXT REFERENCES alerts(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  actor TEXT,
  source TEXT NOT NULL DEFAULT 'backend',
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS slack_notifications (
  id BIGSERIAL PRIMARY KEY,
  alert_id TEXT REFERENCES alerts(id) ON DELETE CASCADE,
  channel_id TEXT,
  message_ts TEXT,
  notification_type TEXT NOT NULL DEFAULT 'alert_acknowledgement',
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'pending',
  sent_at TIMESTAMPTZ,
  acknowledged_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_alerts_acknowledged ON alerts(acknowledged, escalation_status, received_at);
CREATE INDEX IF NOT EXISTS idx_alert_acknowledgements_alert_id ON alert_acknowledgements(alert_id, acknowledged_at DESC);
CREATE INDEX IF NOT EXISTS idx_alert_escalations_alert_id ON alert_escalations(alert_id, escalated_at DESC);
CREATE INDEX IF NOT EXISTS idx_alert_relations_alert_id ON alert_relations(alert_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_events_alert_id ON audit_events(alert_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_slack_notifications_alert_id ON slack_notifications(alert_id, created_at DESC);
