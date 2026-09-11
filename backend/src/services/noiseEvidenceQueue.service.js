const QUEUE_STATES = Object.freeze({
  READY_FOR_EVIDENCE: 'READY_FOR_EVIDENCE',
  WAITING_FOR_MAPPING: 'WAITING_FOR_MAPPING',
  WAITING_FOR_SOURCE_IDENTITY: 'WAITING_FOR_SOURCE_IDENTITY',
  SOURCE_UNSUPPORTED: 'SOURCE_UNSUPPORTED',
  EVIDENCE_CACHED: 'EVIDENCE_CACHED',
  QUERYING: 'QUERYING',
  EVIDENCE_RETURNED: 'EVIDENCE_RETURNED',
  EVIDENCE_INSUFFICIENT: 'EVIDENCE_INSUFFICIENT',
  EVIDENCE_SUFFICIENT: 'EVIDENCE_SUFFICIENT',
  SOURCE_TIMEOUT: 'SOURCE_TIMEOUT',
  SOURCE_ERROR: 'SOURCE_ERROR',
  NO_HISTORICAL_DATA: 'NO_HISTORICAL_DATA',
  STRUCTURALLY_UNRESOLVED: 'STRUCTURALLY_UNRESOLVED',
});

const FAILURE_REASONS = Object.freeze([
  'NO_ACCEPTED_MAPPING',
  'NOT_QUERY_ELIGIBLE',
  'SOURCE_TIMEOUT',
  'SOURCE_ERROR',
  'NO_RECORDS_IN_WINDOW',
  'CURRENT_DATA_ONLY',
  'UNSUPPORTED_HISTORICAL_QUERY',
  'TIMESTAMP_MISMATCH',
  'IDENTITY_CONFLICT',
  'INSUFFICIENT_RECORDS',
  'NORMALIZATION_FAILED',
  'OTHER',
]);

const SUPPORTED_SOURCES = new Set(['AppDynamics', 'Grafana', 'Nagios', 'ThousandEyes']);
const HISTORICAL_SOURCES = new Set(['AppDynamics', 'Grafana', 'Nagios', 'ThousandEyes']);
const MAPPING_RANK = Object.freeze({ CONFIRMED_LOCAL: 4, EXACT: 3, STRONG: 2, CANDIDATE: 1, NONE: 0, CONFLICT: -1, NOT_RESOLVED: -2 });

function text(value) {
  return String(value ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function canonical(value) {
  return text(value).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function sourceSupported(source) {
  return SUPPORTED_SOURCES.has(text(source));
}

function sourceHistorical(source) {
  return HISTORICAL_SOURCES.has(text(source));
}

function acceptedMapping(record) {
  const state = String(record?.identity?.acceptedLevel || record?.identity?.mappingState || 'NONE').toUpperCase();
  return record?.identity?.mappingConflict !== true
    && (record?.identity?.accepted === true || ['EXACT', 'STRONG', 'CONFIRMED_LOCAL'].includes(state));
}

function groupCounts(records) {
  return records.reduce((counts, record) => {
    const key = record.groupId || `unresolved:${record.expectedSource}`;
    counts.set(key, (counts.get(key) || 0) + 1);
    return counts;
  }, new Map());
}

function humanToil(record) {
  const occurrence = record.occurrence || {};
  const handling = occurrence.humanHandling || occurrence.evidence?.humanHandling || {};
  return Number(handling.toilScore || handling.operatorActions || occurrence.acknowledged || record.alert?.acknowledged || 0);
}

function noiseLikelihood(record) {
  return Number(record.occurrence?.noiseLikelihood ?? record.occurrence?.noiseScore ?? record.noiseLikelihood ?? 0);
}

function patternSignal(record) {
  const labels = [record.pattern, ...(record.occurrence?.labels || []), record.occurrence?.classification].join(' ').toLowerCase();
  return /duplicate|flapping|flapping_like/.test(labels) ? 1 : 0;
}

function initialState(record, cachedIds) {
  const id = String(record.alert?.id || '');
  if (cachedIds.has(id)) return QUEUE_STATES.EVIDENCE_CACHED;
  if (!sourceSupported(record.expectedSource)) return QUEUE_STATES.SOURCE_UNSUPPORTED;
  if (record.identity?.mappingConflict) return QUEUE_STATES.STRUCTURALLY_UNRESOLVED;
  if (!record.identity?.canonicalEntity && !record.identity?.mappedEntity && !record.identity?.mappingResolution?.sourceEntityId) return QUEUE_STATES.WAITING_FOR_SOURCE_IDENTITY;
  if (!acceptedMapping(record)) return QUEUE_STATES.WAITING_FOR_MAPPING;
  return QUEUE_STATES.READY_FOR_EVIDENCE;
}

function buildEvidenceQueue(records = [], options = {}) {
  const cachedIds = new Set(options.cachedIds || []);
  const counts = groupCounts(records);
  return records.map((record) => {
    const occurrenceId = String(record.alert?.id || '');
    const mappingState = String(record.identity?.acceptedLevel || record.identity?.mappingState || 'NONE').toUpperCase();
    const canonicalEntity = record.identity?.mappedEntity?.id
      || record.identity?.canonicalEntity?.entityId
      || record.identity?.canonicalEntity?.canonicalName
      || null;
    const item = {
      occurrenceId,
      alertNumber: record.alert?.alertNumber || null,
      groupId: record.groupId || null,
      pattern: record.pattern || record.alert?.title || null,
      source: record.expectedSource,
      canonicalEntity,
      mappingState,
      acceptedMapping: acceptedMapping(record),
      historicalCapable: sourceHistorical(record.expectedSource),
      occurrenceCount: counts.get(record.groupId || `unresolved:${record.expectedSource}`) || 1,
      humanToil: humanToil(record),
      noiseLikelihood: noiseLikelihood(record),
      duplicateOrFlapping: patternSignal(record),
      cached: cachedIds.has(occurrenceId),
      state: initialState(record, cachedIds),
      primaryEvidenceGap: record.primaryEvidenceGapCode || null,
      createdAt: record.alert?.createdAt || null,
    };
    item.priority = [
      Number(item.acceptedMapping),
      Number(item.historicalCapable),
      item.occurrenceCount,
      item.humanToil,
      item.noiseLikelihood,
      item.duplicateOrFlapping,
      Number(!item.cached),
    ];
    return item;
  }).sort((left, right) => {
    for (let index = 0; index < left.priority.length; index += 1) {
      if (left.priority[index] !== right.priority[index]) return right.priority[index] - left.priority[index];
    }
    return left.occurrenceId.localeCompare(right.occurrenceId);
  });
}

function selectQueueBatch(queue, size) {
  return queue.filter((item) => item.state === QUEUE_STATES.READY_FOR_EVIDENCE).slice(0, size);
}

function countQueueStates(queue) {
  const byState = Object.fromEntries(Object.values(QUEUE_STATES).map((state) => [state, 0]));
  queue.forEach((item) => { byState[item.state] = Number(byState[item.state] || 0) + 1; });
  return byState;
}

function normalizeFailureReason(value, context = {}) {
  const reason = text(value).toUpperCase().replace(/[^A-Z0-9]+/g, '_');
  if (!reason && context.recordsReturned === 0) return 'NO_RECORDS_IN_WINDOW';
  if (/TIMEOUT|TIMED_OUT|ABORT/.test(reason)) return 'SOURCE_TIMEOUT';
  if (/NO_ACCEPTED|NO_CONFIRMED|CANDIDATE_MAPPING/.test(reason)) return 'NO_ACCEPTED_MAPPING';
  if (/NOT_APPLICABLE|NOT_QUERY|NO_EXACT_ALERT/.test(reason)) return 'NOT_QUERY_ELIGIBLE';
  if (/CURRENT_DATA_ONLY/.test(reason)) return 'CURRENT_DATA_ONLY';
  if (/UNSUPPORTED_HISTORICAL/.test(reason)) return 'UNSUPPORTED_HISTORICAL_QUERY';
  if (/OUTSIDE_WINDOW|TIMESTAMP/.test(reason)) return 'TIMESTAMP_MISMATCH';
  if (/CONFLICT/.test(reason)) return 'IDENTITY_CONFLICT';
  if (/NO_TELEMETRY|NO_MATCHING|NO_RECORDS/.test(reason)) return 'NO_RECORDS_IN_WINDOW';
  if (/INSUFFICIENT/.test(reason)) return 'INSUFFICIENT_RECORDS';
  if (/NORMALIZ/.test(reason)) return 'NORMALIZATION_FAILED';
  if (/ERROR|FAILED|FORBIDDEN|UNAVAILABLE|401|403|5\d\d/.test(reason)) return 'SOURCE_ERROR';
  return reason && FAILURE_REASONS.includes(reason) ? reason : 'OTHER';
}

function stateFromPackage(record) {
  const monitoring = ['appDynamics', 'grafana', 'nagios', 'thousandEyes']
    .map((key) => record.sources?.[key])
    .filter((source) => source?.applicable);
  const reasons = monitoring.map((source) => normalizeFailureReason(source.failureReason, { recordsReturned: source.recordsReturned }));
  if (reasons.includes('SOURCE_TIMEOUT')) return QUEUE_STATES.SOURCE_TIMEOUT;
  if (reasons.includes('SOURCE_ERROR')) return QUEUE_STATES.SOURCE_ERROR;
  if (reasons.includes('CURRENT_DATA_ONLY') || reasons.includes('UNSUPPORTED_HISTORICAL_QUERY')) return QUEUE_STATES.NO_HISTORICAL_DATA;
  if (record.previousClassification !== record.newClassification) return QUEUE_STATES.EVIDENCE_SUFFICIENT;
  if (monitoring.some((source) => Number(source.recordsReturned ?? source.evidence?.length ?? 0) > 0)) return QUEUE_STATES.EVIDENCE_RETURNED;
  return QUEUE_STATES.EVIDENCE_INSUFFICIENT;
}

function mappingKey(job) {
  const mapping = job.adapter.resolveIdentity(job.alert, job.mappings) || {};
  return `${job.adapter.source}:${mapping.sourceEntityId || mapping.sourceEntityName || job.alert.canonicalEntity || job.alert.occurrenceId}`;
}

function coalesceEvidenceJobs(jobs = []) {
  const buckets = new Map();
  jobs.forEach((job) => {
    const key = mappingKey(job);
    const items = buckets.get(key) || [];
    items.push(job);
    buckets.set(key, items);
  });
  const result = [];
  buckets.forEach((items, key) => {
    items.sort((left, right) => new Date(left.window.from).getTime() - new Date(right.window.from).getTime());
    items.forEach((job) => {
      const previous = result.at(-1);
      const sameBucket = previous?.key === key;
      const overlaps = sameBucket && new Date(job.window.from).getTime() <= new Date(previous.window.to).getTime();
      if (!overlaps) {
        result.push({ key, adapter: job.adapter, alert: job.alert, mappings: job.mappings, occurrenceIds: [job.alert.occurrenceId], alerts: [job.alert], window: { ...job.window } });
        return;
      }
      previous.window.to = new Date(Math.max(new Date(previous.window.to).getTime(), new Date(job.window.to).getTime())).toISOString();
      previous.occurrenceIds.push(job.alert.occurrenceId);
      previous.alerts.push(job.alert);
    });
  });
  return result;
}

module.exports = {
  FAILURE_REASONS,
  MAPPING_RANK,
  QUEUE_STATES,
  acceptedMapping,
  buildEvidenceQueue,
  coalesceEvidenceJobs,
  countQueueStates,
  normalizeFailureReason,
  selectQueueBatch,
  stateFromPackage,
};
