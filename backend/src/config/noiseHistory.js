const NOISE_HISTORY_CONFIG = Object.freeze({
  historyModelVersion: 'phase3-history-v1',
  cacheTtlMs: 5 * 60 * 1000,
  allowedRanges: Object.freeze(['7d', '30d', '90d']),
  autoResolutionConcurrency: 6,
  clusterWindowMinutes: 5,
  stormMinimumOccurrences: 10,
  stormWindowMinutes: 60,
  trendMinimumAbsoluteChange: 2,
  trendMinimumSamples: 2,
  trendThresholdPercentage: 20,
  timePatternMinimumOccurrences: 5,
  timePatternMinimumShare: 0.15,
});

module.exports = { NOISE_HISTORY_CONFIG };
