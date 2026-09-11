const APPDYNAMICS_WORKFLOW_POLICY = Object.freeze({
  policyVersion: 'appd-workflow-policy-v1',
  statuses: Object.freeze({
    confirmed: 'CONFIRMED',
    matched: 'MATCHED',
    unknown: 'UNKNOWN',
    unresolved: 'UNRESOLVED',
    wrongEntity: 'WRONG_ENTITY',
    wrongMetric: 'WRONG_METRIC',
    active: 'ACTIVE',
    recovered: 'RECOVERED',
  }),
  rules: Object.freeze({
    sourceNative: 'APPD_WORKFLOW_INCIDENT_SOURCE_NATIVE_V1',
    sustainedTelemetry: 'APPD_WORKFLOW_INCIDENT_SUSTAINED_TELEMETRY_V1',
    escalation: 'APPD_WORKFLOW_INCIDENT_ESCALATION_V1',
  }),
  reviewRootCauses: Object.freeze([
    'NO_ENTITY',
    'NO_SOURCE_EVENT',
    'NO_TELEMETRY',
    'WRONG_METRIC',
    'WRONG_ENTITY',
    'PERSISTENCE_UNKNOWN',
    'EVENT_BOUNDARY_UNKNOWN',
    'OTHER',
  ]),
});

module.exports = { APPDYNAMICS_WORKFLOW_POLICY };
