-- Read-only Nagios XI occurrence reconciliation.
-- This table stores source evidence only. It is not a classifier, decision,
-- historical label, human outcome, credential, or authorization store.

CREATE TABLE IF NOT EXISTS nagios_alert_occurrence_evidence (
  alert_id TEXT PRIMARY KEY,
  episode_id TEXT,
  source_instance TEXT,
  host_name TEXT,
  service_description TEXT,
  canonical_identity TEXT,
  object_type TEXT,
  object_id TEXT,
  source_occurrence_id TEXT,
  occurrence_state TEXT,
  occurrence_state_type TEXT,
  current_state TEXT,
  current_source_state TEXT,
  current_state_type TEXT,
  firing_at TIMESTAMPTZ,
  recovery_at TIMESTAMPTZ,
  persistence_seconds INTEGER,
  last_state_change TIMESTAMPTZ,
  last_check TIMESTAMPTZ,
  next_check TIMESTAMPTZ,
  plugin_output TEXT,
  long_plugin_output TEXT,
  performance_data TEXT,
  acknowledged BOOLEAN,
  downtime BOOLEAN,
  notifications_enabled BOOLEAN,
  recovery_authoritative BOOLEAN NOT NULL DEFAULT FALSE,
  previous_occurrence_matched BOOLEAN NOT NULL DEFAULT FALSE,
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

CREATE INDEX IF NOT EXISTS idx_nagios_occurrence_identity_time
  ON nagios_alert_occurrence_evidence(source_instance, host_name, service_description, firing_at DESC);

CREATE INDEX IF NOT EXISTS idx_nagios_occurrence_episode
  ON nagios_alert_occurrence_evidence(episode_id);

CREATE INDEX IF NOT EXISTS idx_nagios_occurrence_object
  ON nagios_alert_occurrence_evidence(source_instance, object_id, firing_at DESC);

COMMENT ON TABLE nagios_alert_occurrence_evidence IS
  'Observation-only Nagios XI alert-to-host/service lifecycle evidence. No Nagios mutations or alert decisions are stored here.';
