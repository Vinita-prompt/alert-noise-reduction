const db = require('../config/db');
const { NOISE_EVIDENCE_ACQUISITION_CONFIG } = require('../config/noiseEvidenceAcquisition');
const { service: actionabilityService } = require('./noiseActionability.service');
const { service: enrichmentService } = require('./noiseEvidenceEnrichment.service');
const { service: evidenceGapService } = require('./noiseEvidenceGap.service');
const { service: sourceIdentityService } = require('./sourceIdentity.service');
const {
  QUEUE_STATES,
  buildEvidenceQueue,
  countQueueStates,
  normalizeFailureReason,
  selectQueueBatch,
  stateFromPackage,
} = require('./noiseEvidenceQueue.service');

const SOURCE_KEYS = Object.freeze({
  AppDynamics: 'appDynamics',
  Grafana: 'grafana',
  Nagios: 'nagios',
  ThousandEyes: 'thousandEyes',
  Jira: 'jira',
  Slack: 'slack',
});
const MAPPING_RANK = Object.freeze({ CONFIRMED_LOCAL: 4, EXACT: 3, STRONG: 2, CANDIDATE: 1, NONE: 0, CONFLICT: -1, NOT_RESOLVED: -2 });

function cleanText(value) {
  return String(value ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function sourceMatches(value, requested) {
  const left = cleanText(value).toLowerCase().replace(/[^a-z]/g, '');
  const right = cleanText(requested).toLowerCase().replace(/[^a-z]/g, '');
  if (!right) return true;
  if (right === 'appd' || right === 'appdynamics') return left === 'appd' || left === 'appdynamics';
  return left === right;
}

function parseRange(value) {
  return ['24h', '7d', '30d', '90d'].includes(value) ? value : '7d';
}

function parsePatternLimit(value, config) {
  const parsed = value === undefined || value === null || value === '' ? config.defaultPatternLimit : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > config.maxPatternLimit) {
    const error = new Error(`patternLimit must be a whole number from 1 to ${config.maxPatternLimit}.`);
    error.code = 'INVALID_ACQUISITION_PATTERN_LIMIT';
    error.safeMessage = error.message;
    error.status = 400;
    throw error;
  }
  return parsed;
}

function parseBatchSize(value, config) {
  const parsed = value === undefined || value === null || value === '' ? config.defaultBatchSize : Number(value);
  if (!config.supportedBatchSizes.includes(parsed)) {
    const error = new Error(`batchSize must be one of ${config.supportedBatchSizes.join(', ')}.`);
    error.code = 'INVALID_EVIDENCE_QUEUE_BATCH_SIZE';
    error.safeMessage = error.message;
    error.status = 400;
    throw error;
  }
  return parsed;
}

function percentage(value, total) {
  return total ? Number((Number(value || 0) / Number(total) * 100).toFixed(1)) : 0;
}

function safeString(value) {
  return cleanText(value)
    .replace(/(?:bearer|basic)\s+[a-z0-9._~+/=-]+/gi, '[REDACTED]')
    .replace(/(token|secret|password|credential|authorization|cookie)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]');
}

function redactDeep(value, key = '', depth = 0) {
  if (depth > 12) return null;
  if (/token|secret|password|credential|authorization|cookie/i.test(key)) return '[REDACTED]';
  if (typeof value === 'string') return safeString(value);
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, key, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([nestedKey, item]) => [nestedKey, redactDeep(item, nestedKey, depth + 1)]));
  }
  return value;
}

function evidencePackage(record, group, nowMs, config = NOISE_EVIDENCE_ACQUISITION_CONFIG) {
  const mapping = record.sourceMapping?.mappings?.[0] || null;
  const monitoringEntries = ['appDynamics', 'grafana', 'nagios', 'thousandEyes']
    .map((key) => [key, record.sources?.[key]])
    .filter(([, value]) => value?.applicable);
  const evidence = Object.values(record.sources || {}).flatMap((source) => source?.evidence || []);
  const sourceTimestamps = evidence.map((item) => item.timestamp).filter(Boolean).sort();
  const telemetryRecords = monitoringEntries.reduce((sum, [, source]) => sum + Number(source?.recordsReturned ?? source?.evidence?.length ?? 0), 0);
  const matchedTelemetryRecords = monitoringEntries.reduce((sum, [, source]) => sum + Number(source?.matchedRecords ?? source?.evidence?.length ?? 0), 0);
  const collectedAt = record.collectedAt || new Date(nowMs).toISOString();
  const appDynamicsSource = record.sources?.appDynamics;
  const appDynamicsQueries = (Array.isArray(appDynamicsSource?.query) ? appDynamicsSource.query : [appDynamicsSource?.query]).filter((item) => item && typeof item === 'object');
  const appDynamicsQuery = appDynamicsQueries[0] || null;
  const appDynamicsMapping = record.sourceMapping?.mappings?.find((item) => sourceMatches(item.source, 'AppDynamics')) || null;
  const appDynamicsRaw = appDynamicsQueries.flatMap((item) => item.rawRecords || []);
  const appDynamicsNormalized = appDynamicsQueries.flatMap((item) => item.normalizedRecords || []);
  const appDynamicsMetadata = appDynamicsNormalized.map((item) => item?.metadata || {}).find((item) => item.tier || item.node || item.businessTransaction) || {};
  return {
    ...record,
    phase: '4.1',
    sourceAdapterVersion: config.sourceAdapterVersion,
    evidenceModelVersion: config.evidenceModelVersion,
    actionabilityModelVersion: config.actionabilityModelVersion,
    mapping: {
      source: mapping?.source || group?.source || null,
      state: mapping?.level || record.sourceMapping?.level || 'NONE',
      entity: mapping?.sourceEntityName || null,
      entityId: mapping?.sourceEntityId || null,
      environment: mapping?.environment || null,
      evidence: mapping?.resolution?.evidence || mapping?.reasons || [],
    },
    telemetry: {
      queried: monitoringEntries.length > 0,
      available: telemetryRecords > 0,
      window: record.investigationWindow || null,
      records: telemetryRecords,
      matchedRecords: matchedTelemetryRecords,
      pipelineState: Object.fromEntries(monitoringEntries.map(([key, source]) => [key, source.pipelineState || 'NOT_QUERIED'])),
      failureReason: Object.fromEntries(monitoringEntries.map(([key, source]) => [key, source.failureReason || null])),
      sourceStatus: Object.fromEntries(monitoringEntries.map(([key, source]) => [key, source.status || source.coverage || 'UNAVAILABLE'])),
    },
    operations: record.sources?.operations || null,
    jira: record.sources?.jira || null,
    slack: record.sources?.slack || null,
    appDynamicsEvidence: appDynamicsSource?.applicable ? {
      occurrenceId: record.alertId,
      operationsAlertId: record.alertId,
      source: 'AppDynamics',
      identity: {
        mappingState: appDynamicsMapping?.level || record.sourceMapping?.level || 'NONE',
        applicationId: appDynamicsQuery?.applicationId || appDynamicsMapping?.metadata?.applicationId || appDynamicsMapping?.sourceEntityId || null,
        applicationName: appDynamicsMapping?.sourceEntityName || null,
        tier: appDynamicsMetadata.tier || null,
        node: appDynamicsMetadata.node || null,
        businessTransaction: appDynamicsMetadata.businessTransaction || null,
        mappingReasons: appDynamicsMapping?.reasons || [],
      },
      metricIntent: appDynamicsQuery?.metricIntent || null,
      query: {
        applicationId: appDynamicsQuery?.applicationId || null,
        metricPath: appDynamicsQuery?.metricPath || null,
        windowStart: appDynamicsQuery?.windowStart || record.investigationWindow?.from || null,
        windowEnd: appDynamicsQuery?.windowEnd || record.investigationWindow?.to || null,
        sourceStatus: appDynamicsQuery?.sourceStatus || appDynamicsSource.status || null,
        outcome: appDynamicsQuery?.outcome || normalizeFailureReason(appDynamicsSource.failureReason, { recordsReturned: appDynamicsSource.recordsReturned }),
        rawRecordCount: appDynamicsRaw.length || appDynamicsQueries.reduce((sum, item) => sum + Number(item.rawRecordCount || 0), 0),
        normalizedRecordCount: appDynamicsNormalized.length || appDynamicsQueries.reduce((sum, item) => sum + Number(item.normalizedRecordCount || 0), 0),
        rawRecords: appDynamicsRaw,
        normalizedRecords: appDynamicsNormalized,
      },
      telemetry: {
        records: Number(appDynamicsSource.recordsReturned || 0),
        matchedRecords: Number(appDynamicsSource.matchedRecords || 0),
        summary: appDynamicsSource.diagnostics?.evidenceSummary || null,
      },
      jira: record.sources?.jira || null,
      slack: record.sources?.slack || null,
      operationalEventId: null,
      operationalSignalClassification: null,
      actionabilityClassification: record.newClassification,
      confidence: record.confidence,
      reasons: record.reasons || [],
      collectedAt,
      adapterVersion: config.sourceAdapterVersion,
      evidenceVersion: config.evidenceModelVersion,
    } : record.appDynamicsEvidence || null,
    evidenceCompleteness: record.evidenceCoverage || record.evidenceStatus || 'INSUFFICIENT_EVIDENCE',
    pipelineDecisionState: stateFromPackage(record),
    previousActionability: record.previousClassification,
    resultingActionability: record.newClassification,
    classificationReason: record.actionabilityAfter?.reasons || record.reasons || [],
    collectedAt,
    sourceTimestamp: sourceTimestamps.at(-1) || null,
    windowStart: record.investigationWindow?.from || null,
    windowEnd: record.investigationWindow?.to || null,
    cacheAge: 0,
    freshnessStatus: record.investigationWindow?.open ? 'CURRENT_WINDOW' : 'HISTORICAL_WINDOW',
    diagnostics: {
      ...(record.diagnostics || {}),
      failureReasons: Object.fromEntries(monitoringEntries.map(([key, source]) => [key, normalizeFailureReason(source.failureReason, { recordsReturned: source.recordsReturned })])),
    },
  };
}

function createPersistentStore({ database = db, now = () => Date.now(), ttlMs = NOISE_EVIDENCE_ACQUISITION_CONFIG.evidencePackageTtlMs } = {}) {
  let readyPromise = null;
  function ensure() {
    if (!readyPromise) readyPromise = database.query(`
      CREATE TABLE IF NOT EXISTS noise_evidence_packages (
        alert_id TEXT NOT NULL,
        pattern_id TEXT NOT NULL,
        analysis_range TEXT NOT NULL,
        analysis_version TEXT,
        evidence_version TEXT NOT NULL,
        classification_version TEXT NOT NULL,
        package_json JSONB NOT NULL,
        collected_at TIMESTAMPTZ NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (alert_id, analysis_range, evidence_version)
      );
      CREATE TABLE IF NOT EXISTS noise_evidence_acquisition_runs (
        run_id TEXT PRIMARY KEY,
        analysis_range TEXT NOT NULL,
        acquisition_version TEXT NOT NULL,
        summary_json JSONB NOT NULL,
        started_at TIMESTAMPTZ NOT NULL,
        completed_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `).catch((error) => {
      readyPromise = null;
      throw error;
    });
    return readyPromise;
  }
  return {
    async load(range) {
      await ensure();
      const result = await database.query(
        'SELECT package_json FROM noise_evidence_packages WHERE analysis_range = $1 AND expires_at > NOW() ORDER BY collected_at DESC',
        [range],
      );
      return result.rows.map((row) => row.package_json).filter(Boolean);
    },
    async loadWithMetadata(range) {
      await ensure();
      const result = await database.query(
        'SELECT package_json, expires_at > NOW() AS active FROM noise_evidence_packages WHERE analysis_range = $1 ORDER BY collected_at DESC',
        [range],
      );
      return {
        records: result.rows.filter((row) => row.active).map((row) => row.package_json).filter(Boolean),
        expired: result.rows.filter((row) => !row.active).length,
      };
    },
    async savePackages(range, records) {
      if (!records.length) return 0;
      await ensure();
      let saved = 0;
      for (const record of records) {
        const collectedAt = record.collectedAt || new Date(now()).toISOString();
        const expiresAt = new Date(new Date(collectedAt).getTime() + ttlMs).toISOString();
        const safe = redactDeep(record);
        await database.query(`
          INSERT INTO noise_evidence_packages (
            alert_id, pattern_id, analysis_range, analysis_version, evidence_version,
            classification_version, package_json, collected_at, expires_at, updated_at
          ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,NOW())
          ON CONFLICT (alert_id, analysis_range, evidence_version) DO UPDATE SET
            pattern_id=EXCLUDED.pattern_id, analysis_version=EXCLUDED.analysis_version,
            classification_version=EXCLUDED.classification_version, package_json=EXCLUDED.package_json,
            collected_at=EXCLUDED.collected_at, expires_at=EXCLUDED.expires_at, updated_at=NOW()
        `, [safe.alertId, safe.patternId, range, safe.analysisVersion, safe.evidenceVersion, safe.classificationVersion, JSON.stringify(safe), collectedAt, expiresAt]);
        saved += 1;
      }
      return saved;
    },
    async latestRun(range) {
      await ensure();
      const result = await database.query(
        'SELECT summary_json FROM noise_evidence_acquisition_runs WHERE analysis_range = $1 ORDER BY completed_at DESC LIMIT 1',
        [range],
      );
      return result.rows[0]?.summary_json || null;
    },
    async saveRun(run) {
      await ensure();
      await database.query(`
        INSERT INTO noise_evidence_acquisition_runs (
          run_id, analysis_range, acquisition_version, summary_json, started_at, completed_at
        ) VALUES ($1,$2,$3,$4::jsonb,$5,$6)
        ON CONFLICT (run_id) DO UPDATE SET summary_json=EXCLUDED.summary_json, completed_at=EXCLUDED.completed_at
      `, [run.runId, run.range, run.acquisitionVersion, JSON.stringify(redactDeep(run)), run.startedAt, run.completedAt]);
      return run;
    },
  };
}

function mappingState(record) {
  if (record?.identity?.accepted === true && record?.identity?.acceptedLevel) {
    return String(record.identity.acceptedLevel).toUpperCase();
  }
  return String(record?.identity?.mappingState || 'NONE').toUpperCase();
}

function mappingBefore(record) {
  return String(record?.identity?.mappingResolution?.fromState || mappingState(record)).toUpperCase();
}

function isAccepted(record, config) {
  return config.acceptedMappingLevels.includes(mappingState(record)) && record?.identity?.mappingConflict !== true;
}

function sourceHasReturnedRecords(source) {
  return Number(source?.recordsReturned ?? source?.evidence?.length ?? 0) > 0;
}

function hasMonitoringRecords(record) {
  return ['appDynamics', 'grafana', 'nagios', 'thousandEyes'].some((key) => sourceHasReturnedRecords(record.sources?.[key]));
}

function hasAppDynamicsRawProvenance(record) {
  if (Number(record?.appDynamicsEvidence?.query?.rawRecordCount || 0) > 0) return true;
  const queries = Array.isArray(record?.sources?.appDynamics?.query)
    ? record.sources.appDynamics.query
    : [record?.sources?.appDynamics?.query];
  return queries.some((query) => Number(query?.rawRecordCount || query?.rawRecords?.length || 0) > 0);
}

function selectDiverseGroups(groups, limit) {
  const selected = [];
  const selectedIds = new Set();
  ['Nagios', 'AppDynamics', 'Grafana', 'ThousandEyes'].forEach((source) => {
    if (selected.length >= limit) return;
    const sourceKey = source.toLowerCase().replace('dynamics', 'd');
    const candidate = groups.find((group) => {
      const groupSource = cleanText(group.source).toLowerCase().replace('dynamics', 'd');
      return (groupSource.includes(sourceKey) || sourceKey.includes(groupSource)) && !selectedIds.has(group.groupId);
    });
    if (candidate) {
      selected.push(candidate);
      selectedIds.add(candidate.groupId);
    }
  });
  groups.forEach((group) => {
    if (selected.length < limit && !selectedIds.has(group.groupId)) {
      selected.push(group);
      selectedIds.add(group.groupId);
    }
  });
  return selected;
}

function acceptedGroupOrder(left, right) {
  return right.affectedOccurrences - left.affectedOccurrences
    || (MAPPING_RANK[right.mappingAfter] || 0) - (MAPPING_RANK[left.mappingAfter] || 0)
    || left.groupId.localeCompare(right.groupId);
}

function groupRecords(records, config) {
  const groups = new Map();
  records.forEach((record) => {
    if (!record.groupId) return;
    const current = groups.get(record.groupId) || {
      groupId: record.groupId,
      pattern: record.pattern,
      source: record.expectedSource,
      records: [],
      mappingAfter: mappingState(record),
      mappingBefore: mappingBefore(record),
      mappingResolution: record.identity?.mappingResolution || null,
      accepted: isAccepted(record, config),
    };
    current.records.push(record);
    if ((MAPPING_RANK[mappingState(record)] || 0) > (MAPPING_RANK[current.mappingAfter] || 0)) current.mappingAfter = mappingState(record);
    current.accepted = current.accepted || isAccepted(record, config);
    current.mappingResolution = current.mappingResolution || record.identity?.mappingResolution || null;
    groups.set(record.groupId, current);
  });
  return [...groups.values()].map((group) => ({ ...group, affectedOccurrences: group.records.length }));
}

function sourceProgress(gapOverview, records, baselineNeedsReview) {
  const rows = ['AppDynamics', 'Grafana', 'Nagios', 'ThousandEyes'].map((source) => {
    const key = SOURCE_KEYS[source];
    const sourceGap = gapOverview.sourceBreakdown.find((item) => item.source === source) || {};
    const packages = records.filter((item) => item.sources?.[key]?.applicable);
    const returned = packages.filter((item) => Number(item.sources?.[key]?.recordsReturned ?? item.sources?.[key]?.evidence?.length ?? 0) > 0);
    const recordsReturned = packages.reduce((sum, item) => sum + Number(item.sources?.[key]?.recordsReturned ?? item.sources?.[key]?.evidence?.length ?? 0), 0);
    const blockerReasons = [...new Set([
      ...packages.map((item) => item.sources?.[key]?.failureReason).filter(Boolean).map((reason) => normalizeFailureReason(reason)),
      ...(packages.length === 0 && Number(sourceGap.mappingConflicts || 0) > 0 ? ['MAPPING_CONFLICT'] : []),
      ...(packages.length === 0 && Number(sourceGap.acceptedMapping || 0) === 0 && Number(sourceGap.needsReview || 0) > 0 ? ['NO_ACCEPTED_MAPPING'] : []),
    ])];
    const reclassified = packages.filter((item) => item.previousClassification === 'NEEDS_REVIEW' && item.newClassification !== 'NEEDS_REVIEW');
    return {
      source,
      unresolved: Number(sourceGap.needsReview || 0),
      acceptedMapping: Number(sourceGap.acceptedMapping || 0),
      telemetryQueried: packages.length,
      telemetryReturned: returned.length,
      recordsReturned,
      sufficientEvidence: reclassified.length,
      reclassified: reclassified.length,
      remainingReview: packages.filter((item) => item.newClassification === 'NEEDS_REVIEW').length,
      blockerReasons,
    };
  });
  ['Jira', 'Slack'].forEach((source) => {
    const key = SOURCE_KEYS[source];
    const inspected = records.filter((item) => item.sources?.[key]?.applicable);
    const returned = inspected.filter((item) => Number(item.sources?.[key]?.recordsReturned ?? item.sources?.[key]?.evidence?.length ?? 0) > 0);
    const reclassified = inspected.filter((item) => item.previousClassification === 'NEEDS_REVIEW' && item.newClassification !== 'NEEDS_REVIEW');
    rows.push({ source, unresolved: baselineNeedsReview, acceptedMapping: 0, telemetryQueried: inspected.length, telemetryReturned: returned.length, recordsReturned: inspected.reduce((sum, item) => sum + Number(item.sources?.[key]?.recordsReturned ?? item.sources?.[key]?.evidence?.length ?? 0), 0), sufficientEvidence: reclassified.length, reclassified: reclassified.length, remainingReview: inspected.filter((item) => item.newClassification === 'NEEDS_REVIEW').length, blockerReasons: [...new Set(inspected.map((item) => item.sources?.[key]?.failureReason).filter(Boolean).map((reason) => normalizeFailureReason(reason)))] });
  });
  rows.push({ source: 'Other', unresolved: Math.max(0, baselineNeedsReview - rows.slice(0, 4).reduce((sum, item) => sum + item.unresolved, 0)), acceptedMapping: 0, telemetryQueried: 0, telemetryReturned: 0, recordsReturned: 0, sufficientEvidence: 0, reclassified: 0, remainingReview: 0, blockerReasons: [] });
  return rows;
}

function acquisitionDiagnostics(queue, packages, gapOverview) {
  const byState = countQueueStates(queue);
  const ready = byState[QUEUE_STATES.READY_FOR_EVIDENCE] || 0;
  const cached = byState[QUEUE_STATES.EVIDENCE_CACHED] || 0;
  const accepted = queue.filter((item) => item.acceptedMapping).length;
  const queried = packages.filter((item) => ['appDynamics', 'grafana', 'nagios', 'thousandEyes'].some((key) => item.sources?.[key]?.applicable)).length;
  const returned = packages.filter(hasMonitoringRecords).length;
  const jiraInspected = packages.filter((item) => item.sources?.jira?.applicable).length;
  const slackInspected = packages.filter((item) => item.sources?.slack?.applicable).length;
  const contextualSourcesInspected = packages.filter((item) => item.sources?.jira?.applicable && item.sources?.slack?.applicable).length;
  const sufficient = packages.filter((item) => item.previousClassification !== item.newClassification).length;
  const classified = Number(gapOverview.summary.actionable || 0) + Number(gapOverview.summary.nonActionable || 0);
  const failureCounts = new Map();
  packages.forEach((item) => Object.values(item.diagnostics?.failureReasons || {}).forEach((reason) => {
    if (reason && reason !== 'OTHER') failureCounts.set(reason, (failureCounts.get(reason) || 0) + 1);
  }));
  const failureReasons = [...failureCounts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])).map(([reason, count]) => ({ reason, count }));
  const sources = ['AppDynamics', 'Grafana', 'Nagios', 'ThousandEyes', 'Jira', 'Slack'];
  const sourceStats = sources.map((source) => {
    const key = SOURCE_KEYS[source];
    const applicable = packages.filter((item) => item.sources?.[key]?.applicable);
    const withRecords = applicable.filter((item) => Number(item.sources?.[key]?.recordsReturned ?? item.sources?.[key]?.evidence?.length ?? 0) > 0);
    const useful = withRecords.filter((item) => item.previousClassification !== item.newClassification);
    return {
      source,
      queries: applicable.length,
      successfulResponses: applicable.filter((item) => item.sources?.[key]?.pipelineState !== 'QUERY_FAILED').length,
      recordsReturned: applicable.reduce((sum, item) => sum + Number(item.sources?.[key]?.recordsReturned ?? item.sources?.[key]?.evidence?.length ?? 0), 0),
      matchedWindows: withRecords.length,
      usefulEvidence: useful.length,
      reclassificationImpact: useful.length,
      averageLatencyMs: applicable.length ? Math.round(applicable.reduce((sum, item) => sum + Number(item.sources?.[key]?.executionTimeMs || 0), 0) / applicable.length) : 0,
      timeouts: applicable.filter((item) => normalizeFailureReason(item.sources?.[key]?.failureReason) === 'SOURCE_TIMEOUT').length,
      errors: applicable.filter((item) => normalizeFailureReason(item.sources?.[key]?.failureReason) === 'SOURCE_ERROR').length,
    };
  });
  return {
    queue: {
      unprocessed: ready,
      queued: activeQueueCount(byState),
      completed: packages.length,
      stillReview: gapOverview.summary.needsReview,
      byState,
      next: queue.filter((item) => item.state === QUEUE_STATES.READY_FOR_EVIDENCE).slice(0, 100),
    },
    coverage: {
      mappingCoverage: { count: accepted, total: queue.length, percentage: percentage(accepted, queue.length) },
      queryCoverage: { count: queried, total: accepted, percentage: percentage(queried, accepted) },
      telemetryCoverage: { count: returned, total: queried, percentage: percentage(returned, queried) },
      jiraInspectionCoverage: { count: jiraInspected, total: queue.length, percentage: percentage(jiraInspected, queue.length) },
      slackInspectionCoverage: { count: slackInspected, total: queue.length, percentage: percentage(slackInspected, queue.length) },
      evidenceSufficiencyCoverage: { count: sufficient, total: packages.length, percentage: percentage(sufficient, packages.length) },
      classificationCoverage: { count: classified, total: gapOverview.summary.total, percentage: percentage(classified, gapOverview.summary.total) },
    },
    funnel: [
      ['Needs Review', queue.length],
      ['Accepted source identity', accepted],
      ['Query eligible', accepted],
      ['Evidence queried', queried],
      ['Evidence returned', returned],
      ['Jira / Slack inspected', contextualSourcesInspected],
      ['Evidence sufficient', sufficient],
      ['Reclassified', sufficient],
    ].map(([stage, count]) => ({ stage, count, percentage: percentage(count, queue.length) })),
    failureReasons,
    sourceStats,
  };
}

function activeQueueCount(byState) {
  return Number(byState[QUEUE_STATES.QUERYING] || 0);
}

function createNoiseEvidenceAcquisitionService({
  actionability = actionabilityService,
  config = NOISE_EVIDENCE_ACQUISITION_CONFIG,
  enrichment = enrichmentService,
  gaps = evidenceGapService,
  identity = sourceIdentityService,
  now = () => Date.now(),
  store = null,
} = {}) {
  const persistence = store || createPersistentStore({ now, ttlMs: config.evidencePackageTtlMs });
  const restoredRanges = new Map();
  const inMemoryRuns = new Map();
  let activeRun = null;
  let activeController = null;

  function compatiblePackage(record) {
    const evidenceVersion = record.evidenceModelVersion || record.evidenceVersion;
    const actionabilityVersion = record.actionabilityModelVersion || record.classificationVersion;
    const adapterVersion = record.sourceAdapterVersion || record.evidenceVersion;
    return evidenceVersion === config.evidenceModelVersion
      && actionabilityVersion === config.actionabilityModelVersion
      && adapterVersion === config.sourceAdapterVersion;
  }

  async function restore(rangeValue, force = false) {
    const range = parseRange(rangeValue);
    const previous = restoredRanges.get(range);
    if (!force && previous && now() - previous.restoredAt < 60_000) return previous;
    try {
      const loaded = persistence.loadWithMetadata
        ? await persistence.loadWithMetadata(range)
        : { records: await persistence.load(range), expired: 0 };
      const compatible = loaded.records.filter(compatiblePackage);
      const records = compatible.map((record) => evidencePackage(record, null, now(), config));
      const imported = enrichment.importPackages(range, records);
      const result = {
        imported,
        invalidVersion: loaded.records.length - compatible.length,
        expired: Number(loaded.expired || 0),
        persistence: 'AVAILABLE',
        restoredAt: now(),
      };
      restoredRanges.set(range, result);
      return result;
    } catch (error) {
      const result = { imported: 0, invalidVersion: 0, expired: 0, persistence: 'UNAVAILABLE', safeError: cleanText(error.code || 'EVIDENCE_STORE_UNAVAILABLE'), restoredAt: now() };
      restoredRanges.set(range, result);
      return result;
    }
  }

  async function latestRun(range) {
    if (inMemoryRuns.has(range)) return inMemoryRuns.get(range);
    try {
      const run = await persistence.latestRun(range);
      if (run) inMemoryRuns.set(range, run);
      return run;
    } catch {
      return null;
    }
  }

  function mappingSummary(records) {
    const promotedRelationships = new Map();
    records.forEach((record) => {
      const resolution = record.identity?.mappingResolution;
      if (!resolution) return;
      promotedRelationships.set(`${record.expectedSource}|${resolution.sourceEntityId}`, resolution);
    });
    return {
      candidateBefore: records.filter((record) => mappingBefore(record) === 'CANDIDATE').length,
      acceptedBefore: records.filter((record) => config.acceptedMappingLevels.includes(mappingBefore(record))).length,
      candidateAfter: records.filter((record) => mappingState(record) === 'CANDIDATE').length,
      acceptedAfter: records.filter((record) => isAccepted(record, config)).length,
      promoted: promotedRelationships.size,
      promotedOccurrences: records.filter((record) => Boolean(record.identity?.mappingResolution)).length,
      rejected: records.filter((record) => record.identity?.mappingResolution?.rejected === true).length,
      conflicts: records.filter((record) => record.identity?.mappingConflict === true).length,
      promotions: [...promotedRelationships.values()],
    };
  }

  async function getStatus(options = {}) {
    const range = parseRange(options.range);
    const startedAt = now();
    const restored = await restore(range);
    const [gapOverview, gapRecords, enrichmentStatus, savedRun] = await Promise.all([
      gaps.getOverview({ range }),
      gaps.getRecords({ range }),
      enrichment.prepareStatus({ range }),
      latestRun(range),
    ]);
    const packages = enrichmentStatus.records || [];
    const cachedIds = packages.map((item) => item.alertId);
    const queue = buildEvidenceQueue(gapRecords, { cachedIds }).map((item) => (
      activeRun?.occurrenceIds?.includes(item.occurrenceId) ? { ...item, state: QUEUE_STATES.QUERYING } : item
    ));
    const diagnostics = acquisitionDiagnostics(queue, packages, gapOverview);
    const selectionPreview = selectDiverseGroups(
      groupRecords(gapRecords, config).filter((group) => group.accepted).sort(acceptedGroupOrder),
      config.defaultPatternLimit,
    ).map((group) => ({ groupId: group.groupId, pattern: group.pattern, source: group.source, affectedOccurrences: group.affectedOccurrences, mappingState: group.mappingAfter }));
    const resolved = enrichmentStatus.reclassifiedActionable + enrichmentStatus.reclassifiedNonActionable;
    const after = gapOverview.summary;
    const baseline = {
      total: after.total,
      actionable: Math.max(0, after.actionable - enrichmentStatus.reclassifiedActionable),
      nonActionable: Math.max(0, after.nonActionable - enrichmentStatus.reclassifiedNonActionable),
      needsReview: after.needsReview + resolved,
    };
    const persisted = packages.filter((item) => item.cache?.status === 'PERSISTED').length;
    return {
      phase: '4.1',
      acquisitionVersion: config.acquisitionVersion,
      range,
      activeRun,
      baseline,
      potentiallyClassifiable: gapOverview.coverage.potentiallyClassifiable,
      structurallyUnresolved: gapOverview.coverage.structurallyUnresolved,
      mapping: mappingSummary(gapRecords),
      acquisition: {
        occurrencesAttempted: packages.length,
        telemetryQueried: packages.filter((item) => ['appDynamics', 'grafana', 'nagios', 'thousandEyes'].some((key) => item.sources?.[key]?.applicable)).length,
        telemetryReturned: packages.filter(hasMonitoringRecords).length,
        recordsReturned: packages.reduce((sum, item) => sum + Number(item.telemetry?.records || 0), 0),
        jiraInspected: packages.filter((item) => item.sources?.jira?.applicable).length,
        slackInspected: packages.filter((item) => item.sources?.slack?.applicable).length,
        evidenceSufficient: resolved,
        evidenceUnavailable: packages.filter((item) => item.evidenceStatus === 'EVIDENCE_UNAVAILABLE').length,
        timeouts: packages.filter((item) => /timeout/i.test(String(item.diagnostics?.safeError || ''))).length,
        errors: packages.filter((item) => item.evidenceStatus === 'EVIDENCE_UNAVAILABLE' && !/timeout/i.test(String(item.diagnostics?.safeError || ''))).length,
        selectionPreview,
      },
      evidenceExpansion: diagnostics,
      after,
      newlyActionable: enrichmentStatus.reclassifiedActionable,
      newlyNonActionable: enrichmentStatus.reclassifiedNonActionable,
      stillNeedsReview: after.needsReview,
      resolvedThroughEvidence: resolved,
      needsReviewResolutionRate: percentage(resolved, baseline.needsReview),
      classificationCoverageBefore: percentage(baseline.actionable + baseline.nonActionable, baseline.total),
      classificationCoverageAfter: percentage(after.actionable + after.nonActionable, after.total),
      sourceProgress: sourceProgress(gapOverview, packages, baseline.needsReview),
      lastRun: savedRun,
      persistence: {
        status: restored.persistence,
        packagesRestored: restored.imported,
        packagesExpired: restored.expired,
        packagesInvalidVersion: restored.invalidVersion,
        persistedPackagesInUse: persisted,
        ttlMs: config.evidencePackageTtlMs,
        sourceAdapterVersion: config.sourceAdapterVersion,
        evidenceModelVersion: config.evidenceModelVersion,
        actionabilityModelVersion: config.actionabilityModelVersion,
      },
      performance: {
        executionTimeMs: Math.max(0, now() - startedAt),
        externalApiCalls: Number(savedRun?.performance?.externalApiCalls || 0),
        cacheHits: Number(savedRun?.performance?.cacheHits || persisted),
        requestsAvoided: Number(savedRun?.performance?.requestsAvoided || persisted),
        timeouts: Number(savedRun?.performance?.timeouts || 0),
        errors: Number(savedRun?.performance?.errors || 0),
        maxConcurrency: config.maxConcurrentSourceOperations,
        inventoryReuse: gapOverview.diagnostics?.inventoryReuse || 'UNKNOWN',
      },
      validationMode: range === '90d' ? 'LOCAL_ANALYSIS_WITH_BOUNDED_EXTERNAL_BATCHES' : packages.length ? 'BOUNDED' : 'MAPPING_ONLY',
      readOnly: true,
      externalMutations: 'none',
      automaticSuppression: 'none',
      aiUsed: false,
    };
  }

  async function acquire(options = {}) {
    if (activeRun) {
      const error = new Error('A Phase 4.1 evidence-acquisition batch is already active.');
      error.code = 'EVIDENCE_ACQUISITION_ALREADY_RUNNING';
      error.safeMessage = error.message;
      error.status = 409;
      throw error;
    }
    const range = parseRange(options.range);
    const source = cleanText(options.source);
    const batchSize = parseBatchSize(options.batchSize, config);
    const startedAtMs = now();
    const startedAt = new Date(startedAtMs).toISOString();
    const runId = `phase4.1-${range}-${startedAtMs}`;
    activeController = new AbortController();
    const abortFromRequest = () => activeController?.abort();
    options.signal?.addEventListener('abort', abortFromRequest, { once: true });
    activeRun = { runId, range, source: source || null, batchSize, status: 'RUNNING', startedAt, occurrenceIds: [] };
    try {
      await restore(range);
      const gapOverview = await gaps.getOverview({ range });
      const allGapRecords = await gaps.getRecords({ range });
      const gapRecords = source ? allGapRecords.filter((record) => sourceMatches(record.expectedSource, source)) : allGapRecords;
      const existingStatus = await enrichment.prepareStatus({ range });
      const cachedRecords = existingStatus.records || [];
      const cachedIds = options.forceRefresh === true
        ? options.provenanceOnly === true
          ? cachedRecords.filter(hasAppDynamicsRawProvenance).map((item) => item.alertId)
          : []
        : cachedRecords.map((item) => item.alertId);
      const queue = buildEvidenceQueue(gapRecords, { cachedIds });
      const selectedQueue = selectQueueBatch(queue, batchSize).filter((item) => item.groupId);
      if (sourceMatches(source, 'AppDynamics') && options.forceRefresh === true && options.provenanceOnly === true) {
        const selectedIds = new Set(selectedQueue.map((item) => item.occurrenceId));
        cachedRecords.filter((item) => item.sources?.appDynamics?.applicable && !hasAppDynamicsRawProvenance(item)).forEach((item) => {
          if (selectedQueue.length >= batchSize || selectedIds.has(item.alertId) || !item.patternId) return;
          selectedQueue.push({
            occurrenceId: item.alertId,
            groupId: item.patternId,
            source: 'AppDynamics',
            state: QUEUE_STATES.READY_FOR_EVIDENCE,
            acceptedMapping: true,
            provenanceMigration: true,
          });
          selectedIds.add(item.alertId);
        });
      }
      const grouped = groupRecords(gapRecords, config);
      const groupById = new Map(grouped.map((group) => [group.groupId, group]));
      const selected = [...new Set(selectedQueue.map((item) => item.groupId))].map((groupId) => groupById.get(groupId)).filter(Boolean);
      const blocked = grouped.filter((group) => !group.accepted).sort((left, right) => right.affectedOccurrences - left.affectedOccurrences).slice(0, 10).map((group) => ({
        groupId: group.groupId,
        pattern: group.pattern,
        source: group.source,
        affectedOccurrences: group.affectedOccurrences,
        mappingState: group.mappingAfter,
        reason: group.mappingAfter === 'CANDIDATE' ? 'Candidate mapping remains blocked until deterministic proof is available.' : 'No accepted deterministic source mapping is available.',
      }));
      activeRun.selectedPatterns = selected.length;
      activeRun.occurrenceIds = selectedQueue.map((item) => item.occurrenceId);
      const batches = [];
      const errors = [];
      if (selectedQueue.length && enrichment.enrichOccurrences) {
        try {
          const batch = await enrichment.enrichOccurrences({
            afterMinutes: config.afterMinutes,
            batchSize,
            beforeMinutes: config.beforeMinutes,
            forceRefresh: options.forceRefresh === true,
            occurrenceIds: selectedQueue.map((item) => item.occurrenceId),
            range,
            signal: activeController.signal,
          });
          batches.push(batch);
        } catch (error) {
          if (error.code === 'SOURCE_VALIDATION_CANCELLED') throw error;
          errors.push({ safeError: cleanText(error.safeMessage || error.code || 'EVIDENCE_ACQUISITION_FAILED') });
        }
      } else if (selectedQueue.length) {
        for (const group of selected) {
          try {
            const selectedInGroup = selectedQueue.filter((item) => item.groupId === group.groupId);
            const batch = await enrichment.enrichGroup(group.groupId, {
              afterMinutes: config.afterMinutes,
              batchSize: Math.min(config.maxOccurrencesPerPattern, selectedInGroup.length),
              beforeMinutes: config.beforeMinutes,
              forceRefresh: options.forceRefresh === true,
              range,
              signal: activeController.signal,
            });
            batches.push(batch);
          } catch (error) {
            errors.push({ groupId: group.groupId, pattern: group.pattern, safeError: cleanText(error.safeMessage || error.code || 'EVIDENCE_ACQUISITION_FAILED') });
          }
        }
      }
      const packages = batches.flatMap((batch) => (batch.records || []).map((record) => evidencePackage(record, groupById.get(record.patternId), now(), config)));
      let packagesPersisted = 0;
      let persistenceStatus = 'AVAILABLE';
      try { packagesPersisted = await persistence.savePackages(range, packages); }
      catch { persistenceStatus = 'UNAVAILABLE'; }
      gaps.invalidate();
      const completedAt = new Date(now()).toISOString();
      const baseline = gapOverview.summary;
      const newlyActionable = packages.filter((item) => item.previousClassification === 'NEEDS_REVIEW' && item.newClassification === 'ACTIONABLE').length;
      const newlyNonActionable = packages.filter((item) => item.previousClassification === 'NEEDS_REVIEW' && item.newClassification === 'NON_ACTIONABLE').length;
      const resolvedThroughEvidence = newlyActionable + newlyNonActionable;
      const after = {
        total: baseline.total,
        actionable: baseline.actionable + newlyActionable,
        nonActionable: baseline.nonActionable + newlyNonActionable,
        needsReview: Math.max(0, baseline.needsReview - resolvedThroughEvidence),
      };
      const sourceTimes = (key) => packages.reduce((sum, item) => sum + Number(item.sources?.[key]?.executionTimeMs || 0), 0);
      const run = {
        phase: sourceMatches(source, 'AppDynamics') ? '4.4A' : '4.1', runId, acquisitionVersion: config.acquisitionVersion, range, source: source || null, startedAt, completedAt,
        baseline,
        potentiallyClassifiable: gapOverview.coverage.potentiallyClassifiable,
        structurallyUnresolved: gapOverview.coverage.structurallyUnresolved,
        mapping: mappingSummary(gapRecords),
        selectedPatterns: selected.map((group) => ({ groupId: group.groupId, pattern: group.pattern, source: group.source, affectedOccurrences: group.affectedOccurrences, mappingBefore: group.mappingBefore, mappingAfter: group.mappingAfter, mappingResolution: group.mappingResolution })),
        queue: {
          batchSize,
          selected: selectedQueue,
          selectedOccurrenceIds: selectedQueue.map((item) => item.occurrenceId),
          states: countQueueStates(queue),
          remainingReady: Math.max(0, queue.filter((item) => item.state === QUEUE_STATES.READY_FOR_EVIDENCE).length - selectedQueue.length),
          cancelled: activeController.signal.aborted,
        },
        blockedPatterns: blocked,
        acquisition: {
          occurrencesAttempted: packages.length,
          telemetryQueried: packages.filter((item) => ['appDynamics', 'grafana', 'nagios', 'thousandEyes'].some((key) => item.sources?.[key]?.applicable)).length,
          telemetryReturned: packages.filter(hasMonitoringRecords).length,
          recordsReturned: packages.reduce((sum, item) => sum + Number(item.telemetry?.records || 0), 0),
          jiraInspected: packages.filter((item) => item.sources?.jira?.applicable).length,
          slackInspected: packages.filter((item) => item.sources?.slack?.applicable).length,
          evidenceSufficient: resolvedThroughEvidence,
          evidenceUnavailable: packages.filter((item) => item.evidenceStatus === 'EVIDENCE_UNAVAILABLE').length,
          timeouts: packages.filter((item) => /timeout/i.test(String(item.diagnostics?.safeError || ''))).length,
          errors: errors.length + packages.filter((item) => item.evidenceStatus === 'EVIDENCE_UNAVAILABLE' && !/timeout/i.test(String(item.diagnostics?.safeError || ''))).length,
        },
        after,
        newlyActionable,
        newlyNonActionable,
        stillNeedsReview: after.needsReview,
        needsReviewBefore: baseline.needsReview,
        needsReviewAfter: after.needsReview,
        resolvedThroughEvidence,
        needsReviewResolutionRate: percentage(resolvedThroughEvidence, baseline.needsReview),
        classificationCoverageBefore: percentage(baseline.actionable + baseline.nonActionable, baseline.total),
        classificationCoverageAfter: percentage(after.actionable + after.nonActionable, after.total),
        batches: batches.map((batch) => ({ ...batch, records: undefined })),
        errors,
        persistence: { status: persistenceStatus, packagesPersisted, ttlMs: config.evidencePackageTtlMs },
        performance: {
          executionTimeMs: Math.max(0, now() - startedAtMs),
          mappingResolutionTimeMs: Number(gapOverview.performance?.executionTimeMs || 0),
          telemetryAcquisitionTimeMs: batches.reduce((sum, batch) => sum + Number(batch.performance?.totalTimeMs || 0), 0),
          jiraTimeMs: sourceTimes('jira'),
          slackTimeMs: sourceTimes('slack'),
          externalApiCalls: batches.reduce((sum, batch) => sum + Number(batch.externalApiCallCount || 0), 0),
          cacheHits: batches.reduce((sum, batch) => sum + Number(batch.cacheHits || 0), 0),
          requestsAvoided: batches.reduce((sum, batch) => sum + Number(batch.requestsAvoided || 0), 0),
          timeouts: packages.filter((item) => /timeout/i.test(String(item.diagnostics?.safeError || ''))).length,
          errors: errors.length,
          maxConcurrency: config.maxConcurrentSourceOperations,
        },
        reconciliation: after.actionable + after.nonActionable + after.needsReview === after.total,
        validationMode: range === '90d' ? 'LOCAL_ANALYSIS_WITH_BOUNDED_EXTERNAL_BATCH' : 'BOUNDED',
        externalMutations: 'none', automaticSuppression: 'none', aiUsed: false,
      };
      inMemoryRuns.set(range, run);
      try { await persistence.saveRun(run); } catch { run.persistence.status = 'UNAVAILABLE'; }
      return run;
    } finally {
      options.signal?.removeEventListener('abort', abortFromRequest);
      activeRun = null;
      activeController = null;
    }
  }

  function cancel() {
    if (!activeController || !activeRun) return { cancelled: false, reason: 'NO_ACTIVE_BATCH' };
    activeController.abort();
    return { cancelled: true, runId: activeRun.runId };
  }

  async function persistReadOnlyPackages(rangeValue, records = []) {
    const range = parseRange(rangeValue);
    const packages = records.map((record) => evidencePackage(record, {
      groupId: record.patternId,
      pattern: record.pattern,
      source: record.sources?.appDynamics?.applicable ? 'AppDynamics' : null,
    }, now(), config));
    const saved = await persistence.savePackages(range, packages);
    const imported = enrichment.importPackages ? enrichment.importPackages(range, packages) : 0;
    return { imported, packages, saved };
  }

  async function getPattern(patternId, options = {}) {
    const range = parseRange(options.range);
    await restore(range);
    let gap = null;
    try { gap = await gaps.getPattern(patternId, { range }); } catch (error) {
      if (error.code !== 'EVIDENCE_GAP_PATTERN_NOT_FOUND') throw error;
    }
    const [enrichmentDetail, identityDetail] = await Promise.all([
      enrichment.getGroupEvidence(patternId, { range }),
      identity.resolve({ groupId: patternId, range }),
    ]);
    const monitoringMappings = ['appDynamics', 'grafana', 'nagios', 'thousandEyes'].flatMap((key) => identityDetail.mappings?.[key] || []).filter((item) => item.level !== 'NONE' && item.rejected !== true);
    const selected = monitoringMappings.sort((left, right) => (MAPPING_RANK[right.level] || 0) - (MAPPING_RANK[left.level] || 0))[0] || null;
    const records = enrichmentDetail.records || [];
    return {
      phase: '4.1', range, patternId,
      pattern: gap?.pattern || { patternId, pattern: records[0]?.pattern || null, affectedOccurrences: records.length },
      mapping: {
        before: selected?.resolution?.fromState || selected?.level || 'NONE',
        after: selected?.level || 'NONE',
        accepted: Boolean(selected && config.acceptedMappingLevels.includes(selected.level)),
        entity: identityDetail.canonicalEntity,
        sourceEntity: selected ? { id: selected.sourceEntityId, name: selected.sourceEntityName, source: selected.source, type: selected.sourceEntityType, environment: selected.environment } : null,
        evidence: selected?.resolution?.evidence || selected?.reasons || [],
        reason: selected?.resolution?.reason || selected?.reasons?.join(' ') || 'No deterministic source mapping is accepted.',
        timestamp: selected?.resolution?.timestamp || selected?.provenance?.lastValidatedAt || null,
        conflicts: identityDetail.conflicts || [],
      },
      telemetry: {
        queried: records.filter((item) => ['appDynamics', 'grafana', 'nagios', 'thousandEyes'].some((key) => item.sources?.[key]?.applicable)).length,
        returned: records.filter(hasMonitoringRecords).length,
        records: records.reduce((sum, item) => sum + ['appDynamics', 'grafana', 'nagios', 'thousandEyes'].reduce((count, key) => count + Number(item.sources?.[key]?.recordsReturned ?? item.sources?.[key]?.evidence?.length ?? 0), 0), 0),
        windows: records.map((item) => item.investigationWindow).filter(Boolean),
      },
      actionability: {
        before: enrichmentDetail.before,
        after: enrichmentDetail.after,
        newlyActionable: enrichmentDetail.reclassifiedActionable,
        newlyNonActionable: enrichmentDetail.reclassifiedNonActionable,
        stillNeedsReview: enrichmentDetail.stillNeedsReview,
      },
      jiraInspected: records.filter((item) => item.sources?.jira?.applicable).length,
      slackInspected: records.filter((item) => item.sources?.slack?.applicable).length,
      evidencePackages: records,
      externalMutations: 'none', aiUsed: false,
    };
  }

  return { acquire, cancel, getPattern, getStatus, persistReadOnlyPackages, restore };
}

module.exports = {
  createNoiseEvidenceAcquisitionService,
  createPersistentStore,
  evidencePackage,
  groupRecords,
  hasAppDynamicsRawProvenance,
  redactDeep,
  selectDiverseGroups,
  service: createNoiseEvidenceAcquisitionService(),
};
