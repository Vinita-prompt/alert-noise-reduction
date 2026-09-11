-- Append-only evidence backfill and learning workflow.
-- This migration never rewrites historical alerts, outcomes, or classifications.

ALTER TABLE incident_verification_reports
  ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'LIVE'
    CHECK (origin IN ('LIVE', 'BACKFILL')),
  ADD COLUMN IF NOT EXISTS update_of_report_id TEXT
    REFERENCES incident_verification_reports(report_id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS evidence_completeness TEXT NOT NULL DEFAULT 'PARTIAL'
    CHECK (evidence_completeness IN ('COMPLETE', 'PARTIAL', 'MISSING'));

CREATE TABLE IF NOT EXISTS evidence_backfill_queue (
  queue_id TEXT PRIMARY KEY,
  alert_id TEXT NOT NULL REFERENCES alerts(id) ON DELETE RESTRICT,
  evaluation_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'IN_REVIEW', 'VERIFIED', 'NEEDS_REVIEW', 'SKIPPED')),
  origin TEXT NOT NULL DEFAULT 'BACKFILL' CHECK (origin = 'BACKFILL'),
  reason TEXT NOT NULL,
  priority TEXT,
  monitoring_source TEXT,
  evidence_completeness TEXT NOT NULL DEFAULT 'MISSING'
    CHECK (evidence_completeness IN ('COMPLETE', 'PARTIAL', 'MISSING')),
  imported_evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  evidence_provenance JSONB NOT NULL DEFAULT '[]'::jsonb,
  source_timestamps JSONB NOT NULL DEFAULT '{}'::jsonb,
  selected_by TEXT,
  selected_at TIMESTAMPTZ,
  completed_report_id TEXT REFERENCES incident_verification_reports(report_id) ON DELETE RESTRICT,
  queued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(alert_id)
);

CREATE INDEX IF NOT EXISTS idx_evidence_backfill_queue_status_time
  ON evidence_backfill_queue(status, queued_at DESC);
CREATE INDEX IF NOT EXISTS idx_evidence_backfill_queue_source_priority
  ON evidence_backfill_queue(monitoring_source, priority, status);

CREATE TABLE IF NOT EXISTS evidence_provenance_observations (
  observation_id TEXT PRIMARY KEY,
  alert_id TEXT NOT NULL REFERENCES alerts(id) ON DELETE RESTRICT,
  queue_id TEXT REFERENCES evidence_backfill_queue(queue_id) ON DELETE RESTRICT,
  report_id TEXT REFERENCES incident_verification_reports(report_id) ON DELETE RESTRICT,
  origin TEXT NOT NULL CHECK (origin IN ('LIVE', 'BACKFILL')),
  source_system TEXT NOT NULL,
  evidence_kind TEXT NOT NULL,
  evidence_value JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_timestamp TIMESTAMPTZ,
  collected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_evidence_provenance_alert_time
  ON evidence_provenance_observations(alert_id, collected_at DESC);

CREATE TABLE IF NOT EXISTS evidence_learning_records (
  learning_record_id TEXT PRIMARY KEY,
  report_id TEXT NOT NULL UNIQUE REFERENCES incident_verification_reports(report_id) ON DELETE RESTRICT,
  alert_id TEXT NOT NULL REFERENCES alerts(id) ON DELETE RESTRICT,
  episode_id TEXT NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('LIVE', 'BACKFILL')),
  source TEXT,
  priority TEXT,
  source_identity JSONB NOT NULL DEFAULT '{}'::jsonb,
  alert_state TEXT,
  duration_seconds DOUBLE PRECISION,
  auto_resolved BOOLEAN,
  duplicate_count INTEGER,
  repeat_count INTEGER,
  flapping BOOLEAN,
  event_identifiers JSONB NOT NULL DEFAULT '{}'::jsonb,
  customer_business_impact TEXT,
  action_taken TEXT,
  jira_outcome JSONB NOT NULL DEFAULT '{}'::jsonb,
  responder TEXT,
  resolution_method TEXT,
  evidence_completeness TEXT NOT NULL
    CHECK (evidence_completeness IN ('COMPLETE', 'PARTIAL', 'MISSING')),
  human_decision TEXT NOT NULL
    CHECK (human_decision IN ('INCIDENT', 'NOISE', 'NEEDS_REVIEW')),
  label_status TEXT NOT NULL CHECK (label_status IN ('VERIFIED', 'UNLABELED')),
  training_eligible BOOLEAN NOT NULL DEFAULT FALSE,
  training_exclusion_reason TEXT,
  dataset_split TEXT CHECK (dataset_split IN ('TRAIN', 'VALIDATION', 'HOLDOUT')),
  feature_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  attachment_references JSONB NOT NULL DEFAULT '[]'::jsonb,
  evidence_provenance JSONB NOT NULL DEFAULT '[]'::jsonb,
  reviewer_id TEXT NOT NULL,
  reviewed_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_evidence_learning_label_split
  ON evidence_learning_records(label_status, dataset_split, source, priority);
CREATE INDEX IF NOT EXISTS idx_evidence_learning_alert_time
  ON evidence_learning_records(alert_id, reviewed_at DESC);

CREATE TABLE IF NOT EXISTS evidence_label_feedback_events (
  feedback_event_id TEXT PRIMARY KEY,
  alert_id TEXT NOT NULL REFERENCES alerts(id) ON DELETE RESTRICT,
  original_report_id TEXT REFERENCES incident_verification_reports(report_id) ON DELETE RESTRICT,
  corrected_report_id TEXT NOT NULL REFERENCES incident_verification_reports(report_id) ON DELETE RESTRICT,
  original_label TEXT,
  corrected_label TEXT NOT NULL,
  reviewer_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_evidence_label_feedback_alert_time
  ON evidence_label_feedback_events(alert_id, created_at DESC);

CREATE TABLE IF NOT EXISTS evidence_pattern_recommendations (
  recommendation_id TEXT PRIMARY KEY,
  alert_id TEXT NOT NULL REFERENCES alerts(id) ON DELETE RESTRICT,
  model_version TEXT NOT NULL,
  feature_snapshot_id TEXT NOT NULL,
  recommendation TEXT NOT NULL CHECK (recommendation IN ('INCIDENT', 'NOISE', 'NEEDS_REVIEW')),
  confidence DOUBLE PRECISION,
  matching_patterns JSONB NOT NULL DEFAULT '[]'::jsonb,
  supporting_evidence JSONB NOT NULL DEFAULT '[]'::jsonb,
  missing_evidence JSONB NOT NULL DEFAULT '[]'::jsonb,
  decision_dimensions JSONB NOT NULL DEFAULT '{}'::jsonb,
  shadow_only BOOLEAN NOT NULL DEFAULT TRUE,
  reviewer_outcome TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_evidence_pattern_recommendations_alert_time
  ON evidence_pattern_recommendations(alert_id, created_at DESC);

COMMENT ON TABLE evidence_backfill_queue IS
  'Command Center historical alerts selected for append-only evidence review; historical alerts are never overwritten.';
COMMENT ON TABLE evidence_learning_records IS
  'Structured records derived only from reviewed evidence. Needs Review remains unlabeled and model output never creates labels.';

-- Preserve all feedback rows while excluding Needs Review from supervised labels.
CREATE OR REPLACE VIEW validated_human_feedback_v1 AS
WITH episode_state AS (
  SELECT alert_id, episode_id,
    COUNT(DISTINCT human_decision) FILTER (WHERE status = 'VALIDATED') AS validated_decisions,
    BOOL_OR(validation_code = 'HUMAN_FEEDBACK_CONFLICT') AS has_conflict
  FROM human_verification_feedback
  GROUP BY alert_id, episode_id
), ranked AS (
  SELECT feedback.*,
    ROW_NUMBER() OVER (
      PARTITION BY feedback.alert_id, feedback.episode_id
      ORDER BY feedback.created_at DESC, feedback.feedback_id DESC
    ) AS episode_rank
  FROM human_verification_feedback feedback
  WHERE feedback.status = 'VALIDATED'
)
SELECT ranked.*
FROM ranked
JOIN episode_state USING (alert_id, episode_id)
WHERE ranked.episode_rank = 1
  AND episode_state.validated_decisions = 1
  AND NOT episode_state.has_conflict
  AND COALESCE(ranked.metadata->>'groupingDisposition', '') NOT IN (
    'GROUPING_SUPERSEDED', 'LEGACY_GROUPING_REQUIRES_REPLAY'
  )
  AND ranked.training_eligible
  AND ranked.human_decision IN ('INCIDENT', 'NOISE')
  AND NOT ranked.is_test;
