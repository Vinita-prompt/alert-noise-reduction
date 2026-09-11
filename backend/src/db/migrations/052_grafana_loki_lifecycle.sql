-- Authoritative read-only Grafana Loki lifecycle enrichment.
-- These columns contain source evidence only and never store decisions,
-- credentials, historical labels, or human outcomes.

ALTER TABLE grafana_alert_occurrence_evidence
  ADD COLUMN IF NOT EXISTS pending_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS pending_seconds INTEGER,
  ADD COLUMN IF NOT EXISTS transition_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS transition_sequence JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS lifecycle_evidence_quality TEXT NOT NULL DEFAULT 'UNAVAILABLE',
  ADD COLUMN IF NOT EXISTS firing_observed BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS recovery_authoritative BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS current_instance_observed BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS repeat_notification_count INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_grafana_occurrence_rule_fingerprint_time
  ON grafana_alert_occurrence_evidence(rule_uid, fingerprint, firing_at DESC);

COMMENT ON COLUMN grafana_alert_occurrence_evidence.lifecycle_evidence_quality IS
  'AUTHORITATIVE, STRUCTURED, UNAVAILABLE, or CONFLICT source-evidence quality; not a classification.';
