-- Evidence workflow outcome migration.
--
-- Legacy human_decision values are deliberately retained in the append-only
-- report/audit rows. evidence_outcome_status is the authoritative workflow
-- status exposed by current APIs, Slack, and the website.

ALTER TABLE incident_verification_reports
  ADD COLUMN IF NOT EXISTS evidence_outcome_status TEXT,
  ADD COLUMN IF NOT EXISTS pending_evidence_reason TEXT,
  ADD COLUMN IF NOT EXISTS pending_evidence_details JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS evidence_form_schema_version TEXT NOT NULL DEFAULT 'structured-evidence-v2';

UPDATE incident_verification_reports
SET evidence_outcome_status = CASE human_decision
  WHEN 'INCIDENT' THEN 'CONFIRMED_INCIDENT'
  WHEN 'NOISE' THEN 'CONFIRMED_NOISE'
  ELSE 'PENDING_EVIDENCE'
END
WHERE evidence_outcome_status IS NULL;

ALTER TABLE incident_verification_reports
  ALTER COLUMN evidence_outcome_status SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'incident_verification_reports_outcome_status_check'
  ) THEN
    ALTER TABLE incident_verification_reports
      ADD CONSTRAINT incident_verification_reports_outcome_status_check
      CHECK (evidence_outcome_status IN (
        'CONFIRMED_INCIDENT', 'CONFIRMED_NOISE', 'PENDING_EVIDENCE'
      ));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS evidence_outcome_migration_audit (
  migration_audit_id TEXT PRIMARY KEY,
  report_id TEXT NOT NULL UNIQUE
    REFERENCES incident_verification_reports(report_id) ON DELETE RESTRICT,
  legacy_human_decision TEXT NOT NULL,
  evidence_outcome_status TEXT NOT NULL CHECK (evidence_outcome_status IN (
    'CONFIRMED_INCIDENT', 'CONFIRMED_NOISE', 'PENDING_EVIDENCE'
  )),
  migration_reason TEXT NOT NULL,
  migrated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO evidence_outcome_migration_audit (
  migration_audit_id, report_id, legacy_human_decision,
  evidence_outcome_status, migration_reason
)
SELECT
  'outcome-migration-' || md5(report_id),
  report_id,
  human_decision,
  evidence_outcome_status,
  CASE WHEN human_decision = 'NEEDS_REVIEW'
    THEN 'LEGACY_NEEDS_REVIEW_MAPPED_TO_PENDING_EVIDENCE'
    ELSE 'LEGACY_CONFIRMED_OUTCOME_CANONICALIZED'
  END
FROM incident_verification_reports
ON CONFLICT (report_id) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_incident_reports_outcome_status_time
  ON incident_verification_reports(evidence_outcome_status, submitted_at DESC, alert_id);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'evidence_backfill_queue_status_check'
  ) THEN
    ALTER TABLE evidence_backfill_queue
      DROP CONSTRAINT evidence_backfill_queue_status_check;
  END IF;
END $$;

UPDATE evidence_backfill_queue
SET status = 'PENDING_EVIDENCE', updated_at = NOW()
WHERE status = 'NEEDS_REVIEW';

ALTER TABLE evidence_backfill_queue
  ADD CONSTRAINT evidence_backfill_queue_status_check
  CHECK (status IN ('PENDING', 'IN_REVIEW', 'VERIFIED', 'PENDING_EVIDENCE', 'SKIPPED'));

COMMENT ON COLUMN incident_verification_reports.evidence_outcome_status IS
  'Authoritative human evidence workflow status. Pending evidence is never a supervised label.';
COMMENT ON TABLE evidence_outcome_migration_audit IS
  'Append-only record of legacy human-decision to evidence-outcome migration; original report values remain unchanged.';
