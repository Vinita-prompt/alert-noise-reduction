BEGIN;

ALTER TABLE alerts
  ADD COLUMN IF NOT EXISTS classification_is_legacy BOOLEAN NOT NULL DEFAULT false;

-- Preserve every historical value in place. The flag changes interpretation,
-- not the stored label, confidence, reason, or source/context data.
UPDATE alerts
SET classification_is_legacy = true
WHERE classification <> 'unclassified'
   OR confidence_score IS NOT NULL
   OR classification_reason IS NOT NULL
   OR noise_reason IS NOT NULL;

ALTER TABLE alert_classification_history
  ADD COLUMN IF NOT EXISTS is_legacy BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE operational_decision_audit
  ADD COLUMN IF NOT EXISTS is_legacy BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE noise_rules
  ADD COLUMN IF NOT EXISTS retired_at TIMESTAMPTZ;

ALTER TABLE noise_rules
  ADD COLUMN IF NOT EXISTS retirement_reason TEXT;

UPDATE noise_rules
SET status = 'paused',
    retired_at = COALESCE(retired_at, NOW()),
    retirement_reason = COALESCE(
      retirement_reason,
      'Phase 0: legacy rule-based decision layer retired before historical learning dataset work.'
    ),
    updated_at = NOW();

ALTER TABLE raw_alerts
  DROP CONSTRAINT IF EXISTS raw_alerts_processing_status_check;

ALTER TABLE raw_alerts
  ADD CONSTRAINT raw_alerts_processing_status_check
  CHECK (processing_status IN ('stored', 'normalized', 'normalization_failed', 'classification_failed'));

COMMENT ON COLUMN alerts.classification_is_legacy IS
  'True when classification/noise/confidence fields came from the retired pre-learning decision layer. Never use as model ground truth.';

COMMENT ON TABLE alert_classification_history IS
  'Historical output of the retired rule-based classifier. Audit/rollback only; not authoritative training labels.';

COMMENT ON TABLE operational_decision_audit IS
  'Historical output of the retired deterministic decision layer. Audit/rollback only; not authoritative training labels.';

COMMIT;
