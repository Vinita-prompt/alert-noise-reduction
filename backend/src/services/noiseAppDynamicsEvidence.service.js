const { service: actionabilityService } = require('./noiseActionability.service');
const { service: acquisitionService } = require('./noiseEvidenceAcquisition.service');
const { buildBoundedWindow, service: enrichmentService } = require('./noiseEvidenceEnrichment.service');
const { service: operationalSignalService } = require('./noiseOperationalSignal.service');
const { service: sourceIdentityService } = require('./sourceIdentity.service');
const { service: decisionPolicyService } = require('./noiseAppDynamicsDecisionPolicy.service');
const { AppDynamicsEvidenceAdapter, appDynamicsMetricIntent, normalizeOperationsAlert } = require('./sourceEvidenceAdapters.service');
const {
  AUDIT_SCHEMA_VERSION,
  PHASE: FOLLOW_UP_PHASE,
  auditStatus,
  createFollowUpStore,
  diagnoseResult,
  summarizeAudit,
  validateReplay,
} = require('./noiseAppDynamicsFollowUp.service');

const RANGE = '24h';
const SOURCE = 'AppDynamics';
const CLASSIFICATIONS = [
  'USEFUL_ACTIONABLE_SIGNAL',
  'REDUNDANT_REAL_EVENT_NOTIFICATION',
  'NON_ACTIONABLE_NOISE',
  'NEEDS_REVIEW',
];
const MAPPING_RANK = Object.freeze({ CONFIRMED_LOCAL: 6, EXACT: 5, STRONG: 4, CANDIDATE: 3, STALE_MAPPING: 2, NONE: 1 });

function cleanText(value) {
  return String(value ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function canonical(value) {
  return cleanText(value).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function unique(values) {
  return [...new Set(values.filter(Boolean).map(cleanText).filter(Boolean))];
}

function alertId(alert) {
  return cleanText(alert?.id || alert?.canonicalOperationsId || alert?.externalId);
}

function isAppDynamics(value) {
  const source = canonical(value).replace('dynamics', 'd');
  return source === 'appd' || source.includes('appd');
}

function appDynamicsAlert(alert, group) {
  return isAppDynamics(alert?.source || alert?.sourceSystem || alert?.integrationName || group?.source)
    || /^\s*\[appd(?:ynamics)?\]/i.test(cleanText(alert?.title || alert?.message));
}

function nestedValues(value, pattern, depth = 0, result = []) {
  if (!value || depth > 6 || result.length >= 40) return result;
  if (Array.isArray(value)) {
    value.forEach((item) => nestedValues(item, pattern, depth + 1, result));
    return result;
  }
  if (typeof value !== 'object') return result;
  Object.entries(value).forEach(([key, item]) => {
    if (pattern.test(key) && ['string', 'number'].includes(typeof item) && cleanText(item)) result.push(cleanText(item));
    if (item && typeof item === 'object') nestedValues(item, pattern, depth + 1, result);
  });
  return result;
}

function firstStructured(alert, pattern, direct = []) {
  return unique([...direct, ...nestedValues(alert?.sourceDetails, pattern), ...nestedValues(alert?.sourceIdentifiers, pattern), ...nestedValues(alert?.extraProperties, pattern)])[0] || null;
}

function sourceMetadata(alert) {
  return {
    applicationId: firstStructured(alert, /^(application.?id|app.?id)$/i),
    application: firstStructured(alert, /^(application|application.?name|app.?name)$/i, [alert?.application]),
    service: firstStructured(alert, /^(service|service.?name)$/i, [alert?.service]),
    tier: firstStructured(alert, /^(tier|tier.?name)$/i),
    node: firstStructured(alert, /^(node|node.?name|host|hostname)$/i, [alert?.host, alert?.hostname]),
    businessTransaction: firstStructured(alert, /business.?transaction/i),
    healthRule: firstStructured(alert, /health.?rule/i),
    metric: firstStructured(alert, /^(metric|metric.?name)$/i),
    environment: firstStructured(alert, /^(environment|env)$/i, [alert?.environment]),
  };
}

function highestMapping(mappings = []) {
  return [...mappings].sort((left, right) => (MAPPING_RANK[right.level] || 0) - (MAPPING_RANK[left.level] || 0) || Number(right.score || 0) - Number(left.score || 0))[0] || null;
}

function publicMappingCandidate(mapping) {
  return {
    sourceEntityId: mapping.sourceEntityId || null,
    sourceEntityName: mapping.sourceEntityName || null,
    sourceEntityType: mapping.sourceEntityType || null,
    applicationId: mapping.metadata?.applicationId || null,
    environment: mapping.environment || null,
    level: mapping.level || 'NONE',
    score: Number(mapping.score || 0),
    reasons: mapping.reasons || [],
  };
}

function mappingBlock(metadata, candidates = [], conflicts = [], pattern = '') {
  if (conflicts.length) return { code: 'MAPPING_CONFLICT', reason: 'Accepted source identities contain a deterministic environment or entity conflict.' };
  if (/business.?transaction|\bbt\b/i.test(pattern) && !metadata.businessTransaction) {
    return { code: 'BT_IDENTITY_UNAVAILABLE', reason: 'The alert names a Business Transaction condition but does not provide a Business Transaction name or ID.' };
  }
  const active = candidates.filter((item) => item.level !== 'NONE' && item.rejected !== true);
  if (active.length) return { code: 'CANDIDATE_ONLY_MAPPING', reason: active.length > 1
    ? 'Multiple AppDynamics inventory candidates remain and no unique exact identity is available.'
    : 'The inventory candidate is based on partial identity only and cannot be promoted safely.' };
  if (![metadata.applicationId, metadata.application, metadata.service, metadata.tier, metadata.node, metadata.businessTransaction].some(Boolean)) {
    return { code: 'INSUFFICIENT_IDENTITY', reason: 'Operations did not provide an application, service, tier, node, Business Transaction, or source entity ID.' };
  }
  return { code: 'NO_INVENTORY_MATCH', reason: 'No exact AppDynamics inventory entity matched the structured Operations identity.' };
}

function identityCompletionReport(patterns = [], alerts = []) {
  const unresolvedPatterns = patterns.filter((item) => !item.mapping.accepted);
  const unresolvedOccurrences = alerts.filter((item) => item.classification === 'NEEDS_REVIEW' && !item.mapping.accepted);
  const blockCount = (code) => unresolvedPatterns.filter((item) => item.mappingBlocked?.code === code).length;
  return {
    totalUnmappedOccurrences: unresolvedOccurrences.length,
    distinctUnmappedIdentityPatterns: unresolvedPatterns.length,
    patternsDeterministicallyResolved: patterns.filter((item) => item.mapping.accepted && item.mapping.mappingMechanism === 'deterministic_inventory_match').length,
    patternsCandidateOnly: blockCount('CANDIDATE_ONLY_MAPPING'),
    patternsWithoutInventoryMatch: blockCount('NO_INVENTORY_MATCH'),
    patternsWithConflicts: blockCount('MAPPING_CONFLICT'),
    patternsWithInsufficientIdentity: blockCount('INSUFFICIENT_IDENTITY') + blockCount('BT_IDENTITY_UNAVAILABLE'),
    patterns: unresolvedPatterns.map((item) => ({
      pattern: item.pattern, occurrences: item.occurrences, operationsIdentity: item.operationsIdentity,
      candidateEntities: item.candidateEntities, candidateConfidence: item.mapping.level,
      blockedCode: item.mappingBlocked?.code || 'OTHER', blockedReason: item.mappingBlocked?.reason || 'Identity evidence is insufficient.',
    })),
    reconciliation: unresolvedPatterns.reduce((sum, item) => sum + item.classification.needsReview, 0) === unresolvedOccurrences.length,
  };
}

function classificationCounts(items, getter = (item) => item.classification) {
  const counts = Object.fromEntries(CLASSIFICATIONS.map((classification) => [classification, 0]));
  items.forEach((item) => {
    const classification = getter(item);
    counts[CLASSIFICATIONS.includes(classification) ? classification : 'NEEDS_REVIEW'] += 1;
  });
  return {
    total: items.length,
    usefulActionableSignals: counts.USEFUL_ACTIONABLE_SIGNAL,
    redundantRealEventNotifications: counts.REDUNDANT_REAL_EVENT_NOTIFICATION,
    nonActionableNoise: counts.NON_ACTIONABLE_NOISE,
    needsReview: counts.NEEDS_REVIEW,
    reconciliation: Object.values(counts).reduce((sum, value) => sum + value, 0) === items.length,
  };
}

function queryOutcome(source) {
  if (!source?.applicable) return 'NOT_QUERIED';
  if (source.pipelineState === 'RECORDS_FOUND' || Number(source.recordsReturned || 0) > 0) return 'RECORDS_FOUND';
  return source.failureReason || source.pipelineState || 'NO_RECORDS_IN_WINDOW';
}

function safeEvidencePackage(record) {
  const source = record.sources?.appDynamics;
  const sourceEvidenceCount = Number(source?.recordsReturned || source?.evidence?.length || 0);
  const sourceQueries = (Array.isArray(source?.query) ? source.query : [source?.query]).filter((item) => item && typeof item === 'object');
  const safeQueries = sourceQueries.map(({ rawRecords: _rawRecords, normalizedRecords: _normalizedRecords, ...query }) => query);
  const adapterCacheHits = sourceQueries.filter((query) => query.reuse?.cacheHit === true).length;
  const reportedReuse = source?.queryReuse || source?.diagnostics?.queryReuse || {};
  return {
    alertId: record.alertId,
    alertNumber: record.alertNumber || null,
    patternId: record.patternId,
    collectedAt: record.collectedAt,
    classificationBefore: record.previousClassification,
    classificationAfter: record.newClassification,
    classificationReason: record.classificationReason || record.reasons || [],
    evidenceStatus: record.evidenceStatus,
    evidenceSufficiency: record.evidenceDecisionState || record.pipelineDecisionState,
    investigationWindow: record.investigationWindow,
    mapping: record.mapping || record.sourceMapping || null,
    telemetry: record.telemetry || (source?.applicable ? {
      records: sourceEvidenceCount,
      requested: Number(source?.diagnostics?.queriesRequested || 0),
      returned: sourceEvidenceCount,
    } : null),
    queryOutcome: queryOutcome(source),
    query: Array.isArray(source?.query) ? safeQueries : safeQueries[0] || null,
    queryReuse: sourceQueries.length ? {
      ...reportedReuse,
      cacheHit: adapterCacheHits > 0 || reportedReuse.cacheHit === true,
      cacheHits: Math.max(Number(reportedReuse.cacheHits || 0), adapterCacheHits),
      requestsAvoided: Math.max(Number(reportedReuse.requestsAvoided || 0), adapterCacheHits),
    } : null,
    diagnostics: source?.diagnostics || null,
    evidence: (source?.evidence || []).map((item) => ({
      id: item.id, type: item.type, timestamp: item.timestamp, title: item.title, summary: item.summary,
      severity: item.severity, entity: item.entity, url: item.url, confidence: item.confidence, metadata: item.metadata,
    })),
  };
}

function createNoiseAppDynamicsEvidenceService({
  actionability = actionabilityService,
  acquisition = acquisitionService,
  enrichment = enrichmentService,
  operational = operationalSignalService,
  identity = sourceIdentityService,
  appDynamicsAdapter = new AppDynamicsEvidenceAdapter(),
  decisionPolicy = decisionPolicyService,
  followUpStore = createFollowUpStore(),
  now = () => Date.now(),
} = {}) {
  async function loadIdentityCoverage(refresh) {
    const first = await identity.getCoverage({ range: RANGE, page: 1, size: 100, refresh });
    const entities = [...(first.entities || [])];
    for (let page = 2; page <= Number(first.pagination?.totalPages || 1); page += 1) {
      const response = await identity.getCoverage({ range: RANGE, page, size: 100 });
      entities.push(...(response.entities || []));
    }
    return { ...first, entities };
  }

  async function completeCurrentAppDynamicsIdentities(baseline, coverage) {
    const alerts = (baseline?.analysis?._normalizedAlerts || []).filter((alert) => appDynamicsAlert(alert, null));
    const groupByAlert = new Map();
    (baseline?.patternResults || []).forEach(({ group }) => (group?.alerts || []).forEach((alert) => {
      if (appDynamicsAlert(alert, group) && !groupByAlert.has(alertId(alert))) groupByAlert.set(alertId(alert), group);
    }));
    const standardByGroup = new Map((coverage?.entities || []).map((item) => [String(item.groupId), item]));
    const resolutionByAlert = new Map();
    alerts.forEach((alert) => {
      const group = groupByAlert.get(alertId(alert));
      const resolved = group ? standardByGroup.get(String(group.groupId)) : null;
      if (resolved) resolutionByAlert.set(alertId(alert), resolved);
    });
    if (typeof identity.getInventories !== 'function' || typeof identity.resolveGroup !== 'function') {
      return { resolutionByAlert, patternsResolved: new Set(resolutionByAlert.values()).size, inventoryQueries: 0 };
    }
    const unresolved = alerts.filter((alert) => !resolutionByAlert.has(alertId(alert)));
    if (!unresolved.length) return { resolutionByAlert, patternsResolved: new Set(resolutionByAlert.values()).size, inventoryQueries: 0 };
    const groups = new Map();
    unresolved.forEach((alert) => {
      const metadata = sourceMetadata(alert);
      const identityKey = [metadata.applicationId, metadata.application, metadata.service, metadata.tier, metadata.node,
        metadata.businessTransaction, metadata.environment].map(canonical).filter(Boolean).join('|')
        || `unresolved|${canonical(alert.title || alert.message)}`;
      const group = groups.get(identityKey) || {
        groupId: `appd-current-${identityKey}`,
        pattern: cleanText(alert.title || alert.message) || 'AppDynamics alert',
        source: SOURCE,
        firstSeen: alert.createdAt || alert.firstOccurredAt || null,
        lastSeen: alert.createdAt || alert.firstOccurredAt || null,
        alerts: [],
      };
      group.alerts.push(alert);
      group.firstSeen = [group.firstSeen, alert.createdAt || alert.firstOccurredAt].filter(Boolean).sort()[0] || null;
      group.lastSeen = [group.lastSeen, alert.createdAt || alert.firstOccurredAt].filter(Boolean).sort().at(-1) || null;
      groups.set(identityKey, group);
    });
    const inventories = await identity.getInventories(false);
    for (const group of groups.values()) {
      const resolved = await identity.resolveGroup(group, { inventories });
      group.alerts.forEach((alert) => resolutionByAlert.set(alertId(alert), resolved));
    }
    return { resolutionByAlert, patternsResolved: new Set(resolutionByAlert.values()).size, inventoryQueries: inventories.cacheHit === true ? 0 : 1 };
  }

  async function getStatus(options = {}) {
    const startedAt = now();
    const refresh = String(options.refresh || '').toLowerCase() === 'true' || options.refresh === true;
    await acquisition.restore(RANGE);
    if (refresh) {
      identity.clearCache?.();
      operational.invalidate?.();
    }
    const baseline = await actionability.getSnapshot({ range: RANGE, refresh });
    const overrides = enrichment.getOverrides(RANGE, baseline.analysisVersion);
    const current = overrides.size ? await actionability.getSnapshot({ range: RANGE, enrichmentOverrides: overrides }) : baseline;
    // Reuse the single refreshed Operations snapshot above. Running these in
    // parallel with refresh=true would duplicate lifecycle reads while adding
    // no evidence to the fixed 24-hour denominator.
    const coverage = await loadIdentityCoverage(false);
    const completedIdentity = await completeCurrentAppDynamicsIdentities(baseline, coverage);
    const enrichmentStatus = await enrichment.prepareStatus({ range: RANGE });
    const normalizedAlertById = new Map((baseline.analysis?._normalizedAlerts || []).map((alert) => [alertId(alert), alert]));
    const currentWithValidatedIdentity = {
      ...current,
      occurrences: (current.occurrences || []).map((occurrence) => {
        const id = String(occurrence.canonicalOperationsId);
        const resolved = completedIdentity.resolutionByAlert.get(id);
        if (!resolved) return occurrence;
        const alert = normalizedAlertById.get(id);
        const metadata = sourceMetadata(alert || {});
        const condition = cleanText(alert?.title || alert?.message);
        const appDynamicsMappings = resolved.mappings?.appDynamics || [];
        const mapping = highestMapping(appDynamicsMappings);
        const businessTransactionIdentityMissing = /business.?transaction|\bbt\b/i.test(condition) && !metadata.businessTransaction;
        const accepted = !businessTransactionIdentityMissing && Boolean(mapping?.usableForSourceValidation)
          && ['EXACT', 'STRONG', 'CONFIRMED_LOCAL'].includes(mapping.level);
        return {
          ...occurrence,
          enrichment: {
            ...(occurrence.enrichment || {}),
            sourceMapping: mapping ? { ...mapping, level: accepted ? mapping.level : 'NONE', accepted } : { level: 'NONE', accepted: false },
          },
          evidence: {
            ...(occurrence.evidence || {}),
            identity: {
              ...(occurrence.evidence?.identity || {}),
              accepted,
              candidateOnly: !accepted && !businessTransactionIdentityMissing && appDynamicsMappings.some((item) => item.level === 'CANDIDATE'),
              conflicts: Boolean(resolved.conflicts?.length),
            },
          },
        };
      }),
    };
    const operationalSnapshot = await operational.compute(RANGE, refresh, currentWithValidatedIdentity);
    const groupByAlert = new Map();
    (baseline.patternResults || []).forEach(({ group }) => (group.alerts || []).forEach((alert) => {
      if (appDynamicsAlert(alert, group) && !groupByAlert.has(alertId(alert))) groupByAlert.set(alertId(alert), group);
    }));
    const identityByGroup = new Map((coverage.entities || []).map((item) => [item.groupId, item]));
    const occurrenceById = new Map((current.occurrences || []).map((item) => [String(item.canonicalOperationsId), item]));
    const notifications = operationalSnapshot.events.flatMap((event) => event.notifications || []);
    const notificationById = new Map(notifications.filter((item) => isAppDynamics(item.source)).map((item) => [String(item.alertId), item]));
    const rawPersistedPackages = (enrichmentStatus.records || []).filter((record) => record.sources?.appDynamics?.applicable);
    const persistedPackages = rawPersistedPackages.map(safeEvidencePackage);
    const packageById = new Map(persistedPackages.map((record) => [String(record.alertId), record]));
    let alerts = (baseline.analysis?._normalizedAlerts || []).filter((alert) => {
      const group = groupByAlert.get(alertId(alert));
      return appDynamicsAlert(alert, group);
    }).map((alert) => {
      const id = alertId(alert);
      const group = groupByAlert.get(id) || null;
      const entity = completedIdentity.resolutionByAlert.get(id) || identityByGroup.get(group?.groupId) || null;
      const mappingCandidates = entity?.mappings?.appDynamics || [];
      const mapping = highestMapping(mappingCandidates);
      const metadata = sourceMetadata(alert);
      const normalized = normalizeOperationsAlert(alert, entity);
      const occurrence = occurrenceById.get(id) || null;
      const notification = notificationById.get(id) || null;
      const evidencePackage = packageById.get(id) || null;
      const condition = metadata.healthRule || metadata.metric || cleanText(alert.title || alert.message || group?.pattern) || null;
      const businessTransactionIdentityMissing = /business.?transaction|\bbt\b/i.test(condition) && !metadata.businessTransaction;
      const mappingAccepted = !businessTransactionIdentityMissing && Boolean(mapping?.usableForSourceValidation)
        && ['EXACT', 'STRONG', 'CONFIRMED_LOCAL'].includes(mapping.level);
      return {
        id,
        alertNumber: cleanText(alert.tinyId || alert.alertNumber) || null,
        title: cleanText(alert.title || alert.message || group?.pattern) || 'AppDynamics alert',
        createdAt: alert.createdAt || alert.firstOccurredAt || null,
        closedAt: alert.closeTime || alert.closedAt || alert.resolvedAt || null,
        status: alert.status || null,
        priority: alert.priority || null,
        severity: alert.monitoringSeverity || alert.severity || null,
        groupId: group?.groupId || notification?.patternId || null,
        pattern: group?.pattern || notification?.pattern || null,
        application: {
          id: mapping?.metadata?.applicationId || metadata.applicationId || null,
          name: mapping?.sourceEntityType === 'APPLICATION' ? mapping.sourceEntityName : metadata.application || metadata.service || null,
        },
        alertCondition: { name: condition, healthRule: metadata.healthRule, metric: metadata.metric },
        sourceIdentity: { ...metadata, metricIntent: appDynamicsMetricIntent(normalized) },
        mapping: mapping ? {
          level: mappingAccepted ? mapping.level : 'NONE',
          sourceEntityId: mapping.sourceEntityId,
          sourceEntityName: mapping.sourceEntityName,
          sourceEntityType: mapping.sourceEntityType,
          environment: mapping.environment,
          reasons: mapping.reasons,
          mappingMechanism: mapping.mappingMechanism,
          lastValidatedAt: mapping.provenance?.lastValidatedAt || null,
          accepted: mappingAccepted,
        } : { level: 'NONE', accepted: false, reasons: ['No deterministic AppDynamics mapping is available.'] },
        operationsIdentity: {
          applicationId: metadata.applicationId, application: metadata.application, service: metadata.service,
          tier: metadata.tier, node: metadata.node, businessTransaction: metadata.businessTransaction,
          healthRule: metadata.healthRule, environment: metadata.environment,
        },
        mappingCandidates: mappingCandidates.filter((item) => item.level !== 'NONE').map(publicMappingCandidate),
        mappingConflict: Boolean(entity?.conflicts?.length),
        mappingBlocked: mappingAccepted ? null : mappingBlock(metadata, mappingCandidates, entity?.conflicts || [], group?.pattern || alert.title),
        actionability: occurrence?.classification || 'NEEDS_REVIEW',
        classification: notification?.operationalSignalClassification || 'NEEDS_REVIEW',
        classificationReasons: notification?.actionabilityReasons || occurrence?.reasons || [],
        evidenceState: occurrence?.evidenceState || 'NOT_ENRICHED',
        evidencePackage,
      };
    });
    const reconstruction = operationalSnapshot.appDynamicsEventReconstruction || null;
    const decisionEvaluation = await decisionPolicy.evaluatePopulation({
      alerts,
      packages: rawPersistedPackages,
      operationalEvents: reconstruction,
    });
    alerts = decisionEvaluation.alerts;
    const mappingCounts = { exact: 0, strong: 0, confirmedLocal: 0, candidate: 0, none: 0, stale: 0, conflicts: 0 };
    alerts.forEach((item) => {
      const key = ({ EXACT: 'exact', STRONG: 'strong', CONFIRMED_LOCAL: 'confirmedLocal', CANDIDATE: 'candidate', STALE_MAPPING: 'stale' })[item.mapping.level] || 'none';
      mappingCounts[key] += 1;
      if (identityByGroup.get(item.groupId)?.conflicts?.length) mappingCounts.conflicts += 1;
    });
    const after = classificationCounts(alerts);
    const before = classificationCounts(alerts, (item) => item.evidencePackage?.classificationBefore === 'NEEDS_REVIEW' ? 'NEEDS_REVIEW' : item.classification);
    const accepted = alerts.filter((item) => item.mapping.accepted).length;
    const telemetryQueried = alerts.filter((item) => item.evidencePackage?.queryOutcome && item.evidencePackage.queryOutcome !== 'NOT_QUERIED').length;
    const telemetryReturned = alerts.filter((item) => item.evidencePackage?.queryOutcome === 'RECORDS_FOUND').length;
    const evidenceSufficient = alerts.filter((item) => item.evidencePackage?.evidenceSufficiency === 'EVIDENCE_SUFFICIENT').length;
    // Keep persisted history for restart/resume, but report only evidence tied
    // to alerts still inside the fixed rolling 24-hour denominator.
    const packages = [...new Map(alerts
      .map((item) => item.evidencePackage)
      .filter(Boolean)
      .map((item) => [String(item.alertId), item])).values()];
    const outcomeCounts = {};
    packages.forEach((item) => { outcomeCounts[item.queryOutcome] = Number(outcomeCounts[item.queryOutcome] || 0) + 1; });
    const reviewReasons = new Map();
    alerts.filter((item) => item.classification === 'NEEDS_REVIEW').forEach((item) => {
      const reasons = item.classificationReasons.length ? item.classificationReasons : ['Evidence is not yet sufficient for a deterministic classification.'];
      reasons.forEach((reason) => reviewReasons.set(reason, Number(reviewReasons.get(reason) || 0) + 1));
    });
    const operationalPatterns = new Map((operationalSnapshot.patterns || []).map((item) => [item.patternId, item]));
    const patternGroups = new Map();
    alerts.forEach((item) => {
      const key = item.groupId || `unmapped:${canonical(item.pattern || item.title)}`;
      const records = patternGroups.get(key) || [];
      records.push(item);
      patternGroups.set(key, records);
    });
    const patterns = [...patternGroups.entries()].map(([patternId, records]) => {
      const operationalPattern = operationalPatterns.get(patternId);
      const first = records[0];
      return {
        patternId,
        pattern: first.pattern || first.title,
        application: first.application,
        alertCondition: first.alertCondition,
        metricIntent: first.sourceIdentity.metricIntent,
        mapping: first.mapping,
        occurrences: records.length,
        classification: classificationCounts(records),
        decisions: {
          incident: records.filter((item) => item.decisionPolicy?.decision === 'INCIDENT').length,
          noise: records.filter((item) => item.decisionPolicy?.decision === 'NOISE').length,
          needsReview: records.filter((item) => item.decisionPolicy?.decision === 'NEEDS_REVIEW').length,
        },
        telemetryQueried: records.filter((item) => item.evidencePackage?.queryOutcome && item.evidencePackage.queryOutcome !== 'NOT_QUERIED').length,
        telemetryReturned: records.filter((item) => item.evidencePackage?.queryOutcome === 'RECORDS_FOUND').length,
        evidenceSufficient: records.filter((item) => item.evidencePackage?.evidenceSufficiency === 'EVIDENCE_SUFFICIENT').length,
        noiseLikelihood: operationalPattern?.noiseLikelihood ?? null,
        reviewRisk: operationalPattern?.reviewRisk || null,
        evidencePackages: records.map((item) => item.evidencePackage).filter(Boolean),
        operationsIdentity: first.operationsIdentity,
        candidateEntities: first.mappingCandidates,
        mappingBlocked: first.mappingBlocked,
      };
    }).sort((left, right) => right.occurrences - left.occurrences || left.pattern.localeCompare(right.pattern));
    const applicationCount = new Set(alerts.map((item) => item.application.id || item.application.name).filter(Boolean)).size;
    const conditionCount = new Set(alerts.map((item) => item.alertCondition.name).filter(Boolean).map(canonical)).size;
    const remainingEligible = alerts.filter((item) => item.classification === 'NEEDS_REVIEW' && item.mapping.accepted && !item.evidencePackage).length;
    const eapi = patterns.find((item) => /eapi.?billing.?daemon/i.test([item.pattern, item.application.name].filter(Boolean).join(' '))) || null;
    const status = {
      phase: decisionEvaluation.summary.phase,
      analysisVersion: baseline.analysisVersion,
      range: RANGE,
      computedAt: new Date(now()).toISOString(),
      inventory: {
        alerts: alerts.length,
        applications: applicationCount,
        alertConditions: conditionCount,
        needsReviewBefore: before.needsReview,
        sourceMetadataPreserved: alerts.filter((item) => Object.values(item.sourceIdentity).some(Boolean)).length,
      },
      mapping: { ...mappingCounts, accepted, coveragePercentage: alerts.length ? Number((accepted / alerts.length * 100).toFixed(1)) : 0 },
      telemetry: {
        queried: telemetryQueried,
        returned: telemetryReturned,
        evidenceSufficient,
        recordsReturned: packages.reduce((sum, item) => sum + Number(item.telemetry?.records || 0), 0),
        outcomeCounts,
        cacheHits: packages.filter((item) => item.queryReuse?.cacheHit).length,
        requestsAvoided: packages.reduce((sum, item) => sum + Number(item.queryReuse?.requestsAvoided || (item.queryReuse?.cacheHit ? 1 : 0)), 0),
        validMetricRecords: Number(reconstruction?.summary?.metricValidation?.validMetricRecords || 0),
        invalidMetricRecords: Number(reconstruction?.summary?.metricValidation?.invalidMetricRecords || 0),
        matchedEvents: Number(reconstruction?.summary?.metricValidation?.matchedEvents || 0),
        mismatchedEvents: Number(reconstruction?.summary?.metricValidation?.mismatchedEvents || 0),
        unknownEvents: Number(reconstruction?.summary?.metricValidation?.unknownEvents || 0),
      },
      before,
      after,
      progress: {
        batchSize: 25,
        maxConcurrency: 3,
        processed: packages.length,
        remainingEligible,
        complete: remainingEligible === 0,
      },
      reviewReasons: [...reviewReasons.entries()].map(([reason, count]) => ({ reason, count })).sort((left, right) => right.count - left.count).slice(0, 12),
      patterns,
      alerts,
      decisionPolicy: decisionEvaluation.summary,
      identityCompletion: identityCompletionReport(patterns, alerts),
      operationalEvents: reconstruction,
      eapiBillingDaemon: eapi,
      persistence: {
        identityRegistry: 'PERSISTENT_REVALIDATED',
        evidencePackages: persistedPackages.length,
        evidenceVersion: enrichmentStatus.evidenceVersion,
        classificationVersion: enrichmentStatus.classificationVersion,
      },
      performance: {
        executionTimeMs: Math.max(0, now() - startedAt), maximumConcurrency: 3,
        identityQueries: (coverage.performance?.cacheHit ? 0 : 1) + completedIdentity.inventoryQueries,
        telemetryQueries: packages.length,
        telemetryReused: packages.length,
        recordsReused: Number(reconstruction?.performance?.recordsProcessed || 0),
        additionalRecords: Number(reconstruction?.performance?.additionalSourceCalls || 0) > 0 ? null : 0,
        inventoryCacheHit: coverage.performance?.cacheHit === true,
      },
      safeguards: { readOnly: true, externalMutations: 'none', automaticSuppression: 'none', automaticTuning: 'none', aiUsed: false },
    };
    let latestFollowUp = null;
    try { latestFollowUp = await followUpStore.latest(RANGE); } catch { latestFollowUp = null; }
    const remainingEvidence = auditStatus(status, latestFollowUp);
    if (latestFollowUp?.status === 'COMPLETE' && latestFollowUp.schemaVersion !== AUDIT_SCHEMA_VERSION) {
      try { await followUpStore.save(remainingEvidence); } catch { /* status remains available even when local audit persistence is unavailable */ }
    }
    return { ...status, remainingEvidence };
  }

  async function acquire(options = {}) {
    if (typeof acquisition.persistReadOnlyPackages !== 'function') {
      await loadIdentityCoverage(true);
      const run = await acquisition.acquire({
        batchSize: options.batchSize || 25,
        forceRefresh: options.forceRefresh === true,
        provenanceOnly: options.provenanceOnly === true,
        range: RANGE,
        signal: options.signal,
        source: SOURCE,
      });
      operational.invalidate();
      return { run, status: await getStatus({ refresh: false }), externalMutations: 'none' };
    }
    const batchSize = Math.max(1, Math.min(25, Number(options.batchSize) || 25));
    const before = await getStatus({ refresh: options.forceRefresh === true });
    const currentSnapshot = await actionability.getSnapshot({ range: RANGE });
    const currentOccurrenceById = new Map((currentSnapshot.occurrences || []).map((item) => [String(item.canonicalOperationsId), item]));
    const eligible = before.alerts.filter((item) => item.classification === 'NEEDS_REVIEW' && item.mapping.accepted && !item.evidencePackage).slice(0, batchSize);
    const startedAt = now();
    const results = new Array(eligible.length);
    let cursor = 0;
    const workers = Array.from({ length: Math.min(3, eligible.length) }, async () => {
      while (cursor < eligible.length) {
        const index = cursor;
        cursor += 1;
        const item = eligible[index];
        if (options.signal?.aborted) break;
        const alert = {
          id: item.id,
          tinyId: item.alertNumber,
          source: SOURCE,
          title: item.title,
          service: item.operationsIdentity?.service,
          application: item.operationsIdentity?.application,
          environment: item.operationsIdentity?.environment,
          createdAt: item.createdAt,
          closedAt: item.closedAt,
          status: item.status,
          sourceDetails: {
            applicationId: item.operationsIdentity?.applicationId,
            application: item.operationsIdentity?.application,
            service: item.operationsIdentity?.service,
            tier: item.operationsIdentity?.tier,
            node: item.operationsIdentity?.node,
            businessTransaction: item.operationsIdentity?.businessTransaction,
            healthRule: item.operationsIdentity?.healthRule,
            metric: item.sourceIdentity?.metric,
          },
        };
        const window = buildBoundedWindow(alert, undefined, now());
        if (!window) continue;
        const mapping = {
          source: SOURCE,
          level: item.mapping.level,
          sourceEntityId: item.mapping.sourceEntityId,
          sourceEntityName: item.mapping.sourceEntityName,
          sourceEntityType: item.mapping.sourceEntityType,
          environment: item.mapping.environment,
          reasons: item.mapping.reasons,
          usableForSourceValidation: true,
          metadata: { applicationId: item.mapping.sourceEntityType === 'APPLICATION' ? item.mapping.sourceEntityId : item.application?.id },
        };
        const source = await appDynamicsAdapter.queryEvidence(normalizeOperationsAlert(alert), window, {
          mappings: [mapping],
          range: RANGE,
          refresh: options.forceRefresh === true,
        });
        const beforeOccurrence = currentOccurrenceById.get(String(item.id)) || { canonicalOperationsId: item.id, classification: 'NEEDS_REVIEW', reasons: item.classificationReasons || [] };
        const beforeClassification = beforeOccurrence.classification === 'NEEDS_REVIEW' ? beforeOccurrence.classification : 'NEEDS_REVIEW';
        const actionabilityAfter = {
          ...beforeOccurrence,
          classification: 'NEEDS_REVIEW',
          classificationReasons: item.classificationReasons || beforeOccurrence.classificationReasons || beforeOccurrence.reasons || [],
          reasons: item.classificationReasons || beforeOccurrence.reasons || [],
        };
        results[index] = {
          analysisVersion: before.analysisVersion,
          alertId: item.id,
          alertNumber: item.alertNumber,
          patternId: item.groupId || `appd-${canonical(item.operationsIdentity?.service || item.title)}`,
          pattern: item.pattern || item.title,
          identity: { entityId: item.mapping.sourceEntityId, canonicalName: item.mapping.sourceEntityName, entityType: item.mapping.sourceEntityType },
          sourceMapping: { level: item.mapping.level, mappings: [mapping] },
          investigationWindow: window,
          sources: { appDynamics: { ...source, applicable: true } },
          evidenceCoverage: source.pipelineState === 'RECORDS_FOUND' ? 'COMPLETE' : 'PARTIAL',
          evidenceStatus: source.pipelineState === 'QUERY_FAILED' ? 'EVIDENCE_UNAVAILABLE' : 'ENRICHED',
          evidenceDecisionState: 'EVIDENCE_INSUFFICIENT',
          actionabilityBefore: beforeOccurrence,
          actionabilityAfter,
          previousClassification: beforeClassification,
          newClassification: 'NEEDS_REVIEW',
          reclassification: { changed: false, before: beforeClassification, after: 'NEEDS_REVIEW', reasons: item.classificationReasons || [] },
          confidence: 'LOW',
          reasons: item.classificationReasons || [],
          collectedAt: new Date(now()).toISOString(),
          sourceData: window.open ? 'Live' : 'Historical',
          evidenceVersion: before.persistence.evidenceVersion,
          classificationVersion: before.persistence.classificationVersion,
          diagnostics: { executionTimeMs: source.executionTimeMs, externalApiCallCount: 1, requestsAvoided: source.query?.reuse?.cacheHit ? 1 : 0 },
          externalMutations: 'none',
        };
      }
    });
    await Promise.all(workers);
    const records = results.filter(Boolean);
    const persisted = typeof acquisition.persistReadOnlyPackages === 'function'
      ? await acquisition.persistReadOnlyPackages(RANGE, records)
      : { imported: 0, packages: records, saved: 0 };
    const run = {
      phase: '4.4A.2', runId: `phase4.4A.2-${RANGE}-${startedAt}`, range: RANGE, source: SOURCE,
      batchSize, selected: eligible.length, processed: records.length,
      recordsReturned: records.reduce((sum, record) => sum + Number(record.sources.appDynamics.recordsReturned || 0), 0),
      telemetryQueries: records.length,
      cacheHits: records.filter((record) => record.sources.appDynamics.query?.reuse?.cacheHit).length,
      packagesPersisted: persisted.saved,
      executionTimeMs: Math.max(0, now() - startedAt),
      readOnly: true, externalMutations: 'none', aiUsed: false,
    };
    operational.invalidate();
    return { run, status: await getStatus({ refresh: false }), externalMutations: 'none' };
  }

  async function runFollowUp(options = {}) {
    const startedAt = now();
    const before = await getStatus({ refresh: options.refresh === true });
    const initial = before.remainingEvidence;
    if (initial?.status === 'COMPLETE' && initial.inputVersion) {
      return { run: { ...initial, reused: true }, status: before, externalMutations: 'none' };
    }
    const initialRows = initial?.occurrences || [];
    const alertById = new Map((before.alerts || []).map((item) => [String(item.id), item]));
    const snapshot = await actionability.getSnapshot({ range: RANGE });
    const occurrenceById = new Map((snapshot.occurrences || []).map((item) => [String(item.canonicalOperationsId), item]));
    const diagnosticRows = initialRows.filter((row) => !['BT_IDENTITY_UNAVAILABLE', 'NO_ACCEPTED_MAPPING'].includes(row.rootCause));
    const diagnostics = new Map();
    const correctedPackages = [];
    let cursor = 0;
    const workers = Array.from({ length: Math.min(3, diagnosticRows.length) }, async () => {
      while (cursor < diagnosticRows.length) {
        const index = cursor;
        cursor += 1;
        const row = diagnosticRows[index];
        if (options.signal?.aborted) break;
        const item = alertById.get(String(row.operationsAlertId));
        if (!item || !row.diagnosticWindow) {
          diagnostics.set(String(row.operationsAlertId), diagnoseResult(row, { pipelineState: 'NOT_QUERIED', failureReason: 'INVALID_QUERY_WINDOW', query: {} }, null));
          continue;
        }
        const alert = {
          id: item.id,
          tinyId: item.alertNumber,
          source: SOURCE,
          title: item.title,
          service: item.operationsIdentity?.service,
          application: item.operationsIdentity?.application,
          environment: item.operationsIdentity?.environment,
          createdAt: item.createdAt,
          closedAt: item.closedAt,
          status: item.status,
          sourceDetails: {
            applicationId: item.application?.id || item.operationsIdentity?.applicationId,
            application: item.application?.name || item.operationsIdentity?.application,
            service: item.operationsIdentity?.service,
            tier: item.operationsIdentity?.tier,
            node: item.operationsIdentity?.node,
            businessTransaction: item.operationsIdentity?.businessTransaction,
            healthRule: item.operationsIdentity?.healthRule,
            metric: item.sourceIdentity?.metric,
          },
        };
        const mapping = {
          source: SOURCE,
          level: item.mapping.level,
          sourceEntityId: item.mapping.sourceEntityId,
          sourceEntityName: item.mapping.sourceEntityName,
          sourceEntityType: item.mapping.sourceEntityType,
          environment: item.mapping.environment,
          reasons: item.mapping.reasons,
          usableForSourceValidation: true,
          metadata: { applicationId: item.application?.id || item.mapping.sourceEntityId },
        };
        const source = await appDynamicsAdapter.queryEvidence(normalizeOperationsAlert(alert), row.diagnosticWindow, {
          mappings: [mapping],
          metricIntent: item.sourceIdentity?.metricIntent,
          range: RANGE,
          refresh: true,
          requireExactEntity: true,
        });
        const semantic = validateReplay(source, item.sourceIdentity?.metricIntent);
        const diagnostic = diagnoseResult(row, source, semantic);
        diagnostics.set(String(row.operationsAlertId), diagnostic);
        if (!diagnostic.correctedEvidence || semantic.evidenceLevel !== 'DIRECT') continue;
        const beforeOccurrence = occurrenceById.get(String(item.id)) || { canonicalOperationsId: item.id, classification: 'NEEDS_REVIEW', reasons: item.classificationReasons || [] };
        const query = { ...(source.query || {}), diagnosticReplay: true, replayPhase: FOLLOW_UP_PHASE,
          originalWindow: row.queryWindow, semanticValidation: {
            expectedIntent: semantic.expectedIntent, status: semantic.status, evidenceLevel: semantic.evidenceLevel,
            matchedRecords: semantic.matchedRecords, mismatchedRecords: semantic.mismatchedRecords,
          } };
        correctedPackages.push({
          analysisVersion: before.analysisVersion,
          alertId: item.id,
          alertNumber: item.alertNumber,
          patternId: item.groupId || `appd-${canonical(item.operationsIdentity?.service || item.title)}`,
          pattern: item.pattern || item.title,
          identity: { entityId: item.mapping.sourceEntityId, canonicalName: item.mapping.sourceEntityName, entityType: item.mapping.sourceEntityType },
          sourceMapping: { level: item.mapping.level, mappings: [mapping] },
          investigationWindow: row.diagnosticWindow,
          sources: { appDynamics: { ...source, query, applicable: true } },
          evidenceCoverage: 'COMPLETE',
          evidenceStatus: 'ENRICHED',
          evidenceDecisionState: 'EVIDENCE_INSUFFICIENT',
          actionabilityBefore: beforeOccurrence,
          actionabilityAfter: { ...beforeOccurrence, classification: 'NEEDS_REVIEW', reasons: item.classificationReasons || beforeOccurrence.reasons || [] },
          previousClassification: 'NEEDS_REVIEW',
          newClassification: 'NEEDS_REVIEW',
          reclassification: { changed: false, before: 'NEEDS_REVIEW', after: 'NEEDS_REVIEW', reasons: ['Awaiting existing deterministic event reconstruction.'] },
          confidence: 'LOW',
          reasons: item.classificationReasons || [],
          collectedAt: new Date(now()).toISOString(),
          sourceData: 'Historical diagnostic replay',
          evidenceVersion: before.persistence.evidenceVersion,
          classificationVersion: before.persistence.classificationVersion,
          followUp: { phase: FOLLOW_UP_PHASE, rootCause: diagnostic.rootCause, correctedEvidence: true,
            originalWindow: row.queryWindow, diagnosticWindow: row.diagnosticWindow },
          diagnostics: { executionTimeMs: source.executionTimeMs, externalApiCallCount: source.query?.reuse?.cacheHit ? 0 : 1,
            requestsAvoided: source.query?.reuse?.cacheHit ? 1 : 0, followUp: diagnostic },
          externalMutations: 'none',
        });
      }
    });
    await Promise.all(workers);
    if (correctedPackages.length) await acquisition.persistReadOnlyPackages(RANGE, correctedPackages);
    operational.invalidate?.();
    const after = await getStatus({ refresh: false });
    const afterById = new Map((after.alerts || []).map((item) => [String(item.id), item]));
    const rows = initialRows.map((row) => {
      const diagnostic = diagnostics.get(String(row.operationsAlertId)) || {
        rootCause: row.rootCause,
        reason: row.reasonRemainingReview,
        diagnosticWindow: row.diagnosticWindow,
        queryState: row.queryState,
        rawRecordCount: row.rawRecordCount,
        normalizedRecordCount: row.normalizedRecordCount,
        sourceDataAvailability: row.sourceDataAvailability,
      };
      const updated = afterById.get(String(row.operationsAlertId));
      return {
        ...row,
        rootCause: diagnostic.rootCause,
        telemetryRequested: diagnostic.requestedMetricIntent || row.metricIntent,
        queryState: diagnostic.queryState || row.queryState,
        diagnosticWindow: diagnostic.diagnosticWindow || row.diagnosticWindow,
        telemetryReturned: Number(diagnostic.directRecords || 0),
        rawRecordCount: Number(diagnostic.rawRecordCount ?? row.rawRecordCount ?? 0),
        normalizedRecordCount: Number(diagnostic.normalizedRecordCount ?? row.normalizedRecordCount ?? 0),
        httpStatus: diagnostic.httpStatus ?? row.httpStatus,
        responseShape: diagnostic.responseShape || row.responseShape,
        sourceDataAvailability: diagnostic.sourceDataAvailability || row.sourceDataAvailability,
        diagnostic,
        newClassification: updated?.classification || 'NEEDS_REVIEW',
        reasonRemainingReview: diagnostic.reason || row.reasonRemainingReview,
      };
    });
    const completedAt = new Date(now()).toISOString();
    const queryDiagnostics = [...diagnostics.values()];
    const run = summarizeAudit({
      phase: FOLLOW_UP_PHASE,
      schemaVersion: AUDIT_SCHEMA_VERSION,
      runId: `${FOLLOW_UP_PHASE}-${RANGE}-${startedAt}`,
      range: RANGE,
      inputVersion: initial.inputVersion,
      status: 'COMPLETE',
      startedAt: new Date(startedAt).toISOString(),
      completedAt,
      before: before.after,
      after: after.after,
      occurrences: rows,
      performance: {
        additionalApiCalls: queryDiagnostics.filter((item) => !item.queryReused && item.queryState !== 'NOT_QUERIED').length,
        queriesReused: queryDiagnostics.filter((item) => item.queryReused).length,
        diagnosticQueries: queryDiagnostics.filter((item) => item.queryState !== 'NOT_QUERIED').length,
        recordsReturned: queryDiagnostics.reduce((sum, item) => sum + Number(item.normalizedRecordCount || 0), 0),
        timeouts: queryDiagnostics.filter((item) => /TIMEOUT/i.test(String(item.failureReason || ''))).length,
        errors: queryDiagnostics.filter((item) => item.queryState === 'QUERY_FAILED').length,
        durationMs: Math.max(0, now() - startedAt),
        maxConcurrency: 3,
        correctedPackagesPersisted: correctedPackages.length,
      },
      safeguards: { readOnly: true, externalMutations: 'none', aiUsed: false, automaticSuppression: 'none', automaticTuning: 'none' },
    }, after);
    await followUpStore.save(run);
    return { run, status: await getStatus({ refresh: false }), externalMutations: 'none' };
  }

  async function getPattern(patternId) {
    const status = await getStatus();
    const pattern = status.patterns.find((item) => item.patternId === String(patternId));
    if (!pattern) {
      const error = new Error('AppDynamics evidence pattern was not found in the current 24-hour window.');
      error.code = 'APPDYNAMICS_EVIDENCE_PATTERN_NOT_FOUND';
      error.safeMessage = error.message;
      error.status = 404;
      throw error;
    }
    return { phase: '4.4A.2', range: RANGE, pattern, readOnly: true, externalMutations: 'none' };
  }

  async function getOperationalEvent(eventId) {
    const status = await getStatus();
    const event = status.operationalEvents?.events?.find((item) => item.eventId === String(eventId));
    if (!event) {
      const error = new Error('AppDynamics reconstructed operational event was not found in the current 24-hour window.');
      error.code = 'APPDYNAMICS_RECONSTRUCTED_EVENT_NOT_FOUND';
      error.safeMessage = error.message;
      error.status = 404;
      throw error;
    }
    return { phase: '4.4A.2', range: RANGE, reconstructionVersion: status.operationalEvents.reconstructionVersion, event, readOnly: true, externalMutations: 'none' };
  }

  async function getDecision(alertIdValue) {
    const status = await getStatus();
    const alert = status.alerts.find((item) => String(item.id) === String(alertIdValue)
      || String(item.alertNumber) === String(alertIdValue).replace(/^#/, ''));
    if (!alert) {
      const error = new Error('AppDynamics alert decision was not found in the current 24-hour window.');
      error.code = 'APPDYNAMICS_DECISION_NOT_FOUND';
      error.safeMessage = error.message;
      error.status = 404;
      throw error;
    }
    let history = [];
    try { history = await decisionPolicy.history(alert.id, 50); } catch { history = []; }
    return { phase: status.phase, range: RANGE, alert, history, readOnly: true, externalMutations: 'none' };
  }

  return { acquire, getDecision, getOperationalEvent, getPattern, getStatus, runFollowUp };
}

module.exports = {
  classificationCounts,
  createNoiseAppDynamicsEvidenceService,
  identityCompletionReport,
  isAppDynamics,
  mappingBlock,
  service: createNoiseAppDynamicsEvidenceService(),
  sourceMetadata,
};
