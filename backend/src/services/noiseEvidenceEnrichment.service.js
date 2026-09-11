const { NOISE_EVIDENCE_ENRICHMENT_CONFIG } = require('../config/noiseEvidenceEnrichment');
const { classifyOccurrence, classifyPattern } = require('./noiseActionability.service');
const { service: actionabilityService } = require('./noiseActionability.service');
const { service: phase1Service } = require('./noiseAnalysis.service');
const { mapWithConcurrency } = require('./noiseEvidence.service');
const { service: sourceIdentityService } = require('./sourceIdentity.service');
const { service: sourceValidationService } = require('./noiseSourceValidation.service');

const ACCEPTED_MAPPING_LEVELS = new Set(['EXACT', 'STRONG', 'CONFIRMED_LOCAL']);
const MONITORING_MAPPING_KEYS = ['appDynamics', 'grafana', 'thousandEyes', 'nagios'];
const SOURCE_KEYS = Object.freeze({
  'JSM Operations': 'operations',
  AppDynamics: 'appDynamics',
  Grafana: 'grafana',
  ThousandEyes: 'thousandEyes',
  Nagios: 'nagios',
  'ACC Jira': 'jira',
  Slack: 'slack',
});
const VALID_EVIDENCE_STATES = new Set(['all', 'ENRICHED', 'NOT_ENRICHED', 'EVIDENCE_UNAVAILABLE']);

function safeError(message, code, status = 400) {
  const error = new Error(message);
  error.code = code;
  error.safeMessage = message;
  error.status = status;
  return error;
}

function cleanText(value) {
  return String(value ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function canonical(value) {
  return cleanText(value).toLowerCase();
}

function toMs(value) {
  if (Number.isFinite(value)) return Number(value);
  const parsed = value ? new Date(value).getTime() : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function toIso(value) {
  const milliseconds = toMs(value);
  return milliseconds === null ? null : new Date(milliseconds).toISOString();
}

function unique(values) {
  return [...new Set(values.filter(Boolean).map(cleanText).filter(Boolean))];
}

function percentile(values, position) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (!sorted.length) return 0;
  const index = (sorted.length - 1) * position;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  return Math.round(lower === upper ? sorted[lower] : sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower));
}

function parseRange(value) {
  return ['24h', '7d', '30d', '90d'].includes(value) ? value : '7d';
}

function parseBoolean(value) {
  return value === true || String(value || '').toLowerCase() === 'true';
}

function parseBatchSize(value, config) {
  const parsed = value === undefined || value === null || value === '' ? config.defaultBatchSize : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > config.maxBatchSize) {
    throw safeError(`batchSize must be a whole number from 1 to ${config.maxBatchSize}.`, 'INVALID_ENRICHMENT_BATCH_SIZE');
  }
  return parsed;
}

function parseWindowMinutes(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 30) {
    throw safeError('Evidence window minutes must be a whole number from 1 to 30.', 'INVALID_ENRICHMENT_WINDOW');
  }
  return parsed;
}

function alertId(alert) {
  return String(alert?.id || alert?.canonicalOperationsId || alert?.externalId || '');
}

function alertNumber(alert) {
  return String(alert?.tinyId || alert?.alertNumber || '');
}

function buildBoundedWindow(alert, config = NOISE_EVIDENCE_ENRICHMENT_CONFIG, nowMs = Date.now()) {
  const createdAtMs = toMs(alert?.createdAt || alert?.firstOccurredAt);
  if (createdAtMs === null) return null;
  const closedAtMs = toMs(alert?.closeTime || alert?.closedAt || alert?.resolvedAt);
  const observedAtMs = toMs(alert?.lastOccurredAt || alert?.updatedAt);
  const requestedActiveEnd = closedAtMs || Math.max(createdAtMs, Math.min(nowMs, observedAtMs || nowMs));
  const activeEnd = Math.min(requestedActiveEnd, createdAtMs + config.maxWindowMinutes * 60 * 1000);
  const open = closedAtMs === null && !/closed|resolved/i.test(String(alert?.status || ''));
  return {
    from: new Date(createdAtMs - config.beforeMinutes * 60 * 1000).toISOString(),
    activeFrom: new Date(createdAtMs).toISOString(),
    activeTo: new Date(activeEnd).toISOString(),
    to: new Date(activeEnd + (open ? 0 : config.afterMinutes * 60 * 1000)).toISOString(),
    beforeMinutes: config.beforeMinutes,
    afterMinutes: config.afterMinutes,
    maxWindowMinutes: config.maxWindowMinutes,
    capped: requestedActiveEnd > activeEnd,
    open,
  };
}

function mergeOverlappingWindows(candidates) {
  const sorted = candidates.filter((item) => item.window).sort((left, right) => toMs(left.window.from) - toMs(right.window.from));
  const merged = [];
  sorted.forEach((candidate) => {
    const start = toMs(candidate.window.from);
    const end = toMs(candidate.window.to);
    const previous = merged.at(-1);
    const sameFingerprint = previous && previous.queryFingerprint === candidate.queryFingerprint;
    if (sameFingerprint && start <= toMs(previous.to)) {
      previous.to = new Date(Math.max(toMs(previous.to), end)).toISOString();
      previous.occurrenceIds.push(candidate.occurrenceId);
      return;
    }
    merged.push({
      from: candidate.window.from,
      to: candidate.window.to,
      queryFingerprint: candidate.queryFingerprint,
      occurrenceIds: [candidate.occurrenceId],
    });
  });
  return merged;
}

function acceptedMappings(identity) {
  return MONITORING_MAPPING_KEYS.flatMap((key) => (identity?.mappings?.[key] || []).filter((mapping) => (
    ACCEPTED_MAPPING_LEVELS.has(String(mapping.level || '').toUpperCase())
      && mapping.rejected !== true
      && mapping.usableForSourceValidation !== false
  )));
}

function bestMappingLevel(mappings) {
  if (mappings.some((item) => item.level === 'CONFIRMED_LOCAL')) return 'CONFIRMED_LOCAL';
  if (mappings.some((item) => item.level === 'EXACT')) return 'EXACT';
  if (mappings.some((item) => item.level === 'STRONG')) return 'STRONG';
  return 'NONE';
}

function priorityFor(group, mappingLevel) {
  const labels = new Set(group.labels || [group.classification]);
  const reasons = [];
  let score = Number(group.noiseLikelihood ?? group.noiseScore ?? 0) * 1000;
  reasons.push(`Noise Likelihood ${Number(group.noiseLikelihood ?? group.noiseScore ?? 0)}`);
  if (group.humanToil?.level === 'HIGH') { score += 30_000; reasons.push('High Human Toil'); }
  if (labels.has('duplicate') || labels.has('flapping') || labels.has('flapping_like')) { score += 20_000; reasons.push('Duplicate/flapping behavior'); }
  score += Math.min(20_000, Number(group.occurrences || 0) * 100);
  reasons.push(`${Number(group.occurrences || 0)} pattern occurrences`);
  if (mappingLevel === 'CONFIRMED_LOCAL') { score += 60_000; reasons.push('Locally confirmed source identity'); }
  else if (mappingLevel === 'EXACT') { score += 50_000; reasons.push('Exact source identity'); }
  else if (mappingLevel === 'STRONG') { score += 35_000; reasons.push('Strong source identity'); }
  else reasons.push('Context-only enrichment; monitoring identity is not strong enough for an automatic source query');
  if (['HIGH', 'CRITICAL'].includes(group.reviewRisk?.level)) { score += 8_000; reasons.push(`${group.reviewRisk.level} Review Risk`); }
  return { reasons, score };
}

function sourcePackage(source) {
  const sufficientOutcome = source.evidence?.length > 0
    && !['INSUFFICIENT_DATA', 'INSUFFICIENT_TELEMETRY', 'NO_CONFIRMED_JIRA_RELATIONSHIP', 'NO_RELEVANT_DISCUSSION'].includes(source.outcome?.code);
  return {
    adapter: source.adapter || null,
    applicable: source.sourceStatus !== 'not_applicable',
    confidence: source.confidence || { level: 'LOW', reasons: [] },
    coverage: source.coverage || 'UNAVAILABLE',
    evidence: source.evidence || [],
    evidenceState: source.evidenceState || null,
    evidenceDecisionState: sufficientOutcome ? 'EVIDENCE_SUFFICIENT' : 'EVIDENCE_INSUFFICIENT',
    executionTimeMs: Number(source.executionTimeMs || 0),
    failureReason: source.failureReason || null,
    diagnostics: source.diagnostics || null,
    matchedRecords: Number(source.matchedRecords ?? source.evidence?.length ?? 0),
    mappingQuality: source.mappingQuality || 'NONE',
    outcome: source.outcome || { code: 'INSUFFICIENT_TELEMETRY', detail: 'Evidence was unavailable.' },
    pipelineState: source.pipelineState || null,
    query: source.query || null,
    queryReuse: source.queryReuse || null,
    recordsReturned: Number(source.recordsReturned ?? source.evidence?.length ?? 0),
    status: source.sourceStatus || 'unavailable',
  };
}

function normalizedSources(validation) {
  const result = {
    operations: null,
    appDynamics: null,
    grafana: null,
    thousandEyes: null,
    nagios: null,
    jira: null,
    slack: null,
  };
  (validation?.sourceValidation?.sources || []).forEach((source) => {
    const key = SOURCE_KEYS[source.source];
    if (key) result[key] = sourcePackage(source);
  });
  return Object.fromEntries(Object.entries(result).map(([key, value]) => [key, value || {
    applicable: false,
    confidence: { level: 'LOW', reasons: ['Source was not applicable to this occurrence.'] },
    coverage: 'UNAVAILABLE',
    evidence: [],
    evidenceState: 'NOT_QUERIED',
    evidenceDecisionState: 'EVIDENCE_INSUFFICIENT',
    failureReason: 'SOURCE_NOT_APPLICABLE',
    diagnostics: null,
    matchedRecords: 0,
    mappingQuality: 'NONE',
    outcome: { code: 'NOT_APPLICABLE', detail: 'Source was not applicable to this occurrence.' },
    pipelineState: 'NOT_QUERIED',
    recordsReturned: 0,
    status: 'not_applicable',
  }]));
}

function evidenceStatusFor(validation, sources) {
  if (!validation || validation.execution?.evidenceTimedOut) return 'EVIDENCE_UNAVAILABLE';
  const applicable = Object.entries(sources).filter(([key, value]) => key !== 'operations' && value.applicable);
  if (applicable.some(([, value]) => value.status === 'error' || value.pipelineState === 'QUERY_FAILED')) return 'EVIDENCE_UNAVAILABLE';
  return 'ENRICHED';
}

function redactSafeText(value) {
  return cleanText(value)
    .replace(/(?:bearer|basic)\s+[a-z0-9._~+/=-]+/gi, '[REDACTED]')
    .replace(/(token|secret|password|credential|authorization)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]');
}

function createNoiseEvidenceEnrichmentService({
  config = NOISE_EVIDENCE_ENRICHMENT_CONFIG,
  actionability = actionabilityService,
  phase1 = phase1Service,
  identity = sourceIdentityService,
  validation = sourceValidationService,
  classify = classifyOccurrence,
  classifyGroup = classifyPattern,
  now = () => Date.now(),
} = {}) {
  const evidenceCache = new Map();
  const packagesByRange = new Map();
  const catalogCache = new Map();
  const actionabilitySnapshots = new Map();
  const auditLog = [];
  const batchHistory = [];
  let activeBatch = null;

  function rangePackages(range) {
    if (!packagesByRange.has(range)) packagesByRange.set(range, new Map());
    return packagesByRange.get(range);
  }

  function audit(event, data = {}) {
    const safe = Object.fromEntries(Object.entries(data).map(([key, value]) => [key, typeof value === 'string' ? redactSafeText(value) : value]));
    auditLog.push({ event, timestamp: new Date(now()).toISOString(), ...safe });
    if (auditLog.length > config.maxAuditEntries) auditLog.splice(0, auditLog.length - config.maxAuditEntries);
  }

  function recordActionabilitySnapshot(rangeValue, data, extra = {}) {
    const range = parseRange(rangeValue || data?.range);
    const overview = data?.actionabilityOverview || data?.overview || {};
    const previous = actionabilitySnapshots.get(range) || {};
    const snapshot = {
      ...previous,
      analysisVersion: data?.analysisVersion || previous.analysisVersion || null,
      cachedAt: data?.cachedAt || new Date(now()).toISOString(),
      overview: {
        actionable: Number(overview.actionable || 0),
        needsReview: Number(overview.needsReview || 0),
        nonActionable: Number(overview.nonActionable || 0),
        total: Number(overview.total || 0),
      },
      ...extra,
    };
    actionabilitySnapshots.set(range, snapshot);
    return snapshot;
  }

  async function loadAllActionabilityGroups(range) {
    const first = await actionability.list({ range, page: 1, size: 100 });
    const groups = [...(first.groups || [])];
    for (let page = 2; page <= Number(first.pagination?.totalPages || 1); page += 1) {
      const response = await actionability.list({ range, page, size: 100 });
      groups.push(...(response.groups || []));
    }
    recordActionabilitySnapshot(range, first);
    return { analysisVersion: first.analysisVersion, groups, overview: first.actionabilityOverview };
  }

  async function loadIdentityCoverage(range) {
    const first = await identity.getCoverage({ range, page: 1, size: 100 });
    const entities = [...(first.entities || [])];
    for (let page = 2; page <= Number(first.pagination?.totalPages || 1); page += 1) {
      const response = await identity.getCoverage({ range, page, size: 100 });
      entities.push(...(response.entities || []));
    }
    return entities;
  }

  async function buildCatalog(range, forceRefresh = false) {
    const cached = catalogCache.get(range);
    if (!forceRefresh && cached && now() - cached.cachedAtMs < config.cacheTtlMs) return { ...cached.value, cacheHit: true };
    const startedAt = now();
    const [{ analysisVersion, groups, overview }, entities] = await Promise.all([
      loadAllActionabilityGroups(range),
      loadIdentityCoverage(range),
    ]);
    const identityByGroup = new Map(entities.map((item) => [item.groupId, item]));
    const catalog = groups.map((group) => {
      const sourceIdentity = identityByGroup.get(group.groupId) || null;
      const mappings = acceptedMappings(sourceIdentity);
      const mappingLevel = bestMappingLevel(mappings);
      const priority = priorityFor(group, mappingLevel);
      return { group, sourceIdentity, mappings, mappingLevel, priority };
    }).sort((left, right) => right.priority.score - left.priority.score || left.group.groupId.localeCompare(right.group.groupId));
    const value = {
      analysisVersion,
      catalog,
      overview,
      eligibleForEnrichment: catalog.reduce((total, item) => total + Number(item.group.actionability?.distribution?.needsReview || 0), 0),
      sourceMappable: catalog.filter((item) => item.mappings.length).reduce((total, item) => total + Number(item.group.actionability?.distribution?.needsReview || 0), 0),
      executionTimeMs: Math.max(0, now() - startedAt),
    };
    recordActionabilitySnapshot(range, { analysisVersion, actionabilityOverview: overview }, {
      eligibleForEnrichment: value.eligibleForEnrichment,
      sourceMappable: value.sourceMappable,
    });
    catalogCache.set(range, { cachedAtMs: now(), value });
    return { ...value, cacheHit: false };
  }

  function candidateFingerprint(sourceIdentity, mappings, window) {
    const sourceEntities = mappings.map((item) => `${item.source}:${item.sourceEntityId || item.sourceEntityName}`).sort();
    const entity = sourceIdentity?.canonicalEntity?.entityId || 'context-only';
    return `${sourceEntities.join('|') || 'jira+slack'}:${entity}:${window.from}:${window.to}:actionability-evidence`;
  }

  async function candidatesForCatalog(catalogResult, options) {
    const selected = [];
    const stored = rangePackages(options.range);
    const requestedSource = canonical(options.source);
    const requestedOccurrenceIds = options.occurrenceIds ? new Set(options.occurrenceIds.map(String)) : null;
    for (const item of catalogResult.catalog) {
      if (selected.length >= options.batchSize) break;
      if (requestedSource && !item.mappings.some((mapping) => canonical(mapping.source) === requestedSource) && canonical(item.group.source) !== requestedSource) continue;
      const detail = await phase1.getGroup(item.group.groupId, { range: options.range });
      const baseline = classifyGroup(detail.group);
      const byId = new Map((detail.group.alerts || []).map((alert) => [alertId(alert), alert]));
      const unresolved = baseline.occurrences.filter((occurrence) => occurrence.classification === 'NEEDS_REVIEW');
      for (const occurrence of unresolved) {
        if (selected.length >= options.batchSize) break;
        if (requestedOccurrenceIds && !requestedOccurrenceIds.has(String(occurrence.canonicalOperationsId))) continue;
        const storedPackage = stored.get(occurrence.canonicalOperationsId);
        const currentPackage = storedPackage
          && storedPackage.analysisVersion === (detail.analysisVersion || catalogResult.analysisVersion)
          && storedPackage.evidenceVersion === config.enrichmentModelVersion
          && storedPackage.classificationVersion === config.actionabilityModelVersion;
        if (!options.forceRefresh && currentPackage) continue;
        const alert = byId.get(occurrence.canonicalOperationsId);
        const window = buildBoundedWindow(alert, options.windowConfig || config, now());
        if (!alert || !window) continue;
        const queryFingerprint = candidateFingerprint(item.sourceIdentity, item.mappings, window);
        selected.push({
          alert,
          analysisVersion: detail.analysisVersion || catalogResult.analysisVersion,
          before: occurrence,
          group: detail.group,
          groupId: item.group.groupId,
          mappings: item.mappings,
          mappingLevel: item.mappingLevel,
          occurrenceId: occurrence.canonicalOperationsId,
          priority: item.priority,
          queryFingerprint,
          sourceIdentity: item.sourceIdentity,
          window,
        });
      }
    }
    return selected;
  }

  function cacheKey(candidate) {
    return `${candidate.queryFingerprint}:${candidate.analysisVersion || 'unknown-analysis'}:${config.enrichmentModelVersion}:${config.actionabilityModelVersion}`;
  }

  function packageFromFailure(candidate, error, startedAt) {
    const sources = normalizedSources(null);
    const reasons = unique([...candidate.before.reasons, error.code === 'SOURCE_VALIDATION_CANCELLED' ? 'Evidence enrichment was cancelled.' : 'Bounded source evidence was unavailable; the occurrence remains Needs Review.']);
    const after = {
      ...candidate.before,
      classificationSource: 'PHASE_3_1_ENRICHMENT',
      classificationVersion: config.actionabilityModelVersion,
      classifiedAt: new Date(now()).toISOString(),
      evidenceBasis: 'NEEDS_REVIEW',
      evidenceBasisLabel: 'Needs review',
      evidenceState: 'EVIDENCE_UNAVAILABLE',
      classificationReasons: reasons,
      reasons,
    };
    return {
      analysisVersion: candidate.analysisVersion || null,
      alertId: candidate.occurrenceId,
      alertNumber: alertNumber(candidate.alert) || null,
      patternId: candidate.groupId,
      pattern: candidate.group.pattern,
      identity: candidate.sourceIdentity?.canonicalEntity || null,
      sourceMapping: { level: candidate.mappingLevel, mappings: candidate.mappings },
      investigationWindow: candidate.window,
      sources,
      evidenceCoverage: after.coverage,
      evidenceStatus: 'EVIDENCE_UNAVAILABLE',
      actionabilityBefore: candidate.before,
      actionabilityAfter: after,
      previousClassification: candidate.before.classification,
      newClassification: after.classification,
      reclassification: { changed: false, reasons: after.reasons },
      confidence: after.confidence,
      sourceEvidenceConfidence: Object.fromEntries(Object.entries(sources).map(([key, value]) => [key, value.confidence.level])),
      reasons: after.reasons,
      collectedAt: new Date(now()).toISOString(),
      sourceData: candidate.window.open ? 'Live' : 'Historical',
      modelVersion: config.enrichmentModelVersion,
      evidenceVersion: config.enrichmentModelVersion,
      classificationVersion: config.actionabilityModelVersion,
      cache: { status: 'MISS', hit: false, ttlMs: config.cacheTtlMs },
      diagnostics: { executionTimeMs: Math.max(0, now() - startedAt), externalApiCallCount: 0, requestsAvoided: 0, safeError: redactSafeText(error.safeMessage || error.message || 'Evidence unavailable.') },
      externalMutations: 'none',
    };
  }

  async function enrichCandidate(candidate, options) {
    const key = cacheKey(candidate);
    const cached = evidenceCache.get(key);
    if (!options.forceRefresh && cached && now() - cached.cachedAtMs < config.cacheTtlMs) {
      audit('evidence_cache_hit', { alertId: candidate.occurrenceId, patternId: candidate.groupId });
      const value = { ...cached.value, cache: { ...cached.value.cache, hit: true, status: 'HIT' }, diagnostics: { ...cached.value.diagnostics, externalApiCallCount: 0, requestsAvoided: Math.max(1, cached.value.diagnostics.externalApiCallCount) } };
      rangePackages(options.range).set(candidate.occurrenceId, value);
      return value;
    }
    const startedAt = now();
    audit('enrichment_started', { alertId: candidate.occurrenceId, patternId: candidate.groupId });
    try {
      if (options.signal?.aborted) throw safeError('Evidence enrichment was cancelled.', 'SOURCE_VALIDATION_CANCELLED', 499);
      const sourceValidation = await validation.investigate(candidate.groupId, {
        afterMinutes: options.windowConfig?.afterMinutes || config.afterMinutes,
        beforeMinutes: options.windowConfig?.beforeMinutes || config.beforeMinutes,
        occurrenceId: candidate.occurrenceId,
        range: options.range,
        refresh: options.forceRefresh,
        scope: 'occurrence',
        signal: options.signal,
        strictIdentity: true,
      });
      const after = classify({
        alert: candidate.alert,
        group: candidate.group,
        sourceValidation,
        classifiedAt: new Date(now()).toISOString(),
        classificationSource: 'PHASE_3_1_ENRICHMENT',
      });
      const sources = normalizedSources(sourceValidation);
      const evidenceStatus = evidenceStatusFor(sourceValidation, sources);
      const evidenceCount = Object.entries(sources).filter(([key]) => key !== 'operations').reduce((total, [, source]) => total + source.evidence.length, 0);
      const applicableSources = Object.entries(sources).filter(([key, source]) => key !== 'operations' && source.applicable);
      const evidenceCacheHit = sourceValidation.execution?.evidenceCacheHit === true;
      const externalApiCallCount = evidenceCacheHit ? 0 : Number(sourceValidation.execution?.externalSourceOperations || 0);
      const requestsAvoided = evidenceCacheHit ? Number(sourceValidation.execution?.externalSourceOperations || applicableSources.length) : 0;
      const highNoise = Number(candidate.group.noiseLikelihood ?? candidate.group.noiseScore ?? 0) >= config.highNoiseThreshold;
      const allowedRisk = candidate.group.reviewRisk?.level !== 'CRITICAL';
      const intersection = {
        highNoise,
        highConfidenceNoiseCandidate: after.classification === 'NON_ACTIONABLE' && after.confidence === 'HIGH' && highNoise && allowedRisk,
        potentiallyReducible: after.classification === 'NON_ACTIONABLE' && after.confidence === 'HIGH' && highNoise && allowedRisk,
      };
      const value = {
        analysisVersion: candidate.analysisVersion || null,
        alertId: candidate.occurrenceId,
        alertNumber: alertNumber(candidate.alert) || null,
        patternId: candidate.groupId,
        pattern: candidate.group.pattern,
        identity: sourceValidation.sourceIdentity?.canonicalEntity || candidate.sourceIdentity?.canonicalEntity || null,
        sourceMapping: { level: candidate.mappingLevel, mappings: candidate.mappings },
        investigationWindow: candidate.window,
        sources,
        evidenceCoverage: after.coverage,
        evidenceStatus,
        evidenceDecisionState: candidate.before.classification !== after.classification ? 'EVIDENCE_SUFFICIENT' : 'EVIDENCE_INSUFFICIENT',
        evidenceCollected: evidenceCount > 0,
        actionabilityBefore: candidate.before,
        actionabilityAfter: { ...after, intersection },
        previousClassification: candidate.before.classification,
        newClassification: after.classification,
        reclassification: {
          before: candidate.before.classification,
          after: after.classification,
          changed: candidate.before.classification !== after.classification,
          confidence: after.confidence,
          evidenceBasis: after.evidenceBasis || evidenceStatus,
          reasons: after.reasons,
          collectedAt: new Date(now()).toISOString(),
          sourceTimestamps: Object.values(sources).flatMap((source) => source.evidence || []).map((item) => item.timestamp).filter(Boolean).sort(),
        },
        confidence: after.confidence,
        sourceEvidenceConfidence: Object.fromEntries(Object.entries(sources).map(([source, detail]) => [source, detail.confidence.level])),
        reasons: after.reasons,
        crossSource: sourceValidation.sourceValidation?.crossSourceConsistency || null,
        collectedAt: new Date(now()).toISOString(),
        sourceData: candidate.window.open ? 'Live' : 'Historical',
        modelVersion: config.enrichmentModelVersion,
        evidenceVersion: config.enrichmentModelVersion,
        classificationVersion: config.actionabilityModelVersion,
        cache: { status: 'MISS', hit: false, ttlMs: config.cacheTtlMs },
        diagnostics: {
          executionTimeMs: Math.max(0, now() - startedAt),
          externalApiCallCount,
          requestsAvoided,
          evidenceCacheHit,
          applicableSources: applicableSources.map(([source]) => source),
          evidenceRecords: evidenceCount,
        },
        externalMutations: 'none',
      };
      evidenceCache.set(key, { cachedAtMs: now(), value });
      rangePackages(options.range).set(candidate.occurrenceId, value);
      applicableSources.forEach(([source, detail]) => audit(detail.status === 'error' ? 'source_failed' : 'source_queried', { alertId: candidate.occurrenceId, patternId: candidate.groupId, source, status: detail.status }));
      if (value.reclassification.changed) audit('classification_changed', { alertId: candidate.occurrenceId, from: value.previousClassification, patternId: candidate.groupId, to: value.newClassification });
      audit('enrichment_completed', { alertId: candidate.occurrenceId, classification: value.newClassification, patternId: candidate.groupId, status: value.evidenceStatus });
      return value;
    } catch (error) {
      if (error.code === 'SOURCE_VALIDATION_CANCELLED') throw error;
      const value = packageFromFailure(candidate, error, startedAt);
      evidenceCache.set(key, { cachedAtMs: now(), value });
      rangePackages(options.range).set(candidate.occurrenceId, value);
      audit('source_failed', { alertId: candidate.occurrenceId, patternId: candidate.groupId, status: value.evidenceStatus });
      audit('enrichment_completed', { alertId: candidate.occurrenceId, classification: value.newClassification, patternId: candidate.groupId, status: value.evidenceStatus });
      return value;
    }
  }

  async function processCandidates(candidates, options) {
    const grouped = [...candidates.reduce((map, candidate) => {
      const items = map.get(candidate.groupId) || [];
      items.push(candidate);
      map.set(candidate.groupId, items);
      return map;
    }, new Map()).values()];
    const resultsByGroup = await mapWithConcurrency(grouped, config.maxConcurrentOperations, async (items) => {
      const results = [];
      for (const candidate of items) results.push(await enrichCandidate(candidate, options));
      return results;
    });
    return resultsByGroup.flat();
  }

  function summarizeBatch(records, metadata, startedAt) {
    const durations = records.map((item) => item.diagnostics.executionTimeMs);
    const evidenceCollected = records.filter((item) => item.evidenceStatus === 'ENRICHED').length;
    const result = {
      batchId: `enrichment-${startedAt}`,
      range: metadata.range,
      queued: metadata.queued,
      completed: records.length,
      needsReviewBefore: records.length,
      evidenceCollected,
      evidenceUnavailable: records.filter((item) => item.evidenceStatus === 'EVIDENCE_UNAVAILABLE').length,
      reclassifiedActionable: records.filter((item) => item.newClassification === 'ACTIONABLE').length,
      reclassifiedNonActionable: records.filter((item) => item.newClassification === 'NON_ACTIONABLE').length,
      stillNeedsReview: records.filter((item) => item.newClassification === 'NEEDS_REVIEW').length,
      cacheHits: records.filter((item) => item.cache.hit).length,
      externalApiCallCount: records.reduce((total, item) => total + item.diagnostics.externalApiCallCount, 0),
      requestsAvoided: records.reduce((total, item) => total + item.diagnostics.requestsAvoided, 0),
      performance: {
        averageEvidenceTimeMs: durations.length ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length) : 0,
        p50Ms: percentile(durations, 0.5),
        p95Ms: percentile(durations, 0.95),
        totalTimeMs: Math.max(0, now() - startedAt),
      },
      records,
      actionabilityReconciliation: records.length === records.filter((item) => ['ACTIONABLE', 'NON_ACTIONABLE', 'NEEDS_REVIEW'].includes(item.newClassification)).length,
      maxConcurrentOperations: config.maxConcurrentOperations,
      externalMutations: 'none',
      automaticSuppression: 'none',
      aiUsed: false,
    };
    batchHistory.push({ ...result, records: undefined });
    if (batchHistory.length > 20) batchHistory.shift();
    return result;
  }

  async function enrichBatch(options = {}) {
    if (activeBatch) throw safeError('An evidence-enrichment batch is already running.', 'ENRICHMENT_ALREADY_RUNNING', 409);
    const range = parseRange(options.range);
    const batchSize = parseBatchSize(options.batchSize, config);
    const forceRefresh = parseBoolean(options.forceRefresh);
    const windowConfig = {
      ...config,
      afterMinutes: parseWindowMinutes(options.afterMinutes, config.afterMinutes),
      beforeMinutes: parseWindowMinutes(options.beforeMinutes, config.beforeMinutes),
    };
    const startedAt = now();
    activeBatch = { range, batchSize, startedAt: new Date(startedAt).toISOString(), status: 'RUNNING' };
    try {
      const catalog = await buildCatalog(range, forceRefresh);
      const candidates = await candidatesForCatalog(catalog, { batchSize, forceRefresh, range, source: options.source, windowConfig });
      activeBatch.queued = candidates.length;
      activeBatch.mergedWindows = mergeOverlappingWindows(candidates).length;
      const records = await processCandidates(candidates, { forceRefresh, range, signal: options.signal, windowConfig });
      return summarizeBatch(records, { queued: candidates.length, range }, startedAt);
    } finally {
      activeBatch = null;
    }
  }

  async function enrichOccurrences(options = {}) {
    if (activeBatch) throw safeError('An evidence-enrichment batch is already running.', 'ENRICHMENT_ALREADY_RUNNING', 409);
    const range = parseRange(options.range);
    const batchSize = parseBatchSize(options.batchSize, config);
    const occurrenceIds = [...new Set((options.occurrenceIds || []).map(String).filter(Boolean))].slice(0, batchSize);
    if (!occurrenceIds.length) return summarizeBatch([], { queued: 0, range }, now());
    const forceRefresh = parseBoolean(options.forceRefresh);
    const windowConfig = {
      ...config,
      afterMinutes: parseWindowMinutes(options.afterMinutes, config.afterMinutes),
      beforeMinutes: parseWindowMinutes(options.beforeMinutes, config.beforeMinutes),
    };
    const startedAt = now();
    activeBatch = { range, batchSize, startedAt: new Date(startedAt).toISOString(), status: 'RUNNING', occurrenceIds };
    try {
      const catalog = await buildCatalog(range, forceRefresh);
      const candidates = await candidatesForCatalog(catalog, { batchSize, forceRefresh, occurrenceIds, range, source: options.source, windowConfig });
      activeBatch.queued = candidates.length;
      activeBatch.mergedWindows = mergeOverlappingWindows(candidates).length;
      const records = await processCandidates(candidates, { forceRefresh, range, signal: options.signal, windowConfig });
      return summarizeBatch(records, { queued: candidates.length, range }, startedAt);
    } finally {
      activeBatch = null;
    }
  }

  async function enrichGroup(groupId, options = {}) {
    const id = cleanText(groupId);
    if (!/^[a-f0-9]{24}$/.test(id)) throw safeError('A valid analysis group ID is required.', 'INVALID_NOISE_GROUP_ID');
    if (activeBatch) throw safeError('An evidence-enrichment batch is already running.', 'ENRICHMENT_ALREADY_RUNNING', 409);
    const range = parseRange(options.range);
    const batchSize = parseBatchSize(options.batchSize, config);
    const forceRefresh = parseBoolean(options.forceRefresh);
    const windowConfig = {
      ...config,
      afterMinutes: parseWindowMinutes(options.afterMinutes, config.afterMinutes),
      beforeMinutes: parseWindowMinutes(options.beforeMinutes, config.beforeMinutes),
    };
    const startedAt = now();
    activeBatch = { groupId: id, range, batchSize, startedAt: new Date(startedAt).toISOString(), status: 'RUNNING' };
    try {
      const detail = await phase1.getGroup(id, { range });
      const sourceIdentity = await identity.resolveGroup(detail.group, { refresh: forceRefresh });
      const mappings = acceptedMappings(sourceIdentity);
      const mappingLevel = bestMappingLevel(mappings);
      const priority = priorityFor(detail.group, mappingLevel);
      const baseline = classifyGroup(detail.group);
      const byId = new Map((detail.group.alerts || []).map((alert) => [alertId(alert), alert]));
      const candidates = baseline.occurrences.filter((occurrence) => occurrence.classification === 'NEEDS_REVIEW').slice(0, batchSize).flatMap((occurrence) => {
        const alert = byId.get(occurrence.canonicalOperationsId);
        const window = buildBoundedWindow(alert, windowConfig, now());
        if (!alert || !window) return [];
        return [{
          alert, analysisVersion: detail.analysisVersion, before: occurrence, group: detail.group, groupId: id, mappings, mappingLevel,
          occurrenceId: occurrence.canonicalOperationsId, priority, sourceIdentity, window,
          queryFingerprint: candidateFingerprint(sourceIdentity, mappings, window),
        }];
      });
      activeBatch.queued = candidates.length;
      const records = await processCandidates(candidates, { forceRefresh, range, signal: options.signal, windowConfig });
      return summarizeBatch(records, { queued: candidates.length, range }, startedAt);
    } finally {
      activeBatch = null;
    }
  }

  function packagesFor(range, filters = {}, analysisVersion = null) {
    const state = String(filters.evidenceState || 'all').toUpperCase();
    const source = canonical(filters.source);
    return [...rangePackages(range).values()].filter((item) => (
      (!analysisVersion || item.analysisVersion === analysisVersion)
      && item.evidenceVersion === config.enrichmentModelVersion
      && item.classificationVersion === config.actionabilityModelVersion
      && (state === 'ALL' || item.evidenceStatus === state)
      && (!source || Object.entries(item.sources).some(([key, detail]) => canonical(key) === source && detail.applicable))
    ));
  }

  async function getStatus(options = {}) {
    const range = parseRange(options.range);
    const snapshot = actionabilitySnapshots.get(range) || {
      analysisVersion: null,
      cachedAt: null,
      eligibleForEnrichment: 0,
      overview: { actionable: 0, needsReview: 0, nonActionable: 0, total: 0 },
      sourceMappable: 0,
    };
    const records = packagesFor(range, options, snapshot.analysisVersion);
    const allRecords = packagesFor(range, {}, snapshot.analysisVersion);
    const baseline = snapshot.overview;
    const movedActionable = allRecords.filter((item) => item.previousClassification === 'NEEDS_REVIEW' && item.newClassification === 'ACTIONABLE').length;
    const movedNonActionable = allRecords.filter((item) => item.previousClassification === 'NEEDS_REVIEW' && item.newClassification === 'NON_ACTIONABLE').length;
    const evidenceCollected = allRecords.filter((item) => item.evidenceStatus === 'ENRICHED').length;
    const evidenceUnavailable = allRecords.filter((item) => item.evidenceStatus === 'EVIDENCE_UNAVAILABLE').length;
    const durations = allRecords.map((item) => item.diagnostics.executionTimeMs);
    const sources = ['appDynamics', 'grafana', 'thousandEyes', 'nagios', 'jira', 'slack'];
    const sourceCoverage = Object.fromEntries(sources.map((source) => {
      const applicable = allRecords.filter((item) => item.sources[source]?.applicable);
      const withEvidence = applicable.filter((item) => item.sources[source]?.evidence?.length);
      const unavailable = applicable.filter((item) => item.sources[source]?.status === 'error');
      return [source, { applicable: applicable.length, evidenceCollected: withEvidence.length, unavailable: unavailable.length, coveragePercentage: applicable.length ? Number((withEvidence.length / applicable.length * 100).toFixed(1)) : 0 }];
    }));
    const summary = {
      total: baseline.total,
      actionable: baseline.actionable + movedActionable,
      nonActionable: baseline.nonActionable + movedNonActionable,
      needsReview: Math.max(0, baseline.needsReview - movedActionable - movedNonActionable),
    };
    const cacheHits = allRecords.filter((item) => item.cache.hit).length;
    const evidenceCoverage = allRecords.length ? Number((evidenceCollected / allRecords.length * 100).toFixed(1)) : 0;
    const lastRunAt = allRecords.map((item) => item.collectedAt).filter(Boolean).sort().at(-1) || snapshot.cachedAt || null;
    return {
      phase: '3.1',
      range,
      modelVersion: config.enrichmentModelVersion,
      activeBatch,
      needsReviewBefore: baseline.needsReview,
      eligibleForEnrichment: Number(snapshot.eligibleForEnrichment ?? baseline.needsReview),
      sourceMappable: Number(snapshot.sourceMappable || 0),
      alreadyEnriched: allRecords.length,
      attempted: allRecords.length,
      enriched: evidenceCollected,
      evidenceUnavailable,
      reclassifiedActionable: movedActionable,
      reclassifiedNonActionable: movedNonActionable,
      actionableReclassified: movedActionable,
      nonActionableReclassified: movedNonActionable,
      stillNeedsReview: summary.needsReview,
      sufficientEvidence: movedActionable + movedNonActionable,
      actionabilitySummary: summary,
      actionabilityReconciliation: summary.actionable + summary.nonActionable + summary.needsReview === summary.total,
      evidenceCoverage,
      evidenceCoveragePercentage: evidenceCoverage,
      cacheHits,
      cacheMisses: Math.max(0, allRecords.length - cacheHits),
      lastRunAt,
      baselineAvailable: Boolean(snapshot.analysisVersion || baseline.total),
      analysisVersion: snapshot.analysisVersion,
      evidenceVersion: config.enrichmentModelVersion,
      classificationVersion: config.actionabilityModelVersion,
      sourceCoverage,
      performance: {
        averageEvidenceTimeMs: durations.length ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length) : 0,
        p50Ms: percentile(durations, 0.5),
        p95Ms: percentile(durations, 0.95),
        cacheHitRate: allRecords.length ? Number((allRecords.filter((item) => item.cache.hit).length / allRecords.length * 100).toFixed(1)) : 0,
        externalApiCallCount: allRecords.reduce((total, item) => total + item.diagnostics.externalApiCallCount, 0),
        requestsAvoided: allRecords.reduce((total, item) => total + item.diagnostics.requestsAvoided, 0),
        maxConcurrentOperations: config.maxConcurrentOperations,
      },
      records,
      batchHistory,
      audit: { entries: auditLog.length, latest: auditLog.slice(-20) },
      readOnlySources: true,
      localStateOnly: true,
      externalMutations: 'none',
      automaticSuppression: 'none',
      aiUsed: false,
    };
  }

  async function prepareStatus(options = {}) {
    const range = parseRange(options.range);
    await buildCatalog(range, parseBoolean(options.refresh));
    return getStatus({ ...options, range });
  }

  async function getGroupEvidence(groupId, options = {}) {
    const id = cleanText(groupId);
    if (!/^[a-f0-9]{24}$/.test(id)) throw safeError('A valid analysis group ID is required.', 'INVALID_NOISE_GROUP_ID');
    const range = parseRange(options.range);
    const detail = await phase1.getGroup(id, { range });
    const occurrenceIds = new Set((detail.group?.alerts || []).map((alert) => alertId(alert)).filter(Boolean));
    const records = packagesFor(range, {}, detail.analysisVersion).filter((item) => item.patternId === id || occurrenceIds.has(item.alertId)).sort((left, right) => toMs(right.collectedAt) - toMs(left.collectedAt));
    const before = { actionable: 0, nonActionable: 0, needsReview: records.length };
    const after = {
      actionable: records.filter((item) => item.newClassification === 'ACTIONABLE').length,
      nonActionable: records.filter((item) => item.newClassification === 'NON_ACTIONABLE').length,
      needsReview: records.filter((item) => item.newClassification === 'NEEDS_REVIEW').length,
    };
    return {
      phase: '3.1', groupId: id, range, before, after, records,
      reclassifiedActionable: after.actionable,
      reclassifiedNonActionable: after.nonActionable,
      stillNeedsReview: after.needsReview,
      evidenceUnavailable: records.filter((item) => item.evidenceStatus === 'EVIDENCE_UNAVAILABLE').length,
      actionabilityReconciliation: after.actionable + after.nonActionable + after.needsReview === records.length,
      externalMutations: 'none',
    };
  }

  function getOverrides(rangeValue, analysisVersion = null) {
    const range = parseRange(rangeValue);
    return new Map(packagesFor(range, {}, analysisVersion).filter((item) => (
      item.actionabilityAfter
      && typeof item.actionabilityAfter === 'object'
      && item.actionabilityAfter.coverage?.crossSource
      && ['ACTIONABLE', 'NON_ACTIONABLE', 'NEEDS_REVIEW'].includes(item.actionabilityAfter.classification)
    )).map((item) => [item.alertId, {
      ...item.actionabilityAfter,
      enrichment: {
        collectedAt: item.collectedAt,
        evidenceModelVersion: item.evidenceModelVersion || item.evidenceVersion,
        evidenceStatus: item.evidenceStatus,
        identity: item.identity || null,
        investigationWindow: item.investigationWindow || null,
        previousClassification: item.previousClassification,
        reclassified: item.reclassification.changed,
        sourceMapping: item.sourceMapping || null,
        sourceData: item.sourceData,
        sources: Object.entries(item.sources).filter(([, source]) => source.applicable).map(([source]) => source),
      },
    }]));
  }

  function importPackages(rangeValue, records = []) {
    const range = parseRange(rangeValue);
    const stored = rangePackages(range);
    let imported = 0;
    records.forEach((record) => {
      if (!record?.alertId || record.evidenceVersion !== config.enrichmentModelVersion || record.classificationVersion !== config.actionabilityModelVersion) return;
      const value = {
        ...record,
        cacheAge: Math.max(0, Date.now() - (new Date(record.collectedAt).getTime() || Date.now())),
        freshnessStatus: record.investigationWindow?.open ? 'CURRENT_WINDOW' : 'HISTORICAL_WINDOW',
        cache: { ...(record.cache || {}), hit: true, status: 'PERSISTED' },
        diagnostics: {
          ...(record.diagnostics || {}),
          externalApiCallCount: 0,
          requestsAvoided: Math.max(1, Number(record.diagnostics?.requestsAvoided || record.diagnostics?.externalApiCallCount || 1)),
        },
      };
      stored.set(value.alertId, value);
      imported += 1;
    });
    return imported;
  }

  return { enrichBatch, enrichGroup, enrichOccurrences, getGroupEvidence, getOverrides, getStatus, importPackages, prepareStatus, recordActionabilitySnapshot };
}

module.exports = {
  acceptedMappings,
  buildBoundedWindow,
  createNoiseEvidenceEnrichmentService,
  mergeOverlappingWindows,
  priorityFor,
  redactSafeText,
  service: createNoiseEvidenceEnrichmentService(),
};
