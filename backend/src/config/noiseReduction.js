const NOISE_REDUCTION_CONFIG = Object.freeze({
  modelVersion: 'impact-baseline-v1',
  allowedRanges: Object.freeze(['7d', '30d', '90d']),
  defaultMinNoiseLikelihood: 60,
  thresholds: Object.freeze([50, 60, 70, 80]),
  conservativeExcludedReviewRisks: Object.freeze(['HIGH', 'CRITICAL']),
  stableTrendPercentage: 5,
  topContributorLimit: 20,
});

module.exports = { NOISE_REDUCTION_CONFIG };
