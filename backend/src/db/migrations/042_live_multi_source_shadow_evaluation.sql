-- Phase 6: live multi-source shadow evaluation and feedback learning.
--
-- This schema is analytical only. Monitoring/Jira/Slack reads may contribute
-- evidence, but no source-system mutation or production decision is allowed.

CREATE TABLE IF NOT EXISTS live_source_connectivity_checks (
  id BIGSERIAL PRIMARY KEY,
  source TEXT NOT NULL CHECK (source IN ('AppDynamics', 'Grafana', 'Nagios', 'ThousandEyes')),
  source_instance TEXT,
  status TEXT NOT NULL CHECK (status IN (
    'CONNECTED', 'NOT_CONFIGURED', 'AUTHENTICATION_FAILED', 'FORBIDDEN',
    'NOT_FOUND', 'TIMEOUT', 'CERTIFICATE_ERROR', 'UNAVAILABLE'
  )),
  configured BOOLEAN NOT NULL DEFAULT false,
  authenticated BOOLEAN,
  reachable BOOLEAN,
  api_response_successful BOOLEAN NOT NULL DEFAULT false,
  required_endpoint TEXT,
  required_endpoint_available BOOLEAN,
  required_permissions_available BOOLEAN,
  source_data_usable BOOLEAN NOT NULL DEFAULT false,
  http_status INTEGER,
  safe_error TEXT,
  safe_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_live_source_connectivity_latest
  ON live_source_connectivity_checks(source, source_instance, checked_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS live_shadow_evaluations (
  evaluation_id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  alert_id TEXT NOT NULL REFERENCES alerts(id) ON DELETE RESTRICT,
  source TEXT NOT NULL,
  source_alert_id TEXT,
  feature_as_of TIMESTAMPTZ NOT NULL,
  mode TEXT NOT NULL DEFAULT 'SHADOW' CHECK (mode = 'SHADOW'),
  model_version TEXT NOT NULL,
  model_release_status TEXT NOT NULL CHECK (
    model_release_status IN ('NOT_READY', 'SHADOW_ONLY', 'CANDIDATE', 'APPROVED')
  ),
  final_decision TEXT NOT NULL CHECK (final_decision IN ('NOISE', 'INCIDENT', 'NEEDS_REVIEW')),
  confidence DOUBLE PRECISION CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  experimental_incident_risk_score DOUBLE PRECISION CHECK (
    experimental_incident_risk_score IS NULL
    OR (experimental_incident_risk_score >= 0 AND experimental_incident_risk_score <= 1)
  ),
  business_impact TEXT NOT NULL CHECK (business_impact IN ('CONFIRMED', 'PROBABLE', 'UNKNOWN', 'NOT_OBSERVED')),
  actionability TEXT NOT NULL CHECK (actionability IN ('ACTIONABLE', 'NON_ACTIONABLE', 'UNKNOWN')),
  underlying_event TEXT NOT NULL CHECK (underlying_event IN (
    'CONFIRMED_INCIDENT', 'PROBABLE_INCIDENT', 'KNOWN_OPERATIONAL_EVENT',
    'NO_CONFIRMED_EVENT', 'UNKNOWN'
  )),
  notification_role TEXT NOT NULL CHECK (notification_role IN ('PRIMARY', 'REDUNDANT', 'SUPPORTING', 'DUPLICATE', 'UNKNOWN')),
  noise_detection JSONB NOT NULL DEFAULT '{}'::jsonb,
  classification JSONB NOT NULL DEFAULT '{}'::jsonb,
  feature_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  technical_evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  evidence_references JSONB NOT NULL DEFAULT '[]'::jsonb,
  explanation JSONB NOT NULL DEFAULT '{}'::jsonb,
  adapter_diagnostics JSONB NOT NULL DEFAULT '[]'::jsonb,
  failure_reasons JSONB NOT NULL DEFAULT '[]'::jsonb,
  evaluation_time_ms INTEGER NOT NULL DEFAULT 0,
  source_mutations INTEGER NOT NULL DEFAULT 0 CHECK (source_mutations = 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_live_shadow_evaluations_alert_time
  ON live_shadow_evaluations(alert_id, feature_as_of DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_live_shadow_evaluations_source_time
  ON live_shadow_evaluations(source, feature_as_of DESC);
CREATE INDEX IF NOT EXISTS idx_live_shadow_evaluations_decision_time
  ON live_shadow_evaluations(final_decision, feature_as_of DESC);

CREATE OR REPLACE VIEW live_shadow_evaluations_latest_v1 AS
SELECT DISTINCT ON (evaluation.alert_id) evaluation.*
FROM live_shadow_evaluations evaluation
ORDER BY evaluation.alert_id, evaluation.created_at DESC, evaluation.feature_as_of DESC;

CREATE OR REPLACE VIEW model_feedback_dataset_v1 AS
SELECT
  evaluation.evaluation_id,
  evaluation.alert_id,
  evaluation.source,
  evaluation.model_version,
  evaluation.feature_as_of,
  evaluation.final_decision AS prediction,
  evaluation.confidence,
  outcome.id AS operational_outcome_id,
  outcome.outcome AS actual_outcome,
  outcome.reason AS outcome_reason,
  outcome.reason_code,
  outcome.recorded_at AS outcome_timestamp,
  outcome.recorded_by,
  outcome.linked_incident_key,
  CASE
    WHEN outcome.id IS NULL THEN NULL
    WHEN evaluation.final_decision = 'NOISE' AND outcome.outcome = 'CONFIRMED_NOISE' THEN 'CORRECT_NOISE'
    WHEN evaluation.final_decision = 'NOISE' AND outcome.outcome = 'CONFIRMED_INCIDENT' THEN 'FALSE_NOISE'
    WHEN evaluation.final_decision = 'INCIDENT' AND outcome.outcome = 'CONFIRMED_INCIDENT' THEN 'CORRECT_INCIDENT'
    WHEN evaluation.final_decision = 'INCIDENT' AND outcome.outcome = 'CONFIRMED_NOISE' THEN 'FALSE_INCIDENT'
    WHEN evaluation.final_decision = 'NEEDS_REVIEW' AND outcome.outcome = 'UNKNOWN' THEN 'CORRECT_REVIEW'
    WHEN evaluation.final_decision = 'NEEDS_REVIEW' AND outcome.outcome = 'CONFIRMED_NOISE' THEN 'REVIEW_TO_NOISE'
    WHEN evaluation.final_decision = 'NEEDS_REVIEW' AND outcome.outcome = 'CONFIRMED_INCIDENT' THEN 'REVIEW_TO_INCIDENT'
    ELSE NULL
  END AS feedback_error_type
FROM live_shadow_evaluations_latest_v1 evaluation
LEFT JOIN alert_occurrence_outcomes outcome
  ON outcome.alert_id = evaluation.alert_id AND outcome.is_current;

CREATE OR REPLACE VIEW model_gold_evaluation_dataset_v1 AS
SELECT
  outcome.id AS operational_outcome_id,
  outcome.alert_id,
  COALESCE(evaluation.source, alert.source) AS source,
  alert.severity,
  alert.environment,
  alert.learning_alert_signature_v1 AS alert_signature,
  taxonomy.corrected_domain,
  taxonomy.corrected_subtype,
  outcome.outcome AS ground_truth,
  outcome.reason,
  outcome.reason_code,
  outcome.recorded_at,
  outcome.recorded_by,
  outcome.linked_incident_key,
  evaluation.evaluation_id,
  evaluation.model_version,
  evaluation.final_decision,
  evaluation.feature_as_of,
  evaluation.feature_snapshot,
  evaluation.evidence_references
FROM alert_occurrence_outcomes outcome
JOIN alerts alert ON alert.id = outcome.alert_id
LEFT JOIN live_shadow_evaluations_latest_v1 evaluation ON evaluation.alert_id = outcome.alert_id
LEFT JOIN alert_occurrence_taxonomy_corrections taxonomy
  ON taxonomy.alert_id = outcome.alert_id AND taxonomy.is_current
WHERE outcome.is_current
  AND outcome.outcome IN ('CONFIRMED_NOISE', 'CONFIRMED_INCIDENT');

COMMENT ON TABLE live_shadow_evaluations IS
  'Phase 6 shadow-only evaluations. A prediction is never an operational outcome or training label.';
COMMENT ON VIEW model_feedback_dataset_v1 IS
  'Auditable join of shadow predictions to separately authenticated operational outcomes.';
COMMENT ON VIEW model_gold_evaluation_dataset_v1 IS
  'Confirmed human/Jira outcomes only. Predictions never create ground truth.';
