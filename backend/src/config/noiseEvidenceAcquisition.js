const NOISE_EVIDENCE_ACQUISITION_CONFIG = Object.freeze({
  acquisitionVersion: 'phase4.1-evidence-coverage-expansion-v1',
  actionabilityModelVersion: 'phase3-actionability-v2',
  acceptedMappingLevels: Object.freeze(['EXACT', 'STRONG', 'CONFIRMED_LOCAL']),
  afterMinutes: 10,
  beforeMinutes: 5,
  defaultBatchSize: 25,
  defaultPatternLimit: 5,
  evidenceModelVersion: 'phase4-shared-evidence-adapters-v1',
  evidencePackageTtlMs: 7 * 24 * 60 * 60 * 1000,
  maxConcurrentSourceOperations: 3,
  maxOccurrencesPerPattern: 50,
  maxBatchSize: 100,
  maxPatternLimit: 100,
  sourceAdapterVersion: 'phase4-shared-evidence-adapters-v1',
  supportedBatchSizes: Object.freeze([25, 50, 100]),
  structurallyUnresolvedGaps: Object.freeze([
    'UNKNOWN_SOURCE',
    'IDENTITY_MISSING',
    'SOURCE_NOT_SUPPORTED',
  ]),
});

module.exports = { NOISE_EVIDENCE_ACQUISITION_CONFIG };
