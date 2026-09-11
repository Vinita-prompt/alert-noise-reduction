const { NOISE_ANALYSIS_CONFIG } = require('../config/noiseAnalysis');
const { NOISE_REDUCTION_CONFIG } = require('../config/noiseReduction');
const { service: noiseAnalysisService } = require('./noiseAnalysis.service');

const DAY_MS = 24 * 60 * 60 * 1000;

function safeError(message, code, status = 400) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function round(value, digits = 1) {
  const factor = 10 ** digits;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}

function toMs(value) {
  const result = Date.parse(value || '');
  return Number.isFinite(result) ? result : null;
}

function canonicalAlertId(alert = {}) {
  return String(alert.canonicalOperationsId || alert.id || '').trim() || null;
}

function sourceName(alert = {}) {
  return String(alert.sourceSystem || alert.source || 'Other').trim() || 'Other';
}

function uniqueAlertMap(alerts = []) {
  const values = new Map();
  alerts.forEach((alert) => {
    const id = canonicalAlertId(alert);
    if (id && !values.has(id)) values.set(id, alert);
  });
  return values;
}

function detectorGroups(group = {}) {
  return group._detectorGroups || group.detectorGroups || [];
}

function sortedUniqueAlerts(alerts = [], include = () => true) {
  return [...uniqueAlertMap(alerts.filter(include)).values()].sort((left, right) => {
    const delta = (toMs(left.createdAt) || 0) - (toMs(right.createdAt) || 0);
    return delta || String(canonicalAlertId(left)).localeCompare(String(canonicalAlertId(right)));
  });
}

function duplicateReductionIds(group, include = () => true) {
  const reducible = new Set();
  detectorGroups(group).filter((item) => item.classification === 'duplicate').forEach((burst) => {
    const alerts = sortedUniqueAlerts(burst.alerts, include);
    alerts.slice(1).forEach((alert) => reducible.add(canonicalAlertId(alert)));
  });
  return reducible;
}

function flappingLikeReductionIds(group, include = () => true) {
  const reducible = new Set();
  detectorGroups(group).filter((item) => item.classification === 'flapping_like').forEach((burst) => {
    const alerts = sortedUniqueAlerts(burst.alerts, include);
    alerts.slice(1).forEach((alert) => reducible.add(canonicalAlertId(alert)));
  });
  return reducible;
}

function setUnion(...sets) {
  return new Set(sets.flatMap((set) => [...set]));
}

function setIntersection(left, right) {
  return new Set([...left].filter((value) => right.has(value)));
}

function reductionRecommendation(group, potentiallyReducible, excludedByRisk) {
  if (!potentiallyReducible) return 'No deterministic consolidation opportunity in this simulation.';
  if (excludedByRisk) return `${potentiallyReducible} repetitive occurrence${potentiallyReducible === 1 ? '' : 's'} identified; manual review required.`;
  const mechanisms = [];
  if ((group.labels || []).includes('duplicate')) mechanisms.push('duplicate burst grouping');
  if ((group.labels || []).includes('flapping_like')) mechanisms.push('flapping cooldown');
  return `Review ${mechanisms.join(' and ') || 'alert-rule'} tuning while retaining representative notifications.`;
}

function simulateGroup(group, {
  include = () => true,
  minNoiseLikelihood = 60,
  scenario = 'conservative',
  excludedReviewRisks = ['HIGH', 'CRITICAL'],
} = {}) {
  const alerts = sortedUniqueAlerts(group.alerts, include);
  const alertIds = new Set(alerts.map(canonicalAlertId));
  const qualifies = Number(group.noiseLikelihood) >= minNoiseLikelihood;
  const reviewRisk = String(group.reviewRisk?.level || 'LOW').toUpperCase();
  const manualReviewRequired = ['HIGH', 'CRITICAL'].includes(reviewRisk);
  const excludedByRisk = scenario === 'conservative' && excludedReviewRisks.includes(reviewRisk);
  const rawDuplicate = qualifies ? duplicateReductionIds(group, include) : new Set();
  const rawFlapping = qualifies ? flappingLikeReductionIds(group, include) : new Set();
  const technicalReducible = setUnion(rawDuplicate, rawFlapping);
  const duplicateIds = excludedByRisk ? new Set() : rawDuplicate;
  const flappingLikeIds = excludedByRisk ? new Set() : rawFlapping;
  const reducibleIds = excludedByRisk ? new Set() : technicalReducible;
  const overlapIds = setIntersection(duplicateIds, flappingLikeIds);
  const potentiallyReducible = reducibleIds.size;
  const occurrences = alertIds.size;
  const mechanism = [
    ...(rawDuplicate.size ? ['Duplicate consolidation'] : []),
    ...(rawFlapping.size ? ['Flapping cooldown'] : []),
  ];
  return {
    alertIds,
    alerts,
    candidate: qualifies,
    duplicateIds,
    excludedByRisk,
    flappingLikeIds,
    groupId: group.groupId,
    manualReviewRequired,
    mechanism,
    occurrences,
    overlapIds,
    pattern: group.pattern,
    potentiallyReducible,
    preserved: Math.max(0, occurrences - potentiallyReducible),
    rawTechnicalReducible: technicalReducible.size,
    recommendation: reductionRecommendation(group, technicalReducible.size, excludedByRisk),
    reducibleIds,
    reductionPercentage: occurrences ? round(potentiallyReducible / occurrences * 100, 1) : 0,
    reviewRisk,
    source: group.source || group.sources?.join(' + ') || 'Other',
    noiseLikelihood: Number(group.noiseLikelihood || 0),
    duplicateBursts: Number(group.duplicateBurstCount || 0),
    flappingLikeTransitions: Number(group.flappingLikeEvidence?.transitions || 0),
  };
}

function sourceBreakdown(allAlerts, candidateIds, reducibleIds) {
  const rows = new Map();
  uniqueAlertMap(allAlerts).forEach((alert, id) => {
    const source = sourceName(alert);
    const row = rows.get(source) || { alerts: 0, noiseCandidateAlerts: 0, reducible: 0, source };
    row.alerts += 1;
    if (candidateIds.has(id)) row.noiseCandidateAlerts += 1;
    if (reducibleIds.has(id)) row.reducible += 1;
    rows.set(source, row);
  });
  return [...rows.values()].map((row) => ({
    ...row,
    reductionPercentage: row.alerts ? round(row.reducible / row.alerts * 100, 1) : 0,
  })).sort((left, right) => right.reducible - left.reducible || right.alerts - left.alerts || left.source.localeCompare(right.source));
}

function paretoFor(contributors, total) {
  const share = (limit) => total ? round(contributors.slice(0, limit).reduce((sum, item) => sum + item.potentiallyReducible, 0) / total * 100, 1) : 0;
  return { top5Percentage: share(5), top10Percentage: share(10), top20Percentage: share(20) };
}

function simulateScenario(analysis, {
  config = NOISE_REDUCTION_CONFIG,
  include = () => true,
  minNoiseLikelihood = config.defaultMinNoiseLikelihood,
  scenario = 'conservative',
} = {}) {
  const allAlerts = (analysis._normalizedAlerts || analysis.normalizedAlerts || []).filter(include);
  const totalAlertMap = uniqueAlertMap(allAlerts);
  const candidateIds = new Set();
  const allPatternIds = new Set();
  const duplicateIds = new Set();
  const flappingIds = new Set();
  const groupResults = analysis.groups.map((group) => {
    sortedUniqueAlerts(group.alerts, include).forEach((alert) => allPatternIds.add(canonicalAlertId(alert)));
    const result = simulateGroup(group, {
      include,
      minNoiseLikelihood,
      scenario,
      excludedReviewRisks: config.conservativeExcludedReviewRisks,
    });
    if (result.candidate) result.alertIds.forEach((id) => candidateIds.add(id));
    result.duplicateIds.forEach((id) => duplicateIds.add(id));
    result.flappingLikeIds.forEach((id) => flappingIds.add(id));
    return result;
  });
  const reducibleIds = setUnion(duplicateIds, flappingIds);
  const overlapIds = setIntersection(duplicateIds, flappingIds);
  const contributors = groupResults.filter((item) => item.candidate && (item.potentiallyReducible || item.excludedByRisk)).map((item) => ({
    duplicateBursts: item.duplicateBursts,
    flappingLikeTransitions: item.flappingLikeTransitions,
    groupId: item.groupId,
    manualReviewRequired: item.manualReviewRequired,
    noiseLikelihood: item.noiseLikelihood,
    occurrences: item.occurrences,
    pattern: item.pattern,
    potentiallyReducible: item.potentiallyReducible,
    rawTechnicalReducible: item.rawTechnicalReducible,
    recommendation: item.recommendation,
    reductionPercentage: item.reductionPercentage,
    reviewRisk: item.reviewRisk,
    source: item.source,
  })).sort((left, right) => right.potentiallyReducible - left.potentiallyReducible || right.rawTechnicalReducible - left.rawTechnicalReducible || right.occurrences - left.occurrences || left.pattern.localeCompare(right.pattern));
  const acknowledgedReducible = [...reducibleIds].filter((id) => {
    const alert = totalAlertMap.get(id);
    return alert?.acknowledged === true || Boolean(alert?.ackTime);
  }).length;
  const totalAlerts = totalAlertMap.size;
  const potentiallyReducible = reducibleIds.size;
  const qualifyingGroups = analysis.groups.filter((group) => Number(group.noiseLikelihood) >= minNoiseLikelihood);
  const excluded = groupResults.filter((item) => item.candidate && item.excludedByRisk);
  const provenAutoResolvedIds = new Set();
  analysis.groups.forEach((group) => {
    detectorGroups(group).filter((item) => item.classification === 'auto_resolved').forEach((detector) => sortedUniqueAlerts(detector.alerts, include).forEach((alert) => {
      const id = canonicalAlertId(alert);
      if (id) provenAutoResolvedIds.add(id);
    }));
  });
  const autoResolvedOnlyIds = new Set([...provenAutoResolvedIds].filter((id) => !reducibleIds.has(id)));
  return {
    acknowledgedReducibleAlerts: acknowledgedReducible,
    alertsRepresented: allPatternIds.size,
    candidateIds,
    coverage: analysis.analysisCoverage,
    excludedByRisk: {
      groups: excluded.length,
      technicalOpportunityAlerts: new Set(excluded.flatMap((item) => [...setUnion(duplicateReductionIds(analysis.groups.find((group) => group.groupId === item.groupId), include), flappingLikeReductionIds(analysis.groups.find((group) => group.groupId === item.groupId), include))])).size,
    },
    humanToilImpact: {
      acknowledgedAlerts: acknowledgedReducible,
      repeatedAcknowledgementEvents: acknowledgedReducible,
    },
    mechanismBreakdown: {
      duplicateConsolidation: duplicateIds.size,
      flappingLikeConsolidation: flappingIds.size,
      overlapRemoved: overlapIds.size,
      uniqueTotal: potentiallyReducible,
    },
    minNoiseLikelihood,
    noiseCandidateAlerts: candidateIds.size,
    noiseCandidatePatterns: qualifyingGroups.length,
    noisePatterns: analysis.groups.length,
    pareto: paretoFor(contributors, potentiallyReducible),
    potentiallyReducible,
    potentialReductionPercentage: totalAlerts ? round(potentiallyReducible / totalAlerts * 100, 1) : 0,
    projectedAlerts: Math.max(0, totalAlerts - potentiallyReducible),
    recurringOnlyPatterns: analysis.groups.filter((group) => {
      const labels = group.labels || [];
      return labels.includes('recurring') && !labels.some((label) => ['duplicate', 'flapping_like', 'auto_resolved'].includes(label));
    }).length,
    reducibleIds,
    autoResolvedOnlyCandidates: autoResolvedOnlyIds.size,
    provenAutoResolvedOccurrences: provenAutoResolvedIds.size,
    scenario,
    sourceBreakdown: sourceBreakdown(allAlerts, candidateIds, reducibleIds),
    topContributors: contributors.slice(0, config.topContributorLimit),
    totalAlerts,
  };
}

function trendFor(analysis, options) {
  const rangeTo = toMs(analysis.rangeTo);
  if (!rangeTo || options.range === '7d') return { status: 'INSUFFICIENT_DATA' };
  const currentFrom = rangeTo - 7 * DAY_MS;
  const previousFrom = rangeTo - 14 * DAY_MS;
  const current = simulateScenario(analysis, { ...options, include: (alert) => {
    const time = toMs(alert.createdAt);
    return time !== null && time >= currentFrom && time <= rangeTo;
  } });
  const previous = simulateScenario(analysis, { ...options, include: (alert) => {
    const time = toMs(alert.createdAt);
    return time !== null && time >= previousFrom && time < currentFrom;
  } });
  if (!current.totalAlerts || !previous.totalAlerts) return { current, previous, status: 'INSUFFICIENT_DATA' };
  const change = round(current.potentialReductionPercentage - previous.potentialReductionPercentage, 1);
  return {
    changePercentagePoints: change,
    current: { potentialReductionPercentage: current.potentialReductionPercentage, potentiallyReducible: current.potentiallyReducible, totalAlerts: current.totalAlerts },
    previous: { potentialReductionPercentage: previous.potentialReductionPercentage, potentiallyReducible: previous.potentiallyReducible, totalAlerts: previous.totalAlerts },
    status: Math.abs(change) <= options.config.stableTrendPercentage ? 'STABLE' : change > 0 ? 'INCREASING' : 'DECREASING',
  };
}

function parseOptions(options, config) {
  const range = String(options.range || '7d').toLowerCase();
  if (!config.allowedRanges.includes(range)) throw safeError('range must be 7d, 30d, or 90d.', 'INVALID_NOISE_REDUCTION_RANGE');
  const scenario = String(options.scenario || 'conservative').toLowerCase();
  if (!['conservative', 'opportunity'].includes(scenario)) throw safeError('scenario must be conservative or opportunity.', 'INVALID_NOISE_REDUCTION_SCENARIO');
  const minNoiseLikelihood = options.minNoiseLikelihood === undefined || options.minNoiseLikelihood === ''
    ? config.defaultMinNoiseLikelihood
    : Number(options.minNoiseLikelihood);
  if (!Number.isFinite(minNoiseLikelihood) || minNoiseLikelihood < 0 || minNoiseLikelihood > 100) throw safeError('minNoiseLikelihood must be between 0 and 100.', 'INVALID_NOISE_REDUCTION_THRESHOLD');
  return { minNoiseLikelihood, range, refresh: String(options.refresh || '').toLowerCase() === 'true', scenario };
}

function createNoiseReductionService({
  analysisService = noiseAnalysisService,
  config = NOISE_REDUCTION_CONFIG,
} = {}) {
  async function getImpact(options = {}) {
    const parsed = parseOptions(options, config);
    const analysis = await analysisService.analyzeRange(parsed.range, parsed.refresh);
    const common = { config, minNoiseLikelihood: parsed.minNoiseLikelihood };
    const conservative = simulateScenario(analysis, { ...common, scenario: 'conservative' });
    const opportunity = simulateScenario(analysis, { ...common, scenario: 'opportunity' });
    const selected = parsed.scenario === 'opportunity' ? opportunity : conservative;
    const thresholdSensitivity = config.thresholds.map((threshold) => {
      const result = simulateScenario(analysis, { config, minNoiseLikelihood: threshold, scenario: parsed.scenario });
      return {
        alertsRepresented: result.noiseCandidateAlerts,
        patterns: result.noiseCandidatePatterns,
        potentiallyReducible: result.potentiallyReducible,
        potentialReductionPercentage: result.potentialReductionPercentage,
        threshold,
      };
    });
    const complete = analysis.analysisCoverage?.complete === true && analysis.analysisCoverage?.coveragePercentage === 100;
    return {
      ...selected,
      analysisModelVersion: NOISE_ANALYSIS_CONFIG.analysisModelVersion,
      analysisVersion: analysis.analysisVersion,
      coverage: {
        ...analysis.analysisCoverage,
        estimateStatus: complete ? 'COMPLETE_REDUCTION_ESTIMATE' : 'PARTIAL_REDUCTION_ESTIMATE',
        range: parsed.range,
      },
      externalMutations: 'none',
      modelVersion: config.modelVersion,
      range: parsed.range,
      readOnly: true,
      scenarios: {
        conservative: {
          acknowledgedReducibleAlerts: conservative.acknowledgedReducibleAlerts,
          mechanismBreakdown: conservative.mechanismBreakdown,
          potentiallyReducible: conservative.potentiallyReducible,
          potentialReductionPercentage: conservative.potentialReductionPercentage,
          projectedAlerts: conservative.projectedAlerts,
        },
        opportunity: {
          acknowledgedReducibleAlerts: opportunity.acknowledgedReducibleAlerts,
          mechanismBreakdown: opportunity.mechanismBreakdown,
          potentiallyReducible: opportunity.potentiallyReducible,
          potentialReductionPercentage: opportunity.potentialReductionPercentage,
          projectedAlerts: opportunity.projectedAlerts,
        },
      },
      thresholdSensitivity,
      trend: trendFor(analysis, { ...common, range: parsed.range, scenario: parsed.scenario }),
    };
  }

  async function getGroupImpact(groupId, options = {}) {
    const id = String(groupId || '').trim();
    if (!/^[a-f0-9]{24}$/.test(id)) throw safeError('A valid analysis group ID is required.', 'INVALID_NOISE_GROUP_ID');
    const parsed = parseOptions(options, config);
    const result = await analysisService.getGroup(id, { range: parsed.range, refresh: parsed.refresh });
    const group = result.group;
    const conservative = simulateGroup(group, { minNoiseLikelihood: parsed.minNoiseLikelihood, scenario: 'conservative', excludedReviewRisks: config.conservativeExcludedReviewRisks });
    const opportunity = simulateGroup(group, { minNoiseLikelihood: parsed.minNoiseLikelihood, scenario: 'opportunity', excludedReviewRisks: config.conservativeExcludedReviewRisks });
    return {
      analysisModelVersion: NOISE_ANALYSIS_CONFIG.analysisModelVersion,
      externalMutations: 'none',
      groupId: group.groupId,
      minNoiseLikelihood: parsed.minNoiseLikelihood,
      modelVersion: config.modelVersion,
      noiseLikelihood: group.noiseLikelihood,
      readOnly: true,
      reviewRisk: group.reviewRisk,
      scenarios: {
        conservative: {
          excludedByRisk: conservative.excludedByRisk,
          mechanism: conservative.mechanism,
          occurrences: conservative.occurrences,
          potentiallyReducible: conservative.potentiallyReducible,
          preserved: conservative.preserved,
          recommendation: conservative.recommendation,
          reductionPercentage: conservative.reductionPercentage,
        },
        opportunity: {
          manualReviewRequired: opportunity.manualReviewRequired,
          mechanism: opportunity.mechanism,
          occurrences: opportunity.occurrences,
          potentiallyReducible: opportunity.potentiallyReducible,
          preserved: opportunity.preserved,
          recommendation: opportunity.recommendation,
          reductionPercentage: opportunity.reductionPercentage,
        },
      },
    };
  }

  return { getGroupImpact, getImpact };
}

module.exports = {
  canonicalAlertId,
  createNoiseReductionService,
  duplicateReductionIds,
  flappingLikeReductionIds,
  paretoFor,
  simulateGroup,
  simulateScenario,
  sourceBreakdown,
  service: createNoiseReductionService(),
};
