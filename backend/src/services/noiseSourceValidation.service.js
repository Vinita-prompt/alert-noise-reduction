const { NOISE_SOURCE_VALIDATION_CONFIG } = require('../config/noiseSourceValidation');
const { service: phaseOneService } = require('./noiseAnalysis.service');
const { service: noiseEvidenceService } = require('./noiseEvidence.service');
const { service: sourceIdentityService } = require('./sourceIdentity.service');

const VALID_SCOPES = new Set(['pattern', 'latest', 'occurrence']);
const MONITORING_SOURCES = new Set(['AppDynamics', 'Grafana', 'ThousandEyes', 'Nagios']);
const POSITIVE_OUTCOMES = new Set([
  'REAL_DEGRADATION',
  'NETWORK_DEGRADATION',
  'TEST_FAILURE',
  'HOST_PROBLEM',
  'SERVICE_PROBLEM',
]);
const RECOVERY_OUTCOMES = new Set(['RECOVERY_CONFIRMED', 'NO_SUPPORTING_PROBLEM']);

function safeError(message, code, status = 400) {
  const error = new Error(message);
  error.code = code;
  error.safeMessage = message;
  error.status = status;
  return error;
}

function cleanText(value) {
  return String(value || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function canonical(value) {
  return cleanText(value).toLowerCase();
}

function unique(values) {
  return [...new Set(values.filter(Boolean).map((value) => cleanText(value)).filter(Boolean))];
}

function toMs(value) {
  const parsed = value ? new Date(value).getTime() : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function toIso(value) {
  const milliseconds = typeof value === 'number' ? value : toMs(value);
  return milliseconds === null ? null : new Date(milliseconds).toISOString();
}

function clamp(value, minimum = 0, maximum = 100) {
  return Math.max(minimum, Math.min(maximum, Math.round(Number(value) || 0)));
}

function confidenceLevel(score) {
  if (score >= 80) return 'HIGH';
  if (score >= 55) return 'MEDIUM';
  return 'LOW';
}

function parseMinutes(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 30) {
    throw safeError('Investigation window minutes must be a whole number from 1 to 30.', 'INVALID_VALIDATION_WINDOW');
  }
  return parsed;
}

function sampleOccurrences(alerts, maximum) {
  const sorted = [...alerts].sort((left, right) => (toMs(left.createdAt) || 0) - (toMs(right.createdAt) || 0));
  if (sorted.length <= maximum) return sorted;
  const indexes = new Set([0, sorted.length - 1]);
  for (let index = 1; index < maximum - 1; index += 1) {
    indexes.add(Math.round((index * (sorted.length - 1)) / (maximum - 1)));
  }
  return [...indexes].sort((left, right) => left - right).map((index) => sorted[index]).slice(0, maximum);
}

function selectOccurrences(group, options, config) {
  const alerts = [...(group.alerts || [])].filter((alert) => toMs(alert.createdAt || alert.firstOccurredAt) !== null);
  const scope = VALID_SCOPES.has(options.scope) ? options.scope : 'pattern';
  if (!alerts.length) return { alerts: [], requested: 0, sampled: false, scope };
  if (scope === 'latest') {
    const latest = alerts.reduce((selected, alert) => (
      (toMs(alert.createdAt) || 0) > (toMs(selected.createdAt) || 0) ? alert : selected
    ));
    return { alerts: [latest], requested: alerts.length, sampled: false, scope };
  }
  if (scope === 'occurrence') {
    const occurrenceId = cleanText(options.occurrenceId);
    if (!occurrenceId) throw safeError('occurrenceId is required when scope is occurrence.', 'MISSING_OCCURRENCE_ID');
    const alert = alerts.find((item) => [item.id, item.canonicalOperationsId, item.tinyId, item.alertNumber].filter(Boolean).map(String).includes(occurrenceId));
    if (!alert) throw safeError('The requested occurrence is not part of this pattern.', 'OCCURRENCE_NOT_FOUND', 404);
    return { alerts: [alert], requested: alerts.length, sampled: false, scope };
  }
  const selected = sampleOccurrences(alerts, config.maxOccurrences);
  return { alerts: selected, requested: alerts.length, sampled: selected.length < alerts.length, scope };
}

function buildInvestigationWindows(selection, options, config, nowMs) {
  const beforeMinutes = parseMinutes(options.beforeMinutes, config.beforeMinutes);
  const afterMinutes = parseMinutes(options.afterMinutes, config.afterMinutes);
  const beforeMs = beforeMinutes * 60 * 1000;
  const afterMs = afterMinutes * 60 * 1000;
  const maxWindowMs = Math.max(1, Number(config.maxWindowMinutes || 60)) * 60 * 1000;
  const windows = selection.alerts.map((alert) => {
    const activeFromMs = toMs(alert.createdAt || alert.firstOccurredAt);
    const closedAtMs = toMs(alert.closeTime || alert.closedAt || alert.resolvedAt);
    const observedAtMs = toMs(alert.lastOccurredAt || alert.updatedAt);
    const requestedActiveToMs = closedAtMs || Math.max(activeFromMs, Math.min(nowMs, observedAtMs || nowMs));
    const activeToMs = Math.min(requestedActiveToMs, activeFromMs + maxWindowMs);
    const open = closedAtMs === null && !/closed|resolved/i.test(String(alert.status || ''));
    return {
      alertNumber: alert.tinyId || alert.alertNumber || null,
      canonicalOperationsId: alert.id || alert.canonicalOperationsId || null,
      before: { from: toIso(activeFromMs - beforeMs), to: toIso(activeFromMs) },
      during: { from: toIso(activeFromMs), to: toIso(activeToMs), open, capped: requestedActiveToMs > activeToMs },
      after: open ? { from: null, to: null, available: false } : { from: toIso(activeToMs), to: toIso(activeToMs + afterMs), available: true },
    };
  });
  return { afterMinutes, beforeMinutes, maxWindowMinutes: Math.round(maxWindowMs / 60000), during: 'Operations alert active duration', windows };
}

function phaseForTimestamp(value, windows) {
  const timestamp = toMs(value);
  if (timestamp === null) return 'unknown';
  for (const window of windows) {
    const beforeFrom = toMs(window.before.from);
    const activeFrom = toMs(window.during.from);
    const activeTo = toMs(window.during.to);
    const afterTo = toMs(window.after.to);
    if (beforeFrom !== null && timestamp >= beforeFrom && timestamp < activeFrom) return 'before';
    if (activeFrom !== null && activeTo !== null && timestamp >= activeFrom && timestamp <= activeTo) return 'during';
    if (activeTo !== null && afterTo !== null && timestamp > activeTo && timestamp <= afterTo) return 'after';
  }
  return 'unknown';
}

function mappingQuality(source) {
  if (source.source === 'JSM Operations') return 'EXACT';
  const identityLevel = source.identityMapping?.level;
  if (['EXACT', 'STRONG', 'CONFIRMED_LOCAL'].includes(identityLevel) && source.identityMapping?.rejected !== true) {
    return identityLevel === 'CONFIRMED_LOCAL' ? 'STRONG' : identityLevel;
  }
  const relationships = source.relationships || [];
  const exactRelationship = relationships.find((item) => item.relationship === 'confirmed' && (item.evidence || []).some((reason) => /^Exact (Alert|Jira|Grafana|ThousandEyes)/i.test(reason)));
  if (exactRelationship) return 'EXACT';
  if (relationships.some((item) => item.relationship === 'confirmed' || Number(item.score) >= 65)) return 'STRONG';
  if (relationships.some((item) => Number(item.score) >= 35)) return 'CANDIDATE';
  return 'NONE';
}

function coverageFor(source, selection) {
  if (source.status === 'error' || source.status === 'not_applicable') return 'UNAVAILABLE';
  if (source.status === 'partial' || selection.sampled || source.totalMatches > (source.evidence || []).length) return 'PARTIAL';
  return 'COMPLETE';
}

function phaseMetrics(source, windows) {
  const phases = { before: [], during: [], after: [], unknown: [] };
  (source.evidence || []).forEach((item) => phases[phaseForTimestamp(item.timestamp, windows)].push(item));
  const metric = (label, value) => ({ label, value });
  const result = {
    before: [metric('Evidence records', phases.before.length)],
    during: [metric('Evidence records', phases.during.length)],
    after: [metric('Evidence records', phases.after.length)],
    unknown: [metric('Outside/untimed records', phases.unknown.length)],
  };
  if (source.source === 'Slack') {
    ['before', 'during', 'after'].forEach((phase) => result[phase].push(metric('Thread replies', phases[phase].filter((item) => item.type === 'thread_reply').length)));
  }
  if (source.source === 'ThousandEyes') {
    ['before', 'during', 'after'].forEach((phase) => result[phase].push(metric('Affected agents', unique(phases[phase].flatMap((item) => item.metadata?.agentIds || [])).length)));
  }
  if (source.source === 'Nagios') {
    ['before', 'during', 'after'].forEach((phase) => result[phase].push(metric('Problem states', phases[phase].filter((item) => /critical|down|warning|unknown|unreachable/i.test(`${item.severity} ${item.metadata?.status}`)).length)));
  }
  if (source.source === 'AppDynamics') {
    ['before', 'during', 'after'].forEach((phase) => result[phase].push(metric('Health-rule events', phases[phase].filter((item) => item.metadata?.healthRule || /health|violation/i.test(`${item.type} ${item.title}`)).length)));
  }
  return result;
}

function sourceOutcome(source, quality) {
  const evidence = source.evidence || [];
  const combined = canonical(evidence.map((item) => `${item.type} ${item.title} ${item.summary} ${item.severity} ${item.metadata?.status || ''}`).join(' '));
  if (source.source === 'JSM Operations') {
    const closed = evidence.some((item) => item.type === 'alert_closed');
    return { code: closed ? 'LIFECYCLE_OBSERVED' : 'ALERT_TRIGGERED', detail: closed ? 'Operations contains real created and closed lifecycle timestamps for the selected scope.' : 'Operations contains a real triggered alert lifecycle for the selected scope.' };
  }
  if (source.source === 'AppDynamics') {
    if (!evidence.length) return { code: 'INSUFFICIENT_DATA', detail: quality === 'NONE' ? 'No exact application mapping was available for a safe AppDynamics lookup.' : 'The mapped AppDynamics query returned no event or metric evidence in the bounded occurrence windows.' };
    if (/critical|error|violation|slow|degrad|stall/.test(combined)) return { code: 'REAL_DEGRADATION', detail: 'Mapped AppDynamics events show a degradation or health-rule violation in the bounded investigation window.' };
    if (/recover|normal|resolved|ended/.test(combined)) return { code: 'RECOVERY_CONFIRMED', detail: 'Mapped AppDynamics evidence includes an explicit recovery or return-to-normal signal.' };
    return { code: 'SUPPORTING_EVENT', detail: 'Mapped AppDynamics events were found, but the available fields do not prove a measurable degradation.' };
  }
  if (source.source === 'Grafana') {
    if (!evidence.length) return { code: 'INSUFFICIENT_DATA', detail: quality === 'NONE' ? 'No exact Grafana rule or UID mapping was available.' : 'The mapped Grafana lookup returned no evidence.' };
    return { code: 'ALERT_RULE_CONFIRMED', detail: 'A real Grafana alert rule or UID was matched. Rule metadata alone is not treated as proof of metric degradation.' };
  }
  if (source.source === 'ThousandEyes') {
    if (!evidence.length) return { code: 'INSUFFICIENT_DATA', detail: quality === 'NONE' ? 'No exact ThousandEyes alert ID was available.' : 'The v7 alert lookup returned no occurrence evidence.' };
    if (/clear|resolved|recovered|normal/.test(combined)) return { code: 'RECOVERY_CONFIRMED', detail: 'The mapped ThousandEyes v7 alert reports a cleared or recovered state.' };
    if (/network|path|latency|loss|agent/.test(combined)) return { code: 'NETWORK_DEGRADATION', detail: 'The mapped ThousandEyes v7 alert shows network/test degradation with the returned affected-agent context.' };
    return { code: 'TEST_FAILURE', detail: 'The mapped ThousandEyes v7 alert reports a triggered test failure.' };
  }
  if (source.source === 'Nagios') {
    if (!evidence.length) return { code: 'INSUFFICIENT_DATA', detail: quality === 'NONE' ? 'No exact Nagios host/service mapping was available.' : 'The read-only Nagios lookup did not return historical state evidence inside the bounded windows.' };
    if (/critical|down|warning|unknown|unreachable/.test(combined)) return { code: evidence.some((item) => item.type === 'host') ? 'HOST_PROBLEM' : 'SERVICE_PROBLEM', detail: 'The exact Nagios host/service mapping reports a non-healthy state in the bounded window.' };
    if (/\bok\b|\bup\b|recover/.test(combined)) return { code: 'RECOVERY_CONFIRMED', detail: 'The exact Nagios host/service mapping reports a healthy or recovered state.' };
    return { code: 'INSUFFICIENT_DATA', detail: 'Nagios returned a mapped record, but its available status fields do not prove a problem or recovery.' };
  }
  if (source.source === 'ACC Jira') {
    const confirmed = (source.relationships || []).some((item) => item.relationship === 'confirmed');
    if (!confirmed) return { code: evidence.length ? 'CANDIDATE_ONLY' : 'NO_CONFIRMED_JIRA_RELATIONSHIP', detail: evidence.length ? 'Jira returned entity-plus-time candidates, but no exact alert number or Jira key confirms a relationship.' : 'The bounded Jira search found no exact incident/problem relationship.' };
    const issueTypes = canonical(evidence.map((item) => item.metadata?.issueType).join(' '));
    return { code: issueTypes.includes('problem') ? 'ESCALATED_TO_PROBLEM' : 'ESCALATED_TO_INCIDENT', detail: 'An exact alert number or Jira key confirms the ACC Jira relationship.' };
  }
  if (source.source === 'Slack') {
    if (!evidence.length) return { code: 'NO_RELEVANT_DISCUSSION', detail: 'The bounded exact-alert-number Slack lookup returned no relevant messages.' };
    if (/acknowledg|investigat|resolv|escalat|restart|rollback|fixed|working on/.test(combined)) return { code: 'ACTIVE_OPERATOR_RESPONSE', detail: 'Exact-alert-number Slack messages contain explicit investigation or response activity.' };
    return { code: 'DISCUSSION_ONLY', detail: 'Exact-alert-number Slack context was found, but the messages do not prove a remediation action.' };
  }
  return { code: 'INSUFFICIENT_DATA', detail: 'No deterministic source interpretation is available.' };
}

function sourceConfidence(source, quality, coverage) {
  const base = { EXACT: 88, STRONG: 70, CANDIDATE: 42, NONE: 10 }[quality];
  const timestamped = (source.evidence || []).some((item) => toMs(item.timestamp) !== null);
  const telemetryPenalty = source.source === 'Grafana' && (source.evidence || []).every((item) => item.type === 'alert_rule') ? 8 : 0;
  const hasEvidence = (source.evidence || []).length > 0;
  const score = hasEvidence
    ? clamp(base + (timestamped ? 5 : 0) + (coverage === 'COMPLETE' ? 3 : coverage === 'UNAVAILABLE' ? -8 : 0) + (source.evidence.length > 1 ? 2 : 0) - telemetryPenalty)
    : clamp(Math.min(base, 35) + (coverage === 'UNAVAILABLE' ? -8 : 0));
  const reasons = [`${quality} identifier mapping`, `${coverage.toLowerCase()} source coverage`];
  if (timestamped) reasons.push('Real source timestamp available');
  if (!hasEvidence) reasons.push('No source record was returned in the bounded investigation window');
  if (telemetryPenalty) reasons.push('Rule metadata available without panel metric telemetry');
  return { level: confidenceLevel(score), reasons, score };
}

function scopeSourceEvidence(source, investigationWindow) {
  const selectedIds = new Set(investigationWindow.windows.map((window) => String(window.canonicalOperationsId || '')).filter(Boolean));
  const selectedNumbers = new Set(investigationWindow.windows.map((window) => String(window.alertNumber || '')).filter(Boolean));
  const evidence = (source.evidence || []).filter((item) => {
    const phase = phaseForTimestamp(item.timestamp, investigationWindow.windows);
    if (source.source === 'JSM Operations') {
      const operationsId = String(item.metadata?.canonicalOperationsId || '');
      const alertNumber = String(item.metadata?.alertNumber || '');
      return selectedIds.has(operationsId) || selectedNumbers.has(alertNumber);
    }
    if (source.source === 'Slack') {
      return selectedNumbers.has(String(item.metadata?.alertNumber || '')) && phase !== 'unknown';
    }
    if (['AppDynamics', 'Nagios'].includes(source.source)) return phase !== 'unknown';
    return true;
  });
  const evidenceIds = new Set(evidence.map((item) => item.id));
  return {
    ...source,
    status: source.status === 'working' && !evidence.length ? 'no_evidence' : source.status,
    evidence,
    relationships: (source.relationships || []).filter((relationship) => !relationship.evidenceId || evidenceIds.has(relationship.evidenceId)),
  };
}

function normalizeSource(source, selection, investigationWindow, config) {
  const scoped = scopeSourceEvidence(source, investigationWindow);
  const quality = mappingQuality(scoped);
  const coverage = coverageFor(scoped, selection);
  const matchReasons = unique([
    ...(scoped.identityMapping?.reasons || []),
    ...(scoped.relationships || []).flatMap((item) => item.evidence || []),
  ]);
  if (!matchReasons.length && scoped.source === 'JSM Operations') matchReasons.push('Authoritative Operations lifecycle matched by canonical alert ID in the selected occurrence scope.');
  if (!matchReasons.length) matchReasons.push(scoped.reason || scoped.safeError || (scoped.status === 'not_applicable' ? 'This source was not identified in the selected Operations pattern.' : 'No exact or strong identifier relationship was found.'));
  const outcome = sourceOutcome(scoped, quality);
  const confidence = sourceConfidence(scoped, quality, coverage);
  return {
    source: scoped.source,
    sourceStatus: scoped.status,
    adapter: scoped.adapter || null,
    pipelineState: scoped.pipelineState || (scoped.status === 'not_applicable'
      ? 'NOT_QUERIED'
      : scoped.status === 'error' ? 'QUERY_FAILED'
        : scoped.evidence?.length ? 'RECORDS_FOUND' : 'NO_RECORDS'),
    evidenceState: scoped.evidenceState || null,
    recordsReturned: Number(scoped.recordsReturned ?? scoped.evidence?.length ?? 0),
    matchedRecords: Number(scoped.matchedRecords ?? scoped.evidence?.length ?? 0),
    failureReason: scoped.failureReason || scoped.safeError || scoped.reason || null,
    diagnostics: scoped.diagnostics || null,
    executionTimeMs: Number(scoped.executionTimeMs || 0),
    mappingQuality: quality,
    coverage,
    matchReasons,
    outcome,
    confidence,
    metrics: phaseMetrics(scoped, investigationWindow.windows),
    query: scoped.query || null,
    queryReuse: scoped.queryReuse || null,
    evidence: (scoped.evidence || []).slice(0, config.maxEvidencePerSource).map((item) => ({
      ...item,
      phase: phaseForTimestamp(item.timestamp, investigationWindow.windows),
    })),
  };
}

function crossSourceAssessment(sources) {
  const monitoring = sources.filter((source) => MONITORING_SOURCES.has(source.source));
  const supporting = monitoring.filter((source) => POSITIVE_OUTCOMES.has(source.outcome.code) && ['EXACT', 'STRONG'].includes(source.mappingQuality));
  const recovery = monitoring.filter((source) => RECOVERY_OUTCOMES.has(source.outcome.code) && ['EXACT', 'STRONG'].includes(source.mappingQuality));
  const contradictions = supporting.length && recovery.length
    ? [{ sources: unique([...supporting.map((item) => item.source), ...recovery.map((item) => item.source)]), detail: 'Mapped monitoring evidence includes both problem and recovery/healthy signals. Treat this as a possible transient event and review the timestamps before tuning.' }]
    : [];
  let status = 'INSUFFICIENT_EVIDENCE';
  let summary = 'The bounded source checks did not provide enough exact or strong monitoring evidence for a cross-source conclusion.';
  if (supporting.length >= 2) {
    status = 'CONSISTENT_DEGRADATION';
    summary = `${supporting.map((item) => item.source).join(' and ')} independently support the same operational degradation window.`;
  } else if (supporting.length === 1 && recovery.length) {
    status = 'TRANSIENT_OR_MIXED';
    summary = `${supporting[0].source} supports a problem while ${recovery.map((item) => item.source).join(', ')} provides recovery or healthy-state evidence.`;
  } else if (supporting.length === 1) {
    status = 'SINGLE_SOURCE_SUPPORT';
    summary = `${supporting[0].source} provides exact/strong supporting evidence; no second independent monitoring source confirmed it.`;
  } else if (recovery.length) {
    status = 'NO_SUPPORTING_PROBLEM';
    summary = `${recovery.map((item) => item.source).join(', ')} provides healthy or recovery evidence without a mapped degradation signal.`;
  }
  return { contradictions, recoverySources: recovery.map((item) => item.source), status, summary, supportingSources: supporting.map((item) => item.source) };
}

function overallConclusion(group, sources, consistency) {
  const labels = new Set(group.labels || [group.classification]);
  const jira = sources.find((source) => source.source === 'ACC Jira');
  const slack = sources.find((source) => source.source === 'Slack');
  const confirmedJira = ['ESCALATED_TO_INCIDENT', 'ESCALATED_TO_PROBLEM'].includes(jira?.outcome.code);
  if (consistency.supportingSources.length >= 2) return { code: 'CROSS_SOURCE_SAME_EVENT', label: 'Cross-source same event', detail: consistency.summary };
  if (consistency.supportingSources.length && confirmedJira) return { code: 'RECURRING_BUT_ACTIONABLE', label: 'Recurring but actionable', detail: 'Strong monitoring evidence and an exact ACC Jira relationship show that this repeated pattern had an operational outcome.' };
  if (consistency.status === 'TRANSIENT_OR_MIXED') return { code: 'LIKELY_TRANSIENT_DEGRADATION', label: 'Likely transient degradation', detail: consistency.summary };
  if (labels.has('flapping') || labels.has('flapping_like')) return { code: 'LIKELY_FLAPPING_NOTIFICATION', label: 'Likely flapping notification', detail: 'Operations lifecycle behavior is flapping-like, but source validation did not establish sustained cross-source degradation.' };
  if (labels.has('duplicate')) return { code: 'LIKELY_DUPLICATE_NOTIFICATION', label: 'Likely duplicate notification', detail: 'The deterministic duplicate pattern remains supported; source validation did not independently prove a separate degradation for every occurrence.' };
  if (consistency.status === 'NO_SUPPORTING_PROBLEM') return { code: 'NO_SUPPORTING_MONITORING_EVIDENCE', label: 'No supporting monitoring evidence', detail: consistency.summary };
  if (slack?.outcome.code === 'ACTIVE_OPERATOR_RESPONSE') return { code: 'OPERATOR_RESPONSE_WITHOUT_SOURCE_PROOF', label: 'Operator response without source proof', detail: 'Slack shows response activity, but bounded source evidence is insufficient to confirm the underlying technical condition.' };
  return { code: 'INSUFFICIENT_EVIDENCE', label: 'Insufficient evidence', detail: 'Available exact/strong source data is not sufficient for a safe operational conclusion.' };
}

function overallConfidence(sources, consistency) {
  const relevant = sources.filter((source) => source.source === 'JSM Operations' || source.sourceStatus !== 'not_applicable');
  const mapped = relevant.filter((source) => source.mappingQuality !== 'NONE' && source.evidence.length);
  const monitoringMapped = mapped.filter((source) => MONITORING_SOURCES.has(source.source));
  const operationalContext = mapped.filter((source) => !MONITORING_SOURCES.has(source.source));
  const averageFor = (items) => items.length ? items.reduce((sum, source) => sum + source.confidence.score, 0) / items.length : 0;
  const jiraConfirmed = sources.some((source) => source.source === 'ACC Jira' && ['ESCALATED_TO_INCIDENT', 'ESCALATED_TO_PROBLEM'].includes(source.outcome.code));
  const monitoringAverage = averageFor(monitoringMapped);
  const contextAverage = averageFor(operationalContext);
  const diversityBonus = Math.max(0, consistency.supportingSources.length - 1) * 6;
  const unavailablePenalty = relevant.filter((source) => source.coverage === 'UNAVAILABLE').length * 5;
  const uncappedScore = monitoringMapped.length
    ? monitoringAverage * 0.8 + contextAverage * 0.2 + diversityBonus - unavailablePenalty
    : jiraConfirmed ? 60 - unavailablePenalty : Math.min(50, contextAverage - 40) - unavailablePenalty;
  const score = clamp(uncappedScore);
  const reasons = [
    `${mapped.length} source${mapped.length === 1 ? '' : 's'} with mapped real evidence`,
    `${monitoringMapped.length} mapped monitoring source${monitoringMapped.length === 1 ? '' : 's'}`,
    `${consistency.supportingSources.length} independent supporting monitoring source${consistency.supportingSources.length === 1 ? '' : 's'}`,
  ];
  if (!monitoringMapped.length) reasons.push(jiraConfirmed ? 'Confirmed Jira context provides limited outcome confidence without source telemetry' : 'No mapped monitoring evidence caps validation confidence at Low');
  if (unavailablePenalty) reasons.push('Unavailable source coverage reduced confidence');
  if (consistency.contradictions.length) reasons.push('Mixed problem/recovery evidence requires manual timestamp review');
  return { level: confidenceLevel(score), reasons, score };
}

function buildTimeline(sources) {
  return sources.flatMap((source) => source.evidence.map((item) => ({
    id: item.id,
    source: source.source,
    timestamp: item.timestamp,
    phase: item.phase,
    type: item.type,
    title: item.title,
    summary: item.summary,
    mappingQuality: source.mappingQuality,
    url: item.url,
  }))).filter((item) => toMs(item.timestamp) !== null).sort((left, right) => toMs(left.timestamp) - toMs(right.timestamp));
}

function timeoutFallbackEvidence(group, selection, error) {
  const operationsEvidence = selection.alerts.flatMap((alert) => {
    const alertNumber = alert.tinyId || alert.alertNumber || null;
    const created = {
      id: `operations:${alert.id || alert.canonicalOperationsId}:created`,
      source: 'JSM Operations',
      type: 'alert_created',
      timestamp: alert.createdAt || alert.firstOccurredAt || null,
      title: `Alert #${alertNumber || '—'} created`,
      summary: cleanText(alert.title || alert.message || alert.description) || null,
      severity: alert.priority || null,
      metadata: { alertNumber, canonicalOperationsId: alert.id || alert.canonicalOperationsId || null },
    };
    const closedAt = alert.closeTime || alert.closedAt || alert.resolvedAt;
    return closedAt ? [created, { ...created, id: `${created.id}:closed`, type: 'alert_closed', timestamp: closedAt, title: `Alert #${alertNumber || '—'} closed` }] : [created];
  });
  const configuredSources = new Set((group.sources || []).map((value) => canonical(value)));
  const sourceTimedOut = (source) => ({
    source,
    status: 'error',
    evidence: [],
    relationships: [],
    readOnly: true,
    safeError: error.safeMessage || 'The bounded source lookup timed out.',
  });
  const monitoring = ['AppDynamics', 'Grafana', 'ThousandEyes', 'Nagios'].map((source) => (
    [...configuredSources].some((value) => value.includes(canonical(source).replace('dynamics', 'd')))
      ? sourceTimedOut(source)
      : { source, status: 'not_applicable', evidence: [], relationships: [], readOnly: true }
  ));
  return {
    confidence: { level: 'Low', score: 0, relationshipCount: 0, sourceCount: 0, reasons: ['Source lookup exceeded the bounded timeout.'] },
    reviewRisk: group.reviewRisk || null,
    sources: [
      { source: 'JSM Operations', status: 'working', evidence: operationsEvidence, relationships: [], readOnly: true, authoritative: true },
      sourceTimedOut('Slack'),
      sourceTimedOut('ACC Jira'),
      ...monitoring,
    ],
  };
}

function nextSteps(group, sources, conclusion) {
  const steps = [];
  const unmapped = sources.filter((source) => MONITORING_SOURCES.has(source.source) && source.sourceStatus !== 'not_applicable' && source.mappingQuality === 'NONE');
  if (unmapped.length) steps.push(`Add exact source identifiers for ${unmapped.map((item) => item.source).join(', ')} before considering alert tuning.`);
  if (['CROSS_SOURCE_SAME_EVENT', 'RECURRING_BUT_ACTIONABLE'].includes(conclusion.code)) steps.push('Review the confirmed monitoring/Jira evidence with the owning team and retain the alert until a human approves any threshold or deduplication change.');
  if ((group.labels || [group.classification]).some((label) => ['duplicate', 'flapping', 'flapping_like'].includes(label))) steps.push('Review deduplication or evaluation-window tuning as a proposal only; do not suppress this pattern automatically.');
  if (!steps.length) steps.push('Collect a stronger exact identifier or source timestamp before making an alert-policy decision.');
  return steps;
}

function withAbortAndTimeout(promise, { signal, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (handler, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      handler(value);
    };
    const onAbort = () => finish(reject, safeError('Source validation was cancelled.', 'SOURCE_VALIDATION_CANCELLED', 499));
    const timer = setTimeout(() => finish(reject, safeError('Source validation exceeded the bounded timeout.', 'SOURCE_VALIDATION_TIMEOUT', 504)), timeoutMs);
    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then((value) => finish(resolve, value), (error) => finish(reject, error));
    return undefined;
  });
}

function createNoiseSourceValidationService({
  config = NOISE_SOURCE_VALIDATION_CONFIG,
  evidenceService = noiseEvidenceService,
  phase1Service: phase1 = phaseOneService,
  identityService = null,
  now = () => Date.now(),
} = {}) {
  async function investigate(groupId, options = {}) {
    const id = cleanText(groupId);
    if (!/^[a-f0-9]{24}$/.test(id)) throw safeError('A valid analysis group ID is required.', 'INVALID_NOISE_GROUP_ID');
    const range = ['24h', '7d', '30d', '90d'].includes(options.range) ? options.range : '7d';
    const startedAt = now();
    const phaseOne = await withAbortAndTimeout(phase1.getGroup(id, { range }), { signal: options.signal, timeoutMs: config.timeoutMs });
    const selection = selectOccurrences(phaseOne.group, options, config);
    const investigationWindow = buildInvestigationWindows(selection, options, config, now());
    let sourceIdentity = null;
    if (identityService?.resolveGroup) {
      try {
        sourceIdentity = await withAbortAndTimeout(identityService.resolveGroup(phaseOne.group, {
          refresh: String(options.refresh || '').toLowerCase() === 'true',
        }), { signal: options.signal, timeoutMs: config.timeoutMs });
      } catch (error) {
        if (error.code === 'SOURCE_VALIDATION_CANCELLED') throw error;
        sourceIdentity = {
          phase: '2.8',
          unavailable: true,
          safeError: error.safeMessage || 'Source identity resolution was unavailable.',
        };
      }
    }
    let evidence;
    let evidenceTimedOut = false;
    try {
      evidence = await withAbortAndTimeout(evidenceService.getEvidence(id, {
        investigationWindow,
        occurrences: selection.alerts,
        range,
        refresh: String(options.refresh || '').toLowerCase() === 'true',
        strictIdentity: options.strictIdentity === true,
        sourceIdentity: sourceIdentity?.unavailable ? null : sourceIdentity,
      }), { signal: options.signal, timeoutMs: config.timeoutMs });
    } catch (error) {
      if (error.code !== 'SOURCE_VALIDATION_TIMEOUT') throw error;
      evidenceTimedOut = true;
      evidence = timeoutFallbackEvidence(phaseOne.group, selection, error);
    }
    const sources = (evidence.sources || []).map((source) => normalizeSource(source, selection, investigationWindow, config));
    const consistency = crossSourceAssessment(sources);
    const conclusion = overallConclusion(phaseOne.group, sources, consistency);
    const confidence = overallConfidence(sources, consistency);
    return {
      phase: '2.7',
      groupId: id,
      range,
      baseline: {
        labels: phaseOne.group.labels || [phaseOne.group.classification],
        noiseLikelihood: phaseOne.group.noiseLikelihood ?? phaseOne.group.noiseScore,
        reviewRisk: evidence.reviewRisk || phaseOne.group.reviewRisk || null,
        correlationConfidence: evidence.confidence || null,
        scoresRecalculated: false,
      },
      scope: {
        type: selection.scope === 'pattern' ? 'BOUNDED_PATTERN_HISTORY' : selection.scope === 'latest' ? 'LATEST_OCCURRENCE' : 'SELECTED_OCCURRENCE',
        totalOccurrences: selection.requested,
        occurrencesInspected: selection.alerts.length,
        sampled: selection.sampled,
      },
      investigationWindow,
      sourceValidation: {
        conclusion,
        confidence,
        crossSourceConsistency: consistency,
        sources,
        timeline: buildTimeline(sources),
        nextSteps: nextSteps(phaseOne.group, sources, conclusion),
      },
      sourceIdentity,
      execution: {
        executionTimeMs: Math.max(0, now() - startedAt),
        evidenceCacheHit: evidence.cache?.hit === true,
        evidenceTimedOut,
        externalSourceOperations: (evidence.sources || []).filter((source) => source.source !== 'JSM Operations' && source.status !== 'not_applicable').length,
        maxConcurrentSourceQueries: config.maxConcurrentSourceQueries,
        maxOccurrences: config.maxOccurrences,
        timeoutMs: config.timeoutMs,
      },
      advisoryOnly: true,
      externalMutations: 'none',
      suppressionAction: 'never',
    };
  }

  return { investigate };
}

module.exports = {
  buildInvestigationWindows,
  buildTimeline,
  confidenceLevel,
  createNoiseSourceValidationService,
  crossSourceAssessment,
  mappingQuality,
  overallConclusion,
  phaseForTimestamp,
  selectOccurrences,
  service: createNoiseSourceValidationService({ identityService: sourceIdentityService }),
  sourceConfidence,
  sourceOutcome,
  withAbortAndTimeout,
};
