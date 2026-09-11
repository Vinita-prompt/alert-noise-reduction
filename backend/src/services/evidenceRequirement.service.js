const EVIDENCE_STATUSES = Object.freeze([
  'COLLECTED',
  'VALIDATED',
  'PARTIAL',
  'UNAVAILABLE',
  'CONFLICTING',
  'EXPIRED',
  'INVALID',
]);

const COMMON_FIELDS = Object.freeze([
  ['alertIdentity', 'Alert identity', true],
  ['sourceIdentity', 'Accepted source identity', true],
  ['classificationEvidence', 'Alert classification evidence', true],
  ['businessImpactEvidence', 'Authoritative business impact', false],
  ['actionabilityEvidence', 'Actionability evidence', true],
  ['underlyingEventEvidence', 'Underlying event evidence', true],
  ['notificationRoleEvidence', 'Notification role evidence', true],
  ['noiseDetectionEvidence', 'Noise detection evidence', true],
  ['lifecycleEvidence', 'Source lifecycle evidence', true],
  ['sourceNativeEvidence', 'Source-native evidence', true],
  ['telemetryEvidence', 'Direct telemetry', false],
  ['relatedOperationsEvidence', 'Related Operations alerts', false],
  ['jiraEvidence', 'Related Jira evidence', false],
  ['slackEvidence', 'Related Slack evidence', false],
  ['historicalEvidence', 'Bounded historical recurrence evidence', false],
]);

const SOURCE_FIELDS = Object.freeze({
  AppDynamics: Object.freeze([
    'application', 'tier', 'node', 'businessTransaction', 'healthRule', 'eventId', 'eventType',
    'metricIntent', 'metricPath', 'startValue', 'peakValue', 'endValue', 'threshold',
    'violationStart', 'violationEnd', 'duration', 'sourceUrl',
  ]),
  Grafana: Object.freeze([
    'ruleUid', 'labels', 'annotations', 'dashboardUid', 'panelId', 'datasource', 'query',
    'threshold', 'firingState', 'resolvedState', 'firstSeen', 'lastSeen', 'sourceUrl',
  ]),
  Nagios: Object.freeze([
    'host', 'service', 'checkType', 'state', 'stateType', 'attempt', 'duration', 'output',
    'performanceData', 'notificationType', 'acknowledgement', 'downtime', 'sourceUrl',
  ]),
  ThousandEyes: Object.freeze([
    'alertId', 'ruleId', 'testId', 'testName', 'testType', 'agentId', 'agentName', 'agentLocation',
    'metric', 'threshold', 'violationCount', 'startTime', 'endTime', 'permalink', 'sourceUrl',
  ]),
});

function cleanText(value) {
  return String(value ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function normalizeKey(value) {
  return cleanText(value).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function unique(values) {
  return [...new Set((values || []).filter(Boolean).map(cleanText).filter(Boolean))];
}

function percentage(value, total) {
  return total ? Number((Number(value || 0) / Number(total) * 100).toFixed(1)) : 0;
}

function evidenceStatus({ conflict = false, count = 0, invalid = false, partial = false, validated = false } = {}) {
  if (conflict) return 'CONFLICTING';
  if (invalid) return 'INVALID';
  if (validated && count > 0) return 'VALIDATED';
  if (count > 0 && partial) return 'PARTIAL';
  if (count > 0) return 'COLLECTED';
  return 'UNAVAILABLE';
}

function sourceUrl(record) {
  const metadata = record?.metadata || {};
  return [record?.sourceUrl, record?.url, record?.permalink, metadata.sourceUrl, metadata.url,
    metadata.permalink, metadata.deepLink, metadata.dashboardUrl].find((value) => /^https?:\/\//i.test(cleanText(value))) || null;
}

function provenanceItem(record, fallbackSource, type, status = 'COLLECTED') {
  if (!record) return null;
  const resolvedStatus = status === 'COLLECTED' && (record.authoritative === true || record.matched === true)
    ? 'VALIDATED' : status;
  return {
    evidenceId: cleanText(record.id) || null,
    source: cleanText(record.source || fallbackSource) || 'Unknown',
    sourceId: cleanText(record.id || record.metadata?.eventId || record.metadata?.alertId) || null,
    timestamp: record.timestamp || null,
    entity: cleanText(record.entity) || null,
    evidenceType: cleanText(record.type || type) || type,
    normalizedValue: cleanText(record.title || record.summary || record.type) || null,
    confidence: record.authoritative === true || record.matched === true ? 'HIGH' : 'MEDIUM',
    status: resolvedStatus,
    provenanceUrl: sourceUrl(record),
  };
}

function flattenedMetadata(records) {
  const values = new Map();
  const visit = (value, path = '') => {
    if (Array.isArray(value)) {
      value.forEach((item) => visit(item, path));
      return;
    }
    if (value && typeof value === 'object') {
      Object.entries(value).forEach(([key, item]) => visit(item, key));
      return;
    }
    if (value !== undefined && value !== null && cleanText(value)) values.set(normalizeKey(path), value);
  };
  records.forEach((record) => visit(record));
  return values;
}

function sourceFieldCoverage(occurrence) {
  const source = cleanText(occurrence?.source?.name) || 'Unknown';
  const required = SOURCE_FIELDS[source] || [];
  const records = [...(occurrence?.sourceNativeEvidence || []), ...(occurrence?.telemetry || [])];
  const metadata = flattenedMetadata([
    ...records,
    occurrence?.appDynamicsWorkflow || {},
    occurrence?.alert || {},
    occurrence?.event || {},
  ]);
  return required.map((field) => {
    const aliases = [field];
    if (field === 'sourceUrl') aliases.push('url', 'deepLink', 'permalink', 'dashboardUrl');
    if (field === 'duration') aliases.push('durationMs');
    if (field === 'attempt') aliases.push('attempts', 'currentAttempt');
    if (field === 'labels') aliases.push('label');
    const matched = aliases.map(normalizeKey).find((key) => metadata.has(key));
    return {
      field,
      status: matched ? 'COLLECTED' : 'UNAVAILABLE',
      source,
      valuePresent: Boolean(matched),
    };
  });
}

function buildEvidenceInventory(occurrence, assessment) {
  const source = cleanText(occurrence?.source?.name) || 'Unknown';
  const native = (occurrence?.sourceNativeEvidence || []).map((item) => provenanceItem(item, source, 'source_native')).filter(Boolean);
  const telemetry = (occurrence?.telemetry || []).map((item) => provenanceItem(item, source, 'telemetry')).filter(Boolean);
  const jira = (occurrence?.jira?.records || []).map((item) => provenanceItem(item, 'Jira', 'jira')).filter(Boolean);
  const slack = (occurrence?.slack?.records || []).map((item) => provenanceItem(item, 'Slack', 'slack')).filter(Boolean);
  const rejected = (assessment?.evidenceRejected || []).map((item) => provenanceItem(item, item.source || source, item.type || 'rejected', 'INVALID')).filter(Boolean);
  const conflicting = occurrence?.evidenceStatus?.conflict === true
    ? unique([
      ...(occurrence?.identity?.conflicts && Array.isArray(occurrence.identity.conflicts) ? occurrence.identity.conflicts : []),
      'Accepted source identity conflicts with another evidence record.',
    ]).map((reason, index) => ({
      evidenceId: `conflict-${occurrence.occurrenceId}-${index + 1}`,
      source,
      sourceId: occurrence.occurrenceId,
      timestamp: null,
      entity: occurrence?.identity?.canonicalEntity || null,
      evidenceType: 'CONFLICTING_IDENTITY_OR_LIFECYCLE',
      normalizedValue: reason,
      confidence: 'LOW',
      status: 'CONFLICTING',
      provenanceUrl: null,
    })) : [];
  return { collected: [...native, ...telemetry, ...jira, ...slack], rejected, conflicting };
}

function fieldCoverage(occurrence, assessment) {
  const native = occurrence?.sourceNativeEvidence || [];
  const telemetry = occurrence?.telemetry || [];
  const jira = occurrence?.jira?.records || [];
  const slack = occurrence?.slack?.records || [];
  const event = occurrence?.event || {};
  const identity = occurrence?.identity || {};
  const roleKnown = assessment?.notificationRole?.role && assessment.notificationRole.role !== 'UNKNOWN';
  const noiseKnown = assessment?.noiseDetection?.primaryCategory && assessment.noiseDetection.primaryCategory !== 'UNKNOWN';
  const classificationKnown = assessment?.classification?.domain && assessment.classification.domain !== 'UNKNOWN';
  const actionabilityKnown = assessment?.actionability?.value && assessment.actionability.value !== 'UNKNOWN';
  const eventKnown = assessment?.underlyingEvent?.status && !['UNKNOWN', 'UNCONFIRMED'].includes(assessment.underlyingEvent.status);
  const impactKnown = assessment?.businessImpact?.level && assessment.businessImpact.level !== 'UNKNOWN';
  const related = Array.isArray(event.notifications) ? event.notifications : [];
  const relatedOthers = related.filter((id) => String(id) !== String(occurrence?.occurrenceId));
  const lifecycleCount = [event.start, event.recovery, event.state && event.state !== 'UNKNOWN'].filter(Boolean).length;
  const rows = {
    alertIdentity: { count: [occurrence?.occurrenceId, occurrence?.source?.name, occurrence?.alert?.createdAt].filter(Boolean).length, validated: Boolean(occurrence?.occurrenceId && occurrence?.source?.name && occurrence?.alert?.createdAt) },
    sourceIdentity: { count: identity.accepted ? 1 : 0, validated: identity.accepted === true, conflict: identity.conflicts === true },
    classificationEvidence: { count: assessment?.classification?.evidenceIds?.length || 0, validated: Boolean(classificationKnown && assessment.classification.evidenceIds?.length) },
    businessImpactEvidence: { count: assessment?.businessImpact?.evidenceIds?.length || 0, validated: Boolean(impactKnown && assessment.businessImpact.evidenceIds?.length) },
    actionabilityEvidence: { count: assessment?.actionability?.evidenceIds?.length || 0, validated: Boolean(actionabilityKnown && assessment.actionability.evidenceIds?.length) },
    underlyingEventEvidence: { count: assessment?.underlyingEvent?.evidenceIds?.length || 0, validated: Boolean(eventKnown && assessment.underlyingEvent.evidenceIds?.length) },
    notificationRoleEvidence: { count: assessment?.notificationRole?.evidenceIds?.length || 0, validated: Boolean(roleKnown && assessment.notificationRole.evidenceIds?.length) },
    noiseDetectionEvidence: { count: assessment?.noiseDetection?.evidenceIds?.length || Number(noiseKnown), validated: Boolean(noiseKnown), partial: !assessment?.noiseDetection?.detected },
    lifecycleEvidence: { count: lifecycleCount, validated: lifecycleCount >= 2, partial: lifecycleCount === 1 },
    sourceNativeEvidence: { count: native.length, validated: native.some((item) => item.authoritative === true), partial: native.length > 0 },
    telemetryEvidence: { count: telemetry.length, validated: telemetry.some((item) => item.matched === true), partial: telemetry.length > 0 },
    relatedOperationsEvidence: { count: relatedOthers.length, validated: relatedOthers.length > 0 },
    jiraEvidence: { count: jira.length, validated: jira.length > 0 },
    slackEvidence: { count: slack.length, validated: slack.length > 0 },
    historicalEvidence: { count: Number(event.transitionCount || 0) + Math.max(0, related.length - 1), validated: Number(event.transitionCount || 0) > 0 || related.length > 1 },
  };
  return COMMON_FIELDS.map(([field, label, decisionCritical]) => ({
    field,
    label,
    decisionCritical,
    count: Number(rows[field]?.count || 0),
    status: evidenceStatus(rows[field]),
  }));
}

function missingReason(field, source) {
  const reasons = {
    sourceIdentity: `No accepted deterministic ${source} entity mapping is available.`,
    sourceNativeEvidence: `No authoritative ${source} event or rule record was returned for the alert window.`,
    telemetryEvidence: `No direct matched ${source} telemetry was returned for the alert window.`,
    lifecycleEvidence: 'A complete firing, sustained/degraded, or recovery lifecycle is not established.',
    actionabilityEvidence: 'Evidence does not yet prove that intervention was required or unnecessary.',
    underlyingEventEvidence: 'The underlying operational event is not yet confirmed or excluded.',
    notificationRoleEvidence: 'The notification contribution to the event is not yet proven.',
    noiseDetectionEvidence: 'A supported noise characteristic is neither confirmed nor confidently excluded.',
    classificationEvidence: 'Structured source metadata does not identify the technical alert class.',
    businessImpactEvidence: 'No authoritative service criticality or customer/revenue impact metadata is available.',
    relatedOperationsEvidence: 'No related Operations lifecycle alerts are available.',
    jiraEvidence: 'No related Jira incident or problem evidence is available.',
    slackEvidence: 'No meaningful related Slack investigation evidence is available.',
    historicalEvidence: 'No bounded recurrence or lifecycle history is available.',
    alertIdentity: 'The alert identifier, source, or occurrence timestamp is incomplete.',
  };
  return reasons[field] || 'Required evidence is unavailable.';
}

function collectionAction(field, source) {
  const actions = {
    alertIdentity: ['VALIDATE_PERSISTED_ALERT', 'Validate the persisted Operations alert identity and timestamps.', 'P0'],
    sourceIdentity: ['RESOLVE_SOURCE_IDENTITY', `Resolve the canonical entity to an accepted ${source} identity.`, 'P0'],
    sourceNativeEvidence: ['QUERY_SOURCE_NATIVE', `Query the ${source} source-native alert/event endpoint for the bounded window.`, 'P0'],
    telemetryEvidence: ['QUERY_DIRECT_TELEMETRY', `Query direct ${source} telemetry for the accepted entity and metric.`, 'P0'],
    lifecycleEvidence: ['RECONSTRUCT_LIFECYCLE', 'Reconstruct firing, sustained/degraded, and recovery transitions.', 'P0'],
    underlyingEventEvidence: ['CONFIRM_EVENT_BOUNDARY', 'Validate the underlying event boundary from source-native records and telemetry.', 'P0'],
    actionabilityEvidence: ['COLLECT_ACTIONABILITY', 'Collect sustained/recovery evidence and meaningful Jira, Slack, or Operations action.', 'P0'],
    notificationRoleEvidence: ['COMPARE_EVENT_NOTIFICATIONS', 'Compare related alert contributions within the accepted event boundary.', 'P1'],
    noiseDetectionEvidence: ['VALIDATE_NOISE_BEHAVIOR', 'Validate duplicate, flapping, recovery, correlation, or stale behavior from positive evidence.', 'P1'],
    classificationEvidence: ['COLLECT_CLASSIFICATION_METADATA', `Collect structured ${source} rule, entity, metric, or test metadata.`, 'P1'],
    relatedOperationsEvidence: ['LOAD_RELATED_OPERATIONS', 'Load related Operations lifecycle alerts using accepted identities.', 'P1'],
    jiraEvidence: ['SEARCH_RELATED_JIRA', 'Search Jira read-only for an actual related incident/problem and investigation history.', 'P2'],
    slackEvidence: ['SEARCH_RELATED_SLACK', 'Search Slack read-only for concrete investigation or remediation context.', 'P2'],
    historicalEvidence: ['LOAD_BOUNDED_HISTORY', 'Load persisted bounded history, up to 90 days, without expanding the 24-hour alert denominator.', 'P2'],
    businessImpactEvidence: ['LOOKUP_SERVICE_METADATA', 'Look up authoritative service criticality and customer/revenue impact metadata.', 'P3'],
  };
  const [action, instruction, priority] = actions[field] || ['COLLECT_EVIDENCE', `Collect ${field}.`, 'P3'];
  return { action, instruction, priority };
}

function buildEvidencePlan(occurrence, assessment) {
  const source = cleanText(occurrence?.source?.name) || 'Unknown';
  const fields = fieldCoverage(occurrence, assessment);
  const missing = fields.filter((item) => !['COLLECTED', 'VALIDATED'].includes(item.status));
  const plan = missing.map((item, index) => ({
    order: index + 1,
    field: item.field,
    status: item.status,
    reason: missingReason(item.field, source),
    source,
    ...collectionAction(item.field, source),
    reusable: true,
    window: ['QUERY_SOURCE_NATIVE', 'QUERY_DIRECT_TELEMETRY', 'RECONSTRUCT_LIFECYCLE'].includes(collectionAction(item.field, source).action)
      ? { beforeMinutes: 5, afterMinutes: 10 } : null,
  })).sort((left, right) => left.priority.localeCompare(right.priority) || left.order - right.order)
    .map((item, index) => ({ ...item, order: index + 1 }));
  return {
    alertId: occurrence?.occurrenceId || assessment?.alertId || null,
    source,
    status: plan.length ? 'EVIDENCE_INCOMPLETE' : 'EVIDENCE_COMPLETE',
    fields,
    missingFields: missing.map((item) => ({ ...item, reason: missingReason(item.field, source) })),
    nextEvidenceAction: plan[0] || null,
    plan,
    sourceSpecificFields: sourceFieldCoverage(occurrence),
    inventory: buildEvidenceInventory(occurrence, assessment),
    safeguards: { readOnly: true, externalMutations: 'none', aiUsed: false, automaticSuppression: 'none' },
  };
}

function summarizeEvidenceRequirements(plans = []) {
  const fields = COMMON_FIELDS.map(([field, label, decisionCritical]) => {
    const rows = plans.map((plan) => plan.fields.find((item) => item.field === field)).filter(Boolean);
    const available = rows.filter((item) => ['COLLECTED', 'VALIDATED'].includes(item.status)).length;
    return { field, label, decisionCritical, available, missing: rows.length - available, total: rows.length,
      coveragePercentage: percentage(available, rows.length) };
  });
  const allInventory = plans.flatMap((item) => item.inventory.collected);
  const withProvenance = allInventory.filter((item) => item.evidenceId && item.source && item.evidenceType).length;
  return {
    totalAlerts: plans.length,
    evidenceComplete: plans.filter((item) => item.status === 'EVIDENCE_COMPLETE').length,
    evidenceIncomplete: plans.filter((item) => item.status === 'EVIDENCE_INCOMPLETE').length,
    fields,
    provenanceCoveragePercentage: percentage(withProvenance, allInventory.length),
    unsupportedEvidenceItems: allInventory.length - withProvenance,
    sourceSpecific: Object.entries(plans.reduce((result, plan) => {
      const current = result[plan.source] || { total: 0, available: 0, missing: 0 };
      current.total += plan.sourceSpecificFields.length;
      current.available += plan.sourceSpecificFields.filter((item) => item.valuePresent).length;
      current.missing += plan.sourceSpecificFields.filter((item) => !item.valuePresent).length;
      result[plan.source] = current;
      return result;
    }, {})).map(([source, counts]) => ({ source, ...counts, coveragePercentage: percentage(counts.available, counts.total) })),
  };
}

module.exports = {
  COMMON_FIELDS,
  EVIDENCE_STATUSES,
  SOURCE_FIELDS,
  buildEvidenceInventory,
  buildEvidencePlan,
  evidenceStatus,
  fieldCoverage,
  sourceFieldCoverage,
  summarizeEvidenceRequirements,
};
