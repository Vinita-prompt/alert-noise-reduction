-- Phase 2.5: preserve the verified human principal and correction context in
-- every operational-outcome audit event. No outcome rows are created here.

ALTER TABLE alert_occurrence_outcome_audit
  ADD COLUMN IF NOT EXISTS actor_email TEXT,
  ADD COLUMN IF NOT EXISTS actor_roles JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS actor_permissions JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS authorization_basis TEXT,
  ADD COLUMN IF NOT EXISTS previous_outcome_id BIGINT REFERENCES alert_occurrence_outcomes(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS previous_outcome TEXT,
  ADD COLUMN IF NOT EXISTS new_outcome TEXT,
  ADD COLUMN IF NOT EXISTS reason TEXT,
  ADD COLUMN IF NOT EXISTS reason_code TEXT,
  ADD COLUMN IF NOT EXISTS notes TEXT,
  ADD COLUMN IF NOT EXISTS linked_incident_id TEXT,
  ADD COLUMN IF NOT EXISTS linked_incident_key TEXT,
  ADD COLUMN IF NOT EXISTS supersedes_id BIGINT REFERENCES alert_occurrence_outcomes(id) ON DELETE RESTRICT;

COMMENT ON TABLE alert_occurrence_outcome_audit IS
  'Append-only authenticated human outcome events with authorization and correction provenance.';
