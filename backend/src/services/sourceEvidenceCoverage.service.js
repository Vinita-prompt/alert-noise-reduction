const RESOLUTION_STATUSES = Object.freeze([
  'RESOLVED',
  'UNRESOLVED',
  'API_UNAVAILABLE',
  'AUTH_FAILED',
  'FORBIDDEN',
  'NOT_FOUND',
  'TIMEOUT',
  'INVALID_RESPONSE',
  'CERTIFICATE_ERROR',
]);

const SOURCE_FAILURES = Object.freeze({
  AppDynamics: 'APPDYNAMICS_ALERT_UNRESOLVED',
  Grafana: 'GRAFANA_ALERT_UNRESOLVED',
  Nagios: 'NAGIOS_ALERT_UNRESOLVED',
  ThousandEyes: 'THOUSANDEYES_ALERT_UNRESOLVED',
});

function text(value) {
  return String(value ?? '').trim();
}

function first(values = []) {
  return values.find((value) => value !== null && value !== undefined && value !== '') ?? null;
}

function iso(value) {
  const parsed = value ? new Date(value) : null;
  return parsed && !Number.isNaN(parsed.getTime()) ? parsed.toISOString() : null;
}

function unique(values) {
  return [...new Set((values || []).filter(Boolean).map((value) => text(value)).filter(Boolean))];
}

function latestTimestamp(records) {
  return (records || []).map((item) => iso(item?.timestamp)).filter(Boolean)
    .sort((left, right) => new Date(right).getTime() - new Date(left).getTime())[0] || null;
}

function timestampInsideWindow(value, window) {
  const timestamp = value ? new Date(value).getTime() : Number.NaN;
  const from = window?.from ? new Date(window.from).getTime() : Number.NaN;
  const to = window?.to ? new Date(window.to).getTime() : Number.NaN;
  if (![timestamp, from, to].every(Number.isFinite)) return null;
  return timestamp >= from && timestamp <= to;
}

function canonicalSource(value) {
  const normalized = text(value).toLowerCase().replace(/[\s_-]+/g, '');
  if (['appdynamics', 'appd'].includes(normalized)) return 'AppDynamics';
  if (normalized === 'grafana') return 'Grafana';
  if (['nagios', 'nagiosxi', 'nagiosxiv2'].includes(normalized)) return 'Nagios';
  if (normalized === 'thousandeyes') return 'ThousandEyes';
  return null;
}

function failureStatus(value) {
  const reason = text(value).toUpperCase();
  if (/AUTHENTICATION|INVALID_AUTH|\b401\b/.test(reason)) return 'AUTH_FAILED';
  if (/FORBIDDEN|MISSING_SCOPE|\b403\b/.test(reason)) return 'FORBIDDEN';
  if (/CERTIFICATE|TLS|SELF.SIGNED/.test(reason)) return 'CERTIFICATE_ERROR';
  if (/TIMEOUT|TIMED OUT|ABORT/.test(reason)) return 'TIMEOUT';
  if (/NOT_FOUND|\b404\b/.test(reason)) return 'NOT_FOUND';
  if (/INVALID_RESPONSE|MALFORMED|PARSE/.test(reason)) return 'INVALID_RESPONSE';
  if (/SOURCE_ERROR|SOURCE_CIRCUIT_OPEN|UNAVAILABLE|NOT_CONFIGURED|DNS|ENOTFOUND|ECONN/.test(reason)) return 'API_UNAVAILABLE';
  return 'UNRESOLVED';
}

function sourceAlertId(source, technicalEvidence, records, mapping) {
  const metadata = records.map((item) => item?.metadata || {});
  if (source === 'AppDynamics') return first([
    ...metadata.map((item) => item.eventId || item.violationId),
    mapping?.metadata?.sourceAlertId,
    technicalEvidence?.sourceAlertId && String(technicalEvidence.sourceAlertId) !== String(mapping?.metadata?.applicationId || mapping?.sourceEntityId || '')
      ? technicalEvidence.sourceAlertId : null,
  ]);
  if (source === 'Grafana') return first([
    ...metadata.map((item) => item.ruleUid),
    mapping?.metadata?.ruleUid,
  ]);
  if (source === 'Nagios') return first([
    ...metadata.map((item) => item.objectId || item.serviceId || item.hostId),
    mapping?.sourceEntityId,
    technicalEvidence?.sourceAlertId,
  ]);
  if (source === 'ThousandEyes') return first([
    ...metadata.map((item) => item.alertId),
    mapping?.metadata?.alertId,
    technicalEvidence?.sourceAlertId,
  ]);
  return technicalEvidence?.sourceAlertId || null;
}

function fieldInventory(source, technicalEvidence, primary, mapping) {
  const records = primary?.evidence || technicalEvidence?.sourceSpecificEvidence || [];
  const metadata = records.map((item) => item?.metadata || {});
  const diagnosticMapping = mapping || primary?.identityMapping || null;
  const nagiosCurrentRecord = source === 'Nagios'
    ? records.find((item) => item?.type === 'nagios_current_status')
    : null;
  const nagiosOccurrenceRecords = source === 'Nagios'
    ? records.filter((item) => ['nagios_historical_occurrence', 'nagios_lifecycle'].includes(item?.type) && item?.metadata?.matchWindow === true)
    : [];
  const nagiosOccurrenceRecord = nagiosOccurrenceRecords.find((item) => item?.type === 'nagios_historical_occurrence')
    || nagiosOccurrenceRecords[0] || null;
  const occurrenceRecords = source === 'Grafana'
    ? records.filter((item) => ['grafana_alert_state_history', 'grafana_active_alert', 'grafana_telemetry'].includes(item?.type))
    : records;
  const grafanaStateRecord = source === 'Grafana'
    ? occurrenceRecords.find((item) => item?.type === 'grafana_alert_state_history')
      || occurrenceRecords.find((item) => item?.type === 'grafana_active_alert')
    : null;
  const timestamp = source === 'Grafana'
    ? iso(grafanaStateRecord?.metadata?.stateObservedAt || grafanaStateRecord?.timestamp)
      || latestTimestamp(occurrenceRecords)
    : source === 'Nagios'
      ? latestTimestamp(nagiosOccurrenceRecords)
      : latestTimestamp(occurrenceRecords) || iso(technicalEvidence?.timestamp);
  const common = {
    timestamp,
    sourceAlertId: sourceAlertId(source, technicalEvidence, records, mapping),
  };

  if (source === 'AppDynamics') return {
    ...common,
    applicationId: first([...metadata.map((item) => item.applicationId), mapping?.metadata?.applicationId, mapping?.sourceEntityId]),
    application: first([...metadata.map((item) => item.applicationName), technicalEvidence?.application, mapping?.sourceEntityName]),
    tierId: first(metadata.map((item) => item.tierId)),
    tier: first(metadata.map((item) => item.tier || item.tierName)),
    nodeId: first(metadata.map((item) => item.nodeId)),
    node: first(metadata.map((item) => item.node || item.nodeName)),
    businessTransactionId: first(metadata.map((item) => item.businessTransactionId)),
    businessTransaction: first(metadata.map((item) => item.businessTransaction || item.businessTransactionName)),
    healthRuleId: first(metadata.map((item) => item.healthRuleId)),
    healthRule: first(metadata.map((item) => item.healthRule || item.healthRuleName)),
    policyId: first(metadata.map((item) => item.policyId)),
    policy: first(metadata.map((item) => item.policy || item.policyName)),
    eventId: first([...metadata.map((item) => item.eventId), mapping?.metadata?.eventId, mapping?.metadata?.sourceAlertId]),
    violationId: first([...metadata.map((item) => item.violationId), mapping?.metadata?.violationId]),
    eventType: first(metadata.map((item) => item.eventType)),
    evidenceType: first(metadata.map((item) => item.evidenceType)) || (records.some((item) => /telemetry/i.test(item?.type || '')) ? 'METRIC' : null),
    occurrenceState: first(metadata.map((item) => item.occurrenceState || item.state || item.status || item.eventType)),
    currentState: first(metadata.map((item) => item.currentState)),
    state: first(metadata.map((item) => item.occurrenceState || item.state || item.status || item.eventType)),
    metric: first(metadata.map((item) => item.metric || item.metricName)),
    metricValue: first(metadata.map((item) => item.value)),
    metricOrEvent: first(records.map((item) => item?.metadata?.metric || item?.metadata?.healthRule || item?.metadata?.eventId || (/event/i.test(item?.type || '') ? item?.title : null))),
    deepLink: first([records.find((item) => item?.url)?.url, mapping?.metadata?.deepLink, technicalEvidence?.deepLink]),
    sourceProvenance: first(metadata.map((item) => item.sourceProvenance)),
  };
  if (source === 'Grafana') return {
    ...common,
    grafanaAlerting: first(metadata.map((item) => item.grafanaAlerting)),
    grafanaIrm: first(metadata.map((item) => item.grafanaIrm)),
    grafanaAlertingResolved: Boolean(first(metadata.map((item) => item.grafanaAlertingResolved))
      || (first(metadata.map((item) => item.ruleUid)) && grafanaStateRecord)),
    grafanaRuleResolved: Boolean(first(metadata.map((item) => item.grafanaRuleResolved))
      || first(metadata.map((item) => item.ruleUid))),
    grafanaHistoryResolved: Boolean(first(metadata.map((item) => item.grafanaHistoryResolved))
      || records.some((item) => item?.type === 'grafana_alert_state_history' && item?.metadata?.matchWindow === true)),
    grafanaIrmResolved: Boolean(first(metadata.map((item) => item.grafanaIrmResolved))),
    grafanaDashboardResolved: Boolean(first(metadata.map((item) => item.grafanaDashboardResolved))
      || (first(metadata.map((item) => item.dashboardUid)) && first(metadata.map((item) => item.dashboardTitle)))),
    grafanaPanelEvidence: Boolean(first(metadata.map((item) => item.grafanaPanelEvidence))
      || records.some((item) => item?.type === 'grafana_telemetry'
        && item?.metadata?.matchWindow === true && Number(item?.metadata?.pointCount || 0) > 0)),
    instance: first([...metadata.map((item) => item.sourceHost), primary?.query?.requestedHost,
      primary?.query?.sourceHost, diagnosticMapping?.metadata?.sourceHost]),
    integrationHost: first([...metadata.map((item) => item.integrationHost), diagnosticMapping?.metadata?.integrationHost]),
    instanceDisposition: first([...metadata.map((item) => item.instanceDisposition), primary?.query?.instanceDisposition]),
    ruleUid: first([...metadata.map((item) => item.ruleUid), diagnosticMapping?.metadata?.ruleUid]),
    ruleName: first([...metadata.map((item) => item.ruleName), ...records.map((item) => item?.title), diagnosticMapping?.sourceEntityName]),
    ruleGroup: first(metadata.map((item) => item.ruleGroup)),
    state: first(metadata.map((item) => item.state)),
    stateObservedAt: first(metadata.map((item) => item.stateObservedAt)) || timestamp,
    stateSource: first(metadata.map((item) => item.stateSource)),
    dashboardUid: first([...metadata.map((item) => item.dashboardUid), diagnosticMapping?.metadata?.dashboardUid]),
    dashboardTitle: first([...metadata.map((item) => item.dashboardTitle), diagnosticMapping?.metadata?.dashboardTitle]),
    dashboardDeepLink: first(metadata.map((item) => item.dashboardDeepLink)),
    panelId: first([...metadata.map((item) => item.panelId), diagnosticMapping?.metadata?.panelId]),
    panelTitle: first([...metadata.map((item) => item.panelTitle), diagnosticMapping?.metadata?.panelTitle]),
    panelDeepLink: first(metadata.map((item) => item.panelDeepLink)),
    folder: first([...metadata.map((item) => item.folder), mapping?.metadata?.folder]),
    datasource: first(metadata.map((item) => item.datasource || item.datasources)),
    metric: first(metadata.map((item) => item.metric)),
    value: first(metadata.map((item) => item.value)),
    valueAtOccurrence: first(metadata.map((item) => item.valueAtOccurrence))
      ?? first(metadata.map((item) => item.value)),
    threshold: first(metadata.map((item) => item.threshold)),
    condition: first(metadata.map((item) => item.condition)),
    peak: first(metadata.map((item) => item.peak)),
    minimum: first(metadata.map((item) => item.minimum)),
    timeAboveThresholdSeconds: first(metadata.map((item) => item.timeAboveThresholdSeconds)),
    recovered: first(metadata.map((item) => item.recovered)),
    recoveredAt: first(metadata.map((item) => item.recoveredAt)),
    persistenceSeconds: first(metadata.map((item) => item.persistenceSeconds)),
    noDataObserved: first(metadata.map((item) => item.noDataObserved)),
    metricWindowStart: first(metadata.map((item) => item.metricWindowStart)),
    metricWindowEnd: first(metadata.map((item) => item.metricWindowEnd)),
    evaluationResult: first(metadata.map((item) => item.evaluationResult)),
    evaluationEvidence: first(records.map((item) => item?.metadata?.value ?? item?.metadata?.threshold
      ?? item?.metadata?.evaluationResult ?? item?.metadata?.condition ?? (/telemetry/i.test(item?.type || '') ? item?.summary : null))),
    metricQueryEvidence: records.some((item) => item?.type === 'grafana_telemetry'
      && item?.metadata?.matchWindow === true && Number(item?.metadata?.pointCount || 0) > 0),
    labels: first(metadata.map((item) => item.labels)),
    annotations: first(metadata.map((item) => item.annotations)),
    queryReferences: first(metadata.map((item) => item.queryReferences)),
    sourceProvenance: first(metadata.map((item) => item.sourceProvenance)),
    deepLink: first([metadata.map((item) => item.ruleDeepLink).find(Boolean), records.find((item) => item?.url)?.url, mapping?.metadata?.deepLink, technicalEvidence?.deepLink]),
  };
  if (source === 'Nagios') return {
    ...common,
    host: first([...metadata.map((item) => item.host), mapping?.metadata?.host]),
    service: first([...metadata.map((item) => item.service), mapping?.metadata?.service]),
    currentSourceRecord: Boolean(nagiosCurrentRecord),
    sourceEntityType: first([nagiosOccurrenceRecord?.metadata?.sourceEntityType,
      nagiosCurrentRecord?.metadata?.sourceEntityType]),
    state: first([nagiosOccurrenceRecord?.metadata?.occurrenceState,
      nagiosOccurrenceRecord?.metadata?.status]),
    occurrenceState: first([nagiosOccurrenceRecord?.metadata?.occurrenceState,
      nagiosOccurrenceRecord?.metadata?.status]),
    currentState: first([nagiosCurrentRecord?.metadata?.currentState]),
    currentStatus: first([nagiosCurrentRecord?.metadata?.status]),
    stateType: first([nagiosOccurrenceRecord?.metadata?.stateType]),
    pluginOutput: first([nagiosOccurrenceRecord?.metadata?.pluginOutput]),
    attempts: first([nagiosOccurrenceRecord?.metadata?.attempts]),
    maxAttempts: first([nagiosOccurrenceRecord?.metadata?.maxAttempts]),
    firedAt: iso(nagiosOccurrenceRecord?.metadata?.firedAt
      || nagiosOccurrenceRecord?.metadata?.occurrenceTimestamp),
    lastStateChange: first([nagiosOccurrenceRecord?.metadata?.lastStateTransition,
      nagiosOccurrenceRecord?.timestamp]),
    acknowledged: nagiosOccurrenceRecord?.metadata?.acknowledged ?? null,
    acknowledgementAt: iso(nagiosOccurrenceRecord?.metadata?.acknowledgementAt),
    notificationState: nagiosOccurrenceRecord?.metadata?.notificationState ?? null,
    notificationAt: iso(nagiosOccurrenceRecord?.metadata?.notificationAt),
    notificationType: first([nagiosOccurrenceRecord?.metadata?.notificationType]),
    notificationAlertState: first([nagiosOccurrenceRecord?.metadata?.notificationAlertState]),
    recoveryState: first([nagiosOccurrenceRecord?.metadata?.recoveryState]),
    recoveryAt: iso(nagiosOccurrenceRecord?.metadata?.recoveryAt),
    recovered: nagiosOccurrenceRecord?.metadata?.recovered ?? null,
    recoveredAutomatically: nagiosOccurrenceRecord?.metadata?.recoveredAutomatically ?? null,
    durationSeconds: first([nagiosOccurrenceRecord?.metadata?.durationSeconds]),
    flapping: nagiosOccurrenceRecord?.metadata?.flapping ?? null,
    stateTransitionCount: first([nagiosOccurrenceRecord?.metadata?.stateTransitionCount]),
    stateHistory: nagiosOccurrenceRecord?.metadata?.stateHistory || null,
    historicalMappingMethod: first([nagiosOccurrenceRecord?.metadata?.historicalMappingMethod]),
    historicalMappingEvidence: nagiosOccurrenceRecord?.metadata?.historicalMappingEvidence || null,
    historicalMappingConfidence: first([nagiosOccurrenceRecord?.metadata?.historicalMappingConfidence]),
    currentStatusObservedAt: iso(nagiosCurrentRecord?.metadata?.currentStatusObservedAt || nagiosCurrentRecord?.timestamp),
    sourceFetchedAt: iso(nagiosCurrentRecord?.metadata?.sourceFetchedAt
      || nagiosOccurrenceRecord?.metadata?.sourceFetchedAt
      || nagiosOccurrenceRecord?.metadata?.sourceProvenance?.fetchedAt),
    sourceEventTimestamp: iso(nagiosOccurrenceRecord?.metadata?.occurrenceTimestamp
      || nagiosOccurrenceRecord?.timestamp || timestamp),
    sourceProvenance: nagiosOccurrenceRecord?.metadata?.sourceProvenance || null,
  };
  if (source === 'ThousandEyes') return {
    ...common,
    alertId: first([...metadata.map((item) => item.alertId), mapping?.metadata?.alertId]),
    testId: first([...metadata.map((item) => item.testId), mapping?.metadata?.testId]),
    state: first(metadata.map((item) => item.state)),
    ruleId: first(metadata.map((item) => item.ruleId)),
    agentsOrMetrics: first([
      ...metadata.map((item) => item.agentIds?.length ? item.agentIds.length : null),
      ...metadata.map((item) => item.metric),
    ]),
  };
  return common;
}

function requiredFields(source, fields, mapping) {
  if (source === 'AppDynamics') return [
    ['application', fields.applicationId && fields.application],
    ['sourceAlertOrEventId', fields.sourceAlertId],
    ['state', fields.state],
    ['metricOrHealthRuleEvent', fields.metricOrEvent],
    ['timestamp', fields.timestamp],
  ];
  if (source === 'Grafana') return [
    ['grafanaInstance', fields.instance],
    ['ruleUid', fields.ruleUid],
    ['ruleName', fields.ruleName],
    ['state', fields.state],
    ['timestamp', fields.timestamp],
    ['evaluationOrQueryEvidence', fields.evaluationEvidence],
    ['sourceAlertId', fields.sourceAlertId],
    ['deepLink', fields.deepLink],
    ['sourceProvenance', fields.sourceProvenance],
  ];
  if (source === 'Nagios') return [
    ['host', fields.host],
    ...(mapping?.sourceEntityType === 'SERVICE' || mapping?.metadata?.service ? [['service', fields.service]] : []),
    ['sourceAlertOrEntityId', fields.sourceAlertId],
    ['occurrenceState', fields.occurrenceState],
    ['occurrenceTimestamp', fields.sourceEventTimestamp],
    ['pluginOutput', fields.pluginOutput],
    ['sourceProvenance', fields.sourceProvenance],
  ];
  if (source === 'ThousandEyes') return [
    ['alertId', fields.alertId],
    ['testId', fields.testId],
    ['state', fields.state],
    ['timestamp', fields.timestamp],
    ['agentsOrMetrics', fields.agentsOrMetrics],
  ];
  return [['supportedSource', null]];
}

function mappingMethod(mapping, primary) {
  return first([
    mapping?.reasons?.[0],
    mapping?.mappingMechanism,
    primary?.query?.identityLevel,
    primary?.diagnostics?.mappingState,
  ]);
}

function attemptedPaths(source, primary, mapping) {
  const query = primary?.query || {};
  return unique([
    mapping?.sourceEntityId ? 'accepted_mapping' : null,
    query.applicationId ? 'application_id' : null,
    query.ruleUid ? 'rule_uid' : null,
    query.dashboardUid && query.panelId ? 'dashboard_panel' : null,
    query.composite?.alertName ? 'alert_name_structured_context' : null,
    query.host ? 'host' : null,
    query.service ? 'host_service' : null,
    query.alertId ? 'alert_id' : null,
    query.testId ? 'test_id' : null,
    source ? 'canonical_source' : null,
  ]);
}

function buildSourceEvidenceCoverage({ source, originalSource, technicalEvidence = {}, blocks = [], mappings = [], retrievedAt = new Date().toISOString() }) {
  const canonical = canonicalSource(source);
  const primary = blocks.find((block) => canonicalSource(block?.source) === canonical) || null;
  const mapping = mappings.find((item) => canonicalSource(item?.source) === canonical
    && ['EXACT', 'STRONG', 'CONFIRMED_LOCAL'].includes(String(item?.level || '').toUpperCase())
    && item?.rejected !== true && item?.usableForSourceValidation !== false)
    || (['EXACT', 'STRONG', 'CONFIRMED_LOCAL'].includes(String(primary?.identityMapping?.level || '').toUpperCase())
      && primary?.identityMapping?.usableForSourceValidation !== false ? primary.identityMapping : null);
  const storedStatus = technicalEvidence?.provenance?.primaryStatus;
  const working = primary ? primary.status === 'working' : storedStatus === 'working';
  const failureReason = first([
    primary?.failureReason,
    technicalEvidence?.provenance?.primaryFailureReason,
    canonical ? null : 'UNSUPPORTED_OR_UNRESOLVED_MONITORING_SOURCE',
  ]);
  const acceptedMapping = Boolean(mapping && ['EXACT', 'STRONG', 'CONFIRMED_LOCAL'].includes(String(mapping.level || '').toUpperCase())
    && mapping.rejected !== true);
  const queryFailureStatus = failureStatus(failureReason);
  const status = working || (canonical === 'Grafana' && acceptedMapping) ? 'RESOLVED' : queryFailureStatus;
  const fields = fieldInventory(canonical, technicalEvidence, primary, mapping);
  const required = requiredFields(canonical, fields, mapping);
  const missingFields = required.filter(([, value]) => value === null || value === undefined || value === '').map(([name]) => name);
  const sourceEventTime = iso(fields.timestamp);
  const queryWindow = primary?.queryWindow || null;
  const matchedTimestampEvidence = (primary?.evidence || []).some((item) => item?.metadata?.matchWindow === true);
  const timestampAcceptable = queryWindow
    ? matchedTimestampEvidence || timestampInsideWindow(sourceEventTime, queryWindow) === true
    : Boolean(sourceEventTime);
  if (sourceEventTime && !timestampAcceptable) missingFields.push('timestampInEvaluationWindow');
  const evidenceAsOf = iso(retrievedAt) || new Date().toISOString();
  const freshnessSeconds = sourceEventTime ? Math.max(0, Math.round((new Date(evidenceAsOf).getTime() - new Date(sourceEventTime).getTime()) / 1000)) : null;
  const criticalFailure = ['API_UNAVAILABLE', 'AUTH_FAILED', 'FORBIDDEN', 'NOT_FOUND', 'TIMEOUT', 'INVALID_RESPONSE', 'CERTIFICATE_ERROR'].includes(queryFailureStatus)
    && !(canonical === 'Nagios' && queryFailureStatus === 'NOT_FOUND');
  const complete = status === 'RESOLVED' && working && !criticalFailure && missingFields.length === 0;
  const sourceId = status === 'RESOLVED'
    ? fields.sourceAlertId || fields.alertId || fields.ruleUid || mapping?.sourceEntityId || null
    : fields.sourceAlertId || fields.alertId || fields.ruleUid || null;
  const exactFailure = status === 'UNRESOLVED' ? SOURCE_FAILURES[canonical] || 'SOURCE_ALERT_UNRESOLVED' : failureReason;
  const provenance = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== null && value !== undefined && value !== '').map(([field]) => [field, {
    source: canonical,
    evidenceId: primary?.evidence?.find((item) => item?.metadata?.[field] !== undefined)?.id || primary?.evidence?.[0]?.id || null,
    retrievedAt: evidenceAsOf,
    method: mappingMethod(mapping, primary) || 'normalized_source_evidence',
  }]));
  const deepLink = first([
    fields.deepLink,
    primary?.evidence?.find((item) => item?.url)?.url,
    technicalEvidence?.deepLink,
  ]);

  return {
    sourceResolution: {
      status,
      originalSource: text(originalSource || source) || null,
      canonicalSource: canonical,
      sourceAlertId: sourceId,
      sourceEntityId: mapping?.sourceEntityId || first(primary?.evidence?.map((item) => item?.entity)) || null,
      sourceObjectType: fields.sourceEntityType || mapping?.sourceEntityType || null,
      mappingMethod: mappingMethod(mapping, primary),
      mappingConfidence: mapping?.confidence ?? mapping?.score ?? null,
      attemptedPaths: attemptedPaths(canonical, primary, mapping),
      deepLink,
      failureReason: exactFailure || null,
      reviewCategory: status === 'UNRESOLVED' && attemptedPaths(canonical, primary, mapping).length <= 1
        ? 'MISSING_SOURCE_METADATA' : status === 'UNRESOLVED' ? 'GENUINE_AMBIGUITY' : null,
    },
    evidenceCompleteness: {
      status: complete ? 'COMPLETE' : working ? 'PARTIAL' : criticalFailure ? 'SOURCE_API_UNAVAILABLE' : 'MISSING',
      complete,
      requiredFields: required.map(([name]) => name),
      missingFields,
      presentFields: required.filter(([, value]) => value !== null && value !== undefined && value !== '').map(([name]) => name),
      fields,
      retrievedAt: evidenceAsOf,
      sourceEventTime,
      timestampAcceptable,
      queryWindow,
      evidenceAsOf,
      freshnessSeconds,
      provenance,
    },
    evaluability: {
      status: complete && !criticalFailure && Boolean(sourceEventTime) ? 'EVALUABLE' : 'NOT_EVALUABLE',
      evaluable: complete && !criticalFailure && Boolean(sourceEventTime),
      reason: complete && !criticalFailure && sourceEventTime
        ? 'Source identity and required technical evidence are complete.'
        : criticalFailure ? `Source API evidence is unavailable: ${exactFailure || status}.`
          : status !== 'RESOLVED' ? `Source alert is unresolved: ${exactFailure || status}.`
            : `Required technical evidence is missing: ${missingFields.join(', ') || 'unknown fields'}.`,
    },
    readOnly: true,
  };
}

function coverageFromStored(source, technicalEvidence = {}, adapterDiagnostics = [], originalSource = null) {
  if (technicalEvidence.coverage?.sourceResolution) return technicalEvidence.coverage;
  const primaryDiagnostic = (adapterDiagnostics || []).find((item) => canonicalSource(item?.source) === canonicalSource(source));
  const syntheticBlock = primaryDiagnostic ? {
    ...primaryDiagnostic,
    evidence: technicalEvidence.sourceSpecificEvidence || [],
    identityMapping: null,
  } : null;
  return buildSourceEvidenceCoverage({
    source,
    originalSource,
    technicalEvidence,
    blocks: syntheticBlock ? [syntheticBlock] : [],
    mappings: [],
    retrievedAt: technicalEvidence?.provenance?.retrievedAt || technicalEvidence?.evidenceAsOf || new Date().toISOString(),
  });
}

module.exports = {
  RESOLUTION_STATUSES,
  SOURCE_FAILURES,
  buildSourceEvidenceCoverage,
  canonicalSource,
  coverageFromStored,
  failureStatus,
};
