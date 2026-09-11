const NOISE_EVIDENCE_ENRICHMENT_CONFIG = Object.freeze({
  afterMinutes: 10,
  actionabilityModelVersion: 'phase3-actionability-v2',
  beforeMinutes: 5,
  cacheTtlMs: 10 * 60 * 1000,
  defaultBatchSize: 25,
  enrichmentModelVersion: 'phase4-shared-evidence-adapters-v1',
  highNoiseThreshold: 60,
  maxAuditEntries: 500,
  maxBatchSize: 100,
  maxConcurrentOperations: 3,
  maxWindowMinutes: 60,
  sourceOperationTimeoutMs: 10 * 1000,
});

module.exports = { NOISE_EVIDENCE_ENRICHMENT_CONFIG };
