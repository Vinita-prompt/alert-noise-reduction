require('dotenv').config();

const { service } = require('../src/services/episodeCorrelationDiscovery.service');

async function main() {
  const report = await service.discover({ refresh: true, limit: 50 });
  const compact = {
    generatedAt: report.generatedAt,
    policy: report.policy,
    summary: report.summary,
    sourceBreakdown: report.sourceBreakdown,
    reviewCandidateSourceDistribution: report.reviewCandidateSourceDistribution,
    missingData: report.missingData,
    candidateGroups: report.candidateGroups,
    topCandidates: report.topCandidates.map((candidate) => ({
      pairId: candidate.pairId,
      level: candidate.level,
      score: candidate.score,
      episodeA: candidate.episodeA,
      episodeB: candidate.episodeB,
      sources: candidate.sources,
      alertIds: candidate.alertIds,
      decisions: candidate.decisions,
      titles: candidate.titles,
      time: candidate.time,
      environment: candidate.environment,
      entities: candidate.entities,
      rules: candidate.rules,
      lifecycle: candidate.lifecycle,
      identityStrength: candidate.identityStrength,
      historical: candidate.historical,
      evidence: candidate.evidence,
      contradictoryEvidence: candidate.contradictoryEvidence,
      flags: candidate.flags,
    })),
    safeguards: report.safeguards,
  };
  const output = process.argv.includes('--report') ? {
    generatedAt: compact.generatedAt,
    policy: compact.policy,
    summary: compact.summary,
    sourceBreakdown: compact.sourceBreakdown,
    reviewCandidateSourceDistribution: compact.reviewCandidateSourceDistribution,
    missingData: compact.missingData,
    candidateGroups: compact.candidateGroups,
    candidates: compact.topCandidates.filter((candidate) => (
      ['STRONG_CORRELATION', 'MODERATE_CORRELATION'].includes(candidate.level)
    )),
    safeguards: compact.safeguards,
  } : process.argv.includes('--compact') ? compact : report;
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error?.safeMessage || error?.code || error?.message || 'Correlation discovery failed.'}\n`);
  process.exitCode = 1;
});
