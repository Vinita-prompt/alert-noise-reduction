-- Phase 5: AppDynamics -> Jira outcome reconstruction.
-- Analytical evidence only. No row in this schema is an operational outcome,
-- a confirmed Noise label, or a production model decision.

CREATE TABLE IF NOT EXISTS appdynamics_jira_outcome_reconstruction_runs (
  run_id TEXT PRIMARY KEY,
  reconstruction_version TEXT NOT NULL,
  window_start TIMESTAMPTZ,
  window_end TIMESTAMPTZ NOT NULL,
  window_scope TEXT NOT NULL CHECK (window_scope IN ('ALL_STORED', 'BOUNDED')),
  source_snapshot_fingerprint TEXT NOT NULL,
  summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  read_only_sources BOOLEAN NOT NULL DEFAULT true CHECK (read_only_sources),
  production_classifier_enabled BOOLEAN NOT NULL DEFAULT false CHECK (NOT production_classifier_enabled),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS appdynamics_jira_outcome_timeline (
  id BIGSERIAL PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES appdynamics_jira_outcome_reconstruction_runs(run_id) ON DELETE RESTRICT,
  alert_id TEXT NOT NULL REFERENCES alerts(id) ON DELETE RESTRICT,
  appdynamics_source_id TEXT,
  feature_as_of TIMESTAMPTZ NOT NULL,
  appdynamics_occurrence_start TIMESTAMPTZ,
  appdynamics_occurrence_end TIMESTAMPTZ,
  appdynamics_duration_seconds INTEGER,
  occurrence_count INTEGER,
  occurrence_quality TEXT NOT NULL CHECK (occurrence_quality IN ('RELIABLE_OCCURRENCE','SOURCE_AGGREGATED','SUSPECT','UNAVAILABLE')),
  origin_semantics TEXT NOT NULL CHECK (origin_semantics IN ('PRIMARY_APPDYNAMICS_OCCURRENCE','COMMUNICATION_DERIVED_APPDYNAMICS')),
  status TEXT,
  message TEXT,
  severity TEXT,
  priority TEXT,
  environment TEXT,
  service TEXT,
  application TEXT,
  application_id TEXT,
  tier TEXT,
  node TEXT,
  business_transaction TEXT,
  metric_name TEXT,
  metric_value DOUBLE PRECISION,
  threshold_value DOUBLE PRECISION,
  violation_state TEXT,
  jira_alert_id TEXT,
  jira_incident_key TEXT,
  jira_incident_id TEXT,
  incident_created_at TIMESTAMPTZ,
  incident_time_delta_seconds INTEGER,
  jira_problem_key TEXT,
  slack_message_id TEXT,
  slack_acknowledged_at TIMESTAMPTZ,
  slack_responder TEXT,
  slack_activity_count INTEGER NOT NULL DEFAULT 0,
  investigation_activity_count INTEGER NOT NULL DEFAULT 0,
  outcome_evidence TEXT NOT NULL CHECK (outcome_evidence IN ('INCIDENT_EVIDENCE','NO_ESCALATION_EVIDENCE','INSUFFICIENT_EVIDENCE')),
  evidence_strength TEXT NOT NULL CHECK (evidence_strength IN ('STRONG','MODERATE','WEAK')),
  evidence_reason TEXT NOT NULL,
  evidence_sources JSONB NOT NULL DEFAULT '[]'::jsonb,
  evidence_record_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  evidence_provenance JSONB NOT NULL DEFAULT '{}'::jsonb,
  candidate_signal TEXT NOT NULL DEFAULT 'NONE' CHECK (candidate_signal IN ('NONE','NOISE_CANDIDATE','INCIDENT_CANDIDATE')),
  candidate_strength TEXT CHECK (candidate_strength IS NULL OR candidate_strength IN ('STRONG','MODERATE','WEAK')),
  prediction_time_features JSONB NOT NULL DEFAULT '{}'::jsonb,
  behavior_timeline JSONB NOT NULL DEFAULT '[]'::jsonb,
  workflow_timeline JSONB NOT NULL DEFAULT '[]'::jsonb,
  computed_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (run_id, alert_id)
);

ALTER TABLE appdynamics_jira_outcome_timeline ADD COLUMN IF NOT EXISTS message TEXT;
ALTER TABLE appdynamics_jira_outcome_timeline ADD COLUMN IF NOT EXISTS severity TEXT;
ALTER TABLE appdynamics_jira_outcome_timeline ADD COLUMN IF NOT EXISTS priority TEXT;
ALTER TABLE appdynamics_jira_outcome_timeline ADD COLUMN IF NOT EXISTS environment TEXT;
ALTER TABLE appdynamics_jira_outcome_timeline ADD COLUMN IF NOT EXISTS service TEXT;

CREATE INDEX IF NOT EXISTS idx_appd_jira_timeline_run_time
  ON appdynamics_jira_outcome_timeline(run_id, feature_as_of DESC, alert_id);
CREATE INDEX IF NOT EXISTS idx_appd_jira_timeline_run_outcome
  ON appdynamics_jira_outcome_timeline(run_id, outcome_evidence, evidence_strength);
CREATE INDEX IF NOT EXISTS idx_appd_jira_timeline_run_candidate
  ON appdynamics_jira_outcome_timeline(run_id, candidate_signal, candidate_strength);
CREATE INDEX IF NOT EXISTS idx_appd_jira_timeline_incident
  ON appdynamics_jira_outcome_timeline(jira_incident_key)
  WHERE jira_incident_key IS NOT NULL;

CREATE OR REPLACE VIEW appdynamics_outcome_dataset_v1 AS
SELECT timeline.*
FROM appdynamics_jira_outcome_timeline timeline
JOIN (
  SELECT run_id
  FROM appdynamics_jira_outcome_reconstruction_runs
  ORDER BY window_end DESC, created_at DESC, run_id DESC
  LIMIT 1
) latest ON latest.run_id = timeline.run_id;

COMMENT ON TABLE appdynamics_jira_outcome_timeline IS
  'Phase 5 analytical AppDynamics-to-Jira evidence. Candidate signals are not operational classifications.';
COMMENT ON COLUMN appdynamics_jira_outcome_timeline.prediction_time_features IS
  'T+0/prediction-time fields only; current Jira outcome and later Slack workflow are excluded.';
COMMENT ON COLUMN appdynamics_jira_outcome_timeline.candidate_signal IS
  'Analytical candidate only. NOISE_CANDIDATE is never CONFIRMED_NOISE.';
