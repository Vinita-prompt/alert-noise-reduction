-- Production occurrence-aware grouping remains local, append-only through
-- live_shadow_evaluations, and read-only with respect to source systems.
-- These indexes support bounded exact-occurrence candidate retrieval.

CREATE INDEX IF NOT EXISTS idx_appdynamics_occurrence_source_occurrence
  ON appdynamics_alert_occurrence_evidence(source_occurrence_id, firing_at DESC)
  WHERE source_occurrence_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_appdynamics_occurrence_event
  ON appdynamics_alert_occurrence_evidence(event_id, firing_at DESC)
  WHERE event_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_appdynamics_occurrence_violation
  ON appdynamics_alert_occurrence_evidence(violation_id, firing_at DESC)
  WHERE violation_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_nagios_occurrence_source_occurrence
  ON nagios_alert_occurrence_evidence(source_occurrence_id, firing_at DESC)
  WHERE source_occurrence_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_alerts_ops_received_at
  ON alerts(received_at DESC, id)
  WHERE atlassian_ops_alert_id IS NOT NULL;

COMMENT ON INDEX idx_alerts_ops_received_at IS
  'Bounds live episode candidate retrieval to the current Operations alert population.';
