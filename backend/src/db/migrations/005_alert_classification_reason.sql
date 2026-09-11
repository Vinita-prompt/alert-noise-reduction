ALTER TABLE alerts
  ADD COLUMN IF NOT EXISTS classification_reason TEXT;
