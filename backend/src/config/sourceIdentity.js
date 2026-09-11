const SOURCE_IDENTITY_CONFIG = Object.freeze({
  cacheTtlMs: 10 * 60 * 1000,
  maxCandidatesPerSource: 3,
  minimumCandidateScore: 50,
  strongScore: 75,
  exactScore: 95,
  coverageConcurrency: 3,
  resolverVersion: 'phase5f-source-side-discovery-v1',
});

module.exports = { SOURCE_IDENTITY_CONFIG };
