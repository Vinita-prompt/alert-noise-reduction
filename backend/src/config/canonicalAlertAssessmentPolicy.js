const CANONICAL_ALERT_ASSESSMENT_POLICY = Object.freeze({
  modelVersion: 'canonical-alert-assessment-v1',
  evaluatedRange: '24h',
  historicalEvidenceMaximumRange: '90d',
  confidence: Object.freeze(['HIGH', 'MEDIUM', 'LOW']),
  noiseCategories: Object.freeze([
    'DUPLICATE', 'FLAPPING', 'AUTO_RESOLVED', 'NON_ACTIONABLE', 'CORRELATED', 'STALE', 'NONE', 'UNKNOWN',
  ]),
  classificationDomains: Object.freeze(['INFRASTRUCTURE', 'APPLICATION', 'NETWORK', 'DEPENDENCY', 'UNKNOWN']),
  classificationSubtypes: Object.freeze({
    INFRASTRUCTURE: Object.freeze(['CPU', 'MEMORY', 'DISK', 'VM', 'SERVER', 'CONTAINER', 'POD', 'NODE', 'OTHER']),
    APPLICATION: Object.freeze(['API_FAILURE', 'EXCEPTION', 'RESPONSE_TIME', 'DATABASE_CONNECTION', 'BUSINESS_TRANSACTION', 'ERROR_RATE', 'APPLICATION_HEALTH', 'OTHER']),
    NETWORK: Object.freeze(['PACKET_LOSS', 'HIGH_LATENCY', 'INTERFACE_DOWN', 'DNS', 'CONNECTIVITY', 'PATH', 'OTHER']),
    DEPENDENCY: Object.freeze(['DATABASE_UNAVAILABLE', 'EXTERNAL_API_FAILURE', 'PAYMENT_GATEWAY', 'DOWNSTREAM_SERVICE', 'THIRD_PARTY', 'OTHER']),
    UNKNOWN: Object.freeze(['UNKNOWN']),
  }),
  businessImpactLevels: Object.freeze(['BUSINESS_CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'UNKNOWN']),
  actionabilityValues: Object.freeze(['ACTIONABLE', 'NON_ACTIONABLE', 'UNKNOWN']),
  underlyingEventStatuses: Object.freeze([
    'CONFIRMED_INCIDENT', 'CONFIRMED_NON_ACTIONABLE_EVENT', 'NO_DISTINCT_EVENT', 'UNCONFIRMED', 'UNKNOWN',
  ]),
  notificationRoles: Object.freeze([
    'REPRESENTATIVE', 'REDUNDANT', 'DISTINCT_SIGNAL', 'ESCALATION', 'RECOVERY', 'TRANSIENT', 'UNKNOWN',
  ]),
  finalDecisions: Object.freeze(['INCIDENT', 'NOISE', 'NEEDS_REVIEW']),
  staleSynchronizationIntervalMs: 15 * 60 * 1000,
  rules: Object.freeze({
    incident: Object.freeze({
      id: 'CANONICAL_INCIDENT_CONFIRMED_USEFUL_NOTIFICATION_V1', version: '1.0.0', decision: 'INCIDENT',
      description: 'A confirmed operational incident is represented by a useful representative, distinct, escalation, or recovery notification.',
    }),
    redundantNoise: Object.freeze({
      id: 'CANONICAL_NOISE_REDUNDANT_CONFIRMED_EVENT_V1', version: '1.0.0', decision: 'NOISE',
      description: 'The underlying incident is real, but this notification is positively proven redundant and adds no new operational information.',
    }),
    nonActionableNoise: Object.freeze({
      id: 'CANONICAL_NOISE_CONFIRMED_NON_ACTIONABLE_EVENT_V1', version: '1.0.0', decision: 'NOISE',
      description: 'Positive source evidence confirms a non-actionable event that required no meaningful engineer intervention.',
    }),
    staleNoise: Object.freeze({
      id: 'CANONICAL_NOISE_STALE_NOTIFICATION_V1', version: '1.0.0', decision: 'NOISE',
      description: 'The authoritative source condition is resolved while the Operations notification remains open beyond the synchronization interval.',
    }),
    needsReview: Object.freeze({
      id: 'CANONICAL_NEEDS_REVIEW_INSUFFICIENT_EVIDENCE_V1', version: '1.0.0', decision: 'NEEDS_REVIEW',
      description: 'No approved canonical Incident or positive Noise rule has complete, compatible evidence.',
    }),
  }),
});

module.exports = { CANONICAL_ALERT_ASSESSMENT_POLICY };
