-- Phase 2: explicit, occurrence-level operational outcomes.
-- These records are operator feedback, not historical evidence or ML output.

CREATE TABLE IF NOT EXISTS alert_occurrence_outcomes (
  id BIGSERIAL PRIMARY KEY,
  alert_id TEXT NOT NULL REFERENCES alerts(id) ON DELETE RESTRICT,
  outcome TEXT NOT NULL CHECK (
    outcome IN ('CONFIRMED_INCIDENT', 'CONFIRMED_NOISE', 'UNKNOWN')
  ),
  reason TEXT NOT NULL,
  reason_code TEXT,
  source TEXT NOT NULL CHECK (source IN ('OPERATOR', 'JIRA_INCIDENT')),
  confirmation_method TEXT NOT NULL CHECK (
    confirmation_method IN ('HUMAN_CONFIRMED', 'JIRA_CONFIRMED')
  ),
  confirmation_confidence NUMERIC(5, 4) CHECK (
    confirmation_confidence IS NULL OR (confirmation_confidence >= 0 AND confirmation_confidence <= 1)
  ),
  recorded_at TIMESTAMPTZ NOT NULL,
  recorded_by TEXT NOT NULL,
  recorded_by_id TEXT NOT NULL,
  recorded_by_type TEXT NOT NULL DEFAULT 'user',
  linked_incident_id TEXT,
  linked_incident_key TEXT,
  linked_incident_relationship TEXT,
  linked_incident_at TIMESTAMPTZ,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  notes TEXT,
  is_current BOOLEAN NOT NULL DEFAULT true,
  supersedes_id BIGINT REFERENCES alert_occurrence_outcomes(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (outcome <> 'CONFIRMED_NOISE' OR reason_code IN (
    'AUTO_RESOLVED', 'DUPLICATE', 'FLAPPING', 'NON_ACTIONABLE', 'CORRELATED',
    'STALE', 'EXPECTED_ACTIVITY',
    'TRANSIENT', 'EXPECTED_BEHAVIOR', 'FALSE_POSITIVE', 'OTHER'
  )),
  CHECK (outcome <> 'CONFIRMED_INCIDENT' OR linked_incident_key IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_alert_occurrence_outcomes_current
  ON alert_occurrence_outcomes(alert_id)
  WHERE is_current;

CREATE UNIQUE INDEX IF NOT EXISTS idx_alert_occurrence_outcomes_idempotency
  ON alert_occurrence_outcomes(alert_id, idempotency_key);

CREATE INDEX IF NOT EXISTS idx_alert_occurrence_outcomes_recorded
  ON alert_occurrence_outcomes(recorded_at DESC, alert_id);

CREATE INDEX IF NOT EXISTS idx_alert_occurrence_outcomes_outcome_current
  ON alert_occurrence_outcomes(outcome, recorded_at DESC)
  WHERE is_current;

CREATE TABLE IF NOT EXISTS alert_occurrence_outcome_audit (
  id BIGSERIAL PRIMARY KEY,
  alert_id TEXT NOT NULL REFERENCES alerts(id) ON DELETE RESTRICT,
  outcome_id BIGINT NOT NULL REFERENCES alert_occurrence_outcomes(id) ON DELETE RESTRICT,
  action TEXT NOT NULL CHECK (action IN ('OUTCOME_RECORDED', 'OUTCOME_CORRECTED')),
  actor_id TEXT NOT NULL,
  actor_display TEXT NOT NULL,
  actor_type TEXT NOT NULL DEFAULT 'user',
  idempotency_key TEXT NOT NULL,
  request_context JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_alert_occurrence_outcome_audit_alert
  ON alert_occurrence_outcome_audit(alert_id, created_at DESC, id DESC);

COMMENT ON TABLE alert_occurrence_outcomes IS
  'Versioned explicit operational feedback. Historical evidence and legacy classifications remain separate.';

COMMENT ON TABLE alert_occurrence_outcome_audit IS
  'Append-only audit events for operational-outcome creation and correction.';
