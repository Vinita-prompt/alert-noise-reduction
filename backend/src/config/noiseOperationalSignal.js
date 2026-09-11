const NOISE_OPERATIONAL_SIGNAL_CONFIG = Object.freeze({
  actionabilityModelVersion: 'phase3-actionability-v2',
  afterMinutes: 10,
  beforeMinutes: 5,
  cacheTtlMs: 5 * 60 * 1000,
  evidenceModelVersion: 'phase4-shared-evidence-adapters-v1',
  mappingModelVersion: 'phase2.8-source-identity-v1',
  maxEventDurationMs: 24 * 60 * 60 * 1000,
  operationalSignalModelVersion: '4.2.0',
  operatorViewVersion: '4.3.3-evidence-projection',
});

module.exports = { NOISE_OPERATIONAL_SIGNAL_CONFIG };
