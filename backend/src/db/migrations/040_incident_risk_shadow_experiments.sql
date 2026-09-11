CREATE TABLE IF NOT EXISTS ml_shadow_experiments (
  experiment_id TEXT PRIMARY KEY,
  model_version TEXT NOT NULL UNIQUE,
  experiment_state TEXT NOT NULL DEFAULT 'SHADOW_EXPERIMENT_ONLY'
    CHECK (experiment_state = 'SHADOW_EXPERIMENT_ONLY'),
  model_family TEXT NOT NULL,
  feature_schema_version TEXT NOT NULL,
  taxonomy_version TEXT NOT NULL,
  positive_definition TEXT NOT NULL,
  pu_strategy TEXT NOT NULL,
  artifact_path TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ml_shadow_predictions (
  id BIGSERIAL PRIMARY KEY,
  experiment_id TEXT NOT NULL REFERENCES ml_shadow_experiments(experiment_id),
  alert_id TEXT NOT NULL REFERENCES alerts(id),
  model_version TEXT NOT NULL,
  feature_as_of TIMESTAMPTZ NOT NULL,
  incident_risk_score DOUBLE PRECISION NOT NULL
    CHECK (incident_risk_score >= 0 AND incident_risk_score <= 1),
  score_band TEXT NOT NULL
    CHECK (score_band IN ('HIGH_INCIDENT_LIKENESS', 'INTERMEDIATE', 'LOW_INCIDENT_LIKENESS')),
  explanation JSONB NOT NULL DEFAULT '{}'::jsonb,
  dataset_split TEXT NOT NULL
    CHECK (dataset_split IN ('HELD_OUT_TEST', 'CURRENT_24H_SHADOW')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (experiment_id, alert_id, dataset_split)
);

CREATE INDEX IF NOT EXISTS ml_shadow_predictions_alert_idx
  ON ml_shadow_predictions(alert_id, created_at DESC);

CREATE INDEX IF NOT EXISTS ml_shadow_predictions_experiment_idx
  ON ml_shadow_predictions(experiment_id, dataset_split, incident_risk_score DESC);

COMMENT ON TABLE ml_shadow_experiments IS
  'Append-only metadata for offline Incident-risk experiments. Never loaded by an ingestion or decision path.';

COMMENT ON TABLE ml_shadow_predictions IS
  'Append-only shadow scores stored separately from historical outcomes, operational outcomes, and legacy classifications.';
