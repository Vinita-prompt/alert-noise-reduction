const db = require('../config/db');
const { SOURCE_IDENTITY_CONFIG } = require('../config/sourceIdentity');
const { service: identityService } = require('./sourceIdentity.service');
const { service: decisionService } = require('./operationalDecision.service');
const { service: evidenceCompletionService } = require('./evidenceCompletion.service');

const ACCEPTED_STATES = new Set(['EXACT', 'STRONG', 'CONFIRMED_LOCAL']);
const MONITORING_SOURCES = new Set(['AppDynamics', 'Grafana', 'Nagios', 'ThousandEyes']);

function cleanText(value) {
  return String(value ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function percentage(value, total) {
  return total ? Number((Number(value || 0) / Number(total) * 100).toFixed(1)) : 0;
}

function decisionCounts(data) {
  const summary = data?.canonical?.summary || {};
  return {
    total: Number(summary.total || 0), incident: Number(summary.incident || 0),
    noise: Number(summary.noise || 0), needsReview: Number(summary.needsReview || 0),
  };
}

async function loadCoverage(identity, refresh = false, sourceDiscovery = true) {
  const first = await identity.getCoverage({ range: '24h', page: 1, size: 100, refresh, sourceDiscovery });
  const entities = [...(first.entities || [])];
  for (let page = 2; page <= Number(first.pagination?.totalPages || 1); page += 1) {
    const response = await identity.getCoverage({ range: '24h', page, size: 100, sourceDiscovery });
    entities.push(...(response.entities || []));
  }
  return { ...first, entities };
}

function decisionQuality(data) {
  const total = Number(data?.canonical?.summary?.total || data?.occurrences?.length || 0);
  const ready = (data?.occurrences || []).filter((item) => (
    item.canonicalAssessment?.evidenceCompletion?.readiness?.status === 'READY_FOR_DECISION'
  )).length;
  const automatic = Number(data?.canonical?.summary?.incident || 0) + Number(data?.canonical?.summary?.noise || 0);
  return {
    ready, incomplete: Math.max(0, total - ready),
    readinessPercentage: percentage(ready, total),
    automaticDecisionCoveragePercentage: percentage(automatic, total),
    classificationUnknown: Number(data?.canonical?.summary?.classification?.UNKNOWN || 0),
    unsupportedAutomaticDecisions: Number(data?.canonical?.summary?.quality?.unsupportedAutomaticDecisions || 0),
    evidenceProvenanceCoveragePercentage: Number(data?.canonical?.summary?.quality?.evidenceProvenanceCoveragePercentage || 0),
  };
}

function positiveNoiseEvidence(data) {
  const breakdown = data?.canonical?.summary?.noiseBreakdown || {};
  return {
    duplicate: Number(breakdown.DUPLICATE || 0), flapping: Number(breakdown.FLAPPING || 0),
    autoResolved: Number(breakdown.AUTO_RESOLVED || 0), nonActionable: Number(breakdown.NON_ACTIONABLE || 0),
    correlated: Number(breakdown.CORRELATED || 0), stale: Number(breakdown.STALE || 0),
  };
}

function targetForOccurrence(occurrence, entity) {
  const source = occurrence?.source?.name || 'Unknown';
  const resolved = (entity?.normalizedIdentities || []).find((item) => item.source === source);
  if (resolved) return resolved;
  const level = String(occurrence?.identity?.level || 'NONE').toUpperCase();
  const accepted = occurrence?.identity?.accepted === true && ACCEPTED_STATES.has(level);
  return {
    source,
    sourceEntityType: null,
    sourceEntityId: occurrence?.identity?.sourceEntityId || null,
    sourceEntityName: occurrence?.identity?.sourceEntityName || occurrence?.identity?.canonicalEntity || null,
    application: null, service: occurrence?.identity?.canonicalEntity || null,
    environment: occurrence?.identity?.environment || null,
    host: null, node: null, tier: null, businessTransaction: null,
    ruleId: null, ruleName: null, dashboardId: null, panelId: null,
    testId: null, targetId: null, hostId: null, serviceId: null,
    mappingState: occurrence?.identity?.conflicts ? 'CONFLICT' : accepted ? level
      : occurrence?.identity?.candidateOnly ? 'CANDIDATE' : 'UNKNOWN',
    mappingConfidence: accepted ? 75 : 0,
    identitySource: null,
    evidenceUsed: accepted ? ['Existing accepted source mapping from the operational evidence model.'] : [],
    evidenceMissing: accepted ? [] : [`Deterministic ${source} source identity`],
    reasoning: accepted ? 'Existing accepted source mapping remains available to the evidence pipeline.'
      : `No accepted deterministic ${source} source identity is available.`,
    candidateEntities: [], resolverVersion: SOURCE_IDENTITY_CONFIG.resolverVersion,
    resolvedAt: new Date().toISOString(),
    handoffStatus: accepted ? 'IDENTITY_READY' : 'IDENTITY_INCOMPLETE',
  };
}

function identityRecords(data, coverage) {
  const byPattern = new Map((coverage?.entities || []).map((item) => [String(item.groupId), item]));
  const byOccurrence = new Map();
  (coverage?.entities || []).forEach((item) => (item.operationsIdentity?.operationsIds || [])
    .forEach((id) => byOccurrence.set(String(id), item)));
  return (data?.occurrences || []).map((occurrence) => {
    const occurrenceId = String(occurrence?.occurrenceId || '');
    const legacyPatternId = String(occurrence?.alert?.patternId || '');
    const entity = byOccurrence.get(occurrenceId) || byPattern.get(legacyPatternId) || null;
    const patternId = legacyPatternId || String(entity?.groupId || '');
    const target = targetForOccurrence(occurrence, entity);
    const supported = MONITORING_SOURCES.has(target.source);
    let blocker = null;
    if (!supported) blocker = 'UNSUPPORTED_SOURCE';
    else if (target.mappingState === 'CONFLICT') blocker = target.discovery?.blocker || 'IDENTITY_CONFLICT';
    else if (target.mappingState === 'CANDIDATE') blocker = 'NO_SOURCE_IDENTITY';
    else if (!target.sourceEntityName && !entity?.canonicalEntity?.canonicalName) blocker = 'NO_ENTITY';
    else if (!ACCEPTED_STATES.has(target.mappingState)) blocker = target.discovery?.blocker || 'NO_SOURCE_IDENTITY';
    return {
      occurrenceId,
      alertNumber: occurrence.alert?.alertNumber || null,
      patternId,
      title: occurrence.alert?.title || null,
      source: target.source,
      decision: occurrence.canonicalAssessment?.finalDecision?.decision || 'NEEDS_REVIEW',
      target,
      blocker,
      ready: supported && target.handoffStatus === 'IDENTITY_READY',
    };
  });
}

function countsByState(records) {
  const count = (state) => records.filter((item) => item.target.mappingState === state).length;
  return {
    exact: count('EXACT'), strong: count('STRONG'), confirmedLocal: count('CONFIRMED_LOCAL'),
    candidate: count('CANDIDATE'), conflict: count('CONFLICT'),
    unknown: records.filter((item) => ['UNKNOWN', 'STALE'].includes(item.target.mappingState)).length,
  };
}

function patterns(records, coverage) {
  const grouped = new Map();
  records.forEach((record) => {
    const key = record.patternId || `unresolved:${record.source}:${record.target.sourceEntityName || 'unknown'}`;
    const current = grouped.get(key) || { patternId: key, records: [] };
    current.records.push(record); grouped.set(key, current);
  });
  const entityById = new Map((coverage?.entities || []).map((item) => [String(item.groupId), item]));
  return [...grouped.values()].map((entry) => {
    const first = entry.records[0]; const target = first.target; const entity = entityById.get(entry.patternId);
    return {
      patternId: entry.patternId,
      pattern: entity?.canonicalEntity?.canonicalName || first.title || 'Unresolved source identity',
      occurrences: entry.records.length,
      source: first.source,
      knownFields: [target.sourceEntityName, target.application, target.service, target.environment,
        target.host, target.node, target.tier, target.businessTransaction, target.ruleName]
        .map(cleanText).filter(Boolean).filter((value, index, items) => items.indexOf(value) === index),
      missingFields: target.evidenceMissing || [],
      candidateEntities: target.candidateEntities || [],
      acceptedEntity: ACCEPTED_STATES.has(target.mappingState) ? {
        id: target.sourceEntityId, name: target.sourceEntityName, type: target.sourceEntityType,
      } : null,
      conflict: target.mappingState === 'CONFLICT', mappingState: target.mappingState,
      reason: target.reasoning,
      handoffStatus: target.handoffStatus,
      priority: entry.records.length * (MONITORING_SOURCES.has(first.source) ? 4 : 1)
        * ((target.evidenceUsed || []).length ? 2 : 1),
    };
  }).sort((left, right) => right.priority - left.priority || right.occurrences - left.occurrences || left.pattern.localeCompare(right.pattern));
}

function blockers(records) {
  return records.filter((item) => item.blocker).reduce((result, item) => ({
    ...result, [item.blocker]: Number(result[item.blocker] || 0) + 1,
  }), { NO_ENTITY: 0, IDENTITY_CONFLICT: 0, UNSUPPORTED_SOURCE: 0, NO_SOURCE_IDENTITY: 0 });
}

function examples(records) {
  const acceptedFor = (source) => records.find((item) => item.source === source && item.ready) || null;
  const safe = (record) => record ? {
    alertNumber: record.alertNumber, source: record.source, entity: record.target.sourceEntityName,
    entityId: record.target.sourceEntityId, mappingState: record.target.mappingState,
    evidence: record.target.evidenceUsed, handoffStatus: record.target.handoffStatus,
  } : null;
  return {
    appDynamics: safe(acceptedFor('AppDynamics')), grafana: safe(acceptedFor('Grafana')),
    nagios: safe(acceptedFor('Nagios')), thousandEyes: safe(acceptedFor('ThousandEyes')),
    conflict: safe(records.find((item) => item.target.mappingState === 'CONFLICT')),
    candidateBlocked: safe(records.find((item) => item.target.mappingState === 'CANDIDATE')),
  };
}

function identitySourceBreakdown(records) {
  return [...MONITORING_SOURCES, 'Other'].map((source) => {
    const items = source === 'Other' ? records.filter((item) => !MONITORING_SOURCES.has(item.source))
      : records.filter((item) => item.source === source);
    return {
      source,
      total: items.length,
      resolved: items.filter((item) => item.ready).length,
      remaining: items.filter((item) => !item.ready).length,
      noSourceIdentity: items.filter((item) => item.blocker === 'NO_SOURCE_IDENTITY').length,
    };
  });
}

function buildStatus(data, coverage, latestRun = null) {
  const records = identityRecords(data, coverage);
  const audit = patterns(records, coverage);
  const stateCounts = countsByState(records);
  const ready = records.filter((item) => item.ready).length;
  return {
    phase: '5F', resolverVersion: SOURCE_IDENTITY_CONFIG.resolverVersion,
    evaluatedAt: data?.evaluatedAt || new Date().toISOString(), range: '24h',
    decisions: decisionCounts(data), identity: {
      ...stateCounts, total: records.length, ready, incomplete: records.length - ready,
      evidenceUnlockCoveragePercentage: percentage(ready, records.length),
    },
    patterns: {
      analyzed: audit.length,
      resolved: audit.filter((item) => item.handoffStatus === 'IDENTITY_READY').length,
      unresolved: audit.filter((item) => item.handoffStatus !== 'IDENTITY_READY').length,
      audit,
    },
    blockers: blockers(records), examples: examples(records), records,
    sourceBreakdown: identitySourceBreakdown(records),
    sourceDiscovery: coverage?.sourceDiscovery || null,
    decisionQuality: decisionQuality(data),
    positiveNoiseEvidence: positiveNoiseEvidence(data),
    rawExtraction: coverage?.rawPayloadFieldCoverage || null,
    inventory: coverage?.inventory || null,
    execution: {
      maxConcurrency: SOURCE_IDENTITY_CONFIG.coverageConcurrency,
      inventoryCacheHit: coverage?.performance?.cacheHit === true,
      persistentIdentityRegistry: true,
    },
    lastRun: latestRun,
    outputs: ['IDENTITY_READY', 'IDENTITY_INCOMPLETE'],
    safeguards: { readOnly: true, externalMutations: 'none', aiUsed: false,
      automaticSuppression: 'none', automaticTuning: 'none', classificationRulesChanged: false },
  };
}

function transitionAudit(before, after, beforeStatus, afterStatus, evidenceRun) {
  const beforeById = new Map(before.records.map((item) => [item.occurrenceId, item]));
  const afterById = new Map(after.records.map((item) => [item.occurrenceId, item]));
  const beforeDecisions = new Map((beforeStatus?.occurrences || []).map((item) => [item.occurrenceId, item.canonicalAssessment?.finalDecision?.decision]));
  const afterDecisions = new Map((afterStatus?.occurrences || []).map((item) => [item.occurrenceId, item.canonicalAssessment?.finalDecision?.decision]));
  const common = [...afterById.keys()].filter((id) => beforeById.has(id));
  const identityUnlocked = common.filter((id) => !beforeById.get(id).ready && afterById.get(id).ready);
  const changed = common.filter((id) => beforeDecisions.get(id) !== afterDecisions.get(id));
  const identityDriven = changed.filter((id) => identityUnlocked.includes(id));
  return {
    identityUnlocked,
    identityDrivenTransitions: identityDriven.map((id) => ({ occurrenceId: id, from: beforeDecisions.get(id), to: afterDecisions.get(id) })),
    evidenceDrivenTransitions: changed.filter((id) => !identityUnlocked.includes(id)).map((id) => ({ occurrenceId: id, from: beforeDecisions.get(id), to: afterDecisions.get(id) })),
    populationDrift: evidenceRun?.transitionAudit ? {
      added: evidenceRun.transitionAudit.addedAlertIds?.length || 0,
      dropped: evidenceRun.transitionAudit.droppedAlertIds?.length || 0,
    } : { added: [...afterById.keys()].filter((id) => !beforeById.has(id)).length,
      dropped: [...beforeById.keys()].filter((id) => !afterById.has(id)).length },
  };
}

function createStore() {
  let ready;
  const ensure = () => {
    if (!ready) ready = db.query(`
      CREATE TABLE IF NOT EXISTS source_identity_completion_runs (
        run_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        report JSONB NOT NULL DEFAULT '{}'::jsonb,
        started_at TIMESTAMPTZ NOT NULL,
        completed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    return ready;
  };
  return {
    async save(run) {
      await ensure();
      await db.query(`INSERT INTO source_identity_completion_runs (run_id,status,report,started_at,completed_at)
        VALUES ($1,$2,$3::jsonb,$4,$5) ON CONFLICT (run_id) DO UPDATE SET status=EXCLUDED.status,
        report=EXCLUDED.report, completed_at=EXCLUDED.completed_at`,
      [run.runId, run.status, JSON.stringify(run), run.startedAt, run.completedAt || null]);
    },
    async latest() {
      await ensure();
      const result = await db.query('SELECT report FROM source_identity_completion_runs ORDER BY created_at DESC LIMIT 1');
      return result.rows[0]?.report || null;
    },
  };
}

function createSourceIdentityCompletionService({
  identity = identityService, decisions = decisionService, evidenceCompletion = evidenceCompletionService,
  store = createStore(), now = () => Date.now(),
} = {}) {
  let activeRun = null; let latestRun = null;

  async function getStatus(options = {}) {
    if (!latestRun) { try { latestRun = await store.latest(); } catch { latestRun = null; } }
    const [data, coverage] = await Promise.all([
      decisions.evaluate({ refresh: options.refresh, sourceDiscovery: true }),
      loadCoverage(identity, String(options.refresh || '').toLowerCase() === 'true', true),
    ]);
    return buildStatus(data, coverage, latestRun);
  }

  async function run(options = {}) {
    if (activeRun) {
      const error = new Error('A source-identity completion run is already active.');
      error.code = 'SOURCE_IDENTITY_COMPLETION_ALREADY_RUNNING'; error.safeMessage = error.message; error.status = 409; throw error;
    }
    const startedAt = new Date(now()).toISOString();
    activeRun = { runId: `phase5f-${now()}`, status: 'RUNNING', startedAt };
    try {
      const [beforeData, beforeCoverage] = await Promise.all([
        decisions.evaluate({ refresh: false, sourceDiscovery: false }),
        loadCoverage(identity, false, false),
      ]);
      const before = buildStatus(beforeData, beforeCoverage, latestRun);
      await store.save(activeRun);
      if (typeof identity.clearCache === 'function') identity.clearCache();
      const afterIdentityCoverage = await loadCoverage(identity, true, true);
      const afterIdentity = buildStatus(beforeData, afterIdentityCoverage, latestRun);
      const unlocked = afterIdentity.records.filter((item) => item.ready
        && !before.records.find((previous) => previous.occurrenceId === item.occurrenceId)?.ready);
      const evidenceRun = unlocked.length > 0
        ? await evidenceCompletion.run({ batchSize: options.batchSize || 25, signal: options.signal }) : null;
      const afterData = await decisions.evaluate({ refresh: false, sourceDiscovery: true });
      const after = buildStatus(afterData, afterIdentityCoverage, latestRun);
      const transitions = transitionAudit(before, after, beforeData, afterData, evidenceRun);
      latestRun = {
        runId: activeRun.runId, status: 'COMPLETED', startedAt, completedAt: new Date(now()).toISOString(),
        before: { decisions: before.decisions, identity: before.identity },
        after: { decisions: after.decisions, identity: after.identity },
        patternsAnalyzed: after.patterns.analyzed,
        patternsResolved: Math.max(0, after.patterns.resolved - before.patterns.resolved),
        occurrencesUnlocked: unlocked.length,
        sourceDiscovery: after.sourceDiscovery,
        decisionQuality: {
          before: before.decisionQuality,
          after: after.decisionQuality,
          classificationUncertaintyReduction: Math.max(0,
            Number(before.decisionQuality?.classificationUnknown || 0) - Number(after.decisionQuality?.classificationUnknown || 0)),
        },
        positiveNoiseEvidence: after.positiveNoiseEvidence,
        remainingBlockers: after.blockers,
        rawExtraction: after.rawExtraction,
        sourceBreakdown: after.sourceBreakdown,
        transitions,
        evidenceUnlock: {
          packagesReused: Number(evidenceRun?.acquisition?.performance?.cacheHits || evidenceRun?.acquisition?.persistence?.persistedPackagesInUse || 0),
          newEvidencePackages: Number(evidenceRun?.acquisition?.processed || evidenceRun?.acquisition?.summary?.processed || 0),
          externalSourceCalls: Number(evidenceRun?.acquisition?.performance?.externalApiCalls || 0),
          telemetryReturned: Number(evidenceRun?.acquisition?.coverage?.telemetryCoverage?.count || 0),
          sourceNativeEvents: Number(evidenceRun?.acquisition?.evidence?.sourceNativeEvents || 0),
          relatedNotifications: Number(evidenceRun?.acquisition?.evidence?.relatedNotifications || 0),
          jiraInspections: Number(evidenceRun?.acquisition?.coverage?.jiraInspectionCoverage?.count || 0),
          slackInspections: Number(evidenceRun?.acquisition?.coverage?.slackInspectionCoverage?.count || 0),
        },
        safeguards: after.safeguards,
      };
      await store.save(latestRun);
      return { ...after, before: { decisions: before.decisions, identity: before.identity },
        after: { decisions: after.decisions, identity: after.identity }, lastRun: latestRun };
    } catch (error) {
      const failed = { ...activeRun, status: 'FAILED', completedAt: new Date(now()).toISOString(), safeError: cleanText(error.safeMessage || error.message) };
      try { await store.save(failed); } catch { /* Preserve the original error. */ }
      throw error;
    } finally { activeRun = null; }
  }

  return { getStatus, run, status: () => activeRun };
}

module.exports = {
  ACCEPTED_STATES, buildStatus, countsByState, createSourceIdentityCompletionService,
  decisionQuality, identityRecords, identitySourceBreakdown, loadCoverage, positiveNoiseEvidence,
  service: createSourceIdentityCompletionService(), targetForOccurrence,
};
