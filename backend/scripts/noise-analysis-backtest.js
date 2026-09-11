require('dotenv').config({ path: require('node:path').resolve(__dirname, '../.env') });
// The backtest emits one structured report; normal client request logs are
// intentionally suppressed so operational identifiers are not duplicated.
console.log = () => {};

const { service } = require('../src/services/noiseAnalysis.service');
const { scoreDistribution } = require('../src/services/noiseScoring.service');
const { service: evidenceService } = require('../src/services/noiseEvidence.service');

const riskOrder = Object.freeze({ LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 });

function labelCount(groups, label) {
  return groups.filter((group) => (group.labels || []).includes(label)).length;
}

function rankingChanges(groups) {
  const oldRanking = [...groups].sort((left, right) => right.oldNoiseScore - left.oldNoiseScore);
  const newRanking = [...groups].sort((left, right) => right.noiseLikelihood - left.noiseLikelihood);
  const oldPositions = new Map(oldRanking.map((group, index) => [group.groupId, index + 1]));
  const newPositions = new Map(newRanking.map((group, index) => [group.groupId, index + 1]));
  return groups.map((group) => ({
    correlationConfidence: 'on_demand',
    delta: group.noiseLikelihood - group.oldNoiseScore,
    groupId: group.groupId,
    labels: group.labels,
    newNoiseLikelihood: group.noiseLikelihood,
    newRank: newPositions.get(group.groupId),
    occurrences: group.occurrences,
    oldNoiseScore: group.oldNoiseScore,
    oldRank: oldPositions.get(group.groupId),
    pattern: String(group.pattern || '').slice(0, 180),
    primaryClassification: group.primaryClassification,
    recommendation: group.recommendation,
    reviewRisk: group.reviewRisk?.level,
  })).sort((left, right) => Math.abs(right.delta) - Math.abs(left.delta) || right.newNoiseLikelihood - left.newNoiseLikelihood).slice(0, 20);
}

async function run() {
  const startedAt = Date.now();
  const result = await service.analyzeRange('90d', true);
  const groups = result.groups;
  const highestRisk = groups.reduce((highest, group) => (
    riskOrder[group.reviewRisk?.level] > riskOrder[highest] ? group.reviewRisk.level : highest
  ), 'LOW');
  const top20Changes = rankingChanges(groups);
  const correlationErrors = [];
  for (const item of top20Changes) {
    try {
      const evidence = await evidenceService.getEvidence(item.groupId, { range: '90d', refresh: true });
      item.correlationConfidence = evidence.confidence.score;
    } catch (error) {
      item.correlationConfidence = null;
      correlationErrors.push({ groupId: item.groupId, message: error.safeMessage || error.message || 'Evidence lookup failed.' });
    }
  }
  const report = {
    analysisExecutionTimeMs: result.analysisExecutionTimeMs,
    alertsAnalyzed: result.alertsAnalyzed,
    autoResolution: result.coverage.autoResolution,
    complete: result.complete,
    coveragePercentage: result.coveragePercentage,
    executionTimeMs: Date.now() - startedAt,
    groups: groups.length,
    highestCorrelationConfidence: Math.max(0, ...top20Changes.map((item) => item.correlationConfidence).filter(Number.isFinite)),
    correlationConfidenceCoverage: { attempted: top20Changes.length, failed: correlationErrors.length, succeeded: top20Changes.length - correlationErrors.length },
    correlationErrors,
    highestNoiseLikelihood: Math.max(0, ...groups.map((group) => group.noiseLikelihood)),
    highestReviewRisk: highestRisk,
    humanToilGroups: labelCount(groups, 'high_human_toil'),
    labels: {
      autoResolved: labelCount(groups, 'auto_resolved'),
      crossAlertCluster: labelCount(groups, 'cross_alert_cluster'),
      duplicate: labelCount(groups, 'duplicate'),
      flapping: labelCount(groups, 'flapping'),
      flappingLike: labelCount(groups, 'flapping_like'),
      recurring: labelCount(groups, 'recurring'),
    },
    multiLabelGroups: groups.filter((group) => (group.labels || []).length > 1).length,
    newDistribution: scoreDistribution(groups, 'noiseLikelihood'),
    oldDistribution: scoreDistribution(groups, 'oldNoiseScore'),
    scoreRangeCounts: {
      atLeast20: groups.filter((group) => group.noiseLikelihood >= 20).length,
      atLeast40: groups.filter((group) => group.noiseLikelihood >= 40).length,
      atLeast60: groups.filter((group) => group.noiseLikelihood >= 60).length,
      atLeast80: groups.filter((group) => group.noiseLikelihood >= 80).length,
    },
    top20Changes,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

run().catch((error) => {
  process.stderr.write(`${JSON.stringify({ code: error.code || 'BACKTEST_FAILED', message: error.safeMessage || error.message || 'Backtest failed.' })}\n`);
  process.exitCode = 1;
});
