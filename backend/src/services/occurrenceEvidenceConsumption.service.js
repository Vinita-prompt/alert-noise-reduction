const EXACT_MAPPING = Object.freeze({
  AppDynamics: new Set(['EXACT_OCCURRENCE_RESOLVED']),
  Grafana: new Set(['EXACT_OCCURRENCE_RESOLVED']),
  Nagios: new Set(['EXACT_OCCURRENCE_RECOVERED', 'EXACT_OCCURRENCE_RESOLVED']),
});

const TABLES = Object.freeze({
  AppDynamics: 'appdynamics_alert_occurrence_evidence',
  Grafana: 'grafana_alert_occurrence_evidence',
  Nagios: 'nagios_alert_occurrence_evidence',
});

function clean(value) {
  return String(value ?? '').trim();
}

function normalize(value) {
  return clean(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function canonicalSource(value) {
  const candidate = normalize(clean(value).split('|')[0]).replaceAll('-', '');
  if (['appd', 'appdynamics'].includes(candidate)) return 'AppDynamics';
  if (candidate === 'grafana') return 'Grafana';
  if (['nagios', 'nagiosxi', 'nagiosxiv2'].includes(candidate)) return 'Nagios';
  return null;
}

function unique(values) {
  return [...new Set((values || []).filter((value) => value !== undefined && value !== null && clean(value))
    .map((value) => typeof value === 'string' ? clean(value) : value))];
}

function toIso(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function latestTimestamp(values = []) {
  const timestamps = values.map((value) => value ? new Date(value).getTime() : Number.NaN)
    .filter(Number.isFinite);
  return timestamps.length ? new Date(Math.max(...timestamps)).toISOString() : null;
}

function boolean(value) {
  return value === true || clean(value).toLowerCase() === 'true';
}

function field(value, provenance, resolutionMethod, authority = 'AUTHORITATIVE') {
  if (value === undefined || value === null || value === '') return null;
  return {
    value: value instanceof Date ? value.toISOString() : value,
    provenance,
    resolutionMethod,
    confidence: authority === 'AUTHORITATIVE' ? 100 : 95,
    authority,
  };
}

function acceptedPersistedRow(sourceValue, row = {}) {
  const source = canonicalSource(sourceValue);
  if (!source || !EXACT_MAPPING[source]?.has(clean(row.mapping_status).toUpperCase())) return false;
  if (row.source_resolved !== true || !clean(row.source_occurrence_id) || !toIso(row.firing_at)) return false;
  const currentState = clean(row.current_state).toUpperCase();
  if (!['FIRING', 'RECOVERED'].includes(currentState)) return false;
  if (source === 'AppDynamics') {
    return Boolean(clean(row.application_id) && (clean(row.event_id) || clean(row.violation_id)));
  }
  if (source === 'Grafana') {
    return Boolean(clean(row.rule_uid) && clean(row.fingerprint)
      && clean(row.identity_quality).toUpperCase() === 'AUTHORITATIVE');
  }
  return Boolean(clean(row.source_instance) && clean(row.host_name)
    && (clean(row.service_description) || clean(row.object_type).toLowerCase() === 'host'));
}

function identityMatchesAlert(sourceValue, row, alert = {}) {
  const source = canonicalSource(sourceValue);
  if (!acceptedPersistedRow(source, row)) return false;
  // These tables are keyed by the canonical alert ID and are populated only
  // after source-specific exact-occurrence reconciliation. Re-applying broad
  // recursive JSM metadata here can reject a proven occurrence because an
  // integration payload also contains an unrelated application/entity ID.
  // The persisted mapping status and source IDs are the deterministic join.
  void alert;
  return true;
}

function lifecycleHistory(source, row) {
  const evidence = row.evidence && typeof row.evidence === 'object' ? row.evidence : {};
  if (source === 'Grafana') {
    const transitions = Array.isArray(row.transition_sequence) ? row.transition_sequence : [];
    if (transitions.length && typeof transitions[0] === 'object') return transitions;
    return [
      evidence.trigger ? { state: evidence.trigger.state, timestamp: evidence.trigger.timestamp } : null,
      evidence.recovery ? { state: evidence.recovery.state, timestamp: evidence.recovery.timestamp } : null,
    ].filter(Boolean);
  }
  if (source === 'Nagios') return Array.isArray(evidence.stateHistory) ? evidence.stateHistory : [];
  const violationState = clean(evidence.violation?.state).toUpperCase();
  const violationIsTerminal = /RESOLVED|RECOVERED|CANCELLED|ENDED|CLOSE|CLOSED/.test(violationState);
  return [
    evidence.event ? { state: evidence.event.type, timestamp: evidence.event.time } : null,
    evidence.violation && (!violationIsTerminal || !evidence.event)
      ? { state: evidence.violation.state, timestamp: evidence.violation.start } : null,
    evidence.recovery ? { state: evidence.recovery.type, timestamp: evidence.recovery.time } : null,
  ].filter(Boolean);
}

function recoveryIsAuthoritative(source, row) {
  if (clean(row.current_state).toUpperCase() !== 'RECOVERED' || !toIso(row.recovery_at)) return false;
  if (source === 'Grafana' || source === 'Nagios') return row.recovery_authoritative === true;
  return Boolean(clean(row.violation_id) || clean(row.event_id));
}

function occurrenceEvidenceItem(sourceValue, row, options = {}) {
  const source = canonicalSource(sourceValue);
  const trustedObservation = options.trustedObservation === true
    && clean(row.source_occurrence_id) && toIso(row.firing_at)
    && ['FIRING', 'RECOVERED'].includes(clean(row.current_state).toUpperCase());
  if (!trustedObservation && !acceptedPersistedRow(source, row)) return null;
  const evidenceId = `${normalize(source)}-occurrence:${clean(row.source_occurrence_id)}`;
  const recovered = recoveryIsAuthoritative(source, row);
  const history = lifecycleHistory(source, row);
  const appDynamicsOpeningState = source === 'AppDynamics' && recovered
    ? row.evidence?.event?.type || null : null;
  const occurrenceState = appDynamicsOpeningState || row.occurrence_state || 'FIRING';
  const provenance = Array.isArray(row.provenance) ? row.provenance : [];
  return {
    id: evidenceId,
    evidenceId,
    source,
    type: 'authoritative_source_occurrence_lifecycle',
    title: row.health_rule_name || row.policy_name || row.rule_name || row.service_description || row.host_name || null,
    timestamp: toIso(row.firing_at),
    metadata: {
      sourceOccurrenceId: row.source_occurrence_id,
      eventId: row.event_id || null,
      violationId: row.violation_id || null,
      applicationId: row.application_id || null,
      applicationName: row.application_name || null,
      sourceEntityId: row.object_id || row.node_id || row.tier_id || row.business_transaction_id || null,
      ruleUid: row.rule_uid || null,
      fingerprint: row.fingerprint || null,
      labels: row.instance_labels || null,
      instance: row.source_instance || null,
      host: row.host_name || null,
      service: row.service_description || null,
      occurrenceState,
      state: occurrenceState,
      currentState: row.current_state,
      firedAt: toIso(row.firing_at),
      occurrenceTimestamp: toIso(row.firing_at),
      recovered,
      recoveryAt: recovered ? toIso(row.recovery_at) : null,
      recoveryState: recovered ? (source === 'AppDynamics' ? row.occurrence_state || row.evidence?.recovery?.type || 'RECOVERED'
        : source === 'Nagios' ? row.current_source_state || 'OK' : 'NORMAL') : null,
      stateHistory: history,
      stateType: row.occurrence_state_type || row.current_state_type || null,
      pluginOutput: row.plugin_output || null,
      attempts: row.evidence?.occurrence?.attemptCount ?? null,
      acknowledged: row.acknowledged === true,
      downtime: row.downtime === true,
      notificationState: row.notifications_enabled,
      durationSeconds: Number.isFinite(Number(row.persistence_seconds)) ? Number(row.persistence_seconds) : null,
      mappingStatus: row.mapping_status,
      matchMethod: row.match_method || null,
      matchConfidence: row.match_confidence === null || row.match_confidence === undefined
        ? null : Number(row.match_confidence),
      evidenceOrigin: 'PERSISTED_EXACT_OCCURRENCE_EVIDENCE',
      evidenceTable: TABLES[source],
      observedAt: toIso(row.observed_at || row.updated_at),
      provenance,
      readOnly: true,
    },
    url: row.deep_link || null,
  };
}

function occurrenceFields(sourceValue, row) {
  const source = canonicalSource(sourceValue);
  const provenance = `${source} persisted exact occurrence evidence`;
  const method = source === 'Grafana' ? 'exactRuleInstanceOccurrence'
    : source === 'Nagios' ? 'exactInstanceHostServiceOccurrence' : 'exactOccurrenceEvidence';
  return {
    sourceOccurrenceId: field(row.source_occurrence_id, provenance, method),
    eventId: field(row.event_id, provenance, method),
    violationId: field(row.violation_id, provenance, method),
    applicationId: field(row.application_id, provenance, method),
    application: field(row.application_name, provenance, method),
    ruleUid: field(row.rule_uid, provenance, method),
    fingerprint: field(row.fingerprint, provenance, method),
    instance: field(row.source_instance, provenance, method),
    host: field(row.host_name, provenance, method),
    service: field(row.service_description, provenance, method),
    sourceEntityId: field(row.object_id || row.node_id || row.tier_id || row.business_transaction_id,
      provenance, method),
    occurrenceState: field(row.occurrence_state, provenance, method),
    stateType: field(row.occurrence_state_type || row.current_state_type, provenance, method),
    pluginOutput: field(row.plugin_output, provenance, method),
    acknowledged: field(row.acknowledged, provenance, method),
    downtime: field(row.downtime, provenance, method),
    notificationState: field(row.notifications_enabled, provenance, method),
    currentState: field(row.current_state, provenance, method),
    firingAt: field(toIso(row.firing_at), provenance, method),
    recoveryAt: field(recoveryIsAuthoritative(source, row) ? toIso(row.recovery_at) : null, provenance, method),
    sourceDeepLink: field(row.deep_link, provenance, method),
  };
}

function occurrenceObservation(sourceValue, row, alert = {}) {
  const source = canonicalSource(sourceValue);
  const accepted = identityMatchesAlert(source, row, alert);
  const evidence = accepted ? occurrenceEvidenceItem(source, row) : null;
  const persistedStatus = clean(row?.mapping_status).toUpperCase();
  const deterministicIdentityBlocker = ['MULTIPLE_CANDIDATES', 'LABEL_MISMATCH'].includes(persistedStatus);
  return {
    source,
    accepted: Boolean(evidence),
    terminal: Boolean(evidence?.metadata?.recovered),
    row,
    evidence,
    fieldsUsableForIdentity: Boolean(evidence),
    fields: evidence ? occurrenceFields(source, row) : {},
    deterministicIdentityBlocker,
    blocksFreshSourceQuery: Boolean(evidence?.metadata?.recovered) || deterministicIdentityBlocker,
    reason: evidence ? 'EXACT_PERSISTED_OCCURRENCE_ACCEPTED'
      : clean(row?.mapping_status) || 'NO_EXACT_PERSISTED_OCCURRENCE',
  };
}

function occurrenceEvidenceFreshness(observation, evaluatedAt) {
  const row = observation?.row || {};
  const evaluatedAtIso = toIso(evaluatedAt);
  const sourceEvidenceRetrievedAt = toIso(row.observed_at);
  const persistedOccurrenceUpdatedAt = toIso(row.updated_at);
  const lifecycleTerminalAt = observation?.terminal ? toIso(row.recovery_at) : null;
  const latestEvidenceAt = latestTimestamp([
    sourceEvidenceRetrievedAt,
    persistedOccurrenceUpdatedAt,
    lifecycleTerminalAt,
  ]);
  return {
    evaluatedAt: evaluatedAtIso,
    sourceEvidenceRetrievedAt,
    persistedOccurrenceUpdatedAt,
    lifecycleTerminalAt,
    latestEvidenceAt,
    evaluationStale: Boolean(evaluatedAtIso && latestEvidenceAt
      && new Date(latestEvidenceAt).getTime() > new Date(evaluatedAtIso).getTime()),
  };
}

async function loadOccurrenceObservation(database, { alertId, source, alert = {} }) {
  const canonical = canonicalSource(source);
  const table = TABLES[canonical];
  if (!table || !alertId) return occurrenceObservation(canonical, {}, alert);
  const result = await database.query(`SELECT * FROM ${table} WHERE alert_id=$1 LIMIT 1`, [alertId]);
  return occurrenceObservation(canonical, result.rows[0] || {}, alert);
}

function mergeOccurrenceEvidence(blocks, observation) {
  if (!observation?.accepted || !observation.evidence) {
    if (!observation?.deterministicIdentityBlocker || !observation.source) return blocks;
    if (blocks.some((block) => block.source === observation.source)) return blocks;
    return [{
      source: observation.source,
      adapter: `${observation.source.replace(/\s+/g, '')}PersistedOccurrenceEvidence`,
      status: 'not_applicable',
      pipelineState: 'NOT_QUERIED',
      failureReason: observation.reason,
      evidence: [],
      relationships: [],
      recordsReturned: 0,
      matchedRecords: 0,
      readOnly: true,
      query: { persistedDeterministicIdentityBlocker: true, externalRequests: 0 },
    }, ...blocks];
  }
  const source = observation.source;
  const result = [...blocks];
  const index = result.findIndex((block) => block.source === source);
  if (index < 0) {
    result.unshift({
      source,
      adapter: `${source.replace(/\s+/g, '')}PersistedOccurrenceEvidence`,
      status: 'working',
      pipelineState: 'COMPLETE',
      failureReason: null,
      evidence: [observation.evidence],
      relationships: [],
      recordsReturned: 1,
      matchedRecords: 1,
      readOnly: true,
      query: { persistedExactOccurrence: true, externalRequests: 0 },
    });
    return result;
  }
  const block = result[index];
  const evidence = [...(block.evidence || [])];
  if (!evidence.some((item) => item.id === observation.evidence.id)) evidence.push(observation.evidence);
  result[index] = {
    ...block,
    status: 'working',
    pipelineState: 'COMPLETE',
    failureReason: null,
    evidence,
    matchedRecords: Math.max(Number(block.matchedRecords || 0), 1),
    readOnly: true,
    query: { ...(block.query || {}), persistedExactOccurrence: true },
  };
  return result;
}

function observationTechnicalEvidence(row, episode, enrichment) {
  const existing = row.technical_evidence || {};
  const source = canonicalSource(episode.source);
  if (!['AppDynamics', 'Grafana', 'Nagios'].includes(source) || enrichment.fieldsUsableForIdentity === false) return existing;
  const fields = enrichment.fields || {};
  const value = (name) => fields[name]?.value ?? null;
  const syntheticRow = {
    mapping_status: 'EXACT_OCCURRENCE_RESOLVED',
    source_resolved: true,
    source_occurrence_id: value('sourceOccurrenceId'),
    event_id: value('eventId'),
    violation_id: value('violationId'),
    application_id: value('applicationId'),
    application_name: value('application'),
    rule_uid: value('ruleUid'),
    fingerprint: value('fingerprint'),
    identity_quality: 'AUTHORITATIVE',
    source_instance: value('instance'),
    host_name: value('host'),
    service_description: value('service'),
    object_type: value('service') ? 'service' : 'host',
    object_id: value('sourceEntityId'),
    occurrence_state: value('occurrenceState'),
    occurrence_state_type: value('stateType'),
    plugin_output: value('pluginOutput'),
    acknowledged: value('acknowledged'),
    downtime: value('downtime'),
    notifications_enabled: value('notificationState'),
    current_state: value('currentState'),
    firing_at: value('firingAt'),
    recovery_at: value('recoveryAt'),
    recovery_authoritative: Boolean(value('recoveryAt')),
    deep_link: value('sourceDeepLink'),
    observed_at: row.feature_as_of,
  };
  const item = occurrenceEvidenceItem(source, syntheticRow, { trustedObservation: true });
  if (!item) return existing;
  const now = new Date(row.feature_as_of || Date.now()).getTime();
  const start = new Date(item.metadata.firedAt).getTime();
  const recoveredAt = item.metadata.recoveryAt;
  const end = recoveredAt ? new Date(recoveredAt).getTime() : now;
  const durationSeconds = Number.isFinite(start) && Number.isFinite(end) && end >= start
    ? Math.round((end - start) / 1000) : null;
  const recovered = item.metadata.recovered === true;
  const lifecycle = existing.monitoringLifecycle || {};
  const sourceEvidenceIds = unique([...(lifecycle.provenance?.sourceEvidenceIds || []), item.id]);
  const transitions = [
    { state: 'FIRING', timestamp: item.metadata.firedAt, evidenceId: item.id },
    ...(recovered ? [{ state: 'RECOVERED', timestamp: recoveredAt, evidenceId: item.id }] : []),
  ];
  return {
    ...existing,
    provenance: {
      ...(existing.provenance || {}), primaryStatus: 'working', primaryFailureReason: null,
      evidenceIds: unique([...(existing.provenance?.evidenceIds || []), item.id]), readOnly: true,
    },
    coverage: {
      ...(existing.coverage || {}),
      evaluability: { ...(existing.coverage?.evaluability || {}), evaluable: true,
        reason: 'Exact authoritative source occurrence lifecycle evidence is available.' },
    },
    sourceSpecificEvidence: [
      ...(Array.isArray(existing.sourceSpecificEvidence) ? existing.sourceSpecificEvidence : []), item,
    ],
    monitoringLifecycle: {
      ...lifecycle,
      occurrence: {
        ...(lifecycle.occurrence || {}), sourceOccurrenceId: item.metadata.sourceOccurrenceId,
        eventId: item.metadata.eventId, violationId: item.metadata.violationId,
        ruleUid: item.metadata.ruleUid, fingerprint: item.metadata.fingerprint,
        startedAt: item.metadata.firedAt,
      },
      persistence: { ...(lifecycle.persistence || {}), currentlyFiring: !recovered, durationSeconds },
      recovery: { ...(lifecycle.recovery || {}), recovered, recoveredAt: recovered ? recoveredAt : null },
      transitions,
      completeness: { ...(lifecycle.completeness || {}), lifecycleEvidenceAvailable: true, stateHistoryAvailable: true },
      provenance: {
        ...(lifecycle.provenance || {}), sourceEvidenceIds,
        lifecycleSource: source === 'Grafana'
          ? 'Grafana authenticated alert-state-history read-only occurrence reconciliation'
          : source === 'Nagios'
            ? 'Nagios XI exact instance/host/service state-history read-only occurrence reconciliation'
            : 'AppDynamics Controller API read-only occurrence reconciliation',
      },
      signals: unique([
        ...(lifecycle.signals || []), recovered ? 'AUTHORITATIVE_SOURCE_RECOVERY' : 'SOURCE_OCCURRENCE_FIRING',
      ]),
    },
  };
}

module.exports = {
  acceptedPersistedRow,
  canonicalSource,
  identityMatchesAlert,
  loadOccurrenceObservation,
  mergeOccurrenceEvidence,
  observationTechnicalEvidence,
  occurrenceEvidenceFreshness,
  occurrenceEvidenceItem,
  occurrenceFields,
  occurrenceObservation,
  recoveryIsAuthoritative,
};
