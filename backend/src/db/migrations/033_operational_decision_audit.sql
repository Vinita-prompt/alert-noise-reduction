CREATE TABLE IF NOT EXISTS operational_decision_audit (
  evaluation_id TEXT PRIMARY KEY,
  occurrence_id TEXT NOT NULL,
  alert_number TEXT,
  decision_model_version TEXT NOT NULL,
  input_version TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('INCIDENT', 'NOISE', 'NEEDS_REVIEW')),
  subtype TEXT NOT NULL,
  rule_id TEXT NOT NULL,
  rule_version TEXT NOT NULL,
  confidence TEXT NOT NULL CHECK (confidence IN ('HIGH', 'MEDIUM', 'LOW')),
  previous_decision TEXT,
  reason_for_change TEXT NOT NULL,
  evaluation_json JSONB NOT NULL,
  evaluated_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS operational_decision_occurrence_time_idx
  ON operational_decision_audit(occurrence_id, evaluated_at DESC);
