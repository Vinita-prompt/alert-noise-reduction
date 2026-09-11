CREATE TABLE IF NOT EXISTS source_identity_entities (
  entity_id TEXT PRIMARY KEY,
  canonical_name TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  environment TEXT,
  aliases JSONB NOT NULL DEFAULT '[]'::jsonb,
  first_seen TIMESTAMPTZ,
  last_seen TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS source_identity_decisions (
  id BIGSERIAL PRIMARY KEY,
  entity_id TEXT NOT NULL REFERENCES source_identity_entities(entity_id) ON DELETE CASCADE,
  source_system TEXT NOT NULL,
  source_entity_id TEXT NOT NULL,
  source_entity_name TEXT,
  source_entity_type TEXT,
  decision TEXT NOT NULL CHECK (decision IN ('CONFIRMED_LOCAL', 'REJECTED_LOCAL')),
  evidence_level TEXT NOT NULL CHECK (evidence_level IN ('STRONG', 'CANDIDATE')),
  confidence_score INTEGER NOT NULL CHECK (confidence_score BETWEEN 0 AND 100),
  reasons JSONB NOT NULL DEFAULT '[]'::jsonb,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  confirmed_by TEXT,
  decided_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(entity_id, source_system, source_entity_id)
);

CREATE INDEX IF NOT EXISTS idx_source_identity_decisions_entity
  ON source_identity_decisions(entity_id, source_system);
