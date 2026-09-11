const { NOISE_EVIDENCE_GAP_CONFIG } = require('../config/noiseEvidenceGap');
const {
  applyOccurrenceOverrides,
  classifyOccurrence,
  classifyPattern,
  service: actionabilityService,
} = require('./noiseActionability.service');
const { service: enrichmentService } = require('./noiseEvidenceEnrichment.service');
const { service: phase1Service } = require('./noiseAnalysis.service');
const { service: sourceIdentityService } = require('./sourceIdentity.service');

const ACCEPTED_MAPPING_LEVELS = new Set(['EXACT', 'STRONG', 'CONFIRMED_LOCAL']);
const MONITORING_MAPPING_KEYS = ['appDynamics', 'grafana', 'thousandEyes', 'nagios'];
const POTENTIAL_RANK = { HIGH: 3, MEDIUM: 2, LOW: 1, UNKNOWN: 0 };
const CONFIDENCE_RANK = { HIGH: 3, MEDIUM: 2, LOW: 1 };

function cleanText(value) {
  return String(value ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function canonical(value) {
  return cleanText(value).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function unique(values) {
  return [...new Set(values.filter(Boolean).map(cleanText).filter(Boolean))];
}

function alertId(alert) {
  return String(alert?.id || alert?.canonicalOperationsId || alert?.externalId || '');
}

function alertNumber(alert) {
  return String(alert?.tinyId || alert?.alertNumber || '');
}

function parseRange(value) {
  return ['24h', '7d', '30d', '90d'].includes(value) ? value : '7d';
}

function percent(count, total) {
  return total ? Number((Number(count || 0) / total * 100).toFixed(1)) : 0;
}

function normalizeSource(value) {
  const raw = cleanText(value);
  const normalized = canonical(raw);
  if (!raw) return 'Unknown';
  if (normalized.includes('appdynamic') || normalized === 'appd') return 'AppDynamics';
  if (normalized.includes('grafana')) return 'Grafana';
  if (normalized.includes('nagios')) return 'Nagios';
  if (normalized.includes('thousandeyes')) return 'ThousandEyes';
  if (normalized.includes('halcyon') || normalized.includes('email')) return 'Email / Halcyon';
  if (normalized.includes('jiraservicemanagement') || normalized.includes('jsmcloud')) return 'jira-service-management-cloud';
  return raw;
}

function sourceKey(source) {
  return {
    AppDynamics: 'appDynamics',
    Grafana: 'grafana',
    Nagios: 'nagios',
    ThousandEyes: 'thousandEyes',
  }[source] || null;
}

function sourceFields(alert, expectedSource) {
  const tags = Array.isArray(alert?.tags) ? alert.tags.map(cleanText) : [];
  const readTag = (prefix) => tags.find((tag) => tag.toLowerCase().startsWith(`${prefix.toLowerCase()}:`))?.slice(prefix.length + 1).trim() || null;
  const values = {
    application: cleanText(alert?.application) || null,
    dashboard: cleanText(alert?.dashboardTitle || alert?.dashboard) || null,
    environment: cleanText(alert?.environment) || readTag('environment'),
    folder: cleanText(alert?.folder) || readTag('grafana_folder'),
    host: cleanText(alert?.host || alert?.hostName) || null,
    instance: cleanText(alert?.instance) || readTag('instance'),
    ruleId: cleanText(alert?.ruleId || alert?.alertRuleId || alert?.ruleUid) || null,
    ruleName: cleanText(alert?.ruleName || alert?.alertRuleName) || readTag('alertname'),
    service: cleanText(alert?.service) || readTag('service'),
    testId: cleanText(alert?.testId) || null,
  };
  let sourceInstance = cleanText(alert?.integrationName || alert?.integration?.name) || null;
  if (expectedSource === 'Nagios') {
    const combined = canonical(`${sourceInstance || ''} ${tags.join(' ')} ${values.environment || ''}`);
    if (/dc0?1/.test(combined)) sourceInstance = 'DC01';
    else if (/dc0?2/.test(combined)) sourceInstance = 'DC02';
    else sourceInstance = sourceInstance || 'Unknown DC';
  }
  return { sourceInstance, structured: values };
}

function structuredCanonicalEntity(alert) {
  const name = cleanText(alert?.application || alert?.service || alert?.host || alert?.hostName || alert?.testName || alert?.testId);
  if (!name) return null;
  const entityType = alert?.application ? 'APPLICATION'
    : alert?.host || alert?.hostName ? 'HOST'
      : alert?.testName || alert?.testId ? 'SYNTHETIC_TEST' : 'SERVICE';
  return { canonicalName: name, entityId: null, entityType, source: 'OPERATIONS_STRUCTURED_FIELDS' };
}

function allMonitoringMappings(identity) {
  return MONITORING_MAPPING_KEYS.flatMap((key) => (Array.isArray(identity?.mappings?.[key]) ? identity.mappings[key] : []))
    .filter((mapping) => mapping && String(mapping.level || '').toUpperCase() !== 'NONE' && mapping.rejected !== true);
}

function mappingDiagnostic(identity, expectedSource, alert) {
  const expectedKey = sourceKey(expectedSource);
  const relevant = expectedKey && Array.isArray(identity?.mappings?.[expectedKey])
    ? identity.mappings[expectedKey].filter((mapping) => mapping && String(mapping.level || '').toUpperCase() !== 'NONE' && mapping.rejected !== true)
    : [];
  const allMappings = allMonitoringMappings(identity);
  const accepted = relevant.filter((mapping) => ACCEPTED_MAPPING_LEVELS.has(String(mapping.level || '').toUpperCase()) && mapping.usableForSourceValidation !== false);
  const candidates = relevant.filter((mapping) => String(mapping.level || '').toUpperCase() === 'CANDIDATE');
  const conflict = Boolean(identity?.mappingConflict || identity?.conflicts?.length);
  let mappingState = identity ? 'NONE' : 'NOT_RESOLVED';
  if (conflict) mappingState = 'CONFLICT';
  else if (accepted.length) mappingState = String(accepted[0].level || 'EXACT').toUpperCase();
  else if (candidates.length) mappingState = 'CANDIDATE';
  const selected = accepted[0] || candidates[0] || relevant[0] || null;
  const canonicalEntity = identity?.canonicalEntity || structuredCanonicalEntity(alert);
  const fields = sourceFields(alert, expectedSource);
  return {
    accepted: accepted.length > 0,
    acceptedLevel: accepted.length ? String(accepted[0].level || 'EXACT').toUpperCase() : null,
    acceptedAnySource: allMappings.some((mapping) => ACCEPTED_MAPPING_LEVELS.has(String(mapping.level || '').toUpperCase()) && mapping.usableForSourceValidation !== false),
    anyMapping: allMappings.length > 0,
    candidate: candidates.length > 0,
    candidateAnySource: allMappings.some((mapping) => String(mapping.level || '').toUpperCase() === 'CANDIDATE'),
    canonicalEntity,
    environment: cleanText(identity?.canonicalEntity?.environment || alert?.environment) || null,
    expectedSource,
    mappedEntity: selected ? {
      id: cleanText(selected.sourceEntityId) || null,
      name: cleanText(selected.sourceEntityName) || null,
      source: cleanText(selected.source) || expectedSource,
      type: cleanText(selected.sourceEntityType) || null,
    } : null,
    mappingConflict: conflict,
    mappingReason: selected?.reasons?.map(cleanText).filter(Boolean).join(' ') || identity?.conflicts?.[0]?.type || null,
    mappingResolution: selected?.resolution || null,
    mappingState,
    resolverExecuted: Boolean(identity),
    sourceFields: fields.structured,
    sourceInstance: fields.sourceInstance,
  };
}

function chooseGlobalOccurrence(candidates) {
  const classificationRank = { ACTIONABLE: 3, NON_ACTIONABLE: 2, NEEDS_REVIEW: 1 };
  return [...candidates].sort((left, right) => (
    classificationRank[right.occurrence.classification] - classificationRank[left.occurrence.classification]
    || CONFIDENCE_RANK[right.occurrence.confidence] - CONFIDENCE_RANK[left.occurrence.confidence]
  ))[0];
}

function telemetryDiagnostic(occurrence, expectedSource) {
  const evidence = occurrence?.evidence || {};
  const monitoring = Array.isArray(evidence.monitoring) ? evidence.monitoring : [];
  const expected = monitoring.find((item) => normalizeSource(item.source) === expectedSource) || null;
  const state = String(occurrence?.evidenceState || evidence.evidenceState || 'NOT_ENRICHED').toUpperCase();
  const statusText = cleanText(`${expected?.sourceStatus || ''} ${expected?.status || ''} ${expected?.reason || ''} ${occurrence?.reasons?.join(' ') || ''}`).toLowerCase();
  const outcome = String(expected?.outcome || expected?.outcome?.code || 'INSUFFICIENT_DATA').toUpperCase();
  const returned = Boolean(expected?.evidence?.length);
  const queried = state !== 'NOT_ENRICHED' && Boolean(expected) && !/not_applicable/.test(statusText);
  return {
    available: queried && !/unavailable|error|timeout|forbidden|failed/.test(statusText),
    error: /error|failed|forbidden|\b403\b|\b401\b/.test(statusText),
    evidence: expected?.evidence || [],
    outcome,
    outsideWindow: queried && !returned && /bounded|window|historical/.test(cleanText(`${expected?.reason || ''} ${occurrence?.reasons?.join(' ') || ''}`).toLowerCase()),
    queried,
    returned,
    sourceStatus: expected?.sourceStatus || null,
    state,
    timeout: /timeout|timed out|aborted/.test(statusText),
    unavailable: state === 'EVIDENCE_UNAVAILABLE' || /unavailable/.test(statusText),
  };
}

function operationsDiagnostic(alert, occurrence) {
  const lifecycle = occurrence?.evidence?.lifecycle || {};
  const created = Boolean(alert?.createdAt || alert?.firstOccurredAt);
  const closed = Boolean(alert?.closeTime || alert?.closedAt || alert?.resolvedAt || /closed|resolved/i.test(String(alert?.status || '')));
  const meaningfulAction = Boolean(lifecycle.humanAction || occurrence?.humanHandling?.operatorActionObserved);
  const verifiedLifecycle = Boolean(lifecycle.verifiedClosedCycle || lifecycle.closedBySystem);
  const fields = {
    acknowledgement: Boolean(lifecycle.acknowledged || alert?.acknowledged),
    alias: Boolean(alert?.alias),
    closedTimestamp: closed,
    createdTimestamp: created,
    description: Boolean(cleanText(alert?.description || alert?.message)),
    entity: Boolean(alert?.application || alert?.service || alert?.host || alert?.hostName),
    meaningfulOperatorAction: meaningfulAction,
    notes: Boolean(alert?.notes?.length),
    priority: Boolean(alert?.priority),
    source: Boolean(alert?.source || alert?.sourceSystem || alert?.integrationName),
    status: Boolean(alert?.status),
    tags: Boolean(alert?.tags?.length),
    team: Boolean(alert?.team),
    verifiedLifecycle,
  };
  return {
    fields,
    insufficient: !meaningfulAction && !verifiedLifecycle,
    missingFields: Object.entries(fields).filter(([, present]) => !present).map(([field]) => field),
  };
}

function jiraDiagnostic(occurrence) {
  const jira = occurrence?.evidence?.jira || {};
  const coverage = occurrence?.coverage?.jira || occurrence?.evidence?.coverage?.jira || {};
  const inspected = Number(coverage.inspected || 0) > 0;
  const evidence = Array.isArray(jira.evidence) ? jira.evidence : [];
  return {
    candidateRelationship: evidence.some((item) => item?.metadata?.relationship === 'candidate'),
    confirmedIncident: jira.confirmedIncident === true,
    confirmedProblem: jira.confirmedProblem === true,
    inspected,
    noRelationship: inspected && !jira.confirmedIncident && !jira.confirmedProblem,
  };
}

function slackDiagnostic(occurrence) {
  const slack = occurrence?.evidence?.slack || {};
  const coverage = occurrence?.coverage?.slack || occurrence?.evidence?.coverage?.slack || {};
  const evidence = Array.isArray(slack.evidence) ? slack.evidence : [];
  const combined = cleanText(evidence.map((item) => `${item.title || ''} ${item.summary || ''}`).join(' ')).toLowerCase();
  const inspected = Number(coverage.inspected || 0) > 0;
  return {
    acknowledgementOnly: evidence.length > 0 && /acknowledg/.test(combined) && slack.concreteAction !== true,
    concreteAction: slack.concreteAction === true,
    discussionOnly: evidence.length > 0 && slack.concreteAction !== true,
    exactAlertMatch: evidence.length > 0,
    inspected,
    meaningfulOperatorAction: slack.concreteAction === true,
    noResult: inspected && evidence.length === 0,
  };
}

function gap(code, reason, config = NOISE_EVIDENCE_GAP_CONFIG) {
  const definition = config.gapDefinitions[code] || config.gapDefinitions.OTHER;
  return { code, label: code.toLowerCase().replace(/_/g, ' ').replace(/\b\w/g, (character) => character.toUpperCase()), reason: cleanText(reason), resolutionPotential: definition.potential };
}

function sourceNextBest(expectedSource, identity, primaryCode) {
  if (['NO_ACCEPTED_SOURCE_MAPPING', 'CANDIDATE_ONLY_SOURCE_MAPPING', 'MAPPING_CONFLICT', 'IDENTITY_MISSING'].includes(primaryCode)) return 'IDENTITY_MAPPING';
  if (primaryCode.startsWith('JIRA_')) return 'JIRA';
  if (primaryCode.startsWith('SLACK_')) return 'SLACK';
  if (primaryCode === 'OPERATIONS_LIFECYCLE_INSUFFICIENT' || primaryCode === 'UNKNOWN_SOURCE') return 'OPERATIONS';
  if (primaryCode === 'SOURCE_NOT_SUPPORTED') return 'NONE';
  if (expectedSource === 'Nagios') {
    if (identity.sourceInstance === 'DC01') return 'NAGIOS_DC01';
    if (identity.sourceInstance === 'DC02') return 'NAGIOS_DC02';
    return 'NAGIOS';
  }
  return expectedSource ? expectedSource.toUpperCase().replace(/[^A-Z0-9]+/g, '_') : 'NONE';
}

function gapAction(primaryCode, expectedSource, identity, config = NOISE_EVIDENCE_GAP_CONFIG) {
  if (primaryCode === 'CANDIDATE_ONLY_SOURCE_MAPPING' && identity.mappedEntity?.name) return `Confirm the candidate ${expectedSource} mapping to ${identity.mappedEntity.name}.`;
  if (primaryCode === 'NO_ACCEPTED_SOURCE_MAPPING' && identity.canonicalEntity?.canonicalName) return `Resolve a deterministic ${expectedSource} mapping for ${identity.canonicalEntity.canonicalName}.`;
  if (primaryCode === 'SOURCE_TELEMETRY_NOT_QUERIED') return `Query ${expectedSource} read-only telemetry for the bounded occurrence window.`;
  return config.gapDefinitions[primaryCode]?.action || config.gapDefinitions.OTHER.action;
}

function classifyGap(record, config = NOISE_EVIDENCE_GAP_CONFIG) {
  const { expectedSource, identity, jira, operations, slack, telemetry } = record;
  const supported = config.supportedMonitoringSources.includes(expectedSource);
  const detected = [];
  const add = (code, reason) => { if (!detected.some((item) => item.code === code)) detected.push(gap(code, reason, config)); };

  if (expectedSource === 'Unknown') add('UNKNOWN_SOURCE', 'Operations did not provide a recognized source or integration identity.');
  else if (!identity.canonicalEntity) add('IDENTITY_MISSING', `No stable structured ${expectedSource} entity was available for deterministic resolution.`);
  else if (identity.mappingConflict) add('MAPPING_CONFLICT', identity.mappingReason || 'Source identity contains an unresolved entity or environment conflict.');
  else if (!supported) add('SOURCE_NOT_SUPPORTED', `${expectedSource} does not have a Phase 3.1 monitoring telemetry adapter.`);
  else if (identity.candidate && !identity.accepted) add('CANDIDATE_ONLY_SOURCE_MAPPING', identity.mappingReason || `Only a candidate ${expectedSource} relationship was found.`);
  else if (!identity.accepted) add('NO_ACCEPTED_SOURCE_MAPPING', `No Exact, Strong, or locally confirmed ${expectedSource} mapping is available.`);

  if (supported && identity.accepted) {
    if (telemetry.state === 'NOT_ENRICHED' || !telemetry.queried) add('SOURCE_TELEMETRY_NOT_QUERIED', `${expectedSource} telemetry was not queried for this occurrence window.`);
    else if (telemetry.timeout) add('SOURCE_TELEMETRY_TIMEOUT', `${expectedSource} telemetry timed out.`);
    else if (telemetry.error) add('SOURCE_TELEMETRY_ERROR', `${expectedSource} returned an error during the bounded read-only query.`);
    else if (telemetry.unavailable) add('SOURCE_TELEMETRY_UNAVAILABLE', `${expectedSource} telemetry was unavailable.`);
    else if (!telemetry.returned && telemetry.outsideWindow) add('SOURCE_TELEMETRY_OUTSIDE_WINDOW', `${expectedSource} returned no timestamp-compatible evidence in the occurrence window.`);
    else if (!telemetry.returned || telemetry.outcome === 'INSUFFICIENT_DATA') add('SOURCE_TELEMETRY_INSUFFICIENT', `${expectedSource} returned insufficient structured evidence for a safe classification.`);
  }

  if (operations.insufficient) add('OPERATIONS_LIFECYCLE_INSUFFICIENT', 'Operations has no meaningful operator action or verified lifecycle outcome beyond basic handling.');
  if (!jira.inspected) add('JIRA_NOT_INSPECTED', 'ACC Jira was not inspected for this exact occurrence.');
  else if (!jira.confirmedIncident && !jira.confirmedProblem) add('JIRA_NO_CONFIRMED_RELATIONSHIP', 'No confirmed ACC Jira Incident or Problem relationship was found.');
  if (!slack.inspected) add('SLACK_NOT_INSPECTED', 'Slack was not inspected using the exact Operations alert number.');
  else if (slack.discussionOnly) add('SLACK_CONTEXT_ONLY', 'Slack contains context or acknowledgement but no concrete remediation evidence.');

  const actionableMonitoring = occurrenceMonitoring(record.occurrence).filter((item) => item.actionable).length;
  const recoveryMonitoring = occurrenceMonitoring(record.occurrence).filter((item) => item.nonActionable).length;
  if (actionableMonitoring && recoveryMonitoring) add('CONFLICTING_EVIDENCE', 'Monitoring evidence contains both degradation and recovery signals.');
  if (!detected.length) add('INSUFFICIENT_COMBINED_EVIDENCE', 'Available evidence does not meet either safe classification threshold.');

  detected.sort((left, right) => config.gapPrecedence.indexOf(left.code) - config.gapPrecedence.indexOf(right.code));
  const primary = detected[0] || gap('OTHER', 'No deterministic gap rule matched.', config);
  const nextBestEvidenceSource = sourceNextBest(expectedSource, identity, primary.code);
  return {
    nextBestAction: gapAction(primary.code, expectedSource, identity, config),
    nextBestEvidenceSource,
    primaryEvidenceGap: primary,
    primaryEvidenceGapCode: primary.code,
    resolutionPotential: config.gapDefinitions[primary.code]?.potential || 'UNKNOWN',
    secondaryEvidenceGaps: detected.slice(1),
  };
}

function occurrenceMonitoring(occurrence) {
  return Array.isArray(occurrence?.evidence?.monitoring) ? occurrence.evidence.monitoring : [];
}

function stage(name, count, previous, total) {
  return { name, count, percentage: percent(count, total), dropOff: Math.max(0, previous - count) };
}

function mappingFunnel(records) {
  const total = records.length;
  const counts = {
    sourceIdentified: records.filter((item) => item.expectedSource !== 'Unknown').length,
    identityExtracted: records.filter((item) => item.identity.canonicalEntity).length,
    resolverExecuted: records.filter((item) => item.identity.resolverExecuted).length,
    anyMapping: records.filter((item) => item.identity.anyMapping).length,
    candidate: records.filter((item) => item.identity.candidateAnySource).length,
    accepted: records.filter((item) => item.identity.acceptedAnySource).length,
    enrichmentEligible: records.filter((item) => item.identity.acceptedAnySource && !item.identity.mappingConflict && item.alert.createdAt).length,
    telemetryQueried: records.filter((item) => item.telemetry.queried).length,
    telemetryReturned: records.filter((item) => item.telemetry.returned).length,
    evidenceSufficient: records.filter((item) => item.telemetry.returned && item.occurrence.classification !== 'NEEDS_REVIEW').length,
  };
  let previous = total;
  return [
    ['Needs Review', total],
    ['Source identified', counts.sourceIdentified],
    ['Canonical identity extracted', counts.identityExtracted],
    ['Resolver executed', counts.resolverExecuted],
    ['Any mapping found', counts.anyMapping],
    ['Candidate mapping', counts.candidate],
    ['Accepted mapping', counts.accepted],
    ['Enrichment eligible', counts.enrichmentEligible],
    ['Telemetry queried', counts.telemetryQueried],
    ['Telemetry returned', counts.telemetryReturned],
    ['Evidence sufficient', counts.evidenceSufficient],
  ].map(([name, count], index) => {
    const value = stage(name, count, index ? previous : count, total);
    previous = count;
    return value;
  });
}

function aggregateCodes(records, field) {
  const counts = new Map();
  records.flatMap((record) => field === 'primary'
    ? [record.primaryEvidenceGap]
    : record.secondaryEvidenceGaps).forEach((item) => counts.set(item.code, (counts.get(item.code) || 0) + 1));
  return [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])).map(([code, count]) => ({ code, count, percentage: percent(count, records.length) }));
}

function topCode(records) {
  return aggregateCodes(records, 'primary')[0]?.code || null;
}

function sourceBreakdown(allRecords, needsReviewRecords) {
  const sources = unique(allRecords.map((item) => item.expectedSource)).sort();
  const preferred = ['AppDynamics', 'Grafana', 'Nagios', 'ThousandEyes', 'Email / Halcyon', 'jira-service-management-cloud', 'Unknown'];
  return [...new Set([...preferred.filter((source) => sources.includes(source)), ...sources])].map((source) => {
    const all = allRecords.filter((item) => item.expectedSource === source);
    const review = needsReviewRecords.filter((item) => item.expectedSource === source);
      const mappingCount = (state) => review.filter((item) => item.identity.mappingState === state).length;
    return {
      source,
      totalAlerts: all.length,
      actionable: all.filter((item) => item.occurrence.classification === 'ACTIONABLE').length,
      nonActionable: all.filter((item) => item.occurrence.classification === 'NON_ACTIONABLE').length,
      needsReview: review.length,
      needsReviewPercentage: percent(review.length, all.length),
      identityExtracted: review.filter((item) => item.identity.canonicalEntity).length,
      acceptedMapping: review.filter((item) => item.identity.accepted).length,
      candidateMapping: review.filter((item) => item.identity.candidate && !item.identity.accepted).length,
      noMapping: review.filter((item) => !item.identity.accepted && !item.identity.candidate).length,
      mappingConflicts: review.filter((item) => item.identity.mappingConflict).length,
      mappingLevels: {
        exact: review.filter((item) => item.identity.acceptedLevel === 'EXACT').length,
        strong: review.filter((item) => item.identity.acceptedLevel === 'STRONG').length,
        confirmedLocal: review.filter((item) => item.identity.acceptedLevel === 'CONFIRMED_LOCAL').length,
        candidate: mappingCount('CANDIDATE'),
        none: review.filter((item) => ['NONE', 'NOT_RESOLVED'].includes(item.identity.mappingState)).length,
        conflict: mappingCount('CONFLICT'),
      },
      telemetryQueried: review.filter((item) => item.telemetry.queried).length,
      telemetryAvailable: review.filter((item) => item.telemetry.returned).length,
      telemetryInsufficient: review.filter((item) => item.telemetry.queried && !item.telemetry.returned).length,
      jiraInspected: review.filter((item) => item.jira.inspected).length,
      slackInspected: review.filter((item) => item.slack.inspected).length,
      topEvidenceGap: topCode(review),
      potentiallyClassifiable: review.filter((item) => ['HIGH', 'MEDIUM'].includes(item.resolutionPotential)).length,
      identityFailure: review.filter((item) => ['IDENTITY_MISSING', 'MAPPING_CONFLICT', 'CANDIDATE_ONLY_SOURCE_MAPPING', 'NO_ACCEPTED_SOURCE_MAPPING'].includes(item.primaryEvidenceGapCode)).length,
      telemetryFailure: review.filter((item) => item.primaryEvidenceGapCode.startsWith('SOURCE_TELEMETRY_')).length,
      sourceInstances: unique(review.map((item) => item.identity.sourceInstance)),
      structuredFieldsAvailable: Object.fromEntries(['application', 'dashboard', 'environment', 'folder', 'host', 'instance', 'ruleId', 'ruleName', 'service', 'testId'].map((field) => [field, review.filter((item) => item.identity.sourceFields[field]).length])),
    };
  });
}

function backlog(records, config = NOISE_EVIDENCE_GAP_CONFIG) {
  const grouped = new Map();
  records.forEach((record) => {
    const key = [record.primaryEvidenceGapCode, record.expectedSource, record.nextBestEvidenceSource, record.nextBestAction].join('|');
    const current = grouped.get(key) || {
      issue: record.primaryEvidenceGap.label,
      source: record.expectedSource,
      alertsAffected: 0,
      resolutionPotential: record.resolutionPotential,
      nextBestEvidenceSource: record.nextBestEvidenceSource,
      recommendedEngineeringAction: record.nextBestAction,
      sourceAvailable: config.supportedMonitoringSources.includes(record.expectedSource),
    };
    current.alertsAffected += 1;
    grouped.set(key, current);
  });
  return [...grouped.values()].sort((left, right) => (
    right.alertsAffected - left.alertsAffected
    || POTENTIAL_RANK[right.resolutionPotential] - POTENTIAL_RANK[left.resolutionPotential]
    || Number(right.sourceAvailable) - Number(left.sourceAvailable)
    || left.issue.localeCompare(right.issue)
  )).map((item, index) => ({ rank: index + 1, ...item }));
}

function patternSummaries(records, groups) {
  const groupMap = new Map(groups.map((group) => [group.groupId, group]));
  const buckets = new Map();
  records.forEach((record) => {
    const key = record.groupId || `unresolved:${record.expectedSource}`;
    const items = buckets.get(key) || [];
    items.push(record);
    buckets.set(key, items);
  });
  return [...buckets.entries()].map(([patternId, items]) => {
    const group = groupMap.get(patternId);
    const primaryGaps = aggregateCodes(items, 'primary');
    return {
      patternId,
      pattern: group?.pattern || `Unresolved ${items[0].expectedSource} occurrences outside a detected noise pattern`,
      source: items[0].expectedSource,
      affectedOccurrences: items.length,
      primaryGap: primaryGaps[0]?.code || 'OTHER',
      primaryGaps,
      secondaryGaps: aggregateCodes(items, 'secondary'),
      resolutionPotential: [...items].sort((left, right) => POTENTIAL_RANK[right.resolutionPotential] - POTENTIAL_RANK[left.resolutionPotential])[0]?.resolutionPotential || 'UNKNOWN',
      nextBestEvidenceSource: items[0].nextBestEvidenceSource,
      nextBestAction: items[0].nextBestAction,
    };
  }).sort((left, right) => right.affectedOccurrences - left.affectedOccurrences || left.pattern.localeCompare(right.pattern));
}

function filterRecords(records, options = {}) {
  const filters = {
    evidenceSource: canonical(options.evidenceSource),
    mappingState: canonical(options.mappingState),
    nextBestEvidenceSource: canonical(options.nextBestEvidenceSource),
    primaryGap: canonical(options.primaryGap),
    resolutionPotential: canonical(options.resolutionPotential),
  };
  return records.filter((record) => (
    (!filters.evidenceSource || canonical(record.expectedSource) === filters.evidenceSource)
    && (!filters.mappingState || canonical(record.identity.mappingState) === filters.mappingState)
    && (!filters.nextBestEvidenceSource || canonical(record.nextBestEvidenceSource) === filters.nextBestEvidenceSource)
    && (!filters.primaryGap || canonical(record.primaryEvidenceGapCode) === filters.primaryGap)
    && (!filters.resolutionPotential || canonical(record.resolutionPotential) === filters.resolutionPotential)
  ));
}

function createNoiseEvidenceGapService({
  actionability = actionabilityService,
  config = NOISE_EVIDENCE_GAP_CONFIG,
  enrichment = enrichmentService,
  identity = sourceIdentityService,
  now = () => Date.now(),
  phase1 = phase1Service,
} = {}) {
  const cache = new Map();

  async function loadIdentityCoverage(range) {
    const first = await identity.getCoverage({ range, page: 1, size: 100 });
    const entities = [...(first.entities || [])];
    for (let page = 2; page <= Number(first.pagination?.totalPages || 1); page += 1) {
      const response = await identity.getCoverage({ range, page, size: 100 });
      entities.push(...(response.entities || []));
    }
    return { coverage: first, entities };
  }

  async function build(range, refresh = false) {
    const cached = cache.get(range);
    if (!refresh && cached && now() - cached.cachedAtMs < config.cacheTtlMs) return { ...cached.value, cacheHit: true };
    const startedAt = now();
    const baseline = await actionability.list({ range, page: 1, size: 100, refresh });
    const analysis = await phase1.analyzeRange(range, refresh);
    const overrides = enrichment.getOverrides(range, analysis.analysisVersion);
    const identityResult = await loadIdentityCoverage(range);
    const identityByGroup = new Map(identityResult.entities.map((item) => [item.groupId, item]));

    const candidatesByAlert = new Map();
    analysis.groups.forEach((group) => {
      const actionabilityResult = applyOccurrenceOverrides(group, classifyPattern(group), overrides);
      actionabilityResult.occurrences.forEach((occurrence) => {
        const id = occurrence.canonicalOperationsId;
        const candidates = candidatesByAlert.get(id) || [];
        candidates.push({ group, groupId: group.groupId, occurrence });
        candidatesByAlert.set(id, candidates);
      });
    });

    const allRecords = (analysis._normalizedAlerts || []).map((alert) => {
      const id = alertId(alert);
      const candidates = candidatesByAlert.get(id) || [];
      const selected = candidates.length ? chooseGlobalOccurrence(candidates) : {
        group: null,
        groupId: null,
        occurrence: overrides.get(id) || classifyOccurrence({ alert, group: {} }),
      };
      const expectedSource = normalizeSource(alert.source || alert.sourceSystem || alert.integrationName || selected.group?.source);
      const identityRecord = selected.groupId ? identityByGroup.get(selected.groupId) : null;
      const identityDiagnostic = mappingDiagnostic(identityRecord, expectedSource, alert);
      const occurrence = selected.occurrence;
      const base = {
        alert: {
          acknowledged: alert.acknowledged === true,
          alertNumber: alertNumber(alert) || null,
          createdAt: alert.createdAt || alert.firstOccurredAt || null,
          id,
          status: cleanText(alert.status) || null,
          title: cleanText(alert.title || alert.message || selected.group?.pattern) || null,
        },
        expectedSource,
        groupId: selected.groupId,
        identity: identityDiagnostic,
        occurrence,
        pattern: selected.group?.pattern || null,
      };
      return {
        ...base,
        jira: jiraDiagnostic(occurrence),
        operations: operationsDiagnostic(alert, occurrence),
        slack: slackDiagnostic(occurrence),
        telemetry: telemetryDiagnostic(occurrence, expectedSource),
      };
    });

    const needsReview = allRecords.filter((record) => record.occurrence.classification === 'NEEDS_REVIEW').map((record) => ({ ...record, ...classifyGap(record, config) }));
    const summary = {
      total: allRecords.length,
      actionable: allRecords.filter((item) => item.occurrence.classification === 'ACTIONABLE').length,
      nonActionable: allRecords.filter((item) => item.occurrence.classification === 'NON_ACTIONABLE').length,
      needsReview: needsReview.length,
    };
    summary.reconciliation = summary.actionable + summary.nonActionable + summary.needsReview === summary.total && summary.needsReview === needsReview.length;
    const primaryGaps = aggregateCodes(needsReview, 'primary');
    const sourceMappable = needsReview.filter((item) => item.identity.acceptedAnySource).length;
    const potentiallyClassifiable = needsReview.filter((item) => ['HIGH', 'MEDIUM'].includes(item.resolutionPotential)).length;
    const value = {
      phase: '3.2',
      evidenceGapVersion: config.analysisVersion,
      analysisVersion: analysis.analysisVersion,
      range,
      summary,
      primaryGapReconciliation: primaryGaps.reduce((sum, item) => sum + item.count, 0) === summary.needsReview,
      primaryGaps,
      secondaryGaps: aggregateCodes(needsReview, 'secondary'),
      sourceBreakdown: sourceBreakdown(allRecords, needsReview),
      mappingFunnel: mappingFunnel(needsReview),
      resolutionBacklog: backlog(needsReview, config),
      coverage: {
        currentlyClassified: summary.actionable + summary.nonActionable,
        currentlyClassifiedPercentage: percent(summary.actionable + summary.nonActionable, summary.total),
        currentlyUnresolved: summary.needsReview,
        potentiallyClassifiable,
        structurallyUnresolved: summary.needsReview - potentiallyClassifiable,
      },
      sourceMappable: {
        before: 0,
        after: sourceMappable,
        previousZeroReason: 'Phase 3.1 status used an empty in-memory snapshot until the actionability/catalog path had run. Phase 2.8 mappings were present but the status route had not initialized their occurrence counts.',
        thresholdsChanged: false,
      },
      patterns: patternSummaries(needsReview, analysis.groups),
      filterOptions: {
        evidenceSources: unique(needsReview.map((item) => item.expectedSource)).sort(),
        mappingStates: unique(needsReview.map((item) => item.identity.mappingState)).sort(),
        nextBestEvidenceSources: unique(needsReview.map((item) => item.nextBestEvidenceSource)).sort(),
        primaryGaps: primaryGaps.map((item) => item.code),
        resolutionPotentials: ['HIGH', 'MEDIUM', 'LOW', 'UNKNOWN'],
      },
      diagnostics: {
        externalApiCalls: Number(identityResult.coverage?.performance?.externalApiCalls || 0),
        identityInventoryCacheHit: identityResult.coverage?.performance?.cacheHit === true,
        inventoryReuse: identityResult.coverage?.performance?.cacheHit === true ? 'REUSED' : 'BUILT_ONCE',
        identityPatterns: identityResult.entities.length,
        occurrencesInspected: allRecords.length,
      },
      classificationsChanged: false,
      scoresChanged: false,
      readOnly: true,
      externalMutations: 'none',
      aiUsed: false,
    };
    value.performance = { executionTimeMs: Math.max(0, now() - startedAt), cacheHit: false, cacheTtlMs: config.cacheTtlMs };
    cache.set(range, { cachedAtMs: now(), records: needsReview, value });
    return value;
  }

  async function getOverview(options = {}) {
    const range = parseRange(options.range);
    const built = await build(range, String(options.refresh || '').toLowerCase() === 'true');
    const cached = cache.get(range);
    const filteredRecords = filterRecords(cached?.records || [], options);
    return {
      ...built,
      selection: {
        evidenceSource: options.evidenceSource || null,
        mappingState: options.mappingState || null,
        nextBestEvidenceSource: options.nextBestEvidenceSource || null,
        primaryGap: options.primaryGap || null,
        resolutionPotential: options.resolutionPotential || null,
      },
      filtered: {
        occurrences: filteredRecords.length,
        primaryGaps: aggregateCodes(filteredRecords, 'primary'),
        patterns: patternSummaries(filteredRecords, []),
      },
    };
  }

  async function getPattern(patternId, options = {}) {
    const range = parseRange(options.range);
    await build(range, String(options.refresh || '').toLowerCase() === 'true');
    const state = cache.get(range);
    const records = (state?.records || []).filter((item) => (item.groupId || `unresolved:${item.expectedSource}`) === String(patternId));
    const pattern = state?.value?.patterns?.find((item) => item.patternId === String(patternId));
    if (!pattern) {
      const error = new Error('No evidence-gap pattern matched the requested identifier.');
      error.code = 'EVIDENCE_GAP_PATTERN_NOT_FOUND';
      error.safeMessage = error.message;
      error.status = 404;
      throw error;
    }
    return {
      phase: '3.2',
      range,
      pattern,
      summary: {
        affectedOccurrences: records.length,
        primaryGaps: aggregateCodes(records, 'primary'),
        secondaryGaps: aggregateCodes(records, 'secondary'),
        potentiallyClassifiable: records.filter((item) => ['HIGH', 'MEDIUM'].includes(item.resolutionPotential)).length,
      },
      occurrences: records.map((item) => ({
        alert: item.alert,
        expectedSource: item.expectedSource,
        identity: item.identity,
        jira: item.jira,
        nextBestAction: item.nextBestAction,
        nextBestEvidenceSource: item.nextBestEvidenceSource,
        operations: item.operations,
        primaryEvidenceGap: item.primaryEvidenceGap,
        resolutionPotential: item.resolutionPotential,
        secondaryEvidenceGaps: item.secondaryEvidenceGaps,
        slack: item.slack,
        telemetry: {
          available: item.telemetry.available,
          outcome: item.telemetry.outcome,
          queried: item.telemetry.queried,
          returned: item.telemetry.returned,
          sourceStatus: item.telemetry.sourceStatus,
          state: item.telemetry.state,
        },
      })),
      classificationsChanged: false,
      scoresChanged: false,
      externalMutations: 'none',
      aiUsed: false,
    };
  }

  async function getRecords(options = {}) {
    const range = parseRange(options.range);
    await build(range, String(options.refresh || '').toLowerCase() === 'true');
    const records = cache.get(range)?.records || [];
    return filterRecords(records, options);
  }

  function invalidate() {
    cache.clear();
  }

  return { build, getOverview, getPattern, getRecords, invalidate };
}

module.exports = {
  classifyGap,
  createNoiseEvidenceGapService,
  mappingDiagnostic,
  normalizeSource,
  service: createNoiseEvidenceGapService(),
};
