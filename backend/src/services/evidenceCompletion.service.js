const { service: acquisitionService } = require('./noiseEvidenceAcquisition.service');
const { service: operationalDecisionService } = require('./operationalDecision.service');

function percentage(value, total) {
  return total ? Number((Number(value || 0) / Number(total) * 100).toFixed(1)) : 0;
}

function parseBatchSize(value) {
  const parsed = value === undefined || value === null || value === '' ? 25 : Number(value);
  if (![25, 50, 100].includes(parsed)) {
    const error = new Error('batchSize must be one of 25, 50, 100.');
    error.code = 'INVALID_EVIDENCE_COMPLETION_BATCH_SIZE';
    error.safeMessage = error.message;
    error.status = 400;
    throw error;
  }
  return parsed;
}

function decisionCounts(data) {
  const summary = data?.canonical?.summary || {};
  return {
    total: Number(summary.total || 0),
    incident: Number(summary.incident || 0),
    noise: Number(summary.noise || 0),
    needsReview: Number(summary.needsReview || 0),
    classificationCoveragePercentage: percentage(Number(summary.incident || 0) + Number(summary.noise || 0), Number(summary.total || 0)),
    humanReviewRatePercentage: percentage(Number(summary.needsReview || 0), Number(summary.total || 0)),
  };
}

function rootEvidenceGaps(data) {
  const counts = new Map();
  (data?.occurrences || []).filter((item) => item.canonicalAssessment?.finalDecision?.decision === 'NEEDS_REVIEW')
    .flatMap((item) => item.canonicalAssessment?.evidenceCompletion?.missingFields || [])
    .forEach((item) => counts.set(item.field, (counts.get(item.field) || 0) + 1));
  return [...counts.entries()].map(([field, count]) => ({ field, count }))
    .sort((left, right) => right.count - left.count || left.field.localeCompare(right.field));
}

function sourceCompletion(data) {
  const rows = new Map();
  (data?.occurrences || []).forEach((item) => {
    const source = item.source?.name || 'Unknown';
    const current = rows.get(source) || { source, alerts: 0, needsReview: 0, readyForDecision: 0,
      evidenceItems: 0, conflictingItems: 0 };
    const completion = item.canonicalAssessment?.evidenceCompletion;
    current.alerts += 1;
    current.needsReview += Number(item.canonicalAssessment?.finalDecision?.decision === 'NEEDS_REVIEW');
    current.readyForDecision += Number(completion?.readiness?.status === 'READY_FOR_DECISION');
    current.evidenceItems += completion?.inventory?.collected?.length || 0;
    current.conflictingItems += completion?.inventory?.conflicting?.length || 0;
    rows.set(source, current);
  });
  return [...rows.values()].sort((left, right) => right.alerts - left.alerts || left.source.localeCompare(right.source));
}

function examples(data) {
  const select = (decision) => (data?.occurrences || []).filter((item) => item.canonicalAssessment?.finalDecision?.decision === decision)
    .slice(0, 3).map((item) => ({
      alertId: item.occurrenceId,
      alertNumber: item.alert?.alertNumber || null,
      source: item.source?.name || 'Unknown',
      title: item.alert?.title || null,
      decision,
      evidenceIds: item.canonicalAssessment?.finalDecision?.evidenceIds || [],
      readiness: item.canonicalAssessment?.evidenceCompletion?.readiness?.status || 'EVIDENCE_INCOMPLETE',
      nextEvidenceAction: item.canonicalAssessment?.evidenceCompletion?.nextEvidenceAction || null,
    }));
  return { incident: select('INCIDENT'), noise: select('NOISE'), needsReview: select('NEEDS_REVIEW') };
}

function buildStatus(data, acquisition, run = null) {
  const completion = data?.canonical?.evidenceCoverage || {};
  const ready = (data?.occurrences || []).filter((item) => item.canonicalAssessment?.evidenceCompletion?.readiness?.status === 'READY_FOR_DECISION').length;
  const collectedItems = (data?.occurrences || []).reduce((sum, item) => sum
    + Number(item.canonicalAssessment?.evidenceCompletion?.inventory?.collected?.length || 0), 0);
  const validatedItems = (data?.occurrences || []).reduce((sum, item) => sum
    + (item.canonicalAssessment?.evidenceCompletion?.inventory?.collected || []).filter((evidence) => evidence.status === 'VALIDATED').length, 0);
  const reused = Number(acquisition?.performance?.cacheHits || acquisition?.persistence?.persistedPackagesInUse || 0);
  return {
    phase: '5C',
    modelVersion: 'evidence-completion-v1',
    evaluatedAt: data?.evaluatedAt || new Date().toISOString(),
    range: '24h',
    before: decisionCounts(data),
    evidenceCompletion: {
      alertsInspected: Number(completion.totalAlerts || 0),
      readyForDecision: ready,
      evidenceIncomplete: Math.max(0, Number(completion.totalAlerts || 0) - ready),
      evidenceItemsCollected: collectedItems,
      evidenceItemsValidated: validatedItems,
      evidenceItemsReused: reused,
      evidenceCollectionSuccessRate: percentage(validatedItems, collectedItems),
      provenanceCoveragePercentage: Number(completion.provenanceCoveragePercentage || 0),
      unsupportedEvidenceItems: Number(completion.unsupportedEvidenceItems || 0),
      coverageMatrix: completion.fields || [],
      sourceSpecificCoverage: completion.sourceSpecific || [],
    },
    rootEvidenceGaps: rootEvidenceGaps(data),
    sourceContribution: sourceCompletion(data),
    examples: examples(data),
    acquisition: acquisition || null,
    lastRun: run,
    safeguards: { readOnly: true, externalMutations: 'none', aiUsed: false,
      automaticSuppression: 'none', automaticTuning: 'none', decisionRulesChanged: false },
  };
}

function transitionAudit(beforeData, afterData) {
  const beforeRows = new Map((beforeData?.occurrences || []).map((item) => [item.occurrenceId, item]));
  const afterRows = new Map((afterData?.occurrences || []).map((item) => [item.occurrenceId, item]));
  const commonIds = [...afterRows.keys()].filter((id) => beforeRows.has(id));
  const changes = commonIds.map((id) => {
    const item = afterRows.get(id);
    const previousDecision = beforeRows.get(id)?.canonicalAssessment?.finalDecision?.decision || 'NEEDS_REVIEW';
    const newDecision = item.canonicalAssessment?.finalDecision?.decision || 'NEEDS_REVIEW';
    return {
      alertId: item.occurrenceId,
      alertNumber: item.alert?.alertNumber || null,
      previousDecision,
      newDecision,
      changed: previousDecision !== newDecision,
      reasonForChange: item.canonicalAssessment?.audit?.reasonForChange || (previousDecision === newDecision
        ? 'EVIDENCE_UPDATED_DECISION_UNCHANGED' : 'DECISION_CHANGED_AFTER_EVIDENCE_UPDATE'),
    };
  });
  const count = (rows, decision) => rows.filter((item) => item.canonicalAssessment?.finalDecision?.decision === decision).length;
  const beforeComparableRows = commonIds.map((id) => beforeRows.get(id));
  const afterComparableRows = commonIds.map((id) => afterRows.get(id));
  const comparable = (rows) => ({
    total: rows.length,
    incident: count(rows, 'INCIDENT'),
    noise: count(rows, 'NOISE'),
    needsReview: count(rows, 'NEEDS_REVIEW'),
  });
  return {
    changed: changes.filter((item) => item.changed),
    unchanged: changes.filter((item) => !item.changed).length,
    addedAlertIds: [...afterRows.keys()].filter((id) => !beforeRows.has(id)),
    droppedAlertIds: [...beforeRows.keys()].filter((id) => !afterRows.has(id)),
    comparablePopulation: commonIds.length,
    comparableBefore: comparable(beforeComparableRows),
    comparableAfter: comparable(afterComparableRows),
  };
}

function createEvidenceCompletionService({ acquisition = acquisitionService, decisions = operationalDecisionService } = {}) {
  let latestRun = null;
  let activeRun = null;

  async function getStatus(options = {}) {
    const [data, acquisitionStatus] = await Promise.all([
      decisions.evaluate({ refresh: options.refresh }),
      acquisition.getStatus({ range: '24h' }),
    ]);
    return buildStatus(data, acquisitionStatus, latestRun);
  }

  async function run(options = {}) {
    if (activeRun) {
      const error = new Error('An evidence-completion batch is already running.');
      error.code = 'EVIDENCE_COMPLETION_ALREADY_RUNNING';
      error.safeMessage = error.message;
      error.status = 409;
      throw error;
    }
    const batchSize = parseBatchSize(options.batchSize);
    const startedAt = new Date().toISOString();
    activeRun = { runId: `phase5c-${Date.now()}`, status: 'RUNNING', startedAt, batchSize };
    try {
      const beforeData = await decisions.evaluate({ refresh: false });
      const acquisitionRun = await acquisition.acquire({
        batchSize,
        forceRefresh: false,
        range: '24h',
        signal: options.signal,
      });
      const afterData = await decisions.evaluate({ refresh: true });
      const acquisitionStatus = await acquisition.getStatus({ range: '24h' });
      const afterCounts = decisionCounts(afterData);
      const beforeCounts = decisionCounts(beforeData);
      const audit = transitionAudit(beforeData, afterData);
      const comparableCoverageBefore = percentage(audit.comparableBefore.incident + audit.comparableBefore.noise, audit.comparableBefore.total);
      const comparableCoverageAfter = percentage(audit.comparableAfter.incident + audit.comparableAfter.noise, audit.comparableAfter.total);
      latestRun = {
        runId: activeRun.runId,
        startedAt,
        completedAt: new Date().toISOString(),
        batchSize,
        before: beforeCounts,
        after: afterCounts,
        evidenceDrivenReviewReduction: audit.changed.filter((item) => item.previousDecision === 'NEEDS_REVIEW'
          && item.newDecision !== 'NEEDS_REVIEW').length,
        classificationCoverageChange: Number((comparableCoverageAfter - comparableCoverageBefore).toFixed(1)),
        populationDrift: { added: audit.addedAlertIds.length, dropped: audit.droppedAlertIds.length },
        transitionAudit: audit,
        acquisition: acquisitionRun,
        reconciliation: afterCounts.incident + afterCounts.noise + afterCounts.needsReview === afterCounts.total,
        safeguards: { readOnly: true, externalMutations: 'none', aiUsed: false,
          automaticSuppression: 'none', automaticTuning: 'none', decisionRulesChanged: false },
      };
      return { ...buildStatus(afterData, acquisitionStatus, latestRun), before: beforeCounts, after: afterCounts,
        transitionAudit: audit };
    } finally {
      activeRun = null;
    }
  }

  function status() { return activeRun; }
  return { getStatus, run, status };
}

module.exports = {
  buildStatus,
  createEvidenceCompletionService,
  decisionCounts,
  parseBatchSize,
  service: createEvidenceCompletionService(),
  transitionAudit,
};
