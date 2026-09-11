const { NOISE_ACTIONABILITY_CONFIG } = require('../config/noiseActionability');
const { service: noiseAnalysisService } = require('./noiseAnalysis.service');
const { service: sourceValidationService } = require('./noiseSourceValidation.service');

const ACTIONABILITY_STATES = Object.freeze(['ACTIONABLE', 'NON_ACTIONABLE', 'NEEDS_REVIEW']);
const CONFIDENCE_LEVELS = Object.freeze(['HIGH', 'MEDIUM', 'LOW']);
const MONITORING_SOURCES = new Set(['AppDynamics', 'Grafana', 'ThousandEyes', 'Nagios']);
const ACCEPTED_MAPPINGS = new Set(['EXACT', 'STRONG', 'CONFIRMED_LOCAL']);
const POSITIVE_SOURCE_OUTCOMES = new Set(['REAL_DEGRADATION', 'NETWORK_DEGRADATION', 'TEST_FAILURE', 'HOST_PROBLEM', 'SERVICE_PROBLEM']);
const RECOVERY_SOURCE_OUTCOMES = new Set(['RECOVERY_CONFIRMED', 'NO_SUPPORTING_PROBLEM']);

function safeError(message, code, status = 400) {
  const error = new Error(message);
  error.code = code;
  error.safeMessage = message;
  error.status = status;
  return error;
}

function cleanText(value) {
  return String(value ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function canonical(value) {
  return cleanText(value).toLowerCase();
}

function unique(values) {
  return [...new Set(values.filter(Boolean).map(cleanText).filter(Boolean))];
}

function toMs(value) {
  if (Number.isFinite(value)) return Number(value);
  const parsed = value ? new Date(value).getTime() : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function alertId(alert) {
  return String(alert?.id || alert?.canonicalOperationsId || alert?.externalId || '');
}

function alertNumber(alert) {
  return String(alert?.tinyId || alert?.alertNumber || '');
}

function alertDurationMs(alert) {
  const explicit = Number(alert?.timeToCloseMs ?? alert?.durationMs);
  if (Number.isFinite(explicit) && explicit >= 0) return explicit;
  const created = toMs(alert?.createdAt || alert?.firstOccurredAt);
  const closed = toMs(alert?.closeTime || alert?.closedAt || alert?.resolvedAt);
  return created !== null && closed !== null && closed >= created ? closed - created : null;
}

function labelsFor(group) {
  return new Set(group?.labels || [group?.classification].filter(Boolean));
}

function isClosed(alert) {
  return Boolean(alert?.closeTime || alert?.closedAt || alert?.resolvedAt || /closed|resolved/i.test(String(alert?.status || '')));
}

function reviewRiskLevel(group) {
  return String(group?.reviewRisk?.level || 'LOW').toUpperCase();
}

function occurrenceWindow(alert, sourceValidation, config) {
  const id = alertId(alert);
  const number = alertNumber(alert);
  const configured = sourceValidation?.investigationWindow?.windows?.find((window) => (
    String(window.canonicalOperationsId || '') === id || String(window.alertNumber || '') === number
  ));
  if (configured) {
    return {
      from: toMs(configured.before?.from || configured.during?.from),
      to: toMs(configured.after?.to || configured.during?.to),
      inspected: true,
    };
  }
  const created = toMs(alert?.createdAt || alert?.firstOccurredAt);
  const closed = toMs(alert?.closeTime || alert?.closedAt || alert?.resolvedAt);
  const buffer = config.transientRecoveryMinutes * 60 * 1000;
  return {
    from: created === null ? null : created - buffer,
    to: created === null ? null : (closed || created) + buffer,
    inspected: false,
  };
}

function timestampInWindow(value, window) {
  const timestamp = toMs(value);
  return timestamp !== null && window.from !== null && window.to !== null && timestamp >= window.from && timestamp <= window.to;
}

function exactAlertReference(item, alert) {
  const number = alertNumber(alert);
  const id = alertId(alert);
  if (!number && !id) return false;
  return String(item?.metadata?.alertNumber || '') === number
    || String(item?.metadata?.canonicalOperationsId || '') === id
    || String(item?.correlationKey || '') === `alert:${number}`
    || String(item?.correlationKey || '') === id
    || new RegExp(`Alert\\s*#${number}(?:\\D|$)`, 'i').test(`${item?.title || ''} ${item?.summary || ''}`);
}

function relevantEvidence(source, alert, window, singleOccurrence) {
  return (source?.evidence || []).filter((item) => {
    if (source.source === 'JSM Operations' || source.source === 'Slack' || source.source === 'ACC Jira') {
      if (exactAlertReference(item, alert)) return true;
      return singleOccurrence && source.source !== 'Slack';
    }
    return timestampInWindow(item.timestamp, window);
  });
}

function evidenceSpanMs(evidence) {
  const timestamps = evidence.map((item) => toMs(item.timestamp)).filter((value) => value !== null);
  const explicit = evidence.map((item) => Number(item.metadata?.durationMs)).filter(Number.isFinite);
  if (explicit.length) return Math.max(...explicit);
  return timestamps.length > 1 ? Math.max(...timestamps) - Math.min(...timestamps) : null;
}

function sourceSignal(source, alert, window, singleOccurrence, config) {
  const evidence = relevantEvidence(source, alert, window, singleOccurrence);
  const mappingQuality = String(source?.mappingQuality || 'NONE').toUpperCase();
  const acceptedMapping = ACCEPTED_MAPPINGS.has(mappingQuality);
  const outcome = String(source?.outcome?.code || 'INSUFFICIENT_DATA').toUpperCase();
  const combined = canonical(evidence.map((item) => `${item.type} ${item.title} ${item.summary} ${item.severity} ${item.metadata?.status || ''} ${item.metadata?.state || ''}`).join(' '));
  const durationMs = evidenceSpanMs(evidence) ?? alertDurationMs(alert);
  const recovered = RECOVERY_SOURCE_OUTCOMES.has(outcome) || /recover|resolved|cleared|normal|\bok\b|\bup\b/.test(combined);
  const degradation = POSITIVE_SOURCE_OUTCOMES.has(outcome) || /critical|\bdown\b|unreachable|violation|degrad|test failure|packet loss/.test(combined);
  const agentIds = unique(evidence.flatMap((item) => item.metadata?.agentIds || []));
  const thresholdTelemetry = evidence.some((item) => item.type !== 'alert_rule' && (
    item.metadata?.thresholdViolated === true || /threshold|above|below|breach|violation/.test(canonical(`${item.type} ${item.title} ${item.summary}`))
  ));
  const sustained = Number.isFinite(durationMs) && durationMs >= config.sustainedDegradationMinutes * 60 * 1000;
  const transient = Number.isFinite(durationMs) && durationMs <= config.transientRecoveryMinutes * 60 * 1000;
  let actionable = false;
  let nonActionable = false;
  let reason = null;
  if (acceptedMapping && evidence.length) {
    if (source.source === 'AppDynamics' && degradation && sustained) {
      actionable = true;
      reason = `AppDynamics returned degradation evidence across a sustained ${Math.round(durationMs / 60000)}-minute Operations window.`;
    } else if (source.source === 'AppDynamics' && recovered && transient) {
      nonActionable = true;
      reason = `AppDynamics evidence is consistent with a brief recovery inside ${Math.max(1, Math.round(durationMs / 1000))} seconds.`;
    } else if (source.source === 'Grafana' && thresholdTelemetry && sustained) {
      actionable = true;
      reason = `Grafana telemetry remained threshold-violating across a sustained ${Math.round(durationMs / 60000)}-minute window.`;
    } else if (source.source === 'Grafana' && thresholdTelemetry && recovered && transient) {
      nonActionable = true;
      reason = 'Grafana telemetry shows a transient threshold crossing followed by recovery.';
    } else if (source.source === 'ThousandEyes' && degradation && agentIds.length >= 2) {
      actionable = true;
      reason = `ThousandEyes returned a test failure affecting ${agentIds.length} agents.`;
    } else if (source.source === 'ThousandEyes' && recovered && transient && agentIds.length <= 1) {
      nonActionable = true;
      reason = 'ThousandEyes returned a transient single-agent condition followed by recovery.';
    } else if (source.source === 'Nagios' && degradation && /critical|down|unreachable/.test(combined)) {
      actionable = true;
      reason = `Nagios returned a confirmed ${/down|unreachable/.test(combined) ? 'host' : 'service'} failure state.`;
    } else if (source.source === 'Nagios' && /warning/.test(combined) && recovered && transient) {
      nonActionable = true;
      reason = 'Nagios returned a transient Warning followed by an OK/recovery state.';
    } else if (outcome === 'NO_SUPPORTING_PROBLEM') {
      nonActionable = true;
      reason = `${source.source} explicitly returned no supporting problem in the bounded window.`;
    }
  }
  return {
    acceptedMapping,
    actionable,
    agentCount: agentIds.length,
    coverage: source?.coverage || 'UNAVAILABLE',
    degradation,
    durationMs,
    evidence,
    mappingQuality,
    nonActionable,
    outcome,
    reason,
    recovered,
    source: source?.source,
    sourceStatus: source?.sourceStatus || 'unavailable',
    sustained,
    transient,
  };
}

function duplicateSignal(group, alert, config) {
  if (!labelsFor(group).has('duplicate')) return null;
  const sorted = [...(group?.alerts || [])].sort((left, right) => (toMs(left.createdAt) || 0) - (toMs(right.createdAt) || 0));
  const index = sorted.findIndex((item) => alertId(item) === alertId(alert));
  if (index <= 0) return null;
  const currentCreated = toMs(sorted[index].createdAt);
  for (let previousIndex = index - 1; previousIndex >= 0; previousIndex -= 1) {
    const previous = sorted[previousIndex];
    const previousCreated = toMs(previous.createdAt);
    if (currentCreated === null || previousCreated === null) continue;
    if (currentCreated - previousCreated > config.duplicateWindowMinutes * 60 * 1000) break;
    const previousClosed = toMs(previous.closeTime || previous.closedAt || previous.resolvedAt);
    if (previousClosed === null || previousClosed >= currentCreated) {
      return { duplicateOf: alertId(previous), alertNumber: alertNumber(previous), windowMinutes: config.duplicateWindowMinutes };
    }
  }
  return null;
}

function lifecycleSignal(alert) {
  const lifecycle = alert?.actionabilityLifecycle || {};
  return {
    acknowledged: alert?.acknowledged === true || lifecycle.humanAcknowledgement === true,
    closedBySystem: lifecycle.closedBySystem === true,
    coverage: lifecycle.observed === true ? 'COMPLETE' : 'PARTIAL',
    cycles: Number(lifecycle.cycles || 0),
    humanAction: lifecycle.humanAction === true,
    observed: lifecycle.observed === true,
    verifiedClosedCycle: lifecycle.verifiedClosedCycle === true,
  };
}

function slackSignal(source, alert, window, singleOccurrence) {
  if (!source) return { concreteAction: false, evidence: [], operatorActivity: false };
  const evidence = relevantEvidence(source, alert, window, singleOccurrence);
  const combined = canonical(evidence.map((item) => `${item.title} ${item.summary}`).join(' '));
  return {
    concreteAction: /restarted|rolled back|rollback|configuration updated|restored|fixed|cleared queue|incident opened|service restored|db team engaged|escalated/.test(combined),
    evidence,
    operatorActivity: /investigat|working with|working on|acknowledg|escalat|restart|rollback|restored|fixed/.test(combined),
  };
}

function jiraSignal(source, alert, window, singleOccurrence) {
  if (!source) return { confirmedIncident: false, confirmedProblem: false, evidence: [] };
  const evidence = relevantEvidence(source, alert, window, singleOccurrence).filter((item) => item.metadata?.relationship === 'confirmed');
  const types = canonical(evidence.map((item) => item.metadata?.issueType).join(' '));
  return {
    confirmedIncident: evidence.length > 0 && !types.includes('problem'),
    confirmedProblem: evidence.length > 0 && types.includes('problem'),
    evidence,
  };
}

function coverageRecord(inspected, total = 1, status) {
  const safeTotal = Math.max(0, total);
  const safeInspected = Math.max(0, Math.min(safeTotal, inspected));
  return {
    inspected: safeInspected,
    percentage: safeTotal ? Number((safeInspected / safeTotal * 100).toFixed(1)) : 100,
    status: status || (safeInspected >= safeTotal ? 'COMPLETE' : safeInspected ? 'PARTIAL' : 'UNAVAILABLE'),
    total: safeTotal,
  };
}

function deriveEvidenceSignals({ alert, group, sourceValidation, config = NOISE_ACTIONABILITY_CONFIG }) {
  const window = occurrenceWindow(alert, sourceValidation, config);
  const sources = sourceValidation?.sourceValidation?.sources || [];
  const singleOccurrence = Number(sourceValidation?.scope?.occurrencesInspected || 0) === 1;
  const monitoring = sources.filter((source) => MONITORING_SOURCES.has(source.source)).map((source) => sourceSignal(source, alert, window, singleOccurrence, config));
  const jiraSource = sources.find((source) => source.source === 'ACC Jira');
  const slackSource = sources.find((source) => source.source === 'Slack');
  const jira = jiraSignal(jiraSource, alert, window, singleOccurrence);
  const slack = slackSignal(slackSource, alert, window, singleOccurrence);
  const lifecycle = lifecycleSignal(alert);
  const duplicate = duplicateSignal(group, alert, config);
  const labels = labelsFor(group);
  const identityMappings = sourceValidation?.sourceIdentity?.mappings || {};
  const monitoringMappings = ['appDynamics', 'grafana', 'thousandEyes', 'nagios'].flatMap((key) => identityMappings[key] || []);
  const acceptedIdentity = monitoringMappings.some((mapping) => ACCEPTED_MAPPINGS.has(mapping.level) && mapping.rejected !== true);
  const candidateIdentity = monitoringMappings.some((mapping) => mapping.level === 'CANDIDATE' && mapping.rejected !== true);
  const sourceEvidenceCount = monitoring.reduce((count, item) => count + item.evidence.length, 0);
  const sourceFailure = sources.some((source) => /error|timeout|unavailable/i.test(String(source?.sourceStatus || '')));
  const jiraInspected = jiraSource && jiraSource.coverage !== 'UNAVAILABLE' ? 1 : 0;
  const slackInspected = slackSource && slackSource.coverage !== 'UNAVAILABLE' ? 1 : 0;
  return {
    coverage: {
      crossSource: coverageRecord(sourceEvidenceCount ? 1 : 0, 1, sourceEvidenceCount ? 'COMPLETE' : sourceValidation ? 'PARTIAL' : 'UNAVAILABLE'),
      jira: coverageRecord(jiraInspected, 1, jiraSource?.coverage || (sourceValidation ? 'PARTIAL' : 'UNAVAILABLE')),
      operations: coverageRecord(1, 1, 'COMPLETE'),
      slack: coverageRecord(slackInspected, 1, slackSource?.coverage || (sourceValidation ? 'PARTIAL' : 'UNAVAILABLE')),
      sourceTelemetry: coverageRecord(sourceEvidenceCount ? 1 : 0, 1, sourceEvidenceCount ? 'COMPLETE' : sourceValidation ? 'PARTIAL' : 'UNAVAILABLE'),
    },
    duplicate,
    identity: {
      accepted: acceptedIdentity,
      candidateOnly: candidateIdentity && !acceptedIdentity,
      conflicts: sourceValidation?.sourceIdentity?.mappingConflict === true,
      unavailable: sourceValidation?.sourceIdentity?.unavailable === true,
    },
    jira,
    labels,
    lifecycle,
    monitoring,
    slack,
    evidenceState: !sourceValidation ? 'NOT_ENRICHED' : sourceFailure || sourceValidation?.execution?.evidenceTimedOut ? 'EVIDENCE_UNAVAILABLE' : 'ENRICHED',
    sourceValidationAvailable: Boolean(sourceValidation),
    window,
  };
}

function makeDecision(classification, confidence, reasons, evidence, notificationAssessment, operationalEvent) {
  return {
    classification,
    confidence,
    evidence,
    notificationAssessment,
    operationalEvent,
    reasons: unique(reasons),
  };
}

function evidenceReference(source, item, index) {
  const id = cleanText(item?.id || item?.eventId || item?.issueKey || item?.correlationKey || item?.timestamp || index);
  return id ? `${source}:${id}` : null;
}

function withClassificationProvenance(result, { alert, classifiedAt, classificationSource, config, signals }) {
  const sourceEvidenceIds = unique([
    ...signals.monitoring.flatMap((source) => source.evidence.map((item, index) => evidenceReference(source.source, item, index))),
    ...signals.jira.evidence.map((item, index) => evidenceReference('ACC Jira', item, index)),
    ...signals.slack.evidence.map((item, index) => evidenceReference('Slack', item, index)),
  ]);
  const operationsEvidence = Boolean(signals.duplicate || signals.lifecycle.humanAction || signals.lifecycle.verifiedClosedCycle || signals.lifecycle.closedBySystem);
  let evidenceBasis = 'NEEDS_REVIEW';
  if (result.classification !== 'NEEDS_REVIEW') {
    if (sourceEvidenceIds.length && operationsEvidence) evidenceBasis = 'MIXED_EVIDENCE';
    else if (sourceEvidenceIds.length) evidenceBasis = 'SOURCE_ENRICHED';
    else evidenceBasis = 'OPERATIONS_EVIDENCE';
  }
  const canonicalOperationsId = alertId(alert);
  const derivedSource = classificationSource
    || (sourceEvidenceIds.length ? 'PHASE_3_EVIDENCE' : result.classification === 'NEEDS_REVIEW' ? 'PHASE_3_EVIDENCE' : 'OPERATIONS_LIFECYCLE');
  return {
    ...result,
    classificationSource: derivedSource,
    classificationVersion: config.actionabilityModelVersion,
    classifiedAt: classifiedAt || new Date().toISOString(),
    evidenceBasis,
    evidenceBasisLabel: {
      MIXED_EVIDENCE: 'Mixed evidence',
      NEEDS_REVIEW: 'Needs review',
      OPERATIONS_EVIDENCE: 'Operations evidence',
      SOURCE_ENRICHED: 'Source enriched',
    }[evidenceBasis],
    evidenceState: signals.evidenceState,
    evidenceIds: unique([canonicalOperationsId ? `JSM Operations:${canonicalOperationsId}` : null, ...sourceEvidenceIds]),
    classificationReasons: [...result.reasons],
  };
}

function classifyOccurrence({ alert, group = {}, sourceValidation = null, config = NOISE_ACTIONABILITY_CONFIG, classificationSource = null, classifiedAt = null }) {
  const signals = deriveEvidenceSignals({ alert, group, sourceValidation, config });
  const actionableReasons = [];
  const nonActionableReasons = [];
  const actionableSources = signals.monitoring.filter((item) => item.actionable);
  const recoverySources = signals.monitoring.filter((item) => item.nonActionable);
  if (signals.jira.confirmedIncident) actionableReasons.push('A confirmed ACC Jira Incident relationship supports meaningful operational attention.');
  if (signals.jira.confirmedProblem) actionableReasons.push('A confirmed ACC Jira Problem relationship supports operational significance.');
  actionableReasons.push(...actionableSources.map((item) => item.reason));
  if (actionableSources.length >= 2) actionableReasons.push(`${actionableSources.length} independent monitoring sources corroborate the same bounded operational condition.`);
  if (signals.lifecycle.humanAction) actionableReasons.push('Operations lifecycle evidence records a meaningful human action beyond acknowledgement.');
  if (signals.slack.concreteAction) actionableReasons.push('Exact-alert Slack context records a concrete remediation or escalation action.');

  if (signals.duplicate) nonActionableReasons.push(`This is a duplicate notification of Alert #${signals.duplicate.alertNumber || 'an already active condition'} inside the ${signals.duplicate.windowMinutes}-minute deduplication window.`);
  nonActionableReasons.push(...recoverySources.map((item) => item.reason));
  const duration = alertDurationMs(alert);
  const transient = Number.isFinite(duration) && duration <= config.transientRecoveryMinutes * 60 * 1000;
  if (signals.labels.has('auto_resolved') && signals.lifecycle.closedBySystem && !signals.lifecycle.humanAction && transient) {
    nonActionableReasons.push('Verified system closure occurred quickly without a human intervention.');
  }
  if ((signals.labels.has('flapping') || signals.labels.has('flapping_like')) && signals.lifecycle.verifiedClosedCycle && signals.lifecycle.closedBySystem && !signals.lifecycle.humanAction && transient) {
    nonActionableReasons.push('A repeated flapping lifecycle notification closed quickly without a distinct human action.');
  }

  const strongActionable = actionableReasons.length > 0;
  if (strongActionable) {
    const authoritative = signals.jira.confirmedIncident || signals.jira.confirmedProblem || actionableSources.length >= 2
      || actionableSources.some((item) => item.source === 'ThousandEyes' && item.agentCount >= 2)
      || actionableSources.some((item) => item.source === 'Nagios');
    const notificationAssessment = signals.duplicate ? 'POTENTIALLY_NON_ACTIONABLE' : 'ACTIONABLE';
    return withClassificationProvenance({
      alertNumber: alertNumber(alert) || null,
      canonicalOperationsId: alertId(alert),
      coverage: signals.coverage,
      humanHandling: { acknowledged: signals.lifecycle.acknowledged, operatorActionObserved: signals.lifecycle.humanAction || signals.slack.concreteAction },
      ...makeDecision('ACTIONABLE', authoritative ? 'HIGH' : 'MEDIUM', actionableReasons, signals, notificationAssessment, 'ACTIONABLE'),
    }, { alert, classifiedAt, classificationSource, config, signals });
  }

  const conflictingEvidence = actionableSources.length > 0 && recoverySources.length > 0;
  if (conflictingEvidence || signals.identity.conflicts) {
    const reasons = [];
    if (conflictingEvidence) reasons.push('Mapped monitoring evidence contains both degradation and recovery/healthy signals.');
    if (signals.identity.conflicts) reasons.push('Source identity mappings contain an unresolved environment or entity conflict.');
    return withClassificationProvenance({
      alertNumber: alertNumber(alert) || null,
      canonicalOperationsId: alertId(alert),
      coverage: signals.coverage,
      humanHandling: { acknowledged: signals.lifecycle.acknowledged, operatorActionObserved: false },
      ...makeDecision('NEEDS_REVIEW', 'MEDIUM', reasons, signals, signals.duplicate ? 'POTENTIALLY_NON_ACTIONABLE' : 'NEEDS_REVIEW', 'NEEDS_REVIEW'),
    }, { alert, classifiedAt, classificationSource, config, signals });
  }

  if (nonActionableReasons.length) {
    const highConfidence = Boolean(signals.duplicate || recoverySources.length || (signals.labels.has('auto_resolved') && signals.lifecycle.observed));
    return withClassificationProvenance({
      alertNumber: alertNumber(alert) || null,
      canonicalOperationsId: alertId(alert),
      coverage: signals.coverage,
      humanHandling: { acknowledged: signals.lifecycle.acknowledged, operatorActionObserved: false },
      ...makeDecision('NON_ACTIONABLE', highConfidence ? 'HIGH' : 'MEDIUM', nonActionableReasons, signals, 'NON_ACTIONABLE', recoverySources.length ? 'NON_ACTIONABLE' : 'NEEDS_REVIEW'),
    }, { alert, classifiedAt, classificationSource, config, signals });
  }

  const reviewReasons = [];
  if (signals.identity.candidateOnly) reviewReasons.push('Source identity is Candidate-only and cannot prove actionability.');
  if (signals.identity.unavailable) reviewReasons.push('Source identity resolution was unavailable.');
  if (!signals.sourceValidationAvailable) reviewReasons.push('Direct source telemetry has not been investigated for this occurrence.');
  else if (!signals.monitoring.some((item) => item.evidence.length)) reviewReasons.push('No structured monitoring telemetry was returned in the bounded occurrence window.');
  if (!signals.jira.evidence.length) reviewReasons.push('No confirmed Jira Incident or Problem relationship was found; absence alone is not treated as non-actionable.');
  if (signals.slack.operatorActivity && !signals.slack.concreteAction) reviewReasons.push('Slack contains handling discussion but no concrete remediation evidence.');
  if (!isClosed(alert)) reviewReasons.push('The alert remains active without enough evidence for a safe actionability conclusion.');
  if (signals.lifecycle.acknowledged && !signals.lifecycle.humanAction) reviewReasons.push('Acknowledgement is tracked as human handling, not proof of actionability.');
  if (!reviewReasons.length) reviewReasons.push('Available metadata and lifecycle evidence are insufficient for a safe actionability conclusion.');
  return withClassificationProvenance({
    alertNumber: alertNumber(alert) || null,
    canonicalOperationsId: alertId(alert),
    coverage: signals.coverage,
    humanHandling: { acknowledged: signals.lifecycle.acknowledged, operatorActionObserved: false },
    ...makeDecision('NEEDS_REVIEW', signals.sourceValidationAvailable ? 'MEDIUM' : 'LOW', reviewReasons, signals, 'NEEDS_REVIEW', 'NEEDS_REVIEW'),
  }, { alert, classifiedAt, classificationSource, config, signals });
}

function distributionFor(occurrences) {
  const count = (state) => occurrences.filter((item) => item.classification === state).length;
  const total = occurrences.length;
  const actionable = count('ACTIONABLE');
  const nonActionable = count('NON_ACTIONABLE');
  const needsReview = count('NEEDS_REVIEW');
  return {
    actionable,
    needsReview,
    nonActionable,
    percentages: {
      actionable: total ? Number((actionable / total * 100).toFixed(1)) : 0,
      needsReview: total ? Number((needsReview / total * 100).toFixed(1)) : 0,
      nonActionable: total ? Number((nonActionable / total * 100).toFixed(1)) : 0,
    },
    total,
  };
}

function dominantClassification(distribution, config = NOISE_ACTIONABILITY_CONFIG) {
  if (!distribution.total || distribution.needsReview / distribution.total >= config.dominantThreshold) return 'INSUFFICIENT_EVIDENCE';
  if (distribution.actionable / distribution.total >= config.dominantThreshold) return 'MOSTLY_ACTIONABLE';
  if (distribution.nonActionable / distribution.total >= config.dominantThreshold) return 'MOSTLY_NON_ACTIONABLE';
  return 'MIXED';
}

function aggregateCoverage(occurrences, key) {
  const records = occurrences.map((item) => item.coverage[key]);
  const inspected = records.filter((item) => item?.inspected > 0).length;
  const total = records.length;
  return coverageRecord(inspected, total, inspected === total ? 'COMPLETE' : inspected ? 'PARTIAL' : 'UNAVAILABLE');
}

function aggregateReasons(occurrences) {
  const counts = new Map();
  occurrences.flatMap((item) => item.reasons).forEach((reason) => counts.set(reason, (counts.get(reason) || 0) + 1));
  return [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])).slice(0, 8).map(([reason, occurrencesCount]) => ({ occurrences: occurrencesCount, reason }));
}

function aggregateEvidenceBasis(occurrences) {
  const counts = {
    mixedEvidence: occurrences.filter((item) => item.evidenceBasis === 'MIXED_EVIDENCE').length,
    needsReview: occurrences.filter((item) => item.evidenceBasis === 'NEEDS_REVIEW').length,
    operationsEvidence: occurrences.filter((item) => item.evidenceBasis === 'OPERATIONS_EVIDENCE').length,
    sourceEnriched: occurrences.filter((item) => item.evidenceBasis === 'SOURCE_ENRICHED').length,
  };
  let code = 'NEEDS_REVIEW';
  if (counts.mixedEvidence || ((counts.sourceEnriched > 0) && counts.operationsEvidence > 0)) code = 'MIXED_EVIDENCE';
  else if (counts.sourceEnriched > 0) code = 'SOURCE_ENRICHED';
  else if (counts.operationsEvidence > 0) code = 'OPERATIONS_EVIDENCE';
  return {
    ...counts,
    code,
    label: {
      MIXED_EVIDENCE: 'Mixed evidence',
      NEEDS_REVIEW: 'Needs review',
      OPERATIONS_EVIDENCE: 'Operations evidence',
      SOURCE_ENRICHED: 'Source enriched',
    }[code],
    total: occurrences.length,
  };
}

function summarizePattern(group, occurrences, options = {}) {
  const config = options.config || NOISE_ACTIONABILITY_CONFIG;
  const distribution = distributionFor(occurrences);
  const classification = dominantClassification(distribution, config);
  const classifiedForDominant = classification === 'MOSTLY_ACTIONABLE'
    ? occurrences.filter((item) => item.classification === 'ACTIONABLE')
    : classification === 'MOSTLY_NON_ACTIONABLE'
      ? occurrences.filter((item) => item.classification === 'NON_ACTIONABLE')
      : occurrences;
  const highConfidence = classifiedForDominant.filter((item) => item.confidence === 'HIGH').length;
  const confidence = classification === 'INSUFFICIENT_EVIDENCE' ? 'LOW'
    : classifiedForDominant.length && highConfidence / classifiedForDominant.length >= config.dominantThreshold ? 'HIGH'
      : classifiedForDominant.some((item) => item.confidence !== 'LOW') ? 'MEDIUM' : 'LOW';
  const highNoise = Number(group?.noiseLikelihood ?? group?.noiseScore ?? 0) >= config.highNoiseThreshold;
  const highConfidenceNonActionable = occurrences.filter((item) => item.classification === 'NON_ACTIONABLE' && item.confidence === 'HIGH').length;
  const highConfidenceActionable = occurrences.filter((item) => item.classification === 'ACTIONABLE' && item.confidence === 'HIGH').length;
  const potentiallyReducible = reviewRiskLevel(group) !== 'CRITICAL' && highNoise ? highConfidenceNonActionable : 0;
  return {
    actionabilityModelVersion: config.actionabilityModelVersion,
    classification,
    confidence,
    coverage: {
      crossSource: aggregateCoverage(occurrences, 'crossSource'),
      jira: aggregateCoverage(occurrences, 'jira'),
      operations: aggregateCoverage(occurrences, 'operations'),
      slack: aggregateCoverage(occurrences, 'slack'),
      sourceTelemetry: aggregateCoverage(occurrences, 'sourceTelemetry'),
    },
    distribution,
    evidenceBasis: aggregateEvidenceBasis(occurrences),
    humanHandling: {
      acknowledged: occurrences.filter((item) => item.humanHandling.acknowledged).length,
      operatorActionObserved: occurrences.filter((item) => item.humanHandling.operatorActionObserved).length,
      toilLevel: group?.humanToil?.level || null,
    },
    intersections: {
      actionableButNoisy: highNoise ? distribution.actionable : 0,
      highConfidenceActionable,
      highConfidenceNoiseCandidates: potentiallyReducible,
      highConfidenceNonActionable,
      highNoiseNonActionable: highNoise ? distribution.nonActionable : 0,
      potentiallyReducible,
    },
    notificationDuplication: {
      potentiallyRedundant: occurrences.filter((item) => item.notificationAssessment === 'POTENTIALLY_NON_ACTIONABLE').length,
      underlyingActionable: occurrences.filter((item) => item.operationalEvent === 'ACTIONABLE').length,
    },
    occurrences,
    reasons: aggregateReasons(occurrences),
  };
}

function classifyPattern(group, options = {}) {
  const config = options.config || NOISE_ACTIONABILITY_CONFIG;
  const occurrences = (group?.alerts || []).map((alert) => classifyOccurrence({
    alert,
    group,
    sourceValidation: options.sourceValidation,
    config,
    classifiedAt: options.classifiedAt,
    classificationSource: options.classificationSource,
  }));
  return summarizePattern(group, occurrences, { config });
}

function applyOccurrenceOverrides(group, actionability, overrides, config = NOISE_ACTIONABILITY_CONFIG) {
  if (!(overrides instanceof Map) || !overrides.size) return actionability;
  let applied = 0;
  const sources = new Set();
  const states = new Set();
  const occurrences = actionability.occurrences.map((occurrence) => {
    const override = overrides.get(occurrence.canonicalOperationsId);
    if (!override) return occurrence;
    applied += 1;
    states.add(override.enrichment?.evidenceStatus || 'ENRICHED');
    (override.enrichment?.sources || []).forEach((source) => sources.add(source));
    return override;
  });
  if (!applied) return actionability;
  const summarized = summarizePattern(group, occurrences, { config });
  return {
    ...summarized,
    enrichment: {
      enriched: applied,
      evidenceUnavailable: occurrences.filter((item) => item.enrichment?.evidenceStatus === 'EVIDENCE_UNAVAILABLE').length,
      notEnriched: occurrences.filter((item) => !item.enrichment).length,
      reclassifiedActionable: occurrences.filter((item) => item.enrichment?.reclassified && item.classification === 'ACTIONABLE').length,
      reclassifiedNonActionable: occurrences.filter((item) => item.enrichment?.reclassified && item.classification === 'NON_ACTIONABLE').length,
      sources: [...sources].sort(),
      states: [...states].sort(),
    },
  };
}

function publicPatternActionability(value) {
  return {
    actionabilityModelVersion: value.actionabilityModelVersion,
    classification: value.classification,
    confidence: value.confidence,
    coverage: value.coverage,
    distribution: value.distribution,
    evidenceBasis: value.evidenceBasis,
    humanHandling: value.humanHandling,
    intersections: value.intersections,
    enrichment: value.enrichment || { enriched: 0, evidenceUnavailable: 0, notEnriched: value.distribution.total, reclassifiedActionable: 0, reclassifiedNonActionable: 0, sources: [], states: [] },
    notificationDuplication: value.notificationDuplication,
    reasons: value.reasons,
  };
}

function normalizeListOptions(options = {}) {
  const range = ['24h', '7d', '30d', '90d'].includes(options.range) ? options.range : '7d';
  const actionabilityValue = String(options.actionability || (ACTIONABILITY_STATES.includes(String(options.classification || '').toUpperCase()) ? options.classification : 'all')).toUpperCase();
  const actionability = actionabilityValue === 'ALL' ? 'all' : actionabilityValue;
  if (actionability !== 'all' && !ACTIONABILITY_STATES.includes(actionability)) throw safeError('Unsupported actionability classification.', 'INVALID_ACTIONABILITY_CLASSIFICATION');
  const confidence = String(options.confidence || 'all').toUpperCase();
  if (confidence !== 'ALL' && !CONFIDENCE_LEVELS.includes(confidence)) throw safeError('Unsupported actionability confidence.', 'INVALID_ACTIONABILITY_CONFIDENCE');
  const page = Number.parseInt(options.page || '1', 10);
  const size = Number.parseInt(options.size || '25', 10);
  if (!Number.isSafeInteger(page) || page < 1) throw safeError('page must be a positive integer.', 'INVALID_ACTIONABILITY_PAGE');
  if (![25, 50, 100].includes(size)) throw safeError('size must be 25, 50, or 100.', 'INVALID_ACTIONABILITY_PAGE_SIZE');
  const minNoiseScore = Number(options.minNoiseScore || 0);
  if (!Number.isFinite(minNoiseScore) || minNoiseScore < 0 || minNoiseScore > 100) throw safeError('minNoiseScore must be between 0 and 100.', 'INVALID_ACTIONABILITY_NOISE_SCORE');
  const evidenceState = String(options.evidenceState || 'all').toUpperCase();
  if (!['ALL', 'ENRICHED', 'NOT_ENRICHED', 'EVIDENCE_UNAVAILABLE'].includes(evidenceState)) throw safeError('Unsupported evidence state.', 'INVALID_EVIDENCE_STATE');
  return {
    actionability,
    confidence,
    environment: canonical(options.environment),
    evidenceSource: canonical(options.evidenceSource),
    evidenceState,
    minNoiseScore,
    noiseClassification: canonical(options.noiseClassification || (!ACTIONABILITY_STATES.includes(String(options.classification || '').toUpperCase()) ? options.classification : 'all')) || 'all',
    page,
    pattern: canonical(options.pattern),
    priority: canonical(options.priority),
    range,
    refresh: String(options.refresh || '').toLowerCase() === 'true',
    size,
    source: canonical(options.source),
  };
}

function chooseGlobalOccurrence(candidates) {
  const rank = { ACTIONABLE: 3, NON_ACTIONABLE: 2, NEEDS_REVIEW: 1 };
  return [...candidates].sort((left, right) => rank[right.classification] - rank[left.classification] || CONFIDENCE_LEVELS.indexOf(left.confidence) - CONFIDENCE_LEVELS.indexOf(right.confidence))[0];
}

function overviewSummary(occurrences, patterns) {
  const distribution = distributionFor(occurrences);
  const evidenceEnriched = occurrences.filter((item) => item.evidenceState === 'ENRICHED').length;
  const evidenceUnavailable = occurrences.filter((item) => item.evidenceState === 'EVIDENCE_UNAVAILABLE').length;
  const operationsOnly = occurrences.filter((item) => item.evidenceBasis === 'OPERATIONS_EVIDENCE').length;
  const highConfidenceNonActionableItems = occurrences.filter((item) => item.classification === 'NON_ACTIONABLE' && item.confidence === 'HIGH');
  const highNoiseActionableItems = occurrences.filter((item) => item.classification === 'ACTIONABLE' && item.intersection?.highNoise);
  const nonActionableAudit = highConfidenceNonActionableItems.reduce((audit, item) => {
    if (['SOURCE_ENRICHED', 'MIXED_EVIDENCE'].includes(item.evidenceBasis)) audit.sourceEvidence += 1;
    else if (item.evidence?.duplicate) audit.deterministicDuplicate += 1;
    else if (item.evidence?.lifecycle?.verifiedClosedCycle && item.evidence?.lifecycle?.closedBySystem) audit.verifiedSystemLifecycle += 1;
    else audit.unexplained += 1;
    return audit;
  }, { deterministicDuplicate: 0, sourceEvidence: 0, unexplained: 0, verifiedSystemLifecycle: 0 });
  const sourceClaimPattern = /AppDynamics returned|Grafana telemetry|ThousandEyes returned|Nagios returned/i;
  return {
    ...distribution,
    actionabilityReconciliation: distribution.actionable + distribution.nonActionable + distribution.needsReview === distribution.total,
    actionableButNoisy: occurrences.filter((item) => item.classification === 'ACTIONABLE' && item.intersection?.highNoise).length,
    highConfidenceActionable: occurrences.filter((item) => item.classification === 'ACTIONABLE' && item.confidence === 'HIGH').length,
    highConfidenceNonActionable: occurrences.filter((item) => item.classification === 'NON_ACTIONABLE' && item.confidence === 'HIGH').length,
    highConfidenceNoiseCandidates: occurrences.filter((item) => item.intersection?.highConfidenceNoiseCandidate).length,
    highNoiseNonActionable: occurrences.filter((item) => item.classification === 'NON_ACTIONABLE' && item.intersection?.highNoise).length,
    mixedPatterns: patterns.filter((item) => item.actionability.classification === 'MIXED').length,
    potentiallyReducible: occurrences.filter((item) => item.intersection?.potentiallyReducible).length,
    evidenceReconciliation: {
      actionable: {
        evidenceEnriched: occurrences.filter((item) => item.classification === 'ACTIONABLE' && ['SOURCE_ENRICHED', 'MIXED_EVIDENCE'].includes(item.evidenceBasis)).length,
        operationsOnly: occurrences.filter((item) => item.classification === 'ACTIONABLE' && item.evidenceBasis === 'OPERATIONS_EVIDENCE').length,
      },
      evidenceEnriched,
      evidenceUnavailable,
      nonActionable: {
        evidenceEnriched: occurrences.filter((item) => item.classification === 'NON_ACTIONABLE' && ['SOURCE_ENRICHED', 'MIXED_EVIDENCE'].includes(item.evidenceBasis)).length,
        existingPhase3: occurrences.filter((item) => item.classification === 'NON_ACTIONABLE' && item.evidenceBasis === 'OPERATIONS_EVIDENCE').length,
      },
      notEnriched: occurrences.filter((item) => item.evidenceState === 'NOT_ENRICHED').length,
      operationsOnly,
      reconciles: evidenceEnriched + evidenceUnavailable + occurrences.filter((item) => item.evidenceState === 'NOT_ENRICHED').length === distribution.total,
    },
    classificationAudit: {
      acknowledgementOnlyActionable: occurrences.filter((item) => item.classification === 'ACTIONABLE'
        && item.evidence?.lifecycle?.acknowledged
        && !item.evidence?.lifecycle?.humanAction
        && !item.evidence?.slack?.concreteAction
        && !item.evidence?.jira?.confirmedIncident
        && !item.evidence?.jira?.confirmedProblem
        && !item.evidence?.monitoring?.some((source) => source.actionable)).length,
      highConfidenceNonActionable: {
        ...nonActionableAudit,
        evidenceBacked: highConfidenceNonActionableItems.length - nonActionableAudit.unexplained,
        reconciles: Object.values(nonActionableAudit).reduce((sum, value) => sum + value, 0) === highConfidenceNonActionableItems.length,
        total: highConfidenceNonActionableItems.length,
      },
      highNoiseActionable: {
        mixedEvidence: highNoiseActionableItems.filter((item) => item.evidenceBasis === 'MIXED_EVIDENCE').length,
        operationsEvidence: highNoiseActionableItems.filter((item) => item.evidenceBasis === 'OPERATIONS_EVIDENCE').length,
        sourceEnriched: highNoiseActionableItems.filter((item) => item.evidenceBasis === 'SOURCE_ENRICHED').length,
        total: highNoiseActionableItems.length,
      },
      notEnrichedSourceClaims: occurrences.filter((item) => item.evidenceState === 'NOT_ENRICHED' && item.reasons.some((reason) => sourceClaimPattern.test(reason))).length,
    },
  };
}

function createNoiseActionabilityService({
  config = NOISE_ACTIONABILITY_CONFIG,
  phase1Service = noiseAnalysisService,
  validationService = sourceValidationService,
  now = () => Date.now(),
} = {}) {
  const overviewCache = new Map();
  const detailCache = new Map();

  function overviewCacheKey(range, analysisVersion) {
    return `${config.actionabilityModelVersion}:${config.sourceValidationVersion}:${analysisVersion}:${range}`;
  }

  async function buildOverview(range, refresh = false) {
    const analysis = await phase1Service.analyzeRange(range, refresh);
    const key = overviewCacheKey(range, analysis.analysisVersion);
    const cached = overviewCache.get(key);
    if (!refresh && cached && now() - cached.cachedAtMs < config.cacheTtlMs) return { ...cached, cacheHit: true };
    const startedAt = now();
    const classifiedAt = new Date(now()).toISOString();
    const patternResults = analysis.groups.map((group) => ({ group, actionability: classifyPattern(group, { classifiedAt, config }) }));
    const byAlert = new Map();
    patternResults.forEach(({ group, actionability }) => {
      actionability.occurrences.forEach((occurrence) => {
        const items = byAlert.get(occurrence.canonicalOperationsId) || [];
        const highNoise = Number(group.noiseLikelihood ?? group.noiseScore ?? 0) >= config.highNoiseThreshold;
        const allowedRisk = reviewRiskLevel(group) !== 'CRITICAL';
        items.push({
          ...occurrence,
          intersection: {
            highConfidenceNoiseCandidate: occurrence.classification === 'NON_ACTIONABLE' && occurrence.confidence === 'HIGH' && highNoise && allowedRisk,
            highNoise,
            potentiallyReducible: occurrence.classification === 'NON_ACTIONABLE' && occurrence.confidence === 'HIGH' && highNoise && allowedRisk,
          },
        });
        byAlert.set(occurrence.canonicalOperationsId, items);
      });
    });
    const allAlerts = analysis._normalizedAlerts || [];
    const occurrences = allAlerts.map((alert) => {
      const candidates = byAlert.get(alertId(alert)) || [classifyOccurrence({ alert, classifiedAt, group: {}, config })];
      return chooseGlobalOccurrence(candidates);
    });
    const summary = overviewSummary(occurrences, patternResults);
    const built = {
      analysis,
      cachedAt: new Date(now()).toISOString(),
      cachedAtMs: now(),
      cacheHit: false,
      executionTimeMs: Math.max(0, now() - startedAt),
      occurrences,
      patternResults,
      summary,
    };
    overviewCache.set(key, built);
    return built;
  }

  async function list(options = {}) {
    const parsed = normalizeListOptions(options);
    if (parsed.refresh) {
      overviewCache.clear();
      detailCache.clear();
    }
    const built = await buildOverview(parsed.range, parsed.refresh);
    const overrides = options.enrichmentOverrides instanceof Map ? options.enrichmentOverrides : new Map();
    const enrichedPatternResults = built.patternResults.map(({ group, actionability }) => ({ group, actionability: applyOccurrenceOverrides(group, actionability, overrides, config) }));
    const enrichedOccurrences = built.occurrences.map((occurrence) => overrides.get(occurrence.canonicalOperationsId) || occurrence);
    const enrichedSummary = overviewSummary(enrichedOccurrences, enrichedPatternResults);
    const patterns = enrichedPatternResults.map(({ group, actionability }) => ({
      ...group,
      // Phase 1 may preserve a vendor-provided occurrenceCount on one
      // Operations record. Actionability is occurrence-level over canonical
      // Operations alerts, so expose that authoritative total in this view and
      // retain the Phase 1 number explicitly for diagnostic context.
      sourceOccurrenceCount: group.occurrences,
      occurrences: actionability.distribution.total,
      actionability: publicPatternActionability(actionability),
    }));
    const filtered = patterns.filter((group) => {
      const actionability = group.actionability;
      const labels = group.labels || [group.classification];
      return (!parsed.pattern || canonical(group.pattern).includes(parsed.pattern))
        && (!parsed.source || (group.sources || []).some((source) => canonical(source) === parsed.source))
        && (!parsed.priority || canonical(group.priority) === parsed.priority)
        && (!parsed.environment || (group.alerts || []).some((alert) => canonical(alert.environment) === parsed.environment))
        && (parsed.noiseClassification === 'all' || group.classification === parsed.noiseClassification || labels.includes(parsed.noiseClassification))
        && group.noiseLikelihood >= parsed.minNoiseScore
        && (parsed.evidenceState === 'ALL'
          || (parsed.evidenceState === 'ENRICHED' && actionability.enrichment.enriched > 0)
          || (parsed.evidenceState === 'NOT_ENRICHED' && actionability.enrichment.notEnriched > 0)
          || (parsed.evidenceState === 'EVIDENCE_UNAVAILABLE' && actionability.enrichment.evidenceUnavailable > 0))
        && (!parsed.evidenceSource || actionability.enrichment.sources.some((source) => canonical(source) === parsed.evidenceSource))
        && (parsed.actionability === 'all' || actionability.distribution[parsed.actionability === 'NON_ACTIONABLE' ? 'nonActionable' : parsed.actionability === 'NEEDS_REVIEW' ? 'needsReview' : 'actionable'] > 0)
        && (parsed.confidence === 'ALL' || actionability.confidence === parsed.confidence);
    });
    const totalPages = Math.max(1, Math.ceil(filtered.length / parsed.size));
    const page = Math.min(parsed.page, totalPages);
    const start = (page - 1) * parsed.size;
    return {
      ...built.analysis,
      _normalizedAlerts: undefined,
      actionabilityModelVersion: config.actionabilityModelVersion,
      actionabilityOverview: enrichedSummary,
      actionabilityPerformance: { cacheHit: built.cacheHit, cacheTtlMs: config.cacheTtlMs, executionTimeMs: built.executionTimeMs },
      cachedAt: built.cachedAt,
      cachedAtMs: undefined,
      filterOptions: {
        actionability: ACTIONABILITY_STATES,
        actionabilityConfidence: CONFIDENCE_LEVELS,
        evidenceStates: ['ENRICHED', 'NOT_ENRICHED', 'EVIDENCE_UNAVAILABLE'],
        evidenceSources: ['AppDynamics', 'Grafana', 'ThousandEyes', 'Nagios', 'Jira', 'Slack'],
        environments: [...new Set(built.analysis.groups.flatMap((group) => group.alerts.map((alert) => alert.environment).filter(Boolean)))].sort(),
        priorities: [...new Set(built.analysis.groups.map((group) => group.priority).filter(Boolean))].sort(),
        sources: [...new Set(built.analysis.groups.flatMap((group) => group.sources))].sort(),
      },
      groups: filtered.slice(start, start + parsed.size),
      pagination: { page, size: parsed.size, total: filtered.length, totalPages },
      readOnly: true,
      scoresChanged: false,
      externalMutations: 'none',
      aiUsed: false,
      automaticSuppression: 'none',
    };
  }

  async function getGroup(groupId, options = {}) {
    const id = cleanText(groupId);
    if (!/^[a-f0-9]{24}$/.test(id)) throw safeError('A valid analysis group ID is required.', 'INVALID_NOISE_GROUP_ID');
    const range = ['24h', '7d', '30d', '90d'].includes(options.range) ? options.range : '7d';
    const deep = String(options.deep || '').toLowerCase() === 'true';
    const refresh = String(options.refresh || '').toLowerCase() === 'true';
    const validationScopeKey = deep
      ? [options.scope || 'pattern', options.occurrenceId || '', options.beforeMinutes || '', options.afterMinutes || ''].join(':')
      : 'fast';
    const overrideVersion = options.enrichmentOverrides instanceof Map && options.enrichmentOverrides.size
      ? [...options.enrichmentOverrides.entries()].map(([occurrenceId, item]) => `${occurrenceId}:${item.classifiedAt || item.enrichment?.collectedAt || item.classification}`).sort().join('|')
      : 'none';
    const key = `${config.actionabilityModelVersion}:${config.sourceValidationVersion}:${range}:${id}:${validationScopeKey}:${overrideVersion}`;
    const cached = detailCache.get(key);
    const ttl = deep ? config.deepCacheTtlMs : config.cacheTtlMs;
    if (!refresh && cached && now() - cached.cachedAtMs < ttl) return { ...cached.value, cache: { ...cached.value.cache, hit: true } };
    const startedAt = now();
    const phaseOne = await phase1Service.getGroup(id, { range, refresh });
    const sourceValidation = deep ? await validationService.investigate(id, {
      afterMinutes: options.afterMinutes,
      beforeMinutes: options.beforeMinutes,
      occurrenceId: options.occurrenceId,
      range,
      refresh,
      scope: options.scope || 'pattern',
    }) : null;
    const actionability = applyOccurrenceOverrides(
      phaseOne.group,
      classifyPattern(phaseOne.group, { classifiedAt: new Date(now()).toISOString(), config, sourceValidation }),
      options.enrichmentOverrides,
      config,
    );
    const value = {
      phase: '3',
      analysisVersion: phaseOne.analysisVersion,
      groupId: id,
      range,
      actionability,
      sourceValidationApplied: deep,
      sourceValidation,
      cache: { hit: false, ttlMs: ttl, modelVersion: config.actionabilityModelVersion, sourceValidationVersion: config.sourceValidationVersion },
      executionTimeMs: Math.max(0, now() - startedAt),
      baseline: {
        noiseLikelihood: phaseOne.group.noiseLikelihood ?? phaseOne.group.noiseScore,
        reviewRisk: phaseOne.group.reviewRisk,
        correlationConfidence: phaseOne.group.correlationConfidence,
        scoresRecalculated: false,
      },
      advisoryOnly: true,
      externalMutations: 'none',
      automaticSuppression: 'none',
      aiUsed: false,
    };
    detailCache.set(key, { cachedAtMs: now(), value });
    return value;
  }

  function invalidate() {
    overviewCache.clear();
    detailCache.clear();
  }

  async function getSnapshot(options = {}) {
    const range = ['24h', '7d', '30d', '90d'].includes(options.range) ? options.range : '7d';
    const refresh = String(options.refresh || '').toLowerCase() === 'true';
    const built = await buildOverview(range, refresh);
    const overrides = options.enrichmentOverrides instanceof Map ? options.enrichmentOverrides : new Map();
    return {
      actionabilityModelVersion: config.actionabilityModelVersion,
      analysisVersion: built.analysis.analysisVersion,
      analysis: built.analysis,
      cachedAt: built.cachedAt,
      occurrences: built.occurrences.map((occurrence) => overrides.get(occurrence.canonicalOperationsId) || occurrence),
      patternResults: built.patternResults.map(({ group, actionability }) => ({
        group,
        actionability: applyOccurrenceOverrides(group, actionability, overrides, config),
      })),
      range,
    };
  }

  return { getGroup, getSnapshot, invalidate, list };
}

module.exports = {
  ACTIONABILITY_STATES,
  CONFIDENCE_LEVELS,
  classifyOccurrence,
  classifyPattern,
  applyOccurrenceOverrides,
  createNoiseActionabilityService,
  deriveEvidenceSignals,
  dominantClassification,
  summarizePattern,
  service: createNoiseActionabilityService(),
};
