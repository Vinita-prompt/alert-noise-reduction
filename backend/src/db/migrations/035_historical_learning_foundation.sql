-- Phase 1: deterministic, decision-free features for one stored alert occurrence per record.
-- This migration does not create labels, classification rules, or model output.

CREATE OR REPLACE FUNCTION learning_normalize_message(value TEXT)
RETURNS TEXT
LANGUAGE SQL
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT NULLIF(
    BTRIM(
      REGEXP_REPLACE(
        REGEXP_REPLACE(
          REGEXP_REPLACE(
            REGEXP_REPLACE(
              REGEXP_REPLACE(LOWER(COALESCE(value, '')), '<[^>]+>', ' ', 'gi'),
              '\balert\s*#\s*\d+\b', 'alert #<id>', 'gi'
            ),
            '\b[0-9a-f]{8}-[0-9a-f-]{27,}\b', '<uuid>', 'gi'
          ),
          '\b\d{4}-\d{2}-\d{2}[t ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?z?\b', '<timestamp>', 'gi'
        ),
        '\s+', ' ', 'g'
      )
    ),
    ''
  );
$$;

CREATE OR REPLACE FUNCTION learning_normalize_identity(value TEXT)
RETURNS TEXT
LANGUAGE SQL
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT NULLIF(
    REGEXP_REPLACE(
      REGEXP_REPLACE(LOWER(BTRIM(COALESCE(value, ''))), '^(prod|production)[\s:_-]+', '', 'i'),
      '[^a-z0-9]+', '', 'g'
    ),
    ''
  );
$$;

ALTER TABLE alerts
  ADD COLUMN IF NOT EXISTS learning_normalized_message_v1 TEXT,
  ADD COLUMN IF NOT EXISTS learning_alert_signature_v1 TEXT,
  ADD COLUMN IF NOT EXISTS learning_entity_key_v1 TEXT;

CREATE OR REPLACE FUNCTION set_alert_learning_foundation_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  identity_value TEXT;
  message_value TEXT;
BEGIN
  message_value := learning_normalize_message(
    COALESCE(
      NEW.extracted_details->'normalized_alert'->>'message',
      NEW.description,
      NEW.signal,
      NEW.title
    )
  );
  identity_value := COALESCE(
    NEW.extracted_details->'normalized_alert'->>'entity',
    NEW.extracted_details->'normalized_alert'->>'service',
    NEW.service,
    ''
  );

  NEW.learning_normalized_message_v1 := message_value;
  NEW.learning_entity_key_v1 := CASE
    WHEN learning_normalize_identity(identity_value) IS NULL
      OR learning_normalize_identity(identity_value) IN ('unknown', 'unknownservice')
    THEN NULL
    ELSE MD5(CONCAT_WS('|',
      learning_normalize_identity(identity_value),
      LOWER(COALESCE(NEW.environment, ''))
    ))
  END;
  NEW.learning_alert_signature_v1 := MD5(CONCAT_WS('|',
    LOWER(COALESCE(NEW.extracted_details->'normalized_alert'->>'monitoring_tool', NEW.source, '')),
    learning_normalize_identity(identity_value),
    LOWER(COALESCE(NEW.environment, '')),
    COALESCE(message_value, '')
  ));
  RETURN NEW;
END;
$$;

UPDATE alerts
SET
  learning_normalized_message_v1 = learning_normalize_message(
    COALESCE(
      extracted_details->'normalized_alert'->>'message',
      description,
      signal,
      title
    )
  ),
  learning_alert_signature_v1 = MD5(CONCAT_WS('|',
    LOWER(COALESCE(extracted_details->'normalized_alert'->>'monitoring_tool', source, '')),
    learning_normalize_identity(COALESCE(
      extracted_details->'normalized_alert'->>'entity',
      extracted_details->'normalized_alert'->>'service',
      service,
      ''
    )),
    LOWER(COALESCE(environment, '')),
    COALESCE(learning_normalize_message(COALESCE(
      extracted_details->'normalized_alert'->>'message',
      description,
      signal,
      title
    )), '')
  )),
  learning_entity_key_v1 = CASE
    WHEN learning_normalize_identity(COALESCE(
      extracted_details->'normalized_alert'->>'entity',
      extracted_details->'normalized_alert'->>'service',
      service,
      ''
    )) IS NULL
      OR learning_normalize_identity(COALESCE(
        extracted_details->'normalized_alert'->>'entity',
        extracted_details->'normalized_alert'->>'service',
        service,
        ''
      )) IN ('unknown', 'unknownservice')
    THEN NULL
    ELSE MD5(CONCAT_WS('|',
      learning_normalize_identity(COALESCE(
        extracted_details->'normalized_alert'->>'entity',
        extracted_details->'normalized_alert'->>'service',
        service,
        ''
      )),
      LOWER(COALESCE(environment, ''))
    ))
  END
;

DROP TRIGGER IF EXISTS alerts_learning_foundation_v1 ON alerts;
CREATE TRIGGER alerts_learning_foundation_v1
BEFORE INSERT OR UPDATE OF title, service, environment, source, signal, description, extracted_details
ON alerts
FOR EACH ROW
EXECUTE FUNCTION set_alert_learning_foundation_v1();

CREATE INDEX IF NOT EXISTS idx_alerts_learning_signature_time_v1
  ON alerts (learning_alert_signature_v1, received_at DESC, id);

CREATE INDEX IF NOT EXISTS idx_alerts_learning_entity_time_v1
  ON alerts (learning_entity_key_v1, received_at DESC, id);

CREATE INDEX IF NOT EXISTS idx_alerts_learning_source_time_v1
  ON alerts (source, received_at DESC);

CREATE INDEX IF NOT EXISTS idx_alerts_learning_received_time_v1
  ON alerts (received_at DESC, id);

CREATE INDEX IF NOT EXISTS idx_alerts_learning_priority_time_v1
  ON alerts ((COALESCE(extracted_details->'normalized_alert'->>'priority', extracted_details->'jira'->>'priority')), received_at DESC);

CREATE INDEX IF NOT EXISTS idx_alert_incident_mappings_issue
  ON alert_incident_mappings (jira_ticket_id, alert_id);

CREATE INDEX IF NOT EXISTS idx_slack_alert_events_message_join
  ON slack_alert_events (slack_channel_id, source_message_ts);

CREATE INDEX IF NOT EXISTS idx_slack_alert_events_alert_id
  ON slack_alert_events (alert_id)
  WHERE alert_id IS NOT NULL;

DROP VIEW IF EXISTS historical_alert_learning_occurrences_v1;
CREATE VIEW historical_alert_learning_occurrences_v1 AS
SELECT
  a.id AS alert_id,
  COALESCE(a.atlassian_ops_alert_id, a.id) AS canonical_alert_id,
  a.source_alert_id,
  a.source AS ingestion_source,
  COALESCE(NULLIF(a.extracted_details->'normalized_alert'->>'monitoring_tool', ''), a.source) AS source,
  a.learning_alert_signature_v1 AS alert_signature,
  a.learning_entity_key_v1 AS entity_key,
  COALESCE(a.extracted_details->'normalized_alert'->>'message', a.description, a.signal, a.title) AS message,
  a.learning_normalized_message_v1 AS normalized_message,
  a.severity,
  COALESCE(a.extracted_details->'normalized_alert'->>'priority', a.extracted_details->'jira'->>'priority') AS priority,
  a.status,
  COALESCE(a.extracted_details->'normalized_alert'->>'entity', a.service) AS entity,
  COALESCE(a.extracted_details->'normalized_alert'->>'application', a.extracted_details->'jira'->>'service') AS application,
  COALESCE(a.extracted_details->'normalized_alert'->>'service', a.service) AS service,
  a.environment,
  a.received_at AS created_at,
  a.received_at AS first_seen,
  a.last_seen_at AS last_seen,
  a.occurrences AS occurrence_count,
  a.duplicate_signature AS source_signature,
  a.correlation_id,
  a.slack_channel_id,
  a.slack_message_ts,
  a.acknowledged,
  a.acknowledged_by,
  a.acknowledged_at,
  a.owner,
  a.source_url,
  a.classification AS legacy_classification,
  a.classification_is_legacy,
  a.extracted_details,
  a.raw_payload
FROM alerts a;

COMMENT ON VIEW historical_alert_learning_occurrences_v1 IS
  'One stored alert occurrence per learning record. Contains features only; no ML or Noise/Incident decision.';

COMMENT ON COLUMN alerts.learning_alert_signature_v1 IS
  'Deterministic contextual signature for historical features. It is not a classification or outcome.';

COMMENT ON COLUMN alerts.learning_entity_key_v1 IS
  'Deterministic entity/environment key for historical counts. It is not a classification or readiness gate.';

COMMENT ON COLUMN alerts.learning_normalized_message_v1 IS
  'Deterministically normalized alert message for feature extraction; never a label.';
