const NOISE_EVIDENCE_CONFIG = Object.freeze({
  cacheTtlMs: 5 * 60 * 1000,
  correlationWindowMinutes: 15,
  maxAlertWindows: 12,
  maxConcurrency: 3,
  maxEvidencePerSource: 25,
  maxJiraCandidates: 25,
  sourceTimeoutMs: 10 * 1000,
});

module.exports = { NOISE_EVIDENCE_CONFIG };
