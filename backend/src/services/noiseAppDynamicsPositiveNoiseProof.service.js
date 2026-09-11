const NOISE_SUBTYPES = Object.freeze([
  'REDUNDANT_REAL_EVENT',
  'EXACT_DUPLICATE_NOTIFICATION',
  'FLAPPING_NOTIFICATION',
  'TRANSIENT_NON_ACTIONABLE',
  'REPEATED_RECOVERY_NOTIFICATION',
  'NON_ACTIONABLE_SOURCE_CONDITION',
]);

function cleanText(value) {
  return String(value ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function canonical(value) {
  return cleanText(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function toMs(value) {
  if (Number.isFinite(value)) return Number(value);
  const parsed = value ? new Date(value).getTime() : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function severityRank(value) {
  const text = cleanText(value).toUpperCase();
  if (/P1|CRITICAL|FATAL/.test(text)) return 4;
  if (/P2|HIGH|ERROR/.test(text)) return 3;
  if (/P3|MEDIUM|WARN/.test(text)) return 2;
  return text ? 1 : 0;
}

function valueFor(item, names) {
  for (const name of names) {
    const value = name.split('.').reduce((current, key) => current?.[key], item);
    if (cleanText(value)) return cleanText(value);
  }
  return null;
}

function identityFor(item) {
  const { alert, facts } = item;
  return {
    application: cleanText(facts.sourceEvent?.applicationId || facts.directEvent?.application?.id
      || alert.application?.id || alert.application?.name) || null,
    entity: cleanText(facts.sourceEvent?.entity || facts.directEvent?.entity
      || valueFor(alert, ['operationsIdentity.node', 'sourceIdentity.node', 'operationsIdentity.tier', 'sourceIdentity.tier',
        'operationsIdentity.businessTransaction', 'sourceIdentity.businessTransaction', 'operationsIdentity.service', 'sourceIdentity.service'])) || null,
    node: valueFor(alert, ['operationsIdentity.node', 'sourceIdentity.node']),
    tier: valueFor(alert, ['operationsIdentity.tier', 'sourceIdentity.tier']),
    businessTransaction: valueFor(alert, ['operationsIdentity.businessTransaction', 'sourceIdentity.businessTransaction']),
    healthRule: cleanText(facts.sourceEvent?.healthRule || alert.alertCondition?.healthRule || alert.operationsIdentity?.healthRule) || null,
    condition: cleanText(alert.alertCondition?.name || facts.directEvent?.conditionFamily || alert.title) || null,
    state: cleanText(facts.sourceEvent?.transition || facts.directEvent?.state) || null,
    severity: cleanText(alert.monitoringSeverity || alert.severity || alert.priority || facts.sourceEvent?.severity) || null,
    sourceIds: [...new Set([...(facts.sourceEvent?.ids || []), ...(facts.sourceEvent?.violationIds || [])].map(cleanText).filter(Boolean))],
  };
}

function sameValue(left, right) {
  if (!left || !right) return true;
  return canonical(left) === canonical(right);
}

function shared(valuesA, valuesB) {
  const right = new Set(valuesB || []);
  return (valuesA || []).some((value) => right.has(value));
}

function recoveryFor(item) {
  if (item.facts.sourceEvent?.transition === 'RECOVERY') return true;
  const recoveryAt = toMs(item.facts.directEvent?.recoveryAt);
  const notificationAt = toMs(item.alert.createdAt);
  return recoveryAt !== null && notificationAt !== null && notificationAt >= recoveryAt;
}

function recoveryBetween(item, representative) {
  const from = toMs(representative?.alert?.createdAt);
  const to = toMs(item.alert.createdAt);
  if (from === null || to === null) return false;
  return (item.facts.directEvent?.timeline || []).some((entry) => entry.type === 'RECOVERY'
    && toMs(entry.timestamp) > from && toMs(entry.timestamp) <= to);
}

function distinctInformationCheck(item, representative) {
  const current = identityFor(item);
  const retained = identityFor(representative || item);
  const markers = item.facts.directNotification?.distinctInformation || [];
  const dimensionChanges = ['node', 'tier', 'businessTransaction'].filter((key) => {
    if (!current[key]) return false;
    return !retained[key] || !sameValue(current[key], retained[key]);
  });
  const newSeverity = severityRank(current.severity) > severityRank(retained.severity);
  const newEntity = dimensionChanges.length > 0 || markers.includes('NEW_AFFECTED_COMPONENT')
    || (!sameValue(current.entity, retained.entity) && Boolean(current.entity));
  const newCondition = !sameValue(current.healthRule, retained.healthRule)
    || !sameValue(current.condition, retained.condition);
  const escalation = newSeverity || markers.includes('MATERIAL_ESCALATION') || markers.includes('METRIC_WORSENING');
  const recovery = recoveryFor(item);
  const extraMarkers = markers.filter((value) => !['REPRESENTATIVE_SIGNAL'].includes(value));
  const hasDistinctInformation = newSeverity || newEntity || newCondition || escalation || recovery || extraMarkers.length > 0;
  return {
    newSeverity,
    newEntity,
    newCondition,
    escalation,
    recovery,
    changedDimensions: dimensionChanges,
    sourceMarkers: extraMarkers,
    result: hasDistinctInformation ? 'DISTINCT_INFORMATION_PRESENT' : 'NO_DISTINCT_INFORMATION',
  };
}

function relationshipFor(item, representative) {
  const current = identityFor(item);
  const retained = identityFor(representative || item);
  const sameDirectEvent = Boolean(item.facts.directEvent?.eventId && representative?.facts.directEvent?.eventId
    && item.facts.directEvent.eventId === representative.facts.directEvent.eventId);
  const sharedSourceEvent = shared(current.sourceIds, retained.sourceIds);
  return {
    sameDirectEvent,
    sharedSourceEvent,
    compatibleApplication: sameValue(current.application, retained.application),
    compatibleEntity: sameValue(current.entity, retained.entity),
    compatibleHealthRule: sameValue(current.healthRule, retained.healthRule),
    compatibleCondition: sameValue(current.condition, retained.condition),
    sameState: sameValue(current.state, retained.state),
  };
}

function proofEvidence(item, relationship, distinctCheck) {
  const evidenceUsed = [];
  if (relationship.sharedSourceEvent) evidenceUsed.push({
    tier: 'A', type: 'SHARED_SOURCE_EVENT_ID',
    reason: 'The notification and retained representative share a source event or violation identifier.',
  });
  if (relationship.sameDirectEvent) evidenceUsed.push({
    tier: 'B', type: 'SHARED_RECONSTRUCTED_EVENT',
    reason: 'The existing AppDynamics event reconstruction places both notifications in the same validated event chain.',
  });
  if (item.facts.directEvent?.flapping) evidenceUsed.push({
    tier: 'A', type: 'SOURCE_NATIVE_TRANSITION_SEQUENCE',
    reason: `${item.facts.directEvent.transitionCount || 0} alternating source-native transitions confirm flapping behavior.`,
  });
  if (item.facts.directEvent?.recoveryAt) evidenceUsed.push({
    tier: 'A', type: 'SOURCE_NATIVE_RECOVERY',
    reason: 'An explicit AppDynamics recovery transition is present in the reconstructed event.',
  });
  if (item.facts.directEvent?.sourceNonActionable === true) evidenceUsed.push({
    tier: 'A', type: 'SOURCE_NON_ACTIONABLE_CONDITION',
    reason: 'Persisted AppDynamics source evidence positively identifies the condition as non-actionable.',
  });
  if (distinctCheck.result === 'NO_DISTINCT_INFORMATION') evidenceUsed.push({
    tier: relationship.sharedSourceEvent ? 'A' : 'B', type: 'NO_DISTINCT_INFORMATION',
    reason: 'No new severity, entity, condition, escalation, recovery, or source marker was introduced.',
  });
  return evidenceUsed;
}

function makeProof({ item, representative, rule, subtype, relationship, distinctCheck, confidence, reasoning, evaluatedAt }) {
  return {
    alertId: String(item.alert.id),
    alertNumber: item.alert.alertNumber || null,
    pattern: cleanText(item.alert.pattern || item.alert.title) || null,
    decision: 'NOISE', subtype, ruleId: rule.id, ruleVersion: rule.version,
    underlyingEvent: {
      eventId: item.facts.directEvent?.eventId || item.eventKey || null,
      confirmed: true,
      representativeAlertId: representative ? String(representative.alert.id) : null,
      representativeAlertNumber: representative?.alert.alertNumber || null,
    },
    evidenceUsed: proofEvidence(item, relationship, distinctCheck),
    evidenceMissing: [],
    evidenceRejected: [],
    distinctInformationCheck: distinctCheck,
    reasoning,
    confidence,
    evaluatedAt,
  };
}

function evaluatePositiveNoiseProof(item, config, evaluatedAt) {
  const group = item.eventGroup || [];
  const representative = group.find((entry) => String(entry.alert.id) === String(item.representativeAlertId)) || null;
  const relationship = relationshipFor(item, representative);
  const distinctCheck = distinctInformationCheck(item, representative);
  const confirmed = item.facts.sourceEvent?.valid === true || item.facts.directTelemetry === true;
  const compatible = relationship.compatibleApplication && relationship.compatibleEntity
    && relationship.compatibleHealthRule && relationship.compatibleCondition;
  const earlierRepresentative = representative && String(representative.alert.id) !== String(item.alert.id)
    && toMs(representative.alert.createdAt) <= toMs(item.alert.createdAt);
  const hasEventIdentity = relationship.sharedSourceEvent || relationship.sameDirectEvent;
  const operatorAction = (item.facts.corroboration?.slackEvidence || []).length > 0;
  const baseBlocked = !confirmed || item.facts.evidenceConflict || !item.facts.businessTransactionSafe
    || !hasEventIdentity || !compatible || !representative;
  const distinctBlocked = distinctCheck.newSeverity || distinctCheck.newEntity || distinctCheck.newCondition || distinctCheck.escalation;

  if (!baseBlocked && earlierRepresentative && item.repeatedRecovery === true && distinctCheck.recovery && !distinctBlocked) {
    return makeProof({ item, representative, rule: config.rules.repeatedRecoveryNoise,
      subtype: 'REPEATED_RECOVERY_NOTIFICATION', relationship, distinctCheck,
      confidence: relationship.sharedSourceEvent ? 'HIGH' : 'MEDIUM', evaluatedAt,
      reasoning: 'The same confirmed event already has a retained recovery notification; this later recovery repeats the identical state without adding an entity, condition, severity, escalation, or action.',
    });
  }

  const noDistinct = distinctCheck.result === 'NO_DISTINCT_INFORMATION';
  const noRecoveryBetween = !recoveryBetween(item, representative);
  if (!baseBlocked && earlierRepresentative && item.notificationRole === 'REDUNDANT' && noDistinct && noRecoveryBetween
    && relationship.sharedSourceEvent && relationship.sameState) {
    return makeProof({ item, representative, rule: config.rules.exactDuplicateNoise,
      subtype: 'EXACT_DUPLICATE_NOTIFICATION', relationship, distinctCheck, confidence: 'HIGH', evaluatedAt,
      reasoning: 'The retained representative has the same source event identity, application, entity, condition, state, and compatible timestamp. This notification adds no distinct information.',
    });
  }

  if (!baseBlocked && earlierRepresentative && item.notificationRole === 'REDUNDANT' && noDistinct && noRecoveryBetween
    && item.facts.directEvent?.flapping === true && Number(item.facts.directEvent?.transitionCount || 0) >= 4) {
    return makeProof({ item, representative, rule: config.rules.flappingNotificationNoise,
      subtype: 'FLAPPING_NOTIFICATION', relationship, distinctCheck,
      confidence: relationship.sharedSourceEvent ? 'HIGH' : 'MEDIUM', evaluatedAt,
      reasoning: 'Source-native transitions confirm a flapping event and the retained representative preserves the event. This notification repeats the represented condition without new operational information.',
    });
  }

  if (!baseBlocked && earlierRepresentative && item.notificationRole === 'REDUNDANT' && noDistinct && noRecoveryBetween) {
    return makeProof({ item, representative, rule: config.rules.redundantRealEventNoise,
      subtype: 'REDUNDANT_REAL_EVENT', relationship, distinctCheck,
      confidence: relationship.sharedSourceEvent ? 'HIGH' : 'MEDIUM', evaluatedAt,
      reasoning: 'The underlying AppDynamics event remains a retained Incident. This later notification belongs to the same compatible event and adds no new entity, condition, severity, escalation, recovery, or source detail.',
    });
  }

  const recovered = Boolean(item.facts.directEvent?.recoveryAt);
  const nonActionable = item.facts.directEvent?.sourceNonActionable === true;
  const transient = item.facts.directEvent?.state === 'TRANSIENT';
  if (!baseBlocked && transient && nonActionable && recovered && !operatorAction && !distinctBlocked
    && !item.repeatedRecovery && item.notificationRole === 'REPRESENTATIVE') {
    return makeProof({ item, representative, rule: config.rules.transientNonActionableNoise,
      subtype: 'TRANSIENT_NON_ACTIONABLE', relationship, distinctCheck: { ...distinctCheck, recovery: true,
        result: 'SOURCE_CONFIRMED_TRANSIENT_RECOVERY' }, confidence: 'MEDIUM', evaluatedAt,
      reasoning: 'AppDynamics source evidence confirms a transient condition and explicit recovery, with no sustained degradation, escalation, new entity, or distinct operator action.',
    });
  }

  if (!baseBlocked && nonActionable && recovered && !operatorAction && !distinctBlocked
    && !item.repeatedRecovery && item.notificationRole === 'REPRESENTATIVE') {
    return makeProof({ item, representative, rule: config.rules.nonActionableSourceConditionNoise,
      subtype: 'NON_ACTIONABLE_SOURCE_CONDITION', relationship, distinctCheck: { ...distinctCheck, recovery: true,
        result: 'SOURCE_CONFIRMED_NON_ACTIONABLE_RECOVERY' }, confidence: 'MEDIUM', evaluatedAt,
      reasoning: 'Positive AppDynamics source evidence identifies a recovered non-actionable condition, with no escalation, new entity, or distinct operator action.',
    });
  }

  return null;
}

module.exports = {
  NOISE_SUBTYPES,
  distinctInformationCheck,
  evaluatePositiveNoiseProof,
  identityFor,
  relationshipFor,
};
