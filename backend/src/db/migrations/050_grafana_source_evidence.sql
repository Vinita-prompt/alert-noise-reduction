-- Read-only Grafana occurrence reconciliation.
-- This table stores source evidence only. It is not a classifier, decision,
-- historical label, human outcome, credential, or authorization store.

CREATE TABLE IF NOT EXISTS grafana_alert_occurrence_evidence (
  alert_id TEXT PRIMARY KEY,
  episode_id TEXT,
  workspace_host TEXT,
  integration_host TEXT,
  rule_uid TEXT,
  rule_name TEXT,
  fingerprint TEXT,
  source_occurrence_id TEXT,
  instance_labels JSONB NOT NULL DEFAULT '{}'::jsonb,
  annotations JSONB NOT NULL DEFAULT '{}'::jsonb,
  dashboard_uid TEXT,
  panel_id TEXT,
  datasource_references JSONB NOT NULL DEFAULT '[]'::jsonb,
  condition TEXT,
  occurrence_state TEXT,
  current_state TEXT,
  firing_at TIMESTAMPTZ,
  recovery_at TIMESTAMPTZ,
  persistence_seconds INTEGER,
  identity_quality TEXT NOT NULL DEFAULT 'UNRESOLVED',
  match_method TEXT,
  match_confidence INTEGER CHECK (match_confidence BETWEEN 0 AND 100),
  mapping_status TEXT NOT NULL,
  failure_classification TEXT,
  blocker TEXT,
  source_resolved BOOLEAN NOT NULL DEFAULT FALSE,
  technical_evidence_complete BOOLEAN NOT NULL DEFAULT FALSE,
  evaluable BOOLEAN NOT NULL DEFAULT FALSE,
  historical_profile JSONB NOT NULL DEFAULT '{}'::jsonb,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  provenance JSONB NOT NULL DEFAULT '[]'::jsonb,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_grafana_occurrence_rule_time
  ON grafana_alert_occurrence_evidence(rule_uid, firing_at DESC);

CREATE INDEX IF NOT EXISTS idx_grafana_occurrence_episode
  ON grafana_alert_occurrence_evidence(episode_id);

CREATE INDEX IF NOT EXISTS idx_grafana_occurrence_fingerprint
  ON grafana_alert_occurrence_evidence(fingerprint, firing_at DESC);

COMMENT ON TABLE grafana_alert_occurrence_evidence IS
  'Observation-only Grafana alert-to-rule-instance lifecycle evidence. No Grafana mutations or alert decisions are stored here.';
