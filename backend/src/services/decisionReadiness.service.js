const DECISION_READINESS = Object.freeze({
  READY: 'READY_FOR_DECISION',
  INCOMPLETE: 'EVIDENCE_INCOMPLETE',
});

const DECISION_CRITICAL_FIELDS = Object.freeze([
  'alertIdentity',
  'sourceIdentity',
  'actionabilityEvidence',
  'underlyingEventEvidence',
  'notificationRoleEvidence',
  'noiseDetectionEvidence',
]);

function evaluateDecisionReadiness(assessment, evidencePlan) {
  const fieldByName = new Map((evidencePlan?.fields || []).map((item) => [item.field, item]));
  const relevantFields = assessment?.finalDecision?.decision === 'NOISE'
    ? DECISION_CRITICAL_FIELDS
    : DECISION_CRITICAL_FIELDS.filter((field) => field !== 'noiseDetectionEvidence');
  const missing = relevantFields.filter((field) => {
    const record = fieldByName.get(field);
    return !record || !['COLLECTED', 'VALIDATED'].includes(record.status);
  });
  const canonicalDecisionReady = assessment?.finalDecision?.decision !== 'NEEDS_REVIEW'
    && Boolean(assessment?.finalDecision?.ruleId)
    && Array.isArray(assessment?.finalDecision?.evidenceIds)
    && assessment.finalDecision.evidenceIds.length > 0;
  const status = canonicalDecisionReady && missing.length === 0
    ? DECISION_READINESS.READY : DECISION_READINESS.INCOMPLETE;
  return {
    status,
    missingDecisionEvidence: missing,
    businessImpactRequired: false,
    businessImpactStatus: fieldByName.get('businessImpactEvidence')?.status || 'UNAVAILABLE',
    reasoning: status === DECISION_READINESS.READY
      ? 'The canonical layer has the deterministic rule inputs and provenance required to evaluate this alert.'
      : 'One or more decision-critical evidence fields remain missing, partial, invalid, or conflicting.',
  };
}

module.exports = { DECISION_CRITICAL_FIELDS, DECISION_READINESS, evaluateDecisionReadiness };
