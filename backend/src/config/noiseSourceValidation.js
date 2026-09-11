const NOISE_SOURCE_VALIDATION_CONFIG = Object.freeze({
  afterMinutes: 5,
  beforeMinutes: 5,
  maxConcurrentSourceQueries: 3,
  maxEvidencePerSource: 12,
  maxOccurrences: 12,
  maxWindowMinutes: 60,
  timeoutMs: 60 * 1000,
});

module.exports = { NOISE_SOURCE_VALIDATION_CONFIG };
