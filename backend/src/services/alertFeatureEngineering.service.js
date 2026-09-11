const ALERT_DOMAINS = Object.freeze([
  'INFRASTRUCTURE',
  'APPLICATION',
  'NETWORK',
  'DEPENDENCY',
  'JOB_BATCH_DATA',
  'BUSINESS_TRANSACTION',
  'UNKNOWN_DOMAIN',
]);

const SUBTYPE_DOMAINS = Object.freeze({
  CPU: 'INFRASTRUCTURE',
  MEMORY: 'INFRASTRUCTURE',
  DISK: 'INFRASTRUCTURE',
  STORAGE: 'INFRASTRUCTURE',
  VM: 'INFRASTRUCTURE',
  SERVER: 'INFRASTRUCTURE',
  HOST: 'INFRASTRUCTURE',
  PROCESS: 'INFRASTRUCTURE',
  SERVICE_AVAILABILITY: 'INFRASTRUCTURE',
  RESOURCE_UTILIZATION: 'INFRASTRUCTURE',
  API_FAILURE: 'APPLICATION',
  EXCEPTION: 'APPLICATION',
  ERROR_RATE: 'APPLICATION',
  RESPONSE_TIME: 'APPLICATION',
  APPLICATION_AVAILABILITY: 'APPLICATION',
  DATABASE_CONNECTION: 'APPLICATION',
  TRANSACTION_FAILURE: 'APPLICATION',
  PACKET_LOSS: 'NETWORK',
  HIGH_LATENCY: 'NETWORK',
  INTERFACE_DOWN: 'NETWORK',
  DNS: 'NETWORK',
  CONNECTIVITY: 'NETWORK',
  ROUTING: 'NETWORK',
  NETWORK_AVAILABILITY: 'NETWORK',
  DATABASE_UNAVAILABLE: 'DEPENDENCY',
  EXTERNAL_API_FAILURE: 'DEPENDENCY',
  PAYMENT_GATEWAY_UNAVAILABLE: 'DEPENDENCY',
  DOWNSTREAM_SERVICE: 'DEPENDENCY',
  UPSTREAM_SERVICE: 'DEPENDENCY',
  THIRD_PARTY_SERVICE: 'DEPENDENCY',
  SCHEDULED_JOB_FAILURE: 'JOB_BATCH_DATA',
  DAEMON_FAILURE: 'JOB_BATCH_DATA',
  ETL_FAILURE: 'JOB_BATCH_DATA',
  REPORT_FAILURE: 'JOB_BATCH_DATA',
  BATCH_FAILURE: 'JOB_BATCH_DATA',
  JOB_DELAY: 'JOB_BATCH_DATA',
  DATA_PIPELINE_FAILURE: 'JOB_BATCH_DATA',
  PAYMENT_FAILURE: 'BUSINESS_TRANSACTION',
  PAYMENT_SUCCESS_RATE: 'BUSINESS_TRANSACTION',
  BUSINESS_TRANSACTION_FAILURE: 'BUSINESS_TRANSACTION',
  TRANSACTION_DEGRADATION: 'BUSINESS_TRANSACTION',
  TRAFFIC_ANOMALY: 'BUSINESS_TRANSACTION',
  BUSINESS_FLOW_FAILURE: 'BUSINESS_TRANSACTION',
  UNKNOWN_SUBTYPE: 'UNKNOWN_DOMAIN',
});

const ALERT_SUBTYPES = Object.freeze(Object.keys(SUBTYPE_DOMAINS));
const BEHAVIOR_TYPES = Object.freeze([
  'DUPLICATE',
  'FLAPPING',
  'AUTO_RESOLVED',
  'NON_ACTIONABLE',
  'CORRELATED',
  'STALE',
  'EXPECTED_ACTIVITY',
]);
const TRI_STATE = Object.freeze({ OBSERVED: 'OBSERVED', NOT_OBSERVED: 'NOT_OBSERVED', UNAVAILABLE: 'UNAVAILABLE' });

const TAXONOMY_RULES = Object.freeze([
  ['PAYMENT_SUCCESS_RATE', /payment.{0,30}(success rate|success percentage)|success rate.{0,30}payment/i],
  ['PAYMENT_FAILURE', /payment.{0,30}(fail|declin|error)|(?:fail|error).{0,30}payment/i],
  ['BUSINESS_TRANSACTION_FAILURE', /business transaction.{0,40}(critical|fail|error|health)|transaction health/i],
  ['TRAFFIC_ANOMALY', /traffic.{0,25}(anomal|spike|drop|unusual)/i],
  ['BUSINESS_FLOW_FAILURE', /business flow.{0,30}(fail|error|critical)/i],
  ['ETL_FAILURE', /\betl\b.{0,40}(fail|error)|(?:fail|error).{0,40}\betl\b/i],
  ['DATA_PIPELINE_FAILURE', /data pipeline.{0,40}(fail|error)|file delivery fail|file router.{0,30}(fail|error)|dataflow.{0,30}(fail|error)/i],
  ['SCHEDULED_JOB_FAILURE', /scheduled job.{0,40}(fail|error)|job failed|failed job/i],
  ['DAEMON_FAILURE', /daemon.{0,40}(fail|critical|down|error)|(?:fail|critical|down).{0,40}daemon/i],
  ['REPORT_FAILURE', /report.{0,40}(fail|error)|(?:fail|error).{0,40}report/i],
  ['BATCH_FAILURE', /batch.{0,40}(fail|error)|(?:fail|error).{0,40}batch/i],
  ['JOB_DELAY', /job.{0,40}(delay|late|lag)|(?:delay|late).{0,40}job/i],
  ['PACKET_LOSS', /packet loss/i],
  ['HIGH_LATENCY', /network latency|round.?trip|latency.{0,20}(high|threshold|violation)/i],
  ['INTERFACE_DOWN', /interface.{0,25}(down|unavailable)/i],
  ['DNS', /\bdns\b.{0,30}(fail|error|unavailable|timeout)|(?:fail|error).{0,30}\bdns\b/i],
  ['ROUTING', /network rout|routing (table|protocol)|\bbgp\b/i],
  ['CONNECTIVITY', /connectivity|unreachable|connection refused|connection timed out/i],
  ['NETWORK_AVAILABILITY', /network.{0,25}(down|unavailable)|availability.{0,20}network/i],
  ['PAYMENT_GATEWAY_UNAVAILABLE', /payment gateway.{0,40}(down|unavailable|timeout|fail)/i],
  ['DATABASE_UNAVAILABLE', /database.{0,35}(down|unavailable|offline|connection fail)|unable to connect.{0,20}(db|database)/i],
  ['EXTERNAL_API_FAILURE', /external api.{0,40}(fail|error|unavailable)|third.?party api.{0,40}(fail|error)/i],
  ['DOWNSTREAM_SERVICE', /downstream.{0,35}(fail|error|unavailable|timeout)/i],
  ['UPSTREAM_SERVICE', /upstream.{0,35}(fail|error|unavailable|timeout)/i],
  ['THIRD_PARTY_SERVICE', /third.?party.{0,35}(fail|error|unavailable|timeout)/i],
  ['CPU', /\bcpu\b|processor utilization/i],
  ['MEMORY', /\bmemory\b|heap usage|out of memory|\boom\b/i],
  ['DISK', /\bdisk\b|filesystem|file system|tempdb used/i],
  ['STORAGE', /\bstorage\b|volume capacity/i],
  ['VM', /virtual machine|\bvm\b.{0,20}(down|unavailable|health)/i],
  ['HOST', /\bhost\b.{0,25}(down|unreachable)|\sis down\b/i],
  ['PROCESS', /process.{0,25}(down|not running|critical|fail)/i],
  ['SERVICE_AVAILABILITY', /service.{0,25}(down|unavailable|not running)|availability.{0,25}service/i],
  ['RESOURCE_UTILIZATION', /resource utilization|utili[sz]ation.{0,25}(high|critical)/i],
  ['RESPONSE_TIME', /response time|slow response|latency.{0,25}(application|node|transaction)/i],
  ['ERROR_RATE', /error rate|errors per minute|high error/i],
  ['EXCEPTION', /exception|stack trace/i],
  ['DATABASE_CONNECTION', /database connection|db connection|connection pool/i],
  ['API_FAILURE', /\bapi\b.{0,35}(fail|error|timeout|unavailable)|(?:fail|error).{0,35}\bapi\b/i],
  ['TRANSACTION_FAILURE', /transaction.{0,35}(fail|error)/i],
  ['APPLICATION_AVAILABILITY', /application.{0,25}(down|unavailable|health)|app availability/i],
  ['SERVER', /\bserver\b.{0,25}(down|unavailable|health|critical)/i],
]);

function clean(value) {
  const text = String(value ?? '').trim();
  return text || null;
}

function taxonomyText(input = {}) {
  return [input.metricName, input.title, input.message, input.normalizedMessage, input.entity,
    input.application, input.service, input.monitoringObjectType, ...(Array.isArray(input.tags) ? input.tags : [])]
    .filter(Boolean).join(' ');
}

function suggestTaxonomy(input = {}) {
  const text = taxonomyText(input);
  const match = TAXONOMY_RULES.find(([, pattern]) => pattern.test(text));
  const subtype = match?.[0] || 'UNKNOWN_SUBTYPE';
  const domain = SUBTYPE_DOMAINS[subtype] || 'UNKNOWN_DOMAIN';
  const evidence = [];
  for (const [field, value] of Object.entries({
    metricName: input.metricName,
    title: input.title,
    message: input.message,
    entity: input.entity,
    application: input.application,
    service: input.service,
    monitoringObjectType: input.monitoringObjectType,
  })) {
    if (value && match?.[1].test(String(value))) evidence.push({ field, value: String(value).slice(0, 300) });
  }
  return {
    domain,
    subtype,
    assignmentMethod: match ? 'STRUCTURED_TEXT_TAXONOMY_V1' : 'NO_SUPPORTED_TAXONOMY_EVIDENCE',
    assignmentEvidence: evidence,
    assignmentConfidence: match ? (evidence.some((item) => ['metricName', 'monitoringObjectType'].includes(item.field)) ? 0.95 : 0.8) : null,
  };
}

function behaviorObservation({ available, observed, evidenceIds = [], detail = null, values = {} } = {}) {
  const availability = Boolean(available);
  return {
    state: !availability ? TRI_STATE.UNAVAILABLE : observed ? TRI_STATE.OBSERVED : TRI_STATE.NOT_OBSERVED,
    indicator: !availability ? null : Boolean(observed),
    evidenceIds: Array.isArray(evidenceIds) ? evidenceIds : [],
    detail,
    ...values,
  };
}

function exactBooleanEvidence(value, keys) {
  if (!value || typeof value !== 'object') return null;
  for (const [key, item] of Object.entries(value)) {
    if (keys.includes(key.toLowerCase()) && typeof item === 'boolean') return { key, value: item };
    if (item && typeof item === 'object') {
      const nested = exactBooleanEvidence(item, keys);
      if (nested) return nested;
    }
  }
  return null;
}

function deriveObservedBehavior(input = {}) {
  const duplicateCount = input.duplicateCount === null || input.duplicateCount === undefined
    ? null : Number(input.duplicateCount);
  const relatedAlertCount = input.relatedAlertCount === null || input.relatedAlertCount === undefined
    ? null : Number(input.relatedAlertCount);
  const transitionCount = input.stateTransitionCount === null || input.stateTransitionCount === undefined
    ? null : Number(input.stateTransitionCount);
  const status = clean(input.status)?.toLowerCase();
  const expected = exactBooleanEvidence(input.rawPayload, [
    'expectedactivity', 'plannedactivity', 'maintenancewindow', 'ismaintenance', 'plannedmaintenance',
  ]) || exactBooleanEvidence(input.extractedDetails, [
    'expectedactivity', 'plannedactivity', 'maintenancewindow', 'ismaintenance', 'plannedmaintenance',
  ]);
  const autoResolutionAvailable = status === 'auto-resolved';
  return {
    duplicate: behaviorObservation({
      available: Number.isFinite(duplicateCount), observed: duplicateCount > 1,
      evidenceIds: input.correlationEvidenceIds,
      detail: Number.isFinite(duplicateCount) ? 'Preserved correlation history contains an observed duplicate count.' : null,
      values: { count: duplicateCount, windowSeconds: input.duplicateWindowSeconds ?? null },
    }),
    flapping: behaviorObservation({
      available: Number.isFinite(transitionCount), observed: Number(input.firingToResolvedCount || 0) > 1 && Number(input.resolvedToFiringCount || 0) > 0,
      evidenceIds: input.transitionEvidenceIds,
      detail: Number.isFinite(transitionCount) ? 'Source-supported lifecycle transitions are available.' : null,
      values: {
        stateTransitionCount: transitionCount,
        firingToResolvedCount: input.firingToResolvedCount ?? null,
        resolvedToFiringCount: input.resolvedToFiringCount ?? null,
        windowSeconds: input.flappingWindowSeconds ?? null,
      },
    }),
    autoResolved: behaviorObservation({
      available: autoResolutionAvailable, observed: autoResolutionAvailable,
      detail: autoResolutionAvailable ? 'The stored source status explicitly reports auto-resolved.' : null,
      values: { resolutionSeconds: autoResolutionAvailable ? input.durationSeconds ?? null : null },
    }),
    nonActionable: behaviorObservation({
      available: input.nonActionableHistoryCount !== null && input.nonActionableHistoryCount !== undefined,
      observed: Number(input.nonActionableHistoryCount || 0) > 0,
      detail: input.nonActionableHistoryCount === null || input.nonActionableHistoryCount === undefined
        ? null : 'Prior authenticated non-actionable outcomes are available as historical context only.',
      values: { historyCount: input.nonActionableHistoryCount ?? null },
    }),
    correlated: behaviorObservation({
      available: Number.isFinite(relatedAlertCount) || Number.isFinite(duplicateCount),
      observed: Number(relatedAlertCount || 0) > 0,
      evidenceIds: input.correlationEvidenceIds,
      detail: Number.isFinite(relatedAlertCount) || Number.isFinite(duplicateCount)
        ? 'Preserved correlation history was evaluated independently of outcome.' : null,
      values: {
        alertCount: relatedAlertCount,
        sourceCount: input.correlatedSourceCount ?? null,
        sources: Array.isArray(input.correlatedSources) ? input.correlatedSources : [],
      },
    }),
    stale: behaviorObservation({
      available: false, observed: false,
      detail: null,
      values: { durationSeconds: null },
    }),
    expectedActivity: behaviorObservation({
      available: Boolean(expected), observed: expected?.value === true,
      detail: expected ? `Explicit source field ${expected.key} was available.` : null,
      values: { evidence: expected || null },
    }),
  };
}

function determineOccurrenceQuality(input = {}) {
  const createdAt = input.createdAt ? new Date(input.createdAt).getTime() : NaN;
  const lastSeen = input.lastSeen ? new Date(input.lastSeen).getTime() : NaN;
  const durationSeconds = Number.isFinite(createdAt) && Number.isFinite(lastSeen)
    ? Math.round((lastSeen - createdAt) / 1000) : null;
  const occurrences = Math.max(1, Number(input.occurrenceCount || 1));
  const source = clean(input.source)?.toLowerCase();
  const ingestionSource = clean(input.ingestionSource)?.toLowerCase();

  if (!Number.isFinite(createdAt) || !Number.isFinite(lastSeen)) {
    return { quality: 'UNAVAILABLE', reason: 'A reliable first-seen/last-seen pair is unavailable.', temporalFeaturesUsable: false };
  }
  if (durationSeconds < 0) {
    return { quality: 'SUSPECT', reason: 'Last seen precedes first seen.', temporalFeaturesUsable: false };
  }
  if (durationSeconds > 30 * 86400 && occurrences <= 3) {
    return { quality: 'SUSPECT', reason: 'A low-occurrence record spans more than 30 days and may reflect ingestion or lifecycle aggregation.', temporalFeaturesUsable: false };
  }
  if (['slack', 'jira', 'jsm operations alerts'].includes(source)
    || ['slack', 'jira'].includes(ingestionSource)
    || durationSeconds > 7 * 86400) {
    return { quality: 'SOURCE_AGGREGATED', reason: 'The record uses a source-derived or long-running grouped lifecycle rather than a guaranteed single episode.', temporalFeaturesUsable: false };
  }
  return { quality: 'RELIABLE', reason: 'Stored timestamps form a bounded occurrence lifecycle with no detected temporal anomaly.', temporalFeaturesUsable: true };
}

const FEATURE_LEAKAGE_AUDIT = Object.freeze([
  ['source', 'PREDICTION_TIME_SAFE'], ['source_identity', 'PREDICTION_TIME_SAFE'],
  ['domain', 'PREDICTION_TIME_SAFE'], ['subtype', 'PREDICTION_TIME_SAFE'],
  ['severity', 'PREDICTION_TIME_SAFE'], ['priority', 'PREDICTION_TIME_SAFE'],
  ['environment', 'PREDICTION_TIME_SAFE'], ['message_signature', 'PREDICTION_TIME_SAFE'],
  ['previous_same_signature_count', 'PREDICTION_TIME_SAFE'],
  ['previous_same_entity_count', 'PREDICTION_TIME_SAFE'],
  ['previous_same_service_count', 'PREDICTION_TIME_SAFE'],
  ['previous_confirmed_incident_count', 'PREDICTION_TIME_SAFE'],
  ['previous_confirmed_noise_count', 'PREDICTION_TIME_SAFE'],
  ['occurrence_count_so_far', 'CONDITIONAL_ON_FEATURE_AS_OF'],
  ['duration_so_far', 'CONDITIONAL_ON_FEATURE_AS_OF'],
  ['related_alerts_observed_so_far', 'CONDITIONAL_ON_FEATURE_AS_OF'],
  ['slack_activity_observed_so_far', 'CONDITIONAL_ON_FEATURE_AS_OF'],
  ['jira_incident_for_current_occurrence', 'POST_OUTCOME_ONLY'],
  ['jira_incident_creation_timestamp', 'POST_OUTCOME_ONLY'],
  ['final_alert_duration', 'POST_OUTCOME_ONLY'], ['final_resolution', 'POST_OUTCOME_ONLY'],
  ['resolver', 'POST_OUTCOME_ONLY'], ['problem_linkage_for_current_occurrence', 'POST_OUTCOME_ONLY'],
  ['later_slack_incident_links', 'POST_OUTCOME_ONLY'], ['operator_outcome', 'POST_OUTCOME_ONLY'],
  ['legacy_classification', 'EXCLUDE'], ['legacy_confidence', 'EXCLUDE'],
]);

function featureLeakageAudit() {
  return FEATURE_LEAKAGE_AUDIT.map(([featureName, classification]) => ({
    featureName,
    classification,
    allowedInTrainingPreview: ['PREDICTION_TIME_SAFE', 'CONDITIONAL_ON_FEATURE_AS_OF'].includes(classification),
  }));
}

function buildTrainingPreview(record) {
  const asOf = record.temporalFeatures?.createdAt || null;
  const taxonomy = record.alertClassification || {};
  return {
    occurrenceId: record.alert.alertId,
    featureAsOf: asOf,
    snapshot: 'T+0',
    predictionTimeFeatures: {
      source: record.alert.source,
      sourceIdentity: record.sourceIdentity,
      domain: taxonomy.domain,
      subtype: taxonomy.subtype,
      severity: record.alert.severity,
      priority: record.alert.priority,
      environment: record.sourceIdentity.environment,
      alertSignature: record.alert.alertSignature,
      occurrenceCountSoFar: 1,
      durationSoFarSeconds: 0,
      relatedAlertsObservedSoFar: 0,
      crossSourceActivityObservedSoFar: false,
      historicalFeatures: record.historicalFeatures,
    },
    observedBehaviorAtFeatureAsOf: Object.fromEntries(BEHAVIOR_TYPES.map((name) => [name, 'UNAVAILABLE_AT_T0'])),
    taxonomy,
    occurrenceQuality: record.occurrenceQuality,
    trainingReadiness: record.trainingReadiness,
    trainingLabelCandidate: record.trainingReadiness?.futureTargetCandidate || null,
    includedInTraining: false,
    excludedPostOutcomeFields: [
      'jiraIncident', 'jiraProblem', 'historicalOutcome', 'operationalOutcome', 'workflow',
      'finalDuration', 'finalResolution', 'resolver', 'laterSlackActivity',
    ],
    provenance: {
      snapshotPolicy: 'Only information available at the stored occurrence creation timestamp is exposed.',
      generatedFromStoredData: true,
      mlModelTrained: false,
    },
  };
}

const SOURCE_SEMANTICS = Object.freeze([
  { source: 'AppDynamics', recordMeaning: 'Operations alert occurrence or preserved AppDynamics-derived alert.', timestampSemantics: 'received_at is ingestion/creation; last_seen_at may be lifecycle refresh.', occurrenceSemantics: 'occurrences may aggregate repeated notifications.', resolutionSemantics: 'Only explicit auto-resolved status supports automatic resolution.', temporalReliability: 'CONDITIONAL' },
  { source: 'Grafana', recordMeaning: 'Grafana rule occurrence represented through the stored alert foundation.', timestampSemantics: 'received_at is first stored occurrence; last_seen_at may track later updates.', occurrenceSemantics: 'occurrences may aggregate repeat firings.', resolutionSemantics: 'Closed/resolved alone does not establish auto-resolution.', temporalReliability: 'CONDITIONAL' },
  { source: 'Nagios', recordMeaning: 'Nagios host/service notification or Operations-wrapped notification.', timestampSemantics: 'received_at is stored notification time; long spans may represent grouped updates.', occurrenceSemantics: 'occurrences may aggregate repeat notifications.', resolutionSemantics: 'Recovery requires source-supported state evidence.', temporalReliability: 'CONDITIONAL' },
  { source: 'JSM Operations', recordMeaning: 'Canonical Atlassian Operations alert occurrence.', timestampSemantics: 'created and last-occurred fields are preserved through normalized storage.', occurrenceSemantics: 'count is the Operations occurrence count when supplied.', resolutionSemantics: 'Operations status is lifecycle evidence, not proof of who/what resolved it.', temporalReliability: 'CONDITIONAL' },
  { source: 'Slack', recordMeaning: 'Slack-derived alert record or workflow context.', timestampSemantics: 'message/activity times are communication timestamps.', occurrenceSemantics: 'not a guaranteed monitoring episode count.', resolutionSemantics: 'discussion is not resolution unless explicitly recorded.', temporalReliability: 'SOURCE_AGGREGATED' },
  { source: 'ThousandEyes', recordMeaning: 'ThousandEyes alert occurrence represented through stored ingestion.', timestampSemantics: 'start/end semantics depend on the preserved API record.', occurrenceSemantics: 'agent/test aggregation may apply.', resolutionSemantics: 'clear state must be explicit in source evidence.', temporalReliability: 'CONDITIONAL' },
]);

module.exports = {
  ALERT_DOMAINS,
  ALERT_SUBTYPES,
  BEHAVIOR_TYPES,
  FEATURE_LEAKAGE_AUDIT,
  SOURCE_SEMANTICS,
  SUBTYPE_DOMAINS,
  TRI_STATE,
  buildTrainingPreview,
  deriveObservedBehavior,
  determineOccurrenceQuality,
  featureLeakageAudit,
  suggestTaxonomy,
};
