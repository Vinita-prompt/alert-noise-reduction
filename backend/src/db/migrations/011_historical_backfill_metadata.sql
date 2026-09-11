ALTER TABLE operations_incidents
  ADD COLUMN IF NOT EXISTS attachments JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS incident_details JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS sync_runs (
  id BIGSERIAL PRIMARY KEY,
  sync_name TEXT NOT NULL,
  source TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'historical_backfill',
  status TEXT NOT NULL DEFAULT 'running',
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  alerts_fetched INTEGER NOT NULL DEFAULT 0,
  alerts_inserted INTEGER NOT NULL DEFAULT 0,
  alerts_updated INTEGER NOT NULL DEFAULT 0,
  alerts_skipped INTEGER NOT NULL DEFAULT 0,
  incidents_fetched INTEGER NOT NULL DEFAULT 0,
  incidents_stored INTEGER NOT NULL DEFAULT 0,
  incident_links_created INTEGER NOT NULL DEFAULT 0,
  cursor_value TEXT,
  request_options JSONB NOT NULL DEFAULT '{}'::jsonb,
  error_message TEXT
);

CREATE TABLE IF NOT EXISTS sync_state (
  sync_name TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  cursor_value TEXT,
  last_successful_run_id BIGINT REFERENCES sync_runs(id) ON DELETE SET NULL,
  last_successful_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sync_runs_sync_name ON sync_runs(sync_name, started_at DESC);
