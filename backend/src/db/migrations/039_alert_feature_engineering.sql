-- Phase 3: technical taxonomy corrections and queryable feature taxonomy.
-- No Noise/Incident classifier, label, score, or model output is created here.

CREATE OR REPLACE FUNCTION learning_taxonomy_subtype(
  source_value TEXT,
  message_value TEXT,
  entity_value TEXT,
  application_value TEXT,
  service_value TEXT
)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
AS $$
DECLARE
  value TEXT := LOWER(CONCAT_WS(' ', source_value, message_value, entity_value, application_value, service_value));
BEGIN
  IF value ~ 'payment.{0,30}(success rate|success percentage)|success rate.{0,30}payment' THEN RETURN 'PAYMENT_SUCCESS_RATE';
  ELSIF value ~ 'payment.{0,30}(fail|declin|error)|(?:fail|error).{0,30}payment' THEN RETURN 'PAYMENT_FAILURE';
  ELSIF value ~ 'business transaction.{0,40}(critical|fail|error|health)|transaction health' THEN RETURN 'BUSINESS_TRANSACTION_FAILURE';
  ELSIF value ~ 'traffic.{0,25}(anomal|spike|drop|unusual)' THEN RETURN 'TRAFFIC_ANOMALY';
  ELSIF value ~ 'business flow.{0,30}(fail|error|critical)' THEN RETURN 'BUSINESS_FLOW_FAILURE';
  ELSIF value ~ '\metl\M.{0,40}(fail|error)|(?:fail|error).{0,40}\metl\M' THEN RETURN 'ETL_FAILURE';
  ELSIF value ~ 'data pipeline.{0,40}(fail|error)|file delivery fail|file router.{0,30}(fail|error)|dataflow.{0,30}(fail|error)' THEN RETURN 'DATA_PIPELINE_FAILURE';
  ELSIF value ~ 'scheduled job.{0,40}(fail|error)|job failed|failed job' THEN RETURN 'SCHEDULED_JOB_FAILURE';
  ELSIF value ~ 'daemon.{0,40}(fail|critical|down|error)|(?:fail|critical|down).{0,40}daemon' THEN RETURN 'DAEMON_FAILURE';
  ELSIF value ~ 'report.{0,40}(fail|error)|(?:fail|error).{0,40}report' THEN RETURN 'REPORT_FAILURE';
  ELSIF value ~ 'batch.{0,40}(fail|error)|(?:fail|error).{0,40}batch' THEN RETURN 'BATCH_FAILURE';
  ELSIF value ~ 'job.{0,40}(delay|late|lag)|(?:delay|late).{0,40}job' THEN RETURN 'JOB_DELAY';
  ELSIF value ~ 'packet loss' THEN RETURN 'PACKET_LOSS';
  ELSIF value ~ 'network latency|round.?trip|latency.{0,20}(high|threshold|violation)' THEN RETURN 'HIGH_LATENCY';
  ELSIF value ~ 'interface.{0,25}(down|unavailable)' THEN RETURN 'INTERFACE_DOWN';
  ELSIF value ~ '\mdns\M.{0,30}(fail|error|unavailable|timeout)|(?:fail|error).{0,30}\mdns\M' THEN RETURN 'DNS';
  ELSIF value ~ 'network rout|routing (table|protocol)|\mbgp\M' THEN RETURN 'ROUTING';
  ELSIF value ~ 'connectivity|unreachable|connection refused|connection timed out' THEN RETURN 'CONNECTIVITY';
  ELSIF value ~ 'network.{0,25}(down|unavailable)|availability.{0,20}network' THEN RETURN 'NETWORK_AVAILABILITY';
  ELSIF value ~ 'payment gateway.{0,40}(down|unavailable|timeout|fail)' THEN RETURN 'PAYMENT_GATEWAY_UNAVAILABLE';
  ELSIF value ~ 'database.{0,35}(down|unavailable|offline|connection fail)|unable to connect.{0,20}(db|database)' THEN RETURN 'DATABASE_UNAVAILABLE';
  ELSIF value ~ 'external api.{0,40}(fail|error|unavailable)|third.?party api.{0,40}(fail|error)' THEN RETURN 'EXTERNAL_API_FAILURE';
  ELSIF value ~ 'downstream.{0,35}(fail|error|unavailable|timeout)' THEN RETURN 'DOWNSTREAM_SERVICE';
  ELSIF value ~ 'upstream.{0,35}(fail|error|unavailable|timeout)' THEN RETURN 'UPSTREAM_SERVICE';
  ELSIF value ~ 'third.?party.{0,35}(fail|error|unavailable|timeout)' THEN RETURN 'THIRD_PARTY_SERVICE';
  ELSIF value ~ '\mcpu\M|processor utilization' THEN RETURN 'CPU';
  ELSIF value ~ '\mmemory\M|heap usage|out of memory|\moom\M' THEN RETURN 'MEMORY';
  ELSIF value ~ '\mdisk\M|filesystem|file system|tempdb used' THEN RETURN 'DISK';
  ELSIF value ~ '\mstorage\M|volume capacity' THEN RETURN 'STORAGE';
  ELSIF value ~ 'virtual machine|\mvm\M.{0,20}(down|unavailable|health)' THEN RETURN 'VM';
  ELSIF value ~ '\mhost\M.{0,25}(down|unreachable)| is down\M' THEN RETURN 'HOST';
  ELSIF value ~ 'process.{0,25}(down|not running|critical|fail)' THEN RETURN 'PROCESS';
  ELSIF value ~ 'service.{0,25}(down|unavailable|not running)|availability.{0,25}service' THEN RETURN 'SERVICE_AVAILABILITY';
  ELSIF value ~ 'resource utilization|utili[sz]ation.{0,25}(high|critical)' THEN RETURN 'RESOURCE_UTILIZATION';
  ELSIF value ~ 'response time|slow response|latency.{0,25}(application|node|transaction)' THEN RETURN 'RESPONSE_TIME';
  ELSIF value ~ 'error rate|errors per minute|high error' THEN RETURN 'ERROR_RATE';
  ELSIF value ~ 'exception|stack trace' THEN RETURN 'EXCEPTION';
  ELSIF value ~ 'database connection|db connection|connection pool' THEN RETURN 'DATABASE_CONNECTION';
  ELSIF value ~ '\mapi\M.{0,35}(fail|error|timeout|unavailable)|(?:fail|error).{0,35}\mapi\M' THEN RETURN 'API_FAILURE';
  ELSIF value ~ 'transaction.{0,35}(fail|error)' THEN RETURN 'TRANSACTION_FAILURE';
  ELSIF value ~ 'application.{0,25}(down|unavailable|health)|app availability' THEN RETURN 'APPLICATION_AVAILABILITY';
  ELSIF value ~ '\mserver\M.{0,25}(down|unavailable|health|critical)' THEN RETURN 'SERVER';
  END IF;
  RETURN 'UNKNOWN_SUBTYPE';
END;
$$;

CREATE OR REPLACE FUNCTION learning_taxonomy_domain(subtype_value TEXT)
RETURNS TEXT
LANGUAGE SQL
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN subtype_value IN ('CPU','MEMORY','DISK','STORAGE','VM','SERVER','HOST','PROCESS','SERVICE_AVAILABILITY','RESOURCE_UTILIZATION') THEN 'INFRASTRUCTURE'
    WHEN subtype_value IN ('API_FAILURE','EXCEPTION','ERROR_RATE','RESPONSE_TIME','APPLICATION_AVAILABILITY','DATABASE_CONNECTION','TRANSACTION_FAILURE') THEN 'APPLICATION'
    WHEN subtype_value IN ('PACKET_LOSS','HIGH_LATENCY','INTERFACE_DOWN','DNS','CONNECTIVITY','ROUTING','NETWORK_AVAILABILITY') THEN 'NETWORK'
    WHEN subtype_value IN ('DATABASE_UNAVAILABLE','EXTERNAL_API_FAILURE','PAYMENT_GATEWAY_UNAVAILABLE','DOWNSTREAM_SERVICE','UPSTREAM_SERVICE','THIRD_PARTY_SERVICE') THEN 'DEPENDENCY'
    WHEN subtype_value IN ('SCHEDULED_JOB_FAILURE','DAEMON_FAILURE','ETL_FAILURE','REPORT_FAILURE','BATCH_FAILURE','JOB_DELAY','DATA_PIPELINE_FAILURE') THEN 'JOB_BATCH_DATA'
    WHEN subtype_value IN ('PAYMENT_FAILURE','PAYMENT_SUCCESS_RATE','BUSINESS_TRANSACTION_FAILURE','TRANSACTION_DEGRADATION','TRAFFIC_ANOMALY','BUSINESS_FLOW_FAILURE') THEN 'BUSINESS_TRANSACTION'
    ELSE 'UNKNOWN_DOMAIN'
  END;
$$;

CREATE TABLE IF NOT EXISTS alert_occurrence_taxonomy_corrections (
  id BIGSERIAL PRIMARY KEY,
  alert_id TEXT NOT NULL REFERENCES alerts(id) ON DELETE RESTRICT,
  suggested_domain TEXT NOT NULL,
  suggested_subtype TEXT NOT NULL,
  corrected_domain TEXT NOT NULL CHECK (corrected_domain IN (
    'INFRASTRUCTURE','APPLICATION','NETWORK','DEPENDENCY','JOB_BATCH_DATA','BUSINESS_TRANSACTION','UNKNOWN_DOMAIN'
  )),
  corrected_subtype TEXT NOT NULL,
  reason TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_display TEXT NOT NULL,
  actor_email TEXT,
  actor_roles JSONB NOT NULL DEFAULT '[]'::jsonb,
  actor_permissions JSONB NOT NULL DEFAULT '[]'::jsonb,
  authorization_basis TEXT NOT NULL,
  is_current BOOLEAN NOT NULL DEFAULT true,
  supersedes_id BIGINT REFERENCES alert_occurrence_taxonomy_corrections(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL,
  request_context JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_alert_taxonomy_correction_current
  ON alert_occurrence_taxonomy_corrections(alert_id) WHERE is_current;

CREATE UNIQUE INDEX IF NOT EXISTS idx_alert_taxonomy_correction_idempotency
  ON alert_occurrence_taxonomy_corrections(alert_id, idempotency_key);

CREATE INDEX IF NOT EXISTS idx_alert_taxonomy_correction_history
  ON alert_occurrence_taxonomy_corrections(alert_id, created_at DESC, id DESC);

COMMENT ON TABLE alert_occurrence_taxonomy_corrections IS
  'Append-only authenticated technical-taxonomy corrections. These records never change an operational outcome.';

COMMENT ON FUNCTION learning_taxonomy_subtype(TEXT, TEXT, TEXT, TEXT, TEXT) IS
  'Deterministic technical taxonomy suggestion only. It does not produce Noise or Incident outcomes.';
