// Phase 1 uses deliberately conservative, centralized thresholds. The values
// are tuned for an operator review queue: a single weak signal cannot create a
// high score and correlations require both identity and temporal evidence.
const NOISE_ANALYSIS_CONFIG = Object.freeze({
  analysisModelVersion: '2.6',
  analysisVersion: 'phase2.6-multilabel-v1',
  autoResolutionConcurrency: 6,
  cacheTtlMs: 5 * 60 * 1000,
  correlationWindowMinutes: 15,
  duplicateWindowMinutes: 5,
  flappingMinimumCycles: 3,
  flappingLikeMinimumTransitions: 3,
  flappingWindowMinutes: 60,
  longDurationMinutes: 60,
  maximumLifecycleInspections: 60,
  operationsPageSize: 100,
  // Atlassian requires offset + size to remain below 20,000. Large ranges
  // are divided into chronological windows before reaching that boundary.
  operationsWindowMaxAlerts: 19000,
  operationsRetryDelaysMs: Object.freeze([500, 1500]),
  recurringMinimumClusters: 2,
  recurringMinimumOccurrences: 3,
  shortDurationMinutes: 10,
  correlation: Object.freeze({
    minimumScore: 60,
    confidence: Object.freeze({ high: 75, medium: 60 }),
    weights: Object.freeze({
      exactSourceIdentifier: 35,
      sameApplication: 25,
      sameEnvironment: 10,
      sameHost: 35,
      sameMetricOrRule: 30,
      sameService: 30,
      timeProximity: 15,
    }),
  }),
  noiseScoreWeights: Object.freeze({
    autoResolved: 25,
    correlated: 15,
    duplicateBase: 25,
    duplicateOccurrence: 3,
    duplicateOccurrenceCap: 20,
    flapping: 30,
    highOperationalPriority: -15,
    humanAcknowledgement: -15,
    incidentOrProblem: -20,
    longDuration: -8,
    multiToolConfirmation: -10,
    noHumanAcknowledgement: 10,
    recurringBase: 20,
    recurringOccurrence: 2,
    recurringOccurrenceCap: 15,
    shortDuration: 8,
  }),
});

module.exports = { NOISE_ANALYSIS_CONFIG };
