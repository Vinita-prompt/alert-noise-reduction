const activeStatuses = new Set(['open', 'acknowledged', 'escalated', 'firing', 'triggered', 'investigating']);
const resolvedStatuses = new Set(['resolved', 'recovered', 'auto-resolved']);
const incidentSeverities = new Set(['critical', 'high']);
const mediumIncidentSeverities = new Set(['medium', 'warning']);

function normalizeClassification(row) {
  const isNoise = row.classification === 'noise';
  const isIncident = row.classification === 'incident';

  return {
    classification: row.classification,
    noiseType: row.noise_type || 'none',
    confidenceScore: row.confidence_score,
    isNoise,
    isIncident,
    isActionable: isIncident && !isNoise,
  };
}

function value(row, snakeKey, camelKey = snakeKey) {
  return row?.[snakeKey] ?? row?.[camelKey];
}

function normalizeText(valueToNormalize) {
  return String(valueToNormalize || '').toLowerCase();
}

function hasLowSignalLanguage(row) {
  const text = [
    value(row, 'title'),
    value(row, 'signal'),
    value(row, 'description'),
  ].map(normalizeText).join(' ');

  return [
    'informational',
    'info only',
    'no action',
    'non-actionable',
    'test alert',
    'synthetic check',
    'heartbeat missed',
  ].some((phrase) => text.includes(phrase));
}

function getDuplicateCount(row, allAlerts) {
  const title = value(row, 'title');
  const service = value(row, 'service');
  const environment = value(row, 'environment');

  if (!title || !service || !environment) {
    return 1;
  }

  return allAlerts.filter((candidate) => (
    value(candidate, 'title') === title &&
    value(candidate, 'service') === service &&
    value(candidate, 'environment') === environment
  )).length;
}

function getRelatedAlertCount(row) {
  const relatedAlerts = value(row, 'related_alerts', 'relatedAlerts');

  return Array.isArray(relatedAlerts) ? relatedAlerts.length : 0;
}

function evaluateLegacyAlertForAudit(row, allAlerts = []) {
  const status = value(row, 'status');
  const severity = value(row, 'severity');
  const occurrences = Number(value(row, 'occurrences') || 1);
  const duplicateCount = Math.max(occurrences, getDuplicateCount(row, allAlerts));
  const relatedAlertCount = getRelatedAlertCount(row);

  if (resolvedStatuses.has(status)) {
    return {
      classification: 'noise',
      noiseType: 'auto-resolved',
      confidenceScore: 94,
      noiseReason: 'Matched auto-resolved rule: the source reported this alert as resolved/recovered before ownership was needed.',
      classificationReason: 'Classified as noise because the alert is already resolved and does not require active incident response.',
    };
  }

  if (duplicateCount >= 3) {
    return {
      classification: 'noise',
      noiseType: 'duplicate',
      confidenceScore: 96,
      noiseReason: `Matched duplicate rule: ${duplicateCount} matching alerts share the same title, service, and environment.`,
      classificationReason: `Classified as noise because ${duplicateCount} matching alerts can be grouped into one signal instead of paging separately.`,
    };
  }

  if (occurrences >= 5 && activeStatuses.has(status)) {
    return {
      classification: 'noise',
      noiseType: 'flapping',
      confidenceScore: 90,
      noiseReason: `Matched flapping rule: ${occurrences} occurrences were seen while the alert remained active.`,
      classificationReason: 'Classified as noise because repeated open/recover behavior is likely a flapping monitor rather than a separate incident each time.',
    };
  }

  if (relatedAlertCount > 0) {
    return {
      classification: 'noise',
      noiseType: 'correlated',
      confidenceScore: 88,
      noiseReason: `Matched correlated rule: ${relatedAlertCount} related alert(s) point to a shared upstream signal.`,
      classificationReason: 'Classified as noise because this alert is likely a downstream symptom of another active alert.',
    };
  }

  if ((severity === 'low' || severity === 'warning') && hasLowSignalLanguage(row)) {
    return {
      classification: 'noise',
      noiseType: 'non-actionable',
      confidenceScore: 84,
      noiseReason: 'Matched non-actionable rule: low-severity informational language with no clear operator action.',
      classificationReason: 'Classified as noise because the signal is low impact and does not contain an actionable incident condition.',
    };
  }

  if (incidentSeverities.has(severity) && activeStatuses.has(status)) {
    return {
      classification: 'incident',
      noiseType: 'none',
      confidenceScore: severity === 'critical' ? 96 : 91,
      noiseReason: null,
      classificationReason: `Classified as incident because severity is ${severity} and status is ${status}, which means the alert is active and potentially customer/service impacting.`,
    };
  }

  if (mediumIncidentSeverities.has(severity) && activeStatuses.has(status)) {
    return {
      classification: 'incident',
      noiseType: 'none',
      confidenceScore: 78,
      noiseReason: null,
      classificationReason: `Classified as incident because the alert is active (${status}) and has ${severity} severity. Review before suppressing.`,
    };
  }

  return {
    classification: 'needs_review',
    noiseType: 'none',
    confidenceScore: 52,
    noiseReason: null,
    classificationReason: 'Needs human review because it did not match a noise rule or a high-confidence incident rule.',
  };
}

function classifyAlert() {
  const error = new Error('The legacy rule-based classifier is retired and cannot generate new alert decisions.');
  error.code = 'LEGACY_DECISION_LAYER_RETIRED';
  error.status = 410;
  throw error;
}

function deriveIncidentState(row) {
  if (row.status === 'auto-resolved') {
    return 'resolved';
  }

  if (row.status === 'investigating') {
    return 'investigating';
  }

  return row.classification === 'incident' ? 'open' : 'suppressed';
}

module.exports = {
  classifyAlert,
  deriveIncidentState,
  evaluateLegacyAlertForAudit,
  normalizeClassification,
};
