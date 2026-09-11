const crypto = require('node:crypto');
const db = require('../config/db');
const { CANONICAL_ALERT_ASSESSMENT_POLICY } = require('../config/canonicalAlertAssessmentPolicy');
const { positiveEventProof, recoveryProof } = require('./operationalEvidenceModel.service');

function cleanText(value) {
  return String(value ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function canonical(value) {
  return cleanText(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function unique(values) {
  return [...new Set((values || []).filter(Boolean).map(cleanText).filter(Boolean))];
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') return Object.keys(value).sort().reduce((result, key) => {
    result[key] = stableValue(value[key]);
    return result;
  }, {});
  return value;
}

function hash(value, length = 32) {
  return crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(stableValue(value))).digest('hex').slice(0, length);
}

function toMs(value) {
  if (Number.isFinite(value)) return Number(value);
  const parsed = value ? new Date(value).getTime() : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function evidenceIds(records) {
  return unique((records || []).map((item) => item?.id));
}

function eventOccurrences(occurrence, allOccurrences) {
  return allOccurrences.filter((item) => item.event.eventId === occurrence.event.eventId);
}

function detectorResult(detected, confidence, evidence, reasoning, details = {}) {
  return { detected, confidence, evidence: unique(evidence), reasoning, ...details };
}

function detectDuplicate(occurrence) {
  const duplicate = occurrence.notificationRole.role === 'REDUNDANT'
    && occurrence.notificationRole.exactDuplicate === true
    && Boolean(occurrence.event.representativeNotification)
    && occurrence.event.representativeNotification !== occurrence.occurrenceId;
  return detectorResult(
    duplicate,
    duplicate ? 'HIGH' : 'LOW',
    duplicate ? unique([occurrence.event.eventId, ...occurrence.event.evidenceIds]) : [],
    duplicate
      ? 'The same accepted entity, condition, source-event identity, and event lifecycle are already represented by an earlier alert.'
      : 'No exact source-event duplicate with an earlier representative is proven.',
    {
      duplicateOfAlertId: duplicate ? occurrence.event.representativeNotification : null,
      underlyingEventId: duplicate ? occurrence.event.eventId : null,
      duplicateEvidence: duplicate ? unique([occurrence.event.eventId, ...occurrence.event.evidenceIds]) : [],
    },
  );
}

function detectFlapping(occurrence) {
  const detected = occurrence.event.flapping === true && Number(occurrence.event.transitionCount || 0) >= 4;
  return detectorResult(
    detected,
    detected ? 'HIGH' : 'LOW',
    detected ? unique(occurrence.event.evidenceIds) : [],
    detected
      ? `${occurrence.event.transitionCount} source-supported transitions establish flapping inside the reconstructed event window.`
      : 'No bounded source-supported firing and recovery transition sequence establishes flapping.',
    {
      transitionCount: detected ? occurrence.event.transitionCount : 0,
      stateTimeline: detected ? occurrence.event.stateTimeline || [] : [],
      observationWindow: detected ? { start: occurrence.event.start, recovery: occurrence.event.recovery } : null,
    },
  );
}

function detectAutoResolved(occurrence, allOccurrences) {
  const related = eventOccurrences(occurrence, allOccurrences);
  const fired = related.some(positiveEventProof);
  const recovered = related.some(recoveryProof) || Boolean(occurrence.event.recovery);
  const manualIntervention = related.some((item) => item.operations.humanAction === true || item.slack.concreteAction === true);
  const detected = fired && recovered && !manualIntervention;
  const sourceResolvedAt = occurrence.event.recovery || related.flatMap((item) => [...item.sourceNativeEvidence, ...item.telemetry])
    .filter((item) => item.recovered && item.timestamp).map((item) => item.timestamp).sort().at(-1) || null;
  return detectorResult(
    detected,
    detected ? 'HIGH' : 'LOW',
    detected ? unique(related.flatMap((item) => [...item.sourceNativeEvidence, ...item.telemetry]).filter((item) => item.active || item.recovered).map((item) => item.id)) : [],
    detected
      ? 'The source proves both the operational condition and recovery, with no validated manual remediation between them.'
      : 'A complete source firing-to-recovery lifecycle without meaningful manual intervention is not proven.',
    { sourceResolvedAt, manualInterventionObserved: manualIntervention },
  );
}

function detectNonActionable(occurrence) {
  const records = occurrence.nonActionableEvidence || [];
  const manualIntervention = occurrence.operations.humanAction === true || occurrence.slack.concreteAction === true;
  const detected = records.length > 0 && !manualIntervention;
  return detectorResult(
    detected,
    detected ? 'HIGH' : 'LOW',
    detected ? unique(records.flatMap((item) => item.evidenceIds || [])) : [],
    detected
      ? records.map((item) => item.reason).filter(Boolean).join(' ') || 'Positive source evidence confirms a non-actionable recovered condition.'
      : 'No positive source evidence proves that meaningful engineer intervention was unnecessary.',
  );
}

function detectCorrelated(occurrence, allOccurrences) {
  const related = eventOccurrences(occurrence, allOccurrences);
  const sources = unique(related.map((item) => item.source.name));
  const accepted = related.filter((item) => item.identity.accepted);
  const detected = sources.length > 1 && accepted.length > 1 && related.some(positiveEventProof);
  return detectorResult(
    detected,
    detected ? 'MEDIUM' : 'LOW',
    detected ? unique([occurrence.event.eventId, ...occurrence.event.evidenceIds]) : [],
    detected
      ? 'Accepted evidence from multiple monitoring sources is reconstructed into the same compatible underlying event.'
      : 'No deterministic cross-source relationship is established for this event.',
    {
      correlatedAlertIds: detected ? related.map((item) => item.occurrenceId) : [],
      correlatedSources: detected ? sources : [],
      underlyingEventId: detected ? occurrence.event.eventId : null,
      relationshipEvidence: detected ? unique(occurrence.event.evidenceIds) : [],
    },
  );
}

function detectStale(occurrence, allOccurrences, evaluatedAt, policy = CANONICAL_ALERT_ASSESSMENT_POLICY) {
  const related = eventOccurrences(occurrence, allOccurrences);
  const recoveredRecords = related.flatMap((item) => [...item.sourceNativeEvidence, ...item.telemetry])
    .filter((item) => item.recovered && item.timestamp);
  const sourceResolvedAt = occurrence.event.recovery || recoveredRecords.map((item) => item.timestamp).sort().at(-1) || null;
  const operationsStatus = cleanText(occurrence.operations.status || occurrence.alert.status).toUpperCase();
  const operationsOpen = /OPEN|ACTIVE|ACKNOWLEDGED|TRIGGERED/.test(operationsStatus);
  const staleDuration = sourceResolvedAt && toMs(evaluatedAt) !== null && toMs(sourceResolvedAt) !== null
    ? Math.max(0, toMs(evaluatedAt) - toMs(sourceResolvedAt)) : null;
  const detected = operationsOpen && staleDuration !== null && staleDuration >= policy.staleSynchronizationIntervalMs;
  return detectorResult(
    detected,
    detected ? 'HIGH' : 'LOW',
    detected ? unique(recoveredRecords.map((item) => item.id)) : [],
    detected
      ? 'The authoritative source is resolved while Operations remains open beyond the accepted synchronization interval.'
      : 'No authoritative resolved-source and still-open Operations synchronization gap is proven.',
    { sourceResolvedAt, operationsStatus: operationsStatus || 'UNKNOWN', staleDuration },
  );
}

function evaluateNoiseDetection(occurrence, decision, allOccurrences, evaluatedAt, policy) {
  const detectors = {
    DUPLICATE: detectDuplicate(occurrence),
    FLAPPING: detectFlapping(occurrence),
    AUTO_RESOLVED: detectAutoResolved(occurrence, allOccurrences),
    NON_ACTIONABLE: detectNonActionable(occurrence),
    CORRELATED: detectCorrelated(occurrence, allOccurrences),
    STALE: detectStale(occurrence, allOccurrences, evaluatedAt, policy),
  };
  const categories = Object.entries(detectors).filter(([, result]) => result.detected).map(([category]) => category);
  const sufficientlyObserved = positiveEventProof(occurrence)
    || decision.decision !== 'NEEDS_REVIEW'
    || occurrence.notificationRole.role !== 'UNKNOWN';
  const outputCategories = categories.length ? categories : [sufficientlyObserved ? 'NONE' : 'UNKNOWN'];
  const confidence = categories.some((category) => detectors[category].confidence === 'HIGH') ? 'HIGH'
    : categories.length || sufficientlyObserved ? 'MEDIUM' : 'LOW';
  return {
    detected: categories.length > 0,
    categories: outputCategories,
    primaryCategory: outputCategories[0],
    confidence,
    evidenceIds: unique(categories.flatMap((category) => detectors[category].evidence)),
    reasoning: categories.length
      ? categories.map((category) => detectors[category].reasoning).join(' ')
      : sufficientlyObserved ? 'No supported noise behavior is present in the available source and event evidence.'
        : 'Evidence is insufficient to confirm or exclude a known noise behavior.',
    detectors,
  };
}

function structuredEvidence(occurrence) {
  return [...occurrence.sourceNativeEvidence, ...occurrence.telemetry].map((item) => ({
    id: item.id,
    text: cleanText([
      item.type, item.entity, item.correlationKey,
      item.metadata?.metric, item.metadata?.metricName, item.metadata?.healthRule,
      item.metadata?.eventType, item.metadata?.entityType, item.metadata?.testType,
      item.metadata?.service, item.metadata?.rule, item.metadata?.condition,
    ].filter(Boolean).join(' ')),
  })).filter((item) => item.text);
}

function classificationFromText(text, source) {
  const value = canonical(text);
  if (/payment gateway|merchant processor/.test(value)) return ['DEPENDENCY', 'PAYMENT_GATEWAY'];
  if (/database unavailable|database down|db unavailable/.test(value)) return ['DEPENDENCY', 'DATABASE_UNAVAILABLE'];
  if (/external api/.test(value)) return ['DEPENDENCY', 'EXTERNAL_API_FAILURE'];
  if (/downstream service/.test(value)) return ['DEPENDENCY', 'DOWNSTREAM_SERVICE'];
  if (/third party/.test(value)) return ['DEPENDENCY', 'THIRD_PARTY'];
  if (/packet loss/.test(value)) return ['NETWORK', 'PACKET_LOSS'];
  if (/high latency|latency/.test(value) && source === 'ThousandEyes') return ['NETWORK', 'HIGH_LATENCY'];
  if (/interface down/.test(value)) return ['NETWORK', 'INTERFACE_DOWN'];
  if (/\bdns\b/.test(value)) return ['NETWORK', 'DNS'];
  if (/network path|path visualization/.test(value)) return ['NETWORK', 'PATH'];
  if (/connectivity|unreachable/.test(value) && source === 'ThousandEyes') return ['NETWORK', 'CONNECTIVITY'];
  if (/\bcpu\b/.test(value)) return ['INFRASTRUCTURE', 'CPU'];
  if (/memory|heap/.test(value)) return ['INFRASTRUCTURE', 'MEMORY'];
  if (/disk|filesystem|storage full/.test(value)) return ['INFRASTRUCTURE', 'DISK'];
  if (/\bpod\b/.test(value)) return ['INFRASTRUCTURE', 'POD'];
  if (/container/.test(value)) return ['INFRASTRUCTURE', 'CONTAINER'];
  if (/\bnode\b/.test(value) && source !== 'AppDynamics') return ['INFRASTRUCTURE', 'NODE'];
  if (/\bserver\b|host down/.test(value)) return ['INFRASTRUCTURE', 'SERVER'];
  if (/response time|slow transaction/.test(value)) return ['APPLICATION', 'RESPONSE_TIME'];
  if (/business transaction/.test(value)) return ['APPLICATION', 'BUSINESS_TRANSACTION'];
  if (/error rate|error percentage|errors per minute/.test(value)) return ['APPLICATION', 'ERROR_RATE'];
  if (/exception/.test(value)) return ['APPLICATION', 'EXCEPTION'];
  if (/database connection/.test(value)) return ['APPLICATION', 'DATABASE_CONNECTION'];
  if (/api failure|http 5\d\d|status 5\d\d/.test(value)) return ['APPLICATION', 'API_FAILURE'];
  if (/application health|health rule|anomaly/.test(value)) return ['APPLICATION', 'APPLICATION_HEALTH'];
  return null;
}

function evaluateClassification(occurrence) {
  const workflowCondition = cleanText(occurrence.appDynamicsWorkflow?.details?.condition).toUpperCase();
  const workflowMap = {
    RESPONSE_TIME: ['APPLICATION', 'RESPONSE_TIME'], ERROR_RATE: ['APPLICATION', 'ERROR_RATE'],
    BUSINESS_TRANSACTION: ['APPLICATION', 'BUSINESS_TRANSACTION'], DATABASE_CONNECTION: ['APPLICATION', 'DATABASE_CONNECTION'],
    CPU: ['INFRASTRUCTURE', 'CPU'], MEMORY: ['INFRASTRUCTURE', 'MEMORY'],
  };
  if (workflowMap[workflowCondition]) {
    const workflowEvidenceIds = unique(occurrence.appDynamicsWorkflow.evidenceUsed?.map((item) => item.id));
    return {
      domain: workflowMap[workflowCondition][0], subtype: workflowMap[workflowCondition][1],
      confidence: workflowEvidenceIds.length ? 'HIGH' : 'MEDIUM',
      evidenceIds: workflowEvidenceIds.length ? workflowEvidenceIds : [occurrence.alert.id],
      reasoning: workflowEvidenceIds.length
        ? 'AppDynamics workflow metadata and returned source evidence identify the entity-level alert condition.'
        : 'The normalized AppDynamics alert workflow identifies the condition, but matching source evidence is still incomplete.',
    };
  }
  const structured = structuredEvidence(occurrence);
  for (const item of structured) {
    const match = classificationFromText(item.text, occurrence.source.name);
    if (match) return { domain: match[0], subtype: match[1], confidence: 'HIGH', evidenceIds: [item.id],
      reasoning: 'Structured source, rule, metric, test, or entity metadata identifies the technical alert type.' };
  }
  const fallback = classificationFromText(`${occurrence.alert.pattern || ''} ${occurrence.alert.title || ''}`, occurrence.source.name);
  if (fallback) return { domain: fallback[0], subtype: fallback[1], confidence: 'MEDIUM', evidenceIds: [occurrence.alert.id],
    reasoning: 'No conflicting structured metadata was available, so the normalized Operations alert condition was used as a fallback.' };
  return { domain: 'UNKNOWN', subtype: 'UNKNOWN', confidence: 'LOW', evidenceIds: [],
    reasoning: 'No authoritative source metadata, metric identity, rule identity, or unambiguous fallback identifies the technical alert type.' };
}

function impactCandidates(occurrence) {
  const records = [...occurrence.sourceNativeEvidence, ...occurrence.telemetry,
    ...(occurrence.jira.records || []), ...(occurrence.slack.records || [])];
  const candidates = records.flatMap((item) => {
    const metadata = item.metadata || {};
    return [metadata.businessImpact, metadata.serviceCriticality, metadata.customerImpact,
      metadata.revenueImpact, metadata.impact, metadata.businessCriticality]
      .filter(Boolean).map((value) => ({ id: item.id, value: cleanText(value) }));
  });
  const operations = occurrence.operations || {};
  [operations.businessImpact, operations.serviceCriticality, operations.customerImpact, operations.revenueImpact]
    .filter(Boolean).forEach((value) => candidates.push({ id: occurrence.alert.id, value: cleanText(value) }));
  return candidates;
}

function evaluateBusinessImpact(occurrence) {
  const candidates = impactCandidates(occurrence);
  for (const candidate of candidates) {
    const value = canonical(candidate.value);
    if (/business critical|customer facing critical|revenue impact|payment impact|critical business process/.test(value)) {
      return { level: 'BUSINESS_CRITICAL', confidence: 'HIGH', evidenceIds: [candidate.id],
        reasoning: 'Authoritative service metadata explicitly identifies customer, revenue, payment, or critical-business-process impact.' };
    }
    if (/\bhigh\b|major service|significant impact|significant degradation/.test(value)) return {
      level: 'HIGH', confidence: 'HIGH', evidenceIds: [candidate.id],
      reasoning: 'Authoritative service metadata identifies major or significant service impact.',
    };
    if (/\bmedium\b|limited service|component impact/.test(value)) return {
      level: 'MEDIUM', confidence: 'HIGH', evidenceIds: [candidate.id],
      reasoning: 'Authoritative service metadata identifies limited service or component impact.',
    };
    if (/\blow\b|minor|informational|localized/.test(value)) return {
      level: 'LOW', confidence: 'HIGH', evidenceIds: [candidate.id],
      reasoning: 'Authoritative service metadata identifies minor, informational, or localized impact.',
    };
  }
  return { level: 'UNKNOWN', confidence: 'LOW', evidenceIds: [],
    reasoning: 'No authoritative business-service criticality, customer-impact, or revenue-impact evidence is available.' };
}

function evaluateUnderlyingEvent(occurrence, decision, noiseDetection) {
  const confirmed = decision.underlyingEvent.confirmed === true;
  const evidence = unique([...decision.evidenceUsed.map((item) => item.id), ...occurrence.event.evidenceIds]);
  const nonActionable = noiseDetection.categories.includes('NON_ACTIONABLE');
  let status = 'UNKNOWN';
  if (confirmed && nonActionable) status = 'CONFIRMED_NON_ACTIONABLE_EVENT';
  else if (confirmed) status = 'CONFIRMED_INCIDENT';
  else if (decision.subtype === 'NO_DISTINCT_EVENT') status = 'NO_DISTINCT_EVENT';
  else if (occurrence.event.state !== 'UNKNOWN') status = 'UNCONFIRMED';
  return {
    status, eventId: occurrence.event.eventId, confidence: confirmed ? decision.confidence : 'LOW', evidenceIds: confirmed ? evidence : [],
    reasoning: confirmed
      ? nonActionable ? 'Positive source evidence confirms a real but non-actionable operational event.'
        : 'Authoritative source or sustained matched telemetry confirms a real operational incident.'
      : status === 'UNCONFIRMED' ? 'An event boundary is present, but the required source or telemetry proof is incomplete.'
        : 'Available evidence does not establish whether a distinct operational event occurred.',
    start: occurrence.event.start, recovery: occurrence.event.recovery, state: occurrence.event.state,
    sources: occurrence.event.sources, entities: occurrence.event.entities,
  };
}

function evaluateNotificationRole(occurrence, noiseDetection) {
  let role = occurrence.notificationRole.role;
  if (noiseDetection.categories.includes('NON_ACTIONABLE') && occurrence.nonActionableEvidence.some((item) => item.transient)) role = 'TRANSIENT';
  const supported = role !== 'UNKNOWN' && occurrence.notificationRole.reasons?.length;
  return {
    role, representativeAlertId: occurrence.event.representativeNotification || null,
    confidence: supported ? occurrence.evidenceConfidence.level === 'HIGH' ? 'HIGH' : 'MEDIUM' : 'LOW',
    evidenceIds: supported ? unique([occurrence.event.eventId, ...occurrence.event.evidenceIds]) : [],
    reasoning: occurrence.notificationRole.reasons?.join(' ') || 'The notification contribution cannot be proven from the current event evidence.',
  };
}

function evaluateActionability(occurrence, decision, noiseDetection, underlyingEvent) {
  const nonActionable = noiseDetection.categories.includes('NON_ACTIONABLE');
  if (nonActionable && underlyingEvent.status === 'CONFIRMED_NON_ACTIONABLE_EVENT') return {
    value: 'NON_ACTIONABLE', confidence: 'HIGH', evidenceIds: noiseDetection.detectors.NON_ACTIONABLE.evidence,
    reasoning: 'Positive source evidence proves recovery without sustained degradation or meaningful engineer intervention.',
  };
  if (underlyingEvent.status === 'CONFIRMED_INCIDENT' && decision.evidenceUsed.length) return {
    value: 'ACTIONABLE', confidence: decision.confidence, evidenceIds: decision.evidenceUsed.map((item) => item.id),
    reasoning: decision.decision === 'NOISE'
      ? 'The underlying incident is actionable even though this particular notification is redundant.'
      : 'The confirmed operational condition requires or warranted operator attention.',
  };
  return { value: 'UNKNOWN', confidence: 'LOW', evidenceIds: [],
    reasoning: 'Evidence does not prove that intervention is required or unnecessary.' };
}

function evaluateFinalDecision(decision, noiseDetection, actionability, underlyingEvent, notificationRole, policy) {
  const usefulIncidentRole = ['REPRESENTATIVE', 'DISTINCT_SIGNAL', 'ESCALATION', 'RECOVERY'].includes(notificationRole.role);
  const positiveNoise = noiseDetection.categories.some((item) => !['NONE', 'UNKNOWN', 'AUTO_RESOLVED'].includes(item));
  let rule = policy.rules.needsReview;
  let final = 'NEEDS_REVIEW';
  if (decision.decision === 'INCIDENT' && underlyingEvent.status === 'CONFIRMED_INCIDENT' && usefulIncidentRole && decision.evidenceUsed.length) {
    rule = policy.rules.incident; final = 'INCIDENT';
  } else if (decision.decision === 'NOISE' && notificationRole.role === 'REDUNDANT'
    && underlyingEvent.status === 'CONFIRMED_INCIDENT' && positiveNoise && decision.evidenceUsed.length) {
    rule = policy.rules.redundantNoise; final = 'NOISE';
  } else if (decision.decision === 'NOISE' && underlyingEvent.status === 'CONFIRMED_NON_ACTIONABLE_EVENT'
    && actionability.value === 'NON_ACTIONABLE' && decision.evidenceUsed.length) {
    rule = policy.rules.nonActionableNoise; final = 'NOISE';
  } else if (decision.decision === 'NOISE' && noiseDetection.categories.includes('STALE') && decision.evidenceUsed.length) {
    rule = policy.rules.staleNoise; final = 'NOISE';
  }
  const evidence = final === 'NEEDS_REVIEW' ? decision.evidenceMissing : decision.evidenceUsed;
  return {
    decision: final,
    subtype: final === 'NEEDS_REVIEW' && decision.decision !== 'NEEDS_REVIEW' ? 'CANONICAL_RULE_MISMATCH' : decision.subtype,
    confidence: final === 'NEEDS_REVIEW' ? 'LOW' : decision.confidence,
    ruleId: rule.id,
    sourceRuleId: decision.ruleId,
    evidenceIds: unique(evidence.map((item) => item.id)),
    reasoning: final === 'NEEDS_REVIEW'
      ? decision.decision === 'NEEDS_REVIEW' ? decision.reasoning
        : 'The source decision lacks one or more canonical event, role, actionability, or positive-noise requirements and therefore fails closed.'
      : `${rule.description} Source rule: ${decision.ruleId}.`,
  };
}

function buildWhyStatements(assessment) {
  const values = [
    assessment.underlyingEvent.reasoning,
    assessment.notificationRole.reasoning,
    assessment.noiseDetection.reasoning,
    assessment.actionability.reasoning,
    assessment.classification.reasoning,
    assessment.businessImpact.reasoning,
    assessment.finalDecision.reasoning,
  ];
  return unique(values).slice(0, 7);
}

function buildCanonicalAlertAssessment(occurrence, decision, allOccurrences, {
  evaluatedAt = new Date().toISOString(), policy = CANONICAL_ALERT_ASSESSMENT_POLICY,
} = {}) {
  const noiseDetection = evaluateNoiseDetection(occurrence, decision, allOccurrences, evaluatedAt, policy);
  const classification = evaluateClassification(occurrence);
  const businessImpact = evaluateBusinessImpact(occurrence);
  const underlyingEvent = evaluateUnderlyingEvent(occurrence, decision, noiseDetection);
  const notificationRole = evaluateNotificationRole(occurrence, noiseDetection);
  const actionability = evaluateActionability(occurrence, decision, noiseDetection, underlyingEvent);
  const finalDecision = evaluateFinalDecision(decision, noiseDetection, actionability, underlyingEvent, notificationRole, policy);
  const usedIds = unique([
    ...noiseDetection.evidenceIds, ...classification.evidenceIds, ...businessImpact.evidenceIds,
    ...actionability.evidenceIds, ...underlyingEvent.evidenceIds, ...notificationRole.evidenceIds,
    ...finalDecision.evidenceIds,
  ]);
  const missingIds = new Set(decision.evidenceMissing.map((item) => item.id));
  const usedById = new Map(decision.evidenceUsed.map((item) => [item.id, item]));
  const evidenceUsed = usedIds.filter((id) => !missingIds.has(id))
    .map((id) => usedById.get(id) || { id, type: 'CANONICAL_SUPPORTING_EVIDENCE', source: occurrence.source.name });
  const assessment = {
    alertId: occurrence.occurrenceId,
    noiseDetection,
    classification,
    businessImpact,
    actionability,
    underlyingEvent,
    notificationRole,
    finalDecision,
    evidenceUsed,
    evidenceMissing: decision.evidenceMissing,
    evidenceRejected: decision.evidenceRejected,
    evaluatedAt,
    modelVersion: policy.modelVersion,
  };
  assessment.whyThisDecision = buildWhyStatements(assessment);
  assessment.inputVersion = hash({
    alertId: assessment.alertId, noiseDetection, classification, businessImpact, actionability,
    underlyingEvent, notificationRole, finalDecision, evidenceUsed, evidenceMissing: assessment.evidenceMissing,
  });
  return assessment;
}

function countBy(items, selector, values) {
  return Object.fromEntries(values.map((value) => [value, items.filter((item) => selector(item) === value).length]));
}

function summarizeCanonicalAssessments(assessments, denominator = assessments.length) {
  const decisions = countBy(assessments, (item) => item.finalDecision.decision, ['INCIDENT', 'NOISE', 'NEEDS_REVIEW']);
  const noiseBreakdown = Object.fromEntries(['DUPLICATE', 'FLAPPING', 'AUTO_RESOLVED', 'NON_ACTIONABLE', 'CORRELATED', 'STALE']
    .map((category) => [category, assessments.filter((item) => item.noiseDetection.categories.includes(category)).length]));
  const classification = countBy(assessments, (item) => item.classification.domain,
    ['INFRASTRUCTURE', 'APPLICATION', 'NETWORK', 'DEPENDENCY', 'UNKNOWN']);
  const businessImpact = countBy(assessments, (item) => item.businessImpact.level,
    ['BUSINESS_CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'UNKNOWN']);
  const actionability = countBy(assessments, (item) => item.actionability.value,
    ['ACTIONABLE', 'NON_ACTIONABLE', 'UNKNOWN']);
  const underlyingEvent = countBy(assessments, (item) => item.underlyingEvent.status,
    ['CONFIRMED_INCIDENT', 'CONFIRMED_NON_ACTIONABLE_EVENT', 'NO_DISTINCT_EVENT', 'UNCONFIRMED', 'UNKNOWN']);
  const notificationRole = countBy(assessments, (item) => item.notificationRole.role,
    ['REPRESENTATIVE', 'REDUNDANT', 'DISTINCT_SIGNAL', 'ESCALATION', 'RECOVERY', 'TRANSIENT', 'UNKNOWN']);
  const automatic = assessments.filter((item) => item.finalDecision.decision !== 'NEEDS_REVIEW');
  const deterministic = automatic.filter((item) => item.finalDecision.ruleId).length;
  const provenance = automatic.filter((item) => item.finalDecision.evidenceIds.length).length;
  const unsupported = automatic.filter((item) => !item.finalDecision.ruleId || !item.finalDecision.evidenceIds.length).length;
  return {
    total: denominator,
    evaluated: assessments.length,
    incident: decisions.INCIDENT,
    noise: decisions.NOISE,
    needsReview: decisions.NEEDS_REVIEW,
    noiseBreakdown,
    classification,
    businessImpact,
    actionability,
    underlyingEvent,
    notificationRole,
    quality: {
      deterministicDecisionCoveragePercentage: automatic.length ? Number((deterministic / automatic.length * 100).toFixed(1)) : 100,
      evidenceProvenanceCoveragePercentage: automatic.length ? Number((provenance / automatic.length * 100).toFixed(1)) : 100,
      unsupportedAutomaticDecisions: unsupported,
      noiseFromMissingIncidentEvidence: assessments.filter((item) => item.finalDecision.decision === 'NOISE'
        && !item.finalDecision.evidenceIds.length).length,
      fabricatedUnknownFields: 0,
      reconciliation: assessments.length === denominator
        && decisions.INCIDENT + decisions.NOISE + decisions.NEEDS_REVIEW === denominator,
    },
  };
}

function safeAssessment(value) {
  return JSON.parse(JSON.stringify(value, (key, item) => /token|secret|password|credential|authorization|cookie|raw/i.test(key) ? '[REDACTED]' : item));
}

function createCanonicalAssessmentAuditStore({ database = db } = {}) {
  let readyPromise = null;
  const ensure = () => {
    if (!readyPromise) readyPromise = database.query(`CREATE TABLE IF NOT EXISTS canonical_alert_assessment_audit (
      assessment_id TEXT PRIMARY KEY, alert_id TEXT NOT NULL, model_version TEXT NOT NULL,
      input_version TEXT NOT NULL, final_decision TEXT NOT NULL, final_rule_id TEXT NOT NULL,
      previous_decision TEXT, reason_for_change TEXT NOT NULL, assessment_json JSONB NOT NULL,
      evaluated_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`)
      .then(() => database.query(`CREATE INDEX IF NOT EXISTS canonical_assessment_alert_time_idx
        ON canonical_alert_assessment_audit(alert_id, evaluated_at DESC)`))
      .catch((error) => { readyPromise = null; throw error; });
    return readyPromise;
  };
  return {
    async latest(ids) {
      if (!ids.length) return new Map();
      await ensure();
      const result = await database.query(`SELECT DISTINCT ON (alert_id) alert_id, input_version, final_decision,
        final_rule_id, assessment_json FROM canonical_alert_assessment_audit
        WHERE alert_id=ANY($1::text[]) ORDER BY alert_id, evaluated_at DESC, created_at DESC`, [ids.map(String)]);
      return new Map(result.rows.map((row) => [String(row.alert_id), row]));
    },
    async saveMany(assessments, previousById) {
      await ensure();
      const rows = assessments.map((assessment) => {
        const previous = previousById.get(String(assessment.alertId));
        const assessmentId = `can_assess_${hash(`${assessment.alertId}|${assessment.modelVersion}|${assessment.inputVersion}`)}`;
        const previousDecision = previous?.final_decision || null;
        const reasonForChange = !previous ? 'INITIAL_CANONICAL_ASSESSMENT'
          : previous.input_version === assessment.inputVersion ? 'UNCHANGED_EVIDENCE_REPLAY'
            : previousDecision !== assessment.finalDecision.decision ? 'DECISION_CHANGED_AFTER_EVIDENCE_UPDATE'
              : previous.final_rule_id !== assessment.finalDecision.ruleId ? 'RULE_CHANGED' : 'EVIDENCE_UPDATED_DECISION_UNCHANGED';
        const audited = safeAssessment({ ...assessment, audit: { assessmentId, previousDecision,
          newDecision: assessment.finalDecision.decision, reasonForChange } });
        return { assessmentId, assessment: audited, previousDecision, reasonForChange };
      });
      if (rows.length) await database.query(`INSERT INTO canonical_alert_assessment_audit
        (assessment_id,alert_id,model_version,input_version,final_decision,final_rule_id,previous_decision,
         reason_for_change,assessment_json,evaluated_at)
        SELECT assessment_id,alert_id,model_version,input_version,final_decision,final_rule_id,previous_decision,
          reason_for_change,assessment_json,evaluated_at
        FROM jsonb_to_recordset($1::jsonb) AS record(assessment_id TEXT,alert_id TEXT,model_version TEXT,
          input_version TEXT,final_decision TEXT,final_rule_id TEXT,previous_decision TEXT,
          reason_for_change TEXT,assessment_json JSONB,evaluated_at TIMESTAMPTZ)
        ON CONFLICT (assessment_id) DO NOTHING`, [JSON.stringify(rows.map((row) => ({
          assessment_id: row.assessmentId, alert_id: row.assessment.alertId,
          model_version: row.assessment.modelVersion, input_version: row.assessment.inputVersion,
          final_decision: row.assessment.finalDecision.decision, final_rule_id: row.assessment.finalDecision.ruleId,
          previous_decision: row.previousDecision, reason_for_change: row.reasonForChange,
          assessment_json: row.assessment, evaluated_at: row.assessment.evaluatedAt,
        })))]) ;
      return rows.map((row) => row.assessment);
    },
    async history(alertId, limit = 50) {
      await ensure();
      const result = await database.query(`SELECT assessment_json FROM canonical_alert_assessment_audit
        WHERE alert_id=$1 ORDER BY evaluated_at DESC, created_at DESC LIMIT $2`,
      [String(alertId), Math.max(1, Math.min(200, Number(limit) || 50))]);
      return result.rows.map((row) => row.assessment_json);
    },
  };
}

function createNoopCanonicalAssessmentAuditStore() {
  return {
    async latest() { return new Map(); },
    async saveMany(assessments) { return assessments; },
    async history() { return []; },
  };
}

module.exports = {
  buildCanonicalAlertAssessment,
  createCanonicalAssessmentAuditStore,
  createNoopCanonicalAssessmentAuditStore,
  detectAutoResolved,
  detectCorrelated,
  detectDuplicate,
  detectFlapping,
  detectNonActionable,
  detectStale,
  evaluateActionability,
  evaluateBusinessImpact,
  evaluateClassification,
  evaluateFinalDecision,
  evaluateNoiseDetection,
  evaluateNotificationRole,
  evaluateUnderlyingEvent,
  summarizeCanonicalAssessments,
};
