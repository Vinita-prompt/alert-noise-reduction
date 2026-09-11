CREATE TABLE IF NOT EXISTS noise_evidence_packages (
  alert_id TEXT NOT NULL,
  pattern_id TEXT NOT NULL,
  analysis_range TEXT NOT NULL,
  analysis_version TEXT,
  evidence_version TEXT NOT NULL,
  classification_version TEXT NOT NULL,
  package_json JSONB NOT NULL,
  collected_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (alert_id, analysis_range, evidence_version)
);

CREATE INDEX IF NOT EXISTS idx_noise_evidence_packages_range_expiry
  ON noise_evidence_packages (analysis_range, expires_at DESC);

CREATE TABLE IF NOT EXISTS noise_evidence_acquisition_runs (
  run_id TEXT PRIMARY KEY,
  analysis_range TEXT NOT NULL,
  acquisition_version TEXT NOT NULL,
  summary_json JSONB NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_noise_evidence_acquisition_runs_range
  ON noise_evidence_acquisition_runs (analysis_range, completed_at DESC);
