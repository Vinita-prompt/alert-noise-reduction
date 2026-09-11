-- Episode-first alert evaluation remains append-only, read-only, and shadow-only.

ALTER TABLE live_shadow_evaluations
  DROP CONSTRAINT IF EXISTS live_shadow_evaluations_notification_role_check;

ALTER TABLE live_shadow_evaluations
  ADD CONSTRAINT live_shadow_evaluations_notification_role_check
    CHECK (notification_role IN (
      'PRIMARY', 'REPEAT', 'DUPLICATE', 'CORRELATED', 'RECOVERY',
      'REDUNDANT', 'CORRELATED_SECONDARY', 'UNKNOWN', 'SUPPORTING'
    ));

CREATE INDEX IF NOT EXISTS idx_live_shadow_evaluations_episode_id
  ON live_shadow_evaluations ((feature_snapshot->'episode'->>'episodeId'), created_at DESC);

COMMENT ON COLUMN live_shadow_evaluations.notification_role IS
  'Episode-aware notification role. Episode decisions remain separate in the evaluation explanation.';
