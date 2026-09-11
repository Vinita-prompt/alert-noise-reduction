-- Durable Slack Events API and Interactivity ingress.
-- A callback is persisted before it is acknowledged, claimed with a lease,
-- and retried without creating a second logical delivery.

CREATE TABLE IF NOT EXISTS slack_callback_inbox (
  callback_id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  callback_kind TEXT NOT NULL CHECK (callback_kind IN ('EVENT','INTERACTION')),
  callback_type TEXT NOT NULL,
  action_id TEXT,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (
    status IN ('PENDING','PROCESSING','RETRY','COMPLETED','FAILED')
  ),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  locked_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  last_error_code TEXT,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_slack_callback_inbox_work
  ON slack_callback_inbox(status, available_at, received_at)
  WHERE status IN ('PENDING','RETRY','PROCESSING');

CREATE INDEX IF NOT EXISTS idx_slack_callback_inbox_completed
  ON slack_callback_inbox(completed_at DESC)
  WHERE status = 'COMPLETED';

-- A Slack modal submission is allowed to create at most one evidence report
-- and one feedback record even if the worker is restarted after a partial run.
ALTER TABLE incident_verification_reports
  ADD COLUMN IF NOT EXISTS slack_callback_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_incident_reports_slack_callback
  ON incident_verification_reports(slack_callback_id)
  WHERE slack_callback_id IS NOT NULL;

ALTER TABLE human_verification_feedback
  ADD COLUMN IF NOT EXISTS slack_callback_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_human_feedback_slack_callback
  ON human_verification_feedback(slack_callback_id)
  WHERE slack_callback_id IS NOT NULL;

COMMENT ON TABLE slack_callback_inbox IS
  'Durable idempotent inbox for signed Slack Events API and Interactivity callbacks.';
