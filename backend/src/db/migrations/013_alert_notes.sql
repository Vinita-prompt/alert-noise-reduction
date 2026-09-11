CREATE TABLE IF NOT EXISTS alert_notes (
  id BIGSERIAL PRIMARY KEY,
  alert_id TEXT NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
  note TEXT NOT NULL,
  created_by TEXT NOT NULL DEFAULT 'Website operator',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_alert_notes_alert_id
  ON alert_notes(alert_id, created_at DESC);
