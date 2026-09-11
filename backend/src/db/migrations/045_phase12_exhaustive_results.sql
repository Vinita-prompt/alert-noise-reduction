-- Phase 12: exhaustive alert results and canonical operator vocabulary.
--
-- This migration only broadens analytical shadow-result dimensions. It does
-- not enable a production action or mutate any source system.

ALTER TABLE live_shadow_evaluations
  DROP CONSTRAINT IF EXISTS live_shadow_evaluations_business_impact_check,
  DROP CONSTRAINT IF EXISTS live_shadow_evaluations_underlying_event_check,
  DROP CONSTRAINT IF EXISTS live_shadow_evaluations_notification_role_check;

ALTER TABLE live_shadow_evaluations
  ADD CONSTRAINT live_shadow_evaluations_business_impact_check
    CHECK (business_impact IN (
      'CONFIRMED', 'PROBABLE', 'NONE_OBSERVED', 'UNKNOWN',
      'NOT_OBSERVED' -- preserved legacy shadow rows
    )),
  ADD CONSTRAINT live_shadow_evaluations_underlying_event_check
    CHECK (underlying_event IN (
      'CONFIRMED_INCIDENT', 'PROBABLE_INCIDENT', 'TECHNICAL_EVENT',
      'NO_INCIDENT_EVIDENCE', 'UNKNOWN',
      'KNOWN_OPERATIONAL_EVENT', 'NO_CONFIRMED_EVENT' -- preserved legacy shadow rows
    )),
  ADD CONSTRAINT live_shadow_evaluations_notification_role_check
    CHECK (notification_role IN (
      'PRIMARY', 'REPEAT', 'REDUNDANT', 'CORRELATED', 'CORRELATED_SECONDARY',
      'RECOVERY', 'UNKNOWN',
      'SUPPORTING', 'DUPLICATE' -- preserved legacy shadow rows
    ));

COMMENT ON COLUMN live_shadow_evaluations.business_impact IS
  'Phase 12 evidence result: CONFIRMED, PROBABLE, NONE_OBSERVED, or UNKNOWN.';
COMMENT ON COLUMN live_shadow_evaluations.underlying_event IS
  'Phase 12 underlying-event result. It is evidence interpretation, not an automatic action.';
COMMENT ON COLUMN live_shadow_evaluations.notification_role IS
  'Phase 12 notification role: PRIMARY, REDUNDANT, CORRELATED_SECONDARY, or UNKNOWN.';
