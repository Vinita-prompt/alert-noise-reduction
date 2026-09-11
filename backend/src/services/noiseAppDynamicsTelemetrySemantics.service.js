const MODEL_VERSION = '4.4A.2';

const CONDITION_TO_INTENT = Object.freeze({
  RESPONSE_TIME_DEGRADATION: 'RESPONSE_TIME',
  ERROR_DEGRADATION: 'ERROR_RATE',
  LOAD_ANOMALY: 'CALLS_LOAD',
  NODE_HEALTH_DEGRADATION: 'NODE_HEALTH',
  BUSINESS_TRANSACTION_DEGRADATION: 'BUSINESS_TRANSACTION',
  DATABASE_DEGRADATION: 'DATABASE',
  MEMORY_DEGRADATION: 'MEMORY',
  CPU_DEGRADATION: 'CPU',
  HEALTH_RULE_VIOLATION: 'HEALTH_RULE_EVENT',
  UNKNOWN: 'GENERAL_HEALTH',
});

const METRIC_CONTRACT = Object.freeze({
  RESPONSE_TIME: Object.freeze({ unit: 'ms', aggregation: 'average' }),
  ERROR_RATE: Object.freeze({ unit: 'errors/min', aggregation: 'rate' }),
  CALLS_LOAD: Object.freeze({ unit: 'calls/min', aggregation: 'rate' }),
  CPU: Object.freeze({ unit: '%', aggregation: 'average' }),
  MEMORY: Object.freeze({ unit: null, aggregation: 'average' }),
  DATABASE: Object.freeze({ unit: null, aggregation: 'source-defined' }),
  BUSINESS_TRANSACTION: Object.freeze({ unit: null, aggregation: 'source-defined' }),
  NODE_HEALTH: Object.freeze({ unit: null, aggregation: 'source-defined' }),
  HEALTH_RULE_EVENT: Object.freeze({ unit: null, aggregation: 'categorical' }),
  GENERAL_HEALTH: Object.freeze({ unit: null, aggregation: 'categorical' }),
  UNKNOWN: Object.freeze({ unit: null, aggregation: 'unknown' }),
});

function cleanText(value) {
  return String(value ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function canonical(value) {
  return cleanText(value).toLowerCase().replace(/[^a-z0-9%]+/g, ' ').trim();
}

function normalizeIntent(value) {
  const upper = cleanText(value).toUpperCase();
  return CONDITION_TO_INTENT[upper] || (METRIC_CONTRACT[upper] ? upper : 'GENERAL_HEALTH');
}

function intentFromText(value, entityType = null) {
  const text = canonical(value);
  const entity = cleanText(entityType).toUpperCase();
  if (entity === 'BUSINESS_TRANSACTION' || /business transaction|\bbt\b/.test(text)) return 'BUSINESS_TRANSACTION';
  if (/average response time|response.?time|latency|duration|slow/.test(text)) return 'RESPONSE_TIME';
  if (/error %|errors?.?per.?minute|error.?rate|exception|failure|failed|error/.test(text)) return 'ERROR_RATE';
  if (/calls?.?per.?minute|call.?rate|throughput|traffic|load/.test(text)) return 'CALLS_LOAD';
  if (/cpu|processor/.test(text)) return 'CPU';
  if (/memory|heap|garbage collection|\bgc\b/.test(text)) return 'MEMORY';
  if (/database|\bdb\b|sql|jdbc|connection pool/.test(text)) return 'DATABASE';
  if (/node|jvm|machine agent|process/.test(text)) return 'NODE_HEALTH';
  if (/health rule|violation|policy open|policy close/.test(text)) return 'HEALTH_RULE_EVENT';
  return 'UNKNOWN';
}

function inferredMetricPath(metricName) {
  const intent = intentFromText(metricName);
  if (intent === 'RESPONSE_TIME') return 'Overall Application Performance|Average Response Time (ms)';
  if (intent === 'ERROR_RATE') return /percent|%/i.test(metricName) ? 'Overall Application Performance|Error %' : 'Overall Application Performance|Errors per Minute';
  if (intent === 'CALLS_LOAD') return 'Overall Application Performance|Calls per Minute';
  return null;
}

function metricUnit(record, actualIntent) {
  const supplied = cleanText(record?.unit || record?.metadata?.unit);
  if (supplied) return supplied;
  const name = cleanText(record?.metric || record?.title || record?.metadata?.metric);
  if (/\(ms\)|milliseconds?/i.test(name) || actualIntent === 'RESPONSE_TIME') return 'ms';
  if (/percent|%/i.test(name) || actualIntent === 'CPU') return '%';
  return METRIC_CONTRACT[actualIntent]?.unit || null;
}

function metricAggregation(record, actualIntent) {
  const supplied = cleanText(record?.aggregation || record?.metadata?.aggregation);
  if (supplied) return supplied.toLowerCase();
  return METRIC_CONTRACT[actualIntent]?.aggregation || 'unknown';
}

function isEvent(record) {
  const type = cleanText(record?.type || record?.recordType || record?.eventType).toUpperCase();
  return type === 'EVENT' || (!/METRIC|TELEMETRY/.test(type) && record?.value === null);
}

function hasCompatibleEntity(expectedIntent, entityType, entityIdentity) {
  const type = cleanText(entityType).toUpperCase();
  const hasIdentity = Boolean(cleanText(entityIdentity));
  if (expectedIntent === 'BUSINESS_TRANSACTION') return type === 'BUSINESS_TRANSACTION' && hasIdentity;
  if (['NODE_HEALTH', 'CPU', 'MEMORY'].includes(expectedIntent)) {
    return ['NODE', 'MACHINE', 'JVM', 'TIER'].includes(type) && hasIdentity;
  }
  if (expectedIntent === 'DATABASE') return ['DATABASE', 'DB', 'BACKEND'].includes(type) && hasIdentity;
  return true;
}

function recordSemanticIdentity(record, query = {}, expectedIntentValue = null) {
  const metadata = record?.metadata && typeof record.metadata === 'object' ? record.metadata : {};
  const event = isEvent(record);
  const entityType = cleanText(metadata.entityType || record?.entityType
    || (metadata.businessTransaction ? 'BUSINESS_TRANSACTION' : metadata.node ? 'NODE' : metadata.tier ? 'TIER' : 'APPLICATION')).toUpperCase() || 'APPLICATION';
  const metricName = event ? null : cleanText(record?.metric || metadata.metric || record?.title) || null;
  const metricPath = event ? null : cleanText(record?.metricPath || metadata.metricPath || query.metricPath || inferredMetricPath(metricName)) || null;
  const eventText = [record?.eventType, record?.title, record?.summary, record?.message, metadata.healthRule].filter(Boolean).join(' ');
  const actualIntent = event ? intentFromText(eventText, entityType) : intentFromText(`${metricPath || ''} ${metricName || ''}`, entityType);
  const expectedIntent = normalizeIntent(expectedIntentValue || query.metricIntent);
  const applicationId = cleanText(metadata.applicationId || query.applicationId) || null;
  const entityId = cleanText(metadata.entityId || record?.entityId || metadata.businessTransactionId || metadata.nodeId || query.entityId
    || (entityType === 'APPLICATION' ? applicationId : null)) || null;
  const entityName = cleanText(metadata.businessTransaction || metadata.node || metadata.tier || record?.entity) || null;
  const entityCompatible = hasCompatibleEntity(expectedIntent, entityType, entityId || entityName);
  let status = 'UNKNOWN';
  if (event) {
    if (entityCompatible && actualIntent !== 'UNKNOWN' && (actualIntent === expectedIntent
      || expectedIntent === 'GENERAL_HEALTH'
      || (expectedIntent === 'HEALTH_RULE_EVENT' && metadata.healthRule))) status = 'MATCHED';
    else if (!entityCompatible && expectedIntent === 'BUSINESS_TRANSACTION' && actualIntent === 'BUSINESS_TRANSACTION') status = 'UNKNOWN';
    else if (actualIntent !== 'UNKNOWN' && expectedIntent !== 'GENERAL_HEALTH') status = 'MISMATCHED';
  } else if (actualIntent !== 'UNKNOWN') {
    const exact = actualIntent === expectedIntent;
    const businessTransactionMatch = expectedIntent === 'BUSINESS_TRANSACTION' && entityCompatible;
    status = entityCompatible && (exact || businessTransactionMatch) ? 'MATCHED' : 'MISMATCHED';
  }
  const timestamp = record?.timestamp || record?.time || record?.eventTime || null;
  const evidenceLevel = status === 'MATCHED' && timestamp && applicationId ? 'DIRECT'
    : status === 'MISMATCHED' ? 'INDIRECT' : 'INSUFFICIENT';
  return {
    modelVersion: MODEL_VERSION,
    status,
    evidenceLevel,
    expectedIntent,
    actualIntent,
    metricName,
    metricPath,
    unit: event ? null : metricUnit(record, actualIntent),
    aggregation: event ? 'categorical' : metricAggregation(record, actualIntent),
    rollup: cleanText(metadata.rollup || record?.rollup || query.rollup || query.aggregationLabel) || null,
    entityType,
    entityId,
    applicationId,
    timestamp,
    eventType: event ? cleanText(record?.eventType || record?.type || record?.recordType) || 'APPDYNAMICS_EVENT' : null,
  };
}

function validateTelemetry(records = [], options = {}) {
  const expectedIntent = normalizeIntent(options.metricIntent || options.conditionFamily);
  const validated = records.map((record) => {
    const semantic = recordSemanticIdentity(record, options.query || {}, expectedIntent);
    return { ...record, semantic, metadata: { ...(record.metadata || {}), metricIntent: semantic.actualIntent,
      metricPath: semantic.metricPath, unit: semantic.unit, aggregation: semantic.aggregation,
      rollup: semantic.rollup, entityType: semantic.entityType, entityId: semantic.entityId } };
  });
  const matchedRecords = validated.filter((item) => item.semantic.status === 'MATCHED');
  const mismatchedRecords = validated.filter((item) => item.semantic.status === 'MISMATCHED');
  const unknownRecords = validated.filter((item) => item.semantic.status === 'UNKNOWN');
  const streamByKey = new Map();
  validated.filter((item) => item.type === 'METRIC').forEach((item) => {
    const semantic = item.semantic;
    const key = [semantic.metricPath, semantic.metricName, semantic.entityType, semantic.entityId].join('|');
    const stream = streamByKey.get(key) || { metricName: semantic.metricName, metricPath: semantic.metricPath,
      metricIntent: semantic.actualIntent, unit: semantic.unit, aggregation: semantic.aggregation,
      rollup: semantic.rollup, entityType: semantic.entityType, entityId: semantic.entityId,
      applicationId: semantic.applicationId, match: semantic.status, evidenceLevel: semantic.evidenceLevel, records: 0 };
    stream.records += 1;
    if (semantic.status === 'MATCHED') stream.match = 'MATCHED';
    streamByKey.set(key, stream);
  });
  const status = matchedRecords.length ? 'MATCHED' : mismatchedRecords.length ? 'MISMATCHED' : 'UNKNOWN';
  const evidenceLevel = matchedRecords.some((item) => item.semantic.evidenceLevel === 'DIRECT') ? 'DIRECT'
    : mismatchedRecords.length ? 'INDIRECT' : 'INSUFFICIENT';
  return {
    modelVersion: MODEL_VERSION,
    expectedIntent,
    status,
    evidenceLevel,
    totalRecords: validated.length,
    matchedRecords: matchedRecords.length,
    mismatchedRecords: mismatchedRecords.length,
    unknownRecords: unknownRecords.length,
    validMetricRecords: matchedRecords.filter((item) => item.type === 'METRIC').length,
    invalidMetricRecords: mismatchedRecords.filter((item) => item.type === 'METRIC').length,
    metricStreams: [...streamByKey.values()],
    validatedRecords: validated,
    usableRecords: matchedRecords,
  };
}

module.exports = {
  CONDITION_TO_INTENT,
  METRIC_CONTRACT,
  MODEL_VERSION,
  inferredMetricPath,
  intentFromText,
  normalizeIntent,
  recordSemanticIdentity,
  validateTelemetry,
};
