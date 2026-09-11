const NOISE_APPDYNAMICS_DECISION_POLICY = Object.freeze({
  phase: '4.4A.5',
  policyVersion: '4.4A.5',
  evaluatedRange: '24h',
  source: 'AppDynamics',
  sourceEventCompatibilityMs: 5 * 60 * 1000,
  acceptedMappingLevels: Object.freeze(['CONFIRMED_LOCAL', 'EXACT', 'STRONG']),
  activeEventStates: Object.freeze([
    'OPEN', 'STARTED', 'ACTIVE', 'CRITICAL', 'WARNING', 'VIOLATING',
    'POLICY_OPEN', 'POLICY_OPEN_CRITICAL', 'POLICY_OPEN_WARNING',
  ]),
  recoveryEventStates: Object.freeze([
    'CLOSE', 'CLOSED', 'RECOVERED', 'RESOLVED', 'ENDED',
    'POLICY_CLOSE', 'POLICY_CLOSE_CRITICAL', 'POLICY_CLOSE_WARNING',
  ]),
  meaningfulSeverities: Object.freeze(['ERROR', 'CRITICAL', 'WARN', 'WARNING', 'INFO']),
  rules: Object.freeze({
    sourceNativeIncident: Object.freeze({
      id: 'APPD_INCIDENT_SOURCE_NATIVE_VIOLATION_V1',
      version: '1.0.0',
      decision: 'INCIDENT',
      description: 'A complete AppDynamics source-native event chain confirms the condition represented by this notification.',
    }),
    directTelemetryIncident: Object.freeze({
      id: 'APPD_INCIDENT_DIRECT_TELEMETRY_V1',
      version: '1.0.0',
      decision: 'INCIDENT',
      description: 'Entity-scoped direct telemetry confirms the degradation represented by this notification.',
    }),
    redundantRealEventNoise: Object.freeze({
      id: 'APPD_NOISE_REDUNDANT_REAL_EVENT_V2',
      version: '2.0.0',
      decision: 'NOISE',
      description: 'The underlying event is confirmed and retained, while this later notification adds no distinct operational information.',
    }),
    exactDuplicateNoise: Object.freeze({
      id: 'APPD_NOISE_EXACT_DUPLICATE_V1',
      version: '1.0.0',
      decision: 'NOISE',
      description: 'A retained representative already carries the same source event identity, entity, condition, state, and timestamp.',
    }),
    flappingNotificationNoise: Object.freeze({
      id: 'APPD_NOISE_FLAPPING_NOTIFICATION_V1',
      version: '1.0.0',
      decision: 'NOISE',
      description: 'A source-native flapping event is retained, while this notification repeats a represented transition without new information.',
    }),
    transientNonActionableNoise: Object.freeze({
      id: 'APPD_NOISE_TRANSIENT_NON_ACTIONABLE_V1',
      version: '1.0.0',
      decision: 'NOISE',
      description: 'Direct source evidence confirms a recovered transient condition with no sustained degradation or distinct operator action.',
    }),
    repeatedRecoveryNoise: Object.freeze({
      id: 'APPD_NOISE_REPEATED_RECOVERY_V1',
      version: '1.0.0',
      decision: 'NOISE',
      description: 'An earlier recovery notification is retained and this later notification repeats the same confirmed recovery state without new information.',
    }),
    nonActionableSourceConditionNoise: Object.freeze({
      id: 'APPD_NOISE_NON_ACTIONABLE_SOURCE_CONDITION_V1',
      version: '1.0.0',
      decision: 'NOISE',
      description: 'Positive AppDynamics source evidence confirms the condition was non-actionable and recovered without a distinct operational action.',
    }),
    needsReview: Object.freeze({
      id: 'APPD_NEEDS_REVIEW_EVIDENCE_GAP_V1',
      version: '1.0.0',
      decision: 'NEEDS_REVIEW',
      description: 'Available evidence is insufficient, incompatible, stale, or conflicting for an automatic incident/noise decision.',
    }),
  }),
});

module.exports = { NOISE_APPDYNAMICS_DECISION_POLICY };
