const db = require('../config/db');
const { service: operationsReadService } = require('./atlassian/opsReadValidation.service');
const { coverageFromStored } = require('./sourceEvidenceCoverage.service');

const DISPLAY_TIME_ZONE = process.env.APPLICATION_TIME_ZONE || 'Asia/Kolkata';
const WINDOW_MS = 24 * 60 * 60 * 1000;
const LIVE_PAGE_SIZE = 100;
const MAX_LIVE_RECORDS = 19_900;
const CACHE_TTL_MS = 15_000;
const SUPPORTED_SOURCES = Object.freeze(['AppDynamics', 'Grafana', 'Nagios', 'ThousandEyes']);
const OTHER_SUPPORTED_SOURCES = Object.freeze([]);
const API_FAILURE_STATUSES = new Set([
  'API_UNAVAILABLE', 'AUTH_FAILED', 'FORBIDDEN', 'NOT_FOUND', 'TIMEOUT',
  'INVALID_RESPONSE', 'CERTIFICATE_ERROR', 'SOURCE_API_UNAVAILABLE',
]);

function text(value) {
  return String(value ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function iso(value) {
  const parsed = value ? new Date(value) : null;
  return parsed && !Number.isNaN(parsed.getTime()) ? parsed.toISOString() : null;
}

function boolOption(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'boolean') return value;
  const normalized = text(value).toLowerCase();
  if (['true', '1', 'yes'].includes(normalized)) return true;
  if (['false', '0', 'no'].includes(normalized)) return false;
  return null;
}

function formatInTimeZone(value, timeZone = DISPLAY_TIME_ZONE) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return new Intl.DateTimeFormat('en-US', {
    day: '2-digit', hour: '2-digit', minute: '2-digit', month: 'short',
    second: '2-digit', timeZone, timeZoneName: 'short', year: 'numeric',
  }).format(parsed);
}

function createWindow(nowValue = Date.now(), timeZone = DISPLAY_TIME_ZONE) {
  const end = new Date(nowValue);
  if (Number.isNaN(end.getTime())) throw new Error('Invalid reconciliation execution time.');
  const start = new Date(end.getTime() - WINDOW_MS);
  return {
    durationHours: 24,
    end: end.toISOString(),
    endDisplay: formatInTimeZone(end, timeZone),
    membership: '[start, end]',
    start: start.toISOString(),
    startDisplay: formatInTimeZone(start, timeZone),
    timeZone,
    utc: { start: start.toISOString(), end: end.toISOString() },
  };
}

function populationTimestamp(record = {}) {
  const payload = record.raw_payload || record.rawOperationsPayload || {};
  const candidates = [
    ['operations.createdAt', record.createdAt ?? payload.createdAt ?? payload.created_at ?? payload.createTime],
    ['operations.receivedAt', record.receivedAt ?? record.received_at ?? payload.receivedAt ?? payload.received_at],
    ['canonicalOccurrenceTimestamp', record.occurrenceTimestamp ?? record.occurrence_timestamp],
  ];
  for (const [field, value] of candidates) {
    const timestamp = iso(value);
    if (timestamp) return { timestamp, field };
  }
  return { timestamp: null, field: null };
}

function canonicalId(record = {}) {
  return text(record.canonicalAlertId || record.atlassian_ops_alert_id || record.id || record.source_alert_id) || null;
}

function allTextValues(value, depth = 0) {
  if (depth > 4 || value === null || value === undefined) return [];
  if (['string', 'number'].includes(typeof value)) return [text(value)];
  if (Array.isArray(value)) return value.slice(0, 100).flatMap((item) => allTextValues(item, depth + 1));
  if (typeof value === 'object') {
    return Object.entries(value).slice(0, 200).flatMap(([key, item]) => (
      /(source|integration|monitor|provider|tool|url|link|message|summary|title|description)/i.test(key)
        ? allTextValues(item, depth + 1) : []
    ));
  }
  return [];
}

function supportedSourceFromValue(value) {
  const normalized = text(value).toLowerCase();
  if (!normalized) return null;
  if (/\bappdynamics\b|\bappd\b|\[appd\]/i.test(normalized)) return 'AppDynamics';
  if (/\bgrafana\b/i.test(normalized)) return 'Grafana';
  if (/\bnagios\b/i.test(normalized)) return 'Nagios';
  if (/\bthousand\s*eyes\b/i.test(normalized)) return 'ThousandEyes';
  return null;
}

function sourceIdentity(record = {}) {
  const payload = record.raw_payload || record.rawOperationsPayload || {};
  const extracted = record.extracted_details || {};
  const structured = [
    record.originalSource,
    record.integrationName,
    payload.integrationName,
    extracted?.jsm_ops?.integrationName,
    record.integrationType,
    payload.integrationType,
    record.source,
    payload.source,
    extracted?.normalized_alert?.monitoring_tool,
    extracted?.normalized_alert?.source,
  ].map(text).filter(Boolean);
  const contextual = [record.message, record.summary, record.title, record.description, ...allTextValues(payload)]
    .map(text).filter(Boolean);
  for (const candidate of [...structured, ...contextual]) {
    const supported = supportedSourceFromValue(candidate);
    if (supported) {
      return {
        canonicalSource: supported,
        originalSource: structured[0] || candidate,
        sourceBucket: supported,
        supported: true,
      };
    }
  }
  const originalSource = structured.find((candidate) => !/^(?:jsm[ _-]?ops|operations|jira service management|unknown(?:[ _-](?:source|monitoring tool|service))?)$/i.test(candidate))
    || null;
  if (!originalSource) {
    return { canonicalSource: null, originalSource: null, sourceBucket: 'Unknown', supported: false };
  }
  const canonicalSource = text(originalSource.split('|')[0]) || originalSource;
  return { canonicalSource, originalSource, sourceBucket: 'Unsupported', supported: false };
}

function deduplicateOccurrences(records = []) {
  const items = [];
  const byId = new Map();
  const duplicateIds = new Set();
  let duplicateRecords = 0;
  for (const record of records) {
    const id = canonicalId(record);
    if (!id) {
      items.push(record);
      continue;
    }
    if (byId.has(id)) {
      duplicateRecords += 1;
      duplicateIds.add(id);
      continue;
    }
    byId.set(id, record);
    items.push(record);
  }
  return { items, duplicateIds: [...duplicateIds].sort(), duplicateRecords };
}

function urlsFromRecord(record = {}) {
  const values = [record.source_url, record.sourceUrl, record.url, record.deepLink,
    record.technical_evidence?.coverage?.sourceResolution?.deepLink,
    record.technical_evidence?.deepLink,
    ...allTextValues(record.raw_payload || record.rawOperationsPayload || {}),
    ...allTextValues(record.extracted_details || {}),
    ...allTextValues(record.technical_evidence || {})];
  return values.flatMap((value) => text(value).match(/https?:\/\/[^\s<>"']+/gi) || []);
}

function isExternalGrafanaResolved(record) {
  return urlsFromRecord(record).some((value) => {
    try {
      const hostname = new URL(value).hostname.toLowerCase();
      return hostname === 'grafana.gymsales.net' || hostname === 'grafana.abc.fitness';
    } catch (_error) {
      return false;
    }
  });
}

function coverageForRecord(record, identity) {
  if (!identity.supported) {
    return {
      sourceResolutionStatus: identity.sourceBucket === 'Unknown' ? 'UNKNOWN' : 'NOT_APPLICABLE',
      technicalEvidenceStatus: 'NOT_APPLICABLE', evaluable: false,
      externalGrafana: false, coverage: null,
    };
  }
  const externalGrafana = identity.canonicalSource === 'Grafana' && isExternalGrafanaResolved(record);
  const hasStoredCoverage = Boolean(record.technical_evidence?.coverage?.sourceResolution);
  const hasStoredEvidence = Boolean(
    record.technical_evidence?.provenance
    || record.technical_evidence?.sourceSpecificEvidence?.length
    || record.adapter_diagnostics?.length,
  );
  const coverage = hasStoredCoverage || hasStoredEvidence ? coverageFromStored(
    identity.canonicalSource,
    record.technical_evidence || {},
    record.adapter_diagnostics || [],
    identity.originalSource,
  ) : {
    sourceResolution: { status: 'UNRESOLVED', failureReason: `${identity.canonicalSource.toUpperCase()}_ALERT_UNRESOLVED` },
    evidenceCompleteness: { status: 'MISSING', complete: false },
    evaluability: { status: 'NOT_EVALUABLE', evaluable: false, reason: 'No stored source evidence is available.' },
  };
  const sourceResolutionStatus = externalGrafana ? 'RESOLVED' : coverage.sourceResolution?.status || 'UNRESOLVED';
  const technicalEvidenceStatus = coverage.evidenceCompleteness?.complete
    ? 'COMPLETE' : coverage.evidenceCompleteness?.status || 'MISSING';
  const evaluable = Boolean(record.evaluation_id && coverage.evaluability?.evaluable && !externalGrafana);
  return { coverage, evaluable, externalGrafana, sourceResolutionStatus, technicalEvidenceStatus };
}

function blockerCodes(record, identity, coverageInfo, { hasStoredRecord }) {
  const blockers = [];
  if (!record.populationTimestamp) blockers.push('OCCURRENCE_TIMESTAMP_INVALID');
  if (!hasStoredRecord) blockers.push('MISSING_LOCALLY');
  if (identity.sourceBucket === 'Unsupported') blockers.push('UNSUPPORTED_SOURCE');
  if (identity.sourceBucket === 'Unknown') blockers.push('UNKNOWN_SOURCE');
  if (!identity.supported) return [...new Set(blockers)];
  if (coverageInfo.externalGrafana) blockers.push('GRAFANA_EXTERNAL_INSTANCE_UNAVAILABLE');
  if (coverageInfo.sourceResolutionStatus !== 'RESOLVED') {
    const failure = coverageInfo.coverage?.sourceResolution?.failureReason;
    blockers.push(failure || 'SOURCE_IDENTITY_UNRESOLVED');
  }
  if (API_FAILURE_STATUSES.has(coverageInfo.sourceResolutionStatus)
    || API_FAILURE_STATUSES.has(coverageInfo.technicalEvidenceStatus)) blockers.push('SOURCE_API_UNAVAILABLE');
  if (coverageInfo.technicalEvidenceStatus !== 'COMPLETE') blockers.push('TECHNICAL_EVIDENCE_INCOMPLETE');
  if (!coverageInfo.evaluable) blockers.push('EVALUATION_CONTRACT_FAILED');
  if (!coverageInfo.evaluable) blockers.push('NOT_GOLD_REVIEW_ELIGIBLE');
  return [...new Set(blockers.map((value) => text(value).toUpperCase()).filter(Boolean))];
}

function mergeRecord(live, stored) {
  const primary = stored ? { ...live, ...stored } : { ...live };
  const timestamp = populationTimestamp(live || stored || {});
  // Live Operations metadata is authoritative for population/source buckets.
  // Stored normalization may contain a best-effort monitoring-tool fallback
  // (for example "Payment Gateway") that must not turn a live unknown source
  // into a fabricated supported/unsupported identity.
  const identity = sourceIdentity(live || stored || {});
  const coverageInfo = coverageForRecord(primary, identity);
  const populationRecord = {
    alertId: stored?.id || null,
    canonicalAlertId: canonicalId(live || stored),
    createdAt: timestamp.timestamp,
    populationTimestamp: timestamp.timestamp,
    populationTimestampField: timestamp.field,
    originalSource: identity.originalSource,
    canonicalSource: identity.canonicalSource,
    sourceBucket: identity.sourceBucket,
    supported: identity.supported,
    sourceResolutionStatus: coverageInfo.sourceResolutionStatus,
    technicalEvidenceStatus: coverageInfo.technicalEvidenceStatus,
    evaluable: coverageInfo.evaluable,
    goldReviewEligible: coverageInfo.evaluable,
    reviewed: Boolean(stored?.outcome_id && coverageInfo.evaluable),
    displayId: live?.displayId || (stored?.atlassian_ops_tiny_id ? `#${stored.atlassian_ops_tiny_id}` : null),
    title: text(live?.message || live?.summary || stored?.title || stored?.description) || null,
    status: live?.status || stored?.status || null,
    priority: live?.priority?.name || live?.priority || stored?.priority || null,
    evidenceStatusReason: coverageInfo.coverage?.evaluability?.reason || null,
    externalGrafana: coverageInfo.externalGrafana,
    hasStoredRecord: Boolean(stored),
    currentOutcome: stored?.confirmed_outcome || null,
  };
  populationRecord.blockerCodes = blockerCodes(populationRecord, identity, coverageInfo, {
    hasStoredRecord: Boolean(stored),
  });
  return populationRecord;
}

function insideWindow(record, window) {
  const result = populationTimestamp(record);
  if (!result.timestamp) return false;
  const value = new Date(result.timestamp).getTime();
  return value >= new Date(window.start).getTime() && value <= new Date(window.end).getTime();
}

function reconcilePopulations(liveRecords, storedRecords, window, liveAvailable) {
  const windowExclusions = (liveRecords || []).flatMap((record) => {
    const occurrence = populationTimestamp(record);
    if (!occurrence.timestamp) return [{ canonicalAlertId: canonicalId(record), blockerCode: 'OCCURRENCE_TIMESTAMP_INVALID' }];
    return insideWindow(record, window) ? [] : [{ canonicalAlertId: canonicalId(record), blockerCode: 'OUTSIDE_RECONCILIATION_WINDOW' }];
  });
  const liveWindow = (liveRecords || []).filter((record) => insideWindow(record, window));
  const storedWindow = (storedRecords || []).filter((record) => insideWindow(record, window));
  const live = deduplicateOccurrences(liveWindow);
  const stored = deduplicateOccurrences(storedWindow);
  const liveMap = new Map(live.items.map((record) => [canonicalId(record), record]).filter(([id]) => id));
  const storedMap = new Map(stored.items.map((record) => [canonicalId(record), record]).filter(([id]) => id));
  const matchedIds = [...liveMap.keys()].filter((id) => storedMap.has(id));
  const missingLocallyIds = [...liveMap.keys()].filter((id) => !storedMap.has(id));
  const localOnlyIds = [...storedMap.keys()].filter((id) => !liveMap.has(id));
  const authoritative = liveAvailable ? live.items : stored.items;
  const records = authoritative.map((record) => {
    const id = canonicalId(record);
    return mergeRecord(liveAvailable ? record : null, liveAvailable ? storedMap.get(id) : record);
  });
  return {
    comparison: {
      liveReturnedCount: liveAvailable ? (liveRecords || []).length : null,
      liveExcludedFromWindow: liveAvailable ? windowExclusions.length : null,
      liveCount: liveAvailable ? live.items.length : null,
      storedCount: stored.items.length,
      matchedCount: liveAvailable ? matchedIds.length : null,
      missingLocally: liveAvailable ? missingLocallyIds.length : null,
      missingLocallyIds: liveAvailable ? missingLocallyIds : [],
      localOnly: liveAvailable ? localOnlyIds.length : null,
      localOnlyIds: liveAvailable ? localOnlyIds : [],
      duplicateCanonicalIds: live.duplicateRecords + stored.duplicateRecords,
      duplicateIds: [...new Set([...live.duplicateIds, ...stored.duplicateIds])].sort(),
      livePageDuplicates: live.duplicateRecords,
      storedDuplicates: stored.duplicateRecords,
    },
    records,
    windowExclusions: liveAvailable ? windowExclusions : [],
  };
}

function countBy(records, predicate) {
  return records.reduce((count, record) => count + (predicate(record) ? 1 : 0), 0);
}

function populationSummary(records) {
  const sourceBreakdown = {
    AppDynamics: 0, Grafana: 0, Nagios: 0, ThousandEyes: 0,
    Other: 0, Unsupported: 0, Unknown: 0,
  };
  for (const record of records) {
    const bucket = record.sourceBucket === 'Unsupported'
      ? 'Other'
      : sourceBreakdown[record.sourceBucket] === undefined ? 'Unknown' : record.sourceBucket;
    sourceBreakdown[bucket] += 1;
  }
  const supportedMonitoring = countBy(records, (record) => record.supported);
  const sourceResolved = countBy(records, (record) => record.supported && record.sourceResolutionStatus === 'RESOLVED');
  const technicalEvidenceComplete = countBy(records, (record) => record.supported && record.technicalEvidenceStatus === 'COMPLETE');
  const evaluable = countBy(records, (record) => record.evaluable);
  const goldReviewEligible = countBy(records, (record) => record.goldReviewEligible);
  const reviewed = countBy(records, (record) => record.goldReviewEligible && record.reviewed);
  const funnel = {
    total24h: records.length,
    supportedMonitoring,
    unsupported: sourceBreakdown.Other + sourceBreakdown.Unsupported,
    unknownSource: sourceBreakdown.Unknown,
    sourceResolved,
    sourceUnresolved: supportedMonitoring - sourceResolved,
    technicalEvidenceComplete,
    technicalEvidenceIncomplete: supportedMonitoring - technicalEvidenceComplete,
    evaluable,
    notEvaluable: supportedMonitoring - evaluable,
    goldReviewEligible,
    reviewed,
    unreviewed: goldReviewEligible - reviewed,
  };
  const exclusionReasons = {};
  for (const record of records) {
    for (const blocker of record.blockerCodes || []) exclusionReasons[blocker] = Number(exclusionReasons[blocker] || 0) + 1;
  }
  const externalGrafana = countBy(records, (record) => record.externalGrafana);
  const apiUnavailable = countBy(records, (record) => record.blockerCodes?.includes('SOURCE_API_UNAVAILABLE'));
  const knownExclusion = (record) => !record.goldReviewEligible && (
    !record.supported || record.sourceResolutionStatus !== 'RESOLVED'
    || record.technicalEvidenceStatus !== 'COMPLETE' || record.externalGrafana
    || record.blockerCodes?.includes('SOURCE_API_UNAVAILABLE')
  );
  return {
    arithmetic: {
      sourceBreakdownReconciles: Object.values(sourceBreakdown).reduce((sum, value) => sum + value, 0) === records.length,
      supportedPartitionReconciles: sourceResolved + funnel.sourceUnresolved === supportedMonitoring,
      evidencePartitionReconciles: technicalEvidenceComplete + funnel.technicalEvidenceIncomplete === supportedMonitoring,
      evaluablePartitionReconciles: evaluable + funnel.notEvaluable === supportedMonitoring,
      reviewPartitionReconciles: reviewed + funnel.unreviewed === goldReviewEligible,
    },
    exclusionReasons,
    exclusions: {
      unsupported: funnel.unsupported,
      unknownSource: funnel.unknownSource,
      sourceUnresolved: funnel.sourceUnresolved,
      externalGrafana,
      apiUnavailable,
      evidenceIncomplete: funnel.technicalEvidenceIncomplete,
      other: countBy(records, (record) => !record.goldReviewEligible && !knownExclusion(record)),
    },
    funnel,
    sourceBreakdown,
  };
}

function filterRecords(records, options = {}) {
  const requestedSource = text(options.source).toLowerCase();
  const requestedBlocker = text(options.blocker).toUpperCase();
  const requestedResolution = text(options.sourceResolution || options.resolution).toUpperCase();
  const requestedEvidence = text(options.evidence).toUpperCase();
  const supported = boolOption(options.supported);
  const evaluable = boolOption(options.evaluable);
  const goldReviewEligible = boolOption(options.goldReviewEligible || options.gold);
  return records.filter((record) => (
    (!requestedSource || [record.canonicalSource, record.originalSource, record.sourceBucket]
      .some((value) => text(value).toLowerCase() === requestedSource))
    && (supported === null || record.supported === supported)
    && (!requestedResolution || record.sourceResolutionStatus === requestedResolution)
    && (!requestedEvidence || record.technicalEvidenceStatus === requestedEvidence
      || (requestedEvidence === 'INCOMPLETE' && record.technicalEvidenceStatus !== 'COMPLETE'))
    && (evaluable === null || record.evaluable === evaluable)
    && (goldReviewEligible === null || record.goldReviewEligible === goldReviewEligible)
    && (!requestedBlocker || record.blockerCodes.includes(requestedBlocker))
  ));
}

function driftFrom(previousIds, records) {
  if (!previousIds) return { available: false, entered: null, left: null, net: null };
  const current = new Set(records.map((record) => record.canonicalAlertId).filter(Boolean));
  const entered = [...current].filter((id) => !previousIds.has(id)).length;
  const left = [...previousIds].filter((id) => !current.has(id)).length;
  return { available: true, entered, left, net: entered - left };
}

function safeLiveError(error) {
  const message = text(error?.safeMessage || error?.code || error?.message || 'Operations read unavailable.');
  return message
    .replace(/(?:bearer|basic)\s+[a-z0-9._~+/=-]+/gi, '[REDACTED]')
    .replace(/(token|secret|password|credential|authorization|cookie)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]');
}

function createPopulationReconciliationService({
  database = db,
  operationsService = operationsReadService,
  now = () => Date.now(),
  timeZone = DISPLAY_TIME_ZONE,
  cacheTtlMs = CACHE_TTL_MS,
} = {}) {
  let cache = null;
  let previousIds = null;

  async function loadStored(window) {
    const result = await database.query(`
      SELECT alert.id, alert.title, alert.description, alert.source, alert.source_alert_id,
        alert.atlassian_ops_alert_id, alert.atlassian_ops_tiny_id, alert.source_url,
        alert.status, alert.severity, alert.received_at, alert.created_at,
        alert.raw_payload, alert.extracted_details,
        evaluation.evaluation_id, evaluation.technical_evidence, evaluation.adapter_diagnostics,
        outcome.id AS outcome_id, outcome.outcome AS confirmed_outcome
      FROM alerts alert
      LEFT JOIN live_shadow_evaluations_latest_v1 evaluation ON evaluation.alert_id = alert.id
      LEFT JOIN alert_occurrence_outcomes outcome ON outcome.alert_id = alert.id AND outcome.is_current
      WHERE alert.atlassian_ops_alert_id IS NOT NULL
        AND alert.received_at >= $1::timestamptz
        AND alert.received_at <= $2::timestamptz
      ORDER BY alert.received_at DESC, alert.id DESC
    `, [window.start, window.end]);
    return result.rows || [];
  }

  async function loadLive(window) {
    const configuration = await operationsService.getConfiguration();
    if (!configuration.configured) {
      const error = new Error('JSM Operations read configuration is unavailable.');
      error.code = 'OPERATIONS_NOT_CONFIGURED';
      throw error;
    }
    const values = [];
    const pages = [];
    let offset = 0;
    while (offset < MAX_LIVE_RECORDS) {
      const page = await operationsService.listAlerts({
        from: new Date(window.start).getTime(),
        to: new Date(window.end).getTime(),
        offset,
        order: 'asc',
        size: LIVE_PAGE_SIZE,
        sort: 'createdAt',
      });
      const pageValues = page.values || [];
      values.push(...pageValues);
      pages.push({ offset, returned: pageValues.length, httpStatus: page.httpStatus || null });
      const expectedMore = Boolean(page.pagination?.hasNextPage)
        || (Number(page.count || 0) > offset + pageValues.length)
        || pageValues.length === LIVE_PAGE_SIZE;
      if (!pageValues.length || !expectedMore) break;
      offset += pageValues.length;
      if (offset + LIVE_PAGE_SIZE >= 20_000) {
        const error = new Error('The Operations 24-hour population exceeded the safe pagination boundary.');
        error.code = 'OPERATIONS_RETRIEVAL_BOUNDARY';
        throw error;
      }
    }
    return { records: values, pages };
  }

  async function buildBase() {
    const window = createWindow(now(), timeZone);
    const storedRecords = await loadStored(window);
    let liveAvailable = false;
    let liveRecords = [];
    let pages = [];
    let liveError = null;
    try {
      const live = await loadLive(window);
      liveRecords = live.records;
      pages = live.pages;
      liveAvailable = true;
    } catch (error) {
      liveError = { code: text(error?.code) || 'LIVE_RECONCILIATION_UNAVAILABLE', message: safeLiveError(error) };
    }
    const reconciliation = reconcilePopulations(liveRecords, storedRecords, window, liveAvailable);
    const summary = populationSummary(reconciliation.records);
    const drift = driftFrom(previousIds, reconciliation.records);
    previousIds = new Set(reconciliation.records.map((record) => record.canonicalAlertId).filter(Boolean));
    return {
      generatedAt: window.end,
      window,
      provenance: {
        authoritativeSource: liveAvailable ? 'LIVE_JSM_OPERATIONS_API' : 'PRESERVED_CANONICAL_JSM_OPERATIONS',
        status: liveAvailable ? 'LIVE_RECONCILED' : 'LIVE_RECONCILIATION_UNAVAILABLE',
        warning: liveAvailable ? null : 'Live Operations reconciliation is unavailable; counts use the latest preserved canonical population.',
        liveError,
        externalSystemsReadOnly: true,
      },
      livePagination: {
        complete: liveAvailable,
        pageCount: pages.length,
        pages,
        unexpectedOverlap: reconciliation.comparison.livePageDuplicates,
      },
      comparison: reconciliation.comparison,
      windowExclusions: reconciliation.windowExclusions,
      ...summary,
      drift,
      records: reconciliation.records.sort((left, right) => (
        new Date(right.populationTimestamp || 0) - new Date(left.populationTimestamp || 0)
      )),
      externalMutations: 0,
      decisionSemanticsChanged: false,
      reviewsWritten: 0,
      modelTrainingPerformed: false,
      readOnly: true,
    };
  }

  async function reconcile(options = {}) {
    const cacheNow = Date.now();
    if (!cache || cache.expiresAt <= cacheNow || String(options.refresh).toLowerCase() === 'true') {
      cache = { value: await buildBase(), expiresAt: cacheNow + Math.max(0, cacheTtlMs) };
    }
    const base = cache.value;
    const filtered = filterRecords(base.records, options);
    const page = Math.max(1, Number(options.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(options.pageSize || options.size) || 25));
    const start = (page - 1) * pageSize;
    return {
      ...base,
      records: filtered.slice(start, start + pageSize),
      pagination: {
        page,
        pageSize,
        totalRecords: filtered.length,
        totalPages: filtered.length ? Math.ceil(filtered.length / pageSize) : 0,
      },
      filters: {
        source: text(options.source) || null,
        supported: boolOption(options.supported),
        sourceResolution: text(options.sourceResolution || options.resolution) || null,
        evidence: text(options.evidence) || null,
        evaluable: boolOption(options.evaluable),
        goldReviewEligible: boolOption(options.goldReviewEligible || options.gold),
        blocker: text(options.blocker) || null,
      },
    };
  }

  return { reconcile };
}

module.exports = {
  DISPLAY_TIME_ZONE,
  OTHER_SUPPORTED_SOURCES,
  SUPPORTED_SOURCES,
  WINDOW_MS,
  canonicalId,
  createPopulationReconciliationService,
  createWindow,
  deduplicateOccurrences,
  driftFrom,
  filterRecords,
  formatInTimeZone,
  insideWindow,
  populationSummary,
  populationTimestamp,
  reconcilePopulations,
  service: createPopulationReconciliationService(),
  sourceIdentity,
};
