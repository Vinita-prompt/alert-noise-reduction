CREATE TABLE IF NOT EXISTS apex_workflows (LIKE apex_jobs INCLUDING ALL);

CREATE TABLE IF NOT EXISTS apex_workflow_history (LIKE apex_history INCLUDING ALL);

CREATE TABLE IF NOT EXISTS apex_correlation_links (
  id BIGSERIAL PRIMARY KEY,
  source_tool TEXT NOT NULL DEFAULT 'oracle-apex',
  application_name TEXT NOT NULL DEFAULT 'PF & ETL Dashboard',
  workflow_entity_id TEXT NOT NULL,
  workflow_name TEXT,
  related_source_tool TEXT NOT NULL,
  related_entity_id TEXT,
  related_entity_name TEXT,
  relationship_type TEXT NOT NULL DEFAULT 'context',
  correlation_keys JSONB NOT NULL DEFAULT '{}'::jsonb,
  correlation_confidence NUMERIC,
  dependency_impact_score NUMERIC,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (source_tool, application_name, workflow_entity_id, related_source_tool, related_entity_id)
);

CREATE INDEX IF NOT EXISTS idx_apex_correlation_links_workflow
  ON apex_correlation_links(workflow_entity_id, related_source_tool);

INSERT INTO apex_workflows
SELECT *
FROM apex_jobs
ON CONFLICT (source_tool, application_name, entity_id)
DO NOTHING;

INSERT INTO apex_workflow_history (
  source_tool,
  application_name,
  entity_id,
  entity_name,
  status,
  severity,
  snapshot_at,
  timestamp,
  execution_duration_seconds,
  row_values,
  raw_payload
)
SELECT
  source_tool,
  application_name,
  entity_id,
  entity_name,
  status,
  severity,
  snapshot_at,
  timestamp,
  execution_duration_seconds,
  row_values,
  raw_payload
FROM apex_history
WHERE NOT EXISTS (
  SELECT 1
  FROM apex_workflow_history existing
  WHERE existing.source_tool = apex_history.source_tool
    AND existing.application_name = apex_history.application_name
    AND existing.entity_id = apex_history.entity_id
    AND existing.snapshot_at = apex_history.snapshot_at
);
