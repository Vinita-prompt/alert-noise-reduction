CREATE TABLE IF NOT EXISTS appdynamics_event_reconstruction_snapshots (
  analysis_range TEXT NOT NULL,
  reconstruction_version TEXT NOT NULL,
  analysis_version TEXT NOT NULL,
  snapshot_json JSONB NOT NULL,
  computed_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (analysis_range, reconstruction_version, analysis_version)
);

CREATE INDEX IF NOT EXISTS idx_appdynamics_event_reconstruction_expiry
  ON appdynamics_event_reconstruction_snapshots (analysis_range, expires_at DESC);
