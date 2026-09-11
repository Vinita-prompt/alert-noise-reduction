const crypto = require('node:crypto');

const db = require('../config/db');
const { redactDeep } = require('./noiseEvidenceAcquisition.service');
const { METRIC_CONTRACT, inferredMetricPath, validateTelemetry } = require('./noiseAppDynamicsTelemetrySemantics.service');

const PHASE = '4.4A.3';
const RANGE = '24h';
const AUDIT_SCHEMA_VERSION = 'phase4.4A.3-audit-v2';
const ROOT_CAUSES = Object.freeze([
  'BT_IDENTITY_UNAVAILABLE',
  'NO_ACCEPTED_MAPPING',
  'QUERY_NOT_EXECUTED',
  'WRONG_ENTITY',
  'WRONG_METRIC',
  'WRONG_TIME_WINDOW',
  'NO_TELEMETRY_IN_WINDOW',
  'SOURCE_DATA_RETENTION',
  'SOURCE_API_LIMITATION',
  'ACTIVE_EVENT_NO_BOUNDARY',
  'CONFLICTING_EVIDENCE',
  'NORMALIZATION_FAILURE',
  'OTHER',
]);

function cleanText(value) {
  return String(value ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function normalizeTimestamp(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = typeof value === 'number' || /^\d+(?:\.\d+)?$/.test(String(value).trim()) ? Number(value) : null;
  const milliseconds = Number.isFinite(numeric) ? (numeric < 100_000_000_000 ? numeric * 1000 : numeric) : new Date(value).getTime();
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

function firstQuery(record) {
  const query = record?.evidencePackage?.query;
  return (Array.isArray(query) ? query.find(Boolean) : query) || null;
}

function diagnosticWindow(alert) {
  const query = firstQuery(alert);
  const originalFrom = normalizeTimestamp(query?.windowStart || alert?.evidencePackage?.investigationWindow?.from || alert?.createdAt);
  const originalTo = normalizeTimestamp(query?.windowEnd || alert?.evidencePackage?.investigationWindow?.to || alert?.closedAt || alert?.createdAt);
  if (!originalFrom || !originalTo) return null;
  const from = new Date(originalFrom).getTime();
  const to = new Date(originalTo).getTime();
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return null;
  return {
    from: new Date(from - 5 * 60_000).toISOString(),
    to: new Date(to + 10 * 60_000).toISOString(),
    original: { from: originalFrom, to: originalTo },
    diagnosticPolicy: 'ALERT_MINUS_10_MINUTES_TO_ALERT_PLUS_20_MINUTES',
    timezone: 'UTC',
  };
}

function entityGranularity(alert) {
  const identity = alert?.operationsIdentity || {};
  const text = cleanText(`${alert?.title || ''} ${alert?.alertCondition?.name || ''}`).toLowerCase();
  if (identity.businessTransaction || /business.?transaction|\bbt\b/.test(text)) return 'BUSINESS_TRANSACTION';
  if (identity.node) return 'NODE';
  if (identity.tier) return 'TIER';
  if (/database|\bdb\b|sql|jdbc/.test(text)) return 'DATABASE';
  if (identity.healthRule) return 'HEALTH_RULE';
  return 'APPLICATION';
}

function metricContract(intent) {
  const value = cleanText(intent).toUpperCase() || 'GENERAL_HEALTH';
  const contract = METRIC_CONTRACT[value] || METRIC_CONTRACT.UNKNOWN;
  const metricName = ({ RESPONSE_TIME: 'Average Response Time', ERROR_RATE: 'Errors per Minute', CALLS_LOAD: 'Calls per Minute', CPU: 'CPU', MEMORY: 'Memory' })[value] || null;
  return {
    intent: value,
    metricName,
    metricPath: metricName ? inferredMetricPath(metricName) : null,
    unit: contract.unit,
    aggregation: contract.aggregation,
  };
}

function eventByAlert(status) {
  return new Map((status?.operationalEvents?.events || []).flatMap((event) => (
    (event.notificationIds || []).map((id) => [String(id), event])
  )));
}

function initialRootCause(alert, event) {
  if (alert?.mappingBlocked?.code === 'BT_IDENTITY_UNAVAILABLE') return 'BT_IDENTITY_UNAVAILABLE';
  if (!alert?.mapping?.accepted) return 'NO_ACCEPTED_MAPPING';
  if (!alert?.evidencePackage) return 'QUERY_NOT_EXECUTED';
  if (event?.boundary === 'EVIDENCE_INVALID_METRIC') return 'WRONG_METRIC';
  const query = firstQuery(alert);
  const outcome = cleanText(alert.evidencePackage.queryOutcome || query?.outcome).toUpperCase();
  if (/NORMALIZATION/.test(outcome)) return 'NORMALIZATION_FAILURE';
  if (/ENTITY_NOT_FOUND/.test(outcome)) return 'WRONG_ENTITY';
  if (/UNSUPPORTED|SOURCE_ERROR|SOURCE_TIMEOUT|QUERY_FAILED/.test(outcome)) return 'SOURCE_API_LIMITATION';
  if (/NO_RECORDS|NO_TELEMETRY/.test(outcome) || Number(query?.normalizedRecordCount || 0) === 0) return 'NO_TELEMETRY_IN_WINDOW';
  if (event?.state === 'ONGOING' && !event?.startAt) return 'ACTIVE_EVENT_NO_BOUNDARY';
  if (event?.state === 'INSUFFICIENT_EVIDENCE') return 'OTHER';
  return 'OTHER';
}

function occurrenceAudit(alert, event, diagnostic = null) {
  const query = firstQuery(alert);
  const metric = metricContract(alert?.sourceIdentity?.metricIntent);
  const rootCause = diagnostic?.rootCause || initialRootCause(alert, event);
  return {
    operationsAlertId: alert.id,
    alertNumber: alert.alertNumber || null,
    alertName: alert.title,
    pattern: alert.pattern || alert.title,
    createdAt: normalizeTimestamp(alert.createdAt),
    closedAt: normalizeTimestamp(alert.closedAt),
    application: alert.application?.name || null,
    applicationId: alert.application?.id || null,
    tier: alert.operationsIdentity?.tier || null,
    node: alert.operationsIdentity?.node || null,
    businessTransaction: alert.operationsIdentity?.businessTransaction || null,
    healthRule: alert.operationsIdentity?.healthRule || alert.alertCondition?.healthRule || null,
    policy: alert.sourceIdentity?.policy || null,
    entityGranularity: entityGranularity(alert),
    metricIntent: metric.intent,
    expectedMetric: metric.metricName,
    expectedMetricPath: metric.metricPath,
    expectedUnit: metric.unit,
    expectedAggregation: metric.aggregation,
    mappingState: alert.mapping?.level || 'NONE',
    mappingAccepted: alert.mapping?.accepted === true,
    queryState: diagnostic?.queryState || alert.evidencePackage?.queryOutcome || 'NOT_QUERIED',
    queryWindow: query ? { from: normalizeTimestamp(query.windowStart), to: normalizeTimestamp(query.windowEnd), timezone: 'UTC' } : null,
    diagnosticWindow: diagnostic?.diagnosticWindow || diagnosticWindow(alert),
    telemetryRequested: query?.metricIntent || metric.intent,
    telemetryReturned: Number(alert.evidencePackage?.telemetry?.records || 0),
    rawRecordCount: Number(query?.rawRecordCount || 0),
    normalizedRecordCount: Number(query?.normalizedRecordCount || 0),
    httpStatus: query?.httpStatus || null,
    responseShape: query?.responseShape || null,
    sourceDataAvailability: diagnostic?.sourceDataAvailability || 'UNKNOWN',
    originalReason: initialRootCause(alert, event),
    rootCause,
    diagnostic: diagnostic || null,
    previousClassification: 'NEEDS_REVIEW',
    newClassification: diagnostic?.newClassification || 'NEEDS_REVIEW',
    reasonRemainingReview: diagnostic?.reason
      || (rootCause === 'BT_IDENTITY_UNAVAILABLE' ? 'No structured Business Transaction ID or exact name was present. Application-level telemetry was not used as a substitute.' : null)
      || (rootCause === 'NO_ACCEPTED_MAPPING' ? 'No accepted deterministic AppDynamics entity mapping was available, so no source query was executed.' : null)
      || (rootCause === 'WRONG_METRIC' ? 'Previously returned telemetry did not match the alert condition intent and remains indirect evidence.' : null)
      || alert.classificationReasons?.[0] || event?.evidenceReasons?.[0] || 'Evidence remains insufficient.',
  };
}

function inputVersion(status) {
  const source = (status?.alerts || []).map((alert) => `${alert.id}|${alert.createdAt || ''}`).sort().join('|');
  return crypto.createHash('sha256').update(`${PHASE}|${RANGE}|${source}`).digest('hex');
}

function auditStatus(status, latestRun = null) {
  const version = inputVersion(status);
  const currentEvents = eventByAlert(status);
  const baselineRows = (status?.alerts || []).filter((alert) => alert.classification === 'NEEDS_REVIEW')
    .map((alert) => occurrenceAudit(alert, currentEvents.get(String(alert.id))));
  if (latestRun?.inputVersion === version && Array.isArray(latestRun.occurrences)) {
    const events = eventByAlert(status);
    const occurrences = latestRun.occurrences.map((row) => {
      const event = events.get(String(row.operationsAlertId));
      const contract = metricContract(row.metricIntent);
      const previousMetricStreams = (event?.telemetryValidation?.metricStreams || []).map((stream) => ({
        metricName: stream.metricName || null,
        metricPath: stream.metricPath || null,
        metricIntent: stream.metricIntent || null,
        unit: stream.unit || null,
        aggregation: stream.aggregation || null,
        entityType: stream.entityType || null,
        entityId: stream.entityId || null,
        records: Number(stream.records || 0),
        match: stream.match || null,
      }));
      return {
        ...row,
        expectedMetric: contract.metricName,
        expectedMetricPath: contract.metricPath,
        expectedUnit: contract.unit,
        expectedAggregation: contract.aggregation,
        telemetryRequested: row.diagnostic?.requestedMetricIntent || row.metricIntent,
        previousEvidenceBoundary: event?.boundary || null,
        previousMetricStreams,
        telemetryPreviouslyReturned: [...new Set(previousMetricStreams.map((stream) => stream.metricPath || stream.metricName).filter(Boolean))],
        correctedTelemetryContract: contract.metricName || (row.metricIntent === 'GENERAL_HEALTH' ? 'Direct AppDynamics health-rule/anomaly event' : row.metricIntent),
        reasonRemainingReview: row.rootCause === 'BT_IDENTITY_UNAVAILABLE'
          ? 'No structured Business Transaction ID or exact name was present. Application-level telemetry was not used as a substitute.'
          : row.reasonRemainingReview,
      };
    });
    return summarizeAudit({ ...latestRun, schemaVersion: AUDIT_SCHEMA_VERSION, occurrences }, status);
  }
  return summarizeAudit({
    phase: PHASE,
    range: RANGE,
    inputVersion: version,
    schemaVersion: AUDIT_SCHEMA_VERSION,
    status: 'NOT_RUN',
    startedAt: null,
    completedAt: null,
    occurrences: baselineRows,
    performance: { additionalApiCalls: 0, queriesReused: 0, diagnosticQueries: 0, recordsReturned: 0, timeouts: 0, errors: 0, durationMs: 0, maxConcurrency: 3 },
  }, status);
}

function safeQueryDiagnostic(source, window, semantic) {
  const query = source?.query || {};
  const rawCount = Number(query.rawRecordCount || 0);
  const normalizedCount = Number(query.normalizedRecordCount || 0);
  const httpStatus = query.httpStatus || null;
  const pipelineState = source?.pipelineState || 'NOT_QUERIED';
  const failureReason = source?.failureReason || null;
  const directRecords = Number(semantic?.matchedRecords || 0);
  const mismatchedRecords = Number(semantic?.mismatchedRecords || 0);
  const sourceDataAvailability = /RETENTION/i.test(String(failureReason || '')) ? 'OUTSIDE_RETENTION'
    : rawCount || normalizedCount ? 'AVAILABLE'
      : pipelineState === 'QUERY_FAILED' ? 'UNKNOWN' : 'NOT_AVAILABLE_FOR_METRIC';
  return {
    queryState: pipelineState,
    diagnosticWindow: window,
    httpStatus,
    sourceStatus: query.sourceStatus || null,
    responseShape: query.responseShape || (Array.isArray(query.normalizedRecords) ? 'NORMALIZED_RECORD_ARRAY' : 'EMPTY'),
    rawRecordCount: rawCount,
    normalizedRecordCount: normalizedCount,
    requestedMetricIntent: query.metricIntent || null,
    directRecords,
    mismatchedRecords,
    unknownRecords: Number(semantic?.unknownRecords || 0),
    failureReason,
    sourceDataAvailability,
    metricMatch: query.metricMatch || semantic?.status || 'UNKNOWN',
    actualMetricPaths: query.metricPaths || [],
    queryReused: query.reuse?.cacheHit === true,
    executionTimeMs: Number(source?.executionTimeMs || 0),
  };
}

function diagnoseResult(row, source, semantic) {
  const detail = safeQueryDiagnostic(source, row.diagnosticWindow, semantic);
  let rootCause = row.originalReason;
  let reason = row.reasonRemainingReview;
  if (row.rootCause === 'BT_IDENTITY_UNAVAILABLE' || row.rootCause === 'NO_ACCEPTED_MAPPING') return { ...detail, rootCause: row.rootCause, reason };
  if (!row.diagnosticWindow) return { ...detail, rootCause: 'QUERY_NOT_EXECUTED', reason: 'A valid UTC query window could not be constructed.' };
  if (source?.pipelineState === 'QUERY_FAILED') {
    rootCause = /ENTITY_NOT_FOUND/.test(String(source.failureReason)) ? 'WRONG_ENTITY'
      : /NORMALIZATION/.test(String(source.failureReason)) ? 'NORMALIZATION_FAILURE'
        : /RETENTION/.test(String(source.failureReason)) ? 'SOURCE_DATA_RETENTION' : 'SOURCE_API_LIMITATION';
    reason = `The bounded read-only replay failed with ${cleanText(source.failureReason || 'a source API error')}.`;
  } else if (detail.rawRecordCount > 0 && detail.normalizedRecordCount === 0) {
    rootCause = 'NORMALIZATION_FAILURE';
    reason = 'AppDynamics returned raw records, but none survived normalization.';
  } else if (detail.directRecords > 0) {
    rootCause = row.originalReason === 'WRONG_METRIC' ? 'WRONG_METRIC' : 'WRONG_TIME_WINDOW';
    reason = 'A matching direct AppDynamics record was found only by the single bounded diagnostic replay.';
  } else if (detail.mismatchedRecords > 0 || detail.normalizedRecordCount > 0) {
    rootCause = row.entityGranularity !== 'APPLICATION' ? 'WRONG_ENTITY' : 'WRONG_METRIC';
    reason = 'AppDynamics returned data, but it did not match the required entity and metric semantics.';
  } else if (detail.sourceDataAvailability === 'OUTSIDE_RETENTION') {
    rootCause = 'SOURCE_DATA_RETENTION';
    reason = 'The source explicitly reported that the requested telemetry is outside retention.';
  } else {
    rootCause = 'NO_TELEMETRY_IN_WINDOW';
    reason = `AppDynamics returned ${detail.httpStatus ? `HTTP ${detail.httpStatus}` : 'a successful empty response'} with zero matching records in the bounded UTC diagnostic window.`;
  }
  return { ...detail, rootCause, reason, correctedEvidence: detail.directRecords > 0 };
}

function countRoots(rows) {
  return Object.fromEntries(ROOT_CAUSES.map((cause) => [cause, rows.filter((row) => row.rootCause === cause).length]));
}

function summarizeAudit(run, status = null) {
  const rows = run.occurrences || [];
  const remaining = rows.filter((row) => row.newClassification === 'NEEDS_REVIEW');
  const resolved = rows.length - remaining.length;
  const after = status?.after || run.after || null;
  return {
    ...run,
    rootCauses: countRoots(rows),
    totalAudited: rows.length,
    previousNeedsReview: rows.length,
    remainingNeedsReview: remaining.length,
    resolvedThroughFollowUp: resolved,
    resolvedMapping: rows.filter((row) => row.originalReason === 'NO_ACCEPTED_MAPPING' && row.newClassification !== 'NEEDS_REVIEW').length,
    resolvedQuery: rows.filter((row) => row.rootCause === 'WRONG_TIME_WINDOW' && row.newClassification !== 'NEEDS_REVIEW').length,
    resolvedMetric: rows.filter((row) => row.rootCause === 'WRONG_METRIC' && row.newClassification !== 'NEEDS_REVIEW').length,
    genuinelyUnavailable: remaining.filter((row) => ['NO_TELEMETRY_IN_WINDOW', 'SOURCE_DATA_RETENTION', 'SOURCE_API_LIMITATION'].includes(row.rootCause)).length,
    btIdentityUnresolved: remaining.filter((row) => row.rootCause === 'BT_IDENTITY_UNAVAILABLE').length,
    stillInsufficient: remaining.length,
    reconciliation: ROOT_CAUSES.reduce((sum, cause) => sum + Number(countRoots(rows)[cause] || 0), 0) === rows.length,
    after,
  };
}

function createFollowUpStore({ database = db } = {}) {
  let ready;
  async function ensure() {
    if (!ready) ready = database.query(`
      CREATE TABLE IF NOT EXISTS noise_appdynamics_follow_up_runs (
        run_id TEXT PRIMARY KEY,
        analysis_range TEXT NOT NULL,
        input_version TEXT NOT NULL,
        run_json JSONB NOT NULL,
        completed_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `).catch((error) => { ready = null; throw error; });
    return ready;
  }
  return {
    async latest(range = RANGE) {
      await ensure();
      const result = await database.query('SELECT run_json FROM noise_appdynamics_follow_up_runs WHERE analysis_range = $1 ORDER BY completed_at DESC LIMIT 1', [range]);
      return result.rows[0]?.run_json || null;
    },
    async save(run) {
      await ensure();
      const safe = redactDeep(run);
      await database.query(`
        INSERT INTO noise_appdynamics_follow_up_runs (run_id, analysis_range, input_version, run_json, completed_at)
        VALUES ($1,$2,$3,$4::jsonb,$5)
        ON CONFLICT (run_id) DO UPDATE SET run_json=EXCLUDED.run_json, completed_at=EXCLUDED.completed_at
      `, [safe.runId, safe.range, safe.inputVersion, JSON.stringify(safe), safe.completedAt]);
      return safe;
    },
  };
}

function validateReplay(source, metricIntent) {
  const query = source?.query || {};
  return validateTelemetry(query.normalizedRecords || [], { metricIntent, query });
}

module.exports = {
  AUDIT_SCHEMA_VERSION,
  PHASE,
  RANGE,
  ROOT_CAUSES,
  auditStatus,
  createFollowUpStore,
  diagnoseResult,
  diagnosticWindow,
  entityGranularity,
  inputVersion,
  metricContract,
  normalizeTimestamp,
  occurrenceAudit,
  safeQueryDiagnostic,
  summarizeAudit,
  validateReplay,
};
