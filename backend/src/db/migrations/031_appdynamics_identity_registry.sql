CREATE TABLE IF NOT EXISTS source_identity_validated_mappings (
  entity_id TEXT NOT NULL REFERENCES source_identity_entities(entity_id) ON DELETE CASCADE,
  source_system TEXT NOT NULL,
  source_entity_id TEXT NOT NULL,
  source_entity_name TEXT,
  source_entity_type TEXT,
  environment TEXT,
  evidence_level TEXT NOT NULL CHECK (evidence_level IN ('EXACT', 'STRONG')),
  confidence_score INTEGER NOT NULL CHECK (confidence_score BETWEEN 0 AND 100),
  reasons JSONB NOT NULL DEFAULT '[]'::jsonb,
  mapping_mechanism TEXT NOT NULL,
  validation_status TEXT NOT NULL DEFAULT 'VALID' CHECK (validation_status IN ('VALID', 'STALE')),
  first_validated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_validated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (entity_id, source_system, source_entity_id)
);

CREATE INDEX IF NOT EXISTS idx_source_identity_validated_entity
  ON source_identity_validated_mappings(entity_id, source_system, validation_status);
