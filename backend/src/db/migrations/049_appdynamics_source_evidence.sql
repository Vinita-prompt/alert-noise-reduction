-- Read-only AppDynamics inventory and occurrence reconciliation.
-- These tables contain source evidence only; they do not store decisions,
-- human outcomes, credentials, or authorization material.

CREATE TABLE IF NOT EXISTS appdynamics_policies (
  application_id TEXT NOT NULL,
  policy_id TEXT NOT NULL,
  policy_name TEXT NOT NULL,
  enabled BOOLEAN,
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (application_id, policy_id)
);

CREATE TABLE IF NOT EXISTS appdynamics_alert_occurrence_evidence (
  alert_id TEXT PRIMARY KEY,
  episode_id TEXT,
  application_id TEXT,
  application_name TEXT,
  source_occurrence_id TEXT,
  event_id TEXT,
  violation_id TEXT,
  tier_id TEXT,
  tier_name TEXT,
  node_id TEXT,
  node_name TEXT,
  business_transaction_id TEXT,
  business_transaction_name TEXT,
  health_rule_id TEXT,
  health_rule_name TEXT,
  policy_id TEXT,
  policy_name TEXT,
  affected_entity TEXT,
  event_type TEXT,
  occurrence_state TEXT,
  current_state TEXT,
  firing_at TIMESTAMPTZ,
  recovery_at TIMESTAMPTZ,
  deep_link TEXT,
  match_method TEXT,
  match_confidence INTEGER CHECK (match_confidence BETWEEN 0 AND 100),
  mapping_status TEXT NOT NULL,
  source_resolved BOOLEAN NOT NULL DEFAULT FALSE,
  technical_evidence_complete BOOLEAN NOT NULL DEFAULT FALSE,
  evaluable BOOLEAN NOT NULL DEFAULT FALSE,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  provenance JSONB NOT NULL DEFAULT '[]'::jsonb,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_appdynamics_occurrence_application_time
  ON appdynamics_alert_occurrence_evidence(application_id, firing_at DESC);

CREATE INDEX IF NOT EXISTS idx_appdynamics_occurrence_episode
  ON appdynamics_alert_occurrence_evidence(episode_id);

COMMENT ON TABLE appdynamics_policies IS
  'Read-only AppDynamics policy inventory. No controller credentials are stored.';

COMMENT ON TABLE appdynamics_alert_occurrence_evidence IS
  'Observation-only AppDynamics alert-to-source-occurrence evidence. It is not a classification or human outcome.';
