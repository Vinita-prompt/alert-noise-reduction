-- First supervised learning model infrastructure.
--
-- Everything in this migration is local, append-only, and shadow-only. A model
-- recommendation is never an operational decision or a human-validated label.

CREATE TABLE IF NOT EXISTS ml_feature_snapshots (
  feature_snapshot_id TEXT PRIMARY KEY,
  alert_id TEXT NOT NULL REFERENCES alerts(id) ON DELETE RESTRICT,
  episode_id TEXT,
  evidence_revision TEXT,
  feature_schema_version TEXT NOT NULL,
  feature_as_of TIMESTAMPTZ NOT NULL,
  features JSONB NOT NULL,
  leakage_audit JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ml_feature_snapshots_alert_time
  ON ml_feature_snapshots(alert_id, feature_as_of DESC, created_at DESC);

CREATE TABLE IF NOT EXISTS ml_training_examples (
  training_example_id TEXT PRIMARY KEY,
  alert_id TEXT NOT NULL REFERENCES alerts(id) ON DELETE RESTRICT,
  episode_id TEXT,
  feature_snapshot_id TEXT NOT NULL REFERENCES ml_feature_snapshots(feature_snapshot_id) ON DELETE RESTRICT,
  gold_decision TEXT NOT NULL CHECK (gold_decision IN ('INCIDENT', 'NOISE', 'NEEDS_REVIEW')),
  gold_noise_subtype TEXT,
  feedback_id BIGINT NOT NULL REFERENCES alert_occurrence_outcomes(id) ON DELETE RESTRICT,
  label_source TEXT NOT NULL DEFAULT 'VALIDATED_HUMAN_DECISION'
    CHECK (label_source = 'VALIDATED_HUMAN_DECISION'),
  evidence_revision TEXT,
  dataset_version TEXT NOT NULL,
  temporal_split TEXT CHECK (temporal_split IN ('TRAIN', 'VALIDATION', 'TEST')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (feedback_id, feature_snapshot_id)
);

CREATE INDEX IF NOT EXISTS idx_ml_training_examples_gold_time
  ON ml_training_examples(gold_decision, created_at, training_example_id);

CREATE TABLE IF NOT EXISTS ml_training_dataset_versions (
  dataset_version TEXT PRIMARY KEY,
  feature_schema_version TEXT NOT NULL,
  example_count INTEGER NOT NULL CHECK (example_count >= 0),
  class_distribution JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_query_hash TEXT NOT NULL,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ml_training_dataset_memberships (
  dataset_version TEXT NOT NULL REFERENCES ml_training_dataset_versions(dataset_version) ON DELETE RESTRICT,
  training_example_id TEXT NOT NULL REFERENCES ml_training_examples(training_example_id) ON DELETE RESTRICT,
  temporal_split TEXT NOT NULL CHECK (temporal_split IN ('TRAIN', 'VALIDATION', 'TEST')),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  PRIMARY KEY (dataset_version, training_example_id),
  UNIQUE (dataset_version, ordinal)
);

CREATE TABLE IF NOT EXISTS ml_model_registry (
  model_id TEXT PRIMARY KEY,
  model_version TEXT NOT NULL UNIQUE,
  algorithm TEXT NOT NULL CHECK (algorithm = 'XGBoost'),
  feature_schema_version TEXT NOT NULL,
  training_dataset_version TEXT NOT NULL,
  training_timestamp TIMESTAMPTZ NOT NULL,
  hyperparameters JSONB NOT NULL DEFAULT '{}'::jsonb,
  class_distribution JSONB NOT NULL DEFAULT '{}'::jsonb,
  validation_metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
  confusion_matrix JSONB NOT NULL DEFAULT '[]'::jsonb,
  calibration_status TEXT NOT NULL DEFAULT 'NOT_CALIBRATED',
  artifact_path TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('CANDIDATE', 'SHADOW', 'ACTIVE', 'RETIRED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ml_model_registry_status_time
  ON ml_model_registry(status, training_timestamp DESC);

CREATE TABLE IF NOT EXISTS ml_multiclass_shadow_predictions (
  prediction_id TEXT PRIMARY KEY,
  alert_id TEXT NOT NULL REFERENCES alerts(id) ON DELETE RESTRICT,
  episode_id TEXT,
  model_id TEXT NOT NULL REFERENCES ml_model_registry(model_id) ON DELETE RESTRICT,
  model_version TEXT NOT NULL,
  feature_snapshot_id TEXT NOT NULL REFERENCES ml_feature_snapshots(feature_snapshot_id) ON DELETE RESTRICT,
  deterministic_decision TEXT NOT NULL CHECK (deterministic_decision IN ('INCIDENT', 'NOISE', 'NEEDS_REVIEW')),
  predicted_class TEXT NOT NULL CHECK (predicted_class IN ('INCIDENT', 'NOISE', 'NEEDS_REVIEW')),
  p_incident DOUBLE PRECISION NOT NULL CHECK (p_incident BETWEEN 0 AND 1),
  p_noise DOUBLE PRECISION NOT NULL CHECK (p_noise BETWEEN 0 AND 1),
  p_review DOUBLE PRECISION NOT NULL CHECK (p_review BETWEEN 0 AND 1),
  model_score DOUBLE PRECISION NOT NULL CHECK (model_score BETWEEN 0 AND 1),
  score_label TEXT NOT NULL CHECK (score_label IN ('MODEL_SCORE', 'CALIBRATED_PROBABILITY')),
  top_contributors JSONB NOT NULL DEFAULT '[]'::jsonb,
  safety_gate JSONB NOT NULL DEFAULT '{}'::jsonb,
  predicted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (alert_id, model_id, feature_snapshot_id)
);

CREATE INDEX IF NOT EXISTS idx_ml_multiclass_shadow_predictions_alert_time
  ON ml_multiclass_shadow_predictions(alert_id, predicted_at DESC, prediction_id DESC);
CREATE INDEX IF NOT EXISTS idx_ml_multiclass_shadow_predictions_model_time
  ON ml_multiclass_shadow_predictions(model_id, predicted_at DESC);

COMMENT ON TABLE ml_feature_snapshots IS
  'Immutable prediction-time evidence. Future/human outcome fields are prohibited by the feature extractor.';
COMMENT ON TABLE ml_training_examples IS
  'Append-only examples sourced exclusively from validated human decisions.';
COMMENT ON TABLE ml_model_registry IS
  'Versioned supervised model metadata. The initial XGBoost model may be registered only as SHADOW.';
COMMENT ON TABLE ml_multiclass_shadow_predictions IS
  'Recommendation-only predictions. Deterministic decisions remain authoritative.';
