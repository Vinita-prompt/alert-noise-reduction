CREATE TABLE IF NOT EXISTS auth_access_requests (
  request_id UUID PRIMARY KEY,
  full_name TEXT NOT NULL,
  work_email TEXT NOT NULL,
  team_department TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_at TIMESTAMPTZ,
  reviewed_by TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_auth_access_requests_pending_email
  ON auth_access_requests (LOWER(work_email)) WHERE status = 'PENDING';
CREATE INDEX IF NOT EXISTS idx_auth_access_requests_status_requested
  ON auth_access_requests (status, requested_at DESC);
