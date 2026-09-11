CREATE TABLE IF NOT EXISTS monitoring_dashboards (
  id BIGSERIAL PRIMARY KEY,
  source_tool TEXT NOT NULL,
  application_name TEXT NOT NULL,
  dashboard_name TEXT NOT NULL,
  dashboard_subname TEXT,
  dashboard_uid TEXT NOT NULL,
  panel_count INTEGER NOT NULL DEFAULT 0,
  panel_titles JSONB NOT NULL DEFAULT '[]'::jsonb,
  last_updated_at TIMESTAMPTZ,
  last_refreshed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deep_link TEXT,
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (source_tool, dashboard_uid)
);

CREATE INDEX IF NOT EXISTS idx_monitoring_dashboards_source
  ON monitoring_dashboards(source_tool, dashboard_subname, dashboard_name);
CREATE INDEX IF NOT EXISTS idx_monitoring_dashboards_updated
  ON monitoring_dashboards(source_tool, last_updated_at DESC);
