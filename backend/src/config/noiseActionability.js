const NOISE_ACTIONABILITY_CONFIG = Object.freeze({
  actionabilityModelVersion: 'phase3-actionability-v2',
  cacheTtlMs: 5 * 60 * 1000,
  deepCacheTtlMs: 2 * 60 * 1000,
  dominantThreshold: 0.7,
  duplicateWindowMinutes: 5,
  highNoiseThreshold: 60,
  sourceValidationVersion: 'phase2.8-identity-aware-source-validation-v1',
  sustainedDegradationMinutes: 10,
  transientRecoveryMinutes: 5,
});

module.exports = { NOISE_ACTIONABILITY_CONFIG };
