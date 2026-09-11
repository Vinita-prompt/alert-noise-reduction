const OPERATIONAL_DECISION_POLICY = Object.freeze({
  modelVersion: 'operational-decision-v2-appd-workflow',
  evaluatedRange: '24h',
  historicalEvidenceMaximumRange: '90d',
  decisions: Object.freeze(['INCIDENT', 'NOISE', 'NEEDS_REVIEW']),
  notificationRoles: Object.freeze(['REPRESENTATIVE', 'DISTINCT_SIGNAL', 'ESCALATION', 'RECOVERY', 'REDUNDANT', 'UNKNOWN']),
  monitoringSources: Object.freeze(['AppDynamics', 'Grafana', 'Nagios', 'ThousandEyes']),
  acceptedMappingLevels: Object.freeze(['EXACT', 'STRONG', 'CONFIRMED_LOCAL']),
  rules: Object.freeze({
    appDynamicsSourceNativeIncident: Object.freeze({
      id: 'APPD_WORKFLOW_INCIDENT_SOURCE_NATIVE_V1', version: '1.0.0', decision: 'INCIDENT',
      description: 'An authoritative AppDynamics violation matches the required entity, condition, state, and bounded source timestamp.',
    }),
    appDynamicsSustainedTelemetryIncident: Object.freeze({
      id: 'APPD_WORKFLOW_INCIDENT_SUSTAINED_TELEMETRY_V1', version: '1.0.0', decision: 'INCIDENT',
      description: 'AppDynamics telemetry matches the required entity and condition and proves a sustained or repeated degradation sequence.',
    }),
    appDynamicsEscalationIncident: Object.freeze({
      id: 'APPD_WORKFLOW_INCIDENT_ESCALATION_V1', version: '1.0.0', decision: 'INCIDENT',
      description: 'A confirmed AppDynamics event has materially new severity, entity, or condition evidence.',
    }),
    sourceNativeIncident: Object.freeze({
      id: 'OPERATIONAL_INCIDENT_SOURCE_NATIVE_V1', version: '1.0.0', decision: 'INCIDENT',
      description: 'Authoritative source-native evidence confirms a meaningful operational condition for an accepted entity and compatible time window.',
    }),
    directTelemetryIncident: Object.freeze({
      id: 'OPERATIONAL_INCIDENT_DIRECT_TELEMETRY_V1', version: '1.0.0', decision: 'INCIDENT',
      description: 'Entity-scoped telemetry matches the condition and proves sustained degradation inside the bounded occurrence window.',
    }),
    escalationIncident: Object.freeze({
      id: 'OPERATIONAL_INCIDENT_ESCALATION_V1', version: '1.0.0', decision: 'INCIDENT',
      description: 'This notification introduces a material severity, entity, condition, component, location, agent, or monitoring-source escalation.',
    }),
    recoveryIncident: Object.freeze({
      id: 'OPERATIONAL_INCIDENT_RECOVERY_V1', version: '1.0.0', decision: 'INCIDENT',
      description: 'The source workflow supplies a distinct operationally useful recovery transition.',
    }),
    redundantRealEventNoise: Object.freeze({
      id: 'OPERATIONAL_NOISE_REDUNDANT_REAL_EVENT_V1', version: '1.0.0', decision: 'NOISE',
      description: 'A confirmed operational event and retained representative already carry the same entity, condition, and lifecycle information.',
    }),
    exactDuplicateNoise: Object.freeze({
      id: 'OPERATIONAL_NOISE_EXACT_DUPLICATE_V1', version: '1.0.0', decision: 'NOISE',
      description: 'The notification repeats the same source event identity, entity, condition, state, and compatible event window.',
    }),
    flappingNotificationNoise: Object.freeze({
      id: 'OPERATIONAL_NOISE_FLAPPING_NOTIFICATION_V1', version: '1.0.0', decision: 'NOISE',
      description: 'A confirmed flapping event is retained while this notification repeats an already represented transition without new information.',
    }),
    transientNonActionableNoise: Object.freeze({
      id: 'OPERATIONAL_NOISE_TRANSIENT_NON_ACTIONABLE_V1', version: '1.0.0', decision: 'NOISE',
      description: 'Positive source evidence confirms a transient recovered condition without sustained degradation or distinct operator action.',
    }),
    repeatedRecoveryNoise: Object.freeze({
      id: 'OPERATIONAL_NOISE_REPEATED_RECOVERY_V1', version: '1.0.0', decision: 'NOISE',
      description: 'An earlier useful recovery is retained and this later notification repeats the same recovery state without new information.',
    }),
    nonActionableSourceConditionNoise: Object.freeze({
      id: 'OPERATIONAL_NOISE_NON_ACTIONABLE_SOURCE_CONDITION_V1', version: '1.0.0', decision: 'NOISE',
      description: 'Positive source evidence explicitly proves a recovered non-actionable condition.',
    }),
    needsReview: Object.freeze({
      id: 'OPERATIONAL_NEEDS_REVIEW_EVIDENCE_GAP_V1', version: '1.0.0', decision: 'NEEDS_REVIEW',
      description: 'No approved Incident or positive Noise rule has complete, compatible evidence.',
    }),
  }),
});

module.exports = { OPERATIONAL_DECISION_POLICY };
