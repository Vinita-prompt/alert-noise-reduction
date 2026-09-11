const appDynamicsService = require('./appDynamics.service');
const grafanaService = require('./grafanaDashboard.service');
const nagiosService = require('./nagios.service');
const { workspaceService: thousandEyesService } = require('./thousandEyesWorkspace.service');
const jiraService = require('./atlassian/accJiraRead.service');
const slackStore = require('./slackAlertStore.service');
const { METRIC_CONTRACT, inferredMetricPath, intentFromText } = require('./noiseAppDynamicsTelemetrySemantics.service');
const { evaluateAppDynamicsWorkflowEvidence } = require('./appDynamicsWorkflowEvidence.service');
const { buildMaintenanceNotificationEvidence } = require('./maintenanceNotificationEvidence.service');

const ACCEPTED_MAPPING_LEVELS = new Set(['EXACT', 'STRONG', 'CONFIRMED_LOCAL']);
const PIPELINE_STATES = Object.freeze({
  NOT_QUERIED: 'NOT_QUERIED',
  QUERY_FAILED: 'QUERY_FAILED',
  NO_RECORDS: 'NO_RECORDS',
  RECORDS_FOUND: 'RECORDS_FOUND',
});

function cleanText(value) {
  return String(value ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function canonical(value) {
  return cleanText(value).toLowerCase();
}

function toMs(value) {
  const parsed = value ? new Date(value).getTime() : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function toIso(value) {
  const parsed = toMs(value);
  return parsed === null ? null : new Date(parsed).toISOString();
}

function unique(values) {
  return [...new Set(values.filter(Boolean).map(cleanText).filter(Boolean))];
}

function safeUrl(value) {
  if (!value) return null;
  try {
    const parsed = new URL(String(value));
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function safeError(error) {
  return cleanText(error?.safeMessage || error?.code || error?.message || 'SOURCE_QUERY_FAILED')
    .replace(/(?:bearer|basic)\s+[a-z0-9._~+/=-]+/gi, '[REDACTED]')
    .replace(/(token|secret|password|credential|authorization|cookie)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]');
}

function sourceQueryFailureReason(error) {
  const message = safeError(error);
  if (error?.code === 'GRAFANA_SOURCE_INSTANCE_NOT_CONFIGURED') return error.code;
  if (error?.code === 'GRAFANA_STATE_HISTORY_NOT_CONFIGURED') return error.code;
  const status = Number(error?.vendorStatus || error?.responseStatus || error?.status || 0) || null;
  if (status === 401) return 'AUTHENTICATION_FAILED';
  if (status === 403) return 'FORBIDDEN';
  if (status === 404) return 'NOT_FOUND';
  if (status === 408 || status === 504 || /timeout|timed out|abort/i.test(message)) return 'SOURCE_TIMEOUT';
  if (/certificate|self signed|unable to verify|tls/i.test(message)) return 'CERTIFICATE_ERROR';
  if (/enotfound|getaddrinfo|dns|eai_again/i.test(message)) return 'DNS_UNAVAILABLE';
  if (/invalid response|parse|malformed/i.test(message)) return 'INVALID_RESPONSE';
  return 'SOURCE_ERROR';
}

function sourceName(alert) {
  return cleanText(alert?.sourceSystem || alert?.source || alert?.integration?.name || alert?.sourceDetails?.type || 'Unknown');
}

function sourceMetadata(alert = {}) {
  const details = alert.sourceDetails || {};
  const identifiers = alert.sourceIdentifiers || {};
  const extra = alert.extraProperties || {};
  const tags = Array.isArray(alert.tags) ? alert.tags : [];
  const tagValue = (name) => {
    const found = tags.find((tag) => canonical(tag).startsWith(`${canonical(name)}:`));
    return found ? cleanText(found).slice(cleanText(found).indexOf(':') + 1).trim() : null;
  };
  return {
    originalSource: details.originalSource || extra.originalSource || sourceName(alert),
    sourceAlias: details.sourceAlias || extra.sourceAlias || null,
    applicationId: identifiers.applicationId || details.applicationId || extra.applicationId || null,
    appDynamicsApplicationName: details.appDynamicsApplicationName || details.applicationName || extra.appDynamicsApplicationName || null,
    appDynamicsSourceAlertId: identifiers.eventId || details.appDynamicsSourceAlertId || extra.appDynamicsSourceAlertId || null,
    appDynamicsViolationId: details.appDynamicsViolationId || details.violationId || extra.appDynamicsViolationId || extra.violationId || null,
    appDynamicsDeepLink: details.appDynamicsDeepLink || details.deepLink || extra.appDynamicsDeepLink || extra.deepLink || null,
    grafanaRuleUid: identifiers.ruleUid || identifiers.alertRuleUid || details.ruleUid || extra.ruleUid || null,
    grafanaDashboardUid: identifiers.dashboardUid || details.dashboardUid || extra.dashboardUid || null,
    grafanaPanelId: identifiers.panelId || details.panelId || extra.panelId || null,
    grafanaFolder: details.grafanaFolder || details.folder || extra.grafanaFolder || extra.folder || tagValue('grafana_folder') || null,
    grafanaAlertName: details.grafanaAlertName || details.alertName || details.alertname || extra.grafanaAlertName || extra.alertName || extra.alertname || tagValue('alertname') || null,
    grafanaEnvironment: details.grafanaEnvironment || details.environment || extra.grafanaEnvironment || extra.environment || alert.environment || tagValue('environment') || null,
    grafanaInstance: details.grafanaInstance || details.instance || extra.grafanaInstance || extra.instance || tagValue('instance') || null,
    grafanaService: details.grafanaService || details.service || extra.grafanaService || extra.service || alert.service || tagValue('service') || null,
    grafanaTeam: details.grafanaTeam || details.team || extra.grafanaTeam || extra.team || alert.team || tagValue('team') || null,
    grafanaLabels: details.grafanaLabels || details.labels || extra.grafanaLabels || extra.labels || {},
    grafanaAnnotations: details.grafanaAnnotations || details.annotations || extra.grafanaAnnotations || extra.annotations || {},
    grafanaTags: details.tags || extra.tags || alert.tags || [],
    grafanaDeepLink: details.grafanaDeepLink || details.deepLink || extra.grafanaDeepLink || extra.deepLink || null,
    grafanaSourceUrl: details.grafanaSourceUrl || details.sourceUrl || extra.grafanaSourceUrl || extra.sourceUrl || null,
    grafanaSourceHost: details.grafanaSourceHost || extra.grafanaSourceHost || null,
    grafanaDetailReadFailure: details.grafanaDetailReadFailure || extra.grafanaDetailReadFailure || null,
    appDynamicsMetric: details.metric || details.metricName || extra.metric || extra.metricName || null,
    appDynamicsTier: details.tier || details.tierName || extra.tier || extra.tierName || null,
    appDynamicsNode: details.node || details.nodeName || extra.node || extra.nodeName || null,
    appDynamicsHealthRule: details.healthRule || details.healthRuleName || extra.healthRule || extra.healthRuleName || null,
    appDynamicsBusinessTransaction: details.businessTransaction || details.businessTransactionName || extra.businessTransaction || extra.businessTransactionName || null,
    nagiosHost: details.host || identifiers.host || extra.host || null,
    nagiosService: details.service || identifiers.service || extra.service || null,
    nagiosEnvironment: details.instance || details.environment || extra.nagiosEnvironment || null,
    thousandEyesTestId: identifiers.testId || details.testId || extra.testId || null,
    thousandEyesAlertId: identifiers.alertId || details.alertId || extra.alertId || null,
    jiraIssueKeys: unique([...(cleanText(alert.title).match(/\bACC-\d+\b/gi) || []), ...(cleanText(alert.message).match(/\bACC-\d+\b/gi) || [])]).map((key) => key.toUpperCase()),
    slackMessageId: alert.slackMessageId || details.slackMessageId || null,
  };
}

function normalizeOperationsAlert(alert = {}, identity = null) {
  return {
    occurrenceId: String(alert.id || alert.canonicalOperationsId || alert.externalId || ''),
    operationsAlertId: String(alert.id || alert.canonicalOperationsId || ''),
    alertNumber: cleanText(alert.tinyId || alert.alertNumber) || null,
    source: sourceName(alert),
    alertName: cleanText(alert.title || alert.name) || null,
    message: cleanText(alert.message || alert.description) || null,
    canonicalEntity: identity?.canonicalEntity?.canonicalName || alert.service || alert.application || alert.sourceDetails?.host || null,
    service: alert.service || null,
    application: alert.application || null,
    environment: alert.environment || null,
    priority: alert.priority || null,
    severity: alert.severity || alert.monitoringSeverity || null,
    createdAt: toIso(alert.createdAt || alert.firstOccurredAt),
    updatedAt: toIso(alert.updatedAt),
    lastOccurrence: toIso(alert.lastOccurredAt || alert.updatedAt || alert.createdAt),
    sourceMetadata: sourceMetadata(alert),
  };
}

function normalizeWindow(window = {}) {
  const from = toIso(window.from || window.before?.from || window.activeFrom || window.during?.from);
  const to = toIso(window.to || window.after?.to || window.activeTo || window.during?.to);
  return { from, to, beforeMinutes: Number(window.beforeMinutes ?? 5), afterMinutes: Number(window.afterMinutes ?? 10) };
}

function withinWindow(timestamp, window) {
  const value = toMs(timestamp);
  const from = toMs(window.from);
  const to = toMs(window.to);
  return value !== null && from !== null && to !== null && value >= from && value <= to;
}

function evidenceItem(item = {}, window) {
  const timestamp = toIso(item.timestamp);
  const normalized = {
    id: String(item.id || `${item.source || 'source'}:${item.type || 'record'}:${timestamp || item.title || 'unknown'}`),
    source: item.source,
    type: item.type || 'monitoring_record',
    timestamp,
    title: cleanText(item.title) || 'Source evidence',
    summary: cleanText(item.summary) || null,
    severity: cleanText(item.severity) || null,
    entity: cleanText(item.entity) || null,
    url: safeUrl(item.url),
    correlationKey: cleanText(item.correlationKey) || null,
    confidence: item.confidence || 'Medium',
    metadata: {
      ...(item.metadata || {}),
      matchWindow: timestamp ? withinWindow(timestamp, window) : false,
      queryWindow: { from: window.from, to: window.to },
      retrievalStatus: 'READ_ONLY_SUCCESS',
    },
  };
  const semantics = operationalRecordSemantics(normalized.source, normalized);
  normalized.metadata.operationalState = semantics.active
    ? 'ACTIVE' : semantics.recovered ? 'RECOVERED' : 'UNKNOWN';
  normalized.metadata.authoritative = semantics.authoritative;
  normalized.metadata.recoveryObserved = semantics.recovered;
  return normalized;
}

function relationship(item, mapping, extraReasons = []) {
  const accepted = mapping && ACCEPTED_MAPPING_LEVELS.has(String(mapping.level).toUpperCase()) && mapping.rejected !== true;
  return {
    evidenceId: item.id,
    source: item.source,
    confidence: accepted ? (mapping.level === 'STRONG' ? 'Medium' : 'High') : 'Low',
    score: accepted ? Number(mapping.confidence || mapping.score || (mapping.level === 'STRONG' ? 78 : 92)) : 20,
    relationship: accepted ? 'confirmed' : 'candidate',
    evidence: unique([...(mapping?.reasons || []), ...extraReasons]),
  };
}

function mappingFor(mappings = [], source) {
  return mappings.find((mapping) => canonical(mapping.source) === canonical(source)
    && ACCEPTED_MAPPING_LEVELS.has(String(mapping.level || '').toUpperCase())
    && mapping.rejected !== true
    && mapping.usableForSourceValidation !== false) || null;
}

// Source-specific proof semantics stay at the adapter boundary. The common
// decision engine consumes only the normalized active/recovered/authoritative
// flags and never imports vendor-specific field rules.
function operationalRecordSemantics(source, record) {
  const text = canonical([record?.type, record?.title, record?.summary, record?.severity,
    record?.metadata?.state, record?.metadata?.healthRule].filter(Boolean).join(' '));
  const contradictoryActive = /still (?:critical|down|firing|violat)|continues? to violat/.test(text);
  const recovered = !contradictoryActive && /recover|resolved|cleared|normal|\bok\b|\bup\b|closed/.test(text);
  const active = !recovered && /critical|\bdown\b|unreachable|trigger|firing|alerting|violation|degrad|problem|failure|failed|error/.test(text);
  let authoritative = false;
  if (source === 'AppDynamics') authoritative = Boolean(record?.metadata?.healthRule && active);
  else if (source === 'Grafana') authoritative = Boolean(record?.metadata?.ruleUid && /firing|alerting|trigger|critical|violation/.test(text));
  else if (source === 'Nagios') authoritative = Boolean((record?.metadata?.host || record?.entity) && /critical|\bdown\b|unreachable/.test(text));
  else if (source === 'ThousandEyes') authoritative = Boolean((record?.metadata?.alertId || record?.metadata?.testId)
    && /trigger|active|critical|failure|failed/.test(text));
  return { active, authoritative, recovered };
}

function appDynamicsWorkflowEvidence(input) {
  return evaluateAppDynamicsWorkflowEvidence(input);
}

function adapterResult({ source, adapter, mapping = null, records = [], evidence = [], relationships = [], failureReason = null, startedAt, queryWindow, lifecycle = [], query = null }) {
  const returnedCount = records.length;
  const matchedCount = evidence.length;
  const expectedAbsenceReasons = new Set([
    'NO_TELEMETRY_FOR_WINDOW',
    'TELEMETRY_OUTSIDE_WINDOW',
    'NO_MATCHING_RECORDS',
    'NO_CONFIRMED_JIRA_RELATIONSHIP',
    'NO_RELEVANT_SLACK_CONTEXT',
    'SLACK_CONTEXT_OUTSIDE_WINDOW',
    'NO_RECORDS_IN_WINDOW',
    'CURRENT_DATA_ONLY',
    'UNSUPPORTED_HISTORICAL_QUERY',
    'TIMESTAMP_MISMATCH',
    'CURRENT_SOURCE_ENTITY_NOT_FOUND',
    'HISTORICAL_OCCURRENCE_NOT_FOUND',
    'GRAFANA_STATE_HISTORY_NO_OCCURRENCE_MATCH',
  ]);
  const unresolvedIdentity = /_ALERT_UNRESOLVED$/.test(String(failureReason || ''));
  const pipelineState = failureReason === 'NO_ACCEPTED_SOURCE_MAPPING' || unresolvedIdentity || failureReason === 'SOURCE_NOT_APPLICABLE' || failureReason === 'NOT_QUERY_ELIGIBLE'
    || failureReason === 'NO_EXACT_ALERT_NUMBER'
    ? PIPELINE_STATES.NOT_QUERIED
    : failureReason && !expectedAbsenceReasons.has(failureReason)
      ? PIPELINE_STATES.QUERY_FAILED
      : returnedCount > 0 ? PIPELINE_STATES.RECORDS_FOUND : PIPELINE_STATES.NO_RECORDS;
  const status = pipelineState === PIPELINE_STATES.NOT_QUERIED ? 'not_applicable'
    : pipelineState === PIPELINE_STATES.QUERY_FAILED ? 'error'
      : matchedCount ? 'working' : 'no_evidence';
  const resolutionStatus = status === 'working' ? 'RESOLVED'
    : /AUTHENTICATION|INVALID_AUTH|\b401\b/i.test(failureReason || '') ? 'AUTH_FAILED'
      : /FORBIDDEN|MISSING_SCOPE|\b403\b/i.test(failureReason || '') ? 'FORBIDDEN'
        : /CERTIFICATE|TLS|SELF.SIGNED/i.test(failureReason || '') ? 'CERTIFICATE_ERROR'
          : /TIMEOUT|TIMED OUT|ABORT/i.test(failureReason || '') ? 'TIMEOUT'
            : /NOT_FOUND|\b404\b/i.test(failureReason || '') ? 'NOT_FOUND'
              : /SOURCE_ERROR|SOURCE_CIRCUIT_OPEN|UNAVAILABLE|DNS|ENOTFOUND|ECONN/i.test(failureReason || '') ? 'API_UNAVAILABLE'
                : 'UNRESOLVED';
  const deepLink = evidence.find((item) => item.url)?.url || null;
  return {
    source,
    adapter,
    status,
    evidence,
    relationships,
    lifecycle,
    recordsReturned: returnedCount,
    matchedRecords: matchedCount,
    pipelineState,
    evidenceState: matchedCount ? 'RECORDS_FOUND' : pipelineState,
    failureReason,
    identityMapping: mapping,
    bounded: true,
    query,
    queryWindow,
    readOnly: true,
    resolution: {
      status: resolutionStatus,
      source,
      sourceAlertId: mapping?.metadata?.alertId || mapping?.metadata?.ruleUid
        || mapping?.metadata?.sourceAlertId || mapping?.sourceEntityId || null,
      sourceEntityId: mapping?.sourceEntityId || evidence.find((item) => item.entity)?.entity || null,
      sourceObjectType: mapping?.sourceEntityType || null,
      evidence,
      deepLink,
      retrievedAt: new Date().toISOString(),
      provenance: {
        mappingLevel: mapping?.level || null,
        mappingReasons: mapping?.reasons || [],
        queryWindow,
        readOnly: true,
      },
      errors: failureReason ? [failureReason] : [],
    },
    executionTimeMs: Math.max(0, Date.now() - startedAt),
    diagnostics: {
      adapter,
      mappingState: mapping?.level || 'NONE',
      mappingConfidence: mapping?.confidence ?? mapping?.score ?? null,
      queryStartedAt: new Date(startedAt).toISOString(),
      queryCompletedAt: new Date().toISOString(),
      queryWindow,
      returnedCount,
      matchedCount,
      evidenceState: matchedCount ? 'RECORDS_FOUND' : pipelineState,
      failureReason,
    },
  };
}

class BaseEvidenceAdapter {
  constructor(source, service) {
    this.source = source;
    this.service = service;
    this.name = `${source.replace(/\s+/g, '')}EvidenceAdapter`;
  }

  resolveIdentity(_alert, mappings) {
    return mappingFor(mappings, this.source);
  }

  resolveAlert(alert, mappings = []) {
    const mapping = this.resolveIdentity(alert, mappings);
    return {
      status: mapping ? 'RESOLVED' : 'UNRESOLVED',
      source: this.source,
      sourceAlertId: mapping?.metadata?.alertId || mapping?.metadata?.ruleUid || mapping?.metadata?.sourceAlertId || null,
      sourceEntityId: mapping?.sourceEntityId || null,
      sourceObjectType: mapping?.sourceEntityType || null,
      evidence: [],
      deepLink: null,
      retrievedAt: null,
      provenance: { mappingLevel: mapping?.level || null, mappingReasons: mapping?.reasons || [], readOnly: true },
      errors: mapping ? [] : [`${this.source.toUpperCase().replace(/\s+/g, '_')}_ALERT_UNRESOLVED`],
    };
  }

  async getLifecycle() {
    return [];
  }
}

class NagiosEvidenceAdapter extends BaseEvidenceAdapter {
  constructor(service = nagiosService) { super('Nagios', service); }

  async queryEvidence(alert, timeWindow, context = {}) {
    const startedAt = Date.now();
    const mapping = this.resolveIdentity(alert, context.mappings);
    if (!mapping) return adapterResult({ source: this.source, adapter: this.name, failureReason: 'NAGIOS_ALERT_UNRESOLVED', startedAt, queryWindow: timeWindow });
    const host = mapping.metadata?.host || alert.sourceMetadata.nagiosHost || null;
    const serviceName = mapping.metadata?.service || alert.sourceMetadata.nagiosService || null;
    const mappedInstance = canonical(mapping.metadata?.instance || alert.sourceMetadata.nagiosEnvironment);
    const instances = mappedInstance.includes('02') ? ['d02'] : mappedInstance.includes('01') ? ['d01'] : ['d01', 'd02'];
    if (!host && !serviceName) return adapterResult({ source: this.source, adapter: this.name, mapping, failureReason: 'NO_MATCHING_RECORDS', startedAt, queryWindow: timeWindow });
    const queryWindow = {
      ...timeWindow,
      from: new Date(Math.max(0, toMs(timeWindow.from) - Math.max(0, Number(timeWindow.beforeMinutes || 5)) * 60 * 1000)).toISOString(),
    };
    try {
      const records = [];
      const currentEvidence = [];
      const occurrenceEvidence = [];
      const relationships = [];
      const lifecycle = [];
      const historyFailures = [];
      let historicalSupported = typeof this.service.getHistoricalOccurrenceEvidence === 'function';
      for (const instance of instances) {
        const type = serviceName ? 'service' : 'host';
        const currentPromise = typeof this.service.listWorkspaceRecords === 'function'
          ? this.service.listWorkspaceRecords(instance, type, {
            search: serviceName || host, status: 'all', page: 1, pageSize: 25,
            forceRefresh: context.refresh === true,
          }) : Promise.resolve({ items: [] });
        const historyPromise = historicalSupported
          ? this.service.getHistoricalOccurrenceEvidence(instance, {
            host, service: serviceName, from: queryWindow.from, to: queryWindow.to,
            anchor: alert.createdAt || timeWindow.from,
          }) : Promise.resolve(null);
        const [currentResult, historyResult] = await Promise.allSettled([currentPromise, historyPromise]);

        if (currentResult.status === 'fulfilled') {
          const response = currentResult.value || {};
          const current = (response.items || []).filter((item) => (!host || canonical(item.hostName) === canonical(host)) && (!serviceName || canonical(item.serviceDescription) === canonical(serviceName)));
          for (const item of current) {
            const normalized = evidenceItem({
              id: `nagios:${instance}:${item.id}`, source: this.source, type: 'nagios_current_status',
              timestamp: item.lastCheck || response.fetchedAt,
              title: serviceName ? `${item.hostName} · ${item.serviceDescription}` : item.hostName,
              summary: item.statusInformation, severity: item.status, entity: item.id, url: item.sourceUrl,
              correlationKey: serviceName ? `nagios:${item.hostName}:${item.serviceDescription}` : `nagios:${item.hostName}`,
              metadata: { instance, host: item.hostName, service: item.serviceDescription || null,
                objectId: item.id, sourceEntityId: item.id, sourceEntityType: 'CURRENT_SOURCE_ENTITY',
                status: item.status, currentState: item.currentState ?? null, stateType: item.stateType || null,
                pluginOutput: item.statusInformation || item.pluginOutput || null,
                attempts: item.attempt ?? null, durationSeconds: item.durationSeconds ?? null,
                lastStateChange: item.lastStateChange || null, acknowledged: item.acknowledged ?? null,
                notificationState: item.notificationsEnabled ?? null,
                currentStatusObservedAt: item.lastCheck || response.fetchedAt,
                sourceFetchedAt: response.fetchedAt, queryMode: 'CURRENT_ONLY' },
            }, queryWindow);
            records.push(normalized);
            currentEvidence.push(normalized);
          }
        }

        if (historyResult.status === 'rejected') {
          historyFailures.push(historyResult.reason);
          continue;
        }
        const history = historyResult.value;
        if (!history?.occurrence) continue;
        const occurrence = history.occurrence;
        const normalized = evidenceItem({
          id: occurrence.id, source: this.source, type: 'nagios_historical_occurrence',
          timestamp: occurrence.timestamp,
          title: `${occurrence.hostName || host}${occurrence.serviceDescription ? ` · ${occurrence.serviceDescription}` : ''}`,
          summary: occurrence.pluginOutput, severity: occurrence.state,
          entity: occurrence.sourceEntityId || mapping.sourceEntityId || serviceName || host,
          url: history.sourceUrl,
          correlationKey: serviceName ? `nagios:${host}:${serviceName}` : `nagios:${host}`,
          metadata: {
            instance, host: occurrence.hostName || host, service: occurrence.serviceDescription || null,
            objectId: occurrence.objectId, sourceEntityId: occurrence.sourceEntityId,
            sourceEventId: occurrence.sourceEventId, sourceEntityType: 'HISTORICAL_SOURCE_ENTITY',
            status: occurrence.state, occurrenceState: occurrence.state,
            stateCode: occurrence.stateCode, stateType: occurrence.stateType,
            stateChange: occurrence.stateChange, pluginOutput: occurrence.pluginOutput,
            attempts: occurrence.attemptCount, maxAttempts: occurrence.maxAttempts,
            lastState: occurrence.lastState, lastHardState: occurrence.lastHardState,
            occurrenceTimestamp: occurrence.timestamp, firedAt: occurrence.timestamp,
            lastStateTransition: occurrence.timestamp,
            acknowledged: history.acknowledgement ? true : null,
            acknowledgementAt: history.acknowledgement?.timestamp || null,
            notificationState: history.notification ? 'SENT' : null,
            notificationAt: history.notification?.timestamp || null,
            notificationType: history.notification?.kind || null,
            notificationAlertState: history.notification?.state || null,
            notificationCommand: history.notification?.command || null,
            recovered: history.recovery ? true : null,
            recoveryState: history.recovery?.state || null,
            recoveryAt: history.recovery?.timestamp || null,
            durationSeconds: history.durationSeconds,
            recoveredAutomatically: null,
            flapping: history.flapping.length ? true : null,
            stateTransitionCount: history.stateHistory.length,
            stateHistory: history.stateHistory.slice(0, 100).map((row) => ({
              timestamp: row.timestamp, state: row.state, stateType: row.stateType,
              attempt: row.attemptCount, output: row.pluginOutput,
            })),
            currentState: currentEvidence.find((item) => item.metadata.instance === instance)?.metadata?.status || null,
            currentEntityPresent: currentEvidence.some((item) => item.metadata.instance === instance),
            historicalMappingMethod: 'EXACT_HOST_SERVICE_BOUNDED_TIMESTAMP',
            historicalMappingEvidence: [
              `Exact host: ${occurrence.hostName || host}`,
              occurrence.serviceDescription ? `Exact service: ${occurrence.serviceDescription}` : 'Host-level occurrence',
              `Nagios state time: ${occurrence.timestamp}`,
            ],
            historicalMappingConfidence: 'HIGH',
            sourceProvenance: history.sourceProvenance,
            sourceFetchedAt: history.retrievedAt,
            queryMode: 'BOUNDED_HISTORICAL_OCCURRENCE',
          },
        }, queryWindow);
        records.push(normalized);
        occurrenceEvidence.push(normalized);
        lifecycle.push(normalized);
        relationships.push(relationship(normalized, mapping, [
          'Exact Nagios host/service identity',
          'Authoritative state-history occurrence timestamp is inside the bounded alert window',
        ]));

        if (history.recovery) {
          const recovery = evidenceItem({
            id: history.recovery.id, source: this.source, type: 'nagios_historical_recovery',
            timestamp: history.recovery.timestamp,
            title: `${history.recovery.hostName || host}${history.recovery.serviceDescription ? ` · ${history.recovery.serviceDescription}` : ''} recovered`,
            summary: history.recovery.pluginOutput, severity: history.recovery.state,
            entity: history.recovery.sourceEntityId || normalized.entity, url: history.sourceUrl,
            correlationKey: normalized.correlationKey,
            metadata: { instance, host: history.recovery.hostName || host,
              service: history.recovery.serviceDescription || null,
              objectId: history.recovery.objectId, sourceEntityId: history.recovery.sourceEntityId,
              sourceEntityType: 'HISTORICAL_SOURCE_ENTITY', status: history.recovery.state,
              stateType: history.recovery.stateType, pluginOutput: history.recovery.pluginOutput,
              attempts: history.recovery.attemptCount, recoveryAt: history.recovery.timestamp,
              sourceProvenance: history.sourceProvenance, queryMode: 'BOUNDED_HISTORICAL_RECOVERY' },
          }, queryWindow);
          records.push(recovery);
          lifecycle.push(recovery);
        }
      }
      const matched = [...occurrenceEvidence, ...currentEvidence];
      const failureReason = occurrenceEvidence.length ? null
        : historyFailures.length ? sourceQueryFailureReason(historyFailures[0])
          : !historicalSupported ? 'UNSUPPORTED_HISTORICAL_QUERY'
            : 'HISTORICAL_OCCURRENCE_NOT_FOUND';
      return adapterResult({
        source: this.source,
        adapter: this.name,
        mapping,
        records,
        evidence: matched,
        relationships,
        lifecycle,
        failureReason,
        startedAt,
        queryWindow,
        query: {
          host,
          service: serviceName,
          instances,
          mode: historicalSupported ? 'BOUNDED_HISTORICAL_PLUS_CURRENT' : 'CURRENT_ONLY',
          currentRecords: currentEvidence.length,
          occurrenceRecords: occurrenceEvidence.length,
          currentEntityRequired: false,
        },
      });
    } catch (error) {
      const reason = sourceQueryFailureReason(error);
      return adapterResult({ source: this.source, adapter: this.name, mapping, failureReason: reason, startedAt, queryWindow: timeWindow, query: { host, service: serviceName, instances } });
    }
  }
}

function appDynamicsMetricIntent(alert = {}) {
  const structured = cleanText([
    alert.sourceMetadata?.appDynamicsMetric,
    alert.sourceMetadata?.appDynamicsBusinessTransaction,
    alert.sourceMetadata?.appDynamicsHealthRule,
    alert.sourceMetadata?.appDynamicsTier,
    alert.sourceMetadata?.appDynamicsNode,
  ].filter(Boolean).join(' ')).toLowerCase();
  const fallback = cleanText(alert.alertName || alert.message).toLowerCase();
  const value = structured || fallback;
  if (/response|latency|slow|duration/.test(value)) return 'RESPONSE_TIME';
  if (/error|exception|failure|failed/.test(value)) return 'ERROR_RATE';
  if (/load|calls|traffic|throughput/.test(value)) return 'CALLS_LOAD';
  if (/\bcpu\b|processor\s+(?:usage|utili[sz]ation|load|time)/.test(value)) return 'CPU';
  if (/\b(memory|heap|garbage collection|gc)\b/.test(value)) return 'MEMORY';
  if (/database|\bdb\b|sql|connection pool/.test(value)) return 'DATABASE';
  if (/business.?transaction|\bbt\b/.test(value)) return 'BUSINESS_TRANSACTION';
  if (/node|machine|jvm|\bprocess\b/.test(value)) return 'NODE_HEALTH';
  if (alert.sourceMetadata?.appDynamicsHealthRule) return 'HEALTH_RULE_EVENT';
  return 'GENERAL_HEALTH';
}

function metricMatchesIntent(metric, intent) {
  const value = canonical(metric);
  if (intent === 'RESPONSE_TIME') return /response|latency|duration/.test(value);
  if (intent === 'ERROR_RATE') return /error|exception|failure/.test(value);
  if (intent === 'CALLS_LOAD') return /call|load|traffic|throughput/.test(value);
  if (intent === 'NODE_HEALTH') return /node|jvm|machine|process|cpu|memory/.test(value);
  if (intent === 'DATABASE') return /database|db|sql|connection|pool/.test(value);
  if (intent === 'MEMORY') return /memory|heap|garbage|gc/.test(value);
  if (intent === 'CPU') return /cpu|processor/.test(value);
  if (intent === 'BUSINESS_TRANSACTION') return /business.?transaction|\bbt\b/.test(value);
  if (intent === 'HEALTH_RULE_EVENT') return /health|violation|event/.test(value);
  return false;
}

function appDynamicsMetricMetadata(metric, applicationId, response = {}) {
  const metricIntent = intentFromText(metric);
  const contract = METRIC_CONTRACT[metricIntent] || METRIC_CONTRACT.UNKNOWN;
  const aggregation = response.metrics?.aggregation || {};
  return {
    applicationId: String(applicationId),
    metric,
    metricName: metric,
    metricPath: inferredMetricPath(metric),
    metricIntent,
    unit: contract.unit,
    aggregation: contract.aggregation,
    rollup: aggregation.aggregationLabel || aggregation.label || aggregation.bucketMinutes || null,
    entityType: 'APPLICATION',
    entityId: String(applicationId),
  };
}

function appDynamicsEvidenceType(event = {}) {
  const value = cleanText([event.type, event.eventType, event.state, event.status].filter(Boolean).join(' ')).toUpperCase();
  if (/POLICY_|HEALTH.?RULE|VIOLATION/.test(value)) return 'HEALTH_RULE_VIOLATION';
  if (/ANOMALY|APPLICATION_ERROR|ERROR/.test(value)) return 'EVENT';
  if (/BUSINESS.?TRANSACTION/.test(value) || event.businessTransaction || event.businessTransactionName) return 'BUSINESS_TRANSACTION';
  if (/APPLICATION.?HEALTH/.test(value)) return 'APPLICATION_HEALTH';
  if (value || event.id || event.eventId) return 'EVENT';
  return 'OTHER';
}

function appDynamicsFailureReason(error) {
  const message = safeError(error);
  if (Number(error?.status) === 404 || /not found|entity.*missing/i.test(message)) return 'ENTITY_NOT_FOUND';
  if (/timeout|timed out|abort/i.test(message)) return 'SOURCE_TIMEOUT';
  if (/unsupported.*histor/i.test(message)) return 'UNSUPPORTED_HISTORICAL_QUERY';
  if (/unsupported.*metric/i.test(message)) return 'UNSUPPORTED_METRIC';
  if (/normaliz|invalid response|malformed/i.test(message)) return 'NORMALIZATION_FAILED';
  return 'SOURCE_ERROR';
}

function metricSummary(series = {}) {
  const points = Object.values(series).flat().filter((point) => Number.isFinite(Number(point?.value)));
  if (!points.length) return {
    average: null, baseline: null, current: null, durationOfDegradationMs: null,
    errorIncrease: null, healthRuleState: null, loadIncrease: null, minimum: null,
    nodeState: null, peak: null, recoveryObserved: false, timestamps: [],
  };
  const values = points.map((point) => Number(point.value)).sort((left, right) => left - right);
  const peak = Math.max(...values);
  const current = Number(points.at(-1).value);
  return {
    // The controller response used here does not provide a baseline or a
    // threshold. Keep those fields null instead of treating an observed median
    // as a vendor-provided baseline.
    average: Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(4)),
    baseline: null,
    peak,
    minimum: Math.min(...values),
    current,
    recoveryObserved: current < peak,
    durationOfDegradationMs: null,
    errorIncrease: null,
    healthRuleState: null,
    loadIncrease: null,
    nodeState: null,
    observedMedian: values[Math.floor((values.length - 1) / 2)],
    timestamps: unique(points.map((point) => toIso(point.timestamp))),
  };
}

class AppDynamicsEvidenceAdapter extends BaseEvidenceAdapter {
  constructor(service = appDynamicsService) {
    super('AppDynamics', service);
    this.queryCache = [];
    this.queryCacheTtlMs = 5 * 60 * 1000;
  }

  async queryApplication(application, timeWindow, metricIntent, context = {}) {
    const now = Date.now();
    this.queryCache = this.queryCache.filter((item) => now - item.cachedAt < this.queryCacheTtlMs);
    const from = toMs(timeWindow.from);
    const to = toMs(timeWindow.to);
    const reusable = !context.refresh && this.queryCache.find((item) => (
      item.application === String(application)
      && item.metricIntent === metricIntent
      && item.from <= from
      && item.to >= to
    ));
    if (reusable) return { response: reusable.response, reuse: { cacheHit: true, reusedWindow: { from: toIso(reusable.from), to: toIso(reusable.to) } } };
    const response = this.service.queryApplicationEvidence
      ? await this.service.queryApplicationEvidence(application, { from: timeWindow.from, to: timeWindow.to, metricIntent, refresh: context.refresh === true })
      : await this.service.getWorkspaceApplication(application, { range: context.range || '24h' });
    this.queryCache.push({ application: String(application), metricIntent, from, to, response, cachedAt: now });
    return { response, reuse: { cacheHit: false, reusedWindow: null } };
  }

  async queryEvidence(alert, timeWindow, context = {}) {
    const startedAt = Date.now();
    const mapping = this.resolveIdentity(alert, context.mappings);
    if (!mapping) return adapterResult({ source: this.source, adapter: this.name, failureReason: 'APPDYNAMICS_ALERT_UNRESOLVED', startedAt, queryWindow: timeWindow });
    const application = mapping.metadata?.applicationId
      || alert.sourceMetadata.applicationId
      || alert.application
      || (mapping.sourceEntityType === 'APPLICATION' ? mapping.sourceEntityId || mapping.sourceEntityName : null);
    if (!application) return adapterResult({ source: this.source, adapter: this.name, mapping, failureReason: 'NO_MATCHING_RECORDS', startedAt, queryWindow: timeWindow });
    try {
      const anchor = toMs(alert.createdAt);
      // JSM Operations delivery can trail the AppDynamics source occurrence by
      // several minutes. Keep a bounded ten-minute look-back while requiring
      // the exact source event ID, so delayed delivery never admits a nearby
      // but unrelated event from the same application.
      const beforeMinutes = Math.max(10, Number(timeWindow.beforeMinutes) || 5);
      const occurrenceWindow = {
        ...timeWindow,
        from: anchor === null ? timeWindow.from : toIso(anchor - (beforeMinutes * 60 * 1000)),
      };
      const metricIntent = cleanText(context.metricIntent).toUpperCase() || appDynamicsMetricIntent(alert);
      const targetEventId = cleanText(alert.sourceMetadata?.appDynamicsSourceAlertId
        || mapping.metadata?.eventId || mapping.metadata?.sourceAlertId) || null;
      const targetViolationId = cleanText(alert.sourceMetadata?.appDynamicsViolationId
        || mapping.metadata?.violationId) || null;
      const entityContext = alert.sourceMetadata?.appDynamicsBusinessTransaction ? { type: 'BUSINESS_TRANSACTION', id: alert.sourceMetadata.appDynamicsBusinessTransaction }
        : alert.sourceMetadata?.appDynamicsNode ? { type: 'NODE', id: alert.sourceMetadata.appDynamicsNode }
          : alert.sourceMetadata?.appDynamicsTier ? { type: 'TIER', id: alert.sourceMetadata.appDynamicsTier }
            : { type: 'APPLICATION', id: String(application) };
      if (context.requireExactEntity === true && entityContext.type !== 'APPLICATION' && !this.service.queryEntityEvidence) {
        return adapterResult({
          source: this.source,
          adapter: this.name,
          mapping,
          failureReason: 'SOURCE_API_LIMITATION',
          startedAt,
          queryWindow: occurrenceWindow,
          query: { applicationId: String(application), metricIntent, entityType: entityContext.type, entityId: entityContext.id,
            sourceStatus: 'ENTITY_LEVEL_QUERY_UNAVAILABLE', windowStart: occurrenceWindow.from, windowEnd: occurrenceWindow.to,
            rawRecordCount: 0, normalizedRecordCount: 0, httpStatus: null, responseShape: 'NO_REQUEST' },
        });
      }
      const { response, reuse } = await this.queryApplication(application, occurrenceWindow, metricIntent, context);
      const returnedApplicationId = cleanText(response.application?.id || response.application?.applicationId);
      if (returnedApplicationId && returnedApplicationId !== String(application)) {
        return adapterResult({
          source: this.source,
          adapter: this.name,
          mapping,
          failureReason: 'APPDYNAMICS_APPLICATION_MISMATCH',
          startedAt,
          queryWindow: occurrenceWindow,
          query: {
            applicationId: String(application),
            returnedApplicationId,
            metricIntent,
            sourceStatus: 'IDENTITY_CONFLICT',
          },
        });
      }
      const metricContainer = response.metrics || response.application?.metrics || {};
      const availableSeries = metricContainer.series || {};
      const selectedSeries = Object.fromEntries(Object.entries(availableSeries).filter(([metric]) => metricMatchesIntent(metric, metricIntent)));
      // Fail closed when the requested intent is not present. Falling back to
      // any available series can turn calls/min into response-time or error
      // evidence and is not safe for classification.
      const metricSeries = selectedSeries;
      const records = [];
      const rawRecords = [];
      Object.entries(metricSeries).forEach(([metric, points]) => {
        (points || []).forEach((point, index) => {
          const semanticMetadata = appDynamicsMetricMetadata(metric, application, response);
          rawRecords.push({ recordType: 'METRIC', metric, metricPath: semanticMetadata.metricPath,
            unit: semanticMetadata.unit, aggregation: semanticMetadata.aggregation, rollup: semanticMetadata.rollup,
            entityType: semanticMetadata.entityType, entityId: semanticMetadata.entityId, ...point });
          records.push(evidenceItem({
          id: `appdynamics:${application}:metric:${metric}:${point.timestamp || index}`,
          source: this.source,
          type: 'monitoring_telemetry',
          timestamp: point.timestamp,
          title: metric,
          summary: `${metric}: ${point.value}`,
          entity: mapping.sourceEntityName || alert.canonicalEntity,
          url: response.application?.sourceUrl,
          correlationKey: `appdynamics:${application}`,
          metadata: { ...semanticMetadata, applicationName: response.application?.name || mapping.sourceEntityName || null,
            requestedMetricIntent: metricIntent, value: point.value },
          }, occurrenceWindow));
        });
      });
      for (const [index, event] of (response.events || []).entries()) {
        rawRecords.push({ recordType: 'EVENT', ...event });
        records.push(evidenceItem({
          id: `appdynamics:${application}:event:${event.id || index}`,
          source: this.source,
          type: event.type || event.eventType || 'appdynamics_event',
          timestamp: event.time || event.eventTime || event.timestamp || event.startTime,
          title: event.healthRule || event.name || event.title || event.summary || event.type || 'AppDynamics event',
          summary: event.message || event.eventMessage || event.description || event.summary,
          severity: event.severity,
          entity: event.nodeName || event.node || event.businessTransactionName || event.businessTransaction
            || event.tierName || event.tier || mapping.sourceEntityName,
          url: event.deepLink || event.sourceUrl || response.application?.sourceUrl,
          correlationKey: `appdynamics:${application}`,
          metadata: {
            applicationId: String(application),
            applicationName: response.application?.name || mapping.sourceEntityName || null,
            eventId: event.eventId || event.id || null,
            violationId: event.violationId || (event.endpointCategory === 'healthrule-violations' ? event.id || event.eventId : null),
            eventType: event.eventType || event.type || null,
            occurrenceState: event.state || event.status || event.eventType || event.type || null,
            state: event.state || event.status || event.eventType || event.type || null,
            currentState: event.currentState || response.application?.health?.state || response.application?.health
              || response.application?.status || null,
            firedAt: event.startedAt || event.time || event.eventTime || null,
            recoveryAt: event.recoveryAt || event.endedAt || null,
            recovered: event.terminal === true && Boolean(event.recoveryAt || event.endedAt),
            recoveryState: event.terminalState || null,
            terminalState: event.terminalState || null,
            evidenceType: appDynamicsEvidenceType(event),
            healthRule: event.healthRule || event.healthRuleName || null,
            healthRuleId: event.healthRuleId || event.healthRule?.id || null,
            policy: event.policy || event.policyName || null,
            policyId: event.policyId || event.policy?.id || null,
            tier: event.tierName || event.tier || null,
            tierId: event.tierId || null,
            node: event.nodeName || event.node || null,
            nodeId: event.nodeId || null,
            businessTransaction: event.businessTransactionName || event.businessTransaction || null,
            businessTransactionId: event.businessTransactionId || null,
            database: event.databaseName || event.database || null,
            entityType: event.nodeName || event.node ? 'NODE'
              : event.businessTransactionName || event.businessTransaction ? 'BUSINESS_TRANSACTION'
                : event.tierName || event.tier ? 'TIER'
                  : event.databaseName || event.database ? 'DATABASE' : 'APPLICATION',
            entityId: event.nodeId || event.businessTransactionId || event.tierId || event.databaseId || String(application),
            sourceProvenance: {
              source: 'AppDynamics',
              endpointCategory: event.endpointCategory || 'events',
              sourceObjectId: String(event.id || event.eventId || ''),
              mappingMethod: targetEventId && String(event.id || event.eventId) === targetEventId
                ? 'EXACT_EVENT_ID_AND_BOUNDED_TIMESTAMP' : 'EXACT_APPLICATION_AND_BOUNDED_TIMESTAMP',
              sourceEventTime: event.time || event.eventTime || event.timestamp || event.startTime || null,
              evidenceAsOf: new Date().toISOString(),
              readOnly: true,
            },
          },
        }, occurrenceWindow));
      }
      const boundedRecords = records.filter((item) => item.metadata.matchWindow);
      const exactEventRecords = targetEventId
        ? boundedRecords.filter((item) => String(item.metadata?.eventId || '') === targetEventId)
        : [];
      const matched = targetEventId ? exactEventRecords : boundedRecords;
      const targetOutsideWindow = targetEventId && records.some((item) => (
        String(item.metadata?.eventId || '') === targetEventId && item.metadata?.matchWindow !== true
      ));
      const failureReason = targetEventId && !matched.length
        ? targetOutsideWindow ? 'TIMESTAMP_MISMATCH' : 'APPDYNAMICS_EVENT_NOT_FOUND'
        : records.length && !matched.length ? 'TIMESTAMP_MISMATCH'
          : records.length ? null : 'NO_RECORDS_IN_WINDOW';
      const result = adapterResult({
        source: this.source,
        adapter: this.name,
        mapping,
        records,
        evidence: matched,
        relationships: matched.map((item) => relationship(item, mapping, unique([
          'Exact AppDynamics application identity',
          targetEventId ? 'Exact AppDynamics event identifier' : null,
          'Source event timestamp is inside the bounded occurrence window',
        ]))),
        failureReason,
        startedAt,
        queryWindow: occurrenceWindow,
        query: {
          applicationId: String(application),
          applicationName: response.application?.name || mapping.sourceEntityName || null,
          eventId: targetEventId,
          violationId: targetViolationId,
          matchedEventId: matched.find((item) => item.metadata?.eventId)?.metadata?.eventId || null,
          metricIntent,
          metricPath: Object.keys(metricSeries).length === 1 ? inferredMetricPath(Object.keys(metricSeries)[0]) : null,
          metricPaths: Object.keys(metricSeries).map(inferredMetricPath).filter(Boolean),
          metricMatch: Object.keys(metricSeries).length ? 'MATCHED' : Object.keys(availableSeries).length ? 'MISMATCHED' : 'UNKNOWN',
          sourceStatus: response.metrics?.requestStatus || response.metrics?.status || 'READ_ONLY_SUCCESS',
          httpStatus: response.queryDiagnostics?.metrics?.httpStatus || response.queryDiagnostics?.events?.httpStatus || 200,
          responseShape: Array.isArray(response.events) || Object.keys(availableSeries).length ? 'APPDYNAMICS_EVIDENCE_OBJECT' : 'EMPTY_EVIDENCE_OBJECT',
          entityType: entityContext.type,
          entityId: entityContext.id,
          timezone: 'UTC',
          windowStart: occurrenceWindow.from,
          windowEnd: occurrenceWindow.to,
          rawRecordCount: rawRecords.length,
          normalizedRecordCount: records.length,
          rawRecords,
          normalizedRecords: records,
          reuse,
        },
      });
      result.query.outcome = result.pipelineState === 'RECORDS_FOUND' ? 'RECORDS_FOUND' : result.failureReason || result.pipelineState;
      result.diagnostics.evidenceSummary = { applicationId: String(application), applicationName: response.application?.name || mapping.sourceEntityName || null, eventId: targetEventId, violationId: targetViolationId, metricIntent, queryWindow: occurrenceWindow, recordsReturned: records.length, exactEventMatches: exactEventRecords.length, ...metricSummary(metricSeries) };
      result.diagnostics.telemetrySemanticValidation = {
        expectedIntent: metricIntent,
        metricMatch: result.query.metricMatch,
        availableMetrics: Object.keys(availableSeries),
        acceptedMetrics: Object.keys(metricSeries),
      };
      result.diagnostics.queryReuse = reuse;
      result.workflowEvidence = appDynamicsWorkflowEvidence({
        alert,
        identity: {
          accepted: true,
          canonicalEntity: alert.canonicalEntity || mapping.sourceEntityName || response.application?.name || null,
          sourceEntityId: mapping.sourceEntityId || String(application),
          sourceEntityName: mapping.sourceEntityName || response.application?.name || null,
        },
        monitoringBlocks: [{
          source: this.source,
          acceptedMapping: true,
          degradation: true,
          sustained: false,
          records: matched,
        }],
      });
      return result;
    } catch (error) {
      return adapterResult({ source: this.source, adapter: this.name, mapping, failureReason: appDynamicsFailureReason(error), startedAt, queryWindow: timeWindow, query: { applicationId: String(application), metricIntent: appDynamicsMetricIntent(alert) } });
    }
  }
}

function grafanaThresholdSpec(rule = null, panel = null) {
  const ruleThreshold = (rule?.thresholds || []).find((item) => Array.isArray(item?.values)
    && item.values.some((value) => Number.isFinite(Number(value))));
  const ruleValue = ruleThreshold?.values?.find((value) => Number.isFinite(Number(value)));
  if (ruleValue !== undefined) return {
    comparator: ruleThreshold.evaluator || null,
    refId: ruleThreshold.refId || null,
    source: 'GRAFANA_ALERT_RULE',
    value: Number(ruleValue),
  };
  const panelThreshold = (panel?.display?.thresholds || []).find((item) => item?.value !== null
    && item?.value !== undefined && Number.isFinite(Number(item.value)) && Number(item.value) !== 0);
  return panelThreshold ? {
    comparator: 'gt',
    refId: null,
    source: 'GRAFANA_PANEL_DISPLAY',
    value: Number(panelThreshold.value),
  } : null;
}

function grafanaThresholdExceeded(value, threshold) {
  if (!Number.isFinite(Number(value)) || !threshold || !Number.isFinite(Number(threshold.value))) return null;
  const numeric = Number(value);
  const expected = Number(threshold.value);
  if (['lt', 'less_than'].includes(String(threshold.comparator || '').toLowerCase())) return numeric < expected;
  if (['lte', 'less_than_or_equal'].includes(String(threshold.comparator || '').toLowerCase())) return numeric <= expected;
  if (['gte', 'greater_than_or_equal'].includes(String(threshold.comparator || '').toLowerCase())) return numeric >= expected;
  return numeric > expected;
}

function grafanaFrameEvidence(frame, source, dashboardUid, panelId, window, context = {}) {
  const fields = frame.fields || [];
  const values = frame.values || [];
  const timeIndex = fields.findIndex((field) => field.type === 'time' || /time/i.test(field.name || ''));
  const rows = [];
  if (timeIndex < 0 || !Array.isArray(values[timeIndex])) return rows;
  fields.forEach((field, fieldIndex) => {
    if (fieldIndex === timeIndex || !Array.isArray(values[fieldIndex])) return;
    const points = values[timeIndex].map((timestamp, index) => ({
      timestamp: toIso(timestamp),
      value: values[fieldIndex][index],
    })).filter((point) => point.timestamp && point.value !== null && point.value !== undefined && point.value !== '');
    if (!points.length) return;
    const numericPoints = points.filter((point) => Number.isFinite(Number(point.value)))
      .map((point) => ({ ...point, value: Number(point.value) }));
    const occurrenceMs = toMs(context.occurrenceAt);
    const nearest = [...points].sort((left, right) => (
      occurrenceMs === null ? toMs(left.timestamp) - toMs(right.timestamp)
        : Math.abs(toMs(left.timestamp) - occurrenceMs) - Math.abs(toMs(right.timestamp) - occurrenceMs)
    ))[0];
    const exceedance = numericPoints.map((point) => ({
      ...point,
      exceeded: grafanaThresholdExceeded(point.value, context.threshold),
    }));
    const violating = exceedance.filter((point) => point.exceeded === true);
    const firstViolation = violating[0] || null;
    const lastViolation = violating.at(-1) || null;
    const recoveredPoint = lastViolation
      ? exceedance.find((point) => toMs(point.timestamp) > toMs(lastViolation.timestamp) && point.exceeded === false)
      : null;
    const sampleIntervals = numericPoints.slice(1).map((point, index) => toMs(point.timestamp) - toMs(numericPoints[index].timestamp))
      .filter((value) => Number.isFinite(value) && value > 0).sort((left, right) => left - right);
    const medianIntervalMs = sampleIntervals.length ? sampleIntervals[Math.floor(sampleIntervals.length / 2)] : 0;
    const metric = field.displayName || field.name || frame.name || 'Grafana metric';
    rows.push(evidenceItem({
      id: `grafana:${dashboardUid}:${panelId}:${frame.refId || frame.name}:${fieldIndex}`,
      source,
      type: 'grafana_telemetry',
      timestamp: nearest.timestamp,
      title: metric,
      summary: `${metric}: ${nearest.value}`,
      entity: dashboardUid,
      url: context.panelDeepLink || null,
      correlationKey: `grafana-panel:${dashboardUid}:${panelId}`,
      metadata: {
        dashboardUid,
        dashboardTitle: context.dashboardTitle || null,
        folder: context.folderTitle || null,
        panelId: String(panelId),
        panelTitle: context.panelTitle || null,
        panelDeepLink: context.panelDeepLink || null,
        datasource: context.datasource || null,
        queryReferences: context.queryReferences || [],
        refId: frame.refId || null,
        metric,
        value: nearest.value,
        valueAtOccurrence: nearest.value,
        unit: field.unit || context.unit || null,
        labels: field.labels || {},
        threshold: context.threshold || null,
        thresholdExceededAtOccurrence: grafanaThresholdExceeded(nearest.value, context.threshold),
        peak: numericPoints.length ? Math.max(...numericPoints.map((point) => point.value)) : null,
        minimum: numericPoints.length ? Math.min(...numericPoints.map((point) => point.value)) : null,
        pointCount: points.length,
        metricWindowStart: points[0].timestamp,
        metricWindowEnd: points.at(-1).timestamp,
        firstThresholdCrossingAt: firstViolation?.timestamp || null,
        lastThresholdCrossingAt: lastViolation?.timestamp || null,
        timeAboveThresholdSeconds: violating.length && medianIntervalMs
          ? Math.round((violating.length * medianIntervalMs) / 1000) : null,
        recovered: recoveredPoint ? true : violating.length ? false : null,
        recoveredAt: recoveredPoint?.timestamp || null,
        noDataObserved: points.length === 0,
        series: points.slice(0, 500),
        sourceProvenance: {
          source: 'Grafana',
          endpointCategory: 'dashboard_panel_query',
          sourceObjectId: `${dashboardUid}:${panelId}:${frame.refId || fieldIndex}`,
          mappingMethod: context.mappingMethod || null,
          retrievedAt: context.retrievedAt || new Date().toISOString(),
          sourceEventTime: toIso(context.occurrenceAt),
          evidenceAsOf: context.retrievedAt || new Date().toISOString(),
          readOnly: true,
        },
      },
    }, window));
  });
  return rows;
}

function grafanaIdentitySignals(alert = {}, mapping = null) {
  const metadata = alert.sourceMetadata || {};
  const labels = { ...(metadata.grafanaLabels || {}) };
  const annotations = { ...(metadata.grafanaAnnotations || {}) };
  return {
    ruleUid: mapping?.sourceEntityType === 'ALERT_RULE' ? mapping.sourceEntityId : metadata.grafanaRuleUid || mapping?.metadata?.ruleUid || null,
    dashboardUid: mapping?.metadata?.dashboardUid || metadata.grafanaDashboardUid || null,
    panelId: mapping?.metadata?.panelId || metadata.grafanaPanelId || null,
    alertName: metadata.grafanaAlertName || labels.alertname || alert.alertName || null,
    environment: metadata.grafanaEnvironment || labels.environment || labels.env || alert.environment || null,
    instance: metadata.grafanaInstance || labels.instance || null,
    folder: metadata.grafanaFolder || mapping?.metadata?.folder || null,
    service: metadata.grafanaService || labels.service || annotations.service || alert.service || null,
    team: metadata.grafanaTeam || labels.team || annotations.team || null,
    labels,
    annotations,
    deepLink: mapping?.metadata?.deepLink || metadata.grafanaDeepLink || null,
    sourceUrl: mapping?.metadata?.sourceUrl || metadata.grafanaSourceUrl || null,
    sourceHost: mapping?.metadata?.sourceHost || metadata.grafanaSourceHost || null,
    integrationHost: mapping?.metadata?.integrationHost || metadata.grafanaIntegrationHost || null,
  };
}

function grafanaIdentityLevel(signals) {
  if (signals.ruleUid) return 'EXACT_RULE_UID';
  if (signals.dashboardUid && signals.panelId) return 'EXACT_DASHBOARD_PANEL';
  if (signals.alertName && signals.environment && signals.instance) return 'EXACT_ALERT_ENV_INSTANCE';
  if (signals.alertName && signals.folder && signals.environment) return 'EXACT_ALERT_FOLDER_ENV';
  if (signals.alertName && signals.folder) return 'DISCOVERY_ALERT_FOLDER';
  if (signals.alertName && Object.keys(signals.labels).length >= 2) return 'EXACT_LABEL_SET';
  if (signals.alertName && [signals.environment, signals.instance, signals.folder, signals.service, signals.team].filter(Boolean).length >= 2) return 'STRONG_COMPOSITE';
  return 'GENERIC_IDENTITY_BLOCKED';
}

function grafanaMappingFromDiscovery(discovery, fallback = null) {
  const selected = discovery?.selected;
  if (!selected?.value) return null;
  const value = selected.value;
  const isRule = selected.kind === 'rule';
  return {
    source: 'Grafana',
    level: 'EXACT',
    confidence: 100,
    sourceEntityId: String(isRule ? value.uid : `${value.dashboardUid}:${value.id}`),
    sourceEntityName: value.title,
    sourceEntityType: isRule ? 'ALERT_RULE' : 'PANEL',
    metadata: {
      ...(fallback?.metadata || {}),
      ruleUid: isRule ? value.uid : fallback?.metadata?.ruleUid || null,
      dashboardUid: isRule ? value.dashboard?.uid : value.dashboardUid,
      dashboardTitle: isRule ? value.dashboard?.title : value.dashboardTitle,
      panelId: isRule ? value.dashboard?.panelId : value.id,
      panelTitle: isRule ? null : value.title,
      folder: value.folderTitle || null,
      deepLink: isRule ? value.url : value.deepLink,
      sourceHost: discovery.configuredHost,
      instanceDisposition: discovery.disposition,
      inventoryProof: discovery.proof,
    },
    reasons: [`Grafana identity proven by ${selected.method} in the authenticated workspace inventory`],
  };
}

function selectGrafanaRuleCandidate(items = [], signals = {}) {
  const exactTitle = items.filter((item) => canonical(item.title) === canonical(signals.alertName));
  if (!exactTitle.length) return null;
  const scored = exactTitle.map((item) => {
    const dashboardUid = item.dashboard?.uid || item.dashboardUid || item.labels?.dashboard_uid || null;
    const panelId = item.dashboard?.panelId || item.panelId || item.labels?.panel_id || null;
    const labels = { ...(item.labels || {}), ...(item.annotations || {}) };
    const checks = [
      ['dashboardUid', signals.dashboardUid, dashboardUid, 6],
      ['panelId', signals.panelId, panelId, 6],
      ['folder', signals.folder, item.folderTitle, 4],
      ['environment', signals.environment, labels.environment || labels.env, 3],
      ['instance', signals.instance, labels.instance, 3],
      ['service', signals.service, labels.service, 3],
      ['team', signals.team, labels.team, 3],
    ];
    let score = 1;
    const matched = [];
    for (const [name, expected, actual, weight] of checks) {
      if (!expected || !actual) continue;
      if (canonical(expected) !== canonical(actual)) return null;
      score += weight;
      matched.push(name);
    }
    return { item, matched, score };
  }).filter(Boolean).sort((left, right) => right.score - left.score);
  if (scored.length === 1) return scored[0].score >= 4 ? scored[0].item : null;
  if (!scored.length || scored[0].score < 4 || scored[0].score === scored[1]?.score) return null;
  return scored[0].item;
}

function grafanaInstanceLabels(labels = {}) {
  const routingLabels = new Set([
    'alertname', 'grafana folder', 'severity', 'priority', 'og priority', 'page', 'room',
    'slack', 'send', 'prometheus', 'prometheus replica',
  ]);
  return Object.entries(labels || {}).filter(([key, value]) => {
    if (value === null || value === undefined || value === '' || String(key).startsWith('__')) return false;
    const normalizedKey = canonical(key).replace(/[_-]+/g, ' ');
    return normalizedKey && !routingLabels.has(normalizedKey);
  });
}

function grafanaLabelsMatch(itemLabels = {}, signals = {}) {
  const expected = grafanaInstanceLabels(signals.labels || {});
  if (!expected.length) return false;
  const actual = new Map(Object.entries(itemLabels || {}).map(([key, value]) => [key.toLowerCase(), String(value).trim()]));
  return expected.every(([key, value]) => actual.has(key.toLowerCase())
    && actual.get(key.toLowerCase()) === String(value).trim());
}

function grafanaHistoryItemMatches(item = {}, signals = {}) {
  if (signals.ruleUid && String(item.ruleUid || '') !== String(signals.ruleUid)) return false;
  if (signals.alertName && canonical(item.ruleName || item.labels?.alertname) !== canonical(signals.alertName)) return false;
  return grafanaLabelsMatch(item.labels || {}, signals);
}

function grafanaActiveAlertMatches(item = {}, signals = {}) {
  if (signals.alertName && canonical(item.rule || item.labels?.alertname) !== canonical(signals.alertName)) return false;
  const itemUid = item.labels?.__alert_rule_uid__ || item.labels?.rule_uid || null;
  if (signals.ruleUid && String(itemUid || '') !== String(signals.ruleUid)) return false;
  return grafanaLabelsMatch(item.labels || {}, signals);
}

function grafanaStateHistorySelection(items = [], occurrenceAt, signals = {}) {
  const occurrenceMs = toMs(occurrenceAt);
  const usable = items.filter((item) => toMs(item.timestamp) !== null && cleanText(item.state)
    && grafanaHistoryItemMatches(item, signals));
  if (!usable.length) return null;
  const activeState = (item) => /alerting|firing|pending/i.test(cleanText(item.state));
  const triggers = usable.filter((item) => activeState(item)
    && !/alerting|firing/i.test(cleanText(item.previousState)));
  const fingerprints = new Map();
  triggers.forEach((item) => {
    const key = cleanText(item.fingerprint) || JSON.stringify(item.labels || {});
    if (!fingerprints.has(key)) fingerprints.set(key, []);
    fingerprints.get(key).push(item);
  });
  if (fingerprints.size !== 1) return null;
  const sequence = [...fingerprints.values()][0];
  const firingTransitions = sequence.filter((item) => /alerting|firing/i.test(cleanText(item.state)));
  if (firingTransitions.length === 1) return firingTransitions[0];
  if (firingTransitions.length > 1 || sequence.length !== 1) return null;
  const selected = sequence[0];
  if (occurrenceMs !== null && Math.abs(toMs(selected.timestamp) - occurrenceMs) > 10 * 60 * 1000) return null;
  return selected;
}

function grafanaStateEvidence(event, rule, signals, window) {
  const values = event.values && typeof event.values === 'object' ? event.values : {};
  const value = Object.keys(values).length ? values : null;
  const threshold = rule?.thresholds?.length ? rule.thresholds : null;
  const evaluationResult = value || event.condition || rule?.condition || null;
  const dashboardUid = event.dashboardUid || signals.dashboardUid || rule?.dashboard?.uid || null;
  const panelId = event.panelId || signals.panelId || rule?.dashboard?.panelId || null;
  return evidenceItem({
    id: `grafana:state-history:${event.ruleUid}:${event.fingerprint || event.timestamp}`,
    source: 'Grafana',
    type: 'grafana_alert_state_history',
    timestamp: event.timestamp,
    title: event.ruleName || rule?.title || signals.alertName || 'Grafana alert state',
    summary: [event.previousState ? `${event.previousState} → ${event.state}` : event.state,
      value ? JSON.stringify(value) : null].filter(Boolean).join(' · '),
    entity: signals.service || signals.instance || dashboardUid || event.ruleUid,
    url: rule?.url || signals.deepLink || rule?.dashboard?.url || null,
    correlationKey: `grafana-rule:${event.ruleUid}`,
    confidence: 'High',
    metadata: {
      ruleUid: event.ruleUid,
      ruleId: event.ruleId || null,
      ruleName: event.ruleName || rule?.title || signals.alertName || null,
      state: event.state,
      previousState: event.previousState,
      stateObservedAt: event.timestamp,
      stateSource: 'GRAFANA_ALERT_STATE_HISTORY_LOKI',
      dashboardUid,
      dashboardTitle: rule?.dashboard?.title || null,
      dashboardDeepLink: rule?.dashboard?.url || null,
      panelId: panelId ? String(panelId) : null,
      folder: rule?.folderTitle || signals.folder || null,
      ruleGroup: rule?.ruleGroup || null,
      ruleDeepLink: rule?.url || signals.deepLink || null,
      value,
      values,
      threshold,
      evaluationResult,
      condition: event.condition || rule?.condition || null,
      labels: { ...(rule?.labels || {}), ...(signals.labels || {}), ...(event.labels || {}) },
      annotations: { ...(rule?.annotations || {}), ...(signals.annotations || {}) },
      datasources: rule?.datasources || [],
      queryReferences: rule?.technicalDetails || [],
      sourceHost: signals.sourceHost || null,
      integrationHost: signals.integrationHost || null,
      sourceAlertId: event.ruleUid,
      sourceProvenance: {
        source: 'Grafana', endpointCategory: 'alert_state_history', sourceObjectId: event.ruleUid,
        mappingMethod: signals.ruleUid ? 'EXACT_RULE_UID' : 'PROVEN_INVENTORY_RULE',
        retrievedAt: new Date().toISOString(), sourceEventTime: toIso(event.timestamp),
        evidenceAsOf: new Date().toISOString(), readOnly: true,
      },
    },
  }, window);
}

class GrafanaEvidenceAdapter extends BaseEvidenceAdapter {
  constructor(service = grafanaService) { super('Grafana', service); }

  async queryEvidence(alert, timeWindow, context = {}) {
    const startedAt = Date.now();
    let mapping = this.resolveIdentity(alert, context.mappings);
    const candidate = (context.mappings || []).find((item) => canonical(item?.source) === canonical(this.source)
      && item?.metadata?.requiresInventoryUniqueness);
    let inventoryDiscovery = null;
    if (!mapping && candidate && this.service.findGrafanaWorkspaceEvidenceIdentity) {
      try {
        const candidateSignals = grafanaIdentitySignals(alert, candidate);
        inventoryDiscovery = await this.service.findGrafanaWorkspaceEvidenceIdentity(candidateSignals, { refresh: context.refresh === true });
        mapping = grafanaMappingFromDiscovery(inventoryDiscovery, candidate);
        if (!mapping && inventoryDiscovery.disposition === 'ACTUALLY_DIFFERENT_INSTANCE') {
          return adapterResult({
            source: this.source, adapter: this.name, mapping: candidate,
            failureReason: 'GRAFANA_SOURCE_INSTANCE_NOT_CONFIGURED', startedAt, queryWindow: timeWindow,
            query: {
              attemptedPaths: ['authenticated_workspace_inventory', 'alert_name_structured_context', 'source_host'],
              identityLevel: 'INVENTORY_INSTANCE_RECONCILIATION',
              instanceDisposition: inventoryDiscovery.disposition,
              configuredHost: inventoryDiscovery.configuredHost,
              requestedHost: inventoryDiscovery.requestedHost,
              inventoryProof: inventoryDiscovery.proof,
            },
          });
        }
      } catch (error) {
        return adapterResult({ source: this.source, adapter: this.name, mapping: candidate, failureReason: sourceQueryFailureReason(error), startedAt, queryWindow: timeWindow });
      }
    }
    if (!mapping) {
      const failureReason = candidate?.metadata?.sourceHost
        ? 'GRAFANA_SOURCE_INSTANCE_NOT_CONFIGURED' : 'GRAFANA_ALERT_UNRESOLVED';
      return adapterResult({ source: this.source, adapter: this.name, mapping: candidate || null, failureReason, startedAt, queryWindow: timeWindow,
        query: candidate ? { attemptedPaths: ['alert_name_structured_context', 'source_inventory_uniqueness'], sourceHost: candidate.metadata.sourceHost } : null });
    }
    try {
      let signals = grafanaIdentitySignals(alert, mapping);
      const alertCreatedMs = toMs(alert.createdAt);
      const requestedFromMs = toMs(timeWindow.from);
      const beforeMs = Math.max(0, Number(timeWindow.beforeMinutes || 5)) * 60 * 1000;
      const occurrenceWindow = alertCreatedMs === null ? timeWindow : {
        ...timeWindow,
        from: new Date(Math.min(requestedFromMs ?? alertCreatedMs, alertCreatedMs - beforeMs)).toISOString(),
      };
      const identityLevel = grafanaIdentityLevel(signals);
      if (identityLevel === 'GENERIC_IDENTITY_BLOCKED') {
        return adapterResult({ source: this.source, adapter: this.name, mapping, failureReason: 'NOT_QUERY_ELIGIBLE', startedAt, queryWindow: occurrenceWindow, query: { identityLevel } });
      }
      if (this.service.getGrafanaWorkspaceSourceIdentity && (signals.sourceUrl || signals.sourceHost)) {
        const workspace = await this.service.getGrafanaWorkspaceSourceIdentity();
        let requestedHost = signals.sourceHost || null;
        try { requestedHost = new URL(signals.sourceUrl).hostname.toLowerCase(); } catch { /* structured host remains authoritative */ }
        if (requestedHost && workspace.host && requestedHost !== workspace.host) {
          if (this.service.findGrafanaWorkspaceEvidenceIdentity) {
            inventoryDiscovery = inventoryDiscovery || await this.service.findGrafanaWorkspaceEvidenceIdentity(signals, { refresh: context.refresh === true });
            const discoveredMapping = grafanaMappingFromDiscovery(inventoryDiscovery, mapping);
            if (discoveredMapping) {
              mapping = discoveredMapping;
              signals = grafanaIdentitySignals(alert, mapping);
            }
          }
        }
        if (requestedHost && workspace.host && requestedHost !== workspace.host
          && !inventoryDiscovery?.selected) {
          const error = new Error('The exact Grafana alert belongs to an unconfigured Grafana instance.');
          error.code = 'GRAFANA_SOURCE_INSTANCE_NOT_CONFIGURED';
          error.status = 503;
          error.instanceDiscovery = inventoryDiscovery;
          throw error;
        }
      }
      let ruleUid = signals.ruleUid;
      let rule = null;
      if (ruleUid && this.service.getGrafanaWorkspaceAlertRule) {
        try { rule = await this.service.getGrafanaWorkspaceAlertRule(ruleUid); } catch (error) {
          if (Number(error?.status) !== 404) throw error;
        }
      }
      if (!rule && signals.alertName && this.service.listGrafanaWorkspaceAlertRules) {
        const inventory = await this.service.listGrafanaWorkspaceAlertRules({
          search: signals.alertName, page: 1, pageSize: 25, refresh: context.refresh === true,
        });
        const candidate = selectGrafanaRuleCandidate(inventory.items || [], signals);
        if (candidate) {
          rule = candidate;
          ruleUid = rule.uid;
        }
      }
      const dashboardUid = signals.dashboardUid || rule?.dashboard?.uid;
      const panelId = signals.panelId || rule?.dashboard?.panelId;
      const records = [];
      if (rule) records.push(evidenceItem({
        id: `grafana:rule:${rule.uid}`,
        source: this.source,
        type: 'alert_rule',
        timestamp: rule.updatedAt,
        title: rule.title,
        summary: [rule.folderTitle, rule.ruleGroup, rule.condition].filter(Boolean).join(' · '),
        entity: rule.labels?.service || rule.annotations?.service || alert.canonicalEntity,
        url: rule.url || signals.deepLink || rule.dashboard?.url,
        correlationKey: `grafana-rule:${rule.uid}`,
        metadata: { ruleUid: rule.uid, ruleName: rule.title, ruleGroup: rule.ruleGroup || null,
          ruleDeepLink: rule.url || signals.deepLink || null,
          dashboardUid, dashboardTitle: rule.dashboard?.title || null,
          dashboardDeepLink: rule.dashboard?.url || null,
          panelId: panelId ? String(panelId) : null,
          folder: rule.folderTitle || alert.sourceMetadata.grafanaFolder, labels: rule.labels || {},
          annotations: rule.annotations || {}, state: rule.state || rule.status || null,
          threshold: rule.threshold ?? rule.thresholds ?? null,
          condition: rule.condition || null,
          evaluationResult: rule.condition || rule.evaluationResult || null,
          datasources: rule.datasources || [], queryReferences: rule.technicalDetails || [],
          sourceHost: inventoryDiscovery?.configuredHost || signals.sourceHost || null,
          integrationHost: signals.integrationHost || null,
          instanceDisposition: inventoryDiscovery?.disposition || (signals.sourceHost ? 'ACTUALLY_SAME_INSTANCE' : 'PROVEN_CONFIGURED_INSTANCE'),
          sourceProvenance: {
            source: 'Grafana', endpointCategory: 'alert_rules', sourceObjectId: rule.uid,
            mappingMethod: mapping.reasons?.[0] || identityLevel,
            retrievedAt: new Date().toISOString(), sourceEventTime: null,
            evidenceAsOf: new Date().toISOString(), readOnly: true,
          } },
      }, occurrenceWindow));
      let selectedState = null;
      let historyItems = [];
      let activeMatches = [];
      if (ruleUid && this.service.getGrafanaWorkspaceAlertStateHistory) {
        const history = await this.service.getGrafanaWorkspaceAlertStateHistory(ruleUid, {
          from: occurrenceWindow.from,
          to: occurrenceWindow.to,
          sourceUrl: signals.sourceUrl,
          refresh: context.refresh === true,
        });
        historyItems = (history.items || []).filter((item) => grafanaHistoryItemMatches(item, signals));
        historyItems.forEach((item) => records.push(grafanaStateEvidence(item, rule, signals, occurrenceWindow)));
        selectedState = grafanaStateHistorySelection(historyItems, alert.createdAt, signals);
      }
      if (!selectedState && this.service.getGrafanaWorkspaceActiveAlerts) {
        const active = await this.service.getGrafanaWorkspaceActiveAlerts({ pageSize: 100 });
        const matches = (active.items || []).filter((item) => {
          const itemUid = item.labels?.__alert_rule_uid__ || item.labels?.rule_uid || null;
          return ((ruleUid && String(itemUid || '') === String(ruleUid))
            || (!ruleUid && grafanaActiveAlertMatches(item, signals)))
            && grafanaActiveAlertMatches(item, signals);
        });
        activeMatches = matches;
        matches.forEach((item, index) => records.push(evidenceItem({
          id: `grafana:active:${item.fingerprint || ruleUid || index}`,
          source: this.source,
          type: 'grafana_active_alert',
          timestamp: item.activeSince,
          title: item.rule || signals.alertName || 'Grafana active alert',
          summary: item.annotations?.summary || item.annotations?.description || item.state,
          entity: item.labels?.service || signals.service || alert.canonicalEntity,
          url: item.sourceUrl,
          correlationKey: `grafana-active:${ruleUid || item.fingerprint || signals.alertName}`,
          metadata: {
            ruleUid, dashboardUid, panelId: panelId ? String(panelId) : null,
            state: item.state, labels: item.labels || {}, annotations: item.annotations || {},
            value: item.value ?? null, firingDuration: item.activeSince && timeWindow.to
              ? Math.max(0, Math.round((new Date(timeWindow.to).getTime() - new Date(item.activeSince).getTime()) / 1000)) : null,
            evaluationResult: item.state || null,
          },
        }, occurrenceWindow)));
      }
      let panelResult = null;
      let panelQueryFailure = null;
      const hasOccurrenceState = Boolean(selectedState || records.some((item) => item.type === 'grafana_active_alert' && item.metadata.matchWindow));
      if (hasOccurrenceState && dashboardUid && panelId && this.service.getGrafanaWorkspacePanelData) {
        try {
          panelResult = await this.service.getGrafanaWorkspacePanelData(dashboardUid, panelId, {
            from: occurrenceWindow.from, to: occurrenceWindow.to,
          });
          const threshold = grafanaThresholdSpec(rule, panelResult);
          const retrievedAt = new Date().toISOString();
          for (const frame of panelResult.frames || []) records.push(...grafanaFrameEvidence(
            frame, this.source, dashboardUid, panelId, occurrenceWindow, {
              occurrenceAt: selectedState?.timestamp || alert.createdAt,
              threshold,
              dashboardTitle: panelResult.dashboardTitle || rule?.dashboard?.title || null,
              folderTitle: panelResult.folderTitle || rule?.folderTitle || signals.folder || null,
              panelTitle: panelResult.panelTitle || null,
              panelDeepLink: panelResult.deepLink || null,
              datasource: panelResult.datasource || null,
              queryReferences: panelResult.queryReferences || rule?.technicalDetails || [],
              unit: panelResult.display?.unit || null,
              mappingMethod: mapping.reasons?.[0] || identityLevel,
              retrievedAt,
            },
          ));
        } catch (error) {
          panelQueryFailure = sourceQueryFailureReason(error);
        }
      }
      const alertingContext = this.service.getGrafanaWorkspaceAlertingContext
        ? await this.service.getGrafanaWorkspaceAlertingContext({
            ruleUid,
            sourceUrl: signals.sourceUrl,
            from: occurrenceWindow.from,
            to: occurrenceWindow.to,
            labels: { ...(rule?.labels || {}), ...(signals.labels || {}), ...(selectedState?.labels || {}) },
            rule,
            historyItems,
            activityItems: activeMatches,
            refresh: context.refresh === true,
          }).catch((error) => ({ resolved: false, failureReason: sourceQueryFailureReason(error), readOnly: true }))
        : null;
      const irmContext = this.service.getGrafanaWorkspaceIrmContext && ruleUid
        ? await this.service.getGrafanaWorkspaceIrmContext({
            ruleUid,
            sourceUrl: signals.sourceUrl,
            from: occurrenceWindow.from,
            to: occurrenceWindow.to,
            labels: { ...(rule?.labels || {}), ...(signals.labels || {}) },
            fingerprint: activeMatches[0]?.fingerprint || selectedState?.fingerprint || null,
            refresh: context.refresh === true,
          }).catch((error) => ({ resolved: false, failureReason: sourceQueryFailureReason(error), readOnly: true }))
        : null;
      const stateRecord = selectedState ? records.find((item) => item.type === 'grafana_alert_state_history'
        && item.timestamp === toIso(selectedState.timestamp)
        && item.metadata?.state === selectedState.state) : null;
      if (stateRecord) {
        const stateMs = toMs(stateRecord.timestamp);
        const recovery = historyItems.filter((item) => toMs(item.timestamp) > stateMs
          && (!selectedState.fingerprint || item.fingerprint === selectedState.fingerprint)
          && grafanaHistoryItemMatches(item, signals)
          && /normal|ok|resolved|inactive/i.test(cleanText(item.state)))
          .sort((left, right) => toMs(left.timestamp) - toMs(right.timestamp))[0] || null;
        stateRecord.metadata.alertStartedAt = stateRecord.timestamp;
        stateRecord.metadata.recovered = recovery ? true : /alerting|firing|pending/i.test(cleanText(stateRecord.metadata.state)) ? false : null;
        stateRecord.metadata.recoveredAt = toIso(recovery?.timestamp);
        stateRecord.metadata.persistenceSeconds = recovery
          ? Math.max(0, Math.round((toMs(recovery.timestamp) - stateMs) / 1000))
          : /alerting|firing|pending/i.test(cleanText(stateRecord.metadata.state))
            ? Math.max(0, Math.round((toMs(occurrenceWindow.to) - stateMs) / 1000)) : null;
        stateRecord.metadata.metricWindowStart = occurrenceWindow.from;
        stateRecord.metadata.metricWindowEnd = occurrenceWindow.to;
        stateRecord.metadata.dashboardTitle = panelResult?.dashboardTitle || stateRecord.metadata.dashboardTitle || rule?.dashboard?.title || null;
        stateRecord.metadata.panelTitle = panelResult?.panelTitle || null;
        stateRecord.metadata.panelDeepLink = panelResult?.deepLink || null;
        stateRecord.metadata.datasource = panelResult?.datasource || rule?.datasources || null;
        stateRecord.metadata.queryReferences = panelResult?.queryReferences || stateRecord.metadata.queryReferences || [];
        stateRecord.metadata.threshold = grafanaThresholdSpec(rule, panelResult) || stateRecord.metadata.threshold;
        stateRecord.metadata.noDataObserved = /no\s*data/i.test(cleanText(stateRecord.metadata.state));
        stateRecord.metadata.instanceDisposition = inventoryDiscovery?.disposition || 'PROVEN_CONFIGURED_INSTANCE';
        stateRecord.metadata.sourceHost = inventoryDiscovery?.configuredHost || stateRecord.metadata.sourceHost || null;
        stateRecord.metadata.panelQueryFailure = panelQueryFailure;
      }
      const activeRecords = records.filter((item) => item.type === 'grafana_active_alert' && item.metadata.matchWindow);
      const telemetry = records.filter((item) => item.type === 'grafana_telemetry' && item.metadata.matchWindow);
      const contextRecord = stateRecord || activeRecords[0] || telemetry[0] || null;
      if (contextRecord) {
        contextRecord.metadata.grafanaAlerting = alertingContext;
        contextRecord.metadata.grafanaIrm = irmContext;
        contextRecord.metadata.grafanaAlertingResolved = Boolean(alertingContext?.resolved
          || (rule && (stateRecord || activeRecords.length)));
        contextRecord.metadata.grafanaRuleResolved = Boolean(rule?.uid);
        contextRecord.metadata.grafanaHistoryResolved = Boolean(alertingContext?.historyResolved || historyItems.length);
        contextRecord.metadata.grafanaIrmResolved = Boolean(irmContext?.resolved);
        contextRecord.metadata.grafanaDashboardResolved = Boolean(dashboardUid && (panelResult?.dashboardTitle || rule?.dashboard?.title));
        contextRecord.metadata.grafanaPanelEvidence = telemetry.length > 0;
      }
      const matched = [...(stateRecord ? [stateRecord] : activeRecords), ...telemetry];
      const failureReason = matched.length ? null : ruleUid
        ? 'GRAFANA_STATE_HISTORY_NO_OCCURRENCE_MATCH' : signals.alertName ? 'GRAFANA_ALERT_UNRESOLVED' : 'NO_RECORDS_IN_WINDOW';
      return adapterResult({
        source: this.source, adapter: this.name, mapping, records, evidence: matched,
        relationships: matched.map((item) => relationship(item, mapping, ['Exact Grafana rule identity', 'Grafana source state timestamp is inside the bounded occurrence window'])),
        failureReason, startedAt, queryWindow: occurrenceWindow,
        query: {
          ruleUid: ruleUid || null, dashboardUid: dashboardUid || null,
          panelId: panelId ? String(panelId) : null, identityLevel,
          sourceHost: signals.sourceHost || null,
          configuredHost: inventoryDiscovery?.configuredHost || null,
          requestedHost: inventoryDiscovery?.requestedHost || signals.sourceHost || null,
          instanceDisposition: inventoryDiscovery?.disposition || (signals.sourceHost ? 'PROVEN_CONFIGURED_INSTANCE' : null),
          inventoryProof: inventoryDiscovery?.proof || null,
          panelQueryFailure,
          attemptedPaths: ['rule_uid', 'state_history_loki', 'active_alerts', 'notification_configuration', 'silences', 'irm_alert_groups', 'dashboard_panel'],
          composite: { alertName: signals.alertName, environment: signals.environment, instance: signals.instance, folder: signals.folder, service: signals.service, team: signals.team },
        },
      });
    } catch (error) {
      return adapterResult({
        source: this.source, adapter: this.name, mapping,
        failureReason: sourceQueryFailureReason(error), startedAt, queryWindow: timeWindow,
        query: error?.instanceDiscovery ? {
          attemptedPaths: ['authenticated_workspace_inventory', 'exact_rule_uid', 'dashboard_panel', 'source_host'],
          identityLevel: 'INVENTORY_INSTANCE_RECONCILIATION',
          instanceDisposition: error.instanceDiscovery.disposition,
          configuredHost: error.instanceDiscovery.configuredHost,
          requestedHost: error.instanceDiscovery.requestedHost,
          inventoryProof: error.instanceDiscovery.proof,
        } : null,
      });
    }
  }
}

class ThousandEyesEvidenceAdapter extends BaseEvidenceAdapter {
  constructor(service = thousandEyesService) { super('ThousandEyes', service); }

  async queryEvidence(alert, timeWindow, context = {}) {
    const startedAt = Date.now();
    const mapping = this.resolveIdentity(alert, context.mappings);
    if (!mapping) return adapterResult({ source: this.source, adapter: this.name, failureReason: 'THOUSANDEYES_ALERT_UNRESOLVED', startedAt, queryWindow: timeWindow });
    const alertId = mapping.metadata?.alertId || alert.sourceMetadata.thousandEyesAlertId || null;
    const testId = mapping.metadata?.testId || alert.sourceMetadata.thousandEyesTestId || null;
    try {
      const response = alertId ? await this.service.getAlert(alertId, { range: context.range || '24h' }) : testId ? await this.service.getTest(testId, { range: context.range || '24h' }) : null;
      if (!response) return adapterResult({ source: this.source, adapter: this.name, mapping, failureReason: 'NO_MATCHING_RECORDS', startedAt, queryWindow: timeWindow });
      const records = [];
      const alertRecord = response.alert || response.activeAlerts?.[0];
      if (alertRecord) records.push(evidenceItem({
        id: `thousandeyes:alert:${alertRecord.id}`,
        source: this.source,
        type: alertRecord.type || 'thousandeyes_alert',
        timestamp: alertRecord.startDate,
        title: alertRecord.name || alertRecord.ruleName || 'ThousandEyes alert',
        summary: [alertRecord.testName, alertRecord.ruleName, alertRecord.state].filter(Boolean).join(' · '),
        severity: alertRecord.severity,
        entity: alertRecord.testName || response.test?.name,
        url: alertRecord.sourceLink,
        correlationKey: `thousandeyes:${alertRecord.id}`,
        metadata: { alertId: alertRecord.id, testId: alertRecord.testId || testId,
          ruleId: alertRecord.ruleId || null,
          agentIds: (response.agents || []).map((agent) => agent.id).filter(Boolean),
          locations: (response.agents || []).map((agent) => agent.location || agent.countryId || agent.name).filter(Boolean),
          state: alertRecord.state, durationSeconds: alertRecord.durationSeconds ?? null,
          failureReason: alertRecord.failureReason || alertRecord.violation || null },
      }, timeWindow));
      const metricSets = response.evidence ? [response.evidence] : Object.values(response.metrics || {});
      metricSets.forEach((metrics, setIndex) => {
        (metrics?.series || []).forEach((point, pointIndex) => {
          Object.entries(point)
            .filter(([key, value]) => key !== 'timestamp' && value !== null && value !== undefined)
            .forEach(([metric, value]) => {
              records.push(evidenceItem({
                id: `thousandeyes:${testId || alertId}:metric:${setIndex}:${pointIndex}:${metric}`,
                source: this.source,
                type: 'thousandeyes_telemetry',
                timestamp: point.timestamp,
                title: metric,
                summary: `${metric}: ${value}`,
                entity: response.test?.name || alertRecord?.testName,
                correlationKey: `thousandeyes-test:${testId || alertRecord?.testId}`,
                metadata: { testId: testId || alertRecord?.testId || null, metric, value,
                  agentIds: (response.agents || []).map((agent) => agent.id).filter(Boolean),
                  locations: (response.agents || []).map((agent) => agent.location || agent.countryId || agent.name).filter(Boolean) },
              }, timeWindow));
            });
        });
      });
      const matched = records.filter((item) => item.metadata.matchWindow);
      return adapterResult({ source: this.source, adapter: this.name, mapping, records, evidence: matched, relationships: matched.map((item) => relationship(item, mapping, ['Exact ThousandEyes identity', 'Result timestamp is inside the bounded occurrence window'])), failureReason: records.length && !matched.length ? 'TELEMETRY_OUTSIDE_WINDOW' : records.length ? null : 'NO_TELEMETRY_FOR_WINDOW', startedAt, queryWindow: timeWindow, query: { alertId, testId } });
    } catch (error) {
      return adapterResult({ source: this.source, adapter: this.name, mapping, failureReason: sourceQueryFailureReason(error), startedAt, queryWindow: timeWindow });
    }
  }
}

function exactToken(haystack, token) {
  const value = canonical(haystack);
  const candidate = canonical(token);
  return candidate.length >= 3 && (value.split(/[^a-z0-9._:-]+/).includes(candidate) || value.includes(`alert #${candidate}`));
}

class JiraEvidenceAdapter extends BaseEvidenceAdapter {
  constructor(service = jiraService) { super('ACC Jira', service); }

  resolveIdentity() { return { level: 'CONTEXT', confidence: 50, reasons: ['Bounded Jira context lookup'] }; }

  async queryEvidence(alert, timeWindow) {
    const startedAt = Date.now();
    const mapping = this.resolveIdentity();
    try {
      const response = await this.service.listEvidenceCandidates({ from: timeWindow.from, to: timeWindow.to, limit: 25 });
      const records = [];
      const relationships = [];
      for (const issue of response.items || []) {
        const relatedNumbers = (issue.relatedAlerts || []).map((item) => String(item.alertNumber || ''));
        const exactNumber = alert.alertNumber && relatedNumbers.includes(String(alert.alertNumber));
        const exactKey = alert.sourceMetadata.jiraIssueKeys.includes(String(issue.key || '').toUpperCase());
        const body = [issue.summary, issue.description, issue.resolution, issue.howResolved].filter(Boolean).join(' ');
        const exactEntity = [alert.service, alert.application, alert.canonicalEntity].filter(Boolean).find((value) => exactToken(body, value));
        const timestamp = issue.createdAt || issue.updatedAt || issue.resolvedAt;
        const timeMatch = withinWindow(timestamp, timeWindow) || withinWindow(issue.updatedAt, timeWindow) || withinWindow(issue.resolvedAt, timeWindow);
        if (!exactNumber && !exactKey && !(exactEntity && timeMatch)) continue;
        const confirmed = Boolean(exactNumber || exactKey);
        const item = evidenceItem({
          id: `jira:${issue.key}`,
          source: this.source,
          type: confirmed ? 'confirmed_issue_relationship' : 'candidate_issue_relationship',
          timestamp,
          title: `${issue.key} · ${issue.summary || issue.issueType || 'ACC issue'}`,
          summary: [issue.issueType, issue.status, issue.resolution].filter(Boolean).join(' · '),
          severity: issue.priority,
          entity: exactEntity || issue.key,
          correlationKey: exactNumber ? `alert:${alert.alertNumber}` : `jira:${issue.key}`,
          metadata: {
            issueKey: issue.key,
            issueType: issue.issueType || null,
            status: issue.status || null,
            resolution: issue.resolution || null,
            howResolved: issue.howResolved || null,
            resolvedAt: issue.resolvedAt || null,
            resolver: issue.resolvedBy || issue.resolver || null,
            commentsAvailable: Array.isArray(issue.comments) ? issue.comments.length : null,
            changelogAvailable: Array.isArray(issue.changelog) ? issue.changelog.length : null,
            worklogAvailable: Array.isArray(issue.worklogs || issue.worklog) ? (issue.worklogs || issue.worklog).length : null,
            relationship: confirmed ? 'confirmed' : 'candidate',
          },
        }, timeWindow);
        records.push(item);
        relationships.push({ evidenceId: item.id, source: this.source, confidence: confirmed ? 'High' : 'Medium', score: confirmed ? 95 : 50, relationship: confirmed ? 'confirmed' : 'candidate', evidence: confirmed ? ['Exact alert number or Jira issue key'] : ['Exact entity plus bounded Jira activity'] });
      }
      return adapterResult({ source: this.source, adapter: this.name, mapping, records, evidence: records, relationships, failureReason: records.length ? null : 'NO_CONFIRMED_JIRA_RELATIONSHIP', startedAt, queryWindow: timeWindow, query: { alertNumber: alert.alertNumber, issueKeys: alert.sourceMetadata.jiraIssueKeys } });
    } catch (error) {
      return adapterResult({ source: this.source, adapter: this.name, mapping, failureReason: safeError(error), startedAt, queryWindow: timeWindow });
    }
  }
}

class SlackEvidenceAdapter extends BaseEvidenceAdapter {
  constructor(service = slackStore) { super('Slack', service); }

  resolveIdentity() { return { level: 'CONTEXT', confidence: 50, reasons: ['Exact alert-number Slack lookup'] }; }

  async queryEvidence(alert, timeWindow) {
    const startedAt = Date.now();
    const mapping = this.resolveIdentity();
    if (!alert.alertNumber) return adapterResult({ source: this.source, adapter: this.name, mapping, failureReason: 'NO_EXACT_ALERT_NUMBER', startedAt, queryWindow: timeWindow });
    try {
      const response = await this.service.getCorrelationsByAlertNumbers([alert.alertNumber], { includeMessages: true });
      const correlation = response?.[alert.alertNumber];
      const maintenanceNotification = buildMaintenanceNotificationEvidence({
        alert,
        messages: correlation?.messages || [],
      });
      const messageRecords = (correlation?.messages || []).map((message, index) => {
        const body = cleanText(message.message);
        const authorIsBot = message.author?.isBot === true || message.botId || /bot|automation|integration/i.test(cleanText(message.author?.type));
        const activityType = /restart|rollback|rolled back|config|restor|fixed|cleared|resolved|mitigat/.test(canonical(body)) ? 'remediation'
          : /investigat|debug|triag/.test(canonical(body)) ? 'investigation'
            : /\b(?:escalat\w*|assign\w*|paging|paged|page)\b/.test(canonical(body)) ? 'escalation'
              : /acknowledg/.test(canonical(body)) ? 'acknowledgement' : authorIsBot ? 'automation_notification' : 'discussion';
        return evidenceItem({
        id: `slack:${message.messageTs || index}`,
        source: this.source,
        type: message.threadTs && message.threadTs !== message.messageTs ? 'thread_reply' : 'message',
        timestamp: message.messageAt,
        title: `Slack context for Alert #${alert.alertNumber}`,
        summary: body,
        entity: message.author?.name || null,
        url: message.slackPermalink,
        correlationKey: `alert:${alert.alertNumber}`,
        metadata: { alertNumber: alert.alertNumber, messageId: message.messageTs || null, channel: correlation?.channelName || correlation?.channelId || null, authorId: message.author?.id || null, authorName: message.author?.name || null, actorType: authorIsBot ? 'BOT' : 'HUMAN', activityType, meaningfulAction: !authorIsBot && activityType === 'remediation', threadTs: message.threadTs || null, replyCount: Number(message.replyCount || 0) },
      }, timeWindow);
      });
      const maintenanceRecord = maintenanceNotification ? evidenceItem({
        id: `maintenance-notification:${maintenanceNotification.notificationId}`,
        source: this.source,
        type: 'maintenance_notification',
        timestamp: maintenanceNotification.jsmTimestamp || maintenanceNotification.slackTimestamp,
        title: maintenanceNotification.title || `Maintenance notification for Alert #${alert.alertNumber}`,
        summary: maintenanceNotification.evidenceReason,
        entity: maintenanceNotification.notificationId,
        correlationKey: `alert:${alert.alertNumber}`,
        metadata: {
          alertNumber: alert.alertNumber,
          notificationId: maintenanceNotification.notificationId,
          expectedActivity: true,
          plannedActivity: true,
          maintenanceWindow: maintenanceNotification.maintenanceStart || maintenanceNotification.maintenanceEnd || true,
          operationalContext: 'MAINTENANCE',
          informational: true,
          nonActionable: true,
          actionability: 'NON_ACTIONABLE',
          maintenanceNotification,
        },
      }, timeWindow) : null;
      const records = [...messageRecords, ...(maintenanceRecord ? [maintenanceRecord] : [])];
      const matched = records.filter((item) => item.metadata.matchWindow);
      return adapterResult({ source: this.source, adapter: this.name, mapping, records, evidence: matched, relationships: matched.map((item) => ({ evidenceId: item.id, source: this.source, confidence: 'High', score: 95, relationship: 'confirmed', evidence: [`Exact Alert #${alert.alertNumber} reference`, 'Message timestamp is inside the bounded occurrence window'] })), failureReason: records.length && !matched.length ? 'SLACK_CONTEXT_OUTSIDE_WINDOW' : records.length ? null : 'NO_RELEVANT_SLACK_CONTEXT', startedAt, queryWindow: timeWindow, query: { alertNumber: alert.alertNumber } });
    } catch (error) {
      return adapterResult({ source: this.source, adapter: this.name, mapping, failureReason: safeError(error), startedAt, queryWindow: timeWindow });
    }
  }
}

function createSourceEvidenceAdapterRegistry({ appDynamics = appDynamicsService, grafana = grafanaService, nagios = nagiosService, jira = jiraService, slack = slackStore } = {}) {
  const adapters = [
    new NagiosEvidenceAdapter(nagios),
    new AppDynamicsEvidenceAdapter(appDynamics),
    new GrafanaEvidenceAdapter(grafana),
    new JiraEvidenceAdapter(jira),
    new SlackEvidenceAdapter(slack),
  ];
  return {
    adapters,
    get(source) { return adapters.find((adapter) => canonical(adapter.source) === canonical(source)) || null; },
  };
}

module.exports = {
  ACCEPTED_MAPPING_LEVELS,
  PIPELINE_STATES,
  AppDynamicsEvidenceAdapter,
  GrafanaEvidenceAdapter,
  grafanaActiveAlertMatches,
  grafanaHistoryItemMatches,
  grafanaInstanceLabels,
  grafanaLabelsMatch,
  grafanaStateEvidence,
  grafanaStateHistorySelection,
  selectGrafanaRuleCandidate,
  JiraEvidenceAdapter,
  NagiosEvidenceAdapter,
  SlackEvidenceAdapter,
  ThousandEyesEvidenceAdapter,
  adapterResult,
  appDynamicsMetricIntent,
  appDynamicsWorkflowEvidence,
  appDynamicsFailureReason,
  createSourceEvidenceAdapterRegistry,
  evidenceItem,
  grafanaIdentityLevel,
  grafanaIdentitySignals,
  mappingFor,
  buildMaintenanceNotificationEvidence,
  normalizeOperationsAlert,
  normalizeWindow,
  operationalRecordSemantics,
  withinWindow,
};
